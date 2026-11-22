import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AICC_RECOVERY_HELP, resolveAiccRecovery, runAiccRecoveryCommand, sealAiccRecoveryPointer } from '../src/aicc-recovery-command.mjs';

function fixture(t) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-recovery-command-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const script = path.join(stateRoot, 'artifacts-private', 'run', 'restore.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true, mode: 0o700 });
  fs.writeFileSync(script, '#!/bin/bash\nexit 0\n', { mode: 0o700 });
  const pointerFile = path.join(stateRoot, 'recovery', 'aicc', 'latest.json');
  fs.mkdirSync(path.dirname(pointerFile), { recursive: true, mode: 0o700 });
  const scriptSha256 = crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex');
  fs.writeFileSync(pointerFile, `${JSON.stringify({ schemaVersion: 1, target: 'aicc-exact-component', script, scriptSha256 })}\n`, { mode: 0o600 });
  return { stateRoot, script, pointerFile };
}

test('help never resolves runtime state', () => {
  const result = runAiccRecoveryCommand(['--unknown', '--help']);
  assert.equal(result.executed, false);
  assert.match(result.output, new RegExp(AICC_RECOVERY_HELP.split('\n')[0]));
});

test('default apply uses the exact sealed script', t => {
  const f = fixture(t);
  const calls = [];
  const result = runAiccRecoveryCommand([], {
    stateRoot: f.stateRoot,
    stdio: 'ignore',
    spawnSync(executable, args) { calls.push([executable, args]); return { status: 0 }; }
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [['/bin/bash', [fs.realpathSync(f.script), 'apply']]]);
});

test('status and dry-run preserve their modes', t => {
  const f = fixture(t);
  for (const mode of ['--status', '--dry-run']) {
    let observed = null;
    const result = runAiccRecoveryCommand([mode], {
      stateRoot: f.stateRoot,
      stdio: 'ignore',
      spawnSync(executable, args) { observed = [executable, args]; return { status: 0 }; }
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(observed, ['/bin/bash', [fs.realpathSync(f.script), mode]]);
  }
});

test('an unexpected silent script failure still produces a no-replay diagnostic', t => {
  const f = fixture(t);
  const dryRun = runAiccRecoveryCommand(['--dry-run'], {
    stateRoot: f.stateRoot,
    stdio: 'ignore',
    spawnSync() { return { status: 7 }; }
  });
  assert.equal(dryRun.exitCode, 7);
  assert.match(dryRun.output, /HOLD:.*dispatch=0/);

  const apply = runAiccRecoveryCommand([], {
    stateRoot: f.stateRoot,
    stdio: 'ignore',
    spawnSync() { return { status: 7 }; }
  });
  assert.equal(apply.exitCode, 7);
  assert.match(apply.output, /UNCERTAIN:.*Do not replay/);
});

test('hash drift and scripts outside artifacts-private fail closed', t => {
  const f = fixture(t);
  fs.appendFileSync(f.script, '# drift\n');
  assert.throws(() => resolveAiccRecovery({ stateRoot: f.stateRoot }), error => error.code === 'recovery_hash_mismatch');

  const outside = path.join(f.stateRoot, 'outside.sh');
  fs.writeFileSync(outside, '#!/bin/bash\n', { mode: 0o700 });
  const hash = crypto.createHash('sha256').update(fs.readFileSync(outside)).digest('hex');
  fs.writeFileSync(f.pointerFile, `${JSON.stringify({ schemaVersion: 1, target: 'aicc-exact-component', script: outside, scriptSha256: hash })}\n`, { mode: 0o600 });
  assert.throws(() => resolveAiccRecovery({ stateRoot: f.stateRoot }), error => error.code === 'recovery_scope_denied');
});

test('sealing writes an owner-only atomic pointer with exact component identity', t => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-recovery-seal-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const script = path.join(stateRoot, 'artifacts-private', 'operation-1', 'recover.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true, mode: 0o700 });
  fs.writeFileSync(script, '#!/bin/bash\nexit 0\n', { mode: 0o700 });

  const sealed = sealAiccRecoveryPointer({
    stateRoot,
    script,
    component: 'workspace-business',
    operationId: 'operation-20260825-001',
    backup: '/owner-only/backup',
    updatedAt: '2026-08-25T00:00:00.000Z'
  });
  const resolved = resolveAiccRecovery({ stateRoot });
  assert.equal(resolved.pointer.component, 'workspace-business');
  assert.equal(resolved.pointer.operationId, 'operation-20260825-001');
  assert.equal(resolved.pointer.script, fs.realpathSync(script));
  assert.equal(resolved.pointer.scriptSha256, resolved.observedHash);
  if (process.platform !== 'win32') assert.equal(fs.statSync(sealed.pointerFile).mode & 0o077, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(sealed.pointerFile)), ['latest.json']);
});

test('sealing rejects a script outside owner artifacts and ambiguous identities', t => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-recovery-seal-deny-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const script = path.join(stateRoot, 'outside.sh');
  fs.writeFileSync(script, '#!/bin/bash\nexit 0\n', { mode: 0o700 });
  assert.throws(
    () => sealAiccRecoveryPointer({ stateRoot, script, component: 'x', operationId: 'operation-20260825-002' }),
    error => error.code === 'recovery_component_invalid'
  );
  assert.throws(
    () => sealAiccRecoveryPointer({ stateRoot, script, component: 'workspace-personal', operationId: 'operation-20260825-002' }),
    error => error.code === 'recovery_scope_denied'
  );
});
