import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  applyDesignSourceSelection,
  designSourcesStatus,
  normalizeDesignSourceSelection,
  restoreDesignSourceSelection,
  scanDesignSources,
  scanDesignSourcesAsync
} from '../src/design-sources.mjs';
import { select } from '../guidance/skills/establish-design-direction/scripts/select-design-sources.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-design-sources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  const remote = path.join(root, 'remote.git');
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(work);
  git(work, 'init', '-b', 'main');
  git(work, 'config', 'user.email', 'fixture@example.test');
  git(work, 'config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(work, 'guide.md'), 'first\n');
  git(work, 'add', 'guide.md');
  git(work, 'commit', '-m', 'first');
  const first = git(work, 'rev-parse', 'HEAD');
  git(root, 'clone', '--bare', work, remote);
  git(work, 'remote', 'add', 'origin', remote);
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    policy: { automaticApply: false, monitorIntervalHours: 6 },
    sources: [{
      id: 'fixture-source', label: 'Fixture Source', repository: 'fixture/source',
      url: `file://${remote.slice(0, -4)}`, baselineRevision: first, license: 'MIT',
      estimatedKiB: 1, kind: 'fixture', capabilities: ['layout'], recommendedPaths: ['guide.md']
    }]
  })}\n`);
  return { work, stateRoot, manifestPath, first };
}

test('scan, selection, immutable snapshot apply, update and restore remain commit exact', t => {
  const data = fixture(t);
  const options = { stateRoot: data.stateRoot, manifestPath: data.manifestPath };
  const firstScan = scanDesignSources(options);
  assert.equal(firstScan.sources[0].remoteRevision, data.first);
  assert.equal(firstScan.sources[0].status, 'not_installed');

  const firstSelection = normalizeDesignSourceSelection({ all: true }, firstScan);
  const firstApplied = applyDesignSourceSelection(firstSelection, options);
  assert.equal(firstApplied.sources[0].activeRevision, data.first);
  assert.equal(firstApplied.sources[0].integrity, 'verified');

  fs.writeFileSync(path.join(data.work, 'guide.md'), 'second\n');
  git(data.work, 'add', 'guide.md');
  git(data.work, 'commit', '-m', 'second');
  git(data.work, 'push', 'origin', 'main');
  const second = git(data.work, 'rev-parse', 'HEAD');
  const secondScan = scanDesignSources(options);
  assert.equal(secondScan.sources[0].status, 'update_available');
  assert.equal(secondScan.sources[0].remoteRevision, second);

  const secondApplied = applyDesignSourceSelection(normalizeDesignSourceSelection({ ids: ['fixture-source'] }, secondScan), options);
  assert.equal(secondApplied.sources[0].activeRevision, second);
  assert.ok(fs.existsSync(path.join(data.stateRoot, 'design-sources', 'snapshots', 'fixture-source', data.first, 'guide.md')));
  restoreDesignSourceSelection({ 'fixture-source': data.first }, options);
  assert.equal(designSourcesStatus(options).sources[0].activeRevision, data.first);
});

test('non-blocking scan returns the same exact remote commit', async t => {
  const data = fixture(t);
  const status = await scanDesignSourcesAsync({ stateRoot: data.stateRoot, manifestPath: data.manifestPath });
  assert.equal(status.sources[0].remoteRevision, data.first);
  assert.equal(status.sources[0].status, 'not_installed');
});

test('modified active source fails closed before a new selection is prepared', t => {
  const data = fixture(t);
  const options = { stateRoot: data.stateRoot, manifestPath: data.manifestPath };
  const scanned = scanDesignSources(options);
  applyDesignSourceSelection(normalizeDesignSourceSelection({ all: true }, scanned), options);
  const active = path.join(data.stateRoot, 'design-sources', 'active', 'fixture-source', 'guide.md');
  fs.writeFileSync(active, 'locally modified\n');
  const status = designSourcesStatus(options);
  assert.equal(status.sources[0].integrity, 'modified');
  assert.throws(() => normalizeDesignSourceSelection({ all: true }, status), /수정되었습니다/);
});

test('an untracked file also marks an original snapshot as contaminated', t => {
  const data = fixture(t);
  const options = { stateRoot: data.stateRoot, manifestPath: data.manifestPath };
  const scanned = scanDesignSources(options);
  applyDesignSourceSelection(normalizeDesignSourceSelection({ all: true }, scanned), options);
  const activeDirectory = path.join(data.stateRoot, 'design-sources', 'active', 'fixture-source');
  fs.writeFileSync(path.join(activeDirectory, 'injected.txt'), 'not part of the original commit\n');
  assert.equal(designSourcesStatus(options).sources[0].integrity, 'modified');
  assert.throws(
    () => restoreDesignSourceSelection({ 'fixture-source': data.first }, options),
    /integrity failed/
  );
});

test('web routing prioritizes complementary design responsibilities', t => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-design-routing-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const activeRoot = path.join(stateRoot, 'design-sources', 'active');
  fs.mkdirSync(activeRoot, { recursive: true });
  const revision = 'a'.repeat(40);
  for (const id of ['impeccable', 'shadcn-ui', 'open-design']) {
    const snapshot = path.join(stateRoot, 'design-sources', 'snapshots', id, revision);
    fs.mkdirSync(snapshot, { recursive: true });
    fs.symlinkSync(snapshot, path.join(activeRoot, id));
  }
  const result = select(['--surface', 'web', '--intent', '세련된 업데이트 관리 대시보드', '--json'], { stateRoot });
  assert.deepEqual(result.matches.map(match => match.id), ['impeccable', 'shadcn-ui', 'open-design']);
  assert.ok(result.matches.every(match => match.available && match.revision === revision));
});
