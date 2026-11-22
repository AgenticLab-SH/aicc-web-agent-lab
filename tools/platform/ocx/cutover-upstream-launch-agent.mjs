#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexConfigFingerprint } from '../../../src/ocx-upstream-sync-command.mjs';
import { installOcxUpstreamLaunchAgent } from './install-upstream-launch-agent.mjs';

const label = 'com.opencodex.proxy';

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function run(spawn, command, args, options = {}) {
  const result = spawn(command, args, { encoding: 'utf8', ...options });
  return {
    status: Number.isInteger(result?.status) ? result.status : null,
    stdout: String(result?.stdout || ''),
    stderr: String(result?.stderr || ''),
    error: result?.error ?? null
  };
}

function activeState(spawn, ocx, env) {
  const result = run(spawn, ocx, ['system', 'status', '--json'], { env, timeout: 8_000 });
  if (result.status !== 0) return { activeTurns: null, draining: null, pid: null, routingInjected: null };
  try {
    const payload = JSON.parse(result.stdout);
    return {
      activeTurns: Number.isInteger(payload?.memory?.activeTurnCount) ? payload.memory.activeTurnCount : null,
      draining: typeof payload?.memory?.isDraining === 'boolean' ? payload.memory.isDraining : null,
      pid: Number.isInteger(payload?.memory?.pid) ? payload.memory.pid : null,
      routingInjected: typeof payload?.startup?.routingInjected === 'boolean' ? payload.startup.routingInjected : null
    };
  } catch {
    return { activeTurns: null, draining: null, pid: null, routingInjected: null };
  }
}

function health(spawn, port) {
  return run(spawn, 'curl', [
    '--fail', '--silent', '--show-error', '--max-time', '2',
    `http://127.0.0.1:${port}/healthz`
  ]);
}

function registration(spawn, domain) {
  return run(spawn, 'launchctl', ['print', `${domain}/${label}`]);
}

function progressLine(event) {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  return `[${time}] ${String(event.percent).padStart(3)}% | ${event.step.padEnd(22)} | ETA ${event.eta.padEnd(10)} | ${event.detail}`;
}

function defaultProgress(event) {
  process.stderr.write(`${progressLine(event)}\n`);
}

function resultMessage(result) {
  return [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
}

export function cutoverOcxUpstreamLaunchAgent(options = {}) {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('OCX upstream cutover는 macOS에서만 지원합니다.');
  const home = options.home ?? os.homedir();
  const root = options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const ocx = options.ocx ?? process.env.AICC_OCX_EXECUTABLE?.trim() ?? 'ocx';
  const codexHome = options.codexHome ?? path.join(home, '.codex');
  const port = Number(options.port ?? 10100);
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  const domain = `gui/${uid}`;
  const spawn = options.spawnSync ?? spawnSync;
  const wait = options.pause ?? pause;
  const emit = options.progress ?? defaultProgress;
  const install = options.install ?? installOcxUpstreamLaunchAgent;
  const now = options.now ?? Date.now;
  const fingerprint = options.fingerprint ?? (() => codexConfigFingerprint({ ...process.env, CODEX_HOME: codexHome }));
  const zeroSamplesRequired = Number(options.zeroSamplesRequired ?? 5);
  const sampleIntervalMs = Number(options.sampleIntervalMs ?? 2_000);
  const drainTimeoutMs = Number(options.drainTimeoutMs ?? 20 * 60_000);
  const maxDrainSamples = Number(options.maxDrainSamples ?? Math.ceil(drainTimeoutMs / Math.max(1, sampleIntervalMs)) + 1);
  const stopWaitAttempts = Number(options.stopWaitAttempts ?? 80);
  const recoveryWaitAttempts = Number(options.recoveryWaitAttempts ?? 80);
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome };
  if (!Number.isInteger(uid) || uid < 0) throw new Error('macOS 사용자 UID를 확인할 수 없습니다.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid_ocx_port');
  if (!Number.isInteger(zeroSamplesRequired) || zeroSamplesRequired < 2 || zeroSamplesRequired > 20) throw new Error('invalid_zero_sample_count');
  if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs < 0) throw new Error('invalid_sample_interval');
  if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 1_000) throw new Error('invalid_drain_timeout');
  if (!Number.isInteger(maxDrainSamples) || maxDrainSamples < zeroSamplesRequired) throw new Error('invalid_max_drain_samples');

  let stopAttempted = false;
  let installCompleted = false;
  let lastPid = null;
  const beforeFingerprint = fingerprint();
  if (beforeFingerprint === 'unresolved' || beforeFingerprint === 'unreadable') {
    throw new Error('codex_config_fingerprint_unavailable');
  }

  const recoverOnce = () => {
    if (!stopAttempted || installCompleted || health(spawn, port).status === 0) return 'not-needed';
    emit({ percent: 92, step: 'emergency recovery', eta: '30-60s', detail: 'Starting the previous OCX service once.' });
    const recovered = run(spawn, ocx, ['service', 'start'], { env, timeout: 60_000 });
    if (recovered.status !== 0) return `service-start-failed:${recovered.status ?? 'UNKNOWN'}`;
    for (let attempt = 0; attempt < recoveryWaitAttempts; attempt += 1) {
      if (health(spawn, port).status === 0) return '10100-healthy';
      wait(250);
    }
    return 'service-started-health-unknown';
  };

  try {
    emit({ percent: 2, step: 'preflight', eta: '1-2m', detail: 'Checking exact OCX state and preserving the active Codex route fingerprint.' });
    const previousRegistration = registration(spawn, domain);
    const deadline = now() + drainTimeoutMs;
    let consecutive = 0;
    emit({ percent: 10, step: 'zero-active wait', eta: 'up to 20m', detail: `Waiting for ${zeroSamplesRequired} consecutive zero-active samples.` });
    let samplesTaken = 0;
    while (now() < deadline && samplesTaken < maxDrainSamples) {
      samplesTaken += 1;
      const sample = activeState(spawn, ocx, env);
      if (sample.routingInjected === true) throw new Error('ocx_cutover_refuses_injected_codex_route');
      if (sample.activeTurns === 0 && sample.draining === false && Number.isInteger(sample.pid) && sample.pid > 0) {
        if (lastPid !== null && sample.pid !== lastPid) consecutive = 0;
        lastPid = sample.pid;
        consecutive += 1;
        emit({
          percent: Math.min(20, 10 + consecutive * 2),
          step: 'zero-active wait',
          eta: `${Math.max(0, zeroSamplesRequired - consecutive) * Math.ceil(sampleIntervalMs / 1_000)}s`,
          detail: `zero sample ${consecutive}/${zeroSamplesRequired}`
        });
        if (consecutive >= zeroSamplesRequired) break;
      } else {
        consecutive = 0;
        lastPid = sample.pid;
      }
      wait(sampleIntervalMs);
    }
    if (consecutive < zeroSamplesRequired) throw new Error('ocx_zero_window_timeout');

    emit({ percent: 30, step: 'graceful handoff', eta: '10-30s', detail: 'Unloading the exact launchd owner; OCX handles SIGTERM with its bounded graceful drain.' });
    stopAttempted = true;
    if (previousRegistration.status !== 0) throw new Error('ocx_cutover_requires_managed_launchd_owner');
    const stopped = run(spawn, 'launchctl', ['bootout', `${domain}/${label}`], { timeout: 90_000 });
    for (let attempt = 0; attempt < stopWaitAttempts; attempt += 1) {
      if (health(spawn, port).status !== 0 && registration(spawn, domain).status !== 0) break;
      wait(250);
    }
    const stoppedHealth = health(spawn, port);
    const stoppedRegistration = registration(spawn, domain);
    if (stopped.status !== 0) throw new Error(`ocx_graceful_handoff_failed:${stopped.status ?? 'UNKNOWN'}:${resultMessage(stopped)}`);
    if (stoppedHealth.status === 0) throw new Error('ocx_listener_survived_graceful_stop');
    if (stoppedRegistration.status === 0) throw new Error('ocx_owner_survived_graceful_stop');
    if (fingerprint() !== beforeFingerprint) throw new Error('codex_route_config_changed_during_handoff');

    emit({ percent: 55, step: 'isolated install', eta: '20-40s', detail: 'Installing the bounded KeepAlive=false owner with a separate service CODEX_HOME.' });
    const installed = install({
      ...options.installOptions,
      platform: options.platform ?? process.platform,
      home,
      root,
      ocx,
      codexHome,
      port,
      uid,
      spawnSync: spawn,
      pause: wait,
      activeState: { activeTurns: 0, draining: false },
      previousRegistration,
      previousHealth: stoppedHealth,
      fingerprint
    });
    installCompleted = true;
    emit({ percent: 100, step: 'PASS', eta: 'done', detail: 'Managed isolated OCX is healthy; a foreground terminal is not required.' });
    return {
      ok: true,
      zeroSamples: zeroSamplesRequired,
      stoppedPid: lastPid,
      recovery: 'not-needed',
      ...installed
    };
  } catch (error) {
    const recovery = recoverOnce();
    emit({ percent: 100, step: 'HOLD', eta: 'done', detail: `${error.message}; recovery=${recovery}` });
    throw new Error(`${error.message};recovery=${recovery}`);
  }
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.stdout.write(`${JSON.stringify(cutoverOcxUpstreamLaunchAgent())}\n`);
  } catch (error) {
    process.stderr.write(`ocx-upstream-cutover: ${error.message}\n`);
    process.exitCode = 1;
  }
}
