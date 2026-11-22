import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexTaskCallbackService } from './codex-task-callback.mjs';

const WATCH_ID = /^watch_[A-Za-z0-9-]{8,200}$/;
const TERMINAL_WATCH_STATES = new Set(['completed', 'failed', 'cancelled']);
const RETRYABLE_CALLBACK_ERRORS = new Set([
  'callback_thread_active',
  'callback_destination_writer_busy',
  'callback_turn_still_active',
  'callback_writer_busy'
]);

export class WebGptWatchCallbackError extends Error {
  constructor(code, message = code, data = null) {
    super(message);
    this.name = 'WebGptWatchCallbackError';
    this.code = code;
    this.data = data;
  }
}

function assertPrivateFile(file, code) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new WebGptWatchCallbackError(code);
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0) throw new WebGptWatchCallbackError(`${code}_permissions`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new WebGptWatchCallbackError(`${code}_owner`);
  }
}

function atomicPrivateJson(file, value) {
  const parent = fs.realpathSync(path.dirname(file));
  if (parent !== path.dirname(file)) throw new WebGptWatchCallbackError('web_gpt_callback_result_parent_alias');
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (process.platform !== 'win32' && (parentStat.mode & 0o077) !== 0)) {
    throw new WebGptWatchCallbackError('web_gpt_callback_result_parent_unsafe');
  }
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function validateWatch(watch, watchId, taskId) {
  if (!watch || watch.id !== watchId) throw new WebGptWatchCallbackError('web_gpt_watch_identity_mismatch');
  if (watch.ownerTaskId !== taskId) throw new WebGptWatchCallbackError('web_gpt_watch_owner_mismatch');
  if (!Number.isSafeInteger(watch.version) || watch.version < 1) throw new WebGptWatchCallbackError('web_gpt_watch_version_invalid');
  if (!new Set(['registered', 'submitted', 'responding', 'completed', 'failed', 'cancelled']).has(watch.state)) {
    throw new WebGptWatchCallbackError('web_gpt_watch_state_unknown');
  }
  return watch;
}

function resultDocument(binding, watch, completedAt) {
  const artifacts = (watch.artifacts ?? []).slice(0, 256);
  return {
    operation: binding.operationId,
    status: watch.state === 'completed' ? 'PASS' : 'HOLD',
    completedAt,
    webGpt: {
      watchId: watch.id,
      state: watch.state,
      version: watch.version,
      surface: watch.surface,
      ownerTaskId: watch.ownerTaskId,
      proof: {
        conversationId: watch.proof?.conversationId ?? null,
        conversationUrl: watch.proof?.conversationUrl ?? null,
        userTurnId: watch.proof?.userTurnId ?? null,
        assistantTurnId: watch.proof?.assistantTurnId ?? null,
        notGenerating: watch.proof?.notGenerating === true,
        completionActionVisible: watch.proof?.completionActionVisible === true
      },
      artifactCount: (watch.artifacts ?? []).length,
      artifactsTruncated: (watch.artifacts ?? []).length > artifacts.length,
      artifacts: artifacts.map(item => ({
        id: item.id,
        kind: item.kind,
        name: item.name,
        bytes: item.bytes,
        sha256: item.sha256,
        mediaType: item.mediaType
      })),
      error: watch.error == null ? null : {
        code: String(watch.error.code ?? '').slice(0, 100),
        message: String(watch.error.message ?? '').slice(0, 4_000)
      }
    }
  };
}

function verifyExistingResult(file, binding, watchId) {
  assertPrivateFile(file, 'web_gpt_callback_result_unsafe');
  let document;
  try { document = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new WebGptWatchCallbackError('web_gpt_callback_result_invalid'); }
  if (document?.operation !== binding.operationId || document?.webGpt?.watchId !== watchId || document?.webGpt?.ownerTaskId !== binding.taskId) {
    throw new WebGptWatchCallbackError('web_gpt_callback_result_mismatch');
  }
  return sha256File(file);
}

export class LocalWebGptObserverClient {
  constructor({
    baseUrl = process.env.CODEX_WEB_GPT_OBSERVER_URL?.trim() || 'http://127.0.0.1:17843',
    tokenFile = path.join(os.homedir(), '.codex-chatgpt-web', 'observer', 'token')
  } = {}) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' || !new Set(['127.0.0.1', 'localhost']).has(parsed.hostname) || parsed.port !== '17843') {
      throw new WebGptWatchCallbackError('web_gpt_observer_url_unsafe');
    }
    this.baseUrl = parsed.origin;
    this.tokenFile = path.resolve(tokenFile);
  }

  async #request(pathname) {
    assertPrivateFile(this.tokenFile, 'web_gpt_observer_token_unsafe');
    const token = fs.readFileSync(this.tokenFile, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{32,200}$/.test(token)) throw new WebGptWatchCallbackError('web_gpt_observer_token_invalid');
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(125_000)
    });
    if (!response.ok) throw new WebGptWatchCallbackError('web_gpt_observer_http_error', `observer HTTP ${response.status}`);
    return await response.json();
  }

  async get(watchId) { return await this.#request(`/api/watches/${encodeURIComponent(watchId)}`); }
  async wait(watchId, afterVersion, timeoutMs) {
    return await this.#request(`/api/watches/${encodeURIComponent(watchId)}/wait?after=${afterVersion}&timeoutMs=${timeoutMs}`);
  }
}

export async function runWebGptWatchCallback(options = {}) {
  const watchId = String(options.watchId ?? '').trim();
  if (!WATCH_ID.test(watchId)) throw new WebGptWatchCallbackError('web_gpt_watch_id_invalid');
  const callbackService = options.callbackService ?? new CodexTaskCallbackService();
  const observer = options.observer ?? new LocalWebGptObserverClient({ baseUrl: options.observerUrl, tokenFile: options.observerTokenFile });
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const waitTimeoutMs = Math.max(1_000, Math.min(120_000, Number(options.waitTimeoutMs ?? 120_000)));
  const retryMs = Math.max(250, Math.min(60_000, Number(options.retryMs ?? 5_000)));
  const binding = callbackService.inspect({ callbackId: options.callbackId });
  const deadline = Math.min(Date.parse(binding.expiresAt), now() + Math.max(60_000, Number(options.maxWaitMs ?? 24 * 60 * 60_000)));
  let digest;
  let watch = null;

  if (fs.existsSync(binding.resultFile)) {
    digest = verifyExistingResult(binding.resultFile, binding, watchId);
  } else {
    watch = validateWatch(await observer.get(watchId), watchId, binding.taskId);
    while (!TERMINAL_WATCH_STATES.has(watch.state)) {
      const remaining = deadline - now();
      if (remaining <= 0) throw new WebGptWatchCallbackError('web_gpt_watch_wait_expired');
      watch = validateWatch(await observer.wait(watchId, watch.version, Math.min(waitTimeoutMs, remaining)), watchId, binding.taskId);
    }
    atomicPrivateJson(binding.resultFile, resultDocument(binding, watch, new Date(now()).toISOString()));
    digest = sha256File(binding.resultFile);
  }

  for (;;) {
    try {
      const callback = await callbackService.complete({
        callbackId: binding.callbackId,
        expectedResultSha256: digest,
        timeoutMs: Number(options.callbackTimeoutMs ?? 12 * 60 * 60_000)
      });
      const persisted = watch ?? JSON.parse(fs.readFileSync(binding.resultFile, 'utf8')).webGpt;
      return { ok: callback.ok === true, watchId, watchState: persisted.state, resultFile: binding.resultFile, resultSha256: digest, callback };
    } catch (error) {
      if (!RETRYABLE_CALLBACK_ERRORS.has(error?.code) || now() + retryMs >= deadline) throw error;
      await sleep(retryMs);
    }
  }
}
