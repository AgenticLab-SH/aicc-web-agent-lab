import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { ResourceLeaseManager } from '../src/control-plane/resource-lease.mjs';
import { BrowserPool, BrowserPoolError } from '../src/browser/pool.mjs';
import { FocusGuard, FocusGuardError, selectInteractionRoute } from '../src/control-plane/focus-guard.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-interaction-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new DurableJobStore({ root });
  const resourceLeases = new ResourceLeaseManager({ store });
  const slots = [
    { slotId: 'auto-9224', identityId: 'cdp-9224', profileRoot: 'C:/AICC/browser/9224', cdpEndpoint: 'http://127.0.0.1:9224', automation: true },
    { slotId: 'auto-9225', identityId: 'cdp-9225', profileRoot: 'C:/AICC/browser/9225', cdpEndpoint: 'http://127.0.0.1:9225', automation: true }
  ];
  return { resourceLeases, pool: new BrowserPool({ resourceLeases, slots }), focus: new FocusGuard({ resourceLeases }) };
}

test('browser pool assigns different CDP slots to concurrent AI tasks', t => {
  const f = fixture(t);
  const a = f.pool.acquire({ ownerTaskId: 'task-a', ownerActorId: 'agent-a' });
  const b = f.pool.acquire({ ownerTaskId: 'task-b', ownerActorId: 'agent-b' });
  assert.notEqual(a.slotId, b.slotId);
  assert.notEqual(a.port, b.port);
  assert.throws(() => f.pool.acquire({ ownerTaskId: 'task-c', ownerActorId: 'agent-c' }), e => e instanceof BrowserPoolError && e.code === 'browser_pool_exhausted');
  f.pool.release(a);
  const c = f.pool.acquire({ ownerTaskId: 'task-c', ownerActorId: 'agent-c' });
  assert.equal(c.slotId, a.slotId);
});

test('browser pool rejects user-owned and duplicate slot identities', t => {
  const f = fixture(t);
  assert.throws(() => new BrowserPool({ resourceLeases: f.resourceLeases, slots: [{ slotId: 'daily', identityId: 'daily', profileRoot: 'C:/demo/owner/Chrome', cdpEndpoint: 'http://127.0.0.1:9222', automation: false }] }), e => e.code === 'user_browser_slot_prohibited');
  assert.throws(() => new BrowserPool({ resourceLeases: f.resourceLeases, slots: [
    { slotId: 'slot-a', identityId: 'identity-a', profileRoot: 'C:/A', cdpEndpoint: 'http://127.0.0.1:9333', automation: true },
    { slotId: 'slot-b', identityId: 'identity-b', profileRoot: 'C:/B', cdpEndpoint: 'http://127.0.0.1:9333', automation: true }
  ] }), e => e.code === 'duplicate_browser_slot');
});

test('focus guard always prefers background-safe routes over foreground control', () => {
  assert.equal(selectInteractionRoute({ directAvailable: true, foregroundComputerUseAvailable: true }).route, 'direct');
  assert.equal(selectInteractionRoute({ structuredUiAvailable: true, foregroundComputerUseAvailable: true }).route, 'structured-ui');
  assert.equal(selectInteractionRoute({ backgroundBrowserAvailable: true, foregroundComputerUseAvailable: true }).route, 'background-browser');
});

test('foreground control requires exact target, idle user, and an exclusive focus lease', t => {
  const f = fixture(t);
  assert.throws(() => f.focus.begin({ ownerTaskId: 'task-a', ownerActorId: 'agent-a', exactTargetId: 'window-1', userActive: true, routeOptions: { foregroundComputerUseAvailable: true } }), e => e instanceof FocusGuardError && e.code === 'user_focus_busy');
  const a = f.focus.begin({ ownerTaskId: 'task-a', ownerActorId: 'agent-a', exactTargetId: 'window-1', userActive: false, routeOptions: { foregroundComputerUseAvailable: true } });
  assert.equal(a.foreground, true);
  assert.equal(f.focus.authorize(a).ok, true);
  assert.throws(() => f.focus.begin({ ownerTaskId: 'task-b', ownerActorId: 'agent-b', exactTargetId: 'window-1', routeOptions: { foregroundComputerUseAvailable: true } }), e => e.code === 'resource_busy');
  assert.equal(f.focus.end(a).released, true);
});

test('coordinate fallback is never selected implicitly', () => {
  assert.throws(() => selectInteractionRoute({ exactTargetId: 'window-1' }), e => e.code === 'interaction_route_unavailable');
  assert.equal(selectInteractionRoute({ exactTargetId: 'window-1', coordinateFallbackAllowed: true }).route, 'coordinate-fallback');
});