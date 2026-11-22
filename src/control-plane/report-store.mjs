import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONTROL_REPORT_SCHEMA_VERSION = 1;
export const CONTROL_REPORT_STATUSES = Object.freeze([
  'PROGRESS',
  'DONE',
  'HOLD',
  'APPROVAL_REQUIRED',
  'DRIFT'
]);

const STATUS_SET = new Set(CONTROL_REPORT_STATUSES);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SECRET_ASSIGNMENT = /(?:authorization|cookie|password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/i;

export class ControlReportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ControlReportError';
    this.code = code;
  }
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
}

export function controlReportHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableObject(value))).digest('hex');
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlReportError(`invalid_${label}`, `${label} must be an object`);
  }
  const extras = Object.keys(value).filter(key => !allowed.has(key));
  if (extras.length > 0) throw new ControlReportError(`unknown_${label}_field`, `${label} contains unknown fields`);
}

function safeId(value, label) {
  const normalized = String(value ?? '').trim();
  if (!SAFE_ID.test(normalized)) throw new ControlReportError(`invalid_${label}`, `${label} is invalid`);
  return normalized;
}

function boundedText(value, label, maximum, { optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ControlReportError(`invalid_${label}`, `${label} is invalid`);
  }
  if (SECRET_ASSIGNMENT.test(normalized) || /\bbearer\s+[A-Za-z0-9._~-]{8,}/i.test(normalized)) {
    throw new ControlReportError('secret_like_content_rejected', `${label} contains secret-like content`);
  }
  return normalized;
}

function normalizeEvidence(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new ControlReportError('invalid_evidence', 'evidence must contain at most eight entries');
  }
  return value.map((entry, index) => {
    assertExactKeys(entry, new Set(['type', 'ref', 'sha256']), `evidence_${index}`);
    const sha256 = entry.sha256 === undefined || entry.sha256 === null
      ? null
      : String(entry.sha256).trim().toLowerCase();
    if (sha256 !== null && !SHA256.test(sha256)) {
      throw new ControlReportError('invalid_evidence_sha256', 'evidence sha256 must be exact');
    }
    const normalized = {
      type: safeId(entry.type, 'evidence_type'),
      ref: boundedText(entry.ref, 'evidence_ref', 260)
    };
    if (sha256 !== null) normalized.sha256 = sha256;
    return normalized;
  });
}

// Omit absent fields: legacy v1 journal/report hashes must remain byte compatible.
function reportDetails(input) {
  const details = {};
  for (const key of ['completed', 'remaining', 'choices']) {
    if (input[key] === undefined) continue;
    if (!Array.isArray(input[key]) || input[key].length > 6 || input[key].some(value => typeof value !== 'string')) {
      throw new ControlReportError(`invalid_${key}`, `${key} must contain at most six short strings`);
    }
    details[key] = input[key].map(value => boundedText(value, key, 240));
  }
  if (input.nextAction !== undefined) {
    if (typeof input.nextAction !== 'string') throw new ControlReportError('invalid_next_action', 'nextAction must be a short string');
    details.nextAction = boundedText(input.nextAction, 'next_action', 160);
  }
  return details;
}

export function normalizeControlReport(input) {
  assertExactKeys(input, new Set([
    'schemaVersion', 'controlPlaneId', 'workerId', 'workerSequence', 'status',
    'revision', 'summary', 'nextGate', 'evidence', 'completed', 'remaining', 'choices', 'nextAction'
  ]), 'report');
  if (input.schemaVersion !== CONTROL_REPORT_SCHEMA_VERSION) {
    throw new ControlReportError('unsupported_report_schema', 'report schemaVersion is unsupported');
  }
  if (!Number.isInteger(input.workerSequence) || input.workerSequence < 1) {
    throw new ControlReportError('invalid_worker_sequence', 'workerSequence must be a positive integer');
  }
  const status = String(input.status ?? '').trim().toUpperCase();
  if (!STATUS_SET.has(status)) throw new ControlReportError('invalid_report_status', 'report status is invalid');
  const report = {
    schemaVersion: CONTROL_REPORT_SCHEMA_VERSION,
    controlPlaneId: safeId(input.controlPlaneId, 'control_plane_id'),
    workerId: safeId(input.workerId, 'worker_id'),
    workerSequence: input.workerSequence,
    status,
    revision: boundedText(input.revision, 'revision', 120),
    summary: boundedText(input.summary, 'summary', 240, { optional: true }),
    nextGate: boundedText(input.nextGate, 'next_gate', 160, { optional: true }),
    evidence: normalizeEvidence(input.evidence),
    ...reportDetails(input)
  };
  if (['HOLD', 'APPROVAL_REQUIRED', 'DRIFT'].includes(status) && !report.nextGate) {
    throw new ControlReportError('next_gate_required', `${status} requires nextGate`);
  }
  return Object.freeze(report);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ControlReportError('report_root_invalid', 'report root must be a real directory');
  }
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows ACL or unsupported mode */ }
}

function readRegularText(file, { missing = null } = {}) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ControlReportError('report_file_invalid', `${path.basename(file)} must be a regular file`);
    }
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return missing;
    throw error;
  }
}

function readJson(file, { missing = null } = {}) {
  const text = readRegularText(file, { missing: null });
  if (text === null) return missing;
  try { return JSON.parse(text); }
  catch { throw new ControlReportError('report_json_invalid', `${path.basename(file)} is not valid JSON`); }
}

function atomicWrite(file, text) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, text);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Windows ACL or unsupported mode */ }
  } catch (error) {
    try { fs.closeSync(descriptor); } catch { /* already closed */ }
    try { fs.unlinkSync(temporary); } catch { /* already moved */ }
    throw error;
  }
}

function semanticWorkers(workers) {
  return Object.fromEntries(Object.entries(workers).sort(([left], [right]) => left.localeCompare(right)).map(([id, worker]) => [id, {
    workerSequence: worker.workerSequence,
    status: worker.status,
    revision: worker.revision,
    summary: worker.summary,
    nextGate: worker.nextGate,
    ...reportDetails(worker),
    evidenceHash: worker.evidenceHash,
    reportHash: worker.reportHash
  }]));
}

function summarize(workers) {
  const counts = Object.fromEntries(CONTROL_REPORT_STATUSES.map(status => [status, 0]));
  for (const worker of Object.values(workers)) counts[worker.status] += 1;
  const attention = Object.values(workers)
    .filter(worker => ['HOLD', 'APPROVAL_REQUIRED', 'DRIFT'].includes(worker.status))
    .map(worker => worker.workerId)
    .sort();
  return { counts, attention };
}

function snapshotDigest(workers) {
  return controlReportHash({ schemaVersion: CONTROL_REPORT_SCHEMA_VERSION, workers: semanticWorkers(workers) });
}

function emptySnapshot(controlPlaneId) {
  const workers = {};
  const { counts, attention } = summarize(workers);
  return {
    schemaVersion: CONTROL_REPORT_SCHEMA_VERSION,
    controlPlaneId,
    sequence: 0,
    digest: snapshotDigest(workers),
    workers,
    counts,
    attention,
    updatedAt: null
  };
}

function validateSnapshot(snapshot, controlPlaneId) {
  if (!snapshot || snapshot.schemaVersion !== CONTROL_REPORT_SCHEMA_VERSION || snapshot.controlPlaneId !== controlPlaneId
    || !Number.isInteger(snapshot.sequence) || snapshot.sequence < 0 || !snapshot.workers || typeof snapshot.workers !== 'object') {
    throw new ControlReportError('snapshot_invalid', 'report snapshot failed schema or identity validation');
  }
  if (snapshot.digest !== snapshotDigest(snapshot.workers)) {
    throw new ControlReportError('snapshot_hash_invalid', 'report snapshot digest does not match');
  }
  return snapshot;
}

function applyReport(snapshot, report, at, globalSequence) {
  const reportHash = controlReportHash(report);
  const current = snapshot.workers[report.workerId] ?? null;
  if (current) {
    if (report.workerSequence < current.workerSequence) {
      throw new ControlReportError('stale_worker_sequence', 'worker report sequence is stale');
    }
    if (report.workerSequence === current.workerSequence) {
      if (reportHash === current.reportHash) return { snapshot, duplicate: true, changed: false, reportHash };
      throw new ControlReportError('worker_sequence_conflict', 'worker sequence belongs to different report content');
    }
  }
  const evidenceHash = controlReportHash(report.evidence);
  const workers = {
    ...snapshot.workers,
    [report.workerId]: {
      workerId: report.workerId,
      workerSequence: report.workerSequence,
      status: report.status,
      revision: report.revision,
      summary: report.summary,
      nextGate: report.nextGate,
      evidence: report.evidence,
      ...reportDetails(report),
      evidenceHash,
      reportHash,
      updatedAt: at
    }
  };
  const { counts, attention } = summarize(workers);
  return {
    duplicate: false,
    changed: true,
    reportHash,
    snapshot: {
      schemaVersion: CONTROL_REPORT_SCHEMA_VERSION,
      controlPlaneId: snapshot.controlPlaneId,
      sequence: globalSequence,
      digest: snapshotDigest(workers),
      workers,
      counts,
      attention,
      updatedAt: at
    }
  };
}

export function defaultControlReportRoot({ stateRoot } = {}) {
  const ownerRoot = path.resolve(stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center'));
  if (!path.isAbsolute(ownerRoot) || ownerRoot === path.parse(ownerRoot).root) {
    throw new ControlReportError('state_root_invalid', 'AICC state root must be a confined absolute path');
  }
  return path.join(ownerRoot, 'control-plane', 'reports-v1');
}

export class ControlReportStore {
  constructor({
    root,
    stateRoot,
    controlPlaneId = 'integrated-work-control',
    now = () => Date.now(),
    pid = process.pid,
    lockStaleMs = 30_000,
    isProcessAlive = processIsAlive,
    crashAfterJournal = false,
    maximumJournalBytes = 5 * 1024 * 1024
  } = {}) {
    this.root = path.resolve(root ?? defaultControlReportRoot({ stateRoot }));
    if (!path.isAbsolute(this.root) || this.root === path.parse(this.root).root) {
      throw new ControlReportError('report_root_invalid', 'report root must be a confined absolute path');
    }
    this.controlPlaneId = safeId(controlPlaneId, 'control_plane_id');
    this.now = now;
    this.pid = pid;
    this.lockStaleMs = lockStaleMs;
    this.isProcessAlive = isProcessAlive;
    this.crashAfterJournal = crashAfterJournal;
    this.maximumJournalBytes = maximumJournalBytes;
    this.snapshotFile = path.join(this.root, 'snapshot.json');
    this.journalFile = path.join(this.root, 'events.jsonl');
    this.lockFile = path.join(this.root, 'writer.lock');
  }

  #journalRecords() {
    const text = readRegularText(this.journalFile, { missing: '' });
    if (!text) return [];
    const lines = text.split('\n').filter(Boolean);
    let previousHash = null;
    let previousSequence = 0;
    return lines.map((line, index) => {
      let record;
      try { record = JSON.parse(line); }
      catch { throw new ControlReportError('journal_invalid', `journal line ${index + 1} is invalid JSON`); }
      const { eventHash, ...unsigned } = record;
      if (record.schemaVersion !== CONTROL_REPORT_SCHEMA_VERSION || record.controlPlaneId !== this.controlPlaneId
        || !Number.isInteger(record.sequence) || record.sequence !== previousSequence + 1
        || record.previousHash !== previousHash || eventHash !== controlReportHash(unsigned)) {
        throw new ControlReportError('journal_invalid', `journal line ${index + 1} failed integrity`);
      }
      normalizeControlReport(record.report);
      previousHash = eventHash;
      previousSequence = record.sequence;
      return record;
    });
  }

  #readUnlocked() {
    const raw = readJson(this.snapshotFile, { missing: emptySnapshot(this.controlPlaneId) });
    let snapshot = validateSnapshot(raw, this.controlPlaneId);
    let recoveredFromJournal = false;
    const records = this.#journalRecords();
    for (const record of records) {
      if (record.sequence <= snapshot.sequence) continue;
      const applied = applyReport(snapshot, normalizeControlReport(record.report), record.at, record.sequence);
      if (!applied.changed) throw new ControlReportError('journal_invalid', 'journal contains a duplicate sequence event');
      snapshot = applied.snapshot;
      if (snapshot.digest !== record.snapshotDigest) {
        throw new ControlReportError('journal_invalid', 'journal snapshot digest does not match replay');
      }
      recoveredFromJournal = true;
    }
    return { snapshot, records, recoveredFromJournal };
  }

  #acquireLock() {
    ensurePrivateDirectory(this.root);
    const open = () => {
      const descriptor = fs.openSync(this.lockFile, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: this.pid, createdAt: this.now() }));
      fs.fsyncSync(descriptor);
      return descriptor;
    };
    try { return open(); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lock = readJson(this.lockFile, { missing: null });
      const age = lock && Number.isFinite(lock.createdAt) ? this.now() - lock.createdAt : 0;
      if (!lock || age <= this.lockStaleMs || this.isProcessAlive(lock.pid)) {
        throw new ControlReportError('writer_busy', 'report store already has a live writer');
      }
      try { fs.unlinkSync(this.lockFile); }
      catch { throw new ControlReportError('writer_busy', 'stale report writer lock could not be recovered'); }
      try { return open(); }
      catch { throw new ControlReportError('writer_busy', 'report writer raced during stale recovery'); }
    }
  }

  #appendEvent(record) {
    ensurePrivateDirectory(this.root);
    let currentBytes = 0;
    try { currentBytes = fs.statSync(this.journalFile).size; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const line = `${JSON.stringify(record)}\n`;
    if (currentBytes + Buffer.byteLength(line) > this.maximumJournalBytes) {
      throw new ControlReportError('journal_limit_reached', 'report journal reached its bounded size limit');
    }
    const descriptor = fs.openSync(this.journalFile, 'a', 0o600);
    try {
      fs.writeFileSync(descriptor, line);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try { fs.chmodSync(this.journalFile, 0o600); } catch { /* Windows ACL or unsupported mode */ }
  }

  write(input) {
    const report = normalizeControlReport(input);
    if (report.controlPlaneId !== this.controlPlaneId) {
      throw new ControlReportError('control_plane_identity_mismatch', 'report belongs to a different control plane');
    }
    const descriptor = this.#acquireLock();
    try {
      const { snapshot, records } = this.#readUnlocked();
      const at = new Date(this.now()).toISOString();
      const applied = applyReport(snapshot, report, at, snapshot.sequence + 1);
      if (!applied.changed) {
        return {
          ok: true,
          changed: false,
          duplicate: true,
          workerId: report.workerId,
          workerSequence: report.workerSequence,
          sequence: snapshot.sequence,
          digest: snapshot.digest
        };
      }
      const unsigned = {
        schemaVersion: CONTROL_REPORT_SCHEMA_VERSION,
        controlPlaneId: this.controlPlaneId,
        sequence: applied.snapshot.sequence,
        previousHash: records.at(-1)?.eventHash ?? null,
        at,
        workerId: report.workerId,
        report,
        reportHash: applied.reportHash,
        snapshotDigest: applied.snapshot.digest
      };
      const record = { ...unsigned, eventHash: controlReportHash(unsigned) };
      this.#appendEvent(record);
      if (this.crashAfterJournal) {
        throw new ControlReportError('injected_crash_after_journal', 'injected crash after durable report append');
      }
      atomicWrite(this.snapshotFile, `${JSON.stringify(applied.snapshot, null, 2)}\n`);
      return {
        ok: true,
        changed: true,
        duplicate: false,
        workerId: report.workerId,
        workerSequence: report.workerSequence,
        status: report.status,
        sequence: applied.snapshot.sequence,
        digest: applied.snapshot.digest,
        attention: applied.snapshot.attention
      };
    } finally {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
      try { fs.unlinkSync(this.lockFile); } catch { /* exact lock already released */ }
    }
  }

  status() {
    const { snapshot, records, recoveredFromJournal } = this.#readUnlocked();
    return {
      ok: true,
      schemaVersion: CONTROL_REPORT_SCHEMA_VERSION,
      controlPlaneId: this.controlPlaneId,
      root: this.root,
      sequence: snapshot.sequence,
      digest: snapshot.digest,
      workers: snapshot.workers,
      counts: snapshot.counts,
      attention: snapshot.attention,
      updatedAt: snapshot.updatedAt,
      integrity: {
        ok: true,
        journalEvents: records.length,
        journalHead: records.at(-1)?.eventHash ?? null,
        recoveredFromJournal
      }
    };
  }

  digest({ since = null } = {}) {
    const status = this.status();
    if (since !== null && !SHA256.test(String(since).trim().toLowerCase())) {
      throw new ControlReportError('invalid_digest', 'since digest must be exact SHA-256');
    }
    const changed = since === null || String(since).trim().toLowerCase() !== status.digest;
    return {
      ok: true,
      changed,
      sequence: status.sequence,
      digest: status.digest,
      counts: status.counts,
      attention: status.attention,
      workers: changed ? Object.values(status.workers).map(worker => ({
        workerId: worker.workerId,
        workerSequence: worker.workerSequence,
        status: worker.status,
        revision: worker.revision,
        summary: worker.summary,
        nextGate: worker.nextGate,
        ...reportDetails(worker),
        evidenceHash: worker.evidenceHash,
        updatedAt: worker.updatedAt
      })).sort((left, right) => left.workerId.localeCompare(right.workerId)) : []
    };
  }
}
