// Isolated candidate gate: fake clocks/quota/readers, no login or inference.
// Kept separate from live threshold acceptance; writing this does not run it.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.AICC_OCX_PACKAGE_ROOT;
if (!root || process.env.AICC_OCX_WINDOW_THRESHOLDS !== '95,98') throw Error('Exact candidate required');
let inferenceAttempts = 0;
globalThis.fetch = async () => { inferenceAttempts++; throw Error('Network forbidden in in-flight fixture'); };
const load = relative => import(pathToFileURL(path.join(root, relative)).href);
const { createAiccInflightMonitor } = await load('src/codex/routing/aicc-inflight-monitor.ts');
const { finalizeAiccInflightResponse, aiccInflightCutoffResponse } = await load('src/server/responses/aicc-inflight-response.ts');
const { AiccInflightQuotaCutoff } = await load('src/codex/routing/aicc-inflight-runtime.ts');
const { isNonReplayableResponse, isReplayRefusalResponse, isNonReplayableUpstreamCode } = await load('src/lib/upstream-retry.ts');
const checks = [];
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function fixture() {
  let clock = 1_000, live = true, calls = 0;
  let quota = { shortPercent: 96, weeklyPercent: 20 };
  let settings = { fiveHour: { usedThreshold: 97, action: 'switch' }, longWindow: { usedThreshold: 97, action: 'switch' } };
  let refresh = async () => ({ quota, generation: 1, verified: true });
  const timers = new Set(), observations = [];
  const monitor = createAiccInflightMonitor({ enabled: () => true, now: () => clock,
    settings: () => settings, snapshot: () => quota, generationLive: () => live,
    refresh: async () => { calls++; return refresh(); }, noteObservation: (...args) => observations.push(args),
    schedule: fn => { timers.add(fn); return () => timers.delete(fn); } });
  return { monitor, timers, observations, calls: () => calls,
    quota: value => { quota = value; }, settings: value => { settings = value; },
    refresh: value => { refresh = value; }, live: value => { live = value; }, now: () => clock,
    tick: ms => { clock += ms; for (const fn of [...timers]) fn(); } };
}
{
  const f = fixture(), cuts = [];
  const a = f.monitor.subscribe('pool', 1, reason => cuts.push(['a', reason]));
  const b = f.monitor.subscribe('pool', 1, reason => cuts.push(['b', reason]));
  await flush(); assert.equal(f.calls(), 1); assert.equal(f.timers.size, 1);
  f.tick(5_000); await flush(); assert.equal(f.calls(), 2);
  assert.deepEqual(cuts, []); checks.push('concurrent-requests-share-one-monitor-and-flight');
  f.quota({ shortPercent: 97, weeklyPercent: 20 }); f.tick(1_000);
  assert.deepEqual(cuts, [['a', 'five_hour_threshold'], ['b', 'five_hour_threshold']]);
  assert.equal(f.monitor.activeAccounts(), 0); assert.equal(f.timers.size, 0);
  a(); b(); checks.push('five-hour-97-cancels-every-serving-request-and-timer');
}
for (const action of ['switch', 'stop']) {
  const f = fixture(), cuts = [];
  f.settings({ fiveHour: { usedThreshold: 97, action }, longWindow: { usedThreshold: 97, action } });
  f.monitor.subscribe('pool', 1, reason => cuts.push(reason)); await flush();
  f.quota({ shortPercent: 5, weeklyPercent: 97 }); f.tick(1_000);
  assert.deepEqual(cuts, ['long_window_threshold']); checks.push(`weekly-97-${action}-cancels-running-request`);
}
{
  const f = fixture(), cuts = [];
  f.monitor.subscribe('pool', 1, reason => cuts.push(reason)); await flush();
  f.monitor.observe('pool', 2, { shortPercent: 100 }, f.now()); assert.deepEqual(cuts, []);
  f.monitor.observe('pool', 1, { shortPercent: 97 }, f.now());
  assert.deepEqual(cuts, ['five_hour_threshold']); checks.push('partial-wire-threshold-is-immediate-and-generation-fenced');
}
{
  const f = fixture(), cuts = [];
  f.refresh(async () => ({ quota: { shortPercent: 1, weeklyPercent: 1 }, verified: false }));
  f.monitor.subscribe('pool', 1, reason => cuts.push(reason)); await flush();
  f.tick(14_999); await flush(); assert.deepEqual(cuts, []);
  f.tick(1); assert.deepEqual(cuts, ['quota_unverified']);
  assert.ok(f.observations.some(([, allowed]) => allowed === false)); checks.push('cached-reply-never-renews-freshness');
}
{
  const f = fixture(), cuts = [];
  f.refresh(() => new Promise(() => {}));
  f.monitor.subscribe('pool', 1, reason => cuts.push(reason));
  f.tick(15_000); assert.deepEqual(cuts, ['quota_unverified']); assert.equal(f.timers.size, 0);
  checks.push('hung-quota-flight-does-not-block-cutoff');
}
{
  const f = fixture(), cuts = [];
  f.monitor.subscribe('pool', 1, reason => cuts.push(reason)); await flush();
  f.live(false); f.tick(1_000); assert.deepEqual(cuts, ['credential_changed']);
  assert.ok(!f.observations.some(([, allowed]) => allowed === false)); checks.push('replacement-credential-observation-is-not-invalidated');
}
{
  const f = fixture(), cuts = [];
  const stop = f.monitor.subscribe('pool', 1, reason => cuts.push(reason)); await flush();
  stop(); f.tick(60_000); assert.equal(f.timers.size, 0); assert.deepEqual(cuts, []);
  checks.push('completed-request-leaves-no-idle-polling');
}
{
  const f = fixture(), cuts = [];
  f.monitor.subscribe('pool', 1, reason => cuts.push(reason)); await flush();
  f.settings({ fiveHour: { usedThreshold: 90, action: 'switch' }, longWindow: { usedThreshold: 97, action: 'switch' } });
  f.tick(1_000); assert.deepEqual(cuts, ['five_hour_threshold']); checks.push('live-policy-edit-applies-to-running-request');
}
{
  const f = fixture(), cuts = [], disposers = [];
  f.refresh(() => new Promise(() => {}));
  for (let i = 0; i < 17; i++) disposers.push(f.monitor.subscribe(`pool-${i}`, 1, reason => cuts.push(reason)));
  assert.deepEqual(cuts, ['monitor_capacity']); assert.equal(f.monitor.activeAccounts(), 16);
  disposers.forEach(stop => stop()); assert.equal(f.timers.size, 0); checks.push('monitor-capacity-is-bounded-and-fails-closed');
}
{
  const error = new AiccInflightQuotaCutoff('five_hour_threshold');
  const response = aiccInflightCutoffResponse(error);
  assert.equal(response.status, 429); assert.equal(response.headers.get('x-should-retry'), 'false');
  assert.equal(response.headers.get('retry-after'), null);
  assert.ok(isNonReplayableResponse(response) && isReplayRefusalResponse(response));
  assert.ok(isNonReplayableUpstreamCode((await response.json()).error.code));
  checks.push('pre-header-cutoff-refuses-proxy-and-client-replay');
}
{
  const ac = new AbortController(); let cut, cancelled = false, released = 0;
  const source = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"delta":"partial"}\n\n')); },
    cancel() { cancelled = true; } });
  const guard = { signal: ac.signal, cutoff: () => cut, cancel: reason => ac.abort(reason), dispose() {}, bind() {} };
  const wrapped = finalizeAiccInflightResponse(new Response(source, { headers: { 'content-type': 'text/event-stream' } }), guard, () => released++);
  const reader = wrapped.body.getReader(); await reader.read();
  cut = new AiccInflightQuotaCutoff('long_window_threshold'); ac.abort(cut);
  const text = new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event: error/); assert.match(text, /aicc_window_inflight_cutoff/);
  assert.doesNotMatch(text, /response.completed|\[DONE\]/);
  assert.equal((await reader.read()).done, true); await flush();
  assert.equal(cancelled, true); assert.equal(released, 1); checks.push('partial-sse-is-cancelled-with-error-not-success');
}
{
  let released = 0;
  const ac = new AbortController();
  const guard = { signal: ac.signal, cutoff: () => undefined, cancel: reason => ac.abort(reason), dispose() {}, bind() {} };
  const response = finalizeAiccInflightResponse(new Response('normal'), guard, () => released++);
  assert.equal(await response.text(), 'normal'); assert.equal(released, 1); checks.push('normal-body-remains-complete-and-releases-once');
}
assert.equal(inferenceAttempts, 0);
console.log(JSON.stringify({ terminal: 'PASS_INFLIGHT_SIMULATION', checks, inferenceAttempts,
  actualProviderCancellationVerified: false, actualThresholdCrossingVerified: false }));
