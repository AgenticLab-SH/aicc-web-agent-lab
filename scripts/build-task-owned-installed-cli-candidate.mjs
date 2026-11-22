import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sealInstalledCliCandidate, verifyInstalledCliCandidate } from '../src/recovery/installed-cli-route-adapter.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const MAX_SPEC_BYTES = 256 * 1024;

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

function safeRelative(value) {
  const relative = String(value ?? '').replaceAll('\\', '/');
  if (!relative || relative.startsWith('/') || path.posix.isAbsolute(relative)
    || path.posix.normalize(relative) !== relative || relative.split('/').includes('..')) {
    throw new Error('overlay_path_invalid');
  }
  return relative;
}

function regularFile(file, maximumBytes = 32 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    throw new Error('overlay_file_unsafe');
  }
  const bytes = fs.readFileSync(file);
  return { bytes, size: bytes.length, sha256: sha256(bytes) };
}

function confinedFile(root, relative) {
  const rootReal = fs.realpathSync.native(root);
  const candidate = path.resolve(rootReal, ...relative.split('/'));
  const real = fs.realpathSync.native(candidate);
  const inside = path.relative(rootReal, real);
  if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) {
    throw new Error('overlay_path_escape');
  }
  if (!samePath(candidate, real)) throw new Error('overlay_path_alias');
  return real;
}

function readJson(file, maximumBytes) {
  const read = regularFile(file, maximumBytes);
  try { return { ...read, value: JSON.parse(read.bytes.toString('utf8')) }; }
  catch { throw new Error('overlay_json_invalid'); }
}

function sourceHead(root) {
  const value = String(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore']
  })).trim().toLowerCase();
  if (!GIT_SHA.test(value)) throw new Error('source_head_invalid');
  return value;
}

function atomicJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function normalizeSpec(spec) {
  if (spec?.schemaVersion !== 1 || spec?.component !== 'aicc-control-plane-overlay'
    || !Array.isArray(spec.paths) || spec.paths.length < 1) {
    throw new Error('overlay_spec_invalid');
  }
  const seen = new Set();
  return spec.paths.map(item => {
    const relative = safeRelative(item?.path);
    const reason = String(item?.reason ?? '').trim();
    if (!reason || reason.length > 120 || /[\x00-\x1f]/.test(reason)) throw new Error('overlay_reason_invalid');
    if (seen.has(relative)) throw new Error('overlay_path_duplicate');
    seen.add(relative);
    return { path: relative, reason };
  });
}

export function buildTaskOwnedInstalledCliCandidate(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot ?? '');
  const baseRoot = path.resolve(options.baseRoot ?? '');
  const candidateRoot = path.resolve(options.candidateRoot ?? '');
  const specFile = path.resolve(options.specFile ?? '');
  for (const [label, value] of Object.entries({ sourceRoot, baseRoot, candidateRoot, specFile })) {
    if (!path.isAbsolute(value)) throw new Error(`${label}_must_be_absolute`);
  }
  if (samePath(baseRoot, candidateRoot) || samePath(sourceRoot, candidateRoot)) throw new Error('candidate_root_alias');
  if (fs.existsSync(candidateRoot)) throw new Error('candidate_root_exists');

  const baseVerification = verifyInstalledCliCandidate(baseRoot);
  if (!baseVerification.ok || !SHA256.test(baseVerification.manifestHash ?? '')) {
    throw new Error(`base_release_unverified:${baseVerification.reason ?? 'unknown'}`);
  }
  const baseManifest = readJson(path.join(baseRoot, '.aicc-release.json'), 8 * 1024 * 1024).value;
  if (!SHA256.test(String(baseManifest?.sourceRevision ?? ''))) throw new Error('base_source_revision_invalid');

  const specRead = readJson(specFile, MAX_SPEC_BYTES);
  const paths = normalizeSpec(specRead.value);
  const head = String(options.sourceHead ?? sourceHead(sourceRoot)).toLowerCase();
  if (!GIT_SHA.test(head)) throw new Error('source_head_invalid');

  const overlays = paths.map(item => {
    const sourceFile = confinedFile(sourceRoot, item.path);
    const source = regularFile(sourceFile);
    const baseFile = path.resolve(baseRoot, ...item.path.split('/'));
    let base = null;
    if (fs.existsSync(baseFile)) {
      const read = regularFile(baseFile);
      base = { sha256: read.sha256, size: read.size };
    }
    return {
      path: item.path,
      reason: item.reason,
      sha256: source.sha256,
      size: source.size,
      baseSha256: base?.sha256 ?? null,
      baseSize: base?.size ?? null
    };
  });

  const workingTreeFingerprint = sha256(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    baseManifestHash: baseVerification.manifestHash,
    baseSourceRevision: baseManifest.sourceRevision,
    sourceHead: head,
    overlays: overlays.map(({ path: overlayPath, sha256: digest, size }) => ({ path: overlayPath, sha256: digest, size }))
  })));
  if (!SHA256.test(workingTreeFingerprint)) throw new Error('working_tree_fingerprint_invalid');

  fs.mkdirSync(path.dirname(candidateRoot), { recursive: true });
  fs.cpSync(baseRoot, candidateRoot, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  const copiedManifest = path.join(candidateRoot, '.aicc-release.json');
  const copiedManifestRead = regularFile(copiedManifest, 8 * 1024 * 1024);
  if (copiedManifestRead.sha256 !== baseVerification.manifestHash) throw new Error('base_copy_manifest_drift');
  fs.unlinkSync(copiedManifest);
  // An overlay release can be the next base; its provenance belongs to that base.
  const inheritedOverlay = path.join(candidateRoot, '.aicc-candidate-overlay.json');
  if (fs.existsSync(inheritedOverlay)) {
    const inherited = regularFile(inheritedOverlay, MAX_SPEC_BYTES);
    const baseOverlay = regularFile(path.join(baseRoot, '.aicc-candidate-overlay.json'), MAX_SPEC_BYTES);
    if (inherited.sha256 !== baseOverlay.sha256) throw new Error('base_copy_overlay_drift');
    fs.unlinkSync(inheritedOverlay);
  }

  for (const overlay of overlays) {
    const sourceFile = confinedFile(sourceRoot, overlay.path);
    const target = path.resolve(candidateRoot, ...overlay.path.split('/'));
    const relative = path.relative(candidateRoot, target);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('candidate_overlay_escape');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('candidate_overlay_symlink');
    fs.copyFileSync(sourceFile, target);
    const copied = regularFile(target);
    if (copied.sha256 !== overlay.sha256 || copied.size !== overlay.size) throw new Error('candidate_overlay_copy_mismatch');
  }

  const toolManifest = path.join(candidateRoot, 'components', 'workspace-mcp', 'tool-manifest.mjs');
  const toolSchemaDigest = fs.existsSync(toolManifest) ? regularFile(toolManifest).sha256 : null;
  const overlayManifest = {
    schemaVersion: 1,
    component: 'aicc-control-plane-overlay',
    baseRelease: {
      path: baseRoot,
      manifestSha256: baseVerification.manifestHash,
      sourceRevision: baseManifest.sourceRevision
    },
    source: {
      root: sourceRoot,
      gitHead: head,
      workingTreeFingerprint
    },
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      toolSchemaDigest
    },
    overlaySpecSha256: specRead.sha256,
    overlayCount: overlays.length,
    overlays
  };
  atomicJson(path.join(candidateRoot, '.aicc-candidate-overlay.json'), overlayManifest);

  const sealed = sealInstalledCliCandidate(candidateRoot, { sourceRevision: workingTreeFingerprint });
  const verified = verifyInstalledCliCandidate(candidateRoot);
  if (!verified.ok || verified.manifestHash !== sealed.manifestHash) {
    throw new Error(`candidate_verify_failed:${verified.reason ?? 'unknown'}`);
  }
  return Object.freeze({
    ok: true,
    candidateRoot,
    workingTreeFingerprint,
    sourceHead: head,
    baseManifestHash: baseVerification.manifestHash,
    overlaySpecHash: specRead.sha256,
    overlayCount: overlays.length,
    manifestHash: sealed.manifestHash,
    fileCount: sealed.fileCount,
    totalBytes: sealed.totalBytes,
    toolSchemaDigest
  });
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return argv[index + 1];
}

export function runTaskOwnedCandidateBuilder(argv = process.argv.slice(2)) {
  return buildTaskOwnedInstalledCliCandidate({
    sourceRoot: option(argv, '--source-root'),
    baseRoot: option(argv, '--base-root'),
    candidateRoot: option(argv, '--candidate-root'),
    specFile: option(argv, '--spec')
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.stdout.write(JSON.stringify(runTaskOwnedCandidateBuilder(), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\n');
    process.exitCode = 1;
  }
}
