const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_MODE = 'read-only';

export class OobAdapterError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'OobAdapterError';
    this.code = code;
  }
}

function requireId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new OobAdapterError('oob_descriptor_invalid', `${label} must be an opaque stable ID`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new OobAdapterError('oob_identity_ref_invalid', `${label} must be a SHA-256 identity reference`);
  }
  return value;
}

export function normalizeOobAdapterDescriptor(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OobAdapterError('oob_descriptor_invalid', 'OOB adapter descriptor must be an object');
  }
  if (input.schemaVersion !== 1) throw new OobAdapterError('oob_descriptor_invalid', 'unsupported OOB adapter schema version');
  if (input.routeClass !== 'oob_ops') throw new OobAdapterError('oob_route_class_invalid', 'OOB adapters must use routeClass=oob_ops');
  if (input.normalFallback !== false) throw new OobAdapterError('oob_fallback_forbidden', 'OOB adapters cannot be a silent normal-work fallback');
  if (input.sharesWorkspaceTunnel !== false || input.sharesWorkspaceIdentity !== false) {
    throw new OobAdapterError('oob_failure_domain_violation', 'OOB adapters cannot share Workspace Tunnel or identity');
  }
  if (input.storesRawCredentials !== false) {
    throw new OobAdapterError('oob_secret_storage_forbidden', 'OOB adapters cannot store raw credentials in the control plane');
  }
  if ((input.defaultMode ?? DEFAULT_MODE) !== DEFAULT_MODE) {
    throw new OobAdapterError('oob_default_mode_invalid', 'OOB adapter default mode must be read-only');
  }
  const capabilities = [...new Set(input.capabilities ?? [])].map(value => requireId(value, 'capability'));
  return Object.freeze({
    schemaVersion: 1,
    adapterId: requireId(input.adapterId, 'adapterId'),
    routeClass: 'oob_ops',
    transport: requireId(input.transport, 'transport'),
    defaultMode: DEFAULT_MODE,
    normalFallback: false,
    recoveryOnly: input.recoveryOnly !== false,
    sharesWorkspaceTunnel: false,
    sharesWorkspaceIdentity: false,
    storesRawCredentials: false,
    capabilities
  });
}

export function createOobReadJobSpec({
  descriptor,
  jobId,
  operationId = null,
  idempotencyKey,
  workspaceId,
  identityBinding,
  routeInstanceRef,
  requestRef,
  requestHash,
  workloadClass = 'remote'
} = {}) {
  const adapter = normalizeOobAdapterDescriptor(descriptor);
  const instanceHash = requireSha256(routeInstanceRef, 'routeInstanceRef');
  return {
    jobId: requireId(jobId, 'jobId'),
    operationId: operationId == null ? requireId(jobId, 'jobId') : requireId(operationId, 'operationId'),
    idempotencyKey: requireId(idempotencyKey, 'idempotencyKey'),
    workloadClass,
    workspaceId,
    direction: 'oob_ops',
    requestedRoute: adapter.adapterId,
    routeClass: 'oob_ops',
    routeInstanceRef: instanceHash,
    identityBinding,
    mode: 'read-only',
    requestRef,
    requestHash
  };
}
