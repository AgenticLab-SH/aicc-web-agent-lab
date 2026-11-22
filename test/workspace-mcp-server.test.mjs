import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { workspaceRuntimeStartGuard } from '../components/workspace-mcp/runtime-marker.mjs';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  confinedPath,
  createWorkspaceMcpServer,
  loadConfig,
  resolveRipgrepExecutable,
  sandboxProfile,
  __testing
} from '../components/workspace-mcp/server.mjs';
import { WORKSPACE_MCP_TOOLS } from '../components/workspace-mcp/tool-manifest.mjs';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { WorkspaceFastReadCoordinator } from '../components/workspace-mcp/fast-read.mjs';
import {
  inspectWorkspaceRuntimeMarker,
  workspaceRuntimeExpectedIdentity
} from '../components/workspace-mcp/runtime-marker.mjs';

function nestedSandboxExecAvailable() {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) return false;
  const probe = spawnSync('/usr/bin/sandbox-exec', [
    '-p', '(version 1)\n(allow default)', '/usr/bin/true'
  ], { encoding: 'utf8', timeout: 2_000 });
  return probe.status === 0;
}

const NESTED_SANDBOX_EXEC_AVAILABLE = nestedSandboxExecAvailable();
const GIT_EXECUTABLE = process.platform === 'win32' ? 'git.exe' : '/usr/bin/git';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-mcp-server-'));
  const workspace = path.join(root, 'workspace');
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# fixture\n');
  fs.writeFileSync(path.join(workspace, '.env'), 'SECRET=nope\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, workspace, runtime };
}

for (const surfaceProfile of ['personal-read-fetch', 'business-full']) {
  test(`two concurrent real STDIO ${surfaceProfile} clients isolate leases and preserve guarded writes`, { timeout: 45_000 }, async t => {
    const paths = fixture(t);
    for (const args of [['init', '-q'], ['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
      assert.equal(spawnSync(GIT_EXECUTABLE, args, { cwd: paths.workspace, windowsHide: true }).status, 0);
    }
    const configRoot = path.join(paths.root, 'state', `workspace-mcp-${surfaceProfile}`);
    fs.mkdirSync(configRoot, { recursive: true });
    const configPath = path.join(configRoot, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      ...config(paths.workspace), surfaceProfile, transport: { mode: 'local-stdio' },
      permissions: { files: surfaceProfile === 'personal-read-fetch' ? 'read-only' : 'read-write', commands: true, network: true },
      remoteAuthority: { identityBinding: `local_${'a'.repeat(24)}`, authenticationOwner: 'codex-local-stdio', defaultMode: 'read-only', writePolicy: surfaceProfile === 'personal-read-fetch' ? 'read-only' : 'guarded' }
    }));
    const remoteRuntime = path.join(paths.root, 'state', 'workspace-mcp-personal-read-fetch', 'remote-runtime-fixture');
    fs.mkdirSync(remoteRuntime, { recursive: true });
    const remoteMarkerFile = path.join(remoteRuntime, 'remote-authority-status.json');
    const remoteMarker = JSON.stringify({ process: { pid: process.pid }, phase: 'ready', instanceId: 'remote-fixture' });
    fs.writeFileSync(remoteMarkerFile, remoteMarker);
    const serverPath = path.join(__testing.componentRoot, 'server.mjs');
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, '--config', configPath], stderr: 'pipe' });
    const client = new Client({ name: 'stdio-fixture', version: '1.0.0' });
    const secondTransport = new StdioClientTransport({ command: process.execPath, args: [serverPath, '--config', configPath], stderr: 'pipe' });
    const secondClient = new Client({ name: 'second-stdio-fixture', version: '1.0.0' });
    let stderr = '';
    transport.stderr.on('data', data => { stderr += data; });
    secondTransport.stderr.on('data', data => { stderr += data; });
    try {
      await Promise.all([client.connect(transport), secondClient.connect(secondTransport)]);
      const tools = await client.listTools();
      assert.equal(tools.tools.length, surfaceProfile === 'personal-read-fetch' ? 18 : process.platform === 'darwin' ? 22 : 19);
      const call = async (name, args = {}) => payload(await client.callTool({ name, arguments: args }));
      const secondCall = async (name, args = {}) => payload(await secondClient.callTool({ name, arguments: args }));
      const listed = await call('aicc_workspace_list');
      assert.equal(listed.workspaces.length, 1);
      const [opened, secondOpened] = await Promise.all([
        call('aicc_workspace_open', { alias: 'fixture', mode: 'read-only', correlation_id: 'stdio-read-fixture' }),
        secondCall('aicc_workspace_open', { alias: 'fixture', mode: 'read-only', correlation_id: 'second-stdio-read-fixture' })
      ]);
      assert.equal(opened.ok, true, JSON.stringify(opened));
      assert.equal(secondOpened.ok, true, JSON.stringify(secondOpened));
      const lease = { workspace_id: opened.workspace_id, lease: opened.lease };
      const secondLease = { workspace_id: secondOpened.workspace_id, lease: secondOpened.lease };
      assert.notEqual(lease.lease, secondLease.lease);
      assert.equal((await secondCall('aicc_workspace_read', { ...secondLease, path: 'README.md' })).ok, true);
      assert.equal((await secondCall('aicc_workspace_read', { ...lease, path: 'README.md' })).ok, false);
      assert.equal((await call('aicc_workspace_read', { ...secondLease, path: 'README.md' })).ok, false);
      const read = await call('aicc_workspace_read', { ...lease, path: 'README.md' });
      assert.equal(read.ok, true, JSON.stringify(read));
      assert.match(JSON.stringify(read), /fixture/);
      for (const blocked of ['.env', '../config.json', '.git/config']) {
        assert.equal((await call('aicc_workspace_read', { ...lease, path: blocked })).ok, false);
      }
      const denied = await client.callTool({ name: 'aicc_workspace_open', arguments: { alias: 'fixture', mode: 'write', correlation_id: 'stdio-write-fixture' } });
      assert.equal(denied.isError, true);
      if (surfaceProfile === 'business-full') {
        const forged = await call('aicc_workspace_open', { alias: 'fixture', mode: 'write', correlation_id: 'stdio-forged-fixture', approval_ref: 'approval_fixture', job_id: 'job_fixture', attempt_id: 'attempt_fixture' });
        assert.equal(forged.ok, false);
        const patch = await call('aicc_workspace_apply_patch', { ...lease, request_id: 'patch_fixture', patch: '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# fixture\n+changed\n' });
        assert.equal(patch.ok, false);
      }
      const instances = path.join(configRoot, 'runtime', 'local-stdio');
      const instanceNames = fs.readdirSync(instances);
      assert.equal(instanceNames.length, 2);
      const markers = instanceNames.map(name => JSON.parse(fs.readFileSync(path.join(instances, name, 'remote-authority-status.json'), 'utf8')));
      assert.equal(markers.every(marker => marker.phase === 'ready'), true);
      assert.notEqual(markers[0].process.pid, markers[1].process.pid);
      assert.equal(fs.existsSync(path.join(configRoot, 'runtime', 'remote-authority-status.json')), false);
      assert.equal(workspaceRuntimeStartGuard(configPath).reason, 'runtime_owner_active');
      assert.equal(workspaceRuntimeStartGuard(configPath, { allowLocalInstances: true }).allowed, true);
      assert.equal((await secondCall('aicc_workspace_close', secondLease)).closed, true);
      await secondClient.close();
      assert.equal(workspaceRuntimeStartGuard(configPath).reason, 'runtime_owner_active');
      assert.equal((await call('aicc_workspace_read', { ...lease, path: 'README.md' })).ok, true);
      assert.equal((await call('aicc_workspace_close', lease)).closed, true);
    } catch (error) {
      error.message += `; stdio stderr: ${stderr}`;
      throw error;
    } finally {
      await Promise.all([client.close(), secondClient.close()]);
    }
    const instances = path.join(configRoot, 'runtime', 'local-stdio');
    for (const name of fs.readdirSync(instances)) {
      const instanceRoot = path.join(instances, name);
      const stopped = JSON.parse(fs.readFileSync(path.join(instanceRoot, 'remote-authority-status.json'), 'utf8'));
      assert.equal(stopped.phase, 'stopped');
      assert.equal(stopped.transport.connected, false);
      assert.equal(fs.existsSync(path.join(instanceRoot, 'read-sessions', 'state.json')), true);
    }
    assert.equal(workspaceRuntimeStartGuard(configPath).allowed, true);
    assert.equal(fs.readFileSync(remoteMarkerFile, 'utf8'), remoteMarker);
    assert.equal(fs.existsSync(path.join(configRoot, 'read-sessions')), false);
    assert.equal(fs.existsSync(path.join(paths.root, 'state', 'read-sessions')), false);
    assert.equal(fs.existsSync(path.join(paths.root, 'state', 'workspace-snapshots')), false);
    assert.equal(fs.readFileSync(path.join(paths.workspace, 'README.md'), 'utf8'), '# fixture\n');
  });
}

test('remote STDIO retains a singleton marker and refuses a second live owner', { timeout: 30_000 }, async t => {
  const paths = fixture(t);
  const configPath = path.join(paths.root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    ...config(paths.workspace), surfaceProfile: 'personal-read-fetch', transport: { mode: 'secure-mcp-tunnel' },
    remoteAuthority: { identityBinding: 'remote_fixture_singleton', authenticationOwner: 'secure-mcp-tunnel', defaultMode: 'read-only', writePolicy: 'read-only' }
  }));
  const serverPath = path.join(__testing.componentRoot, 'server.mjs');
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, '--config', configPath], stderr: 'pipe' });
  const client = new Client({ name: 'remote-singleton-fixture', version: '1.0.0' });
  let stderr = '';
  transport.stderr.on('data', data => { stderr += data; });
  try {
    await client.connect(transport);
    await client.listTools();
    const file = path.join(paths.root, 'runtime', 'remote-authority-status.json');
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    const duplicate = spawnSync(process.execPath, [serverPath, '--config', configPath], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    assert.equal(duplicate.status, 1, duplicate.stderr);
    assert.match(duplicate.stderr, /runtime_owner_active/);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.instanceId, before.instanceId);
    assert.deepEqual(after.process, before.process);
    assert.equal(after.phase, 'ready');
    assert.equal((await client.listTools()).tools.length, 18);
    assert.equal(fs.existsSync(path.join(paths.root, 'runtime', 'local-stdio')), false);
  } catch (error) {
    error.message += `; stdio stderr: ${stderr}`;
    throw error;
  } finally { await client.close(); }
});

function config(workspace, skillRoots = []) {
  return {
    schemaVersion: 2,
    defaultWorkspace: 'fixture',
    workspaces: [{ alias: 'fixture', label: 'Fixture', root: workspace }],
    permissions: { commands: true, network: false, maxReadBytes: 1_048_576, maxOutputBytes: 262_144, commandTimeoutMs: 120_000 },
    skillRoots
  };
}

async function clientFor(t, source, runtimeRoot, options = {}) {
  const server = createWorkspaceMcpServer(source, {
    platform: options.platform ?? 'darwin',
    runtimeRoot,
    durableStore: options.durableStore ?? null,
    readSessionStore: options.readSessionStore ?? options.durableStore ?? null,
    fastReadCoordinator: options.fastReadCoordinator ?? null,
    writerAuthorizer: options.writerAuthorizer ?? {
      acquire: async () => ({ ok: true, writerLeaseRef: 'writer_fixture_binding' }),
      release: async () => ({ ok: true })
    }
  });
  const client = new Client({ name: 'aicc-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('Windows server omits process command tools but keeps git apply_patch registered', async t => {
  const paths = fixture(t);
  const client = await clientFor(t, config(paths.workspace), paths.runtime, { platform: 'win32' });
  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name);
  assert.equal(names.length, 19);
  assert.equal(names.includes('aicc_workspace_apply_patch'), true);
  for (const name of ['aicc_workspace_exec', 'aicc_workspace_write_stdin', 'aicc_workspace_process_stop']) {
    assert.equal(names.includes(name), false);
  }
});

function payload(result) {
  return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
}

test('configuration and path guard reject symlinks, traversal, and sensitive files', t => {
  const paths = fixture(t);
  const configFile = path.join(paths.root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config(paths.workspace)));
  const loaded = loadConfig(configFile, { platform: 'win32' });
  assert.equal(loaded.workspaces[0].root, fs.realpathSync(paths.workspace));
  assert.equal(loaded.permissions.commands, false);
  assert.equal(loaded.permissions.network, false);
  assert.equal(confinedPath(paths.workspace, 'README.md'), fs.realpathSync(path.join(paths.workspace, 'README.md')));
  assert.throws(() => confinedPath(paths.workspace, '../outside'), /벗어납니다/);
  assert.throws(() => confinedPath(paths.workspace, '.env'), /민감 파일/);
  fs.symlinkSync(paths.root, path.join(paths.workspace, 'escape'));
  assert.throws(() => confinedPath(paths.workspace, 'escape/file.txt', { allowMissing: true }), /심볼릭 링크/);
});

test('ripgrep resolution works under the restricted LaunchAgent PATH', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-rg-resolver-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const executable = path.join(home, '.local', 'share', 'mise', 'installs', 'github-burnt-sushi-ripgrep', 'latest', 'rg');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.equal(resolveRipgrepExecutable({
    home,
    env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' }
  }), fs.realpathSync(executable));
  assert.throws(() => resolveRipgrepExecutable({
    home,
    env: { PATH: '', AICC_RG_EXECUTABLE: 'relative/rg' }
  }), /실행 가능한 절대 경로/);
});

test('runtime authority marker requires a connected ready transition and current owner identity', t => {
  const paths = fixture(t);
  const configFile = path.join(paths.root, 'config.json');
  const source = { ...config(paths.workspace), remoteAuthority: { identityBinding: 'remote_fixture_identity', defaultMode: 'read-only' } };
  fs.writeFileSync(configFile, JSON.stringify(source));
  const processToken = 'a'.repeat(64);
  const supervisorToken = 'b'.repeat(64);
  const starting = __testing.writeAuthorityMarker(source, configFile, {
    phase: 'starting',
    processStartToken: processToken,
    supervisorProcessStartToken: supervisorToken
  });
  const marker = __testing.writeAuthorityMarker(source, configFile, {
    phase: 'ready',
    previous: starting,
    transportConnected: true
  });
  const file = path.join(paths.root, 'runtime', 'remote-authority-status.json');
  assert.equal(marker.rawCapabilitiesStored, false);
  assert.equal(marker.schemaVersion, 4);
  assert.equal(marker.phase, 'ready');
  assert.equal(marker.transport.connected, true);
  assert.match(marker.transport.readySignalId, /^[a-f0-9]{32}$/);
  assert.match(marker.sourceIdentity.configHash, /^[a-f0-9]{64}$/);
  assert.match(marker.sourceIdentity.manifestHash, /^[a-f0-9]{64}$/);
  assert.match(marker.sourceIdentity.runtimeHash, /^[a-f0-9]{64}$/);
  assert.match(marker.installedIdentity.lockfileSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(marker, 'identityBinding'), false);
  assert.equal(fs.existsSync(file), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const expected = workspaceRuntimeExpectedIdentity(source, configFile);
  const inspectionOptions = { readProcessStartToken: pid => pid === marker.process.pid ? processToken : supervisorToken };
  assert.deepEqual(inspectWorkspaceRuntimeMarker(marker, expected, inspectionOptions).reasons, []);
  assert.equal(inspectWorkspaceRuntimeMarker({ ...marker, phase: 'starting' }, expected, inspectionOptions).ok, false);
  assert.equal(inspectWorkspaceRuntimeMarker({ ...marker, phase: 'failed' }, expected, inspectionOptions).ok, false);
  assert.equal(inspectWorkspaceRuntimeMarker({
    ...marker,
    heartbeatAt: new Date(Date.now() - 60_000).toISOString()
  }, expected, inspectionOptions).reasons.includes('heartbeat'), true);
  assert.equal(inspectWorkspaceRuntimeMarker({
    ...marker,
    sourceIdentity: { ...marker.sourceIdentity, runtimeHash: '0'.repeat(64) }
  }, expected, inspectionOptions).reasons.includes('source_identity'), true);
});

test('fixed MCP surface opens only aliases and can read and inspect changes', async t => {
  const paths = fixture(t);
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'workspace-tools@example.invalid'],
    ['config', 'user.name', 'Workspace Tools'],
    ['add', '.'],
    ['commit', '-qm', 'fixture']
  ]) {
    const result = spawnSync(GIT_EXECUTABLE, ['-C', paths.workspace, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  const skillRoot = path.join(paths.root, 'skills');
  const skill = path.join(skillRoot, 'fixture-skill');
  fs.mkdirSync(path.join(skill, 'references'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: fixture-skill\ndescription: Fixture skill for the complete tool audit.\n---\n\nRead references/detail.md.\n');
  fs.writeFileSync(path.join(skill, 'references', 'detail.md'), '# Detail\n');
  const client = await clientFor(t, config(paths.workspace, [skillRoot]), paths.runtime);
  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name).sort();
  assert.deepEqual(names, WORKSPACE_MCP_TOOLS.map(tool => tool.name).sort());
  const openTool = listed.tools.find(tool => tool.name === 'aicc_workspace_open');
  assert.equal(openTool.annotations.readOnlyHint, false);
  assert.equal(openTool.annotations.destructiveHint, true);
  const rejected = await client.callTool({ name: 'aicc_workspace_open', arguments: { alias: '/tmp', correlation_id: 'correlation-invalid' } });
  assert.equal(rejected.isError, true);
  const opened = await client.callTool({
    name: 'aicc_workspace_open',
    arguments: { alias: 'fixture', mode: 'write', correlation_id: 'correlation-write', approval_ref: 'approval-fixture', job_id: 'durable-job-fixture', attempt_id: 'durable-attempt-fixture', expires_in_seconds: 300 }
  });
  const binding = payload(opened);
  assert.match(binding.workspace_id, /^ws_/);
  assert.match(binding.lease, /^remote_cap_/);
  assert.equal(binding.mode, 'write');
  const read = await client.callTool({ name: 'aicc_workspace_read', arguments: { workspace_id: binding.workspace_id, lease: binding.lease, path: 'README.md' } });
  assert.equal(payload(read).text, '# fixture\n');
  const many = await client.callTool({ name: 'aicc_workspace_read_many', arguments: { workspace_id: binding.workspace_id, lease: binding.lease, paths: ['README.md'] } });
  assert.equal(payload(many).files[0].text, '# fixture\n');
  const info = await client.callTool({ name: 'aicc_workspace_info', arguments: { workspace_id: binding.workspace_id, lease: binding.lease } });
  assert.equal(payload(info).alias, 'fixture');
  const secret = await client.callTool({ name: 'aicc_workspace_read', arguments: { workspace_id: binding.workspace_id, lease: binding.lease, path: '.env' } });
  assert.equal(secret.isError, true);
  const secretSearch = await client.callTool({
    name: 'aicc_workspace_search',
    arguments: { workspace_id: binding.workspace_id, lease: binding.lease, query: 'SECRET=nope', path: '.', files_only: false, max_results: 20 }
  });
  assert.deepEqual(payload(secretSearch).results, []);

  fs.writeFileSync(path.join(paths.workspace, 'single-target.md'), 'needle in one file\n');
  const exactFileSearch = payload(await client.callTool({
    name: 'aicc_workspace_search',
    arguments: {
      workspace_id: binding.workspace_id,
      lease: binding.lease,
      query: 'needle',
      path: 'single-target.md',
      files_only: false,
      max_results: 20
    }
  }));
  assert.deepEqual(exactFileSearch.results, ['single-target.md:1:needle in one file '], JSON.stringify(exactFileSearch));

  fs.writeFileSync(path.join(paths.workspace, 'needle-name.md'), 'filename canary\n');
  fs.writeFileSync(path.join(paths.workspace, 'unrelated-name.md'), 'needle content does not make this a filename match\n');
  const filenameSearch = payload(await client.callTool({
    name: 'aicc_workspace_search',
    arguments: {
      workspace_id: binding.workspace_id,
      lease: binding.lease,
      query: 'needle-name',
      path: '.',
      files_only: true,
      max_results: 20
    }
  }));
  assert.deepEqual(filenameSearch.results, ['needle-name.md']);

  for (let index = 0; index < 200; index += 1) {
    fs.writeFileSync(path.join(paths.workspace, `many-${String(index).padStart(3, '0')}.txt`), 'bounded-search-canary\n');
  }
  const boundedSearch = payload(await client.callTool({
    name: 'aicc_workspace_search',
    arguments: {
      workspace_id: binding.workspace_id,
      lease: binding.lease,
      query: 'bounded-search-canary',
      path: '.',
      files_only: false,
      max_results: 3
    }
  }));
  assert.equal(boundedSearch.ok, true);
  assert.equal(boundedSearch.results.length, 3);
  assert.equal(boundedSearch.truncated, true);
  assert.equal(boundedSearch.limit_reason, 'max_results');

  const changes = payload(await client.callTool({
    name: 'aicc_workspace_changes',
    arguments: { workspace_id: binding.workspace_id, lease: binding.lease }
  }));
  assert.equal(changes.ok, true);
  assert.match(changes.status, /single-target\.md/);

  const skills = payload(await client.callTool({
    name: 'aicc_skill_inventory',
    arguments: { workspace_id: binding.workspace_id, lease: binding.lease }
  }));
  assert.deepEqual(skills.skills, [{ id: 'fixture-skill', description: 'Fixture skill for the complete tool audit.' }]);
  const skillMain = payload(await client.callTool({
    name: 'aicc_skill_read',
    arguments: { workspace_id: binding.workspace_id, lease: binding.lease, skill_id: 'fixture-skill', path: 'SKILL.md' }
  }));
  assert.match(skillMain.text, /complete tool audit/);
  const skillReference = payload(await client.callTool({
    name: 'aicc_skill_read',
    arguments: { workspace_id: binding.workspace_id, lease: binding.lease, skill_id: 'fixture-skill', path: 'references/detail.md' }
  }));
  assert.equal(skillReference.text, '# Detail\n');

  if (NESTED_SANDBOX_EXEC_AVAILABLE) {
    const executed = await client.callTool({
      name: 'aicc_workspace_exec',
      arguments: { workspace_id: binding.workspace_id, lease: binding.lease, request_id: 'exec-request-0001', command: "printf 'sandbox-ok' > command-output.txt", yield_time_ms: 500 }
    });
    assert.equal(payload(executed).exit_code, 0, JSON.stringify(payload(executed)));
    assert.equal(fs.readFileSync(path.join(paths.workspace, 'command-output.txt'), 'utf8'), 'sandbox-ok');

    const secretExecuted = await client.callTool({
      name: 'aicc_workspace_exec',
      arguments: { workspace_id: binding.workspace_id, lease: binding.lease, request_id: 'exec-secret-denied', command: 'cat .env', yield_time_ms: 500 }
    });
    assert.notEqual(payload(secretExecuted).exit_code, 0, JSON.stringify(payload(secretExecuted)));
    assert.doesNotMatch(payload(secretExecuted).output, /SECRET=nope/);

    const patched = await client.callTool({
      name: 'aicc_workspace_apply_patch',
      arguments: {
        workspace_id: binding.workspace_id,
        lease: binding.lease,
        request_id: 'patch-request-001',
        patch: '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# fixture\n+# patched\n'
      }
    });
    assert.equal(payload(patched).ok, true);
    assert.equal(fs.readFileSync(path.join(paths.workspace, 'README.md'), 'utf8'), '# patched\n');

    const interactive = payload(await client.callTool({
      name: 'aicc_workspace_exec',
      arguments: {
        workspace_id: binding.workspace_id,
        lease: binding.lease,
        request_id: 'interactive-command-0001',
        command: 'read line; printf "stdin:%s" "$line"',
        yield_time_ms: 50
      }
    }));
    assert.match(interactive.session_id, /^proc_[a-f0-9]{32}$/);
    const wrote = payload(await client.callTool({
      name: 'aicc_workspace_write_stdin',
      arguments: {
        workspace_id: binding.workspace_id,
        lease: binding.lease,
        request_id: 'interactive-stdin-0001',
        session_id: interactive.session_id,
        chars: 'hello\n',
        output_cursor: 0
      }
    }));
    assert.equal(wrote.ok, true);
    await new Promise(resolve => setTimeout(resolve, 100));
    const polled = payload(await client.callTool({
      name: 'aicc_workspace_write_stdin',
      arguments: {
        workspace_id: binding.workspace_id,
        lease: binding.lease,
        request_id: 'interactive-poll-0001',
        session_id: interactive.session_id,
        chars: '',
        output_cursor: 0
      }
    }));
    assert.match(polled.output, /stdin:hello/);

    const stoppable = payload(await client.callTool({
      name: 'aicc_workspace_exec',
      arguments: {
        workspace_id: binding.workspace_id,
        lease: binding.lease,
        request_id: 'stoppable-command-0001',
        command: 'while :; do sleep 1; done',
        yield_time_ms: 50
      }
    }));
    const stopped = payload(await client.callTool({
      name: 'aicc_workspace_process_stop',
      arguments: {
        workspace_id: binding.workspace_id,
        lease: binding.lease,
        request_id: 'stoppable-stop-0001',
        session_id: stoppable.session_id
      }
    }));
    assert.equal(stopped.stopped, true);
    await new Promise(resolve => setTimeout(resolve, 100));
  } else if (process.platform === 'darwin') t.diagnostic('nested sandbox-exec is unavailable in this test host; command execution assertions were not run');
  const closed = await client.callTool({
    name: 'aicc_workspace_close',
    arguments: { workspace_id: binding.workspace_id, lease: binding.lease }
  });
  assert.equal(payload(closed).closed, true);
  const afterClose = await client.callTool({
    name: 'aicc_workspace_read',
    arguments: { workspace_id: binding.workspace_id, lease: binding.lease, path: 'README.md' }
  });
  assert.equal(afterClose.isError, true);
});

test('Workspace Fast Read opens, searches, and reads while the job writer lock is active', async t => {
  const paths = fixture(t);
  fs.writeFileSync(path.join(paths.workspace, '.env.example'), 'SYNTHETIC_FIXTURE=blocked\n');
  fs.rmSync(path.join(paths.workspace, '.git'), { recursive: true, force: true });
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'workspace-fast-read@example.invalid'],
    ['config', 'user.name', 'Workspace Fast Read'],
    ['add', '.'],
    ['commit', '-qm', 'fixture']
  ]) {
    const result = spawnSync(GIT_EXECUTABLE, ['-C', paths.workspace, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  const clock = 1_700_000_000_000;
  const jobsRoot = path.join(paths.root, 'jobs');
  const readsRoot = path.join(paths.root, 'read-sessions');
  const durableStore = new DurableJobStore({
    root: jobsRoot,
    now: () => clock,
    pid: 99,
    isProcessAlive: pid => pid === 77
  });
  const readSessionStore = new DurableJobStore({ root: readsRoot, now: () => clock });
  fs.writeFileSync(path.join(jobsRoot, 'writer.lock'), JSON.stringify({
    pid: 77,
    createdAt: clock - 1_000
  }), { mode: 0o600 });
  const source = {
    ...config(paths.workspace),
    remoteAuthority: {
      identityBinding: 'remote_concurrent_reader',
      defaultMode: 'read-only',
      writePolicy: 'guarded'
    }
  };
  const fastReadCoordinator = new WorkspaceFastReadCoordinator({
    allowedRoots: [paths.workspace],
    stateRoot: path.join(paths.root, 'snapshots'),
    toolSchemaHash: 'c'.repeat(64)
  });
  const client = await clientFor(t, source, paths.runtime, {
    durableStore,
    readSessionStore,
    fastReadCoordinator
  });

  assert.throws(
    () => durableStore.transaction('still-blocked', () => null),
    error => error.code === 'writer_busy'
  );
  const opened = payload(await client.callTool({
    name: 'aicc_workspace_open',
    arguments: { alias: 'fixture', correlation_id: 'fast-read-concurrent' }
  }));
  assert.equal(opened.mode, 'read-only');
  assert.equal(opened.fast_read.available, true);
  assert.equal(opened.fast_read.complete_workspace_view, true);
  const searched = payload(await client.callTool({
    name: 'aicc_workspace_search',
    arguments: {
      workspace_id: opened.workspace_id,
      lease: opened.lease,
      query: 'fixture',
      path: '.',
      files_only: false,
      max_results: 10
    }
  }));
  assert.equal(searched.results.some(line => line.includes('README.md')), true);
  assert.equal(searched.fast_read.cache_hit, false);
  const searchedAgain = payload(await client.callTool({
    name: 'aicc_workspace_search',
    arguments: {
      workspace_id: opened.workspace_id,
      lease: opened.lease,
      query: 'fixture',
      path: '.',
      files_only: false,
      max_results: 10
    }
  }));
  assert.equal(searchedAgain.fast_read.cache_hit, true);
  const read = payload(await client.callTool({
    name: 'aicc_workspace_read',
    arguments: { workspace_id: opened.workspace_id, lease: opened.lease, path: 'README.md' }
  }));
  assert.equal(read.text, '# fixture\n');
  assert.equal(read.fast_read.available, true);
  const page = payload(await client.callTool({
    name: 'aicc_workspace_read', arguments: { workspace_id: opened.workspace_id, lease: opened.lease,
      path: 'README.md', offset_bytes: 2, max_bytes: 4 }
  }));
  assert.equal(page.text, 'fixt');
  assert.equal(page.next_offset_bytes, 6);
  const raw = payload(await client.callTool({
    name: 'aicc_workspace_read', arguments: { workspace_id: opened.workspace_id, lease: opened.lease,
      path: 'README.md', encoding: 'base64', max_bytes: 3 }
  }));
  assert.equal(raw.data_base64, Buffer.from('# f').toString('base64'));
  const denied = await client.callTool({
    name: 'aicc_workspace_read', arguments: { workspace_id: opened.workspace_id, lease: opened.lease, path: '.env.example' }
  });
  assert.equal(denied.isError, true);
  const literal = payload(await client.callTool({
    name: 'aicc_workspace_search', arguments: { workspace_id: opened.workspace_id, lease: opened.lease,
      path: '.', query: '# fixture', files_only: false, max_results: 10 }
  }));
  assert.equal(literal.results.some(line => line.includes('README.md')), true);
  assert.equal(literal.results.some(line => line.includes('.env')), false);
  fs.writeFileSync(path.join(paths.workspace, 'late-untracked.txt'), 'fixture late\n');
  const live = payload(await client.callTool({
    name: 'aicc_workspace_search', arguments: { workspace_id: opened.workspace_id, lease: opened.lease,
      query: 'fixture', path: '.', files_only: false, max_results: 10 }
  }));
  assert.equal(live.fast_read.cache_hit, false);
  assert.equal(live.fast_read.complete_workspace_view, false);
  assert.equal(live.results.some(line => line.includes('late-untracked.txt')), true);
  fs.writeFileSync(path.join(paths.workspace, 'README.md'), '# changed after open\n');
  const staleRead = await client.callTool({
    name: 'aicc_workspace_read',
    arguments: { workspace_id: opened.workspace_id, lease: opened.lease, path: 'README.md' }
  });
  assert.equal(staleRead.isError, true);
  assert.match(payload(staleRead).error, /workspace state changed/);
  assert.equal(Object.values(durableStore.read().state.remoteLeases).length, 0);
  assert.equal(Object.values(readSessionStore.read().state.remoteLeases).length, 1);
});

test('live search streams past the child output budget instead of failing ENOBUFS', async t => {
  const paths = fixture(t);
  for (let index = 0; index < 200; index += 1) {
    fs.writeFileSync(path.join(paths.workspace, `overflow-${String(index).padStart(3, '0')}.txt`), 'overflow-search-canary\n');
  }
  const source = config(paths.workspace);
  source.permissions.maxOutputBytes = 256;
  const client = await clientFor(t, source, paths.runtime);
  const opened = payload(await client.callTool({
    name: 'aicc_workspace_open',
    arguments: {
      alias: 'fixture', mode: 'write', correlation_id: 'overflow-search-open',
      approval_ref: 'overflow-approval', job_id: 'overflow-job', attempt_id: 'overflow-attempt'
    }
  }));
  const searched = payload(await client.callTool({
    name: 'aicc_workspace_search',
    arguments: {
      workspace_id: opened.workspace_id,
      lease: opened.lease,
      query: 'overflow-search-canary',
      path: '.',
      files_only: false,
      max_results: 3
    }
  }));
  assert.equal(searched.ok, true);
  assert.equal(searched.results.length, 3);
  assert.equal(searched.truncated, true);
  assert.equal(searched.limit_reason, 'max_results');
  assert.equal(searched.result_bytes <= 256, true);
});

test('personal surface advertises only read-fetch tools and cannot request a write lease', async t => {
  const paths = fixture(t);
  const source = {
    ...config(paths.workspace),
    surfaceProfile: 'personal-read-fetch',
    permissions: { commands: false, network: false, files: 'read-only', maxReadBytes: 1_048_576, maxOutputBytes: 262_144 },
    remoteAuthority: {
      identityBinding: 'remote_personal_fixture',
      defaultMode: 'read-only',
      writePolicy: 'read-only'
    }
  };
  const client = await clientFor(t, source, paths.runtime);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 18);
  assert.equal(listed.tools.some(tool => tool.name === 'aicc_workspace_apply_patch'), false);
  assert.equal(listed.tools.some(tool => tool.name === 'aicc_workspace_exec'), false);
  const openTool = listed.tools.find(tool => tool.name === 'aicc_workspace_open');
  assert.equal(openTool.annotations.readOnlyHint, true);
  assert.equal(openTool.annotations.destructiveHint, false);
  assert.equal(openTool.inputSchema.properties.mode.const, 'read-only');
  const rejected = await client.callTool({
    name: 'aicc_workspace_open',
    arguments: { alias: 'fixture', mode: 'write', correlation_id: 'personal-write-rejected' }
  });
  assert.equal(rejected.isError, true);
  const opened = payload(await client.callTool({
    name: 'aicc_workspace_open',
    arguments: { alias: 'fixture', correlation_id: 'personal-read-open' }
  }));
  assert.equal(opened.mode, 'read-only');
  assert.equal(payload(await client.callTool({
    name: 'aicc_workspace_read',
    arguments: { workspace_id: opened.workspace_id, lease: opened.lease, path: 'README.md' }
  })).text, '# fixture\n');
});

test('read-only remote lease cannot invoke writes and replayed write request is rejected', async t => {
  const paths = fixture(t);
  const client = await clientFor(t, config(paths.workspace), paths.runtime);
  const readOpen = payload(await client.callTool({ name: 'aicc_workspace_open', arguments: { alias: 'fixture', correlation_id: 'correlation-readonly' } }));
  const denied = await client.callTool({
    name: 'aicc_workspace_apply_patch',
    arguments: { workspace_id: readOpen.workspace_id, lease: readOpen.lease, request_id: 'read-write-denied', patch: '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# fixture\n+# denied\n' }
  });
  assert.equal(denied.isError, true);

  const writeOpen = payload(await client.callTool({
    name: 'aicc_workspace_open',
    arguments: { alias: 'fixture', mode: 'write', correlation_id: 'correlation-replay', approval_ref: 'approval-replay', job_id: 'durable-job-replay', attempt_id: 'durable-attempt-replay' }
  }));
  const patch = { workspace_id: writeOpen.workspace_id, lease: writeOpen.lease, request_id: 'write-replay-0001', patch: '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# fixture\n+# once\n' };
  if (NESTED_SANDBOX_EXEC_AVAILABLE) {
    assert.equal((await client.callTool({ name: 'aicc_workspace_apply_patch', arguments: patch })).isError, undefined);
    assert.equal((await client.callTool({ name: 'aicc_workspace_apply_patch', arguments: patch })).isError, true);
  } else if (process.platform === 'darwin') t.diagnostic('nested sandbox-exec is unavailable in this test host; replay execution assertions were not run');
});

test('owner-unrestricted workspace defaults to write without approval or durable job fields', async t => {
  const paths = fixture(t);
  const source = {
    ...config(paths.workspace),
    remoteAuthority: {
      identityBinding: 'remote_fixture_identity',
      defaultMode: 'write',
      writePolicy: 'owner-unrestricted'
    }
  };
  const client = await clientFor(t, source, paths.runtime, { writerAuthorizer: null });
  const opened = payload(await client.callTool({
    name: 'aicc_workspace_open',
    arguments: { alias: 'fixture', correlation_id: 'owner-open-default-write' }
  }));
  assert.equal(opened.mode, 'write');
  assert.equal(opened.writer_lease_ref.startsWith('owner_writer_'), true);
  if (NESTED_SANDBOX_EXEC_AVAILABLE) {
    const executed = await client.callTool({
      name: 'aicc_workspace_exec',
      arguments: {
        workspace_id: opened.workspace_id,
        lease: opened.lease,
        request_id: 'owner-exec-request-1',
        command: "printf 'owner-write-ok' > owner-output.txt",
        yield_time_ms: 500
      }
    });
    assert.equal(executed.isError, undefined, JSON.stringify(payload(executed)));
    assert.equal(fs.readFileSync(path.join(paths.workspace, 'owner-output.txt'), 'utf8'), 'owner-write-ok');
  } else if (process.platform === 'darwin') t.diagnostic('nested sandbox-exec is unavailable in this test host; owner write execution assertion was not run');
  const closed = payload(await client.callTool({
    name: 'aicc_workspace_close',
    arguments: { workspace_id: opened.workspace_id, lease: opened.lease }
  }));
  assert.equal(closed.closed, true);
  const reopened = payload(await client.callTool({
    name: 'aicc_workspace_open',
    arguments: { alias: 'fixture', correlation_id: 'owner-open-after-close' }
  }));
  assert.equal(reopened.mode, 'write');
});

test('sandbox profile confines file access and patch headers are workspace-relative', t => {
  const paths = fixture(t);
  const profile = sandboxProfile(paths.workspace, paths.runtime, false);
  assert.match(profile, /deny file-read/);
  assert.match(profile, /deny file-write/);
  assert.match(profile, /deny network/);
  assert.equal(profile.includes('\\.env'), true);
  assert.deepEqual(__testing.validatePatchPaths(paths.workspace, '--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n'), ['README.md']);
  assert.throws(() => __testing.validatePatchPaths(paths.workspace, '--- a/README.md\n+++ b/../outside\n'), /벗어납니다/);
});

test('workspace command timeout terminates the whole process session', async t => {
  if (!NESTED_SANDBOX_EXEC_AVAILABLE) return t.skip('nested macOS sandbox-exec is unavailable in this test host');
  const paths = fixture(t);
  const source = {
    ...config(paths.workspace),
    permissions: { ...config(paths.workspace).permissions, commandTimeoutMs: 1_000 },
    remoteAuthority: {
      identityBinding: 'remote_timeout_identity', defaultMode: 'write', writePolicy: 'owner-unrestricted'
    }
  };
  const client = await clientFor(t, source, paths.runtime, { writerAuthorizer: null });
  const opened = payload(await client.callTool({
    name: 'aicc_workspace_open', arguments: { alias: 'fixture', correlation_id: 'timeout-open-write' }
  }));
  const started = payload(await client.callTool({
    name: 'aicc_workspace_exec',
    arguments: {
      workspace_id: opened.workspace_id, lease: opened.lease, request_id: 'timeout-exec-request',
      command: '/bin/sleep 10', yield_time_ms: 100
    }
  }));
  assert.equal(started.running, true);
  await new Promise(resolve => setTimeout(resolve, 1_300));
  const ended = __testing.processSession(started.session_id);
  assert.equal(ended.running, false);
  assert.equal(ended.timed_out, true);
  assert.equal(ended.terminal_reason, 'command_timeout');
});

test('workspace lease expiry terminates commands before releasing the writer', async t => {
  if (!NESTED_SANDBOX_EXEC_AVAILABLE) return t.skip('nested macOS sandbox-exec is unavailable in this test host');
  const paths = fixture(t);
  const source = {
    ...config(paths.workspace),
    remoteAuthority: {
      identityBinding: 'remote_expiry_identity', defaultMode: 'write', writePolicy: 'owner-unrestricted'
    }
  };
  const client = await clientFor(t, source, paths.runtime, { writerAuthorizer: null });
  const opened = payload(await client.callTool({
    name: 'aicc_workspace_open',
    arguments: { alias: 'fixture', correlation_id: 'expiry-open-write', expires_in_seconds: 1 }
  }));
  const started = payload(await client.callTool({
    name: 'aicc_workspace_exec',
    arguments: {
      workspace_id: opened.workspace_id, lease: opened.lease, request_id: 'expiry-exec-request',
      command: '/bin/sleep 10', yield_time_ms: 100
    }
  }));
  assert.equal(started.running, true);
  await new Promise(resolve => setTimeout(resolve, 1_300));
  const ended = __testing.processSession(started.session_id);
  assert.equal(ended.running, false);
  assert.equal(ended.timed_out, false);
  assert.equal(ended.terminal_reason, 'lease_expired');
});

test('workspace command spawn failure is contained in the process session', () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const session = {
    child,
    output: '',
    exitCode: null,
    truncated: false,
    timedOut: false,
    terminalReason: null,
    timeoutTimer: setTimeout(() => {}, 60_000),
    forceKillTimer: null,
    maxOutputBytes: 262_144
  };
  __testing.bindProcessSession(child, session);
  child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
  assert.equal(session.exitCode, 1);
  assert.equal(session.child, null);
  assert.equal(session.terminalReason, 'process_spawn_error');
  assert.equal(session.timeoutTimer, null);
  assert.match(session.output, /process_spawn_error.*ENOENT/);
  child.emit('close', -1);
  assert.equal(session.exitCode, 1);
});

test('workspace lifecycle holds incomplete output after observed process exit', () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const session = { child, id: 'exit-before-close', output: '', exitCode: null,
    maxOutputBytes: 4096, cleanupFiles: [], timeoutTimer: setTimeout(() => {}, 60_000),
    forceKillTimer: setTimeout(() => {}, 60_000) };
  __testing.bindProcessSession(child, session);
  child.emit('exit', 7, null);
  assert.equal(session.osExitObserved, true);
  assert.equal(session.osExitCode, 7);
  assert.equal(session.osExitSignal, null);
  assert.equal(session.exitCode, null);
  assert.equal(session.child, child);
  assert.notEqual(session.outputComplete, true);
  assert.equal(session.timeoutTimer, null);
  assert.equal(session.forceKillTimer, null);
  child.stdout.write('late child output');
  assert.equal(session.output, 'late child output');
  child.emit('close', 7);
  assert.equal(session.outputComplete, true);
  assert.equal(session.exitCode, 7);
  assert.equal(session.child, null);
});

test('workspace lifecycle preserves signal exit without successful completion', () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const session = { child, id: 'signal-exit', output: '', exitCode: null,
    maxOutputBytes: 4096, cleanupFiles: [], terminalReason: 'requested_stop' };
  __testing.bindProcessSession(child, session);
  child.emit('exit', null, 'SIGTERM');
  assert.equal(session.osExitCode, null);
  assert.equal(session.osExitSignal, 'SIGTERM');
  assert.equal(session.exitCode, null);
  child.emit('close', null);
  assert.equal(session.exitCode, 1);
  assert.equal(session.outputComplete, true);
  assert.equal(session.terminalReason, 'requested_stop');
});

test('workspace stop response preserves nonzero exit and incomplete output without sending another signal', () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { throw new Error('exited process must not be signaled'); };
  const session = { child, id: 'stop-after-exit', output: '', exitCode: null,
    maxOutputBytes: 4096, cleanupFiles: [] };
  __testing.bindProcessSession(child, session);
  child.emit('exit', 7, null);
  const pending = __testing.processStopResult(session);
  assert.equal(pending.stopped, false);
  assert.equal(pending.already_exited, true);
  assert.equal(pending.awaiting_output_close, true);
  assert.equal(pending.os_exit_code, 7);
  assert.equal(pending.exit_code, null);
  assert.equal(pending.running, true);
  assert.equal(session.forceKillTimer, null);
  assert.equal(session.terminalReason, undefined);
  child.stdout.write('late stderr and stdout remain available');
  child.emit('close', 7);
  const closed = __testing.processStopResult(session);
  assert.equal(closed.stopped, false);
  assert.equal(closed.already_exited, true);
  assert.equal(closed.awaiting_output_close, false);
  assert.equal(closed.running, false);
  assert.equal(closed.output_complete, true);
  assert.equal(closed.exit_code, 7);
  assert.equal(closed.ok, false);
  assert.equal(closed.output, 'late stderr and stdout remain available');
});

test('workspace stop response reports an actual signal request until exit and output close', () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const signals = [];
  child.kill = signal => { signals.push(signal); return true; };
  const session = { child, id: 'stop-live', output: '', exitCode: null,
    maxOutputBytes: 4096, cleanupFiles: [] };
  __testing.bindProcessSession(child, session);
  const live = __testing.processStopResult(session);
  assert.equal(live.stopped, true);
  assert.equal(live.already_exited, false);
  assert.equal(live.awaiting_output_close, false);
  assert.equal(live.running, true);
  assert.equal(live.exit_code, null);
  assert.deepEqual(signals, ['SIGTERM']);
  child.emit('exit', null, 'SIGTERM');
  const pending = __testing.processStopResult(session);
  assert.equal(pending.stopped, false);
  assert.equal(pending.awaiting_output_close, true);
  assert.equal(pending.os_exit_signal, 'SIGTERM');
  assert.deepEqual(signals, ['SIGTERM']);
  child.emit('close', null);
  const closed = __testing.processStopResult(session);
  assert.equal(closed.exit_code, 1);
  assert.equal(closed.ok, false);
  assert.equal(closed.awaiting_output_close, false);
});
