import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ComponentRegistry, UnsupportedActionError, normalizeHealth } from '../src/control-plane/registry.mjs';
import { ControlPlaneError, MaintenanceCoordinator } from '../src/control-plane/coordinator.mjs';
import { recoveryPlan } from '../src/control-plane-cli.mjs';

function fixture(t, overrides = {}) {
  const calls = [];
  const state = { activeWork: 0, version: '1', desired: 'before' };
  const adapter = {
    status: async () => ({ ...state }),
    plan: async desired => ({ exactTargets: ['/fixture'], rollback: { desired: state.desired } }),
    apply: async desired => { calls.push(['apply', desired]); state.desired = desired.value; return { ok: true }; },
    verify: async () => ({ ok: true }),
    rollback: async rollback => { calls.push(['rollback', rollback]); state.desired = rollback.desired; },
    ...overrides
  };
  const registry = new ComponentRegistry().register({ id: 'fixture', contractVersion: 1 }, adapter);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-control-plane-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  return { calls, state, adapter, registry, stateRoot, coordinator: new MaintenanceCoordinator({ registry, stateRoot }) };
}

test('read-only registry status performs no filesystem or mutation capability', async t => {
  const { registry, calls, stateRoot } = fixture(t);
  const before = fs.readdirSync(stateRoot).sort();
  const status = await registry.status();
  assert.equal(status[0].ready, false);
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readdirSync(stateRoot).sort(), before);
});

test('health normalization preserves partial failure and unknown active work', () => {
  const health = normalizeHealth({ id: 'web', state: 'attention', healthy: true, detail: 'browser unavailable' });
  assert.equal(health.live, true);
  assert.equal(health.ready, false);
  assert.equal(health.degraded, true);
  assert.equal(health.activeWork, null);
});

test('immutable plan dry-run identifies exact target without applying', async t => {
  const { coordinator, calls } = fixture(t);
  const plan = await coordinator.plan('fixture', { value: 'after' }, { mode: 'dry-run' });
  assert.equal(Object.isFrozen(plan), true);
  assert.deepEqual(plan.exactTargets, ['/fixture']);
  assert.equal((await coordinator.execute(plan)).dryRun, true);
  assert.equal(calls.length, 0);
});

test('stale precondition and unknown or active work fail closed', async t => {
  const { coordinator, state } = fixture(t);
  const stale = await coordinator.plan('fixture', { value: 'after' });
  state.version = '2';
  await assert.rejects(coordinator.execute(stale), error => error instanceof ControlPlaneError && error.code === 'stale_precondition');
  state.version = '1'; state.activeWork = null;
  const unknown = await coordinator.plan('fixture', { value: 'after' });
  await assert.rejects(coordinator.execute(unknown), error => error.code === 'active_work_unknown');
  state.activeWork = 1;
  const active = await coordinator.plan('fixture', { value: 'after' });
  await assert.rejects(coordinator.execute(active), error => error.code === 'active_work_conflict');
});

test('failed verification rolls back only the target adapter', async t => {
  const { coordinator, calls, state } = fixture(t, { verify: async () => ({ ok: false }) });
  const plan = await coordinator.plan('fixture', { value: 'after' });
  await assert.rejects(coordinator.execute(plan), error => error.code === 'verification_failed_rolled_back');
  assert.deepEqual(calls.map(call => call[0]), ['apply', 'rollback']);
  assert.equal(state.desired, 'before');
});

test('successful operation records separate evidence and replays without a second apply', async t => {
  const { coordinator, calls } = fixture(t, {
    verify: async () => ({
      ok: true,
      sourceStatus: 'pass',
      installedStatus: 'pass',
      runtimeStatus: 'pass',
      browserVisibleStatus: 'not_applicable'
    })
  });
  const plan = await coordinator.plan('fixture', { value: 'after' });
  const completed = await coordinator.execute(plan);
  assert.equal(completed.terminal, 'pass');
  assert.deepEqual(completed.evidence, {
    sourceStatus: 'pass',
    installedStatus: 'pass',
    runtimeStatus: 'pass',
    browserVisibleStatus: 'not_applicable'
  });
  const replay = await coordinator.execute(plan);
  assert.equal(replay.terminal, 'replay');
  assert.equal(replay.replayOf, 'pass');
  assert.equal(calls.filter(call => call[0] === 'apply').length, 1);
});

test('apply ambiguity is sealed as uncertain and never blindly retried', async t => {
  const { coordinator, calls } = fixture(t, {
    apply: async desired => {
      calls.push(['apply', desired]);
      throw new Error('connection closed after dispatch');
    }
  });
  const plan = await coordinator.plan('fixture', { value: 'after' });
  await assert.rejects(coordinator.execute(plan), error => error.code === 'mutation_uncertain');
  const replay = await coordinator.execute(plan);
  assert.equal(replay.terminal, 'replay');
  assert.equal(replay.replayOf, 'uncertain');
  assert.equal(calls.filter(call => call[0] === 'apply').length, 1);
});

test('a malformed terminal record is never trusted as replay evidence', async t => {
  const { coordinator, calls } = fixture(t);
  const plan = await coordinator.plan('fixture', { value: 'after' });
  const operationPath = coordinator.operationPath(plan);
  fs.mkdirSync(path.dirname(operationPath), { recursive: true });
  fs.writeFileSync(operationPath, `${JSON.stringify({
    schemaVersion: 2,
    operationId: plan.operationId,
    requestHash: plan.requestHash,
    targetComponent: 'other-domain',
    terminal: 'pass'
  })}\n`, { mode: 0o600 });
  await assert.rejects(coordinator.execute(plan), error => error.code === 'operation_record_invalid');
  assert.equal(calls.length, 0);
});

test('global idle gate blocks a different registered component with UNKNOWN work', async t => {
  const { registry, coordinator, calls } = fixture(t);
  registry.register({ id: 'other-domain' }, {
    status: async () => ({ activeWork: null }),
    plan: async () => ({}),
    apply: async () => { calls.push(['wrong-domain-apply']); },
    verify: async () => ({ ok: true }),
    rollback: async () => {}
  });
  const plan = await coordinator.plan('fixture', { value: 'after' });
  await assert.rejects(coordinator.execute(plan), error => error.code === 'active_work_unknown');
  assert.equal(calls.length, 0);
});

test('unsupported capabilities never fall back to shell', () => {
  const registry = new ComponentRegistry().register({ id: 'read-only' }, { status: async () => ({}) });
  assert.throws(() => registry.requireCapability('read-only', 'apply'), error => error instanceof UnsupportedActionError);
});

test('deterministic recovery plan exposes route provider identity and mode', () => {
  assert.deepEqual(recoveryPlan('native-direct'), { routeId: 'native-direct', provider: 'codex-official', identity: 'native-codex-profile', mode: 'read-only', dependencies: ['codex-official'], silentFailover: false, writerLeaseRequiredForMutation: true });
  assert.equal(recoveryPlan('web-gpt-direct').dependencies.includes('router-17841'), false);
});
