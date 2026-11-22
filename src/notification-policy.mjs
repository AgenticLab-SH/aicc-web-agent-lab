import { redactText } from './lib/redact.mjs';

export const notificationEventTypes = Object.freeze([
  'user_response_required',
  'approval_required',
  'critical_error',
  'task_completed',
  'deployment_complete',
  'report_ready',
  'otp_required',
  'routine_progress'
]);

export const notificationUrgencyLevels = Object.freeze({
  1: '참고',
  2: '일반',
  3: '확인',
  4: '중요',
  5: '긴급'
});

const telegramPrimaryPolicy = Object.freeze({
  user_response_required: [
    { channel: 'telegram', role: 'primary', required: true, responseMode: 'correlated' },
    { channel: 'slack', role: 'secondary', required: false, responseMode: 'report_only' }
  ],
  approval_required: [
    { channel: 'telegram', role: 'primary', required: true, responseMode: 'correlated' },
    { channel: 'slack', role: 'secondary', required: false, responseMode: 'report_only' }
  ],
  critical_error: [
    { channel: 'telegram', role: 'primary', required: true, responseMode: 'none' },
    { channel: 'slack', role: 'secondary', required: false, responseMode: 'none' }
  ],
  task_completed: [
    { channel: 'telegram', role: 'primary', required: false, responseMode: 'none' },
    { channel: 'slack', role: 'secondary', required: false, responseMode: 'none' }
  ],
  deployment_complete: [
    { channel: 'telegram', role: 'primary', required: false, responseMode: 'none' },
    { channel: 'slack', role: 'secondary', required: false, responseMode: 'none' }
  ],
  report_ready: [
    { channel: 'telegram', role: 'primary', required: false, responseMode: 'none' },
    { channel: 'slack', role: 'secondary', required: false, responseMode: 'none' }
  ],
  otp_required: [
    { channel: 'telegram', role: 'primary', required: true, responseMode: 'ephemeral_code' }
  ],
  routine_progress: []
});

const slackPrimaryPolicy = Object.freeze({
  user_response_required: [
    { channel: 'slack', role: 'primary', required: true, responseMode: 'original_task' }
  ],
  approval_required: [
    { channel: 'slack', role: 'primary', required: true, responseMode: 'original_task' }
  ],
  critical_error: [
    { channel: 'slack', role: 'primary', required: true, responseMode: 'none' }
  ],
  task_completed: [
    { channel: 'slack', role: 'primary', required: false, responseMode: 'none' }
  ],
  deployment_complete: [
    { channel: 'slack', role: 'primary', required: false, responseMode: 'none' }
  ],
  report_ready: [
    { channel: 'slack', role: 'primary', required: false, responseMode: 'none' }
  ],
  otp_required: [
    { channel: 'telegram', role: 'primary', required: true, responseMode: 'ephemeral_code' }
  ],
  routine_progress: []
});

export const notificationRoutingProfiles = Object.freeze([
  'telegram_primary',
  'slack_primary'
]);

const defaultUrgencyByType = Object.freeze({
  routine_progress: 1,
  task_completed: 2,
  deployment_complete: 2,
  report_ready: 2,
  user_response_required: 3,
  approval_required: 4,
  otp_required: 4,
  critical_error: 5
});

const fixedSafeContentByType = Object.freeze({
  user_response_required: Object.freeze({
    title: '사용자 확인 필요',
    summary: '세부 내용은 원래 작업에서 확인하세요.',
    nextGate: '원래 작업에서 확인 후 응답'
  }),
  approval_required: Object.freeze({
    title: '사용자 승인 필요',
    summary: '세부 내용은 원래 작업에서 확인하세요.',
    nextGate: '원래 작업에서 승인 또는 보류 선택'
  }),
  critical_error: Object.freeze({
    title: '긴급 확인 필요',
    summary: '세부 오류는 원래 작업에서 확인하세요.',
    nextGate: '원래 작업에서 영향과 복구 절차 확인'
  }),
  task_completed: Object.freeze({
    title: '작업 완료',
    summary: '세부 결과는 원래 작업에서 확인하세요.',
    nextGate: null
  }),
  deployment_complete: Object.freeze({
    title: '배포 완료',
    summary: '세부 결과는 원래 작업에서 확인하세요.',
    nextGate: null
  }),
  report_ready: Object.freeze({
    title: '보고서 준비 완료',
    summary: '세부 결과는 원래 작업에서 확인하세요.',
    nextGate: null
  }),
  otp_required: Object.freeze({
    title: '일회성 코드 입력 필요',
    summary: '코드는 이 알림에 적지 마세요.',
    nextGate: null
  }),
  routine_progress: Object.freeze({
    title: '진행 참고',
    summary: '세부 내용은 원래 작업에서 확인하세요.',
    nextGate: null
  })
});

const taskReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{5,159}$/;
const actionableEventTypes = new Set(['user_response_required', 'approval_required', 'critical_error']);

function urgencyFor(event) {
  const supplied = event.urgency;
  if (supplied != null && (!Number.isInteger(supplied) || supplied < 1 || supplied > 5)) {
    throw new TypeError('invalid_notification_urgency');
  }
  const minimum = defaultUrgencyByType[event.type];
  const legacyCritical = event.severity === 'critical' ? 5 : 0;
  return Math.max(supplied ?? minimum, minimum, legacyCritical);
}

function severityFor(urgency) {
  if (urgency >= 5) return 'critical';
  if (urgency >= 3) return 'attention';
  return 'info';
}

function cleanText(value, maxLength) {
  return redactText(String(value ?? '').trim()).slice(0, maxLength);
}

function cleanLine(value, maxLength) {
  return cleanText(value, maxLength).replace(/\s+/g, ' ').trim();
}

function validateKoreanMessageLine(name, value, required) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    if (required) throw new TypeError(`notification_${name}_required`);
    return;
  }
  if (!/[가-힣]/.test(normalized)) throw new TypeError(`invalid_notification_${name}_language`);
  if (/\p{Extended_Pictographic}/u.test(normalized)) throw new TypeError(`invalid_notification_${name}_format`);
}

function validateEvent(event) {
  if (!event || typeof event !== 'object') throw new TypeError('notification_event_required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(String(event.eventId ?? ''))) {
    throw new TypeError('invalid_notification_event_id');
  }
  if (!notificationEventTypes.includes(event.type)) throw new TypeError('unsupported_notification_event_type');
  if (event.severity != null && !['info', 'attention', 'critical'].includes(event.severity)) {
    throw new TypeError('invalid_notification_severity');
  }
  urgencyFor(event);
  if (!['public', 'internal', 'restricted'].includes(event.sensitivity)) throw new TypeError('invalid_notification_sensitivity');
  if (!String(event.title ?? '').trim()) throw new TypeError('notification_title_required');
  if (!String(event.source ?? '').trim()) throw new TypeError('notification_source_required');
  const deliveredEvent = event.type !== 'routine_progress';
  if (deliveredEvent && event.projectKey == null) throw new TypeError('notification_project_key_required');
  if (event.projectKey != null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/.test(String(event.projectKey))) {
    throw new TypeError('invalid_notification_project_key');
  }
  if (deliveredEvent && event.taskId == null) throw new TypeError('notification_task_id_required');
  if (event.taskId != null && !taskReferencePattern.test(String(event.taskId))) {
    throw new TypeError('invalid_notification_task_id');
  }
  if (event.correlationId != null && !taskReferencePattern.test(String(event.correlationId))) {
    throw new TypeError('invalid_notification_correlation_id');
  }
  if (event.owner != null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(String(event.owner))) {
    throw new TypeError('invalid_notification_owner');
  }
  const callerContentIsVisible = event.sensitivity !== 'restricted' && event.type !== 'otp_required';
  if (callerContentIsVisible) {
    validateKoreanMessageLine('title', event.title, true);
    validateKoreanMessageLine('summary', event.summary, deliveredEvent);
    validateKoreanMessageLine('next_gate', event.nextGate, actionableEventTypes.has(event.type));
  }
}

function validateRoutingProfile(value) {
  const profile = String(value ?? 'telegram_primary').trim();
  if (!notificationRoutingProfiles.includes(profile)) throw new TypeError('unsupported_notification_routing_profile');
  return profile;
}

function eventContextLines(event, nextGateValue = event.nextGate) {
  const lines = [];
  const projectKey = cleanLine(event.projectKey, 80);
  const nextGate = cleanLine(nextGateValue, 160);
  if (nextGate) lines.push(`할 일: ${nextGate}`);
  if (projectKey) lines.push(`출처: ${projectKey}`);
  return lines;
}

function messageFor(event, route) {
  const urgency = urgencyFor(event);
  const urgencyLabel = notificationUrgencyLevels[urgency];
  const useFixedContent = event.sensitivity === 'restricted' || event.type === 'otp_required';
  const fixedContent = fixedSafeContentByType[event.type];
  const title = useFixedContent ? fixedContent.title : cleanLine(event.title, 72);
  const summary = useFixedContent
    ? fixedContent.summary
    : cleanLine(event.summary, route.channel === 'telegram' ? 300 : 180);
  const nextGate = useFixedContent ? fixedContent.nextGate : event.nextGate;
  const lines = [`${urgency} ${urgencyLabel} | ${title}`, summary, ...eventContextLines(event, nextGate)].filter(Boolean);
  if (route.responseMode === 'correlated') {
    lines.push(route.channel === 'telegram' ? '응답: 이 알림의 연결 요청' : '응답: Telegram 연결 요청 또는 원래 작업');
  }
  if (route.responseMode === 'report_only' && ['approval_required', 'user_response_required'].includes(event.type)) {
    lines.push('응답: Telegram 연결 요청 또는 원래 작업');
  }
  if (route.responseMode === 'original_task') {
    lines.push('응답: 원래 Codex 작업');
  }
  if (route.responseMode === 'ephemeral_code') {
    lines.push('응답: Telegram 일회성 요청');
  }
  return lines.join('\n');
}

export function planNotification(event, availability = {}, options = {}) {
  validateEvent(event);
  const urgency = urgencyFor(event);
  const routingProfile = validateRoutingProfile(options.routingProfile);
  const policy = routingProfile === 'slack_primary' ? slackPrimaryPolicy : telegramPrimaryPolicy;
  const available = {
    telegram: availability.telegram !== false,
    slack: availability.slack !== false
  };
  const deliveries = policy[event.type].map(route => ({
    ...route,
    available: available[route.channel],
    state: available[route.channel] ? 'planned' : route.required ? 'blocked' : 'unavailable',
    message: messageFor(event, route)
  }));
  const requiredUnavailable = deliveries.filter(item => item.required && !item.available);
  return {
    ok: requiredUnavailable.length === 0,
    event: {
      eventId: event.eventId,
      type: event.type,
      urgency,
      urgencyLabel: notificationUrgencyLevels[urgency],
      severity: severityFor(urgency),
      sensitivity: event.sensitivity,
      source: cleanText(event.source, 160),
      projectKey: cleanText(event.projectKey, 80) || null,
      owner: cleanText(event.owner, 80) || null,
      taskId: cleanText(event.taskId, 160) || null,
      correlationId: cleanText(event.correlationId, 160) || null,
      expiresAt: event.expiresAt ?? null
    },
    routingProfile,
    primaryChannel: deliveries.find(item => item.role === 'primary')?.channel ?? null,
    deliveries,
    blockingReasons: requiredUnavailable.map(item => `${item.channel}_required_unavailable`),
    responseAuthority: event.type === 'otp_required' ? 'telegram_ephemeral_only'
      : ['approval_required', 'user_response_required'].includes(event.type)
        ? routingProfile === 'slack_primary' ? 'original_task' : 'telegram_or_original_task'
        : 'none'
  };
}
