import crypto from 'node:crypto';

const MODES = new Set(['read-only', 'write']);
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export class RemoteAuthorityError extends Error {
  constructor(code, message) { super(message); this.name = 'RemoteAuthorityError'; this.code = code; }
}

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function requireOpaque(value, label) {
  if (typeof value !== 'string' || !CORRELATION.test(value)) throw new RemoteAuthorityError('invalid_remote_lease', `${label} must be an opaque 8-128 character reference`);
  return value;
}

function conflictWorkspaceIds(workspaceId, values) {
  const ids = [...new Set([workspaceId, ...(Array.isArray(values) ? values : [])])];
  for (const id of ids) requireOpaque(id, 'conflicting workspace id');
  return ids.sort();
}

export class RemoteLeaseAuthority {
  constructor({
    identityBinding,
    now = () => Date.now(),
    readTtlMs = 120 * 60_000,
    writeTtlMs = 120 * 60_000,
    store = null,
    readStore = null,
    writerAuthorizer = null,
    writePolicy = 'guarded',
    onExpire = null,
    ownerPid = process.pid,
    isProcessAlive = processIsAlive,
    authorityInstanceId = crypto.randomUUID()
  } = {}) {
    this.identityBinding = requireOpaque(identityBinding, 'remote identity binding');
    this.now = now;
    this.readTtlMs = readTtlMs;
    this.writeTtlMs = writeTtlMs;
    this.store = store;
    this.readStore = readStore ?? store;
    this.writerAuthorizer = writerAuthorizer;
    this.onExpire = onExpire;
    if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw new RemoteAuthorityError('invalid_remote_lease', 'remote authority owner PID must be a positive integer');
    requireOpaque(authorityInstanceId, 'remote authority instance id');
    this.ownerPid = ownerPid;
    this.isProcessAlive = isProcessAlive;
    this.authorityInstanceId = authorityInstanceId;
    if (!['guarded', 'owner-unrestricted', 'read-only'].includes(writePolicy)) {
      throw new RemoteAuthorityError('invalid_remote_lease', `unsupported remote write policy: ${writePolicy}`);
    }
    this.writePolicy = writePolicy;
    this.tokens = new Map();
    this.usedRequests = new Set();
    this.ownerWriters = new Map();
    this.expiryTimers = new Map();
  }

  reconcileStartup() {
    const stale = [];
    let deferred = 0;
    for (const store of this.#durableStores()) {
      const active = Object.values(store.read().state.remoteLeases).filter(lease => lease.state === 'leased');
      const candidates = active.filter(lease => (
        Date.parse(lease.expiresAt) <= this.now()
        || !Number.isInteger(lease.ownerPid)
        || !this.isProcessAlive(lease.ownerPid)
      ));
      if (!candidates.length) continue;
      try {
        const result = store.transaction('remote.lease.reconcile-startup', state => {
          const reconciled = [];
          for (const lease of Object.values(state.remoteLeases)) {
            if (lease.state !== 'leased') continue;
            const expired = Date.parse(lease.expiresAt) <= this.now();
            const ownerDead = !Number.isInteger(lease.ownerPid) || !this.isProcessAlive(lease.ownerPid);
            if (!expired && !ownerDead) continue;
            lease.state = 'stale';
            lease.terminalReason = expired ? 'remote_lease_expired_before_startup' : 'authority_restart_invalidated_capability';
            reconciled.push(lease.leaseId);
          }
          return { stale: reconciled };
        }).result;
        stale.push(...result.stale);
      } catch (error) {
        if (error?.code !== 'writer_busy') throw error;
        deferred += 1;
      }
    }
    return { stale: [...new Set(stale)], deferred };
  }

  async open({ workspaceId, mode = 'read-only', correlationId, approvalRef = null, jobId = null, attemptId = null, expiresInSeconds = null, conflictWorkspaceIds: requestedConflictWorkspaceIds = [] } = {}) {
    if (!MODES.has(mode)) throw new RemoteAuthorityError('invalid_remote_lease', `unsupported remote mode: ${mode}`);
    if (mode === 'write' && this.writePolicy === 'read-only') {
      throw new RemoteAuthorityError('remote_scope_denied', 'this remote authority exposes read-only leases only');
    }
    requireOpaque(workspaceId, 'workspace id');
    requireOpaque(correlationId, 'correlation id');
    await this.#reapExpired();
    if (mode === 'write' && this.writePolicy === 'guarded') {
      requireOpaque(approvalRef, 'write approval ref');
      requireOpaque(jobId, 'durable job id');
      requireOpaque(attemptId, 'durable attempt id');
      if (!this.writerAuthorizer?.acquire) throw new RemoteAuthorityError('writer_binding_unavailable', 'remote write requires a durable workspace writer authorizer');
    }
    const maximum = mode === 'write' ? this.writeTtlMs : this.readTtlMs;
    const requested = expiresInSeconds === null ? maximum : Number(expiresInSeconds) * 1_000;
    if (!Number.isInteger(requested) || requested < 1_000 || requested > maximum) throw new RemoteAuthorityError('invalid_remote_lease', 'requested remote lease expiry exceeds policy');
    const leaseId = `remote_${crypto.randomUUID()}`;
    let writerLeaseRef = null;
    const writerConflictWorkspaceIds = mode === 'write'
      ? conflictWorkspaceIds(workspaceId, requestedConflictWorkspaceIds)
      : [];
    if (mode === 'write' && this.writePolicy === 'guarded') {
      const authorized = await this.writerAuthorizer.acquire({ workspaceId, jobId, attemptId, identityBinding: this.identityBinding, correlationId, approvalRef, conflictWorkspaceIds: writerConflictWorkspaceIds });
      if (!authorized?.ok || !authorized.writerLeaseRef) throw new RemoteAuthorityError('writer_binding_denied', 'durable workspace writer binding was denied');
      writerLeaseRef = authorized.writerLeaseRef;
    } else if (mode === 'write') {
      if (writerConflictWorkspaceIds.some(id => this.ownerWriters.has(id))) {
        throw new RemoteAuthorityError('writer_binding_denied', 'another authenticated owner write lease is already active for this workspace');
      }
      writerLeaseRef = `owner_writer_${crypto.randomBytes(24).toString('hex')}`;
      // Claim actual roots; sibling roots may share a broad registered ancestor.
      this.ownerWriters.set(workspaceId, writerLeaseRef);
    }
    const capability = `remote_cap_${crypto.randomBytes(32).toString('hex')}`;
    const now = this.now();
    const record = {
      contractVersion: 2,
      leaseId,
      workspaceId,
      identityBinding: this.identityBinding,
      correlationId,
      mode,
      approvalRef: mode === 'write' && this.writePolicy === 'guarded' ? approvalRef : null,
      jobId: mode === 'write' && this.writePolicy === 'guarded' ? jobId : null,
      attemptId: mode === 'write' && this.writePolicy === 'guarded' ? attemptId : null,
      writerLeaseRef,
      writerConflictWorkspaceIds,
      capabilityHash: hash(capability),
      authorityInstanceId: this.authorityInstanceId,
      ownerPid: this.ownerPid,
      state: 'leased',
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + requested).toISOString(),
      terminalReason: null
    };
    this.tokens.set(capability, record);
    try {
      this.#commitOpen(record);
      const timer = setTimeout(() => { void this.#expire(record, 'remote_lease_expired'); }, requested);
      timer.unref?.();
      this.expiryTimers.set(leaseId, timer);
      return { capability, record: structuredClone(record) };
    } catch (error) {
      this.tokens.delete(capability);
      if (writerLeaseRef && this.writePolicy === 'guarded' && this.writerAuthorizer?.release) {
        await this.writerAuthorizer.release({ writerLeaseRef, reason: 'remote_lease_commit_failed' });
      }
      if (this.writePolicy === 'owner-unrestricted') this.#releaseOwnerWriter(record);
      throw error;
    }
  }

  async resolve({ workspaceId, capability, requiredMode = 'read', requestId = null, consumeRequest = true } = {}) {
    const record = this.tokens.get(capability);
    if (!record || record.capabilityHash !== hash(capability)) throw new RemoteAuthorityError('remote_lease_invalid', 'remote lease capability is unknown or invalidated');
    if (record.workspaceId !== workspaceId) throw new RemoteAuthorityError('remote_workspace_mismatch', 'remote lease is bound to another workspace');
    if (record.state !== 'leased' || Date.parse(record.expiresAt) <= this.now()) {
      await this.#expire(record, 'remote_lease_expired');
      throw new RemoteAuthorityError('remote_lease_expired', 'remote lease has expired');
    }
    if (requiredMode === 'write') {
      if (record.mode !== 'write') throw new RemoteAuthorityError('remote_scope_denied', 'read-only remote lease cannot call write tools');
      if (this.writePolicy === 'guarded') {
        const validateWriter = this.writerAuthorizer?.validate ?? this.writerAuthorizer?.acquire;
        if (!validateWriter) {
          await this.#expire(record, 'remote_writer_binding_unavailable');
          throw new RemoteAuthorityError('writer_binding_unavailable', 'remote write requires a durable workspace writer authorizer');
        }
        let authorized;
        try {
          authorized = await validateWriter.call(this.writerAuthorizer, {
            workspaceId: record.workspaceId,
            jobId: record.jobId,
            attemptId: record.attemptId,
            identityBinding: record.identityBinding,
            correlationId: record.correlationId,
            approvalRef: record.approvalRef,
            writerLeaseRef: record.writerLeaseRef,
            conflictWorkspaceIds: record.writerConflictWorkspaceIds
          });
        } catch {
          await this.#expire(record, 'remote_writer_binding_invalid');
          throw new RemoteAuthorityError('writer_binding_denied', 'durable workspace writer binding is no longer active');
        }
        if (!authorized?.ok || authorized.writerLeaseRef !== record.writerLeaseRef) {
          await this.#expire(record, 'remote_writer_binding_invalid');
          throw new RemoteAuthorityError('writer_binding_denied', 'durable workspace writer binding is no longer active');
        }
      } else if (this.ownerWriters.get(record.workspaceId) !== record.writerLeaseRef) {
        await this.#expire(record, 'remote_writer_binding_invalid');
        throw new RemoteAuthorityError('writer_binding_denied', 'authenticated owner writer lease is no longer active');
      }
      if (consumeRequest) {
        requireOpaque(requestId, 'write request id');
        const replayKey = `${record.leaseId}:${requestId}`;
        if (this.usedRequests.has(replayKey)) throw new RemoteAuthorityError('remote_replay_rejected', 'write request ID was already consumed');
        this.usedRequests.add(replayKey);
        if (this.store) this.store.transaction('remote.replay.consume', state => {
          const replayHash = hash(replayKey);
          if (state.remoteReplay[replayHash]) throw new RemoteAuthorityError('remote_replay_rejected', 'write request ID was already consumed');
          state.remoteReplay[replayHash] = { leaseId: record.leaseId, requestHash: hash(requestId), consumedAt: new Date(this.now()).toISOString() };
          return null;
        });
      }
    }
    return structuredClone(record);
  }

  async close(capability, reason = 'remote_close') {
    const record = this.tokens.get(capability);
    if (!record) return { closed: false };
    this.tokens.delete(capability);
    this.#clearExpiry(record.leaseId);
    // Durable replay evidence remains after capability retirement.
    for (const key of this.usedRequests) if (key.startsWith(record.leaseId + ':')) this.usedRequests.delete(key);
    record.state = 'released';
    record.terminalReason = reason;
    record.releasedAt = new Date(this.now()).toISOString();
    this.#persist(record);
    if (record.writerLeaseRef && this.writePolicy === 'guarded' && this.writerAuthorizer?.release) {
      await this.writerAuthorizer.release({ writerLeaseRef: record.writerLeaseRef, reason });
    }
    if (this.writePolicy === 'owner-unrestricted') this.#releaseOwnerWriter(record);
    return { closed: true, leaseId: record.leaseId };
  }

  status() {
    const records = [...this.tokens.values()];
    const active = records.filter(record => record.state === 'leased' && Date.parse(record.expiresAt) > this.now());
    return {
      identityBinding: this.identityBinding,
      active: active.length,
      readOnly: active.filter(record => record.mode === 'read-only').length,
      write: active.filter(record => record.mode === 'write').length,
      writePolicy: this.writePolicy,
      rawCapabilitiesStored: this.#durableStores().some(store => (
        Object.values(store.read().state.remoteLeases).some(record => Object.hasOwn(record, 'capability'))
      ))
    };
  }

  async #expire(record, reason) {
    if (record.state !== 'leased') return;
    this.#clearExpiry(record.leaseId);
    // Durable replay evidence remains after capability retirement.
    for (const key of this.usedRequests) if (key.startsWith(record.leaseId + ':')) this.usedRequests.delete(key);
    this.tokens.delete([...this.tokens.entries()].find(([, value]) => value.leaseId === record.leaseId)?.[0]);
    record.state = 'stale';
    record.terminalReason = reason;
    this.#persist(record);
    if (record.writerLeaseRef && this.writePolicy === 'guarded' && this.writerAuthorizer?.release) {
      await this.writerAuthorizer.release({ writerLeaseRef: record.writerLeaseRef, reason });
    }
    if (this.writePolicy === 'owner-unrestricted') this.#releaseOwnerWriter(record);
    if (this.onExpire) await this.onExpire(structuredClone(record));
  }

  async #reapExpired() {
    const expired = [...this.tokens.values()].filter(record => (
      record.state === 'leased' && Date.parse(record.expiresAt) <= this.now()
    ));
    for (const record of expired) await this.#expire(record, 'remote_lease_expired');
  }

  #releaseOwnerWriter(record) {
    for (const id of record.writerConflictWorkspaceIds ?? [record.workspaceId]) {
      if (this.ownerWriters.get(id) === record.writerLeaseRef) this.ownerWriters.delete(id);
    }
  }

  #clearExpiry(leaseId) {
    const timer = this.expiryTimers.get(leaseId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(leaseId);
  }

  #durableStores() {
    return [...new Set([this.store, this.readStore].filter(Boolean))];
  }

  #storeFor(record) {
    return record.mode === 'read-only' ? this.readStore : this.store;
  }

  #persist(record) {
    const store = this.#storeFor(record);
    if (!store) return;
    store.transaction('remote.lease.state', state => { state.remoteLeases[record.leaseId] = record; return null; });
  }

  #commitOpen(record) {
    const store = this.#storeFor(record);
    if (!store) return;
    store.transaction('remote.lease.open', state => {
      if (record.mode === 'write') {
        const requested = new Set(record.writerConflictWorkspaceIds ?? [record.workspaceId]);
        for (const existing of Object.values(state.remoteLeases)) {
          if (existing.state !== 'leased' || existing.mode !== 'write') continue;
          const expired = Date.parse(existing.expiresAt) <= this.now();
          const ownerDead = !Number.isInteger(existing.ownerPid) || !this.isProcessAlive(existing.ownerPid);
          if (expired || ownerDead) {
            existing.state = 'stale';
            existing.terminalReason = expired ? 'remote_lease_expired_before_open' : 'authority_process_not_alive';
            continue;
          }
          const conflicts = requested.has(existing.workspaceId)
            || (existing.writerConflictWorkspaceIds ?? [existing.workspaceId]).includes(record.workspaceId);
          if (conflicts) {
            throw new RemoteAuthorityError('writer_binding_denied', 'another authenticated owner write lease is already active for this workspace');
          }
        }
      }
      state.remoteLeases[record.leaseId] = record;
      return null;
    });
  }
}
