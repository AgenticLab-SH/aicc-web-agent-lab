import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountStatus } from './adapters/accounts.mjs';
import { ocxStatus } from './adapters/ocx.mjs';
import { ocxAccountStatus } from './adapters/ocx-accounts.mjs';
import { runCommand } from './lib/command.mjs';
import { webGptCommand as resolveWebGptCommand } from './lib/web-gpt-command.mjs';
import { redactText, sanitize } from './lib/redact.mjs';
import { defaultPythonCommand } from './config.mjs';
import { openaiProviderSnapshot, openaiProviderStatus } from './openai-usage.mjs';
import { codexRouteStatus } from './adapters/codex-routes.mjs';
import { openaiAgentGuardStatus } from '../tools/platform/codex/install-openai-api-guard.mjs';
import { designSourcesStatus, normalizeDesignSourceSelection } from './design-sources.mjs';
import { projectServicesSnapshot, projectServicesStatus, selectProjectService } from './project-services.mjs';
import { codexCliUpdateSnapshot, codexCliUpdateStatus } from './codex-cli-update.mjs';
import { aiccRecoveryStatus } from './aicc-recovery-status.mjs';

const previewLifetimeMs = 2 * 60 * 1000;
const here = path.dirname(fileURLToPath(import.meta.url));
const embeddedAccountManager = path.resolve(here, '../components/account-manager/ops/local/codex_multi.py');
const ocxAccountImporter = path.resolve(here, '../components/account-manager/ops/auth-portal/import_current_to_ocx.py');
const openaiProviderCommand = path.resolve(here, 'openai-provider-command.mjs');
const defaultWebGptRecoveryCommand = path.resolve(here, 'web-gpt-recovery-command.mjs');
const defaultCodexNativeRecoveryCommand = path.resolve(here, 'codex-native-recovery-command.mjs');
const defaultOcxUpstreamStartCommand = path.resolve(here, 'ocx-upstream-start-command.mjs');
const defaultOcxUpstreamSyncCommand = path.resolve(here, 'ocx-upstream-sync-command.mjs');
const defaultDesignSourceCommand = path.resolve(here, 'design-source-command.mjs');
const defaultProjectServiceCommand = path.resolve(here, 'project-service-command.mjs');
const defaultCodexCliUpdateCommand = path.resolve(here, 'codex-cli-update-command.mjs');
const defaultAiccRecoveryRunner = path.resolve(here, 'aicc-recovery-runner.mjs');

export class ActionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
    this.status = status;
  }
}

function stableFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* best effort on Windows */ }
}

function outputSummary(result) {
  const text = redactText([result.stdout, result.stderr].filter(Boolean).join('\n').trim());
  return text.length > 4_000 ? `${text.slice(0, 4_000)}\n…` : text;
}

function ocxSnapshot(status) {
  return {
    installed: Boolean(status?.installed),
    healthy: Boolean(status?.healthy),
    version: status?.version ?? null,
    port: status?.runtime?.port ?? null,
    topology: status?.topology?.mode ?? null,
    routingInjected: status?.sections?.runtime?.routingInjected ?? null,
    activeTurns: Number.isInteger(status?.sections?.runtime?.activeTurns) ? status.sections.runtime.activeTurns : null
  };
}

function ocxUpstreamOnly(status) {
  const topology = status?.topology?.mode ?? status?.topology;
  const routingInjected = status?.sections?.runtime?.routingInjected ?? status?.routingInjected;
  return topology === 'upstream-only' && routingInjected === false;
}

function routeSnapshot(status) {
  return {
    activeRoute: status?.activeRoute ?? 'unknown',
    routeUrl: status?.routeUrl ?? null,
    nativeReady: status?.nativeReady === true,
    bridgeHealthy: status?.webGpt?.healthy === true,
    bridgeAcceptingTurns: status?.webGpt?.acceptingTurns === true,
    bridgeAcceptingBrowserTurns: status?.webGpt?.acceptingBrowserTurns === true,
    routerOwner: status?.webGpt?.routerOwner ?? null,
    activeHttpTurns: Number.isFinite(status?.webGpt?.activeHttpTurns) ? status.webGpt.activeHttpTurns : null,
    activeBrowserHttpTurns: Number.isFinite(status?.webGpt?.activeBrowserHttpTurns) ? status.webGpt.activeBrowserHttpTurns : null,
    activeBrowserTurns: Number.isFinite(status?.webGpt?.activeBrowserTurns) ? status.webGpt.activeBrowserTurns : null,
    activeTurns: Number.isFinite(status?.webGpt?.activeTurns) ? status.webGpt.activeTurns : null,
    activeWebTurns: Number.isFinite(status?.webGpt?.activeWebTurns) ? status.webGpt.activeWebTurns : null,
    ocxHealthy: status?.ocx?.healthy === true
  };
}

function accountSnapshot(status) {
  return {
    state: status?.state ?? null,
    activeAccount: status?.activeAccount ?? null,
    accounts: (status?.accounts ?? []).map(account => ({
      index: account.index ?? null,
      account: account.account ?? null,
      idPrefix: account.id_prefix ?? null,
      expired: Boolean(account.expired)
    }))
  };
}

function ocxAccountSnapshot(status) {
  return {
    state: status?.state ?? null,
    activeId: status?.activeId ?? null,
    accounts: (status?.accounts ?? []).map(account => ({
      id: account.id ?? null,
      label: account.label ?? null,
      email: account.email ?? null,
      plan: account.plan ?? null,
      active: Boolean(account.active),
      paused: Boolean(account.paused),
      needsReauth: Boolean(account.needsReauth)
    }))
  };
}

function openaiProbeSnapshot(status) {
  return {
    ...openaiProviderSnapshot(status),
    availability: Object.fromEntries((status?.models || []).map(item => [item.id, {
      status: item.availability?.status || 'untested',
      checkedAt: item.availability?.checkedAt || null
    }]))
  };
}

function openaiCatalogSnapshot(status) {
  return {
    ...openaiProbeSnapshot(status),
    probeBatch: status?.probeBatch ? {
      id: status.probeBatch.id || null,
      status: status.probeBatch.status || null,
      attempted: status.probeBatch.attempted || 0,
      completedAt: status.probeBatch.completedAt || null
    } : null,
    catalogCheckedAt: status?.catalog?.check?.checkedAt || null,
    catalogCheckStatus: status?.catalog?.check?.status || 'not_checked'
  };
}

function openaiAgentGuardSnapshot(status) {
  return { ok: Boolean(status?.ok), scopeCount: status?.scopeCount || 0, guardedCount: status?.guardedCount || 0 };
}

function designSourceSnapshot(status) {
  return {
    checkedAt: status?.checkedAt ?? null,
    sources: (status?.sources ?? []).map(source => ({
      id: source.id,
      activeRevision: source.activeRevision ?? null,
      remoteRevision: source.remoteRevision ?? null,
      integrity: source.integrity ?? 'unknown',
      status: source.status ?? 'unknown'
    }))
  };
}

function latestRecoverySnapshot(status) {
  return {
    available: status?.available === true,
    state: status?.state ?? 'unknown',
    reason: status?.reason ?? 'recovery_unknown',
    component: status?.component ?? null,
    operationId: status?.operationId ?? null,
    pointerSha256: status?.pointerSha256 ?? null,
    statusReady: status?.status?.ready === true,
    statusSummary: status?.status?.summary ?? null,
    dryRunReady: status?.dryRun?.ready === true,
    gate: {
      readOk: status?.gate?.readOk === true,
      exactIdle: status?.gate?.exactIdle === true,
      activeCount: Number.isInteger(status?.gate?.activeCount) ? status.gate.activeCount : null,
      unknownCount: Number.isInteger(status?.gate?.unknownCount) ? status.gate.unknownCount : null
    }
  };
}

function resolveOcxAccount(selector, status) {
  const raw = String(selector ?? '').trim();
  if (!raw) throw new ActionError('selector_required', '전환할 OCX 계정을 선택해야 합니다.');
  if (!['ready', 'degraded'].includes(status?.state)) {
    throw new ActionError('ocx_accounts_unavailable', 'OCX 계정 풀을 확인할 수 없습니다.', 409);
  }
  const lower = raw.toLocaleLowerCase();
  const matches = (status.accounts ?? []).filter(account =>
    String(account.id ?? '').toLocaleLowerCase() === lower
    || String(account.label ?? '').toLocaleLowerCase() === lower
    || String(account.email ?? '').toLocaleLowerCase() === lower
  );
  if (matches.length !== 1) {
    throw new ActionError(
      matches.length > 1 ? 'selector_ambiguous' : 'account_not_found',
      matches.length > 1 ? '여러 OCX 계정이 같은 선택자와 일치합니다.' : '선택한 OCX 계정을 찾지 못했습니다.'
    );
  }
  const target = matches[0];
  if (target.needsReauth) throw new ActionError('account_needs_reauth', '재인증이 필요한 OCX 계정은 선택할 수 없습니다.', 409);
  if (target.paused) throw new ActionError('account_paused', '일시 정지된 OCX 계정은 먼저 해제해야 합니다.', 409);
  if (target.id === status.activeId) throw new ActionError('already_active', '이미 이 OCX 계정이 선택되어 있습니다.', 409);
  return target;
}

function resolveAccount(selector, status) {
  const raw = String(selector ?? '').trim();
  if (!raw) throw new ActionError('selector_required', '전환할 계정을 선택해야 합니다.');
  if (status?.state !== 'ready') {
    throw new ActionError('accounts_unavailable', '계정 상태를 확인할 수 없어 전환을 준비하지 않았습니다.', 409);
  }

  const lower = raw.toLowerCase();
  const matches = (status.accounts ?? []).filter(account => {
    if (String(account.index ?? '') === raw) return true;
    if (String(account.account ?? '').toLowerCase() === lower) return true;
    return String(account.id_prefix ?? '').toLowerCase() === lower;
  });
  if (matches.length !== 1) {
    throw new ActionError(
      matches.length > 1 ? 'selector_ambiguous' : 'account_not_found',
      matches.length > 1 ? '여러 계정이 같은 선택자와 일치합니다.' : '선택한 계정을 찾지 못했습니다.'
    );
  }
  const target = matches[0];
  if (target.expired) throw new ActionError('account_expired', '만료된 계정은 갱신한 뒤 전환할 수 있습니다.', 409);
  if (target.account === status.activeAccount) {
    throw new ActionError('already_active', '이미 이 계정이 기본 GPT Desktop에서 사용 중입니다.', 409);
  }
  return target;
}

function defaultAccountSwitchCommand(selector) {
  const python = process.env.AICC_PYTHON
    ? { executable: process.env.AICC_PYTHON.trim(), args: [] }
    : defaultPythonCommand();
  return {
    executable: python.executable,
    args: [...python.args, embeddedAccountManager, 'switch', selector]
  };
}

function defaultOcxImportCommand() {
  const python = process.env.AICC_PYTHON
    ? { executable: process.env.AICC_PYTHON.trim(), args: [] }
    : defaultPythonCommand();
  return { executable: python.executable, args: [...python.args, ocxAccountImporter] };
}

function buildDefinitions(options) {
  const ocxExecutable = options.ocxExecutable || process.env.AICC_OCX_EXECUTABLE?.trim() || 'ocx';
  const inheritedEnvironment = options.env ?? process.env;
  const appCodexHome = options.appCodexHome
    ?? inheritedEnvironment.CM_APP_CODEX_HOME?.trim()
    ?? path.join(os.homedir(), '.codex');
  const ocxEnvironment = {
    ...inheritedEnvironment,
    CM_APP_CODEX_HOME: appCodexHome,
    CODEX_HOME: appCodexHome
  };
  delete ocxEnvironment.CODEX_SQLITE_HOME;
  delete ocxEnvironment.CODEX_ELECTRON_USER_DATA_PATH;
  delete ocxEnvironment.CODEX_MULTI_ACCOUNT_NAME;
  const ocxCommand = args => ({ executable: ocxExecutable, args, env: ocxEnvironment });
  const ocxUpstreamStartCommand = options.ocxUpstreamStartCommand ?? defaultOcxUpstreamStartCommand;
  const startOcxUpstreamCommand = () => ({ executable: process.execPath, args: [ocxUpstreamStartCommand], env: ocxEnvironment });
  const ocxUpstreamSyncCommand = options.ocxUpstreamSyncCommand ?? defaultOcxUpstreamSyncCommand;
  const syncOcxUpstreamCommand = () => ({ executable: process.execPath, args: [ocxUpstreamSyncCommand], env: ocxEnvironment });
  const webGptCommand = args => ({ ...resolveWebGptCommand(args, { executable: options.webGptExecutable, env: inheritedEnvironment }), env: inheritedEnvironment });
  const webGptRecoveryCommand = options.webGptRecoveryCommand ?? defaultWebGptRecoveryCommand;
  const recoverWebGptCommand = () => ({
    executable: process.execPath,
    args: [webGptRecoveryCommand],
    env: inheritedEnvironment
  });
  const codexNativeRecoveryCommand = options.codexNativeRecoveryCommand ?? defaultCodexNativeRecoveryCommand;
  const recoverNativeCommand = () => ({
    executable: process.execPath,
    args: [codexNativeRecoveryCommand],
    env: inheritedEnvironment
  });
  const providerEnvironment = { ...inheritedEnvironment, AICC_STATE_ROOT: options.stateRoot };
  const openaiCommand = args => ({ executable: process.execPath, args: [openaiProviderCommand, ...args], env: providerEnvironment });
  const accountSwitchCommand = options.accountSwitchCommand ?? defaultAccountSwitchCommand;
  const designSourceCommand = options.designSourceCommand ?? defaultDesignSourceCommand;
  const designSourceEnvironment = { ...inheritedEnvironment, AICC_STATE_ROOT: options.stateRoot };
  const projectServiceCommand = options.projectServiceCommand ?? defaultProjectServiceCommand;
  const projectServiceEnvironment = { ...inheritedEnvironment, AICC_STATE_ROOT: options.stateRoot };
  const codexExecutable = options.codexExecutable
    ?? inheritedEnvironment.AICC_CODEX_EXECUTABLE?.trim()
    ?? path.join(os.homedir(), '.local', 'bin', 'codex');
  const codexCliUpdateCommand = options.codexCliUpdateCommand ?? defaultCodexCliUpdateCommand;
  const aiccRecoveryRunner = options.aiccRecoveryRunner ?? defaultAiccRecoveryRunner;
  const workspaceRootScript = path.resolve(here, '../tools/platform/windows/Reconcile-AiccWorkspaceRoot.ps1');
  const workspaceRootEnvironment = { ...inheritedEnvironment, AICC_STATE_ROOT: options.stateRoot };
  const workspaceRootPowerShell = options.workspaceRootPowerShell ?? 'pwsh.exe';
  const workspaceRootArgs = (args, mode) => ['-NoProfile', '-NonInteractive', '-File', workspaceRootScript,
    '-Mode', mode, '-PlanFile', args.planFile, '-ExpectedPlanSha256', args.planSha256,
    '-RescueReadyFile', args.rescueReadyRef, ...(mode === 'Apply' ? ['-RequireActionLock'] : [])];
  const rootSelection = args => {
    if ((options.platform ?? process.platform) !== 'win32') throw new ActionError('workspace_root_platform', 'Windows 전용 작업입니다.', 409);
    const selection = { planFile: args?.planFile, planSha256: args?.planSha256, rescueReadyRef: args?.rescueReadyRef };
    if (Object.keys(args ?? {}).some(key => !Object.hasOwn(selection, key))
      || !/^[a-f0-9]{64}$/.test(selection.planSha256 ?? '')
      || !path.isAbsolute(selection.planFile ?? '') || !path.isAbsolute(selection.rescueReadyRef ?? '')) {
      throw new ActionError('workspace_root_selection', '정확한 계획 파일, SHA와 복구 응답 참조가 필요합니다.', 409);
    }
    return selection;
  };
  return {
    'workspace.canonical-root-reconcile': {
      title: 'Workspace 정본 연결·런타임 정비',
      kind: 'workspace-maintenance',
      timeoutMs: 180_000,
      async readState(args) {
        const selection = rootSelection(args);
        const result = await (options.runCommand ?? runCommand)(workspaceRootPowerShell, workspaceRootArgs(selection, 'Status'), {
          timeoutMs: 30_000, maxBytes: 64_000, env: workspaceRootEnvironment
        });
        if (!result.ok) throw new ActionError('workspace_root_status', '계획 상태를 읽지 못했습니다. 기존 연결을 보존합니다.', 409);
        try { return JSON.parse(result.stdout); }
        catch { throw new ActionError('workspace_root_status_shape', '계획 상태 응답이 불명확합니다.', 409); }
      },
      snapshot: state => ({ operationId: state.operationId, planSha256: state.planSha256,
        kind: state.kind ?? null, immutableInputHashes: state.immutableInputHashes
          ? Object.fromEntries(Object.entries(state.immutableInputHashes).sort(([a], [b]) => a.localeCompare(b))) : null,
        scopeHash: state.scopeHash, transitionMode: state.transitionMode, coldHandoffSha256: state.coldHandoffSha256, coldStateSha256: state.coldStateSha256, rescueReadySha256: state.rescueReadySha256,
        fileHashes: Object.fromEntries(Object.keys(state.fileHashes ?? {}).sort().map(key => [key, state.fileHashes[key]])), allBefore: state.allBefore,
        allAfter: state.allAfter, terminal: state.terminal, ready: state.ready }),
      prepare(args, state) {
        const selection = rootSelection(args);
        if (state.ready !== true || state.allBefore !== true || state.terminal !== 'NOT_DISPATCHED') {
          throw new ActionError('workspace_root_hold', '원본 상태와 해당 작업의 독립 복구 준비가 필요합니다.', 409);
        }
        return selection;
      },
      describe: (_args, state) => ({
        impact: state.kind === 'workspace-pid-reuse-guard'
          ? '현재 정본 폴더와 계정을 유지하고 승인된 PID 재사용 방지 후보의 Workspace·helper·gateway 연결을 함께 전환합니다.'
          : state.transitionMode === 'cold-bootstrap'
          ? '정상 인계로 정지된 정확한 예약 작업과 runtime을 확인해 승인된 gateway와 정본 폴더 별칭을 함께 설치하고 같은 예약 작업을 켜서 시작합니다.'
          : '정본 폴더 별칭과 그 파일을 고정한 gateway 설정을 함께 전환합니다. 기존 연결 프로그램 bytes와 다른 provider 계약은 재사용합니다.',
        warnings: ['현재 요청과 상태 불명 작업이 있으면 중지합니다.', '단일 잠금 아래 설정·연결 포인터·예약 작업 영수증을 교체하며 실패 시 같은 묶음을 복원합니다.'],
        rollback: '해당 작업의 원본 백업만 사용합니다. 제3의 변경이나 소유권 불명 상태는 덮어쓰지 않고 보류합니다.'
      }),
      command: args => ({ executable: workspaceRootPowerShell, args: workspaceRootArgs(args, 'Apply'), env: workspaceRootEnvironment }),
      verify: (state, _args, _before, result) => result.ok && state.allAfter === true
        && state.terminal === 'APPLIED_RUNTIME_ADMITTED'
    },
    'aicc.restore.latest': {
      title: '최신 AICC 안전 복구',
      kind: 'recovery',
      timeoutMs: 10 * 60_000,
      readState: options.getAiccRecoveryStatus,
      snapshot: latestRecoverySnapshot,
      prepare(_args, state) {
        if (state?.available !== true) {
          throw new ActionError('recovery_pointer_unknown', '검증된 최신 복구 묶음을 찾지 못했습니다.', 409);
        }
        if (state?.gate?.readOk !== true || !Number.isInteger(state?.gate?.activeCount) || !Number.isInteger(state?.gate?.unknownCount)) {
          throw new ActionError('recovery_gate_unknown', 'Codex ACTIVE/UNKNOWN 상태를 정확히 읽을 수 없어 복구하지 않았습니다.', 409);
        }
        if (state.gate.exactIdle !== true) {
          throw new ActionError('codex_work_not_idle', `Codex 작업이 active ${state.gate.activeCount}, UNKNOWN ${state.gate.unknownCount}이어서 복구하지 않았습니다.`, 409);
        }
        if (state?.status?.ready !== true || state?.dryRun?.ready !== true) {
          throw new ActionError('recovery_preflight_hold', '최신 복구 묶음의 상태 또는 dry-run이 안전을 증명하지 못했습니다.', 409);
        }
        return {
          component: state.component,
          operationId: state.operationId,
          pointerSha256: state.pointerSha256
        };
      },
      describe: (args, state) => ({
        impact: `${args.component || '봉인된 exact component'}만 최신 owner-only 복구점으로 되돌립니다. 다른 모델 경로·Workspace·브라우저·계정은 변경하지 않습니다.`,
        warnings: [
          `복구 operation: ${args.operationId || 'owner-only latest'}`,
          '현재 Codex ACTIVE와 UNKNOWN이 모두 0이고 status·dry-run이 PASS한 경우에만 실행됩니다.',
          'dispatch 뒤 결과가 불명확하면 같은 복구를 재실행하지 않고 UNCERTAIN으로 중단합니다.'
        ],
        rollback: state.backup ? '봉인된 exact backup과 구성요소별 사후 조회를 사용합니다.' : '현재 복구 스크립트가 소유한 exact backup과 사후 조회만 사용합니다.'
      }),
      command: () => ({
        executable: process.execPath,
        args: [aiccRecoveryRunner, 'apply'],
        env: inheritedEnvironment
      }),
      verify: (state, args, _before, result) => Boolean(
        result.ok
        && state.available === true
        && state.pointerSha256 === args.pointerSha256
        && state.statusReady === true
        && state.gate.exactIdle === true
        && state.state === 'applied'
      )
    },
    'codex.web-gpt.cancel-turns': {
      title: '남아 있는 Web GPT 작업 취소',
      kind: 'route',
      readState: options.getCodexRouteStatus,
      snapshot: routeSnapshot,
      prepare(_args, state) {
        if (!state.webGpt?.healthy) {
          throw new ActionError('bridge_unavailable', '17841 Web GPT 브리지가 응답하지 않아 작업 취소 명령을 전달할 수 없습니다.', 409);
        }
        const activeBrowserTurns = state.webGpt?.activeBrowserTurns;
        if (!Number.isInteger(activeBrowserTurns)) {
          throw new ActionError('turn_state_unknown', '활성 브라우저 작업 수를 확인할 수 없습니다.', 409);
        }
        if (activeBrowserTurns <= 0) {
          throw new ActionError('no_browser_turns', '취소할 Web GPT 브라우저 작업이 없습니다.', 409);
        }
        return {};
      },
      describe: () => ({
        impact: '17841 브리지에 남아 있는 ChatGPT Web 브라우저 작업을 즉시 취소해 경로 전환 잠금을 해제합니다.',
        warnings: ['진행 중인 Web GPT 답변과 브라우저 자동화가 중단됩니다.', 'Codex Desktop 요청이 계속 연결돼 있으면 현재 작업 중지 또는 앱 완전 종료가 추가로 필요합니다.'],
        rollback: '취소된 답변은 복원할 수 없습니다. 필요한 작업은 새 turn으로 다시 실행해야 합니다.'
      }),
      command: () => webGptCommand(['service', 'cancel-turns']),
      verifyAttempts: 12,
      verifyDelayMs: 250,
      verify: (state, _args, _before, result) => Boolean(result.ok && state.activeBrowserTurns === 0)
    },
    'codex.web-gpt.recover': {
      title: 'Web GPT 런타임 긴급 복구',
      kind: 'route',
      readState: options.getCodexRouteStatus,
      snapshot: routeSnapshot,
      prepare(_args, state) {
        if (!state.webGpt?.healthy) {
          throw new ActionError('turn_state_unknown', '17841 health와 활성 작업 수가 UNKNOWN이라 재시작하지 않았습니다.', 409);
        }
        const counters = [
          state.webGpt?.activeHttpTurns,
          state.webGpt?.activeBrowserHttpTurns,
          state.webGpt?.activeBrowserTurns
        ];
        if (counters.some(value => !Number.isInteger(value))) {
          throw new ActionError('turn_state_unknown', '17841 활성 작업 수를 정확히 확인할 수 없어 재시작하지 않았습니다.', 409);
        }
        if (counters.some(value => value > 0)) {
          throw new ActionError('active_turns', 'Web GPT 작업이 진행 중이라 런타임을 재시작하지 않았습니다.', 409);
        }
        return {};
      },
      describe: (_args, state) => ({
        impact: state.routerOwner === 'service'
          ? '17841 launchd service router만 drain 후 재시작합니다. Desktop/browser-host, 17842, OCX, Native는 변경하지 않습니다.'
          : 'Codex Web GPT 런처만 정상 종료 후 다시 열어 17841 Responses 브리지를 복구합니다. Codex route, Native profile, OCX는 변경하지 않습니다.',
        warnings: ['현재 Web GPT의 세 active counter가 모두 정확히 0인 것을 확인했습니다.', '강제 종료는 사용하지 않으며 안전 종료 또는 bootstrap이 실패하면 같은 동작을 반복하지 않고 HOLD합니다.'],
        rollback: '복구 실패는 17841 component 안에서 HOLD합니다. Native·OCX·17842로 자동 전환하지 않습니다.'
      }),
      command: recoverWebGptCommand,
      timeoutMs: 60_000,
      verifyAttempts: 4,
      verifyDelayMs: 500,
      verify: (state, _args, _before, result) => Boolean(
        result.ok
        && state.bridgeHealthy === true
        && state.bridgeAcceptingTurns === true
      ),
      rollback: () => null
    },
    'codex.native.recover': {
      title: 'Native Codex로 긴급 복구',
      kind: 'route',
      readState: options.getCodexRouteStatus,
      snapshot: routeSnapshot,
      prepare(_args, state) {
        if (!state.nativeReady) throw new ActionError('native_profile_unavailable', '검증된 Native Codex 복구 프로필이 없습니다.', 409);
        const activeTurns = state.webGpt?.activeTurns;
        if (state.webGpt?.healthy && !Number.isInteger(activeTurns)) {
          throw new ActionError('turn_state_unknown', '17841 브리지는 응답하지만 활성 작업 수를 확인할 수 없어 모델 경로를 바꾸지 않았습니다.', 409);
        }
        if (Number.isInteger(activeTurns) && activeTurns > 0) throw new ActionError('active_turns', 'Web GPT 작업이 진행 중이라 모델 경로를 바꾸지 않았습니다.', 409);
        return {};
      },
      describe: () => ({
        impact: 'Web GPT 라우트를 먼저 해제하고 OCX 프록시 설정도 제거해 Codex 모델 경로를 OpenAI 공식 Native endpoint로 복구합니다.',
        warnings: ['현재 Codex Desktop 응답이 끝난 뒤 실행해야 합니다.', '경로 변경 뒤 Codex Desktop을 완전히 종료하고 다시 열어야 합니다.', 'OCX와 Web GPT 서비스 자체는 중지하지 않습니다.'],
        rollback: '17841 브리지가 정상일 때 “통합 모델 경로 다시 연결”을 실행하면 Web GPT와 OCX 모델 선택기로 돌아갑니다.'
      }),
      command: recoverNativeCommand,
      verifyAttempts: 4,
      verifyDelayMs: 250,
      verify: (state, _args, _before, result) => Boolean(result.ok && state.activeRoute === 'native'),
      rollback: before => before.activeRoute === 'web-gpt'
        ? webGptCommand(['route', 'connect'])
        : before.activeRoute === 'ocx'
          ? ocxCommand(['restore', 'back'])
          : null
    },
    'codex.bridge.reconnect': {
      title: '통합 모델 경로 다시 연결',
      kind: 'route',
      readState: options.getCodexRouteStatus,
      snapshot: routeSnapshot,
      prepare(_args, state) {
        if (!state.webGpt?.healthy || !state.webGpt?.acceptingTurns) throw new ActionError('bridge_unavailable', '17841 Web GPT 브리지가 준비되지 않아 연결하지 않았습니다.', 409);
        const activeTurns = state.webGpt?.activeTurns;
        if (!Number.isInteger(activeTurns)) {
          throw new ActionError('turn_state_unknown', '활성 Web GPT 작업 수를 확인할 수 없어 모델 경로를 바꾸지 않았습니다.', 409);
        }
        if (activeTurns > 0) throw new ActionError('active_turns', 'Web GPT 작업이 진행 중이라 모델 경로를 바꾸지 않았습니다.', 409);
        if (state.activeRoute === 'web-gpt') throw new ActionError('already_connected', '이미 통합 모델 경로를 사용하고 있습니다.', 409);
        return {};
      },
      describe: () => ({
        impact: 'Codex Desktop의 모델 선택기를 17841 브리지에 다시 연결합니다. Web 모델은 ChatGPT Web 경로를 사용하고, 일반 Codex 요청은 공식 Native upstream을 사용합니다. OCX는 aicc codex ocx로 명시적으로 실행하는 독립 경로입니다.',
        warnings: ['경로 변경 뒤 Codex Desktop을 완전히 종료하고 다시 열어야 합니다.', 'OCX의 상태는 17841 일반 Codex 요청의 가용성을 결정하지 않습니다.'],
        rollback: '검증에 실패하면 실행 전 Native 또는 OCX 직접 경로로 되돌립니다.'
      }),
      command: () => webGptCommand(['route', 'connect']),
      verifyAttempts: 4,
      verifyDelayMs: 250,
      verify: (state, _args, _before, result) => Boolean(result.ok && state.activeRoute === 'web-gpt'),
      rollback: before => before.activeRoute === 'native'
        ? ocxCommand(['restore'])
        : before.activeRoute === 'ocx'
          ? ocxCommand(['restore', 'back'])
          : null
    },
    'codex-cli.update': {
      title: 'Codex CLI 최신 안정판 적용',
      kind: 'platform-update',
      timeoutMs: 5 * 60_000,
      readState: options.getCodexCliUpdateStatus,
      snapshot: codexCliUpdateSnapshot,
      prepare(_args, state) {
        if (!state?.currentVersion || !state?.latestVersion) {
          throw new ActionError('codex_update_state_unknown', 'Codex CLI 설치 버전과 최신 안정판을 함께 확인할 수 없습니다.', 409);
        }
        if (state.currentVersion === state.latestVersion) {
          throw new ActionError('codex_already_current', `Codex CLI ${state.currentVersion}은 이미 최신 안정판입니다.`, 409);
        }
        if (state.managedStandalone !== true) {
          throw new ActionError('codex_install_method_unsupported', '공식 standalone 관리 설치가 아니므로 AICC가 설치 방식을 바꾸지 않았습니다.', 409);
        }
        if (state.updater?.active) {
          throw new ActionError('codex_daemon_updater_active', '공식 daemon updater가 실행 중이라 이중 업데이트를 시작하지 않았습니다.', 409);
        }
        if (state.work?.safe !== true) {
          throw new ActionError('codex_work_not_idle', `Codex 작업이 active ${state.work?.activeCount ?? 0}, UNKNOWN ${state.work?.unknownCount ?? 0}이어서 업데이트하지 않았습니다.`, 409);
        }
        return { expectedVersion: state.latestVersion };
      },
      describe: (args, state) => ({
        impact: `공식 standalone Codex CLI를 ${state.currentVersion}에서 ${args.expectedVersion}으로 갱신합니다. Codex Desktop과 App Server는 이 작업에서 재시작하지 않습니다.`,
        warnings: ['모든 Codex 작업이 exact idle일 때만 실행합니다.', '실행 중 App Server는 기존 버전을 유지하며 다음 정상 시작에서 새 CLI를 사용합니다.'],
        rollback: `검증 실패 시 current symlink를 보존된 ${path.basename(state.releaseTarget ?? '이전 release')}로 원자적으로 복원합니다.`
      }),
      command: (args, before) => ({
        executable: process.execPath,
        args: [codexCliUpdateCommand,
          '--codex', codexExecutable,
          '--codex-home', appCodexHome,
          '--expected-version', args.expectedVersion,
          '--previous-release', before.releaseTarget
        ],
        env: inheritedEnvironment
      }),
      verify: (state, args, _before, result) => Boolean(
        result.ok
        && state.managedStandalone === true
        && state.currentVersion === args.expectedVersion
      ),
      rollback: before => ({
        executable: process.execPath,
        args: [codexCliUpdateCommand,
          '--codex', codexExecutable,
          '--codex-home', appCodexHome,
          '--expected-version', before.currentVersion,
          '--previous-release', before.releaseTarget,
          '--restore-only', 'true'
        ],
        env: inheritedEnvironment
      })
    },
    'ocx.start': {
      title: 'OCX 시작',
      kind: 'provider',
      verifyAttempts: 12,
      verifyDelayMs: 250,
      readState: options.getOcxStatus,
      snapshot: ocxSnapshot,
      prepare(_args, state) {
        if (!state.installed) throw new ActionError('ocx_unavailable', 'OCX 실행 파일을 찾지 못했습니다.', 409);
        if (state.healthy) throw new ActionError('already_running', 'OCX가 이미 실행 중입니다.', 409);
        return {};
      },
      describe: () => ({
        impact: '이미 설치된 OCX 서비스의 10100 upstream만 시작하고 현재 Codex route 파일의 해시가 그대로인지 확인합니다.',
        warnings: ['서비스 설치·업데이트·모델 route 주입은 수행하지 않습니다.', 'Web GPT 17841과 Native Codex의 현재 경로는 유지합니다.'],
        rollback: '기동 또는 라우팅 정리가 실패하면 OCX service stop으로 서비스를 멈춰 실행 전 상태 복구를 시도합니다.'
      }),
      command: startOcxUpstreamCommand,
      verify: (state, _args, _before, result) => Boolean(result.ok && state.healthy && ocxUpstreamOnly(state)),
      rollback: (before, after) => !before.healthy && after.healthy ? ocxCommand(['service', 'stop']) : null
    },
    'ocx.sync': {
      title: 'OCX 모델 동기화',
      kind: 'provider',
      readState: options.getOcxStatus,
      snapshot: ocxSnapshot,
      prepare(_args, state) {
        if (!state.installed) throw new ActionError('ocx_unavailable', 'OCX 실행 파일을 찾지 못했습니다.', 409);
        if (!state.healthy) throw new ActionError('ocx_offline', 'OCX가 실행 중이 아니어서 upstream catalog를 읽을 수 없습니다.', 409);
        if (!ocxUpstreamOnly(state)) throw new ActionError('route_ownership_conflict', 'OCX가 upstream-only임을 확인할 수 없어 catalog 조회를 중단했습니다.', 409);
        return {};
      },
      describe: () => ({
        impact: '10100 upstream의 provider와 모델 catalog를 읽기 전용으로 다시 확인합니다.',
        warnings: ['Codex config, model cache, provider, account 또는 route를 변경하지 않습니다.'],
        rollback: '읽기 전용 작업이라 rollback mutation이 없습니다. route 파일 해시가 바뀌면 실패로 처리합니다.'
      }),
      command: syncOcxUpstreamCommand,
      verify: (state, _args, _before, result) => Boolean(result.ok && state.healthy && ocxUpstreamOnly(state))
    },
    'ocx.stop': {
      title: 'OCX 중지',
      kind: 'provider',
      readState: options.getOcxStatus,
      snapshot: ocxSnapshot,
      prepare(_args, state) {
        if (!state.installed) throw new ActionError('ocx_unavailable', 'OCX 실행 파일을 찾지 못했습니다.', 409);
        if (!state.healthy) throw new ActionError('already_stopped', 'OCX가 이미 중지되어 있습니다.', 409);
        const activeTurns = state?.sections?.runtime?.activeTurns;
        if (!Number.isInteger(activeTurns)) throw new ActionError('turn_state_unknown', '활성 OCX 작업 수를 확인할 수 없어 중지하지 않았습니다.', 409);
        if (activeTurns > 0) throw new ActionError('active_turns', 'OCX 작업이 진행 중이라 10100을 중지하지 않았습니다.', 409);
        return {};
      },
      describe: () => ({
        impact: '활성 OCX 작업이 0개일 때 10100 서비스만 중지합니다.',
        warnings: ['Web GPT, Native Codex, Codex route와 Workspace MCP는 변경하지 않습니다.'],
        rollback: '다시 연결하려면 새 미리보기 후 upstream-only 시작을 실행합니다.'
      }),
      command: () => ocxCommand(['service', 'stop']),
      verify: (state, _args, _before, result) => Boolean(result.ok && !state.healthy)
    },
    'account.switch': {
      title: '기본 GPT 계정 전환',
      kind: 'account',
      readState: options.getAccountStatus,
      snapshot: accountSnapshot,
      prepare(args, state) {
        const target = resolveAccount(args?.selector, state);
        return { selector: target.account, targetIndex: target.index ?? null };
      },
      describe: args => ({
        impact: `기본 GPT Desktop을 닫고 ${args.selector} 계정으로 인증을 바꾼 뒤 다시 실행합니다.`,
        warnings: ['기본 GPT Desktop이 재시작됩니다.', '계정별로 따로 실행한 GPT Desktop 창은 건드리지 않습니다.'],
        rollback: '전환 또는 재실행이 실패하면 포함된 Account Manager가 기존 인증을 복구합니다. 사후 확인이 다르면 AICC도 이전 계정 복귀를 시도합니다.'
      }),
      command: args => accountSwitchCommand(args.selector),
      verify: (state, args, _before, result) => Boolean(result.ok && state.activeAccount === args.selector),
      rollback: (before, after) => {
        const previous = before.activeAccount;
        if (!previous || after.activeAccount === previous) return null;
        return accountSwitchCommand(previous);
      }
    },
    'ocx.account.use': {
      title: 'OCX 라우팅 계정 전환',
      kind: 'account',
      readState: options.getOcxAccountStatus,
      snapshot: ocxAccountSnapshot,
      prepare(args, state) {
        const target = resolveOcxAccount(args?.selector, state);
        return { selector: target.id, label: target.label, email: target.email, plan: target.plan };
      },
      describe: args => ({
        impact: `${args.label || args.email || args.selector} 계정을 새 OCX 작업의 기본 라우팅 계정으로 선택합니다.`,
        warnings: ['이미 실행 중인 작업은 시작할 때 선택된 계정을 계속 사용합니다.', '토큰이나 로그인 파일은 복사하지 않습니다.'],
        rollback: '검증에 실패하면 미리보기 전의 OCX 활성 계정으로 되돌립니다.'
      }),
      command: args => ocxCommand(['account', 'use', 'openai', args.selector]),
      verify: (state, args, _before, result) => Boolean(result.ok && state.activeId === args.selector),
      rollback: before => before.activeId
        ? ocxCommand(['account', 'use', 'openai', before.activeId])
        : null
    },
    'ocx.account.import-cm': {
      title: '지정 계정 OAuth를 OCX에 적용',
      kind: 'account',
      timeoutMs: 4 * 60 * 1000,
      readState: options.getOcxAccountStatus,
      snapshot: ocxAccountSnapshot,
      prepare(_args, state) {
        if (!['ready', 'degraded'].includes(state?.state)) {
          throw new ActionError('ocx_accounts_unavailable', 'OCX 계정 풀을 확인할 수 없습니다.', 409);
        }
        return {};
      },
      describe: () => ({
        impact: 'AICC에 지정된 cm OAuth를 명시된 OCX 슬롯에 추가하거나 최신 버전으로 교체한 뒤 정상 백그라운드 서비스로 복귀합니다.',
        warnings: ['현재 OCX 연결이 잠깐 끊기므로 진행 중인 모델 응답이 없을 때 실행하세요.', '기존 슬롯 갱신은 이메일과 ChatGPT 계정 ID가 모두 일치할 때만 허용됩니다.', 'import gate는 일회성 프로세스에만 켜지며 서비스 설정에는 저장하지 않습니다.'],
        rollback: '실패 시 native API로 기존 자격증명을 되살리고, 필요하면 보존한 OCX 파일 스냅샷을 복원한 뒤 원래 활성 계정과 gate 없는 서비스를 복구합니다.'
      }),
      command: options.ocxImportCommand ?? defaultOcxImportCommand,
      verify: (state, _args, before, result) => Boolean(
        result.ok
        && state.activeId === before.activeId
        && [before.accounts.length, before.accounts.length + 1].includes(state.accounts.length)
        && !state.accounts.some(account => account.needsReauth)
      )
    },
    'openai.provider.set': {
      title: 'OpenAI API 전체 상태 변경',
      kind: 'provider',
      readState: options.getOpenaiProviderStatus,
      snapshot: openaiProviderSnapshot,
      prepare(args) {
        if (typeof args?.enabled !== 'boolean') throw new ActionError('enabled_required', 'API 활성화 상태가 필요합니다.');
        return { enabled: args.enabled };
      },
      describe: args => ({
        impact: `AICC를 통과하는 OpenAI API 호출을 전체 ${args.enabled ? '허용' : '차단'}합니다.`,
        warnings: args.enabled ? ['모델별 허용과 프로젝트 예산은 계속 적용됩니다.'] : ['AICC를 사용하는 모든 프로젝트의 새 API 호출이 즉시 차단됩니다.'],
        rollback: '같은 화면에서 새 미리보기를 만든 뒤 이전 상태로 되돌릴 수 있습니다.'
      }),
      command: args => openaiCommand(['provider', '--enabled', String(args.enabled)]),
      verify: (state, args, _before, result) => Boolean(result.ok && state.enabled === args.enabled),
      rollback: before => openaiCommand(['provider', '--enabled', String(before.enabled)])
    },
    'openai.model.set': {
      title: 'OpenAI 모델 허용 정책 변경',
      kind: 'provider',
      readState: options.getOpenaiProviderStatus,
      snapshot: openaiProviderSnapshot,
      prepare(args, state) {
        const current = state.models.find(item => item.id === args?.model);
        if (!current) throw new ActionError('model_not_found', '공식 무료 모델 목록에서 대상을 찾지 못했습니다.');
        if (current.lifecycle === 'retired') throw new ActionError('model_retired', '종료된 모델은 활성화할 수 없습니다.', 409);
        if (typeof args.callEnabled !== 'boolean' || typeof args.agentSelectable !== 'boolean') throw new ActionError('model_policy_required', '모델 호출과 에이전트 선택 상태가 모두 필요합니다.');
        return { model: current.id, callEnabled: args.callEnabled, agentSelectable: args.callEnabled && args.agentSelectable };
      },
      describe: args => ({
        impact: `${args.model}의 API 호출을 ${args.callEnabled ? '허용' : '차단'}하고, 에이전트 자동 선택을 ${args.agentSelectable ? '허용' : '차단'}합니다.`,
        warnings: ['사용자가 명시적으로 선택한 호출과 에이전트 자동 선택을 구분해 적용합니다.'],
        rollback: '변경 전 모델 정책으로 자동 복구할 수 있습니다.'
      }),
      command: args => openaiCommand(['model', '--model', args.model, '--call-enabled', String(args.callEnabled), '--agent-selectable', String(args.agentSelectable)]),
      verify: (state, args, _before, result) => Boolean(result.ok && state.models[args.model]?.callEnabled === args.callEnabled && state.models[args.model]?.agentSelectable === args.agentSelectable),
      rollback: (before, _after, args) => openaiCommand(['model', '--model', args.model, '--call-enabled', String(before.models[args.model].callEnabled), '--agent-selectable', String(before.models[args.model].agentSelectable)])
    },
    'openai.default-model.set': {
      title: 'OpenAI 기본 모델 변경',
      kind: 'provider',
      readState: options.getOpenaiProviderStatus,
      snapshot: openaiProviderSnapshot,
      prepare(args, state) {
        const target = state.models.find(item => item.id === args?.model);
        if (!target) throw new ActionError('model_not_found', '공식 무료 모델 목록에서 대상을 찾지 못했습니다.');
        if (!target.callEnabled || !target.agentSelectable) throw new ActionError('model_not_selectable', 'API와 에이전트 선택이 모두 허용된 모델만 기본값으로 지정할 수 있습니다.', 409);
        return { model: target.id };
      },
      describe: args => ({
        impact: `모델을 생략한 AICC 에이전트 호출의 기본값을 ${args.model}로 바꿉니다.`,
        warnings: ['기존 프로젝트가 모델을 명시한 경우에는 영향을 주지 않습니다.'],
        rollback: '변경 전 기본 모델로 자동 복구할 수 있습니다.'
      }),
      command: args => openaiCommand(['default-model', '--model', args.model]),
      verify: (state, args, _before, result) => Boolean(result.ok && state.defaultModel === args.model),
      rollback: before => openaiCommand(['default-model', '--model', before.defaultModel])
    },
    'openai.model.probe': {
      title: 'OpenAI 모델 실제 연결 확인',
      kind: 'diagnostic',
      timeoutMs: 60_000,
      readState: options.getOpenaiProviderStatus,
      snapshot: openaiProbeSnapshot,
      prepare(args, state) {
        const target = state.models.find(item => item.id === args?.model);
        if (!target || target.lifecycle === 'retired') throw new ActionError('model_not_found', '확인할 수 있는 무료 대상 모델이 아닙니다.');
        if (!state.enabled) throw new ActionError('provider_disabled', '먼저 OpenAI API 전체 사용을 켜야 합니다.', 409);
        return { model: target.id };
      },
      describe: args => ({
        impact: `${args.model}에 비민감 고정 문장으로 최소 Responses API 요청을 보내 실제 계정 접근을 확인합니다.`,
        warnings: ['소량의 입력·출력 토큰을 사용하며 공식 Usage 대시보드 반영에는 지연이 있을 수 있습니다.'],
        rollback: '확인 요청과 사용 토큰은 되돌릴 수 없지만 모델 허용 정책은 변경하지 않습니다.'
      }),
      command: args => openaiCommand(['probe', '--model', args.model]),
      verify: (state, args, before, result) => Boolean(result.ok && state.availability[args.model]?.checkedAt && state.availability[args.model]?.checkedAt !== before.availability[args.model]?.checkedAt)
    },
    'openai.catalog.probe-all': {
      title: 'OpenAI 계정 무료 모델 전수 확인',
      kind: 'diagnostic',
      timeoutMs: 15 * 60_000,
      readState: options.getOpenaiProviderStatus,
      snapshot: openaiCatalogSnapshot,
      prepare(_args, state) {
        if (!state.enabled) throw new ActionError('provider_disabled', '먼저 OpenAI API 전체 사용을 켜야 합니다.', 409);
        return {};
      },
      describe: () => ({
        impact: '현재 계정 Data Controls에 표시되었거나 Usage에서 incentive 귀속이 확인된 모델에만 고정 비민감 문장으로 최소 요청을 순차 전송하고 성공·실패·사용 token·응답 시간을 기록합니다.',
        warnings: ['실제 API token을 사용합니다.', '계정 화면이 기타 모델은 과금된다고 명시하므로 전역 후보 30개를 무조건 호출하지 않습니다.', '전수 확인 중에도 90% 선제 정지와 프로젝트 예산이 적용됩니다.'],
        rollback: '사용 token은 되돌릴 수 없지만 provider 정책은 변경하지 않습니다.'
      }),
      command: () => openaiCommand(['probe-all']),
      verify: (state, _args, before, result) => Boolean(result.ok && state.probeBatch?.status === 'completed' && state.probeBatch?.id && state.probeBatch.id !== before.probeBatch?.id)
    },
    'openai.catalog.check': {
      title: 'OpenAI 공식 catalog 갱신 확인',
      kind: 'diagnostic',
      timeoutMs: 60_000,
      readState: options.getOpenaiProviderStatus,
      snapshot: openaiCatalogSnapshot,
      prepare: () => ({}),
      describe: () => ({
        impact: 'OpenAI 도움말의 무료 대상 목록과 Developer 모델 catalog를 읽어 현재 AICC snapshot과 추가·제거 차이를 계산합니다.',
        warnings: ['source code는 자동 수정하지 않고 검토 가능한 private 후보 기록만 갱신합니다.'],
        rollback: '진단 기록만 갱신하므로 별도 rollback이 필요하지 않습니다.'
      }),
      command: () => openaiCommand(['catalog-check']),
      verify: (state, _args, before, result) => Boolean(result.ok && state.catalogCheckedAt && state.catalogCheckedAt !== before.catalogCheckedAt)
    },
    'openai.agent-guard.apply': {
      title: 'Codex OpenAI API 우회 방지 적용',
      kind: 'security',
      timeoutMs: 60_000,
      readState: options.getOpenaiAgentGuardStatus,
      snapshot: openaiAgentGuardSnapshot,
      prepare: () => ({}),
      describe: () => ({
        impact: 'Codex App과 분리 계정 config에서 OpenAI key 환경변수를 제외하고, direct api.openai.com 및 Keychain 직접 조회를 차단하는 managed PreToolUse hook를 적용합니다.',
        warnings: ['새 Codex 작업부터 확실히 적용됩니다.', '사용자가 Codex 밖에서 직접 실행하는 프로그램은 차단하지 않습니다.', '기존 requirements.toml이 AICC 소유가 아니면 덮어쓰지 않고 실패합니다.'],
        rollback: 'AICC private backup의 기존 config와 requirements를 복원합니다.'
      }),
      command: () => openaiCommand(['agent-guard', '--action', 'apply']),
      verify: (state, _args, _before, result) => Boolean(result.ok && state.ok && state.guardedCount === state.scopeCount),
      rollback: () => openaiCommand(['agent-guard', '--action', 'rollback'])
    },
    'design-sources.apply': {
      title: '디자인 원본 선택 업데이트',
      kind: 'source-update',
      timeoutMs: 45 * 60_000,
      readState: options.getDesignSourcesStatus,
      snapshot: designSourceSnapshot,
      prepare(args, state) {
        try { return normalizeDesignSourceSelection(args, state); }
        catch (error) { throw new ActionError('design_source_selection_invalid', error.message, 409); }
      },
      describe: (selection, state) => {
        const lookup = new Map(state.sources.map(source => [source.id, source]));
        const labels = selection.ids.map(id => lookup.get(id)?.id ?? id);
        const changed = selection.ids.filter(id => lookup.get(id)?.activeRevision !== selection.targets[id]);
        return {
          impact: `${labels.length}개 원본을 exact commit 스냅샷으로 준비하고, 검증을 모두 통과하면 ${changed.length}개 활성 참조를 한 번에 갱신합니다.`,
          warnings: [
            '저장소의 hook, installer, daemon, provider 설정은 실행하지 않습니다.',
            '원본은 owner-local 상태 영역에만 저장되고 open-AICC 공개 배포물에는 포함되지 않습니다.',
            '라이선스가 UNKNOWN인 Logo Creator는 로컬 참고만 허용되며 코드나 자산을 배포물에 복사하지 않습니다.'
          ],
          rollback: '전환 전 활성 커밋은 그대로 보존되며 검증 실패 시 각 원본의 이전 활성 참조로 복원합니다.'
        };
      },
      command: selection => ({
        executable: process.execPath,
        args: [designSourceCommand, 'apply', JSON.stringify(selection)],
        env: designSourceEnvironment
      }),
      verify: (state, selection, _before, result) => Boolean(result.ok && selection.ids.every(id => {
        const source = state.sources.find(item => item.id === id);
        return source?.activeRevision === selection.targets[id] && source.integrity === 'verified';
      })),
      rollback: before => ({
        executable: process.execPath,
        args: [designSourceCommand, 'restore', JSON.stringify(Object.fromEntries(before.sources.map(source => [source.id, source.activeRevision])))],
        env: designSourceEnvironment
      })
    },
    'project-service.start': {
      title: '프로젝트 사이트 켜기',
      kind: 'project-lifecycle',
      timeoutMs: 90_000,
      verifyAttempts: 8,
      verifyDelayMs: 500,
      readState: options.getProjectServicesStatus,
      snapshot: projectServicesSnapshot,
      prepare(args, state) {
        try { return selectProjectService(args, state, 'running'); }
        catch (error) { throw new ActionError('project_service_start_blocked', error.message, 409); }
      },
      describe: (args, state) => {
        const project = state.projects.find(item => item.id === args.id);
        return {
          impact: `${project?.id || args.id}의 앱과 worker를 먼저 준비하고 health 확인 뒤 tunnel을 연결합니다.`,
          warnings: ['Workspace, OCX, Web GPT와 다른 프로젝트 서비스는 변경하지 않습니다.', '일부 기동에 실패하면 이번 실행에서 시작한 묶음을 다시 중지합니다.'],
          rollback: '기동 전 상태로 돌아가도록 이 프로젝트 묶음만 역순으로 종료합니다.'
        };
      },
      command: args => ({ executable: process.execPath, args: [projectServiceCommand, 'start', args.id], env: projectServiceEnvironment }),
      verify: (state, args, _before, result) => Boolean(result.ok && state.projects.find(item => item.id === args.id)?.state === 'running'),
      rollback: (_before, _after, args) => ({ executable: process.execPath, args: [projectServiceCommand, 'stop', args.id], env: projectServiceEnvironment })
    },
    'project-service.stop': {
      title: '프로젝트 사이트 끄기',
      kind: 'project-lifecycle',
      timeoutMs: 90_000,
      verifyAttempts: 8,
      verifyDelayMs: 500,
      readState: options.getProjectServicesStatus,
      snapshot: projectServicesSnapshot,
      prepare(args, state) {
        try { return selectProjectService(args, state, 'stopped'); }
        catch (error) { throw new ActionError('project_service_stop_blocked', error.message, 409); }
      },
      describe: (args, state) => {
        const project = state.projects.find(item => item.id === args.id);
        return {
          impact: `${project?.id || args.id}의 새 외부 진입을 먼저 닫고 앱과 worker를 정상 종료합니다.`,
          warnings: ['활성 사이트 연결을 다시 확인하며 하나라도 있으면 실행하지 않습니다.', 'SIGKILL을 사용하지 않고 정상 종료가 확인되지 않으면 중단합니다.'],
          rollback: '종료 또는 검증에 실패하면 이 프로젝트 묶음을 시작 순서대로 다시 준비합니다.'
        };
      },
      command: args => ({ executable: process.execPath, args: [projectServiceCommand, 'stop', args.id], env: projectServiceEnvironment }),
      verify: (state, args, _before, result) => Boolean(result.ok && state.projects.find(item => item.id === args.id)?.state === 'stopped'),
      rollback: (_before, _after, args) => ({ executable: process.execPath, args: [projectServiceCommand, 'start', args.id], env: projectServiceEnvironment })
    }
  };
}

export function createActionController(options = {}) {
  const stateRoot = options.stateRoot
    ?? process.env.AICC_STATE_ROOT?.trim()
    ?? path.join(os.homedir(), '.ai-control-center');
  const previewsRoot = path.join(stateRoot, 'previews');
  const lockPath = path.join(stateRoot, 'action.lock');
  const now = options.now ?? (() => Date.now());
  const runner = options.runCommand ?? runCommand;
  const definitions = buildDefinitions({
    ...options,
    stateRoot,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    getOcxStatus: options.getOcxStatus ?? (() => ocxStatus(options.ocx)),
    getCodexRouteStatus: options.getCodexRouteStatus ?? (() => codexRouteStatus(options.codexRoutes)),
    getAccountStatus: options.getAccountStatus ?? (() => accountStatus(options.accounts)),
    getOcxAccountStatus: options.getOcxAccountStatus ?? (() => ocxAccountStatus(options.ocxAccounts)),
    getOpenaiProviderStatus: options.getOpenaiProviderStatus ?? (() => openaiProviderStatus({ env: { ...process.env, AICC_STATE_ROOT: stateRoot } })),
    getOpenaiAgentGuardStatus: options.getOpenaiAgentGuardStatus ?? (() => openaiAgentGuardStatus({ stateRoot })),
    getDesignSourcesStatus: options.getDesignSourcesStatus ?? (() => designSourcesStatus({ stateRoot })),
    getProjectServicesStatus: options.getProjectServicesStatus ?? (() => projectServicesStatus(options.projectServices)),
    getCodexCliUpdateStatus: options.getCodexCliUpdateStatus ?? (() => codexCliUpdateStatus({
      codexHome: options.appCodexHome,
      codexExecutable: options.codexExecutable,
      npmExecutable: options.npmExecutable,
      runCommand: options.runCommand,
      inspectWork: options.inspectCodexWork
    })),
    getAiccRecoveryStatus: options.getAiccRecoveryStatus ?? (() => aiccRecoveryStatus({ stateRoot }))
  });

  function list() {
    return Object.entries(definitions).map(([name, definition]) => ({
      name,
      title: definition.title,
      kind: definition.kind
    }));
  }

  function previewPath(token) {
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) {
      throw new ActionError('invalid_confirmation', '확인 토큰 형식이 올바르지 않습니다.');
    }
    return path.join(previewsRoot, `${stableFingerprint(token)}.json`);
  }

  function cleanupExpiredPreviews() {
    let entries = [];
    try { entries = fs.readdirSync(previewsRoot, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const candidate = path.join(previewsRoot, entry.name);
      try {
        const record = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (!Number.isFinite(record.expiresAt) || record.expiresAt <= now()) fs.unlinkSync(candidate);
      } catch { /* leave unknown files untouched */ }
    }
  }

  async function preview(name, args = {}) {
    const definition = definitions[name];
    if (!definition) throw new ActionError('action_not_allowed', '허용되지 않은 작업입니다.', 404);
    const state = await definition.readState(args);
    const canonicalArgs = definition.prepare(args, state);
    const snapshot = definition.snapshot(state);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now() + (options.previewLifetimeMs ?? previewLifetimeMs);
    const record = {
      schemaVersion: 1,
      action: name,
      args: canonicalArgs,
      before: snapshot,
      fingerprint: stableFingerprint({ action: name, args: canonicalArgs, state: snapshot }),
      createdAt: now(),
      expiresAt
    };
    ensurePrivateDirectory(previewsRoot);
    cleanupExpiredPreviews();
    fs.writeFileSync(previewPath(token), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return sanitize({
      ok: true,
      action: name,
      title: definition.title,
      args: canonicalArgs,
      current: snapshot,
      ...definition.describe(canonicalArgs, snapshot),
      confirmationToken: token,
      expiresAt: new Date(expiresAt).toISOString()
    });
  }

  function acquireLock(action) {
    ensurePrivateDirectory(stateRoot);
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, action, startedAt: new Date(now()).toISOString() })}\n`);
      fs.closeSync(descriptor);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new ActionError('action_busy', '다른 변경 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요.', 409);
      }
      throw error;
    }
    return () => {
      try { fs.unlinkSync(lockPath); } catch { /* lock recovery is documented */ }
    };
  }

  async function execute(confirmationToken) {
    const token = String(confirmationToken ?? '').trim();
    const file = previewPath(token);
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw new ActionError('confirmation_not_found', '확인 토큰이 없거나 이미 사용되었습니다.', 404);
      throw new ActionError('invalid_confirmation', '확인 기록을 읽을 수 없습니다. 새로 미리보세요.');
    }
    if (record.expiresAt <= now()) {
      try { fs.unlinkSync(file); } catch { /* no-op */ }
      throw new ActionError('confirmation_expired', '확인 시간이 지났습니다. 새로 미리보세요.', 409);
    }
    const definition = definitions[record.action];
    if (!definition) throw new ActionError('action_not_allowed', '허용되지 않은 작업입니다.', 404);

    const release = acquireLock(record.action);
    try {
      fs.unlinkSync(file);
      const beforeState = await definition.readState(record.args);
      const before = definition.snapshot(beforeState);
      const fingerprint = stableFingerprint({ action: record.action, args: record.args, state: before });
      if (fingerprint !== record.fingerprint) {
        throw new ActionError('stale_preview', '현재 상태가 미리보기 이후 달라졌습니다. 다시 미리보세요.', 409);
      }

      const command = definition.command(record.args, before);
      const commandResult = await runner(command.executable, command.args, {
        timeoutMs: definition.timeoutMs ?? options.timeoutMs ?? 120_000,
        maxBytes: 256_000,
        cwd: command.cwd,
        env: command.env
      });
      let afterState = await definition.readState(record.args);
      let after = definition.snapshot(afterState);
      let verified = definition.verify(after, record.args, before, commandResult);
      const verifyAttempts = commandResult.ok ? (definition.verifyAttempts ?? 1) : 1;
      for (let attempt = 1; !verified && attempt < verifyAttempts; attempt += 1) {
        const delayMs = options.verifyDelayMs ?? definition.verifyDelayMs ?? 0;
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        afterState = await definition.readState(record.args);
        after = definition.snapshot(afterState);
        verified = definition.verify(after, record.args, before, commandResult);
      }
      let rollback = { attempted: false, restored: false };

      if (!verified && definition.rollback) {
        const rollbackCommand = definition.rollback(before, after, record.args);
        if (rollbackCommand) {
          const rollbackResult = await runner(rollbackCommand.executable, rollbackCommand.args, {
            timeoutMs: definition.timeoutMs ?? options.timeoutMs ?? 120_000,
            maxBytes: 256_000,
            cwd: rollbackCommand.cwd,
            env: rollbackCommand.env
          });
          const restoredState = definition.snapshot(await definition.readState(record.args));
          rollback = {
            attempted: true,
            commandOk: rollbackResult.ok,
            restored: stableFingerprint(restoredState) === stableFingerprint(before),
            state: restoredState
          };
        } else {
          rollback.restored = stableFingerprint(after) === stableFingerprint(before);
        }
      }

      return sanitize({
        ok: verified,
        action: record.action,
        title: definition.title,
        args: record.args,
        verified,
        command: {
          ok: commandResult.ok,
          exitCode: commandResult.exitCode,
          timedOut: commandResult.timedOut,
          durationMs: commandResult.durationMs,
          output: outputSummary(commandResult)
        },
        before,
        after,
        rollback,
        message: verified ? '작업을 실행하고 결과를 확인했습니다.' : '요청한 상태를 확인하지 못해 가능한 복구를 시도했습니다.'
      });
    } finally {
      release();
    }
  }

  return { list, preview, execute, stateRoot, lockPath };
}
