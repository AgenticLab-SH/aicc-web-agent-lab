const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{1,127}$/;
const REF = /^(?:windows-credential|os-keychain|browser-profile|oauth-session|external-session):\/\/[A-Za-z0-9._:@/+%-]{1,300}$/;
const SENSITIVE_KEY = /(?:password|passwd|passcode|otp|mfa|token|cookie|secret|authorization|credentialvalue)/i;

export class AuthBrokerError extends Error {
  constructor(code, message) { super(message); this.name = 'AuthBrokerError'; this.code = code; }
}

function rejectSensitive(value, path = 'input') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new AuthBrokerError('raw_credential_prohibited', `raw credential-like field is prohibited: ${path}.${key}`);
    if (child && typeof child === 'object') rejectSensitive(child, `${path}.${key}`);
  }
}

function id(value, label) {
  const text = String(value ?? '').trim();
  if (!SAFE_ID.test(text)) throw new AuthBrokerError('invalid_auth_binding', `${label} is invalid`);
  return text;
}

function credentialRef(value) {
  const text = String(value ?? '').trim();
  if (!REF.test(text)) throw new AuthBrokerError('invalid_credential_ref', 'credentialRef must point to an OS/session reference, never a raw credential');
  return text;
}

function normalizeSpec(input = {}) {
  rejectSensitive(input);
  return Object.freeze({
    sessionId: id(input.sessionId, 'session id'),
    providerId: id(input.providerId, 'provider id'),
    accountAlias: id(input.accountAlias, 'account alias'),
    profileId: id(input.profileId, 'profile id'),
    credentialRef: credentialRef(input.credentialRef),
    ownerTaskId: input.ownerTaskId ? id(input.ownerTaskId, 'owner task id') : null,
    ownerActorId: input.ownerActorId ? id(input.ownerActorId, 'owner actor id') : null
  });
}

function normalizeObserved(raw, expected) {
  rejectSensitive(raw, 'adapter_result');
  if (!raw || typeof raw !== 'object') throw new AuthBrokerError('auth_inspection_invalid', 'auth adapter returned no inspection result');
  const accountAlias = id(raw.accountAlias, 'observed account alias');
  const profileId = id(raw.profileId, 'observed profile id');
  if (accountAlias !== expected.accountAlias) throw new AuthBrokerError('account_identity_mismatch', 'observed account differs from the expected account binding');
  if (profileId !== expected.profileId) throw new AuthBrokerError('profile_identity_mismatch', 'observed profile differs from the expected profile binding');
  const expiresAt = raw.expiresAt == null ? null : String(raw.expiresAt);
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw new AuthBrokerError('auth_inspection_invalid', 'expiresAt is invalid');
  return Object.freeze({
    authenticated: raw.authenticated === true,
    accountAlias, profileId, expiresAt,
    refreshable: raw.refreshable === true,
    restorable: raw.restorable === true,
    stateRef: raw.stateRef == null ? null : id(raw.stateRef, 'state ref')
  });
}

function ready(observed, now, skewMs) {
  if (!observed.authenticated) return false;
  if (!observed.expiresAt) return true;
  return Date.parse(observed.expiresAt) - now() > skewMs;
}

export class AuthBroker {
  constructor({ adapter, resourceLeases = null, now = () => Date.now(), expirySkewMs = 60_000 } = {}) {
    if (!adapter?.inspect) throw new AuthBrokerError('auth_broker_configuration_invalid', 'auth adapter with inspect() is required');
    this.adapter = adapter;
    this.resourceLeases = resourceLeases;
    this.now = now;
    this.expirySkewMs = expirySkewMs;
  }

  async inspect(input) {
    const spec = normalizeSpec(input);
    const observed = normalizeObserved(await this.adapter.inspect(spec), spec);
    return Object.freeze({
      ok: true, state: ready(observed, this.now, this.expirySkewMs) ? 'ready' : 'not-ready',
      sessionId: spec.sessionId, providerId: spec.providerId, accountAlias: spec.accountAlias, profileId: spec.profileId,
      authenticated: observed.authenticated, expiresAt: observed.expiresAt, refreshable: observed.refreshable, restorable: observed.restorable
    });
  }

  async ensure(input) {
    const spec = normalizeSpec(input);
    let observed = normalizeObserved(await this.adapter.inspect(spec), spec);
    if (ready(observed, this.now, this.expirySkewMs)) return this.#result('ready', 'existing-authorized-session', spec, observed, false);

    const mutation = observed.refreshable && this.adapter.refresh ? 'refresh' : observed.restorable && this.adapter.restore ? 'restore' : null;
    if (!mutation) return this.#result('reauth-required', observed.authenticated ? 'session-expired' : 'session-not-authorized', spec, observed, false);
    if (!spec.ownerTaskId || !spec.ownerActorId) throw new AuthBrokerError('auth_owner_required', 'auth refresh/restore requires task and actor ownership');

    let lease = null;
    if (this.resourceLeases) {
      lease = this.resourceLeases.acquire({
        resourceType: 'credential-writer', resourceId: `auth:${spec.providerId}:${spec.accountAlias}:${spec.profileId}`,
        ownerTaskId: spec.ownerTaskId, ownerActorId: spec.ownerActorId, accessMode: 'write', recoveryRef: `auth:${spec.sessionId}`
      });
    }
    try {
      const operation = mutation === 'refresh' ? this.adapter.refresh : this.adapter.restore;
      const mutationResult = await operation.call(this.adapter, {
        sessionId: spec.sessionId, providerId: spec.providerId, accountAlias: spec.accountAlias, profileId: spec.profileId, credentialRef: spec.credentialRef,
        ownerTaskId: spec.ownerTaskId, ownerActorId: spec.ownerActorId
      });
      rejectSensitive(mutationResult, `${mutation}_result`);
      observed = normalizeObserved(await this.adapter.inspect(spec), spec);
      if (!ready(observed, this.now, this.expirySkewMs)) return this.#result('reauth-required', `${mutation}-did-not-restore-session`, spec, observed, true);
      return this.#result('ready', mutation === 'refresh' ? 'authorized-session-refreshed' : 'authorized-session-restored', spec, observed, true);
    } finally {
      if (lease) this.resourceLeases.release(lease.leaseId, { ownerTaskId: spec.ownerTaskId, ownerActorId: spec.ownerActorId, reason: 'auth-mutation-complete' });
    }
  }

  #result(state, reason, spec, observed, mutated) {
    return Object.freeze({
      ok: state === 'ready', state, reason, mutated,
      sessionId: spec.sessionId, providerId: spec.providerId, accountAlias: spec.accountAlias, profileId: spec.profileId,
      authenticated: observed.authenticated, expiresAt: observed.expiresAt,
      nextAction: state === 'reauth-required' ? 'human-reauthenticate-exact-bound-account' : null
    });
  }
}