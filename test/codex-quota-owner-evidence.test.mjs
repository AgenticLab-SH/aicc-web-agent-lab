import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareOriginalOwnerQuotaEvidence} from '../tools/platform/codex/prepare-original-owner-quota-evidence.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const json=x=>JSON.stringify(x,null,2)+'\n';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'original-owner-quota-source-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const threadId='01a1c19b-5641-7a50-9168-19e87601b1ef';
 const at=Date.parse('2026-11-14T00:00:00.000Z');
 const reset=Math.floor(Date.parse('2026-11-14T01:00:00.000Z')/1000);
 const ownerContext={kind:'aicc-original-cli-owner-context/v1',threadId,projectRoot:root,
  goalSnapshotSha256:'a'.repeat(64),ownerRevision:'b'.repeat(64),
  stopEpoch:17,issuerReceiptSha256:'c'.repeat(64),
  route:'official-codex-to-17841-to-nonweb-OCX10101',quotaLimitId:'codex'};
 const failure={schemaVersion:1,kind:'aicc-app-server-owned-five-hour-failure/v1',
  threadId,ownerContext,ownerContextSha256:sha(JSON.stringify(ownerContext)),
  failedTurnId:'ababaaba-aaaa-4aaa-baaa-aaaaaaaaaaaa',
  terminalType:'turn/completed',errorInfo:'usageLimitExceeded',
  terminalSha256:'d'.repeat(64),writerProcessIdentitySha256:'e'.repeat(64),
  observedAt:new Date(at).toISOString(),originalOcxIssuerVerified:false,
  dispatchable:false,quota:{limitId:'codex',window:'secondary',usedPercent:100,
    rateLimitReachedType:'rate_limit_reached',ordinaryUsageAllowed:false,
    accountIdSha256:'f'.repeat(64),resetsAt:reset}};
 const admission={schemaVersion:1,kind:'aicc-app-server-owned-five-hour-admission/v1',
  ownerContextSha256:failure.ownerContextSha256,
  writerProcessIdentitySha256:failure.writerProcessIdentitySha256,
  failureReceiptSha256:sha(JSON.stringify(failure)),
  originalOcxIssuerVerified:false,dispatchable:false,
  observedAt:new Date(reset*1000+1000).toISOString(),
  quota:{limitId:'codex',window:'secondary',usedPercent:7,rateLimitReachedType:null,
    spendControlReached:false,ordinaryUsageAllowed:true,
    accountIdSha256:'f'.repeat(64),resetsAt:reset+18000}};
 const failureFile=path.join(root,'failure.json'),
       admissionFile=path.join(root,'admission.json'),outputFile=path.join(root,'candidate.json');
 const put=(file,value)=>{fs.writeFileSync(file,json(value));return sha(fs.readFileSync(file));};
 const opts={failureFile,admissionFile,outputFile,threadId,projectRoot:root,
   ownerRevision:ownerContext.ownerRevision,stopEpoch:ownerContext.stopEpoch,
   goalSha256:ownerContext.goalSnapshotSha256,
   issuerReceiptSha256:ownerContext.issuerReceiptSha256,
   now:()=>reset*1000+1100};
 const run=()=>prepareOriginalOwnerQuotaEvidence(opts);
 function flush(){opts.failureSha256=put(failureFile,failure);
   opts.admissionSha256=put(admissionFile,admission);}
 flush();
 return {root,opts,failure,admission,put,flush,run,outputFile};
}
test('prepared source candidate pins exact original receipts without owner authority or mutation',t=>{
 const f=fixture(t),beforeFailure=sha(fs.readFileSync(f.opts.failureFile));
 const out=f.run();
 assert.equal(out.status,'SOURCE_RECEIPTS_PINNED_OWNER_AUTHORITY_NOT_GRANTED');
 assert.match(out.outputSha256,/^[a-f0-9]{64}$/);
 const candidate=JSON.parse(fs.readFileSync(f.outputFile,'utf8'));
 assert.equal(candidate.ownerRevision,f.failure.ownerContext.ownerRevision);
 assert.equal(candidate.stopEpoch,17);
 assert.equal(candidate.sources.failure.sha256,beforeFailure);
 assert.equal(candidate.sources.admission.sha256,f.opts.admissionSha256);
 assert.equal(candidate.originalIssuerAttested,false);
 assert.equal(candidate.dispatchable,false);
 assert.equal(candidate.newTurns,0);
 assert.equal(candidate.modelRequests,0);
 assert.equal(JSON.stringify(candidate).includes('leaseToken'),false);
 assert.throws(f.run,/HOLD_NEW_SOURCE_CANDIDATE_PATH_REQUIRED/);
 assert.equal(sha(fs.readFileSync(f.opts.failureFile)),beforeFailure);
});
test('source-only quota candidate refuses unrelated owner, quota drift, stale, unknown or repinned tampering',t=>{
 for(const mode of ['owner','epoch','account','goal','time','usage','source','sha','future']){
  const f=fixture(t);
  if(mode==='owner')f.opts.ownerRevision='0'.repeat(64);
  if(mode==='epoch')f.opts.stopEpoch=18;
  if(mode==='account')f.admission.quota.accountIdSha256='1'.repeat(64);
  if(mode==='goal')f.opts.goalSha256='2'.repeat(64);
  if(mode==='time')f.opts.now=()=>Date.parse('2026-11-14T04:00:00.000Z');
  if(mode==='usage')f.admission.quota.ordinaryUsageAllowed=null;
  if(mode==='source')f.admission.failureReceiptSha256='3'.repeat(64);
  if(mode==='sha')fs.appendFileSync(f.opts.admissionFile,'tamper');
  if(mode==='future')f.admission.observedAt='2026-11-14T06:00:00.000Z';
  if(['account','usage','source','future'].includes(mode))f.flush();
  assert.throws(()=>f.run(),/HOLD_/,mode);
  assert.equal(fs.existsSync(f.outputFile),false);
 }
});

test('source packager rejects missing 300-minute windows, NaN/negative use, unknown spend and stale reset after repinning',t=>{
 for(const mode of ['missing-window','different-window','failure-NaN','admission-negative',
  'unknown-spend','old-reset','not-exact-100']){
  const f=fixture(t);
  if(mode==='missing-window')delete f.failure.quota.window;
  if(mode==='different-window')f.admission.quota.window='primary';
  if(mode==='failure-NaN')f.failure.quota.usedPercent=NaN;
  if(mode==='admission-negative')f.admission.quota.usedPercent=-1;
  if(mode==='unknown-spend')f.admission.quota.spendControlReached=null;
  if(mode==='old-reset')f.admission.quota.resetsAt=f.failure.quota.resetsAt;
  if(mode==='not-exact-100')f.failure.quota.usedPercent=99;
  f.admission.failureReceiptSha256=sha(JSON.stringify(f.failure));
  f.flush();
  assert.throws(f.run,/HOLD_/,mode);
  assert.equal(fs.existsSync(f.outputFile),false,mode);
 }
});

test('registered original general-CLI quota preflight is read-only and holds stop and historical pending', {skip:process.platform!=='win32'},t=>{
 const f=fixture(t);
 const original=f.run();
 assert.equal(original.status,'SOURCE_RECEIPTS_PINNED_OWNER_AUTHORITY_NOT_GRANTED');
 const owner=path.join(f.root,'.ai-control-center');
 const state=path.join(owner,'control-plane','codex-continuity');
 const assets=path.join(owner,'asset-control','synthetic-test');
 const sessions=path.join(f.root,'sessions');
 fs.mkdirSync(state,{recursive:true});fs.mkdirSync(assets,{recursive:true});
 fs.mkdirSync(sessions,{recursive:true});
 const handoffFile=path.join(assets,'source-handoff.json');
 fs.copyFileSync(f.outputFile,handoffFile);
 const handoffSha=sha(fs.readFileSync(handoffFile));
 const rollout=path.join(sessions,'current.jsonl');
 fs.writeFileSync(rollout,JSON.stringify({type:'session_meta',payload:{
  id:f.opts.threadId,source:'cli',cwd:f.root}})+'\n');
 const cfg={schemaVersion:1,protocolVersion:3,excludedThreadIds:[],
  workerStopRequestedAt:'2026-11-14T02:00:00.000Z',
  worker:{state:'STOPPED_FOR_MAINTENANCE'},threads:{
   [f.opts.threadId]:{threadId:f.opts.threadId,projectRoot:f.root,
    rollout,enabled:true,strictAccount:null,attempt:null,queueAttempt:null}
  }};
 const registry=path.join(state,'registrations.json');
 const put=()=>fs.writeFileSync(registry,JSON.stringify(cfg));
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const module=path.join(repo,'tools','platform','windows','CodexContinuityMaintenance.psm1');
 const quote=s=>"'"+s.replaceAll("'","''")+"'";
 const ps=[
  "$ErrorActionPreference='Stop';",
  "Import-Module "+quote(module)+" -Force;",
  "Get-AiccGeneralCliQuotaEvidenceReadiness",
  "-StateRoot "+quote(state),
  "-ThreadId "+quote(f.opts.threadId),
  "-SourceHandoffFile "+quote(handoffFile),
  "-ExpectedSourceHandoffSha256 "+quote(handoffSha),
  "-ExpectedGoalSha256 "+quote(f.opts.goalSha256),
  "-SessionsRoot "+quote(sessions),
  "| ConvertTo-Json -Depth 20 -Compress"
 ].join(' ');
 function readStatus(){
  const r=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',ps],
   {encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(r.status,0,r.stderr||r.stdout);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
 }
 put();
 const stopped=readStatus();
 assert.equal(stopped.state,'REGISTERED_MAINTENANCE_STOP_FENCE_HOLD');
 assert.equal(stopped.maintenanceStopPresent,true);
 assert.equal(stopped.sourceReceiptsPinned,true);
 assert.equal(stopped.modelRequests,0);
 assert.equal(stopped.newTurnObserved,false);
 assert.equal(stopped.dispatchable,false);
 const historical='aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
 cfg.threads[historical]={threadId:historical,attempt:{id:'ce9a-historical'}};
 put();
 const pending=readStatus();
 assert.equal(pending.state,'ORIGINAL_OR_HISTORICAL_PENDING_UNSETTLED_HOLD');
 assert.equal(pending.historicalPendingCount,1);
 delete cfg.threads[historical];
 cfg.workerStopRequestedAt=null;
 cfg.worker.state='STOPPED_BUT_UNRELEASED';
 put();
 const noProducer=readStatus();
 assert.equal(noProducer.state,'REGISTERED_ORIGINAL_ISSUER_CALLBACK_AND_OWNER_EPOCH_REQUIRED_HOLD');
 assert.equal(noProducer.originalIssuerAuthenticated,false);
 assert.equal(noProducer.queueAck,false);
 // The synthetic registry is never a trusted sender, even when its stop is clear.
 assert.equal(noProducer.dispatchable,false);
});
