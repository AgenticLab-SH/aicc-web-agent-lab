import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { consumeSlackCaptchaIntoCurrentTask } from './slack-captcha-consumer.mjs';
import { SlackCaptchaBrowserLeaseGuard, validateSlackCaptchaBrowserBinding } from './slack-captcha-browser-guard.mjs';
import { assertPrivateCaptchaPath } from './slack-captcha-state.mjs';

export const SLACK_CAPTCHA_CONSUME_PATH = '/v1/captcha/consume';
const MAX_BODY_BYTES = 2048;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const UUID = /^[a-f0-9-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;

const fail = code => { throw new Error(code); };

function fixedJson(res, statusCode, body) {
  const output = Buffer.from(JSON.stringify(body));
  let wiped = false;
  const wipe = () => { if (!wiped) { wiped = true; output.fill(0); } };
  res.once('finish', wipe);
  res.once('close', wipe);
  res.statusCode = statusCode;
  res.shouldKeepAlive = false;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Connection', 'close');
  res.end(output);
}

export function validateSlackCaptchaLoopbackEnvelope(request, authority) {
  const remoteAddress = request?.socket?.remoteAddress;
  if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::ffff:127.0.0.1') fail('captcha_loopback_remote_required');
  if (request.headers?.host !== authority) fail('captcha_loopback_host_mismatch');
  if (request.method !== 'POST' || request.url !== SLACK_CAPTCHA_CONSUME_PATH) fail('captcha_loopback_route_mismatch');
  if (request.headers?.['content-type'] !== 'application/json') fail('captcha_loopback_json_required');
  if (request.headers?.origin || request.headers?.['content-encoding']) fail('captcha_loopback_browser_or_encoded_request_forbidden');
  const length = request.headers?.['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) fail('captcha_loopback_body_too_large');
}

export function parseSlackCaptchaConsumeBody(raw) {
  const input = Buffer.isBuffer(raw) ? raw : Buffer.from(raw ?? '');
  if (input.length === 0 || input.length > MAX_BODY_BYTES) fail('captcha_loopback_body_size_invalid');
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)); }
  catch { fail('captcha_loopback_body_invalid'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') fail('captcha_loopback_body_invalid');
  const keys = Object.keys(body).sort();
  const expected = ['bindingHash', 'browserLeaseId', 'browserOrigin', 'browserTargetId', 'challengeRevision', 'projectKey', 'requestId', 'taskId'];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) fail('captcha_loopback_binding_shape_invalid');
  if (!UUID.test(body.requestId) || !IDENTIFIER.test(body.projectKey) || !IDENTIFIER.test(body.taskId)
    || !IDENTIFIER.test(body.challengeRevision) || !HASH.test(body.bindingHash)) fail('captcha_loopback_binding_invalid');
  const browser = validateSlackCaptchaBrowserBinding(body);
  return Object.freeze({ requestId: body.requestId, projectKey: body.projectKey, taskId: body.taskId,
    challengeRevision: body.challengeRevision, bindingHash: body.bindingHash, ...browser });
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) fail('captcha_loopback_body_too_large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

export function createSlackCaptchaLoopbackHandler({ state, authority, deleteSlackFile, browserGuard }) {
  if (!state || typeof state.consume !== 'function') fail('captcha_state_consumer_required');
  if (typeof authority !== 'function') fail('captcha_loopback_authority_required');
  if (!browserGuard || typeof browserGuard.authorize !== 'function') fail('captcha_browser_guard_required');
  return async (request, response) => {
    let bodyBuffer = null;
    try {
      validateSlackCaptchaLoopbackEnvelope(request, authority());
      bodyBuffer = await readBody(request);
      const parsed = parseSlackCaptchaConsumeBody(bodyBuffer);
      browserGuard.authorize({
        taskId: parsed.taskId,
        browserLeaseId: parsed.browserLeaseId,
        browserTargetId: parsed.browserTargetId,
        browserOrigin: parsed.browserOrigin
      });
      const binding = Object.freeze({ requestId: parsed.requestId, projectKey: parsed.projectKey, taskId: parsed.taskId,
        challengeRevision: parsed.challengeRevision, bindingHash: parsed.bindingHash });
      let answer = null;
      const result = await consumeSlackCaptchaIntoCurrentTask({
        state,
        binding,
        currentTaskId: binding.taskId,
        typeIntoCurrentChallenge: async value => { answer = value; },
        deleteSlackFile
      });
      if (!result.ok || typeof answer !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(answer)) fail('captcha_loopback_consume_failed');
      const output = Buffer.from(`{"ok":true,"value":"${answer}"}`);
      let wiped = false;
      const wipe = () => { if (!wiped) { wiped = true; output.fill(0); } };
      response.once('finish', wipe);
      response.once('close', wipe);
      answer = null;
      response.statusCode = 200;
      response.shouldKeepAlive = false;
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-store, max-age=0');
      response.setHeader('Pragma', 'no-cache');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Connection', 'close');
      response.end(output);
    } catch {
      if (!response.headersSent) fixedJson(response, 403, { ok: false, state: 'captcha_consume_hold' });
      else response.destroy();
    } finally {
      if (bodyBuffer) bodyBuffer.fill(0);
    }
  };
}

export async function startSlackCaptchaLoopback({ state, stateRoot, deleteSlackFile, browserGuard,
  createServer = http.createServer } = {}) {
  let authority = null;
  const resolvedBrowserGuard = browserGuard ?? new SlackCaptchaBrowserLeaseGuard({ stateRoot });
  const handler = createSlackCaptchaLoopbackHandler({ state, authority: () => authority, deleteSlackFile,
    browserGuard: resolvedBrowserGuard });
  const server = createServer(handler);
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1;
  server.maxRequestsPerSocket = 1;
  await new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || !Number.isInteger(address.port)) {
    server.close();
    fail('captcha_loopback_bind_failed');
  }
  authority = `127.0.0.1:${address.port}`;
  return Object.freeze({
    endpoint: `http://${authority}${SLACK_CAPTCHA_CONSUME_PATH}`,
    port: address.port,
    stop: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  });
}

function endpointFile(privateRoot) {
  return path.join(privateRoot, 'loopback-endpoint.json');
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function publishSlackCaptchaLoopbackEndpoint({ privateRoot, endpoint, port, pid = process.pid,
  checkDirectory = assertPrivateCaptchaPath } = {}) {
  checkDirectory(privateRoot);
  if (endpoint !== `http://127.0.0.1:${port}${SLACK_CAPTCHA_CONSUME_PATH}` || !Number.isInteger(port) || port < 1 || port > 65535
    || !Number.isInteger(pid) || pid < 1) fail('captcha_loopback_endpoint_invalid');
  const file = endpointFile(privateRoot);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('unsafe_captcha_endpoint_path');
    let prior = null;
    try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* replace only a safe regular file. */ }
    if (prior?.pid && processAlive(prior.pid)) fail('captcha_loopback_endpoint_already_active');
    fs.unlinkSync(file);
  }
  const temporary = `${file}.${pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, endpoint, port, pid, startedAt: new Date().toISOString() })}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  return file;
}

export function readSlackCaptchaLoopbackEndpoint({ privateRoot, checkDirectory = assertPrivateCaptchaPath,
  isProcessAlive = processAlive } = {}) {
  checkDirectory(privateRoot);
  const file = endpointFile(privateRoot);
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) fail('unsafe_captcha_endpoint_path');
  checkDirectory(file, false);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('captcha_loopback_endpoint_corrupt'); }
  if (value?.schemaVersion !== 1 || value.endpoint !== `http://127.0.0.1:${value.port}${SLACK_CAPTCHA_CONSUME_PATH}`
    || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !Number.isInteger(value.pid) || value.pid < 1) {
    fail('captcha_loopback_endpoint_corrupt');
  }
  if (!isProcessAlive(value.pid)) return null;
  return { endpoint: value.endpoint, port: value.port };
}

export function removeSlackCaptchaLoopbackEndpoint({ privateRoot, pid = process.pid,
  checkDirectory = assertPrivateCaptchaPath } = {}) {
  checkDirectory(privateRoot);
  const file = endpointFile(privateRoot);
  if (!fs.existsSync(file)) return false;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) fail('unsafe_captcha_endpoint_path');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('captcha_loopback_endpoint_corrupt'); }
  if (value.pid !== pid) fail('captcha_loopback_endpoint_owner_mismatch');
  fs.unlinkSync(file);
  return true;
}
