import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { UpstreamReviewService, observeReview } from '../src/upstream-review-service.mjs';
import { createMonitoringJobService } from '../src/monitoring-job-service.mjs';
import { schedulerTick } from '../src/local-scheduler.mjs';

const target = '11111111-1111-4111-8111-111111111111';
const queued = '22222222-2222-4222-8222-222222222222';
function fixture({ send } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-review-'));
  const clock = { value: Date.parse('2026-11-02T00:00:00Z') };
  const pins = [0, 1, 2].map(n => { const file = path.join(root, `source-${n}`); fs.writeFileSync(file, `source-${n}`); return { path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }; });
  const rollout = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id: target, cwd: root } }) + '\n');
  const r = { schemaVersion: 1, registrationId: 'test-review', enabled: true, automaticApply: false, reviewOnly: true,
    targetThreadId: target, targetRoot: root, rollout, cadenceHours: 24, firstDueAt: new Date(clock.value).toISOString(),
    authorizationRef: 'fixture-approval', goalId: 'fixture-goal', codexExecutable: pins[0].path, codexSha256: pins[0].sha256,
    sourcePins: pins, schedulerEntry: path.join(root, 'local-scheduler.mjs') };
  const registrationPath = path.join(root, 'registration.json');
  const save = () => fs.writeFileSync(registrationPath, JSON.stringify(r)); save();
  const monitoring = createMonitoringJobService({ stateRoot: root, now: () => clock.value,
    manifest: { policy: { localScanIntervalHours: 24 }, sources: [] }, scan: () => { throw Error('scan-not-authorized-by-tick'); } });
  let calls = 0;
  const service = new UpstreamReviewService({ stateRoot: root, registrationPath, monitoring, now: () => clock.value,
    coordinator: { status: () => ({ activePlans: 0, planCount: 0 }) },
    send: async (...args) => { calls++; return send ? send(...args) : { ok: true, exitCode: 0, stdout: `Queued message ${queued} for thread ${target}.\n`, stderr: '' }; } });
  const append = (type, payload) => fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date(clock.value).toISOString(), type, payload }) + '\n');
  return { root, r, save, clock, service, monitoring, append, get calls() { return calls; } };
}

test('one due creates a real review todo and reuses the monitor queue without scan or update', async () => {
  const f = fixture({ send: async (exe, args, options) => {
    assert.deepEqual(args.slice(0, 3), ['queue', '--thread', target]);
    assert.equal(args.at(-1), '--resume'); assert.equal(options.cwd, f.root);
    assert.equal(Object.hasOwn(options.env, 'CODEX_THREAD_ID'), false);
    return { ok: true, exitCode: 0, stdout: `Queued message ${queued} for thread ${target}.`, stderr: '' };
  } });
  const first = await f.service.tick();
  assert.equal(first.latest.state, 'QUEUE_ACCEPTED'); assert.equal(first.latest.queuedMessageId, queued);
  assert.equal(first.latest.automaticApply, false); assert.equal(first.reviewCount, 1);
  assert.equal(f.monitoring.status().queuedJobIds.length, 1);
  assert.equal(first.nextDueAt, '2026-11-03T00:00:00.000Z');
  assert.equal((await f.service.tick()).reason, 'same-due-preserved'); assert.equal(f.calls, 1);
});
test('simultaneous ticks serialize due claim before the queue side effect', async () => {
  const f = fixture(); await Promise.all([f.service.tick(), f.service.tick()]); assert.equal(f.calls, 1); assert.equal(f.service.status().reviewCount, 1);
});
test('lost queue acknowledgement remains uncertain and is never replayed', async () => {
  const f = fixture({ send: async () => { throw Error('timeout-after-possible-send'); } });
  assert.equal((await f.service.tick()).latest.state, 'QUEUE_DELIVERY_UNCERTAIN');
  await f.service.tick(); f.clock.value += 25 * 3600000;
  assert.equal((await f.service.tick()).reason, 'previous-review-reconcile-first'); assert.equal(f.calls, 1);
});
test('wrong exact queue ACK is not acceptance', async () => {
  const f = fixture({ send: async () => ({ ok: true, stdout: `Queued message ${queued} for thread ${queued}.` }) });
  assert.equal((await f.service.tick()).latest.state, 'QUEUE_DELIVERY_UNCERTAIN');
});
test('overdue windows coalesce into one current todo and preserve the anchored next due', async () => {
  const f = fixture(); f.clock.value += 3 * 24 * 3600000 + 1000;
  const r = await f.service.tick(); assert.equal(r.latest.dueIndex, 3); assert.equal(r.reviewCount, 1); assert.equal(r.nextDueAt, '2026-11-06T00:00:00.000Z');
});
test('marker-bound CLI execution and matching terminal release the following due', async () => {
  const f = fixture(); const first = await f.service.tick();
  f.append('event_msg', { type: 'task_started', turn_id: 'exact-turn' });
  f.append('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: first.latest.marker }] });
  f.append('event_msg', { type: 'task_complete', turn_id: 'neighbour-turn' });
  assert.equal((await f.service.tick()).latest.executionState, 'TURN_ACTIVE');
  f.append('event_msg', { type: 'task_complete', turn_id: 'exact-turn' });
  f.clock.value += 24 * 3600000;
  assert.equal((await f.service.tick()).reviewCount, 2); assert.equal(f.calls, 2);
});
test('a marker with no current turn or a neighbouring completion cannot manufacture execution', () => {
  const f = fixture(); const review = { marker: 'AICC_UPSTREAM_REVIEW:exact', createdAt: new Date(f.clock.value).toISOString() };
  f.append('response_item', { type: 'message', role: 'user', content: [{ text: review.marker }] });
  f.append('event_msg', { type: 'task_complete', turn_id: 'unbound' });
  assert.equal(observeReview(f.r, review).executionState, 'UNOBSERVED');
});
test('typed Desktop marker carries its own exact turn', () => {
  const f = fixture(); const review = { marker: 'AICC_UPSTREAM_REVIEW:exact', createdAt: new Date(f.clock.value).toISOString() };
  f.append('event_msg', { type: 'item_completed', turn_id: 'typed-turn', item: { type: 'UserMessage', content: [{ type: 'text', text: review.marker }] } });
  assert.equal(observeReview(f.r, review).turnId, 'typed-turn');
});
test('changed binary/source and wrong saved target stop before delivery', async () => {
  const f = fixture(); fs.writeFileSync(f.r.codexExecutable, 'changed');
  await assert.rejects(f.service.tick(), { code: 'review_registered_code_changed' }); assert.equal(f.calls, 0);
  const g = fixture(); g.r.targetThreadId = queued; g.save();
  await assert.rejects(g.service.tick(), { code: 'review_exact_target_changed' }); assert.equal(g.calls, 0);
});
test('only the exact recipient can acknowledge; acknowledgement does not dispatch', async () => {
  const f = fixture(); const r = await f.service.tick();
  assert.throws(() => f.service.acknowledge(r.latest.id, queued), { code: 'review_exact_recipient_required' });
  assert.equal(f.service.acknowledge(r.latest.id, target).acknowledgedBy, target); assert.equal(f.calls, 1);
});
test('a moved registered current slot cannot silently use the old executable', async () => {
  const f = fixture(); f.r.codexAlias = f.r.sourcePins[1].path; f.save();
  await assert.rejects(f.service.tick(), { code: 'review_registered_slot_changed' }); assert.equal(f.calls, 0);
});
test('disabled or not-yet-due registration does not send', async () => {
  const f = fixture(); f.r.enabled = false; f.save(); assert.equal((await f.service.tick()).reason, 'review-disabled');
  f.r.enabled = true; f.r.firstDueAt = new Date(f.clock.value + 3600000).toISOString(); f.save();
  assert.equal((await f.service.tick()).reason, 'not-due'); assert.equal(f.calls, 0);
});
test('Windows review scheduler scope does not run knowledge, Slack or installation actions', async () => {
  const result = await schedulerTick({ scope: 'upstream-review', reviewService: { tick: async () => ({ marker: 'review-only' }) },
    processNotifications: () => { throw Error('must-not-call'); }, monitoringService: { enqueueDue: () => { throw Error('must-not-call'); } } });
  assert.equal(result.review.marker, 'review-only'); assert.equal(result.automaticApply, false);
});
