import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  armForegroundCodexRescueGuardian,
  requestWebGptRescueAdvice,
  restoreGuardedSnapshot,
  runForegroundCodexRescueGuardian
} from '../src/codex-foreground-rescue-guardian.mjs';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-foreground-rescue-')));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  const stateRoot = path.join(home, '.ai-control-center');
  const configFile = path.join(home, '.codex', 'config.toml');
  const integrationJournalFile = path.join(home, '.codex-chatgpt-web', 'runtime', 'codex-integration.json');
  const workerFile = path.join(root, 'worker.mjs');
  const nativeRescueExecutable = path.join(root, 'codex-native-rescue');
  const manifestFile = path.join(root, 'manifest.json');
  for (const directory of [home, projectRoot, stateRoot, path.dirname(configFile), path.dirname(integrationJournalFile)]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  fs.writeFileSync(configFile, 'openai_base_url = "https://chatgpt.com/backend-api/codex"\n', { mode: 0o600 });
  fs.writeFileSync(integrationJournalFile, '{"active":false}\n', { mode: 0o600 });
  fs.writeFileSync(workerFile, 'export {};\n', { mode: 0o700 });
  fs.writeFileSync(nativeRescueExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(manifestFile, '{"codexVersion":"1.0.0"}\n', { mode: 0o600 });
  return { root, home, projectRoot, stateRoot, configFile, integrationJournalFile, workerFile, nativeRescueExecutable, manifestFile };
}

test('guarded restore only replaces an explicitly allowed current identity', t => {
  const f = fixture(t);
  const backupFile = path.join(f.root, 'backup.toml');
  fs.copyFileSync(f.configFile, backupFile);
  fs.chmodSync(backupFile, 0o600);
  const backup = { path: f.configFile, exists: true, sha256: sha256(backupFile), mode: 0o600, backupFile };
  fs.writeFileSync(f.configFile, 'openai_base_url = "http://127.0.0.1:17841/v1"\n', { mode: 0o600 });
  const riskyIdentity = `sha256:${sha256(f.configFile)}`;
  assert.equal(restoreGuardedSnapshot(backup).state, 'UNKNOWN_DRIFT');
  const restored = restoreGuardedSnapshot(backup, [riskyIdentity]);
  assert.equal(restored.state, 'RESTORED');
  assert.equal(sha256(f.configFile), backup.sha256);
});

test('arming creates one foreground Terminal command and no scheduled task', t => {
  const f = fixture(t);
  const callbackCalls = [];
  const operationResultFile = path.join(f.stateRoot, 'runtime', 'operation', 'result.json');
  fs.mkdirSync(path.dirname(operationResultFile), { recursive: true, mode: 0o700 });
  const armed = armForegroundCodexRescueGuardian({
    platform: 'darwin',
    home: f.home,
    stateRoot: f.stateRoot,
    projectRoot: f.projectRoot,
    projectKey: 'ai-platform',
    taskId: '01a0061f-05c0-7dc0-bf14-f21440901a6b',
    operationId: 'route-cutover-v1',
    operationResultFile,
    expectedDesktopPid: 123,
    manifestFile: f.manifestFile,
    nativeRescueExecutable: f.nativeRescueExecutable,
    workerFile: f.workerFile,
    nodeExecutable: process.execPath,
    configFile: f.configFile,
    integrationJournalFile: f.integrationJournalFile,
    inspectNativeSafety: () => ({ ok: true, state: 'NATIVE_CALLBACK_ROUTE_SAFE', nativeRescue: { ready: true } }),
    callbackService: { arm: options => { callbackCalls.push(options); return { callbackId: 'callback-1' }; } },
    launch: false
  });
  assert.equal(armed.scheduledTask, false);
  assert.equal(armed.mode, 'foreground-terminal-one-shot');
  assert.equal(fs.existsSync(armed.commandFile), true);
  assert.equal(fs.existsSync(path.join(armed.runDir, 'one-shot.plist')), false);
  assert.equal(callbackCalls[0].codexExecutable, f.nativeRescueExecutable);
  assert.equal(callbackCalls[0].controlSocket, null);
  assert.equal(callbackCalls[0].expiresAt, armed.expiresAt);
  assert.match(fs.readFileSync(armed.commandFile, 'utf8'), /--plan/);
  assert.match(fs.readFileSync(armed.commandFile, 'utf8'), /for attempt in \{1\.\.10\}/);
  assert.match(fs.readFileSync(armed.commandFile, 'utf8'), /terminal_tty="\$\(tty\)"/);
  assert.doesNotMatch(fs.readFileSync(armed.commandFile, 'utf8'), /exec .*--plan/);
  assert.equal(fs.existsSync(armed.closeTerminalScript), true);
  const plan = JSON.parse(fs.readFileSync(armed.planFile, 'utf8'));
  assert.equal(plan.nativeCallback.rescueExecutableSha256, sha256(f.nativeRescueExecutable));
  assert.equal(plan.nativeCallback.callbackExecutableSha256, sha256(f.nativeRescueExecutable));
  assert.match(fs.readFileSync(armed.closeTerminalScript, 'utf8'), /tty of targetTab is targetTty/);
});

test('arming accepts a managed global route when the independent Native rescue is ready and pinned', t => {
  const f = fixture(t);
  const operationResultFile = path.join(f.stateRoot, 'runtime', 'operation-managed-route', 'result.json');
  fs.mkdirSync(path.dirname(operationResultFile), { recursive: true, mode: 0o700 });
  const armed = armForegroundCodexRescueGuardian({
    platform: 'darwin',
    home: f.home,
    stateRoot: f.stateRoot,
    projectRoot: f.projectRoot,
    taskId: '01a0061f-05c0-7dc0-bf14-f21440901a6b',
    operationId: 'route-cutover-managed-v1',
    operationResultFile,
    expectedDesktopPid: 123,
    manifestFile: f.manifestFile,
    nativeRescueExecutable: f.nativeRescueExecutable,
    workerFile: f.workerFile,
    nodeExecutable: process.execPath,
    configFile: f.configFile,
    integrationJournalFile: f.integrationJournalFile,
    inspectNativeSafety: () => ({
      ok: false,
      state: 'NATIVE_CALLBACK_ROUTE_NOT_PROVEN',
      compactRoute: 'http://127.0.0.1:17841/v1',
      nativeRescue: { ready: true }
    }),
    callbackService: { arm: () => ({ callbackId: 'callback-managed-route' }) },
    launch: false
  });
  assert.equal(armed.nativeSafety, 'PINNED_NATIVE_RESCUE_READY_ON_MANAGED_ROUTE');
  const plan = JSON.parse(fs.readFileSync(armed.planFile, 'utf8'));
  assert.equal(plan.nativeCallback.routeStateAtArm, 'PINNED_NATIVE_RESCUE_READY_ON_MANAGED_ROUTE');
  assert.equal(plan.nativeCallback.rescueExecutableSha256, sha256(f.nativeRescueExecutable));
});

test('arming can pin the shared daemon client and control socket separately from Native rescue', t => {
  const f = fixture(t);
  const callbackCodexExecutable = path.join(f.root, 'managed-codex');
  const controlSocket = path.join(f.root, 'app-server-control.sock');
  fs.writeFileSync(callbackCodexExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(controlSocket, '', { mode: 0o600 });
  const callbackCalls = [];
  const operationResultFile = path.join(f.stateRoot, 'runtime', 'operation-shared', 'result.json');
  fs.mkdirSync(path.dirname(operationResultFile), { recursive: true, mode: 0o700 });
  const armed = armForegroundCodexRescueGuardian({
    platform: 'darwin',
    home: f.home,
    stateRoot: f.stateRoot,
    projectRoot: f.projectRoot,
    taskId: '01a0061f-05c0-7dc0-bf14-f21440901a6b',
    operationId: 'route-cutover-shared-v1',
    operationResultFile,
    expectedDesktopPid: 123,
    manifestFile: f.manifestFile,
    nativeRescueExecutable: f.nativeRescueExecutable,
    callbackCodexExecutable,
    controlSocket,
    workerFile: f.workerFile,
    nodeExecutable: process.execPath,
    configFile: f.configFile,
    integrationJournalFile: f.integrationJournalFile,
    inspectNativeSafety: () => ({ ok: true, state: 'NATIVE_CALLBACK_ROUTE_SAFE', nativeRescue: { ready: true } }),
    callbackService: { arm: options => { callbackCalls.push(options); return { callbackId: 'callback-shared' }; } },
    launch: false
  });
  assert.equal(callbackCalls[0].codexExecutable, callbackCodexExecutable);
  assert.equal(callbackCalls[0].controlSocket, controlSocket);
  const plan = JSON.parse(fs.readFileSync(armed.planFile, 'utf8'));
  assert.equal(plan.detectTaskIdleWithoutResult, true);
  assert.equal(plan.taskIdleGraceMs, 15_000);
  assert.equal(plan.webGpt.model, 'chatgpt-web/temporary/high');
});

test('worker restores Native state, resumes the same task, then reopens Desktop', async t => {
  const f = fixture(t);
  const runDir = path.join(f.stateRoot, 'runtime', 'codex-foreground-rescue', 'run');
  const backupDir = path.join(runDir, 'backup');
  const mirrorDir = path.join(f.projectRoot, '.aicc-recovery');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const configBackup = path.join(backupDir, 'config.toml');
  const journalBackup = path.join(backupDir, 'journal.json');
  fs.copyFileSync(f.configFile, configBackup);
  fs.copyFileSync(f.integrationJournalFile, journalBackup);
  fs.chmodSync(configBackup, 0o600);
  fs.chmodSync(journalBackup, 0o600);
  const operationResultFile = path.join(runDir, 'operation-result.json');
  fs.writeFileSync(operationResultFile, JSON.stringify({ operation: 'route-cutover-v1', status: 'PASS' }), { mode: 0o600 });
  const planFile = path.join(runDir, 'plan.json');
  const plan = {
    schemaVersion: 1,
    mode: 'foreground-terminal-one-shot',
    operationId: 'route-cutover-v1',
    guardianOperationId: 'rescue-route-cutover-v1',
    taskId: '01a0061f-05c0-7dc0-bf14-f21440901a6b',
    projectRoot: f.projectRoot,
    expectedDesktopPid: 123,
    expectedWorkerPid: null,
    operationResultFile,
    resultFile: path.join(runDir, 'result.json'),
    deliveryFile: path.join(runDir, 'delivery.json'),
    webGptFile: path.join(runDir, 'web-gpt.json'),
    mirrorMarkdown: path.join(runDir, 'TERMINAL-RESCUE.md'),
    workspaceMirrorDirectory: mirrorDir,
    callbackId: 'callback-1',
    backups: {
      config: { path: f.configFile, exists: true, sha256: sha256(configBackup), mode: 0o600, backupFile: configBackup },
      integrationJournal: { path: f.integrationJournalFile, exists: true, sha256: sha256(journalBackup), mode: 0o600, backupFile: journalBackup }
    },
    allowedCurrentIdentities: { config: [], integrationJournal: [] },
    nativeRescueExecutable: f.nativeRescueExecutable,
    callbackCodexExecutable: f.nativeRescueExecutable,
    nativeCallback: {
      rescueExecutableSha256: sha256(f.nativeRescueExecutable),
      callbackExecutableSha256: sha256(f.nativeRescueExecutable),
      routeStateAtArm: 'PINNED_NATIVE_RESCUE_READY_ON_MANAGED_ROUTE'
    },
    workerFile: f.workerFile,
    workerSha256: sha256(f.workerFile),
    pollMs: 1,
    desktopDisappearGraceMs: 1,
    reopenDesktop: true,
    webGpt: { enabled: true, endpoint: 'http://127.0.0.1:17841', model: 'chatgpt-web/saved/extra-high' },
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  fs.writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
  const callbackCalls = [];
  const openCalls = [];
  const result = await runForegroundCodexRescueGuardian(planFile, {
    pidAlive: () => false,
    nativeRescueInspector: () => ({
      ok: true,
      routeLock: { endpoint: 'https://chatgpt.com/backend-api/codex', independentOf: ['17841', '10100'] }
    }),
    callbackService: { complete: async options => { callbackCalls.push(options); return { ok: true, state: 'completed', terminalTurnStatus: 'completed' }; } },
    runCommand: (executable, args) => { openCalls.push([executable, args]); return { status: 0, stdout: '', stderr: '' }; }
  });
  assert.equal(result.ok, true);
  assert.equal(callbackCalls.length, 1);
  assert.equal(callbackCalls[0].waitForTerminal, false);
  assert.equal(openCalls.length, 1);
  assert.equal(fs.existsSync(path.join(mirrorDir, 'TERMINAL-RESCUE.md')), true);
  assert.equal(JSON.parse(fs.readFileSync(plan.resultFile, 'utf8')).scheduledTask, false);
});

test('worker observes a terminal result during Desktop disappearance grace without one long sleep', async t => {
  const f = fixture(t);
  const runDir = path.join(f.stateRoot, 'runtime', 'codex-foreground-rescue', 'interruptible-grace');
  const backupDir = path.join(runDir, 'backup');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const configBackup = path.join(backupDir, 'config.toml');
  const journalBackup = path.join(backupDir, 'journal.json');
  fs.copyFileSync(f.configFile, configBackup);
  fs.copyFileSync(f.integrationJournalFile, journalBackup);
  const operationResultFile = path.join(runDir, 'operation-result.json');
  const planFile = path.join(runDir, 'plan.json');
  let clock = Date.now();
  const plan = {
    schemaVersion: 1,
    mode: 'foreground-terminal-one-shot',
    operationId: 'interruptible-grace-v1',
    guardianOperationId: 'rescue-interruptible-grace-v1',
    taskId: 'task-interruptible-grace',
    projectRoot: f.projectRoot,
    expectedDesktopPid: 123,
    expectedWorkerPid: 456,
    operationResultFile,
    resultFile: path.join(runDir, 'result.json'),
    deliveryFile: path.join(runDir, 'delivery.json'),
    webGptFile: path.join(runDir, 'web-gpt.json'),
    mirrorMarkdown: path.join(runDir, 'TERMINAL-RESCUE.md'),
    workspaceMirrorDirectory: path.join(f.projectRoot, '.aicc-recovery'),
    callbackId: 'callback-interruptible-grace',
    backups: {
      config: { path: f.configFile, exists: true, sha256: sha256(configBackup), mode: 0o600, backupFile: configBackup },
      integrationJournal: { path: f.integrationJournalFile, exists: true, sha256: sha256(journalBackup), mode: 0o600, backupFile: journalBackup }
    },
    allowedCurrentIdentities: { config: [], integrationJournal: [] },
    workerFile: f.workerFile,
    workerSha256: sha256(f.workerFile),
    pollMs: 10,
    callbackRetryMs: 100,
    callbackDeliveryTimeoutMs: 1_000,
    taskIdleGraceMs: 1_000,
    detectTaskIdleWithoutResult: false,
    desktopDisappearGraceMs: 1_000,
    reopenDesktop: false,
    webGpt: { enabled: false },
    expiresAt: new Date(clock + 60_000).toISOString()
  };
  fs.writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
  const sleeps = [];
  const result = await runForegroundCodexRescueGuardian(planFile, {
    now: () => clock,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      clock += milliseconds;
      if (!fs.existsSync(operationResultFile)) {
        fs.writeFileSync(operationResultFile, JSON.stringify({ operation: plan.operationId, status: 'PASS' }), { mode: 0o600 });
      }
    },
    pidAlive: pid => pid === plan.expectedWorkerPid,
    inspectNativeSafety: () => ({ ok: true, state: 'NATIVE_CALLBACK_ROUTE_SAFE' }),
    callbackService: { complete: async () => ({ ok: true, state: 'completed', terminalTurnStatus: 'completed' }) }
  });
  const guardianResult = JSON.parse(fs.readFileSync(plan.resultFile, 'utf8'));
  assert.equal(result.ok, true);
  assert.equal(guardianResult.trigger, 'operation_terminal_after_desktop_exit');
  assert.deepEqual(sleeps, [10]);
});

test('worker waits through an exact retry-safe active state and delivers once idle', async t => {
  const f = fixture(t);
  const runDir = path.join(f.stateRoot, 'runtime', 'codex-foreground-rescue', 'retry');
  const backupDir = path.join(runDir, 'backup');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const configBackup = path.join(backupDir, 'config.toml');
  const journalBackup = path.join(backupDir, 'journal.json');
  fs.copyFileSync(f.configFile, configBackup);
  fs.copyFileSync(f.integrationJournalFile, journalBackup);
  const operationResultFile = path.join(runDir, 'operation-result.json');
  fs.writeFileSync(operationResultFile, JSON.stringify({ operation: 'callback-retry-v1', status: 'PASS' }), { mode: 0o600 });
  const planFile = path.join(runDir, 'plan.json');
  const plan = {
    schemaVersion: 1,
    mode: 'foreground-terminal-one-shot',
    operationId: 'callback-retry-v1',
    guardianOperationId: 'rescue-callback-retry-v1',
    taskId: 'task-retry',
    projectRoot: f.projectRoot,
    expectedDesktopPid: 123,
    expectedWorkerPid: null,
    operationResultFile,
    resultFile: path.join(runDir, 'result.json'),
    deliveryFile: path.join(runDir, 'delivery.json'),
    webGptFile: path.join(runDir, 'web-gpt.json'),
    mirrorMarkdown: path.join(runDir, 'TERMINAL-RESCUE.md'),
    workspaceMirrorDirectory: path.join(f.projectRoot, '.aicc-recovery'),
    callbackId: 'callback-retry',
    backups: {
      config: { path: f.configFile, exists: true, sha256: sha256(configBackup), mode: 0o600, backupFile: configBackup },
      integrationJournal: { path: f.integrationJournalFile, exists: true, sha256: sha256(journalBackup), mode: 0o600, backupFile: journalBackup }
    },
    allowedCurrentIdentities: { config: [], integrationJournal: [] },
    workerFile: f.workerFile,
    workerSha256: sha256(f.workerFile),
    pollMs: 1,
    callbackRetryMs: 100,
    desktopDisappearGraceMs: 1,
    reopenDesktop: false,
    webGpt: { enabled: false },
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  fs.writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
  let attempts = 0;
  let sleeps = 0;
  const result = await runForegroundCodexRescueGuardian(planFile, {
    pidAlive: () => true,
    inspectNativeSafety: () => ({ ok: true, state: 'NATIVE_CALLBACK_ROUTE_SAFE' }),
    sleep: async () => { sleeps += 1; },
    callbackService: { complete: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('active'), { code: 'callback_thread_active' });
      return { ok: true, state: 'completed', terminalTurnStatus: 'completed' };
    } }
  });
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.equal(sleeps, 1);
  assert.equal(result.delivery.lastRetryCode, 'callback_thread_active');
});

test('worker bounds retry-safe callback delivery instead of waiting for the callback TTL', async t => {
  const f = fixture(t);
  const runDir = path.join(f.stateRoot, 'runtime', 'codex-foreground-rescue', 'retry-timeout');
  const backupDir = path.join(runDir, 'backup');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const configBackup = path.join(backupDir, 'config.toml');
  const journalBackup = path.join(backupDir, 'journal.json');
  fs.copyFileSync(f.configFile, configBackup);
  fs.copyFileSync(f.integrationJournalFile, journalBackup);
  const operationResultFile = path.join(runDir, 'operation-result.json');
  fs.writeFileSync(operationResultFile, JSON.stringify({ operation: 'callback-retry-timeout-v1', status: 'PASS' }), { mode: 0o600 });
  const planFile = path.join(runDir, 'plan.json');
  let clock = Date.now();
  const plan = {
    schemaVersion: 1,
    mode: 'foreground-terminal-one-shot',
    operationId: 'callback-retry-timeout-v1',
    guardianOperationId: 'rescue-callback-retry-timeout-v1',
    taskId: 'task-retry-timeout',
    projectRoot: f.projectRoot,
    expectedDesktopPid: 123,
    expectedWorkerPid: null,
    operationResultFile,
    resultFile: path.join(runDir, 'result.json'),
    deliveryFile: path.join(runDir, 'delivery.json'),
    webGptFile: path.join(runDir, 'web-gpt.json'),
    mirrorMarkdown: path.join(runDir, 'TERMINAL-RESCUE.md'),
    workspaceMirrorDirectory: path.join(f.projectRoot, '.aicc-recovery'),
    callbackId: 'callback-retry-timeout',
    backups: {
      config: { path: f.configFile, exists: true, sha256: sha256(configBackup), mode: 0o600, backupFile: configBackup },
      integrationJournal: { path: f.integrationJournalFile, exists: true, sha256: sha256(journalBackup), mode: 0o600, backupFile: journalBackup }
    },
    allowedCurrentIdentities: { config: [], integrationJournal: [] },
    workerFile: f.workerFile,
    workerSha256: sha256(f.workerFile),
    pollMs: 1,
    callbackRetryMs: 100,
    callbackDeliveryTimeoutMs: 250,
    desktopDisappearGraceMs: 1,
    reopenDesktop: false,
    webGpt: { enabled: false },
    expiresAt: new Date(clock + 60_000).toISOString()
  };
  fs.writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
  let attempts = 0;
  const sleeps = [];
  const result = await runForegroundCodexRescueGuardian(planFile, {
    now: () => clock,
    pidAlive: () => true,
    inspectNativeSafety: () => ({ ok: true, state: 'NATIVE_CALLBACK_ROUTE_SAFE' }),
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    callbackService: { complete: async () => {
      attempts += 1;
      throw Object.assign(new Error('active'), { code: 'callback_thread_active' });
    } }
  });
  assert.equal(result.ok, false);
  assert.equal(result.delivery.status, 'HOLD');
  assert.equal(result.delivery.reason, 'guardian_callback_retry_expired');
  assert.deepEqual(result.delivery.detail, { attempts: 3, lastErrorCode: 'callback_thread_active' });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [100, 100, 50]);
});

test('worker never retries an ambiguous callback delivery', async t => {
  const f = fixture(t);
  const runDir = path.join(f.stateRoot, 'runtime', 'codex-foreground-rescue', 'ambiguous');
  const backupDir = path.join(runDir, 'backup');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const configBackup = path.join(backupDir, 'config.toml');
  const journalBackup = path.join(backupDir, 'journal.json');
  fs.copyFileSync(f.configFile, configBackup);
  fs.copyFileSync(f.integrationJournalFile, journalBackup);
  const operationResultFile = path.join(runDir, 'operation-result.json');
  fs.writeFileSync(operationResultFile, JSON.stringify({ operation: 'callback-ambiguous-v1', status: 'PASS' }), { mode: 0o600 });
  const planFile = path.join(runDir, 'plan.json');
  const plan = {
    schemaVersion: 1,
    mode: 'foreground-terminal-one-shot',
    operationId: 'callback-ambiguous-v1',
    guardianOperationId: 'rescue-callback-ambiguous-v1',
    taskId: 'task-ambiguous',
    projectRoot: f.projectRoot,
    expectedDesktopPid: 123,
    expectedWorkerPid: null,
    operationResultFile,
    resultFile: path.join(runDir, 'result.json'),
    deliveryFile: path.join(runDir, 'delivery.json'),
    webGptFile: path.join(runDir, 'web-gpt.json'),
    mirrorMarkdown: path.join(runDir, 'TERMINAL-RESCUE.md'),
    workspaceMirrorDirectory: path.join(f.projectRoot, '.aicc-recovery'),
    callbackId: 'callback-ambiguous',
    backups: {
      config: { path: f.configFile, exists: true, sha256: sha256(configBackup), mode: 0o600, backupFile: configBackup },
      integrationJournal: { path: f.integrationJournalFile, exists: true, sha256: sha256(journalBackup), mode: 0o600, backupFile: journalBackup }
    },
    allowedCurrentIdentities: { config: [], integrationJournal: [] },
    workerFile: f.workerFile,
    workerSha256: sha256(f.workerFile),
    pollMs: 1,
    callbackRetryMs: 100,
    desktopDisappearGraceMs: 1,
    reopenDesktop: false,
    webGpt: { enabled: false },
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  fs.writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
  let attempts = 0;
  const result = await runForegroundCodexRescueGuardian(planFile, {
    pidAlive: () => true,
    inspectNativeSafety: () => ({ ok: true, state: 'NATIVE_CALLBACK_ROUTE_SAFE' }),
    callbackService: { complete: async () => {
      attempts += 1;
      throw Object.assign(new Error('ambiguous'), { code: 'callback_delivery_unknown' });
    } }
  });
  assert.equal(result.ok, false);
  assert.equal(attempts, 1);
  assert.equal(result.delivery.reason, 'callback_delivery_unknown');
});

test('worker revives an observed active task that becomes idle without its watched result', async t => {
  const f = fixture(t);
  const runDir = path.join(f.stateRoot, 'runtime', 'codex-foreground-rescue', 'idle-without-result');
  const backupDir = path.join(runDir, 'backup');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const configBackup = path.join(backupDir, 'config.toml');
  const journalBackup = path.join(backupDir, 'journal.json');
  fs.copyFileSync(f.configFile, configBackup);
  fs.copyFileSync(f.integrationJournalFile, journalBackup);
  const planFile = path.join(runDir, 'plan.json');
  let clock = Date.now();
  const plan = {
    schemaVersion: 1,
    mode: 'foreground-terminal-one-shot',
    operationId: 'unfinished-objective-v1',
    guardianOperationId: 'rescue-unfinished-objective-v1',
    taskId: 'task-unfinished',
    projectRoot: f.projectRoot,
    expectedDesktopPid: 123,
    expectedWorkerPid: null,
    operationResultFile: path.join(runDir, 'missing-operation-result.json'),
    resultFile: path.join(runDir, 'result.json'),
    deliveryFile: path.join(runDir, 'delivery.json'),
    webGptFile: path.join(runDir, 'web-gpt.json'),
    mirrorMarkdown: path.join(runDir, 'TERMINAL-RESCUE.md'),
    workspaceMirrorDirectory: path.join(f.projectRoot, '.aicc-recovery'),
    callbackId: 'callback-unfinished',
    backups: {
      config: { path: f.configFile, exists: true, sha256: sha256(configBackup), mode: 0o600, backupFile: configBackup },
      integrationJournal: { path: f.integrationJournalFile, exists: true, sha256: sha256(journalBackup), mode: 0o600, backupFile: journalBackup }
    },
    allowedCurrentIdentities: { config: [], integrationJournal: [] },
    workerFile: f.workerFile,
    workerSha256: sha256(f.workerFile),
    pollMs: 500,
    callbackRetryMs: 100,
    taskIdleGraceMs: 1_000,
    detectTaskIdleWithoutResult: true,
    desktopDisappearGraceMs: 1,
    reopenDesktop: false,
    webGpt: { enabled: false },
    expiresAt: new Date(clock + 60_000).toISOString()
  };
  fs.writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
  let probes = 0;
  let callbacks = 0;
  const result = await runForegroundCodexRescueGuardian(planFile, {
    now: () => clock,
    sleep: async milliseconds => { clock += milliseconds; },
    pidAlive: () => true,
    inspectTaskState: async () => ({ state: probes++ === 0 ? 'active' : 'idle' }),
    inspectNativeSafety: () => ({ ok: true, state: 'NATIVE_CALLBACK_ROUTE_SAFE' }),
    callbackService: { complete: async () => {
      callbacks += 1;
      return { ok: true, state: 'completed', terminalTurnStatus: 'completed' };
    } }
  });
  const guardianResult = JSON.parse(fs.readFileSync(plan.resultFile, 'utf8'));
  assert.equal(result.ok, false);
  assert.equal(result.status, 'HOLD');
  assert.equal(guardianResult.trigger, 'task_idle_without_terminal_result');
  assert.equal(callbacks, 1);
  assert.ok(probes >= 3);
});

test('Web GPT advisor runs only after two exact idle health samples', async () => {
  const calls = [];
  const bodies = [];
  const health = {
    status: 'ok', accepting_turns: true, accepting_browser_turns: true,
    active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0
  };
  const plan = {
    projectRoot: '/tmp/project', taskId: 'task-1', operationId: 'operation-1',
    workspaceMirrorDirectory: '/tmp/project/.aicc-recovery',
    webGpt: { enabled: true, endpoint: 'http://127.0.0.1:17841', model: 'chatgpt-web/temporary/high' }
  };
  const result = await requestWebGptRescueAdvice(plan, { trigger: 'desktop_disappeared_without_terminal_result' }, {
    sleep: async () => {},
    fetchImpl: async (url, options = {}) => {
      calls.push([url, options.method ?? 'GET']);
      if (url.endsWith('/healthz')) return new Response(JSON.stringify(health), { headers: { 'content-type': 'application/json' } });
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message' }] }), { headers: { 'content-type': 'application/json' } });
    }
  });
  assert.equal(result.state, 'COMPLETED');
  assert.deepEqual(calls.map(([, method]) => method), ['GET', 'GET', 'POST']);
  assert.equal(bodies[0].model, 'chatgpt-web/temporary/high');
  assert.equal(bodies[0].client_metadata['x-codex-turn-metadata'].includes('"sandbox":"read-only"'), true);
  assert.match(bodies[0].input[0].content[0].text, /<sandbox_mode>read-only<\/sandbox_mode>/);
  assert.match(bodies[0].input[1].content[0].text, /sanitized owner-generated mirror/);
});

test('Web GPT advisor rejects an HTTP 200 failed turn', async () => {
  const health = {
    status: 'ok', accepting_turns: true, accepting_browser_turns: true,
    active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0
  };
  const result = await requestWebGptRescueAdvice({
    projectRoot: '/tmp/project', taskId: 'task-1', operationId: 'operation-1',
    workspaceMirrorDirectory: '/tmp/project/.aicc-recovery',
    webGpt: { enabled: true, endpoint: 'http://127.0.0.1:17841', model: 'chatgpt-web/temporary/high' }
  }, { trigger: 'desktop_disappeared_without_terminal_result' }, {
    sleep: async () => {},
    fetchImpl: async (url) => {
      if (url.endsWith('/healthz')) return new Response(JSON.stringify(health), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ status: 'failed', error: { message: 'turn failed' } }), { headers: { 'content-type': 'application/json' } });
    }
  });
  assert.equal(result.state, 'FAILED');
  assert.equal(result.response.ok, true);
  assert.equal(result.response.body.status, 'failed');
});

test('Web GPT advisor fails closed on UNKNOWN activity', async () => {
  let posts = 0;
  const result = await requestWebGptRescueAdvice({
    projectRoot: '/tmp/project', taskId: 'task-1', operationId: 'operation-1',
    workspaceMirrorDirectory: '/tmp/project/.aicc-recovery',
    webGpt: { enabled: true, endpoint: 'http://127.0.0.1:17841', model: 'chatgpt-web/saved/extra-high' }
  }, { trigger: 'guardian_expired' }, {
    fetchImpl: async (_url, options = {}) => {
      if (options.method === 'POST') posts += 1;
      return new Response(JSON.stringify({ status: 'ok', accepting_turns: true }), { headers: { 'content-type': 'application/json' } });
    }
  });
  assert.equal(result.state, 'NOT_EXACT_IDLE');
  assert.equal(posts, 0);
});
