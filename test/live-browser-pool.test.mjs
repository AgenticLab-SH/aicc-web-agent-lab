import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { ResourceLeaseManager } from '../src/control-plane/resource-lease.mjs';
import { LiveBrowserPool } from '../src/browser/live-pool.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-live-pool-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const leases=new ResourceLeaseManager({store:new DurableJobStore({root})});
  let current=[
    {slotId:'cdp-9222',identityId:'registered-cdp-9222',profileRoot:'C:/AICC/9222',cdpEndpoint:'http://127.0.0.1:9222',automation:true,poolEligible:true,externallyBusy:false,automaticLeaseEligible:true},
    {slotId:'cdp-9223',identityId:'registered-cdp-9223',profileRoot:'C:/AICC/9223',cdpEndpoint:'http://127.0.0.1:9223',automation:true,poolEligible:true,externallyBusy:false,automaticLeaseEligible:true},
    {slotId:'cdp-9225',identityId:'registered-cdp-9225',profileRoot:'C:/AICC/9225',cdpEndpoint:'http://127.0.0.1:9225',automation:true,poolEligible:false,externallyBusy:false,automaticLeaseEligible:false}
  ];
  const pool=new LiveBrowserPool({resourceLeases:leases,inventory:()=>current});
  return {leases,pool,set:value=>{current=value;}};
}

test('live pool refreshes registry state on every acquire and never allocates externally busy or policy-excluded slots', t=>{
  const f=fixture(t);
  const a=f.pool.acquire({ownerTaskId:'task-a',ownerActorId:'agent-a'});
  assert.equal(a.slotId,'cdp-9222');
  const updated=f.pool.snapshot().map(slot=>slot.slotId==='cdp-9223'?{...slot,poolEligible:false,externallyBusy:true}:slot);
  f.set(updated);
  assert.throws(()=>f.pool.acquire({ownerTaskId:'task-b',ownerActorId:'agent-b'}),e=>e.code==='browser_pool_exhausted');
  f.pool.release(a);
});

test('reconcile reaps expired common leases and reports live external/policy holds without touching them', t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-live-pool-clock-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let now=1_800_000_000_000;
  const leases=new ResourceLeaseManager({store:new DurableJobStore({root,now:()=>now}),now:()=>now,defaultTtlMs:1000,maximumTtlMs:60000});
  leases.acquire({resourceType:'browser-slot',resourceId:'cdp:9222',ownerTaskId:'task-a',ownerActorId:'agent-a',ttlMs:1000});
  now+=1001;
  const pool=new LiveBrowserPool({resourceLeases:leases,inventory:()=>[
    {slotId:'cdp-9222',identityId:'registered-cdp-9222',profileRoot:'C:/AICC/9222',cdpEndpoint:'http://127.0.0.1:9222',automation:true,poolEligible:true,externallyBusy:false,automaticLeaseEligible:true},
    {slotId:'cdp-9223',identityId:'registered-cdp-9223',profileRoot:'C:/AICC/9223',cdpEndpoint:'http://127.0.0.1:9223',automation:true,poolEligible:false,externallyBusy:true,automaticLeaseEligible:true},
    {slotId:'cdp-9225',identityId:'registered-cdp-9225',profileRoot:'C:/AICC/9225',cdpEndpoint:'http://127.0.0.1:9225',automation:true,poolEligible:false,externallyBusy:false,automaticLeaseEligible:false}
  ]});
  const result=pool.reconcile();
  assert.equal(result.recoveredResourceLeases.length,1);
  assert.deepEqual(result.externallyBusySlots,['cdp-9223']);
  assert.deepEqual(result.policyExcludedSlots,['cdp-9225']);
});