import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createMonitoringJobService } from './monitoring-job-service.mjs';
import { UpdateCoordinator } from './compatibility/update-coordinator.mjs';
import { runCommand } from './lib/command.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
function regular(file) {
  if (!path.isAbsolute(file)) fail('review_absolute_path_required');
  for (let p = file; ; p = path.dirname(p)) {
    if (fs.lstatSync(p).isSymbolicLink()) fail('review_linked_path_refused');
    if (p === path.dirname(p)) break;
  }
  if (!fs.statSync(file).isFile()) fail('review_regular_file_required');
}
function json(file) { regular(file); return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function boundedLines(file, tail = false) {
  regular(file);
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, limit = tail ? 4 * 1024 * 1024 : 65536;
    const start = tail ? Math.max(0, size - limit) : 0;
    const bytes = Buffer.alloc(Math.min(size, limit)); fs.readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.toString('utf8').split('\n');
    if (start) lines.shift();
    return lines;
  } finally { fs.closeSync(fd); }
}

// Queue acceptance, actual marker-bound execution, and review acknowledgement
// are separate. Read only this exact registered rollout, never neighbouring turns.
export function observeReview(registration, review) {
  let turnId = review.turnId ?? null, currentTurn = null;
  const result = { turnId, executionState: review.executionState ?? 'UNOBSERVED' };
  for (const line of boundedLines(registration.rollout, true)) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (!Number.isFinite(Date.parse(row.timestamp)) || Date.parse(row.timestamp) < Date.parse(review.createdAt)) continue;
    const event = row.payload;
    if (row.type === 'event_msg' && event?.type === 'task_started') currentTurn = event.turn_id;
    if (row.type === 'turn_context') currentTurn = event?.turn_id ?? null;
    const typed = row.type === 'event_msg' && event?.type === 'item_completed' && event.item?.type === 'UserMessage';
    const message = row.type === 'response_item' && event?.type === 'message' && event.role === 'user';
    const text = typed ? event.item.content?.map(x => x.text ?? '').join('\n')
      : message ? event.content?.map(x => x.text ?? '').join('\n') : '';
    if (text?.split(/\r?\n/).includes(review.marker)) {
      // CLI response_item has no turn id; its immediately current task/context
      // supplies the identity. A missing context cannot manufacture execution.
      turnId = typed ? event.turn_id : currentTurn;
      if (turnId) Object.assign(result, { turnId, executionState: 'TURN_ACTIVE', observedAt: row.timestamp });
    }
    if (turnId && row.type === 'event_msg' && event?.turn_id === turnId && ['task_complete', 'turn_aborted'].includes(event.type)) {
      Object.assign(result, { turnId, executionState: event.type === 'task_complete' ? 'TURN_COMPLETED' : 'TURN_INTERRUPTED', observedAt: row.timestamp });
    }
    if (row.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(event?.type) && event.turn_id === currentTurn) currentTurn = null;
  }
  return result;
}

export class UpstreamReviewService {
  constructor({ stateRoot = process.env.AICC_STATE_ROOT || path.join(os.homedir(), '.ai-control-center'),
    registrationPath, monitoring, coordinator, now = () => Date.now(), send = runCommand } = {}) {
    this.stateRoot = stateRoot;
    this.registrationPath = registrationPath ?? path.join(stateRoot, 'monitoring', 'scheduler', 'agent-review-registration.json');
    this.monitoring = monitoring ?? createMonitoringJobService({ stateRoot });
    this.store = this.monitoring.manager.store;
    this.coordinator = coordinator ?? new UpdateCoordinator({ stateRoot: path.join(stateRoot, 'compatibility') });
    this.now = now; this.send = send;
  }
  registration() {
    if (!fs.existsSync(this.registrationPath)) return null;
    const r = json(this.registrationPath);
    if (r.schemaVersion !== 1 || r.automaticApply !== false || r.reviewOnly !== true || !uuid.test(r.targetThreadId)
      || !r.authorizationRef || !r.goalId || !Number.isFinite(Date.parse(r.firstDueAt))) fail('review_registration_invalid');
    if (r.cadenceHours !== this.monitoring.manifest.policy.localScanIntervalHours) fail('review_cadence_policy_changed');
    if (!Array.isArray(r.sourcePins) || r.sourcePins.length < 3) fail('review_source_pins_required');
    if (r.codexAlias && fs.realpathSync(r.codexAlias) !== r.codexExecutable) fail('review_registered_slot_changed');
    for (const pin of [...r.sourcePins, { path: r.codexExecutable, sha256: r.codexSha256 }]) {
      regular(pin.path); if (hash(fs.readFileSync(pin.path)) !== pin.sha256) fail('review_registered_code_changed');
    }
    const meta = JSON.parse(boundedLines(r.rollout)[0]);
    if (meta.type !== 'session_meta' || meta.payload?.id !== r.targetThreadId
      || path.resolve(meta.payload.cwd) !== path.resolve(r.targetRoot)) fail('review_exact_target_changed');
    return r;
  }
  status() {
    const r = this.registration();
    const records = Object.values(this.store.read().state.upstreamReviews ?? {}).filter(x => !r || x.registrationId === r.registrationId);
    const last = records.sort((a, b) => b.dueIndex - a.dueIndex)[0] ?? null;
    return { registered: !!r, enabled: r?.enabled === true, automaticApply: false, cadenceHours: r?.cadenceHours ?? null,
      targetThreadId: r?.targetThreadId ?? null, reviewCount: records.length, latest: last,
      nextDueAt: r ? new Date(Date.parse(r.firstDueAt) + ((last?.dueIndex ?? -1) + 1) * r.cadenceHours * 3600000).toISOString() : null };
  }
  async tick() {
    const r = this.registration();
    if (!r || r.enabled !== true) return { skipped: true, reason: r ? 'review-disabled' : 'review-not-registered' };
    const initial = this.status();
    if (initial.latest) {
      const observed = observeReview(r, initial.latest);
      if (observed.turnId) this.store.transaction('upstream.review.observe', s => Object.assign(s.upstreamReviews[initial.latest.id], observed));
    }
    const now = this.now(), interval = r.cadenceHours * 3600000;
    const dueIndex = Math.floor((now - Date.parse(r.firstDueAt)) / interval);
    if (dueIndex < 0) return { skipped: true, reason: 'not-due', ...this.status() };
    const id = hash(`${r.registrationId}:${dueIndex}`), marker = `AICC_UPSTREAM_REVIEW:${id}`;
    const claimed = this.store.transaction('upstream.review.due', s => {
      s.upstreamReviews ??= {};
      if (s.upstreamReviews[id]) return { send: false, reason: 'same-due-preserved', record: s.upstreamReviews[id] };
      const pending = Object.values(s.upstreamReviews).find(x => x.registrationId === r.registrationId
        && !['TURN_COMPLETED', 'TURN_INTERRUPTED'].includes(x.executionState));
      if (pending) return { send: false, reason: 'previous-review-reconcile-first', record: pending };
      const record = { id, registrationId: r.registrationId, dueIndex, dedupeKey: `upstream-review:${r.registrationId}:${dueIndex}`,
        dueAt: new Date(Date.parse(r.firstDueAt) + dueIndex * interval).toISOString(), createdAt: new Date(now).toISOString(),
        targetThreadId: r.targetThreadId, goalId: r.goalId, marker, state: 'TODO_CREATED', executionState: 'UNOBSERVED',
        automaticReplay: false, automaticApply: false };
      s.upstreamReviews[id] = record; return { send: true, record };
    }).result;
    if (!claimed.send) return { skipped: true, reason: claimed.reason, ...this.status() };
    // This due's durable claim survives crashes, timeouts and missed ACKs.
    // A repeated tick only observes it. It never reissues an uncertain queue call.
    let delivery;
    try {
      const monitoring = this.monitoring.enqueueDue();
      const coordination = this.coordinator.status();
      const message = ['[AICC 정기 OCX 업데이트 검토]', marker,
        `검토할 일: ${claimed.record.dedupeKey}; due=${claimed.record.dueAt}; goal=${r.goalId}`,
        `기존 upstream monitor 요청=${monitoring.job?.jobId ?? 'cadence-current'}; UpdateCoordinator active=${coordination.activePlans}.`,
        '이것은 새 정기 검토 요청이다. 과거 설치·UNKNOWN 요청을 재생하지 않는다.',
        '공식 최신·변경 내용·현재 설치·AICC 호환성·실제 영향받는 작업·복구 수단을 기존 monitor/UpdateCoordinator로 검토하라.',
        '같은 root 작성권은 기존 중앙 배정을 따른다. 이 검토 접수로 제품 작성권을 인수하지 않는다. 필요한 적용은 원 승인 범위와 단일 writer/독립 복구 조건을 지킨다.',
        '새 계정/provider/HOME/권한/데몬/무인 교체를 만들지 않는다. 원 결과 불명은 재발신하지 않는다.',
        `수신 확인: node "${r.schedulerEntry}" --ack-upstream-review ${id}`,
        '등록된 exact 대화에서 위 수신 확인을 남기고, 기존 목표에 검토 결과와 남은 조치를 기록하라.'].join('\n');
      this.store.transaction('upstream.review.intent', s => Object.assign(s.upstreamReviews[id], {
        state: 'QUEUE_DELIVERY_UNCERTAIN', messageSha256: hash(message), monitoringJobId: monitoring.job?.jobId ?? null,
        coordinatorPlanCount: coordination.planCount, dispatchAt: new Date(this.now()).toISOString() }));
      const env = { ...process.env }; delete env.CODEX_THREAD_ID; delete env.CODEX_SESSION_ID;
      const result = await this.send(r.codexExecutable, ['queue', '--thread', r.targetThreadId, '--message', message, '--resume'],
        { cwd: r.targetRoot, env, timeoutMs: 25000, maxBytes: 32768 });
      const match = /^Queued message ([a-f0-9-]{36}) for thread ([a-f0-9-]{36})\.\r?$/m.exec(result.stdout ?? '');
      delivery = { state: result.ok && match && match[2] === r.targetThreadId ? 'QUEUE_ACCEPTED' : 'QUEUE_DELIVERY_UNCERTAIN',
        queuedMessageId: result.ok && match?.[2] === r.targetThreadId ? match[1] : null,
        exitCode: result.exitCode, outputSha256: hash(`${result.stdout ?? ''}\n${result.stderr ?? ''}`),
        deliveredAt: new Date(this.now()).toISOString(), resumeWarning: /warning/i.test(result.stderr ?? '') };
    } catch (error) { delivery = { state: 'QUEUE_DELIVERY_UNCERTAIN', errorCode: error.code ?? 'review-dispatch-unconfirmed' }; }
    this.store.transaction('upstream.review.delivery', s => Object.assign(s.upstreamReviews[id], delivery));
    return { skipped: false, ...this.status() };
  }
  acknowledge(id, threadId = process.env.CODEX_THREAD_ID) {
    const r = this.registration();
    if (!r || threadId !== r.targetThreadId || !/^[a-f0-9]{64}$/.test(id)) fail('review_exact_recipient_required');
    return this.store.transaction('upstream.review.agent-ack', s => {
      const record = s.upstreamReviews?.[id];
      if (!record || record.targetThreadId !== threadId || record.registrationId !== r.registrationId) fail('review_not_found');
      record.agentAcknowledgedAt ??= new Date(this.now()).toISOString();
      record.acknowledgedBy = threadId; return record;
    }).result;
  }
}
