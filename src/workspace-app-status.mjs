import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workspaceToolSnapshot } from '../components/workspace-mcp/tool-manifest.mjs';
import { buildWorkspaceAppSyncRequest } from './workspace-app-topology.mjs';
import { planWorkspaceAppSync, verifyWorkspaceAppSyncPostRead } from './workspace-app-lifecycle.mjs';
import { enumerateWorkspaceAppSyncOperations } from './workspace-app-sync-executor.mjs';

function readOptionalRegularJson(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${file} must be a regular non-symlink file`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function surfaceSummary(surfaceProfile, failureDomain) {
  const manifest = workspaceToolSnapshot({ surfaceProfile });
  return {
    surfaceProfile,
    failureDomain,
    source: 'pass',
    installed: 'unknown',
    runtime: 'unknown',
    browserVisible: 'unknown',
    toolCount: manifest.toolCount,
    readToolCount: manifest.readToolCount,
    writeToolCount: manifest.writeToolCount,
    manifestHash: manifest.hash
  };
}

function configuredBindingsFromTopology(topology) {
  if (!topology) return [];
  const aliases = Array.isArray(topology.accounts)
    ? topology.accounts.map(item => item?.accountAlias)
    : [];
  const desired = buildWorkspaceAppSyncRequest(topology, {
    schemaVersion: 1,
    inventories: aliases.map(accountAlias => ({
      accountAlias,
      observedAt: '1970-01-01T00:00:00.000Z',
      apps: []
    }))
  }).desiredAccounts;
  return desired.map(item => ({
    accountAlias: item.accountAlias,
    role: item.role,
    surfaceProfile: item.surfaceProfile,
    ownerAccountAlias: item.ownerAccountAlias ?? null,
    remoteAppId: item.remoteAppId,
    observation: 'configured-only',
    actions: []
  }));
}

export function workspaceAppSyncStatus(options = {}) {
  const stateRoot = options.stateRoot
    ?? process.env.AICC_STATE_ROOT?.trim()
    ?? path.join(os.homedir(), '.ai-control-center');
  const root = path.join(stateRoot, 'workspace-app-sync');
  const topology = readOptionalRegularJson(path.join(root, 'topology.json'));
  const inventory = readOptionalRegularJson(path.join(root, 'inventory.json'));
  const latestResult = readOptionalRegularJson(path.join(root, 'latest-result.json'));
  const surfaces = [
    surfaceSummary('business-full', 'business-publication'),
    surfaceSummary('personal-read-fetch', 'personal-publication')
  ];
  let plan = null;
  let plannerError = null;
  let configuredBindings = [];
  if (topology) {
    try { configuredBindings = configuredBindingsFromTopology(topology); }
    catch (error) { plannerError = error instanceof Error ? error.message : String(error); }
  }
  if (topology && inventory && !plannerError) {
    try { plan = planWorkspaceAppSync(buildWorkspaceAppSyncRequest(topology, inventory)); }
    catch (error) { plannerError = error instanceof Error ? error.message : String(error); }
  }
  const accountBindings = plan?.accountPlans.map(item => ({
    accountAlias: item.accountAlias,
    role: item.role,
    surfaceProfile: item.surfaceProfile,
    ownerAccountAlias: item.desired.ownerAccountAlias ?? null,
    remoteAppId: item.desired.remoteAppId,
    observation: 'inventory-bound',
    actions: item.actions.map(action => ({ action: action.action, appId: action.appId ?? null, reason: action.reason ?? null }))
  })) ?? configuredBindings;
  const pendingActions = [
    ...accountBindings.flatMap(item => item.actions.filter(action => action.action !== 'retain').map(action => ({ accountAlias: item.accountAlias, ...action }))),
    ...(plan?.cleanup ?? []).filter(action => !['retain', 'ignore'].includes(action.action))
  ];
  const topologyReady = Boolean(topology && inventory && plan && !plannerError);
  const receiptBound = plan && latestResult?.planHash === enumerateWorkspaceAppSyncOperations(plan).planHash;
  const fresh = inventory?.inventories?.every(item => {
    const age = Date.now() - Date.parse(item.observedAt);
    return Number.isFinite(age) && age >= 0 && age <= 30 * 60_000;
  });
  const synchronized = topologyReady && pendingActions.length === 0 && plan.canonicalReadyEverywhere
    && fresh && latestResult?.terminal === 'PASS' && receiptBound && verifyWorkspaceAppSyncPostRead(plan, inventory.inventories).ok;
  return {
    id: 'workspace-app-sync',
    label: 'AICC Workspace 계정 동기화',
    healthSummary: false,
    state: synchronized ? 'ready' : 'attention',
    detail: plannerError
      ? '계정 topology 또는 inventory가 유효하지 않아 원격 변경을 HOLD합니다.'
      : !topology
        ? '계정 topology가 없어 원격 변경을 HOLD합니다.'
        : !inventory
          ? `${configuredBindings.length}개 계정 binding은 등록됐지만 최신 browser inventory가 없어 원격 변경을 HOLD합니다.`
          : !topologyReady
            ? '계정 topology와 browser inventory를 결합할 수 없어 원격 변경을 HOLD합니다.'
        : pendingActions.length > 0
          ? `${pendingActions.length}개 계정별 one-shot 조치가 필요합니다.`
          : !synchronized
            ? '계정별 post-read와 retrieval canary 완료 근거가 필요합니다.'
            : `${accountBindings.length}개 계정 binding이 하나의 논리 plugin 정본과 일치합니다.`,
    logicalPluginId: 'aicc-workspace',
    topology: 'one-logical-plugin-separate-account-bindings',
    failureDomains: ['business-publication', 'personal-publication'],
    topologyPresent: topology !== null,
    inventoryPresent: inventory !== null,
    topologyReady,
    plannerError,
    surfaces,
    accountBindings,
    pendingActions,
    cleanup: plan?.cleanup ?? [],
    latestResult: latestResult ? {
      terminal: latestResult.terminal ?? 'UNKNOWN',
      operationId: latestResult.operationId ?? null,
      completedAt: latestResult.completedAt ?? null
    } : null,
    automaticHardDeleteAllowed: false
  };
}
