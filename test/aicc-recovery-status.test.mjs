import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sealAiccRecoveryPointer } from '../src/aicc-recovery-command.mjs';
import { aiccRecoveryStatus } from '../src/aicc-recovery-status.mjs';

function fixture(t) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-recovery-status-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const script = path.join(stateRoot, 'artifacts-private', 'operation', 'recover.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true, mode: 0o700 });
  fs.writeFileSync(script, '#!/bin/bash\nexit 0\n', { mode: 0o700 });
  sealAiccRecoveryPointer({ stateRoot, script, component: 'dashboard', operationId: 'operation-20260825-status' });
  return { stateRoot, script };
}

test('missing pointer remains UNKNOWN instead of becoming ready', t => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-recovery-status-missing-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const status = aiccRecoveryStatus({
    stateRoot,
    gateStatus: () => ({ readOk: true, exactIdle: true, activeCount: 0, unknownCount: 0 })
  });
  assert.equal(status.available, false);
  assert.equal(status.state, 'unknown');
});

test('active Codex work permits status but never dry-run', t => {
  const { stateRoot } = fixture(t);
  const calls = [];
  const status = aiccRecoveryStatus({
    stateRoot,
    gateStatus: () => ({ readOk: true, exactIdle: false, activeCount: 1, unknownCount: 0 }),
    spawnSync(_command, args) { calls.push(args.at(-1)); return { status: 0, stdout: 'READY\n', stderr: '' }; }
  });
  assert.equal(status.state, 'hold');
  assert.equal(status.reason, 'codex_not_idle');
  assert.deepEqual(calls, ['--status']);
  assert.equal(status.dryRun, null);
});

test('exact idle plus status and dry-run exposes a ready one-shot', t => {
  const { stateRoot } = fixture(t);
  const calls = [];
  const status = aiccRecoveryStatus({
    stateRoot,
    gateStatus: () => ({ readOk: true, exactIdle: true, activeCount: 0, unknownCount: 0 }),
    spawnSync(_command, args) { calls.push(args.at(-1)); return { status: 0, stdout: 'READY\n', stderr: '' }; }
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.reason, 'exact_component_ready');
  assert.deepEqual(calls, ['--status', '--dry-run']);
});

test('unknown gate fails closed without dry-run', t => {
  const { stateRoot } = fixture(t);
  const calls = [];
  const status = aiccRecoveryStatus({
    stateRoot,
    gateStatus: () => ({ readOk: false, exactIdle: false, activeCount: null, unknownCount: null }),
    spawnSync(_command, args) { calls.push(args.at(-1)); return { status: 0, stdout: 'READY\n', stderr: '' }; }
  });
  assert.equal(status.state, 'unknown');
  assert.deepEqual(calls, ['--status']);
});

test('applied recovery is terminal and never becomes retryable', t => {
  const { stateRoot } = fixture(t);
  const calls = [];
  const status = aiccRecoveryStatus({
    stateRoot,
    gateStatus: () => ({ readOk: true, exactIdle: true, activeCount: 0, unknownCount: 0 }),
    spawnSync(_command, args) {
      calls.push(args.at(-1));
      return { status: 0, stdout: '{"state":"applied"}\n', stderr: '' };
    }
  });
  assert.equal(status.state, 'applied');
  assert.equal(status.reason, 'exact_component_recovery_applied');
  assert.equal(status.dryRun, null);
  assert.deepEqual(calls, ['--status']);
});
