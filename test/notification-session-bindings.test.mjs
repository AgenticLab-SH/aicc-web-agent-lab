import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NotificationSessionBindingStore } from '../src/notifications/session-bindings.mjs';
import { loadSessionBinding } from '../tools/platform/codex/notification-ack-hook.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-session-bindings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'notifications', 'codex-session-bindings.json');
  let now = Date.parse('2026-08-16T03:00:00.000Z');
  const store = new NotificationSessionBindingStore({ file, now: () => now, maxTtlMs: 86_400_000 });
  return { root, file, store, get now() { return now; }, set now(value) { now = value; } };
}

test('binding store writes the exact owner-only schema consumed by the prompt hook', t => {
  const f = fixture(t);
  const result = f.store.bind({ sessionId: 'session-123', projectKey: 'ai-platform', taskId: 'task-456' });
  assert.equal(result.state, 'bound');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  }
  assert.deepEqual(loadSessionBinding('session-123', { bindingPath: f.file, now: () => f.now }), {
    projectKey: 'ai-platform',
    taskId: 'task-456'
  });
  assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /prompt|transcript|message|summary/i);
});

test('same scope refreshes, conflicting scope fails closed, and exact scope removal is bounded', t => {
  const f = fixture(t);
  f.store.bind({ sessionId: 'session-123', projectKey: 'ai-platform', taskId: 'task-456' });
  assert.equal(f.store.bind({ sessionId: 'session-123', projectKey: 'ai-platform', taskId: 'task-456' }).state, 'refreshed');
  assert.throws(
    () => f.store.bind({ sessionId: 'session-123', projectKey: 'other-project', taskId: 'task-789' }),
    /binding_scope_conflict/
  );
  assert.equal(f.store.unbindScope({ projectKey: 'other-project', taskId: 'task-789' }).removed, 0);
  assert.equal(f.store.unbindScope({ projectKey: 'ai-platform', taskId: 'task-456' }).removed, 1);
  assert.equal(loadSessionBinding('session-123', { bindingPath: f.file, now: () => f.now }), null);
});

test('expired bindings are pruned and requested TTL is capped', t => {
  const f = fixture(t);
  const result = f.store.bind({
    sessionId: 'session-123',
    projectKey: 'ai-platform',
    taskId: 'task-456',
    expiresAt: '2026-08-20T03:00:00.000Z'
  });
  assert.equal(result.expiresAt, '2026-08-17T03:00:00.000Z');
  f.now += 86_400_001;
  assert.equal(f.store.pruneExpired().removed, 1);
});

test('symlink and group-readable binding files are rejected without mutation', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.file), { recursive: true });
  const outside = path.join(f.root, 'outside.json');
  fs.writeFileSync(outside, '{"schemaVersion":1,"bindings":{}}\n', { mode: 0o600 });
  fs.symlinkSync(outside, f.file);
  assert.throws(() => f.store.bind({ sessionId: 'session-123', projectKey: 'ai-platform', taskId: 'task-456' }), /binding_path_unsafe/);
  fs.rmSync(f.file);
  fs.writeFileSync(f.file, '{"schemaVersion":1,"bindings":{}}\n', { mode: 0o644 });
  fs.chmodSync(f.file, 0o644);
  if (process.platform !== 'win32') {
    assert.throws(() => f.store.bind({ sessionId: 'session-123', projectKey: 'ai-platform', taskId: 'task-456' }), /binding_permissions_unsafe/);
  }
});
