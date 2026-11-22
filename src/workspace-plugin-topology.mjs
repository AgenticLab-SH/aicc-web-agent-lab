import crypto from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/;
const ROLES = new Set(['business-owner', 'business-member', 'personal']);
const INSTALL_STATES = new Set(['installed', 'available', 'unsupported', 'unknown']);
const POLICIES = new Set(['required', 'optional', 'shared', 'unsupported', 'unknown']);

export class WorkspacePluginTopologyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspacePluginTopologyError';
    this.code = code;
  }
}

function exactString(value, label, pattern = STABLE_ID) {
  const normalized = String(value ?? '').trim();
  if (!pattern.test(normalized)) throw new WorkspacePluginTopologyError('identity_invalid', `${label} is invalid`);
  return normalized;
}

function exactHash(value, label) {
  return exactString(value, label, HASH);
}

function normalizeIncluded(items, kind) {
  if (!Array.isArray(items)) throw new WorkspacePluginTopologyError('included_assets_invalid', `${kind} must be an array`);
  const normalized = items.map(item => ({
    id: exactString(item?.id, `${kind} ID`),
    version: String(item?.version ?? '').trim() || null,
    hash: exactHash(item?.hash, `${kind} hash`),
    required: item?.required === true
  })).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(normalized.map(item => item.id)).size !== normalized.length) {
    throw new WorkspacePluginTopologyError('included_assets_duplicate', `${kind} contains duplicate stable IDs`);
  }
  return normalized;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function normalizeWorkspacePluginInventory(input = {}) {
  const accountRole = exactString(input.accountRole, 'account role');
  if (!ROLES.has(accountRole)) throw new WorkspacePluginTopologyError('account_role_invalid', `unsupported account role: ${accountRole}`);
  const installState = exactString(input.installState, 'install state');
  if (!INSTALL_STATES.has(installState)) throw new WorkspacePluginTopologyError('install_state_invalid', `unsupported install state: ${installState}`);
  const installationPolicy = exactString(input.installationPolicy, 'installation policy');
  if (!POLICIES.has(installationPolicy)) throw new WorkspacePluginTopologyError('installation_policy_invalid', `unsupported installation policy: ${installationPolicy}`);
  const supportedSurfaces = [...new Set((input.supportedSurfaces ?? []).map(value => exactString(value, 'supported surface')))].sort();
  const normalized = {
    schemaVersion: 1,
    observedAt: String(input.observedAt ?? '').trim(),
    accountRole,
    identityHash: exactHash(input.identityHash, 'identity hash'),
    workspaceHash: exactHash(input.workspaceHash, 'workspace hash'),
    pluginId: exactString(input.pluginId, 'plugin ID'),
    displayName: String(input.displayName ?? '').trim(),
    ownerHash: exactHash(input.ownerHash, 'owner hash'),
    packageVersion: String(input.packageVersion ?? '').trim(),
    packageHash: exactHash(input.packageHash, 'package hash'),
    installState,
    installationPolicy,
    canRefresh: input.canRefresh === true,
    supportedSurfaces,
    skills: normalizeIncluded(input.skills ?? [], 'skills'),
    apps: normalizeIncluded(input.apps ?? [], 'apps'),
    appTemplates: normalizeIncluded(input.appTemplates ?? [], 'app templates'),
    appSnapshotCurrent: input.appSnapshotCurrent === true,
    permissionPolicy: String(input.permissionPolicy ?? 'unknown').trim() || 'unknown',
    rawAccountIncluded: false,
    authMaterialIncluded: false
  };
  if (!normalized.observedAt || !normalized.displayName || !normalized.packageVersion) {
    throw new WorkspacePluginTopologyError('inventory_incomplete', 'observedAt, displayName and packageVersion are required');
  }
  return Object.freeze({ ...normalized, inventoryHash: fingerprint(normalized) });
}

function includedFingerprint(inventory) {
  return fingerprint({ skills: inventory.skills, apps: inventory.apps, appTemplates: inventory.appTemplates });
}

export function planWorkspacePluginSync({ desired, observed = null } = {}) {
  const target = normalizeWorkspacePluginInventory(desired);
  const current = observed ? normalizeWorkspacePluginInventory(observed) : null;
  if (current && (current.identityHash !== target.identityHash || current.workspaceHash !== target.workspaceHash || current.accountRole !== target.accountRole)) {
    return { action: 'hold', reason: 'identity_or_workspace_mismatch', pluginId: target.pluginId, externalWritePerformed: false };
  }
  if (current && current.pluginId !== target.pluginId) {
    return { action: 'hold', reason: 'stable_plugin_id_mismatch', pluginId: target.pluginId, observedPluginId: current.pluginId, externalWritePerformed: false };
  }
  if (!current) {
    return target.installationPolicy === 'unsupported'
      ? { action: 'hold', reason: 'plugin_unsupported_on_surface', pluginId: target.pluginId, externalWritePerformed: false }
      : { action: 'install_candidate', reason: 'plugin_absent', pluginId: target.pluginId, expectedPackageHash: target.packageHash, externalWritePerformed: false };
  }
  const packageCurrent = current.packageVersion === target.packageVersion && current.packageHash === target.packageHash;
  const includedCurrent = includedFingerprint(current) === includedFingerprint(target);
  const appAction = target.appSnapshotCurrent && current.appSnapshotCurrent
    ? { action: 'retain', reason: 'frozen_app_snapshot_current' }
    : { action: 'separate_app_recreate_or_republish', reason: 'frozen_app_snapshot_drift_or_unknown' };
  if (packageCurrent && includedCurrent && current.installState === 'installed') {
    return { action: 'retain', reason: 'plugin_package_current', pluginId: target.pluginId, appAction, externalWritePerformed: false };
  }
  if (!current.canRefresh) {
    return { action: 'hold', reason: 'plugin_refresh_capability_missing', pluginId: target.pluginId, appAction, externalWritePerformed: false };
  }
  return {
    action: 'refresh_candidate',
    reason: packageCurrent ? 'included_assets_drift' : 'package_drift',
    pluginId: target.pluginId,
    expectedCurrentPackageHash: current.packageHash,
    desiredPackageHash: target.packageHash,
    appAction,
    externalWritePerformed: false
  };
}

export function planPluginDuplicateQuarantine({ canonicalPluginId, inventory = [], references = {} } = {}) {
  const canonical = exactString(canonicalPluginId, 'canonical plugin ID');
  const normalized = inventory.map(normalizeWorkspacePluginInventory);
  if (!normalized.some(item => item.pluginId === canonical)) throw new WorkspacePluginTopologyError('canonical_plugin_missing', 'canonical plugin is missing');
  const byId = new Map();
  for (const item of normalized) {
    if (byId.has(item.pluginId)) throw new WorkspacePluginTopologyError('plugin_id_duplicate', `duplicate inventory for stable ID: ${item.pluginId}`);
    byId.set(item.pluginId, item);
  }
  return normalized.filter(item => item.pluginId !== canonical).map(item => {
    const consumers = [...new Set((references[item.pluginId] ?? []).map(value => String(value)))].sort();
    return consumers.length > 0
      ? { pluginId: item.pluginId, action: 'retain', reason: 'reference_nonzero', consumers }
      : { pluginId: item.pluginId, action: 'disable_candidate', reason: 'reference_zero', quarantineDays: 14, hardDelete: false };
  });
}
