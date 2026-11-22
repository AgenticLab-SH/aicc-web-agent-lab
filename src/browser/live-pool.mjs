import { BrowserPool, BrowserPoolError } from './pool.mjs';
import { liveCdpSlotInventory } from './registry.mjs';

export class LiveBrowserPool {
  constructor({ resourceLeases, inventoryOptions = {}, inventory = liveCdpSlotInventory } = {}) {
    if (!resourceLeases?.acquire || !resourceLeases?.release) throw new BrowserPoolError('browser_pool_configuration_invalid', 'resource lease manager is required');
    this.resourceLeases = resourceLeases;
    this.inventoryOptions = inventoryOptions;
    this.inventoryReader = inventory;
  }

  snapshot() {
    return this.inventoryReader(this.inventoryOptions);
  }

  acquire(input = {}) {
    const inventory = this.snapshot();
    const eligible = inventory.filter(slot => slot.poolEligible).map(slot => ({
      slotId: slot.slotId,
      identityId: slot.identityId,
      profileRoot: slot.profileRoot,
      cdpEndpoint: slot.cdpEndpoint,
      automation: true
    }));
    if (!eligible.length) throw new BrowserPoolError('browser_pool_exhausted', 'no live registered CDP slot is currently eligible');
    const pool = new BrowserPool({ resourceLeases: this.resourceLeases, slots: eligible });
    return pool.acquire(input);
  }

  release(allocation, reason = 'browser-slot-released') {
    const pool = new BrowserPool({ resourceLeases: this.resourceLeases, slots: [{
      slotId: allocation.slotId, identityId: allocation.identityId, profileRoot: allocation.profileRoot,
      cdpEndpoint: allocation.cdpEndpoint, automation: true
    }] });
    return pool.release(allocation, reason);
  }

  reconcile() {
    const recovered = this.resourceLeases.recoverExpired();
    const inventory = this.snapshot();
    return {
      recoveredResourceLeases: recovered.stale,
      eligibleSlots: inventory.filter(slot => slot.poolEligible).map(slot => slot.slotId),
      externallyBusySlots: inventory.filter(slot => slot.externallyBusy).map(slot => slot.slotId),
      policyExcludedSlots: inventory.filter(slot => !slot.automaticLeaseEligible).map(slot => slot.slotId)
    };
  }
}