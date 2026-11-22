import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {
  prepareGptQueueOwnerBinding, validateIssuerObservation, releaseOriginalQueueTarget,
  validateOriginalQueueRequest, inspectWithRegisteredCdpIssuer
} from '../tools/platform/web-automation/Prepare-GptQueueOwnerBinding.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
test('original issuer inspection waits for slow owner metadata and keeps failure private',()=>{
  const request={ownerId:'test-owner-0001'},role={leaseToken:'private-lease',
    targetId:'target',conversationId:'conversation',slot:'9222',accountAlias:'account',browserWorkspace:'workspace'};
  const options={powershell:'registered-powershell',script:'registered-helper',requestFile:'private-request',
    runner:(exe,args,opts)=>{
      assert.equal(exe,'registered-powershell');
      assert.equal(opts.timeout,130000);assert.equal(opts.windowsHide,true);assert.equal(opts.shell,false);
      assert.ok(args.includes('QueueOwnerInspect'));assert.ok(args.includes('private-request'));
      return {status:0,stdout:JSON.stringify({ok:true,status:'verified_active_owner_target'})};
    }};
  assert.equal(inspectWithRegisteredCdpIssuer(request,role,'sha',options).ok,true);
  for(const [result,code] of [
    [{error:{code:'ETIMEDOUT',message:'private-lease'},stderr:'private-request'},'HOLD_ORIGINAL_CDP_ISSUER_TIMEOUT'],
    [{status:4,stdout:'private-lease',stderr:'private-request'},'HOLD_ORIGINAL_CDP_ISSUER_UNAVAILABLE'],
    [{status:0,stdout:'private-lease'},'HOLD_ORIGINAL_CDP_ISSUER_JSON_INVALID']
  ])assert.throws(()=>inspectWithRegisteredCdpIssuer(request,role,'sha',{...options,runner:()=>result}),
    error=>error.code===code&&!error.message.includes('private-'));
});
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'g1-private-owner-proof-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const ws=path.join(root,'workspace'),owner=path.join(root,'owner');
  const installed=path.join(owner,'installed'),archive=path.join(owner,'archive');
  for(const d of [ws,owner,installed,archive])fs.mkdirSync(d,{recursive:true});
  const nativeExecutable=path.join(installed,'webgpt-queue-native-host.exe');
  const nativeConfig=path.join(installed,'native-host.config.json');
  const nativeManifest=path.join(installed,'com.agenticfabworks.webgpt_queue.json');
  fs.writeFileSync(nativeExecutable,'SYNTHETIC_BIN_DO_NOT_EXECUTE');
  fs.writeFileSync(nativeConfig,JSON.stringify({baseDirectory:archive}));
  fs.writeFileSync(nativeManifest,JSON.stringify({name:'com.agenticfabworks.webgpt_queue',
    description:'synthetic',path:nativeExecutable,type:'stdio',
    allowed_origins:['chrome-extension://'+'a'.repeat(32)+'/']}));
  const now=Date.parse('2026-11-10T00:00:00.000Z');
  const role=(id,slot,token,nonce,conversation,account)=>({
    id,slot,leaseToken:token,targetId:nonce,targetNonce:nonce.repeat(2),
    conversationId:conversation,accountAlias:account,browserWorkspace:'ordinary',
    prompt:'synthetic task input'
  });
  const roles=[
    role('role-one-0001','9222','1'.repeat(32),'a'.repeat(32),
      '11111111-1111-4111-8111-111111111111','acc-one'),
    role('role-two-0002','9223','2'.repeat(32),'b'.repeat(32),
      '22222222-2222-4222-8222-222222222222','acc-two')
  ];
  const request={schemaVersion:1,kind:'aicc-gpt-queue-original-owner-request',
    bindingId:'owner-binding-0001',operationId:'original-request-0001',
    ownerId:'original-owner-0001',ownerIdentityHash:'e'.repeat(64),
    workspaceAlias:'queue-fixture',workspaceRoot:ws,
    title:'fake owner role handoff',roles};
  const requestPath=path.join(owner,'request.json');
  fs.writeFileSync(requestPath,JSON.stringify(request),{mode:0o600});
  const requestSha256=hash(fs.readFileSync(requestPath));
  const registeredSlots=[
    {port:9222,accountAlias:'acc-one',workspace:'ordinary',automaticLeaseEligible:true},
    {port:9223,accountAlias:'acc-two',workspace:'ordinary',automaticLeaseEligible:true}
  ];
  const observation=(req,role,sha)=>({ok:true,status:'verified_active_owner_target',proof:{
    schemaVersion:1,kind:'aicc-cdp-queue-live-target-inspection',
    originalRequestSha256:sha,ownerId:req.ownerId,originalLeaseSha256:hash(role.leaseToken),
    slot:role.slot,targetId:role.targetId,targetNonce:role.targetNonce,
    conversationId:role.conversationId,accountAlias:role.accountAlias,
    workspaceAlias:role.browserWorkspace,
    accountIdentityHash:(role.slot==='9222'?'a':'b').repeat(64),
    workspaceIdentityHash:'c'.repeat(64),registrationSha256:'d'.repeat(64),
    observedAt:new Date(now-1000).toISOString(),
    expiresAt:new Date(now+60000).toISOString(),state:'OWNED_ACTIVE'
  }});
  const options={requestPath,requestSha256,workspaceAlias:'queue-fixture',workspaceRoot:ws,
    nativeExecutable,nativeConfig,nativeManifest,ownerDirectory:path.join(owner,'prepared'),
    allowFixtureDirectory:true,now:()=>now,
    protectDir:d=>{fs.mkdirSync(d,{recursive:true,mode:0o700});return true;},
    protectFile:p=>{fs.chmodSync(p,0o600);return true;},
    assertFile:p=>{assert.equal(fs.statSync(p).isFile(),true);return true;},
    verifyRegistry:()=>true,registeredSlots,inspectTarget:observation};
  return {root,ws,owner,installed,archive,options,now,request,roles,observation,requestSha256};
}
test('G1 owner issuer prepares exact two active private role proofs and pinned binding without dispatch',async t=>{
  const f=fixture(t),out=await prepareGptQueueOwnerBinding(f.options);
  assert.equal(out.status,'PREPARED_OWNER_EVIDENCE_UNINSTALLED');
  assert.equal(out.targetCount,2);assert.equal(out.installed,false);
  const binding=JSON.parse(fs.readFileSync(out.bindingPath,'utf8'));
  assert.equal(binding.targets.length,2);
  assert.equal(binding.originalRequestSha256,f.requestSha256);
  assert.equal(binding.targets[0].slot,'9222');
  assert.equal(binding.targets[1].slot,'9223');
  assert.notEqual(binding.targets[0].accountIdentityHash,binding.targets[1].accountIdentityHash);
  assert.equal(binding.nativeExecutable,f.options.nativeExecutable);
  assert.equal(binding.nativeManifestSha256,hash(fs.readFileSync(f.options.nativeManifest)));
  assert.equal(out.bindingSha256,hash(fs.readFileSync(out.bindingPath)));
  const overlay=JSON.parse(fs.readFileSync(out.overlayPath,'utf8'));
  assert.equal(overlay.gptQueue.enabled,true);
  assert.equal(overlay.gptQueue.bindingSha256,out.bindingSha256);
  const receipt=JSON.parse(fs.readFileSync(out.receiptPath,'utf8'));
  assert.equal(receipt.originalRequestDispatched,false);
  assert.equal(receipt.toolPublished,false);
  assert.equal(receipt.observedExpiryUtc.length,2);
  for(const target of binding.targets){
    const proof=JSON.parse(fs.readFileSync(target.proofFile,'utf8'));
    assert.equal(target.proofSha256,hash(fs.readFileSync(target.proofFile)));
    assert.equal(proof.ownerId,f.request.ownerId);
    assert.equal(proof.originalRequestSha256,f.requestSha256);
    assert.equal(proof.originalLeaseSha256,target.originalLeaseSha256);
  }
  const result=JSON.stringify(out);
  assert.equal(result.includes(f.roles[0].leaseToken),false);
  assert.equal(result.includes(f.roles[0].prompt),false);
  assert.equal(result.includes(f.roles[0].targetNonce),false);
});
test('G1 current issuer observation after slow immutable verification preserves every original pin',async t=>{
  const f=fixture(t),first=await prepareGptQueueOwnerBinding(f.options);
  const files=[first.receiptPath,first.bindingPath,first.overlayPath,
    ...JSON.parse(fs.readFileSync(first.bindingPath)).targets.map(x=>x.proofFile)];
  const before=files.map(file=>hash(fs.readFileSync(file)));
  const later=f.now+600000;let inspections=0;
  const out=await prepareGptQueueOwnerBinding({...f.options,
    priorReceiptPath:first.receiptPath,priorReceiptSha256:first.receiptSha256,
    verifyCurrentOnly:true,now:()=>later,
    inspectTarget:async(req,role,sha)=>{inspections++;const o=f.observation(req,role,sha);
      o.proof.observedAt=new Date(later-1000).toISOString();
      o.proof.expiresAt=new Date(later+60000).toISOString();return o;}});
  assert.equal(inspections,2);assert.equal(out.currentIssuerVerified,true);
  assert.equal(out.filesWritten,0);assert.equal(out.executionAuthorized,false);
  assert.equal(out.dispatched,false);assert.equal(out.bindingSha256,first.bindingSha256);
  assert.deepEqual(files.map(file=>hash(fs.readFileSync(file))),before);
  assert.equal(fs.readdirSync(f.options.ownerDirectory).length,1);
  const serialized=JSON.stringify(out);
  for(const role of f.roles){assert.equal(serialized.includes(role.leaseToken),false);
    assert.equal(serialized.includes(role.targetNonce),false);}
});

test('G1 current issuer prepares active proof for old provider stage, requiring formal retention before registration',async t=>{
  const f=fixture(t),helper=path.join(f.owner,'Manage-CdpChromeSlotLease.ps1');
  const guard=path.join(f.owner,'Assert-CdpEndpointIdentity.ps1');
  fs.writeFileSync(helper,'SYNTHETIC-NOT-EXECUTED');fs.writeFileSync(guard,'SYNTHETIC-NOT-EXECUTED');
  let releases=0;
  const first=await prepareGptQueueOwnerBinding({...f.options,currentIssuer:true,
    releaseTarget:async()=>{releases++;throw Error('RELEASE_NOT_PERMITTED_DURING_STAGE');},
    issuerHelper:helper,powershellFile:f.options.nativeExecutable});
  assert.equal(releases,0);assert.equal(first.retainedByOriginalIssuer,false);
  assert.equal(first.targetLifecycle,'queue-owner-keep-target-before-registration/v1');
  const binding=JSON.parse(fs.readFileSync(first.bindingPath));
  assert.equal(binding.targetLifecycle,'queue-owner-keep-target-before-registration/v1');
  for(const t of binding.targets){
    const proof=JSON.parse(fs.readFileSync(t.proofFile));
    assert.equal(proof.state,'OWNED_ACTIVE');assert.equal(proof.retentionProof,undefined);
  }
  assert.equal(binding.currentIssuer.requestFile,fs.realpathSync(f.options.requestPath));
  assert.equal(binding.currentIssuer.helperSha256,hash(fs.readFileSync(helper)));
  assert.equal(binding.currentIssuer.identityGuardSha256,hash(fs.readFileSync(guard)));
  assert.equal(JSON.stringify(binding).includes(f.roles[0].leaseToken),false);
  assert.equal(fs.existsSync(path.join(path.dirname(first.bindingPath),'request.json')),false);
  await assert.rejects(prepareGptQueueOwnerBinding({...f.options,
    priorReceiptPath:first.receiptPath,priorReceiptSha256:first.receiptSha256}),
    /HOLD_CURRENT_ISSUER_DOWNGRADE_REFUSED/);
});
test('G1 source refuses implicit KeepTarget during initial candidate and unsupported legacy flag',async t=>{
  const f=fixture(t),helper=path.join(f.owner,'Manage-CdpChromeSlotLease.ps1');
  const guard=path.join(f.owner,'Assert-CdpEndpointIdentity.ps1');
  fs.writeFileSync(helper,'SYNTHETIC-NOT-EXECUTED');
  fs.writeFileSync(guard,'SYNTHETIC-NOT-EXECUTED');
  await assert.rejects(prepareGptQueueOwnerBinding({...f.options,currentIssuer:true,
    retainOriginalTargets:true,issuerHelper:helper,powershellFile:f.options.nativeExecutable}),
    /HOLD_QUEUE_RETENTION_REQUIRES_SEPARATE_FINALIZE_MODE/);
  assert.equal(fs.existsSync(f.options.ownerDirectory),false);
});
test('G1 exact source caller releases one target once with KeepTarget, preserves private request and no model send',t=>{
  const f=fixture(t),invocations=[];
  const result=releaseOriginalQueueTarget(f.request,f.roles[0],f.requestSha256,{
    requestFile:f.options.requestPath,powershell:'pinned-fake-pwsh',
    runner:(exe,args,flags)=>{
      invocations.push({exe,args,flags});
      assert.equal(args.includes('-KeepTarget'),true);
      assert.equal(args.includes('-QueueOwnerRequestFile'),true);
      assert.equal(args.includes(f.options.requestPath),true);
      assert.equal(args.includes(f.roles[0].leaseToken),true);
      assert.equal(flags.shell,false);assert.equal(flags.windowsHide,true);
      return {status:0,stdout:JSON.stringify({ok:true,status:'released',
        target_closed:false,target_id:f.roles[0].targetId,port:9222})};
    }
  });
  assert.equal(invocations.length,1);
  assert.deepEqual(result,{slot:'9222',keepTarget:true,targetClosed:false,executionAuthorized:false});
  assert.equal(JSON.stringify(result).includes(f.roles[0].leaseToken),false);
  assert.equal(JSON.stringify(result).includes(f.roles[0].prompt),false);
  assert.throws(()=>releaseOriginalQueueTarget(f.request,f.roles[0],f.requestSha256,{
    requestFile:f.options.requestPath,powershell:'pinned-fake-pwsh',
    runner:()=>({status:4,stdout:'PRIVATE_LEASE_TOKEN'})}),
    error=>error.code==='HOLD_QUEUE_RETENTION_RELEASE_OUTCOME_UNKNOWN'&&
      !JSON.stringify(error).includes('PRIVATE'));
});
test('G1 two-stage source finalizer checks exact installed config, releases both once, then observes formal retained history without writing binding',async t=>{
  const f=fixture(t),helper=path.join(f.owner,'Manage-CdpChromeSlotLease.ps1');
  const guard=path.join(f.owner,'Assert-CdpEndpointIdentity.ps1');
  fs.writeFileSync(helper,'SYNTHETIC-NOT-EXECUTED');
  fs.writeFileSync(guard,'SYNTHETIC-NOT-EXECUTED');
  const first=await prepareGptQueueOwnerBinding({...f.options,currentIssuer:true,
    issuerHelper:helper,powershellFile:f.options.nativeExecutable});
  const files=[first.receiptPath,first.bindingPath,first.overlayPath,
    ...JSON.parse(fs.readFileSync(first.bindingPath)).targets.map(x=>x.proofFile)];
  const hashes=files.map(p=>hash(fs.readFileSync(p)));
  const installedConfigFile=path.join(f.owner,'installed-current-config.json');
  fs.writeFileSync(installedConfigFile,JSON.stringify({gptQueue:{enabled:true,
    bindingFile:first.bindingPath,bindingSha256:first.bindingSha256}}));
  let calls=0;const retained=new Set();
  const inspectTarget=async(req,role,sha)=>{
    const o=f.observation(req,role,sha);
    if(retained.has(role.slot)){
      o.status='verified_retained_owner_target';o.proof.state='OWNER_KEEP_TARGET_RETAINED';
      o.proof.retentionProof={kind:'aicc-queue-keep-target-release-history/v1',
        creationSha256:(role.slot==='9222'?'3':'4').repeat(64),
        releaseSha256:(role.slot==='9222'?'5':'6').repeat(64)};
    }
    return o;
  };
  const finalized=await prepareGptQueueOwnerBinding({...f.options,
    currentIssuer:true,priorReceiptPath:first.receiptPath,
    priorReceiptSha256:first.receiptSha256,finalizeRetainedTargets:true,
    installedConfigFile,installedConfigSha256:hash(fs.readFileSync(installedConfigFile)),
    inspectTarget,releaseTarget:async(req,role,sha)=>{
      assert.equal(sha,f.requestSha256);calls++;retained.add(role.slot);
      return {slot:role.slot,keepTarget:true,targetClosed:false};
    },issuerHelper:helper,powershellFile:f.options.nativeExecutable});
  assert.equal(calls,2);
  assert.equal(finalized.status,'ORIGINAL_QUEUE_TARGETS_RETAINED_SOURCE_ONLY');
  assert.equal(finalized.retainedTargetCount,2);assert.equal(finalized.filesWritten,0);
  assert.equal(finalized.bindingChanged,false);assert.equal(finalized.executionAuthorized,false);
  assert.deepEqual(files.map(p=>hash(fs.readFileSync(p))),hashes);
  assert.equal(fs.readdirSync(f.options.ownerDirectory).length,1);
});
test('G1 separate finalizer refuses wrong installed config and partial return without forging receipt',async t=>{
  const f=fixture(t),helper=path.join(f.owner,'Manage-CdpChromeSlotLease.ps1');
  const guard=path.join(f.owner,'Assert-CdpEndpointIdentity.ps1');
  fs.writeFileSync(helper,'SYNTHETIC-NOT-EXECUTED');fs.writeFileSync(guard,'SYNTHETIC-NOT-EXECUTED');
  const first=await prepareGptQueueOwnerBinding({...f.options,currentIssuer:true,
    issuerHelper:helper,powershellFile:f.options.nativeExecutable});
  const configFile=path.join(f.owner,'installed-current-config.json');
  fs.writeFileSync(configFile,JSON.stringify({gptQueue:{enabled:true,
    bindingFile:first.bindingPath,bindingSha256:'0'.repeat(64)}}));
  const opts={...f.options,currentIssuer:true,
    priorReceiptPath:first.receiptPath,priorReceiptSha256:first.receiptSha256,
    finalizeRetainedTargets:true,installedConfigFile:configFile,
    installedConfigSha256:hash(fs.readFileSync(configFile)),
    releaseTarget:async()=>{throw Error('MUST_NOT_RELEASE_UNINSTALLED_OWNER');}};
  await assert.rejects(prepareGptQueueOwnerBinding(opts),/HOLD_QUEUE_RETENTION_REGISTERED_CONFIG_MISMATCH/);
  fs.writeFileSync(configFile,JSON.stringify({gptQueue:{enabled:true,
    bindingFile:first.bindingPath,bindingSha256:first.bindingSha256}}));
  let calls=0;
  await assert.rejects(prepareGptQueueOwnerBinding({...opts,
    installedConfigSha256:hash(fs.readFileSync(configFile)),
    releaseTarget:async(_req,role)=>{
      calls++;
      if(calls===2)throw Error('HOLD_TEST_SECOND_RELEASE_UNKNOWN');
      return {slot:role.slot,keepTarget:true,targetClosed:false};
    }}),/HOLD_TEST_SECOND_RELEASE_UNKNOWN/);
  assert.equal(calls,2);assert.equal(fs.readdirSync(f.options.ownerDirectory).length,1);
});
test('G1 old source cannot manufacture retained history from an untrusted claim',t=>{
  const f=fixture(t),retained=f.observation(f.request,f.roles[0],f.requestSha256);
  retained.status='verified_retained_owner_target';
  retained.proof.state='OWNER_KEEP_TARGET_RETAINED';
  assert.throws(()=>validateIssuerObservation(retained,f.request,f.roles[0],f.requestSha256,f.now),
    /HOLD_ORIGINAL_ISSUER_RETAINED_HISTORY_UNPROVEN/);
});

test('G1 current issuer observation refuses missing history, foreign, closed and stale targets without writes',async t=>{
  for(const mutation of ['missing','foreign','closed','slow-second','unknown']){
    const f=fixture(t),first=await prepareGptQueueOwnerBinding(f.options);
    let now=f.now,inspections=0;
    const options={...f.options,priorReceiptPath:first.receiptPath,
      priorReceiptSha256:first.receiptSha256,verifyCurrentOnly:true,now:()=>now,
      inspectTarget:async(req,role,sha)=>{inspections++;
        if(mutation==='unknown')throw Error('ISSUER_UNAVAILABLE');
        const o=f.observation(req,role,sha);
        if(mutation==='foreign')o.proof.ownerId='foreign-owner';
        if(mutation==='closed')o.proof.state='CLOSED';
        if(mutation==='slow-second'&&inspections===2){now+=180000;
          o.proof.observedAt=new Date(now-1000).toISOString();
          o.proof.expiresAt=new Date(now+60000).toISOString();}
        return o;}};
    if(mutation==='missing')delete options.priorReceiptPath;
    await assert.rejects(prepareGptQueueOwnerBinding(options),/HOLD_CURRENT_|HOLD_ORIGINAL_ISSUER_|ISSUER_UNAVAILABLE/,mutation);
    assert.equal(fs.readdirSync(f.options.ownerDirectory).length,1);
    assert.equal(hash(fs.readFileSync(first.bindingPath)),first.bindingSha256);
  }
});

test('G1 real Chrome uppercase target identity remains exact while lease tokens stay lowercase',async t=>{
  const f=fixture(t);
  f.request.roles[0].targetId='ABCDEF0123456789ABCDEF0123456789';
  fs.writeFileSync(f.options.requestPath,JSON.stringify(f.request));
  f.options.requestSha256=hash(fs.readFileSync(f.options.requestPath));
  const out=await prepareGptQueueOwnerBinding(f.options);
  const binding=JSON.parse(fs.readFileSync(out.bindingPath,'utf8'));
  assert.equal(binding.targets[0].targetId,f.request.roles[0].targetId);
  const different=f.observation(f.request,f.roles[0],f.options.requestSha256);
  different.proof.targetId=f.roles[0].targetId.toLowerCase();
  assert.throws(()=>validateIssuerObservation(different,f.request,f.roles[0],f.options.requestSha256,f.now),/HOLD_ORIGINAL_ISSUER_TARGET_PROOF_UNPROVEN/);
  const invalid=structuredClone(f.request);invalid.roles[0].leaseToken='A'.repeat(32);
  assert.throws(()=>validateOriginalQueueRequest(invalid,{alias:'queue-fixture',root:f.ws}),/HOLD_ORIGINAL_ROLE_INVALID/);
});

test('G1 original source SHA, wrong role and pending registry fail before proof creation',async t=>{
  const f=fixture(t),original=f.options;
  await assert.rejects(prepareGptQueueOwnerBinding({...original,requestSha256:'a'.repeat(64)}),
    /HOLD_SOURCE_SHA_CHANGED/);
  await assert.rejects(prepareGptQueueOwnerBinding({...original,registeredSlots:
    [{...original.registeredSlots[0],automaticLeaseEligible:false},original.registeredSlots[1]]}),
    /HOLD_REGISTERED_SLOT_ACCOUNT_MISMATCH/);
  await assert.rejects(prepareGptQueueOwnerBinding({...original,verifyRegistry:()=>false}),
    /HOLD_NATIVE_REGISTRY_UNPROVEN/);
  await assert.rejects(prepareGptQueueOwnerBinding({...original,inspectTarget:async(r,role,sha)=>{
    const proof=f.observation(r,role,sha);proof.proof.ownerId='different-owner';return proof;
  }}),/HOLD_ORIGINAL_ISSUER_TARGET_PROOF_UNPROVEN/);
  assert.equal(fs.existsSync(original.ownerDirectory),false);
});
test('G1 original exact requester, target nonce, duplicate role and expired issuer lease are rejected',async t=>{
  const f=fixture(t);
  const fake={...f.request,roles:[f.roles[0],{...f.roles[1],leaseToken:f.roles[0].leaseToken}]};
  assert.throws(()=>validateOriginalQueueRequest(fake,{alias:'queue-fixture',root:f.ws}),
    /HOLD_DUPLICATE_OWNER_ROLE/);
  const claim=f.observation(f.request,f.roles[0],f.requestSha256);
  claim.proof.targetNonce='f'.repeat(64);
  assert.throws(()=>validateIssuerObservation(claim,f.request,f.roles[0],f.requestSha256,f.now),
    /HOLD_ORIGINAL_ISSUER_TARGET_PROOF_UNPROVEN/);
  const expired=f.observation(f.request,f.roles[0],f.requestSha256);
  expired.proof.expiresAt=new Date(f.now-1).toISOString();
  assert.throws(()=>validateIssuerObservation(expired,f.request,f.roles[0],f.requestSha256,f.now),
    /HOLD_ORIGINAL_ISSUER_PROOF_STALE/);
});
test('G1 exact original prepare is create-once and preserves partial/finished receipts',async t=>{
  const f=fixture(t),first=await prepareGptQueueOwnerBinding(f.options);
  const before=fs.readFileSync(first.bindingPath);
  await assert.rejects(prepareGptQueueOwnerBinding(f.options),
    /HOLD_ORIGINAL_PREPARE_ALREADY_EXISTS_RECONCILE/);
  assert.deepEqual(fs.readFileSync(first.bindingPath),before);
  assert.equal(hash(fs.readFileSync(first.receiptPath)),first.receiptSha256);
});
test('G1 registry path, own root and original private ACL evidence are mandatory',async t=>{
  const f=fixture(t);
  await assert.rejects(prepareGptQueueOwnerBinding({...f.options,
    assertFile:()=>{throw Error('OWNER_ONLY_ACL_DENIED')}}),/OWNER_ONLY_ACL_DENIED/);
  await assert.rejects(prepareGptQueueOwnerBinding({...f.options,
    ownerDirectory:path.join(f.ws,'remote-owner')}),/HOLD_PRIVATE_OWNER_ROOT_INVALID/);
});

test('G1 original issuer refresh preserves expired immutable evidence and exact run identity',async t=>{
  const f=fixture(t),first=await prepareGptQueueOwnerBinding(f.options);
  const originalBinding=fs.readFileSync(first.bindingPath),originalReceipt=fs.readFileSync(first.receiptPath);
  const later=f.now+240000;
  let inspections=0;
  const options={...f.options,priorReceiptPath:first.receiptPath,priorReceiptSha256:first.receiptSha256,
    now:()=>later,inspectTarget:async(req,role,sha)=>{
      inspections++;const out=f.observation(req,role,sha);
      out.proof.observedAt=new Date(later-1000).toISOString();out.proof.expiresAt=new Date(later+60000).toISOString();return out;
    }};
  const refreshed=await prepareGptQueueOwnerBinding(options);
  assert.equal(inspections,2);assert.equal(refreshed.refreshed,true);assert.equal(refreshed.dispatched,false);
  assert.notEqual(first.receiptPath,refreshed.receiptPath);
  assert.deepEqual(fs.readFileSync(first.bindingPath),originalBinding);
  assert.deepEqual(fs.readFileSync(first.receiptPath),originalReceipt);
  const before=JSON.parse(originalBinding),after=JSON.parse(fs.readFileSync(refreshed.bindingPath));
  for(const key of ['bindingId','operationId','ownerId','originalRequestSha256','ownerIdentityHash','definitionSha256'])assert.equal(after[key],before[key]);
  const {createGptQueueExecutor}=await import('../components/workspace-mcp/gpt-queue-provider.mjs');
  const beforeConfig={surfaceProfile:'business-full',...JSON.parse(fs.readFileSync(first.overlayPath))};
  const afterConfig={surfaceProfile:'business-full',...JSON.parse(fs.readFileSync(refreshed.overlayPath))};
  const calls=[];let existingRun=null;
  const exchange=async(binding,message)=>{
    calls.push({runId:binding.runId,type:message.type});
    if(message.type==='orchestration_capabilities')return {ok:true,payload:{schemaVersion:1,pausedRegistration:true,revisionFencedCancel:true,ownerBoundActivation:true}};
    assert.equal(message.type,'orchestration_get','refresh may not create, activate or dispatch');
    return existingRun?{ok:true,payload:{revision:3,run:{id:binding.runId,...existingRun}}}:{ok:false,error:'WEBGPT_ORCHESTRATION_RUN_NOT_FOUND'};
  };
  const old=createGptQueueExecutor(beforeConfig,{verifyRegistry:()=>true,now:()=>later,exchange});
  const current=createGptQueueExecutor(afterConfig,{verifyRegistry:()=>true,now:()=>later,exchange});
  const input={request_id:f.request.operationId,title:f.request.title,
    roles:f.roles.map(({id,slot,targetNonce,conversationId,prompt})=>({id,slot,targetNonce,conversationId,prompt}))};
  await assert.rejects(old.registerPaused({alias:f.request.workspaceAlias,root:f.ws},input),/QUEUE_TARGET_PROOF_STALE/);
  await old.get({alias:f.request.workspaceAlias,root:f.ws},f.request.operationId);
  await current.get({alias:f.request.workspaceAlias,root:f.ws},f.request.operationId);
  assert.equal(calls[0].runId,calls[1].runId);
  assert.equal(calls.every(x=>x.type==='orchestration_get'),true);
  const refreshedBinding=JSON.parse(fs.readFileSync(refreshed.bindingPath));
  existingRun={title:input.title,roles:input.roles,registrationOnly:true,paused:true,status:'paused',ownerBinding:{originalRequestSha256:refreshedBinding.originalRequestSha256,ownerIdentityHash:refreshedBinding.ownerIdentityHash,definitionSha256:refreshedBinding.definitionSha256}};
  const reconciled=await current.registerPaused({alias:f.request.workspaceAlias,root:f.ws},input);
  assert.equal(reconciled.registration,'EXISTING_NOT_RESENT');
  assert.equal(calls.some(x=>['orchestration_create','orchestration_activate'].includes(x.type)),false);
  const expiredAgain=createGptQueueExecutor(afterConfig,{verifyRegistry:()=>true,now:()=>later+240000,exchange});
  await assert.rejects(expiredAgain.registerPaused({alias:f.request.workspaceAlias,root:f.ws},input),/QUEUE_TARGET_PROOF_STALE/);
  await assert.rejects(prepareGptQueueOwnerBinding(options),/HOLD_ORIGINAL_PREPARE_ALREADY_EXISTS_RECONCILE/);
});

test('G1 refresh refuses substituted history, request, installed native and live account identity',async t=>{
  for(const mutation of ['receipt-sha','request','native','proof','live-identity','issuer-unavailable']){
    const f=fixture(t),first=await prepareGptQueueOwnerBinding(f.options);
    const receiptBytes=fs.readFileSync(first.receiptPath),bindingBytes=fs.readFileSync(first.bindingPath);
    let inspections=0;
    const opts={...f.options,priorReceiptPath:first.receiptPath,priorReceiptSha256:first.receiptSha256,
      inspectTarget:async(req,role,sha)=>{inspections++;if(mutation==='issuer-unavailable')throw Error('ISSUER_UNAVAILABLE');
        const out=f.observation(req,role,sha);if(mutation==='live-identity')out.proof.accountIdentityHash='f'.repeat(64);return out;}};
    if(mutation==='receipt-sha')opts.priorReceiptSha256='f'.repeat(64);
    if(mutation==='request'){f.request.title='different';fs.writeFileSync(opts.requestPath,JSON.stringify(f.request));opts.requestSha256=hash(fs.readFileSync(opts.requestPath));}
    if(mutation==='native')fs.writeFileSync(opts.nativeExecutable,'DIFFERENT_NATIVE');
    if(mutation==='proof'){const b=JSON.parse(bindingBytes);fs.writeFileSync(b.targets[0].proofFile,'changed');}
    await assert.rejects(prepareGptQueueOwnerBinding(opts),/HOLD_SOURCE_SHA_CHANGED|HOLD_REFRESH_|ISSUER_UNAVAILABLE/,mutation);
    assert.deepEqual(fs.readFileSync(first.receiptPath),receiptBytes);
    assert.deepEqual(fs.readFileSync(first.bindingPath),bindingBytes);
    assert.equal(fs.readdirSync(opts.ownerDirectory).length,1);
    if(['receipt-sha','request','native','proof'].includes(mutation))assert.equal(inspections,0);
  }
});

test('G1 refreshed owner proof reconciles one real native paused run across process restarts',{
  skip:process.platform!=='win32'||!process.env.AICC_GPT_QUEUE_NATIVE_PROGRAM
},async t=>{
  const f=fixture(t);
  const compiler='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const compiled=spawnSync(compiler,['/nologo','/optimize+','/target:exe','/out:'+f.options.nativeExecutable,
    process.env.AICC_GPT_QUEUE_NATIVE_PROGRAM,'/r:System.Web.Extensions.dll'],{encoding:'utf8',timeout:20000,windowsHide:true});
  assert.equal(compiled.status,0,compiled.stderr||compiled.stdout);
  const {createGptQueueExecutor,nativeGptQueueExchange}=await import('../components/workspace-mcp/gpt-queue-provider.mjs');
  const first=await prepareGptQueueOwnerBinding(f.options);
  const workspace={alias:f.request.workspaceAlias,root:f.ws};
  const input={request_id:f.request.operationId,title:f.request.title,
    roles:f.roles.map(({id,slot,targetNonce,conversationId,prompt})=>({id,slot,targetNonce,conversationId,prompt}))};
  let creates=0,activates=0;
  const exchange=async(binding,message)=>{if(message.type==='orchestration_create')creates++;
    if(message.type==='orchestration_activate')activates++;return nativeGptQueueExchange(binding,message);};
  const executor=(receipt,now)=>createGptQueueExecutor({surfaceProfile:'business-full',
    ...JSON.parse(fs.readFileSync(receipt.overlayPath))},{verifyRegistry:()=>true,now:()=>now,exchange});
  const registered=await executor(first,f.now).registerPaused(workspace,input);
  const later=f.now+240000;
  const refreshed=await prepareGptQueueOwnerBinding({...f.options,priorReceiptPath:first.receiptPath,
    priorReceiptSha256:first.receiptSha256,now:()=>later,inspectTarget:async(req,role,sha)=>{
      const out=f.observation(req,role,sha);out.proof.observedAt=new Date(later-1000).toISOString();
      out.proof.expiresAt=new Date(later+60000).toISOString();return out;}});
  const reconciled=await executor(refreshed,later).registerPaused(workspace,input);
  assert.equal(reconciled.registration,'EXISTING_NOT_RESENT');
  assert.equal(reconciled.revision,registered.revision);assert.equal(reconciled.dispatchState,'NOT_DISPATCHED');
  assert.equal(creates,1);assert.equal(activates,0);
  const cancelled=await executor(refreshed,later).cancel(workspace,{operation_id:f.request.operationId,request_id:'refresh-cancel-001'});
  assert.equal(cancelled.cancel,'CANCELLED_UNSENT');assert.equal(creates,1);
});

function replacementOptions(f,first,overrides={}){
  const replacement=structuredClone(f.request);
  for(let i=0;i<2;i++){
    replacement.roles[i].targetId=(i?'D':'C').repeat(32);
    replacement.roles[i].targetNonce=(i?'d':'c').repeat(64);
    replacement.roles[i].leaseToken=(i?'4':'3').repeat(32);
  }
  const requestPath=path.join(f.owner,'replacement.json');
  fs.writeFileSync(requestPath,JSON.stringify(replacement));
  const calls=[];
  return {replacement,calls,options:{...f.options,requestPath,
    requestSha256:hash(fs.readFileSync(requestPath)),
    priorReceiptPath:first.receiptPath,priorReceiptSha256:first.receiptSha256,
    rebindFromRequestPath:f.options.requestPath,rebindFromRequestSha256:f.requestSha256,
    exchange:async(b,message)=>{calls.push(message);return {ok:false,error:'WEBGPT_ORCHESTRATION_RUN_NOT_FOUND'};},
    ...overrides}};
}

test('G1 new owner targets can prepare the same unregistered task without native mutation or old evidence edits',async t=>{
  const f=fixture(t),first=await prepareGptQueueOwnerBinding(f.options);
  const old=fs.readFileSync(first.bindingPath),request=fs.readFileSync(f.options.requestPath);
  const r=replacementOptions(f,first),next=await prepareGptQueueOwnerBinding(r.options);
  assert.equal(next.rebound,true);assert.equal(next.nativeWrites,0);assert.equal(next.dispatched,false);
  assert.equal(r.calls.length,2);assert.equal(r.calls.every(x=>x.type==='orchestration_get'),true);
  assert.equal(r.calls[0].runId,r.calls[1].runId);
  const before=JSON.parse(old),after=JSON.parse(fs.readFileSync(next.bindingPath));
  assert.equal(before.bindingId,after.bindingId);assert.equal(before.operationId,after.operationId);
  assert.notEqual(before.originalRequestSha256,after.originalRequestSha256);
  assert.notEqual(before.definitionSha256,after.definitionSha256);
  assert.equal(after.targets[0].targetId,'C'.repeat(32));
  assert.deepEqual(fs.readFileSync(first.bindingPath),old);
  assert.deepEqual(fs.readFileSync(f.options.requestPath),request);
});

test('G1 explicit helper upgrade creates exact new sibling generation without touching old owner or Native',async t=>{
 const f=fixture(t),oldDir=path.join(f.owner,'old-issuer');fs.mkdirSync(oldDir);
 const oldHelper=path.join(oldDir,'Manage-CdpChromeSlotLease.ps1');
 const oldGuard=path.join(oldDir,'Assert-CdpEndpointIdentity.ps1');
 fs.writeFileSync(oldHelper,'param([string]$Action)\n# synthetic legacy helper\n');
 fs.writeFileSync(oldGuard,'# synthetic legacy identity guard\n');
 const first=await prepareGptQueueOwnerBinding({...f.options,currentIssuer:true,
   issuerHelper:oldHelper,powershellFile:f.options.nativeExecutable});
 const before=fs.readFileSync(first.bindingPath),oldReceipt=fs.readFileSync(first.receiptPath);
 const r=replacementOptions(f,first,{currentIssuer:true,powershellFile:f.options.nativeExecutable});
 const newDir=path.join(f.owner,'new-issuer');fs.mkdirSync(newDir);
 const helperSource=path.resolve('tools/platform/web-automation/Manage-CdpChromeSlotLease.ps1');
 const guardSource=path.resolve('tools/platform/web-automation/Assert-CdpEndpointIdentity.ps1');
 const newHelper=path.join(newDir,'Manage-CdpChromeSlotLease.ps1');
 const newGuard=path.join(newDir,'Assert-CdpEndpointIdentity.ps1');
 fs.copyFileSync(helperSource,newHelper);fs.copyFileSync(guardSource,newGuard);
 Object.assign(r.options,{issuerHelper:newHelper,upgradeIssuerHelper:true,
   expectedPriorIssuerHelperSha256:hash(fs.readFileSync(oldHelper)),
   expectedNextIssuerHelperSha256:hash(fs.readFileSync(helperSource)),
   expectedNextIssuerGuardSha256:hash(fs.readFileSync(guardSource))});
 const next=await prepareGptQueueOwnerBinding(r.options);
 assert.equal(next.rebound,true);assert.equal(next.nativeWrites,0);
 assert.equal(next.dispatched,false);assert.equal(r.calls.length,2);
 assert.equal(r.calls.every(x=>x.type==='orchestration_get'),true);
 assert.deepEqual(fs.readFileSync(first.bindingPath),before);
 assert.deepEqual(fs.readFileSync(first.receiptPath),oldReceipt);
 const b=JSON.parse(fs.readFileSync(next.bindingPath));
 const prepared=JSON.parse(fs.readFileSync(next.receiptPath));
 assert.equal(b.operationId,f.request.operationId);
 assert.equal(b.ownerId,f.request.ownerId);
 assert.equal(b.targetLifecycle,'queue-owner-keep-target-before-registration/v1');
 assert.equal(b.currentIssuer.helperSha256,hash(fs.readFileSync(helperSource)));
 assert.equal(b.currentIssuer.identityGuardSha256,hash(fs.readFileSync(guardSource)));
 assert.equal(b.issuerHelperUpgrade.previousHelperSha256,hash(fs.readFileSync(oldHelper)));
 assert.deepEqual(prepared.issuerHelperUpgrade,b.issuerHelperUpgrade);
 assert.equal(b.issuerHelperUpgrade.sourceHelperFile,helperSource);
 assert.equal(b.issuerHelperUpgrade.sourceGuardFile,guardSource);
 assert.equal(JSON.stringify(prepared).includes(f.roles[0].leaseToken),false);
 assert.equal(JSON.stringify(prepared).includes(f.roles[0].prompt),false);
 await assert.rejects(prepareGptQueueOwnerBinding(r.options),
   /HOLD_ORIGINAL_PREPARE_ALREADY_EXISTS_RECONCILE/);
});
test('G1 explicit helper upgrade refuses missing authority, source drift, altered guard or Native registered run',async t=>{
 for(const mode of ['no-opt-in','old-sha','helper-sha','guard-sha','altered-helper','altered-guard','native-exists']){
  const f=fixture(t),oldDir=path.join(f.owner,'old');fs.mkdirSync(oldDir);
  const oldHelper=path.join(oldDir,'Manage-CdpChromeSlotLease.ps1');
  fs.writeFileSync(oldHelper,'param([string]$Action)\n# legacy helper\n');
  fs.writeFileSync(path.join(oldDir,'Assert-CdpEndpointIdentity.ps1'),'# old guard');
  const first=await prepareGptQueueOwnerBinding({...f.options,currentIssuer:true,
    issuerHelper:oldHelper,powershellFile:f.options.nativeExecutable});
  const r=replacementOptions(f,first,{currentIssuer:true,powershellFile:f.options.nativeExecutable});
  const dir=path.join(f.owner,'new');fs.mkdirSync(dir);
  const src=path.resolve('tools/platform/web-automation/Manage-CdpChromeSlotLease.ps1');
  const sourceGuard=path.resolve('tools/platform/web-automation/Assert-CdpEndpointIdentity.ps1');
  const helper=path.join(dir,'Manage-CdpChromeSlotLease.ps1');
  const guard=path.join(dir,'Assert-CdpEndpointIdentity.ps1');
  fs.copyFileSync(src,helper);fs.copyFileSync(sourceGuard,guard);
  Object.assign(r.options,{issuerHelper:helper,upgradeIssuerHelper:true,
    expectedPriorIssuerHelperSha256:hash(fs.readFileSync(oldHelper)),
    expectedNextIssuerHelperSha256:hash(fs.readFileSync(src)),
    expectedNextIssuerGuardSha256:hash(fs.readFileSync(sourceGuard))});
  if(mode==='no-opt-in')r.options.upgradeIssuerHelper=false;
  if(mode==='old-sha')r.options.expectedPriorIssuerHelperSha256='0'.repeat(64);
  if(mode==='helper-sha')r.options.expectedNextIssuerHelperSha256='0'.repeat(64);
  if(mode==='guard-sha')r.options.expectedNextIssuerGuardSha256='0'.repeat(64);
  if(mode==='altered-helper')fs.appendFileSync(helper,'\n# unreviewed bytes');
  if(mode==='altered-guard')fs.appendFileSync(guard,'\n# unreviewed bytes');
  if(mode==='native-exists')r.options.exchange=async(_b,msg)=>{
    r.calls.push(msg);return {ok:true,payload:{status:'paused'}};
  };
  await assert.rejects(prepareGptQueueOwnerBinding(r.options),
    /HOLD_ISSUER_HELPER_|HOLD_REBIND_EXISTING_RUN_RECONCILE/,mode);
  assert.equal(fs.readdirSync(f.options.ownerDirectory).length,1,mode);
  assert.equal(hash(fs.readFileSync(first.receiptPath)),first.receiptSha256,mode);
 }
});
test('G1 rebind rejects changed task, existing or unknown native run, identity change and concurrent registration',async t=>{
  for(const mutation of ['prompt','account','owner','native-existing','native-unknown','native-throw','race','live-identity','stale']){
    const f=fixture(t),first=await prepareGptQueueOwnerBinding(f.options);
    const r=replacementOptions(f,first);let reads=0,inspections=0;
    r.options.exchange=async()=>{
      reads++;
      if(mutation==='native-throw')throw Error('transport lost');
      if(mutation==='native-existing'||mutation==='race'&&reads===2)return {ok:true,payload:{}};
      if(mutation==='native-unknown')return {ok:false,error:'TRANSPORT_UNKNOWN'};
      if(mutation==='stale'&&reads===2)r.options.now=()=>f.now+240000;
      return {ok:false,error:'WEBGPT_ORCHESTRATION_RUN_NOT_FOUND'};
    };
    r.options.inspectTarget=async(...args)=>{inspections++;const out=f.observation(...args);
      if(mutation==='live-identity')out.proof.accountIdentityHash='f'.repeat(64);return out;};
    if(mutation==='prompt')r.replacement.roles[0].prompt+=' changed';
    if(mutation==='account')r.replacement.roles[0].accountAlias='other';
    if(mutation==='owner')r.replacement.ownerId='different-owner';
    if(['prompt','account','owner'].includes(mutation)){
      fs.writeFileSync(r.options.requestPath,JSON.stringify(r.replacement));
      r.options.requestSha256=hash(fs.readFileSync(r.options.requestPath));
    }
    await assert.rejects(prepareGptQueueOwnerBinding(r.options),/HOLD_REBIND_|HOLD_REFRESH_LIVE_IDENTITY_CHANGED|HOLD_ORIGINAL_ISSUER_PROOF_STALE/,mutation);
    assert.equal(fs.readdirSync(f.options.ownerDirectory).length,1,mutation);
    assert.equal(hash(fs.readFileSync(first.receiptPath)),first.receiptSha256);
    if(['prompt','account','owner','native-existing','native-unknown','native-throw'].includes(mutation))assert.equal(inspections,0,mutation);
  }
});

test('G1 unregistered target rebind uses real native lookup and rejects an existing paused run',{
  skip:process.platform!=='win32'||!process.env.AICC_GPT_QUEUE_NATIVE_PROGRAM
},async t=>{
  const f=fixture(t);
  const compiled=spawnSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    ['/nologo','/optimize+','/target:exe','/out:'+f.options.nativeExecutable,
      process.env.AICC_GPT_QUEUE_NATIVE_PROGRAM,'/r:System.Web.Extensions.dll'],
    {encoding:'utf8',timeout:20000,windowsHide:true});
  assert.equal(compiled.status,0,compiled.stderr||compiled.stdout);
  const {createGptQueueExecutor}=await import('../components/workspace-mcp/gpt-queue-provider.mjs');
  const first=await prepareGptQueueOwnerBinding(f.options);
  const r=replacementOptions(f,first,{exchange:undefined});
  const next=await prepareGptQueueOwnerBinding(r.options);
  assert.equal(next.rebound,true);
  const provider=createGptQueueExecutor({surfaceProfile:'business-full',
    ...JSON.parse(fs.readFileSync(next.overlayPath))},{verifyRegistry:()=>true,now:()=>f.now});
  const workspace={alias:f.request.workspaceAlias,root:f.ws};
  const registered=await provider.registerPaused(workspace,{request_id:f.request.operationId,title:f.request.title,
    roles:r.replacement.roles.map(({id,slot,targetNonce,conversationId,prompt})=>({id,slot,targetNonce,conversationId,prompt}))});
  assert.equal(registered.registration,'REGISTERED_PAUSED');
  await assert.rejects(prepareGptQueueOwnerBinding(r.options),/HOLD_REBIND_EXISTING_RUN_RECONCILE/);
  const cancelled=await provider.cancel(workspace,{operation_id:f.request.operationId,request_id:'cancel-rebind-001'});
  assert.equal(cancelled.cancel,'CANCELLED_UNSENT');
});

test('G1 slow second issuer inspection cannot publish an expired first proof generation',async t=>{
  const f=fixture(t),first=await prepareGptQueueOwnerBinding(f.options);let clock=f.now;
  await assert.rejects(prepareGptQueueOwnerBinding({...f.options,priorReceiptPath:first.receiptPath,
    priorReceiptSha256:first.receiptSha256,now:()=>clock,inspectTarget:async(req,role,sha)=>{
      const out=f.observation(req,role,sha);
      if(role.slot==='9223'){clock+=240000;out.proof.observedAt=new Date(clock-1000).toISOString();out.proof.expiresAt=new Date(clock+60000).toISOString();}
      return out;
    }}),/HOLD_ORIGINAL_ISSUER_PROOF_STALE/);
  assert.equal(fs.readdirSync(f.options.ownerDirectory).length,1);
  assert.equal(hash(fs.readFileSync(first.receiptPath)),first.receiptSha256);
});

test('G1 privately prepared issuer proof is consumed by the existing business-full native provider',async t=>{
  const f=fixture(t),prepared=await prepareGptQueueOwnerBinding(f.options);
  const {createGptQueueExecutor}=await import('../components/workspace-mcp/gpt-queue-provider.mjs');
  const overlay=JSON.parse(fs.readFileSync(prepared.overlayPath,'utf8'));
  let run=null,revision=0,createCalls=0;
  const native=async(_binding,message)=>{
    if(message.type==='orchestration_capabilities')
      return {ok:true,payload:{schemaVersion:1,pausedRegistration:true,revisionFencedCancel:true,ownerBoundActivation:true}};
    if(message.type==='orchestration_get')
      return run?{ok:true,payload:{revision,run}}:
        {ok:false,error:'WEBGPT_ORCHESTRATION_RUN_NOT_FOUND'};
    if(message.type==='orchestration_create'){
      createCalls++;
      run={...message.definition,registrationOnly:true,paused:true,status:'paused',
        roles:message.definition.roles.map((role,i)=>({...role,status:i===0?'ready':'blocked'}))};
      revision++;
      return {ok:true,payload:{revision,status:'created',run}};
    }
    if(message.type==='orchestration_control'&&message.action==='cancel'){
      if(message.expectedRevision!==revision)
        return {ok:false,error:'WEBGPT_ORCHESTRATION_REVISION_STALE'};
      run.status='cancelled';run.paused=true;
      for(const role of run.roles)role.status='cancelled';
      revision++;
      return {ok:true,payload:{revision,status:'cancel',run}};
    }
    throw Error('UNEXPECTED_NATIVE_REQUEST');
  };
  const executor=createGptQueueExecutor({surfaceProfile:'business-full',...overlay},
    {exchange:native,verifyRegistry:()=>true,now:()=>f.now});
  const workspace={alias:f.request.workspaceAlias,root:f.ws};
  const roles=f.roles.map(role=>({id:role.id,slot:role.slot,targetNonce:role.targetNonce,
    conversationId:role.conversationId,prompt:role.prompt}));
  const created=await executor.registerPaused(workspace,{
    request_id:f.request.operationId,title:f.request.title,roles});
  assert.equal(created.registration,'REGISTERED_PAUSED');
  assert.equal(created.dispatchState,'NOT_DISPATCHED');
  assert.equal((await executor.get(workspace,f.request.operationId)).status,'paused');
  const cancelled=await executor.cancel(workspace,{
    operation_id:f.request.operationId,request_id:'original-owner-cancel-001'});
  assert.equal(cancelled.cancel,'CANCELLED_UNSENT');
  assert.equal((await executor.get(workspace,f.request.operationId)).status,'cancelled');
  assert.equal(createCalls,1);
});
