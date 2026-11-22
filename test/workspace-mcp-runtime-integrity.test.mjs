import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  WORKSPACE_MCP_RUNTIME_SOURCES,
  assertWorkspaceMcpRuntimeClosure,
  buildWorkspaceRuntimeSnapshot,
  hashWorkspaceRuntimeSnapshot,
  parseWorkspaceRuntimeImports,
  workspaceMcpRuntimeClosureAudit,
  workspaceMcpRuntimeHash
} from '../components/workspace-mcp/runtime-integrity.mjs';
import { inspectWorkspaceRuntimeMarker, processStartToken, processStartTokens, startWorkspaceRuntimeMarker, workspaceRuntimeStartGuard } from '../components/workspace-mcp/runtime-marker.mjs';
import { overlayPidReuseGuard, verifyRecordedManifestReconciliation } from '../tools/platform/windows/stage-workspace-home.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('STDIO start guard preserves live and unknown owners and serializes marker creation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-stdio-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  assert.deepEqual(workspaceRuntimeStartGuard(configPath), { allowed: true, reason: 'no_runtime' });
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime);
  const markerFile = path.join(runtime, 'remote-authority-status.json');
  const bytes = JSON.stringify({ process: { pid: process.pid } });
  fs.writeFileSync(markerFile, bytes);
  assert.equal(workspaceRuntimeStartGuard(configPath).reason, 'runtime_owner_active');
  assert.throws(() => startWorkspaceRuntimeMarker({}, configPath), /runtime_owner_active/);
  assert.equal(fs.readFileSync(markerFile, 'utf8'), bytes);
  assert.equal(fs.existsSync(path.join(runtime, 'startup.lock')), false);
  assert.equal(workspaceRuntimeStartGuard(configPath, { signalProcess: () => { throw Object.assign(new Error(), { code: 'EPERM' }); } }).allowed, false);
  assert.equal(workspaceRuntimeStartGuard(configPath, { signalProcess: () => { throw Object.assign(new Error(), { code: 'ESRCH' }); } }).allowed, true);
  fs.writeFileSync(markerFile, 'broken');
  assert.equal(workspaceRuntimeStartGuard(configPath).reason, 'runtime_marker_invalid');
  fs.writeFileSync(markerFile, '{}');
  assert.equal(workspaceRuntimeStartGuard(configPath).reason, 'runtime_owner_unknown');
  fs.writeFileSync(path.join(runtime, 'startup.lock'), JSON.stringify({ pid: process.pid }));
  assert.equal(workspaceRuntimeStartGuard(configPath).reason, 'startup_locked');
  assert.throws(() => startWorkspaceRuntimeMarker({}, configPath), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(path.join(runtime, 'startup.lock'), 'utf8'), JSON.stringify({ pid: process.pid }));
});

function copyRuntimeClosure() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-runtime-'));
  for (const relative of WORKSPACE_MCP_RUNTIME_SOURCES) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, relative), destination);
  }
  return root;
}

test('start guard proves reused PID with fresh token and preserves unknown identity', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-reused-owner-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const configPath=path.join(root,'config.json'),runtime=path.join(root,'runtime');
  fs.mkdirSync(runtime);
  const file=path.join(runtime,'remote-authority-status.json');
  const original=JSON.stringify({process:{pid:32101,processStartToken:'a'.repeat(64)}});
  fs.writeFileSync(file,original);
  const base={platform:'win32',signalProcess(pid,signal){assert.equal(pid,32101);assert.equal(signal,0);}};
  assert.deepEqual(workspaceRuntimeStartGuard(configPath,{...base,readProcessStartToken:()=> 'b'.repeat(64)}),{allowed:true,reason:'runtime_owner_pid_reused'});
  assert.equal(workspaceRuntimeStartGuard(configPath,{...base,readProcessStartToken:()=> 'a'.repeat(64)}).reason,'runtime_owner_active');
  assert.equal(workspaceRuntimeStartGuard(configPath,{...base,readProcessStartToken:()=> null}).reason,'runtime_owner_unknown');
  assert.equal(workspaceRuntimeStartGuard(configPath,{...base,readProcessStartToken:()=>{throw new Error('unavailable');}}).allowed,false);
  assert.equal(workspaceRuntimeStartGuard(configPath,{...base,readProcessStartToken:()=>{throw Object.assign(new Error('raced'),{code:'ESRCH'});}}).reason,'runtime_owner_unknown');
  assert.equal(workspaceRuntimeStartGuard(configPath,{...base,signalProcess(){throw Object.assign(new Error('denied'),{code:'EPERM'});},readProcessStartToken(){assert.fail('Denied liveness is not bypassed');}}).allowed,false);
  const legacy={...base,platform:'linux',readProcessStartToken:()=> 'b'.repeat(64)};
  assert.equal(workspaceRuntimeStartGuard(configPath,{...legacy,readLegacyProcessStartToken:()=> 'a'.repeat(64)}).reason,'runtime_owner_active');
  assert.equal(workspaceRuntimeStartGuard(configPath,{...legacy,readLegacyProcessStartToken:()=> null}).reason,'runtime_owner_unknown');
  assert.equal(workspaceRuntimeStartGuard(configPath,{...legacy,readLegacyProcessStartToken:()=> 'c'.repeat(64)}).reason,'runtime_owner_pid_reused');
  assert.equal(fs.readFileSync(file,'utf8'),original);
});

test('PID guard overlay preserves baseline-only edits and rejects changed identity dependencies', () => {
  const canonical=fs.readFileSync(path.join(repositoryRoot,'components/workspace-mcp/runtime-marker.mjs'),'utf8');
  const guard=/function markerOwnerGuard\(marker, options\) \{[\s\S]*?\n\}/;
  const original=`function markerOwnerGuard(marker, options) {
  const pid = marker.process?.pid;
  if (!Number.isInteger(pid) || pid < 1) return { allowed: false, reason: 'runtime_owner_unknown' };
  try {
    (options.signalProcess ?? process.kill)(pid, 0);
    return { allowed: false, reason: 'runtime_owner_active' };
  } catch (error) {
    return error.code === 'ESRCH'
      ? { allowed: true, reason: 'runtime_owner_stopped' }
      : { allowed: false, reason: 'runtime_owner_unknown' };
  }
}`;
  const baseline=canonical.replace(guard,original)+'\n// baseline-only edit must survive\n';
  const result=overlayPidReuseGuard(baseline,canonical);
  assert.equal(result,canonical+'\n// baseline-only edit must survive\n');
  assert.equal(overlayPidReuseGuard(result,canonical),result);
  assert.throws(()=>overlayPidReuseGuard(baseline.replace('15_000','14_000'),canonical),/identity dependency differs/);
  assert.throws(()=>overlayPidReuseGuard(baseline.replace("reason: 'runtime_owner_active'","reason: 'foreign_owner_active'"),canonical),/supported baseline/);
});

test('PID guard stage accepts only the recorded inventory reconciliation', () => {
  const previous={schemaVersion:1,files:[{path:'tools/platform/windows/Invoke-AiccWorkspaceSandbox.ps1',sha256:'a'.repeat(64),size:10},{path:'unchanged',sha256:'b'.repeat(64),size:7}],fileCount:2,totalBytes:17};
  const record={changedInventoryOnly:true,path:previous.files[0].path,sha256:'c'.repeat(64),originalManifestSha256:'d'.repeat(64)};
  const current=structuredClone(previous);current.files[0].sha256=record.sha256;current.files[0].size=12;current.totalBytes=19;current.appContainerReconciliation=record;
  assert.doesNotThrow(()=>verifyRecordedManifestReconciliation(current,previous,record,{sha256:record.sha256,size:12}));
  current.files[1].sha256='e'.repeat(64);
  assert.throws(()=>verifyRecordedManifestReconciliation(current,previous,record,{sha256:record.sha256,size:12}),/unrelated inventory/);
});

test('local runtime inventory checks all pending owners and never ignores unknown state', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-local-runtime-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const instanceNames = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  for (const [index, instanceId] of instanceNames.entries()) {
    const directory = path.join(root, 'runtime', 'local-stdio', instanceId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'remote-authority-status.json'), JSON.stringify({ instanceId, phase: 'pending', process: { pid: 100 + index } }));
  }
  const signalProcess = pid => { if (pid === 100) throw Object.assign(new Error('stopped'), { code: 'ESRCH' }); };
  assert.equal(workspaceRuntimeStartGuard(configPath, { signalProcess }).reason, 'runtime_owner_active');
  assert.equal(workspaceRuntimeStartGuard(configPath, { signalProcess, allowLocalInstances: true }).allowed, true);
  assert.equal(workspaceRuntimeStartGuard(configPath, { allowLocalInstances: true, signalProcess: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } }).allowed, false);
  const first = path.join(root, 'runtime', 'local-stdio', instanceNames[0], 'remote-authority-status.json');
  fs.writeFileSync(first, '{');
  assert.equal(workspaceRuntimeStartGuard(configPath, { signalProcess, allowLocalInstances: true }).reason, 'local_runtime_invalid');
  fs.unlinkSync(first);
  assert.equal(workspaceRuntimeStartGuard(configPath, { signalProcess, allowLocalInstances: true }).allowed, false);
});

test('local start refuses a remote identity or changed config and releases only its own startup lock', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-local-runtime-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const config = { transport: { mode: 'local-stdio' }, remoteAuthority: { identityBinding: `local_${'a'.repeat(24)}`, authenticationOwner: 'codex-local-stdio' } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  assert.throws(() => startWorkspaceRuntimeMarker({ ...config, remoteAuthority: { identityBinding: 'remote_fixture' } }, configPath), /dedicated local identity/);
  assert.throws(() => startWorkspaceRuntimeMarker(config, configPath, { expectedConfigHash: '0'.repeat(64) }), /config changed/);
  assert.equal(fs.existsSync(path.join(root, 'runtime', 'startup.lock')), false);
  assert.equal(fs.existsSync(path.join(root, 'runtime', 'local-stdio')), false);
  assert.throws(() => startWorkspaceRuntimeMarker(config, configPath, {
    platform: 'win32', spawnSync: () => ({ status: 1 })
  }), /process start identity is unavailable/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'runtime', 'local-stdio')), []);
});

test('runtime hash allowlist exactly matches the server static import closure', () => {
  const audit = assertWorkspaceMcpRuntimeClosure(repositoryRoot);
  assert.equal(audit.ok, true);
  assert.equal(audit.closure.length, WORKSPACE_MCP_RUNTIME_SOURCES.length);
  assert.deepEqual(audit.closure, [...WORKSPACE_MCP_RUNTIME_SOURCES].sort());
  assert.deepEqual(audit.missing, []);
  assert.deepEqual(audit.extra, []);
});

test('runtime hash changes when any imported runtime source byte changes', () => {
  const root = copyRuntimeClosure();
  try {
    const baseline = workspaceMcpRuntimeHash(root);
    for (const relative of WORKSPACE_MCP_RUNTIME_SOURCES) {
      const file = path.join(root, relative);
      const original = fs.readFileSync(file);
      fs.appendFileSync(file, '\n// runtime-integrity-byte-change\n');
      assert.notEqual(workspaceMcpRuntimeHash(root), baseline, relative);
      fs.writeFileSync(file, original);
      assert.equal(workspaceMcpRuntimeHash(root), baseline, relative);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('closure audit reports missing and stale allowlist entries', () => {
  const withoutFastRead = WORKSPACE_MCP_RUNTIME_SOURCES
    .filter(relative => relative !== 'components/workspace-mcp/fast-read.mjs');
  const missing = workspaceMcpRuntimeClosureAudit(repositoryRoot, withoutFastRead);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['components/workspace-mcp/fast-read.mjs']);
  assert.deepEqual(missing.extra, []);

  const withStaleEntry = [...WORKSPACE_MCP_RUNTIME_SOURCES, 'components/workspace-mcp/stale.mjs'];
  const extra = workspaceMcpRuntimeClosureAudit(repositoryRoot, withStaleEntry);
  assert.equal(extra.ok, false);
  assert.deepEqual(extra.missing, []);
  assert.deepEqual(extra.extra, ['components/workspace-mcp/stale.mjs']);
});

test('a newly imported local runtime module fails closed until explicitly reviewed', () => {
  const root = copyRuntimeClosure();
  try {
    const newModule = 'components/workspace-mcp/new-runtime-path.mjs';
    fs.writeFileSync(path.join(root, newModule), 'export const newRuntimePath = true;\n');
    fs.appendFileSync(
      path.join(root, 'components/workspace-mcp/server.mjs'),
      "\nimport './new-runtime-path.mjs';\n"
    );
    const audit = workspaceMcpRuntimeClosureAudit(root);
    assert.equal(audit.ok, false);
    assert.deepEqual(audit.missing, [newModule]);
    assert.throws(
      () => workspaceMcpRuntimeHash(root),
      /runtime hash closure mismatch/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parser ignores comments and strings while covering multiline imports, re-exports, and literal dynamic imports', () => {
  const imports = parseWorkspaceRuntimeImports(Buffer.from(`
    const fake = "import './not-real.mjs'";
    // import './also-not-real.mjs';
    import {
      value
    } from './named.mjs';
    export { other } from './reexport.mjs';
    export * from './all.mjs';
    await import('./dynamic.mjs');
  `), 'entry.mjs');
  assert.deepEqual(imports, [
    './all.mjs',
    './dynamic.mjs',
    './named.mjs',
    './reexport.mjs'
  ]);
});

test('nonliteral dynamic imports and unreviewed runtime loaders fail closed', () => {
  assert.throws(
    () => parseWorkspaceRuntimeImports(Buffer.from('await import(target);\n'), 'entry.mjs'),
    error => error.code === 'workspace_runtime_dynamic_import_unreviewed'
  );
  assert.throws(
    () => parseWorkspaceRuntimeImports(
      Buffer.from("new Worker(new URL('./worker.mjs', import.meta.url));\n"),
      'entry.mjs'
    ),
    error => error.code === 'workspace_runtime_dynamic_import_unreviewed'
  );
  assert.throws(
    () => parseWorkspaceRuntimeImports(
      Buffer.from("import { createRequire } from 'node:module';\ncreateRequire(import.meta.url);\n"),
      'entry.mjs'
    ),
    error => error.code === 'workspace_runtime_dynamic_import_unreviewed'
  );
});

test('duplicate runtime allowlist entries are rejected instead of normalized away', () => {
  const audit = workspaceMcpRuntimeClosureAudit(
    repositoryRoot,
    [...WORKSPACE_MCP_RUNTIME_SOURCES, WORKSPACE_MCP_RUNTIME_SOURCES[0]]
  );
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.duplicates, [WORKSPACE_MCP_RUNTIME_SOURCES[0]]);
});

test('runtime snapshot rejects final and ancestor symlinks, including external realpaths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-symlink-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'external.mjs'), 'export const external = true;\n');
    fs.symlinkSync(path.join(outside, 'external.mjs'), path.join(root, 'entry.mjs'));
    assert.throws(
      () => buildWorkspaceRuntimeSnapshot(root, ['entry.mjs']),
      error => error.code === 'SOURCE_PATH_IDENTITY_HOLD'
    );

    fs.unlinkSync(path.join(root, 'entry.mjs'));
    fs.mkdirSync(path.join(root, 'real'));
    fs.writeFileSync(path.join(root, 'real', 'entry.mjs'), 'export const inside = true;\n');
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));
    assert.throws(
      () => buildWorkspaceRuntimeSnapshot(root, ['alias/entry.mjs']),
      error => error.code === 'SOURCE_PATH_IDENTITY_HOLD'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('runtime hash uses the sealed byte snapshot and rejects a later file swap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-snapshot-'));
  try {
    fs.writeFileSync(path.join(root, 'entry.mjs'), 'export const value = 1;\n');
    const snapshot = buildWorkspaceRuntimeSnapshot(root, ['entry.mjs']);
    fs.writeFileSync(path.join(root, 'entry.mjs'), 'export const value = 2;\n');
    assert.throws(
      () => hashWorkspaceRuntimeSnapshot(snapshot, ['entry.mjs']),
      error => error.code === 'SOURCE_CHANGED_DURING_SEAL'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extensionless and case-aliased local imports are rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-import-'));
  try {
    fs.writeFileSync(path.join(root, 'dependency.mjs'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(root, 'entry.mjs'), "import './dependency';\n");
    assert.throws(
      () => buildWorkspaceRuntimeSnapshot(root, ['entry.mjs']),
      error => error.code === 'SOURCE_CLOSURE_CONFLICT'
    );

    fs.writeFileSync(path.join(root, 'CaseDependency.mjs'), 'export const value = 2;\n');
    fs.writeFileSync(path.join(root, 'entry.mjs'), "import './casedependency.mjs';\n");
    assert.throws(() => buildWorkspaceRuntimeSnapshot(root, ['entry.mjs']));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime marker uses bounded heartbeat and launchd PID proof only when start-token reads are unavailable', () => {
  const now = Date.now();
  const processPid = 32101;
  const supervisorPid = 32100;
  const sourceIdentity = { runtimeHash: '1'.repeat(64) };
  const installedIdentity = { nodeExecSha256: '2'.repeat(64) };
  const marker = {
    schemaVersion: 4,
    phase: 'ready',
    instanceId: '11111111-1111-4111-8111-111111111111',
    supervisorGeneration: '3'.repeat(64),
    process: { pid: processPid, processStartToken: '4'.repeat(64) },
    supervisor: { pid: supervisorPid, processStartToken: '5'.repeat(64) },
    heartbeatAt: new Date(now - 1_000).toISOString(),
    transport: { type: 'stdio', connected: true, readySignalId: '6'.repeat(32) },
    sourceIdentity,
    installedIdentity
  };
  const expected = { sourceIdentity, installedIdentity };
  const fallback = inspectWorkspaceRuntimeMarker(marker, expected, {
    now: () => now,
    readProcessStartToken: () => null,
    signalProcess: pid => { if (![processPid, supervisorPid].includes(pid)) throw Object.assign(new Error('missing'), { code: 'ESRCH' }); },
    allowHeartbeatLivenessFallback: true,
    expectedSupervisorPid: supervisorPid,
    supervisorReady: true
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.identityProof.process, 'fresh-heartbeat-and-live-pid');
  assert.equal(fallback.identityProof.supervisor, 'launchd-pid-fresh-heartbeat-and-live-pid');

  const wrongSupervisor = inspectWorkspaceRuntimeMarker(marker, expected, {
    now: () => now,
    readProcessStartToken: () => null,
    signalProcess: () => {},
    allowHeartbeatLivenessFallback: true,
    expectedSupervisorPid: supervisorPid + 1,
    supervisorReady: true
  });
  assert.equal(wrongSupervisor.reasons.includes('supervisor_identity'), true);

  const tokenMismatch = inspectWorkspaceRuntimeMarker(marker, expected, {
    now: () => now,
    readProcessStartToken: () => '7'.repeat(64),
    signalProcess: () => {},
    allowHeartbeatLivenessFallback: true,
    expectedSupervisorPid: supervisorPid,
    supervisorReady: true
  });
  assert.equal(tokenMismatch.reasons.includes('process_identity'), true);
  assert.equal(tokenMismatch.reasons.includes('supervisor_identity'), true);
});

test('process start token normalizes locale and timezone before hashing ps output', () => {
  let observed = null;
  const token = processStartToken(32101, {
    platform: 'linux',
    env: { LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', TZ: 'Asia/Seoul' },
    spawnSync(executable, args, options) {
      observed = { executable, args, options };
      return { status: 0, stdout: 'Tue Aug 25 09:07:01 2026\n' };
    }
  });
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(observed.executable, '/bin/ps');
  assert.deepEqual(observed.args, ['-o', 'lstart=', '-p', '32101']);
  assert.equal(observed.options.env.LC_ALL, 'C');
  assert.equal(observed.options.env.LANG, 'C');
  assert.equal(observed.options.env.TZ, 'UTC');
});

test('process start token uses invariant PowerShell UTC ticks on Windows', () => {
  let observed = null;
  const token = processStartToken(32101, {
    platform: 'win32',
    env: { LANG: 'ko_KR.UTF-8' },
    spawnSync(executable, args, options) {
      observed = { executable, args, options };
      return { status: 0, stdout: '32101:639000000000000000' };
    }
  });
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(observed.executable, 'pwsh.exe');
  assert.deepEqual(observed.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(observed.args[3], /@\(32101\)/);
  assert.match(observed.args[3], /\[Diagnostics.Process\]::GetProcessById/);
  assert.doesNotMatch(observed.args[3], /Get-Process|Get-CimInstance/);
  assert.match(observed.args[3], /ToUniversalTime\(\)\.Ticks/);
  assert.match(observed.args[3], /InvariantCulture/);
  assert.equal(observed.options.env.LANG, 'ko_KR.UTF-8');
  assert.equal(observed.options.timeout, 15000);
  assert.equal(observed.options.shell, false);
});

test('Windows process identities batch both PIDs once and retain the existing token format', () => {
  let calls = 0;
  const tokens = processStartTokens([32101, 32100], {
    platform: 'win32',
    spawnSync(executable, args, options) {
      calls += 1;
      assert.match(args[3], /@\(32101,32100\)/);
      assert.equal(options.timeout, 15000);
      return { status: 0, stdout: '32101:639000000000000000\r\n32100:638999999999999999\r\n' };
    }
  });
  assert.equal(calls, 1);
  const single = processStartToken(32101, { platform: 'win32', spawnSync: () => ({ status: 0, stdout: '32101:639000000000000000' }) });
  assert.equal(tokens.get(32101), single);
  assert.equal(single, createHash('sha256').update('32101\0win32-start-ticks:639000000000000000').digest('hex'));
  assert.match(tokens.get(32100), /^[a-f0-9]{64}$/);
});

test('Windows process identity timeout, denied access, partial or malformed results never become proof', () => {
  for (const result of [
    { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), stdout: '32101:639000000000000000' },
    { status: 1, stdout: '32101:639000000000000000' },
    { status: 0, stdout: '32101:639000000000000000' },
    { status: 0, stdout: '32101:639000000000000000\n32101:639000000000000000' },
    { status: 0, stdout: '32101:639000000000000000\n9:639000000000000000' },
    { status: 0, stdout: '32101:639000000000000000\n32100:9999999999999999999' }
  ]) {
    const tokens = processStartTokens([32101, 32100], { platform: 'win32', spawnSync: () => result });
    assert.equal(tokens.get(32101), null);
    assert.equal(tokens.get(32100), null);
  }
  const tokens = processStartTokens([32101, 32100], { platform: 'win32', windowsProcessIdentityTimeoutMs: 999999, spawnSync(executable, args, options) {
    assert.equal(options.timeout, 15000);
    throw new Error('access denied');
  } });
  assert.equal(tokens.get(32101), null);
});

test('Native Windows batch reads stable current-process and supervisor identities without cached PID proof', { skip: process.platform !== 'win32' }, () => {
  const first = processStartTokens([process.pid, process.ppid]);
  const second = processStartTokens([process.pid, process.ppid]);
  for (const pid of [process.pid, process.ppid]) {
    assert.match(first.get(pid), /^[a-f0-9]{64}$/);
    assert.equal(second.get(pid), first.get(pid));
  }
});

test('Windows identity timeout never writes a starting or ready marker', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-identity-timeout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  assert.throws(() => startWorkspaceRuntimeMarker({ remoteAuthority: {} }, path.join(root, 'config.json'), {
    platform: 'win32',
    spawnSync() {
      calls += 1;
      return { status: null, error: Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' }) };
    }
  }), /process start identity is unavailable/);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(root, 'runtime', 'remote-authority-status.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'runtime', 'startup.lock')), false);
});

test('runtime marker accepts a sealed pre-fix local-time token during migration', () => {
  const now = Date.now();
  const sourceIdentity = { runtimeHash: '1'.repeat(64) };
  const installedIdentity = { nodeExecSha256: '2'.repeat(64) };
  const legacyProcess = '4'.repeat(64);
  const legacySupervisor = '5'.repeat(64);
  const marker = {
    schemaVersion: 4,
    phase: 'ready',
    instanceId: '11111111-1111-4111-8111-111111111111',
    supervisorGeneration: '3'.repeat(64),
    process: { pid: 32101, processStartToken: legacyProcess },
    supervisor: { pid: 32100, processStartToken: legacySupervisor },
    heartbeatAt: new Date(now - 1_000).toISOString(),
    transport: { type: 'stdio', connected: true, readySignalId: '6'.repeat(32) },
    sourceIdentity,
    installedIdentity
  };
  const inspection = inspectWorkspaceRuntimeMarker(marker, { sourceIdentity, installedIdentity }, {
    now: () => now,
    readProcessStartToken: () => '7'.repeat(64),
    readLegacyProcessStartToken: pid => pid === 32101 ? legacyProcess : legacySupervisor
  });
  assert.equal(inspection.ok, true);
  assert.equal(inspection.identityProof.process, 'legacy-local-process-start-token');
  assert.equal(inspection.identityProof.supervisor, 'legacy-local-process-start-token');
});
