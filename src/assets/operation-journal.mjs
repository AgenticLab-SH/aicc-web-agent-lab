import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ACTIONS = new Set(['create', 'update', 'retire', 'delete']);
const RISK = { create: 'R2', update: 'R2', retire: 'R3', delete: 'R4' };

export class AssetOperationError extends Error {
  constructor(code, message) { super(message); this.name = 'AssetOperationError'; this.code = code; }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class AssetOperationJournal {
  constructor({ root, now = () => Date.now() } = {}) {
    if (!root || !path.isAbsolute(root)) throw new AssetOperationError('journal_root_required', 'an absolute owner journal root is required');
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'operations.json');
    this.now = now;
    this.confirmations = new Map();
  }

  #read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return { schemaVersion: 1, operations: [] }; throw error; }
  }

  #write(state) { atomicJson(this.file, state); }

  preview({ assetId, action, adapterId, expectedFingerprint, patch = {}, rollbackRef = null, actor = 'owner' } = {}) {
    if (!assetId || !adapterId || !ACTIONS.has(action) || !/^[a-f0-9]{64}$/.test(String(expectedFingerprint ?? ''))) {
      throw new AssetOperationError('operation_invalid', 'assetId, adapterId, action, and expectedFingerprint are required');
    }
    if (action === 'delete') throw new AssetOperationError('hard_delete_excluded', 'hard delete is excluded from normal asset synchronization');
    const body = { assetId, action, adapterId, expectedFingerprint, patch: structuredClone(patch), rollbackRef, actor, risk: RISK[action] };
    const operationId = `asset-op-${crypto.randomUUID()}`;
    const confirmationToken = `asset_confirm_${crypto.randomBytes(32).toString('hex')}`;
    this.confirmations.set(confirmationToken, { body, operationId, expiresAt: this.now() + 5 * 60_000 });
    return { schemaVersion: 1, operationId, confirmationToken, confirmationExpiresAt: new Date(this.now() + 5 * 60_000).toISOString(), operation: body, externalWritePerformed: false };
  }

  confirm(token) {
    const pending = this.confirmations.get(token);
    this.confirmations.delete(token);
    if (!pending) throw new AssetOperationError('confirmation_invalid', 'asset confirmation is unknown or consumed');
    if (pending.expiresAt <= this.now()) throw new AssetOperationError('confirmation_expired', 'asset confirmation expired');
    const state = this.#read();
    const idempotencyKey = hash(pending.body);
    const duplicate = state.operations.find(operation => operation.idempotencyKey === idempotencyKey && !['FAILED', 'UNKNOWN'].includes(operation.state));
    if (duplicate) return { duplicate: true, operation: duplicate, externalWritePerformed: false };
    const operation = {
      schemaVersion: 1,
      operationId: pending.operationId,
      idempotencyKey,
      ...pending.body,
      state: 'APPROVED',
      createdAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      attempt: 0,
      workerId: null,
      observedFingerprint: null,
      verifiedFingerprint: null,
      errorCode: null
    };
    state.operations.push(operation);
    this.#write(state);
    return { duplicate: false, operation, externalWritePerformed: false };
  }

  prepare(operationId, { workerId, observedFingerprint } = {}) {
    const state = this.#read();
    if (state.operations.some(operation => operation.state === 'APPLYING' && operation.operationId !== operationId)) throw new AssetOperationError('writer_busy', 'another asset operation owns the writer');
    const operation = state.operations.find(item => item.operationId === operationId);
    if (!operation) throw new AssetOperationError('operation_not_found', 'asset operation not found');
    if (operation.state !== 'APPROVED') throw new AssetOperationError('operation_not_ready', `asset operation is ${operation.state}`);
    if (!workerId || observedFingerprint !== operation.expectedFingerprint) throw new AssetOperationError('precondition_mismatch', 'current asset fingerprint differs from the approved plan');
    operation.state = 'APPLYING';
    operation.workerId = workerId;
    operation.observedFingerprint = observedFingerprint;
    operation.attempt += 1;
    operation.updatedAt = new Date(this.now()).toISOString();
    this.#write(state);
    return { operation, effect: { assetId: operation.assetId, action: operation.action, adapterId: operation.adapterId, patch: operation.patch }, externalWritePerformed: false };
  }

  complete(operationId, { workerId, verifiedFingerprint } = {}) {
    const state = this.#read();
    const operation = state.operations.find(item => item.operationId === operationId);
    if (!operation || operation.state !== 'APPLYING' || operation.workerId !== workerId) throw new AssetOperationError('operation_not_applying', 'asset operation writer binding is invalid');
    if (!/^[a-f0-9]{64}$/.test(String(verifiedFingerprint ?? ''))) throw new AssetOperationError('verification_required', 'a verified post-state fingerprint is required');
    operation.state = 'APPLIED';
    operation.verifiedFingerprint = verifiedFingerprint;
    operation.updatedAt = new Date(this.now()).toISOString();
    this.#write(state);
    return { operation, externalWritePerformed: false };
  }

  fail(operationId, { workerId, errorCode, effectMayHaveOccurred = true } = {}) {
    const state = this.#read();
    const operation = state.operations.find(item => item.operationId === operationId);
    if (!operation || operation.state !== 'APPLYING' || operation.workerId !== workerId) throw new AssetOperationError('operation_not_applying', 'asset operation writer binding is invalid');
    operation.state = effectMayHaveOccurred ? 'UNKNOWN' : 'FAILED';
    operation.errorCode = String(errorCode ?? 'adapter_failed');
    operation.updatedAt = new Date(this.now()).toISOString();
    this.#write(state);
    return { operation, externalWritePerformed: false };
  }

  status() {
    const state = this.#read();
    return {
      schemaVersion: 1,
      total: state.operations.length,
      activeWriters: state.operations.filter(operation => operation.state === 'APPLYING').length,
      byState: Object.fromEntries(['APPROVED', 'APPLYING', 'APPLIED', 'FAILED', 'UNKNOWN'].map(item => [item, state.operations.filter(operation => operation.state === item).length])),
      operations: state.operations
    };
  }
}
