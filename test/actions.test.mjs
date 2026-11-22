import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ActionError, createActionController } from '../src/actions.mjs';

function temporaryState(t) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-actions-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  return stateRoot;
}

function commandResult(overrides = {}) {
  return {
    ok: true,
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 3,
    ...overrides
  };
}

function ocxRuntimeState(healthy, overrides = {}) {
  return {
    installed: true,
    healthy,
    version: '2.10.0',
    runtime: healthy ? { port: 10100 } : null,
    topology: { mode: healthy ? 'upstream-only' : 'unknown' },
    sections: { runtime: { routingInjected: healthy ? false : null, activeTurns: healthy ? 0 : null } },
    ...overrides
  };
}

test('allowlist exposes only named actions', () => {
  const controller = createActionController({
    platform: 'darwin',
    arch: 'arm64',
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({})
  });
  assert.deepEqual(controller.list().map(item => item.name), [
    'workspace.canonical-root-reconcile',
    'aicc.restore.latest',
    'codex.web-gpt.cancel-turns',
    'codex.web-gpt.recover',
    'codex.native.recover',
    'codex.bridge.reconnect',
    'codex-cli.update',
    'ocx.start',
    'ocx.sync',
    'ocx.stop',
    'account.switch',
    'ocx.account.use',
    'ocx.account.import-cm',
    'openai.provider.set',
    'openai.model.set',
    'openai.default-model.set',
    'openai.model.probe',
    'openai.catalog.probe-all',
    'openai.catalog.check',
    'openai.agent-guard.apply',
    'design-sources.apply',
    'project-service.start',
    'project-service.stop'
  ]);
});

test('Workspace root maintenance uses the exact plan and one-use writer transaction', async t => {
  for (const transitionMode of ['cold-bootstrap', 'live-scoped']) {
    await t.test(transitionMode, async t => {
      const stateRoot = temporaryState(t);
      const args = { planFile: path.join(stateRoot, 'plan.json'), planSha256: 'a'.repeat(64), rescueReadyRef: path.join(stateRoot, 'ready.json') };
      let applied = false;
      let statusReads = 0;
      const calls = [];
      const controller = createActionController({
        stateRoot, platform: 'win32',
        runCommand: async (executable, commandArgs, options) => {
          const mode = commandArgs[commandArgs.indexOf('-Mode') + 1];
          calls.push(mode);
          assert.equal(commandArgs[commandArgs.indexOf('-PlanFile') + 1], args.planFile);
          assert.equal(commandArgs[commandArgs.indexOf('-ExpectedPlanSha256') + 1], args.planSha256);
          assert.equal(commandArgs[commandArgs.indexOf('-RescueReadyFile') + 1], args.rescueReadyRef);
          assert.equal(options.env.AICC_STATE_ROOT, stateRoot);
          if (mode === 'Apply') {
            const lock = JSON.parse(fs.readFileSync(path.join(stateRoot, 'action.lock'), 'utf8'));
            assert.equal(lock.action, 'workspace.canonical-root-reconcile');
            assert.equal(lock.pid, process.pid);
            assert.ok(commandArgs.includes('-RequireActionLock'));
            applied = true;
            return commandResult({ stdout: '{"ok":true}' });
          }
          statusReads++;
          // Separate PowerShell processes can return the same hashes in a different key order.
          const fileEntries = [['config', applied ? 'after' : 'before'], ['profile', 'p'], ['registry', 'r'], ['task-receipt', 't']];
          if (statusReads % 2 === 0) fileEntries.reverse();
          return commandResult({ stdout: JSON.stringify({
            operationId: 'fixture-root', planSha256: args.planSha256, scopeHash: 'b'.repeat(64), transitionMode,
            coldHandoffSha256: transitionMode === 'cold-bootstrap' ? 'c'.repeat(64) : null,
            coldStateSha256: transitionMode === 'cold-bootstrap' ? 'd'.repeat(64) : null,
            rescueReadySha256: 'e'.repeat(64), fileHashes: Object.fromEntries(fileEntries),
            allBefore: !applied, allAfter: applied, terminal: applied ? 'APPLIED_RUNTIME_ADMITTED' : 'NOT_DISPATCHED', ready: !applied
          }) });
        }
      });
      const preview = await controller.preview('workspace.canonical-root-reconcile', args);
      const result = await controller.execute(preview.confirmationToken);
      assert.equal(result.ok, true);
      assert.equal(result.after.terminal, 'APPLIED_RUNTIME_ADMITTED');
      assert.deepEqual(calls, ['Status', 'Status', 'Apply', 'Status']);
      assert.equal(fs.existsSync(path.join(stateRoot, 'action.lock')), false);
      await assert.rejects(controller.execute(preview.confirmationToken), error => error.code === 'confirmation_not_found');
    });
  }
});

test('Workspace cold handoff drift or missing readiness prevents dispatch', async t => {
  const stateRoot = temporaryState(t);
  const args = { planFile: path.join(stateRoot, 'plan.json'), planSha256: 'a'.repeat(64), rescueReadyRef: path.join(stateRoot, 'ready.json') };
  let ready = true;
  let handoffHash = 'c'.repeat(64);
  let dispatched = 0;
  const controller = createActionController({
    stateRoot, platform: 'win32',
    runCommand: async (_executable, commandArgs) => {
      if (commandArgs.includes('Apply')) dispatched++;
      return commandResult({ stdout: JSON.stringify({
        operationId: 'fixture-root', planSha256: args.planSha256, scopeHash: 'b'.repeat(64),
        transitionMode: 'cold-bootstrap', coldHandoffSha256: handoffHash, coldStateSha256: 'd'.repeat(64),
        rescueReadySha256: 'e'.repeat(64), fileHashes: { config: 'before' },
        allBefore: true, allAfter: false, terminal: 'NOT_DISPATCHED', ready
      }) });
    }
  });
  const preview = await controller.preview('workspace.canonical-root-reconcile', args);
  handoffHash = 'f'.repeat(64);
  await assert.rejects(controller.execute(preview.confirmationToken), error => error.code === 'stale_preview');
  ready = false;
  await assert.rejects(controller.preview('workspace.canonical-root-reconcile', args), error => error.code === 'workspace_root_hold');
  await assert.rejects(controller.preview('workspace.canonical-root-reconcile', { ...args, arbitrary: true }), error => error.code === 'workspace_root_selection');
  assert.equal(dispatched, 0);
});

test('Codex CLI update requires exact idle and verifies the official standalone target', async t => {
  const stateRoot = temporaryState(t);
  let updated = false;
  const calls = [];
  const getCodexCliUpdateStatus = async () => ({
    ok: true,
    managedStandalone: true,
    installMethod: 'official-standalone',
    currentVersion: updated ? '0.147.0' : '0.146.0',
    latestVersion: '0.147.0',
    updateAvailable: !updated,
    currentLink: '/safe/.codex/packages/standalone/current',
    releaseTarget: '/safe/.codex/packages/standalone/releases/0.146.0-arm64',
    work: { safe: true, activeCount: 0, unknownCount: 0 },
    daemon: { status: 'running', appServerVersion: '0.146.0' },
    updater: { active: false, pid: null, state: 'stale-record' }
  });
  const controller = createActionController({
    stateRoot,
    appCodexHome: '/safe/.codex',
    codexExecutable: '/safe/.local/bin/codex',
    codexCliUpdateCommand: '/safe/codex-cli-update-command.mjs',
    getCodexCliUpdateStatus,
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({}),
    runCommand: async (executable, args) => {
      calls.push([executable, args]);
      updated = true;
      return commandResult({ stdout: '{"ok":true}' });
    }
  });
  const preview = await controller.preview('codex-cli.update');
  assert.equal(preview.args.expectedVersion, '0.147.0');
  const result = await controller.execute(preview.confirmationToken);
  assert.equal(result.ok, true);
  assert.equal(result.after.currentVersion, '0.147.0');
  assert.ok(calls[0][1].includes('--previous-release'));
});

test('Codex CLI update refuses active or unknown Codex work before mutation', async t => {
  const controller = createActionController({
    stateRoot: temporaryState(t),
    getCodexCliUpdateStatus: async () => ({
      ok: true, managedStandalone: true, currentVersion: '0.146.0', latestVersion: '0.147.0',
      work: { safe: false, activeCount: 1, unknownCount: 0 }, updater: { active: false }
    }),
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({})
  });
  await assert.rejects(controller.preview('codex-cli.update'), error => error.code === 'codex_work_not_idle');
});

test('project services use the guarded preview and inverse rollback command', async t => {
  const stateRoot = temporaryState(t);
  let running = false;
  const calls = [];
  const getProjectServicesStatus = async () => ({
    projects: [{
      id: 'demo', state: running ? 'running' : 'stopped', activeConnections: 0, onDemandReady: true,
      units: [{ label: 'com.example.demo', loaded: true, running, onDemandReady: true }]
    }]
  });
  const controller = createActionController({
    stateRoot,
    projectServiceCommand: 'project-service-fixture',
    getProjectServicesStatus,
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({}),
    runCommand: async (executable, args) => {
      calls.push([executable, args]);
      running = args[1] === 'start';
      return commandResult();
    }
  });
  const start = await controller.preview('project-service.start', { id: 'demo' });
  assert.equal((await controller.execute(start.confirmationToken)).ok, true);
  const stop = await controller.preview('project-service.stop', { id: 'demo' });
  assert.equal((await controller.execute(stop.confirmationToken)).ok, true);
  assert.deepEqual(calls, [
    [process.execPath, ['project-service-fixture', 'start', 'demo']],
    [process.execPath, ['project-service-fixture', 'stop', 'demo']]
  ]);
});

test('Native recovery is blocked while a Web GPT turn is active', async t => {
  const controller = createActionController({
    stateRoot: temporaryState(t),
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({}),
    getCodexRouteStatus: async () => ({
      activeRoute: 'web-gpt', nativeReady: true,
      webGpt: { healthy: true, acceptingTurns: true, activeTurns: 1 }, ocx: { healthy: true }
    })
  });
  await assert.rejects(controller.preview('codex.native.recover'), error => error.code === 'active_turns');
});

test('Web GPT emergency cancellation clears retained browser turns through the bridge owner', async t => {
  const stateRoot = temporaryState(t);
  let activeHttpTurns = 1;
  let activeBrowserTurns = 2;
  const calls = [];
  const controller = createActionController({
    stateRoot,
    webGptExecutable: 'web-gpt-fixture',
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({}),
    getCodexRouteStatus: async () => ({
      activeRoute: 'web-gpt', nativeReady: true,
      webGpt: {
        healthy: true,
        acceptingTurns: true,
        activeHttpTurns,
        activeBrowserTurns,
        activeTurns: activeHttpTurns + activeBrowserTurns
      },
      ocx: { healthy: true }
    }),
    runCommand: async (executable, args) => {
      calls.push([executable, args]);
      activeBrowserTurns = 0;
      return commandResult({ stdout: JSON.stringify({ cancelledBrowserTurns: 2 }) });
    }
  });

  const preview = await controller.preview('codex.web-gpt.cancel-turns');
  const result = await controller.execute(preview.confirmationToken);

  assert.equal(result.ok, true);
  assert.equal(result.after.activeBrowserTurns, 0);
  assert.equal(result.after.activeHttpTurns, 1);
  assert.deepEqual(calls, [['web-gpt-fixture', ['service', 'cancel-turns']]]);
});

test('Web GPT runtime recovery uses the guarded component command only at exact zero', async t => {
  const stateRoot = temporaryState(t);
  let healthy = true;
  const calls = [];
  const controller = createActionController({
    stateRoot,
    webGptRecoveryCommand: 'recovery-fixture',
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({}),
    getCodexRouteStatus: async () => ({
      activeRoute: 'web-gpt',
      nativeReady: true,
      webGpt: {
        healthy,
        acceptingTurns: healthy,
        routerOwner: 'service',
        activeHttpTurns: 0,
        activeBrowserHttpTurns: 0,
        activeBrowserTurns: 0,
        activeTurns: 0
      },
      ocx: { healthy: true }
    }),
    runCommand: async (executable, args) => {
      calls.push([executable, args]);
      healthy = true;
      return commandResult({ stdout: JSON.stringify({ ok: true, restarted: true }) });
    }
  });

  const preview = await controller.preview('codex.web-gpt.recover');
  const result = await controller.execute(preview.confirmationToken);

  assert.equal(result.ok, true);
  assert.equal(result.after.bridgeHealthy, true);
  assert.deepEqual(calls, [[process.execPath, ['recovery-fixture']]]);
});

test('Web GPT runtime recovery refuses offline UNKNOWN without dispatch', async t => {
  const calls = [];
  const controller = createActionController({
    stateRoot: temporaryState(t),
    webGptRecoveryCommand: 'recovery-fixture',
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({}),
    getCodexRouteStatus: async () => ({
      activeRoute: 'web-gpt', nativeReady: true,
      webGpt: {
        healthy: false, acceptingTurns: false,
        activeHttpTurns: null, activeBrowserHttpTurns: null, activeBrowserTurns: null, activeTurns: null
      },
      ocx: { healthy: true }
    }),
    runCommand: async (...args) => { calls.push(args); return commandResult(); }
  });
  await assert.rejects(
    controller.preview('codex.web-gpt.recover'),
    error => error.code === 'turn_state_unknown'
  );
  assert.deepEqual(calls, []);
});

test('Web GPT runtime recovery refuses to restart while active work is observable', async t => {
  const controller = createActionController({
    stateRoot: temporaryState(t),
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({}),
    getCodexRouteStatus: async () => ({
      activeRoute: 'web-gpt',
      nativeReady: true,
      webGpt: {
        healthy: true,
        acceptingTurns: true,
        activeHttpTurns: 1,
        activeBrowserHttpTurns: 0,
        activeBrowserTurns: 0,
        activeTurns: 1
      },
      ocx: { healthy: true }
    })
  });

  await assert.rejects(
    controller.preview('codex.web-gpt.recover'),
    error => error.code === 'active_turns'
  );
});

test('Native recovery and bridge reconnect use guarded route owners', async t => {
  const stateRoot = temporaryState(t);
  let activeRoute = 'web-gpt';
  const calls = [];
  const controller = createActionController({
    stateRoot,
    codexNativeRecoveryCommand: 'native-recovery-fixture',
    webGptExecutable: 'web-gpt-fixture',
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({}),
    getCodexRouteStatus: async () => ({
      activeRoute, routeUrl: activeRoute === 'web-gpt' ? 'http://127.0.0.1:17841/v1' : 'https://chatgpt.com/backend-api/codex',
      nativeReady: true, webGpt: { healthy: true, acceptingTurns: true, activeTurns: 0 }, ocx: { healthy: true }
    }),
    runCommand: async (executable, args) => {
      calls.push([executable, args]);
      activeRoute = executable === process.execPath && args[0] === 'native-recovery-fixture' ? 'native' : 'web-gpt';
      return commandResult();
    }
  });
  const nativePreview = await controller.preview('codex.native.recover');
  assert.equal((await controller.execute(nativePreview.confirmationToken)).ok, true);
  const bridgePreview = await controller.preview('codex.bridge.reconnect');
  assert.equal((await controller.execute(bridgePreview.confirmationToken)).ok, true);
  assert.deepEqual(calls, [
    [process.execPath, ['native-recovery-fixture']],
    ['web-gpt-fixture', ['route', 'connect']]
  ]);
});

test('OpenAI provider policy changes use preview, verification, and the private state root', async t => {
  const stateRoot = temporaryState(t);
  const provider = {
    enabled: true,
    defaultModel: 'gpt-5.6-luna',
    models: [
      { id: 'gpt-5.6-luna', lifecycle: 'current', callEnabled: true, agentSelectable: true, availability: { status: 'untested', checkedAt: null } },
      { id: 'gpt-5.6-terra', lifecycle: 'current', callEnabled: true, agentSelectable: true, availability: { status: 'untested', checkedAt: null } }
    ]
  };
  const calls = [];
  const controller = createActionController({
    stateRoot,
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({}),
    getOpenaiProviderStatus: async () => provider,
    runCommand: async (_executable, args, options) => {
      calls.push({ args, stateRoot: options.env.AICC_STATE_ROOT });
      if (args.includes('provider')) provider.enabled = args.at(-1) === 'true';
      if (args.includes('default-model')) provider.defaultModel = args.at(-1);
      return commandResult();
    }
  });
  const disable = await controller.preview('openai.provider.set', { enabled: false });
  assert.equal((await controller.execute(disable.confirmationToken)).ok, true);
  assert.equal(provider.enabled, false);
  const defaultPreview = await controller.preview('openai.default-model.set', { model: 'gpt-5.6-terra' });
  assert.equal((await controller.execute(defaultPreview.confirmationToken)).ok, true);
  assert.equal(provider.defaultModel, 'gpt-5.6-terra');
  assert.ok(calls.every(call => call.stateRoot === stateRoot));
});

test('preview token is stored by hash and can execute only once', async t => {
  const stateRoot = temporaryState(t);
  let healthy = false;
  const calls = [];
  const controller = createActionController({
    stateRoot,
    ocxExecutable: 'ocx-fixture',
    ocxUpstreamStartCommand: 'ocx-upstream-start-fixture',
    getOcxStatus: async () => ocxRuntimeState(healthy),
    getAccountStatus: async () => ({}),
    runCommand: async (executable, args) => {
      calls.push([executable, args]);
      healthy = true;
      return commandResult({ stdout: 'started' });
    }
  });

  const preview = await controller.preview('ocx.start');
  const records = fs.readdirSync(path.join(stateRoot, 'previews'));
  assert.equal(records.length, 1);
  assert.equal(records[0].includes(preview.confirmationToken), false);

  const result = await controller.execute(preview.confirmationToken);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [[process.execPath, ['ocx-upstream-start-fixture']]]);
  await assert.rejects(
    controller.execute(preview.confirmationToken),
    error => error instanceof ActionError && error.code === 'confirmation_not_found'
  );
});

test('latest AICC recovery is previewed and executed once only at exact idle', async t => {
  const stateRoot = temporaryState(t);
  const calls = [];
  let applied = false;
  const recovery = {
    available: true,
    state: 'ready',
    reason: 'exact_component_ready',
    component: 'dashboard',
    operationId: 'operation-20260825-gui',
    pointerSha256: 'a'.repeat(64),
    status: { ready: true, summary: 'READY' },
    dryRun: { ready: true, summary: 'READY' },
    gate: { readOk: true, exactIdle: true, activeCount: 0, unknownCount: 0 }
  };
  const controller = createActionController({
    stateRoot,
    aiccRecoveryRunner: '/fixture/aicc-recovery-runner.mjs',
    getAiccRecoveryStatus: async () => applied
      ? { ...recovery, state: 'applied', reason: 'exact_component_recovery_applied', dryRun: null }
      : recovery,
    runCommand: async (executable, args) => {
      calls.push([executable, args]);
      applied = true;
      return commandResult();
    }
  });

  assert.ok(controller.list().some(item => item.name === 'aicc.restore.latest'));
  const preview = await controller.preview('aicc.restore.latest');
  assert.equal(preview.args.component, 'dashboard');
  assert.match(preview.impact, /dashboard/);
  const result = await controller.execute(preview.confirmationToken);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [[process.execPath, ['/fixture/aicc-recovery-runner.mjs', 'apply']]]);
  await assert.rejects(controller.execute(preview.confirmationToken), error => error.code === 'confirmation_not_found');
});

test('latest AICC recovery rejects ACTIVE or UNKNOWN without dispatch', async t => {
  const stateRoot = temporaryState(t);
  let calls = 0;
  const controller = createActionController({
    stateRoot,
    getAiccRecoveryStatus: async () => ({
      available: true,
      state: 'hold',
      component: 'workspace-business',
      operationId: 'operation-20260825-hold',
      pointerSha256: 'b'.repeat(64),
      status: { ready: true },
      dryRun: null,
      gate: { readOk: true, exactIdle: false, activeCount: 1, unknownCount: 0 }
    }),
    runCommand: async () => { calls += 1; return commandResult(); }
  });
  await assert.rejects(controller.preview('aicc.restore.latest'), error => error.code === 'codex_work_not_idle');
  assert.equal(calls, 0);
});

test('OCX actions target the default App home instead of an inherited isolated home', async t => {
  const stateRoot = temporaryState(t);
  let healthy = false;
  let commandOptions;
  const controller = createActionController({
    stateRoot,
    appCodexHome: '/safe/app-home',
    env: {
      CODEX_HOME: '/unsafe/isolated-home',
      CODEX_SQLITE_HOME: '/unsafe/sqlite-home',
      CODEX_MULTI_ACCOUNT_NAME: 'isolated@example.invalid'
    },
    ocxExecutable: 'ocx-fixture',
    getOcxStatus: async () => ocxRuntimeState(healthy),
    getAccountStatus: async () => ({}),
    runCommand: async (_executable, _args, options) => {
      commandOptions = options;
      healthy = true;
      return commandResult();
    }
  });

  const preview = await controller.preview('ocx.start');
  const result = await controller.execute(preview.confirmationToken);

  assert.equal(result.ok, true);
  assert.equal(commandOptions.env.CODEX_HOME, '/safe/app-home');
  assert.equal(commandOptions.env.CM_APP_CODEX_HOME, '/safe/app-home');
  assert.equal('CODEX_SQLITE_HOME' in commandOptions.env, false);
  assert.equal('CODEX_MULTI_ACCOUNT_NAME' in commandOptions.env, false);
});

test('OCX service start waits for launchd health before declaring failure', async t => {
  const stateRoot = temporaryState(t);
  let commandRan = false;
  let postCommandReads = 0;
  const controller = createActionController({
    stateRoot,
    verifyDelayMs: 0,
    ocxExecutable: 'ocx-fixture',
    getOcxStatus: async () => {
      const healthy = commandRan && ++postCommandReads >= 2;
      return ocxRuntimeState(healthy);
    },
    getAccountStatus: async () => ({}),
    runCommand: async () => {
      commandRan = true;
      return commandResult();
    }
  });

  const preview = await controller.preview('ocx.start');
  const result = await controller.execute(preview.confirmationToken);

  assert.equal(result.ok, true);
  assert.equal(result.after.healthy, true);
  assert.equal(postCommandReads, 2);
});

test('execution refuses a stale preview before running a command', async t => {
  const stateRoot = temporaryState(t);
  let version = '2.7.42';
  let calls = 0;
  const controller = createActionController({
    stateRoot,
    getOcxStatus: async () => ({ installed: true, healthy: false, version, runtime: null }),
    getAccountStatus: async () => ({}),
    runCommand: async () => { calls += 1; return commandResult(); }
  });
  const preview = await controller.preview('ocx.start');
  version = '2.7.43';
  await assert.rejects(
    controller.execute(preview.confirmationToken),
    error => error instanceof ActionError && error.code === 'stale_preview'
  );
  assert.equal(calls, 0);
});

test('expired confirmation cannot execute a command', async t => {
  const stateRoot = temporaryState(t);
  let clock = 1_000;
  let calls = 0;
  const controller = createActionController({
    stateRoot,
    now: () => clock,
    previewLifetimeMs: 100,
    getOcxStatus: async () => ({ installed: true, healthy: false, version: '2.7.42', runtime: null }),
    getAccountStatus: async () => ({}),
    runCommand: async () => { calls += 1; return commandResult(); }
  });
  const preview = await controller.preview('ocx.start');
  clock = 1_101;
  await assert.rejects(
    controller.execute(preview.confirmationToken),
    error => error instanceof ActionError && error.code === 'confirmation_expired'
  );
  assert.equal(calls, 0);
});

test('one-writer lock preserves an unused preview while busy', async t => {
  const stateRoot = temporaryState(t);
  const controller = createActionController({
    stateRoot,
    getOcxStatus: async () => ({ installed: true, healthy: false, version: '2.7.42', runtime: null }),
    getAccountStatus: async () => ({}),
    runCommand: async () => commandResult()
  });
  const preview = await controller.preview('ocx.start');
  fs.writeFileSync(controller.lockPath, 'busy\n', { flag: 'wx' });
  await assert.rejects(
    controller.execute(preview.confirmationToken),
    error => error instanceof ActionError && error.code === 'action_busy'
  );
  fs.unlinkSync(controller.lockPath);
  assert.equal(fs.readdirSync(path.join(stateRoot, 'previews')).length, 1);
});

test('failed OCX start rolls back a proxy that became healthy', async t => {
  const stateRoot = temporaryState(t);
  let healthy = false;
  const calls = [];
  const controller = createActionController({
    stateRoot,
    ocxExecutable: 'ocx-fixture',
    ocxUpstreamStartCommand: 'ocx-upstream-start-fixture',
    getOcxStatus: async () => ocxRuntimeState(healthy),
    getAccountStatus: async () => ({}),
    runCommand: async (executable, args) => {
      calls.push([executable, args]);
      if (executable === process.execPath && args[0] === 'ocx-upstream-start-fixture') {
        healthy = true;
        return commandResult({ ok: false, exitCode: 1, stderr: 'failed after start' });
      }
      healthy = false;
      return commandResult();
    }
  });
  const preview = await controller.preview('ocx.start');
  const result = await controller.execute(preview.confirmationToken);
  assert.equal(result.ok, false);
  assert.deepEqual(calls, [
    [process.execPath, ['ocx-upstream-start-fixture']],
    ['ocx-fixture', ['service', 'stop']]
  ]);
  assert.deepEqual(result.rollback, {
    attempted: true,
    commandOk: true,
    restored: true,
    state: { installed: true, healthy: false, version: '2.10.0', port: null, topology: 'unknown', routingInjected: null, activeTurns: null }
  });
});

test('OCX catalog refresh uses the upstream read-only wrapper and preserves route ownership', async t => {
  const calls = [];
  const controller = createActionController({
    stateRoot: temporaryState(t),
    ocxUpstreamSyncCommand: 'ocx-upstream-sync-fixture',
    getOcxStatus: async () => ocxRuntimeState(true),
    getAccountStatus: async () => ({}),
    runCommand: async (executable, args) => {
      calls.push([executable, args]);
      return commandResult({ stdout: JSON.stringify({ ok: true, routeMutation: false }) });
    }
  });
  const preview = await controller.preview('ocx.sync');
  const result = await controller.execute(preview.confirmationToken);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [[process.execPath, ['ocx-upstream-sync-fixture']]]);
  assert.equal(calls.some(([, args]) => args.includes('sync') || args.includes('restore')), false);
});

test('OCX stop refuses unknown or nonzero active turns before touching the service', async t => {
  for (const activeTurns of [null, 2]) {
    const controller = createActionController({
      stateRoot: temporaryState(t),
      getOcxStatus: async () => ocxRuntimeState(true, { sections: { runtime: { routingInjected: false, activeTurns } } }),
      getAccountStatus: async () => ({}),
      runCommand: async () => { throw new Error('must not run'); }
    });
    await assert.rejects(
      controller.preview('ocx.stop'),
      error => error.code === (activeTurns === null ? 'turn_state_unknown' : 'active_turns')
    );
  }
});

test('account switch resolves a real account and delegates to the embedded command contract', async t => {
  const stateRoot = temporaryState(t);
  let activeAccount = 'one@example.invalid';
  const calls = [];
  const accounts = [
    { index: 1, account: 'one@example.invalid', id_prefix: '11111111', expired: false },
    { index: 2, account: 'two@example.invalid', id_prefix: '22222222', expired: false }
  ];
  const controller = createActionController({
    stateRoot,
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({ state: 'ready', activeAccount, accounts }),
    accountSwitchCommand: selector => ({ executable: 'python-fixture', args: ['manager.py', 'switch', selector] }),
    runCommand: async (executable, args) => {
      calls.push([executable, args]);
      activeAccount = args.at(-1);
      return commandResult({ stdout: 'access_token=must-not-leak' });
    }
  });
  const preview = await controller.preview('account.switch', { selector: '2' });
  assert.equal(preview.args.selector, 'two@example.invalid');
  const result = await controller.execute(preview.confirmationToken);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['python-fixture', ['manager.py', 'switch', 'two@example.invalid']]]);
  assert.equal(result.command.output, 'access_token=<redacted>');
});

test('expired and already-active accounts cannot produce a preview', async t => {
  const controller = createActionController({
    stateRoot: temporaryState(t),
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({
      state: 'ready',
      activeAccount: 'one@example.invalid',
      accounts: [
        { index: 1, account: 'one@example.invalid', expired: false },
        { index: 2, account: 'old@example.invalid', expired: true }
      ]
    })
  });
  await assert.rejects(controller.preview('account.switch', { selector: '1' }), error => error.code === 'already_active');
  await assert.rejects(controller.preview('account.switch', { selector: '2' }), error => error.code === 'account_expired');
});

test('OCX account switch uses a guarded preview and restores the previous account on failure', async t => {
  const stateRoot = temporaryState(t);
  let activeId = 'one';
  const calls = [];
  const accounts = [
    { id: 'one', label: 'one', active: true, needsReauth: false, paused: false },
    { id: 'two', label: 'two', active: false, needsReauth: false, paused: false }
  ];
  const controller = createActionController({
    stateRoot,
    ocxExecutable: 'ocx-fixture',
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({}),
    getOcxAccountStatus: async () => ({
      state: 'ready', activeId,
      accounts: accounts.map(account => ({ ...account, active: account.id === activeId }))
    }),
    runCommand: async (_executable, args) => {
      calls.push(args);
      activeId = args.at(-1);
      return commandResult();
    }
  });
  const preview = await controller.preview('ocx.account.use', { selector: 'two' });
  const result = await controller.execute(preview.confirmationToken);
  assert.equal(result.ok, true);
  assert.equal(activeId, 'two');
  assert.deepEqual(calls, [['account', 'use', 'openai', 'two']]);
});

test('OCX import action verifies one new account and preserves the active selection', async t => {
  const stateRoot = temporaryState(t);
  let accounts = [{ id: 'one', label: 'one', active: true, needsReauth: false, paused: false }];
  const controller = createActionController({
    stateRoot,
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({}),
    getOcxAccountStatus: async () => ({ state: 'ready', activeId: 'one', accounts }),
    ocxImportCommand: () => ({ executable: 'import-fixture', args: [] }),
    runCommand: async () => {
      accounts = [...accounts, { id: 'two', label: 'plus', active: false, needsReauth: false, paused: false }];
      return commandResult({ stdout: '{"ok":true,"imported":true}' });
    }
  });
  const preview = await controller.preview('ocx.account.import-cm');
  const result = await controller.execute(preview.confirmationToken);
  assert.equal(result.ok, true);
  assert.equal(result.after.activeId, 'one');
  assert.equal(result.after.accounts.length, 2);
});

test('OCX import action accepts an in-place credential refresh', async t => {
  const stateRoot = temporaryState(t);
  const accounts = [
    { id: 'one', label: 'one', active: true, needsReauth: false, paused: false },
    { id: 'owner', label: 'owner', active: false, needsReauth: false, paused: false }
  ];
  const controller = createActionController({
    stateRoot,
    getOcxStatus: async () => ({}),
    getAccountStatus: async () => ({}),
    getOcxAccountStatus: async () => ({ state: 'ready', activeId: 'one', accounts }),
    ocxImportCommand: () => ({ executable: 'import-fixture', args: [] }),
    runCommand: async () => commandResult({ stdout: '{"ok":true,"imported":true}' })
  });
  const preview = await controller.preview('ocx.account.import-cm');
  const result = await controller.execute(preview.confirmationToken);
  assert.equal(result.ok, true);
  assert.equal(result.after.activeId, 'one');
  assert.equal(result.after.accounts.length, 2);
});
