import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  captchaWorkerLauncherBody,
  captchaWorkerTaskName,
  captchaWorkerTaskXml,
  captchaWorkerTaskStatus,
  installCaptchaWorkerTask,
  rollbackCaptchaWorkerTask,
  stopCaptchaWorkerTask
} from '../tools/platform/slack/manage-windows-captcha-worker-task.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-captcha-task-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tools', 'platform', 'slack'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'node.exe'), 'fake-node\n');
  fs.writeFileSync(path.join(root, 'tools', 'platform', 'slack', 'run-captcha-socket-worker.mjs'), 'await new Promise(() => {});\n');
  fs.mkdirSync(path.join(root, 'state', 'notifications', 'slack-captcha'), { recursive: true });
  return {
    root,
    stateRoot: path.join(root, 'state'),
    node: path.join(root, 'node.exe'),
    worker: path.join(root, 'tools', 'platform', 'slack', 'run-captcha-socket-worker.mjs'),
    wscript: 'C:\\Windows\\System32\\wscript.exe',
    platform: 'win32',
    userSid: 'S-1-5-21-1000',
    checkDirectory: () => {}
  };
}

function fakeScheduler() {
  let taskXml = null;
  let state = 3;
  const calls = [];
  const run = (command, args) => {
    calls.push([command, [...args]]);
    if (command === 'pwsh' || command === 'powershell.exe') {
      const script = args.at(-1);
      if (script.includes('WindowsIdentity')) return { status: 0, stdout: 'S-1-5-21-1000' };
      return { status: 0, stdout: taskXml ? String(state) : 'absent' };
    }
    if (command !== 'schtasks.exe') return { status: 1, stdout: '' };
    if (args[0] === '/Query') return taskXml ? { status: 0, stdout: taskXml } : { status: 1, stdout: '' };
    if (args[0] === '/Create') {
      const xmlFile = args[args.indexOf('/XML') + 1];
      taskXml = fs.readFileSync(xmlFile, 'utf16le').replace(/^\uFEFF/, '');
      state = 3;
      return { status: 0, stdout: 'created' };
    }
    if (args[0] === '/End') { state = 3; return { status: 0, stdout: 'ended' }; }
    if (args[0] === '/Run') { state = 4; return { status: 0, stdout: 'running' }; }
    if (args[0] === '/Delete') { taskXml = null; state = 3; return { status: 0, stdout: 'deleted' }; }
    return { status: 1, stdout: '' };
  };
  return { run, calls, setRunning: () => { state = 4; }, currentXml: () => taskXml };
}

test('Windows Task Scheduler parses generated XML with one hidden current-user logon action', t => {
  const options = fixture(t);
  const paths = {
    ...options,
    launcher: path.join(options.stateRoot, 'notifications', 'slack-captcha', 'slack-captcha-worker-hidden.vbs')
  };
  const body = captchaWorkerTaskXml({ userSid: options.userSid, paths });
  const parsed = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $raw=[Console]::In.ReadToEnd(); $doc=New-Object System.Xml.XmlDocument; $doc.LoadXml($raw); $svc=New-Object -ComObject Schedule.Service; $svc.Connect(); $definition=$svc.NewTask(0); $definition.XmlText=$raw; [Console]::Out.Write("$($doc.DocumentElement.LocalName):$($definition.Triggers.Count):$($definition.Actions.Count)")'],
  { input: body, encoding: 'utf8', windowsHide: true });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.equal(parsed.stdout, 'Task:1:1');
  assert.equal((body.match(/<LogonTrigger>/g) ?? []).length, 1);
  assert.match(body, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(body, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(body, /<Hidden>true<\/Hidden>/);
  assert.match(body, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(body, /<Command>C:\\Windows\\System32\\wscript\.exe<\/Command>/);
  assert.doesNotMatch(body, /xapp-|xox[baprs]-|AICC_SLACK_CAPTCHA_APP_TOKEN|<Environment>/i);
});

test('launcher contains only the exact node worker command and no secret carrier', t => {
  const options = fixture(t);
  const body = captchaWorkerLauncherBody(options);
  assert.match(body, new RegExp(options.node.replaceAll('\\', '\\\\').replaceAll('.', '\\.')));
  assert.match(body, new RegExp(options.worker.replaceAll('\\', '\\\\').replaceAll('.', '\\.')));
  assert.match(body, /exitCode = shell\.Run\(.*?, 0, True\)/);
  assert.match(body, /WScript\.Quit exitCode/);
  assert.doesNotMatch(body, /xapp-|xox[baprs]-|TOKEN|GetEnvironment|Environment/i);
});

test('install, status, stop and rollback preserve exact ownership and recovery receipt', t => {
  const options = fixture(t);
  const scheduler = fakeScheduler();
  const shared = { ...options, spawnSync: scheduler.run, now: () => Date.parse('2026-09-05T00:00:00Z') };
  const installed = installCaptchaWorkerTask(shared);
  assert.equal(installed.status.ok, true);
  assert.equal(installed.secretsInCommand, false);
  assert.equal(captchaWorkerTaskStatus(shared).state, 'ready');
  assert.match(scheduler.currentXml(), /owner=AICC; scope=current-user/);
  scheduler.setRunning();
  assert.equal(stopCaptchaWorkerTask(shared).ok, true);
  assert.equal(rollbackCaptchaWorkerTask(shared).restoredPrevious, false);
  assert.equal(captchaWorkerTaskStatus(shared).state, 'absent');
  const receipt = JSON.parse(fs.readFileSync(path.join(options.stateRoot, 'notifications', 'slack-captcha', 'slack-captcha-worker-task.json'), 'utf8'));
  assert.equal(receipt.status, 'rolled_back');
  assert.equal(receipt.secretsInCommand, false);
  assert.equal(fs.existsSync(path.join(options.stateRoot, 'notifications', 'slack-captcha', 'slack-captcha-worker-hidden.vbs')), false);
});

test('install refuses a same-name task not owned by AICC', t => {
  const options = fixture(t);
  const scheduler = fakeScheduler();
  const foreign = path.join(options.root, 'foreign.xml');
  fs.writeFileSync(foreign, '<?xml version="1.0"?><Task><RegistrationInfo><Description>someone else</Description></RegistrationInfo></Task>', 'utf16le');
  scheduler.run('schtasks.exe', ['/Create', '/TN', captchaWorkerTaskName, '/XML', foreign, '/F']);
  assert.throws(() => installCaptchaWorkerTask({ ...options, spawnSync: scheduler.run }), /unowned_captcha_worker_task/);
});

test('manager refuses status before the owner-only state ACL gate passes', t => {
  const options = fixture(t);
  let schedulerCalls = 0;
  assert.throws(() => captchaWorkerTaskStatus({
    ...options,
    checkDirectory: () => { throw new Error('private_windows_acl_required'); },
    spawnSync: () => { schedulerCalls += 1; return { status: 0, stdout: 'absent' }; }
  }), /private_windows_acl_required/);
  assert.equal(schedulerCalls, 0);
});
