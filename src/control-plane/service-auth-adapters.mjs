import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../lib/command.mjs';
import { ocxAccountStatus } from '../adapters/ocx-accounts.mjs';

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{1,127}$/;
const A1_IDENTITY_OBSERVER_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tools/platform/oracle/codex-cycle-watch/account_identity_status.ps1'
);

export class ServiceAuthAdapterError extends Error {
  constructor(code, message) { super(message); this.name = 'ServiceAuthAdapterError'; this.code = code; }
}

function regularJson(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new ServiceAuthAdapterError(`${label}_missing`, `${label} file is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ServiceAuthAdapterError(`${label}_unsafe`, `${label} must be a regular file`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new ServiceAuthAdapterError(`${label}_invalid`, `${label} is invalid JSON`); }
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function loopbackOrigin(value, label) {
  let url;
  try { url = new URL(String(value ?? '')); }
  catch { throw new ServiceAuthAdapterError(`${label}_invalid`, `${label} is invalid`); }
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost','::1'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ServiceAuthAdapterError(`${label}_invalid`, `${label} must be an owner-local loopback HTTP origin`);
  }
  return url.origin;
}

async function defaultOcxStatus(options = {}) {
  const executable = options.executable ?? process.env.AICC_OCX_EXECUTABLE?.trim() ?? 'ocx';
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const runner = options.runCommand ?? runCommand;
  const shell = environment.ComSpec?.trim() || process.env.ComSpec?.trim() || 'cmd.exe';
  const invocation = platform === 'win32'
    ? { executable: shell, args: ['/d','/s','/c',executable,'status','--json'] }
    : { executable, args: ['status','--json'] };
  const result = await runner(invocation.executable, invocation.args, { timeoutMs: options.timeoutMs ?? 8000, env: environment, platform });
  if (!result?.ok) throw new ServiceAuthAdapterError('ocx_status_unavailable', 'OCX status could not be read');
  try { return JSON.parse(result.stdout); }
  catch { throw new ServiceAuthAdapterError('ocx_status_invalid', 'OCX status returned invalid JSON'); }
}

async function defaultOcxIdentityObservation(options = {}) {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return null;
  const environment = options.environment ?? process.env;
  const scriptPath = options.scriptPath ?? A1_IDENTITY_OBSERVER_SCRIPT;
  const accessRoot = options.accessRoot ?? path.join(home, '.ai-control-center', 'oracle-a1-access');
  if (!fs.existsSync(scriptPath) || !fs.existsSync(accessRoot)) return null;
  const runner = options.runCommand ?? runCommand;
  const executable = options.pwshExecutable ?? environment.AICC_PWSH_EXECUTABLE?.trim() ?? 'pwsh';
  const result = await runner(executable, [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-Root', accessRoot
  ], {
    timeoutMs: options.timeoutMs ?? 20_000,
    env: environment,
    platform
  });
  if (!result?.ok) return null;
  let payload;
  try { payload = JSON.parse(result.stdout); } catch { return null; }
  if (payload?.schemaVersion !== 1 || payload?.source !== 'a1-ocx-hub' || !Array.isArray(payload.accounts)) return null;
  const observedAt = Number(payload.observedAt);
  if (!Number.isFinite(observedAt) || observedAt <= 0) return null;
  const maxAgeSeconds = Number(options.maxAgeSeconds ?? 300);
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) return null;
  if (Math.abs(Date.now() / 1000 - observedAt) > maxAgeSeconds) return null;
  const accounts = [];
  for (const row of payload.accounts) {
    const identityHash = String(row?.identityHash ?? '');
    const selector = String(row?.selector ?? '');
    const blockReason = row?.blockReason == null ? null : String(row.blockReason);
    if (!HASH.test(identityHash) || !/^[A-Za-z0-9._-]{1,64}$/.test(selector)) return null;
    if (typeof row?.active !== 'boolean') return null;
    if (blockReason !== null && !['paused', 'needs_reauth'].includes(blockReason)) return null;
    accounts.push({
      identityHash,
      selector,
      active: row.active,
      plan: typeof row?.plan === 'string' ? row.plan : null,
      blockReason
    });
  }
  return { schemaVersion: 1, source: 'a1-ocx-hub', observedAt, accounts };
}

async function boundedJson(fetcher, url, attempts = 3, timeoutMs = 3500) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 200));
    } finally { clearTimeout(timer); }
  }
  throw new ServiceAuthAdapterError('service_auth_probe_failed', lastError?.message ?? 'service auth probe failed');
}

export class WebBridgeAuthAdapter {
  constructor(options = {}) {
    const home = options.home ?? os.homedir();
    this.configPath = options.configPath ?? path.join(home, '.codex-chatgpt-web', 'config.json');
    this.healthUrl = options.healthUrl ?? 'http://127.0.0.1:17841/healthz';
    this.readyUrl = options.readyUrl ?? 'http://127.0.0.1:17841/readyz';
    this.fetcher = options.fetch ?? fetch;
    this.attempts = options.attempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? 3500;
  }

  binding() {
    const config = regularJson(this.configPath, 'web_bridge_config');
    if (config.browserIdentityHashVersion !== 2 || !HASH.test(String(config.browserIdentityHash ?? ''))) {
      throw new ServiceAuthAdapterError('web_bridge_identity_binding_missing', 'Web Bridge has no version-2 browser identity binding');
    }
    const accountAlias = String(config.browserAccountAlias ?? '').trim();
    if (!SAFE_ID.test(accountAlias)) throw new ServiceAuthAdapterError('web_bridge_account_alias_missing', 'Web Bridge account alias is missing or unsafe');
    const index = Number.isInteger(config.browserAccountIndex) && config.browserAccountIndex > 0 ? config.browserAccountIndex : 0;
    const profileId = `web-bridge-${index || 'default'}`;
    return { accountAlias, profileId, identityHash: config.browserIdentityHash, browserHost: config.browserHost ?? null };
  }

  async inspect(spec) {
    const binding = this.binding();
    if (spec.accountAlias !== binding.accountAlias) throw new ServiceAuthAdapterError('account_identity_mismatch', 'requested Web Bridge account alias differs from the configured binding');
    if (spec.profileId !== binding.profileId) throw new ServiceAuthAdapterError('profile_identity_mismatch', 'requested Web Bridge profile differs from the configured binding');
    const [health, readiness] = await Promise.all([
      boundedJson(this.fetcher, this.healthUrl, this.attempts, this.timeoutMs),
      boundedJson(this.fetcher, this.readyUrl, this.attempts, this.timeoutMs)
    ]);
    if (health?.status !== 'ok' || readiness?.ready !== true) throw new ServiceAuthAdapterError('web_bridge_unavailable', 'Web Bridge is not healthy and ready');
    if (!HASH.test(String(health.browser_identity_hash ?? '')) || health.browser_identity_hash !== binding.identityHash) {
      throw new ServiceAuthAdapterError('web_bridge_identity_mismatch', 'Web Bridge runtime identity differs from its versioned configured binding');
    }
    if (health.accepting_browser_turns !== true) throw new ServiceAuthAdapterError('web_bridge_browser_not_ready', 'Web Bridge is not accepting browser turns');
    return { authenticated: true, accountAlias: binding.accountAlias, profileId: binding.profileId, expiresAt: null, refreshable: false, restorable: false, stateRef: 'web-bridge-runtime-v2' };
  }
}

export function buildOcxHubBinding(config, options = {}) {
  if (config?.runtimeRole !== 'client' || !config?.client || typeof config.client !== 'object') {
    throw new ServiceAuthAdapterError('ocx_hub_client_required', 'OCX hub binding requires runtimeRole=client');
  }
  const serverUrl = loopbackOrigin(config.client.serverUrl, 'ocx_hub_server_url');
  const managementUrl = loopbackOrigin(config.client.managementUrl, 'ocx_hub_management_url');
  const apiKeyId = String(config.client.apiKeyId ?? '').trim();
  const protocolVersion = Number(config.client.protocolVersion);
  if (!SAFE_ID.test(apiKeyId)) throw new ServiceAuthAdapterError('ocx_hub_key_id_invalid', 'OCX client apiKeyId is missing or unsafe');
  if (!Number.isInteger(protocolVersion) || protocolVersion < 1) throw new ServiceAuthAdapterError('ocx_hub_protocol_invalid', 'OCX client protocolVersion is invalid');
  if (!Array.isArray(config.client.selectedClients) || !config.client.selectedClients.includes('codex')) {
    throw new ServiceAuthAdapterError('ocx_hub_codex_not_selected', 'OCX hub connection is not selected for Codex');
  }
  const accountAlias = String(options.accountAlias ?? 'a1-hub').trim();
  const profileId = String(options.profileId ?? 'ocx-hub-a1').trim();
  if (!SAFE_ID.test(accountAlias) || !SAFE_ID.test(profileId)) throw new ServiceAuthAdapterError('ocx_hub_binding_name_invalid', 'OCX hub binding names are invalid');
  const connectionHash = sha256Json({ serverUrl, managementUrl, apiKeyId, protocolVersion });
  return Object.freeze({
    schemaVersion: 1,
    kind: 'ocx-hub-client-binding',
    accountAlias,
    profileId,
    connectionHash,
    serverUrl,
    managementUrl,
    protocolVersion
  });
}

export class OcxHubConnectionAuthAdapter {
  constructor(options = {}) {
    const home = options.home ?? os.homedir();
    this.configPath = options.configPath ?? path.join(home, '.opencodex', 'config.json');
    this.bindingPath = options.bindingPath ?? path.join(home, '.ai-control-center', 'auth-bindings', 'ocx-hub.json');
    this.statusProvider = options.statusProvider ?? (() => defaultOcxStatus(options.statusOptions ?? {}));
  }

  binding() {
    const binding = regularJson(this.bindingPath, 'ocx_hub_binding');
    if (binding?.schemaVersion !== 1 || binding?.kind !== 'ocx-hub-client-binding'
      || !SAFE_ID.test(String(binding.accountAlias ?? '')) || !SAFE_ID.test(String(binding.profileId ?? ''))
      || !HASH.test(String(binding.connectionHash ?? ''))) {
      throw new ServiceAuthAdapterError('ocx_hub_binding_invalid', 'OCX hub trust binding is invalid');
    }
    const serverUrl = loopbackOrigin(binding.serverUrl, 'ocx_hub_binding_server_url');
    const managementUrl = loopbackOrigin(binding.managementUrl, 'ocx_hub_binding_management_url');
    const protocolVersion = Number(binding.protocolVersion);
    if (!Number.isInteger(protocolVersion) || protocolVersion < 1) throw new ServiceAuthAdapterError('ocx_hub_binding_invalid', 'OCX hub binding protocol is invalid');
    return { ...binding, serverUrl, managementUrl, protocolVersion };
  }

  currentConnection() {
    const config = regularJson(this.configPath, 'ocx_client_config');
    const record = buildOcxHubBinding(config);
    return {
      config,
      serverUrl: record.serverUrl,
      managementUrl: record.managementUrl,
      protocolVersion: record.protocolVersion,
      connectionHash: record.connectionHash,
      apiKeyId: String(config.client.apiKeyId)
    };
  }

  async inspect(spec) {
    const binding = this.binding();
    if (spec.accountAlias !== binding.accountAlias) throw new ServiceAuthAdapterError('account_identity_mismatch', 'requested OCX hub alias differs from the trusted binding');
    if (spec.profileId !== binding.profileId) throw new ServiceAuthAdapterError('profile_identity_mismatch', 'requested OCX hub profile differs from the trusted binding');

    const current = this.currentConnection();
    if (current.connectionHash !== binding.connectionHash
      || current.serverUrl !== binding.serverUrl
      || current.managementUrl !== binding.managementUrl
      || current.protocolVersion !== binding.protocolVersion) {
      throw new ServiceAuthAdapterError('ocx_hub_identity_mismatch', 'current OCX hub connection differs from the trusted binding');
    }

    const status = await this.statusProvider();
    const connection = status?.connection;
    if (status?.runtimeRole !== 'client' || connection?.state !== 'connected' || connection?.readiness !== 'ready'
      || status?.remoteHub?.connected !== true || status?.proxy?.health?.ok !== true) {
      throw new ServiceAuthAdapterError('ocx_hub_unavailable', 'trusted OCX hub connection is not connected and ready');
    }
    const liveServerUrl = loopbackOrigin(connection.serverUrl, 'ocx_live_server_url');
    const liveManagementUrl = loopbackOrigin(connection.managementUrl, 'ocx_live_management_url');
    if (liveServerUrl !== current.serverUrl || liveManagementUrl !== current.managementUrl
      || Number(connection.protocolVersion) !== current.protocolVersion
      || String(connection.apiKeyId ?? '') !== current.apiKeyId) {
      throw new ServiceAuthAdapterError('ocx_hub_runtime_identity_mismatch', 'OCX runtime connection differs from the trusted client configuration');
    }

    return {
      authenticated: true,
      accountAlias: binding.accountAlias,
      profileId: binding.profileId,
      expiresAt: null,
      refreshable: false,
      restorable: false,
      stateRef: 'ocx-hub-client-connected'
    };
  }
}

export class OcxExactAccountAuthAdapter {
  constructor(options = {}) {
    this.accountStatus = options.accountStatus ?? ocxAccountStatus;
    this.accountStatusOptions = options.accountStatusOptions ?? {};
    this.providerId = options.providerId ?? 'openai';
    this.identityObserver = options.identityObserver ?? (() => defaultOcxIdentityObservation({
      home: options.home,
      ...(options.identityObserverOptions ?? {})
    }));
  }

  async inspect(spec) {
    const requestedId = String(spec.accountAlias ?? '').trim();
    if (!SAFE_ID.test(requestedId)) {
      throw new ServiceAuthAdapterError('auth_binding_not_registered', 'requested OCX account ID is invalid');
    }
    const expectedProfile = `ocx-${this.providerId}-${requestedId}`;
    if (spec.profileId !== expectedProfile) {
      throw new ServiceAuthAdapterError('profile_identity_mismatch', 'requested OCX profile differs from the exact account binding');
    }

    const status = await this.accountStatus({ ...this.accountStatusOptions, refresh: false });
    const directReadable = status?.state !== 'unavailable'
      && status?.state !== 'degraded'
      && Array.isArray(status?.accounts);
    if (directReadable) {
      const matches = status.accounts.filter(account => account?.id === requestedId);
      if (matches.length !== 1) {
        throw new ServiceAuthAdapterError('auth_binding_not_registered', 'requested OCX account ID is not uniquely registered');
      }
      const account = matches[0];
      const activeId = status.activeId ?? status.accounts.find(item => item?.active)?.id ?? null;
      if (activeId !== requestedId || account.active !== true) {
        throw new ServiceAuthAdapterError('account_identity_mismatch', 'OCX active account differs from the requested exact binding; automatic switching is prohibited');
      }
      if (account.paused === true) {
        throw new ServiceAuthAdapterError('ocx_account_paused', 'requested OCX account is paused');
      }
      return {
        authenticated: account.needsReauth !== true,
        accountAlias: requestedId,
        profileId: expectedProfile,
        expiresAt: null,
        refreshable: false,
        restorable: false,
        stateRef: account.needsReauth === true ? 'ocx-account-reauth-required' : 'ocx-account-active'
      };
    }

    let observation = null;
    try { observation = await this.identityObserver(); } catch { observation = null; }
    if (!observation || !Array.isArray(observation.accounts)) {
      throw new ServiceAuthAdapterError('ocx_account_surface_unavailable', 'OCX exact account surface and A1 identity observer are unavailable; account identity cannot be inferred from service health');
    }
    const requestedHash = createHash('sha256').update(requestedId).digest('hex');
    const matches = observation.accounts.filter(account => account?.identityHash === requestedHash);
    if (matches.length !== 1) {
      throw new ServiceAuthAdapterError('auth_binding_not_registered', 'requested OCX account identity is not uniquely registered on the A1 hub');
    }
    const account = matches[0];
    const activeAccounts = observation.accounts.filter(item => item?.active === true);
    if (activeAccounts.length !== 1 || account.active !== true) {
      throw new ServiceAuthAdapterError('account_identity_mismatch', 'A1 OCX active account differs from the requested exact binding; automatic switching is prohibited');
    }
    if (account.blockReason === 'paused') {
      throw new ServiceAuthAdapterError('ocx_account_paused', 'requested OCX account is paused');
    }
    const needsReauth = account.blockReason === 'needs_reauth';
    return {
      authenticated: !needsReauth,
      accountAlias: requestedId,
      profileId: expectedProfile,
      expiresAt: null,
      refreshable: false,
      restorable: false,
      stateRef: needsReauth ? 'ocx-account-a1-reauth-required' : 'ocx-account-a1-observed-active'
    };
  }
}