#!/usr/bin/env node
// Owner-local, source-only preparation for the existing Chrome Queue native
// ledger. The real CDP issuer, not an ordinary Chat workspace, must run this.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveWindowsPwsh} from '../../../src/lib/windows-pwsh.mjs';
import {registeredCdpSlots} from '../../../src/browser/registry.mjs';
import {nativeGptQueueExchange} from '../../../components/workspace-mcp/gpt-queue-provider.mjs';
import {
  ensureWindowsOwnerOnlyDirectory, protectWindowsOwnerOnlyPath,
  assertWindowsOwnerOnlyPath
} from '../../../src/lib/windows-owner-only-acl.mjs';

const ownRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const leaseHelper=path.join(ownRoot,'tools/platform/web-automation/Manage-CdpChromeSlotLease.ps1');
const SHA=/^[a-f0-9]{64}$/;
const OP=/^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/;
const HEX32=/^[a-f0-9]{32}$/;
// Chrome's actual target IDs use uppercase hex; lease tokens remain lowercase.
const CDP_TARGET=/^[A-Fa-f0-9]{32}$/;
const CONVERSATION=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{const e=new Error(code);e.code=code;throw e;};
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>record(x)&&Object.keys(x).every(k=>keys.includes(k));
const json=x=>JSON.stringify(x,null,2)+'\n';
const inside=(root,candidate)=>{const d=path.relative(root,candidate);return d===''||(!d.startsWith('..'+path.sep)&&d!=='..'&&!path.isAbsolute(d));};

function regular(file,maxBytes=65536){
  if(typeof file!=='string'||!path.isAbsolute(file))fail('HOLD_OWNER_ABSOLUTE_FILE_REQUIRED');
  for(let candidate=path.resolve(file);;candidate=path.dirname(candidate)){
    let st;try{st=fs.lstatSync(candidate);}catch{fail('HOLD_OWNER_FILE_MISSING');}
    if(st.isSymbolicLink())fail('HOLD_OWNER_REPARSE_POINT');
    if(candidate===path.dirname(candidate))break;
  }
  const st=fs.statSync(file);
  if(!st.isFile()||st.size<=0||st.size>maxBytes)fail('HOLD_OWNER_FILE_BOUND');
  return fs.realpathSync(file);
}
function pinned(file,expected,max=65536){
  if(!SHA.test(expected||''))fail('HOLD_EXPECTED_SOURCE_SHA_REQUIRED');
  const target=regular(file,max),bytes=fs.readFileSync(target);
  if(hash(bytes)!==expected)fail('HOLD_SOURCE_SHA_CHANGED');
  return {path:target,sha256:expected,bytes};
}
function safeReadJson(file,expected,max=65536){
  const item=pinned(file,expected,max);
  let value;try{value=JSON.parse(item.bytes.toString('utf8'));}catch{fail('HOLD_OWNER_JSON_INVALID');}
  if(!record(value))fail('HOLD_OWNER_JSON_INVALID');
  return {...item,value};
}
function exactRole(role,slot){
  if(!exact(role,['id','slot','targetId','leaseToken','targetNonce','conversationId','prompt','accountAlias','browserWorkspace'])||
    !OP.test(role.id||'')||role.slot!==slot||!HEX32.test(role.leaseToken||'')||
    !CDP_TARGET.test(role.targetId||'')||!SHA.test(role.targetNonce||'')||
    !CONVERSATION.test(role.conversationId||'')||typeof role.prompt!=='string'||
    !role.prompt.trim()||role.prompt.length>4000||
    !/^[a-zA-Z0-9_.-]{1,100}$/.test(role.accountAlias||'')||
    !/^[a-zA-Z0-9_.-]{1,100}$/.test(role.browserWorkspace||''))fail('HOLD_ORIGINAL_ROLE_INVALID');
}
export function validateOriginalQueueRequest(value,workspace){
  if(!exact(value,['schemaVersion','kind','operationId','bindingId','ownerId','ownerIdentityHash',
    'workspaceAlias','workspaceRoot','title','roles'])||
    value.schemaVersion!==1||value.kind!=='aicc-gpt-queue-original-owner-request'||
    !OP.test(value.operationId||'')||!OP.test(value.bindingId||'')||
    !OP.test(value.ownerId||'')||!SHA.test(value.ownerIdentityHash||'')||
    typeof value.title!=='string'||!value.title.trim()||value.title.length>140||
    value.workspaceAlias!==workspace.alias||
    path.resolve(value.workspaceRoot||'')!==fs.realpathSync(workspace.root)||
    !Array.isArray(value.roles)||value.roles.length!==2)fail('HOLD_ORIGINAL_REQUEST_IDENTITY');
  value.roles.forEach((role,i)=>exactRole(role,['9222','9223'][i]));
  if(value.roles[0].id===value.roles[1].id||value.roles[0].targetNonce===value.roles[1].targetNonce||
    value.roles[0].leaseToken===value.roles[1].leaseToken)fail('HOLD_DUPLICATE_OWNER_ROLE');
  return value;
}
export function validateIssuerObservation(observed,request,role,originalRequestSha256,now=Date.now()){
  const active=observed?.ok===true&&observed.status==='verified_active_owner_target';
  const retained=observed?.ok===true&&observed.status==='verified_retained_owner_target';
  const p=active||retained?observed.proof:null;
  const history=p?.retentionProof;
  if(retained&&(!exact(history,['kind','creationSha256','releaseSha256'])||
    history.kind!=='aicc-queue-keep-target-release-history/v1'||
    !SHA.test(history.creationSha256||'')||!SHA.test(history.releaseSha256||'')))
    fail('HOLD_ORIGINAL_ISSUER_RETAINED_HISTORY_UNPROVEN');
  if(!record(p)||p.schemaVersion!==1||p.kind!=='aicc-cdp-queue-live-target-inspection'||
    p.originalRequestSha256!==originalRequestSha256||p.ownerId!==request.ownerId||
    p.slot!==role.slot||p.targetId!==role.targetId||p.targetNonce!==role.targetNonce||
    p.conversationId!==role.conversationId||p.accountAlias!==role.accountAlias||
    p.workspaceAlias!==role.browserWorkspace||p.originalLeaseSha256!==hash(role.leaseToken)||
    p.state!==(retained?'OWNER_KEEP_TARGET_RETAINED':'OWNED_ACTIVE')||
    (active&&history!==undefined)||
    ![p.accountIdentityHash,p.workspaceIdentityHash,p.registrationSha256].every(x=>SHA.test(x||'')))
    fail('HOLD_ORIGINAL_ISSUER_TARGET_PROOF_UNPROVEN');
  const observedAt=Date.parse(p.observedAt),expiresAt=Date.parse(p.expiresAt);
  if(!Number.isFinite(observedAt)||!Number.isFinite(expiresAt)||observedAt>now||now-observedAt>120000||
    expiresAt<=now||expiresAt-observedAt>120000)fail('HOLD_ORIGINAL_ISSUER_PROOF_STALE');
  return p;
}
export function inspectWithRegisteredCdpIssuer(request,role,originalRequestSha256,{
  runner=spawnSync,script=leaseHelper,requestFile,powershell=resolveWindowsPwsh()
}={}){
  // The exact token is transmitted only to the original local lease owner.
  // stdout stays in this process; no request/identity/nonce is logged.
  const args=['-NoProfile','-NonInteractive','-File',script,
    '-Action','QueueOwnerInspect','-OwnerId',request.ownerId,
    '-LeaseToken',role.leaseToken,'-TargetId',role.targetId,
    ...(requestFile?['-QueueOwnerRequestFile',requestFile]:[]),
    '-ConversationId',role.conversationId,'-OriginalRequestSha256',originalRequestSha256,
    '-SlotPorts',role.slot,'-AccountAlias',role.accountAlias,
    '-Workspace',role.browserWorkspace,'-AsJson'];
  const result=runner(powershell,args,{encoding:'utf8',timeout:130000,shell:false,
    windowsHide:true,maxBuffer:65536});
  if(result.error?.code==='ETIMEDOUT')fail('HOLD_ORIGINAL_CDP_ISSUER_TIMEOUT');
  if(result.error||result.status!==0)fail('HOLD_ORIGINAL_CDP_ISSUER_UNAVAILABLE');
  let payload;try{payload=JSON.parse(result.stdout);}catch{fail('HOLD_ORIGINAL_CDP_ISSUER_JSON_INVALID');}
  return payload;
}
export function releaseOriginalQueueTarget(request,role,originalRequestSha256,{
  runner=spawnSync,script=leaseHelper,requestFile,powershell=resolveWindowsPwsh()
}={}){
  if(!requestFile||!path.isAbsolute(requestFile)||!SHA.test(originalRequestSha256||'')||
    !CDP_TARGET.test(role.targetId||'')||!HEX32.test(role.leaseToken||''))
    fail('HOLD_QUEUE_RETENTION_EXACT_SOURCE_REQUIRED');
  // One future explicitly requested formal Release -KeepTarget. No blind retry,
  // no alternate account, and no decoded private request or lease in diagnostics.
  const args=['-NoLogo','-NoProfile','-NonInteractive','-File',script,
    '-Action','Release','-OwnerId',request.ownerId,'-LeaseToken',role.leaseToken,
    '-SlotPorts',role.slot,'-AccountAlias',role.accountAlias,
    '-Workspace',role.browserWorkspace,'-KeepTarget',
    '-QueueOwnerRequestFile',requestFile,
    '-OriginalRequestSha256',originalRequestSha256,
    '-ConversationId',role.conversationId,'-AsJson'];
  const outcome=runner(powershell,args,{encoding:'utf8',timeout:30000,
    shell:false,windowsHide:true,maxBuffer:65536});
  if(outcome.error||outcome.status!==0)fail('HOLD_QUEUE_RETENTION_RELEASE_OUTCOME_UNKNOWN');
  let body;try{body=JSON.parse(outcome.stdout);}catch{fail('HOLD_QUEUE_RETENTION_RELEASE_MALFORMED');}
  if(body?.ok!==true||body.status!=='released'||body.target_closed!==false||
    body.target_id!==role.targetId||Number(body.port)!==Number(role.slot))
    fail('HOLD_QUEUE_RETENTION_RELEASE_READBACK_UNPROVEN');
  return {slot:role.slot,keepTarget:true,targetClosed:false,executionAuthorized:false};
}
function validateInstalledNative({executable,config,manifest,verifyRegistry,workspace}){
  const exe=regular(executable,32*1024*1024),cfg=regular(config),mf=regular(manifest);
  if(path.dirname(exe)!==path.dirname(cfg)||path.dirname(exe)!==path.dirname(mf)||
    path.basename(cfg)!=='native-host.config.json'||
    path.basename(mf)!=='com.agenticfabworks.webgpt_queue.json'||
    inside(workspace.root,exe)||inside(workspace.root,cfg)||inside(workspace.root,mf))
    fail('HOLD_NATIVE_REGISTERED_PATH_UNPROVEN');
  const installed=JSON.parse(fs.readFileSync(cfg,'utf8'));
  const manifestValue=JSON.parse(fs.readFileSync(mf,'utf8'));
  if(typeof installed.baseDirectory!=='string'||!path.isAbsolute(installed.baseDirectory)||
    !fs.existsSync(installed.baseDirectory)||!fs.statSync(installed.baseDirectory).isDirectory()||
    inside(workspace.root,installed.baseDirectory)||
    manifestValue.name!=='com.agenticfabworks.webgpt_queue'||manifestValue.type!=='stdio'||
    !Array.isArray(manifestValue.allowed_origins)||manifestValue.allowed_origins.length!==1||
    !/^chrome-extension:\/\/[a-p]{32}\/$/.test(manifestValue.allowed_origins[0])||
    path.resolve(manifestValue.path||'')!==exe)
    fail('HOLD_NATIVE_INSTALLED_MANIFEST_INVALID');
  if(verifyRegistry(mf)!==true)fail('HOLD_NATIVE_REGISTRY_UNPROVEN');
  return {nativeExecutable:exe,nativeExecutableSha256:hash(fs.readFileSync(exe)),
    nativeConfig:cfg,nativeConfigSha256:hash(fs.readFileSync(cfg)),
    nativeManifest:mf,nativeManifestSha256:hash(fs.readFileSync(mf)),
    baseDirectory:fs.realpathSync(installed.baseDirectory)};
}
export function registeredNativeManifestPathMatches(manifestPath,{runner=spawnSync}={}){
  if(process.platform!=='win32')return false;
  const key='HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.agenticfabworks.webgpt_queue';
  const out=runner('reg.exe',['query',key,'/ve'],{encoding:'utf8',windowsHide:true,
    timeout:6000,shell:false,maxBuffer:16384});
  if(out.error||out.status!==0)return false;
  const line=String(out.stdout).split(/\r?\n/).find(x=>/\bREG_SZ\b/.test(x));
  const value=line?.match(/\bREG_SZ\s+(.+?)\s*$/)?.[1];
  return !!value&&path.resolve(value).toLowerCase()===path.resolve(manifestPath).toLowerCase();
}
function protection(options){
  if(options.protectDir&&options.protectFile&&options.assertFile)return options;
  return {protectDir:dir=>ensureWindowsOwnerOnlyDirectory(dir),
    protectFile:file=>protectWindowsOwnerOnlyPath(file,{directory:false}),
    assertFile:file=>assertWindowsOwnerOnlyPath(file,{directory:false})};
}
function writeSealed(file,value,protectFile){
  fs.writeFileSync(file,json(value),{flag:'wx',encoding:'utf8',mode:0o600});
  protectFile(file);
  if(hash(fs.readFileSync(file))!==hash(Buffer.from(json(value))))fail('HOLD_PRIVATE_FILE_CHANGED');
  return {file,sha256:hash(fs.readFileSync(file))};
}
function sealedIssuerHelper(workspace,protect,options){
  if(options.issuerHelper)return regular(options.issuerHelper,1024*1024);
  const source=regular(leaseHelper,1024*1024);
  const guard=regular(path.join(path.dirname(source),'Assert-CdpEndpointIdentity.ps1'),1024*1024);
  if(!process.env.LOCALAPPDATA)fail('HOLD_CURRENT_ISSUER_LOCAL_STORE_REQUIRED');
  const root=path.join(process.env.LOCALAPPDATA,'AICC','queue-issuer-releases');
  if(inside(workspace.root,root))fail('HOLD_CURRENT_ISSUER_EXECUTABLE_BOUNDARY');
  const generation=hash(Buffer.concat([fs.readFileSync(source),Buffer.from('\0'),fs.readFileSync(guard)]));
  protect.protectDir(root);
  const directory=path.join(root,generation);protect.protectDir(directory);
  for(const file of [source,guard]){
    const target=path.join(directory,path.basename(file)),bytes=fs.readFileSync(file);
    if(!fs.existsSync(target)){fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});protect.protectFile(target);}
    protect.assertFile(target);
    if(hash(fs.readFileSync(regular(target,1024*1024)))!==hash(bytes))fail('HOLD_CURRENT_ISSUER_RELEASE_CHANGED');
  }
  return path.join(directory,path.basename(source));
}
function assertExactIssuerHelperUpgradeSource(prior,options,workspace){
  const old=prior?.binding?.value?.currentIssuer;
  if(!record(old)||options.currentIssuer!==true||
    options.upgradeIssuerHelper!==true||
    !SHA.test(options.expectedPriorIssuerHelperSha256||'')||
    !SHA.test(options.expectedNextIssuerHelperSha256||'')||
    !SHA.test(options.expectedNextIssuerGuardSha256||'')||
    options.expectedPriorIssuerHelperSha256!==old.helperSha256)
    fail('HOLD_ISSUER_HELPER_UPGRADE_EXPLICIT_PINS_REQUIRED');
  const oldHelper=pinned(old.helperFile,old.helperSha256,1024*1024);
  const oldGuard=pinned(old.identityGuardFile,old.identityGuardSha256,1024*1024);
  const oldShell=pinned(old.powershellFile,old.powershellSha256,128*1024*1024);
  if(path.basename(oldHelper.path)!=='Manage-CdpChromeSlotLease.ps1'||
    path.basename(oldGuard.path)!=='Assert-CdpEndpointIdentity.ps1'||
    path.dirname(oldHelper.path)!==path.dirname(oldGuard.path)||
    inside(workspace.root,oldHelper.path)||inside(workspace.root,oldShell.path))
    fail('HOLD_ISSUER_HELPER_PREVIOUS_RELEASE_BOUNDARY');
  // Code provenance is the single registered open-AICC source pair, not an
  // arbitrary path or caller boolean. New helper and guard may both change,
  // but their exact bytes and same-directory relationship are SHA-bound.
  const newSource=regular(leaseHelper,1024*1024);
  const newGuard=regular(path.join(path.dirname(newSource),'Assert-CdpEndpointIdentity.ps1'),1024*1024);
  const newHash=hash(fs.readFileSync(newSource));
  const newGuardHash=hash(fs.readFileSync(newGuard));
  if(newHash!==options.expectedNextIssuerHelperSha256||
    newGuardHash!==options.expectedNextIssuerGuardSha256||
    newHash===old.helperSha256)
    fail('HOLD_ISSUER_HELPER_SOURCE_OR_GENERATION_MISMATCH');
  const body=fs.readFileSync(newSource,'utf8');
  if(!/^\s*\[string\]\$QueueOwnerRequestFile\s*=/m.test(body)||
    !/if\s*\(\s*\$Action\s+-eq\s+'QueueOwnerInspect'\s*\)/.test(body)||
    !body.includes('Get-QueueOriginalRequestBinding')||
    !body.includes('Write-KeepTargetHistory'))
    fail('HOLD_ISSUER_HELPER_REQUIRED_ARGUMENT_UNSUPPORTED');
  if(options.issuerHelper!==undefined){
    if(options.allowFixtureDirectory!==true||
      hash(fs.readFileSync(regular(options.issuerHelper,1024*1024)))!==newHash||
      hash(fs.readFileSync(regular(path.join(path.dirname(options.issuerHelper),
        'Assert-CdpEndpointIdentity.ps1'),1024*1024)))!==newGuardHash)
      fail('HOLD_ISSUER_HELPER_PRIVATE_RELEASE_SOURCE_REQUIRED');
  }
  return {
    kind:'aicc-queue-current-issuer-helper-upgrade/v1',
    previousHelperSha256:old.helperSha256,
    previousGuardSha256:old.identityGuardSha256,
    nextHelperSha256:newHash,
    nextGuardSha256:newGuardHash,
    sourceHelperFile:newSource,sourceHelperSha256:newHash,
    sourceGuardFile:newGuard,sourceGuardSha256:newGuardHash,
    powershellSha256:old.powershellSha256,
    requiredArgument:'QueueOwnerRequestFile',
    targetLifecycle:'queue-owner-keep-target-before-registration/v1'
  };
}
function priorOwnerPreparation(options,original,source,native,workspace,protect){
  if(options.priorReceiptPath===undefined&&options.priorReceiptSha256===undefined)return null;
  const receipt=safeReadJson(options.priorReceiptPath,options.priorReceiptSha256);
  protect.assertFile(receipt.path);
  const previous=receipt.value;
  if(previous.schemaVersion!==1||previous.kind!=='aicc-gpt-queue-owner-prepared'||previous.inspectedTargets!==2||
    previous.originalRequestDispatched!==false||previous.originalRequestSha256!==source.sha256||
    previous.ownerIdentityHash!==original.ownerIdentityHash)
    fail('HOLD_REFRESH_ORIGINAL_PREPARATION_MISMATCH');
  const binding=safeReadJson(path.join(path.dirname(receipt.path),'binding.json'),previous.bindingSha256);
  protect.assertFile(binding.path);
  const b=binding.value;
  if(b.kind!=='aicc-gpt-queue-owner-binding'||b.schemaVersion!==1||
    b.bindingId!==original.bindingId||b.operationId!==original.operationId||
    b.ownerId!==original.ownerId||b.originalRequestSha256!==source.sha256||
    b.ownerIdentityHash!==original.ownerIdentityHash||b.workspaceAlias!==workspace.alias||
    b.workspaceRoot!==workspace.root||!Array.isArray(b.targets)||b.targets.length!==2||
    Object.entries(native).some(([key,value])=>b[key]!==value))
    fail('HOLD_REFRESH_ORIGINAL_BINDING_MISMATCH');
  const roles=original.roles.map(role=>({id:role.id,slot:role.slot,targetNonce:role.targetNonce,
    conversationId:role.conversationId,prompt:role.prompt}));
  if(b.definitionSha256!==hash(JSON.stringify({title:original.title,roles})))
    fail('HOLD_REFRESH_ORIGINAL_DEFINITION_MISMATCH');
  for(let i=0;i<2;i++){
    const target=b.targets[i],role=original.roles[i];
    if(!record(target)||target.roleId!==role.id||target.slot!==role.slot||
      target.targetId!==role.targetId||target.targetNonce!==role.targetNonce||
      target.conversationId!==role.conversationId||target.accountAlias!==role.accountAlias||
      target.browserWorkspace!==role.browserWorkspace||target.originalLeaseSha256!==hash(role.leaseToken))
      fail('HOLD_REFRESH_ORIGINAL_TARGET_MISMATCH');
    const proof=safeReadJson(target.proofFile,target.proofSha256);
    if(path.dirname(proof.path)!==path.dirname(binding.path))fail('HOLD_REFRESH_PROOF_BOUNDARY');
    protect.assertFile(proof.path);
    const p=proof.value;
    if(p.kind!=='aicc-queue-exact-target-proof'||p.schemaVersion!==1||
      !['OWNED_ACTIVE','OWNER_KEEP_TARGET_RETAINED'].includes(p.state)||
      (p.state==='OWNER_KEEP_TARGET_RETAINED'&&(!exact(p.retentionProof,['kind','creationSha256','releaseSha256'])||
        p.retentionProof.kind!=='aicc-queue-keep-target-release-history/v1'||
        !SHA.test(p.retentionProof.creationSha256||'')||!SHA.test(p.retentionProof.releaseSha256||'')))||
      p.bindingId!==b.bindingId||p.ownerId!==b.ownerId||
      p.originalRequestSha256!==b.originalRequestSha256||p.ownerIdentityHash!==b.ownerIdentityHash||
      ['roleId','slot','targetId','targetNonce','conversationId','accountAlias','browserWorkspace',
       'originalLeaseSha256','accountIdentityHash','workspaceIdentityHash'].some(key=>p[key]!==target[key])||
      ![p.accountIdentityHash,p.workspaceIdentityHash,p.registrationSha256].every(value=>SHA.test(value||'')))
      fail('HOLD_REFRESH_PRIOR_PROOF_MISMATCH');
  }
  return {receipt,binding};
}
async function assertUnregisteredRebind(prior,options){
  const b=prior.binding.value;
  const runId='gptq_'+hash(b.bindingId+'\0'+b.ownerIdentityHash).slice(0,24)+'_'+b.operationId;
  let response;
  try{
    response=await (options.exchange??nativeGptQueueExchange)(
      {...b,executable:b.nativeExecutable},{type:'orchestration_get',runId});
  }catch{fail('HOLD_REBIND_NATIVE_OUTCOME_UNKNOWN');}
  if(response?.ok===true)fail('HOLD_REBIND_EXISTING_RUN_RECONCILE');
  if(response?.ok!==false||response.error!=='WEBGPT_ORCHESTRATION_RUN_NOT_FOUND')
    fail('HOLD_REBIND_NATIVE_OUTCOME_UNKNOWN');
}
function rebindIdentity(request){
  return JSON.stringify({...request,roles:request.roles.map(({targetId,leaseToken,targetNonce,...role})=>role)});
}
export async function prepareGptQueueOwnerBinding(options){
  const workspace={alias:options.workspaceAlias,root:fs.realpathSync(options.workspaceRoot)};
  const protect=protection(options);
  const source=pinned(options.requestPath,options.requestSha256,65536);
  protect.assertFile(source.path); // must have been issued privately, outside writable Git
  if(inside(workspace.root,source.path))fail('HOLD_ORIGINAL_REQUEST_REMOTE_WRITABLE');
  const original=validateOriginalQueueRequest(JSON.parse(source.bytes.toString('utf8')),workspace);
  const native=validateInstalledNative({executable:options.nativeExecutable,
    config:options.nativeConfig,manifest:options.nativeManifest,
    verifyRegistry:options.verifyRegistry??(file=>registeredNativeManifestPathMatches(file)),
    workspace});
  const rebind=options.rebindFromRequestPath!==undefined||options.rebindFromRequestSha256!==undefined;
  if(options.verifyCurrentOnly===true&&(!options.priorReceiptPath||rebind))
    fail('HOLD_CURRENT_ISSUER_ORIGINAL_PREPARATION_REQUIRED');
  let prior;
  if(rebind){
    if(!options.priorReceiptPath||!options.priorReceiptSha256)fail('HOLD_REBIND_PRIOR_PREPARATION_REQUIRED');
    const previous=safeReadJson(options.rebindFromRequestPath,options.rebindFromRequestSha256);
    protect.assertFile(previous.path);
    if(inside(workspace.root,previous.path))fail('HOLD_ORIGINAL_REQUEST_REMOTE_WRITABLE');
    const previousRequest=validateOriginalQueueRequest(previous.value,workspace);
    if(previous.sha256===source.sha256||rebindIdentity(previousRequest)!==rebindIdentity(original))
      fail('HOLD_REBIND_SEMANTIC_IDENTITY_CHANGED');
    prior=priorOwnerPreparation(options,previousRequest,previous,native,workspace,protect);
    await assertUnregisteredRebind(prior,options);
  }else{prior=priorOwnerPreparation(options,original,source,native,workspace,protect);}
  if(prior?.binding.value.currentIssuer&&options.currentIssuer!==true&&options.verifyCurrentOnly!==true)
    fail('HOLD_CURRENT_ISSUER_DOWNGRADE_REFUSED');
  const upgrade=options.upgradeIssuerHelper===true;
  const pinOverrides=['expectedPriorIssuerHelperSha256','expectedNextIssuerHelperSha256',
    'expectedNextIssuerGuardSha256'];
  if(upgrade&&(!rebind||!prior||options.currentIssuer!==true||
    options.verifyCurrentOnly===true||options.finalizeRetainedTargets===true))
    fail('HOLD_ISSUER_HELPER_UPGRADE_REBIND_ONLY');
  if(!upgrade&&pinOverrides.some(k=>options[k]!==undefined))
    fail('HOLD_ISSUER_HELPER_UPGRADE_EXPLICIT_OPT_IN_REQUIRED');
  const issuerUpgrade=upgrade?assertExactIssuerHelperUpgradeSource(prior,options,workspace):null;
  if(options.retainOriginalTargets===true)
    fail('HOLD_QUEUE_RETENTION_REQUIRES_SEPARATE_FINALIZE_MODE');
  const finalize=options.finalizeRetainedTargets===true;
  if(finalize&&(!prior||rebind||options.verifyCurrentOnly===true||
    prior.binding.value.targetLifecycle!=='queue-owner-keep-target-before-registration/v1'||
    !prior.binding.value.currentIssuer))
    fail('HOLD_QUEUE_RETENTION_INSTALLED_ORIGINAL_OWNER_REQUIRED');
  if(finalize&&(!options.installedConfigFile||!options.installedConfigSha256))
    fail('HOLD_QUEUE_RETENTION_INSTALLED_CONFIG_PIN_REQUIRED');
  if(finalize&&!options.allowFixtureDirectory){
    const expected=path.join(os.homedir(),'.ai-control-center','workspace-mcp','config.json');
    if(path.resolve(options.installedConfigFile).toLowerCase()!==expected.toLowerCase())
      fail('HOLD_QUEUE_RETENTION_REGISTERED_CONFIG_PATH_REQUIRED');
  }
  const installed=finalize?safeReadJson(options.installedConfigFile,options.installedConfigSha256):null;
  if(finalize&&(installed.value?.gptQueue?.enabled!==true||
    installed.value.gptQueue.bindingFile!==prior.binding.path||
    installed.value.gptQueue.bindingSha256!==prior.binding.sha256))
    fail('HOLD_QUEUE_RETENTION_REGISTERED_CONFIG_MISMATCH');
  const slots=options.registeredSlots??registeredCdpSlots();
  const verified=[];
  for(let i=0;i<2;i++){
    const role=original.roles[i],slot=slots.find(x=>String(x.port)===role.slot);
    if(!slot||slot.automaticLeaseEligible!==true||slot.accountAlias!==role.accountAlias||
      slot.workspace!==role.browserWorkspace)fail('HOLD_REGISTERED_SLOT_ACCOUNT_MISMATCH');
    const inspect=options.inspectTarget??((req,r,sha)=>inspectWithRegisteredCdpIssuer(req,r,sha,{requestFile:source.path}));
    const observed=await inspect(original,role,source.sha256);
    verified.push(validateIssuerObservation(observed,original,role,source.sha256,options.now?.()??Date.now()));
  }
  // A slow second issuer read must not publish an already expired first proof.
  for(let i=0;i<2;i++)validateIssuerObservation({ok:true,
    status:verified[i].state==='OWNER_KEEP_TARGET_RETAINED'
      ?'verified_retained_owner_target':'verified_active_owner_target',
    proof:verified[i]},original,original.roles[i],source.sha256,options.now?.()??Date.now());
  if(prior&&verified.some((proof,i)=>
    ['accountIdentityHash','workspaceIdentityHash'].some(key=>proof[key]!==prior.binding.value.targets[i][key])))
    fail('HOLD_REFRESH_LIVE_IDENTITY_CHANGED');
  // A full immutable inventory/backup may take longer than the original proof.
  // Observe the SAME original issuer targets again without rewriting any pin,
  // issuing a replacement binding, or granting execution authority.
  if(options.verifyCurrentOnly===true){
    return {status:'CURRENT_ORIGINAL_ISSUER_VERIFIED_READ_ONLY',
      originalRequestSha256:source.sha256,priorReceiptSha256:prior.receipt.sha256,
      bindingSha256:prior.binding.sha256,targetCount:2,
      proofExpiryUtc:verified.map(p=>p.expiresAt),
      observations:verified.map(p=>({slot:p.slot,observedAt:p.observedAt,expiresAt:p.expiresAt})),
      currentIssuerVerified:true,filesWritten:0,installed:false,
      workspaceApplied:false,chatToolPublished:false,dispatched:false,
      executionAuthorized:false};
  }
  // Rebinding is preparation only. A concurrent old registration must be
  // reconciled, never carried into a new target definition or replayed.
  if(rebind){
    await assertUnregisteredRebind(prior,options);
    for(let i=0;i<2;i++)validateIssuerObservation({ok:true,
      status:verified[i].state==='OWNER_KEEP_TARGET_RETAINED'
        ?'verified_retained_owner_target':'verified_active_owner_target',
      proof:verified[i]},original,original.roles[i],source.sha256,options.now?.()??Date.now());
  }
  if(finalize){
    if(verified.some(p=>p.state!=='OWNED_ACTIVE'))
      fail('HOLD_QUEUE_RETENTION_ACTIVE_OWNER_REQUIRED');
    // Exact original owner release only; no task-new target creation and
    // no resend. A partial failure stays HOLD for the owner to reconcile.
    const c=prior.binding.value.currentIssuer;
    const helper=pinned(c.helperFile,c.helperSha256,1024*1024);
    const powershell=pinned(c.powershellFile,c.powershellSha256,128*1024*1024);
    const registeredConfigStillPinned=()=>
      pinned(installed.path,installed.sha256,65536);
    const release=options.releaseTarget??((req,r,sha)=>
      releaseOriginalQueueTarget(req,r,sha,{requestFile:source.path,script:helper,powershell}));
    for(const role of original.roles){
      registeredConfigStillPinned();
      const outcome=await release(original,role,source.sha256);
      if(outcome?.keepTarget!==true||outcome?.targetClosed!==false||
        outcome.slot!==role.slot)fail('HOLD_QUEUE_RETENTION_RELEASE_READBACK_UNPROVEN');
    }
    for(let i=0;i<original.roles.length;i++){
      const role=original.roles[i];
      const inspect=options.inspectTarget??((req,r,sha)=>
        inspectWithRegisteredCdpIssuer(req,r,sha,{requestFile:source.path,script:helper}));
      const observed=await inspect(original,role,source.sha256);
      const fresh=validateIssuerObservation(observed,original,role,source.sha256,
        options.now?.()??Date.now());
      if(fresh.state!=='OWNER_KEEP_TARGET_RETAINED'||
         ['accountIdentityHash','workspaceIdentityHash','registrationSha256'].some(
           k=>fresh[k]!==verified[i][k]))
        fail('HOLD_QUEUE_RETENTION_FRESH_PROOF_UNVERIFIED');
      verified[i]=fresh;
    }
    registeredConfigStillPinned();
    return {status:'ORIGINAL_QUEUE_TARGETS_RETAINED_SOURCE_ONLY',
      originalRequestSha256:source.sha256,
      priorReceiptSha256:prior.receipt.sha256,
      originalBindingSha256:prior.binding.sha256,
      targetCount:2,retainedTargetCount:verified.length,
      currentIssuerVerified:true,keepTargetReturnCount:2,
      filesWritten:0,bindingChanged:false,configChanged:false,
      installed:false,workspaceApplied:false,chatToolPublished:false,
      dispatched:false,executionAuthorized:false};
  }
  if(options.ownerDirectory!==undefined&&!options.allowFixtureDirectory){
    const expected=path.join(process.env.LOCALAPPDATA??'', 'AICC','queue-owner-bindings');
    if(!process.env.LOCALAPPDATA||path.resolve(options.ownerDirectory).toLowerCase()!==path.resolve(expected).toLowerCase())
      fail('HOLD_PRIVATE_OWNER_DIRECTORY_MISMATCH');
  }
  const root=options.ownerDirectory??path.join(process.env.LOCALAPPDATA??'', 'AICC','queue-owner-bindings');
  if(!path.isAbsolute(root)||inside(workspace.root,root))fail('HOLD_PRIVATE_OWNER_ROOT_INVALID');
  protect.protectDir(root);
  const generation=prior?'\0'+prior.receipt.sha256+'\0'+hash(JSON.stringify(verified)):'';
  const key=hash(original.bindingId+'\0'+original.operationId+'\0'+source.sha256+generation).slice(0,32);
  const destination=path.join(root,'owner-'+key);
  if(prior&&!inside(root,prior.receipt.path))fail('HOLD_REFRESH_OWNER_ROOT_MISMATCH');
  if(fs.existsSync(destination))fail('HOLD_ORIGINAL_PREPARE_ALREADY_EXISTS_RECONCILE'); // never overwrite a partial or finished original
  protect.protectDir(destination);
  const targets=[];
  for(let i=0;i<2;i++){
    const role=original.roles[i],obs=verified[i];
    const body={schemaVersion:1,kind:'aicc-queue-exact-target-proof',
      bindingId:original.bindingId,ownerIdentityHash:original.ownerIdentityHash,
      originalRequestSha256:source.sha256,ownerId:original.ownerId,
      roleId:role.id,slot:role.slot,targetId:role.targetId,targetNonce:role.targetNonce,
      conversationId:role.conversationId,accountAlias:role.accountAlias,
      browserWorkspace:role.browserWorkspace,accountIdentityHash:obs.accountIdentityHash,
      workspaceIdentityHash:obs.workspaceIdentityHash,registrationSha256:obs.registrationSha256,
      originalLeaseSha256:obs.originalLeaseSha256,state:obs.state,
      ...(obs.retentionProof?{retentionProof:obs.retentionProof}:{}),
      observedAt:obs.observedAt,expiresAt:obs.expiresAt};
    const item=writeSealed(path.join(destination,'slot-'+role.slot+'.proof.json'),body,protect.protectFile);
    targets.push({roleId:role.id,slot:role.slot,targetId:role.targetId,
      targetNonce:role.targetNonce,conversationId:role.conversationId,
      accountAlias:role.accountAlias,browserWorkspace:role.browserWorkspace,
      accountIdentityHash:obs.accountIdentityHash,workspaceIdentityHash:obs.workspaceIdentityHash,
      originalLeaseSha256:obs.originalLeaseSha256,
      proofFile:item.file,proofSha256:item.sha256});
  }
  const roles=original.roles.map(role=>({id:role.id,slot:role.slot,targetNonce:role.targetNonce,
    conversationId:role.conversationId,prompt:role.prompt}));
  const binding={schemaVersion:1,kind:'aicc-gpt-queue-owner-binding',
    bindingId:original.bindingId,operationId:original.operationId,
    ownerId:original.ownerId,ownerIdentityHash:original.ownerIdentityHash,
    originalRequestSha256:source.sha256,workspaceAlias:workspace.alias,
    workspaceRoot:workspace.root,definitionSha256:hash(JSON.stringify({title:original.title,roles})),
    ...native,targets};
  if(options.currentIssuer===true){
    binding.targetLifecycle='queue-owner-keep-target-before-registration/v1';
    const helper=sealedIssuerHelper(workspace,protect,options);
    const guard=regular(path.join(path.dirname(helper),'Assert-CdpEndpointIdentity.ps1'),1024*1024);
    if(issuerUpgrade&&(hash(fs.readFileSync(helper))!==issuerUpgrade.nextHelperSha256||
      hash(fs.readFileSync(guard))!==issuerUpgrade.nextGuardSha256))
      fail('HOLD_ISSUER_HELPER_SEALED_RELEASE_CHANGED');
    const powershell=regular(options.powershellFile??resolveWindowsPwsh(),128*1024*1024);
    if(inside(workspace.root,helper)||inside(workspace.root,powershell))fail('HOLD_CURRENT_ISSUER_EXECUTABLE_BOUNDARY');
    binding.currentIssuer={kind:'registered-cdp-current-issuer/v1',
      requestFile:source.path,requestSha256:source.sha256,
      helperFile:helper,helperSha256:hash(fs.readFileSync(helper)),
      identityGuardFile:guard,identityGuardSha256:hash(fs.readFileSync(guard)),
      powershellFile:powershell,powershellSha256:hash(fs.readFileSync(powershell))};
    if(issuerUpgrade){
      if(binding.currentIssuer.powershellSha256!==issuerUpgrade.powershellSha256)
        fail('HOLD_ISSUER_HELPER_SHELL_PIN_CHANGED');
      binding.issuerHelperUpgrade=issuerUpgrade;
    }
  }
  const bundle=writeSealed(path.join(destination,'binding.json'),binding,protect.protectFile);
  const overlay=writeSealed(path.join(destination,'business-full-config-candidate.json'),
    {gptQueue:{enabled:true,bindingFile:bundle.file,bindingSha256:bundle.sha256}},protect.protectFile);
  const receipt=writeSealed(path.join(destination,'prepared.json'),{
    schemaVersion:1,kind:'aicc-gpt-queue-owner-prepared',originalRequestSha256:source.sha256,
    bindingSha256:bundle.sha256,configOverlaySha256:overlay.sha256,
    ownerIdentityHash:original.ownerIdentityHash,
    inspectedTargets:2,retainedByOriginalIssuer:false,
    targetLifecycle:binding.targetLifecycle??null,
    observedExpiryUtc:verified.map(p=>p.expiresAt),
    sourceOnly:true,installedWorkspaceProvider:false,toolPublished:false,
    nativePinned:true,originalRequestDispatched:false,
    ...(issuerUpgrade?{issuerHelperUpgrade:issuerUpgrade}:{}),
    ...(prior?{priorReceiptPath:prior.receipt.path,priorReceiptSha256:prior.receipt.sha256,
      priorBindingSha256:prior.binding.sha256,refreshedByOriginalIssuer:true}:{}),
    ...(rebind?{reboundUnregisteredRequest:true,
      priorOriginalRequestSha256:prior.binding.value.originalRequestSha256}:{})},protect.protectFile);
  return {status:'PREPARED_OWNER_EVIDENCE_UNINSTALLED',receiptPath:receipt.file,
    receiptSha256:receipt.sha256,bindingPath:bundle.file,bindingSha256:bundle.sha256,
    overlayPath:overlay.file,overlaySha256:overlay.sha256,targetCount:2,
    retainedByOriginalIssuer:false,
    targetLifecycle:binding.targetLifecycle??null,
    proofExpiryUtc:verified.map(p=>p.expiresAt),
    installed:false,workspaceApplied:false,chatToolPublished:false,dispatched:false,
    ...(prior?{refreshed:true,originalRequestPreserved:true,priorReceiptSha256:prior.receipt.sha256}:{}),
    ...(rebind?{rebound:true,nativeRegistration:'ABSENT_READ_ONLY',nativeWrites:0}:{})};
}
async function cli(argv){
  const flags=new Map();
  for(let i=0;i<argv.length;i+=2){
    if(!argv[i]?.startsWith('--')||argv[i+1]===undefined||flags.has(argv[i]))fail('HOLD_OWNER_CLI_ARGS');
    flags.set(argv[i],argv[i+1]);
  }
  const required=['--request','--request-sha256','--workspace-alias','--workspace-root',
    '--native-exe','--native-config','--native-manifest'];
  const optional=['--prior-receipt','--prior-receipt-sha256','--rebind-from-request',
    '--rebind-from-request-sha256','--verify-current-only','--current-issuer',
    '--finalize-retained-targets','--installed-config','--installed-config-sha256',
    '--upgrade-issuer-helper','--expected-prior-issuer-helper-sha256',
    '--expected-next-issuer-helper-sha256','--expected-next-issuer-guard-sha256'];
  if(required.some(k=>!flags.has(k))||[...flags.keys()].some(k=>![...required,...optional].includes(k))||
    flags.has('--prior-receipt')!==flags.has('--prior-receipt-sha256')||
    flags.has('--rebind-from-request')!==flags.has('--rebind-from-request-sha256')||
    (flags.has('--verify-current-only')&&flags.get('--verify-current-only')!=='true')||
    (flags.has('--current-issuer')&&flags.get('--current-issuer')!=='true')||
    (flags.has('--finalize-retained-targets')&&flags.get('--finalize-retained-targets')!=='true')||
    flags.has('--installed-config')!==flags.has('--installed-config-sha256')||
    (flags.has('--upgrade-issuer-helper')&&flags.get('--upgrade-issuer-helper')!=='true')||
    (flags.has('--upgrade-issuer-helper')!==
      ['--expected-prior-issuer-helper-sha256','--expected-next-issuer-helper-sha256',
       '--expected-next-issuer-guard-sha256'].every(k=>flags.has(k))))
    fail('HOLD_OWNER_CLI_ARGS');
  const value=await prepareGptQueueOwnerBinding({
    requestPath:flags.get('--request'),requestSha256:flags.get('--request-sha256'),
    workspaceAlias:flags.get('--workspace-alias'),workspaceRoot:flags.get('--workspace-root'),
    nativeExecutable:flags.get('--native-exe'),nativeConfig:flags.get('--native-config'),
    nativeManifest:flags.get('--native-manifest'),
    priorReceiptPath:flags.get('--prior-receipt'),priorReceiptSha256:flags.get('--prior-receipt-sha256'),
    rebindFromRequestPath:flags.get('--rebind-from-request'),
    rebindFromRequestSha256:flags.get('--rebind-from-request-sha256'),
    verifyCurrentOnly:flags.get('--verify-current-only')==='true',
    currentIssuer:flags.get('--current-issuer')==='true',
    finalizeRetainedTargets:flags.get('--finalize-retained-targets')==='true',
    installedConfigFile:flags.get('--installed-config'),
    installedConfigSha256:flags.get('--installed-config-sha256'),
    upgradeIssuerHelper:flags.get('--upgrade-issuer-helper')==='true',
    expectedPriorIssuerHelperSha256:flags.get('--expected-prior-issuer-helper-sha256'),
    expectedNextIssuerHelperSha256:flags.get('--expected-next-issuer-helper-sha256'),
    expectedNextIssuerGuardSha256:flags.get('--expected-next-issuer-guard-sha256')
  });
  console.log(JSON.stringify({ok:true,...value},null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  cli(process.argv.slice(2)).catch(error=>{
    console.error(JSON.stringify({ok:false,status:'HOLD',reason:/^HOLD_/.test(error?.code??'')?error.code:'HOLD_OWNER_PREPARATION_UNPROVEN'}));
    process.exitCode=4;
  });
}
