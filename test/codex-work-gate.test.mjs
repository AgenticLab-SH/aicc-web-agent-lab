import assert from 'node:assert/strict';
import test from 'node:test';
import { codexWorkGateStatus } from '../src/codex-work-gate.mjs';

const now = () => '2026-08-24T00:00:00.000Z';

test('gate reports counts only and exact idle exposes one preflight stage', () => {
  const result = codexWorkGateStatus({ now, inspectCodexWork: () => ({ safe: true, active: [], unknown: [], complete: [{ file: '/private/session', pid: 7 }] }) });
  assert.equal(result.exactIdle, true);
  assert.equal(result.activeCount, 0);
  assert.equal(result.unknownCount, 0);
  assert.equal(result.completeCount, 1);
  assert.equal(result.sequence.stages.filter(stage => stage.state === 'current').length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private\/session|"pid"/);
});

test('active and lifecycle UNKNOWN preserve source-only scope', () => {
  const active = codexWorkGateStatus({ now, inspectCodexWork: () => ({ safe: false, active: [{}], unknown: [], complete: [] }) });
  assert.equal(active.state, 'active');
  assert.equal(active.allowedScope, 'source-test-documentation-only');
  assert.equal(active.sequence.nextStageId, null);

  const unknown = codexWorkGateStatus({ now, inspectCodexWork: () => ({ safe: false, active: [], unknown: [{ reason: 'lifecycle_unknown', file: '/private/session' }], complete: [] }) });
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.unknownCount, 1);
  assert.doesNotMatch(JSON.stringify(unknown), /private\/session/);
});

test('inspection failure, malformed shape and inconsistent safe flag fail closed', () => {
  for (const inspectCodexWork of [
    () => { throw new Error('private failure'); },
    () => ({ safe: false }),
    () => ({ safe: true, active: [{}], unknown: [], complete: [] })
  ]) {
    const result = codexWorkGateStatus({ now, inspectCodexWork });
    assert.equal(result.state, 'unknown');
    assert.equal(result.readOk, false);
    assert.equal(result.exactIdle, false);
    assert.equal(result.sequence.nextStageId, null);
    assert.doesNotMatch(JSON.stringify(result), /private failure/);
  }
});
