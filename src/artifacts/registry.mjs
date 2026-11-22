import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SHA256 = /^[a-f0-9]{64}$/;
const SENSITIVITY = new Set(['public', 'internal', 'private']);
const CHECK_TYPES = new Set(['exact-bytes', 'code-test', 'document-pdf', 'browser-visual', 'deployment']);

export class ArtifactRegistryError extends Error {
  constructor(code, message) { super(message); this.name = 'ArtifactRegistryError'; this.code = code; }
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new ArtifactRegistryError('invalid_artifact', `${label} is required`);
  return value.trim();
}

function validateSource(source) {
  const ref = requireString(source?.ref, 'input source ref');
  const sha256 = requireString(source?.sha256, 'input source sha256');
  if (!SHA256.test(sha256)) throw new ArtifactRegistryError('invalid_artifact', 'input source sha256 is invalid');
  return { ref, sha256 };
}

function safeCommand(check, runner) {
  const executable = requireString(check.executable, 'verification executable');
  const args = Array.isArray(check.args) && check.args.every(value => typeof value === 'string') ? check.args : [];
  const result = runner(executable, args, {
    cwd: check.cwd && path.isAbsolute(check.cwd) ? check.cwd : undefined,
    encoding: 'utf8',
    timeout: Number.isInteger(check.timeoutMs) ? Math.min(check.timeoutMs, 300_000) : 120_000,
    windowsHide: true,
    shell: false
  });
  return { pass: !result.error && result.status === 0, exitCode: result.status ?? null, signal: result.signal ?? null };
}

function evidenceFile(check) {
  const evidencePath = requireString(check.evidencePath, 'verification evidence path');
  if (!path.isAbsolute(evidencePath)) throw new ArtifactRegistryError('invalid_check', 'verification evidence path must be absolute');
  try {
    const stat = fs.statSync(evidencePath);
    if (!stat.isFile() || stat.size === 0) return { pass: false, evidenceRef: check.evidenceRef ?? null, evidenceSha256: null };
    const sha256 = hashFile(evidencePath);
    return {
      pass: !check.expectedSha256 || check.expectedSha256 === sha256,
      evidenceRef: requireString(check.evidenceRef, 'verification evidence ref'),
      evidenceSha256: sha256
    };
  } catch {
    return { pass: false, evidenceRef: check.evidenceRef ?? null, evidenceSha256: null };
  }
}

export class ArtifactRegistry {
  constructor({ store, now = () => Date.now(), commandRunner = spawnSync, deploymentProbe = null } = {}) {
    if (!store) throw new ArtifactRegistryError('store_required', 'durable job store is required');
    this.store = store;
    this.now = now;
    this.commandRunner = commandRunner;
    this.deploymentProbe = deploymentProbe;
  }

  register(spec) {
    const privatePath = requireString(spec.privatePath, 'artifact private path');
    if (!path.isAbsolute(privatePath)) throw new ArtifactRegistryError('invalid_artifact', 'artifact private path must be absolute');
    const stat = fs.statSync(privatePath);
    if (!stat.isFile()) throw new ArtifactRegistryError('invalid_artifact', 'artifact output must be a file');
    const sensitivity = requireString(spec.sensitivity, 'artifact sensitivity');
    if (!SENSITIVITY.has(sensitivity)) throw new ArtifactRegistryError('secret_artifact_prohibited', 'secret-prohibited artifacts cannot be registered');
    const artifactId = spec.artifactId?.trim() || crypto.randomUUID();
    const outputSha256 = hashFile(privatePath);
    const record = {
      contractVersion: 1,
      artifactId,
      jobId: requireString(spec.jobId, 'artifact job id'),
      inputSources: (spec.inputSources ?? []).map(validateSource),
      generator: {
        tool: requireString(spec.generator?.tool, 'generator tool'),
        version: requireString(spec.generator?.version, 'generator version'),
        routeId: requireString(spec.generator?.routeId, 'generator route id')
      },
      output: {
        ref: requireString(spec.outputRef, 'artifact output ref'),
        sha256: outputSha256,
        mediaType: requireString(spec.mediaType, 'artifact media type')
      },
      verification: [],
      verificationCurrent: false,
      verifiedAt: null,
      sensitivity,
      rollbackRef: requireString(spec.rollbackRef, 'artifact rollback ref'),
      privatePath,
      bytes: stat.size,
      createdAt: new Date(this.now()).toISOString(),
      staleReason: null
    };
    return this.store.transaction('artifact.register', state => {
      if (!state.jobs[record.jobId]) throw new ArtifactRegistryError('job_not_found', `unknown artifact job: ${record.jobId}`);
      const existing = state.artifacts[artifactId];
      if (existing) {
        if (existing.jobId === record.jobId && existing.output.sha256 === record.output.sha256 && existing.output.ref === record.output.ref) {
          return { artifact: existing, duplicate: true };
        }
        throw new ArtifactRegistryError('artifact_exists', `artifact already exists: ${artifactId}`);
      }
      state.artifacts[artifactId] = record;
      return { artifact: record, duplicate: false };
    }).result;
  }

  verify(artifactId, checks) {
    if (!Array.isArray(checks) || checks.length === 0) throw new ArtifactRegistryError('checks_required', 'at least one artifact verification is required');
    const before = this.store.read().state.artifacts[artifactId];
    if (!before) throw new ArtifactRegistryError('artifact_not_found', `unknown artifact: ${artifactId}`);
    const observedHash = hashFile(before.privatePath);
    const results = checks.map(check => {
      if (!CHECK_TYPES.has(check.type)) throw new ArtifactRegistryError('invalid_check', `unsupported verification type: ${check.type}`);
      let detail;
      if (check.type === 'exact-bytes') {
        detail = { pass: observedHash === (check.expectedSha256 ?? before.output.sha256), observedSha256: observedHash };
      } else if (check.type === 'code-test') {
        detail = safeCommand(check, this.commandRunner);
      } else if (check.type === 'document-pdf') {
        const magic = fs.readFileSync(before.privatePath).subarray(0, 5).toString('ascii') === '%PDF-';
        const evidence = evidenceFile(check);
        detail = { ...evidence, pass: magic && evidence.pass, pdfMagic: magic };
      } else if (check.type === 'browser-visual') {
        detail = evidenceFile(check);
      } else {
        if (typeof this.deploymentProbe !== 'function') detail = { pass: false, reason: 'deployment_probe_unavailable' };
        else {
          const probed = this.deploymentProbe(check);
          detail = { pass: probed?.ok === true, status: probed?.status ?? null, evidenceRef: probed?.evidenceRef ?? null };
        }
      }
      return {
        type: check.type,
        status: detail.pass ? 'pass' : 'fail',
        checkedAt: new Date(this.now()).toISOString(),
        ...Object.fromEntries(Object.entries(detail).filter(([key]) => key !== 'pass'))
      };
    });
    const allPassed = observedHash === before.output.sha256 && results.every(result => result.status === 'pass');
    return this.store.transaction('artifact.verify', state => {
      const current = state.artifacts[artifactId];
      if (!current || current.output.sha256 !== before.output.sha256 || current.privatePath !== before.privatePath) {
        throw new ArtifactRegistryError('artifact_changed', 'artifact registration changed during verification');
      }
      current.verification = results;
      current.verificationCurrent = allPassed;
      current.verifiedAt = new Date(this.now()).toISOString();
      current.staleReason = allPassed ? null : observedHash !== before.output.sha256 ? 'output_hash_changed' : 'verification_failed';
      return current;
    }).result;
  }

  refresh(artifactId) {
    const before = this.store.read().state.artifacts[artifactId];
    if (!before) throw new ArtifactRegistryError('artifact_not_found', `unknown artifact: ${artifactId}`);
    let observedHash = null;
    try { observedHash = hashFile(before.privatePath); } catch { /* missing output */ }
    return this.store.transaction('artifact.refresh', state => {
      const current = state.artifacts[artifactId];
      if (!current) throw new ArtifactRegistryError('artifact_not_found', `unknown artifact: ${artifactId}`);
      const isCurrent = observedHash === current.output.sha256 && current.verification.length > 0 && current.verification.every(item => item.status === 'pass');
      current.verificationCurrent = isCurrent;
      current.staleReason = isCurrent ? null : observedHash === null ? 'output_missing' : 'output_hash_changed';
      return { artifactId, current: isCurrent, observedSha256: observedHash, expectedSha256: current.output.sha256 };
    }).result;
  }

  get(artifactId, { includePrivatePath = false } = {}) {
    const artifact = this.store.read().state.artifacts[artifactId];
    if (!artifact) throw new ArtifactRegistryError('artifact_not_found', `unknown artifact: ${artifactId}`);
    const copy = structuredClone(artifact);
    if (!includePrivatePath) delete copy.privatePath;
    return copy;
  }
}
