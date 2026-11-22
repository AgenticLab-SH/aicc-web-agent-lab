import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliToolStatus } from './cli-tools.mjs';
import { runCommand } from './lib/command.mjs';
import { redactText, sanitize } from './lib/redact.mjs';
import { setupEnvironment } from './setup.mjs';
import { collectStatus } from './status.mjs';
import { agentsStatus } from './agents.mjs';
import { workspaceMcpStatus } from './workspace-mcp.mjs';
import { workspacePublicationStatus } from './workspace-publish.mjs';
import { WORKSPACE_SURFACE_PROFILES } from '../components/workspace-mcp/tool-manifest.mjs';
import { codexRouteStatus } from './adapters/codex-routes.mjs';
import { ocxStatus } from './adapters/ocx.mjs';
import { webGptStatus } from './adapters/web-gpt.mjs';
import { webGptRescueStatus } from './web-gpt-rescue.mjs';
import { guidanceStatusQuick } from './adapters/guidance-status.mjs';
import { jobManagerStatus } from './jobs/status.mjs';
import { browserBrokerStatus } from './browser/status.mjs';
import { extensionRegistryStatus } from './extensions/status.mjs';
import { compatibilityStatus } from './compatibility/status.mjs';
import { codexPluginStatus } from './adapters/codex-plugins.mjs';
import { webGptCommand } from './lib/web-gpt-command.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function supportComponent(component) {
  if (!component) return null;
  const base = { id: component.id, state: component.state, detail: component.detail };
  if (component.id === 'codex-routes') return { ...base, activeRoute: component.activeRoute, nativeReady: component.nativeReady, webGpt: component.webGpt, ocx: component.ocx };
  if (component.id === 'ocx') return { ...base, version: component.version, cliVersion: component.cliVersion, versionSource: component.versionSource, healthy: component.healthy, ready: component.ready, overview: component.overview, sections: component.sections };
  if (component.id === 'web-gpt') return { ...base, version: component.version, mode: component.mode, healthy: component.healthy, acceptingTurns: component.acceptingTurns, acceptingBrowserTurns: component.acceptingBrowserTurns, routeConfigured: component.routeConfigured, harnessReady: component.harnessReady, activeHttpTurns: component.activeHttpTurns, activeBrowserHttpTurns: component.activeBrowserHttpTurns, activeBrowserTurns: component.activeBrowserTurns };
  if (component.id === 'web-gpt-rescue') return { ...base, operationalState: component.operationalState, version: component.version, configured: component.configured, authenticated: component.authenticated, loaded: component.loaded, port: component.port, active: component.active, acceptingBrowserTurns: component.health?.accepting_browser_turns ?? null };
  if (component.id === 'workspace-mcp-business' || component.id === 'workspace-mcp-personal') return { ...base, surfaceProfile: component.surfaceProfile, serverReady: component.serverReady, workspaceCount: component.workspaceCount, remoteAuthority: { runtimeReady: component.remoteAuthority?.runtimeReady, runtimeReasons: component.remoteAuthority?.runtimeReasons, activeLeases: component.remoteAuthority?.activeLeases }, tunnel: component.tunnel, publication: { needsPublish: component.publication?.needsPublish, toolCount: component.publication?.toolCount, readToolCount: component.publication?.readToolCount, writeToolCount: component.publication?.writeToolCount } };
  if (component.id === 'browser-broker') return { ...base, activeTaskTargets: component.activeTaskTargets, authority: component.authority };
  if (component.id === 'guidance') return { ...base, failed: component.failed, deploymentIssues: component.deploymentIssues };
  return base;
}

async function isolatedSupport(id, label, operation) {
  try { return await operation(); }
  catch (error) {
    return {
      id,
      label,
      state: 'attention',
      detail: '이 구성요소의 읽기 전용 상태 수집에 실패했습니다.',
      isolatedFailure: true,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function recoveryBundle(options = {}) {
  const [routeStatus, ocx, webGpt, webGptRescue, workspaceBusiness, workspacePersonal, browser, guidance] = await Promise.all([
    isolatedSupport('codex-routes', 'Codex 모델 경로', () => (options.codexRouteStatus ?? codexRouteStatus)(options.codexRoutes)),
    isolatedSupport('ocx', 'OCX 모델 연결', () => (options.ocxStatus ?? ocxStatus)(options.ocx)),
    isolatedSupport('web-gpt', 'Web GPT 모델 브리지', () => (options.webGptStatus ?? webGptStatus)(options.webGpt)),
    isolatedSupport('web-gpt-rescue', 'Web GPT 독립 rescue', async () => {
      const result = await (options.webGptRescueStatus ?? webGptRescueStatus)(options.webGptRescue);
      return { ...result, id: 'web-gpt-rescue', label: 'Web GPT 독립 rescue', operationalState: result.state, state: result.state === 'ready' ? 'ready' : 'attention' };
    }),
    isolatedSupport('workspace-mcp-business', 'Business Workspace MCP', async () => ({
      ...await (options.workspaceMcpStatus ?? workspaceMcpStatus)({ ...options.workspaceBusiness, surfaceProfile: 'business-full' }),
      id: 'workspace-mcp-business',
      label: 'Business Workspace MCP'
    })),
    isolatedSupport('workspace-mcp-personal', 'Personal Workspace MCP', async () => ({
      ...await (options.workspaceMcpStatus ?? workspaceMcpStatus)({ ...options.workspacePersonal, surfaceProfile: 'personal-read-fetch' }),
      id: 'workspace-mcp-personal',
      label: 'Personal Workspace MCP'
    })),
    isolatedSupport('browser-broker', '브라우저 세션 Broker', () => Promise.resolve((options.browserBrokerStatus ?? browserBrokerStatus)(options.browser))),
    isolatedSupport('guidance', '지침·스킬·Codex 에이전트', () => Promise.resolve((options.guidanceStatus ?? guidanceStatusQuick)(options.guidance)))
  ]);
  const components = [routeStatus, ocx, webGpt, webGptRescue, workspaceBusiness, workspacePersonal, browser, guidance].map(supportComponent);
  const routes = components.find(component => component.id === 'codex-routes');
  const attention = components.filter(component => component.state !== 'ready').map(component => component.id);
  return sanitize({
    ok: attention.length === 0,
    generatedAt: new Date().toISOString(),
    purpose: 'Web GPT 또는 Codex에 붙여 넣을 수 있는 비밀 제외 AICC 진단 묶음',
    summary: { ready: components.length - attention.length, total: components.length, attention },
    components,
    recommendedNextStep: routes?.activeRoute === 'native'
      ? '17841이 정상일 때 통합 모델 경로 다시 연결을 미리보기로 실행하세요.'
      : routes?.webGpt?.healthy === false
        ? 'Native Codex 긴급 복구를 검토하고 17841 브리지를 별도로 진단하세요.'
        : '현재 경로를 유지하고 확인 필요 구역만 개별 진단하세요.',
    commands: [
      'aicc status --json',
      'codex-chatgpt-web doctor --json',
      'codex-chatgpt-web route status',
      'ocx health --json',
      'ocx status --json',
      'ocx system diagnostics --json'
    ],
    consultationPrompt: '아래 AICC 진단 묶음을 분석해 주세요. 정상 구역은 건드리지 말고, 원인 후보와 가장 안전한 다음 조치 및 롤백 방법을 순서대로 제시해 주세요.'
  });
}

async function workspacePublishPreflight(options = {}) {
  const surfaceProfile = options.surfaceProfile === undefined
    ? WORKSPACE_SURFACE_PROFILES.BUSINESS_FULL : options.surfaceProfile;
  if (!Object.values(WORKSPACE_SURFACE_PROFILES).includes(surfaceProfile)) {
    const error = new Error('게시 대상은 business-full 또는 personal-read-fetch여야 합니다.');
    error.code = 'invalid_workspace_surface';
    error.status = 400;
    throw error;
  }
  const runtime = await workspaceMcpStatus({ surfaceProfile });
  const publication = workspacePublicationStatus({
    surfaceProfile,
    commandSandboxAvailable: runtime.hostCapabilities?.commands === true
  });
  const runtimeMatches = runtime.surfaceProfile === surfaceProfile;
  return {
    ok: runtimeMatches && runtime.state === 'ready',
    surfaceProfile,
    checkedAt: new Date().toISOString(),
    evidence: 'local-source-and-saved-record',
    remotePublicationVerified: false,
    runtime: {
      surfaceProfile,
      state: runtimeMatches ? runtime.state : 'unknown',
      detail: runtimeMatches ? runtime.detail : '선택한 표면의 실행 상태를 확인하지 못했습니다.',
      workspaceCount: runtimeMatches ? runtime.workspaceCount ?? 0 : null,
      permissions: runtimeMatches ? runtime.permissions : null,
      tunnelReady: runtimeMatches && runtime.tunnel?.ready === true,
      localBinding: {
        scope: 'LOCAL',
        identityBinding: runtimeMatches ? runtime.remoteAuthority?.identityBinding ?? null : null,
        provesRemotePublication: false
      }
    },
    publication: {
      surfaceProfile,
      needsPublish: publication.needsPublish,
      toolCount: publication.manifest.toolCount,
      readToolCount: publication.manifest.readToolCount,
      writeToolCount: publication.manifest.writeToolCount,
      manifestHash: publication.manifest.hash,
      tools: publication.manifest.tools,
      published: publication.published,
      manageUrl: publication.manageUrl
    },
    handoff: {
      required: true,
      route: 'official-browser-ui',
      detail: '선택한 표면의 실제 계정과 앱을 공식 화면에서 확인하고 Scan Tools → 위험 항목 검토 → 게시 1회 → 원격 결과 확인을 진행하세요. 로컬 결속은 원격 앱 ID·계정·Tunnel 증거가 아닙니다.'
    }
  };
}

const definitions = Object.freeze({
  'status': { title: '전체 상태', run: () => collectStatus() },
  'setup.check': { title: '설치 상태 점검', run: () => setupEnvironment({ checkOnly: true }) },
  'cli.status': { title: 'CLI 연결 점검', run: () => cliToolStatus() },
  'routes.status': { title: 'Codex 모델 경로 점검', run: () => codexRouteStatus() },
  'jobs.status': { title: '내구 작업·산출물 점검', run: () => jobManagerStatus() },
  'browser.status': { title: '브라우저 identity·target lease 점검', run: () => browserBrokerStatus() },
  'extensions.status': { title: 'Plugin·Skill package 점검', run: () => extensionRegistryStatus() },
  'codex.plugins.status': { title: 'Codex 필수 Plugin 점검', run: () => codexPluginStatus() },
  'compatibility.status': { title: '호환성·업데이트 canary 점검', run: () => compatibilityStatus() },
  'support.bundle': { title: '상담용 통합 진단 묶음', run: () => recoveryBundle() },
  'web-gpt.doctor': {
    title: 'Web GPT 브리지 정밀 진단',
    command: () => webGptCommand(['doctor', '--json'])
  },
  'ocx.diagnostics': {
    title: 'OCX 독립 진단',
    command: () => ({ executable: process.env.AICC_OCX_EXECUTABLE?.trim() || 'ocx', args: ['system', 'diagnostics', '--json'] })
  },
  'agents.status': { title: 'Codex 하위 에이전트 상태', run: () => agentsStatus() },
  'workspace.status': { title: 'AICC 원격 작업공간 MCP 상태', run: () => workspaceMcpStatus() },
  'workspace.publish-preflight': {
    title: 'AICC Workspace 게시 사전검사',
    run: workspacePublishPreflight
  },
  // The dashboard task endpoint forwards taskId only. Keep Personal explicit
  // without adding an API or silently falling back to the Business surface.
  'workspace.publish-preflight.personal-read-fetch': {
    title: 'AICC Workspace Personal 읽기 전용 게시 사전검사',
    run: (options = {}) => {
      if (options.surfaceProfile !== undefined && options.surfaceProfile !== WORKSPACE_SURFACE_PROFILES.PERSONAL_READ_FETCH) {
        const error = new Error('Personal 사전검사의 게시 대상이 일치하지 않습니다.');
        error.code = 'invalid_workspace_surface';
        error.status = 400;
        throw error;
      }
      return workspacePublishPreflight({ ...options, surfaceProfile: WORKSPACE_SURFACE_PROFILES.PERSONAL_READ_FETCH });
    }
  },
  'guidance.check': {
    title: '지침과 스킬 점검',
    command: () => ({
      executable: 'pwsh',
      args: ['-NoProfile', '-File', path.join(root, 'tools', 'platform', 'test', 'Test-AiccGuidance.ps1'), '-AiccRoot', root, '-AsJson']
    })
  }
});

function parseOutput(text) {
  const clean = redactText(String(text ?? '').trim());
  if (!clean) return null;
  try { return sanitize(JSON.parse(clean)); } catch { return clean.length > 20_000 ? `${clean.slice(0, 20_000)}\n…` : clean; }
}

export function listTasks() {
  return Object.entries(definitions).map(([id, definition]) => ({ id, title: definition.title }));
}

export async function runTask(id, options = {}) {
  const definition = definitions[id];
  if (!definition) {
    const error = new Error('허용되지 않은 진단 작업입니다.');
    error.code = 'task_not_allowed';
    error.status = 404;
    throw error;
  }
  const startedAt = Date.now();
  if (definition.run) {
    const result = sanitize(await definition.run(options));
    return { ok: result?.ok !== false, id, title: definition.title, durationMs: Date.now() - startedAt, result };
  }
  const runner = options.runCommand ?? runCommand;
  const command = definition.command();
  const result = await runner(command.executable, command.args, { timeoutMs: 120_000, maxBytes: 512_000 });
  const parsed = parseOutput(result.stdout || result.stderr);
  return {
    ok: result.ok,
    id,
    title: definition.title,
    durationMs: result.durationMs ?? Date.now() - startedAt,
    exitCode: result.exitCode,
    result: parsed
  };
}
