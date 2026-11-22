import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { UserActionLedger } from './user-action-ledger.mjs';

const STATUS_ORDER = ['ACTIVE', 'HOLD', 'REVIEW_READY', 'USER_MANAGED_READY', 'COMPLETE', 'UNASSIGNED'];
const SIMPLE_TEXT_FORBIDDEN = /\b(?:UAC|HOLD|SHA-?256|MCP|CDP|PIT|OOS|SSOT|DRIFT)\b/i;
const REPORT_STATUS = new Set(['PROGRESS', 'DONE', 'HOLD', 'APPROVAL_REQUIRED', 'DRIFT']);
const goalHash = value => createHash('sha256').update(value).digest('hex');

function serviceError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Only the existing tracked ledger is wired here. Caller fields and a dashboard
// projection cannot supply a native parent's authority or latest stop epoch.
export function assertSupportedParentGoalAuthority(binding) {
  if (!binding) return;
  const fields = new Set(['goalId', 'sourceUpdatedAt', 'goalSnapshotHash', 'authorityMode', 'ownerThreadId', 'stopEpoch']);
  if (typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).some(key => !fields.has(key))) {
    throw serviceError('invalid_parent_goal', 'parent goal contains an unsupported binding field');
  }
  if (binding.authorityMode != null && binding.authorityMode !== 'COOPERATIVE'
    || Object.hasOwn(binding, 'ownerThreadId') || Object.hasOwn(binding, 'stopEpoch')) {
    throw serviceError('native_parent_authority_unavailable', 'native parent owner/revision/latest stop epoch reader is not registered; tracked observation cannot satisfy native authority');
  }
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw serviceError('invalid_goal_ledger', `목표 원장 JSON을 읽을 수 없습니다: ${filePath}`);
  }
}

function validateMaster(master) {
  if (!master || !Array.isArray(master.goals)) throw serviceError('invalid_goal_ledger', '목표 원장에 goals 배열이 없습니다.');
  const seen = new Set();
  for (const goal of master.goals) {
    if (!goal || typeof goal.id !== 'string' || !goal.id.trim() || typeof goal.title !== 'string' || !goal.title.trim()) {
      throw serviceError('invalid_goal_ledger', '모든 목표에는 id와 title이 필요합니다.');
    }
    if (seen.has(goal.id)) throw serviceError('invalid_goal_ledger', `중복 목표 id입니다: ${goal.id}`);
    if (!STATUS_ORDER.includes(goal.status)) throw serviceError('invalid_goal_ledger', `알 수 없는 목표 상태입니다: ${goal.status}`);
    seen.add(goal.id);
  }
  if (master.userHelp !== undefined) {
    if (!Array.isArray(master.userHelp)) throw serviceError('invalid_goal_ledger', 'userHelp는 배열이어야 합니다.');
    for (const item of master.userHelp) {
      if (!item || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.ask !== 'string'
        || typeof item.why !== 'string' || !Array.isArray(item.steps) || item.steps.length > 3) {
        throw serviceError('invalid_goal_ledger', '도움 요청은 제목, 요청, 이유와 최대 3단계가 필요합니다.');
      }
      const visibleText = [item.title, item.ask, item.why, ...item.steps].join(' ');
      if (visibleText.length > 640 || SIMPLE_TEXT_FORBIDDEN.test(visibleText)) {
        throw serviceError('invalid_goal_ledger', '사용자 도움 요청에는 어려운 약어나 긴 설명을 바로 노출할 수 없습니다.');
      }
    }
  }
  return master;
}

function normalizeReports(raw) {
  if (!raw || raw.schemaVersion !== 1 || !raw.workers || typeof raw.workers !== 'object') {
    return { sequence: 0, digest: null, updatedAt: null, workers: {}, counts: {}, attention: [] };
  }
  const workers = Object.fromEntries(Object.entries(raw.workers).flatMap(([id, worker]) => {
    if (!worker || !REPORT_STATUS.has(worker.status)) return [];
    return [[id, {
      workerId: id,
      status: worker.status,
      summary: worker.summary ?? null,
      nextGate: worker.nextGate ?? null,
      ...Object.fromEntries(['completed', 'remaining', 'choices'].filter(key => Array.isArray(worker[key])).map(key => [key, worker[key].slice(0, 6).filter(value => typeof value === 'string').map(value => value.slice(0, 240))])),
      ...(typeof worker.nextAction === 'string' ? { nextAction: worker.nextAction.slice(0, 160) } : {}),
      updatedAt: worker.updatedAt ?? null,
      revision: worker.revision ?? null
    }]];
  }));
  return {
    sequence: Number.isInteger(raw.sequence) ? raw.sequence : 0,
    digest: typeof raw.digest === 'string' ? raw.digest : null,
    updatedAt: raw.updatedAt ?? null,
    workers,
    counts: raw.counts ?? {},
    attention: Array.isArray(raw.attention) ? raw.attention : []
  };
}

function normalizeSessions(raw, reports) {
  if (!raw || !Array.isArray(raw.sessions)) return [];
  return raw.sessions.flatMap(session => {
    if (!session || !/^(?:0[1-9]|1[01])$/.test(String(session.number ?? '')) || typeof session.title !== 'string') return [];
    const reportWorkerIds = Array.isArray(session.reportWorkerIds) ? session.reportWorkerIds.filter(id => typeof id === 'string') : [];
    const latestReport = reportWorkerIds.map(id => reports.workers[id]).filter(Boolean)
      .sort((left, right) => Date.parse(right.updatedAt ?? 0) - Date.parse(left.updatedAt ?? 0))[0] ?? null;
    return [{
      number: session.number,
      title: session.title,
      threadId: session.threadId ?? null,
      mode: session.mode ?? 'AUTOMATIC',
      state: latestReport?.status ?? session.state ?? 'UNKNOWN',
      objective: session.objective ?? session.work ?? null,
      progress: session.progress ?? latestReport?.summary ?? session.latestSummary ?? session.work ?? null,
      remaining: session.remaining ?? latestReport?.nextGate ?? session.next ?? null,
      decision: session.decision ?? 'KEEP',
      archiveReason: session.archiveReason ?? null,
      work: session.work ?? null,
      next: latestReport?.nextAction ?? latestReport?.nextGate ?? session.next ?? null,
      latestSummary: latestReport?.summary ?? session.latestSummary ?? null,
      ...(latestReport ? { latestReport } : {}),
      updatedAt: latestReport?.updatedAt ?? session.updatedAt ?? null,
      reportWorkerIds
    }];
  }).sort((left, right) => left.number.localeCompare(right.number));
}

function normalizeState(raw) {
  const checks = raw?.checks && typeof raw.checks === 'object' ? raw.checks : {};
  return { schemaVersion: 1, updatedAt: raw?.updatedAt ?? null, checks };
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function appendEvent(filePath, event) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function eventCount(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).length;
}

export function createGoalLedgerService(options = {}) {
  const ownerRoot = options.ownerRoot ?? path.join(os.homedir(), '.ai-control-center');
  const masterGoalsPath = options.masterGoalsPath ?? path.join(ownerRoot, 'control-plane', 'master-goals.json');
  const statePath = options.statePath ?? path.join(ownerRoot, 'dashboard', 'goal-ledger-state.json');
  const eventsPath = options.eventsPath ?? path.join(ownerRoot, 'dashboard', 'goal-ledger-events.jsonl');
  const reportsPath = options.reportsPath ?? path.join(ownerRoot, 'control-plane', 'reports-v1', 'snapshot.json');
  const sessionsPath = options.sessionsPath ?? path.join(ownerRoot, 'control-plane', 'session-registry.json');
  const now = options.now ?? (() => new Date().toISOString());
  const userActionLedger = options.userActionLedger ?? new UserActionLedger({
    ownerRoot,
    snapshotPath: options.userActionsPath,
    eventsPath: options.userActionEventsPath,
    now
  });

  function masterRecord() {
    for (let current = path.resolve(masterGoalsPath);; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) throw serviceError('goal_link_denied', '연결된 파일을 통한 목표 편집은 지원하지 않습니다.');
      if (current === path.dirname(current)) break;
    }
    const stat = fs.statSync(masterGoalsPath);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw serviceError('invalid_goal_ledger', '목표 원장 파일을 확인할 수 없습니다.');
    const bytes = fs.readFileSync(masterGoalsPath);
    let master;
    try { master = validateMaster(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))); }
    catch (error) { if (error.code) throw error; throw serviceError('invalid_goal_ledger', '목표 원장 형식을 확인할 수 없습니다.'); }
    return { master, revision: goalHash(bytes) };
  }
  function editedMaster(master, input, newId) {
    const keys = new Set(['action', 'goalId', 'title', 'description', 'dependsOn', 'archived', 'expectedSourceRevision']);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.has(key)) || !['goal-save', 'goal-archive'].includes(input.action)) throw serviceError('invalid_goal_edit', '목표 설명·의존 관계·보관 편집만 지원합니다.');
    if (Object.hasOwn(input, 'goalId') && (typeof input.goalId !== 'string' || !input.goalId.trim())) throw serviceError('invalid_goal_edit', '기존 목표의 정확한 식별자가 필요합니다.');
    const next = structuredClone(master);
    let goal = input.goalId ? next.goals.find(g => g.id === input.goalId) : null;
    if (input.goalId && !goal) throw serviceError('unknown_goal', '목표를 찾지 못했습니다.');
    if (input.action === 'goal-archive') {
      if (!goal || typeof input.archived !== 'boolean' || ['title', 'description', 'dependsOn'].some(k => Object.hasOwn(input, k))) throw serviceError('invalid_goal_edit', '보관할 목표와 보관 여부가 필요합니다.');
      goal.archived = input.archived;
    } else {
      if (Object.hasOwn(input, 'archived')) throw serviceError('invalid_goal_edit', '보관은 별도 동작으로 확인하세요.');
      const title = input.title ?? goal?.title;
      const description = input.description ?? goal?.description ?? '';
      if (typeof title !== 'string' || !title.trim() || title.length > 240 || /[\x00-\x1f\x7f]/.test(title) || typeof description !== 'string' || description.length > 2000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(description.replace(/\r\n/g, '\n'))) throw serviceError('invalid_goal_edit', '이름은 240자, 설명은 2000자 안으로 작성하세요.');
      const dependsOn = input.dependsOn ?? goal?.dependsOn ?? [];
      if (!Array.isArray(dependsOn) || dependsOn.length > 100 || new Set(dependsOn).size !== dependsOn.length || dependsOn.some(id => typeof id !== 'string' || !next.goals.some(g => g.id === id && !g.archived))) throw serviceError('invalid_goal_dependency', '의존 목표는 보관되지 않은 기존 목표를 중복 없이 선택하세요.');
      if (!goal) { goal = { id: newId, status: 'UNASSIGNED', createdAt: now() }; next.goals.push(goal); }
      Object.assign(goal, { title: title.trim(), description: description.replace(/\r\n/g, '\n').trim(), dependsOn });
    }
    const visiting = new Set(), visited = new Set();
    const walk = id => {
      if (visiting.has(id)) throw serviceError('goal_dependency_cycle', '목표가 서로 완료를 기다리는 순환 관계입니다.');
      if (visited.has(id)) return;
      if (visiting.size > 500) throw serviceError('invalid_goal_dependency', '의존 관계가 너무 깊습니다. 관계를 나눠 확인하세요.');
      visiting.add(id);
      const current = next.goals.find(g => g.id === id), dependencies = current?.dependsOn ?? [];
      if (!current || !Array.isArray(dependencies)) throw serviceError('invalid_goal_dependency', '기존 의존 관계를 먼저 확인하세요.');
      for (const dependency of dependencies) walk(dependency);
      visiting.delete(id); visited.add(id);
    };
    for (const current of next.goals) walk(current.id);
    goal.updatedAt = now();
    return { next, goal };
  }
  function prepareEdit(input) {
    const { master, revision } = masterRecord();
    if (input?.expectedSourceRevision !== revision) throw serviceError('goal_revision_conflict', '다른 목표 편집이 먼저 저장됐습니다. 새로 조회하세요.');
    const { goal } = editedMaster(master, input, 'preview-new-goal');
    return { kind: 'goal', action: input.action, fingerprint: goalHash(JSON.stringify({ revision, input })), summary: ['AICC 추적 목표의 설명·관계 편집입니다. 실행·발신·Codex 내장 goal·운영 상태는 변경하지 않습니다.', `목표: ${goal.title}`, `설명: ${goal.description ?? '기록 없음'}`, `먼저 완료할 목표: ${(goal.dependsOn ?? []).map(id => master.goals.find(g => g.id === id)?.title ?? id).join(' / ') || '없음'}`, `보관: ${goal.archived ? '보관함으로 이동' : '활성 목록'}`, `운영 상태: ${goal.status} (유지)`] };
  }
  function commitEdit(input, operationId) {
    if (!/^[a-f0-9-]{8,80}$/.test(operationId ?? '')) throw serviceError('invalid_goal_edit', '편집 식별자를 확인할 수 없습니다.');
    masterRecord(); // Reject links before opening a cross-process writer lock.
    const lockFile = masterGoalsPath + '.edit.lock';
    let lock;
    try { lock = fs.openSync(lockFile, 'wx', 0o600); }
    catch { throw serviceError('goal_writer_busy', '다른 목표 작성자가 저장 중입니다.'); }
    try {
      const { master, revision } = masterRecord(), requestHash = goalHash(JSON.stringify(input));
      const prior = master._aiccDashboardEdits;
      if (prior && (prior.schemaVersion !== 1 || !Array.isArray(prior.operations) || !Array.isArray(prior.history))) throw serviceError('invalid_goal_ledger', '기존 편집 이력을 먼저 확인하세요.');
      const duplicate = prior?.operations.find(op => op.id === operationId);
      if (duplicate) {
        if (duplicate.requestHash !== requestHash) throw serviceError('goal_operation_conflict', '같은 식별자로 다른 편집을 저장할 수 없습니다.');
        return { duplicate: true, sourceRevision: revision, dispatched: false, nativeGoalMutated: false };
      }
      if (input?.expectedSourceRevision !== revision) throw serviceError('goal_revision_conflict', '다른 목표 편집이 먼저 저장됐습니다. 새로 조회하세요.');
      const { next, goal } = editedMaster(master, input, `goal:${randomUUID()}`), at = now();
      next._aiccDashboardEdits = { schemaVersion: 1, revision: (prior?.revision ?? 0) + 1, updatedAt: at, operations: [...(prior?.operations ?? []), { id: operationId, requestHash }].slice(-100), history: [...(prior?.history ?? []), { operationId, action: input.action, goalId: goal.id, at, before: master.goals.find(g => g.id === goal.id) ?? null, afterHash: goalHash(JSON.stringify(goal)) }].slice(-60) };
      const content = JSON.stringify(next, null, 2) + '\n', temp = `${masterGoalsPath}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (masterRecord().revision !== revision) throw serviceError('goal_revision_conflict', '목표 원문이 달라져 편집을 중단했습니다.');
      fs.renameSync(temp, masterGoalsPath);
      const post = masterRecord();
      if (post.revision !== goalHash(content)) throw serviceError('goal_poststate_unknown', '목표 저장 결과를 원 요청으로 확인하세요.');
      return { sourceRevision: post.revision, goalId: goal.id, dispatched: false, nativeGoalMutated: false };
    } finally { fs.closeSync(lock); fs.unlinkSync(lockFile); }
  }

  function status() {
    if (!fs.existsSync(masterGoalsPath)) throw serviceError('goal_ledger_missing', '정본 목표 원장을 찾지 못했습니다.');
    const { master, revision } = masterRecord();
    const state = normalizeState(readJson(statePath, {}));
    const reports = normalizeReports(readJson(reportsPath, null));
    const sessions = normalizeSessions(readJson(sessionsPath, null), reports);
    const userActions = userActionLedger.status();
    const goals = master.goals.map(goal => {
      const check = state.checks[goal.id];
      return { ...goal, checked: check?.checked === true, checkedAt: check?.checkedAt ?? null };
    });
    return {
      ok: true,
      schemaVersion: 1,
      ledgerKind: 'aicc-tracked-goals',
      sourceRevision: revision,
      metadataEditingSupported: true,
      nativeCodexGoal: { state: 'UNKNOWN', read: false, mutated: false,
        authoritySource: null, stopEpoch: 'UNKNOWN', requiredReader: 'exact-parent-owner-revision-and-latest-stop-epoch' },
      checkedMeaning: 'owner-check-only-not-goal-completion',
      sourceUpdatedAt: [master.generatedAt, master._aiccDashboardEdits?.updatedAt].filter(value => Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
      viewUpdatedAt: state.updatedAt,
      purpose: master.purpose ?? null,
      statusDefinitions: master.statusDefinitions ?? {},
      summary: {
        goalCount: goals.length,
        checkedCount: goals.filter(goal => goal.checked).length,
        completedCount: goals.filter(goal => goal.status === 'COMPLETE').length,
        byStatus: Object.fromEntries(STATUS_ORDER.map(name => [name, goals.filter(goal => goal.status === name).length]))
      },
      statusOrder: STATUS_ORDER,
      historyCount: eventCount(eventsPath),
      coordination: {
        userHelp: master.userHelp ?? [],
        userActions,
        sessions,
        reports: {
          sequence: reports.sequence,
          digest: reports.digest,
          updatedAt: reports.updatedAt,
          counts: reports.counts,
          attention: reports.attention
        },
        notionSync: master.notionSync ?? null
      },
      goals
    };
  }

  function setChecked(input = {}) {
    if (typeof input.goalId !== 'string' || typeof input.checked !== 'boolean') {
      throw serviceError('invalid_goal_check', 'goalId와 boolean checked가 필요합니다.');
    }
    if (!fs.existsSync(masterGoalsPath)) throw serviceError('goal_ledger_missing', '정본 목표 원장을 찾지 못했습니다.');
    const master = validateMaster(readJson(masterGoalsPath));
    if (!master.goals.some(goal => goal.id === input.goalId)) throw serviceError('unknown_goal', `목표를 찾지 못했습니다: ${input.goalId}`);
    const state = normalizeState(readJson(statePath, {}));
    const at = now();
    state.updatedAt = at;
    state.checks[input.goalId] = { checked: input.checked, checkedAt: input.checked ? at : null };
    atomicWriteJson(statePath, state);
    appendEvent(eventsPath, { schemaVersion: 1, at, goalId: input.goalId, checked: input.checked });
    return status();
  }

  function completeUserAction(input = {}) {
    const result = userActionLedger.complete({ ...input, completedBy: 'USER' });
    return { ...result, userActions: userActionLedger.status() };
  }

  return {
    status,
    setChecked,
    completeUserAction,
    prepareUserActionComplete: input => userActionLedger.prepareComplete(input),
    prepareEdit,
    commitEdit,
    paths: {
      masterGoalsPath,
      statePath,
      eventsPath,
      reportsPath,
      sessionsPath,
      userActionsPath: userActionLedger.snapshotPath,
      userActionEventsPath: userActionLedger.eventsPath
    }
  };
}
