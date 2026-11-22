import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAssetInventory, collectSkillAssets, normalizeAssetRecord, pluginAsset, projectAsset } from '../src/assets/asset-registry.mjs';
import { ChatGptAssetImportStore, normalizeChatGptAssetExport } from '../src/assets/chatgpt-import.mjs';
import { AssetOperationJournal } from '../src/assets/operation-journal.mjs';
import { AssetControlService } from '../src/assets/service.mjs';
import { assetAuditTick } from '../src/assets/scheduled-audit.mjs';

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('asset registry produces stable normalized project, skill, plugin, and ChatGPT records', t => {
  const root = temporary(t, 'aicc-assets-');
  const skillRoot = path.join(root, 'skills');
  fs.mkdirSync(path.join(skillRoot, 'sample-skill'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'sample-skill', 'SKILL.md'), '# sample\n');
  const observedAt = '2026-08-16T00:00:00.000Z';
  const skills = collectSkillAssets({ skillRoot, observedAt });
  const projects = [projectAsset({ id: 'sample', title: 'Sample', canonicalRoot: path.join(root, 'sample'), lifecycle: 'building', priority: { rank: 2 }, sourceState: 'DRIFT' }, observedAt)];
  assert.equal(projectAsset({ id: 'without-priority', title: 'No Priority', priority: null }, observedAt).priority, null);
  const plugins = [pluginAsset({ id: 'sample-plugin', owner: 'AICC', distribution: 'public', source: { path: 'plugins/sample', revision: 'abc', version: '1.0.0' } }, observedAt)];
  const chatgpt = normalizeChatGptAssetExport({ verifiedAt: observedAt, workspace: 'Business', assets: [{ kind: 'PROJECT', name: 'Remote', remoteId: 'g-p-remote', status: 'IN_SYNC_VISIBLE_UI' }] }).assets;
  const inventory = buildAssetInventory({ projects, skills, plugins, chatgpt, generatedAt: observedAt });
  assert.deepEqual(inventory.assets.map(item => item.assetId), ['chatgpt-project:g-p-remote', 'plugin:sample-plugin', 'project:sample', 'skill:sample-skill']);
  assert.equal(inventory.summary.total, 4);
  assert.equal(inventory.assets.find(item => item.assetId === 'project:sample').syncState, 'DRIFT');
  assert.throws(() => normalizeAssetRecord({ assetId: 'project:bad', assetKind: 'project', displayName: 'bad', canonicalOwner: 'x', adapterId: 'x', token: 'secret' }), error => error.code === 'secret_field_denied');
});

test('ChatGPT imports omit private backup paths and keep owner state private', t => {
  const root = temporary(t, 'aicc-chatgpt-import-');
  const store = new ChatGptAssetImportStore({ root, now: () => Date.parse('2026-08-16T01:00:00Z') });
  const result = store.import({
    verifiedAt: '2026-08-14T08:12:40Z', workspace: 'Business', assets: [
      { kind: 'PROJECT_SOURCE_UPDATE', name: 'Project', remoteId: 'g-p-one', status: 'IN_SYNC_ADDITIVE', prechangeBackup: '/private/path' },
      { kind: 'HISTORICAL_REMOTE_IDS', name: 'Old GPT', remoteIds: ['g-old-a', 'g-old-b'], status: 'REMOTE_ABSENT_RETIRED_REFERENCE' }
    ]
  });
  assert.equal(result.imported, 3);
  const stored = store.read();
  assert.equal(stored.assets.filter(item => item.lifecycle === 'retired').length, 2);
  assert.ok(stored.assets.filter(item => item.lifecycle === 'retired').every(item => item.metadata.nameObserved === true));
  assert.doesNotMatch(JSON.stringify(stored), /private\/path|prechangeBackup/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
});

test('asset operation journal is confirmation-gated, single-writer, idempotent, and fail-closed', t => {
  const root = temporary(t, 'aicc-asset-ops-');
  let now = Date.parse('2026-08-16T00:00:00Z');
  const journal = new AssetOperationJournal({ root, now: () => now });
  const input = { assetId: 'custom-gpt:g-one', action: 'update', adapterId: 'chatgpt-visible-ui-v1', expectedFingerprint: 'a'.repeat(64), patch: { instructionsHash: 'b'.repeat(64) }, rollbackRef: 'owner://backup/one' };
  const preview = journal.preview(input);
  const confirmed = journal.confirm(preview.confirmationToken);
  assert.equal(confirmed.operation.state, 'APPROVED');
  assert.throws(() => journal.confirm(preview.confirmationToken), error => error.code === 'confirmation_invalid');
  const prepared = journal.prepare(confirmed.operation.operationId, { workerId: 'worker-1', observedFingerprint: 'a'.repeat(64) });
  assert.equal(prepared.operation.state, 'APPLYING');
  assert.throws(() => journal.preview({ ...input, action: 'delete' }), error => error.code === 'hard_delete_excluded');
  const completed = journal.complete(confirmed.operation.operationId, { workerId: 'worker-1', verifiedFingerprint: 'c'.repeat(64) });
  assert.equal(completed.operation.state, 'APPLIED');
  assert.equal(journal.status().activeWriters, 0);
  now += 1;
});

test('asset service reuses project catalog and extension registry without a second source of truth', t => {
  const root = temporary(t, 'aicc-asset-service-');
  const skillRoot = path.join(root, 'skills');
  fs.mkdirSync(path.join(skillRoot, 'only-skill'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'only-skill', 'SKILL.md'), '# only\n');
  const service = new AssetControlService({
    root: path.join(root, 'state'), skillRoot, now: () => Date.parse('2026-08-16T00:00:00Z'),
    projectService: { catalog: () => ({ projects: [{ id: 'only-project', title: 'Only', canonicalRoot: path.join(root, 'project'), sourceState: 'LOCAL_ONLY' }] }) },
    extensionRegistry: { load: () => ({ extensions: [] }) }
  });
  assert.deepEqual(service.inventory().assets.map(item => item.assetId), ['project:only-project', 'skill:only-skill']);
  const notionSnapshot = { schemaVersion: 1, version: `notion-assets-${'a'.repeat(64)}`, capturedAt: '2026-08-16T00:00:00Z', assets: [] };
  assert.equal(service.saveNotionAssetSnapshot(notionSnapshot).saved, true);
  assert.equal(service.status().notionAssetSource.available, true);
  const first = assetAuditTick({ service, stateRoot: root, now: () => Date.parse('2026-08-16T00:00:00Z') });
  const second = assetAuditTick({ service, stateRoot: root, now: () => Date.parse('2026-08-16T01:00:00Z') });
  assert.equal(first.skipped, false);
  assert.deepEqual(second, { skipped: true, reason: 'not_due', nextAuditAt: first.nextAuditAt, externalWritePerformed: false });
});

test('archive-discovered Projects and GPTs enter the asset inventory while visible UI evidence wins duplicates', t => {
  const root = temporary(t, 'aicc-asset-archive-merge-');
  const service = new AssetControlService({
    root: path.join(root, 'state'), skillRoot: path.join(root, 'missing-skills'), now: () => Date.parse('2026-08-16T00:00:00Z'),
    projectService: { catalog: () => ({ projects: [] }) },
    extensionRegistry: { load: () => ({ extensions: [] }) }
  });
  service.importChatGptArchiveCatalog({ schemaVersion: 1, generatedAt: '2026-08-15T00:00:00Z', items: [{
    schemaVersion: 1, accountAlias: 'one', workspace: 'space', kind: 'chatgpt_project', remoteId: 'g-p-one', title: 'Archive name', shortDescription: 'ChatGPT Project · 대화 3개 · 파일 1개', status: 'observed', projectId: 'g-p-one', projectName: 'Archive name', createdAt: null, updatedAt: '2026-08-15T00:00:00Z', messageCount: null, userMessageCount: null, assistantMessageCount: null, conversationCount: 3, fileCount: 1, toolCount: null, sourceAccountAlias: null
  }, {
    schemaVersion: 1, accountAlias: 'one', workspace: 'space', kind: 'custom_gpt', remoteId: 'g-one', title: 'Archive GPT', shortDescription: 'Custom GPT · 지식 파일 0개 · 도구 2개', status: 'observed', projectId: null, projectName: null, createdAt: null, updatedAt: '2026-08-15T00:00:00Z', messageCount: null, userMessageCount: null, assistantMessageCount: null, conversationCount: null, fileCount: 0, toolCount: 2, sourceAccountAlias: null
  }] });
  assert.deepEqual(service.inventory().assets.map(asset => asset.assetId), ['chatgpt-project:g-p-one', 'custom-gpt:g-one']);
  service.importChatGptSnapshot({ verifiedAt: '2026-08-16T00:00:00Z', workspace: 'space', assets: [{ kind: 'PROJECT', remoteId: 'g-p-one', name: 'Visible name', status: 'IN_SYNC_VISIBLE_UI' }] });
  const inventory = service.inventory();
  assert.equal(inventory.assets.length, 2);
  assert.equal(inventory.assets.find(asset => asset.assetId === 'chatgpt-project:g-p-one').displayName, 'Visible name');
  assert.equal(inventory.assets.find(asset => asset.assetId === 'chatgpt-project:g-p-one').adapterId, 'chatgpt-visible-ui-v1');
});
