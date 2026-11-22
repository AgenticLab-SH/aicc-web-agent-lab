// G1-03: read-only comparison of the r2 overlay source files with the registered managed CLI
// release. It answers "is the source target installed?" without claiming effective daemon,
// endpoint or model behavior. No file, registry or service is changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function sha(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) return null;
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch { return null; }
}

export function codexCliInstallDrift(options = {}) {
  const home = options.home ?? os.homedir();
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT ?? path.join(home, '.ai-control-center');
  const root = options.sourceRoot ?? sourceRoot;
  let overlay;
  try { overlay = JSON.parse(fs.readFileSync(path.join(root, 'specs', 'independent-codex-cli-routes', 'command-route-r2.overlay.json'), 'utf8')); }
  catch { return { ok: false, state: 'source_overlay_unreadable', installedChanged: false }; }
  let cli;
  try { cli = JSON.parse(fs.readFileSync(path.join(stateRoot, 'runtime', 'components.json'), 'utf8')).components?.cli; }
  catch { return { ok: false, state: 'installed_registry_unreadable', installedChanged: false }; }
  const managed = path.join(stateRoot, 'releases', 'cli');
  const releaseRoot = typeof cli?.releaseRoot === 'string' ? path.resolve(cli.releaseRoot) : null;
  if (cli?.location !== 'managed' || !releaseRoot || !releaseRoot.toLowerCase().startsWith(managed.toLowerCase() + path.sep))
    return { ok: false, state: 'managed_cli_release_required', installedChanged: false };
  const files = (Array.isArray(overlay.paths) ? overlay.paths : []).map(row => {
    const relative = String(row.path ?? '');
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) return { path: relative, state: 'invalid_path' };
    const source = sha(path.join(root, relative)), installed = sha(path.join(releaseRoot, relative));
    return { path: relative, state: installed === null ? 'missing_in_installed' : source === installed ? 'same' : 'differs',
      sourceSha256: source, installedSha256: installed };
  });
  const pending = files.filter(row => row.state !== 'same');
  return { ok: true, state: pending.length ? 'SOURCE_TARGET_NOT_INSTALLED' : 'OVERLAY_FILES_MATCH_INSTALLED',
    installedRelease: cli.sourceRelease ?? path.basename(releaseRoot), overlay: 'command-route-r2',
    files, pendingCount: pending.length,
    meaning: 'file identity only; effective daemon, endpoint, model catalog and live requests are not inferred',
    installedChanged: false };
}
