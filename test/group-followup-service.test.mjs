import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {GroupFollowupService} from '../src/group-followup-service.mjs';
import {DurableJobStore} from '../src/jobs/durable-store.mjs';
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-followup-'));const resultFile=path.join(root,'result.json');fs.writeFileSync(resultFile,JSON.stringify({status:'COMPLETED'}));const registrationPath=path.join(root,'registration.json');const r={schemaVersion:1,enabled:true,targetThreadId:'11111111-1111-4111-8111-111111111111',targetRoot:root,accountNumber:2,route:'command-route-r2',authorizationRef:'user-explicit',ownerRevision:'a'.repeat(64),stopEpoch:7,workerOperationId:'22222222-2222-4222-8222-222222222222',sources:[{id:'g2',resultFile,terminalStatuses:['COMPLETED']}]};fs.writeFileSync(registrationPath,JSON.stringify(r));const store=new DurableJobStore({root:path.join(root,'jobs')});const proof={state:'READY',exactThreadId:r.targetThreadId,root,accountNumber:2,route:r.route,ownerRevision:r.ownerRevision,stopEpoch:r.stopEpoch,workerOperationId:r.workerOperationId,resultSha256:createHash('sha256').update(fs.readFileSync(resultFile)).digest('hex'),sourceId:'g2',sourceWriterReceiptSha256:'b'.repeat(64),terminalSha256:'c'.repeat(64),callbackPending:false,queuePending:false,quotaFresh:true,idle:true,writerReleased:true,sourceWriterReturned:true,originalPending:false,stopRequested:false,authorityFresh:true};return {root,r,registrationPath,store,proof};}
test('missing transport observes result but sends nothing',async()=>{const f=fixture();const s=new GroupFollowupService(f);const r=await s.tick();assert.equal(r.changes[0].state,'DESTINATION_PROOF_UNAVAILABLE');assert.equal(r.dispatchSupported,false);});
test('one durable claim survives restart and ambiguous dispatch is never retried',async()=>{const f=fixture();let calls=0;const options={...f,inspectDestination:async()=>f.proof,dispatch:async()=>{calls++;throw Error('lost ACK');}};assert.equal((await new GroupFollowupService(options).tick()).changes[0].state,'DELIVERY_UNCERTAIN');assert.equal((await new GroupFollowupService(options).tick()).changes[0].duplicateSuppressed,true);assert.equal(calls,1);});
test('quota, stop, writer, wrong account and same-root pending forbid dispatch',async()=>{for(const delta of [{quotaFresh:false},{stopRequested:true},{writerReleased:false},{sourceWriterReturned:false},{accountNumber:3},{originalPending:true},{authorityFresh:false}]){const f=fixture();let calls=0;const s=new GroupFollowupService({...f,inspectDestination:async()=>({...f.proof,...delta}),dispatch:async()=>{calls++;}});assert.equal((await s.tick()).changes[0].state,'DESTINATION_CONTRACT_HOLD');assert.equal(calls,0);}});
test('accepted result is not completed and same event is suppressed',async()=>{const f=fixture();let calls=0;const s=new GroupFollowupService({...f,inspectDestination:async()=>f.proof,dispatch:async()=>{calls++;return {state:'QUEUE_ACCEPTED',queuedMessageId:'receipt'};}});assert.equal((await s.tick()).changes[0].state,'QUEUE_ACCEPTED');await s.tick();assert.equal(calls,1);});
test('changed registration during inspection cannot authorize dispatch',async()=>{const f=fixture();let calls=0;const s=new GroupFollowupService({...f,inspectDestination:async()=>{fs.writeFileSync(f.registrationPath,JSON.stringify({...f.r,enabled:false}));return f.proof;},dispatch:async()=>{calls++;}});await s.tick();assert.equal(calls,0);});

test('new owner, stop epoch, worker or changed result and callback/queue occupancy all hold before claim',async()=>{
 for(const delta of [{ownerRevision:'f'.repeat(64)},{stopEpoch:8},{workerOperationId:'44444444-4444-4444-8444-444444444444'},
  {resultSha256:'0'.repeat(64)},{sourceId:'another'},{sourceWriterReceiptSha256:null},{terminalSha256:null},
  {callbackPending:true},{queuePending:true}]){
  const f=fixture();let calls=0;
  const s=new GroupFollowupService({...f,inspectDestination:async()=>({...f.proof,...delta}),dispatch:async()=>{calls++;}});
  assert.equal((await s.tick()).changes[0].state,'DESTINATION_CONTRACT_HOLD');assert.equal(calls,0);
 }
});
test('a previously observed result cannot be reauthorized by changing the registration',async()=>{
 const f=fixture();let sends=0;
 const s=new GroupFollowupService({...f,inspectDestination:async()=>f.proof,dispatch:async()=>{sends++;}});
 f.proof.quotaFresh=false;
 assert.equal((await s.tick()).changes[0].state,'DESTINATION_CONTRACT_HOLD');
 fs.writeFileSync(f.registrationPath,JSON.stringify({...f.r,ownerRevision:'d'.repeat(64)}));
 assert.equal((await s.tick()).changes[0].state,'EVENT_AUTHORITY_CHANGED_HOLD');assert.equal(sends,0);
});
test('strict intent recorded means existing worker admission, never claimed model completion',async()=>{
 const f=fixture();let calls=0;
 const s=new GroupFollowupService({...f,inspectDestination:async()=>f.proof,dispatch:async()=>{calls++;return {state:'STRICT_INTENT_RECORDED'};}});
 assert.equal((await s.tick()).changes[0].state,'STRICT_INTENT_RECORDED');
 assert.equal((await s.tick()).changes[0].duplicateSuppressed,true);assert.equal(calls,1);
});
