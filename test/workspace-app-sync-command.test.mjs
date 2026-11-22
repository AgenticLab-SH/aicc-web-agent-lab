import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  WORKSPACE_APP_SYNC_HELP,
  parseWorkspaceAppSyncArgs,
  runWorkspaceAppSyncCommand
} from '../src/workspace-app-sync-command.mjs';

test('app sync help wins before unknown options without reading files', () => {
  assert.equal(parseWorkspaceAppSyncArgs(['--unknown', '--help']).mode, 'help');
  assert.equal(runWorkspaceAppSyncCommand(['--help', '--request-file', '/missing']).output, WORKSPACE_APP_SYNC_HELP);
});

test('inventory uses a pinned Node driver without dispatching mutations or substituting an account', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-app-inventory-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const driverFile=path.join(root,'driver.mjs'),requestFile=path.join(root,'request.json');
  const source="export const driver={inspect:async request=>({accountAlias:request.accountAlias,observedAt:new Date().toISOString(),apps:[]}),apply:()=>{throw new Error('must not mutate')}};";
  fs.writeFileSync(driverFile,source);
  fs.writeFileSync(requestFile,JSON.stringify({schemaVersion:1,accountAlias:'owner',surfaceProfile:'business-full'}));
  const args=['inventory','--request-file',requestFile,'--driver-file',driverFile,'--driver-sha256',createHash('sha256').update(source).digest('hex'),'--json'];
  const result=await runWorkspaceAppSyncCommand(args);
  assert.equal(result.exitCode,0);assert.equal(result.result.remoteMutation,false);
  assert.equal(result.result.inventory.accountAlias,'owner');
  fs.writeFileSync(driverFile,source+'\n');
  await assert.rejects(()=>runWorkspaceAppSyncCommand(args),/SHA256 changed/);
  assert.throws(()=>parseWorkspaceAppSyncArgs([...args,'--commit']),/unknown/);
});

test('app sync parser rejects unknown, duplicate, relative and incomplete options', () => {
  assert.throws(() => parseWorkspaceAppSyncArgs(['plan', '--unknown']), /unknown option/);
  assert.throws(() => parseWorkspaceAppSyncArgs(['plan', '--request-file', '/tmp/a', '--request-file', '/tmp/b']), /duplicate option/);
  assert.throws(() => parseWorkspaceAppSyncArgs(['plan', '--request-file', 'relative.json']), /absolute path/);
  assert.throws(() => parseWorkspaceAppSyncArgs(['plan', '--topology-file', '/tmp/a']), /exact .*pair/);
  assert.throws(() => parseWorkspaceAppSyncArgs(['verify', '--plan-file', '/tmp/a']), /requires only/);
  assert.throws(() => parseWorkspaceAppSyncArgs(['status', '--plan-file', '/tmp/a']), /accepts only/);
  assert.throws(() => parseWorkspaceAppSyncArgs(['plan', '--state-root', '/tmp', '--request-file', '/tmp/a']), /only valid with status/);
});

test('app sync status reads the owner-local topology without requiring browser inventory', t => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-app-status-command-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const root = path.join(stateRoot, 'workspace-app-sync');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'topology.json'), JSON.stringify({
    schemaVersion: 1,
    logicalPluginId: 'aicc-workspace',
    accounts: [{
      accountAlias: 'account3-personal', role: 'owner', surfaceProfile: 'personal-read-fetch',
      remoteAppId: 'plugin_asdk_app_personal123'
    }]
  }));
  const execution = runWorkspaceAppSyncCommand(['status', '--state-root', stateRoot, '--json']);
  const result = JSON.parse(execution.output);
  assert.equal(execution.exitCode, 0);
  assert.equal(result.topologyPresent, true);
  assert.equal(result.inventoryPresent, false);
  assert.equal(result.accountBindings[0].remoteAppId, 'plugin_asdk_app_personal123');
});

test('app sync expands a small three-account topology from canonical local manifests', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-app-topology-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const topology = path.join(root, 'topology.json');
  const inventory = path.join(root, 'inventory.json');
  const businessId = 'plugin_asdk_app_business123';
  fs.writeFileSync(topology, JSON.stringify({
    schemaVersion: 1,
    logicalPluginId: 'aicc-workspace',
    accounts: [
      { accountAlias: 'account1-business-owner', role: 'owner', surfaceProfile: 'business-full', remoteAppId: businessId },
      { accountAlias: 'account2-business-member', role: 'member', ownerAccountAlias: 'account1-business-owner', surfaceProfile: 'business-full', remoteAppId: businessId },
      { accountAlias: 'account3-personal', role: 'owner', surfaceProfile: 'personal-read-fetch', remoteAppId: null }
    ]
  }));
  fs.writeFileSync(inventory, JSON.stringify({
    schemaVersion: 1,
    inventories: [
      { accountAlias: 'account1-business-owner', observedAt: '2026-08-22T00:00:00.000Z', apps: [] },
      { accountAlias: 'account2-business-member', observedAt: '2026-08-22T00:00:00.000Z', apps: [] },
      { accountAlias: 'account3-personal', observedAt: '2026-08-22T00:00:00.000Z', apps: [] }
    ],
    passedCanaryAccounts: []
  }));
  const result = runWorkspaceAppSyncCommand(['plan', '--topology-file', topology, '--inventory-file', inventory, '--json']).result;
  assert.deepEqual(result.accountPlans.map(item => item.surfaceProfile), ['business-full', 'business-full', 'personal-read-fetch']);
  assert.equal(result.accountPlans[0].actions[0].reason, 'bound_stable_id_missing');
  assert.equal(result.accountPlans[1].actions[0].action, 'share');
  assert.equal(result.accountPlans[2].actions[0].action, 'create');
});

test('app sync plan reads one regular request and emits structured JSON', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-app-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const request = path.join(root, 'request.json');
  const hash = '1'.repeat(64);
  fs.writeFileSync(request, `${JSON.stringify({
    logicalPluginId: 'aicc-workspace',
    desiredAccounts: [{
      accountAlias: 'account3-personal', role: 'owner', surfaceProfile: 'personal-read-fetch', remoteAppId: null,
      manifestHash: hash, toolCatalogHash: '2'.repeat(64), toolCounts: { total: 18, read: 18, write: 0 }
    }],
    inventories: [{ accountAlias: 'account3-personal', observedAt: '2026-08-22T00:00:00.000Z', apps: [] }],
    passedCanaryAccounts: []
  })}\n`, { mode: 0o600 });
  const execution = runWorkspaceAppSyncCommand(['plan', '--request-file', request, '--json']);
  assert.equal(execution.exitCode, 0);
  assert.equal(JSON.parse(execution.output).accountPlans[0].actions[0].action, 'create');
});

test('app sync operations emits deterministic one-shot IDs from a saved plan', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-app-operations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const request = path.join(root, 'request.json');
  const planFile = path.join(root, 'plan.json');
  fs.writeFileSync(request, JSON.stringify({
    logicalPluginId: 'aicc-workspace',
    desiredAccounts: [{
      accountAlias: 'account3-personal', role: 'owner', surfaceProfile: 'personal-read-fetch', remoteAppId: null,
      manifestHash: '1'.repeat(64), toolCatalogHash: '2'.repeat(64), toolCounts: { total: 18, read: 18, write: 0 }
    }],
    inventories: [{ accountAlias: 'account3-personal', observedAt: '2026-08-22T00:00:00.000Z', apps: [] }]
  }));
  const plan = runWorkspaceAppSyncCommand(['plan', '--request-file', request, '--json']).result;
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const first = runWorkspaceAppSyncCommand(['operations', '--plan-file', planFile, '--json']).result;
  const second = runWorkspaceAppSyncCommand(['operations', '--plan-file', planFile, '--json']).result;
  assert.equal(first.operations[0].action.action, 'create');
  assert.equal(first.operations[0].operationId, second.operations[0].operationId);
});

test('execute pins its driver and refuses a second dispatch after an uncertain result', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-app-execute-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inventory = { accountAlias: 'personal-owner', observedAt: new Date().toISOString(), apps: [] };
  const request = path.join(root, 'request.json');
  fs.writeFileSync(request, JSON.stringify({ logicalPluginId: 'aicc-workspace', desiredAccounts: [{
    accountAlias: inventory.accountAlias, role: 'owner', surfaceProfile: 'personal-read-fetch', remoteAppId: null,
    manifestHash: '1'.repeat(64), toolCatalogHash: '2'.repeat(64), toolCounts: { total: 18, read: 18, write: 0 }
  }], inventories: [inventory] }));
  const plan = runWorkspaceAppSyncCommand(['plan', '--request-file', request, '--json']).result;
  const planFile = path.join(root, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const operation = runWorkspaceAppSyncCommand(['operations', '--plan-file', planFile, '--json']).result.operations[0];
  const driverFile = path.join(root, 'driver.mjs');
  fs.writeFileSync(driverFile, `export const driver={inspect:async()=>(${JSON.stringify(inventory)}),apply:async()=>{throw new Error('outcome lost')}};`);
  const driverHash = createHash('sha256').update(fs.readFileSync(driverFile)).digest('hex');
  const args = ['execute', '--plan-file', planFile, '--operation-id', operation.operationId, '--driver-file', driverFile,
    '--driver-sha256', driverHash, '--state-root', root, '--json'];
  assert.equal((await runWorkspaceAppSyncCommand(args)).result.terminal, 'DRY_RUN');
  const journal = path.join(root, 'workspace-app-sync', 'operations', `${operation.operationId}.json`);
  assert.equal(fs.existsSync(journal), false);
  assert.equal((await runWorkspaceAppSyncCommand([...args, '--commit'])).result.terminal, 'UNCERTAIN');
  assert.equal(JSON.parse(fs.readFileSync(journal)).terminal, 'UNCERTAIN');
  await assert.rejects(runWorkspaceAppSyncCommand([...args, '--commit']), /EEXIST/);
  fs.appendFileSync(driverFile, '\n// changed');
  await assert.rejects(runWorkspaceAppSyncCommand(args), /SHA256 changed/);
});
