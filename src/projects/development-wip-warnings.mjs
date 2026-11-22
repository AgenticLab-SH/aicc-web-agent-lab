export class DevelopmentWipWarningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DevelopmentWipWarningError';
    this.code = code;
  }
}

const DEFAULT_POLICY = Object.freeze({
  dirtyDays: 7,
  incompleteTasksPerProject: 3,
  worktreesPerProject: 5,
  dirtyWorktreesPerProject: 2,
  focusPrograms: 3
});

function text(value) {
  return value === undefined || value === null || value === '' ? null : String(value).trim();
}

function iso(value, label) {
  const normalized = text(value);
  if (!normalized) return null;
  const time = Date.parse(normalized);
  if (Number.isNaN(time)) throw new DevelopmentWipWarningError('date_invalid', `${label} is not a valid date`);
  return new Date(time).toISOString();
}

function projectId(row) {
  return text(row?.projectId ?? row?.id ?? row?.['프로젝트 ID'] ?? row?.['고유 ID']);
}

function projectUrl(row) {
  return text(row?.url ?? row?.pageUrl);
}

function strategy(row) {
  return text(row?.strategy ?? row?.['전략 분류']);
}

function lastCheckedValue(row) {
  return text(row?.lastCheckedAt ?? row?.['date:마지막 확인일:start'] ?? row?.['마지막 확인일']);
}

function gitNewerThanLastCheck(commitAt, row) {
  const raw = lastCheckedValue(row);
  if (!raw) return { newer: false, checkedAt: null };
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { newer: commitAt.slice(0, 10) > raw, checkedAt: raw };
  }
  const checkedAt = iso(raw, 'project last checked');
  return { newer: Date.parse(commitAt) > Date.parse(checkedAt), checkedAt };
}

function relationValues(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const candidate = text(value);
  if (!candidate) return [];
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed.map(text).filter(Boolean) : [];
  } catch {
    throw new DevelopmentWipWarningError('relation_invalid', 'relation value must be an array or JSON array');
  }
}

function parentUrls(row) {
  return relationValues(row?.parentProjects ?? row?.['상위 프로젝트']);
}

function taskProjects(row) {
  return relationValues(row?.projects ?? row?.['프로젝트']);
}

function taskIncomplete(row) {
  const status = text(row?.status ?? row?.['상태']);
  const codeStage = text(row?.codeStage ?? row?.['코드 단계']);
  return status !== '완료' && codeStage !== '없음';
}

function headDate(item) {
  return iso(item?.head_date ?? item?.headDate, 'Git head date');
}

function warning(code, projectIdValue, evidence, message) {
  return { code, projectId: projectIdValue ?? null, message, evidence };
}

function sourceLookup(report) {
  const sources = report.projects.filter(item => (item.role ?? 'source') === 'source');
  const worktrees = report.projects.filter(item => item.role === 'worktree');
  const sourceByRepo = new Map();
  for (const source of sources) {
    const repo = text(source.canonical_repo);
    if (repo) sourceByRepo.set(repo, source);
  }
  return { sources, worktrees, sourceByRepo };
}

function resolveFocusPrograms(projects, focusProgramGroups = []) {
  const focusedIds = new Set(projects.filter(row => strategy(row) === '집중').map(projectId).filter(Boolean));
  const membership = new Map();
  for (const group of focusProgramGroups) {
    const groupId = text(group?.id);
    const members = Array.isArray(group?.members) ? group.members.map(text).filter(Boolean) : [];
    if (!groupId || !members.length) throw new DevelopmentWipWarningError('focus_group_invalid', 'focus program group requires id and members');
    for (const member of members) {
      if (membership.has(member)) throw new DevelopmentWipWarningError('focus_group_overlap', `${member} belongs to multiple focus program groups`);
      membership.set(member, groupId);
    }
  }
  const programs = new Set();
  for (const id of focusedIds) programs.add(membership.get(id) ?? id);
  return [...programs].sort();
}

export function planDevelopmentWipWarnings({
  portfolioReport,
  projectRecords = [],
  taskRecords = [],
  previousState = null,
  observedAt = new Date().toISOString(),
  policy = {}
} = {}) {
  if (!portfolioReport || !Array.isArray(portfolioReport.projects)) {
    throw new DevelopmentWipWarningError('portfolio_report_invalid', 'portfolio report requires a projects array');
  }
  const observed = iso(observedAt, 'observedAt');
  const effectivePolicy = { ...DEFAULT_POLICY, ...policy };
  const projectById = new Map();
  const projectByUrl = new Map();
  for (const row of projectRecords) {
    const id = projectId(row);
    if (!id) throw new DevelopmentWipWarningError('project_id_missing', 'project snapshot row is missing project ID');
    projectById.set(id, row);
    const url = projectUrl(row);
    if (url) projectByUrl.set(url, id);
  }

  const priorDirty = previousState?.dirtyFirstSeenByItemId && typeof previousState.dirtyFirstSeenByItemId === 'object'
    ? previousState.dirtyFirstSeenByItemId : {};
  const dirtyFirstSeenByItemId = {};
  const warnings = [];
  const { sources, worktrees, sourceByRepo } = sourceLookup(portfolioReport);

  for (const item of portfolioReport.projects) {
    if (Number(item.dirty_files ?? 0) <= 0) continue;
    const firstSeen = iso(priorDirty[item.id], 'dirty first seen') ?? observed;
    dirtyFirstSeenByItemId[item.id] = firstSeen;
    const ageDays = (Date.parse(observed) - Date.parse(firstSeen)) / 86400000;
    if (ageDays >= effectivePolicy.dirtyDays) {
      const source = item.role === 'worktree' ? sourceByRepo.get(text(item.canonical_repo)) : item;
      warnings.push(warning(
        'DIRTY_AGING',
        source?.id ?? item.id,
        { itemId: item.id, firstSeenDirtyAt: firstSeen, observedAt: observed, ageDays: Number(ageDays.toFixed(2)), dirtyFiles: Number(item.dirty_files ?? 0) },
        `${item.id} has remained dirty for at least ${effectivePolicy.dirtyDays} days`
      ));
    }
  }

  const taskCounts = new Map();
  for (const task of taskRecords.filter(taskIncomplete)) {
    for (const url of taskProjects(task)) {
      const id = projectByUrl.get(url);
      if (!id) continue;
      taskCounts.set(id, (taskCounts.get(id) ?? 0) + 1);
    }
  }
  for (const [id, count] of taskCounts) {
    if (count > effectivePolicy.incompleteTasksPerProject) {
      warnings.push(warning('TASK_OVERLOAD', id, { incompleteImplementationTasks: count, threshold: effectivePolicy.incompleteTasksPerProject },
        `${id} has ${count} incomplete implementation tasks`));
    }
  }

  for (const source of sources) {
    const related = worktrees.filter(item => text(item.canonical_repo) === text(source.canonical_repo));
    const dirtyCount = related.filter(item => Number(item.dirty_files ?? 0) > 0).length;
    if (related.length > effectivePolicy.worktreesPerProject || dirtyCount > effectivePolicy.dirtyWorktreesPerProject) {
      warnings.push(warning('WORKTREE_OVERLOAD', source.id, {
        worktreeCount: related.length,
        dirtyWorktreeCount: dirtyCount,
        worktreeThreshold: effectivePolicy.worktreesPerProject,
        dirtyWorktreeThreshold: effectivePolicy.dirtyWorktreesPerProject
      }, `${source.id} has excessive registered worktree WIP`));
    }
  }

  const focusPrograms = resolveFocusPrograms(projectRecords, effectivePolicy.focusProgramGroups ?? []);
  if (focusPrograms.length > effectivePolicy.focusPrograms) {
    warnings.push(warning('FOCUS_PROGRAM_OVERLOAD', null, {
      focusProgramCount: focusPrograms.length,
      focusPrograms,
      threshold: effectivePolicy.focusPrograms
    }, `focused program axes exceed ${effectivePolicy.focusPrograms}`));
  }

  for (const source of sources) {
    const row = projectById.get(source.id);
    if (!row) continue;
    const commitAt = headDate(source);
    if (!commitAt) continue;
    const comparison = gitNewerThanLastCheck(commitAt, row);
    if (comparison.newer) {
      warnings.push(warning('GIT_NEWER_THAN_NOTION', source.id, { headDate: commitAt, lastCheckedAt: comparison.checkedAt },
        `${source.id} has a Git commit newer than its Notion verification date`));
      if (strategy(row) === '보관 검토') {
        warnings.push(warning('ARCHIVE_REVIEW_NEW_COMMIT', source.id, { headDate: commitAt, lastCheckedAt: comparison.checkedAt },
          `${source.id} is under archive review but has a newer Git commit`));
      }
    }
  }

  warnings.sort((a, b) => (a.code + ':' + (a.projectId ?? '')).localeCompare(b.code + ':' + (b.projectId ?? '')));
  const counts = Object.fromEntries([...new Set(warnings.map(item => item.code))].sort()
    .map(code => [code, warnings.filter(item => item.code === code).length]));

  return {
    schemaVersion: 1,
    observedAt: observed,
    externalWritePerformed: false,
    mutationPerformed: false,
    policy: effectivePolicy,
    summary: { warningCount: warnings.length, counts, focusProgramCount: focusPrograms.length },
    warnings,
    nextState: { schemaVersion: 1, observedAt: observed, dirtyFirstSeenByItemId }
  };
}

export const developmentWipWarningPolicy = DEFAULT_POLICY;
