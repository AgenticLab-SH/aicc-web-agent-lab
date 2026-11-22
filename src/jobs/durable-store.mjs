import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const JOB_STORE_SCHEMA_VERSION = 1;
const LOCK_WAIT_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

export class DurableStoreError extends Error {
  constructor(code, message) { super(message); this.name = 'DurableStoreError'; this.code = code; }
}

export function emptyJobState() {
  return {
    schemaVersion: JOB_STORE_SCHEMA_VERSION,
    sequence: 0,
    jobs: {},
    idempotency: {},
    workspaceLeases: {},
    artifacts: {},
    effects: {},
    orchestrationRuns: {},
    browserLeases: {},
    resourceLeases: {},
    remoteLeases: {},
    remoteReplay: {},
    migrations: [{ version: JOB_STORE_SCHEMA_VERSION, appliedAt: null }]
  };
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
}

export function durableStateHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableObject(value))).digest('hex');
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows ACL or unsupported mode */ }
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
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACL */ }
}

function migrateState(raw, at) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyJobState();
  const version = Number(raw.schemaVersion ?? 0);
  if (version > JOB_STORE_SCHEMA_VERSION) throw new DurableStoreError('schema_too_new', `job store schema ${version} is newer than ${JOB_STORE_SCHEMA_VERSION}`);
  if (version === JOB_STORE_SCHEMA_VERSION) {
    return {
      ...emptyJobState(),
      ...structuredClone(raw),
      schemaVersion: JOB_STORE_SCHEMA_VERSION,
      sequence: Number.isInteger(raw.sequence) && raw.sequence >= 0 ? raw.sequence : 0,
      jobs: raw.jobs && typeof raw.jobs === 'object' ? structuredClone(raw.jobs) : {},
      idempotency: raw.idempotency && typeof raw.idempotency === 'object' ? structuredClone(raw.idempotency) : {},
      workspaceLeases: raw.workspaceLeases && typeof raw.workspaceLeases === 'object' ? structuredClone(raw.workspaceLeases) : {},
      artifacts: raw.artifacts && typeof raw.artifacts === 'object' ? structuredClone(raw.artifacts) : {},
      effects: raw.effects && typeof raw.effects === 'object' ? structuredClone(raw.effects) : {},
      orchestrationRuns: raw.orchestrationRuns && typeof raw.orchestrationRuns === 'object' ? structuredClone(raw.orchestrationRuns) : {},
      browserLeases: raw.browserLeases && typeof raw.browserLeases === 'object' ? structuredClone(raw.browserLeases) : {},
      resourceLeases: raw.resourceLeases && typeof raw.resourceLeases === 'object' ? structuredClone(raw.resourceLeases) : {},
      remoteLeases: raw.remoteLeases && typeof raw.remoteLeases === 'object' ? structuredClone(raw.remoteLeases) : {},
      remoteReplay: raw.remoteReplay && typeof raw.remoteReplay === 'object' ? structuredClone(raw.remoteReplay) : {}
    };
  }
  return {
    ...emptyJobState(),
    jobs: raw.jobs && typeof raw.jobs === 'object' ? structuredClone(raw.jobs) : {},
    idempotency: raw.idempotency && typeof raw.idempotency === 'object' ? structuredClone(raw.idempotency) : {},
    migrations: [{ version: JOB_STORE_SCHEMA_VERSION, appliedAt: at }]
  };
}

function parseJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new DurableStoreError('state_invalid', `${path.basename(file)} is not valid JSON`);
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export class DurableJobStore {
  constructor({ root, now = () => Date.now(), pid = process.pid, lockStaleMs = 60_000, isProcessAlive = processIsAlive, crashAfterJournal = false, create = true, maxJournalRecords = 200, maxJournalBytes = 8 * 1024 * 1024, lockWaitMs = 2_000 } = {}) {
    if (!root || !path.isAbsolute(root)) throw new DurableStoreError('invalid_root', 'durable job store root must be absolute');
    if (!Number.isSafeInteger(maxJournalBytes) || maxJournalBytes < 1) throw new DurableStoreError('invalid_journal_limit', 'journal byte limit must be a positive safe integer');
    if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 5_000) throw new DurableStoreError('invalid_lock_wait', 'writer lock wait must be an integer between zero and 5000 ms');
    this.root = root;
    this.now = now;
    this.pid = pid;
    this.lockStaleMs = lockStaleMs;
    this.isProcessAlive = isProcessAlive;
    this.crashAfterJournal = crashAfterJournal;
    this.maxJournalRecords = maxJournalRecords;
    this.maxJournalBytes = maxJournalBytes;
    this.lockWaitMs = lockWaitMs;
    this.snapshotPath = path.join(root, 'state.json');
    this.journalPath = path.join(root, 'journal.jsonl');
    this.lockPath = path.join(root, 'writer.lock');
    this.backupRoot = path.join(root, 'backups');
    if (create) ensurePrivateDirectory(root);
  }

  #journalRecords() {
    let text;
    try { text = fs.readFileSync(this.journalPath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!text) return [];
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines.map((line, index) => {
      let record;
      try { record = JSON.parse(line); }
      catch { throw new DurableStoreError('journal_invalid', `journal line ${index + 1} is invalid`); }
      if (!Number.isInteger(record.sequence) || !record.state || record.hash !== durableStateHash(record.state)) {
        throw new DurableStoreError('journal_invalid', `journal line ${index + 1} failed integrity`);
      }
      return record;
    });
  }

  read() {
    const at = new Date(this.now()).toISOString();
    const rawSnapshot = parseJson(this.snapshotPath);
    let state = migrateState(rawSnapshot, at);
    let recoveredFromWal = false;
    let previousSequence = 0;
    for (const record of this.#journalRecords()) {
      if (record.sequence <= previousSequence) throw new DurableStoreError('journal_order_invalid', 'journal sequence is not strictly increasing');
      previousSequence = record.sequence;
      if (record.sequence > state.sequence) {
        state = migrateState(record.state, at);
        recoveredFromWal = true;
      }
    }
    return { state: structuredClone(state), recoveredFromWal };
  }

  #acquireLock() {
    const deadline = performance.now() + this.lockWaitMs;
    for (;;) {
      try { return this.#tryAcquireLock(); }
      catch (error) {
        // Only acquisition is retried, before mutate or WAL append can run.
        // A nested writer in this process cannot progress while we wait.
        if (error?.code !== 'writer_busy' || error.writerPid === this.pid) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw error;
        Atomics.wait(LOCK_WAIT_SIGNAL, 0, 0, Math.min(25, remaining));
      }
    }
  }

  #tryAcquireLock() {
    ensurePrivateDirectory(this.root);
    const tryOpen = () => {
      const descriptor = fs.openSync(this.lockPath, 'wx', 0o600);
      const payload = JSON.stringify({ pid: this.pid, createdAt: this.now() });
      fs.writeFileSync(descriptor, payload);
      fs.fsyncSync(descriptor);
      return descriptor;
    };
    try { return tryOpen(); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let lock;
      try { lock = parseJson(this.lockPath); }
      catch (parseError) {
        if (parseError.code !== 'state_invalid') throw parseError;
        // Another process may have created the file but not written its body.
        // Never remove an unreadable lock; it remains busy until our deadline.
        throw new DurableStoreError('writer_busy', 'durable job store writer lock is not yet readable');
      }
      const age = lock && Number.isFinite(lock.createdAt) ? this.now() - lock.createdAt : 0;
      if (!lock || age <= this.lockStaleMs || this.isProcessAlive(lock.pid)) {
        const busy = new DurableStoreError('writer_busy', 'durable job store already has a live writer');
        busy.writerPid = lock?.pid;
        throw busy;
      }
      try { fs.unlinkSync(this.lockPath); }
      catch { throw new DurableStoreError('writer_busy', 'stale writer lock could not be recovered'); }
      try { return tryOpen(); }
      catch { throw new DurableStoreError('writer_busy', 'durable job store writer raced during stale recovery'); }
    }
  }

  #appendWal(state, operation) {
    const record = {
      schemaVersion: JOB_STORE_SCHEMA_VERSION,
      sequence: state.sequence,
      at: new Date(this.now()).toISOString(),
      operation,
      hash: durableStateHash(state),
      state
    };
    ensurePrivateDirectory(this.root);
    const descriptor = fs.openSync(this.journalPath, 'a', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try { fs.chmodSync(this.journalPath, 0o600); } catch { /* Windows ACL */ }
  }

  #compactWal(state) {
    const records = this.#journalRecords();
    // Each WAL record contains the full state. A count-only limit allows large
    // stores to hold the writer lock while repeatedly hashing hundreds of MB.
    // A single current state may exceed the byte limit; preserve it intact.
    if (records.length <= this.maxJournalRecords && fs.statSync(this.journalPath).size <= this.maxJournalBytes) return false;
    const record = {
      schemaVersion: JOB_STORE_SCHEMA_VERSION,
      sequence: state.sequence,
      at: new Date(this.now()).toISOString(),
      operation: 'store.checkpoint',
      hash: durableStateHash(state),
      state
    };
    privateWriteAtomic(this.journalPath, `${JSON.stringify(record)}\n`);
    return true;
  }

  transaction(operation, mutate) {
    const descriptor = this.#acquireLock();
    try {
      const before = this.read().state;
      const next = structuredClone(before);
      const result = mutate(next);
      next.schemaVersion = JOB_STORE_SCHEMA_VERSION;
      next.sequence = before.sequence + 1;
      this.#appendWal(next, operation);
      if (this.crashAfterJournal) throw new DurableStoreError('injected_crash_after_wal', 'injected crash after durable WAL append');
      privateWriteAtomic(this.snapshotPath, `${JSON.stringify(next, null, 2)}\n`);
      this.#compactWal(next);
      return { result: structuredClone(result), state: structuredClone(next) };
    } finally {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
      try { fs.unlinkSync(this.lockPath); } catch { /* exact lock already released */ }
    }
  }

  integrity() {
    try {
      const { state, recoveredFromWal } = this.read();
      const files = [this.snapshotPath, this.journalPath].map(file => {
        try {
          const stat = fs.statSync(file);
          return { file: path.basename(file), exists: true, bytes: stat.size, ownerOnly: process.platform === 'win32' ? null : (stat.mode & 0o077) === 0 };
        } catch { return { file: path.basename(file), exists: false, bytes: 0, ownerOnly: null }; }
      });
      return {
        ok: files.every(file => file.ownerOnly !== false),
        schemaVersion: state.schemaVersion,
        sequence: state.sequence,
        recoveredFromWal,
        files
      };
    } catch (error) {
      return { ok: false, error: error.code ?? 'integrity_failed', detail: error.message };
    }
  }

  backup(label = new Date(this.now()).toISOString().replaceAll(':', '-')) {
    if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new DurableStoreError('invalid_backup_label', 'backup label is unsafe');
    const descriptor = this.#acquireLock();
    try {
      const directory = path.join(this.backupRoot, label);
      if (fs.existsSync(directory)) throw new DurableStoreError('backup_exists', 'backup label already exists');
      ensurePrivateDirectory(directory);
      const state = this.read().state;
      for (const [source, name] of [[this.snapshotPath, 'state.json'], [this.journalPath, 'journal.jsonl']]) {
        if (!fs.existsSync(source)) continue;
        fs.copyFileSync(source, path.join(directory, name), fs.constants.COPYFILE_EXCL);
        try { fs.chmodSync(path.join(directory, name), 0o600); } catch { /* Windows ACL */ }
      }
      const manifest = {
        schemaVersion: JOB_STORE_SCHEMA_VERSION,
        sequence: state.sequence,
        stateHash: durableStateHash(state),
        createdAt: new Date(this.now()).toISOString(),
        recoverable: true
      };
      privateWriteAtomic(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      return { directory, manifest };
    } finally {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
      try { fs.unlinkSync(this.lockPath); } catch { /* exact lock already released */ }
    }
  }

  retentionPlan({ keepBackups = 10 } = {}) {
    if (!Number.isInteger(keepBackups) || keepBackups < 1) throw new DurableStoreError('invalid_retention', 'at least one backup must be retained');
    let entries = [];
    try {
      entries = fs.readdirSync(this.backupRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
          const directory = path.join(this.backupRoot, entry.name);
          const manifest = parseJson(path.join(directory, 'manifest.json'));
          return { label: entry.name, directory, createdAt: manifest?.createdAt ?? null, stateHash: manifest?.stateHash ?? null };
        })
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || right.label.localeCompare(left.label));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return { keepBackups, retained: entries.slice(0, keepBackups), candidates: entries.slice(keepBackups), apply: false };
  }
}
