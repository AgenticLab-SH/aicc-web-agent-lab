// G1-06 producer for the existing plain-checkpoint consumer (codex-checkpoint-handoff.mjs).
// The launcher that spawned the original CLI is the only writer of the stop receipt:
// it alone observed the real exit code and PID. This module never synthesizes a
// receipt from documents, never reads prompt/tool bodies and never sends a model request.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
// opencodex: current shared HOME; aicc-ocx: r2 shared HOME (Prepare-CodexSharedHome.ps1);
// aicc-ocx-compat: process-only provider of the aicc codex ocx launcher.
export const OCX_PROVIDERS = new Set(['opencodex', 'aicc-ocx', 'aicc-ocx-compat']);
const PLAIN_REFUSED = /(?:gAAAAA[A-Za-z0-9_-]{32,}|\b(?:resp|file|conv)_[A-Za-z0-9_-]{12,}|encrypted_content|previous_response_id|access_token|refresh_token)/i;

function regularDirectory(directory) {
  if (!path.isAbsolute(directory ?? '')) throw Error('Absolute checkpoint directory required');
  for (let current = path.resolve(directory);; current = path.dirname(current)) {
    const item = fs.lstatSync(current);
    if (!item.isDirectory() || item.isSymbolicLink()) throw Error('Regular checkpoint directory required');
    if (current === path.dirname(current)) break;
  }
  return path.resolve(directory);
}
function exclusive(file, bytes) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  return { path: file, sha256: digest(bytes) };
}
function readBounded(file, limit = 64 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw Error('Bounded regular file required');
  return fs.readFileSync(file);
}
function plain(value, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /\0/.test(value) || PLAIN_REFUSED.test(value))
    throw Error('Plain checkpoint text required; account-scoped carriers stay with the original issuer');
  return value;
}
function plainList(value, max = 32) {
  if (!Array.isArray(value) || value.length > max) throw Error('Bounded checkpoint list required');
  return value.map(item => plain(item, 4000));
}

export function sourceLaunchPaths(directory, operationId) {
  const prefix = path.join(directory, operationId);
  return { launchPath: prefix + '.source-launch.json', draftPath: prefix + '.draft.json',
    stopPath: prefix + '.stop.json', holdPath: prefix + '.stop-hold.json', checkpointPath: prefix + '.checkpoint.json' };
}

// Same key derivation as external-pool-state.ts threadKey() for the session header.
export function conversationFenceKey(threadId) {
  return createHash('sha256').update(String(threadId).trim()).digest('hex').slice(0, 32);
}

// G1-07: read only this conversation's rows. Other conversations' durable UNKNOWN
// rows are reported as globalUnknownCount and never gate this thread's checkpoint.
export function threadFenceState(threadId, options = {}) {
  const home = options.home ?? os.homedir();
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT ?? path.join(home, '.ai-control-center');
  try {
    const registry = JSON.parse(readBounded(path.join(stateRoot, 'runtime', 'ocx-local', 'current.json'), 262144).toString('utf8'));
    const expected = path.join(stateRoot, 'runtime', 'ocx-local', 'home');
    if (typeof registry.opencodexHome !== 'string' || path.resolve(registry.opencodexHome).toLowerCase() !== expected.toLowerCase())
      return { readOk: false, reason: 'registered_ocx_home_required' };
    const fenceFile = path.join(expected, 'external-request-lifecycle.json');
    // A thread that ran on OCX implies this file exists; absence is not proof of zero.
    const saved = JSON.parse(readBounded(fenceFile, 8 * 1024 * 1024).toString('utf8'));
    if (saved.schemaVersion !== 1 || !Array.isArray(saved.rows)) return { readOk: false, reason: 'fence_shape_invalid' };
    const key = conversationFenceKey(threadId);
    const mine = saved.rows.filter(row => row?.key === key);
    return { readOk: true, fenceFile, keySource: 'session-header-thread-id',
      activeCount: mine.filter(row => row.state === 'reserved' || row.state === 'dispatching').length,
      unknownCount: mine.filter(row => row.state === 'unknown').length,
      globalUnknownCount: saved.rows.filter(row => row?.state === 'unknown').length,
      effects: mine.map(row => ({ operationId: row.operationId, state: row.state })) };
  } catch (error) {
    return { readOk: false, reason: error?.code === 'ENOENT' ? 'fence_or_registry_absent' : 'fence_read_failed' };
  }
}

// Find the rollout this launcher's child created (or resumed). Ambiguity is UNKNOWN.
export function discoverLaunchedThread({ codexHome, cwd, startedAt, resumeThreadId, now = Date.now() }) {
  const root = path.join(codexHome, 'sessions');
  const days = new Set();
  for (let at = startedAt - 86_400_000; at <= now + 86_400_000; at += 86_400_000) {
    const date = new Date(at);
    days.add(path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')));
  }
  const found = [];
  for (const directory of days) {
    let names;
    try { names = fs.readdirSync(directory); } catch { continue; }
    for (const name of names) {
      const match = /^rollout-.*-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl$/i.exec(name);
      if (!match || (resumeThreadId && match[1].toLowerCase() !== resumeThreadId.toLowerCase())) continue;
      const file = path.join(directory, name);
      let stat;
      try { stat = fs.lstatSync(file); } catch { continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs < startedAt - 1000) continue;
      let meta;
      try {
        const descriptor = fs.openSync(file, 'r'), buffer = Buffer.alloc(256 * 1024);
        let count;
        try { count = fs.readSync(descriptor, buffer, 0, buffer.length, 0); } finally { fs.closeSync(descriptor); }
        const first = buffer.subarray(0, count).toString('utf8').split('\n', 1)[0];
        const event = JSON.parse(first);
        meta = event.type === 'session_meta' ? event.payload : null;
      } catch { continue; }
      // Shared-HOME launches record provider "opencodex"; the compat launcher records its
      // process-only provider id "aicc-ocx-compat" (codex-cli-routes.mjs).
      if (!meta || meta.id?.toLowerCase() !== match[1].toLowerCase() || !OCX_PROVIDERS.has(meta.model_provider)
        || path.resolve(meta.cwd ?? '').toLowerCase() !== path.resolve(cwd).toLowerCase()) continue;
      if (!resumeThreadId && !(Date.parse(meta.timestamp) >= startedAt - 5000)) continue;
      found.push({ threadId: match[1].toLowerCase(), file });
    }
  }
  return found.length === 1 ? { ok: true, ...found[0] } : { ok: false, reason: found.length ? 'rollout_ambiguous' : 'rollout_not_found' };
}

export function resumeThreadFromArgs(args = []) {
  const index = args.indexOf('resume');
  return index >= 0 && uuid(args[index + 1]) ? args[index + 1].toLowerCase() : null;
}

// Before spawn: create-once launch intent so a crash leaves evidence, never a retry.
export function claimSourceLaunch(directoryValue, { cwd, resumeThreadId = null } = {}) {
  const directory = regularDirectory(directoryValue);
  const operationId = randomUUID();
  const paths = sourceLaunchPaths(directory, operationId);
  const startedAt = Date.now();
  exclusive(paths.launchPath, encode({ schemaVersion: 1, kind: 'codex-checkpoint-source-launch', operationId,
    cwd: path.resolve(cwd), resumeThreadId, startedAt, state: 'SOURCE_CLI_RUNNING', automaticRetry: false }));
  return { operationId, directory, startedAt, cwd: path.resolve(cwd), resumeThreadId, ...paths };
}

// Validate the AI's plain summary and save it create-once to the launcher-provided path.
export function writeCheckpointDraft(inputFile, environment = process.env) {
  const target = environment.AICC_CODEX_CHECKPOINT_DRAFT;
  if (!path.isAbsolute(target ?? '') || !uuid(environment.AICC_CODEX_CHECKPOINT_OPERATION)
    || path.basename(target) !== environment.AICC_CODEX_CHECKPOINT_OPERATION + '.draft.json')
    throw Error('Run inside a launcher started with --checkpoint-dir');
  const draft = normalizeDraft(JSON.parse(readBounded(path.resolve(inputFile)).toString('utf8')));
  const pin = exclusive(target, encode(draft));
  return { state: 'CHECKPOINT_DRAFT_SAVED', ...pin, continueAfterExit: draft.continueAfterExit };
}
function normalizeDraft(draft) {
  if (draft?.schemaVersion !== 1 || draft.kind !== 'ocx-checkpoint-draft' || !['automatic', 'preferred', 'strict'].includes(draft.mode))
    throw Error('ocx-checkpoint-draft schemaVersion 1 with mode automatic|preferred|strict required');
  if (draft.mode === 'preferred' && !/^[1-9][0-9]?$/.test(String(draft.preferredAccount ?? ''))) throw Error('Preferred mode requires an account number');
  if (!path.isAbsolute(draft.writerRecord ?? '')) throw Error('Absolute canonical writer record path required');
  if (draft.model !== undefined && !/^gpt-[\w.-]+$/.test(draft.model)) throw Error('Unqualified OCX model required');
  const remaining = plainList(draft.remaining);
  if (!remaining.length) throw Error('Remaining work required; completed work is not replayed');
  return { schemaVersion: 1, kind: 'ocx-checkpoint-draft', mode: draft.mode,
    ...(draft.mode === 'preferred' ? { preferredAccount: String(draft.preferredAccount) } : {}),
    ...(draft.model ? { model: draft.model } : {}), writerRecord: path.resolve(draft.writerRecord),
    goal: plain(draft.goal, 16000), completed: plainList(draft.completed), remaining,
    constraints: plainList(draft.constraints), references: plainList(draft.references),
    continueAfterExit: draft.continueAfterExit === true };
}
function rolloutModel(file) {
  try {
    const descriptor = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
    let count;
    try { count = fs.readSync(descriptor, buffer, 0, buffer.length, 0); } finally { fs.closeSync(descriptor); }
    for (const line of buffer.subarray(0, count).toString('utf8').split('\n').slice(1)) {
      const event = JSON.parse(line);
      if (event.type === 'turn_context') return String(event.payload?.model ?? '').replace(/^(?:preferred-)?p[0-9a-f]{6}\//, '');
    }
  } catch { /* UNKNOWN */ }
  return null;
}

// After the child exits: stop receipt only for a real normal exit with this thread idle.
export function produceCheckpointAfterExit(launch, spawnResult, options = {}) {
  const now = options.now ?? Date.now;
  const holds = [];
  const exitCode = spawnResult?.status;
  if (spawnResult?.error || spawnResult?.signal || !Number.isInteger(exitCode)) holds.push('exit_unknown');
  else if (exitCode !== 0) holds.push('nonzero_exit');
  if (!Number.isInteger(spawnResult?.pid) || spawnResult.pid <= 0) holds.push('pid_unknown');
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const thread = discoverLaunchedThread({ codexHome, cwd: launch.cwd, startedAt: launch.startedAt, resumeThreadId: launch.resumeThreadId, now: now() });
  if (!thread.ok) holds.push(thread.reason);
  const fence = thread.ok ? threadFenceState(thread.threadId, options) : { readOk: false, reason: 'thread_unknown' };
  if (!fence.readOk) holds.push(fence.reason);
  else if (fence.activeCount || fence.unknownCount) holds.push(fence.unknownCount ? 'thread_unknown_outcome' : 'thread_request_active');
  const observedAt = now();
  // G1-08: a later terminal resume release proves the conversation did not change since this stop.
  let rollout = null;
  if (thread.ok) { try { const stat = fs.statSync(thread.file); rollout = { rolloutLength: stat.size, rolloutLastWriteMs: Math.floor(stat.mtimeMs) }; } catch { holds.push('rollout_stat_failed'); } }
  if (holds.length) {
    const pin = exclusive(launch.holdPath, encode({ schemaVersion: 1, kind: 'codex-checkpoint-stop-hold', operationId: launch.operationId,
      threadId: thread.ok ? thread.threadId : null, exitCode: Number.isInteger(exitCode) ? exitCode : null,
      holds, fence: fence.readOk ? { activeCount: fence.activeCount, unknownCount: fence.unknownCount,
        globalUnknownCount: fence.globalUnknownCount, effects: fence.effects } : { reason: fence.reason },
      observedAt, automaticRetry: false, originalRequestReplay: false }));
    return { state: 'STOP_HOLD', holds, hold: pin, threadId: thread.ok ? thread.threadId : null };
  }
  const stop = exclusive(launch.stopPath, encode({ schemaVersion: 1, kind: 'codex-checkpoint-stop', operationId: launch.operationId,
    threadId: thread.threadId, normalExit: true,
    // The original process has exited; the canonical writer record moves only at the new exact ACK.
    writerReleased: true, writerReleaseMeaning: 'source_process_exited',
    activeCount: 0, unknownCount: 0, unknownScope: 'this-conversation', globalUnknownCount: fence.globalUnknownCount,
    fenceKeySource: fence.keySource, pid: spawnResult.pid, exitCode, observedAt, rollout: thread.file, ...rollout,
    effects: [], automaticRetry: false }));
  let draftBytes;
  try { draftBytes = readBounded(launch.draftPath); } catch (error) {
    if (error.code === 'ENOENT') return { state: 'STOP_RECORDED_NO_DRAFT', stop, threadId: thread.threadId };
    throw error;
  }
  const draft = normalizeDraft(JSON.parse(draftBytes.toString('utf8')));
  if (draft.mode === 'strict') return { state: 'STOP_RECORDED_STRICT_WAITS_FOR_RESET', stop, threadId: thread.threadId };
  const model = draft.model ?? rolloutModel(thread.file);
  if (!model || !/^gpt-[\w.-]+$/.test(model)) return { state: 'STOP_RECORDED_MODEL_UNKNOWN', stop, threadId: thread.threadId };
  const writerBytes = readBounded(draft.writerRecord);
  const writer = JSON.parse(writerBytes.toString('utf8'));
  if (writer.owner !== thread.threadId) return { state: 'STOP_RECORDED_WRITER_OWNER_DIFFERS', stop, threadId: thread.threadId };
  const checkpoint = exclusive(launch.checkpointPath, encode({ schemaVersion: 1, kind: 'ocx-plain-checkpoint',
    operationId: launch.operationId, sourceThreadId: thread.threadId, mode: draft.mode,
    ...(draft.preferredAccount ? { preferredAccount: Number(draft.preferredAccount) } : {}),
    expiresAt: observedAt + 300_000, cwd: launch.cwd, model, goal: draft.goal, completed: draft.completed,
    remaining: draft.remaining, constraints: draft.constraints, references: draft.references,
    stopReceipt: stop, writerRecord: { path: draft.writerRecord, sha256: digest(writerBytes) } }));
  return { state: 'CHECKPOINT_READY', stop, checkpoint, threadId: thread.threadId, continueAfterExit: draft.continueAfterExit };
}
