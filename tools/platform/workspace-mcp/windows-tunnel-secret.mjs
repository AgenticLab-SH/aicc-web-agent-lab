#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localWorkspaceProtection } from '../../../src/workspace-mcp.mjs';
import { workspaceRuntimeStartGuard } from '../../../components/workspace-mcp/runtime-marker.mjs';
import { workspaceTunnelSurfaceDetails } from './install-launch-agent.mjs';

const MAX_SECRET_BYTES = 8192;
// A cold, least-privilege scheduled task may need more than ten seconds to
// initialize Windows PowerShell under load. This stays bounded and never retries.
const SECRET_SUBPROCESS_TIMEOUT_MS = 30000;

function windowsPowerShellExecutable(options = {}) {
  const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  return path.resolve(options.powershellExecutable ?? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
}

// PowerShell 7's process PSModulePath can shadow Windows PowerShell 5 modules.
// These internal subprocesses need only that executable's built-in modules.
function windowsPowerShellEnvironment(options = {}, extra = {}) {
  return { ...process.env, ...extra,
    PSModulePath: path.join(path.dirname(windowsPowerShellExecutable(options)), 'Modules') };
}
function fail(code, diagnostic) {
  const error = new Error(code);
  error.code = code;
  if (diagnostic) error.diagnostic = diagnostic;
  throw error;
}

// Preserve process-control facts only. stdout, stderr, arguments and environment
// may contain credentials and must never enter a status or failure receipt.
function subprocessDiagnostic(stage, result, started, timeoutMs) {
  const errorCode = typeof result.error?.code === 'string' && /^E[A-Z0-9_]{1,40}$/.test(result.error.code) ? result.error.code : null;
  return { stage, exitCode: Number.isInteger(result.status) ? result.status : null,
    errorCode, timedOut: errorCode === 'ETIMEDOUT',
    signal: typeof result.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(result.signal) ? result.signal : null,
    elapsedMs: Math.max(0, Date.now() - started), timeoutMs };
}

export function windowsTunnelSecretPaths(options = {}) {
  if (!['business-full', 'personal-read-fetch'].includes(options.surfaceProfile)) fail('surface_required');
  const details = workspaceTunnelSurfaceDetails(options.surfaceProfile);
  const stateRoot = path.resolve(options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(options.home ?? os.homedir(), '.ai-control-center'));
  const root = path.join(stateRoot, details.stateDirectory);
  const secrets = path.join(root, 'secrets');
  const profileDir = path.join(root, 'tunnel', 'profiles');
  const runtime = path.join(root, 'tunnel', 'runtime');
  return {
    ...details, stateRoot, root, secrets, profileDir, runtime,
    key: path.join(secrets, 'tunnel-runtime.key.dpapi'),
    binary: path.join(root, 'bin', 'tunnel-client.exe'),
    profile: path.join(profileDir, `${details.runtimeAlias}.yaml`),
    config: path.join(root, 'config.json'),
    lock: path.join(runtime, 'windows-helper.lock'),
    entropy: `aicc-workspace-tunnel:v1:${details.surfaceProfile}`
  };
}

function runtimeArguments(resolved) {
  return [
    'run', '--profile-dir', resolved.profileDir, '--profile', resolved.runtimeAlias,
    '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY',
    '--log.file', 'stdout', '--log.http-raw-unsafe=false',
    '--allow-remote-ui=false', '--open-web-ui=false',
    '--health.listen-addr', '127.0.0.1:0', '--health.unix-socket=',
    '--health.url-file', path.join(resolved.runtime, 'health', `${resolved.runtimeAlias}.url`),
    '--pid.file', path.join(resolved.runtime, `${resolved.runtimeAlias}.pid`)
  ];
}

function safePath(file, kind, optional = false) {
  let current = path.resolve(file);
  let target = true;
  while (true) {
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || (!optional && target)) fail('unsafe_or_missing_path');
    }
    if (stat && (stat.isSymbolicLink() || (target && kind === 'file' ? !stat.isFile() : !stat.isDirectory()))) fail('unsafe_path');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    target = false;
  }
}

function regularBytes(file) {
  safePath(file, 'file');
  const stat = fs.statSync(file);
  if (stat.size < 1 || stat.size > MAX_SECRET_BYTES) fail('invalid_secret_size');
  return fs.readFileSync(file);
}

function secretToken(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_SECRET_BYTES) fail('invalid_secret_size');
  const token = bytes.toString('utf8').trim();
  if (!/^[\x21-\x7e]+$/.test(token)) fail('invalid_secret_encoding');
  return token;
}

export function windowsTunnelDpapi(bytes, action, options = {}) {
  const resolved = windowsTunnelSecretPaths(options);
  if ((options.platform ?? process.platform) !== 'win32') fail('windows_required');
  if (!['Protect', 'Unprotect'].includes(action)) fail('invalid_dpapi_action');
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_SECRET_BYTES) fail('invalid_secret_size');
  const script = [
    "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'",
    'Add-Type -AssemblyName System.Security',
    '$inputBytes=$null; $outputBytes=$null; $stream=[IO.MemoryStream]::new()',
    'try{[Console]::OpenStandardInput().CopyTo($stream); $inputBytes=$stream.ToArray()',
    '$entropy=[Text.Encoding]::UTF8.GetBytes($env:AICC_TUNNEL_ENTROPY)',
    `$outputBytes=[Security.Cryptography.ProtectedData]::${action}($inputBytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::OpenStandardOutput().Write($outputBytes,0,$outputBytes.Length)',
    '}catch{exit 20}finally{if($inputBytes){[Array]::Clear($inputBytes,0,$inputBytes.Length)}; if($outputBytes){[Array]::Clear($outputBytes,0,$outputBytes.Length)}; $stream.Dispose()}'
  ].join(';');
  const started = Date.now();
  const result = (options.spawnSync ?? spawnSync)(windowsPowerShellExecutable(options), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input: bytes, encoding: null, maxBuffer: MAX_SECRET_BYTES, timeout: SECRET_SUBPROCESS_TIMEOUT_MS, windowsHide: true, shell: false,
    env: windowsPowerShellEnvironment(options, { AICC_TUNNEL_ENTROPY: resolved.entropy })
  });
  if (Buffer.isBuffer(result.stderr)) result.stderr.fill(0);
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout) || !result.stdout.length) {
    if (Buffer.isBuffer(result.stdout)) result.stdout.fill(0);
    fail('dpapi_operation_failed', subprocessDiagnostic('dpapi', result, started, SECRET_SUBPROCESS_TIMEOUT_MS));
  }
  return result.stdout;
}

function validateKeyAcl(resolved, options) {
  let directoryDiagnostic;
  try {
    localWorkspaceProtection(resolved.secrets, { ...options, spawnSync(file, args, settings) {
      const started = Date.now();
      // The task does not inherit Codex's tool PATH. Use the same explicit
      // Windows PowerShell as key ACL/DPAPI, avoiding an App Execution Alias.
      const result = (options.spawnSync ?? spawnSync)(windowsPowerShellExecutable(options), args, { ...settings, env: windowsPowerShellEnvironment(options, settings.env) });
      directoryDiagnostic = subprocessDiagnostic('directory_acl', result, started, settings.timeout);
      return result;
    } });
  } catch { fail('secret_directory_acl_invalid', directoryDiagnostic); }
  const script = [
    "$ErrorActionPreference='Stop'",
    '$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$acl=[IO.File]::GetAccessControl($env:AICC_TUNNEL_KEY_FILE)',
    'if($acl.Access.Count -eq 0 -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner){exit 12}',
    "$read=$false; foreach($rule in $acl.Access){$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; if($rule.AccessControlType -eq 'Allow'){if($sid -notin @($owner,'S-1-5-18')){exit 13}; if($sid -eq $owner){$read=$true}}}; if(-not $read){exit 14}"
  ].join(';');
  const started = Date.now();
  const result = (options.spawnSync ?? spawnSync)(windowsPowerShellExecutable(options), ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: SECRET_SUBPROCESS_TIMEOUT_MS, windowsHide: true, shell: false,
    env: windowsPowerShellEnvironment(options, { AICC_TUNNEL_KEY_FILE: resolved.key })
  });
  if (result.status !== 0) fail('secret_acl_invalid', subprocessDiagnostic('key_acl', result, started, SECRET_SUBPROCESS_TIMEOUT_MS));
}

function readSecret(resolved, options) {
  const ciphertext = regularBytes(resolved.key);
  let plaintext;
  try {
    validateKeyAcl(resolved, options);
    plaintext = windowsTunnelDpapi(ciphertext, 'Unprotect', options);
    secretToken(plaintext);
    return plaintext;
  } catch (error) {
    plaintext?.fill(0);
    throw error;
  } finally { ciphertext.fill(0); }
}

// Only a key just created by this import is adjusted. Existing keys remain untouched.
// Elevated Windows tokens otherwise assign Administrators as a new file's owner.
function protectCreatedKeyOwner(resolved, options) {
  if ((options.platform ?? process.platform) !== 'win32') return;
  safePath(resolved.key, 'file');
  const script = "$ErrorActionPreference='Stop'; $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=Get-Acl -LiteralPath $env:AICC_TUNNEL_KEY_FILE; $acl.SetOwner($owner); Set-Acl -LiteralPath $env:AICC_TUNNEL_KEY_FILE -AclObject $acl";
  const started = Date.now();
  const result = (options.spawnSync ?? spawnSync)(windowsPowerShellExecutable(options), ['-NoProfile','-NonInteractive','-Command',script], {
    encoding:'utf8',timeout:SECRET_SUBPROCESS_TIMEOUT_MS,windowsHide:true,shell:false,
    env:windowsPowerShellEnvironment(options,{AICC_TUNNEL_KEY_FILE:resolved.key})
  });
  if(result.status !== 0) fail('created_secret_owner_invalid',subprocessDiagnostic('created_key_owner',result,started,SECRET_SUBPROCESS_TIMEOUT_MS));
}
export function importWindowsTunnelSecret(bytes, options = {}) {
  const resolved = windowsTunnelSecretPaths(options);
  if ((options.platform ?? process.platform) !== 'win32') fail('windows_required');
  secretToken(bytes);
  safePath(resolved.secrets, 'directory', true);
  safePath(resolved.key, 'file', true);
  if (fs.existsSync(resolved.key)) {
    const existing = readSecret(resolved, options);
    try { if (!existing.equals(bytes)) fail('existing_secret_differs'); }
    finally { existing.fill(0); }
    return { ok: true, duplicate: true, surfaceProfile: resolved.surfaceProfile };
  }
  const ciphertext = windowsTunnelDpapi(bytes, 'Protect', options);
  try {
    fs.mkdirSync(resolved.secrets, { recursive: true, mode: 0o700 });
    localWorkspaceProtection(resolved.secrets, { ...options, apply: true });
    fs.writeFileSync(resolved.key, ciphertext, { flag: 'wx', mode: 0o600 });
    protectCreatedKeyOwner(resolved, options);
  } finally { ciphertext.fill(0); }
  const verified = readSecret(resolved, options);
  try { if (!verified.equals(bytes)) fail('secret_roundtrip_failed'); }
  finally { verified.fill(0); }
  return { ok: true, duplicate: false, surfaceProfile: resolved.surfaceProfile };
}

export function windowsTunnelIdleGuard(options = {}) {
  const resolved = windowsTunnelSecretPaths(options);
  try {
    for (const directory of [resolved.root, resolved.runtime, path.join(resolved.root, 'runtime')]) safePath(directory, 'directory', true);
    safePath(path.join(resolved.root, 'runtime', 'remote-authority-status.json'), 'file', true);
    if (fs.existsSync(resolved.lock)) {
      safePath(resolved.lock, 'file');
      let lock;
      try { lock = JSON.parse(fs.readFileSync(resolved.lock, 'utf8')); }
      catch { return { allowed: false, reason: 'tunnel_helper_lock_unknown' }; }
      if (!Number.isInteger(lock?.pid) || lock.pid < 1 || lock.surfaceProfile !== resolved.surfaceProfile) {
        return { allowed: false, reason: 'tunnel_helper_lock_unknown' };
      }
      try {
        probeTunnelOwner(lock.pid, { ...resolved, binary: process.execPath }, options);
        return { allowed: false, reason: 'tunnel_helper_locked' };
      } catch (error) {
        if (error.code !== 'ESRCH') return { allowed: false, reason: 'tunnel_helper_lock_unknown' };
      }
      try { fs.unlinkSync(resolved.lock); }
      catch (error) { if (error.code !== 'ENOENT') return { allowed: false, reason: 'tunnel_helper_lock_unknown' }; }
    }
    const runtimeGuard = workspaceRuntimeStartGuard(resolved.config, options);
    if (!runtimeGuard.allowed) return runtimeGuard;
    for (const pidFile of [path.join(resolved.runtime, `${resolved.runtimeAlias}.pid`), path.join(resolved.root, '.tunnel', 'runtime', `${resolved.runtimeAlias}.pid`)]) {
      if (!fs.existsSync(pidFile)) continue;
      safePath(pidFile, 'file');
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (!Number.isInteger(pid) || pid < 1) return { allowed: false, reason: 'tunnel_owner_unknown' };
      try { probeTunnelOwner(pid, resolved, options); return { allowed: false, reason: 'tunnel_owner_active' }; }
      catch (error) { if (error.code !== 'ESRCH') return { allowed: false, reason: 'tunnel_owner_unknown' }; }
    }
    return { allowed: true, reason: 'no_active_runtime' };
  } catch { return { allowed: false, reason: 'runtime_state_unknown' }; }
}

// After reboot a saved PID can belong to an unrelated protected process. Never kill it.
// Resolve the executable independently; unknown or same-name owners remain fail-closed.
export function probeTunnelOwner(pid, resolved, options = {}) {
  if (!Number.isInteger(pid) || pid < 1) throw Object.assign(new Error('owner_unknown'), { code: 'EPERM' });
  const signal = options.signalProcess ?? process.kill;
  if ((options.platform ?? process.platform) !== 'win32') return signal(pid, 0);
  // A successful signal(0) proves a PID exists, not that it still owns this tunnel.
  let signalError;
  try { signal(pid, 0); }
  catch (error) { if (error.code !== 'EPERM') throw error; signalError = error; }
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; if($null -eq $p){@{state='absent'}|ConvertTo-Json -Compress}else{@{state='present';executablePath=$p.ExecutablePath}|ConvertTo-Json -Compress}`;
  const result = (options.ownerProbe ?? spawnSync)(windowsPowerShellExecutable(options), ['-NoProfile','-NonInteractive','-Command',script], {encoding:'utf8',windowsHide:true,timeout:10000,env:windowsPowerShellEnvironment(options)});
  let owner;
  try { if(result.status !== 0) throw Error('probe_failed'); owner=JSON.parse(String(result.stdout ?? '').trim()); }
  catch { throw Object.assign(new Error('owner_unknown'), {code:'EPERM'}); }
  if(owner.state === 'absent') throw Object.assign(new Error('stale_tunnel_pid'), {code:'ESRCH'});
  if(owner.state !== 'present' || typeof owner.executablePath !== 'string' || !path.isAbsolute(owner.executablePath)) throw Object.assign(new Error('owner_unknown'), {code:'EPERM'});
  if(path.resolve(owner.executablePath).toLowerCase() !== path.resolve(resolved.binary).toLowerCase()) throw Object.assign(new Error('stale_tunnel_pid'), {code:'ESRCH'});
  if(signalError) throw signalError;
  return true;
}
export function windowsTunnelSecretStatus(options = {}) {
  const resolved = windowsTunnelSecretPaths(options);
  try {
    const bytes = readSecret(resolved, options);
    bytes.fill(0);
    return { ok: true, surfaceProfile: resolved.surfaceProfile, format: 'dpapi-binary', scope: 'CurrentUser', readable: true };
  } catch (error) {
    return { ok: false, surfaceProfile: resolved.surfaceProfile, format: 'dpapi-binary', scope: 'CurrentUser', readable: false, reason: 'protected_secret_unavailable',
      ...(error?.diagnostic ? { diagnostic: error.diagnostic } : {}) };
  }
}

export function windowsTunnelDoctor(options = {}) {
  const resolved = windowsTunnelSecretPaths(options);
  const checks = {};
  for (const name of ['binary', 'profile', 'config']) {
    try { safePath(resolved[name], 'file'); checks[name] = true; }
    catch { checks[name] = false; }
  }
  try {
    const config = JSON.parse(fs.readFileSync(resolved.config, 'utf8'));
    checks.authority = config.surfaceProfile === resolved.surfaceProfile
      && config.transport?.mode !== 'local-stdio'
      && config.remoteAuthority?.authenticationOwner === 'secure-mcp-tunnel'
      && /^remote_[a-f0-9]{24}$/.test(config.remoteAuthority?.identityBinding ?? '')
      && ['read-only', 'guarded', 'owner-unrestricted'].includes(config.remoteAuthority?.writePolicy)
      && (config.remoteAuthority?.writePolicy !== 'owner-unrestricted' || config.surfaceProfile === 'business-full');
  } catch { checks.authority = false; }
  const secretStatus = windowsTunnelSecretStatus(options);
  checks.secret = secretStatus.ok;
  const guard = windowsTunnelIdleGuard(options);
  return {
    ok: Object.values(checks).every(Boolean), surfaceProfile: resolved.surfaceProfile, checks, guard,
    ...(secretStatus.diagnostic ? { secretDiagnostic: secretStatus.diagnostic } : {}),
    ready: false, liveCallVerified: false, profileSemanticsVerified: false, networkProbed: false,
    plannedHealthListener: '127.0.0.1:0', logFiles: false,
    canStart: Object.values(checks).every(Boolean) && guard.allowed
  };
}

// Recover only an abandoned startup reservation. The whole runtime and tunnel
// must already be proven idle; malformed/active/denied owners remain untouched.
export function recoverWindowsTunnelStartupLock(options = {}) {
  const resolved = windowsTunnelSecretPaths(options);
  const lock = path.join(resolved.root, 'runtime', 'startup.lock');
  if ((options.platform ?? process.platform) !== 'win32') return { recovered: false, reason: 'windows_required' };
  const guard = windowsTunnelIdleGuard({ ...options, ignoreStartupLock: true });
  if (!guard.allowed) return { recovered: false, reason: guard.reason };
  try { safePath(lock, 'file', true); } catch { return { recovered: false, reason: 'startup_lock_unknown' }; }
  // Windows file operations stay in PowerShell. A dedicated FileShare.None
  // handle serializes recovery attempts without deleting another writer's lock.
  const script = String.raw`
$ErrorActionPreference='Stop'; $mutex=$null
try {
 $runtime=[IO.Path]::GetFullPath($env:AICC_RECOVER_STARTUP_ROOT)
 $lock=Join-Path $runtime 'startup.lock'
 if(!(Test-Path -LiteralPath $lock)){[Console]::Out.Write('ABSENT');exit 0}
 $mutex=[IO.File]::Open((Join-Path $runtime 'startup-recovery.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 foreach($folder in @($runtime,(Split-Path -Parent $runtime))){$item=Get-Item -LiteralPath $folder -Force;if(!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){exit 12}}
 $item=Get-Item -LiteralPath $lock -Force
 if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -lt 1 -or $item.Length -gt 4096){exit 13}
 $original=[IO.File]::ReadAllBytes($lock);$binding=[Text.Encoding]::UTF8.GetString($original)|ConvertFrom-Json
 if($binding.pid -isnot [long] -and $binding.pid -isnot [int]){exit 14}
 if($binding.pid -lt 1 -or $binding.pid -gt [int]::MaxValue){exit 14}
 $owner=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[string]$binding.pid) -ErrorAction Stop
 if($null -ne $owner){exit 15}
 $current=[IO.File]::ReadAllBytes($lock)
 if([Convert]::ToBase64String($current) -cne [Convert]::ToBase64String($original)){exit 16}
 $owner=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[string]$binding.pid) -ErrorAction Stop
 if($null -ne $owner){exit 15}
 $archive=Join-Path $runtime 'startup-lock-recovery'
 if(Test-Path -LiteralPath $archive){$directory=Get-Item -LiteralPath $archive -Force;if(!$directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)){exit 17}}else{New-Item -ItemType Directory -Path $archive | Out-Null}
 $destination=Join-Path $archive (([guid]::NewGuid().ToString('N'))+'.startup.lock')
 Move-Item -LiteralPath $lock -Destination $destination -ErrorAction Stop
 [Console]::Out.Write('RECOVERED')
} catch {exit 18} finally {if($null -ne $mutex){$mutex.Dispose()}}
`;
  const result = (options.startupRecoveryProcess ?? spawnSync)(windowsPowerShellExecutable(options), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 4096, windowsHide: true, shell: false,
    env: windowsPowerShellEnvironment(options, { AICC_RECOVER_STARTUP_ROOT: path.dirname(lock) })
  });
  const status = String(result.stdout ?? '').trim();
  return result.status === 0 && ['ABSENT', 'RECOVERED'].includes(status)
    ? { recovered: status === 'RECOVERED', reason: status === 'RECOVERED' ? 'dead_startup_owner_preserved' : 'startup_lock_absent' }
    : { recovered: false, reason: 'startup_lock_owner_unconfirmed' };
}
export async function runWindowsTunnel(options = {}) {
  const resolved = windowsTunnelSecretPaths(options);
  let doctor = windowsTunnelDoctor(options);
  if (!doctor.canStart && doctor.guard?.reason === 'startup_locked') {
    const recovery = recoverWindowsTunnelStartupLock(options);
    if (recovery.recovered || recovery.reason === 'startup_lock_absent') doctor = windowsTunnelDoctor(options);
  }
  if (!doctor.canStart) {
    const error = new Error('tunnel_preflight_failed');
    error.code = 'tunnel_preflight_failed';
    error.preflight = { checks: doctor.checks, guard: doctor.guard,
      ...(doctor.secretDiagnostic ? { secretDiagnostic: doctor.secretDiagnostic } : {}) };
    throw error;
  }
  fs.mkdirSync(resolved.runtime, { recursive: true, mode: 0o700 });
  fs.rmSync(path.join(resolved.runtime, 'windows-helper.last-error.json'), { force: true });
  localWorkspaceProtection(resolved.runtime, { ...options, apply: true });
  safePath(path.join(resolved.runtime, 'health'), 'directory', true);
  fs.mkdirSync(path.join(resolved.runtime, 'health'), { recursive: true, mode: 0o700 });
  for (const file of [path.join(resolved.runtime, 'health', `${resolved.runtimeAlias}.url`), path.join(resolved.runtime, `${resolved.runtimeAlias}.pid`)]) safePath(file, 'file', true);
  const descriptor = fs.openSync(resolved.lock, 'wx', 0o600);
  let child;
  let childEnv;
  let plaintext;
  const stop = () => {
    if (!child?.pid) return;
    (options.spawnSync ?? spawnSync)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: 10000, shell: false
    });
  };
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, surfaceProfile: resolved.surfaceProfile }));
    const guard = workspaceRuntimeStartGuard(resolved.config, options);
    if (!guard.allowed) fail('runtime_became_active');
    plaintext = readSecret(resolved, options);
    childEnv = { ...process.env };
    for (const name of Object.keys(childEnv)) if (name.toUpperCase() === 'CONTROL_PLANE_API_KEY') delete childEnv[name];
    childEnv.CONTROL_PLANE_API_KEY = secretToken(plaintext);
    child = (options.spawn ?? spawn)(resolved.binary, runtimeArguments(resolved), {
      cwd: resolved.root, env: childEnv, stdio: 'ignore', shell: false, windowsHide: true
    });
    delete childEnv.CONTROL_PLANE_API_KEY;
    plaintext.fill(0);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
    return await new Promise(resolve => {
      child.once('error', () => resolve({ ok: false, code: 'tunnel_start_failed' }));
      // A supervised Tunnel has no successful finite run. A clean child exit
      // still removes the backend and must activate the scheduler's recovery.
      child.once('exit', (exitCode, signal) => resolve({ ok: false, code: exitCode === 0 ? 'unexpected_tunnel_exit' : 'tunnel_exit_failed',
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: typeof signal === 'string' && /^SIG[A-Z0-9]+$/.test(signal) ? signal : null }));
    });
  } finally {
    if (childEnv) delete childEnv.CONTROL_PLANE_API_KEY;
    plaintext?.fill(0);
    for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, stop);
    fs.closeSync(descriptor);
    fs.unlinkSync(resolved.lock);
  }
}

export function parseWindowsTunnelSecretArgs(argv) {
  if (argv.includes('--help')) return { help: true };
  if (![3, 5].includes(argv.length) || !['status', 'doctor', 'import-stdin', 'run'].includes(argv[0]) || argv[1] !== '--surface') fail('invalid_arguments');
  if (argv.length === 5 && (argv[3] !== '--state-root' || !path.isAbsolute(argv[4]))) fail('invalid_state_root');
  windowsTunnelSecretPaths({ surfaceProfile: argv[2] });
  return { action: argv[0], surfaceProfile: argv[2], ...(argv.length === 5 ? { stateRoot: argv[4] } : {}) };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  let input;
  let options;
  try {
    options = parseWindowsTunnelSecretArgs(process.argv.slice(2));
    if (options.help) console.log('windows-tunnel-secret.mjs status|doctor|import-stdin|run --surface business-full|personal-read-fetch');
    else {
      let result;
      if (options.action === 'import-stdin') {
        const chunks = [];
        let size = 0;
        try {
          for await (const chunk of process.stdin) {
            size += chunk.length;
            if (size > MAX_SECRET_BYTES) { chunk.fill(0); fail('invalid_secret_size'); }
            chunks.push(chunk);
          }
          input = Buffer.concat(chunks);
        } finally { for (const chunk of chunks) chunk.fill(0); }
        result = importWindowsTunnelSecret(input, options);
      } else if (options.action === 'run') {
        result = await runWindowsTunnel(options);
        const resolved = windowsTunnelSecretPaths(options);
        fs.mkdirSync(resolved.runtime, { recursive: true, mode: 0o700 });
        // Normal child exits bypass the exception handler; retain their bounded
        // status too, without copying stderr, environment or credentials.
        fs.writeFileSync(path.join(resolved.runtime, 'windows-helper.last-exit.json'), `${JSON.stringify({
          schemaVersion: 1, exitedAt: new Date().toISOString(), helperPid: process.pid,
          surfaceProfile: resolved.surfaceProfile, ...result
        })}\n`, { encoding: 'utf8', mode: 0o600 });
      }
      else if (options.action === 'doctor') result = windowsTunnelDoctor(options);
      else result = windowsTunnelSecretStatus(options);
      if (options.action !== 'run') console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    if (options?.action === 'run') {
      try {
        const resolved = windowsTunnelSecretPaths(options);
        fs.mkdirSync(resolved.runtime, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(resolved.runtime, 'windows-helper.last-error.json'), `${JSON.stringify({
          schemaVersion: 1,
          failedAt: new Date().toISOString(),
          code: typeof error?.code === 'string' ? error.code : 'unknown_failure',
          ...(error?.preflight ? { preflight: error.preflight } : {}),
          ...(error?.diagnostic ? { diagnostic: error.diagnostic } : {}),
        })}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch { /* Preserve the original fail-closed exit. */ }
    }
    process.exitCode = 1;
  } finally { input?.fill(0); }
}
