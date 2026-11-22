import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { DurableJobStore } from '../jobs/durable-store.mjs';
import { planNotification } from '../notification-policy.mjs';

export const NOTIFICATION_OUTBOX_SCHEMA_VERSION = 1;

export const notificationOutboxStates = Object.freeze([
  'record-only',
  'waiting',
  'sending',
  'retry',
  'sent',
  'acknowledged',
  'cancelled',
  'hold'
]);

export const DEFAULT_NOTIFICATION_DELAYS_MS = Object.freeze({
  1: null,
  2: 120_000,
  3: 60_000,
  4: 0,
  5: 0
});

const TERMINAL_STATES = new Set(['record-only', 'sent', 'acknowledged', 'cancelled', 'hold']);
const ACKNOWLEDGEABLE_STATES = new Set(['waiting', 'retry']);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{5,159}$/;
const SAFE_PROJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/;
const SAFE_DISPATCHER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/;
const SAFE_DELIVERY_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SAFE_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const FORBIDDEN_RAW_KEY = /^(?:apiKey|api_key|authorization|bearer|cookie|cookies|credential|credentials|password|refreshToken|refresh_token|secret|session|token)$/i;
const SECRET_LIKE_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\b(?:api[_-]?key|authorization|cookie|password|refresh[_-]?token|secret|token)\s*[:=]\s*\S+|\bsk-[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,})/i;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RENDERED_MESSAGE_BYTES = 4_096;

export class NotificationOutboxError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = 'NotificationOutboxError';
    this.code = code;
    this.details = details;
  }
}

function iso(value) {
  return new Date(value).toISOString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
}

function stableHash(value) {
  return sha256(JSON.stringify(stableObject(value)));
}

function requireSafeIdentifier(value, label, pattern = SAFE_IDENTIFIER) {
  const normalized = String(value ?? '').trim();
  if (!pattern.test(normalized) || SECRET_LIKE_VALUE.test(normalized)) {
    throw new NotificationOutboxError(`invalid_${label}`, `${label} is invalid or secret-like`);
  }
  return normalized;
}

function optionalSafeIdentifier(value, label, pattern = SAFE_IDENTIFIER) {
  if (value == null || value === '') return null;
  return requireSafeIdentifier(value, label, pattern);
}

function rejectForbiddenRawFields(value, location = 'event', seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new NotificationOutboxError('invalid_event', 'notification event cannot contain cyclic data');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RAW_KEY.test(key)) {
      throw new NotificationOutboxError('sensitive_raw_field_prohibited', `${location}.${key} cannot be accepted`);
    }
    rejectForbiddenRawFields(child, `${location}.${key}`, seen);
  }
  seen.delete(value);
}

function parseOptionalTimestamp(value, label) {
  if (value == null || value === '') return null;
  const milliseconds = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new NotificationOutboxError(`invalid_${label}`, `${label} must be an ISO timestamp or epoch milliseconds`);
  }
  return milliseconds;
}

function requireExpectedVersion(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new NotificationOutboxError('expected_version_required', 'expectedVersion must be a positive integer');
  }
  return value;
}

function ensureNamespace(state) {
  if (state.notificationOutbox == null) {
    state.notificationOutbox = {
      schemaVersion: NOTIFICATION_OUTBOX_SCHEMA_VERSION,
      events: {},
      dedupe: {}
    };
  }
  const outbox = state.notificationOutbox;
  if (
    !outbox || typeof outbox !== 'object' || Array.isArray(outbox)
    || outbox.schemaVersion !== NOTIFICATION_OUTBOX_SCHEMA_VERSION
    || !outbox.events || typeof outbox.events !== 'object' || Array.isArray(outbox.events)
    || !outbox.dedupe || typeof outbox.dedupe !== 'object' || Array.isArray(outbox.dedupe)
  ) {
    throw new NotificationOutboxError('outbox_state_invalid', 'notification outbox state is invalid');
  }
  return outbox;
}

function purgePayload(record, at) {
  record.payload = null;
  record.payloadPurgedAt = iso(at);
  record.lease = null;
  record.retryAt = null;
}

function transition(record, nextState, at, reason = null) {
  record.state = nextState;
  record.version += 1;
  record.updatedAt = iso(at);
  record.terminalReason = reason;
  if (TERMINAL_STATES.has(nextState)) purgePayload(record, at);
}

function publicRecord(record) {
  return {
    schemaVersion: record.schemaVersion,
    eventId: record.eventId,
    projectKey: record.projectKey,
    taskId: record.taskId,
    type: record.type,
    urgency: record.urgency,
    urgencyLabel: record.urgencyLabel,
    sensitivity: record.sensitivity,
    sourceHash: record.sourceHash,
    state: record.state,
    version: record.version,
    dueAt: record.dueAt,
    retryAt: record.retryAt,
    expiresAt: record.expiresAt,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    payloadHash: record.payloadHash,
    payloadPresent: typeof record.payload === 'string',
    payloadPurgedAt: record.payloadPurgedAt,
    dedupeKeyHash: record.dedupeKey ? sha256(record.dedupeKey) : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sentAt: record.sentAt,
    acknowledgedAt: record.acknowledgedAt,
    cancelledAt: record.cancelledAt,
    heldAt: record.heldAt,
    terminalReason: record.terminalReason,
    lastErrorCode: record.lastErrorCode,
    deliveryRef: record.deliveryRef,
    activeLease: record.state === 'sending' && record.lease
      ? { dispatcherId: record.lease.dispatcherId, expiresAt: record.lease.expiresAt }
      : null
  };
}

function defaultPlanner(event) {
  return planNotification(event, { slack: true, telegram: false }, { routingProfile: 'slack_primary' });
}

function plannedEvent(event, planner) {
  rejectForbiddenRawFields(event);
  const eventId = requireSafeIdentifier(event?.eventId, 'event_id');
  const projectKey = requireSafeIdentifier(event?.projectKey, 'project_key', SAFE_PROJECT_KEY);
  const taskId = requireSafeIdentifier(event?.taskId, 'task_id');
  let plan;
  try {
    plan = planner(event);
  } catch (error) {
    if (error instanceof NotificationOutboxError) throw error;
    throw new NotificationOutboxError('notification_plan_rejected', 'notification planner rejected the event', {
      cause: String(error?.message ?? error)
    });
  }
  if (plan && typeof plan.then === 'function') {
    throw new NotificationOutboxError('async_planner_unsupported', 'notification planner must be deterministic and synchronous');
  }
  if (!plan || typeof plan !== 'object' || !plan.event || plan.ok === false) {
    throw new NotificationOutboxError('notification_plan_unavailable', 'notification planner did not produce a deliverable plan');
  }
  const plannedUrgency = Number(plan.event.urgency);
  const expectedPrimaryChannel = plannedUrgency === 1 ? null : 'slack';
  if (plan.routingProfile !== 'slack_primary' || plan.primaryChannel !== expectedPrimaryChannel) {
    throw new NotificationOutboxError(
      'notification_plan_unavailable',
      'notification_plan_unavailable: explicit Slack-primary plan required',
      { reason: 'slack_primary_plan_required' }
    );
  }
  if (
    String(plan.event.eventId ?? '') !== eventId
    || String(plan.event.projectKey ?? '') !== projectKey
    || String(plan.event.taskId ?? '') !== taskId
  ) {
    throw new NotificationOutboxError('notification_plan_identity_mismatch', 'planner changed the notification identity');
  }
  const urgency = plannedUrgency;
  if (!Number.isInteger(urgency) || urgency < 1 || urgency > 5) {
    throw new NotificationOutboxError('invalid_urgency', 'planned urgency must be between 1 and 5');
  }
  const expiresAtMs = parseOptionalTimestamp(plan.event.expiresAt, 'expires_at');
  const slackDelivery = Array.isArray(plan.deliveries)
    ? plan.deliveries.find(item => item?.channel === 'slack' && item?.role === 'primary' && item?.state === 'planned')
    : null;
  let message = null;
  if (urgency !== 1) {
    message = String(slackDelivery?.message ?? '');
    if (!message.trim()) {
      throw new NotificationOutboxError('slack_delivery_not_planned', 'planned notification has no Slack delivery');
    }
    if (Buffer.byteLength(message, 'utf8') > MAX_RENDERED_MESSAGE_BYTES || message.includes('\0')) {
      throw new NotificationOutboxError('rendered_payload_invalid', 'rendered notification payload is invalid');
    }
  }
  return {
    eventId,
    projectKey,
    taskId,
    type: requireSafeIdentifier(plan.event.type, 'event_type', /^[A-Za-z][A-Za-z0-9._:-]{2,79}$/),
    urgency,
    urgencyLabel: String(plan.event.urgencyLabel ?? '').slice(0, 16) || null,
    sensitivity: String(plan.event.sensitivity ?? 'internal').slice(0, 32),
    sourceHash: sha256(String(plan.event.source ?? 'unknown')),
    expiresAtMs,
    message,
    payloadHash: message == null ? null : sha256(message)
  };
}

function safeDeliveryReference(result) {
  if (!result || typeof result !== 'object') return null;
  const candidate = result.deliveryId ?? result.messageTs ?? result.externalId ?? null;
  if (candidate == null) return null;
  const normalized = String(candidate).trim();
  return SAFE_DELIVERY_REF.test(normalized) && !SECRET_LIKE_VALUE.test(normalized) ? normalized : null;
}

function safeErrorCode(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if (status === 429) return 'rate_limited';
  const candidate = String(error?.code ?? error?.error ?? 'delivery_failed').trim();
  return SAFE_ERROR_CODE.test(candidate) ? candidate : 'delivery_failed';
}

function retryAfterMilliseconds(value) {
  const explicitMs = Number(value?.retryAfterMs);
  if (Number.isFinite(explicitMs) && explicitMs >= 0) return explicitMs;
  const detailSeconds = Number(value?.details?.retryAfterSeconds);
  if (Number.isFinite(detailSeconds) && detailSeconds >= 0) return detailSeconds * 1_000;
  const seconds = Number(value?.retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const header = Number(value?.headers?.get?.('retry-after') ?? value?.headers?.['retry-after']);
  if (Number.isFinite(header) && header >= 0) return header * 1_000;
  return null;
}

export function defaultNotificationOutboxRoot(options = {}) {
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT ?? path.join(os.homedir(), '.ai-control-center');
  if (!path.isAbsolute(stateRoot)) {
    throw new NotificationOutboxError('invalid_state_root', 'AICC notification state root must be absolute');
  }
  return path.join(stateRoot, 'notifications', 'outbox');
}

export class NotificationOutboxService {
  constructor({
    root,
    store,
    now = () => Date.now(),
    planner = defaultPlanner,
    deliver = null,
    leaseDurationMs = 30_000,
    maxAttempts = 3,
    baseRetryDelayMs = 15_000,
    maxRetryDelayMs = 15 * 60_000
  } = {}) {
    if (store && root) throw new NotificationOutboxError('ambiguous_store', 'provide either root or store, not both');
    if (!store && root != null && !path.isAbsolute(root)) {
      throw new NotificationOutboxError('invalid_root', 'notification outbox root must be absolute');
    }
    if (typeof planner !== 'function') throw new NotificationOutboxError('planner_required', 'planner must be a function');
    if (deliver != null && typeof deliver !== 'function') throw new NotificationOutboxError('delivery_required', 'deliver must be a function');
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1_000) {
      throw new NotificationOutboxError('invalid_lease_duration', 'leaseDurationMs must be at least 1000');
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
      throw new NotificationOutboxError('invalid_max_attempts', 'maxAttempts must be between 1 and 20');
    }
    if (!Number.isInteger(baseRetryDelayMs) || baseRetryDelayMs < 0) {
      throw new NotificationOutboxError('invalid_retry_delay', 'baseRetryDelayMs must be a non-negative integer');
    }
    if (!Number.isInteger(maxRetryDelayMs) || maxRetryDelayMs < baseRetryDelayMs) {
      throw new NotificationOutboxError('invalid_retry_delay', 'maxRetryDelayMs must be at least baseRetryDelayMs');
    }
    this.now = now;
    this.planner = planner;
    this.deliver = deliver;
    this.leaseDurationMs = leaseDurationMs;
    this.maxAttempts = maxAttempts;
    this.baseRetryDelayMs = baseRetryDelayMs;
    this.maxRetryDelayMs = maxRetryDelayMs;
    if (store && Number(store.maxJournalRecords) > 1) {
      throw new NotificationOutboxError(
        'dedicated_store_compaction_required',
        'notification outbox store must compact after every state transition'
      );
    }
    this.store = store ?? new DurableJobStore({
      root: root ?? defaultNotificationOutboxRoot(),
      now,
      maxJournalRecords: 1
    });
  }

  arm(event, { dedupeKey = null } = {}) {
    const planned = plannedEvent(event, this.planner);
    const normalizedDedupeKey = optionalSafeIdentifier(dedupeKey, 'dedupe_key');
    const now = this.now();
    const delayMs = DEFAULT_NOTIFICATION_DELAYS_MS[planned.urgency];
    const dueAtMs = delayMs == null ? null : now + delayMs;
    const fingerprintHash = stableHash({
      projectKey: planned.projectKey,
      taskId: planned.taskId,
      type: planned.type,
      urgency: planned.urgency,
      sensitivity: planned.sensitivity,
      payloadHash: planned.payloadHash,
      expiresAt: planned.expiresAtMs,
      dedupeKey: normalizedDedupeKey
    });

    return this.store.transaction('notification.arm', state => {
      const outbox = ensureNamespace(state);
      const duplicateFor = (existing, source) => {
        if (existing.fingerprintHash !== fingerprintHash) {
          throw new NotificationOutboxError('idempotency_conflict', `${source} already identifies a different notification`);
        }
        return { notification: publicRecord(existing), duplicate: true, deduplicatedBy: source };
      };
      const existingById = outbox.events[planned.eventId];
      if (existingById) return duplicateFor(existingById, 'eventId');
      const dedupeIdentity = normalizedDedupeKey ? `${planned.projectKey}:${normalizedDedupeKey}` : null;
      if (dedupeIdentity) {
        const existingId = outbox.dedupe[dedupeIdentity];
        const existing = existingId ? outbox.events[existingId] : null;
        if (existing) return duplicateFor(existing, 'dedupeKey');
        if (existingId) delete outbox.dedupe[dedupeIdentity];
      }

      let recordState = planned.urgency === 1 ? 'record-only' : 'waiting';
      let terminalReason = planned.urgency === 1 ? 'record_only_policy' : null;
      if (recordState === 'waiting' && planned.expiresAtMs != null && planned.expiresAtMs <= dueAtMs) {
        recordState = 'cancelled';
        terminalReason = 'expires_before_due';
      }
      const at = iso(now);
      const record = {
        schemaVersion: NOTIFICATION_OUTBOX_SCHEMA_VERSION,
        eventId: planned.eventId,
        projectKey: planned.projectKey,
        taskId: planned.taskId,
        type: planned.type,
        urgency: planned.urgency,
        urgencyLabel: planned.urgencyLabel,
        sensitivity: planned.sensitivity,
        sourceHash: planned.sourceHash,
        state: recordState,
        version: 1,
        dueAt: dueAtMs == null ? null : iso(dueAtMs),
        retryAt: null,
        expiresAt: planned.expiresAtMs == null ? null : iso(planned.expiresAtMs),
        attempts: 0,
        maxAttempts: this.maxAttempts,
        payload: recordState === 'waiting' ? planned.message : null,
        payloadHash: planned.payloadHash,
        payloadPurgedAt: recordState === 'waiting' ? null : at,
        dedupeKey: normalizedDedupeKey,
        fingerprintHash,
        lease: null,
        deliveryRef: null,
        lastErrorCode: null,
        createdAt: at,
        updatedAt: at,
        sentAt: null,
        acknowledgedAt: null,
        cancelledAt: recordState === 'cancelled' ? at : null,
        heldAt: null,
        terminalReason
      };
      outbox.events[record.eventId] = record;
      if (dedupeIdentity) outbox.dedupe[dedupeIdentity] = record.eventId;
      return { notification: publicRecord(record), duplicate: false, deduplicatedBy: null };
    }).result;
  }

  // Explicit recovery of a known pre-post credential-read failure only. The
  // exact original event/body and CAS revision remain authoritative; no replay
  // of a network/unknown delivery and no new event identity or attempt reset.
  recoverCredentialReadFailure(event, { expectedVersion, dedupeKey = null } = {}) {
    requireExpectedVersion(expectedVersion);
    const before=this.status({eventId:event.eventId,projectKey:event.projectKey,taskId:event.taskId});
    if(before.version!==expectedVersion)throw new NotificationOutboxError('notification_version_conflict');
    const original = this.arm(event, { dedupeKey });
    if (!original.duplicate) throw new NotificationOutboxError('existing_notification_required');
    const now = this.now();
    return this.store.transaction('notification.recover.credential-read', state => {
      const record = ensureNamespace(state).events[event.eventId];
      if (record.version !== expectedVersion) throw new NotificationOutboxError('notification_version_conflict');
      if (record.state !== 'hold' || record.lastErrorCode !== 'slack_bot_token_unavailable'
        || record.terminalReason !== 'attempts_exhausted' || record.deliveryRef || record.sentAt
        || record.lease || record.credentialRecoveryCount || record.credentialReadFailureCount !== record.attempts || event.type !== 'report_ready'
        || event.sensitivity !== 'internal') throw new NotificationOutboxError('credential_recovery_not_safe');
      const planned = plannedEvent(event, this.planner);
      if (record.payloadHash !== planned.payloadHash || (record.expiresAt && Date.parse(record.expiresAt) <= now))
        throw new NotificationOutboxError('credential_recovery_payload_or_expiry_mismatch');
      record.credentialRecoveryCount = 1;
      record.maxAttempts = record.attempts + 1;
      record.payload = planned.message;
      record.payloadPurgedAt = null;
      record.state = 'waiting';
      record.version += 1;
      record.updatedAt = iso(now);
      record.dueAt = iso(now);
      record.retryAt = null;
      record.terminalReason = 'explicit_credential_read_recovery';
      return { notification: publicRecord(record), recovered: true };
    }).result;
  }

  ack({ projectKey, taskId, eventId = null, expectedVersion = null } = {}) {
    const project = requireSafeIdentifier(projectKey, 'project_key', SAFE_PROJECT_KEY);
    const task = requireSafeIdentifier(taskId, 'task_id');
    const exactEventId = optionalSafeIdentifier(eventId, 'event_id');
    if (expectedVersion != null && !exactEventId) {
      throw new NotificationOutboxError('event_id_required', 'expectedVersion requires an exact eventId');
    }
    const version = expectedVersion == null ? null : requireExpectedVersion(expectedVersion);
    const now = this.now();
    return this.store.transaction('notification.ack', state => {
      const outbox = ensureNamespace(state);
      let matches;
      if (exactEventId) {
        const record = outbox.events[exactEventId];
        if (!record || record.projectKey !== project || record.taskId !== task) {
          throw new NotificationOutboxError('notification_scope_not_found', 'notification was not found in the exact task scope');
        }
        if (version != null && record.version !== version) {
          throw new NotificationOutboxError('version_conflict', 'notification version changed', { currentVersion: record.version });
        }
        matches = [record];
      } else {
        matches = Object.values(outbox.events).filter(record => record.projectKey === project && record.taskId === task);
        if (!matches.length) {
          throw new NotificationOutboxError('notification_scope_not_found', 'no notifications exist in the exact task scope');
        }
      }

      const acknowledged = [];
      const inFlight = [];
      const unchanged = [];
      for (const record of matches) {
        if (ACKNOWLEDGEABLE_STATES.has(record.state)) {
          transition(record, 'acknowledged', now, 'same_task_acknowledged');
          record.acknowledgedAt = iso(now);
          acknowledged.push(publicRecord(record));
        } else if (record.state === 'sending') {
          inFlight.push(publicRecord(record));
        } else {
          unchanged.push(publicRecord(record));
        }
      }
      if (exactEventId && inFlight.length) {
        throw new NotificationOutboxError('delivery_in_progress', 'notification delivery is already in progress');
      }
      return { acknowledged, inFlight, unchanged };
    }).result;
  }

  cancel({ projectKey, taskId, eventId, expectedVersion } = {}) {
    const project = requireSafeIdentifier(projectKey, 'project_key', SAFE_PROJECT_KEY);
    const task = requireSafeIdentifier(taskId, 'task_id');
    const exactEventId = requireSafeIdentifier(eventId, 'event_id');
    const version = requireExpectedVersion(expectedVersion);
    const now = this.now();
    return this.store.transaction('notification.cancel', state => {
      const outbox = ensureNamespace(state);
      const record = outbox.events[exactEventId];
      if (!record || record.projectKey !== project || record.taskId !== task) {
        throw new NotificationOutboxError('notification_scope_not_found', 'notification was not found in the exact task scope');
      }
      if (record.version !== version) {
        throw new NotificationOutboxError('version_conflict', 'notification version changed', { currentVersion: record.version });
      }
      if (record.state === 'cancelled') return { notification: publicRecord(record), duplicate: true };
      if (record.state === 'sending' && Date.parse(record.lease?.expiresAt ?? '') > now) {
        throw new NotificationOutboxError('delivery_in_progress', 'notification delivery is already in progress');
      }
      if (!ACKNOWLEDGEABLE_STATES.has(record.state) && record.state !== 'sending') {
        throw new NotificationOutboxError('invalid_transition', `cannot cancel notification in state ${record.state}`);
      }
      transition(record, 'cancelled', now, 'explicit_cancel');
      record.cancelledAt = iso(now);
      return { notification: publicRecord(record), duplicate: false };
    }).result;
  }

  status({ eventId, projectKey = null, taskId = null } = {}) {
    const exactEventId = requireSafeIdentifier(eventId, 'event_id');
    const project = projectKey == null ? null : requireSafeIdentifier(projectKey, 'project_key', SAFE_PROJECT_KEY);
    const task = taskId == null ? null : requireSafeIdentifier(taskId, 'task_id');
    if ((project == null) !== (task == null)) {
      throw new NotificationOutboxError('incomplete_scope', 'projectKey and taskId must be provided together');
    }
    const outbox = ensureNamespace(this.store.read().state);
    const record = outbox.events[exactEventId];
    if (!record || (project != null && (record.projectKey !== project || record.taskId !== task))) {
      throw new NotificationOutboxError('notification_scope_not_found', 'notification was not found in the requested scope');
    }
    return publicRecord(record);
  }

  list({ projectKey = null, taskId = null, states = null } = {}) {
    const project = projectKey == null ? null : requireSafeIdentifier(projectKey, 'project_key', SAFE_PROJECT_KEY);
    const task = taskId == null ? null : requireSafeIdentifier(taskId, 'task_id');
    if (task != null && project == null) {
      throw new NotificationOutboxError('project_key_required', 'taskId filtering requires projectKey');
    }
    let stateFilter = null;
    if (states != null) {
      const requested = Array.isArray(states) ? states : [states];
      if (!requested.length || requested.some(item => !notificationOutboxStates.includes(item))) {
        throw new NotificationOutboxError('invalid_state_filter', 'notification state filter is invalid');
      }
      stateFilter = new Set(requested);
    }
    const outbox = ensureNamespace(this.store.read().state);
    return Object.values(outbox.events)
      .filter(record => project == null || record.projectKey === project)
      .filter(record => task == null || record.taskId === task)
      .filter(record => stateFilter == null || stateFilter.has(record.state))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId))
      .map(publicRecord);
  }

  pruneTerminal({ olderThanMs = 30 * 24 * 60 * 60_000, limit = 500, apply = false } = {}) {
    if (!Number.isInteger(olderThanMs) || olderThanMs < 0) {
      throw new NotificationOutboxError('invalid_retention_age', 'olderThanMs must be a non-negative integer');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
      throw new NotificationOutboxError('invalid_retention_limit', 'retention limit must be between 1 and 5000');
    }
    if (typeof apply !== 'boolean') {
      throw new NotificationOutboxError('invalid_retention_apply', 'apply must be boolean');
    }
    const now = this.now();
    const cutoff = now - olderThanMs;
    const select = outbox => Object.values(outbox.events)
      .filter(record => TERMINAL_STATES.has(record.state) && Date.parse(record.updatedAt) <= cutoff)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.eventId.localeCompare(right.eventId))
      .slice(0, limit);
    if (!apply) {
      const outbox = ensureNamespace(this.store.read().state);
      const candidates = select(outbox);
      return {
        apply: false,
        cutoff: iso(cutoff),
        limit,
        candidateEventIds: candidates.map(record => record.eventId),
        pendingPreserved: Object.values(outbox.events).filter(record => !TERMINAL_STATES.has(record.state)).length
      };
    }
    return this.store.transaction('notification.retention.prune', state => {
      const outbox = ensureNamespace(state);
      const candidates = select(outbox);
      const removed = new Set(candidates.map(record => record.eventId));
      for (const eventId of removed) delete outbox.events[eventId];
      for (const [identity, eventId] of Object.entries(outbox.dedupe)) {
        if (removed.has(eventId)) delete outbox.dedupe[identity];
      }
      return {
        apply: true,
        cutoff: iso(cutoff),
        limit,
        removedEventIds: [...removed],
        pendingPreserved: Object.values(outbox.events).filter(record => !TERMINAL_STATES.has(record.state)).length
      };
    }).result;
  }

  async dispatchDue({ dispatcherId = `dispatcher-${process.pid}`, limit = 20, deliver = this.deliver } = {}) {
    const dispatcher = requireSafeIdentifier(dispatcherId, 'dispatcher_id', SAFE_DISPATCHER_ID);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new NotificationOutboxError('invalid_dispatch_limit', 'dispatch limit must be between 1 and 100');
    }
    if (typeof deliver !== 'function') {
      throw new NotificationOutboxError('delivery_required', 'dispatchDue requires an injected async delivery function');
    }
    const now = this.now();
    const claimed = this.store.transaction('notification.dispatch.claim', state => {
      const outbox = ensureNamespace(state);
      const recovered = [];
      const terminalized = [];
      for (const record of Object.values(outbox.events)) {
        if (record.state !== 'sending' || Date.parse(record.lease?.expiresAt ?? '') > now) continue;
        if (record.expiresAt != null && Date.parse(record.expiresAt) <= now) {
          transition(record, 'cancelled', now, 'expired_during_send_lease');
          record.cancelledAt = iso(now);
          terminalized.push(record.eventId);
        } else if (record.attempts >= record.maxAttempts) {
          transition(record, 'hold', now, 'send_lease_expired_attempts_exhausted');
          record.heldAt = iso(now);
          record.lastErrorCode = 'send_lease_expired';
          terminalized.push(record.eventId);
        } else {
          transition(record, 'retry', now, 'send_lease_expired');
          record.retryAt = iso(now);
          record.dueAt = iso(now);
          record.lastErrorCode = 'send_lease_expired';
          recovered.push(record.eventId);
        }
      }

      const due = Object.values(outbox.events)
        .filter(record => ['waiting', 'retry'].includes(record.state))
        .sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt) || left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId));
      const claims = [];
      for (const record of due) {
        if (claims.length >= limit) break;
        if (record.expiresAt != null && Date.parse(record.expiresAt) <= now) {
          transition(record, 'cancelled', now, 'expired_before_dispatch');
          record.cancelledAt = iso(now);
          terminalized.push(record.eventId);
          continue;
        }
        if (Date.parse(record.dueAt) > now) continue;
        if (record.attempts >= record.maxAttempts) {
          transition(record, 'hold', now, 'attempts_exhausted');
          record.heldAt = iso(now);
          terminalized.push(record.eventId);
          continue;
        }
        if (typeof record.payload !== 'string' || !SHA256.test(record.payloadHash) || sha256(record.payload) !== record.payloadHash) {
          transition(record, 'hold', now, 'pending_payload_invalid');
          record.heldAt = iso(now);
          record.lastErrorCode = 'pending_payload_invalid';
          terminalized.push(record.eventId);
          continue;
        }
        record.state = 'sending';
        record.version += 1;
        record.attempts += 1;
        record.updatedAt = iso(now);
        record.retryAt = null;
        record.terminalReason = null;
        record.lease = {
          leaseId: crypto.randomUUID(),
          dispatcherId: dispatcher,
          acquiredAt: iso(now),
          expiresAt: iso(now + this.leaseDurationMs)
        };
        claims.push({
          eventId: record.eventId,
          projectKey: record.projectKey,
          taskId: record.taskId,
          urgency: record.urgency,
          attempt: record.attempts,
          leaseId: record.lease.leaseId,
          payloadHash: record.payloadHash,
          message: record.payload
        });
      }
      return { claims, recovered, terminalized };
    }).result;

    const results = [];
    for (const claim of claimed.claims) {
      let outcome;
      let failure = null;
      try {
        outcome = await deliver({
          eventId: claim.eventId,
          projectKey: claim.projectKey,
          taskId: claim.taskId,
          urgency: claim.urgency,
          attempt: claim.attempt,
          payloadHash: claim.payloadHash,
          message: claim.message
        });
        if (outcome === false || outcome?.ok === false) failure = outcome ?? { code: 'delivery_rejected' };
      } catch (error) {
        failure = error;
      }

      const completedAt = this.now();
      const result = this.store.transaction(failure ? 'notification.dispatch.fail' : 'notification.dispatch.sent', state => {
        const outbox = ensureNamespace(state);
        const record = outbox.events[claim.eventId];
        if (!record || record.state !== 'sending' || record.lease?.leaseId !== claim.leaseId) {
          return { eventId: claim.eventId, outcome: 'stale_lease', notification: record ? publicRecord(record) : null };
        }
        if (!failure) {
          transition(record, 'sent', completedAt, null);
          record.sentAt = iso(completedAt);
          record.deliveryRef = safeDeliveryReference(outcome);
          record.lastErrorCode = null;
          return { eventId: record.eventId, outcome: 'sent', notification: publicRecord(record) };
        }

        const errorCode = safeErrorCode(failure);
        const retryAfterMs = retryAfterMilliseconds(failure);
        record.lastErrorCode = errorCode;
        if(errorCode==='slack_bot_token_unavailable') record.credentialReadFailureCount=(record.credentialReadFailureCount??0)+1;
        if (failure?.retryable === false) {
          transition(record, 'hold', completedAt, 'delivery_not_retryable');
          record.heldAt = iso(completedAt);
          return { eventId: record.eventId, outcome: 'hold', notification: publicRecord(record) };
        }
        if (retryAfterMs != null && retryAfterMs > this.maxRetryDelayMs) {
          transition(record, 'hold', completedAt, 'retry_after_exceeds_limit');
          record.heldAt = iso(completedAt);
          return { eventId: record.eventId, outcome: 'hold', notification: publicRecord(record) };
        }
        if (record.attempts >= record.maxAttempts) {
          transition(record, 'hold', completedAt, 'attempts_exhausted');
          record.heldAt = iso(completedAt);
          return { eventId: record.eventId, outcome: 'hold', notification: publicRecord(record) };
        }
        const backoff = Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * (2 ** Math.max(0, record.attempts - 1)));
        const retryDelay = Math.min(this.maxRetryDelayMs, Math.max(backoff, retryAfterMs ?? 0));
        const retryAt = completedAt + retryDelay;
        if (record.expiresAt != null && Date.parse(record.expiresAt) <= retryAt) {
          transition(record, 'cancelled', completedAt, 'expires_before_retry');
          record.cancelledAt = iso(completedAt);
          return { eventId: record.eventId, outcome: 'cancelled', notification: publicRecord(record) };
        }
        record.state = 'retry';
        record.version += 1;
        record.updatedAt = iso(completedAt);
        record.retryAt = iso(retryAt);
        record.dueAt = iso(retryAt);
        record.lease = null;
        record.terminalReason = 'delivery_retry_scheduled';
        return { eventId: record.eventId, outcome: 'retry', notification: publicRecord(record) };
      }).result;
      results.push(result);
    }

    return {
      claimed: claimed.claims.length,
      recovered: claimed.recovered,
      terminalized: claimed.terminalized,
      sent: results.filter(item => item.outcome === 'sent').length,
      retried: results.filter(item => item.outcome === 'retry').length,
      held: results.filter(item => item.outcome === 'hold').length,
      cancelled: results.filter(item => item.outcome === 'cancelled').length,
      stale: results.filter(item => item.outcome === 'stale_lease').length,
      results
    };
  }

  integrity() {
    return this.store.integrity();
  }
}
