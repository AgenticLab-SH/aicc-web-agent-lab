import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/dashboard-workspace.js', import.meta.url), 'utf8');
const requestSource = source.slice(source.indexOf('async function request('), source.indexOf('\nfunction message('));
function fixture(fetch) {
  let fire, delay, clears = 0;
  const context = vm.createContext({ fetch, AbortController, errors: { pair_required: '연결이 필요합니다.' }, csrf: 'fixture',
    setTimeout(callback, ms) { fire = callback; delay = ms; return 1; }, clearTimeout() { clears++; } });
  vm.runInContext(requestSource, context);
  return { request: context.request, expire: () => fire(), get delay() { return delay; }, get clears() { return clears; } };
}

test('dashboard read timeout releases busy state and preserves the last snapshot before a fresh read', async () => {
  const calls = [];
  const f = fixture(async (url, options) => { calls.push({ url, options }); return calls.length === 1 ? new Promise(() => {}) : { ok: true, json: async () => ({ revision: 2 }) }; });
  const context = vm.createContext({ root: { setAttribute() {} }, busy: false, initialized: true, needsConnect: false, message: value => { context.notice = value; }, snapshot: { revision: 1 }, request: f.request });
  vm.runInContext(source.slice(source.indexOf('async function run('), source.indexOf('\nasync function load(')), context);
  const pending = vm.runInContext("run(async () => { snapshot = await request('dashboard'); })", context);
  assert.equal(context.busy, true); assert.equal(f.delay, 20000);
  f.expire(); await pending;
  assert.equal(context.busy, false); assert.equal(context.snapshot.revision, 1);
  assert.match(context.notice, /마지막 표시값/);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.signal.aborted, true);
  await vm.runInContext("run(async () => { snapshot = await request('dashboard'); })", context);
  assert.equal(context.snapshot.revision, 2); assert.equal(calls.length, 2); assert.equal(f.clears, 2);
});

test('dashboard read deadline includes a stalled response body', async () => {
  const f = fixture(async () => ({ ok: true, json: () => new Promise(() => {}) }));
  const pending = f.request('session'); await Promise.resolve(); f.expire();
  await assert.rejects(pending, error => error.code === 'read_timeout');
});

test('dashboard confirmations remain single dispatch without a read cancellation or replay', async () => {
  const calls = [];
  const f = fixture(async (url, options) => { calls.push({ url, options }); throw Error('uncertain transport'); });
  await assert.rejects(f.request('confirm', { confirmationToken: 'fixture-token' }), /uncertain transport/);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.signal, undefined); assert.equal(f.delay, undefined);
});

test('dashboard authentication failures keep the original code without retry', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { ok: false, json: async () => ({ code: 'pair_required' }) }; });
  await assert.rejects(f.request('session'), error => error.code === 'pair_required');
  assert.equal(calls, 1); assert.equal(f.clears, 1);
});

test('dashboard disconnected reads show a recovery action without replay', async () => {
  // Browser fetch errors belong to its window realm.
  const context = vm.createContext({ AbortController, errors: {}, csrf: null, setTimeout, clearTimeout });
  vm.runInContext('fetch = async () => { throw new TypeError("Failed to fetch"); };' + requestSource, context);
  await assert.rejects(context.request('dashboard'), error => error.code === 'read_network_error' && /다시|새로 조회/.test(error.message));
});
