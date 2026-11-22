// G1-06/G1-07 fixtures. Fake rollout, fake OCX fence and fake spawn results only;
// no Codex process, model request or owner state is touched. Written 2026-10-31, not run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { claimSourceLaunch, produceCheckpointAfterExit, conversationFenceKey, threadFenceState,
  resumeThreadFromArgs } from '../src/codex-checkpoint-stop.mjs';
import { prepareCheckpointHandoff } from '../src/codex-checkpoint-handoff.mjs';

const THREAD = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
function fixture({ rows = [], provider = 'aicc-ocx-compat', writerOwner = THREAD } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g1-stop-')));
  const codexHome = path.join(root, 'codex'), stateRoot = path.join(root, 'state'), work = path.join(root, 'work');
  const ocxHome = path.join(stateRoot, 'runtime', 'ocx-local', 'home');
  const operations = path.join(root, 'operations');
  for (const directory of [codexHome, ocxHome, work, operations]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'runtime', 'ocx-local', 'current.json'), JSON.stringify({ opencodexHome: ocxHome }));
  fs.writeFileSync(path.join(ocxHome, 'external-request-lifecycle.json'), JSON.stringify({ schemaVersion: 1, rows }));
  const writer = path.join(root, 'writer.json');
  fs.writeFileSync(writer, JSON.stringify({ schemaVersion: 1, owner: writerOwner, ownedRoots: [work] }));
  const launch = claimSourceLaunch(operations, { cwd: work });
  const now = new Date();
  const day = path.join(codexHome, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-fixture-${THREAD}.jsonl`);
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'session_meta', payload: { id: THREAD, model_provider: provider, source: 'cli', cwd: work, timestamp: new Date(launch.startedAt + 10).toISOString() } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', approval_policy: 'on-request', effort: 'high' } }), ''].join('\n'));
  return { root, codexHome, stateRoot, work, writer, launch, rollout, options: { codexHome, stateRoot } };
}
function draft(f, extra = {}) {
  fs.writeFileSync(f.launch.draftPath, JSON.stringify({ schemaVersion: 1, kind: 'ocx-checkpoint-draft', mode: 'automatic',
    writerRecord: f.writer, goal: 'fixture goal', completed: ['done part'], remaining: ['next part'], constraints: ['keep UNKNOWN'],
    references: ['spec'], ...extra }));
}

test('normal exit with an idle conversation records a stop receipt and a consumable checkpoint', () => {
  const f = fixture({ rows: [{ key: conversationFenceKey(OTHER), operationId: 'x', accountId: 'a', at: 1, state: 'unknown' }] });
  draft(f);
  const result = produceCheckpointAfterExit(f.launch, { status: 0, pid: 999999 }, f.options);
  assert.equal(result.state, 'CHECKPOINT_READY');
  const stop = JSON.parse(fs.readFileSync(result.stop.path, 'utf8'));
  assert.equal(stop.unknownCount, 0); assert.equal(stop.globalUnknownCount, 1); assert.equal(stop.unknownScope, 'this-conversation');
  assert.equal(stop.rolloutLength, fs.statSync(f.rollout).size);
  const checkpoint = JSON.parse(fs.readFileSync(result.checkpoint.path, 'utf8'));
  assert.equal(checkpoint.sourceThreadId, THREAD); assert.equal(checkpoint.model, 'gpt-6.1-sol');
  // The existing consumer accepts the produced files while they are fresh.
  const prepared = prepareCheckpointHandoff(result.checkpoint.path);
  assert.equal(prepared.checkpoint.operationId, f.launch.operationId);
});

test('this conversation UNKNOWN, nonzero exit or ambiguity holds without a stop receipt', () => {
  const unknown = fixture({ rows: [{ key: conversationFenceKey(THREAD), operationId: 'y', accountId: 'a', at: 1, state: 'unknown' }] });
  const held = produceCheckpointAfterExit(unknown.launch, { status: 0, pid: 999999 }, unknown.options);
  assert.equal(held.state, 'STOP_HOLD'); assert.ok(held.holds.includes('thread_unknown_outcome'));
  assert.equal(fs.existsSync(unknown.launch.stopPath), false);
  const failed = fixture();
  assert.deepEqual(produceCheckpointAfterExit(failed.launch, { status: 1, pid: 999999 }, failed.options).holds, ['nonzero_exit']);
  const missing = fixture();
  fs.rmSync(path.join(missing.stateRoot, 'runtime', 'ocx-local', 'home', 'external-request-lifecycle.json'));
  assert.ok(produceCheckpointAfterExit(missing.launch, { status: 0, pid: 999999 }, missing.options).holds.includes('fence_or_registry_absent'));
});

test('missing draft keeps the stop only; foreign writer owner never yields a checkpoint', () => {
  const f = fixture();
  assert.equal(produceCheckpointAfterExit(f.launch, { status: 0, pid: 999999 }, f.options).state, 'STOP_RECORDED_NO_DRAFT');
  const g = fixture({ writerOwner: OTHER });
  draft(g);
  assert.equal(produceCheckpointAfterExit(g.launch, { status: 0, pid: 999999 }, g.options).state, 'STOP_RECORDED_WRITER_OWNER_DIFFERS');
});

test('fence key matches the pool session-header derivation and resume UUID is parsed', () => {
  assert.equal(conversationFenceKey(THREAD), createHash('sha256').update(THREAD).digest('hex').slice(0, 32));
  assert.equal(resumeThreadFromArgs(['resume', THREAD, '-C', 'x']), THREAD);
  assert.equal(resumeThreadFromArgs(['resume', 'not-a-uuid']), null);
  const f = fixture();
  assert.equal(threadFenceState(THREAD, f.options).readOk, true);
});
