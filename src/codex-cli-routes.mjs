import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareCheckpointHandoff, claimCheckpointHandoff, finishCheckpointHandoff } from './codex-checkpoint-handoff.mjs';
import { claimSourceLaunch, produceCheckpointAfterExit, resumeThreadFromArgs } from './codex-checkpoint-stop.mjs';
import { nativeRescueStatus } from './native-rescue.mjs';
import { OFFICIAL_NATIVE_CODEX_ENDPOINT, routeLauncherPaths } from './codex-route-launchers.mjs';

const ROUTES = Object.freeze({
  native: Object.freeze({
    endpoint: OFFICIAL_NATIVE_CODEX_ENDPOINT,
    health: null,
    ready: null,
    profile: 'native'
  }),
  ocx: Object.freeze({
    endpoint: 'http://127.0.0.1:10100/v1',
    health: 'http://127.0.0.1:10100/healthz',
    ready: 'http://127.0.0.1:10100/readyz',
    profile: null
  })
});

const FORBIDDEN_EXACT = new Set([
  '-c', '--config', '-p', '--profile', '-m', '--model', '--oss',
  '--local-provider', '--remote', '--remote-auth-token-env'
]);
const FORBIDDEN_PREFIXES = [
  '-c=', '--config=', '-p=', '--profile=', '-m=', '--model=',
  '--local-provider=', '--remote=', '--remote-auth-token-env='
];

function opencodexHome(options = {}, home = options.home ?? os.homedir()) {
  return options.opencodexHome
    ?? process.env.OPENCODEX_HOME?.trim()
    ?? path.join(home, '.opencodex');
}

function readManagedLocalRoute(options = {}, home = options.home ?? os.homedir()) {
  if (options.opencodexHome) return null;
  const stateRoot = path.resolve(options.stateRoot ?? process.env.AICC_STATE_ROOT ?? path.join(home, '.ai-control-center'));
  const file = path.join(stateRoot, 'runtime', 'ocx-local', 'current.json');
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error('Managed local OCX registry is unsafe');
  let registered;
  try { registered = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Managed local OCX registry is invalid; no legacy route fallback'); }
  const expectedHome = path.join(stateRoot, 'runtime', 'ocx-local', 'home');
  const expectedToken = path.join(home, '.opencodex', 'service-api-token');
  if (registered?.schemaVersion !== 1 || registered.requestExecution !== 'windows-local'
    || registered.credentialWriter !== 'a1' || typeof registered.opencodexHome !== 'string'
    || typeof registered.tokenFile !== 'string' || path.resolve(registered.opencodexHome) !== expectedHome
    || path.resolve(registered.tokenFile) !== path.resolve(expectedToken)) {
    throw new Error('Managed local OCX owner differs; no legacy route fallback');
  }
  return { endpoint: ROUTES.ocx.endpoint, health: ROUTES.ocx.health, ready: ROUTES.ocx.ready,
    admissionTokenFile: expectedToken, accountConfigFile: path.join(expectedHome, 'config.json'), mode: 'managed-local' };
}

function readOcxClientRoute(options = {}, home = options.home ?? os.homedir()) {
  const root = opencodexHome(options, home);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (config?.runtimeRole !== 'client' || typeof config?.client?.serverUrl !== 'string') return null;
  let url;
  try {
    url = new URL(config.client.serverUrl);
  } catch {
    throw new Error('OCX client serverUrl is invalid');
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'http:' || !loopback || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('OCX client data endpoint must be an owner-local loopback HTTP origin');
  }
  const origin = url.origin;
  return {
    endpoint: `${origin}/v1`,
    health: `${origin}/healthz`,
    ready: `${origin}/readyz`,
    admissionTokenFile: path.join(root, 'service-api-token'),
    mode: 'remote-client'
  };
}

function routeDefinition(route, options = {}) {
  const definition = ROUTES[route];
  if (!definition) throw new Error(`Unknown Codex CLI route: ${route}`);
  if (route !== 'ocx') return definition;
  return { ...definition, ...(readManagedLocalRoute(options) ?? readOcxClientRoute(options) ?? { mode: 'standalone' }) };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function readCatalog(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const models = Array.isArray(parsed?.models)
      ? parsed.models.map(item => item?.slug ?? item?.id).filter(Boolean)
      : Array.isArray(parsed?.data)
        ? parsed.data.map(item => item?.id ?? item?.slug).filter(Boolean)
        : [];
    return { file, models };
  } catch {
    return { file, models: [] };
  }
}

function firstCatalogWithModel(candidates, model) {
  for (const candidate of candidates.filter(Boolean)) {
    const catalog = readCatalog(candidate);
    if (catalog.models.includes(model)) return catalog;
  }
  return null;
}

const USER_CONFIG_KEYS = new Set(['approval_policy', 'approvals_reviewer', 'sandbox_mode', 'personality', 'model_reasoning_effort', 'model_verbosity']);
function assertSafeArguments(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') break; // Subsequent prompt text is data, not launcher options.
    if (argument === '-c' || argument === '--config' || argument.startsWith('--config=') || argument.startsWith('-c=')) {
      const value = argument === '-c' || argument === '--config' ? args[++index] : argument.slice(argument.indexOf('=') + 1);
      const match = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(value ?? '');
      if (!match || !USER_CONFIG_KEYS.has(match[1]) || /[\r\n\0]/.test(value)) throw new Error('Compatibility config accepts only explicit user approval/sandbox/personality/reasoning options; route/auth/catalog overrides are refused');
      continue;
    }
    if (FORBIDDEN_EXACT.has(argument) || FORBIDDEN_PREFIXES.some(prefix => argument.startsWith(prefix))
      || /^-[cpm][^=]/.test(argument)) {
      const error = new Error(`Codex ${argument} cannot replace the selected route`);
      error.code = 'AICC_CODEX_ROUTE_OVERRIDE';
      throw error;
    }
  }
}

// Advisory user-layer selection only. Codex still resolves project/session layers itself.
function userLayerString(file, key) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Codex user config must be a bounded regular file');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`));
    if (match) return match[1].startsWith('"') ? JSON.parse(match[1]) : match[1].slice(1, -1);
  }
  return null;
}
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
function validateReasoningEffort(value) {
  if (!REASONING_EFFORTS.has(value)) throw new Error(`Invalid Codex route reasoning effort: ${value}`);
  return value;
}

function validateModel(model) {
  if (!/^[A-Za-z0-9._/-]+$/.test(model)) throw new Error(`Invalid Codex route model: ${model}`);
  if (/^gpt-5\.5(?:$|[-/])/i.test(model)) throw new Error('GPT-5.5 is not allowed for AICC Codex routes');
  return model;
}

function validateAccountSelector(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    || ['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase())) {
    throw new Error('Invalid --route-account: use an exact registered OCX selector');
  }
  return value;
}

function readAccountBindings(route, options) {
  const definition = routeDefinition(route, options);
  if (definition.mode === 'remote-client') throw new Error('Exact account binding is unavailable on this remote client; no account fallback');
  const file = definition.accountConfigFile ?? path.join(opencodexHome(options), 'config.json');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('OCX account binding file is unsafe');
  const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  return { file, config };
}

function numberedAccounts(config) {
  const namespaces = config.codexAccountNamespaces ?? {};
  const rows = (config.codexAccounts ?? []).filter(row => !row.isMain).flatMap(account => {
    // Owner aliases define account numbers; pool order and priority never do.
    const match = /^([1-9][0-9]*)번\(([^()\r\n]+)\)$/.exec(account.alias ?? '');
    if (!match || !Number.isSafeInteger(Number(match[1]))) return [];
    const selectors = Object.entries(namespaces).filter(([, target]) => target === account.id).map(([key]) => key);
    if (selectors.length === 0) return [];
    const selector = selectors.includes(account.logLabel) ? account.logLabel : selectors.length === 1 ? selectors[0] : null;
    if (!selector) throw new Error('Ambiguous OCX account binding; no automatic account selection');
    validateAccountSelector(selector);
    const name = match[2].trim();
    if (!name) return [];
    return [{ number: Number(match[1]), name, selector, target: account.id,
      paused: (config.pausedCodexAccountIds ?? []).includes(account.id) }];
  });
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.number)) throw new Error('Ambiguous OCX account number; no automatic account selection');
    seen.add(row.number);
  }
  const abbreviate = (value, length) => {
    const chars = Array.from(value);
    return chars.length <= length + 1 ? value : chars.slice(0, length).join('') + '-' + chars.at(-1);
  };
  for (const row of rows) {
    let count = 1;
    while (count < Array.from(row.name).length && rows.some(other => other !== row && other.name !== row.name
      && abbreviate(other.name, count).toLowerCase() === abbreviate(row.name, count).toLowerCase())) count += 1;
    row.shortName = abbreviate(row.name, count);
    row.label = 'A' + row.number + ' ' + row.shortName;
  }
  return rows.sort((left, right) => left.number - right.number);
}

function accountBinding(route, options, choice) {
  const { file, config } = readAccountBindings(route, options);
  const number = /^[1-9][0-9]*$/.test(choice) ? Number(choice) : null;
  const accounts = numberedAccounts(config);
  const row = number === null ? accounts.find(account => account.selector === choice) : accounts.find(account => account.number === number);
  const selector = row?.selector ?? choice;
  if (number !== null && !row) throw new Error('Unknown OCX account number; no automatic account selection');
  if (!config.codexAccountNamespaces || !Object.hasOwn(config.codexAccountNamespaces, selector)) {
    throw new Error('Unknown OCX account selector; no automatic account selection');
  }
  const target = config.codexAccountNamespaces[selector];
  if (target !== '@main' && !(config.codexAccounts ?? []).some(account => account.id === target && !account.isMain)) {
    throw new Error('OCX selector has no current exact account binding');
  }
  if (target !== '@main' && (config.pausedCodexAccountIds ?? []).includes(target)) {
    throw new Error('Selected OCX account is paused; no account fallback');
  }
  return { file, target, selector, number: row?.number ?? null, label: row?.label ?? 'OCX account' };
}

export function ocxCliAccountSelectors(options = {}) {
  const { config } = readAccountBindings('ocx', options);
  const accounts = numberedAccounts(config).map(row => ({
    number: row.number, account: 'A' + row.number, name: row.shortName, label: row.label, paused: row.paused
  }));
  return { accounts, source: 'owner-local-config', liveAccountAdmission: 'NOT_CHECKED', globalConfigMutation: false };
}

export function parseCodexRouteArguments(args = []) {
  const forwarded = [];
  let model = null;
  let reasoningEffort = null;
  let accountSelector = null;
  let preferredAccount = null;
  let handoffCheckpoint = null;
  let checkpointDir = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') { forwarded.push(...args.slice(index)); break; }
    if (argument === '--account' || argument.startsWith('--account=') || argument === '--route-account' || argument.startsWith('--route-account=')) {
      if (accountSelector !== null) throw new Error('--account/--route-account may be specified only once');
      const option = argument.startsWith('--account') ? '--account' : '--route-account';
      const value = argument === option ? args[++index] : argument.slice(option.length + 1);
      if (option === '--account' && !/^[1-9][0-9]*$/.test(value ?? '')) throw new Error('--account requires a registered account number');
      accountSelector = validateAccountSelector(value);
    } else if (argument === '--prefer-account' || argument.startsWith('--prefer-account=')) {
      if (preferredAccount !== null) throw new Error('--prefer-account may be specified only once');
      const value = argument === '--prefer-account' ? args[++index] : argument.slice('--prefer-account='.length);
      if (!/^[1-9][0-9]*$/.test(value ?? '')) throw new Error('--prefer-account requires a registered account number');
      preferredAccount = value;
    } else if (argument === '--handoff-checkpoint') {
      if (handoffCheckpoint !== null || !path.isAbsolute(args[index + 1] ?? '')) throw new Error('One absolute checkpoint file required');
      handoffCheckpoint = args[++index];
    } else if (argument === '--checkpoint-dir') {
      if (checkpointDir !== null || !path.isAbsolute(args[index + 1] ?? '')) throw new Error('One absolute checkpoint directory required');
      checkpointDir = args[++index];
    } else if (argument === '--route-effort' || argument.startsWith('--route-effort=')) {
      if (reasoningEffort !== null) throw new Error('--route-effort may be specified only once');
      const value = argument === '--route-effort' ? args[++index] : argument.slice('--route-effort='.length);
      reasoningEffort = validateReasoningEffort(value);
    } else if (['--route-model', '--model', '-m'].includes(argument)) {
      if (model !== null || !args[index + 1]) throw new Error('--route-model requires one model value');
      model = validateModel(args[index + 1]);
      index += 1;
    } else if (argument.startsWith('--route-model=') || argument.startsWith('--model=')) {
      if (model !== null) throw new Error('--route-model may be specified only once');
      model = validateModel(argument.slice(argument.indexOf('=') + 1));
    } else {
      forwarded.push(argument);
    }
  }
  if (accountSelector !== null && preferredAccount !== null) throw new Error('Choose strict --account or failover --prefer-account, not both');
  if (handoffCheckpoint !== null && checkpointDir !== null) throw new Error('A handoff launch cannot also produce a new checkpoint');
  return { model, reasoningEffort, ...(accountSelector === null ? {} : { accountSelector }),
    ...(preferredAccount === null ? {} : { preferredAccount }), ...(handoffCheckpoint === null ? {} : { handoffCheckpoint }),
    ...(checkpointDir === null ? {} : { checkpointDir }), args: forwarded };
}

function prerequisites(route, options = {}) {
  const definition = routeDefinition(route, options);
  const home = options.home ?? os.homedir();
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(home, '.codex');
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT ?? path.join(home, '.ai-control-center');
  const native = options.nativeStatus ?? nativeRescueStatus({ ...options, home, codexHome, stateRoot });
  const baseConfig = path.join(codexHome, 'config.toml');
  const profileFile = route === 'native' ? path.join(codexHome, 'native.config.toml') : null;
  const explicitModel = options.model != null;
  const inheritedModel = userLayerString(profileFile ?? baseConfig, 'model') ?? userLayerString(baseConfig, 'model');
  const baseModel = explicitModel ? validateModel(options.model) : inheritedModel ? validateModel(inheritedModel) : null;
  if (baseModel?.startsWith('chatgpt-web/')) throw new Error('Web model namespace requires the explicit aicc-webgpt profile; this route will not forward it');
  const accountChoice = options.accountSelector == null ? null : validateAccountSelector(String(options.accountSelector));
  const preferredAccountChoice = options.preferredAccount == null ? null : validateAccountSelector(String(options.preferredAccount));
  if (accountChoice && preferredAccountChoice) throw new Error('Choose strict account binding or preferred account failover, not both');
  if ((accountChoice || preferredAccountChoice) && route !== 'ocx') throw new Error('Account selection is only supported by OCX');
  if ((accountChoice || preferredAccountChoice) && (!baseModel || baseModel.includes('/'))) throw new Error('Account selection requires an unqualified explicit or inherited base model');
  const binding = accountChoice ? accountBinding(route, options, accountChoice) : null;
  const preferredBinding = preferredAccountChoice ? accountBinding(route, options, preferredAccountChoice) : null;
  const accountSelector = binding?.selector ?? null;
  const preferredAccountSelector = preferredBinding?.selector ?? null;
  const model = accountSelector ? `${accountSelector}/${baseModel}` : preferredAccountSelector ? `preferred-${preferredAccountSelector}/${baseModel}` : baseModel;
  const configuredCatalog = route === 'native' ? userLayerString(profileFile, 'model_catalog_json') : userLayerString(baseConfig, 'model_catalog_json');
  const catalogFile = (route === 'native' ? options.nativeCatalog : options.ocxCatalog) ?? (configuredCatalog ? path.resolve(codexHome, configuredCatalog) : null);
  const catalog = catalogFile ? readCatalog(catalogFile) : null;
  return {
    route, endpoint: definition.endpoint, health: definition.health ?? null, readyEndpoint: definition.ready ?? null,
    mode: definition.mode ?? null, admissionTokenFile: definition.admissionTokenFile ?? null,
    accountSelector, accountChoice, accountBinding: binding, preferredAccountSelector, preferredAccountChoice, preferredAccountBinding: preferredBinding,
    baseModel, executable: options.executable ?? native.executable, model,
    accountMode: accountSelector ? 'strict' : preferredAccountSelector ? 'preferred' : 'automatic',
    sameThreadAccountSwitch: accountSelector ? false : 'conditional', quotaProtectionPercent: 97,
    accountSelectionOwner: 'ocx', actualAccount: 'NOT_OBSERVED',
    accountSwitchConditions: ['next_unsent_request', 'settled_previous_turn', 'portable_history', 'verified_eligible_account'],
    quotaContinuation: accountSelector ? 'wait_for_reset' : 'ocx_guarded_same_thread_or_hold',
    modelOverride: explicitModel || Boolean(binding || preferredBinding),
    modelSource: explicitModel ? 'explicit-caller' : 'inherited-codex-layers-user-value-advisory',
    profile: route === 'native' ? 'native' : null, profileFile,
    profileAvailable: route !== 'native' || fs.existsSync(profileFile),
    catalog: catalogFile, catalogOverride: Boolean(binding || preferredBinding),
    modelAvailable: catalog && baseModel ? catalog.models.includes(baseModel) : null,
    independentOf: route === 'native' ? ['ocx', 'aicc:17841', 'web-gpt:17842'] : ['native', 'aicc:17841', 'web-gpt:17842'], fallback: false
  };
}

export function codexCliRouteStatus(options = {}) {
  const routes = Object.fromEntries(['native', 'ocx'].map(route => {
    const status = prerequisites(route, options);
    return [route, { ...status, ready: Boolean(status.executable && status.profileAvailable) }];
  }));
  return {
    ok: routes.native.ready && routes.ocx.ready, state: routes.native.ready && routes.ocx.ready ? 'ready' : 'attention', routes,
    defaultRoute: 'ocx', defaultRouteMeaning: 'source-target-not-effective-daemon-proof',
    readinessScope: 'local-prerequisites-only', liveReadiness: 'NOT_CHECKED', inference: 'NOT_STARTED', globalConfigMutation: false, serviceMutation: false
  };
}

export function buildCodexCliInvocation(route, args = [], options = {}) {
  const selection = parseCodexRouteArguments(args);
  if (selection.handoffCheckpoint || options.handoffCheckpoint) throw Error('Checkpoint must pass the one-shot launch consumer');
  for (const key of ['model', 'reasoningEffort', 'accountSelector', 'preferredAccount']) {
    if (selection[key] != null && options[key] != null) throw new Error(`Duplicate explicit Codex option: ${key}`);
    if (selection[key] != null) options = { ...options, [key]: selection[key] };
  }
  args = selection.args;
  assertSafeArguments(args);
  const status = prerequisites(route, options);
  if (!status.executable) throw new Error('Official Codex executable was not found; use the existing official CLI installer');
  if (!status.profileAvailable) throw new Error('The shared-HOME native.config.toml V2 profile is not installed; preserve legacy rescue and request the registered owner deployment');
  if (status.catalogOverride && (!status.catalog || status.modelAvailable !== true)) throw new Error('Account-scoped launch requires metadata from the configured single OCX catalog; no legacy/native catalog fallback');
  const reasoningEffort = options.reasoningEffort == null ? null : validateReasoningEffort(options.reasoningEffort);
  // A distinct process-only provider keeps env_key mutually exclusive with shared-HOME auth.command.
  const provider = route === 'ocx' ? 'aicc-ocx-compat' : 'openai';
  const routingArgs = route === 'ocx' ? [
    '-c', `model_provider=${tomlString(provider)}`,
    '-c', `model_providers.${provider}.name="AICC OCX compatibility"`,
    '-c', `model_providers.${provider}.base_url=${tomlString(status.endpoint)}`,
    '-c', `model_providers.${provider}.wire_api="responses"`,
    '-c', `model_providers.${provider}.requires_openai_auth=false`,
    '-c', `model_providers.${provider}.env_key="OPENCODEX_API_AUTH_TOKEN"`,
    // G1-05: OCX never replays. A client retry of the same request only meets the
    // conversation fence again (observed: one requestId refused 126 times about 1s apart).
    '-c', `model_providers.${provider}.request_max_retries=0`,
    '-c', `model_providers.${provider}.stream_max_retries=0`
  ] : ['--profile', 'native', '-c', `openai_base_url=${tomlString(status.endpoint)}`, '-c', 'model_provider="openai"'];
  return {
    ...status, provider, reasoningEffort,
    args: [...routingArgs,
      ...(reasoningEffort ? ['-c', 'model_reasoning_effort=' + tomlString(reasoningEffort)] : []),
      ...(status.modelOverride ? ['-m', status.model] : []), ...args]
  };
}
async function readJsonUrl(url, options = {}) {
  const response = await (options.fetch ?? fetch)(url, {
    headers: options.headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function assertOcxReady(invocation, options = {}, admissionToken) {
  let health;
  let ready;
  let models;
  try {
    [health, ready, models] = await Promise.all([
      readJsonUrl(invocation.health, options),
      readJsonUrl(invocation.readyEndpoint, options),
      readJsonUrl(`${invocation.endpoint}/models`, { ...options, timeoutMs: options.modelPrecheckTimeoutMs ?? 12_000,
        ...(admissionToken ? { headers: { Authorization: `Bearer ${admissionToken}` } } : {}) })
    ]);
  } catch (error) {
    throw new Error(`OCX readiness precheck failed before any model request; Native was not used as fallback (${error.message})`);
  }
  const advertised = Array.isArray(models?.data) ? models.data.map(item => item?.id).filter(Boolean) : [];
  const isReady = (ready?.status === 'ready' && ready?.ready !== false)
    || (ready?.status === 'ok' && ready?.ready === true);
  const advertisedModel = (!invocation.modelOverride && advertised.length > 0) || advertised.includes(invocation.model)
    || ((invocation.accountSelector || invocation.preferredAccountSelector) && advertised.includes(invocation.baseModel));
  if (health?.status !== 'ok' || !isReady || !advertisedModel) {
    throw new Error(`OCX readiness precheck did not advertise ${invocation.accountBinding || invocation.preferredAccountBinding ? (invocation.accountBinding ?? invocation.preferredAccountBinding).label + ' ' + invocation.baseModel : invocation.model}; no model request was started and Native was not used as fallback`);
  }
}

function readAdmissionToken(file) {
  if (!file) throw new Error('OCX remote client admission token file is unavailable');
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new Error('OCX remote client admission token file is unavailable');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('OCX remote client admission token file is unsafe');
  }
  const token = fs.readFileSync(file, 'utf8').trim();
  if (token.length < 16 || token.length > 4096 || /[\r\n]/.test(token)) {
    throw new Error('OCX remote client admission token is invalid');
  }
  return token;
}

export async function prepareCodexCliLaunch(route, args = [], options = {}) {
  const invocation = buildCodexCliInvocation(route, args, options);
  const admissionToken = route === 'ocx' && invocation.admissionTokenFile
    ? readAdmissionToken(invocation.admissionTokenFile) : null;
  if (route === 'ocx' && !admissionToken) throw new Error('Registered OCX admission credential is required; no authentication or route fallback');
  if (route === 'ocx') await assertOcxReady(invocation, options, admissionToken);
  const environment = { ...(options.env ?? process.env) };
  if (admissionToken) {
    environment.OPENCODEX_API_AUTH_TOKEN = admissionToken;
  }
  if (invocation.accountSelector || invocation.preferredAccountSelector) {
    const selected = invocation.accountBinding ?? invocation.preferredAccountBinding;
    const current = accountBinding(route, options, invocation.accountChoice ?? invocation.preferredAccountChoice);
    if (current.file !== selected.file || current.target !== selected.target || current.selector !== selected.selector) {
      throw new Error('OCX account binding changed before launch; no request was started');
    }
    const payload = JSON.parse(fs.readFileSync(invocation.catalog, 'utf8'));
    const rows = Array.isArray(payload.models) ? payload.models : payload.data;
    const original = rows?.find(row => (row.slug ?? row.id) === invocation.baseModel);
    if (!original) throw new Error('Native model metadata is missing; no account catalog was invented');
    const scoped = structuredClone(original);
    scoped.slug = invocation.model;
    if (Object.hasOwn(scoped, 'id')) scoped.id = invocation.model;
    scoped.display_name = `${current.label}${invocation.preferredAccountSelector ? ' 새 대화 우선' : ' 엄격 고정'} / ${original.display_name ?? invocation.baseModel}`;
    scoped.opencodex_catalog_kind = invocation.preferredAccountSelector ? 'preferred-account-v1' : 'account-selector-v1';
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ocx-account-'));
    const catalog = path.join(directory, 'models.json');
    try {
      fs.writeFileSync(catalog, JSON.stringify({ models: [scoped] }), { flag: 'wx', mode: 0o600 });
    } catch (error) { fs.rmdirSync(directory); throw error; }
    invocation.args.unshift('-c', 'model_catalog_json=' + tomlString(catalog));
    invocation.catalog = catalog;
    invocation.temporaryCatalogDirectory = directory;
  }
  return { invocation, environment };
}

export async function launchCodexCli(route, args = [], options = {}) {
  const parsed = parseCodexRouteArguments(args);
  const checkpointFile = options.handoffCheckpoint ?? parsed.handoffCheckpoint;
  if (checkpointFile) {
    if (options.handoffCheckpoint && parsed.handoffCheckpoint) throw Error('Duplicate checkpoint');
    if (route !== 'ocx' || parsed.args.length || parsed.model || parsed.reasoningEffort || parsed.accountSelector || parsed.preferredAccount
      || options.model || options.reasoningEffort || options.accountSelector || options.preferredAccount)
      throw Error('Checkpoint handoff owns the OCX launch; extra route/resume/fork/prompt options are refused');
    const prepared = prepareCheckpointHandoff(checkpointFile), checkpoint = prepared.checkpoint;
    const nextOptions = { ...options, handoffCheckpoint: undefined, cwd: checkpoint.cwd, model: checkpoint.model,
      ...(checkpoint.mode === 'preferred' ? { preferredAccount: String(checkpoint.preferredAccount) } : {}) };
    // The ordinary launcher keeps fresh OCX admission, supported models and existing auth.
    // No account is selected here and no encrypted history is copied to the new process.
    const nextArgs = ['-C', checkpoint.cwd, '-a', 'on-request', '-c', 'approvals_reviewer="auto_review"', '--', prepared.prompt];
    const { invocation, environment } = await prepareCodexCliLaunch('ocx', nextArgs, nextOptions);
    try {
      // Readiness is not a model send. Persist the one-shot attempt only after preparation.
      prepareCheckpointHandoff(checkpointFile);
      claimCheckpointHandoff(prepared);
      const result = (options.spawnSync ?? spawnSync)(invocation.executable, invocation.args,
        { cwd: checkpoint.cwd, env: { ...environment, AICC_CODEX_CHECKPOINT_ATTEMPT: prepared.attemptPath }, stdio: 'inherit', windowsHide: false });
      if (result.error || result.signal || result.status === null) throw result.error ?? Error('Handoff process result UNKNOWN; reconcile original attempt');
      finishCheckpointHandoff(prepared, result.status);
      return { route: 'ocx', exitCode: result.status, state: 'CLI_EXITED_NOT_ADOPTED', operationId: checkpoint.operationId, automaticRetry: false };
    } finally {
      if (invocation.temporaryCatalogDirectory) { fs.unlinkSync(invocation.catalog); fs.rmdirSync(invocation.temporaryCatalogDirectory); }
    }
  }
  const checkpointDir = options.checkpointDir ?? parsed.checkpointDir;
  if (checkpointDir && route !== 'ocx') throw Error('Checkpoint production is supported only for the OCX route');
  const { invocation, environment } = await prepareCodexCliLaunch(route, args, options);
  let checkpointResult = null;
  try {
    // G1-06: the launcher that observes the real exit is the only stop-receipt producer.
    const launch = checkpointDir ? claimSourceLaunch(checkpointDir, { cwd: options.cwd ?? process.cwd(),
      resumeThreadId: resumeThreadFromArgs(parsed.args) }) : null;
    const result = (options.spawnSync ?? spawnSync)(invocation.executable, invocation.args, {
      cwd: options.cwd ?? process.cwd(),
      env: launch ? { ...environment, AICC_CODEX_CHECKPOINT_DRAFT: launch.draftPath, AICC_CODEX_CHECKPOINT_OPERATION: launch.operationId } : environment,
      stdio: 'inherit',
      windowsHide: false
    });
    if (launch) {
      try { checkpointResult = { operationId: launch.operationId, ...produceCheckpointAfterExit(launch, result, options) }; }
      catch (error) {
        // Keep the real exit code; preserved launch/stop files are reconciled by the owner.
        checkpointResult = { state: 'CHECKPOINT_PRODUCTION_FAILED', operationId: launch.operationId,
          reason: String(error?.message ?? error).slice(0, 200), automaticRetry: false };
      }
    }
    if (result.error) throw result.error;
    const { accountBinding: binding, preferredAccountBinding, temporaryCatalogDirectory, ...publicInvocation } = invocation;
    if (checkpointResult?.state === 'CHECKPOINT_READY' && checkpointResult.continueAfterExit) {
      // One-shot continuation through the existing consumer. Its own attempt file fences replay.
      const { checkpointDir: _dir, ...nextOptions } = options;
      const handoff = await launchCodexCli('ocx', ['--handoff-checkpoint', checkpointResult.checkpoint.path], nextOptions);
      return { ...publicInvocation, exitCode: result.status ?? 1, checkpoint: checkpointResult, handoff };
    }
    return { ...publicInvocation, exitCode: result.status ?? 1, ...(checkpointResult ? { checkpoint: checkpointResult } : {}) };
  } finally {
    if (invocation.temporaryCatalogDirectory) {
      fs.unlinkSync(invocation.catalog);
      fs.rmdirSync(invocation.temporaryCatalogDirectory);
    }
  }
}

export const CODEX_CLI_ROUTES = ROUTES;
