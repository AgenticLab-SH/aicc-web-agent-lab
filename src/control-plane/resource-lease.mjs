import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DurableJobStore } from '../jobs/durable-store.mjs';

const RESOURCE_TYPES = new Set(['workspace-writer','browser-slot','browser-target','ui-focus','terminal-session','deployment','credential-writer','file-mutation']);
const ACCESS_MODES = new Set(['read','write']);
const LEASE_STATES = new Set(['leased','released','stale','quarantined']);
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,255}$/;

export class ResourceLeaseError extends Error {
  constructor(code, message) { super(message); this.name = 'ResourceLeaseError'; this.code = code; }
}

function requiredId(value, label) {
  const text = String(value ?? '').trim();
  if (!SAFE.test(text)) throw new ResourceLeaseError('invalid_resource_lease', `${label} is invalid`);
  return text;
}

function leasesOf(state) {
  if (!state.resourceLeases || typeof state.resourceLeases !== 'object' || Array.isArray(state.resourceLeases)) state.resourceLeases = {};
  return state.resourceLeases;
}

function resourceKey(type, resourceId) { return `${type}:${resourceId}`; }
function nowIso(now) { return new Date(now()).toISOString(); }

function active(lease, now) {
  return lease?.state === 'leased' && Date.parse(lease.expiresAt) > now();
}

function conflicts(left, right) {
  if (left.resourceKey !== right.resourceKey) return false;
  return left.accessMode === 'write' || right.accessMode === 'write';
}

export class ResourceLeaseManager {
  constructor({ store, now = () => Date.now(), defaultTtlMs = 60_000, maximumTtlMs = 10 * 60_000 } = {}) {
    if (!store?.read || !store?.transaction) throw new ResourceLeaseError('resource_lease_configuration_invalid', 'durable store is required');
    if (!Number.isInteger(defaultTtlMs) || defaultTtlMs < 1_000 || defaultTtlMs > maximumTtlMs) throw new ResourceLeaseError('resource_lease_configuration_invalid', 'default TTL is invalid');
    this.store = store;
    this.now = now;
    this.defaultTtlMs = defaultTtlMs;
    this.maximumTtlMs = maximumTtlMs;
  }

  acquire(spec = {}) {
    const resourceType = requiredId(spec.resourceType, 'resource type');
    if (!RESOURCE_TYPES.has(resourceType)) throw new ResourceLeaseError('unsupported_resource_type', `unsupported resource type: ${resourceType}`);
    const resourceId = requiredId(spec.resourceId, 'resource id');
    const ownerTaskId = requiredId(spec.ownerTaskId, 'owner task id');
    const ownerActorId = requiredId(spec.ownerActorId, 'owner actor id');
    const accessMode = spec.accessMode ?? 'write';
    if (!ACCESS_MODES.has(accessMode)) throw new ResourceLeaseError('invalid_resource_lease', 'access mode must be read or write');
    const ttlMs = spec.ttlMs ?? this.defaultTtlMs;
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > this.maximumTtlMs) throw new ResourceLeaseError('invalid_resource_lease', 'TTL exceeds policy');
    const key = resourceKey(resourceType, resourceId);
    const atMs = this.now();
    const candidate = { resourceKey: key, accessMode };
    return this.store.transaction('resource.lease.acquire', state => {
      const leases = leasesOf(state);
      for (const lease of Object.values(leases)) {
        if (lease.state === 'leased' && Date.parse(lease.expiresAt) <= atMs) { lease.state = 'stale'; lease.terminalReason = 'expired_before_acquire'; }
      }
      const blocker = Object.values(leases).find(lease => active(lease, () => atMs) && conflicts(lease, candidate));
      if (blocker) throw new ResourceLeaseError('resource_busy', `resource already has an incompatible lease: ${key}`);
      const generation = Math.max(0, ...Object.values(leases).filter(lease => lease.resourceKey === key).map(lease => Number(lease.generation) || 0)) + 1;
      const leaseId = `resource_${crypto.randomUUID()}`;
      const record = {
        schemaVersion: 1, leaseId, resourceType, resourceId, resourceKey: key, accessMode, ownerTaskId, ownerActorId,
        generation, state: 'leased', acquiredAt: new Date(atMs).toISOString(), heartbeatAt: new Date(atMs).toISOString(),
        expiresAt: new Date(atMs + ttlMs).toISOString(), releasedAt: null, terminalReason: null, recoveryRef: spec.recoveryRef ? requiredId(spec.recoveryRef, 'recovery ref') : null
      };
      leases[leaseId] = record;
      return record;
    }).result;
  }

  authorize(leaseId, expected = {}) {
    const id = requiredId(leaseId, 'lease id');
    const state = this.store.read().state;
    const lease = state.resourceLeases?.[id];
    if (!lease) throw new ResourceLeaseError('resource_lease_not_found', 'resource lease was not found');
    if (!active(lease, this.now)) throw new ResourceLeaseError('resource_lease_inactive', 'resource lease is not active');
    if (expected.resourceType && lease.resourceType !== expected.resourceType) throw new ResourceLeaseError('resource_lease_mismatch', 'resource type differs from lease');
    if (expected.resourceId && lease.resourceId !== expected.resourceId) throw new ResourceLeaseError('resource_lease_mismatch', 'resource id differs from lease');
    if (expected.ownerTaskId && lease.ownerTaskId !== expected.ownerTaskId) throw new ResourceLeaseError('resource_lease_mismatch', 'owner task differs from lease');
    if (expected.ownerActorId && lease.ownerActorId !== expected.ownerActorId) throw new ResourceLeaseError('resource_lease_mismatch', 'owner actor differs from lease');
    if (expected.accessMode === 'write' && lease.accessMode !== 'write') throw new ResourceLeaseError('resource_scope_denied', 'read lease cannot authorize write');
    return { ok: true, leaseId: lease.leaseId, resourceKey: lease.resourceKey, accessMode: lease.accessMode, generation: lease.generation, expiresAt: lease.expiresAt };
  }

  heartbeat(leaseId, { ownerTaskId, ownerActorId, ttlMs = this.defaultTtlMs } = {}) {
    const id = requiredId(leaseId, 'lease id');
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > this.maximumTtlMs) throw new ResourceLeaseError('invalid_resource_lease', 'TTL exceeds policy');
    const atMs = this.now();
    return this.store.transaction('resource.lease.heartbeat', state => {
      const lease = leasesOf(state)[id];
      if (!lease || !active(lease, () => atMs)) throw new ResourceLeaseError('resource_lease_inactive', 'resource lease is not active');
      if (ownerTaskId && lease.ownerTaskId !== ownerTaskId) throw new ResourceLeaseError('resource_lease_mismatch', 'owner task differs from lease');
      if (ownerActorId && lease.ownerActorId !== ownerActorId) throw new ResourceLeaseError('resource_lease_mismatch', 'owner actor differs from lease');
      lease.heartbeatAt = new Date(atMs).toISOString();
      lease.expiresAt = new Date(atMs + ttlMs).toISOString();
      return lease;
    }).result;
  }

  release(leaseId, { ownerTaskId, ownerActorId, reason = 'released' } = {}) {
    const id = requiredId(leaseId, 'lease id');
    const terminalReason = requiredId(reason, 'release reason');
    return this.store.transaction('resource.lease.release', state => {
      const lease = leasesOf(state)[id];
      if (!lease) throw new ResourceLeaseError('resource_lease_not_found', 'resource lease was not found');
      if (lease.state === 'released') return lease;
      if (ownerTaskId && lease.ownerTaskId !== ownerTaskId) throw new ResourceLeaseError('resource_lease_mismatch', 'owner task differs from lease');
      if (ownerActorId && lease.ownerActorId !== ownerActorId) throw new ResourceLeaseError('resource_lease_mismatch', 'owner actor differs from lease');
      lease.state = 'released'; lease.releasedAt = nowIso(this.now); lease.terminalReason = terminalReason;
      return lease;
    }).result;
  }

  recoverExpired() {
    const atMs = this.now();
    return this.store.transaction('resource.lease.recover-expired', state => {
      const stale = [];
      for (const lease of Object.values(leasesOf(state))) {
        if (lease.state === 'leased' && Date.parse(lease.expiresAt) <= atMs) { lease.state = 'stale'; lease.terminalReason = 'expired'; stale.push(lease.leaseId); }
      }
      return { stale };
    }).result;
  }

  status() {
    const leases = Object.values(this.store.read().state.resourceLeases ?? {});
    const now = this.now();
    return {
      schemaVersion: 1, total: leases.length, active: leases.filter(lease => active(lease, () => now)).length,
      states: Object.fromEntries([...LEASE_STATES].map(state => [state, leases.filter(lease => lease.state === state).length])),
      leases: leases.map(lease => ({ ...lease })).sort((a,b) => a.resourceKey.localeCompare(b.resourceKey) || a.generation - b.generation)
    };
  }
}

export function createDefaultResourceLeaseManager(options = {}) {
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center');
  const store = options.store ?? new DurableJobStore({ root: path.join(stateRoot, 'jobs'), create: options.create !== false, now: options.now });
  return new ResourceLeaseManager({ store, now: options.now, defaultTtlMs: options.defaultTtlMs, maximumTtlMs: options.maximumTtlMs });
}

export const AICC_RESOURCE_TYPES = Object.freeze([...RESOURCE_TYPES]);