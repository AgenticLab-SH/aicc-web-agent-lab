#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  workspaceTunnelSurfaceDetails
} from './install-launch-agent.mjs';
import { windowsTunnelDoctor, windowsTunnelIdleGuard } from './windows-tunnel-secret.mjs';

const secretHelper = fileURLToPath(new URL('./windows-tunnel-secret.mjs', import.meta.url));
function selectedHelper(resolved) {
  const registryFile=path.join(resolved.stateRoot,'runtime/components.json');
  if(!fs.existsSync(registryFile)||resolved.details.surfaceProfile!=='business-full')return secretHelper;
  const component=JSON.parse(fs.readFileSync(registryFile,'utf8')).components?.['workspace-host'];
  if(!component)return secretHelper;
  const expected=path.join(resolved.stateRoot,'releases/workspace-host')+path.sep;
  if(!component.entry.startsWith(expected)||fs.lstatSync(component.entry).isSymbolicLink()||crypto.createHash('sha256').update(fs.readFileSync(component.entry)).digest('hex')!==component.entryHash)throw new Error('Managed Workspace helper identity changed');
  return component.entry;
}

function helperArguments(resolved) {
  for (const value of [selectedHelper(resolved), resolved.stateRoot, resolved.helperCommand]) {
    if (/["\r\n]/.test(value)) throw new Error('Unsafe Windows task argument');
  }
  return `"${selectedHelper(resolved)}" run --surface ${resolved.details.surfaceProfile} --state-root "${resolved.stateRoot}"`;
}

function hiddenLauncherArguments(resolved) {
  if (/["\r\n]/.test(resolved.launcher)) throw new Error('Unsafe Windows hidden launcher argument');
  return `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${resolved.launcher}"`;
}

function hiddenLauncherBody(resolved) {
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$launcherPhase = 'process-job'",
    'try {',
    fs.readFileSync(fileURLToPath(new URL('./windows-process-job.ps1', import.meta.url)), 'utf8'),
    "$launcherPhase = 'tunnel-helper'",
    `& ${literal(resolved.helperCommand)} ${literal(selectedHelper(resolved))} 'run' '--surface' ${literal(resolved.details.surfaceProfile)} '--state-root' ${literal(resolved.stateRoot)}`,
    'exit $LASTEXITCODE',
    '} catch {',
    `@{schemaVersion=1;phase=$launcherPhase;languageMode=[string]$ExecutionContext.SessionState.LanguageMode;failedAt=(Get-Date).ToUniversalTime().ToString('o');code='launcher_failed'} | ConvertTo-Json -Compress | Set-Content -LiteralPath ${literal(path.join(resolved.root, 'runtime', 'windows-launcher.last-error.json'))} -Encoding UTF8`,
    'exit 1',
    '}',
    '',
  ].join('\r\n');
}

function requireIdle(resolved, options) {
  const guard = windowsTunnelIdleGuard({ ...options, surfaceProfile: resolved.details.surfaceProfile, stateRoot: resolved.stateRoot });
  if (!guard.allowed) throw new Error(`Workspace Tunnel mutation refused: ${guard.reason}`);
  return guard;
}

// Stop targets a running tunnel, so "a live helper/owner exists" is the expected state, not a
// refusal. The install idle guard returned tunnel_helper_locked for every running tunnel, which
// made the supported stop path unusable (observed 2026-10-31 planned shutdown). Unknown or
// invalid lock/runtime states are still refused.
const STOPPABLE_RUNNING_REASONS = new Set(['tunnel_helper_locked', 'tunnel_owner_active', 'runtime_owner_active']);
function requireStoppable(resolved, options) {
  const guard = windowsTunnelIdleGuard({ ...options, surfaceProfile: resolved.details.surfaceProfile, stateRoot: resolved.stateRoot });
  if (!guard.allowed && !STOPPABLE_RUNNING_REASONS.has(guard.reason)) throw new Error(`Workspace Tunnel stop refused: ${guard.reason}`);
  return guard;
}

const WINDOWS_TASKS = Object.freeze({
  'business-full': 'AgenticLab-AICC-Workspace-Tunnel',
  'personal-read-fetch': 'AgenticLab-AICC-Workspace-Personal-Tunnel'
});

function workspaceTaskDescription(surfaceProfile) {
  return `AgenticLab AICC Workspace Secure MCP Tunnel; owner=AICC; surface=${surfaceProfile}`;
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function xmlText(taskXml, tag) {
  const match = String(taskXml ?? '').match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return null;
  return match[1].trim().replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}

function nextLocalMinuteBoundary(value = Date.now()) {
  const next = new Date(value);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);
  const pad = number => String(number).padStart(2, '0');
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}:${pad(next.getSeconds())}`;
}

export function windowsTaskBody({ userSid, binary, profileDir, runtimeAlias, root, surfaceProfile, helperCommand, helperArgs, actionCommand, actionArgs, recoveryStartBoundary = nextLocalMinuteBoundary() }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(workspaceTaskDescription(surfaceProfile))}</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(userSid)}</UserId></LogonTrigger>
    <CalendarTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>${xml(recoveryStartBoundary)}</StartBoundary>
      <Repetition><Interval>PT1M</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${xml(userSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>${xml(actionCommand ?? helperCommand ?? binary)}</Command>
    <Arguments>${xml(actionArgs ?? helperArgs ?? `run --profile-dir "${profileDir}" --profile "${runtimeAlias}"`)}</Arguments>
    <WorkingDirectory>${xml(root)}</WorkingDirectory>
  </Exec></Actions>
</Task>
`;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function atomicWriteFile(file, bytes, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, bytes, { mode, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function resultMessage(result) {
  return String(result?.stderr || result?.stdout || '').trim();
}

function requiredRegularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`실제 일반 파일이 필요합니다: ${file}`);
}

function queryCurrentUserSid(spawn) {
  const script = '[Console]::Out.Write([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)';
  const result = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true
  });
  const sid = String(result.stdout ?? '').trim();
  if (result.status !== 0 || !/^S-1-(?:\d+-)+\d+$/.test(sid)) {
    throw new Error(`현재 Windows 사용자 SID를 확인하지 못했습니다: ${resultMessage(result)}`);
  }
  return sid;
}


function queryTaskState(spawn, taskName) {
  const escaped = taskName.replaceAll("'", "''");
  const script = `$ErrorActionPreference='Stop'; try{$task=Get-ScheduledTask -TaskPath '\\' -TaskName '${escaped}' -ErrorAction Stop}catch [Microsoft.PowerShell.Cmdletization.Cim.CimJobException]{[Console]::Out.Write('absent');exit 0}; if($null -eq $task){[Console]::Out.Write('absent')}else{[Console]::Out.Write([int]$task.State)}`;
  const result = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true
  });
  if (result.status !== 0) throw new Error(`Windows 예약 작업 상태를 확인하지 못했습니다: ${resultMessage(result)}`);
  const state = String(result.stdout ?? '').trim();
  if (state === 'absent') return null;
  const numeric = Number(state);
  if (!/^[0-4]$/.test(state)) throw new Error('Windows task state is unknown');
  return numeric;
}

function queryTaskXml(spawn, taskName) {
  const result = spawn('schtasks.exe', ['/Query', '/TN', taskName, '/XML', 'ONE'], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true
  });
  if (result.status === 0) return String(result.stdout ?? '');
  if (queryTaskState(spawn, taskName) === null) return null;
  throw new Error(`기존 Workspace Tunnel 예약 작업을 읽지 못했습니다: ${resultMessage(result)}`);
}

function resolveWindowsTaskPaths(options = {}) {
  const home = options.home ?? os.homedir();
  // This isolated read-only deployment must never replace the original personal task.
  const ownerBackup = options.ownerBackupReadOnly === true;
  const ownerBackupRoot = path.join(home, '.ai-control-center', 'account1-backup-route');
  const stateRoot = path.resolve(options.stateRoot ?? (ownerBackup ? ownerBackupRoot : process.env.AICC_STATE_ROOT?.trim()) ?? path.join(home, '.ai-control-center'));
  const details = workspaceTunnelSurfaceDetails(options.surfaceProfile);
  if (ownerBackup && (details.surfaceProfile !== 'personal-read-fetch' || path.resolve(stateRoot) !== path.resolve(ownerBackupRoot))) {
    throw new Error('Owner backup requires the dedicated read-only state root');
  }
  const taskName = ownerBackup ? 'AgenticLab-AICC-Workspace-Account1-Backup-Tunnel' : WINDOWS_TASKS[details.surfaceProfile];
  const root = path.join(stateRoot, details.stateDirectory);
  const binary = path.join(root, 'bin', 'tunnel-client.exe');
  const profileDir = path.join(root, 'tunnel', 'profiles');
  const key = path.join(root, 'secrets', 'tunnel-runtime.key.dpapi');
  const profile = path.join(profileDir, `${details.runtimeAlias}.yaml`);
  const backups = path.join(stateRoot, 'backups', 'workspace-tunnel-windows-task');
  const receipt = path.join(backups, `${taskName}.install.json`);
  const launcher = path.join(root, 'runtime', `${details.runtimeAlias}.hidden.ps1`);
  const legacyLauncher = path.join(root, 'runtime', `${details.runtimeAlias}.hidden.vbs`);
  const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const hostSource = fileURLToPath(new URL('../windows/NoConsoleHost.cs', import.meta.url));
  const hostVersion = crypto.createHash('sha256').update(fs.readFileSync(hostSource)).digest('hex').slice(0,16);
  const consoleHost = path.join(root, 'runtime', `aicc-no-console-${hostVersion}.exe`);
  const installedHost = readJson(receipt)?.wscript;
  const priorHost = installedHost && path.dirname(installedHost) === path.join(root,'runtime') && /^aicc-no-console(?:-[a-f0-9]{16})?\.exe$/.test(path.basename(installedHost)) ? installedHost : null;
  const wscript = path.resolve(options.wscript ?? (options.noConsoleHost ? consoleHost : priorHost ?? powershell));
  const legacyWscript = path.resolve(options.legacyWscript ?? path.join(systemRoot, 'System32', 'wscript.exe'));
  return { home, stateRoot: path.resolve(stateRoot), details, taskName, root, binary, profileDir, key, profile, backups, receipt, launcher, legacyLauncher, wscript, powershell, consoleHost, priorHost, legacyWscript, helperCommand: process.execPath };
}

function workspaceTaskOwned(taskXml, resolved) {
  const legacy = xmlText(taskXml, 'Command') === resolved.binary
    && xmlText(taskXml, 'Arguments') === `run --profile-dir "${resolved.profileDir}" --profile "${resolved.details.runtimeAlias}"`;
  const protectedHelper = xmlText(taskXml, 'Command') === resolved.helperCommand
    && xmlText(taskXml, 'Arguments') === helperArguments(resolved);
  const hiddenHelper = xmlText(taskXml, 'Command')?.toLowerCase() === resolved.wscript.toLowerCase()
    && xmlText(taskXml, 'Arguments') === hiddenLauncherArguments(resolved);
  const priorPowerShell = xmlText(taskXml, 'Command')?.toLowerCase() === resolved.powershell.toLowerCase()
    && xmlText(taskXml, 'Arguments') === hiddenLauncherArguments(resolved);
  const priorGuiHost = resolved.priorHost && xmlText(taskXml,'Command')?.toLowerCase() === resolved.priorHost.toLowerCase()
    && xmlText(taskXml,'Arguments') === hiddenLauncherArguments(resolved);
  return Boolean(taskXml
    && xmlText(taskXml, 'Description') === workspaceTaskDescription(resolved.details.surfaceProfile)
    && (legacy || protectedHelper || hiddenHelper || priorPowerShell || priorGuiHost)
    && xmlText(taskXml, 'WorkingDirectory') === resolved.root);
}

function workspaceTaskUsesHiddenLauncher(taskXml, resolved) {
  return Boolean(taskXml
    && xmlText(taskXml, 'Command')?.toLowerCase() === resolved.wscript.toLowerCase()
    && xmlText(taskXml, 'Arguments') === hiddenLauncherArguments(resolved)
    && xmlText(taskXml, 'Hidden')?.toLowerCase() === 'true');
}

function legacyHiddenLauncherArguments(resolved) {
  if (/[\x00"\r\n]/.test(resolved.legacyLauncher)) throw new Error('Unsafe legacy Windows hidden launcher argument');
  return `/b /nologo "${resolved.legacyLauncher}"`;
}

function pathInside(parent, candidate) {
  const base = path.resolve(parent);
  const value = path.resolve(candidate ?? '');
  return value === base || value.startsWith(`${base}${path.sep}`);
}

function legacyReceiptMatches(receipt, resolved) {
  return Boolean(receipt
    && receipt.schemaVersion === 2
    && receipt.status === 'installed'
    && receipt.taskName === resolved.taskName
    && receipt.surfaceProfile === resolved.details.surfaceProfile
    && receipt.runtimeAlias === resolved.details.runtimeAlias
    && path.resolve(receipt.root ?? '') === resolved.root
    && path.resolve(receipt.binary ?? '') === resolved.binary
    && path.resolve(receipt.profile ?? '') === resolved.profile
    && pathInside(resolved.backups, receipt.previousTaskBackup)
    && fs.existsSync(receipt.previousTaskBackup)
    && fs.lstatSync(receipt.previousTaskBackup).isFile()
    && fs.existsSync(resolved.legacyLauncher)
    && fs.lstatSync(resolved.legacyLauncher).isFile());
}

export function workspaceTaskLegacyAdoptable(taskXml, resolved, receipt, userSid) {
  if (!legacyReceiptMatches(receipt, resolved)) return false;
  const launcherSource = fs.readFileSync(resolved.legacyLauncher, 'utf8');
  return Boolean(taskXml
    && xmlText(taskXml, 'Description') === workspaceTaskDescription(resolved.details.surfaceProfile)
    && xmlText(taskXml, 'Command')?.toLowerCase() === resolved.legacyWscript.toLowerCase()
    && xmlText(taskXml, 'Arguments') === legacyHiddenLauncherArguments(resolved)
    && (!xmlText(taskXml, 'WorkingDirectory') || xmlText(taskXml, 'WorkingDirectory') === resolved.root)
    && (!userSid || xmlText(taskXml, 'UserId') === userSid)
    && xmlText(taskXml, 'Hidden')?.toLowerCase() === 'true'
    && launcherSource.includes('WScript.Shell')
    && launcherSource.includes('windows-tunnel-secret.mjs')
    && launcherSource.includes(`--surface ${resolved.details.surfaceProfile}`)
    && launcherSource.includes(`--state-root ""${resolved.stateRoot}""`));
}

function defaultPause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForTaskStopped({ spawn, taskName, pause = defaultPause, timeoutMs = 5_000, pollMs = 50 }) {
  const deadline = Date.now() + timeoutMs;
  let samples = 0;
  for (;;) {
    samples += 1;
    const state = queryTaskState(spawn, taskName);
    if (state === null || state !== 4) return { confirmed: true, samples, state };
    if (Date.now() >= deadline) throw new Error(`Windows 예약 작업 중지 확인 시간이 초과되었습니다: ${taskName}`);
    pause(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

function restorePreviousTask({ spawn, taskName, previousTaskBackup, previousState, waitForStopped }) {
  spawn('schtasks.exe', ['/End', '/TN', taskName], { encoding: 'utf8', windowsHide: true });
  waitForStopped({ spawn, taskName });
  if (!previousTaskBackup) {
    const removed = spawn('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { encoding: 'utf8', windowsHide: true });
    const absent = queryTaskState(spawn, taskName) === null;
    if (removed.status !== 0 && !absent) throw new Error(`실패한 Windows 예약 작업을 제거하지 못했습니다: ${resultMessage(removed)}`);
    return { restored: false, removedCandidate: true };
  }
  const restored = spawn('schtasks.exe', ['/Create', '/TN', taskName, '/XML', previousTaskBackup, '/F'], {
    encoding: 'utf8', windowsHide: true
  });
  if (restored.status !== 0) throw new Error(`이전 Workspace Tunnel 예약 작업 복구에 실패했습니다: ${resultMessage(restored)}`);
  if (previousState === 4) {
    const restarted = spawn('schtasks.exe', ['/Run', '/TN', taskName], { encoding: 'utf8', windowsHide: true });
    if (restarted.status !== 0) throw new Error(`복구한 Workspace Tunnel 예약 작업을 다시 시작하지 못했습니다: ${resultMessage(restarted)}`);
  }
  return { restored: true, removedCandidate: false };
}

export function workspaceTunnelWindowsTaskStatus(options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('Workspace Tunnel Windows 예약 작업은 Windows에서만 지원합니다.');
  const resolved = resolveWindowsTaskPaths(options);
  const spawn = options.spawnSync ?? spawnSync;
  const taskXml = queryTaskXml(spawn, resolved.taskName);
  const taskState = taskXml ? queryTaskState(spawn, resolved.taskName) : null;
  const receipt = readJson(resolved.receipt);
  const owned = workspaceTaskOwned(taskXml, resolved);
  const hidden = workspaceTaskUsesHiddenLauncher(taskXml, resolved);
  const sourceMatches = Boolean(receipt
    && fs.existsSync(resolved.binary) && fs.existsSync(resolved.profile)
    && fs.existsSync(resolved.launcher) && fs.existsSync(resolved.wscript)
    && receipt.binarySha256 === sha256File(resolved.binary)
    && receipt.profileSha256 === sha256File(resolved.profile)
    && receipt.helperSha256 === sha256File(secretHelper)
    && receipt.nodeSha256 === sha256File(resolved.helperCommand)
    && receipt.launcherSha256 === sha256File(resolved.launcher)
    && (!receipt.hostSha256 || receipt.hostSha256 === sha256File(resolved.wscript))
    && path.resolve(receipt.wscript ?? '') === resolved.wscript);
  const prerequisites = (options.preflight ?? windowsTunnelDoctor)({ ...options, surfaceProfile: resolved.details.surfaceProfile });
  const ok = owned && hidden && receipt?.schemaVersion === 2 && receipt?.status === 'installed'
    && receipt?.taskName === resolved.taskName && sourceMatches && prerequisites.ok;
  return {
    ok,
    state: ok ? 'installed' : taskXml ? 'attention' : 'absent',
    ready: false,
    liveCallVerified: false,
    prerequisites,
    surfaceProfile: resolved.details.surfaceProfile,
    runtimeAlias: resolved.details.runtimeAlias,
    taskName: resolved.taskName,
    taskState,
    owned,
    hidden,
    terminalPolicy: hidden ? 'background-hidden' : 'attention-visible-or-legacy',
    receiptPresent: Boolean(receipt),
    sourceMatches,
    receipt: resolved.receipt,
    command: hidden
      ? `${resolved.wscript} ${hiddenLauncherArguments(resolved)}`
      : `${resolved.helperCommand} ${helperArguments(resolved)}`
  };
}

export function stopWorkspaceTunnelWindowsTask(options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('Workspace Tunnel Windows 예약 작업은 Windows에서만 지원합니다.');
  const resolved = resolveWindowsTaskPaths(options);
  const spawn = options.spawnSync ?? spawnSync;
  const status = workspaceTunnelWindowsTaskStatus({ ...options, spawnSync: spawn });
  if (!status.owned) throw new Error(`소유하지 않은 Workspace Tunnel 예약 작업은 중지하지 않습니다: ${resolved.taskName}`);
  const guard = requireStoppable(resolved, options);
  if (options.dryRun) return { ok: true, dryRun: true, action: 'stop', taskName: resolved.taskName, taskState: status.taskState, runningReason: guard.allowed ? null : guard.reason };
  if (status.taskState === 4) {
    const ended = spawn('schtasks.exe', ['/End', '/TN', resolved.taskName], { encoding: 'utf8', windowsHide: true });
    if (ended.status !== 0) throw new Error(`Workspace Tunnel 예약 작업 중지에 실패했습니다: ${resultMessage(ended)}`);
  }
  const stopped = (options.waitForStopped ?? waitForTaskStopped)({ spawn, taskName: resolved.taskName, pause: options.pause });
  return { ok: true, dryRun: false, action: 'stop', taskName: resolved.taskName, stopConfirmed: stopped.confirmed === true };
}

export function rollbackWorkspaceTunnelWindowsTask(options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('Workspace Tunnel Windows 예약 작업은 Windows에서만 지원합니다.');
  const resolved = resolveWindowsTaskPaths(options);
  const spawn = options.spawnSync ?? spawnSync;
  const receipt = readJson(resolved.receipt);
  if (!receipt || ![1, 2].includes(receipt.schemaVersion) || receipt.status !== 'installed' || receipt.taskName !== resolved.taskName) {
    throw new Error('정확한 Workspace Tunnel 설치 영수증이 없어 rollback을 거부합니다.');
  }
  const taskXml = queryTaskXml(spawn, resolved.taskName);
  if (taskXml && !workspaceTaskOwned(taskXml, resolved)) throw new Error(`소유하지 않은 Workspace Tunnel 예약 작업은 복구하지 않습니다: ${resolved.taskName}`);
  requireIdle(resolved, options);
  const plan = {
    ok: true,
    dryRun: options.dryRun === true,
    action: 'rollback',
    taskName: resolved.taskName,
    previousTaskBackup: receipt.previousTaskBackup ?? null
  };
  if (options.dryRun) return plan;
  restorePreviousTask({
    spawn,
    taskName: resolved.taskName,
    previousTaskBackup: receipt.previousTaskBackup ?? null,
    previousState: receipt.previousState ?? null,
    waitForStopped: options.waitForStopped ?? waitForTaskStopped
  });
  if (receipt.schemaVersion === 2) {
    if (!fs.existsSync(resolved.launcher) || sha256File(resolved.launcher) !== receipt.launcherSha256) {
      throw new Error('Workspace Tunnel hidden launcher changed after install; rollback refused.');
    }
    if (receipt.previousLauncherBackup) {
      requiredRegularFile(receipt.previousLauncherBackup);
      atomicWriteFile(resolved.launcher, fs.readFileSync(receipt.previousLauncherBackup));
    } else {
      fs.rmSync(resolved.launcher, { force: true });
    }
  }
  atomicWriteJson(resolved.receipt, { ...receipt, status: 'rolled_back', rolledBackAt: new Date(options.now?.() ?? Date.now()).toISOString() });
  return { ...plan, dryRun: false, restoredPrevious: Boolean(receipt.previousTaskBackup) };
}

export function installWorkspaceTunnelWindowsTask(options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('Workspace Tunnel Windows 예약 작업은 Windows에서만 지원합니다.');
  const resolved = resolveWindowsTaskPaths(options);
  const { details, taskName, root, binary, profileDir, key, profile, backups, receipt } = resolved;
  if (options.noConsoleHost && !options.dryRun) {
    const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const source = fileURLToPath(new URL('../windows/NoConsoleHost.cs', import.meta.url));
    fs.mkdirSync(path.dirname(resolved.consoleHost), { recursive: true });
    if (!fs.existsSync(resolved.consoleHost)) {
      const built = (options.spawnSync ?? spawnSync)(compiler, ['/nologo', '/target:winexe', `/out:${resolved.consoleHost}`, source], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      if (built.status !== 0) throw new Error('No-console host build failed');
    }
  }
  for (const required of [binary, profile, key, options.dryRun && !fs.existsSync(resolved.wscript) ? resolved.powershell : resolved.wscript]) requiredRegularFile(required);

  const spawn = options.spawnSync ?? spawnSync;
  const userSid = options.userSid ?? queryCurrentUserSid(spawn);
  if (!/^S-1-(?:\d+-)+\d+$/.test(userSid)) throw new Error('Windows 사용자 SID 형식이 올바르지 않습니다.');
  const prerequisites = (options.preflight ?? windowsTunnelDoctor)({ ...options, surfaceProfile: details.surfaceProfile });
  if (!prerequisites.ok) throw new Error('Workspace Tunnel prerequisites failed; run doctor (no plaintext fallback).');
  const guard = requireIdle(resolved, options);
  const installNow = options.now?.() ?? Date.now();
  const stamp = new Date(installNow).toISOString().replaceAll(':', '-');
  const recoveryStartBoundary = nextLocalMinuteBoundary(installNow);
  const previousXml = queryTaskXml(spawn, taskName);
  let previousTaskBackup = null;
  let previousState = null;
  let adoptedLegacy = false;
  if (previousXml) {
    if (!workspaceTaskOwned(previousXml, resolved)) {
      const receiptBefore = readJson(receipt);
      if (!options.adoptLegacy || !workspaceTaskLegacyAdoptable(previousXml, resolved, receiptBefore, userSid)) {
        throw new Error(`소유하지 않은 Workspace Tunnel 예약 작업을 덮어쓰지 않습니다: ${taskName}`);
      }
      adoptedLegacy = true;
    }
    previousState = queryTaskState(spawn, taskName);
    if (previousState === 4) throw new Error('Workspace Tunnel task is active; quiesce the exact owner before repair.');
  }
  const plan = {
    ok: true,
    dryRun: options.dryRun === true,
    action: options.action === 'repair' ? 'repair' : 'install',
    guard,
    secretFormat: 'dpapi-binary-current-user',
    surfaceProfile: details.surfaceProfile,
    runtimeAlias: details.runtimeAlias,
    taskName,
    previousState,
    adoptedLegacy,
    receipt,
    runAtLogon: true,
    keepAlive: false,
    visibleTerminal: false,
    terminalPolicy: 'background-hidden',
    restartPolicy: 'bounded-scheduler-recovery',
    periodicRecovery: { interval: 'PT1M', duration: 'P1D', schedule: 'daily', startBoundary: recoveryStartBoundary },
    rollback: `node ${fileURLToPath(import.meta.url)} rollback --surface ${details.surfaceProfile}${options.ownerBackupReadOnly ? ' --owner-backup-read-only' : ''}`
  };
  if (options.dryRun) return plan;

  fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
  if (previousXml) {
    previousTaskBackup = path.join(backups, `${taskName}.${stamp}.xml`);
    fs.writeFileSync(previousTaskBackup, previousXml, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }

  const candidate = path.join(backups, `${taskName}.${stamp}.candidate.${process.pid}.xml`);
  const waitForStopped = options.waitForStopped ?? waitForTaskStopped;
  let mutationStarted = false;
  let launcherChanged = false;
  let previousLauncherBytes = null;
  let previousLauncherBackup = null;
  try {
    if (fs.existsSync(resolved.launcher)) {
      requiredRegularFile(resolved.launcher);
      previousLauncherBytes = fs.readFileSync(resolved.launcher);
      previousLauncherBackup = path.join(backups, `${taskName}.${stamp}.launcher.before.vbs`);
      fs.writeFileSync(previousLauncherBackup, previousLauncherBytes, { mode: 0o600, flag: 'wx' });
    }
    atomicWriteFile(resolved.launcher, Buffer.from(hiddenLauncherBody(resolved), 'utf8'));
    launcherChanged = true;
    fs.writeFileSync(candidate, `\uFEFF${windowsTaskBody({
      userSid, binary, profileDir, runtimeAlias: details.runtimeAlias, root, surfaceProfile: details.surfaceProfile,
      actionCommand: resolved.wscript, actionArgs: hiddenLauncherArguments(resolved), recoveryStartBoundary
    })}`, { encoding: 'utf16le', flag: 'wx' });
    requireIdle(resolved, options);
    if (queryTaskXml(spawn, taskName) !== previousXml) throw new Error('Workspace Tunnel task changed after preview');
    const stopped = waitForStopped({
      spawn, taskName, pause: options.pause, timeoutMs: options.stopTimeoutMs, pollMs: options.stopPollMs
    });
    mutationStarted = true;
    const registered = spawn('schtasks.exe', ['/Create', '/TN', taskName, '/XML', candidate, '/F'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true
    });
    if (registered.status !== 0) throw new Error(`Workspace Tunnel 예약 작업 등록에 실패했습니다: ${resultMessage(registered)}`);
    if (queryTaskState(spawn, taskName) === null) throw new Error('Workspace Tunnel 예약 작업 등록 후 상태를 확인하지 못했습니다.');
    const started = spawn('schtasks.exe', ['/Run', '/TN', taskName], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    if (started.status !== 0) throw new Error(`Workspace Tunnel 예약 작업 시작에 실패했습니다: ${resultMessage(started)}`);
    atomicWriteJson(receipt, {
      schemaVersion: 2,
      status: 'installed',
      installedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      surfaceProfile: details.surfaceProfile,
      runtimeAlias: details.runtimeAlias,
      taskName,
      previousTaskBackup,
      previousState,
      adoptedLegacy,
      binary,
      binarySha256: sha256File(binary),
      helperSha256: sha256File(secretHelper),
      nodeSha256: sha256File(resolved.helperCommand),
      launcher: resolved.launcher,
      launcherSha256: sha256File(resolved.launcher),
      previousLauncherBackup,
      wscript: resolved.wscript,
      hostSha256: sha256File(resolved.wscript),
      profile,
      profileSha256: sha256File(profile),
      root
    });
    return {
      ...plan,
      dryRun: false,
      previousTaskBackup,
      stopConfirmed: stopped.confirmed === true,
      stopSamples: stopped.samples ?? null,
      startAttempts: 1,
      receipt
    };
  } catch (error) {
    const recoveryErrors = [];
    try {
      if (mutationStarted) {
        requireIdle(resolved, options);
        restorePreviousTask({ spawn, taskName, previousTaskBackup, previousState, waitForStopped });
      }
    }
    catch (rollbackError) { recoveryErrors.push(`task rollback: ${rollbackError.message}`); }
    try {
      if (launcherChanged) {
        if (previousLauncherBytes) atomicWriteFile(resolved.launcher, previousLauncherBytes);
        else fs.rmSync(resolved.launcher, { force: true });
      }
    } catch (launcherError) { recoveryErrors.push(`launcher rollback: ${launcherError.message}`); }
    if (recoveryErrors.length) throw new Error(`${error.message}; ${recoveryErrors.join('; ')}`);
    throw error;
  } finally {
    fs.rmSync(candidate, { force: true });
  }
}

export function rebindWorkspaceTunnelProfileReceipt(options={}) {
  if((options.platform??process.platform)!=='win32')throw new Error('Workspace Task profile rebind is Windows-only');
  const resolved=resolveWindowsTaskPaths(options),spawn=options.spawnSync??spawnSync;
  requiredRegularFile(options.cutoverReceipt);
  const proof=readJson(options.cutoverReceipt),receipt=readJson(resolved.receipt);
  if(proof?.terminal!=='PASS_RUNTIME'||proof.nativePidPreserved!==true||receipt?.schemaVersion!==2||receipt.status!=='installed'||receipt.profileSha256!==proof.originalProfileSha256)throw new Error('Verified cutover and installed preimage required');
  const recovery=path.resolve(proof.recovery),expectedParent=path.join(os.homedir(),'.codex-chatgpt-web','recovery');
  if(path.dirname(recovery)!==expectedParent||!/^unified-workspace-\d+$/.test(path.basename(recovery)))throw new Error('Owned cutover recovery required');
  const preimage=path.join(recovery,'profile.before.yaml'),taskPreimage=path.join(recovery,'task.before.xml');
  for(const file of [preimage,taskPreimage,resolved.profile,resolved.binary,resolved.helperCommand,resolved.launcher])requiredRegularFile(file);
  if(sha256File(preimage)!==proof.originalProfileSha256||sha256File(resolved.profile)!==proof.profileSha256||sha256File(taskPreimage)!==proof.taskPreimageSha256)throw new Error('Cutover proof changed');
  const xml=queryTaskXml(spawn,resolved.taskName);
  if(!workspaceTaskOwned(xml,resolved)||!workspaceTaskUsesHiddenLauncher(xml,resolved)||receipt.binarySha256!==sha256File(resolved.binary)||receipt.helperSha256!==sha256File(secretHelper)||receipt.nodeSha256!==sha256File(resolved.helperCommand)||receipt.launcherSha256!==sha256File(resolved.launcher))throw new Error('Task sources changed beyond profile');
  const backup=path.join(recovery,'task.install.before.json');
  if(options.dryRun)return {ok:true,dryRun:true,profileSha256:proof.profileSha256,taskRestarted:false};
  fs.copyFileSync(resolved.receipt,backup,fs.constants.COPYFILE_EXCL);
  const temporary=resolved.receipt+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify({...receipt,profileSha256:proof.profileSha256},null,2),{flag:'wx',mode:0o600});
  fs.renameSync(temporary,resolved.receipt);
  return {ok:true,profileSha256:proof.profileSha256,preimage:backup,taskRestarted:false};
}

export function parseWorkspaceTunnelWindowsTaskArgs(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const action = ['status', 'doctor', 'install', 'repair', 'stop', 'rollback','rebind-profile'].includes(argv[0]) ? argv[0] : 'install';
  const args = action === argv[0] ? argv.slice(1) : argv;
  let surfaceProfile = null;
  let dryRun = false;
  let adoptLegacy = false;
  let ownerBackupReadOnly = false;
  let cutoverReceipt=null;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (seen.has(token)) throw new Error(`duplicate option: ${token}`);
    seen.add(token);
    if (token === '--dry-run') dryRun = true;
    else if(token==='--cutover-receipt') {cutoverReceipt=args[++index];if(!cutoverReceipt||!path.isAbsolute(cutoverReceipt))throw new Error('Absolute cutover receipt required');}
    else if (token === '--adopt-legacy') adoptLegacy = true;
    else if (token === '--owner-backup-read-only') ownerBackupReadOnly = true;
    else if (token === '--surface') {
      const value = args[++index];
      if (!['business-full', 'personal-read-fetch'].includes(value)) throw new Error('--surface must be business-full or personal-read-fetch');
      surfaceProfile = value;
    } else if (token === '--personal-read-fetch') {
      if (surfaceProfile && surfaceProfile !== 'personal-read-fetch') throw new Error('conflicting surface options');
      surfaceProfile = 'personal-read-fetch';
    } else throw new Error(`unknown option: ${token}`);
  }
  if (!surfaceProfile) throw new Error('--surface business-full|personal-read-fetch is required');
  if (ownerBackupReadOnly && (surfaceProfile !== 'personal-read-fetch' || adoptLegacy)) throw new Error('Dedicated owner backup is read-only and cannot adopt the existing personal task');
  if (adoptLegacy && !['install', 'repair'].includes(action)) throw new Error('--adopt-legacy is only valid for install or repair');
  if(action==='rebind-profile'&&!cutoverReceipt||cutoverReceipt&&action!=='rebind-profile')throw new Error('Exact profile rebind receipt required');
  return { help: false, action, surfaceProfile, dryRun, adoptLegacy, ownerBackupReadOnly,...(cutoverReceipt?{cutoverReceipt}:{}) };
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const parsed = parseWorkspaceTunnelWindowsTaskArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log('Usage: install-windows-task.mjs status|doctor|install|repair|stop|rollback --surface business-full|personal-read-fetch [--dry-run] [--adopt-legacy] [--owner-backup-read-only]');
      process.exit(0);
    }
    const options = { surfaceProfile: parsed.surfaceProfile, ownerBackupReadOnly: parsed.ownerBackupReadOnly, dryRun: parsed.dryRun, adoptLegacy: parsed.adoptLegacy, action: parsed.action,cutoverReceipt:parsed.cutoverReceipt, noConsoleHost: ['install','repair'].includes(parsed.action) };
    const result = parsed.action === 'rebind-profile'?rebindWorkspaceTunnelProfileReceipt(options):parsed.action === 'doctor' ? windowsTunnelDoctor(options)
      : parsed.action === 'status' ? workspaceTunnelWindowsTaskStatus(options)
      : ['install', 'repair'].includes(parsed.action) ? installWorkspaceTunnelWindowsTask(options)
        : parsed.action === 'stop' ? stopWorkspaceTunnelWindowsTask(options)
          : rollbackWorkspaceTunnelWindowsTask(options);
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    console.error(`workspace-tunnel-windows-install: ${error.message}`);
    process.exitCode = 1;
  }
}
