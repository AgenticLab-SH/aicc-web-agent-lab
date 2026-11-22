import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runWebGptWatchCallback } from '../src/web-gpt-watch-callback.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-web-gpt-callback-')));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resultFile = path.join(root, 'result.json');
  const binding = {
    callbackId: 'callback-123', state: 'armed', taskId: 'task-123', operationId: 'web-gpt-operation-123', resultFile,
    expiresAt: '2026-08-22T00:00:00.000Z'
  };
  return { resultFile, binding };
}

function watch(state, version, extra = {}) {
  return { id: 'watch_12345678', ownerTaskId: 'task-123', surface: 'chrome-extension', state, version, proof: {}, artifacts: [], ...extra };
}

test('waits in code and wakes the exact Codex task once after terminal proof', async t => {
  const f = fixture(t);
  const waits = [];
  const completions = [];
  const result = await runWebGptWatchCallback({
    watchId: 'watch_12345678', callbackId: f.binding.callbackId,
    now: () => Date.parse('2026-08-21T12:00:00.000Z'),
    observer: {
      async get() { return watch('registered', 1); },
      async wait(id, version, timeoutMs) {
        waits.push({ id, version, timeoutMs });
        return version === 1 ? watch('responding', 2) : watch('completed', 3, {
          proof: { userTurnId: 'user-1', assistantTurnId: 'assistant-1', notGenerating: true, completionActionVisible: true },
          artifacts: [{ id: 'artifact-1', kind: 'response_markdown', name: 'response.md', bytes: 7, sha256: 'a'.repeat(64), mediaType: 'text/markdown' }],
          rawResponse: 'must-not-be-forwarded'
        });
      }
    },
    callbackService: {
      inspect() { return f.binding; },
      async complete(input) { completions.push(input); return { ok: true, state: 'completed', turnId: 'turn-1' }; }
    }
  });
  assert.equal(waits.length, 2);
  assert.equal(completions.length, 1);
  assert.match(completions[0].expectedResultSha256, /^[a-f0-9]{64}$/);
  const document = JSON.parse(fs.readFileSync(f.resultFile, 'utf8'));
  assert.equal(document.status, 'PASS');
  assert.equal(document.webGpt.watchId, 'watch_12345678');
  assert.equal(document.webGpt.artifacts[0].id, 'artifact-1');
  assert.doesNotMatch(fs.readFileSync(f.resultFile, 'utf8'), /must-not-be-forwarded/);
  assert.equal(result.callback.turnId, 'turn-1');
});

test('retries only pre-dispatch active/busy states and reuses the exact result', async t => {
  const f = fixture(t);
  let attempts = 0;
  let slept = 0;
  const service = {
    inspect() { return f.binding; },
    async complete() {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('busy'), { code: attempts === 1 ? 'callback_thread_active' : 'callback_destination_writer_busy' });
      return { ok: true, state: 'completed', turnId: 'turn-2' };
    }
  };
  await runWebGptWatchCallback({
    watchId: 'watch_12345678', callbackId: f.binding.callbackId, callbackService: service,
    observer: { async get() { return watch('completed', 4); } },
    now: () => Date.parse('2026-08-21T12:00:00.000Z') + slept,
    sleep: async milliseconds => { slept += milliseconds; }
  });
  assert.equal(attempts, 3);
  const first = fs.readFileSync(f.resultFile, 'utf8');
  attempts = 2;
  await runWebGptWatchCallback({
    watchId: 'watch_12345678', callbackId: f.binding.callbackId, callbackService: service,
    observer: { async get() { throw new Error('must not re-read observer'); } },
    now: () => Date.parse('2026-08-21T12:00:00.000Z') + slept,
    sleep: async milliseconds => { slept += milliseconds; }
  });
  assert.equal(fs.readFileSync(f.resultFile, 'utf8'), first);
});

test('rejects a watch owned by another task before writing a callback result', async t => {
  const f = fixture(t);
  await assert.rejects(runWebGptWatchCallback({
    watchId: 'watch_12345678', callbackId: f.binding.callbackId,
    observer: { async get() { return { ...watch('completed', 1), ownerTaskId: 'other-task' }; } },
    callbackService: { inspect() { return f.binding; } },
    now: () => Date.parse('2026-08-21T12:00:00.000Z')
  }), error => error?.code === 'web_gpt_watch_owner_mismatch');
  assert.equal(fs.existsSync(f.resultFile), false);
});
