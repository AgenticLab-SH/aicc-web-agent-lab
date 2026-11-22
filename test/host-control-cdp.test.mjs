import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createHostController } from '../components/host-control/server.mjs';
import { openCdpBrowser } from '../components/host-control/cdp-browser.mjs';
import { browserIdentityHash } from '../src/browser/session-broker.mjs';
import { hostSourceDependencyPins } from '../components/host-control/prepare-update.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const owner = 'c'.repeat(64);
const targetId = 'A'.repeat(32);
const identity = {
 identityId: 'slot-a', role: 'registered-cdp', engine: 'chrome', appIdentity: 'Google Chrome',
 executable: 'C:\\managed\\chrome.exe', userDataRoot: 'C:\\managed\\profile-a',
 profile: 'Default', cdpEndpoint: 'http://127.0.0.1:9222', accountAlias: 'private-a',
 workspaceAlias: 'private-space', owner: 'registered-owner',
 ownershipPolicy: 'task-created-target-only',
 sessionIdentityHash: 'a'.repeat(64), workspaceIdentityHash: 'b'.repeat(64)
};
function fixture(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-host-cdp-fixture-'));
 t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 const mk = name => { const f = path.join(root, name); fs.writeFileSync(f, 'fixture-only'); return f; };
 const exe = mk('executor.exe'), helper = mk('lease.ps1'), guard = mk('identity.ps1');
 const conf = { schemaVersion: 1, scope: 'task-owned-v1', stateRoot: path.join(root, 'journals'),
  powershell: exe, aside: { command: exe, sha256: hash('fixture-only') },
  cua: { command: exe, sha256: hash('fixture-only') }, apps: {},
  cdp: { enabled: true, identities: [identity], leaseHelper: helper, leaseHelperSha256: hash('fixture-only'),
   identityGuard: guard, identityGuardSha256: hash('fixture-only'), powershellSha256: hash('fixture-only') },
  blockedUrlFragments: ['/blocked-owner-resource'] };
 fs.mkdirSync(conf.stateRoot);
 return { root, config: conf, exe, helper, guard };
}
function response(text, structuredContent = {}) {
 return { content: [{ type: 'text', text }], structuredContent };
}
function resultValue(value) { return value.structuredContent; }
test('CDP is selected without starting Aside; observed refs, screenshot, action and exact close work', async t => {
 const f = fixture(t);
 const actions = []; let asideCount = 0, cdpCount = 0, closed = 0;
 const cdpFactory = async (cfg, binding) => {
  cdpCount++;
  assert.equal(cfg.enabled, true);
  assert.equal(binding.identityId, 'slot-a');
  assert.equal(binding.url, 'https://example.com/');
  assert.match(binding.ownerTaskId, /^aicc-host-/);
  return {
   observe: async opts => response('[ref=r1] Send', { browser_backend: 'cdp', screenshot: opts.screenshot === true }),
   act: async (action, args) => { actions.push({ action, ref: args.ref }); return response('[ref=r1] Send', { browser_backend: 'cdp' }); },
   close: async () => { closed++; return { ok: true, closed: true }; },
   disconnect: async () => {}
  };
 };
 const host = await createHostController(f.config, { cdpFactory, connect: async () => { asideCount++; throw Error('ASIDE_MUST_REMAIN_DORMANT'); } });
 t.after(() => host.close());
 const a = { request_id: 'open-cdp-owner-1', client_key: owner, kind: 'browser', browser_identity: 'slot-a', url: 'https://example.com/' };
 const opened = resultValue(await host.call('aicc_host_open', a));
 assert.equal(opened.ok, true); assert.equal(cdpCount, 1); assert.equal(asideCount, 0);
 const obs = resultValue(await host.call('aicc_host_observe', { session_id: opened.session_id, lease: opened.lease, screenshot: true }));
 assert.equal(obs.state.screenshot, true);
 const acted = resultValue(await host.call('aicc_host_act', { session_id: opened.session_id, lease: opened.lease, observation_id: obs.observation_id,
  request_id: 'act-cdp-owner-1', action: 'fill', ref: 'r1', text: 'task-owned-only' }));
 assert.equal(acted.ok, true); assert.deepEqual(actions, [{ action: 'fill', ref: 'r1' }]);
 const other = resultValue(await host.call('aicc_host_act', { session_id: opened.session_id, lease: opened.lease, observation_id: obs.observation_id,
  request_id: 'act-cdp-stale', action: 'click', ref: 'r1' }));
 assert.equal(other.status, 'NOT_DISPATCHED');
 assert.equal(actions.length, 1);
 const ending = resultValue(await host.call('aicc_host_close', { session_id: opened.session_id, lease: opened.lease, request_id: 'close-cdp-owner-1' }));
 assert.equal(ending.status, 'CLOSED'); assert.equal(closed, 1);
 const journal = JSON.parse(fs.readFileSync(path.join(f.config.stateRoot, a.request_id + '.json')));
 assert.equal(journal.sessionState, 'CLOSED');
 assert.equal(journal.operation, 'open');
 assert.equal(asideCount, 0);
});

test('missing or foreign CDP identity refuses before attaching or selecting a different login', async t => {
 const f = fixture(t);
 let cdp = 0, aside = 0;
 const host = await createHostController(f.config, {
  cdpFactory: async () => { cdp++; throw Error('MUST_NOT_CONNECT'); },
  connect: async () => { aside++; throw Error('MUST_NOT_CONNECT'); }
 });
 t.after(() => host.close());
 for (const [index, options] of [{}, { browser_identity: 'foreign' }, { browser_backend: 'aside', browser_identity: 'slot-a' }].entries()) {
  const r = resultValue(await host.call('aicc_host_open', { request_id: 'bad-cdp-' + index,
   client_key: owner, kind: 'browser', url: 'https://example.com/', ...options }));
  assert.equal(r.status, 'NOT_DISPATCHED');
 }
 assert.equal(cdp, 0); assert.equal(aside, 0);
});

test('explicit Aside stays compatible and does not acquire CDP slot', async t => {
 const f = fixture(t);
 let aside = 0, cdp = 0;
 const host = await createHostController(f.config, {
  cdpFactory: async () => { cdp++; throw Error('CDP_NOT_REQUESTED'); },
  connect: async () => {
   aside++;
   return {
    callTool: async ({ name, arguments: args }) => {
     assert.equal(name, 'repl');
     const marker = args.code.match(/AICC_HOST_ACK_[a-f0-9]{16}/)?.[0];
     return response('[ref=b1] Button ' + marker, {});
    },
    close: async () => {}
   };
  }
 });
 t.after(() => host.close());
 const opened = resultValue(await host.call('aicc_host_open', { request_id: 'open-aside-owner',
  client_key: owner, kind: 'browser', browser_backend: 'aside', url: 'https://example.com/' }));
 assert.equal(opened.ok, true); assert.equal(aside, 1); assert.equal(cdp, 0);
 const result = resultValue(await host.call('aicc_host_close', { session_id: opened.session_id, lease: opened.lease, request_id: 'aside-owner-close' }));
 assert.equal(result.status, 'CLOSED');
});

test('uncertain CDP open preserves original request and cannot retry with a new identity', async t => {
 const f = fixture(t);
 let acquire = 0, aside = 0;
 const host = await createHostController(f.config, {
  cdpFactory: async () => { acquire++; throw Error('LEASE_ACQUIRED_TARGET_ID_UNKNOWN'); },
  connect: async () => { aside++; throw Error('NO_FALLBACK'); }
 });
 const req = { request_id: 'unknown-open-cdp', client_key: owner, kind: 'browser', browser_identity: 'slot-a', url: 'https://example.com/' };
 const first = resultValue(await host.call('aicc_host_open', req));
 assert.equal(first.status, 'HOLD');
 const second = resultValue(await host.call('aicc_host_open', req));
 assert.equal(second.status, 'OUTCOME_UNKNOWN');
 assert.equal(acquire, 1); assert.equal(aside, 0);
 await host.close();
 const again = await createHostController(f.config, { cdpFactory: async () => { acquire++; throw Error('REPLAY'); } });
 t.after(() => again.close());
 const state = resultValue(await again.call('aicc_host_sessions', { client_key: owner }));
 assert.equal(state.capacity.historyBlocksNewWork, true);
 assert.equal(state.capacity.unreturnedRecordedSessions, 1);
 assert.equal(acquire, 1);
});

async function directDriverScenario(t, workspaceProof, { disconnectFirst = false } = {}) {
 const f = fixture(t);
 const downloadRoot = path.join(f.root, 'downloads'); fs.mkdirSync(downloadRoot);
 const events = [];
 let url = 'https://chatgpt.com/', closed = false;
 const element = { tag: 'button', type: '', role: '', name: 'Send', label: 'Send', href: '' };
 const locator = {
  evaluateAll: async () => [{ index: 0, ...element }],
  nth: () => ({
   evaluate: async () => ({ index: 0, ...element }),
   isVisible: async () => true, click: async () => events.push('click'),
   fill: async text => events.push('fill:' + text),
   press: async key => events.push('press:' + key)
  })
 };
 const page = {
  url: () => url, isClosed: () => closed, setDefaultTimeout: () => {},
  context: () => context,
  locator: expression => expression === 'body'
   ? { ariaSnapshot: async () => '- button "Send"' }
   : locator,
  evaluate: async () => ({ accountName: 'private-a', identityHash: 'a'.repeat(64),
   ...(workspaceProof === undefined ? {} : { workspaceIdentityHash: workspaceProof }) }),
  screenshot: async () => Buffer.from('image-bytes'),
  goto: async value => { url = value; events.push('navigate'); },
  waitForEvent: async name => {
   assert.equal(name, 'download');
   return { suggestedFilename: () => 'report.txt', createReadStream: async () => Readable.from(['example']) };
  }
 };
 const foreign = { context: () => context };
 const context = {
  pages: () => [foreign, page],
  newCDPSession: async candidate => ({
   send: async () => ({ targetInfo: { targetId: candidate === page ? targetId : 'B'.repeat(32) } }),
   detach: async () => {}
  })
 };
 const browser = { contexts: () => [context], close: async () => { events.push('disconnect'); } };
 const provider = {
  acquire: async ({ identity: selected }) => {
   assert.equal(selected.accountAlias, 'private-a');
   events.push('acquire');
   return { capability: 'owned-capability', targetId,
    endpoint: identity.cdpEndpoint, ownership: 'task-created', identityHash: browserIdentityHash(selected) };
  },
  heartbeat: async ({ capability }) => { assert.equal(capability, 'owned-capability'); return { ok: true }; },
  release: async ({ targetId: exact }) => { assert.equal(exact, targetId); events.push('release'); closed = true; return { ok: true, targetClosed: true }; }
 };
 const driver = await openCdpBrowser({ ...f.config.cdp, powershell: f.exe, blockedUrlFragments: [], downloadRoot },
  { identityId: 'slot-a', url, ownerTaskId: 'fixture-owned-target' },
  { provider, chromium: { connectOverCDP: async endpoint => { assert.equal(endpoint, identity.cdpEndpoint); events.push('attach'); return browser; } },
   identityExpression: '(() => ({identityHash:"x"}))()' });
 if (workspaceProof !== identity.workspaceIdentityHash) {
  await assert.rejects(driver.observe(), /CDP_WORKSPACE_IDENTITY_MISMATCH/);
  await assert.rejects(driver.close(), /CDP_UNCERTAIN_RELEASE_REQUIRES_OWNER/);
  assert.equal(events.includes('release'), false);
  assert.equal(events.includes('click'), false);
  await driver.disconnect();
  return;
 }
 if (disconnectFirst) {
  await driver.disconnect();
  await assert.rejects(driver.close(), /CDP_TRANSPORT_DISCONNECTED_OWNER_RECONCILIATION_REQUIRED/);
  assert.equal(events.includes('release'), false);
  await assert.rejects(driver.observe(), /CDP_TRANSPORT_DISCONNECTED_OWNER_RECONCILIATION_REQUIRED/);
  assert.equal(events.includes('click'), false);
  await driver.disconnect();
  assert.equal(events.filter(e => e === 'disconnect').length, 1);
  return;
 }
 const observed = await driver.observe({ screenshot: true });
 assert.match(observed.content[1].text, /\[ref=r1\]/);
 assert.equal(observed.content[2].type, 'image');
 await driver.act('fill', { ref: 'r1', text: 'test' });
 const nowObserved = await driver.observe();
 assert.equal(nowObserved.structuredContent.page_ref_count, 1);
 await driver.act('download', { ref: 'r1' });
 const files = fs.readdirSync(downloadRoot);
 assert.equal(files.length, 1);
 assert.equal(fs.readFileSync(path.join(downloadRoot, files[0], 'report.txt'), 'utf8'), 'example');
 await driver.close();
 assert.ok(events.includes('release')); assert.ok(events.includes('disconnect'));
 assert.ok(!events.includes('foreign-tab'));
}
test('direct Playwright adapter matches exact target, reads DOM, acts, downloads and releases only owned target', t => directDriverScenario(t, identity.workspaceIdentityHash));
test('disconnected driver refuses local operations and keeps its original lease for owner reconciliation', t => directDriverScenario(t, identity.workspaceIdentityHash, { disconnectFirst: true }));
test('same account in another workspace is refused and original lease retained', t => directDriverScenario(t, 'd'.repeat(64)));
test('missing workspace proof is refused and original lease retained', t => directDriverScenario(t, undefined));
test('ChatGPT workspace binding must be explicit before acquiring a target', async t => {
 const f = fixture(t); let acquired = 0;
 for (const value of [undefined, '', 'invalid']) {
  const configured = { ...identity };
  if (value === undefined) delete configured.workspaceIdentityHash;
  else configured.workspaceIdentityHash = value;
  await assert.rejects(openCdpBrowser({ ...f.config.cdp, identities: [configured] },
   { identityId: identity.identityId, url: 'https://chatgpt.com/', ownerTaskId: 'fixture-workspace-binding' },
   { provider: { acquire: async () => { acquired++; } } }), /CDP_CHATGPT_IDENTITY_PROOF_REQUIRED/);
 }
 assert.equal(acquired, 0);
});
test('two exact registered account slots stay independent with no port-derived fallback', async t => {
 const f = fixture(t);
 const other = { ...identity, identityId: 'slot-b', cdpEndpoint: 'http://127.0.0.1:9223',
  accountAlias: 'private-b', userDataRoot: 'C:\\managed\\profile-b' };
 f.config.cdp.identities.push(other);
 const opened = [], closed = [];
 const host = await createHostController(f.config, {
  connect: async () => { throw Error('ASIDE_NOT_SELECTED'); },
  cdpFactory: async (cfg, binding) => {
   opened.push(binding.identityId);
   return { observe: async () => response('[ref=r1] link', { backend: 'cdp' }),
    act: async () => response('[ref=r1] link', {}),
    close: async () => { closed.push(binding.identityId); return { ok: true, closed: true }; },
    disconnect: async () => {} };
  }
 });
 t.after(() => host.close());
 const sessions = [];
 for(const [index, name] of ['slot-a','slot-b'].entries()){
  const result = resultValue(await host.call('aicc_host_open', { request_id: 'account-slot-open-' + index,
   client_key: owner, kind: 'browser', browser_identity: name, url: 'https://example.com/' }));
  assert.equal(result.ok, true); sessions.push(result);
 }
 assert.deepEqual(opened, ['slot-a','slot-b']);
 const one = sessions[0];
 const shut = resultValue(await host.call('aicc_host_close', { session_id: one.session_id, lease: one.lease, request_id: 'account-slot-close-a' }));
 assert.equal(shut.status, 'CLOSED');
 assert.deepEqual(closed, ['slot-a']);
 const two = sessions[1];
 const observed = resultValue(await host.call('aicc_host_observe', { session_id: two.session_id, lease: two.lease }));
 assert.equal(observed.ok, true);
 await host.call('aicc_host_close', { session_id: two.session_id, lease: two.lease, request_id: 'account-slot-close-b' });
 assert.deepEqual(closed, ['slot-a','slot-b']);
});

test('host update closure pins all CDP imports, and unchanged files retain the same graph digest', () => {
 const current = hostSourceDependencyPins();
 assert.equal(current.pins.length, 4);
 assert.ok(current.pins.some(pin => pin.relative === 'components/host-control/cdp-browser.mjs'));
 assert.ok(current.pins.some(pin => pin.relative === 'src/browser/cdp-lease-provider.mjs'));
 assert.match(current.sha256, /^[a-f0-9]{64}$/);
 assert.deepEqual(hostSourceDependencyPins(), current);
});

test('CDP observation uncertainty records durable UNKNOWN and refuses to close an unproven lease', async t => {
 const f = fixture(t);
 let observed = 0, release = 0;
 const host = await createHostController(f.config, {
  connect: async () => { throw Error('ASIDE_MUST_NOT_RUN'); },
  cdpFactory: async () => ({
   observe: async () => { observed++; if (observed > 1) throw Error('OBSERVATION_OWNER_UNKNOWN'); return response('[ref=r1] link', {}); },
   act: async () => response('[ref=r1] link', {}),
   close: async () => { release++; return { ok: true, closed: true }; },
   disconnect: async () => {}
  })
 });
 const a = { request_id: 'cdp-observation-uncertain', client_key: owner, kind: 'browser', browser_identity: 'slot-a', url: 'https://example.com/' };
 const open = resultValue(await host.call('aicc_host_open', a));
 assert.equal(open.ok, true);
 const bad = resultValue(await host.call('aicc_host_observe', { session_id: open.session_id, lease: open.lease }));
 assert.equal(bad.status, 'HOLD');
 const sessions = resultValue(await host.call('aicc_host_sessions', { client_key: owner }));
 assert.equal(sessions.sessions[0].state, 'UNKNOWN');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.config.stateRoot, a.request_id + '.json'))).sessionState, 'UNKNOWN');
 const close = resultValue(await host.call('aicc_host_close', { session_id: open.session_id, lease: open.lease, request_id: 'cdp-observe-close-refused' }));
 assert.equal(close.status, 'HOLD_UNCERTAIN');
 assert.equal(release, 0);
 await host.close();
 const again = await createHostController(f.config, { connect: async () => { throw Error('NO_REPLAY'); } });
 t.after(() => again.close());
 const recovery = resultValue(await again.call('aicc_host_sessions', { client_key: owner }));
 assert.equal(recovery.capacity.historyBlocksNewWork, true);
 assert.equal(recovery.capacity.unreturnedRecordedSessions, 1);
});

test('identity discovery selects an exact owner-registered CDP ID through capabilities, then acts and returns only its task target', async t => {
 const f = fixture(t);
 const other = { ...identity, identityId: 'slot-b', cdpEndpoint: 'http://127.0.0.1:9223',
  accountAlias: 'private-b', workspaceAlias: 'private-space-b', userDataRoot: 'C:\\managed\\profile-b' };
 f.config.cdp.identities.push(other);
 const selected = [], acted = [], closed = [];
 let aside = 0;
 const host = await createHostController(f.config, {
  connect: async () => { aside++; throw Error('ASIDE_MUST_NOT_BE_USED'); },
  cdpFactory: async (_, binding) => {
   selected.push(binding.identityId);
   return { identityId:binding.identityId, targetId:'A'.repeat(32),
    observe: async () => response('[ref=r1] Open', { browser_backend: 'cdp' }),
    act: async (name,args) => { acted.push([name,args.ref]); return response('[ref=r1] Done', {browser_backend:'cdp'}); },
    close: async () => { closed.push(binding.identityId); return {ok:true,closed:true}; },
    disconnect: async () => {} };
  }
 });
 t.after(() => host.close());
 const caps = resultValue(await host.call('aicc_host_capabilities',{}));
 assert.equal(caps.cdpIdentityRequired,true);
 assert.equal(caps.defaultBrowserBackend,'cdp');
 assert.deepEqual(caps.browserBackends,['cdp','aside']);
 assert.deepEqual(caps.cdpIdentityDiscovery,{
  status:'REGISTERED',identityIds:['slot-a','slot-b'],scope:'installed-host-registered-only',
  loginVerified:false,leaseAvailable:'UNPROVEN',selection:'EXPLICIT_NO_FALLBACK'
 });
 assert.deepEqual(Object.keys(caps.cdpIdentityDiscovery).sort(),
  ['identityIds','leaseAvailable','loginVerified','scope','selection','status'].sort());
 const raw=JSON.stringify(caps);
 for(const secret of ['private-a','private-b','private-space','9222','9223','C:\\managed',
  identity.owner,identity.sessionIdentityHash,identity.workspaceIdentityHash,'accountAlias','workspaceAlias','cdpEndpoint','userDataRoot','profile','ownerHash']){
  assert.equal(raw.includes(secret),false,'capabilities leaked private identity member');
 }
 const chosen=caps.cdpIdentityDiscovery.identityIds.find(value=>value==='slot-b');
 assert.equal(chosen,'slot-b');
 const req={request_id:'discover-exact-cdp-open-1',client_key:owner,kind:'browser',
  browser_backend:'cdp',browser_identity:chosen,url:'https://example.com/'};
 const opened=resultValue(await host.call('aicc_host_open',req));
 assert.equal(opened.ok,true);
 assert.deepEqual(selected,['slot-b']);
 assert.equal(aside,0);
 const obs=resultValue(await host.call('aicc_host_observe',{session_id:opened.session_id,lease:opened.lease}));
 assert.equal(obs.ok,true);
 const next=resultValue(await host.call('aicc_host_act',{session_id:opened.session_id,lease:opened.lease,
  request_id:'discover-exact-cdp-act-1',observation_id:obs.observation_id,action:'click',ref:'r1'}));
 assert.equal(next.ok,true);
 assert.deepEqual(acted,[['click','r1']]);
 const final=resultValue(await host.call('aicc_host_close',{session_id:opened.session_id,lease:opened.lease,
  request_id:'discover-exact-cdp-close-1'}));
 assert.equal(final.status,'CLOSED');
 assert.deepEqual(closed,['slot-b']);
 assert.equal(aside,0);
 const journal=JSON.parse(fs.readFileSync(path.join(f.config.stateRoot,req.request_id+'.json')));
 assert.equal(journal.sessionState,'CLOSED');
 assert.equal(journal.phase,'COMPLETED');
 assert.match(journal.capHash,/^[a-f0-9]{64}$/);
 assert.match(journal.resourceTargetHash,/^[a-f0-9]{64}$/);
});
test('identity discovery fails closed on missing, mixed-owner, malformed or unregistered CDP identities',async t=>{
 const problems=[
  ['not-configured',f=>{f.config.cdp.identities=[];},'NO_REGISTERED_CDP_IDENTITY'],
  ['mixed-owner',f=>{f.config.cdp.identities.push({...identity,identityId:'other-owner-slot',
    owner:'someone-else',cdpEndpoint:'http://127.0.0.1:9223',userDataRoot:'C:\\managed\\other-profile'});},'OWNER_SCOPE_UNVERIFIED'],
  ['duplicate',f=>{f.config.cdp.identities.push({...identity});},'REGISTRY_UNVERIFIED'],
  ['not-registered-role',f=>{f.config.cdp.identities[0]={...identity,role:'isolated-qa'};},'REGISTRY_UNVERIFIED'],
  ['missing-login-proof',f=>{f.config.cdp.identities[0]={...identity,sessionIdentityHash:null};},'REGISTRY_UNVERIFIED'],
  ['broken-profile-bind',f=>{f.config.cdp.identities[0]={...identity,workspaceAlias:''};},'REGISTRY_UNVERIFIED']
 ];
 for(const [label,setup,status] of problems)await t.test(label,async sub=>{
  const f=fixture(sub);setup(f);
  let opened=0;
  const host=await createHostController(f.config,{cdpFactory:async()=>{opened++;throw Error('NO_CDP_ACQUIRE');},
   connect:async()=>{throw Error('NO_ASIDE_FALLBACK');}});
  sub.after(()=>host.close());
  const caps=resultValue(await host.call('aicc_host_capabilities',{}));
  assert.equal(caps.cdpIdentityDiscovery.status,status);
  assert.deepEqual(caps.cdpIdentityDiscovery.identityIds,[]);
  const refusal=resultValue(await host.call('aicc_host_open',{request_id:'discover-refused-'+label,
   client_key:owner,kind:'browser',browser_identity:'slot-a',url:'https://example.com/'}));
  assert.equal(refusal.status,'NOT_DISPATCHED');
  assert.equal(refusal.reason,'EXACT_REGISTERED_CDP_IDENTITY_REQUIRED');
  assert.equal(opened,0);
 });
});
test('identity discovery does not guess identity, switch to Aside or conflate history HOLD with a missing registration',async t=>{
 const f=fixture(t);
 const old='historical-unreturned-open-001';
 const prior={schemaVersion:1,request_id:old,ownerHash:hash(owner),requestHash:hash('prior'),
  session_id:'original-session-00001',operation:'open',kind:'browser',sessionState:'OPEN',
  instanceId:'prior-instance-0001',phase:'OUTCOME_UNKNOWN',at:'2026-11-08T00:00:00Z'};
 const priorPath=path.join(f.config.stateRoot,old+'.json');
 fs.writeFileSync(priorPath,JSON.stringify(prior));
 const preimage=fs.readFileSync(priorPath,'utf8');
 let cdp=0,aside=0;
 const host=await createHostController(f.config,{
  cdpFactory:async()=>{cdp++;throw Error('CDP_DID_NOT_PASS_HISTORY_HOLD');},
  connect:async()=>{aside++;throw Error('ASIDE_DID_NOT_PASS_HISTORY_HOLD');}
 });
 t.after(()=>host.close());
 const caps=resultValue(await host.call('aicc_host_capabilities',{}));
 assert.deepEqual(caps.cdpIdentityDiscovery.identityIds,['slot-a']);
 const missing=resultValue(await host.call('aicc_host_open',{request_id:'discover-missing-before-hold',client_key:owner,
  kind:'browser',url:'https://example.com/'}));
 assert.equal(missing.status,'NOT_DISPATCHED');
 assert.equal(missing.reason,'EXACT_REGISTERED_CDP_IDENTITY_REQUIRED');
 const historical=resultValue(await host.call('aicc_host_open',{request_id:'discover-exact-while-history-hold',client_key:owner,
  kind:'browser',browser_identity:caps.cdpIdentityDiscovery.identityIds[0],url:'https://example.com/'}));
 assert.equal(historical.status,'NOT_DISPATCHED');
 assert.equal(historical.reason,'HOST_HISTORY_UNPROVEN');
 const asideWrong=resultValue(await host.call('aicc_host_open',{request_id:'discover-aside-with-identity',client_key:owner,
  kind:'browser',browser_backend:'aside',browser_identity:'slot-a',url:'https://example.com/'}));
 assert.equal(asideWrong.status,'NOT_DISPATCHED');
 assert.equal(asideWrong.reason,'ASIDE_IS_NOT_REGISTERED_CDP_IDENTITY');
 const asideHeld=resultValue(await host.call('aicc_host_open',{request_id:'discover-aside-history-hold',client_key:owner,
  kind:'browser',browser_backend:'aside',url:'https://example.com/'}));
 assert.equal(asideHeld.reason,'HOST_HISTORY_UNPROVEN');
 assert.equal(cdp,0);assert.equal(aside,0);
 assert.equal(fs.readFileSync(priorPath,'utf8'),preimage);
});
test('identity discovery disabled CDP lists no identities and keeps explicit Aside available without CDP access',async t=>{
 const f=fixture(t);f.config.cdp={enabled:false,identities:[]};
 let aside=0,cdp=0;
 const host=await createHostController(f.config,{
  cdpFactory:async()=>{cdp++;throw Error('CDP_MUST_NOT_RUN');},
  connect:async()=>{aside++;return {callTool:async ({name,arguments:args})=>{
   assert.equal(name,'repl');
   const marker=args.code.match(/AICC_HOST_ACK_[a-f0-9]{16}/)?.[0];
   return response('[ref=b1] Button '+marker,{});},close:async()=>{}};}
 });
 t.after(()=>host.close());
 const caps=resultValue(await host.call('aicc_host_capabilities',{}));
 assert.equal(caps.defaultBrowserBackend,'aside');
 assert.deepEqual(caps.cdpIdentityDiscovery.identityIds,[]);
 assert.equal(caps.cdpIdentityDiscovery.status,'CDP_DISABLED');
 const req={request_id:'discover-aside-only-open',client_key:owner,kind:'browser',
  browser_backend:'aside',url:'https://example.com/'};
 const opened=resultValue(await host.call('aicc_host_open',req));
 assert.equal(opened.ok,true);
 const released=resultValue(await host.call('aicc_host_close',{session_id:opened.session_id,lease:opened.lease,
  request_id:'discover-aside-only-close'}));
 assert.equal(released.status,'CLOSED');
 assert.equal(aside,1);assert.equal(cdp,0);
});

test('Aside lifecycle starts only on an explicit owned request; normal tab and transport closure precede CLOSED', async t => {
 const f=fixture(t),events=[];
 let connected=0,cdp=0,now=1_800_000_000_000;
 const openId='aside-lifecycle-lazy-open-001';
 const host=await createHostController(f.config,{
  now:()=>now,
  cdpFactory:async()=>{cdp++;throw Error('CDP_NOT_SELECTED');},
  connect:async kind=>{
   assert.equal(kind,'browser');connected++;events.push('aside-connect');
   return {
    callTool:async ({name,arguments:args})=>{
     assert.equal(name,'repl');
     const marker=args.code.match(/AICC_HOST_ACK_[a-f0-9]{16}/)?.[0];
     if(args.code.includes('closeTab(page)')){
      assert.match(args.code,/if\(!page\).*ASIDE_OWNED_PAGE_UNPROVEN/);
      events.push('owned-tab-close-ack');
     }else events.push('aside-repl-observe');
     return response('[ref=b1] Owned '+marker,{});
    },
    close:async ()=>{
     const openRecord=JSON.parse(fs.readFileSync(path.join(f.config.stateRoot,openId+'.json')));
     assert.equal(openRecord.sessionState,'OPEN','CLOSED before executor normal return');
     events.push('executor-transport-close-ack');
    }
   };
  }
 });
 t.after(()=>host.close());
 const caps=resultValue(await host.call('aicc_host_capabilities',{}));
 assert.equal(caps.defaultBrowserBackend,'cdp');
 const idleBefore=resultValue(await host.call('aicc_host_sessions',{client_key:owner}));
 assert.equal(idleBefore.capacity.knownSessions,0);
 assert.equal(connected,0,'Aside should not be started by capabilities or inventory');
 assert.equal(cdp,0);
 const args={request_id:openId,client_key:owner,kind:'browser',browser_backend:'aside',url:'https://example.com/'};
 const opened=resultValue(await host.call('aicc_host_open',args));
 assert.equal(opened.ok,true);assert.equal(connected,1);assert.equal(cdp,0);
 assert.equal(events[0],'aside-connect');
 const before=resultValue(await host.call('aicc_host_sessions',{client_key:owner}));
 assert.equal(before.capacity.knownSessions,1);
 assert.equal(before.sessions[0].automatic_return_allowed,false);
 now+=600001;
 const after=resultValue(await host.call('aicc_host_sessions',{client_key:owner}));
 assert.equal(after.sessions[0].automatic_return_allowed,true);
 assert.equal(after.sessions[0].return_reason,'IDLE_EXPIRED_NORMAL_CLOSE_ONLY');
 assert.equal(connected,1,'read-only idle inventory must not start another executor');
 const closed=resultValue(await host.call('aicc_host_close',{
  session_id:opened.session_id,lease:opened.lease,request_id:'aside-lifecycle-close-001'}));
 assert.equal(closed.status,'CLOSED');
 const returned=JSON.parse(fs.readFileSync(path.join(f.config.stateRoot,openId+'.json')));
 assert.equal(returned.sessionState,'CLOSED');
 assert.equal(resultValue(await host.call('aicc_host_sessions',{client_key:owner})).capacity.knownSessions,0);
 assert.deepEqual(events.slice(-2),['owned-tab-close-ack','executor-transport-close-ack']);
 assert.equal(cdp,0);
});

test('Aside lifecycle transport close failure must not certify returned resources or retry on Host shutdown',async t=>{
 const f=fixture(t),openId='aside-lifecycle-transport-unknown-001';
 let transportCloseAttempts=0,tabCloseAttempts=0,connects=0;
 const host=await createHostController(f.config,{cdpFactory:async()=>{throw Error('CDP_NOT_SELECTED');},
  connect:async()=>{connects++;return{
   callTool:async ({name,arguments:args})=>{
    assert.equal(name,'repl');if(args.code.includes('closeTab(page)'))tabCloseAttempts++;
    return response('ACK '+args.code.match(/AICC_HOST_ACK_[a-f0-9]{16}/)?.[0],{});
   },
   close:async()=>{transportCloseAttempts++;throw Error('ASIDE_TRANSPORT_CLOSE_UNACKNOWLEDGED');}
  };}
 });
 const opened=resultValue(await host.call('aicc_host_open',{request_id:openId,client_key:owner,
  kind:'browser',browser_backend:'aside',url:'https://example.com/'}));
 assert.equal(opened.ok,true);
 const attempted=resultValue(await host.call('aicc_host_close',{session_id:opened.session_id,lease:opened.lease,
  request_id:'aside-lifecycle-transport-close-001'}));
 assert.equal(attempted.status,'HOLD');
 assert.match(attempted.reason,/ASIDE_TRANSPORT_CLOSE_UNACKNOWLEDGED/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.config.stateRoot,openId+'.json'))).sessionState,'UNKNOWN');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.config.stateRoot,'aside-lifecycle-transport-close-001.json'))).phase,'OUTCOME_UNKNOWN');
 const ownerState=resultValue(await host.call('aicc_host_sessions',{client_key:owner}));
 assert.equal(ownerState.sessions[0].state,'UNKNOWN');
 assert.equal(ownerState.capacity.knownSessions,1);
 assert.equal(ownerState.sessions[0].automatic_return_allowed,false);
 await host.close();
 assert.equal(connects,1);assert.equal(tabCloseAttempts,1);
 assert.equal(transportCloseAttempts,1,'shutdown must not re-close an ambiguous transport');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.config.stateRoot,openId+'.json'))).sessionState,'UNKNOWN');
});

test('Aside lifecycle missing owned page never returns CLOSED and shutdown does not retry its close',async t=>{
 const f=fixture(t),openId='aside-lifecycle-page-unproven-001';
 let closeRequests=0,transportCloses=0;
 const host=await createHostController(f.config,{
  connect:async()=>({
   callTool:async ({name,arguments:args})=>{
    assert.equal(name,'repl');
    if(args.code.includes('closeTab(page)')){
     assert.match(args.code,/if\(!page\).*ASIDE_OWNED_PAGE_UNPROVEN/);
     closeRequests++;throw Error('ASIDE_OWNED_PAGE_UNPROVEN');
    }
    return response('[ref=b1] Owned '+args.code.match(/AICC_HOST_ACK_[a-f0-9]{16}/)?.[0],{});
   },
   close:async()=>{transportCloses++;}
  })
 });
 const opened=resultValue(await host.call('aicc_host_open',{request_id:openId,client_key:owner,
  kind:'browser',browser_backend:'aside',url:'https://example.com/'}));
 assert.equal(opened.ok,true);
 const attempt=resultValue(await host.call('aicc_host_close',{session_id:opened.session_id,lease:opened.lease,
  request_id:'aside-lifecycle-page-close-001'}));
 assert.equal(attempt.status,'HOLD');
 assert.match(attempt.reason,/ASIDE_OWNED_PAGE_UNPROVEN/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.config.stateRoot,openId+'.json'))).sessionState,'UNKNOWN');
 await host.close();
 assert.equal(closeRequests,1);
 assert.equal(transportCloses,0,'do not terminate a target-unproven Aside executor');
});
test('Aside lifecycle CLOSE_PENDING and CDP uncertain release stay untouched by controller shutdown',async t=>{
 const f=fixture(t),openId='aside-lifecycle-cdp-pending-001';
 let closeAttempts=0,disconnects=0,aside=0;
 const host=await createHostController(f.config,{
  connect:async()=>{aside++;throw Error('ASIDE_NOT_SELECTED');},
  cdpFactory:async()=>({
   identityId:'slot-a',targetId:'A'.repeat(32),
   observe:async()=>response('[ref=r1] Owned',{browser_backend:'cdp'}),
   act:async()=>response('[ref=r1] Owned',{}),
   close:async()=>{closeAttempts++;return {ok:false,closed:false};},
   disconnect:async()=>{disconnects++;}
  })
 });
 const opened=resultValue(await host.call('aicc_host_open',{request_id:openId,client_key:owner,
  kind:'browser',browser_identity:'slot-a',url:'https://example.com/'}));
 assert.equal(opened.ok,true);
 const pending=resultValue(await host.call('aicc_host_close',{session_id:opened.session_id,lease:opened.lease,
  request_id:'aside-lifecycle-cdp-close-001'}));
 assert.equal(pending.status,'CLOSE_PENDING');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.config.stateRoot,openId+'.json'))).sessionState,'CLOSE_PENDING');
 await host.close();
 assert.equal(closeAttempts,1,'shutdown must not replay a pending target release');
 assert.equal(disconnects,0,'pending target ownership requires owner reconciliation');
 assert.equal(aside,0);
});

test('Aside lifecycle Host shutdown preserves still-active owned tab and keeps its original return HOLD on restart',async t=>{
 const f=fixture(t),openId='aside-lifecycle-live-shutdown-001';
 let now=1_800_000_000_000,tabCloses=0,transportCloses=0,connects=0;
 const host=await createHostController(f.config,{now:()=>now,connect:async()=>{connects++;return{
  callTool:async({arguments:args})=>{
   if(args.code.includes('closeTab(page)'))tabCloses++;
   return response('ACK '+args.code.match(/AICC_HOST_ACK_[a-f0-9]{16}/)?.[0],{});
  },close:async()=>{transportCloses++;}
 };}});
 const opened=resultValue(await host.call('aicc_host_open',{request_id:openId,client_key:owner,
  kind:'browser',browser_backend:'aside',url:'https://example.com/'}));
 assert.equal(opened.ok,true);
 const state=resultValue(await host.call('aicc_host_sessions',{client_key:owner}));
 assert.equal(state.sessions[0].automatic_return_allowed,false);
 await host.close();
 assert.equal(tabCloses,0,'Host shutdown must not close a recently active owned tab');
 assert.equal(transportCloses,0,'Host shutdown must not terminate its owner transport');
 assert.equal(connects,1);
 const original=JSON.parse(fs.readFileSync(path.join(f.config.stateRoot,openId+'.json')));
 assert.equal(original.sessionState,'OPEN','missing return proof must remain explicit');
 const restart=await createHostController(f.config,{connect:async()=>{throw Error('RESTART_SHOULD_NOT_SPAWN_ASIDE');}});
 t.after(()=>restart.close());
 const fresh=resultValue(await restart.call('aicc_host_sessions',{client_key:owner}));
 assert.equal(fresh.capacity.historyBlocksNewWork,true);
 assert.equal(fresh.capacity.unreturnedRecordedSessions,1);
 assert.equal(fresh.capacity.availableSessions,null);
 const refused=resultValue(await restart.call('aicc_host_open',{request_id:'aside-lifecycle-shutdown-new-open',client_key:owner,
  kind:'browser',browser_backend:'aside',url:'https://example.com/'}));
 assert.equal(refused.status,'NOT_DISPATCHED');
 assert.equal(refused.reason,'HOST_HISTORY_UNPROVEN');
 assert.equal(tabCloses,0);assert.equal(transportCloses,0);
});

test('Aside lifecycle Host shutdown may normal-close only an already-idle exact owned session',async t=>{
 const f=fixture(t),openId='aside-lifecycle-idle-shutdown-001';
 let now=1_800_000_000_000,tabCloses=0,transportCloses=0;
 const host=await createHostController(f.config,{now:()=>now,connect:async()=>({
  callTool:async({arguments:args})=>{
   if(args.code.includes('closeTab(page)')){tabCloses++;assert.match(args.code,/ASIDE_OWNED_PAGE_UNPROVEN/);}
   return response('ACK '+args.code.match(/AICC_HOST_ACK_[a-f0-9]{16}/)?.[0],{});
  },close:async()=>{transportCloses++;}
 })});
 const opened=resultValue(await host.call('aicc_host_open',{request_id:openId,client_key:owner,
  kind:'browser',browser_backend:'aside',url:'https://example.com/'}));
 assert.equal(opened.ok,true);
 now+=600001;
 await host.close();
 assert.equal(tabCloses,1);
 assert.equal(transportCloses,1);
 const openRecord=JSON.parse(fs.readFileSync(path.join(f.config.stateRoot,openId+'.json')));
 assert.equal(openRecord.sessionState,'CLOSED');
 const restart=await createHostController(f.config,{now:()=>now,connect:async()=>{throw Error('NO_IDLE_REPLAY');}});
 t.after(()=>restart.close());
 const cap=resultValue(await restart.call('aicc_host_sessions',{client_key:owner})).capacity;
 assert.equal(cap.historyBlocksNewWork,false);
 assert.equal(cap.unreturnedRecordedSessions,0);
});
