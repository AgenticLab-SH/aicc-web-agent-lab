import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ExtensionManager, ExtensionRegistry } from '../src/extensions/registry.mjs';
import { extensionRegistryStatus } from '../src/extensions/status.mjs';

const aiccRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function checksums(packageRoot) {
  const file = path.join(packageRoot, 'checksums.sha256');
  const lines = walk(packageRoot)
    .filter(item => item !== file)
    .map(item => ({ item, relative: path.relative(packageRoot, item).split(path.sep).join('/') }))
    .sort((a, b) => a.relative.localeCompare(b.relative))
    .map(entry => `${hash(entry.item)}  ${entry.relative}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-extension-registry-'));
  const packageRoot = path.join(root, 'plugins', 'web-gpt-orchestrator');
  fs.mkdirSync(path.dirname(packageRoot), { recursive: true });
  fs.cpSync(path.join(aiccRoot, 'plugins', 'web-gpt-orchestrator'), packageRoot, { recursive: true });
  fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
  fs.copyFileSync(path.join(aiccRoot, 'extensions', 'registry.json'), path.join(root, 'extensions', 'registry.json'));
  fs.mkdirSync(path.join(root, '.agents', 'plugins'), { recursive: true });
  fs.copyFileSync(path.join(aiccRoot, '.agents', 'plugins', 'marketplace.json'), path.join(root, '.agents', 'plugins', 'marketplace.json'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, packageRoot, registryFile: path.join(root, 'extensions', 'registry.json') };
}

function setVersion(paths, version) {
  const manifestFile = path.join(paths.packageRoot, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const registry = JSON.parse(fs.readFileSync(paths.registryFile, 'utf8'));
  registry.extensions[0].source.version = version;
  registry.extensions[0].source.revision = `fixture-${version}`;
  fs.writeFileSync(paths.registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  checksums(paths.packageRoot);
}

test('canonical public registry validates manifest SBOM NOTICE exact files and secret scan', () => {
  const validated = new ExtensionRegistry().validate();
  assert.equal(validated.ok, true);
  assert.equal(validated.extensionCount, 1);
  assert.equal(validated.marketplace.name, 'aicc-local');
  assert.equal(validated.extensions[0].id, 'web-gpt-orchestrator');
  assert.equal(validated.extensions[0].fileCount, 7);
  assert.equal(validated.extensions[0].secretScan, 'pass');
  const status = extensionRegistryStatus();
  assert.equal(status.state, 'ready');
  assert.equal(status.extensions[0].mcpToolCount, 8);
});

test('checksum manifests accept Windows CRLF line endings', t => {
  const paths = fixture(t);
  const checksumFile = path.join(paths.packageRoot, 'checksums.sha256');
  fs.writeFileSync(checksumFile, fs.readFileSync(checksumFile, 'utf8').replace(/\r?\n/g, '\n'));
  const validated = new ExtensionRegistry({ root: paths.root, file: paths.registryFile }).validate();
  assert.equal(validated.ok, true);
});

test('task-owned clean install disable upgrade and rollback preserve verified packages', t => {
  const paths = fixture(t);
  const installRoot = path.join(paths.root, 'install-root');
  const registry = new ExtensionRegistry({ root: paths.root, file: paths.registryFile });
  const manager = new ExtensionManager({ registry, installRoot, now: () => Date.parse('2026-08-09T20:00:00Z') });
  const installed = manager.install('web-gpt-orchestrator');
  assert.equal(installed.version, '0.1.0');
  assert.equal(manager.setEnabled('web-gpt-orchestrator', false).enabled, false);
  assert.equal(manager.setEnabled('web-gpt-orchestrator', true).enabled, true);
  setVersion(paths, '0.2.0');
  const upgraded = manager.install('web-gpt-orchestrator');
  assert.equal(upgraded.version, '0.2.0');
  assert.notEqual(upgraded.digest, installed.digest);
  const rolledBack = manager.rollback('web-gpt-orchestrator');
  assert.equal(rolledBack.version, '0.1.0');
  assert.equal(rolledBack.digest, installed.digest);
  assert.ok(fs.existsSync(manager.status('web-gpt-orchestrator').packagePath));
});

test('integrity mismatch and recomputed secret-bearing packages fail before install', t => {
  const paths = fixture(t);
  const registry = new ExtensionRegistry({ root: paths.root, file: paths.registryFile });
  fs.appendFileSync(path.join(paths.packageRoot, 'NOTICE'), '\nchanged without checksum\n');
  assert.throws(() => registry.validate(), /checksum mismatch/);
  checksums(paths.packageRoot);
  fs.appendFileSync(path.join(paths.packageRoot, 'NOTICE'), '\npassword = "this-is-a-fake-but-prohibited-value"\n');
  checksums(paths.packageRoot);
  assert.throws(() => registry.validate(), /secret-like content/);
});

test('uninstall quarantines only the extension and keeps unrelated state recoverable', t => {
  const paths = fixture(t);
  const installRoot = path.join(paths.root, 'install-root');
  const sentinel = path.join(installRoot, 'user-artifact.txt');
  fs.mkdirSync(installRoot, { recursive: true });
  fs.writeFileSync(sentinel, 'preserve me\n');
  const manager = new ExtensionManager({ registry: new ExtensionRegistry({ root: paths.root, file: paths.registryFile }), installRoot, now: () => 12345 });
  manager.install('web-gpt-orchestrator');
  const removed = manager.uninstall('web-gpt-orchestrator');
  assert.equal(removed.recoverable, true);
  assert.ok(fs.existsSync(removed.quarantinePath));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve me\n');
  assert.equal(manager.status('web-gpt-orchestrator').installed, false);
});
