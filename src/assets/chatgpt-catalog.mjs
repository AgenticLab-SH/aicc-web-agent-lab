import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeAssetRecord } from './asset-registry.mjs';

const KINDS = new Set(['conversation', 'chatgpt_project', 'custom_gpt']);
const STATUSES = new Set(['captured', 'linked', 'pending', 'unavailable', 'invalid', 'observed']);
const SAFE_SCOPE = /^[A-Za-z0-9._-]{1,100}$/;
const FORBIDDEN_KEY = /token|cookie|password|secret|authorization|prompt|response|messageContent|conversationBody/i;

export class ChatGptCatalogError extends Error {
  constructor(code, message) { super(message); this.name = 'ChatGptCatalogError'; this.code = code; }
}

function text(value, label, limit) {
  if (typeof value !== 'string' || !value.trim()) throw new ChatGptCatalogError('catalog_invalid', `${label} is required`);
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length > limit) throw new ChatGptCatalogError('catalog_invalid', `${label} exceeds ${limit} characters`);
  return normalized;
}

function nullableText(value, label, limit) {
  return value === null || value === undefined ? null : text(value, label, limit);
}

function nullableCount(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0 || value > 10_000_000) throw new ChatGptCatalogError('catalog_invalid', `${label} must be a bounded non-negative integer`);
  return value;
}

function nullableDate(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new ChatGptCatalogError('catalog_invalid', `${label} must be an ISO date or null`);
  return new Date(value).toISOString();
}

function containsForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => FORBIDDEN_KEY.test(key) || containsForbiddenKey(item));
}

function normalizeItem(input) {
  if (!input || typeof input !== 'object' || containsForbiddenKey(input)) throw new ChatGptCatalogError('private_content_denied', 'catalog items must not include prompts, responses, messages, credentials, or session data');
  const accountAlias = text(input.accountAlias, 'accountAlias', 100);
  const workspace = text(input.workspace, 'workspace', 100);
  if (!SAFE_SCOPE.test(accountAlias) || !SAFE_SCOPE.test(workspace)) throw new ChatGptCatalogError('catalog_invalid', 'accountAlias and workspace must be safe identifiers');
  if (!KINDS.has(input.kind) || !STATUSES.has(input.status)) throw new ChatGptCatalogError('catalog_invalid', 'catalog item kind or status is invalid');
  const remoteId = text(input.remoteId, 'remoteId', 200);
  return {
    schemaVersion: 1,
    itemId: `${input.kind}:${accountAlias}:${remoteId}`,
    accountAlias,
    workspace,
    kind: input.kind,
    remoteId,
    title: text(input.title, 'title', 300),
    shortDescription: text(input.shortDescription, 'shortDescription', 300),
    status: input.status,
    projectId: nullableText(input.projectId, 'projectId', 200),
    projectName: nullableText(input.projectName, 'projectName', 300),
    createdAt: nullableDate(input.createdAt, 'createdAt'),
    updatedAt: nullableDate(input.updatedAt, 'updatedAt'),
    messageCount: nullableCount(input.messageCount, 'messageCount'),
    userMessageCount: nullableCount(input.userMessageCount, 'userMessageCount'),
    assistantMessageCount: nullableCount(input.assistantMessageCount, 'assistantMessageCount'),
    conversationCount: nullableCount(input.conversationCount, 'conversationCount'),
    fileCount: nullableCount(input.fileCount, 'fileCount'),
    toolCount: nullableCount(input.toolCount, 'toolCount'),
    sourceAccountAlias: nullableText(input.sourceAccountAlias, 'sourceAccountAlias', 100)
  };
}

function fingerprint(items) {
  return crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

export function normalizeChatGptArchiveCatalog(input, { now = () => Date.now() } = {}) {
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.items) || input.items.length > 100_000) throw new ChatGptCatalogError('catalog_invalid', 'ChatGPT archive catalog requires a bounded items array');
  if (containsForbiddenKey(input)) throw new ChatGptCatalogError('private_content_denied', 'catalog must not include prompts, responses, messages, credentials, or session data');
  const unique = new Map();
  for (const raw of input.items) {
    const item = normalizeItem(raw);
    if (unique.has(item.itemId)) throw new ChatGptCatalogError('catalog_duplicate', `duplicate catalog item: ${item.itemId}`);
    unique.set(item.itemId, item);
  }
  const items = [...unique.values()].sort((left, right) => left.itemId.localeCompare(right.itemId));
  const accounts = [...new Set(items.map(item => item.accountAlias))].sort();
  return {
    schemaVersion: 1,
    importedAt: new Date(now()).toISOString(),
    sourceGeneratedAt: nullableDate(input.generatedAt, 'generatedAt'),
    fingerprint: fingerprint(items),
    accounts,
    summary: {
      total: items.length,
      conversations: items.filter(item => item.kind === 'conversation').length,
      projects: items.filter(item => item.kind === 'chatgpt_project').length,
      customGpts: items.filter(item => item.kind === 'custom_gpt').length,
      captured: items.filter(item => item.status === 'captured').length,
      linked: items.filter(item => item.status === 'linked').length,
      pending: items.filter(item => item.status === 'pending').length,
      unavailable: items.filter(item => item.status === 'unavailable').length,
      invalid: items.filter(item => item.status === 'invalid').length
    },
    items,
    externalWritePerformed: false
  };
}

export class ChatGptArchiveCatalogStore {
  constructor({ root, now = () => Date.now() }) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'chatgpt-archive-catalog.json');
    this.now = now;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(this.root, 0o700);
  }

  read() {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ChatGptCatalogError('catalog_file_invalid', 'ChatGPT catalog must be a regular owner file');
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { schemaVersion: 1, importedAt: null, sourceGeneratedAt: null, fingerprint: null, accounts: [], summary: { total: 0, conversations: 0, projects: 0, customGpts: 0, captured: 0, linked: 0, pending: 0, unavailable: 0, invalid: 0 }, items: [], externalWritePerformed: false };
      throw error;
    }
  }

  import(input) {
    const normalized = normalizeChatGptArchiveCatalog(input, { now: this.now });
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, this.file);
    if (process.platform !== 'win32') fs.chmodSync(this.file, 0o600);
    return { imported: normalized.summary.total, fingerprint: normalized.fingerprint, accounts: normalized.accounts, summary: normalized.summary, externalWritePerformed: false };
  }

  status() {
    const catalog = this.read();
    return { available: catalog.fingerprint !== null, importedAt: catalog.importedAt, sourceGeneratedAt: catalog.sourceGeneratedAt, fingerprint: catalog.fingerprint, accounts: catalog.accounts, summary: catalog.summary };
  }

  assets() {
    const catalog = this.read();
    return catalog.items.filter(item => item.kind === 'chatgpt_project' || item.kind === 'custom_gpt').map(item => normalizeAssetRecord({
      assetId: `${item.kind === 'custom_gpt' ? 'custom-gpt' : 'chatgpt-project'}:${item.remoteId}`,
      assetKind: item.kind,
      displayName: item.title,
      canonicalOwner: 'ChatGPT archive observation',
      canonicalLocator: item.remoteId,
      lifecycle: 'active',
      sensitivity: 'private',
      syncState: item.status === 'observed' ? 'DISCOVERED' : 'HOLD',
      adapterId: 'chatgpt-archive-summary-v1',
      lastObservedAt: item.updatedAt ?? catalog.sourceGeneratedAt,
      capabilities: ['inspect', 'reconcile_with_visible_ui'],
      drift: item.status === 'observed' ? [] : [{ code: 'ARCHIVE_METADATA_PENDING_VISIBLE_VERIFY' }],
      metadata: {
        account: item.accountAlias,
        workspace: item.workspace,
        shortDescription: item.shortDescription,
        conversationCount: item.conversationCount,
        fileCount: item.fileCount,
        toolCount: item.toolCount,
        evidenceLevel: 'undocumented_read_only_observation',
        nameObserved: true
      }
    }));
  }

  query(input = {}) {
    const catalog = this.read();
    const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(100, input.limit)) : 25;
    const cursor = Number.isInteger(input.cursor) ? Math.max(0, input.cursor) : 0;
    const query = String(input.query ?? '').trim().toLocaleLowerCase('ko-KR');
    const items = catalog.items.filter(item => {
      if (input.accountAlias && item.accountAlias !== input.accountAlias) return false;
      if (input.kind && item.kind !== input.kind) return false;
      if (input.status && item.status !== input.status) return false;
      return !query || `${item.title}\n${item.shortDescription}\n${item.projectName ?? ''}`.toLocaleLowerCase('ko-KR').includes(query);
    });
    const page = items.slice(cursor, cursor + limit);
    return { schemaVersion: 1, total: items.length, cursor, nextCursor: cursor + page.length < items.length ? cursor + page.length : null, limit, items: page, externalWritePerformed: false };
  }
}
