import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planNotification, notificationRoutingProfiles } from './notification-policy.mjs';
import { createSlackBotTransport, loadSlackBotConfig } from './slack-bot-transport.mjs';
import { NotificationOutboxService } from './notifications/outbox-service.mjs';
import { NotificationSessionBindingStore } from './notifications/session-bindings.mjs';

export class NotificationCommandError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'NotificationCommandError';
    this.code = code;
    this.details = details;
  }
}

export function defaultNotificationPolicyPath(options = {}) {
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT ?? path.join(os.homedir(), '.ai-control-center');
  return path.join(stateRoot, 'notifications', 'policy.json');
}

export function validateNotificationPolicyConfig(value) {
  if (!value || typeof value !== 'object') throw new NotificationCommandError('notification_policy_required');
  if (value.schemaVersion !== 1) throw new NotificationCommandError('unsupported_notification_policy_schema');
  const routingProfile = String(value.routingProfile ?? '').trim();
  if (!notificationRoutingProfiles.includes(routingProfile)) {
    throw new NotificationCommandError('unsupported_notification_routing_profile');
  }
  if (typeof value.slackEnabled !== 'boolean' || typeof value.telegramEnabled !== 'boolean') {
    throw new NotificationCommandError('invalid_notification_channel_availability');
  }
  return Object.freeze({
    schemaVersion: 1,
    routingProfile,
    slackEnabled: value.slackEnabled,
    telegramEnabled: value.telegramEnabled
  });
}

function readPrivateJson(file, unavailableCode) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw new NotificationCommandError(unavailableCode, { cause: error.code ?? 'read_failed' });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new NotificationCommandError(`${unavailableCode}_unsafe_path`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new NotificationCommandError(`${unavailableCode}_unsafe_permissions`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new NotificationCommandError(`${unavailableCode}_invalid_json`);
  }
}

export function loadNotificationPolicyConfig(file = defaultNotificationPolicyPath()) {
  return validateNotificationPolicyConfig(readPrivateJson(file, 'notification_policy_unavailable'));
}

function makeTransport(options = {}) {
  if (options.transport) return options.transport;
  const slackConfig = options.slackConfig ?? loadSlackBotConfig(options.slackConfigPath);
  return createSlackBotTransport({ ...options, config: slackConfig });
}

export function createNotificationOutboxService(options = {}) {
  const policy = options.policy ?? loadNotificationPolicyConfig(options.policyPath);
  let transport = options.transport ?? null;
  const delivery = async ({ eventId, message }) => {
    transport ??= makeTransport(options);
    return transport.send({ eventId, message });
  };
  const serviceOptions = {
    now: options.outboxNow ?? (() => Date.now()),
    planner: event => planNotification(event, {
      slack: policy.slackEnabled,
      telegram: policy.telegramEnabled
    }, { routingProfile: policy.routingProfile }),
    deliver: options.deliver ?? delivery
  };
  if (options.outboxStore) serviceOptions.store = options.outboxStore;
  else if (options.outboxRoot) serviceOptions.root = options.outboxRoot;
  for (const name of ['leaseDurationMs', 'maxAttempts', 'baseRetryDelayMs', 'maxRetryDelayMs']) {
    if (options[name] != null) serviceOptions[name] = options[name];
  }
  return new NotificationOutboxService(serviceOptions);
}

export function createNotificationSessionBindingStore(options = {}) {
  if (options.bindingStore === false) return null;
  if (options.bindingStore) return options.bindingStore;
  return new NotificationSessionBindingStore({
    ...(options.bindingFile ? { file: options.bindingFile } : {}),
    ...(options.stateRoot ? { stateRoot: options.stateRoot } : {}),
    now: options.outboxNow ?? (() => Date.now()),
    ...(options.bindingMaxTtlMs ? { maxTtlMs: options.bindingMaxTtlMs } : {})
  });
}

function safelyUnbindTask(request, options = {}) {
  const store = createNotificationSessionBindingStore(options);
  if (!store) return { ok: true, state: 'disabled', removed: 0 };
  try {
    return { ...store.unbindScope(request), state: 'cleaned' };
  } catch (error) {
    return { ok: false, state: 'cleanup_failed', removed: 0, error: error.code ?? 'binding_cleanup_failed' };
  }
}

export async function notificationStatus(options = {}) {
  const policy = options.policy ?? loadNotificationPolicyConfig(options.policyPath);
  const result = {
    ok: policy.routingProfile !== 'slack_primary' || policy.slackEnabled,
    routingProfile: policy.routingProfile,
    slackEnabled: policy.slackEnabled,
    telegramEnabled: policy.telegramEnabled,
    slackVerified: null
  };
  if (options.verifySlack && policy.slackEnabled) {
    const identity = await makeTransport(options).verify();
    result.slackVerified = true;
    result.teamId = identity.teamId;
    result.botUserId = identity.botUserId;
    result.botId = identity.botId;
  }
  return result;
}

export async function sendNotification(event, options = {}) {
  return armNotification(event, options);
}

export async function armNotification(event, options = {}) {
  const service = options.outboxService ?? createNotificationOutboxService(options);
  const armed = service.arm(event, { dedupeKey: options.dedupeKey ?? event?.dedupeKey ?? null });
  let dispatch = null;
  if ([4, 5].includes(armed.notification.urgency) && ['waiting', 'retry'].includes(armed.notification.state)) {
    dispatch = await service.dispatchDue({
      dispatcherId: options.dispatcherId ?? `notify-command-${process.pid}`,
      limit: 1
    });
  }
  let sessionBinding = null;
  if ([2, 3].includes(armed.notification.urgency) && ['waiting', 'retry'].includes(armed.notification.state)) {
    const bindingStore = createNotificationSessionBindingStore(options);
    if (bindingStore) {
      try {
        sessionBinding = bindingStore.bind({
          sessionId: options.sessionId ?? event?.sessionId ?? event?.taskId,
          projectKey: armed.notification.projectKey,
          taskId: armed.notification.taskId,
          expiresAt: options.bindingExpiresAt ?? event?.expiresAt ?? null
        });
      } catch (error) {
        if (!armed.duplicate && armed.notification.state === 'waiting') {
          try {
            service.cancel({
              projectKey: armed.notification.projectKey,
              taskId: armed.notification.taskId,
              eventId: armed.notification.eventId,
              expectedVersion: armed.notification.version
            });
          } catch { /* durable outbox remains recoverable and visible */ }
        }
        throw new NotificationCommandError('session_binding_failed', { cause: error.code ?? 'binding_failed' });
      }
    }
  }
  return {
    ok: true,
    action: 'armed',
    ...armed,
    dispatch,
    sessionBinding
  };
}

export function acknowledgeNotification(request, options = {}) {
  const service = options.outboxService ?? createNotificationOutboxService(options);
  const result = service.ack(request);
  const bindingCleanup = result.acknowledged.length > 0 && result.inFlight.length === 0
    ? safelyUnbindTask({ projectKey: request.projectKey, taskId: request.taskId }, options)
    : null;
  return { ok: true, action: 'acknowledged', ...result, bindingCleanup };
}

export function cancelNotification(request, options = {}) {
  const service = options.outboxService ?? createNotificationOutboxService(options);
  const result = service.cancel(request);
  const remaining = service.list({ projectKey: request.projectKey, taskId: request.taskId, states: ['waiting', 'retry', 'sending'] });
  const bindingCleanup = remaining.length === 0
    ? safelyUnbindTask({ projectKey: request.projectKey, taskId: request.taskId }, options)
    : null;
  return { ok: true, action: 'cancelled', ...result, bindingCleanup };
}

export function inspectNotification(request, options = {}) {
  const service = options.outboxService ?? createNotificationOutboxService(options);
  return { ok: true, action: 'inspected', notification: service.status(request) };
}

export async function processDueNotifications(options = {}) {
  const service = options.outboxService ?? createNotificationOutboxService(options);
  const now = service.now();
  const active = service.list({ states: ['waiting', 'retry', 'sending'] });
  const dispatchNeeded = active.some(notification => {
    if (notification.expiresAt != null && Date.parse(notification.expiresAt) <= now) return true;
    if (notification.state === 'sending') return Date.parse(notification.activeLease?.expiresAt ?? '') <= now;
    return Date.parse(notification.dueAt) <= now;
  });
  const dispatch = dispatchNeeded
    ? await service.dispatchDue({
      dispatcherId: options.dispatcherId ?? `notification-scheduler-${process.pid}`,
      limit: options.limit ?? 20
    })
    : { claimed: 0, recovered: [], terminalized: [], sent: 0, retried: 0, held: 0, cancelled: 0, stale: 0, results: [] };
  const retentionPlan = service.pruneTerminal();
  const retention = retentionPlan.candidateEventIds.length
    ? service.pruneTerminal({ apply: true })
    : { apply: false, removedEventIds: [], pendingPreserved: retentionPlan.pendingPreserved };
  let bindingPrune = null;
  const bindingStore = createNotificationSessionBindingStore(options);
  if (bindingStore) {
    try { bindingPrune = bindingStore.pruneExpired(); }
    catch (error) { bindingPrune = { ok: false, error: error.code ?? 'binding_prune_failed' }; }
  }
  return { ok: true, action: 'processed', ...dispatch, retention, bindingPrune };
}
