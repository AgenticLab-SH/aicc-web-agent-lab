import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_TYPES = new Set([
  'invocation',
  'parse_failure',
  'parsed',
  'gate_sample',
  'inspection',
  'backup',
  'dispatch_reserved',
  'dispatch_ack',
  'post_read',
  'request_phase',
  'reconcile_required',
  'reconcile',
  'rollback',
  'stop_requested',
  'terminal'
]);
const SENSITIVE_KEY = /(prompt|token|cookie|authorization|auth_?header|credential|secret|conversation|browser_?profile|raw_?(payload|body|frame|log|stderr|stdout)|attachment_?content|session_?body)/i;
const SAFE_SENSITIVE_HASH_KEYS = new Set(['processStartTokenHash']);

export class AttemptJournalError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'AttemptJournalError';
    this.code = code;
    this.detail = detail;
  }
}

export function attemptDisposition(state) {
  const events = Array.isArray(state?.events) ? state.events : [];
  if (state?.terminal) return { state: 'terminal', terminal: state.terminal };
  if (events.some(event => ['dispatch_reserved', 'dispatch_ack', 'post_read', 'reconcile_required', 'reconcile', 'rollback'].includes(event.type))) {
    return { state: 'reconcile_required', terminal: null };
  }
  return { state: events.length === 0 ? 'fresh' : 'pre_dispatch_started', terminal: null };
}

function requireSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new AttemptJournalError('invalid_identity', `${label} is invalid`);
  }
  return value;
}

function stableValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AttemptJournalError('metadata_invalid', 'metadata numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    throw new AttemptJournalError('raw_bytes_denied', 'raw bytes are not allowed in the attempt journal');
  }
  if (typeof value !== 'object') throw new AttemptJournalError('metadata_invalid', 'metadata must be JSON-compatible');
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (SENSITIVE_KEY.test(key) && !SAFE_SENSITIVE_HASH_KEYS.has(key)) {
      throw new AttemptJournalError('sensitive_field_denied', `sensitive metadata field denied: ${key}`);
    }
    if (SAFE_SENSITIVE_HASH_KEYS.has(key) && !/^[a-f0-9]{64}$/.test(value[key])) {
      throw new AttemptJournalError('sensitive_hash_invalid', `${key} must be a SHA-256 digest`);
    }
    if (value[key] === undefined) continue;
    output[key] = stableValue(value[key]);
  }
  return output;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function fsyncDirectory(directory) {
  // Windows does not support fsync on directory handles (it raises EPERM),
  // while regular files can still be flushed below.  Keep the directory
  // durability barrier on POSIX and treat the unsupported Windows primitive
  // as a no-op rather than turning every append into a false failure.
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function ensureOwnerDirectory(directory) {
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new AttemptJournalError('journal_root_invalid', `${directory} must be a real directory`);
    }
  } else {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(directory, 0o700);
}

function readEvent(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new AttemptJournalError('event_file_invalid', `${file} must be a regular file`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeCreateOnce(file, value) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(file, 0o600);
  fsyncDirectory(path.dirname(file));
}

export class DurableAttemptJournal {
  constructor({ root, operationId, attemptId, writerIdentity, now = () => new Date().toISOString() } = {}) {
    if (!root || !path.isAbsolute(root)) throw new AttemptJournalError('journal_root_required', 'an absolute journal root is required');
    this.root = path.resolve(root);
    this.operationId = requireSafeId(operationId, 'operation ID');
    this.attemptId = requireSafeId(attemptId, 'attempt ID');
    this.writerIdentity = stableValue(writerIdentity ?? {});
    if (!this.writerIdentity.processStartTokenHash || !/^[a-f0-9]{64}$/.test(this.writerIdentity.processStartTokenHash)) {
      throw new AttemptJournalError('writer_identity_required', 'writer identity requires a hashed process-start token');
    }
    this.now = now;
    this.attemptRoot = path.join(this.root, 'operations', this.operationId, 'attempts', this.attemptId);
    this.eventsRoot = path.join(this.attemptRoot, 'events');
    this.lockFile = path.join(this.attemptRoot, 'append.lock');
  }

  inspect() {
    if (!fs.existsSync(this.eventsRoot)) {
      return { schemaVersion: 2, operationId: this.operationId, attemptId: this.attemptId, events: [], terminal: null, chainHead: null };
    }
    const names = fs.readdirSync(this.eventsRoot).filter(name => /^\d{8}\.json$/.test(name)).sort();
    const events = [];
    let previousHash = null;
    for (let index = 0; index < names.length; index += 1) {
      const event = readEvent(path.join(this.eventsRoot, names[index]));
      const sequence = index + 1;
      if (event.schemaVersion !== 2 || event.operationId !== this.operationId || event.attemptId !== this.attemptId || event.sequence !== sequence) {
        throw new AttemptJournalError('event_sequence_invalid', `attempt event ${names[index]} has invalid identity or sequence`);
      }
      if (event.previousHash !== previousHash) throw new AttemptJournalError('event_chain_invalid', `attempt event ${names[index]} has an invalid previous hash`);
      const { eventHash, ...body } = event;
      if (eventHash !== digest(body)) throw new AttemptJournalError('event_hash_invalid', `attempt event ${names[index]} hash mismatch`);
      events.push(event);
      previousHash = eventHash;
    }
    const terminal = events.at(-1)?.type === 'terminal' ? events.at(-1).metadata?.terminal ?? null : null;
    return { schemaVersion: 2, operationId: this.operationId, attemptId: this.attemptId, events, terminal, chainHead: previousHash };
  }

  append(type, metadata = {}) {
    if (!EVENT_TYPES.has(type)) throw new AttemptJournalError('event_type_invalid', `unsupported attempt event: ${type}`);
    ensureOwnerDirectory(this.eventsRoot);
    let lockDescriptor;
    try {
      lockDescriptor = fs.openSync(this.lockFile, 'wx', 0o600);
      fs.writeFileSync(lockDescriptor, `${JSON.stringify({ schemaVersion: 1, writer: this.writerIdentity, acquiredAt: this.now() })}\n`);
      fs.fsyncSync(lockDescriptor);
      const current = this.inspect();
      if (current.terminal) throw new AttemptJournalError('attempt_terminal', `attempt is already terminal: ${current.terminal}`);
      const body = {
        schemaVersion: 2,
        operationId: this.operationId,
        attemptId: this.attemptId,
        sequence: current.events.length + 1,
        type,
        at: this.now(),
        writer: this.writerIdentity,
        previousHash: current.chainHead,
        metadata: stableValue(metadata)
      };
      const event = { ...body, eventHash: digest(body) };
      writeCreateOnce(path.join(this.eventsRoot, `${String(body.sequence).padStart(8, '0')}.json`), event);
      return event;
    } catch (error) {
      if (error?.code === 'EEXIST') throw new AttemptJournalError('attempt_writer_conflict', 'attempt append lock already exists; reconcile before continuing');
      throw error;
    } finally {
      if (lockDescriptor !== undefined) {
        fs.closeSync(lockDescriptor);
        try { fs.unlinkSync(this.lockFile); fsyncDirectory(this.attemptRoot); } catch { /* a crash marker may require reconciliation */ }
      }
    }
  }
}

export function processStartTokenHash({ pid, startedAt, executableHash = null } = {}) {
  if (!Number.isInteger(pid) || typeof startedAt !== 'string') {
    throw new AttemptJournalError('process_identity_invalid', 'pid and startedAt are required');
  }
  return crypto.createHash('sha256').update(stableJson({ pid, startedAt, executableHash })).digest('hex');
}
