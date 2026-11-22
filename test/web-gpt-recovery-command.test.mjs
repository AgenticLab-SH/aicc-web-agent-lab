import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recoverWebGptLauncher, repairStaleWebGptNativeUpstream } from '../src/web-gpt-recovery-command.mjs';

function temporaryHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-web-gpt-recovery-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeOwnership(home, { ownerPid, descriptorPid = ownerPid, daemonPid = null, status = 'degraded' }) {
  const runtimeRoot = path.join(home, '.codex-chatgpt-web', 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'launcher-browser.json'), JSON.stringify({
    version: 1,
    kind: 'codex-web-gpt-launcher',
    pid: descriptorPid,
    createdAt: '2026-08-09T00:00:00.000Z'
  }));
  fs.writeFileSync(path.join(runtimeRoot, 'launcher-supervisor.json'), JSON.stringify({
    version: 1,
    ownerPid,
    daemonPid,
    status,
    updatedAt: '2026-08-09T00:00:01.000Z'
  }));
}

test('Web GPT runtime recovery rejects unsupported platforms', async () => {
  await assert.rejects(
    recoverWebGptLauncher({ platform: 'linux' }),
    /supported only on macOS or service-owned Windows/
  );
});

test('stale standalone OCX native upstream is removed only for the remote-client topology', t => {
  const home = temporaryHome(t);
  const webRoot = path.join(home, '.codex-chatgpt-web');
  const ocxRoot = path.join(home, '.opencodex');
  fs.mkdirSync(webRoot, { recursive: true });
  fs.mkdirSync(ocxRoot, { recursive: true });
  const configPath = path.join(webRoot, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port: 17841,
    runtimeOwner: 'service',
    nativeUpstreamBaseUrl: 'http://127.0.0.1:10100/v1',
    controlToken: 'fixture-secret'
  }));
  fs.writeFileSync(path.join(ocxRoot, 'config.json'), JSON.stringify({
    runtimeRole: 'client',
    client: { serverUrl: 'http://localhost:10101' }
  }));

  const repaired = repairStaleWebGptNativeUpstream({ home });
  assert.equal(repaired.changed, true);
  assert.equal(repaired.reason, 'removed-stale-standalone-ocx-upstream');
  const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal('nativeUpstreamBaseUrl' in after, false);
  assert.equal(after.controlToken, 'fixture-secret');

  const backupDir = path.join(webRoot, 'recovery', 'native-upstream-compat');
  const backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1);
  const backup = JSON.parse(fs.readFileSync(path.join(backupDir, backups[0]), 'utf8'));
  assert.equal(backup.nativeUpstreamBaseUrl, 'http://127.0.0.1:10100/v1');

  const second = repairStaleWebGptNativeUpstream({ home });
  assert.equal(second.changed, false);
  assert.equal(second.reason, 'no-known-stale-upstream');
});

test('service-owned Windows recovery uses official runtime stop/start and repairs the stale upstream first', async t => {
  const home = temporaryHome(t);
  const webRoot = path.join(home, '.codex-chatgpt-web');
  const ocxRoot = path.join(home, '.opencodex');
  fs.mkdirSync(webRoot, { recursive: true });
  fs.mkdirSync(ocxRoot, { recursive: true });
  const configPath = path.join(webRoot, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port: 17841,
    runtimeOwner: 'service',
    runtimeCommand: ['C:\\runtime\\bun.exe', 'C:\\runtime\\cli.js'],
    nativeUpstreamBaseUrl: 'http://127.0.0.1:10100/v1'
  }));
  fs.writeFileSync(path.join(ocxRoot, 'config.json'), JSON.stringify({
    runtimeRole: 'client',
    client: { serverUrl: 'http://localhost:10101' }
  }));

  let reads = 0;
  const commands = [];
  const result = await recoverWebGptLauncher({
    platform: 'win32',
    home,
    bridgeHealth: async () => {
      reads += 1;
      return reads === 1
        ? {
            status: 'ok', service: 'codex-chatgpt-web', runtime_owner: 'service', pid: 91,
            accepting_turns: true, accepting_browser_turns: true,
            active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0
          }
        : {
            status: 'ok', service: 'codex-chatgpt-web', runtime_owner: 'service', pid: 92,
            accepting_turns: true, accepting_browser_turns: true,
            active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0
          };
    },
    spawnSync: (executable, args) => {
      commands.push([executable, args]);
      return { status: 0, stdout: '{}', stderr: '' };
    },
    sleep: async () => {},
    timeoutMs: 100
  });

  assert.equal(result.ok, true);
  assert.equal(result.routerOwner, 'service');
  assert.equal(result.routerRestarted, true);
  assert.equal(result.browserHostRestarted, false);
  assert.equal(result.nativeUpstreamRepair.changed, true);
  assert.deepEqual(commands, [
    ['C:\\runtime\\bun.exe', ['C:\\runtime\\cli.js', 'runtime', 'stop', '--json']],
    ['C:\\runtime\\bun.exe', ['C:\\runtime\\cli.js', 'runtime', 'start', '--json']]
  ]);
  const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal('nativeUpstreamBaseUrl' in after, false);
});

test('Web GPT runtime recovery refuses to restart while work is active', async t => {
  const home = temporaryHome(t);
  await assert.rejects(
    recoverWebGptLauncher({
      platform: 'darwin',
      home,
      bridgeHealth: async () => ({
        status: 'ok',
        service: 'codex-chatgpt-web',
        pid: 91,
        active_http_turns: 1,
        active_browser_http_turns: 0,
        active_browser_turns: 0
      })
    }),
    /still has active work/
  );
});

test('service-owned recovery requires all three route counters to be exactly zero', async t => {
  const home = temporaryHome(t);
  fs.mkdirSync(path.join(home, '.codex-chatgpt-web'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex-chatgpt-web', 'config.json'), JSON.stringify({ runtimeOwner: 'service' }));
  writeOwnership(home, { ownerPid: 999_999_999, daemonPid: null });
  await assert.rejects(
    recoverWebGptLauncher({
      platform: 'darwin',
      home,
      bridgeHealth: async () => ({
        status: 'ok',
        service: 'codex-chatgpt-web',
        runtime_owner: 'service',
        pid: 91,
        active_http_turns: 4,
        active_browser_http_turns: 0,
        active_browser_turns: 0
      })
    }),
    /still has active work/
  );
});

test('service-owned recovery restarts only the exact router runtime and preserves the browser host', async t => {
  const home = temporaryHome(t);
  const providerHome = path.join(home, '.codex-chatgpt-web');
  fs.mkdirSync(providerHome, { recursive: true });
  fs.writeFileSync(path.join(providerHome, 'config.json'), JSON.stringify({
    runtimeOwner: 'service',
    runtimeCommand: [path.join(providerHome, 'runtime', 'codex-chatgpt-web')]
  }));
  let reads = 0;
  let restarts = 0;
  const result = await recoverWebGptLauncher({
    platform: 'darwin',
    home,
    bridgeHealth: async () => {
      reads += 1;
      return reads === 1
        ? {
            status: 'ok', service: 'codex-chatgpt-web', runtime_owner: 'service', pid: 91,
            accepting_turns: true, accepting_browser_turns: false,
            active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0
          }
        : {
            status: 'ok', service: 'codex-chatgpt-web', runtime_owner: 'service', pid: 92,
            accepting_turns: true, accepting_browser_turns: false,
            active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0
          };
    },
    restartService: async () => { restarts += 1; },
    sleep: async () => {},
    timeoutMs: 100
  });
  assert.equal(restarts, 1);
  assert.equal(result.routerOwner, 'service');
  assert.equal(result.routerRestarted, true);
  assert.equal(result.browserHostRestarted, false);
  assert.equal(result.acceptingBrowserTurns, false);
});

test('recovery records offline health as UNKNOWN and performs no restart', async t => {
  const home = temporaryHome(t);
  let restarts = 0;
  await assert.rejects(
    recoverWebGptLauncher({
      platform: 'darwin',
      home,
      bridgeHealth: async () => null,
      restartService: async () => { restarts += 1; }
    }),
    /UNKNOWN/
  );
  assert.equal(restarts, 0);
});

test('Web GPT runtime recovery refuses a healthy bridge without verified launcher ownership', async t => {
  const home = temporaryHome(t);
  await assert.rejects(
    recoverWebGptLauncher({
      platform: 'darwin',
      home,
      bridgeHealth: async () => ({
        status: 'ok',
        service: 'codex-chatgpt-web',
        pid: 91,
        active_http_turns: 0,
        active_browser_http_turns: 0,
        active_browser_turns: 0
      })
    }),
    /ownership cannot be verified/
  );
});

test('Web GPT runtime recovery refuses conflicting launcher ownership markers', async t => {
  const home = temporaryHome(t);
  writeOwnership(home, { ownerPid: 92, descriptorPid: 91, daemonPid: 93, status: 'ready' });

  await assert.rejects(
    recoverWebGptLauncher({
      platform: 'darwin',
      home,
      bridgeHealth: async () => ({
        status: 'ok', service: 'codex-chatgpt-web', pid: 93,
        active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0
      })
    }),
    /ownership markers disagree/
  );
});

test('Web GPT runtime recovery refuses a stale PID owned by another process', async t => {
  const home = temporaryHome(t);
  writeOwnership(home, { ownerPid: process.pid });

  await assert.rejects(
    recoverWebGptLauncher({
      platform: 'darwin',
      home,
      bridgeHealth: async () => ({
        status: 'ok', service: 'codex-chatgpt-web', pid: 93,
        active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0
      }),
      processCommand: () => '/usr/bin/unrelated-process'
    }),
    /does not belong to Codex Web GPT/
  );
});
