import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexCliUpdateStatus, resolveNpmExecutable } from '../src/codex-cli-update.mjs';
import { restoreManagedCodexRelease } from '../src/codex-cli-update-command.mjs';

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-codex-update-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const releases = path.join(codexHome, 'packages', 'standalone', 'releases');
  const previous = path.join(releases, '0.146.0-arm64');
  const next = path.join(releases, '0.147.0-arm64');
  for (const release of [previous, next]) {
    fs.mkdirSync(path.join(release, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(release, 'bin', 'codex'), '#!/bin/sh\n');
  }
  const current = path.join(codexHome, 'packages', 'standalone', 'current');
  fs.symlinkSync(previous, current);
  const localBin = path.join(home, '.local', 'bin');
  fs.mkdirSync(localBin, { recursive: true });
  const executable = path.join(localBin, 'codex');
  fs.symlinkSync(path.join(current, 'bin', 'codex'), executable);
  return { home, codexHome, releases, previous, next, current, executable };
}

test('Codex CLI update status distinguishes official standalone CLI, daemon and latest npm release', async t => {
  const paths = fixture(t);
  const result = await codexCliUpdateStatus({
    platform: 'linux',
    home: paths.home,
    codexHome: paths.codexHome,
    codexExecutable: paths.executable,
    inspectWork: () => ({ safe: true, active: [], unknown: [] }),
    runCommand: async (_executable, args) => {
      if (args[0] === '--version') return { ok: true, stdout: 'codex-cli 0.146.0\n' };
      if (args[0] === 'view') return { ok: true, stdout: '"0.147.0"\n' };
      return { ok: true, stdout: '{"status":"running","appServerVersion":"0.146.0","cliVersion":"0.146.0"}\n' };
    }
  });
  assert.equal(result.managedStandalone, true);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latestVersion, '0.147.0');
  assert.equal(result.work.safe, true);
});

test('managed Codex rollback changes only the owner current symlink', t => {
  const paths = fixture(t);
  restoreManagedCodexRelease({ currentLink: paths.current, previousRelease: paths.next, releasesRoot: paths.releases });
  assert.equal(fs.realpathSync(paths.current), paths.next);
  assert.ok(fs.existsSync(paths.previous));
});

test('Codex CLI status resolves npm beside the launchd Node executable when PATH is restricted', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-node-runtime-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const node = path.join(root, 'node');
  const npm = path.join(root, 'npm');
  fs.writeFileSync(node, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(npm, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(resolveNpmExecutable({ nodeExecutable: node, environment: {}, platform: 'linux' }), npm);
});

test('Codex CLI status resolves the Windows npm.cmd sibling and invokes it through ComSpec', async t => {
  const nodeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-node-win-')));
  t.after(() => fs.rmSync(nodeRoot, { recursive: true, force: true }));
  const nodeExecutable = path.join(nodeRoot, 'node.exe');
  const npmExecutable = path.join(nodeRoot, 'npm.cmd');
  fs.writeFileSync(nodeExecutable, '');
  fs.writeFileSync(npmExecutable, '@echo off\r\n');
  const calls = [];
  const environment = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const result = await codexCliUpdateStatus({
    platform: 'win32',
    home: 'C:\\demo\\owner',
    codexHome: 'C:\\demo\\owner\\.codex',
    nodeExecutable,
    codexExecutable: 'C:\\Tools\\codex.exe',
    environment,
    inspectWork: () => ({ safe: true, active: [], unknown: [] }),
    runCommand: async (executable, args) => {
      calls.push([executable, args]);
      if (args[0] === '--version') return { ok: true, stdout: 'codex-cli 0.146.0\n' };
      if (args.includes('view')) return { ok: true, stdout: '"0.147.0"\n' };
      return { ok: true, stdout: '{"status":"running","appServerVersion":"0.146.0","cliVersion":"0.146.0"}\n' };
    }
  });
  assert.equal(result.latestVersion, '0.147.0');
  const npmCall = calls.find(([, args]) => args.includes('view'));
  assert.deepEqual(npmCall, [
    environment.ComSpec,
    ['/d', '/s', '/c', npmExecutable, 'view', '@openai/codex', 'version', '--json']
  ]);
});
