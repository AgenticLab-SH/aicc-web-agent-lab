import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PendingWorkInbox } from '../src/control-plane/pending-work.mjs';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-pending-'));
  for (const name of ['inbox', 'archive']) fs.mkdirSync(path.join(root, name));
  const inbox = new PendingWorkInbox(path.join(root, 'inbox'), { archiveRoot: path.join(root, 'archive') });
  const request = { id: 'request-001', title: '기존 작업 인수', priority: 'P1',
    origin: { displayName: '테스트 지피티', conversationUrl: 'https://chat.example.invalid/c/demo', identityEvidence: 'fixture-only' },
    projectRoot: root, objective: '기존 결과를 정본에 합친다.', nextAction: '원 담당자가 결과를 인수한다.' };
  return { root, inbox, request };
}
test('duplicate stays one document, conflicting bytes refused; legacy preserved; priorities sorted', () => {
  const { root, inbox, request } = setup();
  inbox.register(request); assert.equal(inbox.register(request).duplicate, true);
  assert.throws(() => inbox.register({ ...request, objective: 'different' }), /conflict/);
  inbox.register({ ...request, id: 'request-002', priority: 'P0' });
  fs.writeFileSync(path.join(root, 'inbox', 'old-note.md'), '# preserved');
  assert.equal(inbox.list().items[0].id, 'request-002');
  assert.equal(inbox.list().legacy.length, 1); assert.equal(inbox.list().automaticDispatch, false);
});
test('CAS, exact owner and canonical proof required before non-destructive archive', () => {
  const { root, inbox, request } = setup();
  let row = inbox.register(request);
  assert.throws(() => inbox.transition(row.id, { action: 'claim', expectedSha256: '0'.repeat(64), owner: 'controller' }), /revision_changed/);
  row = inbox.transition(row.id, { action: 'claim', expectedSha256: row.sha256, owner: 'controller' });
  assert.throws(() => inbox.transition(row.id, { action: 'merge', expectedSha256: row.sha256, owner: 'foreign' }), /different_pending_owner/);
  const canonicalPath = path.join(root, 'PROJECT.md'); fs.writeFileSync(canonicalPath, 'accepted request-001');
  const canonicalSha256 = crypto.createHash('sha256').update(fs.readFileSync(canonicalPath)).digest('hex');
  row = inbox.transition(row.id, { action: 'merge', expectedSha256: row.sha256, owner: 'controller', canonicalPath, canonicalSha256 });
  fs.appendFileSync(canonicalPath, ' changed');
  assert.throws(() => inbox.transition(row.id, { action: 'archive', expectedSha256: row.sha256, owner: 'controller' }), /canonical_evidence_changed/);
  fs.writeFileSync(canonicalPath, 'accepted request-001');
  const result = inbox.transition(row.id, { action: 'archive', expectedSha256: row.sha256, owner: 'controller' });
  assert.equal(result.deleted, false); assert.equal(fs.existsSync(result.path), true); assert.equal(inbox.list().items.length, 0);
});
test('path escape, unknown name, external URLs and premature completion refused', () => {
  const { inbox, request } = setup();
  assert.throws(() => inbox.register({ ...request, id: '../escape' }), /invalid_request_id/);
  assert.throws(() => inbox.register({ ...request, origin: { ...request.origin, displayName: '' } }), /invalid_origin_name/);
  assert.throws(() => inbox.register({ ...request, origin: { ...request.origin, conversationUrl: 'https://example.com/' } }), /exact_chatgpt/);
  const row = inbox.register(request);
  assert.throws(() => inbox.transition(row.id, { action: 'archive', expectedSha256: row.sha256, owner: 'controller' }), /invalid_pending_transition/);
});
