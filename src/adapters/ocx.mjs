import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envCommand, runCommand } from '../lib/command.mjs';
import { sanitize } from '../lib/redact.mjs';
import { projectOcxStorageGovernance } from '../ocx-storage-governance.mjs';

function executableCandidates(explicit) {
  if (explicit) return [explicit];
  const pathEntries = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return [...new Set([
    process.env.AICC_OCX_EXECUTABLE?.trim(),
    ...pathEntries.map(entry => path.join(entry, 'ocx')),
    path.join(os.homedir(), '.local', 'bin', 'ocx'),
    '/opt/homebrew/bin/ocx',
    '/usr/local/bin/ocx',
    'ocx'
  ].filter(Boolean))];
}

function firstInstalled(candidates) {
  return candidates.find(candidate => candidate === 'ocx' || (() => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; }
  })()) ?? candidates.at(-1) ?? 'ocx';
}

function commandInvocation(executable, args, environment = process.env, platform = process.platform) {
  if (platform !== 'win32') return { executable, args };
  const extension = path.extname(executable).toLowerCase();
  const absolute = path.win32.isAbsolute(executable) || path.isAbsolute(executable);
  const requiresCmd = !absolute || ['.bat', '.cmd', '.ps1'].includes(extension) || !extension;
  if (!requiresCmd) return { executable, args };
  const shell = environment.ComSpec?.trim() || process.env.ComSpec?.trim() || 'cmd.exe';
  return { executable: shell, args: ['/d', '/s', '/c', executable, ...args] };
}

function platformRunner(runner, platform, environment) {
  if (platform !== 'win32') return runner;
  return (executable, args, options) => {
    const invocation = commandInvocation(executable, args, environment, platform);
    return runner(invocation.executable, invocation.args, options);
  };
}

function parseJson(result) {
  if (!result?.ok) return null;
  try { return sanitize(JSON.parse(result.stdout)); } catch { return null; }
}

function command(executable, args) {
  return { executable, args };
}

async function mapWithConcurrency(items, limit, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = await operation(items[index], index); }
      catch { results[index] = null; }
    }
  }
  const workerCount = Math.max(1, Math.min(items.length, Number(limit) || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function runCoreProbe(runner, spec, options = {}) {
  const attempts = Math.max(1, Number(options.attempts ?? 2));
  let result = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { result = await runner(spec.executable, spec.args, { timeoutMs: options.timeoutMs ?? 5_000 }); }
    catch { result = null; }
    if (result?.ok || (result && !result.timedOut)) return result;
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 200));
  }
  return result;
}

async function probeLoopbackJson(fetchImpl, url, timeoutMs) {
  if (typeof fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    if (!response?.ok) return null;
    return sanitize(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isExactManagedHealth(payload, port) {
  return payload?.status === 'ok'
    && payload?.service === 'opencodex'
    && Number(payload?.port) === port;
}

function isExactManagedReadiness(payload, port) {
  return payload?.status === 'ready'
    && payload?.service === 'opencodex'
    && Number(payload?.port) === port;
}

function moduleState(payload, result) {
  if (payload) return 'ready';
  if (result?.timedOut) return 'timeout';
  return 'unavailable';
}

function groupedModels(models) {
  const counts = new Map();
  for (const model of models) counts.set(model.provider ?? 'unknown', (counts.get(model.provider ?? 'unknown') ?? 0) + 1);
  return [...counts].map(([provider, count]) => ({ provider, count }));
}

function quotaRoutingPolicy(options = {}) {
  let threshold = options.autoSwitchThreshold;
  if (!Number.isInteger(threshold)) {
    const home = options.opencodexHome ?? process.env.OPENCODEX_HOME?.trim() ?? path.join(os.homedir(), '.opencodex');
    try {
      const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
      threshold = config?.autoSwitchThreshold;
    } catch { threshold = null; }
  }
  const validThreshold = Number.isInteger(threshold) && threshold >= 0 && threshold <= 100 ? threshold : null;
  return {
    owner: 'ocx',
    enabled: validThreshold === null ? null : validThreshold > 0,
    thresholdPercent: validThreshold,
    source: validThreshold === null ? 'unavailable' : 'opencodex-config'
  };
}

export async function ocxStatus(options = {}) {
  const executable = firstInstalled(executableCandidates(options.executable));
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const rawRunner = options.runCommand ?? runCommand;
  const runner = options.runCommand ? rawRunner : platformRunner(rawRunner, platform, environment);
  const versionSpec = options.versionCommand ?? envCommand('AICC_OCX_VERSION', {
    executable,
    args: ['--version']
  });
  const healthSpec = options.healthCommand ?? envCommand('AICC_OCX_HEALTH', {
    executable,
    args: ['health', '--json']
  });
  const readinessSpec = options.readinessCommand ?? envCommand('AICC_OCX_READINESS', {
    executable,
    args: ['ready', '--json']
  });
  const managedPort = Number(options.managedPort ?? 10100);
  const managedBaseUrl = String(options.managedBaseUrl ?? `http://127.0.0.1:${managedPort}`).replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const probeManagedRuntime = options.probeManagedRuntime
    ?? (options.runCommand === undefined || options.fetch !== undefined);
  // collectStatus includes a few synchronous platform probes. Keep this above
  // their bounded window so an already-returned loopback response is not
  // discarded only because the event loop was temporarily occupied.
  const managedProbeTimeoutMs = options.managedProbeTimeoutMs ?? 8_000;
  const readOnlySpecs = options.readOnlyCommands ?? {
    providers: command(executable, ['provider', 'list', '--json']),
    models: command(executable, ['models', 'list', '--json']),
    agents: command(executable, ['agent', 'status', '--json']),
    system: command(executable, ['system', 'status', '--json']),
    usage: command(executable, ['observe', 'usage', '--json']),
    combos: command(executable, ['combo', 'list', '--json']),
    storage: command(executable, ['observe', 'storage', '--json']),
    diagnostics: command(executable, ['system', 'diagnostics', '--json']),
    endpoints: command(executable, ['access', 'endpoints', '--json'])
  };
  const coreOptions = {
    attempts: options.coreAttempts ?? 1,
    timeoutMs: options.timeoutMs ?? 3_000,
    delayMs: options.coreRetryDelayMs ?? 200
  };
  const [version, health, readiness, managedHealthPayload, managedReadinessPayload] = await Promise.all([
    runCoreProbe(runner, versionSpec, coreOptions),
    runCoreProbe(runner, healthSpec, coreOptions),
    runCoreProbe(runner, readinessSpec, coreOptions),
    probeManagedRuntime
      ? probeLoopbackJson(fetchImpl, `${managedBaseUrl}/healthz`, managedProbeTimeoutMs)
      : null,
    probeManagedRuntime
      ? probeLoopbackJson(fetchImpl, `${managedBaseUrl}/readyz`, managedProbeTimeoutMs)
      : null
  ]);
  const coreObservable = [version, health, readiness].some(result => result?.ok || (result && !result.timedOut));
  const readOnlyResults = coreObservable
    ? await mapWithConcurrency(
        Object.values(readOnlySpecs),
        options.readOnlyConcurrency ?? 5,
        spec => Promise.resolve(runner(spec.executable, spec.args, {
          timeoutMs: options.readOnlyTimeoutMs ?? 8_000
        }))
      )
    : Object.values(readOnlySpecs).map(() => ({ ok: false, timedOut: true, error: 'core probe timed out' }));

  let cliHealthPayload = null;
  if (health?.ok) {
    try { cliHealthPayload = sanitize(JSON.parse(health.stdout)); } catch { cliHealthPayload = null; }
  }
  let cliReadinessPayload = null;
  try { cliReadinessPayload = sanitize(JSON.parse(readiness?.stdout ?? '')); } catch { cliReadinessPayload = null; }
  const managedHealthVerified = managedHealthPayload !== null
    ? isExactManagedHealth(managedHealthPayload, managedPort)
    : null;
  const managedReadinessVerified = managedReadinessPayload !== null
    ? isExactManagedReadiness(managedReadinessPayload, managedPort)
    : null;
  const healthPayload = managedHealthPayload ?? cliHealthPayload;
  const readinessPayload = managedReadinessPayload ?? cliReadinessPayload;
  const installed = version?.ok === true;
  const cliVersion = installed ? version.stdout.trim().replace(/^opencodex\s+/i, '') : null;
  const healthy = managedHealthVerified ?? Boolean(cliHealthPayload?.ok);
  const ready = managedReadinessVerified
    ?? (readiness?.ok === true && cliReadinessPayload?.ready === true && cliReadinessPayload?.status === 'ready');
  const runtimeVersion = managedHealthVerified && managedHealthPayload?.version
    ? managedHealthPayload.version
    : cliHealthPayload?.version ?? cliVersion;
  const versionSource = managedHealthVerified && managedHealthPayload?.version
    ? 'managed-runtime-health'
    : cliHealthPayload?.version
      ? 'cli-health'
      : installed
        ? 'standalone-cli'
        : null;
  const readOnly = Object.fromEntries(Object.keys(readOnlySpecs).map((key, index) => [key, parseJson(readOnlyResults[index])]));
  const providers = readOnly.providers?.configured ?? [];
  const models = readOnly.models?.models ?? [];
  const startup = readOnly.system?.startup ?? readOnly.system?.settings?.startupHealth ?? null;
  const memory = readOnly.system?.memory ?? null;
  const usage = readOnly.usage?.summary ?? null;
  const agent = readOnly.agents ?? null;
  const storage = readOnly.storage ?? null;
  const diagnostics = readOnly.diagnostics ?? null;
  const endpoints = readOnly.endpoints ?? null;
  const sectionState = key => moduleState(readOnly[key], readOnlyResults[Object.keys(readOnlySpecs).indexOf(key)]);
  const providerSummaries = providers.map(provider => ({
    name: provider.name ?? null,
    adapter: provider.adapter ?? null,
    authMode: provider.authMode ?? null,
    isDefault: provider.isDefault === true,
    modelCount: Array.isArray(provider.models) ? provider.models.length : 0
  }));
  const chosenSubagents = agent?.subagents?.chosen ?? [];
  const fallbackModels = agent?.fallback?.models ?? [];
  const storageBuckets = (storage?.buckets ?? []).map(bucket => ({
    key: bucket.key ?? null,
    label: bucket.label ?? null,
    bytes: Number.isFinite(bucket.bytes) ? bucket.bytes : null,
    fileCount: Number.isFinite(bucket.fileCount) ? bucket.fileCount : null,
    rows: Number.isFinite(bucket.rows) ? bucket.rows : null
  }));
  const endpointCount = endpoints ? ['responsesEndpoint', 'chatCompletionsEndpoint', 'messagesEndpoint', 'modelsEndpoint'].filter(key => endpoints[key]).length : null;
  const routingInjected = startup?.routingInjected;
  const directBaseUrl = endpoints?.baseUrl ?? null;
  const directRescueReady = healthy && ready && directBaseUrl === 'http://127.0.0.1:10100/v1';
  const topology = routingInjected === false && directRescueReady
    ? { mode: 'upstream-only', state: 'ready', routeOwner: 'external', reason: 'service-ready-without-codex-route-injection' }
    : routingInjected === true
      ? { mode: 'direct-owner', state: 'attention', routeOwner: 'ocx', reason: 'ocx-routing-is-injected' }
      : { mode: 'unknown', state: 'attention', routeOwner: null, reason: directRescueReady ? 'routing-ownership-unknown' : 'direct-endpoint-not-ready' };
  const storageGovernance = projectOcxStorageGovernance(storage);
  const quotaRouting = quotaRoutingPolicy(options);

  return {
    id: 'ocx',
    label: 'OCX 모델 연결',
    state: !installed ? 'unavailable' : !healthy ? 'offline' : ready ? 'ready' : 'attention',
    detail: !installed
      ? 'OCX를 찾지 못했습니다.'
      : !healthy
        ? 'OCX는 설치됐지만 실행 중이 아닙니다.'
        : !ready
          ? `OCX 프로세스는 살아 있지만 readiness가 ${readinessPayload?.status ?? 'unknown'}입니다.`
        : topology.mode === 'upstream-only'
          ? 'OCX가 Codex 경로를 소유하지 않는 upstream-only로 실행 중입니다.'
          : topology.mode === 'direct-owner'
            ? 'OCX가 실행 중이지만 Codex 직접 경로를 소유하고 있어 확인이 필요합니다.'
            : 'OCX는 실행 중이지만 route ownership을 확인할 수 없습니다.',
    installed,
    healthy,
    ready,
    version: runtimeVersion,
    cliVersion,
    versionSource,
    versionMismatch: Boolean(runtimeVersion && cliVersion && runtimeVersion !== cliVersion),
    runtime: healthPayload,
    readiness: readinessPayload,
    cliRuntime: managedHealthPayload !== null ? cliHealthPayload : null,
    cliReadiness: managedReadinessPayload !== null ? cliReadinessPayload : null,
    managedRuntimeProbe: {
      baseUrl: managedBaseUrl,
      healthObserved: managedHealthPayload !== null,
      healthVerified: managedHealthVerified,
      readinessObserved: managedReadinessPayload !== null,
      readinessVerified: managedReadinessVerified
    },
    topology,
    directRescue: {
      profileId: 'ocx-direct',
      protocol: 'openai-responses',
      baseUrl: directBaseUrl,
      ready: directRescueReady,
      identityBinding: 'explicit-alias-required',
      independentOf: ['router-17841', 'web-gpt-session-service']
    },
    failurePolicy: {
      accountAutoSwitch: false,
      accountAutoSwitchOwner: 'ocx',
      ocxAccountAutoSwitch: quotaRouting.enabled,
      ocxAccountAutoSwitchThresholdPercent: quotaRouting.thresholdPercent,
      providerAutoSwitch: false,
      timeoutDomain: 'ocx-upstream-only',
      circuitDomain: 'ocx-upstream-only',
      mayRestartWebGpt: false,
      mayRestartNativeCodex: false
    },
    quotaRouting,
    dashboardUrl: 'http://127.0.0.1:10100/#dashboard',
    overview: {
      providerCount: providers.length,
      providerNames: providers.map(provider => provider.name).filter(Boolean),
      defaultProvider: providers.find(provider => provider.isDefault)?.name ?? null,
      modelCount: models.length,
      comboCount: readOnly.combos?.combos?.length ?? null,
      multiAgentMode: agent?.v2?.multiAgentMode ?? null,
      subagentCount: agent?.subagents?.chosen?.length ?? null,
      startupStatus: startup?.status ?? null,
      normalizedStartupStatus: topology.state,
      topology: topology.mode,
      rebootSafe: startup?.rebootSafe ?? null,
      serviceRunning: startup?.serviceRunning ?? null,
      uptimeSeconds: memory?.uptimeSeconds ?? null,
      rssBytes: memory?.rss ?? null,
      memoryBudgetBytes: memory?.appOwnedBytes?.budgetBytes ?? null,
      memoryRetainedBytes: memory?.appOwnedBytes?.retainedBytes ?? null,
      activeTranslatorBuffers: memory?.appOwnedBytes?.observedInFlight?.translator_buffers?.active ?? null,
      requests30d: usage?.requests ?? null,
      totalTokens30d: usage?.totalTokens ?? null,
      usageCoverageRatio: usage?.coverageRatio ?? null
    },
    sections: {
      providers: {
        state: sectionState('providers'),
        count: providers.length,
        registryCount: readOnly.providers?.registryCount ?? null,
        defaultProvider: providers.find(provider => provider.isDefault)?.name ?? null,
        items: providerSummaries
      },
      models: {
        state: sectionState('models'),
        count: models.length,
        byProvider: groupedModels(models),
        defaultModels: models.filter(model => model.isDefault).map(model => ({ provider: model.provider, model: model.model }))
      },
      agents: {
        state: sectionState('agents'),
        v2Enabled: agent?.v2?.enabled === true,
        multiAgentMode: agent?.v2?.multiAgentMode ?? null,
        chosenCount: chosenSubagents.length,
        chosen: chosenSubagents,
        fallbackCount: fallbackModels.length,
        sidecars: agent?.sidecars ?? null
      },
      usage: {
        state: sectionState('usage'),
        range: readOnly.usage?.range ?? '30d',
        requests: usage?.requests ?? null,
        totalTokens: usage?.totalTokens ?? null,
        coverageRatio: usage?.coverageRatio ?? null,
        estimatedCostUsd: usage?.estimatedCostUsd ?? null,
        measuredRequests: usage?.measuredRequests ?? null,
        unmeteredRequests: usage?.unmeteredRequests ?? null
      },
      runtime: {
        state: sectionState('system'),
        startupStatus: startup?.status ?? null,
        rebootSafe: startup?.rebootSafe ?? null,
        serviceRunning: startup?.serviceRunning ?? null,
        routingInjected: startup?.routingInjected ?? null,
        topology: topology.mode,
        topologyState: topology.state,
        routeOwner: topology.routeOwner,
        diagnosticStale: startup?.diagnosticStale ?? null,
        uptimeSeconds: memory?.uptimeSeconds ?? null,
        rssBytes: memory?.rss ?? null,
        memoryBudgetBytes: memory?.appOwnedBytes?.budgetBytes ?? null,
        retainedBytes: memory?.appOwnedBytes?.retainedBytes ?? null,
        overBudgetBytes: memory?.appOwnedBytes?.overBudgetBytes ?? null,
        activeTurns: memory?.activeTurnCount ?? null,
        draining: memory?.isDraining ?? null
      },
      storage: {
        state: sectionState('storage'),
        totalBytes: storage?.total?.bytes ?? null,
        fileCount: storage?.total?.fileCount ?? null,
        buckets: storageBuckets,
        governance: storageGovernance
      },
      diagnostics: {
        state: sectionState('diagnostics'),
        warningCount: Array.isArray(diagnostics?.warnings) ? diagnostics.warnings.length : null,
        groupCount: Array.isArray(diagnostics?.grouped) ? diagnostics.grouped.length : null
      },
      endpoints: {
        state: sectionState('endpoints'),
        baseUrl: endpoints?.baseUrl ?? null,
        endpointCount
      },
      combos: {
        state: sectionState('combos'),
        count: readOnly.combos?.combos?.length ?? null
      }
    },
    source: versionSpec.executable
  };
}
