import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { resolveAiccRecovery } from './aicc-recovery-command.mjs';
import { codexWorkGateStatus } from './codex-work-gate.mjs';
import { redactText } from './lib/redact.mjs';

function runMode(script, mode, spawn = spawnSync) {
  const result = spawn('/bin/bash', [script, mode], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 256_000
  });
  const output = redactText(String(result.stdout || result.stderr || '').trim()).slice(0, 1_000);
  return {
    ready: result.status === 0 && !result.error,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    summary: output || (result.status === 0 ? 'READY' : 'HOLD')
  };
}

export function aiccRecoveryStatus(options = {}) {
  const stateRoot = options.stateRoot
    ?? process.env.AICC_STATE_ROOT?.trim()
    ?? path.join(os.homedir(), '.ai-control-center');
  const gate = (options.gateStatus ?? codexWorkGateStatus)(options.gateOptions ?? {});
  let resolved;
  try { resolved = resolveAiccRecovery({ stateRoot }); }
  catch (error) {
    return {
      ok: true,
      available: false,
      state: 'unknown',
      reason: error?.code ?? 'recovery_pointer_unknown',
      component: null,
      operationId: null,
      pointerSha256: null,
      status: null,
      dryRun: null,
      gate: {
        readOk: gate?.readOk === true,
        exactIdle: gate?.exactIdle === true,
        activeCount: Number.isInteger(gate?.activeCount) ? gate.activeCount : null,
        unknownCount: Number.isInteger(gate?.unknownCount) ? gate.unknownCount : null
      }
    };
  }
  const status = runMode(resolved.script, '--status', options.spawnSync);
  const applied = status.ready && /"state"\s*:\s*"applied"/.test(status.summary);
  const gateSnapshot = {
    readOk: gate?.readOk === true,
    exactIdle: gate?.exactIdle === true,
    activeCount: Number.isInteger(gate?.activeCount) ? gate.activeCount : null,
    unknownCount: Number.isInteger(gate?.unknownCount) ? gate.unknownCount : null
  };
  const dryRun = gateSnapshot.exactIdle && status.ready && !applied
    ? runMode(resolved.script, '--dry-run', options.spawnSync)
    : null;
  const ready = status.ready && gateSnapshot.exactIdle && dryRun?.ready === true;
  return {
    ok: true,
    available: true,
    state: applied ? 'applied' : ready ? 'ready' : gateSnapshot.readOk ? 'hold' : 'unknown',
    reason: applied ? 'exact_component_recovery_applied' : ready ? 'exact_component_ready' : !status.ready ? 'recovery_status_hold' : !gateSnapshot.exactIdle ? 'codex_not_idle' : 'recovery_dry_run_hold',
    component: resolved.pointer.component ?? null,
    operationId: resolved.pointer.operationId ?? null,
    updatedAt: resolved.pointer.updatedAt ?? null,
    pointerSha256: resolved.observedHash,
    status,
    dryRun,
    gate: gateSnapshot
  };
}
