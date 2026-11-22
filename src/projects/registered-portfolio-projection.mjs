export class RegisteredPortfolioProjectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RegisteredPortfolioProjectionError';
    this.code = code;
  }
}

function text(value) {
  return value === undefined || value === null || value === '' ? null : String(value).trim();
}

function currentTitle(row) {
  return text(row?.title ?? row?.name ?? row?.['프로젝트'] ?? row?.['이름']);
}

function currentProjectId(row) {
  return text(row?.projectId ?? row?.id ?? row?.['프로젝트 ID'] ?? row?.['고유 ID']);
}

function currentRoot(row) {
  return text(row?.canonicalRoot ?? row?.['로컬 기준 경로'] ?? row?.['로컬 정본']);
}

function normalizedPath(value) {
  return text(value)?.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() ?? null;
}

function repositoryValue(value, fallback = null) {
  const candidate = text(value);
  if (!candidate) return fallback;
  if (/^https?:\/\//i.test(candidate)) return candidate;
  if (/^[^/]+\/[^/]+$/.test(candidate)) return `https://github.com/${candidate}`;
  return candidate;
}
function baselineLocalMap(baseline) {
  return new Map(Object.entries(baseline?.projects ?? {}).flatMap(([projectId, pair]) =>
    pair?.local ? [[projectId, structuredClone(pair.local)]] : []
  ));
}

function catalogRecord(project, projectId, notionRow, existing = {}) {
  return {
    ...existing,
    projectId,
    title: existing.title ?? currentTitle(notionRow) ?? text(project.title) ?? projectId,
    canonicalRoot: text(project.canonicalRoot),
    repository: repositoryValue(project.links?.repository, existing.repository ?? null),
    serviceUrl: text(project.links?.production) ?? existing.serviceUrl ?? null
  };
}

function registeredRecord(source, notionRow, existing = {}) {
  return {
    ...existing,
    projectId: source.id,
    title: existing.title ?? currentTitle(notionRow) ?? source.id,
    canonicalRoot: text(source.git_root ?? source.path),
    repository: repositoryValue(source.canonical_repo, existing.repository ?? null),
    serviceUrl: existing.serviceUrl ?? null
  };
}

export function projectPortfolioDevelopmentState({
  report,
  baseline = null,
  notionRecords = [],
  catalogProjects = []
} = {}) {
  if (!report || !Array.isArray(report.projects)) {
    throw new RegisteredPortfolioProjectionError('portfolio_report_invalid', 'registered portfolio report requires a projects array');
  }
  const baselineLocal = baselineLocalMap(baseline);
  const notionById = new Map();
  for (const row of notionRecords) {
    const id = currentProjectId(row);
    if (!id) throw new RegisteredPortfolioProjectionError('notion_project_id_missing', 'current Notion row is missing a project ID');
    notionById.set(id, row);
  }

  const catalogById = new Map(catalogProjects.map(project => [project.id, project]));
  const catalogByRoot = new Map();
  for (const project of catalogProjects) {
    const root = normalizedPath(project.canonicalRoot);
    if (!root) continue;
    if (catalogByRoot.has(root)) {
      throw new RegisteredPortfolioProjectionError('duplicate_catalog_root', `multiple catalog projects share ${project.canonicalRoot}`);
    }
    catalogByRoot.set(root, project);
  }

  const localById = new Map();
  const mappingById = new Map();
  for (const [projectId, notionRow] of notionById) {
    const exact = catalogById.get(projectId) ?? null;
    const rootMatch = catalogByRoot.get(normalizedPath(currentRoot(notionRow))) ?? null;
    const project = exact ?? rootMatch;
    if (!project) continue;
    localById.set(projectId, catalogRecord(project, projectId, notionRow, baselineLocal.get(projectId)));
    mappingById.set(projectId, exact ? 'catalog-id' : 'catalog-root');
  }
  const sources = report.projects.filter(item => (item.role ?? 'source') === 'source');
  const worktrees = report.projects.filter(item => item.role === 'worktree');
  const sourceRepos = new Set();
  for (const source of sources) {
    const repo = text(source.canonical_repo);
    if (repo && sourceRepos.has(repo)) {
      throw new RegisteredPortfolioProjectionError('duplicate_source_repo', `multiple source entries registered for ${repo}`);
    }
    if (repo) sourceRepos.add(repo);
    const notionRow = notionById.get(source.id);
    localById.set(source.id, registeredRecord(source, notionRow, baselineLocal.get(source.id)));
    mappingById.set(source.id, 'registered-portfolio');
  }

  const projects = sources.map(source => {
    const related = worktrees.filter(item => text(item.canonical_repo) === text(source.canonical_repo));
    const registered = [source, ...related];
    return {
      projectId: source.id,
      canonicalRepo: text(source.canonical_repo),
      registeredWorktreeCount: registered.length,
      dirtyWorktreeCount: registered.filter(item => Number(item.dirty_files ?? 0) > 0).length,
      dirtyFiles: registered.reduce((sum, item) => sum + Number(item.dirty_files ?? 0), 0),
      sourceAhead: Number.isInteger(source.ahead) ? source.ahead : null,
      sourceBehind: Number.isInteger(source.behind) ? source.behind : null
    };
  }).sort((left, right) => left.projectId.localeCompare(right.projectId));
  const mappings = [...notionById.keys()].sort().map(projectId => ({
    projectId,
    source: mappingById.get(projectId) ?? 'notion-only'
  }));

  return {
    localProjects: [...localById.values()].sort((left, right) => left.projectId.localeCompare(right.projectId)),
    mappingSummary: {
      notionCount: notionById.size,
      localMatchedCount: localById.size,
      notionOnlyCount: mappings.filter(item => item.source === 'notion-only').length,
      mappings
    },
    portfolioSummary: {
      registeredCount: report.projects.length,
      sourceCount: sources.length,
      worktreeCount: worktrees.length,
      dirtyRegisteredCount: report.projects.filter(item => Number(item.dirty_files ?? 0) > 0).length,
      errorCount: Number(report.error_count ?? 0),
      warningCount: Number(report.warning_count ?? 0),
      projects
    }
  };
}
