import assert from 'node:assert/strict';
import test from 'node:test';
import {
  notificationEventTypes,
  notificationUrgencyLevels,
  planNotification
} from '../src/notification-policy.mjs';

function event(overrides = {}) {
  return {
    eventId: 'task:019fe6c8:attention',
    type: 'user_response_required',
    urgency: 3,
    sensitivity: 'internal',
    source: 'codex-task',
    projectKey: 'ai-platform',
    taskId: '01a003e9-cb53-7610-bf63-655456f8058a',
    correlationId: '019fe6c8',
    title: '사용자 확인이 필요합니다',
    summary: '정확한 다음 단계 하나를 선택해 주세요.',
    nextGate: '원래 Codex 작업에서 선택',
    ...overrides
  };
}

test('event taxonomy is stable and routine progress routes nowhere', () => {
  assert.ok(notificationEventTypes.includes('approval_required'));
  assert.deepEqual(notificationUrgencyLevels, {
    1: '참고', 2: '일반', 3: '확인', 4: '중요', 5: '긴급'
  });
  const plan = planNotification(event({ type: 'routine_progress', urgency: 1 }));
  assert.equal(plan.ok, true);
  assert.equal(plan.event.urgency, 1);
  assert.equal(plan.primaryChannel, null);
  assert.deepEqual(plan.deliveries, []);
});
test('actionable events use Telegram primary and Slack secondary', () => {
  const plan = planNotification(event());
  assert.equal(plan.ok, true);
  assert.equal(plan.primaryChannel, 'telegram');
  assert.deepEqual(plan.deliveries.map(item => item.channel), ['telegram', 'slack']);
  assert.equal(plan.deliveries[0].responseMode, 'correlated');
  assert.match(plan.deliveries[1].message, /응답: Telegram/);
});

test('owner-selected Slack primary routes actionable work to the original Codex task', () => {
  const plan = planNotification(event({
    owner: 'root',
    nextGate: '사용자 판단 뒤 같은 task를 재개'
  }), { telegram: false, slack: true }, { routingProfile: 'slack_primary' });
  assert.equal(plan.ok, true);
  assert.equal(plan.primaryChannel, 'slack');
  assert.equal(plan.responseAuthority, 'original_task');
  assert.deepEqual(plan.deliveries.map(item => item.channel), ['slack']);
  assert.match(plan.deliveries[0].message, /^3 확인 \| 사용자 확인이 필요합니다/);
  assert.match(plan.deliveries[0].message, /할 일: 사용자 판단 뒤 같은 task를 재개/);
  assert.match(plan.deliveries[0].message, /출처: ai-platform/);
  assert.doesNotMatch(plan.deliveries[0].message, /01a003e9-cb53-7610-bf63-655456f8058a/);
  assert.equal(plan.event.taskId, '01a003e9-cb53-7610-bf63-655456f8058a');
  assert.match(plan.deliveries[0].message, /응답: 원래 Codex 작업/);
  assert.doesNotMatch(plan.deliveries[0].message, /Project:|Owner:|Event:|Next gate:|Codex task:|ACTION:|INFO:|CRITICAL:/);
  assert.doesNotMatch(plan.deliveries[0].message, /Telegram의 연결된 요청/);
});

test('five urgency levels are numeric, Korean, concise, and color-free', () => {
  const fixtures = [
    { type: 'task_completed', urgency: 1, expected: '2 일반' },
    { type: 'task_completed', urgency: 2, expected: '2 일반' },
    { type: 'user_response_required', urgency: 3, expected: '3 확인' },
    { type: 'approval_required', urgency: 4, expected: '4 중요' },
    { type: 'critical_error', urgency: 5, expected: '5 긴급' }
  ];
  for (const fixture of fixtures) {
    const plan = planNotification(event(fixture), {}, { routingProfile: 'slack_primary' });
    assert.equal(plan.event.urgencyLabel, fixture.expected.split(' ')[1]);
    assert.match(plan.deliveries[0].message, new RegExp(`^${fixture.expected} \\| `));
    assert.doesNotMatch(plan.deliveries[0].message, /🔴|🟠|🟡|🟢|🔵|red|orange|yellow|green|blue/i);
  }
});

test('legacy severity remains accepted and critical events cannot be downgraded', () => {
  const legacy = event({ urgency: undefined, severity: 'attention' });
  assert.equal(planNotification(legacy).event.urgency, 3);
  const critical = planNotification(event({ type: 'critical_error', urgency: 1, severity: 'info' }));
  assert.equal(critical.event.urgency, 5);
  assert.match(critical.deliveries[0].message, /^5 긴급 \| /);
});

test('Slack-primary profile never routes OTP to Slack', () => {
  const plan = planNotification(event({ type: 'otp_required' }), {
    telegram: false,
    slack: true
  }, { routingProfile: 'slack_primary' });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.deliveries.map(item => item.channel), ['telegram']);
  assert.deepEqual(plan.blockingReasons, ['telegram_required_unavailable']);
});

test('unknown routing profile fails closed', () => {
  assert.throws(() => planNotification(event(), {}, { routingProfile: 'connector_guess' }), /unsupported_notification_routing_profile/);
});

test('required Telegram absence blocks approval but Slack absence only degrades', () => {
  const telegramMissing = planNotification(event({ type: 'approval_required' }), { telegram: false, slack: true });
  assert.equal(telegramMissing.ok, false);
  assert.deepEqual(telegramMissing.blockingReasons, ['telegram_required_unavailable']);

  const slackMissing = planNotification(event({ type: 'approval_required' }), { telegram: true, slack: false });
  assert.equal(slackMissing.ok, true);
  assert.equal(slackMissing.deliveries[1].state, 'unavailable');
});

test('OTP is Telegram-only and does not expose code material', () => {
  const plan = planNotification(event({
    type: 'otp_required',
    title: '인증번호 123456 입력',
    summary: 'password=secret-value api_key=abc 인증번호는 123456',
    nextGate: '123456 입력'
  }));
  assert.deepEqual(plan.deliveries.map(item => item.channel), ['telegram']);
  assert.equal(plan.responseAuthority, 'telegram_ephemeral_only');
  assert.match(plan.deliveries[0].message, /^4 중요 \| 일회성 코드 입력 필요/);
  assert.doesNotMatch(plan.deliveries[0].message, /secret-value|api_key=abc|123456|인증번호는/);
});

test('restricted events replace caller title, summary, and action with fixed safe Korean', () => {
  const plan = planNotification(event({
    sensitivity: 'restricted',
    title: '🔴 private title 123456',
    summary: 'private incident body 123456',
    nextGate: 'secret next gate 123456'
  }));
  for (const delivery of plan.deliveries) {
    assert.match(delivery.message, /^3 확인 \| 사용자 확인 필요/);
    assert.doesNotMatch(delivery.message, /private|secret|123456|🔴/);
    assert.match(delivery.message, /원래 작업/);
  }
});

test('invalid event fails closed', () => {
  assert.throws(() => planNotification(event({ eventId: 'bad' })), /invalid_notification_event_id/);
  assert.throws(() => planNotification(event({ type: 'other' })), /unsupported_notification_event_type/);
  assert.throws(() => planNotification(event({ projectKey: 'bad]header' })), /invalid_notification_project_key/);
  assert.throws(() => planNotification(event({ projectKey: undefined })), /notification_project_key_required/);
  assert.throws(() => planNotification(event({ taskId: undefined })), /notification_task_id_required/);
  assert.throws(() => planNotification(event({ taskId: 'bad\ntask' })), /invalid_notification_task_id/);
  assert.throws(() => planNotification(event({ correlationId: 'bad\ncorrelation' })), /invalid_notification_correlation_id/);
  assert.throws(() => planNotification(event({ owner: 'bad\nowner' })), /invalid_notification_owner/);
  assert.throws(() => planNotification(event({ urgency: 0 })), /invalid_notification_urgency/);
  assert.throws(() => planNotification(event({ urgency: 6 })), /invalid_notification_urgency/);
  assert.throws(() => planNotification(event({ urgency: 2.5 })), /invalid_notification_urgency/);
  assert.throws(() => planNotification(event({ severity: 'urgent' })), /invalid_notification_severity/);
  assert.throws(() => planNotification(event({ title: 'Approval required' })), /invalid_notification_title_language/);
  assert.throws(() => planNotification(event({ title: '🔴 사용자 승인 필요' })), /invalid_notification_title_format/);
  assert.throws(() => planNotification(event({ summary: '' })), /notification_summary_required/);
  assert.throws(() => planNotification(event({ nextGate: '' })), /notification_next_gate_required/);
});
