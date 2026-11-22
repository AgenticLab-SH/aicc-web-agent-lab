// Installed consumer acceptance with synthetic ledgers only; never launches Codex.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const evidenceArg = process.argv[2];
assert(evidenceArg && path.isAbsolute(evidenceArg) && !fs.existsSync(evidenceArg), 'Fresh absolute evidence directory required');
const evidence = path.resolve(evidenceArg);
const registryFile = path.join(os.homedir(), '.ai-control-center', 'runtime', 'components.json');
const registryBytes = fs.readFileSync(registryFile), cli = JSON.parse(registryBytes).components.cli;
assert.equal(cli.location, 'managed');
assert.equal(path.resolve(cli.entry), path.join(cli.releaseRoot, 'bin', 'aicc'));
assert(!evidence.toLowerCase().startsWith(cli.releaseRoot.toLowerCase() + path.sep));
const manifestFile = path.join(cli.releaseRoot, '.aicc-release.json'), manifest = json(manifestFile);
const pins = ['bin/aicc', 'src/bootstrap.mjs', 'src/cli.mjs', 'src/codex-checkpoint-handoff.mjs', 'src/codex-checkpoint-stop.mjs'].map(relative => {
  const file = path.join(cli.releaseRoot, relative), sha256 = digest(fs.readFileSync(file));
  assert.equal(sha256, manifest.files.find(row => row.path === relative)?.sha256);
  return { path: relative, sha256 };
});
const runtimeSha256 = digest(fs.readFileSync(cli.runtime));
fs.mkdirSync(evidence, { recursive: true });
const save = (file, value) => fs.writeFileSync(file, encode(value), { flag: 'wx' });
function snapshot(root) {
  const rows = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink());
      if (stat.isDirectory()) walk(file);
      else rows.push(path.relative(root, file) + ':' + digest(fs.readFileSync(file)));
    }
  }
  walk(root); return rows.join('\n');
}
function fixture(name) {
  const root = path.join(evidence, 'synthetic', name), cwd = path.join(root, 'owned-project');
  const home = path.join(root, 'home'), sessions = path.join(home, 'sessions');
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(sessions, { recursive: true });
  const operationId = randomUUID(), sourceThreadId = randomUUID(), threadId = randomUUID(), at = Date.now() - 1000;
  const prefix = path.join(root, operationId), writer = path.join(root, 'writer.json');
  save(writer, { schemaVersion: 1, owner: sourceThreadId, ownedRoots: [cwd], synthetic: true });
  const stop = path.join(root, 'synthetic-stop.json');
  // Fake transport boundary: these records represent fixtures, never real exit/dispatch evidence.
  save(stop, { schemaVersion: 1, kind: 'codex-checkpoint-stop', operationId, threadId: sourceThreadId,
    normalExit: true, writerReleased: true, activeCount: 0, unknownCount: 0, synthetic: true });
  const checkpoint = path.join(root, 'checkpoint.json');
  save(checkpoint, { schemaVersion: 1, kind: 'ocx-plain-checkpoint', operationId, sourceThreadId, mode: 'automatic',
    cwd, model: 'gpt-fixture', goal: 'Synthetic installed ACK/adopt boundary', completed: [], remaining: ['fixture remaining'], constraints: [], references: [],
    expiresAt: at + 300000, writerRecord: { path: writer, sha256: digest(fs.readFileSync(writer)) }, stopReceipt: { path: stop, sha256: digest(fs.readFileSync(stop)) }, synthetic: true });
  const attempt = prefix + '.launch-attempt.json';
  save(attempt, { schemaVersion: 1, kind: 'ocx-checkpoint-launch', state: 'DISPATCHING', operationId, sourceThreadId,
    observedAt: at, checkpointPath: checkpoint, checkpointSha256: digest(fs.readFileSync(checkpoint)), automaticRetry: false, synthetic: true });
  const exit = prefix + '.launch-result.json';
  save(exit, { schemaVersion: 1, operationId, sourceThreadId, state: 'CLI_EXITED_NOT_ADOPTED', exitCode: 0, synthetic: true });
  const rollout = path.join(sessions, 'rollout-synthetic-' + threadId + '.jsonl');
  fs.writeFileSync(rollout, [
    { type: 'session_meta', payload: { id: threadId, model_provider: 'aicc-ocx-compat', source: 'cli', cwd, timestamp: new Date(at + 100).toISOString() } },
    { type: 'turn_context', payload: { model: 'gpt-fixture', approval_policy: 'on-request', effort: 'high' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const immutableFiles = [stop, checkpoint, attempt, exit, rollout];
  return { name, root, cwd, home, operationId, sourceThreadId, threadId, prefix, writer, checkpoint, attempt, exit, rollout,
    originalPins: immutableFiles.map(file => ({ path: file, sha256: digest(fs.readFileSync(file)) })), calls: 0 };
}
function invoke(f, action, options, env = {}) {
  const result = spawnSync(cli.runtime, [cli.entry, 'codex', 'checkpoint', action, ...options, '--json'], {
    env: { ...process.env, CODEX_HOME: f.home, CODEX_THREAD_ID: f.threadId, AICC_CODEX_CHECKPOINT_ATTEMPT: f.attempt, ...env },
    cwd: f.cwd, encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  save(path.join(evidence, f.name + '-' + (++f.calls) + '-' + action + '.json'), {
    command: [cli.runtime, cli.entry, 'codex', 'checkpoint', action, ...options, '--json'],
    exitCode: result.status, error: result.error?.message ?? null, stdout: result.stdout, stderr: result.stderr, synthetic: true,
  });
  assert(!result.error, result.error?.message); return result;
}
function ack(f, env) { return invoke(f, 'acknowledge', ['--session-log', f.rollout], env); }
function ackPass(f) {
  const result = ack(f); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, 'WRITER_TRANSFERRED_RESULT_PENDING');
  const owner = json(f.writer), transfer = json(f.prefix + '.writer-transfer.json');
  assert.equal(owner.owner, f.threadId); assert.equal(owner.previousOwner, f.sourceThreadId);
  assert.deepEqual(owner.ownedRoots, [f.cwd]); assert.deepEqual(transfer.ownedRoots, [f.cwd]);
  assert.equal(transfer.writer.afterSha256, digest(fs.readFileSync(f.writer)));
  assert.equal(json(f.prefix + '.thread-ack.json').issuer, 'UNKNOWN');
  assert.equal(fs.existsSync(f.writer + '.lock'), false);
}
function work(f, state = 'SOURCE_COMPLETED', ownerThreadId = f.threadId) {
  const file = path.join(f.root, 'work.json');
  save(file, { schemaVersion: 1, kind: 'ocx-checkpoint-work-result', operationId: f.operationId, ownerThreadId,
    state, verification: 'NOT_RUN', completed: ['synthetic source result'], remaining: state === 'SOURCE_COMPLETED' ? [] : ['unfinished synthetic work'], references: ['fixture-only'] });
  return { file, sha256: digest(fs.readFileSync(file)) };
}
function adopt(f, pin) { return invoke(f, 'adopt', ['--checkpoint', f.checkpoint, '--result', pin.file, '--sha256', pin.sha256]); }
function refuseUnchanged(f, fn, message) {
  const before = snapshot(f.root), result = fn();
  assert.notEqual(result.status, 0); assert(result.stderr.includes(message), result.stderr);
  assert.equal(snapshot(f.root), before, 'Refusal changed synthetic original');
}
const cases = [];
function pass(name, fn) { const f = fixture(name); fn(f); for (const pin of f.originalPins) assert.equal(digest(fs.readFileSync(pin.path)), pin.sha256); cases.push({ name, state: 'PASS', syntheticOnly: true, originalTransportPinsPreserved: true }); }
pass('normal-ack-cas-adopt', f => {
  ackPass(f); const pin = work(f), result = adopt(f, pin); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout); assert.equal(receipt.state, 'SOURCE_RESULT_ADOPTED');
  assert.equal(json(f.writer).stage, receipt.state); assert.equal(receipt.installedOrLiveAcceptance, 'NOT_INFERRED');
  assert.equal(receipt.originalRequestsReplayed, false); assert.equal(fs.existsSync(f.writer + '.lock'), false);
});
pass('wrong-exact-ack', f => refuseUnchanged(f, () => ack(f, { CODEX_THREAD_ID: f.sourceThreadId }), 'Actual new CODEX_THREAD_ID'));
pass('stale-writer-sha-ack', f => { fs.appendFileSync(f.writer, '\n'); refuseUnchanged(f, () => ack(f), 'Owner artifact changed'); });
pass('duplicate-ack', f => { ackPass(f); refuseUnchanged(f, () => ack(f), 'Owner artifact changed'); });
pass('wrong-exact-adopt', f => { ackPass(f); const pin = work(f, 'SOURCE_COMPLETED', randomUUID()); refuseUnchanged(f, () => adopt(f, pin), 'Exact ACK, writer transfer'); });
pass('stale-result-sha-adopt', f => { ackPass(f); const pin = work(f); fs.appendFileSync(pin.file, '\n'); refuseUnchanged(f, () => adopt(f, pin), 'Owner artifact changed'); });
pass('writer-owner-changed-adopt', f => { ackPass(f); const pin = work(f); const owner = json(f.writer); owner.owner = randomUUID(); fs.writeFileSync(f.writer, encode(owner)); refuseUnchanged(f, () => adopt(f, pin), 'Exact canonical source writer'); });
for (const state of ['PARTIAL', 'HOLD']) pass(state.toLowerCase() + '-preserved', f => {
  ackPass(f); const pin = work(f, state), result = adopt(f, pin); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout); assert.equal(receipt.state, 'PARTIAL_RESULT_ADOPTED'); assert.equal(receipt.workState, state);
  assert.deepEqual(receipt.remaining, ['unfinished synthetic work']); assert.equal(receipt.verification, 'NOT_RUN');
});
pass('duplicate-adopt-no-replay', f => {
  ackPass(f); const pin = work(f); assert.equal(adopt(f, pin).status, 0);
  const ownerBefore = fs.readFileSync(f.writer), receiptBefore = fs.readFileSync(f.prefix + '.result-adoption.json');
  const result = adopt(f, pin); assert.notEqual(result.status, 0); assert(result.stderr.includes('EEXIST'), result.stderr);
  assert.deepEqual(fs.readFileSync(f.writer), ownerBefore); assert.deepEqual(fs.readFileSync(f.prefix + '.result-adoption.json'), receiptBefore);
  // Current product intentionally retains a lock after uncertain/CAS phase refusal. Never delete it or retry.
  assert(fs.existsSync(f.writer + '.lock')); assert(fs.existsSync(f.prefix + '.adoption.intent.json'));
});
assert.equal(digest(fs.readFileSync(registryFile)), digest(registryBytes));
for (const pin of pins) assert.equal(digest(fs.readFileSync(path.join(cli.releaseRoot, pin.path))), pin.sha256);
assert.equal(digest(fs.readFileSync(cli.runtime)), runtimeSha256);
const result = { status: 'PASS', passed: cases.length, failed: 0, cases, synthetic: true, fakeTransport: 'Only synthetic stop/attempt/exit/rollout metadata; no runner or Codex spawned',
  installation: { releaseRoot: cli.releaseRoot, entry: cli.entry, runtime: cli.runtime, runtimeSha256, manifestSha256: digest(fs.readFileSync(manifestFile)), pins, newInstalls: 0 },
  runtimeRegistryPreserved: true, sourceFunctionInvocations: 0, realModels: 0, realOwnerTransfers: 0, actualHomeWrites: 0, networkSends: 0,
  duplicateAdopt: 'EEXIST; writer and adoption receipt unchanged; synthetic lock/intent retained for exact reconciliation, no retry',
  meaning: 'Installed ACK/CAS/adopt synthetic consumer boundaries only. No real stop, new conversation, account switch or live ownership completion evidence.' };
save(path.join(evidence, 'acceptance.json'), result); console.log(encode(result));
