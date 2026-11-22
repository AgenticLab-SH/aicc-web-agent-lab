import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { JobManager } from '../src/jobs/job-manager.mjs';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { createOobReadJobSpec, normalizeOobAdapterDescriptor, OobAdapterError } from '../src/remote/oob-adapter.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const descriptor = {
  schemaVersion: 1,
  adapterId: 'remote-desktop-commander',
  routeClass: 'oob_ops',
  transport: 'remote-mcp',
  defaultMode: 'read-only',
  normalFallback: false,
  recoveryOnly: true,
  sharesWorkspaceTunnel: false,
  sharesWorkspaceIdentity: false,
  storesRawCredentials: false,
  capabilities: ['filesystem-read', 'process-inspect', 'terminal-exec', 'gui-recovery']
};

test('OOB descriptor preserves a separate failure domain and read-only default', () => {
  const value = normalizeOobAdapterDescriptor(descriptor);
  assert.equal(value.routeClass, 'oob_ops');
  assert.equal(value.defaultMode, 'read-only');
  assert.equal(value.normalFallback, false);
  assert.equal(value.sharesWorkspaceTunnel, false);
  assert.equal(value.sharesWorkspaceIdentity, false);
  assert.equal(value.storesRawCredentials, false);
});

test('OOB descriptor rejects silent fallback, Workspace identity sharing and raw credential storage', () => {
  for (const override of [
    { normalFallback: true },
    { sharesWorkspaceTunnel: true },
    { sharesWorkspaceIdentity: true },
    { storesRawCredentials: true },
    { defaultMode: 'write' }
  ]) {
    assert.throws(() => normalizeOobAdapterDescriptor({ ...descriptor, ...override }),
      error => error instanceof OobAdapterError);
  }
});

test('OOB read bridge creates an explicit Job v2 route without raw device identity', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-oob-job-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new JobManager({ store: new DurableJobStore({ root }) });
  const routeInstanceRef = crypto.createHash('sha256').update('private-device-id').digest('hex');
  const requestHash = crypto.createHash('sha256').update('status').digest('hex');
  const spec = createOobReadJobSpec({
    descriptor,
    jobId: 'oob-job-1',
    operationId: 'oob-op-1',
    idempotencyKey: 'oob-key-1',
    workspaceId: '/workspace/a',
    identityBinding: 'oob-identity-ref',
    routeInstanceRef,
    requestRef: 'request://oob/status',
    requestHash
  });
  const job = manager.submit(spec).job;
  assert.equal(job.contractVersion, 2);
  assert.equal(job.direction, 'oob_ops');
  assert.equal(job.routeClass, 'oob_ops');
  assert.equal(job.requestedRoute, 'remote-desktop-commander');
  assert.equal(job.routeInstanceRef, routeInstanceRef);
  assert.equal(job.mode, 'read-only');
  assert.equal(JSON.stringify(job).includes('private-device-id'), false);
});

test('OOB bridge requires hashed route instance identity', () => {
  assert.throws(() => createOobReadJobSpec({
    descriptor,
    jobId: 'oob-job-2',
    idempotencyKey: 'oob-key-2',
    workspaceId: '/workspace/a',
    identityBinding: 'oob-identity-ref',
    routeInstanceRef: 'raw-device-id',
    requestRef: 'request://oob/status',
    requestHash: 'a'.repeat(64)
  }), error => error instanceof OobAdapterError && error.code === 'oob_identity_ref_invalid');
});
