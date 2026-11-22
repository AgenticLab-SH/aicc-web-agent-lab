import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { identityObserverScript, readUiIdentityExpression, classifyUiIdentity } from '../cdp-bootstrap-ui.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const ui = { login_visible: false, composer_visible: true, profile_visible: false, challenge_visible: false, ready: true };

test('composer alone and warning-only session are not identity or logout proof', () => {
  const result = classifyUiIdentity({ ui, observed: [], accounts: [], me: null });
  assert.equal(result.status, 'unknown');
  assert.equal(result.login_required, null);
  assert.equal(result.user_id_sha256, null);
});

test('actual login UI is distinguished from a challenge or anonymous composer', () => {
  const base = { observed: [], accounts: [], me: null, ui: { ...ui, composer_visible: false, login_visible: true } };
  assert.equal(classifyUiIdentity(base).status, 'signed_out');
  assert.equal(classifyUiIdentity({ ...base, ui: { ...base.ui, challenge_visible: true } }).status, 'unknown');
  assert.equal(classifyUiIdentity({ ...base, ui: { ...base.ui, composer_visible: true } }).status, 'unknown');
});

test('successful observed me is required; memberships do not pick a workspace', () => {
  const base = { ui, observed: [{ source: 'me', status: 200 }], me: { user_id_sha256: hash('fixture-user'), email_sha256: hash('test@example.invalid') },
    accounts: [{ account_id_sha256: hash('fixture-account'), workspace_id_sha256: null, account_type: 'business' }] };
  assert.equal(classifyUiIdentity(base).status, 'signed_in');
  assert.equal(classifyUiIdentity(base).account_id_sha256, null);
  assert.equal(classifyUiIdentity({ ...base, active_account_id_sha256: hash('fixture-account') }).account_id_sha256, hash('fixture-account'));
  assert.equal(classifyUiIdentity({ ...base, observed: [{ source: 'me', status: 403 }] }).status, 'unknown');
  assert.equal(classifyUiIdentity({ ...base, me: { user_id_sha256: 'raw-user', email_sha256: 'test@example.invalid' } }).status, 'unknown');
});

test('passive observer hashes responses in browser and issues no extra requests', async () => {
  let requests = 0;
  const accountId = '00000000-0000-4000-8000-000000000001';
  const context = vm.createContext({ location: { origin: 'https://chatgpt.com' }, URL, Headers, TextEncoder, TextDecoder, crypto: webcrypto, setTimeout, clearTimeout,
    document: { readyState: 'complete', querySelectorAll: () => [], querySelector: () => null },
    fetch: async url => {
      requests++;
      const body = url.endsWith('/me') ? { id: 'fixture-user', email: 'Test@Example.invalid', accessToken: 'never-return' }
        : url.endsWith('/settings') ? {} : { accounts: { [accountId]: { account: { account_id: accountId, structure: 'business' } } } };
      return { url, ok: true, status: 200, headers: new Headers(), clone: () => new Response(JSON.stringify(body)) };
    },
  });
  vm.runInContext(identityObserverScript, context);
  await vm.runInContext(`fetch('https://chatgpt.com/backend-api/me')`, context);
  await vm.runInContext(`fetch('https://chatgpt.com/backend-api/accounts/optimized/check')`, context);
  await vm.runInContext(`fetch('https://chatgpt.com/backend-api/accounts/${accountId}/settings')`, context);
  const evidence = await vm.runInContext(readUiIdentityExpression, context);
  const result = classifyUiIdentity(evidence);
  assert.equal(requests, 3);
  assert.equal(result.status, 'signed_in');
  assert.equal(result.account_id_sha256, hash(accountId));
  assert.equal(result.email_sha256, hash('test@example.invalid'));
  assert.equal(result.email_local_part_sha256, hash('test'));
  assert.equal(result.account_type, 'business');
  for (const raw of ['never-return', 'fixture-user', 'Test@Example.invalid', accountId]) assert.ok(!JSON.stringify(evidence).includes(raw));
});

test('post responses and unrelated origins are not identity evidence', async () => {
  const context = vm.createContext({ location: { origin: 'https://chatgpt.com' }, URL, Headers, TextEncoder, crypto: webcrypto, setTimeout, clearTimeout,
    document: { readyState: 'complete', querySelectorAll: () => [], querySelector: () => null },
    fetch: async url => ({ url, ok: true, status: 200, headers: new Headers(), clone: () => { throw new Error('must not read'); } }),
  });
  vm.runInContext(identityObserverScript, context);
  await vm.runInContext(`fetch('https://chatgpt.com/backend-api/me', {method:'POST'})`, context);
  await vm.runInContext(`fetch('https://example.invalid/backend-api/me')`, context);
  const evidence = await vm.runInContext(readUiIdentityExpression, context);
  assert.equal(evidence.observed.length, 0);
  assert.equal(evidence.errors.length, 0);
});

test('oversized declared and streamed responses stay unknown without returning content', async () => {
  for (const declared of [true, false]) {
    let cloneReads = 0;
    const context = vm.createContext({ location: { origin: 'https://chatgpt.com' }, URL, Headers, TextEncoder, TextDecoder, crypto: webcrypto, setTimeout, clearTimeout,
      document: { readyState: 'complete', querySelectorAll: () => [], querySelector: () => null },
      fetch: async url => ({ url, ok: true, status: 200, headers: new Headers(declared ? { 'content-length': '1048577' } : {}),
        clone: () => { cloneReads++; return new Response(JSON.stringify({ id: 'never-return', padding: 'x'.repeat(1048577) })); } }),
    });
    vm.runInContext(identityObserverScript, context);
    await vm.runInContext(`fetch('https://chatgpt.com/backend-api/me')`, context);
    const evidence = await vm.runInContext(readUiIdentityExpression, context);
    assert.equal(classifyUiIdentity(evidence).status, 'unknown');
    assert.equal(cloneReads, declared ? 0 : 1);
    assert.ok(evidence.errors.includes('response_too_large'));
    assert.ok(!JSON.stringify(evidence).includes('never-return'));
  }
});
