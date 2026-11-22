import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { processStartTokenHash } from '../src/recovery/attempt-journal.mjs';
import { RESTORE_V2_HELP, createRestoreV2Candidate, parseRestoreV2Args } from '../src/recovery/restore-v2-candidate.mjs';

function fixture(t, overrides = {}) {
  const journalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-restore-v2-'));
  t.after(() => fs.rmSync(journalRoot, { recursive: true, force: true }));
  const calls = [];
  const adapter = {
    inspect: async ({ mode }) => { calls.push(`inspect:${mode}`); return { current: false, fingerprintVerified: true, fingerprintHash: 'a'.repeat(64) }; },
    backup: async () => { calls.push('backup'); return { verified: true, backupRefHash: 'b'.repeat(64) }; },
    apply: async () => { calls.push('apply'); return { acknowledged: true, dispatchIdentityHash: 'c'.repeat(64) }; },
    verify: async () => { calls.push('verify'); return { ok: true, generationCurrent: true }; },
    reconcile: async () => { calls.push('reconcile'); return { authoritative: true, effectCount: 1 }; },
    rollback: async () => { calls.push('rollback'); return { acknowledged: true }; },
    verifyRollback: async () => { calls.push('verifyRollback'); return { ok: true }; },
    ...overrides.adapter
  };
  const snapshots = overrides.snapshots ?? [{ readOk: true, generationHash: 'd'.repeat(64), domains: [{ id: 'all', active: 0, unknown: 0 }] }];
  let snapshotIndex = 0;
  const candidate = createRestoreV2Candidate({
    adapters: { 'router-17841': adapter },
    journalRoot,
    inspectGlobalActivity: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
    writerIdentity: { pid: 42, processStartTokenHash: processStartTokenHash({ pid: 42, startedAt: '2026-08-24T00:00:00.000Z' }) },
    gateIntervalMs: 0,
    now: (() => { let tick = 0; return () => `2026-08-24T00:00:${String(tick++).padStart(2, '0')}.000Z`; })(),
    uuid: () => '12345678-1234-1234-1234-123456789abc'
  });
  return { candidate, calls, journalRoot };
}

test('help is handled before parser and no-argument status is read-only', async t => {
  const { candidate, calls, journalRoot } = fixture(t);
  const help = await candidate.run(['--unknown', '--help']);
  assert.equal(help.output, `${RESTORE_V2_HELP}\n`);
  const status = await candidate.run([]);
  assert.equal(status.result.terminal, 'STATUS');
  assert.deepEqual(calls, ['inspect:status']);
  assert.equal(fs.existsSync(path.join(journalRoot, 'operations')), false);
});

test('strict parser rejects ambiguity and journals parse failure without component dispatch', async t => {
  assert.throws(() => parseRestoreV2Args(['router-17841', '--apply']), error => error.code === 'attempt_identity_required');
  assert.throws(() => parseRestoreV2Args(['router-17841', '--status', '--dry-run']), error => error.code === 'conflicting_mode');
  const { candidate, calls, journalRoot } = fixture(t);
  const result = await candidate.run(['router-17841', '--unknown']);
  assert.equal(result.exitCode, 2);
  assert.equal(result.result.terminal, 'HOLD_PRE_DISPATCH');
  assert.deepEqual(calls, []);
  assert.equal(fs.readdirSync(path.join(journalRoot, 'operations', 'restore-parse-failure', 'attempts')).length, 1);
});

test('active or UNKNOWN gate records HOLD before backup and dispatch', async t => {
  for (const snapshot of [
    { readOk: true, domains: [{ id: 'codex', active: 1, unknown: 0 }] },
    { readOk: false, domains: [] }
  ]) {
    const { candidate, calls } = fixture(t, { snapshots: [snapshot] });
    const result = await candidate.run(['router-17841', '--apply', '--operation-id', `op-${snapshot.readOk ? 'active' : 'unknown'}`, '--attempt-id', 'attempt-1']);
    assert.equal(result.result.terminal, 'HOLD_PRE_DISPATCH');
    assert.deepEqual(calls, []);
  }
});

test('exact idle apply is one component backup-dispatch-post-read with a terminal chain', async t => {
  const { candidate, calls, journalRoot } = fixture(t);
  const result = await candidate.run(['router-17841', '--apply', '--operation-id', 'op-pass', '--attempt-id', 'attempt-1']);
  assert.equal(result.result.terminal, 'PASS');
  assert.deepEqual(calls, ['inspect:apply', 'backup', 'apply', 'verify']);
  const eventRoot = path.join(journalRoot, 'operations', 'op-pass', 'attempts', 'attempt-1', 'events');
  const events = fs.readdirSync(eventRoot).sort().map(name => JSON.parse(fs.readFileSync(path.join(eventRoot, name), 'utf8')));
  assert.equal(events.at(-1).metadata.terminal, 'PASS');
  assert.equal(events.filter(event => event.type === 'dispatch_reserved').length, 1);
});

test('ambiguous apply never retries and only the same attempt may reconcile authoritative effect', async t => {
  const { candidate, calls } = fixture(t, { adapter: { apply: async () => { calls.push('apply'); throw new Error('lost ack'); } } });
  const args = ['router-17841', '--apply', '--operation-id', 'op-uncertain', '--attempt-id', 'attempt-1'];
  const applied = await candidate.run(args);
  assert.equal(applied.result.terminal, 'RECONCILE_REQUIRED');
  assert.deepEqual(calls, ['inspect:apply', 'backup', 'apply']);

  const replay = await candidate.run(args);
  assert.equal(replay.result.terminal, 'RECONCILE_REQUIRED');
  assert.deepEqual(calls, ['inspect:apply', 'backup', 'apply']);

  const reconciled = await candidate.run(['router-17841', '--reconcile', '--operation-id', 'op-uncertain', '--attempt-id', 'attempt-1']);
  assert.equal(reconciled.result.terminal, 'PASS');
  assert.deepEqual(calls, ['inspect:apply', 'backup', 'apply', 'reconcile']);

  const fresh = fixture(t);
  const missing = await fresh.candidate.run(['router-17841', '--reconcile', '--operation-id', 'op-missing', '--attempt-id', 'attempt-1']);
  assert.equal(missing.result.reason, 'reconcile_evidence_missing');
  assert.deepEqual(fresh.calls, []);
});
