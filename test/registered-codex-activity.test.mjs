import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readRegisteredCodexActivity } from '../src/jobs/registered-codex-activity.mjs';
import { readMobileWorkActivity } from '../src/jobs/status.mjs';
const now = Date.parse('2026-11-17T00:00:00Z');
const id = '11111111-2222-4333-8444-555555555555';
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-registered-activity-'));
  const stateRoot = path.join(home,'.ai-control-center'), dir = path.join(stateRoot,'control-plane/codex-continuity');
  const sessions = path.join(home,'.codex/sessions');
  fs.mkdirSync(dir,{recursive:true}); fs.mkdirSync(sessions,{recursive:true});
  const rollout = path.join(sessions, id+'.jsonl'), projectRoot = path.join(home,'private-work');
  const cfg = {schemaVersion:1,protocolVersion:3,threads:{[id]:{threadId:id,enabled:true,executionSurface:'cli',rollout,projectRoot}}};
  const registry = path.join(dir,'registrations.json');
  const save = () => fs.writeFileSync(registry,JSON.stringify(cfg));
  const meta = {type:'session_meta',payload:{id,cwd:projectRoot,source:'cli',originator:'codex-tui'}};
  const event = type => ({type:'event_msg',timestamp:new Date(now-1000).toISOString(),payload:{type,turn_id:'t'}});
  const write = events => fs.writeFileSync(rollout,[meta,...events].map(x=>JSON.stringify(x)).join('\n')+'\n');
  save(); write([event('task_started')]);
  return {home,stateRoot,cfg,registry,rollout,save,write,event,read:()=>readRegisteredCodexActivity({stateRoot,now})};
}
test('exact registered original CLI is observed without mutation or private metadata exposure',()=>{
  const f=fixture(), before=fs.readFileSync(f.registry), log=fs.readFileSync(f.rollout);
  const result=f.read(); assert.equal(result.items[0].state,'RECENT_EXECUTION_EVENT');
  assert.equal(result.items[0].actor,'CODEX_CLI');
  assert.doesNotMatch(JSON.stringify(result),/private-work|11111111|rollout|threadId/);
  assert.deepEqual(fs.readFileSync(f.registry),before); assert.deepEqual(fs.readFileSync(f.rollout),log);
  const mobile=readMobileWorkActivity({stateRoot:f.stateRoot,now:()=>now});
  assert.equal(mobile.items[0].state,'RECENT_EXECUTION_EVENT'); assert.equal(mobile.sources.codex,'AVAILABLE');
});
test('wrong identity, foreign root, disabled and missing rollouts never become current execution',()=>{
  const f=fixture(); f.cfg.threads[id].projectRoot=path.join(f.home,'wrong'); f.save();
  assert.equal(f.read().items[0].state,'UNKNOWN');
  f.cfg.threads[id].rollout=path.join(f.home,'outside.jsonl'); f.save(); assert.equal(f.read().items[0].state,'UNKNOWN');
  f.cfg.threads[id].enabled=false; f.save(); assert.equal(f.read().items.length,0);
});
test('partial append and sampled gaps cannot reuse an old running state',()=>{
  const f=fixture();
  f.write([f.event('task_complete')]); fs.appendFileSync(f.rollout,'{"type":"event_msg"');
  assert.equal(f.read().items[0].state,'TURN_ENDED');
  f.write([f.event('task_started'),{type:'response_item',payload:{text:'x'.repeat(600000)}},
    {type:'response_item',timestamp:new Date(now-1).toISOString(),payload:{type:'function_call_output',output:'private'}}]);
  assert.equal(f.read().items[0].state,'UNKNOWN');
});
test('invalid registry preserves UNKNOWN and never claims all agents idle',()=>{
  const f=fixture(); fs.writeFileSync(f.registry,'{}'); assert.equal(f.read().status,'UNKNOWN');
  const result=readMobileWorkActivity({stateRoot:f.stateRoot,now:()=>now}); assert.equal(result.status,'UNKNOWN');
});

function observeExec(f, events) {
  const ops=path.join(f.home,'.codex/ops/current'); fs.mkdirSync(ops,{recursive:true});
  const eventStream=path.join(ops,'events.jsonl');
  const file=path.join(f.stateRoot,'control-plane/session-registry.json');
  const binding={enabled:true,rollout:f.rollout,projectRoot:f.cfg.threads[id].projectRoot,eventStream};
  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,sessions:[{threadId:id,activityObservation:binding}]}));
  fs.writeFileSync(f.rollout,JSON.stringify({type:'session_meta',payload:{id,cwd:binding.projectRoot,source:'exec',originator:'codex_exec'}})+'\n');
  const save=value=>{fs.writeFileSync(eventStream,[{type:'thread.started',thread_id:id},...value].map(x=>JSON.stringify(x)).join('\n')+'\n');fs.utimesSync(eventStream,now/1000,(now-1000)/1000);};
  fs.utimesSync(f.rollout,now/1000,(now-2000)/1000);
  save(events);
  return {binding,file,eventStream,save};
}
test('explicit exec observation works without enabling continuity and never exposes command text',()=>{
  const f=fixture(); f.cfg.threads[id].enabled=false; f.save();
  const o=observeExec(f,[{type:'item.started',item:{type:'command_execution',command:'private-secret'}}]);
  const before=fs.readFileSync(o.file), continuity=fs.readFileSync(f.registry);
  assert.equal(f.read().items[0].state,'RECENT_EXECUTION_EVENT');
  assert.equal(f.read().items[0].evidence,'EXEC_COMMAND_EVENT');
  assert.doesNotMatch(JSON.stringify(f.read()),/private-secret|eventStream|threadId/);
  assert.deepEqual(fs.readFileSync(o.file),before);assert.deepEqual(fs.readFileSync(f.registry),continuity);
  o.save([{type:'item.completed',item:{type:'command_execution'}},{type:'turn.completed'}]);
  assert.equal(f.read().items[0].state,'TURN_ENDED');
  o.save([{type:'item.started',item:{type:'command_execution'}}]);fs.utimesSync(o.eventStream,now/1000,(now-121000)/1000);
  assert.equal(f.read().items[0].state,'STALE_OR_WAITING');
});
test('exec stream wrong identity, unregistered path, partial write and agent prose cannot claim tool execution',()=>{
  const f=fixture(),o=observeExec(f,[{type:'item.completed',item:{type:'agent_message',text:'done'}}]);
  assert.equal(f.read().items[0].state,'STALE_OR_WAITING');
  fs.appendFileSync(o.eventStream,'{"type":');assert.equal(f.read().items[0].state,'UNKNOWN');
  fs.writeFileSync(o.eventStream,JSON.stringify({type:'thread.started',thread_id:'different'})+'\n');
  assert.equal(f.read().items[0].state,'UNKNOWN');
  o.binding.eventStream=path.join(f.home,'foreign.jsonl');
  fs.writeFileSync(o.file,JSON.stringify({schemaVersion:1,sessions:[{threadId:id,activityObservation:o.binding}]}));
  assert.equal(f.read().items[0].state,'UNKNOWN');
});

test('newer original rollout makes a previous exec completion historical; prose cannot refresh a command',()=>{
  const f=fixture();f.cfg.threads[id].enabled=false;f.save();
  const o=observeExec(f,[{type:'turn.started'},
    {type:'item.completed',item:{type:'command_execution',command:'private build'}},
    {type:'item.completed',item:{type:'agent_message',text:'private progress'}}]);
  assert.equal(f.read().items[0].state,'STALE_OR_WAITING');
  o.save([{type:'turn.completed'}]);
  assert.equal(f.read().items[0].state,'TURN_ENDED');
  fs.appendFileSync(f.rollout,JSON.stringify({type:'event_msg',timestamp:new Date(now).toISOString(),payload:{type:'task_started',turn_id:'new'}})+'\n');
  fs.utimesSync(f.rollout,now/1000,now/1000);
  const result=f.read().items[0];
  assert.equal(result.state,'STALE_OR_WAITING');
  assert.equal(result.evidence,'SAVED_STATE_ONLY');
  assert.equal(result.completionVerified,false);
  o.save([{type:'turn.completed'}]);fs.utimesSync(o.eventStream,now/1000,(now+1000)/1000);
  assert.equal(f.read().items[0].state,'UNKNOWN');
});

test('buffered exec stdout uses complete original native tool events, never partial bytes or prose as execution',()=>{
  const f=fixture();f.cfg.threads[id].enabled=false;f.save();
  const o=observeExec(f,[{type:'turn.started'}]);
  const add=(type,payload)=>fs.appendFileSync(f.rollout,JSON.stringify({type,timestamp:new Date(now-500).toISOString(),payload})+'\n');
  add('response_item',{type:'custom_tool_call',input:'private command'});
  fs.appendFileSync(o.eventStream,'{"type":');
  assert.equal(f.read().items[0].state,'RECENT_EXECUTION_EVENT');
  assert.equal(f.read().items[0].evidence,'TOOL_EVENT');
  assert.doesNotMatch(JSON.stringify(f.read()),/private command/);
  add('event_msg',{type:'task_complete',turn_id:'t'});
  assert.equal(f.read().items[0].state,'TURN_ENDED');
  add('event_msg',{type:'task_started',turn_id:'next'});
  add('response_item',{type:'message',content:'still working'});
  assert.equal(f.read().items[0].state,'RECENT_EXECUTION_EVENT');
  add('response_item',{type:'custom_tool_call_output',output:'private output'});
  fs.appendFileSync(f.rollout,'{"type":');
  assert.equal(f.read().items[0].state,'UNKNOWN');
  fs.writeFileSync(o.eventStream,JSON.stringify({type:'thread.started',thread_id:'foreign'})+'\n{"type":');
  assert.equal(f.read().items[0].state,'UNKNOWN');
});

test('registered conversation title is shown only after exact rollout and stream identity checks',()=>{
  const f=fixture(); f.cfg.threads[id].title='G1 원 실행기'; f.save();
  assert.equal(f.read().items[0].displayName,'G1 원 실행기');
  f.cfg.threads[id].projectRoot=path.join(f.home,'wrong'); f.save();
  assert.equal(f.read().items[0].displayName,undefined);
  f.cfg.threads[id].enabled=false; f.save();
  const o=observeExec(f,[{type:'turn.started'}]);
  const cfg=JSON.parse(fs.readFileSync(o.file)); cfg.sessions[0].title=' G2 합성 PAPER '; fs.writeFileSync(o.file,JSON.stringify(cfg));
  const before=fs.readFileSync(o.file);
  assert.equal(f.read().items[0].displayName,'G2 합성 PAPER');
  assert.equal(readMobileWorkActivity({stateRoot:f.stateRoot,now:()=>now}).items[0].displayName,'G2 합성 PAPER');
  assert.equal(f.read().items[0].writeAuthorized,false); assert.equal(f.read().items[0].completionVerified,false);
  assert.deepEqual(fs.readFileSync(o.file),before);
  fs.writeFileSync(o.eventStream,JSON.stringify({type:'thread.started',thread_id:'foreign'})+'\n');
  assert.equal(f.read().items[0].displayName,undefined);
});

test('invalid or absent titles fall back without hiding execution; HTML-looking names are plain data',()=>{
  const f=fixture();
  for(const title of [undefined,'','  ','private\nvalue','x'.repeat(161),{text:'name'}]){
    f.cfg.threads[id].title=title; f.save();
    assert.equal(f.read().items[0].displayName,null);
    assert.equal(f.read().items[0].state,'RECENT_EXECUTION_EVENT');
  }
  f.cfg.threads[id].title='<img src=x onerror=alert(1)> 코덱스'; f.save();
  assert.equal(f.read().items[0].displayName,f.cfg.threads[id].title);
});
