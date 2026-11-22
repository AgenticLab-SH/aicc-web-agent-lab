import os from 'node:os';
import path from 'node:path';
import { DurableJobStore } from '../jobs/durable-store.mjs';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export class CaptchaBrowserGuardError extends Error {
  constructor(code, message = code) { super(message); this.name = 'CaptchaBrowserGuardError'; this.code = code; }
}

function fail(code) { throw new CaptchaBrowserGuardError(code); }

function origin(value) {
  let url;
  try { url = new URL(value); } catch { fail('captcha_browser_origin_invalid'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('captcha_browser_origin_invalid');
  return url.origin;
}

function active(record, now) {
  return record?.state === 'leased' && Number.isFinite(Date.parse(record.expiresAt)) && Date.parse(record.expiresAt) > now;
}

export function validateSlackCaptchaBrowserBinding(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('captcha_browser_binding_required');
  const browserLeaseId = String(value.browserLeaseId ?? '');
  const browserTargetId = String(value.browserTargetId ?? '');
  const browserOrigin = origin(String(value.browserOrigin ?? ''));
  if (!IDENTIFIER.test(browserLeaseId) || !IDENTIFIER.test(browserTargetId)) fail('captcha_browser_binding_invalid');
  return Object.freeze({ browserLeaseId, browserTargetId, browserOrigin });
}

export class SlackCaptchaBrowserLeaseGuard {
  constructor({ stateRoot = process.env.AICC_STATE_ROOT?.trim() || path.join(os.homedir(), '.ai-control-center'), store, now = () => Date.now() } = {}) {
    this.store = store ?? new DurableJobStore({ root: path.join(stateRoot, 'jobs'), create: false, now });
    this.now = now;
  }

  authorize({ taskId, ...browser }) {
    if (!IDENTIFIER.test(String(taskId ?? ''))) fail('captcha_browser_task_invalid');
    const binding = validateSlackCaptchaBrowserBinding(browser);
    const snapshot = this.store.read().state;
    const lease = snapshot.browserLeases?.[binding.browserLeaseId];
    if (!active(lease, this.now())) fail('captcha_browser_lease_inactive');
    if (lease.ownerTaskId !== taskId) fail('captcha_browser_task_mismatch');
    if (lease.targetId !== binding.browserTargetId) fail('captcha_browser_target_mismatch');
    if (lease.accessMode !== 'interact' || !Array.isArray(lease.capabilities) || !lease.capabilities.includes('type')) fail('captcha_browser_type_denied');
    if (!Array.isArray(lease.permittedOrigins) || !lease.permittedOrigins.includes(binding.browserOrigin)) fail('captcha_browser_origin_denied');

    if (lease.resourceLeaseId) {
      const resource = snapshot.resourceLeases?.[lease.resourceLeaseId];
      if (!active(resource, this.now()) || resource.resourceType !== 'browser-slot' || resource.resourceId !== lease.resourceId
        || resource.ownerTaskId !== lease.ownerTaskId || resource.ownerActorId !== lease.ownerAttemptId || resource.accessMode !== 'write') {
        fail('captcha_browser_resource_lease_invalid');
      }
    }

    return Object.freeze({
      ok: true, taskId, leaseId: binding.browserLeaseId, targetId: binding.browserTargetId, origin: binding.browserOrigin, capability: 'type'
    });
  }
}