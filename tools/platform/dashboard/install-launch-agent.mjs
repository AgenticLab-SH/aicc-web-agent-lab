#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const label = 'com.agenticlab.aicc-dashboard';

function blockingPause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function launchdMessage(result) {
  return (result?.stderr || result?.stdout || '').trim();
}

function waitForLaunchdUnloaded({ spawn, target, pause = blockingPause, timeoutMs = 5_000, pollMs = 50 }) {
  const deadline = Date.now() + timeoutMs;
  let samples = 0;
  for (;;) {
    samples += 1;
    const current = spawn('launchctl', ['print', target], { encoding: 'utf8' });
    if (current.status !== 0) return { confirmed: true, samples };
    if (Date.now() >= deadline) throw new Error(`launchd unload 확인 시간이 초과되었습니다: ${target}`);
    pause(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

function restorePreviousPlistBytes({ plist, previousPlistBackup }) {
  if (!previousPlistBackup) {
    fs.rmSync(plist, { force: true });
    return { restored: false, removedCandidate: true };
  }
  const temporary = `${plist}.${process.pid}.rollback.tmp`;
  fs.copyFileSync(previousPlistBackup, temporary, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, plist);
  return { restored: true, removedCandidate: false };
}

function restorePreviousPlist({ spawn, domain, plist, previousPlistBackup, waitForUnloaded, pause, unloadTimeoutMs, unloadPollMs }) {
  spawn('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  waitForUnloaded({ spawn, target: `${domain}/${label}`, pause, timeoutMs: unloadTimeoutMs, pollMs: unloadPollMs });
  const restoredBytes = restorePreviousPlistBytes({ plist, previousPlistBackup });
  if (!previousPlistBackup) return restoredBytes;
  const restored = spawn('launchctl', ['bootstrap', domain, plist], { encoding: 'utf8' });
  if (restored.status !== 0) {
    const registered = spawn('launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8' });
    if (registered.status !== 0) throw new Error(`이전 Dashboard launchd 설정 복구에 실패했습니다: ${launchdMessage(restored)}`);
  }
  return restoredBytes;
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function plistBody({ node, root, home, logs, port }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(path.join(root, 'src', 'server.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'dashboard.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'dashboard.error.log'))}</string>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
<key>HOME</key><string>${xml(home)}</string><key>AICC_HOST</key><string>127.0.0.1</string>
<key>AICC_PORT</key><string>${xml(port)}</string>
</dict></dict></plist>
`;
}

export function installDashboardLaunchAgent(options = {}) {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('AICC Dashboard 자동 시작은 macOS에서만 지원합니다.');
  const home = options.home ?? os.homedir();
  const root = options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const node = options.node ?? process.execPath;
  const port = String(options.port ?? process.env.AICC_PORT ?? '4381');
  const spawn = options.spawnSync ?? spawnSync;
  const pause = options.pause ?? blockingPause;
  const healthAttempts = Math.max(1, Number(options.healthAttempts ?? 20));
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  if (!Number.isInteger(uid) || uid < 0) throw new Error('macOS 사용자 UID를 확인할 수 없습니다.');
  for (const required of [node, path.join(root, 'src', 'server.mjs'), path.join(root, 'package.json')]) {
    const stat = fs.lstatSync(required);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`실제 일반 파일이 필요합니다: ${required}`);
  }
  if (!/^\d{2,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error(`올바르지 않은 Dashboard port: ${port}`);
  const logs = path.join(home, '.ai-control-center', 'logs');
  const backups = path.join(home, '.ai-control-center', 'backups', 'dashboard-launch-agent');
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(launchAgents, { recursive: true });
  const plist = path.join(launchAgents, `${label}.plist`);
  let previousPlistBackup = null;
  if (fs.existsSync(plist)) {
    previousPlistBackup = path.join(backups, `${label}.${new Date(options.now?.() ?? Date.now()).toISOString().replaceAll(':', '-')}.plist`);
    fs.copyFileSync(plist, previousPlistBackup, fs.constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') fs.chmodSync(previousPlistBackup, 0o600);
  }
  const temporary = `${plist}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, plistBody({ node, root, home, logs, port }), { encoding: 'utf8', mode: 0o600 });
  const checked = spawn('plutil', ['-lint', temporary], { encoding: 'utf8' });
  if (checked.status !== 0) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`launchd 설정 검사가 실패했습니다: ${(checked.stderr || checked.stdout || '').trim()}`);
  }
  fs.renameSync(temporary, plist);
  const domain = `gui/${uid}`;
  const waitForUnloaded = options.waitForUnloaded ?? waitForLaunchdUnloaded;
  spawn('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  let unloaded;
  try {
    unloaded = waitForUnloaded({
      spawn,
      target: `${domain}/${label}`,
      pause,
      timeoutMs: options.unloadTimeoutMs,
      pollMs: options.unloadPollMs
    });
  } catch (error) {
    const restored = restorePreviousPlistBytes({ plist, previousPlistBackup });
    throw new Error(`AICC Dashboard launchd unload 확인에 실패했습니다: ${error.message}; plistRollback=${restored.restored ? 'restored' : 'candidate_removed'}`);
  }
  const loaded = spawn('launchctl', ['bootstrap', domain, plist], { encoding: 'utf8' });
  let registeredAfterBootstrapError = false;
  if (loaded.status !== 0) {
    const registered = spawn('launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8' });
    registeredAfterBootstrapError = registered.status === 0;
    if (registered.status !== 0) {
      const failure = `AICC Dashboard 자동 시작 등록에 실패했습니다: ${launchdMessage(loaded)}`;
      try { restorePreviousPlist({ spawn, domain, plist, previousPlistBackup, waitForUnloaded, pause, unloadTimeoutMs: options.unloadTimeoutMs, unloadPollMs: options.unloadPollMs }); }
      catch (rollbackError) { throw new Error(`${failure}; rollback: ${rollbackError.message}`); }
      throw new Error(failure);
    }
  }
  let health = null;
  let healthAttempt = 0;
  const healthUrl = `http://127.0.0.1:${port}/healthz`;
  for (; healthAttempt < healthAttempts; healthAttempt += 1) {
    health = spawn('curl', ['--fail', '--silent', '--show-error', '--max-time', '2', healthUrl], { encoding: 'utf8' });
    if (health.status === 0) break;
    if (healthAttempt + 1 < healthAttempts) pause(Math.min(500, 100 + (healthAttempt * 50)));
  }
  if (health?.status !== 0) {
    const failure = `AICC Dashboard가 등록됐지만 healthz 준비를 확인하지 못했습니다: ${launchdMessage(health)}`;
    try { restorePreviousPlist({ spawn, domain, plist, previousPlistBackup, waitForUnloaded, pause, unloadTimeoutMs: options.unloadTimeoutMs, unloadPollMs: options.unloadPollMs }); }
    catch (rollbackError) { throw new Error(`${failure}; rollback: ${rollbackError.message}`); }
    throw new Error(failure);
  }
  return {
    ok: true,
    label,
    plist,
    previousPlistBackup,
    port: Number(port),
    unloadConfirmed: unloaded.confirmed === true,
    unloadSamples: unloaded.samples ?? null,
    bootstrapAttempts: 1,
    registeredAfterBootstrapError,
    healthAttempts: healthAttempt + 1,
    runAtLoad: true,
    keepAlive: false,
    restartPolicy: 'maintenance-coordinator-only'
  };
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    console.log(JSON.stringify(installDashboardLaunchAgent()));
  } catch (error) {
    console.error(`aicc-dashboard-install: ${error.message}`);
    process.exitCode = 1;
  }
}
