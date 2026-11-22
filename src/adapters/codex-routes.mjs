import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../lib/command.mjs';
import { sanitize } from '../lib/redact.mjs';
import { webGptCommand } from '../lib/web-gpt-command.mjs';
import { nativeRescueStatus } from '../native-rescue.mjs';

const WEB_GPT_URL = 'http://127.0.0.1:17841/v1';
const OCX_URL = 'http://127.0.0.1:10100/v1';
const NATIVE_URL = 'https://chatgpt.com/backend-api/codex';

function loopbackHttpOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
      || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')
      || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function loopbackV1Route(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
      || url.username || url.password || !['/v1', '/v1/'].includes(url.pathname)
      || url.search || url.hash) return null;
    return `${url.origin}/v1`;
  } catch {
    return null;
  }
}

function resolveOcxDataRoute(config) {
  if (config?.runtimeRole === 'client') {
    const origin = loopbackHttpOrigin(config?.client?.serverUrl);
    if (origin) {
      return {
        mode: 'remote-client',
        endpoint: `${origin}/v1`,
        health: `${origin}/healthz`
      };
    }
  }
  return {
    mode: 'standalone',
    endpoint: OCX_URL,
    health: 'http://127.0.0.1:10100/healthz'
  };
}

function inspectWebGptNativeUpstream(config, ocxRoute) {
  const raw = typeof config?.nativeUpstreamBaseUrl === 'string' ? config.nativeUpstreamBaseUrl : null;
  const normalized = loopbackV1Route(raw);
  const staleStandaloneOcx = ocxRoute.mode === 'remote-client'
    && normalized === OCX_URL;
  const unsupportedRemoteOcx = ocxRoute.mode === 'remote-client'
    && normalized !== null
    && normalized === ocxRoute.endpoint;
  return {
    configured: raw !== null,
    endpoint: raw,
    state: staleStandaloneOcx
      ? 'stale-standalone-ocx'
      : unsupportedRemoteOcx
        ? 'remote-ocx-requires-admission-token'
        : raw === null
          ? 'official-native'
          : 'custom-loopback',
    stale: staleStandaloneOcx || unsupportedRemoteOcx
  };
}

function readText(file, reader = fs.readFileSync) {
  try { return reader(file, 'utf8'); } catch { return '' ; }
}

function readJson(file, reader = fs.readFileSync) {
  try { return JSON.parse(reader(file, 'utf8')); } catch { return null; }
}

function tomlString(source, key) {
  const match = String(source).match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'));
  return match?.[1] ?? null;
}

export function codexRouteKind(url) {
  if (!url || url === NATIVE_URL) return 'native';
  if (url === WEB_GPT_URL) return 'web-gpt';
  if (url === OCX_URL) return 'ocx';
  return 'custom';
}

export function configuredCodexRoute(configFile, reader = fs.readFileSync) {
  return tomlString(readText(configFile, reader), 'openai_base_url');
}

function jsonResult(result) {
  if (!result?.ok) return null;
  try { return sanitize(JSON.parse(result.stdout)); } catch { return null; }
}

async function health(fetcher, url, options = {}) {
  const attempts = Math.max(1, Number(options.attempts ?? 2));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 2_500) });
      if (response.ok) return sanitize(await response.json());
    } catch { /* retry one cold-start timeout before declaring the route offline */ }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 200));
  }
  return null;
}

export async function codexRouteStatus(options = {}) {
  const home = options.home ?? os.homedir();
  const configPath = options.configPath ?? path.join(home, '.codex', 'config.toml');
  const nativeConfigPath = options.nativeConfigPath ?? path.join(home, '.codex', 'codex-native.config.toml');
  const webGptConfigPath = options.webGptConfigPath ?? path.join(home, '.codex-chatgpt-web', 'config.json');
  const ocxConfigPath = options.ocxConfigPath ?? path.join(home, '.opencodex', 'config.json');
  const reader = options.readFile ?? fs.readFileSync;
  const nativeConfig = readText(nativeConfigPath, reader);
  const nativeRescue = options.nativeStatus ?? (options.readFile
    ? null
    : nativeRescueStatus({
        home,
        codexHome: options.codexHome,
        stateRoot: options.stateRoot,
        platform: options.platform
      }));
  const webGptConfig = readJson(webGptConfigPath, reader);
  const ocxConfig = readJson(ocxConfigPath, reader);
  const ocxRoute = resolveOcxDataRoute(ocxConfig);
  const webGptNativeUpstream = inspectWebGptNativeUpstream(webGptConfig, ocxRoute);
  const routeUrl = configuredCodexRoute(configPath, reader);
  const nativeUrl = tomlString(nativeConfig, 'openai_base_url');
  const runner = options.runCommand ?? runCommand;
  const readRoute = async () => {
    const routeCommand = webGptCommand(['route', 'status'], { executable: options.webGptCli, home, configPath: webGptConfigPath, readFile: reader });
    return runner(routeCommand.executable, routeCommand.args, { timeoutMs: 5_000 });
  };
  const fetcher = options.fetch ?? fetch;
  const healthOptions = {
    attempts: options.healthAttempts ?? 2,
    timeoutMs: options.healthTimeoutMs ?? 2_500,
    delayMs: options.healthRetryDelayMs ?? 200
  };
  const [routeResult, webGptHealth, ocxHealth] = await Promise.all([
    readRoute().catch(() => null),
    health(fetcher, 'http://127.0.0.1:17841/healthz', healthOptions),
    health(fetcher, ocxRoute.health, healthOptions)
  ]);
  const route = jsonResult(routeResult);
  const kind = codexRouteKind(routeUrl);
  const webHttpTurns = Number.isInteger(webGptHealth?.active_http_turns) ? webGptHealth.active_http_turns : null;
  const webBrowserHttpTurns = Number.isInteger(webGptHealth?.active_browser_http_turns)
    ? webGptHealth.active_browser_http_turns
    : null;
  const webBrowserTurns = Number.isInteger(webGptHealth?.active_browser_turns) ? webGptHealth.active_browser_turns : null;
  const activeTurns = Number.isInteger(webHttpTurns) && Number.isInteger(webBrowserTurns)
    ? webHttpTurns + webBrowserTurns
    : null;
  const activeWebTurns = Number.isInteger(webBrowserHttpTurns) && Number.isInteger(webBrowserTurns)
    ? Math.max(webBrowserHttpTurns, webBrowserTurns)
    : null;
  const nativeReady = nativeUrl === NATIVE_URL || nativeRescue?.ok === true;
  const routeKnown = ['native', 'web-gpt', 'ocx'].includes(kind);

  return sanitize({
    id: 'codex-routes',
    label: 'Codex 모델 경로',
    state: routeKnown && nativeReady && !webGptNativeUpstream.stale ? 'ready' : 'attention',
    detail: webGptNativeUpstream.stale
      ? 'Web GPT native upstream이 현재 OCX client topology와 맞지 않습니다. 일반 Codex 요청이 실패할 수 있습니다.'
      : kind === 'web-gpt'
        ? '통합 모델 선택기가 Web GPT 브리지를 사용하고 있습니다.'
      : kind === 'ocx'
        ? 'Codex가 OCX에 직접 연결되어 있습니다.'
        : kind === 'native'
          ? 'Codex가 공식 Native endpoint에 직접 연결되어 있습니다.'
          : '알 수 없는 사용자 지정 모델 경로를 확인해야 합니다.',
    activeRoute: kind,
    routeUrl: routeUrl ?? NATIVE_URL,
    routeInstalled: route?.installed === true,
    integrationActive: route?.active === true,
    nativeReady,
    nativeProfile: {
      configured: Boolean(nativeConfig) || nativeRescue?.installed === true,
      officialEndpoint: nativeReady,
      source: nativeUrl === NATIVE_URL ? 'config' : nativeRescue?.ok === true ? 'native-rescue' : 'unavailable',
      model: nativeRescue?.model ?? null,
      modelAvailable: nativeRescue?.modelAvailable === true
    },
    webGpt: {
      healthy: webGptHealth?.status === 'ok',
      acceptingTurns: webGptHealth?.accepting_turns === true,
      acceptingBrowserTurns: webGptHealth?.accepting_browser_turns === true,
      routerOwner: webGptHealth?.runtime_owner ?? webGptConfig?.runtimeOwner ?? null,
      activeHttpTurns: webHttpTurns,
      activeBrowserHttpTurns: webBrowserHttpTurns,
      activeBrowserTurns: webBrowserTurns,
      activeTurns,
      activeWebTurns,
      mode: webGptHealth?.mode ?? null,
      nativeUpstream: webGptNativeUpstream
    },
    ocx: {
      healthy: ocxHealth?.ok === true || ocxHealth?.status === 'ok',
      port: Number(new URL(ocxRoute.endpoint).port || 80),
      endpoint: ocxRoute.endpoint,
      mode: ocxRoute.mode,
      upstreamReportedPort: Number.isInteger(ocxHealth?.port) ? ocxHealth.port : null
    },
    recovery: {
      nativeCommand: 'ocx restore',
      bridgeCommand: 'codex-chatgpt-web route connect',
      requiresDesktopRestart: false,
      reloadBoundary: 'new-task-or-official-backend-reload'
    }
  });
}

export const codexRouteConstants = Object.freeze({ WEB_GPT_URL, OCX_URL, NATIVE_URL });
