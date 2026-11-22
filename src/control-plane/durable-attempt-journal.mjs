import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 4096;
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const HASH = /^[0-9a-f]{64}$/;
const PHASES = new Set([
  'invocation_received', 'parsed', 'parse_rejected', 'gate_sampled', 'inspected',
  'preimage_sealed', 'backup_sealed', 'commit_reserved', 'dispatch_started',
  'dispatch_acknowledged', 'postread_observed', 'verification_passed',
  'verification_failed', 'rollback_reserved', 'rollback_started',
  'rollback_verified', 'reconcile_started', 'terminal_pass', 'terminal_hold',
  'terminal_uncertain', 'terminal_reconcile_required',
]);
const TERMINAL = new Set(['parse_rejected', 'terminal_pass', 'terminal_hold',
  'terminal_uncertain', 'terminal_reconcile_required']);
const ALLOWED_FIELDS = new Set([
  'schemaVersion', 'operationId', 'attemptId', 'componentId', 'requestHash',
  'sequence', 'previousEventHash', 'phase', 'at', 'processStartToken',
  'executableHash', 'bundleHash', 'configHash', 'routeGeneration', 'code',
]);

export class DurableAttemptJournalError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'DurableAttemptJournalError';
    this.code = code;
  }
}

function stableJson(value) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

export function attemptEventHash(event) {
  return crypto.createHash('sha256').update(stableJson(event)).digest('hex');
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function regularNoLink(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new DurableAttemptJournalError('journal_storage_invalid');
  }
}

function validateShape(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
      || Object.keys(event).some(key => !ALLOWED_FIELDS.has(key))
      || event.schemaVersion !== 1
      || !safeId(event.operationId) || !safeId(event.attemptId) || !safeId(event.componentId)
      || !HASH.test(event.requestHash) || !Number.isInteger(event.sequence) || event.sequence < 1
      || !(event.previousEventHash === null || HASH.test(event.previousEventHash))
      || !PHASES.has(event.phase) || Number.isNaN(Date.parse(event.at))
      || !safeId(event.processStartToken)
      || !HASH.test(event.executableHash) || !HASH.test(event.bundleHash)
      || !HASH.test(event.configHash) || !safeId(event.routeGeneration)
      || !(event.code === undefined || safeId(event.code))) {
    throw new DurableAttemptJournalError('journal_event_invalid');
  }
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  regularNoLink(file);
  const stat = fs.statSync(file);
  if (stat.size > MAX_JOURNAL_BYTES) throw new DurableAttemptJournalError('journal_too_large');
  const text = fs.readFileSync(file, 'utf8');
  if (text && !text.endsWith('\n')) throw new DurableAttemptJournalError('journal_truncated');
  return text.trim() ? text.trimEnd().split('\n').map(line => JSON.parse(line)) : [];
}

function transitionAllowed(previous, next) {
  if (!previous) return next.phase === 'invocation_received';
  if (TERMINAL.has(previous.phase)) return false;
  if (previous.processStartToken !== next.processStartToken) {
    return previous.phase === 'dispatch_started' && next.phase === 'reconcile_started';
  }
  if (next.phase === 'terminal_uncertain' || next.phase === 'terminal_hold') return true;
  if (next.phase === 'terminal_reconcile_required') {
    return ['dispatch_started', 'dispatch_acknowledged', 'postread_observed',
      'reconcile_started'].includes(previous.phase);
  }
  const order = [
    'invocation_received', 'parsed', 'gate_sampled', 'inspected', 'preimage_sealed',
    'backup_sealed', 'commit_reserved', 'dispatch_started', 'dispatch_acknowledged',
    'postread_observed', 'verification_passed', 'terminal_pass',
  ];
  if (previous.phase === 'verification_failed') return next.phase === 'rollback_reserved';
  if (previous.phase === 'rollback_reserved') return next.phase === 'rollback_started';
  if (previous.phase === 'rollback_started') return next.phase === 'rollback_verified';
  if (previous.phase === 'rollback_verified') return next.phase === 'terminal_hold';
  if (previous.phase === 'reconcile_started') {
    return ['postread_observed', 'terminal_uncertain', 'terminal_reconcile_required'].includes(next.phase);
  }
  if (previous.phase === 'postread_observed' && next.phase === 'verification_failed') return true;
  return order.indexOf(next.phase) === order.indexOf(previous.phase) + 1;
}

export function stopDisposition(events) {
  const phases = events.map(event => event.phase);
  return phases.some(phase => ['dispatch_started', 'dispatch_acknowledged',
    'postread_observed', 'reconcile_started'].includes(phase))
    && !phases.some(phase => TERMINAL.has(phase))
    ? { safeToStop: false, state: 'reconcile_required' }
    : { safeToStop: true, state: 'stoppable' };
}

export class DurableAttemptJournal {
  constructor({ stateRoot }) {
    if (!path.isAbsolute(stateRoot) || path.resolve(stateRoot) === path.parse(path.resolve(stateRoot)).root) {
      throw new DurableAttemptJournalError('journal_root_invalid');
    }
    this.stateRoot = path.resolve(stateRoot);
  }

  fileFor(componentId, operationId, attemptId) {
    for (const value of [componentId, operationId, attemptId]) {
      if (!safeId(value)) throw new DurableAttemptJournalError('journal_identity_invalid');
    }
    return path.join(this.stateRoot, 'attempt-journal', componentId, operationId, `${attemptId}.jsonl`);
  }

  read(identity) {
    const events = readLines(this.fileFor(identity.componentId, identity.operationId, identity.attemptId));
    let previous = null;
    for (const event of events) {
      validateShape(event);
      if (!transitionAllowed(previous, event)
          || event.sequence !== (previous?.sequence ?? 0) + 1
          || event.previousEventHash !== (previous ? attemptEventHash(previous) : null)
          || ['operationId', 'attemptId', 'componentId', 'requestHash'].some(key =>
            previous && event[key] !== previous[key])) {
        throw new DurableAttemptJournalError('journal_chain_invalid');
      }
      previous = event;
    }
    return events;
  }

  append(event) {
    validateShape(event);
    const file = this.fileFor(event.componentId, event.operationId, event.attemptId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    let lockFd;
    try {
      lockFd = fs.openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') throw new DurableAttemptJournalError('journal_writer_conflict');
      throw error;
    }
    try {
      if (fs.existsSync(file)) regularNoLink(file);
      const existing = this.read(event);
      const previous = existing.at(-1) ?? null;
      if (!transitionAllowed(previous, event)
          || event.sequence !== (previous?.sequence ?? 0) + 1
          || event.previousEventHash !== (previous ? attemptEventHash(previous) : null)
          || ['operationId', 'attemptId', 'componentId', 'requestHash'].some(key =>
            previous && event[key] !== previous[key])) {
        throw new DurableAttemptJournalError('journal_transition_invalid');
      }
      const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
      const currentSize = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (bytes.length > MAX_EVENT_BYTES || currentSize + bytes.length > MAX_JOURNAL_BYTES) {
        throw new DurableAttemptJournalError('journal_too_large');
      }
      const fd = fs.openSync(file, 'a', 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try { fs.chmodSync(file, 0o600); } catch { /* Windows ACL is external */ }
      return { ok: true, eventHash: attemptEventHash(event), sequence: event.sequence, phase: event.phase };
    } finally {
      if (lockFd !== undefined) fs.closeSync(lockFd);
      try { fs.unlinkSync(lock); } catch { /* retain original result */ }
    }
  }
}
