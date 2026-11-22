// Consume result changes in the existing durable store. No model heartbeat,
// implicit writer transfer, request replay or account fallback.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {DurableJobStore} from './jobs/durable-store.mjs';
import {inspectStrictFollowup,enqueueStrictFollowup} from './group-followup-strict-adapter.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
function read(file,max=2*1024*1024){
 if(!path.isAbsolute(file))throw Error('followup_absolute_path_required');
 for(let p=file;;p=path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw Error('followup_linked_input');if(path.dirname(p)===p)break;}
 const s=fs.statSync(file);if(!s.isFile()||s.size>max)throw Error('followup_bounded_file_required');
 const bytes=fs.readFileSync(file);return {value:JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')),sha256:digest(bytes)};
}
export class GroupFollowupService{
 constructor({stateRoot=process.env.AICC_STATE_ROOT||path.join(os.homedir(),'.ai-control-center'),registrationPath,store,inspectDestination,dispatch,now=()=>Date.now()}={}){
  this.registrationPath=registrationPath??path.join(stateRoot,'monitoring','scheduler','group-followup-registration.json');
  this.store=store??new DurableJobStore({root:path.join(stateRoot,'jobs'),create:false});
  this.inspectDestination=inspectDestination;this.dispatch=dispatch;this.now=now;
 }
 async tick(){
  if(!fs.existsSync(this.registrationPath))return {skipped:true,reason:'group-followup-unregistered',modelRequests:0};
  const registration=read(this.registrationPath),r=registration.value;
  if(r.schemaVersion!==1||r.enabled!==true)return {skipped:true,reason:'group-followup-disabled',modelRequests:0};
  if(!UUID.test(r.targetThreadId)||r.accountNumber!==2||r.route!=='command-route-r2'||!r.authorizationRef||!Array.isArray(r.sources)||!path.isAbsolute(r.targetRoot))throw Error('followup_registration_invalid');
  // The owner revision and stop epoch are immutable authorizations, not a pool READY hint.
  if(!SHA.test(r.ownerRevision??'')||!Number.isSafeInteger(r.stopEpoch)||r.stopEpoch<0||!UUID.test(r.workerOperationId??''))throw Error('followup_owner_epoch_registration_required');
  const changes=[];
  for(const source of r.sources){
   if(!path.isAbsolute(source.resultFile??'')||!/^[A-Za-z0-9._-]{1,100}$/.test(source.id)||!Array.isArray(source.terminalStatuses)||source.terminalStatuses.length===0||source.terminalStatuses.some(x=>typeof x!=='string'||!/^[A-Z][A-Z0-9_]{0,63}$/.test(x)))throw Error('followup_source_invalid');
   if(!fs.existsSync(source.resultFile))continue;
   const artifact=read(source.resultFile);const status=artifact.value.status;
   if(!source.terminalStatuses.includes(status))continue;
   const eventId=digest(JSON.stringify([r.targetThreadId,source.id,artifact.sha256]));
   let record;
   this.store.transaction('groups.followup.result-observed',s=>{
    s.groupFollowups??={};record=s.groupFollowups[eventId];
    if(record)return;
    record={id:eventId,registrationSha256:registration.sha256,sourceId:source.id,targetThreadId:r.targetThreadId,artifactSha256:artifact.sha256,resultStatus:status,ownerRevision:r.ownerRevision,stopEpoch:r.stopEpoch,workerOperationId:r.workerOperationId,state:'RESULT_OBSERVED',observedAt:new Date(this.now()).toISOString(),automaticReplay:false};
    s.groupFollowups[eventId]=record;
   });
   if(record.registrationSha256!==registration.sha256||record.ownerRevision!==r.ownerRevision||record.stopEpoch!==r.stopEpoch||record.workerOperationId!==r.workerOperationId){changes.push({id:eventId,state:'EVENT_AUTHORITY_CHANGED_HOLD',modelRequests:0});continue;}
   if(['DELIVERY_UNCERTAIN','STRICT_INTENT_RECORDED','QUEUE_ACCEPTED','TURN_STARTED','TURN_COMPLETED','CANCELLED'].includes(record.state)){changes.push({id:eventId,state:record.state,duplicateSuppressed:true});continue;}
   // A stopped/changed registration revokes dispatch before claiming an effect.
   if(read(this.registrationPath).sha256!==registration.sha256){changes.push({id:eventId,state:'REGISTRATION_CHANGED_HOLD'});continue;}
   const destination=await (this.inspectDestination?.(r,source,artifact)??inspectStrictFollowup(r,source,artifact,{eventId}));
   const deliver=this.dispatch??(r.strictContinuity?enqueueStrictFollowup:null);
   if(read(this.registrationPath).sha256!==registration.sha256){changes.push({id:eventId,state:'REGISTRATION_CHANGED_HOLD'});continue;}
   const ready=destination.state==='READY'&&destination.exactThreadId===r.targetThreadId&&path.resolve(destination.root??'')===path.resolve(r.targetRoot)&&destination.accountNumber===2&&destination.route==='command-route-r2'&&destination.ownerRevision===r.ownerRevision&&destination.stopEpoch===r.stopEpoch&&destination.workerOperationId===r.workerOperationId&&destination.resultSha256===artifact.sha256&&destination.sourceId===source.id&&SHA.test(destination.sourceWriterReceiptSha256??'')&&SHA.test(destination.terminalSha256??'')&&destination.callbackPending===false&&destination.queuePending===false&&destination.quotaFresh===true&&destination.idle===true&&destination.writerReleased===true&&destination.sourceWriterReturned===true&&destination.originalPending===false&&destination.stopRequested===false&&destination.authorityFresh===true&&typeof deliver==='function';
   if(!ready){
    const state=destination.state==='READY'?'DESTINATION_CONTRACT_HOLD':destination.state;
    this.store.transaction('groups.followup.gate',s=>Object.assign(s.groupFollowups[eventId],{state,checkedAt:new Date(this.now()).toISOString()}));
    changes.push({id:eventId,state,modelRequests:0});continue;
   }
   let claimed=false;
   this.store.transaction('groups.followup.claim',s=>{const e=s.groupFollowups[eventId];if(['DELIVERY_UNCERTAIN','STRICT_INTENT_RECORDED','QUEUE_ACCEPTED','TURN_STARTED','TURN_COMPLETED','CANCELLED'].includes(e.state))return;e.state='DELIVERY_UNCERTAIN';e.claimedAt=new Date(this.now()).toISOString();claimed=true;});
   if(!claimed){changes.push({id:eventId,state:'DUPLICATE_SUPPRESSED'});continue;}
   // A post-claim failure is uncertain. Never repeat this original effect.
   let result;try{result=await deliver({registration:r,source,eventId,artifactSha256:artifact.sha256,destination});}catch{result={state:'DELIVERY_UNCERTAIN'};}
   const state=['STRICT_INTENT_RECORDED','QUEUE_ACCEPTED','TURN_STARTED','TURN_COMPLETED'].includes(result?.state)?result.state:'DELIVERY_UNCERTAIN';
   this.store.transaction('groups.followup.delivery',s=>Object.assign(s.groupFollowups[eventId],{state,turnId:result?.turnId??null,queuedMessageId:result?.queuedMessageId??null}));
   changes.push({id:eventId,state});
  }
  return {scope:'group-followup',automaticReplay:false,changes,dispatchSupported:typeof this.dispatch==='function'||changes.some(x=>x.state==='STRICT_INTENT_RECORDED')};
 }
}
