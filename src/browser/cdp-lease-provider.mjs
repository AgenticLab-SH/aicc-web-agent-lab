import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserIdentityHash, BrowserBrokerError } from './session-broker.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function invoke(runner, executable, args, { timeoutMs = 45_000 } = {}) {
  const result = runner(executable, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell: false });
  if (result.error) {
    const code = result.error.code === 'ETIMEDOUT' ? 'cdp_provider_timeout' : 'cdp_provider_failed';
    throw new BrowserBrokerError(code, result.error.message || 'CDP lease helper failed');
  }
  if (result.status !== 0) throw new BrowserBrokerError('cdp_provider_failed', result.stderr?.trim() || 'CDP lease helper failed');
  try { return JSON.parse(result.stdout); }
  catch { throw new BrowserBrokerError('cdp_provider_invalid', 'CDP lease helper did not return JSON'); }
}

export class CdpLeaseProvider {
  constructor({ runner = spawnSync, executable = 'pwsh', script = path.join(root, 'tools', 'platform', 'web-automation', 'Manage-CdpChromeSlotLease.ps1') } = {}) {
    this.runner = runner;
    this.executable = executable;
    this.script = script;
  }

  async acquire({ identity, url, ownerTaskId }) {
    if (identity.role !== 'registered-cdp') throw new BrowserBrokerError('provider_role_mismatch', 'CDP provider accepts registered CDP identities only');
    // The registered broker owns slot capacity, including retained/unknown
    // leases. A target client must not replace that policy with a slot limit.
    const args = ['-NoProfile', '-File', this.script, '-Action', 'Acquire', '-OwnerId', ownerTaskId, '-Url', url, '-AsJson'];
    if (identity.accountAlias) args.push('-AccountAlias', identity.accountAlias);
    if (identity.workspaceAlias) args.push('-Workspace', identity.workspaceAlias);
    if (identity.cdpEndpoint) args.push('-SlotPorts', String(new URL(identity.cdpEndpoint).port));
    const result = invoke(this.runner, this.executable, args);
    const lease = result.lease;
    if (!result.ok || !lease?.lease_token || !lease.target_id) throw new BrowserBrokerError('cdp_provider_invalid', 'CDP helper omitted exact lease capability or target');
    return {
      capability: lease.lease_token,
      targetId: lease.target_id,
      endpoint: lease.endpoint,
      ownership: 'task-created',
      identityHash: browserIdentityHash(identity)
    };
  }

  async heartbeat({ capability }) {
    const args = ['-NoProfile', '-File', this.script, '-Action', 'Heartbeat', '-LeaseToken', capability, '-AsJson'];
    let result;
    try {
      result = invoke(this.runner, this.executable, args, { timeoutMs: 12_000 });
    } catch (error) {
      // Repeat only the idempotent renewal for this exact task-owned lease.
      // An uncertain Acquire or Release must never be repeated.
      if (error.code !== 'cdp_provider_timeout') throw error;
      result = invoke(this.runner, this.executable, args, { timeoutMs: 12_000 });
    }
    return { ok: result.ok === true };
  }

  async release({ capability, targetId }) {
    const result = invoke(this.runner, this.executable, ['-NoProfile', '-File', this.script, '-Action', 'Release', '-LeaseToken', capability, '-AsJson']);
    if (result.target_id !== targetId) throw new BrowserBrokerError('target_mismatch', 'CDP helper released a different target');
    return { ok: result.ok === true, targetClosed: result.target_closed === true || result.status === 'released' };
  }

  capabilityFingerprint(capability) { return crypto.createHash('sha256').update(capability).digest('hex'); }
}
