const DEFAULT_CORE_ROUTE_IDS = Object.freeze([
  'aicc-dashboard',
  'workspace-mcp',
  'workspace-tunnel',
  'web-gpt-integrated',
  'web-gpt-rescue',
  'ocx',
  'native-direct'
]);

export class ProjectServiceLinkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProjectServiceLinkError';
    this.code = code;
  }
}

function safeId(value, field = 'serviceProfileId') {
  const id = String(value ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new ProjectServiceLinkError('invalid_service_profile_id', `${field} must be an exact lowercase slug`);
  }
  return id;
}

export function buildProjectServiceAllowlist(manifest, options = {}) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.projects) || !Array.isArray(manifest.policy?.requiredCoreLabels)) {
    throw new ProjectServiceLinkError('invalid_service_manifest', 'project service manifest schema is unsupported');
  }
  const reserved = new Set([
    ...DEFAULT_CORE_ROUTE_IDS,
    ...(options.coreRouteIds ?? []),
    ...manifest.policy.requiredCoreLabels
  ].map(value => String(value).trim()).filter(Boolean));
  const profiles = new Map();
  for (const profile of manifest.projects) {
    const id = safeId(profile?.id, 'project service profile id');
    if (reserved.has(id)) {
      throw new ProjectServiceLinkError('core_service_in_allowlist', `core route cannot be registered as a project service: ${id}`);
    }
    if (profiles.has(id)) {
      throw new ProjectServiceLinkError('duplicate_service_profile', `duplicate project service profile: ${id}`);
    }
    profiles.set(id, {
      id,
      label: typeof profile.label === 'string' && profile.label.trim() ? profile.label.trim() : id,
      healthUrl: typeof profile.healthUrl === 'string' && profile.healthUrl.trim() ? profile.healthUrl.trim() : null,
      listenPort: Number.isInteger(profile.listenPort) ? profile.listenPort : null
    });
  }
  return { profiles, reserved };
}

export function resolveProjectServiceLink(project, { manifest, coreRouteIds = [] } = {}) {
  const configured = project?.serviceProfileId;
  if (configured === null || configured === undefined || configured === '') {
    return { linked: false, serviceProfileId: null, reason: 'not-configured' };
  }
  const requested = String(configured).trim();
  const { profiles, reserved } = buildProjectServiceAllowlist(manifest, { coreRouteIds });
  if (reserved.has(requested)) {
    throw new ProjectServiceLinkError('core_service_forbidden', `core route is not a project lifecycle target: ${requested}`);
  }
  const id = safeId(requested);
  const profile = profiles.get(id);
  if (!profile) {
    throw new ProjectServiceLinkError('unknown_service_profile', `serviceProfileId is not explicitly allowlisted: ${id}`);
  }
  return {
    linked: true,
    serviceProfileId: profile.id,
    label: profile.label,
    healthUrl: profile.healthUrl,
    listenPort: profile.listenPort,
    actionContract: {
      exactProfileMatch: true,
      previewRequired: true,
      confirmationRequired: true,
      arbitraryCommandAllowed: false
    }
  };
}
