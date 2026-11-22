import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectCodexWork } from './codex-desktop-restart.mjs';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--') || argv[index + 1] === undefined) throw new Error('invalid_argument');
    values[key.slice(2)] = argv[index + 1];
  }
  return values;
}

function command(spawn, executable, args) {
  const result = spawn(executable, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: result.status === 0, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function version(text) {
  return /(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i.exec(String(text ?? ''))?.[1] ?? null;
}

function assertOwnedRelease(release, releasesRoot) {
  const resolved = fs.realpathSync(release);
  const root = fs.realpathSync(releasesRoot);
  if (!resolved.startsWith(`${root}${path.sep}`) || !fs.statSync(resolved).isDirectory()) throw new Error('release_target_outside_managed_root');
  return resolved;
}

export function restoreManagedCodexRelease({ currentLink, previousRelease, releasesRoot }) {
  const target = assertOwnedRelease(previousRelease, releasesRoot);
  const parent = path.dirname(currentLink);
  if (fs.realpathSync(parent) !== parent) throw new Error('current_link_parent_alias');
  const temporary = path.join(parent, `.current.aicc-${process.pid}-${Date.now()}`);
  fs.symlinkSync(target, temporary, process.platform === 'win32' ? 'junction' : undefined);
  if (process.platform === 'win32') {
    // MoveFileEx (used by fs.renameSync) cannot replace an existing junction.
    // Keep the swap recoverable by moving the exact managed link aside first,
    // then restore it if publishing the new junction fails. Never remove a
    // non-link or overwrite an unrelated path.
    const displaced = path.join(parent, `.current.aicc-previous-${process.pid}-${Date.now()}`);
    let displacedCurrent = false;
    try {
      let currentStat;
      try { currentStat = fs.lstatSync(currentLink); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (currentStat && !currentStat.isSymbolicLink()) throw new Error('current_link_not_symbolic');
      if (currentStat) {
        fs.renameSync(currentLink, displaced);
        displacedCurrent = true;
      }
      fs.renameSync(temporary, currentLink);
      if (displacedCurrent) {
        try { fs.unlinkSync(displaced); } catch { /* retain a recoverable old link if cleanup is denied */ }
      }
      return target;
    } catch (error) {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* keep original error */ }
      if (displacedCurrent) {
        try { if (!fs.existsSync(currentLink)) fs.renameSync(displaced, currentLink); } catch { /* keep original error */ }
      }
      throw error;
    }
  }
  // POSIX rename atomically replaces the owner-managed link.
  try { fs.renameSync(temporary, currentLink); }
  catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* keep original error */ }
    throw error;
  }
  return target;
}

export function runCodexCliUpdate(options = {}) {
  const values = options.values ?? parseArgs(options.argv ?? process.argv.slice(2));
  const home = options.home ?? os.homedir();
  const codexHome = values['codex-home'] ?? path.join(home, '.codex');
  const releasesRoot = path.join(codexHome, 'packages', 'standalone', 'releases');
  const currentLink = path.join(codexHome, 'packages', 'standalone', 'current');
  const previousRelease = assertOwnedRelease(values['previous-release'], releasesRoot);
  if (values['restore-only'] === 'true') {
    return { ok: true, restored: restoreManagedCodexRelease({ currentLink, previousRelease, releasesRoot }) };
  }
  const work = (options.inspectWork ?? inspectCodexWork)();
  if (work?.safe !== true) throw new Error(`codex_work_not_idle:active=${work?.active?.length ?? 0}:unknown=${work?.unknown?.length ?? 0}`);
  const updaterPid = path.join(codexHome, 'app-server-daemon', 'app-server-updater.pid');
  if (fs.existsSync(updaterPid)) {
    try {
      const pid = Number(JSON.parse(fs.readFileSync(updaterPid, 'utf8')).pid);
      if (Number.isInteger(pid) && pid > 1) {
        process.kill(pid, 0);
        throw new Error('codex_daemon_updater_active');
      }
    } catch (error) {
      if (error.message === 'codex_daemon_updater_active') throw error;
      if (error.code !== 'ESRCH') throw error;
    }
  }
  const codex = values.codex;
  const expectedVersion = values['expected-version'];
  const spawn = options.spawnSync ?? spawnSync;
  const before = command(spawn, codex, ['--version']);
  if (!before.ok || !version(before.stdout)) throw new Error('codex_before_version_unknown');
  const updated = command(spawn, codex, ['update']);
  const after = command(spawn, codex, ['--version']);
  const verified = updated.ok && after.ok && version(after.stdout) === expectedVersion;
  if (!verified) {
    restoreManagedCodexRelease({ currentLink, previousRelease, releasesRoot });
    throw new Error(`codex_update_failed_and_rolled_back:${updated.status ?? 'unknown'}`);
  }
  return { ok: true, previousVersion: version(before.stdout), currentVersion: version(after.stdout), previousRelease, daemonRestarted: false };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { process.stdout.write(`${JSON.stringify(runCodexCliUpdate())}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
