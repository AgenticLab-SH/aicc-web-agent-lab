import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthBroker } from '../src/control-plane/auth-broker.mjs';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { ResourceLeaseManager } from '../src/control-plane/resource-lease.mjs';
import { RegisteredCdpAuthAdapter } from '../src/browser/auth-adapter.mjs';

const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

function fixture(t,{offline=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-cdp-auth-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profile=path.join(root,'profile'); fs.mkdirSync(profile);
  const launcher=path.join(root,'launch.cmd'); fs.writeFileSync(launcher,'@echo off');
  const coordinationPath=path.join(root,'coordination.toml');
  fs.writeFileSync(coordinationPath,`[browser]\ncdp_slot_count = 1\ncdp_slot1_port = 19222\ncdp_slot1_profile_dir = "${profile.replaceAll('\\','/')}"\ncdp_slot1_profile_directory = "Default"\ncdp_slot1_launcher = "${launcher.replaceAll('\\','/')}"\ncdp_slot1_account_alias = "account-a"\ncdp_slot1_workspace = "workspace-a"\ncdp_slot1_usage = "agent_authenticated_shared"\n`);
  const calls=[];
  const runner=(exe,args)=>{
    calls.push(args);
    const action=args[args.indexOf('-Action')+1];
    if(action==='Acquire') return {status:0,stdout:JSON.stringify({ok:true,lease:{lease_token:'transient-capability',target_id:'0123456789abcdef0123456789abcdef'}}),stderr:''};
    return {status:0,stdout:JSON.stringify({ok:true,target_id:'0123456789abcdef0123456789abcdef',target_closed:true}),stderr:''};
  };
  let first=offline;
  const inspectIdentity=async()=>{
    if(first){first=false;throw new Error('cdp_offline');}
    return {status:'signed_in',login_required:false,reason:'session_identity',user_id_sha256:digest('user'),email_sha256:digest('account-a@example.com'),email_local_part_sha256:digest('account-a'),account_id_sha256:null,workspace_id_sha256:null};
  };
  const verifyIdentity=(slot,identity)=>({verification_scope:'account_only',binding_verified:identity.status==='signed_in'&&identity.email_local_part_sha256===digest(slot.alias)});
  const leases=new ResourceLeaseManager({store:new DurableJobStore({root:path.join(root,'jobs')})});
  const adapter=new RegisteredCdpAuthAdapter({inventoryOptions:{stateRoot:root,coordinationPath},inspectIdentity,verifyIdentity,runner,resourceLeases:leases,leaseScript:'fixture.ps1'});
  return {root,adapter,calls,leases};
}

function spec(){return {sessionId:'chatgpt-cdp',providerId:'chatgpt-web-cdp',accountAlias:'account-a',profileId:'cdp-19222',credentialRef:'browser-profile://chatgpt/cdp-19222',ownerTaskId:'task-a',ownerActorId:'agent-a'};}

test('registered CDP auth adapter reuses a verified exact account/profile without exposing hashes or capabilities',async t=>{
  const f=fixture(t);
  const result=await new AuthBroker({adapter:f.adapter}).ensure(spec());
  assert.equal(result.state,'ready');
  assert.equal(result.mutated,false);
  assert.equal(JSON.stringify(result).includes('transient-capability'),false);
  assert.equal(f.calls.length,0);
});

test('offline registered profile is restored by bounded helper acquire/release then re-inspected',async t=>{
  const f=fixture(t,{offline:true});
  const result=await new AuthBroker({adapter:f.adapter}).ensure(spec());
  assert.equal(result.state,'ready');
  assert.equal(result.reason,'authorized-session-restored');
  assert.equal(result.mutated,true);
  assert.equal(f.calls.length,2);
  assert.ok(f.calls[0].includes('-MaxTargetsPerSlot'));
  assert.ok(f.calls[1].includes('-LeaseToken'));
  const browserLeases=f.leases.status().leases.filter(item=>item.resourceType==='browser-slot');
  assert.equal(browserLeases.length,1);
  assert.equal(browserLeases[0].state,'released');
});

test('unknown account/profile binding fails closed before browser launch',async t=>{
  const f=fixture(t,{offline:true});
  await assert.rejects(()=>new AuthBroker({adapter:f.adapter}).ensure({...spec(),profileId:'cdp-19999'}),e=>e.code==='auth_binding_not_registered');
  assert.equal(f.calls.length,0);
});