import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planAgenticIntervention } from '../src/agentic-intervention.mjs';
import {
  acknowledgeNotification,
  armNotification,
  createNotificationOutboxService,
  createNotificationSessionBindingStore,
  loadNotificationPolicyConfig,
  notificationStatus,
  sendNotification,
  validateNotificationPolicyConfig
} from '../src/notification-command.mjs';

const slackPolicy = Object.freeze({
  schemaVersion: 1,
  routingProfile: 'slack_primary',
  slackEnabled: true,
  telegramEnabled: false
});

function event(overrides = {}) {
  return {
    eventId: 'ai-platform:test:notification-command',
    type: 'user_response_required',
    urgency: 3,
    sensitivity: 'internal',
    source: 'test-agent',
    projectKey: 'ai-platform',
    owner: 'root',
    taskId: '01a003e9-cb53-7610-bf63-655456f8058a',
    title: '사용자 확인 필요',
    summary: '원래 Codex 작업에서 선택해 주세요.',
    nextGate: '승인 또는 보류 선택',
    ...overrides
  };
}

test('notification policy config accepts only explicit channel profiles', () => {
  assert.deepEqual(validateNotificationPolicyConfig(slackPolicy), slackPolicy);
  assert.throws(() => validateNotificationPolicyConfig({ ...slackPolicy, routingProfile: 'auto' }), /unsupported_notification_routing_profile/);
  assert.throws(() => validateNotificationPolicyConfig({ ...slackPolicy, slackEnabled: 'yes' }), /invalid_notification_channel_availability/);
});

test('private policy loader rejects symlinks and group-readable files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-notification-policy-'));
  const policyFile = path.join(root, 'policy.json');
  const linkFile = path.join(root, 'policy-link.json');
  fs.writeFileSync(policyFile, `${JSON.stringify(slackPolicy)}\n`, { mode: 0o640 });
  fs.chmodSync(policyFile, 0o640);
  if (process.platform !== 'win32') {
    assert.throws(() => loadNotificationPolicyConfig(policyFile), /notification_policy_unavailable_unsafe_permissions/);
  }
  fs.chmodSync(policyFile, 0o600);
  fs.symlinkSync(policyFile, linkFile);
  assert.throws(() => loadNotificationPolicyConfig(linkFile), /notification_policy_unavailable_unsafe_path/);
  assert.deepEqual(loadNotificationPolicyConfig(policyFile), slackPolicy);
});

test('status can verify the exact configured Slack bot transport', async () => {
  let verified = 0;
  const result = await notificationStatus({
    policy: slackPolicy,
    verifySlack: true,
    transport: {
      async verify() {
        verified += 1;
        return { teamId: 'T0BQBP8D90D', botUserId: 'U0BQDJHQ87Q', botId: 'B0BQ06CUN31' };
      }
    }
  });
  assert.equal(verified, 1);
  assert.equal(result.ok, true);
  assert.equal(result.slackVerified, true);
  assert.equal(result.teamId, 'T0BQBP8D90D');
});

test('legacy send follows the durable level-3 one-minute policy instead of bypassing it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-notification-send-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sent = [];
  const result = await sendNotification(event(), {
    policy: slackPolicy,
    outboxRoot: root,
    outboxNow: () => 0,
    bindingStore: false,
    transport: {
      async send(value) {
        sent.push(value);
        return { ok: true, state: 'sent', eventId: value.eventId, channelId: 'D0BQTEST0001', messageTs: '1786801000.000001' };
      }
    }
  });
  assert.equal(sent.length, 0);
  assert.equal(result.notification.eventId, event().eventId);
  assert.equal(result.notification.state, 'waiting');
  assert.equal(result.notification.dueAt, '1970-01-01T00:01:00.000Z');
  assert.equal(result.notification.payloadPresent, true);
  assert.equal(result.dispatch, null);
});

test('level 4 is dispatched immediately and level 2 can be acknowledged in the exact task scope', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-notification-arm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sent = [];
  const service = createNotificationOutboxService({
    policy: slackPolicy,
    outboxRoot: root,
    outboxNow: () => 1_000,
    transport: {
      async send(value) {
        sent.push(value);
        return { ok: true, messageTs: '1786801000.000001' };
      }
    }
  });
  const bindingFile = path.join(root, 'codex-session-bindings.json');
  const bindingStore = createNotificationSessionBindingStore({ bindingFile, outboxNow: () => 1_000 });
  const immediate = await armNotification(event({ eventId: 'ai-platform:test:immediate', urgency: 4 }), { outboxService: service, bindingStore });
  assert.equal(immediate.dispatch.sent, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /^4 중요 \| 사용자 확인 필요/);
  assert.match(sent[0].message, /응답: 원래 Codex 작업/);

  const delayed = await armNotification(event({ eventId: 'ai-platform:test:delayed', type: 'task_completed', urgency: 2, nextGate: null }), { outboxService: service, bindingStore });
  assert.equal(delayed.notification.dueAt, '1970-01-01T00:02:01.000Z');
  assert.equal(delayed.sessionBinding.state, 'bound');
  const acknowledged = acknowledgeNotification({ projectKey: 'ai-platform', taskId: event().taskId }, { outboxService: service, bindingStore });
  assert.equal(acknowledged.acknowledged.length, 1);
  assert.equal(acknowledged.bindingCleanup.removed, 1);
  assert.equal(service.status({ eventId: delayed.notification.eventId }).payloadPresent, false);
});

test('owner-requested urgent intervention is immediate, task-bound, and deduplicated', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-urgent-intervention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const request = {
    ...event(), schemaVersion: 1,
    autonomousRoutes: [{ kind: 'browser', state: 'unavailable' }],
    computerUse: { state: 'unavailable', available: false, currentScreenAuthorized: false },
    humanOnlyReason: 'subjective_owner_decision'
  };
  const automatic = planAgenticIntervention({ ...request, autonomousRoutes: [{ kind: 'api', state: 'ready' }] });
  assert.equal(automatic.notification, null);
  const plan = planAgenticIntervention(request);
  assert.equal(plan.action, 'notify_user');
  const sent = [];
  const options = {
    policy: slackPolicy, outboxRoot: root, outboxNow: () => 1000, bindingStore: false,
    transport: { async send(value) { sent.push(value); return { ok: true, messageTs: '1786801000.000001' }; } }
  };
  const urgent = { ...plan.notification, urgency: 5 };
  const first = await armNotification(urgent, options);
  await armNotification(urgent, options);
  assert.equal(first.dispatch.sent, 1);
  assert.equal(first.notification.taskId, request.taskId);
  assert.equal(first.notification.dueAt, '1970-01-01T00:00:01.000Z');
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /^5 긴급 \|/);
  assert.doesNotMatch(sent[0].message, new RegExp(request.taskId));
});

test('send refuses a primary transport this command does not own', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-notification-unsupported-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(() => sendNotification(event(), {
    policy: { ...slackPolicy, routingProfile: 'telegram_primary', telegramEnabled: true },
    outboxRoot: root
  }), /notification_plan_unavailable/);
});
