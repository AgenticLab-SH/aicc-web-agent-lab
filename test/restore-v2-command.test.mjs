import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sealAiccRecoveryPointer } from '../src/aicc-recovery-command.mjs';
import { runRestoreV2Command } from '../src/recovery/restore-v2-command.mjs';

function fixture(t) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-restore-v2-command-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const script = path.join(stateRoot, 'artifacts-private', 'op', 'recover.sh');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '#!/bin/bash\nexit 0\n');
  sealAiccRecoveryPointer({ stateRoot, script, component: 'dashboard', operationId: 'operation-v1-pointer' });
  return { stateRoot };
}

test('no-argument v2 restore is read-only inventory and creates no journal', async t => {
  const { stateRoot } = fixture(t);
  const result = await runRestoreV2Command([], { stateRoot });
  assert.equal(result.exitCode, 0);
  assert.equal(result.result.terminal, 'STATUS');
  assert.equal(result.result.statuses['legacy-pointer'].reason, 'legacy_pointer_observed_only');
  assert.equal(fs.existsSync(path.join(stateRoot, 'recovery', 'v2')), false);
});

test('legacy pointer dry-run is explicit HOLD and never executes the script', async t => {
  const { stateRoot } = fixture(t);
  const result = await runRestoreV2Command(['legacy-pointer', '--dry-run'], {
    stateRoot,
    gateSamples: 1,
    gateIntervalMs: 0,
    gateStatus: () => ({ readOk: true, generatedAt: '2026-09-17T00:00:00.000Z', activeCount: 0, unknownCount: 0 }),
    writerIdentity: { pid: 1, processStartTokenHash: 'a'.repeat(64) }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.result.terminal, 'DRY_RUN');
  assert.equal(result.result.reason, 'adapter_not_ready');
});

test('apply is blocked before backup when v2 adapter is not installed', async t => {
  const { stateRoot } = fixture(t);
  const result = await runRestoreV2Command([
    'legacy-pointer', '--apply', '--operation-id', 'op-v2-hold', '--attempt-id', 'attempt-1'
  ], {
    stateRoot,
    gateSamples: 1,
    gateIntervalMs: 0,
    gateStatus: () => ({ readOk: true, generatedAt: '2026-09-17T00:00:00.000Z', activeCount: 0, unknownCount: 0 }),
    writerIdentity: { pid: 1, processStartTokenHash: 'a'.repeat(64) }
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.result.reason, 'fingerprint_unproven');
});
