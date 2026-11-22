#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const schedulerLabel = 'com.agenticlab.aicc-scheduler';

function launchdMessage(result) {
  return (result?.stderr || result?.stdout || '').trim();
}

function restorePreviousPlist({ run, domain, plist, previousPlistBackup }) {
  run('launchctl', ['bootout', `${domain}/${schedulerLabel}`], { stdio: 'ignore' });
  if (!previousPlistBackup) {
    fs.rmSync(plist, { force: true });
    return { restored: false, removedCandidate: true };
  }
  const temporary = `${plist}.${process.pid}.rollback.tmp`;
  fs.copyFileSync(previousPlistBackup, temporary, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, plist);
  const restored = run('launchctl', ['bootstrap', domain, plist], { encoding: 'utf8' });
  if (restored.status !== 0) throw new Error(`이전 scheduler launchd 설정 복구에 실패했습니다: ${launchdMessage(restored)}`);
  return { restored: true, removedCandidate: false };
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function schedulerPlistBody({ node, root, home, logs, intervalSeconds = 30 }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${schedulerLabel}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(path.join(root, 'src', 'local-scheduler.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>StartInterval</key><integer>${intervalSeconds}</integer>
<key>ThrottleInterval</key><integer>30</integer><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'scheduler.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'scheduler.error.log'))}</string>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
<key>HOME</key><string>${xml(home)}</string>
</dict></dict></plist>
`;
}

export function installSchedulerLaunchAgent(options = {}) {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('AICC durable scheduler는 macOS에서만 자동 등록합니다.');
  const home = options.home ?? os.homedir();
  const root = options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const node = options.node ?? process.execPath;
  const intervalSeconds = Number(options.intervalSeconds ?? 30);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 3600) throw new Error('scheduler interval은 30-3600초여야 합니다.');
  for (const required of [node, path.join(root, 'src', 'local-scheduler.mjs'), path.join(root, 'package.json')]) {
    const stat = fs.lstatSync(required);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`실제 일반 파일이 필요합니다: ${required}`);
  }
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  if (!Number.isInteger(uid) || uid < 0) throw new Error('macOS 사용자 UID를 확인할 수 없습니다.');
  const run = options.spawnSync ?? spawnSync;
  const logs = path.join(home, '.ai-control-center', 'logs');
  const backups = path.join(home, '.ai-control-center', 'backups', 'scheduler-launch-agent');
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  fs.mkdirSync(launchAgents, { recursive: true });
  const plist = path.join(launchAgents, `${schedulerLabel}.plist`);
  let previousPlistBackup = null;
  if (fs.existsSync(plist)) {
    previousPlistBackup = path.join(backups, `${schedulerLabel}.${new Date(options.now?.() ?? Date.now()).toISOString().replaceAll(':', '-')}.plist`);
    fs.copyFileSync(plist, previousPlistBackup, fs.constants.COPYFILE_EXCL);
    if (process.platform !== 'win32') fs.chmodSync(previousPlistBackup, 0o600);
  }
  const temporary = `${plist}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, schedulerPlistBody({ node, root, home, logs, intervalSeconds }), { encoding: 'utf8', mode: 0o600 });
  const linted = run('plutil', ['-lint', temporary], { encoding: 'utf8' });
  if (linted.status !== 0) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`scheduler launchd 설정 검사가 실패했습니다: ${(linted.stderr || linted.stdout || '').trim()}`);
  }
  fs.renameSync(temporary, plist);
  const domain = `gui/${uid}`;
  run('launchctl', ['bootout', `${domain}/${schedulerLabel}`], { stdio: 'ignore' });
  const loaded = run('launchctl', ['bootstrap', domain, plist], { encoding: 'utf8' });
  const current = run('launchctl', ['print', `${domain}/${schedulerLabel}`], { encoding: 'utf8' });
  const registeredAfterBootstrapError = loaded.status !== 0 && current.status === 0;
  if (loaded.status !== 0 && !registeredAfterBootstrapError) {
    const failure = `scheduler launchd 등록에 실패했습니다: ${launchdMessage(loaded)}`;
    try { restorePreviousPlist({ run, domain, plist, previousPlistBackup }); }
    catch (rollbackError) { throw new Error(`${failure}; rollback: ${rollbackError.message}`); }
    throw new Error(failure);
  }
  if (current.status !== 0) {
    const failure = 'scheduler launchd 등록 후 owner 상태를 확인하지 못했습니다.';
    try { restorePreviousPlist({ run, domain, plist, previousPlistBackup }); }
    catch (rollbackError) { throw new Error(`${failure}; rollback: ${rollbackError.message}`); }
    throw new Error(failure);
  }
  return {
    ok: true,
    label: schedulerLabel,
    plist,
    previousPlistBackup,
    bootstrapAttempts: 1,
    registeredAfterBootstrapError,
    intervalSeconds,
    runAtLoad: true,
    keepAlive: false,
    dashboardTimerRemoved: true,
    automaticApply: false
  };
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try { console.log(JSON.stringify(installSchedulerLaunchAgent())); }
  catch (error) {
    console.error(`aicc-scheduler-install: ${error.message}`);
    process.exitCode = 1;
  }
}
