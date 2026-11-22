import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeAssetRecord } from './asset-registry.mjs';

export class ChatGptAssetImportError extends Error {
  constructor(code, message) { super(message); this.name = 'ChatGptAssetImportError'; this.code = code; }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function kindFor(kind, remoteId) {
  const normalized = String(kind ?? '').toLowerCase();
  if (normalized.includes('project') || (typeof remoteId === 'string' && remoteId.startsWith('g-p-'))) return 'chatgpt_project';
  if (normalized.includes('custom') || (typeof remoteId === 'string' && remoteId.startsWith('g-'))) return 'custom_gpt';
  return null;
}

function oneRecord({ remoteId, kind, name, status, visibility, verifiedAt, account, workspace }) {
  const assetKind = kindFor(kind, remoteId);
  if (!assetKind || typeof remoteId !== 'string' || !remoteId.trim()) return null;
  const retired = /retired|absent/i.test(String(status));
  const inSync = /in_sync/i.test(String(status));
  return normalizeAssetRecord({
    assetId: `${assetKind === 'custom_gpt' ? 'custom-gpt' : 'chatgpt-project'}:${remoteId}`,
    assetKind,
    displayName: String(name ?? remoteId),
    canonicalOwner: 'ChatGPT visible UI',
    canonicalLocator: remoteId,
    lifecycle: retired ? 'retired' : 'active',
    sensitivity: visibility && /public|all people/i.test(visibility) ? 'public-visible' : 'private',
    syncState: retired ? 'RETIRED' : inSync ? 'IN_SYNC' : 'DISCOVERED',
    adapterId: 'chatgpt-visible-ui-v1',
    lastObservedAt: verifiedAt,
    lastVerifiedAt: inSync ? verifiedAt : null,
    capabilities: ['inspect', 'create_with_approval', 'update_with_approval'],
    metadata: { account: account ?? null, workspace: workspace ?? null, visibility: visibility ?? null, providerStatus: status ?? null, nameObserved: typeof name === 'string' && Boolean(name.trim()) }
  });
}

export function normalizeChatGptAssetExport(input, { importedAt = new Date().toISOString() } = {}) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.assets)) throw new ChatGptAssetImportError('chatgpt_export_invalid', 'ChatGPT asset export requires an assets array');
  const verifiedAt = Number.isFinite(Date.parse(input.verifiedAt)) ? new Date(input.verifiedAt).toISOString() : importedAt;
  const records = [];
  for (const item of input.assets) {
    if (Array.isArray(item.remoteIds)) {
      for (const remoteId of item.remoteIds) {
        const record = oneRecord({ ...item, remoteId, verifiedAt, account: input.accountHandle ?? input.visibleAccount, workspace: input.workspace });
        if (record) records.push(record);
      }
      continue;
    }
    const record = oneRecord({ ...item, remoteId: item.remoteId, verifiedAt, account: input.accountHandle ?? input.visibleAccount, workspace: input.workspace });
    if (record) records.push(record);
  }
  const unique = new Map(records.map(record => [record.assetId, record]));
  return { schemaVersion: 1, importedAt, sourceVerifiedAt: verifiedAt, assets: [...unique.values()].sort((left, right) => left.assetId.localeCompare(right.assetId)) };
}

export class ChatGptAssetImportStore {
  constructor({ root, now = () => Date.now() } = {}) {
    if (!root || !path.isAbsolute(root)) throw new ChatGptAssetImportError('state_root_required', 'an absolute owner state root is required');
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'chatgpt-assets.json');
    this.now = now;
  }

  read() {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ChatGptAssetImportError('state_invalid', 'ChatGPT asset state must be a regular owner file');
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { schemaVersion: 1, importedAt: null, sourceVerifiedAt: null, assets: [] };
      throw error;
    }
  }

  import(input) {
    const normalized = normalizeChatGptAssetExport(input, { importedAt: new Date(this.now()).toISOString() });
    atomicJson(this.file, normalized);
    return { imported: normalized.assets.length, importedAt: normalized.importedAt, sourceVerifiedAt: normalized.sourceVerifiedAt, externalWritePerformed: false };
  }
}
