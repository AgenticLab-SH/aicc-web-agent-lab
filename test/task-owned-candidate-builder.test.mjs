import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildTaskOwnedInstalledCliCandidate } from '../scripts/build-task-owned-installed-cli-candidate.mjs';
import { sealInstalledCliCandidate, verifyInstalledCliCandidate } from '../src/recovery/installed-cli-route-adapter.mjs';

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-task-owned-candidate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'base');
  const source = path.join(root, 'source');
  const candidate = path.join(root, 'candidate');
  const spec = path.join(source, 'overlay.json');

  for (const relative of ['bin/aicc', 'src/cli.mjs', 'src/recovery/restore-v2-command.mjs']) {
    write(path.join(base, relative), 'base:' + relative + '\n');
  }
  write(path.join(base, 'keep.txt'), 'sealed-base-only\n');
  write(path.join(base, 'components/workspace-mcp/tool-manifest.mjs'), 'export const tools=[];\n');
  sealInstalledCliCandidate(base, { sourceRevision: 'b'.repeat(64) });

  write(path.join(source, 'src/control-plane/example.mjs'), 'export const value=2;\n');
  write(path.join(source, 'unrelated-dirty.txt'), 'must-not-enter-candidate\n');
  write(spec, JSON.stringify({
    schemaVersion: 1,
    component: 'aicc-control-plane-overlay',
    paths: [{ path: 'src/control-plane/example.mjs', reason: 'owned test overlay' }]
  }));

  return { root, base, source, candidate, spec };
}

test('builder clones a verified immutable base and overlays only explicit task-owned files', t => {
  const f = fixture(t);
  const result = buildTaskOwnedInstalledCliCandidate({
    sourceRoot: f.source,
    baseRoot: f.base,
    candidateRoot: f.candidate,
    specFile: f.spec,
    sourceHead: 'a'.repeat(40)
  });
  assert.equal(result.ok, true);
  assert.equal(result.overlayCount, 1);
  assert.equal(verifyInstalledCliCandidate(f.candidate).ok, true);
  assert.equal(fs.readFileSync(path.join(f.candidate, 'keep.txt'), 'utf8'), 'sealed-base-only\n');
  assert.equal(fs.readFileSync(path.join(f.candidate, 'src/control-plane/example.mjs'), 'utf8'), 'export const value=2;\n');
  assert.equal(fs.existsSync(path.join(f.candidate, 'unrelated-dirty.txt')), false);

  const overlay = JSON.parse(fs.readFileSync(path.join(f.candidate, '.aicc-candidate-overlay.json'), 'utf8'));
  assert.equal(overlay.overlayCount, 1);
  assert.equal(overlay.overlays[0].path, 'src/control-plane/example.mjs');
  assert.equal(overlay.source.gitHead, 'a'.repeat(40));
  assert.equal(overlay.source.workingTreeFingerprint, result.workingTreeFingerprint);
  assert.equal(overlay.baseRelease.manifestSha256, result.baseManifestHash);
});

test('builder rejects a drifted sealed base before candidate creation', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.base, 'keep.txt'), 'drift\n');
  assert.throws(() => buildTaskOwnedInstalledCliCandidate({
    sourceRoot: f.source,
    baseRoot: f.base,
    candidateRoot: f.candidate,
    specFile: f.spec,
    sourceHead: 'a'.repeat(40)
  }), /base_release_unverified/);
  assert.equal(fs.existsSync(f.candidate), false);
});

test('builder never overwrites an existing candidate path', t => {
  const f = fixture(t);
  fs.mkdirSync(f.candidate);
  write(path.join(f.candidate, 'sentinel.txt'), 'preserve\n');
  assert.throws(() => buildTaskOwnedInstalledCliCandidate({
    sourceRoot: f.source,
    baseRoot: f.base,
    candidateRoot: f.candidate,
    specFile: f.spec,
    sourceHead: 'a'.repeat(40)
  }), /candidate_root_exists/);
  assert.equal(fs.readFileSync(path.join(f.candidate, 'sentinel.txt'), 'utf8'), 'preserve\n');
});

test('overlay spec rejects traversal and duplicate ownership before any copy', t => {
  const f = fixture(t);
  write(f.spec, JSON.stringify({
    schemaVersion: 1,
    component: 'aicc-control-plane-overlay',
    paths: [
      { path: '../escape.mjs', reason: 'invalid path' },
      { path: '../escape.mjs', reason: 'duplicate invalid path' }
    ]
  }));
  assert.throws(() => buildTaskOwnedInstalledCliCandidate({
    sourceRoot: f.source,
    baseRoot: f.base,
    candidateRoot: f.candidate,
    specFile: f.spec,
    sourceHead: 'a'.repeat(40)
  }), /overlay_path_invalid/);
  assert.equal(fs.existsSync(f.candidate), false);
});

test('the r2 overlay spec passes builder validation and covers every static src/cli.mjs dependency missing from older bases', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'specs/independent-codex-cli-routes/command-route-r2.overlay.json'), 'utf8'));
  assert.equal(spec.schemaVersion, 1);
  assert.equal(spec.component, 'aicc-control-plane-overlay');
  const seen = new Set();
  for (const row of spec.paths) {
    assert.ok(row.reason.trim().length > 0 && row.reason.trim().length <= 120, `${row.path} reason must be 1..120 characters`);
    assert.equal(seen.has(row.path), false, `${row.path} duplicated`);
    seen.add(row.path);
    assert.ok(fs.statSync(path.join(root, row.path)).isFile(), `${row.path} must exist in source`);
  }
  for (const required of ['src/cli.mjs', 'src/windows-health-repair.mjs', 'src/workspace-client-config.mjs',
    'src/runtime-layout.mjs', 'src/windows-codex-desktop-identity.mjs', 'tools/platform/codex/Read-AiccOcxAdmission.ps1']) {
    assert.ok(seen.has(required), `${required} must be in the r2 overlay`);
  }
});
