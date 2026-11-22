import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { workspaceAppSyncStatus } from '../src/workspace-app-status.mjs';

test('app sync status exposes separate Business and Personal vectors without claiming remote readiness', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-app-status-'));
  try {
    const status = workspaceAppSyncStatus({ stateRoot });
    assert.equal(status.state, 'attention');
    assert.equal(status.topologyReady, false);
    const businessCounts = process.platform === 'darwin' ? [22, 17, 5] : [19, 17, 2];
    assert.deepEqual(status.surfaces.map(item => [item.surfaceProfile, item.toolCount, item.readToolCount, item.writeToolCount]), [
      ['business-full', ...businessCounts],
      ['personal-read-fetch', 18, 18, 0]
    ]);
    assert.equal(status.surfaces.every(item => item.source === 'pass' && item.browserVisible === 'unknown'), true);
    assert.equal(status.automaticHardDeleteAllowed, false);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('app sync status plans exact per-account actions from owner-only topology and inventory', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-app-status-plan-'));
  try {
    const root = path.join(stateRoot, 'workspace-app-sync');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'topology.json'), JSON.stringify({
      schemaVersion: 1,
      logicalPluginId: 'aicc-workspace',
      accounts: [{ accountAlias: 'account3-personal', role: 'owner', surfaceProfile: 'personal-read-fetch', remoteAppId: null }]
    }));
    fs.writeFileSync(path.join(root, 'inventory.json'), JSON.stringify({
      schemaVersion: 1,
      inventories: [{ accountAlias: 'account3-personal', observedAt: '2026-08-22T00:00:00.000Z', apps: [] }]
    }));
    const status = workspaceAppSyncStatus({ stateRoot });
    assert.equal(status.topologyReady, true);
    assert.equal(status.accountBindings[0].actions[0].action, 'create');
    assert.equal(status.pendingActions.length, 1);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('app sync status exposes configured stable bindings without pretending browser inventory exists', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-app-status-topology-'));
  try {
    const root = path.join(stateRoot, 'workspace-app-sync');
    fs.mkdirSync(root, { recursive: true });
    const businessId = 'plugin_asdk_app_business123';
    fs.writeFileSync(path.join(root, 'topology.json'), JSON.stringify({
      schemaVersion: 1,
      logicalPluginId: 'aicc-workspace',
      accounts: [
        { accountAlias: 'account1-owner', role: 'owner', surfaceProfile: 'business-full', remoteAppId: businessId },
        { accountAlias: 'account2-member', role: 'member', ownerAccountAlias: 'account1-owner', surfaceProfile: 'business-full', remoteAppId: businessId },
        { accountAlias: 'account3-personal', role: 'owner', surfaceProfile: 'personal-read-fetch', remoteAppId: 'plugin_asdk_app_personal123' }
      ]
    }));
    const status = workspaceAppSyncStatus({ stateRoot });
    assert.equal(status.topologyPresent, true);
    assert.equal(status.inventoryPresent, false);
    assert.equal(status.topologyReady, false);
    assert.equal(status.accountBindings.length, 3);
    assert.equal(status.accountBindings[1].ownerAccountAlias, 'account1-owner');
    assert.equal(status.accountBindings[2].remoteAppId, 'plugin_asdk_app_personal123');
    assert.equal(status.accountBindings.every(item => item.observation === 'configured-only'), true);
    assert.match(status.detail, /3개 계정 binding.*browser inventory/);
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
