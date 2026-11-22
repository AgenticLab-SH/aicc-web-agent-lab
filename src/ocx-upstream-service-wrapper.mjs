#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function statIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  };
}

function sameStatIdentity(left, right) {
  return left?.dev === right?.dev
    && left?.ino === right?.ino
    && left?.size === right?.size
    && left?.mtimeNs === right?.mtimeNs
    && left?.ctimeNs === right?.ctimeNs;
}

export function sealOcxLaunchArtifact(file) {
  const requested = path.resolve(file);
  const link = fs.lstatSync(requested);
  if (!link.isFile() || link.isSymbolicLink()) throw new Error('ocx_artifact_not_regular');
  const realpath = fs.realpathSync.native(requested);
  const descriptor = fs.openSync(realpath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const beforeIdentity = statIdentity(before);
    const afterIdentity = statIdentity(after);
    if (!before.isFile() || !sameStatIdentity(beforeIdentity, afterIdentity) || BigInt(bytes.length) !== after.size) {
      throw new Error('ocx_artifact_changed_during_seal');
    }
    return Object.freeze({
      realpath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      stat: Object.freeze(afterIdentity)
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function ocxArtifactStillCurrent(expected) {
  try {
    const link = fs.lstatSync(expected.realpath, { bigint: true });
    return link.isFile()
      && !link.isSymbolicLink()
      && fs.realpathSync.native(expected.realpath) === expected.realpath
      && sameStatIdentity(statIdentity(link), expected.stat);
  } catch {
    return false;
  }
}

function processStartToken(pid, options = {}) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const run = options.spawnSync ?? spawnSync;
  const result = run(options.psExecutable ?? '/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8', timeout: 2_000, windowsHide: true
  });
  const started = String(result?.stdout ?? '').trim();
  return result?.status === 0 && started
    ? createHash('sha256').update(`${pid}\0${started}`).digest('hex')
    : null;
}

function listenerPid(port, options = {}) {
  const run = options.spawnSync ?? spawnSync;
  const result = run(options.lsofExecutable ?? '/usr/sbin/lsof', [
    '-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'
  ], { encoding: 'utf8', timeout: 2_000, windowsHide: true });
  if (result?.status !== 0) return null;
  const pids = new Set(String(result.stdout ?? '').split(/\r?\n/)
    .filter(line => /^p\d+$/.test(line))
    .map(line => Number(line.slice(1)))
    .filter(pid => Number.isInteger(pid) && pid > 0));
  return pids.size === 1 ? [...pids][0] : null;
}

export function advanceOcxReadinessProof(previous, sample, requiredConsecutive = 3) {
  if (!Number.isInteger(requiredConsecutive) || requiredConsecutive < 2) {
    throw new Error('invalid_ocx_readiness_sample_count');
  }
  if (!sample?.current || typeof sample.identity !== 'string' || !sample.identity) {
    return Object.freeze({ current: false, ready: false, consecutive: 0, required: requiredConsecutive, identity: null });
  }
  const consecutive = previous?.current && previous.identity === sample.identity
    ? previous.consecutive + 1
    : 1;
  return Object.freeze({
    current: true,
    ready: consecutive >= requiredConsecutive,
    consecutive,
    required: requiredConsecutive,
    identity: sample.identity
  });
}

function snapshot(file) {
  try {
    return { exists: true, bytes: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, bytes: null, mode: 0o600 };
    throw error;
  }
}

function equal(left, right) {
  return left?.equals(right) === true;
}

function atomicRestore(file, before, expectedCurrent) {
  const current = snapshot(file);
  if (current.exists !== expectedCurrent.exists || (current.exists && !equal(current.bytes, expectedCurrent.bytes))) {
    return false;
  }
  if (!before.exists) {
    fs.unlinkSync(file);
    return true;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.aicc-restore`;
  fs.writeFileSync(temporary, before.bytes, { mode: before.mode });
  try { fs.chmodSync(temporary, before.mode); } catch { /* Windows ACL */ }
  fs.renameSync(temporary, file);
  return true;
}

function rootCatalogLineCandidates(content) {
  const candidates = [];
  const firstTable = content.search(/^\s*\[/m);
  const expression = /^[ \t]*model_catalog_json[ \t]*=.*(?:\r?\n|$)/gm;
  for (const match of content.matchAll(expression)) {
    if (firstTable !== -1 && match.index >= firstTable) continue;
    const start = match.index;
    const end = start + match[0].length;
    candidates.push(content.slice(0, start) + content.slice(end));
    if (end < content.length && /^\r?\n/.test(content.slice(end))) {
      candidates.push(content.slice(0, start) + content.slice(end).replace(/^\r?\n/, ''));
    }
  }
  return candidates;
}

export function classifyOcxRouteMutation(before, after) {
  if (before === after) return 'unchanged';
  return rootCatalogLineCandidates(after).includes(before)
    ? 'ocx_catalog_pointer_only'
    : 'conflict';
}

function ocxInvalidatedCache(bytes, catalogBytes) {
  if (!bytes || !catalogBytes) return false;
  try {
    const cache = JSON.parse(bytes.toString('utf8'));
    const catalog = JSON.parse(catalogBytes.toString('utf8'));
    return cache?.fetched_at === '2000-01-01T00:00:00Z'
      && cache?.client_version === '0.0.0'
      && JSON.stringify(cache?.models) === JSON.stringify(catalog?.models ?? catalog);
  } catch {
    return false;
  }
}

export function reconcileOcxStartupFiles({ codexHome, beforeConfig, beforeCache }) {
  const config = path.join(codexHome, 'config.toml');
  const cache = path.join(codexHome, 'models_cache.json');
  const catalog = path.join(codexHome, 'opencodex-catalog.json');
  const currentConfig = snapshot(config);
  const currentCache = snapshot(cache);
  const currentCatalog = snapshot(catalog);
  let route = 'unchanged';
  let modelCache = 'unchanged';

  if (beforeConfig.exists !== currentConfig.exists) {
    route = 'conflict';
  } else if (beforeConfig.exists && !equal(beforeConfig.bytes, currentConfig.bytes)) {
    const mutation = classifyOcxRouteMutation(
      beforeConfig.bytes.toString('utf8'),
      currentConfig.bytes.toString('utf8')
    );
    route = mutation === 'ocx_catalog_pointer_only'
      ? (atomicRestore(config, beforeConfig, currentConfig) ? 'restored' : 'conflict')
      : 'conflict';
  }

  const cacheChanged = beforeCache.exists !== currentCache.exists
    || (beforeCache.exists && currentCache.exists && !equal(beforeCache.bytes, currentCache.bytes));
  if (cacheChanged) {
    modelCache = ocxInvalidatedCache(currentCache.bytes, currentCatalog.bytes)
      ? (atomicRestore(cache, beforeCache, currentCache) ? 'restored' : 'conflict')
      : 'preserved_non_ocx_change';
  }
  return { route, modelCache, ok: route !== 'conflict' };
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(temporary, 0o600); } catch { /* Windows ACL */ }
  fs.renameSync(temporary, file);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`unexpected_argument:${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing_value:${key}`);
    values[key.slice(2)] = value;
    index += 1;
  }
  const port = Number(values.port ?? 10100);
  const maxRestarts = Number(values['max-restarts'] ?? 2);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid_port');
  if (!Number.isInteger(maxRestarts) || maxRestarts < 0 || maxRestarts > 2) throw new Error('invalid_restart_budget');
  const stateFile = values['state-file'] ?? path.join(os.homedir(), '.ai-control-center', 'runtime', 'ocx-upstream-service.json');
  const codexHome = values['codex-home'] ?? process.env.CODEX_HOME?.trim() ?? path.join(os.homedir(), '.codex');
  const serviceCodexHome = values['service-codex-home'] ?? path.join(path.dirname(stateFile), 'ocx-upstream-codex-home');
  if (path.resolve(serviceCodexHome) === path.resolve(codexHome)) throw new Error('service_codex_home_must_be_isolated');
  return {
    ocx: values.ocx ?? 'ocx',
    port,
    maxRestarts,
    home: values.home ?? os.homedir(),
    codexHome,
    serviceCodexHome,
    opencodexHome: values['opencodex-home'] ?? process.env.OPENCODEX_HOME?.trim() ?? path.join(os.homedir(), '.opencodex'),
    stateFile
  };
}

export function validateOcxHealthPayload(body, port) {
  return body?.status === 'ok'
    && body?.service === 'opencodex'
    && body?.port === port
    && Number.isInteger(body?.pid)
    && body.pid > 0
    ? { ready: true, servicePid: body.pid }
    : { ready: false, servicePid: null };
}

export function validateOcxReadinessPayload(body, port) {
  return body?.status === 'ready'
    && body?.service === 'opencodex'
    && body?.port === port
    && Number.isInteger(body?.pid)
    && body.pid > 0
    ? { ready: true, servicePid: body.pid }
    : { ready: false, servicePid: null };
}

export function inspectOcxUpstreamOnlyIntent(opencodexHome) {
  const configFile = path.join(opencodexHome, 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return config?.clientIntegrations?.codex === false
      ? { ok: true, reason: null }
      : { ok: false, reason: 'codex_integration_not_disabled' };
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === 'ENOENT' ? 'config_missing' : 'config_unreadable'
    };
  }
}

async function healthIdentity(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) });
    const body = response.ok ? await response.json() : null;
    return validateOcxHealthPayload(body, port);
  } catch {
    return { ready: false, servicePid: null };
  }
}

async function readinessIdentity(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1_000) });
    const body = await response.json().catch(() => null);
    return response.ok
      ? validateOcxReadinessPayload(body, port)
      : { ready: false, servicePid: null };
  } catch {
    return { ready: false, servicePid: null };
  }
}

async function currentReadinessSample(options, child, artifact) {
  const [health, readiness] = await Promise.all([
    healthIdentity(options.port),
    readinessIdentity(options.port)
  ]);
  const servicePid = health.ready && readiness.ready && health.servicePid === readiness.servicePid
    ? health.servicePid
    : null;
  const currentListenerPid = listenerPid(options.port, options);
  const serviceStartToken = processStartToken(servicePid, options);
  const artifactCurrent = ocxArtifactStillCurrent(artifact);
  const current = child.exitCode == null
    && Number.isInteger(servicePid)
    && currentListenerPid === servicePid
    && typeof serviceStartToken === 'string'
    && artifactCurrent;
  const identity = current
    ? createHash('sha256').update(JSON.stringify({
      launcherPid: child.pid,
      servicePid,
      listenerPid: currentListenerPid,
      serviceStartToken,
      artifactRealpath: artifact.realpath,
      artifactSha256: artifact.sha256
    })).digest('hex')
    : null;
  return {
    current,
    identity,
    servicePid,
    listenerPid: currentListenerPid,
    serviceStartToken,
    artifactCurrent,
    healthReady: health.ready,
    readinessReady: readiness.ready
  };
}

async function monitorStartup(options, beforeConfig, beforeCache, child, attempt, artifact) {
  const requiredConsecutive = Number(options.readinessSamplesRequired ?? 3);
  if (!Number.isInteger(requiredConsecutive) || requiredConsecutive < 2 || requiredConsecutive > 20) {
    throw new Error('invalid_ocx_readiness_sample_count');
  }
  let proof = advanceOcxReadinessProof(null, null, requiredConsecutive);
  let sample = null;
  let last = { route: 'unchanged', modelCache: 'unchanged', ok: true };
  let lastWrittenState = null;
  let lastWrittenAt = 0;
  while (child.exitCode == null) {
    sample = await currentReadinessSample(options, child, artifact);
    last = reconcileOcxStartupFiles({ codexHome: options.codexHome, beforeConfig, beforeCache });
    proof = advanceOcxReadinessProof(proof, { ...sample, current: sample.current && last.ok }, requiredConsecutive);
    const state = proof.ready ? 'ready' : 'attention';
    const now = Date.now();
    if (state !== lastWrittenState || !proof.ready || now - lastWrittenAt >= 5_000) {
      atomicJson(options.stateFile, {
        schemaVersion: 2,
        state,
        topology: 'upstream-only',
        ownerPid: process.pid,
        launcherPid: child.pid,
        servicePid: sample.servicePid,
        listenerPid: sample.listenerPid,
        serviceStartToken: sample.serviceStartToken,
        launchArtifact: artifact,
        routeMutation: last.ok ? false : null,
        routeReconciliation: last.route,
        modelCacheReconciliation: last.modelCache,
        codexHomeIsolation: path.resolve(options.serviceCodexHome) !== path.resolve(options.codexHome),
        livenessCurrent: sample.healthReady,
        readinessCurrent: sample.readinessReady,
        artifactCurrent: sample.artifactCurrent,
        readinessProof: proof,
        attempt,
        restartBudget: options.maxRestarts,
        updatedAt: new Date(now).toISOString()
      });
      lastWrittenState = state;
      lastWrittenAt = now;
    }
    await sleep(proof.ready
      ? Number(options.readyProbeIntervalMs ?? 1_000)
      : Number(options.startupProbeIntervalMs ?? 250));
  }
  proof = advanceOcxReadinessProof(proof, null, requiredConsecutive);
  atomicJson(options.stateFile, {
    schemaVersion: 2,
    state: 'attention',
    topology: 'upstream-only',
    ownerPid: process.pid,
    launcherPid: child.pid,
    servicePid: sample?.servicePid ?? null,
    listenerPid: sample?.listenerPid ?? null,
    serviceStartToken: sample?.serviceStartToken ?? null,
    launchArtifact: artifact,
    routeMutation: last.ok ? false : null,
    routeReconciliation: last.route,
    modelCacheReconciliation: last.modelCache,
    codexHomeIsolation: path.resolve(options.serviceCodexHome) !== path.resolve(options.codexHome),
    livenessCurrent: false,
    readinessCurrent: false,
    artifactCurrent: ocxArtifactStillCurrent(artifact),
    readinessProof: proof,
    terminalReason: 'launcher_exit',
    attempt,
    restartBudget: options.maxRestarts,
    updatedAt: new Date().toISOString()
  });
  return { ...last, readinessProof: proof };
}

export function childEnvironment(options) {
  fs.mkdirSync(options.serviceCodexHome, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(options.serviceCodexHome, 0o700); } catch { /* Windows ACL */ }
  const env = {
    ...process.env,
    HOME: options.home,
    CODEX_HOME: options.serviceCodexHome,
    OPENCODEX_HOME: options.opencodexHome,
    OCX_SERVICE: '1'
  };
  if (!env.OPENCODEX_API_AUTH_TOKEN) {
    try {
      const token = fs.readFileSync(path.join(options.opencodexHome, 'service-api-token'), 'utf8').trim();
      if (token) env.OPENCODEX_API_AUTH_TOKEN = token;
    } catch { /* optional service auth */ }
  }
  return env;
}

export async function runOcxUpstreamService(options) {
  const upstreamOnlyIntent = inspectOcxUpstreamOnlyIntent(options.opencodexHome);
  if (!upstreamOnlyIntent.ok) {
    throw new Error(`ocx_upstream_only_intent_invalid:${upstreamOnlyIntent.reason}`);
  }
  const launchArtifact = sealOcxLaunchArtifact(options.ocx);
  let stopping = false;
  let currentChild = null;
  let releaseQuarantine = null;
  const onSignal = signal => {
    stopping = true;
    releaseQuarantine?.();
    if (currentChild?.exitCode == null) currentChild.kill(signal);
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGHUP', () => onSignal('SIGHUP'));

  for (let attempt = 0; attempt <= options.maxRestarts; attempt += 1) {
    const beforeConfig = snapshot(path.join(options.codexHome, 'config.toml'));
    const beforeCache = snapshot(path.join(options.codexHome, 'models_cache.json'));
    atomicJson(options.stateFile, {
      schemaVersion: 2,
      state: 'starting',
      topology: 'upstream-only',
      ownerPid: process.pid,
      launchArtifact,
      codexHomeIsolation: path.resolve(options.serviceCodexHome) !== path.resolve(options.codexHome),
      attempt,
      restartBudget: options.maxRestarts,
      updatedAt: new Date().toISOString()
    });
    currentChild = spawn(options.ocx, ['start', '--port', String(options.port)], {
      env: childEnvironment(options),
      stdio: 'inherit',
      shell: false,
      windowsHide: true
    });
    const monitor = monitorStartup(options, beforeConfig, beforeCache, currentChild, attempt, launchArtifact)
      .catch(error => {
        if (currentChild?.exitCode == null) currentChild.kill('SIGTERM');
        throw error;
      });
    const [[exitCode, signal]] = await Promise.all([once(currentChild, 'exit'), monitor]);
    currentChild = null;
    if (stopping) return 0;
    if (attempt < options.maxRestarts) {
      atomicJson(options.stateFile, {
        schemaVersion: 2,
        state: 'restarting',
        topology: 'upstream-only',
        ownerPid: process.pid,
        codexHomeIsolation: path.resolve(options.serviceCodexHome) !== path.resolve(options.codexHome),
        attempt,
        restartBudget: options.maxRestarts,
        lastExitCode: exitCode,
        lastSignal: signal,
        updatedAt: new Date().toISOString()
      });
      await sleep(attempt === 0 ? 1_000 : 5_000);
      continue;
    }
    atomicJson(options.stateFile, {
      schemaVersion: 2,
      state: 'quarantined',
      topology: 'upstream-only',
      ownerPid: process.pid,
      codexHomeIsolation: path.resolve(options.serviceCodexHome) !== path.resolve(options.codexHome),
      attempt,
      restartBudget: options.maxRestarts,
      lastExitCode: exitCode,
      lastSignal: signal,
      updatedAt: new Date().toISOString()
    });
    await new Promise(resolve => { releaseQuarantine = resolve; });
    return 1;
  }
  return 1;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    process.exitCode = await runOcxUpstreamService(options);
  } catch (error) {
    process.stderr.write(`ocx-upstream-service: ${error.message}\n`);
    process.exitCode = 1;
  }
}
