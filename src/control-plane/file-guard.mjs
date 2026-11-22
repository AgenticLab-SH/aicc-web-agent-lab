import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class FileGuardError extends Error {
  constructor(code, message) { super(message); this.name = 'FileGuardError'; this.code = code; }
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function ensurePrivateDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows ACL */ }
}

function atomicJson(file, value) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function safeRequestId(value) {
  const id = String(value ?? '').trim();
  if (!REQUEST_ID.test(id)) throw new FileGuardError('invalid_request_id', 'file mutation requires a safe request id');
  return id;
}

function normalizeRelative(value) {
  const text = String(value ?? '').trim();
  if (!text || path.isAbsolute(text) || text.includes('\0')) throw new FileGuardError('invalid_file_target', 'file target must be relative to the guarded root');
  const normalized = path.normalize(text);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new FileGuardError('file_target_escape', 'file target escapes the guarded root');
  return normalized;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertNoLinks(root, relativePath, includeTarget = true) {
  const parts = relativePath.split(path.sep).filter(Boolean);
  let current = root;
  const limit = includeTarget ? parts.length : Math.max(0, parts.length - 1);
  for (let index = 0; index < limit; index += 1) {
    current = path.join(current, parts[index]);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new FileGuardError('linked_path_prohibited', `linked path is prohibited: ${parts.slice(0, index + 1).join('/')}`);
  }
}

export class FileGuard {
  constructor({ root, stateRoot, resourceLeases = null, now = () => Date.now() } = {}) {
    if (!root || !path.isAbsolute(root)) throw new FileGuardError('invalid_guard_root', 'guard root must be absolute');
    this.root = path.resolve(root);
    if (!fs.existsSync(this.root) || !fs.statSync(this.root).isDirectory()) throw new FileGuardError('invalid_guard_root', 'guard root must be an existing directory');
    this.realRoot = fs.realpathSync.native(this.root);
    const rootKey = sha256(Buffer.from(this.realRoot, 'utf8')).slice(0, 16);
    this.stateRoot = path.resolve(stateRoot ?? path.join(os.homedir(), '.ai-control-center', 'file-guard', rootKey));
    this.receiptsRoot = path.join(this.stateRoot, 'receipts');
    this.preimagesRoot = path.join(this.stateRoot, 'preimages');
    this.quarantineRoot = path.join(this.stateRoot, 'quarantine');
    this.resourceLeases = resourceLeases;
    this.now = now;
  }

  resolve(relativePath, { mustExist = false } = {}) {
    const relative = normalizeRelative(relativePath);
    const target = path.resolve(this.root, relative);
    if (!isInside(this.root, target)) throw new FileGuardError('file_target_escape', 'file target escapes the guarded root');
    assertNoLinks(this.root, relative, fs.existsSync(target));
    const parent = path.dirname(target);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new FileGuardError('file_parent_missing', 'file target parent must already exist');
    const realParent = fs.realpathSync.native(parent);
    if (!isInside(this.realRoot, realParent)) throw new FileGuardError('file_target_escape', 'file target parent resolves outside the guarded root');
    if (mustExist && !fs.existsSync(target)) throw new FileGuardError('file_target_missing', 'file target does not exist');
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new FileGuardError('unsupported_file_target', 'file mutation supports regular files only');
    }
    return { relative: relative.split(path.sep).join('/'), target };
  }

  #receiptPath(requestId) { return path.join(this.receiptsRoot, `${requestId}.json`); }

  #readReceipt(requestId) {
    const file = this.#receiptPath(safeRequestId(requestId));
    if (!fs.existsSync(file)) throw new FileGuardError('file_receipt_missing', `file mutation receipt not found: ${requestId}`);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new FileGuardError('file_receipt_invalid', `file mutation receipt is invalid: ${requestId}`); }
  }

  #stateArtifact(relativePath) {
    const relative = normalizeRelative(relativePath);
    const file = path.resolve(this.stateRoot, relative);
    if (!isInside(this.stateRoot, file)) throw new FileGuardError('file_state_escape', 'file guard state artifact escapes state root');
    if (!fs.existsSync(file)) throw new FileGuardError('file_state_artifact_missing', 'file guard recovery artifact is missing');
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new FileGuardError('file_state_artifact_invalid', 'file guard recovery artifact must be a regular file');
    return file;
  }

  #begin(requestId, operation, relative, ownerTaskId, ownerActorId) {
    const receiptPath = this.#receiptPath(requestId);
    if (fs.existsSync(receiptPath)) throw new FileGuardError('file_mutation_replay', `request id already has a receipt: ${requestId}`);
    let lease = null;
    if (this.resourceLeases) {
      lease = this.resourceLeases.acquire({
        resourceType: 'file-mutation', resourceId: `file:${sha256(Buffer.from(relative, 'utf8'))}`, ownerTaskId, ownerActorId, accessMode: 'write',
        recoveryRef: `file-guard:${requestId}`
      });
    }
    return { receiptPath, lease, operation };
  }

  #finish(context, ownerTaskId, ownerActorId, receipt) {
    atomicJson(context.receiptPath, receipt);
    if (context.lease) this.resourceLeases.release(context.lease.leaseId, { ownerTaskId, ownerActorId, reason: 'file-mutation-complete' });
    return { ok: true, duplicate: false, receipt };
  }

  #abort(context, ownerTaskId, ownerActorId) {
    if (!context?.lease) return;
    try { this.resourceLeases.release(context.lease.leaseId, { ownerTaskId, ownerActorId, reason: 'file-mutation-aborted' }); } catch { /* fail closed until expiry */ }
  }

  replace({ requestId, relativePath, content, expectedSha256 = null, ownerTaskId, ownerActorId } = {}) {
    const id = safeRequestId(requestId);
    const resolved = this.resolve(relativePath);
    const task = String(ownerTaskId ?? '').trim();
    const actor = String(ownerActorId ?? '').trim();
    if (!task || !actor) throw new FileGuardError('file_owner_required', 'file mutation requires task and actor ownership');
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
    const postSha256 = sha256(bytes);
    const exists = fs.existsSync(resolved.target);
    const preimage = exists ? fs.readFileSync(resolved.target) : null;
    const preSha256 = preimage ? sha256(preimage) : null;
    if (exists && !expectedSha256) throw new FileGuardError('expected_preimage_required', 'overwrite requires the expected preimage hash');
    if (expectedSha256 && (!SHA256.test(expectedSha256) || expectedSha256 !== preSha256)) throw new FileGuardError('preimage_mismatch', 'current file hash does not match the expected preimage');
    const context = this.#begin(id, 'replace', resolved.relative, task, actor);
    let backupPath = null;
    const temp = `${resolved.target}.aicc-${id}-${crypto.randomUUID()}.tmp`;
    try {
      if (preimage) {
        ensurePrivateDir(this.preimagesRoot);
        backupPath = path.join(this.preimagesRoot, `${id}.bin`);
        const fd = fs.openSync(backupPath, 'wx', 0o600);
        try { fs.writeFileSync(fd, preimage); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, resolved.target);
      const verified = sha256(fs.readFileSync(resolved.target));
      if (verified !== postSha256) throw new FileGuardError('post_read_mismatch', 'post-write hash verification failed');
      return this.#finish(context, task, actor, {
        schemaVersion: 1, requestId: id, operation: 'replace', relativePath: resolved.relative,
        ownerTaskId: task, ownerActorId: actor, at: new Date(this.now()).toISOString(),
        preimageExisted: Boolean(preimage), preSha256, postSha256, backupPath: backupPath ? path.relative(this.stateRoot, backupPath).split(path.sep).join('/') : null
      });
    } catch (error) {
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
      this.#abort(context, task, actor);
      throw error;
    }
  }

  quarantine({ requestId, relativePath, expectedSha256, ownerTaskId, ownerActorId } = {}) {
    const id = safeRequestId(requestId);
    const resolved = this.resolve(relativePath, { mustExist: true });
    const task = String(ownerTaskId ?? '').trim();
    const actor = String(ownerActorId ?? '').trim();
    if (!task || !actor) throw new FileGuardError('file_owner_required', 'file mutation requires task and actor ownership');
    const bytes = fs.readFileSync(resolved.target);
    const currentSha256 = sha256(bytes);
    if (!SHA256.test(String(expectedSha256 ?? '')) || expectedSha256 !== currentSha256) throw new FileGuardError('preimage_mismatch', 'quarantine requires the exact current file hash');
    const context = this.#begin(id, 'quarantine', resolved.relative, task, actor);
    ensurePrivateDir(this.quarantineRoot);
    const destination = path.join(this.quarantineRoot, `${id}-${path.basename(resolved.target)}`);
    try {
      if (fs.existsSync(destination)) throw new FileGuardError('quarantine_collision', 'quarantine destination already exists');
      fs.renameSync(resolved.target, destination);
      return this.#finish(context, task, actor, {
        schemaVersion: 1, requestId: id, operation: 'quarantine', relativePath: resolved.relative,
        ownerTaskId: task, ownerActorId: actor, at: new Date(this.now()).toISOString(),
        preSha256: currentSha256, quarantinePath: path.relative(this.stateRoot, destination).split(path.sep).join('/')
      });
    } catch (error) {

      this.#abort(context, task, actor);
      throw error;
    }
  }

  rollback({ requestId, originalRequestId, ownerTaskId, ownerActorId } = {}) {
    const id = safeRequestId(requestId);
    const originalId = safeRequestId(originalRequestId);
    const original = this.#readReceipt(originalId);
    if (!['replace', 'quarantine'].includes(original.operation) || !original.relativePath) {
      throw new FileGuardError('file_receipt_not_rollbackable', 'original receipt is not rollbackable');
    }
    const task = String(ownerTaskId ?? '').trim();
    const actor = String(ownerActorId ?? '').trim();
    if (!task || !actor) throw new FileGuardError('file_owner_required', 'file rollback requires task and actor ownership');

    const resolved = this.resolve(original.relativePath);
    const context = this.#begin(id, 'rollback', resolved.relative, task, actor);

    if (original.operation === 'replace') {
      if (!fs.existsSync(resolved.target)) {
        this.#abort(context, task, actor);
        throw new FileGuardError('rollback_target_missing', 'replacement target is missing');
      }
      const current = fs.readFileSync(resolved.target);
      if (sha256(current) !== original.postSha256) {
        this.#abort(context, task, actor);
        throw new FileGuardError('rollback_target_drift', 'replacement target changed after the original mutation');
      }

      let preimage = null;
      if (original.preimageExisted) {
        if (!original.backupPath) {
          this.#abort(context, task, actor);
          throw new FileGuardError('file_state_artifact_missing', 'original replace receipt has no preimage artifact');
        }
        const backup = this.#stateArtifact(original.backupPath);
        preimage = fs.readFileSync(backup);
        if (sha256(preimage) !== original.preSha256) {
          this.#abort(context, task, actor);
          throw new FileGuardError('file_state_artifact_drift', 'preimage artifact hash does not match the original receipt');
        }
      }

      ensurePrivateDir(this.quarantineRoot);
      const displaced = path.join(this.quarantineRoot, `${id}-rollback-current-${path.basename(resolved.target)}`);
      if (fs.existsSync(displaced)) {
        this.#abort(context, task, actor);
        throw new FileGuardError('quarantine_collision', 'rollback displacement artifact already exists');
      }

      let displacedWritten = false;
      try {
        fs.renameSync(resolved.target, displaced);
        displacedWritten = true;
        if (preimage) {
          const temp = `${resolved.target}.aicc-${id}-restore-${crypto.randomUUID()}.tmp`;
          const fd = fs.openSync(temp, 'wx', 0o600);
          try { fs.writeFileSync(fd, preimage); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          fs.renameSync(temp, resolved.target);
          if (sha256(fs.readFileSync(resolved.target)) !== original.preSha256) {
            throw new FileGuardError('rollback_post_read_mismatch', 'restored preimage failed post-read verification');
          }
        }
        return this.#finish(context, task, actor, {
          schemaVersion: 1,
          requestId: id,
          operation: 'rollback',
          originalRequestId: originalId,
          originalOperation: original.operation,
          relativePath: resolved.relative,
          ownerTaskId: task,
          ownerActorId: actor,
          at: new Date(this.now()).toISOString(),
          restoredSha256: original.preimageExisted ? original.preSha256 : null,
          targetPresent: original.preimageExisted === true,
          displacedPath: path.relative(this.stateRoot, displaced).split(path.sep).join('/')
        });
      } catch (error) {
        try {
          if (displacedWritten && !fs.existsSync(resolved.target) && fs.existsSync(displaced)) {
            fs.renameSync(displaced, resolved.target);
          }
        } catch {}
        this.#abort(context, task, actor);
        throw error;
      }
    }

    const artifact = this.#stateArtifact(original.quarantinePath);
    if (sha256(fs.readFileSync(artifact)) !== original.preSha256) {
      this.#abort(context, task, actor);
      throw new FileGuardError('file_state_artifact_drift', 'quarantined artifact hash does not match the original receipt');
    }
    if (fs.existsSync(resolved.target)) {
      this.#abort(context, task, actor);
      throw new FileGuardError('rollback_target_conflict', 'cannot restore quarantined file because the target path is occupied');
    }

    let restored = false;
    try {
      fs.renameSync(artifact, resolved.target);
      restored = true;
      if (sha256(fs.readFileSync(resolved.target)) !== original.preSha256) {
        throw new FileGuardError('rollback_post_read_mismatch', 'restored quarantined file failed post-read verification');
      }
      return this.#finish(context, task, actor, {
        schemaVersion: 1,
        requestId: id,
        operation: 'rollback',
        originalRequestId: originalId,
        originalOperation: original.operation,
        relativePath: resolved.relative,
        ownerTaskId: task,
        ownerActorId: actor,
        at: new Date(this.now()).toISOString(),
        restoredSha256: original.preSha256,
        targetPresent: true
      });
    } catch (error) {
      try {
        if (restored && fs.existsSync(resolved.target) && !fs.existsSync(artifact)) {
          fs.renameSync(resolved.target, artifact);
        }
      } catch {}
      this.#abort(context, task, actor);
      throw error;
    }
  }
}