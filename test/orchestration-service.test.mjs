import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { JobManager } from '../src/jobs/job-manager.mjs';
import { WebGptOrchestrationService } from '../src/orchestration/service.mjs';
import { createGoalLedgerService } from '../src/goals/service.mjs';

function fixture(t, start = Date.parse('2026-08-09T19:00:00Z')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-orchestration-'));
  let now = start;
  const clock = () => now;
  const store = new DurableJobStore({ root: path.join(root, 'jobs'), now: clock });
  const manager = new JobManager({ store, now: clock, leaseDurationMs: 60_000 });
  const service = new WebGptOrchestrationService({ manager, store, artifactRoot: path.join(root, 'artifacts'), now: clock });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store, manager, service, advance: milliseconds => { now += milliseconds; } };
}

function plan(service, overrides = {}) {
  return service.planRun({
    requestId: 'request-plan-0001',
    runId: 'run-fixture',
    rootTaskId: 'root-fixture',
    workspaceId: 'workspace-fixture',
    routeId: 'chatgpt-web/temporary/high',
    identityBinding: 'identity-fixture',
    surface: 'full',
    tools: [
      { id: 'read_file', classes: ['read'] },
      { id: 'apply_patch', classes: ['write'] }
    ],
    roles: [
      { roleId: 'researcher', kind: 'researcher', dependencies: [], requiredToolIds: ['read_file'] },
      { roleId: 'critic', kind: 'critic', dependencies: [], requiredToolIds: ['read_file'] },
      { roleId: 'merger', kind: 'merger', dependencies: ['researcher', 'critic'], requiredToolIds: ['read_file'] }
    ],
    budgets: { defaultFanOut: 2, hardActiveCap: 5 },
    ...overrides
  });
}

function start(service, run, roleId, requestId) {
  return service.startRole({ requestId, runId: run.runId, roleId, capabilitySnapshotHash: run.capabilitySnapshot.hash });
}

function submit(service, run, roleId, requestId, resultId) {
  return service.submitResult({
    requestId,
    runId: run.runId,
    roleId,
    capabilitySnapshotHash: run.capabilitySnapshot.hash,
    resultId,
    claim: `${roleId} structured claim`,
    evidence: [],
    validatorStatus: 'pass'
  });
}

test('researcher critic and merger use exact advertised tools and verified structured artifacts', t => {
  const { service, store } = fixture(t);
  const planned = plan(service);
  const run = planned.run;
  assert.deepEqual(run.capabilitySnapshot.toolIds, ['apply_patch', 'read_file']);
  assert.throws(() => start(service, run, 'merger', 'start-merger-early'), /dependencies/i);
  start(service, run, 'researcher', 'start-researcher');
  start(service, run, 'critic', 'start-critic');
  assert.equal(submit(service, run, 'researcher', 'result-researcher', 'research-result').state, 'completed');
  assert.equal(submit(service, run, 'critic', 'result-critic', 'critic-result').state, 'completed');
  start(service, run, 'merger', 'start-merger');
  assert.equal(submit(service, run, 'merger', 'result-merger', 'merger-result').state, 'completed');
  const status = service.status({ runId: run.runId }).run;
  assert.equal(status.state, 'completed');
  assert.equal(status.rawTranscriptStored, false);
  assert.ok(status.roles.every(role => role.artifactCount === 1));
  const completeState = store.read().state;
  const durable = completeState.orchestrationRuns[run.runId];
  assert.ok(durable.hooks.some(hook => hook.name === 'before_merge'));
  assert.ok(durable.hooks.some(hook => hook.name === 'after_result'));
  const forbiddenKeys = [];
  const inspect = (value, at = 'state') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:prompt|response|transcript|cookie|cookies|secret|token|password|authorization|browserProfile|tabContent|content)$/i.test(key)) forbiddenKeys.push(`${at}.${key}`);
      inspect(child, `${at}.${key}`);
    }
  };
  inspect(completeState);
  assert.deepEqual(forbiddenKeys, []);
});

test('writer request holds the only workspace writer and a second writer is rejected before apply', t => {
  const { service, store } = fixture(t);
  const run = plan(service, {
    requestId: 'request-writer-plan',
    runId: 'run-writer',
    roles: [
      { roleId: 'solver-a', kind: 'solver', dependencies: [], requiredToolIds: ['read_file'] },
      { roleId: 'solver-b', kind: 'solver', dependencies: [], requiredToolIds: ['read_file'] },
      { roleId: 'writer', kind: 'writer', mode: 'write', dependencies: ['solver-a', 'solver-b'], requiredToolIds: ['apply_patch'] },
      { roleId: 'verifier', kind: 'verifier', dependencies: ['writer'], requiredToolIds: ['read_file'] }
    ]
  }).run;
  start(service, run, 'solver-a', 'start-solver-a');
  start(service, run, 'solver-b', 'start-solver-b');
  submit(service, run, 'solver-a', 'result-solver-a', 'solver-a-result');
  submit(service, run, 'solver-b', 'result-solver-b', 'solver-b-result');
  const writer = service.requestWriter({ requestId: 'writer-request', runId: run.runId, roleId: 'writer', capabilitySnapshotHash: run.capabilitySnapshot.hash });
  assert.equal(writer.writerLease, 'exclusive-workspace-writer-held');
  assert.equal(Object.keys(store.read().state.workspaceLeases).length, 1);
  assert.throws(() => service.startRole({ requestId: 'wrong-writer-start', runId: run.runId, roleId: 'writer', capabilitySnapshotHash: run.capabilitySnapshot.hash }), /request_writer/);
  assert.throws(() => plan(service, {
    requestId: 'request-two-writers',
    runId: 'run-two-writers',
    roles: [
      { roleId: 'writer-a', kind: 'writer', mode: 'write', requiredToolIds: ['apply_patch'] },
      { roleId: 'writer-b', kind: 'writer', mode: 'write', requiredToolIds: ['apply_patch'] }
    ]
  }), /at most one writer/);
});

test('a user-selected eight-tab budget runs eight independent roles and queues the remainder', t => {
  const { service, store } = fixture(t);
  const roles = Array.from({ length: 10 }, (_, index) => ({ roleId: `solver-${index + 1}`, kind: 'solver', dependencies: [], requiredToolIds: ['read_file'] }));
  const run = plan(service, { requestId: 'request-ten-roles', runId: 'run-ten-roles', roles, budgets: { defaultFanOut: 8, hardActiveCap: 8 } }).run;
  for (let index = 0; index < 8; index += 1) start(service, run, `solver-${index + 1}`, `start-solver-${index + 1}`);
  assert.throws(() => start(service, run, 'solver-9', 'start-solver-9'), /active limit/i);
  const state = store.read().state;
  assert.equal(Object.values(state.jobs).filter(job => job.orchestrationRunId === run.runId && job.state === 'running').length, 8);
  assert.equal(Object.keys(state.browserLeases).length, 0);
});

test('stale or inferred capabilities and browser-only local writes fail closed', t => {
  const { service, advance } = fixture(t);
  assert.throws(() => plan(service, { requestId: 'request-inferred', runId: 'run-inferred', tools: [{ id: 'all-tools', classes: ['read'] }] }), /inferred tool/i);
  assert.throws(() => plan(service, {
    requestId: 'request-browser-writer',
    runId: 'run-browser-writer',
    surface: 'browser-only',
    roles: [{ roleId: 'writer', kind: 'writer', mode: 'write', dependencies: [], requiredToolIds: ['apply_patch'] }]
  }), /browser-only/);
  const run = plan(service, { requestId: 'request-expiry', runId: 'run-expiry', capabilityTtlSeconds: 30 }).run;
  advance(30_001);
  assert.throws(() => start(service, run, 'researcher', 'start-expired'), /expired/);
  assert.throws(() => service.startRole({ requestId: 'start-changed', runId: run.runId, roleId: 'researcher', capabilitySnapshotHash: '0'.repeat(64) }), /changed/);
});

test('cancel and cleanup remove only run-owned lease records and preserve audit state', t => {
  const { service, store } = fixture(t);
  const run = plan(service, { requestId: 'request-cleanup', runId: 'run-cleanup' }).run;
  start(service, run, 'researcher', 'start-cleanup-researcher');
  store.transaction('fixture.browser-leases', state => {
    state.browserLeases.owned = { runId: run.runId, targetId: 'owned-target' };
    state.browserLeases.foreign = { runId: 'another-run', targetId: 'foreign-target' };
  });
  const cancelled = service.cancelRun({ requestId: 'cancel-cleanup', runId: run.runId });
  assert.equal(cancelled.targetCleanup, 'owned-targets-only');
  const cleaned = service.cleanupRun({ requestId: 'cleanup-terminal', runId: run.runId });
  assert.deepEqual(cleaned.cleanedBrowserLeaseIds, ['owned']);
  const state = store.read().state;
  assert.equal(state.browserLeases.owned, undefined);
  assert.equal(state.browserLeases.foreign.targetId, 'foreign-target');
  assert.ok(state.orchestrationRuns[run.runId]);
  assert.equal(state.orchestrationRuns[run.runId].cleanup.foreignTargetsTouched, 0);
});

function trackedGoal(root, service) {
  const masterGoalsPath = path.join(root, 'control-plane', 'master-goals.json');
  const revision = '2026-08-09T19:00:00Z';
  const write = (status = 'ACTIVE', generatedAt = revision, definition = {}) => {
    fs.mkdirSync(path.dirname(masterGoalsPath), { recursive: true });
    fs.writeFileSync(masterGoalsPath, JSON.stringify({ generatedAt, goals: [{ id: 'parent-fixture', title: 'Parent fixture', status, ...definition }] }));
  };
  write();
  service.goalLedger = createGoalLedgerService({ ownerRoot: root });
  return { write, binding: { goalId: 'parent-fixture', sourceUpdatedAt: revision } };
}

test('bound tracked goal revision and ACTIVE status guard new dispatch without promoting parent authority', t => {
  const { root, service, store } = fixture(t);
  const goal = trackedGoal(root, service);
  const run = plan(service, { parentGoal: goal.binding }).run;
  assert.equal(run.parentGoal.goalId, goal.binding.goalId);
  assert.equal(run.parentGoal.sourceUpdatedAt, goal.binding.sourceUpdatedAt);
  assert.match(run.parentGoal.goalSnapshotHash, /^[a-f0-9]{64}$/);
  assert.equal(run.parentGoalCompletion, 'unknown');
  goal.write('HOLD');
  assert.throws(() => start(service, run, 'researcher', 'start-held-parent'), { code: 'parent_goal_inactive' });
  goal.write('ACTIVE', '2026-08-09T19:01:00Z');
  assert.throws(() => start(service, run, 'researcher', 'start-changed-parent'), { code: 'parent_goal_revision_changed' });
  assert.ok(Object.values(store.read().state.jobs).every(job => job.attempts.length === 0));
  goal.write();
  assert.equal(start(service, run, 'researcher', 'start-current-parent').ok, true);
});

test('tracked parent stop preserves exact result but blocks new consumption; ACK stays cooperative', t => {
  const { root, service, store } = fixture(t);
  const goal = trackedGoal(root, service);
  const run = plan(service, { parentGoal: goal.binding }).run;
  const started = start(service, run, 'researcher', 'start-parent-result');
  const job = store.read().state.jobs[started.jobId];
  const exact = {
    runId: run.runId, roleId: 'researcher', capabilitySnapshotHash: run.capabilitySnapshot.hash,
    resultId: 'parent-result', attemptId: started.attemptId,
    operationId: job.attempts.at(-1).operationId ?? job.operationId ?? job.jobId, requestHash: job.requestHash
  };
  goal.write('HOLD');
  const recorded = service.submitResult({ ...exact, requestId: 'record-parent-result', recordOnly: true, claim: 'preserved original result' });
  assert.equal(recorded.state, 'recorded');
  const consume = {
    ...exact, action: 'consume', requestId: 'consume-parent-result',
    adoption: { resultHash: recorded.resultHash, consumerId: 'parent-fixture', destination: 'parent://fixture', effectKey: 'effect-fixture',
      goalRevision: goal.binding.sourceUpdatedAt, identityBinding: run.identityBinding,
      expectedRunUpdatedAt: service.status({ runId: run.runId }).run.updatedAt }
  };
  assert.throws(() => service.submitResult(consume), { code: 'parent_goal_inactive' });
  goal.write('ACTIVE', '2026-08-09T19:01:00Z');
  assert.throws(() => service.submitResult(consume), { code: 'parent_goal_revision_changed' });
  assert.equal(store.read().state.jobs[job.jobId].results[0].consumptions?.length ?? 0, 0);
  goal.write();
  assert.throws(() => service.submitResult({ ...consume, adoption: { ...consume.adoption, goalRevision: 'another-revision' } }), { code: 'parent_goal_revision_changed' });
  const consumed = service.submitResult(consume);
  assert.equal(consumed.receipt.authorityMode, 'COOPERATIVE');
  assert.equal(consumed.parentGoalCompletion, 'unknown');
  assert.equal(consumed.parentGoalObservation.check, 'tracked-ledger-observed');
  assert.deepEqual(service.submitResult(consume), consumed);
});

test('explicit parent binding fails closed without a readable tracked goal ledger', t => {
  const { root, service, store } = fixture(t);
  const binding = { goalId: 'parent-fixture', sourceUpdatedAt: 'revision-fixture' };
  assert.throws(() => plan(service, { parentGoal: binding }), { code: 'parent_goal_unavailable' });
  service.goalLedger = createGoalLedgerService({ ownerRoot: root });
  assert.throws(() => plan(service, { parentGoal: binding }), error => error.code === 'parent_goal_unavailable' && !error.message.includes(root));
  assert.equal(Object.keys(store.read().state.orchestrationRuns).length, 0);
});

test('bound definition hash rejects same-timestamp scope changes while personal checklist changes remain view-only', t => {
  const { root, service, store } = fixture(t);
  const goal = trackedGoal(root, service);
  const run = plan(service, { parentGoal: goal.binding }).run;
  goal.write('ACTIVE', goal.binding.sourceUpdatedAt, { title: 'Changed approved scope' });
  assert.throws(() => start(service, run, 'researcher', 'start-changed-definition'), { code: 'parent_goal_revision_changed' });
  assert.ok(Object.values(store.read().state.jobs).every(job => job.attempts.length === 0));
  goal.write();
  service.goalLedger.setChecked({ goalId: goal.binding.goalId, checked: true });
  assert.equal(start(service, run, 'researcher', 'start-checklist-only').ok, true);
  assert.throws(() => plan(service, {
    requestId: 'wrong-expected-definition', runId: 'wrong-expected-definition',
    parentGoal: { ...goal.binding, goalSnapshotHash: '0'.repeat(64) }
  }), { code: 'parent_goal_revision_changed' });
});

test('bound consumption checks goal inside the job transaction, durably records observation, and reconciles exact ACK after stop', t => {
  const { root, service, store, manager } = fixture(t);
  const goal = trackedGoal(root, service);
  const run = plan(service, { parentGoal: goal.binding }).run;
  const started = start(service, run, 'researcher', 'start-durable-parent');
  const job = manager.read(started.jobId);
  const exact = { runId: run.runId, roleId: 'researcher', capabilitySnapshotHash: run.capabilitySnapshot.hash,
    resultId: 'durable-parent-result', attemptId: started.attemptId,
    operationId: job.attempts.at(-1).operationId ?? job.operationId ?? job.jobId, requestHash: job.requestHash };
  const recorded = service.submitResult({ ...exact, requestId: 'record-durable-parent', recordOnly: true, claim: 'Original evidence' });
  const adoption = { resultHash: recorded.resultHash, consumerId: 'parent-consumer', destination: 'parent://exact', effectKey: 'effect-exact',
    goalRevision: goal.binding.sourceUpdatedAt, identityBinding: run.identityBinding, expectedRunUpdatedAt: service.status({ runId: run.runId }).run.updatedAt };
  const input = { ...adoption, resultId: exact.resultId, operationId: exact.operationId, requestHash: exact.requestHash };
  assert.throws(() => manager.acknowledgeResult(job.jobId, started.attemptId, input), { code: 'parent_goal_check_required' });
  assert.throws(() => manager.acknowledgeResult(job.jobId, started.attemptId, input, {
    checkParentGoal: () => ({ goalId: run.parentGoal.goalId, sourceUpdatedAt: run.parentGoal.sourceUpdatedAt,
      goalSnapshotHash: '0'.repeat(64), status: 'ACTIVE', check: 'tracked-ledger-observed' })
  }), { code: 'parent_goal_check_invalid' });
  const transaction = store.transaction.bind(store);
  let entered = false;
  store.transaction = (label, mutation) => transaction(label, state => {
    if (label === 'job.result.consume') { entered = true; goal.write('HOLD'); }
    return mutation(state);
  });
  const consume = { ...exact, action: 'consume', requestId: 'consume-durable-parent', adoption };
  assert.throws(() => service.submitResult(consume), { code: 'parent_goal_inactive' });
  assert.equal(entered, true);
  assert.equal(manager.read(job.jobId).results[0].consumptions?.length ?? 0, 0);
  store.transaction = transaction;
  goal.write();
  const consumed = service.submitResult(consume);
  assert.equal(consumed.receipt.authorityMode, 'COOPERATIVE');
  assert.equal(consumed.receipt.goalRevisionStatus, 'tracked-ledger-observed');
  assert.equal(consumed.receipt.parentGoalCompletion, 'unknown');
  assert.equal(consumed.receipt.parentGoalObservation.goalSnapshotHash, run.parentGoal.goalSnapshotHash);
  assert.equal(consumed.receipt.parentGoalObservation.definitionBinding, 'hash-bound');
  assert.deepEqual(manager.read(job.jobId).results[0].consumptions[0], consumed.receipt);
  assert.equal('title' in consumed.receipt.parentGoalObservation, false);
  goal.write('HOLD');
  const reconciled = service.submitResult({ ...consume, requestId: 'reconcile-exact-consumption' });
  assert.equal(reconciled.duplicate, true);
  assert.deepEqual(reconciled.receipt, consumed.receipt);
  assert.equal(manager.read(job.jobId).results[0].consumptions.length, 1);
  assert.throws(() => service.submitResult({ ...consume, requestId: 'different-after-stop', adoption: { ...adoption, effectKey: 'new-effect' } }), { code: 'parent_goal_inactive' });
});

test('original ACK reconciliation stays read-only after memo loss, stop, cleanup and expiry', t => {
  const { root, service, store, manager, advance } = fixture(t);
  const goal = trackedGoal(root, service);
  const run = plan(service, { parentGoal: goal.binding, capabilityTtlSeconds: 30 }).run;
  const started = start(service, run, 'researcher', 'start-ack-readback');
  const job = manager.read(started.jobId);
  const exact = { roleId: 'researcher', capabilitySnapshotHash: run.capabilitySnapshot.hash,
    resultId: 'ack-readback-result', attemptId: started.attemptId,
    operationId: job.attempts.at(-1).operationId ?? job.operationId ?? job.jobId, requestHash: job.requestHash };
  const recorded = service.submitResult({ ...exact, runId: run.runId, requestId: 'record-ack-readback', recordOnly: true, claim: 'Original evidence' });
  const adoption = { resultHash: recorded.resultHash, consumerId: 'parent-consumer', destination: 'parent://exact', effectKey: 'effect-exact',
    goalRevision: goal.binding.sourceUpdatedAt, identityBinding: run.identityBinding };
  const query = { runId: run.runId, consumption: { ...exact, adoption } };
  const missing = service.status(query);
  assert.equal(missing.state, 'unknown');
  assert.equal(missing.reconciliation, 'original-ack-not-found');
  assert.equal(missing.receipt, null);
  assert.equal(missing.replayAllowed, false);
  const consumed = service.submitResult({ ...exact, runId: run.runId, requestId: 'consume-ack-readback', action: 'consume',
    adoption: { ...adoption, expectedRunUpdatedAt: service.status({ runId: run.runId }).run.updatedAt } });
  store.transaction('fixture.lost-request-memo', state => { delete state.orchestrationRuns[run.runId].operations['consume-ack-readback']; });
  goal.write('HOLD');
  service.cancelRun({ requestId: 'cancel-ack-readback', runId: run.runId });
  service.cleanupRun({ requestId: 'cleanup-ack-readback', runId: run.runId });
  advance(30_001);
  const before = store.read();
  store.transaction = () => { throw new Error('reconciliation must never write'); };
  const restarted = new WebGptOrchestrationService({ manager, store, artifactRoot: path.join(root, 'artifacts'), now: () => Date.parse('2026-08-10T19:00:00Z') });
  const reconciled = restarted.status(query);
  assert.equal(reconciled.reconciliation, 'original-ack-found');
  assert.equal(reconciled.state, 'consumed');
  assert.equal(reconciled.replayAllowed, false);
  assert.deepEqual(reconciled.receipt, consumed.receipt);
  assert.equal(reconciled.parentGoalCompletion, 'unknown');
  assert.deepEqual(store.read(), before);
  assert.throws(() => restarted.status({ ...query, consumption: { ...query.consumption, capabilitySnapshotHash: '0'.repeat(64) } }), { code: 'stale_capability' });
  assert.throws(() => restarted.status({ ...query, consumption: { ...query.consumption, adoption: { ...adoption, resultHash: '0'.repeat(64) } } }), { code: 'result_binding_mismatch' });
  assert.throws(() => restarted.status({ ...query, consumption: { ...query.consumption, adoption: { ...adoption, identityBinding: 'other-identity' } } }), { code: 'adoption_identity_mismatch' });
  assert.throws(() => restarted.status({ ...query, consumption: { ...query.consumption, adoption: { ...adoption, goalRevision: 'other-revision' } } }), { code: 'adoption_conflict' });
  assert.equal(restarted.status({ ...query, consumption: { ...query.consumption, adoption: { ...adoption, effectKey: 'other-effect' } } }).state, 'unknown');
  assert.deepEqual(store.read(), before);
});

test('native parent authority and stop epoch fail closed without downgrading to tracked authority', t => {
  const { root, service, store, manager } = fixture(t);
  const goal = trackedGoal(root, service);
  // Even a claimed native projection is not an exact native-owner reader.
  const tracked = service.goalLedger;
  service.goalLedger = { status: () => ({ ...tracked.status(), nativeCodexGoal: {
    state: 'ACTIVE', read: true, ownerThreadId: 'parent-thread', stopEpoch: 0
  } }) };
  const beforePlan = store.read();
  for (const requirement of [{ authorityMode: 'NATIVE' }, { stopEpoch: 0 }, { ownerThreadId: 'parent-thread' }]) {
    assert.throws(() => plan(service, { parentGoal: { ...goal.binding, ...requirement } }), { code: 'native_parent_authority_unavailable' });
    assert.deepEqual(store.read(), beforePlan);
  }
  assert.throws(() => plan(service, { parentGoal: { ...goal.binding, nativeAuthority: { ready: true } } }), { code: 'invalid_parent_goal' });
  const run = plan(service, { parentGoal: { ...goal.binding, authorityMode: 'COOPERATIVE' } }).run;
  assert.equal(run.parentGoal.authorityMode, 'COOPERATIVE');
  assert.equal(run.parentGoalAuthority.nativeAuthorityReady, false);
  assert.equal(run.parentGoalAuthority.stopEpoch, 'UNKNOWN');
  // Plan memo lookup cannot silently accept a stronger native requirement either.
  assert.throws(() => plan(service, { parentGoal: { ...goal.binding, authorityMode: 'NATIVE' } }), { code: 'native_parent_authority_unavailable' });
  assert.throws(() => manager.createRun({ parentGoal: { ...goal.binding, stopEpoch: 0 } }), { code: 'native_parent_authority_unavailable' });
  const started = start(service, run, 'researcher', 'start-native-boundary');
  const job = manager.read(started.jobId);
  const exact = { runId: run.runId, roleId: 'researcher', capabilitySnapshotHash: run.capabilitySnapshot.hash,
    resultId: 'native-boundary-result', attemptId: started.attemptId,
    operationId: job.attempts.at(-1).operationId ?? job.operationId ?? job.jobId, requestHash: job.requestHash };
  const recorded = service.submitResult({ ...exact, requestId: 'record-native-boundary', recordOnly: true, claim: 'Original evidence' });
  const adoption = { resultHash: recorded.resultHash, consumerId: 'parent-consumer', destination: 'parent://exact', effectKey: 'effect-exact',
    goalRevision: goal.binding.sourceUpdatedAt, identityBinding: run.identityBinding, expectedRunUpdatedAt: service.status({ runId: run.runId }).run.updatedAt };
  const consumed = service.submitResult({ ...exact, requestId: 'consume-native-boundary', action: 'consume', adoption });
  // A future/imported native binding must not enter the old cooperative dispatch/consume path.
  store.transaction('fixture.unregistered-native-parent', state => {
    state.orchestrationRuns[run.runId].parentGoal.authorityMode = 'NATIVE';
    state.orchestrationRuns[run.runId].parentGoal.stopEpoch = 0;
  });
  const before = store.read();
  assert.throws(() => start(service, run, 'critic', 'start-unregistered-native'), { code: 'native_parent_authority_unavailable' });
  assert.throws(() => service.submitResult({ ...exact, requestId: 'consume-unregistered-native', action: 'consume', adoption: { ...adoption, effectKey: 'new-effect' } }), { code: 'native_parent_authority_unavailable' });
  assert.deepEqual(store.read(), before);
  const query = { runId: run.runId, consumption: { ...exact, adoption } };
  assert.deepEqual(service.status(query).receipt, consumed.receipt);
  assert.deepEqual(store.read(), before);
});
