import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ControlReportStore} from '../control-plane/report-store.mjs';
import {NotificationOutboxService} from './outbox-service.mjs';
import {planNotification} from '../notification-policy.mjs';

const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function safe(value,max=140){
 return String(value??'').replace(/https?:\/\/\S+|[A-Za-z]:[\\/]\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]+|\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/gi,'[상세 기록]')
  .replace(/\bBearer\s+\S+|\bxox[baprs]-\S+|\bsk-[A-Za-z0-9_-]{12,}|(?:password|token|secret|cookie|api[_-]?key)\s*[:=]\s*\S+/gi,'[보호된 값]')
  .replace(/[\x00-\x1f\x7f<>`|]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}
export function renderControlReport(worker,label){
 const state={DONE:'단위 결과 완료',HOLD:'보류',APPROVAL_REQUIRED:'확인 필요',DRIFT:'상태 불일치',PROGRESS:'진행'}[worker.status];
 const kst=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(worker.updatedAt));
 const urgency=worker.status==='APPROVAL_REQUIRED'?4:2;
 return [`${urgency} ${urgency===4?'중요':'일반'} | ${safe(label,30)} · ${state}`,`기준: ${kst} KST`,safe(worker.summary),
  worker.completed?.length?`• 반영: ${worker.completed.slice(0,2).map(v=>safe(v,90)).join(' / ')}`:null,
  worker.remaining?.length?`• 남음: ${worker.remaining.slice(0,2).map(v=>safe(v,90)).join(' / ')}`:null,
  `다음: ${safe(worker.nextGate??worker.nextAction??'기존 개발 문서의 다음 단계 확인',120)}`].filter(Boolean).join('\n').slice(0,700);
}
export function collectControlReportNotifications(config,{stateRoot,now=()=>Date.now(),reports,outbox}={}){
 if(config?.schemaVersion!==1||config.enabled!==true||!Number.isFinite(Date.parse(config.enabledAt))||!Array.isArray(config.workers)||config.workers.length>20)throw Error('report_bridge_config_invalid');
 reports??=new ControlReportStore({stateRoot});
 // No credential/network access here: the registered owner-local dispatcher
 // verifies identity and delivers via the existing outbox on its normal tick.
 outbox??=new NotificationOutboxService({root:path.join(stateRoot,'notifications','outbox'),now,planner:event=>{
  const plan=planNotification(event,{slack:true,telegram:false},{routingProfile:'slack_primary'});
  return {...plan,deliveries:plan.deliveries.map(d=>d.channel==='slack'?{...d,message:event.summary}:d)};
 }});
 const workers=reports.status().workers,results=[];
 for(const binding of config.workers){
  if(!id.test(binding.workerId??'')||!id.test(binding.projectKey??'')||!id.test(binding.taskId??'')||!safe(binding.label,30))throw Error('report_bridge_binding_invalid');
 }
 for(const binding of config.workers){
  const worker=workers[binding.workerId];
  if(!worker||Date.parse(worker.updatedAt)<Date.parse(config.enabledAt))continue;
  if(worker.status==='PROGRESS'&&!worker.completed?.length)continue;
  if(!['DONE','HOLD','APPROVAL_REQUIRED','DRIFT','PROGRESS'].includes(worker.status)||!Number.isFinite(Date.parse(worker.updatedAt)))throw Error('report_bridge_worker_invalid');
  const content={status:worker.status,summary:worker.summary,completed:worker.completed??[],remaining:worker.remaining??[],nextGate:worker.nextGate??null,nextAction:worker.nextAction??null};
  // Semantic id excludes sequence/time/revision so unchanged polling or a
  // reworded revision cannot repeatedly publish the same result.
  const eventId='control-report-'+hash([binding.workerId,binding.taskId,content]);
  const existing=outbox.list({projectKey:binding.projectKey,taskId:binding.taskId}).find(row=>row.eventId===eventId);
  if(existing){results.push({workerId:binding.workerId,eventId,state:existing.state,duplicate:true});continue;}
  const event={eventId,dedupeKey:eventId,type:'report_ready',urgency:worker.status==='APPROVAL_REQUIRED'?4:2,sensitivity:'internal',source:'authorized-control-report-bridge',projectKey:binding.projectKey,taskId:binding.taskId,title:safe(binding.label,30)+' 개발 보고',summary:renderControlReport(worker,binding.label),nextGate:null};
  const result=outbox.arm(event,{dedupeKey:eventId});
  results.push({workerId:binding.workerId,eventId,state:result.notification.state,duplicate:result.duplicate});
 }
 return {state:'COLLECTED',results};
}
export function readControlReportBridgeConfig(file){
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768)throw Error('report_bridge_config_unsafe');
 return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
}
