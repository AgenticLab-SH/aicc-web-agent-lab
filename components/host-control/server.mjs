import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import Ajv from 'ajv';
import { openCdpBrowser } from './cdp-browser.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const exec=promisify(execFile),sha=v=>createHash('sha256').update(v).digest('hex');
const str=(maxLength=512)=>({type:'string',minLength:1,maxLength});
const id={type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$'};
const lease={type:'string',pattern:'^[a-f0-9]{64}$'};
const obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const auth={session_id:id,lease};
const operation={...auth,request_id:id};
const closeInput=obj({...operation,history_recovery:obj({
 open_request_id:id,close_request_id:id,client_key:lease
})},['session_id','lease','request_id']);
const annotations=readOnly=>({readOnlyHint:readOnly,destructiveHint:false,idempotentHint:readOnly,openWorldHint:true});
function tool(name,title,description,inputSchema,readOnly=false){return {name,title,description,inputSchema,annotations:annotations(readOnly)};}
export const HOST_TOOLS=Object.freeze([
 tool('aicc_host_capabilities','호스트 화면 제어 기능','등록 CDP 브라우저를 열기 전에 cdpIdentityDiscovery.identityIds의 정확한 browser_identity를 조회하고 해당 작업의 승인된 신원만 명시 선택하세요. 목록은 Host 소유자 범위의 ID만 포함하며 로그인·현재 lease 가용성 증거가 아닙니다. 신원 불명/서로 다른 소유자는 자동 선택 또는 Aside 대체 없이 HOLD합니다. 파일/exec lease와 별도이며 기존 사용자 창을 채택하지 않습니다.',obj({}),true),
 tool('aicc_host_open','작업용 브라우저·앱 열기','kind browser는 설정된 기본 엔진(CDP 설정 시 등록된 exact identity 필수)을 사용하고, browser_backend=aside는 명시적 보조 경로입니다. desktop은 app_key로 등록된 앱의 새 프로세스만 엽니다. request_id와 client_key를 보존하세요. 동일 요청 재조회는 같은 결과를 반환하며 불명 작업은 재실행하지 않습니다. 새 요청에서 wait_for_capacity=true는 확인된 용량 부족일 때만 QUEUED로 보존합니다. 과거 결과 불명은 원 요청 조회로 보존하며 새 별개 작업의 용량을 차지하지 않습니다. 실제 열린 세션의 반환 미입증이나 원장 손상은 NOT_DISPATCHED/HISTORY_UNPROVEN으로 남기고 claim하지 않습니다. QUEUED는 aicc_host_wait claim 전에는 열지 않습니다. 기존 거절/불명 요청의 옵션을 바꿔 재생하지 마세요. owner_label/purpose에는 비밀이나 개인본문을 넣지 마세요.',obj({request_id:id,client_key:lease,kind:{enum:['browser','desktop']},url:str(2048),app_key:str(64),browser_backend:{enum:['cdp','aside']},browser_identity:str(64),wait_for_capacity:{type:'boolean'},owner_label:str(80),purpose:str(160)},['request_id','client_key','kind'])),
 tool('aicc_host_sessions','본인 호스트 점유·공유 대기 보기','본인 client_key의 세션·대기만 상세 조회합니다. 공유 용량/대기는 집계만, URL은 origin만 표시하며 lease·화면·다른 담당자는 반환하지 않습니다. 조회는 idle 시간을 연장하지 않습니다.',obj({client_key:lease}),true),
 tool('aicc_host_wait','원 대기 요청 claim·취소','wait_for_capacity로 등록한 같은 원 request_id만 claim 또는 취소합니다. claim은 용량과 순서가 허용할 때 한 번만 실행합니다. 재시작·불명 원 작업은 재생하지 않습니다. 대기 취소는 기존 세션을 닫지 않습니다.',obj({request_id:id,client_key:lease,action:{enum:['claim','cancel']}})),
 tool('aicc_host_observe','작업 화면 읽기','작업 소유 화면의 현재 접근성 정보와 선택적 이미지를 읽습니다. observation_id를 다음 조작에 그대로 사용하세요. 기존 사용자 화면은 읽지 않습니다.',obj({...auth,screenshot:{type:'boolean'}},['session_id','lease']),true),
 tool('aicc_host_act','작업 화면 클릭·입력','관측한 현재 화면에서만 click/fill/press/hotkey/select/check/navigate/scroll을 실행하고 새 화면을 반환합니다. 브라우저는 ref, Windows는 element_token 또는 관측 화면 안 x/y를 사용합니다. 원격 코드·shell·임의 프로세스 제어 없음. foreground는 background_unavailable 후 같은 동작에만 허용합니다.',obj({...operation,observation_id:id,action:{enum:['click','fill','press','hotkey','select','check','navigate','scroll','download']},ref:str(80),element_token:str(100),text:{type:'string',maxLength:10000},key:str(80),keys:{type:'array',items:str(32),minItems:2,maxItems:4},url:str(2048),x:{type:'number',minimum:0},y:{type:'number',minimum:0},direction:{enum:['up','down','left','right']},amount:{type:'integer',minimum:1,maximum:10},delivery_mode:{enum:['background','foreground']}},['session_id','lease','request_id','observation_id','action'])),
 tool('aicc_host_close','작업용 탭·창 닫기','해당 작업이 연 탭·앱 창만 정상 닫습니다. 미저장/닫기 거절이면 CLOSE_PENDING입니다. 선택적 history_recovery는 같은 소유자·세대·target·원 lease·정상 닫기 영수증을 검증한 경우에만 원 journal을 보존하고 별도 반환 기록을 1회 작성합니다. 증거 없으면 HOLD. 강제 종료·재채택·재실행 없음.',closeInput),
 tool('aicc_host_operation_status','호스트 원 작업 결과','request_id와 open 때 사용한 client_key로 같은 원 결과를 조회합니다. 새 실행은 하지 않습니다. 브라우저 내용/입력은 원장에 저장하지 않습니다.',obj({request_id:id,client_key:lease}),true)
]);
function regular(file){if(!path.isAbsolute(file))throw Error('ABSOLUTE_PATH_REQUIRED');for(let p=file;;p=path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw Error('LINK_REFUSED');if(path.dirname(p)===p)break;}if(!fs.statSync(file).isFile())throw Error('REGULAR_FILE_REQUIRED');return file;}
function result(value,content=[]){return {content:[{type:'text',text:JSON.stringify(value)},...content],structuredContent:value};}
function unpack(value){if(value.structuredContent)return value.structuredContent;for(const c of value.content??[]){if(c.type==='text')try{return JSON.parse(c.text);}catch{}}return {};}
function textOf(r){return (r.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');}
function metadataError(r){return unpack(r).code??unpack(r).error?.code??(/background_unavailable/.test(textOf(r))?'background_unavailable':'DRIVER_REFUSED');}
function check(r){if(r?.isError)throw Object.assign(Error(metadataError(r)),{driverResult:r});return r;}


// Selectable identities come only from the already owner-pinned Host CDP
// registry, never a port probe, current browser window or caller-supplied
// account label. An ID is not a login/availability/lease attestation.
// There is no per-caller principal on a zero-input capabilities call:
// mixed owner registrations MUST NOT be disclosed as a shared list.
function discoverHostCdpIdentityIds(cdp){
 const unavailable=(status)=>({status,identityIds:[],scope:'installed-host-registered-only',
  loginVerified:false,leaseAvailable:'UNPROVEN',selection:'EXPLICIT_NO_FALLBACK'});
 if(cdp?.enabled!==true)return unavailable('CDP_DISABLED');
 if(!Array.isArray(cdp.identities)||cdp.identities.length===0)return unavailable('NO_REGISTERED_CDP_IDENTITY');
 if(cdp.identities.length>16)return unavailable('REGISTRY_UNVERIFIED');
 const seen=new Set(),owners=new Set(),ids=[];
 for(const value of cdp.identities){
  if(!value||typeof value!=='object'||Array.isArray(value)||
     typeof value.identityId!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(value.identityId)||
     seen.has(value.identityId)||value.role!=='registered-cdp'||value.engine!=='chrome'||
     value.ownershipPolicy!=='task-created-target-only'||
     typeof value.owner!=='string'||!value.owner||
     typeof value.accountAlias!=='string'||!value.accountAlias||
     typeof value.workspaceAlias!=='string'||!value.workspaceAlias||
     typeof value.profile!=='string'||!value.profile||
     typeof value.executable!=='string'||!value.executable||
     typeof value.userDataRoot!=='string'||!value.userDataRoot||
     typeof value.cdpEndpoint!=='string'||!/^http:\/\/127\.0\.0\.1:[0-9]{4,5}$/.test(value.cdpEndpoint)||
     !/^[a-f0-9]{64}$/.test(value.sessionIdentityHash??'')||
     !(value.workspaceIdentityHash===null||/^[a-f0-9]{64}$/.test(value.workspaceIdentityHash??'')))
    return unavailable('REGISTRY_UNVERIFIED');
  seen.add(value.identityId);owners.add(value.owner);ids.push(value.identityId);
 }
 if(owners.size!==1)return unavailable('OWNER_SCOPE_UNVERIFIED');
 return {status:'REGISTERED',identityIds:ids,scope:'installed-host-registered-only',
  loginVerified:false,leaseAvailable:'UNPROVEN',selection:'EXPLICIT_NO_FALLBACK'};
}
const validHostId=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$/.test(value);
const validHostHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);


// Read-only evidence checklist for the original owner. Missing fields are
// missing *recorded proof*, never an assertion that the resource is gone.
// Do not copy lease/target/owner hashes or infer a normal return from age.
function originalOpenReturnEvidence(r){
 if(r?.operation!=='open'||['NOT_DISPATCHED','CANCELLED','QUEUED'].includes(r.phase)||
    r.sessionState==='CLOSED')return null;
 const recorded={sessionId:validHostId(r.session_id),
  generation:validHostId(r.instanceId),originalLeaseHash:validHostHash(r.capHash),
  exactTargetHash:validHostHash(r.resourceTargetHash)};
 const missing=Object.entries(recorded).filter(([,found])=>!found)
  .map(([name])=>({sessionId:'ORIGINAL_SESSION_ID',generation:'SOURCE_GENERATION',
   originalLeaseHash:'ORIGINAL_LEASE_HASH',exactTargetHash:'EXACT_TARGET_HASH'})[name]);
 return {status:'NORMAL_RETURN_UNPROVEN',recorded,missingProofs:[...missing,'VERIFIED_NORMAL_CLOSE_RECEIPT'],
  nextActor:'ORIGINAL_ISSUER_AND_EXACT_HOST_OWNER',originalOutcomeUnchanged:true,replayed:false};
}
const RETURN_RECEIPTS_DIR='.history-return-receipts';
const returnDirectory=root=>path.join(root,RETURN_RECEIPTS_DIR);
function proofRecord(root,requestId){
 if(!validHostId(requestId))throw Error('HOST_PROOF_REQUEST_ID_REQUIRED');
 const file=regular(path.join(root,requestId+'.json'));
 const raw=fs.readFileSync(file);
 if(raw.length>65536)throw Error('HOST_PROOF_JOURNAL_TOO_LARGE');
 const value=JSON.parse(raw.toString('utf8'));
 if(value?.schemaVersion!==1||value.request_id!==requestId||
    !validHostHash(value.ownerHash)||!validHostHash(value.requestHash))
   throw Error('HOST_PROOF_JOURNAL_IDENTITY_CHANGED');
 return {value,sha256:sha(raw)};
}
function exactNormalReturnHash(sessionId){
 return sha(JSON.stringify(result({ok:true,status:'CLOSED',session_id:sessionId})));
}
/** No file supplied by a caller is an authority: both records are read from
 * the original private journal. The exact normal-close result is checked,
 * not merely a COMPLETED phase (a refused CLOSE_PENDING can also complete).
 */
function provedNormalReturn(root,openId,closeId,authorization={}){
 const open=proofRecord(root,openId),close=proofRecord(root,closeId);
 const o=open.value,c=close.value;
 if(o.operation!=='open'||!['COMPLETED','OUTCOME_UNKNOWN'].includes(o.phase)||
    !['OPEN','OPENING','UNKNOWN','CLOSE_PENDING'].includes(o.sessionState)||
    !validHostId(o.session_id)||!validHostHash(o.capHash)||
    !validHostHash(o.resourceTargetHash)||!validHostId(o.instanceId))
   throw Error('HOST_OPEN_RESOURCE_EVIDENCE_UNPROVEN');
 if(c.operation!=='session'||c.hostAction!=='normal-close/v1'||
    c.phase!=='COMPLETED'||c.session_id!==o.session_id||
    c.ownerHash!==o.ownerHash||c.instanceId!==o.instanceId||
    c.kind!==o.kind||c.resourceTargetHash!==o.resourceTargetHash||
    c.resultHash!==exactNormalReturnHash(o.session_id))
   throw Error('HOST_NORMAL_RETURN_PROOF_MISMATCH');
 if(!validHostHash(c.resultHash)||!validHostId(closeId)||openId===closeId||
    !Number.isFinite(Date.parse(c.at))||!Number.isFinite(Date.parse(o.at))||
    Date.parse(c.at)<Date.parse(o.at))throw Error('HOST_RETURN_PROOF_TIME_OR_RESULT_INVALID');
 if(authorization.client_key!==undefined &&
    sha(authorization.client_key)!==o.ownerHash)throw Error('HOST_RECOVERY_OWNER_MISMATCH');
 if(authorization.session_id!==undefined &&
    authorization.session_id!==o.session_id)throw Error('HOST_RECOVERY_SESSION_MISMATCH');
 if(authorization.lease!==undefined){
   if(sha(authorization.lease)!==o.capHash)throw Error('HOST_RECOVERY_ORIGINAL_LEASE_MISMATCH');
   const entries=[['session_id',o.session_id],['lease',authorization.lease],['request_id',closeId]];
   const permutations=[[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
   if(!permutations.some(order=>sha(JSON.stringify(Object.fromEntries(order.map(i=>entries[i]))))===c.requestHash))
     throw Error('HOST_RECOVERY_CLOSE_REQUEST_BINDING_MISMATCH');
 }
 return {open,close};
}
function readReturnReceipts(stateRoot){
 const records=[],invalid=[];
 const directory=returnDirectory(stateRoot);
 if(!fs.existsSync(directory))return {records,invalid};
 try{
  if(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink())throw Error('LINKED_RETURN_RECEIPTS_DIR');
  const files=fs.readdirSync(directory);
  if(files.length>5000)throw Error('RETURN_RECEIPT_CAP_REACHED');
  for(const name of files){
   try{
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}\.json$/.test(name))throw Error('BAD_RETURN_RECEIPT_NAME');
    const file=regular(path.join(directory,name)),stat=fs.statSync(file);
    if(stat.nlink!==1||stat.size>65536)throw Error('LINKED_OR_OVERSIZE_RETURN_RECEIPT');
    const raw=fs.readFileSync(file),receipt=JSON.parse(raw.toString('utf8'));
    const keys=['schemaVersion','kind','request_id','open_request_id','close_request_id',
      'ownerHash','session_id','instanceId','resourceTargetHash','openJournalSha256',
      'closeJournalSha256','closeResultHash','reconcileRequestHash','reconciledAt'];
    if(!receipt||Object.keys(receipt).sort().join('|')!==keys.sort().join('|')||
       receipt.schemaVersion!==1||receipt.kind!=='host-history-normal-return/v1'||
       receipt.open_request_id!==name.slice(0,-5)||!validHostId(receipt.request_id)||
       !validHostHash(receipt.reconcileRequestHash)||!validHostHash(receipt.openJournalSha256)||
       !validHostHash(receipt.closeJournalSha256)||!Number.isFinite(Date.parse(receipt.reconciledAt)))
      throw Error('RETURN_RECEIPT_SHAPE_INVALID');
    const proof=provedNormalReturn(stateRoot,receipt.open_request_id,receipt.close_request_id);
    if(proof.open.sha256!==receipt.openJournalSha256||
       proof.close.sha256!==receipt.closeJournalSha256||
       proof.open.value.ownerHash!==receipt.ownerHash||
       proof.open.value.session_id!==receipt.session_id||
       proof.open.value.instanceId!==receipt.instanceId||
       proof.open.value.resourceTargetHash!==receipt.resourceTargetHash||
       proof.close.value.resultHash!==receipt.closeResultHash)
      throw Error('RETURN_RECEIPT_SOURCE_DRIFT');
    records.push({...receipt,receiptSha256:sha(raw),originalPhase:proof.open.value.phase});
   }catch{invalid.push(name);}
  }
 }catch{invalid.push('RECEIPT_DIRECTORY');}
 return {records,invalid};
}
/** Read legacy and current journals without rewriting them or inferring a session's return. */
export function readHostHistory(stateRoot){
 const recovered=[];const history={journalRecords:0,legacyRecords:0,legacyNotDispatched:0,legacyCompleted:0,legacyOutcomeUnknown:0,legacyDispatching:0,unreadableJournals:0,partialWrites:0,nonJournalEntries:0};
 let files;try{files=fs.readdirSync(stateRoot);if(files.length>5000)throw Error('HOST_JOURNAL_CAP_REACHED');}catch{return {recovered,resolved:[],history:{...history,unreadableJournals:1}};}
 for(const file of files){
  try{
   const full=path.join(stateRoot,file),stat=fs.lstatSync(full);
   if(stat.isSymbolicLink()){history.unreadableJournals++;continue;}
   if(!file.endsWith('.json')){
    if(/\.json\.[^.]+\.tmp$/.test(file)){history.partialWrites++;}else{history.nonJournalEntries++;}
    continue;
   }
   if(!stat.isFile()||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}\.json$/.test(file)){history.unreadableJournals++;continue;}
   const r=JSON.parse(fs.readFileSync(regular(full),'utf8'));
   if(r?.schemaVersion!==1||r.request_id!==file.slice(0,-5)||!/^[a-f0-9]{64}$/.test(r.ownerHash??'')||!/^[a-f0-9]{64}$/.test(r.requestHash??'')||!['QUEUED','DISPATCHING','COMPLETED','NOT_DISPATCHED','OUTCOME_UNKNOWN','CANCELLED'].includes(r.phase)){history.unreadableJournals++;continue;}
   history.journalRecords++;
   if(r.operation==null){
    history.legacyRecords++;
    if(r.phase==='NOT_DISPATCHED'){history.legacyNotDispatched++;continue;}
    if(r.phase==='COMPLETED'){history.legacyCompleted++;recovered.push({...r,recovery:'LEGACY_OPERATION_KIND_UNPROVEN'});continue;}
    if(r.phase==='OUTCOME_UNKNOWN')history.legacyOutcomeUnknown++;
    else if(r.phase==='DISPATCHING')history.legacyDispatching++;
    else{history.unreadableJournals++;continue;}
    recovered.push({...r,recovery:'ORIGINAL_OPERATION_UNPROVEN'});
   }else if(r.operation==='open'){
    if(r.phase==='QUEUED')recovered.push({...r,recovery:'QUEUED_CONTEXT_LOST'});
    else if(!['CLOSED','NOT_DISPATCHED'].includes(r.sessionState)&&r.phase!=='NOT_DISPATCHED'&&r.phase!=='CANCELLED')recovered.push({...r,recovery:'SESSION_RETURN_UNPROVEN'});
   }else if(r.operation==='session'){
    if(['DISPATCHING','OUTCOME_UNKNOWN'].includes(r.phase))recovered.push({...r,recovery:'ORIGINAL_OPERATION_UNPROVEN'});
   }else history.unreadableJournals++;
  }catch{history.unreadableJournals++;}
 }
 const receipts=readReturnReceipts(stateRoot);
 history.invalidReturnReceipts=receipts.invalid.length;
 history.verifiedReturnReceipts=receipts.records.length;
 if(receipts.invalid.length)history.unreadableJournals+=receipts.invalid.length;
 const resolvedIds=new Set(receipts.records.map(r=>r.open_request_id));
 const unresolved=recovered.filter(r=>!resolvedIds.has(r.request_id));
 return {recovered:unresolved,history,resolved:receipts.records};
}
export async function createHostController(config,{connect,processes,now=Date.now,cdpFactory=openCdpBrowser}={}){
 if(config?.schemaVersion!==1||config.scope!=='task-owned-v1'||process.platform!=='win32'&&!connect)throw Error('EXACT_WINDOWS_HOST_SCOPE_REQUIRED');
 for(const entry of [config.aside,config.cua]){if(sha(fs.readFileSync(regular(entry.command)))!==entry.sha256)throw Error('EXECUTOR_PIN_CHANGED');}
 regular(config.powershell);
 if(!path.isAbsolute(config.stateRoot))throw Error('OWNER_STATE_REQUIRED');
 fs.mkdirSync(config.stateRoot,{recursive:true,mode:0o700});
 for(let p=config.stateRoot;;p=path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw Error('LINK_REFUSED');if(path.dirname(p)===p)break;}
 const ajv=new Ajv({strict:false}),schemas=new Map(HOST_TOOLS.map(t=>[t.name,ajv.compile(t.inputSchema)]));
 const sessions=new Map(),cache=new Map(),waiting=new Map();const instanceId=randomUUID();let tail=Promise.resolve(),closing=false,pending=0;
 const pidInfo=processes??(async pid=>{
  const script=pid?`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}';if($p){@{pid=[int]$p.ProcessId;created=$p.CreationDate.ToUniversalTime().Ticks.ToString();image=$p.ExecutablePath}|ConvertTo-Json -Compress}else{'null'}`:`@(Get-CimInstance Win32_Process|ForEach-Object {@{pid=[int]$_.ProcessId;image=$_.ExecutablePath}})|ConvertTo-Json -Compress`;
  const {stdout}=await exec(config.powershell,['-NoProfile','-NonInteractive','-Command','[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'+script],{windowsHide:true,timeout:15000,maxBuffer:1024*1024});return JSON.parse(stdout.trim());
 });
 const journalFile=key=>path.join(config.stateRoot,key+'.json');
 const save=(key,value)=>{const file=journalFile(key),tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value),{flag:'wx',mode:0o600});fs.renameSync(tmp,file);};
 const read=key=>fs.existsSync(journalFile(key))?JSON.parse(fs.readFileSync(regular(journalFile(key)),'utf8')):null;
 // Original outcome uncertainty stays on its original request; it is not live occupancy.
 // Only an explicit persisted open-session record can require a resource-return hold.
 const {recovered,history,resolved:resolvedReturns}=readHostHistory(config.stateRoot);
 let historyUnreadable=history.unreadableJournals>0||history.partialWrites>0;
 const unreturnedRecordedSessions=recovered.filter(r=>r.operation==='open'&&r.recovery==='SESSION_RETURN_UNPROVEN');
 let historyUnproven=recovered.some(r=>r.recovery!=='QUEUED_CONTEXT_LOST');
 const recoveryHold=()=>historyUnreadable||unreturnedRecordedSessions.length>0;
 function reloadReconciledHistory(){
  const fresh=readHostHistory(config.stateRoot);
  recovered.splice(0,recovered.length,...fresh.recovered);
  resolvedReturns.splice(0,resolvedReturns.length,...fresh.resolved);
  Object.assign(history,fresh.history);
  historyUnreadable=history.unreadableJournals>0||history.partialWrites>0;
  historyUnproven=recovered.some(r=>r.recovery!=='QUEUED_CONTEXT_LOST');
  unreturnedRecordedSessions.splice(0,unreturnedRecordedSessions.length,
   ...recovered.filter(r=>r.operation==='open'&&r.recovery==='SESSION_RETURN_UNPROVEN'));
 }
 const hasCapacity=kind=>!recoveryHold()&&sessions.size<4&&[...sessions.values()].filter(s=>s.kind===kind).length<(kind==='desktop'?1:3);
 const firstEligible=()=>[...waiting.values()].find(w=>hasCapacity(w.args.kind));
 function capacity(){
  const browser=[...sessions.values()].filter(s=>s.kind==='browser').length,desktop=sessions.size-browser;
  return {maximumSessions:4,maximumBrowserSessions:3,maximumDesktopSessions:1,knownSessions:sessions.size,
   browserSessions:browser,desktopSessions:desktop,availableSessions:recoveryHold()?null:4-sessions.size,
   availableBrowser:recoveryHold()?null:Math.min(4-sessions.size,3-browser),
   availableDesktop:recoveryHold()?null:Math.min(4-sessions.size,1-desktop),
   waiting:waiting.size,maximumWaiting:12,serialPending:Math.max(0,pending-1),
   recoveredUnknown:recovered.filter(r=>['DISPATCHING','OUTCOME_UNKNOWN'].includes(r.phase)).length,
   recoveredReturnUnproven:recovered.filter(r=>['LEGACY_OPERATION_KIND_UNPROVEN','SESSION_RETURN_UNPROVEN'].includes(r.recovery)).length,
   recoveredQueued:recovered.filter(r=>r.recovery==='QUEUED_CONTEXT_LOST').length,
   historicalRecords:{...history,currentActiveInferred:false},
   history:historyUnreadable?'UNREADABLE':historyUnproven?'UNPROVEN':'CURRENT_INSTANCE',
   historyAdmission:'session-evidence-v1',
   historyBlocksNewWork:recoveryHold(),
   unreturnedRecordedSessions:unreturnedRecordedSessions.length,
   as_of:new Date(now()).toISOString()};
 }
 function metadata(args){return {owner_label:args.owner_label??null,purpose:args.purpose??null,
  allowed_url:args.kind==='browser'?{origin:new URL(safeUrl(args.url)).origin,path:'REDACTED',query:'REDACTED',fragment:'REDACTED',current_url:'UNPROVEN'}:null,
  app_key:args.kind==='desktop'?args.app_key:null,
  browser_backend:args.kind==='browser'?browserBackend(args):null,
  browser_identity:args.kind==='browser'&&browserBackend(args)==='cdp'?args.browser_identity:null};}
 function queuedView(w){
  const eligible=firstEligible();
  return {request_id:w.args.request_id,kind:w.args.kind,...w.metadata,owner:'THIS_CLIENT',
   status:'QUEUED',dispatched:false,queued_at:w.at,
   position:[...waiting.keys()].indexOf(w.args.request_id)+1,
   claimable:eligible===w,reason:recoveryHold()?'HISTORY_UNPROVEN':!hasCapacity(w.args.kind)?'HOST_SESSION_LIMIT':eligible===w?'CLAIM_REQUIRED':'EARLIER_ELIGIBLE_REQUEST',
   next_actor:'ORIGINAL_CLIENT',automatic_dispatch:false};
 }
 function journalResult(r){
  return cache.get(r.request_id)??result({ok:r.phase==='COMPLETED',status:r.phase==='DISPATCHING'?'OUTCOME_UNKNOWN':r.phase,
   request_id:r.request_id,resultHash:r.resultHash,resultEvicted:true,replayed:false,
   ...(r.phase==='QUEUED'?{dispatched:false,reason:'HOLD_QUEUE_CONTEXT_LOST',next_actor:'ORIGINAL_CLIENT_CANCEL_OR_OWNER_RECONCILE'}:{})});
 }
 function browserBackend(a){
  if(a.kind!=='browser')return null;
  return a.browser_backend??(config.cdp?.enabled===true?'cdp':'aside');
 }
 function validateOpen(a){
  if(a.kind==='browser'&&!a.url||a.kind==='desktop'&&!a.app_key)throw Object.assign(Error('URL_OR_APP_KEY_REQUIRED'),{beforeDispatch:true});
  if(a.kind==='desktop'&&!config.apps?.[a.app_key])throw Object.assign(Error('APP_NOT_REGISTERED'),{beforeDispatch:true});
  if(a.kind==='desktop'&&(a.browser_backend||a.browser_identity))throw Object.assign(Error('BROWSER_OPTIONS_ONLY_FOR_BROWSER'),{beforeDispatch:true});
  if(a.kind==='browser'){
   const backend=browserBackend(a);
   if(backend==='cdp'){
    if(!a.browser_identity||!discoverHostCdpIdentityIds(config.cdp).identityIds.includes(a.browser_identity))throw Object.assign(Error('EXACT_REGISTERED_CDP_IDENTITY_REQUIRED'),{beforeDispatch:true});
   }else if(backend==='aside'){
    if(a.browser_identity)throw Object.assign(Error('ASIDE_IS_NOT_REGISTERED_CDP_IDENTITY'),{beforeDispatch:true});
   }else throw Object.assign(Error('BROWSER_BACKEND_NOT_SUPPORTED'),{beforeDispatch:true});
  }
  if(a.kind==='browser')try{safeUrl(a.url);}catch(e){e.beforeDispatch=true;throw e;}
 }
 function newRecord(args,s,hostAction=null){
  if(fs.readdirSync(config.stateRoot).length>=5000)throw Object.assign(Error('HOST_JOURNAL_CAP_REACHED'),{beforeDispatch:true});
  return {schemaVersion:1,request_id:args.request_id,ownerHash:s?.ownerHash??sha(args.client_key),
   requestHash:sha(JSON.stringify(args)),session_id:s?.id??null,operation:s?'session':'open',kind:s?.kind??args.kind,
   ...(hostAction?{hostAction}:{}),...(s?.resourceTargetHash?{resourceTargetHash:s.resourceTargetHash}:{}),
   instanceId,phase:'DISPATCHING',at:new Date(now()).toISOString()};
 }
 function sessionState(s,state){
  const r=read(s.openRequestId);
  if(!r||r.ownerHash!==s.ownerHash||r.session_id!==s.id||r.operation!=='open')throw Error('HOST_SESSION_JOURNAL_BINDING_UNPROVEN');
  save(r.request_id,{...r,sessionState:state,capHash:s.capHash,
   ...(s.resourceTargetHash?{resourceTargetHash:s.resourceTargetHash}:{}),
   session_state_at:new Date(now()).toISOString()});
 }
 async function completeOperation(rec,fn,s){
  try{
   const output=await fn();const bytes=JSON.stringify(output);rec={...rec,...read(rec.request_id),phase:'COMPLETED',resultHash:sha(bytes)};
   save(rec.request_id,rec);
   // Images and downloads are returned once, not retained in a 24-entry RAM cache.
   if(Buffer.byteLength(bytes)<=262144)cache.set(rec.request_id,output);
   while(cache.size>24)cache.delete(cache.keys().next().value);return output;
  }catch(e){
   rec={...rec,...read(rec.request_id),phase:e.beforeDispatch?'NOT_DISPATCHED':'OUTCOME_UNKNOWN',error:String(e.message).slice(0,150)};
   if(rec.operation==='open'&&e.beforeDispatch)rec.sessionState='NOT_DISPATCHED';
   save(rec.request_id,rec);if(s&&!e.beforeDispatch){s.uncertain=true;try{sessionState(s,'UNKNOWN');}catch{}}throw e;
  }
 }
 async function openRequest(a){
  const prior=read(a.request_id);
  if(prior){
   if(prior.ownerHash!==sha(a.client_key)||prior.requestHash!==sha(JSON.stringify(a)))throw Error('REQUEST_ID_CONFLICT');
   const w=waiting.get(a.request_id);
   return w?result({ok:true,...queuedView(w),capacity:capacity()}):journalResult(prior);
  }
  validateOpen(a);
  if(recoveryHold())return transaction(a,()=>open(a));
  if(a.wait_for_capacity===true&&(!hasCapacity(a.kind)||firstEligible())){
   if(waiting.size>=12)throw Object.assign(Error('HOST_WAIT_QUEUE_FULL'),{beforeDispatch:true});
   const rec={...newRecord(a),phase:'QUEUED'};save(a.request_id,rec);
   const w={args:{...a},metadata:metadata(a),at:rec.at};waiting.set(a.request_id,w);
   return result({ok:true,...queuedView(w),capacity:capacity()});
  }
  return transaction(a,()=>open(a));
 }
 async function waitRequest(a){
  const rec=read(a.request_id);
  if(!rec)return result({ok:false,status:'NOT_FOUND',dispatched:false,replayed:false});
  if(rec.ownerHash!==sha(a.client_key))throw Error('OPERATION_OWNER_MISMATCH');
  if(rec.phase!=='QUEUED')return journalResult(rec);
  if(a.action==='cancel'){
   save(a.request_id,{...rec,phase:'CANCELLED',cancelled_at:new Date(now()).toISOString()});
   waiting.delete(a.request_id);
   const recoveredIndex=recovered.findIndex(r=>r.request_id===a.request_id&&r.recovery==='QUEUED_CONTEXT_LOST');if(recoveredIndex>=0)recovered.splice(recoveredIndex,1);
   return result({ok:true,status:'CANCELLED',request_id:a.request_id,dispatched:false,session_closed:false,replayed:false});
  }
  const w=waiting.get(a.request_id);
  if(!w)return journalResult(rec);
  if(rec.requestHash!==sha(JSON.stringify(w.args)))throw Error('QUEUED_REQUEST_BINDING_CHANGED');
  if(firstEligible()!==w)return result({ok:true,...queuedView(w),capacity:capacity()});
  save(a.request_id,{...rec,phase:'DISPATCHING',claimed_at:new Date(now()).toISOString()});
  waiting.delete(a.request_id);
  return completeOperation(rec,()=>open(w.args,true));
 }
 function ownedSessions(a){
  const owner=sha(a.client_key);
  return result({ok:true,scope:'task-owned-v1',capacity:capacity(),
   sessions:[...sessions.values()].filter(s=>s.ownerHash===owner).map(s=>({
    session_id:s.id,request_id:s.openRequestId,kind:s.kind,owner:'THIS_CLIENT',...s.metadata,
    created_at:new Date(s.created).toISOString(),last_activity_at:new Date(s.touched).toISOString(),
    last_observation_at:s.observation?new Date(s.observation.at).toISOString():null,
    state:s.uncertain?'UNKNOWN':s.closePending?'CLOSE_PENDING':'OPEN',
    return_allowed:!s.uncertain,
    return_reason:s.uncertain?'ORIGINAL_OPERATION_UNCERTAIN':s.closePending?'OWNER_HANDLE_UNSAVED_OR_REFUSED_CLOSE':now()-s.touched>600000?'IDLE_EXPIRED_NORMAL_CLOSE_ONLY':'OWNER_NORMAL_CLOSE_WITH_ORIGINAL_LEASE',
    automatic_return_allowed:!s.uncertain&&!s.closePending&&!s.expiryCloseAttempted&&now()-s.touched>600000,
    next_actor:'ORIGINAL_CLIENT_WITH_LEASE'})),
   waiting:[...waiting.values()].filter(w=>sha(w.args.client_key)===owner).map(queuedView),
   recovered:recovered.filter(r=>r.ownerHash===owner).slice(0,24).map(r=>({request_id:r.request_id,kind:r.kind??'UNKNOWN',
    status:r.recovery,record_phase:r.phase,dispatched:r.phase==='QUEUED'?false:'UNKNOWN',session_return:'UNPROVEN',replayed:false,next_actor:'ORIGINAL_CLIENT_OR_HOST_OWNER',
    ...(originalOpenReturnEvidence(r)?{returnEvidence:originalOpenReturnEvidence(r)}:{})})),
   recovered_truncated:recovered.filter(r=>r.ownerHash===owner).length>24,
   lease_disclosure:false,other_owner_details:false});
 }
 const attach=connect??(async (kind)=>{
  const spec=kind==='browser'?config.aside:config.cua;
  const transport=new StdioClientTransport({command:spec.command,args:spec.args,env:getDefaultEnvironment(),stderr:'pipe'});transport.stderr?.resume();
  const client=new Client({name:'aicc-task-owned-'+kind,version:'1.0.0'},{capabilities:{}});
  try{await client.connect(transport);return client;}catch(e){await transport.close();throw e;}
 });
 const call=(s,name,args)=>s.client.callTool({name,arguments:args},undefined,{timeout:60000});
 const browser=async(s,code)=>{
  const marker='AICC_HOST_ACK_'+randomBytes(8).toString('hex');
  const guard=`var aiccGuard=()=>{if(typeof page!=='undefined'&&page&&${JSON.stringify(config.blockedUrlFragments??[])}.some(v=>page.url().includes(v)))throw Error('ORIGINAL_RESOURCE_REFUSAL_PRESERVED');};`;
  const guarded=code.includes('closeTab(page)')?code:`aiccGuard();${code.replaceAll('snapshot(page)','(aiccGuard(),snapshot(page))')};aiccGuard();`;
  const raw=await call(s,'repl',{title:'AICC 작업 소유 탭',code:guard+guarded+`;console.log(${JSON.stringify(marker)});`});
  check(raw);if(!textOf(raw).includes(marker))throw Error('ASIDE_ACK_UNKNOWN_NO_REPLAY');
  return {...raw,content:raw.content?.map(c=>c.type==='text'?{...c,text:c.text.replaceAll(marker,'').trim()}:c)};
 };
 function safeUrl(raw){const u=new URL(raw);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error('HTTP_URL_WITHOUT_CREDENTIALS_REQUIRED');if((config.blockedUrlFragments??[]).some(v=>u.href.includes(v)))throw Error('ORIGINAL_RESOURCE_REFUSAL_PRESERVED');return u.href;}
 function getSession(args){const s=sessions.get(args.session_id);if(!s||sha(args.lease)!==s.capHash)throw Error('HOST_LEASE_UNKNOWN');if(s.closed)throw Error('HOST_SESSION_CLOSED');if(now()-s.touched>600000)throw Error('HOST_SESSION_IDLE_EXPIRED_CLOSE_ONLY');s.touched=now();return s;}
 function getForClose(args){const s=sessions.get(args.session_id);if(!s||sha(args.lease)!==s.capHash)throw Error('HOST_LEASE_UNKNOWN');return s;}
 const isSamePid=async s=>{const p=await pidInfo(s.pid);if(!p||p.created!==s.process.created||p.image!==s.process.image)throw Error('PROCESS_IDENTITY_CHANGED');};
 async function windows(s){return unpack(check(await call(s,'list_windows',{pid:s.pid})));}
 function listWindows(data){return Array.isArray(data)?data:data.windows??data.apps??[];}
 function locateWindow(data,pid,windowId){return listWindows(data).find(w=>(w.pid===undefined||Number(w.pid)===pid)&&Number(w.window_id??w.id)===windowId);}
 function stampObservation(s,raw){const data=unpack(raw),txt=textOf(raw);s.observation={id:randomUUID(),at:now(),refs:new Set([...txt.matchAll(/\[ref=([^\]]+)\]/g)].map(m=>m[1])),tokens:new Set((data.elements??[]).map(x=>x.element_token).filter(Boolean)),bounds:data.window_bounds??null};return result({ok:!raw.isError,session_id:s.id,kind:s.kind,observation_id:s.observation.id,observed_at:new Date(now()).toISOString(),state:data,...(s.kind==='browser'?{snapshot:txt}:{pid:s.pid,window_id:s.windowId})},raw.content??[]);}
 async function observe(s,screenshot=false){
  if(s.kind==='browser'){
   if(s.backend==='cdp'){
    try{return stampObservation(s,await s.cdp.observe({screenshot}));}
    catch(e){s.uncertain=true;try{sessionState(s,'UNKNOWN');}catch{}throw e;}
   }
   const raw=check(await browser(s,`console.log((await snapshot(page)).tree);${screenshot?'await display(await page.screenshot());':''}`));return stampObservation(s,raw);
  }
  await isSamePid(s);const raw=await call(s,'get_window_state',{pid:s.pid,window_id:s.windowId,max_elements:350,max_depth:20,max_dimension:1280,include_screenshot:screenshot});return stampObservation(s,check(raw));
 }
 async function close(s){
  if(s.closed)return result({ok:true,status:'CLOSED',session_id:s.id});
  if(s.uncertain)return result({ok:false,status:'HOLD_UNCERTAIN',session_id:s.id});
  const pendingClose=reason=>{s.closePending=true;sessionState(s,'CLOSE_PENDING');return result({ok:false,status:'CLOSE_PENDING',reason,session_id:s.id});};
  if(s.kind==='browser'){
   if(s.backend==='cdp'){
    if(!s.cdp)return pendingClose('CDP_ACQUIRE_OR_TARGET_UNPROVEN');
    const outcome=await s.cdp.close();
    if(outcome?.ok!==true||outcome.closed!==true)return pendingClose('CDP_EXACT_LEASE_RELEASE_UNPROVEN');
   }else check(await browser(s,'if(!page){throw Error("ASIDE_OWNED_PAGE_UNPROVEN");}await closeTab(page);console.log("AICC_OWN_TAB_CLOSED");'));
  }
  else{
   const proc=await pidInfo(s.pid);
   if(proc){await isSamePid(s);const before=await call(s,'get_window_state',{pid:s.pid,window_id:s.windowId,max_elements:150,include_screenshot:false});
    if(!before.isError){const closeButton=(unpack(before).elements??[]).find(e=>e.role==='Button'&&/^(닫기|Close)$/i.test(e.label??''));let action=closeButton?await call(s,'click',{pid:s.pid,window_id:s.windowId,element_token:closeButton.element_token,delivery_mode:'background'}):await call(s,'hotkey',{pid:s.pid,window_id:s.windowId,keys:['alt','f4'],delivery_mode:'background'});if(action.isError&&metadataError(action)==='background_unavailable'){await isSamePid(s);check(await call(s,'get_window_state',{pid:s.pid,window_id:s.windowId,max_elements:150,include_screenshot:false}));action=await call(s,'hotkey',{pid:s.pid,window_id:s.windowId,keys:['alt','f4'],delivery_mode:'foreground'});}if(action.isError)return pendingClose(metadataError(action));}
    const remaining=await windows(s);if(locateWindow(remaining,s.pid,s.windowId))return pendingClose('WINDOW_REMAINS; observe and handle only this window');
   }
  }
  // Do not publish CLOSED while the task-owned executor transport is still
  // open or its normal close acknowledgement is uncertain. Transport close
  // does not prove unrelated OS child-process termination.
  await s.client.close();if(s.cdp)await s.cdp.disconnect();
  sessionState(s,'CLOSED');s.closed=true;sessions.delete(s.id);return result({ok:true,status:'CLOSED',session_id:s.id});
 }
 async function transaction(args,fn,s,hostAction=null){
  const prior=read(args.request_id),ownerHash=s?.ownerHash??sha(args.client_key);
  if(prior){
   if(prior.ownerHash!==ownerHash||prior.requestHash!==sha(JSON.stringify(args)))throw Error('REQUEST_ID_CONFLICT');
   return journalResult(prior);
  }
  const rec=newRecord(args,s,hostAction);save(args.request_id,rec);
  return completeOperation(rec,fn,s);
 }
 async function open(a,claimed=false){
  if(a.kind==='browser'&&!a.url||a.kind==='desktop'&&!a.app_key)throw Object.assign(Error('URL_OR_APP_KEY_REQUIRED'),{beforeDispatch:true});
  const spec=a.kind==='desktop'?config.apps?.[a.app_key]:null;
  if(a.kind==='desktop'&&!spec)throw Object.assign(Error('APP_NOT_REGISTERED'),{beforeDispatch:true});
  if(recoveryHold())throw Object.assign(Error('HOST_HISTORY_UNPROVEN'),{beforeDispatch:true});
  if(!hasCapacity(a.kind))throw Object.assign(Error('HOST_SESSION_LIMIT'),{beforeDispatch:true});
  if(!claimed&&firstEligible())throw Object.assign(Error('HOST_SHARED_WAIT_CLAIM_REQUIRED'),{beforeDispatch:true});
  const url=a.kind==='browser'?safeUrl(a.url):null;
  const backend=browserBackend(a);
  // A CDP request never starts the Aside REPL; the registered lease helper
  // and Playwright attach only after durable OPENING is recorded.
  const client=backend==='cdp'?{close:async()=>{}}:await attach(a.kind),cap=randomBytes(32).toString('hex'),s={id:randomUUID(),capHash:sha(cap),ownerHash:sha(a.client_key),kind:a.kind,backend,client,touched:now(),created:now(),closed:false,closePending:false,openRequestId:a.request_id,metadata:metadata(a)};
  const opening=read(a.request_id);
  if(!opening||opening.ownerHash!==s.ownerHash||opening.phase!=='DISPATCHING')throw Error('HOST_OPEN_JOURNAL_BINDING_UNPROVEN');
  save(a.request_id,{...opening,session_id:s.id,sessionState:'OPENING'});
  sessions.set(s.id,s);
  try{
   if(a.kind==='browser'){
    if(backend==='cdp')s.cdp=await cdpFactory({...config.cdp,powershell:config.powershell,blockedUrlFragments:config.blockedUrlFragments},
     {identityId:a.browser_identity,url,ownerTaskId:'aicc-host-'+s.id});
    else check(await browser(s,`await openTab(${JSON.stringify(url)});console.log((await snapshot(page)).tree);`));
   }
   else{
    const running=await pidInfo();const existing=new Set(running.map(p=>Number(p.pid??p)));if((spec.launch?.path&&running.some(p=>p.image?.toLowerCase()===spec.launch.path.toLowerCase()))||spec.processNames?.some(name=>running.some(p=>p.image&&path.basename(p.image).toLowerCase()===name.toLowerCase())))throw Object.assign(Error('REGISTERED_APP_ALREADY_RUNNING_USER_INSTANCE_PRESERVED'),{beforeDispatch:true});
    if(spec.sha256&&sha(fs.readFileSync(regular(spec.launch.path)))!==spec.sha256)throw Error('REGISTERED_APP_PIN_CHANGED');
    const launch=check(await call(s,'launch_app',{...(spec.launch??spec),start_minimized:false})),data=unpack(launch);s.pid=Number(data.pid);
    if(!s.pid||existing.has(s.pid)){s.uncertain=true;throw Error('NEW_PROCESS_NOT_PROVEN_EXISTING_USER_TARGET_PRESERVED');}
    s.process=await pidInfo(s.pid);if(!s.process)throw Error('LAUNCHED_PROCESS_NOT_OBSERVED');
    const ws=data.windows?.length?data.windows:listWindows(await windows(s));
    const w=ws.find(w=>w.pid===undefined||Number(w.pid)===s.pid);s.windowId=Number(w?.window_id??w?.id);if(!s.windowId)throw Error('NEW_WINDOW_NOT_OBSERVED');
   }
   // Resource identity is taken only from the official acquired target or
   // exact observed task-launched process; an Aside REPL has no durable
   // target identity and must never become an adoptable historic handle.
   if(s.kind==='browser'&&s.backend==='cdp'&&s.cdp?.targetId&&s.cdp?.identityId)
    s.resourceTargetHash=sha(JSON.stringify(['cdp',s.cdp.identityId,s.cdp.targetId]));
   else if(s.kind==='desktop'&&s.pid&&s.windowId&&s.process?.created&&s.process?.image)
    s.resourceTargetHash=sha(JSON.stringify(['cua',s.pid,s.windowId,s.process.created,s.process.image]));
   sessionState(s,'OPEN');
   return result({ok:true,session_id:s.id,lease:cap,kind:s.kind,expires_after_idle_seconds:600,scope:'task-owned-only',...(s.kind==='desktop'?{pid:s.pid,window_id:s.windowId}:{}),observation:await observe(s,false)});
  }catch(e){if(e.beforeDispatch){sessions.delete(s.id);await s.client.close();await s.cdp?.disconnect().catch(()=>{});throw e;}
   if(backend==='cdp'){s.uncertain=true;await s.cdp?.disconnect().catch(()=>{});}
   else if(s.kind==='browser'&&!s.uncertain){try{await close(s);}catch{}}
   else s.uncertain=true;
   throw e;}
 }
 async function act(s,a){
  const o=s.observation;if(!o||o.id!==a.observation_id||now()-o.at>120000)throw Object.assign(Error('FRESH_OBSERVATION_REQUIRED'),{beforeDispatch:true});
  if(s.uncertain)throw Object.assign(Error('ORIGINAL_OPERATION_UNCERTAIN'),{beforeDispatch:true});
  if(s.kind==='browser'){
   if(a.delivery_mode==='foreground'||a.element_token||a.x!==undefined||a.y!==undefined)throw Object.assign(Error('BROWSER_REQUIRES_OBSERVED_REF'),{beforeDispatch:true});
   if(a.action!=='navigate'&&(!a.ref||!o.refs.has(a.ref)))throw Object.assign(Error('OBSERVED_REF_REQUIRED'),{beforeDispatch:true});
   if(s.backend==='cdp'){
    if(!['click','fill','press','select','check','navigate','download'].includes(a.action))throw Object.assign(Error('UNSUPPORTED_CDP_ACTION'),{beforeDispatch:true});
    if(a.action==='navigate')safeUrl(a.url);
    s.observation=null;
    const raw=await s.cdp.act(a.action,a);
    return stampObservation(s,raw);
   }
   const loc=`page.locator(${JSON.stringify(a.ref)})`;
   const codes={click:()=>`${loc}.click()`,fill:()=>`${loc}.fill(${JSON.stringify(a.text??'')})`,press:()=>`${loc}.press(${JSON.stringify(a.key)})`,select:()=>`${loc}.selectOption(${JSON.stringify(a.text)})`,check:()=>`${loc}.check()`,navigate:()=>`page.goto(${JSON.stringify(safeUrl(a.url))})`};
   if(!codes[a.action])throw Object.assign(Error('UNSUPPORTED_BROWSER_ACTION'),{beforeDispatch:true});
   s.observation=null;const raw=await browser(s,`await ${codes[a.action]()};console.log((await snapshot(page)).tree);`);if(raw.isError){s.lastError=metadataError(raw);return result({ok:false,status:'ACTION_REFUSED',reason:s.lastError},raw.content??[]);}if(a.action==='navigate')s.metadata.allowed_url={origin:new URL(safeUrl(a.url)).origin,path:'REDACTED',query:'REDACTED',fragment:'REDACTED',current_url:'UNPROVEN'};return stampObservation(s,raw);
  }
  await isSamePid(s);
  if(a.ref||a.url||['navigate','select','check'].includes(a.action))throw Object.assign(Error('UNSUPPORTED_DESKTOP_ACTION'),{beforeDispatch:true});
  if(a.element_token&&!o.tokens.has(a.element_token))throw Object.assign(Error('OBSERVED_ELEMENT_REQUIRED'),{beforeDispatch:true});
  const pixels=a.x!==undefined&&a.y!==undefined;
  if(pixels){const b=o.bounds;if(!b||a.x<0||a.y<0||a.x>=(b.width??b.w)||a.y>=(b.height??b.h))throw Object.assign(Error('PIXEL_OUTSIDE_OBSERVED_WINDOW'),{beforeDispatch:true});}
  if(['click','fill','scroll'].includes(a.action)&&!a.element_token&&!pixels)throw Object.assign(Error('OBSERVED_TARGET_REQUIRED'),{beforeDispatch:true});
  const fingerprint=sha(JSON.stringify({...a,request_id:null,observation_id:null,delivery_mode:null}));
  if(a.delivery_mode==='foreground'&&s.escalation!==fingerprint)throw Object.assign(Error('BACKGROUND_UNAVAILABLE_REQUIRED'),{beforeDispatch:true});
  const base={pid:s.pid,window_id:s.windowId,delivery_mode:a.delivery_mode??'background',...(a.element_token?{element_token:a.element_token}:{}),...(pixels?{x:a.x,y:a.y}:{})};
  const names={click:'click',fill:'type_text',press:'press_key',hotkey:'hotkey',scroll:'scroll'};
  const args={...base,...(a.action==='fill'?{text:a.text??''}:{}),...(a.action==='press'?{key:a.key}:{}),...(a.action==='hotkey'?{keys:a.keys}:{}),...(a.action==='scroll'?{direction:a.direction,amount:a.amount??3}:{})};
  s.observation=null;const raw=await call(s,names[a.action],args);
  if(raw.isError){const code=metadataError(raw);s.escalation=code==='background_unavailable'?fingerprint:null;return result({ok:false,status:'ACTION_REFUSED',reason:code,...(code==='background_unavailable'?{escalation:'Observe again then retry only the same action with foreground'}:{})},raw.content??[]);}
  s.escalation=null;return result({ok:true,actionResult:unpack(raw),postcondition:await observe(s,false)},raw.content??[]);
 }

/** Explicit same-owner return reconciliation. Never acquires, attaches,
  * closes, resumes or replays a historical resource. A completed tagged
  * normal-close journal is the resource return authority, not a stale
  * capacity snapshot, absent PID, returned status or a caller assertion.
  */
 function reconcileHistoricalReturn(a){
  const owner=a.history_recovery,openId=owner.open_request_id,closeId=owner.close_request_id;
  if(a.request_id===openId||a.request_id===closeId)
   throw Error('HOST_RECOVERY_NEW_REQUEST_ID_REQUIRED');
  const ownerHash=sha(owner.client_key);
  const original=proofRecord(config.stateRoot,openId);
  if(original.value.ownerHash!==ownerHash)
   throw Error('HOST_RECOVERY_OWNER_MISMATCH');
  if(sessions.has(a.session_id)||
     [...sessions.values()].some(s=>s.resourceTargetHash&&s.resourceTargetHash===original.value.resourceTargetHash))
   throw Error('HOST_RECOVERY_RESOURCE_STILL_LIVE');
  const proof=provedNormalReturn(config.stateRoot,openId,closeId,
   {client_key:owner.client_key,session_id:a.session_id,lease:a.lease});
  const requestHash=sha(JSON.stringify(a));
  if(read(a.request_id))throw Error('HOST_RECOVERY_REQUEST_ID_COLLISION');
  const dir=returnDirectory(config.stateRoot),file=path.join(dir,openId+'.json');
  // Any existing receipt must validate against the exact current original
  // records and be the same request. An invalid or foreign receipt never
  // authorizes a new write.
  if(fs.existsSync(dir)){
   const indexed=readReturnReceipts(config.stateRoot);
   if(indexed.invalid.length)throw Error('HOST_RETURN_RECEIPT_UNREADABLE');
   const existing=indexed.records.find(r=>r.open_request_id===openId);
   if(existing){
    if(existing.request_id!==a.request_id||existing.reconcileRequestHash!==requestHash)
     throw Error('HOST_RETURN_ALREADY_RECONCILED_DIFFERENT_REQUEST');
    reloadReconciledHistory();
    return result({ok:true,status:'HISTORY_RETURN_RECONCILED',request_id:a.request_id,
     original_request_id:openId,original_outcome:proof.open.value.phase,
     original_outcome_unmodified:true,resource_return:'PROVEN_NORMAL_CLOSE',
     resolution_receipt_sha256:existing.receiptSha256,replayed:false,capacity:capacity()});
   }
  }
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.lstatSync(dir).isSymbolicLink()||!fs.lstatSync(dir).isDirectory())
   throw Error('HOST_RETURN_RECEIPT_DIRECTORY_LINKED');
  const receipt={schemaVersion:1,kind:'host-history-normal-return/v1',request_id:a.request_id,
   open_request_id:openId,close_request_id:closeId,ownerHash,session_id:a.session_id,
   instanceId:proof.open.value.instanceId,resourceTargetHash:proof.open.value.resourceTargetHash,
   openJournalSha256:proof.open.sha256,closeJournalSha256:proof.close.sha256,
   closeResultHash:proof.close.value.resultHash,reconcileRequestHash:requestHash,
   reconciledAt:new Date(now()).toISOString()};
  const bytes=JSON.stringify(receipt);
  const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  reloadReconciledHistory();
  if(!resolvedReturns.some(r=>r.open_request_id===openId))
   throw Error('HOST_RETURN_RECEIPT_POSTWRITE_UNPROVEN');
  return result({ok:true,status:'HISTORY_RETURN_RECONCILED',request_id:a.request_id,
   original_request_id:openId,original_outcome:proof.open.value.phase,
   original_outcome_unmodified:true,resource_return:'PROVEN_NORMAL_CLOSE',
   resolution_receipt_sha256:sha(bytes),replayed:false,capacity:capacity()});
 }
 const methods={
  aicc_host_capabilities:async()=>result({ok:true,scope:'task-owned-v1',browser:config.cdp?.enabled===true?'Registered CDP/Playwright exact task target; Aside explicit auxiliary':'Aside fixed REPL executor, no extra model',defaultBrowserBackend:config.cdp?.enabled===true?'cdp':'aside',browserBackends:config.cdp?.enabled===true?['cdp','aside']:['aside'],cdpIdentityRequired:config.cdp?.enabled===true,cdpIdentityDiscovery:discoverHostCdpIdentityIds(config.cdp),desktop:'Cua persistent MCP lifecycle, new registered app process only',apps:Object.keys(config.apps??{}),maximumSessions:4,maximumBrowserSessions:3,maximumDesktopSessions:1,idleSeconds:600,sessionInventory:'owner-only-v1',sharedWait:'explicit-claim-v1',maximumWaiting:12,automaticWaitDispatch:false,historyAdmission:'session-evidence-v1',arbitraryCode:false,workspaceExecSandboxUnchanged:true,legacyRefusalsPreserved:true}),
  aicc_host_open:a=>openRequest(a),
  aicc_host_sessions:a=>ownedSessions(a),
  aicc_host_wait:a=>waitRequest(a),
  aicc_host_observe:a=>observe(getSession(a),a.screenshot===true),
  aicc_host_act:a=>{const s=getSession(a);return transaction(a,()=>act(s,a),s);},
  aicc_host_close:a=>{if(a.history_recovery)return reconcileHistoricalReturn(a);const prior=read(a.request_id);if(prior){if(prior.requestHash!==sha(JSON.stringify(a)))throw Error('REQUEST_ID_CONFLICT');return cache.get(a.request_id)??result({ok:prior.phase==='COMPLETED',status:prior.phase,request_id:a.request_id,resultEvicted:true,replayed:false});}const s=getForClose(a);return transaction(a,()=>close(s),s,'normal-close/v1');},
  aicc_host_operation_status:async a=>{const r=read(a.request_id);if(!r)return result({ok:true,status:'NOT_FOUND',dispatched:false});if(r.ownerHash!==sha(a.client_key))throw Error('OPERATION_OWNER_MISMATCH');const w=waiting.get(a.request_id);if(w)return result({ok:true,...queuedView(w),capacity:capacity()});const original=journalResult(r),returnProof=resolvedReturns.find(v=>v.open_request_id===a.request_id);if(returnProof)return result({...original.structuredContent,history_return:{status:'PROVEN_NORMAL_CLOSE_SEPARATE',receipt_sha256:returnProof.receiptSha256,original_outcome_unmodified:true,replayed:false}});const evidence=originalOpenReturnEvidence(r);return evidence?result({...original.structuredContent,returnEvidence:evidence}):original;}
 };
 const timer=setInterval(()=>{if(pending)return;for(const s of sessions.values())if(!s.closed&&!s.uncertain&&!s.closePending&&!s.expiryCloseAttempted&&now()-s.touched>600000){s.expiryCloseAttempted=true;void enqueue(async()=>{try{return await close(s);}catch(e){s.uncertain=true;try{sessionState(s,'UNKNOWN');}catch{};throw e;}}).catch(()=>{});}},30000);timer.unref();
 function enqueue(fn){if(pending>=12)return Promise.reject(Object.assign(Error('HOST_QUEUE_FULL_NOT_DISPATCHED'),{beforeDispatch:true}));pending++;const p=tail.then(fn);tail=p.catch(()=>{}).finally(()=>pending--);return p;}
 return {
  tools:HOST_TOOLS,
  async call(name,a){if(closing)throw Error('HOST_CLOSING_NOT_DISPATCHED');if(!schemas.get(name)?.(a))return result({ok:false,status:'INVALID_REQUEST_NOT_DISPATCHED'});try{return await enqueue(()=>methods[name](a));}catch(e){return {...result({ok:false,status:e.beforeDispatch?'NOT_DISPATCHED':'HOLD',reason:String(e.message).slice(0,200),retry:false,...(['HOST_SESSION_LIMIT','HOST_SHARED_WAIT_CLAIM_REQUIRED','HOST_HISTORY_UNPROVEN'].includes(e.message)?{category:e.message==='HOST_HISTORY_UNPROVEN'?'HISTORY_UNPROVEN':'CAPACITY',capacity:capacity(),next_tool:'aicc_host_sessions',original_request_replay:false}:{})},e.driverResult?.content??[]),isError:true};}},
  async close(){closing=true;clearInterval(timer);await tail;for(const s of [...sessions.values()]){
   // Shutdown is not consent to close a recently active tab/window.
   // Only the same exact owned session already beyond the idle threshold
   // may attempt normal close. Pending/UNKNOWN retains original evidence.
   if(s.uncertain||s.closePending||now()-s.touched<=600000)continue;
   try{await close(s);}catch{ s.uncertain=true;try{sessionState(s,'UNKNOWN');}catch{} }
  }}
 };
}
export async function runHostServer(configFile){
 const cfg=JSON.parse(fs.readFileSync(regular(configFile),'utf8'));const host=await createHostController(cfg);
 const server=new Server({name:'aicc-task-owned-host-control',version:'1.0.0'},{capabilities:{tools:{}},instructions:'Use only user-authorized tasks. Host leases are separate from Workspace/Codex. Do not adopt existing user tabs/windows or bypass prior resource/security refusals. Observe before actions and retain request IDs. No extra model is used.'});
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:HOST_TOOLS}));server.setRequestHandler(CallToolRequestSchema,r=>host.call(r.params.name,r.params.arguments??{}));
 let stop;const close=()=>stop??=(async()=>{await host.close();await server.close();})();server.onclose=()=>void close();process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());await server.connect(new StdioServerTransport());return {host,server,close};
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--config')throw Error('Usage: server.mjs --config ABSOLUTE_JSON');runHostServer(args[1]).catch(()=>{console.error('AICC host control initialization refused');process.exitCode=1;});}







