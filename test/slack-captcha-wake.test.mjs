import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { armSlackCaptchaWake, completeSlackCaptchaWake } from '../src/notifications/slack-captcha-wake.mjs';
import { ensureWindowsOwnerOnlyDirectory, windowsOwnerOnlyPathStatus } from '../src/lib/windows-owner-only-acl.mjs';

const REQUEST_ID = '12345678-1234-4234-8234-123456789abc';
const CALLBACK_ID = '87654321-4321-4321-8321-cba987654321';

test('arms one exact-task callback and binds it to the CAPTCHA request', t => {
  const resultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-captcha-wake-'));
  t.after(() => fs.rmSync(resultRoot, { recursive: true, force: true }));
  let armed;
  let bound;
  const request = {
    requestId: REQUEST_ID,
    projectKey: 'ai-platform',
    taskId: 'task-123',
    expiresAt: '2027-01-15T00:10:00.000Z'
  };
  const result = armSlackCaptchaWake({
    state: { bindWake: (requestId, wake) => { bound = { requestId, wake }; } },
    request,
    projectRoot: 'C:\\project',
    manifestFile: 'C:\\manifest.json',
    codexExecutable: 'C:\\codex.exe',
    resultRoot,
    callbackService: { arm: value => { armed = value; return { callbackId: CALLBACK_ID, expiresAt: request.expiresAt }; } }
  });
  assert.equal(result.state, 'wake_armed');
  assert.equal(armed.taskId, request.taskId);
  assert.equal(armed.operationId, `slack-captcha:${REQUEST_ID}`);
  assert.equal(bound.requestId, REQUEST_ID);
  assert.equal(bound.wake.callbackId, CALLBACK_ID);
  if (process.platform === 'win32') {
    assert.equal(windowsOwnerOnlyPathStatus(path.dirname(result.resultFile), { directory: true }).ok, true);
  }
});

test('answer-ready event writes metadata only and retries the exact callback while the task is active', async t => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-captcha-wake-complete-'));
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const root = process.platform === 'win32' ? path.join(outer, 'private') : outer;
  if (process.platform === 'win32') ensureWindowsOwnerOnlyDirectory(root);
  const resultFile = path.join(root, 'result.json');
  let attempts = 0;
  let elapsed = 0;
  const expiresAt = new Date(Date.parse('2027-01-15T00:00:00.000Z') + 60_000).toISOString();
  const callbackService = {
    inspect: () => ({ callbackId: CALLBACK_ID, operationId: `slack-captcha:${REQUEST_ID}`, taskId: 'task-123', resultFile, expiresAt }),
    async complete() {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('active'), { code: 'callback_thread_active' });
      return { ok: true, state: 'completed', turnId: 'turn-1' };
    }
  };
  const result = await completeSlackCaptchaWake({
    state: { inspect: () => ({ state: 'answer_ready', liveAutoWake: true, taskId: 'task-123' }) },
    wake: { requestId: REQUEST_ID, callbackId: CALLBACK_ID, operationId: `slack-captcha:${REQUEST_ID}`, expiresAt },
    callbackService,
    now: () => Date.parse('2027-01-15T00:00:00.000Z') + elapsed,
    sleep: async milliseconds => { elapsed += milliseconds; },
    retryMs: 1_000
  });
  assert.equal(result.state, 'completed');
  assert.equal(attempts, 2);
  const written = fs.readFileSync(resultFile, 'utf8');
  assert.match(written, /"state": "answer_ready"/);
  assert.match(written, /"authorization": "exact_challenge_entry_and_submit"/);
  assert.doesNotMatch(written, /captchaValue|Secret7/);
  if (process.platform === 'win32') {
    assert.equal(windowsOwnerOnlyPathStatus(path.dirname(resultFile), { directory: true }).ok, true);
    assert.equal(windowsOwnerOnlyPathStatus(resultFile, { directory: false }).ok, true);
  }
});
