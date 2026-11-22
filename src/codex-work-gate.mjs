import { inspectCodexWork } from './codex-desktop-restart.mjs';
import { planAiccRepairSequence } from './repair-sequence.mjs';

function unknownResult(reason, generatedAt, outcomes) {
  const gate = { readOk: false, exactIdle: false, activeCount: null, unknownCount: null };
  return {
    ok: false,
    schemaVersion: 1,
    generatedAt,
    state: 'unknown',
    reason,
    ...gate,
    completeCount: null,
    allowedScope: 'source-test-documentation-only',
    sequence: planAiccRepairSequence({ gate, outcomes })
  };
}

export function codexWorkGateStatus(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const outcomes = options.outcomes ?? {};
  const generatedAt = now();
  let work;
  try { work = (options.inspectCodexWork ?? inspectCodexWork)(options.inspectOptions ?? {}); }
  catch { return unknownResult('inspection_failed', generatedAt, outcomes); }

  if (!Array.isArray(work?.active) || !Array.isArray(work?.unknown) || !Array.isArray(work?.complete)) {
    return unknownResult('inspection_shape_invalid', generatedAt, outcomes);
  }
  const activeCount = work.active.length;
  const unknownCount = work.unknown.length;
  const completeCount = work.complete.length;
  const expectedSafe = activeCount === 0 && unknownCount === 0;
  if (work.safe !== expectedSafe) return unknownResult('inspection_inconsistent', generatedAt, outcomes);

  const exactIdle = expectedSafe;
  const state = unknownCount > 0 ? 'unknown' : activeCount > 0 ? 'active' : 'ready';
  const allowedScope = exactIdle ? 'component-scoped-one-shot-after-preflight' : 'source-test-documentation-only';
  const gate = { readOk: true, exactIdle, activeCount, unknownCount };
  return {
    ok: true,
    schemaVersion: 1,
    generatedAt,
    state,
    reason: exactIdle ? 'exact_idle' : unknownCount > 0 ? 'lifecycle_unknown' : 'active_nonzero',
    ...gate,
    completeCount,
    allowedScope,
    sequence: planAiccRepairSequence({ gate, outcomes })
  };
}
