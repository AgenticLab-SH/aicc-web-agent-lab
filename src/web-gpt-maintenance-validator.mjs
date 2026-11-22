export class WebGptMaintenanceValidationError extends Error {
  constructor(code, message, evidence = null) {
    super(message);
    this.name = 'WebGptMaintenanceValidationError';
    this.code = code;
    this.evidence = evidence;
  }
}

function fail(code, message, evidence = null) {
  throw new WebGptMaintenanceValidationError(code, message, evidence);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function componentById(status, id) {
  const component = status?.components?.find(item => item?.id === id);
  if (!component) fail('AGGREGATE_COMPONENT_UNKNOWN', `aggregate status is missing ${id}`);
  return component;
}

export function validateAggregateRescueSummary(summary, options = {}) {
  const expectedPort = options.expectedPort ?? 17842;
  const value = object(summary);
  if (!value) fail('AGGREGATE_RESCUE_UNKNOWN', 'aggregate rescue summary is UNKNOWN');
  const evidence = {
    state: value.state ?? null,
    port: value.port ?? null,
    configured: value.configured ?? null,
    authenticated: value.authenticated ?? null,
    loaded: value.loaded ?? null,
    healthPresent: object(value.health) !== null,
  };
  if (evidence.state !== 'ready' || evidence.port !== expectedPort
    || evidence.configured !== true || evidence.authenticated !== true || evidence.loaded !== true) {
    fail('AGGREGATE_RESCUE_NOT_READY', 'aggregate rescue ownership summary is not ready', evidence);
  }
  return evidence;
}

export function validateDirectRescueHealth(health, options = {}) {
  const expectedPort = options.expectedPort ?? 17842;
  const expectedVersion = options.expectedVersion ?? null;
  const value = object(health);
  if (!value) fail('DIRECT_RESCUE_UNKNOWN', 'direct rescue health is UNKNOWN');
  const evidence = {
    status: value.status ?? null,
    version: value.version ?? null,
    pid: value.pid ?? null,
    port: value.port ?? null,
    acceptingTurns: value.accepting_turns ?? null,
    counters: [value.active_http_turns, value.active_browser_http_turns, value.active_browser_turns],
  };
  if (evidence.status !== 'ok' || !Number.isInteger(evidence.pid) || evidence.pid <= 0
    || evidence.port !== expectedPort || evidence.acceptingTurns !== true
    || (expectedVersion !== null && evidence.version !== expectedVersion)) {
    fail('DIRECT_RESCUE_NOT_READY', 'direct rescue identity/readiness check failed', evidence);
  }
  if (evidence.counters.some(counter => !Number.isInteger(counter))) {
    fail('DIRECT_RESCUE_COUNTER_UNKNOWN', 'direct rescue active counter is UNKNOWN', evidence);
  }
  if (evidence.counters.some(counter => counter !== 0)) {
    fail('DIRECT_RESCUE_ACTIVE', 'direct rescue has active work', evidence);
  }
  return evidence;
}

export async function collectDirectRescueExactSamples(options = {}) {
  const fetchHealth = options.fetchHealth;
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const count = options.count ?? 5;
  const intervalMs = options.intervalMs ?? 1_000;
  if (typeof fetchHealth !== 'function') fail('DIRECT_RESCUE_FETCHER_REQUIRED', 'fetchHealth is required');
  if (!Number.isInteger(count) || count < 2 || count > 10) fail('DIRECT_RESCUE_SAMPLE_COUNT_INVALID', 'sample count must be 2..10');
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    let health;
    try { health = await fetchHealth(); }
    catch (error) {
      fail('DIRECT_RESCUE_FETCH_FAILED', 'direct rescue health fetch failed', {
        sample: index + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    samples.push(validateDirectRescueHealth(health, options));
    if (index + 1 < count) await sleep(intervalMs);
  }
  const pids = [...new Set(samples.map(sample => sample.pid))];
  if (pids.length !== 1) fail('DIRECT_RESCUE_PID_CHANGED', 'direct rescue owner changed across exact samples', { pids });
  return { pid: pids[0], count: samples.length, samples };
}

export async function validateRescueCutoverPreflight(options = {}) {
  if (typeof options.collectAggregate !== 'function') {
    fail('AGGREGATE_FETCHER_REQUIRED', 'collectAggregate is required');
  }
  options.onPhase?.('direct-rescue-exact-samples');
  const direct = await collectDirectRescueExactSamples(options);
  options.onPhase?.('aggregate-rescue-summary');
  let aggregateStatus;
  try { aggregateStatus = await options.collectAggregate(); }
  catch (error) {
    fail('AGGREGATE_FETCH_FAILED', 'aggregate status fetch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const aggregate = validateAggregateRescueSummary(
    options.aggregateIsComponent === true ? aggregateStatus : componentById(aggregateStatus, 'web-gpt-rescue'),
    options,
  );
  return { direct, aggregate };
}

export function validateIntegratedWebHealth(health, options = {}) {
  const expectedPort = options.expectedPort ?? 17841;
  const expectedVersion = options.expectedVersion ?? null;
  const expectedPid = options.expectedPid ?? null;
  const expectedAccepting = options.expectedAccepting ?? true;
  const value = object(health);
  if (!value) fail('INTEGRATED_WEB_UNKNOWN', 'integrated Web GPT health is UNKNOWN');
  const evidence = {
    status: value.status ?? null,
    version: value.version ?? null,
    pid: value.pid ?? null,
    port: value.port ?? null,
    acceptingTurns: value.accepting_turns ?? null,
    counters: [value.active_http_turns, value.active_browser_http_turns, value.active_browser_turns],
  };
  if (evidence.status !== 'ok' || !Number.isInteger(evidence.pid) || evidence.pid <= 0
    || evidence.port !== expectedPort || evidence.acceptingTurns !== expectedAccepting
    || (expectedVersion !== null && evidence.version !== expectedVersion)
    || (expectedPid !== null && evidence.pid !== expectedPid)) {
    fail('INTEGRATED_WEB_NOT_READY', 'integrated Web GPT identity/readiness check failed', evidence);
  }
  if (evidence.counters.some(counter => !Number.isInteger(counter))) {
    fail('INTEGRATED_WEB_COUNTER_UNKNOWN', 'integrated Web GPT active counter is UNKNOWN', evidence);
  }
  return evidence;
}

export function validateIntegratedDrainAck(response, options = {}) {
  const value = object(response);
  const expectedPid = options.expectedPid ?? null;
  if (!value) fail('INTEGRATED_DRAIN_UNKNOWN', 'integrated Web GPT drain response is UNKNOWN');
  const evidence = {
    status: value.status ?? null,
    pid: value.pid ?? expectedPid,
    acceptingTurns: value.accepting_turns ?? null,
    counters: [value.active_http_turns, value.active_browser_http_turns, value.active_browser_turns],
  };
  if (evidence.status !== 'ok' || evidence.acceptingTurns !== false
    || (expectedPid !== null && evidence.pid !== expectedPid)) {
    fail('INTEGRATED_DRAIN_NOT_ACKNOWLEDGED', 'integrated Web GPT did not acknowledge the drain contract', evidence);
  }
  if (evidence.counters.some(counter => !Number.isInteger(counter))) {
    fail('INTEGRATED_DRAIN_COUNTER_UNKNOWN', 'integrated Web GPT drain counter is UNKNOWN', evidence);
  }
  if (evidence.counters.some(counter => counter !== 0)) {
    fail('INTEGRATED_DRAIN_ACTIVE', 'integrated Web GPT drain raced with active work', evidence);
  }
  return evidence;
}

export async function acquireIntegratedMaintenanceLease(options = {}) {
  const fetchHealth = options.fetchHealth;
  const control = options.control;
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const sampleCount = options.sampleCount ?? 2;
  const intervalMs = options.intervalMs ?? 250;
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  if (typeof fetchHealth !== 'function') fail('INTEGRATED_WEB_FETCHER_REQUIRED', 'fetchHealth is required');
  if (typeof control !== 'function') fail('INTEGRATED_WEB_CONTROL_REQUIRED', 'control is required');
  if (!Number.isInteger(sampleCount) || sampleCount < 2 || sampleCount > 10) {
    fail('INTEGRATED_WEB_SAMPLE_COUNT_INVALID', 'sampleCount must be 2..10');
  }

  const deadline = now() + maxWaitMs;
  const samples = [];
  let ownerPid = options.expectedPid ?? null;
  while (now() <= deadline) {
    let raw;
    try { raw = await fetchHealth(); }
    catch (error) {
      fail('INTEGRATED_WEB_FETCH_FAILED', 'integrated Web GPT health fetch failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const sample = validateIntegratedWebHealth(raw, { ...options, expectedPid: ownerPid });
    ownerPid ??= sample.pid;
    if (sample.counters.every(counter => counter === 0)) samples.push(sample);
    else samples.length = 0;
    if (samples.length >= sampleCount) break;
    await sleep(intervalMs);
  }
  if (samples.length < sampleCount) {
    fail('INTEGRATED_WEB_IDLE_TIMEOUT', 'integrated Web GPT did not reach consecutive exact idle', {
      expectedPid: ownerPid,
      sampleCount,
      maxWaitMs,
    });
  }

  let drainAttempted = false;
  let drained = false;
  try {
    drainAttempted = true;
    const drain = validateIntegratedDrainAck(await control('drain'), { expectedPid: ownerPid });
    drained = true;
    const postHealth = validateIntegratedWebHealth(await fetchHealth(), {
      ...options,
      expectedPid: ownerPid,
      expectedAccepting: false,
    });
    if (postHealth.counters.some(counter => counter !== 0)) {
      fail('INTEGRATED_POST_DRAIN_ACTIVE', 'integrated Web GPT became active after drain', postHealth);
    }
    return {
      pid: ownerPid,
      samples,
      drain,
      postHealth,
      release: async () => {
        if (!drained) return;
        const resume = object(await control('resume'));
        if (!resume || resume.status !== 'ok' || resume.accepting_turns !== true) {
          fail('INTEGRATED_RESUME_FAILED', 'integrated Web GPT did not resume accepting turns');
        }
        drained = false;
      },
    };
  } catch (error) {
    let resumeError = null;
    if (drainAttempted) {
      try { await control('resume'); drained = false; }
      catch (caught) { resumeError = caught instanceof Error ? caught.message : String(caught); }
    }
    if (resumeError !== null) {
      fail('INTEGRATED_DRAIN_COMPENSATION_FAILED', `${error instanceof Error ? error.message : String(error)}; compensating resume failed`, { resumeError });
    }
    throw error;
  }
}

export async function waitForPostSetupDoctor(options = {}) {
  const runDoctor = options.runDoctor;
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 500;
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const fatalIds = new Set(options.fatalIds ?? ['config', 'codex', 'tunnel-binary', 'tunnel-key']);
  if (typeof runDoctor !== 'function') fail('DOCTOR_RUNNER_REQUIRED', 'runDoctor is required');
  const deadline = now() + maxWaitMs;
  let attempts = 0;
  let latest = null;
  while (now() <= deadline) {
    attempts += 1;
    let report;
    try { report = await runDoctor(); }
    catch (error) {
      fail('DOCTOR_RUN_FAILED', 'post-setup doctor execution failed', {
        attempts,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!object(report) || !Array.isArray(report.checks)
      || report.checks.some(check => !object(check) || typeof check.id !== 'string'
        || !['ok', 'warning', 'error'].includes(check.status))) {
      fail('DOCTOR_REPORT_INVALID', 'post-setup doctor report is invalid', { attempts });
    }
    const statuses = report.checks.map(check => ({ id: check.id, status: check.status }));
    latest = { ok: report.ok === true, statuses };
    const errors = statuses.filter(check => check.status === 'error');
    if (report.ok === true && errors.length === 0) {
      return { attempts, warningIds: statuses.filter(check => check.status === 'warning').map(check => check.id), statuses };
    }
    const fatal = errors.filter(check => fatalIds.has(check.id));
    if (fatal.length > 0) {
      fail('DOCTOR_FATAL_ERROR', 'post-setup doctor reported a non-transient error', { attempts, errorIds: fatal.map(check => check.id), statuses });
    }
    await sleep(intervalMs);
  }
  fail('DOCTOR_STABILIZATION_TIMEOUT', 'post-setup doctor did not stabilize within the bounded wait', { attempts, latest, maxWaitMs });
}
