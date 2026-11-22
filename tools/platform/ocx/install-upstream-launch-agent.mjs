#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexConfigFingerprint } from '../../../src/ocx-upstream-sync-command.mjs';
import { inspectOcxUpstreamOnlyIntent } from '../../../src/ocx-upstream-service-wrapper.mjs';

const label = 'com.opencodex.proxy';

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function launchdMessage(result) {
  return (result?.stderr || result?.stdout || '').trim();
}

function transientBootstrapFailure(result) {
  return result?.status === 5 || /Bootstrap failed:\s*5|Input\/output error/i.test(launchdMessage(result));
}

function exactRegistration(result, { node, wrapper }) {
  if (result?.status !== 0) return false;
  const output = String(result.stdout || '');
  return output.includes(`program = ${node}`) && output.includes(wrapper);
}

function registeredLabel(result) {
  return result?.status === 0 && /state = (?:running|waiting|spawn scheduled|spawned)/.test(String(result.stdout || ''));
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function body({ node, wrapper, ocx, home, codexHome, serviceCodexHome, opencodexHome, stateFile, logs, port }) {
  const args = [
    node, wrapper,
    '--ocx', ocx,
    '--port', String(port),
    '--home', home,
    '--codex-home', codexHome,
    '--service-codex-home', serviceCodexHome,
    '--opencodex-home', opencodexHome,
    '--state-file', stateFile,
    '--max-restarts', '2'
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'ocx-upstream.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'ocx-upstream.error.log'))}</string>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
<key>HOME</key><string>${xml(home)}</string><key>CODEX_HOME</key><string>${xml(serviceCodexHome)}</string>
<key>OPENCODEX_HOME</key><string>${xml(opencodexHome)}</string><key>OCX_SERVICE</key><string>1</string>
</dict></dict></plist>
`;
}

function readActiveState(spawn, ocx) {
  const result = spawn(ocx, ['system', 'status', '--json'], { encoding: 'utf8', timeout: 8_000 });
  if (result.status !== 0) return { activeTurns: null, draining: null };
  try {
    const payload = JSON.parse(result.stdout);
    return {
      activeTurns: Number.isInteger(payload?.memory?.activeTurnCount) ? payload.memory.activeTurnCount : null,
      draining: typeof payload?.memory?.isDraining === 'boolean' ? payload.memory.isDraining : null
    };
  } catch {
    return { activeTurns: null, draining: null };
  }
}

function timestamp(now = new Date()) {
  return now.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function installOcxUpstreamLaunchAgent(options = {}) {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('OCX upstream LaunchAgent는 macOS에서만 지원합니다.');
  const home = options.home ?? os.homedir();
  const root = options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const node = options.node ?? process.execPath;
  const wrapper = options.wrapper ?? path.join(root, 'src', 'ocx-upstream-service-wrapper.mjs');
  const requestedOcx = options.ocx ?? process.env.AICC_OCX_EXECUTABLE?.trim() ?? '/opt/homebrew/bin/ocx';
  const codexHome = options.codexHome ?? path.join(home, '.codex');
  const opencodexHome = options.opencodexHome ?? path.join(home, '.opencodex');
  const stateRoot = options.stateRoot ?? path.join(home, '.ai-control-center');
  const stateFile = path.join(stateRoot, 'runtime', 'ocx-upstream-service.json');
  const serviceCodexHome = options.serviceCodexHome ?? path.join(path.dirname(stateFile), 'ocx-upstream-codex-home');
  const logs = path.join(stateRoot, 'logs');
  const port = Number(options.port ?? 10100);
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  const spawn = options.spawnSync ?? spawnSync;
  const wait = options.pause ?? pause;
  const unloadAttempts = Math.max(1, Number(options.unloadAttempts ?? 40));
  if (!Number.isInteger(uid) || uid < 0) throw new Error('macOS 사용자 UID를 확인할 수 없습니다.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid_ocx_port');
  if (path.resolve(serviceCodexHome) === path.resolve(codexHome)) throw new Error('service_codex_home_must_be_isolated');
  for (const required of [node, wrapper]) {
    const stat = fs.lstatSync(required);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`실제 일반 파일이 필요합니다: ${required}`);
  }
  const ocx = fs.realpathSync(requestedOcx);
  if (!fs.statSync(ocx).isFile()) throw new Error(`OCX 실행 파일이 필요합니다: ${requestedOcx}`);
  const active = options.activeState ?? readActiveState(spawn, ocx);
  if (active.activeTurns !== 0 || active.draining !== false) {
    throw new Error(`ocx_active_state_not_safe:${active.activeTurns ?? 'UNKNOWN'}:${active.draining ?? 'UNKNOWN'}`);
  }
  const upstreamOnlyIntent = options.upstreamOnlyIntent ?? inspectOcxUpstreamOnlyIntent(opencodexHome);
  if (!upstreamOnlyIntent.ok) {
    throw new Error(`ocx_upstream_only_intent_invalid:${upstreamOnlyIntent.reason ?? 'UNKNOWN'}`);
  }
  const beforeFingerprint = options.fingerprint?.() ?? codexConfigFingerprint({ ...process.env, CODEX_HOME: codexHome });
  if (beforeFingerprint === 'unresolved' || beforeFingerprint === 'unreadable') throw new Error('codex_config_fingerprint_unavailable');

  const domain = `gui/${uid}`;
  const previousRegistration = options.previousRegistration
    ?? spawn('launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8' });
  const previouslyRegistered = previousRegistration.status === 0;
  const previousHealth = options.previousHealth
    ?? spawn('curl', ['--fail', '--silent', '--show-error', '--max-time', '2', `http://127.0.0.1:${port}/healthz`], { encoding: 'utf8' });
  if (previousHealth.status === 0 && !previouslyRegistered) throw new Error('ocx_listener_unmanaged');

  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  fs.mkdirSync(serviceCodexHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(serviceCodexHome, 0o700);
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(launchAgents, { recursive: true });
  const plist = path.join(launchAgents, `${label}.plist`);
  const backupRoot = options.backupRoot ?? path.join(stateRoot, 'backups', 'ocx-upstream-launch-agent', timestamp(options.now));
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backup = path.join(backupRoot, `${label}.plist`);
  const stateBackup = path.join(backupRoot, 'ocx-upstream-service.json');
  if (fs.existsSync(plist)) fs.copyFileSync(plist, backup);
  if (fs.existsSync(backup)) fs.chmodSync(backup, 0o600);
  if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, stateBackup);
  if (fs.existsSync(stateBackup)) fs.chmodSync(stateBackup, 0o600);

  const temporary = `${plist}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, body({ node, wrapper, ocx, home, codexHome, serviceCodexHome, opencodexHome, stateFile, logs, port }), { encoding: 'utf8', mode: 0o600 });
  const lint = spawn('plutil', ['-lint', temporary], { encoding: 'utf8' });
  if (lint.status !== 0) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`ocx_launchagent_plist_invalid:${(lint.stderr || lint.stdout || '').trim()}`);
  }
  const installStartedAt = Date.now();
  fs.renameSync(temporary, plist);
  const rollbackAndThrow = message => {
    let rollback = 'restored';
    try {
      spawn('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
      if (fs.existsSync(stateFile)) {
        const failedState = path.join(backupRoot, 'failed-ocx-upstream-service.json');
        fs.copyFileSync(stateFile, failedState);
        fs.chmodSync(failedState, 0o600);
      }
      if (fs.existsSync(backup)) {
        const restoreTemporary = `${plist}.${process.pid}.rollback`;
        fs.copyFileSync(backup, restoreTemporary);
        fs.chmodSync(restoreTemporary, 0o600);
        fs.renameSync(restoreTemporary, plist);
        if (previouslyRegistered) {
          const restored = spawn('launchctl', ['bootstrap', domain, plist], { encoding: 'utf8' });
          if (restored.status !== 0) {
            const restoredRegistration = spawn('launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8' });
            rollback = transientBootstrapFailure(restored) && registeredLabel(restoredRegistration)
              ? 'restored_registered_after_bootstrap_error'
              : `bootstrap_failed_${restored.status ?? 'UNKNOWN'}`;
          }
        } else {
          rollback = 'restored_unloaded_owner';
        }
      } else {
        fs.rmSync(plist, { force: true });
        rollback = 'removed_new_install';
      }
      if (fs.existsSync(stateBackup)) {
        const stateRestoreTemporary = `${stateFile}.${process.pid}.rollback`;
        fs.copyFileSync(stateBackup, stateRestoreTemporary);
        fs.chmodSync(stateRestoreTemporary, 0o600);
        fs.renameSync(stateRestoreTemporary, stateFile);
      } else {
        fs.rmSync(stateFile, { force: true });
      }
    } catch (error) {
      rollback = `failed_${error?.code ?? error?.name ?? 'UNKNOWN'}`;
    }
    throw new Error(`${message};rollback=${rollback}`);
  };
  spawn('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  let unloaded = false;
  for (let attempt = 0; attempt < unloadAttempts; attempt += 1) {
    const registered = spawn('launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8' });
    if (registered.status !== 0) {
      unloaded = true;
      break;
    }
    wait(250);
  }
  if (!unloaded) rollbackAndThrow('ocx_launchagent_did_not_unload');
  fs.rmSync(stateFile, { force: true });
  const loaded = spawn('launchctl', ['bootstrap', domain, plist], { encoding: 'utf8' });
  let registeredAfterBootstrapError = false;
  if (loaded.status !== 0) {
    const registered = spawn('launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8' });
    if (exactRegistration(registered, { node, wrapper })) {
      registeredAfterBootstrapError = true;
    }
  }
  if (loaded?.status !== 0 && !registeredAfterBootstrapError) {
    rollbackAndThrow(`ocx_launchagent_bootstrap_failed:${launchdMessage(loaded)}`);
  }

  let health = null;
  let healthPayload = null;
  let ready = null;
  let readyPayload = null;
  let runtime = null;
  let readiness = null;
  const readinessSamplesRequired = Number(options.readinessSamplesRequired ?? 3);
  if (!Number.isInteger(readinessSamplesRequired) || readinessSamplesRequired < 2 || readinessSamplesRequired > 20) {
    rollbackAndThrow('invalid_ocx_readiness_sample_count');
  }
  let readinessIdentity = null;
  let consecutiveReadiness = 0;
  for (let attempt = 0; attempt < Number(options.healthAttempts ?? 80); attempt += 1) {
    health = spawn('curl', ['--fail', '--silent', '--show-error', '--max-time', '2', `http://127.0.0.1:${port}/healthz`], { encoding: 'utf8' });
    try { healthPayload = JSON.parse(health.stdout); } catch { healthPayload = null; }
    ready = spawn('curl', ['--fail', '--silent', '--show-error', '--max-time', '2', `http://127.0.0.1:${port}/readyz`], { encoding: 'utf8' });
    try { readyPayload = JSON.parse(ready.stdout); } catch { readyPayload = null; }
    try { runtime = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { runtime = null; }
    const freshRuntime = Number.isInteger(runtime?.ownerPid)
      && runtime.ownerPid > 0
      && Number.isInteger(runtime?.servicePid)
      && runtime.servicePid > 0
      && runtime?.codexHomeIsolation === true
      && Date.parse(runtime?.updatedAt ?? '') >= installStartedAt;
    const exactService = healthPayload?.service === 'opencodex'
      && healthPayload?.port === port
      && healthPayload?.pid === runtime?.servicePid;
    const exactReadyService = readyPayload?.status === 'ready'
      && readyPayload?.service === 'opencodex'
      && readyPayload?.port === port
      && readyPayload?.pid === runtime?.servicePid;
    const runtimeProofCurrent = runtime?.schemaVersion === 2
      && runtime?.readinessProof?.current === true
      && runtime?.readinessProof?.ready === true
      && runtime.readinessProof.consecutive >= runtime.readinessProof.required
      && typeof runtime.readinessProof.identity === 'string'
      && /^[a-f0-9]{64}$/.test(runtime.readinessProof.identity)
      && runtime?.livenessCurrent === true
      && runtime?.readinessCurrent === true
      && runtime?.artifactCurrent === true
      && runtime?.listenerPid === runtime?.servicePid
      && /^[a-f0-9]{64}$/.test(runtime?.launchArtifact?.sha256 ?? '')
      && /^[a-f0-9]{64}$/.test(runtime?.serviceStartToken ?? '');
    const currentIdentity = health.status === 0 && ready.status === 0 && runtime?.state === 'ready'
      && freshRuntime && exactService && exactReadyService && runtimeProofCurrent
      ? runtime.readinessProof.identity
      : null;
    if (currentIdentity) {
      consecutiveReadiness = readinessIdentity === currentIdentity ? consecutiveReadiness + 1 : 1;
      readinessIdentity = currentIdentity;
    } else {
      consecutiveReadiness = 0;
      readinessIdentity = null;
    }
    readiness = {
      healthOk: health.status === 0,
      readyOk: ready.status === 0,
      runtimeReady: runtime?.state === 'ready',
      routePreserved: runtime?.routeMutation === false,
      runtimeFresh: freshRuntime,
      exactService,
      exactReadyService,
      runtimeProofCurrent,
      consecutiveReadiness,
      readinessSamplesRequired,
      readinessIdentity,
      healthPid: Number.isInteger(healthPayload?.pid) ? healthPayload.pid : null,
      servicePid: Number.isInteger(runtime?.servicePid) ? runtime.servicePid : null,
      launcherPid: Number.isInteger(runtime?.launcherPid) ? runtime.launcherPid : null,
      healthService: typeof healthPayload?.service === 'string' ? healthPayload.service : null,
      healthPort: Number.isInteger(healthPayload?.port) ? healthPayload.port : null,
      readyStatus: typeof readyPayload?.status === 'string' ? readyPayload.status : null,
      readyPid: Number.isInteger(readyPayload?.pid) ? readyPayload.pid : null,
      runtimeUpdatedAt: typeof runtime?.updatedAt === 'string' ? runtime.updatedAt : null
    };
    if (readiness.healthOk && readiness.readyOk && readiness.runtimeReady && readiness.routePreserved
        && readiness.runtimeFresh && readiness.exactService && readiness.exactReadyService
        && readiness.runtimeProofCurrent && readiness.consecutiveReadiness >= readiness.readinessSamplesRequired) break;
    wait(250);
  }
  if (!readiness?.healthOk || !readiness?.readyOk || !readiness?.runtimeReady || !readiness?.routePreserved
      || !readiness?.runtimeFresh || !readiness?.exactService || !readiness?.exactReadyService
      || !readiness?.runtimeProofCurrent
      || readiness.consecutiveReadiness < readiness.readinessSamplesRequired) {
    rollbackAndThrow(`ocx_upstream_not_ready:${JSON.stringify(readiness)}`);
  }
  const afterFingerprint = options.fingerprint?.() ?? codexConfigFingerprint({ ...process.env, CODEX_HOME: codexHome });
  if (afterFingerprint !== beforeFingerprint) rollbackAndThrow('codex_route_config_changed');
  return {
    ok: true,
    label,
    plist,
    backup: fs.existsSync(backup) ? backup : null,
    port,
    runAtLoad: true,
    keepAlive: false,
    restartBudget: 2,
    serviceCodexHome,
    codexHomeIsolation: path.resolve(serviceCodexHome) !== path.resolve(codexHome),
    bootstrapAttempts: 1,
    registeredAfterBootstrapError,
    topology: 'upstream-only',
    routeFingerprintPreserved: true,
    runtime
  };
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.stdout.write(`${JSON.stringify(installOcxUpstreamLaunchAgent())}\n`);
  } catch (error) {
    process.stderr.write(`ocx-upstream-launchagent-install: ${error.message}\n`);
    process.exitCode = 1;
  }
}
