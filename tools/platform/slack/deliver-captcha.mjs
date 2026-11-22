#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { WebClient } from '@slack/web-api';
import { deliverSlackCaptcha } from '../../../src/notifications/slack-captcha-delivery.mjs';
import { armSlackCaptchaWake } from '../../../src/notifications/slack-captcha-wake.mjs';
import { readSlackBotToken, loadSlackBotConfig } from '../../../src/slack-bot-transport.mjs';
import { openOwnerCaptchaState } from './captcha-bridge.mjs';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk.toString('utf8');
  if (Buffer.byteLength(input) > 4096) throw new Error('captcha_delivery_input_too_large');
}

try {
  const payload = JSON.parse(input);
  const stateRoot = process.env.AICC_STATE_ROOT || path.join(os.homedir(), '.ai-control-center');
  const config = loadSlackBotConfig(path.join(stateRoot, 'notifications', 'slack-alerts.json'));
  const state = openOwnerCaptchaState(stateRoot);
  const request = state.create({
    projectKey: payload.projectKey,
    taskId: payload.taskId,
    challengeRevision: payload.challengeRevision,
    siteLabel: payload.siteLabel,
    expiresAt: payload.expiresAt
  });
  try {
    const callback = payload.callback;
    if (!callback || typeof callback !== 'object') throw new Error('captcha_wake_config_required');
    const wake = armSlackCaptchaWake({
      state,
      request,
      projectRoot: path.resolve(callback.projectRoot),
      manifestFile: path.resolve(callback.manifestFile),
      codexExecutable: path.resolve(callback.codexExecutable),
      resultRoot: path.join(stateRoot, 'runtime', 'slack-captcha-wake')
    });
    const token = await readSlackBotToken(config);
    const webClient = new WebClient(token);
    const result = await deliverSlackCaptcha({ state, request, cropPath: path.resolve(payload.cropPath), webClient, config });
    process.stdout.write(`${JSON.stringify({ ...result, bindingHash: request.bindingHash, challengeRevision: request.challengeRevision,
      projectKey: request.projectKey, taskId: request.taskId, expiresAt: request.expiresAt,
      liveAutoWake: true, callbackId: wake.callbackId })}\n`);
  } catch (error) {
    await state.cancel(request).catch(() => {});
    throw error;
  }
} catch (error) {
  const reason = /^[a-z0-9_]{1,80}$/.test(String(error?.message ?? ''))
    ? String(error.message)
    : 'captcha_delivery_failed';
  process.stderr.write(`${JSON.stringify({ ok: false, state: 'captcha_delivery_hold', reason })}\n`);
  process.exitCode = 1;
}
