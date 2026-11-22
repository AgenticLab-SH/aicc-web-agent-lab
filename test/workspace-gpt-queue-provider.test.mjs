import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createWorkspaceMcpServer} from '../components/workspace-mcp/server.mjs';
import {createGptQueueExecutor,nativeGptQueueExchange} from '../components/workspace-mcp/gpt-queue-provider.mjs';
import {workspaceToolSnapshot} from '../components/workspace-mcp/tool-manifest.mjs';

const hash=v=>createHash('sha256').update(v).digest('hex');
const stored=(file,v)=>{fs.writeFileSync(file,typeof v==='string'?v:JSON.stringify(v));return file;};
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-owner-queue-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workspace={alias:'chatgpt-queue-fixture',root:path.join(root,'workspace')};
  const owner=path.join(root,'owner'),archive=path.join(owner,'archive');
  fs.mkdirSync(workspace.root);fs.mkdirSync(owner);fs.mkdirSync(archive);
  const executable=stored(path.join(owner,'queue-host.exe'),'SYNTHETIC_PROBE_EXECUTABLE');
  const nativeConfig=stored(path.join(owner,'native-host.config.json'),{baseDirectory:archive});
  const nativeManifest=stored(path.join(owner,'com.agenticfabworks.webgpt_queue.json'),{
    name:'com.agenticfabworks.webgpt_queue',path:executable,type:'stdio',
    allowed_origins:['chrome-extension://'+'a'.repeat(32)+'/']});
  const operationId='original-g1-request-001',bindingId='owner-g1-binding-001',now=Date.now();
  const ownerId='original-owner-001',originalRequestSha256='d'.repeat(64);
  const title='isolated work';
  const roles=[{id:'owner-role-one',slot:'9222',targetNonce:'a'.repeat(64),
    conversationId:'conversation-a-0001',prompt:'fake alpha'},
    {id:'owner-role-two',slot:'9223',targetNonce:'b'.repeat(64),
      conversationId:'conversation-b-0002',prompt:'fake beta'}];
  const targets=roles.map((role,i)=>{
    const targetId=(i===0?'a':'b').repeat(32);
    const accountAlias=i===0?'fake-one':'fake-two';
    const browserWorkspace='ordinary';
    const accountIdentityHash=(i===0?'1':'2').repeat(64);
    const workspaceIdentityHash='3'.repeat(64),originalLeaseSha256='f'.repeat(64);
    const proof=stored(path.join(owner,'proof-'+i+'.json'),{
      schemaVersion:1,kind:'aicc-queue-exact-target-proof',bindingId,ownerId,
      ownerIdentityHash:'e'.repeat(64),originalRequestSha256,
      roleId:role.id,slot:role.slot,targetId,accountAlias,browserWorkspace,
      accountIdentityHash,workspaceIdentityHash,registrationSha256:'9'.repeat(64),
      targetNonce:role.targetNonce,conversationId:role.conversationId,
      originalLeaseSha256,state:'OWNED_ACTIVE',
      observedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+120000).toISOString()
    });
    return {roleId:role.id,slot:role.slot,targetId,accountAlias,browserWorkspace,
      accountIdentityHash,workspaceIdentityHash,originalLeaseSha256,
      targetNonce:role.targetNonce,conversationId:role.conversationId,
      proofFile:proof,proofSha256:hash(fs.readFileSync(proof))};
  });
  const binding={schemaVersion:1,kind:'aicc-gpt-queue-owner-binding',
    bindingId,operationId,ownerId,originalRequestSha256,ownerIdentityHash:'e'.repeat(64),
    workspaceAlias:workspace.alias,workspaceRoot:workspace.root,
    nativeExecutable:executable,nativeExecutableSha256:hash(fs.readFileSync(executable)),
    nativeConfig,nativeConfigSha256:hash(fs.readFileSync(nativeConfig)),
    nativeManifest,nativeManifestSha256:hash(fs.readFileSync(nativeManifest)),
    baseDirectory:archive,definitionSha256:hash(JSON.stringify({title,roles})),targets};
  const bindingFile=path.join(owner,'binding.json');
  const config={surfaceProfile:'business-full',gptQueue:{enabled:true,bindingFile,bindingSha256:''}};
  const refresh=()=>{stored(bindingFile,binding);config.gptQueue.bindingSha256=hash(fs.readFileSync(bindingFile));};
  refresh();
  return {root,workspace,owner,archive,now,title,roles,operationId,config,binding,refresh,executable};
}
function simulatedNative(){
  const state={revision:0,runs:new Map(),calls:[],dispatch:0};
  async function exchange(_binding,m){
    state.calls.push(m.type);
    const success=payload=>({ok:true,payload});
    const no=error=>({ok:false,error});
    if(m.type==='orchestration_capabilities')
      return success({schemaVersion:1,pausedRegistration:true,revisionFencedCancel:true,ownerBoundActivation:true});
    if(m.type==='orchestration_get'){
      const run=state.runs.get(m.runId);
      return run?success({revision:state.revision,run}):no('WEBGPT_ORCHESTRATION_RUN_NOT_FOUND');
    }
    if(m.type==='orchestration_list')
      return success({revision:state.revision,runs:[...state.runs.values()]});
    if(m.type==='orchestration_create'){
      const d=m.definition;
      if(state.runs.has(d.id))return success({status:'existing',revision:state.revision,run:state.runs.get(d.id)});
      if(d.startPaused!==true)throw Error('SYNTHETIC_DISPATCHABLE_REGISTER');
      const run={...d,registrationOnly:true,status:'paused',paused:true,
        roles:d.roles.map((r,i)=>({...r,status:i===0?'ready':'blocked'}))};
      state.runs.set(d.id,run);state.revision++;
      return success({status:'created',revision:state.revision,run});
    }
    if(m.type==='orchestration_control'){
      if(m.action!=='cancel')throw Error('UNSUPPORTED_NATIVE_ACTION');
      if(m.expectedRevision!==state.revision)return no('WEBGPT_ORCHESTRATION_REVISION_STALE');
      const run=state.runs.get(m.runId);
      run.status='cancelled';run.paused=true;
      for(const role of run.roles)role.status='cancelled';
      state.revision++;return success({status:'cancel',revision:state.revision,run});
    }
    if(m.type==='orchestration_activate'){
      const run=state.runs.get(m.runId);
      if(m.expectedRevision!==state.revision)return no('WEBGPT_ORCHESTRATION_REVISION_STALE');
      run.activationRequestId=m.activationRequestId;run.executionAuthorized=true;run.status='running';run.paused=false;
      state.revision++;return success({status:'activated',revision:state.revision,run});
    }
    throw Error('NO_ARBITRARY_NATIVE_ACTION');
  }
  return {state,exchange};
}
function currentIssuerFixture(f){
  const helper=stored(path.join(f.owner,'Manage-CdpChromeSlotLease.ps1'),'SYNTHETIC-NEVER-EXECUTED');
  const guard=stored(path.join(f.owner,'Assert-CdpEndpointIdentity.ps1'),'SYNTHETIC-NEVER-EXECUTED');
  const powershell=stored(path.join(f.owner,'pwsh.exe'),'SYNTHETIC-NEVER-EXECUTED');
  const roles=f.roles.map((role,i)=>{
    const t=f.binding.targets[i],leaseToken=String(i+1).repeat(32);
    t.originalLeaseSha256=hash(leaseToken);
    const proof=JSON.parse(fs.readFileSync(t.proofFile));proof.originalLeaseSha256=t.originalLeaseSha256;
    stored(t.proofFile,proof);t.proofSha256=hash(fs.readFileSync(t.proofFile));
    return {...role,targetId:t.targetId,accountAlias:t.accountAlias,browserWorkspace:t.browserWorkspace,leaseToken};
  });
  const request={schemaVersion:1,kind:'aicc-gpt-queue-original-owner-request',
    bindingId:f.binding.bindingId,operationId:f.operationId,ownerId:f.binding.ownerId,
    ownerIdentityHash:f.binding.ownerIdentityHash,workspaceAlias:f.workspace.alias,workspaceRoot:f.workspace.root,
    title:f.title,roles};
  const file=stored(path.join(f.owner,'original-request.json'),request);
  f.binding.originalRequestSha256=hash(fs.readFileSync(file));
  for(const t of f.binding.targets){const proof=JSON.parse(fs.readFileSync(t.proofFile));
    proof.originalRequestSha256=f.binding.originalRequestSha256;stored(t.proofFile,proof);
    t.proofSha256=hash(fs.readFileSync(t.proofFile));}
  f.binding.currentIssuer={kind:'registered-cdp-current-issuer/v1',requestFile:file,
    requestSha256:f.binding.originalRequestSha256,helperFile:helper,helperSha256:hash(fs.readFileSync(helper)),
    identityGuardFile:guard,identityGuardSha256:hash(fs.readFileSync(guard)),
    powershellFile:powershell,powershellSha256:hash(fs.readFileSync(powershell))};
  f.refresh();
  return {file,request,inspectTarget:async role=>{
    const t=f.binding.targets.find(t=>t.slot===role.slot);
    return {ok:true,status:'verified_active_owner_target',proof:{schemaVersion:1,
      kind:'aicc-cdp-queue-live-target-inspection',state:'OWNED_ACTIVE',
      ownerId:f.binding.ownerId,originalRequestSha256:f.binding.originalRequestSha256,
      workspaceAlias:t.browserWorkspace,...Object.fromEntries(['slot','targetId','targetNonce','conversationId',
        'accountAlias','originalLeaseSha256','accountIdentityHash','workspaceIdentityHash'].map(k=>[k,t[k]])),
      registrationSha256:'9'.repeat(64),observedAt:new Date(f.now-1000).toISOString(),
      expiresAt:new Date(f.now+60000).toISOString()}};
  }};
}

test('G1 installed current issuer contract permits expired historical pins only after fresh exact reads',async t=>{
  const f=fixture(t),n=simulatedNative(),c=currentIssuerFixture(f),before=fs.readFileSync(c.file);
  const later=f.now+600000;let reads=0;
  const e=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,assertPrivateFile:()=>true,
    now:()=>later,exchange:n.exchange,inspectTarget:async role=>{
      reads++;const out=await c.inspectTarget(role);out.proof.observedAt=new Date(later-1000).toISOString();
      out.proof.expiresAt=new Date(later+60000).toISOString();return out;}});
  const registered=await e.registerPaused(f.workspace,input(f));
  assert.equal(registered.registration,'REGISTERED_PAUSED');assert.equal(reads,4);
  const activated=await e.activate(f.workspace,{operation_id:f.operationId,request_id:'current-activation-001',expected_revision:registered.revision});
  assert.equal(activated.executionAuthorized,true);assert.equal(reads,8);
  assert.deepEqual(fs.readFileSync(c.file),before);assert.equal(n.state.dispatch,0);
});

test('G1 staged active binding is read-only acceptable but cannot register until both original KeepTarget returns are observed',async t=>{
  const f=fixture(t),n=simulatedNative(),c=currentIssuerFixture(f);
  f.binding.targetLifecycle='queue-owner-keep-target-before-registration/v1';
  f.refresh();
  let retained=new Set();
  const originalHashes=f.binding.targets.map(t=>hash(fs.readFileSync(t.proofFile)));
  const inspect=async role=>{
    const out=await c.inspectTarget(role);
    if(retained.has(role.slot)){
      out.status='verified_retained_owner_target';
      out.proof.state='OWNER_KEEP_TARGET_RETAINED';
      out.proof.retentionProof={kind:'aicc-queue-keep-target-release-history/v1',
        creationSha256:(role.slot==='9222'?'1':'2').repeat(64),
        releaseSha256:(role.slot==='9222'?'3':'4').repeat(64)};
    }
    return out;
  };
  const executor=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,
    assertPrivateFile:()=>true,exchange:n.exchange,now:()=>f.now,inspectTarget:inspect});
  await assert.rejects(executor.registerPaused(f.workspace,input(f)),
    error=>error.code==='QUEUE_CURRENT_ISSUER_KEEP_TARGET_REQUIRED');
  assert.equal(n.state.calls.includes('orchestration_create'),false);
  retained.add('9222');
  await assert.rejects(executor.registerPaused(f.workspace,input(f)),
    error=>error.code==='QUEUE_CURRENT_ISSUER_KEEP_TARGET_REQUIRED');
  retained.add('9223');
  const result=await executor.registerPaused(f.workspace,input(f));
  assert.equal(result.registration,'REGISTERED_PAUSED');assert.equal(result.paused,true);
  assert.equal(result.executionAuthorized,false);assert.equal(n.state.dispatch,0);
  assert.equal(n.state.calls.filter(x=>x==='orchestration_create').length,1);
  assert.deepEqual(f.binding.targets.map(t=>hash(fs.readFileSync(t.proofFile))),originalHashes);
});
test('G1 retained original KeepTarget issuer supports paused registration only with exact fresh sealed history, no dispatch',async t=>{
  const f=fixture(t),n=simulatedNative(),c=currentIssuerFixture(f);
  const chain=slot=>({kind:'aicc-queue-keep-target-release-history/v1',
    creationSha256:(slot==='9222'?'a':'b').repeat(64),
    releaseSha256:(slot==='9222'?'c':'d').repeat(64)});
  for(const t of f.binding.targets){
    const proof=JSON.parse(fs.readFileSync(t.proofFile,'utf8'));
    proof.state='OWNER_KEEP_TARGET_RETAINED';proof.retentionProof=chain(t.slot);
    stored(t.proofFile,proof);t.proofSha256=hash(fs.readFileSync(t.proofFile));
  }
  f.refresh();
  const inspect=async role=>{
    const out=await c.inspectTarget(role);
    out.status='verified_retained_owner_target';
    out.proof.state='OWNER_KEEP_TARGET_RETAINED';out.proof.retentionProof=chain(role.slot);
    return out;
  };
  const e=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,
    assertPrivateFile:()=>true,exchange:n.exchange,now:()=>f.now,inspectTarget:inspect});
  const registered=await e.registerPaused(f.workspace,input(f));
  assert.equal(registered.registration,'REGISTERED_PAUSED');
  assert.equal(registered.status,'paused');
  assert.equal(n.state.dispatch,0);
  assert.equal(n.state.calls.filter(x=>x==='orchestration_create').length,1);
  const missing=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,
    assertPrivateFile:()=>true,exchange:n.exchange,now:()=>f.now,inspectTarget:async role=>{
      const out=await inspect(role);delete out.proof.retentionProof;return out;}});
  await assert.rejects(missing.registerPaused(f.workspace,input(f)),
    /QUEUE_CURRENT_ISSUER_RETAINED_HISTORY_UNPROVEN/);
  const changed=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,
    assertPrivateFile:()=>true,exchange:n.exchange,now:()=>f.now,inspectTarget:async role=>{
      const out=await inspect(role);out.proof.retentionProof.releaseSha256='e'.repeat(64);return out;}});
  await assert.rejects(changed.registerPaused(f.workspace,input(f)),
    /QUEUE_CURRENT_ISSUER_RETAINED_HISTORY_UNPROVEN/);
  assert.equal(n.state.calls.filter(x=>x==='orchestration_create').length,1);
});
test('G1 creation-only history cannot be promoted to issuer authority by a caller assertion',async t=>{
  const f=fixture(t),n=simulatedNative(),c=currentIssuerFixture(f);
  const e=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,
    assertPrivateFile:()=>true,exchange:n.exchange,now:()=>f.now,
    inspectTarget:async _role=>({ok:false,status:'HOLD',
      holdCode:'HOLD_QUEUE_RETAINED_RELEASE_UNPROVEN'})});
  await assert.rejects(e.registerPaused(f.workspace,input(f)),
    error=>error.code==='QUEUE_CURRENT_ISSUER_LEASE_UNPROVEN');
  assert.equal(n.state.calls.includes('orchestration_create'),false);
});

test('G1 current issuer closed, changed identity, stale read, pin drift and missing private ACL refuse mutation',async t=>{
  for(const mutation of ['closed','identity','stale','helper','private','unavailable','slow-second','lost-before-create','request','private-definition']){
    const f=fixture(t),n=simulatedNative(),c=currentIssuerFixture(f);let reads=0,now=f.now;
    if(mutation==='helper')stored(f.binding.currentIssuer.helperFile,'changed');
    if(mutation==='request')stored(c.file,'changed');
    if(mutation==='private-definition'){
      c.request.title='substituted';stored(c.file,c.request);
      f.binding.originalRequestSha256=hash(fs.readFileSync(c.file));
      f.binding.currentIssuer.requestSha256=f.binding.originalRequestSha256;
      for(const target of f.binding.targets){const p=JSON.parse(fs.readFileSync(target.proofFile));
        p.originalRequestSha256=f.binding.originalRequestSha256;stored(target.proofFile,p);
        target.proofSha256=hash(fs.readFileSync(target.proofFile));}
      f.refresh();
    }
    const e=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,exchange:n.exchange,now:()=>now,
      assertPrivateFile:()=>{if(mutation==='private')throw Error('ACL');},inspectTarget:async role=>{
        reads++;if(mutation==='unavailable')throw Error('UNKNOWN');
        const out=await c.inspectTarget(role);
        if(mutation==='closed'||(mutation==='lost-before-create'&&reads>2))out.proof.state='CLOSED';
        if(mutation==='identity')out.proof.accountIdentityHash='0'.repeat(64);
        if(mutation==='stale')out.proof.expiresAt=new Date(now-1).toISOString();
        if(mutation==='slow-second'&&reads===2){now+=180000;out.proof.observedAt=new Date(now-1000).toISOString();out.proof.expiresAt=new Date(now+60000).toISOString();}
        return out;}});
    await assert.rejects(e.registerPaused(f.workspace,input(f)),/QUEUE_CURRENT_ISSUER_|QUEUE_PIN_CHANGED/,mutation);
    assert.equal(n.state.calls.includes('orchestration_create'),false,mutation);
    assert.equal(n.state.calls.includes('orchestration_activate'),false,mutation);
    assert.equal((await e.get(f.workspace,f.operationId)).status,'NOT_FOUND');
  }
});
function input(f){return {request_id:f.operationId,title:f.title,roles:f.roles};}
test('G1 registration refuses an installed host without owner activation before creating any run',async t=>{
  const f=fixture(t),n=simulatedNative();
  const exchange=async(b,m)=>m.type==='orchestration_capabilities'
    ?{ok:true,payload:{schemaVersion:1,pausedRegistration:true,revisionFencedCancel:true}}:n.exchange(b,m);
  const q=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,now:()=>f.now,exchange});
  await assert.rejects(q.registerPaused(f.workspace,input(f)),/QUEUE_OWNER_ACTIVATION_UNSUPPORTED/);
  assert.equal(n.state.calls.includes('orchestration_create'),false);assert.equal(n.state.runs.size,0);
});
test('G1 registration readback and existing runs must retain all three original owner pins',async t=>{
  for(const mutation of ['missing','changed','existing']){
    const f=fixture(t),n=simulatedNative();let creates=0;
    const exchange=async(b,m)=>{
      if(m.type==='orchestration_create')creates++;
      const out=await n.exchange(b,m);
      if(m.type==='orchestration_get'&&out.ok){
        if(mutation==='changed')out.payload.run.ownerBinding.definitionSha256='0'.repeat(64);
        else delete out.payload.run.ownerBinding;
      }
      return out;
    };
    const q=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,now:()=>f.now,exchange});
    if(mutation==='existing'){
      await n.exchange(null,{type:'orchestration_create',definition:{id:'gptq_'+hash(f.binding.bindingId+'\0'+f.binding.ownerIdentityHash).slice(0,24)+'_'+f.operationId,title:f.title,startPaused:true,roles:f.roles}});
    }
    await assert.rejects(q.registerPaused(f.workspace,input(f)),/QUEUE_REGISTRATION_READBACK_UNPROVEN|HOLD_ORIGINAL_REQUEST_COLLISION/);
    assert.equal(creates,mutation==='existing'?0:1);assert.equal(n.state.dispatch,0);
  }
});
function payload(reply){
  const value=reply.content?.find(c=>c.type==='text')?.text;
  assert.ok(value,'MCP returned no structured response');
  return JSON.parse(value);
}

test('G1 provider accepts exact uppercase Chrome target proof and refuses case drift',async t=>{
  const f=fixture(t),native=simulatedNative();
  const target=f.binding.targets[0];
  target.targetId=target.targetId.toUpperCase();
  const proof=JSON.parse(fs.readFileSync(target.proofFile,'utf8'));
  proof.targetId=target.targetId;stored(target.proofFile,proof);
  target.proofSha256=hash(fs.readFileSync(target.proofFile));f.refresh();
  const executor=createGptQueueExecutor(f.config,{exchange:native.exchange,verifyRegistry:()=>true,now:()=>f.now});
  assert.equal((await executor.registerPaused(f.workspace,input(f))).registration,'REGISTERED_PAUSED');
  proof.targetId=proof.targetId.toLowerCase();stored(target.proofFile,proof);
  target.proofSha256=hash(fs.readFileSync(target.proofFile));f.refresh();
  await assert.rejects(executor.registerPaused(f.workspace,input(f)),/QUEUE_TARGET_PROOF_MISMATCH/);
  assert.equal(native.state.dispatch,0);
});

test('G1 activation separately authorizes only the exact fresh owner request once',async t=>{
  const f=fixture(t),n=simulatedNative();let now=f.now;
  const e=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,exchange:n.exchange,now:()=>now});
  const registered=await e.registerPaused(f.workspace,input(f));
  const activation={operation_id:f.operationId,request_id:'activate-original-001',expected_revision:registered.revision};
  await assert.rejects(e.activate(f.workspace,{...activation,expected_revision:registered.revision+1}),/QUEUE_STALE_REVISION/);
  now=f.now+240000;
  await assert.rejects(e.activate(f.workspace,activation),/QUEUE_TARGET_PROOF_STALE/);
  now=f.now;
  const started=await e.activate(f.workspace,activation);
  assert.equal(started.activation,'AUTHORIZED_FOR_EXISTING_EXTENSION');
  assert.equal(started.executionAuthorized,true);
  assert.equal(started.messageSubmitted,false);
  assert.equal(started.dispatchState,'NOT_DISPATCHED');
  now=f.now+240000;
  assert.equal((await e.activate(f.workspace,activation)).activation,'ALREADY_AUTHORIZED_NOT_RESENT');
  await assert.rejects(e.activate(f.workspace,{...activation,request_id:'activate-duplicate-002'}),/QUEUE_ACTIVATION_ALREADY_CLAIMED/);
  assert.equal(n.state.calls.filter(x=>x==='orchestration_activate').length,1);
  assert.equal(n.state.dispatch,0);
});

test('G1 activation lost acknowledgement reconciles the original authorization without reactivation',async t=>{
  const f=fixture(t),n=simulatedNative();let lost=true,now=f.now;
  const e=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,now:()=>now,exchange:async(b,m)=>{
    const response=await n.exchange(b,m);
    if(m.type==='orchestration_activate'&&lost){lost=false;throw Error('SYNTHETIC_ACK_LOST');}
    return response;
  }});
  const registered=await e.registerPaused(f.workspace,input(f));
  const activation={operation_id:f.operationId,request_id:'activate-lost-ack-001',expected_revision:registered.revision};
  await assert.rejects(e.activate(f.workspace,activation),/QUEUE_NATIVE_OUTCOME_UNKNOWN/);
  now=f.now+240000;
  assert.equal((await e.get(f.workspace,f.operationId)).executionAuthorized,true);
  assert.equal((await e.activate(f.workspace,activation)).activation,'ALREADY_AUTHORIZED_NOT_RESENT');
  assert.equal(n.state.calls.filter(x=>x==='orchestration_activate').length,1);
  assert.equal(n.state.dispatch,0);
});

test('G1 activation readback refuses changed owner, definition or missing authorization',async t=>{
  for(const mutation of ['owner','definition','authorization']){
    const f=fixture(t),n=simulatedNative();
    const e=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,now:()=>f.now,exchange:async(b,m)=>{
      const response=await n.exchange(b,m);
      if(m.type==='orchestration_activate'){
        const run=[...n.state.runs.values()][0];
        if(mutation==='owner')run.ownerBinding={...run.ownerBinding,ownerIdentityHash:'0'.repeat(64)};
        if(mutation==='definition')run.roles[0].prompt='changed-after-activation';
        if(mutation==='authorization')delete run.executionAuthorized;
      }
      return response;
    }});
    const registered=await e.registerPaused(f.workspace,input(f));
    const activation={operation_id:f.operationId,request_id:'activate-readback-001',expected_revision:registered.revision};
    await assert.rejects(e.activate(f.workspace,activation),/QUEUE_ACTIVATION_READBACK_UNPROVEN|QUEUE_ACTIVATION_ORIGINAL_BINDING_MISMATCH/);
    await assert.rejects(e.activate(f.workspace,activation),/QUEUE_ACTIVATION_READBACK_UNPROVEN|QUEUE_ACTIVATION_ORIGINAL_BINDING_MISMATCH/);
    assert.equal(n.state.calls.filter(x=>x==='orchestration_activate').length,1);
    assert.equal(n.state.dispatch,0);
  }
});

test('G1 activation real isolated native ledger survives lost acknowledgement and process restart',{
  skip:process.platform!=='win32'||!process.env.AICC_GPT_QUEUE_NATIVE_PROGRAM
},async t=>{
  const f=fixture(t);
  const compiler='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const compiled=spawnSync(compiler,['/nologo','/optimize+','/target:exe','/out:'+f.executable,
    process.env.AICC_GPT_QUEUE_NATIVE_PROGRAM,'/r:System.Web.Extensions.dll'],{encoding:'utf8',timeout:20000});
  assert.equal(compiled.status,0,compiled.stderr||compiled.stdout);
  f.binding.nativeExecutableSha256=hash(fs.readFileSync(f.executable));f.refresh();
  let activationCalls=0;
  const options={verifyRegistry:()=>true,now:()=>f.now,exchange:async(b,m)=>{
    const response=await nativeGptQueueExchange(b,m);
    if(m.type==='orchestration_activate'){activationCalls++;throw Error('SYNTHETIC_ACK_LOST_AFTER_REAL_NATIVE_EXIT');}
    return response;
  }};
  const first=createGptQueueExecutor(f.config,options);
  const registered=await first.registerPaused(f.workspace,input(f));
  const activation={operation_id:f.operationId,request_id:'activate-native-lost-ack',expected_revision:registered.revision};
  await assert.rejects(first.activate(f.workspace,activation),/QUEUE_NATIVE_OUTCOME_UNKNOWN/);
  const restarted=createGptQueueExecutor(f.config,{...options,now:()=>f.now+240000});
  const reconciled=await restarted.activate(f.workspace,activation);
  assert.equal(reconciled.activation,'ALREADY_AUTHORIZED_NOT_RESENT');
  assert.equal(reconciled.executionAuthorized,true);
  assert.equal(reconciled.dispatchState,'NOT_DISPATCHED');
  assert.equal(reconciled.revision,registered.revision+1);
  assert.equal(activationCalls,1);
  await assert.rejects(restarted.activate(f.workspace,{...activation,request_id:'different-native-request'}),/QUEUE_ACTIVATION_ALREADY_CLAIMED/);
  assert.equal(activationCalls,1);
});

test('G1 changed definition, unbound legacy registration and unknown work cannot activate',async t=>{
  for(const mutation of ['definition','binding','unknown']){
    const f=fixture(t),n=simulatedNative(),e=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,exchange:n.exchange,now:()=>f.now});
    const registered=await e.registerPaused(f.workspace,input(f)),run=[...n.state.runs.values()][0];
    if(mutation==='definition')run.roles[0].prompt='changed';
    if(mutation==='binding')delete run.ownerBinding;
    if(mutation==='unknown')run.roles[0].submissionUncertain=true;
    await assert.rejects(e.activate(f.workspace,{operation_id:f.operationId,request_id:'activate-original-001',expected_revision:registered.revision}),
      /QUEUE_ACTIVATION_ORIGINAL_BINDING_MISMATCH|HOLD_ORIGINAL_CLAIM_OR_DISPATCH_RECONCILE/);
    assert.equal(n.state.calls.includes('orchestration_activate'),false);
  }
});

test('G1 business-full exact owner tools; personal read-only never advertises mutation',()=>{
  const enabled=workspaceToolSnapshot({surfaceProfile:'business-full',gptQueueAvailable:true,
    commandSandboxAvailable:true,platform:'win32'});
  const personal=workspaceToolSnapshot({surfaceProfile:'personal-read-fetch',gptQueueAvailable:true,
    commandSandboxAvailable:true,platform:'win32'});
  assert.deepEqual(enabled.tools.filter(t=>t.name.startsWith('aicc_gpt_queue_')).map(t=>t.name),
    ['aicc_gpt_queue_register','aicc_gpt_queue_list','aicc_gpt_queue_get','aicc_gpt_queue_cancel','aicc_gpt_queue_activate']);
  assert.equal(personal.tools.some(t=>t.name.startsWith('aicc_gpt_queue_')),false);
  assert.equal(workspaceToolSnapshot().tools.some(t=>t.name.startsWith('aicc_gpt_queue_')),false);
});

test('G1 exact owner proof, original ID, idempotent register, no send, read-only list and CAS cancel',async t=>{
  const f=fixture(t),n=simulatedNative(),e=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,exchange:n.exchange,now:()=>f.now});
  const first=await e.registerPaused(f.workspace,input(f));
  assert.equal(first.registration,'REGISTERED_PAUSED');
  assert.equal(first.dispatchState,'NOT_DISPATCHED');
  assert.equal(first.nextAssignment,'HOLD_EXACT_OWNER_TARGET_AND_ACTIVATION_REQUIRED');
  assert.equal((await e.registerPaused(f.workspace,input(f))).registration,'EXISTING_NOT_RESENT');
  assert.equal(n.state.calls.filter(x=>x==='orchestration_create').length,1);
  const listed=await e.list(f.workspace);assert.equal(listed.runs.length,1);
  assert.equal(listed.runs[0].status,'paused');assert.equal(listed.otherOwnerRunsOmitted,true);
  const get=await e.get(f.workspace,f.operationId);
  assert.equal(get.roles[0].conversationRecorded,true);
  assert.equal(get.roles[0].userMessageRecorded,false);
  await assert.rejects(e.registerPaused(f.workspace,{...input(f),request_id:'new-bypass-0001'}),/QUEUE_ORIGINAL_REQUEST_ID_MISMATCH/);
  await assert.rejects(e.registerPaused(f.workspace,{...input(f),roles:[{...f.roles[0],prompt:'tampered'},f.roles[1]]}),/QUEUE_DEFINITION_SHA_MISMATCH/);
  await assert.rejects(e.get({alias:'other-owner',root:f.workspace.root},f.operationId),/QUEUE_OWNER_BINDING_INVALID/);
  const cancelled=await e.cancel(f.workspace,{operation_id:f.operationId,request_id:'cancel-owner-001'});
  assert.equal(cancelled.cancel,'CANCELLED_UNSENT');
  assert.equal(cancelled.originalTargetLeaseReturned,false);
  assert.equal((await e.cancel(f.workspace,{operation_id:f.operationId,request_id:'cancel-owner-002'})).cancel,'ALREADY_CANCELLED');
  assert.equal(n.state.calls.filter(x=>x==='orchestration_control').length,1);
  assert.equal(n.state.dispatch,0);
  const unsafe=JSON.stringify({get,cancelled,listed});
  for(const original of ['fake alpha','fake beta','conversation-a-0001','a'.repeat(64),'f'.repeat(64)])assert.equal(unsafe.includes(original),false);
});

test('G1 stale target proof, changed installed executable and old native capability fail before create',async t=>{
  const f=fixture(t),n=simulatedNative();
  const stale=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,exchange:n.exchange,now:()=>f.now+240000});
  await assert.rejects(stale.registerPaused(f.workspace,input(f)),/QUEUE_TARGET_PROOF_STALE/);
  assert.equal(n.state.calls.length,0);
  const old=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,exchange:async (_b,m)=>m.type==='orchestration_capabilities'?
    {ok:false,error:'LOCAL_ARCHIVE_UNKNOWN_REQUEST'}:n.exchange(_b,m),now:()=>f.now});
  await assert.rejects(old.registerPaused(f.workspace,input(f)),/QUEUE_NATIVE_LOCAL_ARCHIVE_UNKNOWN_REQUEST/);
  assert.equal(n.state.calls.includes('orchestration_create'),false);
  fs.writeFileSync(f.executable,'UNPINNED_EXECUTABLE');
  await assert.rejects(createGptQueueExecutor(f.config,{verifyRegistry:()=>true,exchange:n.exchange}).get(f.workspace,f.operationId),/QUEUE_PIN_CHANGED/);
});

test('G1 registered MCP tools reach the exact owner-bound native contract, including cancellation',async t=>{
  const f=fixture(t),n=simulatedNative(),lease='remote_cap_'+'b'.repeat(64);
  const remoteAuthority={reconcileStartup(){},
    resolve:async({capability,requiredMode,requestId})=>{
      if(capability!==lease||!['write','read'].includes(requiredMode))throw Error('OWNER_LEASE_DENIED');
      if(requiredMode==='write'&&!requestId)throw Error('WRITE_REQUEST_REQUIRED');
      return {leaseId:'owner-lease-fixture'};
    }};
  const server=createWorkspaceMcpServer({...f.config,workspaces:[f.workspace],
    permissions:{commands:false}},{runtimeRoot:f.owner,remoteAuthority,gptQueueRegistryVerify:()=>true,
      gptQueueExchange:n.exchange,now:()=>f.now});
  const client=new Client({name:'owner-queue-fixture',version:'1.0.0'});
  const [serverTransport,clientTransport]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(serverTransport);await client.connect(clientTransport);
    const tools=(await client.listTools()).tools.map(t=>t.name);
    assert.ok(tools.includes('aicc_gpt_queue_register'));
    const listedWorkspaces=payload(await client.callTool({name:'aicc_workspace_list',arguments:{}}));
    assert.equal(listedWorkspaces.workspaces.some(w=>w.alias===f.workspace.alias),true);
    const workspace_id='ws_'+hash(f.workspace.alias+'\0'+f.workspace.root).slice(0,24);
    const auth={workspace_id,lease};
    const reg=payload(await client.callTool({name:'aicc_gpt_queue_register',arguments:{...auth,...input(f)}}));
    assert.equal(reg.ok,true);assert.equal(reg.registration,'REGISTERED_PAUSED');
    const list=payload(await client.callTool({name:'aicc_gpt_queue_list',arguments:auth}));
    assert.equal(list.runs.length,1);
    const original=payload(await client.callTool({name:'aicc_gpt_queue_get',arguments:{...auth,operation_id:f.operationId}}));
    assert.equal(original.status,'paused');assert.equal(original.dispatchState,'NOT_DISPATCHED');
    const stop=payload(await client.callTool({name:'aicc_gpt_queue_cancel',arguments:{
      ...auth,request_id:'cancel-fixture-001',operation_id:f.operationId}}));
    assert.equal(stop.cancel,'CANCELLED_UNSENT');
    assert.equal(n.state.calls.filter(x=>x==='orchestration_create').length,1);
    assert.equal(n.state.calls.filter(x=>x==='orchestration_control').length,1);
  }finally{await client.close();await server.close();}
});

test('G1 formal MCP -> real isolated WebGPT Queue native-host ledger if exact source fixture supplied',{
  skip:process.platform!=='win32'||!process.env.AICC_GPT_QUEUE_NATIVE_PROGRAM
},async t=>{
  const f=fixture(t),source=process.env.AICC_GPT_QUEUE_NATIVE_PROGRAM;
  const compiler='C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const compile=spawnSync(compiler,['/nologo','/optimize+','/target:exe',
    '/out:'+f.executable,source,'/r:System.Web.Extensions.dll'],{encoding:'utf8',timeout:20000});
  assert.equal(compile.status,0,compile.stderr||compile.stdout);
  f.binding.nativeExecutableSha256=hash(fs.readFileSync(f.executable));f.refresh();
  const lease='remote_cap_'+'a'.repeat(64);
  const remoteAuthority={reconcileStartup(){},resolve:async({capability,requestId,requiredMode})=>{
    if(capability!==lease||requiredMode==='write'&&!requestId)throw Error('OWNER_LEASE_DENIED');
    return {leaseId:'exact-original-fixture'};
  }};
  const server=createWorkspaceMcpServer({...f.config,workspaces:[f.workspace],
    permissions:{commands:false}},{runtimeRoot:f.owner,remoteAuthority,gptQueueRegistryVerify:()=>true,now:()=>f.now});
  const client=new Client({name:'native-owner-real-fixture',version:'1.0.0'});
  const [st,ct]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(st);await client.connect(ct);
    const listWork=payload(await client.callTool({name:'aicc_workspace_list',arguments:{}}));
    assert.equal(listWork.workspaces.some(w=>w.alias===f.workspace.alias),true);
    const workspace_id='ws_'+hash(f.workspace.alias+'\0'+f.workspace.root).slice(0,24);
    const auth={workspace_id,lease};
    const reg=payload(await client.callTool({name:'aicc_gpt_queue_register',arguments:{...auth,...input(f)}}));
    assert.equal(reg.registration,'REGISTERED_PAUSED',JSON.stringify(reg));
    const saved=JSON.parse(fs.readFileSync(path.join(f.archive,'.webgpt-queue-orchestrator','state.json'),'utf8'));
    assert.equal(Object.values(saved.runs).length,1);
    const work=Object.values(saved.runs)[0];
    assert.equal(work.registrationOnly,true);assert.equal(work.status,'paused');
    assert.equal(work.roles.some(role=>role.dispatchCount>0||role.userMessageId),false);
    const get=payload(await client.callTool({name:'aicc_gpt_queue_get',arguments:{
      ...auth,operation_id:f.operationId}}));
    assert.equal(get.status,'paused');
    const cancelled=payload(await client.callTool({name:'aicc_gpt_queue_cancel',arguments:{
      ...auth,request_id:'cancel-fixture-002',operation_id:f.operationId}}));
    assert.equal(cancelled.cancel,'CANCELLED_UNSENT',JSON.stringify(cancelled));
    assert.equal(cancelled.originalTargetLeaseReturned,false);
    const after=payload(await client.callTool({name:'aicc_gpt_queue_get',arguments:{
      ...auth,operation_id:f.operationId}}));
    assert.equal(after.status,'cancelled');assert.equal(after.dispatchState,'NOT_DISPATCHED');
    const final=JSON.parse(fs.readFileSync(path.join(f.archive,'.webgpt-queue-orchestrator','state.json'),'utf8'));
    assert.equal(Object.values(final.runs)[0].status,'cancelled');
  }finally{await client.close();await server.close();}
});

test('G1 original claimed or altered target records refuse cancel without native control',async t=>{
  const f=fixture(t),n=simulatedNative(),e=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,exchange:n.exchange,now:()=>f.now});
  await e.registerPaused(f.workspace,input(f));
  const run=[...n.state.runs.values()][0],role=run.roles[0];
  role.status='dispatched';role.dispatchCount=1;role.userMessageId='original-user-message';
  await assert.rejects(e.cancel(f.workspace,{operation_id:f.operationId,request_id:'cancel-unsafe-001'}),
    /HOLD_ORIGINAL_CLAIM_OR_DISPATCH_RECONCILE/);
  assert.equal(n.state.calls.includes('orchestration_control'),false);
  role.status='ready';delete role.dispatchCount;delete role.userMessageId;
  role.targetNonce='c'.repeat(64);
  await assert.rejects(e.get(f.workspace,f.operationId),/QUEUE_ORIGINAL_TARGET_BINDING_DRIFT/);
  await assert.rejects(e.cancel(f.workspace,{operation_id:f.operationId,request_id:'cancel-unsafe-002'}),
    /QUEUE_ORIGINAL_TARGET_BINDING_DRIFT/);
  assert.equal(n.state.calls.includes('orchestration_control'),false);
});

test('G1 native uncertain create is not resent; original read-only get remains the reconciliation path',async t=>{
  const f=fixture(t),n=simulatedNative();let uncertainOnce=true;
  const exchange=async(b,m)=>{
    if(m.type==='orchestration_create'&&uncertainOnce){uncertainOnce=false;await n.exchange(b,m);throw Error('SYNTHETIC_ACK_LOST');}
    return n.exchange(b,m);
  };
  const e=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,exchange,now:()=>f.now});
  await assert.rejects(e.registerPaused(f.workspace,input(f)),/QUEUE_NATIVE_OUTCOME_UNKNOWN/);
  assert.equal((await e.get(f.workspace,f.operationId)).status,'paused');
  assert.equal(n.state.calls.filter(t=>t==='orchestration_create').length,1);
  assert.equal((await e.registerPaused(f.workspace,input(f))).registration,'EXISTING_NOT_RESENT');
  assert.equal(n.state.calls.filter(t=>t==='orchestration_create').length,1);
});

test('G1 stale native revision refuses cancellation while preserving paused original',async t=>{
  const f=fixture(t),n=simulatedNative();let stale=true;
  const e=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,exchange:async(b,m)=>{
    if(m.type==='orchestration_control'&&stale){stale=false;n.state.revision++;}
    return n.exchange(b,m);
  },now:()=>f.now});
  await e.registerPaused(f.workspace,input(f));
  await assert.rejects(e.cancel(f.workspace,{operation_id:f.operationId,request_id:'cancel-stale-001'}),
    /QUEUE_STALE_REVISION/);
  assert.equal((await e.get(f.workspace,f.operationId)).status,'paused');
});

test('G1 personal-read-fetch server hides all queue tools even with an enabled declaration',async t=>{
  const f=fixture(t),server=createWorkspaceMcpServer({...f.config,surfaceProfile:'personal-read-fetch',
    workspaces:[f.workspace],permissions:{commands:false}},{runtimeRoot:f.owner,
    remoteAuthority:{reconcileStartup(){}}});
  const client=new Client({name:'read-only-fixture',version:'1.0.0'});
  const [st,ct]=InMemoryTransport.createLinkedPair();
  try{await server.connect(st);await client.connect(ct);
    assert.equal((await client.listTools()).tools.some(tool=>tool.name.startsWith('aicc_gpt_queue_')),false);
  }finally{await client.close();await server.close();}
});

test('G1 immutable owner proof expires for register but supports original read and safe cancel after process restart',async t=>{
  const f=fixture(t),n=simulatedNative();
  const early=createGptQueueExecutor(f.config,{exchange:n.exchange,now:()=>f.now,verifyRegistry:()=>true});
  assert.equal((await early.registerPaused(f.workspace,input(f))).registration,'REGISTERED_PAUSED');
  const later=createGptQueueExecutor(f.config,{
    exchange:n.exchange,now:()=>f.now+240000,verifyRegistry:()=>true});
  assert.equal((await later.get(f.workspace,f.operationId)).status,'paused');
  assert.equal((await later.list(f.workspace)).runs[0].dispatchState,'NOT_DISPATCHED');
  await assert.rejects(later.registerPaused(f.workspace,input(f)),/QUEUE_TARGET_PROOF_STALE/);
  const cancelled=await later.cancel(f.workspace,{
    operation_id:f.operationId,request_id:'same-owner-after-restart-0001'});
  assert.equal(cancelled.cancel,'CANCELLED_UNSENT');
  const original=await later.get(f.workspace,f.operationId);
  assert.equal(original.status,'cancelled');
  const proofFile=f.binding.targets[0].proofFile;
  fs.appendFileSync(proofFile,'\n');
  await assert.rejects(later.get(f.workspace,f.operationId),/QUEUE_PIN_CHANGED/);
  assert.equal(n.state.calls.filter(type=>type==='orchestration_create').length,1);
});
test('G1 pinned QueueOwnerInspect process results yield only fixed enum diagnostic, never raw errors',async t=>{
 const scenarios=[
  {name:'closed',reply:{status:4,stdout:JSON.stringify({ok:false,status:'HOLD',holdCode:'HOLD_QUEUE_TARGET_CHANGED',secret:'DO_NOT_LOG_LEASE_TOKEN'})},code:'QUEUE_CURRENT_ISSUER_TARGET_CLOSED_OR_UNPROVEN'},
  {name:'lost lease',reply:{status:4,stdout:JSON.stringify({ok:false,status:'HOLD',holdCode:'HOLD_QUEUE_ORIGINAL_ACTIVE_LEASE_UNPROVEN'})},code:'QUEUE_CURRENT_ISSUER_LEASE_UNPROVEN'},
  {name:'identity',reply:{status:4,stdout:JSON.stringify({ok:false,status:'HOLD',holdCode:'HOLD_QUEUE_LIVE_NONCE_UNPROVEN'})},code:'QUEUE_CURRENT_ISSUER_IDENTITY_HOLD'},
  {name:'unknown enum',reply:{status:4,stdout:JSON.stringify({ok:false,status:'HOLD',holdCode:'HOLD_ATTACKER_SECRET'})},code:'QUEUE_CURRENT_ISSUER_INSPECT_UNPROVEN'},
  {name:'registered browser identity refused',reply:{status:4,stdout:JSON.stringify({ok:false,status:'HOLD',holdCode:'HOLD_REGISTERED_IDENTITY'})},code:'QUEUE_CURRENT_ISSUER_IDENTITY_HOLD'},
  {name:'target origin refused',reply:{status:4,stdout:JSON.stringify({ok:false,status:'HOLD',holdCode:'HOLD_TARGET_ORIGIN'})},code:'QUEUE_CURRENT_ISSUER_IDENTITY_HOLD'},
  {name:'target identity unavailable',reply:{status:4,stdout:JSON.stringify({ok:false,status:'HOLD',holdCode:'HOLD_TARGET_IDENTITY_UNPROVEN'})},code:'QUEUE_CURRENT_ISSUER_IDENTITY_HOLD'},
  {name:'timeout',reply:{status:null,error:{code:'ETIMEDOUT',message:'SECRET-ARGS'}} ,code:'QUEUE_CURRENT_ISSUER_INSPECT_TIMEOUT'},
  {name:'launch',reply:{status:null,error:{code:'ENOENT'}},code:'QUEUE_CURRENT_ISSUER_INSPECT_LAUNCH_FAILED'},
  {name:'overflow',reply:{status:null,error:{code:'ENOBUFS'}},code:'QUEUE_CURRENT_ISSUER_INSPECT_OVERFLOW'},
  {name:'malformed',reply:{status:0,stdout:'PRIVATE_STDIN_IS_NOT_JSON'},code:'QUEUE_CURRENT_ISSUER_INSPECT_MALFORMED'},
  {name:'malformed hold',reply:{status:4,stdout:'PRIVATE_STDIN_IS_NOT_JSON'},code:'QUEUE_CURRENT_ISSUER_INSPECT_MALFORMED'},
  {name:'nonzero',reply:{status:3,stdout:'PRIVATE_NONZERO_MESSAGE'},code:'QUEUE_CURRENT_ISSUER_INSPECT_NONZERO'}
 ];
 for(const {name,reply,code} of scenarios){
  const f=fixture(t),c=currentIssuerFixture(f),n=simulatedNative(),invocations=[];
  const e=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,
   assertPrivateFile:()=>true,exchange:n.exchange,now:()=>f.now,
   spawnIssuerProcess:(exe,args,flags)=>{
    invocations.push({base:path.basename(exe),argNames:args.filter((_,i)=>i%2===0),flags});
    assert.equal(flags.timeout,130000);assert.equal(flags.windowsHide,true);
    assert.equal(flags.shell,false);assert.equal(flags.maxBuffer,65536);
    assert.equal(args.includes(c.request.roles[0].leaseToken),true);
    return reply;
   }});
  await assert.rejects(e.registerPaused(f.workspace,input(f)),error=>{
   assert.equal(error.code,code,name);
   assert.equal(error.message,code,name);
   assert.equal(JSON.stringify(error).includes('SECRET'),false);
   assert.equal(JSON.stringify(error).includes('PRIVATE'),false);
   assert.equal(JSON.stringify(error).includes(c.request.roles[0].leaseToken),false);
   return true;
  });
  assert.equal(invocations.length,1,name);
  assert.equal(n.state.calls.includes('orchestration_create'),false,name);
  assert.equal(n.state.calls.includes('orchestration_activate'),false,name);
 }
});
test('G1 current-issuer second-slot target can close after first successful inspect without any registration',async t=>{
 const f=fixture(t),c=currentIssuerFixture(f),n=simulatedNative();let count=0;
 const e=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,exchange:n.exchange,
  assertPrivateFile:()=>true,now:()=>f.now,inspectTarget:async role=>{
   count++;
   return count===2?{ok:false,status:'HOLD',holdCode:'HOLD_QUEUE_TARGET_CHANGED'}:c.inspectTarget(role);
  }});
 await assert.rejects(e.registerPaused(f.workspace,input(f)),/QUEUE_CURRENT_ISSUER_TARGET_CLOSED_OR_UNPROVEN/);
 assert.equal(count,2);
 assert.equal(n.state.calls.includes('orchestration_create'),false);
});

test('G1 slow second issuer read cannot extend the first proof lifetime',async t=>{
 const f=fixture(t),c=currentIssuerFixture(f),n=simulatedNative();let clock=f.now,reads=0;
 const e=createGptQueueExecutor(f.config,{verifyRegistry:()=>true,exchange:n.exchange,
  assertPrivateFile:()=>true,now:()=>clock,inspectTarget:async role=>{
   reads++;
   const result=await c.inspectTarget(role);
   if(reads===2){clock=f.now+121000;
    result.proof.observedAt=new Date(clock).toISOString();
    result.proof.expiresAt=new Date(clock+60000).toISOString();}
   return result;
  }});
 await assert.rejects(e.registerPaused(f.workspace,input(f)),/QUEUE_CURRENT_ISSUER_STALE/);
 assert.equal(reads,2);
 assert.equal(n.state.calls.includes('orchestration_create'),false);
 assert.equal(n.state.calls.includes('orchestration_activate'),false);
});
