import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgenticInterventionError, planAgenticIntervention } from '../src/agentic-intervention.mjs';
import { runAgenticInterventionCommand } from '../src/agentic-intervention-command.mjs';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { ResourceLeaseManager } from '../src/control-plane/resource-lease.mjs';
import { FocusGuard } from '../src/control-plane/focus-guard.mjs';

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    autonomousRoutes: [
      { kind: 'code', state: 'failed' },
      { kind: 'cli', state: 'failed' },
      { kind: 'api', state: 'unavailable' },
      { kind: 'mcp', state: 'unavailable' },
      { kind: 'browser', state: 'unavailable' }
    ],
    computerUse: { state: 'unavailable', available: false, currentScreenAuthorized: false },
    eventId: 'open-aicc:task:intervention:v1',
    projectKey: 'open-aicc',
    taskId: '01a050a5-711c-7d62-8d5a-93075a3dc0fc',
    correlationId: 'open-aicc:task:intervention',
    source: 'codex-agent',
    owner: 'root',
    title: '사용자 확인 필요',
    summary: '허용된 자동 경로를 모두 확인했습니다.',
    nextGate: '원래 Codex 작업에서 필요한 동작 수행',
    ...overrides
  };
}

test('continues on the first ordered autonomous route and emits no notification', () => {
  const plan = planAgenticIntervention(request({
    autonomousRoutes: [
      { kind: 'browser', state: 'ready' },
      { kind: 'cli', state: 'ready' },
      { kind: 'code', state: 'failed' }
    ]
  }));
  assert.equal(plan.action, 'continue_automatic');
  assert.equal(plan.route, 'cli');
  assert.equal(plan.notification, null);
});

test('uses Computer Use only with exact current-screen authorization', () => {
  const plan = planAgenticIntervention(request({
    computerUse: { state: 'untried', available: true, currentScreenAuthorized: true }
  }));
  assert.equal(plan.action, 'use_computer');
  assert.equal(plan.notification, null);
});

test('missing current-screen authorization becomes the only requested human gate', () => {
  const plan = planAgenticIntervention(request({
    computerUse: { state: 'untried', available: true, currentScreenAuthorized: false }
  }));
  assert.equal(plan.action, 'notify_user');
  assert.equal(plan.reason, 'current_screen_authorization');
  assert.equal(plan.notification.type, 'user_response_required');
  assert.equal(plan.notification.urgency, 3);
});

test('a human-only approval is immediate and stays bound to the original task', () => {
  const plan = planAgenticIntervention(request({ humanOnlyReason: 'legal_acceptance', approvalRequired: true }));
  assert.equal(plan.action, 'notify_user');
  assert.equal(plan.notification.type, 'approval_required');
  assert.equal(plan.notification.urgency, 4);
  assert.equal(plan.notification.taskId, request().taskId);
});

test('arm never calls the notification outbox while an automatic route remains', async () => {
  let calls = 0;
  const result = await runAgenticInterventionCommand('arm', request({
    autonomousRoutes: [{ kind: 'api', state: 'ready' }]
  }), {
    armNotification: async () => { calls += 1; }
  });
  assert.equal(result.action, 'no_notification_needed');
  assert.equal(calls, 0);
});

test('arm delegates one bounded event only after the intervention gate is proven', async () => {
  const events = [];
  const result = await runAgenticInterventionCommand('arm', request({ humanOnlyReason: 'captcha' }), {
    armNotification: async event => {
      events.push(event);
      return { ok: true, notification: { eventId: event.eventId, state: 'waiting' } };
    }
  });
  assert.equal(result.action, 'notification_armed');
  assert.equal(events.length, 1);
  assert.equal(events[0].interventionReason, 'captcha');
});

test('unknown human-only reasons and duplicate route kinds fail closed', () => {
  assert.throws(() => planAgenticIntervention(request({ humanOnlyReason: 'maybe' })), AgenticInterventionError);
  assert.throws(() => planAgenticIntervention(request({
    autonomousRoutes: [{ kind: 'cli', state: 'failed' }, { kind: 'cli', state: 'ready' }]
  })), /duplicate_route_kind/);
});


test('Computer Use execution is gated by exact target, user activity, and an exclusive AICC focus lease', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-focus-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourceLeases = new ResourceLeaseManager({ store: new DurableJobStore({ root }) });
  const focusGuard = new FocusGuard({ resourceLeases });
  const prepared = await runAgenticInterventionCommand('prepare-computer', request({
    computerUse: {
      state: 'untried', available: true, currentScreenAuthorized: true,
      exactTargetId: 'window-1', userActive: false, mutation: true
    }
  }), { focusGuard });
  assert.equal(prepared.action, 'computer_use_prepared');
  assert.equal(prepared.focusSession.foreground, true);
  assert.equal(prepared.focusSession.exactTargetId, 'window-1');

  const authorized = await runAgenticInterventionCommand('authorize-computer', { focusSession: prepared.focusSession }, { focusGuard });
  assert.equal(authorized.authorization.ok, true);

  await assert.rejects(() => runAgenticInterventionCommand('prepare-computer', request({
    eventId: 'open-aicc:task:intervention:v2',
    correlationId: 'open-aicc:task:intervention:v2',
    computerUse: {
      state: 'untried', available: true, currentScreenAuthorized: true,
      exactTargetId: 'window-1', userActive: false, mutation: true
    }
  }), { focusGuard }), error => error.code === 'resource_busy');

  const released = await runAgenticInterventionCommand('release-computer', {
    focusSession: prepared.focusSession, reason: 'computer-use-complete'
  }, { focusGuard });
  assert.equal(released.release.released, true);
});

test('Computer Use preparation refuses foreground mutation while the user is active', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-focus-busy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const focusGuard = new FocusGuard({ resourceLeases: new ResourceLeaseManager({ store: new DurableJobStore({ root }) }) });
  await assert.rejects(() => runAgenticInterventionCommand('prepare-computer', request({
    computerUse: {
      state: 'untried', available: true, currentScreenAuthorized: true,
      exactTargetId: 'window-2', userActive: true, mutation: true
    }
  }), { focusGuard }), error => error.code === 'user_focus_busy');
});
