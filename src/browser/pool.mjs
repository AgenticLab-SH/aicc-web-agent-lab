const LOOPBACK = new Set(['127.0.0.1', 'localhost']);

export class BrowserPoolError extends Error {
  constructor(code, message) { super(message); this.name = 'BrowserPoolError'; this.code = code; }
}

function normalizeSlot(slot) {
  if (!slot || typeof slot !== 'object') throw new BrowserPoolError('invalid_browser_slot', 'browser slot must be an object');
  const slotId = String(slot.slotId ?? '').trim();
  const identityId = String(slot.identityId ?? '').trim();
  const profileRoot = String(slot.profileRoot ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(slotId) || !identityId || !profileRoot) throw new BrowserPoolError('invalid_browser_slot', 'browser slot identity is invalid');
  let endpoint;
  try { endpoint = new URL(slot.cdpEndpoint); } catch { throw new BrowserPoolError('invalid_browser_slot', 'browser slot requires an explicit CDP endpoint'); }
  if (endpoint.protocol !== 'http:' || !LOOPBACK.has(endpoint.hostname) || !endpoint.port) throw new BrowserPoolError('invalid_browser_slot', 'CDP endpoint must be loopback with an explicit port');
  if (slot.automation !== true) throw new BrowserPoolError('user_browser_slot_prohibited', 'browser pool accepts automation-owned slots only');
  const port = Number(endpoint.port);
  return Object.freeze({ slotId, identityId, profileRoot, cdpEndpoint: endpoint.toString().replace(/\/$/, ''), port, resourceId: `cdp:${port}`, automation: true });
}

export class BrowserPool {
  constructor({ resourceLeases, slots = [] } = {}) {
    if (!resourceLeases?.acquire || !resourceLeases?.release) throw new BrowserPoolError('browser_pool_configuration_invalid', 'resource lease manager is required');
    this.resourceLeases = resourceLeases;
    this.slots = slots.map(normalizeSlot);
    const ids = new Set(); const ports = new Set(); const profiles = new Set();
    for (const slot of this.slots) {
      if (ids.has(slot.slotId) || ports.has(slot.port) || profiles.has(slot.profileRoot.toLowerCase())) throw new BrowserPoolError('duplicate_browser_slot', 'slot id, port, and profile root must be unique');
      ids.add(slot.slotId); ports.add(slot.port); profiles.add(slot.profileRoot.toLowerCase());
    }
  }

  acquire({ ownerTaskId, ownerActorId, preferredSlotId = null, recoveryRef = null } = {}) {
    const ordered = preferredSlotId ? [
      ...this.slots.filter(slot => slot.slotId === preferredSlotId),
      ...this.slots.filter(slot => slot.slotId !== preferredSlotId)
    ] : this.slots;
    if (preferredSlotId && !this.slots.some(slot => slot.slotId === preferredSlotId)) throw new BrowserPoolError('browser_slot_not_found', `unknown browser slot: ${preferredSlotId}`);
    for (const slot of ordered) {
      try {
        const lease = this.resourceLeases.acquire({ resourceType: 'browser-slot', resourceId: slot.resourceId, ownerTaskId, ownerActorId, accessMode: 'write', recoveryRef });
        return Object.freeze({ ...slot, leaseId: lease.leaseId, generation: lease.generation, ownerTaskId, ownerActorId });
      } catch (error) {
        if (error?.code !== 'resource_busy') throw error;
      }
    }
    throw new BrowserPoolError('browser_pool_exhausted', 'no automation browser slot is available');
  }

  release(allocation, reason = 'browser-slot-released') {
    if (!allocation?.leaseId || !allocation?.ownerTaskId || !allocation?.ownerActorId) throw new BrowserPoolError('invalid_browser_allocation', 'browser allocation is invalid');
    return this.resourceLeases.release(allocation.leaseId, { ownerTaskId: allocation.ownerTaskId, ownerActorId: allocation.ownerActorId, reason });
  }

  inventory() { return this.slots.map(slot => ({ ...slot })); }
}