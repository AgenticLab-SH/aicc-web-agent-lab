#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function workspaceTunnelSurfaceDetails(surfaceProfile = 'business-full') {
  if (surfaceProfile === 'business-full') return {
    surfaceProfile,
    stateDirectory: 'workspace-mcp',
    runtimeAlias: 'aicc-workspace',
    label: 'com.agenticlab.aicc-workspace-tunnel'
  };
  if (surfaceProfile === 'personal-read-fetch') return {
    surfaceProfile,
    stateDirectory: 'workspace-mcp-personal-read-fetch',
    runtimeAlias: 'aicc-workspace-personal-read-fetch',
    label: 'com.agenticlab.aicc-workspace-personal-read-fetch-tunnel'
  };
  throw new Error(`지원하지 않는 Workspace MCP surface profile입니다: ${surfaceProfile}`);
}

export function parseWorkspaceTunnelInstallArgs(args = []) {
  if (args.includes('--help') || args.includes('-h')) return { help: true, surfaceProfile: null };
  const seen = new Set();
  let surfaceProfile = null;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!['--surface', '--personal-read-fetch'].includes(token)) throw new Error(`unknown option: ${token}`);
    if (seen.has(token)) throw new Error(`duplicate option: ${token}`);
    seen.add(token);
    if (token === '--surface') {
      const value = args[index + 1];
      if (!['business-full', 'personal-read-fetch'].includes(value)) throw new Error('--surface must be business-full or personal-read-fetch');
      surfaceProfile = value;
      index += 1;
    } else {
      if (surfaceProfile && surfaceProfile !== 'personal-read-fetch') throw new Error('conflicting surface options');
      surfaceProfile = 'personal-read-fetch';
    }
  }
  if (!surfaceProfile) throw new Error('--surface business-full|personal-read-fetch is required');
  return { help: false, surfaceProfile };
}

function launchdMessage(result) {
  return (result?.stderr || result?.stdout || '').trim();
}

function defaultPause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForLaunchdUnloaded({ spawn, target, pause = defaultPause, timeoutMs = 5_000, pollMs = 50 }) {
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

function restorePreviousPlist({ spawn, domain, plist, previousPlistBackup, label, waitForUnloaded }) {
  spawn('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  waitForUnloaded({ spawn, target: `${domain}/${label}` });
  if (!previousPlistBackup) {
    fs.rmSync(plist, { force: true });
    return { restored: false, removedCandidate: true };
  }
  const temporary = `${plist}.${process.pid}.rollback.tmp`;
  fs.copyFileSync(previousPlistBackup, temporary, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, plist);
  const restored = spawn('launchctl', ['bootstrap', domain, plist], { encoding: 'utf8' });
  if (restored.status !== 0) throw new Error(`이전 Workspace Tunnel launchd 설정 복구에 실패했습니다: ${launchdMessage(restored)}`);
  return { restored: true, removedCandidate: false };
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function plistBody({ binary, profileDir, logs, home, label, runtimeAlias }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>
<string>${xml(binary)}</string><string>run</string><string>--profile-dir</string><string>${xml(profileDir)}</string><string>--profile</string><string>${xml(runtimeAlias)}</string>
</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'tunnel.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'tunnel.error.log'))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>HOME</key><string>${xml(home)}</string></dict>
</dict></plist>
`;
}

export function installWorkspaceTunnelLaunchAgent(options = {}) {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('Workspace Tunnel 자동 시작은 macOS에서만 지원합니다.');
  const home = options.home ?? os.homedir();
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(home, '.ai-control-center');
  const details = workspaceTunnelSurfaceDetails(options.surfaceProfile);
  const { label, runtimeAlias } = details;
  const root = path.join(stateRoot, details.stateDirectory);
  const binary = path.join(root, 'bin', 'tunnel-client');
  const profileDir = path.join(root, 'tunnel', 'profiles');
  const key = path.join(root, 'secrets', 'tunnel-runtime.key');
  const logs = path.join(root, 'logs');
  const spawn = options.spawnSync ?? spawnSync;
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  if (!Number.isInteger(uid) || uid < 0) throw new Error('macOS 사용자 UID를 확인할 수 없습니다.');
  for (const required of [binary, path.join(profileDir, `${runtimeAlias}.yaml`), key]) {
    const stat = fs.lstatSync(required);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`실제 일반 파일이 필요합니다: ${required}`);
  }
  if ((fs.statSync(key).mode & 0o077) !== 0) throw new Error('Tunnel runtime key는 소유자 전용(0600)이어야 합니다.');
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const backups = path.join(stateRoot, 'backups', 'workspace-tunnel-launch-agent');
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
  fs.writeFileSync(temporary, plistBody({ binary, profileDir, logs, home, label, runtimeAlias }), { encoding: 'utf8', mode: 0o600 });
  const checked = spawn('plutil', ['-lint', temporary], { encoding: 'utf8' });
  if (checked.status !== 0) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`launchd 설정 검사가 실패했습니다: ${(checked.stderr || checked.stdout || '').trim()}`);
  }
  fs.renameSync(temporary, plist);
  const domain = `gui/${uid}`;
  const waitForUnloaded = options.waitForUnloaded ?? waitForLaunchdUnloaded;
  spawn('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  const unloaded = waitForUnloaded({
    spawn,
    target: `${domain}/${label}`,
    pause: options.pause,
    timeoutMs: options.unloadTimeoutMs,
    pollMs: options.unloadPollMs
  });
  const loaded = spawn('launchctl', ['bootstrap', domain, plist], { encoding: 'utf8' });
  let registeredAfterBootstrapError = false;
  if (loaded.status !== 0) {
    const registered = spawn('launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8' });
    registeredAfterBootstrapError = registered.status === 0;
    if (registered.status !== 0) {
      const failure = `Workspace Tunnel 자동 시작 등록에 실패했습니다: ${launchdMessage(loaded)}`;
      try { restorePreviousPlist({ spawn, domain, plist, previousPlistBackup, label, waitForUnloaded }); }
      catch (rollbackError) { throw new Error(`${failure}; rollback: ${rollbackError.message}`); }
      throw new Error(failure);
    }
  }
  return { ok: true, surfaceProfile: details.surfaceProfile, runtimeAlias, label, plist, previousPlistBackup, unloadConfirmed: unloaded.confirmed === true, unloadSamples: unloaded.samples ?? null, bootstrapAttempts: 1, registeredAfterBootstrapError, runAtLoad: true, keepAlive: false, restartPolicy: 'maintenance-coordinator-only' };
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const parsed = parseWorkspaceTunnelInstallArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log('Usage: install-launch-agent.mjs --surface business-full|personal-read-fetch');
      process.exit(0);
    }
    const result = installWorkspaceTunnelLaunchAgent({
      surfaceProfile: parsed.surfaceProfile
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`workspace-tunnel-install: ${error.message}`);
    process.exitCode = 1;
  }
}
