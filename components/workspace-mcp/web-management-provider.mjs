import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

const SHA=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const ACTIONS=new Set(['project-inspect','project-status','project-source-read','project-create','project-update','project-upload','project-source-delete','project-delete','plugin-delete','instructions-inspect','instructions-update','personal-skill-list','personal-skill-inspect','personal-skill-plan-add-file','personal-skill-plan-file','personal-skill-upload','personal-skill-update','personal-skill-update-body','personal-skill-add-file','personal-skill-delete','title-inventory','title-read','title-rename']);
const READ_ACTIONS=new Set(['project-inspect','project-status','project-source-read','instructions-inspect','personal-skill-list','personal-skill-inspect','personal-skill-plan-add-file','personal-skill-plan-file','title-inventory','title-read']);
const INPUT_KEYS=new Set(['schemaVersion','action','remoteId','name','memory','instructions','sources','source','expectedName','expectedVersion','preimageSHA256','instructionsSHA256','sourceCount','includeActionMenu','desired','confirm','conversationCount','previewDelete','desiredFields','commit','backupReceipt','skill','title']);
const sessions=new Map();
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2);
function inside(root,file){const relative=path.relative(root,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function regular(file){
 if(!path.isAbsolute(file||''))throw Error('Owner binding requires absolute paths');
 for(let current=path.resolve(file);;current=path.dirname(current)){
  const item=fs.lstatSync(current);if(item.isSymbolicLink())throw Error('Linked management paths are refused');
  if(current===path.dirname(current))break;
 }
 if(!fs.statSync(file).isFile())throw Error('A regular management file is required');
 return fs.realpathSync(file);
}
function pinned(file,hash){if(!SHA.test(hash||'')||digest(fs.readFileSync(regular(file)))!==hash)throw Error('Owner management pin changed');return file;}
function boundedJson(file,maximum=1048576){const exact=regular(file);if(fs.statSync(exact).size>maximum)throw Error('Management JSON exceeds its bound');return JSON.parse(fs.readFileSync(exact,'utf8').replace(/^\uFEFF/,''));}
function relativeFile(root,value){
 if(typeof value!=='string'||!value||path.isAbsolute(value)||value.split(/[\\/]/).some(part=>!part||part==='.'||part==='..'||part.startsWith('.')||/[<>:\"|?*\x00-\x1f]/.test(part)||/[. ]$/.test(part)))throw Error('A bounded non-hidden workspace file is required');
 const exact=regular(path.resolve(root,value));if(!inside(root,exact))throw Error('Management input escaped its registered workspace');return exact;
}
function allowedFile(root,value){const exact=regular(value);if(!inside(root,exact)||path.relative(root,exact).split(path.sep).some(part=>part.startsWith('.')||/[<>:\"|?*\x00-\x1f]/.test(part)||/[. ]$/.test(part)))throw Error('Management asset must stay in the registered non-hidden workspace');return exact;}
function operationFiles(directory,requestId){if(!ID.test(requestId||''))throw Error('Invalid management request ID');const prefix=path.join(directory,requestId);return {record:prefix+'.json',request:prefix+'.request.json',result:prefix+'.result.json'};}
function writeNew(file,value){fs.writeFileSync(file,json(value),{encoding:'utf8',flag:'wx',mode:0o600});}
function writeRecord(file,value){const descriptor=fs.openSync(file,'r+');try{fs.ftruncateSync(descriptor,0);fs.writeFileSync(descriptor,json(value));fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}}
function readBinding(config,workspace){
 const declaration=config.webManagement;
 if(config.surfaceProfile==='personal-read-fetch'||declaration?.enabled!==true)throw Error('Named Web management is not owner-bound on this deployment');
 const bindingFile=pinned(declaration.bindingFile,declaration.bindingSha256);
 if(inside(workspace.root,bindingFile))throw Error('Management authority must be outside the remotely writable workspace');
 const binding=boundedJson(bindingFile);
 if(binding.executionBoundary!=='owner-registered-fixed-web-manager')throw Error('Explicit named execution boundary required');
 if(!Array.isArray(binding.blockedRequestHashes)||binding.blockedRequestHashes.some(value=>!SHA.test(value))||!Array.isArray(binding.blockedAssetKeys)||binding.blockedAssetKeys.some(value=>typeof value!=='string'))throw Error('Owner denial reconciliation lists required');
 if(binding.schemaVersion!==1||binding.kind!=='aicc-web-management-owner-binding'||binding.workspaceAlias!==workspace.alias||fs.realpathSync(binding.workspaceRoot)!==fs.realpathSync(workspace.root))throw Error('Exact registered management workspace binding required');
 if(!SHA.test(binding.identityHash||'')||!SHA.test(binding.workspaceIdentityHash||'')||typeof binding.account!=='string'||!ID.test(binding.bindingId||''))throw Error('Exact management identity binding required');
 if(!Array.isArray(binding.allowedActions)||!binding.allowedActions.length||binding.allowedActions.some(action=>!ACTIONS.has(action)))throw Error('Invalid owner action allowlist');
 pinned(binding.node,binding.nodeSha256);pinned(binding.entry,binding.entrySha256);pinned(binding.config,binding.configSha256);
 if(!Array.isArray(binding.dependencyPins)||!binding.dependencyPins.length)throw Error('Owner-reviewed dependency pins are required');
 for(const pin of binding.dependencyPins)pinned(pin.path,pin.sha256);
 for(const file of [binding.entry,binding.config,...binding.dependencyPins.map(pin=>pin.path)])if(inside(workspace.root,fs.realpathSync(file)))throw Error('Fixed manager code and config must be outside the remotely writable workspace');
 const directory=fs.realpathSync(binding.operationDirectory);
 if(fs.lstatSync(binding.operationDirectory).isSymbolicLink())throw Error('Linked operation directory refused');
 for(const key of ['maximumOutputBytes','timeoutMs'])if(binding[key]!==undefined&&(!Number.isSafeInteger(binding[key])||binding[key]<1))throw Error('Invalid management resource limit');
 if(!fs.statSync(directory).isDirectory()||inside(workspace.root,directory))throw Error('Operation records must be owner-only and outside the remote workspace');
 return {...binding,operationDirectory:directory};
}
export function prepareWebManagementRequest(raw,binding,workspace,resultFile){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!INPUT_KEYS.has(key)))throw Error('Unknown management request field');
 if(raw.schemaVersion!==1||!binding.allowedActions.includes(raw.action))throw Error('Management action is outside its owner binding');
 const input=structuredClone(raw);
 const assetKey=raw.action==='project-create'?'project|'+binding.account+'|'+raw.name:raw.action.startsWith('project-')?'project|'+binding.account+'|'+raw.remoteId:raw.action==='plugin-delete'?'plugin|'+raw.remoteId:raw.action.startsWith('personal-skill-')?'skill|'+binding.account+'|'+(raw.skill?.skillId||raw.skill?.name):raw.action.startsWith('title-')?'chat-title|'+binding.account+'|'+raw.title?.conversationId:'instructions|'+binding.account+'|personalization';
 // A preserved unresolved/denied skill name stays fenced even when a later caller supplies an ID.
 const skillNameKey=raw.action.startsWith('personal-skill-')?'skill|'+binding.account+'|'+raw.skill?.name:null;
 if(binding.blockedAssetKeys?.includes(assetKey)||(skillNameKey&&binding.blockedAssetKeys?.includes(skillNameKey)))throw Error('Previously denied management target remains blocked');
 if(raw.desired&&(typeof raw.desired!=='object'||Array.isArray(raw.desired)||Object.keys(raw.desired).some(key=>!['name','instructions','memory'].includes(key))))throw Error('Unknown desired Project field');
 if(raw.desired?.memory!==undefined&&!['default','project-only'].includes(raw.desired.memory))throw Error('Invalid desired Project memory mode');
 if(raw.desiredFields&&(!Array.isArray(raw.desiredFields)||raw.desiredFields.length>20||raw.desiredFields.some(field=>!field||Object.keys(field).some(key=>!['label','placeholder','value'].includes(key))||typeof field.value!=='string'||field.value.length>8000)))throw Error('Invalid personal Instructions fields');
 if(raw.action==='project-source-read'){
  const source=raw.source;
  if(raw.commit!==undefined&&raw.commit!==false)throw Error('Read-only Source request cannot commit');
  if(typeof raw.expectedName!=='string'||!raw.expectedName||!SHA.test(raw.preimageSHA256||'')
   ||!source||typeof source!=='object'||Array.isArray(source)||Object.keys(source).some(key=>!['filename','maxBytes','includeBody','expectedSha256'].includes(key))
   ||typeof source.filename!=='string'||!source.filename||/[\\/\x00-\x1f]/.test(source.filename)||!/\.md$/i.test(source.filename)
   ||source.includeBody!==true||!Number.isSafeInteger(source.maxBytes)||source.maxBytes<1||source.maxBytes>256*1024
   ||(source.expectedSha256!==undefined&&!SHA.test(source.expectedSha256)))throw Error('Explicit bounded exact Markdown Source read required');
 }else if(raw.source&&(!raw.source||typeof raw.source!=='object'||Array.isArray(raw.source)||Object.keys(raw.source).some(key=>!['filename','sha256','sizeBytes'].includes(key))||!SHA.test(raw.source.sha256||'')||!Number.isSafeInteger(raw.source.sizeBytes)||raw.source.sizeBytes<1))throw Error('Invalid recovery Source metadata');
 if(raw.action.startsWith('personal-skill-')){
  const s=input.skill,keys=new Set(['name','displayName','skillId','expectedCurrentSha','expectedTreeSha','file','fileSHA256','bodyFile','bodyFileSHA256','descriptionFile','descriptionFileSHA256','filePath','includeBody','includeFiles','planRequestId','planSHA256']);
  if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(key=>!keys.has(key)))throw Error('Unknown personal skill field');
  for(const [key,max] of [['file',25*1048576],['bodyFile',100000],['descriptionFile',8000]])if(s[key]!==undefined){s[key]=allowedFile(workspace.root,s[key]);if(!SHA.test(s[key+'SHA256']||'')||fs.statSync(s[key]).size>max||digest(fs.readFileSync(s[key]))!==s[key+'SHA256'])throw Error('Exact personal skill file bytes required');if(!['personal-skill-plan-file','personal-skill-plan-add-file','personal-skill-add-file'].includes(raw.action)&&!s.planRequestId)delete s[key+'SHA256'];}
  if(['personal-skill-plan-add-file','personal-skill-add-file'].includes(raw.action)){
   const apply=raw.action==='personal-skill-add-file';
   if(!/^[a-z0-9][a-z0-9-]{1,63}$/.test(s.name||'')||typeof s.displayName!=='string'||!s.displayName||s.displayName.length>150
    ||!/^[A-Za-z0-9_-]{8,200}$/.test(s.skillId||'')||!/^references\/[a-z0-9][a-z0-9-]{0,62}[.]md$/.test(s.filePath||'')
    ||!s.bodyFile||!SHA.test(s.bodyFileSHA256||'')||s.planRequestId!==undefined||s.planSHA256!==undefined)throw Error('Exact new references Markdown file required');
   if(apply){if(raw.commit!==true||!SHA.test(s.expectedCurrentSha||'')||!SHA.test(s.expectedTreeSha||'')||raw.confirm!=='ADD-FILE:'+s.skillId+':'+s.filePath)throw Error('Fresh skill/tree preimages and exact add-file confirmation required');}
   else if((raw.commit!==undefined&&raw.commit!==false)||raw.confirm!==undefined)throw Error('Read-only add-file plan cannot commit or confirm');
  }
  if(raw.action==='personal-skill-plan-file'&&raw.commit!==undefined&&raw.commit!==false)throw Error('Read-only file plan cannot commit');
  if(s.planRequestId!==undefined||s.planSHA256!==undefined){
   if(raw.action!=='personal-skill-update-body'||!ID.test(s.planRequestId||'')||!SHA.test(s.planSHA256||''))throw Error('Exact original file plan required');
   const files=operationFiles(binding.operationDirectory,s.planRequestId),record=boundedJson(files.record);
   if(record.phase!=='COMPLETED'||record.bindingId!==binding.bindingId||record.workspaceAlias!==workspace.alias
    ||record.action!=='personal-skill-plan-file'||digest(fs.readFileSync(regular(files.result)))!==s.planSHA256)throw Error('HOLD_FILE_PLAN_UNPROVEN');
   const plan=boundedJson(files.result);
   if(plan.kind!=='existing-support-file-plan/v1'||plan.status!=='FILE_PLAN_READY'||plan.account!==binding.account
    ||plan.identityHash!==binding.identityHash||plan.workspaceIdentityHash!==binding.workspaceIdentityHash
    ||plan.skillId!==s.skillId||plan.name!==s.name||plan.displayName!==s.displayName||plan.filePath!==s.filePath
    ||plan.beforeSHA256!==s.expectedCurrentSha||plan.bodyFile!==s.bodyFile||plan.desiredSourceSHA256!==s.bodyFileSHA256
    ||plan.backupReceipt!==allowedFile(workspace.root,raw.backupReceipt))throw Error('HOLD_FILE_PLAN_CHANGED');
   const receipt=boundedJson(plan.backupReceipt);
   if(receipt.bundleSHA256!==plan.backupBundleSHA256)throw Error('HOLD_FILE_PLAN_BACKUP_CHANGED');
   for(const suffix of ['.operation.json','.operation.lock'])if(fs.existsSync(plan.backupReceipt+suffix))throw Error('HOLD_ORIGINAL_OPERATION_RECONCILE: reuse original request_id/status; never apply the plan again');
   input.filePlan=plan;
  }
 }
 if(raw.action.startsWith('title-')){
  const t=input.title,keys=new Set(['explicitUserRequest','filters','conversationId','outputDirectory','expectedTitle','desiredTitle','contentEvidence']);
  if(!t||typeof t!=='object'||Array.isArray(t)||Object.keys(t).some(key=>!keys.has(key))||typeof t.explicitUserRequest!=='string'||!t.explicitUserRequest.trim()||t.explicitUserRequest.length>8000)throw Error('Explicit bounded title-management request required');
  if(t.filters){const k=new Set(['titleContains','createdFrom','createdThrough','updatedFrom','updatedThrough','conversationIds']);if(typeof t.filters!=='object'||Array.isArray(t.filters)||Object.keys(t.filters).some(key=>!k.has(key)))throw Error('Unknown conversation selector');}
  if(t.outputDirectory!==undefined){const d=t.outputDirectory;if(typeof d!=='string'||!path.isAbsolute(d)||!inside(workspace.root,d)||path.relative(workspace.root,d).split(path.sep).some(part=>!part||part.startsWith('.')||/[<>:\"|?*\x00-\x1f]/.test(part)||/[. ]$/.test(part)))throw Error('Conversation output must be a registered non-hidden directory');for(let c=path.resolve(d);;c=path.dirname(c)){if(fs.existsSync(c)&&fs.lstatSync(c).isSymbolicLink())throw Error('Linked conversation output refused');if(c===path.dirname(c))break;}fs.mkdirSync(d,{recursive:true});if(!fs.statSync(d).isDirectory())throw Error('Conversation output directory required');}
  if(t.contentEvidence){const e=t.contentEvidence,k=new Set(['conversationId','method','readScope','sourcePath','sha256']);if(typeof e!=='object'||Array.isArray(e)||Object.keys(e).some(key=>!k.has(key)))throw Error('Unknown content-reading evidence');if(e.method==='local-import'){e.sourcePath=allowedFile(workspace.root,e.sourcePath);if(!SHA.test(e.sha256||'')||digest(fs.readFileSync(e.sourcePath))!==e.sha256)throw Error('Content-reading artifact changed');}}
 }
 const mutating=!READ_ACTIONS.has(raw.action);
 if(mutating||['personal-skill-plan-file','personal-skill-plan-add-file'].includes(raw.action)){if(mutating&&raw.commit!==true)throw Error('The exact management request must declare commit');input.backupReceipt=allowedFile(workspace.root,raw.backupReceipt);
  const receipt=boundedJson(input.backupReceipt);
  for(const field of ['bundlePath',...(receipt.notionFormat==='INLINE_JSON'?['notionRecoveryProofPath','notionPageReadPath']:[])])allowedFile(workspace.root,receipt[field]);}
 if(raw.action==='project-create'&&(raw.memory!=='default'||!/^w-(?![wl]-)\S/.test(raw.name||'')))throw Error('Projects require one w- prefix and default memory');
 if(input.sources){if(!Array.isArray(input.sources)||input.sources.length>50)throw Error('Invalid Source list');for(const source of input.sources){
  if(!source||typeof source.filename!=='string'||!source.filename||/[\\/\x00-\x1f]/.test(source.filename)||Object.keys(source).some(key=>!['path','filename','sha256','sizeBytes'].includes(key))||!SHA.test(source.sha256||'')||!Number.isSafeInteger(source.sizeBytes)||source.sizeBytes<1)throw Error('Exact Source metadata required');
  source.path=allowedFile(workspace.root,source.path);if(fs.statSync(source.path).size!==source.sizeBytes||digest(fs.readFileSync(source.path))!==source.sha256)throw Error('Source bytes differ');
 }}
 // Host identity, account, executable, config and output are never remote input.
 return {...input,config:binding.config,account:binding.account,identityHash:binding.identityHash,workspaceIdentityHash:binding.workspaceIdentityHash,resultFile};
}
export function createWebManagementExecutor(config,options={}){
 const startProcess=options.spawn??spawn;
 const now=options.now??(()=>new Date().toISOString());
 function status(workspace,requestId){
  const binding=readBinding(config,workspace),files=operationFiles(binding.operationDirectory,requestId);
  const record=boundedJson(files.record);if(record.bindingId!==binding.bindingId||record.workspaceAlias!==workspace.alias)throw Error('Management operation is outside this binding');
  const running=sessions.has(files.record);
  const orphaned=record.phase==='DISPATCHING'&&!running;
  const result=record.phase==='COMPLETED'&&fs.existsSync(files.result)?boundedJson(files.result,4*1048576):null;
  let failure=null;if(!running&&record.phase==='OUTCOME_UNKNOWN_RECONCILE'&&fs.existsSync(files.result)){
   const saved=boundedJson(files.result,4*1048576);
   if(typeof saved?.status==='string'){
    failure={status:saved.status.slice(0,80),action:record.action,reason:typeof saved.reason==='string'?saved.reason.slice(0,500).replace(/(?:remote_cap|local_read_cap|local_grant)_[A-Za-z0-9_-]+/g,'[redacted]'):'Manager outcome requires read-only reconciliation'};
    if(typeof saved.remoteMutation==='boolean')failure.remoteMutation=saved.remoteMutation;
    if(/^[A-Za-z0-9_-]{8,200}$/.test(saved.skillId||''))failure.skillId=saved.skillId;
    if(Array.isArray(saved.requests))failure.requests=saved.requests.slice(0,20).filter(r=>r&&['POST','PATCH','PUT','DELETE','GET'].includes(r.method)&&Number.isInteger(r.status)&&r.status>=100&&r.status<=599&&/^\/backend-api\/[A-Za-z0-9_/-]{1,180}$/.test(r.path||'')).map(r=>({method:r.method,status:r.status,path:r.path}));
   }
  }
  let sourceDownload=null;
  const downloadFile=files.result+'.source-download.json';
  const safeDownload=value=>{
   if(!value||typeof value!=='object')return null;
   const safe={automaticRetry:false};
   for(const key of ['phase','failedPhase','cleanup','outcome','eventFailureKind','clickFailureKind'])if(typeof value[key]==='string'&&/^[A-Za-z_]{1,80}$/.test(value[key]))safe[key]=value[key];
   for(const key of ['downloadDispatchAttempted','clickResolved','downloadEventObserved','bytesReadFromRemote','remoteMutationDispatched'])if(typeof value[key]==='boolean')safe[key]=value[key];
   return safe;
  };
  if(fs.existsSync(downloadFile)){
   try{const saved=boundedJson(downloadFile,65536);if(saved.action!==record.action||saved.identityHash!==binding.identityHash||saved.workspaceIdentityHash!==binding.workspaceIdentityHash)throw Error('Diagnostic binding mismatch');sourceDownload=safeDownload(saved.sourceDownload);}
   catch{sourceDownload={phase:'DIAGNOSTICS_UNREADABLE',automaticRetry:false};}
  }else if(failure&&/Source download dispatch or event is unclear/.test(failure.reason)){
   sourceDownload={phase:'LEGACY_DOWNLOAD_OUTCOME_UNRESOLVED',downloadDispatchAttempted:null,downloadEventObserved:null,automaticRetry:false};
  }
  return {ok:!orphaned,request_id:requestId,status:orphaned?'OUTCOME_UNKNOWN_RECONCILE':record.phase,running,result,failure,exit_code:record.exitCode??null,
   ...(sourceDownload?{source_download:sourceDownload,next_action:'READ_ORIGINAL_OPERATION_STATUS_NO_REPLAY'}:{}),
   ...(result?.kind==='existing-support-file-plan/v1'?{plan_sha256:digest(fs.readFileSync(files.result))}:{}),
   ...(record.fileTarget?{file_target:record.fileTarget,next_action:'READ_ORIGINAL_OPERATION_STATUS_NO_REPLAY'}:{}),
   automaticRetry:false};
 }
 function start(workspace,input){
  const binding=readBinding(config,workspace),files=operationFiles(binding.operationDirectory,input.request_id);
  const requestFile=relativeFile(workspace.root,input.request_path),bytes=fs.readFileSync(requestFile);
  if(bytes.length>1048576||!SHA.test(input.request_sha256||'')||digest(bytes)!==input.request_sha256)throw Error('Exact request bytes are required');
  if(binding.blockedRequestHashes.includes(input.request_sha256))throw Error('Previously denied request remains blocked');
  const raw=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
  if(fs.existsSync(files.record)){
   const existing=boundedJson(files.record);
   if(existing.requestSHA256!==input.request_sha256||existing.workspaceAlias!==workspace.alias||existing.bindingId!==binding.bindingId)throw Error('Management request ID was already used for other input');
   return status(workspace,input.request_id);
  }
  // A Source read downloads bytes: unlike metadata inspection its exact request is never replayed under a fresh ID.
  if(raw.action==='project-source-read'&&input.request_id!=='read-'+input.request_sha256.slice(0,40))throw Error('Exact Source read requires its stable original request ID');
  const prepared=prepareWebManagementRequest(raw,binding,workspace,files.result);
  const lockFile=path.join(binding.operationDirectory,'writer.lock');let lock=null;
  // Reconciliation needs live reads while an uncertain write remains blocked.
  // Read-only actions never acquire, replace or release another request's writer lock.
  if(!READ_ACTIONS.has(raw.action))try{lock=fs.openSync(lockFile,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw Error('Management writer is busy or requires prior-outcome reconciliation');throw error;}
  const record={schemaVersion:1,bindingId:binding.bindingId,workspaceAlias:workspace.alias,request_id:input.request_id,requestSHA256:input.request_sha256,action:raw.action,phase:'PREPARED',createdAt:now(),automaticRetry:false};
  if(prepared.filePlan)record.fileTarget={skillId:prepared.filePlan.skillId,filePath:prepared.filePlan.filePath,
   beforeSHA256:prepared.filePlan.beforeSHA256,desiredSHA256:prepared.filePlan.desiredSHA256,
   planRequestId:raw.skill.planRequestId,planSHA256:raw.skill.planSHA256};
  let child;
  const unlock=(preserve=false)=>{if(lock===null)return;try{fs.closeSync(lock);}finally{if(!preserve)fs.unlinkSync(lockFile);}};
  try{
   if(lock!==null)fs.writeFileSync(lock,json({request_id:input.request_id,requestSHA256:input.request_sha256}));
   writeNew(files.request,prepared);writeNew(files.record,record);
   // Durable intent comes before the only process creation. No shell or arbitrary command.
   record.phase='DISPATCHING';writeRecord(files.record,record);
   child=startProcess(binding.node,[binding.entry,files.request],{cwd:workspace.root,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_OPTIONS:'',NODE_PATH:'',NO_COLOR:'1'}});
  }catch(error){
   if(fs.existsSync(files.record)){record.phase='OUTCOME_UNKNOWN_RECONCILE';record.error='MANAGEMENT_START_FAILED';writeRecord(files.record,record);}unlock(fs.existsSync(files.record));throw error;
  }
  sessions.set(files.record,child);let outputBytes=0,finished=false,limitHit=false;
  const maximumOutputBytes=Math.min(binding.maximumOutputBytes??1048576,4*1048576);
  const timeoutMs=Math.min(binding.timeoutMs??180000,300000);
  const consume=chunk=>{outputBytes+=chunk.length;if(outputBytes>maximumOutputBytes&&!limitHit){limitHit=true;record.phase='OUTCOME_UNKNOWN_RECONCILE';record.error='MANAGEMENT_OUTPUT_LIMIT';writeRecord(files.record,record);}};
  child.stdout?.on('data',consume);child.stderr?.on('data',consume);
  const timer=setTimeout(()=>{limitHit=true;record.phase='OUTCOME_UNKNOWN_RECONCILE';record.error='MANAGEMENT_OBSERVATION_TIMEOUT';writeRecord(files.record,record);},timeoutMs);timer.unref?.();
  const finish=(exitCode,error)=>{
   if(finished)return;finished=true;clearTimeout(timer);sessions.delete(files.record);
   record.finishedAt=now();record.exitCode=exitCode;
   record.phase=error||limitHit||exitCode!==0||!fs.existsSync(files.result)?'OUTCOME_UNKNOWN_RECONCILE':'COMPLETED';
   if(record.phase==='COMPLETED'){
    try{const result=boundedJson(files.result,4*1048576);if(!result||typeof result!=='object'||!result.status||/UNKNOWN|HOLD|FAIL|ERROR|BLOCKED/i.test(result.status))record.phase='OUTCOME_UNKNOWN_RECONCILE';}
    catch{record.phase='OUTCOME_UNKNOWN_RECONCILE';}
   }
   if(error)record.error='MANAGEMENT_PROCESS_ERROR';
   try{writeRecord(files.record,record);}finally{unlock(record.phase!=='COMPLETED');}
  };
  child.once('error',error=>finish(null,error));child.once('close',code=>finish(code,null));
  return {ok:true,status:'DISPATCHING',request_id:input.request_id,action:raw.action,automaticRetry:false};
 }
 return {start,status};
}
