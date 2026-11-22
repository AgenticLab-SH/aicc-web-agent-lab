import { spawn, spawnSync } from 'node:child_process';
import { windowsHealthDoctor, windowsHealthRepair, printWindowsHealth } from './windows-health-repair.mjs';
import { webGptCommand } from './lib/web-gpt-command.mjs';
import readline from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActionController } from './actions.mjs';
import { runAccountCli } from './account-cli.mjs';
import { cliToolStatus, setupCliTools } from './cli-tools.mjs';
import { collectStatus } from './status.mjs';
import { webGptStatus } from './adapters/web-gpt.mjs';
import { startServer } from './server.mjs';
import { setupEnvironment } from './setup.mjs';
import { findGuidanceWorkflows, runGuidance } from './guidance.mjs';
import { runTui } from './tui.mjs';
import { runTask } from './tasks.mjs';
import { checkOpenaiCatalog } from './openai-catalog-check.mjs';
import { configureOpenaiEligibility, configureOpenaiProject, estimateOpenaiRequest, evaluateOpenaiMonitor, guardedOpenaiResponse, openaiMonitorStatus, openaiProjectStatus, openaiProviderStatus, openaiUsageStatus, probeAllOpenaiModels, recordOpenaiOfficialObservation } from './openai-usage.mjs';
import { checkAgents, deployAgents, planAgents, agentsStatus } from './agents.mjs';
import { configureLocalWorkspaceMcp, configureWorkspaceMcp, migrateWorkspaceMcpRemoteAuthority, reconcileWorkspaceMcpRoots, workspaceMcpCommand, workspaceMcpDoctor, workspaceMcpStatus, readWorkspaceMcpConfig, workspaceMcpPaths } from './workspace-mcp.mjs';
import { runWorkspaceSnapshotCommand } from './workspace-snapshots/command.mjs';
import { runWorkspaceAppSyncCommand } from './workspace-app-sync-command.mjs';
import { parseWorkspaceSubcommandOptions } from './workspace-command-options.mjs';
import { prepareWorkspaceClientConfig } from './workspace-client-config.mjs';
import { jobManagerStatus, listDurableJobs, showDurableJob } from './jobs/status.mjs';
import { createDefaultOrchestrationService, startWebGptOrchestratorMcp } from './orchestration/mcp-server.mjs';
import { extensionRegistryStatus } from './extensions/status.mjs';
import { ExtensionRegistry } from './extensions/registry.mjs';
import { runAssetCommand } from './assets/command.mjs';
import { buildCompatibilityMatrix, loadReleaseMatrix } from './compatibility/lab.mjs';
import { compatibilityStatus } from './compatibility/status.mjs';
import { backupPrivateHome, initializePrivateHome, privateHomeErasePlan, privateHomeStatus, rehearsePrivateHomeRestore } from './private-home.mjs';
import {initializeRuntimeLayout,runtimeHomeStatus} from './runtime-layout.mjs';
import { installNativeRescue, nativeRescueStatus } from './native-rescue.mjs';
import { installRouteLaunchers, routeLauncherStatus } from './codex-route-launchers.mjs';
import { codexCliRouteStatus, launchCodexCli, parseCodexRouteArguments, ocxCliAccountSelectors } from './codex-cli-routes.mjs';
import { runCheckpointHandoffCommand } from './codex-checkpoint-handoff.mjs';
import { codexCliInstallDrift } from './codex-cli-install-drift.mjs';
import { bootstrapWebGptRescueFromCdp, loginWebGptRescue, prepareWebGptRescue, startWebGptRescue, stopWebGptRescue, webGptRescueStatus } from './web-gpt-rescue.mjs';
import { armCodexDesktopQuit, armCodexDesktopRestart, inspectCodexWork, runCodexDesktopForegroundOnce } from './codex-desktop-restart.mjs';
import { inspectWindowsCodexDesktopIdentity } from './windows-codex-desktop-identity.mjs';
import { CodexTaskCallbackService, defaultDesktopCodexExecutable } from './codex-task-callback.mjs';
import { runWebGptWatchCallback } from './web-gpt-watch-callback.mjs';
import { runOcxRecoveryCommand } from './ocx-recovery-command.mjs';
import { runAiccRecoveryCommand } from './aicc-recovery-command.mjs';
import { runRestoreV2Command } from './recovery/restore-v2-command.mjs';
import { runRecoveryHandoffCommand } from './recovery-handoff-command.mjs';
import {
  acknowledgeNotification,
  armNotification,
  cancelNotification,
  inspectNotification,
  notificationStatus,
  processDueNotifications,
  sendNotification
} from './notification-command.mjs';
import { runAgenticInterventionCommand } from './agentic-intervention-command.mjs';
import { runControlReportCommand } from './control-plane-report-command.mjs';
import { WorkLedgerResumeView } from './control-plane/work-ledger.mjs';
import { runUserActionCommand } from './goals/user-action-ledger.mjs';
import { SUPERVISE_HELP, runSuperviseCommand } from './supervised-runs/cli.mjs';

const rawCommand = process.argv[2] || null;
const command = rawCommand === '--accounts' || rawCommand === '--account-status' ? 'account' : rawCommand;
const host = process.env.AICC_HOST || '127.0.0.1';
const port = Number(process.env.AICC_PORT || 4381);
const url = `http://${host}:${port}`;

function help() {
  console.log(`open-AICC (aicc)

Usage:
  aicc                  검색 가능한 대화형 메뉴 열기
  aicc menu             검색 가능한 대화형 메뉴 열기
  aicc terminal-tabs [list|sort]  Windows Terminal 탭 이름·번호순 미리보기 / 편집
  aicc setup [--check]  개인 설정 파일 생성 또는 설치 상태 점검
  aicc doctor [--json]  Native Codex·Windows sandbox·고정 AICC backend 진단
  aicc repair [--json]  기존 owner 복구 실행·검증; OCX 자동 시작과 기록 변경 없음
  aicc restore [COMPONENT] [--status|--dry-run|--apply|--reconcile|--rollback|--stop]
                       restore v2. 인자 없음은 읽기 전용 inventory이며 mutation은 exact attempt ID 필수
  aicc restore legacy --apply|--status|--dry-run
                       봉인된 구 exact-component 복구 pointer의 명시적 호환 경로
  aicc restore ocx [--status|--dry-run]
                       owner-only OCX 복구 계획만 별도로 실행
  aicc recovery-handoff status|refresh [--json]
                       Web GPT가 local write를 못 쓸 때 읽을 owner-only LATEST.md/JSON 생성
  aicc home init|status [--json]
                       AICC 홈·구성요소 릴리스 경로 관리
  aicc private-home init|status|backup|restore-rehearsal|erase-plan [--json]
                       owner-only 개인 상태 root와 복구 경계 관리
  aicc native-rescue status|install [--json]
    install --official-catalog-source RECEIPT --expected-manifest-sha256 SHA256 --expected-catalog-sha256 SHA256 [--model MODEL]
                       17841·10100과 독립된 공식 Native Codex 실행기 관리
  aicc route-launchers status|install [--json]
                       기존 호환 실행기 관리; 평상시 codex + 공유 HOME, Native/Web은 V2 profile opt-in
  aicc codex native [--route-model MODEL] [--route-effort EFFORT] [Codex 인자]
                       독립 정비용 native V2 profile 호환 실행; 평상시 명령은 codex
  aicc codex ocx [--route-model MODEL] [--route-effort EFFORT] [--account N] [Codex 인자]
                       OCX endpoint/명시 계정만 고르는 호환 실행; 미지정 model/effort/catalog는 상속
  aicc codex status [--json]
                       두 독립 CLI 경로의 로컬 실행 준비 상태 확인
  aicc codex drift [--json]
                       r2 overlay source와 등록 설치 CLI release의 파일 일치만 비교(읽기 전용)
  aicc codex accounts [--json]
  aicc codex ocx --checkpoint-dir ABSOLUTE_DIR [Codex 인자]
                       종료 시 실제 exit/PID와 이 대화만의 OCX 상태로 stop 영수증·checkpoint 생성
  aicc codex checkpoint draft --input FILE [--json]
                       --checkpoint-dir로 시작한 CLI 안에서 평문 작업 요약을 1회 저장
  aicc codex checkpoint acknowledge --session-log ABSOLUTE_ROLLOUT [--json]
  aicc codex checkpoint adopt --checkpoint FILE --result FILE --sha256 SHA256 [--json]
                       새 OCX CLI에서 고를 등록 계정 선택자 조회 (실제 접수·quota 확인 아님)
  aicc codex-desktop status [--json]
  aicc codex-desktop app-status [--json]
                       로컬 Codex 작업의 완료·활성·UNKNOWN 상태 확인
  aicc codex-desktop restart-once --expected-pid PID --expected-thread UUID --confirm-one-shot [--json]
                       모든 작업 exact-idle 뒤 Desktop을 정상 종료하고 한 번만 다시 열기
  aicc codex-desktop foreground-restart-once --expected-pid PID --expected-thread UUID --operation-id ID --result-file OWNER_RUNTIME_JSON --confirm-one-shot [--json]
                       예약 작업 없이 현재 Terminal에서 exact-idle을 기다려 정상 재시작하고 결과 기록
  aicc codex-desktop quit-once --expected-pid PID --expected-thread UUID --confirm-one-shot [--json]
                       모든 작업 exact-idle 뒤 확인창까지 처리해 Desktop을 한 번만 종료
  printf '{...}' | aicc codex-callback arm [--json]
                       owner-only terminal result와 exact task App Server callback을 한 번 결합
  aicc codex-callback complete --callback ID --result-sha256 SHA256 [--json]
                       terminal result를 검증하고 exact idle task에 한 번 전달해 완료까지 관찰
  aicc codex-callback cancel --callback ID --result-sha256 SHA256 [--reason manual_resume] [--json]
                       전달 전 callback을 exact result hash로 취소해 뒤늦은 중복 turn 방지
  aicc codex-callback inspect --callback ID [--json]
                       callback 상태와 redacted result proof 조회
  aicc web-gpt-callback wait --watch WATCH_ID --callback CALLBACK_ID [--json]
                       Observer exact turn을 저부하로 기다린 뒤 기존 Codex 작업을 한 번 재개
  aicc status [--json]  현재 구성 요소 상태 조회
  printf '{...}' | aicc report write [--json]
                       worker 상태를 strict owner-local JSON control-plane에 기록
  aicc report status [--json]
  aicc report digest [--since SHA256] [--json]
                       모델·task turn 없이 snapshot 조회와 변경 여부 판정
  aicc work-ledger status [--include-archived] [--json]
                       대화 transcript 없이 현재 작업·다음 gate·사용자 의존 항목을 재구성
  aicc user-action status [--json]
                       사용자가 아직 하지 않은 파트별 할 일을 짧은 JSON으로 조회
  printf '{...}' | aicc user-action add|complete [--json]
                       놓치면 안 되는 사용자 할 일을 누적하거나 완료 근거와 함께 제거
  aicc notify status [--verify] [--json]
                       owner-local 사용자 알림 정책과 Slack bot 신원 확인
  printf '{...}' | aicc notify arm [--json]
                       1 기록·2 2분·3 1분·4/5 즉시 정책으로 알림 등록
  printf '{...}' | aicc notify ack|cancel|inspect [--json]
                       exact project·task·event 범위로 대기 알림 확인·취소·조회
  aicc notify process-due [--json]
                       기한이 지난 알림을 단일 lease로 전달
  printf '{...}' | aicc intervene plan|arm [--json]
                       자동 경로·Computer Use·사람 개입·Slack 알림 순서를 판정
  printf '{...}' | aicc intervene prepare-computer|authorize-computer|release-computer [--json]
                       exact target·user activity·focus lease를 통과한 Computer Use 세션만 준비·검증·해제
  aicc account          시각적 GPT 계정 관리 메뉴
  aicc account status [--json]
                       기본 GPT Desktop 계정 상태
  aicc account ocx list|current [--json]
                       OCX 라우팅 계정 상태
  aicc account portal status|open [--json]
                       웹 로그인 전달 포털 확인 또는 열기
  aicc start            로컬 관리 화면 실행
  aicc open             로컬 화면을 실행하고 브라우저에서 열기
  aicc agents plan|deploy|check|status
                       AICC 정본 Codex 하위 에이전트 관리
  aicc workspace configure --surface business-full|personal-read-fetch [--include-projects-root] [--include-owner-content-roots] [--owner-unrestricted-write] [--unrestricted-local-access] [--unrestricted-windows-commands]
  aicc workspace migrate-authority|reconcile-roots|status|doctor|serve [--surface business-full|personal-read-fetch]
  aicc workspace configure-local --surface PROFILE [--source-surface PROFILE] [--alias ALIAS] [--dry-run] [--repair]
  aicc workspace doctor|serve --local --surface PROFILE
                       Business full 또는 Personal read/fetch Secure Tunnel용 Workspace MCP 관리
  aicc workspace snapshot (--request-base64 BASE64|--request-file ABSOLUTE_JSON) [--json]
                       exact Git root의 owner-only snapshot/query/change transaction 실행
  aicc workspace app-sync status [--json]
  aicc workspace app-sync plan --request-file ABSOLUTE_JSON [--json]
  aicc workspace app-sync operations --plan-file ABSOLUTE_JSON [--json]
  aicc workspace app-sync verify --plan-file ABSOLUTE_JSON --post-read-file ABSOLUTE_JSON [--json]
                       세 계정의 AICC Workspace 앱을 하나의 논리 plugin으로 조회·계획·사후 검증
  aicc job status|list|show <job-id> [--json]
                       내구 작업·attempt·산출물 상태를 읽기 전용으로 조회
  aicc orchestration status|mcp [--json]
                       Web GPT 역할 DAG 상태 조회 또는 plugin MCP stdio 실행
  aicc extension status|validate [--json]
                       공개 plugin·skill registry와 package 무결성 점검
  aicc assets status|audit [--force] [--json]
                       Project·skill·plugin·ChatGPT 통합 inventory와 저비용 drift 감사
  aicc assets import-chatgpt --file ABSOLUTE_JSON [--json]
                       검증된 visible-UI export를 owner-only registry에 반영
  aicc assets import-chatgpt-catalog --file ABSOLUTE_JSON [--json]
                       다중 계정 대화·Project·Custom GPT 요약 카탈로그를 owner-only 저장소에 반영
  aicc assets chatgpt-catalog [--account ID] [--kind KIND] [--status STATUS] [--query TEXT] [--limit N] [--cursor N] [--json]
                       원문 없이 사람이 읽을 수 있는 ChatGPT 항목 설명을 검색·페이지 조회
  aicc assets notion-pull --config ABSOLUTE_JSON [--json]
                       공식 Notion API snapshot을 읽어 Project Catalog에 반영
  aicc assets notion-priority-worker --config ABSOLUTE_JSON --operation ID --worker ID [--json]
                       승인된 priority outbox 한 건을 precondition·post-read 검증으로 처리
  aicc assets notion-asset-plan --config ABSOLUTE_JSON [--json]
                       AI Asset Registry와 local ChatGPT observation의 field-authority diff 생성
  aicc assets notion-asset-worker --config ABSOLUTE_JSON --operation ID --worker ID [--json]
                       승인된 Notion asset create/update 한 건을 exact post-read로 처리
  aicc compatibility status|matrix [--json]
                       설치·target 호환성과 격리 canary/update 상태 점검
  aicc web-gpt status|doctor|cancel-turns|recover|open-connectors
                       Codex Web GPT 상태·긴급 복구와 커넥터 확인
  aicc web-gpt rescue status|prepare|bootstrap-cdp|login|start|stop [--json]
                       17841·주 앱과 독립된 browser-only Web GPT 예비 경로
  aicc guidance plan [--target codex|claude] [--all-targets]
                       기본 Codex 또는 명시한 대상의 지침 배포 미리보기
  aicc guidance deploy [--target codex|claude] [--all-targets]
                       기본 Codex를 배포하고 미사용 선택형 대상을 안전하게 정리
  aicc guidance check [--target codex|claude] [--all-targets]
                       기본 또는 명시한 배포의 정본·manifest 정합성 검사
  aicc guidance find <query> [--limit N] [--json]
                       비등록 AICC workflow를 정본에서 검색
  aicc cli status       codex·claude·OCX CLI 연결 상태 확인
  aicc cli setup [--install-missing]
                       고정 버전 CLI 설치; 기본 Native 경로는 유지
  aicc task run <진단ID> [--json]
                       허용된 읽기 전용 진단 작업 실행
  aicc openai usage [--json]
                       무료 토큰 로컬 원장과 95% 하드 한도 확인
  aicc openai provider [--json]
                       API 전체 상태·기본 모델·허용 정책 확인
  aicc openai models [--json]

  aicc openai monitor [status|run] [--json]

  aicc openai catalog check [--json]

  aicc openai probe-all --confirm-token-use [--json]

  aicc openai eligibility set --declared 모델1,모델2 --observed 모델3 [--json]
                       공식 무료 대상 모델·가격·실계정 확인 상태 조회
  aicc openai project status [--project 이름] [--json]
                       현재 Git 프로젝트의 일일 예산과 사용량 확인
  aicc openai project set --frontier-limit 25000 --efficient-limit 250000
                       현재 프로젝트의 풀별 일일 한도 변경
  printf '질문' | aicc openai estimate [--model gpt-5.6-luna] --max-output 512
                       네트워크 호출 없이 예약량과 남은 한도 확인
  printf '질문' | aicc openai ask [--model gpt-5.6-luna] --max-output 512 [--project 이름]
                       프로젝트·전역 guard를 거쳐 운영체제 보안 저장소 키로 호출
  aicc action list      허용된 제어 작업 조회
  aicc action preview <작업> [--selector <계정>]
                       변경 내용 미리보기와 확인 토큰 발급
  aicc action execute --confirmation <토큰>
                       미리 본 작업을 한 번 실행하고 결과 확인
  ${SUPERVISE_HELP}
  aicc help             도움말

호환: cm ... = aicc account ... · aicc --accounts · aicc --account-status

Actions: codex.web-gpt.cancel-turns, codex.web-gpt.recover, codex.native.recover, codex.bridge.reconnect, ocx.start, ocx.sync, ocx.stop, account.switch, ocx.account.use, ocx.account.import-cm`);
}

async function ask(question) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await prompt.question(question)).trim(); }
  finally { prompt.close(); }
}

async function readJsonStdin(maxBytes = 16_384, label = 'notification event') {
  if (process.stdin.isTTY) throw new Error(`${label} JSON을 stdin으로 전달해야 합니다.`);
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    if (Buffer.byteLength(input, 'utf8') > maxBytes) throw new Error(`${label} JSON이 너무 큽니다.`);
  }
  try { return JSON.parse(input); }
  catch { throw new Error(`${label} JSON이 올바르지 않습니다.`); }
}

async function interactiveAction(name, suppliedArgs = {}) {
  const controller = createActionController();
  let args = { ...suppliedArgs };
  if (name === 'account.switch' && !args.selector) {
    const status = await collectStatus();
    const accountComponent = status.components.find(component => component.id === 'accounts');
    const available = (accountComponent?.accounts ?? []).filter(account => !account.expired && !account.is_app_active);
    if (!available.length) throw new Error('전환할 수 있는 다른 계정이 없습니다.');
    console.log('\n전환할 계정');
    available.forEach((account, index) => console.log(`  ${index + 1}. ${account.account} (${account.plan || '요금제 미확인'})`));
    const selected = Number(await ask('번호를 선택하세요: '));
    if (!Number.isInteger(selected) || !available[selected - 1]) throw new Error('올바른 번호를 선택하지 않았습니다.');
    args = { selector: available[selected - 1].account };
  }
  if (name === 'ocx.account.use' && !args.selector) {
    const status = await collectStatus();
    const component = status.components.find(item => item.id === 'ocx-accounts');
    const available = (component?.accounts ?? []).filter(account => !account.active && !account.needsReauth && !account.paused);
    if (!available.length) throw new Error('전환할 수 있는 다른 OCX 계정이 없습니다.');
    console.log('\n새 작업에 사용할 OCX 계정');
    available.forEach((account, index) => {
      console.log(`  ${index + 1}. ${account.label || account.email || account.id} (${account.plan || '요금제 미확인'})`);
    });
    const selected = Number(await ask('번호를 선택하세요: '));
    if (!Number.isInteger(selected) || !available[selected - 1]) throw new Error('올바른 번호를 선택하지 않았습니다.');
    args = { selector: available[selected - 1].id };
  }
  const preview = await controller.preview(name, args);
  console.log(`\n${preview.title}\n${preview.impact}`);
  for (const warning of preview.warnings ?? []) console.log(`주의: ${warning}`);
  console.log(`복구: ${preview.rollback}`);
  const answer = (await ask('실행할까요? [y/N] ')).toLocaleLowerCase();
  if (!['y', 'yes', '예'].includes(answer)) {
    console.log('취소했습니다.');
    return;
  }
  printJsonOrSummary(await controller.execute(preview.confirmationToken));
}

async function executeMenuItem(item) {
  if (item.action) return interactiveAction(item.action);
  if (item.confirm) {
    const answer = (await ask(`${item.title}을(를) 실행할까요? [y/N] `)).toLocaleLowerCase();
    if (!['y', 'yes', '예'].includes(answer)) return console.log('취소했습니다.');
  }
  const parts = item.command.split(' ');
  const executable = parts.shift();
  const invocation = executable === 'aicc'
    ? [process.execPath, [process.argv[1], ...parts]]
    : [executable, parts];
  const result = spawnSync(invocation[0], invocation[1], { stdio: 'inherit', env: process.env, cwd: process.cwd() });
  if (result.error) throw result.error;
  if (result.status && result.status !== 0) console.log(`명령이 종료 코드 ${result.status}로 끝났습니다.`);
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function printJsonOrSummary(result) {
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else if (result.confirmationToken) {
    console.log(`${result.title}\n${result.impact}`);
    for (const warning of result.warnings ?? []) console.log(`주의: ${warning}`);
    console.log(`복구: ${result.rollback}`);
    console.log(`확인 토큰: ${result.confirmationToken}`);
    console.log(`유효 시각: ${result.expiresAt}`);
  } else {
    console.log(`${result.ok ? '✓' : '!'} ${result.title}: ${result.message}`);
    if (result.command?.output) console.log(result.command.output);
  }
}

function printSetup(result) {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.ok ? '✓' : '!'} 개인 설정: ${result.file}${result.created ? ' (생성됨)' : ''}`);
  console.log(`${result.security.ok && result.syntax.ok ? '✓' : '!'} 설정 파일: ${result.syntax.detail || result.security.reason}`);
  for (const check of result.checks) {
    console.log(`${check.ok ? '✓' : check.required ? '!' : '○'} ${check.name}: ${check.detail}${check.required ? '' : ' (선택)'}`);
  }
}

function printCliStatus(result) {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const [name, state] of Object.entries(result.commands)) {
    console.log(`${state.available ? '✓' : '!'} ${name}: ${state.version || '설치되지 않음'}`);
  }
  if (result.ocxVersionSkew) {
    console.log(`! OCX 버전 불일치: 설정 ${result.ocxInstallations.configured.version} / 셸 ${result.ocxInstallations.shell.version}`);
  }
  console.log(`${result.proxyReady ? '✓' : '○'} OCX 명시 경로: ${result.proxyReady ? '준비됨' : '꺼짐/준비되지 않음'}`);
  console.log(`${result.routing.codex === 'native' ? '✓' : '!'} codex 기본 경로: ${result.routing.codex}`);
  console.log(`${result.routing.claude === 'native' ? '✓' : '!'} claude 기본 경로: ${result.routing.claude}`);
  console.log(result.note);
  if (result.installed?.length) console.log(`설치됨: ${result.installed.join(', ')}`);
  if (result.installCommand && result.missing?.length) console.log(`설치: ${result.installCommand}`);
}

function printTaskResult(result) {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.ok ? '✓' : '!'} ${result.title} (${result.durationMs}ms)`);
  if (result.result !== null && result.result !== undefined) {
    console.log(typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2));
  }
}

function openBrowser(target) {
  const platformCommand = process.platform === 'darwin'
    ? ['open', [target]]
    : process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', 'start', '', target]]
      : ['xdg-open', [target]];
  const child = spawn(platformCommand[0], platformCommand[1], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

async function isReachable(target) {
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(800), cache: 'no-store' });
    return response.ok;
  } catch { return false; }
}

async function main() {
  if (command === 'terminal-tabs') {
    if (process.platform !== 'win32') throw new Error('Windows Terminal 탭 정리는 Windows PC 전용입니다.');
    const args = process.argv.slice(3);
    const presets = { list: ['-Action', 'List', '-AsJson'], sort: ['-Action', 'Sort', '-AsJson'] };
    if (args.length > 1 || (args.length && !['list', 'sort'].includes(args[0]))) {
      throw new Error('사용법: aicc terminal-tabs [list|sort]');
    }
    const script = fileURLToPath(new URL('../tools/platform/windows/Invoke-AiccTerminalTabs.ps1', import.meta.url));
    const shell = path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-File', script, ...(presets[args[0]] ?? [])], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  if (command === 'doctor' || command === 'repair') {
    const allowed = new Set(['--json', '--background']);
    for (const arg of process.argv.slice(3)) if (!allowed.has(arg)) throw new Error(`알 수 없는 진단 옵션: ${arg}`);
    const result = command === 'doctor' ? await windowsHealthDoctor() : await windowsHealthRepair({ background: process.argv.includes('--background') });
    printWindowsHealth(result, process.argv.includes('--json'));
    if (result.ok === false) process.exitCode = 1;
    return;
  }
  if (!command || command === 'menu') {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      await runTui({ execute: executeMenuItem });
    } else help();
    return;
  }
  if (command === 'restore') {
    const target = process.argv[3];
    let result;
    if (target === 'ocx') result = runOcxRecoveryCommand(process.argv.slice(4));
    else if (target === 'legacy') {
      const legacyArgs = process.argv.slice(4);
      if (legacyArgs.length === 1 && legacyArgs[0] === '--apply') result = runAiccRecoveryCommand([]);
      else if (legacyArgs.length === 1 && ['--status', '--dry-run', '--help', '-h'].includes(legacyArgs[0])) {
        result = runAiccRecoveryCommand(legacyArgs);
      } else throw new Error('legacy restore requires one explicit --apply, --status, --dry-run, or --help mode');
    } else result = await runRestoreV2Command(process.argv.slice(3));
    if (result.output) process.stdout.write(result.output);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  if (command === 'recovery-handoff') {
    const execution = await runRecoveryHandoffCommand(process.argv.slice(3));
    process.stdout.write(execution.output);
    process.exitCode = execution.exitCode;
    return;
  }
  if (command === 'account') {
    const args = rawCommand === '--account-status' ? ['status', '--json'] : process.argv.slice(3);
    if (args[0] === 'ocx' && args[1] === 'use') {
      const selector = args[2];
      if (!selector) throw new Error('사용할 OCX 계정 ID가 필요합니다.');
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await interactiveAction('ocx.account.use', { selector });
      } else {
        const preview = await createActionController().preview('ocx.account.use', { selector });
        printJsonOrSummary(preview);
      }
      return;
    }
    const code = await runAccountCli(args);
    if (code !== 0) process.exitCode = code;
    return;
  }
  if (command === 'setup') {
    const result = await setupEnvironment({ checkOnly: process.argv.includes('--check') });
    printSetup(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if(command==='home'){
    const action=process.argv[3]||'status';
    if(!['init','status'].includes(action))throw new Error('aicc home init|status [--json]');
    const result=action==='init'?initializeRuntimeLayout():runtimeHomeStatus();
    console.log(process.argv.includes('--json')?JSON.stringify(result,null,2):`AICC home: ${result.root}`);return;
  }
  if (command === 'private-home') {
    const subcommand = process.argv[3] || 'status';
    if (subcommand === 'restore-rehearsal' && !optionValue('--backup')) throw new Error('--backup 절대 경로가 필요합니다.');
    const result = subcommand === 'init' ? initializePrivateHome()
      : subcommand === 'status' ? privateHomeStatus()
        : subcommand === 'backup' ? backupPrivateHome({ label: optionValue('--label') || undefined, destination: optionValue('--destination') || undefined })
          : subcommand === 'restore-rehearsal' ? rehearsePrivateHomeRestore({ backup: optionValue('--backup') })
            : subcommand === 'erase-plan' ? privateHomeErasePlan()
              : null;
    if (!result) throw new Error(`알 수 없는 private-home 명령: ${subcommand}`);
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.ok ? '✓' : '!'} Private Home ${subcommand}: ${result.root ?? result.destination ?? `${result.verified ?? 0}개 검증`}`);
    if (result.ok === false) process.exitCode = 1;
    return;
  }
  if (command === 'native-rescue') {
    const subcommand = process.argv[3] || 'status';
    const result = subcommand === 'status' ? nativeRescueStatus()
      : subcommand === 'install' ? installNativeRescue({
        officialCatalogSourceReceipt: optionValue('--official-catalog-source'),
        expectedManifestSha256: optionValue('--expected-manifest-sha256') ?? undefined,
        expectedCatalogSha256: optionValue('--expected-catalog-sha256') ?? undefined,
        model: optionValue('--model') ?? undefined
      })
        : null;
    if (!result) throw new Error(`알 수 없는 native-rescue 명령: ${subcommand}`);
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.ok ? '✓' : '!'} Native rescue ${result.state}: ${result.destination}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'route-launchers') {
    const subcommand = process.argv[3] || 'status';
    const result = subcommand === 'status' ? routeLauncherStatus()
      : subcommand === 'install' ? await installRouteLaunchers()
        : null;
    if (!result) throw new Error(`알 수 없는 route-launchers 명령: ${subcommand}`);
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.ok ? '✓' : '!'} Codex route launchers ${result.state}: default=${result.defaultCodex.native ? 'Native' : result.defaultCodex.endpoint}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'codex') {
    const subcommand = process.argv[3] || 'status';
    if (subcommand === 'checkpoint') {
      const result = runCheckpointHandoffCommand(process.argv.slice(4));
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`Checkpoint ${result.state} · exact ${result.threadId}`);
      return;
    }
    if (subcommand === 'drift') {
      const result = codexCliInstallDrift();
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`${result.state} · 설치 release ${result.installedRelease ?? '미확인'} · 미반영 ${result.pendingCount ?? '?'}개`);
        for (const row of result.files ?? []) if (row.state !== 'same') console.log(`  ${row.state}: ${row.path}`);
      }
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (subcommand === 'accounts') {
      const result = ocxCliAccountSelectors();
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else for (const row of result.accounts) console.log(`${row.label}${row.paused ? ' · 일시 정지' : ''}`);
      return;
    }
    if (subcommand === 'status') {
      const result = codexCliRouteStatus();
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`${result.routes.native.ready ? '✓' : '!'} Native Codex CLI: ${result.routes.native.ready ? '준비됨' : '준비 필요'}`);
        console.log(`${result.routes.ocx.ready ? '✓' : '!'} OCX Codex CLI: ${result.routes.ocx.ready ? '준비됨' : '준비 필요'} · 자동 fallback 없음`);
      }
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!['native', 'ocx'].includes(subcommand)) throw new Error(`알 수 없는 Codex CLI 경로: ${subcommand}`);
    const selection = parseCodexRouteArguments(process.argv.slice(4));
    const result = await launchCodexCli(subcommand, selection.args, { model: selection.model ?? undefined, reasoningEffort: selection.reasoningEffort ?? undefined,
      accountSelector: selection.accountSelector ?? undefined, preferredAccount: selection.preferredAccount ?? undefined, handoffCheckpoint: selection.handoffCheckpoint ?? undefined,
      checkpointDir: selection.checkpointDir ?? undefined });
    if (result.checkpoint) console.error(`Checkpoint ${result.checkpoint.state}${result.checkpoint.holds ? ' · ' + result.checkpoint.holds.join(',') : ''} · operation ${result.checkpoint.operationId}`);
    process.exitCode = result.exitCode;
    return;
  }
  if (command === 'codex-desktop') {
    const subcommand = process.argv[3] || 'status';
    if (subcommand === 'app-status') {
      const result = inspectWindowsCodexDesktopIdentity();
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`${result.ok ? '✓' : '!'} Codex Desktop app: ${result.state}; task idle is not inferred.`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (subcommand === 'status') {
      const work = inspectCodexWork();
      const result = process.platform === 'win32'
        ? { ...work, desktopApplication: inspectWindowsCodexDesktopIdentity() }
        : work;
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`${result.safe ? '✓' : '!'} Codex local work: active=${result.active.length} unknown=${result.unknown.length} complete=${result.complete.length}`);
      if (!result.safe) process.exitCode = 1;
      return;
    }
    if (subcommand === 'restart-once') {
      if (!process.argv.includes('--confirm-one-shot')) throw new Error('--confirm-one-shot이 필요합니다.');
      const result = armCodexDesktopRestart({
        expectedPid: Number(optionValue('--expected-pid')),
        expectedThreadId: optionValue('--expected-thread'),
        maxSamples: Number(optionValue('--max-samples') || 3_600)
      });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`✓ Codex Desktop 단발 재시작 예약: ${result.label}\n진행 로그: ${path.join(result.runDir, 'progress.log')}`);
      return;
    }
    if (subcommand === 'foreground-restart-once') {
      if (!process.argv.includes('--confirm-one-shot')) throw new Error('--confirm-one-shot이 필요합니다.');
      const result = runCodexDesktopForegroundOnce({
        expectedPid: Number(optionValue('--expected-pid')),
        expectedThreadId: optionValue('--expected-thread'),
        operationId: optionValue('--operation-id'),
        resultFile: optionValue('--result-file'),
        maxSamples: Number(optionValue('--max-samples') || 3_600)
      });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`${result.status === 'PASS' ? '✓' : '!'} Codex Desktop foreground 재시작: ${result.status} (${result.reason})`);
      if (result.status !== 'PASS') process.exitCode = 1;
      return;
    }
    if (subcommand === 'quit-once') {
      if (!process.argv.includes('--confirm-one-shot')) throw new Error('--confirm-one-shot이 필요합니다.');
      const result = armCodexDesktopQuit({
        expectedPid: Number(optionValue('--expected-pid')),
        expectedThreadId: optionValue('--expected-thread'),
        maxSamples: Number(optionValue('--max-samples') || 3_600)
      });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`✓ Codex Desktop 단발 종료 예약: ${result.label}\n진행 로그: ${path.join(result.runDir, 'progress.log')}`);
      return;
    }
    throw new Error(`알 수 없는 codex-desktop 명령: ${subcommand}`);
  }
  if (command === 'codex-callback') {
    const subcommand = process.argv[3] || 'inspect';
    const service = new CodexTaskCallbackService();
    if (subcommand === 'arm') {
      const input = await readJsonStdin(32_768, 'callback binding');
      const result = service.arm({
        ...input,
        manifestFile: optionValue('--manifest') || input.manifestFile,
        codexExecutable: optionValue('--codex-executable') || input.codexExecutable || defaultDesktopCodexExecutable()
      });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`✓ Terminal callback armed: ${result.callbackId}\nToken: ${result.tokenFile}\nExpires: ${result.expiresAt}`);
      return;
    }
    if (subcommand === 'complete') {
      const result = await service.complete({
        callbackId: optionValue('--callback'),
        expectedResultSha256: optionValue('--result-sha256'),
        timeoutMs: Number(optionValue('--timeout-ms') || 12 * 60 * 60_000)
      });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`✓ Terminal callback ${result.state}: ${result.callbackId} · turn ${result.turnId}`);
      return;
    }
    if (subcommand === 'cancel') {
      const result = await service.cancel({
        callbackId: optionValue('--callback'),
        expectedResultSha256: optionValue('--result-sha256'),
        reason: optionValue('--reason') || 'operator_cancelled'
      });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`✓ Terminal callback ${result.state}: ${result.callbackId}`);
      return;
    }
    if (subcommand === 'inspect') {
      const result = service.inspect({ callbackId: optionValue('--callback') });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`Terminal callback ${result.callbackId}: ${result.state} · ${result.operationId}`);
      return;
    }
    throw new Error(`알 수 없는 codex-callback 명령: ${subcommand}`);
  }
  if (command === 'web-gpt-callback') {
    const subcommand = process.argv[3] || 'wait';
    if (subcommand !== 'wait') throw new Error(`알 수 없는 web-gpt-callback 명령: ${subcommand}`);
    const result = await runWebGptWatchCallback({
      watchId: optionValue('--watch'),
      callbackId: optionValue('--callback'),
      observerUrl: optionValue('--observer-url') || undefined,
      observerTokenFile: optionValue('--observer-token-file') || undefined,
      maxWaitMs: Number(optionValue('--max-wait-ms') || 24 * 60 * 60_000),
      callbackTimeoutMs: Number(optionValue('--callback-timeout-ms') || 12 * 60 * 60_000)
    });
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.ok ? '✓' : '!'} Web GPT callback ${result.watchState}: ${result.watchId} · ${result.callback.state}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'status') {
    const status = await collectStatus();
    if (process.argv.includes('--json')) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(`open-AICC · 조회 전용 · ${status.summary.ready}/${status.summary.total} 준비됨`);
      for (const component of status.components) {
        const mark = component.state === 'ready' ? '✓' : component.state === 'offline' ? '○' : '!';
        console.log(`${mark} ${component.label}: ${component.detail}`);
      }
    }
    return;
  }
  if (command === 'report') {
    const subcommand = process.argv[3] || 'status';
    const input = subcommand === 'write' ? await readJsonStdin(16_384, 'control report') : null;
    const result = runControlReportCommand(subcommand, input, { since: optionValue('--since') });
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else if (subcommand === 'write') console.log(`✓ worker report ${result.changed ? 'recorded' : 'unchanged'}: ${result.workerId} · sequence ${result.sequence}`);
    else console.log(`control reports: workers=${Object.values(result.counts).reduce((sum, count) => sum + count, 0)} · sequence=${result.sequence} · digest=${result.digest}`);
    return;
  }
  if (command === 'supervise') {
    await runSuperviseCommand(process.argv.slice(3), { readJsonStdin });
    return;
  }
  if (command === 'work-ledger') {
    const subcommand = process.argv[3] || 'status';
    if (subcommand !== 'status') throw new Error(`알 수 없는 work-ledger 명령: ${subcommand}`);
    const result = new WorkLedgerResumeView().status({ includeArchived: process.argv.includes('--include-archived') });
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else {
      const target = result.resumeTarget ? `${result.resumeTarget.kind}:${result.resumeTarget.id} · ${result.resumeTarget.state}` : '없음';
      console.log(`AICC Work Ledger · resume=${target} · sessions=${result.summary.sessions} · blocking=${result.summary.blockingUserActions}`);
      if (result.nextGate) console.log(`next: ${result.nextGate}`);
      if (!result.ok) console.log(`! degraded sources: ${Object.entries(result.sourceHealth).filter(([,value]) => !value.ok).map(([name]) => name).join(', ')}`);
    }
    return;
  }
  if (command === 'user-action') {
    const subcommand = process.argv[3] || 'status';
    const input = ['add', 'complete'].includes(subcommand) ? await readJsonStdin(16_384, 'user action') : null;
    const result = runUserActionCommand(subcommand, input);
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else if (subcommand === 'status') console.log(`사용자 할 일 ${result.activeCount}개 · 지금 ${result.readyCount}개 · 꼭 필요 ${result.blockingCount}개 · 완료 ${result.completedCount}개`);
    else console.log(`✓ 사용자 할 일 ${subcommand === 'complete' ? '완료' : result.changed ? '기록' : '변경 없음'}: ${result.id ?? result.action?.id}`);
    return;
  }
  if (command === 'notify') {
    const subcommand = process.argv[3] || 'status';
    if (subcommand === 'status') {
      const result = await notificationStatus({ verifySlack: process.argv.includes('--verify') });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`${result.ok ? '✓' : '!'} notifications: ${result.routingProfile} · Slack ${result.slackEnabled ? 'enabled' : 'disabled'}${result.slackVerified ? ' · identity verified' : ''}`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (subcommand === 'send') {
      const result = await sendNotification(await readJsonStdin());
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`✓ 알림 등록: ${result.notification.state} · ${result.notification.eventId}`);
      return;
    }
    if (subcommand === 'arm') {
      const result = await armNotification(await readJsonStdin());
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`✓ 알림 등록: ${result.notification.state} · ${result.notification.eventId}`);
      return;
    }
    if (subcommand === 'ack') {
      const result = acknowledgeNotification(await readJsonStdin());
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`✓ 대기 알림 확인: ${result.acknowledged.length}건`);
      return;
    }
    if (subcommand === 'cancel') {
      const result = cancelNotification(await readJsonStdin());
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`✓ 알림 취소: ${result.notification.eventId}`);
      return;
    }
    if (subcommand === 'inspect') {
      const result = inspectNotification(await readJsonStdin());
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`✓ 알림 상태: ${result.notification.state} · ${result.notification.eventId}`);
      return;
    }
    if (subcommand === 'process-due') {
      const result = await processDueNotifications();
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`✓ 알림 처리: 전송 ${result.sent} · 재시도 ${result.retried} · 보류 ${result.held}`);
      return;
    }
    throw new Error(`알 수 없는 notify 명령: ${subcommand}`);
  }
  if (command === 'intervene') {
    const subcommand = process.argv[3] || 'plan';
    const result = await runAgenticInterventionCommand(subcommand, await readJsonStdin(32_768, 'intervention request'));
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`✓ 개입 판정: ${result.plan.action} · ${result.plan.reason}`);
    return;
  }
  if (command === 'guidance') {
    if (process.argv.slice(3).some(argument => argument === '--help' || argument === '-h' || argument === 'help')) {
      console.log('aicc guidance plan|deploy|check [--target codex|claude] [--all-targets]\naicc guidance find <query> [--limit N] [--json]');
      return;
    }
    const subcommand = process.argv[3] || 'check';
    if (subcommand === 'find') {
      const args = process.argv.slice(4);
      const queryParts = [];
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--json') continue;
        if (args[index] === '--limit') {
          index += 1;
          continue;
        }
        queryParts.push(args[index]);
      }
      const result = findGuidanceWorkflows(queryParts.join(' '), { limit: optionValue('--limit') ?? undefined });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else if (result.count === 0) console.log(`일치하는 비등록 workflow 없음: ${result.query}`);
      else {
        for (const match of result.matches) {
          const handoff = match.handoffs.length ? ` · handoff ${match.handoffs.map(name => `$${name}`).join(', ')}` : '';
          console.log(`${match.name} [${match.delivery}/${match.invocation}]${handoff} — ${match.description}\n  ${match.path}`);
        }
        if (result.total > result.count) console.log(`외 ${result.total - result.count}건 · --limit으로 조정`);
      }
      return;
    }
    runGuidance(subcommand, {
      target: optionValue('--target') ?? undefined,
      allTargets: process.argv.includes('--all-targets')
    });
    return;
  }
  if (command === 'agents') {
    const subcommand = process.argv[3] || 'status';
    const result = subcommand === 'plan' ? planAgents()
      : subcommand === 'deploy' ? deployAgents()
        : subcommand === 'check' ? checkAgents()
          : subcommand === 'status' ? agentsStatus()
            : null;
    if (!result) throw new Error(`알 수 없는 agents 명령: ${subcommand}`);
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.ok ? '✓' : '!'} ${result.message}`);
    if (result.ok === false) process.exitCode = 1;
    return;
  }
  if (command === 'workspace') {
    const subcommand = process.argv[3] || 'status';
    const delegated = new Set(['snapshot', 'app-sync']);
    const workspaceOptions = delegated.has(subcommand) ? null : parseWorkspaceSubcommandOptions(subcommand, process.argv.slice(4));
    if (workspaceOptions?.help) {
      console.log('Usage: aicc workspace configure --surface business-full|personal-read-fetch | prepare-client-config --surface PROFILE < owner-bindings.json | migrate-authority|status|doctor|serve [--surface PROFILE] | reconcile-roots [--surface PROFILE] [--dry-run]');
      return;
    }
    const surfaceProfile = workspaceOptions?.surfaceProfile ?? null;
    if (subcommand === 'prepare-client-config') {
      const input = await readJsonStdin(262_144, 'owner-local client bindings');
      const result = prepareWorkspaceClientConfig(input, { surfaceProfile });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (subcommand === 'configure-local') {
      const result = await configureLocalWorkspaceMcp(workspaceOptions);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (subcommand === 'configure') {
      const result = configureWorkspaceMcp({
        surfaceProfile,
        includeProjectsRoot: workspaceOptions.includeProjectsRoot,
        includeOwnerContentRoots: workspaceOptions.includeOwnerContentRoots,
        ownerUnrestrictedWrite: workspaceOptions.ownerUnrestrictedWrite,
        unrestrictedLocalAccess: workspaceOptions.unrestrictedLocalAccess,
        unrestrictedWindowsCommands: workspaceOptions.unrestrictedWindowsCommands
      });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`✓ Workspace MCP에 Git 워크스페이스 ${result.workspaceCount}개를 등록했습니다.`);
      return;
    }
    if (subcommand === 'migrate-authority') {
      const result = migrateWorkspaceMcpRemoteAuthority({ surfaceProfile });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`✓ Workspace MCP remote authority 설정을 ${result.duplicate ? '확인' : 'migration'}했습니다.`);
      return;
    }
    if (subcommand === 'reconcile-roots') {
      const result = reconcileWorkspaceMcpRoots({ surfaceProfile, dryRun: workspaceOptions.dryRun });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`✓ Workspace MCP root ${result.dryRun ? '미리보기' : result.duplicate ? '확인' : '정규화'}: ${result.workspaceCount}개 유지 · ${result.removed.length}개 제거`);
      return;
    }
    if (subcommand === 'doctor') {
      const result = await workspaceMcpDoctor({ surfaceProfile, local: workspaceOptions.local });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (subcommand === 'status') {
      const result = await workspaceMcpStatus({ surfaceProfile });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`${result.state === 'ready' ? '✓' : '!'} ${result.detail}`);
      if (result.state !== 'ready') process.exitCode = 1;
      return;
    }
    if (subcommand === 'serve') {
      const local = workspaceOptions.local;
      const config = readWorkspaceMcpConfig({ surfaceProfile, local });
      if (!config) throw new Error('먼저 aicc workspace configure를 실행해야 합니다.');
      const details = workspaceMcpCommand(config, { surfaceProfile, configPath: workspaceMcpPaths({ surfaceProfile, local }).config });
      const child = spawn(details.executable, details.args, { cwd: details.cwd, env: process.env, stdio: 'inherit', windowsHide: true });
      child.once('exit', code => { process.exitCode = code ?? 1; });
      return;
    }
    if (subcommand === 'snapshot') {
      const result = runWorkspaceSnapshotCommand(process.argv.slice(4));
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else if (result.query) console.log(`✓ workspace snapshot ${result.query.snapshotId} · cache ${result.query.cacheHit ? 'hit' : 'miss'}`);
      else if (result.bundle) console.log(`✓ portable workspace bundle ${result.bundle.snapshotId} · ${result.bundle.reused ? 'reused' : 'created'} · ${result.bundle.path}`);
      else if (result.materialized) console.log(`✓ workspace snapshot ${result.materialized.snapshotId} · CAS ${result.materialized.reused ? 'reused' : 'created'}`);
      else {
        const transaction = result.planned ?? result.applied ?? result.reconciled ?? result.rolledBack ?? result.status;
        const operationId = transaction.operationId ?? transaction.plan?.operationId;
        const phase = transaction.state?.phase ?? (result.planned ? 'PLANNED' : 'UNKNOWN');
        console.log(`✓ workspace change ${operationId} · ${phase}`);
      }
      return;
    }
    if (subcommand === 'app-sync') {
      const execution = await runWorkspaceAppSyncCommand(process.argv.slice(4));
      process.stdout.write(execution.output);
      if (execution.exitCode !== 0) process.exitCode = execution.exitCode;
      return;
    }
    throw new Error(`알 수 없는 workspace 명령: ${subcommand}`);
  }
  if (command === 'job') {
    const subcommand = process.argv[3] || 'status';
    const result = subcommand === 'status' ? jobManagerStatus()
      : subcommand === 'list' ? { ok: true, jobs: listDurableJobs() }
        : subcommand === 'show' ? showDurableJob(process.argv[4])
          : null;
    if (subcommand === 'show' && !process.argv[4]) throw new Error('조회할 job ID가 필요합니다.');
    if (!result) throw new Error(subcommand === 'show' ? '작업을 찾을 수 없습니다.' : `알 수 없는 job 명령: ${subcommand}`);
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else if (subcommand === 'status') console.log(`${result.state === 'ready' ? '✓' : '!'} ${result.detail}`);
    else if (subcommand === 'list') for (const job of result.jobs) console.log(`${job.jobId}\t${job.state}\t${job.mode}\t${job.workloadClass}`);
    else console.log(`${result.jobId}\t${result.state}\t${result.mode}\t${result.requestedRoute}`);
    if (subcommand === 'status' && result.state !== 'ready') process.exitCode = 1;
    return;
  }
  if (command === 'orchestration') {
    const subcommand = process.argv[3] || 'status';
    if (subcommand === 'status') {
      const result = createDefaultOrchestrationService().status({ runId: optionValue('--run') || undefined });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`Web GPT orchestration · run ${result.run ? result.run.runId : result.runCount} · ${result.run ? result.run.state : `active ${result.activeRuns}`}`);
      return;
    }
    if (subcommand === 'mcp') {
      await startWebGptOrchestratorMcp();
      return;
    }
    throw new Error(`알 수 없는 orchestration 명령: ${subcommand}`);
  }
  if (command === 'extension') {
    const subcommand = process.argv[3] || 'status';
    const result = subcommand === 'status' ? extensionRegistryStatus()
      : subcommand === 'validate' ? new ExtensionRegistry().validate()
        : null;
    if (!result) throw new Error(`알 수 없는 extension 명령: ${subcommand}`);
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.state === 'attention' || result.ok === false ? '!' : '✓'} ${result.detail ?? `extension ${result.extensionCount}개 검증됨`}`);
    if (result.state === 'attention' || result.ok === false) process.exitCode = 1;
    return;
  }
  if (command === 'assets') {
    const result = await runAssetCommand(process.argv.slice(3));
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else if (result.summary) console.log(`AI 자산 ${result.summary.total}개 · fingerprint ${result.fingerprint.slice(0, 12)} · 외부 쓰기 없음`);
    else if (result.imported !== undefined) console.log(`✓ ChatGPT 자산 ${result.imported}개를 owner-only registry에 반영했습니다.`);
    else if (result.saved) console.log(`✓ Notion snapshot ${result.version}을 반영했습니다.`);
    else console.log(`✓ assets ${process.argv[3] || 'status'} 완료`);
    return;
  }
  if (command === 'compatibility') {
    const subcommand = process.argv[3] || 'status';
    const result = subcommand === 'status' ? compatibilityStatus()
      : subcommand === 'matrix' ? buildCompatibilityMatrix(loadReleaseMatrix())
        : null;
    if (!result) throw new Error(`알 수 없는 compatibility 명령: ${subcommand}`);
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.state === 'attention' || result.ok === false ? '!' : '✓'} ${result.detail ?? `${result.components.length}개 component 호환 matrix`}`);
    if (result.state === 'attention' || result.ok === false) process.exitCode = 1;
    return;
  }
  if (command === 'web-gpt') {
    const subcommand = process.argv[3] || 'status';
    if (subcommand === 'rescue') {
      const rescueCommand = process.argv[4] || 'status';
      const result = rescueCommand === 'status' ? await webGptRescueStatus()
        : rescueCommand === 'prepare' ? prepareWebGptRescue({ catalogSource: optionValue('--catalog-source') })
          : rescueCommand === 'bootstrap-cdp' ? await bootstrapWebGptRescueFromCdp({
            endpoint: optionValue('--endpoint'),
            targetId: optionValue('--target-id'),
            accountAlias: optionValue('--account-alias')
          })
          : rescueCommand === 'login' ? loginWebGptRescue()
            : rescueCommand === 'start' ? await startWebGptRescue()
              : rescueCommand === 'stop' ? await stopWebGptRescue()
                : null;
      if (!result) throw new Error(`알 수 없는 web-gpt rescue 명령: ${rescueCommand}`);
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`${result.ok ? '✓' : '!'} Web GPT rescue ${result.state ?? rescueCommand}: ${result.root ?? result.label ?? ''}`);
      if (result.ok === false && rescueCommand !== 'status') process.exitCode = 1;
      return;
    }
    if (subcommand === 'status') {
      const result = await webGptStatus();
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`${result?.state === 'ready' ? '✓' : '!'} ${result?.detail || '상태를 확인할 수 없습니다.'}`);
      if (result?.state !== 'ready') process.exitCode = 1;
      return;
    }
    if (subcommand === 'doctor') {
      const descriptor = webGptCommand(['doctor', ...(process.argv.includes('--json') ? ['--json'] : [])]);
      const result = spawnSync(descriptor.executable, descriptor.args, {
        encoding: 'utf8', timeout: 75_000, windowsHide: true
      });
      if (result.error) throw result.error;
      process.stdout.write(result.stdout || '');
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.status !== 0) process.exitCode = result.status ?? 1;
      return;
    }
    if (subcommand === 'cancel-turns') {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await interactiveAction('codex.web-gpt.cancel-turns');
      } else {
        printJsonOrSummary(await createActionController().preview('codex.web-gpt.cancel-turns'));
      }
      return;
    }
    if (subcommand === 'recover') {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        await interactiveAction('codex.web-gpt.recover');
      } else {
        printJsonOrSummary(await createActionController().preview('codex.web-gpt.recover'));
      }
      return;
    }
    if (subcommand === 'open-connectors') {
      openBrowser('https://chatgpt.com/#settings/Connectors');
      console.log('ChatGPT 커넥터 설정을 여는 중입니다.');
      return;
    }
    throw new Error(`알 수 없는 web-gpt 명령: ${subcommand}`);
  }
  if (command === 'start') {
    startServer();
    return;
  }
  if (command === 'open') {
    if (!await isReachable(`${url}/healthz`)) {
      const script = fileURLToPath(new URL('./server.mjs', import.meta.url));
      const child = spawn(process.execPath, [script], {
        detached: true,
        stdio: 'ignore',
        cwd: path.dirname(script),
        env: process.env,
        windowsHide: true
      });
      child.unref();
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    openBrowser(url);
    console.log(`open-AICC를 여는 중입니다: ${url}`);
    return;
  }
  if (command === 'cli') {
    const subcommand = process.argv[3] || 'status';
    const result = subcommand === 'status'
      ? await cliToolStatus()
      : subcommand === 'setup'
        ? await setupCliTools({ installMissing: process.argv.includes('--install-missing') })
        : null;
    if (!result) throw new Error(`알 수 없는 cli 명령: ${subcommand}`);
    printCliStatus(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'task') {
    const subcommand = process.argv[3] || 'run';
    const taskId = process.argv[4];
    if (subcommand !== 'run' || !taskId) throw new Error('사용법: aicc task run <진단ID> [--json]');
    const result = await runTask(taskId);
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else printJsonOrSummary(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'openai') {
    const subcommand = process.argv[3] || 'usage';
    if (subcommand === 'usage') {
      const result = openaiUsageStatus();
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`OpenAI 무료 토큰 로컬 guard · UTC ${result.dayUtc} · ${result.keyConfigured ? '운영체제 보안 저장소 키 확인됨' : '키 없음'}`);
        for (const group of result.groups) console.log(`${group.label}: ${group.tokens.toLocaleString()} / ${group.freeLimit.toLocaleString()} token (${group.percent}%, 95% 하드 잔여 ${group.hardRemaining.toLocaleString()})`);
        console.log(result.note);
      }
      return;
    }
    if (subcommand === 'provider' || subcommand === 'models') {
      const result = openaiProviderStatus();
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else if (subcommand === 'provider') {
        console.log(`OpenAI API: ${result.enabled ? '켜짐' : '꺼짐'} · 기본 모델 ${result.defaultModel} · ${result.keyConfigured ? '운영체제 보안 저장소 키 확인됨' : '키 없음'}`);
        console.log(`에이전트 선택 가능 ${result.models.filter(model => model.agentSelectable).length}개 · 사용자 호출 가능 ${result.models.filter(model => model.callEnabled).length}개`);
      } else {
        for (const model of result.models) {
          const access = model.availability.status === 'available' ? '실호출 확인' : model.availability.status === 'unavailable' ? '호출 불가' : model.lifecycle === 'retired' ? '종료' : '미확인';
          console.log(`${model.isDefault ? '★' : model.agentSelectable ? '✓' : model.callEnabled ? '○' : '·'} ${model.id}\t${model.groupId}\t${access}\t${model.role}`);
        }
        console.log('★ 기본 · ✓ 에이전트 선택 가능 · ○ 사용자 명시 호출만 · 모델별 실제 확인은 AICC 웹의 “연결 확인”을 사용하세요.');
      }
      return;
    }
    if (subcommand === 'monitor') {
      const monitorCommand = process.argv[4] || 'status';
      let result;
      if (monitorCommand === 'status') result = openaiMonitorStatus();
      else if (monitorCommand === 'run') result = evaluateOpenaiMonitor();
      else if (monitorCommand === 'observe') result = recordOpenaiOfficialObservation({
        inputTokens: Number(optionValue('--input-tokens')),
        outputTokens: Number(optionValue('--output-tokens')),
        requests: Number(optionValue('--requests')),
        costUsd: Number(optionValue('--cost-usd') || 0),
        observedAt: optionValue('--observed-at') || undefined
      });
      else throw new Error(`알 수 없는 openai monitor 명령: ${monitorCommand}`);
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`OpenAI monitor: ${result.state} · 마지막 확인 ${result.lastEvaluatedAt || '아직 없음'}`);
        for (const group of result.groups) console.log(`${group.label}: ${group.percent}% · 경고 ${group.warningPercent}% · 자동 정지 ${group.autoPausePercent}%`);
      }
      return;
    }
    if (subcommand === 'catalog') {
      const catalogCommand = process.argv[4] || 'check';
      if (catalogCommand !== 'check') throw new Error(`알 수 없는 openai catalog 명령: ${catalogCommand}`);
      const result = await checkOpenaiCatalog();
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`OpenAI catalog: ${result.status} · 공식 ${result.counts?.official ?? '–'} · 추가 ${result.added.length} · 제거 ${result.removed.length}`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (subcommand === 'probe-all') {
      if (!process.argv.includes('--confirm-token-use')) throw new Error('계정 무료 대상 모델 전수 확인은 실제 token을 사용합니다. --confirm-token-use를 명시하세요.');
      const result = await probeAllOpenaiModels({
        onResult: (item, progress) => {
          if (!process.argv.includes('--json')) console.error(`[${progress.attempted}/${progress.total}] ${item.model}: ${item.status}${item.usage ? ` · ${item.usage.totalTokens} token` : ''}`);
        }
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (subcommand === 'eligibility') {
      const eligibilityCommand = process.argv[4] || 'status';
      if (eligibilityCommand !== 'set') throw new Error('openai eligibility는 set 명령과 --declared 목록이 필요합니다.');
      const result = configureOpenaiEligibility({
        source: optionValue('--source') || 'authenticated-account-ui',
        declaredFamilies: String(optionValue('--declared') || '').split(',').filter(Boolean),
        observedIncentiveModels: String(optionValue('--observed') || '').split(',').filter(Boolean)
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (subcommand === 'project') {
      const projectCommand = process.argv[4] || 'status';
      const project = optionValue('--project') || undefined;
      if (projectCommand === 'status') {
        const result = openaiProjectStatus({ project });
        if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`${result.project.label} · OpenAI 프로젝트 guard · UTC ${result.dayUtc}${result.customized ? ' · 사용자 한도' : ' · 기본 10% 한도'}`);
          for (const group of result.groups) console.log(`${group.label}: ${group.tokens.toLocaleString()} / ${group.limit.toLocaleString()} token (${group.percent}%, 잔여 ${group.remaining.toLocaleString()})`);
        }
        return;
      }
      if (projectCommand === 'set') {
        const result = configureOpenaiProject(project, {
          frontier: Number(optionValue('--frontier-limit')),
          efficient: Number(optionValue('--efficient-limit'))
        });
        if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`${result.project.label} 프로젝트의 OpenAI 일일 한도를 저장했습니다.`);
          for (const group of result.groups) console.log(`${group.label}: ${group.limit.toLocaleString()} token`);
        }
        return;
      }
      throw new Error(`알 수 없는 openai project 명령: ${projectCommand}`);
    }
    if (subcommand === 'ask' || subcommand === 'estimate') {
      if (process.stdin.isTTY) throw new Error('입력 내용 노출을 줄이기 위해 stdin으로 프롬프트를 전달하세요.');
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const input = Buffer.concat(chunks).toString('utf8');
      const model = optionValue('--model') || undefined;
      const maxOutputTokens = Number(optionValue('--max-output') || 512);
      const project = optionValue('--project') || undefined;
      const selectionSource = process.argv.includes('--user-selected') ? 'user' : 'agent';
      const result = subcommand === 'estimate'
        ? estimateOpenaiRequest({ model, input, maxOutputTokens, project, selectionSource })
        : await guardedOpenaiResponse({ model, input, maxOutputTokens, project, selectionSource });
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else if (subcommand === 'ask') {
        console.log(result.text);
        console.error(`\n[AICC guard] ${result.project.label} · ${result.model} · ${result.usage.totalTokens.toLocaleString()} token`);
      } else {
        console.log(`${result.project.label} · ${result.model} · 최대 예약 ${result.reservation.toLocaleString()} token`);
        console.log(`프로젝트 잔여(예약 후): ${result.project.remainingAfterReservation.toLocaleString()} / ${result.project.limit.toLocaleString()}`);
        console.log(`전역 잔여(예약 후): ${result.global.remainingAfterReservation.toLocaleString()} / ${result.global.limit.toLocaleString()}`);
      }
      return;
    }
    throw new Error(`알 수 없는 openai 명령: ${subcommand}`);
  }
  if (command === 'action') {
    const controller = createActionController();
    const actionCommand = process.argv[3] || 'list';
    if (actionCommand === 'list') {
      const actions = controller.list();
      if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: true, actions }, null, 2));
      else for (const action of actions) console.log(`${action.name}\t${action.title}`);
      return;
    }
    if (actionCommand === 'preview') {
      const actionName = process.argv[4];
      if (!actionName) throw new Error('미리 볼 작업 이름이 필요합니다.');
      printJsonOrSummary(await controller.preview(actionName, { selector: optionValue('--selector') }));
      return;
    }
    if (actionCommand === 'execute') {
      const confirmationToken = optionValue('--confirmation');
      if (!confirmationToken) throw new Error('--confirmation 토큰이 필요합니다.');
      const result = await controller.execute(confirmationToken);
      printJsonOrSummary(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    throw new Error(`알 수 없는 action 명령: ${actionCommand}`);
  }
  help();
  process.exitCode = 2;
}

main().catch(error => {
  console.error(`aicc: ${error.message}`);
  process.exitCode = 1;
});
