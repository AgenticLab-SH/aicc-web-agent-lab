import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { JobManager } from '../src/jobs/job-manager.mjs';
import { ResourceLeaseManager } from '../src/control-plane/resource-lease.mjs';
import { BrowserSessionBroker, browserIdentityHash, createBrowserIdentityRegistry } from '../src/browser/session-broker.mjs';
import { CdpLeaseProvider } from '../src/browser/cdp-lease-provider.mjs';

const REQUEST_HASH = crypto.createHash('sha256').update('browser-request').digest('hex');

function fixture(t, { mode = 'read-only', accessMode = 'observe', providerOverrides = {}, commonResourceLease = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-browser-broker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { value: 1_700_000_000_000 };
  const store = new DurableJobStore({ root: path.join(root, 'store'), now: () => clock.value });
  const jobs = new JobManager({ store, now: () => clock.value });
  const job = jobs.submit({
    jobId: `browser-${mode}`, idempotencyKey: `browser-${mode}`, workloadClass: 'browser', workspaceId: '/workspace/browser',
    requestedRoute: 'native-direct', identityBinding: 'browser:fixture', mode,
    requestRef: 'request://browser', requestHash: REQUEST_HASH
  }).job;
  const worker = { workerId: 'browser-worker', workloadClasses: ['browser'], modes: [mode], routeIds: ['native-direct'] };
  const dispatched = jobs.dispatch(job.jobId, worker);
  jobs.start(job.jobId, dispatched.attempt.attemptId);
  const identity = {
    identityId: 'registered-fixture', role: 'registered-cdp', engine: 'chromium', appIdentity: 'com.fixture.chrome',
    executable: '/Applications/Fixture Chrome.app', userDataRoot: '/private/fixture/browser', profile: 'Default',
    cdpEndpoint: 'http://127.0.0.1:19222', accountAlias: 'fixture-account', workspaceAlias: 'fixture-workspace',
    owner: 'aicc-cdp-helper', ownershipPolicy: 'task-created-target-only'
  };
  const registry = createBrowserIdentityRegistry([identity]);
  const calls = [];
  const provider = {
    acquire: async input => {
      calls.push({ operation: 'acquire', input });
      return { capability: 'provider-secret-capability', targetId: 'target-owned', ownership: 'task-created', identityHash: browserIdentityHash(registry.get(identity.identityId)), ...providerOverrides.acquire };
    },
    heartbeat: async input => { calls.push({ operation: 'heartbeat', input }); return { ok: true, ...providerOverrides.heartbeat }; },
    release: async input => { calls.push({ operation: 'release', input }); return { ok: true, targetClosed: true, ...providerOverrides.release }; }
  };
  const resourceLeases = commonResourceLease ? new ResourceLeaseManager({ store, now: () => clock.value, defaultTtlMs: 1_000, maximumTtlMs: 60_000 }) : null;
  const broker = new BrowserSessionBroker({ store, registry, provider, resourceLeases, now: () => clock.value, ttlMs: 100, maxActive: 5 });
  const spec = {
    jobId: job.jobId, attemptId: dispatched.attempt.attemptId, identityId: identity.identityId,
    url: 'https://example.com/qa', purpose: 'fixture QA', accessMode,
    capabilities: accessMode === 'observe' ? ['navigate', 'inspect', 'screenshot'] : ['navigate', 'click', 'type'],
    permittedOrigins: ['https://example.com']
  };
  return { root, clock, store, jobs, job, attemptId: dispatched.attempt.attemptId, registry, provider, calls, resourceLeases, broker, spec };
}

test('broker persists the exact task-owned target but never the raw provider capability', async t => {
  const { store, calls, broker, spec } = fixture(t);
  const lease = await broker.acquire(spec);
  assert.equal(lease.targetId, 'target-owned');
  assert.equal(lease.rawTabContentStored, false);
  assert.equal(Object.hasOwn(store.read().state.browserLeases[lease.leaseId], 'capability'), false);
  assert.equal(JSON.stringify(store.read().state).includes('provider-secret-capability'), false);
  assert.equal(broker.authorize(lease.leaseId, { targetId: lease.targetId, url: 'https://example.com/next', capability: 'inspect' }).ok, true);
  assert.throws(() => broker.authorize(lease.leaseId, { targetId: 'foreign', url: 'https://example.com', capability: 'inspect' }), error => error.code === 'target_mismatch');
  assert.throws(() => broker.authorize(lease.leaseId, { targetId: lease.targetId, url: 'https://other.example', capability: 'inspect' }), error => error.code === 'origin_not_allowed');
  const released = await broker.release(lease.leaseId);
  assert.equal(released.state, 'released');
  assert.equal(calls.filter(call => call.operation === 'release')[0].input.targetId, 'target-owned');
});

test('wrong identity or non-task ownership is rejected and the exact acquired capability is cleaned up', async t => {
  const mismatch = fixture(t, { providerOverrides: { acquire: { identityHash: '0'.repeat(64) } } });
  await assert.rejects(() => mismatch.broker.acquire(mismatch.spec), error => error.code === 'identity_mismatch');
  assert.equal(mismatch.calls.filter(call => call.operation === 'release').length, 1);
  assert.equal(Object.keys(mismatch.store.read().state.browserLeases).length, 0);

  const foreign = fixture(t, { providerOverrides: { acquire: { ownership: 'existing-user-target' } } });
  await assert.rejects(() => foreign.broker.acquire(foreign.spec), error => error.code === 'user_target_prohibited');
  assert.equal(foreign.calls.filter(call => call.operation === 'release').length, 1);
});

test('observe mode cannot gain click or download and interact mode requires a durable writer', async t => {
  const observed = fixture(t);
  await assert.rejects(() => observed.broker.acquire({ ...observed.spec, capabilities: ['click'] }), error => error.code === 'capability_denied');
  await assert.rejects(() => observed.broker.acquire({ ...observed.spec, accessMode: 'interact', capabilities: ['click'] }), error => error.code === 'writer_required');
  const writer = fixture(t, { mode: 'write', accessMode: 'interact' });
  const lease = await writer.broker.acquire(writer.spec);
  assert.equal(writer.broker.authorize(lease.leaseId, { targetId: lease.targetId, url: 'https://example.com', capability: 'click' }).ok, true);
});

test('broker restart never takes over foreign targets and defers cleanup without the provider capability', async t => {
  const { store, registry, provider, broker, spec } = fixture(t);
  const lease = await broker.acquire(spec);
  const restarted = new BrowserSessionBroker({ store, registry, provider, maxActive: 5 });
  const reconciled = restarted.reconcile([
    { targetId: lease.targetId, ownerTaskId: 'wrong-owner', identityHash: lease.identityHash },
    { targetId: 'foreign-user-target', ownerTaskId: 'user', identityHash: 'f'.repeat(64) }
  ]);
  assert.deepEqual(reconciled.quarantined, [lease.leaseId]);
  assert.equal(reconciled.foreignTargetsUntouched, 1);
  assert.equal(reconciled.acquired, 0);
  const deferred = await restarted.release(lease.leaseId);
  assert.equal(deferred.state, 'stale');
  assert.equal(deferred.cleanupState, 'provider-reconcile-required');
});

test('expired browser lease becomes stale without selecting or closing a foreign target', async t => {
  const { clock, broker, spec } = fixture(t);
  const lease = await broker.acquire(spec);
  clock.value += 101;
  assert.deepEqual(broker.recoverExpired().stale, [lease.leaseId]);
  assert.equal(broker.status().states.stale, 1);
  assert.equal(broker.status().rawCapabilitiesStored, false);
});

test('CDP adapter calls only the protected helper with explicit registered scope and no shell', async () => {
  const calls = [];
  const runner = (executable, args, options) => {
    calls.push({ executable, args, options });
    const action = args[args.indexOf('-Action') + 1];
    if (action === 'Acquire') return { status: 0, stdout: JSON.stringify({ ok: true, lease: { lease_token: 'secret-token', target_id: 'exact-target', endpoint: 'http://127.0.0.1:19222' } }), stderr: '' };
    if (action === 'Heartbeat') return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    return { status: 0, stdout: JSON.stringify({ ok: true, status: 'released', target_id: 'exact-target', target_closed: true }), stderr: '' };
  };
  const identity = createBrowserIdentityRegistry([{
    identityId: 'cdp', role: 'registered-cdp', engine: 'chromium', appIdentity: 'fixture', executable: '/fixture/chrome',
    userDataRoot: '/fixture/profile', profile: 'Default', cdpEndpoint: 'http://127.0.0.1:19222',
    accountAlias: 'account-a', workspaceAlias: 'workspace-a', owner: 'helper', ownershipPolicy: 'task-created-target-only'
  }]).get('cdp');
  const provider = new CdpLeaseProvider({ runner, executable: 'pwsh', script: '/fixture/Manage-CdpChromeSlotLease.ps1' });
  const lease = await provider.acquire({ identity, url: 'https://example.com', ownerTaskId: 'job-a' });
  assert.equal(lease.targetId, 'exact-target');
  assert.ok(calls[0].args.includes('19222'));
  assert.ok(calls[0].args.includes('account-a'));
  assert.ok(calls[0].args.includes('workspace-a'));
  assert.equal(calls[0].options.shell, false);
  await provider.heartbeat({ capability: lease.capability });
  assert.equal((await provider.release({ capability: lease.capability, targetId: lease.targetId })).targetClosed, true);
});


test('CDP target client preserves broker capacity and retained leases without retrying busy admission', async () => {
  const retained = ['unresolved-a', 'unresolved-b'];
  let acquisitions = 0;
  const provider = new CdpLeaseProvider({ runner: (_exe, args) => {
    acquisitions++;
    const override = args.indexOf('-MaxTargetsPerSlot');
    const capacity = override < 0 ? 3 : Number(args[override + 1]);
    if (retained.length >= capacity) return { status: 3, stdout: '{"ok":false,"status":"busy"}', stderr: '' };
    return { status: 0, stdout: JSON.stringify({ ok: true, lease: {
      lease_token: 'fixture-only', target_id: 'exact-task-target', endpoint: 'http://127.0.0.1:19222'
    } }), stderr: '' };
  } });
  const identity = { role: 'registered-cdp', cdpEndpoint: 'http://127.0.0.1:19222', accountAlias: 'fixture', workspaceAlias: 'fixture' };
  assert.equal((await provider.acquire({ identity, url: 'https://example.com', ownerTaskId: 'task' })).targetId, 'exact-task-target');
  assert.equal(acquisitions, 1);
  assert.deepEqual(retained, ['unresolved-a', 'unresolved-b']);
  retained.push('another-owner');
  await assert.rejects(() => provider.acquire({ identity, url: 'https://example.com', ownerTaskId: 'full-task' }), e => e.code === 'cdp_provider_failed');
  assert.equal(acquisitions, 2);
  assert.equal(retained.length, 3);
});

test('browser broker binds the registered CDP slot to the shared AICC Resource Lease', async t => {
  const f = fixture(t, { commonResourceLease: true });
  const lease = await f.broker.acquire(f.spec);
  assert.ok(lease.resourceLeaseId);
  assert.equal(lease.resourceId, 'cdp:19222');
  const common = f.store.read().state.resourceLeases[lease.resourceLeaseId];
  assert.equal(common.resourceType, 'browser-slot');
  assert.equal(common.resourceId, 'cdp:19222');
  assert.equal(common.ownerTaskId, f.job.jobId);
  assert.equal(common.ownerActorId, f.attemptId);
  assert.throws(() => f.resourceLeases.acquire({
    resourceType: 'browser-slot', resourceId: 'cdp:19222', ownerTaskId: 'other-task', ownerActorId: 'other-agent'
  }), error => error.code === 'resource_busy');
  assert.equal(f.broker.authorize(lease.leaseId, { targetId: lease.targetId, url: 'https://example.com', capability: 'inspect' }).resourceLeaseId, lease.resourceLeaseId);
  await f.broker.heartbeat(lease.leaseId);
  await f.broker.release(lease.leaseId);
  assert.equal(f.store.read().state.resourceLeases[lease.resourceLeaseId].state, 'released');
});


test('negative provider heartbeat cannot extend browser or shared resource lease', async t => {
  const f = fixture(t, { providerOverrides: { heartbeat: { ok: false } }, commonResourceLease: true });
  const lease = await f.broker.acquire(f.spec);
  const before = f.store.read().state.browserLeases[lease.leaseId];
  const resource = f.store.read().state.resourceLeases[lease.resourceLeaseId];
  f.clock.value += 10;
  await assert.rejects(() => f.broker.heartbeat(lease.leaseId), error => error.code === 'provider_heartbeat_failed');
  const after = f.store.read().state.browserLeases[lease.leaseId];
  const resourceAfter = f.store.read().state.resourceLeases[lease.resourceLeaseId];
  assert.equal(after.heartbeatAt, before.heartbeatAt);
  assert.equal(after.expiresAt, before.expiresAt);
  assert.equal(resourceAfter.expiresAt, resource.expiresAt);
});
