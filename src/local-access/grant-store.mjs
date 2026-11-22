import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LocalAccessPolicyError,
  assertGrantedRelativePath,
  localAuditHash,
  localPolicyHash,
  normalizeLocalGrant
} from '../../components/workspace-mcp/local-access-policy.mjs';

const GRANT_REF = /^local_grant_[A-Za-z0-9_-]{16,96}$/;
const APPROVAL_REF = /^session_approval_[A-Za-z0-9_-]{16,96}$/;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_TYPES = new Set(['local', 'codex-sessions']);
const SKIPPABLE = new Set(['local_path_not_granted', 'local_sensitive_path_denied', 'local_symlink_denied']);

export class LocalAccessGrantStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalAccessGrantStoreError';
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

function readJsonFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new LocalAccessGrantStoreError('local_state_invalid', 'local access state must be a regular owner file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function exactDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new LocalAccessGrantStoreError('local_root_invalid', 'an exact absolute local root is required');
  }
  let stat;
  try { stat = fs.lstatSync(value); }
  catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') throw new LocalAccessGrantStoreError('HOLD_TCC', 'macOS denied the selected root; do not bypass TCC');
    throw new LocalAccessGrantStoreError('local_root_unavailable', 'the selected local root is unavailable');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalAccessGrantStoreError('local_root_invalid', 'the selected root must be a real directory, not a symlink');
  const canonicalRoot = fs.realpathSync(value);
  if (path.resolve(value) !== canonicalRoot) throw new LocalAccessGrantStoreError('local_root_mismatch', 'the selected root must already be its canonical realpath');
  return canonicalRoot;
}

function ensurePrivateStateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new LocalAccessGrantStoreError('local_state_invalid', 'local access state directories must be real directories, not symlinks');
  }
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function stringArray(value, label, fallback) {
  const source = value === undefined ? fallback : value;
  if (!Array.isArray(source) || source.some(item => typeof item !== 'string' || !item.trim())) {
    throw new LocalAccessGrantStoreError('local_grant_invalid', `${label} must be an array of non-empty relative patterns`);
  }
  return source.map(item => item.trim());
}

function integer(value, fallback, minimum, maximum, label) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new LocalAccessGrantStoreError('local_grant_invalid', `${label} is outside the supported range`);
  }
  return selected;
}

function sourceId(sourceType, canonicalRoot) {
  return `local_source_${crypto.createHash('sha256').update(`${sourceType}\0${canonicalRoot}`).digest('hex').slice(0, 24)}`;
}

function countPreview(grant, maximum) {
  const queue = ['.'];
  let fileCount = 0;
  let directoryCount = 0;
  let skippedCount = 0;
  let truncated = false;
  while (queue.length) {
    const relativeDirectory = queue.shift();
    let directory;
    try { directory = assertGrantedRelativePath(grant, relativeDirectory, { expect: 'directory' }); }
    catch (error) {
      if (SKIPPABLE.has(error?.code)) { skippedCount += 1; continue; }
      throw error;
    }
    directoryCount += 1;
    let entries;
    try { entries = fs.readdirSync(directory.path, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') throw new LocalAccessGrantStoreError('HOLD_TCC', 'macOS denied preview traversal; do not bypass TCC');
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) { skippedCount += 1; continue; }
      const relativePath = relativeDirectory === '.' ? entry.name : `${relativeDirectory}/${entry.name}`;
      let resolved;
      try { resolved = assertGrantedRelativePath(grant, relativePath); }
      catch (error) {
        if (SKIPPABLE.has(error?.code) || error?.code === 'HOLD_TCC') { skippedCount += 1; continue; }
        throw error;
      }
      if (resolved.stat.isDirectory()) queue.push(relativePath);
      else if (resolved.stat.isFile()) fileCount += 1;
      if (fileCount + directoryCount >= maximum) { truncated = true; queue.length = 0; break; }
    }
  }
  return { fileCount, directoryCount, skippedCount, truncated };
}

function safeRef(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new LocalAccessGrantStoreError(code, 'local access reference is invalid');
  return value;
}

export function localAccessStateRoot(options = {}) {
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center');
  const root = options.root ?? path.join(stateRoot, 'local-access');
  if (!path.isAbsolute(root)) throw new LocalAccessGrantStoreError('local_state_invalid', 'local access state root must be absolute');
  return path.resolve(root);
}

export class LocalAccessGrantStore {
  constructor({ root, stateRoot, homeRoot = os.homedir(), now = () => Date.now(), maximumPreviewEntries = 100_000 } = {}) {
    this.root = localAccessStateRoot({ root, stateRoot });
    this.now = now;
    this.homeRoot = homeRoot;
    this.maximumPreviewEntries = integer(maximumPreviewEntries, 100_000, 1, 1_000_000, 'maximumPreviewEntries');
    this.grantsRoot = path.join(this.root, 'grants');
    this.approvalsRoot = path.join(this.root, 'excerpt-approvals');
    this.consumedApprovalsRoot = path.join(this.root, 'consumed-excerpt-approvals');
    ensurePrivateStateDirectory(this.root);
    ensurePrivateStateDirectory(this.grantsRoot);
    ensurePrivateStateDirectory(this.approvalsRoot);
    ensurePrivateStateDirectory(this.consumedApprovalsRoot);
  }

  prepareGrant(input = {}) {
    const canonicalRoot = exactDirectory(input.root);
    const sourceType = input.sourceType ?? 'local';
    if (!SOURCE_TYPES.has(sourceType)) throw new LocalAccessGrantStoreError('local_grant_invalid', 'sourceType must be local or codex-sessions');
    const includes = stringArray(input.includes, 'includes', ['**/*']);
    const denies = stringArray(input.denies, 'denies', []);
    const policy = {
      wholeHomeApproved: input.wholeHomeApproved === true,
      applicationSupportApproved: input.applicationSupportApproved === true
    };
    const canonicalHome = fs.realpathSync(this.homeRoot);
    if (canonicalRoot === canonicalHome && policy.wholeHomeApproved && denies.length === 0) {
      throw new LocalAccessGrantStoreError('local_whole_home_denylist_required', 'an explicit home-root grant requires a non-empty user denylist in addition to structural sensitive-path denial');
    }
    const budgets = {
      maxFiles: integer(input.budgets?.maxFiles, 10_000, 1, 100_000, 'maxFiles'),
      maxFileBytes: integer(input.budgets?.maxFileBytes, 1024 * 1024, 1, 16 * 1024 * 1024, 'maxFileBytes'),
      maxReadBytes: integer(input.budgets?.maxReadBytes, 4 * 1024 * 1024, 1, 16 * 1024 * 1024, 'maxReadBytes'),
      maxRunBytes: integer(input.budgets?.maxRunBytes, 16 * 1024 * 1024, 1, 64 * 1024 * 1024, 'maxRunBytes'),
      maxMatches: integer(input.budgets?.maxMatches, 1_000, 1, 10_000, 'maxMatches')
    };
    const ttlSeconds = integer(input.ttlSeconds, 3_600, 60, 3_600, 'ttlSeconds');
    const approvedAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + ttlSeconds * 1_000).toISOString();
    const correlationId = typeof input.correlationId === 'string' && input.correlationId.trim()
      ? input.correlationId.trim()
      : `local-correlation-${crypto.randomUUID()}`;
    const id = sourceId(sourceType, canonicalRoot);
    const policyHash = localPolicyHash({ sourceType, canonicalRoot, includes, denies, policy, budgets });
    const provisional = {
      schemaVersion: 1,
      grantRef: `local_grant_${crypto.randomBytes(16).toString('hex')}`,
      sourceId: id,
      sourceType,
      label: typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 128) : path.basename(canonicalRoot),
      root: canonicalRoot,
      canonicalRoot,
      includes,
      denies,
      policy,
      budgets,
      preview: { fileCount: 0, policyHash },
      correlationId,
      approvedAt,
      expiresAt,
      policyHash,
      auditHash: localAuditHash({ sourceId: id, policyHash, correlationId, approvedAt, expiresAt, previewFileCount: 0 })
    };
    const normalized = normalizeLocalGrant(provisional, { now: this.now, homeRoot: this.homeRoot });
    const preview = countPreview(normalized, Math.min(this.maximumPreviewEntries, budgets.maxFiles));
    const record = {
      ...provisional,
      preview: { ...preview, policyHash },
      auditHash: localAuditHash({ sourceId: id, policyHash, correlationId, approvedAt, expiresAt, previewFileCount: preview.fileCount })
    };
    normalizeLocalGrant(record, { now: this.now, homeRoot: this.homeRoot });
    return record;
  }

  issueGrant(record) {
    const normalized = normalizeLocalGrant(record, { now: this.now, homeRoot: this.homeRoot });
    const file = path.join(this.grantsRoot, `${normalized.grantRef}.json`);
    if (fs.existsSync(file)) throw new LocalAccessGrantStoreError('local_grant_exists', 'the local grant reference already exists');
    atomicJson(file, record);
    return structuredClone(record);
  }

  resolveGrant(grantRef) {
    safeRef(grantRef, GRANT_REF, 'local_grant_invalid');
    const file = path.join(this.grantsRoot, `${grantRef}.json`);
    try {
      const record = readJsonFile(file);
      normalizeLocalGrant(record, { now: this.now, homeRoot: this.homeRoot });
      return record;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  listGrants() {
    return fs.readdirSync(this.grantsRoot, { withFileTypes: true })
      .filter(entry => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
      .flatMap(entry => {
        try {
          const record = readJsonFile(path.join(this.grantsRoot, entry.name));
          return [{
            grantRef: record.grantRef,
            sourceId: record.sourceId,
            sourceType: record.sourceType,
            label: record.label,
            canonicalRoot: record.canonicalRoot,
            includes: record.includes,
            denies: record.denies,
            expiresAt: record.expiresAt,
            expired: Date.parse(record.expiresAt) <= this.now(),
            policyHash: record.policyHash,
            auditHash: record.auditHash,
            preview: record.preview
          }];
        } catch { return []; }
      })
      .sort((left, right) => right.expiresAt.localeCompare(left.expiresAt));
  }

  prepareExcerptApproval(input = {}) {
    const grant = this.resolveGrant(input.grantRef);
    if (!grant) throw new LocalAccessGrantStoreError('local_grant_unknown', 'the source grant is unknown');
    if (grant.sourceType !== 'codex-sessions') throw new LocalAccessGrantStoreError('session_source_required', 'excerpt approval requires a dedicated Codex sessions grant');
    const sessionUuid = String(input.sessionUuid ?? '').toLocaleLowerCase('en-US');
    if (!SESSION_UUID.test(sessionUuid)) throw new LocalAccessGrantStoreError('session_uuid_invalid', 'a valid Codex session UUID is required');
    const ttlSeconds = integer(input.ttlSeconds, 300, 60, 900, 'excerpt ttlSeconds');
    return {
      schemaVersion: 1,
      approved: true,
      approvalRef: `session_approval_${crypto.randomBytes(16).toString('hex')}`,
      sourceId: grant.sourceId,
      sessionUuid,
      correlationId: grant.correlationId,
      auditHash: grant.auditHash,
      expiresAt: new Date(this.now() + ttlSeconds * 1_000).toISOString(),
      maxLines: integer(input.maxLines, 80, 1, 200, 'maxLines'),
      maxTurns: integer(input.maxTurns, 8, 1, 20, 'maxTurns'),
      maxBytes: integer(input.maxBytes, 64 * 1024, 1, 256 * 1024, 'maxBytes'),
      allowAssistantText: input.allowAssistantText === true,
      rawPrompt: false,
      rawToolOutput: false
    };
  }

  issueExcerptApproval(record) {
    safeRef(record?.approvalRef, APPROVAL_REF, 'session_approval_invalid');
    const file = path.join(this.approvalsRoot, `${record.approvalRef}.json`);
    if (fs.existsSync(file)) throw new LocalAccessGrantStoreError('session_approval_exists', 'the excerpt approval reference already exists');
    atomicJson(file, record);
    return structuredClone(record);
  }

  resolveExcerptApproval({ approvalRef, sourceId: expectedSourceId, sessionUuid, correlationId, auditHash } = {}) {
    safeRef(approvalRef, APPROVAL_REF, 'session_approval_invalid');
    const file = path.join(this.approvalsRoot, `${approvalRef}.json`);
    try {
      const record = readJsonFile(file);
      if (record.sourceId !== expectedSourceId || record.sessionUuid !== sessionUuid || record.correlationId !== correlationId || record.auditHash !== auditHash) return null;
      const consumed = path.join(this.consumedApprovalsRoot, `${approvalRef}.json`);
      try { fs.renameSync(file, consumed); }
      catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'EEXIST') return null;
        throw error;
      }
      if (process.platform !== 'win32') fs.chmodSync(consumed, 0o600);
      return record;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
}
