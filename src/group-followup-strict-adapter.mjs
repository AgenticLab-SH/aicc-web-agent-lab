// Exact owner-only group event transport to the installed strict continuity worker.
// A READY inspection is never a model dispatch or an authorization by itself.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_FILE=64*1024*1024;
const ACTIONS=new Set(['GroupInspect','GroupEnqueue']);

function pinnedFile(file,expected){
 if(typeof file!=='string'||!path.isAbsolute(file)||!SHA.test(expected??''))throw Error('strict_followup_pin_invalid');
 for(let current=path.resolve(file);;current=path.dirname(current)){
  const item=fs.lstatSync(current);
  if(item.isSymbolicLink())throw Error('strict_followup_linked_path');
  if(path.dirname(current)===current)break;
 }
 const item=fs.statSync(file);
 if(!item.isFile()||item.size>MAX_FILE)throw Error('strict_followup_file_unsafe');
 if(path.normalize(fs.realpathSync(file)).toLowerCase()!==path.normalize(path.resolve(file)).toLowerCase())throw Error('strict_followup_alias_refused');
 if(createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==expected)throw Error('strict_followup_pin_changed');
}
function parseBoundedJson(output){
 const text=Buffer.isBuffer(output)?output.toString('utf8'):String(output??'');
 if(text.length<2||Buffer.byteLength(text,'utf8')>16384)throw Error('strict_followup_output_invalid');
 const value=JSON.parse(text.replace(/^\uFEFF/,''));
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('strict_followup_output_invalid');
 return value;
}
function ownerInput(registration,source,artifact,eventId){
 const t=registration.strictContinuity;
 if(!t)return {state:'DESTINATION_PROOF_UNAVAILABLE',modelRequests:0};
 if(t.schemaVersion!==1||t.kind!=='aicc-installed-strict-preflight'||!path.isAbsolute(t.stateRoot??'')||
    !SHA.test(registration.ownerRevision??'')||!Number.isSafeInteger(registration.stopEpoch)||registration.stopEpoch<0||
    !UUID.test(registration.workerOperationId??'')||!UUID.test(registration.targetThreadId??'')||
    !path.isAbsolute(registration.targetRoot??'')||registration.accountNumber!==2||registration.route!=='command-route-r2'||
    !SHA.test(artifact.sha256??'')||!/^[A-Za-z0-9._-]{1,100}$/.test(source.id??'')||
    !SHA.test(eventId??'')||t.eventId!==eventId||(t.eventSha256&&!SHA.test(t.eventSha256)))
  return {state:'STRICT_FOLLOWUP_REGISTRATION_HOLD',modelRequests:0};
 try{pinnedFile(t.pwshPath,t.pwshSha256);pinnedFile(t.helperPath,t.helperSha256)}
 catch{return {state:'STRICT_HELPER_IDENTITY_HOLD',modelRequests:0}};
 return {target:t,args:[
  '-NoProfile','-NonInteractive','-File',t.helperPath,
  '-Action',null,'-ThreadId',registration.targetThreadId,
  '-StrictAccountNumber','2','-StateRoot',t.stateRoot,
  '-EventId',eventId,'-ExpectedEventSha256',t.eventSha256??'','-ExpectedResultSha256',artifact.sha256
 ]};
}
async function callOwner(input,action,invoke){
 if(!ACTIONS.has(action))throw Error('strict_unsupported_action');
 const args=[...input.args];args[5]=action;
 const execute=invoke??((program,argv)=>execFileSync(program,argv,{
  encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:16384
 }));
 return parseBoundedJson(await execute(input.target.pwshPath,args));
}

export async function inspectStrictFollowup(registration,source,artifact,{invoke,eventId}={}){
 const input=ownerInput(registration,source,artifact,eventId);
 if(!input.args)return input;
 let proof;
 try{proof=await callOwner(input,'GroupInspect',invoke)}
 catch{return {state:'STRICT_OWNER_ACTION_UNAVAILABLE',modelRequests:0}};
 if(proof.schemaVersion!==1||proof.kind!=='aicc-group-owner-inspect'||!SHA.test(proof.eventSha256??'')||proof.threadId!==registration.targetThreadId||
    proof.exactThreadId!==registration.targetThreadId||proof.accountNumber!==2||proof.route!=='command-route-r2'||
    proof.eventId!==eventId||proof.ownerRevision!==registration.ownerRevision||
    proof.stopEpoch!==registration.stopEpoch||proof.workerOperationId!==registration.workerOperationId||
    proof.sourceId!==source.id||proof.resultSha256!==artifact.sha256||
    path.resolve(proof.root??'')!==path.resolve(registration.targetRoot)||
    proof.claimed!==false||proof.dispatched!==false||proof.automaticReplay!==false)
  return {state:'STRICT_OWNER_PROOF_IDENTITY_HOLD',modelRequests:0};
 if(proof.state!=='READY')return {state:proof.state==='GROUP_EVENT_ALREADY_RECORDED'?'GROUP_EVENT_ALREADY_RECORDED':'STRICT_OWNER_EVIDENCE_HOLD',
  ownerState:String(proof.state??'UNKNOWN').slice(0,80),modelRequests:0};
 if(proof.quotaFresh!==true||proof.idle!==true||proof.writerReleased!==true||proof.sourceWriterReturned!==true||
    proof.originalPending!==false||proof.stopRequested!==false||proof.authorityFresh!==true||
    proof.callbackPending!==false||proof.queuePending!==false||
    !SHA.test(proof.terminalSha256??'')||!SHA.test(proof.sourceWriterReceiptSha256??'')||
    !SHA.test(proof.registrationSha256??''))
  return {state:'STRICT_OWNER_PROOF_INCOMPLETE_HOLD',modelRequests:0};
 return {...proof,state:'READY',modelRequests:0};
}
export async function enqueueStrictFollowup({registration,source,eventId,artifactSha256,destination},{invoke}={}){
 const input=ownerInput(registration,source,{sha256:artifactSha256},eventId);
 if(!input.args)return input;
 if(destination?.state!=='READY'||destination.eventId!==eventId||destination.resultSha256!==artifactSha256||
    destination.ownerRevision!==registration.ownerRevision||destination.workerOperationId!==registration.workerOperationId)
  return {state:'STRICT_ENQUEUE_PROOF_HOLD',modelRequests:0};
 let receipt;
 input.args[input.args.indexOf('-ExpectedEventSha256')+1]=destination.eventSha256;
 try{receipt=await callOwner(input,'GroupEnqueue',invoke)}
 catch{return {state:'DELIVERY_UNCERTAIN',modelRequests:0}};
 if(receipt.schemaVersion!==1||receipt.kind!=='aicc-group-owner-enqueue'||
    receipt.eventId!==eventId||receipt.threadId!==registration.targetThreadId||
    receipt.claimed!==false||receipt.dispatched!==false||receipt.automaticReplay!==false||
    receipt.modelRequests!==0||receipt.state!=='STRICT_INTENT_RECORDED')
  return {state:'DELIVERY_UNCERTAIN',modelRequests:0};
 return {state:'STRICT_INTENT_RECORDED',eventId,modelRequests:0};
}
