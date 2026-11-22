import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const AICC_RECOVERY_HELP = `AICC exact-component recovery

Usage:
  aicc restore
  aicc restore --status
  aicc restore --dry-run
  aicc restore --help
  aicc restore ocx [--status|--dry-run]

The no-target command runs only the sealed owner recovery pointer. It never chooses a
different component, browser, account, route, or provider as a fallback.`;

export class AiccRecoveryCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AiccRecoveryCommandError';
    this.code = code;
  }
}

function parseMode(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return '--help';
  if (argv.length === 0) return 'apply';
  if (argv.length === 1 && ['--status', '--dry-run'].includes(argv[0])) return argv[0];
  throw new AiccRecoveryCommandError('invalid_restore_option', `unknown restore option: ${argv.join(' ')}`);
}

function ensureOwnerFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch { throw new AiccRecoveryCommandError('recovery_missing', `${label} is missing: ${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new AiccRecoveryCommandError('recovery_invalid', `${label} must be a regular non-symlink file`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new AiccRecoveryCommandError('recovery_owner_mismatch', `${label} is not owned by the current user`);
  }
  // POSIX mode bits are not authoritative on Windows; NTFS ACLs are handled
  // by the owner-private state root and the Windows private-home policy.
  if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) {
    throw new AiccRecoveryCommandError('recovery_permissions', `${label} must not be group/world writable`);
  }
  return stat;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ensureOwnerDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new AiccRecoveryCommandError('recovery_directory_invalid', 'AICC recovery directory must be an owner-only real directory');
  }
}

export function sealAiccRecoveryPointer({
  stateRoot = process.env.AICC_STATE_ROOT?.trim() || path.join(os.homedir(), '.ai-control-center'),
  script,
  component,
  operationId,
  backup = null,
  updatedAt = new Date().toISOString()
} = {}) {
  const resolvedStateRoot = path.resolve(stateRoot);
  if (typeof script !== 'string' || !path.isAbsolute(script)) {
    throw new AiccRecoveryCommandError('recovery_script_invalid', 'AICC recovery script must be an absolute path');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(String(component ?? ''))) {
    throw new AiccRecoveryCommandError('recovery_component_invalid', 'AICC recovery component is invalid');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(String(operationId ?? ''))) {
    throw new AiccRecoveryCommandError('recovery_operation_invalid', 'AICC recovery operation ID is invalid');
  }
  ensureOwnerFile(script, 'AICC recovery script');
  const artifactsRoot = path.join(resolvedStateRoot, 'artifacts-private');
  ensureOwnerDirectory(artifactsRoot);
  const realArtifactsRoot = fs.realpathSync(artifactsRoot);
  const realScript = fs.realpathSync(script);
  if (!realScript.startsWith(`${realArtifactsRoot}${path.sep}`)) {
    throw new AiccRecoveryCommandError('recovery_scope_denied', 'AICC recovery script must remain under artifacts-private');
  }
  const pointerDirectory = path.join(resolvedStateRoot, 'recovery', 'aicc');
  ensureOwnerDirectory(pointerDirectory);
  const pointerFile = path.join(pointerDirectory, 'latest.json');
  const payload = {
    schemaVersion: 1,
    target: 'aicc-exact-component',
    component,
    operationId,
    updatedAt,
    backup,
    script: realScript,
    scriptSha256: sha256(realScript)
  };
  const temporary = `${pointerFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, pointerFile);
  fs.chmodSync(pointerFile, 0o600);
  return { pointerFile, pointer: payload };
}

export function resolveAiccRecovery({
  stateRoot = process.env.AICC_STATE_ROOT?.trim() || path.join(os.homedir(), '.ai-control-center')
} = {}) {
  const resolvedStateRoot = path.resolve(stateRoot);
  const pointerFile = path.join(resolvedStateRoot, 'recovery', 'aicc', 'latest.json');
  ensureOwnerFile(pointerFile, 'AICC recovery pointer');
  let pointer;
  try { pointer = JSON.parse(fs.readFileSync(pointerFile, 'utf8')); }
  catch { throw new AiccRecoveryCommandError('recovery_pointer_invalid', 'AICC recovery pointer is not valid JSON'); }
  if (pointer?.schemaVersion !== 1
    || pointer?.target !== 'aicc-exact-component'
    || typeof pointer?.script !== 'string'
    || !path.isAbsolute(pointer.script)
    || !/^[a-f0-9]{64}$/.test(pointer?.scriptSha256 ?? '')) {
    throw new AiccRecoveryCommandError('recovery_pointer_invalid', 'AICC recovery pointer has an invalid schema, target, or hash');
  }
  ensureOwnerFile(pointer.script, 'AICC recovery script');
  const artifactsRoot = path.join(resolvedStateRoot, 'artifacts-private');
  const realArtifactsRoot = fs.realpathSync(artifactsRoot);
  const realScript = fs.realpathSync(pointer.script);
  if (!realScript.startsWith(`${realArtifactsRoot}${path.sep}`)) {
    throw new AiccRecoveryCommandError('recovery_scope_denied', 'AICC recovery script must remain under artifacts-private');
  }
  const observedHash = sha256(realScript);
  if (observedHash !== pointer.scriptSha256) {
    throw new AiccRecoveryCommandError('recovery_hash_mismatch', 'AICC recovery script differs from the sealed pointer');
  }
  return { pointerFile, pointer, script: realScript, observedHash };
}

export function runAiccRecoveryCommand(argv, options = {}) {
  const mode = parseMode(argv);
  if (mode === '--help') return { exitCode: 0, output: `${AICC_RECOVERY_HELP}\n`, executed: false };
  const resolved = resolveAiccRecovery(options);
  const spawn = options.spawnSync ?? spawnSync;
  const result = spawn('/bin/bash', [resolved.script, mode], {
    stdio: options.stdio ?? 'inherit',
    env: options.env ?? process.env
  });
  if (result.error) throw result.error;
  const exitCode = Number.isInteger(result.status) ? result.status : 4;
  const output = [0, 3, 4].includes(exitCode)
    ? ''
    : mode === 'apply'
      ? `UNCERTAIN: sealed AICC recovery script exited unexpectedly (${exitCode}). Do not replay; inspect the exact component and recovery artifacts.\n`
      : `HOLD: sealed AICC recovery ${mode} could not prove a safe state (exit ${exitCode}); dispatch=0.\n`;
  return { exitCode, output, executed: true, mode, ...resolved };
}
