#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MAX_HOOK_INPUT_BYTES = 32 * 1024;
export const MAX_SESSION_ID_LENGTH = 160;

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const defaultAiccBin = path.join(sourceRoot, 'bin', 'aicc');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeIdentifier(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value);
}

function assertOwnerOnlyRegularFile(file, unavailableCode) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(unavailableCode);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${unavailableCode}_unsafe_path`);
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0) throw new Error(`${unavailableCode}_unsafe_permissions`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`${unavailableCode}_unsafe_owner`);
    }
  }
  return stat;
}

export function defaultSessionBindingPath(options = {}) {
  const stateRoot = options.stateRoot
    ?? process.env.AICC_STATE_ROOT?.trim()
    ?? path.join(options.home ?? os.homedir(), '.ai-control-center');
  return path.join(stateRoot, 'notifications', 'codex-session-bindings.json');
}

export function parseUserPromptSubmit(raw, options = {}) {
  const maxBytes = options.maxInputBytes ?? MAX_HOOK_INPUT_BYTES;
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
  if (bytes.length === 0 || bytes.length > maxBytes) return null;
  let event;
  try {
    event = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(event) || event.hook_event_name !== 'UserPromptSubmit') return null;
  if (!isSafeIdentifier(event.session_id, MAX_SESSION_ID_LENGTH)) return null;
  return Object.freeze({ sessionId: event.session_id });
}

function normalizeBinding(value, nowMs) {
  if (!isPlainObject(value)) return null;
  if (!isSafeIdentifier(value.projectKey, 160) || !isSafeIdentifier(value.taskId, 200)) return null;
  if (value.eventId != null && !isSafeIdentifier(value.eventId, 240)) return null;
  if (value.expiresAt != null) {
    const expiry = Date.parse(value.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= nowMs) return null;
  }
  return Object.freeze({
    projectKey: value.projectKey,
    taskId: value.taskId,
    ...(value.eventId == null ? {} : { eventId: value.eventId })
  });
}

export function loadSessionBinding(sessionId, options = {}) {
  const file = options.bindingPath ?? defaultSessionBindingPath(options);
  const stat = assertOwnerOnlyRegularFile(file, 'session_binding_unavailable');
  if (!stat) return null;
  let document;
  try {
    document = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(document) || document.schemaVersion !== 1 || !isPlainObject(document.bindings)) return null;
  if (!Object.prototype.hasOwnProperty.call(document.bindings, sessionId)) return null;
  return normalizeBinding(document.bindings[sessionId], options.now?.() ?? Date.now());
}

export function runAckSubprocess(binding, options = {}) {
  const useNodeLauncher = process.platform === 'win32' && options.aiccBin == null;
  const executable = useNodeLauncher ? (options.nodeBinary ?? process.execPath) : (options.aiccBin ?? defaultAiccBin);
  const argv = useNodeLauncher ? [defaultAiccBin, 'notify', 'ack'] : ['notify', 'ack'];
  const input = `${JSON.stringify(binding)}\n`;
  const run = options.spawnSync ?? spawnSync;
  const result = run(executable, argv, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 3_000,
    windowsHide: true,
    env: options.env ?? process.env
  });
  return Object.freeze({
    ok: result.status === 0 && !result.error,
    status: result.status,
    errorCode: result.error?.code ?? null
  });
}

export async function acknowledgeUserPrompt(raw, options = {}) {
  const parsed = parseUserPromptSubmit(raw, options);
  if (!parsed) return Object.freeze({ ok: true, state: 'ignored', reason: 'invalid_or_irrelevant_event' });
  let binding;
  try {
    binding = (options.loadBinding ?? loadSessionBinding)(parsed.sessionId, options);
  } catch {
    return Object.freeze({ ok: true, state: 'ignored', reason: 'binding_unavailable' });
  }
  if (!binding) return Object.freeze({ ok: true, state: 'ignored', reason: 'no_binding' });
  let result;
  try {
    result = await (options.runAck ?? runAckSubprocess)(binding, options);
  } catch {
    return Object.freeze({ ok: true, state: 'ignored', reason: 'ack_unavailable' });
  }
  if (!result?.ok) return Object.freeze({ ok: true, state: 'ignored', reason: 'ack_unavailable' });
  return Object.freeze({ ok: true, state: 'acknowledged' });
}

export function readBoundedStdin(stream = process.stdin, maxBytes = MAX_HOOK_INPUT_BYTES) {
  return new Promise(resolve => {
    const chunks = [];
    let total = 0;
    let oversized = false;
    stream.on('data', chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      if (!oversized) chunks.push(bytes);
    });
    stream.on('end', () => resolve(oversized ? null : Buffer.concat(chunks)));
    stream.on('error', () => resolve(null));
  });
}

async function main() {
  const raw = await readBoundedStdin();
  if (raw) await acknowledgeUserPrompt(raw);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch(() => {}).finally(() => {
    process.exitCode = 0;
  });
}
