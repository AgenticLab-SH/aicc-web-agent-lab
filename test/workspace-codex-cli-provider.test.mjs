import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createCodexCliExecutor } from '../components/workspace-mcp/codex-cli-provider.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Keep bounded temp evidence; operational cleanup is separate from these tests.
function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-codex-dispatch-'));
  const workspace = { alias: 'fixture', root: path.join(root, 'workspace') };
  const operations = path.join(root, 'operations');
  fs.mkdirSync(path.join(workspace.root, '.git'), { recursive: true });
  fs.mkdirSync(operations);
  const binding = { schemaVersion: 1, kind: 'aicc-codex-cli-owner-binding',
    bindingId: 'fixture-binding-01', executionBoundary: 'owner-registered-codex-cli-workspace-write',
    workspaceAlias: workspace.alias, workspaceRoot: workspace.root, operationDirectory: operations,
    blockedPromptHashes: [], models: { native: ['fixture-model'], ocx: ['fixture-model'] },
    reasoningEfforts: ['medium'], timeoutMs: 10000, maximumPromptBytes: 1024, maximumOutputBytes: 8192 };
  for (const name of ['codex', 'powershell', 'launcher', 'processJob']) {
    binding[name] = path.join(root, name);
    fs.writeFileSync(binding[name], name);
    binding[name + 'Sha256'] = sha(name);
  }
  const bindingFile = path.join(root, 'binding.json');
  const config = { surfaceProfile: 'business-full', workspaces: [workspace], codexCli: { enabled: true } };
  function seal() {
    fs.writeFileSync(bindingFile, JSON.stringify(binding));
    config.codexCli.bindings = { fixture: { bindingFile, bindingSha256: sha(fs.readFileSync(bindingFile)) } };
  }
  seal();
  const bytes = Buffer.from('한글 marker only, no tools');
  fs.writeFileSync(path.join(workspace.root, 'prompt.txt'), bytes);
  const input = { operation_id: 'fixture-operation-01', route: 'native', model: 'fixture-model',
    reasoning_effort: 'medium', prompt_path: 'prompt.txt', prompt_sha256: sha(bytes) };
  const lease = { leaseId: 'fixture-lease-01', expiresAt: new Date(Date.now() + 60000).toISOString() };
  const children = [], calls = [];
  const prepareLaunch = options.prepareLaunch ?? (async (route, args) => {
    calls.push({ route, args });
    return { invocation: { args, provider: route === 'ocx' ? 'opencodex' : 'openai' }, environment: {} };
  });
  const executor = createCodexCliExecutor(config, { prepareLaunch, spawn: () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { child.killed = true; return true; };
    children.push(child); return child;
  } });
  return { workspace, operations, binding, input, lease, executor, children, calls, seal };
}
const windows = { skip: process.platform !== 'win32' };

test('unregistered alias reports missing owner binding before prompt or operation dispatch', windows, async () => {
  const f = fixture();
  const unregistered = { ...f.workspace, alias: 'unregistered-workspace' };
  assert.throws(() => f.executor.status(unregistered, f.input.operation_id), /CODEX_CLI_WORKSPACE_NOT_REGISTERED/);
  await assert.rejects(f.executor.start(unregistered, f.input, f.lease), /CODEX_CLI_WORKSPACE_NOT_REGISTERED/);
  assert.equal(f.children.length, 0);
  assert.deepEqual(fs.readdirSync(f.operations), []);
});

test('dispatch requires exact prompt bytes, pinned runtime and allowed route', windows, async () => {
  const f = fixture();
  await assert.rejects(f.executor.start(f.workspace, { ...f.input, prompt_sha256: '0'.repeat(64) }, f.lease), /Exact prompt bytes/);
  await assert.rejects(f.executor.start(f.workspace, { ...f.input, route: 'other' }, f.lease), /outside the owner binding/);
  await assert.rejects(f.executor.start(f.workspace, { ...f.input, prompt_path: '../prompt.txt' }, f.lease), /non-hidden/);
  f.binding.blockedPromptHashes = [f.input.prompt_sha256]; f.seal();
  await assert.rejects(f.executor.start(f.workspace, f.input, f.lease), /Previously denied/);
  assert.equal(f.children.length, 0);
  fs.writeFileSync(f.binding.codex, 'changed');
  await assert.rejects(f.executor.start(f.workspace, f.input, f.lease), /pin changed/);
});

test('durable operation deduplicates, locks overlapping writes and seals completion', windows, async () => {
  const f = fixture();
  await f.executor.start(f.workspace, f.input, f.lease);
  await f.executor.start(f.workspace, f.input, f.lease);
  assert.equal(f.children.length, 1);
  assert.throws(() => f.executor.assertNoWriter(f.workspace), /owns this workspace/);
  await assert.rejects(f.executor.start(f.workspace, { ...f.input, route: 'ocx' }, f.lease), /different input/);
  const child = f.children[0];
  child.stdout.write('{"type":"thread.started","thread_id":"12345678-1234-1234-1234-123456789abc"}\n{"type":"turn.sta');
  child.stdout.write('rted"}\n{"type":"turn.completed"}\n');
  assert.equal(f.executor.status(f.workspace, f.input.operation_id).status, 'TASK_STARTED');
  fs.writeFileSync(path.join(f.operations, f.input.operation_id + '.result.md'), '한글_OK');
  child.emit('close', 0);
  const status = f.executor.status(f.workspace, f.input.operation_id);
  assert.equal(status.status, 'COMPLETED'); assert.equal(status.result, '한글_OK');
  assert.equal(status.observed_provider, null); assert.equal(status.configured_provider, 'openai');
  assert.equal(status.result_sha256, sha('한글_OK'));
  f.executor.assertNoWriter(f.workspace);
  const recovered = createCodexCliExecutor({ surfaceProfile: 'business-full', workspaces: [f.workspace],
    codexCli: { enabled: true, bindings: { fixture: { bindingFile: path.join(path.dirname(f.operations), 'binding.json'),
      bindingSha256: sha(fs.readFileSync(path.join(path.dirname(f.operations), 'binding.json'))) } } } });
  assert.equal(recovered.status(f.workspace, f.input.operation_id).status, 'COMPLETED');
  fs.appendFileSync(path.join(f.operations, f.input.operation_id + '.result.md'), 'changed');
  assert.throws(() => recovered.status(f.workspace, f.input.operation_id), /result changed/);
});

test('preflight loss of lease never dispatches and confirmed failure releases its own lock', windows, async () => {
  let release;
  const f = fixture({ prepareLaunch: () => new Promise(resolve => { release = resolve; }) });
  const starting = f.executor.start(f.workspace, f.input, f.lease);
  assert.equal(f.executor.activeForLease(f.lease.leaseId), true);
  f.executor.stopLease(f.lease.leaseId);
  release({ invocation: { args: [], provider: 'openai' }, environment: {} });
  await assert.rejects(starting, /preflight rejected/);
  assert.equal(f.children.length, 0);
  assert.equal(f.executor.status(f.workspace, f.input.operation_id).status, 'REJECTED_BEFORE_DISPATCH');
  f.executor.assertNoWriter(f.workspace);
});

test('exit without completed turn and cancelled jobs retain reconciliation lock', windows, async () => {
  for (const cancel of [false, true]) {
    const f = fixture(); await f.executor.start(f.workspace, f.input, f.lease);
    if (cancel) f.executor.stopLease(f.lease.leaseId);
    fs.writeFileSync(path.join(f.operations, f.input.operation_id + '.result.md'), 'partial');
    f.children[0].emit('close', 0);
    assert.equal(f.executor.status(f.workspace, f.input.operation_id).status, 'OUTCOME_UNKNOWN_RECONCILE');
    assert.throws(() => f.executor.assertNoWriter(f.workspace), /reconciliation/);
    await f.executor.start(f.workspace, f.input, f.lease);
    assert.equal(f.children.length, 1);
  }
});

test('ordinary writer check survives a retired CLI binary while preserving real locks', windows, () => {
  const f = fixture();
  fs.unlinkSync(f.binding.codex);
  assert.doesNotThrow(() => f.executor.assertNoWriter(f.workspace));
  fs.writeFileSync(path.join(f.operations, 'writer.lock'), 'unreconciled original operation');
  assert.throws(() => f.executor.assertNoWriter(f.workspace), /owns this workspace/);
});
