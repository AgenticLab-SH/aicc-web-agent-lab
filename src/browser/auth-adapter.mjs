import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registeredCdpSlots } from './registry.mjs';
import { inspectSlot, verificationResult } from '../../tools/platform/web-automation/cdp-identity-bootstrap.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export class BrowserAuthAdapterError extends Error {
  constructor(code, message) { super(message); this.name = 'BrowserAuthAdapterError'; this.code = code; }
}

function exactSlot(spec, options) {
  const slots = registeredCdpSlots(options);
  const slot = slots.find(item => item.slotId === spec.profileId && item.accountAlias === spec.accountAlias);
  if (!slot) throw new BrowserAuthAdapterError('auth_binding_not_registered', 'expected account/profile binding is not registered');
  if (!slot.automaticLeaseEligible) throw new BrowserAuthAdapterError('auth_binding_not_eligible', 'registered account/profile binding is not eligible for automatic use');
  return slot;
}

function bootstrapSlot(slot) {
  return {
    port: slot.port,
    endpoint: slot.cdpEndpoint,
    profile: slot.profileRoot,
    alias: slot.accountAlias,
    reserved: false
  };
}

function safeObserved(spec, authenticated, extras = {}) {
  return {
    authenticated,
    accountAlias: spec.accountAlias,
    profileId: spec.profileId,
    expiresAt: null,
    refreshable: false,
    restorable: extras.restorable === true,
    stateRef: extras.stateRef ?? null
  };
}

export class RegisteredCdpAuthAdapter {
  constructor(options = {}) {
    this.inventoryOptions = options.inventoryOptions ?? {};
    this.inspectIdentity = options.inspectIdentity ?? inspectSlot;
    this.verifyIdentity = options.verifyIdentity ?? verificationResult;
    this.runner = options.runner ?? spawnSync;
    this.resourceLeases = options.resourceLeases ?? null;
    this.executable = options.executable ?? 'pwsh';
    this.leaseScript = options.leaseScript ?? path.join(root, 'tools', 'platform', 'web-automation', 'Manage-CdpChromeSlotLease.ps1');
  }

  async inspect(spec) {
    const slot = exactSlot(spec, this.inventoryOptions);
    let identity;
    try { identity = await this.inspectIdentity(bootstrapSlot(slot)); }
    catch (error) {
      if (error?.message === 'cdp_offline') return safeObserved(spec, false, { restorable: true, stateRef: `cdp:${slot.port}:offline` });
      throw new BrowserAuthAdapterError('auth_identity_inspection_failed', 'registered CDP identity inspection failed');
    }
    const verified = this.verifyIdentity(bootstrapSlot(slot), identity);
    return safeObserved(spec, verified.binding_verified === true, {
      restorable: false,
      stateRef: `cdp:${slot.port}:${verified.verification_scope}`
    });
  }

  async restore(spec) {
    const slot = exactSlot(spec, this.inventoryOptions);
    let slotLease = null;
    if (this.resourceLeases) {
      if (!spec.ownerTaskId || !spec.ownerActorId) throw new BrowserAuthAdapterError('auth_restore_owner_required', 'registered profile restore requires task and actor ownership');
      slotLease = this.resourceLeases.acquire({
        resourceType: 'browser-slot',
        resourceId: `cdp:${slot.port}`,
        ownerTaskId: spec.ownerTaskId,
        ownerActorId: spec.ownerActorId,
        accessMode: 'write',
        recoveryRef: `auth-restore:${spec.sessionId}`
      });
    }

    try {
      const args = [
        '-NoProfile', '-File', this.leaseScript, '-Action', 'Acquire',
        '-OwnerId', `auth-${spec.sessionId}`,
        '-Url', 'https://chatgpt.com/',
        '-WaitSec', '3',
        '-MaxTargetsPerSlot', '1',
        '-SlotPorts', String(slot.port),
        '-AccountAlias', slot.accountAlias,
        '-Workspace', slot.workspace,
        '-AsJson'
      ];
      const acquired = this.runner(this.executable, args, { encoding: 'utf8', timeout: 45_000, windowsHide: true, shell: false });
      if (acquired.error || acquired.status !== 0) throw new BrowserAuthAdapterError('auth_restore_failed', 'registered browser profile could not be started safely');
      let payload;
      try { payload = JSON.parse(acquired.stdout); } catch { throw new BrowserAuthAdapterError('auth_restore_failed', 'registered browser lease helper returned invalid output'); }
      const token = payload?.lease?.lease_token;
      const targetId = payload?.lease?.target_id;
      if (!payload?.ok || !token || !targetId) throw new BrowserAuthAdapterError('auth_restore_failed', 'registered browser lease helper did not return an exact owned target');

      const released = this.runner(this.executable, ['-NoProfile', '-File', this.leaseScript, '-Action', 'Release', '-LeaseToken', token, '-AsJson'], {
        encoding: 'utf8', timeout: 45_000, windowsHide: true, shell: false
      });
      if (released.error || released.status !== 0) throw new BrowserAuthAdapterError('auth_restore_cleanup_failed', 'temporary auth restore target could not be released safely');
      let releasePayload;
      try { releasePayload = JSON.parse(released.stdout); } catch { throw new BrowserAuthAdapterError('auth_restore_cleanup_failed', 'auth restore release helper returned invalid output'); }
      if (!releasePayload?.ok || releasePayload.target_id !== targetId) throw new BrowserAuthAdapterError('auth_restore_cleanup_failed', 'auth restore release did not confirm the exact owned target');
      return { ok: true, startedRegisteredProfile: true };
    } finally {
      if (slotLease) {
        this.resourceLeases.release(slotLease.leaseId, {
          ownerTaskId: spec.ownerTaskId,
          ownerActorId: spec.ownerActorId,
          reason: 'auth-profile-restore-complete'
        });
      }
    }
  }
}