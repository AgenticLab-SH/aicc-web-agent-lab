import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { ResourceLeaseManager } from '../src/control-plane/resource-lease.mjs';
import { AuthBroker } from '../src/control-plane/auth-broker.mjs';

function spec(overrides={}) { return {
  sessionId:'chatgpt-primary', providerId:'chatgpt-web', accountAlias:'account-a', profileId:'profile-a',
  credentialRef:'browser-profile://chatgpt/profile-a', ownerTaskId:'task-a', ownerActorId:'agent-a', ...overrides
}; }

function fixture(t, states) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-auth-broker-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const leases=new ResourceLeaseManager({store:new DurableJobStore({root})});
  let index=0; const calls=[];
  const adapter={
    inspect: async input => { calls.push({op:'inspect',input}); return states[Math.min(index,states.length-1)]; },
    refresh: async input => { calls.push({op:'refresh',input}); index+=1; return {ok:true}; },
    restore: async input => { calls.push({op:'restore',input}); index+=1; return {ok:true}; }
  };
  return {leases,calls,broker:new AuthBroker({adapter,resourceLeases:leases,now:()=>1_800_000_000_000,expirySkewMs:60_000})};
}

test('ready exact account/profile is reused without an auth mutation', async t=>{
  const f=fixture(t,[{authenticated:true,accountAlias:'account-a',profileId:'profile-a',expiresAt:'2028-01-01T00:00:00Z'}]);
  const result=await f.broker.ensure(spec());
  assert.equal(result.state,'ready'); assert.equal(result.mutated,false);
  assert.deepEqual(f.calls.map(x=>x.op),['inspect']);
});

test('authorized refresh runs once under credential-writer lease and rechecks exact identity', async t=>{
  const f=fixture(t,[
    {authenticated:true,accountAlias:'account-a',profileId:'profile-a',expiresAt:'2026-01-01T00:00:00Z',refreshable:true},
    {authenticated:true,accountAlias:'account-a',profileId:'profile-a',expiresAt:'2028-01-01T00:00:00Z'}
  ]);
  const result=await f.broker.ensure(spec());
  assert.equal(result.state,'ready'); assert.equal(result.reason,'authorized-session-refreshed'); assert.equal(result.mutated,true);
  assert.deepEqual(f.calls.map(x=>x.op),['inspect','refresh','inspect']);
  assert.equal(f.leases.status().states.released,1);
});

test('wrong account or profile fails closed before any refresh or restore', async t=>{
  const f=fixture(t,[{authenticated:true,accountAlias:'account-b',profileId:'profile-a',refreshable:true}]);
  await assert.rejects(()=>f.broker.ensure(spec()),e=>e.code==='account_identity_mismatch');
  assert.deepEqual(f.calls.map(x=>x.op),['inspect']);
});

test('raw credentials are rejected and never delegated to an adapter', async t=>{
  const f=fixture(t,[{authenticated:false,accountAlias:'account-a',profileId:'profile-a'}]);
  await assert.rejects(()=>f.broker.ensure(spec({password:'do-not-store'})),e=>e.code==='raw_credential_prohibited');
  assert.equal(f.calls.length,0);
});

test('non-refreshable session returns one bounded reauth instruction instead of retrying', async t=>{
  const f=fixture(t,[{authenticated:false,accountAlias:'account-a',profileId:'profile-a',refreshable:false,restorable:false}]);
  const result=await f.broker.ensure(spec());
  assert.equal(result.state,'reauth-required'); assert.equal(result.nextAction,'human-reauthenticate-exact-bound-account');
  assert.deepEqual(f.calls.map(x=>x.op),['inspect']);
});

test('adapter results containing tokens are rejected even when the adapter reports success', async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-auth-secret-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const broker=new AuthBroker({adapter:{inspect:async()=>({authenticated:true,accountAlias:'account-a',profileId:'profile-a',accessToken:'secret-value'})}});
  await assert.rejects(()=>broker.ensure(spec()),e=>e.code==='raw_credential_prohibited');
});