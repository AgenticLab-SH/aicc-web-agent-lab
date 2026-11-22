import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  buildWorkspaceMcpConfig, configureWorkspaceMcp, discoverGitWorkspaces, discoverOwnerContentRoots, migrateWorkspaceMcpRemoteAuthority,
  configureLocalWorkspaceMcp, readWorkspaceMcpConfig, reconcileWorkspaceMcpRoots, workspaceMcpCommand, workspaceMcpDoctor, workspaceMcpPaths, workspaceMcpRuntimeExecutable, workspaceMcpStatus
} from '../src/workspace-mcp.mjs';
import { __testing as serverTesting } from '../components/workspace-mcp/server.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('local STDIO installer is isolated, private, idempotent and repairs only after an idle preview', async t => {
  const projectsRoot = fixture(t);
  const stateRoot = fixture(t);
  fs.mkdirSync(path.join(projectsRoot, 'one', '.git'), { recursive: true });
  const sourceOptions = { stateRoot, projectsRoot, surfaceProfile: 'personal-read-fetch' };
  configureWorkspaceMcp(sourceOptions);
  const remote = workspaceMcpPaths(sourceOptions);
  const sourceBytes = fs.readFileSync(remote.config, 'utf8');
  const local = workspaceMcpPaths({ ...sourceOptions, local: true });
  const plan = await configureLocalWorkspaceMcp({ ...sourceOptions, dryRun: true });
  assert.equal(plan.workspaceCount, 1);
  assert.equal(fs.existsSync(local.root), false);
  const installed = await configureLocalWorkspaceMcp(sourceOptions);
  assert.equal(installed.writePolicy, 'read-only');
  assert.equal(local.root.endsWith('workspace-mcp-codex'), true);
  const config = readWorkspaceMcpConfig({ ...sourceOptions, local: true });
  assert.equal(config.transport.mode, 'local-stdio');
  assert.notEqual(config.remoteAuthority.identityBinding, JSON.parse(sourceBytes).remoteAuthority.identityBinding);
  assert.equal(config.remoteAuthority.authenticationOwner, 'codex-local-stdio');
  assert.equal(config.permissions.commands, false);
  assert.equal(config.permissions.network, false);
  assert.equal((await configureLocalWorkspaceMcp(sourceOptions)).duplicate, true);
  if (process.platform === 'win32') {
    const inspected = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:AICC_TEST_CONFIG; $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $other=@($acl.Access | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($owner,'S-1-5-18')}); [Console]::Out.Write(($other.Count -eq 0 -and $acl.Access.Count -gt 0))"], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true, env: { ...process.env, AICC_TEST_CONFIG: local.config }
    });
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(inspected.stdout, 'True');
  }
  const doctor = await workspaceMcpDoctor({ ...sourceOptions, local: true, readProcessStartToken: () => 'a'.repeat(64) });
  assert.equal(doctor.ok, true, JSON.stringify(doctor));
  assert.equal(doctor.canStart, true);
  assert.equal(doctor.tunnelRequired, false);
  assert.equal(doctor.liveCallVerified, false);
  assert.deepEqual(doctor.listenerPorts, []);
  assert.equal(JSON.stringify(doctor).includes(stateRoot), false);
  config.workspaces[0].label = 'Local customization';
  fs.writeFileSync(local.config, JSON.stringify(config));
  await assert.rejects(configureLocalWorkspaceMcp(sourceOptions), /--repair/);
  assert.equal((await configureLocalWorkspaceMcp({ ...sourceOptions, dryRun: true })).duplicate, false);
  fs.writeFileSync(path.join(local.runtime, 'remote-authority-status.json'), JSON.stringify({ process: { pid: process.pid } }));
  await assert.rejects(configureLocalWorkspaceMcp({ ...sourceOptions, repair: true }), /runtime_owner_active/);
  fs.unlinkSync(path.join(local.runtime, 'remote-authority-status.json'));
  const instanceNames = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  for (const instanceId of instanceNames) {
    const instanceRoot = path.join(local.runtime, 'local-stdio', instanceId);
    fs.mkdirSync(instanceRoot, { recursive: true });
    fs.writeFileSync(path.join(instanceRoot, 'remote-authority-status.json'), JSON.stringify({ instanceId, phase: 'pending', process: { pid: process.pid } }));
  }
  const concurrentDoctor = await workspaceMcpDoctor({ ...sourceOptions, local: true, readProcessStartToken: () => 'a'.repeat(64) });
  assert.equal(concurrentDoctor.canStart, true);
  assert.equal(concurrentDoctor.repairGuard.allowed, false);
  for (const instanceId of instanceNames) {
    await assert.rejects(configureLocalWorkspaceMcp({ ...sourceOptions, repair: true }), /runtime_owner_active/);
    const instanceRoot = path.join(local.runtime, 'local-stdio', instanceId);
    fs.unlinkSync(path.join(instanceRoot, 'remote-authority-status.json'));
    fs.rmdirSync(instanceRoot);
  }
  const repaired = await configureLocalWorkspaceMcp({ ...sourceOptions, repair: true });
  assert.equal(JSON.parse(fs.readFileSync(repaired.backupPath, 'utf8')).workspaces[0].label, 'Local customization');
  assert.equal(fs.readFileSync(remote.config, 'utf8'), sourceBytes);
  assert.equal(fs.existsSync(remote.runtime), false);
});

test('local guarded write requires exact selected Git roots and never inherits owner-unrestricted policy', async t => {
  const projectsRoot = fixture(t);
  const stateRoot = fixture(t);
  const repo = path.join(projectsRoot, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  configureWorkspaceMcp({ projectsRoot, stateRoot, surfaceProfile: 'personal-read-fetch', includeProjectsRoot: true });
  const source = readWorkspaceMcpConfig({ stateRoot, surfaceProfile: 'personal-read-fetch' });
  const alias = source.workspaces.find(item => item.root === fs.realpathSync(repo)).alias;
  const options = { stateRoot, surfaceProfile: 'business-full', dryRun: true };
  await assert.rejects(configureLocalWorkspaceMcp(options), /explicit --alias/);
  await assert.rejects(configureLocalWorkspaceMcp({ ...options, aliases: ['not-registered'] }), /not registered/);
  await assert.rejects(configureLocalWorkspaceMcp({ ...options, aliases: [alias] }), /exact Git roots/);
  const result = await configureLocalWorkspaceMcp({ ...options, aliases: [alias], spawnSync: () => ({ status: 0, stdout: repo }) });
  assert.equal(result.writePolicy, 'guarded');
  assert.equal(result.workspaceCount, 1);
  assert.match(result.configPath, /workspace-mcp-codex-business-full/);
  assert.equal(fs.existsSync(result.configPath), false);
});

test('STDIO doctor fails closed on missing configuration and selected surface mismatch without creating state', async t => {
  const stateRoot = fixture(t);
  const absent = await workspaceMcpDoctor({ stateRoot, local: true, surfaceProfile: 'personal-read-fetch', readProcessStartToken: () => null });
  assert.equal(absent.ok, false);
  assert.equal(absent.canStart, false);
  assert.deepEqual(fs.readdirSync(stateRoot), []);
  const projectsRoot = fixture(t);
  fs.mkdirSync(path.join(projectsRoot, '.git'));
  configureWorkspaceMcp({ projectsRoot, stateRoot, surfaceProfile: 'personal-read-fetch' });
  const paths = workspaceMcpPaths({ stateRoot, surfaceProfile: 'personal-read-fetch' });
  const config = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  config.surfaceProfile = 'business-full';
  fs.writeFileSync(paths.config, JSON.stringify(config));
  assert.throws(() => readWorkspaceMcpConfig({ stateRoot, surfaceProfile: 'personal-read-fetch' }), /surface/);
  assert.equal((await workspaceMcpDoctor({ stateRoot, surfaceProfile: 'personal-read-fetch', readProcessStartToken: () => 'a'.repeat(64) })).ok, false);
});

test('discovers exact git workspaces without treating the parent as one workspace', t => {
  const root = fixture(t);
  const one = path.join(root, 'one');
  const two = path.join(root, 'group', 'two');
  fs.mkdirSync(path.join(one, '.git'), { recursive: true });
  fs.mkdirSync(path.join(two, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'ignored', '.git'), { recursive: true });
  assert.deepEqual(discoverGitWorkspaces(root), [one, two].map(item => fs.realpathSync(item)).sort());
});

test('configures owner-local state and preserves all exact workspace roots without a listener port', t => {
  const projectsRoot = fixture(t);
  const stateRoot = fixture(t);
  const root = path.join(projectsRoot, 'aicc');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const result = configureWorkspaceMcp({ projectsRoot, stateRoot });
  const stored = readWorkspaceMcpConfig({ stateRoot });
  assert.equal(result.workspaceCount, 1);
  assert.equal(stored.schemaVersion, 2);
  assert.equal(stored.transport.mode, 'secure-mcp-tunnel');
  assert.equal(stored.executionBoundary.modelInference, 'external-chatgpt-conversation');
  assert.equal(stored.executionBoundary.codexTaskDelegation, false);
  assert.equal(stored.remoteAuthority.authenticationOwner, 'secure-mcp-tunnel');
  assert.equal(stored.remoteAuthority.defaultMode, 'read-only');
  assert.equal(stored.remoteAuthority.writePolicy, 'guarded');
  assert.deepEqual(stored.remoteAuthority.writeRequires, ['approval-ref', 'durable-job-id', 'durable-attempt-id', 'single-writer-lease', 'unique-request-id']);
  assert.match(stored.remoteAuthority.identityBinding, /^remote_[a-f0-9]{24}$/);
  assert.deepEqual(stored.workspaces.map(item => item.root), [fs.realpathSync(root)]);
  assert.equal('endpoint' in stored, false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(stateRoot, 'workspace-mcp', 'config.json')).mode & 0o777, 0o600);
  }
});

test('owner opt-in exposes the full projects tree and opens authenticated writes by default', t => {
  const projectsRoot = fixture(t);
  const repo = path.join(projectsRoot, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const config = buildWorkspaceMcpConfig({ projectsRoot, includeProjectsRoot: true, ownerUnrestrictedWrite: true });
  assert.equal(config.workspaces[0].root, fs.realpathSync(projectsRoot));
  assert.equal(config.remoteAuthority.defaultMode, 'write');
  assert.equal(config.remoteAuthority.writePolicy, 'owner-unrestricted');
  assert.deepEqual(config.remoteAuthority.writeRequires, ['authenticated-owner', 'single-writer-lease', 'unique-request-id']);
});

test('macOS Business opt-in registers the local machine root with terminal and network access', t => {
  const projectsRoot = fixture(t);
  const repo = path.join(projectsRoot, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const config = buildWorkspaceMcpConfig({
    projectsRoot,
    unrestrictedLocalAccess: true,
    ownerUnrestrictedWrite: true,
    platform: 'darwin'
  });
  assert.equal(config.defaultWorkspace, 'local-machine');
  assert.deepEqual(config.workspaces[0], {
    alias: 'local-machine',
    label: 'Local Machine',
    root: fs.realpathSync(path.parse(projectsRoot).root)
  });
  assert.equal(config.permissions.files, 'read-write');
  assert.equal(config.permissions.commands, true);
  assert.equal(config.permissions.network, true);
  assert.equal(config.executionBoundary.externalWorkspaceTools, 'local-machine-files-terminal-network-and-aicc-skills');
});

test('Personal read-fetch rejects unrestricted local access', t => {
  const projectsRoot = fixture(t);
  const repo = path.join(projectsRoot, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  assert.throws(() => buildWorkspaceMcpConfig({
    projectsRoot,
    surfaceProfile: 'personal-read-fetch',
    unrestrictedLocalAccess: true
  }), /Business full/);
});

test('Windows Business config fails closed for commands and network but keeps file writes', t => {
  const projectsRoot = fixture(t);
  const repo = path.join(projectsRoot, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const config = buildWorkspaceMcpConfig({
    projectsRoot,
    unrestrictedLocalAccess: true,
    ownerUnrestrictedWrite: true,
    platform: 'win32'
  });
  assert.equal(config.permissions.files, 'read-write');
  assert.equal(config.permissions.commands, false);
  assert.equal(config.permissions.network, false);
  assert.equal(config.executionBoundary.externalWorkspaceTools, 'local-machine-files-and-aicc-skills');
});

test('Windows Business config opens full local files, commands and network only with the owner flag', t => {
  const projectsRoot = fixture(t);
  const repo = path.join(projectsRoot, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const config = buildWorkspaceMcpConfig({
    projectsRoot,
    unrestrictedLocalAccess: true,
    ownerUnrestrictedWrite: true,
    unrestrictedWindowsCommands: true,
    platform: 'win32'
  });
  assert.equal(config.defaultWorkspace, 'local-machine');
  assert.equal(config.permissions.files, 'read-write');
  assert.equal(config.permissions.commands, true);
  assert.equal(config.permissions.network, true);
  assert.equal(config.permissions.commandIsolation, 'owner-unrestricted-windows');
  assert.equal(config.executionBoundary.externalWorkspaceTools, 'local-machine-files-terminal-network-and-aicc-skills');
});

test('personal profile stores a separate read-fetch-only configuration', t => {
  const projectsRoot = fixture(t);
  const stateRoot = fixture(t);
  const repo = path.join(projectsRoot, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const options = { projectsRoot, stateRoot, surfaceProfile: 'personal-read-fetch', ownerUnrestrictedWrite: true };
  const result = configureWorkspaceMcp(options);
  const stored = readWorkspaceMcpConfig({ stateRoot, surfaceProfile: 'personal-read-fetch' });
  assert.match(result.configPath.replaceAll('\\', '/'), /workspace-mcp-personal-read-fetch\/config\.json$/);
  assert.equal(stored.surfaceProfile, 'personal-read-fetch');
  assert.equal(stored.permissions.files, 'read-only');
  assert.equal(stored.permissions.commands, false);
  assert.equal(stored.permissions.network, false);
  assert.equal(stored.remoteAuthority.defaultMode, 'read-only');
  assert.equal(stored.remoteAuthority.writePolicy, 'read-only');
  assert.deepEqual(stored.remoteAuthority.writeRequires, []);
  assert.equal(stored.transport.runtimeAlias, 'aicc-workspace-personal-read-fetch');
  assert.equal(readWorkspaceMcpConfig({ stateRoot }), null);
});

test('owner content discovery exposes visible content directories but excludes hidden auth state and Library', t => {
  const ownerHome = fixture(t);
  for (const name of ['Desktop', 'Documents', 'Downloads', 'dev', 'Library', '.ssh', '.codex']) {
    fs.mkdirSync(path.join(ownerHome, name));
  }
  assert.deepEqual(discoverOwnerContentRoots(ownerHome), ['Desktop', 'Documents', 'Downloads', 'dev']
    .map(name => fs.realpathSync(path.join(ownerHome, name))).sort());
});

test('owner content opt-in registers visible content as writable aliases without exposing the whole home', t => {
  const ownerHome = fixture(t);
  const projectsRoot = path.join(ownerHome, 'dev', 'projects');
  const repo = path.join(projectsRoot, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(ownerHome, 'Documents'));
  fs.mkdirSync(path.join(ownerHome, 'Library'));
  fs.mkdirSync(path.join(ownerHome, '.ssh'));
  const config = buildWorkspaceMcpConfig({
    projectsRoot,
    ownerHome,
    includeProjectsRoot: true,
    includeOwnerContentRoots: true,
    ownerUnrestrictedWrite: true,
    platform: 'darwin'
  });
  const roots = config.workspaces.map(item => item.root);
  assert.equal(roots.includes(fs.realpathSync(ownerHome)), false);
  assert.equal(roots.includes(fs.realpathSync(path.join(ownerHome, 'Library'))), false);
  assert.equal(roots.includes(fs.realpathSync(path.join(ownerHome, '.ssh'))), false);
  assert.equal(roots.includes(fs.realpathSync(path.join(ownerHome, 'Documents'))), true);
  assert.equal(roots.includes(fs.realpathSync(path.join(ownerHome, 'dev'))), true);
  assert.equal(config.workspaces.every(item => /^[a-z0-9._-]+$/.test(item.alias) && !/^\.+$/.test(item.alias)), true);
  assert.equal(config.workspaces.find(item => item.root === fs.realpathSync(path.join(ownerHome, 'dev'))).alias, 'dev');
  assert.equal(config.executionBoundary.externalWorkspaceTools, 'owner-content-files-terminal-and-aicc-skills');
  assert.deepEqual(config.executionBoundary.excludedOwnerState, ['hidden-home-directories', 'Library']);
});

test('builds a direct AICC STDIO server command without a network listener', t => {
  const projectsRoot = fixture(t);
  const root = path.join(projectsRoot, 'repo');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const config = buildWorkspaceMcpConfig({ projectsRoot });
  const command = workspaceMcpCommand(config, { nodeExecutable: '/fixture/node', configPath: '/fixture/config.json' });
  assert.equal(command.executable, '/fixture/node');
  assert.match(command.args[0].replaceAll('\\', '/'), /components\/workspace-mcp\/server\.mjs$/);
  assert.deepEqual(command.args.slice(1), ['--config', '/fixture/config.json']);
  assert.equal('endpoint' in command, false);
});

test('reads the exact node identity declared by the owner-only tunnel profile', t => {
  const stateRoot = fixture(t);
  const profile = path.join(stateRoot, 'workspace-mcp', 'tunnel', 'profiles', 'aicc-workspace.yaml');
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(profile, `${JSON.stringify({ mcp: { commands: [{ channel: 'main', command: `"${process.execPath}" "/fixture/server.mjs"` }] } })}\n`, { mode: 0o600 });
  assert.equal(workspaceMcpRuntimeExecutable({ transport: { runtimeAlias: 'aicc-workspace' } }, { stateRoot }), fs.realpathSync.native(process.execPath));
});

test('reconciles only missing or duplicate real roots and preserves the surface policy', t => {
  const projectsRoot = fixture(t);
  const stateRoot = fixture(t);
  const live = path.join(projectsRoot, 'live');
  const missing = path.join(projectsRoot, 'missing');
  fs.mkdirSync(path.join(live, '.git'), { recursive: true });
  configureWorkspaceMcp({ projectsRoot, stateRoot, allowedRoots: [live], ownerUnrestrictedWrite: true });
  const configPath = path.join(stateRoot, 'workspace-mcp', 'config.json');
  const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  current.workspaces.push({ alias: 'missing', label: 'missing', root: missing });
  current.workspaces.push({ alias: 'duplicate', label: 'duplicate', root: live });
  fs.writeFileSync(configPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  const result = reconcileWorkspaceMcpRoots({ stateRoot });
  assert.equal(result.duplicate, false);
  assert.deepEqual(result.removed.map(item => item.reason).sort(), ['duplicate-realpath', 'missing']);
  const stored = readWorkspaceMcpConfig({ stateRoot });
  assert.equal(stored.workspaces.length, 1);
  assert.equal(stored.remoteAuthority.writePolicy, 'owner-unrestricted');
  assert.equal(fs.existsSync(result.backupPath), true);
});

test('root reconciliation preserves stored permissions when the caller lacks the runtime sandbox', t => {
  const projectsRoot = fixture(t);
  const stateRoot = fixture(t);
  const live = path.join(projectsRoot, 'live');
  fs.mkdirSync(path.join(live, '.git'), { recursive: true });
  configureWorkspaceMcp({ projectsRoot, stateRoot, allowedRoots: [live] });
  const configPath = path.join(stateRoot, 'workspace-mcp', 'config.json');
  const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  current.permissions = { ...current.permissions, commands: true, network: true, commandIsolation: 'appcontainer-windows' };
  current.workspaces.push({ alias: 'missing', label: 'missing', root: path.join(projectsRoot, 'missing') });
  fs.writeFileSync(configPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  const options = { stateRoot, platform: 'win32', commandSandboxAvailable: false };
  assert.equal(readWorkspaceMcpConfig(options).permissions.commands, false);
  const result = reconcileWorkspaceMcpRoots(options);
  const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(stored.permissions, current.permissions);
  assert.deepEqual(stored.executionBoundary, current.executionBoundary);
  assert.deepEqual(stored.remoteAuthority, current.remoteAuthority);
  assert.deepEqual(stored.workspaces, current.workspaces.slice(0, -1));
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backupPath, 'utf8')), current);
});

test('root reconciliation dry-run reports exact removals without writing config or backup', t => {
  const projectsRoot = fixture(t);
  const stateRoot = fixture(t);
  const live = path.join(projectsRoot, 'live');
  const missing = path.join(projectsRoot, 'missing');
  fs.mkdirSync(path.join(live, '.git'), { recursive: true });
  configureWorkspaceMcp({ projectsRoot, stateRoot, allowedRoots: [live] });
  const configPath = path.join(stateRoot, 'workspace-mcp', 'config.json');
  const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  current.workspaces.push({ alias: 'missing', label: 'missing', root: missing });
  fs.writeFileSync(configPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  const before = fs.readFileSync(configPath);
  const result = reconcileWorkspaceMcpRoots({ stateRoot, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.backupPath, undefined);
  assert.equal(result.afterHash, null);
  assert.deepEqual(result.removed, [{ alias: 'missing', root: missing, reason: 'missing' }]);
  assert.deepEqual(fs.readFileSync(configPath), before);
  assert.equal(fs.existsSync(path.join(stateRoot, 'workspace-mcp', 'backups')), false);
});

test('remote authority migration preserves every registered workspace and is idempotent', t => {
  const projectsRoot = fixture(t);
  const stateRoot = fixture(t);
  const root = path.join(projectsRoot, 'repo');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  configureWorkspaceMcp({ projectsRoot, stateRoot });
  const configPath = path.join(stateRoot, 'workspace-mcp', 'config.json');
  const legacy = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  delete legacy.remoteAuthority;
  fs.writeFileSync(configPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
  const migrated = migrateWorkspaceMcpRemoteAuthority({ stateRoot });
  assert.equal(migrated.duplicate, false);
  assert.equal(migrated.workspaceCount, 1);
  assert.notEqual(migrated.beforeHash, migrated.afterHash);
  assert.equal(fs.existsSync(migrated.backupPath), true);
  const stored = readWorkspaceMcpConfig({ stateRoot });
  assert.deepEqual(stored.workspaces, legacy.workspaces);
  assert.equal(stored.remoteAuthority.defaultMode, 'read-only');
  assert.equal(migrateWorkspaceMcpRemoteAuthority({ stateRoot }).duplicate, true);
});

test('status distinguishes a configured STDIO runtime from missing configuration', async t => {
  const stateRoot = fixture(t);
  const missing = await workspaceMcpStatus({ stateRoot, timeoutMs: 10 });
  assert.equal(missing.state, 'unavailable');
  const projectsRoot = fixture(t);
  fs.mkdirSync(path.join(projectsRoot, 'repo', '.git'), { recursive: true });
  configureWorkspaceMcp({ projectsRoot, stateRoot, platform: 'darwin' });
  const configPath = path.join(stateRoot, 'workspace-mcp', 'config.json');
  const runtimeConfig = readWorkspaceMcpConfig({ stateRoot, platform: 'darwin' });
  const processToken = 'a'.repeat(64);
  const supervisorToken = 'b'.repeat(64);
  const startingMarker = serverTesting.writeAuthorityMarker(runtimeConfig, configPath, {
    phase: 'starting',
    // Model the server invocation, not this test runner's --test flags.
    execArgv: [],
    processStartToken: processToken,
    supervisorProcessStartToken: supervisorToken
  });
  serverTesting.writeAuthorityMarker(runtimeConfig, configPath, {
    phase: 'ready',
    previous: startingMarker,
    transportConnected: true
  });
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  fs.mkdirSync(path.join(stateRoot, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'jobs', 'state.json'), JSON.stringify({
    remoteLeases: { write_fixture: { state: 'leased', mode: 'write', expiresAt } }
  }));
  fs.mkdirSync(path.join(stateRoot, 'read-sessions', 'business-full'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'read-sessions', 'business-full', 'state.json'), JSON.stringify({
    remoteLeases: { read_fixture: { state: 'leased', mode: 'read-only', expiresAt } }
  }));
  const ready = await workspaceMcpStatus({
    stateRoot,
    platform: 'darwin',
    tunnelProbe: async () => ({ running: true, healthy: true, ready: true, supervisorPid: process.ppid }),
    runtimeMarkerInspectionOptions: {
      readProcessStartToken: () => null,
      signalProcess: pid => { if (![process.pid, process.ppid].includes(pid)) throw Object.assign(new Error('missing'), { code: 'ESRCH' }); }
    }
  });
  assert.equal(ready.state, 'ready', JSON.stringify({detail:ready.detail,reasons:ready.remoteAuthority?.runtimeReasons}));
  assert.equal(ready.serverReady, true);
  assert.equal(ready.workspaceCount, 1);
  assert.equal(ready.publication.toolCount, 22);
  assert.equal(ready.publication.readToolCount, 17);
  assert.equal(ready.publication.writeToolCount, 5);
  assert.equal(ready.publication.needsPublish, true);
  assert.equal(ready.remoteAuthority.activeLeases, 2);
  assert.equal(ready.remoteAuthority.runtimeIdentityProof.process, 'fresh-heartbeat-and-live-pid');
  assert.equal(ready.remoteAuthority.runtimeIdentityProof.supervisor, 'launchd-pid-fresh-heartbeat-and-live-pid');
  assert.equal(ready.remoteAuthority.rawCapabilitiesStored, false);
  const markerPath = path.join(stateRoot, 'workspace-mcp', 'runtime', 'remote-authority-status.json');
  const staleMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  staleMarker.sourceIdentity.runtimeHash = '0'.repeat(64);
  fs.writeFileSync(markerPath, `${JSON.stringify(staleMarker)}\n`, { mode: 0o600 });
  const stale = await workspaceMcpStatus({ stateRoot, platform: 'darwin', tunnelProbe: async () => ({ running: true, healthy: true, ready: true }) });
  assert.equal(stale.state, 'attention');
  assert.equal(stale.serverReady, false);
  assert.equal(stale.remoteAuthority.runtimeReady, false);
  assert.match(stale.detail, /런타임 준비 증명 실패/);
});

test('Windows status reports fail-closed permissions and a command-free publication', async t => {
  const stateRoot = fixture(t);
  const projectsRoot = fixture(t);
  fs.mkdirSync(path.join(projectsRoot, 'repo', '.git'), { recursive: true });
  configureWorkspaceMcp({ projectsRoot, stateRoot, platform: 'win32', network: true });
  const configPath = path.join(stateRoot, 'workspace-mcp', 'config.json');
  const stale = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  stale.permissions.commands = true;
  stale.permissions.network = true;
  stale.executionBoundary.externalWorkspaceTools = 'workspace-files-terminal-network-and-aicc-skills';
  fs.writeFileSync(configPath, `${JSON.stringify(stale, null, 2)}\n`);
  const status = await workspaceMcpStatus({
    stateRoot,
    platform: 'win32',
    tunnelProbe: async () => ({ running: false, healthy: false, ready: false })
  });
  assert.equal(status.permissions.commands, false);
  assert.equal(status.permissions.network, false);
  assert.equal(status.executionBoundary.externalWorkspaceTools, 'workspace-files-and-aicc-skills');
  assert.deepEqual(status.hostCapabilities, { commands: false, network: false, webManagement: false, codexCli: false, gptQueue: false });
  assert.deepEqual(status.publication.capabilities, { commands: false, network: false });
  assert.equal(status.publication.toolCount, 19);
  assert.equal(status.publication.tools.some(tool => tool.name === 'aicc_workspace_apply_patch'), true);
  assert.equal(status.publication.tools.some(tool => tool.name === 'aicc_workspace_exec'), false);
});
