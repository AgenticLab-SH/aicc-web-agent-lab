import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  parseSlackCaptchaConsumeBody,
  publishSlackCaptchaLoopbackEndpoint,
  readSlackCaptchaLoopbackEndpoint,
  removeSlackCaptchaLoopbackEndpoint,
  startSlackCaptchaLoopback,
  validateSlackCaptchaLoopbackEnvelope
} from '../src/notifications/slack-captcha-loopback.mjs';
import { captchaBridgeStatus } from '../tools/platform/slack/captcha-bridge.mjs';

const binding = Object.freeze({
  requestId: '12345678-1234-4234-8234-123456789abc',
  projectKey: 'open-AICC',
  taskId: 'codex-task-42',
  challengeRevision: 'rev-7',
  bindingHash: 'a'.repeat(64)
});
const browserBinding = Object.freeze({
  browserLeaseId: 'browser-lease-42',
  browserTargetId: 'target-42',
  browserOrigin: 'https://example.com'
});
const consumeBody = Object.freeze({ ...binding, ...browserBinding });
const browserGuard = Object.freeze({ authorize: value => {
  assert.deepEqual(value, { taskId: binding.taskId, ...browserBinding });
  return { ok: true };
} });

function post(endpoint, body, options = {}) {
  const target = new URL(endpoint);
  const payload = options.raw ?? JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: target.hostname, port: target.port, path: options.path ?? target.pathname,
      method: options.method ?? 'POST', headers: {
        Host: options.host ?? target.host,
        'Content-Type': options.contentType ?? 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(options.headers ?? {})
      } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

test('loopback returns one CAPTCHA value only after exact state consumption and then rejects replay', async t => {
  let consumed = false;
  let purgedBeforeCallback = false;
  const state = { async consume(actual, useValue) {
    if (consumed || JSON.stringify(actual) !== JSON.stringify(binding)) throw new Error('binding_or_replay');
    consumed = true;
    purgedBeforeCallback = true;
    await useValue('A9b2');
    return { ok: true, state: 'consumed_and_purged', slackFileDeleted: false };
  } };
  const server = await startSlackCaptchaLoopback({ state, browserGuard });
  t.after(() => server.stop().catch(() => {}));
  assert.match(server.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1\/captcha\/consume$/);
  const first = await post(server.endpoint, consumeBody);
  assert.equal(first.status, 200);
  assert.equal(first.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(purgedBeforeCallback, true);
  assert.deepEqual(JSON.parse(first.text), { ok: true, value: 'A9b2' });
  const replay = await post(server.endpoint, consumeBody);
  assert.equal(replay.status, 403);
  assert.doesNotMatch(replay.text, /A9b2|binding_or_replay/);
});

test('wrong Host, method, content type, path, body and exact binding all fail closed', async t => {
  let consumeCalls = 0;
  const state = { async consume(actual, useValue) {
    consumeCalls += 1;
    if (actual.bindingHash !== binding.bindingHash) throw new Error('wrong_binding');
    await useValue('X1');
    return { ok: true, state: 'consumed_and_purged' };
  } };
  const server = await startSlackCaptchaLoopback({ state, browserGuard });
  t.after(() => server.stop().catch(() => {}));
  const cases = [
    { host: 'localhost' },
    { method: 'GET' },
    { contentType: 'text/plain' },
    { path: '/v1/captcha/other' },
    { raw: '{bad json' },
    { body: { ...consumeBody, extra: 'x' } },
    { body: { ...consumeBody, bindingHash: 'b'.repeat(64) } },
    { body: { ...consumeBody, browserLeaseId: 'wrong-lease' } }
  ];
  for (const item of cases) {
    const response = await post(server.endpoint, item.body ?? consumeBody, item);
    assert.equal(response.status, 403);
    assert.deepEqual(JSON.parse(response.text), { ok: false, state: 'captcha_consume_hold' });
  }
  assert.equal(consumeCalls, 1);
});

test('non-loopback remote address and oversized bodies are rejected before consumption', async () => {
  assert.throws(() => validateSlackCaptchaLoopbackEnvelope({
    socket: { remoteAddress: '192.0.2.1' }, method: 'POST', url: '/v1/captcha/consume',
    headers: { host: '127.0.0.1:1234', 'content-type': 'application/json', 'content-length': '2' }
  }, '127.0.0.1:1234'), /captcha_loopback_remote_required/);
  assert.throws(() => parseSlackCaptchaConsumeBody(Buffer.alloc(2049, 0x61)), /captcha_loopback_body_size_invalid/);
});

test('endpoint status record exposes only loopback endpoint and port and enforces its owner PID', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-captcha-endpoint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkDirectory = () => {};
  const endpoint = 'http://127.0.0.1:43210/v1/captcha/consume';
  publishSlackCaptchaLoopbackEndpoint({ privateRoot: root, endpoint, port: 43210, checkDirectory });
  assert.deepEqual(readSlackCaptchaLoopbackEndpoint({ privateRoot: root, checkDirectory, isProcessAlive: () => true }),
    { endpoint, port: 43210 });
  const stored = fs.readFileSync(path.join(root, 'loopback-endpoint.json'), 'utf8');
  assert.doesNotMatch(stored, /value|bindingHash|xapp-|xox[baprs]-/i);
  assert.throws(() => removeSlackCaptchaLoopbackEndpoint({ privateRoot: root, pid: process.pid + 1, checkDirectory }),
    /captcha_loopback_endpoint_owner_mismatch/);
  assert.equal(removeSlackCaptchaLoopbackEndpoint({ privateRoot: root, checkDirectory }), true);
});

test('bridge status publishes endpoint metadata without a CAPTCHA value or capability', () => {
  const endpoint = 'http://127.0.0.1:43210/v1/captcha/consume';
  const result = captchaBridgeStatus({
    stateRoot: 'C:\\owner-state',
    open: () => ({ status: () => ({ schemaVersion: 1, active: 1, answerReady: 1, expired: 0 }) }),
    readEndpoint: () => ({ endpoint, port: 43210 })
  });
  assert.equal(result.consumeEndpoint, endpoint);
  assert.equal(result.consumePort, 43210);
  assert.doesNotMatch(JSON.stringify(result), /bindingHash|"value"/);
});
