const GiB = 1024 ** 3;

export const OCX_STORAGE_POLICY_VERSION = 1;

export const OCX_STORAGE_BUCKET_POLICIES = Object.freeze({
  auth_account_state: Object.freeze({
    class: 'auth-account-state',
    owner: 'OCX credential and account stores',
    retention: 'owner-managed; no automatic expiry or relocation',
    quotaBytes: null,
    compaction: 'owner procedure only',
    backup: 'owner-provided backup before any mutation',
    erase: 'explicit owner procedure only',
    recoverability: 'not assumed by AICC',
    cleanupEligible: false
  }),
  sessions: Object.freeze({
    class: 'session-metadata',
    owner: 'OCX Codex-home runtime',
    retention: 'active sessions retained until the owner archives them',
    quotaBytes: null,
    compaction: 'not performed by AICC',
    backup: 'required before owner mutation',
    erase: 'never selected by archived-session cleanup',
    recoverability: 'owner history and database contract',
    cleanupEligible: false
  }),
  archived_sessions: Object.freeze({
    class: 'session-metadata',
    owner: 'OCX storage cleanup engine',
    retention: 'default cleanup disabled; owner preview selects oldest archives only',
    quotaBytes: 5 * GiB,
    compaction: 'owner preview plus exact digest; active writer check required',
    backup: 'complete satellite database backup before commit',
    erase: 'quarantine only unless a separately approved permanent policy exists',
    recoverability: 'OCX trash manifest and owner restore workflow',
    cleanupEligible: true
  }),
  logs_db: Object.freeze({
    class: 'session-logs',
    owner: 'OCX SQLite writer',
    retention: 'owner-managed with archived-session reconciliation',
    quotaBytes: null,
    compaction: 'owner-only checkpoint or vacuum after exclusive writer proof',
    backup: 'SQLite online backup or owner transaction required',
    erase: 'never deleted directly by AICC',
    recoverability: 'owner database backup',
    cleanupEligible: false
  }),
  state_db: Object.freeze({
    class: 'session-account-state',
    owner: 'OCX SQLite writer',
    retention: 'indefinite while referenced by accounts, sessions, jobs, or history',
    quotaBytes: null,
    compaction: 'owner-only checkpoint or vacuum after exclusive writer proof',
    backup: 'SQLite online backup required',
    erase: 'never deleted directly by AICC',
    recoverability: 'owner database backup',
    cleanupEligible: false
  }),
  response_cache: Object.freeze({
    class: 'response-spill-cache',
    owner: 'OCX runtime',
    retention: 'bounded by the runtime memory/cache policy',
    quotaBytes: 256 * 1024 ** 2,
    compaction: 'runtime eviction only; must not terminate router or Web GPT',
    backup: 'not required for rebuildable entries; pinned continuation state is excluded',
    erase: 'owner eviction only',
    recoverability: 'rebuildable except explicitly pinned continuation state',
    cleanupEligible: false
  }),
  attachments: Object.freeze({
    class: 'attachments-artifacts',
    owner: 'OCX Codex-home runtime',
    retention: 'retain while referenced by any session or artifact manifest',
    quotaBytes: null,
    compaction: 'none',
    backup: 'required before any owner deletion',
    erase: 'reference-counted owner quarantine only',
    recoverability: 'owner trash or source artifact',
    cleanupEligible: false
  }),
  deletion_manifests: Object.freeze({
    class: 'rollback-metadata',
    owner: 'OCX storage cleanup engine',
    retention: 'retain through the rollback window',
    quotaBytes: null,
    compaction: 'owner procedure only after restore is impossible or expired',
    backup: 'part of the cleanup transaction',
    erase: 'never before rollback expiry',
    recoverability: 'required to restore quarantined archives',
    cleanupEligible: false
  }),
  other: Object.freeze({
    class: 'mixed-unknown-and-rebuildable',
    owner: 'multiple application owners',
    retention: 'UNKNOWN until every exact path is classified',
    quotaBytes: null,
    compaction: 'none at aggregate-bucket level',
    backup: 'required for non-rebuildable paths',
    erase: 'blocked at aggregate-bucket level',
    recoverability: 'path-specific and currently UNKNOWN',
    cleanupEligible: false
  })
});

function finiteNumber(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function projectObservedBucket(bucket) {
  const key = typeof bucket?.key === 'string' ? bucket.key : 'other';
  const policy = OCX_STORAGE_BUCKET_POLICIES[key] ?? OCX_STORAGE_BUCKET_POLICIES.other;
  return {
    key,
    class: policy.class,
    owner: policy.owner,
    bytes: finiteNumber(bucket?.bytes),
    fileCount: finiteNumber(bucket?.fileCount),
    rows: finiteNumber(bucket?.rows),
    retention: policy.retention,
    quotaBytes: policy.quotaBytes,
    compaction: policy.compaction,
    backup: policy.backup,
    erase: policy.erase,
    recoverability: policy.recoverability,
    cleanupEligible: policy.cleanupEligible
  };
}

export function projectOcxStorageGovernance(storage) {
  const observed = Array.isArray(storage?.buckets) ? storage.buckets.map(projectObservedBucket) : [];
  const observedKeys = new Set(observed.map(bucket => bucket.key));
  const synthetic = ['auth_account_state', 'response_cache']
    .filter(key => !observedKeys.has(key))
    .map(key => projectObservedBucket({ key }));
  return {
    policyVersion: OCX_STORAGE_POLICY_VERSION,
    owner: 'ocx-upstream',
    totalBytes: finiteNumber(storage?.total?.bytes),
    fileCount: finiteNumber(storage?.total?.fileCount),
    quota: {
      state: 'per-bucket-policy',
      aggregateQuotaBytes: null,
      overQuotaAction: 'report-and-defer; never stop OCX, router 17841, or Web GPT'
    },
    defaultCleanupEnabled: false,
    mutationAuthority: 'OCX owner API with exact preview digest and exclusive storage writer',
    buckets: [...observed, ...synthetic],
    unknownBuckets: observed.filter(bucket => bucket.class === 'mixed-unknown-and-rebuildable').map(bucket => bucket.key)
  };
}

function safeArchivedPath(value) {
  return typeof value === 'string'
    && value.startsWith('archived_sessions/')
    && !value.includes('..')
    && !value.includes('\\')
    && value.split('/').length === 2;
}

export function validateOcxCleanupDryRun(preview, options = {}) {
  const blockers = [];
  const count = Number.isInteger(preview?.count) && preview.count >= 0 ? preview.count : null;
  const bytes = finiteNumber(preview?.bytes);
  const digest = typeof preview?.digest === 'string' ? preview.digest : '';
  const candidates = Array.isArray(preview?.candidates) ? preview.candidates : [];
  const complete = count !== null && candidates.length === count;
  if (!complete) blockers.push('incomplete_preview');
  if (!/^[a-f0-9]{64}$/i.test(digest)) blockers.push('invalid_digest');
  if (bytes === null) blockers.push('invalid_bytes');
  const projected = [];
  for (const candidate of candidates) {
    const physical = Array.isArray(candidate?.physicalRelPaths) ? candidate.physicalRelPaths : [];
    if (!safeArchivedPath(candidate?.relPath) || !physical.length || physical.some(path => !safeArchivedPath(path))) {
      blockers.push('unsafe_or_non_archived_target');
      continue;
    }
    const candidateBytes = finiteNumber(candidate?.bytes);
    const mtimeMs = finiteNumber(candidate?.mtimeMs);
    if (candidateBytes === null || mtimeMs === null) {
      blockers.push('incomplete_target_metadata');
      continue;
    }
    projected.push({
      relPath: candidate.relPath,
      physicalRelPaths: physical,
      bytes: candidateBytes,
      mtimeMs
    });
  }
  const projectedBytes = projected.reduce((sum, item) => sum + item.bytes, 0);
  if (bytes !== null && complete && projectedBytes !== bytes) blockers.push('byte_total_mismatch');
  const activeTurns = Number.isInteger(options.activeTurns) ? options.activeTurns : null;
  if (activeTurns === null) blockers.push('active_turns_unknown');
  else if (activeTurns !== 0) blockers.push('active_turns_nonzero');
  if (options.mode !== 'quarantine') blockers.push('quarantine_required');
  if (options.backupVerified !== true) blockers.push('backup_not_verified');
  if (options.integrityBefore !== 'ok') blockers.push('integrity_not_verified');
  if (options.approved !== true) blockers.push('explicit_approval_required');
  return {
    status: blockers.length ? 'HOLD' : 'PASS',
    exactTargetCount: projected.length,
    exactBytes: projectedBytes,
    digest,
    targets: projected,
    blockers: [...new Set(blockers)],
    applyAllowed: blockers.length === 0,
    rollback: {
      mechanism: 'OCX owner quarantine manifest and trash restore',
      verification: 'post-restore storage scan plus SQLite quick_check',
      permanentDeleteAllowed: false
    }
  };
}
