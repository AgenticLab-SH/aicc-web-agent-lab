import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertSafeOwnerRoot, validateSourceRegistry } from './policy.mjs';

const PORTABLE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DECISIONS = new Set(['promote', 'reject', 'hold']);
const CATEGORIES = new Set(['environment', 'wiki', 'skill', 'mcp']);

export class KnowledgeStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KnowledgeStorageError';
    this.code = code;
  }
}

function requireId(value, label) {
  if (typeof value !== 'string' || !PORTABLE_ID.test(value)) throw new KnowledgeStorageError('invalid_id', `${label} is not portable`);
  return value;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new KnowledgeStorageError('symlink_denied', 'knowledge state directories may not be symlinks');
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows ACL or unsupported mode */ }
}

function assertContained(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === '.') return target;
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new KnowledgeStorageError('path_escape_denied', 'knowledge state path escaped its owner root');
  let current = root;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new KnowledgeStorageError('symlink_denied', 'knowledge state path traversed a symlink');
    if (!stat.isDirectory()) throw new KnowledgeStorageError('path_type_denied', 'knowledge state parent is not a directory');
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new KnowledgeStorageError('symlink_denied', 'knowledge state files may not be symlinks');
  return target;
}

function atomicWrite(root, file, bytes) {
  assertContained(root, file);
  ensurePrivateDirectory(path.dirname(file));
  assertContained(root, file);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACL or unsupported mode */ }
}

function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(root, file, fallback = null) {
  assertContained(root, file);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new KnowledgeStorageError('state_invalid', `${path.basename(file)} is not valid JSON`);
  }
}

export class KnowledgeReviewStore {
  constructor({ root, registry, now = () => Date.now(), create = true } = {}) {
    this.root = assertSafeOwnerRoot(root);
    this.registry = validateSourceRegistry(registry);
    this.now = now;
    this.paths = {
      sources: path.join(this.root, 'sources.json'),
      cursors: path.join(this.root, 'cursors'),
      objects: path.join(this.root, 'objects', 'sha256'),
      runs: path.join(this.root, 'runs'),
      requests: path.join(this.root, 'requests'),
      checkpoints: path.join(this.root, 'checkpoints'),
      candidates: path.join(this.root, 'candidates'),
      backups: path.join(this.root, 'backups'),
      ledger: path.join(this.root, 'ledger.jsonl')
    };
    if (create) this.initialize();
  }

  initialize() {
    if (fs.existsSync(this.root) && fs.lstatSync(this.root).isSymbolicLink()) throw new KnowledgeStorageError('symlink_denied', 'knowledge owner root may not be a symlink');
    ensurePrivateDirectory(this.root);
    for (const directory of [this.paths.cursors, this.paths.objects, this.paths.runs, this.paths.requests, this.paths.checkpoints, this.paths.candidates, this.paths.backups]) ensurePrivateDirectory(directory);
    if (!fs.existsSync(this.paths.sources)) atomicWrite(this.root, this.paths.sources, jsonBytes(this.registry));
    else {
      const stored = readJson(this.root, this.paths.sources);
      if (stored?.automaticApply !== false || stored?.manualOnly !== true) throw new KnowledgeStorageError('automatic_apply_prohibited', 'stored source policy is not manual-only');
      const previousBytes = jsonBytes(stored);
      const currentBytes = jsonBytes(this.registry);
      const previousDigest = sha256(previousBytes);
      const currentDigest = sha256(currentBytes);
      if (previousDigest !== currentDigest) {
        const backupId = `source-registry-${previousDigest.slice(0, 16)}`;
        const directory = path.join(this.paths.backups, backupId);
        if (!fs.existsSync(directory)) {
          ensurePrivateDirectory(directory);
          atomicWrite(this.root, path.join(directory, 'sources.json'), previousBytes);
          atomicWrite(this.root, path.join(directory, 'manifest.json'), jsonBytes({
            schemaVersion: 1,
            backupId,
            scope: 'knowledge-review-source-registry',
            previousSha256: previousDigest,
            replacementSha256: currentDigest,
            automaticRestore: false,
            createdAt: new Date(this.now()).toISOString()
          }));
        }
        atomicWrite(this.root, this.paths.sources, currentBytes);
      }
    }
    return this.describePaths();
  }

  describePaths() {
    return { root: this.root, ...structuredClone(this.paths) };
  }

  readCursor(sourceId) {
    const id = requireId(sourceId, 'source id');
    return readJson(this.root, path.join(this.paths.cursors, `${id}.json`), {
      schemaVersion: 1,
      sourceId: id,
      index: null,
      pages: {},
      lastCompletedAt: null,
      lastOutcome: 'never'
    });
  }

  writeCursor(sourceId, cursor) {
    const id = requireId(sourceId, 'source id');
    if (cursor?.sourceId !== id || cursor?.schemaVersion !== 1 || typeof cursor.pages !== 'object' || Array.isArray(cursor.pages)) {
      throw new KnowledgeStorageError('invalid_cursor', 'source cursor is invalid');
    }
    const file = path.join(this.paths.cursors, `${id}.json`);
    atomicWrite(this.root, file, jsonBytes(cursor));
    return { file, sha256: sha256(fs.readFileSync(file)) };
  }

  putObject(body) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const digest = sha256(bytes);
    const file = path.join(this.paths.objects, digest);
    assertContained(this.root, file);
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new KnowledgeStorageError('symlink_denied', 'content-addressed object target is unsafe');
      if (sha256(fs.readFileSync(file)) !== digest) throw new KnowledgeStorageError('object_hash_mismatch', 'existing content-addressed object is corrupt');
      return { digest, file, bytes: stat.size, duplicate: true };
    }
    atomicWrite(this.root, file, bytes);
    return { digest, file, bytes: bytes.length, duplicate: false };
  }

  writeCheckpoint(jobId, checkpoint) {
    const id = requireId(jobId, 'job id');
    const file = path.join(this.paths.checkpoints, `${id}.json`);
    const record = { ...structuredClone(checkpoint), schemaVersion: 1, jobId: id, updatedAt: new Date(this.now()).toISOString() };
    atomicWrite(this.root, file, jsonBytes(record));
    return { file, ref: `knowledge-review://checkpoints/${id}`, sha256: sha256(fs.readFileSync(file)), record };
  }

  writeRequest(requestHash, request) {
    if (!SHA256.test(requestHash ?? '')) throw new KnowledgeStorageError('invalid_digest', 'request hash is invalid');
    const file = path.join(this.paths.requests, `${requestHash}.json`);
    const record = { ...structuredClone(request), schemaVersion: 1, requestHash, manualOnly: true, automaticApply: false };
    if (fs.existsSync(file)) {
      const existing = readJson(this.root, file);
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw new KnowledgeStorageError('request_hash_conflict', 'request hash already refers to a different request');
      return { file, ref: `knowledge-review://requests/${requestHash}`, record, duplicate: true };
    }
    atomicWrite(this.root, file, jsonBytes(record));
    return { file, ref: `knowledge-review://requests/${requestHash}`, record, duplicate: false };
  }

  readRequest(requestHash) {
    if (!SHA256.test(requestHash ?? '')) throw new KnowledgeStorageError('invalid_digest', 'request hash is invalid');
    const record = readJson(this.root, path.join(this.paths.requests, `${requestHash}.json`), null);
    if (!record) throw new KnowledgeStorageError('request_not_found', 'knowledge review request does not exist');
    return record;
  }

  writeRunManifest(runId, manifest) {
    const id = requireId(runId, 'run id');
    const directory = path.join(this.paths.runs, id);
    ensurePrivateDirectory(directory);
    const file = path.join(directory, 'manifest.json');
    const record = { ...structuredClone(manifest), schemaVersion: 1, runId: id, automaticApply: false };
    atomicWrite(this.root, file, jsonBytes(record));
    return { file, ref: `knowledge-review://runs/${id}/manifest`, sha256: sha256(fs.readFileSync(file)), record };
  }

  listRunManifests() {
    if (!fs.existsSync(this.paths.runs)) return [];
    return fs.readdirSync(this.paths.runs, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && PORTABLE_ID.test(entry.name))
      .map(entry => readJson(this.root, path.join(this.paths.runs, entry.name, 'manifest.json'), null))
      .filter(Boolean)
      .sort((left, right) => String(right.finishedAt ?? '').localeCompare(String(left.finishedAt ?? '')));
  }

  backupCursorState(backupId) {
    const id = requireId(backupId, 'backup id');
    const directory = path.join(this.paths.backups, id);
    if (fs.existsSync(directory)) {
      const existing = readJson(this.root, path.join(directory, 'manifest.json'), null);
      if (!existing) throw new KnowledgeStorageError('backup_invalid', 'existing cursor backup has no manifest');
      return { directory, manifest: existing, duplicate: true };
    }
    const staging = `${directory}.tmp-${crypto.randomUUID()}`;
    ensurePrivateDirectory(staging);
    const cursorBackup = path.join(staging, 'cursors');
    ensurePrivateDirectory(cursorBackup);
    const entries = [];
    const copy = (source, target, logicalName) => {
      assertContained(this.root, source);
      if (!fs.existsSync(source)) return;
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new KnowledgeStorageError('symlink_denied', 'cursor backup source must be a regular file');
      const bytes = fs.readFileSync(source);
      atomicWrite(this.root, target, bytes);
      entries.push({ path: logicalName, sha256: sha256(bytes), bytes: bytes.length });
    };
    copy(this.paths.sources, path.join(staging, 'sources.json'), 'sources.json');
    for (const entry of fs.readdirSync(this.paths.cursors, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      copy(path.join(this.paths.cursors, entry.name), path.join(cursorBackup, entry.name), `cursors/${entry.name}`);
    }
    const manifest = {
      schemaVersion: 1,
      backupId: id,
      scope: 'knowledge-review-cursors',
      entries,
      immutableObjectsPreserved: true,
      appendOnlyLedgerPreserved: true,
      automaticRestore: false,
      createdAt: new Date(this.now()).toISOString()
    };
    atomicWrite(this.root, path.join(staging, 'manifest.json'), jsonBytes(manifest));
    fs.renameSync(staging, directory);
    return { directory, manifest, duplicate: false };
  }

  rollbackPlan(backupId) {
    const id = requireId(backupId, 'backup id');
    const directory = path.join(this.paths.backups, id);
    const manifest = readJson(this.root, path.join(directory, 'manifest.json'), null);
    if (!manifest || manifest.backupId !== id || manifest.automaticRestore !== false) throw new KnowledgeStorageError('backup_not_found', `unknown cursor backup: ${id}`);
    return {
      schemaVersion: 1,
      backupId: id,
      apply: false,
      requiresExplicitOwnerConfirmation: true,
      restoreEntries: structuredClone(manifest.entries),
      preserveImmutableObjects: true,
      preserveAppendOnlyLedger: true
    };
  }

  createCandidate(spec) {
    const category = String(spec?.category ?? '');
    if (!CATEGORIES.has(category)) throw new KnowledgeStorageError('invalid_candidate', 'candidate category must be environment, wiki, skill, or mcp');
    const candidateId = requireId(spec.candidateId ?? crypto.randomUUID(), 'candidate id');
    const record = {
      schemaVersion: 1,
      candidateId,
      category,
      title: String(spec.title ?? '').trim(),
      summary: String(spec.summary ?? '').trim(),
      sourceRefs: Array.isArray(spec.sourceRefs) ? [...new Set(spec.sourceRefs.map(String))] : [],
      impactFiles: Array.isArray(spec.impactFiles) ? [...new Set(spec.impactFiles.map(String))] : [],
      risk: String(spec.risk ?? '').trim(),
      validation: String(spec.validation ?? '').trim(),
      rollback: String(spec.rollback ?? '').trim(),
      status: 'candidate',
      automaticApply: false,
      createdAt: new Date(this.now()).toISOString()
    };
    if (!record.title || !record.summary || !record.sourceRefs.length) throw new KnowledgeStorageError('invalid_candidate', 'candidate title, summary, and source refs are required');
    const file = path.join(this.paths.candidates, `${candidateId}.json`);
    if (fs.existsSync(file)) throw new KnowledgeStorageError('candidate_exists', `candidate already exists: ${candidateId}`);
    atomicWrite(this.root, file, jsonBytes(record));
    return record;
  }

  listCandidates() {
    if (!fs.existsSync(this.paths.candidates)) return [];
    return fs.readdirSync(this.paths.candidates, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => readJson(this.root, path.join(this.paths.candidates, entry.name), null))
      .filter(Boolean)
      .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
  }

  appendDecision(spec) {
    const candidateId = requireId(spec?.candidateId, 'candidate id');
    const decision = String(spec?.decision ?? '');
    if (!DECISIONS.has(decision)) throw new KnowledgeStorageError('invalid_decision', 'decision must be promote, reject, or hold');
    const candidateFile = path.join(this.paths.candidates, `${candidateId}.json`);
    if (!readJson(this.root, candidateFile, null)) throw new KnowledgeStorageError('candidate_not_found', `unknown candidate: ${candidateId}`);
    const record = {
      schemaVersion: 1,
      eventId: requireId(spec.eventId ?? crypto.randomUUID(), 'event id'),
      candidateId,
      decision,
      reason: String(spec.reason ?? '').trim(),
      reviewedBy: String(spec.reviewedBy ?? '').trim(),
      evidenceRefs: Array.isArray(spec.evidenceRefs) ? [...new Set(spec.evidenceRefs.map(String))] : [],
      applied: false,
      automaticApply: false,
      decidedAt: new Date(this.now()).toISOString()
    };
    if (!record.reason || !record.reviewedBy) throw new KnowledgeStorageError('invalid_decision', 'decision reason and reviewer are required');
    assertContained(this.root, this.paths.ledger);
    if (fs.existsSync(this.paths.ledger) && fs.lstatSync(this.paths.ledger).isSymbolicLink()) throw new KnowledgeStorageError('symlink_denied', 'decision ledger may not be a symlink');
    const descriptor = fs.openSync(this.paths.ledger, 'a', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try { fs.chmodSync(this.paths.ledger, 0o600); } catch { /* Windows ACL or unsupported mode */ }
    return record;
  }

  readLedger() {
    assertContained(this.root, this.paths.ledger);
    try {
      return fs.readFileSync(this.paths.ledger, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new KnowledgeStorageError('ledger_invalid', 'decision ledger is invalid');
    }
  }
}

export function assertDigest(value) {
  if (!SHA256.test(value ?? '')) throw new KnowledgeStorageError('invalid_digest', 'sha256 digest is invalid');
  return value;
}
