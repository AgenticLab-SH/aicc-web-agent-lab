import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AICC_RESTORE_HELP,
  createAiccRestoreService,
  parseAiccRestoreArgs,
  runAiccRestoreCli
} from '../src/aicc-restore.mjs';

function fixture(t, overrides = {}) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-restore-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const calls = [];
  const step = {
    id: 'workspace-personal',
    rollbackUnit: 'workspace-personal',
    inspect: async () => ({ needsRepair: true, fingerprintVerified: true }),
    backup: async () => ({ ok: true, rollbackUnit: 'workspace-personal', ref: 'backup' }),
    apply: async () => { calls.push('apply'); return { ok: true }; },
    verify: async () => ({ ok: true, sourceStatus: 'pass', installedStatus: 'pass', runtimeStatus: 'pass' }),
    rollback: async () => { calls.push('rollback'); return { ok: true, rollbackUnit: 'workspace-personal' }; },
    ...overrides.step
  };
  const snapshots = overrides.snapshots ?? [{ readOk: true, domains: [{ id: 'codex', active: 0 }] }];
  let snapshotIndex = 0;
  const service = createAiccRestoreService({
    stateRoot,
    profile: { schemaVersion: 1, profileId: 'aicc-core-recovery-v1', steps: [step] },
    inspectGlobalActivity: async () => snapshots[Math.min(snapshotIndex++, snapshots.length - 1)],
    gateIntervalMs: 0,
    now: (() => { let n = 0; return () => `2026-08-22T00:00:${String(n++).padStart(2, '0')}.000Z`; })(),
    uuid: () => '12345678-1234-1234-1234-123456789abc',
    processIdentity: () => ({ pid: 42, processStartToken: 'fixture' })
  });
  return { stateRoot, calls, service };
}

test('help is parsed before unknown options and needs no runtime', async () => {
  assert.equal(parseAiccRestoreArgs(['--unknown', '--help']).mode, 'help');
  let created = 0;
  const result = await runAiccRestoreCli(['--help', '--unknown'], { createService: () => { created += 1; } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, AICC_RESTORE_HELP);
  assert.equal(created, 0);
});

test('parser rejects unknown, duplicate, conflicting and relative profile options', () => {
  assert.throws(() => parseAiccRestoreArgs(['--unknown']), error => error.code === 'unknown_option');
  assert.throws(() => parseAiccRestoreArgs(['--json', '--json']), error => error.code === 'duplicate_option');
  assert.throws(() => parseAiccRestoreArgs(['--status', '--dry-run']), error => error.code === 'conflicting_mode');
  assert.throws(() => parseAiccRestoreArgs(['--profile', 'relative.json']), error => error.code === 'profile_not_absolute');
  assert.throws(() => parseAiccRestoreArgs(['--stop']), error => error.code === 'operation_id_required');
});

test('dry-run reads the gate and component but creates no files and never applies', async t => {
  const { stateRoot, calls, service } = fixture(t);
  const result = await service.dryRun();
  assert.equal(result.terminal, 'DRY_RUN');
  assert.equal(result.gate.samples.length, 5);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(stateRoot, 'recovery')), false);
});

test('active or UNKNOWN global work writes owner-only HOLD and performs no mutation', async t => {
  for (const snapshot of [
    { readOk: true, domains: [{ id: 'codex', active: 1 }] },
    { readOk: false, domains: [] }
  ]) {
    const { calls, service } = fixture(t, { snapshots: [snapshot] });
    const result = await service.execute({ operationId: `hold-${snapshot.readOk ? 'active' : 'unknown'}` });
    assert.equal(result.terminal, 'HOLD');
    assert.equal(result.reason, 'global_activity_gate');
    assert.deepEqual(calls, []);
    assert.equal(fs.statSync(result.resultPath).mode & 0o777, 0o600);
  }
});

test('exact idle applies one component after backup and records PASS', async t => {
  const order = [];
  const { service } = fixture(t, {
    step: {
      inspect: async () => { order.push('inspect'); return { needsRepair: true, fingerprintVerified: true }; },
      backup: async () => { order.push('backup'); return { ok: true, rollbackUnit: 'workspace-personal' }; },
      apply: async () => { order.push('apply'); return { ok: true }; },
      verify: async () => { order.push('verify'); return { ok: true }; },
      rollback: async () => { order.push('rollback'); return { ok: true, rollbackUnit: 'workspace-personal' }; }
    }
  });
  const result = await service.execute({ operationId: 'pass-one' });
  assert.equal(result.terminal, 'PASS');
  assert.deepEqual(order, ['inspect', 'backup', 'apply', 'verify']);
  assert.equal(result.steps[0].terminal, 'PASS');
  assert.equal(fs.statSync(result.resultPath).mode & 0o777, 0o600);
});

test('verification failure rolls back only the exact component and ends HOLD', async t => {
  const { calls, service } = fixture(t, { step: { verify: async () => ({ ok: false, reason: 'canary_failed' }) } });
  const result = await service.execute({ operationId: 'rollback-one' });
  assert.equal(result.terminal, 'HOLD');
  assert.equal(result.reason, 'component_verification_failed_rolled_back');
  assert.deepEqual(calls, ['apply', 'rollback']);
});

test('ambiguous apply is sealed as UNCERTAIN and preserves the writer marker', async t => {
  const { service } = fixture(t, { step: { apply: async () => { throw new Error('connection closed after dispatch'); } } });
  const result = await service.execute({ operationId: 'uncertain-one' });
  assert.equal(result.terminal, 'UNCERTAIN');
  assert.equal(result.reason, 'component_apply_ambiguous');
  assert.equal(fs.existsSync(service.paths.leaseFile), true);
  await assert.rejects(service.execute({ operationId: 'blind-retry' }), error => error.code === 'restore_lease_conflict');
});

test('status is read-only and stop requires an existing non-terminal operation', async t => {
  const { service } = fixture(t);
  assert.equal(service.status().operation, null);
  await assert.rejects(async () => service.requestStop('missing'), error => error.code === 'operation_missing');
});
