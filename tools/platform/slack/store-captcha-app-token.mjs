#!/usr/bin/env node
import { storeSlackCaptchaAppToken } from '../../../src/notifications/slack-captcha-secrets.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

let token = '';
for await (const chunk of process.stdin) {
  token += chunk.toString('utf8');
  if (token.length > 512) break;
}

try {
  const result = await storeSlackCaptchaAppToken({ service: argument('--service'), account: argument('--account') }, token);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message === 'invalid_slack_app_token' ? error.message : 'slack_app_token_store_failed' })}\n`);
  process.exitCode = 1;
} finally {
  token = null;
}
