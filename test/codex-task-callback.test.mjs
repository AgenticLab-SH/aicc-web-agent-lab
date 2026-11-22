import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { CodexTaskCallbackService } from '../src/codex-task-callback.mjs';

const VERSION = '0.148.0-alpha.9';
const TASK_ID = '01a0061f-05c0-7dc0-bf14-f21440901a6b';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function thread(root, { status = 'idle', turns = [] } = {}) {
  return { thread: { id: TASK_ID, cwd: root, status: { type: status }, turns } };
}

function fakeClient(root, options = {}) {
  const calls = [];
  return {
    calls,
    async connect() { calls.push(['connect']); return {}; },
    async threadRead(params) { calls.push(['threadRead', params]); return options.read ?? thread(root); },
    async threadResume(params) {
      calls.push(['threadResume', params]);
      if (options.resumeError) throw options.resumeError;
      return options.resume ?? thread(root);
    },
    async turnStart(params) {
      calls.push(['turnStart', params]);
      if (options.turnStartError) throw options.turnStartError;
      return { turn: { id: options.turnId ?? 'turn-123', status: 'inProgress', items: [] } };
    },
    async waitFor(method, predicate) {
      calls.push(['waitFor', method]);
      if (options.waitError) throw options.waitError;
      const value = options.completed ?? { turn: { id: options.turnId ?? 'turn-123', status: 'completed', items: [] } };
      assert.equal(predicate(value), true);
      return value;
    },
    close() { calls.push(['close']); }
  };
}

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-callback-')));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  const resultRoot = path.join(root, 'results');
  const stateRoot = path.join(root, 'state');
  for (const directory of [projectRoot, resultRoot, stateRoot]) fs.mkdirSync(directory, { mode: 0o700 });
  const manifestFile = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify({ codexVersion: VERSION, productionStableAllowlist: ['initialize', 'thread/read', 'thread/resume', 'turn/start'] })}\n`, { mode: 0o600 });
  const codexExecutable = path.join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const codexSource = process.platform === 'win32'
    ? `@echo codex-cli ${VERSION}\r\n`
    : `#!/bin/sh\necho 'codex-cli ${VERSION}'\n`;
  fs.writeFileSync(codexExecutable, codexSource, { mode: 0o700 });
  const resultFile = path.join(resultRoot, 'result.json');
  let now = Date.parse('2026-08-16T09:30:00.000Z');
  const clients = [];
  const service = new CodexTaskCallbackService({
    stateRoot,
    now: () => now,
    randomUUID: () => '123e4567-e89b-42d3-a456-426614174000',
    randomBytes: () => Buffer.alloc(32, 7),
    clientFactory: clientOptions => {
      const client = fakeClient(projectRoot, options.client ?? {});
      client.options = clientOptions;
      clients.push(client);
      return client;
    }
  });
  const arm = (overrides = {}) => service.arm({
    projectKey: 'ai-platform',
    taskId: TASK_ID,
    projectRoot,
    operationId: 'terminal-operation-v1',
    resultFile,
    manifestFile,
    codexExecutable,
    terminalStatuses: ['PASS', 'HOLD'],
    ...overrides
  });
  const writeResult = (document = { operation: 'terminal-operation-v1', status: 'PASS', secret: 'not-forwarded' }) => {
    fs.writeFileSync(resultFile, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    fs.chmodSync(resultFile, 0o600);
    return sha256(resultFile);
  };
  return { root, projectRoot, resultRoot, stateRoot, manifestFile, codexExecutable, resultFile, service, clients, arm, writeResult, get now() { return now; }, set now(value) { now = value; } };
}

test('owner-only callback validates the pinned Desktop App Server and resumes the exact idle task once', async t => {
  const f = fixture(t);
  const armed = f.arm();
  const digest = f.writeResult();
  const result = await f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest });
  assert.equal(result.state, 'completed');
  assert.equal(result.duplicateSuppressed, false);
  const turnStart = f.clients[0].calls.find(call => call[0] === 'turnStart')[1];
  assert.equal(turnStart.threadId, TASK_ID);
  assert.equal(turnStart.cwd, f.projectRoot);
  assert.equal(turnStart.clientUserMessageId, `aicc-terminal-callback:${armed.callbackId}`);
  assert.match(turnStart.input[0].text, /terminal-operation-v1/);
  assert.match(turnStart.input[0].text, new RegExp(digest));
  assert.match(turnStart.input[0].text, /60초 이내의 짧은 인수 turn/);
  assert.match(turnStart.input[0].text, /사용자 메시지가 새로 도착하면.*재발행하지 말고/);
  assert.doesNotMatch(turnStart.input[0].text, /not-forwarded/);
  assert.equal(fs.existsSync(armed.tokenFile), false);
  assert.equal(f.service.inspect({ callbackId: armed.callbackId }).state, 'completed');
});

test('guardian handoff returns after one callback turn is durably submitted', async t => {
  const f = fixture(t);
  const armed = f.arm();
  const digest = f.writeResult();
  const result = await f.service.complete({
    callbackId: armed.callbackId,
    expectedResultSha256: digest,
    waitForTerminal: false
  });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'turn_started');
  assert.equal(result.submitted, true);
  assert.equal(f.service.inspect({ callbackId: armed.callbackId }).state, 'turn_started');
  assert.equal(f.clients[0].calls.some(call => call[0] === 'waitFor'), false);
  assert.equal(fs.existsSync(armed.tokenFile), true);
});

test('callback can bind exact delivery to an owner-only shared Desktop daemon socket', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const controlSocket = path.join(f.root, 'app-server-control.sock');
  const server = net.createServer();
  server.listen(controlSocket);
  await once(server, 'listening');
  fs.chmodSync(controlSocket, 0o600);
  try {
    const armed = f.arm({ controlSocket });
    assert.equal(armed.deliveryTransport, 'desktop-shared-daemon');
    const digest = f.writeResult();
    const result = await f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest });
    assert.equal(result.state, 'completed');
    assert.equal(f.service.inspect({ callbackId: armed.callbackId }).controlSocket, controlSocket);
    assert.equal(typeof f.clients[0].options.spawnProcess, 'function');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('completed callback suppresses replay without creating another App Server client', async t => {
  const f = fixture(t);
  const armed = f.arm();
  const digest = f.writeResult();
  await f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest });
  const replay = await f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest });
  assert.equal(replay.duplicateSuppressed, true);
  assert.equal(f.clients.length, 1);
});

test('a failed callback turn is terminal but is never reported as a successful continuation', async t => {
  const f = fixture(t, { client: { completed: { turn: { id: 'turn-123', status: 'failed', items: [] } } } });
  const armed = f.arm();
  const digest = f.writeResult();
  const result = await f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'terminal_failed');
  assert.equal(result.terminalTurnStatus, 'failed');
  assert.equal(f.service.inspect({ callbackId: armed.callbackId }).state, 'terminal_failed');
  assert.equal(fs.existsSync(armed.tokenFile), false);

  const repeated = await f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest });
  assert.equal(repeated.ok, false);
  assert.equal(repeated.state, 'terminal_failed');
  assert.equal(repeated.duplicateSuppressed, true);
  assert.equal(f.clients.length, 1);
});

test('callback rejects a wrong result hash before App Server dispatch', async t => {
  const f = fixture(t);
  const armed = f.arm();
  f.writeResult();
  await assert.rejects(
    f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: '0'.repeat(64) }),
    error => error.code === 'callback_result_hash_mismatch'
  );
  assert.equal(f.clients.length, 0);
  assert.equal(f.service.inspect({ callbackId: armed.callbackId }).state, 'armed');
});

test('callback rejects nonterminal, wrong-operation, permissive and symlink results', async t => {
  for (const variant of ['nonterminal', 'operation', 'permissions', 'symlink']) {
    await t.test(variant, async t2 => {
      const f = fixture(t2);
      const armed = f.arm();
      let expectedCode;
      if (variant === 'nonterminal') { f.writeResult({ operation: 'terminal-operation-v1', status: 'RUNNING' }); expectedCode = 'callback_result_not_terminal'; }
      if (variant === 'operation') { f.writeResult({ operation: 'another-operation', status: 'PASS' }); expectedCode = 'callback_result_operation_mismatch'; }
      if (variant === 'permissions') {
        if (process.platform === 'win32') {
          t2.skip('POSIX mode bits do not represent Windows ACLs');
          return;
        }
        f.writeResult(); fs.chmodSync(f.resultFile, 0o644); expectedCode = 'callback_result_unsafe_permissions';
      }
      if (variant === 'symlink') {
        const target = path.join(f.resultRoot, 'target.json');
        fs.writeFileSync(target, `${JSON.stringify({ operation: 'terminal-operation-v1', status: 'PASS' })}\n`, { mode: 0o600 });
        fs.symlinkSync(target, f.resultFile);
        expectedCode = 'callback_result_unsafe';
      }
      await assert.rejects(
        f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: '0'.repeat(64) }),
        error => error.code === expectedCode
      );
      assert.equal(f.clients.length, 0);
    });
  }
});

test('callback refuses active and wrong-root tasks without consuming the binding', async t => {
  for (const variant of ['active', 'wrong-root']) {
    await t.test(variant, async t2 => {
      const f = fixture(t2);
      const armed = f.arm();
      const digest = f.writeResult();
      const originalFactory = f.service.clientFactory;
      f.service.clientFactory = () => {
        const client = variant === 'active'
          ? fakeClient(f.projectRoot, { read: thread(f.projectRoot, { status: 'active' }) })
          : fakeClient(f.projectRoot, { read: thread(f.root) });
        f.clients.push(client);
        return client;
      };
      await assert.rejects(
        f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest }),
        error => error.code === (variant === 'active' ? 'callback_thread_active' : 'callback_thread_root_mismatch')
      );
      f.service.clientFactory = originalFactory;
      assert.equal(f.service.inspect({ callbackId: armed.callbackId }).state, 'armed');
    });
  }
});

test('Desktop writer ownership is recorded before dispatch and can be retried without a duplicate turn', async t => {
  const writerError = Object.assign(new Error(`thread ${TASK_ID} already has an active writer`), { code: -32603 });
  const f = fixture(t, { client: { resumeError: writerError } });
  const armed = f.arm();
  const digest = f.writeResult();
  await assert.rejects(
    f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest }),
    error => error.code === 'callback_destination_writer_busy' && error.data?.retrySafe === true
  );
  const blocked = f.service.inspect({ callbackId: armed.callbackId });
  assert.equal(blocked.state, 'destination_busy');
  assert.equal(blocked.resultSha256, digest);
  assert.equal(blocked.lastDeliveryErrorCode, 'callback_destination_writer_busy');
  assert.equal(f.clients[0].calls.some(call => call[0] === 'turnStart'), false);

  f.service.clientFactory = () => {
    const client = fakeClient(f.projectRoot);
    f.clients.push(client);
    return client;
  };
  const retried = await f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest });
  assert.equal(retried.state, 'completed');
  assert.equal(f.clients.flatMap(client => client.calls).filter(call => call[0] === 'turnStart').length, 1);
});

test('manual resume cancellation consumes an undelivered callback with an exact result hash', async t => {
  const f = fixture(t);
  const armed = f.arm();
  const digest = f.writeResult();
  const cancelled = await f.service.cancel({
    callbackId: armed.callbackId,
    expectedResultSha256: digest,
    reason: 'manual_resume'
  });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.duplicateSuppressed, false);
  assert.equal(fs.existsSync(armed.tokenFile), false);
  const inspected = f.service.inspect({ callbackId: armed.callbackId });
  assert.equal(inspected.state, 'cancelled');
  assert.equal(inspected.cancellationReason, 'manual_resume');
  const repeated = await f.service.cancel({
    callbackId: armed.callbackId,
    expectedResultSha256: digest,
    reason: 'manual_resume'
  });
  assert.equal(repeated.duplicateSuppressed, true);
  await assert.rejects(
    f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest }),
    error => error.code === 'callback_cancelled'
  );
  assert.equal(f.clients.length, 0);
});

test('callback cancellation refuses a wrong hash and ambiguous delivery states', async t => {
  const wrongHash = fixture(t);
  const wrongHashArmed = wrongHash.arm();
  wrongHash.writeResult();
  await assert.rejects(
    wrongHash.service.cancel({ callbackId: wrongHashArmed.callbackId, expectedResultSha256: '0'.repeat(64) }),
    error => error.code === 'callback_result_hash_mismatch'
  );
  assert.equal(wrongHash.service.inspect({ callbackId: wrongHashArmed.callbackId }).state, 'armed');

  const ambiguous = fixture(t, { client: { turnStartError: Object.assign(new Error('timeout'), { code: 'request_timeout' }) } });
  const ambiguousArmed = ambiguous.arm();
  const digest = ambiguous.writeResult();
  await assert.rejects(
    ambiguous.service.complete({ callbackId: ambiguousArmed.callbackId, expectedResultSha256: digest }),
    error => error.code === 'callback_delivery_unknown'
  );
  await assert.rejects(
    ambiguous.service.cancel({ callbackId: ambiguousArmed.callbackId, expectedResultSha256: digest }),
    error => error.code === 'callback_cancel_unsafe'
  );
});

test('expired binding fails closed before reading a terminal result', async t => {
  const f = fixture(t);
  const armed = f.arm();
  f.writeResult();
  f.now += 24 * 60 * 60_000 + 1;
  await assert.rejects(
    f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: sha256(f.resultFile) }),
    error => error.code === 'callback_expired'
  );
  assert.equal(f.service.inspect({ callbackId: armed.callbackId }).state, 'expired');
});

test('ambiguous turn/start is never replayed', async t => {
  const f = fixture(t, { client: { turnStartError: Object.assign(new Error('timeout'), { code: 'request_timeout' }) } });
  const armed = f.arm();
  const digest = f.writeResult();
  await assert.rejects(f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest }), error => error.code === 'callback_delivery_unknown');
  assert.equal(f.service.inspect({ callbackId: armed.callbackId }).state, 'dispatching');
  await assert.rejects(f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest }), error => error.code === 'callback_delivery_unknown');
  assert.equal(f.clients.length, 1);
});

test('a started callback turn is reconciled after a wait timeout without a duplicate turn', async t => {
  const f = fixture(t, { client: { waitError: Object.assign(new Error('wait timeout'), { code: 'notification_timeout' }) } });
  const armed = f.arm();
  const digest = f.writeResult();
  await assert.rejects(f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest, timeoutMs: 1000 }), error => error.code === 'callback_turn_wait_timeout');
  assert.equal(f.service.inspect({ callbackId: armed.callbackId }).state, 'turn_started');
  f.service.clientFactory = () => {
    const client = fakeClient(f.projectRoot, { read: thread(f.projectRoot, { turns: [{ id: 'turn-123', status: 'completed', items: [] }] }) });
    f.clients.push(client);
    return client;
  };
  const reconciled = await f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest });
  assert.equal(reconciled.reconciled, true);
  assert.equal(f.clients.flatMap(client => client.calls).filter(call => call[0] === 'turnStart').length, 1);
});

test('a user-interrupted callback turn is reconciled without replay and consumes its token', async t => {
  const f = fixture(t, { client: { waitError: Object.assign(new Error('wait timeout'), { code: 'notification_timeout' }) } });
  const armed = f.arm();
  const digest = f.writeResult();
  await assert.rejects(
    f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest, timeoutMs: 1000 }),
    error => error.code === 'callback_turn_wait_timeout'
  );
  f.service.clientFactory = () => {
    const client = fakeClient(f.projectRoot, { read: thread(f.projectRoot, { turns: [{ id: 'turn-123', status: 'interrupted', items: [] }] }) });
    f.clients.push(client);
    return client;
  };
  const reconciled = await f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest });
  assert.equal(reconciled.ok, false);
  assert.equal(reconciled.state, 'terminal_interrupted');
  assert.equal(reconciled.reconciled, true);
  assert.equal(fs.existsSync(armed.tokenFile), false);
  assert.equal(f.clients.flatMap(client => client.calls).filter(call => call[0] === 'turnStart').length, 1);
});

test('callback pins binary and manifest bytes at arm time', async t => {
  for (const target of ['binary', 'manifest']) {
    await t.test(target, async t2 => {
      const f = fixture(t2);
      const armed = f.arm();
      const digest = f.writeResult();
      if (target === 'binary') fs.appendFileSync(f.codexExecutable, '# changed\n');
      else fs.appendFileSync(f.manifestFile, ' ');
      await assert.rejects(
        f.service.complete({ callbackId: armed.callbackId, expectedResultSha256: digest }),
        error => error.code === (target === 'binary' ? 'callback_codex_executable_changed' : 'callback_manifest_changed')
      );
      assert.equal(f.clients.length, 0);
    });
  }
});
