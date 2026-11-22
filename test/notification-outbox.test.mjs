import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import {
  DEFAULT_NOTIFICATION_DELAYS_MS,
  NotificationOutboxError,
  NotificationOutboxService
} from '../src/notifications/outbox-service.mjs';

const START = 1_800_000_000_000;

function event(urgency = 3, overrides = {}) {
  return {
    eventId: `notify:event:${urgency}:base`,
    type: urgency === 1 ? 'routine_progress' : urgency >= 5 ? 'critical_error' : urgency === 4 ? 'approval_required' : urgency === 3 ? 'user_response_required' : 'task_completed',
    urgency,
    sensitivity: 'internal',
    source: 'fixture-service',
    projectKey: 'ai-platform',
    taskId: 'task-fixture-000001',
    title: '알림 제목 원문',
    summary: '알림 요약 원문',
    nextGate: urgency >= 3 ? '원래 작업에서 확인' : null,
    ...overrides
  };
}

function planner(input) {
  return {
    ok: true,
    routingProfile: 'slack_primary',
    primaryChannel: input.urgency === 1 ? null : 'slack',
    event: {
      eventId: input.eventId,
      type: input.type,
      urgency: input.urgency,
      urgencyLabel: { 1: '참고', 2: '일반', 3: '확인', 4: '중요', 5: '긴급' }[input.urgency],
      sensitivity: input.sensitivity,
      source: input.source,
      projectKey: input.projectKey,
      taskId: input.taskId,
      expiresAt: input.expiresAt ?? null
    },
    deliveries: input.urgency === 1 ? [] : [{
      channel: 'slack',
      role: 'primary',
      state: 'planned',
      message: `${input.urgency} 단계 | 정제된 알림\n출처: ${input.projectKey}`
    }]
  };
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-notification-outbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { value: options.now ?? START };
  const makeService = overrides => new NotificationOutboxService({
    root,
    now: () => clock.value,
    planner,
    leaseDurationMs: 1_000,
    baseRetryDelayMs: 100,
    maxRetryDelayMs: 20_000,
    ...options.service,
    ...overrides
  });
  return { root, clock, makeService, service: makeService() };
}

test('default urgency delays are exact and level 3 dispatches at 60000 ms, not before', async t => {
  const { clock, service } = fixture(t);
  assert.deepEqual(DEFAULT_NOTIFICATION_DELAYS_MS, {
    1: null, 2: 120_000, 3: 60_000, 4: 0, 5: 0
  });
  const armed = service.arm(event(3));
  assert.equal(armed.notification.state, 'waiting');
  assert.equal(Date.parse(armed.notification.dueAt), START + 60_000);
  const delivered = [];
  clock.value = START + 59_999;
  assert.equal((await service.dispatchDue({ dispatcherId: 'test-dispatcher', deliver: async value => delivered.push(value) })).claimed, 0);
  clock.value = START + 60_000;
  const result = await service.dispatchDue({ dispatcherId: 'test-dispatcher', deliver: async value => {
    delivered.push(value);
    return { ok: true, deliveryId: 'delivery-level-3' };
  } });
  assert.equal(result.sent, 1);
  assert.equal(delivered.length, 1);
  assert.equal(service.status({ eventId: event(3).eventId }).state, 'sent');
});

test('level 2 dispatches at exactly 120000 ms, while levels 4 and 5 are immediately due', async t => {
  const { clock, service } = fixture(t);
  const level2 = event(2, { eventId: 'notify:event:2:boundary' });
  const level4 = event(4, { eventId: 'notify:event:4:immediate' });
  const level5 = event(5, { eventId: 'notify:event:5:immediate' });
  assert.equal(Date.parse(service.arm(level2).notification.dueAt), START + 120_000);
  assert.equal(Date.parse(service.arm(level4).notification.dueAt), START);
  assert.equal(Date.parse(service.arm(level5).notification.dueAt), START);
  const sent = [];
  const immediate = await service.dispatchDue({ dispatcherId: 'test-dispatcher', deliver: async value => {
    sent.push(value.eventId);
    return { ok: true };
  } });
  assert.equal(immediate.sent, 2);
  assert.deepEqual(new Set(sent), new Set([level4.eventId, level5.eventId]));
  clock.value = START + 119_999;
  assert.equal((await service.dispatchDue({ dispatcherId: 'test-dispatcher', deliver: async () => ({ ok: true }) })).claimed, 0);
  clock.value = START + 120_000;
  assert.equal((await service.dispatchDue({ dispatcherId: 'test-dispatcher', deliver: async () => ({ ok: true }) })).sent, 1);
});

test('level 1 is record-only and can never reach the delivery function', async t => {
  const { service } = fixture(t);
  const armed = service.arm(event(1));
  assert.equal(armed.notification.state, 'record-only');
  assert.equal(armed.notification.dueAt, null);
  assert.equal(armed.notification.payloadPresent, false);
  let calls = 0;
  assert.equal((await service.dispatchDue({ dispatcherId: 'test-dispatcher', deliver: async () => { calls += 1; } })).claimed, 0);
  assert.equal(calls, 0);
});

test('a Telegram-primary plan cannot be accepted through its secondary Slack route', t => {
  const { makeService } = fixture(t);
  const service = makeService({ planner: input => {
    const plan = planner(input);
    return {
      ...plan,
      routingProfile: 'telegram_primary',
      primaryChannel: 'telegram',
      deliveries: [
        { channel: 'telegram', role: 'primary', state: 'planned', message: '텔레그램 주 전송' },
        { channel: 'slack', role: 'secondary', state: 'planned', message: '슬랙 보조 전송' }
      ]
    };
  } });
  assert.throws(
    () => service.arm(event(3, { eventId: 'notify:event:routing:wrong' })),
    error => error.code === 'notification_plan_unavailable'
  );
});

test('same-task acknowledgement atomically acknowledges every waiting event', t => {
  const { service } = fixture(t);
  const first = event(2, { eventId: 'notify:event:ack:first' });
  const second = event(3, { eventId: 'notify:event:ack:second' });
  const other = event(3, { eventId: 'notify:event:ack:other', taskId: 'task-fixture-999999' });
  service.arm(first);
  service.arm(second);
  service.arm(other);
  const result = service.ack({ projectKey: 'ai-platform', taskId: 'task-fixture-000001' });
  assert.deepEqual(new Set(result.acknowledged.map(item => item.eventId)), new Set([first.eventId, second.eventId]));
  assert.ok(result.acknowledged.every(item => item.state === 'acknowledged' && item.payloadPresent === false));
  assert.equal(service.status({ eventId: other.eventId }).state, 'waiting');
});

test('wrong task, event, and CAS version cannot acknowledge or cancel another notification', t => {
  const { service } = fixture(t);
  const armed = service.arm(event(3, { eventId: 'notify:event:scope:guard' })).notification;
  assert.throws(
    () => service.ack({ projectKey: 'ai-platform', taskId: 'task-fixture-999999', eventId: armed.eventId }),
    error => error instanceof NotificationOutboxError && error.code === 'notification_scope_not_found'
  );
  assert.throws(
    () => service.ack({ projectKey: 'ai-platform', taskId: 'task-fixture-000001', eventId: 'notify:event:missing:0001' }),
    error => error.code === 'notification_scope_not_found'
  );
  assert.throws(
    () => service.cancel({ projectKey: 'ai-platform', taskId: 'task-fixture-000001', eventId: armed.eventId, expectedVersion: armed.version + 1 }),
    error => error.code === 'version_conflict'
  );
  const cancelled = service.cancel({
    projectKey: 'ai-platform', taskId: 'task-fixture-000001', eventId: armed.eventId, expectedVersion: armed.version
  });
  assert.equal(cancelled.notification.state, 'cancelled');
  assert.equal(cancelled.notification.version, armed.version + 1);
  assert.equal(cancelled.notification.payloadPresent, false);
});

test('event IDs and dedupe keys are idempotent and conflicting reuse fails closed', t => {
  const { service } = fixture(t);
  const base = event(3, { eventId: 'notify:event:dedupe:base' });
  const first = service.arm(base, { dedupeKey: 'comment-thread-0001' });
  const sameEvent = service.arm(base, { dedupeKey: 'comment-thread-0001' });
  assert.equal(first.duplicate, false);
  assert.equal(sameEvent.duplicate, true);
  assert.equal(sameEvent.deduplicatedBy, 'eventId');
  const sameDedupe = service.arm({ ...base, eventId: 'notify:event:dedupe:alias' }, { dedupeKey: 'comment-thread-0001' });
  assert.equal(sameDedupe.duplicate, true);
  assert.equal(sameDedupe.deduplicatedBy, 'dedupeKey');
  assert.equal(sameDedupe.notification.eventId, base.eventId);
  assert.throws(
    () => service.arm({ ...base, eventId: 'notify:event:dedupe:conflict', taskId: 'task-fixture-999999' }, { dedupeKey: 'comment-thread-0001' }),
    error => error.code === 'idempotency_conflict'
  );
  assert.equal(service.list().length, 1);
});

test('concurrent dispatch is single-lease and an expired send lease is recovered without stale finalization', async t => {
  const { clock, service } = fixture(t);
  const armed = event(4, { eventId: 'notify:event:lease:recovery' });
  service.arm(armed);
  let releaseFirst;
  const firstDelivery = new Promise(resolve => { releaseFirst = resolve; });
  const calls = [];
  const firstDispatch = service.dispatchDue({ dispatcherId: 'dispatcher-one', deliver: async value => {
    calls.push({ owner: 'one', eventId: value.eventId, attempt: value.attempt });
    return firstDelivery;
  } });
  assert.equal(service.status({ eventId: armed.eventId }).state, 'sending');
  assert.equal((await service.dispatchDue({ dispatcherId: 'dispatcher-two', deliver: async () => ({ ok: true }) })).claimed, 0);

  clock.value += 1_001;
  const recovered = await service.dispatchDue({ dispatcherId: 'dispatcher-two', deliver: async value => {
    calls.push({ owner: 'two', eventId: value.eventId, attempt: value.attempt });
    return { ok: true, deliveryId: 'delivery-recovered' };
  } });
  assert.deepEqual(recovered.recovered, [armed.eventId]);
  assert.equal(recovered.sent, 1);
  releaseFirst({ ok: true, deliveryId: 'delivery-stale' });
  const stale = await firstDispatch;
  assert.equal(stale.stale, 1);
  assert.deepEqual(calls.map(item => item.attempt), [1, 2]);
  const current = service.status({ eventId: armed.eventId });
  assert.equal(current.state, 'sent');
  assert.equal(current.deliveryRef, 'delivery-recovered');
});

test('429 retryAfter is honored and attempts converge to hold at the configured bound', async t => {
  const { clock, makeService } = fixture(t, { service: { maxAttempts: 2 } });
  const service = makeService({ maxAttempts: 2 });
  const armed = event(4, { eventId: 'notify:event:retry:bounded' });
  service.arm(armed);
  let calls = 0;
  const fail = async () => {
    calls += 1;
    const error = new Error('details are not persisted');
    error.code = 'slack_rate_limited';
    error.details = { retryAfterSeconds: 7 };
    throw error;
  };
  const first = await service.dispatchDue({ dispatcherId: 'test-dispatcher', deliver: fail });
  assert.equal(first.retried, 1);
  let current = service.status({ eventId: armed.eventId });
  assert.equal(current.state, 'retry');
  assert.equal(current.lastErrorCode, 'slack_rate_limited');
  assert.equal(Date.parse(current.retryAt), START + 7_000);
  clock.value = START + 6_999;
  assert.equal((await service.dispatchDue({ dispatcherId: 'test-dispatcher', deliver: fail })).claimed, 0);
  clock.value = START + 7_000;
  const second = await service.dispatchDue({ dispatcherId: 'test-dispatcher', deliver: fail });
  assert.equal(second.held, 1);
  current = service.status({ eventId: armed.eventId });
  assert.equal(current.state, 'hold');
  assert.equal(current.attempts, 2);
  assert.equal(current.payloadPresent, false);
  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(current), /details are not persisted/);
});

test('terminal records purge rendered payload while retaining its hash and safe metadata', async t => {
  const { root, service } = fixture(t);
  const armed = event(4, { eventId: 'notify:event:purge:terminal' });
  const pending = service.arm(armed).notification;
  assert.equal(pending.payloadPresent, true);
  assert.match(pending.payloadHash, /^[a-f0-9]{64}$/);
  await service.dispatchDue({ dispatcherId: 'test-dispatcher', deliver: async () => ({ ok: true, deliveryId: 'safe-reference' }) });
  const terminal = service.status({ eventId: armed.eventId });
  assert.equal(terminal.state, 'sent');
  assert.equal(terminal.payloadPresent, false);
  assert.equal(terminal.payloadHash, pending.payloadHash);
  assert.ok(terminal.payloadPurgedAt);
  for (const file of ['state.json', 'journal.jsonl']) {
    const persisted = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(persisted, /4 단계 \| 정제된 알림/);
    assert.doesNotMatch(persisted, /"payload"\s*:\s*"/);
  }
});

test('restart reopens the dedicated durable store without duplicate submission', async t => {
  const { root, clock, service } = fixture(t);
  const armed = event(3, { eventId: 'notify:event:restart:persistence' });
  service.arm(armed, { dedupeKey: 'restart-persistence-001' });
  const restarted = new NotificationOutboxService({
    root,
    now: () => clock.value,
    planner,
    leaseDurationMs: 1_000,
    baseRetryDelayMs: 100,
    maxRetryDelayMs: 20_000
  });
  assert.equal(restarted.status({ eventId: armed.eventId }).state, 'waiting');
  assert.equal(restarted.arm(armed, { dedupeKey: 'restart-persistence-001' }).duplicate, true);
  clock.value += 60_000;
  assert.equal((await restarted.dispatchDue({ dispatcherId: 'test-dispatcher', deliver: async () => ({ ok: true }) })).sent, 1);
  assert.equal(restarted.status({ eventId: armed.eventId }).state, 'sent');
});

test('expiry cancels a due notification before delivery and purges its payload', async t => {
  const { clock, service } = fixture(t);
  const expiring = event(4, {
    eventId: 'notify:event:expiry:before-send',
    expiresAt: new Date(START + 500).toISOString()
  });
  service.arm(expiring);
  clock.value += 500;
  let calls = 0;
  const result = await service.dispatchDue({ dispatcherId: 'test-dispatcher', deliver: async () => { calls += 1; } });
  assert.equal(result.claimed, 0);
  assert.deepEqual(result.terminalized, [expiring.eventId]);
  assert.equal(calls, 0);
  const current = service.status({ eventId: expiring.eventId });
  assert.equal(current.state, 'cancelled');
  assert.equal(current.terminalReason, 'expired_before_dispatch');
  assert.equal(current.payloadPresent, false);
});

test('bounded retention prunes only old terminal metadata and preserves all pending deliveries', async t => {
  const { clock, service } = fixture(t);
  const recordOnly = event(1, { eventId: 'notify:event:retention:record' });
  const sent = event(4, { eventId: 'notify:event:retention:sent' });
  const pending = event(3, { eventId: 'notify:event:retention:pending' });
  service.arm(recordOnly, { dedupeKey: 'retention-record-001' });
  service.arm(sent, { dedupeKey: 'retention-sent-0001' });
  service.arm(pending, { dedupeKey: 'retention-pending-01' });
  await service.dispatchDue({ dispatcherId: 'test-dispatcher', deliver: async () => ({ ok: true }) });
  clock.value += 1_000;
  const plan = service.pruneTerminal({ olderThanMs: 500, limit: 1 });
  assert.equal(plan.apply, false);
  assert.equal(plan.candidateEventIds.length, 1);
  assert.equal(plan.pendingPreserved, 1);
  assert.equal(service.list().length, 3);

  const first = service.pruneTerminal({ olderThanMs: 500, limit: 1, apply: true });
  assert.equal(first.removedEventIds.length, 1);
  assert.equal(first.pendingPreserved, 1);
  assert.equal(service.status({ eventId: pending.eventId }).state, 'waiting');
  const second = service.pruneTerminal({ olderThanMs: 500, limit: 1, apply: true });
  assert.equal(second.removedEventIds.length, 1);
  assert.deepEqual(service.list().map(item => item.eventId), [pending.eventId]);
  assert.equal(service.arm(recordOnly, { dedupeKey: 'retention-record-001' }).duplicate, false);
});

test('status and list never expose message bodies, and raw sensitive fields are rejected before planning', t => {
  const { root, service } = fixture(t);
  const rawTitle = '절대로 상태에 나오면 안 되는 원문 제목';
  const rawSummary = '절대로 상태에 나오면 안 되는 원문 요약';
  const armed = event(3, { eventId: 'notify:event:privacy:status', title: rawTitle, summary: rawSummary });
  service.arm(armed, { dedupeKey: 'privacy-status-0001' });
  const visible = JSON.stringify({ status: service.status({ eventId: armed.eventId }), list: service.list() });
  assert.doesNotMatch(visible, /message|payload"\s*:/);
  assert.doesNotMatch(visible, new RegExp(`${rawTitle}|${rawSummary}`));
  const persisted = fs.readFileSync(path.join(root, 'state.json'), 'utf8');
  assert.doesNotMatch(persisted, new RegExp(`${rawTitle}|${rawSummary}`));
  assert.doesNotMatch(persisted, /"title"\s*:|"summary"\s*:/);

  assert.throws(
    () => service.arm({ ...event(3, { eventId: 'notify:event:privacy:field' }), token: 'do-not-store' }),
    error => error.code === 'sensitive_raw_field_prohibited'
  );
  assert.throws(
    () => service.arm(event(3, { eventId: 'notify:event:privacy:dedupe' }), { dedupeKey: 'token=secret-material' }),
    error => error.code === 'invalid_dedupe_key'
  );
  assert.throws(
    () => service.arm(event(3, { eventId: 'notify:event:privacy:task', taskId: 'token=secret-material' })),
    error => error.code === 'invalid_task_id'
  );
});

test('default planner produces the existing redacted compact Slack payload and owner-only durable files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-notification-outbox-default-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { value: START };
  const store = new DurableJobStore({ root, now: () => clock.value, maxJournalRecords: 1 });
  const service = new NotificationOutboxService({ store, now: () => clock.value, leaseDurationMs: 1_000 });
  const restricted = event(4, {
    eventId: 'notify:event:default:planner',
    sensitivity: 'restricted',
    title: 'private raw title token=should-not-leak',
    summary: 'private raw summary password=should-not-leak',
    nextGate: 'secret=should-not-leak'
  });
  service.arm(restricted);
  const delivered = [];
  await service.dispatchDue({ dispatcherId: 'test-dispatcher', deliver: async value => {
    delivered.push(value.message);
    return { ok: true };
  } });
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /^4 중요 \| 사용자 승인 필요/);
  assert.doesNotMatch(delivered[0], /should-not-leak|private raw/);
  assert.equal(service.integrity().ok, true);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(root).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(root, 'state.json')).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(root, 'journal.jsonl')).mode & 0o077, 0);
  }
});

for (const unsafe of [null,'slack_network_failed','slack_delivery_identity_mismatch','send_lease_expired']) {
  test(`credential recovery exact existing event and safe pre-post code ${unsafe}`,async t=>{
    const {service}=fixture(t,{service:{maxAttempts:1}});
    const value=event(4,{type:'report_ready'});
    const armed=service.arm(value,{dedupeKey:value.eventId});
    await service.dispatchDue({dispatcherId:'recovery-fixture',deliver:async()=>{throw {code:unsafe??'slack_bot_token_unavailable'};}});
    const previous=service.status({eventId:value.eventId});
    assert.equal(previous.state,'hold');
    assert.throws(()=>service.recoverCredentialReadFailure({...value,eventId:'missing:recovery:event'},{expectedVersion:previous.version}),error=>error.code==='notification_scope_not_found');
    assert.throws(()=>service.recoverCredentialReadFailure({...value,taskId:'other-task-000001'},{expectedVersion:previous.version}),error=>error.code==='notification_scope_not_found');
    assert.throws(()=>service.recoverCredentialReadFailure(value,{expectedVersion:previous.version-1,dedupeKey:value.eventId}),/version_conflict/);
    if(unsafe){assert.throws(()=>service.recoverCredentialReadFailure(value,{expectedVersion:previous.version,dedupeKey:value.eventId}),/not_safe/);return;}
    const recovered=service.recoverCredentialReadFailure(value,{expectedVersion:previous.version,dedupeKey:value.eventId});
    assert.equal(recovered.notification.eventId,value.eventId);
    assert.equal(recovered.notification.attempts,1);
    assert.equal(recovered.notification.maxAttempts,2);
    const result=await service.dispatchDue({dispatcherId:'recovery-fixture',deliver:async()=>({ok:true,deliveryRef:'1786802400.000007'})});
    assert.equal(result.sent,1);
    assert.equal(service.status({eventId:value.eventId}).attempts,2);
    assert.throws(()=>service.recoverCredentialReadFailure(value,{expectedVersion:service.status({eventId:value.eventId}).version,dedupeKey:value.eventId}),/not_safe/);
    assert.equal(service.integrity().ok,true);
  });
}

test('credential recovery rejects altered original body and a second recovery after failure',async t=>{
 const {service}=fixture(t,{service:{maxAttempts:1},});
 const value=event(4,{type:'report_ready'});
 service.arm(value,{dedupeKey:value.eventId});
 await service.dispatchDue({dispatcherId:'recovery-fixture',deliver:async()=>{throw {code:'slack_bot_token_unavailable'};}});
 const previous=service.status({eventId:value.eventId});
 assert.throws(()=>service.recoverCredentialReadFailure({...value,urgency:5},{expectedVersion:previous.version}),error=>error.code==='idempotency_conflict');
 service.recoverCredentialReadFailure(value,{expectedVersion:previous.version,dedupeKey:value.eventId});
 await service.dispatchDue({dispatcherId:'recovery-fixture',deliver:async()=>{throw {code:'slack_bot_token_unavailable'};}});
 const failed=service.status({eventId:value.eventId});
 assert.equal(failed.state,'hold');
 assert.throws(()=>service.recoverCredentialReadFailure(value,{expectedVersion:failed.version,dedupeKey:value.eventId}),/not_safe/);
});
test('a prior unknown network attempt cannot be recovered after a credential failure',async t=>{
 const {service,clock}=fixture(t,{service:{maxAttempts:2}});
 const value=event(4,{type:'report_ready'});
 service.arm(value);
 await service.dispatchDue({dispatcherId:'recovery-fixture',deliver:async()=>{throw {code:'slack_network_failed'};}});
 clock.value+=20000;
 await service.dispatchDue({dispatcherId:'recovery-fixture',deliver:async()=>{throw {code:'slack_bot_token_unavailable'};}});
 const previous=service.status({eventId:value.eventId});
 assert.equal(previous.state,'hold');
 assert.throws(()=>service.recoverCredentialReadFailure(value,{expectedVersion:previous.version}),/not_safe/);
});