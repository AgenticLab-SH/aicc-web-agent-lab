import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
const NON_TERMINAL = new Set(['PENDING_SYNC', 'SYNCING']);

export class ProjectPriorityOutboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProjectPriorityOutboxError';
    this.code = code;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, sequence: 0, confirmedSnapshot: null, operations: {}, idempotency: {} };
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ProjectPriorityOutboxError('state_symlink_denied', 'priority outbox directories must be real owner directories, not symlinks');
  }
  try { fs.chmodSync(directory, 0o700); } catch { /* ACL-only platform */ }
}

function privateWriteAtomic(file, bytes) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* ACL-only platform */ }
}

function parseJson(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ProjectPriorityOutboxError('state_symlink_denied', `${path.basename(file)} must be a regular owner file`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof ProjectPriorityOutboxError) throw error;
    throw new ProjectPriorityOutboxError('state_invalid', `${path.basename(file)} is not valid JSON`);
  }
}

function normalizeState(value) {
  if (value === null) return emptyState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectPriorityOutboxError('state_invalid', 'priority outbox state must be an object');
  if (Number(value.schemaVersion) > SCHEMA_VERSION) throw new ProjectPriorityOutboxError('schema_too_new', 'priority outbox schema is newer than this runtime');
  return {
    schemaVersion: SCHEMA_VERSION,
    sequence: Number.isInteger(value.sequence) && value.sequence >= 0 ? value.sequence : 0,
    confirmedSnapshot: value.confirmedSnapshot ? normalizeRemoteSnapshot(value.confirmedSnapshot) : null,
    operations: value.operations && typeof value.operations === 'object' && !Array.isArray(value.operations) ? structuredClone(value.operations) : {},
    idempotency: value.idempotency && typeof value.idempotency === 'object' && !Array.isArray(value.idempotency) ? structuredClone(value.idempotency) : {}
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function requiredText(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new ProjectPriorityOutboxError('invalid_operation', `${field} is required`);
  return normalized;
}

function requiredProjectId(value) {
  const id = requiredText(value, 'projectId');
  if (!PROJECT_ID.test(id)) throw new ProjectPriorityOutboxError('invalid_operation', 'projectId must be a stable lowercase slug');
  return id;
}

function priorityRank(snapshot, projectId) {
  return snapshot.priorities.find(item => item.projectId === projectId)?.rank ?? null;
}

export function normalizeRemoteSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new ProjectPriorityOutboxError('invalid_remote_snapshot', 'remote priority snapshot must be an object');
  }
  const remoteVersion = requiredText(snapshot.remoteVersion ?? snapshot.version, 'remoteVersion');
  const capturedAt = requiredText(snapshot.capturedAt, 'capturedAt');
  if (Number.isNaN(Date.parse(capturedAt))) throw new ProjectPriorityOutboxError('invalid_remote_snapshot', 'capturedAt must be an ISO timestamp');
  if (!Array.isArray(snapshot.priorities)) throw new ProjectPriorityOutboxError('invalid_remote_snapshot', 'priorities must be an array');
  const seen = new Set();
  const priorities = snapshot.priorities.map(item => {
    const projectId = requiredProjectId(item?.projectId);
    if (seen.has(projectId)) throw new ProjectPriorityOutboxError('invalid_remote_snapshot', `duplicate remote priority: ${projectId}`);
    seen.add(projectId);
    const rank = Number(item?.rank);
    if (!Number.isInteger(rank) || rank < 0) throw new ProjectPriorityOutboxError('invalid_remote_snapshot', 'remote priority rank must be a non-negative integer');
    return { projectId, rank };
  }).sort((left, right) => left.rank - right.rank || left.projectId.localeCompare(right.projectId));
  return { remoteVersion, capturedAt: new Date(capturedAt).toISOString(), priorities };
}

export class ProjectPriorityOutbox {
  constructor({
    root,
    now = () => Date.now(),
    pid = process.pid,
    isProcessAlive = processIsAlive,
    lockStaleMs = 60_000,
    create = true,
    crashAfterJournal = false
  } = {}) {
    if (!root || !path.isAbsolute(root)) throw new ProjectPriorityOutboxError('invalid_root', 'priority outbox root must be absolute');
    this.root = root;
    this.now = now;
    this.pid = pid;
    this.isProcessAlive = isProcessAlive;
    this.lockStaleMs = lockStaleMs;
    this.crashAfterJournal = crashAfterJournal;
    this.snapshotPath = path.join(root, 'state.json');
    this.journalPath = path.join(root, 'journal.jsonl');
    this.lockPath = path.join(root, 'writer.lock');
    this.backupRoot = path.join(root, 'backups');
    if (create) ensurePrivateDirectory(root);
  }

  #journalRecords() {
    let textValue;
    try {
      const stat = fs.lstatSync(this.journalPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ProjectPriorityOutboxError('state_symlink_denied', 'priority outbox journal must be a regular owner file');
      textValue = fs.readFileSync(this.journalPath, 'utf8');
    }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!textValue) return [];
    return textValue.trimEnd().split('\n').filter(Boolean).map((line, index) => {
      let record;
      try { record = JSON.parse(line); }
      catch { throw new ProjectPriorityOutboxError('journal_invalid', `priority outbox journal line ${index + 1} is invalid`); }
      if (!Number.isInteger(record.sequence) || !record.state || record.stateHash !== hash(record.state)) {
        throw new ProjectPriorityOutboxError('journal_invalid', `priority outbox journal line ${index + 1} failed integrity`);
      }
      return record;
    });
  }

  readState() {
    let state = normalizeState(parseJson(this.snapshotPath));
    let recoveredFromJournal = false;
    let previousSequence = 0;
    for (const record of this.#journalRecords()) {
      if (record.sequence <= previousSequence) throw new ProjectPriorityOutboxError('journal_order_invalid', 'priority outbox journal sequence is not increasing');
      previousSequence = record.sequence;
      if (record.sequence > state.sequence) {
        state = normalizeState(record.state);
        recoveredFromJournal = true;
      }
    }
    return { state: structuredClone(state), recoveredFromJournal };
  }

  #acquireLock() {
    ensurePrivateDirectory(this.root);
    const open = () => {
      const descriptor = fs.openSync(this.lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: this.pid, createdAt: this.now() }));
      fs.fsyncSync(descriptor);
      return descriptor;
    };
    try { return open(); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lock = parseJson(this.lockPath);
      const age = lock && Number.isFinite(lock.createdAt) ? this.now() - lock.createdAt : 0;
      if (!lock || age <= this.lockStaleMs || this.isProcessAlive(lock.pid)) {
        throw new ProjectPriorityOutboxError('writer_busy', 'priority outbox already has a live writer');
      }
      try { fs.unlinkSync(this.lockPath); }
      catch { throw new ProjectPriorityOutboxError('writer_busy', 'stale priority outbox lock could not be recovered'); }
      try { return open(); }
      catch { throw new ProjectPriorityOutboxError('writer_busy', 'priority outbox writer raced during lock recovery'); }
    }
  }

  #transaction(operationName, mutate) {
    const descriptor = this.#acquireLock();
    try {
      const before = this.readState().state;
      const next = structuredClone(before);
      const result = mutate(next);
      next.schemaVersion = SCHEMA_VERSION;
      next.sequence = before.sequence + 1;
      const record = {
        schemaVersion: SCHEMA_VERSION,
        sequence: next.sequence,
        operation: operationName,
        at: new Date(this.now()).toISOString(),
        stateHash: hash(next),
        state: next
      };
      ensurePrivateDirectory(this.root);
      const journal = fs.openSync(this.journalPath, 'a', 0o600);
      try {
        fs.writeFileSync(journal, `${JSON.stringify(record)}\n`);
        fs.fsyncSync(journal);
      } finally { fs.closeSync(journal); }
      if (this.crashAfterJournal) throw new ProjectPriorityOutboxError('injected_crash_after_journal', 'injected crash after priority effect reservation');
      privateWriteAtomic(this.snapshotPath, `${JSON.stringify(next, null, 2)}\n`);
      return { result: structuredClone(result), state: structuredClone(next) };
    } finally {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
      try { fs.unlinkSync(this.lockPath); } catch { /* exact lock already released */ }
    }
  }

  initialize(snapshot) {
    const normalized = normalizeRemoteSnapshot(snapshot);
    return this.#transaction('priority.snapshot.initialize', state => {
      if (state.confirmedSnapshot) {
        if (hash(state.confirmedSnapshot) === hash(normalized)) return { duplicate: true, snapshot: state.confirmedSnapshot };
        if (Object.values(state.operations).some(operation => NON_TERMINAL.has(operation.state))) {
          throw new ProjectPriorityOutboxError('pending_sync_exists', 'confirmed snapshot cannot be replaced while priority operations are pending');
        }
      }
      state.confirmedSnapshot = normalized;
      return { duplicate: false, snapshot: normalized };
    }).result;
  }

  enqueue({ operationId, idempotencyKey, projectId, desiredRank, expectedRemoteVersion, actor = 'owner' } = {}) {
    const normalizedOperationId = requiredText(operationId, 'operationId');
    const normalizedKey = requiredText(idempotencyKey, 'idempotencyKey');
    const normalizedProjectId = requiredProjectId(projectId);
    const normalizedExpectedVersion = requiredText(expectedRemoteVersion, 'expectedRemoteVersion');
    const rank = Number(desiredRank);
    if (!Number.isInteger(rank) || rank < 0) throw new ProjectPriorityOutboxError('invalid_operation', 'desiredRank must be a non-negative integer');
    const requestHash = hash({ projectId: normalizedProjectId, desiredRank: rank, expectedRemoteVersion: normalizedExpectedVersion });
    return this.#transaction('priority.operation.enqueue', state => {
      if (!state.confirmedSnapshot) throw new ProjectPriorityOutboxError('snapshot_required', 'a confirmed Notion priority snapshot is required before reordering');
      const existingId = state.idempotency[normalizedKey];
      if (existingId) {
        const existing = state.operations[existingId];
        if (!existing || existing.requestHash !== requestHash) throw new ProjectPriorityOutboxError('idempotency_conflict', 'idempotency key was reused with a different priority request');
        return { duplicate: true, operation: existing };
      }
      if (state.operations[normalizedOperationId]) throw new ProjectPriorityOutboxError('operation_exists', 'operationId already exists');
      const previousRank = priorityRank(state.confirmedSnapshot, normalizedProjectId);
      if (previousRank === null) throw new ProjectPriorityOutboxError('unknown_project', 'project is absent from the confirmed Notion priority snapshot');
      const at = new Date(this.now()).toISOString();
      const stale = state.confirmedSnapshot.remoteVersion !== normalizedExpectedVersion;
      const operation = {
        operationId: normalizedOperationId,
        idempotencyKey: normalizedKey,
        requestHash,
        projectId: normalizedProjectId,
        desiredRank: rank,
        previousRank,
        expectedRemoteVersion: normalizedExpectedVersion,
        actualRemoteVersion: stale ? state.confirmedSnapshot.remoteVersion : null,
        state: stale ? 'DRIFT' : 'PENDING_SYNC',
        actor: requiredText(actor, 'actor'),
        effect: {
          effectId: `project-priority:${normalizedOperationId}`,
          state: stale ? 'CANCELLED' : 'RESERVED',
          reservedAt: at,
          completedAt: stale ? at : null
        },
        rollbackSnapshot: structuredClone(state.confirmedSnapshot),
        attempts: [],
        resumeCount: 0,
        lastErrorCode: stale ? 'remote_version_conflict' : null,
        createdAt: at,
        updatedAt: at
      };
      state.operations[normalizedOperationId] = operation;
      state.idempotency[normalizedKey] = normalizedOperationId;
      return { duplicate: false, operation };
    }).result;
  }

  prepareSync(operationId, { remoteVersion, workerId } = {}) {
    const id = requiredText(operationId, 'operationId');
    const observedVersion = requiredText(remoteVersion, 'remoteVersion');
    const worker = requiredText(workerId, 'workerId');
    return this.#transaction('priority.operation.prepare-sync', state => {
      const operation = state.operations[id];
      if (!operation) throw new ProjectPriorityOutboxError('operation_not_found', 'priority operation was not found');
      if (operation.state === 'SYNCING') return { duplicate: true, operation, request: null };
      if (operation.state !== 'PENDING_SYNC') throw new ProjectPriorityOutboxError('operation_not_pending', `priority operation cannot sync from ${operation.state}`);
      const at = new Date(this.now()).toISOString();
      if (observedVersion !== operation.expectedRemoteVersion) {
        operation.state = 'DRIFT';
        operation.actualRemoteVersion = observedVersion;
        operation.lastErrorCode = 'remote_version_conflict';
        operation.effect.state = 'CANCELLED';
        operation.effect.completedAt = at;
        operation.updatedAt = at;
        return { duplicate: false, operation, request: null };
      }
      operation.state = 'SYNCING';
      operation.attempts.push({ workerId: worker, preparedAt: at, remoteVersion: observedVersion });
      operation.updatedAt = at;
      return {
        duplicate: false,
        operation,
        request: {
          operationId: operation.operationId,
          idempotencyKey: operation.idempotencyKey,
          projectId: operation.projectId,
          desiredRank: operation.desiredRank,
          expectedRemoteVersion: operation.expectedRemoteVersion
        }
      };
    }).result;
  }

  completeSync(operationId, remoteSnapshot) {
    const id = requiredText(operationId, 'operationId');
    const observed = normalizeRemoteSnapshot(remoteSnapshot);
    return this.#transaction('priority.operation.complete-sync', state => {
      const operation = state.operations[id];
      if (!operation) throw new ProjectPriorityOutboxError('operation_not_found', 'priority operation was not found');
      if (operation.state === 'APPLIED') return { duplicate: true, operation };
      if (operation.state !== 'SYNCING') throw new ProjectPriorityOutboxError('operation_not_syncing', `priority operation cannot complete from ${operation.state}`);
      const at = new Date(this.now()).toISOString();
      operation.actualRemoteVersion = observed.remoteVersion;
      if (priorityRank(observed, operation.projectId) !== operation.desiredRank) {
        operation.state = 'DRIFT';
        operation.lastErrorCode = 'remote_result_mismatch';
        operation.effect.state = 'CANCELLED';
        operation.effect.completedAt = at;
        operation.updatedAt = at;
        return { duplicate: false, operation };
      }
      operation.state = 'APPLIED';
      operation.effect.state = 'COMMITTED';
      operation.effect.completedAt = at;
      operation.updatedAt = at;
      state.confirmedSnapshot = observed;
      return { duplicate: false, operation };
    }).result;
  }

  recordFailure(operationId, errorCode) {
    const id = requiredText(operationId, 'operationId');
    const code = requiredText(errorCode, 'errorCode');
    return this.#transaction('priority.operation.failure', state => {
      const operation = state.operations[id];
      if (!operation) throw new ProjectPriorityOutboxError('operation_not_found', 'priority operation was not found');
      if (operation.state !== 'SYNCING') throw new ProjectPriorityOutboxError('operation_not_syncing', 'only a syncing priority operation can record a retryable failure');
      operation.state = 'PENDING_SYNC';
      operation.lastErrorCode = code;
      operation.updatedAt = new Date(this.now()).toISOString();
      return operation;
    }).result;
  }

  reconcileReserved(remoteSnapshot) {
    const observed = normalizeRemoteSnapshot(remoteSnapshot);
    return this.#transaction('priority.operation.reconcile-reserved', state => {
      const result = { applied: [], pending: [], drift: [] };
      for (const operation of Object.values(state.operations)) {
        if (!NON_TERMINAL.has(operation.state) || operation.effect?.state !== 'RESERVED') continue;
        const remoteRank = priorityRank(observed, operation.projectId);
        const rollbackRank = priorityRank(operation.rollbackSnapshot, operation.projectId);
        const at = new Date(this.now()).toISOString();
        operation.actualRemoteVersion = observed.remoteVersion;
        if (remoteRank === operation.desiredRank && observed.remoteVersion !== operation.expectedRemoteVersion) {
          operation.state = 'APPLIED';
          operation.effect.state = 'COMMITTED';
          operation.effect.completedAt = at;
          state.confirmedSnapshot = observed;
          result.applied.push(operation.operationId);
        } else if (observed.remoteVersion === operation.expectedRemoteVersion && remoteRank === rollbackRank) {
          operation.state = 'PENDING_SYNC';
          operation.resumeCount = Number(operation.resumeCount ?? 0) + 1;
          result.pending.push(operation.operationId);
        } else {
          operation.state = 'DRIFT';
          operation.lastErrorCode = 'reserved_effect_remote_drift';
          operation.effect.state = 'CANCELLED';
          operation.effect.completedAt = at;
          result.drift.push(operation.operationId);
        }
        operation.updatedAt = at;
      }
      return result;
    }).result;
  }

  rollback(operationId, { reason, actor } = {}) {
    const id = requiredText(operationId, 'operationId');
    const normalizedReason = requiredText(reason, 'reason');
    const normalizedActor = requiredText(actor, 'actor');
    return this.#transaction('priority.operation.rollback', state => {
      const operation = state.operations[id];
      if (!operation) throw new ProjectPriorityOutboxError('operation_not_found', 'priority operation was not found');
      if (operation.state === 'APPLIED') throw new ProjectPriorityOutboxError('remote_rollback_required', 'an applied Notion priority requires a new guarded remote operation');
      if (operation.state === 'ROLLED_BACK') return { duplicate: true, operation };
      const at = new Date(this.now()).toISOString();
      operation.state = 'ROLLED_BACK';
      operation.rollback = { reason: normalizedReason, actor: normalizedActor, at };
      operation.effect.state = 'CANCELLED';
      operation.effect.completedAt = at;
      operation.updatedAt = at;
      return { duplicate: false, operation };
    }).result;
  }

  get(operationId) {
    const operation = this.readState().state.operations[requiredText(operationId, 'operationId')];
    return operation ? structuredClone(operation) : null;
  }

  list() {
    return Object.values(this.readState().state.operations)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.operationId.localeCompare(right.operationId))
      .map(operation => structuredClone(operation));
  }

  status() {
    const { state, recoveredFromJournal } = this.readState();
    const operations = Object.values(state.operations);
    return {
      schemaVersion: SCHEMA_VERSION,
      sequence: state.sequence,
      remoteVersion: state.confirmedSnapshot?.remoteVersion ?? null,
      pendingSync: operations.filter(operation => operation.state === 'PENDING_SYNC').length,
      syncing: operations.filter(operation => operation.state === 'SYNCING').length,
      applied: operations.filter(operation => operation.state === 'APPLIED').length,
      drift: operations.filter(operation => operation.state === 'DRIFT').length,
      rolledBack: operations.filter(operation => operation.state === 'ROLLED_BACK').length,
      recoveredFromJournal
    };
  }

  backup(label) {
    const normalized = requiredText(label, 'backup label');
    if (!/^[A-Za-z0-9._-]+$/.test(normalized)) throw new ProjectPriorityOutboxError('invalid_backup_label', 'backup label contains unsafe characters');
    const descriptor = this.#acquireLock();
    try {
      const directory = path.join(this.backupRoot, normalized);
      if (fs.existsSync(directory)) throw new ProjectPriorityOutboxError('backup_exists', 'priority outbox backup already exists');
      ensurePrivateDirectory(directory);
      const state = this.readState().state;
      for (const [source, name] of [[this.snapshotPath, 'state.json'], [this.journalPath, 'journal.jsonl']]) {
        if (!fs.existsSync(source)) continue;
        fs.copyFileSync(source, path.join(directory, name), fs.constants.COPYFILE_EXCL);
        try { fs.chmodSync(path.join(directory, name), 0o600); } catch { /* ACL-only platform */ }
      }
      const manifest = { schemaVersion: SCHEMA_VERSION, sequence: state.sequence, stateHash: hash(state), createdAt: new Date(this.now()).toISOString(), recoverable: true };
      privateWriteAtomic(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      return { directory, manifest };
    } finally {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
      try { fs.unlinkSync(this.lockPath); } catch { /* exact lock already released */ }
    }
  }
}
