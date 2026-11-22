import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { workspaceToolSnapshot } from '../components/workspace-mcp/tool-manifest.mjs';
import { recordWorkspacePublication, workspacePublicationStatus } from '../src/workspace-publish.mjs';

function accountCanary(manifest, accountAlias, overrides = {}) {
  return {
    accountAlias,
    workspaceAlias: accountAlias === 'account3' ? 'personal' : 'pposik',
    conversationUrl: `https://chat.example.invalid/c/demo${accountAlias.padEnd(12, '0')}`,
    appId: 'asdk_app_abc123',
    appVersionId: 'asdk_app_v_def456',
    manifestHash: manifest.hash,
    status: 'pass',
    toolResults: manifest.tools.map(tool => ({ name: tool.name, status: 'pass' })),
    rollbackVerifiedTools: manifest.tools.filter(tool => tool.mode === 'write').map(tool => tool.name),
    verifiedAt: '2026-08-18T00:00:00.000Z',
    ...overrides
  };
}

test('publication hash covers the exact Workspace input contracts', () => {
  const manifest = workspaceToolSnapshot({ platform: 'darwin' });
  const open = manifest.tools.find(tool => tool.name === 'aicc_workspace_open');
  const info = manifest.tools.find(tool => tool.name === 'aicc_workspace_info');
  assert.equal(manifest.schemaVersion, 4);
  assert.equal(manifest.surfaceProfile, 'business-full');
  assert.ok(open.inputSchema.required.includes('correlation_id'));
  assert.equal(info.inputSchema.properties.lease.pattern, '^remote_cap_[a-f0-9]{64}$');
});

test('personal publication is a separate read-fetch-only 18-tool surface', t => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-publish-personal-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const options = { stateRoot, surfaceProfile: 'personal-read-fetch' };
  const before = workspacePublicationStatus(options);
  assert.equal(before.manifest.toolCount, 18);
  assert.equal(before.manifest.readToolCount, 18);
  assert.equal(before.manifest.writeToolCount, 0);
  assert.equal(before.manifest.tools.find(tool => tool.name === 'aicc_workspace_open').mode, 'read');
  assert.equal(before.manifest.tools.some(tool => tool.name === 'aicc_workspace_exec'), false);
  assert.match(before.stateFile.replaceAll('\\', '/'), /workspace-mcp-personal-read-fetch\/publish-state\.json$/);
  const recorded = recordWorkspacePublication({
    ...options,
    appName: 'AICC Workspace Personal Read Fetch',
    appId: 'asdk_app_personal123',
    appVersionId: 'asdk_app_v_personal456',
    workspaceName: 'account3 personal',
    tunnelId: 'tunnel_personal123',
    publisherAccountAlias: 'account3',
    requiredAccountAliases: ['account3'],
    accountCanaries: [accountCanary(before.manifest, 'account3', {
      appId: 'asdk_app_personal123',
      appVersionId: 'asdk_app_v_personal456'
    })],
    discoverability: 'invite_only',
    riskReviewSections: [],
    riskReviewCheckboxes: [],
    riskReviewStatus: 'pass'
  });
  assert.equal(recorded.needsPublish, false);
  assert.equal(recorded.published.surfaceProfile, 'personal-read-fetch');
  assert.deepEqual(recorded.published.accountCanaries[0].rollbackVerifiedTools, []);
  assert.equal(workspacePublicationStatus({ stateRoot }).published, null);
});

test('publication snapshot changes only after an explicit verified record', t => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-publish-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const before = workspacePublicationStatus({ stateRoot, platform: 'darwin' });
  assert.equal(before.manifest.toolCount, 22);
  assert.equal(before.manifest.readToolCount, 17);
  assert.equal(before.manifest.writeToolCount, 5);
  assert.equal(before.needsPublish, true);
  assert.equal(before.manageUrl, 'https://chatgpt.com/plugins');
  const recorded = recordWorkspacePublication({
    stateRoot,
    platform: 'darwin',
    appName: 'AICC Workspace',
    appId: 'asdk_app_abc123',
    appVersionId: 'asdk_app_v_def456',
    workspaceName: 'demo-owner Business',
    tunnelId: 'tunnel_abc123',
    publisherAccountAlias: 'account2',
    requiredAccountAliases: ['account1', 'account2'],
    accountCanaries: [accountCanary(before.manifest, 'account1'), accountCanary(before.manifest, 'account2')],
    discoverability: 'workspace_directory',
    riskReviewSections: ['무단 데이터 접근', '악성 앱'],
    riskReviewCheckboxes: ['이해합니다', '이 앱을 신뢰합니다', '민감한 데이터를 요청하지 않음을 확인했습니다'],
    riskReviewStatus: 'pass',
    replacementOfAppId: 'asdk_app_old123'
  });
  assert.equal(recorded.needsPublish, false);
  assert.equal(recorded.published.appName, 'AICC Workspace');
  assert.equal(recorded.published.appId, 'asdk_app_abc123');
  assert.equal(recorded.published.workspaceName, 'demo-owner Business');
  assert.deepEqual(recorded.published.requiredAccountAliases, ['account1', 'account2']);
  assert.equal(recorded.published.accountCanaries.length, 2);
  assert.equal(recorded.published.accountCanaries[0].toolResults.length, 22);
  assert.equal(recorded.published.riskReviewSections.length, 2);
  if (process.platform !== 'win32') assert.equal(fs.statSync(recorded.stateFile).mode & 0o777, 0o600);
});

test('publication record fails closed without full replacement and canary evidence', t => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-publish-evidence-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  assert.throws(
    () => recordWorkspacePublication({ stateRoot, platform: 'darwin', appName: 'AICC Workspace' }),
    /app ID/
  );
  assert.throws(
    () => recordWorkspacePublication({
      stateRoot,
      platform: 'darwin',
      appName: 'AICC Workspace',
      appId: 'asdk_app_abc123',
      appVersionId: 'asdk_app_v_def456',
      workspaceName: 'demo-owner Business',
      tunnelId: 'tunnel_abc123',
      publisherAccountAlias: 'account2',
      requiredAccountAliases: ['account2'],
      accountCanaries: [accountCanary(workspacePublicationStatus({ stateRoot, platform: 'darwin' }).manifest, 'account2', {
        toolResults: [{ name: 'aicc_workspace_list', status: 'pass' }]
      })],
      discoverability: 'workspace_directory',
      riskReviewSections: ['악성 앱'],
      riskReviewCheckboxes: ['신뢰합니다'],
      riskReviewStatus: 'pass'
    }),
    /22개 도구/
  );
  const manifest = workspacePublicationStatus({ stateRoot, platform: 'darwin' }).manifest;
  assert.throws(() => recordWorkspacePublication({
    stateRoot,
    platform: 'darwin',
    appName: 'AICC Workspace',
    appId: 'asdk_app_abc123',
    appVersionId: 'asdk_app_v_def456',
    workspaceName: 'demo-owner Business',
    tunnelId: 'tunnel_abc123',
    publisherAccountAlias: 'account2',
    requiredAccountAliases: ['account2'],
    accountCanaries: [accountCanary(manifest, 'account2')],
    discoverability: 'workspace_directory',
    riskReviewSections: [],
    riskReviewCheckboxes: [],
    riskReviewStatus: 'pass'
  }), /잠재적 위험 검토/);
  assert.throws(() => recordWorkspacePublication({
    stateRoot,
    platform: 'darwin',
    appName: 'AICC Workspace',
    appId: 'asdk_app_abc123',
    appVersionId: 'asdk_app_v_def456',
    workspaceName: 'demo-owner Business',
    tunnelId: 'tunnel_abc123',
    publisherAccountAlias: 'account2',
    requiredAccountAliases: ['account1', 'account2', 'account3'],
    accountCanaries: [accountCanary(manifest, 'account1'), accountCanary(manifest, 'account2')],
    discoverability: 'workspace_directory',
    riskReviewSections: ['악성 앱'],
    riskReviewCheckboxes: ['신뢰합니다'],
    riskReviewStatus: 'pass'
  }), /missing=account3/);
});

test('a legacy name-only publication record is stale after an input contract change', t => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-publish-legacy-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const stateFile = path.join(stateRoot, 'workspace-mcp', 'publish-state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({
    schemaVersion: 1,
    appName: 'AICC Workspace',
    toolCount: 13,
    manifestHash: 'legacy-name-title-mode-only-hash',
    verifiedAt: '2026-08-06T00:00:00.000Z'
  })}\n`);
  assert.equal(workspacePublicationStatus({ stateRoot, platform: 'darwin' }).needsPublish, true);
});

test('Windows publication omits command process tools and reports network closed', () => {
  const status = workspacePublicationStatus({ platform: 'win32' });
  assert.deepEqual(status.capabilities, { commands: false, network: false });
  assert.equal(status.manifest.toolCount, 19);
  assert.equal(status.manifest.readToolCount, 17);
  assert.equal(status.manifest.writeToolCount, 2);
  assert.equal(status.manifest.tools.some(tool => tool.name === 'aicc_workspace_apply_patch'), true);
  for (const name of ['aicc_workspace_exec', 'aicc_workspace_write_stdin', 'aicc_workspace_process_stop']) {
    assert.equal(status.manifest.tools.some(tool => tool.name === name), false);
  }
});

test('Linux publication also fails closed without an injected sandbox adapter', () => {
  const status = workspacePublicationStatus({ platform: 'linux' });
  assert.deepEqual(status.capabilities, { commands: false, network: false });
  assert.equal(status.manifest.toolCount, 19);
  assert.equal(status.manifest.tools.some(tool => tool.name === 'aicc_workspace_apply_patch'), true);
  assert.equal(status.manifest.tools.some(tool => tool.name === 'aicc_workspace_exec'), false);
});

test('an explicit verified sandbox capability restores the future full Business manifest', () => {
  const manifest = workspaceToolSnapshot({ platform: 'win32', commandSandboxAvailable: true });
  assert.deepEqual(manifest.capabilities, { commands: true, network: true });
  assert.equal(manifest.toolCount, 22);
  assert.equal(manifest.writeToolCount, 5);
});

test('Windows publication can match the configured owner-unrestricted runtime', () => {
  const status = workspacePublicationStatus({ platform: 'win32', commandSandboxAvailable: true });
  assert.deepEqual(status.capabilities, { commands: true, network: true });
  assert.equal(status.manifest.toolCount, 22);
  assert.equal(status.manifest.readToolCount, 17);
  assert.equal(status.manifest.writeToolCount, 5);
  assert.equal(status.manifest.tools.some(tool => tool.name === 'aicc_workspace_exec'), true);
});
