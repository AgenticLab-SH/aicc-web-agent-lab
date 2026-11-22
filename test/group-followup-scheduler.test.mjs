import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {schedulerTick} from '../src/local-scheduler.mjs';

test('explicit followup scope invokes only the result consumer', async () => {
  let calls=0;
  const result=await schedulerTick({scope:'group-followup',groupFollowupService:{async tick(){calls++;return {changes:[],dispatchSupported:false};}},
    reviewService:{tick(){throw Error('upstream review must remain separate');}},
    monitoringService:{manager:{recoverExpired(){throw Error('unrelated jobs must not run');}}}});
  assert.equal(calls,1);
  assert.equal(result.scope,'group-followup');
  assert.equal(result.automaticApply,false);
  assert.equal(result.followup.dispatchSupported,false);
});

test('unregistered default scope sends no model request',async()=>{
  const result=await schedulerTick({scope:'group-followup',groupFollowup:{registrationPath:fileURLToPath(new URL('./missing-followup-registration.json',import.meta.url))}});
  assert.equal(result.followup.reason,'group-followup-unregistered');
  assert.equal(result.followup.modelRequests,0);
});
