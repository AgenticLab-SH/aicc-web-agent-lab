#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKnowledgeReviewService } from './knowledge-review/service.mjs';
import { createMonitoringJobService } from './monitoring-job-service.mjs';
import { armNotification, processDueNotifications } from './notification-command.mjs';
import { assetAuditTick } from './assets/scheduled-audit.mjs';
import { UpstreamReviewService } from './upstream-review-service.mjs';
import { GroupFollowupService } from './group-followup-service.mjs';

function firstQueued(service) {
  return service.status().queuedJobIds?.[0] ?? null;
}

export function buildUpstreamUpdateNotification(report) {
  const updates = Array.isArray(report?.sources)
    ? report.sources.filter(source => source?.status === 'update_available')
    : [];
  if (updates.length === 0) return null;
  const identities = updates.map(source => ({
    id: String(source.id),
    current: String(source.currentVersion ?? source.currentRevision ?? 'UNKNOWN')
  })).sort((left, right) => left.id.localeCompare(right.id));
  const signature = crypto.createHash('sha256').update(JSON.stringify(identities)).digest('hex');
  const ocx = updates.find(source => source.id === 'ocx-upstream-npm');
  const names = updates.slice(0, 4).map(source => source.label || source.id).join(', ');
  const extra = updates.length > 4 ? ` 외 ${updates.length - 4}개` : '';
  const ocxDetail = ocx?.currentVersion ? ` OCX 최신판은 ${ocx.currentVersion}입니다.` : '';
  return {
    eventId: `ai-platform:upstream-update:${signature.slice(0, 24)}`,
    dedupeKey: `local-upstream:${signature}`,
    type: 'report_ready',
    urgency: 2,
    sensitivity: 'internal',
    source: 'aicc-local-upstream-monitor',
    projectKey: 'ai-platform',
    owner: 'local-scheduler',
    taskId: 'aicc:upstream-monitor:daily',
    title: '사용 소스 업데이트 발견',
    summary: `${updates.length}개 소스의 새 버전을 찾았습니다: ${names}${extra}.${ocxDetail}`,
    nextGate: null
  };
}

export async function schedulerTick(options = {}) {
  if (options.scope === 'group-followup') {
    const followup = options.groupFollowupService ?? new GroupFollowupService(options.groupFollowup);
    return { schemaVersion: 1, automaticApply: false, scope: 'group-followup', followup: await followup.tick() };
  }
  if (options.scope === 'upstream-review') {
    const review = options.reviewService ?? new UpstreamReviewService(options.review);
    return { schemaVersion: 1, automaticApply: false, scope: 'upstream-review', review: await review.tick() };
  }
  const monitoring = options.monitoringService ?? createMonitoringJobService(options.monitoring);
  const knowledge = options.knowledgeService ?? createKnowledgeReviewService(options.knowledge);
  let monitoringResult;
  let knowledgeResult;
  try {
    monitoring.manager.recoverExpired();
    const due = monitoring.enqueueDue();
    const monitoringJobId = firstQueued(monitoring);
    monitoringResult = monitoringJobId ? await monitoring.runOnce(monitoringJobId) : { skipped: true, reason: due.reason };
  } catch (error) {
    monitoringResult = { ok: false, error: error.code ?? 'monitoring_scheduler_failed', message: error.message };
  }
  try {
    if (knowledge.manager !== monitoring.manager) knowledge.manager.recoverExpired();
    const knowledgeJobId = firstQueued(knowledge);
    knowledgeResult = knowledgeJobId ? await knowledge.runOnce(knowledgeJobId) : { skipped: true, reason: 'no-confirmed-job' };
  } catch (error) {
    knowledgeResult = { ok: false, error: error.code ?? 'knowledge_scheduler_failed', message: error.message };
  }
  const result = {
    schemaVersion: 1,
    automaticApply: false,
    monitoring: monitoringResult,
    knowledge: knowledgeResult,
    updateNotification: null,
    notifications: null,
    assets: null
  };
  try {
    result.assets = (options.auditAssets ?? assetAuditTick)(options.assets ?? {});
  } catch (error) {
    result.assets = { ok: false, error: error.code ?? 'asset_audit_failed', externalWritePerformed: false };
  }
  try {
    const event = buildUpstreamUpdateNotification(result.monitoring?.report);
    if (event) {
      result.updateNotification = await (options.armUpdateNotification ?? armNotification)(event, {
        ...(options.updateNotifications ?? {}),
        bindingStore: false,
        dedupeKey: event.dedupeKey
      });
    } else {
      result.updateNotification = { skipped: true, reason: 'no-new-update-signature' };
    }
  } catch (error) {
    result.updateNotification = { ok: false, error: error.code ?? 'update_notification_arm_failed' };
  }
  try {
    result.notifications = await (options.processNotifications ?? processDueNotifications)(options.notifications ?? {});
  } catch (error) {
    result.notifications = { ok: false, error: error.code ?? 'notification_scheduler_failed' };
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ackIndex = process.argv.indexOf('--ack-upstream-review');
  const execution = ackIndex >= 0 ? Promise.resolve().then(() => new UpstreamReviewService().acknowledge(process.argv[ackIndex + 1]))
    : schedulerTick({ scope: process.argv.includes('--group-followup-only') ? 'group-followup' : process.argv.includes('--upstream-review-only') ? 'upstream-review' : undefined });
  execution.then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(`aicc-scheduler: ${error.code ?? 'failed'}: ${error.message}`);
    process.exitCode = 1;
  });
}
