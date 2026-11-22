import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { ResourceLeaseManager } from '../src/control-plane/resource-lease.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-resource-lease-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const store = new DurableJobStore({ root, now });
  const manager = new ResourceLeaseManager({ store, now, defaultTtlMs: 10_000, maximumTtlMs: 60_000 });
  return { root, store, manager, advance: ms => { clock += ms; } };
}

test('single writer excludes another writer and readers while active', t => {
  const f = fixture(t);
  const lease = f.manager.acquire({ resourceType: 'workspace-writer', resourceId: 'open-aicc', ownerTaskId: 'task-a', ownerActorId: 'agent-a' });
  assert.equal(lease.accessMode, 'write');
  assert.throws(() => f.manager.acquire({ resourceType: 'workspace-writer', resourceId: 'open-aicc', ownerTaskId: 'task-b', ownerActorId: 'agent-b', accessMode: 'read' }), e => e.code === 'resource_busy');
  assert.throws(() => f.manager.acquire({ resourceType: 'workspace-writer', resourceId: 'open-aicc', ownerTaskId: 'task-b', ownerActorId: 'agent-b' }), e => e.code === 'resource_busy');
});

test('multiple readers can share a resource but block a writer', t => {
  const f = fixture(t);
  f.manager.acquire({ resourceType: 'browser-slot', resourceId: 'slot-01', ownerTaskId: 'task-a', ownerActorId: 'agent-a', accessMode: 'read' });
  f.manager.acquire({ resourceType: 'browser-slot', resourceId: 'slot-01', ownerTaskId: 'task-b', ownerActorId: 'agent-b', accessMode: 'read' });
  assert.equal(f.manager.status().active, 2);
  assert.throws(() => f.manager.acquire({ resourceType: 'browser-slot', resourceId: 'slot-01', ownerTaskId: 'task-c', ownerActorId: 'agent-c', accessMode: 'write' }), e => e.code === 'resource_busy');
});

test('lease authorization is exact and read leases cannot authorize writes', t => {
  const f = fixture(t);
  const lease = f.manager.acquire({ resourceType: 'file-mutation', resourceId: 'repo/a.txt', ownerTaskId: 'task-a', ownerActorId: 'agent-a', accessMode: 'read' });
  assert.equal(f.manager.authorize(lease.leaseId, { resourceType: 'file-mutation', resourceId: 'repo/a.txt', ownerTaskId: 'task-a' }).ok, true);
  assert.throws(() => f.manager.authorize(lease.leaseId, { accessMode: 'write' }), e => e.code === 'resource_scope_denied');
  assert.throws(() => f.manager.authorize(lease.leaseId, { resourceId: 'repo/b.txt' }), e => e.code === 'resource_lease_mismatch');
});

test('expiry is recovered without PID heuristics and generation advances on reacquire', t => {
  const f = fixture(t);
  const first = f.manager.acquire({ resourceType: 'ui-focus', resourceId: 'desktop', ownerTaskId: 'task-a', ownerActorId: 'agent-a' });
  f.advance(11_000);
  const recovered = f.manager.recoverExpired();
  assert.deepEqual(recovered.stale, [first.leaseId]);
  const second = f.manager.acquire({ resourceType: 'ui-focus', resourceId: 'desktop', ownerTaskId: 'task-b', ownerActorId: 'agent-b' });
  assert.equal(second.generation, 2);
  assert.equal(f.manager.status().states.stale, 1);
});

test('lease state survives store restart and owner mismatch cannot release it', t => {
  const f = fixture(t);
  const lease = f.manager.acquire({ resourceType: 'deployment', resourceId: 'a1-relay', ownerTaskId: 'task-a', ownerActorId: 'agent-a', recoveryRef: 'receipt-001' });
  const store2 = new DurableJobStore({ root: f.root, now: () => 1_800_000_000_500 });
  const manager2 = new ResourceLeaseManager({ store: store2, now: () => 1_800_000_000_500 });
  assert.equal(manager2.authorize(lease.leaseId, { ownerTaskId: 'task-a', ownerActorId: 'agent-a' }).generation, 1);
  assert.throws(() => manager2.release(lease.leaseId, { ownerTaskId: 'task-x', ownerActorId: 'agent-a' }), e => e.code === 'resource_lease_mismatch');
  const released = manager2.release(lease.leaseId, { ownerTaskId: 'task-a', ownerActorId: 'agent-a', reason: 'completed' });
  assert.equal(released.state, 'released');
});