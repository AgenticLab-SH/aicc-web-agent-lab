import { randomBytes } from 'node:crypto';
import { LocalAccessPolicyError, normalizeLocalGrant, stableHash } from './local-access-policy.mjs';

const CAPABILITY = /^local_read_cap_[a-f0-9]{64}$/;
const SOURCE_ID = /^local_source_[a-f0-9]{24}$/;
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function requireValue(value, pattern, code, message) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new LocalAccessPolicyError(code, message);
  return value;
}

export class LocalReadGrantAuthority {
  constructor({ resolveGrant, now = () => Date.now(), maximumTtlMs = 60 * 60_000 } = {}) {
    if (typeof resolveGrant !== 'function') throw new TypeError('LocalReadGrantAuthority requires a local UI grant resolver');
    this.resolveGrant = resolveGrant;
    this.now = now;
    this.maximumTtlMs = maximumTtlMs;
    this.capabilities = new Map();
  }

  async openRead({ grantRef, correlationId, expiresInSeconds = null } = {}) {
    requireValue(grantRef, /^local_grant_[A-Za-z0-9_-]{16,96}$/, 'local_grant_invalid', 'a local UI grant_ref is required');
    requireValue(correlationId, OPAQUE_REF, 'local_correlation_invalid', 'a valid correlation_id is required');
    const raw = await this.resolveGrant(grantRef);
    if (!raw || raw.grantRef !== grantRef) throw new LocalAccessPolicyError('local_grant_unknown', 'the local UI grant_ref is unknown or no longer approved');
    const grant = normalizeLocalGrant(raw, { now: this.now });
    if (grant.correlationId !== correlationId) throw new LocalAccessPolicyError('local_correlation_mismatch', 'the grant is bound to another correlation_id');
    const remaining = Date.parse(grant.expiresAt) - this.now();
    const requested = expiresInSeconds === null ? Math.min(remaining, this.maximumTtlMs) : Number(expiresInSeconds) * 1_000;
    if (!Number.isInteger(requested) || requested < 1_000 || requested > this.maximumTtlMs || requested > remaining) {
      throw new LocalAccessPolicyError('local_ttl_invalid', 'the requested read TTL exceeds the approved grant or process policy');
    }
    const capability = `local_read_cap_${randomBytes(32).toString('hex')}`;
    const issuedAt = this.now();
    const record = {
      grant,
      sourceId: grant.sourceId,
      sourceType: grant.sourceType,
      correlationId,
      capabilityHash: stableHash(capability),
      state: 'active',
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + requested).toISOString(),
      usedFiles: 0,
      usedBytes: 0,
      usedMatches: 0
    };
    this.capabilities.set(capability, record);
    return {
      capability,
      source: this.#publicRecord(record)
    };
  }

  resolve({ sourceId, capability, correlationId, requiredSourceType = null, requiredMode = 'read' } = {}) {
    requireValue(sourceId, SOURCE_ID, 'local_source_invalid', 'a valid source_id is required');
    requireValue(capability, CAPABILITY, 'local_capability_invalid', 'a valid read capability is required');
    requireValue(correlationId, OPAQUE_REF, 'local_correlation_invalid', 'a valid correlation_id is required');
    const record = this.capabilities.get(capability);
    if (!record || record.capabilityHash !== stableHash(capability)) throw new LocalAccessPolicyError('local_capability_invalid', 'the read capability is unknown or was invalidated by process restart');
    if (record.state !== 'active') throw new LocalAccessPolicyError('local_capability_closed', 'the read capability is closed');
    if (Date.parse(record.expiresAt) <= this.now()) {
      this.capabilities.delete(capability);
      record.state = 'expired';
      throw new LocalAccessPolicyError('local_capability_expired', 'the read capability has expired');
    }
    if (record.sourceId !== sourceId) throw new LocalAccessPolicyError('local_source_mismatch', 'the read capability is bound to another source');
    if (record.correlationId !== correlationId) throw new LocalAccessPolicyError('local_correlation_mismatch', 'the read capability is bound to another correlation_id');
    if (requiredMode !== 'read') throw new LocalAccessPolicyError('local_scope_denied', 'local read grants never provide write or exec capability');
    if (requiredSourceType && record.sourceType !== requiredSourceType) {
      throw new LocalAccessPolicyError('local_source_type_mismatch', `this tool requires a ${requiredSourceType} grant`);
    }
    return record;
  }

  consume(record, { files = 0, bytes = 0, matches = 0 } = {}) {
    for (const [value, label] of [[files, 'files'], [bytes, 'bytes'], [matches, 'matches']]) {
      if (!Number.isInteger(value) || value < 0) throw new LocalAccessPolicyError('local_budget_invalid', `${label} usage must be a non-negative integer`);
    }
    const budgets = record.grant.budgets;
    if (record.usedFiles + files > budgets.maxFiles) throw new LocalAccessPolicyError('local_file_budget_exceeded', 'the approved file-count budget is exhausted');
    if (bytes > budgets.maxReadBytes || record.usedBytes + bytes > budgets.maxRunBytes) {
      throw new LocalAccessPolicyError('local_byte_budget_exceeded', 'the approved read/run byte budget is exhausted');
    }
    if (record.usedMatches + matches > budgets.maxMatches) throw new LocalAccessPolicyError('local_match_budget_exceeded', 'the approved search match budget is exhausted');
    record.usedFiles += files;
    record.usedBytes += bytes;
    record.usedMatches += matches;
    return this.#publicRecord(record);
  }

  close({ sourceId, capability, correlationId } = {}) {
    const record = this.resolve({ sourceId, capability, correlationId });
    this.capabilities.delete(capability);
    record.state = 'closed';
    return { closed: true, sourceId: record.sourceId, auditHash: record.grant.auditHash };
  }

  status() {
    const active = [...this.capabilities.values()].filter(record => record.state === 'active' && Date.parse(record.expiresAt) > this.now());
    return {
      active: active.length,
      rawCapabilitiesDurable: false,
      sources: active.map(record => this.#publicRecord(record))
    };
  }

  #publicRecord(record) {
    return {
      sourceId: record.sourceId,
      sourceType: record.sourceType,
      label: record.grant.label,
      correlationId: record.correlationId,
      expiresAt: record.expiresAt,
      policyHash: record.grant.policyHash,
      auditHash: record.grant.auditHash,
      previewFileCount: record.grant.preview.fileCount,
      budgets: record.grant.budgets,
      usage: { files: record.usedFiles, bytes: record.usedBytes, matches: record.usedMatches },
      mode: 'read-only',
      write: false,
      exec: false
    };
  }
}
