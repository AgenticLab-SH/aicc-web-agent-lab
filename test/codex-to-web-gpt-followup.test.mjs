import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { enqueueCodexCompletionToWebGpt } from '../src/codex-to-web-gpt-followup.mjs';

const SESSION = '01a12750-04a7-7b23-87e8-6ccc4ff8829b';
const CHAT = 'https://chat.example.invalid/c/demo';
const WATCH = 'watch_12345678';
const OWNER = 'task-origin-20261011';
const OPERATION = 'aicc.codex-terminal-0001';
const REQUEST = 'aicc-codex-web-reply-0001';

function fixture(t, changes = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-reverse-followup-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resultFile = path.join(root, 'result.json');
  let doc = {
    operation: OPERATION,
    codexTaskId: SESSION,
    projectRoot: root,
    status: 'PASS',
    userSecret: 'TOP-SECRET-DO-NOT-FORWARD',
    ...changes
  };
  const bytes = JSON.stringify(doc);
  fs.writeFileSync(resultFile, bytes, { mode: 0o600 });
  const expectedResultSha256 = createHash('sha256').update(bytes).digest('hex');
  const options = {
    watchId: WATCH,
    originTaskId: OWNER,
    conversationUrl: CHAT,
    codexSessionId: SESSION,
    operationId: OPERATION,
    requestId: REQUEST,
    resultFile,
    expectedResultSha256,
    expectedProjectRoot: root
  };
  const watch = {
    id: WATCH, ownerTaskId: OWNER, surface: 'chrome-extension', state: 'completed',
    proof: {
      tabId: 'tab-123', conversationId: '01234567-89ab-4cde-8fab-0123456789ab',
      conversationUrl: CHAT, userTurnId: 'user-123', assistantTurnId: 'assistant-123',
      notGenerating: true, completionActionVisible: true
    }
  };
  const calls = [];
  const observer = {
    async get(id) { calls.push(['get', id]); return watch; },
    async enqueueFollowup(input) {
      calls.push(['enqueue', input]);
      return {
        id: 'watch_followup123', ownerTaskId: OWNER, state: 'registered',
        surface: 'chrome-extension',
        proof: { tabId: watch.proof.tabId, conversationId: watch.proof.conversationId, conversationUrl: CHAT },
        dispatch: { state: 'pending', mode: input.mode, afterWatchId: input.afterWatchId, requestId: input.requestId }
      };
    }
  };
  return { root, resultFile, options, watch, observer, calls };
}

function rejectCode(expected) {
  return e => e?.code === expected;
}

test('queues one exact same-conversation completion and does not leak result contents', async t => {
  const f = fixture(t);
  const r = await enqueueCodexCompletionToWebGpt({ ...f.options, observer: f.observer });
  assert.equal(r.ok, true);
  assert.equal(r.delivery, 'QUEUED_NOT_DELIVERED');
  assert.equal(r.followupWatchId, 'watch_followup123');
  assert.equal(r.codexSessionId, SESSION);
  assert.deepEqual(f.calls.map(call => call[0]), ['get', 'enqueue']);
  const message = f.calls[1][1].prompt;
  assert.match(message, /codex:\/\/threads\/01a12750/);
  assert.match(message, /Terminal result: PASS/);
  assert.match(message, /Result SHA-256: [a-f0-9]{64}/);
  assert.doesNotMatch(message, /TOP-SECRET|userSecret|result\.json|\\"/);
});

test('accepts SHA-bound UTF-8 BOM receipts from Windows PowerShell without forwarding raw content', async t => {
  const f = fixture(t);
  const payload = fs.readFileSync(f.resultFile);
  fs.writeFileSync(f.resultFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), payload]));
  const expectedResultSha256 = createHash('sha256').update(fs.readFileSync(f.resultFile)).digest('hex');
  const result = await enqueueCodexCompletionToWebGpt({ ...f.options, expectedResultSha256, observer: f.observer });
  assert.equal(result.delivery, 'QUEUED_NOT_DELIVERED');
  assert.equal(result.resultSha256, expectedResultSha256);
  assert.doesNotMatch(f.calls[1][1].prompt, /TOP-SECRET/);
});

test('rejects any status, operation or child session mismatch before enqueue', async t => {
  for (const changes of [{ status: 'RUNNING' }, { operation: 'wrong-operation' }, { codexTaskId: 'another-task' }]) {
    const f = fixture(t, changes);
    await assert.rejects(enqueueCodexCompletionToWebGpt({ ...f.options, observer: f.observer }), rejectCode('result_identity_or_status_mismatch'));
    assert.equal(f.calls.length, 0);
  }
});

test('rejects result SHA mismatch, wrong expected project root and bad session UUID', async t => {
  const f = fixture(t);
  await assert.rejects(enqueueCodexCompletionToWebGpt({ ...f.options, expectedResultSha256: 'f'.repeat(64), observer: f.observer }), rejectCode('result_hash_mismatch'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-wrong-root-'));
  t.after(() => fs.rmSync(other, { force: true, recursive: true }));
  await assert.rejects(enqueueCodexCompletionToWebGpt({ ...f.options, expectedProjectRoot: other, observer: f.observer }), rejectCode('result_project_root_mismatch'));
  await assert.rejects(enqueueCodexCompletionToWebGpt({ ...f.options, codexSessionId: 'invalid', observer: f.observer }), rejectCode('codex_session_id_invalid'));
  assert.equal(f.calls.length, 0);
});

test('refuses symlink results and does not inspect the observer', async t => {
  const f = fixture(t);
  const symlink = path.join(f.root, 'linked-result.json');
  fs.symlinkSync(f.resultFile, symlink, 'file');
  await assert.rejects(enqueueCodexCompletionToWebGpt({ ...f.options, resultFile: symlink, observer: f.observer }), rejectCode('result_file_unsafe'));
  assert.equal(f.calls.length, 0);
});

test('requires exact original owner, verified response and conversation URL', async t => {
  const f = fixture(t);
  f.watch.ownerTaskId = 'other-owner';
  await assert.rejects(enqueueCodexCompletionToWebGpt({ ...f.options, observer: f.observer }), rejectCode('parent_watch_not_verified'));
  f.watch.ownerTaskId = OWNER;
  f.watch.proof.notGenerating = false;
  await assert.rejects(enqueueCodexCompletionToWebGpt({ ...f.options, observer: f.observer }), rejectCode('parent_watch_not_verified'));
  f.watch.proof.notGenerating = true;
  f.watch.proof.conversationUrl = 'https://chat.example.invalid/c/demo';
  await assert.rejects(enqueueCodexCompletionToWebGpt({ ...f.options, observer: f.observer }), rejectCode('parent_watch_not_verified'));
  assert.equal(f.calls.filter(call => call[0] === 'enqueue').length, 0);
});

test('rejects unsupported parent surface or still-running response', async t => {
  const f = fixture(t);
  f.watch.state = 'responding';
  await assert.rejects(enqueueCodexCompletionToWebGpt({ ...f.options, observer: f.observer }), rejectCode('parent_watch_not_verified'));
  f.watch.state = 'completed';
  f.watch.surface = 'registered-cdp';
  await assert.rejects(enqueueCodexCompletionToWebGpt({ ...f.options, observer: f.observer }), rejectCode('parent_watch_not_verified'));
});

test('Observer stable request ID yields same follow-up watch when replayed', async t => {
  const f = fixture(t);
  const a = await enqueueCodexCompletionToWebGpt({ ...f.options, observer: f.observer });
  const b = await enqueueCodexCompletionToWebGpt({ ...f.options, observer: f.observer });
  assert.equal(a.followupWatchId, b.followupWatchId);
  assert.equal(f.calls.filter(call => call[0] === 'enqueue').length, 2);
  // Observer's server-side idempotency owns duplicate suppression.
});

test('ambiguous post is DELIVERY_UNCERTAIN, never retries automatically', async t => {
  const f = fixture(t);
  let postCount = 0;
  f.observer.enqueueFollowup = async () => { postCount++; throw new Error('timeout'); };
  await assert.rejects(enqueueCodexCompletionToWebGpt({ ...f.options, observer: f.observer }), rejectCode('DELIVERY_UNCERTAIN'));
  assert.equal(postCount, 1);
});

test('wrong follow-up dispatch proof remains uncertain', async t => {
  const f = fixture(t);
  f.observer.enqueueFollowup = async () => ({
    id: 'watch_wrong1234', state: 'registered', surface: 'chrome-extension', ownerTaskId: OWNER,
    dispatch: { afterWatchId: 'watch_other99999', mode: 'queue', requestId: REQUEST }
  });
  await assert.rejects(enqueueCodexCompletionToWebGpt({ ...f.options, observer: f.observer }), rejectCode('DELIVERY_UNCERTAIN'));
});

test('rejects non-conversation URLs and unexpected auth-like query parameters', async t => {
  const f = fixture(t);
  for (const url of [
    'https://evil.invalid/c/01234567-89ab-4cde-8fab-0123456789ab',
    'https://chatgpt.com/share/01234567-89ab-4cde-8fab-0123456789ab',
    CHAT + '?token=secret',
    'file:///C:/private/file'
  ]) {
    await assert.rejects(enqueueCodexCompletionToWebGpt({ ...f.options, conversationUrl: url, observer: f.observer }), rejectCode('conversation_url_invalid'));
  }
});
