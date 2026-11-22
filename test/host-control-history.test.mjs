import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createHostController, readHostHistory, HOST_TOOLS } from '../components/host-control/server.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-host-history-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stateRoot=path.join(root,'journals');fs.mkdirSync(stateRoot);
 const executor=path.join(root,'never-launched.exe');fs.writeFileSync(executor,'fixture');
 const config={schemaVersion:1,scope:'task-owned-v1',stateRoot,powershell:executor,aside:{command:executor,sha256:sha('fixture')},cua:{command:executor,sha256:sha('fixture')},apps:{}};
 const key='c'.repeat(64),ownerHash=sha(key);
 const record=(id,phase,extra={})=>{
  const value={schemaVersion:1,request_id:id,ownerHash,requestHash:sha(id),session_id:null,phase,at:'2026-10-20T00:00:00Z',...extra};
  fs.writeFileSync(path.join(stateRoot,id+'.json'),JSON.stringify(value));return value;
 };
 const snapshot=()=>Object.fromEntries(fs.readdirSync(stateRoot).filter(file=>fs.statSync(path.join(stateRoot,file)).isFile()).map(file=>[file,fs.readFileSync(path.join(stateRoot,file),'utf8')]));
 return {root,stateRoot,config,key,record,snapshot};
}


function historicalReturnFixture(t,{withClose=true}={}){
 const f=fixture(t),openId='historical-task-open-0001',closeId='historical-task-close-0001';
 const sessionId='0db1d68d-7321-4de0-b531-f3c590ebe21a',generation='2a5c46dd-d424-4a73-819a-a8f0b9b302a8';
 const lease='e'.repeat(64),target=sha('fake-exact-owned-cdp-target-and-slot');
 const original={request_id:openId,client_key:f.key,kind:'browser',url:'https://example.com/'};
 const opened=f.record(openId,'OUTCOME_UNKNOWN',{
  requestHash:sha(JSON.stringify(original)),operation:'open',kind:'browser',
  sessionState:'OPEN',session_id:sessionId,instanceId:generation,
  capHash:sha(lease),resourceTargetHash:target
 });
 const closeArgs={session_id:sessionId,lease,request_id:closeId};
 const exactNormalReturn={ok:true,status:'CLOSED',session_id:sessionId};
 const closeOutput={content:[{type:'text',text:JSON.stringify(exactNormalReturn)}],structuredContent:exactNormalReturn};
 if(withClose)f.record(closeId,'COMPLETED',{
  operation:'session',kind:'browser',hostAction:'normal-close/v1',session_id:sessionId,
  instanceId:generation,resourceTargetHash:target,requestHash:sha(JSON.stringify(closeArgs)),
  resultHash:sha(JSON.stringify(closeOutput)),at:'2026-10-20T00:00:01Z'
 });
 const recovery={session_id:sessionId,lease,request_id:'independent-return-reconcile-0001',
  history_recovery:{open_request_id:openId,close_request_id:closeId,client_key:f.key}};
 return {...f,openId,closeId,sessionId,lease,generation,target,opened,original,recovery};
}
async function historyController(t,f){
 let calls=0;
 const host=await createHostController(f.config,{connect:async()=>{calls++;throw Error('HISTORICAL_DRIVER_MUST_NOT_RUN');}});
 t.after(()=>host.close());
 return {host,get calls(){return calls;}};
}
test('legacy outcomes distinguish undispatched, unknown and completed-without-return-proof without rewriting evidence',t=>{
 const f=fixture(t);
 for(let i=0;i<8;i++)f.record('legacy-not-sent-'+i,'NOT_DISPATCHED',{error:'DRIVER_REFUSED'});
 for(let i=0;i<15;i++)f.record('legacy-completed-'+i,'COMPLETED',{resultHash:sha('output-'+i)});
 for(let i=0;i<6;i++)f.record('legacy-unknown-'+i,'OUTCOME_UNKNOWN',{error:'DRIVER_REFUSED'});
 fs.mkdirSync(path.join(f.stateRoot,'old-unit-fixture'));
 const before=f.snapshot(),history=readHostHistory(f.stateRoot);
 assert.equal(history.history.legacyRecords,29);
 assert.equal(history.history.legacyNotDispatched,8);
 assert.equal(history.history.legacyCompleted,15);
 assert.equal(history.history.legacyOutcomeUnknown,6);
 assert.equal(history.history.unreadableJournals,0);
 assert.equal(history.history.nonJournalEntries,1);
 assert.equal(history.recovered.filter(r=>r.recovery==='ORIGINAL_OPERATION_UNPROVEN').length,6);
 assert.equal(history.recovered.filter(r=>r.recovery==='LEGACY_OPERATION_KIND_UNPROVEN').length,15);
 assert.equal(history.recovered.some(r=>r.phase==='NOT_DISPATCHED'),false);
 assert.deepEqual(f.snapshot(),before);
});

test('per-entry corruption and partial writes retain HOLD evidence while valid remaining records are classified',t=>{
 const f=fixture(t);
 fs.writeFileSync(path.join(f.stateRoot,'aaa-broken.json'),'{');
 fs.writeFileSync(path.join(f.stateRoot,'partial-request.json.fixture.tmp'),'partial');
 f.record('z-valid-unknown','OUTCOME_UNKNOWN');
 f.record('z-valid-completed','COMPLETED',{resultHash:sha('result')});
 const before=f.snapshot(),history=readHostHistory(f.stateRoot);
 assert.equal(history.history.unreadableJournals,1);
 assert.equal(history.history.partialWrites,1);
 assert.equal(history.history.legacyOutcomeUnknown,1);
 assert.equal(history.history.legacyCompleted,1);
 assert.deepEqual(f.snapshot(),before);
});

test('owner read preserves historical outcomes without inventing current occupancy or blocking independent work',async t=>{
 const f=fixture(t);let driverCalls=0;
 for(let i=0;i<6;i++)f.record('old-unknown-'+i,'OUTCOME_UNKNOWN');
 f.record('old-completed-fixture','COMPLETED',{resultHash:sha('result')});
 f.record('old-not-sent-fixture','NOT_DISPATCHED');
 f.record('other-owner-unknown','OUTCOME_UNKNOWN',{ownerHash:sha('different-owner')});
 const before=f.snapshot();
 const controller=await createHostController(f.config,{connect:async()=>{driverCalls++;throw Error('DRIVER_MUST_NOT_RUN');}});
 t.after(()=>controller.close());
 const result=(await controller.call('aicc_host_sessions',{client_key:f.key})).structuredContent;
 assert.equal(result.capacity.knownSessions,0);
 assert.equal(result.capacity.recoveredUnknown,7);
 assert.equal(result.capacity.recoveredReturnUnproven,1);
 assert.equal(result.capacity.historicalRecords.currentActiveInferred,false);
 assert.equal(result.capacity.history,'UNPROVEN');
 assert.equal(result.capacity.availableSessions,4);
 assert.equal(result.capacity.historyAdmission,'session-evidence-v1');
 assert.equal(result.capacity.historyBlocksNewWork,false);
 assert.equal(result.capacity.unreturnedRecordedSessions,0);
 assert.equal(result.recovered.length,7);
 assert.equal(result.recovered.some(r=>r.request_id==='other-owner-unknown'),false);
 assert.equal(result.recovered.find(r=>r.request_id==='old-completed-fixture').status,'LEGACY_OPERATION_KIND_UNPROVEN');
 assert.equal(result.recovered.every(r=>r.session_return==='UNPROVEN'&&r.replayed===false),true);
 assert.equal(driverCalls,0);assert.deepEqual(f.snapshot(),before);
});

test('only known undispatched history and unrelated directory do not invent unknown work or occupy capacity',async t=>{
 const f=fixture(t);f.record('old-not-dispatched','NOT_DISPATCHED');fs.mkdirSync(path.join(f.stateRoot,'unit-directory'));
 const controller=await createHostController(f.config,{connect:async()=>{throw Error('DRIVER_MUST_NOT_RUN');}});
 t.after(()=>controller.close());
 const result=(await controller.call('aicc_host_sessions',{client_key:f.key})).structuredContent;
 assert.equal(result.capacity.recoveredUnknown,0);assert.equal(result.capacity.recoveredReturnUnproven,0);
 assert.equal(result.capacity.knownSessions,0);assert.equal(result.capacity.availableSessions,4);
 assert.equal(result.capacity.history,'CURRENT_INSTANCE');assert.deepEqual(result.recovered,[]);
});

test('current explicit CLOSED proof is respected while current OPEN and original unknown remain separate historical evidence',t=>{
 const f=fixture(t);
 f.record('modern-closed-fixture','COMPLETED',{operation:'open',sessionState:'CLOSED'});
 f.record('modern-open-fixture','COMPLETED',{operation:'open',sessionState:'OPEN'});
 f.record('modern-unknown-fixture','OUTCOME_UNKNOWN',{operation:'session'});
 f.record('modern-unsent-fixture','NOT_DISPATCHED',{operation:'open',sessionState:'NOT_DISPATCHED'});
 const result=readHostHistory(f.stateRoot);
 assert.equal(result.history.legacyRecords,0);assert.equal(result.recovered.length,2);
 assert.equal(result.recovered.find(r=>r.request_id==='modern-open-fixture').recovery,'SESSION_RETURN_UNPROVEN');
 assert.equal(result.recovered.find(r=>r.request_id==='modern-unknown-fixture').recovery,'ORIGINAL_OPERATION_UNPROVEN');
});

test('legacy unknown requests are not replayed while a distinct request reaches the executor',async t=>{
 const f=fixture(t);let driverCalls=0;
 const original={request_id:'legacy-original-request',client_key:f.key,kind:'browser',url:'https://example.com/'};
 f.record(original.request_id,'OUTCOME_UNKNOWN',{requestHash:sha(JSON.stringify(original)),error:'DRIVER_REFUSED'});
 const originalBytes=fs.readFileSync(path.join(f.stateRoot,original.request_id+'.json'),'utf8');
 const controller=await createHostController(f.config,{connect:async()=>{
  driverCalls++;throw Object.assign(Error('FAKE_EXECUTOR_NOT_STARTED'),{beforeDispatch:true});
 }});
 t.after(()=>controller.close());
 const oldResult=(await controller.call('aicc_host_open',original)).structuredContent;
 assert.equal(oldResult.status,'OUTCOME_UNKNOWN');assert.equal(driverCalls,0);
 const nextResult=(await controller.call('aicc_host_open',{...original,request_id:'new-independent-request'})).structuredContent;
 assert.equal(nextResult.status,'NOT_DISPATCHED');assert.equal(nextResult.reason,'FAKE_EXECUTOR_NOT_STARTED');
 assert.equal(driverCalls,1);
 assert.equal(fs.readFileSync(path.join(f.stateRoot,original.request_id+'.json'),'utf8'),originalBytes);
});

test('explicit open-session return uncertainty still blocks admission',async t=>{
 const f=fixture(t);let driverCalls=0;
 f.record('recorded-open-session','COMPLETED',{operation:'open',sessionState:'OPEN',session_id:'saved-session-id'});
 const before=f.snapshot();
 const controller=await createHostController(f.config,{connect:async()=>{driverCalls++;throw Error('DRIVER_MUST_NOT_RUN');}});
 t.after(()=>controller.close());
 const inventory=(await controller.call('aicc_host_sessions',{client_key:f.key})).structuredContent;
 assert.equal(inventory.capacity.historyBlocksNewWork,true);
 assert.equal(inventory.capacity.unreturnedRecordedSessions,1);
 assert.equal(inventory.capacity.availableSessions,null);assert.deepEqual(f.snapshot(),before);
 const opened=(await controller.call('aicc_host_open',{request_id:'new-during-return-hold',client_key:f.key,kind:'browser',url:'https://example.com/'})).structuredContent;
 assert.equal(opened.status,'NOT_DISPATCHED');assert.equal(opened.reason,'HOST_HISTORY_UNPROVEN');
 assert.equal(driverCalls,0);
});

test('corrupt journals retain their admission hold without a driver call',async t=>{
 const f=fixture(t);let driverCalls=0;
 fs.writeFileSync(path.join(f.stateRoot,'corrupt-journal-fixture.json'),'{');
 const controller=await createHostController(f.config,{connect:async()=>{driverCalls++;throw Error('DRIVER_MUST_NOT_RUN');}});
 t.after(()=>controller.close());
 const inventory=(await controller.call('aicc_host_sessions',{client_key:f.key})).structuredContent;
 assert.equal(inventory.capacity.history,'UNREADABLE');assert.equal(inventory.capacity.historyBlocksNewWork,true);
 assert.equal(inventory.capacity.availableSessions,null);
 const opened=(await controller.call('aicc_host_open',{request_id:'new-during-corruption',client_key:f.key,kind:'browser',url:'https://example.com/'})).structuredContent;
 assert.equal(opened.reason,'HOST_HISTORY_UNPROVEN');assert.equal(driverCalls,0);
});

test('historical normal-return proof resolves only this original resource; OUTCOME_UNKNOWN and journal bytes persist',async t=>{
 const f=historicalReturnFixture(t),controller=await historyController(t,f);
 const before=f.snapshot(),originalHash=sha(fs.readFileSync(path.join(f.stateRoot,f.openId+'.json')));
 const admissionBefore=(await controller.host.call('aicc_host_sessions',{client_key:f.key})).structuredContent;
 assert.equal(admissionBefore.capacity.historyBlocksNewWork,true);
 assert.equal(admissionBefore.capacity.unreturnedRecordedSessions,1);
 const oldStatusBefore=(await controller.host.call('aicc_host_operation_status',{request_id:f.openId,client_key:f.key})).structuredContent;
 assert.equal(oldStatusBefore.status,'OUTCOME_UNKNOWN');
 assert.equal(oldStatusBefore.resultEvicted,true);
 assert.equal(oldStatusBefore.replayed,false);
 const recovered=await controller.host.call('aicc_host_close',f.recovery);
 assert.equal(recovered.structuredContent.status,'HISTORY_RETURN_RECONCILED',JSON.stringify(recovered.structuredContent));
 assert.equal(recovered.structuredContent.resource_return,'PROVEN_NORMAL_CLOSE');
 assert.equal(recovered.structuredContent.original_outcome,'OUTCOME_UNKNOWN');
 assert.equal(recovered.structuredContent.original_outcome_unmodified,true);
 assert.equal(recovered.structuredContent.capacity.historyBlocksNewWork,false);
 assert.equal(controller.calls,0);
 assert.deepEqual(Object.fromEntries(Object.entries(f.snapshot()).filter(([name])=>name.endsWith('.json'))),before);
 assert.equal(sha(fs.readFileSync(path.join(f.stateRoot,f.openId+'.json'))),originalHash);
 const files=fs.readdirSync(path.join(f.stateRoot,'.history-return-receipts'));
 assert.deepEqual(files,[f.openId+'.json']);
 const originalAfter=(await controller.host.call('aicc_host_operation_status',{request_id:f.openId,client_key:f.key})).structuredContent;
 assert.equal(originalAfter.status,'OUTCOME_UNKNOWN');
 assert.equal(originalAfter.resultEvicted,true);
 assert.equal(originalAfter.history_return.status,'PROVEN_NORMAL_CLOSE_SEPARATE');
 const duplicate=(await controller.host.call('aicc_host_close',f.recovery)).structuredContent;
 assert.equal(duplicate.status,'HISTORY_RETURN_RECONCILED');
 assert.deepEqual(fs.readdirSync(path.join(f.stateRoot,'.history-return-receipts')),[f.openId+'.json']);
 const conflict=(await controller.host.call('aicc_host_close',{...f.recovery,request_id:'independent-return-reconcile-0002'})).structuredContent;
 assert.equal(conflict.status,'HOLD');
 assert.equal(conflict.reason,'HOST_RETURN_ALREADY_RECONCILED_DIFFERENT_REQUEST');
 const openRetry=(await controller.host.call('aicc_host_open',f.original)).structuredContent;
 assert.equal(openRetry.status,'OUTCOME_UNKNOWN');
 assert.equal(openRetry.replayed,false);
 assert.equal(controller.calls,0);
 const restart=readHostHistory(f.stateRoot);
 assert.equal(restart.resolved.length,1);
 assert.equal(restart.history.verifiedReturnReceipts,1);
 assert.equal(restart.recovered.filter(r=>r.operation==='open').length,0);
});

test('missing exact prior normal-return evidence holds original session, permits status reads, and blocks new open',async t=>{
 const f=historicalReturnFixture(t,{withClose:false}),controller=await historyController(t,f);
 const before=f.snapshot(),recovered=await controller.host.call('aicc_host_close',f.recovery);
 assert.equal(recovered.structuredContent.status,'HOLD');
 const oldStatus=(await controller.host.call('aicc_host_operation_status',{request_id:f.openId,client_key:f.key})).structuredContent;
 assert.equal(oldStatus.status,'OUTCOME_UNKNOWN');
 assert.equal(oldStatus.resultEvicted,true);
 const openNext=(await controller.host.call('aicc_host_open',{...f.original,request_id:'independent-after-missing-proof'})).structuredContent;
 assert.equal(openNext.status,'NOT_DISPATCHED');
 assert.equal(openNext.reason,'HOST_HISTORY_UNPROVEN');
 assert.equal(controller.calls,0);
 assert.equal(f.snapshot()[f.openId+'.json'],before[f.openId+'.json']);
 assert.equal(JSON.parse(f.snapshot()['independent-after-missing-proof.json']).phase,'NOT_DISPATCHED');
 assert.equal(fs.existsSync(path.join(f.stateRoot,'.history-return-receipts')),false);
});

test('historical return proof rejects other owner, generation, resource target, lease, wrong close outcome and untagged actions',async t=>{
 const cases={
  otherOwner:f=>{f.recovery.history_recovery.client_key='f'.repeat(64);},
  otherSession:f=>{f.recovery.session_id='another-session-00001';},
  otherGeneration:f=>{const file=path.join(f.stateRoot,f.closeId+'.json'),r=JSON.parse(fs.readFileSync(file));r.instanceId='wrong-generation-12345';fs.writeFileSync(file,JSON.stringify(r));},
  otherTarget:f=>{const file=path.join(f.stateRoot,f.closeId+'.json'),r=JSON.parse(fs.readFileSync(file));r.resourceTargetHash=sha('different-target');fs.writeFileSync(file,JSON.stringify(r));},
  wrongLease:f=>{f.recovery.lease='d'.repeat(64);},
  closeUnknown:f=>{const file=path.join(f.stateRoot,f.closeId+'.json'),r=JSON.parse(fs.readFileSync(file));r.phase='OUTCOME_UNKNOWN';fs.writeFileSync(file,JSON.stringify(r));},
  closePending:f=>{const file=path.join(f.stateRoot,f.closeId+'.json'),r=JSON.parse(fs.readFileSync(file));r.resultHash=sha('CLOSE_PENDING');fs.writeFileSync(file,JSON.stringify(r));},
  untaggedClose:f=>{const file=path.join(f.stateRoot,f.closeId+'.json'),r=JSON.parse(fs.readFileSync(file));delete r.hostAction;fs.writeFileSync(file,JSON.stringify(r));},
  requestHashWrong:f=>{const file=path.join(f.stateRoot,f.closeId+'.json'),r=JSON.parse(fs.readFileSync(file));r.requestHash=sha('not-original-close');fs.writeFileSync(file,JSON.stringify(r));},
  sourceNoCap:f=>{const file=path.join(f.stateRoot,f.openId+'.json'),r=JSON.parse(fs.readFileSync(file));delete r.capHash;fs.writeFileSync(file,JSON.stringify(r));},
  sourceNoTarget:f=>{const file=path.join(f.stateRoot,f.openId+'.json'),r=JSON.parse(fs.readFileSync(file));delete r.resourceTargetHash;fs.writeFileSync(file,JSON.stringify(r));}
 };
 for(const [name,mutate] of Object.entries(cases)){
  await t.test(name,async sub=>{
   const f=historicalReturnFixture(sub);mutate(f);
   const before=f.snapshot(),controller=await historyController(sub,f);
   const answer=(await controller.host.call('aicc_host_close',f.recovery)).structuredContent;
   assert.equal(answer.status,'HOLD',name+' unexpected success');
   assert.equal(answer.ok,false);
   assert.equal(controller.calls,0);
   assert.equal(fs.existsSync(path.join(f.stateRoot,'.history-return-receipts')),false);
   assert.deepEqual(f.snapshot(),before);
  });
 }
});

test('changed or forged sidecar cannot exempt original history; original status and owner binding stay intact',async t=>{
 for(const scenario of ['originalHashDrift','closeHashDrift','receiptTamper']){
  await t.test(scenario,async sub=>{
   const f=historicalReturnFixture(sub),controller=await historyController(sub,f);
   const settled=(await controller.host.call('aicc_host_close',f.recovery)).structuredContent;
   assert.equal(settled.status,'HISTORY_RETURN_RECONCILED');
   if(scenario==='originalHashDrift')fs.appendFileSync(path.join(f.stateRoot,f.openId+'.json'),' ');
   if(scenario==='closeHashDrift')fs.appendFileSync(path.join(f.stateRoot,f.closeId+'.json'),' ');
   if(scenario==='receiptTamper'){
    const file=path.join(f.stateRoot,'.history-return-receipts',f.openId+'.json');
    const receipt=JSON.parse(fs.readFileSync(file));receipt.resourceTargetHash=sha('foreign-target');
    fs.writeFileSync(file,JSON.stringify(receipt));
   }
   const refreshed=readHostHistory(f.stateRoot);
   assert.ok(refreshed.history.invalidReturnReceipts>0);
   assert.ok(refreshed.history.unreadableJournals>0);
   assert.equal(refreshed.resolved.length,0);
   assert.equal(refreshed.recovered.some(r=>r.request_id===f.openId),true);
   assert.equal(controller.calls,0);
  });
 }
});

test('legacy open without pinned session lease or resource target cannot be reconciled, regardless of older outcome',async t=>{
 const f=fixture(t);
 const owner='original-return-proof-owner';
 f.record(owner,'OUTCOME_UNKNOWN',{operation:'open',sessionState:'OPEN',session_id:'0db1d68d-7321-4de0-b531-f3c590ebe21a',instanceId:'legacy-instance-0001',kind:'browser'});
 const controller=await historyController(t,f);
 const action={session_id:'0db1d68d-7321-4de0-b531-f3c590ebe21a',lease:'e'.repeat(64),
  request_id:'independent-legacy-recovery-01',history_recovery:{open_request_id:owner,
  close_request_id:'missing-legacy-close-proof',client_key:f.key}};
 const result=(await controller.host.call('aicc_host_close',action)).structuredContent;
 assert.equal(result.status,'HOLD');
 assert.equal((await controller.host.call('aicc_host_sessions',{client_key:f.key})).structuredContent.capacity.historyBlocksNewWork,true);
 assert.equal(controller.calls,0);
});

test('host normal-return recovery changes only one optional existing close schema; owner status remains read-only',t=>{
 const names=HOST_TOOLS.map(tool=>tool.name);
 assert.equal(names.length,8);
 assert.equal(new Set(names).size,8);
 const close=HOST_TOOLS.find(tool=>tool.name==='aicc_host_close');
 assert.equal(close.annotations.readOnlyHint,false);
 assert.deepEqual(close.inputSchema.required,['session_id','lease','request_id']);
 assert.deepEqual(close.inputSchema.properties.history_recovery.required,
  ['open_request_id','close_request_id','client_key']);
 assert.equal(close.inputSchema.properties.history_recovery.additionalProperties,false);
 const status=HOST_TOOLS.find(tool=>tool.name==='aicc_host_operation_status');
 assert.equal(status.annotations.readOnlyHint,true);
 assert.deepEqual(status.inputSchema.required,['request_id','client_key']);
 assert.equal(status.inputSchema.additionalProperties,false);
 const f=historicalReturnFixture(t,{withClose:false});
 const history=readHostHistory(f.stateRoot);
 assert.equal(history.history.invalidReturnReceipts,0);
 assert.equal(history.recovered.some(x=>x.request_id===f.openId),true);
});

test('G1 history evidence read-only owner status explains missing legacy lease and target proof without changing UNKNOWN',async t=>{
 const f=fixture(t),id='original-host-history-owner-probe-0001';
 const original=f.record(id,'OUTCOME_UNKNOWN',{operation:'open',kind:'browser',
  session_id:'0db1d68d-7321-4de0-b531-f3c590ebe21a',
  instanceId:'historical-owner-generation-0001',sessionState:'UNKNOWN',error:'DRIVER_REFUSED'});
 const before=f.snapshot(),controller=await historyController(t,f);
 const s=(await controller.host.call('aicc_host_operation_status',{request_id:id,client_key:f.key})).structuredContent;
 assert.equal(s.status,'OUTCOME_UNKNOWN');assert.equal(s.resultEvicted,true);assert.equal(s.replayed,false);
 assert.deepEqual(s.returnEvidence,{
  status:'NORMAL_RETURN_UNPROVEN',
  recorded:{sessionId:true,generation:true,originalLeaseHash:false,exactTargetHash:false},
  missingProofs:['ORIGINAL_LEASE_HASH','EXACT_TARGET_HASH','VERIFIED_NORMAL_CLOSE_RECEIPT'],
  nextActor:'ORIGINAL_ISSUER_AND_EXACT_HOST_OWNER',originalOutcomeUnchanged:true,replayed:false
 });
 const owned=(await controller.host.call('aicc_host_sessions',{client_key:f.key})).structuredContent;
 assert.equal(owned.capacity.historyBlocksNewWork,true);
 assert.equal(owned.capacity.unreturnedRecordedSessions,1);
 assert.deepEqual(owned.recovered[0].returnEvidence,s.returnEvidence);
 const secretFields=JSON.stringify(s.returnEvidence);
 for(const name of ['ownerHash','capHash','resourceTargetHash','client_key','lease','endpoint','profile']){
  assert.equal(secretFields.includes('"'+name+'"'),false);
 }
 const foreign=(await controller.host.call('aicc_host_operation_status',{request_id:id,client_key:'d'.repeat(64)})).structuredContent;
 assert.equal(foreign.status,'HOLD');
 assert.equal(foreign.reason,'OPERATION_OWNER_MISMATCH');
 assert.equal(foreign.returnEvidence,undefined);
 const foreignSessions=(await controller.host.call('aicc_host_sessions',{client_key:'d'.repeat(64)})).structuredContent;
 assert.equal(foreignSessions.recovered.length,0);
 assert.equal(controller.calls,0);
 assert.deepEqual(f.snapshot(),before);
 assert.equal(original.sessionState,'UNKNOWN');
});

test('G1 history evidence does not equate recorded lease and target hashes with a verified return receipt',async t=>{
 const f=historicalReturnFixture(t,{withClose:false}),controller=await historyController(t,f);
 const before=f.snapshot();
 const s=(await controller.host.call('aicc_host_operation_status',{request_id:f.openId,client_key:f.key})).structuredContent;
 assert.equal(s.status,'OUTCOME_UNKNOWN');assert.equal(s.resultEvicted,true);
 assert.deepEqual(s.returnEvidence.recorded,{sessionId:true,generation:true,originalLeaseHash:true,exactTargetHash:true});
 assert.deepEqual(s.returnEvidence.missingProofs,['VERIFIED_NORMAL_CLOSE_RECEIPT']);
 assert.equal(s.returnEvidence.status,'NORMAL_RETURN_UNPROVEN');
 assert.equal((await controller.host.call('aicc_host_sessions',{client_key:f.key})).structuredContent.capacity.historyBlocksNewWork,true);
 assert.equal(controller.calls,0);assert.deepEqual(f.snapshot(),before);
});