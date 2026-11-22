import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePrivateHome } from '../private-home.mjs';

const LOCAL_FIELDS = ['title', 'canonicalRoot', 'repository', 'serviceUrl'];
const NOTION_FIELDS = ['status', 'lifecycle', 'note', 'archived'];
const SAFE_PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BASELINE_SCHEMA_VERSION = 1;
const RESTORE_CONFIRMATION = 'restore-development-sync-baseline';
const MIGRATION_CONFIRMATION = 'migrate-development-sync-baseline';

export class DevelopmentNotionSyncError extends Error {
  constructor(code, message) { super(message); this.name = 'DevelopmentNotionSyncError'; this.code = code; }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function text(value) { return value === undefined || value === null || value === '' ? null : String(value).trim(); }
function equal(left, right) { return JSON.stringify(left ?? null) === JSON.stringify(right ?? null); }

function normalizeBinding(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DevelopmentNotionSyncError('binding_required', 'an owner-local Notion binding is required');
  }
  const notionPageUrl = text(input?.notionPageUrl);
  const notionDataSourceId = text(input?.notionDataSourceId);
  let page;
  try { page = new URL(notionPageUrl); }
  catch { throw new DevelopmentNotionSyncError('binding_invalid', 'Notion page URL must be an exact app.notion.com page URL'); }
  if (page.protocol !== 'https:' || page.hostname !== 'app.notion.com' || !/^\/p\/[a-f0-9]{32}$/.test(page.pathname)
    || page.search || page.hash || page.username || page.password || page.port) {
    throw new DevelopmentNotionSyncError('binding_invalid', 'Notion page URL must be an app.notion.com page URL');
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(notionDataSourceId ?? '')) {
    throw new DevelopmentNotionSyncError('binding_invalid', 'Notion data source ID must be an exact UUID');
  }
  return { notionPageUrl: page.href, notionDataSourceId };
}

function normalizeRecord(input, source) {
  const projectId = text(input?.projectId ?? input?.id ?? input?.['프로젝트 ID'] ?? input?.['고유 ID']);
  if (!projectId || !SAFE_PROJECT_ID.test(projectId)) throw new DevelopmentNotionSyncError('project_id_invalid', `${source} project ID is invalid`);
  const links = input?.links && typeof input.links === 'object' ? input.links : {};
  return {
    projectId,
    title: text(input.title ?? input.name ?? input['프로젝트'] ?? input['이름']),
    canonicalRoot: text(input.canonicalRoot ?? input['로컬 기준 경로'] ?? input['로컬 정본']),
    repository: text(input.repository ?? links.repository ?? input['GitHub']),
    serviceUrl: text(input.serviceUrl ?? links.production ?? input['서비스 주소'] ?? input['서비스 URL']),
    status: text(input.status ?? input['상태']),
    lifecycle: text(input.lifecycle ?? input['운영 단계'] ?? input['수명주기']),
    note: text(input.note ?? input['메모']),
    archived: input.archived ?? (input['보관'] === '__YES__' ? true : input['보관'] === '__NO__' ? false : null),
    pageUrl: text(input.pageUrl ?? input.url),
    lastEditedTime: text(input.lastEditedTime)
  };
}

function normalizedPairs(localProjects, notionRecords) {
  const local = new Map(localProjects.map(item => { const record = normalizeRecord(item, 'local'); return [record.projectId, record]; }));
  const notion = new Map(notionRecords.map(item => { const record = normalizeRecord(item, 'notion'); return [record.projectId, record]; }));
  if (local.size !== localProjects.length) throw new DevelopmentNotionSyncError('duplicate_project_id', 'local projects contain a duplicate project ID');
  if (notion.size !== notionRecords.length) throw new DevelopmentNotionSyncError('duplicate_project_id', 'Notion records contain a duplicate project ID');
  const projectIds = [...new Set([...local.keys(), ...notion.keys()])].sort();
  return Object.fromEntries(projectIds.map(projectId => [projectId, {
    local: local.get(projectId) ?? null,
    notion: notion.get(projectId) ?? null
  }]));
}

export function createDevelopmentSyncBaseline({
  localProjects = [],
  notionRecords = [],
  capturedAt = new Date().toISOString(),
  binding
} = {}) {
  if (Number.isNaN(Date.parse(capturedAt))) throw new DevelopmentNotionSyncError('captured_at_invalid', 'capturedAt must be an ISO timestamp');
  const normalizedBinding = normalizeBinding(binding);
  const projects = normalizedPairs(localProjects, notionRecords);
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    binding: normalizedBinding,
    capturedAt: new Date(capturedAt).toISOString(),
    digest: hash({ binding: normalizedBinding, projects }),
    projects
  };
}

function validateBaseline(value, binding) {
  if (!value || value.schemaVersion !== BASELINE_SCHEMA_VERSION || !value.projects || typeof value.projects !== 'object' || Array.isArray(value.projects)) {
    throw new DevelopmentNotionSyncError('baseline_invalid', 'development sync baseline is invalid');
  }
  const actualBinding = normalizeBinding(value.binding);
  if (binding !== undefined && !equal(actualBinding, normalizeBinding(binding))) {
    throw new DevelopmentNotionSyncError('baseline_binding_mismatch', 'baseline belongs to a different Notion target');
  }
  if (Number.isNaN(Date.parse(value.capturedAt))) throw new DevelopmentNotionSyncError('baseline_invalid', 'baseline capturedAt is invalid');
  const expectedDigest = hash({ binding: actualBinding, projects: value.projects });
  if (value.digest !== expectedDigest) throw new DevelopmentNotionSyncError('baseline_digest_mismatch', 'baseline digest does not match its content');
  return structuredClone(value);
}

function changed(current, before, field) {
  return !equal(current?.[field], before?.[field]);
}

function recordPlan(projectId, pair, before) {
  const localPresenceChanged = Boolean(pair.local) !== Boolean(before.local);
  const notionPresenceChanged = Boolean(pair.notion) !== Boolean(before.notion);
  const pageUrl = pair.notion?.pageUrl ?? before.notion?.pageUrl ?? null;
  const expectedLastEditedTime = pair.notion?.lastEditedTime ?? before.notion?.lastEditedTime ?? null;
  if (localPresenceChanged || notionPresenceChanged) {
    const conflicts = [
      ...(localPresenceChanged ? ['local-record-presence'] : []),
      ...(notionPresenceChanged ? ['notion-record-presence'] : [])
    ];
    return { projectId, pageUrl, expectedLastEditedTime, state: 'CONFLICT', localToNotion: {}, notionToLocal: {}, conflicts };
  }
  if (!pair.local || !pair.notion) {
    return { projectId, pageUrl, expectedLastEditedTime, state: 'IN_SYNC', localToNotion: {}, notionToLocal: {}, conflicts: [] };
  }
  const localToNotion = {};
  const notionToLocal = {};
  const conflicts = [];
  for (const field of LOCAL_FIELDS) {
    const localChanged = changed(pair.local, before.local, field);
    const notionChanged = changed(pair.notion, before.notion, field);
    if (localChanged && notionChanged) {
      if (!equal(pair.local[field], pair.notion[field])) conflicts.push(field);
    } else if (localChanged) {
      if (!equal(pair.local[field], pair.notion[field])) localToNotion[field] = pair.local[field];
    } else if (notionChanged && !equal(pair.local[field], pair.notion[field])) {
      conflicts.push(field);
    }
  }
  for (const field of NOTION_FIELDS) {
    const localChanged = changed(pair.local, before.local, field);
    const notionChanged = changed(pair.notion, before.notion, field);
    if (localChanged && notionChanged) {
      if (!equal(pair.local[field], pair.notion[field])) conflicts.push(field);
    } else if (notionChanged) {
      if (!equal(pair.local[field], pair.notion[field])) notionToLocal[field] = pair.notion[field];
    } else if (localChanged && !equal(pair.local[field], pair.notion[field])) {
      conflicts.push(field);
    }
  }
  const state = conflicts.length ? 'CONFLICT'
    : Object.keys(localToNotion).length && Object.keys(notionToLocal).length ? 'BOTH_DIRECTIONS'
      : Object.keys(localToNotion).length ? 'LOCAL_TO_NOTION'
        : Object.keys(notionToLocal).length ? 'NOTION_TO_LOCAL' : 'IN_SYNC';
  return { projectId, pageUrl, expectedLastEditedTime, state, localToNotion, notionToLocal, conflicts };
}

export function planDevelopmentSync({ localProjects = [], notionRecords = [], baseline = null, binding } = {}) {
  const priorBaseline = baseline === null ? null : validateBaseline(baseline, binding);
  const effectiveBinding = binding ?? priorBaseline?.binding;
  const current = createDevelopmentSyncBaseline({ localProjects, notionRecords, binding: effectiveBinding });
  if (baseline === null) {
    return {
      schemaVersion: 1,
      status: 'BASELINE_REQUIRED',
      baselineRequired: true,
      transportBlocked: true,
      current,
      entries: [],
      operations: { localToNotion: [], notionToLocal: [] },
      summary: { IN_SYNC: 0, LOCAL_TO_NOTION: 0, NOTION_TO_LOCAL: 0, BOTH_DIRECTIONS: 0, CONFLICT: 0 },
      externalWritePerformed: false,
      nextGate: '최초 기준 스냅샷을 owner-local에 만든 뒤 다시 계획한다.',
      transport: { preferred: 'notion-mcp-changed-rows-only', fallback: 'explicitly-authorized-browser' }
    };
  }
  const projectIds = [...new Set([...Object.keys(priorBaseline.projects), ...Object.keys(current.projects)])].sort();
  const entries = projectIds.map(projectId => recordPlan(
    projectId,
    current.projects[projectId] ?? { local: null, notion: null },
    priorBaseline.projects[projectId] ?? { local: null, notion: null }
  ));
  const localToNotion = entries.filter(entry => Object.keys(entry.localToNotion).length).map(entry => ({
    projectId: entry.projectId,
    pageUrl: entry.pageUrl,
    expectedLastEditedTime: entry.expectedLastEditedTime,
    patch: entry.localToNotion
  }));
  const notionToLocal = entries.filter(entry => Object.keys(entry.notionToLocal).length).map(entry => ({
    projectId: entry.projectId,
    patch: entry.notionToLocal
  }));
  const hasConflict = entries.some(entry => entry.state === 'CONFLICT');
  const hasBothDirections = entries.some(entry => entry.state === 'BOTH_DIRECTIONS') || (localToNotion.length > 0 && notionToLocal.length > 0);
  const transportBlocked = hasConflict || hasBothDirections;
  const hasChanges = localToNotion.length > 0 || notionToLocal.length > 0;
  const status = transportBlocked ? 'REVIEW_REQUIRED' : hasChanges ? 'READY' : 'IN_SYNC';
  return {
    schemaVersion: 1,
    status,
    baselineRequired: false,
    baselineDigest: priorBaseline.digest,
    transportBlocked,
    current,
    entries,
    operations: { localToNotion, notionToLocal },
    summary: Object.fromEntries(['IN_SYNC', 'LOCAL_TO_NOTION', 'NOTION_TO_LOCAL', 'BOTH_DIRECTIONS', 'CONFLICT'].map(state => [state, entries.filter(entry => entry.state === state).length])),
    externalWritePerformed: false,
    nextGate: status === 'REVIEW_REQUIRED'
      ? '양쪽 변경 또는 정본 경계 충돌을 사람이 확인해야 한다.'
      : status === 'READY' ? '표시된 변경 행만 한 방향으로 적용하고 사후 조회한다.' : '변경 없음.',
    transport: { preferred: 'notion-mcp-changed-rows-only', fallback: 'explicitly-authorized-browser' }
  };
}

export function developmentSyncOwnerPaths({ stateRoot, root } = {}) {
  const privateRoot = stateRoot ? path.resolve(stateRoot) : resolvePrivateHome().root;
  const syncRoot = path.resolve(root ?? path.join(privateRoot, 'project-catalog', 'development-notion-sync'));
  if (syncRoot === path.parse(syncRoot).root) throw new DevelopmentNotionSyncError('state_root_invalid', 'sync state root cannot be a filesystem root');
  return {
    root: syncRoot,
    baselineFile: path.join(syncRoot, 'baseline.json'),
    lockFile: path.join(syncRoot, 'writer.lock'),
    backupsRoot: path.join(syncRoot, 'backups')
  };
}

function ensureOwnerDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DevelopmentNotionSyncError('state_symlink_denied', 'sync state directory must be a real owner directory');
  try { fs.chmodSync(directory, 0o700); } catch { /* ACL-only platform */ }
}

function readRegularJson(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new DevelopmentNotionSyncError('state_symlink_denied', 'sync baseline must be a regular owner file');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new DevelopmentNotionSyncError('baseline_invalid', 'sync baseline is not valid JSON'); }
}

function privateWriteAtomic(file, value) {
  ensureOwnerDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* ACL-only platform */ }
}

function withStoreLock(paths, action) {
  ensureOwnerDirectory(paths.root);
  let descriptor;
  try {
    descriptor = fs.openSync(paths.lockFile, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error.code === 'EEXIST') throw new DevelopmentNotionSyncError('writer_busy', 'development sync already has a writer');
    throw error;
  }
  try { return action(); }
  finally {
    try { fs.closeSync(descriptor); } catch { /* already closed */ }
    try { fs.unlinkSync(paths.lockFile); } catch { /* exact lock already released */ }
  }
}

export function readDevelopmentSyncBaseline(options = {}) {
  const paths = developmentSyncOwnerPaths(options);
  const value = readRegularJson(paths.baselineFile);
  return value ? validateBaseline(value, options.binding) : null;
}

export function initializeDevelopmentSyncBaseline({ localProjects = [], notionRecords = [], capturedAt, binding, ...pathOptions } = {}) {
  const paths = developmentSyncOwnerPaths(pathOptions);
  const candidate = createDevelopmentSyncBaseline({ localProjects, notionRecords, capturedAt, binding });
  return withStoreLock(paths, () => {
    const existingValue = readRegularJson(paths.baselineFile);
    if (existingValue) {
      const existing = validateBaseline(existingValue, binding);
      if (existing.digest === candidate.digest) return { created: false, duplicate: true, baseline: existing, paths, externalWritePerformed: false };
      throw new DevelopmentNotionSyncError('baseline_exists', 'a different baseline already exists; complete or restore it explicitly');
    }
    privateWriteAtomic(paths.baselineFile, candidate);
    return { created: true, duplicate: false, baseline: candidate, paths, externalWritePerformed: false };
  });
}

export function prepareDevelopmentSync({ localProjects = [], notionRecords = [], binding, ...pathOptions } = {}) {
  const baseline = readDevelopmentSyncBaseline({ ...pathOptions, binding });
  if (!baseline) {
    const initialized = initializeDevelopmentSyncBaseline({ localProjects, notionRecords, binding, ...pathOptions });
    return {
      schemaVersion: 1,
      status: 'BASELINE_CREATED',
      baseline: initialized.baseline,
      operations: { localToNotion: [], notionToLocal: [] },
      transportBlocked: true,
      externalWritePerformed: false,
      nextGate: '다음 실행부터 기준 이후 변경 행만 계획한다.'
    };
  }
  return planDevelopmentSync({ localProjects, notionRecords, baseline, binding: binding ?? baseline.binding });
}

export async function applyDevelopmentSyncChanges({ plan, writeNotionRow, writeLocalRow } = {}) {
  if (!plan || plan.schemaVersion !== 1) throw new DevelopmentNotionSyncError('plan_invalid', 'a development sync plan is required');
  if (plan.transportBlocked || plan.status !== 'READY') throw new DevelopmentNotionSyncError('review_required', plan.nextGate ?? 'sync plan is not ready');
  const notionOperations = plan.operations?.localToNotion ?? [];
  const localOperations = plan.operations?.notionToLocal ?? [];
  if (notionOperations.length && typeof writeNotionRow !== 'function') throw new DevelopmentNotionSyncError('notion_writer_required', 'changed Notion rows require an explicit writer');
  if (localOperations.length && typeof writeLocalRow !== 'function') throw new DevelopmentNotionSyncError('local_writer_required', 'changed local rows require an explicit writer');
  if (notionOperations.length && localOperations.length) throw new DevelopmentNotionSyncError('review_required', 'two-way changes cannot be applied in one run');
  const applied = [];
  for (const operation of notionOperations) {
    await writeNotionRow(structuredClone(operation));
    applied.push({ direction: 'LOCAL_TO_NOTION', projectId: operation.projectId, fields: Object.keys(operation.patch) });
  }
  for (const operation of localOperations) {
    await writeLocalRow(structuredClone(operation));
    applied.push({ direction: 'NOTION_TO_LOCAL', projectId: operation.projectId, fields: Object.keys(operation.patch) });
  }
  return {
    status: applied.length ? 'APPLIED_AWAITING_VERIFICATION' : 'IN_SYNC',
    applied,
    changedRowsOnly: true,
    verificationRequired: applied.length > 0,
    externalWritePerformed: applied.length > 0
  };
}

function backupBaseline(paths, baseline) {
  ensureOwnerDirectory(paths.backupsRoot);
  const file = path.join(paths.backupsRoot, `${baseline.digest}.json`);
  if (!fs.existsSync(file)) privateWriteAtomic(file, baseline);
  return file;
}

export function completeDevelopmentSync({
  localProjects = [],
  notionRecords = [],
  expectedBaselineDigest,
  capturedAt,
  binding,
  ...pathOptions
} = {}) {
  if (!SHA256.test(expectedBaselineDigest ?? '')) throw new DevelopmentNotionSyncError('expected_digest_required', 'expected baseline digest is required');
  const paths = developmentSyncOwnerPaths(pathOptions);
  return withStoreLock(paths, () => {
    const baseline = validateBaseline(readRegularJson(paths.baselineFile), binding);
    const effectiveBinding = binding ?? baseline.binding;
    if (baseline.digest !== expectedBaselineDigest) throw new DevelopmentNotionSyncError('baseline_changed', 'baseline changed before completion');
    const plan = planDevelopmentSync({ localProjects, notionRecords, baseline, binding: effectiveBinding });
    if (plan.status !== 'IN_SYNC') throw new DevelopmentNotionSyncError('verification_required', 'post-read must show no pending changes or conflicts before advancing baseline');
    const next = createDevelopmentSyncBaseline({ localProjects, notionRecords, capturedAt, binding: effectiveBinding });
    if (next.digest === baseline.digest) return { completed: false, duplicate: true, baseline, backupFile: null, externalWritePerformed: false };
    const backupFile = backupBaseline(paths, baseline);
    privateWriteAtomic(paths.baselineFile, next);
    return { completed: true, duplicate: false, baseline: next, previousDigest: baseline.digest, backupFile, externalWritePerformed: false };
  });
}

function candidateContained(paths, candidateFile) {
  if (!path.isAbsolute(candidateFile)) throw new DevelopmentNotionSyncError('candidate_invalid', 'candidate path must be absolute');
  const resolved = path.resolve(candidateFile);
  const expected = path.resolve(paths.root, 'baseline-candidate.json');
  if (resolved !== expected) throw new DevelopmentNotionSyncError('candidate_invalid', 'candidate must be the exact owner-local baseline-candidate.json');
  return resolved;
}

export function migrateDevelopmentSyncBaseline({
  candidateFile,
  expectedCurrentDigest,
  expectedCandidateDigest,
  confirm,
  dryRun = false,
  binding,
  ...pathOptions
} = {}) {
  if (!SHA256.test(expectedCurrentDigest ?? '')) throw new DevelopmentNotionSyncError('expected_digest_required', 'expected current baseline digest is required');
  if (!SHA256.test(expectedCandidateDigest ?? '')) throw new DevelopmentNotionSyncError('expected_candidate_digest_required', 'expected candidate baseline digest is required');
  const paths = developmentSyncOwnerPaths(pathOptions);
  const source = candidateContained(paths, candidateFile);
  const current = readDevelopmentSyncBaseline({ ...pathOptions, binding });
  if (!current || current.digest !== expectedCurrentDigest) throw new DevelopmentNotionSyncError('baseline_changed', 'current baseline does not match the expected digest');
  const candidate = validateBaseline(readRegularJson(source), binding ?? current.binding);
  if (candidate.digest !== expectedCandidateDigest) throw new DevelopmentNotionSyncError('candidate_changed', 'candidate baseline does not match the expected digest');
  if (!equal(candidate.binding, current.binding)) throw new DevelopmentNotionSyncError('baseline_binding_mismatch', 'candidate baseline belongs to a different Notion target');
  const preview = {
    source,
    target: paths.baselineFile,
    fromDigest: current.digest,
    toDigest: candidate.digest,
    mutationPerformed: false,
    externalWritePerformed: false
  };
  if (candidate.digest === current.digest) return { ...preview, duplicate: true, dryRun: Boolean(dryRun) };
  if (dryRun) return { ...preview, duplicate: false, dryRun: true };
  if (confirm !== MIGRATION_CONFIRMATION) {
    throw new DevelopmentNotionSyncError('migration_confirmation_required', `migration requires --confirm ${MIGRATION_CONFIRMATION}`);
  }
  return withStoreLock(paths, () => {
    const lockedCurrent = validateBaseline(readRegularJson(paths.baselineFile), binding ?? current.binding);
    if (lockedCurrent.digest !== expectedCurrentDigest) throw new DevelopmentNotionSyncError('baseline_changed', 'current baseline changed before migration');
    const lockedCandidate = validateBaseline(readRegularJson(source), lockedCurrent.binding);
    if (lockedCandidate.digest !== expectedCandidateDigest) throw new DevelopmentNotionSyncError('candidate_changed', 'candidate baseline changed before migration');
    const backupFile = backupBaseline(paths, lockedCurrent);
    privateWriteAtomic(paths.baselineFile, lockedCandidate);
    const postRead = validateBaseline(readRegularJson(paths.baselineFile), lockedCurrent.binding);
    if (postRead.digest !== lockedCandidate.digest) {
      privateWriteAtomic(paths.baselineFile, lockedCurrent);
      throw new DevelopmentNotionSyncError('migration_postcondition_failed', 'baseline migration post-read failed and the previous baseline was restored');
    }
    return {
      ...preview,
      migrated: true,
      duplicate: false,
      mutationPerformed: true,
      backupFile,
      baseline: postRead
    };
  });
}

function backupContained(paths, backupFile) {
  if (!path.isAbsolute(backupFile)) throw new DevelopmentNotionSyncError('backup_invalid', 'backup path must be absolute');
  const resolved = path.resolve(backupFile);
  const relative = path.relative(paths.backupsRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new DevelopmentNotionSyncError('backup_invalid', 'backup must be an exact file in the development sync backup root');
  return resolved;
}

export function restoreDevelopmentSyncBaseline({ backupFile, expectedCurrentDigest, confirm, dryRun = false, binding, ...pathOptions } = {}) {
  if (!SHA256.test(expectedCurrentDigest ?? '')) throw new DevelopmentNotionSyncError('expected_digest_required', 'expected current digest is required');
  const paths = developmentSyncOwnerPaths(pathOptions);
  const source = backupContained(paths, backupFile);
  const backup = validateBaseline(readRegularJson(source), binding);
  const current = readDevelopmentSyncBaseline({ ...pathOptions, binding: binding ?? backup.binding });
  if (!current || current.digest !== expectedCurrentDigest) throw new DevelopmentNotionSyncError('baseline_changed', 'current baseline does not match the expected digest');
  const preview = { source, target: paths.baselineFile, fromDigest: current.digest, toDigest: backup.digest, mutationPerformed: false };
  if (dryRun) return { ...preview, dryRun: true };
  if (confirm !== RESTORE_CONFIRMATION) throw new DevelopmentNotionSyncError('restore_confirmation_required', `restore requires --confirm ${RESTORE_CONFIRMATION}`);
  return withStoreLock(paths, () => {
    const lockedCurrent = validateBaseline(readRegularJson(paths.baselineFile), binding ?? backup.binding);
    if (lockedCurrent.digest !== expectedCurrentDigest) throw new DevelopmentNotionSyncError('baseline_changed', 'current baseline changed before restore');
    backupBaseline(paths, lockedCurrent);
    privateWriteAtomic(paths.baselineFile, backup);
    return { ...preview, restored: true, mutationPerformed: true };
  });
}

export const developmentSyncFields = Object.freeze({ localAuthoritative: LOCAL_FIELDS, notionAuthoritative: NOTION_FIELDS });

function parseCli(argv) {
  const options = { command: argv[0] ?? 'help' };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--dry-run') { options.dryRun = true; continue; }
    if (!key.startsWith('--') || index + 1 >= argv.length) throw new DevelopmentNotionSyncError('usage', `invalid argument: ${key}`);
    options[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

function cliHelp() {
  return `Usage:\n  node ${fileURLToPath(import.meta.url)} initialize --local ABSOLUTE_JSON --notion ABSOLUTE_JSON --binding OWNER_LOCAL_JSON [--state-root ABSOLUTE_DIR]\n  node ${fileURLToPath(import.meta.url)} plan --local ABSOLUTE_JSON --notion ABSOLUTE_JSON [--binding OWNER_LOCAL_JSON] [--state-root ABSOLUTE_DIR]\n  node ${fileURLToPath(import.meta.url)} complete --local ABSOLUTE_JSON --notion ABSOLUTE_JSON --expected-baseline-digest SHA256 [--binding OWNER_LOCAL_JSON] [--state-root ABSOLUTE_DIR]\n  node ${fileURLToPath(import.meta.url)} status [--state-root ABSOLUTE_DIR]\n  node ${fileURLToPath(import.meta.url)} migrate --candidate ABSOLUTE_JSON --expected-current-digest SHA256 --expected-candidate-digest SHA256 --dry-run [--binding OWNER_LOCAL_JSON] [--state-root ABSOLUTE_DIR]\n  node ${fileURLToPath(import.meta.url)} migrate --candidate ABSOLUTE_JSON --expected-current-digest SHA256 --expected-candidate-digest SHA256 --confirm ${MIGRATION_CONFIRMATION} [--binding OWNER_LOCAL_JSON] [--state-root ABSOLUTE_DIR]\n  node ${fileURLToPath(import.meta.url)} restore --backup ABSOLUTE_JSON --expected-current-digest SHA256 --dry-run [--binding OWNER_LOCAL_JSON] [--state-root ABSOLUTE_DIR]\n  node ${fileURLToPath(import.meta.url)} restore --backup ABSOLUTE_JSON --expected-current-digest SHA256 --confirm ${RESTORE_CONFIRMATION} [--binding OWNER_LOCAL_JSON] [--state-root ABSOLUTE_DIR]\n\nThe binding stays owner-local and is captured in the baseline. This command never polls Notion. Plan emits changed rows only. Two-sided changes stop for review.`;
}

function absoluteJson(file, label) {
  if (!file || !path.isAbsolute(file)) throw new DevelopmentNotionSyncError('usage', `${label} must be an absolute JSON path`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function runCli(argv) {
  const options = parseCli(argv);
  if (options.command === 'help' || options.command === '--help' || options.command === '-h') return { help: cliHelp() };
  const pathOptions = { ...(options['state-root'] ? { stateRoot: options['state-root'] } : {}) };
  const binding = options.binding ? absoluteJson(options.binding, '--binding') : undefined;
  if (options.command === 'status') {
    const baseline = readDevelopmentSyncBaseline(pathOptions);
    return { present: Boolean(baseline), baselineDigest: baseline?.digest ?? null, capturedAt: baseline?.capturedAt ?? null, paths: developmentSyncOwnerPaths(pathOptions) };
  }
  if (options.command === 'migrate') {
    return migrateDevelopmentSyncBaseline({
      ...pathOptions,
      candidateFile: options.candidate,
      expectedCurrentDigest: options['expected-current-digest'],
      expectedCandidateDigest: options['expected-candidate-digest'],
      confirm: options.confirm,
      dryRun: options.dryRun === true,
      binding
    });
  }
  if (options.command === 'restore') {
    return restoreDevelopmentSyncBaseline({
      ...pathOptions,
      backupFile: options.backup,
      expectedCurrentDigest: options['expected-current-digest'],
      confirm: options.confirm,
      dryRun: options.dryRun === true,
      binding
    });
  }
  const localProjects = absoluteJson(options.local, '--local');
  const notionRecords = absoluteJson(options.notion, '--notion');
  if (!Array.isArray(localProjects) || !Array.isArray(notionRecords)) throw new DevelopmentNotionSyncError('usage', 'local and notion JSON files must contain arrays');
  if (options.command === 'initialize') return initializeDevelopmentSyncBaseline({ ...pathOptions, localProjects, notionRecords, binding });
  if (options.command === 'plan') return prepareDevelopmentSync({ ...pathOptions, localProjects, notionRecords, binding });
  if (options.command === 'complete') return completeDevelopmentSync({ ...pathOptions, localProjects, notionRecords, expectedBaselineDigest: options['expected-baseline-digest'], binding });
  throw new DevelopmentNotionSyncError('usage', `unknown command: ${options.command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then(result => {
    if (result.help) process.stdout.write(`${result.help}\n`);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.code ?? 'unexpected_error', message: error.message })}\n`);
    process.exitCode = 1;
  });
}
