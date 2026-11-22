import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableAttemptJournal, processStartTokenHash } from '../src/recovery/attempt-journal.mjs';
import { RequestTraceRecorder, classifyPreFirstActionStall, classifyRouteFailure, evaluateIntegratedRouteReadiness } from '../src/recovery/request-trace.mjs';

function traceFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-request-trace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = new DurableAttemptJournal({
    root,
    operationId: 'request-operation',
    attemptId: 'attempt-001',
    writerIdentity: { pid: 7, processStartTokenHash: processStartTokenHash({ pid: 7, startedAt: '2026-08-24T00:00:00.000Z' }) }
  });
  return new RequestTraceRecorder({ journal, requestId: 'request-private-id', taskId: 'task-private-id', routeGeneration: 'route-generation-1', modelHash: 'a'.repeat(64) });
}

test('request phases retain hashed identity and no private identifiers', t => {
  const trace = traceFixture(t);
  trace.record('accepted');
  trace.record('app_server_started', { writerProcessIdentityHash: 'b'.repeat(64) });
  trace.record('route_selected', { branch: 'native', endpointIdentityHash: 'c'.repeat(64) });
  trace.record('upstream_started');
  trace.record('first_progress');
  trace.record('response_received', { httpStatus: 200 });
  trace.finish('completed');
  const serialized = JSON.stringify(trace.journal.inspect());
  assert.equal(serialized.includes('request-private-id'), false);
  assert.equal(serialized.includes('task-private-id'), false);
  assert.equal(trace.terminal, 'completed');
});

test('pre-first-action stall is typed without kill or resend', () => {
  const stalled = classifyPreFirstActionStall({ taskStartedAtMs: 0, observedAtMs: 61_000, thresholdMs: 60_000, requestIdentityKnown: true, processIdentityKnown: true });
  assert.deepEqual(stalled, { stalled: true, state: 'stalled_unknown', elapsedMs: 61_000, resendAllowed: false, killAllowed: false, nativeHandoffAllowed: true, reconcileRequired: true });
  const waiting = classifyPreFirstActionStall({ taskStartedAtMs: 0, observedAtMs: 30_000, thresholdMs: 60_000 });
  assert.equal(waiting.state, 'waiting_for_first_progress');
  const progressed = classifyPreFirstActionStall({ taskStartedAtMs: 0, firstProgressAtMs: 1_000, observedAtMs: 90_000 });
  assert.equal(progressed.state, 'progress_observed');
});

test('integrated route promotion readiness fails closed on UNKNOWN and branch dependencies', () => {
  const base = {
    listener: { ready: true }, serviceIdentityCurrent: true, runtimeBundleCurrent: true, acceptingTurns: true,
    acceptingBrowserTurns: true, activeHttpTurns: 0, activeBrowserHttpTurns: 0, activeBrowserTurns: 0,
    broker: { ready: true }, browser: { ready: true }, nativeUpstream: { ready: true },
    canary: { status: 'pass', bounded: true, generationCurrent: true }
  };
  assert.equal(evaluateIntegratedRouteReadiness({ ...base, branch: 'web' }).ready, true);
  assert.equal(evaluateIntegratedRouteReadiness({ ...base, branch: 'native' }).ready, true);
  const unknown = evaluateIntegratedRouteReadiness({ ...base, branch: 'web', activeHttpTurns: null });
  assert.equal(unknown.ready, false);
  assert.ok(unknown.reasons.includes('activeHttpTurns_unknown'));
  const browserHold = evaluateIntegratedRouteReadiness({ ...base, branch: 'web', browser: { ready: false } });
  assert.ok(browserHold.reasons.includes('browser_not_ready'));
});

test('502 and 503 remain branch-correlated typed failures without retry', () => {
  assert.deepEqual(classifyRouteFailure({ httpStatus: 502, branch: 'native', upstreamStarted: true }), { type: 'native_upstream_bad_gateway', retryAllowed: false, reconcileRequired: true });
  assert.deepEqual(classifyRouteFailure({ httpStatus: 503, branch: 'web', browserStarted: true }), { type: 'browser_or_provider_unavailable', retryAllowed: false, reconcileRequired: true });
  assert.equal(classifyRouteFailure({ httpStatus: 502 }).type, 'route_bad_gateway_unknown');
});
