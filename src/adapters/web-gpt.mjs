import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitize } from '../lib/redact.mjs';
import { configuredCodexRoute } from './codex-routes.mjs';

const WEB_MODELS = Object.freeze([
  'Web / 임시 / 낮음', 'Web / 임시 / 중간', 'Web / 임시 / 높음', 'Web / 임시 / 매우 높음',
  'Web / 저장 / 낮음', 'Web / 저장 / 중간', 'Web / 저장 / 높음', 'Web / 저장 / 매우 높음'
]);
const WEB_PRO_MODELS = Object.freeze(['Web / 임시 / Pro', 'Web / 저장 / Pro']);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function configuredRuntimeManifestPath(config, stateRoot, releaseVersion) {
  const executable = Array.isArray(config?.runtimeCommand) ? config.runtimeCommand[0] : null;
  if (typeof executable === 'string' && path.isAbsolute(executable)) {
    const manifest = path.resolve(path.dirname(executable), '..', 'manifest.json');
    if (fs.existsSync(manifest)) return manifest;
  }
  return releaseVersion
    ? path.join(stateRoot, 'versions', `${releaseVersion}-${os.platform()}-${os.arch()}`, 'manifest.json')
    : null;
}

function latestVerification(file) {
  const value = readJson(file);
  if (![1, 2].includes(value?.schemaVersion) || value?.kind !== 'web-gpt-six-mode-smoke') return null;
  const counts = ['total', 'completed', 'overallPass', 'filePass', 'browserPass', 'failed', 'stalled'];
  if (!counts.every(key => Number.isInteger(value[key]) && value[key] >= 0)) return null;
  if (!['pass', 'attention'].includes(value.status)) return null;
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    observedAt: typeof value.observedAt === 'string' ? value.observedAt : null,
    releaseVersion: typeof value.releaseVersion === 'string' ? value.releaseVersion : null,
    runtimeBundleId: typeof value.runtimeBundleId === 'string' && /^[a-f0-9]{64}$/.test(value.runtimeBundleId)
      ? value.runtimeBundleId
      : null,
    strategyVersion: Number.isInteger(value.strategyVersion) ? value.strategyVersion : null,
    status: value.status,
    total: value.total,
    completed: value.completed,
    overallPass: value.overallPass,
    filePass: value.filePass,
    browserPass: value.browserPass,
    failed: value.failed,
    stalled: value.stalled
  };
}

function latestHarnessVerification(file) {
  const value = readJson(file);
  if (value?.schemaVersion !== 1 || value?.kind !== 'web-gpt-harness-canary') return null;
  if (!['pass', 'attention'].includes(value.status)) return null;
  if (typeof value.appName !== 'string' || value.appName.length === 0) return null;
  if (!Number.isInteger(value.toolCount) || value.toolCount < 0) return null;
  if (!Array.isArray(value.toolNames) || !value.toolNames.every(name => typeof name === 'string')) return null;
  return {
    schemaVersion: 1,
    kind: value.kind,
    observedAt: typeof value.observedAt === 'string' ? value.observedAt : null,
    status: value.status,
    appName: value.appName,
    appVersionId: typeof value.appVersionId === 'string' ? value.appVersionId : null,
    releaseVersion: typeof value.releaseVersion === 'string' ? value.releaseVersion : null,
    runtimeBundleId: typeof value.runtimeBundleId === 'string' && /^[a-f0-9]{64}$/.test(value.runtimeBundleId)
      ? value.runtimeBundleId
      : null,
    toolCount: value.toolCount,
    toolNames: value.toolNames,
    wrapperStatus: value.wrapperStatus === 'pass' ? 'pass' : 'attention',
    detail: typeof value.detail === 'string' ? value.detail : null,
  };
}

async function defaultTunnelStatus(healthUrlFile, fetcher, timeoutMs) {
  try {
    const endpoint = new URL(fs.readFileSync(healthUrlFile, 'utf8').trim());
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(new URL('/healthz', endpoint), {
        headers: { accept: 'text/plain' }, signal: controller.signal
      });
      if (!response.ok || (await response.text()).trim() !== 'live') return null;
      return { running: true, healthy: true, ready: true, state: 'ready' };
    } finally { clearTimeout(timer); }
  } catch { return null; }
}

async function health(url, fetcher, timeoutMs, attempts = 2, delayMs = 200) {
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, { headers: { accept: 'application/json' }, signal: controller.signal });
      if (response.ok) return sanitize(await response.json());
    } catch { /* retry one cold-start timeout before declaring the bridge offline */ }
    finally { clearTimeout(timer); }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return null;
}

async function readiness(url, fetcher, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    const payload = sanitize(await response.json());
    if (!payload || typeof payload !== 'object' || typeof payload.ready !== 'boolean'
      || !payload.dependencies || typeof payload.dependencies !== 'object') return null;
    return { httpStatus: Number.isInteger(response.status) ? response.status : response.ok ? 200 : 503, ...payload };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export async function webGptStatus(options = {}) {
  const home = options.home ?? os.homedir();
  const stateRoot = options.stateRoot ?? path.join(home, '.codex-chatgpt-web');
  const configPath = options.configPath ?? path.join(stateRoot, 'config.json');
  const codexConfigPath = options.codexConfigPath ?? path.join(home, '.codex', 'config.toml');
  const appPath = options.appPath ?? (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Codex Web GPT', 'Codex Web GPT.exe')
    : '/Applications/Codex Web GPT.app');
  const launcherStatePath = options.launcherStatePath
    ?? (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Codex Web GPT', 'launcher-state.json')
      : path.join(home, 'Library', 'Application Support', 'Codex Web GPT', 'launcher-state.json'));
  const verificationPath = options.verificationPath
    ?? path.join(home, '.ai-control-center', 'evidence', 'web-gpt-latest.json');
  const harnessVerificationPath = options.harnessVerificationPath
    ?? path.join(home, '.ai-control-center', 'evidence', 'web-gpt-harness-latest.json');
  const config = readJson(configPath);
  const launcherState = readJson(launcherStatePath);
  const port = Number(config?.port || 17841);
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const runtime = await health(
    `http://127.0.0.1:${port}/healthz`,
    options.fetch ?? fetch,
    options.timeoutMs ?? 2_500,
    options.healthAttempts ?? 2,
    options.healthRetryDelayMs ?? 200
  );
  const runtimeReadiness = await (options.readinessProbe ?? readiness)(
    `http://127.0.0.1:${port}/readyz`,
    options.fetch ?? fetch,
    options.timeoutMs ?? 2_500
  );
  const installed = Boolean(config || fs.existsSync(appPath));
  const healthy = runtime?.status === 'ok' || runtime?.ok === true;
  const route = configuredCodexRoute(codexConfigPath);
  const routeConfigured = route === baseUrl;
  const mode = config?.mode ?? null;
  const proAvailable = config?.proAvailable === true;
  const modelLabels = proAvailable ? [...WEB_MODELS, ...WEB_PRO_MODELS] : [...WEB_MODELS];
  const tunnelConfigured = Boolean(config?.tunnel);
  const harnessConfigured = mode === 'full' && tunnelConfigured;
  const tunnelHealthUrlFile = options.tunnelHealthUrlFile ?? (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'tunnel-client', 'health', `${config?.tunnel?.alias ?? 'codex-chatgpt-web'}.url`)
    : path.join(home, 'Library', 'Application Support', 'tunnel-client', 'health', `${config?.tunnel?.alias ?? 'codex-chatgpt-web'}.url`));
  const tunnelRuntime = harnessConfigured
    ? sanitize(await (options.tunnelStatus ?? defaultTunnelStatus)(
      tunnelHealthUrlFile,
      options.fetch ?? fetch,
      options.timeoutMs ?? 2_500,
    ))
    : null;
  const harnessReady = harnessConfigured && tunnelRuntime?.ready === true && runtime?.mode === 'full';
  const connectorSelectable = harnessReady && launcherState?.mcpSetupComplete === true;
  const verification = latestVerification(verificationPath);
  const harnessVerification = latestHarnessVerification(harnessVerificationPath);
  const currentReleaseVersion = runtime?.version ?? config?.releaseVersion ?? null;
  const runtimeManifestPath = options.runtimeManifestPath
    ?? configuredRuntimeManifestPath(config, stateRoot, currentReleaseVersion);
  const runtimeManifest = runtimeManifestPath ? readJson(runtimeManifestPath) : null;
  const currentRuntimeBundleId = typeof runtimeManifest?.bundleId === 'string' && /^[a-f0-9]{64}$/.test(runtimeManifest.bundleId)
    ? runtimeManifest.bundleId
    : null;
  const harnessVerificationVersionMatches = harnessVerification?.releaseVersion === currentReleaseVersion;
  const harnessVerificationBundleMatches = harnessVerification?.runtimeBundleId
    ? harnessVerification.runtimeBundleId === currentRuntimeBundleId
    : true;
  const harnessVerificationAppMatches = harnessVerification?.appName === (config?.appName ?? 'Web GPT 작업 하네스');
  const currentHarnessVerification = harnessVerificationVersionMatches
    && harnessVerificationBundleMatches
    && harnessVerificationAppMatches
    ? harnessVerification
    : null;
  const connectorVerified = connectorSelectable
    && currentHarnessVerification?.status === 'pass'
    && currentHarnessVerification.wrapperStatus === 'pass';
  const verificationVersionMatches = verification?.releaseVersion === currentReleaseVersion;
  const verificationBundleMatches = verification?.runtimeBundleId
    ? verification.runtimeBundleId === currentRuntimeBundleId
    : true;
  const currentVerification = verificationVersionMatches && verificationBundleMatches ? verification : null;
  const verificationBundleMismatch = Boolean(verificationVersionMatches && verification?.runtimeBundleId && !verificationBundleMatches);
  const verificationNeedsAttention = currentVerification?.status === 'attention' || verificationBundleMismatch;
  const connectorNeedsAttention = mode === 'full' && harnessReady && !connectorVerified;
  const state = healthy && routeConfigured && (mode !== 'full' || harnessReady) && !verificationNeedsAttention && !connectorNeedsAttention
    ? 'ready'
    : installed ? 'attention' : 'unavailable';
  return sanitize({
    id: 'web-gpt',
    label: 'Web GPT 모델 브리지',
    optional: !installed,
    state,
    detail: !installed
      ? 'Web GPT v2 브리지가 설치되어 있지 않습니다.'
      : !healthy
        ? '브리지가 설치됐지만 현재 응답하지 않습니다.'
        : !routeConfigured
          ? '브리지는 실행 중이지만 Codex 모델 경로가 아직 연결되지 않았습니다.'
          : verificationNeedsAttention
            ? verificationBundleMismatch
              ? '브리지와 하네스는 준비됐지만 현재 설치 bundle은 최근 6모드 실측 bundle과 달라 재검증이 필요합니다.'
              : `브리지와 하네스는 준비됐지만 최근 6모드 실측은 ${verification.overallPass}/${verification.total}개만 완전 성공했습니다.`
          : connectorNeedsAttention
            ? currentHarnessVerification?.status === 'attention'
              ? `전용 Tunnel과 앱 선택은 준비됐지만 실제 하네스 도구 canary가 실패했습니다${currentHarnessVerification.detail ? `: ${currentHarnessVerification.detail}` : '.'}`
              : '전용 Tunnel은 준비됐지만 현재 설치 release와 ChatGPT 앱의 실제 하네스 도구 canary가 필요합니다.'
          : mode === 'full' && harnessReady
            ? 'Web GPT 모델과 현재 Codex 도구 하네스용 전용 Tunnel이 준비되어 있습니다.'
            : mode === 'full'
              ? '전체 하네스 설정은 있지만 전용 Tunnel 런타임이 아직 준비되지 않았습니다.'
            : 'Web GPT 모델이 연결되어 있습니다. 로컬 도구는 전체 하네스 MCP를 구성한 뒤 사용할 수 있습니다.',
    installed,
    healthy,
    routeConfigured,
    route: routeConfigured ? baseUrl : null,
    version: runtime?.version ?? config?.releaseVersion ?? null,
    runtimeBundleId: currentRuntimeBundleId,
    mode,
    browserHost: config?.browserHost ?? null,
    runtimeOwner: runtime?.runtime_owner ?? config?.runtimeOwner ?? null,
    acceptingTurns: runtime?.accepting_turns === true,
    acceptingBrowserTurns: runtime?.accepting_browser_turns === true,
    dependencyReady: runtimeReadiness?.ready === true,
    readinessSupported: runtimeReadiness !== null,
    readiness: runtimeReadiness,
    tunnelConfigured,
    harnessConfigured,
    harnessReady,
    tunnelRuntime,
    connectorSelectable,
    connectorVerified,
    connectorVerification: connectorVerified
      ? 'verified'
      : currentHarnessVerification?.status === 'attention'
        ? 'tool-canary-failed'
        : connectorSelectable
          ? 'tool-canary-required'
          : harnessReady ? 'chatgpt-required' : 'not-ready',
    connectorName: harnessConfigured ? config?.appName ?? 'Web GPT 작업 하네스' : null,
    harnessScope: 'current-codex-project',
    proAvailable,
    autoApproveToolCalls: config?.autoApproveToolCalls === true,
    activeHttpTurns: runtime?.active_http_turns ?? null,
    activeBrowserHttpTurns: runtime?.active_browser_http_turns ?? null,
    activeBrowserTurns: runtime?.active_browser_turns ?? null,
    maxConcurrentTurns: 64,
    modelLabels,
    modelCount: modelLabels.length,
    inferenceOwner: 'chatgpt-web',
    localHarnessConsumesModelTokens: false,
    latestVerification: currentVerification,
    historicalVerification: verification,
    latestHarnessVerification: currentHarnessVerification,
    historicalHarnessVerification: harnessVerification,
    verificationBundleMismatch,
    stateRoot
  });
}

export { WEB_MODELS, WEB_PRO_MODELS };
