import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { workspacePublicationStatus } from './workspace-publish.mjs';
import {
  inspectWorkspaceRuntimeMarker,
  processStartTokens,
  workspaceRuntimeStartGuard,
  workspaceRuntimeExpectedIdentity
} from '../components/workspace-mcp/runtime-marker.mjs';
import {
  normalizeWorkspaceSurfaceProfile,
  WORKSPACE_SURFACE_PROFILES,
  workspaceExecutionBoundaryForHost,
  workspaceHostCapabilities,
  workspaceCommandSandboxAvailable,
  workspacePermissionsForHost
} from '../components/workspace-mcp/tool-manifest.mjs';

const ignoredDirectories = new Set([
  '.git', '.next', '.cache', '.venv', 'node_modules', 'dist', 'build', 'coverage',
  'Library', 'backups', 'quickshare'
]);

const excludedOwnerContentDirectories = new Set(['Library']);

export const workspaceMcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function realDirectory(candidate) {
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return fs.realpathSync(candidate);
  } catch { return null; }
}

export function discoverGitWorkspaces(baseRoot, options = {}) {
  const root = realDirectory(baseRoot);
  if (!root) throw new Error(`워크스페이스 검색 루트를 찾지 못했습니다: ${baseRoot}`);
  const maxDepth = options.maxDepth ?? 8;
  const workspaces = [];
  const visit = (directory, depth) => {
    if (fs.existsSync(path.join(directory, '.git'))) workspaces.push(directory);
    if (depth >= maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || ignoredDirectories.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.openai') continue;
      visit(path.join(directory, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  return [...new Set(workspaces.map(item => fs.realpathSync(item)))].sort();
}

export function discoverOwnerContentRoots(ownerHome = os.homedir()) {
  const home = realDirectory(ownerHome);
  if (!home) throw new Error(`소유자 홈을 찾지 못했습니다: ${ownerHome}`);
  return fs.readdirSync(home, { withFileTypes: true })
    .filter(entry => (
      entry.isDirectory()
      && !entry.isSymbolicLink()
      && !entry.name.startsWith('.')
      && !excludedOwnerContentDirectories.has(entry.name)
    ))
    .map(entry => realDirectory(path.join(home, entry.name)))
    .filter(Boolean)
    .sort();
}

function remoteAuthorityConfig(projectsRoot, ownerUnrestrictedWrite = false, surfaceProfile = WORKSPACE_SURFACE_PROFILES.BUSINESS_FULL) {
  if (surfaceProfile === WORKSPACE_SURFACE_PROFILES.PERSONAL_READ_FETCH) {
    return {
      identityBinding: `remote_${createHash('sha256').update(`aicc-workspace\0${surfaceProfile}\0${projectsRoot}`).digest('hex').slice(0, 24)}`,
      authenticationOwner: 'secure-mcp-tunnel',
      defaultMode: 'read-only',
      writePolicy: 'read-only',
      writeRequires: [],
      readExpirySeconds: 7200,
      writeExpirySeconds: 0
    };
  }
  return {
    identityBinding: `remote_${createHash('sha256').update(`aicc-workspace\0${projectsRoot}`).digest('hex').slice(0, 24)}`,
    authenticationOwner: 'secure-mcp-tunnel',
    defaultMode: ownerUnrestrictedWrite ? 'write' : 'read-only',
    writePolicy: ownerUnrestrictedWrite ? 'owner-unrestricted' : 'guarded',
    writeRequires: ownerUnrestrictedWrite
      ? ['authenticated-owner', 'single-writer-lease', 'unique-request-id']
      : ['approval-ref', 'durable-job-id', 'durable-attempt-id', 'single-writer-lease', 'unique-request-id'],
    readExpirySeconds: 7200,
    writeExpirySeconds: 7200
  };
}

export function workspaceMcpPaths(options = {}) {
  const stateRoot = options.stateRoot
    ?? process.env.AICC_STATE_ROOT?.trim()
    ?? path.join(os.homedir(), '.ai-control-center');
  const surfaceProfile = normalizeWorkspaceSurfaceProfile(options.surfaceProfile);
  const directory = options.local === true
    ? surfaceProfile === WORKSPACE_SURFACE_PROFILES.PERSONAL_READ_FETCH ? 'workspace-mcp-codex' : 'workspace-mcp-codex-business-full'
    : surfaceProfile === WORKSPACE_SURFACE_PROFILES.BUSINESS_FULL
    ? 'workspace-mcp'
    : `workspace-mcp-${surfaceProfile}`;
  const root = path.join(stateRoot, directory);
  return {
    root,
    config: path.join(root, 'config.json'),
    registry: path.join(root, 'workspace-registry.json'),
    logs: path.join(root, 'logs'),
    backups: path.join(root, 'backups'),
    runtime: path.join(root, 'runtime')
  };
}

export function workspaceMcpRuntimeExecutable(config, options = {}) {
  const paths = workspaceMcpPaths(options);
  const runtimeAlias = config?.transport?.runtimeAlias;
  if (typeof runtimeAlias !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(runtimeAlias)) return null;
  const profile = path.join(paths.root, 'tunnel', 'profiles', `${runtimeAlias}.yaml`);
  let parsed;
  try {
    const stat = fs.lstatSync(profile);
    // POSIX mode bits are not an ownership signal on NTFS.  Windows ACLs are
    // authoritative there, so only enforce the private-file mode check on
    // platforms that expose meaningful Unix permission bits.
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o022) !== 0)) return null;
    parsed = JSON.parse(fs.readFileSync(profile, 'utf8'));
  } catch { return null; }
  const command = parsed?.mcp?.commands?.find(item => item?.channel === 'main')?.command;
  if (typeof command !== 'string') return null;
  // Keep backslashes inside a quoted Windows executable path.  The previous
  // POSIX-only expression rejected `C:\\...\\node.exe` before the path could
  // be canonicalised and verified below.
  const quoted = command.match(/^\s*"([^"]+)"(?:\s|$)/);
  const unquoted = command.match(/^\s*([^\s"']+)(?:\s|$)/);
  const executable = quoted?.[1] ?? unquoted?.[1] ?? null;
  if (!executable || !path.isAbsolute(executable)) return null;
  try {
    const real = fs.realpathSync.native(executable);
    const stat = fs.lstatSync(real);
    return stat.isFile() && !stat.isSymbolicLink() ? real : null;
  } catch { return null; }
}

function workspaceRuntimeIdentityOptions(executable, options = {}) {
  if (options.runtimeIdentityOptions) return { ...options.runtimeIdentityOptions, execPath: executable };
  const inspected = spawnSync(executable, ['-p', 'JSON.stringify({nodeVersion:process.version,versions:{modules:process.versions.modules,v8:process.versions.v8}})'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '' }
  });
  if (inspected.error || inspected.status !== 0) throw new Error('Workspace runtime Node identity could not be inspected');
  const descriptor = JSON.parse(String(inspected.stdout ?? '').trim());
  if (typeof descriptor?.nodeVersion !== 'string'
    || typeof descriptor?.versions?.modules !== 'string'
    || typeof descriptor?.versions?.v8 !== 'string') {
    throw new Error('Workspace runtime Node identity descriptor is invalid');
  }
  return { execPath: executable, nodeVersion: descriptor.nodeVersion, versions: descriptor.versions, execArgv: [] };
}

function stableAlias(root, projectsRoot, used) {
  const relationship = path.relative(projectsRoot, root);
  const insideProjectsRoot = relationship === '' || (!relationship.startsWith('..') && !path.isAbsolute(relationship));
  const relative = insideProjectsRoot ? relationship.split(path.sep).filter(Boolean) : [path.basename(root)];
  const normalizedBase = (relative.at(-1) || path.basename(root))
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = !normalizedBase || /^\.+$/.test(normalizedBase) ? 'workspace' : normalizedBase;
  let alias = base;
  if (used.has(alias)) {
    const group = relative.slice(-2, -1)[0]?.normalize('NFKC').toLocaleLowerCase('en-US')
      .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    alias = group ? `${group}-${base}` : base;
  }
  if (used.has(alias)) alias = `${alias}-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`;
  used.add(alias);
  return alias;
}

export function buildWorkspaceMcpConfig(options = {}) {
  const surfaceProfile = normalizeWorkspaceSurfaceProfile(options.surfaceProfile);
  const personalReadFetch = surfaceProfile === WORKSPACE_SURFACE_PROFILES.PERSONAL_READ_FETCH;
  if (personalReadFetch && options.unrestrictedLocalAccess === true) {
    throw new Error('unrestricted local access는 Business full profile에서만 사용할 수 있습니다.');
  }
  const projectsRoot = fs.realpathSync(options.projectsRoot ?? process.env.AICC_WORKSPACE_PROJECTS_ROOT?.trim() ?? path.join(os.homedir(), 'dev', 'projects'));
  const machineRoot = fs.realpathSync(path.parse(projectsRoot).root);
  const discoveredRoots = options.allowedRoots ?? discoverGitWorkspaces(projectsRoot);
  const ownerContentRoots = options.includeOwnerContentRoots === true
    ? discoverOwnerContentRoots(options.ownerHome ?? os.homedir())
    : [];
  const allowedRoots = [...new Set([
    ...(options.unrestrictedLocalAccess === true ? [machineRoot] : []),
    ...(options.includeProjectsRoot === true ? [projectsRoot] : []),
    ...ownerContentRoots,
    ...discoveredRoots
  ].map(root => fs.realpathSync(root)))];
  if (!allowedRoots.length) throw new Error('등록할 Git 워크스페이스가 없습니다.');
  const used = new Set();
  const workspaces = allowedRoots.map(root => {
    if (options.unrestrictedLocalAccess === true && root === machineRoot) {
      used.add('local-machine');
      return { alias: 'local-machine', label: 'Local Machine', root };
    }
    return { alias: stableAlias(root, projectsRoot, used), label: path.basename(root), root };
  });
  const preferredDefault = options.defaultRoot ? fs.realpathSync(options.defaultRoot) : null;
  const defaultWorkspace = workspaces.find(item => item.root === preferredDefault)?.alias
    ?? (options.unrestrictedLocalAccess === true ? 'local-machine' : null)
    ?? workspaces.find(item => item.label === 'AICC')?.alias
    ?? workspaces[0].alias;
  const platform = options.platform ?? process.platform;
  const unrestrictedWindowsCommands = platform === 'win32' && options.unrestrictedWindowsCommands === true;
  const requestedPermissions = {
    files: personalReadFetch ? 'read-only' : 'read-write',
    commands: !personalReadFetch,
    network: personalReadFetch ? false : options.network !== false,
    maxReadBytes: Number(options.maxReadBytes ?? 1_048_576),
    maxOutputBytes: Number(options.maxOutputBytes ?? 262_144),
    commandTimeoutMs: Number(options.commandTimeoutMs ?? 7_200_000),
    ...(unrestrictedWindowsCommands ? { commandIsolation: 'owner-unrestricted-windows' } : {})
  };
  const permissions = workspacePermissionsForHost(requestedPermissions, {
    surfaceProfile,
    platform,
    commandSandboxAvailable: workspaceCommandSandboxAvailable({ permissions: requestedPermissions }, {
      platform,
      commandSandboxAvailable: options.commandSandboxAvailable
    })
  });
  const scopedFiles = options.unrestrictedLocalAccess === true
    ? 'local-machine-files'
    : options.includeOwnerContentRoots === true
      ? 'owner-content-files'
      : 'workspace-files';
  const externalWorkspaceTools = personalReadFetch
    ? 'workspace-and-owner-content-read-fetch-and-aicc-skills'
    : `${scopedFiles}${permissions.commands ? '-terminal' : ''}${options.unrestrictedLocalAccess === true && permissions.network ? '-network' : ''}-and-aicc-skills`;
  return {
    schemaVersion: 2,
    surfaceProfile,
    generatedAt: new Date().toISOString(),
    projectsRoot,
    defaultWorkspace,
    workspaces,
    permissions,
    transport: {
      mode: 'secure-mcp-tunnel',
      runtimeAlias: personalReadFetch ? 'aicc-workspace-personal-read-fetch' : 'aicc-workspace'
    },
    remoteAuthority: remoteAuthorityConfig(projectsRoot, options.ownerUnrestrictedWrite === true, surfaceProfile),
    skillRoots: [path.join(options.ownerHome ?? options.home ?? os.homedir(), '.agents', 'skills')],
    executionBoundary: {
      modelInference: 'external-chatgpt-conversation',
      codexTaskDelegation: false,
      desktopBrowserAndComputerUse: 'codex-web-gpt-full-harness-only',
      externalWorkspaceTools,
      excludedOwnerState: ['hidden-home-directories', 'Library']
    }
  };
}

function atomicJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, mode);
}

export function configureWorkspaceMcp(options = {}) {
  const paths = workspaceMcpPaths(options);
  const config = buildWorkspaceMcpConfig(options);
  if (fs.existsSync(paths.config)) {
    fs.mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    fs.copyFileSync(paths.config, path.join(paths.backups, `config.${stamp}.json`));
  }
  atomicJson(paths.config, config);
  return { ok: true, configPath: paths.config, workspaceCount: config.workspaces.length, config };
}

export function localWorkspaceProtection(directory, options = {}) {
  if (!realDirectory(directory)) throw new Error('Local state directory must be a real directory');
  if ((options.platform ?? process.platform) !== 'win32') {
    if (options.apply) fs.chmodSync(directory, 0o700);
    if ((fs.statSync(directory).mode & 0o077) !== 0) throw new Error('Local workspace owner-only mode is required');
    return;
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User",
    "function Test-PrivateRoot($acl){if(-not $acl.AreAccessRulesProtected -or $acl.Access.Count -eq 0 -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value){return $false}; $ownerFull=$false; foreach($rule in $acl.Access){$sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; if($rule.AccessControlType -eq 'Allow'){if($sid -notin @($owner.Value,'S-1-5-18')){return $false}; if($sid -eq $owner.Value -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl){$ownerFull=$true}}}; return $ownerFull}",
    '$acl=Get-Acl -LiteralPath $env:AICC_LOCAL_WORKSPACE_ROOT',
    'if(Test-PrivateRoot $acl){exit 0}',
    "if($env:AICC_LOCAL_WORKSPACE_PROTECT -ne '1' -or $acl.AreAccessRulesProtected){exit 12}",
    '$acl.SetOwner($owner); $acl.SetAccessRuleProtection($true,$false)',
    'foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}',
    "foreach($sid in @($owner,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}",
    'Set-Acl -LiteralPath $env:AICC_LOCAL_WORKSPACE_ROOT -AclObject $acl',
    'if(-not (Test-PrivateRoot (Get-Acl -LiteralPath $env:AICC_LOCAL_WORKSPACE_ROOT))){exit 13}'
  ].join(';');
  const result = (options.spawnSync ?? spawnSync)('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...process.env, AICC_LOCAL_WORKSPACE_ROOT: directory, AICC_LOCAL_WORKSPACE_PROTECT: options.apply ? '1' : '0' }
  });
  if (result.status !== 0) throw new Error('Local workspace owner-only Windows ACL validation failed');
}

export async function configureLocalWorkspaceMcp(options = {}) {
  const surfaceProfile = normalizeWorkspaceSurfaceProfile(options.surfaceProfile);
  const sourceSurface = normalizeWorkspaceSurfaceProfile(options.sourceSurface ?? WORKSPACE_SURFACE_PROFILES.PERSONAL_READ_FETCH);
  const sourcePaths = workspaceMcpPaths({ ...options, local: false, surfaceProfile: sourceSurface });
  const paths = workspaceMcpPaths({ ...options, local: true, surfaceProfile });
  const { loadConfig } = await import('../components/workspace-mcp/server.mjs');
  const source = loadConfig(sourcePaths.config);
  if (source.surfaceProfile !== sourceSurface) throw new Error('Source config surface mismatch');
  const aliases = options.aliases ?? [];
  if (new Set(aliases).size !== aliases.length) throw new Error('Duplicate workspace alias');
  const write = surfaceProfile === WORKSPACE_SURFACE_PROFILES.BUSINESS_FULL;
  if (write && !aliases.length) throw new Error('Guarded local write requires explicit --alias selections');
  const workspaces = aliases.length ? aliases.map(alias => {
    const workspace = source.workspaces.find(item => item.alias === alias);
    if (!workspace) throw new Error('Selected alias is not registered in the source surface');
    return workspace;
  }) : source.workspaces;
  if (write) {
    for (const workspace of workspaces) {
      const git = (options.spawnSync ?? spawnSync)('git', ['-C', workspace.root, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8', timeout: 5_000, windowsHide: true
      });
      if (git.status !== 0 || realDirectory(String(git.stdout).trim()) !== realDirectory(workspace.root)) {
        throw new Error('Guarded local write requires exact Git roots, not parent directories');
      }
    }
  }
  const permissions = { ...source.permissions, files: write ? 'read-write' : 'read-only', commands: false, network: false };
  const config = {
    ...source,
    managedBy: 'aicc-workspace-local-stdio-v1',
    surfaceProfile,
    workspaces,
    defaultWorkspace: workspaces.find(item => item.alias === source.defaultWorkspace)?.alias ?? workspaces[0].alias,
    permissions,
    transport: { mode: 'local-stdio', runtimeAlias: write ? 'aicc-workspace-codex-business-full' : 'aicc-workspace-codex' },
    remoteAuthority: {
      ...remoteAuthorityConfig(paths.root, false, surfaceProfile),
      identityBinding: `local_${createHash('sha256').update(`codex-stdio\0${surfaceProfile}\0${paths.root}`).digest('hex').slice(0, 24)}`,
      authenticationOwner: 'codex-local-stdio'
    },
    executionBoundary: {
      ...workspaceExecutionBoundaryForHost(source.executionBoundary, permissions),
      modelInference: 'local-codex-client',
      externalWorkspaceTools: write ? 'guarded-workspace-files-and-aicc-skills' : 'workspace-read-fetch-and-aicc-skills'
    }
  };
  const bytes = `${JSON.stringify(config, null, 2)}\n`;
  for (const directory of [paths.root, paths.runtime, paths.backups]) {
    if (fs.existsSync(directory) && !realDirectory(directory)) throw new Error('Local state directory must not be a symlink or non-directory');
  }
  const exists = fs.existsSync(paths.config);
  let beforeBytes = null;
  let duplicate = false;
  if (exists) {
    const current = loadConfig(paths.config);
    beforeBytes = fs.readFileSync(paths.config, 'utf8');
    if (current.managedBy !== config.managedBy || current.transport?.mode !== 'local-stdio') {
      throw new Error('Local config is not owned by the local STDIO installer');
    }
    duplicate = beforeBytes === bytes;
    if (!duplicate && !options.repair && !options.dryRun) throw new Error('Local config differs; review --dry-run then use --repair');
  }
  const guard = workspaceRuntimeStartGuard(paths.config);
  const result = {
    ok: true, dryRun: options.dryRun === true, duplicate, surfaceProfile,
    configPath: paths.config, workspaceCount: workspaces.length, transport: 'local-stdio',
    writePolicy: config.remoteAuthority.writePolicy, startGuard: guard, listenerPorts: [],
    command: workspaceMcpCommand(config, { configPath: paths.config })
  };
  if (options.dryRun) return result;
  if (duplicate) {
    localWorkspaceProtection(paths.root, options);
    return result;
  }
  if (!guard.allowed) throw new Error(`Local config mutation refused: ${guard.reason}`);
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const lock = path.join(paths.root, 'runtime', 'startup.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(lock, 'wx', 0o600);
  let backupPath = null;
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
    const lockedGuard = workspaceRuntimeStartGuard(paths.config, { ignoreStartupLock: true });
    if (!lockedGuard.allowed) throw new Error(`Local config mutation refused: ${lockedGuard.reason}`);
    const currentBytes = fs.existsSync(paths.config) ? fs.readFileSync(paths.config, 'utf8') : null;
    if (currentBytes !== beforeBytes) throw new Error('Local config changed after preview');
    localWorkspaceProtection(paths.root, { ...options, apply: true });
    if (exists) {
      fs.mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
      backupPath = path.join(paths.backups, `config.${Date.now()}.${process.pid}.json`);
      fs.copyFileSync(paths.config, backupPath, fs.constants.COPYFILE_EXCL);
    }
    atomicJson(paths.config, config);
    try { loadConfig(paths.config); }
    catch (error) {
      if (beforeBytes === null) fs.unlinkSync(paths.config);
      else atomicJson(paths.config, JSON.parse(beforeBytes));
      throw error;
    }
    return { ...result, backupPath };
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lock);
  }
}

export function migrateWorkspaceMcpRemoteAuthority(options = {}) {
  const paths = workspaceMcpPaths(options);
  const current = readWorkspaceMcpConfig(options);
  if (!current) throw new Error('먼저 Workspace MCP 설정을 구성해야 합니다.');
  const ownerUnrestrictedWrite = options.ownerUnrestrictedWrite
    ?? current.remoteAuthority?.writePolicy === 'owner-unrestricted';
  const surfaceProfile = normalizeWorkspaceSurfaceProfile(current.surfaceProfile ?? options.surfaceProfile);
  const expected = remoteAuthorityConfig(current.projectsRoot, ownerUnrestrictedWrite, surfaceProfile);
  const currentHash = createHash('sha256').update(fs.readFileSync(paths.config)).digest('hex');
  if (JSON.stringify(current.remoteAuthority ?? null) === JSON.stringify(expected)) {
    return { ok: true, duplicate: true, configPath: paths.config, beforeHash: currentHash, afterHash: currentHash, remoteAuthority: expected };
  }
  fs.mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const backupPath = path.join(paths.backups, `config.pre-remote-authority.${stamp}.json`);
  fs.copyFileSync(paths.config, backupPath);
  if (process.platform !== 'win32') fs.chmodSync(backupPath, 0o600);
  const migrated = { ...current, remoteAuthority: expected };
  atomicJson(paths.config, migrated);
  const afterHash = createHash('sha256').update(fs.readFileSync(paths.config)).digest('hex');
  return { ok: true, duplicate: false, configPath: paths.config, backupPath, beforeHash: currentHash, afterHash, workspaceCount: migrated.workspaces.length, remoteAuthority: expected };
}

export function reconcileWorkspaceMcpRoots(options = {}) {
  const paths = workspaceMcpPaths(options);
  if (!readWorkspaceMcpConfig(options)) throw new Error('먼저 Workspace MCP 설정을 구성해야 합니다.');
  // Validate through the reader, but persist the owner's original settings.
  // Host capability normalization belongs to reads, not a roots-only edit.
  const current = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  const retained = [];
  const removed = [];
  const seen = new Set();
  for (const workspace of current.workspaces) {
    const real = realDirectory(workspace.root);
    if (!real) {
      removed.push({ alias: workspace.alias, root: workspace.root, reason: 'missing' });
      continue;
    }
    if (seen.has(real)) {
      removed.push({ alias: workspace.alias, root: workspace.root, reason: 'duplicate-realpath' });
      continue;
    }
    seen.add(real);
    retained.push(real === workspace.root ? workspace : { ...workspace, root: real });
  }
  if (retained.length < 1) throw new Error('Workspace root reconciliation would remove every registered workspace.');
  const normalized = {
    ...current,
    generatedAt: new Date().toISOString(),
    defaultWorkspace: retained.some(item => item.alias === current.defaultWorkspace)
      ? current.defaultWorkspace
      : retained[0].alias,
    workspaces: retained
  };
  const beforeHash = createHash('sha256').update(fs.readFileSync(paths.config)).digest('hex');
  if (removed.length === 0 && JSON.stringify(normalized.workspaces) === JSON.stringify(current.workspaces)) {
    return { ok: true, dryRun: Boolean(options.dryRun), duplicate: true, configPath: paths.config, beforeHash, afterHash: beforeHash, removed, workspaceCount: retained.length };
  }
  if (options.dryRun) {
    return { ok: true, dryRun: true, duplicate: false, configPath: paths.config, beforeHash, afterHash: null, removed, workspaceCount: retained.length };
  }
  fs.mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const backupPath = path.join(paths.backups, `config.pre-root-reconcile.${stamp}.json`);
  fs.copyFileSync(paths.config, backupPath, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') fs.chmodSync(backupPath, 0o600);
  atomicJson(paths.config, normalized);
  const afterHash = createHash('sha256').update(fs.readFileSync(paths.config)).digest('hex');
  return { ok: true, dryRun: false, duplicate: false, configPath: paths.config, backupPath, beforeHash, afterHash, removed, workspaceCount: retained.length };
}

export function readWorkspaceMcpConfig(options = {}) {
  const paths = workspaceMcpPaths(options);
  if (!fs.existsSync(paths.config)) return null;
  const parsed = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.workspaces)) {
    throw new Error('Workspace MCP 설정 형식이 올바르지 않습니다. 다시 구성해야 합니다.');
  }
  parsed.surfaceProfile = normalizeWorkspaceSurfaceProfile(parsed.surfaceProfile ?? options.surfaceProfile);
  if (parsed.surfaceProfile !== normalizeWorkspaceSurfaceProfile(options.surfaceProfile)) {
    throw new Error('Workspace MCP config surface does not match the selected surface');
  }
  parsed.permissions = workspacePermissionsForHost(parsed.permissions, {
    surfaceProfile: parsed.surfaceProfile,
    platform: options.platform,
    commandSandboxAvailable: workspaceCommandSandboxAvailable(parsed, options)
  });
  parsed.executionBoundary = workspaceExecutionBoundaryForHost(parsed.executionBoundary, parsed.permissions);
  return parsed;
}

export function workspaceMcpCommand(config, options = {}) {
  const node = options.nodeExecutable ?? process.execPath;
  const server = options.serverPath ?? path.join(workspaceMcpRoot, 'components', 'workspace-mcp', 'server.mjs');
  return { executable: node, args: [server, '--config', options.configPath ?? workspaceMcpPaths(options).config], cwd: workspaceMcpRoot };
}

export async function workspaceMcpDoctor(options = {}) {
  const surfaceProfile = normalizeWorkspaceSurfaceProfile(options.surfaceProfile);
  const paths = workspaceMcpPaths({ ...options, surfaceProfile });
  const checks = [];
  let config;
  const check = async (name, probe) => {
    try {
      await probe();
      checks.push({ name, ok: true });
    } catch {
      checks.push({ name, ok: false });
    }
  };
  await check('configuration', async () => {
    const { loadConfig } = await import('../components/workspace-mcp/server.mjs');
    config = loadConfig(paths.config, options);
    if (config.surfaceProfile !== surfaceProfile) throw new Error('surface mismatch');
  });
  await check('authority', () => {
    if (!config?.remoteAuthority?.identityBinding
      || !['read-only', 'guarded'].includes(config.remoteAuthority.writePolicy)
      || (surfaceProfile === WORKSPACE_SURFACE_PROFILES.PERSONAL_READ_FETCH
        && (config.permissions.files !== 'read-only' || config.remoteAuthority.writePolicy !== 'read-only'))) {
      throw new Error('guarded authority required');
    }
  });
  if (options.local) {
    await check('local_transport', () => {
      if (config?.transport?.mode !== 'local-stdio' || config.remoteAuthority?.authenticationOwner !== 'codex-local-stdio') {
        throw new Error('Local transport identity is required');
      }
    });
    await check('owner_only_storage', () => localWorkspaceProtection(paths.root, options));
  }
  await check('runtime_dependencies', () => {
    if (!config) throw new Error('configuration unavailable');
    workspaceRuntimeExpectedIdentity(config, paths.config, options.runtimeIdentityOptions);
  });
  await check('ripgrep', async () => {
    const { resolveRipgrepExecutable } = await import('../components/workspace-mcp/server.mjs');
    resolveRipgrepExecutable(options.ripgrepOptions);
  });
  await check('process_identity', () => {
    const tokens = options.readProcessStartToken ? null : processStartTokens([process.pid, process.ppid], options);
    const readToken = options.readProcessStartToken ?? (pid => tokens.get(pid));
    if (!readToken(process.pid) || !readToken(process.ppid)) throw new Error('process identity unavailable');
  });
  const repairGuard = workspaceRuntimeStartGuard(paths.config, { ...options, allowLocalInstances: false });
  const startGuard = workspaceRuntimeStartGuard(paths.config, { ...options, allowLocalInstances: config?.transport?.mode === 'local-stdio' });
  const ok = checks.every(item => item.ok);
  return {
    ok,
    transport: 'stdio',
    surfaceProfile,
    workspaceCount: config?.workspaces?.length ?? 0,
    checks,
    startGuard,
    repairGuard,
    canStart: ok && startGuard.allowed,
    liveCallVerified: false,
    tunnelRequired: false,
    listenerPorts: []
  };
}

async function probeLoopbackTunnel(baseUrl, options = {}) {
  let endpoint;
  try { endpoint = new URL(baseUrl); }
  catch { return { healthy: false, ready: false, reason: 'health URL invalid' }; }
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '::1', 'localhost'].includes(endpoint.hostname)) {
    return { healthy: false, ready: false, reason: 'health URL must be loopback HTTP' };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const probe = async suffix => {
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${suffix}`, {
        signal: (options.abortSignalFactory ?? AbortSignal.timeout)(options.timeoutMs ?? 2_000)
      });
      return response.ok === true;
    } catch { return false; }
  };
  const [healthy, ready] = await Promise.all([probe('/healthz'), probe('/readyz')]);
  return { healthy, ready, reason: ready ? null : '터널 준비 안 됨' };
}

function tunnelProcessAlive(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (options.processAlive) return options.processAlive(pid) === true;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function readTunnelPid(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

export async function probeWorkspaceTunnel(options = {}) {
  const platform = options.platform ?? process.platform;
  const surfaceProfile = normalizeWorkspaceSurfaceProfile(options.surfaceProfile);
  const personalReadFetch = surfaceProfile === WORKSPACE_SURFACE_PROFILES.PERSONAL_READ_FETCH;
  const runtimeAlias = personalReadFetch ? 'aicc-workspace-personal-read-fetch' : 'aicc-workspace';
  const spawnProcess = options.spawnSync ?? spawnSync;
  if (platform === 'win32') {
    const taskName = personalReadFetch
      ? 'AgenticLab-AICC-Workspace-Personal-Tunnel'
      : 'AgenticLab-AICC-Workspace-Tunnel';
    const registered = spawnProcess('schtasks.exe', ['/Query', '/TN', taskName], {
      encoding: 'utf8', timeout: 3_000, windowsHide: true
    }).status === 0;
    const root = workspaceMcpPaths({ ...options, surfaceProfile }).root;
    const runtimeRoot = path.join(root, 'tunnel', 'runtime');
    const healthFile = options.healthFile ?? path.join(runtimeRoot, 'health', `${runtimeAlias}.url`);
    const pid = readTunnelPid(options.pidFile ?? path.join(runtimeRoot, `${runtimeAlias}.pid`));
    const pidAlive = tunnelProcessAlive(pid, options);
    if (!registered) {
      return { registered: false, running: false, healthy: false, ready: false, reason: 'Windows 예약 작업 없음', supervisorPid: null, supervisorLabel: taskName };
    }
    if (!fs.existsSync(healthFile)) {
      return { registered: true, running: pidAlive, healthy: false, ready: false, reason: pidAlive ? 'health URL 없음' : 'Windows 예약 작업 프로세스 중지', supervisorPid: pidAlive ? pid : null, supervisorLabel: taskName };
    }
    const baseUrl = fs.readFileSync(healthFile, 'utf8').trim();
    const health = await probeLoopbackTunnel(baseUrl, options);
    const running = pidAlive || health.healthy || health.ready;
    return {
      registered: true,
      running,
      healthy: health.healthy,
      ready: health.ready,
      reason: running ? health.reason : 'Windows 예약 작업 프로세스 중지',
      supervisorPid: pidAlive ? pid : null,
      supervisorLabel: taskName
    };
  }
  if (platform !== 'darwin') return { running: false, healthy: false, ready: false, reason: '지원하지 않는 자동 시작 플랫폼' };
  const label = personalReadFetch
    ? 'com.agenticlab.aicc-workspace-personal-read-fetch-tunnel'
    : 'com.agenticlab.aicc-workspace-tunnel';
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const printed = uid === null ? { status: 1 } : spawnProcess('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8', timeout: 3_000 });
  const running = printed.status === 0 && /\bstate = running\b/.test(printed.stdout ?? '');
  const supervisorPidMatch = String(printed.stdout ?? '').match(/^\s*pid = (\d+)\s*$/m);
  const supervisorPid = running && supervisorPidMatch ? Number(supervisorPidMatch[1]) : null;
  const healthFile = options.healthFile ?? path.join(options.home ?? os.homedir(), 'Library', 'Application Support', 'tunnel-client', 'health', `${runtimeAlias}.url`);
  if (!running || !fs.existsSync(healthFile)) return { running, healthy: false, ready: false, reason: running ? 'health URL 없음' : 'launchd 중지', supervisorPid, supervisorLabel: label };
  const baseUrl = fs.readFileSync(healthFile, 'utf8').trim();
  let endpoint;
  try { endpoint = new URL(baseUrl); }
  catch { return { running, healthy: false, ready: false, reason: 'health URL invalid', supervisorPid, supervisorLabel: label }; }
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '::1', 'localhost'].includes(endpoint.hostname)) {
    return { running, healthy: false, ready: false, reason: 'health URL must be loopback HTTP', supervisorPid, supervisorLabel: label };
  }
  const probe = suffix => new Promise(resolve => {
    const timeoutSeconds = Math.max(1, Math.ceil((options.timeoutMs ?? 2_000) / 1_000));
    const child = spawn(options.curlExecutable ?? '/usr/bin/curl', [
      '--fail', '--silent', '--max-time', String(timeoutSeconds), '--output', '/dev/null', `${baseUrl}${suffix}`
    ], { stdio: 'ignore' });
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once('error', () => finish(false));
    child.once('close', code => finish(code === 0));
  });
  const [healthy, ready] = await Promise.all([probe('/healthz'), probe('/readyz')]);
  return { running, healthy, ready, reason: ready ? null : '터널 준비 안 됨', supervisorPid, supervisorLabel: label };
}

export async function workspaceMcpStatus(options = {}) {
  const paths = workspaceMcpPaths(options);
  let config;
  try { config = readWorkspaceMcpConfig(options); }
  catch (error) {
    return { id: 'workspace-mcp', label: 'AICC 원격 작업공간 MCP', state: 'attention', detail: error.message };
  }
  if (!config) {
    return { id: 'workspace-mcp', label: 'AICC 원격 작업공간 MCP', state: 'unavailable', detail: '아직 구성되지 않았습니다.', optional: false };
  }
  const missing = config.workspaces.filter(item => !realDirectory(item.root));
  const command = workspaceMcpCommand(config, { ...options, configPath: paths.config });
  const serverExists = fs.existsSync(command.args[0]);
  let dependencyReady = false;
  try {
    const resolveDependency = options.resolveDependency
      ?? (specifier => createRequire(path.join(command.cwd, 'package.json')).resolve(specifier));
    dependencyReady = Boolean(resolveDependency('@modelcontextprotocol/sdk/server/mcp.js'));
  } catch { dependencyReady = false; }
  const tunnel = await (options.tunnelProbe ?? probeWorkspaceTunnel)(options);
  const surfaceProfile = normalizeWorkspaceSurfaceProfile(config.surfaceProfile ?? options.surfaceProfile);
  const commandSandboxAvailable = workspaceCommandSandboxAvailable(config, options);
  const publication = workspacePublicationStatus({ ...options, surfaceProfile, commandSandboxAvailable, webManagementAvailable: config.webManagement?.enabled === true, codexCliAvailable: config.codexCli?.enabled === true, gptQueueAvailable: config.gptQueue?.enabled === true });
  const hostCapabilities = workspaceHostCapabilities({
    surfaceProfile,
    platform: options.platform,
    commandSandboxAvailable
  });
  const authorityMarkerPath = path.join(paths.runtime, 'remote-authority-status.json');
  let authorityMarker = null;

  let markerInspection = Object.freeze({ ok: !config.remoteAuthority, reasons: Object.freeze([]) });
  if (config.remoteAuthority) {
    try {
      const runtimeExecutable = options.runtimeIdentityOptions?.execPath
        ?? workspaceMcpRuntimeExecutable(config, options)
        ?? command.executable;
      const expectedIdentity = workspaceRuntimeExpectedIdentity(
        config,
        paths.config,
        workspaceRuntimeIdentityOptions(runtimeExecutable, options)
      );
      // Observe the marker after potentially slow deployment identity inspection.
      try { authorityMarker = JSON.parse(fs.readFileSync(authorityMarkerPath, 'utf8')); } catch { /* pre-migration runtime */ }
      markerInspection = inspectWorkspaceRuntimeMarker(
        authorityMarker,
        expectedIdentity,
        {
          ...options.runtimeMarkerInspectionOptions,
          allowHeartbeatLivenessFallback: options.runtimeMarkerInspectionOptions?.allowHeartbeatLivenessFallback
            ?? (tunnel.ready === true && Number.isInteger(tunnel.supervisorPid)),
          expectedSupervisorPid: options.runtimeMarkerInspectionOptions?.expectedSupervisorPid
            ?? tunnel.supervisorPid,
          supervisorReady: options.runtimeMarkerInspectionOptions?.supervisorReady
            ?? tunnel.ready === true
        }
      );
    } catch (error) {
      markerInspection = Object.freeze({
        ok: false,
        reasons: Object.freeze([`inspection_error:${error instanceof Error ? error.message : String(error)}`])
      });
    }
  }
  const markerMatches = markerInspection.ok;
  let activeRemoteLeases = 0;
  let rawCapabilitiesStored = false;
  try {
    const ownerStateRoot = path.dirname(paths.root);
    const stateFiles = [
      path.join(ownerStateRoot, 'jobs', 'state.json'),
      path.join(ownerStateRoot, 'read-sessions', surfaceProfile, 'state.json')
    ];
    for (const stateFile of stateFiles) {
      let durable;
      try { durable = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const leases = Object.values(durable.remoteLeases ?? {});
      activeRemoteLeases += leases.filter(item => item.state === 'leased' && Date.parse(item.expiresAt) > Date.now()).length;
      rawCapabilitiesStored ||= leases.some(item => Object.hasOwn(item, 'capability'));
    }
  } catch (error) {
    activeRemoteLeases = null;
    rawCapabilitiesStored = null;
  }
  const ready = missing.length === 0 && serverExists && dependencyReady && tunnel.ready
    && (!config.remoteAuthority || markerMatches);
  return {
    id: 'workspace-mcp',
    label: 'AICC 원격 작업공간 MCP',
    state: ready ? 'ready' : 'attention',
    detail: missing.length
      ? `등록 경로 ${missing.length}개를 찾지 못했습니다.`
      : !serverExists
        ? '고정 STDIO 서버를 찾지 못했습니다.'
        : !dependencyReady
          ? 'MCP 런타임 의존성을 불러오지 못했습니다.'
          : !tunnel.running
            ? `${config.workspaces.length}개 워크스페이스 · Tunnel 자동 시작 중지`
          : !tunnel.ready
            ? `${config.workspaces.length}개 워크스페이스 · Tunnel 연결 대기`
            : config.remoteAuthority && !markerMatches
              ? `${config.workspaces.length}개 워크스페이스 · 런타임 준비 증명 실패 (${markerInspection.reasons.join(', ')})`
            : `${config.workspaces.length}개 워크스페이스 · Secure Tunnel 준비됨`,
    configured: true,
    surfaceProfile,
    serverReady: ready,
    workspaceCount: config.workspaces.length,
    missingCount: missing.length,
    permissions: config.permissions,
    hostCapabilities: { commands: hostCapabilities.commands, network: hostCapabilities.network, webManagement: config?.webManagement?.enabled === true, codexCli: config?.codexCli?.enabled === true, gptQueue: config?.gptQueue?.enabled === true },
    executionBoundary: config.executionBoundary ?? null,
    transport: config.transport,
    remoteAuthority: config.remoteAuthority ? {
      ...config.remoteAuthority,
      migrationRequired: !markerMatches,
      runtimeReady: markerMatches,
      runtimeReasons: markerInspection.reasons,
      runtimeIdentityProof: markerInspection.identityProof ?? null,
      activeLeases: activeRemoteLeases,
      rawCapabilitiesStored
    } : {
      authenticationOwner: 'secure-mcp-tunnel',
      defaultMode: 'legacy-unscoped-runtime',
      migrationRequired: true,
      runtimeReady: false,
      activeLeases: null,
      rawCapabilitiesStored: null
    },
    tunnel: { running: tunnel.running, healthy: tunnel.healthy, ready: tunnel.ready, reason: tunnel.reason ?? null },
    publication: {
      needsPublish: publication.needsPublish,
      toolCount: publication.manifest.toolCount,
      readToolCount: publication.manifest.readToolCount,
      writeToolCount: publication.manifest.writeToolCount,
      capabilities: publication.manifest.capabilities,
      tools: publication.manifest.tools,
      published: publication.published,
      manageUrl: publication.manageUrl
    },
    configPath: paths.config,
    command
  };
}
