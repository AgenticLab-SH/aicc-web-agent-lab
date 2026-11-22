import os from 'node:os';
import path from 'node:path';
import { accountStatus } from './adapters/accounts.mjs';
import { ocxStatus } from './adapters/ocx.mjs';
import { ocxAccountStatus } from './adapters/ocx-accounts.mjs';
import { localToolStatus } from './adapters/local-tools.mjs';
import { pathStatus } from './lib/fs-status.mjs';
import { sanitize } from './lib/redact.mjs';
import { authPortalStatus } from './adapters/auth-portal.mjs';
import { guidanceStatusQuick } from './adapters/guidance-status.mjs';
import { agentsStatus } from './agents.mjs';
import { workspaceMcpStatus } from './workspace-mcp.mjs';
import { workspaceAppSyncStatus } from './workspace-app-status.mjs';
import { webGptStatus } from './adapters/web-gpt.mjs';
import { webGptRescueStatus } from './web-gpt-rescue.mjs';
import { codexRouteStatus } from './adapters/codex-routes.mjs';
import { jobManagerStatus } from './jobs/status.mjs';
import { browserBrokerStatus } from './browser/status.mjs';
import { extensionRegistryStatus } from './extensions/status.mjs';
import { compatibilityStatus } from './compatibility/status.mjs';
import { privateHomeStatus } from './private-home.mjs';
import { codexPluginStatus } from './adapters/codex-plugins.mjs';

async function isolatedComponent(id, label, operation, fallback = null, timeoutMs = 12_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('status probe timed out');
          error.code = 'AICC_STATUS_PROBE_TIMEOUT';
          reject(error);
        }, timeoutMs);
      })
    ]);
  } catch (error) {
    if (fallback !== null) return fallback;
    return {
      id,
      label,
      state: 'attention',
      detail: error?.code === 'AICC_STATUS_PROBE_TIMEOUT'
        ? '이 구역의 상태 조회 시간이 초과되었습니다. 다른 AICC 기능은 계속 사용할 수 있습니다.'
        : '이 구역의 상태 조회만 실패했습니다. 다른 AICC 기능은 계속 사용할 수 있습니다.',
      isolatedFailure: true,
      timedOut: error?.code === 'AICC_STATUS_PROBE_TIMEOUT'
    };
  } finally { clearTimeout(timer); }
}

export async function collectStatus(options = {}) {
  const stateRoot = process.env.AICC_STATE_ROOT || path.join(os.homedir(), '.ai-control-center');
  const componentTimeoutMs = options.componentTimeoutMs ?? 12_000;
  const isolate = (id, label, operation, fallback = null) => isolatedComponent(id, label, operation, fallback, componentTimeoutMs);
  const [accounts, ocxAccounts, ocx, webGpt, webGptRescue, routes, portal, guidance, codexPlugins, agents, workspace, workspaceApps, jobs, browser, extensions, compatibility, privateHome, tools] = await Promise.all([
    isolate('accounts', 'GPT 계정', () => (options.accountStatus ?? accountStatus)(options.accounts)),
    isolate('ocx-accounts', 'OCX 계정 풀', () => (options.ocxAccountStatus ?? ocxAccountStatus)(options.ocxAccounts)),
    isolate('ocx', 'OCX 모델 연결', () => (options.ocxStatus ?? ocxStatus)(options.ocx)),
    isolate('web-gpt', 'Web GPT 모델 브리지', () => (options.webGptStatus ?? webGptStatus)(options.webGpt)),
    isolate('web-gpt-rescue', 'Web GPT 독립 rescue', async () => {
      const result = await (options.webGptRescueStatus ?? webGptRescueStatus)(options.webGptRescue);
      return {
        ...result,
        id: 'web-gpt-rescue',
        label: 'Web GPT 독립 rescue',
        state: result.state === 'ready' || result.state === 'standby' ? 'ready' : result.state === 'unprepared' ? 'unavailable' : 'attention',
        detail: result.state === 'ready'
          ? `17842 browser rescue 준비 · 활성 HTTP ${result.active?.http ?? 'UNKNOWN'}`
          : result.state === 'standby'
            ? '17842 독립 rescue는 보존됐지만 browser 수락 상태는 standby입니다.'
            : '17842 독립 rescue 상태를 확인해야 합니다.',
        optional: true,
        healthSummary: false
      };
    }),
    isolate('codex-routes', 'Codex 모델 경로', () => (options.codexRouteStatus ?? codexRouteStatus)(options.codexRoutes)),
    isolate('auth-portal', '웹 로그인 전달 포털', () => (options.authPortalStatus ?? authPortalStatus)(options.authPortal)),
    isolate('guidance', '지침·스킬·Codex 에이전트', () => Promise.resolve((options.guidanceStatus ?? guidanceStatusQuick)(options.guidance))),
    isolate('codex-plugins', 'Codex 필수 Plugin', () => (options.codexPluginStatus ?? codexPluginStatus)({ stateRoot, ...options.codexPlugins })),
    isolate('codex-agents', 'Codex 하위 에이전트', () => Promise.resolve((options.agentsStatus ?? agentsStatus)(options.agents))),
    isolate('workspace-mcp', 'AICC 원격 작업공간 MCP', () => (options.workspaceMcpStatus ?? workspaceMcpStatus)(options.workspace)),
    isolate('workspace-app-sync', 'AICC Workspace 계정 동기화', () => Promise.resolve((options.workspaceAppSyncStatus ?? workspaceAppSyncStatus)({ stateRoot, ...options.workspaceApps }))),
    isolate('job-manager', '내구 작업·산출물', () => Promise.resolve((options.jobManagerStatus ?? jobManagerStatus)({ stateRoot, ...options.jobs }))),
    isolate('browser-broker', '브라우저 세션 Broker', () => Promise.resolve((options.browserBrokerStatus ?? browserBrokerStatus)({ stateRoot, ...options.browser }))),
    isolate('extensions', 'Plugin·Skill 패키지', () => Promise.resolve((options.extensionRegistryStatus ?? extensionRegistryStatus)(options.extensions))),
    isolate('compatibility-lab', '호환성·업데이트 Canary', () => Promise.resolve((options.compatibilityStatus ?? compatibilityStatus)({ stateRoot: path.join(stateRoot, 'compatibility'), ...options.compatibility }))),
    isolate('private-home', 'AICC Private Home', () => Promise.resolve((() => {
      const result = (options.privateHomeStatus ?? privateHomeStatus)({ stateRoot, ...options.privateHome });
      return { id: 'private-home', label: 'AICC Private Home', state: result.ok ? 'ready' : 'attention', detail: result.ok ? `owner-only · 이동 가능 상태 ${result.presentMovableFiles}개` : '초기화 또는 권한 확인이 필요합니다.', ...result };
    })())),
    isolate('local-tools', '로컬 앱', () => (options.localToolStatus ?? localToolStatus)(options.tools), [{
      id: 'local-tools', label: '로컬 앱', state: 'attention',
      detail: '로컬 앱 상태 조회 시간이 초과되거나 실패했습니다.', isolatedFailure: true
    }])
  ]);
  const agentComponent = agents.id === 'codex-agents' && agents.isolatedFailure
    ? agents
    : {
        id: 'codex-agents', label: 'Codex 하위 에이전트', state: agents.state === 'ready' ? 'ready' : 'attention',
        detail: agents.message, summary: agents.summary, issues: agents.issues
      };
  const components = [accounts, ocxAccounts, ocx, webGpt, webGptRescue, routes, portal, guidance, codexPlugins, agentComponent, workspace, workspaceApps, jobs, browser, extensions, compatibility, privateHome, ...tools];
  const healthComponents = components.filter(component => component.healthSummary !== false && !(component.optional && component.state === 'unavailable'));
  const ready = healthComponents.filter(component => component.state === 'ready').length;

  return sanitize({
    ok: true,
    schemaVersion: 1,
    mode: 'local-control',
    generatedAt: new Date().toISOString(),
    summary: {
      ready,
      total: healthComponents.length,
      attention: healthComponents.length - ready
    },
    components,
    stateRoots: [
      pathStatus(stateRoot),
      pathStatus(path.join(stateRoot, 'workspace-mcp')),
      pathStatus(path.join(stateRoot, 'jobs')),
      pathStatus(process.env.AICC_ACCOUNT_MANAGER_STATE_ROOT || path.join(stateRoot, 'account-manager')),
      pathStatus(path.join(os.homedir(), '.codex')),
      pathStatus(path.join(os.homedir(), '.codex-multi')),
      pathStatus(path.join(os.homedir(), '.opencodex'))
    ]
  });
}
