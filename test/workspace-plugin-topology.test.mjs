import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWorkspacePluginInventory, planPluginDuplicateQuarantine, planWorkspacePluginSync } from '../src/workspace-plugin-topology.mjs';

function inventory(overrides = {}) {
  return {
    observedAt: '2026-08-24T00:00:00.000Z',
    accountRole: 'personal',
    identityHash: '1'.repeat(64),
    workspaceHash: '2'.repeat(64),
    pluginId: 'aicc.workspace',
    displayName: 'AICC',
    ownerHash: '3'.repeat(64),
    packageVersion: '1.0.0',
    packageHash: '4'.repeat(64),
    installState: 'installed',
    installationPolicy: 'optional',
    canRefresh: true,
    supportedSurfaces: ['chat'],
    skills: [{ id: 'aicc.restore', version: '1', hash: '5'.repeat(64), required: true }],
    apps: [{ id: 'asdk_app_personal', version: '18', hash: '6'.repeat(64), required: true }],
    appTemplates: [],
    appSnapshotCurrent: true,
    permissionPolicy: 'never-ask-read-only',
    ...overrides
  };
}

test('plugin inventory binds stable package and included assets to hashed account lineage', () => {
  const normalized = normalizeWorkspacePluginInventory(inventory());
  assert.match(normalized.inventoryHash, /^[a-f0-9]{64}$/);
  assert.equal(normalized.rawAccountIncluded, false);
  assert.equal(normalized.authMaterialIncluded, false);
  assert.throws(() => normalizeWorkspacePluginInventory(inventory({ skills: [inventory().skills[0], inventory().skills[0]] })), error => error.code === 'included_assets_duplicate');
});

test('plugin refresh and frozen app recreation remain separate actions', () => {
  const desired = inventory({ packageVersion: '2.0.0', packageHash: '7'.repeat(64), appSnapshotCurrent: false });
  const plan = planWorkspacePluginSync({ desired, observed: inventory() });
  assert.equal(plan.action, 'refresh_candidate');
  assert.equal(plan.reason, 'package_drift');
  assert.equal(plan.appAction.action, 'separate_app_recreate_or_republish');
});

test('identity mismatch and unsupported Personal package fail closed', () => {
  const mismatch = planWorkspacePluginSync({ desired: inventory(), observed: inventory({ workspaceHash: '8'.repeat(64) }) });
  assert.equal(mismatch.action, 'hold');
  assert.equal(mismatch.reason, 'identity_or_workspace_mismatch');
  const unsupported = planWorkspacePluginSync({ desired: inventory({ installationPolicy: 'unsupported', installState: 'unsupported' }), observed: null });
  assert.equal(unsupported.reason, 'plugin_unsupported_on_surface');
});

test('duplicate cleanup uses stable IDs and reference graph, never names or hard delete', () => {
  const canonical = inventory();
  const oldReferenced = inventory({ pluginId: 'aicc.workspace.old1', packageHash: '8'.repeat(64) });
  const oldFree = inventory({ pluginId: 'aicc.workspace.old2', packageHash: '9'.repeat(64) });
  const plan = planPluginDuplicateQuarantine({
    canonicalPluginId: canonical.pluginId,
    inventory: [canonical, oldReferenced, oldFree],
    references: { [oldReferenced.pluginId]: ['asdk_app_shared'] }
  });
  assert.equal(plan.find(item => item.pluginId === oldReferenced.pluginId).action, 'retain');
  assert.deepEqual(plan.find(item => item.pluginId === oldFree.pluginId), { pluginId: oldFree.pluginId, action: 'disable_candidate', reason: 'reference_zero', quarantineDays: 14, hardDelete: false });
});
