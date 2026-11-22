import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { spawnSync as nativeSpawnSync } from 'node:child_process';
import { probeWorkspaceTunnel } from '../src/workspace-mcp.mjs';
import { installWorkspaceTunnelLaunchAgent, parseWorkspaceTunnelInstallArgs } from '../tools/platform/workspace-mcp/install-launch-agent.mjs';
import {
  installWorkspaceTunnelWindowsTask as installWindowsTask,
  parseWorkspaceTunnelWindowsTaskArgs,
  stopWorkspaceTunnelWindowsTask,
  windowsTaskBody,
  workspaceTaskLegacyAdoptable
} from '../tools/platform/workspace-mcp/install-windows-task.mjs';
import {
  importWindowsTunnelSecret, windowsTunnelDpapi, windowsTunnelSecretPaths,
  windowsTunnelSecretStatus, windowsTunnelDoctor, windowsTunnelIdleGuard,
  runWindowsTunnel, parseWindowsTunnelSecretArgs
} from '../tools/platform/workspace-mcp/windows-tunnel-secret.mjs';

const macOnlyTest = process.platform === 'win32' ? test.skip : test;

function installWorkspaceTunnelWindowsTask(options) {
  return installWindowsTask({ preflight: () => ({ ok: true }), ...options });
}

test('Windows secret helper accepts only exact supported surfaces and bounded input', () => {
  assert.throws(() => parseWindowsTunnelSecretArgs(['status', '--surface', 'pro']), /surface_required/);
  assert.throws(() => parseWindowsTunnelSecretArgs(['run', '--surface', 'business-full', '--key', 'secret']), /invalid_state_root/);
  assert.throws(() => windowsTunnelDpapi(Buffer.alloc(8193), 'Protect', { platform: 'win32', surfaceProfile: 'business-full' }), /invalid_secret_size/);
  assert.equal(windowsTunnelSecretPaths({ surfaceProfile: 'business-full' }).entropy, 'aicc-workspace-tunnel:v1:business-full');
  assert.equal(parseWorkspaceTunnelWindowsTaskArgs(['repair', '--surface', 'personal-read-fetch', '--dry-run']).action, 'repair');
});

test('Windows helper and installer fail closed on active, malformed and locked runtime state', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-tunnel-guard-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const fixture = createWindowsTunnelFixture(home);
  const options = { platform: 'win32', stateRoot: fixture.stateRoot, surfaceProfile: 'business-full' };
  const paths = windowsTunnelSecretPaths(options);
  fs.mkdirSync(path.join(paths.root, 'runtime'), { recursive: true });
  const marker = path.join(paths.root, 'runtime', 'remote-authority-status.json');
  fs.writeFileSync(marker, JSON.stringify({ process: { pid: process.pid } }));
  assert.equal(windowsTunnelIdleGuard(options).reason, 'runtime_owner_active');
  assert.throws(() => installWorkspaceTunnelWindowsTask({ ...options, userSid: 'S-1-5-21-1000', spawnSync() { assert.fail('No task calls while active'); } }), /runtime_owner_active/);
  fs.writeFileSync(marker, '{');
  assert.equal(windowsTunnelIdleGuard(options).allowed, false);
  fs.unlinkSync(marker);
  fs.mkdirSync(paths.runtime, { recursive: true });
  const pidFile = path.join(paths.runtime, `${paths.runtimeAlias}.pid`);
  fs.writeFileSync(pidFile, String(process.pid));
  assert.equal(windowsTunnelIdleGuard(options).reason, 'no_active_runtime');
  assert.equal(windowsTunnelIdleGuard({ ...options, ownerProbe() { return { status: 0, stdout: JSON.stringify({ state: 'present', executablePath: paths.binary }) }; } }).reason, 'tunnel_owner_active');
  fs.writeFileSync(pidFile, 'unknown');
  assert.equal(windowsTunnelIdleGuard(options).allowed, false);
  fs.unlinkSync(pidFile);
  fs.writeFileSync(paths.lock, '{}');
  assert.equal(windowsTunnelIdleGuard(options).reason, 'tunnel_helper_lock_unknown');
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, surfaceProfile: 'business-full' }));
  assert.equal(windowsTunnelIdleGuard(options).reason, 'tunnel_helper_locked');
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: 2147483647, surfaceProfile: 'business-full' }));
  const recovered = windowsTunnelIdleGuard({ ...options, signalProcess() {
    const error = new Error('missing');
    error.code = 'ESRCH';
    throw error;
  } });
  assert.deepEqual(recovered, { allowed: true, reason: 'no_active_runtime' });
  assert.equal(fs.existsSync(paths.lock), false);
});

test('DPAPI subprocess failure cannot expose captured output', () => {
  const captured = Buffer.from('fixture-sensitive-value');
  const stderr = Buffer.from('fixture-sensitive-error');
  assert.throws(() => windowsTunnelDpapi(Buffer.from('fixture'), 'Unprotect', {
    platform: 'win32', surfaceProfile: 'business-full',
    spawnSync() { return { status: 20, stdout: captured, stderr }; }
  }), /^Error: dpapi_operation_failed$/);
  assert.equal(captured.every(value => value === 0), true);
  assert.equal(stderr.every(value => value === 0), true);
});

test('DPAPI failure receipt distinguishes deadline from refusal without captured text', () => {
  for (const [status, code, timedOut] of [[null, 'ETIMEDOUT', true], [20, undefined, false]]) {
    const sensitive = Buffer.from('fixture-sensitive-output');
    let failure;
    try {
      windowsTunnelDpapi(Buffer.from('fixture-ciphertext'), 'Unprotect', {
        platform: 'win32', surfaceProfile: 'business-full',
        spawnSync() { return { status, error: code ? { code, message: 'fixture-sensitive-message' } : undefined, stdout: sensitive, stderr: Buffer.from('fixture-sensitive-error') }; }
      });
    } catch (error) { failure = error; }
    assert.equal(failure.code, 'dpapi_operation_failed');
    assert.equal(failure.diagnostic.stage, 'dpapi');
    assert.equal(failure.diagnostic.exitCode, status);
    assert.equal(failure.diagnostic.timedOut, timedOut);
    assert.equal(failure.diagnostic.errorCode, code ?? null);
    assert.equal(failure.diagnostic.timeoutMs, 30000);
    assert.equal(Number.isInteger(failure.diagnostic.elapsedMs), true);
    assert.equal(JSON.stringify(failure).includes('fixture-sensitive'), false);
    assert.equal(sensitive.every(value => value === 0), true);
  }
});

test('Secret doctor retains directory deadline metadata through preflight failure', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-secret-diagnostic-'));
  t.after(() => fs.rmSync(home, {recursive:true,force:true}));
  const fixture = createWindowsTunnelFixture(home);
  const expectedShell=path.resolve('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
  const options = {platform:'win32',stateRoot:fixture.stateRoot,surfaceProfile:'business-full',powershellExecutable:expectedShell,
    spawnSync(file) { assert.equal(file,expectedShell);return {status:null,error:{code:'ETIMEDOUT',message:'fixture-sensitive-message'},stdout:'fixture-sensitive-output',stderr:'fixture-sensitive-error'}; }};
  const paths = windowsTunnelSecretPaths(options);
  fs.mkdirSync(paths.secrets, {recursive:true});
  fs.writeFileSync(paths.key, 'fixture-ciphertext');
  const status = windowsTunnelSecretStatus(options);
  assert.equal(status.readable, false);
  assert.equal(status.diagnostic.stage, 'directory_acl');
  assert.equal(status.diagnostic.timedOut, true);
  assert.equal(status.diagnostic.timeoutMs, 30000);
  await assert.rejects(runWindowsTunnel(options), error => {
    assert.equal(error.code, 'tunnel_preflight_failed');
    assert.equal(error.preflight.secretDiagnostic.stage, 'directory_acl');
    assert.equal(error.preflight.secretDiagnostic.errorCode, 'ETIMEDOUT');
    assert.equal(JSON.stringify(error).includes('fixture-sensitive'), false);
    return true;
  });
});

test('Native DPAPI preserves bytes, isolates entropy, fails closed and never persists plaintext', { skip: process.platform !== 'win32' }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-tunnel-dpapi-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateRoot = path.join(home, 'state');
  const original = Buffer.from('fixture-runtime-token\r\n');
  const options = { stateRoot, surfaceProfile: 'business-full' };
  const paths = windowsTunnelSecretPaths(options);
  const imported = importWindowsTunnelSecret(original, options);
  assert.equal(imported.ok, true);
  assert.equal(fs.existsSync(path.join(paths.secrets, 'tunnel-runtime.key')), false);
  assert.deepEqual(fs.readdirSync(paths.secrets), ['tunnel-runtime.key.dpapi']);
  const encrypted = fs.readFileSync(paths.key);
  assert.equal(encrypted.includes(original), false);
  const roundtrip = windowsTunnelDpapi(encrypted, 'Unprotect', options);
  assert.deepEqual(roundtrip, original);
  roundtrip.fill(0);
  assert.equal(importWindowsTunnelSecret(original, options).duplicate, true);
  assert.throws(() => importWindowsTunnelSecret(Buffer.from('different-fixture'), options), /existing_secret_differs/);
  assert.deepEqual(fs.readFileSync(paths.key), encrypted);
  assert.throws(() => windowsTunnelDpapi(encrypted, 'Unprotect', { ...options, surfaceProfile: 'personal-read-fetch' }), /dpapi_operation_failed/);
  const personal = { ...options, surfaceProfile: 'personal-read-fetch' };
  assert.equal(importWindowsTunnelSecret(original, personal).ok, true);
  assert.equal(windowsTunnelSecretStatus(personal).readable, true);
  assert.equal(windowsTunnelDoctor(options).ok, false);
  fs.mkdirSync(path.dirname(paths.binary), { recursive: true });
  fs.mkdirSync(paths.profileDir, { recursive: true });
  fs.writeFileSync(paths.binary, 'fixture');
  fs.writeFileSync(paths.profile, '{}');
  const config = { surfaceProfile: options.surfaceProfile, remoteAuthority: {
    identityBinding: `remote_${'a'.repeat(24)}`, authenticationOwner: 'secure-mcp-tunnel', writePolicy: 'guarded'
  } };
  fs.writeFileSync(paths.config, JSON.stringify(config));
  assert.equal(windowsTunnelDoctor(options).canStart, true);

  fs.writeFileSync(paths.config, JSON.stringify({
    surfaceProfile: 'business-full', transport: { mode: 'secure-mcp-tunnel' }, remoteAuthority: {
      identityBinding: `remote_${'b'.repeat(24)}`, authenticationOwner: 'secure-mcp-tunnel', writePolicy: 'owner-unrestricted'
    }
  }));
  assert.equal(windowsTunnelDoctor(options).checks.authority, true);
  let snapshot;
  const parentKey = process.env.CONTROL_PLANE_API_KEY;
  const result = await runWindowsTunnel({ ...options, spawn(binary, args, childOptions) {
    snapshot = { binary, args, env: { ...childOptions.env }, stdio: childOptions.stdio, shell: childOptions.shell };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unexpected_tunnel_exit');
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(snapshot.env.CONTROL_PLANE_API_KEY, original.toString().trim());
  assert.equal(snapshot.stdio, 'ignore');
  assert.equal(snapshot.shell, false);
  assert.equal(snapshot.args.includes(original.toString().trim()), false);
  assert.equal(process.env.CONTROL_PLANE_API_KEY, parentKey);
  assert.equal(fs.existsSync(paths.lock), false);
  assert.equal(fs.existsSync(path.join(paths.root, 'logs')), false);
  delete snapshot.env.CONTROL_PLANE_API_KEY;
  const failedExit = await runWindowsTunnel({ ...options, spawn() {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', -1073741510, null));
    return child;
  } });
  assert.deepEqual(failedExit, { ok: false, code: 'tunnel_exit_failed', exitCode: -1073741510, signal: null });
  assert.equal(fs.existsSync(paths.lock), false);
  const signaledExit = await runWindowsTunnel({ ...options, spawn() {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
    return child;
  } });
  assert.deepEqual(signaledExit, { ok: false, code: 'tunnel_exit_failed', exitCode: null, signal: 'SIGTERM' });
  fs.writeFileSync(paths.config, JSON.stringify({ ...config, transport: { mode: 'local-stdio' } }));
  assert.equal(windowsTunnelDoctor(options).checks.authority, false);
  fs.writeFileSync(paths.key, Buffer.from('corrupt-ciphertext'));
  fs.writeFileSync(path.join(paths.secrets, 'tunnel-runtime.key'), 'legacy-fixture');
  assert.equal(windowsTunnelSecretStatus(options).readable, false);
  const cli = nativeSpawnSync(process.execPath, ['tools/platform/workspace-mcp/windows-tunnel-secret.mjs', 'run', '--surface', 'business-full', '--state-root', stateRoot], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.equal(cli.stderr, '');
  const failure = JSON.parse(fs.readFileSync(path.join(paths.runtime, 'windows-helper.last-error.json'), 'utf8'));
  assert.equal(failure.code, 'tunnel_preflight_failed');
  assert.equal(failure.preflight.checks.secret, false);
  assert.equal(typeof failure.preflight.guard.allowed, 'boolean');
  assert.equal(JSON.stringify(failure).includes('fixture-runtime-token'), false);
  assert.equal(JSON.stringify(failure).includes('legacy-fixture'), false);
  original.fill(0);
});

test('Workspace Tunnel installer requires an explicit surface and parses help before errors', () => {
  assert.equal(parseWorkspaceTunnelInstallArgs(['--unknown', '--help']).help, true);
  assert.throws(() => parseWorkspaceTunnelInstallArgs([]), /is required/);
  assert.throws(() => parseWorkspaceTunnelInstallArgs(['--surface', 'other']), /must be/);
  assert.throws(() => parseWorkspaceTunnelInstallArgs(['--surface', 'business-full', '--personal-read-fetch']), /conflicting/);
  assert.equal(parseWorkspaceTunnelInstallArgs(['--surface', 'business-full']).surfaceProfile, 'business-full');
});

function createWindowsTunnelFixture(home, surface = 'business-full') {
  const stateRoot = path.join(home, '.ai-control-center');
  const personal = surface === 'personal-read-fetch';
  const root = path.join(stateRoot, personal ? 'workspace-mcp-personal-read-fetch' : 'workspace-mcp');
  const alias = personal ? 'aicc-workspace-personal-read-fetch' : 'aicc-workspace';
  for (const directory of ['bin', path.join('tunnel', 'profiles'), 'secrets']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  for (const file of [
    path.join(root, 'bin', 'tunnel-client.exe'),
    path.join(root, 'tunnel', 'profiles', `${alias}.yaml`),
    path.join(root, 'secrets', 'tunnel-runtime.key.dpapi')
  ]) fs.writeFileSync(file, 'fixture');
  return { stateRoot, root, alias };
}

test('Windows Tunnel task uses an exact current-user logon task with bounded periodic recovery', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-windows-task-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const fixture = createWindowsTunnelFixture(home);
  const fixedNow = new Date(2026, 9, 4, 12, 34, 35);
  const expectedBoundary = new Date(fixedNow);
  expectedBoundary.setSeconds(0, 0);
  expectedBoundary.setMinutes(expectedBoundary.getMinutes() + 1);
  const pad = value => String(value).padStart(2, '0');
  const expectedBoundaryText = `${expectedBoundary.getFullYear()}-${pad(expectedBoundary.getMonth() + 1)}-${pad(expectedBoundary.getDate())}T${pad(expectedBoundary.getHours())}:${pad(expectedBoundary.getMinutes())}:00`;
  let registered = false;
  let candidateXml = '';
  const calls = [];
  const spawnSync = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'pwsh.exe') return { status: 0, stdout: registered ? '3' : 'absent', stderr: '' };
    if (args[0] === '/Query') return { status: 1, stdout: '', stderr: 'not found' };
    if (args[0] === '/Create') {
      candidateXml = fs.readFileSync(args[args.indexOf('/XML') + 1], 'utf16le');
      registered = true;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === '/Run') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  const result = installWorkspaceTunnelWindowsTask({
    platform: 'win32', home, stateRoot: fixture.stateRoot, userSid: 'S-1-5-21-1000', spawnSync,
    now: () => fixedNow.getTime(),
    waitForStopped: () => ({ confirmed: true, samples: 1, state: null })
  });
  assert.equal(result.taskName, 'AgenticLab-AICC-Workspace-Tunnel');
  assert.equal(result.runAtLogon, true);
  assert.equal(result.keepAlive, false);
  assert.equal(result.visibleTerminal, false);
  assert.equal(result.terminalPolicy, 'background-hidden');
  assert.equal(result.restartPolicy, 'bounded-scheduler-recovery');
  assert.deepEqual(result.periodicRecovery, { interval: 'PT1M', duration: 'P1D', schedule: 'daily', startBoundary: expectedBoundaryText });
  assert.match(candidateXml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(candidateXml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(candidateXml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(candidateXml, /<LogonTrigger>[\s\S]*?<\/LogonTrigger>[\s\S]*?<CalendarTrigger>[\s\S]*?<Enabled>true<\/Enabled>[\s\S]*?<StartBoundary>[^<]+<\/StartBoundary>[\s\S]*?<Repetition><Interval>PT1M<\/Interval><Duration>P1D<\/Duration><StopAtDurationEnd>false<\/StopAtDurationEnd><\/Repetition>[\s\S]*?<ScheduleByDay><DaysInterval>1<\/DaysInterval><\/ScheduleByDay>[\s\S]*?<\/CalendarTrigger>/);
  assert.match(candidateXml, new RegExp(`<StartBoundary>${expectedBoundaryText.replaceAll(':', '\\:')}<\\/StartBoundary>`));
  assert.match(candidateXml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(candidateXml, /<Hidden>true<\/Hidden>/);
  assert.match(candidateXml, /<Command>.*powershell\.exe<\/Command>/i);
  assert.match(candidateXml, /\.hidden\.ps1/);
  assert.match(candidateXml, /-WindowStyle Hidden/);
  assert.match(candidateXml, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>3<\/Count><\/RestartOnFailure>/);
  const hiddenLauncher = path.join(fixture.root, 'runtime', `${fixture.alias}.hidden.ps1`);
  const launcherSource = fs.readFileSync(hiddenLauncher, 'utf8');
  assert.match(launcherSource, /windows-tunnel-secret\.mjs/);
  assert.match(launcherSource, /AiccWorkspaceProcessJob/);
  assert.match(launcherSource, /'--surface' 'business-full'/);
  assert.match(launcherSource, /exit \$LASTEXITCODE/);
  assert.doesNotMatch(candidateXml, /CONTROL_PLANE_API_KEY|tunnel-runtime.key/);
  assert.equal(calls.filter(item => item[1] === '/Create').length, 1);
  assert.equal(calls.filter(item => item[1] === '/Run').length, 1);
});

test('personal read-fetch uses an isolated Windows task and state root', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-personal-windows-task-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const fixture = createWindowsTunnelFixture(home, 'personal-read-fetch');
  let registered = false;
  const spawnSync = (command, args) => {
    if (command === 'pwsh.exe') return { status: 0, stdout: registered ? '3' : 'absent', stderr: '' };
    if (args[0] === '/Query') return { status: 1, stdout: '', stderr: '' };
    if (args[0] === '/Create') { registered = true; return { status: 0, stdout: '', stderr: '' }; }
    if (args[0] === '/Run') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  const result = installWorkspaceTunnelWindowsTask({
    platform: 'win32', home, stateRoot: fixture.stateRoot, surfaceProfile: 'personal-read-fetch',
    userSid: 'S-1-5-21-1000', spawnSync, waitForStopped: () => ({ confirmed: true, samples: 1 })
  });
  assert.equal(result.taskName, 'AgenticLab-AICC-Workspace-Personal-Tunnel');
  assert.equal(result.runtimeAlias, 'aicc-workspace-personal-read-fetch');
});

test('Windows Tunnel task refuses an inherited or broadly readable runtime key before mutation', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-windows-acl-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const fixture = createWindowsTunnelFixture(home);
  let mutations = 0;
  assert.throws(() => installWorkspaceTunnelWindowsTask({
    platform: 'win32', home, stateRoot: fixture.stateRoot, userSid: 'S-1-5-21-1000',
    spawnSync: () => { mutations += 1; return { status: 0, stdout: '', stderr: '' }; },
    preflight: () => { throw new Error('private ACL required'); }
  }), /private ACL required/);
  assert.equal(mutations, 0);
});

test('Windows Tunnel task restores the exact previous XML and stopped state after start failure', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-windows-rollback-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const fixture = createWindowsTunnelFixture(home);
  const previousXml = windowsTaskBody({
    userSid: 'S-1-5-21-1000',
    binary: path.join(fixture.root, 'bin', 'tunnel-client.exe'),
    profileDir: path.join(fixture.root, 'tunnel', 'profiles'),
    runtimeAlias: fixture.alias,
    root: fixture.root,
    surfaceProfile: 'business-full'
  }).replace(/    <CalendarTrigger>[\s\S]*?<\/CalendarTrigger>\n/, '');
  assert.doesNotMatch(previousXml, /CalendarTrigger/);
  let taskState = 3;
  let createCalls = 0;
  let runCalls = 0;
  let restoredXml = '';
  const spawnSync = (command, args) => {
    if (command === 'pwsh.exe') return { status: 0, stdout: String(taskState), stderr: '' };
    if (args[0] === '/Query') return { status: 0, stdout: previousXml, stderr: '' };
    if (args[0] === '/End') { taskState = 3; return { status: 0, stdout: '', stderr: '' }; }
    if (args[0] === '/Create') {
      createCalls += 1;
      if (createCalls === 2) restoredXml = fs.readFileSync(args[args.indexOf('/XML') + 1], 'utf8');
      taskState = 3;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === '/Run') {
      runCalls += 1;
      if (runCalls === 1) return { status: 7, stdout: '', stderr: 'candidate failed' };
      taskState = 4;
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  assert.throws(() => installWorkspaceTunnelWindowsTask({
    platform: 'win32', home, stateRoot: fixture.stateRoot, userSid: 'S-1-5-21-1000', spawnSync,
    waitForStopped: () => ({ confirmed: true, samples: 1, state: 3 }),
    now: () => Date.parse('2026-08-28T00:00:00Z')
  }), /candidate failed/);
  assert.equal(createCalls, 2);
  assert.equal(runCalls, 1);
  assert.equal(restoredXml, previousXml);
  assert.equal(taskState, 3);
});

test('Windows Tunnel dry-run validates the exact surface without writing a receipt or task', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-windows-dry-run-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const fixture = createWindowsTunnelFixture(home);
  const calls = [];
  const result = installWorkspaceTunnelWindowsTask({
    platform: 'win32', home, stateRoot: fixture.stateRoot, surfaceProfile: 'business-full', dryRun: true,
    userSid: 'S-1-5-21-1000', validatePrivateKey: () => true,
    spawnSync(command, args) {
      calls.push([command, ...args]);
      if (command === 'schtasks.exe') return { status: 1, stdout: '', stderr: 'not found' };
      return { status: 0, stdout: 'absent', stderr: '' };
    }
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.surfaceProfile, 'business-full');
  assert.equal(calls.some(call => call.includes('/Create') || call.includes('/Run') || call.includes('/End')), false);
  assert.equal(fs.existsSync(path.join(fixture.stateRoot, 'backups', 'workspace-tunnel-windows-task')), false);
  assert.deepEqual(parseWorkspaceTunnelWindowsTaskArgs(['install', '--surface', 'business-full', '--dry-run']), {
    help: false, action: 'install', surfaceProfile: 'business-full', dryRun: true, adoptLegacy: false, ownerBackupReadOnly: false
  });
});

test('Windows Tunnel stop accepts a live helper lock but still refuses unknown lock state', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-windows-stop-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const fixture = createWindowsTunnelFixture(home);
  const profileDir = path.join(fixture.root, 'tunnel', 'profiles');
  const ownedXml = [
    '<Task>',
    `<Description>AgenticLab AICC Workspace Secure MCP Tunnel; owner=AICC; surface=business-full</Description>`,
    `<Command>${path.join(fixture.root, 'bin', 'tunnel-client.exe')}</Command>`,
    `<Arguments>run --profile-dir "${profileDir}" --profile "${fixture.alias}"</Arguments>`,
    `<WorkingDirectory>${fixture.root}</WorkingDirectory>`,
    '</Task>'
  ].join('');
  let taskState = 4;
  const calls = [];
  const spawnSync = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'pwsh.exe') return { status: 0, stdout: String(taskState), stderr: '' };
    if (args[0] === '/Query') return { status: 0, stdout: ownedXml, stderr: '' };
    if (args[0] === '/End') { taskState = 3; return { status: 0, stdout: '', stderr: '' }; }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  const options = { platform: 'win32', home, stateRoot: fixture.stateRoot, surfaceProfile: 'business-full',
    userSid: 'S-1-5-21-1000', preflight: () => ({ ok: true }), spawnSync,
    waitForStopped: () => ({ confirmed: true, samples: 1, state: 3 }) };
  const paths = windowsTunnelSecretPaths(options);
  fs.mkdirSync(path.dirname(paths.lock), { recursive: true });
  fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, surfaceProfile: 'business-full' }));
  assert.equal(windowsTunnelIdleGuard(options).reason, 'tunnel_helper_locked');
  // Install/repair still refuse a running helper; only stop treats it as the expected state.
  assert.throws(() => installWorkspaceTunnelWindowsTask({ ...options, spawnSync() { assert.fail('No task calls while locked'); } }), /tunnel_helper_locked/);
  const preview = stopWorkspaceTunnelWindowsTask({ ...options, dryRun: true });
  assert.equal(preview.ok, true);
  assert.equal(preview.runningReason, 'tunnel_helper_locked');
  assert.equal(calls.some(call => call.includes('/End')), false);
  const stopped = stopWorkspaceTunnelWindowsTask(options);
  assert.equal(stopped.stopConfirmed, true);
  assert.equal(calls.filter(call => call.includes('/End')).length, 1);
  taskState = 4;
  fs.writeFileSync(paths.lock, '{}');
  const endsBefore = calls.filter(call => call.includes('/End')).length;
  assert.throws(() => stopWorkspaceTunnelWindowsTask(options), /stop refused: tunnel_helper_lock_unknown/);
  assert.equal(calls.filter(call => call.includes('/End')).length, endsBefore);
});

test('profile receipt refresh requires a cutover proof and cannot be smuggled into other Task actions',()=>{
  const file=path.resolve(os.tmpdir(),'owned-cutover.json');
  assert.equal(parseWorkspaceTunnelWindowsTaskArgs(['rebind-profile','--surface','business-full','--cutover-receipt',file,'--dry-run']).cutoverReceipt,file);
  assert.throws(()=>parseWorkspaceTunnelWindowsTaskArgs(['rebind-profile','--surface','business-full']),/receipt/);
  assert.throws(()=>parseWorkspaceTunnelWindowsTaskArgs(['rebind-profile','--surface','business-full','--cutover-receipt','relative.json']),/Absolute/);
  assert.throws(()=>parseWorkspaceTunnelWindowsTaskArgs(['repair','--surface','business-full','--cutover-receipt',file]),/receipt/);
});

test('Windows Tunnel adopts only an exact inactive legacy AICC task with an explicit flag', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-windows-adopt-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const fixture = createWindowsTunnelFixture(home);
  const runtime = path.join(fixture.root, 'runtime');
  const legacyLauncher = path.join(runtime, `${fixture.alias}.hidden.vbs`);
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(legacyLauncher, [
    'Option Explicit',
    'Dim shell, command',
    'Set shell = CreateObject("WScript.Shell")',
    `command = """C:\\AICC\\node.exe"" ""C:\\AICC\\windows-tunnel-secret.mjs"" run --surface business-full --state-root ""${fixture.stateRoot}"""`,
    'WScript.Quit shell.Run(command, 0, True)',
    ''
  ].join('\r\n'));
  const backups = path.join(fixture.stateRoot, 'backups', 'workspace-tunnel-windows-task');
  fs.mkdirSync(backups, { recursive: true });
  const priorBackup = path.join(backups, 'prior.xml');
  fs.writeFileSync(priorBackup, 'prior-task');
  const receipt = path.join(backups, 'AgenticLab-AICC-Workspace-Tunnel.install.json');
  fs.writeFileSync(receipt, JSON.stringify({
    schemaVersion: 2, status: 'installed', surfaceProfile: 'business-full', runtimeAlias: fixture.alias,
    taskName: 'AgenticLab-AICC-Workspace-Tunnel', root: fixture.root,
    binary: path.join(fixture.root, 'bin', 'tunnel-client.exe'),
    profile: path.join(fixture.root, 'tunnel', 'profiles', `${fixture.alias}.yaml`),
    previousTaskBackup: priorBackup
  }));
  const previousXml = windowsTaskBody({
    userSid: 'S-1-5-21-1000', binary: path.join(fixture.root, 'bin', 'tunnel-client.exe'),
    profileDir: path.join(fixture.root, 'tunnel', 'profiles'), runtimeAlias: fixture.alias,
    root: fixture.root, surfaceProfile: 'business-full',
    actionCommand: 'C:\\Windows\\System32\\wscript.exe',
    actionArgs: `/b /nologo "${legacyLauncher}"`
  });
  assert.equal(workspaceTaskLegacyAdoptable(previousXml, {
    ...fixture,
    binary: path.join(fixture.root, 'bin', 'tunnel-client.exe'),
    profile: path.join(fixture.root, 'tunnel', 'profiles', `${fixture.alias}.yaml`),
    details: { surfaceProfile: 'business-full', runtimeAlias: fixture.alias },
    taskName: 'AgenticLab-AICC-Workspace-Tunnel', legacyWscript: 'C:\\Windows\\System32\\wscript.exe',
    legacyLauncher, backups, receipt: path.join(backups, 'AgenticLab-AICC-Workspace-Tunnel.install.json')
  }, JSON.parse(fs.readFileSync(receipt, 'utf8')), 'S-1-5-21-1000'), true);
  let currentXml = previousXml;
  let registered = false;
  const spawnSync = (command, args) => {
    if (command === 'pwsh.exe') return { status: 0, stdout: '3', stderr: '' };
    if (args[0] === '/Query') return { status: 0, stdout: currentXml, stderr: '' };
    if (args[0] === '/Create') {
      currentXml = fs.readFileSync(args[args.indexOf('/XML') + 1], 'utf16le');
      registered = true;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === '/Run') return { status: 0, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  assert.throws(() => installWorkspaceTunnelWindowsTask({
    platform: 'win32', home, stateRoot: fixture.stateRoot, surfaceProfile: 'business-full',
    userSid: 'S-1-5-21-1000', spawnSync
  }), /소유하지 않은/);
  const preview = installWorkspaceTunnelWindowsTask({
    platform: 'win32', home, stateRoot: fixture.stateRoot, surfaceProfile: 'business-full',
    userSid: 'S-1-5-21-1000', spawnSync, adoptLegacy: true, dryRun: true
  });
  assert.equal(preview.adoptedLegacy, true);
  const result = installWorkspaceTunnelWindowsTask({
    platform: 'win32', home, stateRoot: fixture.stateRoot, surfaceProfile: 'business-full',
    userSid: 'S-1-5-21-1000', spawnSync, adoptLegacy: true,
    waitForStopped: () => ({ confirmed: true, samples: 1, state: 3 }),
    now: () => Date.parse('2026-09-20T00:00:00Z')
  });
  assert.equal(result.adoptedLegacy, true);
  assert.equal(registered, true);
  assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).adoptedLegacy, true);
});

test('Windows Tunnel probe requires the exact task and verifies loopback health plus PID', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-windows-probe-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const fixture = createWindowsTunnelFixture(home, 'personal-read-fetch');
  const runtime = path.join(fixture.root, 'tunnel', 'runtime');
  fs.mkdirSync(path.join(runtime, 'health'), { recursive: true });
  fs.writeFileSync(path.join(runtime, `${fixture.alias}.pid`), '4321');
  fs.writeFileSync(path.join(runtime, 'health', `${fixture.alias}.url`), 'http://127.0.0.1:43829');
  const result = await probeWorkspaceTunnel({
    platform: 'win32', home, stateRoot: fixture.stateRoot, surfaceProfile: 'personal-read-fetch',
    spawnSync: () => ({ status: 0, stdout: '', stderr: '' }), processAlive: pid => pid === 4321,
    abortSignalFactory: () => undefined, fetchImpl: async url => ({ ok: /\/(?:healthz|readyz)$/.test(url) })
  });
  assert.equal(result.registered, true);
  assert.equal(result.running, true);
  assert.equal(result.healthy, true);
  assert.equal(result.ready, true);
  assert.equal(result.supervisorPid, 4321);
  assert.equal(result.supervisorLabel, 'AgenticLab-AICC-Workspace-Personal-Tunnel');
});

macOnlyTest('Workspace Tunnel login owner starts once without unbounded KeepAlive', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-launchd-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, '.ai-control-center', 'workspace-mcp');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tunnel', 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  for (const file of [path.join(root, 'bin', 'tunnel-client'), path.join(root, 'tunnel', 'profiles', 'aicc-workspace.yaml'), path.join(root, 'secrets', 'tunnel-runtime.key')]) fs.writeFileSync(file, 'fixture', { mode: 0o600 });
  const calls = [];
  const spawnSync = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; };
  const result = installWorkspaceTunnelLaunchAgent({ platform: 'darwin', home, stateRoot: path.join(home, '.ai-control-center'), spawnSync, waitForUnloaded: () => ({ confirmed: true, samples: 1 }) });
  assert.equal(result.keepAlive, false);
  assert.equal(result.restartPolicy, 'maintenance-coordinator-only');
  assert.equal(result.unloadConfirmed, true);
  const plist = fs.readFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.agenticlab.aicc-workspace-tunnel.plist'), 'utf8');
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><false\/>/);
  assert.deepEqual(calls.filter(item => item[0] === 'launchctl').map(item => item[1]), ['bootout', 'bootstrap']);
});

macOnlyTest('personal read-fetch Tunnel uses a separate state root, profile, and launchd label', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-personal-launchd-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateRoot = path.join(home, '.ai-control-center');
  const root = path.join(stateRoot, 'workspace-mcp-personal-read-fetch');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tunnel', 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  for (const file of [
    path.join(root, 'bin', 'tunnel-client'),
    path.join(root, 'tunnel', 'profiles', 'aicc-workspace-personal-read-fetch.yaml'),
    path.join(root, 'secrets', 'tunnel-runtime.key')
  ]) fs.writeFileSync(file, 'fixture', { mode: 0o600 });
  const spawnSync = () => ({ status: 0, stdout: '', stderr: '' });
  const result = installWorkspaceTunnelLaunchAgent({
    platform: 'darwin', home, stateRoot, spawnSync, surfaceProfile: 'personal-read-fetch', waitForUnloaded: () => ({ confirmed: true, samples: 1 })
  });
  assert.equal(result.runtimeAlias, 'aicc-workspace-personal-read-fetch');
  assert.equal(result.label, 'com.agenticlab.aicc-workspace-personal-read-fetch-tunnel');
  const plist = fs.readFileSync(result.plist, 'utf8');
  assert.match(plist, /aicc-workspace-personal-read-fetch/);
  assert.equal(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.agenticlab.aicc-workspace-tunnel.plist')), false);
});

macOnlyTest('Workspace Tunnel installer reconciles bootstrap error 5 by post-read without retry', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-launchd-retry-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, '.ai-control-center', 'workspace-mcp');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tunnel', 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  for (const file of [path.join(root, 'bin', 'tunnel-client'), path.join(root, 'tunnel', 'profiles', 'aicc-workspace.yaml'), path.join(root, 'secrets', 'tunnel-runtime.key')]) fs.writeFileSync(file, 'fixture', { mode: 0o600 });
  let bootstraps = 0;
  const spawnSync = (command, args) => {
    if (command === 'plutil' || args[0] === 'bootout') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'print') return { status: 0, stdout: 'state = running', stderr: '' };
    bootstraps += 1;
    return { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
  };
  const result = installWorkspaceTunnelLaunchAgent({ platform: 'darwin', home, uid: 501, spawnSync, waitForUnloaded: () => ({ confirmed: true, samples: 1 }) });
  assert.equal(result.bootstrapAttempts, 1);
  assert.equal(result.registeredAfterBootstrapError, true);
  assert.equal(bootstraps, 1);
});

macOnlyTest('Workspace Tunnel installer does not retry a non-transient bootstrap failure', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-launchd-fail-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, '.ai-control-center', 'workspace-mcp');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tunnel', 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  for (const file of [path.join(root, 'bin', 'tunnel-client'), path.join(root, 'tunnel', 'profiles', 'aicc-workspace.yaml'), path.join(root, 'secrets', 'tunnel-runtime.key')]) fs.writeFileSync(file, 'fixture', { mode: 0o600 });
  const spawnSync = (command, args) => {
    if (command === 'plutil' || args[0] === 'bootout') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'print') return { status: 113, stdout: '', stderr: '' };
    return { status: 77, stdout: '', stderr: 'permission denied' };
  };
  assert.throws(() => installWorkspaceTunnelLaunchAgent({ platform: 'darwin', home, uid: 501, spawnSync, pause: () => {}, waitForUnloaded: () => ({ confirmed: true, samples: 1 }) }), /permission denied/);
});

macOnlyTest('Workspace Tunnel installer restores the exact previous plist after candidate registration failure', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-launchd-rollback-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateRoot = path.join(home, '.ai-control-center');
  const root = path.join(stateRoot, 'workspace-mcp');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tunnel', 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  for (const file of [path.join(root, 'bin', 'tunnel-client'), path.join(root, 'tunnel', 'profiles', 'aicc-workspace.yaml'), path.join(root, 'secrets', 'tunnel-runtime.key')]) fs.writeFileSync(file, 'fixture', { mode: 0o600 });
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(launchAgents, { recursive: true });
  const plist = path.join(launchAgents, 'com.agenticlab.aicc-workspace-tunnel.plist');
  fs.writeFileSync(plist, 'previous-workspace', { mode: 0o600 });
  let bootstrapCalls = 0;
  const spawnSync = (command, args) => {
    if (command === 'plutil' || args[0] === 'bootout') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'bootstrap') {
      bootstrapCalls += 1;
      return bootstrapCalls === 1
        ? { status: 77, stdout: '', stderr: 'permission denied' }
        : { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'print') return { status: 113, stdout: '', stderr: 'not registered' };
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  assert.throws(
    () => installWorkspaceTunnelLaunchAgent({ platform: 'darwin', home, stateRoot, uid: 501, spawnSync, pause: () => {}, waitForUnloaded: () => ({ confirmed: true, samples: 1 }), now: () => Date.parse('2026-08-15T00:00:00Z') }),
    /permission denied/
  );
  assert.equal(fs.readFileSync(plist, 'utf8'), 'previous-workspace');
  assert.equal(bootstrapCalls, 2);
});

macOnlyTest('Workspace Tunnel waits for exact unload before the only candidate bootstrap', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-launchd-unload-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, '.ai-control-center', 'workspace-mcp');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tunnel', 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  for (const file of [path.join(root, 'bin', 'tunnel-client'), path.join(root, 'tunnel', 'profiles', 'aicc-workspace.yaml'), path.join(root, 'secrets', 'tunnel-runtime.key')]) fs.writeFileSync(file, 'fixture', { mode: 0o600 });
  let printCalls = 0;
  let bootstrapCalls = 0;
  const spawnSync = (command, args) => {
    if (command === 'plutil' || args[0] === 'bootout') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'print') return { status: ++printCalls < 3 ? 0 : 113, stdout: '', stderr: '' };
    if (args[0] === 'bootstrap') { bootstrapCalls += 1; return { status: 0, stdout: '', stderr: '' }; }
    return { status: 1, stdout: '', stderr: '' };
  };
  const result = installWorkspaceTunnelLaunchAgent({ platform: 'darwin', home, uid: 501, spawnSync, pause: () => {}, unloadTimeoutMs: 100 });
  assert.equal(result.unloadConfirmed, true);
  assert.equal(result.unloadSamples, 3);
  assert.equal(bootstrapCalls, 1);
});
