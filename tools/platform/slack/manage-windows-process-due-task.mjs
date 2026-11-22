#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const notificationProcessDueTaskName = 'AgenticLab-AICC-Notification-Process-Due';
export const notificationProcessDueDescription = 'AgenticLab AICC notification process-due scheduler; owner=AICC; component=notification-process-due';
export const notificationProcessDueLauncherName = 'process-due-hidden.vbs';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function vbs(value) {
  return String(value).replaceAll('"', '""');
}

export function notificationProcessDueLauncherBody({ node, cli, root }) {
  const command = `"${node}" "${cli}" notify process-due --json`;
  return `Set shell = CreateObject("WScript.Shell")\r\nshell.CurrentDirectory = "${vbs(root)}"\r\nshell.Run "${vbs(command)}", 0, True\r\n`;
}

function xmlText(taskXml, tag) {
  const match = String(taskXml ?? '').match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return null;
  return match[1].trim().replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
}

function requiredRegularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`실제 일반 파일이 필요합니다: ${file}`);
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

function resultMessage(result) {
  return String(result?.stderr || result?.stdout || '').trim();
}

function queryCurrentUserSid(run) {
  const script = '[Console]::Out.Write([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)';
  const result = run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true
  });
  const sid = String(result.stdout ?? '').trim();
  if (result.status !== 0 || !/^S-1-(?:\d+-)+\d+$/.test(sid)) throw new Error(`현재 Windows 사용자 SID를 확인하지 못했습니다: ${resultMessage(result)}`);
  return sid;
}

function queryTaskState(run, taskName) {
  const escaped = taskName.replaceAll("'", "''");
  const script = `$task=Get-ScheduledTask -TaskName '${escaped}' -ErrorAction SilentlyContinue; if($null -eq $task){[Console]::Out.Write('absent')}else{[Console]::Out.Write([int]$task.State)}`;
  const result = run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true
  });
  if (result.status !== 0) throw new Error(`Windows 예약 작업 상태를 확인하지 못했습니다: ${resultMessage(result)}`);
  const state = String(result.stdout ?? '').trim();
  if (state === 'absent') return null;
  const numeric = Number(state);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 4) throw new Error(`알 수 없는 Windows 예약 작업 상태입니다: ${state}`);
  return numeric;
}

function queryTaskXml(run, taskName) {
  const result = run('schtasks.exe', ['/Query', '/TN', taskName, '/XML', 'ONE'], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true
  });
  if (result.status === 0) return String(result.stdout ?? '');
  if (queryTaskState(run, taskName) === null) return null;
  throw new Error(`Windows 예약 작업 XML을 읽지 못했습니다: ${resultMessage(result)}`);
}

function defaultPause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForStopped({ run, taskName, pause = defaultPause, timeoutMs = 5_000, pollMs = 50 }) {
  const deadline = Date.now() + timeoutMs;
  let samples = 0;
  for (;;) {
    samples += 1;
    const state = queryTaskState(run, taskName);
    if (state === null || state !== 4) return { confirmed: true, samples, state };
    if (Date.now() >= deadline) throw new Error(`Windows 예약 작업 중지 확인 시간이 초과되었습니다: ${taskName}`);
    pause(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

// The hidden wscript launcher waits for node (shell.Run ..., True). A PT1M limit ended only
// wscript, orphaned node and let the next 1-minute run be refused (0x800710E0) while node kept
// sending. Killing node mid-send would create an unknown Slack delivery, so the limit is set
// above the worst per-run delivery time (20 notifications x about 40 s) instead (2026-10-31 G1).
export function notificationProcessDueTaskBody({ userSid, wscript, launcher, root, startBoundary = '2026-01-01T00:00:00' }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(notificationProcessDueDescription)}</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(userSid)}</UserId></LogonTrigger>
    <TimeTrigger><StartBoundary>${xml(startBoundary)}</StartBoundary><Enabled>true</Enabled><Repetition><Interval>PT1M</Interval><Duration>P9999D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${xml(userSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit><Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(wscript)}</Command><Arguments>/b /nologo &quot;${xml(launcher)}&quot;</Arguments><WorkingDirectory>${xml(root)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

function taskOwned(taskXml, expected) {
  if (!taskXml || xmlText(taskXml, 'Description') !== notificationProcessDueDescription || xmlText(taskXml, 'WorkingDirectory') !== expected.root) return false;
  const command = xmlText(taskXml, 'Command');
  const argumentsText = xmlText(taskXml, 'Arguments');
  const legacyDirectNode = command === expected.node && argumentsText === `"${expected.cli}" notify process-due --json`;
  const hiddenLauncher = command?.toLowerCase() === expected.wscript.toLowerCase()
    && argumentsText === `/b /nologo "${expected.launcher}"`;
  return legacyDirectNode || hiddenLauncher;
}

function taskUsesHiddenLauncher(taskXml, expected) {
  return Boolean(taskXml
    && xmlText(taskXml, 'Command')?.toLowerCase() === expected.wscript.toLowerCase()
    && xmlText(taskXml, 'Arguments') === `/b /nologo "${expected.launcher}"`);
}

function resolvePaths(options = {}) {
  const root = options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const home = options.home ?? os.homedir();
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(home, '.ai-control-center');
  return {
    root,
    home,
    stateRoot,
    node: options.node ?? process.execPath,
    cli: options.cli ?? path.join(root, 'bin', 'aicc'),
    wscript: options.wscript ?? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'),
    launcher: options.launcher ?? path.join(stateRoot, 'notifications', notificationProcessDueLauncherName),
    receipt: options.receipt ?? path.join(stateRoot, 'notifications', 'process-due-scheduler.json'),
    backups: options.backups ?? path.join(stateRoot, 'backups', 'notification-process-due-task')
  };
}

function validateTarget(options, paths) {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('Slack process-due Windows 예약 작업은 Windows에서만 지원합니다.');
  if (options.taskName !== notificationProcessDueTaskName) throw new Error(`--task ${notificationProcessDueTaskName}가 필요합니다.`);
  requiredRegularFile(paths.node);
  requiredRegularFile(paths.cli);
  requiredRegularFile(path.join(paths.root, 'package.json'));
}

export function notificationProcessDueTaskStatus(options = {}) {
  const paths = resolvePaths(options);
  const run = options.spawnSync ?? spawnSync;
  const taskName = options.taskName ?? notificationProcessDueTaskName;
  const taskXml = queryTaskXml(run, taskName);
  const state = taskXml ? queryTaskState(run, taskName) : null;
  const receipt = readJson(paths.receipt);
  const expected = { node: paths.node, cli: paths.cli, wscript: paths.wscript, launcher: paths.launcher, root: paths.root };
  const owned = taskOwned(taskXml, expected);
  const launcherBody = notificationProcessDueLauncherBody(paths);
  const sourceMatches = Boolean(receipt?.nodeSha256 === sha256(fs.readFileSync(paths.node))
    && receipt?.cliSha256 === sha256(fs.readFileSync(paths.cli))
    && receipt?.launcherSha256 === sha256(launcherBody)
    && fs.existsSync(paths.launcher)
    && sha256(fs.readFileSync(paths.launcher)) === receipt.launcherSha256);
  const hiddenLauncher = taskUsesHiddenLauncher(taskXml, expected);
  const ok = owned && hiddenLauncher && receipt?.schemaVersion === 2 && receipt?.taskName === taskName && receipt?.status === 'installed' && sourceMatches;
  return {
    ok,
    state: ok ? 'ready' : taskXml ? 'attention' : 'absent',
    taskName,
    taskState: state,
    owned,
    hiddenLauncher,
    receiptPresent: Boolean(receipt),
    sourceMatches,
    intervalSeconds: 60,
    command: `${paths.wscript} /b /nologo "${paths.launcher}"`,
    receipt: paths.receipt
  };
}

function restorePreviousTask({ run, taskName, previousTaskBackup, previousState }) {
  run('schtasks.exe', ['/End', '/TN', taskName], { encoding: 'utf8', windowsHide: true });
  if (!previousTaskBackup) {
    const removed = run('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { encoding: 'utf8', windowsHide: true });
    const absent = queryTaskState(run, taskName) === null;
    if (removed.status !== 0 && !absent) throw new Error(`실패한 알림 예약 작업을 제거하지 못했습니다: ${resultMessage(removed)}`);
    return;
  }
  const restored = run('schtasks.exe', ['/Create', '/TN', taskName, '/XML', previousTaskBackup, '/F'], { encoding: 'utf8', windowsHide: true });
  if (restored.status !== 0) throw new Error(`이전 알림 예약 작업 복구에 실패했습니다: ${resultMessage(restored)}`);
  if (previousState === 4) {
    const restarted = run('schtasks.exe', ['/Run', '/TN', taskName], { encoding: 'utf8', windowsHide: true });
    if (restarted.status !== 0) throw new Error(`복구한 알림 예약 작업을 다시 시작하지 못했습니다: ${resultMessage(restarted)}`);
  }
}

export function installNotificationProcessDueTask(options = {}) {
  const paths = resolvePaths(options);
  validateTarget(options, paths);
  const run = options.spawnSync ?? spawnSync;
  const userSid = options.userSid ?? queryCurrentUserSid(run);
  if (!/^S-1-(?:\d+-)+\d+$/.test(userSid)) throw new Error('Windows 사용자 SID 형식이 올바르지 않습니다.');
  const taskName = options.taskName;
  const previousXml = queryTaskXml(run, taskName);
  const previousState = previousXml ? queryTaskState(run, taskName) : null;
  const expected = { node: paths.node, cli: paths.cli, wscript: paths.wscript, launcher: paths.launcher, root: paths.root };
  if (previousXml && !taskOwned(previousXml, expected)) {
    throw new Error(`소유하지 않은 Windows 예약 작업을 덮어쓰지 않습니다: ${taskName}`);
  }
  const plan = {
    ok: true,
    dryRun: options.dryRun === true,
    action: 'install',
    taskName,
    previousState,
    intervalSeconds: 60,
    runAtLogon: true,
    keepAlive: false,
    command: `${paths.wscript} /b /nologo "${paths.launcher}"`,
    receipt: paths.receipt,
    rollback: `node ${fileURLToPath(import.meta.url)} rollback --task ${taskName}`
  };
  if (options.dryRun) return plan;

  fs.mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
  const stamp = new Date(options.now?.() ?? Date.now()).toISOString().replaceAll(':', '-');
  const previousTaskBackup = previousXml ? path.join(paths.backups, `${taskName}.${stamp}.xml`) : null;
  if (previousTaskBackup) fs.writeFileSync(previousTaskBackup, previousXml, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const previousLauncherBackup = fs.existsSync(paths.launcher) ? path.join(paths.backups, `${notificationProcessDueLauncherName}.${stamp}.backup`) : null;
  if (previousLauncherBackup) fs.copyFileSync(paths.launcher, previousLauncherBackup, fs.constants.COPYFILE_EXCL);
  const launcherBody = notificationProcessDueLauncherBody(paths);
  fs.mkdirSync(path.dirname(paths.launcher), { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.launcher, launcherBody, { encoding: 'utf8', mode: 0o600 });
  const candidate = path.join(paths.backups, `${taskName}.${stamp}.candidate.${process.pid}.xml`);
  fs.writeFileSync(candidate, `\uFEFF${notificationProcessDueTaskBody({ userSid, wscript: paths.wscript, launcher: paths.launcher, root: paths.root })}`, {
    encoding: 'utf16le', mode: 0o600, flag: 'wx'
  });
  try {
    if (previousState === 4) {
      const ended = run('schtasks.exe', ['/End', '/TN', taskName], { encoding: 'utf8', windowsHide: true });
      if (ended.status !== 0) throw new Error(`기존 알림 예약 작업 중지에 실패했습니다: ${resultMessage(ended)}`);
      (options.waitForStopped ?? waitForStopped)({ run, taskName, pause: options.pause });
    }
    const registered = run('schtasks.exe', ['/Create', '/TN', taskName, '/XML', candidate, '/F'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    if (registered.status !== 0) throw new Error(`알림 예약 작업 등록에 실패했습니다: ${resultMessage(registered)}`);
    const currentXml = queryTaskXml(run, taskName);
    if (!taskOwned(currentXml, expected) || !taskUsesHiddenLauncher(currentXml, expected)) throw new Error('알림 예약 작업 등록 후 숨김 launcher identity가 일치하지 않습니다.');
    atomicWriteJson(paths.receipt, {
      schemaVersion: 2,
      status: 'installed',
      installedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      taskName,
      previousTaskBackup,
      previousLauncherBackup,
      previousState,
      node: paths.node,
      nodeSha256: sha256(fs.readFileSync(paths.node)),
      cli: paths.cli,
      cliSha256: sha256(fs.readFileSync(paths.cli)),
      root: paths.root,
      launcher: paths.launcher,
      launcherSha256: sha256(launcherBody),
      command: `${paths.wscript} /b /nologo "${paths.launcher}"`,
      intervalSeconds: 60
    });
  } catch (error) {
    try { restorePreviousTask({ run, taskName, previousTaskBackup, previousState }); }
    catch (rollbackError) { throw new Error(`${error.message}; rollback: ${rollbackError.message}`); }
    if (previousLauncherBackup) fs.copyFileSync(previousLauncherBackup, paths.launcher);
    else fs.rmSync(paths.launcher, { force: true });
    throw error;
  } finally {
    fs.rmSync(candidate, { force: true });
  }
  return { ...plan, dryRun: false, previousTaskBackup, status: notificationProcessDueTaskStatus({ ...options, receipt: paths.receipt }) };
}

export function stopNotificationProcessDueTask(options = {}) {
  const paths = resolvePaths(options);
  validateTarget(options, paths);
  const run = options.spawnSync ?? spawnSync;
  const current = notificationProcessDueTaskStatus({ ...options, receipt: paths.receipt });
  if (!current.owned) throw new Error(`소유하지 않은 Windows 예약 작업은 중지하지 않습니다: ${options.taskName}`);
  if (options.dryRun) return { ok: true, dryRun: true, action: 'stop', taskName: options.taskName, taskState: current.taskState };
  if (current.taskState === 4) {
    const ended = run('schtasks.exe', ['/End', '/TN', options.taskName], { encoding: 'utf8', windowsHide: true });
    if (ended.status !== 0) throw new Error(`알림 예약 작업 중지에 실패했습니다: ${resultMessage(ended)}`);
  }
  const stopped = (options.waitForStopped ?? waitForStopped)({ run, taskName: options.taskName, pause: options.pause });
  return { ok: true, dryRun: false, action: 'stop', taskName: options.taskName, stopConfirmed: stopped.confirmed === true };
}

export function rollbackNotificationProcessDueTask(options = {}) {
  const paths = resolvePaths(options);
  validateTarget(options, paths);
  const run = options.spawnSync ?? spawnSync;
  const receipt = readJson(paths.receipt);
  if (!receipt || ![1, 2].includes(receipt.schemaVersion) || receipt.taskName !== options.taskName || receipt.status !== 'installed') {
    throw new Error('정확한 설치 영수증이 없어 rollback을 거부합니다.');
  }
  const currentXml = queryTaskXml(run, options.taskName);
  if (currentXml && !taskOwned(currentXml, { node: paths.node, cli: paths.cli, wscript: paths.wscript, launcher: paths.launcher, root: paths.root })) {
    throw new Error(`소유하지 않은 Windows 예약 작업은 복구하지 않습니다: ${options.taskName}`);
  }
  const plan = { ok: true, dryRun: options.dryRun === true, action: 'rollback', taskName: options.taskName, previousTaskBackup: receipt.previousTaskBackup ?? null };
  if (options.dryRun) return plan;
  restorePreviousTask({ run, taskName: options.taskName, previousTaskBackup: receipt.previousTaskBackup ?? null, previousState: receipt.previousState ?? null });
  atomicWriteJson(paths.receipt, { ...receipt, status: 'rolled_back', rolledBackAt: new Date(options.now?.() ?? Date.now()).toISOString() });
  return { ...plan, dryRun: false, restoredPrevious: Boolean(receipt.previousTaskBackup) };
}

export function parseNotificationProcessDueTaskArgs(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const action = argv[0] ?? 'status';
  if (!['status', 'install', 'stop', 'rollback'].includes(action)) throw new Error('action must be status, install, stop, or rollback');
  let taskName = null;
  let dryRun = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') dryRun = true;
    else if (token === '--task') taskName = argv[++index];
    else throw new Error(`unknown option: ${token}`);
  }
  if (action !== 'status' && taskName !== notificationProcessDueTaskName) throw new Error(`--task ${notificationProcessDueTaskName}가 필요합니다.`);
  return { help: false, action, taskName: taskName ?? notificationProcessDueTaskName, dryRun };
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const parsed = parseNotificationProcessDueTaskArgs(process.argv.slice(2));
    if (parsed.help) {
      console.log(`Usage: manage-windows-process-due-task.mjs status | install|stop|rollback --task ${notificationProcessDueTaskName} [--dry-run]`);
      process.exit(0);
    }
    const options = { taskName: parsed.taskName, dryRun: parsed.dryRun };
    const result = parsed.action === 'status' ? notificationProcessDueTaskStatus(options)
      : parsed.action === 'install' ? installNotificationProcessDueTask(options)
        : parsed.action === 'stop' ? stopNotificationProcessDueTask(options)
          : rollbackNotificationProcessDueTask(options);
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    console.error(`aicc-notification-process-due-task: ${error.message}`);
    process.exitCode = 1;
  }
}
