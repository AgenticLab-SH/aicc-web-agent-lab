import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireIntegratedMaintenanceLease,
  collectDirectRescueExactSamples,
  validateAggregateRescueSummary,
  validateDirectRescueHealth,
  validateIntegratedDrainAck,
  validateIntegratedWebHealth,
  validateRescueCutoverPreflight,
  waitForPostSetupDoctor,
} from '../src/web-gpt-maintenance-validator.mjs';

const health = (overrides = {}) => ({
  status: 'ok',
  version: '2.0.0-aicc.6',
  pid: 597,
  port: 17842,
  accepting_turns: true,
  accepting_browser_turns: false,
  active_http_turns: 0,
  active_browser_http_turns: 0,
  active_browser_turns: 0,
  ...overrides,
});

const aggregate = (overrides = {}) => ({
  id: 'web-gpt-rescue',
  state: 'ready',
  port: 17842,
  configured: true,
  authenticated: true,
  loaded: true,
  healthSummary: false,
  ...overrides,
});

test('aggregate rescue accepts normalized standby with optional health omitted', () => {
  assert.deepEqual(validateAggregateRescueSummary(aggregate()), {
    state: 'ready', port: 17842, configured: true, authenticated: true, loaded: true, healthPresent: false,
  });
});

test('aggregate rescue accepts a ready summary with health present without trusting it for idle', () => {
  const result = validateAggregateRescueSummary(aggregate({ health: health({ active_http_turns: 9 }) }));
  assert.equal(result.healthPresent, true);
});

test('preflight performs direct same-PID exact samples before aggregate summary', async () => {
  const phases = [];
  let fetches = 0;
  const result = await validateRescueCutoverPreflight({
    fetchHealth: async () => { fetches += 1; return health(); },
    collectAggregate: async () => ({ components: [aggregate()] }),
    sleep: async () => {},
    expectedVersion: '2.0.0-aicc.6',
    onPhase: phase => phases.push(phase),
  });
  assert.equal(fetches, 5);
  assert.equal(result.direct.pid, 597);
  assert.deepEqual(phases, ['direct-rescue-exact-samples', 'aggregate-rescue-summary']);
});

test('direct rescue rejects UNKNOWN counters', () => {
  assert.throws(() => validateDirectRescueHealth(health({ active_browser_turns: undefined })), error => error.code === 'DIRECT_RESCUE_COUNTER_UNKNOWN');
});

test('direct rescue rejects nonzero work', () => {
  assert.throws(() => validateDirectRescueHealth(health({ active_http_turns: 1 })), error => error.code === 'DIRECT_RESCUE_ACTIVE');
});

test('direct exact samples reject a PID change', async () => {
  let call = 0;
  await assert.rejects(collectDirectRescueExactSamples({
    fetchHealth: async () => health({ pid: call++ < 2 ? 597 : 598 }),
    sleep: async () => {},
    count: 5,
    expectedVersion: '2.0.0-aicc.6',
  }), error => error.code === 'DIRECT_RESCUE_PID_CHANGED');
});

test('direct exact samples fail closed on a transient fetch error', async () => {
  let call = 0;
  await assert.rejects(collectDirectRescueExactSamples({
    fetchHealth: async () => { if (call++ === 2) throw new Error('timeout'); return health(); },
    sleep: async () => {},
    count: 5,
  }), error => error.code === 'DIRECT_RESCUE_FETCH_FAILED' && error.evidence.sample === 3);
});

test('aggregate rescue rejects wrong ownership and UNKNOWN fields', () => {
  assert.throws(() => validateAggregateRescueSummary(aggregate({ loaded: null })), error => error.code === 'AGGREGATE_RESCUE_NOT_READY');
  assert.throws(() => validateAggregateRescueSummary(aggregate({ port: 17841 })), error => error.code === 'AGGREGATE_RESCUE_NOT_READY');
});

test('direct rescue rejects identity and readiness drift', () => {
  assert.throws(() => validateDirectRescueHealth(health({ version: 'other' }), { expectedVersion: '2.0.0-aicc.6' }), error => error.code === 'DIRECT_RESCUE_NOT_READY');
  assert.throws(() => validateDirectRescueHealth(health({ accepting_turns: false })), error => error.code === 'DIRECT_RESCUE_NOT_READY');
});

const integrated = (overrides = {}) => ({
  status: 'ok', version: '2.0.0-aicc.17', pid: 76503, port: 17841,
  accepting_turns: true, active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0,
  ...overrides,
});

test('integrated maintenance lease waits for consecutive zero then closes the race with drain', async () => {
  const health = [integrated({ active_http_turns: 2 }), integrated(), integrated(), integrated({ accepting_turns: false })];
  const actions = [];
  const lease = await acquireIntegratedMaintenanceLease({
    fetchHealth: async () => health.shift(),
    control: async action => {
      actions.push(action);
      return action === 'drain'
        ? { status: 'ok', pid: 76503, accepting_turns: false, active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0 }
        : { status: 'ok', accepting_turns: true };
    },
    sleep: async () => {},
    now: (() => { let time = 0; return () => time += 10; })(),
    expectedVersion: '2.0.0-aicc.17',
  });
  assert.equal(lease.samples.length, 2);
  assert.deepEqual(actions, ['drain']);
  await lease.release();
  assert.deepEqual(actions, ['drain', 'resume']);
});

test('integrated maintenance lease compensates a drain race and never returns a lease', async () => {
  const actions = [];
  await assert.rejects(acquireIntegratedMaintenanceLease({
    fetchHealth: async () => integrated(),
    control: async action => {
      actions.push(action);
      return action === 'drain'
        ? { status: 'ok', pid: 76503, accepting_turns: false, active_http_turns: 1, active_browser_http_turns: 0, active_browser_turns: 0 }
        : { status: 'ok', accepting_turns: true };
    },
    sleep: async () => {}, expectedVersion: '2.0.0-aicc.17',
  }), error => error.code === 'INTEGRATED_DRAIN_ACTIVE');
  assert.deepEqual(actions, ['drain', 'resume']);
});

test('integrated maintenance lease fails closed on PID drift, UNKNOWN counters, and timeout', async () => {
  assert.throws(() => validateIntegratedWebHealth(integrated({ active_browser_turns: undefined })), error => error.code === 'INTEGRATED_WEB_COUNTER_UNKNOWN');
  assert.throws(() => validateIntegratedDrainAck({ status: 'ok', pid: 8, accepting_turns: false, active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0 }, { expectedPid: 7 }), error => error.code === 'INTEGRATED_DRAIN_NOT_ACKNOWLEDGED');
  await assert.rejects(acquireIntegratedMaintenanceLease({
    fetchHealth: async () => integrated({ active_http_turns: 1 }),
    control: async () => { throw new Error('must not drain'); },
    sleep: async () => {}, now: (() => { let time = 0; return () => time += 10; })(), maxWaitMs: 25,
  }), error => error.code === 'INTEGRATED_WEB_IDLE_TIMEOUT');
});

test('integrated maintenance lease compensates a timeout after drain delivery', async () => {
  const actions = [];
  await assert.rejects(acquireIntegratedMaintenanceLease({
    fetchHealth: async () => integrated(),
    control: async action => {
      actions.push(action);
      if (action === 'drain') throw new Error('timeout after delivery');
      return { status: 'ok', accepting_turns: true };
    },
    sleep: async () => {},
  }), /timeout after delivery/);
  assert.deepEqual(actions, ['drain', 'resume']);
});

test('post-setup doctor waits for transient readiness and accepts warnings', async () => {
  const reports = [
    { ok: false, checks: [{ id: 'proxy', status: 'error' }] },
    { ok: false, checks: [{ id: 'tunnel-runtime', status: 'error' }] },
    { ok: true, checks: [{ id: 'proxy', status: 'ok' }, { id: 'connector', status: 'warning' }] },
  ];
  const result = await waitForPostSetupDoctor({
    runDoctor: async () => reports.shift(), sleep: async () => {},
    now: (() => { let time = 0; return () => time += 10; })(),
  });
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.warningIds, ['connector']);
});

test('post-setup doctor fails immediately on durable config and credential errors', async () => {
  let attempts = 0;
  await assert.rejects(waitForPostSetupDoctor({
    runDoctor: async () => { attempts += 1; return { ok: false, checks: [{ id: 'tunnel-key', status: 'error' }] }; },
    sleep: async () => {},
  }), error => error.code === 'DOCTOR_FATAL_ERROR' && error.evidence.errorIds[0] === 'tunnel-key');
  assert.equal(attempts, 1);
});

test('post-setup doctor rejects malformed reports and bounded transient timeout', async () => {
  await assert.rejects(waitForPostSetupDoctor({ runDoctor: async () => ({ ok: true, checks: [{ id: 'proxy', status: 'mystery' }] }) }), error => error.code === 'DOCTOR_REPORT_INVALID');
  await assert.rejects(waitForPostSetupDoctor({
    runDoctor: async () => ({ ok: false, checks: [{ id: 'proxy', status: 'error' }] }),
    sleep: async () => {}, now: (() => { let time = 0; return () => time += 10; })(), maxWaitMs: 25,
  }), error => error.code === 'DOCTOR_STABILIZATION_TIMEOUT');
});
