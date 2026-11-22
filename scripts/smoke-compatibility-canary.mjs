import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCompatibilityMatrix, evaluateRegression, loadReleaseMatrix, validateCanaryEnvironment, verifyStartOnce } from '../src/compatibility/lab.mjs';
import { UpdateCoordinator } from '../src/compatibility/update-coordinator.mjs';

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForFile(file, child, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    if (child.exitCode !== null) throw new Error(`canary listener exited early: ${child.exitCode}`);
    await delay(25);
  }
  throw new Error('canary listener readiness timed out');
}

async function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) return child.exitCode;
  return await Promise.race([
    new Promise(resolve => child.once('exit', code => resolve(code))),
    delay(timeoutMs).then(() => { child.kill('SIGKILL'); throw new Error('child exit timed out'); })
  ]);
}

async function health(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return { reachable: true, status: response.status };
  } catch (error) {
    return { reachable: false, status: null, error: error.name };
  }
}

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-phase10-canary-'));
const canaryRoot = path.join(temporaryRoot, 'canary');
const listenerPort = await freePort();
const definition = {
  root: canaryRoot,
  stateRoot: path.join(canaryRoot, 'state'),
  databaseRoot: path.join(canaryRoot, 'db'),
  profileRoot: path.join(canaryRoot, 'profile'),
  artifactRoot: path.join(canaryRoot, 'artifacts'),
  ports: { loginService: listenerPort, aicc: await freePort(), webGpt: await freePort(), ocx: await freePort() }
};
const environment = validateCanaryEnvironment(definition, {
  activeRoots: [
    path.join(os.homedir(), '.ai-control-center'),
    path.join(os.homedir(), '.codex'),
    path.join(os.homedir(), '.opencodex')
  ]
});

fs.mkdirSync(definition.stateRoot, { recursive: true, mode: 0o700 });
const release = loadReleaseMatrix();
const compatibility = buildCompatibilityMatrix(release, { evidenceRef: 'phase-10-canary' });
const incompatibleCompatibility = structuredClone(compatibility);
incompatibleCompatibility.components[0].compatibility = 'blocked';
const regressionInput = {
  checks: release.requiredRegression.map(id => ({ id, status: 'pass' })),
  directRescue: release.requiredDirectRescue.map(id => ({ id, status: 'pass' })),
  compatibility
};
const regression = evaluateRegression(release, regressionInput);
const incompatibleRegression = evaluateRegression(release, { ...regressionInput, compatibility: incompatibleCompatibility });
const coordinator = new UpdateCoordinator({ stateRoot: path.join(definition.stateRoot, 'coordinator') });
const basePlan = {
  targetComponent: 'fixture-component',
  currentVersion: '1.0.0',
  targetVersion: '1.0.0',
  preconditionHash: digest('fixture-current'),
  desiredHash: digest('fixture-target'),
  rollbackRef: 'task-owned:fixture-current',
  backupRef: 'task-owned:fixture-backup',
  activeWorkProof: { count: 0, observedAt: new Date().toISOString(), source: 'task-owned-canary' },
  compatibility: regression,
  compatibilityHash: compatibility.hash,
  directRescue: regressionInput.directRescue,
  allowSameReleaseCanary: true
};
coordinator.createPlan({ ...basePlan, operationId: 'commit-canary' });
coordinator.lease('commit-canary', basePlan.preconditionHash);
coordinator.recordStage('commit-canary', 'shadow', { status: 'pass', ref: 'task-owned:shadow' });
coordinator.recordStage('commit-canary', 'canary', { status: 'pass', ref: 'task-owned:canary' });
coordinator.recordStage('commit-canary', 'default', { status: 'pass', ref: 'task-owned:default' });

coordinator.createPlan({ ...basePlan, operationId: 'rollback-canary', desiredHash: digest('fixture-bad-target') });
coordinator.lease('rollback-canary', basePlan.preconditionHash);
coordinator.recordStage('rollback-canary', 'shadow', { status: 'pass', ref: 'task-owned:rollback-shadow' });
coordinator.recordStage('rollback-canary', 'canary', { status: 'pass', ref: 'task-owned:rollback-canary' });
coordinator.rollback('rollback-canary', { restoredHash: basePlan.preconditionHash, ref: 'task-owned:exact-restore' });

const readyFile = path.join(temporaryRoot, 'listener-ready.json');
const child = spawn(process.execPath, [path.join(sourceRoot, 'scripts', 'fixtures', 'compatibility-listener.mjs'), String(listenerPort), readyFile], { stdio: ['ignore', 'pipe', 'pipe'] });
const listener = await waitForFile(readyFile, child);
const listenerHealth = await health(`http://127.0.0.1:${listenerPort}/healthz`);
const duplicate = spawn(process.execPath, [path.join(sourceRoot, 'scripts', 'fixtures', 'compatibility-listener.mjs'), String(listenerPort), path.join(temporaryRoot, 'duplicate-ready.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
let duplicateStderr = '';
duplicate.stderr.on('data', chunk => { duplicateStderr += chunk.toString(); });
const duplicateExit = await waitForExit(duplicate);

const startOnce = verifyStartOnce({
  services: [{ label: 'aicc-phase10-isolated-login', pid: listener.pid, listener: listener.listener, active: true, restartCount: 0, kind: 'daemon', keepAlive: false }],
  duplicateJobs: 0
});
const liveBefore = {
  webGpt: await health('http://127.0.0.1:17841/healthz'),
  ocx: await health('http://127.0.0.1:10100/healthz')
};

const firstFailure = coordinator.recordRestartFailure('fixture-failing-adapter', { fingerprint: 'fixture-startup-error', evidenceRef: 'task-owned:restart-1' });
const secondFailure = coordinator.recordRestartFailure('fixture-failing-adapter', { fingerprint: 'fixture-startup-error', evidenceRef: 'task-owned:restart-2' });
const foreignBudget = coordinator.recordRestartFailure('fixture-surviving-adapter', { fingerprint: 'independent-observation', evidenceRef: 'task-owned:independent' });
const state = coordinator.status();

child.kill('SIGTERM');
await waitForExit(child);
const liveAfter = {
  webGpt: await health('http://127.0.0.1:17841/healthz'),
  ocx: await health('http://127.0.0.1:10100/healthz')
};

const report = {
  ok: environment.ok && regression.ok && !incompatibleRegression.ok && incompatibleRegression.activeReleaseMayChange === false && listenerHealth.status === 200 && duplicateExit !== 0 && /EADDRINUSE/.test(duplicateStderr) && startOnce.ok && firstFailure.restartAllowed && !secondFailure.restartAllowed && foreignBudget.restartAllowed && liveBefore.webGpt.status === 200 && liveBefore.ocx.status === 200 && liveAfter.webGpt.status === 200 && liveAfter.ocx.status === 200,
  environment: { ...environment, root: '<task-owned-temp>', writableRoots: environment.writableRoots.map(() => '<task-owned-temp>') },
  compatibility: { releaseId: compatibility.releaseId, componentCount: compatibility.components.length, hash: compatibility.hash, incompatible: compatibility.components.filter(item => item.compatibility !== 'compatible').map(item => item.id) },
  regression,
  incompatibleCanary: { blockedBeforeApply: !incompatibleRegression.ok && incompatibleRegression.activeReleaseMayChange === false, incompatible: incompatibleRegression.incompatible },
  update: { committed: state.plans.find(item => item.operationId === 'commit-canary')?.state, rolledBack: state.plans.find(item => item.operationId === 'rollback-canary')?.state, activePlans: state.activePlans },
  startOnce: { ...startOnce, listenerHealth, duplicateRejected: duplicateExit !== 0 && /EADDRINUSE/.test(duplicateStderr) },
  restartBudget: { firstFailure, secondFailure, independentComponent: foreignBudget, quarantinedComponents: state.quarantinedComponents },
  liveIsolation: { before: liveBefore, after: liveAfter, routesRestarted: false },
  cleanup: { listenerExited: child.exitCode === 0, canaryRootOwned: true }
};

fs.rmSync(temporaryRoot, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
