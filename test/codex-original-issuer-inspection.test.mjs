import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {inspectInstalledOriginalIssuerCallback,main} from '../tools/platform/codex/inspect-original-issuer-callback.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-issuer-inspection-'));
 const executable=path.join(dir,'codex.bin'),manifestFile=path.join(dir,'manifest.json');
 fs.writeFileSync(executable,'pinned fake executable - never run');
 const manifest={executable,executableSha256:sha(fs.readFileSync(executable)),codexVersion:'1',
  productionStableAllowlist:['thread/read','thread/goal/get','account/rateLimits/read'],
  officialQuotaRead:{method:'account/rateLimits/read',readOnly:true,senderAllowed:false,
   originalCliIssuerBound:false,quotaRecoveryAuthority:false}};
 const registryFile=path.join(dir,'registry.json'),threadId='11111111-1111-4111-8111-111111111111';
 const registry={schemaVersion:1,protocolVersion:3,threads:{[threadId]:{
  threadId,projectRoot:dir,enabled:true,executionSurface:'cli',
  originalIssuerOwnerRevision:'a'.repeat(64),originalIssuerReceiptSha256:'b'.repeat(64),
  originalIssuerWriterProcessIdentitySha256:'c'.repeat(64),
  originalIssuerStopEpoch:1,originalIssuerPreviousStopEpoch:0}},
  originalGeneralCliIssuerProducer:{authorityReader:{},privateKey:{}},originalOcxSelectionReader:{}};
 fs.writeFileSync(registryFile,JSON.stringify(registry));
 const o={manifestFile,registryFile,registrySha256:sha(fs.readFileSync(registryFile)),threadId},calls=[];
 const save=()=>{fs.writeFileSync(manifestFile,JSON.stringify(manifest));o.manifestSha256=sha(fs.readFileSync(manifestFile));};save();
 const deps={probe:(exe,args,options)=>{calls.push({exe,args,options});return {status:0,
  stdout:JSON.stringify({status:'running',appServerVersion:'1',managedCodexPath:executable,socketPath:'original-socket'})};},
  makeProxy:({socketPath})=>{calls.push(['proxy',socketPath]);return ()=>{};},
  makeClient:()=>({connect:async()=>calls.push('connect'),close:()=>calls.push('close')}),
  inspect:async()=>{calls.push('inspect');return {state:'EXACT_ORIGINAL_GATE_HOLD',canApply:false,
   dispatchable:false,registrationChanged:false,modelRequests:0,newTurns:0};}};
 return {o,deps,calls,manifest,save,registry};
}
test('original daemon failure is distinct and never starts or substitutes a server',async()=>{
 for(const result of [{status:1,stderr:'secret diagnostic'}, {error:Error('private timeout')}]){
  const f=fixture();f.deps.probe=(exe,args)=>{f.calls.push(args);return result;};
  const r=await inspectInstalledOriginalIssuerCallback(f.o,f.deps);
  assert.equal(r.state,'ORIGINAL_CALLBACK_ORIGINAL_DAEMON_UNAVAILABLE_HOLD');
  assert.deepEqual(f.calls,[['app-server','daemon','version']]);
  assert.equal(r.automaticRetry,false);assert.equal(r.modelRequests,0);
  assert.ok(!JSON.stringify(r).includes('secret'));
 }
});
test('wrong binary, write-capable manifest and tampered manifest fail before connection',async()=>{
 for(const mode of ['binary','allowlist','sender','authority','missing-method','manifest-pin']){
  const f=fixture();
  if(mode==='binary')fs.writeFileSync(f.manifest.executable,'changed');
  if(mode==='allowlist')f.manifest.productionStableAllowlist.push('turn/start');
  if(mode==='sender')f.manifest.officialQuotaRead.senderAllowed=true;
  if(mode==='authority')f.manifest.officialQuotaRead.quotaRecoveryAuthority=true;
  if(mode==='missing-method')f.manifest.productionStableAllowlist.pop();
  f.save();if(mode==='manifest-pin')fs.appendFileSync(f.o.manifestFile,' ');
  const r=await inspectInstalledOriginalIssuerCallback(f.o,f.deps);
  assert.match(r.state,/HOLD$/);assert.equal(f.calls.length,0,mode);
 }
});
test('foreign daemon is refused and original source verdict is preserved with client close',async()=>{
 const f=fixture(),probe=f.deps.probe;
 f.deps.probe=(...args)=>{const result=probe(...args),v=JSON.parse(result.stdout);v.appServerVersion='foreign';return {...result,stdout:JSON.stringify(v)};};
 assert.equal((await inspectInstalledOriginalIssuerCallback(f.o,f.deps)).state,'ORIGINAL_CALLBACK_ORIGINAL_DAEMON_IDENTITY_HOLD');
 assert.equal(f.calls.length,1);
 const g=fixture();assert.equal((await inspectInstalledOriginalIssuerCallback(g.o,g.deps)).state,'EXACT_ORIGINAL_GATE_HOLD');
 assert.equal(g.calls.at(-1),'close');
});
test('connection failure and installation drift discard result and close the original client',async()=>{
 for(const mode of ['connect','binary-drift','manifest-drift']){
  const f=fixture();
  if(mode==='connect')f.deps.makeClient=()=>({connect:async()=>{throw Error('private transport detail');},close:()=>f.calls.push('close')});
  else f.deps.inspect=async()=>{fs.appendFileSync(mode==='binary-drift'?f.manifest.executable:f.o.manifestFile,' ');return {canApply:true};};
  const r=await inspectInstalledOriginalIssuerCallback(f.o,f.deps);
  assert.equal(r.canApply,false);assert.equal(r.registrationChanged,false);
  assert.equal(f.calls.at(-1),'close');assert.equal(r.modelRequests,0);
 }
});
test('missing, duplicate and unknown arguments are rejected without running a daemon',async()=>{
 for(const args of [[],['--manifest','x'],Array(22).fill('--manifest'),['--unexpected','x']])
  assert.equal((await main(args)).state,'ORIGINAL_CALLBACK_EXACT_ARGUMENTS_HOLD');
});

test('version probe cannot substitute a replaced issuer or manifest before connect',async()=>{
 for(const target of ['issuer','manifest']){
  const f=fixture(),probe=f.deps.probe;
  const alias=path.join(path.dirname(f.o.manifestFile),'daemon.bin');
  fs.copyFileSync(f.manifest.executable,alias);
  f.deps.probe=(...args)=>{
   const result=probe(...args),daemon=JSON.parse(result.stdout);
   daemon.managedCodexPath=alias;
   fs.appendFileSync(target==='issuer'?f.manifest.executable:f.o.manifestFile,' changed');
   return {...result,stdout:JSON.stringify(daemon)};
  };
  const r=await inspectInstalledOriginalIssuerCallback(f.o,f.deps);
  assert.equal(r.state,'ORIGINAL_CALLBACK_INSTALLATION_DRIFT_HOLD',target);
  assert.equal(f.calls.length,1);assert.equal(r.canApply,false);
  assert.equal(r.registrationChanged,false);assert.equal(r.modelRequests,0);
 }
});

test('separate daemon binary drift after source read discards callback evidence',async()=>{
 const f=fixture(),probe=f.deps.probe;
 const alias=path.join(path.dirname(f.o.manifestFile),'daemon.bin');
 fs.copyFileSync(f.manifest.executable,alias);
 f.deps.probe=(...args)=>{
  const result=probe(...args),daemon=JSON.parse(result.stdout);
  daemon.managedCodexPath=alias;return {...result,stdout:JSON.stringify(daemon)};
 };
 f.deps.inspect=async()=>{
  fs.appendFileSync(alias,' changed');
  return {state:'STALE_SOURCE_RESULT',canApply:true};
 };
 const r=await inspectInstalledOriginalIssuerCallback(f.o,f.deps);
 assert.equal(r.state,'ORIGINAL_CALLBACK_INSTALLATION_DRIFT_HOLD');
 assert.equal(r.canApply,false);assert.equal(r.registrationChanged,false);
 assert.equal(r.modelRequests,0);assert.equal(r.newTurns,0);
 assert.equal(f.calls.at(-1),'close');
});

test('original producer pending, stop and missing registration hold before daemon access',async()=>{
 for(const mode of ['pending','stop','worker-stop','producer','registry-pin']){
  const f=fixture();
  if(mode==='pending')f.registry.threads.historical={queueAttempt:{state:'QUEUE_ACCEPTED'}};
  if(mode==='stop')f.registry.workerStopRequestedAt='preserved';
  if(mode==='worker-stop')f.registry.worker={state:'STOPPED_FOR_MAINTENANCE'};
  if(mode==='producer')delete f.registry.originalGeneralCliIssuerProducer;
  fs.writeFileSync(f.o.registryFile,JSON.stringify(f.registry));
  f.o.registrySha256=sha(fs.readFileSync(f.o.registryFile));
  if(mode==='registry-pin')fs.appendFileSync(f.o.registryFile,' ');
  const before=fs.readFileSync(f.o.registryFile);
  const r=await inspectInstalledOriginalIssuerCallback(f.o,f.deps);
  assert.equal(r.state,'ORIGINAL_PRODUCER_PREFLIGHT_HOLD',mode);
  assert.equal(f.calls.length,0,mode);assert.equal(r.modelRequests,0);
  assert.equal(r.registrationChanged,false);assert.deepEqual(fs.readFileSync(f.o.registryFile),before);
 }
});
