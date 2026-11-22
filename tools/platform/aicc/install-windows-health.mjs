#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_SOURCE_ROOT = 'C:\\demo\\open-AICC';
const HEALTH_RELATIVE = 'src/windows-health-repair.mjs';
const CLI_RELATIVE = 'tools/platform/aicc/windows-native-health.mjs';
const RUNNER_RELATIVE = 'run-windows-health.mjs';
const HEALTH_ROOT_LINE = "const root = fileURLToPath(new URL('../', import.meta.url));";
const STATE_VERSION = 1;
const PREFIX = 'AICC Windows native health';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function releaseIdentity({ files, sourceFiles, sourceRoot }) {
  return sha256(JSON.stringify({ files: sortedObject(files), sourceFiles: sortedObject(sourceFiles), sourceRoot }));
}

function assertRegularPath(file) {
  const absolute = path.resolve(file);
  for (let cursor = absolute; ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error('linked_path_refused');
    if (path.dirname(cursor) === cursor) break;
  }
  if (!fs.statSync(absolute).isFile()) throw new Error('regular_file_required');
}

function assertDirectoryPath(dir) {
  const absolute = path.resolve(dir);
  for (let cursor = absolute; ; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error('linked_path_refused');
    if (path.dirname(cursor) === cursor) break;
  }
  if (!fs.statSync(absolute).isDirectory()) throw new Error('directory_required');
}

function normalizeRoot(root) {
  return fs.realpathSync.native(path.resolve(root));
}

function parseBranch(script) {
  const expression = /^([ \t]*)if \(\$args\.Count -gt 0 -and \$args\[0\] -in @\('doctor','repair'\)\) \{\r?\n([ \t]*)& "\$basedir\/node\.exe" '([^'\r\n]+)' @args\r?\n([ \t]*)exit \$LASTEXITCODE\r?\n\1\}/gm;
  const matches = [...script.matchAll(expression)];
  if (matches.length !== 1) throw new Error('exact_doctor_repair_branch_required');
  const match = matches[0];
  return {
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
    indent: match[1],
    invokeIndent: match[2],
    exitIndent: match[4],
    target: match[3],
  };
}

function branchFor(releaseEntry, branch) {
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  return `${branch.indent}if ($args.Count -gt 0 -and $args[0] -in @('doctor','repair')) {\n`
    + `${branch.invokeIndent}& "$basedir/node.exe" ${quote(releaseEntry)} @args\n`
    + `${branch.exitIndent}exit $LASTEXITCODE\n${branch.indent}}`;
}

function cmdHealthDispatch() {
  return [
    'IF /I "%~1"=="doctor" GOTO aicc_health',
    'IF /I "%~1"=="repair" GOTO aicc_health',
    'GOTO start',
    ':aicc_health',
    '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0aicc.ps1" %*',
    'EXIT /B %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

function patchCmdShim(content) {
  const marker = /^(@ECHO off\r?\n)GOTO start\r?\n/gim;
  const matches = [...content.matchAll(new RegExp(marker.source, marker.flags))];
  if (matches.length !== 1) return { content, changed: false, recognized: false };
  const match = matches[0];
  const dispatch = cmdHealthDispatch();
  const newline = match[0].includes('\r\n') ? '\r\n' : '\n';
  const normalized = dispatch.replaceAll('\r\n', newline);
  return {
    content: content.slice(0, match.index) + match[1] + normalized + content.slice(match.index + match[0].length),
    changed: true,
    recognized: true,
  };
}

function aliasPowerShell() {
  return "# Reuse AICC's safe native repair; preserve all authentication and history.\r\n"
    + '& "$PSScriptRoot\\aicc.ps1" repair @args\r\nexit $LASTEXITCODE\r\n';
}

function aliasCmd() {
  return '@ECHO off\r\nCALL "%~dp0aicc.cmd" repair %*\r\nEXIT /B %ERRORLEVEL%\r\n';
}

function readSourceBundle(sourceRoot) {
  const healthPath = path.join(sourceRoot, HEALTH_RELATIVE);
  const cliPath = path.join(sourceRoot, CLI_RELATIVE);
  for (const file of [healthPath, cliPath]) assertRegularPath(file);
  const originalHealth = fs.readFileSync(healthPath);
  const originalCli = fs.readFileSync(cliPath);
  const healthText = originalHealth.toString('utf8');
  const lineCount = healthText.split(HEALTH_ROOT_LINE).length - 1;
  if (lineCount !== 1) throw new Error('health_root_anchor_must_appear_once');
  const rootLiteral = `const root = ${JSON.stringify(sourceRoot)};`;
  const snapshotHealth = Buffer.from(healthText.replace(HEALTH_ROOT_LINE, rootLiteral), 'utf8');
  return {
    healthPath,
    cliPath,
    sourceFiles: {
      [HEALTH_RELATIVE]: sha256(originalHealth),
      [CLI_RELATIVE]: sha256(originalCli),
    },
    files: {
      [HEALTH_RELATIVE]: snapshotHealth,
      [CLI_RELATIVE]: originalCli,
    },
  };
}

function runnerSource() {
  return `#!/usr/bin/env node\n`
    + `import crypto from 'node:crypto';\nimport fs from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath, pathToFileURL } from 'node:url';\n`
    + `const releaseRoot=path.dirname(fileURLToPath(import.meta.url));\n`
    + `const manifestPath=path.join(releaseRoot,'manifest.json');\n`
    + `const digest=value=>crypto.createHash('sha256').update(value).digest('hex');\n`
    + `const noLinks=(file,stop)=>{for(let current=path.resolve(file);;current=path.dirname(current)){if(fs.lstatSync(current).isSymbolicLink())throw new Error('health_linked_path');if(current===stop)break;if(path.dirname(current)===current)throw new Error('health_path_escape');}};\n`
    + `const sorted=value=>Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));\n`
    + `const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));\n`
    + `const expected=digest(JSON.stringify({files:sorted(manifest.files),sourceFiles:sorted(manifest.sourceFiles),sourceRoot:manifest.sourceRoot}));\n`
    + `if(manifest.schemaVersion!==1||manifest.releaseHash!==expected||path.basename(releaseRoot)!==expected)throw new Error('health_release_manifest_mismatch');\n`
    + `noLinks(releaseRoot,path.parse(releaseRoot).root);\n`
    + `for(const [relative,hash] of Object.entries(manifest.files)){const file=path.resolve(releaseRoot,relative);if(!file.startsWith(releaseRoot+path.sep))throw new Error('health_release_path_escape');noLinks(file,releaseRoot);if(!fs.lstatSync(file).isFile()||digest(fs.readFileSync(file))!==hash)throw new Error('health_release_file_mismatch');}\n`
    + `for(const [relative,hash] of Object.entries(manifest.sourceFiles)){const file=path.resolve(manifest.sourceRoot,relative);if(!file.startsWith(manifest.sourceRoot+path.sep))throw new Error('health_source_path_escape');noLinks(file,manifest.sourceRoot);if(!fs.lstatSync(file).isFile()||digest(fs.readFileSync(file))!==hash)throw new Error('health_source_drift');}\n`
    + `await import(pathToFileURL(path.join(releaseRoot,'${CLI_RELATIVE}')).href);\n`;
}

function buildRelease(sourceRoot) {
  const bundle = readSourceBundle(sourceRoot);
  const files = { ...bundle.files, [RUNNER_RELATIVE]: Buffer.from(runnerSource(), 'utf8') };
  const fileHashes = Object.fromEntries(Object.entries(files).map(([relative, bytes]) => [relative, sha256(bytes)]));
  const releaseHash = releaseIdentity({ files: fileHashes, sourceFiles: bundle.sourceFiles, sourceRoot });
  const manifest = {
    schemaVersion: 1,
    releaseHash,
    sourceRoot,
    sourceFiles: sortedObject(bundle.sourceFiles),
    files: sortedObject(fileHashes),
  };
  return { releaseHash, files, manifest, fileHashes };
}

function verifyRelease(releaseDir, { sourceRoot, checkSource = true } = {}) {
  assertDirectoryPath(releaseDir);
  const manifestPath = path.join(releaseDir, 'manifest.json');
  assertRegularPath(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || path.basename(releaseDir) !== manifest.releaseHash) throw new Error('health_release_manifest_mismatch');
  if (sourceRoot && path.resolve(sourceRoot) !== path.resolve(manifest.sourceRoot)) throw new Error('health_source_root_changed');
  const expectedHash = releaseIdentity(manifest);
  if (expectedHash !== manifest.releaseHash) throw new Error('health_release_hash_mismatch');
  const expectedPaths = Object.keys(manifest.files).sort();
  const actualPaths = [];
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('linked_release_path_refused');
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const relative = path.relative(releaseDir, full).split(path.sep).join('/');
        if (relative !== 'manifest.json') actualPaths.push(relative);
      } else throw new Error('unsupported_release_entry');
    }
  };
  visit(releaseDir);
  if (JSON.stringify(actualPaths.sort()) !== JSON.stringify(expectedPaths)) throw new Error('health_release_file_set_mismatch');
  for (const relative of expectedPaths) {
    const file = path.join(releaseDir, ...relative.split('/'));
    assertRegularPath(file);
    if (sha256(fs.readFileSync(file)) !== manifest.files[relative]) throw new Error('health_release_file_hash_mismatch');
  }
  const sourceDrift = [];
  if (checkSource) {
    for (const [relative, expected] of Object.entries(manifest.sourceFiles)) {
      const source = path.join(manifest.sourceRoot, ...relative.split('/'));
      try {
        assertRegularPath(source);
        if (sha256(fs.readFileSync(source)) !== expected) sourceDrift.push(relative);
      } catch { sourceDrift.push(relative); }
    }
  }
  return { manifest, sourceDrift, sourceMatches: sourceDrift.length === 0 };
}

function findInstallDir(home, localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData) throw new Error('local_app_data_unavailable');
  const base = path.join(localAppData, 'Programs', 'AICC-Tools');
  assertDirectoryPath(base);
  const candidates = fs.readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('node-'))
    .map(entry => path.join(base, entry.name))
    .filter(dir => fs.existsSync(path.join(dir, 'aicc.ps1')) && fs.existsSync(path.join(dir, 'node.exe')));
  if (candidates.length !== 1) throw new Error('exact_aicc_tools_install_required');
  return candidates[0];
}

function pathsFor(options = {}) {
  const home = path.resolve(options.home ?? os.homedir());
  const sourceRoot = normalizeRoot(options.sourceRoot ?? DEFAULT_SOURCE_ROOT);
  const installDir = path.resolve(options.installDir ?? findInstallDir(home, options.localAppData));
  const managedHome = path.resolve(process.env.AICC_STATE_ROOT || path.join(home,'.ai-control-center'));
  const managedHealth = path.join(managedHome,'runtime/windows-health');
  const migrated = !options.healthHome && fs.existsSync(path.join(managedHealth,'install-state.json'));
  const healthHome = path.resolve(options.healthHome ?? (migrated ? managedHealth : path.join(home, '.codex', 'windows-health')));
  const releaseRoot = migrated ? path.join(managedHome,'releases/windows-health') : path.join(healthHome, 'releases');
  const statePath = path.join(healthHome, 'install-state.json');
  const aiccPs1 = path.join(installDir, 'aicc.ps1');
  const aiccCmd = path.join(installDir, 'aicc.cmd');
  const nodeExe = path.join(installDir, 'node.exe');
  for (const file of [aiccPs1, nodeExe]) assertRegularPath(file);
  return { home, sourceRoot, installDir, healthHome, releaseRoot, statePath, aiccPs1, aiccCmd, nodeExe };
}

function currentState(file) {
  if (!fs.existsSync(file)) return null;
  assertRegularPath(file);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.schemaVersion !== STATE_VERSION) throw new Error('health_install_state_version_mismatch');
  return state;
}

function wrapperPreimages(paths) {
  const result = {};
  for (const file of [paths.aiccPs1, paths.aiccCmd, path.join(paths.installDir, 'codex-repair.ps1'), path.join(paths.installDir, 'codex-repair.cmd')]) {
    if (fs.existsSync(file)) {
      assertRegularPath(file);
      const bytes = fs.readFileSync(file);
      result[path.basename(file)] = { exists: true, sha256: sha256(bytes), bytes };
    } else result[path.basename(file)] = { exists: false, sha256: null, bytes: null };
  }
  return result;
}

function planInstallation(paths) {
  const release = buildRelease(paths.sourceRoot);
  const releaseDir = path.join(paths.releaseRoot, release.releaseHash);
  const preimages = wrapperPreimages(paths);
  const scriptText = preimages['aicc.ps1'].bytes.toString('utf8');
  const branch = parseBranch(scriptText);
  const sourceCli = path.join(paths.sourceRoot, CLI_RELATIVE);
  if (path.resolve(branch.target).toLowerCase() !== path.resolve(sourceCli).toLowerCase()) {
    throw new Error('source_health_branch_target_mismatch');
  }
  const releaseEntry = path.join(releaseDir, RUNNER_RELATIVE);
  const patchedPs1 = scriptText.slice(0, branch.start) + branchFor(releaseEntry, branch) + scriptText.slice(branch.end);
  let patchedCmd = null;
  let cmdStatus = 'missing';
  if (preimages['aicc.cmd'].exists) {
    const result = patchCmdShim(preimages['aicc.cmd'].bytes.toString('utf8'));
    patchedCmd = result.content;
    cmdStatus = result.recognized ? (result.changed ? 'patch' : 'already-patched') : 'unchanged-unrecognized';
  }
  const desiredPs1Alias = aliasPowerShell();
  const desiredCmdAlias = aliasCmd();
  for (const [name, desired] of [['codex-repair.ps1', desiredPs1Alias], ['codex-repair.cmd', desiredCmdAlias]]) {
    if (preimages[name].exists && preimages[name].bytes.toString('utf8').replaceAll('\r\n', '\n') !== desired.replaceAll('\r\n', '\n')) {
      throw new Error(`repair_alias_conflict:${name}`);
    }
  }
  return {
    release,
    releaseDir,
    releaseEntry,
    preimages,
    patchedPs1: Buffer.from(patchedPs1, 'utf8'),
    patchedCmd: patchedCmd === null ? null : Buffer.from(patchedCmd, 'utf8'),
    cmdStatus,
    aliasPowerShell: Buffer.from(desiredPs1Alias, 'utf8'),
    aliasCmd: Buffer.from(desiredCmdAlias, 'utf8'),
  };
}

function planUpgrade(paths, state) {
  const release = buildRelease(paths.sourceRoot);
  if (release.releaseHash === state.releaseHash) throw new Error('health_upgrade_source_unchanged');
  const releaseDir = path.join(paths.releaseRoot, release.releaseHash);
  const preimages = wrapperPreimages(paths);
  const scriptText = preimages['aicc.ps1'].bytes.toString('utf8');
  const branch = parseBranch(scriptText);
  const oldRunner = path.join(paths.releaseRoot, state.releaseHash, RUNNER_RELATIVE);
  if (branch.target !== oldRunner) throw new Error('upgrade_current_route_mismatch');
  const releaseEntry = path.join(releaseDir, RUNNER_RELATIVE);
  const patchedPs1 = scriptText.slice(0, branch.start) + branchFor(releaseEntry, branch) + scriptText.slice(branch.end);
  return {
    release,
    releaseDir,
    releaseEntry,
    preimages,
    patchedPs1: Buffer.from(patchedPs1, 'utf8'),
  };
}

function writeExclusive(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* preserve the write failure */ }
    try { fs.unlinkSync(file); } catch { /* preserve the write failure */ }
    throw error;
  }
  fs.closeSync(fd);
}

function atomicWrite(file, bytes) {
  const temp = `${file}.aicc-health-${process.pid}-${crypto.randomUUID()}.tmp`;
  writeExclusive(temp, bytes);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* preserve original failure */ }
    throw error;
  }
}

function applyAcl(target, mode, options = {}) {
  if (options.setAcl) return options.setAcl(target, mode);
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('owner_system_acl_unavailable');
  const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';
  const whoami = path.join(systemRoot, 'System32', 'whoami.exe');
  const icacls = path.join(systemRoot, 'System32', 'icacls.exe');
  const identity = spawnSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  if (identity.status !== 0) throw new Error('owner_sid_unavailable');
  const ownerSid = identity.stdout.match(/\bS-1-5-21-(?:\d+-){3}\d+\b/)?.[0];
  if (!ownerSid) throw new Error('owner_sid_unavailable');
  const isDirectory = fs.lstatSync(target).isDirectory();
  const inheritance = isDirectory ? '(OI)(CI)' : '';
  const perms = mode === 'immutable' ? 'RX' : 'F';
  const access = `${inheritance}${perms}`;
  const args = [target, '/inheritance:r', '/grant:r', `*${ownerSid}:${access}`, '/grant', `SYSTEM:${access}`];
  const result = spawnSync(icacls, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('owner_system_acl_failed');
}

function applyImmutableTree(root, options) {
  const visit = dir => {
    assertDirectoryPath(dir);
    applyAcl(dir, 'immutable', options);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('linked_release_path_refused');
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        assertRegularPath(full);
        applyAcl(full, 'immutable', options);
      } else throw new Error('unsupported_release_entry');
    }
  };
  visit(root);
}

function ensureDir(dir, options, mode = 'private') {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertDirectoryPath(dir);
  applyAcl(dir, mode, options);
}

function writeRelease(plan, paths, options) {
  ensureDir(paths.healthHome, options, 'private');
  fs.mkdirSync(paths.releaseRoot, { recursive: true, mode: 0o700 });
  assertDirectoryPath(paths.releaseRoot);
  applyAcl(paths.releaseRoot, 'private', options);
  if (fs.existsSync(plan.releaseDir)) {
    const verified = verifyRelease(plan.releaseDir, { sourceRoot: paths.sourceRoot, checkSource: true });
    if (!verified.sourceMatches) throw new Error('health_source_drift');
    return { created: false };
  }
  const stagingDir = path.join(paths.releaseRoot, `.staging-${plan.release.releaseHash}-${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(stagingDir, { recursive: false, mode: 0o700 });
  try {
    for (const [relative, bytes] of Object.entries(plan.release.files)) {
      const file = path.join(stagingDir, ...relative.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeExclusive(file, bytes);
    }
    writeExclusive(path.join(stagingDir, 'manifest.json'), Buffer.from(stableJson(plan.release.manifest), 'utf8'));
    applyImmutableTree(stagingDir, options);
    if (fs.existsSync(plan.releaseDir)) throw new Error('health_release_collision');
    fs.renameSync(stagingDir, plan.releaseDir);
    const verified = verifyRelease(plan.releaseDir, { sourceRoot: paths.sourceRoot, checkSource: true });
    if (!verified.sourceMatches) throw new Error('health_source_drift');
    return { created: true };
  } catch (error) {
    const safeRoot = path.resolve(paths.releaseRoot) + path.sep;
    if (path.resolve(stagingDir).startsWith(safeRoot) && fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function acquireLock(paths) {
  fs.mkdirSync(paths.healthHome, { recursive: true, mode: 0o700 });
  assertDirectoryPath(paths.healthHome);
  const lock = path.join(paths.healthHome, 'install.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeFileSync(fd, stableJson({ pid: process.pid, createdAt: new Date().toISOString() }));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return () => { try { fs.unlinkSync(lock); } catch { /* report completion separately */ } };
}

function savePreimages(paths, preimages, changedNames, options) {
  ensureDir(paths.healthHome, options, 'private');
  const backupDir = path.join(paths.healthHome, 'backups', `${Date.now()}-${crypto.randomUUID()}`);
  ensureDir(path.dirname(backupDir), options, 'private');
  ensureDir(backupDir, options, 'private');
  const backed = {};
  for (const name of changedNames) {
    const preimage = preimages[name];
    const backupPath = path.join(backupDir, `${name}.preimage`);
    if (preimage.exists) {
      writeExclusive(backupPath, preimage.bytes);
      if (sha256(fs.readFileSync(backupPath)) !== preimage.sha256) throw new Error('preimage_backup_mismatch');
      applyAcl(backupPath, 'private', options);
    }
    backed[name] = { exists: preimage.exists, sha256: preimage.sha256, path: preimage.exists ? backupPath : null };
  }
  return { backupDir, backed };
}

function verifyPreimagesUnchanged(paths, preimages) {
  for (const [name, original] of Object.entries(preimages)) {
    const file = path.join(paths.installDir, name);
    const exists = fs.existsSync(file);
    if (exists !== original.exists) throw new Error(`wrapper_changed_before_commit:${name}`);
    if (exists) {
      assertRegularPath(file);
      if (sha256(fs.readFileSync(file)) !== original.sha256) throw new Error(`wrapper_changed_before_commit:${name}`);
    }
  }
}

function desiredWrapperBytes(plan) {
  return {
    'aicc.ps1': plan.patchedPs1,
    ...(plan.patchedCmd && plan.cmdStatus === 'patch' ? { 'aicc.cmd': plan.patchedCmd } : {}),
    ...(plan.preimages['codex-repair.ps1'].exists ? {} : { 'codex-repair.ps1': plan.aliasPowerShell }),
    ...(!plan.preimages['codex-repair.cmd'].exists && plan.cmdStatus === 'patch' ? { 'codex-repair.cmd': plan.aliasCmd } : {}),
  };
}

function validateInstallReceipt(paths, state) {
  const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const allowedNames = new Set(['aicc.ps1', 'aicc.cmd', 'codex-repair.ps1', 'codex-repair.cmd']);
  if (state.installDir !== paths.installDir || state.sourceRoot !== paths.sourceRoot
      || !validHash(state.releaseHash) || state.releaseDir !== path.join(paths.releaseRoot, state.releaseHash)
      || !state.changedFiles || typeof state.changedFiles !== 'object' || Array.isArray(state.changedFiles)
      || !Object.hasOwn(state.changedFiles, 'aicc.ps1')) {
    throw new Error('install_state_path_mismatch');
  }
  for (const [name, record] of Object.entries(state.changedFiles)) {
    if (!allowedNames.has(name) || !record || typeof record !== 'object'
        || !validHash(record.installedSha256) || !record.preimage || typeof record.preimage !== 'object'
        || typeof record.preimage.exists !== 'boolean') {
      throw new Error('install_state_receipt_malformed');
    }
    const preimage = record.preimage;
    if (preimage.exists ? (!validHash(preimage.sha256) || typeof preimage.path !== 'string')
      : (preimage.sha256 !== null || preimage.path !== null)) {
      throw new Error('install_state_preimage_malformed');
    }
  }
}

function preimageDriftFor(paths, state) {
  const drift = [];
  const backupRoot = path.resolve(paths.healthHome, 'backups');
  for (const [name, record] of Object.entries(state.changedFiles)) {
    const preimage = record.preimage;
    if (!preimage.exists) continue;
    try {
      const backupPath = path.resolve(preimage.path);
      const relative = path.relative(backupRoot, backupPath);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        drift.push(name);
        continue;
      }
      assertRegularPath(backupPath);
      if (sha256(fs.readFileSync(backupPath)) !== preimage.sha256) drift.push(name);
    } catch { drift.push(name); }
  }
  return drift;
}

function restoreStateFiles(paths, state, options) {
  validateInstallReceipt(paths, state);
  const changed = Object.entries(state.changedFiles);
  for (const [name, record] of changed) {
    const target = path.join(paths.installDir, name);
    const exists = fs.existsSync(target);
    if (record.installedSha256 === null) {
      if (exists) throw new Error(`rollback_target_drift:${name}`);
    } else {
      if (!exists) throw new Error(`rollback_target_missing:${name}`);
      assertRegularPath(target);
      if (sha256(fs.readFileSync(target)) !== record.installedSha256) throw new Error(`rollback_target_drift:${name}`);
    }
  }
  const backupDrift = preimageDriftFor(paths, state);
  if (backupDrift.length) throw new Error(`rollback_backup_drift:${backupDrift[0]}`);
  for (const [name, record] of changed) {
    const target = path.join(paths.installDir, name);
    if (!record.preimage.exists) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      continue;
    }
    const bytes = fs.readFileSync(record.preimage.path);
    if (sha256(bytes) !== record.preimage.sha256) throw new Error(`rollback_backup_drift:${name}`);
    atomicWrite(target, bytes);
  }
  const statePath = paths.statePath;
  assertRegularPath(statePath);
  fs.unlinkSync(statePath);
  return { terminal: 'PASS', rolledBack: true, restoredFiles: changed.map(([name]) => name), releasePreserved: true };
}

export function windowsHealthInstallStatus(options = {}) {
  const paths = pathsFor(options);
  const state = currentState(paths.statePath);
  const script = fs.readFileSync(paths.aiccPs1, 'utf8');
  const branch = parseBranch(script);
  if (!state) {
    return { terminal: branch.target === path.join(paths.sourceRoot, CLI_RELATIVE) ? 'NOT_INSTALLED' : 'HOLD', installed: false, reason: branch.target === path.join(paths.sourceRoot, CLI_RELATIVE) ? 'source_branch_active' : 'install_state_missing', sourceRoot: paths.sourceRoot, installDir: paths.installDir };
  }
  validateInstallReceipt(paths, state);
  const releaseDir = path.join(paths.releaseRoot, state.releaseHash);
  const release = verifyRelease(releaseDir, { sourceRoot: paths.sourceRoot, checkSource: true });
  const expectedEntry = path.join(releaseDir, RUNNER_RELATIVE);
  if (branch.target !== expectedEntry) throw new Error('installed_branch_target_mismatch');
  const wrapperDrift = [];
  for (const [name, record] of Object.entries(state.changedFiles)) {
    const target = path.join(paths.installDir, name);
    const exists = fs.existsSync(target);
    if (record.installedSha256 === null ? exists : !exists) wrapperDrift.push(name);
    else if (exists) {
      try { assertRegularPath(target); if (sha256(fs.readFileSync(target)) !== record.installedSha256) wrapperDrift.push(name); }
      catch { wrapperDrift.push(name); }
    }
  }
  const preimageDrift = preimageDriftFor(paths, state);
  return {
    terminal: release.sourceMatches && wrapperDrift.length === 0 && preimageDrift.length === 0 ? 'PASS' : 'HOLD',
    installed: true,
    releaseHash: state.releaseHash,
    releaseDir,
    sourceMatches: release.sourceMatches,
    sourceDrift: release.sourceDrift,
    releaseFilesVerified: true,
    wrapperDrift,
    preimageDrift,
    aliases: { powershell: fs.existsSync(path.join(paths.installDir, 'codex-repair.ps1')), cmd: fs.existsSync(path.join(paths.installDir, 'codex-repair.cmd')) },
    commandShim: fs.existsSync(paths.aiccCmd) ? 'present' : 'missing',
  };
}

function assertUpgradeEligible(status) {
  if (status.sourceMatches !== false || !status.releaseFilesVerified || status.wrapperDrift.length
      || status.preimageDrift.length || !status.sourceDrift.length) {
    throw new Error('existing_health_install_not_upgradeable');
  }
}

function upgradeSummary(plan, status) {
  return {
    terminal: 'READY',
    installed: true,
    changed: true,
    upgrade: true,
    previousReleaseHash: status.releaseHash,
    releaseHash: plan.release.releaseHash,
    releaseDir: plan.releaseDir,
    sourceFiles: plan.release.manifest.sourceFiles,
    snapshotFiles: plan.release.manifest.files,
    wrapperChanges: ['aicc.ps1'],
    rollbackPreimagesPreserved: true,
  };
}

function commitInstalledUpgrade(paths, options, expectedReleaseHash) {
  ensureDir(paths.healthHome, options, 'private');
  const unlock = acquireLock(paths);
  try {
    const prior = currentState(paths.statePath);
    if (!prior) throw new Error('health_install_not_found');
    const status = windowsHealthInstallStatus(options);
    if (status.terminal === 'PASS') return { terminal: 'PASS', installed: true, changed: false, status };
    assertUpgradeEligible(status);
    if (prior.releaseHash !== expectedReleaseHash) throw new Error('health_install_changed_before_upgrade');

    const plan = planUpgrade(paths, prior);
    const oldWrapperBytes = fs.readFileSync(paths.aiccPs1);
    const oldStateBytes = fs.readFileSync(paths.statePath);
    const oldPreimages = plan.preimages;
    let wrapperWritten = false;
    let stateWritten = false;
    try {
      const release = writeRelease(plan, paths, options);
      verifyPreimagesUnchanged(paths, oldPreimages);
      const currentStatus = windowsHealthInstallStatus(options);
      assertUpgradeEligible(currentStatus);
      if (currentStatus.releaseHash !== prior.releaseHash) throw new Error('health_install_changed_before_upgrade');

      atomicWrite(paths.aiccPs1, plan.patchedPs1);
      wrapperWritten = true;
      const nextState = {
        ...prior,
        upgradedAt: new Date().toISOString(),
        releaseHash: plan.release.releaseHash,
        releaseDir: plan.releaseDir,
        changedFiles: {
          ...prior.changedFiles,
          'aicc.ps1': {
            ...prior.changedFiles['aicc.ps1'],
            installedSha256: sha256(plan.patchedPs1),
          },
        },
      };
      atomicWrite(paths.statePath, Buffer.from(stableJson(nextState), 'utf8'));
      stateWritten = true;
      applyAcl(paths.statePath, 'private', options);
      const installedStatus = windowsHealthInstallStatus(options);
      if (installedStatus.terminal !== 'PASS') throw new Error('upgraded_status_not_pass');
      return {
        terminal: 'PASS',
        installed: true,
        changed: true,
        upgrade: true,
        releaseCreated: release.created,
        rollbackPreimagesPreserved: true,
        status: installedStatus,
      };
    } catch (error) {
      try {
        if (wrapperWritten) atomicWrite(paths.aiccPs1, oldWrapperBytes);
        if (stateWritten) {
          atomicWrite(paths.statePath, oldStateBytes);
          applyAcl(paths.statePath, 'private', options);
        }
      } catch (rollbackError) {
        throw new Error(`upgrade_failed_rollback_incomplete:${error.message}:${rollbackError.message}`);
      }
      throw error;
    }
  } finally {
    unlock();
  }
}

export function installWindowsHealth(options = {}) {
  const paths = pathsFor(options);
  const prior = currentState(paths.statePath);
  if (prior) {
    const status = windowsHealthInstallStatus(options);
    if (status.terminal === 'PASS') return { terminal: 'PASS', installed: true, changed: false, status };
    assertUpgradeEligible(status);
    const plan = planUpgrade(paths, prior);
    const summary = upgradeSummary(plan, status);
    if (options.dryRun === true) return summary;
    if (options.commit !== true) throw new Error('explicit_commit_required');
    if ((options.platform ?? process.platform) !== 'win32') throw new Error('windows_health_install_only');
    return commitInstalledUpgrade(paths, options, prior.releaseHash);
  }
  const plan = planInstallation(paths);
  const writePlan = desiredWrapperBytes(plan);
  const changedNames = Object.keys(writePlan);
  const summary = {
    terminal: 'READY',
    installed: false,
    changed: false,
    sourceRoot: paths.sourceRoot,
    releaseHash: plan.release.releaseHash,
    releaseDir: plan.releaseDir,
    sourceFiles: plan.release.manifest.sourceFiles,
    snapshotFiles: plan.release.manifest.files,
    wrapperChanges: changedNames,
    commandShim: plan.cmdStatus,
    aliases: changedNames.filter(name => name.startsWith('codex-repair.')),
  };
  if (options.dryRun === true) return summary;
  if (options.commit !== true) throw new Error('explicit_commit_required');
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('windows_health_install_only');
  ensureDir(paths.healthHome, options, 'private');
  const unlock = acquireLock(paths);
  let backup = null;
  let stateWritten = false;
  const installed = [];
  try {
    const release = writeRelease(plan, paths, options);
    verifyPreimagesUnchanged(paths, plan.preimages);
    backup = savePreimages(paths, plan.preimages, changedNames, options);
    const installedHashes = {};
    for (const [name, bytes] of Object.entries(writePlan)) {
      const target = path.join(paths.installDir, name);
      if (plan.preimages[name].exists) atomicWrite(target, bytes);
      else writeExclusive(target, bytes);
      installed.push(name);
      installedHashes[name] = sha256(bytes);
      if (name.startsWith('codex-repair.')) applyAcl(target, 'private', options);
    }
    const postScript = fs.readFileSync(paths.aiccPs1, 'utf8');
    const postBranch = parseBranch(postScript);
    if (postBranch.target !== plan.releaseEntry) throw new Error('installed_branch_readback_failed');
    for (const [name, bytes] of Object.entries(writePlan)) {
      if (sha256(fs.readFileSync(path.join(paths.installDir, name))) !== installedHashes[name]) throw new Error(`installed_wrapper_hash_failed:${name}`);
    }
    const state = {
      schemaVersion: STATE_VERSION,
      installedAt: new Date().toISOString(),
      sourceRoot: paths.sourceRoot,
      installDir: paths.installDir,
      releaseHash: plan.release.releaseHash,
      releaseDir: plan.releaseDir,
      changedFiles: Object.fromEntries(changedNames.map(name => [name, {
        installedSha256: installedHashes[name] ?? null,
        preimage: backup.backed[name],
      }])),
    };
    atomicWrite(paths.statePath, Buffer.from(stableJson(state), 'utf8'));
    stateWritten = true;
    applyAcl(paths.statePath, 'private', options);
    const status = windowsHealthInstallStatus(options);
    if (status.terminal !== 'PASS') throw new Error('installed_status_not_pass');
    return { terminal: 'PASS', installed: true, changed: true, releaseCreated: release.created, status };
  } catch (error) {
    try {
      if (stateWritten && fs.existsSync(paths.statePath)) fs.unlinkSync(paths.statePath);
      for (const name of installed.reverse()) {
        const target = path.join(paths.installDir, name);
        const original = plan.preimages[name];
        if (!original.exists) {
          if (fs.existsSync(target)) fs.unlinkSync(target);
        } else {
          if (!backup?.backed[name]?.path) throw new Error(`rollback_preimage_missing:${name}`);
          const originalBytes = fs.readFileSync(backup.backed[name].path);
          if (sha256(originalBytes) !== original.sha256) throw new Error(`rollback_preimage_drift:${name}`);
          atomicWrite(target, originalBytes);
        }
      }
    } catch (rollbackError) {
      throw new Error(`install_failed_rollback_incomplete:${error.message}:${rollbackError.message}`);
    }
    throw error;
  } finally {
    unlock();
  }
}

export function rollbackWindowsHealth(options = {}) {
  const paths = pathsFor(options);
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('windows_health_install_only');
  const state = currentState(paths.statePath);
  if (!state) throw new Error('health_install_not_found');
  const unlock = acquireLock(paths);
  try { return restoreStateFiles(paths, state, options); } finally { unlock(); }
}

function parseArgs(args) {
  const [action, ...rest] = args;
  const flags = new Set(rest);
  if (!['status', 'install', 'rollback'].includes(action)) throw new Error('Usage: install-windows-health.mjs status | install --dry-run | install --commit | rollback');
  if (rest.some(flag => !['--dry-run', '--commit'].includes(flag))) throw new Error('unknown_argument');
  if (flags.has('--dry-run') && flags.has('--commit')) throw new Error('dry_run_commit_conflict');
  if (action === 'install' && Number(flags.has('--dry-run')) + Number(flags.has('--commit')) !== 1) throw new Error('explicit_install_mode_required');
  if (action !== 'install' && rest.length) throw new Error('flags_not_valid_for_action');
  return { action, dryRun: flags.has('--dry-run'), commit: flags.has('--commit') };
}

async function main() {
  const { action, ...mode } = parseArgs(process.argv.slice(2));
  const result = action === 'status' ? windowsHealthInstallStatus() : action === 'install' ? installWindowsHealth(mode) : rollbackWindowsHealth();
  console.log(JSON.stringify(result, null, 2));
  if (result.terminal === 'HOLD') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`${PREFIX}: ${error.message}`); process.exitCode = 1; });
}
