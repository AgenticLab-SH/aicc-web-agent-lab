import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { registeredSlots, identityExpression, inspectSlot, sanitizeIdentity, verificationResult, inspectIndependently } from '../cdp-identity-bootstrap.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const empty = { status: 'signed_out', login_required: true, reason: 'empty_session', user_id_sha256: null, email_sha256: null, account_id_sha256: null, workspace_id_sha256: null };
const profile = process.platform === 'win32' ? 'C:/fixture/profile' : '/fixture/profile';
const slot = { port: 9222, endpoint: 'http://127.0.0.1:9222', profile };

test('pending is eligible only for exact registered bootstrap inventory', () => {
  const text = `[browser]\ncdp_slot1_port = 9222\ncdp_slot1_profile_dir = "${profile}"\ncdp_slot1_usage = "manual_login_pending"`;
  assert.deepEqual(registeredSlots(text, [9222]), [{ ...slot, alias: null, reserved: false }]);
  assert.throws(() => registeredSlots(text, [9223]));
  assert.throws(() => registeredSlots(text + '\ncdp_slot1_port = 9222', [9222]));
  assert.throws(() => registeredSlots(text.replace('manual_login_pending', 'disabled'), [9222]));
});

test('session raw identity and token never leave the browser expression', async () => {
  const result = await vm.runInNewContext(identityExpression, {
    location: { origin: 'https://chatgpt.com' }, crypto: webcrypto, TextEncoder, AbortSignal,
    fetch: async (url, options) => {
      assert.equal(url, '/api/auth/session'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      return { ok: true, status: 200, json: async () => ({ user: { id: 'fixture-user', email: ' Test@Example.invalid ' }, account: { id: 'fixture-account' }, workspace: { id: 'fixture-workspace' }, accessToken: 'never-return-this' }) };
    },
  });
  assert.deepEqual(sanitizeIdentity(result), { status: 'signed_in', login_required: false, reason: 'session_identity', user_id_sha256: digest('fixture-user'), email_sha256: digest('test@example.invalid'), account_id_sha256: digest('fixture-account'), workspace_id_sha256: digest('fixture-workspace') });
  assert.ok(!JSON.stringify(result).includes('never-return-this'));
});

test('signed out is not confused with forbidden or malformed sessions', async () => {
  const bannerOnly = await vm.runInNewContext(identityExpression, { location: { origin: 'https://chatgpt.com' }, AbortSignal,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ WARNING_BANNER: 'fixture notice' }) }) });
  assert.equal(sanitizeIdentity(bannerOnly).status, 'unknown');
  assert.equal(sanitizeIdentity(bannerOnly).login_required, null);
  assert.equal(sanitizeIdentity(bannerOnly).reason, 'session_response_restricted');
  for (const [status, payload, expected] of [[200, {}, 'signed_out'], [200, { expires: 'fixture', user: null }, 'signed_out'], [401, {}, 'signed_out'], [403, {}, 'unknown'], [200, { error: 'blocked' }, 'unknown'], [200, [], 'unknown']]) {
    const result = await vm.runInNewContext(identityExpression, { location: { origin: 'https://chatgpt.com' }, AbortSignal,
      fetch: async () => ({ ok: status === 200, status, json: async () => payload }) });
    assert.equal(result.status, expected);
  }
  assert.throws(() => sanitizeIdentity({ ...empty, email_sha256: 'plain@example.invalid' }));
});

function fakeConnection(failMethod) {
  const calls = [];
  return { calls, connect: async () => {}, close: () => calls.push(['close']), send: async (method, params, sessionId) => {
    calls.push([method, params, sessionId]);
    if (method === failMethod) throw new Error('fixture error');
    return { 'Target.createTarget': { targetId: 'owned' }, 'Target.attachToTarget': { sessionId: 'session' },
      'Page.getFrameTree': { frameTree: { frame: { id: 'frame', url: 'https://chatgpt.com/' } } },
      'Page.createIsolatedWorld': { executionContextId: 42 }, 'Runtime.evaluate': { result: { value: empty } }, 'Target.closeTarget': { success: true } }[method] ?? {};
  } };
}

test('guarded new target only; cleanup on success and failure', async () => {
  for (const failure of [undefined, 'Runtime.evaluate', 'Target.attachToTarget']) {
    const connection = fakeConnection(failure);
    let guards = 0;
    const operation = inspectSlot(slot, { connection, wait: async () => {}, guard: async () => { guards++; }, getVersion: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/fixture' }) });
    if (failure) await assert.rejects(operation); else assert.deepEqual(await operation, { ...empty, status: 'unknown', login_required: null });
    assert.ok(guards >= 2);
    assert.equal(connection.calls.filter(([method]) => method === 'Target.createTarget').length, 1);
    assert.deepEqual(connection.calls.find(([method]) => method === 'Target.closeTarget')[1], { targetId: 'owned' });
    assert.deepEqual(connection.calls[0][1], { url: 'about:blank', background: true, hidden: true });
    assert.equal(connection.calls.at(-1)[0], 'close');
  }
});

test('failed guard and foreign websocket cannot create a target', async () => {
  for (const guardFails of [true, false]) {
    const connection = fakeConnection();
    await assert.rejects(inspectSlot(slot, { connection, guard: async () => { if (guardFails) throw new Error('guard'); },
      getVersion: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/fixture' }) }));
    assert.equal(connection.calls.length, 1);
  }
});

test('missing account and workspace stay unknown; no fallback to user id', async () => {
  const result = await vm.runInNewContext(identityExpression, { location: { origin: 'https://chatgpt.com' }, crypto: webcrypto, TextEncoder, AbortSignal,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ user: { id: 'fixture-user', email: 'test@example.invalid' } }) }) });
  assert.equal(sanitizeIdentity(result).status, 'signed_in');
  assert.equal(result.account_id_sha256, null);
  assert.equal(result.workspace_id_sha256, null);
});

test('cross-origin evaluation does not fetch session data', async () => {
  const result = await vm.runInNewContext(identityExpression, { location: { origin: 'https://example.invalid' },
    fetch: () => { throw new Error('must not fetch'); } });
  assert.equal(result.reason, 'origin_unavailable');
  assert.equal(result.login_required, null);
});

test('cleanup failure is not reported as successful inventory', async () => {
  const connection = fakeConnection('Target.closeTarget');
  await assert.rejects(inspectSlot(slot, { connection, wait: async () => {}, guard: async () => {},
    getVersion: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/fixture' }) }));
  assert.equal(connection.calls.at(-1)[0], 'close');
});

test('independent results preserve success before and after failure; reserved is optional', async () => {
  const authenticated = { status: 'signed_in', user_id_sha256: digest('user'), email_sha256: digest('fixture@example.invalid'),
    email_local_part_sha256: digest('fixture'), account_id_sha256: digest('selected'), workspace_id_sha256: null };
  for (const reservedStatus of ['signed_out', 'unknown']) {
    const results = [];
    const slots = [9222, 9223, 9224, 9225].map(port => ({ port, alias: 'fixture', reserved: port === 9225 }));
    const summary = await inspectIndependently(slots, async selected => selected.reserved ? { status: reservedStatus } : authenticated, result => { results.push(result); });
    assert.equal(summary.failed, false);
    assert.equal(results.length, 4);
    assert.ok(results.slice(0, 3).every(result => result.binding_verified && result.verification_scope === 'account_only' && result.workspace_id_sha256 === null));
    assert.ok(results.every(result => result.mutation_authorized === false));
    assert.equal(results[3].binding_verified, false);
    assert.equal(results[3].login_action_required, false);
    const partial = [];
    const failed = await inspectIndependently(slots, async selected => {
      if (selected.port === 9223) throw new Error('cdp_command_timeout');
      return authenticated;
    }, result => { partial.push(result); });
    assert.equal(failed.failed, true);
    assert.equal(partial[0].binding_verified, true);
    assert.equal(partial[1].error, 'cdp_command_timeout');
    assert.equal(partial[2].binding_verified, true);
  }
});

test('alias binding requires actual email local-part hash; account is not workspace', () => {
  const identity = { status: 'signed_in', user_id_sha256: digest('user'), email_sha256: digest('fixture@example.invalid'),
    email_local_part_sha256: digest('fixture'), account_id_sha256: digest('selected'), workspace_id_sha256: null };
  assert.equal(verificationResult({ ...slot, alias: 'other' }, identity).binding_verified, false);
  assert.equal(verificationResult({ ...slot, alias: 'fixture' }, { ...identity, email_local_part_sha256: null }).intended_alias_localpart_match, null);
  const result = verificationResult({ ...slot, alias: ' FIXTURE ' }, identity);
  assert.equal(result.verification_scope, 'account_only');
  assert.equal(result.workspace_id_sha256, null);
  assert.equal(result.binding_verified, true);
});

test('unknown errors never disclose paths or raw identity in streamed results', async () => {
  const results = [];
  await inspectIndependently([slot], async () => { throw new Error('private-path/raw-account/secret-token'); }, result => { results.push(result); });
  assert.equal(results[0].error, 'inspection_failed');
  assert.ok(!JSON.stringify(results).includes('secret-token'));
});
