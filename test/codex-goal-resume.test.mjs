import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectOriginalQueuedRequest} from '../src/codex-goal-resume.mjs';

function originalQueueFixture(){
 const threadId='11111111-1111-4111-8111-111111111111';
 const id='22222222-2222-4222-8222-222222222222',message='approved existing work';
 const attempt={threadId,id,queuedMessageId:'33333333-3333-4333-8333-333333333333',
  transport:'codex-queue',automaticReplay:false,marker:'AICC_QUEUE_ATTEMPT:'+id,
  messageSha256:createHash('sha256').update(message).digest('hex')};
 const turn={id:'44444444-4444-4444-8444-444444444444',status:'completed',items:[
  {type:'userMessage',content:[{type:'text',text:message+'\n\n'+attempt.marker}]}]};
 const thread={id:threadId,cwd:process.cwd(),status:{type:'idle'},turns:[turn]};
 const pages=[{data:[],nextCursor:null}],calls=[];
 const client={threadRead:async p=>{calls.push(['thread/read',p]);return {thread:structuredClone(thread)};},
  threadQueueListForInspection:async p=>{calls.push(['thread/queue/list',p]);return pages.shift();}};
 const options={threadId,projectRoot:process.cwd(),attempt,
  expectedAttemptSha256:createHash('sha256').update(JSON.stringify(attempt)).digest('hex'),client,
  manifest:{productionStableAllowlist:['thread/read','thread/queue/list']}};
 return {options,thread,turn,pages,calls,attempt};
}
test('original queue terminal read binds original message and turn without releasing pending',async()=>{
 const f=originalQueueFixture(),r=await inspectOriginalQueuedRequest(f.options);
 assert.equal(r.state,'ORIGINAL_QUEUE_EXACT_TERMINAL_OBSERVED_OWNER_SETTLEMENT_REQUIRED');
 assert.equal(r.turnId,f.turn.id);assert.equal(r.pendingPreserved,true);
 assert.equal(r.dispatchable,false);assert.equal(r.queueMutations,0);
 assert.deepEqual(f.calls.map(x=>x[0]),['thread/read','thread/queue/list','thread/read']);
});
test('original queue absence, unloaded owner and neighbouring turns never settle UNKNOWN',async()=>{
 for(const mode of ['absent','unloaded','wrong-text','multiple','saved-turn','status','root','missing-turns']){
  const f=originalQueueFixture();
  if(mode==='absent')f.thread.turns=[];
  if(mode==='unloaded')f.thread.status.type='notLoaded';
  if(mode==='wrong-text')f.turn.items[0].content[0].text='other\n\n'+f.attempt.marker;
  if(mode==='multiple')f.thread.turns.push(structuredClone(f.turn));
  if(mode==='status')f.turn.status='unknown';
  if(mode==='root')f.thread.cwd=path.dirname(process.cwd());
  if(mode==='missing-turns')delete f.thread.turns;
  if(mode==='saved-turn'){
   f.attempt.turnId='55555555-5555-4555-8555-555555555555';
   f.options.expectedAttemptSha256=createHash('sha256').update(JSON.stringify(f.attempt)).digest('hex');
  }
  const r=await inspectOriginalQueuedRequest(f.options);
  assert.match(r.state,/HOLD$/,mode);assert.equal(r.pendingPreserved,true,mode);
  assert.equal(r.queueMutations,0,mode);assert.equal(r.automaticReplay,false,mode);
 }
});
test('original queue reads all pages and recognises an exact queued ID without dispatch',async()=>{
 const f=originalQueueFixture();f.pages.splice(0,1,{data:[],nextCursor:'page-2'},
  {data:[{id:f.attempt.queuedMessageId}],nextCursor:null});
 const r=await inspectOriginalQueuedRequest(f.options);
 assert.equal(r.state,'ORIGINAL_QUEUE_STILL_QUEUED_HOLD');
 assert.equal(f.calls[2][1].cursor,'page-2');assert.equal(r.modelRequests,0);
});
test('original queue pagination, read failures and concurrent changes fail closed',async()=>{
 for(const mode of ['cycle','limit','malformed','read-error','drift','attempt-drift','duplicate']){
  const f=originalQueueFixture();
  if(mode==='cycle')f.pages.splice(0,1,{data:[],nextCursor:'x'},{data:[],nextCursor:'x'});
  if(mode==='limit'){f.options.maxPages=1;f.pages[0].nextCursor='x';}
  if(mode==='malformed')f.pages[0].data={};
  if(mode==='read-error')f.options.client.threadQueueListForInspection=async()=>{throw Error('private failure');};
  if(mode==='duplicate')f.pages[0].data=[{id:f.attempt.queuedMessageId},{id:f.attempt.queuedMessageId}];
  if(mode==='drift'||mode==='attempt-drift'){
   const original=f.options.client.threadQueueListForInspection;
   f.options.client.threadQueueListForInspection=async(...p)=>{
    const r=await original(...p);
    if(mode==='drift')f.thread.status.type='active';else f.attempt.messageSha256='a'.repeat(64);
    return r;
   };
  }
  const r=await inspectOriginalQueuedRequest(f.options);
  assert.match(r.state,/HOLD$/,mode);assert.equal(r.pendingPreserved,true,mode);
  assert.equal(r.queueMutations,0,mode);
 }
});
test('original queue invalid receipt and unsupported read fail before any transport',async()=>{
 for(const mode of ['sha','replay','marker','allowlist','id']){
  const f=originalQueueFixture();
  if(mode==='sha')f.options.expectedAttemptSha256='0'.repeat(64);
  if(mode==='replay')f.attempt.automaticReplay=true;
  if(mode==='marker')f.attempt.marker='neighbour';
  if(mode==='allowlist')f.options.manifest.productionStableAllowlist=['thread/read'];
  if(mode==='id')f.attempt.queuedMessageId='invalid';
  await assert.rejects(()=>inspectOriginalQueuedRequest(f.options),/exact_receipt/);
  assert.equal(f.calls.length,0,mode);
 }
});
import {goalSnapshotSha256,resumeExistingThreadGoal,inspectExistingGoalQuotaWindow,inspectOriginalOwnerQuotaReceiptPair,inspectSealedOriginalOwnerQuotaHandoff,verifyRegisteredOriginalIssuerCallback,prepareOriginalIssuerCallbackRegistration,inspectOriginalOcxSelectionQuotaChain} from '../src/codex-goal-resume.mjs';
function selectionFixture(t){
 const f=fixture('active'),clock=Date.parse('2026-11-14T06:00:00Z');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-ocx-selection-consumer-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const moduleFile=path.join(dir,'reader.mjs'),controlFile=path.join(dir,'control.json');
 fs.writeFileSync(moduleFile,`import fs from 'node:fs';
 export function readOriginalCliQuotaReceiptChain(){
 const f=${JSON.stringify(controlFile)}, c=JSON.parse(fs.readFileSync(f));c.reads++;fs.writeFileSync(f,JSON.stringify(c));
 if(c.error)throw Error('private error');
 if(c.registryFile){const r=JSON.parse(fs.readFileSync(c.registryFile));r.workerStopRequestedAt='2026-11-14T01:00:00Z';fs.writeFileSync(c.registryFile,JSON.stringify(r));}
 return c.source;
 }`);
 const sourceReaderPin={moduleFile,moduleSha256:createHash('sha256').update(fs.readFileSync(moduleFile)).digest('hex'),exportName:'readOriginalCliQuotaReceiptChain'};
 const registryFile=path.join(dir,'registrations.json');
 const cfg={schemaVersion:1,protocolVersion:3,threads:{[threadId]:{threadId,projectRoot:process.cwd(),enabled:true,executionSurface:'cli'}},originalOcxSelectionReader:sourceReaderPin};
 const save=()=>{fs.writeFileSync(registryFile,JSON.stringify(cfg));return createHash('sha256').update(fs.readFileSync(registryFile)).digest('hex');};
 const turnId='22222222-2222-4222-8222-222222222222';
 const source={state:'ORIGINAL_SELECTION_QUOTA_CHAIN_VERIFIED_SENDER_AUTHORITY_REQUIRED',threadId,turnId,accountIdSha256:'a'.repeat(64),credentialGeneration:3,
 failureReceiptSha256:'b'.repeat(64),attestationSha256:'c'.repeat(64),recoveryReceiptSha256:'d'.repeat(64),
 originalResetAt:clock/1000-30,observedAt:new Date(clock).toISOString(),quotaObservedAt:new Date(clock).toISOString(),backendLimitProven:false,
 originalTerminal:{threadId,turnId,terminalSha256:'e'.repeat(64),terminalType:'turn_failed'},
 sourceOnly:true,originalIssuerVerified:false,writerReturned:false,issuerAuthorityGranted:false,dispatchable:false,modelRequests:0,newTurns:0};
 const control={reads:0,source};
 const saveControl=()=>fs.writeFileSync(controlFile,JSON.stringify(control));saveControl();
 const options={...f.options,continuityRegistryFile:registryFile,expectedContinuityRegistrySha256:save(),sourceReaderPin,
 pin:{ownerRequestId:turnId,attestationSha256:source.attestationSha256,recoverySha256:source.recoveryReceiptSha256},now:()=>clock};
 return {f,source,cfg,options,save,moduleFile,control,saveControl,reads:()=>JSON.parse(fs.readFileSync(controlFile)).reads};
}
test('actual OCX selection receipt is accepted separately from an App Server failure, without granting sender rights',async t=>{
 const x=selectionFixture(t),r=await inspectOriginalOcxSelectionQuotaChain(x.options);
 assert.equal(r.sourceChainVerified,true);assert.equal(r.backendLimitProven,false);
 assert.equal(r.state,'ORIGINAL_OCX_SELECTION_CHAIN_VERIFIED_OWNER_CALLBACK_REQUIRED_HOLD');
 assert.equal(r.dispatchable,false);assert.equal(r.newTurns,0);assert.equal(r.queueAck,false);
 assert.equal(x.reads(),1);assert.equal(x.f.calls.length,0);
});
test('original pending, another historical pending and maintenance stop remain pre-read gates',async t=>{
 for(const mode of ['own','historical','stop','worker-stop','disabled','strict','missing-reader']){
  const x=selectionFixture(t);
  if(mode==='own')x.cfg.threads[threadId].attempt={state:'UNKNOWN'};
  if(mode==='historical')x.cfg.threads.other={queueAttempt:{state:'QUEUE_ACCEPTED'}};
  if(mode==='stop')x.cfg.workerStopRequestedAt='2026-11-14T01:00:00Z';
  if(mode==='worker-stop')x.cfg.worker={state:'STOPPED_FOR_MAINTENANCE'};
  if(mode==='disabled')x.cfg.threads[threadId].enabled=false;
  if(mode==='strict')x.cfg.threads[threadId].strictAccount=2;
  if(mode==='missing-reader')delete x.cfg.originalOcxSelectionReader;
  x.options.expectedContinuityRegistrySha256=x.save();
  const r=await inspectOriginalOcxSelectionQuotaChain(x.options);
  assert.match(r.state,/HOLD$/,mode);assert.equal(r.sourceChainVerified,undefined,mode);
  assert.equal(x.reads(),0,mode);assert.equal(x.f.calls.length,0,mode);
 }
});

test('selection recovery never authenticates a paused, budget-limited or completed goal',async t=>{
 for(const status of ['paused','blocked','budgetLimited','complete']){
  const x=selectionFixture(t);x.f.goal.status=status;
  x.options.expectedGoalSha256=goalSnapshotSha256(x.f.goal);
  const r=await inspectOriginalOcxSelectionQuotaChain(x.options);
  assert.equal(r.state,'ORIGINAL_SELECTION_CURRENT_GOAL_HOLD',status);
  assert.equal(r.dispatchable,false);assert.equal(x.f.calls.length,0);
 }
});

function signedSelectionFixture(t){
 const x=selectionFixture(t),clock=x.options.now();
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const executableFile=path.join(path.dirname(x.moduleFile),'producer.bin');
 fs.writeFileSync(executableFile,'fake-original-selection-owner');
 const hash=b=>createHash('sha256').update(b).digest('hex');
 const producer={kind:'aicc-original-cli-issuer-producer-pin/v1',
  route:'official-codex-to-17841-to-nonweb-OCX10101',keyId:'original-selection-test-key',
  executableFile,executableSha256:hash(fs.readFileSync(executableFile)),
  publicKeyPem:publicKey.export({type:'spki',format:'pem'}),
  publicKeySha256:hash(publicKey.export({type:'spki',format:'der'}))};
 const entry=x.cfg.threads[threadId];
 Object.assign(entry,{originalIssuerOwnerRevision:'1'.repeat(64),originalIssuerStopEpoch:3,
  originalIssuerPreviousStopEpoch:2,originalIssuerReceiptSha256:'2'.repeat(64),
  originalIssuerWriterProcessIdentitySha256:'3'.repeat(64)});
 const callback={kind:'aicc-original-cli-issuer-callback/v1',threadId,
  route:producer.route,projectRoot:x.options.projectRoot,goalSnapshotSha256:x.options.expectedGoalSha256,
  ownerRevision:entry.originalIssuerOwnerRevision,stopEpoch:3,previousStopEpoch:2,
  issuerReceiptSha256:entry.originalIssuerReceiptSha256,failedTurnId:x.source.turnId,
  terminalSha256:x.source.originalTerminal.terminalSha256,accountIdSha256:x.source.accountIdSha256,
  writerProcessIdentitySha256:entry.originalIssuerWriterProcessIdentitySha256,
  failureReceiptSha256:x.source.failureReceiptSha256,admissionReceiptSha256:x.source.recoveryReceiptSha256,
  quotaSourceKind:'ocx-selection',ownerRequestId:x.options.pin.ownerRequestId,
  credentialGeneration:x.source.credentialGeneration,attestationSha256:x.source.attestationSha256,
  originalIssuerBound:true,writerReturned:true,writerClosed:true};
 const receiptFile=path.join(path.dirname(x.moduleFile),'callback.json');
 x.cfg.originalGeneralCliIssuerProducer=producer;
 function seal(change={}){
  const payload={...callback,producerExecutableSha256:producer.executableSha256,
   observedAt:new Date(clock).toISOString(),...change};delete payload.signedSource;
  const bytes=Buffer.from(JSON.stringify(payload));
  callback.signedSource={kind:'aicc-original-cli-issuer-signed-source/v1',keyId:producer.keyId,
   payloadBase64:bytes.toString('base64'),signatureBase64:sign(null,bytes,privateKey).toString('base64')};
  fs.writeFileSync(receiptFile,JSON.stringify(callback));
  entry.originalIssuerQuotaCallback={kind:'aicc-original-cli-issuer-callback-pin/v1',
   receiptFile,receiptSha256:hash(fs.readFileSync(receiptFile))};
  x.options.expectedContinuityRegistrySha256=x.save();
 }
 seal();return {...x,entry,callback,producer,seal};
}

test('real selection chain joins independently signed owner without fabricating backend exhaustion',async t=>{
 const x=signedSelectionFixture(t),r=await inspectOriginalOcxSelectionQuotaChain(x.options);
 assert.equal(r.callbackSourceAuthenticated,true);assert.equal(r.sourceChainVerified,true);
 assert.equal(r.backendLimitProven,false);assert.equal(r.dispatchable,false);
 assert.equal(r.issuerAuthorityGranted,false);assert.equal(r.queueAck,false);
 assert.equal(r.modelRequests,0);assert.equal(r.newTurns,0);
 assert.equal(r.stopEpoch,3);assert.equal(x.f.calls.length,0);
});

test('signed selection rejects account, credential, request, terminal, owner, epoch, stop and replay drift',async t=>{
 for(const mode of ['account','generation','request','attestation','terminal','owner','epoch','process',
  'signature','stale','unregistered','pending','stop','writer','callback-during-goal-read']){
  const x=signedSelectionFixture(t);
  if(mode==='account')x.callback.accountIdSha256='f'.repeat(64);
  if(mode==='generation')x.callback.credentialGeneration++;
  if(mode==='request')x.callback.ownerRequestId=threadId;
  if(mode==='attestation')x.callback.attestationSha256='f'.repeat(64);
  if(mode==='terminal')x.callback.terminalSha256='f'.repeat(64);
  if(mode==='owner')x.entry.originalIssuerOwnerRevision='f'.repeat(64);
  if(mode==='epoch')x.entry.originalIssuerStopEpoch++;
  if(mode==='process')x.entry.originalIssuerWriterProcessIdentitySha256='f'.repeat(64);
  if(mode==='unregistered')delete x.cfg.originalGeneralCliIssuerProducer;
  if(mode==='pending')x.cfg.threads.other={attempt:{state:'UNKNOWN'}};
  if(mode==='stop')x.cfg.workerStopRequestedAt='preserved';
  if(mode==='writer')x.callback.writerReturned=false;
  x.seal(mode==='stale'?{observedAt:new Date(x.options.now()-120001).toISOString()}:{});
  if(mode==='signature'){
   x.callback.signedSource.signatureBase64='A'.repeat(86)+'==';
   const pin=x.entry.originalIssuerQuotaCallback;
   fs.writeFileSync(pin.receiptFile,JSON.stringify(x.callback));
   pin.receiptSha256=createHash('sha256').update(fs.readFileSync(pin.receiptFile)).digest('hex');
   x.options.expectedContinuityRegistrySha256=x.save();
  }
  if(mode==='callback-during-goal-read')x.options.client.threadGoalGet=async()=>{
   fs.appendFileSync(x.entry.originalIssuerQuotaCallback.receiptFile,' ');return {goal:x.f.goal};};
  const r=await inspectOriginalOcxSelectionQuotaChain(x.options);
  assert.notEqual(r.callbackSourceAuthenticated,true,mode);assert.match(r.state,/HOLD$/,mode);
  assert.equal(r.dispatchable,false,mode);assert.equal(r.modelRequests,0,mode);
  assert.equal(x.f.calls.length,0,mode);
 }
});
test('repinned source changes and changes while awaiting original source or goal remain HOLD',async t=>{
 for(const mode of ['account','turn','generation','stale','future','quota-stale','before-reset','quota-before-reset','issuer','writer','dispatch','terminal','hash','goal','not-loaded','module','stop-during-read','module-during-read','transport']){
  const x=selectionFixture(t);
  if(mode==='account')x.source.accountIdSha256='bad';
  if(mode==='turn')x.source.threadId='33333333-3333-4333-8333-333333333333';
  if(mode==='generation')x.source.credentialGeneration=-1;
  if(mode==='stale')x.source.observedAt=new Date(x.options.now()-60000).toISOString();
  if(mode==='future')x.source.observedAt=new Date(x.options.now()+1).toISOString();
  if(mode==='quota-stale')x.source.quotaObservedAt=new Date(x.options.now()-60000).toISOString();
  if(mode==='before-reset')x.source.originalResetAt=x.options.now()/1000+1;
  if(mode==='quota-before-reset')x.source.quotaObservedAt=new Date(x.source.originalResetAt*1000-1).toISOString();
  if(mode==='issuer')x.source.issuerAuthorityGranted=true;
  if(mode==='writer')x.source.writerReturned=true;
  if(mode==='dispatch')x.source.modelRequests=1;
  if(mode==='terminal')x.source.originalTerminal.turnId=threadId;
  if(mode==='hash')x.source.recoveryReceiptSha256='e'.repeat(64);
  if(mode==='goal')x.f.goal.updatedAt++;
  if(mode==='not-loaded')x.options.client.threadRead=async()=>({thread:{id:threadId,cwd:process.cwd(),status:{type:'notLoaded'}}});
  if(mode==='module')fs.appendFileSync(x.moduleFile,'// changed');
  if(mode==='stop-during-read')x.control.registryFile=x.options.continuityRegistryFile;
  if(mode==='module-during-read')x.options.client.threadGoalGet=async()=>{fs.appendFileSync(x.moduleFile,'// changed');return {goal:x.f.goal};};
  if(mode==='transport')x.control.error=true;
  x.saveControl();
  const r=await inspectOriginalOcxSelectionQuotaChain(x.options);
  assert.match(r.state,/HOLD$/,mode);assert.equal(r.sourceChainVerified,undefined,mode);
  assert.equal(r.dispatchable,false,mode);assert.equal(x.f.calls.length,0,mode);
  assert.equal(JSON.stringify(r).includes('private error'),false,mode);
 }
});
const threadId='01a1c19b-5641-7a50-9168-19e87601b1ef';
function fixture(status='blocked') {
 const goal={threadId,objective:'Finish existing work',status,createdAt:1,updatedAt:2,tokensUsed:100,timeUsedSeconds:50};
 const calls=[];
 const client={threadRead:async()=>({thread:{id:threadId,cwd:process.cwd(),status:{type:'active'}}}),
   threadGoalGet:async()=>({goal}),threadGoalResumeForUser:async(params,authorization)=>{calls.push({params,authorization});return {goal:{...goal,status:'active',updatedAt:3}};}};
 return {goal,calls,options:{client,manifest:{productionStableAllowlist:['thread/read','thread/goal/get'],userGoalResume:{method:'thread/goal/set',provenanceField:'origin'}},threadId,projectRoot:process.cwd(),expectedGoalSha256:goalSnapshotSha256(goal),authorization:{kind:'explicit-user-goal-resume',threadId,reference:'current-user-request'}}};
}
test('explicit resume preserves objective, budget and usage; sends no turn or thread resume',async()=>{
 const f=fixture();const r=await resumeExistingThreadGoal(f.options);
 assert.equal(r.state,'GOAL_ACTIVE');assert.deepEqual(f.calls,[{params:{threadId},authorization:f.options.authorization}]);
 assert.equal(r.goal.tokensUsed,100);assert.equal(r.automaticQuotaResumeProven,false);
});
test('missing authorization, stale goal, and wrong root fail before mutation',async()=>{
 for(const variant of ['authorization','snapshot','root']){
  const f=fixture();if(variant==='authorization')f.options.authorization=null;
  if(variant==='snapshot')f.goal.updatedAt=99;
  if(variant==='root')f.options.projectRoot=process.cwd()+'/wrong';
  await assert.rejects(resumeExistingThreadGoal(f.options));assert.equal(f.calls.length,0);
 }
});
test('usage, budget and complete states require separate contracts; active is idempotent',async()=>{
 for(const status of ['usageLimited','budgetLimited','complete']){
  const f=fixture(status);await assert.rejects(resumeExistingThreadGoal(f.options),/separate_contract/);assert.equal(f.calls.length,0);
 }
 const f=fixture('active');assert.equal((await resumeExistingThreadGoal(f.options)).state,'ALREADY_ACTIVE');assert.equal(f.calls.length,0);
});
test('a different server cannot resume a goal owned outside its loaded threads',async()=>{
 const f=fixture();f.options.client.threadRead=async()=>({thread:{id:threadId,cwd:process.cwd(),status:{type:'notLoaded'}}});
 await assert.rejects(resumeExistingThreadGoal(f.options),/original_owner_transport/);assert.equal(f.calls.length,0);
});
test('ambiguous RPC and changed goal reply preserve uncertainty without retries',async()=>{
 for(const kind of ['timeout','changed']){
  const f=fixture();f.options.client.threadGoalResumeForUser=async()=>{f.calls.push(kind);if(kind==='timeout')throw Object.assign(Error(),{code:'request_timeout'});return {goal:{...f.goal,status:'active',objective:'replacement'}};};
  const r=await resumeExistingThreadGoal(f.options);assert.equal(r.state,'RESUME_UNCONFIRMED');assert.equal(r.automaticRetry,false);assert.equal(f.calls.length,1);
 }
});
function readFixture(){
 const f=fixture('active');
 f.options.manifest.officialQuotaRead={
   method:'account/rateLimits/read',readOnly:true,originalCliIssuerBound:false,
   quotaRecoveryAuthority:false,senderAllowed:false};
 f.options.manifest.productionStableAllowlist.push('account/rateLimits/read');
 const queried=[];
 f.options.client.rateLimitsReadForInspection=async()=>{
   queried.push('account/rateLimits/read');
   return {rateLimitsByLimitId:{codex:{limitId:'codex',primary:{
     windowDurationMins:15,usedPercent:25,resetsAt:1790000000},
     secondary:{windowDurationMins:300,usedPercent:26,resetsAt:1790000300},
     rateLimitReachedType:null}}};
 };
 return {f,queried};
}
test('official five-hour quota read is observational even after window recovers; old active goal never changes',async()=>{
 const {f,queried}=readFixture();
 const before=goalSnapshotSha256(f.goal);
 const value=await inspectExistingGoalQuotaWindow({...f.options,now:()=>1780000000000});
 assert.equal(value.state,'OFFICIAL_FIVE_HOUR_WINDOW_READABLE_OWNER_RELEASE_HOLD');
 assert.equal(value.quota.window,'secondary');
 assert.equal(value.quota.usedPercent,26);
 assert.deepEqual(queried,['account/rateLimits/read']);
 assert.equal(f.calls.length,0);
 assert.equal(goalSnapshotSha256(f.goal),before);
 assert.equal(value.originalIssuerVerified,false);
 assert.equal(value.ownerRevisionVerified,false);
 assert.equal(value.stopEpochVerified,false);
 assert.equal(value.dispatchable,false);
 assert.equal(value.modelRequests,0);
 assert.equal(value.newTurns,0);
 assert.equal(value.queueOperations,0);
});
test('limit, missing bucket, ambiguous bucket, read failure and unsupported contract remain HOLD',async()=>{
 const cases=[
  ['limited',async()=>({rateLimits:{limitId:'codex',secondary:{windowDurationMins:300,usedPercent:100,resetsAt:1790000300}}}),'OFFICIAL_FIVE_HOUR_QUOTA_STILL_LIMITED_HOLD'],
  ['missing',async()=>({rateLimits:{limitId:'codex',primary:{windowDurationMins:15,usedPercent:0,resetsAt:1790000300}}}),'FIVE_HOUR_QUOTA_BUCKET_NOT_RETURNED_HOLD'],
  ['ambiguous',async()=>({rateLimitsByLimitId:{codex:{limitId:'codex',secondary:{windowDurationMins:300,usedPercent:0,resetsAt:1790000300}},codex_other:{limitId:'codex_other',secondary:{windowDurationMins:300,usedPercent:0,resetsAt:1790000300}}}}),'AMBIGUOUS_FIVE_HOUR_QUOTA_BUCKET_HOLD'],
  ['unknown',async()=>{throw Object.assign(Error('private'),{code:'request_timeout'});},'OFFICIAL_QUOTA_READ_UNKNOWN_NO_RETRY']
 ];
 for(const [name,fn,state] of cases){
   const {f}=readFixture();
   f.options.client.rateLimitsReadForInspection=fn;
   const observed=await inspectExistingGoalQuotaWindow(f.options);
   assert.equal(observed.state,state,name);
   assert.equal(observed.dispatchable,false,name);
   assert.equal(observed.automaticRetry,false,name);
   assert.equal(f.calls.length,0,name);
 }
 const {f}=readFixture();
 f.options.manifest.officialQuotaRead=null;
 await assert.rejects(inspectExistingGoalQuotaWindow(f.options),/exact_installed_contract_required/);
});
test('goal drift, original thread mismatch and non-active goal prevent even official quota read',async()=>{
 for(const variant of ['goal','thread','status']){
   const {f,queried}=readFixture();
   if(variant==='goal')f.goal.updatedAt=100;
   if(variant==='thread')f.options.client.threadRead=async()=>({thread:{
     id:threadId,cwd:process.cwd()+'/other',status:{type:'active'}}});
   if(variant==='status')f.goal.status='paused',f.options.expectedGoalSha256=goalSnapshotSha256(f.goal);
   const value=await inspectExistingGoalQuotaWindow(f.options);
   assert.match(value.state,/_HOLD$/);
   assert.equal(queried.length,0);
   assert.equal(f.calls.length,0);
 }
});
const qSha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function quotaSourceFixture(){
 const f=fixture('active');
 const at=Date.parse('2026-11-14T00:00:00.000Z');
 const reset=Math.floor(Date.parse('2026-11-14T01:00:00.000Z')/1000);
 const ownerContext={kind:'aicc-original-cli-owner-context/v1',
  threadId,projectRoot:process.cwd(),goalSnapshotSha256:goalSnapshotSha256(f.goal),
  route:'official-codex-to-17841-to-nonweb-OCX10101',
  ownerRevision:'a'.repeat(64),stopEpoch:5,issuerReceiptSha256:'b'.repeat(64),
  quotaLimitId:'codex'};
 const failureReceipt={schemaVersion:1,kind:'aicc-app-server-owned-five-hour-failure/v1',
  ownerContext,ownerContextSha256:qSha(ownerContext),
  threadId,failedTurnId:'ababaaba-aaaa-4aaa-baaa-aaaaaaaaaaaa',errorInfo:'usageLimitExceeded',
  terminalType:'turn/completed',terminalSha256:'c'.repeat(64),writerProcessIdentitySha256:'d'.repeat(64),
  observedAt:new Date(at).toISOString(),originalOcxIssuerVerified:false,
  quota:{limitId:'codex',window:'secondary',usedPercent:100,rateLimitReachedType:'rate_limit_reached',
   ordinaryUsageAllowed:false,resetsAt:reset,accountIdSha256:'e'.repeat(64)}};
 const admissionReceipt={schemaVersion:1,kind:'aicc-app-server-owned-five-hour-admission/v1',
  ownerContextSha256:failureReceipt.ownerContextSha256,
  writerProcessIdentitySha256:failureReceipt.writerProcessIdentitySha256,
  failureReceiptSha256:qSha(failureReceipt),
  observedAt:new Date(reset*1000+1000).toISOString(),originalOcxIssuerVerified:false,
  quota:{limitId:'codex',window:'secondary',usedPercent:3,rateLimitReachedType:null,spendControlReached:false,
   ordinaryUsageAllowed:true,resetsAt:reset+18000,accountIdSha256:'e'.repeat(64)}};
 const originalOwnerProof={ownerRevision:ownerContext.ownerRevision,
  stopEpoch:ownerContext.stopEpoch,issuerReceiptSha256:ownerContext.issuerReceiptSha256,
  sourceWriterReceiptSha256:qSha(failureReceipt),returned:true,closed:true};
 const options={...f.options,failureReceipt,admissionReceipt,
  originalOwnerProof,expectedFailureReceiptSha256:qSha(failureReceipt),
  expectedAdmissionReceiptSha256:qSha(admissionReceipt),globalPendingCount:0,
  now:()=>reset*1000+10000};
 return {f,options};
}
test('original sender failure and fresh backend admission produces only owner-gated source candidate',async()=>{
 const {f,options}=quotaSourceFixture();
 const r=await inspectOriginalOwnerQuotaReceiptPair(options);
 assert.equal(r.state,'RECEIPT_CHAIN_MATCHED_EXTERNAL_OWNER_GATE_REQUIRED');
 assert.equal(r.afterReset,true);
 assert.equal(r.backendOrdinaryUsageAllowed,true);
 assert.equal(r.issuerAuthorityGranted,false);
 assert.equal(r.originalOcxIssuerVerified,false);
 assert.equal(r.dispatchable,false);
 assert.equal(r.newTurns,0);
 assert.equal(f.calls.length,0);
});
test('original sender receipt consumer refuses unknown, changed goal, sender, quota and pending',async()=>{
 for(const mode of ['sha','account','owner','stop','pending','goal','ordinary','time','unknown']){
  const {f,options}=quotaSourceFixture();
  if(mode==='sha')options.failureReceipt.terminalSha256='f'.repeat(64);
  if(mode==='account')options.admissionReceipt.quota.accountIdSha256='f'.repeat(64);
  if(mode==='owner')options.originalOwnerProof.ownerRevision='f'.repeat(64);
  if(mode==='stop')options.originalOwnerProof.stopEpoch=9;
  if(mode==='pending')options.globalPendingCount=1;
  if(mode==='goal')f.goal.updatedAt=77;
  if(mode==='ordinary')options.admissionReceipt.quota.ordinaryUsageAllowed=null;
  if(mode==='time')options.now=()=>Date.parse('2026-11-14T04:00:00.000Z');
  if(mode==='unknown')options.client.threadRead=async()=>{throw Object.assign(Error('secret'),{code:'transport_unknown'});};
  // Every post-mutation receipt is independently re-signed in this synthetic
  // test except the deliberate stale-SHA case. This is still not issuer auth.
  if(!['sha','owner','stop','pending','goal','time','unknown'].includes(mode))
   options.expectedAdmissionReceiptSha256=qSha(options.admissionReceipt);
  const r=await inspectOriginalOwnerQuotaReceiptPair(options);
  assert.match(r.state,/HOLD|UNKNOWN/);
  assert.equal(r.dispatchable,false);
  assert.equal(f.calls.length,0);
 }
});
test('source quota receipt pair rejects missing 300-minute window, mismatched window, NaN and invalid percentages despite repinned SHA',async()=>{
 const changes=[
  ['missing-failed-window',o=>{delete o.failureReceipt.quota.window;}],
  ['missing-fresh-window',o=>{delete o.admissionReceipt.quota.window;}],
  ['wrong-window',o=>{o.failureReceipt.quota.window='quarterHour';}],
  ['mismatched-window',o=>{o.admissionReceipt.quota.window='primary';}],
  ['failed-NaN',o=>{o.failureReceipt.quota.usedPercent=NaN;}],
  ['failed-Infinity',o=>{o.failureReceipt.quota.usedPercent=Infinity;}],
  ['failed-over100',o=>{o.failureReceipt.quota.usedPercent=101;}],
  ['failed-negative',o=>{o.failureReceipt.quota.usedPercent=-1;}],
  ['fresh-NaN',o=>{o.admissionReceipt.quota.usedPercent=NaN;}],
  ['fresh-negative',o=>{o.admissionReceipt.quota.usedPercent=-2;}],
  ['fresh-Infinity',o=>{o.admissionReceipt.quota.usedPercent=-Infinity;}],
  ['fresh-100',o=>{o.admissionReceipt.quota.usedPercent=100;}],
  ['fresh-not-number',o=>{o.admissionReceipt.quota.usedPercent='4';}],
  ['missing-failed-percent',o=>{delete o.failureReceipt.quota.usedPercent;}],
  ['missing-fresh-percent',o=>{delete o.admissionReceipt.quota.usedPercent;}],
  ['wrong-limit',o=>{o.admissionReceipt.quota.limitId='codex_other';}],
  ['missing-reset',o=>{delete o.admissionReceipt.quota.resetsAt;}],
  ['old-reset',o=>{o.admissionReceipt.quota.resetsAt=o.failureReceipt.quota.resetsAt;}],
  ['future-reset',o=>{o.admissionReceipt.quota.resetsAt=o.failureReceipt.quota.resetsAt+25000;}],
  ['unknown-spend',o=>{o.admissionReceipt.quota.spendControlReached=null;}],
  ['schema-changed',o=>{o.admissionReceipt.schemaVersion=2;}],
  ['terminal-kind-changed',o=>{o.failureReceipt.terminalType='turn/started';}]
 ];
 for(const [name,mutate] of changes){
  const {f,options}=quotaSourceFixture();
  mutate(options);
  options.expectedFailureReceiptSha256=qSha(options.failureReceipt);
  options.admissionReceipt.failureReceiptSha256=options.expectedFailureReceiptSha256;
  options.expectedAdmissionReceiptSha256=qSha(options.admissionReceipt);
  options.originalOwnerProof.sourceWriterReceiptSha256=options.expectedFailureReceiptSha256;
  const result=await inspectOriginalOwnerQuotaReceiptPair(options);
  assert.match(result.state,/HOLD$/,name);
  assert.equal(result.dispatchable,false,name);
  assert.equal(result.newTurns,0,name);
  assert.equal(f.calls.length,0,name);
 }
});

function sealedOwnerHandoffFixture(t){
 const f=quotaSourceFixture(),o=f.options,ctx=o.failureReceipt.ownerContext,
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-original-issuer-handoff-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const put=(name,value)=>{const file=path.join(dir,name);fs.writeFileSync(file,JSON.stringify(value));return {file,sha256:qSha(value)};};
 const failure=put('failure.json',o.failureReceipt),admission=put('admission.json',o.admissionReceipt);
 const candidate=put('handoff.json',{
  schemaVersion:1,kind:'aicc-original-cli-quota-source-owner-handoff/v1',
  status:'SOURCE_RECEIPTS_PINNED_OWNER_AUTHORITY_NOT_GRANTED',
  threadId,projectRoot:process.cwd(),goalSnapshotSha256:o.expectedGoalSha256,
  route:ctx.route,ownerRevision:ctx.ownerRevision,stopEpoch:ctx.stopEpoch,
  originalIssuerReceiptSha256:ctx.issuerReceiptSha256,
  failedTurnId:o.failureReceipt.failedTurnId,terminalSha256:o.failureReceipt.terminalSha256,
  accountIdSha256:o.failureReceipt.quota.accountIdSha256,quotaLimitId:ctx.quotaLimitId,
  originalFiveHourResetAt:o.failureReceipt.quota.resetsAt,
  recordedOwnerProcessSha256:o.failureReceipt.writerProcessIdentitySha256,
  sources:{failure,admission},
  originalIssuerAttested:false,originalOwnerReleased:false,dispatchable:false,
  modelRequests:0,newTurns:0
 });
 let cfg={
  schemaVersion:1,protocolVersion:3,
  threads:{[threadId]:{threadId,projectRoot:process.cwd(),strictAccount:null,
   groupOwnerOnly:false,enabled:true,attempt:null,queueAttempt:null}},
  excludedThreadIds:[],workerStopRequestedAt:'2026-11-14T00:00:00.000Z',
  worker:{state:'STOPPED_FOR_MAINTENANCE'}
 };
 const registryFile=path.join(dir,'registrations.json');
 const writeRegistry=()=>{fs.writeFileSync(registryFile,JSON.stringify(cfg));return qSha(cfg);};
 let registrySha256=writeRegistry();
 const run=(overrides={})=>inspectSealedOriginalOwnerQuotaHandoff({
  client:o.client,manifest:o.manifest,threadId,
  projectRoot:process.cwd(),expectedGoalSha256:o.expectedGoalSha256,
  handoffFile:candidate.file,expectedHandoffFileSha256:candidate.sha256,
  continuityRegistryFile:registryFile,expectedContinuityRegistrySha256:registrySha256,
  now:o.now,...overrides
 });
 function writeCallback(change={}){
  const callback={
   kind:'aicc-original-cli-issuer-callback/v1',threadId,route:ctx.route,
   projectRoot:process.cwd(),goalSnapshotSha256:o.expectedGoalSha256,
   ownerRevision:ctx.ownerRevision,stopEpoch:ctx.stopEpoch,
   previousStopEpoch:ctx.stopEpoch,
   issuerReceiptSha256:ctx.issuerReceiptSha256,
   failedTurnId:o.failureReceipt.failedTurnId,terminalSha256:o.failureReceipt.terminalSha256,
   accountIdSha256:o.failureReceipt.quota.accountIdSha256,
   writerProcessIdentitySha256:o.failureReceipt.writerProcessIdentitySha256,
   failureReceiptSha256:qSha(o.failureReceipt),
   admissionReceiptSha256:qSha(o.admissionReceipt),
   originalIssuerBound:true,writerReturned:true,writerClosed:true,...change
  };
  const pin=put('original-issuer-callback.json',callback);
  cfg.threads[threadId].originalIssuerQuotaCallback={
   kind:'aicc-original-cli-issuer-callback-pin/v1',receiptFile:pin.file,receiptSha256:pin.sha256};
  registrySha256=writeRegistry();
 }
 return {f,o,dir,run,cfg,candidate,writeCallback,
  save:()=>{registrySha256=writeRegistry();},file:registryFile,
  options:()=>({client:o.client,manifest:o.manifest,threadId,projectRoot:process.cwd(),
   expectedGoalSha256:o.expectedGoalSha256,handoffFile:candidate.file,
   expectedHandoffFileSha256:candidate.sha256,continuityRegistryFile:registryFile,
   expectedContinuityRegistrySha256:registrySha256,now:o.now})};
}
test('sealed original sender handoff reads current registered owner, keeps historical pending and maintenance stop',async t=>{
 const f=sealedOwnerHandoffFixture(t);
 const first=await f.run();
 assert.equal(first.state,'MAINTENANCE_STOP_EPOCH_PRESERVED_HOLD');
 assert.equal(first.dispatchable,false);
 assert.equal(first.modelRequests,0);
 f.cfg.threads['aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa']={
  threadId:'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa',attempt:{id:'historical-pending'}};
 f.save();
 const pending=await f.run();
 assert.equal(pending.state,'HISTORICAL_OR_UNKNOWN_PENDING_SETTLEMENT_HOLD');
 f.cfg.threads['aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa'].attempt=null;
 f.cfg.workerStopRequestedAt=null;f.cfg.worker.state='STOPPED_BUT_NO_FENCE';
 f.save();
 assert.equal((await f.run()).state,'ORIGINAL_GENERAL_CLI_ISSUER_CALLBACK_NOT_REGISTERED_HOLD');
 f.writeCallback();
 const matched=await f.run();
 assert.equal(matched.state,'REGISTERED_CALLBACK_SOURCE_CHAIN_MATCHED_SENDER_AUTHORITY_REQUIRED');
 assert.equal(matched.issuerAuthorityGranted,false);
 assert.equal(matched.dispatchable,false);
 assert.equal(matched.newTurns,0);
 assert.equal(f.f.f.calls.length,0);
});

function signedOriginalCallbackFixture(t){
 const f=sealedOwnerHandoffFixture(t);
 f.cfg.workerStopRequestedAt=null;f.cfg.worker.state='STOPPED_BUT_NO_FENCE';
 f.writeCallback();
 const file=f.cfg.threads[threadId].originalIssuerQuotaCallback.receiptFile;
 const callback=JSON.parse(fs.readFileSync(file,'utf8'));
 const binding={...callback};delete binding.kind;
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const executableFile=path.join(f.dir,'producer.bin');fs.writeFileSync(executableFile,'fake-original-owner-producer');
 const producer={kind:'aicc-original-cli-issuer-producer-pin/v1',
  route:callback.route,keyId:'original-owner-test-key',executableFile,
  executableSha256:createHash('sha256').update(fs.readFileSync(executableFile)).digest('hex'),
  publicKeyPem:publicKey.export({type:'spki',format:'pem'}),
  publicKeySha256:createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex')};
 const clock=f.o.now();
 function seal(change={}){
  const payload={...callback,producerExecutableSha256:producer.executableSha256,
   observedAt:new Date(clock).toISOString(),...change};delete payload.signedSource;
  const bytes=Buffer.from(JSON.stringify(payload));
  callback.signedSource={kind:'aicc-original-cli-issuer-signed-source/v1',keyId:producer.keyId,
   payloadBase64:bytes.toString('base64'),signatureBase64:sign(null,bytes,privateKey).toString('base64')};
 }
 seal();
 function install(){
  fs.writeFileSync(file,JSON.stringify(callback));
  f.cfg.originalGeneralCliIssuerProducer=producer;
  f.cfg.threads[threadId].originalIssuerOwnerRevision=callback.ownerRevision;
  f.cfg.threads[threadId].originalIssuerStopEpoch=callback.stopEpoch;
  f.cfg.threads[threadId].originalIssuerReceiptSha256=callback.issuerReceiptSha256;
  f.cfg.threads[threadId].originalIssuerPreviousStopEpoch=callback.previousStopEpoch;
  f.cfg.threads[threadId].originalIssuerQuotaCallback.receiptSha256=qSha(callback);f.save();
 }
 return {f,callback,binding,producer,seal,install,clock,
  verify:()=>verifyRegisteredOriginalIssuerCallback({callback,binding,producer,now:()=>clock})};
}
test('independently pinned original producer authenticates exact signed source without dispatch rights',async t=>{
 const f=signedOriginalCallbackFixture(t);assert.equal(f.verify().authenticated,true);
 f.install();const observed=await f.f.run();
 assert.equal(observed.callbackSourceAuthenticated,true);
 assert.equal(observed.dispatchable,false);assert.equal(observed.issuerAuthorityGranted,false);
 assert.equal(observed.modelRequests,0);assert.equal(observed.originalQueueAck,false);
});
test('original producer rejects forged signatures, executable drift, wrong issuer, goal, epoch and stale source',t=>{
 for(const mode of ['signature','payload','key','executable','account','goal','epoch','negative-epoch','old','future','unregistered']){
  const f=signedOriginalCallbackFixture(t);
  if(mode==='signature')f.callback.signedSource.signatureBase64='A'.repeat(86)+'==';
  if(mode==='payload')f.callback.signedSource.payloadBase64=Buffer.from('{}').toString('base64');
  if(mode==='key')f.producer.publicKeySha256='0'.repeat(64);
  if(mode==='executable')fs.writeFileSync(f.producer.executableFile,'changed');
  if(mode==='account')f.seal({accountIdSha256:'f'.repeat(64)});
  if(mode==='goal')f.seal({goalSnapshotSha256:'f'.repeat(64)});
  if(mode==='epoch')f.binding.stopEpoch++;
  if(mode==='negative-epoch'){f.callback.previousStopEpoch=-1;f.binding.previousStopEpoch=-1;f.seal();}
  if(mode==='old')f.seal({observedAt:new Date(f.clock-120001).toISOString()});
  if(mode==='future')f.seal({observedAt:new Date(f.clock+1).toISOString()});
  if(mode==='unregistered')f.producer.kind='self-declared-producer';
  const result=f.verify();assert.equal(result.authenticated,false,mode);
  assert.equal(result.dispatchable,false,mode);assert.match(result.state,/HOLD$/,mode);
 }
});
test('signed original callback preserves pending, explicit stop and live-writer fences',async t=>{
 for(const mode of ['pending','stop','writer','previous-epoch','duplicate-owner','registered-revision','registered-epoch','registered-issuer']){
  const f=signedOriginalCallbackFixture(t);f.install();
  if(mode==='pending')f.f.cfg.threads['aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa']={queueAttempt:{state:'QUEUE_ACCEPTED'}};
  if(mode==='stop')f.f.cfg.workerStopRequestedAt='2026-11-14T00:00:00Z';
  if(mode==='writer'){f.callback.writerReturned=false;f.seal();f.install();}
  if(mode==='previous-epoch')f.f.cfg.threads[threadId].originalIssuerPreviousStopEpoch++;
  if(mode==='duplicate-owner')f.f.cfg.threads[threadId].strictAccount=2;
  if(mode==='registered-revision')f.f.cfg.threads[threadId].originalIssuerOwnerRevision='f'.repeat(64);
  if(mode==='registered-epoch')f.f.cfg.threads[threadId].originalIssuerStopEpoch++;
  if(mode==='registered-issuer')f.f.cfg.threads[threadId].originalIssuerReceiptSha256='f'.repeat(64);
  f.f.save();const result=await f.f.run();
  assert.match(result.state,/HOLD$/,mode);assert.equal(result.dispatchable,false,mode);
  assert.equal(result.modelRequests,0,mode);assert.equal(f.f.f.f.calls.length,0,mode);
 }
});
test('original callback registration preview requires independent producer and rejects duplicates and awaited stop drift',async t=>{
 for(const mode of ['valid','missing-producer','duplicate','stop-during-goal-read']){
  const f=signedOriginalCallbackFixture(t);f.install();
  const pin=f.f.cfg.threads[threadId].originalIssuerQuotaCallback;
  if(mode!=='duplicate')delete f.f.cfg.threads[threadId].originalIssuerQuotaCallback;
  if(mode==='missing-producer')delete f.f.cfg.originalGeneralCliIssuerProducer;
  f.f.save();
  const options={...f.f.options(),registrationCandidatePin:pin};
  if(mode==='stop-during-goal-read'){
   const original=options.client.threadGoalGet;
   options.client.threadGoalGet=async(...args)=>{
    const value=await original(...args);f.f.cfg.workerStopRequestedAt='2026-11-14T00:00:00Z';f.f.save();return value;
   };
  }
  const before=fs.readFileSync(f.f.file,'utf8');
  const result=await prepareOriginalIssuerCallbackRegistration(options);
  assert.equal(result.canApply,false,mode);assert.equal(result.registrationChanged,false,mode);
  assert.equal(result.modelRequests,0,mode);
  if(mode==='valid'){
   assert.equal(result.state,'PREPARED_ORIGINAL_CALLBACK_REGISTRATION_REQUIRES_OWNER_CAS');
   assert.equal(fs.readFileSync(f.f.file,'utf8'),before);
  }else assert.match(result.state,/HOLD$/,mode);
 }
});
test('sealed original sender handoff rejects changed source, callback, registration, goal and authority claims',async t=>{
 for(const mode of ['bad-handoff-sha','bad-registry-sha','wrong-root','callback-stop-revoked',
  'foreign-account','fake-issuer-bool','changed-goal']){
  const f=sealedOwnerHandoffFixture(t);
  f.cfg.workerStopRequestedAt=null;f.cfg.worker.state='STOPPED_BUT_NO_FENCE';
  f.writeCallback(mode==='callback-stop-revoked'?{stopEpoch:11}:
   mode==='foreign-account'?{accountIdSha256:'f'.repeat(64)}:{});
  if(mode==='fake-issuer-bool'){
   f.cfg.threads[threadId].originalIssuerQuotaCallback={returned:true,closed:true};
   f.save();
  }
  if(mode==='changed-goal')f.f.f.goal.updatedAt=77;
  const extra={};
  if(mode==='bad-handoff-sha')extra.expectedHandoffFileSha256='0'.repeat(64);
  if(mode==='bad-registry-sha')extra.expectedContinuityRegistrySha256='1'.repeat(64);
  if(mode==='wrong-root')extra.projectRoot=path.join(f.dir,'other');
  const state=await f.run(extra);
  assert.match(state.state,/HOLD$/,mode);
  assert.equal(state.issuerAuthorityGranted,false,mode);
  assert.equal(state.dispatchable,false,mode);
 }
});
