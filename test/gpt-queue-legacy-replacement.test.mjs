import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {nativeGptQueueExchange} from '../components/workspace-mcp/gpt-queue-provider.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fileHash=file=>hash(fs.readFileSync(file));
const put=(file,value)=>{fs.writeFileSync(file,JSON.stringify(value));return file;};
const source=fs.readFileSync('tools/platform/workspace-mcp/GptQueueRuntimeDeployment.ps1','utf8');
const script=source.match(/\$nativeReadScript=@'\r?\n([\s\S]*?)\r?\n'@/)[1];
const runId=b=>'gptq_'+hash(b.bindingId+'\0'+b.ownerIdentityHash).slice(0,24)+'_'+b.operationId;

function fixture(){
  // Keep bounded synthetic evidence in the OS temporary directory for diagnosis.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'queue-legacy-replacement-'));
  const roles=['9222','9223'].map((slot,i)=>({id:'synthetic-role-'+i,slot,
    targetNonce:String(i+1).repeat(64),conversationId:'synthetic-conversation-'+i,
    prompt:'Synthetic harmless test prompt '+i}));
  const request={kind:'aicc-gpt-queue-original-owner-request',bindingId:'synthetic-binding-old',
    operationId:'synthetic-operation-old',ownerId:'synthetic-owner',ownerIdentityHash:'a'.repeat(64),
    workspaceAlias:'synthetic-workspace',workspaceRoot:root,title:'Synthetic legacy cancellation',roles};
  const requestFile=put(path.join(root,'request.json'),request);
  const old={...request,originalRequestSha256:fileHash(requestFile),
    definitionSha256:hash(JSON.stringify({title:request.title,roles})),
    currentIssuer:{requestFile},targets:roles.map(r=>({...r,roleId:r.id})),baseDirectory:root};
  const next={...old,bindingId:'synthetic-binding-next',operationId:'synthetic-operation-next',
    originalRequestSha256:'b'.repeat(64),nativeExecutable:'synthetic-not-executed'};
  const run={id:runId(old),title:request.title,registrationOnly:true,paused:true,status:'cancelled',
    cancelledAt:new Date().toISOString(),roles:roles.map((r,i)=>({...r,position:i,status:'cancelled',attempt:0,history:[]}))};
  const view=(revision,status)=>({ok:true,operationId:old.operationId,revision,status,paused:true,
    registrationOnly:true,dispatchState:'NOT_DISPATCHED',executionAuthorized:false,
    roles:roles.map((r,i)=>({id:r.id,slot:r.slot,status:status==='cancelled'?'cancelled':i?'blocked':'ready',
      dispatchCount:0,submissionUncertain:false,conversationRecorded:true,
      userMessageRecorded:false,assistantMessageRecorded:false,errorCode:null,structuredResult:null}))});
  const receipt={before:view(1,'paused'),result:{...view(2,'cancelled'),cancel:'CANCELLED_UNSENT'}};
  const state={revision:2,oldId:run.id,run,capability:{ownerBoundActivation:true,pausedRegistration:true,revisionFencedCancel:true},
    newGet:{ok:false,error:'WEBGPT_ORCHESTRATION_RUN_NOT_FOUND'}};
  const provider=path.join(root,'components/workspace-mcp/gpt-queue-provider.mjs');
  fs.mkdirSync(path.dirname(provider),{recursive:true});
  fs.writeFileSync(provider,"import fs from 'node:fs';export async function nativeGptQueueExchange(b,q){"+
    "const s=JSON.parse(fs.readFileSync(process.env.QUEUE_LEGACY_FIXTURE));"+
    "if(q.type==='orchestration_capabilities')return {ok:true,payload:s.capability};"+
    "if(q.type!=='orchestration_get')throw Error('NATIVE_MUTATION_FORBIDDEN');"+
    "return q.runId===s.oldId?{ok:true,payload:{revision:s.revision,run:s.run}}:s.newGet;}");
  const oldFile=path.join(root,'old.json'),nextFile=path.join(root,'next.json');
  const receiptFile=path.join(root,'cancel.json'),stateFile=path.join(root,'state.json');
  function execute({backend=root,pinReceipt=true}={}){
    put(oldFile,old);put(nextFile,next);put(receiptFile,receipt);put(stateFile,state);
    const originals=[oldFile,nextFile,requestFile,receiptFile,stateFile].map(fileHash);
    const result=spawnSync(process.execPath,['--input-type=module','-e',script,backend,oldFile,nextFile,
      receiptFile,pinReceipt?fileHash(receiptFile):'c'.repeat(64)],
    {encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,QUEUE_LEGACY_FIXTURE:stateFile}});
    assert.deepEqual([oldFile,nextFile,requestFile,receiptFile,stateFile].map(fileHash),originals,'readback preserves evidence');
    return result;
  }
  return {root,roles,request,requestFile,old,next,run,receipt,state,execute};
}

test('sealed legacy cancelled-unsent run is accepted without rewriting omitted fields',()=>{
  const f=fixture(),r=f.execute();assert.equal(r.status,0,r.stderr);
  const proof=JSON.parse(r.stdout);
  assert.equal(proof.previousProof,'SEALED_LEGACY_CANCELLED_UNSENT');
  assert.equal(proof.nextRegistered,false);assert.equal(proof.readOnly,true);
  assert.equal(proof.legacyCancelReceiptSha256,hash(JSON.stringify(f.receipt)));
});

for(const [name,mutate] of [
  ['attempt',f=>{f.run.roles[0].attempt=1;}],
  ['history',f=>{f.run.roles[0].history=[{status:'claimed'}];}],
  ['claim',f=>{f.run.roles[0].claimToken='synthetic';}],
  ['message',f=>{f.run.roles[0].userMessageId='synthetic';}],
  ['unknown',f=>{f.run.roles[0].submissionUncertain=true;}],
  ['dispatch',f=>{f.run.roles[0].dispatchCount=1;}],
  ['zero dispatch injected',f=>{f.run.roles[0].dispatchCount=0;}],
  ['activation',f=>{f.run.executionAuthorized=true;}],
  ['completed legacy',f=>{f.run.status='completed';}],
  ['foreign definition',f=>{f.run.roles[0].prompt='different';}],
  ['changed request',f=>{put(f.requestFile,{...f.request,title:'different'});}],
  ['foreign owner',f=>{f.old.ownerId='foreign';}],
  ['missing request',f=>{f.old.currentIssuer={};}],
  ['wrong receipt operation',f=>{f.receipt.result.operationId='foreign';}],
  ['receipt revision',f=>{f.receipt.result.revision=3;}],
  ['invalid initial revision',f=>{f.receipt.before.revision=-1;f.receipt.result.revision=0;f.state.revision=0;}],
  ['receipt uncertain',f=>{f.receipt.before.roles[0].submissionUncertain=true;}],
  ['receipt no conversation',f=>{f.receipt.before.roles[0].conversationRecorded=false;}],
  ['missing run',f=>{f.state.run=null;}],
  ['registered next',f=>{f.state.newGet={ok:true,payload:{run:{}}};}],
  ['unknown next',f=>{f.state.newGet={ok:false,error:'UNKNOWN'};}],
  ['unsupported host',f=>{f.state.capability.ownerBoundActivation=false;}],
  ['null owner binding',f=>{f.run.ownerBinding=null;}]
])test('legacy replacement refuses '+name,()=>{
  const f=fixture();mutate(f);const r=f.execute();assert.notEqual(r.status,0,r.stdout);
});

test('legacy cancellation receipt content must match its pinned SHA',()=>{
  const f=fixture(),r=f.execute({pinReceipt:false});assert.notEqual(r.status,0);
  assert.match(r.stderr,/HOLD_LEGACY_EVIDENCE_SHA_CHANGED/);
});

test('Windows request slash spelling resolves to the same exact workspace',
 {skip:process.platform!=='win32'},()=>{
  const f=fixture();f.old.workspaceRoot=f.request.workspaceRoot.replaceAll('\\','/');
  const r=f.execute();assert.equal(r.status,0,r.stderr);
});

test('legacy request cannot point at a different workspace',()=>{
  const f=fixture();f.old.workspaceRoot=path.join(f.root,'foreign-workspace');
  const r=f.execute();assert.notEqual(r.status,0);assert.match(r.stderr,/HOLD_LEGACY_DEFINITION_UNPROVEN/);
});

test('installed native host supports sealed legacy readback using only an isolated synthetic ledger',
 {skip:!process.env.AICC_QUEUE_TEST_NATIVE_EXE},async()=>{
  const f=fixture();f.next.nativeExecutable=process.env.AICC_QUEUE_TEST_NATIVE_EXE;
  const binding={executable:f.next.nativeExecutable,baseDirectory:f.root};
  const exchange=body=>nativeGptQueueExchange(binding,body);
  const created=await exchange({type:'orchestration_create',definition:{id:runId(f.old),
    title:f.request.title,startPaused:true,roles:f.roles}});
  assert.equal(created.ok,true);
  const cancelled=await exchange({type:'orchestration_control',runId:runId(f.old),action:'cancel',expectedRevision:created.payload.revision});
  assert.equal(cancelled.ok,true);
  const read=await exchange({type:'orchestration_get',runId:runId(f.old)});
  assert.equal(read.payload.revision,2);assert.equal(read.payload.run.ownerBinding,undefined);
  assert.ok(read.payload.run.roles.every(r=>r.attempt===0&&r.history.length===0));
  const ledger=path.join(f.root,'.webgpt-queue-orchestrator','state.json'),before=fileHash(ledger);
  // Mock fixture state uses a different path so it cannot overwrite native evidence.
  const oldFile=put(path.join(f.root,'actual-old.json'),f.old),nextFile=put(path.join(f.root,'actual-next.json'),f.next);
  const receiptFile=put(path.join(f.root,'actual-cancel.json'),f.receipt);
  const r=spawnSync(process.execPath,['--input-type=module','-e',script,process.cwd(),oldFile,nextFile,receiptFile,fileHash(receiptFile)],
    {encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).previousProof,'SEALED_LEGACY_CANCELLED_UNSENT');
  assert.equal(fileHash(ledger),before);
});
