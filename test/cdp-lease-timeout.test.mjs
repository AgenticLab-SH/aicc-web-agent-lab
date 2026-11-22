import assert from 'node:assert/strict';
import test from 'node:test';
import { CdpLeaseProvider } from '../src/browser/cdp-lease-provider.mjs';

const timeout = () => ({ error: Object.assign(new Error('fixture timed out'), { code: 'ETIMEDOUT' }), status: null, stdout: '', stderr: '' });
const success = { status: 0, stdout: '{"ok":true}', stderr: '' };

function fixture(outcomes) {
  const calls = [];
  const runner = (executable, args, options) => {
    calls.push({ executable, args, options });
    return outcomes.shift() ?? timeout();
  };
  const provider = new CdpLeaseProvider({ runner, executable: 'pwsh', script: 'C:/fixture/Manage-CdpChromeSlotLease.ps1' });
  return { calls, provider };
}

test('same-token CDP lease heartbeat retries exactly once after uncertain helper timeout', async () => {
  const { calls, provider } = fixture([timeout(), success]);
  assert.deepEqual(await provider.heartbeat({ capability: 'exact-capability' }), { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, calls[1].args);
  for (const call of calls) {
    assert.equal(call.options.timeout, 12_000);
    assert.equal(call.options.shell, false);
    assert.equal(call.args[call.args.indexOf('-Action') + 1], 'Heartbeat');
    assert.equal(call.args[call.args.indexOf('-LeaseToken') + 1], 'exact-capability');
  }
});

test('CDP heartbeat is bounded to two same-token tries, never indefinite', async () => {
  const { calls, provider } = fixture([timeout(), timeout(), success]);
  await assert.rejects(() => provider.heartbeat({ capability: 'exact-capability' }), e => e.code === 'cdp_provider_timeout');
  assert.equal(calls.length, 2);
});

test('non-timeout CDP heartbeat failure is not replayed', async () => {
  const { calls, provider } = fixture([{ status: 4, stdout: '', stderr: 'lease rejected' }, success]);
  await assert.rejects(() => provider.heartbeat({ capability: 'exact-capability' }), e => e.code === 'cdp_provider_failed');
  assert.equal(calls.length, 1);
});

test('ambiguous Acquire and Release failures never replay a browser-changing operation', async () => {
  const acquired = fixture([timeout(), success]);
  await assert.rejects(
    () => acquired.provider.acquire({
      identity: { role: 'registered-cdp', cdpEndpoint: 'http://127.0.0.1:19222' },
      url: 'https://example.com', ownerTaskId: 'fixture-job'
    }),
    e => e.code === 'cdp_provider_timeout'
  );
  assert.equal(acquired.calls.length, 1);
  assert.equal(acquired.calls[0].args[acquired.calls[0].args.indexOf('-Action') + 1], 'Acquire');
  const released = fixture([timeout(), success]);
  await assert.rejects(
    () => released.provider.release({ capability: 'exact-capability', targetId: 'exact-owned-target' }),
    e => e.code === 'cdp_provider_timeout'
  );
  assert.equal(released.calls.length, 1);
  assert.equal(released.calls[0].args[released.calls[0].args.indexOf('-Action') + 1], 'Release');
});
