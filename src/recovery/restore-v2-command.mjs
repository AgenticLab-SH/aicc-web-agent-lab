import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAiccRecovery } from '../aicc-recovery-command.mjs';
import { codexWorkGateStatus } from '../codex-work-gate.mjs';
import { processStartTokenHash } from './attempt-journal.mjs';
import { readOnlyMirrorAdapter } from './read-only-mirror.mjs';
import { createRestoreV2Candidate } from './restore-v2-candidate.mjs';

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writerIdentity() {
  const executableHash = sha256File(process.execPath);
  const startedAt = new Date(Date.now() - Math.max(0, process.uptime() * 1_000)).toISOString();
  return {
    pid: process.pid,
    processStartTokenHash: processStartTokenHash({ pid: process.pid, startedAt, executableHash }),
    executableHash
  };
}

function activitySnapshot(options = {}) {
  const gate = (options.gateStatus ?? codexWorkGateStatus)(options.gateOptions ?? {});
  return {
    readOk: gate?.readOk === true,
    generationHash: gate?.readOk === true
      ? crypto.createHash('sha256').update(`${gate.state ?? 'unknown'}:${gate.activeCount}:${gate.unknownCount}`).digest('hex')
      : null,
    domains: [{
      id: 'codex-desktop',
      active: Number.isInteger(gate?.activeCount) ? gate.activeCount : null,
      unknown: Number.isInteger(gate?.unknownCount) ? gate.unknownCount : null
    }]
  };
}

export function legacyPointerAdapter({ stateRoot }) {
  return {
    async inspect() {
      try {
        const resolved = resolveAiccRecovery({ stateRoot });
        return {
          available: true,
          current: false,
          fingerprintVerified: false,
          fingerprintHash: resolved.observedHash,
          schemaVersion: resolved.pointer.schemaVersion,
          component: resolved.pointer.component ?? null,
          operationId: resolved.pointer.operationId ?? null,
          reason: 'legacy_pointer_observed_only'
        };
      } catch (error) {
        return {
          available: false,
          current: false,
          fingerprintVerified: false,
          fingerprintHash: null,
          reason: error?.code ?? 'legacy_pointer_unavailable'
        };
      }
    },
    async backup() { throw new Error('v2_adapter_not_installed'); },
    async apply() { throw new Error('v2_adapter_not_installed'); },
    async verify() { throw new Error('v2_adapter_not_installed'); },
    async reconcile() { return { authoritative: false, effectCount: null }; },
    async rollback() { throw new Error('v2_adapter_not_installed'); },
    async verifyRollback() { throw new Error('v2_adapter_not_installed'); }
  };
}

function textResult(execution) {
  if (execution.output) return execution.output;
  const result = execution.result ?? {};
  const component = result.component ? ` ${result.component}` : '';
  return `${result.terminal ?? 'HOLD'}${component}: ${result.reason ?? 'unknown'}\n`;
}

export async function runRestoreV2Command(argv = [], options = {}) {
  const stateRoot = path.resolve(options.stateRoot
    ?? process.env.AICC_STATE_ROOT?.trim()
    ?? path.join(os.homedir(), '.ai-control-center'));
  const candidate = options.candidate ?? createRestoreV2Candidate({
    adapters: options.adapters ?? {
      'read-only-mirror': readOnlyMirrorAdapter({ home: options.home, stateRoot, codexRoot: options.codexRoot }),
      'legacy-pointer': legacyPointerAdapter({ stateRoot })
    },
    journalRoot: options.journalRoot ?? path.join(stateRoot, 'recovery', 'v2'),
    inspectGlobalActivity: options.inspectGlobalActivity ?? (() => activitySnapshot(options)),
    writerIdentity: options.writerIdentity ?? writerIdentity(),
    now: options.now,
    uuid: options.uuid,
    wait: options.wait,
    gateSamples: options.gateSamples,
    gateIntervalMs: options.gateIntervalMs
  });
  const execution = await candidate.run(argv);
  return {
    ...execution,
    output: argv.includes('--json') && execution.result
      ? `${JSON.stringify(execution.result, null, 2)}\n`
      : textResult(execution)
  };
}
