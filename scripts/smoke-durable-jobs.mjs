import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { JobManager } from '../src/jobs/job-manager.mjs';
import { ArtifactRegistry } from '../src/artifacts/registry.mjs';

const requestedRoot = process.env.AICC_PHASE07_SMOKE_ROOT?.trim();
const root = requestedRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-phase07-smoke-'));
const storeRoot = path.join(root, 'store');
const effectFile = path.join(root, 'external-effects.txt');
const outputFile = path.join(root, 'representative-code.mjs');
const requestHash = crypto.createHash('sha256').update('phase07-smoke-request').digest('hex');
const workerScript = fileURLToPath(new URL('./fixtures/durable-job-worker.mjs', import.meta.url));
const worker = { workerId: 'phase07-writer', workloadClasses: ['batch'], modes: ['write'], routeIds: ['native-direct'], maxActive: 1 };
let child = null;

function waitForReady(processHandle) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('worker ready timeout')), 5_000);
    processHandle.stdout.setEncoding('utf8');
    processHandle.stdout.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      try { resolve(JSON.parse(buffer.slice(0, newline))); }
      catch (error) { reject(error); }
    });
    processHandle.once('error', error => { clearTimeout(timeout); reject(error); });
    processHandle.once('exit', code => {
      if (!buffer.includes('\n')) { clearTimeout(timeout); reject(new Error(`worker exited before ready: ${code}`)); }
    });
  });
}

function waitForExit(processHandle) {
  return new Promise(resolve => processHandle.once('exit', (code, signal) => resolve({ code, signal })));
}

try {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const firstStore = new DurableJobStore({ root: storeRoot });
  const firstManager = new JobManager({ store: firstStore, leaseDurationMs: 400 });
  const submitted = firstManager.submit({
    jobId: 'phase07-restart-job', idempotencyKey: 'phase07-restart-key', workloadClass: 'batch',
    workspaceId: '/phase07/task-owned-workspace', requestedRoute: 'native-direct', identityBinding: 'fixture:local',
    mode: 'write', requestRef: 'request://phase07-smoke', requestHash
  });
  const lease = firstManager.dispatch(submitted.job.jobId, worker);
  child = spawn(process.execPath, [workerScript, storeRoot, submitted.job.jobId, lease.attempt.attemptId, effectFile], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  const ready = await waitForReady(child);
  const childPid = child.pid;
  const exitPromise = waitForExit(child);
  child.kill('SIGTERM');
  const killed = await exitPromise;
  child = null;
  await new Promise(resolve => setTimeout(resolve, 450));

  const restartedStore = new DurableJobStore({ root: storeRoot });
  const restartedManager = new JobManager({ store: restartedStore, leaseDurationMs: 400 });
  const recovered = restartedManager.recoverExpired();
  const duplicate = restartedManager.submit({
    idempotencyKey: 'phase07-restart-key', workloadClass: 'batch', workspaceId: '/phase07/task-owned-workspace',
    requestedRoute: 'native-direct', identityBinding: 'fixture:local', mode: 'write',
    requestRef: 'request://phase07-smoke', requestHash
  });
  restartedManager.resume(submitted.job.jobId);
  const retry = restartedManager.dispatch(submitted.job.jobId, worker);
  restartedManager.start(submitted.job.jobId, retry.attempt.attemptId);
  const duplicateEffect = restartedManager.reserveEffect(submitted.job.jobId, retry.attempt.attemptId, 'external-write', 'effect://phase07-smoke');

  fs.writeFileSync(outputFile, 'export const phase07DurableRecovery = true;\n', { mode: 0o600 });
  const artifacts = new ArtifactRegistry({ store: restartedStore });
  const registered = artifacts.register({
    artifactId: 'phase07-code-artifact', jobId: submitted.job.jobId,
    inputSources: [{ ref: 'request://phase07-smoke', sha256: requestHash }],
    generator: { tool: 'smoke-durable-jobs', version: '1', routeId: 'native-direct' },
    privatePath: outputFile, outputRef: 'artifact://phase07/representative-code.mjs', mediaType: 'text/javascript',
    sensitivity: 'internal', rollbackRef: 'backup://phase07-smoke'
  }).artifact;
  const verified = artifacts.verify(registered.artifactId, [
    { type: 'exact-bytes' },
    { type: 'code-test', executable: process.execPath, args: ['--check', outputFile] }
  ]);
  restartedManager.beginVerification(submitted.job.jobId, retry.attempt.attemptId);
  const completed = restartedManager.complete(submitted.job.jobId, retry.attempt.attemptId, [registered.artifactId]);
  const markerLines = fs.readFileSync(effectFile, 'utf8').trim().split('\n').filter(Boolean);
  const backup = restartedStore.backup('post-recovery');
  const report = {
    ok: completed.state === 'completed' && markerLines.length === 1 && duplicate.duplicate && !duplicateEffect.created,
    root,
    worker: { pid: childPid, ready, exit: killed },
    recovery: { recovered: recovered.recovered, duplicateSubmit: duplicate.duplicate, attempts: completed.attempts.length },
    sideEffects: { markerCount: markerLines.length, duplicateReservationCreated: duplicateEffect.created },
    artifact: { artifactId: verified.artifactId, sha256: verified.output.sha256, verification: verified.verification.map(item => ({ type: item.type, status: item.status })) },
    store: { ...restartedManager.status(), backup: { directory: backup.directory, stateHash: backup.manifest.stateHash } }
  };
  const reportPath = process.env.AICC_PHASE07_SMOKE_REPORT?.trim();
  if (reportPath) fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} finally {
  if (child) child.kill('SIGTERM');
  if (!requestedRoot) fs.rmSync(root, { recursive: true, force: true });
}
