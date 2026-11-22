import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { jobManagerStatus, listDurableJobs, readDurableEvidenceHistory } from '../src/jobs/status.mjs';

test('job status is read-only before initialization', t => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-job-status-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const result = jobManagerStatus({ stateRoot });
  assert.equal(result.state, 'ready');
  assert.equal(result.initialized, false);
  assert.equal(fs.existsSync(path.join(stateRoot, 'jobs')), false);
  assert.deepEqual(listDurableJobs({ stateRoot }), []);
});

test('job status isolates a corrupt store without throwing', t => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-job-status-corrupt-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const jobs = path.join(stateRoot, 'jobs');
  fs.mkdirSync(jobs, { mode: 0o700 });
  fs.writeFileSync(path.join(jobs, 'state.json'), '{broken', { mode: 0o600 });
  const result = jobManagerStatus({ stateRoot });
  assert.equal(result.state, 'attention');
  assert.equal(result.isolatedFailure, true);
  assert.equal(result.integrity.error, 'state_invalid');
});
test('completed/failed evidence history is owner-bound metadata, without prompts, paths or keys', t => {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-evidence-history-'));
  t.after(() => fs.rmSync(owner, { recursive: true, force: true }));
  fs.mkdirSync(path.join(owner, 'jobs'));
  const at = '2026-11-08T00:00:00.000Z';
  const jobId = 'private-job-client_key-secret';
  const state = { schemaVersion: 1,
    jobs: {
      [jobId]: { jobId, workspaceId: 'private-workspace', identityBinding: 'private-owner', state: 'completed',
        updatedAt: at, orchestrationRunId: 'private-run', artifactRefs: ['private-artifact'],
        attempts: [{ attemptId: 'private-attempt' }],
        results: [{ jobId, attemptId: 'private-attempt', validatorStatus: 'pass', claim: 'raw-prompt-secret' }] },
      'private-failed-job': { jobId: 'private-failed-job', workspaceId: 'private-workspace', identityBinding: 'private-owner',
        state: 'failed', updatedAt: '2026-11-07T00:00:00.000Z', artifactRefs: [], results: [],
        terminalReason: 'raw-token-secret' },
      'private-running-job': { jobId: 'private-running-job', state: 'running', updatedAt: at }
    },
    artifacts: {
      'private-artifact': { artifactId: 'private-artifact', jobId, privatePath: 'C:\\private\\client_key\\secret',
        output: { ref: 'private-absolute-path-secret', sha256: 'a'.repeat(64), mediaType: 'application/json' },
        verificationCurrent: true, verifiedAt: at,
        verification: [{ type: 'exact-bytes', status: 'pass', checkedAt: at, evidenceRef: 'private-nonce-secret' }] }
    },
    orchestrationRuns: { 'private-run': { runId: 'private-run', jobIds: [jobId], workspaceId: 'private-workspace',
      identityBinding: 'private-owner', cleanup: { at, cleanedBrowserLeaseIds: ['private-lease-client_key'],
        foreignTargetsTouched: 0 } } }
  };
  const before = JSON.stringify(state);
  const view = readDurableEvidenceHistory({ stateRoot: owner, store: { read: () => ({ state }) } });
  assert.equal(view.status, 'AVAILABLE');
  assert.equal(view.totalTerminal, 2); assert.equal(view.shown, 2);
  assert.equal(view.fileOpenSupported, false); assert.equal(view.currentFileReverified, false);
  const completed = view.jobs.find(job => job.state === 'COMPLETED');
  assert.equal(completed.validatorStatus, 'PASS');
  assert.equal(completed.artifactVerifications[0].verification, 'RECORDED_PASS');
  assert.equal(completed.artifactVerifications[0].checks[0].status, 'pass');
  assert.equal(completed.cleanup.status, 'RECORDED');
  assert.equal(completed.cleanup.cleanedLeaseCount, 1);
  assert.equal(view.jobs.find(job => job.state === 'FAILED').cleanup.status, 'NO_BOUND_RUN');
  const exposed = JSON.stringify(view);
  for (const secret of ['private-', 'client_key', 'raw-prompt', 'raw-token', 'nonce', 'C:\\', owner, 'absolute-path']) {
    assert.equal(exposed.includes(secret), false, 'exposure: ' + secret);
  }
  assert.equal(JSON.stringify(state), before);
});
test('evidence history returns UNKNOWN for broken source and never claims verifier or cleanup from mismatched run', t => {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-evidence-hold-'));
  t.after(() => fs.rmSync(owner, { recursive: true, force: true }));
  assert.equal(readDurableEvidenceHistory({ stateRoot: owner }).status, 'NOT_INITIALIZED');
  fs.mkdirSync(path.join(owner, 'jobs'));
  const jobId = 'failed-work';
  const state = { schemaVersion: 1, jobs: { [jobId]: { jobId, state: 'failed', updatedAt: '2026-11-08T01:00:00Z',
    orchestrationRunId: 'run', workspaceId: 'owner', identityBinding: 'binding',
    artifactRefs: [], results: [], attempts: [] } },
    artifacts: { artifact: { artifactId: 'artifact', jobId, verificationCurrent: true,
      output: { sha256: 'b'.repeat(64), mediaType: 'application/json' },
      verification: [{ type: 'code-test', status: 'fail', checkedAt: '2026-11-08T00:00:00Z' }],
      privatePath: '/private/secret', verifiedAt: '2026-11-08T00:00:00Z' } },
    orchestrationRuns: { run: { workspaceId: 'other-owner', identityBinding: 'other',
      jobIds: [jobId], cleanup: { at: '2026-11-08T00:00:00Z', cleanedBrowserLeaseIds: [], foreignTargetsTouched: 0 } } } };
  const store = { read: () => ({ state }) };
  const view = readDurableEvidenceHistory({ stateRoot: owner, store });
  assert.equal(view.jobs[0].cleanup.status, 'BINDING_UNKNOWN');
  assert.equal(view.jobs[0].artifactVerifications[0].verification, 'RECORDED_FAIL');
  assert.equal(readDurableEvidenceHistory({ stateRoot: owner, store: { read: () => { throw Error('/private/key'); } } }).status, 'UNKNOWN');
  assert.equal(readDurableEvidenceHistory({ stateRoot: owner, store: { read: () => ({ state: { ...state, schemaVersion: 2 } }) } }).status, 'UNKNOWN');
});
test('evidence history caps terminal records and distinguishes empty history from missing source', t => {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-evidence-limit-'));
  t.after(() => fs.rmSync(owner, { recursive: true, force: true }));
  fs.mkdirSync(path.join(owner, 'jobs'));
  const state = { schemaVersion: 1, artifacts: {}, orchestrationRuns: {}, jobs: {} };
  assert.equal(readDurableEvidenceHistory({ stateRoot: owner, store: { read: () => ({ state }) } }).status, 'EMPTY');
  for (let i = 0; i < 25; i++) state.jobs['j' + i] = {
    jobId: 'j' + i, state: 'failed', updatedAt: new Date(Date.UTC(2026, 10, 8, 1, i)).toISOString(),
    artifactRefs: [], results: [] };
  const view = readDurableEvidenceHistory({ stateRoot: owner, store: { read: () => ({ state }) } });
  assert.equal(view.shown, 24); assert.equal(view.totalTerminal, 25); assert.equal(view.truncated, true);
  assert.equal(view.jobs[0].state, 'FAILED');
});

