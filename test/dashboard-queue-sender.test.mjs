import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createDashboardWorkspace } from '../src/dashboard-workspace.mjs';
import { createDashboardQueueSender } from '../src/dashboard-queue-sender.mjs';
import { createDashboardQueuePreflight } from '../src/dashboard-queue-preflight.mjs';
import { createServer } from '../src/server.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
const agentId = '23456789-2345-4234-8234-234567890abc';
function fixture() {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-checked-send-'));
  const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
  const root = path.join(ownerRoot, 'control-plane/codex-continuity'), registryFile = path.join(root, 'registrations.json');
  const portfolioRoot = path.join(ownerRoot, 'portfolio'), workerStateRoot = path.join(ownerRoot, 'workers');
  write(path.join(portfolioRoot, 'group-registry.json'), { groups: [{id:'G3', name:'대시보드'}] });
  write(path.join(workerStateRoot, 'G3.state.json'), {jobId:'G3',threadId:agentId,state:'partial'});
  const helper = path.join(ownerRoot, 'releases/codex-continuity/fixture/helper.ps1');
  fs.mkdirSync(path.dirname(helper), { recursive: true }); fs.writeFileSync(helper, '# Dashboard checked send reuses this exact sender\n# INERT FAKE');
  const registry = {schemaVersion:1,protocolVersion:3,helperPath:helper,helperSha256:sha(fs.readFileSync(helper)),threads:{[agentId]:{threadId:agentId,state:'DISABLED'},other:{queueAttempt:{id:'history',state:'UNKNOWN'}}}};
  write(registryFile, registry);
  const dashboard = createDashboardWorkspace({ownerRoot,portfolioRoot,workerStateRoot,codexHome:ownerRoot});
  const commit = input => dashboard.commit({...input,expectedRevision:dashboard.status().revision},randomUUID());
  commit({action:'queue-stop',stopped:false});commit({action:'queue-add',agentId,instruction:'한글\n  literal $() and `ticks`'});
  const id = dashboard.status().queue[0].id;commit({action:'queue-prepare',id});
  write(path.join(root,'requests',id+'.preflight-evidence.json'),{synthetic:true});
  const f={ownerRoot,root,registryFile,registry,helper,dashboard,commit,id,write,calls:[],stage:'QUEUE_ACCEPTED',preflightReady:true};
  f.input=()=>({id,expectedRevision:dashboard.status().revision});
  const queuePreflight={inspect:async()=>({ready:f.preflightReady})};
  f.runner=async (_exe,args)=>{
    f.calls.push(args);assert.match(args.at(-1),/-Action QueueMessage/);assert.match(args.at(-1),new RegExp(id));assert.match(args.at(-1),new RegExp(agentId));assert.doesNotMatch(args.at(-1),/literal|ticks/);
    assert.throws(()=>f.commit({action:'queue-stop',stopped:true}),/writer_busy/);
    if(f.throwTransport)throw Error('timeout');
    const intent=dashboard.status().queue[0];
    const receipt={id,threadId:agentId,messageSha256:intent.messageSha256,marker:intent.marker,transport:'codex-queue',state:f.stage,at:new Date().toISOString(),queuedMessageId:randomUUID(),acceptedAt:new Date().toISOString(),...(['QUEUE_TURN_ACTIVE','QUEUE_TURN_COMPLETED','QUEUE_TURN_INTERRUPTED'].includes(f.stage)?{turnId:randomUUID(),terminalAt:new Date().toISOString()}:{}),...f.badReceipt};
    write(path.join(root,'requests',id+'.json'),receipt);f.registry.threads[agentId].queueAttempt=receipt;write(registryFile,f.registry);return receipt;
  };f.sender=createDashboardQueueSender({ownerRoot,dashboard,queuePreflight,runner:f.runner});return f;
}
test('checked sender locks exact intent, preserves unrelated UNKNOWN, sends once and reconciles acceptance separately',async()=>{
  const f=fixture(),input=f.input(),p=await f.sender.prepare(input);assert.equal(f.calls.length,0);
  const result=await f.sender.execute(input,p);assert.equal(result.stage,'ACCEPTED');assert.equal(result.goalComplete,false);
  assert.equal(f.calls.length,1);await assert.rejects(f.sender.execute(input,p),/preserved|pending/);
  f.commit({action:'queue-reconcile',id:f.id});assert.equal(f.dashboard.status().queue[0].state,'ACCEPTED');
  assert.equal(f.registry.threads.other.queueAttempt.state,'UNKNOWN');
});
test('turn active, terminal and uncertain are distinct and never imply goal completion',async()=>{
  for(const [stage,expected] of [['QUEUE_TURN_ACTIVE','RUNNING'],['QUEUE_TURN_COMPLETED','TURN_COMPLETED'],['QUEUE_TURN_INTERRUPTED','INTERRUPTED'],['QUEUE_DELIVERY_UNCERTAIN','UNKNOWN']]){
    const f=fixture();f.stage=stage;const input=f.input(),p=await f.sender.prepare(input);const r=await f.sender.execute(input,p);assert.equal(r.stage,expected);assert.equal(r.goalComplete,false);
    f.commit({action:'queue-reconcile',id:f.id});assert.equal(f.dashboard.status().queue[0].state,expected);
  }
});
test('stale revision, changed pin/evidence, admission hold, arbitrary input and existing same request never send',async()=>{
  for(const mutate of [
    f=>f.commit({action:'pin',agentId,pinned:true}),
    f=>fs.appendFileSync(f.helper,'changed'),
    f=>f.write(path.join(f.root,'requests',f.id+'.preflight-evidence.json'),{changed:true}),
    f=>{f.preflightReady=false;},
    f=>{f.registry.threads[agentId].queueAttempt={id:f.id,state:'UNKNOWN'};f.write(f.registryFile,f.registry);},
    f=>f.write(path.join(f.root,'requests',f.id+'.json'),{id:f.id,state:'UNKNOWN',original:true})
  ]){const f=fixture(),input=f.input(),p=await f.sender.prepare(input);mutate(f);await assert.rejects(f.sender.execute(input,p));assert.equal(f.calls.length,0);}
  const f=fixture();await assert.rejects(f.sender.prepare({...f.input(),command:'arbitrary'}),/input_invalid/);assert.equal(f.calls.length,0);
});
test('transport failure or wrong exact receipt preserves one-use send record without retry',async()=>{
  for(const change of [f=>{f.throwTransport=true;},f=>{f.badReceipt={threadId:randomUUID()};},f=>{f.badReceipt={id:randomUUID()};},f=>{f.badReceipt={messageSha256:'f'.repeat(64)};}]){
    const f=fixture();change(f);const input=f.input(),p=await f.sender.prepare(input);assert.equal((await f.sender.execute(input,p)).stage,'UNKNOWN');
    const original=fs.readFileSync(path.join(f.root,'requests',f.id+'.dashboard-send.json'));await assert.rejects(f.sender.execute(input,p));assert.equal(f.calls.length,1);assert.deepEqual(fs.readFileSync(path.join(f.root,'requests',f.id+'.dashboard-send.json')),original);
  }
});
test('registered preflight and sender compose through the same injected runner, with no dispatch in preview',async()=>{
  const f=fixture();fs.appendFileSync(f.helper,"\n'QueuePreflight' { }");f.registry.helperSha256=sha(fs.readFileSync(f.helper));f.write(f.registryFile,f.registry);
  let inspections=0;
  const runner=async(exe,args)=>{
    if(args.at(-1).includes('-Action QueuePreflight')){inspections++;const intent=f.dashboard.inspectHandoff(f.input());return {schemaVersion:1,kind:'aicc-queue-preflight',state:'READY_NOT_AUTHORIZED',threadId:agentId,operationId:f.id,messageSha256:intent.messageSha256,targetRoute:'EXACT_OCX',idleVerified:true,quotaFresh:true,binarySha256:'b'.repeat(64),evidenceSha256:sha(fs.readFileSync(path.join(f.root,'requests',f.id+'.preflight-evidence.json'))),observedAt:new Date().toISOString(),dispatched:false,claimed:false,automaticDelivery:false};}
    return f.runner(exe,args);
  };
  const queuePreflight=createDashboardQueuePreflight({ownerRoot:f.ownerRoot,dashboard:f.dashboard,runner});
  const sender=createDashboardQueueSender({ownerRoot:f.ownerRoot,dashboard:f.dashboard,queuePreflight,runner});
  const input=f.input(),p=await sender.prepare(input);assert.equal(f.calls.length,0);assert.equal(inspections,1);
  assert.equal((await sender.execute(input,p)).stage,'ACCEPTED');assert.equal(inspections,2);assert.equal(f.calls.length,1);
});
test('HTTP stale confirmation is consumed without creating a send attempt',async t=>{
  const f=fixture(),server=createServer({goals:{ownerRoot:f.ownerRoot},mobile:{ownerRoot:f.ownerRoot,dashboard:f.dashboard,queueSender:f.sender,trayTools:{status:async()=>({catalog:[],unresolved:[]})}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const origin=`http://127.0.0.1:${server.address().port}`;
  const api=async(name,body,headers={})=>{const r=await fetch(origin+'/api/mobile/'+name,{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify(body)});return {headers:r.headers,data:await r.json()};};
  const session=await api('local-session',{}),auth={cookie:session.headers.get('set-cookie').split(';')[0],'x-aicc-csrf':session.data.csrf};
  const p=await api('preview',{kind:'queue-send',config:f.input()},auth);f.commit({action:'queue-pause',agentId,paused:true});
  assert.equal((await api('confirm',{confirmationToken:p.data.confirmationToken},auth)).data.ok,false);
  assert.equal((await api('confirm',{confirmationToken:p.data.confirmationToken},auth)).data.code,'confirmation_expired');assert.equal(f.calls.length,0);assert.equal(fs.existsSync(path.join(f.root,'requests',f.id+'.dashboard-send.json')),false);
});
test('HTTP preview/one confirmation/exact sender uses authenticated CSRF path and preserves historical UNKNOWN',async t=>{
  const f=fixture(),server=createServer({goals:{ownerRoot:f.ownerRoot},mobile:{ownerRoot:f.ownerRoot,dashboard:f.dashboard,queueSender:f.sender,trayTools:{status:async()=>({catalog:[],unresolved:[]})}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const origin=`http://127.0.0.1:${server.address().port}`;
  const api=async(name,body,headers={})=>{const r=await fetch(origin+'/api/mobile/'+name,{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify(body)});return {headers:r.headers,data:await r.json()};};
  const input={kind:'queue-send',config:f.input()};assert.equal((await api('preview',input)).data.code,'pair_required');
  const session=await api('local-session',{}),cookie=session.headers.get('set-cookie').split(';')[0],auth={cookie,'x-aicc-csrf':session.data.csrf};
  assert.equal((await api('preview',input,{cookie})).data.code,'csrf_required');
  f.write(path.join(f.ownerRoot,'status-tray/requests/mobile-'+ 'a'.repeat(32)+'.json'),{operationId:'a'.repeat(32),kind:'unrelated',state:'UNKNOWN'});
  const p=await api('preview',input,auth);assert.equal(p.data.ok,true);assert.equal(f.calls.length,0);
  const c=await api('confirm',{confirmationToken:p.data.confirmationToken},auth);assert.equal(c.data.ok,true);
  const lookup=await (await fetch(origin+'/api/mobile/operation-by-confirmation?sha256='+sha(p.data.confirmationToken),{headers:{cookie}})).json();assert.equal(lookup.operationId,c.data.operationId);
  assert.equal((await api('confirm',{confirmationToken:p.data.confirmationToken},auth)).data.code,'confirmation_expired');
  let result;for(let i=0;i<30;i++){result=await (await fetch(origin+'/api/mobile/operation?id='+c.data.operationId,{headers:{cookie}})).json();if(result.state!=='DISPATCHING')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(result.state,'COMPLETED');assert.equal(result.queueResult.stage,'ACCEPTED');assert.equal(f.calls.length,1);assert.equal(f.dashboard.status().queue[0].state,'HANDOFF_READY');
});
