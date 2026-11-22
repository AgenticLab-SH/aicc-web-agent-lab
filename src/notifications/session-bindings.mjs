import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{5,159}$/;
const SAFE_PROJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{5,159}$/;

export class NotificationSessionBindingError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'NotificationSessionBindingError';
    this.code = code;
  }
}

function requireIdentifier(value, pattern, code) {
  const normalized = String(value ?? '').trim();
  if (!pattern.test(normalized)) throw new NotificationSessionBindingError(code);
  return normalized;
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function assertPrivateRegularFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new NotificationSessionBindingError('binding_path_unsafe');
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0) throw new NotificationSessionBindingError('binding_permissions_unsafe');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new NotificationSessionBindingError('binding_owner_unsafe');
    }
  }
  return stat;
}

function atomicPrivateJson(file, value) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

export function defaultNotificationSessionBindingPath(options = {}) {
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT ?? path.join(os.homedir(), '.ai-control-center');
  if (!path.isAbsolute(stateRoot)) throw new NotificationSessionBindingError('binding_state_root_invalid');
  return path.join(stateRoot, 'notifications', 'codex-session-bindings.json');
}

export class NotificationSessionBindingStore {
  constructor({ file, stateRoot, now = () => Date.now(), maxTtlMs = 24 * 60 * 60_000, lockStaleMs = 30_000, isProcessAlive = processIsAlive } = {}) {
    this.file = file ?? defaultNotificationSessionBindingPath({ stateRoot });
    if (!path.isAbsolute(this.file)) throw new NotificationSessionBindingError('binding_path_invalid');
    if (!Number.isInteger(maxTtlMs) || maxTtlMs < 60_000 || maxTtlMs > 7 * 24 * 60 * 60_000) {
      throw new NotificationSessionBindingError('binding_max_ttl_invalid');
    }
    this.now = now;
    this.maxTtlMs = maxTtlMs;
    this.lockStaleMs = lockStaleMs;
    this.isProcessAlive = isProcessAlive;
    this.lockFile = `${this.file}.lock`;
  }

  #read() {
    if (!assertPrivateRegularFile(this.file)) return { schemaVersion: SCHEMA_VERSION, bindings: {} };
    let document;
    try {
      document = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      throw new NotificationSessionBindingError('binding_document_invalid');
    }
    if (document?.schemaVersion !== SCHEMA_VERSION || !document.bindings || typeof document.bindings !== 'object' || Array.isArray(document.bindings)) {
      throw new NotificationSessionBindingError('binding_document_invalid');
    }
    return document;
  }

  #withLock(work) {
    ensurePrivateDirectory(path.dirname(this.file));
    const acquire = () => {
      const descriptor = fs.openSync(this.lockFile, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: this.now() }));
      fs.fsyncSync(descriptor);
      return descriptor;
    };
    let descriptor;
    try {
      descriptor = acquire();
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      assertPrivateRegularFile(this.lockFile);
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch { /* handled as busy */ }
      const age = Number.isFinite(owner?.createdAt) ? this.now() - owner.createdAt : 0;
      if (!owner || age <= this.lockStaleMs || this.isProcessAlive(owner.pid)) {
        throw new NotificationSessionBindingError('binding_writer_busy');
      }
      fs.unlinkSync(this.lockFile);
      try { descriptor = acquire(); }
      catch { throw new NotificationSessionBindingError('binding_writer_busy'); }
    }
    try {
      return work();
    } finally {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
      try { fs.unlinkSync(this.lockFile); } catch { /* exact lock already gone */ }
    }
  }

  bind({ sessionId, projectKey, taskId, expiresAt = null } = {}) {
    const session = requireIdentifier(sessionId, SAFE_SESSION_ID, 'binding_session_id_invalid');
    const project = requireIdentifier(projectKey, SAFE_PROJECT_KEY, 'binding_project_key_invalid');
    const task = requireIdentifier(taskId, SAFE_TASK_ID, 'binding_task_id_invalid');
    const now = this.now();
    const requestedExpiry = expiresAt == null ? now + this.maxTtlMs : Date.parse(expiresAt);
    if (!Number.isFinite(requestedExpiry) || requestedExpiry <= now) throw new NotificationSessionBindingError('binding_expiry_invalid');
    const expiry = Math.min(requestedExpiry, now + this.maxTtlMs);
    return this.#withLock(() => {
      const document = this.#read();
      for (const [key, binding] of Object.entries(document.bindings)) {
        if (!Number.isFinite(Date.parse(binding?.expiresAt)) || Date.parse(binding.expiresAt) <= now) delete document.bindings[key];
      }
      const existing = document.bindings[session];
      if (existing && (existing.projectKey !== project || existing.taskId !== task)) {
        throw new NotificationSessionBindingError('binding_scope_conflict');
      }
      document.bindings[session] = {
        projectKey: project,
        taskId: task,
        expiresAt: new Date(expiry).toISOString(),
        updatedAt: new Date(now).toISOString()
      };
      atomicPrivateJson(this.file, document);
      return Object.freeze({ ok: true, state: existing ? 'refreshed' : 'bound', sessionId: session, projectKey: project, taskId: task, expiresAt: document.bindings[session].expiresAt });
    });
  }

  unbindScope({ projectKey, taskId } = {}) {
    const project = requireIdentifier(projectKey, SAFE_PROJECT_KEY, 'binding_project_key_invalid');
    const task = requireIdentifier(taskId, SAFE_TASK_ID, 'binding_task_id_invalid');
    return this.#withLock(() => {
      const document = this.#read();
      const removed = [];
      for (const [sessionId, binding] of Object.entries(document.bindings)) {
        if (binding?.projectKey === project && binding?.taskId === task) {
          delete document.bindings[sessionId];
          removed.push(sessionId);
        }
      }
      if (removed.length) atomicPrivateJson(this.file, document);
      return Object.freeze({ ok: true, removed: removed.length });
    });
  }

  pruneExpired() {
    const now = this.now();
    return this.#withLock(() => {
      const document = this.#read();
      let removed = 0;
      for (const [sessionId, binding] of Object.entries(document.bindings)) {
        if (!Number.isFinite(Date.parse(binding?.expiresAt)) || Date.parse(binding.expiresAt) <= now) {
          delete document.bindings[sessionId];
          removed += 1;
        }
      }
      if (removed) atomicPrivateJson(this.file, document);
      return Object.freeze({ ok: true, removed });
    });
  }
}
