import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runSandboxedVerification, WorkspaceChangeError } from '../src/workspace-snapshots/change-transaction.mjs';
import { WorkspaceSnapshotService } from '../src/workspace-snapshots/service.mjs';

const SCHEMA_HASH = 'b'.repeat(64);

function nestedSandboxExecAvailable() {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) return false;
  const probe = spawnSync('/usr/bin/sandbox-exec', [
    '-p', '(version 1)\n(allow default)', '/usr/bin/true'
  ], { encoding: 'utf8', timeout: 2_000 });
  return probe.status === 0;
}

const NESTED_SANDBOX_EXEC_AVAILABLE = nestedSandboxExecAvailable();

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function passingRunner(assertion = () => {}) {
  return input => {
    assertion(input);
    return {
      passed: true,
      networkAllowed: false,
      rawOutputStored: false,
      results: input.steps.map(step => ({
        type: step.type,
        selector: step.type === 'node_test' ? step.paths : [step.script],
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 1,
        stdoutBytes: 0,
        stdoutSha256: '0'.repeat(64),
        stderrBytes: 0,
        stderrSha256: '0'.repeat(64),
        passed: true,
      })),
    };
  };
}

function fixture(t, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-change-'));
  const root = path.join(base, 'repo');
  const stateRoot = path.join(base, 'state');
  fs.mkdirSync(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'change@example.invalid');
  git(root, 'config', 'user.name', 'Change Test');
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'one.txt'), 'one-before\n');
  fs.writeFileSync(path.join(root, 'two.txt'), 'two-before\n');
  const fixtureTest = options.useRealVerification
    ? 'import assert from "node:assert/strict"; import net from "node:net"; import test from "node:test"; test("sandbox denies network", async () => new Promise((resolve, reject) => { const socket = net.connect({ host: "127.0.0.1", port: 9 }); socket.once("connect", () => reject(new Error("network unexpectedly available"))); socket.once("error", error => { try { assert.match(String(error.code), /^(?:EPERM|EACCES)$/); resolve(); } catch (failure) { reject(failure); } }); }));\n'
    : 'import test from "node:test"; test("fixture", () => {});\n';
  fs.writeFileSync(path.join(root, 'test', 'fixture.test.mjs'), fixtureTest);
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ scripts: { check: 'node --test test/fixture.test.mjs' } }, null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  const clock = { value: Date.parse('2026-08-16T05:00:00Z') };
  const service = new WorkspaceSnapshotService({
    allowedRoots: [root],
    stateRoot,
    now: () => new Date(clock.value),
    verificationRunner: options.useRealVerification ? undefined : options.verificationRunner ?? passingRunner(),
    transactionCrashPoint: options.transactionCrashPoint,
    transactionPid: options.transactionPid,
    transactionLockStaleMs: options.transactionLockStaleMs,
    transactionIsProcessAlive: options.transactionIsProcessAlive,
  });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, root, stateRoot, clock, service };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function encoded(text) {
  return Buffer.from(text).toString('base64');
}

function begin(service, root) {
  return service.begin({ root, toolSchemaHash: SCHEMA_HASH }).manifest;
}

function plan(service, snapshotId, changes, verification = [{ type: 'node_test', paths: ['test/fixture.test.mjs'] }]) {
  return service.planChange({ snapshotId, changes, verification });
}

test('plan is content-idempotent, stores only bounded owner payloads, and never changes the workspace', t => {
  const { root, stateRoot, clock, service } = fixture(t);
  const snapshot = begin(service, root);
  const request = [{ type: 'write_text', path: 'one.txt', contentBase64: encoded('one-after\n') }];
  const first = plan(service, snapshot.snapshotId, request);
  clock.value += 60_000;
  const duplicate = plan(service, snapshot.snapshotId, request);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.plan.operationId, first.plan.operationId);
  assert.equal(duplicate.plan.planHash, first.plan.planHash);
  assert.equal(first.plan.changes[0].expectedSha256.length, 64);
  assert.equal(first.plan.changes[0].desiredSha256.length, 64);
  assert.equal(JSON.stringify(first.plan).includes(encoded('one-after\n')), false);
  const operationRoot = path.join(stateRoot, 'transactions', first.plan.operationId);
  assert.equal(fs.readFileSync(path.join(operationRoot, 'payloads', '000.bin'), 'utf8'), 'one-after\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(operationRoot, 'payloads', '000.bin')).mode & 0o077, 0);
  assert.equal(fs.readFileSync(path.join(root, 'one.txt'), 'utf8'), 'one-before\n');
});

test('candidate verification precedes one exclusive live apply and explicit rollback restores exact bytes', t => {
  let verificationSawOldLive = false;
  const context = fixture(t, {
    verificationRunner: passingRunner(({ root: scratch, sourceRoot }) => {
      assert.equal(fs.readFileSync(path.join(scratch, 'one.txt'), 'utf8'), 'one-after\n');
      assert.equal(fs.readFileSync(path.join(sourceRoot, 'one.txt'), 'utf8'), 'one-before\n');
      verificationSawOldLive = true;
    }),
  });
  const snapshot = begin(context.service, context.root);
  const created = plan(context.service, snapshot.snapshotId, [{ type: 'write_text', path: 'one.txt', contentBase64: encoded('one-after\n') }]);
  const applied = context.service.applyVerifyChange({ operationId: created.plan.operationId, planHash: created.plan.planHash });
  assert.equal(verificationSawOldLive, true);
  assert.equal(applied.state.phase, 'VERIFIED');
  assert.equal(applied.state.effectState, 'COMMITTED');
  assert.equal(applied.state.verification.rawOutputStored, false);
  assert.equal(fs.readFileSync(path.join(context.root, 'one.txt'), 'utf8'), 'one-after\n');
  assert.equal(context.service.applyVerifyChange({ operationId: created.plan.operationId, planHash: created.plan.planHash }).duplicate, true);
  const rolledBack = context.service.rollbackChange({ operationId: created.plan.operationId, planHash: created.plan.planHash, reason: 'fixture' });
  assert.equal(rolledBack.state.phase, 'ROLLED_BACK');
  assert.equal(fs.readFileSync(path.join(context.root, 'one.txt'), 'utf8'), 'one-before\n');
  assert.equal(context.service.rollbackChange({ operationId: created.plan.operationId, planHash: created.plan.planHash }).duplicate, true);
});

test('candidate verification failure and stale workspace stop before any live mutation', t => {
  const failed = fixture(t, { verificationRunner: () => ({ passed: false, networkAllowed: false, rawOutputStored: false, results: [{ passed: false }] }) });
  const failedSnapshot = begin(failed.service, failed.root);
  const failedPlan = plan(failed.service, failedSnapshot.snapshotId, [{ type: 'write_text', path: 'one.txt', contentBase64: encoded('should-not-apply\n') }]);
  const result = failed.service.applyVerifyChange({ operationId: failedPlan.plan.operationId, planHash: failedPlan.plan.planHash });
  assert.equal(result.state.phase, 'CANDIDATE_FAILED');
  assert.equal(fs.readFileSync(path.join(failed.root, 'one.txt'), 'utf8'), 'one-before\n');

  const stale = fixture(t);
  const staleSnapshot = begin(stale.service, stale.root);
  const stalePlan = plan(stale.service, staleSnapshot.snapshotId, [{ type: 'write_text', path: 'one.txt', contentBase64: encoded('should-not-apply\n') }]);
  fs.writeFileSync(path.join(stale.root, 'two.txt'), 'external-drift\n');
  assert.throws(
    () => stale.service.applyVerifyChange({ operationId: stalePlan.plan.operationId, planHash: stalePlan.plan.planHash }),
    error => error.code === 'snapshot_stale',
  );
  assert.equal(fs.readFileSync(path.join(stale.root, 'one.txt'), 'utf8'), 'one-before\n');
});

test('partial crash reconciles by narrow rollback without replaying an already-applied write', t => {
  const crashed = fixture(t, { transactionCrashPoint: 'after_mutation_0', transactionPid: 91, transactionIsProcessAlive: () => false });
  const snapshot = begin(crashed.service, crashed.root);
  const created = plan(crashed.service, snapshot.snapshotId, [
    { type: 'write_text', path: 'one.txt', contentBase64: encoded('one-after\n') },
    { type: 'write_text', path: 'two.txt', contentBase64: encoded('two-after\n') },
  ]);
  assert.throws(
    () => crashed.service.applyVerifyChange({ operationId: created.plan.operationId, planHash: created.plan.planHash }),
    error => error instanceof WorkspaceChangeError && error.code === 'injected_crash',
  );
  assert.equal(fs.readFileSync(path.join(crashed.root, 'one.txt'), 'utf8'), 'one-after\n');
  assert.equal(fs.readFileSync(path.join(crashed.root, 'two.txt'), 'utf8'), 'two-before\n');

  const restarted = new WorkspaceSnapshotService({
    allowedRoots: [crashed.root], stateRoot: crashed.stateRoot,
    now: () => new Date(crashed.clock.value + 120_000), verificationRunner: passingRunner(),
    transactionPid: 92, transactionLockStaleMs: 100, transactionIsProcessAlive: () => false,
  });
  const reconciled = restarted.reconcileChange({ operationId: created.plan.operationId, planHash: created.plan.planHash });
  assert.equal(reconciled.action, 'rolled-back');
  assert.equal(reconciled.state.phase, 'ROLLED_BACK');
  assert.equal(fs.readFileSync(path.join(crashed.root, 'one.txt'), 'utf8'), 'one-before\n');
  assert.equal(fs.readFileSync(path.join(crashed.root, 'two.txt'), 'utf8'), 'two-before\n');
});

test('all-desired crash commits by observation while external drift holds without overwriting it', t => {
  const committed = fixture(t, { transactionCrashPoint: 'after_mutation_0', transactionPid: 81, transactionIsProcessAlive: () => false });
  const committedSnapshot = begin(committed.service, committed.root);
  const committedPlan = plan(committed.service, committedSnapshot.snapshotId, [{ type: 'write_text', path: 'one.txt', contentBase64: encoded('one-after\n') }]);
  assert.throws(
    () => committed.service.applyVerifyChange({ operationId: committedPlan.plan.operationId, planHash: committedPlan.plan.planHash }),
    error => error.code === 'injected_crash',
  );
  const committedRestart = new WorkspaceSnapshotService({
    allowedRoots: [committed.root], stateRoot: committed.stateRoot,
    now: () => new Date(committed.clock.value + 120_000), verificationRunner: passingRunner(),
    transactionPid: 82, transactionLockStaleMs: 100, transactionIsProcessAlive: () => false,
  });
  const commitResult = committedRestart.reconcileChange({ operationId: committedPlan.plan.operationId, planHash: committedPlan.plan.planHash });
  assert.equal(commitResult.action, 'committed');
  assert.equal(commitResult.state.phase, 'VERIFIED');
  assert.equal(fs.readFileSync(path.join(committed.root, 'one.txt'), 'utf8'), 'one-after\n');

  const drift = fixture(t, { transactionCrashPoint: 'after_mutation_0', transactionPid: 71, transactionIsProcessAlive: () => false });
  const driftSnapshot = begin(drift.service, drift.root);
  const driftPlan = plan(drift.service, driftSnapshot.snapshotId, [
    { type: 'write_text', path: 'one.txt', contentBase64: encoded('one-after\n') },
    { type: 'write_text', path: 'two.txt', contentBase64: encoded('two-after\n') },
  ]);
  assert.throws(() => drift.service.applyVerifyChange({ operationId: driftPlan.plan.operationId, planHash: driftPlan.plan.planHash }), error => error.code === 'injected_crash');
  fs.writeFileSync(path.join(drift.root, 'one.txt'), 'external-owner-change\n');
  const driftRestart = new WorkspaceSnapshotService({
    allowedRoots: [drift.root], stateRoot: drift.stateRoot,
    now: () => new Date(drift.clock.value + 120_000), verificationRunner: passingRunner(),
    transactionPid: 72, transactionLockStaleMs: 100, transactionIsProcessAlive: () => false,
  });
  const held = driftRestart.reconcileChange({ operationId: driftPlan.plan.operationId, planHash: driftPlan.plan.planHash });
  assert.equal(held.action, 'hold-external-drift');
  assert.equal(held.state.phase, 'HOLD_EXTERNAL_DRIFT');
  assert.equal(fs.readFileSync(path.join(drift.root, 'one.txt'), 'utf8'), 'external-owner-change\n');
  assert.equal(fs.readFileSync(path.join(drift.root, 'two.txt'), 'utf8'), 'two-before\n');
});

test('live writer, wrong plan hash, test weakening, unselected untracked and sensitive content fail closed', t => {
  const context = fixture(t, { transactionPid: 99, transactionIsProcessAlive: pid => pid === 77 });
  const snapshot = begin(context.service, context.root);
  assert.throws(
    () => plan(context.service, snapshot.snapshotId, [{ type: 'write_text', path: 'test/fixture.test.mjs', contentBase64: encoded('test weakened\n') }]),
    error => error.code === 'verification_invalid',
  );
  fs.writeFileSync(path.join(context.root, 'unselected.txt'), 'owner draft\n');
  assert.throws(
    () => plan(context.service, snapshot.snapshotId, [{ type: 'write_text', path: 'unselected.txt', contentBase64: encoded('replace\n') }]),
    error => error.code === 'snapshot_stale' || error.code === 'untracked_target_denied',
  );
  fs.rmSync(path.join(context.root, 'unselected.txt'));
  assert.throws(
    () => plan(context.service, snapshot.snapshotId, [{ type: 'write_text', path: 'one.txt', contentBase64: encoded(`ghp_${'a'.repeat(20)}\n`) }]),
    error => error.code === 'sensitive_content',
  );
  const created = plan(context.service, snapshot.snapshotId, [{ type: 'write_text', path: 'one.txt', contentBase64: encoded('one-after\n') }]);
  assert.throws(
    () => context.service.changeStatus({ operationId: created.plan.operationId, planHash: '0'.repeat(64) }),
    error => error instanceof WorkspaceChangeError && error.code === 'plan_hash_mismatch',
  );
  const writerFile = path.join(context.stateRoot, 'writers', `${snapshot.workspaceId}.lock`);
  fs.writeFileSync(writerFile, `${JSON.stringify({ schemaVersion: 1, workspaceId: snapshot.workspaceId, operationId: 'change_busy', pid: 77, nonce: 'busy', createdAt: context.clock.value - 100_000 })}\n`, { mode: 0o600 });
  assert.throws(
    () => context.service.applyVerifyChange({ operationId: created.plan.operationId, planHash: created.plan.planHash }),
    error => error instanceof WorkspaceChangeError && error.code === 'writer_busy',
  );
  assert.equal(fs.readFileSync(path.join(context.root, 'one.txt'), 'utf8'), 'one-before\n');
});

test('the default macOS verifier denies network before applying the candidate', { skip: !NESTED_SANDBOX_EXEC_AVAILABLE }, t => {
  const context = fixture(t, { useRealVerification: true });
  const snapshot = begin(context.service, context.root);
  const created = plan(context.service, snapshot.snapshotId, [{ type: 'write_text', path: 'one.txt', contentBase64: encoded('verified-offline\n') }]);
  const applied = context.service.applyVerifyChange({ operationId: created.plan.operationId, planHash: created.plan.planHash });
  assert.equal(applied.state.phase, 'VERIFIED');
  assert.equal(applied.state.verification.networkAllowed, false);
  assert.equal(applied.state.verification.rawOutputStored, false);
  assert.equal(applied.state.verification.results[0].passed, true);
  assert.equal(fs.readFileSync(path.join(context.root, 'one.txt'), 'utf8'), 'verified-offline\n');
});

test('the macOS verifier traverses owner-home scratch metadata without exposing sibling owner data', { skip: !NESTED_SANDBOX_EXEC_AVAILABLE }, t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-owner-home-verifier-'));
  const ownerHome = path.join(base, 'owner');
  const scratch = path.join(ownerHome, 'state', 'transactions', 'change_fixture', 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(ownerHome, 'secret.txt'), 'must stay unreadable\n');
  fs.writeFileSync(path.join(scratch, 'fixture.test.mjs'), [
    'import assert from "node:assert/strict";',
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import test from "node:test";',
    'test("owner scratch remains usable and confined", () => {',
    '  const secret = path.resolve(process.cwd(), "../../../../secret.txt");',
    '  assert.throws(() => fs.readFileSync(secret, "utf8"), error => /^(?:EPERM|EACCES)$/.test(String(error.code)));',
    '});',
    '',
  ].join('\n'));
  const previousHome = process.env.HOME;
  process.env.HOME = ownerHome;
  try {
    const result = runSandboxedVerification({
      root: scratch,
      sourceRoot: scratch,
      steps: [{ type: 'node_test', paths: ['fixture.test.mjs'], timeoutMs: 30_000 }],
    });
    assert.equal(result.passed, true);
    assert.equal(result.networkAllowed, false);
    assert.equal(result.rawOutputStored, false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
});

test('exact stale writer reconciliation quarantines its lock and forged request identity fails closed', t => {
  const context = fixture(t, {
    transactionPid: 202,
    transactionLockStaleMs: 100,
    transactionIsProcessAlive: () => false,
  });
  const snapshot = begin(context.service, context.root);
  const created = plan(context.service, snapshot.snapshotId, [{ type: 'write_text', path: 'one.txt', contentBase64: encoded('one-after\n') }]);
  const writerFile = path.join(context.stateRoot, 'writers', `${snapshot.workspaceId}.lock`);
  const staleWriter = {
    schemaVersion: 1,
    workspaceId: snapshot.workspaceId,
    operationId: created.plan.operationId,
    pid: 101,
    nonce: 'stale',
    createdAt: context.clock.value - 1_000,
  };
  fs.writeFileSync(writerFile, `${JSON.stringify(staleWriter)}\n`, { mode: 0o600 });
  const reconciled = context.service.reconcileChange({ operationId: created.plan.operationId, planHash: created.plan.planHash });
  assert.equal(reconciled.action, 'none');
  assert.equal(fs.existsSync(writerFile), false);
  assert.equal(fs.readdirSync(path.join(context.stateRoot, 'transactions', created.plan.operationId)).some(name => name.startsWith('stale-writer-')), true);

  const planFile = path.join(context.stateRoot, 'transactions', created.plan.operationId, 'plan.json');
  const forged = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  forged.requestHash = 'f'.repeat(64);
  const { planHash: _oldHash, operationId: _operationId, ...core } = forged;
  forged.planHash = hash(core);
  fs.writeFileSync(planFile, `${JSON.stringify(forged, null, 2)}\n`);
  assert.throws(
    () => context.service.changeStatus({ operationId: created.plan.operationId, planHash: forged.planHash }),
    error => error instanceof WorkspaceChangeError && error.code === 'plan_integrity_failed',
  );
});
