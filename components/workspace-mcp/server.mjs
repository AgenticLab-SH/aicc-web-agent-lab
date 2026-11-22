#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { windowsOwnerEnvironment } from './windows-owner-environment.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RemoteLeaseAuthority } from './remote-authority.mjs';
import { readFilePage } from './bounded-file-read.mjs';
import { boundedWorkspaceSearch } from './bounded-search.mjs';
import { WORKSPACE_MCP_INPUT_SCHEMAS, workspaceMcpInputSchema } from './input-schemas.mjs';
import {
  normalizeWorkspaceSurfaceProfile,
  WORKSPACE_SURFACE_PROFILES,
  workspaceExecutionBoundaryForHost,
  workspaceCommandSandboxAvailable,
  workspacePermissionsForHost,
  workspaceToolSnapshot
} from './tool-manifest.mjs';
import { assertSafeWorkspaceCommand } from './destructive-command-guard.mjs';
import { startWorkspaceRuntimeMarker, workspaceRuntimeMarkerRoot, writeWorkspaceRuntimeMarker } from './runtime-marker.mjs';
import { registerLocalAccessTools } from './local-source-provider.mjs';
import { createWebManagementExecutor } from './web-management-provider.mjs';
import { createCodexCliExecutor } from './codex-cli-provider.mjs';
import { createGptQueueExecutor } from './gpt-queue-provider.mjs';
import { DurableJobStore } from '../../src/jobs/durable-store.mjs';
import { DurableRemoteWriterAuthorizer } from '../../src/remote/durable-writer-authorizer.mjs';
import { LocalAccessGrantStore } from '../../src/local-access/grant-store.mjs';
import { WorkspaceFastReadCoordinator, shouldFailClosedOnFastReadError } from './fast-read.mjs';

const componentRoot = path.dirname(fileURLToPath(import.meta.url));
const blockedNames = new Set([
  '.env', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials', 'credentials.json',
  'id_rsa', 'id_ed25519', 'known_hosts', '.ssh', '.gnupg', '.aws', '.azure', '.kube'
]);
const blockedExtensions = new Set(['.pem', '.key', '.p12', '.pfx']);
const ignoredSearch = ['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.venv'];
const processSessions = new Map();
const codexCliExecutors = new Set();
let runtimeMarkerContext = null;
let runtimeMarkerHeartbeat = null;

function executableFile(candidate) {
  if (!candidate || !path.isAbsolute(candidate)) return null;
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return null;
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

export function resolveRipgrepExecutable(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const isWindows = (options.platform ?? process.platform) === 'win32'
    || String(env.OS ?? '').toLowerCase() === 'windows_nt';
  const configured = env.AICC_RG_EXECUTABLE?.trim();
  if (configured) {
    const exact = executableFile(configured);
    if (!exact) throw new Error('AICC_RG_EXECUTABLE은 실행 가능한 절대 경로여야 합니다.');
    return exact;
  }
  const names = isWindows ? ['rg.exe', 'rg.cmd', 'rg'] : ['rg'];
  const candidates = [
    ...String(env.PATH ?? '').split(path.delimiter).filter(Boolean)
      .flatMap(entry => names.map(name => path.join(entry, name))),
    '/opt/homebrew/bin/rg',
    '/usr/local/bin/rg',
    path.join(home, '.local', 'share', 'mise', 'installs', 'github-burnt-sushi-ripgrep', 'latest', 'rg'),
    '/Applications/ChatGPT.app/Contents/Resources/rg'
  ];
  for (const candidate of new Set(candidates)) {
    const exact = executableFile(candidate);
    if (exact) return exact;
  }
  return null;
}

function boundedRipgrep({ executable, args, cwd, maxResults, maxOutputBytes, parseLine, timeoutMs = 20_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const results = [];
    let pending = '';
    let stderr = '';
    let acceptedBytes = 0;
    let linesSeen = 0;
    let parsedCandidates = 0;
    let limitReason = null;
    let timedOut = false;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const stop = reason => {
      if (limitReason) return;
      limitReason = reason;
      child.kill('SIGTERM');
    };
    const consume = line => {
      if (!line || limitReason) return;
      linesSeen += 1;
      let parsed;
      try { parsed = parseLine(line); }
      catch { return; }
      if (typeof parsed !== 'string' || !parsed) return;
      parsedCandidates += 1;
      const bytes = Buffer.byteLength(parsed);
      if (results.length >= maxResults) return stop('max_results');
      if (acceptedBytes + bytes > maxOutputBytes) return stop('max_output_bytes');
      results.push(parsed);
      acceptedBytes += bytes;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (limitReason) return;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        consume(line);
        if (limitReason) break;
      }
      if (!limitReason && Buffer.byteLength(pending) > maxOutputBytes) stop('single_line_output_limit');
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (Buffer.byteLength(stderr) < maxOutputBytes) stderr += chunk;
    });
    child.once('error', error => finish(new Error(`검색 실행에 실패했습니다: ${error.code ?? error.name ?? 'SPAWN_ERROR'}`)));
    child.once('close', code => {
      if (!limitReason && pending) consume(pending);
      if (timedOut) return finish(new Error('검색 실행 시간이 20초를 초과했습니다. 경로나 검색어를 더 좁혀 주세요.'));
      if (!limitReason && ![0, 1].includes(code)) {
        return finish(new Error((stderr || `검색 실행이 상태 ${code ?? 'UNKNOWN'}로 종료되었습니다.`).trim()));
      }
      return finish(null, {
        results,
        truncated: limitReason !== null,
        limitReason,
        acceptedBytes,
        linesSeen,
        parsedCandidates
      });
    });
  });
}

function workspaceSearchGlobs() {
  return [
    ...ignoredSearch.map(name => `!**/${name}/**`),
    '!**/.env',
    '!**/.env.*',
    ...[...blockedNames].flatMap(name => [`!**/${name}`, `!**/${name}/**`]),
    ...[...blockedExtensions].map(extension => `!**/*${extension}`)
  ];
}
const activatedSkills = new Map();

function response(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {})
  };
}

function writeAuthorityMarker(config, configPath, options = {}) {
  return writeWorkspaceRuntimeMarker(config, configPath, options);
}

function safeError(error) {
  const diagnostics = error instanceof WorkspacePatchError
    ? { code: error.code, stage: error.stage, writeState: error.writeState }
    : null;
  return response({ ok: false, error: error instanceof Error ? error.message : String(error), ...(diagnostics ? { diagnostics } : {}) }, true);
}

class WorkspacePatchError extends Error {
  constructor(message, code, stage, writeState) {
    super(message);
    this.name = 'WorkspacePatchError';
    this.code = code;
    this.stage = stage;
    this.writeState = writeState;
  }
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--config' || !path.isAbsolute(argv[1])) {
    throw new Error('Usage: server.mjs --config ABSOLUTE_JSON');
  }
  return { configPath: path.resolve(argv[1]) };
}

export function loadConfig(configPath, options = {}) {
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Workspace MCP 설정은 실제 일반 파일이어야 합니다.');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.schemaVersion !== 2 || !Array.isArray(config.workspaces) || !config.workspaces.length) {
    throw new Error('Workspace MCP 설정 형식이 올바르지 않습니다.');
  }
  config.surfaceProfile = normalizeWorkspaceSurfaceProfile(config.surfaceProfile);
  config.permissions = workspacePermissionsForHost(config.permissions, {
    surfaceProfile: config.surfaceProfile,
    platform: options.platform,
    commandSandboxAvailable: workspaceCommandSandboxAvailable(config, options)
  });
  config.executionBoundary = workspaceExecutionBoundaryForHost(config.executionBoundary, config.permissions);
  const aliases = new Set();
  for (const item of config.workspaces) {
    if (!/^[a-z0-9._-]+$/.test(item.alias) || aliases.has(item.alias)) throw new Error('워크스페이스 별칭이 올바르지 않거나 중복되었습니다.');
    const stat = fs.lstatSync(item.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`등록 워크스페이스가 실제 디렉터리가 아닙니다: ${item.alias}`);
    item.root = fs.realpathSync(item.root);
    aliases.add(item.alias);
  }
  return config;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertNotSensitive(relativePath) {
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const normalizedParts = parts.map(part => part.toLocaleLowerCase('en-US'));
  const basename = parts.at(-1)?.toLocaleLowerCase('en-US') ?? '';
  if (normalizedParts.some(part => blockedNames.has(part))
    || basename.startsWith('.env.')
    || blockedExtensions.has(path.extname(basename))) {
    throw new Error(`민감 파일은 원격 작업공간 도구로 읽거나 수정할 수 없습니다: ${relativePath}`);
  }
  if (normalizedParts.includes('.git')) {
    throw new Error(`Git 내부 메타데이터는 원격 작업공간 도구에서 직접 다루지 않습니다: ${relativePath}`);
  }
}

export function confinedPath(root, relativePath, options = {}) {
  root = fs.realpathSync(root);
  if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
    throw new Error('경로는 워크스페이스 기준 상대 경로여야 합니다.');
  }
  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new Error('경로가 워크스페이스를 벗어납니다.');
  assertNotSensitive(normalized);
  const target = path.resolve(root, normalized);
  if (!inside(root, target)) throw new Error('경로가 워크스페이스를 벗어납니다.');
  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const resolvedExisting = fs.realpathSync(existing);
  if (!inside(root, resolvedExisting)) throw new Error('심볼릭 링크가 워크스페이스 밖을 가리킵니다.');
  if (!options.allowMissing && !fs.existsSync(target)) throw new Error(`파일을 찾지 못했습니다: ${relativePath}`);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('심볼릭 링크 자체는 원격 도구로 다루지 않습니다.');
    const real = fs.realpathSync(target);
    if (!inside(root, real)) throw new Error('경로가 워크스페이스 밖으로 해석됩니다.');
    return real;
  }
  return target;
}

function workspaceId(item) {
  return `ws_${createHash('sha256').update(`${item.alias}\0${item.root}`).digest('hex').slice(0, 24)}`;
}

function resolveWorkspace(config, workspaceIdValue) {
  const workspace = config.workspaces.find(item => workspaceId(item) === workspaceIdValue);
  if (!workspace) throw new Error('등록되지 않은 워크스페이스입니다.');
  return workspace;
}

function conflictingWorkspaceIds(config, workspace) {
  return config.workspaces
    .filter(candidate => inside(workspace.root, candidate.root) || inside(candidate.root, workspace.root))
    .map(candidate => workspaceId(candidate));
}

function quoteSeatbelt(value) {
  return `\"${String(value).replaceAll('\\', '\\\\').replaceAll('\"', '\\\"')}\"`;
}

function quoteSeatbeltRegex(value) {
  return `#\"${String(value).replaceAll('\"', '\\\"')}\"`;
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sensitiveSandboxRegexes(root) {
  const prefix = `^${regexEscape(root)}/`;
  const segmentNames = [...blockedNames]
    .filter(name => name !== '.env')
    .map(regexEscape)
    .sort((left, right) => right.length - left.length)
    .join('|');
  const extensions = [...blockedExtensions].map(extension => regexEscape(extension.slice(1))).join('|');
  return [
    `${prefix}(?:.*/)?\\.env(?:\\.[^/]*)?$`,
    `${prefix}(?:.*/)?(?:${segmentNames})(?:/.*)?$`,
    `${prefix}(?:.*/)?[^/]+\\.(?:${extensions})$`
  ];
}

function allowedRuntimeReads() {
  const candidates = ['/System', '/usr', '/bin', '/sbin', '/opt/homebrew', '/Library', '/private/var/db', '/dev'];
  const executable = fs.realpathSync(process.execPath);
  candidates.push(path.dirname(path.dirname(executable)));
  return [...new Set(candidates.filter(item => fs.existsSync(item)).map(item => fs.realpathSync(item)))];
}

export function sandboxProfile(root, runtimeRoot, network = true) {
  root = fs.realpathSync(root);
  runtimeRoot = fs.realpathSync(runtimeRoot);
  const home = fs.realpathSync(os.homedir());
  const reads = [root, runtimeRoot, ...allowedRuntimeReads()];
  const writes = [root, runtimeRoot, '/private/tmp', '/tmp'].filter(item => fs.existsSync(item));
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-read* (subpath ${quoteSeatbelt(home)}))`,
    '(deny file-write*)',
    ...reads.map(item => `(allow file-read* (subpath ${quoteSeatbelt(item)}))`),
    ...writes.map(item => `(allow file-write* (subpath ${quoteSeatbelt(fs.realpathSync(item))}))`),
    ...sensitiveSandboxRegexes(root).flatMap(pattern => [
      `(deny file-read* (regex ${quoteSeatbeltRegex(pattern)}))`,
      `(deny file-write* (regex ${quoteSeatbeltRegex(pattern)}))`
    ]),
    ...(network ? [] : ['(deny network*)'])
  ].join('\n');
}

function cleanEnvironment(root, runtimeRoot) {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const git = String(process.env.PATH ?? '').split(path.delimiter)
      .map(directory => executableFile(path.join(directory, 'git.exe'))).find(Boolean);
    const pathValue = [
      powershell ? path.dirname(powershell) : null,
      git ? path.dirname(git) : null,
      path.dirname(process.execPath),
      path.join(systemRoot, 'System32'),
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
    ].filter(Boolean).filter(item => fs.existsSync(item)).join(path.delimiter);
    return {
      PATH: pathValue,
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      ComSpec: process.env.ComSpec || path.join(systemRoot, 'System32', 'cmd.exe'),
      PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
      PSModulePath: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
      TEMP: runtimeRoot,
      TMP: runtimeRoot,
      LOCALAPPDATA: runtimeRoot,
      APPDATA: runtimeRoot,
      USERPROFILE: root,
      HOME: root,
      AICC_WORKSPACE_ROOT: root,
      AICC_RUNTIME_ROOT: runtimeRoot,
      NO_COLOR: '1',
      CI: '1'
    };
  }
  const pathValue = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin', path.dirname(process.execPath)]
    .filter(item => fs.existsSync(item)).join(':');
  return {
    PATH: pathValue,
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8',
    TMPDIR: '/private/tmp',
    HOME: root,
    AICC_WORKSPACE_ROOT: root,
    AICC_RUNTIME_ROOT: runtimeRoot,
    NO_COLOR: '1',
    CI: '1'
  };
}

function sandboxInvocation(root, runtimeRoot, command, network, commandIsolation) {
  if (process.platform === 'win32') {
    if (commandIsolation === 'owner-unrestricted-windows') {
      if (!network) throw new Error('Windows unrestricted command mode cannot enforce a network deny policy.');
      const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
      const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      if (!fs.existsSync(executable)) throw new Error('Windows PowerShell executable is unavailable.');
      return { executable,
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;' + command],
        env: windowsOwnerEnvironment({ root, runtimeRoot }) };
    }
    if (commandIsolation !== 'appcontainer-windows') {
      throw new Error('Windows workspace exec requires an explicit command isolation policy.');
    }
    const executable = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (!executable) throw new Error('Windows workspace exec requires PowerShell.');
    const broker = path.resolve(componentRoot, '../../tools/platform/windows/Invoke-AiccWorkspaceSandbox.ps1');
    if (!fs.existsSync(broker)) throw new Error('Windows AppContainer workspace broker is missing.');
    const workspaceHash = createHash('sha256').update(root.toLocaleLowerCase('en-US')).digest('hex').slice(0, 24);
    const brokerRuntime = path.join(runtimeRoot, 'windows-appcontainer', workspaceHash);
    fs.mkdirSync(brokerRuntime, { recursive: true, mode: 0o700 });
    const commandFile = path.join(brokerRuntime, `command-${randomBytes(16).toString('hex')}.txt`);
    fs.writeFileSync(commandFile, command, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return {
      executable,
      args: [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', broker,
        '-WorkspaceRoot', root,
        '-RuntimeRoot', brokerRuntime,
        '-CommandFile', commandFile,
        '-Network', network ? 'Enabled' : 'Disabled'
      ],
      env: cleanEnvironment(root, brokerRuntime),
      cleanupFiles: [commandFile]
    };
  }
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) {
    throw new Error('명령 실행은 macOS sandbox-exec가 있는 호스트에서만 지원됩니다.');
  }
  return {
    executable: '/usr/bin/sandbox-exec',
    args: ['-p', sandboxProfile(root, runtimeRoot, network), '/bin/zsh', '-f', '-c', command],
    env: cleanEnvironment(root, runtimeRoot)
  };
}

function appendOutput(session, chunk) {
  session.output += chunk.toString('utf8');
  if (Buffer.byteLength(session.output) > session.maxOutputBytes) {
    const tail = Buffer.from(session.output).subarray(-session.maxOutputBytes).toString('utf8');
    session.outputBase = (session.outputBase ?? 0) + session.output.length - tail.length;
    session.output = tail;
    session.truncated = true;
  }
}

function sessionResult(session, from = 0) {
  return {
    ok: session.exitCode === 0 || session.exitCode === null,
    session_id: session.id,
    running: session.exitCode === null,
    exit_code: session.exitCode,
    process_running: session.osExitObserved === true ? false : (session.exitCode === null ? null : false),
    os_exit_code: session.osExitCode ?? null,
    os_exit_signal: session.osExitSignal ?? null,
    output_complete: session.outputComplete === true,
    output: session.output.slice(Math.max(0, from - (session.outputBase ?? 0))),
    output_cursor: (session.outputBase ?? 0) + session.output.length,
    output_start_cursor: session.outputBase ?? 0,
    output_gap: from < (session.outputBase ?? 0),
    truncated: session.truncated,
    timed_out: session.timedOut,
    terminal_reason: session.terminalReason
  };
}

function stopProcessSession(session, reason = 'requested_stop') {
  if (!session?.child || session.exitCode !== null || session.osExitObserved === true) return false;
  session.terminalReason = reason;
  const pid = session.child.pid;
  try {
    if (session.processGroup && Number.isInteger(pid)) process.kill(-pid, 'SIGTERM');
    else session.child.kill('SIGTERM');
  } catch { /* The close event may already be queued. */ }
  if (!session.forceKillTimer) {
    session.forceKillTimer = setTimeout(() => {
      if (!session.child || session.exitCode !== null || session.osExitObserved === true) return;
      try {
        if (session.processGroup && Number.isInteger(pid)) process.kill(-pid, 'SIGKILL');
        else session.child.kill('SIGKILL');
      } catch { /* Process tree already exited. */ }
    }, 2_000);
    session.forceKillTimer.unref?.();
  }
  return true;
}

function stopSessionsForLease(leaseId, reason) {
  for (const session of processSessions.values()) {
    if (session.remoteLeaseId === leaseId) stopProcessSession(session, reason);
  }
}

function processStopResult(session) {
  const stopped = stopProcessSession(session, 'requested_stop');
  return {
    ...sessionResult(session),
    stopped,
    already_exited: session.osExitObserved === true || session.exitCode !== null || !session.child,
    awaiting_output_close: session.osExitObserved === true && session.outputComplete !== true && session.exitCode === null
  };
}

function retireSessionsForLease(leaseId, reason) {
  for (const session of processSessions.values()) {
    if (session.remoteLeaseId !== leaseId) continue;
    session.retired = true;
    if (session.child && session.exitCode === null) stopProcessSession(session, reason);
    else { session.output = ""; processSessions.delete(session.id); }
  }
}

function finishProcessSession(session, exitCode, terminalReason = null) {
  if (session.exitCode !== null) return;
  session.exitCode = exitCode ?? 1;
  session.child = null;
  if (terminalReason) session.terminalReason = terminalReason;
  if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
  if (session.forceKillTimer) clearTimeout(session.forceKillTimer);
  session.timeoutTimer = null;
  session.forceKillTimer = null;
  for (const file of session.cleanupFiles ?? []) {
    try { fs.unlinkSync(file); } catch { /* retain unrelated paths */ }
  }
  session.cleanupFiles = [];
  if (session.retired) { session.output = ""; processSessions.delete(session.id); }
}

function bindProcessSession(child, session) {
  child.stdout?.on('data', chunk => appendOutput(session, chunk));
  child.stderr?.on('data', chunk => appendOutput(session, chunk));
  child.once('error', error => {
    const code = typeof error?.code === 'string' ? error.code : 'SPAWN_ERROR';
    appendOutput(session, `[process_spawn_error] ${code}\n`);
    finishProcessSession(session, 1, 'process_spawn_error');
  });
  child.once('exit', (code, signal) => {
    session.osExitObserved = true;
    session.osExitCode = Number.isInteger(code) ? code : null;
    session.osExitSignal = typeof signal === 'string' ? signal : null;
    if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
    if (session.forceKillTimer) clearTimeout(session.forceKillTimer);
    session.timeoutTimer = null;
    session.forceKillTimer = null;
  });
  child.once('close', code => {
    session.outputComplete = true;
    finishProcessSession(session, code);
  });
}

function startCommand(root, runtimeRoot, command, config, yieldTimeMs, remoteLease) {
  assertSafeWorkspaceCommand(command, {
    workspaceRoot: root,
    stateRoot: runtimeRoot,
    home: os.homedir(),
    env: process.env
  });
  const invocation = sandboxInvocation(root, runtimeRoot, command, config.permissions.network !== false, config.permissions.commandIsolation);
  const child = spawn(invocation.executable, invocation.args, {
    cwd: root,
    env: invocation.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });
  const id = `proc_${randomBytes(16).toString('hex')}`;
  const session = {
    id, child, output: '', exitCode: null, truncated: false, timedOut: false, terminalReason: null,
    processGroup: process.platform !== 'win32', forceKillTimer: null, timeoutTimer: null,
    cleanupFiles: invocation.cleanupFiles ?? [],
    maxOutputBytes: config.permissions.maxOutputBytes ?? 262_144,
    remoteLeaseId: remoteLease.leaseId,
    workspaceId: remoteLease.workspaceId
  };
  processSessions.set(id, session);
  const timeoutMs = Math.max(1, Math.min(7_200_000, Number(config.permissions.commandTimeoutMs ?? 7_200_000), Date.parse(remoteLease.expiresAt) - Date.now()));
  session.timeoutTimer = setTimeout(() => {
    session.timedOut = true;
    stopProcessSession(session, 'command_timeout');
  }, timeoutMs);
  session.timeoutTimer.unref?.();
  bindProcessSession(child, session);
  return new Promise(resolve => setTimeout(() => resolve(sessionResult(session)), Math.max(50, Math.min(yieldTimeMs, 10_000))));
}

function validatePatchPaths(root, patchText) {
  const paths = [];
  for (const line of patchText.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.startsWith('+++ ') && !line.startsWith('--- ')) continue;
    const raw = line.slice(4).split('\t')[0].trim();
    if (raw === '/dev/null') continue;
    const relative = raw.replace(/^[ab]\//, '');
    if (relative.split(/[\\/]/).includes('..')) throw new Error('워크스페이스를 벗어납니다.');
    if (relative.split(/[\\/]/).some(part => /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) throw new Error('Unsafe patch path');
    confinedPath(root, relative, { allowMissing: true });
    paths.push(relative);
  }
  if (!paths.length) throw new Error('통합 diff에 파일 경로가 없습니다.');
  return [...new Set(paths)];
}

// Create one validated component at a time: never follow a link or an ADS path.
function ensurePatchParents(root, files) {
  for (const relative of files) {
    const components = relative.replace(/\\/g, '/').split('/').slice(0, -1);
    let current = root;
    for (const component of components) {
      if (!component || component === '.' || component === '..' || /[<>:"|?*\x00-\x1f]/.test(component)
          || /[. ]$/.test(component)) throw new Error('Unsafe patch parent directory');
      current = path.join(current, component);
      confinedPath(root, path.relative(root, current), { allowMissing: true });
      if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, fs.realpathSync(current)))
        throw new Error('Patch parent must be a confined regular directory');
    }
  }
}
function runPatch(root, runtimeRoot, patchText, network) {
  if (/^(?:rename (?:from|to)|copy (?:from|to)|GIT binary patch|Binary files )/m.test(patchText)) {
    throw new WorkspacePatchError('Only unified text patches are supported', 'PATCH_FORMAT_UNSUPPORTED', 'format', 'NOT_STARTED');
  }
  let files;
  try {
    files = validatePatchPaths(root, patchText);
  } catch (error) {
    throw new WorkspacePatchError(error instanceof Error ? error.message : String(error), 'PATCH_PATH_CHECK_FAILED', 'path-check', 'NOT_STARTED');
  }
  const execute = process.platform === 'win32'
    ? dryRun => spawnSync('git.exe', [
      'apply', '--no-index', '--whitespace=nowarn', '-p1', ...(dryRun ? ['--check'] : [])
    ], { cwd: root, input: patchText, encoding: 'utf8', timeout: 30_000, windowsHide: true })
    : dryRun => {
      const profile = sandboxProfile(root, runtimeRoot, network);
      return spawnSync('/usr/bin/sandbox-exec', [
        '-p', profile, '/usr/bin/patch', '--batch', '--forward', '-p1', ...(dryRun ? ['--dry-run'] : [])
      ], { cwd: root, input: patchText, encoding: 'utf8', env: cleanEnvironment(root, runtimeRoot), timeout: 30_000 });
    };
  const checked = execute(true);
  if (checked.status !== 0) {
    throw new WorkspacePatchError(`패치 사전 검사가 실패했습니다: ${(checked.stderr || checked.stdout || '').trim()}`, checked.error ? 'PATCH_EXECUTOR_FAILED' : 'PATCH_PREFLIGHT_FAILED', 'preflight', 'NOT_STARTED');
  }
  try {
    ensurePatchParents(root, files);
    for (const relative of files) confinedPath(root, relative, { allowMissing: true });
  } catch (error) {
    throw new WorkspacePatchError(error instanceof Error ? error.message : String(error), 'PATCH_PREPARE_FAILED', 'prepare', 'UNKNOWN');
  }
  const applied = execute(false);
  if (applied.status !== 0) {
    throw new WorkspacePatchError(`패치 적용이 실패했습니다: ${(applied.stderr || applied.stdout || '').trim()}`, 'PATCH_APPLY_FAILED', 'apply', 'UNKNOWN');
  }
  return { ok: true, files, output: (applied.stdout || '').trim() };
}

function gitSummary(root, maxOutputBytes) {
  // Git for Windows is normally exposed as `git.exe` through PATH; the
  // macOS image keeps the stable system path used by the sandbox profile.
  const git = process.platform === 'win32' ? 'git.exe' : '/usr/bin/git';
  const run = args => spawnSync(git, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: maxOutputBytes,
    windowsHide: true
  });
  const status = run(['status', '--short']);
  const stat = run(['diff', '--stat']);
  const staged = run(['diff', '--cached', '--stat']);
  if (status.status !== 0) throw new Error((status.stderr || 'Git 상태를 읽지 못했습니다.').trim());
  return { ok: true, status: status.stdout, diff_stat: stat.stdout, staged_stat: staged.stdout };
}

function skillCatalog(config) {
  const entries = [];
  for (const root of config.skillRoots ?? []) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const skillFile = path.join(root, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const first = fs.readFileSync(skillFile, 'utf8').split('\n').slice(0, 12).join('\n');
      const description = first.match(/^description:\s*[\"']?(.*?)[\"']?\s*$/m)?.[1] ?? '';
      entries.push({ id: entry.name, description, root: path.join(root, entry.name) });
    }
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

export function createWorkspaceMcpServer(config, options = {}) {
  const surfaceProfile = normalizeWorkspaceSurfaceProfile(config.surfaceProfile);
  const personalReadFetch = surfaceProfile === WORKSPACE_SURFACE_PROFILES.PERSONAL_READ_FETCH;
  config = {
    ...config,
    permissions: workspacePermissionsForHost(config.permissions, {
      surfaceProfile,
      platform: options.platform,
      commandSandboxAvailable: workspaceCommandSandboxAvailable(config, options)
    })
  };
  config.executionBoundary = workspaceExecutionBoundaryForHost(config.executionBoundary, config.permissions);
  const runtimeRoot = options.runtimeRoot ?? path.join(path.dirname(options.configPath ?? os.tmpdir()), 'runtime');
  const ripgrepExecutable = options.ripgrepExecutable ?? resolveRipgrepExecutable(options.ripgrepOptions);
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const server = new McpServer({ name: 'aicc-workspace', version: '1.0.0' });
  const fastRead = options.fastReadCoordinator ?? null;
  const codexCli = !personalReadFetch && config.codexCli?.enabled === true ? createCodexCliExecutor(config) : null;
  if (codexCli) codexCliExecutors.add(codexCli);
  const gptQueue = !personalReadFetch && config.gptQueue?.enabled === true
    ? createGptQueueExecutor(config,{exchange:options.gptQueueExchange,now:options.now,
      verifyRegistry:options.gptQueueRegistryVerify}) : null;
  const remoteAuthority = options.remoteAuthority ?? new RemoteLeaseAuthority({
    identityBinding: config.remoteAuthority?.identityBinding ?? 'authenticated-tunnel-owner',
    readTtlMs: Math.max(1, Math.min(7200, config.remoteAuthority?.readExpirySeconds ?? 7200)) * 1000,
    writeTtlMs: Math.max(1, Math.min(7200, config.remoteAuthority?.writeExpirySeconds ?? 7200)) * 1000,
    store: options.durableStore ?? null,
    readStore: options.readSessionStore ?? options.durableStore ?? null,
    writerAuthorizer: options.writerAuthorizer ?? null,
    writePolicy: config.remoteAuthority?.writePolicy ?? 'guarded',
    onExpire: record => {
      fastRead?.close(record.leaseId);
      activatedSkills.delete(record.leaseId);
      retireSessionsForLease(record.leaseId, 'lease_expired');
      codexCli?.stopLease(record.leaseId);
    }
  });
  remoteAuthority.reconcileStartup();
  const withLease = (requiredMode, callback, { codexDispatch = false } = {}) => async (input, extra) => {
    try {
      const lease = await remoteAuthority.resolve({ workspaceId: input.workspace_id, capability: input.lease, requiredMode, requestId: input.request_id ?? null });
      const workspace = resolveWorkspace(config, input.workspace_id);
      if (requiredMode === 'write' && !codexDispatch) codexCli?.assertNoWriter(workspace);
      return await callback(input, { workspace, lease, signal: extra?.signal });
    } catch (error) { return safeError(error); }
  };

  server.registerTool('aicc_workspace_open', {
    title: 'AICC 워크스페이스 열기',
    description: 'AICC에 미리 등록된 별칭으로 하나의 로컬 워크스페이스를 엽니다. 임의 경로는 허용하지 않습니다.',
    inputSchema: workspaceMcpInputSchema('aicc_workspace_open', { surfaceProfile }),
    annotations: personalReadFetch
      ? { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
      : { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async ({ alias, mode, correlation_id, approval_ref, job_id, attempt_id, expires_in_seconds }) => {
    try {
      const workspace = config.workspaces.find(item => item.alias === alias);
      if (!workspace) throw new Error(`등록된 워크스페이스 별칭이 아닙니다: ${alias}`);
      const id = workspaceId(workspace);
      const opened = await remoteAuthority.open({
        workspaceId: id,
        conflictWorkspaceIds: conflictingWorkspaceIds(config, workspace),
        mode: personalReadFetch ? 'read-only' : mode ?? config.remoteAuthority?.defaultMode ?? 'read-only',
        correlationId: correlation_id,
        approvalRef: approval_ref,
        jobId: job_id,
        attemptId: attempt_id,
        expiresInSeconds: expires_in_seconds
      });
      activatedSkills.set(opened.record.leaseId, new Set());
      const fastReadStatus = opened.record.mode === 'read-only'
        ? fastRead?.open({ leaseId: opened.record.leaseId, root: workspace.root }) ?? { available: false, reason: 'not_configured' }
        : { available: false, reason: 'write_lease' };
      return response({
        ok: true, workspace_id: id, lease: opened.capability, alias, label: workspace.label,
        mode: opened.record.mode, expires_at: opened.record.expiresAt,
        correlation_id: opened.record.correlationId, writer_lease_ref: opened.record.writerLeaseRef,
        fast_read: fastReadStatus
      });
    } catch (error) { return safeError(error); }
  });

  server.registerTool('aicc_workspace_close', {
    title: 'AICC 워크스페이스 닫기',
    description: '열린 워크스페이스 lease를 즉시 반환합니다. 실행 중인 명령이 있으면 먼저 완료하거나 중지해야 합니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_workspace_close,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async input => {
    try {
      const lease = await remoteAuthority.resolve({
        workspaceId: input.workspace_id,
        capability: input.lease,
        requiredMode: 'read'
      });
      const running = [...processSessions.values()].filter(session => (
        session.remoteLeaseId === lease.leaseId
        && session.workspaceId === lease.workspaceId
        && session.child
        && session.exitCode === null
      ));
      if (running.length > 0 || codexCli?.activeForLease(lease.leaseId)) throw new Error('이 lease에 실행 중인 프로세스가 있습니다. 완료를 확인하거나 먼저 중지해 주세요.');
      const closed = await remoteAuthority.close(input.lease, 'remote_tool_close');
      fastRead?.close(lease.leaseId);
      activatedSkills.delete(lease.leaseId);
      retireSessionsForLease(lease.leaseId, 'remote_tool_close');
      return response({ ok: true, ...closed });
    } catch (error) { return safeError(error); }
  });

  server.registerTool('aicc_workspace_list', {
    title: 'AICC 워크스페이스 목록',
    description: '등록된 워크스페이스 별칭과 표시 이름을 반환합니다. 로컬 절대 경로는 노출하지 않습니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_workspace_list,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => response({ ok: true, default: config.defaultWorkspace, workspaces: config.workspaces.map(({ alias, label }) => ({ alias, label })) }));

  server.registerTool('aicc_workspace_info', {
    title: '워크스페이스 개요',
    description: '열린 워크스페이스의 Git 브랜치, 변경 상태와 최상위 항목을 경계 안에서 요약합니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_workspace_info,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, withLease('read', async (input, { workspace }) => {
    const git = process.platform === 'win32' ? 'git.exe' : '/usr/bin/git';
    const run = args => spawnSync(git, args, {
      cwd: workspace.root,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: config.permissions.maxOutputBytes ?? 262_144,
      windowsHide: true
    });
    const branch = run(['branch', '--show-current']);
    const status = run(['status', '--short']);
    const entries = fs.readdirSync(workspace.root, { withFileTypes: true })
      .filter(entry => !entry.isSymbolicLink() && !ignoredSearch.includes(entry.name) && !blockedNames.has(entry.name.toLocaleLowerCase('en-US')))
      .slice(0, 200)
      .map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' }));
    return response({
      ok: true,
      alias: workspace.alias,
      label: workspace.label,
      git: branch.status === 0 ? { branch: branch.stdout.trim() || null, clean: !status.stdout.trim(), changed_files: status.stdout.split('\n').filter(Boolean).length } : null,
      entries,
      entries_truncated: entries.length >= 200
    });
  }));

  server.registerTool('aicc_workspace_read', {
    title: '워크스페이스 파일 읽기',
    description: '파일 크기와 무관하게 byte 페이지로 읽습니다. 텍스트는 인코딩을 지정할 수 있고 바이너리는 base64로 반환합니다. 다음 페이지는 next_offset_bytes와 file_version을 사용하세요.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_workspace_read,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, withLease('read', async (input, { workspace, lease, signal }) => {
    const file = confinedPath(workspace.root, input.path);
    const load = () => ({ ...readFilePage(file, input), path: input.path });
    return response(fastRead ? await fastRead.boundedQuery({
      leaseId: lease.leaseId, key: ['read-page', input], load, signal
    }) : load());
  }));

  server.registerTool('aicc_workspace_read_many', {
    title: '워크스페이스 여러 파일 읽기',
    description: '최대 20개 파일의 첫 페이지를 읽습니다. 전체 파일 크기 제한은 없으며 응답 byte 예산이 차면 next_path_index부터 이어가세요. 각 파일의 나머지는 workspace_read로 이어 읽습니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_workspace_read_many,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, withLease('read', async (input, { workspace }) => {
    const files = [];
    let budget = input.max_total_bytes;
    let index = input.start_path_index;
    for (; index < input.paths.length && budget > 0; index++) {
      const relative = input.paths[index];
      const page = readFilePage(confinedPath(workspace.root, relative), {
        max_bytes: Math.min(budget, input.max_bytes_each), max_lines: input.max_lines_each, encoding: input.encoding
      });
      files.push({ ...page, path: relative });
      budget -= page.bytes_read;
    }
    return response({ ok: true, files, next_path_index: index < input.paths.length ? index : null,
      paths_complete: index >= input.paths.length, response_bytes: input.max_total_bytes - budget });
  }));
  server.registerTool('aicc_workspace_search', {
    title: '워크스페이스 검색',
    description: 'ripgrep으로 열린 워크스페이스 안의 파일명 또는 텍스트를 검색합니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_workspace_search,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {
      'openai/toolInvocation/invoking': '워크스페이스 검색 중…',
      'openai/toolInvocation/invoked': '워크스페이스 검색 완료'
    }
  }, withLease('read', async (input, { workspace, lease, signal }) => {
    if (input.path !== '.') confinedPath(workspace.root, input.path);
    if (!ripgrepExecutable) throw new Error('ripgrep 실행기를 찾지 못했습니다. AICC_RG_EXECUTABLE을 설정하세요.');
    const load = async () => {
    const searched = await boundedWorkspaceSearch({
      executable: ripgrepExecutable, root: workspace.root, relativePath: input.path,
      query: input.query, filesOnly: input.files_only, maxResults: input.max_results,
      maxOutputBytes: config.permissions.maxOutputBytes ?? 262_144,
      globs: workspaceSearchGlobs(), blockedNames: [...blockedNames],
      blockedExtensions: [...blockedExtensions], signal
    });
    return {
      ok: true,
      results: searched.results,
      truncated: searched.truncated,
      limit_reason: searched.limitReason,
      result_bytes: searched.acceptedBytes,
      search_events: searched.linesSeen,
      matched_candidates: searched.parsedCandidates
    };
    };
    return response(fastRead ? await fastRead.boundedQuery({
      leaseId: lease.leaseId, key: ['bounded-search', input], load, signal
    }) : await load());
  }));

  if (!personalReadFetch) server.registerTool('aicc_workspace_apply_patch', {
    title: '워크스페이스 패치 적용',
    description: '열린 워크스페이스 안에만 통합 diff를 사전 검사한 뒤 적용합니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_workspace_apply_patch,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, withLease('write', async (input, { workspace }) => response(runPatch(workspace.root, runtimeRoot, input.patch, config.permissions.network !== false))));

  if (!personalReadFetch && config.permissions.commands) server.registerTool('aicc_workspace_exec', {
    title: '워크스페이스 명령 실행',
    description: 'macOS 샌드박스에서 명령을 실행합니다. 읽기와 쓰기는 열린 워크스페이스 및 제한된 런타임 경로로 한정됩니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_workspace_exec,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, withLease('write', async (input, { workspace, lease }) => {
    if (!config.permissions.commands) throw new Error('이 AICC 구성에서는 명령 실행이 꺼져 있습니다.');
    return response(await startCommand(workspace.root, runtimeRoot, input.command, config, input.yield_time_ms, lease));
  }));

  if (!personalReadFetch && config.permissions.commands) server.registerTool('aicc_workspace_write_stdin', {
    title: '실행 중인 명령에 입력',
    description: 'aicc_workspace_exec가 반환한 현재 프로세스 세션에 입력하거나 출력을 폴링합니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_workspace_write_stdin,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, withLease('write', async (input, { lease }) => {
    const session = processSessions.get(input.session_id);
    if (!session) throw new Error('프로세스 세션을 찾지 못했습니다. 런타임 재시작 뒤에는 명령을 새로 실행해야 합니다.');
    if (session.remoteLeaseId !== lease.leaseId || session.workspaceId !== lease.workspaceId) throw new Error('프로세스 세션은 다른 remote lease에 속합니다.');
    if (input.chars) {
      if (!session.child || session.exitCode !== null || session.osExitObserved === true) throw new Error('프로세스가 이미 종료되었습니다.');
      session.child.stdin.write(input.chars);
    }
    return response(sessionResult(session, input.output_cursor));
  }));

  if (!personalReadFetch && config.permissions.commands) server.registerTool('aicc_workspace_process_stop', {
    title: '실행 중인 명령 중지',
    description: 'aicc_workspace_exec로 시작한 현재 프로세스 세션 하나에 SIGTERM을 보내고 종료를 요청합니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_workspace_process_stop,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, withLease('write', async (input, { lease }) => {
    const session = processSessions.get(input.session_id);
    if (!session) throw new Error('프로세스 세션을 찾지 못했습니다.');
    if (session.remoteLeaseId !== lease.leaseId || session.workspaceId !== lease.workspaceId) throw new Error('프로세스 세션은 다른 remote lease에 속합니다.');
    return response(processStopResult(session));
  }));

  server.registerTool('aicc_workspace_changes', {
    title: '워크스페이스 변경 검토',
    description: '현재 Git 변경 파일과 staged/unstaged 요약을 반환합니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_workspace_changes,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, withLease('read', async (input, { workspace }) => response(gitSummary(workspace.root, config.permissions.maxOutputBytes ?? 262_144))));

  server.registerTool('aicc_skill_inventory', {
    title: 'AICC 스킬 목록',
    description: 'AICC 정본에 등록된 스킬 이름과 설명을 반환합니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_skill_inventory,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, withLease('read', async () => response({ ok: true, skills: skillCatalog(config).map(({ id, description }) => ({ id, description })) })));

  server.registerTool('aicc_skill_read', {
    title: 'AICC 스킬 읽기',
    description: '처음에는 SKILL.md 전체를 읽고, 그 뒤에만 같은 스킬이 직접 참조한 파일을 읽습니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_skill_read,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, withLease('read', async (input, { lease }) => {
    const skill = skillCatalog(config).find(item => item.id === input.skill_id);
    if (!skill) throw new Error('등록된 AICC 스킬이 아닙니다.');
    const active = activatedSkills.get(lease.leaseId) ?? new Set();
    if (input.path !== 'SKILL.md' && !active.has(input.skill_id)) throw new Error('먼저 이 스킬의 SKILL.md 전체를 읽어야 합니다.');
    const file = confinedPath(skill.root, input.path);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > (config.permissions.maxReadBytes ?? 1_048_576)) throw new Error('스킬 파일을 읽을 수 없거나 제한보다 큽니다.');
    const text = fs.readFileSync(file, 'utf8');
    if (input.path === 'SKILL.md') active.add(input.skill_id);
    activatedSkills.set(lease.leaseId, active);
    return response({ ok: true, skill_id: input.skill_id, path: input.path, text });
  }));

  if (codexCli) {
    server.registerTool('aicc_codex_cli_start', {
      title: 'Native·OCX Codex CLI 작업 접수',
      description: '소유자가 고정한 Git 작업공간에서 선택한 Native 또는 OCX CLI만 실행합니다. route/model/effort와 UTF-8 prompt SHA를 명시합니다. 일반 exec 격리는 해제하지 않습니다. operation_id는 원 작업 ID이며 접수 실패·불명 시 새 ID 재전송이나 Native 대체를 하지 않습니다.',
      inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_codex_cli_start,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, withLease('write', async (input, { workspace, lease }) => response(await codexCli.start(workspace, input, lease)), { codexDispatch: true }));
    server.registerTool('aicc_codex_cli_status', {
      title: 'Codex CLI 원 작업 결과',
      description: '원 operation_id의 세션·작업 시작·완료·최종 응답을 구분해 회수합니다. DISPATCHING은 작업 시작 증거가 아니며 COMPLETED도 사용자 목표 전체 완료를 대신하지 않습니다. 불명 결과는 원 작업을 조정합니다.',
      inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_codex_cli_status,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, withLease('read', async (input, { workspace }) => response(codexCli.status(workspace, input.operation_id))));
  }
  if (gptQueue) {
    const common = {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
    server.registerTool('aicc_gpt_queue_register',{
      title:'원 소유자가 고정한 Chrome Queue 작업 일시중지 등록',
      description:'기존 native-host의 exact owner/임대/대화 증거와 요청 SHA를 확인한 뒤 PAUSED로만 등록합니다. 등록은 발신이 아닙니다. 불명 요청을 재송하지 마세요.',
      inputSchema:WORKSPACE_MCP_INPUT_SCHEMAS.aicc_gpt_queue_register,
      annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false}
    },withLease('write',async(input,{workspace})=>response(await gptQueue.registerPaused(workspace,input))));
    server.registerTool('aicc_gpt_queue_list',{
      title:'원 소유자 Chrome Queue 목록',
      description:'기존 원장에 저장된 해당 원 소유자 등록 작업만 조회합니다. 등록/발신/완료는 구분합니다.',
      inputSchema:WORKSPACE_MCP_INPUT_SCHEMAS.aicc_gpt_queue_list,annotations:common
    },withLease('read',async(input,{workspace})=>response(await gptQueue.list(workspace))));
    server.registerTool('aicc_gpt_queue_get',{
      title:'원 Chrome Queue 요청의 결과·상태 조회',
      description:'정확한 원 operation_id와 owner binding의 원장 상태·증거만 조회합니다. 전송/답변이 없으면 없다고 표시합니다.',
      inputSchema:WORKSPACE_MCP_INPUT_SCHEMAS.aicc_gpt_queue_get,annotations:common
    },withLease('read',async(input,{workspace})=>response(await gptQueue.get(workspace,input.operation_id))));
    server.registerTool('aicc_gpt_queue_cancel',{
      title:'발신 전 원 Chrome Queue 등록 작업 취소',
      description:'미접수·미발신인 PAUSED 원 작업만 원 native-host의 버전 CAS로 취소합니다. 원 target lease 반환이나 발신 취소를 주장하지 않습니다.',
      inputSchema:WORKSPACE_MCP_INPUT_SCHEMAS.aicc_gpt_queue_cancel,
      annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false}
    },withLease('write',async(input,{workspace})=>response(await gptQueue.cancel(workspace,input))));
    server.registerTool('aicc_gpt_queue_activate',{
      title:'원 소유자 Chrome Queue 작업 실행 승인',
      description:'원 요청·두 대상의 최신 소유 증거와 expected_revision이 일치할 때만 기존 확장의 실행을 승인합니다. 승인 접수는 실제 발신이나 완료가 아닙니다. 응답 불명은 원 operation_id로 조회하고 새 요청으로 재송하지 마세요.',
      inputSchema:WORKSPACE_MCP_INPUT_SCHEMAS.aicc_gpt_queue_activate,
      annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}
    },withLease('write',async(input,{workspace})=>response(await gptQueue.activate(workspace,input))));
  }
  if (!personalReadFetch && config.webManagement?.enabled === true) {
    const management = createWebManagementExecutor(config);
    server.registerTool('aicc_web_management_start', {
      title: '승인된 Web 자산 관리 실행',
      description: '소유자가 별도로 등록한 고정 관리기만 실행합니다. 등록 계정·허용 동작·원본 백업 검사를 지키며 임의 명령과 거절된 요청의 재실행은 허용하지 않습니다. 불명 결과는 재발신하지 않고 status로 대조합니다.',
      inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_web_management_start,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, withLease('write', async (input, { workspace }) => response(management.start(workspace, input))));
    server.registerTool('aicc_web_management_status', {
      title: 'Web 자산 관리 결과',
      description: '같은 등록 작업의 실행 상태와 실제 결과를 조회합니다. 프로세스 완료는 자산 변경 성공을 뜻하지 않습니다.',
      inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_web_management_status,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, withLease('read', async (input, { workspace }) => response(management.status(workspace, input.operation_id))));
  }
  registerLocalAccessTools(server, {
    resolveGrant: options.resolveLocalAccessGrant ?? (async () => null),
    resolveExcerptApproval: options.resolveLocalExcerptApproval ?? (async () => null),
    now: options.now,
    maximumTtlMs: options.localAccessMaximumTtlMs
  });

  return server;
}

async function main() {
  const { configPath } = parseArguments(process.argv.slice(2));
  const expectedConfigHash = createHash('sha256').update(fs.readFileSync(configPath)).digest('hex');
  const config = loadConfig(configPath);
  if (!config.remoteAuthority) throw new Error('Workspace MCP remote authority configuration is required');
  let marker = startWorkspaceRuntimeMarker(config, configPath, { expectedConfigHash });
  runtimeMarkerContext = { config, configPath, marker };
  try {
    const stateRoot = path.dirname(path.dirname(configPath));
    const localStdio = config.transport?.mode === 'local-stdio';
    const runtimeRoot = workspaceRuntimeMarkerRoot(config, configPath, { previous: marker });
    const durableStore = new DurableJobStore({ root: path.join(stateRoot, 'jobs'), create: false });
    const readSessionStore = new DurableJobStore({
      root: localStdio ? path.join(runtimeRoot, 'read-sessions')
        : path.join(stateRoot, 'read-sessions', normalizeWorkspaceSurfaceProfile(config.surfaceProfile))
    });
    const writerAuthorizer = new DurableRemoteWriterAuthorizer({
      store: durableStore,
      bootstrapLeaseDurationMs: Math.max(1, Math.min(7200, config.remoteAuthority?.writeExpirySeconds ?? 7200)) * 1000
    });
    const fastReadCoordinator = new WorkspaceFastReadCoordinator({
      allowedRoots: config.workspaces.map(item => item.root),
      stateRoot: path.join(localStdio ? runtimeRoot : stateRoot, 'workspace-snapshots'),
      toolSchemaHash: workspaceToolSnapshot({
        surfaceProfile: config.surfaceProfile,
        commandSandboxAvailable: workspaceCommandSandboxAvailable(config),
        webManagementAvailable: config.webManagement?.enabled === true,
        codexCliAvailable: config.codexCli?.enabled === true,
        gptQueueAvailable: config.gptQueue?.enabled === true
      }).hash
    });
    const localAccessStore = new LocalAccessGrantStore({ stateRoot });
    const server = createWorkspaceMcpServer(config, {
      configPath,
      runtimeRoot,
      durableStore: localStdio && config.surfaceProfile === WORKSPACE_SURFACE_PROFILES.PERSONAL_READ_FETCH ? null : durableStore,
      readSessionStore,
      writerAuthorizer,
      fastReadCoordinator,
      resolveLocalAccessGrant: grantRef => localAccessStore.resolveGrant(grantRef),
      resolveLocalExcerptApproval: input => localAccessStore.resolveExcerptApproval(input)
    });
    const transport = new StdioServerTransport();
    server.server.onclose = shutdown;
    process.stdin.once('end', () => { void server.close().catch(shutdown); });
    await server.connect(transport);
    marker = writeAuthorityMarker(config, configPath, {
      phase: 'ready',
      previous: marker,
      transportConnected: true
    });
    runtimeMarkerContext.marker = marker;
    runtimeMarkerHeartbeat = setInterval(() => {
      try {
        marker = writeAuthorityMarker(config, configPath, {
          phase: 'ready',
          previous: marker,
          transportConnected: true,
          readySignalId: marker.transport.readySignalId
        });
        runtimeMarkerContext.marker = marker;
      } catch (error) {
        console.error(`[aicc-workspace-mcp] marker heartbeat failed: ${error.message}`);
      }
    }, 15_000);
    runtimeMarkerHeartbeat.unref();
    console.error(`[aicc-workspace-mcp] ready workspaces=${config.workspaces.length}`);
  } catch (error) {
    try {
      marker = writeAuthorityMarker(config, configPath, {
        phase: 'failed',
        previous: marker,
        failureCode: 'stdio_start_failed'
      });
      runtimeMarkerContext.marker = marker;
    } catch { /* preserve the original transport failure */ }
    throw error;
  }
}

function shutdown() {
  if (runtimeMarkerHeartbeat) clearInterval(runtimeMarkerHeartbeat);
  runtimeMarkerHeartbeat = null;
  if (runtimeMarkerContext?.marker) {
    try {
      runtimeMarkerContext.marker = writeAuthorityMarker(
        runtimeMarkerContext.config,
        runtimeMarkerContext.configPath,
        { phase: 'stopped', previous: runtimeMarkerContext.marker }
      );
    } catch (error) {
      console.error(`[aicc-workspace-mcp] marker shutdown failed: ${error.message}`);
    }
  }
  for (const executor of codexCliExecutors) executor.stopLease(null);
  for (const session of processSessions.values()) {
    if (session.child && session.exitCode === null) stopProcessSession(session, 'server_shutdown');
  }
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(`[aicc-workspace-mcp] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}

export const __testing = {
  workspaceId, validatePatchPaths, ensurePatchParents, runPatch, safeError, sandboxInvocation, gitSummary, blockedNames, componentRoot, writeAuthorityMarker,
  bindProcessSession, processStopResult, boundedRipgrep, workspaceSearchGlobs,
  processSession: id => {
    const session = processSessions.get(id);
    return session ? sessionResult(session) : null;
  }
};
