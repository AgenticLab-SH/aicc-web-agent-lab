import { workspaceToolSnapshot } from '../components/workspace-mcp/tool-manifest.mjs';

const ACCOUNT_ALIAS = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const APP_ID = /^(?:plugin_)?asdk_app_[a-z0-9]+$/i;

function accountAlias(value, label) {
  const normalized = String(value ?? '').trim();
  if (!ACCOUNT_ALIAS.test(normalized)) throw new Error(`${label} must be a safe account alias`);
  return normalized;
}

function remoteAppId(value, label) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!APP_ID.test(normalized)) throw new Error(`${label} must be an exact ChatGPT app/plugin ID`);
  return normalized;
}

/**
 * Expand a small account topology into the complete desired-state request used
 * by the sync planner. Source hashes come from the local canonical
 * manifest; a reviewed remote catalog can independently bind integrated tools.
 */
export function buildWorkspaceAppSyncRequest(topology = {}, observed = {}) {
  if (topology.schemaVersion !== 1 || topology.logicalPluginId !== 'aicc-workspace') {
    throw new Error('topology must describe schemaVersion 1 logicalPluginId=aicc-workspace');
  }
  if (observed.schemaVersion !== 1 || !Array.isArray(observed.inventories)) {
    throw new Error('observed inventory envelope must use schemaVersion 1');
  }
  if (!Array.isArray(topology.accounts) || topology.accounts.length < 1) {
    throw new Error('topology.accounts cannot be empty');
  }
  const aliases = new Set();
  const accounts = topology.accounts.map((entry, index) => {
    const alias = accountAlias(entry?.accountAlias, `accounts[${index}].accountAlias`);
    if (aliases.has(alias)) throw new Error(`duplicate topology account alias: ${alias}`);
    aliases.add(alias);
    const role = entry?.role;
    if (!['owner', 'member'].includes(role)) throw new Error(`accounts[${index}].role must be owner or member`);
    const surfaceProfile = entry?.surfaceProfile;
    if (!['business-full', 'personal-read-fetch'].includes(surfaceProfile)) {
      throw new Error(`accounts[${index}].surfaceProfile must be explicit`);
    }
    if (surfaceProfile === 'personal-read-fetch' && role !== 'owner') {
      throw new Error('Personal bindings must be owner replicas, not Business shares');
    }
    const ownerAccountAlias = role === 'member'
      ? accountAlias(entry?.ownerAccountAlias, `accounts[${index}].ownerAccountAlias`)
      : null;
    const manifest = workspaceToolSnapshot({ surfaceProfile });
    const verificationBasis = entry.verificationBasis ?? 'source-manifest';
    if (!['source-manifest', 'remote-catalog'].includes(verificationBasis)) {
      throw new Error('Unsupported verification basis');
    }
    let catalogHash = manifest.hash;
    let toolCounts = { total: manifest.toolCount, read: manifest.readToolCount, write: manifest.writeToolCount };
    if (verificationBasis === 'remote-catalog') {
      const contract = entry.acceptedRemoteCatalog;
      if (!entry.remoteAppId || !/^[a-f0-9]{64}$/.test(contract?.toolCatalogHash ?? '')) {
        throw new Error('Accepted remote catalog requires an exact app ID and SHA-256');
      }
      const counts = contract.toolCounts;
      if (!counts || !['total', 'read', 'write'].every(key => Number.isInteger(counts[key]) && counts[key] >= 0)
        || counts.total < 1 || counts.read + counts.write !== counts.total
        || (surfaceProfile === 'personal-read-fetch' && counts.write !== 0)) {
        throw new Error('Accepted remote catalog counts are invalid for the surface');
      }
      catalogHash = contract.toolCatalogHash;
      toolCounts = { total: counts.total, read: counts.read, write: counts.write };
    }
    return {
      verificationBasis,
      accountAlias: alias,
      role,
      surfaceProfile,
      ...(ownerAccountAlias ? { ownerAccountAlias } : {}),
      remoteAppId: remoteAppId(entry?.remoteAppId, `accounts[${index}].remoteAppId`),
      manifestHash: manifest.hash,
      // Accepted remote schemas stay separate from the local source manifest.
      toolCatalogHash: catalogHash,
      toolCounts
    };
  });
  const byAlias = new Map(accounts.map(item => [item.accountAlias, item]));
  for (const item of accounts.filter(account => account.role === 'member')) {
    const owner = byAlias.get(item.ownerAccountAlias);
    if (!owner || owner.role !== 'owner' || owner.surfaceProfile !== 'business-full') {
      throw new Error(`Business member ${item.accountAlias} must reference a Business owner`);
    }
    if (item.surfaceProfile !== 'business-full') throw new Error('member bindings must use business-full');
    if (item.remoteAppId !== owner.remoteAppId) {
      throw new Error(`Business member ${item.accountAlias} must share the exact owner remoteAppId, including null`);
    }
  }
  const inventoryAliases = observed.inventories.map((item, index) => accountAlias(item?.accountAlias, `inventories[${index}].accountAlias`));
  if (new Set(inventoryAliases).size !== inventoryAliases.length) throw new Error('observed inventories contain duplicate accounts');
  const missing = [...aliases].filter(alias => !inventoryAliases.includes(alias));
  const unexpected = inventoryAliases.filter(alias => !aliases.has(alias));
  if (missing.length || unexpected.length) {
    throw new Error(`inventory account scope mismatch: missing=${missing.join(',') || '-'} unexpected=${unexpected.join(',') || '-'}`);
  }
  return {
    logicalPluginId: 'aicc-workspace',
    desiredAccounts: accounts,
    inventories: observed.inventories,
    passedCanaryAccounts: observed.passedCanaryAccounts ?? [],
    deleteAuthorizations: observed.deleteAuthorizations ?? []
  };
}
