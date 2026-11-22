import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const MAX_CHANGES = 20;
const MAX_CHANGE_BYTES = 1_048_576;
const MAX_TOTAL_CHANGE_BYTES = 4_194_304;
const MAX_VERIFICATIONS = 3;
const MAX_VERIFICATION_PATHS = 20;
const MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 120_000;
const TERMINAL_PHASES = new Set(['VERIFIED', 'ROLLED_BACK', 'CANDIDATE_FAILED', 'HOLD_EXTERNAL_DRIFT']);

export class WorkspaceChangeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceChangeError';
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function ensureOwnerDirectory(directory) {
  const current = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (current && (current.isSymbolicLink() || !current.isDirectory())) {
    throw new WorkspaceChangeError('owner_state_invalid', `workspace transaction directory is unsafe: ${directory}`);
  }
  if (current && typeof process.getuid === 'function' && current.uid !== process.getuid()) {
    throw new WorkspaceChangeError('owner_state_invalid', `workspace transaction directory belongs to another user: ${directory}`);
  }
  if (!current) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function readOwnerJson(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()
    || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new WorkspaceChangeError('owner_state_invalid', `workspace transaction file is missing or unsafe: ${file}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new WorkspaceChangeError('owner_state_invalid', `workspace transaction file belongs to another user: ${file}`);
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new WorkspaceChangeError('owner_state_invalid', `workspace transaction JSON is invalid: ${path.basename(file)}`); }
}

function writeOwnerAtomic(file, bytes) {
  ensureOwnerDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

function writeOwnerJsonAtomic(file, value) {
  writeOwnerAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function currentIso(now) {
  const value = now();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function currentMs(now) {
  const value = now();
  return value instanceof Date ? value.getTime() : Number(value);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function strictBase64(value) {
  if (typeof value !== 'string' || value.length > MAX_CHANGE_BYTES * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new WorkspaceChangeError('change_content_invalid', 'write_text contentBase64 must be canonical bounded base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length > MAX_CHANGE_BYTES) {
    throw new WorkspaceChangeError('change_content_invalid', `write_text content exceeds ${MAX_CHANGE_BYTES} bytes`);
  }
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new WorkspaceChangeError('change_content_invalid', 'write_text content must be valid UTF-8'); }
  if (bytes.includes(0)) throw new WorkspaceChangeError('change_content_invalid', 'write_text content contains a NUL byte');
  return bytes;
}

function boundedTimeout(value) {
  const selected = value === undefined ? DEFAULT_TIMEOUT_MS : Number(value);
  if (!Number.isInteger(selected) || selected < 1_000 || selected > DEFAULT_TIMEOUT_MS) {
    throw new WorkspaceChangeError('verification_invalid', `verification timeout must be 1000 to ${DEFAULT_TIMEOUT_MS} ms`);
  }
  return selected;
}

function validateVerification(steps, inspectTarget, root, manifest, changes) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_VERIFICATIONS) {
    throw new WorkspaceChangeError('verification_invalid', `change plan requires 1 to ${MAX_VERIFICATIONS} verification steps`);
  }
  const changedPaths = new Set(changes.map(item => item.path));
  return steps.map(step => {
    if (step?.type === 'node_test') {
      if (!Array.isArray(step.paths) || step.paths.length < 1 || step.paths.length > MAX_VERIFICATION_PATHS) {
        throw new WorkspaceChangeError('verification_invalid', `node_test requires 1 to ${MAX_VERIFICATION_PATHS} paths`);
      }
      const paths = [...new Set(step.paths.map(item => inspectTarget(root, manifest, item, { requireSnapshotMember: true }).path))];
      if (paths.some(item => changedPaths.has(item))) {
        throw new WorkspaceChangeError('verification_invalid', 'verification test files cannot change in the same plan');
      }
      return { type: 'node_test', paths, timeoutMs: boundedTimeout(step.timeoutMs) };
    }
    if (step?.type === 'package_script') {
      if (changedPaths.has('package.json')) {
        throw new WorkspaceChangeError('verification_invalid', 'package.json cannot change in the same plan that verifies a captured package script');
      }
      const script = String(step.script ?? '');
      if (!/^[A-Za-z0-9:_-]{1,100}$/.test(script)) throw new WorkspaceChangeError('verification_invalid', 'package_script name is invalid');
      const packageFile = inspectTarget(root, manifest, 'package.json', { requireSnapshotMember: true });
      const parsed = JSON.parse(fs.readFileSync(packageFile.resolved, 'utf8'));
      const command = parsed?.scripts?.[script];
      if (typeof command !== 'string' || command.length < 1 || command.length > 4_096) {
        throw new WorkspaceChangeError('verification_invalid', `package script does not exist or is not bounded: ${script}`);
      }
      return {
        type: 'package_script',
        manager: 'npm',
        script,
        packageJsonSha256: packageFile.sha256,
        commandSha256: sha256(command),
        timeoutMs: boundedTimeout(step.timeoutMs),
      };
    }
    throw new WorkspaceChangeError('verification_invalid', `verification type is not allowlisted: ${String(step?.type)}`);
  });
}

function quoteSeatbelt(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function allowedRuntimeReads(extra = []) {
  const candidates = ['/System', '/usr', '/bin', '/sbin', '/opt/homebrew', '/Library', '/private/var/db', '/dev', ...extra];
  candidates.push(path.dirname(path.dirname(fs.realpathSync(process.execPath))));
  return [...new Set(candidates.filter(item => fs.existsSync(item)).map(item => fs.realpathSync(item)))];
}

function ownerScratchAncestorMetadata(root, home) {
  const resolvedRoot = fs.realpathSync(root);
  const resolvedHome = fs.realpathSync(home);
  if (resolvedRoot === resolvedHome || !resolvedRoot.startsWith(`${resolvedHome}${path.sep}`)) return [];
  const ancestors = [];
  let current = path.dirname(resolvedRoot);
  while (current === resolvedHome || current.startsWith(`${resolvedHome}${path.sep}`)) {
    ancestors.push(current);
    if (current === resolvedHome) break;
    current = path.dirname(current);
  }
  return ancestors.reverse();
}

function sandboxProfile(root, extraReads = []) {
  const home = fs.realpathSync(os.homedir());
  const ancestorMetadata = ownerScratchAncestorMetadata(root, home);
  const reads = [root, ...allowedRuntimeReads(extraReads)];
  const writes = [root, '/private/tmp', '/tmp'].filter(item => fs.existsSync(item));
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-read* (subpath ${quoteSeatbelt(home)}))`,
    '(deny file-write*)',
    ...ancestorMetadata.map(item => `(allow file-read-metadata (literal ${quoteSeatbelt(item)}))`),
    ...reads.map(item => `(allow file-read* (subpath ${quoteSeatbelt(fs.realpathSync(item))}))`),
    ...writes.map(item => `(allow file-write* (subpath ${quoteSeatbelt(fs.realpathSync(item))}))`),
    '(deny network*)',
  ].join('\n');
}

function verificationEnvironment(root) {
  return {
    PATH: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', path.dirname(process.execPath)].filter(item => fs.existsSync(item)).join(':'),
    HOME: root,
    TMPDIR: '/private/tmp',
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8',
    CI: '1',
    NO_COLOR: '1',
    AICC_OFFLINE_VERIFICATION: '1',
  };
}

function summarizeExecution(step, result, startedAt, endedAt) {
  const stdout = Buffer.from(result.stdout ?? '');
  const stderr = Buffer.from(result.stderr ?? '');
  return {
    type: step.type,
    selector: step.type === 'node_test' ? step.paths : [step.script],
    exitCode: result.status,
    signal: result.signal ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    durationMs: endedAt - startedAt,
    stdoutBytes: stdout.length,
    stdoutSha256: sha256(stdout),
    stderrBytes: stderr.length,
    stderrSha256: sha256(stderr),
    passed: result.status === 0,
  };
}

export function runSandboxedVerification({ root, sourceRoot, steps, now = () => Date.now() }) {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) {
    throw new WorkspaceChangeError('verification_runner_unavailable', 'workspace change verification requires macOS sandbox-exec');
  }
  const sourceModules = path.join(sourceRoot, 'node_modules');
  const scratchModules = path.join(root, 'node_modules');
  if (fs.existsSync(sourceModules) && !fs.existsSync(scratchModules)) fs.symlinkSync(fs.realpathSync(sourceModules), scratchModules, 'dir');
  const extraReads = fs.existsSync(sourceModules) ? [sourceModules] : [];
  const profile = sandboxProfile(root, extraReads);
  const results = [];
  for (const step of steps) {
    if (step.type === 'package_script') {
      const packageBytes = fs.readFileSync(path.join(root, 'package.json'));
      const parsed = JSON.parse(packageBytes.toString('utf8'));
      const command = parsed?.scripts?.[step.script];
      if (sha256(packageBytes) !== step.packageJsonSha256 || sha256(String(command ?? '')) !== step.commandSha256) {
        throw new WorkspaceChangeError('verification_drift', `captured package script changed before verification: ${step.script}`);
      }
    }
    const executable = step.type === 'node_test' ? process.execPath : '/usr/bin/env';
    const args = step.type === 'node_test' ? ['--test', ...step.paths] : ['npm', 'run', '--silent', step.script];
    const startedAt = currentMs(now);
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, executable, ...args], {
      cwd: root,
      env: verificationEnvironment(root),
      encoding: 'utf8',
      timeout: step.timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    const summary = summarizeExecution(step, result, startedAt, currentMs(now));
    results.push(summary);
    if (!summary.passed) break;
  }
  return { passed: results.length === steps.length && results.every(item => item.passed), results, networkAllowed: false, rawOutputStored: false };
}

function confinedTarget(root, relativePath, { allowMissing = true } = {}) {
  if (typeof relativePath !== 'string' || relativePath.length < 1 || relativePath.length > 16_384 || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
    throw new WorkspaceChangeError('change_path_invalid', 'change path must be a bounded relative path');
  }
  const normalized = path.normalize(relativePath).replaceAll(path.sep, '/').replace(/^\.\//, '');
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) throw new WorkspaceChangeError('change_path_escape', 'change path escapes the workspace');
  const segments = normalized.split('/');
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = path.join(current, segments[index]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new WorkspaceChangeError('change_parent_invalid', `change parent is missing or unsafe: ${normalized}`);
  }
  const resolved = path.join(root, ...segments);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new WorkspaceChangeError('change_symlink_denied', `change target is a symlink: ${normalized}`);
  if (stat && !stat.isFile()) throw new WorkspaceChangeError('change_target_invalid', `change target is not a regular file: ${normalized}`);
  if (!stat && !allowMissing) throw new WorkspaceChangeError('change_target_missing', `change target is missing: ${normalized}`);
  return { path: normalized, resolved, exists: Boolean(stat), stat };
}

function atomicTargetWrite(target, bytes, mode) {
  const temporary = path.join(path.dirname(target), `.aicc-change-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx', mode);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, target);
}

function copyTree(source, destination) {
  ensureOwnerDirectory(destination);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(destination, entry.name);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) throw new WorkspaceChangeError('change_symlink_denied', `candidate source contains a symlink: ${entry.name}`);
    if (stat.isDirectory()) {
      copyTree(sourcePath, targetPath);
    } else if (stat.isFile()) {
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(targetPath, stat.mode & 0o111 ? 0o700 : 0o600);
    } else {
      throw new WorkspaceChangeError('change_target_invalid', `candidate source contains a special entry: ${entry.name}`);
    }
  }
}

export class WorkspaceChangeTransactionService {
  constructor({
    stateRoot,
    resolveSnapshot,
    materialize,
    inspectTarget,
    validateContent,
    now = () => Date.now(),
    pid = process.pid,
    lockStaleMs = 60_000,
    isProcessAlive = processIsAlive,
    verificationRunner = runSandboxedVerification,
    crashPoint = null,
  } = {}) {
    if (!path.isAbsolute(stateRoot ?? '')) throw new WorkspaceChangeError('owner_state_invalid', 'workspace transaction stateRoot must be absolute');
    if (typeof resolveSnapshot !== 'function' || typeof materialize !== 'function' || typeof inspectTarget !== 'function' || typeof validateContent !== 'function') {
      throw new WorkspaceChangeError('transaction_adapter_invalid', 'workspace transaction adapters are incomplete');
    }
    this.root = path.join(stateRoot, 'transactions');
    this.writerRoot = path.join(stateRoot, 'writers');
    this.resolveSnapshot = resolveSnapshot;
    this.materialize = materialize;
    this.inspectTarget = inspectTarget;
    this.validateContent = validateContent;
    this.now = now;
    this.pid = pid;
    this.lockStaleMs = lockStaleMs;
    this.isProcessAlive = isProcessAlive;
    this.verificationRunner = verificationRunner;
    this.crashPoint = crashPoint;
    ensureOwnerDirectory(this.root);
    ensureOwnerDirectory(this.writerRoot);
  }

  plan({ snapshotId, changes, verification }) {
    const { manifest, root } = this.resolveSnapshot(snapshotId);
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > MAX_CHANGES) {
      throw new WorkspaceChangeError('changes_invalid', `change plan requires 1 to ${MAX_CHANGES} changes`);
    }
    const prepared = [];
    const payloads = [];
    let totalBytes = 0;
    const names = new Set();
    for (let index = 0; index < changes.length; index += 1) {
      const change = changes[index];
      if (!['write_text', 'delete'].includes(change?.type)) throw new WorkspaceChangeError('change_type_denied', `change type is not allowlisted: ${String(change?.type)}`);
      const current = this.inspectTarget(root, manifest, change.path, { allowMissing: change.type === 'write_text' });
      if (names.has(current.path)) throw new WorkspaceChangeError('change_duplicate_path', `change path appears more than once: ${current.path}`);
      names.add(current.path);
      if (change.expectedSha256 !== undefined && change.expectedSha256 !== current.sha256) {
        throw new WorkspaceChangeError('change_precondition_mismatch', `caller expected hash differs for ${current.path}`);
      }
      if (change.type === 'delete') {
        if (!current.exists) throw new WorkspaceChangeError('change_target_missing', `delete target is missing: ${current.path}`);
        prepared.push({ type: 'delete', path: current.path, expectedSha256: current.sha256, desiredSha256: null, bytes: 0, mode: current.mode });
        payloads.push(null);
        continue;
      }
      const bytes = strictBase64(change.contentBase64);
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_CHANGE_BYTES) throw new WorkspaceChangeError('change_content_invalid', `change payloads exceed ${MAX_TOTAL_CHANGE_BYTES} bytes`);
      this.validateContent(bytes, current.path);
      prepared.push({
        type: 'write_text',
        path: current.path,
        expectedSha256: current.sha256,
        desiredSha256: sha256(bytes),
        bytes: bytes.length,
        mode: current.exists ? current.mode : 0o600,
      });
      payloads.push(bytes);
    }
    const verifiedSteps = validateVerification(verification, this.inspectTarget, root, manifest, prepared);
    const identity = {
      schemaVersion: SCHEMA_VERSION,
      snapshotId,
      workspaceId: manifest.workspaceId,
      head: manifest.head,
      preconditionHash: manifest.snapshotId.slice('snapshot_'.length),
      desiredHash: sha256(stableJson(prepared.map(item => ({ type: item.type, path: item.path, desiredSha256: item.desiredSha256 })))),
      policyHash: manifest.policyHash,
      changes: prepared,
      verification: verifiedSteps,
    };
    const requestHash = sha256(stableJson(identity));
    const operationId = `change_${requestHash}`;
    const core = {
      ...identity,
      requestHash,
      createdAt: currentIso(this.now),
    };
    const planHash = sha256(stableJson(core));
    const plan = { ...core, operationId, planHash };
    const directory = this.#operationRoot(operationId);
    if (fs.existsSync(directory)) {
      const existing = this.#readPlan(operationId);
      if (existing.requestHash !== requestHash) throw new WorkspaceChangeError('operation_id_conflict', 'existing operationId has a different request hash');
      return { plan: existing, duplicate: true };
    }
    const temporary = fs.mkdtempSync(path.join(this.root, '.plan-'));
    fs.chmodSync(temporary, 0o700);
    try {
      ensureOwnerDirectory(path.join(temporary, 'payloads'));
      ensureOwnerDirectory(path.join(temporary, 'states'));
      ensureOwnerDirectory(path.join(temporary, 'backups'));
      payloads.forEach((bytes, index) => {
        if (bytes) writeOwnerAtomic(path.join(temporary, 'payloads', `${String(index).padStart(3, '0')}.bin`), bytes);
      });
      writeOwnerJsonAtomic(path.join(temporary, 'plan.json'), plan);
      this.#writeStateAt(temporary, {
        sequence: 1,
        phase: 'PLANNED',
        effectState: 'NONE',
        appliedIndexes: [],
        verification: null,
        backup: null,
        reconcileCount: 0,
        at: currentIso(this.now),
      });
      fs.renameSync(temporary, directory);
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      if (fs.existsSync(directory)) {
        const existing = this.#readPlan(operationId);
        if (existing.requestHash === requestHash) return { plan: existing, duplicate: true };
      }
      throw error;
    }
    return { plan, duplicate: false };
  }

  applyVerify({ operationId, planHash }) {
    const plan = this.#requirePlan(operationId, planHash);
    let state = this.#readState(operationId);
    if (state.phase === 'VERIFIED') return { operationId, state, duplicate: true };
    if (state.phase !== 'PLANNED') throw new WorkspaceChangeError('transaction_not_applicable', `transaction phase requires reconcile or a new plan: ${state.phase}`);
    const writer = this.#acquireWriter(plan, false);
    let liveMutationReserved = false;
    try {
      let context = this.resolveSnapshot(plan.snapshotId);
      const materialized = this.materialize(plan.snapshotId);
      const scratch = path.join(this.#operationRoot(operationId), 'scratch');
      fs.rmSync(scratch, { recursive: true, force: true });
      copyTree(materialized.root, scratch);
      state = this.#appendState(operationId, state, { phase: 'VERIFYING_CANDIDATE', effectState: 'NONE', scratch: 'scratch' });
      for (let index = 0; index < plan.changes.length; index += 1) this.#applyOne(scratch, plan, index);
      const verification = this.verificationRunner({ root: scratch, sourceRoot: context.root, steps: plan.verification, now: this.now });
      fs.rmSync(scratch, { recursive: true, force: true });
      if (!verification.passed) {
        state = this.#appendState(operationId, state, { phase: 'CANDIDATE_FAILED', effectState: 'NONE', verification, scratch: null });
        return { operationId, state, duplicate: false };
      }
      state = this.#appendState(operationId, state, { phase: 'CANDIDATE_VERIFIED', effectState: 'NONE', verification, scratch: null });
      context = this.resolveSnapshot(plan.snapshotId);
      const backup = this.#createBackup(plan, context.root, context.manifest);
      state = this.#appendState(operationId, state, { phase: 'APPLYING', effectState: 'RESERVED', backup, appliedIndexes: [] });
      liveMutationReserved = true;
      this.#crash('after_reserve');
      for (let index = 0; index < plan.changes.length; index += 1) {
        this.#applyOne(context.root, plan, index);
        this.#crash(`after_mutation_${index}`);
        state = this.#appendState(operationId, state, { appliedIndexes: [...state.appliedIndexes, index] });
      }
      this.#assertDesired(plan, context.root);
      state = this.#appendState(operationId, state, { phase: 'VERIFIED', effectState: 'COMMITTED', committedAt: currentIso(this.now) });
      return { operationId, state, duplicate: false };
    } catch (error) {
      if (error instanceof WorkspaceChangeError && error.code === 'injected_crash') throw error;
      if (liveMutationReserved) {
        const rolledBack = this.#rollbackInternal(plan, state, { reason: error.code ?? 'apply_failed', reconciled: false });
        if (!rolledBack.ok) throw new WorkspaceChangeError('rollback_hold', 'workspace change failed and rollback held on external drift');
        throw new WorkspaceChangeError('apply_failed_rolled_back', `workspace change failed and narrow rollback completed: ${error.message}`);
      }
      throw error;
    } finally {
      this.#releaseWriter(writer);
    }
  }

  reconcile({ operationId, planHash }) {
    const plan = this.#requirePlan(operationId, planHash);
    let state = this.#readState(operationId);
    const writer = this.#acquireWriter(plan, true);
    try {
      state = this.#readState(operationId);
      const scratch = path.join(this.#operationRoot(operationId), 'scratch');
      if (['VERIFYING_CANDIDATE', 'CANDIDATE_VERIFIED'].includes(state.phase)) {
        fs.rmSync(scratch, { recursive: true, force: true });
        state = this.#appendState(operationId, state, {
          phase: 'PLANNED', effectState: 'NONE', scratch: null,
          reconcileCount: (state.reconcileCount ?? 0) + 1,
          reconciliation: 'candidate-only-no-live-effect',
        });
        return { operationId, state, action: 'reset-to-plan' };
      }
      if (state.phase === 'PLANNED' || TERMINAL_PHASES.has(state.phase)) return { operationId, state, action: 'none' };
      if (!['APPLYING', 'ROLLING_BACK'].includes(state.phase)) {
        throw new WorkspaceChangeError('reconcile_phase_unknown', `transaction phase cannot be reconciled automatically: ${state.phase}`);
      }
      const context = this.resolveSnapshotForChangedWorkspace(plan);
      const observed = this.#observe(plan, context.root);
      if (observed.every(item => item === 'desired') && state.phase === 'APPLYING') {
        state = this.#appendState(operationId, state, {
          phase: 'VERIFIED', effectState: 'COMMITTED',
          reconcileCount: (state.reconcileCount ?? 0) + 1,
          reconciliation: 'all-desired-commit', committedAt: currentIso(this.now),
        });
        return { operationId, state, action: 'committed' };
      }
      if (observed.every(item => item === 'expected') && state.phase === 'APPLYING') {
        state = this.#appendState(operationId, state, {
          phase: 'PLANNED', effectState: 'NONE', appliedIndexes: [],
          reconcileCount: (state.reconcileCount ?? 0) + 1,
          reconciliation: 'reserved-with-no-effect',
        });
        return { operationId, state, action: 'reset-to-plan' };
      }
      const rolledBack = this.#rollbackInternal(plan, state, { reason: 'crash_reconcile', reconciled: true, root: context.root });
      return { operationId, state: rolledBack.state, action: rolledBack.ok ? 'rolled-back' : 'hold-external-drift' };
    } finally {
      this.#releaseWriter(writer);
    }
  }

  rollback({ operationId, planHash, reason = 'explicit_rollback' }) {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(reason)) {
      throw new WorkspaceChangeError('rollback_reason_invalid', 'rollback reason must be a bounded machine-readable tag');
    }
    const plan = this.#requirePlan(operationId, planHash);
    const state = this.#readState(operationId);
    if (state.phase === 'ROLLED_BACK') return { operationId, state, duplicate: true };
    if (state.phase !== 'VERIFIED') throw new WorkspaceChangeError('rollback_not_applicable', `rollback requires VERIFIED, got ${state.phase}`);
    const writer = this.#acquireWriter(plan, false);
    try {
      const context = this.resolveSnapshotForChangedWorkspace(plan);
      const result = this.#rollbackInternal(plan, state, { reason, reconciled: false, root: context.root });
      return { operationId, state: result.state, duplicate: false };
    } finally {
      this.#releaseWriter(writer);
    }
  }

  status({ operationId, planHash }) {
    const plan = this.#requirePlan(operationId, planHash);
    return { plan, state: this.#readState(operationId) };
  }

  #operationRoot(operationId) {
    if (!/^change_[a-f0-9]{64}$/.test(operationId ?? '')) throw new WorkspaceChangeError('operation_id_invalid', 'workspace change operationId is invalid');
    return path.join(this.root, operationId);
  }

  #readPlan(operationId) {
    return readOwnerJson(path.join(this.#operationRoot(operationId), 'plan.json'));
  }

  #requirePlan(operationId, planHash) {
    const plan = this.#readPlan(operationId);
    if (!/^[a-f0-9]{64}$/.test(planHash ?? '') || plan.planHash !== planHash || plan.operationId !== operationId) {
      throw new WorkspaceChangeError('plan_hash_mismatch', 'workspace change plan hash differs');
    }
    const { planHash: _storedHash, operationId: _operationId, ...core } = plan;
    if (sha256(stableJson(core)) !== planHash) throw new WorkspaceChangeError('plan_integrity_failed', 'workspace change plan content differs from its hash');
    const { requestHash, createdAt: _createdAt, ...identity } = core;
    if (!/^[a-f0-9]{64}$/.test(requestHash ?? '')
      || sha256(stableJson(identity)) !== requestHash
      || operationId !== `change_${requestHash}`) {
      throw new WorkspaceChangeError('plan_integrity_failed', 'workspace change request identity differs from its content');
    }
    return plan;
  }

  #stateFiles(operationId) {
    const directory = path.join(this.#operationRoot(operationId), 'states');
    return fs.readdirSync(directory).filter(name => /^\d{8}\.json$/.test(name)).sort();
  }

  #readState(operationId) {
    const files = this.#stateFiles(operationId);
    if (files.length < 1) throw new WorkspaceChangeError('transaction_state_missing', 'workspace transaction state is missing');
    const record = readOwnerJson(path.join(this.#operationRoot(operationId), 'states', files.at(-1)));
    if (record.hash !== sha256(stableJson(record.state)) || record.sequence !== record.state.sequence) {
      throw new WorkspaceChangeError('transaction_state_invalid', 'workspace transaction state hash differs');
    }
    return record.state;
  }

  #writeStateAt(root, state) {
    const record = { schemaVersion: SCHEMA_VERSION, sequence: state.sequence, hash: sha256(stableJson(state)), state };
    writeOwnerJsonAtomic(path.join(root, 'states', `${String(state.sequence).padStart(8, '0')}.json`), record);
    return state;
  }

  #appendState(operationId, previous, patch) {
    const state = { ...structuredClone(previous), ...structuredClone(patch), sequence: previous.sequence + 1, at: currentIso(this.now) };
    return this.#writeStateAt(this.#operationRoot(operationId), state);
  }

  #payload(plan, index) {
    const change = plan.changes[index];
    if (change.type !== 'write_text') return null;
    const file = path.join(this.#operationRoot(plan.operationId), 'payloads', `${String(index).padStart(3, '0')}.bin`);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isFile()
      || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new WorkspaceChangeError('payload_invalid', `workspace change payload is unsafe: ${index}`);
    }
    const bytes = fs.readFileSync(file);
    if (bytes.length !== change.bytes || sha256(bytes) !== change.desiredSha256) throw new WorkspaceChangeError('payload_invalid', `workspace change payload differs: ${index}`);
    return bytes;
  }

  #applyOne(root, plan, index) {
    const change = plan.changes[index];
    const target = confinedTarget(root, change.path, { allowMissing: change.type === 'write_text' });
    const currentSha256 = target.exists ? sha256(fs.readFileSync(target.resolved)) : null;
    if (currentSha256 !== change.expectedSha256) {
      throw new WorkspaceChangeError('change_precondition_mismatch', `workspace target changed before mutation: ${change.path}`);
    }
    if (change.type === 'delete') {
      fs.unlinkSync(target.resolved);
      return;
    }
    atomicTargetWrite(target.resolved, this.#payload(plan, index), change.mode);
  }

  #createBackup(plan, root, manifest) {
    const directory = path.join(this.#operationRoot(plan.operationId), 'backups');
    const entries = [];
    for (let index = 0; index < plan.changes.length; index += 1) {
      const current = this.inspectTarget(root, manifest, plan.changes[index].path, { allowMissing: true, allowChangedWorkspace: true });
      if (current.sha256 !== plan.changes[index].expectedSha256) throw new WorkspaceChangeError('change_precondition_mismatch', `live precondition differs before backup: ${current.path}`);
      const entry = { index, path: current.path, existed: current.exists, sha256: current.sha256, mode: current.mode };
      if (current.exists) {
        const file = path.join(directory, `${String(index).padStart(3, '0')}.bin`);
        if (!fs.existsSync(file)) {
          fs.copyFileSync(current.resolved, file, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(file, 0o600);
        }
        const backupBytes = fs.readFileSync(file);
        if (sha256(backupBytes) !== current.sha256) throw new WorkspaceChangeError('backup_invalid', `workspace backup differs: ${current.path}`);
      }
      entries.push(entry);
    }
    const backup = { ref: `workspace-change://${plan.operationId}/backups`, entries, createdAt: currentIso(this.now) };
    writeOwnerJsonAtomic(path.join(directory, 'manifest.json'), backup);
    return backup;
  }

  #observe(plan, root) {
    return plan.changes.map(change => {
      const target = confinedTarget(root, change.path, { allowMissing: true });
      const hash = target.exists ? sha256(fs.readFileSync(target.resolved)) : null;
      if (hash === change.desiredSha256) return 'desired';
      if (hash === change.expectedSha256) return 'expected';
      return 'drift';
    });
  }

  #assertDesired(plan, root) {
    const observed = this.#observe(plan, root);
    const mismatch = observed.findIndex(item => item !== 'desired');
    if (mismatch >= 0) throw new WorkspaceChangeError('postcondition_mismatch', `workspace desired hash differs after apply: ${plan.changes[mismatch].path}`);
  }

  #rollbackInternal(plan, previous, { reason, reconciled, root = null }) {
    const context = root ? { root } : this.resolveSnapshotForChangedWorkspace(plan);
    const observed = this.#observe(plan, context.root);
    if (observed.some(item => item === 'drift')) {
      const state = this.#appendState(plan.operationId, previous, {
        phase: 'HOLD_EXTERNAL_DRIFT', effectState: 'UNKNOWN',
        reconcileCount: (previous.reconcileCount ?? 0) + (reconciled ? 1 : 0),
        rollback: { ok: false, reason, observed },
      });
      return { ok: false, state };
    }
    let state = this.#appendState(plan.operationId, previous, { phase: 'ROLLING_BACK', effectState: 'ROLLBACK_RESERVED', rollback: { ok: null, reason, observed } });
    const backup = state.backup ?? readOwnerJson(path.join(this.#operationRoot(plan.operationId), 'backups', 'manifest.json'));
    for (const entry of [...backup.entries].reverse()) {
      if (observed[entry.index] !== 'desired') continue;
      const target = confinedTarget(context.root, entry.path, { allowMissing: true });
      if (!entry.existed) {
        if (target.exists) fs.unlinkSync(target.resolved);
        continue;
      }
      const file = path.join(this.#operationRoot(plan.operationId), 'backups', `${String(entry.index).padStart(3, '0')}.bin`);
      const bytes = fs.readFileSync(file);
      if (sha256(bytes) !== entry.sha256) throw new WorkspaceChangeError('backup_invalid', `workspace rollback backup differs: ${entry.path}`);
      atomicTargetWrite(target.resolved, bytes, entry.mode);
    }
    const restored = this.#observe(plan, context.root);
    if (!restored.every(item => item === 'expected')) throw new WorkspaceChangeError('rollback_verification_failed', 'workspace narrow rollback did not restore every expected hash');
    state = this.#appendState(plan.operationId, state, {
      phase: 'ROLLED_BACK', effectState: 'ROLLED_BACK',
      reconcileCount: (state.reconcileCount ?? 0) + (reconciled ? 1 : 0),
      rollback: { ok: true, reason, observed, restoredAt: currentIso(this.now) },
    });
    return { ok: true, state };
  }

  #writerPath(plan) {
    if (!/^workspace_[a-f0-9]{24}$/.test(plan.workspaceId ?? '')) throw new WorkspaceChangeError('workspace_id_invalid', 'workspaceId is invalid');
    return path.join(this.writerRoot, `${plan.workspaceId}.lock`);
  }

  #acquireWriter(plan, reconcile) {
    const file = this.#writerPath(plan);
    const open = () => {
      const nonce = crypto.randomBytes(16).toString('hex');
      const descriptor = fs.openSync(file, 'wx', 0o600);
      const lock = { schemaVersion: 1, workspaceId: plan.workspaceId, operationId: plan.operationId, pid: this.pid, nonce, createdAt: currentMs(this.now) };
      fs.writeFileSync(descriptor, `${JSON.stringify(lock)}\n`);
      fs.fsyncSync(descriptor);
      return { file, descriptor, lock };
    };
    try { return open(); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = readOwnerJson(file);
      const age = currentMs(this.now) - Number(existing.createdAt);
      if (!Number.isFinite(age) || age <= this.lockStaleMs || this.isProcessAlive(existing.pid)) {
        throw new WorkspaceChangeError('writer_busy', `workspace already has an active writer: ${existing.operationId ?? 'unknown'}`);
      }
      if (!reconcile || existing.operationId !== plan.operationId) {
        throw new WorkspaceChangeError('writer_reconcile_required', `stale workspace writer requires exact reconciliation: ${existing.operationId ?? 'unknown'}`);
      }
      const quarantine = path.join(this.#operationRoot(plan.operationId), `stale-writer-${sha256(stableJson(existing)).slice(0, 16)}.json`);
      fs.renameSync(file, quarantine);
      fs.chmodSync(quarantine, 0o600);
      try { return open(); }
      catch { throw new WorkspaceChangeError('writer_busy', 'workspace writer raced during stale reconciliation'); }
    }
  }

  #releaseWriter(writer) {
    if (!writer) return;
    try { fs.closeSync(writer.descriptor); } catch { /* already closed */ }
    try {
      const current = readOwnerJson(writer.file);
      if (current.pid === writer.lock.pid && current.nonce === writer.lock.nonce && current.operationId === writer.lock.operationId) fs.unlinkSync(writer.file);
    } catch { /* preserve ambiguous writer evidence */ }
  }

  #crash(point) {
    if (this.crashPoint === point) throw new WorkspaceChangeError('injected_crash', `injected workspace transaction crash at ${point}`);
  }

  resolveSnapshotForChangedWorkspace(plan) {
    const internal = this.resolveSnapshot(plan.snapshotId, { allowChangedWorkspace: true });
    return internal;
  }
}
