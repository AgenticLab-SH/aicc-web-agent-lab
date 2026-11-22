import assert from 'node:assert/strict';
import test from 'node:test';
import { computeProjectProgress, PROJECT_PROGRESS_WEIGHTS, ProjectProgressError } from '../src/projects/project-progress.mjs';

test('weighted progress credits only current PASS evidence and excludes N/A from the denominator', () => {
  const progress = computeProjectProgress({
    gates: {
      discovery: { status: 'PASS', current: true, evidenceRefs: ['evidence://current-discovery'] },
      design: { status: 'N/A' },
      implementation: { status: 'PARTIAL', current: true, evidenceRefs: ['evidence://partial'] },
      automatedVerification: { status: 'PASS', current: false, evidenceRefs: ['evidence://historical'] },
      userAcceptance: { status: 'FAIL', current: true, evidenceRefs: ['evidence://failure'] },
      releaseOperation: { status: 'UNKNOWN' }
    }
  });
  assert.deepEqual(PROJECT_PROGRESS_WEIGHTS, {
    discovery: 10,
    design: 15,
    implementation: 35,
    automatedVerification: 20,
    userAcceptance: 10,
    releaseOperation: 10
  });
  assert.equal(progress.computed.denominator, 85);
  assert.equal(progress.computed.numerator, 10);
  assert.equal(progress.percent, 12);
  assert.equal(progress.confidence, 'partial');
  assert.deepEqual(progress.evidenceRefs, ['evidence://current-discovery']);
  assert.equal(progress.computed.gates.automatedVerification.excludedReason, 'current-evidence-required');
});

test('weighted progress reaches verified only when every applicable gate has current evidence', () => {
  const gates = Object.fromEntries(Object.keys(PROJECT_PROGRESS_WEIGHTS).map(name => [name, {
    status: 'PASS', current: true, evidenceRefs: [`evidence://${name}`]
  }]));
  const progress = computeProjectProgress({ gates });
  assert.equal(progress.percent, 100);
  assert.equal(progress.confidence, 'verified');
  assert.equal(progress.method, 'weighted-gates');
  assert.equal(progress.evidenceRefs.length, 6);
});

test('manual override preserves computed and original values plus reason, actor, and time', () => {
  const progress = computeProjectProgress({
    gates: { discovery: { status: 'PASS', current: true, evidenceRefs: ['evidence://one'] } },
    manualOverride: {
      percent: 47,
      reason: 'Owner reviewed the externally tracked milestone.',
      actor: 'owner',
      at: '2026-04-04T10:30:00+09:00'
    }
  });
  assert.equal(progress.method, 'manual-override');
  assert.equal(progress.percent, 47);
  assert.equal(progress.computed.percent, 10);
  assert.equal(progress.override.originalPercent, 10);
  assert.equal(progress.override.reason, 'Owner reviewed the externally tracked milestone.');
  assert.equal(progress.override.actor, 'owner');
  assert.equal(progress.override.at, '2026-04-04T01:30:00.000Z');
  assert.equal(progress.confidence, 'partial');
});

test('a claimed PASS without current evidence is worth zero and invalid overrides fail closed', () => {
  const claimed = computeProjectProgress({ gates: { discovery: 'PASS' } });
  assert.equal(claimed.computed.numerator, 0);
  assert.equal(claimed.percent, 0);
  assert.throws(
    () => computeProjectProgress({ manualOverride: { percent: 101, reason: 'invalid', actor: 'owner', at: '2026-01-01T00:00:00Z' } }),
    error => error instanceof ProjectProgressError && error.code === 'invalid_manual_override'
  );
});
