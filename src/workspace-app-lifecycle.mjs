import { createHash } from 'node:crypto';

// ChatGPT surfaces expose the same stable app in either raw (`asdk_app_*`) or
// installed-plugin (`plugin_asdk_app_*`) form. Keep the exact observed form so
// post-read and delete authorization remain bound to the same identifier.
const APP_ID = /^(?:plugin_)?asdk_app_[a-z0-9]+$/i;
const HASH = /^[a-f0-9]{64}$/;
const ACCOUNT_ALIAS = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

function exactAppId(value, label) {
  const normalized = String(value ?? '').trim();
  if (!APP_ID.test(normalized)) throw new Error(`${label} must be an exact ChatGPT app ID`);
  return normalized;
}

function isoTime(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an RFC3339 UTC timestamp`);
  return new Date(value).toISOString();
}

function exactStringSet(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const normalized = value.map(item => String(item ?? '').trim());
  if (normalized.some(item => !item)) throw new Error(`${label} cannot contain empty values`);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must contain unique values`);
  return normalized;
}

function referenceProof(item) {
  const requiredScopes = exactStringSet(item.requiredReferenceScopes, 'item.requiredReferenceScopes');
  const completedScopes = new Set(exactStringSet(item.completedReferenceScopes, 'item.completedReferenceScopes'));
  const unknownScopes = exactStringSet(item.unknownReferenceScopes, 'item.unknownReferenceScopes');
  const knownReferences = exactStringSet(item.knownReferences, 'item.knownReferences');
  if (requiredScopes.length < 1 || !requiredScopes.every(scope => completedScopes.has(scope))) {
    return { ready: false, action: 'hold', reason: 'reference_scope_incomplete' };
  }
  if (unknownScopes.length > 0) return { ready: false, action: 'hold', reason: 'unknown_reference_scope' };
  if (knownReferences.length > 0) return { ready: false, action: 'retain', reason: 'live_reference' };
  return { ready: true };
}

export function planWorkspaceAppCleanup(input = {}) {
  const canonicalAppId = exactAppId(input.canonicalAppId, 'canonicalAppId');
  const rollbackAppId = exactAppId(input.rollbackAppId, 'rollbackAppId');
  if (canonicalAppId === rollbackAppId) throw new Error('canonical and rollback app IDs must differ');
  const observedAt = isoTime(input.observedAt, 'observedAt');
  const quarantineDays = Number(input.quarantineDays ?? 14);
  if (!Number.isInteger(quarantineDays) || quarantineDays < 1 || quarantineDays > 365) {
    throw new Error('quarantineDays must be an integer between 1 and 365');
  }
  const requiredAccounts = [...new Set((input.requiredAccountAliases ?? []).map(value => String(value).trim()).filter(Boolean))];
  if (requiredAccounts.length < 1) throw new Error('requiredAccountAliases cannot be empty');
  const passedAccounts = new Set((input.passedAccountAliases ?? []).map(value => String(value).trim()).filter(Boolean));
  const canaryReady = requiredAccounts.every(alias => passedAccounts.has(alias));
  const hardDeleteCapabilityVerified = input.hardDeleteCapability === 'verified-visible-ui';
  const rollbackRehearsed = input.rollbackRehearsed === true;
  const items = Array.isArray(input.items) ? input.items : [];
  const seen = new Set();
  const actions = [];
  for (const item of items) {
    const appId = exactAppId(item.appId, 'item.appId');
    if (seen.has(appId)) throw new Error(`duplicate app inventory item: ${appId}`);
    seen.add(appId);
    const base = { appId, name: String(item.name ?? '').trim() || null };
    if (appId === canonicalAppId) {
      actions.push({ ...base, action: 'retain', reason: 'canonical' });
      continue;
    }
    if (appId === rollbackAppId) {
      actions.push({ ...base, action: 'retain', reason: 'immediate_rollback' });
      continue;
    }
    if (item.managedByAicc !== true || item.family !== 'aicc-workspace') {
      actions.push({ ...base, action: 'ignore', reason: 'outside_managed_family' });
      continue;
    }
    if (item.supersededByAppId !== canonicalAppId || item.lineageVerified !== true) {
      actions.push({ ...base, action: 'hold', reason: 'supersession_unproven' });
      continue;
    }
    if (!canaryReady) {
      actions.push({ ...base, action: 'hold', reason: 'canonical_account_canary_incomplete' });
      continue;
    }
    let references;
    try { references = referenceProof(item); }
    catch {
      actions.push({ ...base, action: 'hold', reason: 'reference_evidence_invalid' });
      continue;
    }
    if (!references.ready) {
      actions.push({ ...base, action: references.action, reason: references.reason });
      continue;
    }
    const status = String(item.status ?? '').toUpperCase();
    if (status === 'ENABLED') {
      actions.push({ ...base, action: 'disable', reason: 'superseded_quarantine_entry' });
      continue;
    }
    if (status !== 'DISABLED' || !item.disabledAt) {
      actions.push({ ...base, action: 'hold', reason: 'disabled_state_unproven' });
      continue;
    }
    const disabledAt = isoTime(item.disabledAt, 'item.disabledAt');
    const elapsedDays = (Date.parse(observedAt) - Date.parse(disabledAt)) / 86_400_000;
    if (elapsedDays < quarantineDays) {
      actions.push({ ...base, action: 'retain', reason: 'quarantine_window', eligibleAfter: new Date(Date.parse(disabledAt) + quarantineDays * 86_400_000).toISOString() });
      continue;
    }
    if (!hardDeleteCapabilityVerified) {
      actions.push({ ...base, action: 'hold', reason: 'hard_delete_capability_unverified' });
      continue;
    }
    if (!rollbackRehearsed) {
      actions.push({ ...base, action: 'hold', reason: 'rollback_not_rehearsed' });
      continue;
    }
    actions.push({ ...base, action: 'delete_candidate', reason: 'owner_exact_id_commit_required' });
  }
  if (!seen.has(canonicalAppId) || !seen.has(rollbackAppId)) {
    throw new Error('inventory must contain both canonical and immediate rollback apps');
  }
  return {
    schemaVersion: 1,
    observedAt,
    canonicalAppId,
    rollbackAppId,
    requiredAccountAliases: requiredAccounts,
    accountCanaryReady: canaryReady,
    hardDeleteCapabilityVerified,
    rollbackRehearsed,
    quarantineDays,
    actions,
    deleteCandidateAppIds: actions.filter(item => item.action === 'delete_candidate').map(item => item.appId),
    automaticHardDeleteAllowed: false,
  };
}

function exactHash(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!HASH.test(normalized)) throw new Error(`${label} must be a SHA-256 hash`);
  return normalized;
}

function exactAccountAlias(value, label) {
  const normalized = String(value ?? '').trim();
  if (!ACCOUNT_ALIAS.test(normalized)) throw new Error(`${label} must be a safe account alias`);
  return normalized;
}

function exactSurface(value, label) {
  if (!['business-full', 'personal-read-fetch'].includes(value)) {
    throw new Error(`${label} must be business-full or personal-read-fetch`);
  }
  return value;
}

function exactRole(value, label) {
  if (!['owner', 'member'].includes(value)) throw new Error(`${label} must be owner or member`);
  return value;
}

function exactToolCounts(value, label) {
  const fields = ['total', 'read', 'write'];
  if (!value || !fields.every(field => Number.isInteger(value[field]) && value[field] >= 0)) {
    throw new Error(`${label} must contain non-negative integer total/read/write counts`);
  }
  if (value.read + value.write !== value.total) throw new Error(`${label} read + write must equal total`);
  return { total: value.total, read: value.read, write: value.write };
}

function normalizedDesiredAccount(item, index) {
  const verificationBasis=item?.verificationBasis ?? 'source-manifest';
  if(!['source-manifest','remote-catalog'].includes(verificationBasis))throw new Error('Unsupported verification basis');
  const accountAlias = exactAccountAlias(item?.accountAlias, `desiredAccounts[${index}].accountAlias`);
  const role = exactRole(item?.role, `desiredAccounts[${index}].role`);
  const surfaceProfile = exactSurface(item?.surfaceProfile, `desiredAccounts[${index}].surfaceProfile`);
  const remoteAppId = item?.remoteAppId == null ? null : exactAppId(item.remoteAppId, `desiredAccounts[${index}].remoteAppId`);
  const ownerAccountAlias = role === 'member'
    ? exactAccountAlias(item?.ownerAccountAlias, `desiredAccounts[${index}].ownerAccountAlias`)
    : null;
  if (surfaceProfile === 'personal-read-fetch' && role !== 'owner') {
    throw new Error('personal-read-fetch cannot use a member binding');
  }
  const toolCounts = exactToolCounts(item?.toolCounts, `desiredAccounts[${index}].toolCounts`);
  if (surfaceProfile === 'personal-read-fetch' && toolCounts.write !== 0) {
    throw new Error('personal-read-fetch must expose zero write tools');
  }
  return {
    accountAlias,
    verificationBasis,
    role,
    surfaceProfile,
    ownerAccountAlias,
    remoteAppId,
    manifestHash: exactHash(item?.manifestHash, `desiredAccounts[${index}].manifestHash`),
    toolCatalogHash: exactHash(item?.toolCatalogHash, `desiredAccounts[${index}].toolCatalogHash`),
    toolCounts
  };
}

function normalizedInventory(input, accountAlias) {
  if(input?.complete===false)throw new Error('Inventory is incomplete; absence cannot be inferred');
  if (!input || exactAccountAlias(input.accountAlias, 'inventory.accountAlias') !== accountAlias) {
    throw new Error(`inventory is missing or belongs to another account: ${accountAlias}`);
  }
  const observedAt = isoTime(input.observedAt, `inventory.${accountAlias}.observedAt`);
  if (!Array.isArray(input.apps)) throw new Error(`inventory.${accountAlias}.apps must be an array`);
  const seen = new Set();
  const apps = input.apps.map((app, index) => {
    const appId = exactAppId(app?.appId, `inventory.${accountAlias}.apps[${index}].appId`);
    if (seen.has(appId)) throw new Error(`duplicate app ID in ${accountAlias}: ${appId}`);
    seen.add(appId);
    return {
      appId,
      name: String(app?.name ?? '').trim() || null,
      status: String(app?.status ?? '').trim().toUpperCase(),
      family: String(app?.family ?? '').trim() || null,
      logicalPluginId: String(app?.logicalPluginId ?? '').trim() || null,
      manifestHash: app?.manifestHash == null ? null : exactHash(app.manifestHash, `inventory.${accountAlias}.${appId}.manifestHash`),
      toolCatalogHash: app?.toolCatalogHash == null ? null : exactHash(app.toolCatalogHash, `inventory.${accountAlias}.${appId}.toolCatalogHash`),
      toolCounts: app?.toolCounts == null ? null : exactToolCounts(app.toolCounts, `inventory.${accountAlias}.${appId}.toolCounts`),
      surfaceProfile: app?.surfaceProfile == null ? null : exactSurface(app.surfaceProfile, `inventory.${accountAlias}.${appId}.surfaceProfile`),
      canUpdate: app?.canUpdate === true,
      canDisable: app?.canDisable === true,
      canDelete: app?.canDelete === true,
      canShare: app?.canShare === true,
      sharedFromAccountAlias: app?.sharedFromAccountAlias == null ? null : exactAccountAlias(app.sharedFromAccountAlias, `inventory.${accountAlias}.${appId}.sharedFromAccountAlias`),
      referenceState: ['zero', 'nonzero', 'unknown'].includes(app?.referenceState) ? app.referenceState : 'unknown',
      preimageHash: app?.preimageHash == null ? null : exactHash(app.preimageHash, `inventory.${accountAlias}.${appId}.preimageHash`)
    };
  });
  return { accountAlias, observedAt, registered:input.registered===true, apps };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function workspaceAppInventoryHash(input) {
  const account = exactAccountAlias(input?.accountAlias, 'inventory.accountAlias');
  const inventory = normalizedInventory(input, account);
  const body = { accountAlias: inventory.accountAlias, registered:inventory.registered, apps: [...inventory.apps].sort((left, right) => left.appId.localeCompare(right.appId)) };
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
}

function desiredDiff(desired, observed) {
  const fields = [];
  if (desired.verificationBasis !== 'remote-catalog' && observed.manifestHash !== desired.manifestHash) fields.push('manifestHash');
  if (observed.toolCatalogHash !== desired.toolCatalogHash) fields.push('toolCatalogHash');
  if (observed.surfaceProfile !== desired.surfaceProfile) fields.push('surfaceProfile');
  if (!observed.toolCounts
    || observed.toolCounts.total !== desired.toolCounts.total
    || observed.toolCounts.read !== desired.toolCounts.read
    || observed.toolCounts.write !== desired.toolCounts.write) fields.push('toolCounts');
  return fields;
}

function deleteAuthorization(input, accountAlias, app) {
  const matches = (input.deleteAuthorizations ?? []).filter(item => item?.accountAlias === accountAlias && item?.appId === app.appId);
  if (matches.length > 1) throw new Error(`duplicate delete authorization: ${accountAlias}:${app.appId}`);
  const authorization = matches[0];
  if (!authorization) return null;
  if (authorization.preimageHash !== app.preimageHash || !HASH.test(String(authorization.preimageHash ?? ''))) return null;
  if (typeof authorization.approvedAt !== 'string' || !Number.isFinite(Date.parse(authorization.approvedAt))) return null;
  return { approvedAt: new Date(authorization.approvedAt).toISOString(), preimageHash: authorization.preimageHash };
}

/**
 * Build one logical AICC Workspace plugin plan across separate account surfaces.
 * The plan can express create/update/enable/share/disable/delete, but never uses a name as delete authority.
 */
export function planWorkspaceAppSync(input = {}) {
  const logicalPluginId = String(input.logicalPluginId ?? '').trim();
  if (logicalPluginId !== 'aicc-workspace') throw new Error('logicalPluginId must be aicc-workspace');
  const desiredAccounts = (input.desiredAccounts ?? []).map(normalizedDesiredAccount);
  if (desiredAccounts.length < 1) throw new Error('desiredAccounts cannot be empty');
  const aliases = desiredAccounts.map(item => item.accountAlias);
  if (new Set(aliases).size !== aliases.length) throw new Error('desiredAccounts must contain unique account aliases');
  const desiredByAlias = new Map(desiredAccounts.map(item => [item.accountAlias, item]));
  for (const desired of desiredAccounts.filter(item => item.role === 'member')) {
    const owner = desiredByAlias.get(desired.ownerAccountAlias);
    if (!owner || owner.role !== 'owner' || owner.surfaceProfile !== 'business-full') {
      throw new Error(`member ${desired.accountAlias} must reference a Business owner in desiredAccounts`);
    }
    if (desired.remoteAppId && owner.remoteAppId && desired.remoteAppId !== owner.remoteAppId) {
      throw new Error(`member ${desired.accountAlias} must share the owner stable app ID`);
    }
    if (desired.manifestHash !== owner.manifestHash || desired.toolCatalogHash !== owner.toolCatalogHash) {
      throw new Error(`member ${desired.accountAlias} must share the owner manifest and tool catalog`);
    }
  }
  const inventories = new Map((input.inventories ?? []).map(item => [item.accountAlias, item]));
  const passedCanaries = new Set((input.passedCanaryAccounts ?? []).map(value => exactAccountAlias(value, 'passedCanaryAccounts')));
  const canonicalReadyEverywhere = desiredAccounts.every(item => passedCanaries.has(item.accountAlias));
  const accountPlans = [];
  const cleanup = [];

  for (const desired of desiredAccounts) {
    const inventory = normalizedInventory(inventories.get(desired.accountAlias), desired.accountAlias);
    const managed = inventory.apps.filter(app => app.family === 'aicc-workspace' && app.logicalPluginId === logicalPluginId);
    const canonical = desired.remoteAppId ? managed.find(app => app.appId === desired.remoteAppId) ?? null : null;
    const actions = [];
    if (desired.role === 'member') {
      const owner = desiredByAlias.get(desired.ownerAccountAlias);
      const ownerAppId = owner.remoteAppId;
      const shared = ownerAppId ? managed.find(app => app.appId === ownerAppId) ?? null : null;
      if (!ownerAppId) {
        actions.push({ action: 'hold', reason: 'owner_stable_id_missing' });
      } else if (!shared) {
        actions.push({ action: 'share', appId: ownerAppId, fromAccountAlias: owner.accountAlias, toAccountAlias: desired.accountAlias });
      } else if (shared.sharedFromAccountAlias !== owner.accountAlias) {
        actions.push({ action: 'hold', appId: shared.appId, reason: 'shared_owner_binding_mismatch' });
      } else {
        const diff = desiredDiff(desired, shared);
        actions.push(diff.length === 0 && shared.status === 'ENABLED'
          ? { action: 'retain', appId: shared.appId, reason: 'shared_exact' }
          : { action: 'hold', appId: shared.appId, reason: 'shared_surface_drift', fields: diff });
      }
    } else if (!desired.remoteAppId) {
      if (managed.length === 0) actions.push({ action: 'create', reason: 'stable_id_absent', desired });
      else if (managed.length === 1) actions.push({ action: 'adopt_candidate', appId: managed[0].appId, reason: 'exact_post_read_binding_required' });
      else actions.push({ action: 'hold', reason: 'multiple_unbound_managed_apps', appIds: managed.map(app => app.appId) });
    } else if (!canonical) {
      actions.push({ action: 'hold', appId: desired.remoteAppId, reason: 'bound_stable_id_missing' });
    } else if (canonical.surfaceProfile && canonical.surfaceProfile !== desired.surfaceProfile) {
      actions.push({ action: 'hold', appId: canonical.appId, reason: 'failure_domain_mismatch' });
    } else {
      const diff = desiredDiff(desired, canonical);
      if (canonical.status !== 'ENABLED') {
        actions.push({ action: 'enable', appId: canonical.appId, expectedStatus: canonical.status, fields: diff, desired });
      } else if (diff.length > 0) {
        actions.push(canonical.canUpdate
          ? { action: 'update', appId: canonical.appId, fields: diff, desired }
          : { action: 'hold', appId: canonical.appId, reason: 'update_capability_missing', fields: diff });
      } else {
        actions.push({ action: 'retain', appId: canonical.appId, reason: 'canonical_exact' });
      }
    }

    const canonicalId = desired.remoteAppId;
    for (const app of managed.filter(item => item.appId !== canonicalId)) {
      if (!canonicalReadyEverywhere) {
        cleanup.push({ accountAlias: desired.accountAlias, appId: app.appId, action: 'hold', reason: 'canonical_canary_incomplete' });
      } else if (app.referenceState !== 'zero') {
        cleanup.push({ accountAlias: desired.accountAlias, appId: app.appId, action: app.referenceState === 'nonzero' ? 'retain' : 'hold', reason: `reference_${app.referenceState}` });
      } else if (app.status === 'ENABLED') {
        cleanup.push({ accountAlias: desired.accountAlias, appId: app.appId, action: app.canDisable ? 'disable' : 'hold', reason: app.canDisable ? 'superseded_exact_id' : 'disable_capability_missing' });
      } else {
        const authorization = deleteAuthorization(input, desired.accountAlias, app);
        cleanup.push({
          accountAlias: desired.accountAlias,
          appId: app.appId,
          action: !inventory.registered ? 'hold' : authorization && app.canDelete ? 'delete' : 'delete_candidate',
          reason: !inventory.registered ? 'registered_inventory_required' : authorization ? (app.canDelete ? 'exact_authorization_bound' : 'delete_capability_missing') : 'exact_delete_authorization_required',
          authorization
        });
      }
    }
    accountPlans.push({
      accountAlias: desired.accountAlias,
      role: desired.role,
      surfaceProfile: desired.surfaceProfile,
      observedAt: inventory.observedAt,
      inventoryHash: workspaceAppInventoryHash(inventory),
      desired,
      actions
    });
  }
  return {
    schemaVersion: 1,
    logicalPluginId,
    topology: 'one-logical-plugin-separate-account-bindings',
    failureDomains: ['business-publication', 'personal-publication'],
    canonicalReadyEverywhere,
    accountPlans,
    cleanup,
    automaticHardDeleteAllowed: false
  };
}

export function verifyWorkspaceAppSyncPostRead(plan, postReadInventories = []) {
  if (plan?.schemaVersion !== 1 || plan?.logicalPluginId !== 'aicc-workspace') throw new Error('invalid sync plan');
  const inventories = new Map(postReadInventories.map(item => [item.accountAlias, item]));
  const holds = [];
  for (const accountPlan of plan.accountPlans) {
    const inventory = normalizedInventory(inventories.get(accountPlan.accountAlias), accountPlan.accountAlias);
    for (const action of accountPlan.actions) {
      if (!['retain', 'update', 'enable', 'share'].includes(action.action) || !action.appId) {
        holds.push({ accountAlias: accountPlan.accountAlias, reason: 'canonical_action_unverified', action: action.action });
        continue;
      }
      const exact = inventory.apps.filter(app => app.appId === action.appId);
      if (exact.length !== 1 || exact[0].status !== 'ENABLED') {
        holds.push({ accountAlias: accountPlan.accountAlias, appId: action.appId, reason: 'canonical_post_read_mismatch' });
      } else {
        const fields = desiredDiff(accountPlan.desired, exact[0]);
        if (fields.length) holds.push({ accountAlias: accountPlan.accountAlias, appId: action.appId, reason: 'canonical_schema_drift', fields });
        if (accountPlan.role === 'member' && exact[0].sharedFromAccountAlias !== accountPlan.desired.ownerAccountAlias) {
          holds.push({ accountAlias: accountPlan.accountAlias, appId: action.appId, reason: 'shared_owner_binding_mismatch' });
        }
      }
    }
  }
  for (const action of plan.cleanup) {
    const inventory = normalizedInventory(inventories.get(action.accountAlias), action.accountAlias);
    const exact = inventory.apps.filter(app => app.appId === action.appId);
    if (!['retain', 'ignore', 'disable', 'delete'].includes(action.action)) {
      holds.push({ accountAlias: action.accountAlias, appId: action.appId, reason: 'cleanup_action_unverified', action: action.action });
    }
    if (action.action === 'disable' && (exact.length !== 1 || exact[0].status !== 'DISABLED')) {
      holds.push({ accountAlias: action.accountAlias, appId: action.appId, reason: 'disable_post_read_mismatch' });
    }
    if (action.action === 'delete' && exact.length !== 0) {
      holds.push({ accountAlias: action.accountAlias, appId: action.appId, reason: 'delete_post_read_mismatch' });
    }
    if(action.action==='delete' && !inventory.registered)holds.push({accountAlias:action.accountAlias,appId:action.appId,reason:'registered_inventory_required'});
  }
  return { ok: holds.length === 0, status: holds.length === 0 ? 'pass' : 'hold', holds };
}
