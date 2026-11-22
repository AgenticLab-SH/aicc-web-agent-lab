import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.mjs';

test('server exposes local-control health, status, and allowlisted actions', async t => {
  const calls = [];
  const server = createServer({
    collectStatus: async () => ({ ok: true, schemaVersion: 1, components: [] }),
    codexWorkGateStatus: () => ({ ok: true, schemaVersion: 1, exactIdle: false, activeCount: 2, unknownCount: 0, allowedScope: 'source-test-documentation-only', sequence: { stages: [] } }),
    aiccRecoveryStatus: () => ({ ok: true, available: true, state: 'hold', component: 'dashboard', operationId: 'operation-server-test', gate: { readOk: true, exactIdle: false, activeCount: 2, unknownCount: 0 } }),
    actionController: {
      list: () => [{ name: 'ocx.start', title: 'OCX 시작', kind: 'provider' }],
      preview: async (action, args) => { calls.push(['preview', action, args]); return { ok: true, confirmationToken: 'token' }; },
      execute: async token => { calls.push(['execute', token]); return { ok: true }; }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const health = await fetch(`http://127.0.0.1:${port}/healthz`).then(response => response.json());
  assert.deepEqual(health, { ok: true, mode: 'local-control' });

  const dashboard = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get('content-type'), /^text\/html/);
  assert.match(await dashboard.text(), /open-AICC/);

  const status = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
  assert.equal(status.schemaVersion, 1);

  const workGate = await fetch(`http://127.0.0.1:${port}/api/codex-work-gate`).then(response => response.json());
  assert.equal(workGate.activeCount, 2);
  assert.equal(workGate.exactIdle, false);
  assert.equal(workGate.allowedScope, 'source-test-documentation-only');

  const recovery = await fetch(`http://127.0.0.1:${port}/api/recovery/latest`).then(response => response.json());
  assert.equal(recovery.state, 'hold');
  assert.equal(recovery.component, 'dashboard');
  assert.equal(recovery.gate.activeCount, 2);

  const actions = await fetch(`http://127.0.0.1:${port}/api/actions`).then(response => response.json());
  assert.equal(actions.actions[0].name, 'ocx.start');

  const designServer = createServer({
    collectStatus: async () => ({ ok: true }),
    designSourcesStatus: () => ({ ok: true, sources: [{ id: 'impeccable', status: 'current' }] }),
    scanDesignSources: () => ({ ok: true, checkedAt: '2026-08-14T00:00:00.000Z', sources: [] }),
    actionController: { list: () => [], preview: async () => ({}), execute: async () => ({}) }
  });
  await new Promise(resolve => designServer.listen(0, '127.0.0.1', resolve));
  t.after(() => designServer.close());
  const designPort = designServer.address().port;
  const designStatus = await fetch(`http://127.0.0.1:${designPort}/api/design-sources`).then(response => response.json());
  assert.equal(designStatus.sources[0].id, 'impeccable');
  const designScan = await fetch(`http://127.0.0.1:${designPort}/api/design-sources/scan`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  }).then(response => response.json());
  assert.equal(designScan.checkedAt, '2026-08-14T00:00:00.000Z');

  const usageServer = createServer({
    collectStatus: async () => ({ ok: true }),
    openaiUsageStatus: () => ({ ok: true, source: 'local-guard-ledger', groups: [] }),
    actionController: { list: () => [], preview: async () => ({}), execute: async () => ({}) }
  });
  await new Promise(resolve => usageServer.listen(0, '127.0.0.1', resolve));
  t.after(() => usageServer.close());
  const usagePort = usageServer.address().port;
  const usage = await fetch(`http://127.0.0.1:${usagePort}/api/openai-usage`).then(response => response.json());
  assert.equal(usage.source, 'local-guard-ledger');

  const catalog = await fetch(`http://127.0.0.1:${port}/api/catalog`).then(response => response.json());
  assert.ok(catalog.items.some(item => item.id === 'workspace-mcp'));

  const product = await fetch(`http://127.0.0.1:${port}/api/product`).then(response => response.json());
  assert.equal(product.name, 'Luminous Control Ledger');
  assert.equal(product.inventory.actionCount, 1);
  assert.ok(product.journeys.some(journey => journey.id === 'web-gpt'));

  const preview = await fetch(`http://127.0.0.1:${port}/api/actions/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'ocx.start', args: {} })
  });
  assert.equal(preview.status, 200);
  assert.deepEqual(calls[0], ['preview', 'ocx.start', {}]);

  const execute = await fetch(`http://127.0.0.1:${port}/api/actions/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmationToken: 'token' })
  });
  assert.equal(execute.status, 200);
  assert.deepEqual(calls[1], ['execute', 'token']);
});

test('concurrent dashboard status reads share one collection and reuse a short cache', async t => {
  let calls = 0;
  const server = createServer({
    collectStatus: async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 30));
      return { ok: true, schemaVersion: 1, calls };
    },
    statusCacheTtlMs: 1_000,
    actionController: { list: () => [], preview: async () => ({}), execute: async () => ({}) }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/api/status`;

  const first = await Promise.all([fetch(endpoint), fetch(endpoint), fetch(endpoint)]);
  await Promise.all(first.map(response => response.json()));
  await fetch(endpoint).then(response => response.json());

  assert.equal(calls, 1);
});

test('server exposes monitoring status and only enqueues confirmed durable upstream scans', async t => {
  const calls = [];
  const server = createServer({
    collectStatus: async () => ({ ok: true }),
    monitoringStatus: () => ({ ok: true, signal: { state: 'current' }, local: { launchAgents: { items: [] } } }),
    monitoringJobService: {
      status: () => ({ owner: 'durable-job-manager', queuedJobIds: [] }),
      preview: () => ({ requiresConfirmation: true, automaticApply: false }),
      enqueue: input => {
        calls.push(input);
        if (input.confirmed !== true) throw Object.assign(new Error('confirmation required'), { code: 'confirmation_required' });
        return { duplicate: false, job: { jobId: 'monitor-1', state: 'queued' } };
      }
    },
    actionController: { list: () => [], preview: async () => ({}), execute: async () => ({}) }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const before = await fetch(`http://127.0.0.1:${port}/api/monitoring`).then(response => response.json());
  assert.equal(before.signal.state, 'current');
  assert.equal(before.scheduler.owner, 'durable-job-manager');
  const denied = await fetch(`http://127.0.0.1:${port}/api/monitoring/upstream-refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(denied.status, 409);
  const response = await fetch(`http://127.0.0.1:${port}/api/monitoring/upstream-refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, requestId: 'manual-1', idempotencyKey: 'manual-1' })
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).job.state, 'queued');
  assert.deepEqual(calls.at(-1), { confirmed: true, requestId: 'manual-1', idempotencyKey: 'manual-1' });
});

test('server exposes knowledge, project, and local access APIs without executing external writes', async t => {
  const calls = [];
  const server = createServer({
    collectStatus: async () => ({ ok: true }),
    actionController: { list: () => [], preview: async () => ({}), execute: async () => ({}) },
    knowledgeReviewService: {
      status: () => ({ manualOnly: true, automaticApply: false, queuedJobIds: [] }),
      preview: input => ({ requiresConfirmation: true, sourceIds: input.sourceIds }),
      enqueue: input => { calls.push(['knowledge', input]); return { job: { jobId: 'knowledge-1', state: 'queued' } }; }
    },
    projectCatalogService: {
      status: () => ({ summary: { total: 60 }, priorityOutbox: { pendingSync: 0 } }),
      listPriorityOperations: () => ({ operations: [], externalWritePerformed: false }),
      previewPriority: input => ({ requiresConfirmation: true, confirmationToken: 'project-confirm', operation: input }),
      confirmPriority: token => { calls.push(['priority', token]); return { state: 'PENDING_SYNC', externalWritePerformed: false }; },
      refreshNotionSnapshot: snapshot => { calls.push(['snapshot', snapshot.version]); return { saved: true, externalWritePerformed: false }; },
      preparePrioritySync: input => { calls.push(['prepare', input.operationId]); return { request: input, externalWritePerformed: false }; },
      completePrioritySync: input => { calls.push(['complete', input.operationId]); return { operation: { state: 'APPLIED' }, externalWritePerformed: false }; },
      recordPrioritySyncFailure: input => { calls.push(['failure', input.operationId]); return { operation: { state: 'PENDING_SYNC' }, externalWritePerformed: false }; }
    },
    localAccessService: {
      status: () => ({ wholeHomeAlias: false, grants: [] }),
      previewGrant: input => ({ requiresConfirmation: true, confirmationToken: 'grant-confirm', grant: input }),
      confirmGrant: token => { calls.push(['grant', token]); return { ok: true, grant: { grantRef: 'grant-1' } }; },
      previewExcerpt: input => ({ requiresConfirmation: true, confirmationToken: 'excerpt-confirm', approval: input }),
      confirmExcerpt: token => { calls.push(['excerpt', token]); return { ok: true, approval: { approvalRef: 'approval-1' } }; }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const endpoint = pathname => `http://127.0.0.1:${port}${pathname}`;
  const post = (pathname, body) => fetch(endpoint(pathname), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await fetch(endpoint('/api/knowledge-review/status')).then(response => response.json())).manualOnly, true);
  assert.equal((await fetch(endpoint('/api/projects')).then(response => response.json())).summary.total, 60);
  assert.deepEqual((await fetch(endpoint('/api/projects/priority/outbox')).then(response => response.json())).operations, []);
  assert.equal((await fetch(endpoint('/api/local-access')).then(response => response.json())).wholeHomeAlias, false);
  assert.equal((await post('/api/knowledge-review/jobs', { confirmed: true, requestId: 'r', idempotencyKey: 'k' })).status, 202);
  assert.equal((await post('/api/projects/priority/confirm', { confirmationToken: 'project-confirm' })).status, 202);
  assert.equal((await post('/api/projects/notion-snapshot', { snapshot: { version: 'notion-v2', capturedAt: '2026-08-15T00:00:00.000Z', projects: [], ideas: [] } })).status, 200);
  assert.equal((await post('/api/projects/priority/sync/prepare', { operationId: 'priority-1', remoteVersion: 'notion-v1', workerId: 'notion' })).status, 200);
  assert.equal((await post('/api/projects/priority/sync/complete', { operationId: 'priority-1', snapshot: { version: 'notion-v2', capturedAt: '2026-08-15T00:00:00.000Z', projects: [], ideas: [] } })).status, 200);
  assert.equal((await post('/api/projects/priority/sync/failure', { operationId: 'priority-2', errorCode: 'transport_failed' })).status, 200);
  assert.equal((await post('/api/local-access/grants/confirm', { confirmationToken: 'grant-confirm' })).status, 201);
  assert.equal((await post('/api/local-access/excerpts/confirm', { confirmationToken: 'excerpt-confirm' })).status, 201);
  assert.deepEqual(calls.map(call => call[0]), ['knowledge', 'priority', 'snapshot', 'prepare', 'complete', 'failure', 'grant', 'excerpt']);

  const crossOrigin = await fetch(endpoint('/api/local-access/grants/preview'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://example.invalid' },
    body: JSON.stringify({ root: '/tmp' })
  });
  assert.equal(crossOrigin.status, 403);
});

test('server runs only allowlisted local diagnostic tasks', async t => {
  const calls = [];
  const server = createServer({
    collectStatus: async () => ({ ok: true }),
    actionController: { list: () => [], preview: async () => ({}), execute: async () => ({}) },
    runTask: async taskId => { calls.push(taskId); return { ok: true, id: taskId, result: {} }; }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/tasks/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'workspace.status' })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['workspace.status']);
});

test('server exposes guarded recovery handoff status, refresh, and Finder reveal', async t => {
  const calls = [];
  const recoveryHandoffService = {
    status: () => ({ ok: true, available: false }),
    content: () => ({ ok: true, available: true, documents: { markdown: '# current', json: '{}' } }),
    refresh: async () => { calls.push('refresh'); return { ok: true, available: true, documents: { markdown: '# safe', json: '{}' } }; },
    reveal: async () => { calls.push('reveal'); return { ok: true, revealed: true, path: '~/.ai-control-center/recovery/example.md' }; }
  };
  const server = createServer({
    collectStatus: async () => ({ ok: true }),
    actionController: { list: () => [], preview: async () => ({}), execute: async () => ({}) },
    recoveryHandoffService
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const endpoint = pathname => `http://127.0.0.1:${port}${pathname}`;
  const status = await fetch(endpoint('/api/recovery/handoff')).then(response => response.json());
  assert.equal(status.available, false);
  const content = await fetch(endpoint('/api/recovery/handoff/content')).then(response => response.json());
  assert.equal(content.documents.markdown, '# current');
  const refresh = await fetch(endpoint('/api/recovery/handoff/refresh'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(refresh.status, 201);
  assert.equal((await refresh.json()).documents.markdown, '# safe');
  const reveal = await fetch(endpoint('/api/recovery/handoff/reveal'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(reveal.status, 200);
  assert.deepEqual(calls, ['refresh', 'reveal']);

  const crossOrigin = await fetch(endpoint('/api/recovery/handoff/refresh'), {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.invalid' }, body: '{}'
  });
  assert.equal(crossOrigin.status, 403);
});

test('server returns completed diagnostic findings without treating them as a request failure', async t => {
  const server = createServer({
    collectStatus: async () => ({ ok: true }),
    actionController: { list: () => [], preview: async () => ({}), execute: async () => ({}) },
    runTask: async taskId => ({ ok: false, id: taskId, result: { attention: ['OCX 연결 확인 필요'] } })
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/tasks/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'workspace.status' })
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.ok, false);
  assert.deepEqual(result.result.attention, ['OCX 연결 확인 필요']);
});

test('dashboard preserves completed diagnostic findings for display', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'));
  assert.match(source, /postJson\('\/api\/tasks\/run', \{ taskId: item\.taskId \}, \{ acceptFindings: true \}\)/);
  assert.match(source, /data\.ok === false && !options\.acceptFindings/);
});

test('server opens only the named auth portal through the guarded endpoint', async t => {
  const calls = [];
  const server = createServer({
    collectStatus: async () => ({ ok: true }),
    actionController: { list: () => [], preview: async () => ({}), execute: async () => ({}) },
    openLocalApp: async appId => { calls.push(appId); return { ok: true, id: appId, url: 'https://login.example.test/' }; }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/apps/open`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId: 'auth-portal' })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['auth-portal']);
});

test('action endpoints reject form and cross-origin requests', async t => {
  const server = createServer({
    collectStatus: async () => ({ ok: true }),
    actionController: { list: () => [], preview: async () => ({ ok: true }), execute: async () => ({ ok: true }) }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/api/actions/preview`;

  const form = await fetch(endpoint, { method: 'POST', body: 'action=ocx.start' });
  assert.equal(form.status, 415);
  const crossOrigin = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://example.invalid' },
    body: JSON.stringify({ action: 'ocx.start' })
  });
  assert.equal(crossOrigin.status, 403);
});
