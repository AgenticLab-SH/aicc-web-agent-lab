import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalAccessGrantStore } from '../src/local-access/grant-store.mjs';
import { LocalAccessService } from '../src/local-access/service.mjs';

const NOW = Date.parse('2026-08-15T06:00:00.000Z');

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-local-access-service-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const selected = path.join(temporary, 'selected');
  const stateRoot = path.join(temporary, 'state');
  fs.mkdirSync(path.join(selected, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(selected, 'README.md'), '# safe\n');
  fs.writeFileSync(path.join(selected, 'notes', 'one.txt'), 'one\n');
  const store = new LocalAccessGrantStore({ stateRoot, now: () => NOW });
  const service = new LocalAccessService({ store, now: () => NOW });
  return { temporary, selected: fs.realpathSync(selected), stateRoot, store, service };
}

test('exact-root preview exposes scope and one confirmation issues an owner-only grant', t => {
  const { selected, service, stateRoot } = fixture(t);
  const preview = service.previewGrant({
    root: selected,
    includes: ['**/*'],
    denies: ['private/**'],
    ttlSeconds: 600,
    correlationId: 'correlation-local-service'
  });
  assert.equal(preview.requiresConfirmation, true);
  assert.equal(preview.grant.canonicalRoot, selected);
  assert.equal(preview.grant.preview.fileCount, 2);
  assert.equal(preview.grant.write, false);
  const issued = service.confirmGrant(preview.confirmationToken);
  assert.equal(issued.grant.sourceType, 'local');
  const file = path.join(stateRoot, 'local-access', 'grants', `${issued.grant.grantRef}.json`);
  assert.equal(fs.existsSync(file), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.equal(service.resolveGrant(issued.grant.grantRef).auditHash, issued.grant.auditHash);
  assert.throws(() => service.confirmGrant(preview.confirmationToken), error => error.code === 'confirmation_invalid');
});

test('whole-home and symlink selections fail closed before grant issuance', t => {
  const { temporary, selected, stateRoot } = fixture(t);
  const service = new LocalAccessService({
    store: new LocalAccessGrantStore({ stateRoot: path.join(stateRoot, 'home-check'), homeRoot: selected, now: () => NOW }),
    now: () => NOW
  });
  assert.throws(
    () => service.previewGrant({ root: selected, includes: ['**/*'], correlationId: 'correlation-home-denied' }),
    error => error.code === 'local_whole_home_denied'
  );
  assert.throws(
    () => service.previewGrant({ root: selected, includes: ['**/*'], wholeHomeApproved: true, correlationId: 'correlation-home-no-denylist' }),
    error => error.code === 'local_whole_home_denylist_required'
  );
  const explicit = service.previewGrant({
    root: selected,
    includes: ['**/*'],
    denies: ['private/**'],
    wholeHomeApproved: true,
    correlationId: 'correlation-home-explicit'
  });
  assert.equal(explicit.grant.policy.wholeHomeApproved, true);
  assert.deepEqual(explicit.grant.denies, ['private/**']);
  const linked = path.join(temporary, 'linked');
  fs.symlinkSync(selected, linked);
  assert.throws(() => service.previewGrant({ root: linked, includes: ['**/*'] }), error => error.code === 'local_root_invalid');
});

test('owner state roots and child ledgers reject symlinks', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-local-state-symlink-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const target = path.join(temporary, 'target');
  fs.mkdirSync(target);
  const linkedRoot = path.join(temporary, 'linked-state');
  fs.symlinkSync(target, linkedRoot);
  assert.throws(
    () => new LocalAccessGrantStore({ root: linkedRoot, now: () => NOW }),
    error => error.code === 'local_state_invalid'
  );

  const realRoot = path.join(temporary, 'real-state');
  fs.mkdirSync(realRoot);
  fs.symlinkSync(target, path.join(realRoot, 'grants'));
  assert.throws(
    () => new LocalAccessGrantStore({ root: realRoot, now: () => NOW }),
    error => error.code === 'local_state_invalid'
  );
});

test('dedicated session excerpt approval is separately confirmed and exact-bound', t => {
  const { temporary, service } = fixture(t);
  const sessions = path.join(temporary, '.codex', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, '019ff9b0-e2a7-7543-bff8-681819bfcd98.jsonl'), '{}\n');
  const grantPreview = service.previewGrant({
    root: fs.realpathSync(sessions),
    sourceType: 'codex-sessions',
    includes: ['**/*'],
    ttlSeconds: 600,
    correlationId: 'correlation-session-service'
  });
  const grant = service.confirmGrant(grantPreview.confirmationToken).grant;
  const excerptPreview = service.previewExcerpt({
    grantRef: grant.grantRef,
    sessionUuid: '019ff9b0-e2a7-7543-bff8-681819bfcd98',
    maxLines: 40,
    maxTurns: 4,
    maxBytes: 4096
  });
  const approval = service.confirmExcerpt(excerptPreview.confirmationToken).approval;
  assert.equal(approval.rawPrompt, false);
  assert.equal(approval.rawToolOutput, false);
  assert.equal(service.resolveExcerptApproval({
    approvalRef: approval.approvalRef,
    sourceId: grant.sourceId,
    sessionUuid: approval.sessionUuid,
    correlationId: grant.correlationId,
    auditHash: grant.auditHash
  }).approvalRef, approval.approvalRef);
  assert.equal(service.resolveExcerptApproval({
    approvalRef: approval.approvalRef,
    sourceId: grant.sourceId,
    sessionUuid: approval.sessionUuid,
    correlationId: grant.correlationId,
    auditHash: grant.auditHash
  }), null);
  assert.equal(service.resolveExcerptApproval({
    approvalRef: approval.approvalRef,
    sourceId: grant.sourceId,
    sessionUuid: '00000000-0000-0000-0000-000000000000',
    correlationId: grant.correlationId,
    auditHash: grant.auditHash
  }), null);
});
