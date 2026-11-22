import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { accountStatus } from '../src/adapters/accounts.mjs';
import { authPortalStatus } from '../src/adapters/auth-portal.mjs';
import { ocxStatus } from '../src/adapters/ocx.mjs';
import { ocxAccountStatus } from '../src/adapters/ocx-accounts.mjs';
import { localToolStatus } from '../src/adapters/local-tools.mjs';
import { webGptStatus } from '../src/adapters/web-gpt.mjs';
import { codexRouteStatus } from '../src/adapters/codex-routes.mjs';
import { projectOcxStorageGovernance, validateOcxCleanupDryRun } from '../src/ocx-storage-governance.mjs';
import { startOcxAsUpstream } from '../src/ocx-upstream-start-command.mjs';
import { syncOcxUpstreamCatalog } from '../src/ocx-upstream-sync-command.mjs';

test('account adapter accepts the masked cm JSON contract', async () => {
  const status = await accountStatus({
    command: { executable: 'cm-fixture', args: ['status', '--json'] },
    runCommand: async () => ({
      ok: true,
      stdout: JSON.stringify({
        ok: true,
        schema_version: 1,
        account_count: 1,
        active_account: 'account-one',
        accounts: [{ account: 'account-one', access_token: 'must-not-leak' }]
      })
    })
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.accountCount, 1);
  assert.equal(status.accounts[0].access_token, '<redacted>');
});

test('account adapter fails closed on non-JSON output', async () => {
  const status = await accountStatus({
    command: { executable: 'cm-fixture', args: [] },
    runCommand: async () => ({ ok: true, stdout: 'not json' })
  });
  assert.equal(status.state, 'degraded');
  assert.equal(status.error, 'invalid JSON response');
});

test('OCX adapter combines installed version and health', async () => {
  const responses = new Map([
    ['--version', { ok: true, stdout: 'opencodex 2.7.42\n' }],
    ['health --json', { ok: true, stdout: JSON.stringify({ ok: true, pid: 42, port: 10100 }) }],
    ['ready --json', { ok: true, stdout: JSON.stringify({ ready: true, status: 'ready', pid: 42, port: 10100 }) }]
  ]);
  const status = await ocxStatus({
    executable: 'ocx-fixture',
    runCommand: async (_executable, args) => responses.get(args.join(' '))
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.version, '2.7.42');
  assert.equal(status.runtime.port, 10100);
});

test('OCX adapter reports the managed runtime version when the standalone CLI is stale', async () => {
  const responses = new Map([
    ['--version', { ok: true, stdout: 'opencodex 2.12.0\n' }],
    ['health --json', { ok: true, stdout: JSON.stringify({ ok: true, version: '2.29.0', pid: 42, port: 10100 }) }],
    ['ready --json', { ok: true, stdout: JSON.stringify({ ready: true, status: 'ready', pid: 42, port: 10100 }) }]
  ]);
  const status = await ocxStatus({
    executable: 'ocx-fixture',
    runCommand: async (_executable, args) => responses.get(args.join(' '))
  });
  assert.equal(status.version, '2.29.0');
  assert.equal(status.cliVersion, '2.12.0');
  assert.equal(status.versionSource, 'cli-health');
});

test('OCX adapter prefers exact loopback runtime identity over stale standalone CLI output', async () => {
  const responses = new Map([
    ['--version', { ok: true, stdout: 'opencodex 2.12.0\n' }],
    ['health --json', { ok: true, stdout: JSON.stringify({ ok: true, pid: 41, port: 10100 }) }],
    ['ready --json', { ok: true, stdout: JSON.stringify({ ready: true, status: 'ready', pid: 41, port: 10100 }) }]
  ]);
  const status = await ocxStatus({
    executable: 'ocx-fixture',
    runCommand: async (_executable, args) => responses.get(args.join(' ')) ?? { ok: true, stdout: '{}' },
    fetch: async url => ({
      ok: true,
      json: async () => String(url).endsWith('/healthz')
        ? { status: 'ok', service: 'opencodex', version: '2.14.1', pid: 42, port: 10100 }
        : { status: 'ready', service: 'opencodex', version: '2.14.1', pid: 42, port: 10100 }
    })
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.version, '2.14.1');
  assert.equal(status.cliVersion, '2.12.0');
  assert.equal(status.versionSource, 'managed-runtime-health');
  assert.equal(status.versionMismatch, true);
  assert.equal(status.runtime.pid, 42);
  assert.equal(status.cliRuntime.pid, 41);
  assert.equal(status.managedRuntimeProbe.healthVerified, true);
  assert.equal(status.managedRuntimeProbe.readinessVerified, true);
});

test('OCX adapter summarizes official read-only CLI data for the AICC dashboard', async () => {
  const payloads = new Map([
    ['--version', 'opencodex 2.10.0\n'],
    ['health --json', JSON.stringify({ ok: true, pid: 42, port: 10100 })],
    ['ready --json', JSON.stringify({ ready: true, status: 'ready', pid: 42, port: 10100 })],
    ['provider list --json', JSON.stringify({ configured: [{ name: 'openai', isDefault: true }, { name: 'kiro' }] })],
    ['models list --json', JSON.stringify({ models: [{ model: 'one' }, { model: 'two' }, { model: 'three' }] })],
    ['agent status --json', JSON.stringify({ v2: { multiAgentMode: 'default' }, subagents: { chosen: ['one'] } })],
    ['system status --json', JSON.stringify({ startup: { status: 'at-risk', rebootSafe: false, serviceRunning: true, routingInjected: false }, memory: { uptimeSeconds: 90, rss: 1024, activeTurnCount: 0, appOwnedBytes: { budgetBytes: 2048, retainedBytes: 512, observedInFlight: { translator_buffers: { active: 0 } } } } })],
    ['observe usage --json', JSON.stringify({ summary: { requests: 12, totalTokens: 345, coverageRatio: 0.9 } })],
    ['combo list --json', JSON.stringify({ combos: [{ id: 'fallback' }] })],
    ['observe storage --json', JSON.stringify({ total: { bytes: 512, fileCount: 2 }, buckets: [{ key: 'archived_sessions', bytes: 400, fileCount: 1 }, { key: 'state_db', bytes: 112, fileCount: 1, rows: 3 }] })],
    ['access endpoints --json', JSON.stringify({ baseUrl: 'http://127.0.0.1:10100/v1', responsesEndpoint: 'http://127.0.0.1:10100/v1/responses', modelsEndpoint: 'http://127.0.0.1:10100/v1/models' })]
  ]);
  const status = await ocxStatus({
    executable: 'ocx-fixture',
    autoSwitchThreshold: 98,
    runCommand: async (_executable, args) => ({ ok: true, stdout: payloads.get(args.join(' ')) ?? '{}' })
  });
  assert.deepEqual(status.overview.providerNames, ['openai', 'kiro']);
  assert.equal(status.overview.defaultProvider, 'openai');
  assert.equal(status.overview.modelCount, 3);
  assert.equal(status.overview.comboCount, 1);
  assert.equal(status.overview.rebootSafe, false);
  assert.equal(status.overview.requests30d, 12);
  assert.equal(status.overview.subagentCount, 1);
  assert.equal(status.sections.providers.state, 'ready');
  assert.deepEqual(status.sections.models.byProvider, [{ provider: 'unknown', count: 3 }]);
  assert.equal(status.sections.usage.requests, 12);
  assert.equal(status.topology.mode, 'upstream-only');
  assert.equal(status.topology.state, 'ready');
  assert.equal(status.directRescue.ready, true);
  assert.equal(status.directRescue.identityBinding, 'explicit-alias-required');
  assert.equal(status.failurePolicy.ocxAccountAutoSwitch, true);
  assert.equal(status.failurePolicy.ocxAccountAutoSwitchThresholdPercent, 98);
  assert.equal(status.overview.normalizedStartupStatus, 'ready');
  assert.equal(status.sections.runtime.topology, 'upstream-only');
  assert.equal(status.sections.storage.governance.defaultCleanupEnabled, false);
  assert.equal(status.sections.storage.governance.buckets.find(bucket => bucket.key === 'auth_account_state').cleanupEligible, false);
});

test('OCX adapter reports injected routing as a topology conflict instead of ready upstream ownership', async () => {
  const payloads = new Map([
    ['--version', 'opencodex 2.10.0\n'],
    ['health --json', JSON.stringify({ ok: true, pid: 42, port: 10100 })],
    ['ready --json', JSON.stringify({ ready: true, status: 'ready', pid: 42, port: 10100 })],
    ['system status --json', JSON.stringify({ startup: { serviceRunning: true, routingInjected: true }, memory: { activeTurnCount: 0 } })],
    ['access endpoints --json', JSON.stringify({ baseUrl: 'http://127.0.0.1:10100/v1' })]
  ]);
  const status = await ocxStatus({
    executable: 'ocx-fixture',
    runCommand: async (_executable, args) => ({ ok: true, stdout: payloads.get(args.join(' ')) ?? '{}' })
  });
  assert.equal(status.topology.mode, 'direct-owner');
  assert.equal(status.topology.state, 'attention');
  assert.equal(status.topology.routeOwner, 'ocx');
  assert.equal(status.failurePolicy.mayRestartWebGpt, false);
  assert.equal(status.failurePolicy.mayRestartNativeCodex, false);
});

test('OCX storage governance requires an exact archived-only digest and explicit quarantine approval', () => {
  const governance = projectOcxStorageGovernance({
    total: { bytes: 30, fileCount: 2 },
    buckets: [{ key: 'archived_sessions', bytes: 30, fileCount: 2 }, { key: 'other', bytes: 0, fileCount: 0 }]
  });
  assert.equal(governance.defaultCleanupEnabled, false);
  assert.equal(governance.buckets.find(bucket => bucket.key === 'other').cleanupEligible, false);
  const preview = {
    count: 2,
    bytes: 30,
    digest: 'a'.repeat(64),
    candidates: [
      { relPath: 'archived_sessions/one.jsonl', physicalRelPaths: ['archived_sessions/one.jsonl'], bytes: 10, mtimeMs: 100 },
      { relPath: 'archived_sessions/two.jsonl', physicalRelPaths: ['archived_sessions/two.jsonl'], bytes: 20, mtimeMs: 200 }
    ]
  };
  const hold = validateOcxCleanupDryRun(preview, { activeTurns: 3, mode: 'quarantine', backupVerified: true, integrityBefore: 'ok', approved: false });
  assert.equal(hold.status, 'HOLD');
  assert.deepEqual(hold.blockers.sort(), ['active_turns_nonzero', 'explicit_approval_required']);
  const pass = validateOcxCleanupDryRun(preview, { activeTurns: 0, mode: 'quarantine', backupVerified: true, integrityBefore: 'ok', approved: true });
  assert.equal(pass.status, 'PASS');
  assert.equal(pass.applyAllowed, true);
  assert.equal(pass.exactTargetCount, 2);
  assert.equal(pass.exactBytes, 30);
  assert.equal(pass.rollback.permanentDeleteAllowed, false);
});

test('OCX upstream lifecycle helpers preserve the Codex route fingerprint and never call sync or restore', () => {
  const startCalls = [];
  const started = startOcxAsUpstream({
    ocxExecutable: 'ocx-fixture',
    fingerprint: () => 'stable-route',
    run: (_executable, args) => {
      startCalls.push(args);
      return args[0] === 'health' ? JSON.stringify({ ok: true, port: 10100 }) : '';
    }
  });
  assert.equal(started.routeMutation, false);
  assert.deepEqual(startCalls, [['service', 'start'], ['health', '--json']]);

  const syncCalls = [];
  const synced = syncOcxUpstreamCatalog({
    ocxExecutable: 'ocx-fixture',
    fingerprint: () => 'stable-route',
    run: (_executable, args) => {
      syncCalls.push(args);
      if (args[0] === 'health') return JSON.stringify({ ok: true, port: 10100 });
      if (args[0] === 'provider') return JSON.stringify({ configured: [{ name: 'one' }] });
      return JSON.stringify({ models: [{ model: 'one' }, { model: 'two' }] });
    }
  });
  assert.equal(synced.routeMutation, false);
  assert.equal(synced.providerCount, 1);
  assert.equal(synced.modelCount, 2);
  assert.deepEqual(syncCalls, [['health', '--json'], ['provider', 'list', '--json'], ['models', 'list', '--json']]);
});

test('OCX upstream lifecycle invokes Windows command shims through ComSpec', () => {
  const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const startCalls = [];
  const started = startOcxAsUpstream({
    platform: 'win32',
    env,
    ocxExecutable: 'ocx',
    spawnSync: (executable, args) => {
      startCalls.push([executable, args]);
      return { status: 0, stdout: args.at(-1) === '--json' ? '{"ok":true,"port":10100}' : '' };
    },
    fingerprint: () => 'stable-route'
  });
  assert.equal(started.ok, true);
  assert.deepEqual(startCalls, [
    [env.ComSpec, ['/d', '/s', '/c', 'ocx', 'service', 'start']],
    [env.ComSpec, ['/d', '/s', '/c', 'ocx', 'health', '--json']]
  ]);

  const syncCalls = [];
  const synced = syncOcxUpstreamCatalog({
    platform: 'win32',
    env,
    ocxExecutable: 'ocx',
    spawnSync: (executable, args) => {
      syncCalls.push([executable, args]);
      const command = args.slice(4).join(' ');
      const stdout = command.startsWith('health')
        ? '{"ok":true,"port":10100}'
        : command.startsWith('provider')
          ? '{"configured":[{"name":"one"}]}'
          : '{"models":[{"model":"one"}]}';
      return { status: 0, stdout };
    },
    fingerprint: () => 'stable-route'
  });
  assert.equal(synced.ok, true);
  assert.deepEqual(syncCalls, [
    [env.ComSpec, ['/d', '/s', '/c', 'ocx', 'health', '--json']],
    [env.ComSpec, ['/d', '/s', '/c', 'ocx', 'provider', 'list', '--json']],
    [env.ComSpec, ['/d', '/s', '/c', 'ocx', 'models', 'list', '--json']]
  ]);
});

test('OCX upstream helpers fail closed if an owner command changes the Codex route file', () => {
  let fingerprintReads = 0;
  assert.throws(() => syncOcxUpstreamCatalog({
    ocxExecutable: 'ocx-fixture',
    fingerprint: () => ++fingerprintReads === 1 ? 'before' : 'after',
    run: (_executable, args) => args[0] === 'health'
      ? JSON.stringify({ ok: true, port: 10100 })
      : args[0] === 'provider'
        ? JSON.stringify({ configured: [] })
        : JSON.stringify({ models: [] })
  }), /codex_route_config_changed/);
});

test('OCX adapter verifies core health before running bounded detail probes', async () => {
  let corePending = 3;
  let detailActive = 0;
  let detailMaximum = 0;
  let detailStartedEarly = false;
  await ocxStatus({
    executable: 'ocx-fixture',
    readOnlyConcurrency: 2,
    runCommand: async (_executable, args) => {
      const key = args.join(' ');
      if (key === '--version' || key === 'health --json' || key === 'ready --json') {
        await new Promise(resolve => setTimeout(resolve, 5));
        corePending -= 1;
        return key === '--version'
          ? { ok: true, stdout: 'opencodex 2.10.0\n' }
          : key === 'health --json'
            ? { ok: true, stdout: JSON.stringify({ ok: true, port: 10100 }) }
            : { ok: true, stdout: JSON.stringify({ ready: true, status: 'ready', port: 10100 }) };
      }
      if (corePending > 0) detailStartedEarly = true;
      detailActive += 1;
      detailMaximum = Math.max(detailMaximum, detailActive);
      await new Promise(resolve => setTimeout(resolve, 5));
      detailActive -= 1;
      return { ok: true, stdout: '{}' };
    }
  });
  assert.equal(detailStartedEarly, false);
  assert.equal(detailMaximum, 2);
});

test('OCX adapter retries one timed-out core probe before reporting offline', async () => {
  const calls = new Map();
  const status = await ocxStatus({
    executable: 'ocx-fixture',
    coreAttempts: 2,
    coreRetryDelayMs: 0,
    runCommand: async (_executable, args) => {
      const key = args.join(' ');
      calls.set(key, (calls.get(key) ?? 0) + 1);
      if ((key === '--version' || key === 'health --json' || key === 'ready --json') && calls.get(key) === 1) return { ok: false, timedOut: true, stdout: '' };
      if (key === '--version') return { ok: true, stdout: 'opencodex 2.10.0\n' };
      if (key === 'health --json') return { ok: true, stdout: JSON.stringify({ ok: true, port: 10100 }) };
      if (key === 'ready --json') return { ok: true, stdout: JSON.stringify({ ready: true, status: 'ready', port: 10100 }) };
      return { ok: true, stdout: '{}' };
    }
  });
  assert.equal(status.state, 'ready');
  assert.equal(calls.get('--version'), 2);
  assert.equal(calls.get('health --json'), 2);
  assert.equal(calls.get('ready --json'), 2);
});

test('Codex route adapter separates native, Web GPT, and OCX recovery readiness', async () => {
  const files = new Map([
    ['/codex/config.toml', 'openai_base_url = "http://127.0.0.1:17841/v1"\n'],
    ['/codex/native.toml', 'openai_base_url = "https://chatgpt.com/backend-api/codex"\n']
  ]);
  const status = await codexRouteStatus({
    configPath: '/codex/config.toml',
    nativeConfigPath: '/codex/native.toml',
    readFile: file => files.get(file),
    webGptCli: 'web-gpt-fixture',
    runCommand: async () => ({ ok: true, stdout: JSON.stringify({ installed: true, active: true }) }),
    fetch: async url => ({
      ok: true,
      json: async () => String(url).includes('17841')
        ? {
            status: 'ok', mode: 'full', runtime_owner: 'service',
            accepting_turns: true, accepting_browser_turns: true,
            active_http_turns: 1, active_browser_http_turns: 2, active_browser_turns: 2
          }
        : { ok: true, port: 10100 }
    })
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.activeRoute, 'web-gpt');
  assert.equal(status.integrationActive, true);
  assert.equal(status.nativeReady, true);
  assert.equal(status.webGpt.activeHttpTurns, 1);
  assert.equal(status.webGpt.activeBrowserHttpTurns, 2);
  assert.equal(status.webGpt.activeBrowserTurns, 2);
  assert.equal(status.webGpt.activeTurns, 3);
  assert.equal(status.webGpt.activeWebTurns, 2);
  assert.equal(status.webGpt.routerOwner, 'service');
  assert.equal(status.ocx.healthy, true);
  assert.equal(status.recovery.requiresDesktopRestart, false);
  assert.equal(status.recovery.reloadBoundary, 'new-task-or-official-backend-reload');
});

test('Codex route adapter follows the OCX client data endpoint and flags a stale standalone Web GPT upstream', async () => {
  const files = new Map([
    ['/codex/config.toml', 'openai_base_url = "http://127.0.0.1:17841/v1"\n'],
    ['/codex/native.toml', 'openai_base_url = "https://chatgpt.com/backend-api/codex"\n'],
    ['/webgpt/config.json', JSON.stringify({
      runtimeOwner: 'service',
      nativeUpstreamBaseUrl: 'http://127.0.0.1:10100/v1'
    })],
    ['/ocx/config.json', JSON.stringify({
      runtimeRole: 'client',
      client: { serverUrl: 'http://localhost:10101' }
    })]
  ]);
  const seen = [];
  const status = await codexRouteStatus({
    configPath: '/codex/config.toml',
    nativeConfigPath: '/codex/native.toml',
    webGptConfigPath: '/webgpt/config.json',
    ocxConfigPath: '/ocx/config.json',
    readFile: file => files.get(file),
    webGptCli: 'web-gpt-fixture',
    runCommand: async () => ({ ok: true, stdout: JSON.stringify({ installed: true, active: true }) }),
    fetch: async url => {
      const value = String(url);
      seen.push(value);
      if (value.includes('17841')) {
        return { ok: true, json: async () => ({
          status: 'ok', mode: 'browser-only', runtime_owner: 'service',
          accepting_turns: true, accepting_browser_turns: true,
          active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0
        }) };
      }
      if (value.includes('10101')) {
        return { ok: true, json: async () => ({ status: 'ok', port: 10101 }) };
      }
      throw new Error(`unexpected URL: ${value}`);
    }
  });
  assert.equal(status.state, 'attention');
  assert.equal(status.webGpt.nativeUpstream.stale, true);
  assert.equal(status.webGpt.nativeUpstream.state, 'stale-standalone-ocx');
  assert.equal(status.ocx.mode, 'remote-client');
  assert.equal(status.ocx.endpoint, 'http://localhost:10101/v1');
  assert.equal(status.ocx.port, 10101);
  assert.equal(seen.some(url => url.includes('10101/healthz')), true);
  assert.equal(seen.some(url => url.includes('10100/healthz')), false);
});

test('Codex route adapter treats an unpinned Web GPT native upstream as official Native in OCX client mode', async () => {
  const files = new Map([
    ['/codex/config.toml', 'openai_base_url = "http://127.0.0.1:17841/v1"\n'],
    ['/codex/native.toml', 'openai_base_url = "https://chatgpt.com/backend-api/codex"\n'],
    ['/webgpt/config.json', JSON.stringify({ runtimeOwner: 'service' })],
    ['/ocx/config.json', JSON.stringify({
      runtimeRole: 'client',
      client: { serverUrl: 'http://localhost:10101' }
    })]
  ]);
  const status = await codexRouteStatus({
    configPath: '/codex/config.toml',
    nativeConfigPath: '/codex/native.toml',
    webGptConfigPath: '/webgpt/config.json',
    ocxConfigPath: '/ocx/config.json',
    readFile: file => files.get(file),
    webGptCli: 'web-gpt-fixture',
    runCommand: async () => ({ ok: true, stdout: JSON.stringify({ installed: true, active: true }) }),
    fetch: async url => ({
      ok: true,
      json: async () => String(url).includes('17841')
        ? {
            status: 'ok', mode: 'browser-only', runtime_owner: 'service',
            accepting_turns: true, accepting_browser_turns: true,
            active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0
          }
        : { status: 'ok', port: 10101 }
    })
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.webGpt.nativeUpstream.stale, false);
  assert.equal(status.webGpt.nativeUpstream.state, 'official-native');
  assert.equal(status.ocx.mode, 'remote-client');
  assert.equal(status.ocx.endpoint, 'http://localhost:10101/v1');
});

test('Codex route adapter retries transient loopback health failures', async () => {
  const files = new Map([
    ['/codex/config.toml', 'openai_base_url = "http://127.0.0.1:17841/v1"\n'],
    ['/codex/native.toml', 'openai_base_url = "https://chatgpt.com/backend-api/codex"\n']
  ]);
  const calls = new Map();
  const status = await codexRouteStatus({
    configPath: '/codex/config.toml', nativeConfigPath: '/codex/native.toml', readFile: file => files.get(file),
    webGptCli: 'web-gpt-fixture', healthRetryDelayMs: 0,
    runCommand: async () => ({ ok: true, stdout: JSON.stringify({ installed: true, active: true }) }),
    fetch: async url => {
      const key = String(url);
      calls.set(key, (calls.get(key) ?? 0) + 1);
      if (calls.get(key) === 1) throw new Error('cold start');
      return { ok: true, json: async () => key.includes('17841') ? { status: 'ok', accepting_turns: true } : { status: 'ok', port: 10100 } };
    }
  });
  assert.equal(status.webGpt.healthy, true);
  assert.equal(status.ocx.healthy, true);
  assert.equal([...calls.values()].every(count => count === 2), true);
});

test('OCX failure leaves Integrated Web GPT and Native recovery observable', async () => {
  const files = new Map([
    ['/codex/config.toml', 'openai_base_url = "http://127.0.0.1:17841/v1"\n'],
    ['/codex/native.toml', 'openai_base_url = "https://chatgpt.com/backend-api/codex"\n']
  ]);
  const status = await codexRouteStatus({
    configPath: '/codex/config.toml',
    nativeConfigPath: '/codex/native.toml',
    readFile: file => files.get(file),
    runCommand: async () => ({ ok: true, stdout: JSON.stringify({ installed: true, active: true }) }),
    fetch: async url => {
      if (String(url).includes('10100')) throw new Error('isolated OCX unavailable');
      return { ok: true, json: async () => ({ status: 'ok', accepting_turns: true, accepting_browser_turns: true, active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0 }) };
    },
    healthAttempts: 1
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.webGpt.healthy, true);
  assert.equal(status.nativeReady, true);
  assert.equal(status.ocx.healthy, false);
});

test('17841 failure leaves OCX direct and Native recovery observable', async () => {
  const files = new Map([
    ['/codex/config.toml', 'openai_base_url = "http://127.0.0.1:17841/v1"\n'],
    ['/codex/native.toml', 'openai_base_url = "https://chatgpt.com/backend-api/codex"\n']
  ]);
  const status = await codexRouteStatus({
    configPath: '/codex/config.toml',
    nativeConfigPath: '/codex/native.toml',
    readFile: file => files.get(file),
    runCommand: async () => ({ ok: false, stdout: '' }),
    fetch: async url => {
      if (String(url).includes('17841')) throw new Error('isolated router unavailable');
      return { ok: true, json: async () => ({ ok: true, port: 10100 }) };
    },
    healthAttempts: 1
  });
  assert.equal(status.nativeReady, true);
  assert.equal(status.webGpt.healthy, false);
  assert.equal(status.ocx.healthy, true);
});

test('Web GPT adapter distinguishes a healthy bridge from an inactive Codex route', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-web-gpt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const codexConfigPath = path.join(root, 'codex.toml');
  const launcherStatePath = path.join(root, 'launcher-state.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port: 17841, releaseVersion: '2.0.0', mode: 'full', browserHost: 'launcher', tunnel: { configured: true }
  }));
  fs.writeFileSync(codexConfigPath, 'openai_base_url = "http://127.0.0.1:10100/v1"\n');
  fs.writeFileSync(launcherStatePath, JSON.stringify({ mcpSetupComplete: true }));
  const status = await webGptStatus({
    configPath, codexConfigPath, launcherStatePath, appPath: path.join(root, 'missing.app'),
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ok', version: '2.0.0', mode: 'full', active_browser_turns: 0 }) }),
    tunnelStatus: async () => ({ running: true, healthy: true, ready: true, state: 'ready' })
  });
  assert.equal(status.healthy, true);
  assert.equal(status.routeConfigured, false);
  assert.equal(status.state, 'attention');
  assert.equal(status.modelCount, 8);
  assert.ok(status.modelLabels.includes('Web / 임시 / 매우 높음'));
  assert.equal(status.modelLabels.some(label => label.endsWith('/ Pro')), false);
  assert.equal(status.localHarnessConsumesModelTokens, false);
  assert.equal(status.harnessReady, true);
  assert.equal(status.tunnelRuntime.ready, true);
  assert.equal(status.connectorSelectable, true);
  assert.equal(status.connectorVerified, false);
  assert.equal(status.connectorVerification, 'tool-canary-required');
});

test('Web GPT adapter retries one transient bridge health failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-web-gpt-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const codexConfigPath = path.join(root, 'codex.toml');
  fs.writeFileSync(configPath, JSON.stringify({ port: 17841, mode: 'browser-only' }));
  fs.writeFileSync(codexConfigPath, 'openai_base_url = "http://127.0.0.1:17841/v1"\n');
  let calls = 0;
  const status = await webGptStatus({
    configPath, codexConfigPath, appPath: path.join(root, 'missing.app'), healthRetryDelayMs: 0,
    readinessProbe: async () => null,
    fetch: async () => {
      calls += 1;
      if (calls === 1) throw new Error('cold start');
      return { ok: true, json: async () => ({ status: 'ok', mode: 'browser-only' }) };
    }
  });
  assert.equal(status.healthy, true);
  assert.equal(calls, 2);
});

test('Web GPT adapter does not claim local harness tools in browser-only mode', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-web-gpt-browser-only-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const codexConfigPath = path.join(root, 'codex.toml');
  fs.writeFileSync(configPath, JSON.stringify({ port: 17841, releaseVersion: '2.0.0', mode: 'browser-only' }));
  fs.writeFileSync(codexConfigPath, 'openai_base_url = "http://127.0.0.1:17841/v1"\n');
  const status = await webGptStatus({
    configPath, codexConfigPath, launcherStatePath: path.join(root, 'missing-launcher-state.json'), appPath: path.join(root, 'missing.app'),
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ok', version: '2.0.0' }) })
  });
  assert.equal(status.state, 'ready');
  assert.match(status.detail, /로컬 도구는 전체 하네스 MCP/);
  assert.doesNotMatch(status.detail, /도구 하네스가 연결/);
  assert.equal(status.harnessConfigured, false);
  assert.equal(status.harnessReady, false);
});

test('Web GPT adapter reports attention when full harness tunnel is not ready', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-web-gpt-full-degraded-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const codexConfigPath = path.join(root, 'codex.toml');
  fs.writeFileSync(configPath, JSON.stringify({
    port: 17841, releaseVersion: '2.0.0', mode: 'full', tunnel: { configured: true }, appName: 'Web GPT 작업 하네스'
  }));
  fs.writeFileSync(codexConfigPath, 'openai_base_url = "http://127.0.0.1:17841/v1"\n');
  const status = await webGptStatus({
    configPath, codexConfigPath, launcherStatePath: path.join(root, 'missing-launcher-state.json'), appPath: path.join(root, 'missing.app'),
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ok', version: '2.0.0', mode: 'full' }) }),
    tunnelStatus: async () => ({ running: true, healthy: false, ready: false, state: 'starting' })
  });
  assert.equal(status.state, 'attention');
  assert.equal(status.harnessConfigured, true);
  assert.equal(status.harnessReady, false);
  assert.match(status.detail, /아직 준비되지/);
});

test('Web GPT adapter separates liveness from the current dependency readiness vector', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-web-gpt-readiness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const codexConfigPath = path.join(root, 'codex.toml');
  fs.writeFileSync(configPath, JSON.stringify({ port: 17841, releaseVersion: '2.0.0-aicc.24', mode: 'full', tunnel: { configured: true } }));
  fs.writeFileSync(codexConfigPath, 'openai_base_url = "http://127.0.0.1:17841/v1"\n');
  const status = await webGptStatus({
    configPath, codexConfigPath, appPath: path.join(root, 'missing.app'),
    fetch: async url => String(url).endsWith('/readyz')
      ? {
          ok: false, status: 503, json: async () => ({
            status: 'attention', ready: false,
            dependencies: {
              listener: { ready: true }, broker: { ready: true, state: 'ready' },
              browser: { ready: false, state: 'draining' }, native_upstream: { ready: null, state: 'request_time_verification' }
            }
          })
        }
      : { ok: true, status: 200, json: async () => ({ status: 'ok', version: '2.0.0-aicc.24', mode: 'full' }) },
    tunnelStatus: async () => ({ running: true, healthy: true, ready: true, state: 'ready' })
  });
  assert.equal(status.healthy, true);
  assert.equal(status.readinessSupported, true);
  assert.equal(status.dependencyReady, false);
  assert.equal(status.readiness.httpStatus, 503);
  assert.deepEqual(status.readiness.dependencies.browser, { ready: false, state: 'draining' });
});

test('Web GPT adapter reads the launcher-owned tunnel health endpoint without spawning the CLI', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-web-gpt-tunnel-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const codexConfigPath = path.join(root, 'codex.toml');
  const launcherStatePath = path.join(root, 'launcher-state.json');
  const tunnelHealthUrlFile = path.join(root, 'tunnel-health.url');
  const harnessVerificationPath = path.join(root, 'harness-verification.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port: 17841, releaseVersion: '2.0.0', mode: 'full', appName: 'Web GPT 작업 하네스',
    tunnel: { alias: 'codex-chatgpt-web' }
  }));
  fs.writeFileSync(codexConfigPath, 'openai_base_url = "http://127.0.0.1:17841/v1"\n');
  fs.writeFileSync(launcherStatePath, JSON.stringify({ mcpSetupComplete: true }));
  fs.writeFileSync(tunnelHealthUrlFile, 'http://127.0.0.1:54321\n');
  fs.writeFileSync(harnessVerificationPath, JSON.stringify({
    schemaVersion: 1,
    kind: 'web-gpt-harness-canary',
    observedAt: '2026-08-10T14:00:00Z',
    status: 'pass',
    appName: 'Web GPT 작업 하네스',
    releaseVersion: '2.0.0',
    toolCount: 19,
    toolNames: ['codex_bind_turn', 'codex_orchestrator_status'],
    wrapperStatus: 'pass'
  }));
  const status = await webGptStatus({
    configPath, codexConfigPath, launcherStatePath, tunnelHealthUrlFile, harnessVerificationPath,
    appPath: path.join(root, 'missing.app'),
    fetch: async url => String(url).includes(':17841')
      ? { ok: true, json: async () => ({ status: 'ok', version: '2.0.0', mode: 'full' }) }
      : { ok: true, text: async () => 'live' }
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.harnessReady, true);
  assert.equal(status.connectorSelectable, true);
  assert.equal(status.connectorVerified, true);
  assert.equal(status.connectorVerification, 'verified');
  assert.deepEqual(status.tunnelRuntime, {
    running: true, healthy: true, ready: true, state: 'ready'
  });
});

test('Web GPT adapter surfaces same-version six-mode verification attention', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-web-gpt-verification-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const codexConfigPath = path.join(root, 'codex.toml');
  const launcherStatePath = path.join(root, 'launcher-state.json');
  const verificationPath = path.join(root, 'verification.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port: 17841, releaseVersion: '2.0.0-aicc.2', mode: 'full', tunnel: { configured: true }
  }));
  fs.writeFileSync(codexConfigPath, 'openai_base_url = "http://127.0.0.1:17841/v1"\n');
  fs.writeFileSync(launcherStatePath, JSON.stringify({ mcpSetupComplete: true }));
  fs.writeFileSync(verificationPath, JSON.stringify({
    schemaVersion: 2, strategyVersion: 2, kind: 'web-gpt-six-mode-smoke', observedAt: '2026-08-07T11:58:42Z',
    releaseVersion: '2.0.0-aicc.2', status: 'attention', total: 6, completed: 5,
    overallPass: 3, filePass: 3, browserPass: 3, failed: 2, stalled: 1
  }));
  const status = await webGptStatus({
    configPath, codexConfigPath, launcherStatePath, verificationPath,
    appPath: path.join(root, 'missing.app'),
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ok', version: '2.0.0-aicc.2', mode: 'full' }) }),
    tunnelStatus: async () => ({ running: true, healthy: true, ready: true, state: 'ready' })
  });
  assert.equal(status.state, 'attention');
  assert.equal(status.latestVerification.schemaVersion, 2);
  assert.equal(status.latestVerification.strategyVersion, 2);
  assert.equal(status.latestVerification.overallPass, 3);
  assert.match(status.detail, /3\/6개만 완전 성공/);
});

test('Web GPT adapter accepts a same-release six-mode 6/6 verification', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-web-gpt-verification-pass-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const codexConfigPath = path.join(root, 'codex.toml');
  const launcherStatePath = path.join(root, 'launcher-state.json');
  const verificationPath = path.join(root, 'verification.json');
  const harnessVerificationPath = path.join(root, 'harness-verification.json');
  const runtimeManifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port: 17841, releaseVersion: '2.0.0-aicc.4', mode: 'full', tunnel: { configured: true }
  }));
  fs.writeFileSync(codexConfigPath, 'openai_base_url = "http://127.0.0.1:17841/v1"\n');
  fs.writeFileSync(launcherStatePath, JSON.stringify({ mcpSetupComplete: true }));
  fs.writeFileSync(verificationPath, JSON.stringify({
    schemaVersion: 2, strategyVersion: 3, kind: 'web-gpt-six-mode-smoke', observedAt: '2026-08-09T16:43:21Z',
    runtimeBundleId: 'a'.repeat(64),
    releaseVersion: '2.0.0-aicc.4', status: 'pass', total: 6, completed: 6,
    overallPass: 6, filePass: 6, browserPass: 6, failed: 0, stalled: 0
  }));
  fs.writeFileSync(harnessVerificationPath, JSON.stringify({
    schemaVersion: 1, kind: 'web-gpt-harness-canary', observedAt: '2026-08-09T16:43:21Z',
    status: 'pass', appName: 'Web GPT 작업 하네스', releaseVersion: '2.0.0-aicc.4',
    runtimeBundleId: 'a'.repeat(64), toolCount: 19,
    toolNames: ['codex_bind_turn', 'codex_orchestrator_status'], wrapperStatus: 'pass'
  }));
  fs.writeFileSync(runtimeManifestPath, JSON.stringify({ bundleId: 'a'.repeat(64) }));
  const status = await webGptStatus({
    configPath, codexConfigPath, launcherStatePath, verificationPath, harnessVerificationPath, runtimeManifestPath,
    appPath: path.join(root, 'missing.app'),
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ok', version: '2.0.0-aicc.4', mode: 'full' }) }),
    tunnelStatus: async () => ({ running: true, healthy: true, ready: true, state: 'ready' })
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.latestVerification.status, 'pass');
  assert.equal(status.latestVerification.overallPass, 6);
  assert.equal(status.latestVerification.browserPass, 6);
  assert.equal(status.runtimeBundleId, 'a'.repeat(64));
  assert.equal(status.verificationBundleMismatch, false);
  assert.equal(status.connectorVerification, 'verified');
});

test('Web GPT adapter does not claim six-mode proof for a rebuilt same-version bundle', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-web-gpt-bundle-mismatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const codexConfigPath = path.join(root, 'codex.toml');
  const launcherStatePath = path.join(root, 'launcher-state.json');
  const verificationPath = path.join(root, 'verification.json');
  const runtimeManifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port: 17841, releaseVersion: '2.0.0-aicc.4', mode: 'full', tunnel: { configured: true }
  }));
  fs.writeFileSync(codexConfigPath, 'openai_base_url = "http://127.0.0.1:17841/v1"\n');
  fs.writeFileSync(launcherStatePath, JSON.stringify({ mcpSetupComplete: true }));
  fs.writeFileSync(verificationPath, JSON.stringify({
    schemaVersion: 2, strategyVersion: 3, kind: 'web-gpt-six-mode-smoke', observedAt: '2026-08-09T16:43:21Z',
    releaseVersion: '2.0.0-aicc.4', runtimeBundleId: 'a'.repeat(64), status: 'pass', total: 6, completed: 6,
    overallPass: 6, filePass: 6, browserPass: 6, failed: 0, stalled: 0
  }));
  fs.writeFileSync(runtimeManifestPath, JSON.stringify({ bundleId: 'b'.repeat(64) }));
  const status = await webGptStatus({
    configPath, codexConfigPath, launcherStatePath, verificationPath, runtimeManifestPath,
    appPath: path.join(root, 'missing.app'),
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ok', version: '2.0.0-aicc.4', mode: 'full' }) }),
    tunnelStatus: async () => ({ running: true, healthy: true, ready: true, state: 'ready' })
  });
  assert.equal(status.state, 'attention');
  assert.equal(status.latestVerification, null);
  assert.equal(status.historicalVerification.overallPass, 6);
  assert.equal(status.verificationBundleMismatch, true);
  assert.match(status.detail, /현재 설치 bundle.*재검증/);
});

test('Web GPT adapter reads the manifest beside the exact configured runtime command', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-web-gpt-exact-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const codexConfigPath = path.join(root, 'codex.toml');
  const releaseRoot = path.join(root, 'versions', '2.0.0-aicc.24-custom-bundle-darwin-arm64');
  const executable = path.join(releaseRoot, 'bin', 'codex-chatgpt-web');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '#!/bin/sh\n');
  fs.writeFileSync(path.join(releaseRoot, 'manifest.json'), JSON.stringify({ bundleId: 'c'.repeat(64) }));
  fs.writeFileSync(configPath, JSON.stringify({
    port: 17841,
    releaseVersion: '2.0.0-aicc.24',
    runtimeCommand: [executable],
    mode: 'browser-only'
  }));
  fs.writeFileSync(codexConfigPath, 'openai_base_url = "http://127.0.0.1:17841/v1"\n');
  const status = await webGptStatus({
    stateRoot: root,
    configPath,
    codexConfigPath,
    appPath: path.join(root, 'missing.app'),
    readinessProbe: async () => null,
    fetch: async () => ({
      ok: true,
      json: async () => ({ status: 'ok', version: '2.0.0-aicc.24', mode: 'browser-only' })
    })
  });
  assert.equal(status.runtimeBundleId, 'c'.repeat(64));
});

test('Web GPT adapter does not present an older release verification as current', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-web-gpt-stale-verification-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const codexConfigPath = path.join(root, 'codex.toml');
  const launcherStatePath = path.join(root, 'launcher-state.json');
  const verificationPath = path.join(root, 'verification.json');
  fs.writeFileSync(configPath, JSON.stringify({
    port: 17841, releaseVersion: '2.0.0-aicc.4', mode: 'full', tunnel: { configured: true }
  }));
  fs.writeFileSync(codexConfigPath, 'openai_base_url = "http://127.0.0.1:17841/v1"\n');
  fs.writeFileSync(launcherStatePath, JSON.stringify({ mcpSetupComplete: true }));
  fs.writeFileSync(verificationPath, JSON.stringify({
    schemaVersion: 2, strategyVersion: 2, kind: 'web-gpt-six-mode-smoke', observedAt: '2026-08-09T09:03:54Z',
    releaseVersion: '2.0.0-aicc.3', status: 'attention', total: 6, completed: 5,
    overallPass: 2, filePass: 2, browserPass: 5, failed: 4, stalled: 0
  }));
  const status = await webGptStatus({
    configPath, codexConfigPath, launcherStatePath, verificationPath,
    appPath: path.join(root, 'missing.app'),
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ok', version: '2.0.0-aicc.4', mode: 'full' }) }),
    tunnelStatus: async () => ({ running: true, healthy: true, ready: true, state: 'ready' })
  });
  assert.equal(status.state, 'attention');
  assert.equal(status.latestVerification, null);
  assert.equal(status.connectorVerification, 'tool-canary-required');
});

test('OCX account adapter exposes only safe account metadata', async () => {
  const status = await ocxAccountStatus({
    executable: 'ocx-fixture',
    refresh: true,
    runCommand: async () => ({
      ok: true,
      stdout: JSON.stringify({ accounts: [{
        id: 'pool-one', label: 'Plus', email: 'f***t@example.test', plan: 'plus',
        active: true, needsReauth: false, accessToken: 'must-not-leak',
        quota: { weeklyPercent: 23, weeklyResetAt: 1_787_196_737 }
      }] })
    })
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.activeId, 'pool-one');
  assert.equal(status.quotaSource, 'live-refresh');
  assert.equal(status.quotaKnownCount, 1);
  assert.equal(status.accounts[0].quota.weeklyRemainingPercent, 77);
  assert.equal('accessToken' in status.accounts[0], false);
});

test('OCX account adapter falls back to cached masked rows when live quota refresh fails', async () => {
  const calls = [];
  const status = await ocxAccountStatus({
    executable: 'ocx-fixture',
    refresh: true,
    runCommand: async (_executable, args) => {
      calls.push(args.join(' '));
      if (args[1] === 'refresh') return { ok: false, error: 'refresh unavailable' };
      return { ok: true, stdout: JSON.stringify({ accounts: [{ id: 'pool-two', label: 'Team', active: false }] }) };
    }
  });
  assert.deepEqual(calls, ['account refresh openai --json', 'account list openai --quota --json']);
  assert.equal(status.state, 'degraded');
  assert.equal(status.quotaSource, 'cached-list');
  assert.equal(status.quotaKnownCount, 0);
});

test('OCX missing or invalid long quota never means zero or ready', async () => {
  for (const quota of [null, {}, { shortPercent: 0 }, { weeklyPercent: -1 }, { weeklyPercent: false }, { weeklyPercent: 101 }]) {
    const status = await ocxAccountStatus({ runCommand: async (_exe, args) => {
      assert.deepEqual(args, ['account', 'list', 'openai', '--quota', '--json']);
      return { ok: true, stdout: JSON.stringify({ accounts: [{ id: 'fixture', quota }] }) };
    } });
    assert.equal(status.state, 'degraded');
    assert.equal(status.quotaKnownCount, 0);
    assert.equal(status.quotaFreshness, 'unreported');
  }
  const zero = await ocxAccountStatus({ runCommand: async () => ({ ok: true, stdout: JSON.stringify({ accounts: [{ id: 'fixture', quota: { weeklyPercent: 0 } }] }) }) });
  assert.equal(zero.quotaKnownCount, 1);
  assert.equal(zero.accounts[0].quota.weeklyRemainingPercent, 100);
});

test('auth portal adapter reads only the configured public URL', async () => {
  const status = await authPortalStatus({
    configPath: '/fixture/auth-portal.env',
    readFile: () => 'CM_AUTH_PORTAL_URL="https://login.example.test/path"\nCM_AUTH_MACHINE_TOKEN=secret\n'
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.url, 'https://login.example.test/path');
  assert.equal(JSON.stringify(status).includes('secret'), false);
});

test('local tool defaults resolve only maintained embedded project locations', async () => {
  const tools = await localToolStatus();
  const manager = tools.find(item => item.id === 'account-manager');
  assert.equal(manager.path, path.resolve('components/account-manager'));
  assert.equal(manager.exists, true);
  assert.deepEqual(tools.map(item => item.id).sort(), ['account-manager', 'gpt-desktop']);
});
