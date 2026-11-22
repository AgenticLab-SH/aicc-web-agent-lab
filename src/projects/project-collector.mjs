import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { computeProjectProgress } from './project-progress.mjs';

const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
const KINDS = new Set(['product', 'tool', 'platform', 'knowledge', 'idea', 'prototype']);
const DOMAINS = new Set(['aicc', 'web', 'app', 'career', 'notion', 'knowledge', 'other']);
const LIFECYCLES = new Set(['idea', 'discovery', 'design', 'building', 'verification', 'operating', 'paused', 'archived']);
const SENSITIVITIES = new Set(['public-safe', 'private', 'restricted']);
const PROHIBITED_MANIFEST_KEYS = new Set(['command', 'startCommand', 'stopCommand', 'shell', 'exec', 'environment', 'secrets']);

export class ProjectCatalogError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectCatalogError';
    this.code = code;
    this.details = details;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hasParentSegment(value) {
  return String(value).split(/[\\/]+/).includes('..');
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function hasSensitiveNativeSegment(candidate) {
  const parts = path.resolve(candidate).split(path.sep).filter(Boolean).map(part => part.toLowerCase());
  const exact = new Set(['.ssh', '.codex', '.codex-multi', '.ai-control-center', '.codex-chatgpt-web', '.opencodex', 'keychains']);
  if (parts.some(part => exact.has(part))) return true;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] === 'library' && ['application support', 'cookies'].includes(parts[index + 1])) return true;
  }
  return false;
}

function ensureDirectoryRoot(projectsRoot) {
  if (!projectsRoot || !path.isAbsolute(projectsRoot) || hasParentSegment(projectsRoot)) {
    throw new ProjectCatalogError('invalid_projects_root', 'configured projects root must be an absolute path without parent traversal');
  }
  if (hasSensitiveNativeSegment(projectsRoot)) {
    throw new ProjectCatalogError('sensitive_projects_root', 'configured projects root overlaps native sensitive state');
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync(projectsRoot);
    if (!fs.statSync(realRoot).isDirectory()) throw new Error('not-directory');
  } catch {
    throw new ProjectCatalogError('projects_root_unavailable', 'configured projects root is not an available directory');
  }
  return { lexicalRoot: path.resolve(projectsRoot), realRoot };
}

function approvedPath(input, boundary, { type, label }) {
  if (typeof input !== 'string' || !input.trim() || hasParentSegment(input)) {
    throw new ProjectCatalogError('path_traversal_rejected', `${label} contains an invalid or parent-traversing path`);
  }
  const lexical = path.isAbsolute(input) ? path.resolve(input) : path.resolve(boundary.lexicalRoot, input);
  if (!pathIsWithin(boundary.lexicalRoot, lexical) && !pathIsWithin(boundary.realRoot, lexical)) {
    throw new ProjectCatalogError('path_outside_projects_root', `${label} is outside the configured projects root`);
  }
  if (hasSensitiveNativeSegment(lexical)) {
    throw new ProjectCatalogError('sensitive_path_rejected', `${label} overlaps native sensitive state`);
  }
  let real;
  try { real = fs.realpathSync(lexical); }
  catch { throw new ProjectCatalogError('source_path_unavailable', `${label} does not exist`); }
  if (!pathIsWithin(boundary.realRoot, real)) {
    throw new ProjectCatalogError('symlink_escape_rejected', `${label} resolves outside the configured projects root`);
  }
  const stat = fs.statSync(real);
  if (type === 'file' && !stat.isFile()) throw new ProjectCatalogError('source_type_rejected', `${label} must be a file`);
  if (type === 'directory' && !stat.isDirectory()) throw new ProjectCatalogError('source_type_rejected', `${label} must be a directory`);
  return real;
}

function readJson(file, label) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('root must be an object');
    return value;
  } catch (error) {
    throw new ProjectCatalogError('source_json_invalid', `${label} is not valid JSON`, { detail: error.message });
  }
}

function optionalEnum(value, allowed, field) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!allowed.has(normalized)) throw new ProjectCatalogError('invalid_project_field', `${field} has an unsupported value`);
  return normalized;
}

function exactProjectId(value, label = 'project id') {
  const id = String(value ?? '').trim();
  if (!PROJECT_ID.test(id)) throw new ProjectCatalogError('invalid_project_id', `${label} must be a stable lowercase slug`);
  return id;
}

function normalizedLinks(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const docs = Array.isArray(source.docs) ? source.docs.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : [];
  return {
    notion: typeof source.notion === 'string' && source.notion.trim() ? source.notion.trim() : null,
    repository: typeof source.repository === 'string' && source.repository.trim() ? source.repository.trim() : null,
    production: typeof source.production === 'string' && source.production.trim() ? source.production.trim() : null,
    docs: [...new Set(docs)]
  };
}

function inferredClassification(root, projectsRoot) {
  const [area] = path.relative(projectsRoot, root).split(path.sep);
  if (area === 'web') return { kind: null, domain: 'web' };
  if (area === 'apps') return { kind: 'product', domain: 'app' };
  if (area === 'tools') return { kind: 'tool', domain: 'other' };
  if (area === 'labs') return { kind: 'prototype', domain: 'other' };
  if (area === 'ai-platform') return { kind: 'platform', domain: 'aicc' };
  if (area === 'career') return { kind: null, domain: 'career' };
  if (area === 'knowledge') return { kind: 'knowledge', domain: 'knowledge' };
  return { kind: null, domain: 'other' };
}

function assertSafeManifest(manifest) {
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) {
    throw new ProjectCatalogError('unsupported_project_manifest', 'project manifest schemaVersion must be 1');
  }
  for (const key of PROHIBITED_MANIFEST_KEYS) {
    if (Object.hasOwn(manifest, key)) {
      throw new ProjectCatalogError('project_command_forbidden', `project manifest cannot define ${key}`);
    }
  }
}

function localRecordFromRoot(root, projectsRoot, manifest, manifestPath) {
  assertSafeManifest(manifest);
  const inferred = inferredClassification(root, projectsRoot);
  const id = exactProjectId(manifest.id ?? path.basename(root));
  const title = typeof manifest.title === 'string' && manifest.title.trim() ? manifest.title.trim() : path.basename(root);
  let manifestCanonical = null;
  if (typeof manifest.canonicalRoot === 'string' && manifest.canonicalRoot.trim()) {
    if (hasParentSegment(manifest.canonicalRoot)) throw new ProjectCatalogError('path_traversal_rejected', 'project manifest canonicalRoot contains parent traversal');
    const candidate = path.isAbsolute(manifest.canonicalRoot) ? path.resolve(manifest.canonicalRoot) : path.resolve(root, manifest.canonicalRoot);
    if (!pathIsWithin(projectsRoot, candidate)) throw new ProjectCatalogError('path_outside_projects_root', 'project manifest canonicalRoot is outside the configured projects root');
    if (hasSensitiveNativeSegment(candidate)) throw new ProjectCatalogError('sensitive_path_rejected', 'project manifest canonicalRoot overlaps native sensitive state');
    manifestCanonical = candidate;
  }
  const progressInput = manifest.progressGates ?? manifest.progress?.gates ?? {};
  const manualOverride = manifest.progressOverride ?? manifest.progress?.override ?? null;
  return {
    id,
    title,
    kind: optionalEnum(manifest.kind, KINDS, 'kind') ?? inferred.kind,
    domain: optionalEnum(manifest.domain, DOMAINS, 'domain') ?? inferred.domain,
    canonicalRoot: root,
    progress: computeProjectProgress({ gates: progressInput, manualOverride }),
    serviceProfileId: manifest.serviceProfileId === undefined || manifest.serviceProfileId === null ? null : exactProjectId(manifest.serviceProfileId, 'serviceProfileId'),
    links: normalizedLinks(manifest.links),
    sensitivity: optionalEnum(manifest.sensitivity, SENSITIVITIES, 'sensitivity'),
    lastVerifiedAt: typeof manifest.lastVerifiedAt === 'string' && !Number.isNaN(Date.parse(manifest.lastVerifiedAt)) ? new Date(manifest.lastVerifiedAt).toISOString() : null,
    runtime: manifest.runtime && typeof manifest.runtime === 'object' && !Array.isArray(manifest.runtime) ? structuredClone(manifest.runtime) : null,
    release: manifest.release && typeof manifest.release === 'object' && !Array.isArray(manifest.release) ? structuredClone(manifest.release) : null,
    localHints: {
      lifecycle: manifest.lifecycle ?? null,
      priority: manifest.priority ?? null,
      nextAction: manifest.nextAction ?? null,
      canonicalRoot: manifestCanonical,
      claimedProgress: manifest.progress && !manifest.progress.gates ? structuredClone(manifest.progress) : null
    },
    sourceRefs: [{ type: manifestPath ? 'project-manifest' : 'injected-root', path: manifestPath ?? root }],
    conflicts: []
  };
}

function safeProfileSummary(profile) {
  return {
    hostingProvider: typeof profile.hosting_provider === 'string' ? profile.hosting_provider : null,
    providerProject: typeof profile.provider_project === 'string' ? profile.provider_project : null,
    primaryDomain: typeof profile.primary_domain === 'string' ? profile.primary_domain : null,
    sourceRepository: typeof profile.source_repository === 'string' ? profile.source_repository : null,
    sourceVisibility: typeof profile.source_visibility === 'string' ? profile.source_visibility : null,
    lastVerifiedAt: typeof profile.last_verified_at === 'string' && !Number.isNaN(Date.parse(profile.last_verified_at)) ? new Date(profile.last_verified_at).toISOString() : null,
    lastVerificationStatus: typeof profile.last_verification?.status === 'string' ? profile.last_verification.status : null,
    productionUrl: typeof profile.last_verification?.production_url === 'string' ? profile.last_verification.production_url : null
  };
}

function localRecordFromWebService(service, canonicalRoot, workspaceFile, profileFile, profile) {
  const id = exactProjectId(service.key, 'website service key');
  const summary = safeProfileSummary(profile ?? {});
  const visibility = summary.sourceVisibility ?? service.source_visibility;
  const sensitivity = visibility === 'public' ? 'public-safe' : visibility === 'private' ? 'private' : null;
  return {
    id,
    title: typeof service.title === 'string' && service.title.trim() ? service.title.trim() : id,
    kind: service.kind === 'tool' ? 'tool' : 'product',
    domain: 'web',
    canonicalRoot,
    progress: computeProjectProgress(),
    serviceProfileId: null,
    links: normalizedLinks({
      repository: summary.sourceRepository ?? service.source_repository ?? null,
      production: service.production_url ?? summary.productionUrl ?? null,
      docs: []
    }),
    sensitivity,
    lastVerifiedAt: summary.lastVerifiedAt,
    runtime: {
      hostingProvider: summary.hostingProvider ?? service.hosting_provider ?? null,
      hostname: service.hostname ?? summary.primaryDomain ?? null,
      dataMode: service.data_mode ?? null,
      domainStatus: service.domain_status ?? null,
      accessClassification: service.path_type ?? null
    },
    release: {
      repositoryStatus: service.repository_status ?? null,
      sourceVisibility: visibility ?? null,
      providerProject: summary.providerProject ?? service.provider_project ?? null,
      lastVerificationStatus: summary.lastVerificationStatus
    },
    localHints: { lifecycle: null, priority: null, nextAction: null, canonicalRoot: null, claimedProgress: null },
    sourceRefs: [
      { type: 'website-workspace', path: workspaceFile },
      ...(profileFile ? [{ type: 'website-profile', path: profileFile }] : [])
    ],
    conflicts: []
  };
}

function equalValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeLinks(target, incoming, conflicts) {
  const merged = { ...target, docs: [...new Set([...(target.docs ?? []), ...(incoming.docs ?? [])])] };
  for (const field of ['notion', 'repository', 'production']) {
    if (merged[field] === null) merged[field] = incoming[field];
    else if (incoming[field] !== null && merged[field] !== incoming[field]) {
      conflicts.push({ field: `links.${field}`, left: merged[field], right: incoming[field] });
    }
  }
  return merged;
}

function mergeLocalRecord(target, incoming) {
  const result = structuredClone(target);
  const conflicts = [...result.conflicts, ...incoming.conflicts];
  for (const field of ['title', 'kind', 'domain', 'serviceProfileId', 'sensitivity', 'runtime', 'release']) {
    if (result[field] === null || result[field] === undefined) result[field] = structuredClone(incoming[field]);
    else if (incoming[field] !== null && incoming[field] !== undefined && !equalValue(result[field], incoming[field])) {
      conflicts.push({ field, left: result[field], right: incoming[field] });
    }
  }
  if (result.canonicalRoot !== incoming.canonicalRoot) {
    conflicts.push({ field: 'canonicalRoot', left: result.canonicalRoot, right: incoming.canonicalRoot });
    result.canonicalRoot = null;
  }
  result.links = mergeLinks(result.links, incoming.links, conflicts);
  result.lastVerifiedAt = [result.lastVerifiedAt, incoming.lastVerifiedAt].filter(Boolean).sort().at(-1) ?? null;
  result.sourceRefs = [...result.sourceRefs, ...incoming.sourceRefs];
  for (const field of ['lifecycle', 'priority', 'nextAction', 'canonicalRoot', 'claimedProgress']) {
    const current = result.localHints[field];
    const next = incoming.localHints[field];
    if (current === null || current === undefined) result.localHints[field] = structuredClone(next);
    else if (next !== null && next !== undefined && !equalValue(current, next)) conflicts.push({ field: `localHints.${field}`, left: current, right: next });
  }
  result.conflicts = conflicts;
  return result;
}

function addLocalRecord(records, record) {
  records.set(record.id, records.has(record.id) ? mergeLocalRecord(records.get(record.id), record) : record);
}

export function collectLocalProjects({
  projectsRoot,
  structureReadmePath = 'README.md',
  projectRoots = [],
  projectOverlays = [],
  websiteWorkspacePaths = [],
  websiteProfilePaths = [],
  now = () => Date.now()
} = {}) {
  const boundary = ensureDirectoryRoot(projectsRoot);
  const structureReadme = approvedPath(structureReadmePath, boundary, { type: 'file', label: 'structure README' });
  if (structureReadme !== path.join(boundary.realRoot, 'README.md')) {
    throw new ProjectCatalogError('noncanonical_structure_readme', 'structure README must be the configured projects root README.md');
  }
  const structureBytes = fs.readFileSync(structureReadme);
  const profileFiles = new Map();
  const overlayByRoot = new Map();
  for (const overlay of projectOverlays) {
    if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) throw new ProjectCatalogError('project_overlay_invalid', 'project overlay must be an object');
    const overlayRoot = approvedPath(overlay.root, boundary, { type: 'directory', label: 'project overlay root' });
    if (overlayByRoot.has(overlayRoot)) throw new ProjectCatalogError('project_overlay_invalid', 'project overlay root was injected more than once');
    const { root: _root, ...manifestFields } = overlay;
    assertSafeManifest(manifestFields);
    overlayByRoot.set(overlayRoot, manifestFields);
  }
  for (const input of websiteProfilePaths) {
    const file = approvedPath(input, boundary, { type: 'file', label: 'website profile' });
    if (profileFiles.has(file)) throw new ProjectCatalogError('duplicate_website_profile', 'website profile path was injected more than once');
    profileFiles.set(file, { profile: readJson(file, 'website profile'), used: false });
  }
  const records = new Map();
  for (const input of projectRoots) {
    const root = approvedPath(input, boundary, { type: 'directory', label: 'project root' });
    const manifestCandidate = path.join(root, '.aicc', 'project.json');
    let manifest = {};
    let manifestPath = null;
    if (fs.existsSync(manifestCandidate)) {
      manifestPath = approvedPath(manifestCandidate, boundary, { type: 'file', label: 'project manifest' });
      manifest = readJson(manifestPath, 'project manifest');
    }
    if (overlayByRoot.has(root)) manifest = { ...manifest, ...overlayByRoot.get(root) };
    addLocalRecord(records, localRecordFromRoot(root, boundary.realRoot, manifest, manifestPath));
  }
  for (const input of websiteWorkspacePaths) {
    const workspaceFile = approvedPath(input, boundary, { type: 'file', label: 'website workspace' });
    const workspace = readJson(workspaceFile, 'website workspace');
    if (!Array.isArray(workspace.services)) throw new ProjectCatalogError('website_workspace_invalid', 'website workspace services must be an array');
    const workspaceRoot = path.dirname(workspaceFile);
    for (const service of workspace.services) {
      if (!service || typeof service !== 'object' || Array.isArray(service)) throw new ProjectCatalogError('website_service_invalid', 'website service must be an object');
      const relativeRoot = service.repository_root ?? service.canonical_path;
      if (typeof relativeRoot !== 'string' || path.isAbsolute(relativeRoot)) {
        throw new ProjectCatalogError('website_path_rejected', 'website service canonical path must be relative to the workspace file');
      }
      const canonicalRoot = approvedPath(path.resolve(workspaceRoot, relativeRoot), boundary, { type: 'directory', label: 'website service root' });
      let profileFile = null;
      let profile = null;
      if (service.profile_path !== undefined && service.profile_path !== null) {
        if (typeof service.profile_path !== 'string' || path.isAbsolute(service.profile_path)) {
          throw new ProjectCatalogError('website_profile_path_rejected', 'website profile path must be relative to the workspace file');
        }
        const expected = approvedPath(path.resolve(workspaceRoot, service.profile_path), boundary, { type: 'file', label: 'website profile reference' });
        const injected = profileFiles.get(expected);
        if (injected) {
          profileFile = expected;
          profile = injected.profile;
          injected.used = true;
        }
      }
      addLocalRecord(records, localRecordFromWebService(service, canonicalRoot, workspaceFile, profileFile, profile));
    }
  }
  const unusedProfile = [...profileFiles.entries()].find(([, value]) => !value.used);
  if (unusedProfile) {
    throw new ProjectCatalogError('unbound_website_profile', 'an injected website profile is not referenced by an injected website workspace', { path: unusedProfile[0] });
  }
  return {
    schemaVersion: 1,
    collectedAt: new Date(now()).toISOString(),
    structureReadme: { path: structureReadme, sha256: sha256(structureBytes) },
    projectsRoot: boundary.realRoot,
    projects: [...records.values()].sort((left, right) => left.id.localeCompare(right.id))
  };
}

function stableNotionIdentity(raw) {
  const explicit = raw.projectId ?? raw.mappedProjectId ?? raw.slug;
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) {
    return { id: exactProjectId(explicit, 'mapped Notion project id'), source: 'explicit-mapping' };
  }
  const uniqueId = raw.uniqueId ?? raw['고유 ID'];
  const stableValue = uniqueId ?? raw.notionId ?? raw.pageId ?? raw.id;
  if (stableValue === undefined || stableValue === null || !String(stableValue).trim()) {
    throw new ProjectCatalogError('notion_identity_missing', 'Notion item requires an exact mapping, unique ID, or page ID');
  }
  const normalized = String(stableValue).trim().toLowerCase();
  if (uniqueId !== undefined && PROJECT_ID.test(normalized)) return { id: normalized, source: 'notion-unique-id' };
  const compactUuid = normalized.replaceAll('-', '');
  if (/^[a-f0-9]{32}$/.test(compactUuid)) return { id: `notion-${compactUuid}`, source: uniqueId !== undefined ? 'notion-unique-id' : 'notion-page-id' };
  return { id: `notion-${sha256(normalized).slice(0, 24)}`, source: uniqueId !== undefined ? 'notion-unique-id' : 'notion-page-id' };
}

function normalizeNotionItem(raw, itemType, snapshot) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProjectCatalogError('notion_item_invalid', 'Notion item must be an object');
  const identity = stableNotionIdentity(raw);
  const priorityRank = raw.priority && typeof raw.priority === 'object' ? raw.priority.rank : raw.priority;
  const priorityUpdatedAt = raw.priority && typeof raw.priority === 'object' ? raw.priority.updatedAt : raw.priorityUpdatedAt;
  const priority = Number.isInteger(priorityRank) && priorityRank >= 0 && typeof priorityUpdatedAt === 'string' && !Number.isNaN(Date.parse(priorityUpdatedAt))
    ? { rank: priorityRank, source: 'notion', updatedAt: new Date(priorityUpdatedAt).toISOString() }
    : null;
  return {
    id: identity.id,
    identitySource: identity.source,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : identity.id,
    kind: optionalEnum(raw.kind, KINDS, 'Notion kind') ?? (itemType === 'idea' ? 'idea' : null),
    domain: optionalEnum(raw.domain, DOMAINS, 'Notion domain') ?? (itemType === 'idea' ? 'notion' : null),
    lifecycle: optionalEnum(raw.lifecycle, LIFECYCLES, 'Notion lifecycle'),
    priority,
    nextAction: typeof raw.nextAction === 'string' && raw.nextAction.trim() ? raw.nextAction.trim() : null,
    canonicalRootClaim: typeof raw.canonicalRoot === 'string' && raw.canonicalRoot.trim() ? raw.canonicalRoot.trim() : null,
    notionId: raw.notionId ?? raw.pageId ?? raw.id ?? null,
    notionUrl: typeof raw.notionUrl === 'string' && raw.notionUrl.trim() ? raw.notionUrl.trim() : null,
    itemType,
    snapshotVersion: snapshot.version ?? null,
    capturedAt: snapshot.capturedAt ?? null
  };
}

export function normalizeNotionSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !Array.isArray(snapshot.projects) || !Array.isArray(snapshot.ideas)) {
    throw new ProjectCatalogError('notion_snapshot_invalid', 'Notion snapshot must contain projects and ideas arrays');
  }
  if (snapshot.capturedAt !== undefined && Number.isNaN(Date.parse(snapshot.capturedAt))) {
    throw new ProjectCatalogError('notion_snapshot_invalid', 'Notion snapshot capturedAt must be an ISO timestamp');
  }
  const items = [
    ...snapshot.projects.map(item => normalizeNotionItem(item, 'project', snapshot)),
    ...snapshot.ideas.map(item => normalizeNotionItem(item, 'idea', snapshot))
  ];
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new ProjectCatalogError('duplicate_notion_project', `Notion snapshot contains duplicate project id: ${item.id}`);
    seen.add(item.id);
  }
  return { version: snapshot.version ?? null, capturedAt: snapshot.capturedAt ?? null, items };
}

function driftRecord(field, authoritativeSource, localValue, notionValue, reason = null) {
  return { field, authoritativeSource, localValue: localValue ?? null, notionValue: notionValue ?? null, ...(reason ? { reason } : {}) };
}

function projectFromSources(local, notion) {
  const drift = [];
  if (local) {
    for (const conflict of local.conflicts) drift.push(driftRecord(conflict.field, 'local', conflict.left, conflict.right, 'local-source-conflict'));
  }
  if (local && notion) {
    for (const field of ['lifecycle', 'priority', 'nextAction']) {
      const localValue = local.localHints[field];
      const notionValue = notion[field];
      if (notionValue === null) drift.push(driftRecord(field, 'notion', localValue, notionValue, 'notion-authoritative-value-missing'));
      else if (localValue !== null && localValue !== undefined && !equalValue(localValue, notionValue)) drift.push(driftRecord(field, 'notion', localValue, notionValue));
    }
    if (local.localHints.canonicalRoot && path.resolve(local.localHints.canonicalRoot) !== local.canonicalRoot) {
      drift.push(driftRecord('canonicalRoot', 'local', local.canonicalRoot, notion.canonicalRootClaim, 'local-manifest-root-does-not-match-collected-realpath'));
    }
    if (notion.canonicalRootClaim && notion.canonicalRootClaim !== local.canonicalRoot) {
      drift.push(driftRecord('canonicalRoot', 'local', local.canonicalRoot, notion.canonicalRootClaim));
    }
    if (local.localHints.claimedProgress) {
      drift.push(driftRecord('progress', 'local', local.progress, local.localHints.claimedProgress, 'claimed-percent-not-current-evidence'));
    }
  }
  const sourceState = drift.length > 0 ? 'DRIFT' : local && notion ? 'IN_SYNC' : local ? 'LOCAL_ONLY' : 'NOTION_ONLY';
  return {
    schemaVersion: 1,
    id: notion?.id ?? local.id,
    title: notion?.title ?? local.title,
    kind: notion?.kind ?? local?.kind ?? null,
    domain: notion?.domain ?? local?.domain ?? null,
    canonicalRoot: local?.canonicalRoot ?? null,
    lifecycle: notion?.lifecycle ?? null,
    progress: local?.progress ?? computeProjectProgress(),
    priority: notion?.priority ?? null,
    nextAction: notion?.nextAction ?? null,
    serviceProfileId: local?.serviceProfileId ?? null,
    links: {
      notion: notion?.notionUrl ?? null,
      repository: local?.links.repository ?? null,
      production: local?.links.production ?? null,
      docs: local?.links.docs ?? []
    },
    sensitivity: local?.sensitivity ?? null,
    lastVerifiedAt: local?.lastVerifiedAt ?? null,
    sourceState,
    drift,
    origins: {
      local: local ? {
        sourceRefs: local.sourceRefs,
        localHints: local.localHints
      } : null,
      notion: notion ? {
        notionId: notion.notionId,
        itemType: notion.itemType,
        identitySource: notion.identitySource,
        snapshotVersion: notion.snapshotVersion,
        capturedAt: notion.capturedAt,
        canonicalRootClaim: notion.canonicalRootClaim
      } : null
    },
    runtime: local?.runtime ?? null,
    release: local?.release ?? null
  };
}

export function mergeProjectCatalog({ localSnapshot, notionSnapshot, now = () => Date.now() } = {}) {
  if (!localSnapshot || !Array.isArray(localSnapshot.projects)) {
    throw new ProjectCatalogError('local_snapshot_invalid', 'local project snapshot is required');
  }
  const notion = normalizeNotionSnapshot(notionSnapshot);
  const localById = new Map(localSnapshot.projects.map(project => [project.id, project]));
  const notionById = new Map(notion.items.map(project => [project.id, project]));
  const ids = new Set([...localById.keys(), ...notionById.keys()]);
  const projects = [...ids].map(id => projectFromSources(localById.get(id) ?? null, notionById.get(id) ?? null));
  projects.sort((left, right) => {
    const leftRank = left.priority?.rank ?? Number.MAX_SAFE_INTEGER;
    const rightRank = right.priority?.rank ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  });
  const count = state => projects.filter(project => project.sourceState === state).length;
  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    sourcePolicy: {
      notionAuthoritative: ['lifecycle', 'priority', 'nextAction'],
      localAuthoritative: ['canonicalRoot', 'source', 'runtime', 'release'],
      silentOverwrite: false
    },
    sourceSnapshots: {
      local: {
        collectedAt: localSnapshot.collectedAt ?? null,
        projectsRoot: localSnapshot.projectsRoot ?? null,
        structureReadme: localSnapshot.structureReadme ?? null,
        count: localSnapshot.projects.length
      },
      notion: {
        version: notion.version,
        capturedAt: notion.capturedAt,
        projects: notion.items.filter(item => item.itemType === 'project').length,
        projectsActive: notion.items.filter(item => item.itemType === 'project' && item.lifecycle !== 'archived').length,
        projectsArchived: notion.items.filter(item => item.itemType === 'project' && item.lifecycle === 'archived').length,
        ideas: notion.items.filter(item => item.itemType === 'idea').length,
        ideasActive: notion.items.filter(item => item.itemType === 'idea' && item.lifecycle !== 'archived').length,
        ideasArchived: notion.items.filter(item => item.itemType === 'idea' && item.lifecycle === 'archived').length
      }
    },
    projects,
    summary: {
      total: projects.length,
      inSync: count('IN_SYNC'),
      localOnly: count('LOCAL_ONLY'),
      notionOnly: count('NOTION_ONLY'),
      drift: count('DRIFT')
    }
  };
}

export function collectProjectCatalog(options = {}) {
  const localSnapshot = collectLocalProjects(options);
  return mergeProjectCatalog({ localSnapshot, notionSnapshot: options.notionSnapshot, now: options.now });
}
