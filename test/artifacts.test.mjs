import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { JobManager } from '../src/jobs/job-manager.mjs';
import { ArtifactRegistry, ArtifactRegistryError } from '../src/artifacts/registry.mjs';

const REQUEST_HASH = crypto.createHash('sha256').update('artifact-request').digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new DurableJobStore({ root: path.join(root, 'state') });
  const manager = new JobManager({ store });
  const registry = new ArtifactRegistry({ store });
  return { root, store, manager, registry };
}

function activeJob(manager, jobId = 'artifact-job') {
  const job = manager.submit({
    jobId, idempotencyKey: jobId, workloadClass: 'batch', workspaceId: '/workspace/artifacts',
    requestedRoute: 'native-direct', identityBinding: 'account:fixture', mode: 'read-only',
    requestRef: 'request://artifact', requestHash: REQUEST_HASH
  }).job;
  const lease = manager.dispatch(job.jobId, { workerId: 'artifact-worker', workloadClasses: ['batch'], modes: ['read-only'], routeIds: ['native-direct'] });
  manager.start(job.jobId, lease.attempt.attemptId);
  return { job, attemptId: lease.attempt.attemptId };
}

function register(registry, root, jobId, overrides = {}) {
  const output = overrides.privatePath ?? path.join(root, `${jobId}.txt`);
  if (!fs.existsSync(output)) fs.writeFileSync(output, 'verified output\n');
  return registry.register({
    artifactId: overrides.artifactId ?? `${jobId}-artifact`, jobId,
    inputSources: [{ ref: 'source://fixture', sha256: REQUEST_HASH }],
    generator: { tool: 'node', version: process.version, routeId: 'native-direct' },
    privatePath: output, outputRef: `artifact://${jobId}`, mediaType: overrides.mediaType ?? 'text/plain',
    sensitivity: overrides.sensitivity ?? 'internal', rollbackRef: 'backup://fixture'
  });
}

test('artifact registry records provenance and exact-byte verification before completion', t => {
  const { root, manager, registry } = fixture(t);
  const { job, attemptId } = activeJob(manager);
  const registered = register(registry, root, job.jobId);
  const verified = registry.verify(registered.artifact.artifactId, [{ type: 'exact-bytes' }]);
  assert.equal(verified.verificationCurrent, true);
  assert.equal(verified.inputSources[0].sha256, REQUEST_HASH);
  assert.equal(registry.get(verified.artifactId).privatePath, undefined);
  manager.beginVerification(job.jobId, attemptId);
  assert.equal(manager.complete(job.jobId, attemptId, [verified.artifactId]).state, 'completed');
});

test('failed verification cannot complete and changed output invalidates stale evidence', t => {
  const { root, manager, registry } = fixture(t);
  const { job, attemptId } = activeJob(manager, 'stale-job');
  const registered = register(registry, root, job.jobId);
  const artifactId = registered.artifact.artifactId;
  const failed = registry.verify(artifactId, [{ type: 'exact-bytes', expectedSha256: '0'.repeat(64) }]);
  assert.equal(failed.verificationCurrent, false);
  manager.beginVerification(job.jobId, attemptId);
  assert.throws(() => manager.complete(job.jobId, attemptId, [artifactId]), error => error.code === 'artifact_unverified');

  registry.verify(artifactId, [{ type: 'exact-bytes' }]);
  fs.appendFileSync(registered.artifact.privatePath, 'drift');
  assert.equal(registry.refresh(artifactId).current, false);
  assert.throws(() => manager.complete(job.jobId, attemptId, [artifactId]), error => error.code === 'artifact_unverified');
});

test('code verification executes without a shell and stores only exit metadata', t => {
  const { root, manager, registry } = fixture(t);
  const { job } = activeJob(manager, 'code-job');
  const registered = register(registry, root, job.jobId);
  const verified = registry.verify(registered.artifact.artifactId, [{ type: 'code-test', executable: process.execPath, args: ['-e', 'process.exit(0)'] }]);
  assert.equal(verified.verificationCurrent, true);
  assert.deepEqual(verified.verification[0].exitCode, 0);
  assert.equal(JSON.stringify(verified).includes('stdout'), false);
});

test('PDF and browser verification require separate non-empty evidence files', t => {
  const { root, manager, registry } = fixture(t);
  const { job } = activeJob(manager, 'pdf-job');
  const pdf = path.join(root, 'fixture.pdf');
  const rendered = path.join(root, 'rendered.png');
  const browser = path.join(root, 'browser.png');
  fs.writeFileSync(pdf, Buffer.from('%PDF-1.4\nfixture\n%%EOF\n'));
  fs.writeFileSync(rendered, 'render-evidence');
  fs.writeFileSync(browser, 'browser-evidence');
  const registered = register(registry, root, job.jobId, { privatePath: pdf, mediaType: 'application/pdf' });
  const verified = registry.verify(registered.artifact.artifactId, [
    { type: 'document-pdf', evidencePath: rendered, evidenceRef: 'evidence://rendered' },
    { type: 'browser-visual', evidencePath: browser, evidenceRef: 'evidence://browser' }
  ]);
  assert.equal(verified.verificationCurrent, true);
  assert.equal(verified.verification.length, 2);
  assert.ok(verified.verification.every(result => result.evidenceSha256));
});

test('secret-prohibited artifact classification and unsupported checks fail closed', t => {
  const { root, manager, registry } = fixture(t);
  const { job } = activeJob(manager, 'secret-job');
  assert.throws(() => register(registry, root, job.jobId, { sensitivity: 'secret-prohibited' }), error => error instanceof ArtifactRegistryError && error.code === 'secret_artifact_prohibited');
  const registered = register(registry, root, job.jobId);
  assert.throws(() => registry.verify(registered.artifact.artifactId, [{ type: 'made-up' }]), error => error.code === 'invalid_check');
});
