#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertPrivateCaptchaPath } from '../../../src/notifications/slack-captcha-state.mjs';

export const captchaWorkerTaskName = 'AgenticLab-AICC-Slack-Captcha-Worker';
export const captchaWorkerTaskDescription = 'AgenticLab AICC Slack CAPTCHA Socket worker; owner=AICC; scope=current-user';
const launcherName = 'slack-captcha-worker-hidden.vbs';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const vbs = value => String(value).replaceAll('"', '""');

function readJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function atomicPrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`regular_file_required:${file}`);
}

function textBetween(source, tag) {
  const match = String(source ?? '').match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return match?.[1]?.trim().replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&') ?? null;
}

function resolvePaths(options = {}) {
  const root = options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center');
  const privateRoot = path.join(stateRoot, 'notifications', 'slack-captcha');
  return {
    root,
    stateRoot,
    privateRoot,
    node: options.node ?? process.execPath,
    worker: options.worker ?? path.join(root, 'tools', 'platform', 'slack', 'run-captcha-socket-worker.mjs'),
    wscript: options.wscript ?? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'),
    launcher: options.launcher ?? path.join(privateRoot, launcherName),
    receipt: options.receipt ?? path.join(privateRoot, 'slack-captcha-worker-task.json'),
    backups: options.backups ?? path.join(privateRoot, 'worker-task-backups')
  };
}

export function captchaWorkerLauncherBody(paths) {
  const command = `"${paths.node}" "${paths.worker}"`;
  return `Set shell = CreateObject("WScript.Shell")\r\nshell.CurrentDirectory = "${vbs(paths.root)}"\r\nexitCode = shell.Run("${vbs(command)}", 0, True)\r\nWScript.Quit exitCode\r\n`;
}

export function captchaWorkerTaskXml({ userSid, paths, startBoundary = '2026-01-01T00:00:00' }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(captchaWorkerTaskDescription)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><StartBoundary>${xml(startBoundary)}</StartBoundary><Enabled>true</Enabled><UserId>${xml(userSid)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(userSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(paths.wscript)}</Command><Arguments>/b /nologo &quot;${xml(paths.launcher)}&quot;</Arguments><WorkingDirectory>${xml(paths.root)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

function queryState(run, taskName) {
  const escaped = taskName.replaceAll("'", "''");
  const script = `$task=Get-ScheduledTask -TaskName '${escaped}' -ErrorAction SilentlyContinue; if($null -eq $task){[Console]::Out.Write('absent')}else{[Console]::Out.Write([int]$task.State)}`;
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  if (result.status !== 0) throw new Error('captcha_worker_task_state_failed');
  const value = String(result.stdout ?? '').trim();
  if (value === 'absent') return null;
  const state = Number(value);
  if (!Number.isInteger(state) || state < 0 || state > 4) throw new Error('captcha_worker_task_state_invalid');
  return state;
}

function queryXml(run, taskName) {
  const result = run('schtasks.exe', ['/Query', '/TN', taskName, '/XML', 'ONE'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (result.status === 0) return String(result.stdout ?? '');
  if (queryState(run, taskName) === null) return null;
  throw new Error('captcha_worker_task_query_failed');
}

function currentSid(run) {
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)'], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true
  });
  const sid = String(result.stdout ?? '').trim();
  if (result.status !== 0 || !/^S-1-(?:\d+-)+\d+$/.test(sid)) throw new Error('current_windows_sid_unavailable');
  return sid;
}

function owned(taskXml, paths) {
  return Boolean(taskXml
    && textBetween(taskXml, 'Description') === captchaWorkerTaskDescription
    && textBetween(taskXml, 'WorkingDirectory') === paths.root
    && textBetween(taskXml, 'Command')?.toLowerCase() === paths.wscript.toLowerCase()
    && textBetween(taskXml, 'Arguments') === `/b /nologo "${paths.launcher}"`);
}

function validate(options, paths) {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('windows_required');
  if ((options.taskName ?? captchaWorkerTaskName) !== captchaWorkerTaskName) throw new Error(`exact_task_required:${captchaWorkerTaskName}`);
  regular(paths.node);
  regular(paths.worker);
  regular(path.join(paths.root, 'package.json'));
  (options.checkDirectory ?? assertPrivateCaptchaPath)(paths.privateRoot);
}

function restore(run, taskName, previousTaskBackup, previousState) {
  run('schtasks.exe', ['/End', '/TN', taskName], { encoding: 'utf8', windowsHide: true });
  if (!previousTaskBackup) {
    run('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { encoding: 'utf8', windowsHide: true });
    if (queryState(run, taskName) !== null) throw new Error('captcha_worker_task_delete_failed');
    return;
  }
  regular(previousTaskBackup);
  const result = run('schtasks.exe', ['/Create', '/TN', taskName, '/XML', previousTaskBackup, '/F'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('captcha_worker_task_restore_failed');
  if (previousState === 4) run('schtasks.exe', ['/Run', '/TN', taskName], { encoding: 'utf8', windowsHide: true });
}

export function captchaWorkerTaskStatus(options = {}) {
  const paths = resolvePaths(options);
  validate(options, paths);
  const run = options.spawnSync ?? spawnSync;
  const taskName = options.taskName ?? captchaWorkerTaskName;
  const taskXml = queryXml(run, taskName);
  const taskState = taskXml ? queryState(run, taskName) : null;
  const receipt = readJson(paths.receipt);
  const launcherBody = captchaWorkerLauncherBody(paths);
  let launcherSafe = false;
  try { regular(paths.launcher); launcherSafe = true; } catch { launcherSafe = false; }
  const sourceMatches = Boolean(receipt?.schemaVersion === 1 && receipt.status === 'installed'
    && receipt.taskName === taskName && receipt.root === paths.root && receipt.node === paths.node && receipt.worker === paths.worker
    && receipt.nodeSha256 === sha256(fs.readFileSync(paths.node)) && receipt.workerSha256 === sha256(fs.readFileSync(paths.worker))
    && receipt.launcherSha256 === sha256(launcherBody) && launcherSafe
    && sha256(fs.readFileSync(paths.launcher)) === receipt.launcherSha256);
  const taskOwned = owned(taskXml, paths);
  const ok = taskOwned && sourceMatches;
  return { ok, state: ok ? 'ready' : taskXml ? 'attention' : 'absent', taskName, taskState, owned: taskOwned,
    sourceMatches, hidden: taskOwned, trigger: 'current_user_logon', secretsInCommand: false, receipt: paths.receipt };
}

export function installCaptchaWorkerTask(options = {}) {
  const paths = resolvePaths(options);
  validate(options, paths);
  const run = options.spawnSync ?? spawnSync;
  const taskName = options.taskName ?? captchaWorkerTaskName;
  const priorXml = queryXml(run, taskName);
  const priorState = priorXml ? queryState(run, taskName) : null;
  if (priorXml && !owned(priorXml, paths)) throw new Error('unowned_captcha_worker_task');
  const plan = { ok: true, action: 'install', dryRun: options.dryRun === true, taskName, trigger: 'current_user_logon', hidden: true,
    secretsInCommand: false, command: `${paths.wscript} /b /nologo "${paths.launcher}"`, receipt: paths.receipt };
  if (options.dryRun) return plan;
  const userSid = options.userSid ?? currentSid(run);
  if (!/^S-1-(?:\d+-)+\d+$/.test(userSid)) throw new Error('invalid_windows_sid');
  fs.mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
  (options.checkDirectory ?? assertPrivateCaptchaPath)(paths.backups);
  const stamp = new Date(options.now?.() ?? Date.now()).toISOString().replaceAll(':', '-');
  const previousTaskBackup = priorXml ? path.join(paths.backups, `${taskName}.${stamp}.xml`) : null;
  const previousLauncherBackup = fs.existsSync(paths.launcher) ? path.join(paths.backups, `${launcherName}.${stamp}.backup`) : null;
  if (previousTaskBackup) fs.writeFileSync(previousTaskBackup, priorXml, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  if (previousLauncherBackup) {
    regular(paths.launcher);
    fs.copyFileSync(paths.launcher, previousLauncherBackup, fs.constants.COPYFILE_EXCL);
  }
  const launcherBody = captchaWorkerLauncherBody(paths);
  fs.writeFileSync(paths.launcher, launcherBody, { encoding: 'utf8', mode: 0o600 });
  const candidate = path.join(paths.backups, `${taskName}.${stamp}.candidate.${process.pid}.xml`);
  fs.writeFileSync(candidate, `\uFEFF${captchaWorkerTaskXml({ userSid, paths })}`, { encoding: 'utf16le', mode: 0o600, flag: 'wx' });
  try {
    if (priorState === 4) run('schtasks.exe', ['/End', '/TN', taskName], { encoding: 'utf8', windowsHide: true });
    const created = run('schtasks.exe', ['/Create', '/TN', taskName, '/XML', candidate, '/F'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (created.status !== 0 || !owned(queryXml(run, taskName), paths)) throw new Error('captcha_worker_task_install_failed');
    atomicPrivateJson(paths.receipt, { schemaVersion: 1, status: 'installed', installedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      taskName, root: paths.root, node: paths.node, nodeSha256: sha256(fs.readFileSync(paths.node)), worker: paths.worker,
      workerSha256: sha256(fs.readFileSync(paths.worker)), launcher: paths.launcher, launcherSha256: sha256(launcherBody),
      previousTaskBackup, previousLauncherBackup, previousState: priorState, secretsInCommand: false });
  } catch (error) {
    restore(run, taskName, previousTaskBackup, priorState);
    if (previousLauncherBackup) { regular(previousLauncherBackup); fs.copyFileSync(previousLauncherBackup, paths.launcher); }
    else fs.rmSync(paths.launcher, { force: true });
    throw error;
  } finally { fs.rmSync(candidate, { force: true }); }
  return { ...plan, dryRun: false, status: captchaWorkerTaskStatus({ ...options, taskName, receipt: paths.receipt }) };
}

export function stopCaptchaWorkerTask(options = {}) {
  const paths = resolvePaths(options);
  validate(options, paths);
  const run = options.spawnSync ?? spawnSync;
  const current = captchaWorkerTaskStatus({ ...options, taskName: captchaWorkerTaskName });
  if (!current.owned) throw new Error('unowned_captcha_worker_task');
  if (options.dryRun) return { ok: true, action: 'stop', dryRun: true, taskName: captchaWorkerTaskName };
  if (current.taskState === 4) {
    const result = run('schtasks.exe', ['/End', '/TN', captchaWorkerTaskName], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error('captcha_worker_task_stop_failed');
  }
  if (queryState(run, captchaWorkerTaskName) === 4) throw new Error('captcha_worker_task_stop_unconfirmed');
  return { ok: true, action: 'stop', dryRun: false, taskName: captchaWorkerTaskName };
}

export function rollbackCaptchaWorkerTask(options = {}) {
  const paths = resolvePaths(options);
  validate(options, paths);
  const run = options.spawnSync ?? spawnSync;
  const receipt = readJson(paths.receipt);
  if (receipt?.schemaVersion !== 1 || receipt.status !== 'installed' || receipt.taskName !== captchaWorkerTaskName) throw new Error('captcha_worker_receipt_required');
  const taskXml = queryXml(run, captchaWorkerTaskName);
  if (taskXml && !owned(taskXml, paths)) throw new Error('unowned_captcha_worker_task');
  if (options.dryRun) return { ok: true, action: 'rollback', dryRun: true, taskName: captchaWorkerTaskName };
  restore(run, captchaWorkerTaskName, receipt.previousTaskBackup, receipt.previousState);
  if (receipt.previousLauncherBackup) { regular(receipt.previousLauncherBackup); fs.copyFileSync(receipt.previousLauncherBackup, paths.launcher); }
  else fs.rmSync(paths.launcher, { force: true });
  atomicPrivateJson(paths.receipt, { ...receipt, status: 'rolled_back', rolledBackAt: new Date(options.now?.() ?? Date.now()).toISOString() });
  return { ok: true, action: 'rollback', dryRun: false, taskName: captchaWorkerTaskName, restoredPrevious: Boolean(receipt.previousTaskBackup) };
}

function parse(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const action = argv[0] ?? 'status';
  if (!['status', 'install', 'stop', 'rollback'].includes(action)) throw new Error('unsupported_action');
  const dryRun = argv.includes('--dry-run');
  const taskIndex = argv.indexOf('--task');
  const taskName = taskIndex >= 0 ? argv[taskIndex + 1] : captchaWorkerTaskName;
  if (taskName !== captchaWorkerTaskName) throw new Error(`exact_task_required:${captchaWorkerTaskName}`);
  return { help: false, action, dryRun, taskName };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const input = parse(process.argv.slice(2));
    if (input.help) {
      process.stdout.write(`Usage: manage-windows-captcha-worker-task.mjs status | install|stop|rollback --task ${captchaWorkerTaskName} [--dry-run]\n`);
    } else {
      const options = { taskName: input.taskName, dryRun: input.dryRun };
      const result = input.action === 'status' ? captchaWorkerTaskStatus(options)
        : input.action === 'install' ? installCaptchaWorkerTask(options)
          : input.action === 'stop' ? stopCaptchaWorkerTask(options) : rollbackCaptchaWorkerTask(options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.ok === false) process.exitCode = 1;
    }
  } catch {
    process.stderr.write('{"ok":false,"state":"captcha_worker_task_hold"}\n');
    process.exitCode = 1;
  }
}
