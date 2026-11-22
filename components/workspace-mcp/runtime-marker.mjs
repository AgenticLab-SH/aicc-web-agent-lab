import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workspaceMcpRuntimeHash } from './runtime-integrity.mjs';
import { workspaceCommandSandboxAvailable, workspaceToolSnapshot } from './tool-manifest.mjs';

const componentRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(componentRoot, '../..');
const HASH = /^[a-f0-9]{64}$/;
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileHash(file) {
  return sha256(fs.readFileSync(file));
}

function safeRealFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Runtime identity requires a regular non-symlink file: ${file}`);
  return fs.realpathSync.native(file);
}

function findPackageJson(moduleFile) {
  let current = path.dirname(moduleFile);
  for (;;) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) return safeRealFile(candidate);
    const parent = path.dirname(current);
    if (parent === current) throw new Error('MCP SDK package.json was not found');
    current = parent;
  }
}

function processStartTokenForTimezone(pid, options = {}, timezone = 'UTC') {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const spawn = options.spawnSync ?? spawnSync;
  if ((options.platform ?? process.platform) === 'win32') {
    return processStartTokens([pid], options).get(pid) ?? null;
  }
  const executable = options.psExecutable ?? '/bin/ps';
  const result = spawn(executable, ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
    env: {
      ...(options.env ?? process.env),
      LC_ALL: 'C',
      LANG: 'C',
      TZ: timezone
    }
  });
  if (result.error || result.status !== 0 || !String(result.stdout ?? '').trim()) return null;
  return sha256(`${pid}\0${String(result.stdout).trim()}`);
}

export function processStartTokens(pids, options = {}) {
  const requested = [...new Set(pids)];
  const unavailable = () => new Map(requested.map(pid => [pid, null]));
  if (!requested.length || requested.length > 2 || requested.some(pid => !Number.isInteger(pid) || pid < 1)) return unavailable();
  if ((options.platform ?? process.platform) !== 'win32') {
    return new Map(requested.map(pid => [pid, processStartTokenForTimezone(pid, options)]));
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    `try { foreach($targetPid in @(${requested.join(',')})) {`,
    '$processInfo=[Diagnostics.Process]::GetProcessById($targetPid)',
    'try { $ticks=$processInfo.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)',
    '[Console]::Out.WriteLine("${targetPid}:$ticks")',
    '} finally { $processInfo.Dispose() }',
    '} } catch { exit 1 }'
  ].join(';');
  const configuredTimeout = options.windowsProcessIdentityTimeoutMs;
  const timeout = Number.isInteger(configuredTimeout) && configuredTimeout > 0
    ? Math.min(configuredTimeout, 15_000) : 15_000;
  let result;
  try {
    result = (options.spawnSync ?? spawnSync)(options.pwshExecutable ?? 'pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout, maxBuffer: 4096, windowsHide: true, shell: false,
      env: options.env ?? process.env
    });
  } catch { return unavailable(); }
  if (result.error || result.status !== 0) return unavailable();
  const lines = String(result.stdout ?? '').trim().split(/\r?\n/);
  if (lines.length !== requested.length) return unavailable();
  const tokens = new Map();
  for (const line of lines) {
    const match = line.match(/^(\d+):(\d{17,19})$/);
    if (!match) return unavailable();
    const pid = Number(match[1]);
    const ticks = BigInt(match[2]);
    if (!requested.includes(pid) || tokens.has(pid) || ticks <= 0n || ticks > 3155378975999999999n) return unavailable();
    tokens.set(pid, sha256(`${pid}\0win32-start-ticks:${match[2]}`));
  }
  return tokens;
}

export function processStartToken(pid, options = {}) {
  return processStartTokenForTimezone(pid, options, 'UTC');
}

function legacyLocalProcessStartToken(pid, options = {}) {
  return processStartTokenForTimezone(pid, options, '/etc/localtime');
}

function processIsAlive(pid, options = {}) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  const signalProcess = options.signalProcess ?? ((target, signal) => process.kill(target, signal));
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves that the kernel currently owns the PID even when this
    // reader cannot signal it.
    return error?.code === 'EPERM';
  }
}

export function workspaceRuntimeInstalledIdentity(options = {}) {
  const execPath = safeRealFile(options.execPath ?? process.execPath);
  const versions = options.versions ?? process.versions;
  const nodeVersion = options.nodeVersion ?? process.version;
  const execArgv = options.execArgv ?? process.execArgv;
  const lockfile = [
    path.join(repositoryRoot, 'npm-shrinkwrap.json'),
    path.join(repositoryRoot, 'package-lock.json')
  ].find(file => fs.existsSync(file));
  if (!lockfile) throw new Error('Workspace MCP installed identity requires a lockfile');
  const sdkModule = safeRealFile(fileURLToPath(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js')));
  const sdkPackage = findPackageJson(sdkModule);
  const sdk = JSON.parse(fs.readFileSync(sdkPackage, 'utf8'));
  return Object.freeze({
    nodeVersion,
    nodeModulesAbi: versions.modules,
    v8Version: versions.v8,
    nodeExecRealpath: execPath,
    nodeExecSha256: fileHash(execPath),
    execArgvSha256: sha256(JSON.stringify(execArgv)),
    nodeOptionsSha256: sha256(String(process.env.NODE_OPTIONS ?? '')),
    lockfileRealpath: safeRealFile(lockfile),
    lockfileSha256: fileHash(lockfile),
    mcpSdkVersion: sdk.version,
    mcpSdkPackageJsonSha256: fileHash(sdkPackage),
    mcpSdkResolvedRealpath: sdkModule,
    mcpSdkResolvedSha256: fileHash(sdkModule)
  });
}

export function workspaceRuntimeExpectedIdentity(config, configPath, options = {}) {
  return Object.freeze({
    sourceIdentity: Object.freeze({
      policyHash: config.remoteAuthority
        ? sha256(JSON.stringify(config.remoteAuthority))
        : null,
      configHash: fileHash(safeRealFile(configPath)),
      manifestHash: workspaceToolSnapshot({
        surfaceProfile: config.surfaceProfile,
        commandSandboxAvailable: workspaceCommandSandboxAvailable(config, options),
        webManagementAvailable: config.webManagement?.enabled === true,
        codexCliAvailable: config.codexCli?.enabled === true,
        gptQueueAvailable: config.gptQueue?.enabled === true
      }).hash,
      runtimeHash: workspaceMcpRuntimeHash(options.repositoryRoot ?? repositoryRoot)
    }),
    installedIdentity: workspaceRuntimeInstalledIdentity({
      execPath: options.execPath,
      nodeVersion: options.nodeVersion,
      versions: options.versions,
      execArgv: options.execArgv
    })
  });
}

function fsyncDirectory(directory) {
  // NTFS does not expose a fsync-able directory handle through Node. The
  // regular marker file is still flushed above; preserve the POSIX directory
  // barrier where it is supported without turning Windows writes into EPERM.
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    fsyncDirectory(path.dirname(file));
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* rename may already have consumed it */ }
    throw error;
  }
}

function liveOwnerIdentity(options = {}) {
  const pid = options.pid ?? process.pid;
  const supervisorPid = options.supervisorPid ?? process.ppid;
  const missingPids = [options.processStartToken ? null : pid, options.supervisorProcessStartToken ? null : supervisorPid].filter(value => value !== null);
  const tokens = processStartTokens(missingPids, options);
  const ownStartToken = options.processStartToken ?? tokens.get(pid);
  const supervisorStartToken = options.supervisorProcessStartToken ?? tokens.get(supervisorPid);
  if (!HASH.test(ownStartToken ?? '') || !HASH.test(supervisorStartToken ?? '')) {
    throw new Error('Workspace MCP process start identity is unavailable');
  }
  const configuredGeneration = String(options.supervisorGeneration ?? process.env.AICC_WORKSPACE_SUPERVISOR_GENERATION ?? '');
  const supervisorGeneration = HASH.test(configuredGeneration)
    ? configuredGeneration
    : sha256(`${supervisorPid}\0${supervisorStartToken}`);
  return Object.freeze({
    process: Object.freeze({ pid, processStartToken: ownStartToken }),
    supervisor: Object.freeze({ pid: supervisorPid, processStartToken: supervisorStartToken }),
    supervisorGeneration
  });
}

function currentMarker(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function workspaceRuntimeStartGuard(configPath, options = {}) {
  const runtimeRoot = options.runtimeRoot ?? path.join(path.dirname(configPath), 'runtime');
  if (!options.ignoreStartupLock && fs.existsSync(path.join(runtimeRoot, 'startup.lock'))) {
    return { allowed: false, reason: 'startup_locked' };
  }
  let marker;
  try { marker = currentMarker(path.join(runtimeRoot, 'remote-authority-status.json')); }
  catch { return { allowed: false, reason: 'runtime_marker_invalid' }; }
  const legacyGuard = marker ? markerOwnerGuard(marker, options) : { allowed: true, reason: 'no_runtime' };
  if (!legacyGuard.allowed) return legacyGuard;
  const instances = path.join(runtimeRoot, 'local-stdio');
  let instanceCount = 0;
  try {
    const stat = fs.lstatSync(instances);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { allowed: false, reason: 'local_runtime_invalid' };
    const entries = fs.readdirSync(instances, { withFileTypes: true });
    instanceCount = entries.length;
    if (entries.length > 4096) return { allowed: false, reason: 'local_runtime_inventory_limit' };
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !INSTANCE_ID.test(entry.name)) return { allowed: false, reason: 'local_runtime_invalid' };
      const file = path.join(instances, entry.name, 'remote-authority-status.json');
      const markerStat = fs.lstatSync(file);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) return { allowed: false, reason: 'local_runtime_invalid' };
      const instance = currentMarker(file);
      if (!instance || instance.instanceId !== entry.name || !['pending', 'starting', 'ready', 'stopped', 'failed'].includes(instance.phase)) return { allowed: false, reason: 'local_runtime_invalid' };
      const guard = markerOwnerGuard(instance, options);
      if (!guard.allowed && !(options.allowLocalInstances === true && guard.reason === 'runtime_owner_active')) return guard;
    }
  } catch (error) {
    if (error.code !== 'ENOENT' || fs.existsSync(instances)) return { allowed: false, reason: 'local_runtime_invalid' };
  }
  return instanceCount ? { allowed: true, reason: 'local_instances_compatible' } : legacyGuard;
}

function markerOwnerGuard(marker, options) {
  const pid = marker.process?.pid;
  if (!Number.isInteger(pid) || pid < 1) return { allowed: false, reason: 'runtime_owner_unknown' };
  try {
    (options.signalProcess ?? process.kill)(pid, 0);
    // A saved PID can be reused by an unrelated process after the owner exits.
    // Only a fresh, valid start-token mismatch proves that case. Never kill the
    // new process or turn unavailable/denied identity into a stopped owner.
    const expected = marker.process?.processStartToken;
    if (HASH.test(expected ?? '')) {
      let current;
      try { current = (options.readProcessStartToken ?? (target => processStartToken(target, options)))(pid); }
      catch { return { allowed: false, reason: 'runtime_owner_unknown' }; }
      if (!HASH.test(current ?? '')) return { allowed: false, reason: 'runtime_owner_unknown' };
      if (current !== expected) {
        if ((options.platform ?? process.platform) !== 'win32') {
          let legacy;
          try { legacy = (options.readLegacyProcessStartToken ?? (target => legacyLocalProcessStartToken(target, options)))(pid); }
          catch { return { allowed: false, reason: 'runtime_owner_unknown' }; }
          if (!HASH.test(legacy ?? '')) return { allowed: false, reason: 'runtime_owner_unknown' };
          if (legacy === expected) return { allowed: false, reason: 'runtime_owner_active' };
        }
        return { allowed: true, reason: 'runtime_owner_pid_reused' };
      }
    }
    return { allowed: false, reason: 'runtime_owner_active' };
  } catch (error) {
    return error.code === 'ESRCH'
      ? { allowed: true, reason: 'runtime_owner_stopped' }
      : { allowed: false, reason: 'runtime_owner_unknown' };
  }
}

export function workspaceRuntimeMarkerRoot(config, configPath, options = {}) {
  const root = options.runtimeRoot ?? path.join(path.dirname(configPath), 'runtime');
  if (config.transport?.mode !== 'local-stdio') return root;
  if (config.remoteAuthority?.authenticationOwner !== 'codex-local-stdio'
    || !/^local_[a-f0-9]{24}$/.test(config.remoteAuthority?.identityBinding ?? '')) {
    throw new Error('Local STDIO requires a dedicated local identity binding');
  }
  const instanceId = options.previous?.instanceId ?? options.instanceId;
  if (!INSTANCE_ID.test(instanceId ?? '')) throw new Error('Local STDIO requires an exact runtime instance');
  return path.join(root, 'local-stdio', instanceId);
}

function startLocalWorkspaceRuntimeMarker(config, configPath, options) {
  const instanceId = randomUUID();
  const instanceRoot = workspaceRuntimeMarkerRoot(config, configPath, { ...options, instanceId });
  const root = options.runtimeRoot ?? path.join(path.dirname(configPath), 'runtime');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, 'startup.lock');
  const deadline = Date.now() + 5_000;
  let descriptor;
  for (;;) {
    try { descriptor = fs.openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  let reserved = false;
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
    const guard = workspaceRuntimeStartGuard(configPath, { ...options, ignoreStartupLock: true, allowLocalInstances: true });
    if (!guard.allowed) throw new Error(`Workspace MCP start refused: ${guard.reason}`);
    if (options.expectedConfigHash && fileHash(configPath) !== options.expectedConfigHash) throw new Error('Local config changed before startup');
    fs.mkdirSync(path.dirname(instanceRoot), { recursive: true, mode: 0o700 });
    fs.mkdirSync(instanceRoot, { mode: 0o700 });
    writeJsonAtomic(path.join(instanceRoot, 'remote-authority-status.json'), {
      phase: 'pending', instanceId, process: { pid: options.pid ?? process.pid }
    });
    reserved = true;
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lock);
  }
  try {
    return writeWorkspaceRuntimeMarker(config, configPath, { ...options, instanceId, phase: 'starting' });
  } catch (error) {
    if (reserved) {
      fs.unlinkSync(path.join(instanceRoot, 'remote-authority-status.json'));
      fs.rmdirSync(instanceRoot);
    }
    throw error;
  }
}

export function startWorkspaceRuntimeMarker(config, configPath, options = {}) {
  if (config.transport?.mode === 'local-stdio') return startLocalWorkspaceRuntimeMarker(config, configPath, options);
  const runtimeRoot = options.runtimeRoot ?? path.join(path.dirname(configPath), 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(runtimeRoot, 'startup.lock');
  const descriptor = fs.openSync(lock, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
    const guard = workspaceRuntimeStartGuard(configPath, { ...options, ignoreStartupLock: true });
    if (!guard.allowed) throw new Error(`Workspace MCP start refused: ${guard.reason}`);
    return writeWorkspaceRuntimeMarker(config, configPath, { ...options, phase: 'starting' });
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lock);
  }
}

export function writeWorkspaceRuntimeMarker(config, configPath, options = {}) {
  if (!config.remoteAuthority) return null;
  const runtimeRoot = workspaceRuntimeMarkerRoot(config, configPath, options);
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(runtimeRoot, 0o700);
  const file = path.join(runtimeRoot, 'remote-authority-status.json');
  const previous = options.previous ?? null;
  const onDisk = currentMarker(file);
  if (previous && (!onDisk || onDisk.instanceId !== previous.instanceId)) {
    throw new Error('Workspace MCP runtime marker generation changed before transition');
  }
  const phase = options.phase ?? 'starting';
  if (!new Set(['starting', 'ready', 'stopped', 'failed']).has(phase)) {
    throw new Error(`Workspace MCP runtime phase is invalid: ${phase}`);
  }
  const now = new Date(options.now?.() ?? Date.now()).toISOString();
  const owner = previous
    ? { process: previous.process, supervisor: previous.supervisor, supervisorGeneration: previous.supervisorGeneration }
    : liveOwnerIdentity(options);
  const expected = previous
    ? { sourceIdentity: previous.sourceIdentity, installedIdentity: previous.installedIdentity }
    : workspaceRuntimeExpectedIdentity(config, configPath, options);
  const instanceId = previous?.instanceId ?? options.instanceId ?? randomUUID();
  if (!INSTANCE_ID.test(instanceId)) throw new Error('Workspace MCP runtime instance ID is invalid');
  const connected = phase === 'ready' && options.transportConnected === true;
  const readySignalId = connected
    ? options.readySignalId ?? previous?.transport?.readySignalId ?? randomBytes(16).toString('hex')
    : null;
  if (connected && !/^[a-f0-9]{32}$/.test(readySignalId)) throw new Error('Workspace MCP ready signal ID is invalid');
  const heartbeatSequence = previous ? Number(previous.heartbeatSequence ?? 0) + 1 : 0;
  const record = Object.freeze({
    schemaVersion: 4,
    phase,
    instanceId,
    supervisorGeneration: owner.supervisorGeneration,
    process: owner.process,
    supervisor: owner.supervisor,
    startedAt: previous?.startedAt ?? now,
    readyAt: phase === 'ready' ? previous?.readyAt ?? now : null,
    heartbeatSequence,
    heartbeatAt: now,
    transport: Object.freeze({
      type: 'stdio',
      connected,
      readySignalId
    }),
    sourceIdentity: expected.sourceIdentity,
    installedIdentity: expected.installedIdentity,
    authorityVersion: 2,
    identityHash: sha256(config.remoteAuthority.identityBinding),
    rawCapabilitiesStored: false,
    ...(options.failureCode ? { failureCode: String(options.failureCode).slice(0, 120) } : {})
  });
  writeJsonAtomic(file, record);
  return record;
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function inspectWorkspaceRuntimeMarker(marker, expected, options = {}) {
  const now = options.now?.() ?? Date.now();
  const maximumHeartbeatAgeMs = options.maximumHeartbeatAgeMs ?? 45_000;
  const reasons = [];
  if (!marker || marker.schemaVersion !== 4) reasons.push('schema');
  if (marker?.phase !== 'ready') reasons.push('phase');
  if (!INSTANCE_ID.test(marker?.instanceId ?? '')) reasons.push('instance');
  if (!HASH.test(marker?.supervisorGeneration ?? '')) reasons.push('supervisor_generation');
  if (!marker?.transport?.connected || marker?.transport?.type !== 'stdio'
    || !/^[a-f0-9]{32}$/.test(marker?.transport?.readySignalId ?? '')) reasons.push('transport');
  const heartbeatAt = Date.parse(marker?.heartbeatAt ?? '');
  const heartbeatFresh = Number.isFinite(heartbeatAt)
    && heartbeatAt <= now + 5_000
    && now - heartbeatAt <= maximumHeartbeatAgeMs;
  if (!heartbeatFresh) {
    reasons.push('heartbeat');
  }
  const tokens = options.readProcessStartToken ? null : processStartTokens([marker?.process?.pid, marker?.supervisor?.pid], options);
  const readStartToken = options.readProcessStartToken ?? (pid => tokens.get(pid));
  const readLegacyStartToken = options.readLegacyProcessStartToken
    ?? (options.readProcessStartToken || (options.platform ?? process.platform) === 'win32' ? (() => null) : (pid => legacyLocalProcessStartToken(pid, options)));
  const processToken = readStartToken(marker?.process?.pid);
  const processLegacyToken = readLegacyStartToken(marker?.process?.pid);
  const processTokenAvailable = HASH.test(processToken ?? '') || HASH.test(processLegacyToken ?? '');
  const processTokenMatches = HASH.test(processToken ?? '') && processToken === marker?.process?.processStartToken;
  const processLegacyTokenMatches = !processTokenMatches
    && HASH.test(processLegacyToken ?? '')
    && processLegacyToken === marker?.process?.processStartToken;
  const transportReady = marker?.transport?.connected === true && marker?.transport?.type === 'stdio';
  const fallbackAllowed = options.allowHeartbeatLivenessFallback === true && heartbeatFresh && transportReady;
  const processFallback = !processTokenAvailable
    && fallbackAllowed
    && processIsAlive(marker?.process?.pid, options);
  if (!processTokenMatches && !processLegacyTokenMatches && !processFallback) reasons.push('process_identity');

  const supervisorToken = readStartToken(marker?.supervisor?.pid);
  const supervisorLegacyToken = readLegacyStartToken(marker?.supervisor?.pid);
  const supervisorTokenAvailable = HASH.test(supervisorToken ?? '') || HASH.test(supervisorLegacyToken ?? '');
  const supervisorTokenMatches = HASH.test(supervisorToken ?? '') && supervisorToken === marker?.supervisor?.processStartToken;
  const supervisorLegacyTokenMatches = !supervisorTokenMatches
    && HASH.test(supervisorLegacyToken ?? '')
    && supervisorLegacyToken === marker?.supervisor?.processStartToken;
  const expectedSupervisorPid = Number(options.expectedSupervisorPid);
  const supervisorFallback = !supervisorTokenAvailable
    && fallbackAllowed
    && options.supervisorReady === true
    && Number.isInteger(expectedSupervisorPid)
    && expectedSupervisorPid > 0
    && marker?.supervisor?.pid === expectedSupervisorPid
    && marker?.process?.pid !== expectedSupervisorPid
    && processIsAlive(expectedSupervisorPid, options);
  if (!supervisorTokenMatches && !supervisorLegacyTokenMatches && !supervisorFallback) reasons.push('supervisor_identity');
  if (!equalJson(marker?.sourceIdentity, expected?.sourceIdentity)) reasons.push('source_identity');
  if (!equalJson(marker?.installedIdentity, expected?.installedIdentity)) reasons.push('installed_identity');
  return Object.freeze({
    ok: reasons.length === 0,
    reasons: Object.freeze(reasons),
    identityProof: Object.freeze({
      process: processTokenMatches
        ? 'process-start-token'
        : processLegacyTokenMatches
          ? 'legacy-local-process-start-token'
          : processFallback ? 'fresh-heartbeat-and-live-pid' : 'unverified',
      supervisor: supervisorTokenMatches
        ? 'process-start-token'
        : supervisorLegacyTokenMatches
          ? 'legacy-local-process-start-token'
          : supervisorFallback ? 'launchd-pid-fresh-heartbeat-and-live-pid' : 'unverified'
    })
  });
}
