const ROUTE_KINDS = Object.freeze(['code', 'cli', 'api', 'mcp', 'browser']);
const ROUTE_STATES = new Set(['ready', 'succeeded', 'failed', 'unavailable', 'prohibited', 'not_applicable']);
const HUMAN_ONLY_REASONS = new Set([
  'biometric',
  'captcha',
  'credential_entry',
  'current_screen_authorization',
  'identity_verification',
  'legal_acceptance',
  'mfa_or_otp',
  'payment_confirmation',
  'physical_presence',
  'subjective_owner_decision',
  'uac_secure_desktop'
]);
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,500}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

export class AgenticInterventionError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'AgenticInterventionError';
    this.code = code;
    this.details = details;
  }
}

function requiredId(value, label) {
  const normalized = String(value ?? '').trim();
  if (!SAFE_ID.test(normalized)) throw new AgenticInterventionError(`invalid_${label}`);
  return normalized;
}

function requiredText(value, label, maxLength = 200) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maxLength || !SAFE_TEXT.test(normalized)) {
    throw new AgenticInterventionError(`invalid_${label}`);
  }
  return normalized;
}

function normalizeRoutes(value) {
  if (!Array.isArray(value)) throw new AgenticInterventionError('autonomous_routes_required');
  const seen = new Set();
  return value.map(route => {
    const kind = String(route?.kind ?? '').trim();
    const state = String(route?.state ?? '').trim();
    if (!ROUTE_KINDS.includes(kind)) throw new AgenticInterventionError('invalid_route_kind');
    if (!ROUTE_STATES.has(state)) throw new AgenticInterventionError('invalid_route_state');
    if (seen.has(kind)) throw new AgenticInterventionError('duplicate_route_kind');
    seen.add(kind);
    return Object.freeze({ kind, state });
  });
}

function normalizeComputerUse(value) {
  if (!value || typeof value !== 'object') throw new AgenticInterventionError('computer_use_state_required');
  const state = String(value.state ?? '').trim();
  if (!['untried', 'succeeded', 'failed', 'unavailable', 'prohibited', 'not_applicable'].includes(state)) {
    throw new AgenticInterventionError('invalid_computer_use_state');
  }
  if (typeof value.available !== 'boolean' || typeof value.currentScreenAuthorized !== 'boolean') {
    throw new AgenticInterventionError('invalid_computer_use_capability');
  }
  return Object.freeze({
    state,
    available: value.available,
    currentScreenAuthorized: value.currentScreenAuthorized
  });
}

function notificationType(request) {
  return request.approvalRequired === true ? 'approval_required' : 'user_response_required';
}

function buildNotification(request, reason) {
  const type = notificationType(request);
  return Object.freeze({
    eventId: requiredId(request.eventId, 'event_id'),
    type,
    urgency: type === 'approval_required' ? 4 : 3,
    sensitivity: request.sensitivity === 'restricted' ? 'restricted' : 'internal',
    source: requiredId(request.source ?? 'codex-agent', 'source'),
    projectKey: requiredId(request.projectKey, 'project_key'),
    owner: requiredId(request.owner ?? 'root', 'owner'),
    taskId: requiredId(request.taskId, 'task_id'),
    correlationId: requiredId(request.correlationId ?? request.eventId, 'correlation_id'),
    title: requiredText(request.title, 'title', 80),
    summary: requiredText(request.summary, 'summary', 200),
    nextGate: requiredText(request.nextGate, 'next_gate', 120),
    interventionReason: reason
  });
}

export function planAgenticIntervention(request) {
  if (!request || typeof request !== 'object') throw new AgenticInterventionError('intervention_request_required');
  if (request.schemaVersion !== 1) throw new AgenticInterventionError('unsupported_intervention_schema');
  const routes = normalizeRoutes(request.autonomousRoutes);
  const computerUse = normalizeComputerUse(request.computerUse);

  if (routes.some(route => route.state === 'succeeded') || computerUse.state === 'succeeded') {
    return Object.freeze({ ok: true, action: 'complete', reason: 'goal_satisfied', notification: null });
  }

  const ready = ROUTE_KINDS.map(kind => routes.find(route => route.kind === kind))
    .find(route => route?.state === 'ready');
  if (ready) {
    return Object.freeze({ ok: true, action: 'continue_automatic', reason: 'autonomous_route_ready', route: ready.kind, notification: null });
  }

  if (computerUse.state === 'untried' && computerUse.available && computerUse.currentScreenAuthorized) {
    return Object.freeze({ ok: true, action: 'use_computer', reason: 'authorized_computer_use_ready', route: 'computer_use', notification: null });
  }

  let reason = String(request.humanOnlyReason ?? '').trim();
  if (reason && !HUMAN_ONLY_REASONS.has(reason)) throw new AgenticInterventionError('invalid_human_only_reason');
  if (!reason && computerUse.state === 'untried' && computerUse.available && !computerUse.currentScreenAuthorized) {
    reason = 'current_screen_authorization';
  }
  if (!reason) reason = 'autonomous_routes_exhausted';

  return Object.freeze({
    ok: true,
    action: 'notify_user',
    reason,
    notification: buildNotification(request, reason)
  });
}

export const agenticInterventionContract = Object.freeze({
  routeOrder: [...ROUTE_KINDS, 'computer_use'],
  humanOnlyReasons: [...HUMAN_ONLY_REASONS],
  rule: 'notify only after no permitted autonomous route remains'
});
