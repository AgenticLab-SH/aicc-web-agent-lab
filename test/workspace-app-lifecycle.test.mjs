import assert from 'node:assert/strict';
import test from 'node:test';
import { planWorkspaceAppCleanup, planWorkspaceAppSync, verifyWorkspaceAppSyncPostRead } from '../src/workspace-app-lifecycle.mjs';

const canonicalAppId = 'asdk_app_current123';
const rollbackAppId = 'asdk_app_rollback123';

function inventory() {
  const referenceProof = {
    lineageVerified: true,
    requiredReferenceScopes: ['publication-state', 'account-inventory', 'saved-conversation-links'],
    completedReferenceScopes: ['publication-state', 'account-inventory', 'saved-conversation-links'],
    unknownReferenceScopes: [],
    knownReferences: []
  };
  return [
    { appId: canonicalAppId, name: 'AICC current', status: 'ENABLED' },
    { appId: rollbackAppId, name: 'AICC rollback', status: 'ENABLED' },
    {
      appId: 'asdk_app_oldenabled123', name: 'AICC old enabled', status: 'ENABLED', managedByAicc: true,
      family: 'aicc-workspace', supersededByAppId: canonicalAppId, ...referenceProof
    },
    {
      appId: 'asdk_app_oldquarantine123', name: 'AICC old disabled', status: 'DISABLED', managedByAicc: true,
      family: 'aicc-workspace', supersededByAppId: canonicalAppId, ...referenceProof,
      disabledAt: '2026-07-01T00:00:00.000Z'
    },
    { appId: 'asdk_app_other123', name: 'Other', status: 'ENABLED', managedByAicc: false }
  ];
}

test('cleanup retains canonical and rollback, disables first, then emits an exact delete candidate only after quarantine', () => {
  const plan = planWorkspaceAppCleanup({
    canonicalAppId, rollbackAppId, observedAt: '2026-08-17T00:00:00.000Z', quarantineDays: 14,
    requiredAccountAliases: ['account1', 'account2'], passedAccountAliases: ['account1', 'account2'],
    hardDeleteCapability: 'verified-visible-ui', rollbackRehearsed: true, items: inventory()
  });
  assert.deepEqual(plan.actions.map(item => [item.appId, item.action]), [
    [canonicalAppId, 'retain'],
    [rollbackAppId, 'retain'],
    ['asdk_app_oldenabled123', 'disable'],
    ['asdk_app_oldquarantine123', 'delete_candidate'],
    ['asdk_app_other123', 'ignore']
  ]);
  assert.deepEqual(plan.deleteCandidateAppIds, ['asdk_app_oldquarantine123']);
  assert.equal(plan.automaticHardDeleteAllowed, false);
});

test('cleanup holds hard deletion when the current product surface has not proved it', () => {
  const plan = planWorkspaceAppCleanup({
    canonicalAppId, rollbackAppId, observedAt: '2026-08-17T00:00:00.000Z', quarantineDays: 14,
    requiredAccountAliases: ['account1', 'account2'], passedAccountAliases: ['account1', 'account2'], items: inventory()
  });
  assert.equal(plan.actions.find(item => item.appId === 'asdk_app_oldquarantine123').action, 'hold');
  assert.equal(plan.actions.find(item => item.appId === 'asdk_app_oldquarantine123').reason, 'hard_delete_capability_unverified');
  assert.equal(plan.automaticHardDeleteAllowed, false);
});

test('cleanup never disables or deletes before every required account canary passes', () => {
  const plan = planWorkspaceAppCleanup({
    canonicalAppId, rollbackAppId, observedAt: '2026-08-17T00:00:00.000Z', quarantineDays: 14,
    requiredAccountAliases: ['account1', 'account2'], passedAccountAliases: ['account1'], items: inventory()
  });
  assert.equal(plan.accountCanaryReady, false);
  assert.equal(plan.actions.filter(item => item.appId.includes('old')).every(item => item.action === 'hold'), true);
  assert.equal(plan.automaticHardDeleteAllowed, false);
});

test('cleanup fails closed for legacy reference counts and incomplete or unknown reference scopes', () => {
  const cases = [
    { referenceCount: 0 },
    {
      lineageVerified: true,
      requiredReferenceScopes: ['publication-state', 'account-inventory'],
      completedReferenceScopes: ['publication-state'],
      unknownReferenceScopes: [],
      knownReferences: []
    },
    {
      lineageVerified: true,
      requiredReferenceScopes: ['publication-state'],
      completedReferenceScopes: ['publication-state'],
      unknownReferenceScopes: ['saved-conversation-links'],
      knownReferences: []
    }
  ];
  for (const candidate of cases) {
    const items = inventory();
    items[2] = {
      appId: 'asdk_app_oldenabled123', name: 'AICC old enabled', status: 'ENABLED', managedByAicc: true,
      family: 'aicc-workspace', supersededByAppId: canonicalAppId, ...candidate
    };
    const plan = planWorkspaceAppCleanup({
      canonicalAppId, rollbackAppId, observedAt: '2026-08-17T00:00:00.000Z', quarantineDays: 14,
      requiredAccountAliases: ['account1'], passedAccountAliases: ['account1'],
      hardDeleteCapability: 'verified-visible-ui', rollbackRehearsed: true, items
    });
    assert.equal(plan.actions[2].action, 'hold');
  }
});

test('cleanup retains an app when a completed reference scope still contains a known reference', () => {
  const items = inventory();
  items[2].knownReferences = ['saved-conversation:conversation-redacted'];
  const plan = planWorkspaceAppCleanup({
    canonicalAppId, rollbackAppId, observedAt: '2026-08-17T00:00:00.000Z', quarantineDays: 14,
    requiredAccountAliases: ['account1'], passedAccountAliases: ['account1'], items
  });
  assert.equal(plan.actions[2].action, 'retain');
  assert.equal(plan.actions[2].reason, 'live_reference');
});

const h1 = '1'.repeat(64);
const h2 = '2'.repeat(64);
const h3 = '3'.repeat(64);
const h4 = '4'.repeat(64);

function syncInput() {
  return {
    logicalPluginId: 'aicc-workspace',
    desiredAccounts: [
      {
        accountAlias: 'account1-business-owner', role: 'owner', surfaceProfile: 'business-full',
        remoteAppId: 'asdk_app_business123', manifestHash: h1, toolCatalogHash: h2,
        toolCounts: { total: 22, read: 17, write: 5 }
      },
      {
        accountAlias: 'account2-business-member', role: 'member', ownerAccountAlias: 'account1-business-owner',
        surfaceProfile: 'business-full', remoteAppId: 'asdk_app_business123', manifestHash: h1, toolCatalogHash: h2,
        toolCounts: { total: 22, read: 17, write: 5 }
      },
      {
        accountAlias: 'account3-personal', role: 'owner', surfaceProfile: 'personal-read-fetch',
        remoteAppId: 'asdk_app_personal123', manifestHash: h3, toolCatalogHash: h4,
        toolCounts: { total: 18, read: 18, write: 0 }
      }
    ],
    inventories: [
      {
        accountAlias: 'account1-business-owner', observedAt: '2026-08-22T00:00:00.000Z', apps: [
          {
            appId: 'asdk_app_business123', status: 'ENABLED', family: 'aicc-workspace', logicalPluginId: 'aicc-workspace',
            manifestHash: h1, toolCatalogHash: h2, surfaceProfile: 'business-full', toolCounts: { total: 22, read: 17, write: 5 },
            canUpdate: true, canDisable: true, canDelete: true, canShare: true
          },
          {
            appId: 'asdk_app_oldbusiness123', status: 'ENABLED', family: 'aicc-workspace', logicalPluginId: 'aicc-workspace',
            manifestHash: h1, toolCatalogHash: h2, surfaceProfile: 'business-full', toolCounts: { total: 22, read: 17, write: 5 },
            canDisable: true, canDelete: true, referenceState: 'zero', preimageHash: '5'.repeat(64)
          }
        ]
      },
      {
        accountAlias: 'account2-business-member', observedAt: '2026-08-22T00:00:00.000Z', apps: [
          {
            appId: 'asdk_app_business123', status: 'ENABLED', family: 'aicc-workspace', logicalPluginId: 'aicc-workspace',
            manifestHash: h1, toolCatalogHash: h2, surfaceProfile: 'business-full', toolCounts: { total: 22, read: 17, write: 5 },
            sharedFromAccountAlias: 'account1-business-owner'
          }
        ]
      },
      {
        accountAlias: 'account3-personal', observedAt: '2026-08-22T00:00:00.000Z', apps: [
          {
            appId: 'asdk_app_personal123', status: 'ENABLED', family: 'aicc-workspace', logicalPluginId: 'aicc-workspace',
            manifestHash: h3, toolCatalogHash: h4, surfaceProfile: 'personal-read-fetch', toolCounts: { total: 18, read: 18, write: 0 },
            canUpdate: true, canDisable: true, canDelete: true
          }
        ]
      }
    ],
    passedCanaryAccounts: ['account1-business-owner', 'account2-business-member', 'account3-personal']
  };
}

test('sync keeps one logical plugin while preserving Business shared and Personal replica failure domains', () => {
  const plan = planWorkspaceAppSync(syncInput());
  assert.equal(plan.topology, 'one-logical-plugin-separate-account-bindings');
  assert.deepEqual(plan.failureDomains, ['business-publication', 'personal-publication']);
  assert.deepEqual(plan.accountPlans.map(item => item.actions[0].action), ['retain', 'retain', 'retain']);
  assert.deepEqual(plan.cleanup, [{
    accountAlias: 'account1-business-owner', appId: 'asdk_app_oldbusiness123', action: 'disable', reason: 'superseded_exact_id'
  }]);
  assert.equal(plan.automaticHardDeleteAllowed, false);
});

test('sync accepts the exact installed plugin ID form used by existing ChatGPT app inventory', () => {
  const input = syncInput();
  const installedId = 'plugin_asdk_app_6a82fd793bb481919b7bb35f1e0737db';
  input.desiredAccounts[0].remoteAppId = installedId;
  input.desiredAccounts[1].remoteAppId = installedId;
  input.inventories[0].apps[0].appId = installedId;
  input.inventories[1].apps[0].appId = installedId;
  const plan = planWorkspaceAppSync(input);
  assert.equal(plan.accountPlans[0].actions[0].appId, installedId);
  assert.equal(plan.accountPlans[1].actions[0].appId, installedId);
});

test('sync expresses create, update, share, disable and exact authorized delete without name authority', () => {
  const input = syncInput();
  input.desiredAccounts[0].remoteAppId = null;
  input.desiredAccounts[1].remoteAppId = null;
  input.desiredAccounts[2].manifestHash = '6'.repeat(64);
  input.inventories[0].apps = [];
  input.inventories[1].apps = [];
  input.inventories[2].apps[0].manifestHash = h3;
  const plan = planWorkspaceAppSync(input);
  assert.equal(plan.accountPlans[0].actions[0].action, 'create');
  assert.equal(plan.accountPlans[1].actions[0].action, 'hold');
  assert.equal(plan.accountPlans[2].actions[0].action, 'update');

  const deletion = syncInput();
  deletion.inventories[0].registered=true;
  deletion.inventories[0].apps[1].status = 'DISABLED';
  deletion.deleteAuthorizations = [{
    accountAlias: 'account1-business-owner', appId: 'asdk_app_oldbusiness123',
    preimageHash: '5'.repeat(64), approvedAt: '2026-08-22T00:01:00.000Z'
  }];
  assert.equal(planWorkspaceAppSync(deletion).cleanup[0].action, 'delete');
});

test('sync holds cleanup until all account canaries pass and never crosses surface permissions', () => {
  const input = syncInput();
  input.passedCanaryAccounts = ['account1-business-owner'];
  assert.equal(planWorkspaceAppSync(input).cleanup[0].reason, 'canonical_canary_incomplete');
  const invalid = syncInput();
  invalid.desiredAccounts[2].toolCounts.write = 1;
  invalid.desiredAccounts[2].toolCounts.total = 19;
  assert.throws(() => planWorkspaceAppSync(invalid), /zero write tools/);
});

test('explicit remote catalog verification never fabricates a source manifest hash',()=>{
  const input=syncInput();
  input.desiredAccounts[0].verificationBasis='remote-catalog';
  input.inventories[0].apps[0].manifestHash=null;
  assert.equal(planWorkspaceAppSync(input).accountPlans[0].actions[0].action,'retain');
  delete input.desiredAccounts[0].verificationBasis;
  assert.notEqual(planWorkspaceAppSync(input).accountPlans[0].actions[0].action,'retain');
});

test('installed inventory absence never authorizes definition deletion',()=>{
  const input=syncInput();
  input.inventories[0].apps[1].status='DISABLED';
  input.deleteAuthorizations=[{accountAlias:'account1-business-owner',appId:'asdk_app_oldbusiness123',
    preimageHash:'5'.repeat(64),approvedAt:'2026-08-22T00:01:00.000Z'}];
  assert.equal(planWorkspaceAppSync(input).cleanup[0].reason,'registered_inventory_required');
  input.inventories[0].complete=false;
  assert.throws(()=>planWorkspaceAppSync(input),/incomplete/);
});

test('post-read verifies exact stable IDs for update/share/disable/delete actions', () => {
  const input = syncInput();
  const plan = planWorkspaceAppSync(input);
  const postRead = structuredClone(input.inventories);
  postRead[0].apps[1].status = 'DISABLED';
  assert.equal(verifyWorkspaceAppSyncPostRead(plan, postRead).ok, true);
  postRead[0].apps[1].status = 'ENABLED';
  const held = verifyWorkspaceAppSyncPostRead(plan, postRead);
  assert.equal(held.ok, false);
  assert.equal(held.holds[0].reason, 'disable_post_read_mismatch');
});

test('post-read refuses enabled apps with old schemas and unresolved cleanup or creation', () => {
  const input = syncInput();
  const plan = planWorkspaceAppSync(input);
  const post = structuredClone(input.inventories);
  post[0].apps[1].status = 'DISABLED';
  post[0].apps[0].manifestHash = '9'.repeat(64);
  assert.equal(verifyWorkspaceAppSyncPostRead(plan, post).holds.some(item => item.reason === 'canonical_schema_drift'), true);
  const unresolved = structuredClone(plan);
  unresolved.accountPlans[0].actions = [{ action: 'create' }];
  unresolved.cleanup[0].action = 'hold';
  const result = verifyWorkspaceAppSyncPostRead(unresolved, post);
  assert.equal(result.ok, false);
  assert.equal(result.holds.some(item => item.reason === 'canonical_action_unverified'), true);
  assert.equal(result.holds.some(item => item.reason === 'cleanup_action_unverified'), true);
});
