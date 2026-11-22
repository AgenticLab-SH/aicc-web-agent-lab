import assert from 'node:assert/strict';
import test from 'node:test';
import { planWorkspaceAppSync } from '../src/workspace-app-lifecycle.mjs';
import { enumerateWorkspaceAppSyncOperations, executeWorkspaceAppSyncOperation } from '../src/workspace-app-sync-executor.mjs';

const h1 = '1'.repeat(64);
const h2 = '2'.repeat(64);
const desired = {
  accountAlias: 'account3-personal', role: 'owner', surfaceProfile: 'personal-read-fetch', remoteAppId: null,
  manifestHash: h1, toolCatalogHash: h2, toolCounts: { total: 18, read: 18, write: 0 }
};
const empty = { accountAlias: 'account3-personal', observedAt: '2026-08-22T00:00:00.000Z', apps: [] };

test('one-shot executor dry-run performs no remote mutation and binds the fresh inventory hash', async () => {
  const plan = planWorkspaceAppSync({ logicalPluginId: 'aicc-workspace', desiredAccounts: [desired], inventories: [empty] });
  const operation = enumerateWorkspaceAppSyncOperations(plan).operations[0];
  let applied = 0;
  const result = await executeWorkspaceAppSyncOperation({ plan, operationId: operation.operationId }, {
    inspect: async () => empty,
    apply: async () => { applied += 1; }
  });
  assert.equal(result.terminal, 'DRY_RUN');
  assert.equal(applied, 0);
});

test('one-shot executor creates and post-reads one exact Personal replica', async () => {
  const plan = planWorkspaceAppSync({ logicalPluginId: 'aicc-workspace', desiredAccounts: [desired], inventories: [empty] });
  const operation = enumerateWorkspaceAppSyncOperations(plan).operations[0];
  let inventory = structuredClone(empty);
  let dispatches = 0;
  const result = await executeWorkspaceAppSyncOperation({ plan, operationId: operation.operationId, commit: true }, {
    inspect: async () => inventory,
    apply: async () => {
      dispatches += 1;
      inventory = { ...inventory, observedAt: '2026-08-22T00:01:00.000Z', apps: [{
        appId: 'plugin_asdk_app_created123', status: 'ENABLED', family: 'aicc-workspace', logicalPluginId: 'aicc-workspace',
        manifestHash: h1, toolCatalogHash: h2, surfaceProfile: 'personal-read-fetch', toolCounts: { total: 18, read: 18, write: 0 }
      }] };
      return { appId: 'plugin_asdk_app_created123' };
    }
  });
  assert.equal(result.terminal, 'PASS');
  assert.equal(dispatches, 1);
});

test('one-shot executor holds a stale plan and seals ambiguous dispatch without retry', async () => {
  const plan = planWorkspaceAppSync({ logicalPluginId: 'aicc-workspace', desiredAccounts: [desired], inventories: [empty] });
  const operation = enumerateWorkspaceAppSyncOperations(plan).operations[0];
  const changed = { ...empty, apps: [{ appId: 'plugin_asdk_app_other123', status: 'ENABLED' }] };
  const stale = await executeWorkspaceAppSyncOperation({ plan, operationId: operation.operationId, commit: true }, {
    inspect: async () => changed,
    apply: async () => assert.fail('stale plans cannot dispatch')
  });
  assert.equal(stale.terminal, 'HOLD');
  const uncertain = await executeWorkspaceAppSyncOperation({ plan, operationId: operation.operationId, commit: true }, {
    inspect: async () => empty,
    apply: async () => { throw new Error('network outcome missing'); }
  });
  assert.equal(uncertain.terminal, 'UNCERTAIN');
  assert.equal(uncertain.retryAllowed, false);
});
