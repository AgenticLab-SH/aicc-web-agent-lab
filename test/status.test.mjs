import assert from 'node:assert/strict';
import test from 'node:test';
import { collectStatus } from '../src/status.mjs';

const webGptRescueStatus = async () => ({ ok: false, state: 'unprepared' });
const codexPluginStatus = async () => ({ id: 'codex-plugins', state: 'ready', detail: 'ok' });

test('collectStatus merges adapters into one stable schema', async () => {
  const status = await collectStatus({
    accountStatus: async () => ({ id: 'accounts', label: 'Accounts', state: 'ready', detail: 'ok' }),
    ocxAccountStatus: async () => ({ id: 'ocx-accounts', label: 'OCX accounts', state: 'ready', detail: 'ok' }),
    ocxStatus: async () => ({ id: 'ocx', label: 'OCX', state: 'offline', detail: 'off' }),
    webGptStatus: async () => ({ id: 'web-gpt', state: 'unavailable', optional: true }),
    webGptRescueStatus,
    codexRouteStatus: async () => ({ id: 'codex-routes', state: 'ready' }),
    authPortalStatus: async () => ({ id: 'auth-portal', state: 'unavailable', optional: true }),
    guidanceStatus: () => ({ id: 'guidance', label: 'Guidance', state: 'ready', detail: 'ok' }),
    codexPluginStatus,
    agentsStatus: () => ({ state: 'ready', message: 'ok', summary: {}, issues: [] }),
    workspaceMcpStatus: async () => ({ id: 'workspace-mcp', state: 'ready', detail: 'ok' }),
    jobManagerStatus: () => ({ id: 'job-manager', state: 'ready', detail: 'ok' }),
    browserBrokerStatus: () => ({ id: 'browser-broker', state: 'ready', detail: 'ok' }),
    extensionRegistryStatus: () => ({ id: 'extensions', state: 'ready', detail: 'ok' }),
    compatibilityStatus: () => ({ id: 'compatibility-lab', state: 'ready', detail: 'ok' }),
    privateHomeStatus: () => ({ ok: true, presentMovableFiles: 1 }),
    localToolStatus: async () => [{ id: 'gpt-desktop', label: 'GPT Desktop', state: 'ready', detail: 'ok' }]
  });
  assert.equal(status.ok, true);
  assert.equal(status.schemaVersion, 1);
  assert.deepEqual(status.summary, { ready: 13, total: 14, attention: 1 });
  assert.equal(status.components.find(component => component.id === 'extensions').state, 'ready');
  assert.equal(status.mode, 'local-control');
  assert.equal(status.stateRoots.length, 7);
});

test('unavailable optional integrations do not participate in the health summary', async () => {
  const status = await collectStatus({
    accountStatus: async () => ({ id: 'accounts', state: 'ready' }),
    ocxAccountStatus: async () => ({ id: 'ocx-accounts', state: 'ready' }),
    ocxStatus: async () => ({ id: 'ocx', state: 'ready' }),
    webGptStatus: async () => ({ id: 'web-gpt', state: 'unavailable', optional: true }),
    webGptRescueStatus,
    codexRouteStatus: async () => ({ id: 'codex-routes', state: 'ready' }),
    authPortalStatus: async () => ({ id: 'auth-portal', state: 'unavailable', optional: true }),
    guidanceStatus: () => ({ id: 'guidance', state: 'ready' }),
    codexPluginStatus,
    agentsStatus: () => ({ state: 'ready', message: 'ok', summary: {}, issues: [] }),
    workspaceMcpStatus: async () => ({ id: 'workspace-mcp', state: 'ready' }),
    jobManagerStatus: () => ({ id: 'job-manager', state: 'ready' }),
    browserBrokerStatus: () => ({ id: 'browser-broker', state: 'ready' }),
    extensionRegistryStatus: () => ({ id: 'extensions', state: 'ready' }),
    compatibilityStatus: () => ({ id: 'compatibility-lab', state: 'ready' }),
    privateHomeStatus: () => ({ ok: true, presentMovableFiles: 1 }),
    localToolStatus: async () => []
  });
  assert.deepEqual(status.summary, { ready: 13, total: 13, attention: 0 });
});

test('guidance drift participates in the health summary', async () => {
  const status = await collectStatus({
    accountStatus: async () => ({ id: 'accounts', state: 'ready' }),
    ocxAccountStatus: async () => ({ id: 'ocx-accounts', state: 'ready' }),
    ocxStatus: async () => ({ id: 'ocx', state: 'ready' }),
    webGptStatus: async () => ({ id: 'web-gpt', state: 'unavailable', optional: true }),
    webGptRescueStatus,
    codexRouteStatus: async () => ({ id: 'codex-routes', state: 'ready' }),
    authPortalStatus: async () => ({ id: 'auth-portal', state: 'unavailable', optional: true }),
    guidanceStatus: () => ({ id: 'guidance', state: 'attention', failed: 1 }),
    codexPluginStatus,
    agentsStatus: () => ({ state: 'ready', message: 'ok', summary: {}, issues: [] }),
    workspaceMcpStatus: async () => ({ id: 'workspace-mcp', state: 'ready' }),
    jobManagerStatus: () => ({ id: 'job-manager', state: 'ready' }),
    browserBrokerStatus: () => ({ id: 'browser-broker', state: 'ready' }),
    extensionRegistryStatus: () => ({ id: 'extensions', state: 'ready' }),
    compatibilityStatus: () => ({ id: 'compatibility-lab', state: 'ready' }),
    privateHomeStatus: () => ({ ok: true, presentMovableFiles: 1 }),
    localToolStatus: async () => []
  });
  assert.deepEqual(status.summary, { ready: 12, total: 13, attention: 1 });
});

test('one failed adapter is isolated from the remaining dashboard', async () => {
  const status = await collectStatus({
    accountStatus: async () => { throw new Error('fixture failure'); },
    ocxAccountStatus: async () => ({ id: 'ocx-accounts', state: 'ready' }),
    ocxStatus: async () => ({ id: 'ocx', state: 'ready' }),
    webGptStatus: async () => ({ id: 'web-gpt', state: 'ready' }),
    webGptRescueStatus,
    codexRouteStatus: async () => ({ id: 'codex-routes', state: 'ready' }),
    authPortalStatus: async () => ({ id: 'auth-portal', state: 'unavailable', optional: true }),
    guidanceStatus: () => ({ id: 'guidance', state: 'ready' }),
    codexPluginStatus,
    agentsStatus: () => ({ state: 'ready', message: 'ok', summary: {}, issues: [] }),
    workspaceMcpStatus: async () => ({ id: 'workspace-mcp', state: 'ready' }),
    jobManagerStatus: () => ({ id: 'job-manager', state: 'ready' }),
    browserBrokerStatus: () => ({ id: 'browser-broker', state: 'ready' }),
    extensionRegistryStatus: () => ({ id: 'extensions', state: 'ready' }),
    privateHomeStatus: () => ({ ok: true, presentMovableFiles: 1 }),
    localToolStatus: async () => []
  });
  const accounts = status.components.find(component => component.id === 'accounts');
  assert.equal(status.ok, true);
  assert.equal(accounts.state, 'attention');
  assert.equal(accounts.isolatedFailure, true);
  assert.equal(status.components.find(component => component.id === 'ocx').state, 'ready');
});

test('a slow status probe fails closed within its component deadline', async () => {
  const never = async () => new Promise(() => {});
  const status = await collectStatus({
    componentTimeoutMs: 25,
    accountStatus: never,
    ocxAccountStatus: async () => ({ id: 'ocx-accounts', state: 'ready' }),
    ocxStatus: async () => ({ id: 'ocx', state: 'ready' }),
    webGptStatus: async () => ({ id: 'web-gpt', state: 'unavailable', optional: true }),
    webGptRescueStatus,
    codexRouteStatus: async () => ({ id: 'codex-routes', state: 'ready' }),
    authPortalStatus: async () => ({ id: 'auth-portal', state: 'unavailable', optional: true }),
    guidanceStatus: () => ({ id: 'guidance', state: 'ready' }),
    codexPluginStatus,
    agentsStatus: () => ({ state: 'ready', message: 'ok', summary: {}, issues: [] }),
    workspaceMcpStatus: async () => ({ id: 'workspace-mcp', state: 'ready' }),
    jobManagerStatus: () => ({ id: 'job-manager', state: 'ready' }),
    browserBrokerStatus: () => ({ id: 'browser-broker', state: 'ready' }),
    extensionRegistryStatus: () => ({ id: 'extensions', state: 'ready' }),
    compatibilityStatus: () => ({ id: 'compatibility-lab', state: 'ready' }),
    privateHomeStatus: () => ({ ok: true, presentMovableFiles: 1 }),
    localToolStatus: async () => []
  });
  const accounts = status.components.find(component => component.id === 'accounts');
  assert.equal(accounts.isolatedFailure, true);
  assert.equal(accounts.timedOut, true);
  assert.match(accounts.detail, /초과/);
});

test('job database failure is isolated from Web GPT, Native routes, OCX, and Workspace MCP status', async () => {
  const status = await collectStatus({
    accountStatus: async () => ({ id: 'accounts', state: 'ready' }),
    ocxAccountStatus: async () => ({ id: 'ocx-accounts', state: 'ready' }),
    ocxStatus: async () => ({ id: 'ocx', state: 'ready' }),
    webGptStatus: async () => ({ id: 'web-gpt', state: 'ready' }),
    webGptRescueStatus,
    codexRouteStatus: async () => ({ id: 'codex-routes', state: 'ready' }),
    authPortalStatus: async () => ({ id: 'auth-portal', state: 'unavailable', optional: true }),
    guidanceStatus: () => ({ id: 'guidance', state: 'ready' }),
    codexPluginStatus,
    agentsStatus: () => ({ state: 'ready', message: 'ok', summary: {}, issues: [] }),
    workspaceMcpStatus: async () => ({ id: 'workspace-mcp', state: 'ready' }),
    jobManagerStatus: () => { throw new Error('fixture job DB failure'); },
    browserBrokerStatus: () => ({ id: 'browser-broker', state: 'ready' }),
    extensionRegistryStatus: () => ({ id: 'extensions', state: 'ready' }),
    privateHomeStatus: () => ({ ok: true, presentMovableFiles: 1 }),
    localToolStatus: async () => []
  });
  assert.equal(status.components.find(component => component.id === 'job-manager').isolatedFailure, true);
  for (const id of ['ocx', 'web-gpt', 'codex-routes', 'workspace-mcp']) assert.equal(status.components.find(component => component.id === id).state, 'ready');
});
