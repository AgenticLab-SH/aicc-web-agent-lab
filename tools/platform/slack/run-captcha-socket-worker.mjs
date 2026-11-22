#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSlackBotToken, loadSlackBotConfig } from '../../../src/slack-bot-transport.mjs';
import { readSlackCaptchaAppToken } from '../../../src/notifications/slack-captcha-secrets.mjs';
import { startSlackCaptchaSocket } from '../../../src/notifications/slack-captcha-socket.mjs';
import { deleteSlackCaptchaFile } from '../../../src/notifications/slack-captcha-delivery.mjs';
import { completeSlackCaptchaWake } from '../../../src/notifications/slack-captcha-wake.mjs';
import { publishSlackCaptchaLoopbackEndpoint, removeSlackCaptchaLoopbackEndpoint,
  startSlackCaptchaLoopback } from '../../../src/notifications/slack-captcha-loopback.mjs';
import { openOwnerCaptchaState } from './captcha-bridge.mjs';

let worker = null;
let loopback = null;
let privateRoot = null;
let endpointPublished = false;
let timer = null;
let stopping = false;
const waking = new Set();

function writeWorkerStatus(state, reason = null) {
  if (!privateRoot) return;
  const file = path.join(privateRoot, 'worker-status.json');
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = { schemaVersion: 1, state, pid: process.pid, updatedAt: new Date().toISOString(),
    ...(reason ? { reason: /^[a-z0-9_]{2,80}$/.test(reason) ? reason : 'unknown_error' } : {}) };
  fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

async function cleanup() {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  if (endpointPublished && privateRoot) {
    try { removeSlackCaptchaLoopbackEndpoint({ privateRoot }); } catch { /* fail closed without exposing details. */ }
  }
  if (loopback) { try { await loopback.stop(); } catch { /* already stopped. */ } }
  if (worker) { try { await worker.stop(); } catch { /* already stopped. */ } }
}

try {
  const stateRoot = process.env.AICC_STATE_ROOT || path.join(os.homedir(), '.ai-control-center');
  const config = loadSlackBotConfig(path.join(stateRoot, 'notifications', 'slack-alerts.json'));
  const state = openOwnerCaptchaState(stateRoot);
  privateRoot = path.join(stateRoot, 'notifications', 'slack-captcha');
  const triggerWake = requestId => {
    if (waking.has(requestId)) return;
    const wake = state.pendingWakes().find(item => item.requestId === requestId);
    if (!wake) return;
    waking.add(requestId);
    completeSlackCaptchaWake({ state, wake })
      .catch(() => {})
      .finally(() => waking.delete(requestId));
  };
  const reconcileWakes = () => {
    for (const wake of state.pendingWakes()) triggerWake(wake.requestId);
  };
  worker = await startSlackCaptchaSocket({
    state,
    appTokenProvider: () => readSlackCaptchaAppToken({ service: 'aicc-slack-captcha', account: config.teamId }),
    botTokenProvider: () => readSlackBotToken(config),
    report: result => { if (result?.state === 'answer_ready' && result.requestId) triggerWake(result.requestId); }
  });
  loopback = await startSlackCaptchaLoopback({
    state,
    stateRoot,
    deleteSlackFile: fileId => deleteSlackCaptchaFile(worker.webClient, fileId)
  });
  publishSlackCaptchaLoopbackEndpoint({ privateRoot, endpoint: loopback.endpoint, port: loopback.port });
  endpointPublished = true;
  writeWorkerStatus('running');
  const purge = () => {
    reconcileWakes();
    return state.purgeExpired({ deleteSlackFile: fileId => deleteSlackCaptchaFile(worker.webClient, fileId) }).catch(() => {});
  };
  await purge();
  timer = setInterval(purge, 30_000);
  timer.unref();
  const stop = async () => {
    await cleanup();
    try { writeWorkerStatus('stopped'); } catch { /* status is best effort. */ }
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise(() => {});
} catch (error) {
  await cleanup();
  try { writeWorkerStatus('hold', String(error?.message ?? 'unknown_error')); } catch { /* status is best effort. */ }
  process.stderr.write('{"ok":false,"state":"captcha_socket_hold"}\n');
  process.exitCode = 1;
}
