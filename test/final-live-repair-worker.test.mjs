import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildTrustedCallbackRequest, classifyWorkspaceRuntimeAction, completeFinalCallback, evaluateDirectSurvival, evaluateProSavedChatLineage, evaluateReusableAccountInventoryStage, evaluateReusableWorkspaceStage, evaluateRouteSplitStatus, formatKstTimestamp, formatRepairProgressLine, inspectStageRecovery, reconcileTaskOwnedNativeCli, recoverConfiguredSurvivalPaths, releaseDesktopForOwnedCallbacks, reopenDesktopAfterOwnedCallbacks, resolveVerifiedWorkspaceAppName, restoreRouteSplitPreimage, waitForExactIdle } from '../tools/platform/aicc/run-final-live-repair.mjs';

const workerSource = fs.readFileSync(new URL('../tools/platform/aicc/run-final-live-repair.mjs', import.meta.url), 'utf8');

test('final repair reports remote cleanup as pending exact review rather than a user lock', () => {
  assert.doesNotMatch(workerSource, /USER_LOCK/);
  assert.match(workerSource, /PENDING_EXACT_REVIEW/);
  assert.match(workerSource, /pendingReviews/);
  assert.match(workerSource, /live_repair_requires_macos/);
});

test('final live repair gate waits for active work and requires consecutive exact-idle samples', async () => {
  const samples = [
    { safe: false, active: [{ pid: 1 }], unknown: [], complete: [] },
    { safe: true, active: [], unknown: [], complete: [] },
    { safe: true, active: [], unknown: [], complete: [] }
  ];
  const observed = [];
  const result = await waitForExactIdle({ inspect: () => samples.shift(), samples: 2, intervalMs: 0, maxWaitMs: 1_000, onSample: value => observed.push(value) });
  assert.equal(result.exactIdle, true);
  assert.equal(observed.length, 3);
});

test('final live repair gate never converts UNKNOWN into idle', async () => {
  await assert.rejects(
    waitForExactIdle({ inspect: () => ({ safe: false, active: [], unknown: [{ reason: 'malformed' }], complete: [] }), samples: 1, intervalMs: 0, maxWaitMs: 100 }),
    error => error.code === 'codex_gate_unknown'
  );
});

test('workspace live repair reuses ready, observes identity lag, and installs only exact drift or stopped runtime', () => {
  const base = {
    state: 'attention',
    serverReady: false,
    missingCount: 0,
    remoteAuthority: { activeLeases: 0, runtimeReady: false, runtimeReasons: [] },
    tunnel: { running: true, healthy: true, ready: true, reason: null }
  };
  assert.equal(classifyWorkspaceRuntimeAction({
    ...base,
    state: 'ready',
    serverReady: true,
    remoteAuthority: { activeLeases: 0, runtimeReady: true, runtimeReasons: [] }
  }).action, 'reuse');
  assert.equal(classifyWorkspaceRuntimeAction({
    ...base,
    remoteAuthority: { activeLeases: 0, runtimeReady: false, runtimeReasons: ['process_identity', 'supervisor_identity'] }
  }).action, 'observe');
  assert.equal(classifyWorkspaceRuntimeAction({
    ...base,
    remoteAuthority: { activeLeases: 0, runtimeReady: false, runtimeReasons: ['source_identity'] }
  }).action, 'install');
  assert.equal(classifyWorkspaceRuntimeAction({
    ...base,
    tunnel: { running: false, healthy: false, ready: false, reason: 'launchd 중지' }
  }).action, 'install');
  assert.equal(classifyWorkspaceRuntimeAction({
    ...base,
    remoteAuthority: { activeLeases: null, runtimeReady: false, runtimeReasons: [] }
  }).action, 'hold');
  assert.equal(classifyWorkspaceRuntimeAction({
    ...base,
    tunnel: { running: true, healthy: false, ready: false, reason: '터널 준비 안 됨' }
  }).action, 'hold');
});

test('terminal progress keeps stage, elapsed time, ETA and HOLD reason human-readable', () => {
  assert.equal(formatKstTimestamp(Date.parse('2026-08-25T04:54:26Z')), '2026-08-25 13:54:26 KST');
  assert.equal(
    formatRepairProgressLine({ completed: 3, total: 11, stage: 'account-3-lineage', terminal: null, elapsedMs: 65_000, remainingMs: 125_000 }),
    'AICC [3/11] 기존 검토 결과 재사용 · 경과 01:05 · 예상 남음 02:05'
  );
  assert.match(
    formatRepairProgressLine({ completed: 3, total: 11, stage: 'account-3-lineage', terminal: 'HOLD', elapsedMs: 65_000, reason: 'identity_mismatch' }),
    /HOLD: 기존 검토 결과 재사용.*예상 남음 00:00.*identity_mismatch/
  );
  assert.match(
    formatRepairProgressLine({ completed: 3, total: 11, stage: 'final-callback', terminal: 'waiting_callback', elapsedMs: 65_000, remainingMs: 125_000 }),
    /현재 작업에 최종 결과 전달.*예상 남음 02:05/
  );
});

test('Pro saved Chat lineage does not depend on the current virtualized sidebar', () => {
  const evidence = {
    mode: 'Chat',
    model: 'Pro',
    sidebarListed: false,
    reloadVerified: true,
    authenticatedApiVerified: true,
    identityVerified: true,
    userTurns: 1,
    assistantTurns: 1,
    authenticatedAssistantNodes: 6,
    assistantMessageIdSha256: 'a'.repeat(64),
    submissions: 0,
    remoteMutation: false
  };
  assert.deepEqual(evaluateProSavedChatLineage(evidence), {
    ok: true,
    failures: [],
    sidebarObservation: 'not_listed'
  });
  assert.deepEqual(evaluateProSavedChatLineage({ ...evidence, assistantMessageIdSha256: null }), {
    ok: false,
    failures: ['assistant_lineage_hash'],
    sidebarObservation: 'not_listed'
  });
});

test('account app canary resolves the exact current display name from stable-ID detail evidence', () => {
  const binding = { remoteAppId: 'plugin_exact123' };
  const inventory = {
    observation: {
      pageLineage: { pluginId: binding.remoteAppId, exactPath: true, familyVisible: true },
      headings: ['설정', 'AICC Workspace — current owner tools 22', 'AICC Workspace — current owner tools 22']
    }
  };
  assert.equal(resolveVerifiedWorkspaceAppName(inventory, binding), 'AICC Workspace — current owner tools 22');
  assert.throws(
    () => resolveVerifiedWorkspaceAppName({ ...inventory, observation: { ...inventory.observation, headings: ['AICC Workspace one', 'AICC Workspace two'] } }, binding),
    error => error.code === 'account_app_name_unknown'
  );
  assert.throws(
    () => resolveVerifiedWorkspaceAppName(inventory, { remoteAppId: 'plugin_foreign' }),
    error => error.code === 'account_app_name_lineage_failed'
  );
});

test('resume reuses a completed Workspace canary only after an exact current post-read', () => {
  const current = {
    state: 'ready',
    serverReady: true,
    remoteAuthority: { runtimeReady: true, activeLeases: 0 },
    tunnel: { running: true, healthy: true, ready: true },
    publication: { toolCount: 22, readToolCount: 17, writeToolCount: 5 }
  };
  const prior = {
    surface: 'business-full',
    canary: { ok: true, surface: 'business-full', write: true, readback: true, rollback: 'pass' },
    sourceManifest: { toolCount: 22, readToolCount: 17, writeToolCount: 5 }
  };
  assert.equal(evaluateReusableWorkspaceStage({ current, prior, surface: 'business-full', toolCount: 22, readToolCount: 17, writeToolCount: 5 }).ok, true);
  assert.deepEqual(
    evaluateReusableWorkspaceStage({ current: { ...current, remoteAuthority: { runtimeReady: true, activeLeases: null } }, prior, surface: 'business-full', toolCount: 22, readToolCount: 17, writeToolCount: 5 }).failures,
    ['authority_ready']
  );
});

test('resume reuses three persisted account canaries without another browser submission', () => {
  const bindings = [
    ['account-1', 'business-full', 'plugin-business'],
    ['account-2', 'business-full', 'plugin-business'],
    ['account-3', 'personal-read-fetch', 'plugin-personal']
  ].map(([accountAlias, surfaceProfile, remoteAppId]) => ({ accountAlias, surfaceProfile, remoteAppId }));
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const account = (accountIndex, surface, appId) => ({
    accountIndex,
    surface,
    identityHash: 'a'.repeat(64),
    workspaceIdentityHash: 'b'.repeat(64),
    appDisplayNameHash: 'c'.repeat(64),
    canonicalAppIdHash: hash(appId),
    preflight: { submissions: 0, remoteMutation: false, mode: 'Chat' },
    canary: { submissions: 1, persistedToolCall: true, conversationUrlHash: 'd'.repeat(64) }
  });
  const input = {
    topology: { accountBindings: bindings },
    roleIdentities: { pro: { accountAlias: 'account-3' }, default: { accountAlias: 'account-1' }, secondary: { accountAlias: 'account-2' } }
  };
  const result = evaluateReusableAccountInventoryStage({
    ...input,
    prior: { accounts: [account(3, 'personal-read-fetch', 'plugin-personal'), account(1, 'business-full', 'plugin-business'), account(2, 'business-full', 'plugin-business')] }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.postRead.accountAliases, ['account-3', 'account-1', 'account-2']);
  assert.equal(evaluateReusableAccountInventoryStage({
    ...input,
    prior: { accounts: [account(3, 'personal-read-fetch', 'wrong'), account(1, 'business-full', 'plugin-business'), account(2, 'business-full', 'plugin-business')] }
  }).ok, false);
});

test('task-owned Native CLI reconciliation waits for active work then terminates only the exact UNKNOWN identity once', async () => {
  const pid = 4242;
  const identity = 'a'.repeat(64);
  const samples = [
    { safe: false, active: [{ pid: 7 }], unknown: [{ pid, reason: 'interactive_codex_without_rollout' }] },
    { safe: false, active: [], unknown: [{ pid, reason: 'interactive_codex_without_rollout' }] },
    { safe: true, active: [], unknown: [] }
  ];
  const terminated = [];
  let alive = true;
  const result = await reconcileTaskOwnedNativeCli({
    pid,
    expectedStartCommandSha256: identity,
    inspect: () => samples.shift(),
    identify: () => ({ pid, startCommandSha256: identity }),
    terminate: targetPid => { terminated.push(targetPid); alive = false; },
    exists: () => alive,
    intervalMs: 0,
    maxWaitMs: 1_000
  });
  assert.equal(result.terminal, 'PASS');
  assert.deepEqual(terminated, [pid]);
});

test('task-owned Native CLI reconciliation refuses foreign UNKNOWN and PID reuse without termination', async () => {
  let terminated = false;
  await assert.rejects(
    reconcileTaskOwnedNativeCli({
      pid: 4242,
      expectedStartCommandSha256: 'a'.repeat(64),
      inspect: () => ({ safe: false, active: [], unknown: [{ pid: 9999, reason: 'interactive_codex_without_rollout' }] }),
      terminate: () => { terminated = true; },
      intervalMs: 0,
      maxWaitMs: 100
    }),
    error => error.code === 'codex_gate_unknown'
  );
  await assert.rejects(
    reconcileTaskOwnedNativeCli({
      pid: 4242,
      expectedStartCommandSha256: 'a'.repeat(64),
      inspect: () => ({ safe: false, active: [], unknown: [{ pid: 4242, reason: 'interactive_codex_without_rollout' }] }),
      identify: () => ({ pid: 4242, startCommandSha256: 'b'.repeat(64) }),
      terminate: () => { terminated = true; },
      intervalMs: 0,
      maxWaitMs: 100
    }),
    error => error.code === 'native_cli_identity_conflict'
  );
  assert.equal(terminated, false);
});

function directRoute({ mode = 'browser-only', readyStatus = 404, ready = false, counters = [0, 0, 0] } = {}) {
  return {
    health: {
      status: 200,
      ready: true,
      acceptingTurns: true,
      mode,
      counters: {
        active_http_turns: counters[0],
        active_browser_http_turns: counters[1],
        active_browser_turns: counters[2],
        active_turns: null
      }
    },
    ready: { status: readyStatus, ready }
  };
}

test('17842 legacy browser-only standby treats absent readyz as not applicable, not failure', () => {
  assert.deepEqual(evaluateDirectSurvival(directRoute()), {
    ok: true,
    readyContract: 'not_applicable',
    legacyReadyNotApplicable: true
  });
  assert.equal(evaluateDirectSurvival(directRoute({ mode: 'full' })).ok, false);
  assert.equal(evaluateDirectSurvival(directRoute({ counters: [0, 1, 0] })).ok, false);
  assert.equal(evaluateDirectSurvival(directRoute({ counters: [0, null, 0] })).ok, false);
});

test('cold survival recovery bootstraps each exactly absent configured job once', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-cold-survival-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const labels = [
    'com.agenticlab.aicc.web-gpt-rescue',
    'com.opencodex.proxy',
    'io.github.codex-chatgpt-web.daemon',
    'dev.agenticlab.web-gpt-observer'
  ];
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(launchAgents, { recursive: true });
  for (const label of labels) fs.writeFileSync(path.join(launchAgents, `${label}.plist`), '<plist/>\n');
  const ready = { direct: false, ocx: false, integrated: false, observer: false };
  const bootstraps = [];
  const snapshot = () => ({
    integrated: ready.integrated ? {
      health: { ready: true, acceptingTurns: true, acceptingBrowserTurns: true, counters: { active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0 } },
      ready: { ready: true }
    } : { health: { ready: false, counters: {} }, ready: { ready: false } },
    direct: ready.direct ? directRoute() : { health: { status: null, ready: false, counters: {} }, ready: { status: null, ready: false } },
    ocx: ready.ocx ? { health: { ready: true }, ready: { ready: true } } : { health: { ready: false }, ready: { ready: false } }
  });
  const result = await recoverConfiguredSurvivalPaths({
    home,
    uid: 501,
    inspectRuntime: async () => snapshot(),
    inspectObserver: async () => ({ status: ready.observer ? 200 : null }),
    inspectNative: () => ({ ok: true, destination: 'native' }),
    appVersion: () => 'fixture',
    appPids: () => [],
    pause: async () => {},
    runCommand: (_executable, args) => {
      if (args[0] === 'print') return { status: 113, stdout: '', stderr: 'Could not find service' };
      if (args[0] === '-lint') return { status: 0, stdout: 'OK', stderr: '' };
      if (args[0] === 'bootstrap') {
        const label = path.basename(args[2], '.plist');
        bootstraps.push(label);
        if (label === labels[0]) ready.direct = true;
        if (label === labels[1]) ready.ocx = true;
        if (label === labels[2]) ready.integrated = true;
        if (label === labels[3]) ready.observer = true;
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(bootstraps, labels);
  assert.equal(result.components.every(item => item.terminal === 'PASS' && item.mutation === true), true);
  assert.equal(result.launcher.terminal, 'DEFERRED_TO_VERSIONED_APP_STAGE');
});

test('cold survival recovery refuses a registered-unhealthy job without kickstart or bootstrap', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-cold-survival-hold-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  await assert.rejects(recoverConfiguredSurvivalPaths({
    home,
    uid: 501,
    inspectRuntime: async () => ({
      integrated: { health: { ready: false, counters: {} }, ready: { ready: false } },
      direct: { health: { status: null, ready: false, counters: {} }, ready: { status: null, ready: false } },
      ocx: { health: { ready: false }, ready: { ready: false } }
    }),
    inspectObserver: async () => ({ status: null }),
    inspectNative: () => ({ ok: true, destination: 'native' }),
    appVersion: () => 'fixture',
    runCommand: (_executable, args) => {
      calls.push(args);
      return { status: 0, stdout: 'registered', stderr: '' };
    }
  }), error => error.code === 'cold_service_registered_unhealthy');
  assert.equal(calls.some(args => args[0] === 'bootstrap' || args[0] === 'kickstart'), false);
});

function callbackRuntime() {
  return {
    integrated: {
      health: { ready: true, acceptingTurns: true, acceptingBrowserTurns: true, version: 'aicc.24', process: { pid: 1 }, counters: { active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0 } },
      ready: { ready: true }
    },
    direct: {
      health: { status: 200, ready: true, acceptingTurns: true, mode: 'browser-only', version: 'direct', process: { pid: 2 }, counters: { active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0 } },
      ready: { status: 404, ready: false }
    },
    ocx: { health: { ready: true, version: 'ocx', process: { pid: 3 } }, ready: { ready: true } },
    native: { ok: true, destination: 'native' }
  };
}

test('integrated callback canary carries the trusted read-only environment contract', () => {
  const request = buildTrustedCallbackRequest({
    taskId: '01a01d0d-52bc-7671-900f-68d314b37d11',
    turnId: 'turn-fixture',
    publicRoot: '/tmp/open-AICC<&',
    marker: 'AICC_CALLBACK_E2E_FIXTURE'
  });
  const metadata = JSON.parse(request.body.client_metadata['x-codex-turn-metadata']);
  assert.equal(request.prompt, 'Reply with exactly AICC_CALLBACK_E2E_FIXTURE and no other text. Do not use tools.');
  assert.equal(request.body.prompt_cache_key, metadata.thread_id);
  assert.equal(metadata.sandbox, 'read-only');
  assert.deepEqual(metadata.workspaces, { '/tmp/open-AICC<&': { has_changes: false } });
  assert.match(request.body.input[0].content[0].text, /<sandbox_mode>read-only<\/sandbox_mode>/);
  assert.match(request.body.input[0].content[0].text, /<root>\/tmp\/open-AICC&lt;&amp;<\/root>/);
  assert.equal(request.body.input[1].content[0].text, request.prompt);
  assert.equal(request.body.input.every(item => item.internal_chat_message_metadata_passthrough.turn_id === 'turn-fixture'), true);
});

test('owned callback transport releases Desktop once and preserves every route identity', async () => {
  const baseline = callbackRuntime();
  const result = await releaseDesktopForOwnedCallbacks({
    expectedPid: 123,
    baseline,
    quitDesktop: input => ({ ok: true, operation: 'quit', oldPid: input.expectedPid, newPid: null, quitCount: 1, forcedTermination: false }),
    inspectRuntime: async () => callbackRuntime()
  });
  assert.deepEqual(result, { ok: true, oldPid: 123, released: true, quitCount: 1, forcedTermination: false });
});

test('owned callback transport reopens Desktop once only after strict route readiness', async () => {
  const baseline = callbackRuntime();
  let opened = 0;
  const result = await reopenDesktopAfterOwnedCallbacks({
    baseline,
    inspectApps: (() => {
      let calls = 0;
      return () => ({ ok: true, applications: calls++ === 0 ? [] : [{ pid: 456 }] });
    })(),
    inspectRuntime: async () => callbackRuntime(),
    runCommand: () => { opened += 1; return { status: 0, stdout: '', stderr: '' }; },
    pause: async () => {},
    readyAttempts: 2
  });
  assert.equal(opened, 1);
  assert.deepEqual(result, { ok: true, reopened: true, newPid: 456, openCount: 1 });
});

test('route split is not reinstalled when the exact Native default and named routes already match', () => {
  const status = {
    ok: true,
    defaultCodex: { native: true },
    routes: ['codex-aicc', 'codex-web', 'codex-ocx'].map((name, index) => ({
      name,
      ready: true,
      sourceSha256: String(index).repeat(64),
      installedSha256: String(index).repeat(64)
    }))
  };
  assert.deepEqual(evaluateRouteSplitStatus(status, { active: false }), {
    desired: true,
    defaultNative: true,
    journalInactive: true,
    namedRoutesReady: true
  });
  assert.equal(evaluateRouteSplitStatus(status, { active: true }).desired, false);
  assert.equal(evaluateRouteSplitStatus({ ...status, defaultCodex: { native: false } }, { active: false }).desired, false);
  assert.equal(evaluateRouteSplitStatus({ ...status, routes: status.routes.slice(0, 2) }, { active: false }).desired, false);
});

test('final callback retries only retry-safe pre-dispatch writer busy and reuses the exact digest', async () => {
  const calls = [];
  const service = {
    async complete(input) {
      calls.push(input);
      if (calls.length === 1) throw Object.assign(new Error('busy'), { code: 'callback_destination_writer_busy' });
      return { ok: true, state: 'completed' };
    }
  };
  let clock = 0;
  const retries = [];
  const result = await completeFinalCallback({
    service,
    callbackId: 'callback-1',
    digest: 'a'.repeat(64),
    retryMs: 5,
    maxWaitMs: 100,
    now: () => clock,
    wait: async milliseconds => { clock += milliseconds; },
    onRetry: value => retries.push(value)
  });
  assert.equal(result.state, 'completed');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(retries, [{ attempt: 1, errorCode: 'callback_destination_writer_busy', elapsedMs: 0, remainingMs: 100, nextRetryMs: 5 }]);
});

test('final callback never retries ambiguous delivery', async () => {
  let calls = 0;
  await assert.rejects(
    completeFinalCallback({
      service: { async complete() { calls += 1; throw Object.assign(new Error('unknown'), { code: 'callback_delivery_unknown' }); } },
      callbackId: 'callback-1',
      digest: 'b'.repeat(64),
      retryMs: 1,
      maxWaitMs: 10,
      wait: async () => {}
    }),
    error => error.code === 'callback_delivery_unknown'
  );
  assert.equal(calls, 1);
});

test('final live repair updates an exact one-use recovery pointer before every mutable local stage', () => {
  assert.match(workerSource, /record\('dashboard-recovery-gui', resume \? 'NOT_APPLICABLE' : 'PASS'/);
  assert.match(workerSource, /dashboard_launchagent_failed/);
  for (const component of ['routes', 'dashboard', 'guidance', 'app']) {
    assert.match(workerSource, new RegExp(`sealStageRecovery\\(options, '${component}'`));
  }
  assert.match(workerSource, /surface === 'business-full' \? 'business' : 'personal'/);
  assert.match(workerSource, /sealStageRecovery\(options, recoveryComponent/);
  assert.match(workerSource, /state: 'dispatching'/);
  assert.match(workerSource, /recovery_dispatch_uncertain/);
  assert.match(workerSource, /recovery_replay_denied/);
  assert.match(workerSource, /run directory must remain under owner-only artifacts-private/);
  assert.match(workerSource, /record\('recovery-gui-open', 'PASS'/);
  assert.match(workerSource, /\/usr\/bin\/open/);
  assert.match(workerSource, /'--expected-prompt-file', options\.savedProPrompt/);
  assert.match(workerSource, /'--expected-receipt-file', options\.savedProReceipt/);
  assert.match(workerSource, /savedProPrompt: fs\.realpathSync\(required\(args, '--saved-pro-prompt'\)\)/);
  assert.match(workerSource, /savedProReceipt: fs\.realpathSync\(required\(args, '--saved-pro-receipt'\)\)/);
  assert.match(workerSource, /progress log must remain directly inside the exact run directory/);
  assert.match(workerSource, /createTerminalProgressReporter/);
  assert.match(workerSource, /formatKstTimestamp/);
  assert.match(workerSource, /stage: 'final-callback'/);
  assert.match(workerSource, /start\('account-3-lineage'\)/);
  assert.match(workerSource, /loadResumeEvidence\(options\)/);
  assert.match(workerSource, /resume\s*\?\s*options\.resumeVerified\.pro/);
  assert.match(workerSource, /identity_converged_without_restart/);
  assert.match(workerSource, /workspace_identity_convergence_hold/);
  assert.match(workerSource, /resolveVerifiedWorkspaceAppName\(detailInventory, binding\)/);
  assert.match(workerSource, /--inspect/);
  assert.match(workerSource, /account_canary_preflight_failed/);
  assert.doesNotMatch(workerSource, /'--app-name', 'AICC Workspace'/);
  assert.match(workerSource, /options\.resumeVerified\?\.workspaces\?\.business/);
  assert.match(workerSource, /options\.resumeVerified\?\.workspaces\?\.personal/);
  assert.match(workerSource, /fs\.mkdirSync\(path\.dirname\(backup\), \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(workerSource, /entry\.stage === 'final-callback' \|\| entry\.stage === 'terminal'/);
  assert.match(workerSource, /sourceRecoverySha256: sha256File\(dashboardRecovery\)/);
  assert.match(workerSource, /dry-run <routes\|dashboard\|app\|guidance\|business\|personal>/);
  assert.match(workerSource, /--recovery-component "\$TARGET" --recovery-mode "\$COMMAND"/);
  assert.doesNotMatch(workerSource, /ACTION="\\\$\{1:-status\}"/);
});

test('stage recovery rejects an unknown component before reading arbitrary targets', async t => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-final-recovery-inspect-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(runDir, 'repair-plan.json'), `${JSON.stringify({ operation: 'operation-fixture' })}\n`, { mode: 0o600 });
  await assert.rejects(
    inspectStageRecovery({ runDir, component: 'arbitrary-target' }),
    error => error.code === 'rollback_scope_invalid'
  );
});

test('route split recovery restores exact existing bytes and removes only formerly absent owned targets', async t => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-route-recovery-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const operation = 'route-recovery-fixture';
  const targetA = path.join(runDir, 'live', 'config.toml');
  const targetB = path.join(runDir, 'live', 'codex-aicc');
  const backup = path.join(runDir, 'preimage', 'route-split', '00.bin');
  fs.mkdirSync(path.dirname(targetA), { recursive: true });
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.writeFileSync(targetA, 'changed\n');
  fs.writeFileSync(targetB, 'new\n');
  fs.writeFileSync(backup, 'before\n');
  const digest = await import('node:crypto').then(({ createHash }) => createHash('sha256').update(fs.readFileSync(backup)).digest('hex'));
  fs.writeFileSync(path.join(runDir, 'preimage', 'route-split', 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    operation,
    entries: [
      { target: targetA, exists: true, mode: 0o600, sha256: digest, backup },
      { target: targetB, exists: false, mode: null, sha256: null, backup: null }
    ]
  })}\n`);
  const result = restoreRouteSplitPreimage({ runDir, operation, expectedTargets: [targetA, targetB] });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(targetA, 'utf8'), 'before\n');
  assert.equal(fs.existsSync(targetB), false);
});
