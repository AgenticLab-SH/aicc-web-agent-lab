import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceSnapshotError, WorkspaceSnapshotService } from '../src/workspace-snapshots/service.mjs';

const SCHEMA_HASH = 'a'.repeat(64);

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-snapshot-'));
  const root = path.join(base, 'repo');
  const stateRoot = path.join(base, 'state');
  fs.mkdirSync(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'snapshot@example.invalid');
  git(root, 'config', 'user.name', 'Snapshot Test');
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ packageManager: 'npm@11', scripts: { test: 'node --test', check: 'node --check index.mjs' } }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'index.mjs'), 'export const value = "snapshot needle";\n');
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# Guide\nimmutable snapshot needle\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  const service = new WorkspaceSnapshotService({ allowedRoots: [root], stateRoot, now: () => new Date('2026-08-16T04:00:00Z') });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, stateRoot, service };
}

test('builds one content-addressed identity and caches only verified read queries', t => {
  const { root, stateRoot, service } = fixture(t);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'selected untracked overlay\n');
  const begun = service.begin({ root, toolSchemaHash: SCHEMA_HASH, selectedUntrackedPaths: ['notes.txt'] });
  assert.match(begun.manifest.snapshotId, /^snapshot_[a-f0-9]{64}$/);
  assert.equal(begun.manifest.selectedUntracked.length, 1);
  const request = {
    snapshotId: begun.manifest.snapshotId,
    operations: [
      { type: 'status' },
      { type: 'search', query: 'needle', path: '.', maxResults: 10 },
      { type: 'read_many', paths: ['index.mjs', 'notes.txt'], maxLinesEach: 20 },
      { type: 'test_metadata' },
      { type: 'diff' },
    ],
  };
  const first = service.query(request);
  assert.equal(first.cacheHit, false);
  assert.equal(first.results[1].results.length, 2);
  assert.equal(first.results[2].files.length, 2);
  assert.deepEqual(first.results[3].packageJson.scripts, ['check', 'test']);
  assert.equal(first.results[4].patchIncluded, false);
  const second = service.query(request);
  assert.equal(second.cacheHit, true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(stateRoot).mode & 0o077, 0);
});

test('invalidates the snapshot before serving a cached result when tracked or selected overlay bytes change', t => {
  const { root, service } = fixture(t);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'first\n');
  const begun = service.begin({ root, toolSchemaHash: SCHEMA_HASH, selectedUntrackedPaths: ['notes.txt'] });
  const request = { snapshotId: begun.manifest.snapshotId, operations: [{ type: 'read_many', paths: ['index.mjs'] }] };
  assert.equal(service.query(request).cacheHit, false);
  assert.equal(service.query(request).cacheHit, true);
  fs.writeFileSync(path.join(root, 'index.mjs'), 'export const value = "changed";\n');
  assert.throws(() => service.query(request), error => error instanceof WorkspaceSnapshotError && error.code === 'snapshot_stale');

  git(root, 'checkout', '--', 'index.mjs');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'second\n');
  assert.throws(() => service.query(request), error => error instanceof WorkspaceSnapshotError && error.code === 'snapshot_stale');
});

test('rejects wrong roots, external symlinks, sensitive paths and secret-like content', t => {
  const { base, root, service } = fixture(t);
  const outside = path.join(base, 'outside.txt');
  fs.writeFileSync(outside, 'outside\n');
  fs.symlinkSync(outside, path.join(root, 'escape.txt'));
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=secret\n');
  fs.writeFileSync(path.join(root, 'leak.txt'), `token=ghp_${'a'.repeat(20)}\n`);
  fs.writeFileSync(path.join(root, 'unselected.txt'), 'not selected\n');
  git(root, 'add', '-f', '.env', 'leak.txt');
  git(root, 'commit', '-qm', 'sensitive fixtures');
  const begun = service.begin({ root, toolSchemaHash: SCHEMA_HASH });
  assert.throws(
    () => service.begin({ root, toolSchemaHash: SCHEMA_HASH, selectedUntrackedPaths: ['escape.txt'] }),
    error => error instanceof WorkspaceSnapshotError && error.code === 'symlink_denied',
  );
  assert.throws(
    () => service.query({ snapshotId: begun.manifest.snapshotId, operations: [{ type: 'read_many', paths: ['.env'] }] }),
    error => error instanceof WorkspaceSnapshotError && error.code === 'sensitive_path',
  );
  assert.throws(
    () => service.query({ snapshotId: begun.manifest.snapshotId, operations: [{ type: 'read_many', paths: ['leak.txt'] }] }),
    error => error instanceof WorkspaceSnapshotError && error.code === 'sensitive_content',
  );
  assert.throws(
    () => service.query({ snapshotId: begun.manifest.snapshotId, operations: [{ type: 'read_many', paths: ['unselected.txt'] }] }),
    error => error instanceof WorkspaceSnapshotError && error.code === 'path_not_in_snapshot',
  );
  assert.throws(
    () => service.query({ snapshotId: begun.manifest.snapshotId, operations: [{ type: 'process_status' }] }),
    error => error instanceof WorkspaceSnapshotError && error.code === 'operation_not_allowed',
  );
  assert.throws(
    () => new WorkspaceSnapshotService({ allowedRoots: [root], stateRoot: path.join(base, 'other-state') })
      .begin({ root: base, toolSchemaHash: SCHEMA_HASH }),
    error => error instanceof WorkspaceSnapshotError && error.code === 'workspace_not_allowed',
  );

  const redirected = path.join(base, 'redirected-state');
  fs.mkdirSync(redirected);
  const stateSymlink = path.join(base, 'state-link');
  fs.symlinkSync(redirected, stateSymlink);
  assert.throws(
    () => new WorkspaceSnapshotService({ allowedRoots: [root], stateRoot: stateSymlink }),
    error => error instanceof WorkspaceSnapshotError && error.code === 'owner_state_invalid',
  );
});

test('materializes exact dirty state into owner-only CAS and exports one validated deterministic ZIP', t => {
  const { root, stateRoot, service } = fixture(t);
  fs.writeFileSync(path.join(root, 'index.mjs'), 'export const value = "dirty snapshot";\n');
  fs.rmSync(path.join(root, 'docs', 'guide.md'));
  fs.writeFileSync(path.join(root, 'notes.txt'), 'selected untracked overlay\n');
  const begun = service.begin({ root, toolSchemaHash: SCHEMA_HASH, selectedUntrackedPaths: ['notes.txt'] });

  const materialized = service.materialize({ snapshotId: begun.manifest.snapshotId });
  assert.equal(materialized.reused, false);
  assert.equal(fs.readFileSync(path.join(materialized.root, 'index.mjs'), 'utf8'), 'export const value = "dirty snapshot";\n');
  assert.equal(fs.existsSync(path.join(materialized.root, 'docs', 'guide.md')), false);
  assert.equal(fs.readFileSync(path.join(materialized.root, 'notes.txt'), 'utf8'), 'selected untracked overlay\n');
  assert.equal(fs.existsSync(path.join(materialized.root, '.git')), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(materialized.root, 'index.mjs')).mode & 0o077, 0);
  assert.match(materialized.treeDigest, /^[a-f0-9]{64}$/);
  assert.equal(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(stateRoot, 'work')), []);

  const reused = service.materialize({ snapshotId: begun.manifest.snapshotId });
  assert.equal(reused.reused, true);
  assert.equal(reused.treeDigest, materialized.treeDigest);

  const firstBundle = service.exportPortableBundle({ snapshotId: begun.manifest.snapshotId });
  assert.equal(firstBundle.ok, true);
  assert.equal(firstBundle.reused, false);
  assert.equal(firstBundle.snapshotId, begun.manifest.snapshotId);
  assert.equal(firstBundle.manifest.files.some(item => item.path === 'notes.txt'), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(firstBundle.path).mode & 0o077, 0);
  const secondBundle = service.exportPortableBundle({ snapshotId: begun.manifest.snapshotId });
  assert.equal(secondBundle.reused, true);
  assert.equal(secondBundle.sha256, firstBundle.sha256);

  assert.equal(fs.readFileSync(path.join(root, 'index.mjs'), 'utf8'), 'export const value = "dirty snapshot";\n');
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'selected untracked overlay\n');
});

test('materialization fails closed for stale snapshots, tracked symlinks and an existing exact writer lock', t => {
  const stale = fixture(t);
  const begun = stale.service.begin({ root: stale.root, toolSchemaHash: SCHEMA_HASH });
  fs.writeFileSync(path.join(stale.root, 'index.mjs'), 'export const value = "stale";\n');
  assert.throws(
    () => stale.service.materialize({ snapshotId: begun.manifest.snapshotId }),
    error => error instanceof WorkspaceSnapshotError && error.code === 'snapshot_stale',
  );

  const locked = fixture(t);
  const lockedSnapshot = locked.service.begin({ root: locked.root, toolSchemaHash: SCHEMA_HASH });
  const lock = path.join(locked.stateRoot, 'cas', `${lockedSnapshot.manifest.snapshotId}.lock`);
  fs.writeFileSync(lock, 'owned\n', { mode: 0o600 });
  assert.throws(
    () => locked.service.materialize({ snapshotId: lockedSnapshot.manifest.snapshotId }),
    error => error instanceof WorkspaceSnapshotError && error.code === 'materialization_busy',
  );

  const linked = fixture(t);
  fs.symlinkSync('index.mjs', path.join(linked.root, 'linked.mjs'));
  git(linked.root, 'add', 'linked.mjs');
  git(linked.root, 'commit', '-qm', 'tracked symlink');
  const linkedSnapshot = linked.service.begin({ root: linked.root, toolSchemaHash: SCHEMA_HASH });
  assert.throws(
    () => linked.service.materialize({ snapshotId: linkedSnapshot.manifest.snapshotId }),
    error => error instanceof WorkspaceSnapshotError && error.code === 'symlink_denied',
  );

  const sensitive = fixture(t);
  fs.writeFileSync(path.join(sensitive.root, '.env'), 'PASSWORD=not-portable\n');
  git(sensitive.root, 'add', '-f', '.env');
  git(sensitive.root, 'commit', '-qm', 'tracked sensitive file');
  const sensitiveSnapshot = sensitive.service.begin({ root: sensitive.root, toolSchemaHash: SCHEMA_HASH });
  assert.throws(
    () => sensitive.service.materialize({ snapshotId: sensitiveSnapshot.manifest.snapshotId }),
    error => error instanceof WorkspaceSnapshotError && error.code === 'sensitive_path',
  );
});

test('tracked environment templates remain portable but secret-like template content fails closed', t => {
  const safe = fixture(t);
  fs.writeFileSync(path.join(safe.root, '.env.example'), 'EXAMPLE_TOKEN=replace-me\n');
  git(safe.root, 'add', '.env.example');
  git(safe.root, 'commit', '-qm', 'safe environment template');
  const safeSnapshot = safe.service.begin({ root: safe.root, toolSchemaHash: SCHEMA_HASH });
  assert.equal(fs.existsSync(path.join(safe.service.materialize({ snapshotId: safeSnapshot.manifest.snapshotId }).root, '.env.example')), true);

  const leaked = fixture(t);
  fs.writeFileSync(path.join(leaked.root, '.env.example'), `TOKEN=ghp_${'a'.repeat(20)}\n`);
  git(leaked.root, 'add', '.env.example');
  git(leaked.root, 'commit', '-qm', 'unsafe environment template');
  const leakedSnapshot = leaked.service.begin({ root: leaked.root, toolSchemaHash: SCHEMA_HASH });
  assert.throws(
    () => leaked.service.materialize({ snapshotId: leakedSnapshot.manifest.snapshotId }),
    error => error instanceof WorkspaceSnapshotError && error.code === 'sensitive_content',
  );
});
