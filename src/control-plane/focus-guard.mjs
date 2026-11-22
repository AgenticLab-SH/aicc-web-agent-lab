const ROUTES = Object.freeze(['direct','structured-ui','background-browser','foreground-computer-use','coordinate-fallback']);

export class FocusGuardError extends Error {
  constructor(code, message) { super(message); this.name = 'FocusGuardError'; this.code = code; }
}

export function selectInteractionRoute(input = {}) {
  if (input.directAvailable === true) return { route: 'direct', foreground: false, reason: 'direct-capability-available' };
  if (input.structuredUiAvailable === true) return { route: 'structured-ui', foreground: false, reason: 'structured-ui-available' };
  if (input.backgroundBrowserAvailable === true) return { route: 'background-browser', foreground: false, reason: 'background-browser-available' };
  if (input.foregroundComputerUseAvailable === true) {
    if (input.userActive === true && input.mutation !== false) throw new FocusGuardError('user_focus_busy', 'foreground mutation is blocked while user activity is present');
    if (!input.exactTargetId) throw new FocusGuardError('exact_focus_target_required', 'foreground Computer Use requires an exact target');
    return { route: 'foreground-computer-use', foreground: true, reason: 'foreground-required' };
  }
  if (input.coordinateFallbackAllowed === true) {
    if (!input.exactTargetId) throw new FocusGuardError('exact_focus_target_required', 'coordinate fallback requires an exact target');
    if (input.userActive === true && input.mutation !== false) throw new FocusGuardError('user_focus_busy', 'coordinate mutation is blocked while user activity is present');
    return { route: 'coordinate-fallback', foreground: true, reason: 'structured-routes-unavailable' };
  }
  throw new FocusGuardError('interaction_route_unavailable', 'no safe interaction route is available');
}

export class FocusGuard {
  constructor({ resourceLeases } = {}) {
    if (!resourceLeases?.acquire || !resourceLeases?.release) throw new FocusGuardError('focus_guard_configuration_invalid', 'resource lease manager is required');
    this.resourceLeases = resourceLeases;
  }

  begin({ ownerTaskId, ownerActorId, exactTargetId, userActive = false, mutation = true, routeOptions = {}, recoveryRef = null } = {}) {
    const route = selectInteractionRoute({ ...routeOptions, exactTargetId, userActive, mutation });
    if (!route.foreground) return Object.freeze({ ...route, leaseId: null, exactTargetId: exactTargetId ?? null, ownerTaskId, ownerActorId });
    const lease = this.resourceLeases.acquire({ resourceType: 'ui-focus', resourceId: exactTargetId, ownerTaskId, ownerActorId, accessMode: 'write', recoveryRef });
    return Object.freeze({ ...route, leaseId: lease.leaseId, generation: lease.generation, exactTargetId, ownerTaskId, ownerActorId });
  }

  authorize(session) {
    if (!session?.foreground) return { ok: true, foreground: false, route: session?.route ?? 'direct' };
    return this.resourceLeases.authorize(session.leaseId, { resourceType: 'ui-focus', resourceId: session.exactTargetId, ownerTaskId: session.ownerTaskId, ownerActorId: session.ownerActorId, accessMode: 'write' });
  }

  end(session, reason = 'focus-released') {
    if (!session?.foreground || !session.leaseId) return { ok: true, released: false };
    const lease = this.resourceLeases.release(session.leaseId, { ownerTaskId: session.ownerTaskId, ownerActorId: session.ownerActorId, reason });
    return { ok: true, released: true, lease };
  }
}

export const AICC_INTERACTION_ROUTES = ROUTES;