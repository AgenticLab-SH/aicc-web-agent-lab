import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const editor = path.resolve('tools/platform/web-automation/edit-aicc-extension-registry.mjs');
const verifier = path.resolve('tools/platform/web-automation/verify-aicc-extension-registry-sources.mjs');

function run(...args) {
  return spawnSync(process.execPath, [editor, ...args], { encoding: 'utf8', windowsHide: true });
}

function commitFixture(extensionRoot) {
  execFileSync('git', ['init'], { cwd: extensionRoot, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: extensionRoot, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: extensionRoot, windowsHide: true });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/fixture.git'], { cwd: extensionRoot, windowsHide: true });
  execFileSync('git', ['add', 'manifest.json'], { cwd: extensionRoot, windowsHide: true });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: extensionRoot, windowsHide: true });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: extensionRoot, encoding: 'utf8', windowsHide: true }).trim();
}

test('registry editor approves an exact clean Git extension root before registration', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-extension-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extensionRoot = path.join(root, 'extension');
  fs.mkdirSync(extensionRoot);
  fs.writeFileSync(path.join(extensionRoot, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Fixture Extension', permissions: ['storage'] }));
  const head = commitFixture(extensionRoot);
  const registryPath = path.join(root, 'registry.json');
  fs.writeFileSync(registryPath, `${JSON.stringify({ schema_version: 1, trusted_roots: [], extensions: [] }, null, 2)}\n`);

  const trustArgs = ['--registry', registryPath, '--action', 'trust-root', '--source-root', extensionRoot,
    '--expected-head', head, '--expected-remote', 'https://example.invalid/fixture.git', '--dry-run', 'true'];
  assert.equal(run(...trustArgs).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(registryPath, 'utf8')).trusted_roots, []);
  trustArgs[trustArgs.length - 1] = 'false';
  assert.equal(run(...trustArgs).status, 0);

  const definitionPath = path.join(root, 'definition.json');
  fs.writeFileSync(definitionPath, JSON.stringify({
    key: 'fixture-extension', path: extensionRoot, slots: ['9225'], allowed_permissions: ['storage'],
    allowed_host_permissions: [], allowed_optional_host_permissions: [], allowed_content_script_matches: [],
    pin_to_toolbar: true, options: { enabled: true, host_access: 'ON_CLICK' }, storage: {}, verify: {}
  }));
  const registered = run('--registry', registryPath, '--action', 'register', '--key', 'fixture-extension',
    '--definition', definitionPath, '--replace', 'false', '--dry-run', 'false');
  assert.equal(registered.status, 0, registered.stderr);
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.equal(registry.extensions[0].key, 'fixture-extension');
  assert.equal(registry.extensions[0].forbid_host_permissions, true);
  assert.equal(registry.trusted_root_evidence[0].git_head, head);
  const verified = spawnSync(process.execPath, [verifier, '--registry', registryPath, '--extension', 'fixture-extension'], { encoding: 'utf8', windowsHide: true });
  assert.equal(verified.status, 0, verified.stderr);

  fs.writeFileSync(path.join(extensionRoot, 'uncommitted.txt'), 'drift');
  const drift = run('--registry', registryPath, '--action', 'register', '--key', 'fixture-extension',
    '--definition', definitionPath, '--replace', 'true', '--dry-run', 'true');
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /clean Git worktree/);
  const blocked = spawnSync(process.execPath, [verifier, '--registry', registryPath, '--extension', 'fixture-extension'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Pinned extension source drift/);

  execFileSync('git', ['add', 'uncommitted.txt'], { cwd: extensionRoot, windowsHide: true });
  execFileSync('git', ['commit', '-m', 'safe update'], { cwd: extensionRoot, windowsHide: true });
  const updatedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: extensionRoot, encoding: 'utf8', windowsHide: true }).trim();
  const remotePivot = run('--registry', registryPath, '--action', 'refresh-trust-root', '--source-root', extensionRoot,
    '--expected-head', updatedHead, '--expected-remote', 'https://evil.invalid/fixture.git', '--dry-run', 'true');
  assert.notEqual(remotePivot.status, 0);
  assert.match(remotePivot.stderr, /cannot change the pinned Git remote/);
  const refreshDryRun = run('--registry', registryPath, '--action', 'refresh-trust-root', '--source-root', extensionRoot,
    '--expected-head', updatedHead, '--expected-remote', 'https://example.invalid/fixture.git', '--dry-run', 'true');
  assert.equal(refreshDryRun.status, 0, refreshDryRun.stderr);
  assert.equal(JSON.parse(fs.readFileSync(registryPath, 'utf8')).trusted_root_evidence[0].git_head, head);
  const refresh = run('--registry', registryPath, '--action', 'refresh-trust-root', '--source-root', extensionRoot,
    '--expected-head', updatedHead, '--expected-remote', 'https://example.invalid/fixture.git', '--dry-run', 'false');
  assert.equal(refresh.status, 0, refresh.stderr);
  assert.equal(JSON.parse(fs.readFileSync(registryPath, 'utf8')).trusted_root_evidence[0].git_head, updatedHead);
  const verifiedAfterRefresh = spawnSync(process.execPath, [verifier, '--registry', registryPath, '--extension', 'fixture-extension'], { encoding: 'utf8', windowsHide: true });
  assert.equal(verifiedAfterRefresh.status, 0, verifiedAfterRefresh.stderr);
});

test('registry editor preserves fail-closed host policy for a badge replacement', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-extension-badge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extensionRoot = path.join(root, 'extensions', 'badge');
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.writeFileSync(path.join(extensionRoot, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Badge', permissions: ['storage'] }));
  const registryPath = path.join(root, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({
    schema_version: 1,
    trusted_roots: [path.dirname(extensionRoot)],
    extensions: [{ key: 'badge', path: extensionRoot, manifest_name: 'Badge', manifest_version: 3,
      allowed_permissions: ['storage'], forbid_host_permissions: true, pin_to_toolbar: true, slots: ['9225'] }]
  }));
  const definitionPath = path.join(root, 'definition.json');
  fs.writeFileSync(definitionPath, JSON.stringify({ key: 'badge', path: extensionRoot, slots: ['9225'],
    allowed_permissions: ['storage'], allowed_host_permissions: [], allowed_optional_host_permissions: [],
    allowed_content_script_matches: [], pin_to_toolbar: true, options: {}, storage: {}, verify: {} }));
  const result = run('--registry', registryPath, '--action', 'register', '--key', 'badge', '--definition', definitionPath,
    '--replace', 'true', '--dry-run', 'true');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).change.entry.forbid_host_permissions, true);
});
