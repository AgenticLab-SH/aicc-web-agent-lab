import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AICC_RESTORE_PROFILE_ID = 'aicc-core-recovery-v1';
export const AICC_RESTORE_HELP = `AICC 복구

Usage:
  aicc restore
  aicc restore --dry-run
  aicc restore --status [--operation-id ID]
  aicc restore --stop --operation-id ID
  aicc restore --help

기본 restore profile은 aicc-core-recovery-v1입니다. 각 failure domain을 별도 rollback
단위로 처리하며 active 또는 UNKNOWN이 있으면 아무 것도 변경하지 않고 HOLD합니다.`;

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MODES = new Map([
  ['--status', 'status'],
  ['--dry-run', 'dry-run'],
  ['--stop', 'stop']
]);
const VALUE_OPTIONS = new Set(['--operation-id', '--profile']);

export class RestoreError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

function requireSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new RestoreError('invalid_identity', `${label} is invalid`);
  }
  return value;
}

export function parseAiccRestoreArgs(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return Object.freeze({ mode: 'help', json: false, operationId: null, profileFile: null });
  }
  const seen = new Set();
  const values = { mode: 'apply', json: false, operationId: null, profileFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('-')) throw new RestoreError('unexpected_argument', `unexpected argument: ${token}`);
    if (seen.has(token)) throw new RestoreError('duplicate_option', `duplicate option: ${token}`);
    seen.add(token);
    if (token === '--json') {
      values.json = true;
      continue;
    }
    if (MODES.has(token)) {
      if (values.mode !== 'apply') throw new RestoreError('conflicting_mode', 'restore mode options are mutually exclusive');
      values.mode = MODES.get(token);
      continue;
    }
    if (VALUE_OPTIONS.has(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new RestoreError('missing_option_value', `${token} requires a value`);
      index += 1;
      if (token === '--operation-id') values.operationId = requireSafeId(value, 'operation ID');
      else {
        if (!path.isAbsolute(value)) throw new RestoreError('profile_not_absolute', '--profile must be an absolute path');
        values.profileFile = path.resolve(value);
      }
      continue;
    }
    throw new RestoreError('unknown_option', `unknown option: ${token}`);
  }
  if (values.mode === 'stop' && !values.operationId) {
    throw new RestoreError('operation_id_required', '--stop requires --operation-id');
  }
  return Object.freeze(values);
}

function ensureOwnerDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function writeCreateOnceJson(file, value) {
  ensureOwnerDirectory(path.dirname(file));
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(file, 0o600);
  fsyncDirectory(path.dirname(file));
}

function replaceOwnerJson(file, value) {
  ensureOwnerDirectory(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  fsyncDirectory(path.dirname(file));
}

function readOwnerJson(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new RestoreError('artifact_invalid', `${file} must be a regular file`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizedProfile(profile) {
  if (!profile || profile.schemaVersion !== 1 || profile.profileId !== AICC_RESTORE_PROFILE_ID) {
    throw new RestoreError('profile_invalid', `restore profile must be ${AICC_RESTORE_PROFILE_ID}`);
  }
  if (!Array.isArray(profile.steps) || profile.steps.length < 1) {
    throw new RestoreError('profile_invalid', 'restore profile must contain at least one component step');
  }
  const ids = new Set();
  for (const step of profile.steps) {
    requireSafeId(step.id, 'component ID');
    if (ids.has(step.id)) throw new RestoreError('profile_invalid', `duplicate component step: ${step.id}`);
    ids.add(step.id);
    if (step.rollbackUnit !== step.id) {
      throw new RestoreError('rollback_unit_invalid', `component ${step.id} must own its rollback unit`);
    }
    for (const capability of ['inspect', 'backup', 'apply', 'verify', 'rollback']) {
      if (typeof step[capability] !== 'function') {
        throw new RestoreError('profile_invalid', `component ${step.id} is missing ${capability}`);
      }
    }
  }
  return profile;
}

function terminalExitCode(terminal) {
  if (terminal === 'PASS' || terminal === 'DRY_RUN' || terminal === 'STATUS' || terminal === 'STOP_REQUESTED') return 0;
  if (terminal === 'HOLD') return 3;
  return 4;
}

function gateBlockers(snapshot) {
  if (!snapshot || snapshot.readOk !== true) return [{ domain: 'global', active: null, reason: 'activity_read_unknown' }];
  if (!Array.isArray(snapshot.domains) || snapshot.domains.length < 1) {
    return [{ domain: 'global', active: null, reason: 'activity_domains_missing' }];
  }
  return snapshot.domains.flatMap(domain => {
    if (!Number.isInteger(domain.active)) return [{ domain: domain.id ?? 'unknown', active: null, reason: 'active_unknown' }];
    if (domain.active !== 0) return [{ domain: domain.id ?? 'unknown', active: domain.active, reason: 'active_nonzero' }];
    return [];
  });
}

export function createAiccRestoreService({
  profile,
  inspectGlobalActivity,
  stateRoot = process.env.AICC_STATE_ROOT || path.join(os.homedir(), '.ai-control-center'),
  now = () => new Date().toISOString(),
  uuid = () => crypto.randomUUID(),
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  gateSamples = 5,
  gateIntervalMs = 2_000,
  processIdentity = () => ({ pid: process.pid, processStartToken: null })
} = {}) {
  const selectedProfile = normalizedProfile(profile);
  if (typeof inspectGlobalActivity !== 'function') throw new RestoreError('profile_invalid', 'global activity inspector is required');
  const recoveryRoot = path.join(stateRoot, 'recovery', 'v1');
  const operationsRoot = path.join(recoveryRoot, 'operations');
  const latestFile = path.join(recoveryRoot, 'latest.json');
  const leaseFile = path.join(recoveryRoot, 'restore.lock');

  function operationFiles(operationId) {
    const safe = requireSafeId(operationId, 'operation ID');
    const root = path.join(operationsRoot, safe);
    return {
      root,
      state: path.join(root, 'state.json'),
      result: path.join(root, 'result.json'),
      stop: path.join(root, 'stop-request.json')
    };
  }

  function status(operationId = null) {
    let selected = operationId;
    if (!selected) selected = readOwnerJson(latestFile)?.operationId ?? null;
    if (!selected) return { ok: true, terminal: 'STATUS', profileId: selectedProfile.profileId, operation: null };
    const files = operationFiles(selected);
    return {
      ok: true,
      terminal: 'STATUS',
      profileId: selectedProfile.profileId,
      operation: {
        operationId: selected,
        state: readOwnerJson(files.state),
        result: readOwnerJson(files.result),
        stopRequested: readOwnerJson(files.stop)
      }
    };
  }

  function requestStop(operationId) {
    const files = operationFiles(operationId);
    if (!fs.existsSync(files.state)) throw new RestoreError('operation_missing', `operation not found: ${operationId}`);
    if (fs.existsSync(files.result)) return { ok: false, terminal: 'HOLD', operationId, reason: 'operation_already_terminal' };
    if (!fs.existsSync(files.stop)) {
      writeCreateOnceJson(files.stop, { schemaVersion: 1, operationId, requestedAt: now() });
    }
    return { ok: true, terminal: 'STOP_REQUESTED', operationId, resultPath: files.stop };
  }

  async function sampleGlobalGate() {
    const samples = [];
    for (let index = 0; index < gateSamples; index += 1) {
      let snapshot;
      try { snapshot = await inspectGlobalActivity(); }
      catch (error) {
        snapshot = { readOk: false, error: error instanceof Error ? error.message : String(error), domains: [] };
      }
      const blockers = gateBlockers(snapshot);
      samples.push({ observedAt: now(), snapshot, blockers });
      if (blockers.length > 0) return { ok: false, samples, blockers };
      if (index + 1 < gateSamples && gateIntervalMs > 0) await wait(gateIntervalMs);
    }
    return { ok: true, samples, blockers: [] };
  }

  async function dryRun() {
    const gate = await sampleGlobalGate();
    const steps = [];
    for (const step of selectedProfile.steps) {
      try {
        const inspection = await step.inspect({ dryRun: true });
        steps.push({ id: step.id, rollbackUnit: step.rollbackUnit, inspection });
      } catch (error) {
        steps.push({ id: step.id, rollbackUnit: step.rollbackUnit, inspection: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { ok: gate.ok, terminal: 'DRY_RUN', profileId: selectedProfile.profileId, gate, steps };
  }

  async function execute({ operationId = null } = {}) {
    const createdOperationId = operationId ?? `restore-${now().replace(/[-:.]/g, '')}-${uuid().slice(0, 8)}`;
    requireSafeId(createdOperationId, 'operation ID');
    ensureOwnerDirectory(recoveryRoot);
    let leaseDescriptor;
    try {
      leaseDescriptor = fs.openSync(leaseFile, 'wx', 0o600);
    } catch {
      throw new RestoreError('restore_lease_conflict', 'another restore writer or reconciliation marker exists');
    }
    const files = operationFiles(createdOperationId);
    ensureOwnerDirectory(files.root);
    const started = {
      schemaVersion: 1,
      operationId: createdOperationId,
      profileId: selectedProfile.profileId,
      terminal: 'STARTED',
      startedAt: now(),
      writer: processIdentity(),
      componentOrder: selectedProfile.steps.map(step => step.id)
    };
    let preserveLease = false;
    let mutationDispatched = false;
    const stepResults = [];
    try {
      fs.writeFileSync(leaseDescriptor, `${JSON.stringify(started)}\n`);
      fs.fsyncSync(leaseDescriptor);
      replaceOwnerJson(files.state, started);
      replaceOwnerJson(latestFile, { schemaVersion: 1, operationId: createdOperationId, profileId: selectedProfile.profileId, updatedAt: now() });
      const gate = await sampleGlobalGate();
      if (!gate.ok) {
        const result = {
          ...started,
          ok: false,
          terminal: 'HOLD',
          reason: 'global_activity_gate',
          gate,
          steps: stepResults,
          completedAt: now()
        };
        writeCreateOnceJson(files.result, result);
        replaceOwnerJson(files.state, result);
        return { ...result, resultPath: files.result };
      }
      for (const step of selectedProfile.steps) {
        if (fs.existsSync(files.stop)) {
          const result = {
            ...started,
            ok: false,
            terminal: 'HOLD',
            reason: 'stop_requested_between_components',
            gate,
            steps: stepResults,
            completedAt: now()
          };
          writeCreateOnceJson(files.result, result);
          replaceOwnerJson(files.state, result);
          return { ...result, resultPath: files.result };
        }
        let inspection;
        try { inspection = await step.inspect({ operationId: createdOperationId, dryRun: false }); }
        catch (error) {
          const result = {
            ...started, ok: false, terminal: 'HOLD', reason: 'component_inspection_failed', component: step.id,
            error: error instanceof Error ? error.message : String(error), gate, steps: stepResults, completedAt: now()
          };
          writeCreateOnceJson(files.result, result);
          replaceOwnerJson(files.state, result);
          return { ...result, resultPath: files.result };
        }
        if (inspection?.needsRepair === false) {
          stepResults.push({ id: step.id, terminal: 'NOT_APPLICABLE', inspection });
          replaceOwnerJson(files.state, { ...started, terminal: 'RUNNING', currentComponent: step.id, gate, steps: stepResults, updatedAt: now() });
          continue;
        }
        if (inspection?.needsRepair !== true || inspection?.fingerprintVerified !== true) {
          const result = {
            ...started, ok: false, terminal: 'HOLD', reason: 'component_fingerprint_unproven', component: step.id,
            gate, steps: [...stepResults, { id: step.id, terminal: 'HOLD', inspection }], completedAt: now()
          };
          writeCreateOnceJson(files.result, result);
          replaceOwnerJson(files.state, result);
          return { ...result, resultPath: files.result };
        }
        const backup = await step.backup({ operationId: createdOperationId, inspection });
        if (!backup?.ok || backup?.rollbackUnit !== step.id) {
          const result = {
            ...started, ok: false, terminal: 'HOLD', reason: 'component_backup_invalid', component: step.id,
            gate, steps: [...stepResults, { id: step.id, terminal: 'HOLD', inspection, backup }], completedAt: now()
          };
          writeCreateOnceJson(files.result, result);
          replaceOwnerJson(files.state, result);
          return { ...result, resultPath: files.result };
        }
        replaceOwnerJson(files.state, {
          ...started, terminal: 'RUNNING', currentComponent: step.id, commitPoint: 'before_apply', gate,
          steps: [...stepResults, { id: step.id, terminal: 'BACKED_UP', inspection, backup }], updatedAt: now()
        });
        let applied;
        try {
          mutationDispatched = true;
          applied = await step.apply({ operationId: createdOperationId, inspection, backup });
        } catch (error) {
          preserveLease = true;
          const result = {
            ...started, ok: false, terminal: 'UNCERTAIN', reason: 'component_apply_ambiguous', component: step.id,
            error: error instanceof Error ? error.message : String(error), gate,
            steps: [...stepResults, { id: step.id, terminal: 'UNCERTAIN', inspection, backup }], completedAt: now()
          };
          writeCreateOnceJson(files.result, result);
          replaceOwnerJson(files.state, result);
          return { ...result, resultPath: files.result };
        }
        let verified;
        try { verified = await step.verify({ operationId: createdOperationId, inspection, backup, applied }); }
        catch (error) {
          preserveLease = true;
          const result = {
            ...started, ok: false, terminal: 'UNCERTAIN', reason: 'component_verify_ambiguous', component: step.id,
            error: error instanceof Error ? error.message : String(error), gate,
            steps: [...stepResults, { id: step.id, terminal: 'UNCERTAIN', inspection, backup, applied }], completedAt: now()
          };
          writeCreateOnceJson(files.result, result);
          replaceOwnerJson(files.state, result);
          return { ...result, resultPath: files.result };
        }
        if (verified?.ok !== true) {
          let rollback;
          try { rollback = await step.rollback({ operationId: createdOperationId, inspection, backup, applied, verified }); }
          catch (error) {
            preserveLease = true;
            const result = {
              ...started, ok: false, terminal: 'UNCERTAIN', reason: 'component_rollback_ambiguous', component: step.id,
              error: error instanceof Error ? error.message : String(error), gate,
              steps: [...stepResults, { id: step.id, terminal: 'UNCERTAIN', inspection, backup, applied, verified }], completedAt: now()
            };
            writeCreateOnceJson(files.result, result);
            replaceOwnerJson(files.state, result);
            return { ...result, resultPath: files.result };
          }
          const terminal = rollback?.ok === true && rollback?.rollbackUnit === step.id ? 'HOLD' : 'UNCERTAIN';
          preserveLease = terminal === 'UNCERTAIN';
          const result = {
            ...started, ok: false, terminal, reason: terminal === 'HOLD' ? 'component_verification_failed_rolled_back' : 'rollback_unverified',
            component: step.id, gate,
            steps: [...stepResults, { id: step.id, terminal, inspection, backup, applied, verified, rollback }], completedAt: now()
          };
          writeCreateOnceJson(files.result, result);
          replaceOwnerJson(files.state, result);
          return { ...result, resultPath: files.result };
        }
        stepResults.push({ id: step.id, terminal: 'PASS', inspection, backup, applied, verified });
        replaceOwnerJson(files.state, {
          ...started, terminal: 'RUNNING', currentComponent: step.id, commitPoint: 'verified', gate,
          steps: stepResults, updatedAt: now()
        });
      }
      const result = { ...started, ok: true, terminal: 'PASS', gate, steps: stepResults, completedAt: now() };
      writeCreateOnceJson(files.result, result);
      replaceOwnerJson(files.state, result);
      return { ...result, resultPath: files.result };
    } catch (error) {
      if (mutationDispatched) preserveLease = true;
      throw error;
    } finally {
      fs.closeSync(leaseDescriptor);
      if (!preserveLease) {
        try { fs.unlinkSync(leaseFile); fsyncDirectory(recoveryRoot); } catch { /* already removed */ }
      }
    }
  }

  return { status, requestStop, dryRun, execute, paths: { recoveryRoot, operationsRoot, latestFile, leaseFile } };
}

export async function runAiccRestoreCli(argv, dependencies = {}) {
  const parsed = parseAiccRestoreArgs(argv);
  if (parsed.mode === 'help') return { exitCode: 0, output: AICC_RESTORE_HELP, result: null };
  if (typeof dependencies.createService !== 'function') {
    throw new RestoreError('restore_runtime_missing', 'restore runtime is not configured');
  }
  const service = await dependencies.createService({ profileFile: parsed.profileFile });
  const result = parsed.mode === 'status' ? service.status(parsed.operationId)
    : parsed.mode === 'stop' ? service.requestStop(parsed.operationId)
      : parsed.mode === 'dry-run' ? await service.dryRun()
        : await service.execute({ operationId: parsed.operationId });
  const output = parsed.json ? `${JSON.stringify(result, null, 2)}\n`
    : `${result.terminal}: ${result.reason ?? result.profileId ?? AICC_RESTORE_PROFILE_ID}${result.resultPath ? `\nresult: ${result.resultPath}` : ''}\n`;
  return { exitCode: terminalExitCode(result.terminal), output, result };
}
