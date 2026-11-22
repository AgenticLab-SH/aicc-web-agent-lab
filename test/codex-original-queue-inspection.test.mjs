import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {inspectInstalledOriginalQueue,main} from '../tools/platform/codex/inspect-original-queue.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-original-queue-read-'));
 const executable=path.join(dir,'codex.bin');fs.writeFileSync(executable,'fake-pinned-binary');
 const threadId='11111111-1111-4111-8111-111111111111';
 const attempt={id:'22222222-2222-4222-8222-222222222222',threadId,
  queuedMessageId:'33333333-3333-4333-8333-333333333333',transport:'codex-queue',automaticReplay:false,
  binarySha256:sha(fs.readFileSync(executable)),
  messageSha256:'a'.repeat(64),marker:'AICC_QUEUE_ATTEMPT:22222222-2222-4222-8222-222222222222'};
 const cfg={schemaVersion:1,protocolVersion:3,workerStopRequestedAt:'preserved',
  threads:{[threadId]:{threadId,projectRoot:dir,queueAttempt:attempt}}};
 const manifest={executable,executableSha256:sha(fs.readFileSync(executable)),codexVersion:'1',
  productionStableAllowlist:['thread/read','thread/queue/list'],originalQueueInspection:{
   method:'thread/queue/list',readOnly:true,senderAllowed:false,
   paramsSchemaSha256:'a'.repeat(64),responseSchemaSha256:'b'.repeat(64)}};
 const registryFile=path.join(dir,'registry.json'),manifestFile=path.join(dir,'manifest.json');
 const save=()=>{fs.writeFileSync(registryFile,JSON.stringify(cfg));fs.writeFileSync(manifestFile,JSON.stringify(manifest));};save();
 const options={threadId,projectRoot:dir,registryFile,manifestFile,
  registrySha256:sha(fs.readFileSync(registryFile)),manifestSha256:sha(fs.readFileSync(manifestFile)),
  attemptSha256:sha(JSON.stringify(attempt))};
 const calls=[];
 const deps={probe:(exe,args)=>{calls.push({exe,args});return {status:0,stdout:JSON.stringify({
  status:'running',appServerVersion:'1',managedCodexPath:executable,socketPath:path.join(dir,'socket')})};},
  makeProxy:()=>{calls.push('proxy');return ()=>{};},
  makeClient:()=>({connect:async()=>calls.push('connect'),close:()=>calls.push('close'),
   threadRead:async()=>({thread:{id:threadId,cwd:dir,status:{type:'notLoaded'},turns:[]}}),
   threadQueueListForInspection:async()=>({data:[]})})};
 return {dir,options,deps,cfg,manifest,calls,save};
}
test('installed original queue reader uses existing daemon without changing maintenance or pending',async()=>{
 const f=fixture(),before=fs.readFileSync(f.options.registryFile);
 const r=await inspectInstalledOriginalQueue(f.options,f.deps);
 assert.equal(r.state,'ORIGINAL_QUEUE_OWNER_NOT_LOADED_HOLD');
 assert.deepEqual(f.calls[0].args,['app-server','daemon','version']);
 assert.equal(r.registrationChanged,false);assert.equal(r.queueMutations,0);
 assert.deepEqual(fs.readFileSync(f.options.registryFile),before);
 assert.equal(f.calls.at(-1),'close');
});
test('daemon refusal does not start or switch servers',async()=>{
 const f=fixture();f.deps.probe=(exe,args)=>{f.calls.push(args);return {status:1,stdout:''};};
 const r=await inspectInstalledOriginalQueue(f.options,f.deps);
 assert.equal(r.state,'ORIGINAL_QUEUE_ORIGINAL_DAEMON_UNAVAILABLE_HOLD');
 assert.equal(f.calls.length,1);assert.equal(r.pendingPreserved,true);
});
test('wrong binary and broad manifest cannot establish original sender ownership',async()=>{
 for(const mode of ['pin','allowlist','root','attempt','issuer']){
  const f=fixture();
  if(mode==='pin')fs.writeFileSync(f.manifest.executable,'changed');
  if(mode==='allowlist')f.manifest.productionStableAllowlist.push('turn/start');
  if(mode==='root')f.options.projectRoot=path.dirname(f.dir);
  if(mode==='attempt')f.options.attemptSha256='0'.repeat(64);
  if(mode==='issuer'){
   f.cfg.threads[f.options.threadId].queueAttempt.binarySha256='f'.repeat(64);
   f.options.attemptSha256=sha(JSON.stringify(f.cfg.threads[f.options.threadId].queueAttempt));
  }
  f.save();f.options.manifestSha256=sha(fs.readFileSync(f.options.manifestFile));
  f.options.registrySha256=sha(fs.readFileSync(f.options.registryFile));
  const r=await inspectInstalledOriginalQueue(f.options,f.deps);
  assert.match(r.state,/HOLD$/,mode);assert.equal(f.calls.length,0,mode);
  assert.equal(r.registrationChanged,false,mode);
 }
});
test('registry mutation during original queue read discards observation and closes client',async()=>{
 const f=fixture(),make=f.deps.makeClient;
 f.deps.makeClient=()=>{const client=make();client.threadQueueListForInspection=async()=>{
  f.cfg.workerStopRequestedAt='new-stop';f.save();return {data:[]};};return client;};
 const r=await inspectInstalledOriginalQueue(f.options,f.deps);
 assert.equal(r.state,'ORIGINAL_QUEUE_INSPECTION_UNAVAILABLE_HOLD');
 assert.equal(r.pendingPreserved,true);assert.equal(f.calls.at(-1),'close');
 assert.equal(JSON.parse(fs.readFileSync(f.options.registryFile)).workerStopRequestedAt,'new-stop');
});
test('missing exact read arguments perform no operation',async()=>{
 assert.equal((await main([])).state,'ORIGINAL_QUEUE_EXACT_ARGUMENTS_HOLD');
});

test('issuer replacement during version probe is refused before connecting',async()=>{
 const f=fixture(),probe=f.deps.probe;
 const alias=path.join(f.dir,'daemon.bin');fs.copyFileSync(f.manifest.executable,alias);
 f.deps.probe=(...args)=>{
  const result=probe(...args),daemon=JSON.parse(result.stdout);
  daemon.managedCodexPath=alias;
  fs.appendFileSync(f.manifest.executable,' replaced');
  return {...result,stdout:JSON.stringify(daemon)};
 };
 const before=fs.readFileSync(f.options.registryFile);
 const r=await inspectInstalledOriginalQueue(f.options,f.deps);
 assert.equal(r.state,'ORIGINAL_QUEUE_ISSUER_INSTALLATION_DRIFT_HOLD');
 assert.equal(f.calls.length,1);assert.equal(r.pendingPreserved,true);
 assert.deepEqual(fs.readFileSync(f.options.registryFile),before);
});

test('binary drift after exact terminal observation discards evidence',async()=>{
 for(const target of ['executable','daemon']){
  const f=fixture(),make=f.deps.makeClient,probe=f.deps.probe;
  const alias=path.join(f.dir,'daemon.bin');fs.copyFileSync(f.manifest.executable,alias);
  f.deps.probe=(...args)=>{
   const result=probe(...args),daemon=JSON.parse(result.stdout);
   daemon.managedCodexPath=alias;return {...result,stdout:JSON.stringify(daemon)};
  };
  const message='approved work',attempt=f.cfg.threads[f.options.threadId].queueAttempt;
  attempt.messageSha256=sha(message);f.options.attemptSha256=sha(JSON.stringify(attempt));
  f.save();f.options.registrySha256=sha(fs.readFileSync(f.options.registryFile));
  f.deps.makeClient=()=>{
   const client=make();let reads=0;
   client.threadRead=async()=>{
    if(++reads===2)fs.appendFileSync(target==='executable'?f.manifest.executable:alias,' replaced');
    return {thread:{id:f.options.threadId,cwd:f.dir,status:{type:'idle'},turns:[{
     id:'44444444-4444-4444-8444-444444444444',status:'completed',items:[{
      type:'userMessage',content:[{type:'text',text:message+'\n\n'+attempt.marker}]}]}]}};
   };return client;
  };
  const before=fs.readFileSync(f.options.registryFile);
  const r=await inspectInstalledOriginalQueue(f.options,f.deps);
  assert.equal(r.state,'ORIGINAL_QUEUE_ISSUER_INSTALLATION_DRIFT_HOLD',target);
  assert.equal(r.pendingPreserved,true);assert.equal(r.queueMutations,0);
  assert.equal(r.modelRequests,0);assert.equal(f.calls.at(-1),'close');
  assert.equal(r.turnId,undefined);
  assert.deepEqual(fs.readFileSync(f.options.registryFile),before);
 }
});
