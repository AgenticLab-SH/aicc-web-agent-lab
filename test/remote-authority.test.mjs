import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RemoteLeaseAuthority } from '../components/workspace-mcp/remote-authority.mjs';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { JobManager } from '../src/jobs/job-manager.mjs';
import { DurableRemoteWriterAuthorizer } from '../src/remote/durable-writer-authorizer.mjs';

const WORKSPACE = `ws_${'a'.repeat(24)}`;
const OTHER_WORKSPACE = `ws_${'b'.repeat(24)}`;
const IDENTITY = 'remote_fixture_owner';
const HASH = crypto.createHash('sha256').update('remote-request').digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-remote-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { value: 1_700_000_000_000 };
  const store = new DurableJobStore({ root: path.join(root, 'store'), now: () => clock.value });
  return { root, clock, store };
}

test('remote read lease is correlation-bound, expires, and cannot call write tools', async t => {
  const { clock, store } = fixture(t);
  const expired = [];
  const authority = new RemoteLeaseAuthority({
    identityBinding: IDENTITY, now: () => clock.value, store, readTtlMs: 2_000,
    onExpire: record => expired.push(record)
  });
  const opened = await authority.open({ workspaceId: WORKSPACE, correlationId: 'correlation-read-1', expiresInSeconds: 2 });
  assert.equal(opened.record.mode, 'read-only');
  assert.equal((await authority.resolve({ workspaceId: WORKSPACE, capability: opened.capability })).leaseId, opened.record.leaseId);
  await assert.rejects(() => authority.resolve({ workspaceId: WORKSPACE, capability: opened.capability, requiredMode: 'write', requestId: 'request-write-1' }), error => error.code === 'remote_scope_denied');
  await assert.rejects(() => authority.resolve({ workspaceId: OTHER_WORKSPACE, capability: opened.capability }), error => error.code === 'remote_workspace_mismatch');
  clock.value += 2_001;
  await assert.rejects(() => authority.resolve({ workspaceId: WORKSPACE, capability: opened.capability }), error => error.code === 'remote_lease_expired');
  assert.equal(store.read().state.remoteLeases[opened.record.leaseId].state, 'stale');
  assert.deepEqual(expired.map(record => record.leaseId), [opened.record.leaseId]);
  assert.deepEqual(authority.status(), {
    identityBinding: IDENTITY, active: 0, readOnly: 0, write: 0,
    writePolicy: 'guarded', rawCapabilitiesStored: false
  });
});

test('remote read session remains available while the durable job store has a live writer', async t => {
  const { root, clock } = fixture(t);
  const jobsRoot = path.join(root, 'blocked-jobs');
  const readRoot = path.join(root, 'read-sessions');
  const jobs = new DurableJobStore({
    root: jobsRoot,
    now: () => clock.value,
    pid: 99,
    isProcessAlive: pid => pid === 77
  });
  const reads = new DurableJobStore({ root: readRoot, now: () => clock.value });
  fs.writeFileSync(path.join(jobsRoot, 'writer.lock'), JSON.stringify({
    pid: 77,
    createdAt: clock.value - 1_000
  }), { mode: 0o600 });
  const authority = new RemoteLeaseAuthority({
    identityBinding: IDENTITY,
    now: () => clock.value,
    store: jobs,
    readStore: reads,
    ownerPid: 99,
    isProcessAlive: pid => pid === 77 || pid === 99
  });

  assert.throws(
    () => jobs.transaction('still-blocked', () => null),
    error => error.code === 'writer_busy'
  );
  const opened = await authority.open({
    workspaceId: WORKSPACE,
    correlationId: 'concurrent-read-session'
  });
  assert.equal(opened.record.mode, 'read-only');
  assert.equal(jobs.read().state.remoteLeases[opened.record.leaseId], undefined);
  assert.equal(reads.read().state.remoteLeases[opened.record.leaseId].state, 'leased');
  assert.equal((await authority.resolve({
    workspaceId: WORKSPACE,
    capability: opened.capability
  })).leaseId, opened.record.leaseId);
  assert.equal((await authority.close(opened.capability)).closed, true);
  assert.equal(reads.read().state.remoteLeases[opened.record.leaseId].state, 'released');
});

test('remote write requires approval and durable binding and rejects replayed request IDs', async t => {
  const { store } = fixture(t);
  const writerCalls = [];
  const writerAuthorizer = {
    acquire: async input => { writerCalls.push({ operation: 'acquire', input }); return { ok: true, writerLeaseRef: 'writer_fixture_binding' }; },
    validate: async input => { writerCalls.push({ operation: 'validate', input }); return { ok: true, writerLeaseRef: 'writer_fixture_binding' }; },
    release: async input => { writerCalls.push({ operation: 'release', input }); return { ok: true }; }
  };
  const authority = new RemoteLeaseAuthority({ identityBinding: IDENTITY, store, writerAuthorizer });
  await assert.rejects(() => authority.open({ workspaceId: WORKSPACE, mode: 'write', correlationId: 'correlation-write-0' }), error => error.code === 'invalid_remote_lease');
  const opened = await authority.open({
    workspaceId: WORKSPACE, mode: 'write', correlationId: 'correlation-write-1', approvalRef: 'approval-phase08',
    jobId: 'durable-job-08', attemptId: 'durable-attempt-08', expiresInSeconds: 30
  });
  assert.equal(opened.record.writerLeaseRef, 'writer_fixture_binding');
  assert.equal((await authority.resolve({ workspaceId: WORKSPACE, capability: opened.capability, requiredMode: 'write', requestId: 'write-request-0001' })).mode, 'write');
  await assert.rejects(() => authority.resolve({ workspaceId: WORKSPACE, capability: opened.capability, requiredMode: 'write', requestId: 'write-request-0001' }), error => error.code === 'remote_replay_rejected');
  assert.equal(Object.values(store.read().state.remoteReplay).length, 1);
  assert.equal(writerCalls.filter(call => call.operation === 'validate').length, 2);
  assert.equal(JSON.stringify(store.read().state).includes(opened.capability), false);
  assert.equal((await authority.close(opened.capability)).closed, true);
  assert.equal(writerCalls.filter(call => call.operation === 'release').length, 1);
});

test('owner-unrestricted write skips approval jobs but preserves one writer and replay safety', async t => {
  const { store } = fixture(t);
  const authority = new RemoteLeaseAuthority({
    identityBinding: IDENTITY,
    store,
    writePolicy: 'owner-unrestricted'
  });
  const opened = await authority.open({
    workspaceId: WORKSPACE,
    mode: 'write',
    correlationId: 'owner-direct-write-1'
  });
  assert.equal(opened.record.approvalRef, null);
  assert.equal(opened.record.jobId, null);
  assert.match(opened.record.writerLeaseRef, /^owner_writer_[a-f0-9]{48}$/);
  await assert.rejects(
    () => authority.open({ workspaceId: WORKSPACE, mode: 'write', correlationId: 'owner-direct-write-2' }),
    error => error.code === 'writer_binding_denied'
  );
  assert.equal((await authority.resolve({
    workspaceId: WORKSPACE,
    capability: opened.capability,
    requiredMode: 'write',
    requestId: 'owner-write-request-1'
  })).mode, 'write');
  await assert.rejects(
    () => authority.resolve({
      workspaceId: WORKSPACE,
      capability: opened.capability,
      requiredMode: 'write',
      requestId: 'owner-write-request-1'
    }),
    error => error.code === 'remote_replay_rejected'
  );
  await authority.close(opened.capability);
  const reopened = await authority.open({
    workspaceId: WORKSPACE,
    mode: 'write',
    correlationId: 'owner-direct-write-3'
  });
  assert.equal(reopened.record.mode, 'write');
});

test('expired owner writer is reaped before a new write lease opens', async t => {
  const { clock, store } = fixture(t);
  const authority = new RemoteLeaseAuthority({
    identityBinding: IDENTITY,
    now: () => clock.value,
    store,
    writePolicy: 'owner-unrestricted',
    writeTtlMs: 2_000
  });
  const expired = await authority.open({
    workspaceId: WORKSPACE,
    mode: 'write',
    correlationId: 'owner-expiring-writer',
    expiresInSeconds: 2
  });
  clock.value += 2_001;
  const reopened = await authority.open({
    workspaceId: WORKSPACE,
    mode: 'write',
    correlationId: 'owner-after-expiry'
  });
  assert.equal(reopened.record.mode, 'write');
  assert.equal(store.read().state.remoteLeases[expired.record.leaseId].state, 'stale');
});

test('overlapping workspace aliases share one owner writer exclusion set', async t => {
  const { store } = fixture(t);
  const authority = new RemoteLeaseAuthority({
    identityBinding: IDENTITY,
    store,
    writePolicy: 'owner-unrestricted'
  });
  const opened = await authority.open({
    workspaceId: WORKSPACE,
    conflictWorkspaceIds: [OTHER_WORKSPACE],
    mode: 'write',
    correlationId: 'owner-overlap-first'
  });
  await assert.rejects(
    () => authority.open({
      workspaceId: OTHER_WORKSPACE,
      conflictWorkspaceIds: [WORKSPACE],
      mode: 'write',
      correlationId: 'owner-overlap-second'
    }),
    error => error.code === 'writer_binding_denied'
  );
  await authority.close(opened.capability);
  const reopened = await authority.open({
    workspaceId: OTHER_WORKSPACE,
    conflictWorkspaceIds: [WORKSPACE],
    mode: 'write',
    correlationId: 'owner-overlap-after-close'
  });
  assert.equal(reopened.record.mode, 'write');
});

test('remote write capability is invalidated when its durable writer job is cancelled', async t => {
  const { store } = fixture(t);
  const manager = new JobManager({ store });
  const job = manager.submit({
    jobId: 'durable-job-cancel', idempotencyKey: 'durable-job-cancel', workloadClass: 'remote', workspaceId: WORKSPACE,
    requestedRoute: 'workspace-mcp', identityBinding: IDENTITY, mode: 'write', requestRef: 'request://remote-cancel', requestHash: HASH
  }).job;
  const dispatched = manager.dispatch(job.jobId, { workerId: 'remote-worker', workloadClasses: ['remote'], modes: ['write'], routeIds: ['workspace-mcp'] });
  manager.start(job.jobId, dispatched.attempt.attemptId);
  const authority = new RemoteLeaseAuthority({
    identityBinding: IDENTITY,
    store,
    writerAuthorizer: new DurableRemoteWriterAuthorizer({ store })
  });
  const opened = await authority.open({
    workspaceId: WORKSPACE,
    mode: 'write',
    correlationId: 'correlation-cancelled-writer',
    approvalRef: 'approval-cancelled-writer',
    jobId: job.jobId,
    attemptId: dispatched.attempt.attemptId,
    expiresInSeconds: 30
  });

  manager.cancel(job.jobId, 'canary_cancelled');

  await assert.rejects(
    () => authority.resolve({ workspaceId: WORKSPACE, capability: opened.capability, requiredMode: 'write', requestId: 'write-after-cancel-0001' }),
    error => error.code === 'writer_binding_denied'
  );
  const persisted = store.read().state.remoteLeases[opened.record.leaseId];
  assert.equal(persisted.state, 'stale');
  assert.equal(persisted.terminalReason, 'remote_writer_binding_invalid');
  assert.equal(Object.values(store.read().state.remoteReplay).length, 0);
});

test('authority restart invalidates old capabilities instead of replaying or adopting them', async t => {
  const { store } = fixture(t);
  const livePids = new Set([4401]);
  const isProcessAlive = pid => livePids.has(pid);
  const authority = new RemoteLeaseAuthority({ identityBinding: IDENTITY, store, ownerPid: 4401, isProcessAlive });
  const opened = await authority.open({ workspaceId: WORKSPACE, correlationId: 'correlation-restart' });
  livePids.delete(4401);
  livePids.add(4402);
  const restarted = new RemoteLeaseAuthority({ identityBinding: IDENTITY, store, ownerPid: 4402, isProcessAlive });
  assert.deepEqual(restarted.reconcileStartup().stale, [opened.record.leaseId]);
  await assert.rejects(() => restarted.resolve({ workspaceId: WORKSPACE, capability: opened.capability }), error => error.code === 'remote_lease_invalid');
  assert.equal(store.read().state.remoteLeases[opened.record.leaseId].terminalReason, 'authority_restart_invalidated_capability');
});

test('startup reconciliation defers stale job-store records instead of blocking the read authority', async t => {
  const { root, clock } = fixture(t);
  const jobsRoot = path.join(root, 'reconcile-busy-jobs');
  const jobs = new DurableJobStore({
    root: jobsRoot,
    now: () => clock.value,
    pid: 99,
    isProcessAlive: pid => pid === 77
  });
  jobs.transaction('seed-stale-remote-lease', state => {
    state.remoteLeases.remote_stale_fixture = {
      leaseId: 'remote_stale_fixture',
      state: 'leased',
      mode: 'write',
      ownerPid: 76,
      expiresAt: new Date(clock.value - 1_000).toISOString()
    };
    return null;
  });
  fs.writeFileSync(path.join(jobsRoot, 'writer.lock'), JSON.stringify({
    pid: 77,
    createdAt: clock.value - 1_000
  }), { mode: 0o600 });
  const authority = new RemoteLeaseAuthority({
    identityBinding: IDENTITY,
    now: () => clock.value,
    store: jobs,
    readStore: new DurableJobStore({ root: path.join(root, 'reconcile-read-sessions'), now: () => clock.value }),
    ownerPid: 99,
    isProcessAlive: pid => pid === 77 || pid === 99
  });

  assert.deepEqual(authority.reconcileStartup(), { stale: [], deferred: 1 });
  const opened = await authority.open({
    workspaceId: WORKSPACE,
    correlationId: 'reconcile-read-open'
  });
  assert.equal(opened.record.mode, 'read-only');
});

test('a second live authority preserves leases and shares owner-writer exclusion through the durable store', async t => {
  const { store } = fixture(t);
  const livePids = new Set([4501, 4502]);
  const isProcessAlive = pid => livePids.has(pid);
  const first = new RemoteLeaseAuthority({
    identityBinding: IDENTITY,
    store,
    writePolicy: 'owner-unrestricted',
    ownerPid: 4501,
    isProcessAlive,
    authorityInstanceId: 'authority-instance-first'
  });
  const second = new RemoteLeaseAuthority({
    identityBinding: IDENTITY,
    store,
    writePolicy: 'owner-unrestricted',
    ownerPid: 4502,
    isProcessAlive,
    authorityInstanceId: 'authority-instance-second'
  });
  const opened = await first.open({
    workspaceId: WORKSPACE,
    conflictWorkspaceIds: [OTHER_WORKSPACE],
    mode: 'write',
    correlationId: 'owner-live-authority-first'
  });

  assert.deepEqual(second.reconcileStartup().stale, []);
  assert.equal(store.read().state.remoteLeases[opened.record.leaseId].state, 'leased');
  await assert.rejects(
    () => second.open({
      workspaceId: OTHER_WORKSPACE,
      conflictWorkspaceIds: [WORKSPACE],
      mode: 'write',
      correlationId: 'owner-live-authority-second'
    }),
    error => error.code === 'writer_binding_denied'
  );

  livePids.delete(4501);
  assert.deepEqual(second.reconcileStartup().stale, [opened.record.leaseId]);
  const recovered = await second.open({
    workspaceId: OTHER_WORKSPACE,
    conflictWorkspaceIds: [WORKSPACE],
    mode: 'write',
    correlationId: 'owner-dead-authority-recovered'
  });
  assert.equal(recovered.record.ownerPid, 4502);
  assert.equal(recovered.record.authorityInstanceId, 'authority-instance-second');
});

test('durable remote writer authorizer binds exact workspace, identity, job and attempt lease', async t => {
  const { store } = fixture(t);
  const manager = new JobManager({ store });
  const job = manager.submit({
    jobId: 'durable-job-08', idempotencyKey: 'durable-job-08', workloadClass: 'remote', workspaceId: WORKSPACE,
    requestedRoute: 'workspace-mcp', identityBinding: IDENTITY, mode: 'write', requestRef: 'request://remote', requestHash: HASH
  }).job;
  const dispatched = manager.dispatch(job.jobId, { workerId: 'remote-worker', workloadClasses: ['remote'], modes: ['write'], routeIds: ['workspace-mcp'] });
  manager.start(job.jobId, dispatched.attempt.attemptId);
  const authorizer = new DurableRemoteWriterAuthorizer({ store });
  const result = await authorizer.acquire({ workspaceId: WORKSPACE, jobId: job.jobId, attemptId: dispatched.attempt.attemptId, identityBinding: IDENTITY });
  assert.equal(result.ok, true);
  assert.match(result.writerLeaseRef, /^writer_[a-f0-9]{64}$/);
  await assert.rejects(() => authorizer.acquire({ workspaceId: OTHER_WORKSPACE, jobId: job.jobId, attemptId: dispatched.attempt.attemptId, identityBinding: IDENTITY }), error => error.code === 'remote_job_binding_invalid');
});

test('independent children sharing a broad alias can write concurrently while actual ancestors remain excluded', async t => {
  const { store } = fixture(t);
  const parent = `ws_${'c'.repeat(24)}`;
  const first = new RemoteLeaseAuthority({ identityBinding: IDENTITY, store, writePolicy: 'owner-unrestricted' });
  const second = new RemoteLeaseAuthority({ identityBinding: IDENTITY, store, writePolicy: 'owner-unrestricted' });
  const left = await first.open({ workspaceId: WORKSPACE, conflictWorkspaceIds: [parent], mode: 'write', correlationId: 'siblings-left-owner' });
  const right = await first.open({ workspaceId: OTHER_WORKSPACE, conflictWorkspaceIds: [parent], mode: 'write', correlationId: 'siblings-right-owner' });
  assert.equal((await first.resolve({workspaceId: WORKSPACE, capability: left.capability, requiredMode: 'write', requestId: 'siblings-left-write'})).mode, 'write');
  assert.equal((await first.resolve({workspaceId: OTHER_WORKSPACE, capability: right.capability, requiredMode: 'write', requestId: 'siblings-right-write'})).mode, 'write');
  await assert.rejects(() => second.open({workspaceId: WORKSPACE, conflictWorkspaceIds: [parent], mode: 'write', correlationId: 'same-root-other-owner'}), error => error.code === 'writer_binding_denied');
  await assert.rejects(() => second.open({workspaceId: parent, conflictWorkspaceIds: [WORKSPACE, OTHER_WORKSPACE], mode: 'write', correlationId: 'ancestor-other-owner'}), error => error.code === 'writer_binding_denied');
  await first.close(left.capability);
  const sharedStoreSibling = await second.open({workspaceId: WORKSPACE, conflictWorkspaceIds: [parent], mode: 'write', correlationId: 'siblings-cross-process'});
  assert.equal((await first.resolve({workspaceId: OTHER_WORKSPACE, capability: right.capability, requiredMode: 'write', requestId: 'siblings-still-valid'})).mode, 'write');
  await first.close(right.capability);
  await second.close(sharedStoreSibling.capability);
  const broad = await second.open({workspaceId: parent, conflictWorkspaceIds: [WORKSPACE, OTHER_WORKSPACE], mode: 'write', correlationId: 'ancestor-now-owner'});
  await assert.rejects(() => first.open({workspaceId: WORKSPACE, conflictWorkspaceIds: [parent], mode: 'write', correlationId: 'child-while-parent-owner'}), error => error.code === 'writer_binding_denied');
  await second.close(broad.capability);
});

test('installed nonconsuming writer checks preserve replay state until actual dispatch', async t => {
  const { store } = fixture(t);
  const authority = new RemoteLeaseAuthority({identityBinding: IDENTITY, store, writePolicy: 'owner-unrestricted'});
  const opened = await authority.open({workspaceId: WORKSPACE, mode: 'write', correlationId: 'nonconsume-writer-check'});
  await authority.resolve({workspaceId: WORKSPACE, capability: opened.capability, requiredMode: 'write', consumeRequest: false});
  assert.equal(Object.keys(store.read().state.remoteReplay).length, 0);
  await authority.resolve({workspaceId: WORKSPACE, capability: opened.capability, requiredMode: 'write', requestId: 'nonconsume-actual-write'});
  assert.equal(Object.keys(store.read().state.remoteReplay).length, 1);
  await assert.rejects(() => authority.resolve({workspaceId: WORKSPACE, capability: opened.capability, requiredMode: 'write', requestId: 'nonconsume-actual-write'}), error => error.code === 'remote_replay_rejected');
  await authority.close(opened.capability);
  assert.equal(store.read().state.remoteLeases[opened.record.leaseId].state, 'released');
});
