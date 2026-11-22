#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSlackCaptchaState } from '../../../src/notifications/slack-captcha-state.mjs';
import { readSlackCaptchaLoopbackEndpoint } from '../../../src/notifications/slack-captcha-loopback.mjs';

export function openOwnerCaptchaState(stateRoot = process.env.AICC_STATE_ROOT || path.join(os.homedir(), '.ai-control-center')) {
  const config = JSON.parse(fs.readFileSync(path.join(stateRoot, 'notifications', 'slack-alerts.json'), 'utf8'));
  return createSlackCaptchaState({
    root: path.join(stateRoot, 'notifications', 'slack-captcha'),
    identity: { ...config, userId: config.recipientUserId }
  });
}

export function captchaBridgeStatus({ open = openOwnerCaptchaState,
  stateRoot = process.env.AICC_STATE_ROOT || path.join(os.homedir(), '.ai-control-center'),
  readEndpoint = readSlackCaptchaLoopbackEndpoint } = {}) {
  try {
    const loopback = readEndpoint({ privateRoot: path.join(stateRoot, 'notifications', 'slack-captcha') });
    return { ok: true, state: 'configured', ...open(stateRoot).status(),
      consumeEndpoint: loopback?.endpoint ?? null, consumePort: loopback?.port ?? null };
  }
  catch (error) {
    if (['ENOENT', 'private_windows_acl_required'].includes(error.code) || /unsafe_state_path|private_windows_acl_required/.test(error.message)) {
      return { ok: false, state: 'not_configured', liveAutoWake: false };
    }
    throw error;
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: captcha-bridge.mjs status\nNo CAPTCHA value is printed by this command. Consume requires an exact active AICC interactive browser lease.\n');
  } else {
    try { process.stdout.write(`${JSON.stringify(captchaBridgeStatus())}\n`); }
    catch { process.stderr.write('{"ok":false,"state":"captcha_bridge_hold"}\n'); process.exitCode = 1; }
  }
}
