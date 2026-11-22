import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultDesignSourceManifest = path.join(root, 'guidance', 'design-sources.json');
const revisionPattern = /^[0-9a-f]{40}$/;
const idPattern = /^[a-z0-9][a-z0-9-]{1,80}$/;

function privateRoot(options = {}) {
  return options.stateRoot
    ?? process.env.AICC_STATE_ROOT?.trim()
    ?? path.join(os.homedir(), '.ai-control-center');
}

export function designSourcePaths(options = {}) {
  const stateRoot = privateRoot(options);
  const storeRoot = path.join(stateRoot, 'design-sources');
  return {
    stateRoot,
    storeRoot,
    repositoriesRoot: path.join(storeRoot, 'repositories'),
    snapshotsRoot: path.join(storeRoot, 'snapshots'),
    activeRoot: path.join(storeRoot, 'active'),
    observationsPath: path.join(storeRoot, 'observations.json'),
    eventsPath: path.join(storeRoot, 'events.jsonl')
  };
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* best effort on Windows */ }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function atomicJson(file, value) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

export function loadDesignSourceManifest(file = defaultDesignSourceManifest) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.sources)) throw new Error('Unsupported design source manifest');
  const ids = new Set();
  for (const source of manifest.sources) {
    if (!idPattern.test(source.id) || ids.has(source.id)) throw new Error(`Invalid design source id: ${source.id}`);
    if (!/^[^/]+\/[^/]+$/.test(source.repository)) throw new Error(`Invalid repository: ${source.id}`);
    if (!revisionPattern.test(source.baselineRevision)) throw new Error(`Invalid baseline revision: ${source.id}`);
    ids.add(source.id);
  }
  return manifest;
}

function git(args, options = {}) {
  const result = spawnSync(options.gitExecutable ?? 'git', args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    env: options.env ?? process.env
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || `exit ${result.status}`).trim().slice(0, 2_000);
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
  return String(result.stdout || '').trim();
}

function gitAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.gitExecutable ?? 'git', args, {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const limit = options.maxBuffer ?? 16 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let overflow = false;
    const collect = (chunk, key) => {
      if (overflow) return;
      if (stdout.length + stderr.length + chunk.length > limit) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      if (key === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => collect(chunk, 'stdout'));
    child.stderr.on('data', chunk => collect(chunk, 'stderr'));
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 120_000);
    timeout.unref();
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (overflow) return reject(new Error(`git ${args[0]} exceeded output limit`));
      if (code !== 0) return reject(new Error(`git ${args[0]} failed: ${(stderr || signal || `exit ${code}`).trim().slice(0, 2_000)}`));
      resolve(stdout.trim());
    });
  });
}

function activeRevision(paths, id) {
  const link = path.join(paths.activeRoot, id);
  try {
    const target = fs.realpathSync(link);
    const revision = path.basename(target);
    return revisionPattern.test(revision) ? revision : null;
  } catch { return null; }
}

function snapshotIntegrity(paths, id, revision, options = {}) {
  if (!revision) return 'missing';
  const snapshot = path.join(paths.snapshotsRoot, id, revision);
  if (!fs.existsSync(snapshot)) return 'missing';
  try {
    const head = git(['-C', snapshot, 'rev-parse', 'HEAD'], options);
    const dirty = git(['-C', snapshot, 'status', '--porcelain', '--untracked-files=all'], options);
    return head === revision && !dirty ? 'verified' : 'modified';
  } catch { return 'unknown'; }
}

function observationMap(paths) {
  const data = readJson(paths.observationsPath, { sources: [] });
  return new Map((data.sources ?? []).map(item => [item.id, item]));
}

export function designSourcesStatus(options = {}) {
  const manifest = loadDesignSourceManifest(options.manifestPath);
  const paths = designSourcePaths(options);
  const observations = observationMap(paths);
  const sources = manifest.sources.map(source => {
    const observed = observations.get(source.id) ?? {};
    const active = activeRevision(paths, source.id);
    const remote = revisionPattern.test(observed.remoteRevision ?? '') ? observed.remoteRevision : null;
    const integrity = snapshotIntegrity(paths, source.id, active, options);
    let status = 'not_checked';
    if (observed.status === 'unknown') status = 'unknown';
    else if (remote && !active) status = 'not_installed';
    else if (remote && active === remote) status = integrity === 'verified' ? 'current' : 'modified';
    else if (remote && active !== remote) status = 'update_available';
    return {
      ...source,
      activeRevision: active,
      remoteRevision: remote,
      observedAt: observed.observedAt ?? null,
      status,
      integrity,
      snapshotPath: active ? path.join(paths.snapshotsRoot, source.id, active) : null,
      activePath: active ? path.join(paths.activeRoot, source.id) : null
    };
  });
  const counts = Object.fromEntries(['current', 'update_available', 'not_installed', 'modified', 'unknown', 'not_checked'].map(status => [status, sources.filter(source => source.status === status).length]));
  return {
    ok: true,
    schemaVersion: 1,
    checkedAt: sources.map(source => source.observedAt).filter(Boolean).sort().at(-1) ?? null,
    automaticApply: false,
    monitorIntervalHours: manifest.policy.monitorIntervalHours,
    estimatedTotalKiB: sources.reduce((sum, source) => sum + Number(source.estimatedKiB || 0), 0),
    counts,
    sources
  };
}

export function scanDesignSources(options = {}) {
  const manifest = loadDesignSourceManifest(options.manifestPath);
  const paths = designSourcePaths(options);
  const observedAt = new Date(options.now?.() ?? Date.now()).toISOString();
  const sources = manifest.sources.map(source => {
    try {
      const output = git(['ls-remote', '--exit-code', `${source.url}.git`, 'HEAD'], { ...options, timeoutMs: options.scanTimeoutMs ?? 30_000 });
      const revision = output.split(/\s+/)[0] ?? '';
      if (!revisionPattern.test(revision)) throw new Error('remote returned no commit');
      return { id: source.id, status: revision === source.baselineRevision ? 'current' : 'update_available', remoteRevision: revision, observedAt };
    } catch (error) {
      return { id: source.id, status: 'unknown', reason: String(error.message).slice(0, 300), observedAt };
    }
  });
  const report = { schemaVersion: 1, checkedAt: observedAt, automaticApply: false, sources };
  atomicJson(paths.observationsPath, report);
  return designSourcesStatus(options);
}

export async function scanDesignSourcesAsync(options = {}) {
  const manifest = loadDesignSourceManifest(options.manifestPath);
  const paths = designSourcePaths(options);
  const observedAt = new Date(options.now?.() ?? Date.now()).toISOString();
  const sources = await Promise.all(manifest.sources.map(async source => {
    try {
      const output = await gitAsync(['ls-remote', '--exit-code', `${source.url}.git`, 'HEAD'], { ...options, timeoutMs: options.scanTimeoutMs ?? 30_000 });
      const revision = output.split(/\s+/)[0] ?? '';
      if (!revisionPattern.test(revision)) throw new Error('remote returned no commit');
      return { id: source.id, status: revision === source.baselineRevision ? 'current' : 'update_available', remoteRevision: revision, observedAt };
    } catch (error) {
      return { id: source.id, status: 'unknown', reason: String(error.message).slice(0, 300), observedAt };
    }
  }));
  const report = { schemaVersion: 1, checkedAt: observedAt, automaticApply: false, sources };
  atomicJson(paths.observationsPath, report);
  return designSourcesStatus(options);
}

function sourceById(manifest) {
  return new Map(manifest.sources.map(source => [source.id, source]));
}

export function normalizeDesignSourceSelection(args, state) {
  const requested = args?.all === true
    ? state.sources.map(source => source.id)
    : Array.isArray(args?.ids) ? args.ids.map(String) : [];
  const ids = [...new Set(requested)].sort();
  if (!ids.length) throw new Error('하나 이상의 디자인 소스를 선택해야 합니다.');
  const status = new Map(state.sources.map(source => [source.id, source]));
  const targets = {};
  for (const id of ids) {
    if (!idPattern.test(id) || !status.has(id)) throw new Error(`알 수 없는 디자인 소스: ${id}`);
    const source = status.get(id);
    if (!revisionPattern.test(source.remoteRevision ?? '')) throw new Error(`${source.label}의 최신 커밋을 먼저 확인해야 합니다.`);
    if (source.integrity === 'modified') throw new Error(`${source.label}의 활성 스냅샷이 수정되었습니다. 별도 보존 후 다시 시도하세요.`);
    targets[id] = source.remoteRevision;
  }
  return { ids, targets };
}

function ensureRepository(source, paths, options) {
  ensurePrivateDirectory(paths.repositoriesRoot);
  const repositoryPath = path.join(paths.repositoriesRoot, `${source.id}.git`);
  if (!fs.existsSync(repositoryPath)) {
    git(['clone', '--bare', '--filter=blob:none', `${source.url}.git`, repositoryPath], { ...options, timeoutMs: options.cloneTimeoutMs ?? 30 * 60_000 });
  }
  return repositoryPath;
}

function ensureSnapshot(source, revision, paths, options) {
  const repositoryPath = ensureRepository(source, paths, options);
  const snapshot = path.join(paths.snapshotsRoot, source.id, revision);
  if (fs.existsSync(snapshot)) {
    if (snapshotIntegrity(paths, source.id, revision, options) !== 'verified') throw new Error(`${source.id} snapshot integrity failed`);
    return snapshot;
  }
  ensurePrivateDirectory(path.dirname(snapshot));
  git(['--git-dir', repositoryPath, 'fetch', '--filter=blob:none', '--no-tags', 'origin', revision], { ...options, timeoutMs: options.cloneTimeoutMs ?? 30 * 60_000 });
  git(['--git-dir', repositoryPath, 'worktree', 'add', '--detach', snapshot, revision], { ...options, timeoutMs: options.cloneTimeoutMs ?? 30 * 60_000 });
  if (snapshotIntegrity(paths, source.id, revision, options) !== 'verified') throw new Error(`${source.id} snapshot verification failed`);
  return snapshot;
}

function atomicSymlink(target, link) {
  ensurePrivateDirectory(path.dirname(link));
  const temporary = `${link}.${process.pid}.${Date.now()}.tmp`;
  try { fs.unlinkSync(temporary); } catch { /* no-op */ }
  fs.symlinkSync(target, temporary);
  if (process.platform !== 'win32' || !fs.existsSync(link)) {
    fs.renameSync(temporary, link);
    return;
  }
  // NTFS does not replace an existing directory junction/symlink with
  // renameSync. Move only the owned link aside, install the new one, and
  // restore the old link if the second rename fails.
  const existing = fs.lstatSync(link);
  if (!existing.isSymbolicLink()) {
    try { fs.unlinkSync(temporary); } catch { /* no-op */ }
    throw new Error(`active design source is not an owned symlink: ${link}`);
  }
  const displaced = `${link}.${process.pid}.${Date.now()}.old`;
  fs.renameSync(link, displaced);
  try {
    fs.renameSync(temporary, link);
  } catch (error) {
    try { fs.renameSync(displaced, link); } catch { /* preserve the original error */ }
    try { fs.unlinkSync(temporary); } catch { /* no-op */ }
    throw error;
  }
  try { fs.unlinkSync(displaced); } catch { /* best-effort cleanup of a link only */ }
}

function appendEvent(paths, event) {
  ensurePrivateDirectory(paths.storeRoot);
  fs.appendFileSync(paths.eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function applyDesignSourceSelection(selection, options = {}) {
  const manifest = loadDesignSourceManifest(options.manifestPath);
  const lookup = sourceById(manifest);
  const paths = designSourcePaths(options);
  const before = Object.fromEntries(selection.ids.map(id => [id, activeRevision(paths, id)]));
  const prepared = new Map();
  for (const id of selection.ids) {
    const source = lookup.get(id);
    const revision = selection.targets[id];
    if (!source || !revisionPattern.test(revision ?? '')) throw new Error(`Invalid design source target: ${id}`);
    prepared.set(id, ensureSnapshot(source, revision, paths, options));
  }
  const switched = [];
  try {
    for (const id of selection.ids) {
      atomicSymlink(prepared.get(id), path.join(paths.activeRoot, id));
      switched.push(id);
    }
  } catch (error) {
    for (const id of switched.reverse()) {
      const link = path.join(paths.activeRoot, id);
      if (before[id]) atomicSymlink(path.join(paths.snapshotsRoot, id, before[id]), link);
      else { try { fs.unlinkSync(link); } catch { /* no-op */ } }
    }
    throw error;
  }
  appendEvent(paths, { type: 'apply', observedAt: new Date().toISOString(), ids: selection.ids, before, targets: selection.targets });
  return designSourcesStatus(options);
}

export function restoreDesignSourceSelection(revisions, options = {}) {
  const paths = designSourcePaths(options);
  for (const [id, revision] of Object.entries(revisions ?? {})) {
    if (!idPattern.test(id)) throw new Error(`Invalid design source id: ${id}`);
    const link = path.join(paths.activeRoot, id);
    if (revision == null) { try { fs.unlinkSync(link); } catch { /* no-op */ } continue; }
    if (!revisionPattern.test(revision)) throw new Error(`Invalid restore revision: ${id}`);
    const target = path.join(paths.snapshotsRoot, id, revision);
    if (!fs.existsSync(target)) throw new Error(`Missing restore snapshot: ${id}`);
    if (snapshotIntegrity(paths, id, revision, options) !== 'verified') {
      throw new Error(`Restore snapshot integrity failed: ${id}`);
    }
    atomicSymlink(target, link);
  }
  appendEvent(paths, { type: 'restore', observedAt: new Date().toISOString(), revisions });
  return designSourcesStatus(options);
}
