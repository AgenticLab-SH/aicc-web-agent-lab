import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { armCodexDesktopQuit, armCodexDesktopRestart, inspectCodexDesktopCatalog, inspectCodexWork, lastLifecycleEvent, quitCodexDesktopOnce, restartCodexDesktopOnce, runCodexDesktopForegroundOnce, validateSurvival } from '../src/codex-desktop-restart.mjs';

function healthyServices() {
  return {
    web: { status: 'ok', pid: 10, accepting_turns: true, accepting_browser_turns: true, active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0 },
    rescue: { status: 'ok', pid: 20 },
    ocx: { status: 'ok', pid: 30 },
    ocxState: { memory: { activeTurnCount: 0, isDraining: false } },
    nativeReady: true
  };
}

test('work inspection distinguishes completed idle shells from active and unknown tasks', () => {
  const processes = { ok: true, processes: [
    { pid: 1, command: 'codex', rollouts: ['/done.jsonl'], unknown: false },
    { pid: 2, command: 'codex', rollouts: ['/active.jsonl'], unknown: false },
    { pid: 3, command: 'codex', rollouts: [], unknown: false }
  ] };
  const result = inspectCodexWork({
    processes,
    lastLifecycleEvent: file => file.includes('done') ? { type: 'task_complete' } : { type: 'task_started' }
  });
  assert.equal(result.safe, false);
  assert.equal(result.complete.length, 1);
  assert.equal(result.active.length, 1);
  assert.equal(result.unknown.length, 1);
});

test('an interrupted turn is terminal even when no task_complete event follows it', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-desktop-aborted-turn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rollout = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(rollout, [
    JSON.stringify({ timestamp: '2026-08-20T15:05:02.711Z', type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: '2026-08-20T15:05:14.499Z', type: 'event_msg', payload: { type: 'turn_aborted' } })
  ].join('\n'));

  const event = lastLifecycleEvent(rollout);
  assert.deepEqual(event, {
    type: 'task_complete',
    timestamp: '2026-08-20T15:05:14.499Z',
    terminal: 'interrupted',
    sourceType: 'turn_aborted'
  });
  const status = inspectCodexWork({
    processes: { ok: true, processes: [{ pid: 41, command: 'codex app-server', rollouts: [rollout], unknown: false }] }
  });
  assert.equal(status.safe, true);
  assert.equal(status.active.length, 0);
  assert.equal(status.complete.length, 1);
  assert.equal(status.unknown.length, 0);
});

test('a final-answer response is terminal even when task_complete is absent', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-desktop-final-answer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rollout = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(rollout, [
    JSON.stringify({ timestamp: '2026-09-28T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } }),
    JSON.stringify({ timestamp: '2026-09-28T00:04:49.530Z', type: 'response_item', payload: { type: 'message', phase: 'final_answer' } })
  ].join('\n'));

  const event = lastLifecycleEvent(rollout);
  assert.deepEqual(event, {
    type: 'task_complete',
    timestamp: '2026-09-28T00:04:49.530Z',
    terminal: 'final_answer',
    sourceType: 'response_item_final_answer'
  });
  const status = inspectCodexWork({
    processes: { ok: true, processes: [{ pid: 24840, command: 'codex app-server', rollouts: [rollout], unknown: false }] }
  });
  assert.equal(status.safe, true);
  assert.equal(status.active.length, 0);
  assert.equal(status.complete.length, 1);
  assert.equal(status.unknown.length, 0);
});

test('live process discovery includes a bundled absolute codex executable', () => {
  const calls = [];
  const spawnSync = (command, args) => {
    calls.push([command, args]);
    if (command === 'ps' && args[0] === '-axo') {
      return { status: 0, stdout: ' 41 /Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server\n 42 /bin/zsh -lc codex\n', stderr: '' };
    }
    if (command === 'ps') return { status: 0, stdout: '/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server\n', stderr: '' };
    if (command === 'lsof') return { status: 0, stdout: 'n/tmp/sessions/rollout-current.jsonl\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  const result = inspectCodexWork({
    spawnSync,
    lastLifecycleEvent: () => ({ type: 'task_started' })
  });
  assert.equal(result.safe, false);
  assert.equal(result.active.length, 1);
  assert.equal(result.active[0].pid, 41);
  assert.equal(calls.some(([command, args]) => command === 'ps' && args[0] === '-axo'), true);
});

test('survival proof requires exact Web zero, OCX zero, Native, rescue, and stable service PIDs', () => {
  const before = healthyServices();
  assert.equal(validateSurvival(healthyServices(), { before }).ok, true);
  const busy = healthyServices();
  busy.web.active_http_turns = 1;
  assert.equal(validateSurvival(busy, { before }).ok, false);
  const replaced = healthyServices();
  replaced.ocx.pid = 31;
  assert.equal(validateSurvival(replaced, { before }).ok, false);
});

test('desktop catalog proof uses the live managed route while preserving the native cache', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-desktop-catalog-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex/config.toml'), 'openai_base_url = "http://127.0.0.1:17841/v1"\n');
  fs.writeFileSync(path.join(home, '.codex/models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }] }));
  const liveCatalog = { models: [
    { slug: 'gpt-5.6-sol' },
    { slug: 'chatgpt-web/saved/extra-high' },
    'chatgpt-web/temporary/high'
  ] };
  const routeSpawn = (_command, args) => ({
    status: args.at(-1) === 'http://127.0.0.1:17841/v1/models' ? 0 : 1,
    stdout: JSON.stringify(liveCatalog),
    stderr: ''
  });

  const pass = inspectCodexDesktopCatalog(home, undefined, { spawnSync: routeSpawn });
  assert.equal(pass.ok, true);
  assert.equal(pass.catalogSource, 'live_route');
  assert.equal(pass.nativeModelCount, 1);
  assert.equal(pass.webModelCount, 2);

  const missing = inspectCodexDesktopCatalog(home, 'chatgpt-web/temporary/xhigh', { spawnSync: routeSpawn });
  assert.equal(missing.ok, false);
  assert.equal(missing.liveCatalogReady, false);

  const unavailable = inspectCodexDesktopCatalog(home, undefined, {
    spawnSync: () => ({ status: 7, stdout: '', stderr: 'unavailable' })
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.liveCatalogReady, false);

  fs.writeFileSync(path.join(home, '.codex/config.toml'), 'openai_base_url = "https://example.invalid/v1"\n');
  const unmanaged = inspectCodexDesktopCatalog(home, undefined, { spawnSync: routeSpawn });
  assert.equal(unmanaged.ok, false);
  assert.equal(unmanaged.configManaged, false);
});

test('one-shot restart waits for five safe samples, quits once, opens once, and never forces', () => {
  let appPid = 100;
  let safeSamples = 0;
  let quitCalls = 0;
  let openCalls = 0;
  const result = restartCodexDesktopOnce({
    platform: 'darwin', expectedPid: 100, sampleIntervalMs: 0, reopenDelayMs: 0,
    pause: () => {},
    desktopApplications: () => ({ ok: true, applications: appPid ? [{ pid: appPid }] : [] }),
    inspectWork: () => ({ safe: ++safeSamples >= 2, active: safeSamples >= 2 ? [] : [{}], unknown: [], complete: [] }),
    serviceSnapshot: healthyServices,
    requestGracefulQuit: () => { quitCalls += 1; appPid = null; return { status: 0, stdout: 'true' }; },
    openDesktop: () => { openCalls += 1; appPid = 200; return { status: 0, stdout: '' }; },
    catalogState: () => ({ ok: true, modelCount: 17, webModelCount: 10, requiredModel: 'chatgpt-web/saved/extra-high' }),
    progress: () => {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.oldPid, 100);
  assert.equal(result.newPid, 200);
  assert.equal(result.zeroSamples, 5);
  assert.equal(result.restartCount, 1);
  assert.equal(result.forcedTermination, false);
  assert.equal(result.scheduledTaskConfirmationClicked, false);
  assert.equal(quitCalls, 1);
  assert.equal(openCalls, 1);
});

test('a graceful quit request is proven by exact PID disappearance, not advisory return text', () => {
  let appPid = 100;
  let openCalls = 0;
  const result = restartCodexDesktopOnce({
    platform: 'darwin', expectedPid: 100, sampleIntervalMs: 0, reopenDelayMs: 0,
    pause: () => {},
    desktopApplications: () => ({ ok: true, applications: appPid ? [{ pid: appPid }] : [] }),
    inspectWork: () => ({ safe: true, active: [], unknown: [], complete: [] }),
    serviceSnapshot: healthyServices,
    requestGracefulQuit: () => { appPid = null; return { status: 0, stdout: 'false' }; },
    openDesktop: () => { openCalls += 1; appPid = 200; return { status: 0, stdout: '' }; },
    catalogState: () => ({ ok: true, modelCount: 17, webModelCount: 10, requiredModel: 'chatgpt-web/saved/extra-high' }),
    progress: () => {}
  });
  assert.equal(result.ok, true);
  assert.equal(openCalls, 1);
});

test('a graceful quit that leaves the exact PID never opens or force-terminates the app', () => {
  let openCalls = 0;
  assert.throws(() => restartCodexDesktopOnce({
    platform: 'darwin', expectedPid: 100, sampleIntervalMs: 0,
    pause: () => {},
    desktopApplications: () => ({ ok: true, applications: [{ pid: 100 }] }),
    inspectWork: () => ({ safe: true, active: [], unknown: [], complete: [] }),
    serviceSnapshot: healthyServices,
    requestGracefulQuit: () => ({ status: 0, stdout: 'false' }),
    confirmScheduledTaskQuit: () => ({ status: 0, stdout: JSON.stringify({ clicked: false, reason: 'scheduled_task_warning_not_found' }) }),
    openDesktop: () => { openCalls += 1; return { status: 0, stdout: '' }; },
    progress: () => {}
  }), /desktop_did_not_exit_gracefully/);
  assert.equal(openCalls, 0);
});

test('scheduled-task quit dialog clicks only the exact eligible Quit button once', () => {
  let appPid = 100;
  let confirmCalls = 0;
  let openCalls = 0;
  const result = restartCodexDesktopOnce({
    platform: 'darwin', expectedPid: 100, sampleIntervalMs: 0, reopenDelayMs: 0,
    pause: () => {},
    desktopApplications: () => ({ ok: true, applications: appPid ? [{ pid: appPid }] : [] }),
    inspectWork: () => ({ safe: true, active: [], unknown: [], complete: [] }),
    serviceSnapshot: healthyServices,
    requestGracefulQuit: () => ({ status: 1, stdout: '' }),
    confirmScheduledTaskQuit: () => {
      confirmCalls += 1;
      appPid = null;
      return { status: 0, stdout: JSON.stringify({ clicked: true, button: '종료' }) };
    },
    openDesktop: () => { openCalls += 1; appPid = 200; return { status: 0, stdout: '' }; },
    catalogState: () => ({ ok: true, modelCount: 17, webModelCount: 10, requiredModel: 'chatgpt-web/saved/extra-high' }),
    progress: () => {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.scheduledTaskConfirmationClicked, true);
  assert.equal(confirmCalls, 1);
  assert.equal(openCalls, 1);
});

test('quit-once exits immediately without confirmation when the app closes normally', () => {
  let appPid = 100;
  let confirmCalls = 0;
  let openCalls = 0;
  const result = quitCodexDesktopOnce({
    platform: 'darwin', expectedPid: 100, sampleIntervalMs: 0,
    pause: () => {},
    desktopApplications: () => ({ ok: true, applications: appPid ? [{ pid: appPid }] : [] }),
    inspectWork: () => ({ safe: true, active: [], unknown: [], complete: [] }),
    serviceSnapshot: healthyServices,
    requestGracefulQuit: () => { appPid = null; return { status: 0, stdout: 'true' }; },
    confirmScheduledTaskQuit: () => { confirmCalls += 1; return { status: 0, stdout: '{}' }; },
    openDesktop: () => { openCalls += 1; return { status: 0, stdout: '' }; },
    progress: () => {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.operation, 'quit');
  assert.equal(result.newPid, null);
  assert.equal(result.quitCount, 1);
  assert.equal(result.restartCount, 0);
  assert.equal(result.scheduledTaskConfirmationClicked, false);
  assert.equal(confirmCalls, 0);
  assert.equal(openCalls, 0);
});

test('quit-once clicks one exact scheduled-task confirmation and never reopens', () => {
  let appPid = 100;
  let confirmCalls = 0;
  let openCalls = 0;
  const result = quitCodexDesktopOnce({
    platform: 'darwin', expectedPid: 100, sampleIntervalMs: 0,
    pause: () => {},
    desktopApplications: () => ({ ok: true, applications: appPid ? [{ pid: appPid }] : [] }),
    inspectWork: () => ({ safe: true, active: [], unknown: [], complete: [] }),
    serviceSnapshot: healthyServices,
    requestGracefulQuit: () => ({ status: 1, stdout: '' }),
    confirmScheduledTaskQuit: () => {
      confirmCalls += 1;
      appPid = null;
      return { status: 0, stdout: JSON.stringify({ clicked: true, button: '종료' }) };
    },
    openDesktop: () => { openCalls += 1; return { status: 0, stdout: '' }; },
    progress: () => {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.scheduledTaskConfirmationClicked, true);
  assert.equal(confirmCalls, 1);
  assert.equal(openCalls, 0);
});

test('foreground restart records one private terminal result without scheduling', { skip: process.platform === 'win32' }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-desktop-foreground-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateRoot = path.join(home, '.ai-control-center');
  const resultFile = path.join(stateRoot, 'runtime/foreground-rescue/restart-v1/result.json');
  const result = runCodexDesktopForegroundOnce({
    platform: 'darwin', home, stateRoot,
    expectedThreadId: '019fdae2-7573-7ab0-af6b-87951188b143',
    operationId: 'desktop-restart-v1', resultFile,
    inspectWork: {
      safe: false,
      active: [{ file: '/tmp/rollout-019fdae2-7573-7ab0-af6b-87951188b143.jsonl' }],
      complete: [],
      unknown: []
    },
    lifecycle: () => ({ ok: true, oldPid: 100, newPid: 200, servicePids: { web: 10, rescue: 20, ocx: 30 } })
  });
  assert.equal(result.status, 'PASS');
  assert.equal(result.scheduledTask, false);
  assert.equal(result.forceTermination, false);
  assert.deepEqual(result.desktop, { oldPid: 100, newPid: 200 });
  assert.equal(fs.statSync(resultFile).mode & 0o077, 0);
  assert.equal(JSON.parse(fs.readFileSync(resultFile, 'utf8')).operation, 'desktop-restart-v1');
});

test('foreground restart records HOLD once and rejects paths outside owner runtime', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-desktop-foreground-hold-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateRoot = path.join(home, '.ai-control-center');
  const common = {
    platform: 'darwin', home, stateRoot,
    expectedThreadId: '019fdae2-7573-7ab0-af6b-87951188b143',
    operationId: 'desktop-restart-hold-v1',
    inspectWork: {
      safe: false,
      active: [{ file: '/tmp/rollout-019fdae2-7573-7ab0-af6b-87951188b143.jsonl' }],
      complete: [],
      unknown: []
    },
    lifecycle: () => { throw new Error('safe_idle_window_timeout'); }
  };
  const resultFile = path.join(stateRoot, 'runtime/foreground-rescue/restart-hold-v1/result.json');
  const held = runCodexDesktopForegroundOnce({ ...common, resultFile });
  assert.equal(held.status, 'HOLD');
  assert.equal(held.reason, 'safe_idle_window_timeout');
  let outsideLifecycleCalls = 0;
  assert.throws(() => runCodexDesktopForegroundOnce({
    ...common,
    operationId: 'desktop-restart-outside-v1',
    resultFile: path.join(home, 'outside.json'),
    lifecycle: () => { outsideLifecycleCalls += 1; return { oldPid: 1, newPid: 2 }; }
  }), /foreground_result_outside_owner_runtime/);
  assert.equal(outsideLifecycleCalls, 0);
});

test('arming writes a private KeepAlive=false one-shot with exact PID and thread', { skip: process.platform === 'win32' }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-desktop-restart-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const spawnSync = (command, args) => {
    calls.push([command, args]);
    if (command === 'launchctl' && args[0] === 'print') return { status: 113, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = armCodexDesktopRestart({
    platform: 'darwin', home, stateRoot: path.join(home, '.ai-control-center'), uid: 501,
    node: '/usr/bin/node', ocxExecutable: '/usr/bin/true', expectedPid: 123,
    expectedThreadId: '019fdae2-7573-7ab0-af6b-87951188b143',
    now: new Date('2026-08-13T00:00:00.000Z'), spawnSync,
    inspectWork: {
      safe: false,
      active: [{ file: '/tmp/rollout-019fdae2-7573-7ab0-af6b-87951188b143.jsonl' }],
      complete: [],
      unknown: []
    }
  });
  const plist = fs.readFileSync(result.plistFile, 'utf8');
  assert.match(plist, /<key>KeepAlive<\/key><false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, new RegExp(`<key>HOME<\\/key><string>${home.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}<\\/string>`));
  assert.match(plist, /<key>PATH<\/key><string>\/usr\/bin:/);
  assert.match(plist, /--worker/);
  assert.equal(fs.statSync(result.runDir).mode & 0o077, 0);
  assert.equal(fs.statSync(result.planFile).mode & 0o077, 0);
  assert.equal(calls.at(-1)[0], 'launchctl');
  assert.equal(calls.at(-1)[1][0], 'bootstrap');
});

test('arming refuses an unobserved thread id before writing a worker', { skip: process.platform === 'win32' }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-desktop-restart-wrong-thread-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.throws(() => armCodexDesktopRestart({
    platform: 'darwin', home, stateRoot: path.join(home, '.ai-control-center'), uid: 501,
    node: '/usr/bin/node', ocxExecutable: '/usr/bin/true', expectedPid: 123,
    expectedThreadId: '019fdae2-7573-7ab0-af6b-87951188b143',
    inspectWork: { safe: true, active: [], complete: [], unknown: [] }
  }), /expected_thread_not_observed/);
});

test('quit arming records a distinct one-shot operation and label', { skip: process.platform === 'win32' }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-desktop-quit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const spawnSync = (command, args) => {
    if (command === 'launchctl' && args[0] === 'print') return { status: 113, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = armCodexDesktopQuit({
    platform: 'darwin', home, stateRoot: path.join(home, '.ai-control-center'), uid: 501,
    node: '/usr/bin/node', ocxExecutable: '/usr/bin/true', expectedPid: 123,
    expectedThreadId: '019fdae2-7573-7ab0-af6b-87951188b143',
    now: new Date('2026-08-13T00:00:00.000Z'), spawnSync,
    inspectWork: {
      safe: false,
      active: [{ file: '/tmp/rollout-019fdae2-7573-7ab0-af6b-87951188b143.jsonl' }],
      complete: [], unknown: []
    }
  });
  const plan = JSON.parse(fs.readFileSync(result.planFile, 'utf8'));
  assert.equal(result.operation, 'quit');
  assert.equal(plan.operation, 'quit');
  assert.match(result.label, /codex-desktop-quit/);
});
