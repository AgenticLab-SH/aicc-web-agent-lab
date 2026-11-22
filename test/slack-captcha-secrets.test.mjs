import test from 'node:test';
import assert from 'node:assert/strict';
import { readSlackCaptchaAppToken, storeSlackCaptchaAppToken } from '../src/notifications/slack-captcha-secrets.mjs';

const reference = Object.freeze({ service: 'aicc-slack-captcha', account: 'T123456789' });
const token = 'xapp-demo-fixture-value-1';

test('Windows app token uses Credential Manager helper stdin and never argv or result', async () => {
  const calls = [];
  const runner = async (executable, args, options = {}) => {
    calls.push({ executable, args, input: options.input });
    return args.includes('Read') ? { ok: true, stdout: token } : { ok: true, stdout: '{"ok":true}' };
  };
  const stored = await storeSlackCaptchaAppToken(reference, token, { platform: 'win32', pwshExecutable: 'pwsh', runSecretCommand: runner });
  const read = await readSlackCaptchaAppToken(reference, { platform: 'win32', pwshExecutable: 'pwsh', runSecretCommand: runner });
  assert.equal(stored.backend, 'windows_credential_manager');
  assert.equal(read, token);
  assert.equal(calls[0].executable, 'pwsh');
  assert.match(calls[0].args.join(' '), /Invoke-WindowsSlackAppTokenStore\.ps1.*Store/);
  assert.equal(calls[0].args.includes(token), false);
  assert.equal(calls[0].input, `${token}\n`);
  assert.match(calls[1].args.join(' '), /Invoke-WindowsSlackAppTokenStore\.ps1.*Read/);
  assert.equal(calls[1].input, undefined);
  assert.doesNotMatch(JSON.stringify(stored), /xapp-/);
});

test('rejects bot tokens, unsupported platforms and malformed references before spawn', async () => {
  let called = false;
  const runner = async () => { called = true; return { ok: true, stdout: token }; };
  await assert.rejects(storeSlackCaptchaAppToken(reference, 'xoxb-demo-fixture-value-2', { platform: 'win32', runSecretCommand: runner }), /invalid/);
  await assert.rejects(readSlackCaptchaAppToken(reference, { platform: 'linux', runSecretCommand: runner }), /windows/);
  await assert.rejects(readSlackCaptchaAppToken({ service: '../bad', account: 'T123456789' }, { platform: 'win32', runSecretCommand: runner }), /reference/);
  assert.equal(called, false);
});
