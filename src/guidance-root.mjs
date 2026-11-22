import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class GuidanceRootError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'GuidanceRootError';
    this.code = code;
  }
}

function canonicalGuidanceRoot(root, code) {
  if (!path.isAbsolute(root)) throw new GuidanceRootError(code);
  let canonical;
  try { canonical = fs.realpathSync(root); }
  catch { throw new GuidanceRootError(code); }
  if (canonical !== path.resolve(root)) throw new GuidanceRootError(`${code}_alias`);
  for (const relative of ['guidance/skills', 'guidance/directives', 'tools/platform/test/Test-AiccGuidance.ps1']) {
    if (!fs.existsSync(path.join(canonical, relative))) throw new GuidanceRootError(`${code}_incomplete`);
  }
  return canonical;
}

function readOwnedManifest(file, group) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new GuidanceRootError('guidance_manifest_unsafe');
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o022) !== 0) throw new GuidanceRootError('guidance_manifest_writable_by_others');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new GuidanceRootError('guidance_manifest_owner_mismatch');
  }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new GuidanceRootError('guidance_manifest_invalid'); }
  if (manifest?.schema_version !== 1 || manifest.target_group !== group || typeof manifest.aicc_root !== 'string') {
    throw new GuidanceRootError('guidance_manifest_invalid');
  }
  return manifest;
}

function manifestCandidates(home, group) {
  if (group === 'codex') {
    return [
      path.join(home, '.agents', 'skills', '.aicc-guidance-deployment.json'),
      path.join(home, '.codex', 'skills', '.aicc-guidance-deployment.json')
    ];
  }
  return [path.join(home, `.${group}`, 'skills', '.aicc-guidance-deployment.json')];
}

export function resolveGuidanceCheckRoot({ runtimeRoot, home = os.homedir(), explicitRoot = process.env.AICC_GUIDANCE_ROOT } = {}) {
  if (explicitRoot) return Object.freeze({ root: canonicalGuidanceRoot(path.resolve(explicitRoot), 'guidance_explicit_root_invalid'), source: 'explicit' });
  const manifests = ['codex', 'claude'].flatMap(group => (
    manifestCandidates(home, group).map(file => readOwnedManifest(file, group))
  ));
  const present = manifests.filter(Boolean);
  if (present.length === 0) return Object.freeze({ root: canonicalGuidanceRoot(path.resolve(runtimeRoot), 'guidance_runtime_root_invalid'), source: 'runtime' });
  const roots = [...new Set(present.map(manifest => manifest.aicc_root))];
  if (roots.length !== 1) throw new GuidanceRootError('guidance_manifest_root_conflict');
  return Object.freeze({ root: canonicalGuidanceRoot(roots[0], 'guidance_manifest_root_invalid'), source: 'deployment-manifests' });
}
