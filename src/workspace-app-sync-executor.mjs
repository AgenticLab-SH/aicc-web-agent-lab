import { createHash } from 'node:crypto';
import { workspaceAppInventoryHash } from './workspace-app-lifecycle.mjs';

const MUTATING_ACTIONS = new Set(['create', 'update', 'enable', 'share', 'disable', 'delete']);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function operationId(planHash, scope, accountAlias, index, action) {
  return `appsync-${createHash('sha256').update(`${planHash}\0${scope}\0${accountAlias}\0${index}\0${action}`).digest('hex').slice(0, 24)}`;
}

export function enumerateWorkspaceAppSyncOperations(plan) {
  if (plan?.schemaVersion !== 1 || plan?.logicalPluginId !== 'aicc-workspace') throw new Error('invalid workspace app sync plan');
  const planHash = createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');
  const operations = [];
  for (const accountPlan of plan.accountPlans ?? []) {
    for (const [index, action] of (accountPlan.actions ?? []).entries()) {
      operations.push({
        operationId: operationId(planHash, 'account', accountPlan.accountAlias, index, action.action),
        planHash,
        scope: 'account',
        accountAlias: accountPlan.accountAlias,
        role: accountPlan.role,
        surfaceProfile: accountPlan.surfaceProfile,
        expectedInventoryHash: accountPlan.inventoryHash,
        desired: accountPlan.desired,
        action
      });
    }
  }
  const accountByAlias = new Map((plan.accountPlans ?? []).map(item => [item.accountAlias, item]));
  for (const [index, action] of (plan.cleanup ?? []).entries()) {
    const accountPlan = accountByAlias.get(action.accountAlias);
    if (!accountPlan) throw new Error(`cleanup account is not in the plan: ${action.accountAlias}`);
    operations.push({
      operationId: operationId(planHash, 'cleanup', action.accountAlias, index, action.action),
      planHash,
      scope: 'cleanup',
      accountAlias: action.accountAlias,
      role: accountPlan.role,
      surfaceProfile: accountPlan.surfaceProfile,
      expectedInventoryHash: accountPlan.inventoryHash,
      desired: accountPlan.desired,
      action
    });
  }
  return { schemaVersion: 1, planHash, operations };
}

function sameCounts(left, right) {
  return left?.total === right?.total && left?.read === right?.read && left?.write === right?.write;
}

function exactApp(inventory, appId) {
  const matches = (inventory.apps ?? []).filter(app => app.appId === appId);
  return matches.length === 1 ? matches[0] : null;
}

function desiredMatches(app, desired) {
  return (desired.verificationBasis==='remote-catalog' || app?.manifestHash === desired.manifestHash)
    && app?.toolCatalogHash === desired.toolCatalogHash
    && app?.surfaceProfile === desired.surfaceProfile
    && sameCounts(app?.toolCounts, desired.toolCounts);
}

function verifyPostRead(operation, before, after, applied) {
  if (after?.accountAlias !== operation.accountAlias) return { ok: false, reason: 'post_read_account_mismatch' };
  const action = operation.action.action;
  if (action === 'create') {
    const createdId = applied?.appId ?? null;
    if (!createdId || exactApp(before, createdId)) return { ok: false, reason: 'created_stable_id_invalid' };
    const app = exactApp(after, createdId);
    return app && app.status === 'ENABLED' && desiredMatches(app, operation.desired)
      ? { ok: true, appId: createdId }
      : { ok: false, reason: 'create_post_read_mismatch', appId: createdId };
  }
  if (action === 'update' || action === 'enable') {
    const app = exactApp(after, operation.action.appId);
    return app && app.status === 'ENABLED' && desiredMatches(app, operation.desired)
      ? { ok: true, appId: app.appId }
      : { ok: false, reason: `${action}_post_read_mismatch`, appId: operation.action.appId };
  }
  if (action === 'share') {
    const app = exactApp(after, operation.action.appId);
    return app && app.status === 'ENABLED' && app.sharedFromAccountAlias === operation.action.fromAccountAlias
      && desiredMatches(app, operation.desired)
      ? { ok: true, appId: app.appId }
      : { ok: false, reason: 'share_post_read_mismatch', appId: operation.action.appId };
  }
  if (action === 'disable') {
    const app = exactApp(after, operation.action.appId);
    return app?.status === 'DISABLED'
      ? { ok: true, appId: app.appId }
      : { ok: false, reason: 'disable_post_read_mismatch', appId: operation.action.appId };
  }
  if (action === 'delete') {
    return after.registered===true && before.registered===true && after.complete!==false && !exactApp(after, operation.action.appId)
      ? { ok: true, appId: operation.action.appId }
      : { ok: false, reason: 'delete_post_read_mismatch', appId: operation.action.appId };
  }
  return { ok: false, reason: 'action_not_mutating' };
}

/** Execute exactly one account-scoped action. A fresh plan is required after it. */
export async function executeWorkspaceAppSyncOperation({ plan, operationId: selectedId, commit = false }, driver, hooks = {}) {
  if (!driver || typeof driver.inspect !== 'function' || typeof driver.apply !== 'function') {
    throw new Error('workspace app sync driver must provide inspect and apply');
  }
  const catalog = enumerateWorkspaceAppSyncOperations(plan);
  const matches = catalog.operations.filter(item => item.operationId === selectedId);
  if (matches.length !== 1) throw new Error('operationId must select exactly one planned action');
  const operation = matches[0];
  if (!MUTATING_ACTIONS.has(operation.action.action)) {
    return { ok: false, terminal: 'HOLD', operationId: selectedId, reason: 'planned_action_is_not_executable', operation };
  }
  const before = await driver.inspect(operation);
  const beforeHash = workspaceAppInventoryHash(before);
  if (beforeHash !== operation.expectedInventoryHash) {
    return { ok: false, terminal: 'HOLD', operationId: selectedId, reason: 'inventory_preimage_changed', expectedInventoryHash: operation.expectedInventoryHash, beforeHash };
  }
  if (!commit) {
    return { ok: true, terminal: 'DRY_RUN', operationId: selectedId, beforeHash, operation, remoteMutation: false };
  }
  await hooks.onDispatching?.({ operation, beforeHash });
  let applied;
  try { applied = await driver.apply(operation, before); }
  catch (error) {
    return {
      ok: false,
      terminal: error?.preDispatch === true ? 'HOLD' : 'UNCERTAIN',
      operationId: selectedId,
      reason: error?.preDispatch === true ? 'driver_pre_dispatch_failure' : 'submission_outcome_uncertain',
      error: error instanceof Error ? error.message : String(error),
      retryAllowed: false
    };
  }
  let after;
  try { after = await driver.inspect(operation); }
  catch (error) {
    return { ok: false, terminal: 'UNCERTAIN', operationId: selectedId, reason: 'post_read_failed', error: error instanceof Error ? error.message : String(error), retryAllowed: false };
  }
  const verification = verifyPostRead(operation, before, after, applied);
  if (!verification.ok) {
    return { ok: false, terminal: 'UNCERTAIN', operationId: selectedId, reason: verification.reason, verification, retryAllowed: false };
  }
  const result = { ok: true, terminal: 'PASS', operationId: selectedId, action: operation.action.action, accountAlias: operation.accountAlias, beforeHash, afterHash: workspaceAppInventoryHash(after), verification, remoteMutation: true };
  await hooks.onCompleted?.(result);
  return result;
}
