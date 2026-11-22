import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OFFICIAL_SOURCE_REGISTRY } from '../src/knowledge-review/policy.mjs';
import { KnowledgeReviewStore } from '../src/knowledge-review/storage.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-knowledge-store-'));
  const root = path.join(base, 'knowledge-review');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const clock = { value: Date.parse('2026-08-15T00:00:00Z') };
  const store = new KnowledgeReviewStore({ root, registry: OFFICIAL_SOURCE_REGISTRY, now: () => clock.value });
  return { base, root, store, clock };
}

test('owner store uses private directories/files and content-addressed immutable objects', t => {
  const { root, store } = fixture(t);
  const first = store.putObject('alpha\n');
  const second = store.putObject('alpha\n');
  assert.equal(first.digest, second.digest);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(path.basename(first.file), first.digest);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(root).mode & 0o077, 0);
    assert.equal(fs.statSync(first.file).mode & 0o077, 0);
    assert.equal(fs.statSync(store.paths.sources).mode & 0o077, 0);
  }
  const storedRegistry = JSON.parse(fs.readFileSync(store.paths.sources, 'utf8'));
  assert.equal(storedRegistry.manualOnly, true);
  assert.equal(storedRegistry.automaticApply, false);
});

test('source cursors persist index, ETag, Last-Modified, index hash, and content hash', t => {
  const { store } = fixture(t);
  const cursor = store.readCursor('openai-developers');
  cursor.index = {
    canonicalUrl: 'https://developers.openai.com/llms.txt',
    etag: 'fixture-etag',
    lastModified: 'Fri, 15 Aug 2026 00:00:00 GMT',
    indexHash: 'a'.repeat(64),
    contentHash: 'a'.repeat(64),
    objectDigest: 'a'.repeat(64)
  };
  const saved = store.writeCursor('openai-developers', cursor);
  assert.equal(saved.sha256.length, 64);
  assert.deepEqual(store.readCursor('openai-developers').index, cursor.index);
});

test('compiled source-registry changes replace owner policy only after an owner-only rollback snapshot', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-knowledge-registry-refresh-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'knowledge-review');
  const previous = { ...OFFICIAL_SOURCE_REGISTRY, sources: OFFICIAL_SOURCE_REGISTRY.sources.filter(source => source.id !== 'openai-chatgpt') };
  new KnowledgeReviewStore({ root, registry: previous });
  new KnowledgeReviewStore({ root, registry: OFFICIAL_SOURCE_REGISTRY });
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'sources.json'), 'utf8'));
  assert.deepEqual(stored.sources.map(source => source.id), OFFICIAL_SOURCE_REGISTRY.sources.map(source => source.id));
  const backups = fs.readdirSync(path.join(root, 'backups')).filter(name => name.startsWith('source-registry-'));
  assert.equal(backups.length, 1);
  const backupRoot = path.join(root, 'backups', backups[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.scope, 'knowledge-review-source-registry');
  assert.equal(manifest.automaticRestore, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backupRoot, 'sources.json'), 'utf8')).sources.length, previous.sources.length);
  new KnowledgeReviewStore({ root, registry: OFFICIAL_SOURCE_REGISTRY });
  assert.equal(fs.readdirSync(path.join(root, 'backups')).filter(name => name.startsWith('source-registry-')).length, 1);
});

test('root and internal symlink traversal are rejected', t => {
  const { base, root, store } = fixture(t);
  const alias = path.join(base, 'alias');
  fs.symlinkSync(root, alias, 'dir');
  assert.throws(
    () => new KnowledgeReviewStore({ root: alias, registry: OFFICIAL_SOURCE_REGISTRY }),
    error => error.code === 'symlink_denied'
  );

  const cursor = store.readCursor('openai-developers');
  const displaced = path.join(base, 'cursors-real');
  fs.renameSync(store.paths.cursors, displaced);
  fs.symlinkSync(displaced, store.paths.cursors, 'dir');
  assert.throws(() => store.writeCursor('openai-developers', cursor), error => error.code === 'symlink_denied');
});

test('candidates remain unapplied and promote/reject/hold decisions append to an immutable ledger', t => {
  const { store, clock } = fixture(t);
  const candidate = store.createCandidate({
    candidateId: 'candidate-one',
    category: 'skill',
    title: 'Synthetic review candidate',
    summary: 'Fixture summary only.',
    sourceRefs: ['https://developers.openai.com/codex/example.md'],
    impactFiles: ['guidance/skills/example/SKILL.md'],
    risk: 'Requires a separate guidance review.',
    validation: 'Run dedicated evals.',
    rollback: 'Do not deploy the candidate.'
  });
  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.automaticApply, false);
  for (const [index, decision] of ['hold', 'reject', 'promote'].entries()) {
    clock.value += 1;
    const event = store.appendDecision({
      eventId: `event-${index}`,
      candidateId: candidate.candidateId,
      decision,
      reason: `synthetic ${decision}`,
      reviewedBy: 'fixture-reviewer',
      evidenceRefs: ['knowledge-review://runs/fixture/manifest']
    });
    assert.equal(event.applied, false);
    assert.equal(event.automaticApply, false);
  }
  assert.deepEqual(store.readLedger().map(event => event.decision), ['hold', 'reject', 'promote']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(store.paths.candidates, 'candidate-one.json'), 'utf8')).status, 'candidate');
});

test('cursor backup is owner-only and rollback remains an explicit non-applying plan', t => {
  const { store } = fixture(t);
  const cursor = store.readCursor('openai-developers');
  cursor.lastOutcome = 'completed';
  store.writeCursor('openai-developers', cursor);
  const backup = store.backupCursorState('before-fixture');
  assert.equal(backup.manifest.scope, 'knowledge-review-cursors');
  assert.equal(backup.manifest.automaticRestore, false);
  assert.ok(backup.manifest.entries.some(entry => entry.path === 'cursors/openai-developers.json'));
  const plan = store.rollbackPlan('before-fixture');
  assert.equal(plan.apply, false);
  assert.equal(plan.requiresExplicitOwnerConfirmation, true);
  assert.equal(plan.preserveImmutableObjects, true);
  assert.equal(plan.preserveAppendOnlyLedger, true);
});
