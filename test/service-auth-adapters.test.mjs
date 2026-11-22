import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuthBroker } from '../src/control-plane/auth-broker.mjs';
import { buildOcxHubBinding, OcxExactAccountAuthAdapter, OcxHubConnectionAuthAdapter, WebBridgeAuthAdapter } from '../src/control-plane/service-auth-adapters.mjs';

function webFixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-web-auth-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const configPath=path.join(root,'config.json');
  fs.writeFileSync(configPath,JSON.stringify({browserIdentityHashVersion:2,browserIdentityHash:'a'.repeat(64),browserAccountAlias:'account-a',browserAccountIndex:1,browserHost:'registered-cdp'}));
  const fetch=async url=>({ok:true,status:200,json:async()=>String(url).endsWith('/healthz')?{status:'ok',browser_identity_hash:'a'.repeat(64),accepting_browser_turns:true}:{ready:true}});
  return {configPath,fetch};
}

test('Web Bridge adapter proves configured v2 runtime identity without returning the hash',async t=>{
  const f=webFixture(t);
  const adapter=new WebBridgeAuthAdapter({configPath:f.configPath,fetch:f.fetch});
  const result=await new AuthBroker({adapter}).ensure({sessionId:'web-bridge',providerId:'web-bridge',accountAlias:'account-a',profileId:'web-bridge-1',credentialRef:'external-session://web-bridge/profile-1'});
  assert.equal(result.state,'ready');
  assert.equal(result.mutated,false);
  assert.equal(JSON.stringify(result).includes('a'.repeat(64)),false);
});

test('Web Bridge adapter fails closed on runtime identity drift',async t=>{
  const f=webFixture(t);
  const fetch=async url=>({ok:true,status:200,json:async()=>String(url).endsWith('/healthz')?{status:'ok',browser_identity_hash:'b'.repeat(64),accepting_browser_turns:true}:{ready:true}});
  const adapter=new WebBridgeAuthAdapter({configPath:f.configPath,fetch});
  await assert.rejects(()=>adapter.inspect({accountAlias:'account-a',profileId:'web-bridge-1'}),e=>e.code==='web_bridge_identity_mismatch');
});

test('OCX adapter accepts only the exact active account and never switches accounts',async()=>{
  let calls=0;
  const accountStatus=async()=>{calls+=1;return{state:'ready',activeId:'acct-a',accounts:[{id:'acct-a',active:true,paused:false,needsReauth:false},{id:'acct-b',active:false,paused:false,needsReauth:false}]};};
  const adapter=new OcxExactAccountAuthAdapter({accountStatus});
  const ready=await new AuthBroker({adapter}).ensure({sessionId:'ocx-a',providerId:'ocx',accountAlias:'acct-a',profileId:'ocx-openai-acct-a',credentialRef:'external-session://ocx/acct-a'});
  assert.equal(ready.state,'ready'); assert.equal(calls,1);
  await assert.rejects(()=>adapter.inspect({accountAlias:'acct-b',profileId:'ocx-openai-acct-b'}),e=>e.code==='account_identity_mismatch');
  assert.equal(calls,2);
});

test('OCX needsReauth becomes bounded reauth-required and no mutation is attempted',async()=>{
  const adapter=new OcxExactAccountAuthAdapter({accountStatus:async()=>({state:'degraded-but-readable',activeId:'acct-a',accounts:[{id:'acct-a',active:true,paused:false,needsReauth:true}]})});
  const result=await new AuthBroker({adapter}).ensure({sessionId:'ocx-a',providerId:'ocx',accountAlias:'acct-a',profileId:'ocx-openai-acct-a',credentialRef:'external-session://ocx/acct-a'});
  assert.equal(result.state,'reauth-required'); assert.equal(result.mutated,false);
});

test('OCX unavailable account management surface fails closed instead of inferring identity from port health',async()=>{
  const adapter=new OcxExactAccountAuthAdapter({
    accountStatus:async()=>({state:'unavailable',accounts:[]}),
    identityObserver:async()=>null
  });
  await assert.rejects(()=>adapter.inspect({accountAlias:'acct-a',profileId:'ocx-openai-acct-a'}),e=>e.code==='ocx_account_surface_unavailable');
});

test('OCX exact account falls back to the A1 hashed identity observer without exposing or switching raw accounts',async()=>{
  const requestedId='acct-a';
  const identityHash=createHash('sha256').update(requestedId).digest('hex');
  const adapter=new OcxExactAccountAuthAdapter({
    accountStatus:async()=>({state:'unavailable',accounts:[]}),
    identityObserver:async()=>({
      schemaVersion:1,
      source:'a1-ocx-hub',
      observedAt:Date.now()/1000,
      accounts:[
        {identityHash,selector:'p1',active:true,plan:'team',blockReason:null},
        {identityHash:'b'.repeat(64),selector:'p2',active:false,plan:'plus',blockReason:'paused'}
      ]
    })
  });
  const result=await new AuthBroker({adapter}).ensure({
    sessionId:'ocx-a1',
    providerId:'ocx',
    accountAlias:requestedId,
    profileId:'ocx-openai-acct-a',
    credentialRef:'external-session://ocx/acct-a'
  });
  assert.equal(result.state,'ready');
  assert.equal(result.mutated,false);
  assert.equal(result.stateRef,undefined);
  assert.equal(JSON.stringify(result).includes(identityHash),false);
});

test('OCX A1 hashed observer fails closed when the requested account is not the sole active identity',async()=>{
  const requestedId='acct-a';
  const identityHash=createHash('sha256').update(requestedId).digest('hex');
  const adapter=new OcxExactAccountAuthAdapter({
    accountStatus:async()=>({state:'unavailable',accounts:[]}),
    identityObserver:async()=>({
      schemaVersion:1,
      source:'a1-ocx-hub',
      observedAt:Date.now()/1000,
      accounts:[
        {identityHash,selector:'p1',active:true,plan:'team',blockReason:null},
        {identityHash:'c'.repeat(64),selector:'p2',active:true,plan:'team',blockReason:null}
      ]
    })
  });
  await assert.rejects(
    ()=>adapter.inspect({accountAlias:requestedId,profileId:'ocx-openai-acct-a'}),
    error=>error.code==='account_identity_mismatch'
  );
});

test('OCX A1 hashed observer maps needs_reauth to bounded reauth-required without mutation',async()=>{
  const requestedId='acct-a';
  const identityHash=createHash('sha256').update(requestedId).digest('hex');
  const adapter=new OcxExactAccountAuthAdapter({
    accountStatus:async()=>({state:'unavailable',accounts:[]}),
    identityObserver:async()=>({
      schemaVersion:1,
      source:'a1-ocx-hub',
      observedAt:Date.now()/1000,
      accounts:[{identityHash,selector:'p1',active:true,plan:'team',blockReason:'needs_reauth'}]
    })
  });
  const result=await new AuthBroker({adapter}).ensure({
    sessionId:'ocx-a1',
    providerId:'ocx',
    accountAlias:requestedId,
    profileId:'ocx-openai-acct-a',
    credentialRef:'external-session://ocx/acct-a'
  });
  assert.equal(result.state,'reauth-required');
  assert.equal(result.mutated,false);
});

function hubFixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-ocx-hub-auth-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const configPath=path.join(root,'config.json');
  const bindingPath=path.join(root,'ocx-hub.json');
  const config={
    runtimeRole:'client',
    client:{
      serverUrl:'http://localhost:10101',
      managementUrl:'http://localhost:10102',
      apiKeyId:'0389c1cc-aabc-4453-a226-0a6fbdd87089',
      protocolVersion:1,
      selectedClients:['codex'],
      managementTransport:'direct'
    }
  };
  fs.writeFileSync(configPath,JSON.stringify(config));
  fs.writeFileSync(bindingPath,JSON.stringify(buildOcxHubBinding(config)));
  const status={
    runtimeRole:'client',
    proxy:{health:{ok:true}},
    remoteHub:{connected:true},
    connection:{
      state:'connected',
      readiness:'ready',
      serverUrl:'http://localhost:10101',
      managementUrl:'http://localhost:10102',
      apiKeyId:'0389c1cc-aabc-4453-a226-0a6fbdd87089',
      protocolVersion:1
    }
  };
  return {root,configPath,bindingPath,config,status};
}

test('OCX hub client adapter binds the exact A1 connection without reading or switching upstream accounts',async t=>{
  const f=hubFixture(t);
  const adapter=new OcxHubConnectionAuthAdapter({configPath:f.configPath,bindingPath:f.bindingPath,statusProvider:async()=>f.status});
  const result=await new AuthBroker({adapter}).ensure({sessionId:'ocx-hub',providerId:'ocx',accountAlias:'a1-hub',profileId:'ocx-hub-a1',credentialRef:'external-session://ocx/a1-hub'});
  assert.equal(result.state,'ready');
  assert.equal(result.mutated,false);
  assert.equal(JSON.stringify(result).includes('0389c1cc-aabc-4453-a226-0a6fbdd87089'),false);
});

test('OCX hub client adapter fails closed on config or runtime connection drift',async t=>{
  const f=hubFixture(t);
  const drifted={...f.config,client:{...f.config.client,apiKeyId:'1389c1cc-aabc-4453-a226-0a6fbdd87089'}};
  fs.writeFileSync(f.configPath,JSON.stringify(drifted));
  const adapter=new OcxHubConnectionAuthAdapter({configPath:f.configPath,bindingPath:f.bindingPath,statusProvider:async()=>f.status});
  await assert.rejects(()=>adapter.inspect({accountAlias:'a1-hub',profileId:'ocx-hub-a1'}),e=>e.code==='ocx_hub_identity_mismatch');

  fs.writeFileSync(f.configPath,JSON.stringify(f.config));
  const liveDrift={...f.status,connection:{...f.status.connection,managementUrl:'http://localhost:10103'}};
  const adapter2=new OcxHubConnectionAuthAdapter({configPath:f.configPath,bindingPath:f.bindingPath,statusProvider:async()=>liveDrift});
  await assert.rejects(()=>adapter2.inspect({accountAlias:'a1-hub',profileId:'ocx-hub-a1'}),e=>e.code==='ocx_hub_runtime_identity_mismatch');
});

test('OCX hub client adapter requires connected remote hub readiness',async t=>{
  const f=hubFixture(t);
  const offline={...f.status,remoteHub:{connected:false}};
  const adapter=new OcxHubConnectionAuthAdapter({configPath:f.configPath,bindingPath:f.bindingPath,statusProvider:async()=>offline});
  await assert.rejects(()=>adapter.inspect({accountAlias:'a1-hub',profileId:'ocx-hub-a1'}),e=>e.code==='ocx_hub_unavailable');
});
