import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installSchedulerLaunchAgent, schedulerLabel, schedulerPlistBody } from '../tools/platform/dashboard/install-scheduler-launch-agent.mjs';
import {
  installNotificationProcessDueTask,
  notificationProcessDueLauncherBody,
  notificationProcessDueTaskBody,
  notificationProcessDueTaskName,
  parseNotificationProcessDueTaskArgs,
  rollbackNotificationProcessDueTask
} from '../tools/platform/slack/manage-windows-process-due-task.mjs';

test('scheduler plist is a bounded launchd tick and does not embed an upstream scan timer in the dashboard', () => {
  const body = schedulerPlistBody({ node: '/usr/bin/node', root: '/private/tmp/open-AICC', home: '/demo/owner', logs: '/demo/owner/logs' });
  assert.match(body, new RegExp(schedulerLabel.replaceAll('.', '\\.')));
  assert.match(body, /local-scheduler\.mjs/);
  assert.match(body, /<key>StartInterval<\/key><integer>30<\/integer>/);
  assert.match(body, /<key>KeepAlive<\/key><false\/>/);
});

test('durable scheduler LaunchAgent installer refuses Windows before any command or file mutation', () => {
  let invoked = false;
  assert.throws(() => installSchedulerLaunchAgent({
    platform: 'win32',
    spawnSync: () => { invoked = true; }
  }), /macOS/);
  assert.equal(invoked, false);
});

test('scheduler installer validates, backs up the exact plist, and registers only its own label', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-scheduler-agent-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'open-AICC');
  const node = path.join(home, 'node');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(node, 'node');
  fs.writeFileSync(path.join(root, 'src', 'local-scheduler.mjs'), '');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(launchAgents, { recursive: true });
  const plist = path.join(launchAgents, `${schedulerLabel}.plist`);
  fs.writeFileSync(plist, 'previous', { mode: 0o600 });
  const calls = [];
  const result = installSchedulerLaunchAgent({
    platform: 'darwin', home, root, node, uid: 501, now: () => Date.parse('2026-08-15T00:00:00Z'),
    spawnSync: (command, args) => { calls.push([command, args]); return { status: 0, stdout: '', stderr: '' }; }
  });
  assert.equal(result.label, schedulerLabel);
  assert.equal(fs.readFileSync(result.previousPlistBackup, 'utf8'), 'previous');
  assert.equal(result.bootstrapAttempts, 1);
  assert.equal(result.intervalSeconds, 30);
  assert.deepEqual(calls.filter(call => call[0] === 'launchctl').map(call => call[1][0]), ['bootout', 'bootstrap', 'print']);
  assert.ok(calls.filter(call => call[0] === 'launchctl').every(call => call[1].join(' ').includes(schedulerLabel)));
});

test('scheduler installer restores the previous plist when registration verification fails', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-scheduler-agent-rollback-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'open-AICC');
  const node = path.join(home, 'node');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(node, 'node');
  fs.writeFileSync(path.join(root, 'src', 'local-scheduler.mjs'), '');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(launchAgents, { recursive: true });
  const plist = path.join(launchAgents, `${schedulerLabel}.plist`);
  fs.writeFileSync(plist, 'previous-scheduler', { mode: 0o600 });
  let bootstrapCalls = 0;
  const spawnSync = (command, args) => {
    if (command === 'plutil' || args[0] === 'bootout') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'bootstrap') { bootstrapCalls += 1; return { status: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'print') return { status: 113, stdout: '', stderr: 'not registered' };
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  assert.throws(
    () => installSchedulerLaunchAgent({ platform: 'darwin', home, root, node, uid: 501, spawnSync, now: () => Date.parse('2026-08-15T00:00:00Z') }),
    /owner 상태를 확인하지 못했습니다/
  );
  assert.equal(fs.readFileSync(plist, 'utf8'), 'previous-scheduler');
  assert.equal(bootstrapCalls, 2);
});

test('scheduler installer reconciles bootstrap error 5 by post-read without retry', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-scheduler-agent-retry-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'open-AICC');
  const node = path.join(home, 'node');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(node, 'node');
  fs.writeFileSync(path.join(root, 'src', 'local-scheduler.mjs'), '');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  let bootstrapCalls = 0;
  const spawnSync = (command, args) => {
    if (command === 'plutil' || args[0] === 'bootout' || args[0] === 'print') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'bootstrap') {
      bootstrapCalls += 1;
      return { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = installSchedulerLaunchAgent({
    platform: 'darwin', home, root, node, uid: 501, spawnSync
  });
  assert.equal(result.bootstrapAttempts, 1);
  assert.equal(result.registeredAfterBootstrapError, true);
  assert.equal(bootstrapCalls, 1);
});

function windowsSchedulerFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-notification-windows-task-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'open-AICC');
  const node = path.join(home, 'node.exe');
  const cli = path.join(root, 'bin', 'aicc');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(node, 'node');
  fs.writeFileSync(cli, 'aicc');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  return { home, root, node, cli, stateRoot: path.join(home, '.ai-control-center') };
}

test('Windows notification scheduler is a least-privilege exact process-due task', () => {
  const body = notificationProcessDueTaskBody({
    userSid: 'S-1-5-21-1000', wscript: 'C:\\Windows\\System32\\wscript.exe', launcher: 'C:\\AICC\\state\\process-due-hidden.vbs', root: 'C:\\AICC'
  });
  assert.match(body, /<Interval>PT1M<\/Interval>/);
  // G1-22: the hidden wscript waits for node; PT1M ended runs mid-send and orphaned node.
  assert.match(body, /<ExecutionTimeLimit>PT15M<\/ExecutionTimeLimit>/);
  assert.doesNotMatch(body, /<ExecutionTimeLimit>PT1M<\/ExecutionTimeLimit>/);
  assert.match(body, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(body, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(body, /wscript\.exe/);
  assert.match(body, /\/b \/nologo/);
  assert.doesNotMatch(body, /node\.exe/);
  assert.doesNotMatch(body, /token|secret|RestartOnFailure/);
});

test('Windows notification scheduler launcher runs process-due without a visible console', () => {
  const body = notificationProcessDueLauncherBody({
    node: 'C:\\AICC\\node.exe', cli: 'C:\\AICC\\bin\\aicc', root: 'C:\\AICC'
  });
  assert.match(body, /notify process-due --json/);
  assert.match(body, /, 0, True/);
  assert.match(body, /CurrentDirectory/);
});

test('Windows notification scheduler dry-run validates without filesystem or task mutation', t => {
  const fixture = windowsSchedulerFixture(t);
  const calls = [];
  const result = installNotificationProcessDueTask({
    ...fixture,
    platform: 'win32',
    taskName: notificationProcessDueTaskName,
    dryRun: true,
    userSid: 'S-1-5-21-1000',
    spawnSync(command, args) {
      calls.push([command, ...args]);
      if (command === 'schtasks.exe') return { status: 1, stdout: '', stderr: 'not found' };
      return { status: 0, stdout: 'absent', stderr: '' };
    }
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.action, 'install');
  assert.equal(calls.some(call => call.includes('/Create') || call.includes('/Delete') || call.includes('/Run')), false);
  assert.equal(fs.existsSync(path.join(fixture.stateRoot, 'notifications', 'process-due-scheduler.json')), false);
});

test('Windows notification scheduler refuses mutation without the exact task target', () => {
  assert.throws(() => parseNotificationProcessDueTaskArgs(['install']), /--task/);
  assert.deepEqual(parseNotificationProcessDueTaskArgs(['install', '--task', notificationProcessDueTaskName, '--dry-run']), {
    help: false,
    action: 'install',
    taskName: notificationProcessDueTaskName,
    dryRun: true
  });
});

for (const schemaVersion of [1, 2]) {
  test(`Windows notification scheduler rollback accepts an installed schema ${schemaVersion} receipt`, t => {
    const fixture = windowsSchedulerFixture(t);
    const receipt = path.join(fixture.stateRoot, 'notifications', 'process-due-scheduler.json');
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, JSON.stringify({
      schemaVersion,
      status: 'installed',
      taskName: notificationProcessDueTaskName,
      previousTaskBackup: null,
      previousState: null
    }));
    const result = rollbackNotificationProcessDueTask({
      ...fixture,
      platform: 'win32',
      taskName: notificationProcessDueTaskName,
      dryRun: true,
      spawnSync(command) {
        if (command === 'schtasks.exe') return { status: 1, stdout: '', stderr: 'not found' };
        return { status: 0, stdout: 'absent', stderr: '' };
      }
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.action, 'rollback');
  });
}
