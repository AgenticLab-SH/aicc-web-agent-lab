import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { backupPrivateHome, initializePrivateHome, privateHomeErasePlan, privateHomeStatus, rehearsePrivateHomeRestore, resolvePrivateHome } from '../src/private-home.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-private-home-test-'));
  const stateRoot = path.join(home, 'selected-private-home');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, stateRoot };
}

test('private home is user-selected, owner-only, and inventories external state without relocation', t => {
  const paths = fixture(t);
  const result = initializePrivateHome({ ...paths, exists: item => item.endsWith('.codex') });
  assert.equal(result.ok, true);
  assert.equal(result.selection, 'user-selected');
  if (process.platform !== 'win32') assert.equal(fs.statSync(paths.stateRoot).mode & 0o077, 0);
  const external = JSON.parse(fs.readFileSync(result.externalStatePath, 'utf8'));
  assert.equal(external.entries.length, 8);
  assert.ok(external.entries.every(entry => entry.movableByAicc === false));
  const credentialId = process.platform === 'win32' ? 'windows-credential-manager' : 'macos-keychain';
  assert.equal(external.entries.find(entry => entry.id === credentialId).path, null);
  assert.equal(resolvePrivateHome(paths).root, paths.stateRoot);
});

test('Windows private home inventory uses Windows application state paths', t => {
  const paths = fixture(t);
  const localAppData = path.join(paths.home, 'AppData', 'Local');
  const appData = path.join(paths.home, 'AppData', 'Roaming');
  const result = initializePrivateHome({ ...paths, platform: 'win32', env: { LOCALAPPDATA: localAppData, APPDATA: appData } });
  const external = JSON.parse(fs.readFileSync(result.externalStatePath, 'utf8'));
  assert.equal(external.entries.find(entry => entry.id === 'chrome-profile').path, path.join(localAppData, 'Google', 'Chrome', 'User Data'));
  assert.equal(external.entries.find(entry => entry.id === 'codex-desktop').path, path.join(appData, 'Codex'));
  assert.equal(external.entries.find(entry => entry.id === 'windows-credential-manager').path, null);
  assert.equal(external.entries.some(entry => entry.id === 'macos-keychain'), false);
});

test('private home backup copies only whitelisted declarative state and restores by exact hash', t => {
  const paths = fixture(t);
  initializePrivateHome(paths);
  fs.writeFileSync(path.join(paths.stateRoot, 'config.env'), 'AICC_PORT=4381\n', { mode: 0o600 });
  fs.mkdirSync(path.join(paths.stateRoot, 'workspace-mcp', 'secrets'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.stateRoot, 'workspace-mcp', 'secrets', 'tunnel-runtime.key'), 'never-copy', { mode: 0o600 });
  const backup = backupPrivateHome({ ...paths, label: 'fixture' });
  assert.equal(backup.fileCount, 1);
  assert.equal(backup.rawSecretsCopied, false);
  assert.equal(fs.existsSync(path.join(backup.destination, 'files', 'workspace-mcp', 'secrets', 'tunnel-runtime.key')), false);
  assert.deepEqual(rehearsePrivateHomeRestore({ backup: backup.destination }), { ok: true, verified: 1, rawSecretsRestored: false, rehearsalRootRemoved: true });
  assert.deepEqual(privateHomeErasePlan(paths), {
    ok: true,
    mode: 'plan-only',
    approvalRequired: true,
    exactTargets: ['config.env'],
    excluded: ['external-state entries', 'Keychain', 'browser profiles', 'auth/session/account databases', 'raw secrets'],
    deletionPerformed: false
  });
  assert.equal(privateHomeStatus(paths).migrationRequired, false);
});

test('private home rejects filesystem roots and symlink-owned movable state', t => {
  const paths = fixture(t);
  assert.throws(() => resolvePrivateHome({ stateRoot: path.parse(paths.stateRoot).root, home: paths.home }), /filesystem root/);
  initializePrivateHome(paths);
  const external = path.join(paths.home, 'external-config');
  fs.writeFileSync(external, 'AICC_PORT=4381\n', { mode: 0o600 });
  fs.symlinkSync(external, path.join(paths.stateRoot, 'config.env'));
  assert.throws(() => backupPrivateHome({ ...paths, label: 'symlink' }), /real file/);
});
