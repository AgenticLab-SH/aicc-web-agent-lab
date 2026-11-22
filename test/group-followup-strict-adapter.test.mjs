import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inspectStrictFollowup,enqueueStrictFollowup} from '../src/group-followup-strict-adapter.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const hash=file=>digest(fs.readFileSync(file));
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-group-owner-'));
 const pwshPath=path.join(root,'pwsh.exe'),helperPath=path.join(root,'Invoke-AiccCodexContinuity.ps1');
 fs.writeFileSync(pwshPath,'pinned fake portable PowerShell');
 fs.writeFileSync(helperPath,'pinned fake installed owner manager');
 const source={id:'g2'},artifact={sha256:'b'.repeat(64)};
 const threadId='11111111-1111-4111-8111-111111111111';
 const eventId=digest(JSON.stringify([threadId,source.id,artifact.sha256]));
 const registration={schemaVersion:1,accountNumber:2,route:'command-route-r2',
  targetThreadId:threadId,targetRoot:root,ownerRevision:'a'.repeat(64),stopEpoch:7,
  workerOperationId:'22222222-2222-4222-8222-222222222222',
  strictContinuity:{kind:'aicc-installed-strict-preflight',schemaVersion:1,eventId,
   pwshPath,pwshSha256:hash(pwshPath),helperPath,helperSha256:hash(helperPath),stateRoot:root}};
 const proof={schemaVersion:1,kind:'aicc-group-owner-inspect',state:'READY',
  threadId,exactThreadId:threadId,eventId,eventSha256:'c'.repeat(64),
  accountNumber:2,requestedAccountNumber:2,route:'command-route-r2',root,
  ownerRevision:registration.ownerRevision,stopEpoch:7,workerOperationId:registration.workerOperationId,
  resultSha256:artifact.sha256,sourceId:source.id,claimed:false,dispatched:false,
  automaticReplay:false,modelRequests:0,quotaFresh:true,idle:true,writerReleased:true,
  sourceWriterReturned:true,originalPending:false,stopRequested:false,authorityFresh:true,
  callbackPending:false,queuePending:false,sourceWriterReceiptSha256:'d'.repeat(64),
  terminalSha256:'e'.repeat(64),registrationSha256:'f'.repeat(64)};
 return {root,registration,source,artifact,eventId,proof};
}
function assertArgs(f,argv,action,expectedSha=''){
 assert.deepEqual(argv,[
  '-NoProfile','-NonInteractive','-File',f.registration.strictContinuity.helperPath,
  '-Action',action,'-ThreadId',f.registration.targetThreadId,'-StrictAccountNumber','2',
  '-StateRoot',f.root,'-EventId',f.eventId,'-ExpectedEventSha256',expectedSha,
  '-ExpectedResultSha256',f.artifact.sha256]);
}
test('pinned GroupInspect to GroupEnqueue is a model-free owner-only intent',async()=>{
 const f=fixture();let calls=[];
 const invoke=async(program,args)=>{
  assert.equal(program,f.registration.strictContinuity.pwshPath);
  calls.push(args);
  if(args[5]==='GroupInspect'){assertArgs(f,args,'GroupInspect');return JSON.stringify(f.proof)}
  assertArgs(f,args,'GroupEnqueue',f.proof.eventSha256);
  return JSON.stringify({schemaVersion:1,kind:'aicc-group-owner-enqueue',
   state:'STRICT_INTENT_RECORDED',eventId:f.eventId,threadId:f.registration.targetThreadId,
   claimed:false,dispatched:false,automaticReplay:false,modelRequests:0});
 };
 const inspected=await inspectStrictFollowup(f.registration,f.source,f.artifact,{eventId:f.eventId,invoke});
 assert.equal(inspected.state,'READY');assert.equal(inspected.modelRequests,0);
 const receipt=await enqueueStrictFollowup({registration:f.registration,source:f.source,artifactSha256:f.artifact.sha256,eventId:f.eventId,destination:inspected},{invoke});
 assert.equal(receipt.state,'STRICT_INTENT_RECORDED');assert.equal(receipt.modelRequests,0);assert.equal(calls.length,2);
});
test('a missing installed capability holds; prior read-only strict READY never enqueues',async()=>{
 const f=fixture(),result=await inspectStrictFollowup(f.registration,f.source,f.artifact,{
  eventId:f.eventId,invoke:()=>{throw Error('GroupInspect is not installed')}
 });
 assert.equal(result.state,'STRICT_OWNER_ACTION_UNAVAILABLE');assert.equal(result.modelRequests,0);
});
test('wrong account, root, thread, result, generation or output event is never trusted',async()=>{
 const changes=[
  {accountNumber:3},{root:'C:\\foreign'},{threadId:'33333333-3333-4333-8333-333333333333'},
  {resultSha256:'0'.repeat(64)},{ownerRevision:'0'.repeat(64)},{stopEpoch:8},
  {workerOperationId:'44444444-4444-4444-8444-444444444444'},
  {eventId:'f'.repeat(64)},{claimed:true},{dispatched:true},{automaticReplay:true},
  {eventSha256:'not-a-sha'}
 ];
 for(const diff of changes){
  const f=fixture();const result=await inspectStrictFollowup(f.registration,f.source,f.artifact,{
   eventId:f.eventId,invoke:()=>JSON.stringify({...f.proof,...diff})
  });
  assert.equal(result.state,'STRICT_OWNER_PROOF_IDENTITY_HOLD',JSON.stringify(diff));
 }
});
test('owner active, quota wait, old pending, stop and duplicate all HOLD',async()=>{
 for(const state of ['ORIGINAL_WRITER_NOT_RELEASED','STRICT_QUOTA_WAIT','PENDING_DELIVERY_HOLD','WORKER_STOP_HOLD','GROUP_EVENT_ALREADY_RECORDED']){
  const f=fixture();const result=await inspectStrictFollowup(f.registration,f.source,f.artifact,{
   eventId:f.eventId,invoke:()=>JSON.stringify({...f.proof,state})
  });
  assert.notEqual(result.state,'READY');assert.equal(result.modelRequests,0);
 }
});
test('wrong receipt, stale authority or callback/queue occupancy never READY',async()=>{
 for(const diff of [{sourceWriterReceiptSha256:null},{terminalSha256:null},{registrationSha256:null},
  {sourceWriterReturned:false},{writerReleased:false},{authorityFresh:false},{quotaFresh:false},
  {callbackPending:true},{queuePending:true},{originalPending:true},{stopRequested:true}]){
  const f=fixture();const result=await inspectStrictFollowup(f.registration,f.source,f.artifact,{
   eventId:f.eventId,invoke:()=>JSON.stringify({...f.proof,...diff})
  });
  assert.equal(result.state,'STRICT_OWNER_PROOF_INCOMPLETE_HOLD',JSON.stringify(diff));
 }
});
test('missing owner event ID or installed helper SHA drift stops before invocation',async()=>{
 const f=fixture();let calls=0;
 const invoke=()=>{calls++;return JSON.stringify(f.proof)};
 const missing=await inspectStrictFollowup(f.registration,f.source,f.artifact,{invoke});
 assert.equal(missing.state,'STRICT_FOLLOWUP_REGISTRATION_HOLD');
 fs.writeFileSync(f.registration.strictContinuity.helperPath,'changed');
 const drift=await inspectStrictFollowup(f.registration,f.source,f.artifact,{eventId:f.eventId,invoke});
 assert.equal(drift.state,'STRICT_HELPER_IDENTITY_HOLD');assert.equal(calls,0);
});
test('lost ACK after GroupEnqueue is uncertain and cannot be inferred as a new turn',async()=>{
 const f=fixture();const inspected=await inspectStrictFollowup(f.registration,f.source,f.artifact,{
  eventId:f.eventId,invoke:()=>JSON.stringify(f.proof)
 });
 const result=await enqueueStrictFollowup({registration:f.registration,source:f.source,
  artifactSha256:f.artifact.sha256,eventId:f.eventId,destination:inspected},{invoke:()=>{throw Error('ACK lost')}});
 assert.equal(result.state,'DELIVERY_UNCERTAIN');assert.equal(result.modelRequests,0);
});
