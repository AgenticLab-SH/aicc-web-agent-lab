import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OCX_RECOVERY_HELP = `OCX recovery

Usage:
  aicc restore ocx
  aicc restore ocx --status
  aicc restore ocx --dry-run
  aicc restore ocx --help

Without an option, the current owner-only OCX recovery plan is applied.
`;

export class OcxRecoveryCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OcxRecoveryCommandError';
    this.code = code;
  }
}

function parseMode(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return '--help';
  if (argv.length === 0) return '--apply';
  if (argv.length === 1 && ['--apply', '--status', '--dry-run'].includes(argv[0])) return argv[0];
  throw new OcxRecoveryCommandError('invalid_ocx_restore_option', `unknown OCX restore option: ${argv.join(' ')}`);
}

function ensureOwnerFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch { throw new OcxRecoveryCommandError('ocx_recovery_missing', `${label} is missing: ${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new OcxRecoveryCommandError('ocx_recovery_invalid', `${label} must be a regular non-symlink file`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new OcxRecoveryCommandError('ocx_recovery_owner_mismatch', `${label} is not owned by the current user`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new OcxRecoveryCommandError('ocx_recovery_permissions', `${label} must not be group/world writable`);
  }
  return stat;
}

export function resolveOcxRecovery({ stateRoot = process.env.AICC_STATE_ROOT?.trim() || path.join(os.homedir(), '.ai-control-center') } = {}) {
  const resolvedStateRoot = path.resolve(stateRoot);
  const pointerFile = path.join(resolvedStateRoot, 'recovery', 'ocx', 'latest.json');
  ensureOwnerFile(pointerFile, 'OCX recovery pointer');
  let pointer;
  try { pointer = JSON.parse(fs.readFileSync(pointerFile, 'utf8')); }
  catch { throw new OcxRecoveryCommandError('ocx_recovery_pointer_invalid', 'OCX recovery pointer is not valid JSON'); }
  if (pointer?.schemaVersion !== 1 || pointer?.target !== 'ocx-10100' || typeof pointer?.script !== 'string' || !path.isAbsolute(pointer.script)) {
    throw new OcxRecoveryCommandError('ocx_recovery_pointer_invalid', 'OCX recovery pointer has an invalid schema or target');
  }
  const artifactsRoot = path.join(resolvedStateRoot, 'artifacts-private');
  ensureOwnerFile(pointer.script, 'OCX recovery script');
  const realArtifactsRoot = fs.realpathSync(artifactsRoot);
  const realScript = fs.realpathSync(pointer.script);
  if (realScript !== realArtifactsRoot && !realScript.startsWith(`${realArtifactsRoot}${path.sep}`)) {
    throw new OcxRecoveryCommandError('ocx_recovery_scope_denied', 'OCX recovery script must remain under artifacts-private');
  }
  return { pointerFile, pointer, script: realScript };
}

export function runOcxRecoveryCommand(argv, options = {}) {
  const mode = parseMode(argv);
  if (mode === '--help') return { exitCode: 0, output: OCX_RECOVERY_HELP, executed: false };
  const resolved = resolveOcxRecovery(options);
  const spawn = options.spawnSync ?? spawnSync;
  const result = spawn('/bin/bash', [resolved.script, mode], {
    stdio: options.stdio ?? 'inherit',
    env: options.env ?? process.env
  });
  if (result.error) throw result.error;
  const exitCode = Number.isInteger(result.status) ? result.status : 4;
  return { exitCode, output: '', executed: true, mode, ...resolved };
}
