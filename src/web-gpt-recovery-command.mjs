import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { webGptCommand } from './lib/web-gpt-command.mjs';

const APP_NAME = 'Codex Web GPT';
const HEALTH_URL = 'http://127.0.0.1:17841/healthz';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function loopbackHttpOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
      || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')
      || url.search || url.hash) return null;
    return { origin: url.origin, port: Number(url.port || 80) };
  } catch {
    return null;
  }
}

function loopbackV1(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
      || url.username || url.password || !['/v1', '/v1/'].includes(url.pathname)
      || url.search || url.hash) return null;
    return { endpoint: `${url.origin}/v1`, port: Number(url.port || 80) };
  } catch {
    return null;
  }
}

export function repairStaleWebGptNativeUpstream(options = {}) {
  const home = options.home ?? os.homedir();
  const configPath = options.configPath ?? path.join(home, '.codex-chatgpt-web', 'config.json');
  const ocxConfigPath = options.ocxConfigPath ?? path.join(home, '.opencodex', 'config.json');
  const before = fs.readFileSync(configPath);
  const config = JSON.parse(before.toString('utf8').replace(/^\uFEFF/, ''));
  const ocxConfig = readJson(ocxConfigPath);
  const stale = loopbackV1(config?.nativeUpstreamBaseUrl);
  const client = ocxConfig?.runtimeRole === 'client'
    ? loopbackHttpOrigin(ocxConfig?.client?.serverUrl)
    : null;

  if (Number(config?.port) !== 17841) return { changed: false, reason: 'not-integrated-17841' };
  if (!client || client.port === 10100) return { changed: false, reason: 'ocx-not-remote-client' };
  if (!stale || stale.port !== 10100) return { changed: false, reason: 'no-known-stale-upstream' };

  const recoveryDir = path.join(home, '.codex-chatgpt-web', 'recovery', 'native-upstream-compat');
  fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(recoveryDir, 0o700); } catch { /* Windows best effort */ }
  const beforeHash = sha256(before);
  const backupPath = path.join(recoveryDir, `config.${beforeHash.slice(0, 16)}.json`);
  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, before, { flag: 'wx', mode: 0o600 });
    try { fs.chmodSync(backupPath, 0o600); } catch { /* Windows best effort */ }
  }

  const next = JSON.parse(before.toString('utf8').replace(/^\uFEFF/, ''));
  delete next.nativeUpstreamBaseUrl;
  const temporary = `${configPath}.aicc-native-upstream-${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const current = fs.readFileSync(configPath);
  if (sha256(current) !== beforeHash) {
    fs.rmSync(temporary, { force: true });
    throw new Error('Web GPT config changed during stale native-upstream repair; refusing overwrite');
  }
  fs.renameSync(temporary, configPath);
  try { fs.chmodSync(configPath, 0o600); } catch { /* Windows best effort */ }
  return {
    changed: true,
    reason: 'removed-stale-standalone-ocx-upstream',
    backupPath,
    previousEndpoint: stale.endpoint,
    clientEndpoint: `${client.origin}/v1`
  };
}

function processRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function processCommand(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 3_000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function isLauncherCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  return command.includes('/Codex Web GPT.app/Contents/MacOS/Codex Web GPT')
    || command === 'Codex Web GPT'
    || command.startsWith('Codex Web GPT ');
}

async function bridgeHealth(timeoutMs = 1_500) {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (!response.ok) return null;
    const body = await response.json();
    if (body?.service !== 'codex-chatgpt-web' || body?.status !== 'ok') return null;
    return body;
  } catch { return null; }
}

function launcherOwnership(home) {
  const runtimeRoot = path.join(home, '.codex-chatgpt-web', 'runtime');
  const descriptorPath = path.join(runtimeRoot, 'launcher-browser.json');
  const supervisorPath = path.join(runtimeRoot, 'launcher-supervisor.json');
  const descriptor = readJson(descriptorPath);
  const supervisor = readJson(supervisorPath);
  if (fs.existsSync(descriptorPath) && (!descriptor
    || descriptor.version !== 1
    || descriptor.kind !== 'codex-web-gpt-launcher'
    || !Number.isInteger(descriptor.pid)
    || descriptor.pid < 1
    || typeof descriptor.createdAt !== 'string'
    || Number.isNaN(Date.parse(descriptor.createdAt)))) {
    throw new Error('Codex Web GPT launcher browser ownership marker is invalid; refusing an unsafe restart');
  }
  if (fs.existsSync(supervisorPath) && (!supervisor
    || supervisor.version !== 1
    || !Number.isInteger(supervisor.ownerPid)
    || supervisor.ownerPid < 1
    || !(supervisor.daemonPid === null || (Number.isInteger(supervisor.daemonPid) && supervisor.daemonPid > 0))
    || typeof supervisor.status !== 'string'
    || typeof supervisor.updatedAt !== 'string'
    || Number.isNaN(Date.parse(supervisor.updatedAt)))) {
    throw new Error('Codex Web GPT launcher supervisor ownership marker is invalid; refusing an unsafe restart');
  }
  const descriptorPid = Number(descriptor?.pid);
  const ownerPid = Number(supervisor?.ownerPid);
  const daemonPid = Number(supervisor?.daemonPid);

  if (Number.isInteger(descriptorPid) && descriptorPid > 0
    && Number.isInteger(ownerPid) && ownerPid > 0
    && descriptorPid !== ownerPid) {
    throw new Error('Codex Web GPT launcher ownership markers disagree; refusing an unsafe restart');
  }

  return {
    ownerPid: Number.isInteger(ownerPid) && ownerPid > 0
      ? ownerPid
      : Number.isInteger(descriptorPid) && descriptorPid > 0 ? descriptorPid : null,
    daemonPid: Number.isInteger(daemonPid) && daemonPid > 0 ? daemonPid : null
  };
}

function assertExactIdle(health) {
  if (!health) {
    throw new Error('Web GPT bridge health and active turn counts are UNKNOWN; refusing restart');
  }
  const counters = {
    http: health.active_http_turns,
    browserHttp: health.active_browser_http_turns,
    browser: health.active_browser_turns
  };
  if (Object.values(counters).some(value => !Number.isInteger(value))) {
    throw new Error('Web GPT active turn counts are UNKNOWN; refusing restart');
  }
  if (Object.values(counters).some(value => value > 0)) {
    throw new Error(
      `Web GPT still has active work (http=${counters.http}, browser-http=${counters.browserHttp}, browser=${counters.browser}); refusing restart`
    );
  }
}

async function waitForExit(pid, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processRunning(pid)) return true;
    await sleep(200);
  }
  return !processRunning(pid);
}

function openLauncher() {
  const result = spawnSync('/usr/bin/open', ['-a', APP_NAME, '--args', '--hidden'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `open exited with ${result.status}`);
  }
}

function restartService(config, options = {}) {
  const platform = options.platform ?? process.platform;
  const runner = options.spawnSync ?? spawnSync;
  if (platform === 'win32') {
    const home = options.home ?? os.homedir();
    const configPath = options.configPath ?? path.join(home, '.codex-chatgpt-web', 'config.json');
    for (const args of [['runtime', 'stop', '--json'], ['runtime', 'start', '--json']]) {
      const resolved = webGptCommand(args, {
        executable: options.webGptExecutable,
        env: options.env ?? process.env,
        platform,
        home,
        configPath,
        readFile: options.readFile ?? fs.readFileSync
      });
      const result = runner(resolved.executable, resolved.args, {
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(result.stderr?.trim() || result.stdout?.trim()
          || `Web GPT runtime ${args[1]} exited with ${result.status}`);
      }
    }
    return;
  }

  const executable = Array.isArray(config?.runtimeCommand) ? config.runtimeCommand[0] : null;
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || !fs.existsSync(executable)) {
    throw new Error('Service-owned Web GPT has no exact durable runtime executable; refusing restart');
  }
  const result = runner(executable, ['service', 'restart'], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `Web GPT service restart exited with ${result.status}`);
  }
}

async function waitForReady(previousBridgePid, options = {}) {
  const serviceRestarted = options.serviceRestarted === true;
  const requireBrowser = options.requireBrowser === true;
  const readHealth = options.bridgeHealth ?? bridgeHealth;
  const wait = options.sleep ?? sleep;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let lastHealth = null;
  while (Date.now() < deadline) {
    const health = await readHealth(1_500);
    if (health) lastHealth = health;
    const expectedProcess = !previousBridgePid || health?.pid !== previousBridgePid;
    if (health?.accepting_turns === true
      && (!requireBrowser || health?.accepting_browser_turns === true)
      && Number.isInteger(health.pid)
      && expectedProcess) return health;
    await wait(300);
  }
  const component = serviceRestarted ? 'service router' : 'launcher runtime';
  throw new Error(`Codex Web GPT ${component} did not return ready after restart${lastHealth ? ` (last pid=${lastHealth.pid ?? 'unknown'})` : ''}`);
}

export async function recoverWebGptLauncher(options = {}) {
  const platform = options.platform ?? process.platform;
  if (!['darwin', 'win32'].includes(platform)) {
    throw new Error('Web GPT recovery is supported only on macOS or service-owned Windows runtimes');
  }

  const home = options.home ?? os.homedir();
  const configPath = options.configPath ?? path.join(home, '.codex-chatgpt-web', 'config.json');
  const readHealth = options.bridgeHealth ?? bridgeHealth;
  const before = await readHealth();
  const config = readJson(configPath);
  const serviceOwned = before?.runtime_owner === 'service' || config?.runtimeOwner === 'service';
  assertExactIdle(before);

  if (serviceOwned) {
    const nativeUpstreamRepair = repairStaleWebGptNativeUpstream({
      home,
      configPath,
      ocxConfigPath: options.ocxConfigPath
    });
    await (options.restartService ?? restartService)(config, {
      ...options,
      home,
      platform,
      configPath
    });
    const after = await waitForReady(before.pid ?? null, {
      serviceRestarted: true,
      requireBrowser: false,
      bridgeHealth: readHealth,
      sleep: options.sleep,
      timeoutMs: options.timeoutMs
    });
    return {
      ok: true,
      restarted: true,
      previousBridgePid: before.pid ?? null,
      bridgePid: after.pid,
      routerOwner: 'service',
      routerRestarted: true,
      browserHostRestarted: false,
      nativeUpstreamRepair,
      acceptingTurns: after.accepting_turns === true,
      acceptingBrowserTurns: after.accepting_browser_turns === true,
      activeHttpTurns: after.active_http_turns ?? null,
      activeBrowserTurns: after.active_browser_turns ?? null
    };
  }

  if (platform !== 'darwin') {
    throw new Error('Launcher-owned Web GPT recovery is currently supported only on macOS');
  }

  const ownership = launcherOwnership(home);

  if (before && !ownership.ownerPid) {
    throw new Error('Web GPT is reachable but launcher ownership cannot be verified; refusing an unsafe restart');
  }
  if (before && !serviceOwned && ownership.daemonPid && before.pid !== ownership.daemonPid) {
    throw new Error('Web GPT bridge pid does not match launcher ownership; refusing an unsafe restart');
  }

  const ownerAlive = processRunning(ownership.ownerPid);
  if (ownerAlive) {
    const ownerCommand = (options.processCommand ?? processCommand)(ownership.ownerPid);
    if (!isLauncherCommand(ownerCommand)) {
      throw new Error('Launcher ownership PID does not belong to Codex Web GPT; refusing an unsafe restart');
    }
  }
  if (before && !ownerAlive) {
    throw new Error('Web GPT is reachable but its launcher owner is not running; refusing an unsafe restart');
  }

  if (ownerAlive) {
    process.kill(ownership.ownerPid, 'SIGTERM');
    if (!await waitForExit(ownership.ownerPid)) {
      throw new Error('Codex Web GPT launcher refused graceful shutdown; no force kill was attempted');
    }
  }

  openLauncher();
  const after = await waitForReady(before?.pid ?? null, {
    serviceRestarted: false,
    requireBrowser: true,
    bridgeHealth: readHealth,
    sleep: options.sleep,
    timeoutMs: options.timeoutMs
  });
  return {
    ok: true,
    restarted: ownerAlive,
    previousBridgePid: before?.pid ?? null,
    bridgePid: after.pid,
    routerOwner: 'launcher',
    routerRestarted: before?.pid !== after.pid,
    browserHostRestarted: true,
    acceptingTurns: after.accepting_turns === true,
    acceptingBrowserTurns: after.accepting_browser_turns === true,
    activeHttpTurns: after.active_http_turns ?? null,
    activeBrowserTurns: after.active_browser_turns ?? null
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  recoverWebGptLauncher()
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => {
      process.stderr.write(`web-gpt-recovery: ${error.message}\n`);
      process.exitCode = 1;
    });
}
