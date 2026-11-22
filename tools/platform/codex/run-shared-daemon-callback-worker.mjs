#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { restartCodexDesktopOnce } from '../../../src/codex-desktop-restart.mjs';
import { CodexTaskCallbackService } from '../../../src/codex-task-callback.mjs';
import { inspectNativeCallbackSafety } from '../../../src/codex-callback-safety.mjs';
import { CodexAppServerClient, loadAppServerManifest } from '../../../src/adapters/codex-app-server.mjs';
import { createCodexAppServerDaemonSpawn, validateOwnerOnlyUnixSocket } from '../../../src/adapters/codex-app-server-daemon.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function required(name, pattern = null) {
  const value = String(option(name) ?? '').trim();
  if (!value || (pattern && !pattern.test(value))) throw new Error(`invalid_option:${name}`);
  return value;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true, ...options });
  return {
    status: Number.isInteger(result.status) ? result.status : null,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
    error: result.error ?? null
  };
}

function atomicPrivateJson(file, value) {
  const parent = fs.realpathSync(path.dirname(file));
  if (parent !== path.dirname(file)) throw new Error('result_parent_alias');
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || (process.platform !== 'win32' && (parentStat.mode & 0o077) !== 0)) throw new Error('result_parent_unsafe');
  if (typeof process.getuid === 'function' && parentStat.uid !== process.getuid()) throw new Error('result_parent_owner_unsafe');
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function formatKstTimestamp(milliseconds = Date.now()) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(new Date(milliseconds));
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second} KST`;
}

function daemonStatus(desktopCodex) {
  const result = run(desktopCodex, ['app-server', 'daemon', 'version']);
  let value = null;
  try { value = result.status === 0 ? JSON.parse(result.stdout) : null; } catch { value = null; }
  return {
    ok: result.status === 0 && value?.status === 'running',
    status: value?.status ?? 'unknown',
    managedCodexPath: value?.managedCodexPath ?? null,
    managedCodexVersion: value?.managedCodexVersion ?? null,
    appServerVersion: value?.appServerVersion ?? null,
    socketPath: value?.socketPath ?? null
  };
}

async function inspectDaemonThread({ daemonCodex, manifestFile, taskId, projectRoot, socketPath }) {
  const manifest = loadAppServerManifest(manifestFile);
  const root = fs.realpathSync(projectRoot);
  const client = new CodexAppServerClient({
    executable: fs.realpathSync(daemonCodex),
    cwd: root,
    env: { ...process.env, AICC_CODEX_VERSION: manifest.codexVersion },
    manifest,
    spawnProcess: createCodexAppServerDaemonSpawn({ socketPath }),
    timeoutMs: 30_000
  });
  try {
    await client.connect();
    const response = await client.threadRead({ threadId: taskId, includeTurns: false });
    const thread = response?.thread;
    let observedRoot = null;
    try { observedRoot = thread?.cwd ? fs.realpathSync(thread.cwd) : null; } catch { observedRoot = null; }
    const status = thread?.status?.type ?? null;
    return {
      ok: thread?.id === taskId && observedRoot === root && ['idle', 'notLoaded'].includes(status),
      taskId: thread?.id ?? null,
      projectRoot: observedRoot,
      status
    };
  } finally {
    client.close();
  }
}

function desktopUsesSharedDaemon(desktopPid, socketPath, desktopCodex) {
  validateOwnerOnlyUnixSocket(socketPath);
  const environment = run('ps', ['eww', '-p', String(desktopPid), '-o', 'command=']);
  const processes = run('ps', ['-axo', 'pid=,ppid=,command=']);
  const version = run(desktopCodex, ['app-server', 'daemon', 'version']);
  let daemon = null;
  try { daemon = version.status === 0 ? JSON.parse(version.stdout) : null; } catch { daemon = null; }
  const separateAppServer = processes.stdout.split('\n').some(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    return match && Number(match[2]) === desktopPid && /\/Contents\/Resources\/codex\b.*\bapp-server\b/.test(match[3]);
  });
  return {
    ok: environment.status === 0
      && /(?:^|\s)CODEX_APP_SERVER_USE_LOCAL_DAEMON=1(?:\s|$)/.test(environment.stdout)
      && !separateAppServer
      && daemon?.status === 'running'
      && daemon?.socketPath === socketPath,
    environmentEnabled: /(?:^|\s)CODEX_APP_SERVER_USE_LOCAL_DAEMON=1(?:\s|$)/.test(environment.stdout),
    separateAppServer,
    daemonVersion: daemon?.appServerVersion ?? null,
    socketPath: daemon?.socketPath ?? null
  };
}

export async function runSharedDaemonCallbackWorker(options = {}) {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('shared_daemon_callback_requires_macos');
  const runCommand = options.runCommand ?? run;
  const validateSocket = options.validateSocket ?? validateOwnerOnlyUnixSocket;
  const restartDesktop = options.restartDesktop ?? restartCodexDesktopOnce;
  const inspectSharedDaemon = options.inspectSharedDaemon ?? desktopUsesSharedDaemon;
  const inspectDaemon = options.inspectDaemon ?? daemonStatus;
  const inspectThread = options.inspectDaemonThread ?? inspectDaemonThread;
  const inspectNativeRoute = options.inspectNativeRoute ?? inspectNativeCallbackSafety;
  const writeResult = options.writeResult ?? atomicPrivateJson;
  const callbackId = options.callbackId;
  const operationId = options.operationId;
  const resultFile = options.resultFile;
  const deliveryResultFile = options.deliveryResultFile ?? path.join(path.dirname(resultFile), 'callback-delivery.json');
  const expectedDesktopPid = Number(options.expectedDesktopPid);
  const socketPath = validateSocket(options.socketPath);
  const desktopCodex = fs.realpathSync(options.desktopCodex);
  const daemonCodex = fs.realpathSync(options.daemonCodex);
  const manifestFile = fs.realpathSync(options.manifestFile);
  const taskId = String(options.taskId ?? '').trim();
  const projectRoot = fs.realpathSync(options.projectRoot);
  const expectedDaemonVersion = String(options.expectedDaemonVersion ?? loadAppServerManifest(manifestFile).codexVersion).trim();
  if (!SAFE_ID.test(callbackId) || !SAFE_ID.test(operationId)) throw new Error('callback_identity_invalid');
  if (!SAFE_ID.test(taskId)) throw new Error('callback_task_identity_invalid');
  if (!Number.isInteger(expectedDesktopPid) || expectedDesktopPid <= 1) throw new Error('expected_desktop_pid_invalid');
  if (!path.isAbsolute(resultFile) || fs.existsSync(resultFile)) throw new Error('result_file_invalid');
  if (!path.isAbsolute(deliveryResultFile) || fs.existsSync(deliveryResultFile)) throw new Error('delivery_result_file_invalid');
  const previousEnvironment = runCommand('launchctl', ['getenv', 'CODEX_APP_SERVER_USE_LOCAL_DAEMON']);
  const environmentWasEnabled = previousEnvironment.status === 0 && previousEnvironment.stdout === '1';
  let environmentChanged = false;
  let restart = null;
  let callback = null;
  try {
    const nativeBefore = inspectNativeRoute();
    if (!nativeBefore?.ok) throw Object.assign(new Error('callback_native_route_preflight_failed'), { nativeRoute: nativeBefore });
    const daemonBefore = inspectDaemon(desktopCodex);
    let managedCodex = null;
    try { managedCodex = daemonBefore?.managedCodexPath ? fs.realpathSync(daemonBefore.managedCodexPath) : null; } catch { managedCodex = null; }
    if (!daemonBefore?.ok
      || daemonBefore.appServerVersion !== expectedDaemonVersion
      || daemonBefore.socketPath !== socketPath
      || managedCodex !== daemonCodex) {
      throw Object.assign(new Error('shared_daemon_identity_mismatch'), { shared: daemonBefore });
    }
    const threadBefore = await inspectThread({ daemonCodex, manifestFile, taskId, projectRoot, socketPath });
    if (!threadBefore?.ok) {
      throw Object.assign(new Error('shared_daemon_thread_scope_mismatch'), { shared: { ...daemonBefore, thread: threadBefore } });
    }
    if (!environmentWasEnabled) {
      const enabled = runCommand('launchctl', ['setenv', 'CODEX_APP_SERVER_USE_LOCAL_DAEMON', '1']);
      if (enabled.status !== 0) throw new Error('shared_daemon_environment_enable_failed');
      environmentChanged = true;
    }
    restart = restartDesktop({
      expectedPid: expectedDesktopPid,
      maxSamples: Number(options.maxSamples ?? 3_600),
      progress: event => process.stdout.write(`[${formatKstTimestamp()}] ${event.percent}% ${event.step}: ${event.detail}\n`)
    });
    const shared = inspectSharedDaemon(restart.newPid, socketPath, desktopCodex);
    if (!shared.ok || shared.daemonVersion !== expectedDaemonVersion) {
      throw Object.assign(new Error('desktop_shared_daemon_postcondition_failed'), { shared });
    }
    const nativeAfter = inspectNativeRoute();
    if (!nativeAfter?.ok || nativeAfter.compactRoute !== nativeBefore.compactRoute) {
      throw Object.assign(new Error('callback_native_route_postcondition_failed'), { nativeRoute: nativeAfter });
    }
    const document = {
      operation: operationId,
      status: 'PASS',
      completedAt: new Date().toISOString(),
      desktop: { oldPid: restart.oldPid, newPid: restart.newPid, restartCount: restart.restartCount, forcedTermination: restart.forcedTermination },
      sharedDaemon: shared,
      nativeRoute: { state: nativeAfter.state, compactRoute: nativeAfter.compactRoute, rescueReady: nativeAfter.nativeRescue?.ready === true }
    };
    writeResult(resultFile, document);
    const resultSha256 = crypto.createHash('sha256').update(fs.readFileSync(resultFile)).digest('hex');
    callback = await (options.callbackService ?? new CodexTaskCallbackService()).complete({
      callbackId,
      expectedResultSha256: resultSha256,
      timeoutMs: Number(options.callbackTimeoutMs ?? 12 * 60 * 60_000)
    });
    const delivery = {
      operation: operationId,
      status: callback.ok === true ? 'PASS' : 'HOLD',
      completedAt: new Date().toISOString(),
      callback: {
        callbackId,
        state: callback.state,
        turnId: callback.turnId ?? null,
        terminalTurnStatus: callback.terminalTurnStatus ?? null,
        resultSha256
      }
    };
    writeResult(deliveryResultFile, delivery);
    if (!callback.ok) throw Object.assign(new Error(`callback_turn_${callback.terminalTurnStatus ?? 'not_completed'}`), { callback });
    return { ok: true, operationId, resultFile, deliveryResultFile, resultSha256, restart, sharedDaemon: shared, callback };
  } catch (error) {
    if (!fs.existsSync(resultFile)) {
      writeResult(resultFile, {
        operation: operationId,
        status: 'HOLD',
        completedAt: new Date().toISOString(),
        reason: error.message,
        desktop: restart == null ? null : { oldPid: restart.oldPid, newPid: restart.newPid, forcedTermination: restart.forcedTermination },
        sharedDaemon: error.shared ?? null
      });
    }
    if (!fs.existsSync(deliveryResultFile)) {
      writeResult(deliveryResultFile, {
        operation: operationId,
        status: 'HOLD',
        completedAt: new Date().toISOString(),
        reason: error.message,
        callback: callback == null ? null : {
          callbackId,
          state: callback.state,
          turnId: callback.turnId ?? null,
          terminalTurnStatus: callback.terminalTurnStatus ?? null
        },
        nativeRoute: error.nativeRoute == null ? null : {
          state: error.nativeRoute.state ?? 'UNKNOWN',
          compactRoute: error.nativeRoute.compactRoute ?? null,
          rescueReady: error.nativeRoute.nativeRescue?.ready === true
        }
      });
    }
    if (environmentChanged && restart == null) runCommand('launchctl', ['unsetenv', 'CODEX_APP_SERVER_USE_LOCAL_DAEMON']);
    throw error;
  }
}

async function main() {
  const result = await runSharedDaemonCallbackWorker({
    callbackId: required('--callback', SAFE_ID),
    operationId: required('--operation', SAFE_ID),
    resultFile: required('--result-file'),
    deliveryResultFile: option('--delivery-result-file') ?? undefined,
    expectedDesktopPid: required('--expected-desktop-pid', /^\d+$/),
    socketPath: required('--socket'),
    desktopCodex: required('--desktop-codex'),
    daemonCodex: required('--daemon-codex'),
    manifestFile: required('--manifest'),
    taskId: required('--task', SAFE_ID),
    projectRoot: required('--project-root'),
    expectedDaemonVersion: option('--expected-daemon-version') ?? undefined,
    maxSamples: option('--max-samples') ?? 3_600
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`HOLD: ${error.message}\n`);
    process.exitCode = 1;
  });
}
