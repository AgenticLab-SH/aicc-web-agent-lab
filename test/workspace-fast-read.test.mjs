import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceFastReadCoordinator } from '../components/workspace-mcp/fast-read.mjs';

const TOOL_SCHEMA_HASH = 'b'.repeat(64);

function git(root, ...args) {
  const executable = process.platform === 'win32' ? 'git.exe' : '/usr/bin/git';
  const result = spawnSync(executable, ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-fast-read-'));
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fast-read@example.invalid');
  git(root, 'config', 'user.name', 'Fast Read Test');
  fs.writeFileSync(path.join(root, 'README.md'), '# snapshot needle\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  const coordinator = new WorkspaceFastReadCoordinator({
    allowedRoots: [root],
    stateRoot: path.join(base, 'snapshots'),
    toolSchemaHash: TOOL_SCHEMA_HASH
  });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { root, coordinator };
}

test('Fast Read binds one immutable snapshot and reuses verified query results', t => {
  const { root, coordinator } = fixture(t);
  const opened = coordinator.open({ leaseId: 'remote_read_lease_1', root });
  assert.equal(opened.available, true);
  assert.equal(opened.complete_workspace_view, true);
  assert.equal(opened.live_facts_cached, false);
  const request = {
    leaseId: 'remote_read_lease_1',
    operations: [{ type: 'search', query: 'needle', path: '.', maxResults: 10 }]
  };
  const first = coordinator.query(request);
  const second = coordinator.query(request);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(second.results[0].results[0].path, 'README.md');
  assert.equal(coordinator.close('remote_read_lease_1'), true);
  assert.equal(coordinator.query(request), null);
});

test('Fast Read marks unselected untracked files as incomplete and detects tracked drift', t => {
  const { root, coordinator } = fixture(t);
  fs.writeFileSync(path.join(root, 'draft.txt'), 'untracked\n');
  const opened = coordinator.open({ leaseId: 'remote_read_lease_2', root });
  assert.equal(opened.available, true);
  assert.equal(opened.complete_workspace_view, false);
  assert.equal(opened.excluded_untracked_files, 1);
  fs.writeFileSync(path.join(root, 'README.md'), '# changed\n');
  assert.throws(
    () => coordinator.query({
      leaseId: 'remote_read_lease_2',
      operations: [{ type: 'read_many', paths: ['README.md'] }]
    }),
    error => error.code === 'snapshot_stale'
  );
});

test('bounded Fast Read caches existing response contracts and bypasses newly untracked files', async t => {
  const { root, coordinator } = fixture(t);
  coordinator.open({ leaseId: 'bounded', root });
  let loads = 0;
  const request = { leaseId: 'bounded', key: ['page', { offset_bytes: 2, max_bytes: 4 }],
    load: async () => ({ text: 'snap', next_offset_bytes: 6, loads: ++loads }) };
  const first = await coordinator.boundedQuery(request);
  assert.equal(first.text, 'snap');
  assert.equal(first.next_offset_bytes, 6);
  assert.equal(first.fast_read.cache_hit, false);
  const second = await coordinator.boundedQuery(request);
  assert.equal(second.fast_read.cache_hit, true);
  assert.equal(loads, 1);
  fs.writeFileSync(path.join(root, 'new-untracked.txt'), 'new result\n');
  const live = await coordinator.boundedQuery(request);
  assert.equal(loads, 2);
  assert.equal(live.fast_read.cache_hit, false);
  assert.equal(live.fast_read.complete_workspace_view, false);
});

test('bounded Fast Read rejects tracked changes made during a load and never reuses a failed load', async t => {
  const { root, coordinator } = fixture(t);
  coordinator.open({ leaseId: 'bounded-failure', root });
  const key = ['search', 'needle'];
  await assert.rejects(coordinator.boundedQuery({
    leaseId: 'bounded-failure', key, load: async () => { throw new Error('bounded search refused'); }
  }), /bounded search refused/);
  let loads = 0;
  const retry = await coordinator.boundedQuery({
    leaseId: 'bounded-failure', key, load: async () => ({ results: [], loads: ++loads })
  });
  assert.equal(loads, 1);
  assert.equal(retry.fast_read.cache_hit, false);
  await assert.rejects(coordinator.boundedQuery({
    leaseId: 'bounded-failure', key: ['different-page'], load: async () => {
      fs.writeFileSync(path.join(root, 'README.md'), 'changed during load\n');
      return { text: 'must not escape' };
    }
  }), error => error.code === 'snapshot_stale');
});

test('bounded Fast Read keeps large responses uncached and honors cancellation on cache hits', async t => {
  const { root, coordinator } = fixture(t);
  coordinator.open({ leaseId: 'bounded-limits', root });
  let loads = 0;
  const request = { leaseId: 'bounded-limits', key: ['large-page'],
    load: async () => ({ text: 'x'.repeat(262_144), loads: ++loads }) };
  await coordinator.boundedQuery(request);
  await coordinator.boundedQuery(request);
  assert.equal(loads, 2);
  const controller = new AbortController();
  const small = { leaseId: 'bounded-limits', key: ['small'], load: async () => ({ text: 'small' }) };
  await coordinator.boundedQuery(small);
  controller.abort(new Error('read cancelled'));
  await assert.rejects(coordinator.boundedQuery({ ...small, signal: controller.signal }), /read cancelled/);
});
