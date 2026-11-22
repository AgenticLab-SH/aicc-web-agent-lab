import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalReadGrantAuthority } from '../components/workspace-mcp/local-read-grant-authority.mjs';
import {
  assertGrantedRelativePath,
  contentDisposition,
  localAuditHash,
  localPolicyHash,
  normalizeLocalGrant,
  redactLocalText
} from '../components/workspace-mcp/local-access-policy.mjs';

const FIXTURE = path.resolve('test/fixtures/local-access/local');
const NOW = Date.parse('2026-08-15T03:00:00.000Z');

function tempRoot(t, basename = 'approved-root') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-local-policy-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, basename);
  fs.cpSync(FIXTURE, root, { recursive: true });
  return { temporary, root: fs.realpathSync(root) };
}

function grantFor(root, overrides = {}) {
  const sourceType = overrides.sourceType ?? 'local';
  const sourceId = overrides.sourceId ?? 'local_source_0123456789abcdef01234567';
  const correlationId = overrides.correlationId ?? 'correlation-local-policy';
  const includes = overrides.includes ?? ['**/*'];
  const denies = overrides.denies ?? ['private/**'];
  const policy = { wholeHomeApproved: false, applicationSupportApproved: false, ...overrides.policy };
  const budgets = {
    maxFiles: 100,
    maxFileBytes: 1024 * 1024,
    maxReadBytes: 2 * 1024 * 1024,
    maxRunBytes: 4 * 1024 * 1024,
    maxMatches: 100,
    ...overrides.budgets
  };
  const canonicalRoot = fs.realpathSync(root);
  const approvedAt = overrides.approvedAt ?? '2026-08-15T02:00:00.000Z';
  const expiresAt = overrides.expiresAt ?? '2026-08-15T04:00:00.000Z';
  const policyHash = localPolicyHash({ sourceType, canonicalRoot, includes, denies, policy, budgets });
  const previewFileCount = overrides.previewFileCount ?? 4;
  const auditHash = localAuditHash({ sourceId, policyHash, correlationId, approvedAt, expiresAt, previewFileCount });
  return {
    schemaVersion: 1,
    grantRef: overrides.grantRef ?? 'local_grant_0123456789abcdef',
    sourceId,
    sourceType,
    label: 'Synthetic approved source',
    root: canonicalRoot,
    canonicalRoot,
    includes,
    denies,
    policy,
    budgets,
    preview: { fileCount: previewFileCount, policyHash },
    correlationId,
    approvedAt,
    expiresAt,
    policyHash,
    auditHash
  };
}

test('grant normalization binds exact canonical root, preview policy hash, budgets, TTL, and audit hash', t => {
  const { root } = tempRoot(t);
  const raw = grantFor(root);
  const grant = normalizeLocalGrant(raw, { now: () => NOW });
  assert.equal(grant.canonicalRoot, root);
  assert.equal(grant.policyHash, raw.preview.policyHash);
  assert.equal(grant.auditHash, raw.auditHash);
  assert.equal(grant.budgets.maxRunBytes, 4 * 1024 * 1024);

  assert.throws(
    () => normalizeLocalGrant({ ...raw, canonicalRoot: path.dirname(root) }, { now: () => NOW }),
    error => error.code === 'local_root_mismatch'
  );
  assert.throws(
    () => normalizeLocalGrant({ ...raw, policyHash: '0'.repeat(64) }, { now: () => NOW }),
    error => error.code === 'local_policy_mismatch'
  );
});

test('invalid approvedAt fails closed with stable policy error instead of RangeError', t => {
  const { root } = tempRoot(t);
  const raw = grantFor(root, { approvedAt: 'not-a-date' });
  assert.throws(
    () => normalizeLocalGrant(raw, { now: () => NOW }),
    error => error.name === 'LocalAccessPolicyError' && error.code === 'local_grant_expired'
  );
});

test('whole-home roots need explicit policy and sensitive state homes remain structural denies', t => {
  const { temporary, root } = tempRoot(t);
  const raw = grantFor(root);
  assert.throws(
    () => normalizeLocalGrant(raw, { now: () => NOW, homeRoot: root }),
    error => error.code === 'local_whole_home_denied'
  );
  assert.throws(
    () => normalizeLocalGrant(grantFor(temporary), { now: () => NOW, homeRoot: root }),
    error => error.code === 'local_root_too_broad'
  );
  assert.throws(
    () => normalizeLocalGrant(grantFor(path.parse(root).root), { now: () => NOW, homeRoot: root }),
    error => error.code === 'local_root_too_broad'
  );

  for (const segment of ['.ssh', '.gnupg', '.aws', '.codex', '.codex-multi', '.codex-chatgpt-web', '.opencodex']) {
    const stateRoot = path.join(temporary, `state-${segment.replaceAll('.', '')}`, segment);
    fs.mkdirSync(stateRoot, { recursive: true });
    const stateGrant = grantFor(fs.realpathSync(stateRoot), { grantRef: `local_grant_${segment.replace(/[^a-z]/g, '')}0123456789abcdef`.slice(0, 40) });
    assert.throws(
      () => normalizeLocalGrant(stateGrant, { now: () => NOW }),
      error => error.code === 'local_sensitive_path_denied',
      segment
    );
  }
});

test('dedicated Codex session grants require an exact active or archived sessions root', t => {
  const { temporary } = tempRoot(t);
  const codexHome = path.join(temporary, '.codex');
  const sessions = path.join(codexHome, 'sessions');
  const archivedSessions = path.join(codexHome, 'archived_sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(archivedSessions, { recursive: true });
  const broad = grantFor(fs.realpathSync(codexHome), { sourceType: 'codex-sessions' });
  assert.throws(() => normalizeLocalGrant(broad, { now: () => NOW }), error => error.code === 'session_root_invalid');
  const exact = grantFor(fs.realpathSync(sessions), { sourceType: 'codex-sessions' });
  assert.equal(normalizeLocalGrant(exact, { now: () => NOW }).sourceType, 'codex-sessions');
  const archived = grantFor(fs.realpathSync(archivedSessions), {
    sourceType: 'codex-sessions',
    grantRef: 'local_grant_archivedsessions012345'
  });
  assert.equal(normalizeLocalGrant(archived, { now: () => NOW }).sourceType, 'codex-sessions');
});

test('path guard rejects traversal, symlinks, TCC, sensitive names, and explicit deny matches', t => {
  const { temporary, root } = tempRoot(t);
  fs.mkdirSync(path.join(root, '.ssh'));
  fs.writeFileSync(path.join(root, '.ssh', 'id_ed25519'), 'synthetic');
  for (const name of ['.env.local', 'credentials.yaml', 'secret.json', 'auth.sqlite', 'session-local.db', 'refresh_token.json']) {
    fs.writeFileSync(path.join(root, name), 'synthetic');
  }
  fs.symlinkSync(temporary, path.join(root, 'escape'));
  const grant = normalizeLocalGrant(grantFor(root), { now: () => NOW });
  assert.throws(() => assertGrantedRelativePath(grant, '../outside'), error => error.code === 'local_path_escape');
  assert.throws(() => assertGrantedRelativePath(grant, 'escape'), error => error.code === 'local_symlink_denied');
  assert.throws(() => assertGrantedRelativePath(grant, '.ssh/id_ed25519'), error => error.code === 'local_sensitive_path_denied');
  for (const name of ['.env.local', 'credentials.yaml', 'secret.json', 'auth.sqlite', 'session-local.db', 'refresh_token.json']) {
    assert.throws(() => assertGrantedRelativePath(grant, name), error => error.code === 'local_sensitive_path_denied', name);
  }
  assert.throws(() => assertGrantedRelativePath(grant, 'private/file.txt'), error => error.code === 'local_path_not_granted');

  const tcc = path.join(temporary, 'Library', 'Mail');
  fs.mkdirSync(tcc, { recursive: true });
  assert.throws(() => normalizeLocalGrant(grantFor(fs.realpathSync(tcc)), { now: () => NOW }), error => error.code === 'HOLD_TCC');
});

test('text redaction and metadata-only classification cover secrets, prompts, tools, archives, databases, and binary files', () => {
  const redacted = redactLocalText('api_key=secret\nsecret="value with spaces"\n{"prompt":"private json","tool_output":"command json"}\nprompt: private\ntool_output: command\nCookie: session=value\nAuthorization: Basic basic-secret\nsk-synthetic01234567890123456789');
  assert.doesNotMatch(redacted, /api_key=secret|value with spaces|private json|command json|private|command|session=value|basic-secret|sk-synthetic/);
  assert.match(redacted, /<redacted/);
  assert.equal(contentDisposition('fixture.zip').contentMode, 'metadata-only');
  assert.equal(contentDisposition('fixture.sqlite').kind, 'database');
  assert.equal(contentDisposition('fixture.bin').kind, 'binary');
  assert.equal(contentDisposition('fixture.txt').contentMode, 'redacted-text');
});

test('authority consumes only local UI grant_ref, binds source/correlation, expires, closes, and never widens to write', async t => {
  const { root } = tempRoot(t);
  let clock = NOW;
  const raw = grantFor(root);
  const authority = new LocalReadGrantAuthority({ resolveGrant: async ref => ref === raw.grantRef ? raw : null, now: () => clock });
  const opened = await authority.openRead({ grantRef: raw.grantRef, correlationId: raw.correlationId, expiresInSeconds: 60 });
  const record = authority.resolve({ sourceId: raw.sourceId, capability: opened.capability, correlationId: raw.correlationId });
  assert.equal(record.sourceType, 'local');
  assert.throws(() => authority.resolve({ sourceId: raw.sourceId, capability: opened.capability, correlationId: 'correlation-wrong-value' }), error => error.code === 'local_correlation_mismatch');
  assert.throws(() => authority.resolve({ sourceId: 'local_source_ffffffffffffffffffffffff', capability: opened.capability, correlationId: raw.correlationId }), error => error.code === 'local_source_mismatch');
  assert.throws(() => authority.resolve({ sourceId: raw.sourceId, capability: opened.capability, correlationId: raw.correlationId, requiredMode: 'write' }), error => error.code === 'local_scope_denied');
  assert.equal(authority.status().rawCapabilitiesDurable, false);

  const restarted = new LocalReadGrantAuthority({ resolveGrant: async () => raw, now: () => clock });
  assert.throws(() => restarted.resolve({ sourceId: raw.sourceId, capability: opened.capability, correlationId: raw.correlationId }), error => error.code === 'local_capability_invalid');

  assert.equal(authority.close({ sourceId: raw.sourceId, capability: opened.capability, correlationId: raw.correlationId }).closed, true);
  assert.throws(() => authority.resolve({ sourceId: raw.sourceId, capability: opened.capability, correlationId: raw.correlationId }), error => error.code === 'local_capability_invalid');

  const expiring = await authority.openRead({ grantRef: raw.grantRef, correlationId: raw.correlationId, expiresInSeconds: 1 });
  clock += 1001;
  assert.throws(() => authority.resolve({ sourceId: raw.sourceId, capability: expiring.capability, correlationId: raw.correlationId }), error => error.code === 'local_capability_expired');
  await assert.rejects(() => authority.openRead({ grantRef: 'local_grant_ffffffffffffffff', correlationId: raw.correlationId }), error => error.code === 'local_grant_unknown');
});

export { grantFor };
