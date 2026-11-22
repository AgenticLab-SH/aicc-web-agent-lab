import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runWorkspaceSnapshotCommand } from '../src/workspace-snapshots/command.mjs';

function encoded(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

test('task snapshot state rejects outside paths and symlinks before creating a cache', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-snapshot-boundary-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const request=['--request-base64',encoded({action:'query',snapshotId:'unused'})];
  assert.throws(()=>runWorkspaceSnapshotCommand([...request,'--state-root',os.tmpdir()],{cwd:directory,service:{}}),/exact project/);
  assert.throws(()=>runWorkspaceSnapshotCommand([...request,'--state-root','relative'],{cwd:directory,service:{}}),/exact project/);
  const state=path.join(fs.realpathSync(directory),'.aicc-workspace-snapshots');
  fs.symlinkSync(os.tmpdir(),state,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>runWorkspaceSnapshotCommand([...request,'--state-root',state],{cwd:directory,service:{}}),/link or file/);
});

test('workspace snapshot command keeps request JSON out of the plain argument and dispatches begin_query', () => {
  const calls = [];
  const service = {
    begin(request) {
      calls.push(['begin', request]);
      return { manifest: { snapshotId: `snapshot_${'1'.repeat(64)}`, root: '/safe/project' }, reused: false };
    },
    query(request) {
      calls.push(['query', request]);
      return { snapshotId: request.snapshotId, cacheHit: false, results: [] };
    },
  };
  const request = {
    action: 'begin_query',
    toolSchemaHash: 'a'.repeat(64),
    selectedUntrackedPaths: ['notes.txt'],
    operations: [{ type: 'status' }],
  };
  const token = encoded(request);
  const result = runWorkspaceSnapshotCommand(['--request-base64', token], { cwd: '/safe/project', service });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ['begin', { root: '/safe/project', toolSchemaHash: request.toolSchemaHash, selectedUntrackedPaths: ['notes.txt'] }],
    ['query', { snapshotId: `snapshot_${'1'.repeat(64)}`, operations: [{ type: 'status' }] }],
  ]);
  assert.equal('root' in result.begun.manifest, false);
  assert.doesNotMatch(token, /notes\.txt|status/);
});

test('workspace snapshot command rejects oversized, malformed and unknown requests', () => {
  assert.throws(() => runWorkspaceSnapshotCommand([], { service: {} }), /--request-base64/);
  assert.throws(() => runWorkspaceSnapshotCommand(['--request-base64', 'not-safe!'], { service: {} }), /invalid/);
  assert.throws(
    () => runWorkspaceSnapshotCommand(['--request-base64', encoded({ action: 'live_process_status' })], { service: {} }),
    /unsupported workspace snapshot action/,
  );
});

test('workspace snapshot command exposes bounded CAS metadata and an explicit local bundle artifact', () => {
  const calls = [];
  const service = {
    materialize(request) {
      calls.push(['materialize', request]);
      return { snapshotId: request.snapshotId, treeDigest: 'c'.repeat(64), root: '/owner-only/cas/tree', reused: false };
    },
    exportPortableBundle(request) {
      calls.push(['export', request]);
      return { ok: true, snapshotId: request.snapshotId, path: '/owner-only/bundles/snapshot.zip', sha256: 'd'.repeat(64), reused: false };
    },
  };
  const snapshotId = `snapshot_${'2'.repeat(64)}`;
  const materialized = runWorkspaceSnapshotCommand(['--request-base64', encoded({ action: 'materialize', snapshotId })], { service });
  assert.equal('root' in materialized.materialized, false);
  const exported = runWorkspaceSnapshotCommand(['--request-base64', encoded({ action: 'export_bundle', snapshotId })], { service });
  assert.equal(exported.bundle.path, '/owner-only/bundles/snapshot.zip');
  assert.deepEqual(calls, [
    ['materialize', { snapshotId }],
    ['export', { snapshotId }],
  ]);
});

test('workspace snapshot command accepts one owner-only request file and dispatches the change lifecycle', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-workspace-command-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const service = {
    planChange(request) { calls.push(['plan', request]); return { plan: { operationId: `change_${'1'.repeat(64)}` }, duplicate: false }; },
    applyVerifyChange(request) { calls.push(['apply', request]); return { operationId: request.operationId, state: { phase: 'VERIFIED' } }; },
    reconcileChange(request) { calls.push(['reconcile', request]); return { operationId: request.operationId, state: { phase: 'VERIFIED' }, action: 'none' }; },
    rollbackChange(request) { calls.push(['rollback', request]); return { operationId: request.operationId, state: { phase: 'ROLLED_BACK' } }; },
    changeStatus(request) { calls.push(['status', request]); return { plan: { operationId: request.operationId }, state: { phase: 'ROLLED_BACK' } }; },
  };
  const operationId = `change_${'1'.repeat(64)}`;
  const planHash = '2'.repeat(64);
  const requests = [
    { action: 'plan_change', snapshotId: `snapshot_${'3'.repeat(64)}`, changes: [{ type: 'delete', path: 'old.txt' }], verification: [{ type: 'node_test', paths: ['test/a.test.mjs'] }] },
    { action: 'apply_verify_change', operationId, planHash },
    { action: 'reconcile_change', operationId, planHash },
    { action: 'rollback_change', operationId, planHash, reason: 'operator_request' },
    { action: 'change_status', operationId, planHash },
  ];
  for (const [index, request] of requests.entries()) {
    const file = path.join(directory, `${index}.json`);
    fs.writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
    const result = runWorkspaceSnapshotCommand(['--request-file', file], { cwd: '/safe/project', service });
    assert.equal(result.ok, true);
    assert.equal(result.action, request.action);
  }
  assert.deepEqual(calls, [
    ['plan', { snapshotId: requests[0].snapshotId, changes: requests[0].changes, verification: requests[0].verification }],
    ['apply', { operationId, planHash }],
    ['reconcile', { operationId, planHash }],
    ['rollback', { operationId, planHash, reason: 'operator_request' }],
    ['status', { operationId, planHash }],
  ]);
  assert.throws(
    () => runWorkspaceSnapshotCommand(['--request-base64', encoded({ action: 'query' }), '--request-file', path.join(directory, '0.json')], { service }),
    /exactly one/,
  );
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(directory, '0.json'), 0o644);
    assert.throws(() => runWorkspaceSnapshotCommand(['--request-file', path.join(directory, '0.json')], { service }), /unsafe/);
  }
});
