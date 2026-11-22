import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectPriorityOutbox, ProjectPriorityOutboxError } from '../src/projects/project-priority-outbox.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-priority-outbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { value: Date.parse('2026-05-05T00:00:00Z') };
  const outbox = new ProjectPriorityOutbox({ root, now: () => clock.value, lockStaleMs: 100 });
  const initial = {
    remoteVersion: 'notion-v1',
    capturedAt: '2026-05-05T00:00:00Z',
    priorities: [
      { projectId: 'alpha', rank: 10 },
      { projectId: 'beta', rank: 20 }
    ]
  };
  outbox.initialize(initial);
  return { root, clock, outbox, initial };
}

test('reorder enqueue is durable PENDING_SYNC and never mutates the confirmed snapshot optimistically', t => {
  const { outbox } = fixture(t);
  const first = outbox.enqueue({
    operationId: 'move-alpha',
    idempotencyKey: 'priority-alpha-v1',
    projectId: 'alpha',
    desiredRank: 5,
    expectedRemoteVersion: 'notion-v1',
    actor: 'owner'
  });
  assert.equal(first.duplicate, false);
  assert.equal(first.operation.state, 'PENDING_SYNC');
  assert.equal(first.operation.effect.state, 'RESERVED');
  assert.equal(first.operation.rollbackSnapshot.priorities.find(item => item.projectId === 'alpha').rank, 10);
  assert.equal(outbox.readState().state.confirmedSnapshot.priorities.find(item => item.projectId === 'alpha').rank, 10);

  const duplicate = outbox.enqueue({
    operationId: 'different-operation-id',
    idempotencyKey: 'priority-alpha-v1',
    projectId: 'alpha',
    desiredRank: 5,
    expectedRemoteVersion: 'notion-v1',
    actor: 'owner'
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.operation.operationId, 'move-alpha');
  assert.throws(
    () => outbox.enqueue({ operationId: 'conflict', idempotencyKey: 'priority-alpha-v1', projectId: 'alpha', desiredRank: 4, expectedRemoteVersion: 'notion-v1', actor: 'owner' }),
    error => error instanceof ProjectPriorityOutboxError && error.code === 'idempotency_conflict'
  );
});

test('remote version conflict becomes DRIFT before any connector write request is emitted', t => {
  const { outbox } = fixture(t);
  outbox.enqueue({ operationId: 'move-alpha', idempotencyKey: 'alpha', projectId: 'alpha', desiredRank: 5, expectedRemoteVersion: 'notion-v1', actor: 'owner' });
  const prepared = outbox.prepareSync('move-alpha', { remoteVersion: 'notion-v2', workerId: 'notion-connector' });
  assert.equal(prepared.request, null);
  assert.equal(prepared.operation.state, 'DRIFT');
  assert.equal(prepared.operation.actualRemoteVersion, 'notion-v2');
  assert.equal(prepared.operation.effect.state, 'CANCELLED');
  assert.equal(outbox.readState().state.confirmedSnapshot.remoteVersion, 'notion-v1');
});

test('confirmed snapshot changes only after remote result verification and applied rollback requires a new guarded operation', t => {
  const { outbox } = fixture(t);
  outbox.enqueue({ operationId: 'move-alpha', idempotencyKey: 'alpha', projectId: 'alpha', desiredRank: 5, expectedRemoteVersion: 'notion-v1', actor: 'owner' });
  const prepared = outbox.prepareSync('move-alpha', { remoteVersion: 'notion-v1', workerId: 'notion-connector' });
  assert.equal(prepared.request.idempotencyKey, 'alpha');
  assert.equal(outbox.readState().state.confirmedSnapshot.remoteVersion, 'notion-v1');
  const completed = outbox.completeSync('move-alpha', {
    remoteVersion: 'notion-v2',
    capturedAt: '2026-05-05T00:01:00Z',
    priorities: [{ projectId: 'alpha', rank: 5 }, { projectId: 'beta', rank: 20 }]
  });
  assert.equal(completed.operation.state, 'APPLIED');
  assert.equal(completed.operation.effect.state, 'COMMITTED');
  assert.equal(outbox.readState().state.confirmedSnapshot.remoteVersion, 'notion-v2');
  assert.throws(
    () => outbox.rollback('move-alpha', { reason: 'undo', actor: 'owner' }),
    error => error instanceof ProjectPriorityOutboxError && error.code === 'remote_rollback_required'
  );
});

test('restart recovers a journaled reserved effect and reconciles it without blind duplicate mutation', t => {
  const { root, clock, outbox } = fixture(t);
  const crashing = new ProjectPriorityOutbox({ root, now: () => clock.value, crashAfterJournal: true });
  assert.throws(
    () => crashing.enqueue({ operationId: 'move-alpha', idempotencyKey: 'alpha', projectId: 'alpha', desiredRank: 5, expectedRemoteVersion: 'notion-v1', actor: 'owner' }),
    error => error instanceof ProjectPriorityOutboxError && error.code === 'injected_crash_after_journal'
  );
  const restarted = new ProjectPriorityOutbox({ root, now: () => clock.value });
  assert.equal(restarted.readState().recoveredFromJournal, true);
  assert.equal(restarted.get('move-alpha').state, 'PENDING_SYNC');
  restarted.prepareSync('move-alpha', { remoteVersion: 'notion-v1', workerId: 'notion-connector' });

  const afterWorkerRestart = new ProjectPriorityOutbox({ root, now: () => clock.value });
  const reconciliation = afterWorkerRestart.reconcileReserved({
    remoteVersion: 'notion-v1',
    capturedAt: '2026-05-05T00:00:30Z',
    priorities: [{ projectId: 'alpha', rank: 10 }, { projectId: 'beta', rank: 20 }]
  });
  assert.deepEqual(reconciliation, { applied: [], pending: ['move-alpha'], drift: [] });
  assert.equal(afterWorkerRestart.get('move-alpha').state, 'PENDING_SYNC');
  assert.equal(afterWorkerRestart.get('move-alpha').resumeCount, 1);
});

test('reserved effect reconciliation recognizes already-applied remote state and rollback preserves the original snapshot', t => {
  const { outbox } = fixture(t);
  outbox.enqueue({ operationId: 'move-alpha', idempotencyKey: 'alpha', projectId: 'alpha', desiredRank: 5, expectedRemoteVersion: 'notion-v1', actor: 'owner' });
  outbox.prepareSync('move-alpha', { remoteVersion: 'notion-v1', workerId: 'notion-connector' });
  const reconciliation = outbox.reconcileReserved({
    remoteVersion: 'notion-v2',
    capturedAt: '2026-05-05T00:02:00Z',
    priorities: [{ projectId: 'alpha', rank: 5 }, { projectId: 'beta', rank: 20 }]
  });
  assert.deepEqual(reconciliation, { applied: ['move-alpha'], pending: [], drift: [] });
  assert.equal(outbox.get('move-alpha').state, 'APPLIED');

  outbox.initialize({
    remoteVersion: 'notion-v3',
    capturedAt: '2026-05-05T00:03:00Z',
    priorities: [{ projectId: 'alpha', rank: 5 }, { projectId: 'beta', rank: 20 }]
  });
  outbox.enqueue({ operationId: 'move-beta', idempotencyKey: 'beta', projectId: 'beta', desiredRank: 8, expectedRemoteVersion: 'notion-v3', actor: 'owner' });
  const rolledBack = outbox.rollback('move-beta', { reason: 'Owner cancelled before remote sync.', actor: 'owner' });
  assert.equal(rolledBack.operation.state, 'ROLLED_BACK');
  assert.equal(rolledBack.operation.rollbackSnapshot.remoteVersion, 'notion-v3');
  assert.equal(outbox.readState().state.confirmedSnapshot.priorities.find(item => item.projectId === 'beta').rank, 20);
});

test('priority outbox creates an owner-only recoverable backup', t => {
  const { outbox } = fixture(t);
  const backup = outbox.backup('before-connector-sync');
  assert.equal(backup.manifest.recoverable, true);
  assert.match(backup.manifest.stateHash, /^[a-f0-9]{64}$/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(backup.directory).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(backup.directory, 'manifest.json')).mode & 0o077, 0);
  }
});

test('priority outbox rejects symlink owner roots and state files', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-priority-symlink-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const target = path.join(temporary, 'target');
  fs.mkdirSync(target);
  const linkedRoot = path.join(temporary, 'linked');
  fs.symlinkSync(target, linkedRoot);
  assert.throws(
    () => new ProjectPriorityOutbox({ root: linkedRoot }),
    error => error.code === 'state_symlink_denied'
  );

  const root = path.join(temporary, 'real');
  const outbox = new ProjectPriorityOutbox({ root });
  const external = path.join(temporary, 'external.json');
  fs.writeFileSync(external, '{}');
  fs.symlinkSync(external, path.join(root, 'state.json'));
  assert.throws(
    () => outbox.readState(),
    error => error.code === 'state_symlink_denied'
  );
});
