import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {sealRegisteredOriginalIssuerCallback,inspectRegisteredOriginalIssuerProducer} from '../src/original-cli-issuer-producer.mjs';
import {verifyRegisteredOriginalIssuerCallback} from '../src/codex-goal-resume.mjs';
import {protectWindowsOwnerOnlyPath} from '../src/lib/windows-owner-only-acl.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const threadId='11111111-1111-4111-8111-111111111111';
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-original-producer-'));
 const clock=Date.now(),turnId='22222222-2222-4222-8222-222222222222';
 const pin={ownerRequestId:'33333333-3333-4333-8333-333333333333',attestationSha256:'a'.repeat(64),recoverySha256:'b'.repeat(64)};
 const entry={threadId,projectRoot:dir,enabled:true,executionSurface:'cli',
  originalIssuerOwnerRevision:'1'.repeat(64),originalIssuerStopEpoch:3,originalIssuerPreviousStopEpoch:2,
  originalIssuerReceiptSha256:'2'.repeat(64),originalIssuerWriterProcessIdentitySha256:'3'.repeat(64)};
 const source={state:'ORIGINAL_SELECTION_QUOTA_CHAIN_VERIFIED_SENDER_AUTHORITY_REQUIRED',threadId,turnId,
  accountIdSha256:'4'.repeat(64),credentialGeneration:1,failureReceiptSha256:'5'.repeat(64),
  attestationSha256:pin.attestationSha256,recoveryReceiptSha256:pin.recoverySha256,
  observedAt:new Date(clock).toISOString(),quotaObservedAt:new Date(clock).toISOString(),originalResetAt:Math.floor(clock/1000)-30,
  backendLimitProven:false,
  originalTerminal:{threadId,turnId,terminalType:'turn_failed',terminalSha256:'6'.repeat(64)},
  sourceOnly:true,originalIssuerVerified:false,writerReturned:false,issuerAuthorityGranted:false,dispatchable:false,modelRequests:0,newTurns:0};
 const owner={kind:'aicc-original-cli-issuer-authority-observation/v1',threadId,projectRoot:dir,
  route:'official-codex-to-17841-to-nonweb-OCX10101',goalSnapshotSha256:'7'.repeat(64),
  ownerRevision:entry.originalIssuerOwnerRevision,stopEpoch:3,previousStopEpoch:2,
  issuerReceiptSha256:entry.originalIssuerReceiptSha256,writerProcessIdentitySha256:entry.originalIssuerWriterProcessIdentitySha256,
  failedTurnId:turnId,terminalSha256:source.originalTerminal.terminalSha256,accountIdSha256:source.accountIdSha256,
  ownerRequestId:pin.ownerRequestId,credentialGeneration:1,attestationSha256:pin.attestationSha256,
  failureReceiptSha256:source.failureReceiptSha256,admissionReceiptSha256:pin.recoverySha256,
  originalIssuerBound:true,writerReturned:true,writerClosed:true,pendingSettled:true,stopRequested:false,
  goalStatus:'usageLimited',observedAt:new Date(clock).toISOString()};
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const keyFile=path.join(dir,'private.pem');fs.writeFileSync(keyFile,privateKey.export({format:'pem',type:'pkcs8'}));
 if(process.platform==='win32'){
  protectWindowsOwnerOnlyPath(dir,{directory:true});
  protectWindowsOwnerOnlyPath(keyFile,{directory:false});
 }else{fs.chmodSync(keyFile,0o600);fs.chmodSync(dir,0o700);}
 const producer={kind:'aicc-original-cli-issuer-producer-pin/v1',route:owner.route,keyId:'fixture-original-key',
  executableFile:process.execPath,executableSha256:sha(fs.readFileSync(process.execPath)),
  publicKeyPem:publicKey.export({type:'spki',format:'pem'}),publicKeySha256:sha(publicKey.export({type:'spki',format:'der'})),
  privateKey:{file:keyFile,sha256:sha(fs.readFileSync(keyFile))}};
 const readerFile=path.join(dir,'reader.mjs'),authorityFile=path.join(dir,'authority.mjs');
 const sourceFile=path.join(dir,'source.json'),ownerFile=path.join(dir,'owner.json');
 fs.writeFileSync(sourceFile,JSON.stringify(source));fs.writeFileSync(ownerFile,JSON.stringify(owner));
 fs.writeFileSync(readerFile,`import fs from 'node:fs';export function readOriginalCliQuotaReceiptChain(){return JSON.parse(fs.readFileSync(${JSON.stringify(sourceFile)},'utf8'));}`);
 fs.writeFileSync(authorityFile,`import fs from 'node:fs';export function readOriginalIssuerAuthority(){return JSON.parse(fs.readFileSync(${JSON.stringify(ownerFile)},'utf8'));}`);
 producer.authorityReader={moduleFile:authorityFile,moduleSha256:sha(fs.readFileSync(authorityFile)),exportName:'readOriginalIssuerAuthority'};
 const cfg={schemaVersion:1,protocolVersion:3,threads:{[threadId]:entry},originalGeneralCliIssuerProducer:producer,
  originalOcxSelectionReader:{moduleFile:readerFile,moduleSha256:sha(fs.readFileSync(readerFile)),exportName:'readOriginalCliQuotaReceiptChain'}};
 const registryFile=path.join(dir,'registry.json'),outputFile=path.join(dir,'callback.json');
 const options={registryFile,threadId,goalSha256:owner.goalSnapshotSha256,pin,outputFile,now:()=>clock};
 const save=()=>{fs.writeFileSync(registryFile,JSON.stringify(cfg));options.registrySha256=sha(fs.readFileSync(registryFile));};save();
 return {dir,cfg,entry,source,owner,producer,sourceFile,ownerFile,readerFile,authorityFile,keyFile,options,save,
  run:()=>sealRegisteredOriginalIssuerCallback(options),saveSource:()=>fs.writeFileSync(sourceFile,JSON.stringify(source)),
  saveOwner:()=>fs.writeFileSync(ownerFile,JSON.stringify(owner))};
}
test('registered producer seals real Ed25519 bytes consumed by existing independent verifier',async()=>{
 const f=fixture(),before=fs.readFileSync(f.options.registryFile),r=await f.run();
 assert.equal(r.state,'ORIGINAL_CALLBACK_SEALED_NOT_REGISTERED');assert.equal(r.modelRequests,0);
 assert.equal(r.dispatchable,false);assert.equal(r.registrationChanged,false);
 assert.deepEqual(fs.readFileSync(f.options.registryFile),before);
 const callback=JSON.parse(fs.readFileSync(r.receiptFile));
 assert.equal(sha(fs.readFileSync(r.receiptFile)),r.receiptSha256);
 assert.equal(verifyRegisteredOriginalIssuerCallback({callback,producer:f.producer,binding:callback,now:f.options.now}).authenticated,true);
 callback.signedSource.signatureBase64=Buffer.alloc(64).toString('base64');
 assert.equal(verifyRegisteredOriginalIssuerCallback({callback,producer:f.producer,binding:callback,now:f.options.now}).authenticated,false);
 await assert.rejects(f.run(),/new_owner_local_output/);
});
test('global pending, stop, unregistered authority and owner epoch reject before authority import',async()=>{
 for(const mode of ['pending','stop','maintenance','missing','epoch','revision','existing','disabled','strict']){
  const f=fixture();
  if(mode==='pending')f.cfg.threads.other={queueAttempt:{state:'UNKNOWN'}};
  if(mode==='stop')f.cfg.workerStopRequestedAt='preserved';
  if(mode==='maintenance')f.cfg.worker={state:'STOPPED_FOR_MAINTENANCE'};
  if(mode==='missing')delete f.producer.authorityReader;
  if(mode==='epoch')f.entry.originalIssuerPreviousStopEpoch=4;
  if(mode==='revision')f.entry.originalIssuerOwnerRevision='not-a-hash';
  if(mode==='existing')f.entry.originalIssuerQuotaCallback={preserve:true};
  if(mode==='disabled')f.entry.enabled=false;
  if(mode==='strict')f.entry.strictAccount=2;
  f.save();await assert.rejects(f.run(),undefined,mode);assert.equal(fs.existsSync(f.options.outputFile),false,mode);
 }
});
test('original owner rejects wrong identity, live writer, goal and freshness claims',async()=>{
 for(const mode of ['thread','root','goal','account','turn','generation','revision','epoch','writer','closed','issuer','stop','pending','paused','stale']){
  const f=fixture();
  if(mode==='thread')f.owner.threadId='44444444-4444-4444-8444-444444444444';
  if(mode==='root')f.owner.projectRoot=path.dirname(f.dir);
  if(mode==='goal')f.owner.goalSnapshotSha256='f'.repeat(64);
  if(mode==='account')f.owner.accountIdSha256='f'.repeat(64);
  if(mode==='turn')f.owner.failedTurnId='44444444-4444-4444-8444-444444444444';
  if(mode==='generation')f.owner.credentialGeneration++;
  if(mode==='revision')f.owner.ownerRevision='f'.repeat(64);
  if(mode==='epoch')f.owner.stopEpoch++;
  if(mode==='writer')f.owner.writerReturned=false;
  if(mode==='closed')f.owner.writerClosed=false;
  if(mode==='issuer')f.owner.originalIssuerBound=false;
  if(mode==='stop')f.owner.stopRequested=true;
  if(mode==='pending')f.owner.pendingSettled=false;
  if(mode==='paused')f.owner.goalStatus='paused';
  if(mode==='stale')f.owner.observedAt=new Date(f.options.now()-61000).toISOString();
  f.saveOwner();await assert.rejects(f.run(),undefined,mode);assert.equal(fs.existsSync(f.options.outputFile),false,mode);
 }
});
test('quota selection requires fresh exact source and terminal instead of owner assertions',async()=>{
 for(const mode of ['account','turn','freshness','reset','terminal','source','send']){
  const f=fixture();
  if(mode==='account')f.source.accountIdSha256='invalid';
  if(mode==='turn')f.source.turnId='invalid';
  if(mode==='freshness')f.source.quotaObservedAt=new Date(f.options.now()-61000).toISOString();
  if(mode==='reset')f.source.originalResetAt=Math.floor(f.options.now()/1000)+100;
  if(mode==='terminal')f.source.originalTerminal.terminalType='in_progress';
  if(mode==='source')f.source.issuerAuthorityGranted=true;
  if(mode==='send')f.source.newTurns=1;
  f.saveSource();await assert.rejects(f.run(),undefined,mode);assert.equal(fs.existsSync(f.options.outputFile),false,mode);
 }
});
test('signed producer refuses invalid reset and missing limit classification before creating output',async()=>{
 for(const reset of [undefined,null,0,-1,1.5,'1',Number.MAX_SAFE_INTEGER+1]){
  const f=fixture();f.source.originalResetAt=reset;f.saveSource();
  const before=fs.readFileSync(f.options.registryFile);
  await assert.rejects(f.run(),/original_selection_or_freshness_hold/);
  assert.equal(fs.existsSync(f.options.outputFile),false);
  assert.deepEqual(fs.readFileSync(f.options.registryFile),before);
 }
 for(const classification of [undefined,null,0,1,'false','true']){
  const f=fixture();f.source.backendLimitProven=classification;f.saveSource();
  await assert.rejects(f.run(),/original_selection_or_freshness_hold/);
  assert.equal(fs.existsSync(f.options.outputFile),false);
 }
 const f=fixture();f.source.backendLimitProven=true;f.saveSource();
 assert.equal((await f.run()).state,'ORIGINAL_CALLBACK_SEALED_NOT_REGISTERED');
});

test('freshly sealed source cannot reuse a quota read from before the original reset',async()=>{
 const f=fixture();
 f.source.quotaObservedAt=new Date(f.source.originalResetAt*1000-1).toISOString();
 f.saveSource();
 await assert.rejects(f.run(),/original_selection_or_freshness_hold/);
 assert.equal(fs.existsSync(f.options.outputFile),false);
});

test('executable, key and authority pins cannot be substituted',async()=>{
 for(const mode of ['executable','key','keypair','authority','reader']){
  const f=fixture();
  if(mode==='executable')f.producer.executableSha256='f'.repeat(64);
  if(mode==='key')fs.appendFileSync(f.keyFile,'changed');
  if(mode==='keypair'){
   const {privateKey}=generateKeyPairSync('ed25519');fs.writeFileSync(f.keyFile,privateKey.export({format:'pem',type:'pkcs8'}));
   f.producer.privateKey.sha256=sha(fs.readFileSync(f.keyFile));
  }
  if(mode==='authority')fs.appendFileSync(f.authorityFile,'// changed');
  if(mode==='reader')fs.appendFileSync(f.readerFile,'// changed');
  f.save();await assert.rejects(f.run(),undefined,mode);assert.equal(fs.existsSync(f.options.outputFile),false,mode);
 }
});
test('awaited authority drift discards signed output and preserves changed registry',async()=>{
 for(const mode of ['registry','authority','key']){
  const f=fixture();
  const file=mode==='registry'?f.options.registryFile:mode==='authority'?f.authorityFile:f.keyFile;
  fs.writeFileSync(f.authorityFile,`import fs from 'node:fs';export async function readOriginalIssuerAuthority(){const owner=JSON.parse(fs.readFileSync(${JSON.stringify(f.ownerFile)},'utf8'));await Promise.resolve();fs.appendFileSync(${JSON.stringify(file)},' ');return owner;}`);
  f.producer.authorityReader.moduleSha256=sha(fs.readFileSync(f.authorityFile));f.save();
  await assert.rejects(f.run(),/file_changed/,mode);assert.equal(fs.existsSync(f.options.outputFile),false,mode);
 }
});
test('live readiness has no sign, key creation, registry mutation or sender side effects',()=>{
 const f=fixture(),before=fs.readFileSync(f.options.registryFile);
 const ready=inspectRegisteredOriginalIssuerProducer(f.options);
 assert.equal(ready.state,'ORIGINAL_PRODUCER_REGISTERED_LIVE_OBSERVATION_REQUIRED');
 assert.equal(ready.canSeal,false);assert.equal(ready.dispatchable,false);
 assert.equal(fs.existsSync(f.options.outputFile),false);
 assert.deepEqual(fs.readFileSync(f.options.registryFile),before);
 f.cfg.threads.other={queueAttempt:{state:'QUEUE_ACCEPTED'}};f.save();
 assert.equal(inspectRegisteredOriginalIssuerProducer(f.options).reason,'producer_pending_preserved');
 delete f.cfg.threads.other;f.cfg.workerStopRequestedAt='preserved';f.save();
 assert.equal(inspectRegisteredOriginalIssuerProducer(f.options).reason,'producer_stop_preserved');
 delete f.cfg.workerStopRequestedAt;delete f.producer.authorityReader;f.save();
 assert.equal(inspectRegisteredOriginalIssuerProducer(f.options).reason,'producer_independent_registration_required');
});
