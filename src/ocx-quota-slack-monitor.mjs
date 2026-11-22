import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { defaultSlackBotConfigPath } from './slack-bot-transport.mjs';
import { armNotification, defaultNotificationPolicyPath } from './notification-command.mjs';
import { defaultNotificationOutboxRoot } from './notifications/outbox-service.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const clean = (value, max = 64) => String(value ?? '').replace(/[\x00-\x1f\x7f<>]/g, ' ').slice(0, max);
function guard(file) {
  for (let current = path.resolve(file);; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('quota_monitor_linked_path');
    if (current === path.dirname(current)) break;
  }
}
function read(file) {
  guard(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1048576) fail('quota_monitor_state_invalid');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.schemaVersion !== 1 || !value.edges || typeof value.edges !== 'object' || Array.isArray(value.edges)) fail('quota_monitor_state_invalid');
  return value;
}
function atomic(file, value) {
  guard(file);
  const temp = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
// T33/T56 (2026-11-01 G1): one user-facing Slack path. The monitor arms one short Korean event in the
// existing AICC notification outbox (dedupe by eventId, redaction, urgency policy) instead of posting
// its own long message through a separate transport.
function quotaEvent(snapshot, triggers, timestamp) {
  const policy = snapshot.policy;
  const reached = triggers.map(value => `${clean(value.name, 24)} ${value.label}`).join(', ');
  const selected = snapshot.tray?.selectionVerified
    ? snapshot.accounts.filter(row => row.active).map(row => clean(row.name, 24)).join(', ') || '없음'
    : '확인되지 않음';
  const summary = `차단 사용률(5시간 ${policy.fiveHourUsedThreshold}% · 장기 ${policy.longWindowUsedThreshold}%) 도달: ${reached}. 현재 선택: ${selected}.`;
  return {
    eventId: 'ocxquota:' + sha(triggers.map(row => row.edgeId).sort().join(':')).slice(0, 56),
    type: 'report_ready',
    urgency: 4,
    sensitivity: 'internal',
    source: 'ocx-quota-slack-monitor',
    projectKey: 'aicc',
    taskId: 'ocx-quota-monitor',
    title: `OCX 계정 ${triggers.length}건 한도 차단 사용률 도달`,
    summary: summary.slice(0, 180),
    nextGate: '트레이 한도 화면에서 계정 상태 확인'
  };
}

// One timer in the existing server. A durable DISPATCHING/UNKNOWN edge is never resent.
export function createOcxQuotaSlackMonitor(options = {}) {
  if (typeof options.dashboard?.read !== 'function') fail('quota_monitor_dashboard_required');
  const ownerRoot = path.resolve(options.ownerRoot ?? process.env.AICC_STATE_ROOT ?? path.join(os.homedir(), '.ai-control-center'));
  const directory = path.join(ownerRoot, 'notifications');
  const stateFile = path.join(directory, 'ocx-quota-block-monitor.json');
  const lockFile = stateFile + '.lock';
  const now = options.now ?? Date.now;
  const intervalMs = Math.max(15000, Math.min(300000, Number(options.intervalMs) || 60000));
  let timer = null, pending = null, stopped = true, lockFd = null;
  let view = { running: false, inFlight: false, state: 'stopped', lastCheckedAt: null, lastSentAt: null, errorCode: null, unresolvedDeliveryCount: 0 };
  function acquire() {
    if (lockFd !== null) return;
    guard(directory); fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); guard(lockFile);
    const create = () => {
      lockFd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(lockFd, JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt: new Date(now()).toISOString() })); fs.fsyncSync(lockFd);
    };
    try { create(); return; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Reclaim only a proven dead process lock. Message dispatch fences stay intact.
    const reclaim = lockFile + '.reconcile';
    guard(reclaim);
    try { fs.mkdirSync(reclaim, { mode: 0o700 }); } catch { fail('quota_monitor_owner_lock_held'); }
    try {
      const stat = fs.lstatSync(lockFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024) fail('quota_monitor_owner_lock_invalid');
      const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) fail('quota_monitor_owner_lock_invalid');
      let dead = false;
      try { process.kill(owner.pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
      if (!dead) fail('quota_monitor_owner_lock_held');
      fs.unlinkSync(lockFile);
      try { create(); } catch (error) { if (error.code === 'EEXIST') fail('quota_monitor_owner_lock_held'); throw error; }
    } finally { fs.rmdirSync(reclaim); }
  }
  function release() {
    if (lockFd !== null) { fs.closeSync(lockFd); lockFd = null; fs.unlinkSync(lockFile); }
  }
  async function work() {
    acquire();
    const timestamp = now();
    const state = fs.existsSync(stateFile) ? read(stateFile) : { schemaVersion: 1, edges: {}, deliveries: {} };
    state.deliveries ??= {};
    if (typeof state.deliveries !== 'object' || Array.isArray(state.deliveries) || Object.values(state.deliveries).some(value => !value || !['DISPATCHING', 'UNKNOWN', 'SENT'].includes(value.state))) fail('quota_monitor_state_invalid');
    view.unresolvedDeliveryCount = Object.values(state.deliveries).filter(value => ['DISPATCHING', 'UNKNOWN'].includes(value.state)).length;
    const snapshot = await options.dashboard.read({ refresh: true });
    view.lastCheckedAt = new Date(timestamp).toISOString();
    if (snapshot.warningSettings?.slackEnabled !== true) { view.state = snapshot.warningSettings ? 'disabled' : 'settings_unavailable'; return; }
    const policy = snapshot.policy;
    if (!policy || ![policy.fiveHourUsedThreshold, policy.longWindowUsedThreshold].every(value => Number.isFinite(value) && value >= 1 && value <= 100)) { view.state = 'policy_unavailable'; return; }
    const triggers = [];
    for (const row of snapshot.accounts ?? []) {
      if (!/^[a-f0-9]{64}$/.test(row.identityHash ?? '') || !row.quotaFresh) continue;
      for (const window of [
        { key: 'fiveHour', label: '5시간', used: row.shortUsedPercent, limit: policy.fiveHourUsedThreshold, reset: row.shortResetAt },
        { key: 'longWindow', label: row.longLabel || '주간', used: row.longUsedPercent, limit: policy.longWindowUsedThreshold, reset: row.longResetAt }
      ]) {
        if (!Number.isFinite(window.used) || window.used < 0 || window.used > 100) continue;
        const resetMs = Date.parse(window.reset ?? '');
        if (Number.isFinite(resetMs) && resetMs <= timestamp) continue;
        const key = sha(`${row.identityHash}:${window.key}`);
        const previous = state.edges[key] ?? { cycle: 0, above: false };
        const above = window.used >= window.limit;
        const reset = Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null;
        const newCycle = reset && previous.reset !== reset || !above && previous.above;
        const cycle = previous.cycle + (newCycle ? 1 : 0);
        const edgeId = sha(`${key}:${reset ?? cycle}:${window.limit}`);
        state.edges[key] = { cycle, above, reset, observedAt: row.quotaObservedAt, lastSeenAt: new Date(timestamp).toISOString() };
        if (above && !state.deliveries[edgeId]) triggers.push({ edgeId, name: row.name, label: window.label });
      }
    }
    if (Object.keys(state.edges).length > 256 || Object.keys(state.deliveries).length > 2048) { view.state = 'history_capacity_hold'; atomic(stateFile, state); return; }
    if (!triggers.length) { atomic(stateFile, state); view.state = view.unresolvedDeliveryCount ? 'delivery_unknown_hold' : 'watching'; return; }
    // Resolve the owner notification policy before fencing; a missing policy has not armed anything.
    const notify = options.notify ?? (event => armNotification(event, {
      policyPath: defaultNotificationPolicyPath({ stateRoot: ownerRoot }),
      slackConfigPath: defaultSlackBotConfigPath({ stateRoot: ownerRoot }),
      outboxRoot: defaultNotificationOutboxRoot({ stateRoot: ownerRoot }),
      bindingStore: false,
      dispatcherId: `ocx-quota-monitor-${process.pid}`
    }));
    const event = quotaEvent(snapshot, triggers, timestamp);
    const eventId = event.eventId;
    for (const trigger of triggers) state.deliveries[trigger.edgeId] = { state: 'DISPATCHING', eventId, attemptedAt: new Date(timestamp).toISOString() };
    atomic(stateFile, state);
    view.state = 'dispatching';
    try {
      const result = await notify(event);
      // Armed in the durable outbox (or already armed under the same eventId). Delivery, retry and
      // HOLD are owned by the outbox from here; this monitor never re-arms the same edge.
      if (result?.ok !== true || !result.notification?.eventId) fail('quota_notify_result_unknown');
      const sentAt = result.notification.sentAt ?? new Date(now()).toISOString();
      for (const trigger of triggers) state.deliveries[trigger.edgeId] = { ...state.deliveries[trigger.edgeId], state: 'SENT', sentAt, outboxState: String(result.notification.state ?? '').slice(0, 24) };
      atomic(stateFile, state);
      view.lastSentAt = sentAt; view.state = 'sent';
    } catch (error) {
      // Refusals raised by validation or planning happen before the outbox writes anything: the edge
      // was not armed, so drop the fence and let a later tick try again (nothing reached Slack).
      if (/^(notification_plan_unavailable|notification_policy_unavailable\w*|unsupported_notification_\w+|invalid_notification_\w+|notification_\w+_required)$/.test(error?.code ?? '')) {
        for (const trigger of triggers) delete state.deliveries[trigger.edgeId];
        atomic(stateFile, state); view.state = 'notify_unavailable_hold'; view.errorCode = error.code;
        return;
      }
      for (const trigger of triggers) state.deliveries[trigger.edgeId] = { ...state.deliveries[trigger.edgeId], state: 'UNKNOWN' };
      atomic(stateFile, state); view.state = 'delivery_unknown_hold';
      view.unresolvedDeliveryCount += triggers.length;
      view.errorCode = /^[a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'quota_slack_delivery_unknown';
    }
  }
  function tick() {
    if (pending) return pending;
    view.inFlight = true; view.errorCode = null;
    pending = Promise.resolve().then(work).catch(error => { view.state = 'hold'; view.errorCode = /^[a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'quota_monitor_unavailable'; }).finally(() => {
      view.inFlight = false; pending = null;
      if (stopped) release();
    });
    return pending;
  }
  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => { timer = null; void tick().finally(schedule); }, intervalMs);
    timer.unref?.();
  }
  return Object.freeze({
    start() { if (!stopped) return this.status(); stopped = false; view.running = true; view.state = 'starting'; void tick().finally(schedule); return this.status(); },
    async stop() { stopped = true; view.running = false; if (timer) clearTimeout(timer); timer = null; if (pending) await pending; release(); view.state = 'stopped'; return this.status(); },
    tick,
    status() { return { ...view, intervalMs, deliveryPolicy: 'persisted-edge-armed-once-in-notification-outbox', triggerScope: 'all-pool-accounts', selectionScope: 'pool-selection-not-per-conversation-proof' }; }
  });
}
