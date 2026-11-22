import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runSharedDaemonCallbackWorker } from '../tools/platform/codex/run-shared-daemon-callback-worker.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-shared-worker-')));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktopCodex = path.join(root, 'codex');
  fs.writeFileSync(desktopCodex, '#!/bin/sh\n', { mode: 0o700 });
  const manifestFile = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestFile, '{"codexVersion":"1"}\n', { mode: 0o600 });
  return {
    platform: 'darwin',
    root,
    desktopCodex,
    manifestFile,
    resultFile: path.join(root, 'result.json'),
    socketPath: path.join(root, 'control.sock')
  };
}

test('shared daemon callback refuses Windows before invoking launchctl or Desktop restart', async () => {
  let invoked = false;
  await assert.rejects(runSharedDaemonCallbackWorker({
    platform: 'win32',
    runCommand: () => { invoked = true; },
    restartDesktop: () => { invoked = true; }
  }), /requires_macos/);
  assert.equal(invoked, false);
});

function daemonIdentity(f) {
  return {
    platform: f.platform,
    daemonCodex: f.desktopCodex,
    manifestFile: f.manifestFile,
    taskId: '01a01d0d-52bc-7671-900f-68d314b37d11',
    projectRoot: f.root,
    inspectDaemon: () => ({
      ok: true,
      status: 'running',
      managedCodexPath: f.desktopCodex,
      managedCodexVersion: '1',
      appServerVersion: '1',
      socketPath: f.socketPath
    }),
    inspectDaemonThread: async () => ({ ok: true, taskId: '01a01d0d-52bc-7671-900f-68d314b37d11', projectRoot: f.root, status: 'notLoaded' })
  };
}

test('one-shot worker enables shared daemon, restarts once and completes the exact callback', async t => {
  const f = fixture(t);
  const commands = [];
  const callbackCalls = [];
  const result = await runSharedDaemonCallbackWorker({
    ...daemonIdentity(f),
    callbackId: '123e4567-e89b-42d3-a456-426614174000',
    operationId: 'same-session-canary-v1',
    resultFile: f.resultFile,
    expectedDesktopPid: 123,
    socketPath: f.socketPath,
    desktopCodex: f.desktopCodex,
    validateSocket: value => value,
    runCommand: (executable, args) => {
      commands.push([executable, args]);
      return args[0] === 'getenv' ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: '', stderr: '' };
    },
    restartDesktop: () => ({ oldPid: 123, newPid: 456, restartCount: 1, forcedTermination: false }),
    inspectSharedDaemon: () => ({ ok: true, environmentEnabled: true, separateAppServer: false, daemonVersion: '1', socketPath: f.socketPath }),
    inspectNativeRoute: () => ({ ok: true, state: 'NATIVE_CALLBACK_ROUTE_SAFE', compactRoute: 'https://chatgpt.com/backend-api/codex', nativeRescue: { ready: true } }),
    callbackService: {
      async complete(options) {
        callbackCalls.push(options);
        return { ok: true, state: 'completed', turnId: 'turn-1', terminalTurnStatus: 'completed' };
      }
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.restart.newPid, 456);
  assert.equal(JSON.parse(fs.readFileSync(f.resultFile, 'utf8')).status, 'PASS');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'callback-delivery.json'), 'utf8')).status, 'PASS');
  assert.match(callbackCalls[0].expectedResultSha256, /^[a-f0-9]{64}$/);
  assert.equal(commands.some(([, args]) => args[0] === 'setenv'), true);
  assert.equal(commands.some(([, args]) => args[0] === 'unsetenv'), false);
});

test('failure before restart records HOLD and rolls back a newly enabled environment', async t => {
  const f = fixture(t);
  const commands = [];
  await assert.rejects(runSharedDaemonCallbackWorker({
    ...daemonIdentity(f),
    callbackId: '123e4567-e89b-42d3-a456-426614174000',
    operationId: 'same-session-canary-v1',
    resultFile: f.resultFile,
    expectedDesktopPid: 123,
    socketPath: f.socketPath,
    desktopCodex: f.desktopCodex,
    validateSocket: value => value,
    runCommand: (executable, args) => {
      commands.push([executable, args]);
      return args[0] === 'getenv' ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: '', stderr: '' };
    },
    inspectNativeRoute: () => ({ ok: true, state: 'NATIVE_CALLBACK_ROUTE_SAFE', compactRoute: 'https://chatgpt.com/backend-api/codex', nativeRescue: { ready: true } }),
    restartDesktop: () => { throw new Error('idle_gate_hold'); }
  }), /idle_gate_hold/);
  const document = JSON.parse(fs.readFileSync(f.resultFile, 'utf8'));
  assert.equal(document.status, 'HOLD');
  assert.equal(document.reason, 'idle_gate_hold');
  assert.equal(commands.some(([, args]) => args[0] === 'unsetenv'), true);
});

test('worker refuses a Desktop restart when the callback task can still compact through 17841', async t => {
  const f = fixture(t);
  let restarted = false;
  await assert.rejects(runSharedDaemonCallbackWorker({
    ...daemonIdentity(f),
    callbackId: '123e4567-e89b-42d3-a456-426614174000',
    operationId: 'same-session-canary-v1',
    resultFile: f.resultFile,
    expectedDesktopPid: 123,
    socketPath: f.socketPath,
    desktopCodex: f.desktopCodex,
    validateSocket: value => value,
    runCommand: () => ({ status: 1, stdout: '', stderr: '' }),
    inspectNativeRoute: () => ({ ok: false, state: 'NATIVE_CALLBACK_ROUTE_NOT_PROVEN', compactRoute: 'http://127.0.0.1:17841/v1', nativeRescue: { ready: true } }),
    restartDesktop: () => { restarted = true; }
  }), /callback_native_route_preflight_failed/);
  assert.equal(restarted, false);
  assert.equal(JSON.parse(fs.readFileSync(f.resultFile, 'utf8')).status, 'HOLD');
  const delivery = JSON.parse(fs.readFileSync(path.join(f.root, 'callback-delivery.json'), 'utf8'));
  assert.equal(delivery.status, 'HOLD');
  assert.equal(delivery.nativeRoute.compactRoute, 'http://127.0.0.1:17841/v1');
});

test('worker records a failed callback turn as HOLD instead of reporting continuation PASS', async t => {
  const f = fixture(t);
  await assert.rejects(runSharedDaemonCallbackWorker({
    ...daemonIdentity(f),
    callbackId: '123e4567-e89b-42d3-a456-426614174000',
    operationId: 'same-session-canary-v1',
    resultFile: f.resultFile,
    expectedDesktopPid: 123,
    socketPath: f.socketPath,
    desktopCodex: f.desktopCodex,
    validateSocket: value => value,
    runCommand: (executable, args) => args[0] === 'getenv'
      ? { status: 0, stdout: '1', stderr: '' }
      : { status: 0, stdout: '', stderr: '' },
    inspectNativeRoute: () => ({ ok: true, state: 'NATIVE_CALLBACK_ROUTE_SAFE', compactRoute: 'https://chatgpt.com/backend-api/codex', nativeRescue: { ready: true } }),
    restartDesktop: () => ({ oldPid: 123, newPid: 456, restartCount: 1, forcedTermination: false }),
    inspectSharedDaemon: () => ({ ok: true, environmentEnabled: true, separateAppServer: false, daemonVersion: '1', socketPath: f.socketPath }),
    callbackService: {
      async complete() { return { ok: false, state: 'terminal_failed', turnId: 'turn-1', terminalTurnStatus: 'failed' }; }
    }
  }), /callback_turn_failed/);
  assert.equal(JSON.parse(fs.readFileSync(f.resultFile, 'utf8')).status, 'PASS');
  const delivery = JSON.parse(fs.readFileSync(path.join(f.root, 'callback-delivery.json'), 'utf8'));
  assert.equal(delivery.status, 'HOLD');
  assert.equal(delivery.callback.state, 'terminal_failed');
});

test('worker refuses a stale daemon before changing launchctl or restarting Desktop', async t => {
  const f = fixture(t);
  const commands = [];
  let restarted = false;
  await assert.rejects(runSharedDaemonCallbackWorker({
    ...daemonIdentity(f),
    callbackId: '123e4567-e89b-42d3-a456-426614174000',
    operationId: 'same-session-canary-v1',
    resultFile: f.resultFile,
    expectedDesktopPid: 123,
    socketPath: f.socketPath,
    desktopCodex: f.desktopCodex,
    validateSocket: value => value,
    inspectDaemon: () => ({
      ok: true,
      status: 'running',
      managedCodexPath: f.desktopCodex,
      managedCodexVersion: '0.147.0',
      appServerVersion: '0.147.0',
      socketPath: f.socketPath
    }),
    runCommand: (executable, args) => {
      commands.push([executable, args]);
      return { status: args[0] === 'getenv' ? 1 : 0, stdout: '', stderr: '' };
    },
    inspectNativeRoute: () => ({ ok: true, state: 'NATIVE_CALLBACK_ROUTE_SAFE', compactRoute: 'https://chatgpt.com/backend-api/codex', nativeRescue: { ready: true } }),
    restartDesktop: () => { restarted = true; }
  }), /shared_daemon_identity_mismatch/);
  assert.equal(restarted, false);
  assert.equal(commands.some(([, args]) => args[0] === 'setenv'), false);
  assert.equal(JSON.parse(fs.readFileSync(f.resultFile, 'utf8')).reason, 'shared_daemon_identity_mismatch');
});
