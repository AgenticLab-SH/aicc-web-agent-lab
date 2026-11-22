import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectProjectCatalog } from './project-collector.mjs';
import { ProjectPriorityOutbox } from './project-priority-outbox.mjs';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIRMATION = /^project_confirm_[a-f0-9]{64}$/;
const SKIP_DIRECTORIES = new Set(['.git', '_recovery', 'archive', 'legacy', 'node_modules', 'dist', 'build', '.next', '.venv', 'user-knowledge']);

export class ProjectCatalogServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProjectCatalogServiceError';
    this.code = code;
  }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function ensurePrivateProjectRoot(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ProjectCatalogServiceError('state_symlink_denied', 'project catalog state root must be a real owner directory');
  }
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function readJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ProjectCatalogServiceError('snapshot_invalid', 'project snapshot must be a regular owner file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function defaultProjectsRoot() {
  const configured = process.env.AICC_PROJECTS_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const inferred = path.resolve(moduleRoot, '..', '..', '..');
  return fs.existsSync(path.join(inferred, 'README.md')) ? inferred : null;
}

function projectStateRoot(options = {}) {
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center');
  return options.root ?? path.join(stateRoot, 'project-catalog');
}

export function discoverProjectRoots(projectsRoot, { maximumDepth = 5 } = {}) {
  if (!projectsRoot || !path.isAbsolute(projectsRoot)) throw new ProjectCatalogServiceError('projects_root_required', 'an absolute projects root is required');
  const canonicalRoot = fs.realpathSync(projectsRoot);
  const roots = [];
  const queue = [{ directory: canonicalRoot, depth: 0 }];
  while (queue.length) {
    const { directory, depth } = queue.shift();
    const gitMarker = path.join(directory, '.git');
    if (fs.existsSync(gitMarker)) {
      const marker = fs.lstatSync(gitMarker);
      if (!marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) roots.push(directory);
    }
    if (depth >= maximumDepth) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_DIRECTORIES.has(entry.name)) continue;
      queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
    }
  }
  return [...new Set(roots)].sort();
}

function opaqueLocalId(projectsRoot, projectRoot) {
  const relative = path.relative(projectsRoot, projectRoot).split(path.sep).join('/');
  return `local-${crypto.createHash('sha256').update(relative).digest('hex').slice(0, 16)}`;
}

function websiteSources(projectsRoot) {
  const workspaceFile = path.join(projectsRoot, 'web', 'website-workspace.json');
  if (!fs.existsSync(workspaceFile)) return { websiteWorkspacePaths: [], websiteProfilePaths: [], serviceOverlays: [] };
  const workspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
  const profiles = (workspace.services ?? []).flatMap(service => {
    if (typeof service?.profile_path !== 'string' || !service.profile_path.trim()) return [];
    const candidate = path.resolve(path.dirname(workspaceFile), service.profile_path);
    return fs.existsSync(candidate) ? [candidate] : [];
  });
  const serviceOverlays = (workspace.services ?? []).flatMap(service => {
    const relativeRoot = service?.repository_root ?? service?.canonical_path;
    if (typeof service?.key !== 'string' || typeof relativeRoot !== 'string') return [];
    const root = path.resolve(path.dirname(workspaceFile), relativeRoot);
    return fs.existsSync(root) ? [{ root: fs.realpathSync(root), id: service.key, title: service.title }] : [];
  });
  return { websiteWorkspacePaths: [workspaceFile], websiteProfilePaths: [...new Set(profiles)], serviceOverlays };
}

function emptyNotionSnapshot() {
  return { version: 'notion-snapshot-unavailable', capturedAt: new Date(0).toISOString(), projects: [], ideas: [] };
}

function prioritySnapshot(notionSnapshot) {
  const priorities = [...(notionSnapshot.projects ?? []), ...(notionSnapshot.ideas ?? [])]
    .flatMap(item => {
      const projectId = item.projectId ?? item.slug ?? item.uniqueId ?? item.pageId ?? item.notionId ?? item.id;
      const rank = item.priority && typeof item.priority === 'object' ? item.priority.rank : item.priority;
      return typeof projectId === 'string' && Number.isInteger(rank) && rank >= 0 ? [{ projectId, rank }] : [];
    });
  return {
    remoteVersion: String(notionSnapshot.version ?? 'notion-snapshot-unavailable'),
    capturedAt: notionSnapshot.capturedAt ?? new Date(0).toISOString(),
    priorities
  };
}

function validatedNotionSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.ideas) || typeof snapshot.version !== 'string' || !Number.isFinite(Date.parse(snapshot.capturedAt))) {
    throw new ProjectCatalogServiceError('snapshot_invalid', 'Notion snapshot requires version, capturedAt, projects, and ideas');
  }
  return structuredClone(snapshot);
}

export class ProjectCatalogService {
  constructor({ projectsRoot = defaultProjectsRoot(), stateRoot, root, outbox, now = () => Date.now(), confirmationTtlMs = 5 * 60_000 } = {}) {
    if (!projectsRoot || !path.isAbsolute(projectsRoot)) throw new ProjectCatalogServiceError('projects_root_required', 'AICC_PROJECTS_ROOT or an explicit projectsRoot is required');
    this.projectsRoot = fs.realpathSync(projectsRoot);
    this.root = path.resolve(projectStateRoot({ stateRoot, root }));
    this.snapshotFile = path.join(this.root, 'notion-snapshot.json');
    this.now = now;
    this.confirmationTtlMs = confirmationTtlMs;
    this.confirmations = new Map();
    ensurePrivateProjectRoot(this.root);
    this.outbox = outbox ?? new ProjectPriorityOutbox({ root: path.join(this.root, 'priority-outbox'), now });
  }

  notionSnapshot() {
    try { return readJson(this.snapshotFile); }
    catch (error) {
      if (error?.code === 'ENOENT') return emptyNotionSnapshot();
      throw error;
    }
  }

  saveNotionSnapshot(snapshot) {
    const validated = validatedNotionSnapshot(snapshot);
    atomicJson(this.snapshotFile, validated);
    const remote = prioritySnapshot(validated);
    try { this.outbox.initialize(remote); }
    catch (error) {
      if (error?.code !== 'pending_sync_exists') throw error;
    }
    return { saved: true, version: validated.version, capturedAt: validated.capturedAt, projects: validated.projects.length, ideas: validated.ideas.length };
  }

  catalog() {
    const projectRoots = discoverProjectRoots(this.projectsRoot);
    const website = websiteSources(this.projectsRoot);
    const serviceOverlayByRoot = new Map(website.serviceOverlays.map(overlay => [overlay.root, overlay]));
    const basenameCounts = new Map();
    for (const root of projectRoots) basenameCounts.set(path.basename(root), (basenameCounts.get(path.basename(root)) ?? 0) + 1);
    const projectOverlays = projectRoots.flatMap(root => {
      if (serviceOverlayByRoot.has(root)) return [serviceOverlayByRoot.get(root)];
      const basename = path.basename(root);
      if (/^[a-z0-9][a-z0-9-]*$/.test(basename) && basenameCounts.get(basename) === 1) return [];
      return [{ root, id: opaqueLocalId(this.projectsRoot, root), title: basename }];
    });
    const notionSnapshot = this.notionSnapshot();
    return collectProjectCatalog({
      projectsRoot: this.projectsRoot,
      structureReadmePath: path.join(this.projectsRoot, 'README.md'),
      projectRoots,
      projectOverlays,
      websiteWorkspacePaths: website.websiteWorkspacePaths,
      websiteProfilePaths: website.websiteProfilePaths,
      notionSnapshot,
      now: this.now
    });
  }

  status() {
    const notion = this.notionSnapshot();
    const catalog = this.catalog();
    return {
      ...catalog,
      notionSource: {
        available: notion.version !== 'notion-snapshot-unavailable',
        version: notion.version,
        capturedAt: notion.version === 'notion-snapshot-unavailable' ? null : notion.capturedAt,
        projectCount: notion.projects.length,
        ideaCount: notion.ideas.length
      },
      priorityOutbox: this.outbox.status()
    };
  }

  previewPriority({ projectId, desiredRank, expectedRemoteVersion, actor = 'owner' } = {}) {
    const operationId = `priority-${crypto.randomUUID()}`;
    const idempotencyKey = `priority:${projectId}:${desiredRank}:${expectedRemoteVersion}`;
    const request = { operationId, idempotencyKey, projectId, desiredRank, expectedRemoteVersion, actor };
    const token = `project_confirm_${crypto.randomBytes(32).toString('hex')}`;
    this.confirmations.set(token, { request, expiresAt: this.now() + this.confirmationTtlMs });
    return {
      schemaVersion: 1,
      requiresConfirmation: true,
      confirmationToken: token,
      confirmationExpiresAt: new Date(this.now() + this.confirmationTtlMs).toISOString(),
      operation: request,
      externalWritePerformed: false
    };
  }

  confirmPriority(token) {
    if (typeof token !== 'string' || !CONFIRMATION.test(token)) throw new ProjectCatalogServiceError('confirmation_invalid', 'a valid one-use priority confirmation is required');
    const pending = this.confirmations.get(token);
    this.confirmations.delete(token);
    if (!pending) throw new ProjectCatalogServiceError('confirmation_invalid', 'priority confirmation is unknown or consumed');
    if (pending.expiresAt <= this.now()) throw new ProjectCatalogServiceError('confirmation_expired', 'priority confirmation expired');
    return { ...this.outbox.enqueue(pending.request), externalWritePerformed: false };
  }

  listPriorityOperations() {
    return { ...this.outbox.status(), operations: this.outbox.list(), externalWritePerformed: false };
  }

  refreshNotionSnapshot(snapshot) {
    return { ...this.saveNotionSnapshot(snapshot), externalWritePerformed: false };
  }

  preparePrioritySync({ operationId, remoteVersion, workerId } = {}) {
    return { ...this.outbox.prepareSync(operationId, { remoteVersion, workerId }), externalWritePerformed: false };
  }

  completePrioritySync({ operationId, snapshot } = {}) {
    const validated = validatedNotionSnapshot(snapshot);
    const completed = this.outbox.completeSync(operationId, prioritySnapshot(validated));
    const saved = this.saveNotionSnapshot(validated);
    return { ...completed, snapshot: saved, externalWritePerformed: false };
  }

  recordPrioritySyncFailure({ operationId, errorCode } = {}) {
    return { operation: this.outbox.recordFailure(operationId, errorCode), externalWritePerformed: false };
  }
}

export function createProjectCatalogService(options = {}) {
  return new ProjectCatalogService(options);
}
