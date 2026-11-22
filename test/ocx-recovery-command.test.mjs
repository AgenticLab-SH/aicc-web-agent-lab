import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OCX_RECOVERY_HELP, resolveOcxRecovery, runOcxRecoveryCommand } from '../src/ocx-recovery-command.mjs';

function fixture(t) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ocx-recovery-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const artifactsRoot = path.join(stateRoot, 'artifacts-private', 'ocx-plan');
  const pointerRoot = path.join(stateRoot, 'recovery', 'ocx');
  fs.mkdirSync(artifactsRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(pointerRoot, { recursive: true, mode: 0o700 });
  const script = path.join(artifactsRoot, 'restore.sh');
  fs.writeFileSync(script, '#!/bin/bash\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(path.join(pointerRoot, 'latest.json'), `${JSON.stringify({ schemaVersion: 1, target: 'ocx-10100', script })}\n`, { mode: 0o600 });
  return { stateRoot, script };
}

test('help needs no recovery pointer and defaults to a concise command', () => {
  const result = runOcxRecoveryCommand(['--help'], { stateRoot: '/missing' });
  assert.equal(result.output, OCX_RECOVERY_HELP);
  assert.equal(result.executed, false);
});

test('aicc restore ocx defaults to applying the exact owner recovery script', t => {
  const { stateRoot, script } = fixture(t);
  const calls = [];
  const result = runOcxRecoveryCommand([], {
    stateRoot,
    stdio: 'ignore',
    spawnSync: (command, args) => { calls.push([command, args]); return { status: 0 }; }
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [['/bin/bash', [fs.realpathSync(script), '--apply']]]);
});

test('pointer cannot escape artifacts-private', t => {
  const { stateRoot } = fixture(t);
  const outside = path.join(stateRoot, 'outside.sh');
  fs.writeFileSync(outside, '#!/bin/bash\n', { mode: 0o700 });
  fs.writeFileSync(path.join(stateRoot, 'recovery', 'ocx', 'latest.json'), `${JSON.stringify({ schemaVersion: 1, target: 'ocx-10100', script: outside })}\n`, { mode: 0o600 });
  assert.throws(() => resolveOcxRecovery({ stateRoot }), error => error.code === 'ocx_recovery_scope_denied');
});

test('unknown and conflicting recovery options are rejected', () => {
  assert.throws(() => runOcxRecoveryCommand(['--status', '--dry-run']), error => error.code === 'invalid_ocx_restore_option');
  assert.throws(() => runOcxRecoveryCommand(['--unknown']), error => error.code === 'invalid_ocx_restore_option');
});
