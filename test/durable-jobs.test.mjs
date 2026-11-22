import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { DurableJobStore, DurableStoreError, durableStateHash } from '../src/jobs/durable-store.mjs';
import { JobManager, JobManagerError, selectWorker } from '../src/jobs/job-manager.mjs';

const HASH = crypto.createHash('sha256').update('request').digest('hex');
const CAPABILITY_HASH = crypto.createHash('sha256').update('capabilities').digest('hex');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-durable-jobs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { value: options.now ?? 1_700_000_000_000 };
  const store = new DurableJobStore({ root, now: () => clock.value, lockStaleMs: 100, lockWaitMs: 0, ...options.store });
  const manager = new JobManager({ store, now: () => clock.value, leaseDurationMs: 100 });
  return { root, clock, store, manager };
}

function spec(overrides = {}) {
  return {
    jobId: overrides.jobId,
    idempotencyKey: overrides.idempotencyKey ?? `key-${crypto.randomUUID()}`,
    workloadClass: 'batch',
    workspaceId: '/workspace/a',
    requestedRoute: 'native-direct',
    identityBinding: 'account:a',
    mode: 'read-only',
    requestRef: 'request://fixture',
    requestHash: HASH,
    ...overrides
  };
}

const readWorker = { workerId: 'reader-1', workloadClasses: ['batch'], modes: ['read-only'], routeIds: ['native-direct'], maxActive: 10 };
const writeWorker = { workerId: 'writer-1', workloadClasses: ['batch'], modes: ['write'], routeIds: ['native-direct', 'ocx-direct'], maxActive: 10 };

test('durable store WAL recovers a transaction after an injected snapshot crash', t => {
  const { root, clock } = fixture(t);
  const crashing = new DurableJobStore({ root, now: () => clock.value, crashAfterJournal: true });
  assert.throws(() => crashing.transaction('fixture.crash', state => { state.jobs.one = { state: 'queued' }; }), error => error.code === 'injected_crash_after_wal');
  const recovered = new DurableJobStore({ root, now: () => clock.value }).read();
  assert.equal(recovered.recoveredFromWal, true);
  assert.equal(recovered.state.jobs.one.state, 'queued');
  assert.equal(recovered.state.sequence, 1);
});

test('durable store migrates version zero and creates an owner-only backup', t => {
  const { root, store } = fixture(t);
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ schemaVersion: 0, jobs: { old: { state: 'paused' } } }), { mode: 0o600 });
  const migrated = store.read().state;
  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.jobs.old.state, 'paused');
  store.transaction('migration.persist', state => { state.migrations[0].appliedAt = 'fixture'; });
  const backup = store.backup('before-drill');
  assert.equal(backup.manifest.recoverable, true);
  assert.equal(backup.manifest.stateHash, durableStateHash(store.read().state));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(backup.directory, 'manifest.json')).mode & 0o077, 0);
});

test('durable store compacts WAL after a bounded record count and previews backup retention', t => {
  const { root, clock } = fixture(t);
  const store = new DurableJobStore({ root, now: () => clock.value, maxJournalRecords: 2 });
  for (let index = 0; index < 4; index += 1) store.transaction(`fixture.${index}`, state => { state.effects[index] = { index }; });
  const journalLines = fs.readFileSync(path.join(root, 'journal.jsonl'), 'utf8').trim().split('\n');
  assert.ok(journalLines.length <= 2);
  assert.equal(store.read().state.effects[3].index, 3);
  store.backup('one');
  clock.value += 1;
  store.backup('two');
  const retention = store.retentionPlan({ keepBackups: 1 });
  assert.equal(retention.retained.length, 1);
  assert.equal(retention.candidates.length, 1);
  assert.equal(retention.apply, false);
  assert.equal(fs.existsSync(retention.candidates[0].directory), true);
});

test('durable store bounds WAL bytes without dropping jobs, replay fences, or unknown results', t => {
  const { root } = fixture(t);
  const store = new DurableJobStore({ root, maxJournalBytes: 12_000 });
  store.transaction('fixture.original', state => {
    state.jobs.original = { state: 'unknown', detail: '한글'.repeat(900) };
    state.remoteReplay.original = { outcome: 'unknown', requestHash: HASH };
    state.remoteLeases.original = { state: 'released', owner: 'fixture' };
  });
  for (let index = 0; index < 6; index += 1) {
    store.transaction('fixture.progress', state => { state.effects.last = { index }; });
    const journal = fs.readFileSync(path.join(root, 'journal.jsonl'), 'utf8');
    assert.ok(Buffer.byteLength(journal) <= 12_000);
    assert.ok(journal.trim().split('\n').length < 200);
  }
  const reopened = new DurableJobStore({ root }).read();
  assert.equal(reopened.state.sequence, 7);
  assert.equal(reopened.state.jobs.original.state, 'unknown');
  assert.equal(reopened.state.jobs.original.detail, '한글'.repeat(900));
  assert.equal(reopened.state.remoteReplay.original.requestHash, HASH);
  assert.equal(reopened.state.remoteLeases.original.state, 'released');
  assert.equal(reopened.state.effects.last.index, 5);
  assert.equal(store.integrity().ok, true);
});

test('byte checkpoint retains an oversized state and crash recovery still replays its successor', t => {
  const { root } = fixture(t);
  const store = new DurableJobStore({ root, maxJournalBytes: 100 });
  store.transaction('fixture.large', state => { state.jobs.large = { bodyHash: HASH, padding: 'x'.repeat(1_000) }; });
  assert.equal(fs.readFileSync(path.join(root, 'journal.jsonl'), 'utf8').trim().split('\n').length, 1);
  const crashing = new DurableJobStore({ root, maxJournalBytes: 100, crashAfterJournal: true });
  assert.throws(() => crashing.transaction('fixture.crash', state => { state.effects.after = { saved: true }; }), error => error.code === 'injected_crash_after_wal');
  const recovered = store.read();
  assert.equal(recovered.recoveredFromWal, true);
  assert.equal(recovered.state.jobs.large.bodyHash, HASH);
  assert.equal(recovered.state.effects.after.saved, true);
  store.transaction('fixture.checkpoint', () => null);
  assert.equal(fs.readFileSync(path.join(root, 'journal.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.equal(store.integrity().ok, true);
});

test('byte checkpoint rejects invalid limits and does not conceal corrupt WAL records', t => {
  const { root } = fixture(t);
  for (const maxJournalBytes of [0, -1, 1.5, Infinity, '1024']) {
    assert.throws(() => new DurableJobStore({ root, maxJournalBytes }), error => error.code === 'invalid_journal_limit');
  }
  const store = new DurableJobStore({ root, maxJournalBytes: 100 });
  store.transaction('fixture.valid', () => null);
  const journalPath = path.join(root, 'journal.jsonl');
  const record = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  record.hash = 'invalid';
  fs.writeFileSync(journalPath, JSON.stringify(record) + '\n');
  assert.throws(() => store.transaction('fixture.must_not_replace', () => null), error => error.code === 'journal_invalid');
  assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).hash, 'invalid');
});

test('durable store rejects a live writer and recovers only an expired dead lock', t => {
  const { root, clock, store } = fixture(t, { store: { isProcessAlive: pid => pid === 77, pid: 99 } });
  fs.writeFileSync(path.join(root, 'writer.lock'), JSON.stringify({ pid: 77, createdAt: clock.value - 1_000 }), { mode: 0o600 });
  assert.throws(() => store.transaction('blocked', () => null), error => error instanceof DurableStoreError && error.code === 'writer_busy');
  fs.writeFileSync(path.join(root, 'writer.lock'), JSON.stringify({ pid: 78, createdAt: clock.value - 1_000 }));
  assert.doesNotThrow(() => store.transaction('recovered', () => null));
});

test('durable store waits for a foreign writer before mutating exactly once', async t => {
  const { root } = fixture(t);
  const lock = path.join(root, 'writer.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, createdAt: Date.now() }));
  const worker = new Worker(`const { parentPort,workerData }=require('node:worker_threads');const fs=require('node:fs');parentPort.postMessage('ready');setTimeout(()=>{fs.unlinkSync(workerData);parentPort.postMessage('released')},100)`, { eval: true, workerData: lock });
  await new Promise(resolve => worker.once('message', resolve));
  const exited = new Promise((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
  const store = new DurableJobStore({ root, lockWaitMs: 1_000, isProcessAlive: () => true });
  let mutations = 0;
  store.transaction('fixture.after_foreign_writer', state => { mutations++; state.effects.once = { value: 1 }; });
  await exited;
  assert.equal(mutations, 1);
  assert.equal(store.read().state.sequence, 1);
  assert.equal(store.read().state.effects.once.value, 1);
});

test('durable store preserves live or unreadable locks at timeout and never waits on itself', t => {
  const { root } = fixture(t);
  const lock = path.join(root, 'writer.lock');
  let mutations = 0;
  const store = new DurableJobStore({ root, lockWaitMs: 30, isProcessAlive: () => true });
  for (const bytes of ['', JSON.stringify({ pid: 123456, createdAt: Date.now() })]) {
    fs.writeFileSync(lock, bytes);
    assert.throws(() => store.transaction('fixture.blocked', () => { mutations++; }), error => error.code === 'writer_busy');
    assert.equal(fs.readFileSync(lock, 'utf8'), bytes);
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
  assert.throws(() => store.transaction('fixture.same_process', () => { mutations++; }), error => error.code === 'writer_busy' && error.writerPid === process.pid);
  assert.equal(mutations, 0);
  assert.equal(fs.existsSync(path.join(root, 'journal.jsonl')), false);
  for (const lockWaitMs of [-1, 5_001, 1.2, Infinity, '30']) {
    assert.throws(() => new DurableJobStore({ root, lockWaitMs }), error => error.code === 'invalid_lock_wait');
  }
});

test('submit is idempotent and rejects prompt, response, token, and transcript bodies', t => {
  const { manager } = fixture(t);
  const first = manager.submit(spec({ idempotencyKey: 'stable' }));
  const duplicate = manager.submit(spec({ idempotencyKey: 'stable' }));
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(first.job.jobId, duplicate.job.jobId);
  for (const field of ['prompt', 'response', 'token', 'transcript']) {
    assert.throws(() => manager.submit(spec({ idempotencyKey: field, metadata: { [field]: 'private body' } })), error => error instanceof JobManagerError && error.code === 'sensitive_body_prohibited');
  }
});

test('job v2 carries operation and explicit route lineage into attempts', t => {
  const { manager } = fixture(t);
  const job = manager.submit(spec({
    jobId: 'lineage-job',
    operationId: 'operation-001',
    direction: 'oob_ops',
    requestedRoute: 'remote-desktop',
    routeClass: 'oob_ops',
    routeInstanceRef: 'device-ref-001'
  })).job;
  assert.equal(job.contractVersion, 2);
  assert.equal(job.operationId, 'operation-001');
  assert.equal(job.direction, 'oob_ops');
  assert.equal(job.routeClass, 'oob_ops');
  assert.equal(job.routeInstanceRef, 'device-ref-001');
  const lease = manager.dispatch(job.jobId, {
    workerId: 'oob-reader',
    workloadClasses: ['batch'],
    modes: ['read-only'],
    routeIds: ['remote-desktop'],
    maxActive: 1
  });
  assert.equal(lease.attempt.operationId, 'operation-001');
  assert.equal(lease.attempt.routeClass, 'oob_ops');
  assert.equal(lease.attempt.routeInstanceRef, 'device-ref-001');
  assert.equal(manager.submit(spec({ jobId: 'default-operation' })).job.operationId, 'default-operation');
  assert.throws(() => manager.submit(spec({ jobId: 'bad-direction', direction: 'automatic-fallback' })),
    error => error instanceof JobManagerError && error.code === 'invalid_job');
});

test('single writer rejects a second writer while concurrent read-only rescue proceeds', t => {
  const { manager } = fixture(t);
  const first = manager.submit(spec({ jobId: 'writer-a', mode: 'write' })).job;
  const second = manager.submit(spec({ jobId: 'writer-b', mode: 'write' })).job;
  const rescue = manager.submit(spec({ jobId: 'reader', mode: 'read-only' })).job;
  manager.dispatch(first.jobId, writeWorker);
  assert.throws(() => manager.dispatch(second.jobId, writeWorker), error => error.code === 'writer_conflict');
  const readLease = manager.dispatch(rescue.jobId, readWorker);
  assert.equal(readLease.job.writerLease.mode, 'read-only');
  assert.equal(manager.status().activeWriters, 1);
});

test('pause, resume, cancel, failure, and explicit failover preserve terminal attempts', t => {
  const { manager } = fixture(t);
  const paused = manager.submit(spec({ jobId: 'paused', mode: 'write' })).job;
  const firstLease = manager.dispatch(paused.jobId, writeWorker);
  manager.start(paused.jobId, firstLease.attempt.attemptId);
  manager.pause(paused.jobId, 'checkpointed');
  manager.resume(paused.jobId);
  const secondLease = manager.dispatch(paused.jobId, writeWorker);
  manager.start(paused.jobId, secondLease.attempt.attemptId);
  const failed = manager.failAttempt(paused.jobId, secondLease.attempt.attemptId, 'route_down');
  assert.equal(failed.state, 'failed');
  const failover = manager.requestFailover(paused.jobId, {
    routeId: 'ocx-direct', identityBinding: 'ocx:fixed', reason: 'explicit_rescue', approvedPolicy: 'phase07-fixture'
  });
  assert.equal(failover.attempts.at(-1).state, 'superseded');
  const thirdLease = manager.dispatch(paused.jobId, writeWorker);
  assert.equal(thirdLease.attempt.fallbackFrom, 'native-direct');
  assert.equal(thirdLease.attempt.approvedPolicy, 'phase07-fixture');
  assert.equal(manager.cancel(paused.jobId).state, 'cancelled');
});

test('stale lease recovery pauses the job and does not create a new attempt', t => {
  const { manager, clock } = fixture(t);
  const job = manager.submit(spec({ jobId: 'orphan', mode: 'write' })).job;
  const lease = manager.dispatch(job.jobId, writeWorker);
  manager.start(job.jobId, lease.attempt.attemptId);
  clock.value += 101;
  assert.deepEqual(manager.recoverExpired().recovered, ['orphan']);
  const recovered = manager.read('orphan');
  assert.equal(recovered.state, 'paused');
  assert.equal(recovered.attempts.length, 1);
  assert.equal(recovered.attempts[0].state, 'paused');
  assert.equal(manager.status().activeWriters, 0);
});

test('effect reservation is idempotent across resumed attempts', t => {
  const { manager } = fixture(t);
  const job = manager.submit(spec({ jobId: 'effect', mode: 'write' })).job;
  const first = manager.dispatch(job.jobId, writeWorker);
  manager.start(job.jobId, first.attempt.attemptId);
  assert.equal(manager.reserveEffect(job.jobId, first.attempt.attemptId, 'publish', 'effect://fixture').created, true);
  manager.pause(job.jobId, 'worker_exit');
  manager.resume(job.jobId);
  const second = manager.dispatch(job.jobId, writeWorker);
  manager.start(job.jobId, second.attempt.attemptId);
  assert.equal(manager.reserveEffect(job.jobId, second.attempt.attemptId, 'publish', 'effect://fixture').created, false);
  assert.equal(manager.completeEffect(job.jobId, 'publish').state, 'completed');
});

test('orchestration run enforces hard cap, role DAG dependencies, result registry, and owned cancellation', t => {
  const { manager } = fixture(t);
  const run = manager.createRun({
    runId: 'run-1', requestId: 'request-1', rootTaskId: 'root-1', workspaceId: '/workspace/a',
    routeId: 'native-direct', identityBinding: 'account:a', mode: 'full', capabilitySnapshotHash: CAPABILITY_HASH,
    budgets: { defaultFanOut: 2, hardActiveCap: 2 }, roleDag: [{ roleId: 'researcher', role: 'web-researcher', mode: 'read-only', dependencies: [] }, { roleId: 'critic', role: 'critic', mode: 'read-only', dependencies: ['researcher'] }, { roleId: 'merger', role: 'merger', mode: 'read-only', dependencies: ['researcher', 'critic'] }]
  });
  assert.equal(run.rawTranscriptStored, false);
  const roles = ['researcher', 'critic', 'merger'];
  const jobs = ['one', 'two', 'three'].map((jobId, index) => manager.submit(spec({ jobId, orchestrationRunId: run.runId, roleId: roles[index] })).job);
  const leases = jobs.slice(0, 2).map(job => manager.dispatch(job.jobId, readWorker));
  assert.throws(() => manager.dispatch(jobs[2].jobId, readWorker), error => error.code === 'run_backpressure');
  manager.start(jobs[0].jobId, leases[0].attempt.attemptId);
  const result = manager.recordResult(jobs[0].jobId, leases[0].attempt.attemptId, {
    claim: 'The source supports the finding.', evidence: [{ ref: 'evidence://one', sha256: HASH }], unknown: 'Live drift remains possible.'
  });
  assert.equal(result.validatorStatus, 'pending');
  assert.equal(result.contractVersion, 1);
  assert.equal(result.jobId, jobs[0].jobId);
  const cancelled = manager.cancelRun(run.runId);
  assert.deepEqual(new Set(cancelled.cancelled), new Set(['one', 'two', 'three']));
});

test('ten-role run honors an eight-tab active budget and queues the remainder', t => {
  const { manager } = fixture(t);
  const roleDag = Array.from({ length: 10 }, (_, index) => ({ roleId: `role-${index}`, role: 'solver', mode: 'read-only', dependencies: [] }));
  const run = manager.createRun({
    runId: 'ten-role-run', requestId: 'ten-role-request', rootTaskId: 'ten-role-root', workspaceId: '/workspace/a',
    routeId: 'native-direct', identityBinding: 'account:a', mode: 'full', capabilitySnapshotHash: CAPABILITY_HASH,
    budgets: { defaultFanOut: 8, hardActiveCap: 8 }, roleDag
  });
  const jobs = roleDag.map((role, index) => manager.submit(spec({
    jobId: `ten-job-${index}`, idempotencyKey: `ten-key-${index}`, orchestrationRunId: run.runId, roleId: role.roleId
  })).job);
  for (const job of jobs.slice(0, 8)) manager.dispatch(job.jobId, readWorker);
  assert.throws(() => manager.dispatch(jobs[8].jobId, readWorker), error => error.code === 'run_backpressure');
  const current = jobs.map(job => manager.read(job.jobId));
  assert.equal(current.filter(job => job.state === 'leased').length, 8);
  assert.equal(current.filter(job => job.state === 'queued').length, 2);
  assert.ok(current.filter(job => ['leased', 'running', 'verifying'].includes(job.state)).length <= 8);
});

test('an unspecified tab budget is derived from the runnable role graph instead of a fixed default', t => {
  const { manager } = fixture(t);
  const roleDag = [
    ...Array.from({ length: 4 }, (_, index) => ({ roleId: `independent-${index}`, role: 'solver', mode: 'read-only', dependencies: [] })),
    { roleId: 'merger', role: 'merger', mode: 'read-only', dependencies: ['independent-0', 'independent-1', 'independent-2', 'independent-3'] }
  ];
  const run = manager.createRun({
    runId: 'derived-budget-run', requestId: 'derived-budget-request', rootTaskId: 'derived-budget-root', workspaceId: '/workspace/a',
    routeId: 'native-direct', identityBinding: 'account:a', mode: 'full', capabilitySnapshotHash: CAPABILITY_HASH, roleDag
  });
  assert.deepEqual(run.budgets, { defaultFanOut: 4, hardActiveCap: 5 });
});

test('orchestration rejects cyclic DAGs, multiple writers, and browser-only local writes', t => {
  const { manager } = fixture(t);
  const base = {
    requestId: 'request', rootTaskId: 'root', workspaceId: '/workspace/a', routeId: 'web-gpt',
    identityBinding: 'account:a', mode: 'full', capabilitySnapshotHash: CAPABILITY_HASH,
    budgets: { defaultFanOut: 2, hardActiveCap: 5 }
  };
  assert.throws(() => manager.createRun({ ...base, roleDag: [{ roleId: 'a', role: 'a', mode: 'read-only', dependencies: ['b'] }, { roleId: 'b', role: 'b', mode: 'read-only', dependencies: ['a'] }] }), error => error.code === 'invalid_dag');
  assert.throws(() => manager.createRun({ ...base, roleDag: [{ roleId: 'a', role: 'a', mode: 'write', dependencies: [] }, { roleId: 'b', role: 'b', mode: 'write', dependencies: [] }] }), error => error.code === 'invalid_dag');
  assert.throws(() => manager.createRun({ ...base, mode: 'browser-only', roleDag: [{ roleId: 'writer', role: 'writer', mode: 'write', dependencies: [] }] }), error => error.code === 'unsupported_surface');
});

test('worker selection uses explicit workload, route, mode, and capacity rather than model labels', () => {
  const job = spec();
  const selected = selectWorker(job, [
    { workerId: 'busy', workloadClasses: ['batch'], modes: ['read-only'], routeIds: ['native-direct'], active: 2, model: 'irrelevant' },
    { workerId: 'idle', workloadClasses: ['batch'], modes: ['read-only'], routeIds: ['native-direct'], active: 0, model: 'also-irrelevant' },
    { workerId: 'wrong-route', workloadClasses: ['batch'], modes: ['read-only'], routeIds: ['web-gpt'], active: 0 }
  ]);
  assert.equal(selected.workerId, 'idle');
});
