import crypto from 'node:crypto';

const ROLES = new Set(['in-app-browser', 'web-gpt-partition', 'registered-cdp', 'isolated-qa']);
const STATES = new Set(['leased', 'released', 'stale', 'quarantined']);
const READ_ONLY_CAPABILITIES = new Set(['navigate', 'inspect', 'screenshot', 'console', 'network']);
const ALL_CAPABILITIES = new Set([...READ_ONLY_CAPABILITIES, 'click', 'type', 'download']);

export class BrowserBrokerError extends Error {
  constructor(code, message) { super(message); this.name = 'BrowserBrokerError'; this.code = code; }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
}

function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new BrowserBrokerError('invalid_browser_lease', `${label} is required`);
  return value.trim();
}

function normalizeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new BrowserBrokerError('origin_not_allowed', `invalid browser URL: ${value}`); }
  if (!['http:', 'https:', 'about:'].includes(url.protocol)) throw new BrowserBrokerError('origin_not_allowed', `browser URL protocol is not allowed: ${url.protocol}`);
  return url.protocol === 'about:' ? 'about:' : url.origin;
}

function activeAttempt(job, attemptId) {
  return job?.attempts?.find(attempt => attempt.attemptId === attemptId && attempt.state === 'running') ?? null;
}

export function browserIdentityHash(identity) {
  return hash({
    role: identity.role,
    engine: identity.engine,
    appIdentity: identity.appIdentity,
    executable: identity.executable,
    userDataRoot: identity.userDataRoot,
    profile: identity.profile,
    cdpEndpoint: identity.cdpEndpoint ?? null,
    nativeSessionId: identity.nativeSessionId ?? null,
    accountAlias: identity.accountAlias ?? null,
    workspaceAlias: identity.workspaceAlias ?? null,
    owner: identity.owner
  });
}

export function createBrowserIdentityRegistry(entries) {
  const registry = new Map();
  for (const candidate of entries) {
    const identity = {
      identityId: requireString(candidate.identityId, 'browser identity id'),
      role: requireString(candidate.role, 'browser role'),
      engine: requireString(candidate.engine, 'browser engine'),
      appIdentity: requireString(candidate.appIdentity, 'OS app identity'),
      executable: requireString(candidate.executable, 'browser executable'),
      userDataRoot: requireString(candidate.userDataRoot, 'browser user data root'),
      profile: requireString(candidate.profile, 'browser profile'),
      cdpEndpoint: candidate.cdpEndpoint?.trim() || null,
      nativeSessionId: candidate.nativeSessionId?.trim() || null,
      accountAlias: candidate.accountAlias?.trim() || null,
      workspaceAlias: candidate.workspaceAlias?.trim() || null,
      owner: requireString(candidate.owner, 'browser identity owner'),
      ownershipPolicy: candidate.ownershipPolicy ?? 'task-created-target-only'
    };
    if (!ROLES.has(identity.role)) throw new BrowserBrokerError('invalid_identity', `unsupported browser role: ${identity.role}`);
    if (identity.ownershipPolicy !== 'task-created-target-only') throw new BrowserBrokerError('user_target_prohibited', 'browser identity must exclude existing user targets');
    if (identity.cdpEndpoint) {
      const endpoint = new URL(identity.cdpEndpoint);
      if (!['127.0.0.1', 'localhost'].includes(endpoint.hostname) || endpoint.protocol !== 'http:') throw new BrowserBrokerError('invalid_identity', 'CDP endpoint must be explicit loopback HTTP');
    } else if (!identity.nativeSessionId) throw new BrowserBrokerError('invalid_identity', 'browser identity requires CDP endpoint or native session ID');
    if (registry.has(identity.identityId)) throw new BrowserBrokerError('invalid_identity', `duplicate browser identity: ${identity.identityId}`);
    identity.hash = browserIdentityHash(identity);
    registry.set(identity.identityId, Object.freeze(identity));
  }
  return registry;
}

function browserSlotResourceId(identity) {
  if (identity.cdpEndpoint) return `cdp:${new URL(identity.cdpEndpoint).port}`;
  return `native:${identity.identityId}`;
}

function requireLease(state, leaseId) {
  const lease = state.browserLeases[leaseId];
  if (!lease) throw new BrowserBrokerError('lease_not_found', `unknown browser lease: ${leaseId}`);
  return lease;
}

export class BrowserSessionBroker {
  constructor({ store, registry, provider, resourceLeases = null, now = () => Date.now(), ttlMs = 60_000, maxActive = 64 } = {}) {
    if (!store || !(registry instanceof Map) || !provider) throw new BrowserBrokerError('broker_configuration_invalid', 'store, identity registry, and provider are required');
    if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 64) throw new BrowserBrokerError('broker_configuration_invalid', 'browser hard active cap must be 1-64');
    this.store = store;
    this.registry = registry;
    this.provider = provider;
    this.resourceLeases = resourceLeases;
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxActive = maxActive;
    this.capabilities = new Map();
  }

  async acquire(spec) {
    const identity = this.registry.get(spec.identityId);
    if (!identity) throw new BrowserBrokerError('identity_not_found', `unknown browser identity: ${spec.identityId}`);
    const snapshot = this.store.read().state;
    const job = snapshot.jobs[spec.jobId];
    const attempt = activeAttempt(job, spec.attemptId);
    if (!job || !attempt || !['browser', 'remote'].includes(job.workloadClass)) throw new BrowserBrokerError('job_binding_invalid', 'browser lease requires an active browser or remote job attempt');
    const accessMode = spec.accessMode ?? 'observe';
    if (!['observe', 'interact'].includes(accessMode)) throw new BrowserBrokerError('invalid_browser_lease', 'browser access mode is invalid');
    if (accessMode === 'interact' && job.mode !== 'write') throw new BrowserBrokerError('writer_required', 'interactive browser work requires the durable workspace writer lease');
    const capabilities = [...new Set(spec.capabilities ?? [...READ_ONLY_CAPABILITIES])];
    if (capabilities.some(item => !ALL_CAPABILITIES.has(item))) throw new BrowserBrokerError('invalid_browser_lease', 'browser capability is not supported');
    if (accessMode === 'observe' && capabilities.some(item => !READ_ONLY_CAPABILITIES.has(item))) throw new BrowserBrokerError('capability_denied', 'read-only browser lease cannot click, type, or download');
    const permittedOrigins = [...new Set((spec.permittedOrigins ?? []).map(normalizeOrigin))];
    const requestedOrigin = normalizeOrigin(spec.url);
    if (!permittedOrigins.includes(requestedOrigin)) throw new BrowserBrokerError('origin_not_allowed', 'requested browser origin is not allowlisted');
    const activeCount = Object.values(snapshot.browserLeases).filter(lease => lease.state === 'leased' && Date.parse(lease.expiresAt) > this.now()).length;
    if (activeCount >= this.maxActive) throw new BrowserBrokerError('browser_backpressure', 'browser active lease cap reached');

    let resourceLease = null;
    if (this.resourceLeases) {
      resourceLease = this.resourceLeases.acquire({
        resourceType: 'browser-slot', resourceId: browserSlotResourceId(identity), ownerTaskId: job.jobId,
        ownerActorId: spec.attemptId, accessMode: 'write', ttlMs: Math.max(1_000, this.ttlMs),
        recoveryRef: `browser:${job.jobId}:${spec.attemptId}`
      });
    }
    let external;
    try {
      external = await this.provider.acquire({ identity, url: spec.url, ownerTaskId: job.jobId, purpose: spec.purpose });
    } catch (error) {
      if (resourceLease) {
        try { this.resourceLeases.release(resourceLease.leaseId, { ownerTaskId: job.jobId, ownerActorId: spec.attemptId, reason: 'provider-acquire-failed' }); } catch { /* fail closed until expiry */ }
      }
      throw error;
    }
    let persisted = false;
    try {
      if (external.ownership !== 'task-created' || !external.targetId) throw new BrowserBrokerError('user_target_prohibited', 'provider did not return a task-created target');
      if (external.identityHash !== identity.hash) throw new BrowserBrokerError('identity_mismatch', 'browser provider identity differs from the registered tuple');
      const capability = requireString(external.capability, 'provider lease capability');
      const leaseId = spec.leaseId?.trim() || `browser_${crypto.randomUUID()}`;
      const at = new Date(this.now()).toISOString();
      const expiresAt = new Date(this.now() + this.ttlMs).toISOString();
      const result = this.store.transaction('browser.lease.acquire', state => {
        const currentJob = state.jobs[spec.jobId];
        if (!activeAttempt(currentJob, spec.attemptId)) throw new BrowserBrokerError('job_binding_invalid', 'job attempt changed before browser lease commit');
        if (state.browserLeases[leaseId]) throw new BrowserBrokerError('lease_exists', `browser lease already exists: ${leaseId}`);
        if (Object.values(state.browserLeases).some(lease => lease.state === 'leased' && (lease.targetId === external.targetId || lease.ownerAttemptId === spec.attemptId))) {
          throw new BrowserBrokerError('target_conflict', 'target or attempt already has a browser lease');
        }
        const lease = {
          contractVersion: 1,
          leaseId,
          identity: { ...identity },
          identityHash: identity.hash,
          targetId: external.targetId,
          conversationId: external.conversationId ?? null,
          ownerTaskId: job.jobId,
          ownerAttemptId: spec.attemptId,
          purpose: requireString(spec.purpose, 'browser lease purpose'),
          accessMode,
          capabilities,
          permittedOrigins,
          downloadPolicy: spec.downloadPolicy ?? 'task-artifact-save-as-only',
          state: 'leased',
          heartbeatAt: at,
          expiresAt,
          capabilityHash: hash(capability),
          resourceLeaseId: resourceLease?.leaseId ?? null,
          resourceId: browserSlotResourceId(identity),
          cleanupState: 'owned-target-open',
          rawTabContentStored: false
        };
        state.browserLeases[leaseId] = lease;
        currentJob.browserLeaseRefs = [...new Set([...(currentJob.browserLeaseRefs ?? []), leaseId])];
        return lease;
      }).result;
      this.capabilities.set(leaseId, capability);
      persisted = true;
      return result;
    } finally {
      if (!persisted && external.capability) await this.provider.release({ capability: external.capability, targetId: external.targetId }).catch(() => {});
      if (!persisted && resourceLease) {
        try { this.resourceLeases.release(resourceLease.leaseId, { ownerTaskId: job.jobId, ownerActorId: spec.attemptId, reason: 'browser-acquire-rollback' }); } catch { /* fail closed until expiry */ }
      }
    }
  }

  authorize(leaseId, { targetId, url, capability }) {
    const lease = requireLease(this.store.read().state, leaseId);
    if (lease.state !== 'leased' || Date.parse(lease.expiresAt) <= this.now()) throw new BrowserBrokerError('lease_inactive', 'browser lease is not active');
    if (lease.targetId !== targetId) throw new BrowserBrokerError('target_mismatch', 'browser operation target differs from the exact lease target');
    if (!lease.permittedOrigins.includes(normalizeOrigin(url))) throw new BrowserBrokerError('origin_not_allowed', 'browser operation origin is not allowlisted');
    if (!lease.capabilities.includes(capability)) throw new BrowserBrokerError('capability_denied', `browser capability not granted: ${capability}`);
    if (lease.resourceLeaseId && this.resourceLeases) {
      this.resourceLeases.authorize(lease.resourceLeaseId, {
        resourceType: 'browser-slot', resourceId: lease.resourceId, ownerTaskId: lease.ownerTaskId,
        ownerActorId: lease.ownerAttemptId, accessMode: 'write'
      });
    }
    return { ok: true, leaseId, targetId, capability, identityHash: lease.identityHash, resourceLeaseId: lease.resourceLeaseId ?? null };
  }

  async heartbeat(leaseId) {
    const capability = this.capabilities.get(leaseId);
    if (!capability) throw new BrowserBrokerError('provider_reconcile_required', 'provider capability is unavailable after restart');
    const providerResult = await this.provider.heartbeat({ capability });
    if (providerResult?.ok !== true) throw new BrowserBrokerError('provider_heartbeat_failed', 'task-owned browser lease renewal was not confirmed');
    const current = requireLease(this.store.read().state, leaseId);
    if (current.resourceLeaseId && this.resourceLeases) {
      this.resourceLeases.heartbeat(current.resourceLeaseId, {
        ownerTaskId: current.ownerTaskId, ownerActorId: current.ownerAttemptId, ttlMs: Math.max(1_000, this.ttlMs)
      });
    }
    return this.store.transaction('browser.lease.heartbeat', state => {
      const lease = requireLease(state, leaseId);
      if (lease.state !== 'leased') throw new BrowserBrokerError('lease_inactive', 'browser lease is not active');
      lease.heartbeatAt = new Date(this.now()).toISOString();
      lease.expiresAt = new Date(this.now() + this.ttlMs).toISOString();
      return lease;
    }).result;
  }

  async release(leaseId) {
    const before = requireLease(this.store.read().state, leaseId);
    if (before.state === 'released') return before;
    const capability = this.capabilities.get(leaseId);
    if (!capability) {
      return this.store.transaction('browser.lease.release.defer', state => {
        const lease = requireLease(state, leaseId);
        lease.state = 'stale';
        lease.cleanupState = 'provider-reconcile-required';
        return lease;
      }).result;
    }
    const released = await this.provider.release({ capability, targetId: before.targetId });
    if (!released?.targetClosed) throw new BrowserBrokerError('target_cleanup_failed', 'provider did not confirm exact target closure');
    this.capabilities.delete(leaseId);
    const browserLease = this.store.transaction('browser.lease.release', state => {
      const lease = requireLease(state, leaseId);
      lease.state = 'released';
      lease.cleanupState = 'owned-target-closed';
      lease.releasedAt = new Date(this.now()).toISOString();
      return lease;
    }).result;
    if (browserLease.resourceLeaseId && this.resourceLeases) {
      this.resourceLeases.release(browserLease.resourceLeaseId, {
        ownerTaskId: browserLease.ownerTaskId, ownerActorId: browserLease.ownerAttemptId, reason: 'browser-target-closed'
      });
    }
    return browserLease;
  }

  reconcile(observed = []) {
    return this.store.transaction('browser.lease.reconcile', state => {
      const knownTargets = new Set(Object.values(state.browserLeases).map(lease => lease.targetId));
      const observedByTarget = new Map(observed.map(item => [item.targetId, item]));
      const stale = [];
      const quarantined = [];
      for (const lease of Object.values(state.browserLeases)) {
        if (lease.state !== 'leased') continue;
        const item = observedByTarget.get(lease.targetId);
        if (!item) { lease.state = 'stale'; lease.cleanupState = 'provider-target-absent'; stale.push(lease.leaseId); continue; }
        if (item.ownerTaskId !== lease.ownerTaskId || item.identityHash !== lease.identityHash) {
          lease.state = 'quarantined'; lease.cleanupState = 'ownership-mismatch'; quarantined.push(lease.leaseId);
        }
      }
      return { stale, quarantined, foreignTargetsUntouched: observed.filter(item => !knownTargets.has(item.targetId)).length, acquired: 0 };
    }).result;
  }

  recoverExpired() {
    return this.store.transaction('browser.lease.expire', state => {
      const stale = [];
      for (const lease of Object.values(state.browserLeases)) {
        if (lease.state === 'leased' && Date.parse(lease.expiresAt) <= this.now()) {
          lease.state = 'stale';
          lease.cleanupState = 'provider-reconcile-required';
          stale.push(lease.leaseId);
        }
      }
      return { stale };
    }).result;
  }

  status() {
    const leases = Object.values(this.store.read().state.browserLeases);
    return {
      identities: this.registry.size,
      total: leases.length,
      active: leases.filter(lease => lease.state === 'leased').length,
      states: Object.fromEntries([...STATES].map(state => [state, leases.filter(lease => lease.state === state).length])),
      rawCapabilitiesStored: leases.some(lease => Object.hasOwn(lease, 'capability')),
      hardActiveCap: this.maxActive
    };
  }
}
