import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatGptArchiveCatalogStore, normalizeChatGptArchiveCatalog } from '../src/assets/chatgpt-catalog.mjs';

function item(overrides = {}) {
  return {
    schemaVersion: 1,
    accountAlias: 'account-one',
    workspace: 'workspace-one',
    kind: 'conversation',
    remoteId: 'conversation-one',
    title: '설계 검토',
    shortDescription: '일반 대화 · 메시지 4개(사용자 2, 응답 2)',
    status: 'captured',
    projectId: null,
    projectName: null,
    createdAt: '2026-08-15T00:00:00Z',
    updatedAt: '2026-08-15T01:00:00Z',
    messageCount: 4,
    userMessageCount: 2,
    assistantMessageCount: 2,
    conversationCount: null,
    fileCount: null,
    toolCount: null,
    sourceAccountAlias: null,
    ...overrides
  };
}

test('ChatGPT archive catalog imports only summary metadata and supports bounded query', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-chatgpt-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ChatGptArchiveCatalogStore({ root, now: () => Date.parse('2026-08-16T00:00:00Z') });
  const imported = store.import({ schemaVersion: 1, generatedAt: '2026-08-15T12:00:00Z', items: [
    item(),
    item({ remoteId: 'conversation-unavailable', title: '원문 부재', shortDescription: '목록 메타데이터 보존 · 원격 부재 HOLD', status: 'unavailable', messageCount: null, userMessageCount: null, assistantMessageCount: null }),
    item({ kind: 'chatgpt_project', remoteId: 'project-one', title: '자동화 프로젝트', shortDescription: 'ChatGPT Project · 대화 8개 · 파일 2개', status: 'observed', projectId: 'project-one', projectName: '자동화 프로젝트', messageCount: null, userMessageCount: null, assistantMessageCount: null, conversationCount: 8, fileCount: 2 })
  ] });
  assert.equal(imported.summary.total, 3);
  assert.equal(imported.summary.unavailable, 1);
  assert.deepEqual(imported.accounts, ['account-one']);
  assert.equal(store.query({ query: '파일 2개', limit: 1 }).items[0].remoteId, 'project-one');
  assert.deepEqual(store.assets().map(asset => asset.assetId), ['chatgpt-project:project-one']);
  assert.equal(store.assets()[0].metadata.shortDescription, 'ChatGPT Project · 대화 8개 · 파일 2개');
  assert.equal(store.status().available, true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
});

test('ChatGPT archive catalog rejects credentials and raw conversation content', () => {
  assert.throws(() => normalizeChatGptArchiveCatalog({ schemaVersion: 1, items: [{ ...item(), token: 'secret' }] }), error => error.code === 'private_content_denied');
  assert.throws(() => normalizeChatGptArchiveCatalog({ schemaVersion: 1, items: [{ ...item(), prompt: 'private prompt' }] }), error => error.code === 'private_content_denied');
  assert.throws(() => normalizeChatGptArchiveCatalog({ schemaVersion: 1, items: [item(), item()] }), error => error.code === 'catalog_duplicate');
});
