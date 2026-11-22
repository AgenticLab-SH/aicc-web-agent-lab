import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { ResourceLeaseManager } from '../src/control-plane/resource-lease.mjs';
import { FocusGuard } from '../src/control-plane/focus-guard.mjs';
import { GuardedCuaDriver } from '../src/control-plane/cua-driver-adapter.mjs';

function fixture(t,{backgroundFails=false,verifyStatus='satisfied',activityActive=false,activityUnknown=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-cua-adapter-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const leases=new ResourceLeaseManager({store:new DurableJobStore({root})});
  const focusGuard=new FocusGuard({resourceLeases:leases});
  const calls=[];
  const runner=(exe,args)=>{
    const tool=args[0]; const input=JSON.parse(args[1]); calls.push({tool,input});
    if(tool==='get_window_state') return {status:0,stdout:JSON.stringify({structuredContent:{snapshot_id:'s1234abcd',elements:[{element_token:'s1234abcd:7',element_index:7}]}}),stderr:''};
    if(tool==='click' && input.delivery_mode==='background' && backgroundFails) return {status:1,stdout:JSON.stringify({isError:true,error:{code:'background_unavailable',message:'needs foreground'}}),stderr:''};
    if(tool==='verify_state') return {status:0,stdout:JSON.stringify({structuredContent:{status:verifyStatus}}),stderr:''};
    return {status:0,stdout:JSON.stringify({ok:true,effect:'delivered'}),stderr:''};
  };
  const activityProbe=()=>{if(activityUnknown)throw new Error('probe failed');return{active:activityActive,idleMs:activityActive?100:5000,source:'fixture'};};
  return {calls,leases,driver:new GuardedCuaDriver({runner,focusGuard,activityProbe})};
}

const input={pid:1234,windowId:5678,session:'task-1',ownerTaskId:'task-1',ownerActorId:'agent-a',action:'click',actionArgs:{element_token:'s1234abcd:7'},expect:[{element:{selector:{label_contains:'Done'},exists:true}}]};

test('CUA adapter snapshots first, uses background delivery, then verifies',t=>{
  const f=fixture(t);
  const result=f.driver.perform(input);
  assert.equal(result.route,'background');
  assert.deepEqual(f.calls.map(x=>x.tool),['get_window_state','click','verify_state']);
  assert.equal(f.calls[1].input.delivery_mode,'background');
  assert.equal(f.leases.status().active,0);
});

test('foreground escalation happens only after explicit background_unavailable and authorization',t=>{
  const f=fixture(t,{backgroundFails:true});
  const result=f.driver.perform({...input,foregroundAuthorized:true});
  assert.equal(result.route,'foreground');
  assert.deepEqual(f.calls.map(x=>x.tool),['get_window_state','click','click','verify_state']);
  assert.equal(f.calls[1].input.delivery_mode,'background');
  assert.equal(f.calls[2].input.delivery_mode,'foreground');
  const focus=f.leases.status().leases.filter(x=>x.resourceType==='ui-focus');
  assert.equal(focus.length,1); assert.equal(focus[0].state,'released');
});

test('background failure does not steal focus without explicit foreground authorization',t=>{
  const f=fixture(t,{backgroundFails:true});
  assert.throws(()=>f.driver.perform(input),e=>e.code==='foreground_authorization_required');
  assert.deepEqual(f.calls.map(x=>x.tool),['get_window_state','click']);
});

test('active user blocks authorized foreground escalation',t=>{
  const f=fixture(t,{backgroundFails:true});
  assert.throws(()=>f.driver.perform({...input,foregroundAuthorized:true,userActive:true}),e=>e.code==='user_focus_busy');
  assert.deepEqual(f.calls.map(x=>x.tool),['get_window_state','click']);
});

test('stale or foreign element tokens are rejected before the action call',t=>{
  const f=fixture(t);
  assert.throws(()=>f.driver.perform({...input,actionArgs:{element_token:'s99999999:1'}}),e=>e.code==='cua_snapshot_token_mismatch');
  assert.deepEqual(f.calls.map(x=>x.tool),['get_window_state']);
});

test('an unsatisfied postcondition fails closed after one action rather than retrying',t=>{
  const f=fixture(t,{verifyStatus:'unsatisfied'});
  assert.throws(()=>f.driver.perform(input),e=>e.code==='cua_postcondition_not_satisfied');
  assert.deepEqual(f.calls.map(x=>x.tool),['get_window_state','click','verify_state']);
});

test('observed recent Windows-style user activity blocks foreground even when caller says idle',t=>{
  const f=fixture(t,{backgroundFails:true,activityActive:true});
  assert.throws(()=>f.driver.perform({...input,foregroundAuthorized:true,userActive:false}),e=>e.code==='user_focus_busy');
  assert.deepEqual(f.calls.map(x=>x.tool),['get_window_state','click']);
});

test('unknown user activity fails closed before foreground delivery',t=>{
  const f=fixture(t,{backgroundFails:true,activityUnknown:true});
  assert.throws(()=>f.driver.perform({...input,foregroundAuthorized:true}),e=>e.code==='user_activity_unknown');
  assert.deepEqual(f.calls.map(x=>x.tool),['get_window_state','click']);
});
