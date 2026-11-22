import assert from 'node:assert/strict';
import test from 'node:test';
import { listTasks, recoveryBundle, runTask } from '../src/tasks.mjs';

test('diagnostic task allowlist is explicit', () => {
  const ids = listTasks().map(task => task.id);
  assert.ok(ids.includes('workspace.status'));
  assert.ok(ids.includes('workspace.publish-preflight'));
  assert.ok(ids.includes('agents.status'));
  assert.ok(ids.includes('guidance.check'));
  assert.ok(ids.includes('routes.status'));
  assert.ok(ids.includes('jobs.status'));
  assert.ok(ids.includes('browser.status'));
  assert.ok(ids.includes('extensions.status'));
  assert.ok(ids.includes('codex.plugins.status'));
  assert.ok(ids.includes('support.bundle'));
  assert.ok(ids.includes('web-gpt.doctor'));
  assert.ok(ids.includes('ocx.diagnostics'));
  assert.equal(ids.includes('shell'), false);
});

test('command task captures structured output without a shell', async () => {
  const result = await runTask('guidance.check', {
    runCommand: async (executable, args) => ({
      ok: true, exitCode: 0, durationMs: 4,
      stdout: JSON.stringify({ executable, args: args.slice(-1) }), stderr: ''
    })
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.args.at(-1), '-AsJson');
});

test('unknown diagnostic task fails closed', async () => {
  await assert.rejects(() => runTask('shell.anything'), /허용되지 않은/);
});

test('recovery bundle collects only isolated survival-path components', async () => {
  const calls = [];
  const component = (id, extra = {}) => ({ id, state: 'ready', detail: 'ok', ...extra });
  const result = await recoveryBundle({
    codexRouteStatus: async () => { calls.push('routes'); return component('codex-routes', { nativeReady: true, activeRoute: 'web-gpt', webGpt: { healthy: false } }); },
    ocxStatus: async () => { calls.push('ocx'); return component('ocx', { version: '2.14.1', healthy: true, ready: true }); },
    webGptStatus: async () => { calls.push('web-gpt'); return component('web-gpt', { version: null, activeHttpTurns: null }); },
    webGptRescueStatus: async () => { calls.push('rescue'); return { state: 'ready', version: '2.0.0-aicc.6', active: { http: 0, browserHttp: 0, browser: 0 } }; },
    workspaceMcpStatus: async options => { calls.push(options.surfaceProfile); return component('workspace-mcp', { surfaceProfile: options.surfaceProfile, workspaceCount: options.surfaceProfile === 'business-full' ? 39 : 51, publication: { toolCount: options.surfaceProfile === 'business-full' ? 22 : 18, needsPublish: true } }); },
    browserBrokerStatus: () => { calls.push('browser'); return component('browser-broker', { activeTaskTargets: 0 }); },
    guidanceStatus: () => { calls.push('guidance'); return component('guidance'); }
  });
  assert.equal(result.summary.total, 8);
  assert.equal(result.summary.ready, 8);
  assert.deepEqual(calls.sort(), ['browser', 'business-full', 'guidance', 'ocx', 'personal-read-fetch', 'rescue', 'routes', 'web-gpt'].sort());
  assert.equal(result.components.find(item => item.id === 'workspace-mcp-business').workspaceCount, 39);
  assert.equal(result.components.find(item => item.id === 'workspace-mcp-personal').workspaceCount, 51);
  assert.equal(result.components.find(item => item.id === 'web-gpt-rescue').active.http, 0);
});

test('recovery bundle isolates one failed component without dropping healthy survival paths', async () => {
  const component = id => ({ id, state: 'ready', detail: 'ok' });
  const result = await recoveryBundle({
    codexRouteStatus: async () => component('codex-routes'),
    ocxStatus: async () => { throw new Error('ocx fixture unavailable'); },
    webGptStatus: async () => component('web-gpt'),
    webGptRescueStatus: async () => ({ state: 'ready' }),
    workspaceMcpStatus: async options => ({ ...component('workspace-mcp'), surfaceProfile: options.surfaceProfile }),
    browserBrokerStatus: () => component('browser-broker'),
    guidanceStatus: () => component('guidance')
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.summary.attention, ['ocx']);
  assert.equal(result.components.find(item => item.id === 'ocx').isolatedFailure, undefined);
  assert.match(result.components.find(item => item.id === 'ocx').detail, /수집에 실패/);
  assert.equal(result.components.find(item => item.id === 'web-gpt-rescue').state, 'ready');
});
