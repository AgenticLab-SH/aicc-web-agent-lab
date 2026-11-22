import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalWebGptObserverClient } from './web-gpt-watch-callback.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WATCH_ID = /^watch_[A-Za-z0-9-]{8,200}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,200}$/;
const TASK_ID = /^[A-Za-z0-9._:@/-]{3,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_RESULT_BYTES = 1024 * 1024;
const TERMINAL = new Set(['PASS', 'HOLD', 'FAIL']);

export class CodexToWebGptFollowupError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'CodexToWebGptFollowupError';
    this.code = code;
  }
}

function requireId(value, expression, code) {
  const text = String(value ?? '').trim();
  if (!expression.test(text)) throw new CodexToWebGptFollowupError(code);
  return text;
}

function canonicalConversationUrl(value) {
  let parsed;
  try { parsed = new URL(String(value ?? '')); }
  catch { throw new CodexToWebGptFollowupError('conversation_url_invalid'); }
  if (parsed.protocol !== 'https:' || !['chatgpt.com', 'chat.openai.com'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port
    || !/\/(?:c|g\/g-p-[A-Za-z0-9_-]+\/c)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(parsed.pathname)) {
    throw new CodexToWebGptFollowupError('conversation_url_invalid');
  }
  return parsed.origin + parsed.pathname.replace(/\/$/, '');
}

function readTerminalProof(file, expectedSha, operationId, codexSessionId, projectRoot = null) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    throw new CodexToWebGptFollowupError('result_path_invalid');
  }
  const normalized = path.resolve(file);
  const parent = path.dirname(normalized);
  if (fs.realpathSync.native(parent) !== parent) throw new CodexToWebGptFollowupError('result_parent_aliased');
  const stat = fs.lstatSync(normalized);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_RESULT_BYTES) {
    throw new CodexToWebGptFollowupError('result_file_unsafe');
  }
  const descriptor = fs.openSync(normalized, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const before = fs.fstatSync(descriptor);
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ino !== after.ino || bytes.length !== after.size) {
      throw new CodexToWebGptFollowupError('result_changed_during_read');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha) throw new CodexToWebGptFollowupError('result_hash_mismatch');
  let doc;
  try { doc = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new CodexToWebGptFollowupError('result_json_invalid'); }
  if (doc?.operation !== operationId || doc?.codexTaskId !== codexSessionId
    || !TERMINAL.has(doc?.status)) {
    throw new CodexToWebGptFollowupError('result_identity_or_status_mismatch');
  }
  if (projectRoot != null) {
    if (typeof doc.projectRoot !== 'string'
      || fs.realpathSync.native(doc.projectRoot) !== fs.realpathSync.native(projectRoot)) {
      throw new CodexToWebGptFollowupError('result_project_root_mismatch');
    }
  }
  return { status: doc.status, sha256, bytes: bytes.length };
}

export class ObserverFollowupClient extends LocalWebGptObserverClient {
  async enqueueFollowup({ afterWatchId, mode = 'queue', prompt, requestId }) {
    const stat = fs.lstatSync(this.tokenFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CodexToWebGptFollowupError('observer_token_unsafe');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new CodexToWebGptFollowupError('observer_token_permissions');
    }
    const token = fs.readFileSync(this.tokenFile, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{32,200}$/.test(token)) throw new CodexToWebGptFollowupError('observer_token_invalid');
    let response;
    try {
      response = await fetch(`${this.baseUrl}/api/followups`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ afterWatchId, mode, prompt, requestId }),
        signal: AbortSignal.timeout(30_000)
      });
    } catch {
      throw new CodexToWebGptFollowupError('DELIVERY_UNCERTAIN');
    }
    if (!response.ok) {
      throw new CodexToWebGptFollowupError('observer_followup_rejected', `observer HTTP ${response.status}`);
    }
    try { return await response.json(); }
    catch { throw new CodexToWebGptFollowupError('DELIVERY_UNCERTAIN'); }
  }
}

export async function enqueueCodexCompletionToWebGpt(options = {}) {
  const watchId = requireId(options.watchId, WATCH_ID, 'watch_id_invalid');
  const originTaskId = requireId(options.originTaskId, TASK_ID, 'origin_task_id_invalid');
  const codexSessionId = requireId(options.codexSessionId, UUID, 'codex_session_id_invalid').toLowerCase();
  const operationId = requireId(options.operationId, REQUEST_ID, 'operation_id_invalid');
  const requestId = requireId(options.requestId, REQUEST_ID, 'request_id_invalid');
  const expectedSha = requireId(options.expectedResultSha256, HASH, 'result_sha256_invalid');
  const conversationUrl = canonicalConversationUrl(options.conversationUrl);
  const conversationId = conversationUrl.slice(conversationUrl.lastIndexOf('/') + 1).toLowerCase();
  const result = readTerminalProof(
    options.resultFile, expectedSha, operationId, codexSessionId, options.expectedProjectRoot ?? null
  );

  const observer = options.observer ?? new ObserverFollowupClient({
    baseUrl: options.observerUrl,
    tokenFile: options.observerTokenFile ?? path.join(os.homedir(), '.codex-chatgpt-web', 'observer', 'token')
  });
  const watch = await observer.get(watchId);
  const proof = watch?.proof ?? {};
  if (watch?.id !== watchId || watch.ownerTaskId !== originTaskId
    || watch.surface !== 'chrome-extension' || watch.state !== 'completed'
    || !proof.tabId || String(proof.conversationId ?? '').toLowerCase() !== conversationId
    || !proof.userTurnId || !proof.assistantTurnId
    || proof.notGenerating !== true || proof.completionActionVisible !== true
    || canonicalConversationUrl(proof.conversationUrl) !== conversationUrl) {
    throw new CodexToWebGptFollowupError('parent_watch_not_verified');
  }

  const message = [
    '[AICC verified Codex task completion]',
    `Operation: ${operationId}`,
    `Codex task: codex://threads/${codexSessionId}`,
    `Terminal result: ${result.status}`,
    `Result SHA-256: ${result.sha256}`,
    'The worker result is a receipt, not proof of live deployment. Inspect the exact authorized AICC project and verify outstanding steps before reporting completion. Do not duplicate the Codex task.'
  ].join('\n');

  let queued;
  try { queued = await observer.enqueueFollowup({ afterWatchId: watchId, mode: 'queue', prompt: message, requestId }); }
  catch (error) {
    if (error?.code) throw error;
    throw new CodexToWebGptFollowupError('DELIVERY_UNCERTAIN');
  }
  if (!queued || !WATCH_ID.test(queued.id ?? '') || queued.ownerTaskId !== originTaskId || queued.surface !== watch.surface
    || (queued.proof?.conversationId && String(queued.proof.conversationId).toLowerCase() !== conversationId)
    || queued.dispatch?.afterWatchId !== watchId || queued.dispatch?.requestId !== requestId
    || queued.dispatch?.mode !== 'queue' || !['registered', 'submitted', 'responding', 'completed'].includes(queued.state)
    || (queued.proof?.conversationUrl && canonicalConversationUrl(queued.proof.conversationUrl) !== conversationUrl)) {
    throw new CodexToWebGptFollowupError('DELIVERY_UNCERTAIN');
  }

  // Enqueue is not proof that the Chrome extension sent the user turn.
  return Object.freeze({
    ok: true, delivery: 'QUEUED_NOT_DELIVERED', parentWatchId: watchId,
    followupWatchId: queued.id, requestId, codexSessionId,
    terminalStatus: result.status, resultSha256: result.sha256, resultBytes: result.bytes
  });
}
