import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {assertWindowsOwnerOnlyPath} from '../../src/lib/windows-owner-only-acl.mjs';

// Business-full-only adapter to the ALREADY INSTALLED WebGPT Queue native host.
// No shell, daemon, second queue, browser send or target-lease mutation.
const SHA=/^[a-f0-9]{64}$/;
const OP=/^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;
const CONVERSATION=/^[A-Za-z0-9][A-Za-z0-9_-]{7,126}$/;
const TARGET=/^[a-f0-9]{64}$/;
const SLOT=['9222','9223'];
const MAX_FRAME=2*1024*1024;
const hash=value=>createHash('sha256').update(value).digest('hex');
const inside=(root,candidate)=>{const d=path.relative(root,candidate);return d===''||(!d.startsWith('..'+path.sep)&&d!=='..'&&!path.isAbsolute(d));};
// Fixed, non-sensitive diagnostics only: never expose helper stdout, stderr,
// command arguments, target IDs, lease tokens or an arbitrary upstream message.
const ISSUER_HOLD_CODES=Object.freeze({
  HOLD_REGISTERED_IDENTITY:'QUEUE_CURRENT_ISSUER_IDENTITY_HOLD',
  HOLD_TARGET_ORIGIN:'QUEUE_CURRENT_ISSUER_IDENTITY_HOLD',
  HOLD_TARGET_IDENTITY_UNPROVEN:'QUEUE_CURRENT_ISSUER_IDENTITY_HOLD',
  HOLD_TARGET_CLOSED_OR_UNPROVEN:'QUEUE_CURRENT_ISSUER_TARGET_CLOSED_OR_UNPROVEN',
  HOLD_QUEUE_TARGET_CHANGED:'QUEUE_CURRENT_ISSUER_TARGET_CLOSED_OR_UNPROVEN',
  HOLD_QUEUE_LEASE_EXPIRED:'QUEUE_CURRENT_ISSUER_LEASE_EXPIRED',
  HOLD_QUEUE_ORIGINAL_ACTIVE_LEASE_UNPROVEN:'QUEUE_CURRENT_ISSUER_LEASE_UNPROVEN',
  HOLD_QUEUE_ORIGINAL_ACTIVE_LEASE_CHANGED:'QUEUE_CURRENT_ISSUER_LEASE_CHANGED',
  HOLD_QUEUE_RETAINED_RELEASE_UNPROVEN:'QUEUE_CURRENT_ISSUER_LEASE_UNPROVEN',
  HOLD_QUEUE_RETAINED_CHAIN_UNPROVEN:'QUEUE_CURRENT_ISSUER_LEASE_UNPROVEN',
  HOLD_QUEUE_RETAINED_LEASE_CONFLICT:'QUEUE_CURRENT_ISSUER_LEASE_UNPROVEN',
  HOLD_QUEUE_RETAINED_REQUEST_UNPROVEN:'QUEUE_CURRENT_ISSUER_LEASE_UNPROVEN',
  HOLD_QUEUE_RETAINED_ROLE_UNPROVEN:'QUEUE_CURRENT_ISSUER_LEASE_UNPROVEN',
  HOLD_QUEUE_RETENTION_PRIVATE_REQUEST_REQUIRED:'QUEUE_CURRENT_ISSUER_ARGUMENTS_HOLD',
  HOLD_QUEUE_RETENTION_PRIVATE_REQUEST_BOUNDARY:'QUEUE_CURRENT_ISSUER_ARGUMENTS_HOLD',
  HOLD_QUEUE_RETENTION_REQUEST_SHA_CHANGED:'QUEUE_CURRENT_ISSUER_LEASE_UNPROVEN',
  HOLD_QUEUE_RETENTION_ORIGINAL_LEASE_MISMATCH:'QUEUE_CURRENT_ISSUER_LEASE_UNPROVEN',
  HOLD_QUEUE_RETAINED_IDENTITY_CHANGED:'QUEUE_CURRENT_ISSUER_IDENTITY_HOLD',
  HOLD_QUEUE_SAVED_CONVERSATION_UNPROVEN:'QUEUE_CURRENT_ISSUER_IDENTITY_HOLD',
  HOLD_QUEUE_LIVE_NONCE_UNPROVEN:'QUEUE_CURRENT_ISSUER_IDENTITY_HOLD',
  HOLD_QUEUE_OWNER_INSPECT_ARGUMENTS:'QUEUE_CURRENT_ISSUER_ARGUMENTS_HOLD',
  HOLD_QUEUE_OWNER_INSPECT_UNPROVEN:'QUEUE_CURRENT_ISSUER_INSPECT_UNPROVEN'
});
const ISSUER_FIXED_ERRORS=new Set([
  ...Object.values(ISSUER_HOLD_CODES),
  'QUEUE_CURRENT_ISSUER_INSPECT_UNPROVEN',
  'QUEUE_CURRENT_ISSUER_INSPECT_NONZERO',
  'QUEUE_CURRENT_ISSUER_INSPECT_MALFORMED',
  'QUEUE_CURRENT_ISSUER_INSPECT_TIMEOUT',
  'QUEUE_CURRENT_ISSUER_INSPECT_LAUNCH_FAILED',
  'QUEUE_CURRENT_ISSUER_INSPECT_OVERFLOW'
]);
function currentIssuerHoldCategory(payload){
  if(!record(payload)||payload.ok!==false||payload.status!=='HOLD')return null;
  return Object.hasOwn(ISSUER_HOLD_CODES,payload.holdCode)
    ?ISSUER_HOLD_CODES[payload.holdCode]:'QUEUE_CURRENT_ISSUER_INSPECT_UNPROVEN';
}
function currentIssuerInspectSpawn(powershell,args,spawnProcess=spawnSync){
  const reply=spawnProcess(powershell,args,{
    // Match owner preparation: the pinned identity helper can await a slow
    // CDP response for 90 seconds. Proof freshness is checked after both reads.
    encoding:'utf8',timeout:130000,windowsHide:true,shell:false,maxBuffer:65536
  });
  const failureCode=reply?.error?.code;
  if(failureCode==='ETIMEDOUT')hold('QUEUE_CURRENT_ISSUER_INSPECT_TIMEOUT');
  if(failureCode==='ENOENT'||failureCode==='EACCES'||failureCode==='EPERM')
    hold('QUEUE_CURRENT_ISSUER_INSPECT_LAUNCH_FAILED');
  if(failureCode==='ENOBUFS')hold('QUEUE_CURRENT_ISSUER_INSPECT_OVERFLOW');
  if(reply?.error)hold('QUEUE_CURRENT_ISSUER_INSPECT_UNPROVEN');
  // The pinned QueueOwnerInspect helper reports safe HOLD_* in JSON on
  // stdout with process exit code 4. Decode only its fixed enum.
  if(reply?.status===4){
    let parsed;try{parsed=JSON.parse(String(reply.stdout??''));}
    catch{hold('QUEUE_CURRENT_ISSUER_INSPECT_MALFORMED');}
    hold(currentIssuerHoldCategory(parsed)??'QUEUE_CURRENT_ISSUER_INSPECT_NONZERO');
  }
  if(reply?.status!==0)hold('QUEUE_CURRENT_ISSUER_INSPECT_NONZERO');
  let parsed;try{parsed=JSON.parse(String(reply.stdout??''));}
  catch{hold('QUEUE_CURRENT_ISSUER_INSPECT_MALFORMED');}
  if(!record(parsed))hold('QUEUE_CURRENT_ISSUER_INSPECT_MALFORMED');
  return parsed;
}

function hold(code){const e=new Error(code);e.code=code;throw e;}
function pinned(file,expected,limit=65536){
  if(typeof file!=='string'||!path.isAbsolute(file)||!SHA.test(expected||''))hold('QUEUE_PIN_REQUIRED');
  for(let c=path.resolve(file);;c=path.dirname(c)){
    let stat;try{stat=fs.lstatSync(c);}catch{hold('QUEUE_PIN_UNAVAILABLE');}
    if(stat.isSymbolicLink())hold('QUEUE_LINK_REFUSED');
    if(c===path.dirname(c))break;
  }
  const stat=fs.statSync(file);
  if(!stat.isFile()||stat.size>limit)hold('QUEUE_PIN_INVALID');
  if(hash(fs.readFileSync(file))!==expected)hold('QUEUE_PIN_CHANGED');
  return fs.realpathSync(file);
}
function record(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function exactKeys(value,keys){return record(value)&&Object.keys(value).every(k=>keys.includes(k));}
function safeRole(role){
  return {id:role.id,status:role.status,slot:role.slot,
    dispatchCount:Number.isSafeInteger(role.dispatchCount)?role.dispatchCount:0,
    conversationRecorded:typeof role.conversationId==='string'&&!role.conversationId.startsWith('WEB:'),
    userMessageRecorded:typeof role.userMessageId==='string',
    assistantMessageRecorded:typeof role.assistantMessageId==='string',
    submissionUncertain:role.submissionUncertain===true,
    errorCode:/^[A-Z0-9_:-]{1,100}$/.test(role.errorCode||'')?role.errorCode:null,
    // Original structured result is an owner-scoped, bounded handoff, never raw response.
    structuredResult:role.status==='completed'&&role.dispatchCount===1&&
      typeof role.assistantMessageId==='string'&&record(role.result)?
      {summary:String(role.result.summary??'').slice(0,4000),
       evidence:Array.isArray(role.result.evidence)?role.result.evidence.slice(0,8).map(s=>String(s).slice(0,800)):[],
       next:String(role.result.next??'').slice(0,2000)}:null};
}
function view(run,revision,operationId){
  if(!record(run)||!Array.isArray(run.roles)||run.registrationOnly!==true)hold('QUEUE_ORIGINAL_RUN_UNPROVEN');
  return {ok:true,operationId,revision,
    status:run.status,paused:run.paused===true,registrationOnly:true,
    dispatchState:run.roles.some(r=>r.dispatchCount>0||r.userMessageId)?'DISPATCH_RECORDED':'NOT_DISPATCHED',
    roles:run.roles.slice(0,12).map(safeRole),
    executionAuthorized:run.executionAuthorized===true,
    nextAssignment:run.executionAuthorized===true?'EXISTING_EXTENSION_EXECUTOR':'HOLD_EXACT_OWNER_TARGET_AND_ACTIVATION_REQUIRED',
    targetLeaseReturn:'ORIGINAL_TARGET_OWNER_REQUIRED'};
}
function registeredManifestPathMatches(file){
  if(process.platform!=='win32')return false;
  const key='HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.agenticfabworks.webgpt_queue';
  const result=spawnSync('reg.exe',['query',key,'/ve'],{encoding:'utf8',windowsHide:true,timeout:6000,
    shell:false,maxBuffer:16384});
  if(result.error||result.status!==0)return false;
  const line=String(result.stdout).split(/\r?\n/).find(text=>/\bREG_SZ\b/.test(text));
  const pathValue=line?.match(/\bREG_SZ\s+(.+?)\s*$/)?.[1];
  return typeof pathValue==='string'&&path.resolve(pathValue).toLowerCase()===path.resolve(file).toLowerCase();
}
function bindingFor(config,workspace,{fresh=false,now=Date.now(),verifyRegistry=registeredManifestPathMatches}={}){
  try {
  const d=config.gptQueue;
  if(config.surfaceProfile==='personal-read-fetch'||d?.enabled!==true)hold('QUEUE_BUSINESS_FULL_ONLY');
  const bindingFile=pinned(d.bindingFile,d.bindingSha256);
  if(inside(fs.realpathSync(workspace.root),bindingFile))hold('QUEUE_OWNER_BINDING_IN_WORKSPACE');
  const b=JSON.parse(fs.readFileSync(bindingFile,'utf8'));
  if(record(b)&&b.targetLifecycle!==undefined&&
     b.targetLifecycle!=='queue-owner-keep-target-before-registration/v1')
    hold('QUEUE_TARGET_LIFECYCLE_CONTRACT_INVALID');
  if(!record(b)||b.schemaVersion!==1||b.kind!=='aicc-gpt-queue-owner-binding'||
    b.workspaceAlias!==workspace.alias||fs.realpathSync(b.workspaceRoot)!==fs.realpathSync(workspace.root)||
    !OP.test(b.bindingId||'')||!OP.test(b.operationId||'')||!OP.test(b.ownerId||'')||
    !SHA.test(b.originalRequestSha256||'')||!SHA.test(b.ownerIdentityHash||'')||
    !SHA.test(b.definitionSha256||'')||!Array.isArray(b.targets)||b.targets.length!==2)hold('QUEUE_OWNER_BINDING_INVALID');
  const exe=pinned(b.nativeExecutable,b.nativeExecutableSha256,32*1024*1024);
  const cfg=pinned(b.nativeConfig,b.nativeConfigSha256);
  const manifestPath=pinned(b.nativeManifest,b.nativeManifestSha256);
  if(path.dirname(exe)!==path.dirname(cfg)||path.dirname(exe)!==path.dirname(manifestPath)||
    path.basename(cfg)!=='native-host.config.json'||
    path.basename(manifestPath)!=='com.agenticfabworks.webgpt_queue.json'||
    inside(workspace.root,exe)||inside(workspace.root,cfg)||inside(workspace.root,manifestPath))
    hold('QUEUE_NATIVE_PIN_BOUNDARY');
  const nativeManifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  if(nativeManifest.name!=='com.agenticfabworks.webgpt_queue'||nativeManifest.type!=='stdio'||
    path.resolve(nativeManifest.path||'')!==exe||
    !Array.isArray(nativeManifest.allowed_origins)||nativeManifest.allowed_origins.length!==1||
    !/^chrome-extension:\/\/[a-p]{32}\/$/.test(nativeManifest.allowed_origins[0])||
    verifyRegistry(manifestPath)!==true)hold('QUEUE_NATIVE_INSTALLED_REGISTRATION_UNPROVEN');
  const installed=JSON.parse(fs.readFileSync(cfg,'utf8'));
  if(typeof installed.baseDirectory!=='string'||!path.isAbsolute(installed.baseDirectory)||
    !fs.existsSync(installed.baseDirectory)||
    fs.realpathSync(installed.baseDirectory)!==fs.realpathSync(b.baseDirectory)||
    inside(workspace.root,b.baseDirectory))hold('QUEUE_NATIVE_LEDGER_BINDING_INVALID');
  for(let i=0;i<2;i++){
    const t=b.targets[i];
    if(!record(t)||t.slot!==SLOT[i]||!OP.test(t.roleId||'')||
      !TARGET.test(t.targetNonce||'')||!CONVERSATION.test(t.conversationId||'')||
      !/^[A-Fa-f0-9]{32}$/.test(t.targetId||'')||!SHA.test(t.accountIdentityHash||'')||
      !SHA.test(t.workspaceIdentityHash||'')||!SHA.test(t.originalLeaseSha256||'')||
      typeof t.accountAlias!=='string'||!t.accountAlias||
      typeof t.browserWorkspace!=='string'||!t.browserWorkspace)hold('QUEUE_TARGET_BINDING_INVALID');
    const file=pinned(t.proofFile,t.proofSha256);
    if(!inside(path.dirname(bindingFile),file)||inside(workspace.root,file))hold('QUEUE_TARGET_PROOF_BOUNDARY');
    const proof=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!record(proof)||proof.schemaVersion!==1||proof.kind!=='aicc-queue-exact-target-proof'||
      proof.bindingId!==b.bindingId||proof.ownerId!==b.ownerId||
      proof.originalRequestSha256!==b.originalRequestSha256||
      proof.ownerIdentityHash!==b.ownerIdentityHash||
      proof.roleId!==t.roleId||proof.slot!==t.slot||proof.targetNonce!==t.targetNonce||
      proof.conversationId!==t.conversationId||proof.targetId!==t.targetId||
      proof.accountAlias!==t.accountAlias||proof.browserWorkspace!==t.browserWorkspace||
      proof.accountIdentityHash!==t.accountIdentityHash||
      proof.workspaceIdentityHash!==t.workspaceIdentityHash||
      proof.originalLeaseSha256!==t.originalLeaseSha256||
      !SHA.test(proof.registrationSha256||'')||
      !['OWNED_ACTIVE','OWNER_KEEP_TARGET_RETAINED'].includes(proof.state)||
      (proof.state==='OWNER_KEEP_TARGET_RETAINED'&&
       (!exactKeys(proof.retentionProof,['kind','creationSha256','releaseSha256'])||
        proof.retentionProof.kind!=='aicc-queue-keep-target-release-history/v1'||
        !SHA.test(proof.retentionProof.creationSha256||'')||
        !SHA.test(proof.retentionProof.releaseSha256||'')))||
      (proof.state==='OWNED_ACTIVE'&&proof.retentionProof!==undefined))
      hold('QUEUE_TARGET_PROOF_MISMATCH');
    if(b.currentIssuer){
      const observed=Date.parse(proof.observedAt),expires=Date.parse(proof.expiresAt);
      if(!Number.isFinite(observed)||!Number.isFinite(expires)||observed>now||
        expires<=observed||expires-observed>180000)hold('QUEUE_TARGET_PROOF_STALE');
    }
    if(fresh&&!b.currentIssuer){
      const observed=Date.parse(proof.observedAt),expires=Date.parse(proof.expiresAt);
      if(!Number.isFinite(observed)||!Number.isFinite(expires)||observed>now||
        now-observed>120000||expires<=now||expires-observed>180000)hold('QUEUE_TARGET_PROOF_STALE');
    }
  }
  return {...b,executable:exe,baseDirectory:installed.baseDirectory,
    runId:'gptq_'+hash(b.bindingId+'\0'+b.ownerIdentityHash).slice(0,24)+'_'+b.operationId};
  } catch(error){
    if(typeof error?.code==='string'&&error.code.startsWith('QUEUE_'))throw error;
    hold('QUEUE_OWNER_BINDING_UNAVAILABLE');
  }
}
export async function verifyGptQueueCurrentIssuer(binding,workspace,options={}){
  const c=binding.currentIssuer;
  if(!record(c)||c.kind!=='registered-cdp-current-issuer/v1'||
    !exactKeys(c,['kind','requestFile','requestSha256','helperFile','helperSha256',
      'identityGuardFile','identityGuardSha256','powershellFile','powershellSha256'])||
    c.requestSha256!==binding.originalRequestSha256)hold('QUEUE_CURRENT_ISSUER_CONTRACT_INVALID');
  const requestFile=pinned(c.requestFile,c.requestSha256);
  if(inside(workspace.root,requestFile))hold('QUEUE_CURRENT_ISSUER_REQUEST_BOUNDARY');
  try{(options.assertPrivateFile??assertWindowsOwnerOnlyPath)(requestFile,{directory:false});}
  catch{hold('QUEUE_CURRENT_ISSUER_PRIVATE_FILE_REQUIRED');}
  const helper=pinned(c.helperFile,c.helperSha256,1024*1024);
  const guard=pinned(c.identityGuardFile,c.identityGuardSha256,1024*1024);
  const powershell=pinned(c.powershellFile,c.powershellSha256,128*1024*1024);
  if(path.basename(helper)!=='Manage-CdpChromeSlotLease.ps1'||
    path.basename(guard)!=='Assert-CdpEndpointIdentity.ps1'||
    path.dirname(helper)!==path.dirname(guard)||inside(workspace.root,helper)||
    inside(workspace.root,powershell))hold('QUEUE_CURRENT_ISSUER_EXECUTABLE_BOUNDARY');
  const request=JSON.parse(fs.readFileSync(requestFile,'utf8'));
  if(request.kind!=='aicc-gpt-queue-original-owner-request'||request.schemaVersion!==1||
    request.bindingId!==binding.bindingId||request.operationId!==binding.operationId||
    request.ownerId!==binding.ownerId||request.ownerIdentityHash!==binding.ownerIdentityHash||
    request.workspaceAlias!==binding.workspaceAlias||path.resolve(request.workspaceRoot||'')!==path.resolve(binding.workspaceRoot)||
    !Array.isArray(request.roles)||request.roles.length!==2)hold('QUEUE_CURRENT_ISSUER_REQUEST_MISMATCH');
  const roles=request.roles.map(({id,slot,targetNonce,conversationId,prompt})=>({id,slot,targetNonce,conversationId,prompt}));
  if(hash(JSON.stringify({title:request.title,roles}))!==binding.definitionSha256)
    hold('QUEUE_CURRENT_ISSUER_DEFINITION_MISMATCH');
  const observed=[];
  const clock=options.now??Date.now;
  for(let i=0;i<2;i++){
    const role=request.roles[i],target=binding.targets[i];
    if(!/^[a-f0-9]{32}$/.test(role.leaseToken||'')||hash(role.leaseToken)!==target.originalLeaseSha256||
      ['slot','targetId','targetNonce','conversationId','accountAlias','browserWorkspace'].some(k=>role[k]!==target[k])||
      role.id!==target.roleId)hold('QUEUE_CURRENT_ISSUER_ROLE_MISMATCH');
    let result;
    try{
      result=await (options.inspectTarget??((r)=>{
        const args=['-NoLogo','-NoProfile','-NonInteractive','-File',helper,'-Action','QueueOwnerInspect',
          '-OwnerId',binding.ownerId,'-LeaseToken',r.leaseToken,'-TargetId',r.targetId,
          '-SlotPorts',r.slot,'-AccountAlias',r.accountAlias,'-Workspace',r.browserWorkspace,
          '-ConversationId',r.conversationId,'-OriginalRequestSha256',binding.originalRequestSha256,
          '-QueueOwnerRequestFile',requestFile,'-AsJson'];
        return currentIssuerInspectSpawn(powershell,args,options.spawnIssuerProcess??spawnSync);
      }))(role);
    }catch(error){
      if(ISSUER_FIXED_ERRORS.has(error?.code))throw error;
      hold('QUEUE_CURRENT_ISSUER_INSPECT_UNPROVEN');
    }
    const helperHold=currentIssuerHoldCategory(result);
    if(helperHold)hold(helperHold);
    const retained=result?.ok===true&&result.status==='verified_retained_owner_target';
    const active=result?.ok===true&&result.status==='verified_active_owner_target';
    const p=active||retained?result.proof:null;
    const retention=p?.retentionProof;
    if(retained&&(!exactKeys(retention,['kind','creationSha256','releaseSha256'])||
      retention.kind!=='aicc-queue-keep-target-release-history/v1'||
      !SHA.test(retention.creationSha256||'')||!SHA.test(retention.releaseSha256||'')))
      hold('QUEUE_CURRENT_ISSUER_RETAINED_HISTORY_UNPROVEN');
    if(!record(p)||p.kind!=='aicc-cdp-queue-live-target-inspection'||p.schemaVersion!==1||
      p.state!==(retained?'OWNER_KEEP_TARGET_RETAINED':'OWNED_ACTIVE')||
      (active&&retention!==undefined)||p.ownerId!==binding.ownerId||p.originalRequestSha256!==binding.originalRequestSha256||
      p.workspaceAlias!==target.browserWorkspace||
      ['slot','targetId','targetNonce','conversationId','accountAlias','originalLeaseSha256',
        'accountIdentityHash','workspaceIdentityHash'].some(k=>p[k]!==target[k])||
      !SHA.test(p.registrationSha256||''))hold('QUEUE_CURRENT_ISSUER_TARGET_MISMATCH');
    const sealed=JSON.parse(fs.readFileSync(target.proofFile,'utf8'));
    if(sealed.state==='OWNER_KEEP_TARGET_RETAINED'&&
      (!retained||!record(sealed.retentionProof)||
       sealed.retentionProof.creationSha256!==retention.creationSha256||
       sealed.retentionProof.releaseSha256!==retention.releaseSha256)){
      hold('QUEUE_CURRENT_ISSUER_RETAINED_HISTORY_UNPROVEN');
    }
    observed.push(p);
  }
  // Both reads must still be current when consumed; a slow second read cannot
  // turn the first observation into an authorization with an extended lifetime.
  const now=clock();
  for(const p of observed){const at=Date.parse(p.observedAt),expires=Date.parse(p.expiresAt);
    if(!Number.isFinite(at)||!Number.isFinite(expires)||at>now||now-at>120000||
      expires<=now||expires<=at||expires-at>120000)hold('QUEUE_CURRENT_ISSUER_STALE');}
  return {ok:true,status:'CURRENT_ORIGINAL_ISSUER_VERIFIED_READ_ONLY',
    originalRequestSha256:binding.originalRequestSha256,ownerIdentityHash:binding.ownerIdentityHash,
    definitionSha256:binding.definitionSha256,targetCount:2,
    observations:observed.map(p=>({slot:p.slot,observedAt:p.observedAt,expiresAt:p.expiresAt})),
    retainedTargets:observed.filter(p=>p.state==='OWNER_KEEP_TARGET_RETAINED').length,
    filesWritten:0,executionAuthorized:false,dispatched:false};
}
export async function verifyGptQueueOwnerConfig(config,workspace,options={}){
  const binding=bindingFor(config,workspace,{fresh:true,now:(options.now??Date.now)(),
    verifyRegistry:options.verifyRegistry??registeredManifestPathMatches});
  if(!binding.currentIssuer)hold('QUEUE_CURRENT_ISSUER_CONTRACT_REQUIRED');
  return verifyGptQueueCurrentIssuer(binding,workspace,options);
}
export function nativeGptQueueExchange(binding,body,{spawnProcess=spawn,timeoutMs=10000}={}){
  return new Promise((resolve,reject)=>{
    const requestId=randomUUID(),request=Buffer.from(JSON.stringify({...body,requestId}));
    if(request.length>MAX_FRAME)return reject(Error('QUEUE_FRAME_TOO_LARGE'));
    const header=Buffer.alloc(4);header.writeUInt32LE(request.length);
    const env={SystemRoot:process.env.SystemRoot??'',WINDIR:process.env.WINDIR??'',
      TEMP:process.env.TEMP??'',TMP:process.env.TMP??'',
      WEBGPT_QUEUE_ARCHIVE_BASE:binding.baseDirectory};
    const child=spawnProcess(binding.executable,[],{cwd:path.dirname(binding.executable),
      shell:false,windowsHide:true,stdio:['pipe','pipe','ignore'],env});
    let bytes=Buffer.alloc(0),result=null,failed=null;
    const timer=setTimeout(()=>{failed=Error('QUEUE_NATIVE_TIMEOUT_UNCERTAIN');child.kill();},timeoutMs);
    child.on('error',e=>{failed=e;});
    child.stdout.on('data',chunk=>{
      bytes=Buffer.concat([bytes,chunk]);
      if(bytes.length>MAX_FRAME+4){failed=Error('QUEUE_NATIVE_FRAME_OVERSIZE');child.kill();return;}
      if(bytes.length>=4){
        const length=bytes.readUInt32LE(0);
        if(length===0||length>MAX_FRAME){failed=Error('QUEUE_NATIVE_FRAME_INVALID');child.kill();return;}
        if(bytes.length===length+4)try{result=JSON.parse(bytes.subarray(4).toString('utf8'));}catch{failed=Error('QUEUE_NATIVE_JSON_INVALID');}
      }
    });
    child.on('close',code=>{
      clearTimeout(timer);
      if(failed||code!==0||!result||result.requestId!==requestId||
        typeof result.ok!=='boolean'||(result.ok&&!record(result.payload)))reject(failed??Error('QUEUE_NATIVE_OUTCOME_UNKNOWN'));
      else resolve(result);
    });
    child.stdin.on('error',()=>{}); // a failed write is reconciled by original get, never resent
    child.stdin.end(Buffer.concat([header,request]));
  });
}
export function createGptQueueExecutor(config,options={}){
  const exchange=options.exchange??((binding,body)=>nativeGptQueueExchange(binding,body,options));
  const now=options.now??Date.now;
  const bind=(workspace,fresh)=>bindingFor(config,workspace,{fresh,now:now(),
    verifyRegistry:options.verifyRegistry??registeredManifestPathMatches});
  const assertCurrent=async(workspace,b,{registration=false}={})=>{
    if(b.currentIssuer){
      const proof=await verifyGptQueueCurrentIssuer(b,workspace,{...options,now});
      if(registration&&b.targetLifecycle==='queue-owner-keep-target-before-registration/v1'&&
        proof.retainedTargets!==2)hold('QUEUE_CURRENT_ISSUER_KEEP_TARGET_REQUIRED');
      return proof;
    }
    bind(workspace,true);
    if(registration&&b.targetLifecycle)hold('QUEUE_CURRENT_ISSUER_CONTRACT_REQUIRED');
    return null;
  };
  async function ask(b,type,fields={}){
    let response;
    try{response=await exchange(b,{type,...fields});}
    catch{hold('QUEUE_NATIVE_OUTCOME_UNKNOWN');}
    if(!record(response)||typeof response.ok!=='boolean')hold('QUEUE_NATIVE_OUTCOME_UNKNOWN');
    if(!response.ok){
      if(response.error==='WEBGPT_ORCHESTRATION_RUN_NOT_FOUND')return null;
      if(response.error==='WEBGPT_ORCHESTRATION_REVISION_STALE')hold('QUEUE_STALE_REVISION');
      hold('QUEUE_NATIVE_'+String(response.error??'UNKNOWN').replace(/[^A-Z0-9_]/g,'').slice(0,90));
    }
    if(!record(response.payload))hold('QUEUE_NATIVE_INVALID_RESULT');
    return response.payload;
  }
  async function getRaw(b){
    const data=await ask(b,'orchestration_get',{runId:b.runId});
    if(data===null)return null;
    if(data.run?.id!==b.runId||data.run?.registrationOnly!==true||!Number.isSafeInteger(data.revision))
      hold('QUEUE_ORIGINAL_RUN_UNPROVEN');
    if(data.run.roles?.length!==2||data.run.roles.some((role,i)=>
      role.id!==b.targets[i].roleId||role.slot!==b.targets[i].slot||
      role.targetNonce!==b.targets[i].targetNonce||
      role.conversationId!==b.targets[i].conversationId))
      hold('QUEUE_ORIGINAL_TARGET_BINDING_DRIFT');
    return data;
  }
  function requestIdentity(b,operationId){
    if(operationId!==b.operationId)hold('QUEUE_ORIGINAL_REQUEST_ID_MISMATCH');
  }
  return {
    async registerPaused(workspace,input){
      const b=bind(workspace,true);requestIdentity(b,input.request_id);
      await assertCurrent(workspace,b,{registration:true});
      if(typeof input.title!=='string'||input.title.length<1||input.title.length>140||
        !Array.isArray(input.roles)||input.roles.length!==2)hold('QUEUE_DEFINITION_INVALID');
      const roles=input.roles.map((role,i)=>{
        const t=b.targets[i];
        if(!exactKeys(role,['id','slot','targetNonce','conversationId','prompt'])||
          role.id!==t.roleId||role.slot!==t.slot||role.targetNonce!==t.targetNonce||
          role.conversationId!==t.conversationId||typeof role.prompt!=='string'||
          !role.prompt.trim()||role.prompt.length>4000)hold('QUEUE_EXACT_TARGET_OR_PROMPT_MISMATCH');
        return {id:role.id,slot:role.slot,targetNonce:role.targetNonce,
          conversationId:role.conversationId,prompt:role.prompt};
      });
      if(hash(JSON.stringify({title:input.title,roles}))!==b.definitionSha256)hold('QUEUE_DEFINITION_SHA_MISMATCH');
      // A legacy native host ignores startPaused and would make the role READY.
      // Require explicit installed capability before any registration mutation.
      const capability=await ask(b,'orchestration_capabilities');
      if(capability?.schemaVersion!==1||capability.pausedRegistration!==true||
        capability.revisionFencedCancel!==true)hold('QUEUE_PAUSED_REGISTRATION_UNSUPPORTED');
      if(capability.ownerBoundActivation!==true)hold('QUEUE_OWNER_ACTIVATION_UNSUPPORTED');
      const existing=await getRaw(b);
      function same(run){return run?.title===input.title&&run?.registrationOnly===true&&run.roles?.length===2&&
        roles.every((role,i)=>Object.entries(role).every(([key,value])=>run.roles[i]?.[key]===value));}
      const sameOwner=run=>record(run?.ownerBinding)&&
        ['originalRequestSha256','ownerIdentityHash','definitionSha256'].every(key=>run.ownerBinding[key]===b[key]);
      if(existing){if(!same(existing.run)||!sameOwner(existing.run))hold('HOLD_ORIGINAL_REQUEST_COLLISION');return {...view(existing.run,existing.revision,b.operationId),registration:'EXISTING_NOT_RESENT'};}
      const ownerBinding={originalRequestSha256:b.originalRequestSha256,ownerIdentityHash:b.ownerIdentityHash,definitionSha256:b.definitionSha256};
      await assertCurrent(workspace,b,{registration:true});
      const created=await ask(b,'orchestration_create',{definition:{id:b.runId,title:input.title,startPaused:true,roles,ownerBinding}});
      if(created===null)hold('QUEUE_CREATE_OUTCOME_UNKNOWN');
      const proof=await getRaw(b);
      if(!proof||!same(proof.run)||!sameOwner(proof.run)||proof.run.status!=='paused'||proof.run.paused!==true||
        proof.run.roles.some(r=>r.dispatchCount>0||r.userMessageId||r.claimToken))
        hold('QUEUE_REGISTRATION_READBACK_UNPROVEN');
      return {...view(proof.run,proof.revision,b.operationId),registration:'REGISTERED_PAUSED',messageSubmitted:false};
    },
    async activate(workspace,input){
      const b=bind(workspace,false);requestIdentity(b,input.operation_id);
      if(!OP.test(input.request_id||'')||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<0)
        hold('QUEUE_ACTIVATION_INPUT_INVALID');
      const current=await getRaw(b);
      if(!current)hold('QUEUE_ORIGINAL_REQUEST_NOT_FOUND');
      const run=current.run;
      if(!Array.isArray(run.roles)||run.roles.some(r=>typeof r.prompt!=='string'))hold('QUEUE_ACTIVATION_ORIGINAL_BINDING_MISMATCH');
      if(!record(run.ownerBinding)||['originalRequestSha256','ownerIdentityHash','definitionSha256'].some(k=>run.ownerBinding[k]!==b[k])||
        hash(JSON.stringify({title:run.title,roles:run.roles.map(r=>({id:r.id,slot:r.slot,targetNonce:r.targetNonce,conversationId:r.conversationId,prompt:r.prompt}))}))!==b.definitionSha256)
        hold('QUEUE_ACTIVATION_ORIGINAL_BINDING_MISMATCH');
      if(run.activationRequestId){
        if(run.activationRequestId!==input.request_id)hold('QUEUE_ACTIVATION_ALREADY_CLAIMED');
        if(run.executionAuthorized!==true)hold('QUEUE_ACTIVATION_READBACK_UNPROVEN');
        return {...view(run,current.revision,b.operationId),activation:'ALREADY_AUTHORIZED_NOT_RESENT',messageSubmitted:false};
      }
      await assertCurrent(workspace,b,{registration:true});
      if(current.revision!==input.expected_revision)hold('QUEUE_STALE_REVISION');
      if(run.status!=='paused'||run.paused!==true||run.roles.some(r=>!['ready','blocked'].includes(r.status)||
        r.claimToken||r.workerId||r.dispatchCount>0||r.userMessageId||r.assistantMessageId||r.submissionUncertain===true))
        hold('HOLD_ORIGINAL_CLAIM_OR_DISPATCH_RECONCILE');
      const capability=await ask(b,'orchestration_capabilities');
      if(capability?.ownerBoundActivation!==true)hold('QUEUE_OWNER_ACTIVATION_UNSUPPORTED');
      await assertCurrent(workspace,b,{registration:true});
      const result=await ask(b,'orchestration_activate',{runId:b.runId,activationRequestId:input.request_id,
        expectedRevision:input.expected_revision,originalRequestSha256:b.originalRequestSha256,
        ownerIdentityHash:b.ownerIdentityHash,definitionSha256:b.definitionSha256});
      if(!result)hold('QUEUE_ACTIVATION_OUTCOME_UNKNOWN');
      const proof=await getRaw(b);
      if(!proof||proof.run.activationRequestId!==input.request_id||proof.run.executionAuthorized!==true)
        hold('QUEUE_ACTIVATION_READBACK_UNPROVEN');
      if(!record(proof.run.ownerBinding)||['originalRequestSha256','ownerIdentityHash','definitionSha256'].some(k=>proof.run.ownerBinding[k]!==b[k])||
        proof.run.roles.some(r=>typeof r.prompt!=='string')||
        hash(JSON.stringify({title:proof.run.title,roles:proof.run.roles.map(r=>({id:r.id,slot:r.slot,targetNonce:r.targetNonce,conversationId:r.conversationId,prompt:r.prompt}))}))!==b.definitionSha256)
        hold('QUEUE_ACTIVATION_ORIGINAL_BINDING_MISMATCH');
      return {...view(proof.run,proof.revision,b.operationId),activation:'AUTHORIZED_FOR_EXISTING_EXTENSION',messageSubmitted:false};
    },
    async list(workspace){
      const b=bind(workspace,false),result=await ask(b,'orchestration_list');
      if(!result||!Array.isArray(result.runs)||!Number.isSafeInteger(result.revision))hold('QUEUE_NATIVE_LIST_UNPROVEN');
      const own=result.runs.filter(run=>run?.id===b.runId&&run.registrationOnly===true);
      if(own.some(run=>run.roles?.length!==2||run.roles.some((role,i)=>
        role.id!==b.targets[i].roleId||role.slot!==b.targets[i].slot||
        role.targetNonce!==b.targets[i].targetNonce||role.conversationId!==b.targets[i].conversationId)))
        hold('QUEUE_ORIGINAL_TARGET_BINDING_DRIFT');
      return {ok:true,revision:result.revision,runs:own.map(run=>{
        const v=view(run,result.revision,b.operationId);
        return {operationId:v.operationId,status:v.status,paused:v.paused,dispatchState:v.dispatchState};
      }),otherOwnerRunsOmitted:true};
    },
    async get(workspace,operationId){
      const b=bind(workspace,false);requestIdentity(b,operationId);
      const data=await getRaw(b);
      return data?view(data.run,data.revision,operationId):{ok:true,status:'NOT_FOUND',operationId,dispatched:false};
    },
    async cancel(workspace,input){
      const b=bind(workspace,false);requestIdentity(b,input.operation_id);
      const data=await getRaw(b);
      if(!data)hold('QUEUE_ORIGINAL_REQUEST_NOT_FOUND');
      const run=data.run;
      if(run.status==='cancelled')return {...view(run,data.revision,b.operationId),cancel:'ALREADY_CANCELLED'};
      if(run.status!=='paused'||run.paused!==true||run.roles.some(r=>!['ready','blocked'].includes(r.status)||
        r.claimToken||r.workerId||r.dispatchCount>0||r.userMessageId||r.assistantMessageId||
        r.submissionUncertain===true))hold('HOLD_ORIGINAL_CLAIM_OR_DISPATCH_RECONCILE');
      const done=await ask(b,'orchestration_control',{runId:b.runId,action:'cancel',expectedRevision:data.revision});
      if(!done)hold('QUEUE_CANCEL_OUTCOME_UNKNOWN');
      const confirmed=await getRaw(b);
      if(!confirmed||confirmed.run.status!=='cancelled'||confirmed.run.roles.some(r=>r.dispatchCount>0||r.userMessageId))
        hold('QUEUE_CANCEL_RETURN_READBACK_UNPROVEN');
      return {...view(confirmed.run,confirmed.revision,b.operationId),cancel:'CANCELLED_UNSENT',
        createdTargetByThisTool:false,originalTargetLeaseReturned:false,
        nextOwner:'ORIGINAL_CDP_TARGET_OWNER'};
    }
  };
}
