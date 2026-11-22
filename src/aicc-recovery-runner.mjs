#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolveAiccRecovery } from './aicc-recovery-command.mjs';

const requested = process.argv[2] ?? 'apply';
const modes = new Map([
  ['apply', 'apply'],
  ['status', '--status'],
  ['dry-run', '--dry-run']
]);

if (!modes.has(requested)) {
  process.stderr.write('aicc-recovery-runner: mode must be apply, status, or dry-run\n');
  process.exitCode = 2;
} else {
  try {
    const resolved = resolveAiccRecovery();
    const result = spawnSync('/bin/bash', [resolved.script, modes.get(requested)], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = Number.isInteger(result.status) ? result.status : 4;
  } catch (error) {
    process.stderr.write(`aicc-recovery-runner: ${error?.code ?? 'ERROR'}: ${error.message}\n`);
    process.exitCode = 3;
  }
}
