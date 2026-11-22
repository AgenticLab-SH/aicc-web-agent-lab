import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOcxQuotaSlackMonitor } from '../src/ocx-quota-slack-monitor.mjs';

const hash = 'a'.repeat(64);
function snapshot(used) {
  return {
    warningSettings: { slackEnabled: true },
    policy: { fiveHourUsedThreshold: 97, longWindowUsedThreshold: 97, fiveHourAction: 'switch', longWindowAction: 'switch' },
    tray: { selectionVerified: true },
    accounts: [{ identityHash: hash, quotaFresh: true, name: '1번', active: true, shortUsedPercent: used, longUsedPercent: 10,
      shortResetAt: '2099-01-01T00:00:00.000Z', longResetAt: '2099-02-01T00:00:00.000Z', longLabel: '주간', quotaObservedAt: '2026-11-01T00:00:00.000Z' }]
  };
}
function root() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ocx-quota-monitor-')); }

test('quota monitor arms one short Korean outbox event per threshold edge and never re-arms it', async () => {
  const ownerRoot = root();
  try {
    const events = [];
    let used = 98;
    const monitor = createOcxQuotaSlackMonitor({ ownerRoot, dashboard: { read: async () => snapshot(used) },
      notify: async event => { events.push(event); return { ok: true, notification: { eventId: event.eventId, state: 'sent', sentAt: '2026-11-01T00:00:01.000Z' } }; } });
    await monitor.tick();
    await monitor.tick();
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.type, 'report_ready');
    assert.equal(event.urgency, 4);
    assert.equal(event.projectKey, 'aicc');
    assert.match(event.title, /[가-힣]/);
    assert.ok(event.summary.length <= 180);
    assert.match(event.summary, /1번 5시간/);
    assert.match(event.eventId, /^ocxquota:[a-f0-9]{56}$/);
    assert.equal(monitor.status().state, 'watching');
    used = 50;
    await monitor.tick();
    assert.equal(events.length, 1, 'falling below the threshold sends nothing');
    await monitor.stop();
  } finally { fs.rmSync(ownerRoot, { recursive: true, force: true }); }
});

test('an ambiguous notify result keeps the edge UNKNOWN and is not re-armed', async () => {
  const ownerRoot = root();
  try {
    let calls = 0;
    const monitor = createOcxQuotaSlackMonitor({ ownerRoot, dashboard: { read: async () => snapshot(99) },
      notify: async () => { calls++; return { ok: false }; } });
    await monitor.tick();
    assert.equal(monitor.status().state, 'delivery_unknown_hold');
    await monitor.tick();
    assert.equal(calls, 1);
    const state = JSON.parse(fs.readFileSync(path.join(ownerRoot, 'notifications', 'ocx-quota-block-monitor.json'), 'utf8'));
    assert.deepEqual(Object.values(state.deliveries).map(row => row.state), ['UNKNOWN']);
    await monitor.stop();
  } finally { fs.rmSync(ownerRoot, { recursive: true, force: true }); }
});

test('a planning refusal arms nothing, keeps no fence and retries on a later tick without Slack', async () => {
  const ownerRoot = root();
  try {
    fs.mkdirSync(path.join(ownerRoot, 'notifications'), { recursive: true });
    // No channel enabled: the outbox planner refuses before writing, so nothing leaves the machine.
    fs.writeFileSync(path.join(ownerRoot, 'notifications', 'policy.json'), JSON.stringify({ schemaVersion: 1, routingProfile: 'telegram_primary', slackEnabled: false, telegramEnabled: false }));
    const monitor = createOcxQuotaSlackMonitor({ ownerRoot, dashboard: { read: async () => snapshot(99) } });
    await monitor.tick();
    assert.equal(monitor.status().state, 'notify_unavailable_hold');
    assert.equal(monitor.status().errorCode, 'notification_plan_unavailable');
    const state = JSON.parse(fs.readFileSync(path.join(ownerRoot, 'notifications', 'ocx-quota-block-monitor.json'), 'utf8'));
    assert.deepEqual(state.deliveries, {});
    await monitor.stop();
  } finally { fs.rmSync(ownerRoot, { recursive: true, force: true }); }
});

test('default path writes the event to the real durable outbox; a missing Slack config stays local', async () => {
  const ownerRoot = root();
  try {
    fs.mkdirSync(path.join(ownerRoot, 'notifications'), { recursive: true });
    fs.writeFileSync(path.join(ownerRoot, 'notifications', 'policy.json'), JSON.stringify({ schemaVersion: 1, routingProfile: 'slack_primary', slackEnabled: true, telegramEnabled: false }));
    // No Slack bot config exists under this temporary root, so the immediate urgency-4 dispatch fails
    // locally inside the outbox (retry/hold) and never reaches the network.
    const monitor = createOcxQuotaSlackMonitor({ ownerRoot, dashboard: { read: async () => snapshot(99) } });
    await monitor.tick();
    assert.equal(monitor.status().state, 'sent', 'armed in the outbox');
    const outbox = fs.readdirSync(path.join(ownerRoot, 'notifications', 'outbox'), { recursive: true });
    assert.ok(outbox.length > 0);
    await monitor.tick();
    const state = JSON.parse(fs.readFileSync(path.join(ownerRoot, 'notifications', 'ocx-quota-block-monitor.json'), 'utf8'));
    assert.deepEqual(Object.values(state.deliveries).map(row => row.state), ['SENT']);
    await monitor.stop();
  } finally { fs.rmSync(ownerRoot, { recursive: true, force: true }); }
});
