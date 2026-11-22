import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/i;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function samePath(left, right) {
  const normalize = value => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function regularFile(file, maximumBytes = 1_048_576) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) throw new Error('unsafe_regular_file');
  const bytes = fs.readFileSync(file);
  return { bytes, hash: sha256(bytes), size: bytes.length };
}

function linkTarget(link) {
  const stat = fs.lstatSync(link);
  if (!stat.isSymbolicLink()) throw new Error('installed_entry_not_link');
  const target = fs.readlinkSync(link);
  return path.resolve(path.dirname(link), target);
}

function writeOwnerJson(file, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return sha256(bytes);
}

function junctionType() {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

export function inventoryInstalledCliCandidate(candidatePath, options = {}) {
  const root = path.resolve(candidatePath);
  const manifestName = options.manifestName ?? '.aicc-release.json';
  const maximumFileBytes = options.maximumFileBytes ?? 32 * 1024 * 1024;
  const files = [];
  let totalBytes = 0;
  function visit(directory, relativeRoot = '') {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('candidate_tree_unsafe');
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      if (relative === manifestName) continue;
      const file = path.join(directory, entry.name);
      const item = fs.lstatSync(file);
      if (item.isSymbolicLink()) throw new Error('candidate_tree_symlink');
      if (item.isDirectory()) {
        visit(file, relative);
        continue;
      }
      if (!item.isFile() || item.size > maximumFileBytes) throw new Error('candidate_tree_file_unsafe');
      const bytes = fs.readFileSync(file);
      totalBytes += bytes.length;
      files.push({ path: relative, sha256: sha256(bytes), size: bytes.length });
    }
  }
  visit(root);
  return { files, totalBytes };
}

export function sealInstalledCliCandidate(candidatePath, options = {}) {
  const root = path.resolve(candidatePath);
  const manifestName = options.manifestName ?? '.aicc-release.json';
  const manifestFile = path.join(root, manifestName);
  const sourceRevision = String(options.sourceRevision ?? '').toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(sourceRevision)) throw new Error('candidate_source_revision_invalid');
  if (fs.existsSync(manifestFile)) throw new Error('candidate_manifest_exists');
  const inventory = inventoryInstalledCliCandidate(root, options);
  const manifest = {
    schemaVersion: 1,
    component: 'installed-cli-route',
    sourceRevision,
    fileCount: inventory.files.length,
    totalBytes: inventory.totalBytes,
    files: inventory.files
  };
  const manifestHash = writeOwnerJson(manifestFile, manifest);
  return { manifestFile, manifestHash, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes };
}

export function verifyInstalledCliCandidate(candidatePath, options = {}) {
  const root = path.resolve(candidatePath);
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return { ok: false, reason: 'candidate_root_unsafe', manifestHash: null, fileCount: 0 };
    }
  } catch {
    return { ok: false, reason: 'candidate_root_unreadable', manifestHash: null, fileCount: 0 };
  }
  const manifestFile = path.join(root, options.manifestName ?? '.aicc-release.json');
  let manifestBytes;
  let manifest;
  try {
    const read = regularFile(manifestFile, options.maximumManifestBytes ?? 8 * 1024 * 1024);
    manifestBytes = read.bytes;
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'candidate_manifest_unreadable', manifestHash: null, fileCount: 0 };
  }
  if (manifest?.schemaVersion !== 1 || manifest?.component !== 'installed-cli-route' || !Array.isArray(manifest?.files)) {
    return { ok: false, reason: 'candidate_manifest_invalid', manifestHash: sha256(manifestBytes), fileCount: 0 };
  }
  const required = new Set(options.requiredFiles ?? ['bin/aicc', 'src/cli.mjs', 'src/recovery/restore-v2-command.mjs']);
  const seen = new Set();
  let actualInventory;
  try { actualInventory = inventoryInstalledCliCandidate(root, options); }
  catch (error) { return { ok: false, reason: error?.message ?? 'candidate_inventory_unreadable', manifestHash: sha256(manifestBytes), fileCount: 0 }; }
  const actualByPath = new Map(actualInventory.files.map(file => [file.path, file]));
  if (manifest.fileCount !== manifest.files.length || manifest.totalBytes !== actualInventory.totalBytes
    || manifest.files.length !== actualInventory.files.length) {
    return { ok: false, reason: 'candidate_inventory_mismatch', manifestHash: sha256(manifestBytes), fileCount: actualInventory.files.length };
  }
  for (const item of manifest.files) {
    const relative = typeof item?.path === 'string' ? item.path.replaceAll('\\', '/') : '';
    if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..') || !SHA256.test(item?.sha256 ?? '') || seen.has(relative)) {
      return { ok: false, reason: 'candidate_manifest_invalid', manifestHash: sha256(manifestBytes), fileCount: seen.size };
    }
    const file = path.resolve(root, relative);
    if (!inside(root, file)) return { ok: false, reason: 'candidate_path_escape', manifestHash: sha256(manifestBytes), fileCount: seen.size };
    const actual = actualByPath.get(relative);
    if (!actual || actual.sha256 !== item.sha256.toLowerCase() || actual.size !== item.size) {
      return { ok: false, reason: 'candidate_hash_mismatch', manifestHash: sha256(manifestBytes), fileCount: seen.size };
    }
    seen.add(relative);
  }
  if ([...required].some(file => !seen.has(file))) {
    return { ok: false, reason: 'candidate_required_file_missing', manifestHash: sha256(manifestBytes), fileCount: seen.size };
  }
  return { ok: true, reason: 'candidate_verified', manifestHash: sha256(manifestBytes), fileCount: seen.size };
}

function readBackupManifest(backupTarget) {
  const file = path.join(backupTarget, 'manifest.json');
  const read = regularFile(file, 256_000);
  const value = JSON.parse(read.bytes.toString('utf8'));
  if (value?.schemaVersion !== 1 || value?.component !== 'installed-cli-route' || !SHA256.test(value?.sourceGeneration ?? '')) {
    throw new Error('backup_manifest_invalid');
  }
  return { file, value, hash: read.hash };
}

export function createInstalledCliRouteAdapter(options = {}) {
  for (const [label, value] of Object.entries({ entryPath: options.entryPath, candidatePath: options.candidatePath, backupRoot: options.backupRoot })) {
    if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error(`${label}_invalid`);
  }
  if (!Array.isArray(options.wrapperPaths) || options.wrapperPaths.length < 1
    || options.wrapperPaths.some(file => typeof file !== 'string' || !path.isAbsolute(file))) {
    throw new Error('wrapper_paths_invalid');
  }
  const entryPath = path.resolve(options.entryPath ?? '');
  const candidatePath = path.resolve(options.candidatePath ?? '');
  const backupRoot = path.resolve(options.backupRoot ?? '');
  const wrapperPaths = (options.wrapperPaths ?? []).map(file => path.resolve(file));
  const legacyPointerPath = options.legacyPointerPath ? path.resolve(options.legacyPointerPath) : null;
  if (typeof options.recoveryScriptPath !== 'string' || !path.isAbsolute(options.recoveryScriptPath)) {
    throw new Error('recovery_script_path_invalid');
  }
  const recoveryScriptPath = path.resolve(options.recoveryScriptPath);

  function inspect() {
    let currentTarget;
    let wrappers;
    let pointerHash = null;
    try {
      currentTarget = linkTarget(entryPath);
      wrappers = wrapperPaths.map(file => regularFile(file).hash);
      if (legacyPointerPath && fs.existsSync(legacyPointerPath)) pointerHash = regularFile(legacyPointerPath).hash;
    } catch (error) {
      return {
        available: false,
        current: false,
        fingerprintVerified: false,
        fingerprintHash: null,
        reason: error?.message ?? 'installed_entry_unreadable'
      };
    }
    const candidate = verifyInstalledCliCandidate(candidatePath, options);
    const fingerprintHash = sha256(JSON.stringify({
      entryTarget: currentTarget,
      wrappers,
      pointerHash,
      candidateManifestHash: candidate.manifestHash
    }));
    return {
      available: true,
      current: samePath(currentTarget, candidatePath),
      fingerprintVerified: candidate.ok,
      fingerprintHash,
      reason: candidate.reason,
      wrapperCount: wrappers.length,
      pointerPresent: pointerHash !== null,
      candidateFileCount: candidate.fileCount
    };
  }

  function validateScope(scope = {}) {
    const operationId = String(scope.operationId ?? '');
    const attemptId = String(scope.attemptId ?? '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(attemptId)) {
      throw new Error('recovery_scope_identity_invalid');
    }
    const backupTarget = scope.backupTarget
      ? path.resolve(scope.backupTarget)
      : path.join(backupRoot, `${operationId}-${attemptId}`);
    const rollbackTarget = scope.rollbackTarget ? path.resolve(scope.rollbackTarget) : entryPath;
    const expectedGeneration = scope.expectedGeneration ?? scope.inspection?.fingerprintHash ?? null;
    if (!samePath(rollbackTarget, entryPath)) throw new Error('rollback_target_mismatch');
    if (!inside(backupRoot, backupTarget) || samePath(backupRoot, backupTarget)
      || !samePath(path.dirname(backupTarget), backupRoot)) {
      throw new Error('backup_target_outside_root');
    }
    return { ...scope, operationId, attemptId, backupTarget, rollbackTarget, expectedGeneration };
  }

  return Object.freeze({
    async inspect() { return inspect(); },

    async backup(scope) {
      const resolved = validateScope(scope);
      const { backupTarget, expectedGeneration } = resolved;
      const current = inspect();
      if (!SHA256.test(expectedGeneration ?? '') || !current.fingerprintVerified || current.fingerprintHash !== expectedGeneration) {
        throw new Error('backup_generation_mismatch');
      }
      if (fs.existsSync(backupTarget)) throw new Error('backup_target_exists');
      fs.mkdirSync(backupTarget, { mode: 0o700 });
      if (process.platform !== 'win32') fs.chmodSync(backupTarget, 0o700);
      const wrapperDirectory = path.join(backupTarget, 'wrappers');
      fs.mkdirSync(wrapperDirectory, { mode: 0o700 });
      const wrapperFiles = wrapperPaths.map((source, index) => {
        const destination = path.join(wrapperDirectory, `${String(index).padStart(2, '0')}-${path.basename(source)}`);
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        if (process.platform !== 'win32') fs.chmodSync(destination, 0o600);
        return { index, sha256: regularFile(destination).hash };
      });
      let pointer = null;
      if (legacyPointerPath && fs.existsSync(legacyPointerPath)) {
        const destination = path.join(backupTarget, 'legacy-pointer.json');
        fs.copyFileSync(legacyPointerPath, destination, fs.constants.COPYFILE_EXCL);
        if (process.platform !== 'win32') fs.chmodSync(destination, 0o600);
        pointer = { sha256: regularFile(destination).hash };
      }
      const sourceTarget = linkTarget(entryPath);
      const routeCopy = path.join(backupTarget, 'route-link');
      fs.symlinkSync(sourceTarget, routeCopy, junctionType());
      const recoveryScript = path.join(backupTarget, 'restore-installed-cli-route.ps1');
      fs.copyFileSync(recoveryScriptPath, recoveryScript, fs.constants.COPYFILE_EXCL);
      if (process.platform !== 'win32') fs.chmodSync(recoveryScript, 0o600);
      const recoveryScriptHash = regularFile(recoveryScript).hash;
      const manifest = {
        schemaVersion: 1,
        component: 'installed-cli-route',
        operationId: resolved.operationId,
        attemptId: resolved.attemptId,
        sourceGeneration: expectedGeneration,
        entryPath,
        sourceTarget,
        candidatePath,
        wrapperFiles,
        pointer,
        recoveryScript: { sha256: recoveryScriptHash }
      };
      const backupRefHash = writeOwnerJson(path.join(backupTarget, 'manifest.json'), manifest);
      const reread = readBackupManifest(backupTarget);
      return {
        verified: reread.hash === backupRefHash
          && samePath(linkTarget(routeCopy), sourceTarget)
          && regularFile(recoveryScript).hash === recoveryScriptHash,
        backupRefHash,
        recoveryScriptHash
      };
    },

    async apply(scope) {
      const resolved = validateScope(scope);
      const { backupTarget, expectedGeneration } = resolved;
      if (!SHA256.test(expectedGeneration ?? '')) throw new Error('dispatch_generation_missing');
      const backup = readBackupManifest(backupTarget);
      if (backup.value.sourceGeneration !== expectedGeneration) throw new Error('backup_generation_mismatch');
      const current = inspect();
      if (current.fingerprintHash !== expectedGeneration) throw new Error('dispatch_generation_mismatch');
      const temporary = `${entryPath}.${process.pid}-${crypto.randomUUID()}.candidate`;
      const displaced = path.join(backupTarget, 'displaced-live-link');
      fs.symlinkSync(candidatePath, temporary, junctionType());
      try {
        fs.renameSync(entryPath, displaced);
        try { fs.renameSync(temporary, entryPath); }
        catch (error) {
          fs.renameSync(displaced, entryPath);
          throw error;
        }
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
      return {
        acknowledged: samePath(linkTarget(entryPath), candidatePath),
        dispatchIdentityHash: sha256(`${resolved.operationId}:${resolved.attemptId}:${candidatePath}:${backup.hash}`)
      };
    },

    async verify() {
      const current = inspect();
      return { ok: current.current === true && current.fingerprintVerified === true, generationCurrent: current.current === true };
    },

    async reconcile(scope) {
      const { backupTarget } = validateScope(scope);
      const backup = readBackupManifest(backupTarget);
      let target;
      try { target = linkTarget(entryPath); }
      catch { return { authoritative: false, effectCount: null }; }
      if (samePath(target, candidatePath)) return { authoritative: true, effectCount: 1 };
      if (samePath(target, backup.value.sourceTarget)) return { authoritative: true, effectCount: 0 };
      return { authoritative: false, effectCount: null };
    },

    async rollback(scope) {
      const resolved = validateScope(scope);
      const { backupTarget } = resolved;
      const backup = readBackupManifest(backupTarget);
      const temporary = `${entryPath}.${process.pid}-${crypto.randomUUID()}.rollback`;
      const displaced = path.join(backupTarget, `rollback-displaced-${resolved.operationId}-${resolved.attemptId}`);
      fs.symlinkSync(backup.value.sourceTarget, temporary, junctionType());
      try {
        fs.renameSync(entryPath, displaced);
        try { fs.renameSync(temporary, entryPath); }
        catch (error) {
          fs.renameSync(displaced, entryPath);
          throw error;
        }
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
      return { acknowledged: samePath(linkTarget(entryPath), backup.value.sourceTarget) };
    },

    async verifyRollback(scope) {
      const { backupTarget } = validateScope(scope);
      const backup = readBackupManifest(backupTarget);
      let target;
      try { target = linkTarget(entryPath); }
      catch { return { ok: false }; }
      return { ok: samePath(target, backup.value.sourceTarget) };
    }
  });
}
