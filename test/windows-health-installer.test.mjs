import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import {
  installWindowsHealth,
  rollbackWindowsHealth,
  windowsHealthInstallStatus,
} from '../tools/platform/aicc/install-windows-health.mjs';

const temporary = [];
const sourceModule = `import { fileURLToPath } from 'node:url';\nconst root = fileURLToPath(new URL('../', import.meta.url));\nexport { root };\n`;
const cliModule = `import { root } from '../../../src/windows-health-repair.mjs';\nconst [command] = process.argv.slice(2);\nif (!['doctor','repair'].includes(command)) throw new Error('doctor|repair');\nconsole.log(root);\n`;
const installedScript = `#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\nif ($args.Count -gt 0 -and $args[0] -in @('doctor','repair')) {\n  & "$basedir/node.exe" 'C:\\demo\\open-AICC\\tools\\platform\\aicc\\windows-native-health.mjs' @args\n  exit $LASTEXITCODE\n}\n& "$basedir/node.exe" "$basedir/node_modules/open-aicc/bin/aicc" $args\nexit $LASTEXITCODE\n`;
const installedCmd = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\open-aicc\\bin\\aicc" %*\r\n`;
const repairAlias = `# Reuse AICC's safe native repair; preserve all authentication and history.\r\n& "$PSScriptRoot\\aicc.ps1" repair @args\r\nexit $LASTEXITCODE\r\n`;

function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function fixture({ aliases = true, shim = true, realAcl = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-windows-health-'));
  temporary.push(base);
  const sourceRoot = path.join(base, 'source');
  const installDir = path.join(base, 'AICC-Tools', 'node-fixture');
  const healthHome = path.join(base, 'owner', '.codex', 'windows-health');
  fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'tools', 'platform', 'aicc'), { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'src', 'windows-health-repair.mjs'), sourceModule);
  fs.writeFileSync(path.join(sourceRoot, 'tools', 'platform', 'aicc', 'windows-native-health.mjs'), cliModule);
  const sourceScript = installedScript.replaceAll('C:\\demo\\open-AICC', sourceRoot);
  fs.writeFileSync(path.join(installDir, 'aicc.ps1'), sourceScript);
  fs.writeFileSync(path.join(installDir, 'node.exe'), 'test-runtime');
  if (shim) fs.writeFileSync(path.join(installDir, 'aicc.cmd'), installedCmd);
  if (aliases) fs.writeFileSync(path.join(installDir, 'codex-repair.ps1'), repairAlias);
  const aclCalls = [];
  const options = {
    platform: 'win32',
    home: path.join(base, 'owner'),
    sourceRoot,
    installDir,
    healthHome,
    ...(realAcl ? {} : { setAcl: (target, mode) => aclCalls.push({ target, mode }) }),
  };
  return { base, sourceRoot, installDir, healthHome, options, aclCalls, sourceScript };
}

function currentUserSid() {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const result = spawnSync(path.join(systemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const sid = result.stdout.match(/S-\d+(?:-\d+)+/)?.[0];
  assert.ok(sid, 'current user SID should be available');
  return sid;
}

function aclSnapshot(target) {
  const escaped = target.replaceAll("'", "''");
  const script = `Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; $acl = Get-Acl -LiteralPath '${escaped}'; $rules = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ sid=$_.IdentityReference.Value; rights=$_.FileSystemRights.ToString(); flags=$_.InheritanceFlags.ToString(); type=$_.AccessControlType.ToString(); inherited=$_.IsInherited } }); [pscustomobject]@{ ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; rules=$rules } | ConvertTo-Json -Compress -Depth 4`;
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const modules = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PSModulePath: modules },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function grantScratchCleanupAccess(root, ownerSid) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const icacls = path.join(systemRoot, 'System32', 'icacls.exe');
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) {
        const result = spawnSync(icacls, [target, '/grant:r', `*${ownerSid}:F`, '/grant', 'SYSTEM:F'], { encoding: 'utf8', windowsHide: true });
        assert.equal(result.status, 0, result.stderr);
      } else assert.fail(`unexpected scratch entry: ${target}`);
    }
    const result = spawnSync(icacls, [dir, '/grant:r', `*${ownerSid}:(OI)(CI)F`, '/grant', 'SYSTEM:(OI)(CI)F'], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  if (fs.existsSync(root)) visit(root);
}

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('dry-run builds the exact release plan without writing or replacing wrappers', () => {
  const env = fixture();
  const beforePs1 = fs.readFileSync(path.join(env.installDir, 'aicc.ps1'));
  const beforeCmd = fs.readFileSync(path.join(env.installDir, 'aicc.cmd'));

  const result = installWindowsHealth({ ...env.options, dryRun: true });

  assert.equal(result.terminal, 'READY');
  assert.equal(result.wrapperChanges.includes('aicc.ps1'), true);
  assert.equal(result.commandShim, 'patch');
  assert.equal(fs.existsSync(env.healthHome), false);
  assert.deepEqual(fs.readFileSync(path.join(env.installDir, 'aicc.ps1')), beforePs1);
  assert.deepEqual(fs.readFileSync(path.join(env.installDir, 'aicc.cmd')), beforeCmd);
});

test('staging commit seals a canonical-root snapshot, connects only doctor and repair, and rolls back exact preimages', () => {
  const env = fixture();
  const ps1Path = path.join(env.installDir, 'aicc.ps1');
  const cmdPath = path.join(env.installDir, 'aicc.cmd');
  const beforePs1 = fs.readFileSync(ps1Path);
  const beforeCmd = fs.readFileSync(cmdPath);
  const beforeAlias = fs.readFileSync(path.join(env.installDir, 'codex-repair.ps1'));

  const result = installWindowsHealth({ ...env.options, commit: true });
  assert.equal(result.terminal, 'PASS');
  assert.equal(result.releaseCreated, true);
  assert.equal(result.status.sourceMatches, true);
  assert.equal(result.status.releaseFilesVerified, true);
  assert.deepEqual(Object.keys(result.status.wrapperDrift), []);
  assert.equal(fs.readFileSync(path.join(env.installDir, 'codex-repair.ps1')).toString(), beforeAlias.toString());
  assert.match(fs.readFileSync(ps1Path, 'utf8'), new RegExp(result.status.releaseDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(fs.readFileSync(ps1Path, 'utf8'), /@\('doctor','repair'\)/);
  const updatedCmd = fs.readFileSync(cmdPath, 'utf8');
  assert.match(updatedCmd, /"%~dp0aicc\.ps1" %\*/);
  assert.ok(updatedCmd.endsWith(installedCmd.slice(installedCmd.indexOf(':find_dp0'))));
  assert.equal(fs.readFileSync(path.join(env.installDir, 'codex-repair.cmd'), 'utf8'), '@ECHO off\r\nCALL "%~dp0aicc.cmd" repair %*\r\nEXIT /B %ERRORLEVEL%\r\n');

  const releaseDir = result.status.releaseDir;
  const snapshot = fs.readFileSync(path.join(releaseDir, 'src', 'windows-health-repair.mjs'), 'utf8');
  assert.ok(snapshot.includes(`const root = ${JSON.stringify(env.sourceRoot)};`));
  const runner = path.join(releaseDir, 'run-windows-health.mjs');
  for (const command of ['doctor', 'repair']) {
    const run = spawnSync(process.execPath, [runner, command], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), env.sourceRoot);
  }
  assert.equal(spawnSync(process.execPath, [runner, 'invalid'], { encoding: 'utf8' }).stderr.includes('doctor|repair'), true);
  assert.ok(env.aclCalls.some(call => call.mode === 'immutable' && path.dirname(call.target) === path.join(env.healthHome, 'releases')));
  assert.ok(env.aclCalls.some(call => call.mode === 'private' && call.target === path.join(env.healthHome, 'install-state.json')));

  const rolledBack = rollbackWindowsHealth(env.options);
  assert.equal(rolledBack.terminal, 'PASS');
  assert.equal(rolledBack.releasePreserved, true);
  assert.deepEqual(fs.readFileSync(ps1Path), beforePs1);
  assert.deepEqual(fs.readFileSync(cmdPath), beforeCmd);
  assert.deepEqual(fs.readFileSync(path.join(env.installDir, 'codex-repair.ps1')), beforeAlias);
  assert.equal(fs.existsSync(path.join(env.installDir, 'codex-repair.cmd')), false);
  assert.equal(fs.existsSync(path.join(env.healthHome, 'install-state.json')), false);
  assert.equal(windowsHealthInstallStatus(env.options).terminal, 'NOT_INSTALLED');
});

test('health source drift blocks status and installed runner before importing the snapshot', () => {
  const env = fixture();
  const result = installWindowsHealth({ ...env.options, commit: true });
  const source = path.join(env.sourceRoot, 'src', 'windows-health-repair.mjs');
  fs.appendFileSync(source, '\n// drift\n');

  const status = windowsHealthInstallStatus(env.options);
  assert.equal(status.terminal, 'HOLD');
  assert.equal(status.sourceMatches, false);
  assert.deepEqual(status.sourceDrift, ['src/windows-health-repair.mjs']);
  const run = spawnSync(process.execPath, [path.join(result.status.releaseDir, 'run-windows-health.mjs'), 'invalid'], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /health_source_drift/);
  const rolledBack = rollbackWindowsHealth(env.options);
  assert.equal(rolledBack.terminal, 'PASS');
  assert.deepEqual(fs.readFileSync(path.join(env.installDir, 'aicc.ps1')), Buffer.from(env.sourceScript));
});

test('clean source drift upgrades to a new release and retains the original rollback preimages', () => {
  const env = fixture();
  const ps1Path = path.join(env.installDir, 'aicc.ps1');
  const cmdPath = path.join(env.installDir, 'aicc.cmd');
  const aliasPath = path.join(env.installDir, 'codex-repair.ps1');
  const originalPs1 = fs.readFileSync(ps1Path);
  const originalCmd = fs.readFileSync(cmdPath);
  const originalAlias = fs.readFileSync(aliasPath);
  installWindowsHealth({ ...env.options, commit: true });
  const firstInstalledPs1 = fs.readFileSync(ps1Path);
  const firstInstalledCmd = fs.readFileSync(cmdPath);
  const priorState = JSON.parse(fs.readFileSync(path.join(env.healthHome, 'install-state.json'), 'utf8'));
  const priorReleaseHash = priorState.releaseHash;
  const originalBackup = priorState.changedFiles['aicc.ps1'].preimage;

  fs.appendFileSync(path.join(env.sourceRoot, 'src', 'windows-health-repair.mjs'), '\n// maintenance update\n');
  const dryRun = installWindowsHealth({ ...env.options, dryRun: true });
  assert.equal(dryRun.terminal, 'READY');
  assert.equal(dryRun.upgrade, true);
  assert.equal(dryRun.previousReleaseHash, priorReleaseHash);
  assert.deepEqual(fs.readFileSync(ps1Path), firstInstalledPs1);

  const upgraded = installWindowsHealth({ ...env.options, commit: true });
  assert.equal(upgraded.terminal, 'PASS');
  assert.equal(upgraded.upgrade, true);
  assert.notEqual(upgraded.status.releaseHash, priorReleaseHash);
  assert.equal(upgraded.status.sourceMatches, true);
  assert.deepEqual(upgraded.status.wrapperDrift, []);
  assert.deepEqual(upgraded.status.preimageDrift, []);
  assert.deepEqual(fs.readFileSync(cmdPath), firstInstalledCmd);
  assert.deepEqual(fs.readFileSync(aliasPath), originalAlias);

  const upgradedState = JSON.parse(fs.readFileSync(path.join(env.healthHome, 'install-state.json'), 'utf8'));
  assert.deepEqual(upgradedState.changedFiles['aicc.ps1'].preimage, originalBackup);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(originalBackup.path)).digest('hex'), originalBackup.sha256);
  const rollback = rollbackWindowsHealth(env.options);
  assert.equal(rollback.terminal, 'PASS');
  assert.deepEqual(fs.readFileSync(ps1Path), originalPs1);
  assert.deepEqual(fs.readFileSync(cmdPath), originalCmd);
  assert.deepEqual(fs.readFileSync(aliasPath), originalAlias);
});

test('upgrade refuses wrapper or original-preimage drift and rollback checks all backups before restoring', () => {
  const changedWrapper = fixture();
  installWindowsHealth({ ...changedWrapper.options, commit: true });
  fs.appendFileSync(path.join(changedWrapper.sourceRoot, 'src', 'windows-health-repair.mjs'), '\n// source update\n');
  const changedCmd = path.join(changedWrapper.installDir, 'aicc.cmd');
  const editedCmdBytes = Buffer.concat([fs.readFileSync(changedCmd), Buffer.from('REM owner edit\r\n')]);
  fs.writeFileSync(changedCmd, editedCmdBytes);
  assert.throws(() => installWindowsHealth({ ...changedWrapper.options, commit: true }), /existing_health_install_not_upgradeable/);
  assert.deepEqual(fs.readFileSync(changedCmd), editedCmdBytes);

  const rerouted = fixture();
  installWindowsHealth({ ...rerouted.options, commit: true });
  fs.appendFileSync(path.join(rerouted.sourceRoot, 'src', 'windows-health-repair.mjs'), '\n// source update\n');
  const reroutedStatePath = path.join(rerouted.healthHome, 'install-state.json');
  const reroutedState = JSON.parse(fs.readFileSync(reroutedStatePath, 'utf8'));
  const reroutedScriptPath = path.join(rerouted.installDir, 'aicc.ps1');
  const currentScript = fs.readFileSync(reroutedScriptPath, 'utf8');
  const oldRunner = path.join(reroutedState.releaseDir, 'run-windows-health.mjs');
  const sourceCli = path.join(rerouted.sourceRoot, 'tools', 'platform', 'aicc', 'windows-native-health.mjs');
  const sourceReroutedScript = currentScript.replace(oldRunner, sourceCli);
  fs.writeFileSync(reroutedScriptPath, sourceReroutedScript);
  reroutedState.changedFiles['aicc.ps1'].installedSha256 = hash(Buffer.from(sourceReroutedScript));
  fs.writeFileSync(reroutedStatePath, JSON.stringify(reroutedState, null, 2) + '\n');
  assert.throws(() => installWindowsHealth({ ...rerouted.options, commit: true }), /installed_branch_target_mismatch/);

  const changedBackup = fixture();
  installWindowsHealth({ ...changedBackup.options, commit: true });
  fs.appendFileSync(path.join(changedBackup.sourceRoot, 'src', 'windows-health-repair.mjs'), '\n// source update\n');
  const statePath = path.join(changedBackup.healthHome, 'install-state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const backupPath = state.changedFiles['aicc.ps1'].preimage.path;
  fs.appendFileSync(backupPath, '\n// backup drift\n');
  const installedPs1 = fs.readFileSync(path.join(changedBackup.installDir, 'aicc.ps1'));
  const status = windowsHealthInstallStatus(changedBackup.options);
  assert.equal(status.terminal, 'HOLD');
  assert.deepEqual(status.preimageDrift, ['aicc.ps1']);
  assert.throws(() => installWindowsHealth({ ...changedBackup.options, commit: true }), /existing_health_install_not_upgradeable/);
  assert.throws(() => rollbackWindowsHealth(changedBackup.options), /rollback_backup_drift:aicc\.ps1/);
  assert.deepEqual(fs.readFileSync(path.join(changedBackup.installDir, 'aicc.ps1')), installedPs1);
});

test('tampered immutable release and wrapper drift fail closed', () => {
  const env = fixture();
  const result = installWindowsHealth({ ...env.options, commit: true });
  fs.appendFileSync(path.join(result.status.releaseDir, 'tools', 'platform', 'aicc', 'windows-native-health.mjs'), '\n// tamper\n');
  assert.throws(() => windowsHealthInstallStatus(env.options), /health_release_file_hash_mismatch/);

  const clean = fixture();
  const installed = installWindowsHealth({ ...clean.options, commit: true });
  fs.appendFileSync(path.join(clean.installDir, 'aicc.cmd'), 'REM user edit\r\n');
  const status = windowsHealthInstallStatus(clean.options);
  assert.equal(status.terminal, 'HOLD');
  assert.deepEqual(status.wrapperDrift, ['aicc.cmd']);
  assert.throws(() => rollbackWindowsHealth(clean.options), /rollback_target_drift:aicc\.cmd/);
  assert.ok(fs.existsSync(path.join(installed.status.releaseDir, 'manifest.json')));
});

test('install refuses ambiguous source anchors, branch shapes, and modified repair aliases', () => {
  const duplicated = fixture();
  fs.appendFileSync(path.join(duplicated.sourceRoot, 'src', 'windows-health-repair.mjs'), HEALTH_ROOT_LINE_FOR_TEST);
  assert.throws(() => installWindowsHealth({ ...duplicated.options, dryRun: true }), /health_root_anchor_must_appear_once/);

  const unknown = fixture();
  fs.writeFileSync(path.join(unknown.installDir, 'aicc.ps1'), installedScript.replace("@('doctor','repair')", "@('doctor')"));
  assert.throws(() => installWindowsHealth({ ...unknown.options, dryRun: true }), /exact_doctor_repair_branch_required/);

  const rerouted = fixture();
  fs.writeFileSync(path.join(rerouted.installDir, 'aicc.ps1'), rerouted.sourceScript.replace(rerouted.sourceRoot, 'C:\\other\\project'));
  assert.throws(() => installWindowsHealth({ ...rerouted.options, dryRun: true }), /source_health_branch_target_mismatch/);

  const alias = fixture();
  fs.writeFileSync(path.join(alias.installDir, 'codex-repair.ps1'), 'user-owned customization');
  assert.throws(() => installWindowsHealth({ ...alias.options, dryRun: true }), /repair_alias_conflict/);
});

test('CMD alias is omitted when no CMD shim exists and unknown shims are otherwise preserved', () => {
  const env = fixture({ shim: false, aliases: false });
  const result = installWindowsHealth({ ...env.options, commit: true });
  assert.equal(result.terminal, 'PASS');
  assert.equal(fs.existsSync(path.join(env.installDir, 'codex-repair.ps1')), true);
  assert.equal(fs.existsSync(path.join(env.installDir, 'codex-repair.cmd')), false);

  const unknown = fixture();
  fs.writeFileSync(path.join(unknown.installDir, 'aicc.cmd'), '@ECHO off\r\nREM custom shim\r\n');
  const customCmd = fs.readFileSync(path.join(unknown.installDir, 'aicc.cmd'));
  const staged = installWindowsHealth({ ...unknown.options, dryRun: true });
  assert.equal(staged.commandShim, 'unchanged-unrecognized');
  const committed = installWindowsHealth({ ...unknown.options, commit: true });
  assert.equal(committed.terminal, 'PASS');
  assert.deepEqual(fs.readFileSync(path.join(unknown.installDir, 'aicc.cmd')), customCmd);
  assert.equal(fs.existsSync(path.join(unknown.installDir, 'codex-repair.cmd')), false);
});

test('real Windows staging ACL leaves every immutable snapshot readable and owned by the current user', { skip: process.platform !== 'win32' }, () => {
  const env = fixture({ realAcl: true });
  const ownerSid = currentUserSid();
  try {
    const result = installWindowsHealth({ ...env.options, commit: true });
    assert.equal(result.terminal, 'PASS');
    const manifestPath = path.join(result.status.releaseDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const files = [...Object.keys(manifest.files), 'manifest.json'];
    const directories = new Set([result.status.releaseDir]);
    for (const relative of files) {
      const target = path.join(result.status.releaseDir, ...relative.split('/'));
      const bytes = fs.readFileSync(target);
      if (relative !== 'manifest.json') assert.equal(hash(bytes), manifest.files[relative]);
      const acl = aclSnapshot(target);
      assert.equal(acl.ownerSid, ownerSid, `owner changed for ${relative}`);
      const rules = Array.isArray(acl.rules) ? acl.rules : [acl.rules];
      for (const sid of [ownerSid, 'S-1-5-18']) {
        const rule = rules.find(candidate => candidate?.sid === sid);
        assert.ok(rule, `explicit ACL missing for ${sid} on ${relative}`);
        assert.equal(rule.type, 'Allow');
        assert.equal(rule.inherited, false);
        assert.match(rule.rights, /ReadAndExecute/);
        assert.equal(rule.flags, 'None');
      }
      for (let dir = path.dirname(target); dir.startsWith(result.status.releaseDir); dir = path.dirname(dir)) directories.add(dir);
    }
    for (const dir of directories) {
      const acl = aclSnapshot(dir);
      assert.equal(acl.ownerSid, ownerSid, `owner changed for ${path.relative(result.status.releaseDir, dir) || '.'}`);
      const rules = Array.isArray(acl.rules) ? acl.rules : [acl.rules];
      for (const sid of [ownerSid, 'S-1-5-18']) {
        const rule = rules.find(candidate => candidate?.sid === sid);
        assert.ok(rule, `explicit directory ACL missing for ${sid}`);
        assert.equal(rule.type, 'Allow');
        assert.equal(rule.inherited, false);
        assert.match(rule.rights, /ReadAndExecute/);
        assert.match(rule.flags, /ObjectInherit/);
        assert.match(rule.flags, /ContainerInherit/);
      }
    }
  } finally {
    grantScratchCleanupAccess(env.healthHome, ownerSid);
  }
});

const HEALTH_ROOT_LINE_FOR_TEST = "\nconst root = fileURLToPath(new URL('../', import.meta.url));\n";
