const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const UPSTREAM_NAMES = new Set(['agentdock', 'nexusdock', 'cccc']);

export class ComponentIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ComponentIdentityError';
    this.code = code;
  }
}

const DEFINITIONS = [
  { id: 'aicc-control-plane', displayName: 'AICC Control Plane', kind: 'core', aliases: ['control-plane'] },
  { id: 'aicc-remote-fabric', displayName: 'AICC Remote Fabric', kind: 'remote', aliases: ['remote-fabric'] },
  { id: 'aicc-relay', displayName: 'AICC Relay', kind: 'remote', aliases: ['remote-gateway', 'aicc-remote-gateway'], upstreamRef: 'nexusdock' },
  { id: 'aicc-endpoint', displayName: 'AICC Endpoint', kind: 'remote', aliases: ['device-agent', 'remote-device-agent'], upstreamRef: 'agentdock' },
  { id: 'aicc-remote-app', displayName: 'AICC Remote App', kind: 'remote', aliases: ['remote-mcp-app'] },
  { id: 'aicc-workspace', displayName: 'AICC Workspace', kind: 'policy', aliases: ['workspace-mcp', 'aicc-workspace-mcp'], compatibility: { toolPrefix: 'aicc_workspace_' } },
  { id: 'aicc-work-ledger', displayName: 'AICC Work Ledger', kind: 'state', aliases: ['control-plane-report', 'session-registry', 'user-action-ledger'] },
  { id: 'aicc-resource-lease', displayName: 'AICC Resource Lease', kind: 'policy', aliases: ['resource-lease'] },
  { id: 'aicc-browser-pool', displayName: 'AICC Browser Pool', kind: 'interaction', aliases: ['browser-session-broker', 'cdp-lease-provider'] },
  { id: 'aicc-focus-guard', displayName: 'AICC Focus Guard', kind: 'interaction', aliases: ['focus-guard'] },
  { id: 'aicc-auth-broker', displayName: 'AICC Auth Broker', kind: 'identity', aliases: ['auth-session-broker'] },
  { id: 'aicc-file-guard', displayName: 'AICC File Guard', kind: 'safety', aliases: ['file-guard'] },
  { id: 'aicc-web-bridge', displayName: 'AICC Web Bridge', kind: 'web', aliases: ['web-gpt', 'webgpt'], compatibility: { port: 17841 } },
  { id: 'rdc-recovery-path', displayName: 'RDC Recovery Path', kind: 'recovery', external: true, aliases: ['rdc'] }
];

function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function validateComponentIdentities(definitions = DEFINITIONS) {
  const ids = new Set();
  const names = new Set();
  const lookup = new Map();
  for (const input of definitions) {
    const id = normalized(input.id);
    if (!SAFE_ID.test(id)) throw new ComponentIdentityError('invalid_component_id', `invalid canonical component id: ${input.id}`);
    if (ids.has(id)) throw new ComponentIdentityError('duplicate_component_id', `duplicate canonical component id: ${id}`);
    const displayName = String(input.displayName ?? '').trim();
    if (!displayName) throw new ComponentIdentityError('invalid_display_name', `missing display name for ${id}`);
    const displayKey = displayName.toLowerCase();
    if (names.has(displayKey)) throw new ComponentIdentityError('duplicate_display_name', `duplicate display name: ${displayName}`);
    if ([...UPSTREAM_NAMES].some(name => id.includes(name))) {
      throw new ComponentIdentityError('upstream_name_in_canonical_id', `upstream project name cannot be a production canonical id: ${id}`);
    }
    if (input.upstreamRef && !UPSTREAM_NAMES.has(normalized(input.upstreamRef))) {
      throw new ComponentIdentityError('unknown_upstream_ref', `unknown upstream reference: ${input.upstreamRef}`);
    }
    ids.add(id);
    names.add(displayKey);
    for (const key of [id, ...(input.aliases ?? []).map(normalized)]) {
      if (!key) throw new ComponentIdentityError('invalid_component_alias', `empty component alias for ${id}`);
      const existing = lookup.get(key);
      if (existing && existing !== id) throw new ComponentIdentityError('duplicate_component_alias', `component alias ${key} maps to both ${existing} and ${id}`);
      lookup.set(key, id);
    }
  }
  return { ids, lookup };
}

const VALIDATED = validateComponentIdentities();
const BY_ID = new Map(DEFINITIONS.map(definition => [definition.id, Object.freeze({ ...definition, aliases: Object.freeze([...(definition.aliases ?? [])]) })]));

export const AICC_COMPONENT_IDENTITIES = Object.freeze([...BY_ID.values()]);

export function resolveComponentIdentity(value) {
  const id = VALIDATED.lookup.get(normalized(value));
  return id ? BY_ID.get(id) : null;
}

export function requireComponentIdentity(value) {
  const identity = resolveComponentIdentity(value);
  if (!identity) throw new ComponentIdentityError('unknown_component_identity', `unknown component identity: ${value}`);
  return identity;
}

export function canonicalComponentId(value) {
  return requireComponentIdentity(value).id;
}

export function componentDisplayName(value) {
  return requireComponentIdentity(value).displayName;
}