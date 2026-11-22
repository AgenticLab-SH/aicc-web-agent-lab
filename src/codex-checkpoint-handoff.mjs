// Plain checkpoint continuation for the existing OCX CLI launcher. No history replay.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { writeCheckpointDraft, OCX_PROVIDERS } from './codex-checkpoint-stop.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const pinPattern = /^[a-f0-9]{64}$/;
function exclusive(file, value) {
  if (!path.isAbsolute(file ?? '')) throw Error('Absolute owner artifact path required');
  for (let current = path.dirname(file);; current = path.dirname(current)) {
    const item = fs.lstatSync(current);
    if (!item.isDirectory() || item.isSymbolicLink()) throw Error('Regular owner artifact directory required');
    if (current === path.dirname(current)) break;
  }
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, value); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}
function readRegular(file, limit = 64 * 1024) {
  if (!path.isAbsolute(file ?? '')) throw Error('Absolute owner checkpoint path required');
  for (let current = path.resolve(file);; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw Error('Linked checkpoint path refused');
    if (current === path.dirname(current)) break;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > limit) throw Error('Bounded regular checkpoint file required');
  return fs.readFileSync(file);
}
function plain(value, maximum = 16000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /\0/.test(value)
    || /(?:gAAAAA[A-Za-z0-9_-]{32,}|\b(?:resp|file|conv)_[A-Za-z0-9_-]{12,}|encrypted_content|previous_response_id|access_token|refresh_token)/i.test(value))
    throw Error('Plain work summary required; account-scoped carriers must stay with the original issuer');
  return value;
}
function plainList(value, max = 32) {
  if (!Array.isArray(value) || value.length > max) throw Error('Bounded checkpoint list required');
  return value.map(item => plain(item, 4000));
}
function readPinned(pin) {
  if (!pinPattern.test(pin?.sha256 ?? '')) throw Error('Exact artifact SHA256 required');
  const bytes = readRegular(pin.path);
  if (digest(bytes) !== pin.sha256) throw Error('Owner artifact changed');
  return bytes;
}
function artifactPaths(file, operationId) {
  const prefix = path.join(path.dirname(file), operationId);
  return { attemptPath: prefix + '.launch-attempt.json', resultPath: prefix + '.launch-result.json',
    ackPath: prefix + '.thread-ack.json', transferPath: prefix + '.writer-transfer.json',
    adoptionPath: prefix + '.result-adoption.json' };
}
function writerRecord(bytes, sourceThreadId) {
  const record = JSON.parse(bytes.toString('utf8'));
  if (record.schemaVersion !== 1 || record.owner !== sourceThreadId
    || !Array.isArray(record.ownedRoots) || !record.ownedRoots.length || record.ownedRoots.length > 16
    || record.ownedRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root)))
    throw Error('Exact canonical source writer and owned roots required');
  return record;
}
export function prepareCheckpointHandoff(file, now = Date.now()) {
  const bytes = readRegular(file), checkpoint = JSON.parse(bytes.toString('utf8'));
  if (checkpoint.schemaVersion !== 1 || checkpoint.kind !== 'ocx-plain-checkpoint'
    || !uuid(checkpoint.operationId) || !uuid(checkpoint.sourceThreadId)
    || !['automatic', 'preferred', 'strict'].includes(checkpoint.mode)) throw Error('Exact OCX checkpoint contract required');
  if (checkpoint.mode === 'strict') throw Error('Strict account mode must wait for its reset; handoff refused');
  if (!Number.isFinite(checkpoint.expiresAt) || checkpoint.expiresAt <= now || checkpoint.expiresAt > now + 300000)
    throw Error('Fresh checkpoint required');
  if (!path.isAbsolute(checkpoint.cwd ?? '') || !fs.statSync(checkpoint.cwd).isDirectory()) throw Error('Original workspace required');
  if (typeof checkpoint.model !== 'string' || !/^gpt-[\w.-]+$/.test(checkpoint.model)) throw Error('Unqualified OCX model required');
  const stopPin = checkpoint.stopReceipt;
  if (!/^[a-f0-9]{64}$/.test(stopPin?.sha256 ?? '')) throw Error('Pinned original stop receipt required');
  const stopBytes = readRegular(stopPin.path);
  if (digest(stopBytes) !== stopPin.sha256) throw Error('Original stop receipt changed');
  const stop = JSON.parse(stopBytes.toString('utf8'));
  if (stop.schemaVersion !== 1 || stop.kind !== 'codex-checkpoint-stop'
    || stop.operationId !== checkpoint.operationId || stop.threadId !== checkpoint.sourceThreadId
    || stop.normalExit !== true || stop.writerReleased !== true || stop.activeCount !== 0 || stop.unknownCount !== 0
    || !Number.isInteger(stop.pid) || stop.pid <= 0
    || !Number.isFinite(stop.observedAt) || now - stop.observedAt < 0 || now - stop.observedAt > 60000
    || !Array.isArray(stop.effects) || stop.effects.some(effect => !effect?.operationId || !['completed', 'not_dispatched'].includes(effect.state)))
    throw Error('Fresh normal exit, writer release, exact idle and reconciled effects required');
  try { process.kill(stop.pid, 0); throw Error('Original CLI process is still alive'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  writerRecord(readPinned(checkpoint.writerRecord), checkpoint.sourceThreadId);
  const completed = plainList(checkpoint.completed), remaining = plainList(checkpoint.remaining), constraints = plainList(checkpoint.constraints);
  if (!remaining.length) throw Error('Remaining work required; completed work is not replayed');
  const references = plainList(checkpoint.references);
  const prompt = ['Continue this owner-approved G1 work from a plain checkpoint.',
    'Original thread: ' + checkpoint.sourceThreadId,
    'Keep prior effects and conversations. Do not replay original requests, fork, resume, or import account-scoped history.',
    'Before any source write, use the installed aicc codex checkpoint acknowledge --session-log ABSOLUTE_CURRENT_ROLLOUT --json.',
    'Its inherited attempt binding and actual CODEX_THREAD_ID must match. Save the exact ACK first; acquire the pinned canonical writer next.',
    'If acknowledgement or writer transfer fails, preserve all artifacts and HOLD. Do not recreate or retry the attempt.',
    'After WRITER_TRANSFERRED_RESULT_PENDING, update the existing project current/task/execution records with your exact thread and inherited installed receipts.',
    'Return an ocx-checkpoint-work-result receipt for this operation and your exact thread. New thread creation is not result adoption.',
    'Goal: ' + plain(checkpoint.goal), 'Completed:\n' + completed.join('\n'),
    'Remaining work:\n' + remaining.join('\n'), 'Constraints:\n' + constraints.join('\n'),
    'Canonical references:\n' + references.join('\n')].join('\n\n');
  if (checkpoint.mode === 'preferred' && !/^[1-9][0-9]?$/.test(String(checkpoint.preferredAccount ?? '')))
    throw Error('Preferred mode requires the registered account number');
  return { checkpoint, prompt, file: path.resolve(file), sha256: digest(bytes), stopPin,
    ...artifactPaths(file, checkpoint.operationId) };
}
export function claimCheckpointHandoff(prepared) {
  // Recheck inputs immediately before the one-way intent; never reopen an existing attempt.
  if (Date.now() >= prepared.checkpoint.expiresAt || digest(readRegular(prepared.file)) !== prepared.sha256
    || digest(readRegular(prepared.stopPin.path)) !== prepared.stopPin.sha256) throw Error('Checkpoint changed or expired');
  writerRecord(readPinned(prepared.checkpoint.writerRecord), prepared.checkpoint.sourceThreadId);
  exclusive(prepared.attemptPath, encode({ schemaVersion: 1, kind: 'ocx-checkpoint-launch',
    operationId: prepared.checkpoint.operationId, sourceThreadId: prepared.checkpoint.sourceThreadId,
    checkpointPath: prepared.file, checkpointSha256: prepared.sha256, state: 'DISPATCHING', observedAt: Date.now(),
    result: 'UNKNOWN_UNTIL_ORIGINAL_RECEIPT', automaticRetry: false }));
}
export function finishCheckpointHandoff(prepared, exitCode) {
  if (!Number.isInteger(exitCode)) throw Error('Exact CLI exit code required');
  exclusive(prepared.resultPath, encode({ schemaVersion: 1, operationId: prepared.checkpoint.operationId,
    sourceThreadId: prepared.checkpoint.sourceThreadId, state: 'CLI_EXITED_NOT_ADOPTED', exitCode,
    newThreadId: null, issuer: 'UNKNOWN', acknowledgementPath: prepared.ackPath,
    writerTransferPath: prepared.transferPath, resultAdoption: 'PENDING_EXACT_THREAD_RECEIPT', automaticRetry: false }));
}

// Post-dispatch reads bind the original durable attempt; expired launch inputs are never relaunched.
function dispatchedCheckpoint(attemptFile) {
  const attemptBytes = readRegular(attemptFile), attempt = JSON.parse(attemptBytes.toString('utf8'));
  if (attempt.schemaVersion !== 1 || attempt.kind !== 'ocx-checkpoint-launch' || attempt.state !== 'DISPATCHING'
    || !uuid(attempt.operationId) || !uuid(attempt.sourceThreadId) || !Number.isFinite(attempt.observedAt)
    || attempt.automaticRetry !== false) throw Error('Original one-shot launch attempt required');
  const checkpointPin = { path: attempt.checkpointPath, sha256: attempt.checkpointSha256 };
  const checkpoint = JSON.parse(readPinned(checkpointPin).toString('utf8'));
  const paths = artifactPaths(checkpointPin.path, attempt.operationId);
  if (path.resolve(attemptFile) !== paths.attemptPath || checkpoint.schemaVersion !== 1
    || checkpoint.kind !== 'ocx-plain-checkpoint' || checkpoint.operationId !== attempt.operationId
    || checkpoint.sourceThreadId !== attempt.sourceThreadId || !['automatic', 'preferred'].includes(checkpoint.mode))
    throw Error('Checkpoint and original launch binding differ');
  const stop = JSON.parse(readPinned(checkpoint.stopReceipt).toString('utf8'));
  if (stop.kind !== 'codex-checkpoint-stop' || stop.operationId !== attempt.operationId
    || stop.threadId !== attempt.sourceThreadId || stop.normalExit !== true || stop.writerReleased !== true
    || stop.activeCount !== 0 || stop.unknownCount !== 0) throw Error('Original stop evidence differs');
  const attemptPin = { path: paths.attemptPath, sha256: digest(attemptBytes) };
  return { attempt, attemptPin, checkpoint, inputPins: [attemptPin, checkpointPin, checkpoint.stopReceipt], ...paths };
}
function currentThreadIdentity(file, context, environment) {
  const threadId = environment.CODEX_THREAD_ID;
  if (!uuid(threadId) || threadId === context.checkpoint.sourceThreadId || !path.isAbsolute(file ?? ''))
    throw Error('Actual new CODEX_THREAD_ID and current rollout required');
  // Only parse the bounded header. Never copy prompt/tool bodies or search another conversation.
  const sessions = path.resolve(environment.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'), 'sessions');
  const relative = path.relative(sessions, path.resolve(file));
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw Error('Rollout must belong to the current shared HOME sessions root');
  if (!path.basename(file).endsWith('-' + threadId + '.jsonl')) throw Error('Current rollout filename differs');
  for (let current = path.resolve(file);; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw Error('Linked rollout path refused');
    if (current === path.dirname(current)) break;
  }
  const descriptor = fs.openSync(file, 'r'), header = Buffer.alloc(1024 * 1024);
  let count;
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw Error('Regular current rollout required');
    count = fs.readSync(descriptor, header, 0, header.length, 0);
  } finally { fs.closeSync(descriptor); }
  const text = header.subarray(0, count).toString('utf8'), end = text.lastIndexOf('\n');
  if (end < 0) throw Error('Complete rollout metadata line required');
  const lines = text.slice(0, end).split('\n');
  const first = JSON.parse(lines[0]);
  const meta = first.type === 'session_meta' ? first.payload : null;
  // The handoff child is launched by the compat launcher, whose process-only provider id
  // is "aicc-ocx-compat"; shared-HOME launches record "opencodex" now and "aicc-ocx" after r2 (G1-06).
  if (!meta || meta.id !== threadId || !OCX_PROVIDERS.has(meta.model_provider) || meta.source !== 'cli'
    || path.resolve(meta.cwd ?? '') !== path.resolve(context.checkpoint.cwd)
    || !Number.isFinite(Date.parse(meta.timestamp)) || Date.parse(meta.timestamp) < context.attempt.observedAt)
    throw Error('Actual new OCX CLI metadata does not match the original attempt');
  let turn;
  for (const line of lines.slice(1)) {
    const event = JSON.parse(line);
    if (event.type === 'turn_context') { turn = event.payload; break; }
  }
  const baseModel = typeof turn?.model === 'string' && context.checkpoint.mode === 'preferred'
    ? turn.model.replace(/^preferred-p[0-9a-f]{6}\//, '') : turn?.model;
  if (!turn || baseModel !== context.checkpoint.model || turn.approval_policy !== 'on-request')
    throw Error('Exact current model and approval context required');
  return { threadId, provider: meta.model_provider, model: turn.model, effort: turn.effort ?? 'UNKNOWN',
    endpoint: 'UNKNOWN', issuer: 'UNKNOWN', metadataTimestamp: meta.timestamp };
}
function updateWriter(context, beforeBytes, next, phase, extraPins = []) {
  const file = context.checkpoint.writerRecord.path, lockFile = file + '.lock';
  const prefix = path.join(path.dirname(context.attemptPath), context.attempt.operationId + '.' + phase);
  const lock = fs.openSync(lockFile, 'wx', 0o600);
  let completed = false;
  try {
    [...context.inputPins, ...extraPins].forEach(readPinned);
    if (digest(readRegular(file)) !== digest(beforeBytes)) throw Error('Canonical writer CAS changed');
    const afterBytes = encode(next), temporary = prefix + '.writer-next.json';
    exclusive(prefix + '.writer-before.json', beforeBytes);
    exclusive(prefix + '.intent.json', encode({ schemaVersion: 1, operationId: context.attempt.operationId,
      phase, target: file, beforeSha256: digest(beforeBytes), afterSha256: digest(afterBytes), automaticRetry: false }));
    // Target-local rename keeps replacement on the same volume as the canonical record.
    const targetTemporary = file + '.' + context.attempt.operationId + '.' + phase + '.tmp';
    exclusive(temporary, afterBytes);
    exclusive(targetTemporary, afterBytes);
    [...context.inputPins, ...extraPins].forEach(readPinned);
    if (digest(readRegular(file)) !== digest(beforeBytes)) throw Error('Canonical writer CAS changed before transfer');
    fs.renameSync(targetTemporary, file);
    completed = true;
    return { path: file, beforeSha256: digest(beforeBytes), afterSha256: digest(afterBytes) };
  } finally {
    fs.closeSync(lock);
    // On any uncertainty retain the lock, intent and original preimage for exact reconciliation.
    if (completed) fs.unlinkSync(lockFile);
  }
}
export function acknowledgeCheckpointHandoff(sessionLog, environment = process.env) {
  const context = dispatchedCheckpoint(environment.AICC_CODEX_CHECKPOINT_ATTEMPT);
  const identity = currentThreadIdentity(sessionLog, context, environment);
  const beforeBytes = readPinned(context.checkpoint.writerRecord);
  const previous = writerRecord(beforeBytes, context.checkpoint.sourceThreadId);
  exclusive(context.ackPath, encode({ schemaVersion: 1, kind: 'ocx-checkpoint-thread-ack',
    operationId: context.attempt.operationId, sourceThreadId: previous.owner, ...identity,
    state: 'THREAD_ACKNOWLEDGED_WRITER_PENDING', observedAt: Date.now(), attempt: context.attemptPin, automaticRetry: false }));
  const next = { ...previous, previousOwner: previous.owner, owner: identity.threadId, nextWriter: identity.threadId,
    stage: 'CHECKPOINT_WRITER_ACCEPTED_RESULT_PENDING', at: new Date().toISOString(),
    checkpointHandoff: { operationId: context.attempt.operationId, sourceThreadId: previous.owner,
      acknowledgementPath: context.ackPath, resultAdoption: 'PENDING' } };
  const ackPin = { path: context.ackPath, sha256: digest(readRegular(context.ackPath)) };
  const writer = updateWriter(context, beforeBytes, next, 'transfer', [ackPin]);
  const receipt = { schemaVersion: 1, kind: 'ocx-checkpoint-writer-transfer', operationId: context.attempt.operationId,
    sourceThreadId: previous.owner, threadId: identity.threadId, state: 'WRITER_TRANSFERRED_RESULT_PENDING',
    writer, ownedRoots: previous.ownedRoots, acknowledgementSha256: ackPin.sha256, automaticRetry: false };
  exclusive(context.transferPath, encode(receipt));
  return { state: receipt.state, threadId: identity.threadId, acknowledgementPath: context.ackPath,
    writerTransferPath: context.transferPath, issuer: 'UNKNOWN', automaticRetry: false };
}
export function adoptCheckpointHandoff(checkpointFile, resultPin) {
  const checkpoint = JSON.parse(readRegular(checkpointFile).toString('utf8'));
  if (!uuid(checkpoint.operationId)) throw Error('Exact checkpoint operation required');
  const context = dispatchedCheckpoint(artifactPaths(checkpointFile, checkpoint.operationId).attemptPath);
  if (path.resolve(checkpointFile) !== path.resolve(context.attempt.checkpointPath)) throw Error('Original checkpoint path differs');
  const ackBytes = readRegular(context.ackPath), ack = JSON.parse(ackBytes.toString('utf8'));
  const transferBytes = readRegular(context.transferPath), transfer = JSON.parse(transferBytes.toString('utf8'));
  const exitBytes = readRegular(context.resultPath), exit = JSON.parse(exitBytes.toString('utf8'));
  const work = JSON.parse(readPinned(resultPin).toString('utf8'));
  if (ack.kind !== 'ocx-checkpoint-thread-ack' || ack.operationId !== context.attempt.operationId || !uuid(ack.threadId)
    || ack.sourceThreadId !== context.checkpoint.sourceThreadId || ack.threadId === ack.sourceThreadId
    || ack.attempt?.sha256 !== context.attemptPin.sha256 || ack.attempt?.path !== context.attemptPath
    || transfer.kind !== 'ocx-checkpoint-writer-transfer' || transfer.operationId !== ack.operationId
    || transfer.threadId !== ack.threadId || transfer.sourceThreadId !== ack.sourceThreadId
    || transfer.acknowledgementSha256 !== digest(ackBytes) || transfer.state !== 'WRITER_TRANSFERRED_RESULT_PENDING'
    || exit.operationId !== ack.operationId || exit.sourceThreadId !== ack.sourceThreadId || exit.exitCode !== 0
    || exit.state !== 'CLI_EXITED_NOT_ADOPTED' || work.schemaVersion !== 1 || work.kind !== 'ocx-checkpoint-work-result'
    || work.operationId !== ack.operationId || work.ownerThreadId !== ack.threadId
    || !['SOURCE_COMPLETED', 'PARTIAL', 'HOLD'].includes(work.state)
    || !['NOT_RUN', 'USER_REQUESTED'].includes(work.verification)) throw Error('Exact ACK, writer transfer, successful CLI exit and work result required');
  const completed = plainList(work.completed), remaining = plainList(work.remaining), references = plainList(work.references);
  if (work.state === 'SOURCE_COMPLETED' && remaining.length) throw Error('Completed source result still has remaining work');
  const beforeBytes = readRegular(context.checkpoint.writerRecord.path), owner = writerRecord(beforeBytes, ack.threadId);
  if (owner.checkpointHandoff?.operationId !== ack.operationId || owner.checkpointHandoff.sourceThreadId !== ack.sourceThreadId
    || JSON.stringify(owner.ownedRoots) !== JSON.stringify(transfer.ownedRoots)) throw Error('Canonical writer has changed; no result adoption');
  const state = work.state === 'SOURCE_COMPLETED' ? 'SOURCE_RESULT_ADOPTED' : 'PARTIAL_RESULT_ADOPTED';
  const next = { ...owner, currentResult: resultPin.path, stage: state, at: new Date().toISOString(),
    checkpointHandoff: { ...owner.checkpointHandoff, resultAdoption: state, adoptionPath: context.adoptionPath } };
  const writer = updateWriter(context, beforeBytes, next, 'adoption', [resultPin,
    { path: context.ackPath, sha256: digest(ackBytes) }, { path: context.transferPath, sha256: digest(transferBytes) },
    { path: context.resultPath, sha256: digest(exitBytes) }]);
  const receipt = { schemaVersion: 1, kind: 'ocx-checkpoint-result-adoption', operationId: ack.operationId,
    sourceThreadId: ack.sourceThreadId, threadId: ack.threadId, state, workState: work.state,
    result: resultPin, verification: work.verification, completed, remaining, references, writer,
    acknowledgementSha256: digest(ackBytes), transferSha256: digest(transferBytes),
    installedOrLiveAcceptance: 'NOT_INFERRED', originalRequestsReplayed: false, automaticRetry: false };
  exclusive(context.adoptionPath, encode(receipt));
  return receipt;
}
export function runCheckpointHandoffCommand(args, environment = process.env) {
  const [action, ...rest] = args, options = new Map();
  const allowed = action === 'acknowledge' ? ['--session-log'] : action === 'adopt' ? ['--checkpoint', '--result', '--sha256']
    : action === 'draft' ? ['--input'] : [];
  if (!allowed.length) throw Error('Use checkpoint draft, acknowledge or adopt; none launches a model request');
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--json') continue;
    if (!allowed.includes(rest[i]) || options.has(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith('--'))
      throw Error('Exact checkpoint command options required');
    const key = rest[i];
    options.set(key, rest[++i]);
  }
  if (allowed.some(key => !options.has(key))) throw Error('Missing checkpoint command option');
  if (action === 'draft') return writeCheckpointDraft(options.get('--input'), environment);
  return action === 'acknowledge' ? acknowledgeCheckpointHandoff(options.get('--session-log'), environment)
    : adoptCheckpointHandoff(options.get('--checkpoint'), { path: options.get('--result'), sha256: options.get('--sha256') });
}
