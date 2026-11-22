import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceChangeTransactionService } from './change-transaction.mjs';
import { createPortableZip, validatePortableZip } from './portable-bundle.mjs';

const POLICY_VERSION = 1;
const MAX_SELECTED_UNTRACKED = 100;
const MAX_OPERATIONS = 20;
const DEFAULT_MAX_READ_BYTES = 1_048_576;
const DEFAULT_MAX_SEARCH_BYTES = 2_097_152;
const DEFAULT_MAX_SEARCH_FILES = 500;
const DEFAULT_MAX_RESULTS = 100;
const MAX_PORTABLE_FILES = 9_999;
const MAX_PORTABLE_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_PORTABLE_TOTAL_BYTES = 512 * 1024 * 1024;
const SAFE_ENV_TEMPLATE_NAMES = new Set(['.env.example', '.env.sample', '.env.template']);

const SENSITIVE_FILE_NAMES = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'cookies',
  'cookies.json',
  'id_ed25519',
  'id_rsa',
  'keychain-db',
  'login data',
  'secrets.json',
  'storage-state.json',
]);

const SENSITIVE_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|ghp|xox[baprs])_[A-Za-z0-9_-]{16,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/i,
];

export class WorkspaceSnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceSnapshotError';
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function ensureOwnerDirectory(directory) {
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new WorkspaceSnapshotError('owner_state_invalid', `snapshot owner state is not a regular directory: ${directory}`);
  }
  if (existing && typeof process.getuid === 'function' && existing.uid !== process.getuid()) {
    throw new WorkspaceSnapshotError('owner_state_invalid', `snapshot owner state belongs to another user: ${directory}`);
  }
  if (!existing) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function assertOwnerDirectory(directory) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WorkspaceSnapshotError('owner_state_invalid', `snapshot owner directory is missing or unsafe: ${directory}`);
  }
  if ((process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new WorkspaceSnapshotError('owner_state_invalid', `snapshot owner directory permissions are unsafe: ${directory}`);
  }
}

function readOwnerJson(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new WorkspaceSnapshotError('owner_state_invalid', `snapshot owner file is missing or unsafe: ${file}`);
  }
  if ((process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new WorkspaceSnapshotError('owner_state_invalid', `snapshot owner file permissions are unsafe: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeOwnerJsonAtomic(file, value) {
  ensureOwnerDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

function runGit(root, args, maxBuffer = 64 * 1024 * 1024) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.status !== 0) {
    throw new WorkspaceSnapshotError(
      'git_failed',
      `git ${args[0] ?? 'command'} failed: ${(result.stderr || result.stdout || 'unknown error').trim().slice(0, 500)}`,
    );
  }
  return result.stdout;
}

function runGitInput(root, args, input, maxBuffer = 64 * 1024 * 1024) {
  const result = spawnSync('git', ['-C', root, ...args], {
    input,
    encoding: 'utf8',
    maxBuffer,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.status !== 0) {
    throw new WorkspaceSnapshotError(
      'git_failed',
      `git ${args[0] ?? 'command'} failed: ${(result.stderr || result.stdout || 'unknown error').trim().slice(0, 500)}`,
    );
  }
  return result.stdout;
}

function nulList(value) {
  return String(value).split('\0').filter(Boolean);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizeRelative(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 16_384) {
    throw new WorkspaceSnapshotError('path_invalid', 'snapshot path must be a non-empty bounded string');
  }
  if (relativePath.includes('\0') || path.isAbsolute(relativePath)) {
    throw new WorkspaceSnapshotError('path_invalid', 'snapshot path must be relative and contain no NUL byte');
  }
  const normalized = path.normalize(relativePath).replaceAll(path.sep, '/');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new WorkspaceSnapshotError('path_escape', 'snapshot path escapes the workspace root');
  }
  return normalized === '.' ? '.' : normalized.replace(/^\.\//, '');
}

function isSensitivePath(relativePath) {
  const normalized = normalizeRelative(relativePath).toLowerCase();
  const parts = normalized.split('/');
  const name = parts.at(-1) ?? '';
  if (parts.some(part => ['.git', '.ssh', '.codex', '.ai-control-center', 'node_modules'].includes(part))) return true;
  if (SENSITIVE_FILE_NAMES.has(name) || (name.startsWith('.env.') && !SAFE_ENV_TEMPLATE_NAMES.has(name))) return true;
  return /\.(?:pem|p12|pfx|key|keystore)$/i.test(name);
}

function containsSensitiveContent(text) {
  return SENSITIVE_CONTENT.some(pattern => pattern.test(text));
}

function safeExistingFile(root, relativePath) {
  const normalized = normalizeRelative(relativePath);
  if (normalized === '.' || isSensitivePath(normalized)) {
    throw new WorkspaceSnapshotError('sensitive_path', `snapshot access is denied for ${normalized}`);
  }
  const segments = normalized.split('/');
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) throw new WorkspaceSnapshotError('path_missing', `snapshot path does not exist: ${normalized}`);
    if (stat.isSymbolicLink()) throw new WorkspaceSnapshotError('symlink_denied', `snapshot path contains a symlink: ${normalized}`);
  }
  const resolved = fs.realpathSync(current);
  if (!isWithin(root, resolved)) throw new WorkspaceSnapshotError('path_escape', `snapshot path escapes the workspace root: ${normalized}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new WorkspaceSnapshotError('not_a_file', `snapshot path is not a regular file: ${normalized}`);
  return { normalized, resolved, stat };
}

function readSafeText(root, relativePath, maxBytes = DEFAULT_MAX_READ_BYTES) {
  const file = safeExistingFile(root, relativePath);
  if (file.stat.size > maxBytes) {
    throw new WorkspaceSnapshotError('file_too_large', `snapshot file exceeds ${maxBytes} bytes: ${file.normalized}`);
  }
  const bytes = fs.readFileSync(file.resolved);
  if (bytes.includes(0)) throw new WorkspaceSnapshotError('binary_file', `snapshot text operation rejects binary file: ${file.normalized}`);
  const text = bytes.toString('utf8');
  if (containsSensitiveContent(text)) {
    throw new WorkspaceSnapshotError('sensitive_content', `snapshot content guard rejected ${file.normalized}`);
  }
  return { ...file, text, sha256: sha256(bytes) };
}

function canonicalAllowedRoots(allowedRoots) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new WorkspaceSnapshotError('allowed_roots_required', 'workspace snapshots require an explicit allowedRoots boundary');
  }
  return allowedRoots.map(root => fs.realpathSync(root));
}

function canonicalGitRoot(requestedRoot, allowedRoots) {
  const requested = fs.realpathSync(requestedRoot);
  if (!allowedRoots.some(root => isWithin(root, requested))) {
    throw new WorkspaceSnapshotError('workspace_not_allowed', 'workspace root is outside the explicit allowedRoots boundary');
  }
  const gitRoot = fs.realpathSync(runGit(requested, ['rev-parse', '--show-toplevel']).trim());
  if (gitRoot !== requested) {
    throw new WorkspaceSnapshotError('git_root_required', 'workspace snapshot root must be the exact Git toplevel');
  }
  return gitRoot;
}

function branchName(root) {
  const result = spawnSync('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function selectedUntrackedManifest(root, selectedPaths) {
  const selected = [...new Set((selectedPaths ?? []).map(normalizeRelative))].sort();
  if (selected.length > MAX_SELECTED_UNTRACKED) {
    throw new WorkspaceSnapshotError('untracked_limit', `selected untracked overlay exceeds ${MAX_SELECTED_UNTRACKED} files`);
  }
  const untracked = new Set(nulList(runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])));
  return selected.map(relativePath => {
    if (!untracked.has(relativePath)) {
      throw new WorkspaceSnapshotError('untracked_selection_invalid', `selected overlay path is not an untracked Git file: ${relativePath}`);
    }
    const file = readSafeText(root, relativePath);
    return { path: file.normalized, bytes: file.stat.size, sha256: file.sha256 };
  });
}

function copySelectedUntracked(root, destination, selected) {
  for (const item of selected) {
    const source = safeExistingFile(root, item.path);
    const target = path.join(destination, ...item.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source.resolved, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, source.stat.mode & 0o111 ? 0o700 : 0o600);
    const copied = fs.readFileSync(target);
    if (copied.length !== item.bytes || sha256(copied) !== item.sha256) {
      throw new WorkspaceSnapshotError('materialization_mismatch', `selected overlay copy differs: ${item.path}`);
    }
  }
}

function copyTreeOwnerOnly(source, destination, relative = '.', budget = { files: 0, bytes: 0 }) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (relative === '.' && entry.name === '.git') continue;
    const sourcePath = path.join(source, entry.name);
    const nextRelative = relative === '.' ? entry.name : `${relative}/${entry.name}`;
    const destinationPath = path.join(destination, entry.name);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) {
      throw new WorkspaceSnapshotError('symlink_denied', `snapshot materialization rejects symlink: ${nextRelative}`);
    }
    if (stat.isDirectory()) {
      copyTreeOwnerOnly(sourcePath, destinationPath, nextRelative, budget);
      continue;
    }
    if (!stat.isFile()) throw new WorkspaceSnapshotError('materialization_entry_denied', `snapshot materialization rejects special entry: ${nextRelative}`);
    budget.files += 1;
    budget.bytes += stat.size;
    if (budget.files > MAX_PORTABLE_FILES || stat.size > MAX_PORTABLE_ENTRY_BYTES || budget.bytes > MAX_PORTABLE_TOTAL_BYTES) {
      throw new WorkspaceSnapshotError('materialization_limit', `snapshot materialization exceeds portable limits at ${nextRelative}`);
    }
    if (isSensitivePath(nextRelative)) {
      throw new WorkspaceSnapshotError('sensitive_path', `snapshot materialization rejects sensitive path: ${nextRelative}`);
    }
    const bytes = fs.readFileSync(sourcePath);
    if (containsSensitiveContent(bytes.toString('utf8'))) {
      throw new WorkspaceSnapshotError('sensitive_content', `snapshot materialization content guard rejected ${nextRelative}`);
    }
    fs.writeFileSync(destinationPath, bytes, { flag: 'wx', mode: stat.mode & 0o111 ? 0o700 : 0o600 });
    fs.chmodSync(destinationPath, stat.mode & 0o111 ? 0o700 : 0o600);
  }
}

function portableTreeFiles(root, relative = '.', budget = { files: 0, bytes: 0 }) {
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(root, entry.name);
    const entryRelative = relative === '.' ? entry.name : `${relative}/${entry.name}`;
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) throw new WorkspaceSnapshotError('symlink_denied', `snapshot CAS contains symlink: ${entryRelative}`);
    if (stat.isDirectory()) {
      output.push(...portableTreeFiles(entryPath, entryRelative, budget));
      continue;
    }
    if (!stat.isFile()) throw new WorkspaceSnapshotError('materialization_entry_denied', `snapshot CAS contains a special entry: ${entryRelative}`);
    budget.files += 1;
    budget.bytes += stat.size;
    if (budget.files > MAX_PORTABLE_FILES || stat.size > MAX_PORTABLE_ENTRY_BYTES || budget.bytes > MAX_PORTABLE_TOTAL_BYTES) {
      throw new WorkspaceSnapshotError('materialization_limit', `snapshot CAS exceeds portable limits at ${entryRelative}`);
    }
    const bytes = fs.readFileSync(entryPath);
    output.push({ path: entryRelative, bytes, mode: stat.mode & 0o777, sha256: sha256(bytes) });
  }
  return output;
}

function treeDigest(files) {
  return sha256(stableJson(files.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: file.sha256, mode: file.mode }))));
}

function acquireLock(file, code) {
  try {
    return fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new WorkspaceSnapshotError(code, 'another snapshot writer owns this exact artifact');
    throw error;
  }
}

function fingerprint(root, toolSchemaHash, selectedUntrackedPaths) {
  if (!/^[a-f0-9]{64}$/.test(toolSchemaHash ?? '')) {
    throw new WorkspaceSnapshotError('schema_hash_invalid', 'toolSchemaHash must be an exact SHA-256 hex digest');
  }
  const head = runGit(root, ['rev-parse', 'HEAD']).trim();
  const trackedStatus = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  const dirtyPatch = runGit(root, ['diff', '--binary', '--no-ext-diff', 'HEAD', '--']);
  const selectedUntracked = selectedUntrackedManifest(root, selectedUntrackedPaths);
  const policyHash = sha256(stableJson({ version: POLICY_VERSION, sensitiveNames: [...SENSITIVE_FILE_NAMES].sort() }));
  const identity = {
    workspaceRootHash: sha256(root),
    head,
    branch: branchName(root),
    trackedStatusHash: sha256(trackedStatus),
    dirtyOverlayHash: sha256(dirtyPatch),
    selectedUntracked,
    policyHash,
    toolSchemaHash,
  };
  return { ...identity, snapshotId: `snapshot_${sha256(stableJson(identity))}` };
}

function boundedInteger(value, fallback, minimum, maximum) {
  const selected = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new WorkspaceSnapshotError('query_limit_invalid', `query limit must be an integer from ${minimum} to ${maximum}`);
  }
  return selected;
}

function operationPaths(root, manifest, requestedPath = '.') {
  const prefix = normalizeRelative(requestedPath);
  const tracked = nulList(runGit(root, ['ls-files', '-z']));
  const candidates = [...new Set([...tracked, ...manifest.selectedUntracked.map(item => item.path)])].sort();
  return candidates.filter(candidate => {
    if (prefix !== '.' && candidate !== prefix && !candidate.startsWith(`${prefix}/`)) return false;
    if (isSensitivePath(candidate)) return false;
    try {
      safeExistingFile(root, candidate);
      return true;
    } catch {
      return false;
    }
  });
}

function assertSnapshotMember(root, manifest, relativePath) {
  const normalized = normalizeRelative(relativePath);
  const tracked = new Set(nulList(runGit(root, ['ls-files', '-z'])));
  const selected = new Set(manifest.selectedUntracked.map(item => item.path));
  if (!tracked.has(normalized) && !selected.has(normalized)) {
    throw new WorkspaceSnapshotError('path_not_in_snapshot', `path is neither tracked nor selected in this snapshot: ${normalized}`);
  }
  return normalized;
}

function mutableTargetState(root, manifest, relativePath, options = {}) {
  const normalized = normalizeRelative(relativePath);
  if (normalized === '.' || isSensitivePath(normalized)) {
    throw new WorkspaceSnapshotError('sensitive_path', `workspace change is denied for ${normalized}`);
  }
  const segments = normalized.split('/');
  let parent = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    parent = path.join(parent, segments[index]);
    const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkspaceSnapshotError('change_parent_invalid', `workspace change parent is missing or unsafe: ${normalized}`);
    }
  }
  const resolved = path.join(root, ...segments);
  if (!isWithin(root, path.resolve(resolved))) throw new WorkspaceSnapshotError('path_escape', `workspace change escapes the root: ${normalized}`);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new WorkspaceSnapshotError('symlink_denied', `workspace change target is a symlink: ${normalized}`);
  if (stat && !stat.isFile()) throw new WorkspaceSnapshotError('not_a_file', `workspace change target is not a regular file: ${normalized}`);
  const tracked = new Set(nulList(runGit(root, ['ls-files', '-z', '--', normalized])));
  const selected = new Set(manifest.selectedUntracked.map(item => item.path));
  const member = tracked.has(normalized) || selected.has(normalized);
  if (stat && !member) throw new WorkspaceSnapshotError('untracked_target_denied', `workspace change refuses an unselected untracked file: ${normalized}`);
  if (options.requireSnapshotMember && (!member || !stat)) {
    throw new WorkspaceSnapshotError('path_not_in_snapshot', `workspace verification path is not an existing snapshot member: ${normalized}`);
  }
  if (!stat && !options.allowMissing) throw new WorkspaceSnapshotError('path_missing', `workspace change target is missing: ${normalized}`);
  if (!stat) return { path: normalized, resolved, exists: false, sha256: null, bytes: 0, mode: null };
  if (stat.size > MAX_PORTABLE_ENTRY_BYTES) throw new WorkspaceSnapshotError('file_too_large', `workspace change target is too large: ${normalized}`);
  const bytes = fs.readFileSync(resolved);
  if (containsSensitiveContent(bytes.toString('utf8'))) throw new WorkspaceSnapshotError('sensitive_content', `workspace change content guard rejected ${normalized}`);
  return { path: normalized, resolved, exists: true, sha256: sha256(bytes), bytes: bytes.length, mode: stat.mode & 0o777 };
}

function executeOperation(root, manifest, operation) {
  if (!operation || typeof operation !== 'object') {
    throw new WorkspaceSnapshotError('operation_invalid', 'snapshot query operation must be an object');
  }
  switch (operation.type) {
    case 'status': {
      const trackedEntries = nulList(runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no']));
      return {
        type: 'status',
        head: manifest.head,
        branch: manifest.branch,
        trackedDirtyEntries: trackedEntries.length,
        selectedUntrackedEntries: manifest.selectedUntracked.length,
        dirty: trackedEntries.length > 0 || manifest.selectedUntracked.length > 0,
      };
    }
    case 'diff': {
      const numeric = runGit(root, ['diff', '--numstat', '--no-ext-diff', 'HEAD', '--'], 8 * 1024 * 1024)
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => {
          const [additions, deletions, ...paths] = line.split('\t');
          return {
            additions: additions === '-' ? null : Number(additions),
            deletions: deletions === '-' ? null : Number(deletions),
            paths: paths.map(candidate => isSensitivePath(candidate) ? '[sensitive path omitted]' : candidate),
          };
        });
      const entries = runGit(root, ['diff', '--name-status', '--no-ext-diff', 'HEAD', '--'], 8 * 1024 * 1024)
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => {
          const [status, ...paths] = line.split('\t');
          return {
            status,
            paths: paths.map(candidate => isSensitivePath(candidate) ? '[sensitive path omitted]' : candidate),
          };
        });
      return {
        type: 'diff',
        summary: {
          files: numeric.length,
          additions: numeric.reduce((sum, item) => sum + (item.additions ?? 0), 0),
          deletions: numeric.reduce((sum, item) => sum + (item.deletions ?? 0), 0),
          binaryFiles: numeric.filter(item => item.additions === null || item.deletions === null).length,
        },
        numeric,
        entries,
        patchIncluded: false,
      };
    }
    case 'read_many': {
      if (!Array.isArray(operation.paths) || operation.paths.length < 1 || operation.paths.length > 20) {
        throw new WorkspaceSnapshotError('read_paths_invalid', 'read_many requires 1 to 20 paths');
      }
      const maxLinesEach = boundedInteger(operation.maxLinesEach, 250, 1, 1_000);
      const maxBytesEach = boundedInteger(operation.maxBytesEach, DEFAULT_MAX_READ_BYTES, 1, 16_777_216);
      const files = operation.paths.map(requested => {
        const normalized = assertSnapshotMember(root, manifest, requested);
        const file = readSafeText(root, normalized, maxBytesEach);
        const lines = file.text.split(/\r?\n/).slice(0, maxLinesEach);
        return {
          path: file.normalized,
          sha256: file.sha256,
          bytes: file.stat.size,
          truncated: lines.length < file.text.split(/\r?\n/).length,
          text: lines.join('\n'),
        };
      });
      return { type: 'read_many', files };
    }
    case 'search': {
      const query = String(operation.query ?? '');
      if (!query || query.length > 500) throw new WorkspaceSnapshotError('search_query_invalid', 'search query must contain 1 to 500 characters');
      const caseSensitive = operation.caseSensitive === true;
      const needle = caseSensitive ? query : query.toLowerCase();
      const maxResults = boundedInteger(operation.maxResults, DEFAULT_MAX_RESULTS, 1, 500);
      const maxFiles = boundedInteger(operation.maxFiles, DEFAULT_MAX_SEARCH_FILES, 1, 5_000);
      const maxBytes = boundedInteger(operation.maxBytes, DEFAULT_MAX_SEARCH_BYTES, 1, 16_777_216);
      const candidates = operationPaths(root, manifest, operation.path ?? '.').slice(0, maxFiles);
      const results = [];
      let inspectedBytes = 0;
      let sensitiveFilesSkipped = 0;
      for (const candidate of candidates) {
        if (results.length >= maxResults || inspectedBytes >= maxBytes) break;
        let file;
        try {
          file = readSafeText(root, candidate, Math.min(DEFAULT_MAX_READ_BYTES, maxBytes - inspectedBytes));
        } catch (error) {
          if (error instanceof WorkspaceSnapshotError && error.code === 'sensitive_content') sensitiveFilesSkipped += 1;
          continue;
        }
        inspectedBytes += file.stat.size;
        const lines = file.text.split(/\r?\n/);
        for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
          const haystack = caseSensitive ? lines[index] : lines[index].toLowerCase();
          const column = haystack.indexOf(needle);
          if (column >= 0) {
            results.push({ path: candidate, line: index + 1, column: column + 1, text: lines[index].slice(0, 500) });
          }
        }
      }
      return { type: 'search', results, inspectedFiles: candidates.length, inspectedBytes, sensitiveFilesSkipped };
    }
    case 'test_metadata': {
      const output = { type: 'test_metadata', packageJson: null, lockfiles: [] };
      if (fs.existsSync(path.join(root, 'package.json'))) {
        const packageFile = readSafeText(root, 'package.json');
        const parsed = JSON.parse(packageFile.text);
        output.packageJson = {
          packageManager: typeof parsed.packageManager === 'string' ? parsed.packageManager : null,
          engines: parsed.engines && typeof parsed.engines === 'object' ? parsed.engines : null,
          scripts: parsed.scripts && typeof parsed.scripts === 'object' ? Object.keys(parsed.scripts).sort() : [],
          sha256: packageFile.sha256,
        };
      }
      for (const name of ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
        if (!fs.existsSync(path.join(root, name))) continue;
        const file = safeExistingFile(root, name);
        output.lockfiles.push({ path: name, bytes: file.stat.size, sha256: sha256(fs.readFileSync(file.resolved)) });
      }
      return output;
    }
    default:
      throw new WorkspaceSnapshotError('operation_not_allowed', `snapshot operation is not allowlisted: ${String(operation.type)}`);
  }
}

export class WorkspaceSnapshotService {
  constructor(options = {}) {
    this.home = options.home ?? os.homedir();
    this.stateRoot = options.stateRoot ?? path.join(this.home, '.ai-control-center', 'workspace-snapshots');
    this.allowedRoots = canonicalAllowedRoots(options.allowedRoots);
    this.now = options.now ?? (() => new Date());
    ensureOwnerDirectory(this.stateRoot);
    ensureOwnerDirectory(path.join(this.stateRoot, 'snapshots'));
    ensureOwnerDirectory(path.join(this.stateRoot, 'cache'));
    ensureOwnerDirectory(path.join(this.stateRoot, 'cas'));
    ensureOwnerDirectory(path.join(this.stateRoot, 'bundles'));
    ensureOwnerDirectory(path.join(this.stateRoot, 'work'));
    this.changeTransactions = new WorkspaceChangeTransactionService({
      stateRoot: this.stateRoot,
      resolveSnapshot: (snapshotId, request = {}) => {
        const loaded = this.#loadSnapshot(snapshotId, request);
        return { manifest: loaded.manifest, root: loaded.canonicalRoot };
      },
      materialize: snapshotId => this.materialize({ snapshotId }),
      inspectTarget: (root, manifest, relativePath, request = {}) => mutableTargetState(root, manifest, relativePath, request),
      validateContent: (bytes, relativePath) => {
        if (isSensitivePath(relativePath)) throw new WorkspaceSnapshotError('sensitive_path', `workspace change is denied for ${relativePath}`);
        if (containsSensitiveContent(bytes.toString('utf8'))) throw new WorkspaceSnapshotError('sensitive_content', `workspace change content guard rejected ${relativePath}`);
      },
      now: this.now,
      pid: options.transactionPid,
      lockStaleMs: options.transactionLockStaleMs,
      isProcessAlive: options.transactionIsProcessAlive,
      verificationRunner: options.verificationRunner,
      crashPoint: options.transactionCrashPoint,
    });
  }

  begin({ root, toolSchemaHash, selectedUntrackedPaths = [] }) {
    const canonicalRoot = canonicalGitRoot(root, this.allowedRoots);
    const current = fingerprint(canonicalRoot, toolSchemaHash, selectedUntrackedPaths);
    const manifest = {
      schemaVersion: 1,
      snapshotId: current.snapshotId,
      workspaceId: `workspace_${current.workspaceRootHash.slice(0, 24)}`,
      root: canonicalRoot,
      head: current.head,
      branch: current.branch,
      trackedStatusHash: current.trackedStatusHash,
      dirtyOverlayHash: current.dirtyOverlayHash,
      selectedUntracked: current.selectedUntracked,
      policyHash: current.policyHash,
      toolSchemaHash: current.toolSchemaHash,
      createdAt: this.now().toISOString(),
      cacheScope: 'immutable-read-only',
      liveFactsCached: false,
    };
    const file = path.join(this.stateRoot, 'snapshots', `${manifest.snapshotId}.json`);
    const reused = fs.existsSync(file);
    if (!reused) writeOwnerJsonAtomic(file, manifest);
    return { manifest: reused ? readOwnerJson(file) : manifest, reused };
  }

  query({ snapshotId, operations }) {
    const { manifest, canonicalRoot } = this.#loadFreshSnapshot(snapshotId);
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_OPERATIONS) {
      throw new WorkspaceSnapshotError('operations_invalid', `snapshot query requires 1 to ${MAX_OPERATIONS} operations`);
    }
    const normalizedOperations = stable(operations);
    const queryHash = sha256(stableJson({ snapshotId, operations: normalizedOperations }));
    const cacheFile = path.join(this.stateRoot, 'cache', snapshotId, `${queryHash}.json`);
    if (fs.existsSync(cacheFile)) {
      const cached = readOwnerJson(cacheFile);
      return { ...cached, cacheHit: true };
    }
    const result = {
      schemaVersion: 1,
      snapshotId,
      workspaceId: manifest.workspaceId,
      cacheHit: false,
      results: operations.map(operation => executeOperation(canonicalRoot, manifest, operation)),
      generatedAt: this.now().toISOString(),
      liveFactsIncluded: false,
    };
    writeOwnerJsonAtomic(cacheFile, result);
    return result;
  }

  materialize({ snapshotId }) {
    const { manifest, canonicalRoot } = this.#loadFreshSnapshot(snapshotId);
    const casRoot = path.join(this.stateRoot, 'cas', snapshotId);
    if (fs.existsSync(casRoot)) return this.#verifiedMaterialization(casRoot, manifest);

    const lockFile = `${casRoot}.lock`;
    const descriptor = acquireLock(lockFile, 'materialization_busy');
    const workRoot = path.join(this.stateRoot, 'work');
    const temporary = fs.mkdtempSync(path.join(workRoot, `${snapshotId.slice(9, 21)}-`));
    fs.chmodSync(temporary, 0o700);
    const worktree = path.join(temporary, 'detached');
    const candidate = path.join(temporary, 'candidate');
    const candidateTree = path.join(candidate, 'tree');
    let worktreeAdded = false;
    try {
      runGit(canonicalRoot, ['worktree', 'add', '--detach', worktree, manifest.head]);
      worktreeAdded = true;
      const patchBytes = runGit(canonicalRoot, ['diff', '--binary', '--full-index', '--no-ext-diff', 'HEAD', '--']);
      if (patchBytes.length > 0) runGitInput(worktree, ['apply', '--binary', '--whitespace=nowarn', '-'], patchBytes);
      copySelectedUntracked(canonicalRoot, worktree, manifest.selectedUntracked);
      if (runGit(worktree, ['rev-parse', 'HEAD']).trim() !== manifest.head) {
        throw new WorkspaceSnapshotError('materialization_mismatch', 'detached materialization HEAD differs');
      }
      const appliedPatchHash = sha256(runGit(worktree, ['diff', '--binary', '--no-ext-diff', 'HEAD', '--']));
      if (appliedPatchHash !== manifest.dirtyOverlayHash) {
        throw new WorkspaceSnapshotError('materialization_mismatch', 'detached materialization tracked overlay differs');
      }
      fs.mkdirSync(candidate, { mode: 0o700 });
      copyTreeOwnerOnly(worktree, candidateTree);
      const files = portableTreeFiles(candidateTree);
      const materialization = {
        schemaVersion: 1,
        snapshotId,
        workspaceId: manifest.workspaceId,
        head: manifest.head,
        treeDigest: treeDigest(files),
        files: files.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: file.sha256, mode: file.mode })),
        createdAt: this.now().toISOString(),
        source: 'detached-git-worktree-plus-bounded-overlay',
      };
      writeOwnerJsonAtomic(path.join(candidate, 'materialization.json'), materialization);
      fs.renameSync(candidate, casRoot);
      return { ...materialization, root: path.join(casRoot, 'tree'), reused: false };
    } finally {
      const partialWorktree = fs.existsSync(path.join(worktree, '.git'));
      let worktreeRemoved = !worktreeAdded && !partialWorktree;
      if (worktreeAdded || partialWorktree) {
        try {
          runGit(canonicalRoot, ['worktree', 'remove', '--force', worktree]);
          worktreeRemoved = true;
        } catch {
          // Keep the exact owner-only worktree for later explicit reconciliation; never prune unrelated worktrees.
        }
      }
      if (worktreeRemoved) fs.rmSync(temporary, { recursive: true, force: true });
      fs.closeSync(descriptor);
      fs.rmSync(lockFile, { force: true });
    }
  }

  exportPortableBundle({ snapshotId }) {
    const { manifest } = this.#loadFreshSnapshot(snapshotId);
    const materialized = this.materialize({ snapshotId });
    const destination = path.join(this.stateRoot, 'bundles', `${snapshotId}.zip`);
    if (fs.existsSync(destination)) {
      const validated = validatePortableZip({ file: destination, expectedSnapshotId: snapshotId });
      return { ...validated, path: destination, reused: true };
    }
    const lockFile = `${destination}.lock`;
    const descriptor = acquireLock(lockFile, 'bundle_busy');
    try {
      if (fs.existsSync(destination)) {
        const validated = validatePortableZip({ file: destination, expectedSnapshotId: snapshotId });
        return { ...validated, path: destination, reused: true };
      }
      const files = portableTreeFiles(materialized.root);
      createPortableZip({
        destination,
        manifest: {
          snapshotId,
          workspaceId: manifest.workspaceId,
          head: manifest.head,
          branch: manifest.branch,
          dirtyOverlayHash: manifest.dirtyOverlayHash,
          selectedUntracked: manifest.selectedUntracked,
          policyHash: manifest.policyHash,
          toolSchemaHash: manifest.toolSchemaHash,
          createdAt: manifest.createdAt,
        },
        files,
      });
      const validated = validatePortableZip({ file: destination, expectedSnapshotId: snapshotId });
      return { ...validated, path: destination, reused: false };
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(lockFile, { force: true });
    }
  }

  validatePortableBundle({ file, expectedSnapshotId = null }) {
    return validatePortableZip({ file, expectedSnapshotId });
  }

  planChange(request) {
    return this.changeTransactions.plan(request);
  }

  applyVerifyChange(request) {
    return this.changeTransactions.applyVerify(request);
  }

  reconcileChange(request) {
    return this.changeTransactions.reconcile(request);
  }

  rollbackChange(request) {
    return this.changeTransactions.rollback(request);
  }

  changeStatus(request) {
    return this.changeTransactions.status(request);
  }

  #loadFreshSnapshot(snapshotId) {
    return this.#loadSnapshot(snapshotId, { allowChangedWorkspace: false });
  }

  #loadSnapshot(snapshotId, { allowChangedWorkspace = false } = {}) {
    if (!/^snapshot_[a-f0-9]{64}$/.test(snapshotId ?? '')) {
      throw new WorkspaceSnapshotError('snapshot_id_invalid', 'snapshotId is invalid');
    }
    const file = path.join(this.stateRoot, 'snapshots', `${snapshotId}.json`);
    if (!fs.existsSync(file)) throw new WorkspaceSnapshotError('snapshot_missing', 'workspace snapshot does not exist');
    const manifest = readOwnerJson(file);
    const canonicalRoot = canonicalGitRoot(manifest.root, this.allowedRoots);
    if (!allowChangedWorkspace) {
      const current = fingerprint(
        canonicalRoot,
        manifest.toolSchemaHash,
        manifest.selectedUntracked.map(item => item.path),
      );
      if (current.snapshotId !== manifest.snapshotId) {
        throw new WorkspaceSnapshotError('snapshot_stale', 'workspace state changed after the snapshot was created');
      }
    }
    return { manifest, canonicalRoot };
  }

  #verifiedMaterialization(casRoot, manifest) {
    assertOwnerDirectory(casRoot);
    const record = readOwnerJson(path.join(casRoot, 'materialization.json'));
    if (record.snapshotId !== manifest.snapshotId || record.head !== manifest.head) {
      throw new WorkspaceSnapshotError('materialization_mismatch', 'CAS identity differs from the current snapshot');
    }
    const treeRoot = path.join(casRoot, 'tree');
    assertOwnerDirectory(treeRoot);
    const files = portableTreeFiles(treeRoot);
    const compact = files.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: file.sha256, mode: file.mode }));
    if (record.treeDigest !== treeDigest(files) || stableJson(record.files) !== stableJson(compact)) {
      throw new WorkspaceSnapshotError('materialization_mismatch', 'CAS contents differ from the recorded tree digest');
    }
    return { ...record, root: treeRoot, reused: true };
  }
}
