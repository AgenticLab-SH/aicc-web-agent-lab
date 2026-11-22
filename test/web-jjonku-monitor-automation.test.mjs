import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWebJjonkuMonitorAutomation,
  WEB_JJONKU_AUTOMATION_ID,
  WEB_JJONKU_HEARTBEAT_RRULE,
  WEB_JJONKU_TARGET_THREAD_ID
} from '../src/web-jjonku-monitor-automation.mjs';

function fixture(nowMs = () => 1_790_000_000_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-jjonku-automation-'));
  const codexHome = path.join(root, 'codex-home');
  const file = path.join(codexHome, 'automations', WEB_JJONKU_AUTOMATION_ID, 'automation.toml');
  const store = createWebJjonkuMonitorAutomation({ codexHome, nowMs });
  return { root, codexHome, file, store };
}

test('disabled default does not create a Codex heartbeat', () => {
  const { root, file, store } = fixture();
  try {
    assert.equal(store.status().liveStatus, 'not-created');
    assert.equal(store.sync({ enabled: false }).liveStatus, 'not-created');
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('enabling creates one native heartbeat TOML with the fixed five-minute scheduler', () => {
  const { root, file, store } = fixture();
  try {
    const status = store.sync({ enabled: true });
    assert.equal(status.liveStatus, 'active');
    assert.equal(status.schedulerCadenceMinutes, 5);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /version = 1/);
    assert.match(text, /id = "web-jjonku-monitor"/);
    assert.match(text, /kind = "heartbeat"/);
    assert.match(text, /status = "ACTIVE"/);
    assert.ok(text.includes('rrule = "' + WEB_JJONKU_HEARTBEAT_RRULE + '"'));
    assert.ok(text.includes(WEB_JJONKU_TARGET_THREAD_ID));
    assert.match(text, /notification_policy = "failed_runs_only"/);
    assert.equal(store.status().liveStatus, 'active');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('disabling pauses the same heartbeat and preserves its creation time', () => {
  let now = 1_790_000_000_000;
  const { root, file, store } = fixture(() => now);
  try {
    store.sync({ enabled: true });
    const created = /created_at = (\d+)/.exec(fs.readFileSync(file, 'utf8'))[1];
    now += 60_000;
    const paused = store.sync({ enabled: false });
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(paused.liveStatus, 'paused');
    assert.match(text, /status = "PAUSED"/);
    assert.ok(text.includes('created_at = ' + created));
    assert.ok(text.includes('updated_at = ' + now));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('unchanged active definition is not rewritten just because the clock advanced', () => {
  let now = 1_790_000_000_000;
  const { root, file, store } = fixture(() => now);
  try {
    store.sync({ enabled: true });
    const original = fs.readFileSync(file, 'utf8');
    now += 300_000;
    store.sync({ enabled: true });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('another ACTIVE heartbeat on the same thread blocks creation without touching it', () => {
  const { root, codexHome, file, store } = fixture();
  try {
    const otherDir = path.join(codexHome, 'automations', 'other-heartbeat');
    fs.mkdirSync(otherDir, { recursive: true });
    const other = [
      'version = 1',
      'id = "other-heartbeat"',
      'kind = "heartbeat"',
      'name = "other"',
      'prompt = "other"',
      'status = "ACTIVE"',
      'rrule = "RRULE:FREQ=HOURLY"',
      'target_thread_id = "' + WEB_JJONKU_TARGET_THREAD_ID + '"',
      'created_at = 1',
      'updated_at = 1',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(otherDir, 'automation.toml'), other);
    assert.throws(() => store.sync({ enabled: true }), error => {
      assert.equal(error.code, 'codex_heartbeat_conflict');
      assert.equal(error.conflictAutomationId, 'other-heartbeat');
      return true;
    });
    assert.equal(fs.existsSync(file), false);
    assert.equal(store.status().liveStatus, 'conflict');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('invalid owned automation is preserved and fails closed', () => {
  const { root, file, store } = fixture();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'version = 1\nid = "wrong-id"\nkind = "heartbeat"\nstatus = "ACTIVE"\n');
    const original = fs.readFileSync(file);
    assert.throws(() => store.status(), { code: 'invalid_codex_automation' });
    assert.deepEqual(fs.readFileSync(file), original);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
