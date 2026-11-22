import crypto from 'node:crypto';

const PHASES = new Set([
  'accepted',
  'app_server_started',
  'route_selected',
  'router_started',
  'upstream_started',
  'browser_started',
  'first_progress',
  'response_received',
  'stalled_unknown',
  'terminal'
]);
const TERMINALS = new Set(['completed', 'failed', 'interrupted', 'uncertain', 'hold']);

function hashIdentity(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function knownCounter(value) {
  return Number.isInteger(value) && value >= 0;
}

export class RequestTraceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RequestTraceError';
    this.code = code;
  }
}

export class RequestTraceRecorder {
  constructor({ journal, requestId, taskId, routeGeneration, modelHash } = {}) {
    if (!journal || typeof journal.append !== 'function') throw new RequestTraceError('journal_required', 'attempt journal is required');
    if (!requestId || !taskId || !routeGeneration || !modelHash) throw new RequestTraceError('trace_identity_required', 'request, task, route generation and model hash are required');
    this.journal = journal;
    this.identity = Object.freeze({
      requestIdHash: hashIdentity(requestId),
      taskIdHash: hashIdentity(taskId),
      routeGenerationHash: hashIdentity(routeGeneration),
      modelHash: String(modelHash)
    });
    this.phase = null;
    this.terminal = null;
  }

  record(phase, metadata = {}) {
    if (!PHASES.has(phase)) throw new RequestTraceError('phase_invalid', `unsupported request phase: ${phase}`);
    if (this.terminal) throw new RequestTraceError('request_terminal', `request is already terminal: ${this.terminal}`);
    if (phase === 'accepted' && this.phase !== null) throw new RequestTraceError('phase_conflict', 'accepted must be the first phase');
    if (phase !== 'accepted' && this.phase === null) throw new RequestTraceError('phase_conflict', 'accepted must be recorded first');
    if (phase === 'first_progress' && ['response_received', 'stalled_unknown'].includes(this.phase)) {
      throw new RequestTraceError('phase_conflict', `first progress cannot follow ${this.phase}`);
    }
    if (phase === 'stalled_unknown' && this.phase === 'first_progress') {
      throw new RequestTraceError('phase_conflict', 'a request with first progress is not a pre-first-action stall');
    }
    const event = this.journal.append('request_phase', { ...this.identity, phase, ...metadata });
    this.phase = phase;
    return event;
  }

  finish(terminal, metadata = {}) {
    if (!TERMINALS.has(terminal)) throw new RequestTraceError('terminal_invalid', `unsupported request terminal: ${terminal}`);
    if (this.phase === null) throw new RequestTraceError('phase_conflict', 'accepted must be recorded before terminal');
    const event = this.journal.append('terminal', { ...this.identity, phase: 'terminal', terminal, ...metadata });
    this.phase = 'terminal';
    this.terminal = terminal;
    return event;
  }
}

export function classifyPreFirstActionStall({
  taskStartedAtMs,
  firstProgressAtMs = null,
  observedAtMs,
  thresholdMs = 60_000,
  requestIdentityKnown = false,
  processIdentityKnown = false
} = {}) {
  if (!Number.isFinite(taskStartedAtMs) || !Number.isFinite(observedAtMs) || !Number.isFinite(thresholdMs) || thresholdMs < 1) {
    throw new RequestTraceError('stall_input_invalid', 'valid task start, observation and threshold values are required');
  }
  if (Number.isFinite(firstProgressAtMs)) {
    return { stalled: false, state: 'progress_observed', elapsedMs: Math.max(0, firstProgressAtMs - taskStartedAtMs), resendAllowed: false, killAllowed: false, nativeHandoffAllowed: false };
  }
  const elapsedMs = Math.max(0, observedAtMs - taskStartedAtMs);
  if (elapsedMs < thresholdMs) {
    return { stalled: false, state: 'waiting_for_first_progress', elapsedMs, resendAllowed: false, killAllowed: false, nativeHandoffAllowed: false };
  }
  return {
    stalled: true,
    state: 'stalled_unknown',
    elapsedMs,
    resendAllowed: false,
    killAllowed: false,
    nativeHandoffAllowed: requestIdentityKnown === true && processIdentityKnown === true,
    reconcileRequired: true
  };
}

export function evaluateIntegratedRouteReadiness({
  branch,
  listener,
  serviceIdentityCurrent,
  runtimeBundleCurrent,
  acceptingTurns,
  acceptingBrowserTurns,
  activeHttpTurns,
  activeBrowserHttpTurns,
  activeBrowserTurns,
  broker,
  browser,
  nativeUpstream,
  canary
} = {}) {
  if (!['web', 'native'].includes(branch)) throw new RequestTraceError('branch_invalid', 'branch must be web or native');
  const reasons = [];
  if (listener?.ready !== true) reasons.push(listener?.ready === false ? 'listener_not_ready' : 'listener_unknown');
  if (serviceIdentityCurrent !== true) reasons.push(serviceIdentityCurrent === false ? 'service_identity_drift' : 'service_identity_unknown');
  if (runtimeBundleCurrent !== true) reasons.push(runtimeBundleCurrent === false ? 'runtime_bundle_drift' : 'runtime_bundle_unknown');
  if (acceptingTurns !== true) reasons.push(acceptingTurns === false ? 'turns_not_accepted' : 'accepting_turns_unknown');
  for (const [name, value] of Object.entries({ activeHttpTurns, activeBrowserHttpTurns, activeBrowserTurns })) {
    if (!knownCounter(value)) reasons.push(`${name}_unknown`);
    else if (value !== 0) reasons.push(`${name}_nonzero`);
  }
  if (broker?.ready !== true) reasons.push(broker?.ready === false ? 'broker_not_ready' : 'broker_unknown');
  if (branch === 'web') {
    if (acceptingBrowserTurns !== true) reasons.push(acceptingBrowserTurns === false ? 'browser_turns_not_accepted' : 'accepting_browser_turns_unknown');
    if (browser?.ready !== true) reasons.push(browser?.ready === false ? 'browser_not_ready' : 'browser_unknown');
  } else if (nativeUpstream?.ready !== true) {
    reasons.push(nativeUpstream?.ready === false ? 'native_upstream_not_ready' : 'native_upstream_unknown');
  }
  if (canary?.status !== 'pass' || canary?.bounded !== true || canary?.generationCurrent !== true) reasons.push('bounded_canary_missing_or_stale');
  return { ready: reasons.length === 0, branch, reasons, failClosed: reasons.length > 0 };
}

export function classifyRouteFailure({ httpStatus = null, branch = null, upstreamStarted = false, browserStarted = false } = {}) {
  if (httpStatus === 502) {
    if (branch === 'native' && upstreamStarted) return { type: 'native_upstream_bad_gateway', retryAllowed: false, reconcileRequired: true };
    return { type: 'route_bad_gateway_unknown', retryAllowed: false, reconcileRequired: true };
  }
  if (httpStatus === 503) {
    if (branch === 'web' && browserStarted) return { type: 'browser_or_provider_unavailable', retryAllowed: false, reconcileRequired: true };
    return { type: 'route_unavailable_unknown', retryAllowed: false, reconcileRequired: true };
  }
  return { type: 'request_failure_unknown', retryAllowed: false, reconcileRequired: true };
}
