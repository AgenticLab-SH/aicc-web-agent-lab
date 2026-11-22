import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactRegistry } from './artifacts/registry.mjs';
import { DurableJobStore } from './jobs/durable-store.mjs';
import { JobManager } from './jobs/job-manager.mjs';
import { loadMonitoringManifest } from './monitoring.mjs';
import { scanLocalUpstreams, upstreamMonitorPaths } from './upstream-monitor.mjs';

const REQUEST_REF = /^monitoring:\/\/requests\/([a-f0-9]{64})$/;
const ACTIVE = new Set(['leased', 'running', 'verifying']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const WORKER = Object.freeze({
  workerId: 'local-upstream-monitor',
  workloadClasses: ['batch'],
  modes: ['read-only'],
  routeIds: ['local-deterministic'],
  maxActive: 1
});

export class MonitoringJobServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MonitoringJobServiceError';
    this.code = code;
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ensureOwnerDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new MonitoringJobServiceError('owner_state_symlink_denied', 'monitoring owner state directories must be real directories, not symlinks');
  }
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function atomicJson(file, value) {
  ensureOwnerDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function defaultPaths(options = {}) {
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center');
  const monitoringRoot = options.monitoringRoot ?? path.join(stateRoot, 'monitoring');
  return {
    stateRoot,
    root: options.root ?? path.join(monitoringRoot, 'scheduler'),
    jobsRoot: options.jobsRoot ?? path.join(stateRoot, 'jobs'),
    upstreamState: options.upstreamStatePath ?? upstreamMonitorPaths({ ...options, stateRoot }).state
  };
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new MonitoringJobServiceError('invalid_request', `${label} is required`);
  return value.trim();
}

export class MonitoringJobService {
  constructor({ manager, artifactRegistry, scan = scanLocalUpstreams, now = () => Date.now(), manifest, ...options } = {}) {
    const paths = defaultPaths(options);
    this.root = path.resolve(paths.root);
    this.requestsRoot = path.join(this.root, 'requests');
    this.upstreamState = path.resolve(paths.upstreamState);
    this.now = now;
    this.scan = scan;
    this.options = options;
    this.manifest = manifest ?? loadMonitoringManifest(options.manifestPath);
    this.intervalMs = this.manifest.policy.localScanIntervalHours * 60 * 60_000;
    ensureOwnerDirectory(this.root);
    ensureOwnerDirectory(this.requestsRoot);
    const store = manager?.store ?? new DurableJobStore({ root: paths.jobsRoot, now });
    this.manager = manager ?? new JobManager({ store, now });
    this.artifacts = artifactRegistry ?? new ArtifactRegistry({ store: this.manager.store, now });
  }

  #jobs() {
    return this.manager.read().filter(job => String(job.requestRef).startsWith('monitoring://requests/'));
  }

  #requestFile(requestHash) {
    return path.join(this.requestsRoot, `${requestHash}.json`);
  }

  #writeRequest(requestHash, request) {
    const file = this.#requestFile(requestHash);
    if (fs.existsSync(file)) {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (hash(current) !== requestHash) throw new MonitoringJobServiceError('request_conflict', 'durable monitoring request hash does not match');
      return file;
    }
    atomicJson(file, request);
    return file;
  }

  #readRequest(requestHash) {
    const file = this.#requestFile(requestHash);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new MonitoringJobServiceError('request_invalid', 'monitoring request must be a regular owner file');
    const request = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (hash(request) !== requestHash) throw new MonitoringJobServiceError('request_invalid', 'monitoring request content changed');
    return { request, file };
  }

  status() {
    const jobs = this.#jobs();
    const latest = [...jobs].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] ?? null;
    return {
      schemaVersion: 1,
      owner: 'durable-job-manager',
      automaticApply: false,
      dashboardExecutesScan: false,
      cadenceHours: this.manifest.policy.localScanIntervalHours,
      activeJobIds: jobs.filter(job => ACTIVE.has(job.state)).map(job => job.jobId),
      queuedJobIds: jobs.filter(job => job.state === 'queued').map(job => job.jobId),
      latestJob: latest ? { jobId: latest.jobId, state: latest.state, createdAt: latest.createdAt, updatedAt: latest.updatedAt, terminalReason: latest.terminalReason } : null
    };
  }

  preview() {
    return {
      schemaVersion: 1,
      requiresConfirmation: true,
      operation: 'local-upstream-scan',
      sourceCount: this.manifest.sources?.length ?? null,
      automaticApply: false,
      executionOwner: 'durable-job-manager',
      writes: ['owner-only upstream revision snapshot', 'owner-only durable job checkpoint', 'verified run artifact']
    };
  }

  enqueue({ confirmed = false, requestId, idempotencyKey } = {}) {
    if (confirmed !== true) throw new MonitoringJobServiceError('confirmation_required', 'manual upstream monitoring confirmation is required');
    const request = {
      schemaVersion: 1,
      requestId: requireText(requestId, 'request id'),
      operation: 'local-upstream-scan',
      automaticApply: false
    };
    const requestHash = hash(request);
    const requestFile = this.#writeRequest(requestHash, request);
    const submitted = this.manager.submit({
      jobId: `monitor-${requestHash.slice(0, 24)}`,
      idempotencyKey: requireText(idempotencyKey, 'idempotency key'),
      workloadClass: 'batch',
      workspaceId: this.root,
      requestedRoute: 'local-deterministic',
      identityBinding: 'owner-local',
      mode: 'read-only',
      requestRef: `monitoring://requests/${requestHash}`,
      requestHash
    });
    if (submitted.duplicate && submitted.job.requestHash !== requestHash) throw new MonitoringJobServiceError('idempotency_conflict', 'idempotency key already refers to another monitoring request');
    return { job: submitted.job, duplicate: submitted.duplicate, requestRef: `monitoring://requests/${requestHash}`, requestFile };
  }

  enqueueDue() {
    const jobs = this.#jobs();
    if (jobs.some(job => !TERMINAL.has(job.state))) return { due: false, reason: 'pending-job', job: jobs.find(job => !TERMINAL.has(job.state)) };
    const last = [...jobs].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0];
    if (last && this.now() - Date.parse(last.createdAt) < this.intervalMs) return { due: false, reason: 'cadence-current', job: last };
    const window = Math.floor(this.now() / this.intervalMs);
    return { due: true, ...this.enqueue({ confirmed: true, requestId: `scheduled-${window}`, idempotencyKey: `local-upstream-window-${window}` }) };
  }

  async runOnce(jobId) {
    let job = this.manager.read(requireText(jobId, 'job id'));
    if (!String(job.requestRef).startsWith('monitoring://requests/')) throw new MonitoringJobServiceError('job_scope_denied', 'job is not an upstream monitoring job');
    if (job.state === 'completed') return { job, duplicate: true };
    if (job.state === 'paused') { this.manager.resume(job.jobId); job = this.manager.read(job.jobId); }
    if (job.state !== 'queued') throw new MonitoringJobServiceError(ACTIVE.has(job.state) ? 'job_already_active' : 'job_not_runnable', `monitoring job is ${job.state}`);
    const requestHash = REQUEST_REF.exec(job.requestRef)?.[1];
    if (!requestHash || requestHash !== job.requestHash) throw new MonitoringJobServiceError('request_ref_invalid', 'monitoring request reference is invalid');
    const { request, file: requestFile } = this.#readRequest(requestHash);
    const lease = this.manager.dispatch(job.jobId, WORKER);
    const attemptId = lease.attempt.attemptId;
    this.manager.start(job.jobId, attemptId);
    this.manager.heartbeat(job.jobId, attemptId, { ref: job.requestRef, sha256: fileHash(requestFile) });
    try {
      const report = await this.scan({ ...this.options, upstreamStatePath: this.upstreamState });
      if (!fs.existsSync(this.upstreamState)) throw new MonitoringJobServiceError('artifact_missing', 'upstream scan did not create its owner snapshot');
      const sha256 = fileHash(this.upstreamState);
      const artifactId = `monitoring-snapshot-${job.jobId}`;
      this.artifacts.register({
        artifactId,
        jobId: job.jobId,
        inputSources: [{ ref: job.requestRef, sha256: requestHash }],
        generator: { tool: 'aicc-local-upstream-monitor', version: '1', routeId: 'local-deterministic' },
        outputRef: `monitoring://snapshots/${job.jobId}`,
        privatePath: this.upstreamState,
        mediaType: 'application/json',
        sensitivity: 'private',
        rollbackRef: 'monitoring://snapshots/owner-backup-required'
      });
      this.artifacts.verify(artifactId, [{ type: 'exact-bytes', expectedSha256: sha256 }]);
      this.manager.beginVerification(job.jobId, attemptId);
      this.manager.recordResult(job.jobId, attemptId, {
        resultId: `monitoring-result-${job.jobId}`,
        claim: 'The registered local upstream sources were scanned without applying updates.',
        evidence: [{ ref: `monitoring://snapshots/${job.jobId}`, sha256 }],
        unknown: report?.counts?.unknown ? `${report.counts.unknown} sources remain unknown.` : null,
        recommendation: 'Review exact pinned diffs and licenses before any update.',
        artifactRefs: [artifactId],
        validatorStatus: report?.counts?.unknown ? 'unknown' : 'pass'
      });
      const completed = this.manager.complete(job.jobId, attemptId, [artifactId]);
      return { job: completed, duplicate: false, request, report, artifact: { artifactId, sha256 } };
    } catch (error) {
      try { this.manager.failAttempt(job.jobId, attemptId, error?.code ?? 'monitoring_scan_failed'); } catch { /* preserve original error */ }
      throw error;
    }
  }
}

export function createMonitoringJobService(options = {}) {
  return new MonitoringJobService(options);
}
