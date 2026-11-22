import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { responseBlocks } from './notifications/slack-response-inbox.mjs';
import { resolveWindowsPwsh } from './lib/windows-pwsh.mjs';

const SLACK_API_ROOT = 'https://slack.com/api';
const ID_PATTERNS = Object.freeze({
  teamId: /^T[A-Z0-9]{8,}$/, recipientUserId: /^U[A-Z0-9]{8,}$/,
  appId: /^A[A-Z0-9]{8,}$/, botUserId: /^U[A-Z0-9]{8,}$/, botId: /^B[A-Z0-9]{8,}$/
});
const KEYCHAIN_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/;

export class SlackBotTransportError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'SlackBotTransportError';
    this.code = code;
    this.details = details;
  }
}

function requireMatch(name, value, pattern) {
  const normalized = String(value ?? '').trim();
  if (!pattern.test(normalized)) throw new SlackBotTransportError(`invalid_${name}`);
  return normalized;
}

export function validateSlackBotConfig(value) {
  if (!value || typeof value !== 'object') throw new SlackBotTransportError('slack_bot_config_required');
  if (value.schemaVersion !== 1) throw new SlackBotTransportError('unsupported_slack_bot_config_schema');
  if (value.transport !== 'aicc_slack_bot') throw new SlackBotTransportError('invalid_slack_bot_transport');
  const config = {
    schemaVersion: 1,
    transport: 'aicc_slack_bot',
    teamId: requireMatch('team_id', value.teamId, ID_PATTERNS.teamId),
    recipientUserId: requireMatch('recipient_user_id', value.recipientUserId, ID_PATTERNS.recipientUserId),
    appId: requireMatch('app_id', value.appId, ID_PATTERNS.appId),
    botUserId: requireMatch('bot_user_id', value.botUserId, ID_PATTERNS.botUserId),
    botId: requireMatch('bot_id', value.botId, ID_PATTERNS.botId),
    keychainService: requireMatch('keychain_service', value.keychainService, KEYCHAIN_REF),
    keychainAccount: requireMatch('keychain_account', value.keychainAccount, KEYCHAIN_REF)
  };
  if (config.botUserId === config.recipientUserId) throw new SlackBotTransportError('slack_sender_must_be_distinct');
  return Object.freeze(config);
}

export function defaultSlackBotConfigPath(options = {}) {
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT ?? path.join(os.homedir(), '.ai-control-center');
  return path.join(stateRoot, 'notifications', 'slack-alerts.json');
}

export function loadSlackBotConfig(file = defaultSlackBotConfigPath()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new SlackBotTransportError('slack_bot_config_unavailable', { cause: error.code ?? 'read_failed' });
  }
  try {
    return validateSlackBotConfig(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SlackBotTransportError) throw error;
    throw new SlackBotTransportError('slack_bot_config_invalid_json');
  }
}

function secretCommand(executable, args, options = {}) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, exitCode: null, stdout, stderr, ...result });
    };
    try {
      child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      finish({ code: 'spawn_failed' });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ code: 'command_timeout' });
    }, options.timeoutMs ?? 8_000);
    timer.unref();
    child.stdout.on('data', chunk => { if (stdout.length < 16_384) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { if (stderr.length < 16_384) stderr += chunk.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); finish({ code: 'spawn_failed' }); });
    child.on('close', exitCode => {
      clearTimeout(timer);
      finish({ ok: exitCode === 0, exitCode, code: exitCode === 0 ? null : 'command_failed' });
    });
    child.stdin.end(options.input ?? '');
  });
}

function validateBotToken(value) {
  const token = String(value ?? '').trim();
  if (!/^xoxb-[A-Za-z0-9-]{20,}$/.test(token)) throw new SlackBotTransportError('invalid_slack_bot_token');
  return token;
}

export async function readSlackBotToken(reference, options = {}) {
  const service = requireMatch('keychain_service', reference?.keychainService, KEYCHAIN_REF);
  const account = requireMatch('keychain_account', reference?.keychainAccount, KEYCHAIN_REF);
  const runner = options.runSecretCommand ?? secretCommand;
  const platform = options.platform ?? process.platform;
  let result;
  if (platform === 'darwin') {
    result = await runner('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { timeoutMs: 8_000 });
  } else if (platform === 'win32') {
    const helper = fileURLToPath(new URL('../tools/platform/slack/Invoke-WindowsSlackSecretStore.ps1', import.meta.url));
    result = await runner(options.pwshExecutable ?? resolveWindowsPwsh(), [
      '-NoProfile', '-NonInteractive', '-File', helper,
      '-Action', 'Read', '-Service', service, '-Account', account
    ], { timeoutMs: 30_000 });
  } else {
    throw new SlackBotTransportError('supported_os_secret_store_required');
  }
  if (!result.ok) throw new SlackBotTransportError('slack_bot_token_unavailable');
  return validateBotToken(result.stdout);
}

export async function storeSlackBotToken(reference, tokenValue, options = {}) {
  const service = requireMatch('keychain_service', reference?.keychainService, KEYCHAIN_REF);
  const account = requireMatch('keychain_account', reference?.keychainAccount, KEYCHAIN_REF);
  const token = validateBotToken(tokenValue);
  const runner = options.runSecretCommand ?? secretCommand;
  const platform = options.platform ?? process.platform;
  let executable;
  let args;
  let timeoutMs;
  let backend;
  if (platform === 'darwin') {
    const helper = fileURLToPath(new URL('../tools/platform/slack/store-bot-token.swift', import.meta.url));
    executable = '/usr/bin/swift';
    args = [helper, service, account];
    timeoutMs = 30_000;
    backend = 'macos_keychain';
  } else if (platform === 'win32') {
    const helper = fileURLToPath(new URL('../tools/platform/slack/Invoke-WindowsSlackSecretStore.ps1', import.meta.url));
    executable = options.pwshExecutable ?? resolveWindowsPwsh();
    args = [
      '-NoProfile', '-NonInteractive', '-File', helper,
      '-Action', 'Store', '-Service', service, '-Account', account
    ];
    timeoutMs = 12_000;
    backend = 'windows_credential_manager';
  } else {
    throw new SlackBotTransportError('supported_os_secret_store_required');
  }
  const result = await runner(executable, args, { input: `${token}\n`, timeoutMs });
  if (!result.ok) throw new SlackBotTransportError('slack_bot_token_store_failed');
  return { ok: true, backend, keychainService: service, keychainAccount: account };
}

// Compatibility aliases retain the owner-local config field names while the
// runtime selects the native secret store for the current operating system.
export const readSlackBotTokenFromKeychain = readSlackBotToken;
export const storeSlackBotTokenInKeychain = storeSlackBotToken;

function safeSlackError(value) {
  const code = String(value ?? '').trim();
  return /^[a-z0-9_]{2,80}$/.test(code) ? code : 'unknown_error';
}

async function slackCall(method, payload, token, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response;
  try {
    response = await fetchImpl(`${options.apiRoot ?? SLACK_API_ROOT}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000)
    });
  } catch {
    throw new SlackBotTransportError('slack_network_failed');
  }
  if (response.status === 429) {
    const retryAfterSeconds = Number.parseInt(response.headers?.get?.('retry-after') ?? '', 10);
    throw new SlackBotTransportError('slack_rate_limited', {
      retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null
    });
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new SlackBotTransportError('slack_invalid_response');
  }
  if (!response.ok || body?.ok !== true) {
    throw new SlackBotTransportError(`slack_${method.replaceAll('.', '_')}_failed`, { slackError: safeSlackError(body?.error) });
  }
  return body;
}

export async function inspectSlackBotIdentity(reference, expectedTeamId, options = {}) {
  const teamId = requireMatch('team_id', expectedTeamId, ID_PATTERNS.teamId);
  const tokenProvider = options.tokenProvider ?? (ref => readSlackBotToken(ref, options));
  const token = validateBotToken(await tokenProvider(reference));
  const result = await slackCall('auth.test', {}, token, options);
  if (result.team_id !== teamId) throw new SlackBotTransportError('slack_team_identity_mismatch');
  return {
    ok: true,
    teamId,
    botUserId: requireMatch('bot_user_id', result.user_id, ID_PATTERNS.botUserId),
    botId: requireMatch('bot_id', result.bot_id, ID_PATTERNS.botId)
  };
}

function atomicPrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function deliveryFile(root, eventId) {
  const digest = crypto.createHash('sha256').update(eventId).digest('hex');
  return { record: path.join(root, `${digest}.json`), lock: path.join(root, `${digest}.lock`) };
}

function messageHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deterministicClientMessageId(eventId) {
  const bytes = Buffer.from(crypto.createHash('sha256').update(`aicc-slack:${eventId}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readExistingDelivery(file, eventId) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value.eventId === eventId ? value : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquireDeliveryLock(paths, eventId, expectedMessageHash, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = Math.max(30_000, Number(options.lockStaleAfterMs ?? 120_000));
  const isAlive = options.processIsAlive ?? processIsAlive;
  const create = () => {
    fs.mkdirSync(paths.lock, { mode: 0o700 });
    atomicPrivateJson(path.join(paths.lock, 'owner.json'), {
      schemaVersion: 1,
      eventId,
      messageHash: expectedMessageHash,
      pid: process.pid,
      acquiredAt: new Date(nowMs).toISOString()
    });
  };
  try {
    create();
    return;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(paths.lock);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SlackBotTransportError('slack_delivery_lock_unsafe');
  let owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(paths.lock, 'owner.json'), 'utf8'));
  } catch {
    owner = null;
  }
  const ownerPid = Number(owner?.pid);
  const lockAgeMs = Math.max(0, nowMs - stat.mtimeMs);
  if (lockAgeMs < staleAfterMs || isAlive(ownerPid)) {
    throw new SlackBotTransportError('slack_delivery_in_progress');
  }
  fs.rmSync(paths.lock, { recursive: true, force: true });
  create();
}

export function createSlackBotTransport(options = {}) {
  const config = validateSlackBotConfig(options.config);
  const stateRoot = options.deliveryStateRoot ?? path.join(path.dirname(defaultSlackBotConfigPath(options)), 'slack-deliveries');
  const tokenProvider = options.tokenProvider ?? (ref => readSlackBotToken(ref, options));
  const now = options.now ?? (() => new Date());
  const verify = async () => {
    const identity = await inspectSlackBotIdentity(config, config.teamId, { ...options, tokenProvider });
    if (identity.botUserId !== config.botUserId || identity.botId !== config.botId) {
      throw new SlackBotTransportError('slack_bot_identity_mismatch');
    }
    return identity;
  };

  return Object.freeze({
    config,
    verify,
    async send({ eventId, message, responseRequest }) {
      const normalizedEventId = String(eventId ?? '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(normalizedEventId)) {
        throw new SlackBotTransportError('invalid_notification_event_id');
      }
      const normalizedMessage = String(message ?? '').trim();
      if (!normalizedMessage || normalizedMessage.length > 3_000) throw new SlackBotTransportError('invalid_slack_message');
      const blocks = responseRequest ? responseBlocks(responseRequest) : undefined;
      const expectedMessageHash = messageHash(blocks ? JSON.stringify({ message: normalizedMessage, blocks }) : normalizedMessage);
      const paths = deliveryFile(stateRoot, normalizedEventId);
      const existing = readExistingDelivery(paths.record, normalizedEventId);
      if (existing) {
        if (existing.messageHash && existing.messageHash !== expectedMessageHash) {
          throw new SlackBotTransportError('slack_delivery_idempotency_conflict');
        }
        return { ok: true, state: 'duplicate', ...existing };
      }
      fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      acquireDeliveryLock(paths, normalizedEventId, expectedMessageHash, options);
      try {
        const raced = readExistingDelivery(paths.record, normalizedEventId);
        if (raced) {
          if (raced.messageHash && raced.messageHash !== expectedMessageHash) {
            throw new SlackBotTransportError('slack_delivery_idempotency_conflict');
          }
          return { ok: true, state: 'duplicate', ...raced };
        }
        // Bind verification and delivery to one native secret read. Never retain
        // the credential across sends or skip the current identity check.
        const token = validateBotToken(await tokenProvider(config));
        const identity = await inspectSlackBotIdentity(config, config.teamId, { ...options, tokenProvider: async () => token });
        if (identity.botUserId !== config.botUserId || identity.botId !== config.botId) {
          throw new SlackBotTransportError('slack_bot_identity_mismatch');
        }
        const response = await slackCall('chat.postMessage', {
          channel: config.recipientUserId,
          text: normalizedMessage,
          ...(blocks ? { blocks } : {}),
          client_msg_id: deterministicClientMessageId(normalizedEventId),
          unfurl_links: false,
          unfurl_media: false
        }, token, options);
        const channelId = requireMatch('delivery_channel_id', response.channel, /^D[A-Z0-9]{8,}$/);
        const messageTs = requireMatch('message_ts', response.ts, /^\d{8,}\.\d+$/);
        if (response.message?.user !== config.botUserId || response.message?.bot_id !== config.botId || response.message?.app_id !== config.appId) {
          throw new SlackBotTransportError('slack_delivery_identity_mismatch');
        }
        const record = {
          eventId: normalizedEventId,
          teamId: config.teamId,
          recipientUserId: config.recipientUserId,
          appId: config.appId,
          botUserId: identity.botUserId,
          botId: identity.botId,
          channelId,
          messageTs,
          messageHash: expectedMessageHash,
          sentAt: now().toISOString()
        };
        atomicPrivateJson(paths.record, record);
        return { ok: true, state: 'sent', ...record };
      } finally {
        fs.rmSync(paths.lock, { recursive: true, force: true });
      }
    }
  });
}
