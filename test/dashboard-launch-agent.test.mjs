import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installDashboardLaunchAgent } from '../tools/platform/dashboard/install-launch-agent.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-dashboard-launchd-'));
  const root = path.join(home, 'AICC');
  const node = path.join(home, 'node');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(node, '#!/bin/sh\n');
  fs.writeFileSync(path.join(root, 'src', 'server.mjs'), '');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.chmodSync(node, 0o700);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, root, node };
}

test('dashboard LaunchAgent installer refuses Windows before any command or file mutation', () => {
  let invoked = false;
  assert.throws(() => installDashboardLaunchAgent({
    platform: 'win32',
    spawnSync: () => { invoked = true; }
  }), /macOS/);
  assert.equal(invoked, false);
});

test('dashboard installer reconciles bootstrap error 5 by post-read without retry', t => {
  const paths = fixture(t);
  let bootstrapCalls = 0;
  let healthCalls = 0;
  const pauses = [];
  const spawnSync = (command, args) => {
    if (command === 'plutil') return { status: 0, stdout: '', stderr: '' };
    if (command === 'curl') {
      healthCalls += 1;
      return healthCalls === 1
        ? { status: 7, stdout: '', stderr: 'connection refused' }
        : { status: 0, stdout: '{"ok":true}', stderr: '' };
    }
    if (args[0] === 'bootout') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'print') return { status: 0, stdout: 'state = running', stderr: '' };
    bootstrapCalls += 1;
    return { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
  };
  const result = installDashboardLaunchAgent({
    ...paths,
    platform: 'darwin',
    uid: 501,
    spawnSync,
    waitForUnloaded: () => ({ confirmed: true, samples: 1 }),
    pause: milliseconds => pauses.push(milliseconds)
  });
  assert.equal(result.ok, true);
  assert.equal(result.unloadConfirmed, true);
  assert.equal(result.bootstrapAttempts, 1);
  assert.equal(result.registeredAfterBootstrapError, true);
  assert.equal(result.healthAttempts, 2);
  assert.equal(result.keepAlive, false);
  assert.equal(result.restartPolicy, 'maintenance-coordinator-only');
  assert.equal(bootstrapCalls, 1);
  assert.equal(healthCalls, 2);
  assert.deepEqual(pauses, [100]);
  const plist = fs.readFileSync(path.join(paths.home, 'Library', 'LaunchAgents', 'com.agenticlab.aicc-dashboard.plist'), 'utf8');
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><false\/>/);
});

test('dashboard installer does not hide a non-transient bootstrap failure', t => {
  const paths = fixture(t);
  const spawnSync = (command, args) => {
    if (command === 'plutil') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'bootout') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'print') return { status: 113, stdout: '', stderr: '' };
    return { status: 77, stdout: '', stderr: 'permission denied' };
  };
  assert.throws(
    () => installDashboardLaunchAgent({ ...paths, platform: 'darwin', uid: 501, spawnSync, waitForUnloaded: () => ({ confirmed: true, samples: 1 }), pause: () => {} }),
    /permission denied/
  );
});

test('dashboard installer fails when launchd registers but healthz never becomes ready', t => {
  const paths = fixture(t);
  const spawnSync = (command, args) => {
    if (command === 'plutil') return { status: 0, stdout: '', stderr: '' };
    if (command === 'curl') return { status: 7, stdout: '', stderr: 'connection refused' };
    if (args[0] === 'bootout' || args[0] === 'bootstrap') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'print') return { status: 113, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  assert.throws(
    () => installDashboardLaunchAgent({
      ...paths,
      platform: 'darwin',
      uid: 501,
      healthAttempts: 2,
      spawnSync,
      waitForUnloaded: () => ({ confirmed: true, samples: 1 }),
      pause: () => {}
    }),
    /healthz 준비를 확인하지 못했습니다/
  );
});

test('dashboard installer restores the exact previous plist when candidate health fails', t => {
  const paths = fixture(t);
  const launchAgents = path.join(paths.home, 'Library', 'LaunchAgents');
  fs.mkdirSync(launchAgents, { recursive: true });
  const plist = path.join(launchAgents, 'com.agenticlab.aicc-dashboard.plist');
  fs.writeFileSync(plist, 'previous-dashboard', { mode: 0o600 });
  let bootstrapCalls = 0;
  const spawnSync = (command, args) => {
    if (command === 'plutil' || args[0] === 'bootout') return { status: 0, stdout: '', stderr: '' };
    if (command === 'curl') return { status: 7, stdout: '', stderr: 'connection refused' };
    if (args[0] === 'bootstrap') { bootstrapCalls += 1; return { status: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'print') return { status: 113, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  assert.throws(
    () => installDashboardLaunchAgent({ ...paths, platform: 'darwin', uid: 501, healthAttempts: 1, spawnSync, waitForUnloaded: () => ({ confirmed: true, samples: 1 }), pause: () => {}, now: () => Date.parse('2026-08-15T00:00:00Z') }),
    /healthz 준비를 확인하지 못했습니다/
  );
  assert.equal(fs.readFileSync(plist, 'utf8'), 'previous-dashboard');
  assert.equal(bootstrapCalls, 2, 'candidate and restored previous plist must each bootstrap once');
});

test('dashboard installer waits for exact unload before the only candidate bootstrap', t => {
  const paths = fixture(t);
  const launchctl = [];
  let printCalls = 0;
  let bootstrapCalls = 0;
  const spawnSync = (command, args) => {
    if (command === 'plutil' || command === 'curl') return { status: 0, stdout: '{}', stderr: '' };
    launchctl.push(args[0]);
    if (args[0] === 'bootout') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'print') {
      printCalls += 1;
      return printCalls < 3
        ? { status: 0, stdout: 'state = exited', stderr: '' }
        : { status: 113, stdout: '', stderr: 'not registered' };
    }
    if (args[0] === 'bootstrap') {
      bootstrapCalls += 1;
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  const result = installDashboardLaunchAgent({ ...paths, platform: 'darwin', uid: 501, spawnSync, pause: () => {} });
  assert.equal(result.unloadConfirmed, true);
  assert.equal(result.unloadSamples, 3);
  assert.equal(bootstrapCalls, 1);
  assert.deepEqual(launchctl, ['bootout', 'print', 'print', 'print', 'bootstrap']);
});

test('dashboard installer restores plist bytes and does not bootstrap when unload is UNKNOWN', t => {
  const paths = fixture(t);
  const launchAgents = path.join(paths.home, 'Library', 'LaunchAgents');
  fs.mkdirSync(launchAgents, { recursive: true });
  const plist = path.join(launchAgents, 'com.agenticlab.aicc-dashboard.plist');
  fs.writeFileSync(plist, 'previous-dashboard', { mode: 0o600 });
  let bootstrapCalls = 0;
  const spawnSync = (command, args) => {
    if (command === 'plutil' || args[0] === 'bootout') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'bootstrap') bootstrapCalls += 1;
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  assert.throws(
    () => installDashboardLaunchAgent({
      ...paths,
      platform: 'darwin',
      uid: 501,
      spawnSync,
      waitForUnloaded: () => { throw new Error('launchd unload 확인 시간이 초과되었습니다'); },
      now: () => Date.parse('2026-08-15T00:00:00Z')
    }),
    /unload 확인에 실패.*plistRollback=restored/
  );
  assert.equal(fs.readFileSync(plist, 'utf8'), 'previous-dashboard');
  assert.equal(bootstrapCalls, 0);
});
