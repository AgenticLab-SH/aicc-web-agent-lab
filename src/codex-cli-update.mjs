import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectCodexWork } from './codex-desktop-restart.mjs';
import { runCommand } from './lib/command.mjs';

function version(text) {
  return /(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i.exec(String(text ?? ''))?.[1] ?? null;
}

function jsonVersion(text) {
  try {
    const parsed = JSON.parse(String(text ?? '').trim());
    return typeof parsed === 'string' ? parsed : parsed?.version ?? null;
  } catch {
    return version(text);
  }
}

function realpath(file) {
  try { return fs.realpathSync(file); } catch { return null; }
}

export function resolveNpmExecutable(options = {}) {
  const configured = options.npmExecutable ?? options.environment?.AICC_NPM_EXECUTABLE?.trim();
  if (configured) return configured;
  const platform = options.platform ?? process.platform;
  const nodeDirectory = path.dirname(options.nodeExecutable ?? process.execPath);
  const siblingNames = platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'];
  for (const name of siblingNames) {
    const sibling = path.join(nodeDirectory, name);
    try {
      fs.accessSync(sibling, fs.constants.X_OK);
      return sibling;
    } catch {
      // Continue through the platform's executable variants.
    }
  }
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function commandInvocation(executable, args, platform, environment) {
  if (platform !== 'win32') return { executable, args };
  const extension = path.extname(executable).toLowerCase();
  const absolute = path.win32.isAbsolute(executable) || path.isAbsolute(executable);
  const requiresCmd = !absolute || ['.bat', '.cmd', '.ps1'].includes(extension) || !extension;
  if (!requiresCmd) return { executable, args };
  const shell = environment?.ComSpec?.trim() || process.env.ComSpec?.trim() || 'cmd.exe';
  return { executable: shell, args: ['/d', '/s', '/c', executable, ...args] };
}

function runNpmCommand(runner, executable, args, options, platform, environment) {
  const invocation = commandInvocation(executable, args, platform, environment);
  return runner(invocation.executable, invocation.args, options);
}

function updaterProcess(options = {}) {
  const pidFile = options.updaterPidFile;
  if (!pidFile || !fs.existsSync(pidFile)) return { active: false, pid: null, state: 'not-configured' };
  try {
    const pid = Number(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid);
    if (!Number.isInteger(pid) || pid <= 1) return { active: false, pid: null, state: 'invalid-record' };
    process.kill(pid, 0);
    return { active: true, pid, state: 'running' };
  } catch (error) {
    return { active: false, pid: null, state: error?.code === 'ESRCH' ? 'stale-record' : 'unavailable' };
  }
}

export async function codexCliUpdateStatus(options = {}) {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const codexHome = options.codexHome ?? path.join(home, '.codex');
  const codexExecutable = options.codexExecutable ?? path.join(home, '.local', 'bin', 'codex');
  const npmExecutable = resolveNpmExecutable({
    npmExecutable: options.npmExecutable,
    environment,
    nodeExecutable: options.nodeExecutable ?? process.execPath,
    platform
  });
  const runner = options.runCommand ?? runCommand;
  const work = (options.inspectWork ?? inspectCodexWork)(options.workOptions);
  const [installedResult, latestResult, daemonResult] = await Promise.all([
    runner(codexExecutable, ['--version'], { timeoutMs: 15_000, maxBytes: 20_000 }),
    runNpmCommand(runner, npmExecutable, ['view', '@openai/codex', 'version', '--json'], { timeoutMs: 30_000, maxBytes: 20_000 }, platform, environment),
    runner(codexExecutable, ['app-server', 'daemon', 'version'], { timeoutMs: 15_000, maxBytes: 40_000 })
  ]);
  const currentVersion = installedResult?.ok ? version(installedResult.stdout) : null;
  const latestVersion = latestResult?.ok ? jsonVersion(latestResult.stdout) : null;
  let daemon = null;
  if (daemonResult?.ok) {
    try { daemon = JSON.parse(daemonResult.stdout); } catch { daemon = null; }
  }
  const releasesRoot = path.join(codexHome, 'packages', 'standalone', 'releases');
  const currentLink = path.join(codexHome, 'packages', 'standalone', 'current');
  const executableRealpath = realpath(codexExecutable);
  const releaseTarget = realpath(currentLink);
  const managedStandalone = Boolean(
    executableRealpath
    && releaseTarget
    && executableRealpath.startsWith(`${releaseTarget}${path.sep}`)
    && releaseTarget.startsWith(`${releasesRoot}${path.sep}`)
  );
  const updater = updaterProcess({ updaterPidFile: path.join(codexHome, 'app-server-daemon', 'app-server-updater.pid') });
  return {
    ok: Boolean(currentVersion && latestVersion),
    package: '@openai/codex',
    npmExecutable,
    installMethod: managedStandalone ? 'official-standalone' : 'unknown-or-mixed',
    managedStandalone,
    codexExecutable,
    executableRealpath,
    currentLink,
    releaseTarget,
    currentVersion,
    latestVersion,
    updateAvailable: Boolean(currentVersion && latestVersion && currentVersion !== latestVersion),
    work: {
      safe: work?.safe === true,
      activeCount: work?.active?.length ?? 0,
      unknownCount: work?.unknown?.length ?? 0
    },
    daemon: daemon ? {
      status: daemon.status ?? 'unknown',
      backend: daemon.backend ?? null,
      cliVersion: daemon.cliVersion ?? null,
      appServerVersion: daemon.appServerVersion ?? null,
      managedCodexPath: daemon.managedCodexPath ?? null
    } : null,
    updater,
    restartPending: Boolean(daemon?.appServerVersion && currentVersion && daemon.appServerVersion !== currentVersion)
  };
}

export function codexCliUpdateSnapshot(status) {
  return {
    installMethod: status?.installMethod ?? 'unknown-or-mixed',
    managedStandalone: status?.managedStandalone === true,
    currentVersion: status?.currentVersion ?? null,
    latestVersion: status?.latestVersion ?? null,
    releaseTarget: status?.releaseTarget ?? null,
    currentLink: status?.currentLink ?? null,
    work: status?.work ?? { safe: false, activeCount: 0, unknownCount: 1 },
    daemon: status?.daemon ?? null,
    updater: status?.updater ?? { active: false, pid: null, state: 'unknown' },
    restartPending: status?.restartPending === true
  };
}
