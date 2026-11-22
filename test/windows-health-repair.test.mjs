import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repairPlan,repairActionStatus} from '../src/windows-health-repair.mjs';
const healthy=()=>({native:{install:'ok',provider:'openai'},sandbox:{provisioning:'complete'},workspace:{state:'ready',taskOwned:true,canStart:false,activeLeases:0}});
test('official elevation refusal reports the required foreground step without losing other errors',()=>{
 assert.equal(repairActionStatus({code:1,stderr:'Error: orchestrator_elevation_required: sandbox provisioning setup must be run from an elevated process'}),'NEEDS_FOREGROUND');
 assert.equal(repairActionStatus({code:1,stderr:'helper_sandbox_lock_failed'}),'FAILED');
 assert.equal(repairActionStatus({code:0}),'DISPATCHED');
});
test('healthy Native is a no-op; OCX, history and Defender stay outside repair',()=>{assert.deepEqual(repairPlan(healthy()),{allowed:true,actions:[],ocxAction:'none',historyAction:'none',defenderAction:'none'});});
test('a stopped owner is repairable only with exact zero leases and positive start guard',()=>{const state=healthy();state.workspace={state:'attention',taskOwned:true,canStart:true,activeLeases:0};assert.deepEqual(repairPlan(state).actions,['repair_owned_workspace_task']);for(const value of [1,null,undefined]){state.workspace.activeLeases=value;assert.equal(repairPlan(state).allowed,false);}});
test('non Native provider or unknown install is preserved without mutation',()=>{const state=healthy();state.native.provider='opencodex';assert.equal(repairPlan(state).allowed,false);state.native.provider='openai';state.native.install='warning';assert.equal(repairPlan(state).allowed,false);});
test('background recovery never launches sandbox elevation prompts',()=>{const state=healthy();state.sandbox.provisioning='incomplete';assert.deepEqual(repairPlan(state,{background:true}).actions,['sandbox_requires_foreground']);assert.deepEqual(repairPlan(state).actions,['official_sandbox_setup']);});
test('explicit sandbox fallback uses official setup, while background still requires foreground',()=>{
  assert.deepEqual(repairPlan(healthy(),{forceSandbox:true}).actions,['official_sandbox_setup']);
  assert.deepEqual(repairPlan(healthy(),{forceSandbox:true,background:true}).actions,['sandbox_requires_foreground']);
});
test('fresh readiness catches broken setup even when the old provisioning marker is complete',()=>{
  const state=healthy();state.sandbox.readiness='notConfigured';
  assert.deepEqual(repairPlan(state).actions,['official_sandbox_setup']);
  assert.deepEqual(repairPlan(state,{background:true}).actions,['sandbox_requires_foreground']);
  state.sandbox.readiness='ready';assert.deepEqual(repairPlan(state).actions,[]);
});

test('health does not label an integrated local route as official Native based on provider name',async()=>{
 const {configuredHealthRoute}=await import('../src/windows-health-repair.mjs');
 assert.equal(configuredHealthRoute('openai_base_url = "http://127.0.0.1:17841/v1"','openai').mode,'integrated-local');
 assert.equal(configuredHealthRoute('openai_base_url = "http://127.0.0.1:10100/v1"','openai').mode,'ocx');
 assert.equal(configuredHealthRoute('[profiles.other]\nopenai_base_url = "http://127.0.0.1:17841/v1"','openai').mode,'native');
 assert.equal(configuredHealthRoute('openai_base_url = "https://other.example/v1"','openai').mode,'custom');
 assert.equal(configuredHealthRoute('','unknown').mode,'custom');
 assert.equal(configuredHealthRoute('','openai').threadRouteVerified,false);
});
test('Native repair cannot mutate a locally integrated model route merely named openai',()=>{
 const state=healthy();state.route={mode:'integrated-local'};
 state.workspace={state:'attention',taskOwned:true,canStart:true,activeLeases:0};
 assert.equal(repairPlan(state).allowed,false);
 assert.deepEqual(repairPlan(state).actions,[]);
});