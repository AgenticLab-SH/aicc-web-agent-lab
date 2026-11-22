import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SOURCE_ID = /^local_source_[a-f0-9]{24}$/;
const GRANT_REF = /^local_grant_[A-Za-z0-9_-]{16,96}$/;
const HASH = /^[a-f0-9]{64}$/;
const SOURCE_TYPES = new Set(['local', 'codex-sessions']);
const CODEX_SESSION_ROOTS = new Set(['sessions', 'archived_sessions']);
const ARCHIVE_EXTENSIONS = new Set(['.7z', '.bz2', '.gz', '.rar', '.tar', '.tgz', '.xz', '.zip']);
const DATABASE_EXTENSIONS = new Set(['.db', '.db3', '.duckdb', '.mdb', '.sqlite', '.sqlite3']);
const BINARY_EXTENSIONS = new Set([
  '.a', '.avi', '.bin', '.bmp', '.class', '.dmg', '.doc', '.docx', '.dylib', '.eot', '.exe', '.gif',
  '.heic', '.ico', '.jar', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.o', '.otf', '.pdf', '.png',
  '.ppt', '.pptx', '.pyc', '.so', '.ttf', '.wav', '.webm', '.webp', '.woff', '.woff2', '.xls', '.xlsx'
]);
const SENSITIVE_BASENAMES = new Set([
  '.env', '.git-credentials', '.netrc', '.npmrc', '.pypirc', 'auth.db', 'auth.json', 'cookies',
  'cookies.binarycookies', 'credentials', 'credentials.json', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'id_rsa', 'keychain-2.db', 'login data', 'session.db', 'sessions.db', 'web data'
]);
const SENSITIVE_EXTENSIONS = new Set(['.key', '.p12', '.pfx', '.pem']);
const BROWSER_SEGMENTS = new Set([
  'brave-browser', 'chrome', 'chromium', 'com.brave.browser', 'com.google.chrome', 'firefox',
  'microsoft edge', 'profiles', 'whale'
]);
const PRIVATE_STATE_SEGMENTS = new Set([
  '.aws', '.claude', '.codex', '.codex-chatgpt-web', '.codex-multi', '.gnupg', '.opencodex', '.ssh'
]);

export class LocalAccessPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalAccessPolicyError';
    this.code = code;
  }
}

export function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requireOpaque(value, label, pattern = OPAQUE_REF) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new LocalAccessPolicyError('local_grant_invalid', `${label} must be an opaque reference`);
  }
  return value;
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new LocalAccessPolicyError('local_grant_invalid', `${label} is outside the supported range`);
  }
  return value;
}

function normalizePattern(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value)) {
    throw new LocalAccessPolicyError('local_grant_invalid', `${label} must be a relative path pattern`);
  }
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) {
    throw new LocalAccessPolicyError('local_grant_invalid', `${label} cannot escape the granted root`);
  }
  return normalized;
}

function patternRegex(pattern) {
  if (pattern === '.' || pattern === '**' || pattern === '**/*') return /^.*$/;
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^(?:${source})(?:/.*)?$`);
}

function matchesAny(relativePath, patterns) {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '') || '.';
  return patterns.some(pattern => patternRegex(pattern).test(normalized));
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function absoluteParts(value) {
  return path.resolve(value).split(path.sep).filter(Boolean).map(part => part.toLocaleLowerCase('en-US'));
}

function isTccProtected(value) {
  const normalized = `/${absoluteParts(value).join('/')}/`;
  return [
    '/library/application support/com.apple.tcc/', '/library/mail/', '/library/messages/',
    '/library/safari/', '/library/calendars/', '/library/addressbook/'
  ].some(fragment => normalized.includes(fragment));
}

function isApplicationSupport(value) {
  return `/${absoluteParts(value).join('/')}/`.includes('/library/application support/');
}

function sensitiveReason(canonicalRoot, relativePath, policy, sourceType) {
  const candidate = path.resolve(canonicalRoot, relativePath === '.' ? '' : relativePath);
  const relativeParts = relativePath.replaceAll('\\', '/').split('/').filter(part => part && part !== '.');
  const lowered = relativeParts.map(part => part.toLocaleLowerCase('en-US'));
  const basename = lowered.at(-1) ?? '';
  const absolute = `/${absoluteParts(candidate).join('/')}/`;

  if (isTccProtected(candidate)) return { code: 'HOLD_TCC', message: 'macOS TCC-protected stores are not readable through local access grants' };
  if (isApplicationSupport(candidate) && !policy.applicationSupportApproved) {
    return { code: 'local_sensitive_path_denied', message: 'Application Support requires an explicit, separately reviewed grant policy' };
  }
  if (lowered.includes('.ssh')) return { code: 'local_sensitive_path_denied', message: '.ssh is always denied' };
  const privateStateSegment = absoluteParts(candidate).find(part => PRIVATE_STATE_SEGMENTS.has(part));
  const exactDedicatedSessionsRoot = sourceType === 'codex-sessions'
    && CODEX_SESSION_ROOTS.has(path.basename(canonicalRoot).toLocaleLowerCase('en-US'))
    && inside(canonicalRoot, candidate);
  if (privateStateSegment && !(privateStateSegment === '.codex' && exactDedicatedSessionsRoot)) {
    return { code: 'local_sensitive_path_denied', message: 'credential and session state homes require a dedicated provider and cannot be read as local sources' };
  }
  if (absolute.includes('/library/keychains/') || basename.includes('keychain')) {
    return { code: 'local_sensitive_path_denied', message: 'Keychain data is always denied' };
  }
  if (sourceType !== 'codex-sessions' && (absolute.includes('/.codex/sessions/') || absolute.includes('/.codex/archived_sessions/'))) {
    return { code: 'local_sensitive_path_denied', message: 'Codex session files require the dedicated session provider' };
  }
  if (lowered.some(part => BROWSER_SEGMENTS.has(part)) || basename.includes('cookie')) {
    return { code: 'local_sensitive_path_denied', message: 'browser profiles and cookies are always denied' };
  }
  const credentialVariant = basename.startsWith('.env.')
    || /^(?:credentials?|secrets?)(?:\.[a-z0-9_-]+)?$/i.test(basename)
    || /^(?:auth|sessions?)(?:[-_][a-z0-9_-]+)?\.(?:db|db3|json|sqlite|sqlite3)$/i.test(basename)
    || /^(?:access|refresh|auth)?[-_]?tokens?(?:\.(?:json|ya?ml|toml|ini|db|sqlite))?$/i.test(basename);
  if (SENSITIVE_BASENAMES.has(basename) || credentialVariant || SENSITIVE_EXTENSIONS.has(path.extname(basename))) {
    return { code: 'local_sensitive_path_denied', message: 'credential, secret, auth, or session database files are always denied' };
  }
  return null;
}

export function localPolicyHash({ sourceType, canonicalRoot, includes, denies, policy, budgets }) {
  return stableHash({
    schemaVersion: 1,
    sourceType,
    canonicalRoot,
    includes,
    denies,
    policy: {
      wholeHomeApproved: policy.wholeHomeApproved,
      applicationSupportApproved: policy.applicationSupportApproved,
      binaryContent: 'metadata-only',
      archiveContent: 'metadata-only',
      databaseContent: 'metadata-only',
      write: false,
      exec: false
    },
    budgets
  });
}

export function localAuditHash({ sourceId, policyHash, correlationId, approvedAt, expiresAt, previewFileCount }) {
  return stableHash({ schemaVersion: 1, sourceId, policyHash, correlationId, approvedAt, expiresAt, previewFileCount });
}

export function normalizeLocalGrant(raw, { now = () => Date.now(), homeRoot = os.homedir() } = {}) {
  if (!raw || raw.schemaVersion !== 1) throw new LocalAccessPolicyError('local_grant_invalid', 'local grant schemaVersion must be 1');
  requireOpaque(raw.grantRef, 'grant_ref', GRANT_REF);
  requireOpaque(raw.sourceId, 'source_id', SOURCE_ID);
  requireOpaque(raw.correlationId, 'correlation_id');
  if (!SOURCE_TYPES.has(raw.sourceType)) throw new LocalAccessPolicyError('local_grant_invalid', 'unsupported local source type');
  if (typeof raw.root !== 'string' || !path.isAbsolute(raw.root) || typeof raw.canonicalRoot !== 'string' || !path.isAbsolute(raw.canonicalRoot)) {
    throw new LocalAccessPolicyError('local_grant_invalid', 'grant roots must be exact absolute paths created by the local UI');
  }
  let rootStat;
  try { rootStat = fs.lstatSync(raw.root); } catch (error) { throw mapFilesystemError(error, 'the granted root is unavailable'); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new LocalAccessPolicyError('local_grant_invalid', 'the granted root must be a real directory, not a symlink');
  const canonicalRoot = fs.realpathSync(raw.root);
  if (path.resolve(raw.root) !== canonicalRoot || path.resolve(raw.canonicalRoot) !== canonicalRoot) {
    throw new LocalAccessPolicyError('local_root_mismatch', 'the exact granted root no longer matches its canonical realpath');
  }
  const policy = {
    wholeHomeApproved: raw.policy?.wholeHomeApproved === true,
    applicationSupportApproved: raw.policy?.applicationSupportApproved === true
  };
  let canonicalHome = null;
  try { canonicalHome = fs.realpathSync(homeRoot); } catch { canonicalHome = path.resolve(homeRoot); }
  const filesystemRoot = path.parse(canonicalRoot).root;
  if (canonicalRoot === filesystemRoot || (canonicalRoot !== canonicalHome && inside(canonicalRoot, canonicalHome))) {
    throw new LocalAccessPolicyError('local_root_too_broad', 'filesystem roots and ancestors of the owner home cannot be granted');
  }
  if (canonicalRoot === canonicalHome && !policy.wholeHomeApproved) {
    throw new LocalAccessPolicyError('local_whole_home_denied', 'a home-root grant requires explicit wholeHomeApproved policy');
  }
  if (raw.sourceType === 'codex-sessions' && !CODEX_SESSION_ROOTS.has(path.basename(canonicalRoot).toLocaleLowerCase('en-US'))) {
    throw new LocalAccessPolicyError('session_root_invalid', 'a codex-sessions grant must target the exact sessions or archived_sessions directory, not a broader Codex home');
  }
  const rootSensitive = sensitiveReason(canonicalRoot, '.', policy, raw.sourceType);
  if (rootSensitive) throw new LocalAccessPolicyError(rootSensitive.code, rootSensitive.message);

  const includes = (raw.includes ?? []).map((item, index) => normalizePattern(item, `includes[${index}]`));
  const denies = (raw.denies ?? []).map((item, index) => normalizePattern(item, `denies[${index}]`));
  if (!includes.length) throw new LocalAccessPolicyError('local_grant_invalid', 'at least one explicit include path is required');
  const budgets = {
    maxFiles: requireInteger(raw.budgets?.maxFiles, 'maxFiles', 1, 100_000),
    maxFileBytes: requireInteger(raw.budgets?.maxFileBytes, 'maxFileBytes', 1, 16 * 1024 * 1024),
    maxReadBytes: requireInteger(raw.budgets?.maxReadBytes, 'maxReadBytes', 1, 16 * 1024 * 1024),
    maxRunBytes: requireInteger(raw.budgets?.maxRunBytes, 'maxRunBytes', 1, 64 * 1024 * 1024),
    maxMatches: requireInteger(raw.budgets?.maxMatches, 'maxMatches', 1, 10_000)
  };
  if (budgets.maxReadBytes > budgets.maxRunBytes || budgets.maxFileBytes > budgets.maxRunBytes) {
    throw new LocalAccessPolicyError('local_grant_invalid', 'per-read budgets cannot exceed the run byte budget');
  }
  const approvedAtMs = Date.parse(raw.approvedAt);
  const expiresAtMs = Date.parse(raw.expiresAt);
  if (!Number.isFinite(approvedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= now()) {
    throw new LocalAccessPolicyError('local_grant_expired', 'the local UI grant is expired or has invalid timestamps');
  }
  const approvedAt = new Date(approvedAtMs).toISOString();
  const expiresAt = new Date(expiresAtMs).toISOString();
  const previewFileCount = requireInteger(raw.preview?.fileCount, 'preview.fileCount', 0, 10_000_000);
  const policyHash = localPolicyHash({ sourceType: raw.sourceType, canonicalRoot, includes, denies, policy, budgets });
  if (!HASH.test(raw.policyHash) || raw.policyHash !== policyHash || raw.preview?.policyHash !== policyHash) {
    throw new LocalAccessPolicyError('local_policy_mismatch', 'the grant preview policy hash does not match the current exact-root policy');
  }
  const auditHash = localAuditHash({ sourceId: raw.sourceId, policyHash, correlationId: raw.correlationId, approvedAt, expiresAt, previewFileCount });
  if (!HASH.test(raw.auditHash) || raw.auditHash !== auditHash) {
    throw new LocalAccessPolicyError('local_audit_mismatch', 'the grant audit hash is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    grantRef: raw.grantRef,
    sourceId: raw.sourceId,
    sourceType: raw.sourceType,
    label: typeof raw.label === 'string' ? raw.label.slice(0, 128) : 'Approved local source',
    canonicalRoot,
    includes: Object.freeze(includes),
    denies: Object.freeze(denies),
    policy: Object.freeze(policy),
    budgets: Object.freeze(budgets),
    preview: Object.freeze({ fileCount: previewFileCount, policyHash }),
    correlationId: raw.correlationId,
    approvedAt,
    expiresAt,
    policyHash,
    auditHash
  });
}

export function assertGrantedRelativePath(grant, relativePath, { expect = null } = {}) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
    throw new LocalAccessPolicyError('local_path_invalid', 'paths must be relative to the exact granted root');
  }
  const normalized = path.normalize(relativePath).replaceAll('\\', '/').replace(/^\.\//, '') || '.';
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) {
    throw new LocalAccessPolicyError('local_path_escape', 'the requested path escapes the exact granted root');
  }
  if (!matchesAny(normalized, grant.includes) || matchesAny(normalized, grant.denies)) {
    throw new LocalAccessPolicyError('local_path_not_granted', 'the requested path is outside the grant include/deny policy');
  }
  const sensitive = sensitiveReason(grant.canonicalRoot, normalized, grant.policy, grant.sourceType);
  if (sensitive) throw new LocalAccessPolicyError(sensitive.code, sensitive.message);
  const target = path.resolve(grant.canonicalRoot, normalized === '.' ? '' : normalized);
  if (!inside(grant.canonicalRoot, target)) throw new LocalAccessPolicyError('local_path_escape', 'the requested path escapes the exact granted root');

  const relativeParts = normalized === '.' ? [] : normalized.split('/');
  let cursor = grant.canonicalRoot;
  try {
    for (const part of relativeParts) {
      cursor = path.join(cursor, part);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new LocalAccessPolicyError('local_symlink_denied', 'symbolic links are not traversed by local access tools');
    }
    const real = fs.realpathSync(target);
    if (!inside(grant.canonicalRoot, real) || real !== target) throw new LocalAccessPolicyError('local_symlink_denied', 'the path realpath differs from the granted path');
    const stat = fs.lstatSync(real);
    if (expect === 'file' && !stat.isFile()) throw new LocalAccessPolicyError('local_path_type', 'the requested path is not a regular file');
    if (expect === 'directory' && !stat.isDirectory()) throw new LocalAccessPolicyError('local_path_type', 'the requested path is not a directory');
    return { path: real, relativePath: normalized, stat };
  } catch (error) {
    if (error instanceof LocalAccessPolicyError) throw error;
    throw mapFilesystemError(error, 'the requested local path is unavailable');
  }
}

export function contentDisposition(filePath, sample = null) {
  const extension = path.extname(filePath).toLocaleLowerCase('en-US');
  if (ARCHIVE_EXTENSIONS.has(extension)) return { kind: 'archive', contentMode: 'metadata-only' };
  if (DATABASE_EXTENSIONS.has(extension)) return { kind: 'database', contentMode: 'metadata-only' };
  if (BINARY_EXTENSIONS.has(extension)) return { kind: 'binary', contentMode: 'metadata-only' };
  if (sample && Buffer.from(sample).subarray(0, 8192).includes(0)) return { kind: 'binary', contentMode: 'metadata-only' };
  return { kind: 'text', contentMode: 'redacted-text' };
}

export function redactLocalText(value) {
  let text = String(value);
  text = text.replace(/-----BEGIN [^-\n]+-----[\s\S]*?-----END [^-\n]+-----/gi, '<redacted-pem-block>');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer <redacted>');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<redacted-token>');
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})\b/g, '<redacted-token>');
  text = text.replace(/(^|\n)\s*authorization\s*:[^\n]*/gi, '$1<redacted-authorization-line>');
  text = text.replace(/(^|\n)\s*(?:set-cookie|cookie)\s*:[^\n]*/gi, '$1<redacted-cookie-line>');
  text = text.replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie|authorization)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,\n}]+)/gi, '$1<redacted>');
  text = text.replace(/(["']?(?:prompt|tool[_-]?output|command[_-]?output)["']?\s*:\s*)(?:"[^"\n]*"|'[^'\n]*'|[^,\n}]+)/gi, '$1<redacted-sensitive-text>');
  text = text.replace(/(^|\n)(\s*(?:system|developer|user)?\s*prompt\s*[:=]).*$/gim, '$1$2 <redacted-prompt>');
  text = text.replace(/(^|\n)(\s*(?:tool|command)[_-]?output\s*[:=]).*$/gim, '$1$2 <redacted-tool-output>');
  return text;
}

export function mapFilesystemError(error, fallbackMessage = 'local filesystem access failed') {
  if (error instanceof LocalAccessPolicyError) return error;
  if (error?.code === 'EPERM' || error?.code === 'EACCES') {
    return new LocalAccessPolicyError('HOLD_TCC', 'macOS denied this read; do not bypass TCC or switch browser/account/provider');
  }
  if (error?.code === 'ENOENT') return new LocalAccessPolicyError('local_path_missing', fallbackMessage);
  return new LocalAccessPolicyError('local_read_failed', fallbackMessage);
}
