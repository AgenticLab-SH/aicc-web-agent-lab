import crypto from 'node:crypto';
import { LocalAccessGrantStore, LocalAccessGrantStoreError } from './grant-store.mjs';

const CONFIRMATION = /^local_confirm_[a-f0-9]{64}$/;

export class LocalAccessServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalAccessServiceError';
    this.code = code;
  }
}

export class LocalAccessService {
  constructor({ store, now = () => Date.now(), confirmationTtlMs = 5 * 60_000, ...options } = {}) {
    this.now = now;
    this.store = store ?? new LocalAccessGrantStore({ now, ...options });
    this.confirmationTtlMs = confirmationTtlMs;
    this.confirmations = new Map();
  }

  #confirmation(kind, record) {
    const token = `local_confirm_${crypto.randomBytes(32).toString('hex')}`;
    this.confirmations.set(token, { kind, record, expiresAt: this.now() + this.confirmationTtlMs });
    return token;
  }

  #consume(token, kind) {
    if (typeof token !== 'string' || !CONFIRMATION.test(token)) throw new LocalAccessServiceError('confirmation_invalid', 'a valid one-use confirmation token is required');
    const pending = this.confirmations.get(token);
    this.confirmations.delete(token);
    if (!pending || pending.kind !== kind) throw new LocalAccessServiceError('confirmation_invalid', 'the confirmation token is unknown, consumed, or for another action');
    if (pending.expiresAt <= this.now()) throw new LocalAccessServiceError('confirmation_expired', 'the confirmation token expired');
    return pending.record;
  }

  status() {
    const grants = this.store.listGrants();
    return {
      schemaVersion: 1,
      defaultReadOnly: true,
      wholeHomeAlias: false,
      rawCapabilitiesDurable: false,
      grants,
      summary: {
        total: grants.length,
        active: grants.filter(grant => !grant.expired).length,
        expired: grants.filter(grant => grant.expired).length
      }
    };
  }

  previewGrant(input = {}) {
    const record = this.store.prepareGrant(input);
    const confirmationToken = this.#confirmation('grant', record);
    return {
      schemaVersion: 1,
      requiresConfirmation: true,
      confirmationToken,
      confirmationExpiresAt: new Date(this.now() + this.confirmationTtlMs).toISOString(),
      grant: {
        grantRef: record.grantRef,
        sourceId: record.sourceId,
        sourceType: record.sourceType,
        label: record.label,
        canonicalRoot: record.canonicalRoot,
        includes: record.includes,
        denies: record.denies,
        policy: record.policy,
        budgets: record.budgets,
        preview: record.preview,
        correlationId: record.correlationId,
        expiresAt: record.expiresAt,
        policyHash: record.policyHash,
        auditHash: record.auditHash,
        mode: 'read-only',
        write: false,
        exec: false
      }
    };
  }

  confirmGrant(confirmationToken) {
    const record = this.#consume(confirmationToken, 'grant');
    return { ok: true, grant: this.store.issueGrant(record) };
  }

  previewExcerpt(input = {}) {
    const record = this.store.prepareExcerptApproval(input);
    const confirmationToken = this.#confirmation('excerpt', record);
    return {
      schemaVersion: 1,
      requiresConfirmation: true,
      confirmationToken,
      confirmationExpiresAt: new Date(this.now() + this.confirmationTtlMs).toISOString(),
      approval: record
    };
  }

  confirmExcerpt(confirmationToken) {
    const record = this.#consume(confirmationToken, 'excerpt');
    return { ok: true, approval: this.store.issueExcerptApproval(record) };
  }

  resolveGrant(grantRef) { return this.store.resolveGrant(grantRef); }
  resolveExcerptApproval(input) { return this.store.resolveExcerptApproval(input); }
}

export function createLocalAccessService(options = {}) {
  try { return new LocalAccessService(options); }
  catch (error) {
    if (error instanceof LocalAccessGrantStoreError) throw error;
    throw error;
  }
}
