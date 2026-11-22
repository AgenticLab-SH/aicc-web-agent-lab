import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCompatibilityMatrix, diffSchemas, evaluateRegression, loadReleaseMatrix, validateCanaryEnvironment, verifyStartOnce } from '../src/compatibility/lab.mjs';
import { compatibilityStatus } from '../src/compatibility/status.mjs';
import { UpdateCoordinator } from '../src/compatibility/update-coordinator.mjs';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-compatibility-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function canary(root) {
  return {
    root,
    stateRoot: path.join(root, 'state'),
    databaseRoot: path.join(root, 'db'),
    profileRoot: path.join(root, 'profile'),
    artifactRoot: path.join(root, 'artifacts'),
    ports: { aicc: 19381, webGpt: 19841, ocx: 19100 }
  };
}

function passRegression(matrix, compatibility) {
  return {
    checks: matrix.requiredRegression.map(id => ({ id, status: 'pass' })),
    directRescue: matrix.requiredDirectRescue.map(id => ({ id, status: 'pass' })),
    compatibility
  };
}

function planInput(matrix, overrides = {}) {
  return {
    operationId: 'update-web-gpt-canary',
    targetComponent: 'web-gpt-private-adapter',
    currentVersion: '2.0.0-aicc.4',
    targetVersion: '2.0.0-aicc.4',
    preconditionHash: 'a'.repeat(64),
    desiredHash: 'b'.repeat(64),
    rollbackRef: 'owner-backup:web-gpt-current',
    backupRef: 'owner-backup:web-gpt-phase10',
    activeWorkProof: { count: 0, observedAt: '2026-08-10T00:00:00Z', source: 'canary' },
    compatibility: { ok: true },
    compatibilityHash: buildCompatibilityMatrix(matrix).hash,
    directRescue: matrix.requiredDirectRescue.map(id => ({ id, status: 'pass' })),
    ...overrides
  };
}

test('canary roots and ports are isolated from active state and production listeners', t => {
  const root = temporary(t);
  const active = path.join(root, 'active');
  const isolated = path.join(root, 'isolated');
  assert.equal(validateCanaryEnvironment(canary(isolated), { activeRoots: [active] }).ok, true);
  assert.throws(() => validateCanaryEnvironment(canary(path.join(active, 'child')), { activeRoots: [active] }), error => error.code === 'shared_canary_state');
  assert.throws(() => validateCanaryEnvironment({ ...canary(isolated), ports: { webGpt: 17841 } }), error => error.code === 'shared_canary_port');
});

test('release matrix and reproducible schema diff block removed compatibility fields', () => {
  const release = loadReleaseMatrix();
  const matrix = buildCompatibilityMatrix(release, { observedAt: '2026-08-10T00:00:00Z', evidenceRef: 'phase10' });
  assert.equal(matrix.components.length, 5);
  assert.equal(matrix.components.every(item => item.compatibility === 'compatible'), true);
  const incompatible = diffSchemas({ stable: true, required: 1 }, { stable: true });
  assert.deepEqual(incompatible.removed, ['/required']);
});

test('full regression and every direct rescue are required before active release change', () => {
  const release = loadReleaseMatrix();
  const compatibility = buildCompatibilityMatrix(release);
  assert.equal(evaluateRegression(release, passRegression(release, compatibility)).ok, true);
  const failed = passRegression(release, compatibility);
  failed.directRescue[0].status = 'fail';
  assert.deepEqual(evaluateRegression(release, failed).rescueFailures, ['web-gpt-direct']);
});

test('update plan is immutable and exact nonzero or unknown active work holds before lease', t => {
  const root = temporary(t);
  const release = loadReleaseMatrix();
  const coordinator = new UpdateCoordinator({ stateRoot: root, now: () => 1 });
  const held = coordinator.createPlan(planInput(release, { operationId: 'held', activeWorkProof: { count: null, observedAt: 'x', source: 'unknown' } }));
  assert.equal(held.state, 'hold');
  assert.throws(() => coordinator.lease('held', 'a'.repeat(64)), error => error.code === 'plan_not_ready');
  const planned = coordinator.createPlan(planInput(release));
  assert.equal(planned.state, 'planned');
  assert.equal(coordinator.createPlan(planInput(release)).duplicate, true);
  assert.throws(() => coordinator.createPlan(planInput(release, { targetVersion: 'different' })), error => error.code === 'immutable_plan_conflict');
});

test('rollout order is shadow then canary then default with verified direct rescues', t => {
  const root = temporary(t);
  const release = loadReleaseMatrix();
  const coordinator = new UpdateCoordinator({ stateRoot: root, now: () => 2 });
  coordinator.createPlan(planInput(release));
  coordinator.lease('update-web-gpt-canary', 'a'.repeat(64));
  assert.throws(() => coordinator.recordStage('update-web-gpt-canary', 'canary', { status: 'pass', ref: 'early' }), error => error.code === 'invalid_rollout_sequence');
  coordinator.recordStage('update-web-gpt-canary', 'shadow', { status: 'pass', ref: 'shadow' });
  coordinator.recordStage('update-web-gpt-canary', 'canary', { status: 'pass', ref: 'canary' });
  assert.equal(coordinator.recordStage('update-web-gpt-canary', 'default', { status: 'pass', ref: 'default' }).state, 'committed');
});

test('rollback must restore the exact component precondition hash', t => {
  const root = temporary(t);
  const release = loadReleaseMatrix();
  const coordinator = new UpdateCoordinator({ stateRoot: root });
  coordinator.createPlan(planInput(release));
  coordinator.lease('update-web-gpt-canary', 'a'.repeat(64));
  assert.throws(() => coordinator.rollback('update-web-gpt-canary', { restoredHash: 'c'.repeat(64), ref: 'bad' }), error => error.code === 'rollback_unverified');
  assert.equal(coordinator.rollback('update-web-gpt-canary', { restoredHash: 'a'.repeat(64), ref: 'restored' }).state, 'rolled-back');
});

test('two failed automatic restarts quarantine only the target component', t => {
  const root = temporary(t);
  const coordinator = new UpdateCoordinator({ stateRoot: root, now: () => 3 });
  const first = coordinator.recordRestartFailure('adapter-a', { fingerprint: 'failure-a', evidenceRef: 'attempt-1' });
  const second = coordinator.recordRestartFailure('adapter-a', { fingerprint: 'failure-a', evidenceRef: 'attempt-2' });
  assert.equal(first.restartAllowed, true);
  assert.equal(second.restartAllowed, false);
  assert.equal(second.state, 'quarantined');
  assert.equal(coordinator.recordRestartFailure('adapter-a', { fingerprint: 'failure-a', evidenceRef: 'attempt-3' }).attempts, 2);
  assert.deepEqual(coordinator.status().quarantinedComponents, ['adapter-a']);
  assert.equal(coordinator.recordRestartFailure('adapter-b', { fingerprint: 'failure-b', evidenceRef: 'independent' }).restartAllowed, true);
});

test('start-once proof rejects duplicate owners listeners jobs loops and GUI KeepAlive', () => {
  const pass = verifyStartOnce({ services: [
    { label: 'canary-a', pid: 101, listener: '127.0.0.1:19381', active: true, restartCount: 0, kind: 'daemon', keepAlive: false },
    { label: 'canary-b', pid: 102, listener: '127.0.0.1:19841', active: true, restartCount: 2, kind: 'gui', keepAlive: false }
  ], duplicateJobs: 0 });
  assert.equal(pass.ok, true);
  const fail = verifyStartOnce({ services: [
    { label: 'duplicate', pid: 1, listener: 'same', active: true, restartCount: 0, kind: 'daemon' },
    { label: 'duplicate', pid: 2, listener: 'same', active: true, restartCount: 3, kind: 'gui', keepAlive: true }
  ], duplicateJobs: 1 });
  assert.equal(fail.ok, false);
});

test('compatibility status isolates state and never auto-applies versions', t => {
  const root = temporary(t);
  const result = compatibilityStatus({ stateRoot: root, observedAt: '2026-08-10T00:00:00Z' });
  assert.equal(result.state, 'ready');
  assert.equal(result.componentCount, 5);
  assert.equal(result.automaticVersionApply, false);
  assert.deepEqual(result.rolloutSequence, ['shadow', 'canary', 'default']);
});
