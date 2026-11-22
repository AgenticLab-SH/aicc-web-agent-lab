const COMPLETE_OUTCOMES = new Set(['PASS', 'NOT_APPLICABLE']);
const BLOCKED_OUTCOMES = new Set([
  'HOLD_PRE_DISPATCH',
  'HOLD_POSTREAD',
  'UNCERTAIN',
  'RECONCILE_REQUIRED',
  'FAILED',
  'UNKNOWN'
]);

export const AICC_REPAIR_STAGES = Object.freeze([
  Object.freeze({
    id: 'recovery-foundation',
    label: '복구 기반 설치 확인',
    detail: '공통 journal과 restore v2의 installed identity를 읽고 필요할 때만 CLI entry를 교체합니다.',
    backup: 'CLI entry, legacy pointer와 candidate manifest',
    success: 'status-only 기본 동작, owner-only journal과 exact rollback post-read',
    stop: 'parser ambiguity, hash drift, journal write 실패'
  }),
  Object.freeze({
    id: 'workspace-business',
    label: 'Business Workspace',
    detail: 'Business full-write package, runtime marker, Tunnel과 tool snapshot을 한 transaction으로 확인합니다.',
    backup: 'Business stable app ID와 installed package/runtime preimage',
    success: 'source·installed·runtime post-read와 reversible scratch canary',
    stop: 'identity mismatch, active lease, publication ACK ambiguity'
  }),
  Object.freeze({
    id: 'workspace-personal',
    label: 'Personal Workspace',
    detail: 'Personal read-fetch package를 Business와 별도 failure domain으로 확인합니다.',
    backup: 'Personal stable app ID와 read-only manifest preimage',
    success: '18-tool read surface와 forged write deny post-read',
    stop: 'write tool 노출, identity mismatch, active lease'
  }),
  Object.freeze({
    id: 'ocx-direct',
    label: 'OCX direct',
    detail: '10100 installed target과 readiness를 비교하고 필요한 경우에만 별도 one-shot으로 갱신합니다.',
    backup: 'OCX package, service unit과 Codex config hash',
    success: 'health·ready·catalog PASS와 비대상 route 불변',
    stop: 'active turn, config drift, cutover ACK ambiguity'
  }),
  Object.freeze({
    id: 'integrated-route',
    label: 'Integrated 17841',
    detail: 'launchd 원인 확인 뒤 service와 browser branch를 나눠 한 번씩 검증합니다.',
    backup: 'plist, bundle identity, process-start identity와 survival snapshot',
    success: 'strict readiness와 bounded native/browser canary',
    stop: 'exit 5 원인 미확정, counter UNKNOWN, 17842·10100·Native 변화'
  }),
  Object.freeze({
    id: 'personal-pro-account',
    label: 'Account 3 Personal Pro',
    detail: '등록된 exact saved Chat에서 첫 account/browser post-read와 lineage canary를 수행합니다.',
    backup: 'registered target, account/workspace hash와 saved Chat lineage',
    success: 'exact account·Chat·plugin/app visibility와 retrieval canary',
    stop: 'target/account drift, foreign tab, dispatch ambiguity'
  }),
  Object.freeze({
    id: 'business-accounts',
    label: 'Business owner와 member',
    detail: '두 Business 계정을 직렬로 확인하고 같은 canonical lineage만 유지합니다.',
    backup: 'account별 plugin/app inventory와 dependency graph',
    success: '두 계정 exact post-read, tool canary와 duplicate 0',
    stop: 'stable ID UNKNOWN, role mismatch, unrelated dependency 영향'
  }),
  Object.freeze({
    id: 'publication-sync',
    label: 'Publication·Project·Notion',
    detail: 'app publication, 기존 복구 Project delta와 필요한 Notion sync를 서로 다른 transaction으로 닫습니다.',
    backup: 'published revision, Project resource/instruction hash와 prior sync evidence',
    success: 'stable ID post-read, retrieval canary와 existing asset duplicate 0',
    stop: 'same-ID update 가정, remote effect 불명, 기존 자산 재생성 필요'
  }),
  Object.freeze({
    id: 'callback-e2e',
    label: 'Callback·queue·reconcile E2E',
    detail: 'same-thread callback과 orphan/stalled/compaction reconciliation을 no-replay로 검증합니다.',
    backup: 'operation/attempt ID, prior callback state와 exact task lineage',
    success: 'same task terminal, duplicate send 0와 owner-only result',
    stop: 'ACK ambiguity, wrong thread, uncertain external effect'
  })
]);

function normalizeGate(gate) {
  const activeCount = Number.isSafeInteger(gate?.activeCount) && gate.activeCount >= 0 ? gate.activeCount : null;
  const unknownCount = Number.isSafeInteger(gate?.unknownCount) && gate.unknownCount >= 0 ? gate.unknownCount : null;
  const readOk = gate?.readOk === true && activeCount !== null && unknownCount !== null;
  if (!readOk || unknownCount > 0 || (gate?.exactIdle === false && activeCount === 0)) return { state: 'unknown', activeCount, unknownCount, exactIdle: false };
  if (activeCount > 0) return { state: 'active', activeCount, unknownCount, exactIdle: false };
  return { state: 'idle', activeCount, unknownCount, exactIdle: true };
}

function normalizeOutcomes(outcomes) {
  if (!outcomes || typeof outcomes !== 'object' || Array.isArray(outcomes)) throw new TypeError('outcomes must be an object');
  const knownIds = new Set(AICC_REPAIR_STAGES.map(stage => stage.id));
  const normalized = {};
  for (const [stageId, outcome] of Object.entries(outcomes)) {
    if (!knownIds.has(stageId)) throw new TypeError(`unknown repair stage: ${stageId}`);
    if (!COMPLETE_OUTCOMES.has(outcome) && !BLOCKED_OUTCOMES.has(outcome)) {
      throw new TypeError(`unsupported repair outcome: ${outcome}`);
    }
    normalized[stageId] = outcome;
  }
  return normalized;
}

export function planAiccRepairSequence({ gate, outcomes = {} } = {}) {
  const normalizedGate = normalizeGate(gate);
  const normalizedOutcomes = normalizeOutcomes(outcomes);
  const firstUnresolved = AICC_REPAIR_STAGES.findIndex(stage => !COMPLETE_OUTCOMES.has(normalizedOutcomes[stage.id]));
  const outOfOrder = firstUnresolved >= 0 && AICC_REPAIR_STAGES
    .slice(firstUnresolved + 1)
    .some(stage => COMPLETE_OUTCOMES.has(normalizedOutcomes[stage.id]));

  if (outOfOrder) {
    return {
      gate: normalizedGate,
      state: 'conflict',
      allowedScope: 'source-test-documentation-only',
      currentStageId: null,
      nextStageId: null,
      reason: 'out_of_order_terminal_evidence',
      stages: AICC_REPAIR_STAGES.map(stage => ({ ...stage, outcome: normalizedOutcomes[stage.id] ?? null, state: 'waiting', nextAction: 'reconcile_sequence' }))
    };
  }

  if (!normalizedGate.exactIdle) {
    return {
      gate: normalizedGate,
      state: normalizedGate.state,
      allowedScope: 'source-test-documentation-only',
      currentStageId: null,
      nextStageId: null,
      reason: normalizedGate.state === 'unknown' ? 'active_or_lifecycle_unknown' : 'active_nonzero',
      stages: AICC_REPAIR_STAGES.map(stage => ({ ...stage, outcome: normalizedOutcomes[stage.id] ?? null, state: COMPLETE_OUTCOMES.has(normalizedOutcomes[stage.id]) ? 'complete' : 'waiting', nextAction: 'wait_for_exact_idle' }))
    };
  }

  let currentStageId = null;
  let nextStageId = null;
  let blocked = false;
  const stages = AICC_REPAIR_STAGES.map(stage => {
    const outcome = normalizedOutcomes[stage.id] ?? null;
    if (COMPLETE_OUTCOMES.has(outcome)) return { ...stage, outcome, state: 'complete', nextAction: 'none' };
    if (currentStageId || nextStageId) return { ...stage, outcome, state: 'waiting', nextAction: 'wait_for_prior_terminal' };
    currentStageId = stage.id;
    if (BLOCKED_OUTCOMES.has(outcome)) {
      blocked = true;
      return {
        ...stage,
        outcome,
        state: 'blocked',
        nextAction: ['UNCERTAIN', 'RECONCILE_REQUIRED'].includes(outcome) ? 'reconcile_only' : 'inspect_and_replan'
      };
    }
    nextStageId = stage.id;
    return { ...stage, outcome, state: 'current', nextAction: 'read_only_preflight' };
  });

  const complete = currentStageId === null;
  return {
    gate: normalizedGate,
    state: complete ? 'complete' : blocked ? 'blocked' : 'ready',
    allowedScope: complete ? 'none' : blocked ? 'reconcile-only' : 'component-scoped-one-shot-after-preflight',
    currentStageId,
    nextStageId,
    reason: complete ? 'all_stages_terminal' : blocked ? 'current_stage_not_terminal' : 'exact_idle_preflight_required',
    stages
  };
}
