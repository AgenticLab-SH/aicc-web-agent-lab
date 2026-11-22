import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { processStartTokenHash } from '../src/recovery/attempt-journal.mjs';
import { createInstalledCliRouteAdapter, sealInstalledCliCandidate, verifyInstalledCliCandidate } from '../src/recovery/installed-cli-route-adapter.mjs';
import { createRestoreV2Candidate } from '../src/recovery/restore-v2-candidate.mjs';

const RECOVERY_SCRIPT = path.resolve('tools/platform/aicc/restore-installed-cli-route.ps1');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function link(directory, target) {
  fs.symlinkSync(target, directory, process.platform === 'win32' ? 'junction' : 'dir');
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-installed-cli-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = path.join(root, 'current');
  const candidate = path.join(root, 'candidate');
  const installRoot = path.join(root, 'install');
  const entry = path.join(installRoot, 'open-aicc');
  const backupRoot = path.join(root, 'backups');
  const journalRoot = path.join(root, 'journal');
  fs.mkdirSync(current, { recursive: true });
  fs.mkdirSync(candidate, { recursive: true });
  fs.mkdirSync(installRoot, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });
  for (const relative of ['bin/aicc', 'src/cli.mjs', 'src/recovery/restore-v2-command.mjs']) {
    const file = path.join(candidate, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `candidate:${relative}\n`);
  }
  sealInstalledCliCandidate(candidate, { sourceRevision: 'a'.repeat(40) });
  const wrappers = ['aicc', 'aicc.cmd', 'aicc.ps1'].map(name => {
    const file = path.join(installRoot, name);
    fs.writeFileSync(file, `wrapper:${name}\n`);
    return file;
  });
  const pointer = path.join(root, 'legacy-pointer.json');
  fs.writeFileSync(pointer, '{"schemaVersion":1}\n');
  link(entry, current);
  const adapter = createInstalledCliRouteAdapter({
    entryPath: entry,
    candidatePath: candidate,
    backupRoot,
    wrapperPaths: wrappers,
    legacyPointerPath: pointer,
    recoveryScriptPath: RECOVERY_SCRIPT
  });
  const candidateRunner = createRestoreV2Candidate({
    adapters: { 'installed-cli-route': adapter },
    journalRoot,
    inspectGlobalActivity: async () => ({ readOk: true, generationHash: 'd'.repeat(64), domains: [{ id: 'all', active: 0, unknown: 0 }] }),
    writerIdentity: { pid: process.pid, processStartTokenHash: processStartTokenHash({ pid: process.pid, startedAt: '2026-09-17T00:00:00.000Z' }) },
    gateSamples: 1,
    gateIntervalMs: 0
  });
  return { root, current, candidate, entry, backupRoot, journalRoot, adapter, candidateRunner };
}

function args(mode, operationId, attemptId = 'attempt-1') {
  return [
    'installed-cli-route', mode,
    '--operation-id', operationId,
    '--attempt-id', attemptId
  ];
}

function backupTarget(state, operationId, attemptId = 'attempt-1') {
  return path.join(state.backupRoot, `${operationId}-${attemptId}`);
}

test('installed CLI route backs up, switches once, and blocks replay', async t => {
  const state = fixture(t);
  const initial = await state.adapter.inspect();
  assert.equal(initial.fingerprintVerified, true);
  assert.equal(initial.current, false);
  const expectedBackup = backupTarget(state, 'cli-cutover');
  const applied = await state.candidateRunner.run(args('--apply', 'cli-cutover'));
  assert.equal(applied.result.terminal, 'PASS');
  assert.equal(fs.existsSync(path.join(expectedBackup, 'manifest.json')), true);
  assert.equal(path.resolve(fs.readlinkSync(state.entry)), state.candidate);
  const replay = await state.candidateRunner.run(args('--apply', 'cli-cutover'));
  assert.equal(replay.result.reason, 'attempt_already_terminal');
  assert.equal(path.resolve(fs.readlinkSync(state.entry)), state.candidate);
});

test('candidate manifest drift fails before backup creation', async t => {
  const state = fixture(t);
  fs.appendFileSync(path.join(state.candidate, 'src', 'cli.mjs'), 'drift\n');
  const inspection = await state.adapter.inspect();
  assert.equal(inspection.fingerprintVerified, false);
  const expectedBackup = backupTarget(state, 'cli-drift');
  const result = await state.candidateRunner.run(args('--apply', 'cli-drift'));
  assert.equal(result.result.reason, 'fingerprint_unproven');
  assert.equal(fs.existsSync(expectedBackup), false);
  assert.equal(path.resolve(fs.readlinkSync(state.entry)), state.current);
});

test('candidate inventory rejects unsealed extra files and symlinks', async t => {
  const state = fixture(t);
  fs.writeFileSync(path.join(state.candidate, 'unsealed.txt'), 'extra\n');
  assert.equal((await state.adapter.inspect()).reason, 'candidate_inventory_mismatch');
  fs.rmSync(path.join(state.candidate, 'unsealed.txt'));
  const unsafe = path.join(state.candidate, 'unsafe-link');
  link(unsafe, state.current);
  assert.equal((await state.adapter.inspect()).reason, 'candidate_tree_symlink');
});

test('candidate verifier accepts a full inventory manifest larger than the old 256 KB cap', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-large-release-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of ['bin/aicc', 'src/cli.mjs', 'src/recovery/restore-v2-command.mjs']) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `required:${relative}\n`);
  }
  const bulk = path.join(root, 'bulk');
  fs.mkdirSync(bulk);
  for (let index = 0; index < 2_600; index += 1) {
    fs.writeFileSync(path.join(bulk, `${String(index).padStart(4, '0')}.txt`), `${index}\n`);
  }
  const sealed = sealInstalledCliCandidate(root, { sourceRevision: 'b'.repeat(40) });
  assert.ok(fs.statSync(sealed.manifestFile).size > 256_000);
  assert.equal(verifyInstalledCliCandidate(root).ok, true);
});

test('failed junction swap restores the old link and reconciles as known no effect', async t => {
  const state = fixture(t);
  const initial = await state.adapter.inspect();
  const expectedBackup = backupTarget(state, 'cli-swap-failure');
  const originalRename = fs.renameSync;
  let renameCalls = 0;
  fs.renameSync = (...values) => {
    renameCalls += 1;
    if (renameCalls === 2) throw new Error('injected_second_rename_failure');
    return originalRename(...values);
  };
  t.after(() => { fs.renameSync = originalRename; });
  const applied = await state.candidateRunner.run(args('--apply', 'cli-swap-failure'));
  assert.equal(applied.result.terminal, 'RECONCILE_REQUIRED');
  assert.equal(path.resolve(fs.readlinkSync(state.entry)), state.current);
  fs.renameSync = originalRename;
  assert.equal(fs.existsSync(path.join(expectedBackup, 'manifest.json')), true);
  const reconciled = await state.candidateRunner.run(args('--reconcile', 'cli-swap-failure'));
  assert.equal(reconciled.result.terminal, 'FAILED');
  assert.equal(reconciled.result.reason, 'known_no_effect');
});

test('backup contains a hash-bound recovery command independent of AICC Node code', async t => {
  if (process.platform !== 'win32') return t.skip('PowerShell junction recovery is Windows-only');
  const state = fixture(t);
  const initial = await state.adapter.inspect();
  const expectedBackup = backupTarget(state, 'cli-independent-recovery');
  const applied = await state.candidateRunner.run(args('--apply', 'cli-independent-recovery'));
  assert.equal(applied.result.terminal, 'PASS');
  const manifestFile = path.join(expectedBackup, 'manifest.json');
  const manifestHash = sha256(manifestFile);
  const powershell = process.env.PWSH_EXE ?? 'pwsh';
  const { spawnSync } = await import('node:child_process');
  const recovery = spawnSync(powershell, [
    '-NoProfile', '-File', path.join(expectedBackup, 'restore-installed-cli-route.ps1'),
    '-BackupTarget', expectedBackup,
    '-ExpectedManifestSha256', manifestHash
  ], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.equal(JSON.parse(recovery.stdout).terminal, 'ROLLED_BACK');
  assert.equal(path.resolve(fs.readlinkSync(state.entry)), state.current);
});
