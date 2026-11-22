#!/usr/bin/env node
// Source-only immutable handoff for the CURRENT original Codex sender's own
// App Server failure+admission observations. No model, queue or owner action.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Error(code);};
function sealed(file,expected){
  if(typeof file!=='string'||!path.isAbsolute(file)||!SHA.test(expected??''))
    fail('HOLD_EXACT_PRIVATE_RECEIPT_PIN_REQUIRED');
  const full=path.resolve(file);
  for(let parent=full;;parent=path.dirname(parent)){
    if(fs.lstatSync(parent).isSymbolicLink())fail('HOLD_PRIVATE_RECEIPT_ALIAS');
    if(parent===path.dirname(parent))break;
  }
  const st=fs.statSync(full);
  if(!st.isFile()||st.size<=0||st.size>65536)fail('HOLD_PRIVATE_RECEIPT_BOUNDS');
  const bytes=fs.readFileSync(full);
  if(hash(bytes)!==expected)fail('HOLD_PRIVATE_RECEIPT_SHA_DRIFT');
  const value=JSON.parse(bytes.toString('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))fail('HOLD_PRIVATE_RECEIPT_SCHEMA');
  return {file:full,sha256:expected,value};
}
function ensureCreateOnce(file){
  if(typeof file!=='string'||!path.isAbsolute(file)||fs.existsSync(file))
    fail('HOLD_NEW_SOURCE_CANDIDATE_PATH_REQUIRED');
  const parent=path.dirname(path.resolve(file));
  if(path.resolve(fs.realpathSync(parent))!==parent||!fs.statSync(parent).isDirectory())
    fail('HOLD_SOURCE_CANDIDATE_PARENT_ALIAS');
  return path.resolve(file);
}
export function prepareOriginalOwnerQuotaEvidence({
  failureFile,failureSha256,admissionFile,admissionSha256,
  ownerRevision,stopEpoch,goalSha256,issuerReceiptSha256,
  threadId,projectRoot,outputFile,now=Date.now
}={}){
  const previous=sealed(failureFile,failureSha256);
  const fresh=sealed(admissionFile,admissionSha256);
  const f=previous.value,r=fresh.value,ctx=f.ownerContext;
  const observed=Date.parse(f.observedAt??'');
  const accepted=Date.parse(r.observedAt??'');
  if(!SHA.test(ownerRevision??'')||!SHA.test(goalSha256??'')||
    !SHA.test(issuerReceiptSha256??'')||
    !Number.isSafeInteger(stopEpoch)||stopEpoch<0||
    !UUID.test(threadId??'')||!path.isAbsolute(projectRoot??'')||
    ctx?.kind!=='aicc-original-cli-owner-context/v1'||
    ctx.threadId!==threadId||path.resolve(ctx.projectRoot)!==path.resolve(projectRoot)||
    ctx.goalSnapshotSha256!==goalSha256||ctx.ownerRevision!==ownerRevision||
    ctx.stopEpoch!==stopEpoch||ctx.issuerReceiptSha256!==issuerReceiptSha256||
    ctx.route!=='official-codex-to-17841-to-nonweb-OCX10101'||
    !['codex','codex_other'].includes(ctx.quotaLimitId)||
    f.schemaVersion!==1||r.schemaVersion!==1||
    f.kind!=='aicc-app-server-owned-five-hour-failure/v1'||
    r.kind!=='aicc-app-server-owned-five-hour-admission/v1'||
    f.threadId!==threadId||!UUID.test(f.failedTurnId??'')||
    f.errorInfo!=='usageLimitExceeded'||f.terminalType!=='turn/completed'||
    !SHA.test(f.terminalSha256??'')||
    !SHA.test(f.writerProcessIdentitySha256??'')||
    f.ownerContextSha256!==hash(JSON.stringify(ctx))||
    r.ownerContextSha256!==f.ownerContextSha256||
    r.writerProcessIdentitySha256!==f.writerProcessIdentitySha256||
    r.failureReceiptSha256!==hash(JSON.stringify(f))||
    f.originalOcxIssuerVerified!==false||r.originalOcxIssuerVerified!==false||
    f.dispatchable!==false||r.dispatchable!==false)
    fail('HOLD_SOURCE_OWNER_ROUTE_OR_RECEIPT_CHAIN_CHANGED');
  const fq=f.quota,aq=r.quota;
  const percentage=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=100;
  const window=x=>x==='primary'||x==='secondary';
  const nowMs=now();
  if(!fq||!aq||!window(fq.window)||aq.window!==fq.window||
    !percentage(fq.usedPercent)||fq.usedPercent!==100||
    !percentage(aq.usedPercent)||aq.usedPercent>=100||
    !Number.isFinite(nowMs)||
    fq.limitId!==ctx.quotaLimitId||aq.limitId!==fq.limitId||
    !SHA.test(fq.accountIdSha256??'')||
    aq.accountIdSha256!==fq.accountIdSha256||
    fq.usedPercent<100||fq.rateLimitReachedType!=='rate_limit_reached'||
    fq.ordinaryUsageAllowed!==false||
    !Number.isSafeInteger(fq.resetsAt)||
    aq.ordinaryUsageAllowed!==true||
    aq.rateLimitReachedType!==null||aq.spendControlReached!==false||
    !Number.isSafeInteger(aq.resetsAt)||aq.resetsAt*1000<=accepted||
    aq.resetsAt*1000>accepted+6*3600000||
    !Number.isFinite(observed)||!Number.isFinite(accepted)||
    observed>accepted||fq.resetsAt*1000<=observed||
    fq.resetsAt*1000>observed+6*3600000||
    accepted<fq.resetsAt*1000||
    accepted>nowMs||nowMs-accepted>120000)
    fail('HOLD_FIVE_HOUR_FAILURE_OR_FRESH_ADMISSION_UNPROVEN');
  const output=ensureCreateOnce(outputFile);
  const record={
    schemaVersion:1,kind:'aicc-original-cli-quota-source-owner-handoff/v1',
    status:'SOURCE_RECEIPTS_PINNED_OWNER_AUTHORITY_NOT_GRANTED',
    threadId,projectRoot,goalSnapshotSha256:goalSha256,
    route:ctx.route,ownerRevision,stopEpoch,
    originalIssuerReceiptSha256:issuerReceiptSha256,
    failedTurnId:f.failedTurnId,terminalSha256:f.terminalSha256,
    accountIdSha256:fq.accountIdSha256,
    quotaLimitId:ctx.quotaLimitId,originalFiveHourResetAt:fq.resetsAt,
    sources:{failure:{file:previous.file,sha256:previous.sha256},
      admission:{file:fresh.file,sha256:fresh.sha256}},
    recordedOwnerProcessSha256:f.writerProcessIdentitySha256,
    originalIssuerAttested:false,originalOwnerReleased:false,
    historicalPendingSettled:false,registrationChanged:false,
    dispatchable:false,automaticRetry:false,newTurns:0,modelRequests:0,
    next:'registered central installer verifies original OCX issuer, writer release, stopEpoch CAS, pending settlement and independent READY/drain'
  };
  fs.writeFileSync(output,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
  const pinned=hash(fs.readFileSync(output));
  return {status:record.status,outputFile:output,outputSha256:pinned,
    originalIssuerAttested:false,modelRequests:0,newTurns:0};
}
function opt(name){const index=process.argv.indexOf(name);return index<0?null:process.argv[index+1];}
function main(){
  const args=['--failure','--failure-sha256','--admission','--admission-sha256',
    '--owner-revision','--stop-epoch','--goal-sha256','--issuer-receipt-sha256',
    '--thread-id','--project-root','--output'];
  if(process.argv.slice(2).length!==args.length*2 ||
    args.some(k=>!opt(k)) ||
    process.argv.slice(2).filter((x,i)=>i%2===0).some(k=>!args.includes(k)) ||
    new Set(process.argv.slice(2).filter((x,i)=>i%2===0)).size!==args.length)
    fail('HOLD_EXPLICIT_SOURCE_INPUTS_REQUIRED');
  const out=prepareOriginalOwnerQuotaEvidence({
    failureFile:opt('--failure'),failureSha256:opt('--failure-sha256'),
    admissionFile:opt('--admission'),admissionSha256:opt('--admission-sha256'),
    ownerRevision:opt('--owner-revision'),stopEpoch:Number(opt('--stop-epoch')),
    goalSha256:opt('--goal-sha256'),issuerReceiptSha256:opt('--issuer-receipt-sha256'),
    threadId:opt('--thread-id'),projectRoot:opt('--project-root'),outputFile:opt('--output')
  });
  process.stdout.write(JSON.stringify(out)+'\n');
}
if(path.resolve(process.argv[1]??'')===path.resolve(fileURLToPath(import.meta.url))){
  try{main();}catch(e){process.stderr.write(String(e.message).slice(0,120)+'\n');process.exitCode=1;}
}
