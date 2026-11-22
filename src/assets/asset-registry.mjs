import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ASSET_KINDS = new Set(['project', 'skill', 'codex_plugin', 'chatgpt_project', 'custom_gpt']);
const LIFECYCLES = new Set(['idea', 'active', 'paused', 'retired', 'unknown']);
const SYNC_STATES = new Set(['DISCOVERED', 'IN_SYNC', 'DRIFT', 'HOLD', 'RETIRED', 'UNKNOWN']);
const ASSET_ID = /^(?:project|skill|plugin|chatgpt-project|custom-gpt):[A-Za-z0-9][A-Za-z0-9._:+-]{0,255}$/;
const FORBIDDEN_KEYS = /(?:^|_)(?:token|cookie|password|secret|session|browser_profile|storage_state)(?:$|_)/i;

export class AssetRegistryError extends Error {
  constructor(code, message) { super(message); this.name = 'AssetRegistryError'; this.code = code; }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function assetFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function assertSecretFree(value, trail = []) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw new AssetRegistryError('secret_field_denied', `asset record cannot contain ${[...trail, key].join('.')}`);
    assertSecretFree(item, [...trail, key]);
  }
}

function isoOrNull(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

export function normalizeAssetRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AssetRegistryError('asset_invalid', 'asset record must be an object');
  assertSecretFree(input);
  const assetId = String(input.assetId ?? '').trim();
  if (!ASSET_ID.test(assetId)) throw new AssetRegistryError('asset_id_invalid', 'assetId must use a stable kind-prefixed identifier');
  const assetKind = String(input.assetKind ?? '').trim();
  if (!ASSET_KINDS.has(assetKind)) throw new AssetRegistryError('asset_kind_invalid', `unsupported asset kind: ${assetKind}`);
  const displayName = String(input.displayName ?? '').trim();
  if (!displayName) throw new AssetRegistryError('asset_name_required', 'displayName is required');
  const lifecycle = String(input.lifecycle ?? 'unknown').trim();
  if (!LIFECYCLES.has(lifecycle)) throw new AssetRegistryError('asset_lifecycle_invalid', `unsupported lifecycle: ${lifecycle}`);
  const syncState = String(input.syncState ?? 'DISCOVERED').trim();
  if (!SYNC_STATES.has(syncState)) throw new AssetRegistryError('asset_sync_state_invalid', `unsupported sync state: ${syncState}`);
  const record = {
    schemaVersion: 1,
    assetId,
    assetKind,
    displayName,
    canonicalOwner: String(input.canonicalOwner ?? '').trim(),
    canonicalLocator: input.canonicalLocator === null || input.canonicalLocator === undefined ? null : String(input.canonicalLocator),
    sourceRevision: input.sourceRevision === null || input.sourceRevision === undefined ? null : String(input.sourceRevision),
    lifecycle,
    priority: Number.isInteger(input.priority) && input.priority >= 0 ? input.priority : null,
    nextAction: input.nextAction === null || input.nextAction === undefined ? null : String(input.nextAction),
    sensitivity: input.sensitivity === null || input.sensitivity === undefined ? null : String(input.sensitivity),
    syncState,
    adapterId: String(input.adapterId ?? '').trim(),
    lastObservedAt: isoOrNull(input.lastObservedAt),
    lastVerifiedAt: isoOrNull(input.lastVerifiedAt),
    rollbackRef: input.rollbackRef === null || input.rollbackRef === undefined ? null : String(input.rollbackRef),
    capabilities: [...new Set(Array.isArray(input.capabilities) ? input.capabilities.map(String) : [])].sort(),
    drift: Array.isArray(input.drift) ? structuredClone(input.drift) : [],
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? structuredClone(input.metadata) : {}
  };
  if (!record.canonicalOwner || !record.adapterId) throw new AssetRegistryError('asset_owner_required', 'canonicalOwner and adapterId are required');
  record.fingerprint = assetFingerprint({ ...record, fingerprint: undefined });
  return record;
}

function skillDigest(directory) {
  const files = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(directory);
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(directory, file).split(path.sep).join('/')).update('\0').update(fs.readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

export function collectSkillAssets({ skillRoot, observedAt = new Date().toISOString() } = {}) {
  if (!skillRoot || !path.isAbsolute(skillRoot) || !fs.existsSync(skillRoot)) return [];
  return fs.readdirSync(skillRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && fs.existsSync(path.join(skillRoot, entry.name, 'SKILL.md')))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => normalizeAssetRecord({
      assetId: `skill:${entry.name}`,
      assetKind: 'skill',
      displayName: entry.name,
      canonicalOwner: 'open-AICC guidance',
      canonicalLocator: path.join(skillRoot, entry.name),
      sourceRevision: skillDigest(path.join(skillRoot, entry.name)),
      lifecycle: 'active',
      syncState: 'DISCOVERED',
      adapterId: 'aicc-guidance-v1',
      lastObservedAt: observedAt,
      capabilities: ['inspect', 'create', 'update', 'deploy', 'recoverable_remove']
    }));
}

export function projectAsset(project, observedAt) {
  return normalizeAssetRecord({
    assetId: `project:${project.id}`,
    assetKind: 'project',
    displayName: project.title ?? project.id,
    canonicalOwner: 'independent-git',
    canonicalLocator: project.canonicalRoot ?? null,
    sourceRevision: project.sourceRevision ?? project.release?.revision ?? null,
    lifecycle: project.lifecycle === 'archived' ? 'retired' : project.lifecycle ? 'active' : 'unknown',
    priority: project.priority && typeof project.priority === 'object' ? project.priority.rank : project.priority,
    nextAction: project.nextAction ?? null,
    sensitivity: project.sensitivity ?? null,
    syncState: project.sourceState === 'IN_SYNC' ? 'IN_SYNC' : project.sourceState === 'DRIFT' ? 'DRIFT' : 'DISCOVERED',
    adapterId: 'aicc-project-catalog-v1',
    lastObservedAt: observedAt,
    lastVerifiedAt: project.lastVerifiedAt ?? null,
    capabilities: ['inspect', 'register', 'update_manifest', 'archive_with_approval'],
    drift: project.drift ?? [],
    metadata: { domain: project.domain ?? null, kind: project.kind ?? null, sourceState: project.sourceState ?? null }
  });
}

export function pluginAsset(entry, observedAt) {
  return normalizeAssetRecord({
    assetId: `plugin:${entry.id}`,
    assetKind: 'codex_plugin',
    displayName: entry.id,
    canonicalOwner: entry.owner,
    canonicalLocator: entry.source?.path ?? null,
    sourceRevision: entry.source?.revision ?? entry.source?.version ?? null,
    lifecycle: 'active',
    sensitivity: entry.distribution === 'public' ? 'public-safe' : 'private',
    syncState: 'DISCOVERED',
    adapterId: 'aicc-extension-registry-v1',
    lastObservedAt: observedAt,
    capabilities: ['inspect', 'install', 'enable', 'disable', 'update', 'recoverable_remove', 'rollback'],
    metadata: { version: entry.source?.version ?? null, distribution: entry.distribution ?? null }
  });
}

export function buildAssetInventory({ projects = [], skills = [], plugins = [], chatgpt = [], generatedAt = new Date().toISOString() } = {}) {
  const assets = [...projects, ...skills, ...plugins, ...chatgpt].map(normalizeAssetRecord).sort((left, right) => left.assetId.localeCompare(right.assetId));
  const ids = new Set();
  for (const asset of assets) {
    if (ids.has(asset.assetId)) throw new AssetRegistryError('asset_duplicate', `duplicate assetId: ${asset.assetId}`);
    ids.add(asset.assetId);
  }
  const byKind = Object.fromEntries([...ASSET_KINDS].sort().map(kind => [kind, assets.filter(asset => asset.assetKind === kind).length]));
  const byState = Object.fromEntries([...SYNC_STATES].sort().map(state => [state, assets.filter(asset => asset.syncState === state).length]));
  const fingerprint = assetFingerprint(assets.map(({ lastObservedAt, ...asset }) => asset));
  return { schemaVersion: 1, generatedAt: new Date(generatedAt).toISOString(), fingerprint, assets, summary: { total: assets.length, byKind, byState } };
}

export const assetKinds = [...ASSET_KINDS];
