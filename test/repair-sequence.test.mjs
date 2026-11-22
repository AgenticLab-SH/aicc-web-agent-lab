import assert from 'node:assert/strict';
import test from 'node:test';
import { AICC_REPAIR_STAGES, planAiccRepairSequence } from '../src/repair-sequence.mjs';

const idle = { readOk: true, activeCount: 0, unknownCount: 0 };

test('active and UNKNOWN gates expose no next repair stage', () => {
  for (const gate of [
    { readOk: true, activeCount: 2, unknownCount: 0 },
    { readOk: true, activeCount: 0, unknownCount: 1 },
    { readOk: false, activeCount: null, unknownCount: null }
  ]) {
    const plan = planAiccRepairSequence({ gate });
    assert.equal(plan.nextStageId, null);
    assert.equal(plan.currentStageId, null);
    assert.equal(plan.allowedScope, 'source-test-documentation-only');
    assert.ok(plan.stages.every(stage => stage.state === 'waiting'));
  }
});

test('exact idle selects one read-only preflight and advances only after exact terminal evidence', () => {
  const first = planAiccRepairSequence({ gate: idle });
  assert.equal(first.nextStageId, AICC_REPAIR_STAGES[0].id);
  assert.equal(first.stages.filter(stage => stage.state === 'current').length, 1);
  assert.equal(first.stages[0].nextAction, 'read_only_preflight');

  const second = planAiccRepairSequence({ gate: idle, outcomes: { [AICC_REPAIR_STAGES[0].id]: 'PASS' } });
  assert.equal(second.stages[0].state, 'complete');
  assert.equal(second.nextStageId, AICC_REPAIR_STAGES[1].id);
  assert.equal(second.stages.filter(stage => stage.state === 'current').length, 1);
});

test('uncertain outcome permits reconcile only and never advances', () => {
  const plan = planAiccRepairSequence({ gate: idle, outcomes: { [AICC_REPAIR_STAGES[0].id]: 'UNCERTAIN' } });
  assert.equal(plan.state, 'blocked');
  assert.equal(plan.nextStageId, null);
  assert.equal(plan.currentStageId, AICC_REPAIR_STAGES[0].id);
  assert.equal(plan.stages[0].nextAction, 'reconcile_only');
  assert.ok(plan.stages.slice(1).every(stage => stage.state === 'waiting'));
});

test('out-of-order PASS is conflict and all stages fail closed', () => {
  const plan = planAiccRepairSequence({ gate: idle, outcomes: { [AICC_REPAIR_STAGES[1].id]: 'PASS' } });
  assert.equal(plan.state, 'conflict');
  assert.equal(plan.nextStageId, null);
  assert.equal(plan.reason, 'out_of_order_terminal_evidence');
  assert.ok(plan.stages.every(stage => stage.nextAction === 'reconcile_sequence'));
});

test('all exact terminal outcomes complete without another action', () => {
  const outcomes = Object.fromEntries(AICC_REPAIR_STAGES.map((stage, index) => [stage.id, index % 2 ? 'PASS' : 'NOT_APPLICABLE']));
  const plan = planAiccRepairSequence({ gate: idle, outcomes });
  assert.equal(plan.state, 'complete');
  assert.equal(plan.currentStageId, null);
  assert.equal(plan.nextStageId, null);
  assert.ok(plan.stages.every(stage => stage.state === 'complete'));
});

test('unknown stage and unsupported outcome are rejected', () => {
  assert.throws(() => planAiccRepairSequence({ gate: idle, outcomes: { typo: 'PASS' } }), /unknown repair stage/);
  assert.throws(() => planAiccRepairSequence({ gate: idle, outcomes: { [AICC_REPAIR_STAGES[0].id]: 'MAYBE' } }), /unsupported repair outcome/);
});

test('invalid counters and an explicit not-idle result never authorize a repair preflight', () => {
  assert.equal(planAiccRepairSequence({ gate: { readOk: true, exactIdle: false, activeCount: 1, unknownCount: 0 } }).state, 'active');
  for (const gate of [
    { readOk: true, activeCount: -1, unknownCount: 0 },
    { readOk: true, activeCount: 0, unknownCount: -1 },
    { readOk: true, activeCount: Number.MAX_SAFE_INTEGER + 1, unknownCount: 0 },
    { readOk: true, activeCount: 0, unknownCount: NaN },
    { readOk: true, exactIdle: false, activeCount: 0, unknownCount: 0 }
  ]) {
    const plan = planAiccRepairSequence({ gate });
    assert.equal(plan.gate.exactIdle, false);
    assert.equal(plan.state, 'unknown');
    assert.equal(plan.nextStageId, null);
    assert.equal(plan.allowedScope, 'source-test-documentation-only');
    assert.ok(plan.stages.every(stage => stage.state === 'waiting'));
  }
});