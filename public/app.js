import { componentPresentation, diagnosticPresentation } from './presentation.js';

const $ = selector => document.querySelector(selector);
const workspacePublicationSurfaces = Object.freeze({
  'business-full': { label: 'Business 업무 공간', taskId: 'workspace.publish-preflight' },
  'personal-read-fetch': { label: 'Personal 개인 계정 읽기 전용', taskId: 'workspace.publish-preflight.personal-read-fetch' }
});
const workspacePreflightResults = new Map();
const workspaceTargetPreferenceKey = 'aicc.workspaceTargetPreferences.v1';
const defaultWorkspaceTargetPreferences = () => ({
  version: 1,
  ports: [9222, 9223, 9224],
  targets: {
    'business-full': { account: 1, tunnelId: '' },
    'personal-read-fetch': { account: 3, tunnelId: '' }
  }
});

function normalizeWorkspaceTargetPreferences(value) {
  if (value?.version !== 1 || !Array.isArray(value.ports) || value.ports.length !== 3
      || value.ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)
      || new Set(value.ports).size !== 3) throw new Error('세 계정의 포트는 서로 다른 1024~65535 정수여야 합니다.');
  const targets = {};
  for (const surfaceProfile of Object.keys(workspacePublicationSurfaces)) {
    const target = value.targets?.[surfaceProfile];
    if (!target || ![1, 2, 3].includes(target.account) || typeof target.tunnelId !== 'string'
        || !/^(?:|tunnel_[A-Za-z0-9_-]{1,90})$/.test(target.tunnelId)) {
      throw new Error('게시 계정과 기존 Tunnel ID 형식을 확인하세요. 인증 정보는 저장할 수 없습니다.');
    }
    targets[surfaceProfile] = { account: target.account, tunnelId: target.tunnelId };
  }
  return { version: 1, ports: [...value.ports], targets };
}

let workspaceTargetPreferences;
try {
  const stored = localStorage.getItem(workspaceTargetPreferenceKey);
  workspaceTargetPreferences = stored ? normalizeWorkspaceTargetPreferences(JSON.parse(stored)) : defaultWorkspaceTargetPreferences();
} catch {
  workspaceTargetPreferences = defaultWorkspaceTargetPreferences();
}

function renderWorkspaceTargetPreferences() {
  const surfaceProfile = selectedWorkspacePublicationSurface();
  const target = workspaceTargetPreferences.targets[surfaceProfile];
  workspaceTargetPreferences.ports.forEach((port, index) => {
    $(`#workspaceAccountPort${index + 1}`).value = String(port);
  });
  $('#workspaceTargetAccount').value = String(target.account);
  $('#workspaceTargetTunnel').value = target.tunnelId;
  $('#workspaceTargetBindingState').textContent = `${workspacePublicationSurfaces[surfaceProfile].label}: ${target.account}번 계정의 선호 포트 ${workspaceTargetPreferences.ports[target.account - 1]}, 기존 Tunnel ${target.tunnelId || '미입력'}. 실제 로그인·Tunnel 소유 계정·인증 방식·수신자 범위가 확인되기 전 게시 보류입니다.`;
}

function saveWorkspaceTargetPreferences(event) {
  event.preventDefault();
  try {
    const surfaceProfile = selectedWorkspacePublicationSurface();
    const candidate = normalizeWorkspaceTargetPreferences({
      version: 1,
      ports: [1, 2, 3].map(account => Number($(`#workspaceAccountPort${account}`).value)),
      targets: {
        ...workspaceTargetPreferences.targets,
        [surfaceProfile]: {
          account: Number($('#workspaceTargetAccount').value),
          tunnelId: $('#workspaceTargetTunnel').value.trim()
        }
      }
    });
    localStorage.setItem(workspaceTargetPreferenceKey, JSON.stringify(candidate));
    workspaceTargetPreferences = candidate;
    renderWorkspaceTargetPreferences();
    $('#workspaceTargetPreferenceMessage').textContent = '이 기기의 준비 설정을 저장했습니다. 실제 계정·등록 CDP·Tunnel·원격 게시에는 적용하지 않았습니다.';
  } catch (error) {
    $('#workspaceTargetPreferenceMessage').textContent = `저장하지 않았습니다. ${error.message}`;
  }
}

function selectedWorkspacePublicationSurface() {
  const surfaceProfile = $('#workspacePublicationSurface').value;
  if (!Object.hasOwn(workspacePublicationSurfaces, surfaceProfile)) {
    throw new Error('알 수 없는 게시 대상입니다. Business 또는 Personal을 선택하세요.');
  }
  return surfaceProfile;
}

async function writeClipboardText(text) {
  const fallback = document.createElement('textarea');
  fallback.value = text;
  fallback.setAttribute('readonly', '');
  fallback.setAttribute('aria-hidden', 'true');
  fallback.className = 'clipboard-copy-fallback';
  document.body.append(fallback);
  fallback.select();
  fallback.setSelectionRange(0, fallback.value.length);
  try {
    if (document.execCommand('copy')) return 'exec-command';
  } finally {
    fallback.remove();
  }

  let clipboardTimeout;
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => {
        clipboardTimeout = window.setTimeout(() => reject(new Error('clipboard API timeout')), 1_000);
      })
    ]);
    return 'clipboard-api';
  } finally {
    window.clearTimeout(clipboardTimeout);
  }
}

const components = $('#components');
const roots = $('#stateRoots');
const summary = $('#summaryCount');
const summaryHint = $('#summaryHint');
const summaryRing = $('#summaryRing');
const summaryPercent = $('#summaryPercent');
const updatedAt = $('#updatedAt');
const componentUpdated = $('#componentUpdated');
const refresh = $('#refresh');
const accountSelector = $('#accountSelector');
const accountCards = $('#accountCards');
const switchAccount = $('#switchAccount');
const ocxAccountSelector = $('#ocxAccountSelector');
const ocxAccountCards = $('#ocxAccountCards');
const switchOcxAccount = $('#switchOcxAccount');
const actionMessage = $('#actionMessage');
const actionDialog = $('#actionDialog');
const dialogTitle = $('#dialogTitle');
const dialogImpact = $('#dialogImpact');
const dialogWarnings = $('#dialogWarnings');
const dialogRollback = $('#dialogRollback');
const confirmAction = $('#confirmAction');
const resultDialog = $('#resultDialog');
const resultTitle = $('#resultTitle');
const resultSummary = $('#resultSummary');
const resultHighlights = $('#resultHighlights');
const resultDetails = $('#resultDetails');
const resultOutput = $('#resultOutput');
const toolSearch = $('#toolSearch');
const searchResults = $('#searchResults');
const quickTools = $('#quickTools');
const toolFilters = $('#toolFilters');
const toolLibrary = $('#toolLibrary');
const openaiUsageGroups = $('#openaiUsageGroups');
const openaiUsageUpdated = $('#openaiUsageUpdated');
const openaiKeyState = $('#openaiKeyState');
const openaiGuardSummary = $('#openaiGuardSummary');
const openaiProviderState = $('#openaiProviderState');
const toggleOpenaiProvider = $('#toggleOpenaiProvider');
const openaiDefaultModel = $('#openaiDefaultModel');
const setOpenaiDefaultModel = $('#setOpenaiDefaultModel');
const openaiModelSummary = $('#openaiModelSummary');
const openaiModelFilters = $('#openaiModelFilters');
const openaiModelList = $('#openaiModelList');
const openaiActionMessage = $('#openaiActionMessage');
const ocxModules = $('#ocxModules');
const supportMessage = $('#supportMessage');
const refreshSupportBundle = $('#refreshSupportBundle');
const copySupportPrompt = $('#copySupportPrompt');
const copySupportJson = $('#copySupportJson');
const revealSupportBundle = $('#revealSupportBundle');
const supportBundleMeta = $('#supportBundleMeta');
const latestRecoveryState = $('#latestRecoveryState');
const latestRecoveryDetail = $('#latestRecoveryDetail');
const latestRecoveryTarget = $('#latestRecoveryTarget');
const latestRecoveryUpdated = $('#latestRecoveryUpdated');
const latestRecoveryButton = $('#latestRecoveryButton');
const latestRecoveryMessage = $('#latestRecoveryMessage');
const openaiMonitorState = $('#openaiMonitorState');
const openaiMonitorSummary = $('#openaiMonitorSummary');
const probeAllOpenaiModels = $('#probeAllOpenaiModels');
const checkOpenaiCatalog = $('#checkOpenaiCatalog');
const applyOpenaiAgentGuard = $('#applyOpenaiAgentGuard');
const designSourcesChecked = $('#designSourcesChecked');
const designSourceUpdateCount = $('#designSourceUpdateCount');
const designSourceMissingCount = $('#designSourceMissingCount');
const designSourceTotalSize = $('#designSourceTotalSize');
const designSourceSelectionSummary = $('#designSourceSelectionSummary');
const designSourceList = $('#designSourceList');
const designSourceMessage = $('#designSourceMessage');
const selectAllDesignSources = $('#selectAllDesignSources');
const scanDesignSourcesButton = $('#scanDesignSources');
const applyDesignSources = $('#applyDesignSources');
const monitoringUpdated = $('#monitoringUpdated');
const monitoringSignalMark = $('#monitoringSignalMark');
const monitoringSignalTitle = $('#monitoringSignalTitle');
const monitoringSignalDetail = $('#monitoringSignalDetail');
const monitoringSourceCount = $('#monitoringSourceCount');
const monitoringUpdateCount = $('#monitoringUpdateCount');
const monitoringObserverMode = $('#monitoringObserverMode');
const refreshUpstreamMonitoring = $('#refreshUpstreamMonitoring');
const monitoringMessage = $('#monitoringMessage');
const webJjonkuConfigStatus = $('#webJjonkuConfigStatus');
const webJjonkuConfigForm = $('#webJjonkuConfigForm');
const webJjonkuConfigMessage = $('#webJjonkuConfigMessage');
const webJjonkuLastRun = $('#webJjonkuLastRun');
const saveWebJjonkuConfig = $('#saveWebJjonkuConfig');
const webJjonkuCheckInterval = $('#webJjonkuCheckInterval');
const webJjonkuEnabled = $('#webJjonkuEnabled');
const webJjonkuTargets = $('#webJjonkuTargets');
const addWebJjonkuTarget = $('#addWebJjonkuTarget');
const webPeerGrants = $('#webPeerGrants');
const addWebPeerGrant = $('#addWebPeerGrant');
let webSupervisorData = null;
const monitoringLayers = $('#monitoringLayers');
const monitoringSensorCount = $('#monitoringSensorCount');
const monitoringSensorList = $('#monitoringSensorList');
const monitoringOracleState = $('#monitoringOracleState');
const monitoringOracleEvidence = $('#monitoringOracleEvidence');
const monitoringSourceSummary = $('#monitoringSourceSummary');
const monitoringSourceList = $('#monitoringSourceList');
const launchAgentSummary = $('#launchAgentSummary');
const launchAgentList = $('#launchAgentList');
const projectServiceSummary = $('#projectServiceSummary');
const projectServiceList = $('#projectServiceList');
const attentionQueue = $('#attentionQueue');
const attentionSummary = $('#attentionSummary');
const repairGateState = $('#repairGateState');
const repairGateDetail = $('#repairGateDetail');
const repairSequenceList = $('#repairSequenceList');
const repairScope = $('#repairScope');
const capabilityGuide = $('#capabilityGuide');
const glossaryGrid = $('#glossaryGrid');
const flowSelector = $('#flowSelector');
const activeFlowSummary = $('#activeFlowSummary');
const taskBrief = $('#taskBrief');
const copyPlannedPrompt = $('#copyPlannedPrompt');
const planPromptMessage = $('#planPromptMessage');
const activitySummary = $('#activitySummary');
const menuToggle = $('#menuToggle');
const primarySidebar = $('#primarySidebar');
const recipeGrid = $('#recipeGrid');
const recipeMessage = $('#recipeMessage');
const projectCatalogSummary = $('#projectCatalogSummary');
const projectCatalogMeta = $('#projectCatalogMeta');
const projectFilters = $('#projectFilters');
const projectList = $('#projectList');
const projectMessage = $('#projectMessage');
const goalLedgerSummary = $('#goalLedgerSummary');
const goalLedgerMeta = $('#goalLedgerMeta');
const goalSearch = $('#goalSearch');
const goalStatusFilter = $('#goalStatusFilter');
const goalSort = $('#goalSort');
const goalStatusCounts = $('#goalStatusCounts');
const goalList = $('#goalList');
const goalMessage = $('#goalMessage');
const userHelpSummary = $('#userHelpSummary');
const userHelpList = $('#userHelpList');
const sessionLedgerSummary = $('#sessionLedgerSummary');
const sessionList = $('#sessionList');
const threadDecisionRows = $('#threadDecisionRows');
const notionSyncState = $('#notionSyncState');
const notionSyncSummary = $('#notionSyncSummary');
const notionSyncFacts = $('#notionSyncFacts');
const notionSyncLink = $('#notionSyncLink');
const coreRouteLedger = $('#coreRouteLedger');
const recentEvidence = $('#recentEvidence');
const knowledgeReviewState = $('#knowledgeReviewState');
const knowledgeReviewSources = $('#knowledgeReviewSources');
const knowledgeReviewLastRun = $('#knowledgeReviewLastRun');
const previewKnowledgeReview = $('#previewKnowledgeReview');
const enqueueKnowledgeReview = $('#enqueueKnowledgeReview');
const knowledgeReviewMessage = $('#knowledgeReviewMessage');
const localAccessForm = $('#localAccessForm');
const localAccessRoot = $('#localAccessRoot');
const localAccessSourceType = $('#localAccessSourceType');
const localAccessIncludes = $('#localAccessIncludes');
const localAccessDenies = $('#localAccessDenies');
const localAccessTtl = $('#localAccessTtl');
const localAccessWholeHomeApproved = $('#localAccessWholeHomeApproved');
const previewLocalGrant = $('#previewLocalGrant');
const confirmLocalGrant = $('#confirmLocalGrant');
const localAccessMessage = $('#localAccessMessage');
const localAccessGrants = $('#localAccessGrants');
const sessionApprovalForm = $('#sessionApprovalForm');
const sessionGrantRef = $('#sessionGrantRef');
const sessionUuid = $('#sessionUuid');
const sessionMaxLines = $('#sessionMaxLines');
const sessionMaxTurns = $('#sessionMaxTurns');
const sessionMaxBytes = $('#sessionMaxBytes');
const previewSessionApproval = $('#previewSessionApproval');
const confirmSessionApproval = $('#confirmSessionApproval');
const sessionApprovalMessage = $('#sessionApprovalMessage');
let confirmationToken = null;
let confirmationAction = null;
let catalog = { groups: [], items: [] };
let product = { flows: [], journeys: [], glossary: [], inventory: {} };
let statusData = null;
let activeFilter = 'all';
let activeArchitectureFilter = 'all';
let activeOpenaiModelFilter = 'current';
let activeFlowId = 'daily';
let searchIndex = 0;
let activeRecipeFilter = 'all';
let designSourceData = null;
let monitoringData = null;
let webJjonkuConfigReady = false;
let projectData = null;
let goalData = null;
let activeGoalStatus = localStorage.getItem('aicc.goalStatus') || 'all';
let activeGoalSort = localStorage.getItem('aicc.goalSort') || 'priority';
let knowledgeData = null;
let localAccessData = null;
let activeMonitorSourceFilter = 'attention';
let activeProjectFilter = 'active';
let pendingProjectPriority = null;
let pendingKnowledgePreview = null;
let pendingLocalGrantToken = null;
let pendingSessionApprovalToken = null;
let monitoringPreviewReady = false;
let recoveryHandoffDocuments = null;
let latestRecoveryData = null;
const selectedDesignSources = new Set();
let initialHashAligned = false;

const desktopRecipes = Object.freeze([
  { id: 'code', group: 'build', eyebrow: 'BUILD', title: '코드 구현과 검증', model: 'Web / 저장 / 매우 높음', summary: '긴 작업 문맥을 유지하며 구현·테스트·근거까지 마칩니다.', prompt: 'Web GPT 모델로 이 저장소의 현재 구조와 지침을 먼저 확인하고, 요청한 기능을 구현해. 기존 사용자 변경은 보존하고 테스트·브라우저 QA·남은 UNKNOWN까지 근거와 함께 보고해.' },
  { id: 'diagnose', group: 'solve', eyebrow: 'DIAGNOSE', title: '로컬 문제 원인 찾기', model: 'Web / 임시 / 높음', summary: '정상 경로는 유지하고 고장 난 한 구역만 진단합니다.', prompt: 'Web GPT 모델로 현재 로컬 상태와 로그를 읽어 문제 원인을 분리해. 정상인 Codex·OCX·Web GPT 경로는 건드리지 말고, 재현 근거와 가장 작은 안전 조치부터 제안해.' },
  { id: 'orchestrate', group: 'team', eyebrow: 'ROLE DAG', title: '여러 Web GPT 역할 협업', model: 'Web / 임시 / 매우 높음', summary: '조사자·비판자·writer·검증자를 한 writer 규칙으로 나눕니다.', prompt: '웹 지피티 오케스트레이션 스킬을 사용해 coordinator → researcher(읽기 전용) → critic(읽기 전용) → writer(유일한 파일 작성자) → verifier(읽기 전용) 순서로 이 작업을 수행해. 현재 도구 스냅샷을 먼저 확인하고 run·lease를 끝에 정리해.' },
  { id: 'research', group: 'team', eyebrow: 'RESEARCH', title: '자료조사와 반대 검토', model: 'Web / 임시 / 높음', summary: '조사 결과를 독립 비판자가 다시 확인합니다.', prompt: 'Web GPT로 공식 1차 자료를 조사하고, 별도 critic 역할이 누락·반례·최신성 위험을 검토하게 해. 검증된 사실, 추론, UNKNOWN을 분리하고 출처를 결과 가까이에 붙여줘.' },
  { id: 'browser', group: 'operate', eyebrow: 'BROWSER', title: '웹 화면 확인과 로컬 수정', model: 'Web / 저장 / 높음', summary: '로그인 경계를 지키며 브라우저 증거와 코드를 연결합니다.', prompt: 'Web GPT로 현재 프로젝트를 수정하되, 웹 확인은 로그인과 workspace가 맞는 인앱 Browser를 사용해. 사용자 탭은 건드리지 말고 task-owned 화면에서 데스크톱·모바일 동작을 실제 검증해.' },
  { id: 'remote', group: 'operate', eyebrow: 'REMOTE', title: '폰·외부 ChatGPT에서 Mac 작업', model: 'AICC Workspace 앱', summary: '등록한 Git 작업공간만 만료 lease로 엽니다.', prompt: 'AICC Workspace 앱에서 대상 workspace_id를 확인하고 lease를 연 뒤 읽기부터 시작해. 허용된 작업공간 밖 경로는 열지 말고, 쓰기는 변경안과 검증 계획을 먼저 제시해.' }
]);

function renderRecipes() {
  const visible = desktopRecipes.filter(item => activeRecipeFilter === 'all' || item.group === activeRecipeFilter);
  recipeGrid.innerHTML = visible.map(item => `<article class="recipe-card" data-recipe-group="${escapeHtml(item.group)}">
    <div class="recipe-head"><span>${escapeHtml(item.eyebrow)}</span><b>${escapeHtml(item.model)}</b></div>
    <h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary)}</p>
    <details><summary>요청 내용 보기</summary><blockquote>${escapeHtml(item.prompt)}</blockquote></details>
    <button type="button" class="secondary copy-recipe" data-recipe-id="${escapeHtml(item.id)}">요청 복사</button>
  </article>`).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function allowedNotionPageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['app.notion.com', 'notion.so', 'www.notion.so'].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

function parseListInput(value) {
  return [...new Set(String(value ?? '').split(/[\n,]/).map(item => item.trim()).filter(Boolean))];
}

function localRequestId(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function stateLabel(value) {
  return ({
    ready: '준비', attention: '확인 필요', unavailable: '미설치', standby: '대기',
    IN_SYNC: '일치', DRIFT: '차이', LOCAL_ONLY: '로컬만', NOTION_ONLY: 'Notion만'
  })[value] || value || 'UNKNOWN';
}

const goalStatusLabels = Object.freeze({
  ACTIVE: '진행 중', HOLD: '도움 필요', REVIEW_READY: '검토 준비', USER_MANAGED_READY: '직접 작업', COMPLETE: '완료', UNASSIGNED: '보충 필요'
});

function goalStatusLabel(value) {
  return goalStatusLabels[value] || value || 'UNKNOWN';
}

function goalProgressItems(progress = {}) {
  return Object.entries(progress).slice(0, 8).map(([key, value]) => {
    const display = Array.isArray(value)
      ? value.slice(0, 3).join(' · ') + (value.length > 3 ? ` 외 ${value.length - 3}` : '')
      : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    return `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(display)}</dd></div>`;
  }).join('');
}

const sessionStateLabels = Object.freeze({
  ACTIVE: '작업 중', IDLE: '다음 일 대기', NOT_LOADED: '직접 열기', PROGRESS: '작업 중', DONE: '한 단계 마침',
  HOLD: '조건 기다림', APPROVAL_REQUIRED: '내 확인 필요', DRIFT: '다시 맞추는 중', USER_MANAGED_READY: '내가 직접 작업', UNKNOWN: '확인 필요',
  ARCHIVED: '보관 완료'
});

const sessionDecisionLabels = Object.freeze({
  KEEP: '관제 유지', CONTINUE: '계속 진행', WAIT: '안전 대기', ARCHIVE: '보관 완료', USER: '직접 작업'
});

function renderCoordination(coordination = {}) {
  const actionLedger = coordination.userActions ?? null;
  const helpItems = actionLedger ? actionLedger.actions ?? [] : (coordination.userHelp ?? []).map(item => ({ ...item, part: null, completionCriteria: null, blocking: false }));
  const blockingItems = helpItems.filter(item => item.blocking === true);
  const completedLabel = actionLedger?.completedCount ? ` · 완료 기록 ${actionLedger.completedCount}개` : '';
  userHelpSummary.textContent = blockingItems.length
    ? `지금 꼭 ${blockingItems.length}개 · 전체 ${helpItems.length}개${completedLabel}`
    : helpItems.length ? `남은 일 ${helpItems.length}개${completedLabel}` : `지금 할 일 없음${completedLabel}`;
  userHelpList.innerHTML = helpItems.length ? helpItems.map(item => `<article class="user-help-item ${item.blocking ? 'blocking' : item.readyNow ? 'ready' : 'later'}">
    <div><span>${item.blocking ? '이것부터 필요' : item.readyNow ? '할 수 있을 때' : '날짜를 기다리는 중'}</span>${item.part ? `<b>${escapeHtml(item.part)} · ${escapeHtml(item.partTitle)}</b>` : ''}<strong>${escapeHtml(item.title)}</strong></div>
    <p>${escapeHtml(item.ask)}</p>
    <ol>${item.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
    <small><b>필요한 이유</b> ${escapeHtml(item.why)}</small>
    ${item.blockingReason ? `<small><b>왜 지금 꼭 필요한가</b> ${escapeHtml(item.blockingReason)}</small>` : ''}
    ${item.completionCriteria ? `<small><b>끝난 기준</b> ${escapeHtml(item.completionCriteria)}</small>` : ''}
    ${item.id && actionLedger ? `<button type="button" class="secondary user-action-complete" data-user-action-complete="${escapeHtml(item.id)}">완료했어요</button>` : ''}
  </article>`).join('') : `<p class="empty"><strong>지금은 해줄 일이 없습니다.</strong><span>완료된 일은 화면에서 빠지고 기록에만 남습니다.${actionLedger?.completedCount ? ` 지금까지 ${actionLedger.completedCount}개 완료했습니다.` : ''}</span></p>`;

  const sessions = coordination.sessions ?? [];
  const activeCount = sessions.filter(session => ['ACTIVE', 'PROGRESS'].includes(session.state)).length;
  sessionLedgerSummary.textContent = `${activeCount}개 작업 중 · ${sessions.length}개 관리`;
  sessionList.innerHTML = sessions.length ? sessions.map(session => `<article class="session-item ${escapeHtml(String(session.state).toLocaleLowerCase('en-US'))}">
    <span class="session-number">${escapeHtml(session.number)}</span>
    <div><strong>${escapeHtml(session.title)}</strong><p>${escapeHtml(session.progress || session.work || '현재 설명을 보충하고 있습니다.')}</p><small>${escapeHtml(session.remaining || session.next || (session.mode === 'USER' ? '사용자가 이 작업을 열 때 시작합니다.' : '다음 안전한 일을 자동으로 찾습니다.'))}</small></div>
    <em>${escapeHtml(sessionStateLabels[session.state] || '확인 필요')}</em>
  </article>`).join('') : '<p class="empty">번호별 작업 기록이 아직 없습니다.</p>';
  threadDecisionRows.innerHTML = sessions.length ? sessions.map(session => `<tr class="${escapeHtml(String(session.state).toLocaleLowerCase('en-US'))}">
    <th scope="row">${escapeHtml(session.number)}</th>
    <td><strong>${escapeHtml(session.title)}</strong><span>${escapeHtml(session.objective || session.work || '목표를 보충하고 있습니다.')}</span></td>
    <td>${escapeHtml(session.progress || session.latestSummary || session.work || '아직 보고가 없습니다.')}</td>
    <td>${escapeHtml(session.remaining || session.next || (session.decision === 'ARCHIVE' ? '없음' : '다음 보고를 기다립니다.'))}</td>
    <td><em>${escapeHtml(sessionDecisionLabels[session.decision] || '관제 유지')}</em>${session.archiveReason ? `<small>${escapeHtml(session.archiveReason)}</small>` : ''}</td>
  </tr>`).join('') : '<tr><td colspan="5">번호별 작업 기록이 아직 없습니다.</td></tr>';

  const notion = coordination.notionSync;
  if (!notion) {
    notionSyncState.textContent = '연결 정보 없음';
    notionSyncSummary.textContent = '노션 개발 페이지를 아직 연결하지 않았습니다.';
    notionSyncFacts.innerHTML = '';
    notionSyncLink.hidden = true;
    return;
  }
  notionSyncState.textContent = notion.stateLabel || '연결 준비';
  notionSyncSummary.textContent = notion.summary || '바뀐 내용만 주고받습니다.';
  notionSyncFacts.innerHTML = `<div><dt>기준</dt><dd>${escapeHtml(notion.canonicalRule || '로컬 코드')}</dd></div><div><dt>노션 항목</dt><dd>${escapeHtml(notion.remoteRows ?? '확인 전')}</dd></div><div><dt>방법</dt><dd>${escapeHtml(notion.transportLabel || '변경분만 전송')}</dd></div>`;
  const notionPageUrl = allowedNotionPageUrl(notion.pageUrl);
  notionSyncLink.hidden = !notionPageUrl;
  if (notionPageUrl) notionSyncLink.href = notionPageUrl;
  else notionSyncLink.removeAttribute('href');
}

function goalVisible(goal) {
  if (activeGoalStatus !== 'all' && goal.status !== activeGoalStatus) return false;
  const query = goalSearch.value.trim().toLocaleLowerCase('ko-KR');
  if (!query) return true;
  return [goal.id, goal.title, goal.ownerTask, goal.next, goal.status].some(value => String(value ?? '').toLocaleLowerCase('ko-KR').includes(query));
}

function renderGoals(data = goalData) {
  if (!data || !goalList) return;
  goalData = data;
  renderCoordination(data.coordination);
  if (activeGoalStatus !== 'all' && !(data.statusOrder ?? []).includes(activeGoalStatus)) activeGoalStatus = 'all';
  if (!['priority', 'unchecked', 'status', 'title'].includes(activeGoalSort)) activeGoalSort = 'priority';
  const order = new Map((data.statusOrder ?? []).map((status, index) => [status, index]));
  const visible = (data.goals ?? []).filter(goalVisible).sort((left, right) => {
    if (activeGoalSort === 'unchecked') return Number(left.checked) - Number(right.checked) || left.id.localeCompare(right.id);
    if (activeGoalSort === 'status') return (order.get(left.status) ?? 99) - (order.get(right.status) ?? 99) || left.id.localeCompare(right.id);
    if (activeGoalSort === 'title') return left.title.localeCompare(right.title, 'ko');
    return (order.get(left.status) ?? 99) - (order.get(right.status) ?? 99) || left.id.localeCompare(right.id);
  });
  goalLedgerSummary.textContent = `개인 검토 ${data.summary.checkedCount}/${data.summary.goalCount} · 이력 ${data.historyCount}`;
  goalLedgerMeta.textContent = data.sourceUpdatedAt
    ? `정본 ${new Date(data.sourceUpdatedAt).toLocaleString('ko-KR')} · 화면 기록 ${data.viewUpdatedAt ? new Date(data.viewUpdatedAt).toLocaleString('ko-KR') : '없음'}`
    : '정본 갱신 시각을 확인하지 못했습니다.';
  goalStatusCounts.innerHTML = (data.statusOrder ?? []).filter(status => data.summary.byStatus?.[status]).map(status => `<button type="button" data-goal-status="${escapeHtml(status)}" class="${activeGoalStatus === status ? 'active' : ''}" aria-pressed="${String(activeGoalStatus === status)}"><span>${escapeHtml(goalStatusLabel(status))}</span><strong>${data.summary.byStatus[status]}</strong></button>`).join('');
  goalStatusFilter.innerHTML = '<option value="all">모든 상태</option>' + (data.statusOrder ?? []).map(status => `<option value="${escapeHtml(status)}">${escapeHtml(goalStatusLabel(status))} · ${data.summary.byStatus?.[status] ?? 0}</option>`).join('');
  goalStatusFilter.value = activeGoalStatus;
  goalSort.value = activeGoalSort;
  goalList.setAttribute('aria-busy', 'false');
  goalList.innerHTML = visible.length ? visible.map(goal => `<article class="goal-row ${escapeHtml(goal.status.toLocaleLowerCase('en-US'))} ${goal.checked ? 'checked' : ''}">
    <label class="goal-check"><input type="checkbox" data-goal-id="${escapeHtml(goal.id)}" ${goal.checked ? 'checked' : ''}><span class="sr-only">${escapeHtml(goal.title)} 개인 검토 표시</span></label>
    <div class="goal-identity"><div><span class="goal-id">${escapeHtml(goal.id)}</span><strong>${escapeHtml(goal.title)}</strong></div><p>${escapeHtml(goal.next || '다음 행동 보충 필요')}</p><small>${escapeHtml(goal.ownerTask || '담당 작업 보충 필요')}</small></div>
    <div class="goal-operational-state"><span class="goal-state ${escapeHtml(goal.status.toLocaleLowerCase('en-US'))}">${escapeHtml(goalStatusLabel(goal.status))}</span><small>운영 상태</small></div>
    <details class="goal-details"><summary>근거와 진행 수치</summary><dl>${goalProgressItems(goal.progress)}</dl><p>${escapeHtml(goal.progressInterpretation || '')}</p><code>${escapeHtml(goal.evidence || '근거 보충 필요')}</code>${goal.checkedAt ? `<small>마지막 체크 ${escapeHtml(new Date(goal.checkedAt).toLocaleString('ko-KR'))}</small>` : ''}</details>
  </article>`).join('') : '<p class="empty-state"><strong>조건에 맞는 목표가 없습니다.</strong><span>검색어나 운영 상태 필터를 바꿔 보세요.</span></p>';
}

async function loadGoals() {
  const response = await fetch('/api/goals', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  renderGoals(data);
  return data;
}

async function setGoalChecked(goalId, checked) {
  goalMessage.textContent = `${goalId} 개인 검토 기록 저장 중`;
  const input = goalList.querySelector(`[data-goal-id="${CSS.escape(goalId)}"]`);
  if (input) input.disabled = true;
  try {
    const data = await postJson('/api/goals/check', { goalId, checked });
    renderGoals(data);
    goalMessage.textContent = `${goalId} ${checked ? '체크' : '체크 해제'} 기록을 누적했습니다. 운영 상태는 변경하지 않았습니다.`;
  } catch (error) {
    if (input) { input.checked = !checked; input.disabled = false; }
    goalMessage.textContent = `체크 기록을 저장하지 못했습니다: ${error.message}`;
  }
}

async function completeUserAction(actionId) {
  const button = userHelpList.querySelector(`[data-user-action-complete="${CSS.escape(actionId)}"]`);
  if (button) { button.disabled = true; button.textContent = '기록 중…'; }
  try {
    await postJson('/api/goals/user-actions/complete', {
      id: actionId,
      evidence: '사용자가 로컬 관제 화면에서 완료했다고 확인했습니다.'
    });
    await loadGoals();
    goalMessage.textContent = `${actionId} 완료를 기록했습니다. 이 항목은 목록에서 빠졌습니다.`;
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = '완료했어요'; }
    goalMessage.textContent = `완료 기록을 저장하지 못했습니다: ${error.message}`;
  }
}

function projectVisible(project) {
  if (activeProjectFilter === 'all') return true;
  if (activeProjectFilter === 'idea') return project.kind === 'idea';
  if (activeProjectFilter === 'drift') return project.sourceState === 'DRIFT';
  if (activeProjectFilter === 'archived') return project.lifecycle === 'archived';
  return project.lifecycle !== 'archived';
}

function renderProjectCatalog(data = projectData) {
  if (!data || !projectList) return;
  projectData = data;
  const projects = data.projects ?? [];
  const visible = projects.filter(projectVisible).sort((left, right) => {
    const leftRank = Number.isInteger(left.priority?.rank) ? left.priority.rank : Number.MAX_SAFE_INTEGER;
    const rightRank = Number.isInteger(right.priority?.rank) ? right.priority.rank : Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || String(left.title).localeCompare(String(right.title), 'ko');
  });
  projectCatalogSummary.textContent = `${data.summary?.total ?? projects.length}개 catalog · DRIFT ${data.summary?.drift ?? 0}개`;
  projectCatalogMeta.textContent = data.notionSource?.available
    ? `로컬 ${data.sourceSnapshots?.local?.count ?? '–'} · Notion 프로젝트 ${data.notionSource.projectCount} / 아이디어 ${data.notionSource.ideaCount} · ${new Date(data.notionSource.capturedAt).toLocaleString('ko-KR')}`
    : `로컬 ${data.sourceSnapshots?.local?.count ?? '–'} · Notion snapshot 없음`;
  const filters = [
    ['active', '활성'], ['idea', '아이디어'], ['drift', 'DRIFT'], ['archived', '보관'], ['all', '전체']
  ];
  projectFilters.innerHTML = filters.map(([id, label]) => `<button type="button" data-project-filter="${id}" aria-pressed="${String(activeProjectFilter === id)}" class="${activeProjectFilter === id ? 'active' : ''}">${label}</button>`).join('');
  projectList.innerHTML = visible.length ? visible.map(project => {
    const rank = Number.isInteger(project.priority?.rank) ? project.priority.rank : null;
    const progress = Number.isFinite(project.progress?.percent) ? project.progress.percent : 0;
    const notionOwned = Boolean(project.origins?.notion) && rank !== null;
    const pathCopy = project.canonicalRoot ? `<code title="${escapeHtml(project.canonicalRoot)}">${escapeHtml(project.canonicalRoot)}</code>` : '<span>로컬 정본 없음</span>';
    const nextAction = project.nextAction || '다음 행동이 아직 기록되지 않았습니다.';
    return `<article class="project-ledger-row ${escapeHtml(String(project.sourceState || 'UNKNOWN').toLocaleLowerCase('en-US'))}">
      <div class="project-rank"><span>${rank === null ? '–' : rank}</span><small>priority</small></div>
      <div class="project-identity"><div><strong>${escapeHtml(project.title)}</strong><span>${escapeHtml(project.domain)} · ${escapeHtml(project.kind)}</span></div><p>${escapeHtml(nextAction)}</p>${pathCopy}</div>
      <dl class="project-state-cells"><div><dt>lifecycle</dt><dd>${escapeHtml(project.lifecycle || 'UNKNOWN')}</dd></div><div><dt>progress</dt><dd>${progress}% · ${escapeHtml(project.progress?.confidence || 'unknown')}</dd></div><div><dt>source</dt><dd>${escapeHtml(stateLabel(project.sourceState))}</dd></div></dl>
      <div class="project-priority-actions" aria-label="${escapeHtml(project.title)} 우선순위">
        <button type="button" class="ghost" data-project-id="${escapeHtml(project.id)}" data-priority-shift="-1" ${notionOwned && rank > 0 ? '' : 'disabled'} aria-label="우선순위 올리기">↑</button>
        <button type="button" class="ghost" data-project-id="${escapeHtml(project.id)}" data-priority-shift="1" ${notionOwned ? '' : 'disabled'} aria-label="우선순위 내리기">↓</button>
      </div>
    </article>`;
  }).join('') : '<p class="empty">이 필터에 해당하는 프로젝트가 없습니다. 다른 필터를 선택해 주세요.</p>';
}

function routeEvidence(component, fallback = 'current acceptance 없음') {
  if (component?.latestVerification?.status === 'pass') return `current ${component.latestVerification.overallPass}/${component.latestVerification.total}`;
  if (component?.historicalVerification) return `historical ${component.historicalVerification.overallPass ?? '–'}/${component.historicalVerification.total ?? '–'} · current 아님`;
  return fallback;
}

function exactActiveGate(...counters) {
  if (!counters.length || counters.some(value => !Number.isInteger(value))) return 'UNKNOWN · mutation HOLD';
  const total = counters.reduce((sum, value) => sum + value, 0);
  return total === 0 ? `${counters.join('/')} · exact idle` : `${counters.join('/')} · active`;
}

function renderCoreRouteLedger(data = statusData) {
  if (!data || !coreRouteLedger) return;
  const find = id => data.components?.find(component => component.id === id);
  const web = find('web-gpt');
  const rescue = find('web-gpt-rescue');
  const ocx = find('ocx');
  const routes = find('codex-routes');
  const rows = [
    {
      label: 'Integrated Web GPT · 17841', source: 'chatgpt-web/* → 17841',
      installed: web?.version ? `${web.version}${web.runtimeBundleId ? ` · ${web.runtimeBundleId.slice(0, 8)}` : ''}` : 'UNKNOWN',
      health: web?.healthy ? 'healthy' : 'UNKNOWN · offline',
      gate: exactActiveGate(web?.activeHttpTurns, web?.activeBrowserHttpTurns, web?.activeBrowserTurns),
      browser: web?.acceptingBrowserTurns ? (web?.harnessReady ? 'browser + harness ready' : 'browser ready · harness HOLD') : 'browser HOLD',
      evidence: routeEvidence(web), state: web?.healthy ? web?.state : 'offline'
    },
    {
      label: 'Web GPT direct · 17842', source: `${rescue?.port || 17842} · browser-only`,
      installed: rescue?.version || 'UNKNOWN',
      health: rescue?.health?.status === 'ok' ? 'healthy' : 'UNKNOWN · offline',
      gate: exactActiveGate(rescue?.health?.active_http_turns, rescue?.health?.active_browser_http_turns, rescue?.health?.active_browser_turns),
      browser: rescue?.health?.accepting_browser_turns ? 'browser ready' : 'browser standby',
      evidence: '독립 생존 경로 · acceptance 별도', state: rescue?.health?.status === 'ok' ? rescue?.state : 'offline'
    },
    {
      label: 'OCX direct · 10100', source: 'selected provider → 10100', installed: ocx?.version || 'UNKNOWN',
      health: ocx?.state === 'ready' ? 'health + ready' : stateLabel(ocx?.state),
      gate: exactActiveGate(ocx?.sections?.runtime?.activeTurns), browser: 'N/A · direct API',
      evidence: Number.isInteger(ocx?.sections?.runtime?.activeTurns) ? 'current runtime observed' : 'current acceptance 없음', state: ocx?.state
    },
    {
      label: 'Native direct', source: 'OpenAI official endpoint', installed: routes?.nativeReady ? 'profile ready' : 'UNKNOWN',
      health: routes?.nativeReady ? 'profile verified' : 'UNKNOWN', gate: 'N/A · independent profile', browser: 'N/A · direct API',
      evidence: routes?.nativeReady ? 'current profile evidence' : 'current smoke 별도 필요', state: routes?.nativeReady ? 'ready' : 'attention'
    }
  ];
  coreRouteLedger.innerHTML = rows.map(row => `<article class="core-route-row ${escapeHtml(row.state || 'attention')}"><strong>${escapeHtml(row.label)}</strong><dl><div><dt>configured source</dt><dd>${escapeHtml(row.source)}</dd></div><div><dt>installed runtime</dt><dd>${escapeHtml(row.installed)}</dd></div><div><dt>live health</dt><dd>${escapeHtml(row.health)}</dd></div><div><dt>active gate</dt><dd>${escapeHtml(row.gate)}</dd></div><div><dt>browser / harness</dt><dd>${escapeHtml(row.browser)}</dd></div><div><dt>acceptance evidence</dt><dd>${escapeHtml(row.evidence)}</dd></div></dl></article>`).join('');
}

function renderRecentEvidence() {
  if (!recentEvidence) return;
  const workspace = statusData?.components?.find(component => component.id === 'workspace-mcp');
  const web = statusData?.components?.find(component => component.id === 'web-gpt');
  const evidence = [
    {
      label: 'Official knowledge',
      value: knowledgeData?.latestRun ? `${knowledgeData.latestRun.outcome} · ${knowledgeData.latestRun.finishedAt || '시각 없음'}` : 'current run 없음',
      kind: knowledgeData?.latestRun?.outcome === 'completed' ? 'current' : 'unknown'
    },
    {
      label: '52-source monitor',
      value: monitoringData?.upstream?.checkedAt ? `${monitoringData.signal?.state || 'unknown'} · ${formatMonitoringDate(monitoringData.upstream.checkedAt)}` : 'owner snapshot 없음',
      kind: monitoringData?.signal?.state || 'unknown'
    },
    {
      label: 'Workspace publication',
      value: workspace?.publication?.needsPublish ? `candidate ${workspace.publication.toolCount ?? '–'} tools · refresh 필요` : workspace?.publication?.published?.verifiedAt ? `verified ${new Date(workspace.publication.published.verifiedAt).toLocaleString('ko-KR')}` : 'current connector evidence 없음',
      kind: workspace?.publication?.needsPublish ? 'stale' : 'current'
    },
    {
      label: 'Web GPT acceptance',
      value: routeEvidence(web),
      kind: web?.latestVerification?.status === 'pass' ? 'current' : 'historical'
    }
  ];
  recentEvidence.innerHTML = evidence.map(item => `<div class="evidence-row ${escapeHtml(item.kind)}"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></div>`).join('');
}

function renderKnowledgeReview(data = knowledgeData) {
  if (!data || !knowledgeReviewState) return;
  knowledgeData = data;
  knowledgeReviewState.textContent = data.runningJobIds?.length ? `실행 중 ${data.runningJobIds.length}` : data.queuedJobIds?.length ? `대기 ${data.queuedJobIds.length}` : '수동 대기';
  knowledgeReviewSources.innerHTML = (data.sources ?? []).map(source => `<li><strong>${escapeHtml(source.sourceId)}</strong><span>${escapeHtml(source.lastOutcome || 'not-run')} · pages ${source.pageCount ?? 0}</span></li>`).join('') || '<li>등록 source 없음</li>';
  knowledgeReviewLastRun.textContent = data.latestRun
    ? `${data.latestRun.outcome} · ${formatMonitoringDate(data.latestRun.finishedAt)} · 자동 적용 0`
    : '현재 실행 근거 없음 · preview 후 durable job을 생성하세요.';
  renderRecentEvidence();
}

function renderLocalAccess(data = localAccessData) {
  if (!data || !localAccessGrants) return;
  localAccessData = data;
  const grants = data.grants ?? [];
  localAccessGrants.innerHTML = grants.length ? grants.map(grant => `<article class="local-grant-row ${grant.expired ? 'expired' : 'active'}"><div><strong>${escapeHtml(grant.label)}</strong><span>${escapeHtml(grant.sourceType)} · ${grant.expired ? '만료' : '활성'}</span></div><code>${escapeHtml(grant.canonicalRoot)}</code><small>${escapeHtml(grant.grantRef)} · ${formatMonitoringDate(grant.expiresAt)}</small></article>`).join('') : '<p class="empty">활성 grant가 없습니다. exact root를 preview한 뒤에만 발급됩니다.</p>';
  if (sessionGrantRef) {
    const sessionGrants = grants.filter(grant => grant.sourceType === 'codex-sessions' && !grant.expired);
    sessionGrantRef.innerHTML = '<option value="">sessions grant 선택</option>' + sessionGrants.map(grant => `<option value="${escapeHtml(grant.grantRef)}">${escapeHtml(grant.label)} · ${escapeHtml(grant.grantRef)}</option>`).join('');
  }
}

async function loadProjectCatalog() {
  const response = await fetch('/api/projects', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  renderProjectCatalog(data);
  return data;
}

async function loadKnowledgeReview() {
  const response = await fetch('/api/knowledge-review/status', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  renderKnowledgeReview(data);
  return data;
}

async function loadLocalAccess() {
  const response = await fetch('/api/local-access', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  renderLocalAccess(data);
  return data;
}

async function previewOfficialKnowledgeReview() {
  previewKnowledgeReview.disabled = true;
  enqueueKnowledgeReview.disabled = true;
  knowledgeReviewMessage.textContent = '공식 source 범위와 최대 요청 수를 계산하고 있습니다.';
  try {
    const preview = await postJson('/api/knowledge-review/preview', {});
    pendingKnowledgePreview = preview;
    const sourceLabels = preview.sources.map(source => source.sourceId).join(' · ');
    knowledgeReviewMessage.textContent = `${sourceLabels} · 최대 ${preview.estimatedRequests.totalAtMost} requests · owner-only 저장 · 자동 적용 0. 범위를 확인한 뒤 job을 생성하세요.`;
    enqueueKnowledgeReview.disabled = false;
  } catch (error) {
    pendingKnowledgePreview = null;
    knowledgeReviewMessage.textContent = `preview 실패: ${error.message}`;
  } finally {
    previewKnowledgeReview.disabled = false;
  }
}

async function enqueueOfficialKnowledgeReview() {
  if (!pendingKnowledgePreview) return;
  enqueueKnowledgeReview.disabled = true;
  knowledgeReviewMessage.textContent = '확인된 범위로 durable job을 생성하고 있습니다.';
  try {
    const requestId = localRequestId('knowledge-review');
    const result = await postJson('/api/knowledge-review/jobs', {
      confirmed: true,
      sourceIds: pendingKnowledgePreview.sources.map(source => source.sourceId),
      requestId,
      idempotencyKey: requestId
    });
    pendingKnowledgePreview = null;
    knowledgeReviewMessage.textContent = `${result.job.jobId} 대기열 생성 · source/guidance/Wiki/Skill/MCP 자동 적용 없음`;
    await loadKnowledgeReview();
  } catch (error) {
    knowledgeReviewMessage.textContent = `job 생성 실패: ${error.message}`;
    enqueueKnowledgeReview.disabled = false;
  }
}

async function previewProjectPriority(projectId, shift) {
  const project = projectData?.projects?.find(item => item.id === projectId);
  if (!project || !Number.isInteger(project.priority?.rank)) return;
  const desiredRank = Math.max(0, project.priority.rank + shift);
  projectMessage.textContent = `${project.title} 우선순위 ${project.priority.rank} → ${desiredRank} preview 중`;
  try {
    const preview = await postJson('/api/projects/priority/preview', {
      projectId,
      desiredRank,
      expectedRemoteVersion: projectData.notionSource?.version,
      actor: 'owner'
    });
    pendingProjectPriority = preview;
    const text = document.createElement('span');
    text.textContent = `${project.title}: rank ${project.priority.rank} → ${desiredRank}. 확인해도 Notion에 즉시 쓰지 않고 owner outbox에 PENDING_SYNC로 기록합니다. `;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.dataset.confirmProjectPriority = 'true';
    button.textContent = '확인하고 outbox 기록';
    projectMessage.replaceChildren(text, button);
  } catch (error) {
    pendingProjectPriority = null;
    projectMessage.textContent = `priority preview 실패: ${error.message}`;
  }
}

async function confirmProjectPriorityChange() {
  if (!pendingProjectPriority) return;
  const button = projectMessage.querySelector('[data-confirm-project-priority]');
  if (button) button.disabled = true;
  try {
    const result = await postJson('/api/projects/priority/confirm', { confirmationToken: pendingProjectPriority.confirmationToken });
    const operation = result.operation ?? result;
    pendingProjectPriority = null;
    projectMessage.textContent = `outbox ${operation.operationId || operation.id || 'record'} · ${operation.state || 'PENDING_SYNC'} · 외부 write ${result.externalWritePerformed ? '실행됨' : '없음'}`;
    await loadProjectCatalog();
  } catch (error) {
    projectMessage.textContent = `outbox 기록 실패: ${error.message}`;
    if (button) button.disabled = false;
  }
}

async function previewLocalAccessGrant(event) {
  event?.preventDefault();
  const includes = parseListInput(localAccessIncludes.value);
  const denies = parseListInput(localAccessDenies.value);
  if (localAccessWholeHomeApproved.checked && denies.length === 0) {
    localAccessMessage.textContent = 'whole-home explicit grant에는 구조적 차단 외에 사용자가 적은 non-empty denylist가 필요합니다.';
    return;
  }
  previewLocalGrant.disabled = true;
  confirmLocalGrant.disabled = true;
  pendingLocalGrantToken = null;
  try {
    const preview = await postJson('/api/local-access/grants/preview', {
      root: localAccessRoot.value.trim(),
      sourceType: localAccessSourceType.value,
      includes,
      denies,
      ttlSeconds: Number(localAccessTtl.value),
      wholeHomeApproved: localAccessWholeHomeApproved.checked,
      correlationId: localRequestId('local-read')
    });
    pendingLocalGrantToken = preview.confirmationToken;
    const grant = preview.grant;
    localAccessMessage.textContent = `${grant.canonicalRoot} · files ${grant.preview.fileCount}${grant.preview.truncated ? '+' : ''} · TTL ${formatMonitoringDate(grant.expiresAt)} · read-only · policy ${grant.policyHash.slice(0, 12)}. exact 범위를 확인한 뒤 발급하세요.`;
    confirmLocalGrant.disabled = false;
  } catch (error) {
    localAccessMessage.textContent = `grant preview 실패: ${error.message}`;
  } finally {
    previewLocalGrant.disabled = false;
  }
}

async function confirmLocalAccessGrant() {
  if (!pendingLocalGrantToken) return;
  confirmLocalGrant.disabled = true;
  try {
    const result = await postJson('/api/local-access/grants/confirm', { confirmationToken: pendingLocalGrantToken });
    pendingLocalGrantToken = null;
    localAccessMessage.textContent = `${result.grant.grantRef} 발급 · raw capability은 durable 저장되지 않으며 MCP restart 뒤 다시 open해야 합니다.`;
    await loadLocalAccess();
  } catch (error) {
    localAccessMessage.textContent = `grant 발급 실패: ${error.message}`;
    confirmLocalGrant.disabled = false;
  }
}

async function previewCodexSessionApproval(event) {
  event?.preventDefault();
  previewSessionApproval.disabled = true;
  confirmSessionApproval.disabled = true;
  pendingSessionApprovalToken = null;
  try {
    const preview = await postJson('/api/local-access/excerpts/preview', {
      grantRef: sessionGrantRef.value,
      sessionUuid: sessionUuid.value.trim(),
      maxLines: Number(sessionMaxLines.value),
      maxTurns: Number(sessionMaxTurns.value),
      maxBytes: Number(sessionMaxBytes.value)
    });
    pendingSessionApprovalToken = preview.confirmationToken;
    const approval = preview.approval;
    sessionApprovalMessage.textContent = `${approval.sessionUuid} · ${approval.maxLines} lines / ${approval.maxTurns} turns / ${approval.maxBytes} bytes · prompt/tool output redaction · 다시 눌러 발급`;
    confirmSessionApproval.disabled = false;
  } catch (error) {
    sessionApprovalMessage.textContent = `excerpt preview 실패: ${error.message}`;
  } finally {
    previewSessionApproval.disabled = false;
  }
}

async function confirmCodexSessionApproval() {
  if (!pendingSessionApprovalToken) return;
  confirmSessionApproval.disabled = true;
  try {
    const result = await postJson('/api/local-access/excerpts/confirm', { confirmationToken: pendingSessionApprovalToken });
    pendingSessionApprovalToken = null;
    sessionApprovalMessage.textContent = `${result.approval.approvalRef} 발급 · source/UUID/correlation/audit-bound · 첫 resolver 소비 뒤 replay 거부`;
  } catch (error) {
    sessionApprovalMessage.textContent = `excerpt 승인 실패: ${error.message}`;
    confirmSessionApproval.disabled = false;
  }
}

function formatSourceSize(kib) {
  const bytes = Number(kib || 0) * 1024;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.round(bytes / 1024).toLocaleString('ko-KR')} KiB`;
}

function designSourceStatusLabel(status) {
  return ({
    current: '최신', update_available: '업데이트', not_installed: '로컬 없음',
    modified: '수정 감지', unknown: '확인 실패', not_checked: '확인 전'
  })[status] || status;
}

function shortRevision(revision) {
  return revision ? revision.slice(0, 10) : '–';
}

function selectableDesignSources() {
  return (designSourceData?.sources ?? []).filter(source => source.remoteRevision && source.integrity !== 'modified');
}

function updateDesignSourceSelection() {
  const available = selectableDesignSources();
  for (const id of [...selectedDesignSources]) {
    if (!available.some(source => source.id === id)) selectedDesignSources.delete(id);
  }
  const count = selectedDesignSources.size;
  const size = available.filter(source => selectedDesignSources.has(source.id)).reduce((sum, source) => sum + Number(source.estimatedKiB || 0), 0);
  designSourceSelectionSummary.textContent = count ? `${count}개 선택 · 예상 원본 ${formatSourceSize(size)}` : '선택된 원본 없음';
  applyDesignSources.disabled = count === 0;
  const allSelected = available.length > 0 && available.every(source => selectedDesignSources.has(source.id));
  selectAllDesignSources.textContent = allSelected ? '선택 해제' : '전체 선택';
  document.querySelectorAll('[data-design-source-id]').forEach(input => { input.checked = selectedDesignSources.has(input.dataset.designSourceId); });
}

function renderDesignSources(data) {
  designSourceData = data;
  designSourcesChecked.textContent = data.checkedAt ? `마지막 확인 ${new Date(data.checkedAt).toLocaleString('ko-KR')}` : '최신 커밋을 아직 확인하지 않음';
  designSourceUpdateCount.textContent = String(data.counts.update_available || 0);
  designSourceMissingCount.textContent = String(data.counts.not_installed || 0);
  designSourceTotalSize.textContent = formatSourceSize(data.estimatedTotalKiB);
  designSourceList.innerHTML = data.sources.map(source => {
    const selectable = Boolean(source.remoteRevision) && source.integrity !== 'modified';
    const capabilities = source.capabilities.map(item => `<span>${escapeHtml(item)}</span>`).join('');
    const restriction = source.usageRestriction ? `<p>${escapeHtml(source.usageRestriction)}</p>` : '';
    return `<article class="design-source-card">
      <label class="design-source-check" title="${selectable ? '업데이트 대상 선택' : '최신 확인 또는 무결성 복구가 필요합니다.'}"><input type="checkbox" data-design-source-id="${escapeHtml(source.id)}" ${selectedDesignSources.has(source.id) ? 'checked' : ''} ${selectable ? '' : 'disabled'}><span class="sr-only">${escapeHtml(source.label)} 선택</span></label>
      <div class="design-source-copy">
        <div class="design-source-head"><h3>${escapeHtml(source.label)}</h3><span class="source-badge ${escapeHtml(source.status)}">${escapeHtml(designSourceStatusLabel(source.status))}</span><span class="source-badge${source.license === 'UNKNOWN' ? ' license-unknown' : ''}">${escapeHtml(source.license)}</span><span class="source-badge">${escapeHtml(source.kind)}</span></div>
        <p>Codex 추천 범위: ${source.recommendedPaths.map(escapeHtml).join(' · ')}</p>${restriction}
        <div class="source-capabilities">${capabilities}</div>
        <div class="source-commits"><span>활성 커밋<code title="${escapeHtml(source.activeRevision || '')}">${escapeHtml(shortRevision(source.activeRevision))}</code></span><span>최신 커밋<code title="${escapeHtml(source.remoteRevision || '')}">${escapeHtml(shortRevision(source.remoteRevision))}</code></span></div>
      </div>
      <div class="design-source-side"><strong>${formatSourceSize(source.estimatedKiB)}</strong><span>GitHub 추정치</span><span>무결성 ${escapeHtml(source.integrity)}</span><a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">원본 열기 ↗</a></div>
    </article>`;
  }).join('');
  updateDesignSourceSelection();
}

async function loadDesignSources() {
  const response = await fetch('/api/design-sources', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  renderDesignSources(data);
}

async function scanDesignSourceUpdates() {
  scanDesignSourcesButton.disabled = true;
  designSourceMessage.textContent = '7개 원본의 최신 커밋을 읽기 전용으로 확인하고 있습니다.';
  try {
    const data = await postJson('/api/design-sources/scan', {});
    renderDesignSources(data);
    designSourceMessage.textContent = `확인 완료: 업데이트 ${data.counts.update_available || 0}개 · 로컬 없음 ${data.counts.not_installed || 0}개`;
  } catch (error) {
    designSourceMessage.textContent = `확인하지 못했습니다: ${error.message}`;
  } finally {
    scanDesignSourcesButton.disabled = false;
  }
}

function formatMonitoringDate(value) {
  if (!value) return '기록 없음';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('ko-KR');
}

function monitorStatusLabel(status) {
  return ({
    current: '최신', update_available: '업데이트', auth_required: '인증 필요',
    reference: '참고 최신', unknown: '확인 실패', missing: '신호 없음', stale: '오래된 신호'
  })[status] || status || '확인 전';
}

function renderMonitoringSources() {
  const sources = monitoringData?.upstream?.sources ?? [];
  const visible = sources.filter(source => {
    if (activeMonitorSourceFilter === 'all') return true;
    if (activeMonitorSourceFilter === 'attention') return !['current', 'reference'].includes(source.status);
    return source.status === activeMonitorSourceFilter;
  });
  monitoringSourceSummary.textContent = `${visible.length}개 표시 · 전체 ${sources.length}개`;
  monitoringSourceList.innerHTML = visible.length ? visible.map(source => {
    const baseline = source.baselineVersion || shortRevision(source.baselineRevision);
    const current = source.currentVersion || shortRevision(source.currentRevision);
    const action = source.status === 'update_available' && source.applyAction
      ? `<button type="button" class="secondary compact-action" data-action="${escapeHtml(source.applyAction)}">안전 업데이트</button><span>${escapeHtml(source.applyReason || '미리보기 후 적용합니다.')}</span>`
      : source.status === 'reference'
        ? `<span>${escapeHtml(source.applyReason || '참고 원본의 최신 상태만 확인합니다.')}</span>`
        : source.status === 'update_available'
          ? `<span>${escapeHtml(source.applyReason || '전용 적용기 확인 후 agent가 검토합니다.')}</span>`
          : source.status === 'current' ? '<span>적용할 변경 없음</span>' : `<span>${escapeHtml(source.applyReason || '현재 상태를 다시 확인해야 합니다.')}</span>`;
    return `<article class="monitor-source-row ${escapeHtml(source.status)}">
      <div><strong>${escapeHtml(source.label || source.id)}</strong><small>${escapeHtml(source.package || source.repository || source.type)}</small></div>
      <span class="monitor-state ${escapeHtml(source.status)}">${escapeHtml(monitorStatusLabel(source.status))}</span>
      <div class="monitor-revisions"><span>${source.status === 'reference' ? '설치' : '기준'} <code>${escapeHtml(source.status === 'reference' ? '미채택' : baseline)}</code></span><span>관측 <code>${escapeHtml(current)}</code></span></div>
      <div class="monitor-source-action">${action}</div>
    </article>`;
  }).join('') : '<p class="empty">이 필터에 해당하는 업스트림이 없습니다.</p>';
}

function launchAgentDecision(item) {
  if (item.group === 'project-on-demand') return item.running ? 'AICC가 사이트 묶음으로 실행 중' : '의도적으로 꺼짐 · 상주 비용 0 MiB';
  if (!item.running) return '현재 상주 비용 0 MiB';
  if (item.attention) return `최근 종료 코드 ${item.lastExitCode} 점검`;
  if (item.label === 'com.opencodex.proxy') return '필수 OCX upstream · 상시 유지';
  if (item.label === 'com.agenticlab.aicc-workspace-tunnel') return '필수 외부 Workspace 경로 · 상시 유지';
  if (item.group === 'project-owned') return '해당 프로젝트 사용 여부로 별도 판단';
  return '현재 역할에 맞게 실행 중';
}

function projectServiceStateLabel(project) {
  if (!project.onDemandReady) return '정책 전환 필요';
  return project.state === 'running' ? '실행 중' : project.state === 'stopped' ? '꺼짐' : '부분 실행';
}

function renderProjectServices(data) {
  const projects = data?.projects ?? [];
  const summary = data?.summary ?? {};
  projectServiceSummary.textContent = `${summary.running || 0}개 실행 · ${summary.stopped || 0}개 꺼짐`;
  projectServiceList.innerHTML = projects.length ? projects.map(project => {
    const targetRunning = project.state !== 'running';
    const action = targetRunning ? 'project-service.start' : 'project-service.stop';
    const disabled = !project.onDemandReady || (!targetRunning && project.activeConnections !== 0);
    const connectionCopy = project.activeConnections === null ? '연결 확인 불가' : `활성 연결 ${project.activeConnections}개`;
    return `<article class="project-service-row ${escapeHtml(project.state)}">
      <div class="project-service-copy"><strong>${escapeHtml(project.label)}</strong><p>${escapeHtml(project.description)}</p></div>
      <div class="project-service-evidence"><span class="launch-agent-state ${project.state === 'running' ? 'running' : 'idle'}">${escapeHtml(projectServiceStateLabel(project))}</span><small>${project.runningCount}/${project.unitCount} unit · ${escapeHtml(connectionCopy)}</small></div>
      <button type="button" class="${targetRunning ? 'secondary' : 'ghost'}" data-project-service-action="${action}" data-project-service-id="${escapeHtml(project.id)}" ${disabled ? 'disabled' : ''}>${targetRunning ? '사이트 켜기' : '사이트 끄기'}</button>
    </article>`;
  }).join('') : '<p class="empty">등록된 온디맨드 프로젝트가 없습니다.</p>';
}

function renderLaunchAgents(data) {
  const summary = data.summary ?? {};
  launchAgentSummary.textContent = `${summary.running || 0}/${summary.registered || 0} 실행 · ${Number(summary.residentMiB || 0).toFixed(1)} MiB`;
  const items = [...(data.items ?? [])].sort((a, b) => Number(b.running) - Number(a.running) || b.residentMiB - a.residentMiB || a.label.localeCompare(b.label));
  launchAgentList.innerHTML = items.length ? items.map(item => `<article class="launch-agent-row${item.attention ? ' attention' : ''}">
    <div class="launch-agent-id"><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.role)} · ${escapeHtml(item.group)}</small></div>
    <span class="launch-agent-state ${item.running ? 'running' : 'idle'}">${item.running ? '실행 중' : '비실행'}</span>
    <div class="launch-agent-resource"><strong>${Number(item.residentMiB || 0).toFixed(1)} MiB</strong><small>CPU ${Number(item.cpuPercent || 0).toFixed(1)}% · ${item.processCount || 0} process</small></div>
    <div class="launch-agent-need"><span>${escapeHtml(item.need)}</span><b>${escapeHtml(launchAgentDecision(item))}</b></div>
  </article>`).join('') : '<p class="empty">등록된 LaunchAgent가 없습니다.</p>';
}

function renderMonitoring(data) {
  monitoringData = data;
  const oracle = data.oracle;
  const upstream = data.upstream;
  const signal = data.signal ?? { state: 'missing', detail: '신호가 없습니다.' };
  monitoringUpdated.textContent = upstream?.checkedAt ? `로컬 검사 ${formatMonitoringDate(upstream.checkedAt)}` : '로컬 검사 기록 없음';
  monitoringSignalMark.classList.toggle('current', signal.state === 'current');
  monitoringSignalMark.classList.toggle('stale', signal.state !== 'current');
  monitoringSignalTitle.textContent = signal.state === 'current' ? 'AICC가 업스트림을 직접 확인했습니다' : signal.state === 'stale' ? '로컬 업스트림 검사를 다시 실행하세요' : '첫 로컬 업스트림 검사가 필요합니다';
  monitoringSignalDetail.textContent = signal.detail;
  monitoringSourceCount.textContent = String(upstream?.sources?.length ?? 0);
  monitoringUpdateCount.textContent = String(upstream?.counts?.update_available ?? 0);
  monitoringObserverMode.textContent = data.scheduler?.owner === 'durable-job-manager' ? 'durable queue' : '소유자 미확인';
  monitoringLayers.innerHTML = data.layers.map(layer => `<article class="monitor-layer layer-${escapeHtml(layer.id)}">
    <span>${String(layer.order).padStart(2, '0')}</span>
    <div><strong>${escapeHtml(layer.label)}</strong><p>${escapeHtml(layer.summary)}</p></div>
    <dl><div><dt>소유</dt><dd>${escapeHtml(layer.owner)}</dd></div><div><dt>위치</dt><dd>${escapeHtml(layer.location)}</dd></div></dl>
  </article>`).join('');
  monitoringSensorCount.textContent = `${data.local.sensors.length}개`;
  monitoringSensorList.innerHTML = data.local.sensors.map(sensor => `<div><span><strong>${escapeHtml(sensor.label)}</strong><small>${escapeHtml(sensor.mode)}</small></span><b>${escapeHtml(sensor.cadence)}</b><em>${escapeHtml(sensor.apply)}</em></div>`).join('');
  monitoringOracleState.textContent = data.policy?.oracleAdapterDefault === 'disabled' ? '기본 비활성' : '선택 활성';
  monitoringOracleEvidence.innerHTML = oracle ? [
    ['마지막 보존 관측', formatMonitoringDate(oracle.checkedAt)],
    ['보존된 타이머 상태', `${oracle.timer?.activeState || 'unknown'} · ${oracle.timer?.subState || 'unknown'}`],
    ['기본 정책', data.policy?.oracleAdapterDefault || 'disabled'],
    ['observer 종료', `${oracle.observer?.result || 'unknown'} · ${formatMonitoringDate(oracle.observer?.lastFinished)}`],
    ['직전 CPU', `${(Number(oracle.observer?.cpuUsageNanoseconds || 0) / 1_000_000_000).toFixed(2)}초`],
    ['현재 역할', '예비 adapter']
  ].map(([term, value]) => `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('') : '<div><dt>상태</dt><dd>Oracle adapter를 사용한 기록이 없습니다.</dd></div>';
  renderProjectServices(data.local.projectServices);
  renderMonitoringSources();
  renderLaunchAgents(data.local.launchAgents);
  renderRecentEvidence();
}

async function loadMonitoring() {
  const response = await fetch('/api/monitoring', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  renderMonitoring(data);
}

function selectedWebTargets() {
  return [...webJjonkuTargets.querySelectorAll('[data-supervisor-target]')].map(row => {
    const field = name => row.querySelector('[data-field="' + name + '"]');
    return { id: row.dataset.supervisorTarget, enabled: field('enabled').checked, role: field('role').value,
      conversationUrl: field('conversationUrl').value.trim(), autoResume: field('autoResume').checked,
      autoResumeMode: field('autoResumeMode').value,
      ...(field('externalStateFile').value.trim() ? { externalStateFile: field('externalStateFile').value.trim(), externalStateSha256: field('externalStateSha256').value.trim() } : {}) };
  });
}
function renderWebTargets(targets) {
  const modes = webSupervisorData.capabilities.autoResumeModes;
  const roles = webSupervisorData.roles;
  webJjonkuTargets.innerHTML = targets.map(t => {
    const roleOptions = roles.map(r => '<option value="' + escapeHtml(r.role) + '"' + (r.role === t.role ? ' selected' : '') + '>' + escapeHtml(r.available ? r.accountAlias + ' / ' + r.workspaceAlias : r.role + ' · 등록 신원 미확인') + '</option>').join('');
    const modeOptions = Object.entries(modes).map(([key, m]) => '<option value="' + key + '"' + (key === t.autoResumeMode ? ' selected' : '') + '>' + escapeHtml(m.label) + '</option>').join('');
    return '<fieldset data-supervisor-target="' + escapeHtml(t.id) + '"><legend>선택 대화</legend><div class="web-supervisor-row"><label>대화 URL<input data-field="conversationUrl" type="url" value="' + escapeHtml(t.conversationUrl || '') + '" placeholder="https://chatgpt.com/c/..." required></label><label>등록 계정<select data-field="role">' + roleOptions + '</select></label><label>재개 방식<select data-field="autoResumeMode">' + modeOptions + '</select></label></div><div class="web-supervisor-options"><label><input type="checkbox" data-field="enabled"' + (t.enabled ? ' checked' : '') + '> 이 대화 감시</label><label><input type="checkbox" data-field="autoResume"' + (t.autoResume ? ' checked' : '') + '> 조건 충족 시 응답 중지·재개 허용</label><button type="button" data-remove-target="' + escapeHtml(t.id) + '">목록에서 제외</button></div><p>' + escapeHtml(modes[t.autoResumeMode]?.description || modes['response-only'].description) + '</p><details><summary>외부 작업 영수증 · 정리 확인 방식에서만 필요</summary><label>영수증 절대 경로<input data-field="externalStateFile" value="' + escapeHtml(t.externalStateFile || '') + '"></label><label>영수증 SHA256<input data-field="externalStateSha256" value="' + escapeHtml(t.externalStateSha256 || '') + '" maxlength="64"></label></details></fieldset>';
  }).join('');
}
function renderWebJjonkuConfig(data) {
  webSupervisorData = data;
  webJjonkuEnabled.checked = data.config.enabled;
  webJjonkuCheckInterval.value = String(data.config.intervalSeconds);
  renderWebTargets(data.config.targets);
  renderWebPeerGrants(data.config.peerGrants ?? []);
  webJjonkuConfigStatus.textContent = data.isDefault ? '기본 꺼짐 · 선택 대화 없음' : '저장된 선택 ' + data.config.targets.length + '개';
  const runner = data.runner;
  const states = { OFF: '꺼짐', WATCHING: '감시 중', HOLD: '확인 필요', STOPPED: '종료' };
  webJjonkuLastRun.textContent = (runner.receiptFresh ? '최근 타이머 보고: ' + states[runner.reportedState] + ' · ' + new Date(runner.observedAt).toLocaleString('ko-KR') : runner.installationVerified ? '타이머 설치 확인 · 현재 기록은 오래됐거나 확인되지 않았습니다.' : '타이머 설치 기록 미확인') + ' · 메시지 전달과 외부 작업 완료는 별도입니다.' + (runner.peerDispatchSupported ? ' 대화 간 전달 기능 설치 확인.' : ' 대화 간 전달 기능은 아직 설치되지 않아 켜기가 제한됩니다.') + (data.legacyPreserved ? ' 과거 고정 목록 설정은 보존되며 자동 이관하지 않았습니다.' : '');
  webJjonkuConfigReady = true; saveWebJjonkuConfig.disabled = false; addWebJjonkuTarget.disabled = false; addWebPeerGrant.disabled = false;
}
async function loadWebJjonkuConfig() {
  const response = await fetch('/api/web-jjonku-monitor/config', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || '설정 조회 실패');
  renderWebJjonkuConfig(data);
}
async function saveWebJjonkuSettings(event) {
  event.preventDefault();
  if (!webJjonkuConfigReady || !webJjonkuConfigForm.reportValidity()) return;
  saveWebJjonkuConfig.disabled = true; webJjonkuConfigMessage.textContent = '선택한 계정과 대화 범위를 확인해 저장합니다.';
  try {
    const saved = await postJson('/api/web-jjonku-monitor/config', { schemaVersion: 1, expectedRevision: webSupervisorData.revision, enabled: webJjonkuEnabled.checked, intervalSeconds: Number(webJjonkuCheckInterval.value), targets: selectedWebTargets(), peerGrants: selectedWebPeerGrants() });
    renderWebJjonkuConfig(saved);
    webJjonkuConfigMessage.textContent = '선택 설정을 저장했습니다. 실제 실행은 연결된 감독기에서 확인해야 합니다.';
  } catch (error) { webJjonkuConfigMessage.textContent = '저장하지 못했습니다: ' + error.message; }
  finally { saveWebJjonkuConfig.disabled = false; }
}
addWebJjonkuTarget?.addEventListener('click', () => {
  if (!webSupervisorData) return;
  const targets = selectedWebTargets();
  if (targets.length >= 32) return;
  targets.push({ id: 'chat-' + crypto.randomUUID(), enabled: false, autoResume: false, role: webSupervisorData.roles.find(r => r.available)?.role || 'default', conversationUrl: '', autoResumeMode: 'response-only' });
  renderWebTargets(targets);
  renderWebPeerGrants(selectedWebPeerGrants());
});
webJjonkuTargets?.addEventListener('click', event => {
  const remove = event.target.closest('[data-remove-target]');
  if (remove) { renderWebTargets(selectedWebTargets().filter(t => t.id !== remove.dataset.removeTarget)); renderWebPeerGrants(selectedWebPeerGrants()); }
});
webJjonkuTargets?.addEventListener('change', event => {
  if (event.target.matches('[data-field="autoResumeMode"]')) renderWebTargets(selectedWebTargets());
  renderWebPeerGrants(selectedWebPeerGrants());
});
function selectedWebPeerGrants() {
  return [...webPeerGrants.querySelectorAll('[data-peer-grant]')].map(row => {
    const field = name => row.querySelector('[data-peer-field="' + name + '"]');
    return { id: row.dataset.peerGrant, enabled: field('enabled').checked, sourceTargetId: field('sourceTargetId').value,
      recipientIds: [...field('recipientIds').selectedOptions].map(option => option.value), purpose: field('purpose').value,
      templateText: field('templateText').value, expiresAt: field('expiresAt').value ? new Date(field('expiresAt').value).toISOString() : '',
      inputFields: field('inputFields').value.split('\n').filter(line => line.trim()).map(line => { const [name, limit] = line.split(':'); return { name: name.trim(), maxLength: Number(limit) }; }) };
  });
}
function renderWebPeerGrants(grants) {
  const targets = selectedWebTargets();
  webPeerGrants.innerHTML = grants.map(g => {
    const sourceId = g.sourceTargetId ?? g.source?.targetId ?? '';
    const recipientIds = g.recipientIds ?? g.recipients?.map(r => r.targetId) ?? [];
    const options = selected => targets.map(t => '<option value="' + escapeHtml(t.id) + '"' + (selected.includes(t.id) ? ' selected' : '') + '>' + escapeHtml(t.role + ' · ' + (t.conversationUrl || 'URL 미입력')) + '</option>').join('');
    const expiry = g.expiresAt ? new Date(g.expiresAt) : new Date(Date.now() + 86400000);
    const localExpiry = new Date(expiry.getTime() - expiry.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    return '<fieldset data-peer-grant="' + escapeHtml(g.id) + '"><legend>대화 간 전달 ' + escapeHtml(g.revision ? '· 승인 버전 ' + g.revision : '· 새 승인') + '</legend><label><input type="checkbox" data-peer-field="enabled"' + (g.enabled ? ' checked' : '') + '> 이 발신·수신 범위에 틀 전달 허용</label><div class="web-supervisor-row"><label>발신 대화<select data-peer-field="sourceTargetId"><option value="">선택하세요</option>' + options([sourceId]) + '</select></label><label>수신 대화 · Ctrl로 여러 개 선택<select data-peer-field="recipientIds" multiple size="3">' + options(recipientIds) + '</select></label><label>승인 만료<input type="datetime-local" data-peer-field="expiresAt" value="' + localExpiry + '" required></label></div><label>전달 목적<input data-peer-field="purpose" maxlength="200" value="' + escapeHtml(g.purpose || '') + '" required></label><label>전달할 정확한 틀 · 입력은 {{field_name}}으로 표시<textarea data-peer-field="templateText" maxlength="2000" rows="3" required>' + escapeHtml(g.templateText ?? g.template?.text ?? '') + '</textarea></label><label>허용 입력 · 한 줄에 field_name:최대길이(1~500)<textarea data-peer-field="inputFields" rows="2">' + escapeHtml((g.inputFields ?? []).map(f => f.name + ':' + f.maxLength).join('\n')) + '</textarea></label><p>입력값은 인용된 문자열로만 틀에 들어갑니다. 웹 응답의 자유 지시·승인 표시는 권한으로 사용하지 않습니다.</p><button type="button" data-remove-peer="' + escapeHtml(g.id) + '">승인 철회·목록에서 제외</button></fieldset>';
  }).join('');
}
addWebPeerGrant?.addEventListener('click', () => {
  if (!webSupervisorData) return;
  const grants = selectedWebPeerGrants(); if (grants.length >= 16) return;
  grants.push({ id: 'peer-' + crypto.randomUUID(), enabled: false, recipientIds: [], inputFields: [] }); renderWebPeerGrants(grants);
});
webPeerGrants?.addEventListener('click', event => {
  const remove = event.target.closest('[data-remove-peer]');
  if (remove) renderWebPeerGrants(selectedWebPeerGrants().filter(g => g.id !== remove.dataset.removePeer));
});
webJjonkuConfigForm?.addEventListener('submit', saveWebJjonkuSettings);

async function refreshUpstreamSignal() {
  refreshUpstreamMonitoring.disabled = true;
  try {
    if (!monitoringPreviewReady) {
      const preview = await postJson('/api/monitoring/upstream-preview', {});
      monitoringPreviewReady = {
        requestId: `manual-upstream-${crypto.randomUUID()}`,
        idempotencyKey: `manual-upstream-${crypto.randomUUID()}`
      };
      monitoringMessage.textContent = `${preview.sourceCount ?? '등록'}개 source를 owner-only snapshot으로 확인합니다. 자동 적용은 없으며, 다시 누르면 durable job만 생성합니다.`;
      refreshUpstreamMonitoring.textContent = '확인하고 감시 job 생성';
      return;
    }
    const queued = await postJson('/api/monitoring/upstream-refresh', { confirmed: true, ...monitoringPreviewReady });
    monitoringMessage.textContent = `durable job ${queued.job?.jobId || '생성됨'} · Dashboard는 scan을 실행하지 않습니다.`;
    monitoringPreviewReady = false;
    refreshUpstreamMonitoring.textContent = '업스트림 지금 확인';
    await loadMonitoring();
  } catch (error) {
    monitoringMessage.textContent = `업스트림을 확인하지 못했습니다: ${error.message}`;
    monitoringPreviewReady = false;
    refreshUpstreamMonitoring.textContent = '업스트림 지금 확인';
  } finally {
    refreshUpstreamMonitoring.disabled = false;
  }
}

function iconFor(item) {
  const icons = { dashboard: '⌂', status: '✓', 'workspace-mcp': 'M', 'codex-agents': 'A', 'auth-portal': '↥', codex: 'G', claude: 'C', ocx: 'O', 'web-gpt': 'W', accounts: '◎', workflows: '↗', system: '◇' };
  return icons[item.id] || icons[item.group] || '·';
}

function taskButtonLabel(item) {
  if (item.taskId) return '지금 확인';
  if (item.href) return '화면 열기';
  if (item.appId) return '앱 열기';
  if (item.webSection) return '이동';
  return '명령 복사';
}

function toolCard(item, compact = false) {
  return `<article class="tool-card${compact ? ' compact' : ''}" data-tool-id="${escapeHtml(item.id)}">
    <span class="tool-icon" aria-hidden="true">${escapeHtml(iconFor(item))}</span>
    <div class="tool-copy"><div class="tool-heading"><h3>${escapeHtml(item.title)}</h3>${item.taskId ? '<span class="capability">바로 실행</span>' : ''}</div><p>${escapeHtml(item.description)}</p>${compact ? '' : `<code>${escapeHtml(item.command)}</code>`}</div>
    <button type="button" class="tool-run" data-tool-run="${escapeHtml(item.id)}">${taskButtonLabel(item)}</button>
  </article>`;
}

function statusForJourney(journey) {
  if (!statusData) return { state: 'unknown', label: '확인 중', detail: '실시간 상태를 불러오고 있습니다.' };
  if (journey.statusComponent === 'project-catalog') {
    if (!projectData) return { state: 'unknown', label: '확인 중', detail: '로컬과 Notion snapshot을 각각 불러오고 있습니다.' };
    const drift = projectData.summary?.drift ?? 0;
    return { state: drift ? 'attention' : 'ready', label: drift ? `DRIFT ${drift}개` : '정본 분리 완료', detail: `${projectData.summary?.total ?? projectData.projects?.length ?? 0}개 catalog · 외부 write 없음` };
  }
  if (journey.statusComponent === 'knowledge-review') {
    if (!knowledgeData) return { state: 'unknown', label: '확인 중', detail: 'durable review ledger를 불러오고 있습니다.' };
    const pending = (knowledgeData.runningJobIds?.length ?? 0) + (knowledgeData.queuedJobIds?.length ?? 0);
    return pending
      ? { state: 'attention', label: `대기·실행 ${pending}`, detail: '공식 source job만 실행하며 자동 적용은 0입니다.' }
      : { state: 'standby', label: '수동 대기', detail: knowledgeData.latestRun ? `최근 ${knowledgeData.latestRun.outcome}` : 'current run 근거 없음' };
  }
  if (journey.statusComponent === 'local-access') {
    if (!localAccessData) return { state: 'unknown', label: '확인 중', detail: 'owner-only grant ledger를 불러오고 있습니다.' };
    const active = (localAccessData.grants ?? []).filter(grant => !grant.expired).length;
    return { state: active ? 'ready' : 'standby', label: active ? `active ${active}` : '명시 승인 대기', detail: 'exact root · TTL · denylist · read-only' };
  }
  const component = statusData.components.find(item => item.id === journey.statusComponent);
  if (!component) {
    if (journey.statusComponent === 'dashboard') return { state: statusData.summary.attention ? 'attention' : 'ready', label: statusData.summary.attention ? '일부 확인 필요' : '운영 준비', detail: `${statusData.summary.ready}/${statusData.summary.total} 구성 요소 준비` };
    if (journey.statusComponent === 'accounts') return { state: 'ready', label: '관리 가능', detail: '계정 상태는 인증 정보를 노출하지 않고 표시됩니다.' };
    if (journey.statusComponent === 'openai-usage') return { state: 'optional', label: '독립 가드', detail: 'API 사용량 구역은 다른 경로와 독립적으로 동작합니다.' };
    return { state: 'unknown', label: '근거 없음', detail: '이 기능의 실시간 상태 근거가 없습니다.' };
  }
  const state = component.state || 'unknown';
  return { state, label: state === 'ready' ? '지금 사용 가능' : state === 'optional' ? '선택 기능' : state === 'unavailable' ? '현재 사용 불가' : '확인 필요', detail: component.detail || '상세 상태를 확인하세요.' };
}

function renderProductGuide() {
  if (!product.journeys.length) return;
  const activeFlow = product.flows.find(flow => flow.id === activeFlowId) || product.flows[0] || { id: 'all', label: '전체 보기', description: '모든 기능 확인', journeyIds: product.journeys.map(item => item.id) };
  activeFlowId = activeFlow.id;
  const visibleJourneys = activeFlow.journeyIds.map(id => product.journeys.find(journey => journey.id === id)).filter(Boolean);
  $('#guideJourneyCount').textContent = visibleJourneys.length;
  $('#guideToolCount').textContent = catalog.items.length || '–';
  $('#guideActionCount').textContent = product.inventory?.actionCount ?? '–';
  flowSelector.innerHTML = product.flows.map(flow => `<button type="button" class="flow-option${flow.id === activeFlow.id ? ' active' : ''}" data-flow="${escapeHtml(flow.id)}" aria-pressed="${flow.id === activeFlow.id}"><strong>${escapeHtml(flow.label)}</strong><small>${escapeHtml(flow.description)}</small></button>`).join('');
  activeFlowSummary.innerHTML = `<span>${escapeHtml(activeFlow.label)}</span><strong>${visibleJourneys.map((journey, index) => `${String(index + 1).padStart(2, '0')} ${journey.title.replace(/하기$/, '')}`).join(' → ')}</strong>`;
  capabilityGuide.innerHTML = visibleJourneys.map((journey, index) => {
    const live = statusForJourney(journey);
    const tool = journey.toolIds.map(id => catalog.items.find(item => item.id === id)).find(item => item?.taskId);
    return `<article class="journey-card accent-${escapeHtml(journey.accent)} ${escapeHtml(live.state)}" data-journey-card="${escapeHtml(journey.id)}">
      <button class="journey-summary" type="button" aria-expanded="${index === 0}" aria-controls="journey-${escapeHtml(journey.id)}">
        <span class="journey-index">${String(index + 1).padStart(2, '0')}</span>
        <span class="journey-title"><small>${escapeHtml(journey.eyebrow)}</small><strong>${escapeHtml(journey.title)}</strong><em>${escapeHtml(journey.outcome)}</em></span>
        <span class="journey-live"><i></i><b>${escapeHtml(live.label)}</b><small>${escapeHtml(live.detail)}</small></span>
        <span class="journey-chevron" aria-hidden="true">⌄</span>
      </button>
      <div id="journey-${escapeHtml(journey.id)}" class="journey-detail" ${index === 0 ? '' : 'hidden'}>
        <div class="journey-why"><span>언제 사용하나요?</span><p>${escapeHtml(journey.when)}</p></div>
        <div class="journey-columns">
          <div><span class="detail-label">먼저 준비할 것</span><ul>${journey.prerequisites.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>
          <div><span class="detail-label">따라 하기</span><ol>${journey.steps.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ol></div>
        </div>
        <div class="journey-outcomes"><p><span>성공 확인</span>${escapeHtml(journey.success)}</p><p><span>문제가 생기면</span>${escapeHtml(journey.recovery)}</p></div>
        <div class="journey-actions"><a class="button-link" href="#${escapeHtml(journey.section)}">상세 화면 열기</a>${tool ? `<button type="button" class="secondary" data-tool-run="${escapeHtml(tool.id)}">${escapeHtml(tool.title)} 실행</button>` : ''}<span>${journey.toolIds.length}개 관련 도구</span></div>
      </div>
    </article>`;
  }).join('');
  glossaryGrid.innerHTML = product.glossary.map(item => `<div><dt>${escapeHtml(item.term)}</dt><dd>${escapeHtml(item.meaning)}</dd></div>`).join('');
  requestAnimationFrame(() => document.querySelectorAll('[data-journey-card]').forEach(card => card.classList.add('revealed')));
}

function plannedPrompt() {
  const flow = product.flows.find(item => item.id === activeFlowId) || product.flows[0];
  const brief = taskBrief.value.trim();
  if (!brief) return '';
  const safeguards = {
    daily: '현재 프로젝트 경계를 먼저 확인하고, 필요한 도구만 사용해 구현·검증한 뒤 결과와 남은 UNKNOWN을 보고해.',
    team: 'web-gpt-orchestrator를 사용해 coordinator→researcher(read-only)→critic(read-only)→writer(정확히 1명)→verifier(read-only)→cleanup 역할 DAG로 실행해. 쓰기 범위와 성공 조건을 먼저 고정하고 active run과 lease를 0으로 정리해.',
    provider: '현재 provider·계정·route와 active turn을 읽기 전용으로 확인해. 기존 작업을 중단하거나 계정·provider를 조용히 바꾸지 말고 필요한 변경은 영향·rollback과 함께 제안 또는 실행해.',
    remote: '등록된 workspace와 만료 lease 경계를 확인하고, 원격 도구가 광고한 capability만 사용해. 비밀·인증·등록되지 않은 경로는 열지 말고 결과와 검증 근거를 남겨.',
    recover: 'Web GPT·OCX·Native·Workspace를 각각 진단해 정상 경로는 보존하고 고장 난 구성 요소만 복구해. UNKNOWN을 0으로 간주하지 말고 재시작 전후 생존 경로와 rollback을 검증해.',
    operate: '현재 owner·manifest·버전·active writer를 확인하고 관리 정본을 통해서만 변경해. 생성된 home을 직접 편집하지 말고 테스트·privacy·rollback 근거를 남겨.',
    all: '전체 구조와 소유 경계를 먼저 확인하고, 작업을 최소 단계로 나눠 구현·검증해. 완료·미적용·HOLD·UNKNOWN을 구분해 보고해.'
  };
  return `[AICC 작업 흐름: ${flow?.label || '전체'}]\n\n목표: ${brief}\n\n진행 원칙: ${safeguards[activeFlowId] || safeguards.all}`;
}

function renderActivity(data) {
  if (!activitySummary) return;
  const find = id => data.components.find(component => component.id === id);
  const jobs = find('job-manager');
  const items = [
    ['DURABLE JOBS', jobs, '내구 작업과 역할 run'],
    ['WRITERS', jobs ? { ...jobs, label: '현재 쓰기 소유권', detail: `활성 writer ${jobs.activeWriters ?? 0}개 · orchestration run ${jobs.orchestrationRuns ?? 0}개` } : null, '현재 쓰기 소유권'],
    ['CODEX AGENTS', find('codex-agents'), '로컬 agent 작업'],
    ['BROWSER LEASES', find('browser-broker'), '소유 target과 사용자 탭 분리'],
    ['EXTENSIONS', find('extensions'), 'plugin·skill package 무결성']
  ];
  activitySummary.innerHTML = items.map(([eyebrow, component, fallback]) => {
    const state = component?.state || 'unknown';
    const ready = ['ready', 'optional'].includes(state);
    return `<article class="activity-card ${ready ? 'ready' : 'attention'}"><span>${escapeHtml(eyebrow)}</span><strong>${escapeHtml(component?.label || fallback)}</strong><p>${escapeHtml(component?.detail || '현재 상태 근거가 없습니다.')}</p><small>${ready ? '정상 범위' : '읽기 전용 점검 권장'}</small></article>`;
  }).join('');
}

function recommendedToolFor(component) {
  const map = {
    'web-gpt': 'web-gpt-doctor', ocx: 'ocx-diagnostics', 'workspace-mcp': 'workspace-mcp',
    'codex-routes': 'routes-status', guidance: 'guidance-check', agents: 'codex-agents',
    compatibility: 'compatibility-status', browser: 'status', extensions: 'status'
  };
  return catalog.items.find(item => item.id === map[component.id]) || catalog.items.find(item => item.id === 'status');
}

function renderAttention(data) {
  const items = data.components.filter(component => !['ready', 'optional'].includes(component.state));
  attentionSummary.textContent = items.length ? `${items.length}개 항목 · 읽기 전용 점검부터 권장` : '확인할 문제가 없습니다. 현재 경로를 그대로 사용하세요.';
  if (!items.length) {
    attentionQueue.innerHTML = `<article class="attention-clear"><span class="clear-mark">✓</span><div><strong>모든 핵심 경로가 준비되었습니다.</strong><p>불필요한 재시작이나 설정 변경 없이 현재 작업을 계속할 수 있습니다.</p></div><a class="button-link secondary" href="#guide">기능 둘러보기</a></article>`;
    return;
  }
  attentionQueue.innerHTML = items.map((component, index) => {
    const view = componentPresentation(component);
    const tool = recommendedToolFor(component);
    return `<article class="attention-item ${escapeHtml(view.stateClass)}"><span class="attention-number">${String(index + 1).padStart(2, '0')}</span><div><small>${escapeHtml(view.label)}</small><strong>${escapeHtml(component.label)}</strong><p>${escapeHtml(component.detail)}</p>${view.hint ? `<em>${escapeHtml(view.hint)}</em>` : ''}</div>${tool ? `<button type="button" class="secondary" data-tool-run="${escapeHtml(tool.id)}">${escapeHtml(tool.title)}</button>` : ''}</article>`;
  }).join('');
}

function renderCodexWorkGate(data) {
  if (!repairGateState || !repairGateDetail || !repairSequenceList || !repairScope) return;
  const activeCount = Number.isSafeInteger(data?.activeCount) && data.activeCount >= 0 ? data.activeCount : null;
  const unknownCount = Number.isSafeInteger(data?.unknownCount) && data.unknownCount >= 0 ? data.unknownCount : null;
  const readOk = data?.readOk === true && activeCount !== null && unknownCount !== null;
  const stages = Array.isArray(data?.sequence?.stages) ? data.sequence.stages : [];

  let gateClass = 'unknown';
  if (!readOk || unknownCount > 0 || (data?.exactIdle === false && activeCount === 0)) {
    repairGateState.textContent = unknownCount > 0 ? `UNKNOWN ${unknownCount}` : 'UNKNOWN';
    repairGateDetail.textContent = '정비에 필요한 유휴 상태를 증명하지 못했습니다. 현재 연결을 끊는 수리·재시작은 보류합니다. 승인된 독립 소스 작업은 계속할 수 있습니다.';
  } else if (activeCount > 0) {
    gateClass = 'partial';
    repairGateState.textContent = `ACTIVE ${activeCount}`;
    repairGateDetail.textContent = '진행 중인 작업이 있어 이 연결의 수리·재시작은 보류합니다. 승인된 독립 소스 작업은 계속할 수 있습니다.';
  } else {
    gateClass = 'verified';
    repairGateState.textContent = 'EXACT IDLE';
    repairGateDetail.textContent = 'ACTIVE와 UNKNOWN이 모두 0입니다. 아래에서 표시된 한 단계의 읽기 전용 확인만 다음으로 진행할 수 있습니다.';
  }
  repairGateState.className = `ledger-verdict ${gateClass}`;

  const scopeLabels = {
    'source-test-documentation-only': '정비 대기 중 가능: 승인된 독립 소스·허용된 검사·문서',
    'component-scoped-one-shot-after-preflight': '지금 가능: 표시된 한 단계의 읽기 전용 확인',
    'reconcile-only': '지금 가능: 기존 시도 조정만',
    none: '남은 단계 없음'
  };
  repairScope.textContent = scopeLabels[data?.sequence?.allowedScope ?? data?.allowedScope]
    ?? '지금 가능: 상태 재확인만';

  if (!stages.length) {
    repairSequenceList.setAttribute('aria-busy', 'false');
    repairSequenceList.innerHTML = '<li class="repair-stage blocked"><span>–</span><div><strong>수리 순서 UNKNOWN</strong><p>추론으로 다음 단계를 만들지 않습니다.</p></div><em>중지</em></li>';
    return;
  }

  const stateLabels = { complete: '완료', current: '다음 확인', blocked: '중지·조정', waiting: '대기' };
  repairSequenceList.setAttribute('aria-busy', 'false');
  repairSequenceList.innerHTML = stages.map((stage, index) => {
    const state = ['complete', 'current', 'blocked', 'waiting'].includes(stage.state) ? stage.state : 'blocked';
    const showContract = state === 'current' || state === 'blocked';
    const detail = showContract ? `<p>${escapeHtml(stage.detail || '세부 근거가 없습니다.')}</p>` : '';
    return `<li class="repair-stage ${escapeHtml(state)}"><span>${String(index + 1).padStart(2, '0')}</span><div><strong>${escapeHtml(stage.label || stage.id || '이름 없는 단계')}</strong>${detail}</div><em>${escapeHtml(stage.outcome || stateLabels[state])}</em>${showContract ? `<dl class="repair-stage-contract"><div><dt>백업</dt><dd>${escapeHtml(stage.backup || 'UNKNOWN')}</dd></div><div><dt>성공</dt><dd>${escapeHtml(stage.success || 'UNKNOWN')}</dd></div><div><dt>중지</dt><dd>${escapeHtml(stage.stop || 'UNKNOWN')}</dd></div></dl>` : ''}</li>`;
  }).join('');
}

function renderCatalog() {
  quickTools.innerHTML = catalog.items.filter(item => item.featured).map(item => toolCard(item, true)).join('');
  toolFilters.innerHTML = [{ id: 'all', label: '전체' }, ...catalog.groups]
    .map(group => `<button type="button" class="filter-chip${activeFilter === group.id ? ' active' : ''}" data-filter="${escapeHtml(group.id)}" aria-pressed="${activeFilter === group.id}">${escapeHtml(group.label)}</button>`).join('');
  const items = activeFilter === 'all' ? catalog.items : catalog.items.filter(item => item.group === activeFilter);
  toolLibrary.innerHTML = items.map(item => toolCard(item)).join('');
  renderProductGuide();
}

function renderArchitectureFilter() {
  document.querySelectorAll('[data-architecture-filter]').forEach(button => {
    const selected = button.dataset.architectureFilter === activeArchitectureFilter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.querySelectorAll('[data-map-groups]').forEach(element => {
    const groups = String(element.dataset.mapGroups || '').split(/\s+/).filter(Boolean);
    element.classList.toggle('is-dimmed', activeArchitectureFilter !== 'all' && !groups.includes(activeArchitectureFilter));
  });
}

function renderLiveMapState(id, ready, label, detail) {
  const pill = document.querySelector(`[data-live-state="${id}"]`);
  if (pill) {
    pill.textContent = label;
    pill.classList.toggle('ready', ready === true);
    pill.classList.toggle('attention', ready !== true);
  }
  document.querySelectorAll(`[data-live-detail="${id}"]`).forEach(element => { element.textContent = detail; });
}

function compactNumber(value) {
  if (!Number.isFinite(value)) return '–';
  return new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '–';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(amount >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '–';
}

function routeLabel(route) {
  return ({ 'web-gpt': '통합 Web GPT 브리지', ocx: 'OCX 직접 연결', native: 'Native Codex', custom: '사용자 지정 경로' })[route] || '알 수 없는 경로';
}

function renderOcxModules(ocx) {
  const sections = ocx?.sections || {};
  const cards = [
    ['providers', 'Provider', sections.providers, `${sections.providers?.count ?? '–'}개 · 기본 ${sections.providers?.defaultProvider || '미확인'}`, (sections.providers?.items || []).map(item => item.name).filter(Boolean).join(' · ') || '목록 없음'],
    ['models', '모델 catalog', sections.models, `${sections.models?.count ?? '–'}개`, (sections.models?.byProvider || []).map(item => `${item.provider} ${item.count}`).join(' · ') || 'Provider별 수량 미확인'],
    ['usage', '30일 사용량', sections.usage, `${compactNumber(sections.usage?.requests)}회`, `token ${compactNumber(sections.usage?.totalTokens)} · 측정 ${percent(sections.usage?.coverageRatio)}`],
    ['runtime', '런타임·시작', sections.runtime, sections.runtime?.serviceRunning ? '서비스 실행 중' : '서비스 확인 필요', `RSS ${formatBytes(sections.runtime?.rssBytes)} · 작업 ${sections.runtime?.activeTurns ?? '–'}개`],
    ['agents', '하위 에이전트', sections.agents, `${sections.agents?.chosenCount ?? '–'}개 선택`, `모드 ${sections.agents?.multiAgentMode || '미확인'} · fallback ${sections.agents?.fallbackCount ?? '–'}`],
    ['combos', 'Combo', sections.combos, `${sections.combos?.count ?? '–'}개`, 'failover · round-robin 가상 모델'],
    ['storage', '저장소', sections.storage, formatBytes(sections.storage?.totalBytes), `${compactNumber(sections.storage?.fileCount)}개 파일 · 민감 경로 미표시`],
    ['diagnostics', '진단', sections.diagnostics, sections.diagnostics?.warningCount === 0 ? '경고 없음' : `${sections.diagnostics?.warningCount ?? '–'}개 경고`, `${sections.diagnostics?.groupCount ?? '–'}개 진단 그룹`],
    ['endpoints', '로컬 API', sections.endpoints, `${sections.endpoints?.endpointCount ?? '–'}개 endpoint`, sections.endpoints?.baseUrl || 'loopback endpoint 미확인']
  ];
  ocxModules.innerHTML = cards.map(([id, title, section, value, detail], index) => {
    const ready = section?.state === 'ready';
    return `<article class="ocx-module-card ${ready ? 'ready' : 'attention'}" data-ocx-module="${escapeHtml(id)}"><span>${String(index + 1).padStart(2, '0')}</span><div><strong>${escapeHtml(title)}</strong><b>${escapeHtml(value)}</b><small>${escapeHtml(detail)}</small></div><i>${ready ? '정상' : section?.state === 'timeout' ? '시간 초과' : '독립 실패'}</i></article>`;
  }).join('');
}

function matchingTools(query) {
  const terms = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return catalog.items.filter(item => {
    const haystack = [item.title, item.description, item.command, ...(item.keywords || [])].join(' ').toLocaleLowerCase();
    return terms.every(term => haystack.includes(term));
  }).slice(0, 8);
}

function renderSearch() {
  const matches = matchingTools(toolSearch.value);
  const hasQuery = Boolean(toolSearch.value.trim());
  searchIndex = Math.max(0, Math.min(searchIndex, Math.max(0, matches.length - 1)));
  searchResults.hidden = !hasQuery;
  toolSearch.setAttribute('aria-expanded', String(hasQuery));
  toolSearch.setAttribute('aria-activedescendant', matches.length ? `search-result-${searchIndex}` : '');
  searchResults.innerHTML = matches.length
    ? matches.map((item, index) => `<button id="search-result-${index}" type="button" role="option" aria-selected="${index === searchIndex}" class="${index === searchIndex ? 'selected' : ''}" data-search-index="${index}" data-tool-run="${escapeHtml(item.id)}"><span class="tool-icon">${escapeHtml(iconFor(item))}</span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.description)}</small></span><code>${escapeHtml(item.command)}</code></button>`).join('')
    : '<p>일치하는 도구가 없습니다. 다른 표현으로 찾아보세요.</p>';
}

function showDiagnosticResult(item, taskResult) {
  const preflight = taskResult.result;
  const isWorkspacePreflight = Object.values(workspacePublicationSurfaces).some(surface => surface.taskId === item.taskId);
  const view = isWorkspacePreflight && preflight?.publication ? {
    tone: 'attention',
    headline: `${workspacePublicationSurfaces[preflight.surfaceProfile].label} 사전검사 자료입니다.`,
    detail: `${preflight.runtime?.detail || '실행 상태 미확인'} ${preflight.handoff?.detail || '공식 화면에서 Scan Tools → 검토 → 게시 1회와 원격 결과 확인이 필요합니다.'}`,
    highlights: [
      { label: '전체 도구', value: `${preflight.publication.toolCount}개`, tone: 'muted' },
      { label: '읽기', value: `${preflight.publication.readToolCount}개`, tone: 'muted' },
      { label: '쓰기', value: `${preflight.publication.writeToolCount}개`, tone: 'muted' },
      { label: 'LOCAL 결속', value: preflight.runtime?.localBinding?.identityBinding || '미확인', tone: 'muted' },
      { label: '실제 원격 게시', value: '이 검사로 확인하지 않음', tone: 'attention' }
    ]
  } : diagnosticPresentation(item.taskId, taskResult);
  resultDialog.className = `result-dialog ${view.tone}`;
  resultSummary.innerHTML = `<strong>${escapeHtml(view.headline)}</strong><span>${escapeHtml(view.detail)}</span>`;
  resultHighlights.innerHTML = view.highlights.map(highlight => `<div class="result-highlight ${escapeHtml(highlight.tone)}"><span>${escapeHtml(highlight.label)}</span><strong>${escapeHtml(highlight.value)}</strong></div>`).join('');
  resultHighlights.hidden = !view.highlights.length;
  resultDetails.open = false;
}

async function copyCommand(command) {
  try {
    await writeClipboardText(command);
    actionMessage.textContent = `명령을 복사했습니다: ${command}`;
  } catch {
    window.prompt('아래 명령을 복사하세요.', command);
  }
}

async function runTask(item) {
  const isWorkspacePreflight = Object.values(workspacePublicationSurfaces).some(surface => surface.taskId === item.taskId);
  let surfaceProfile;
  if (isWorkspacePreflight) {
    try { surfaceProfile = selectedWorkspacePublicationSurface(); }
    catch (error) { actionMessage.textContent = error.message; return; }
    const surface = workspacePublicationSurfaces[surfaceProfile];
    // The existing endpoint accepts taskId only; each ID binds one exact surface.
    item = { ...item, taskId: surface.taskId, title: `${surface.label} 게시 사전검사` };
  }
  resultDialog.showModal();
  resultDialog.setAttribute('aria-busy', 'true');
  resultDialog.className = 'result-dialog loading';
  resultTitle.textContent = item.title;
  resultSummary.innerHTML = '<strong>안전한 조회 작업을 실행하고 있습니다.</strong><span>완료될 때까지 이 창을 열어 두세요.</span>';
  resultHighlights.hidden = true;
  resultHighlights.innerHTML = '';
  resultDetails.open = true;
  resultOutput.textContent = '확인 중…';
  try {
    const result = await postJson('/api/tasks/run', { taskId: item.taskId }, { acceptFindings: true });
    if (isWorkspacePreflight) {
      if (result.result?.surfaceProfile !== surfaceProfile || result.result?.publication?.surfaceProfile !== surfaceProfile) {
        throw new Error('선택한 표면의 사전검사 응답이 없습니다. 소스 준비 상태만 참고하고 공식 화면에서 별도로 확인하세요.');
      }
      workspacePreflightResults.set(surfaceProfile, result.result);
      renderWorkspaceSurface(statusData);
    }
    showDiagnosticResult(item, result);
    resultOutput.textContent = typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2);
    if (item.taskId === 'status') await loadStatus();
  } catch (error) {
    resultDialog.className = 'result-dialog attention';
    resultSummary.innerHTML = '<strong>작업을 완료하지 못했습니다.</strong><span>아래 기술 정보를 확인해 주세요.</span>';
    resultHighlights.hidden = true;
    resultDetails.open = true;
    resultOutput.textContent = error.message;
  } finally {
    resultDialog.setAttribute('aria-busy', 'false');
  }
}

async function activateTool(item) {
  searchResults.hidden = true;
  toolSearch.setAttribute('aria-expanded', 'false');
  if (item.taskId) return runTask(item);
  if (item.id === 'auth-portal') {
    const opened = window.open('', '_blank');
    try {
      const result = await postJson('/api/apps/open', { appId: item.id });
      if (opened) opened.location = result.url;
      else window.location.href = result.url;
    } catch (error) {
      opened?.close();
      actionMessage.textContent = error.message;
    }
    return;
  }
  if (item.appId) {
    try {
      await postJson('/api/apps/open', { appId: item.appId });
      actionMessage.textContent = `${item.title}을(를) 열었습니다.`;
    } catch (error) { actionMessage.textContent = error.message; }
    return;
  }
  if (item.href) return window.open(item.href, '_blank', 'noopener');
  if (item.webSection) {
    document.querySelector(`#${item.webSection}`)?.scrollIntoView({ behavior: 'smooth' });
    if (item.action && item.action !== 'account.switch') return previewAction(item.action);
    return;
  }
  return copyCommand(item.command);
}

async function postJson(path, body, options = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || (data.ok === false && !options.acceptFindings)) {
    throw new Error(data.error || data.message || `HTTP ${response.status}`);
  }
  return data;
}

function fillAccounts(data) {
  const accountComponent = data.components.find(component => component.id === 'accounts');
  const accounts = accountComponent?.accounts ?? [];
  accountSelector.innerHTML = accounts.length
    ? accounts.map(account => `<option value="${escapeHtml(account.account)}" ${account.expired || account.is_app_active ? 'disabled' : ''}>${escapeHtml(account.account)}${account.is_app_active ? ' (현재)' : account.expired ? ' (만료)' : ''}</option>`).join('')
    : '<option value="">전환 가능한 계정 없음</option>';
  const firstAvailable = accounts.find(account => !account.expired && !account.is_app_active);
  accountSelector.value = firstAvailable?.account ?? '';
  switchAccount.disabled = !firstAvailable;
  accountCards.innerHTML = accounts.length ? accounts.map(account => {
    const available = account.quota?.long_remaining_percent;
    const remaining = Number.isFinite(available) ? `${available}% 남음` : '한도 미확인';
    return `<article class="account-card${account.is_app_active ? ' active' : ''}"><div><span class="avatar">${escapeHtml(String(account.account || '?').slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(account.account)}</strong><small>${escapeHtml(account.plan || '요금제 미확인')} · ${escapeHtml(remaining)}</small>${Number.isFinite(available) ? `<progress value="${100 - available}" max="100" aria-label="장기 할당량 사용률">${100 - available}%</progress>` : ''}</span></div><span class="account-state">${account.is_app_active ? '현재 계정' : account.expired ? '갱신 필요' : '사용 가능'}</span></article>`;
  }).join('') : '<p class="empty">표시할 계정이 없습니다.</p>';
}

function fillOcxAccounts(data) {
  const component = data.components.find(item => item.id === 'ocx-accounts');
  const accounts = component?.accounts ?? [];
  ocxAccountSelector.innerHTML = accounts.length
    ? accounts.map(account => `<option value="${escapeHtml(account.id)}" ${account.active || account.needsReauth || account.paused ? 'disabled' : ''}>${escapeHtml(account.label || account.email || account.id)}${account.active ? ' (현재)' : account.needsReauth ? ' (재인증 필요)' : account.paused ? ' (일시 정지)' : ''}</option>`).join('')
    : '<option value="">전환 가능한 OCX 계정 없음</option>';
  const firstAvailable = accounts.find(account => !account.active && !account.needsReauth && !account.paused);
  ocxAccountSelector.value = firstAvailable?.id ?? '';
  switchOcxAccount.disabled = !firstAvailable;
  ocxAccountCards.innerHTML = accounts.length ? accounts.map(account => {
    const name = account.label || account.email || account.id;
    const state = account.active ? '현재 라우팅' : account.needsReauth ? '재인증 필요' : account.paused ? '일시 정지' : '사용 가능';
    const weeklyRemaining = account.quota?.weeklyRemainingPercent;
    const monthlyRemaining = account.quota?.monthlyRemainingPercent;
    const resetAt = account.quota?.weeklyResetAt || account.quota?.monthlyResetAt;
    const quotaLabel = Number.isFinite(weeklyRemaining) ? `주간 ${weeklyRemaining}% 남음` : Number.isFinite(monthlyRemaining) ? `월간 ${monthlyRemaining}% 남음` : account.needsReauth ? '재인증 후 확인' : '할당량 미확인';
    const used = Number.isFinite(weeklyRemaining) ? 100 - weeklyRemaining : Number.isFinite(monthlyRemaining) ? 100 - monthlyRemaining : null;
    return `<article class="account-card quota-card${account.active ? ' active' : ''}"><div><span class="avatar">${escapeHtml(String(name || '?').slice(0, 1).toUpperCase())}</span><span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(account.plan || '요금제 미확인')} · ${escapeHtml(quotaLabel)}</small>${Number.isFinite(used) ? `<progress value="${used}" max="100" aria-label="${escapeHtml(name)} 할당량 사용률">${used}%</progress>` : ''}${resetAt ? `<em>${escapeHtml(new Date(resetAt * 1000).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }))} 초기화</em>` : ''}</span></div><span class="account-state">${escapeHtml(state)}</span></article>`;
  }).join('') : '<p class="empty">OCX 계정 풀을 표시할 수 없습니다.</p>';
}

async function previewAction(action, args = {}) {
  actionMessage.textContent = '변경 내용을 확인 중입니다.';
  openaiActionMessage.textContent = '변경 내용을 확인 중입니다.';
  if (action === 'design-sources.apply') designSourceMessage.textContent = '선택한 원본의 exact commit 적용 계획을 만들고 있습니다.';
  if (action.startsWith('project-service.')) monitoringMessage.textContent = '프로젝트 묶음의 현재 연결과 LaunchAgent 상태를 확인하고 있습니다.';
  if (action === 'codex-cli.update') monitoringMessage.textContent = 'Codex 설치 방식, 최신 안정판, active/UNKNOWN 작업과 rollback을 확인하고 있습니다.';
  if (action === 'aicc.restore.latest') latestRecoveryMessage.textContent = '봉인된 복구점과 exact-idle 상태를 다시 확인하고 있습니다.';
  try {
    const preview = await postJson('/api/actions/preview', { action, args });
    confirmationToken = preview.confirmationToken;
    confirmationAction = action;
    dialogTitle.textContent = preview.title;
    dialogImpact.textContent = preview.impact;
    dialogWarnings.innerHTML = (preview.warnings ?? []).map(item => `<li>${escapeHtml(item)}</li>`).join('');
    dialogRollback.textContent = `복구 방법: ${preview.rollback}`;
    actionMessage.textContent = '';
    openaiActionMessage.textContent = '';
    if (action === 'design-sources.apply') designSourceMessage.textContent = '미리보기를 확인한 뒤 실행 여부를 결정하세요.';
    if (action.startsWith('project-service.')) monitoringMessage.textContent = '영향과 복구 순서를 확인한 뒤 실행 여부를 결정하세요.';
    if (action === 'codex-cli.update') monitoringMessage.textContent = '영향과 이전 release 복구점을 확인한 뒤 실행 여부를 결정하세요.';
    if (action === 'aicc.restore.latest') latestRecoveryMessage.textContent = '영향과 복구 대상을 확인한 뒤 한 번만 실행하세요.';
    actionDialog.showModal();
  } catch (error) {
    confirmationToken = null;
    confirmationAction = null;
    actionMessage.textContent = error.message;
    openaiActionMessage.textContent = error.message;
    if (action === 'design-sources.apply') designSourceMessage.textContent = error.message;
    if (action.startsWith('project-service.')) monitoringMessage.textContent = error.message;
    if (action === 'codex-cli.update') monitoringMessage.textContent = error.message;
    if (action === 'aicc.restore.latest') latestRecoveryMessage.textContent = error.message;
  }
}

async function executeAction() {
  if (!confirmationToken) return;
  const token = confirmationToken;
  const action = confirmationAction;
  confirmationToken = null;
  confirmationAction = null;
  confirmAction.disabled = true;
  actionMessage.textContent = '작업을 실행하고 결과를 확인 중입니다.';
  openaiActionMessage.textContent = '작업을 실행하고 결과를 확인 중입니다.';
  if (action === 'aicc.restore.latest') latestRecoveryMessage.textContent = '정확히 한 구성요소를 복구하고 사후 상태를 확인 중입니다.';
  try {
    const result = await postJson('/api/actions/execute', { confirmationToken: token });
    actionMessage.textContent = `${result.title}: ${result.message}`;
    openaiActionMessage.textContent = `${result.title}: ${result.message}`;
    if (result.action === 'design-sources.apply') {
      designSourceMessage.textContent = `${result.title}: ${result.message}`;
      selectedDesignSources.clear();
    }
    if (result.action?.startsWith('project-service.')) monitoringMessage.textContent = `${result.title}: ${result.message}`;
    if (result.action === 'codex-cli.update') monitoringMessage.textContent = `${result.title}: ${result.message}`;
    if (result.action === 'aicc.restore.latest') latestRecoveryMessage.textContent = `${result.title}: ${result.message}`;
    await load();
  } catch (error) {
    actionMessage.textContent = error.message;
    designSourceMessage.textContent = error.message;
    if (action === 'aicc.restore.latest') latestRecoveryMessage.textContent = error.message;
  } finally {
    confirmAction.disabled = false;
  }
}

function renderLatestRecovery(data) {
  latestRecoveryData = data;
  const gateKnown = data?.gate?.readOk === true
    && Number.isInteger(data?.gate?.activeCount)
    && Number.isInteger(data?.gate?.unknownCount);
  const ready = data?.available === true && data?.state === 'ready' && gateKnown && data.gate.exactIdle === true;
  latestRecoveryState.textContent = data?.state === 'applied' ? '복구 완료' : ready ? '실행 가능' : data?.state === 'hold' ? '대기' : '확인 불가';
  latestRecoveryState.className = `capability ${data?.state === 'applied' || ready ? 'ready' : data?.state === 'hold' ? 'hold' : 'unknown'}`;
  latestRecoveryTarget.textContent = data?.component || '–';
  latestRecoveryUpdated.textContent = data?.updatedAt ? new Date(data.updatedAt).toLocaleString('ko-KR') : '–';
  latestRecoveryButton.disabled = !ready;
  latestRecoveryButton.textContent = ready
    ? '최신 안전 복구 열기'
    : data?.state === 'applied'
      ? '복구 완료 · 재실행 금지'
    : !gateKnown
      ? '작업 상태 확인 불가'
      : !data?.available
        ? '봉인된 복구점 없음'
        : data.gate.activeCount > 0 || data.gate.unknownCount > 0
          ? '다른 작업 종료 후 가능'
          : '복구 사전검사 HOLD';
  latestRecoveryDetail.textContent = ready
    ? '현재 Codex ACTIVE와 UNKNOWN이 모두 0이며 봉인된 status·dry-run이 통과했습니다.'
    : data?.state === 'applied'
      ? '이 복구점은 이미 한 번 실행됐습니다. 같은 복구를 다시 보내지 않습니다.'
    : !gateKnown
      ? 'ACTIVE/UNKNOWN을 정확히 읽지 못해 복구를 닫았습니다.'
      : data.gate.activeCount > 0 || data.gate.unknownCount > 0
        ? `현재 Codex active ${data.gate.activeCount}, UNKNOWN ${data.gate.unknownCount}입니다. 다른 경로는 건드리지 않습니다.`
        : data?.status?.summary || '복구점을 안전하게 실행할 근거가 부족해 HOLD합니다.';
  latestRecoveryButton.title = latestRecoveryDetail.textContent;
}

async function loadLatestRecoveryStatus() {
  const response = await fetch('/api/recovery/latest', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`);
  renderLatestRecovery(data);
  return data;
}

function renderWorkspaceSurface(data = statusData) {
  const surfaceProfile = $('#workspacePublicationSurface').value;
  const validSurface = Object.hasOwn(workspacePublicationSurfaces, surfaceProfile);
  const label = validSurface ? workspacePublicationSurfaces[surfaceProfile].label : '알 수 없는 게시 대상';
  const allComponents = data?.components || [];
  const component = validSurface ? allComponents.find(candidate =>
    ['workspace-mcp', 'workspace-mcp-business', 'workspace-mcp-personal'].includes(candidate.id)
    && (candidate.surfaceProfile === surfaceProfile
      || (surfaceProfile === 'business-full' && candidate.id === 'workspace-mcp' && candidate.surfaceProfile === undefined))) : null;
  const preflight = validSurface ? workspacePreflightResults.get(surfaceProfile) : null;
  const runtime = component || preflight?.runtime;
  const candidatePublication = component?.publication || preflight?.publication;
  const publication = candidatePublication && (candidatePublication.surfaceProfile === surfaceProfile
    || (component && candidatePublication.surfaceProfile === undefined)) ? candidatePublication : null;
  const source = validSurface ? allComponents.find(candidate => candidate.id === 'workspace-app-sync')?.surfaces?.find(candidate =>
    candidate.surfaceProfile === surfaceProfile && (surfaceProfile !== 'personal-read-fetch' || candidate.writeToolCount === 0)) : null;
  const snapshot = publication || source;
  const tools = publication?.tools || [];
  const tunnelReady = runtime?.tunnel?.ready === true || runtime?.tunnelReady === true;
  $('#workspacePreflight').disabled = !validSurface;
  $('#workspacePublishSurfaceLabel').textContent = `${label} 게시 사전검사`;
  $('#workspaceDetail').textContent = `${label}: ${runtime?.detail || '선택한 표면의 실행 상태 자료가 없습니다. 소스 준비 상태와 공식 화면 인계만 안내합니다.'}`;
  $('#workspaceIndicator').classList.toggle('online', runtime?.state === 'ready');
  $('#workspaceCount').textContent = Number.isInteger(runtime?.workspaceCount) ? `${runtime.workspaceCount}개` : '미확인';
  $('#workspaceTunnel').textContent = !runtime ? '미확인' : tunnelReady ? '로컬 준비됨' : runtime.tunnel?.running ? '연결 대기' : '준비 미확인';
  $('#workspaceFilePermission').textContent = runtime?.permissions?.files === 'read-write' ? '읽기·쓰기' : runtime?.permissions?.files === 'read-only' ? '읽기 전용' : runtime?.permissions?.files || '미확인';
  $('#workspaceCommandPermission').textContent = runtime?.permissions?.commands === true ? '사용 가능' : runtime?.permissions?.commands === false ? '사용 안 함' : '미확인';
  const identityBinding = component?.remoteAuthority?.identityBinding || preflight?.runtime?.localBinding?.identityBinding;
  $('#workspaceLocalBinding').textContent = `LOCAL 결속: ${identityBinding || '미확인'}. 로컬 identityBinding은 원격 앱 ID·계정·Tunnel의 증거가 아닙니다.`;
  $('#workspaceToolCount').textContent = Number.isInteger(snapshot?.toolCount) ? `${snapshot.toolCount}개` : '–';
  $('#workspaceReadToolCount').textContent = Number.isInteger(snapshot?.readToolCount) ? `${snapshot.readToolCount}개` : '–';
  $('#workspaceWriteToolCount').textContent = Number.isInteger(snapshot?.writeToolCount) ? `${snapshot.writeToolCount}개` : '–';
  $('#workspaceToolSummary').textContent = tools.length ? `${tools.length}개 소스 후보` : source ? '소스 도구 수만 확인' : '목록 미확인';
  $('#workspacePublishState').textContent = publication
    ? publication.published ? publication.needsPublish ? '저장 기록 갱신 필요' : '저장 기록과 소스 일치' : '원격 게시 기록 없음'
    : source ? '소스 준비 상태' : '자료 미확인';
  $('#workspacePublishState').classList.toggle('attention', true);
  const recordDetail = publication?.published
    ? publication.needsPublish ? '로컬 도구와 저장된 게시 기록이 다릅니다.' : '로컬 도구와 저장된 게시 기록이 일치합니다.'
    : '실제 원격 게시와 선택한 계정의 사용 가능 상태는 미확인입니다.';
  $('#workspacePublishDetail').textContent = `${label}: ${recordDetail} ${preflight?.checkedAt ? `최근 사전검사 ${new Date(preflight.checkedAt).toLocaleString('ko-KR')}. ` : ''}소스·저장 기록은 현재 원격 게시 증거가 아닙니다. 공식 화면에서 Scan Tools → 검토 → 게시 1회 → 원격 결과 확인을 진행하세요.`;
  $('#workspaceTools').innerHTML = tools.length ? tools.map(tool => `<div class="workspace-tool ${tool.mode === 'write' ? 'write' : 'read'}"><span>${tool.mode === 'write' ? '쓰기' : '읽기'}</span><div><strong>${escapeHtml(tool.title)}</strong><code>${escapeHtml(tool.name)}</code></div></div>`).join('') : '<span class="empty">선택한 표면의 도구 목록 자료가 없습니다. 게시 사전검사 또는 공식 화면 확인이 필요합니다.</span>';
}

function renderStatus(data) {
  const percent = data.summary.total ? Math.round(data.summary.ready / data.summary.total * 100) : 0;
  summary.textContent = `${data.summary.total}개 중 ${data.summary.ready}개 준비됨`;
  summaryHint.textContent = data.summary.attention ? `${data.summary.attention}개 항목을 확인해 주세요.` : '모든 핵심 연결이 정상입니다.';
  summaryPercent.textContent = `${percent}%`;
  summaryRing.setAttribute('stroke-dasharray', `${percent} ${100 - percent}`);
  const date = new Date(data.generatedAt).toLocaleString('ko-KR');
  updatedAt.textContent = `마지막 확인 ${date}`;
  componentUpdated.textContent = date;
  components.innerHTML = data.components.map(component => {
    const presentation = componentPresentation(component);
    return `<article class="component-card ${escapeHtml(presentation.stateClass)}">
      <span class="component-dot"></span><div><div class="card-head"><h3>${escapeHtml(component.label)}</h3><span class="state">${escapeHtml(presentation.label)}</span></div><p>${escapeHtml(component.detail)}</p>${presentation.hint ? `<small>${escapeHtml(presentation.hint)}</small>` : ''}</div>
    </article>`;
  }).join('');
  renderActivity(data);
  renderAttention(data);
  renderProductGuide();
  renderCoreRouteLedger(data);
  renderRecentEvidence();
  const ocx = data.components.find(component => component.id === 'ocx');
  const webGpt = data.components.find(component => component.id === 'web-gpt');
  const workspace = data.components.find(component => component.id === 'workspace-mcp');
  const workspaceApps = data.components.find(component => component.id === 'workspace-app-sync');
  const routeView = (prefix, component) => {
    $(`#${prefix}RouteState`).textContent = component?.state === 'ready' ? '정상' : component?.state === 'unavailable' ? '미설치' : '확인 필요';
    $(`#${prefix}RouteDetail`).textContent = component?.detail || '상태를 확인할 수 없습니다.';
    document.querySelector(`[data-route-card="${prefix === 'workspace' ? 'workspace' : prefix === 'webGpt' ? 'web-gpt' : prefix}"]`)?.classList.toggle('ready', component?.state === 'ready');
  };
  routeView('webGpt', webGpt);
  routeView('ocx', ocx);
  routeView('workspace', workspace);
  renderLiveMapState(
    'web-bridge',
    webGpt?.healthy === true && webGpt?.routeActive === true,
    webGpt?.healthy === true && webGpt?.routeActive === true ? '브리지 정상' : '브리지 확인',
    webGpt?.detail || 'Web GPT 상태를 확인할 수 없습니다.'
  );
  renderLiveMapState(
    'web-harness',
    webGpt?.harnessReady === true,
    webGpt?.harnessReady === true ? 'Full 하네스 준비' : webGpt?.harnessConfigured ? 'Tunnel 확인 필요' : 'Full 하네스 구성 전',
    webGpt?.harnessReady === true ? '현재 프로젝트 도구 사용 가능' : webGpt?.harnessConfigured ? '전용 Tunnel 또는 커넥터 확인 필요' : '브라우저 전용 모드'
  );
  renderLiveMapState(
    'workspace-tunnel',
    workspace?.tunnel?.ready === true,
    workspace?.tunnel?.ready === true ? 'Tunnel 준비' : 'Tunnel 확인',
    workspace?.tunnel?.ready === true ? '외부 ChatGPT 연결 준비됨' : '로컬 MCP 또는 Tunnel 확인 필요'
  );
  renderLiveMapState(
    'ocx',
    ocx?.state === 'ready',
    ocx?.state === 'ready' ? 'OCX 정상' : 'OCX 확인',
    ocx?.detail || 'OCX 상태를 확인할 수 없습니다.'
  );
  $('#webGptDetail').textContent = webGpt?.detail || '상태를 확인할 수 없습니다.';
  $('#webGptIndicator').classList.toggle('online', webGpt?.state === 'ready');
  $('#webGptVersion').textContent = webGpt?.version || '미확인';
  $('#webGptMode').textContent = webGpt?.mode === 'full' ? '전체 Codex 하네스' : webGpt?.mode === 'browser-only' ? '브라우저 전용' : '미설정';
  $('#webGptRouterOwner').textContent = webGpt?.runtimeOwner === 'service'
    ? 'macOS 독립 서비스 · OCX 전달 유지'
    : webGpt?.runtimeOwner === 'launcher' ? 'Desktop 종속' : '미확인';
  $('#webGptHarness').textContent = webGpt?.connectorVerified
    ? '현재 프로젝트 도구 검증됨'
    : webGpt?.harnessReady ? 'Tunnel 준비 · 도구 canary 필요' : webGpt?.harnessConfigured ? 'Tunnel 확인 필요' : '구성 전';
  $('#webGptTunnel').textContent = webGpt?.tunnelRuntime?.ready ? '준비됨' : webGpt?.tunnelRuntime?.running ? '연결 대기' : webGpt?.harnessConfigured ? '중지' : '미구성';
  $('#webGptConnector').textContent = webGpt?.connectorVerification === 'verified'
    ? 'Web GPT 작업 하네스 검증됨'
    : webGpt?.connectorVerification === 'tool-canary-failed' ? '앱 도구 스냅샷 교체 필요'
      : webGpt?.connectorVerification === 'tool-canary-required' ? '실제 도구 canary 필요'
        : webGpt?.connectorVerification === 'chatgpt-required' ? 'ChatGPT에서 앱 선택 확인' : '하네스 준비 후 확인';
  $('#webGptTurns').textContent = Number.isInteger(webGpt?.activeBrowserTurns) ? `${webGpt.activeBrowserTurns}/${webGpt.maxConcurrentTurns}` : '–';
  const readiness = webGpt?.readiness;
  $('#webReadinessState').textContent = !webGpt?.readinessSupported ? '설치본 미지원' : webGpt?.dependencyReady ? 'READY' : 'ATTENTION';
  $('#webReadinessState').classList.toggle('attention', !webGpt?.dependencyReady);
  const readinessLabels = { listener: 'HTTP listener', broker: 'Turn broker', browser: 'Browser intake', native_upstream: 'Native upstream' };
  const readinessEntries = Object.entries(readiness?.dependencies || {});
  $('#webReadinessVector').innerHTML = readinessEntries.length ? readinessEntries.map(([key, dependency]) => {
    const state = dependency?.ready === true ? 'pass' : dependency?.ready === false ? 'blocked' : 'deferred';
    const label = dependency?.ready === true ? 'READY' : dependency?.ready === false ? 'BLOCKED' : 'REQUEST-TIME';
    return `<article class="${state}"><span>${escapeHtml(readinessLabels[key] || key)}</span><strong>${label}</strong><small>${escapeHtml(dependency?.state || 'state unavailable')}</small></article>`;
  }).join('') : `<span class="empty">${webGpt?.readinessSupported ? 'readiness dependency를 읽지 못했습니다.' : '현재 설치 bundle은 /readyz를 제공하지 않습니다.'}</span>`;
  const webGptVerification = webGpt?.latestVerification;
  const historicalWebGptVerification = webGpt?.historicalVerification;
  $('#webGptVerification').textContent = webGpt?.verificationBundleMismatch
    ? `이전 bundle ${historicalWebGptVerification?.overallPass ?? '–'}/${historicalWebGptVerification?.total ?? '–'} · 현재 재검증 필요`
    : Number.isInteger(webGptVerification?.total)
    ? `${webGptVerification.overallPass}/${webGptVerification.total} 완전 성공`
    : '실측 기록 없음';
  $('#webTestCapability').textContent = webGpt?.verificationBundleMismatch
    ? '현재 설치본 재검증 필요'
    : Number.isInteger(webGptVerification?.total)
      ? `완전 성공 ${webGptVerification.overallPass}/${webGptVerification.total}`
      : '현재 설치본 실측 없음';
  const shortBundle = value => typeof value === 'string' ? value.slice(0, 12) : '미확인';
  $('#webTestBundleScope').textContent = `검증 bundle ${shortBundle(historicalWebGptVerification?.runtimeBundleId)} · 현재 bundle ${shortBundle(webGpt?.runtimeBundleId)}`;
  $('#webTestRuntimeNote').textContent = webGpt?.verificationBundleMismatch
    ? '아래 6/6 표는 이전 bundle의 보존된 증거입니다. 현재 설치 bundle은 실시간 재검증 전까지 인수 HOLD입니다.'
    : webGptVerification?.status === 'pass'
      ? '현재 설치 bundle과 검증 bundle이 일치합니다.'
      : '현재 설치 bundle의 완전한 6경로 실측이 아직 없습니다.';
  const modelLabels = webGpt?.modelLabels || [];
  $('#webGptModelCount').textContent = `${modelLabels.length}개`;
  $('#webGptModels').innerHTML = modelLabels.length ? modelLabels.map(label => `<span class="model-chip">${escapeHtml(label)}</span>`).join('') : '<span class="empty">Web GPT 모델 구성이 아직 없습니다.</span>';
  renderWorkspaceSurface(data);
  $('#workspaceAppSyncState').textContent = workspaceApps?.state === 'ready' ? '동기화 완료' : workspaceApps?.topologyReady ? '조치 대기' : 'INVENTORY HOLD';
  $('#workspaceAppSyncState').classList.toggle('attention', workspaceApps?.state !== 'ready');
  $('#workspaceAppSyncDetail').textContent = workspaceApps?.detail || '계정 동기화 상태를 확인할 수 없습니다.';
  const appSurfaces = workspaceApps?.surfaces || [];
  $('#workspaceAppSurfaceGrid').innerHTML = appSurfaces.length ? appSurfaces.map(surface => `<article>
    <div><span>${surface.surfaceProfile === 'business-full' ? 'Business shared' : 'Personal replica'}</span><strong>${escapeHtml(surface.failureDomain)}</strong></div>
    <b>${surface.toolCount} tools</b><small>read ${surface.readToolCount} · write ${surface.writeToolCount}</small>
  </article>`).join('') : '<span class="empty">로컬 manifest를 확인할 수 없습니다.</span>';
  const surfaceByProfile = new Map(appSurfaces.map(surface => [surface.surfaceProfile, surface]));
  const bindingFallback = [
    { accountAlias: 'Business owner', role: 'owner', surfaceProfile: 'business-full', actions: [{ action: 'hold', reason: 'browser_inventory_required' }] },
    { accountAlias: 'Business member', role: 'member', surfaceProfile: 'business-full', actions: [{ action: 'hold', reason: 'browser_inventory_required' }] },
    { accountAlias: 'Personal owner', role: 'owner', surfaceProfile: 'personal-read-fetch', actions: [{ action: 'hold', reason: 'browser_inventory_required' }] }
  ];
  const appBindings = workspaceApps?.accountBindings?.length ? workspaceApps.accountBindings : bindingFallback;
  const evidenceCell = (value, kind) => {
    const normalized = value || 'unknown';
    return `<span class="evidence-state ${escapeHtml(normalized)}">${normalized === 'pass' ? 'PASS' : normalized === 'unknown' ? 'UNKNOWN' : escapeHtml(normalized || kind)}</span>`;
  };
  $('#workspaceAppBindings').innerHTML = appBindings.map(binding => {
    const surface = surfaceByProfile.get(binding.surfaceProfile) || {};
    const actions = binding.actions || [];
    const next = actions.map(action => action.action === 'retain' ? '유지' : action.action === 'hold' ? `HOLD · ${action.reason || '확인 필요'}` : action.action).join(' · ') || '확인 필요';
    return `<tr><td><strong>${escapeHtml(binding.accountAlias)}</strong><small>${binding.role === 'member' ? '공유 member' : 'owner'}</small></td><td>${escapeHtml(binding.surfaceProfile)}</td><td>${Number.isInteger(surface.toolCount) ? `${surface.toolCount} (${surface.readToolCount}/${surface.writeToolCount})` : '–'}</td><td>${evidenceCell(surface.source, 'source')}</td><td>${evidenceCell(surface.installed, 'installed')}</td><td>${evidenceCell(surface.runtime, 'runtime')}</td><td>${evidenceCell(surface.browserVisible, 'browser')}</td><td><span class="binding-action ${actions.some(action => action.action === 'hold') ? 'hold' : ''}">${escapeHtml(next)}</span></td></tr>`;
  }).join('');
  $('#ocxDetail').textContent = ocx?.detail || '상태를 확인할 수 없습니다.';
  $('#ocxIndicator').classList.toggle('online', ocx?.state === 'ready');
  const ocxOverview = ocx?.overview || {};
  $('#ocxConsoleIndicator').classList.toggle('online', ocx?.state === 'ready');
  const ocxTopology = ocx?.topology?.mode || 'unknown';
  $('#ocxConsoleState').textContent = ocx?.state === 'ready' ? `OCX ${ocx.version || ''} ${ocxTopology} 정상`.trim() : 'OCX 확인 필요';
  $('#ocxConsoleDetail').textContent = ocx?.detail || '읽기 전용 운영 지표를 불러오지 못했습니다.';
  $('#ocxProviderCount').textContent = Number.isInteger(ocxOverview.providerCount) ? `${ocxOverview.providerCount}개` : '–';
  $('#ocxProviderNames').textContent = ocxOverview.providerNames?.length ? ocxOverview.providerNames.join(' · ') : 'Provider 미확인';
  $('#ocxModelCount').textContent = Number.isInteger(ocxOverview.modelCount) ? `${ocxOverview.modelCount}개` : '–';
  $('#ocxTokens30d').textContent = compactNumber(ocxOverview.totalTokens30d);
  $('#ocxCoverage').textContent = Number.isFinite(ocxOverview.usageCoverageRatio) ? `측정 ${Math.round(ocxOverview.usageCoverageRatio * 100)}%` : '측정 범위 미확인';
  $('#ocxMemoryRss').textContent = formatBytes(ocxOverview.rssBytes);
  $('#ocxMemoryBudget').textContent = Number.isFinite(ocxOverview.memoryBudgetBytes) ? `앱 보유 예산 ${formatBytes(ocxOverview.memoryBudgetBytes)}` : '예산 미확인';
  $('#ocxRebootSafe').textContent = ocxTopology;
  $('#ocxStartupState').textContent = ocx?.directRescue?.ready ? '10100 direct 복구 준비' : '10100 direct 확인 필요';
  $('#ocxSubagentCount').textContent = Number.isInteger(ocxOverview.subagentCount) ? `${ocxOverview.subagentCount}개` : '–';
  $('#ocxMultiAgentMode').textContent = ocxOverview.multiAgentMode ? `모드 ${ocxOverview.multiAgentMode}` : '모드 미확인';
  renderOcxModules(ocx);
  const routes = data.components.find(component => component.id === 'codex-routes');
  $('#codexRouteLabel').textContent = routeLabel(routes?.activeRoute);
  $('#codexRouteState').textContent = routes?.state === 'ready' ? '복구 준비됨' : '확인 필요';
  $('#codexRouteState').classList.toggle('attention', routes?.state !== 'ready');
  $('#codexRouteDetail').textContent = routes?.detail || '모델 경로 상태를 확인할 수 없습니다.';
  $('#nativeProfileState').textContent = routes?.nativeReady ? '공식 endpoint 검증됨' : '확인 필요';
  $('#routeWebGptState').textContent = routes?.webGpt?.healthy ? `정상 · ${routes.webGpt.mode || '모드 미확인'}` : '연결 안 됨';
  $('#routeRouterOwner').textContent = routes?.webGpt?.routerOwner === 'service'
    ? '독립 서비스'
    : routes?.webGpt?.routerOwner === 'launcher' ? 'Desktop' : '미확인';
  $('#routeOcxState').textContent = routes?.ocx?.healthy ? '정상 · 10100' : '연결 안 됨';
  const activeHttpTurns = Number.isInteger(routes?.webGpt?.activeHttpTurns) ? routes.webGpt.activeHttpTurns : null;
  const activeBrowserHttpTurns = Number.isInteger(routes?.webGpt?.activeBrowserHttpTurns) ? routes.webGpt.activeBrowserHttpTurns : null;
  const activeBrowserTurns = Number.isInteger(routes?.webGpt?.activeBrowserTurns) ? routes.webGpt.activeBrowserTurns : null;
  const activeTurns = Number.isInteger(routes?.webGpt?.activeTurns) ? routes.webGpt.activeTurns : null;
  const activeTurnsKnown = Number.isInteger(activeTurns);
  $('#routeActiveTurns').textContent = activeTurnsKnown
    ? `전체 HTTP ${activeHttpTurns} · Web HTTP ${activeBrowserHttpTurns ?? '–'} · 브라우저 ${activeBrowserTurns}`
    : '–';
  const cancelTurnsButton = $('[data-action="codex.web-gpt.cancel-turns"]');
  const recoverWebGptButton = $('[data-action="codex.web-gpt.recover"]');
  const nativeButton = $('[data-action="codex.native.recover"]');
  const bridgeButton = $('[data-action="codex.bridge.reconnect"]');
  const routesAvailable = Boolean(routes);
  const bridgeHealthy = routes?.webGpt?.healthy === true;
  const exactWebCountersKnown = [activeHttpTurns, activeBrowserHttpTurns, activeBrowserTurns].every(Number.isInteger);
  const routeBusyOrUnknown = !bridgeHealthy || !exactWebCountersKnown || [activeHttpTurns, activeBrowserHttpTurns, activeBrowserTurns].some(value => value > 0);
  const serviceOwnedRouter = routes?.webGpt?.routerOwner === 'service';
  const recoveryBusyOrUnknown = routeBusyOrUnknown;
  cancelTurnsButton.disabled = !bridgeHealthy || !Number.isInteger(activeBrowserTurns) || activeBrowserTurns <= 0;
  cancelTurnsButton.title = !bridgeHealthy
    ? '브리지가 응답하지 않아 취소 명령을 전달할 수 없습니다.'
    : !Number.isInteger(activeBrowserTurns)
      ? '활성 브라우저 작업 수를 확인할 수 없습니다.'
      : activeBrowserTurns > 0
        ? '남아 있는 ChatGPT Web 브라우저 작업을 취소합니다.'
        : activeHttpTurns > 0
          ? '브라우저 작업은 없고 Codex 요청만 남아 있습니다. Codex Desktop 작업을 중지하거나 앱을 종료하세요.'
          : '취소할 Web GPT 작업이 없습니다.';
  recoverWebGptButton.disabled = !routesAvailable || recoveryBusyOrUnknown;
  recoverWebGptButton.title = !routesAvailable
    ? '모델 경로 상태를 먼저 확인해야 합니다.'
    : !bridgeHealthy
      ? '17841 health와 active counter가 UNKNOWN이므로 재시작하지 않습니다.'
      : !exactWebCountersKnown
        ? '세 active counter를 모두 확인할 수 없어 재시작하지 않습니다.'
      : recoveryBusyOrUnknown
          ? '먼저 남은 Web 작업과 Codex Desktop 작업을 중지하세요.'
          : serviceOwnedRouter
            ? '17841 service router만 drain 후 one-shot으로 복구합니다. Desktop과 다른 경로는 유지합니다.'
            : 'launcher-owned 17841 runtime만 안전하게 복구합니다.';
  nativeButton.disabled = !routes?.nativeReady || routes?.activeRoute === 'native' || routeBusyOrUnknown;
  nativeButton.title = routes?.activeRoute === 'native'
    ? '이미 Native Codex 경로입니다.'
    : routeBusyOrUnknown
      ? activeTurnsKnown
        ? '먼저 남은 Web 작업을 취소하고 Codex Desktop 작업을 중지하세요.'
        : '활성 작업 수를 확인할 수 없어 경로를 바꾸지 않습니다.'
      : '미리보기 후 공식 Native endpoint로 복구합니다.';
  bridgeButton.disabled = !bridgeHealthy || !routes?.webGpt?.acceptingTurns || routes?.activeRoute === 'web-gpt' || !activeTurnsKnown || activeTurns > 0;
  bridgeButton.title = routes?.activeRoute === 'web-gpt'
    ? '이미 통합 모델 경로입니다.'
    : !bridgeHealthy
      ? '17841 브리지가 정상일 때만 다시 연결합니다.'
      : !activeTurnsKnown
        ? '활성 작업 수를 확인할 수 없어 경로를 바꾸지 않습니다.'
        : activeTurns > 0
          ? '먼저 남은 Web 작업과 Codex Desktop 작업을 중지하세요.'
          : '17841 통합 모델 경로로 다시 연결합니다.';
  const ocxRunning = ocx?.state === 'ready';
  const ocxInstalled = ocx?.installed !== false;
  const ocxActiveTurns = Number.isInteger(ocx?.sections?.runtime?.activeTurns) ? ocx.sections.runtime.activeTurns : null;
  const startButton = $('[data-action="ocx.start"]');
  const syncButton = $('[data-action="ocx.sync"]');
  const stopButton = $('[data-action="ocx.stop"]');
  startButton.disabled = ocxRunning || !ocxInstalled;
  startButton.textContent = ocxRunning ? '실행 중' : '시작';
  startButton.title = ocxRunning ? 'OCX가 이미 실행 중입니다.' : ocxInstalled ? 'OCX 연결 시작 미리보기' : 'OCX가 설치되어 있지 않습니다.';
  syncButton.disabled = !ocxRunning;
  syncButton.title = ocxRunning ? 'route를 바꾸지 않고 upstream catalog를 읽기 전용으로 확인합니다.' : 'OCX를 먼저 시작해 주세요.';
  stopButton.disabled = !ocxRunning || ocxActiveTurns === null || ocxActiveTurns > 0;
  stopButton.title = !ocxRunning
    ? 'OCX가 실행 중이 아닙니다.'
    : ocxActiveTurns === null
      ? '활성 작업 수를 확인할 수 없어 중지하지 않습니다.'
      : ocxActiveTurns > 0
        ? `진행 중 OCX 작업 ${ocxActiveTurns}개가 있어 중지하지 않습니다.`
        : '10100 upstream만 중지하는 미리보기입니다.';
  fillAccounts(data);
  fillOcxAccounts(data);
  roots.innerHTML = data.stateRoots.map(item => `<div class="path"><code>${escapeHtml(item.path)}</code><span>${item.exists ? '유지 중' : '아직 없음'}</span></div>`).join('');
}

function formatTokens(value) {
  return Number(value || 0).toLocaleString('ko-KR');
}

function availabilityLabel(availability) {
  if (availability?.status === 'available') return '실호출 확인';
  if (['unavailable', 'not_found', 'access_denied', 'rate_limited'].includes(availability?.status)) return '호출 불가';
  if (availability?.status === 'retired') return '종료';
  return '미확인';
}

function renderOpenaiMonitor(monitor, provider) {
  if (!monitor) return;
  const label = monitor.state === 'paused' ? '자동 정지' : monitor.state === 'warning' ? '경고' : '정상 감시';
  openaiMonitorState.textContent = label;
  openaiMonitorState.classList.toggle('ready', monitor.state === 'ready');
  openaiMonitorState.classList.toggle('attention', monitor.state !== 'ready');
  const batch = provider?.probeBatch;
  const check = provider?.catalog?.check;
  const official = monitor.officialObservation;
  const agentGuard = monitor.agentGuard;
  const poolRows = monitor.groups.map(group => `<span><b>${escapeHtml(group.label)}</b><small>${group.percent}% · 경고 ${group.warningPercent}% · 자동 정지 ${group.autoPausePercent}%</small></span>`).join('');
  openaiMonitorSummary.innerHTML = `${poolRows}
    <span><b>전수 확인</b><small>${batch ? `${batch.attempted}/${batch.total} · 성공 ${batch.available} · 실패 ${batch.unavailable} · ${formatTokens(batch.totalTokens)} token` : '아직 실행하지 않음'}</small></span>
    <span><b>공식 catalog</b><small>${check?.checkedAt ? `${escapeHtml(check.status)} · ${new Date(check.checkedAt).toLocaleString('ko-KR')}` : '아직 확인하지 않음'}${check?.added?.length || check?.removed?.length ? ` · 추가 ${check.added.length} / 제거 ${check.removed.length}` : ''}</small></span>
    <span><b>공식 Usage 반영</b><small>${official ? `${formatTokens(official.totalTokens)} token · ${official.requests}회 · 지연 ${official.reflectionDelaySeconds ?? '측정 불가'}초 · $${Number(official.costUsd).toFixed(2)}` : '전수 확인 후 인증 화면에서 측정'}</small></span>`;
  openaiMonitorSummary.innerHTML += `<span><b>Agent 우회 방지</b><small>${agentGuard?.ok ? `${agentGuard.guardedCount}/${agentGuard.scopeCount} Codex home 적용` : `${agentGuard?.guardedCount || 0}/${agentGuard?.scopeCount || 0} 적용 · 조치 필요`}</small></span>`;
  probeAllOpenaiModels.disabled = !provider?.enabled || batch?.status === 'running';
  probeAllOpenaiModels.textContent = batch?.status === 'running' ? `전수 확인 중 ${batch.attempted}/${batch.total}` : '계정 무료 모델 전수 실호출';
  applyOpenaiAgentGuard.disabled = Boolean(agentGuard?.ok);
  applyOpenaiAgentGuard.textContent = agentGuard?.ok ? 'Agent 우회 방지 적용됨' : 'Agent 우회 방지 적용';
}

function formatPrice(value) {
  return Number.isFinite(value) ? `$${value.toLocaleString('en-US', { maximumFractionDigits: 3 })}` : '–';
}

function renderOpenaiProvider(provider) {
  if (!provider) return;
  const enabled = provider.enabled === true;
  openaiProviderState.textContent = enabled ? 'API 켜짐' : 'API 꺼짐';
  openaiProviderState.classList.toggle('ready', enabled);
  openaiProviderState.classList.toggle('attention', !enabled);
  toggleOpenaiProvider.textContent = enabled ? 'OpenAI API 전체 끄기' : 'OpenAI API 전체 켜기';
  toggleOpenaiProvider.dataset.enabled = String(!enabled);
  toggleOpenaiProvider.classList.toggle('danger', enabled);
  const selectable = provider.models.filter(model => model.agentSelectable && model.lifecycle !== 'retired');
  openaiDefaultModel.innerHTML = selectable.map(model => `<option value="${escapeHtml(model.id)}"${model.isDefault ? ' selected' : ''}>${escapeHtml(model.label)} · ${escapeHtml(model.id)}</option>`).join('');
  setOpenaiDefaultModel.disabled = !selectable.length || openaiDefaultModel.value === provider.defaultModel;
  const available = provider.models.filter(model => model.availability?.status === 'available').length;
  openaiModelSummary.textContent = `${provider.models.length}개 공식 후보 · 계정 표시 ${provider.eligibility?.declaredFamilies?.length || 0}개 모델군 · ${selectable.length}개 agent 허용 · ${available}개 실호출 확인`;
  const filters = [
    ['current', '현재 권장'], ['enabled', '사용 허용'], ['all', '전체'], ['frontier', '고성능 풀'], ['efficient', '경량 풀']
  ];
  openaiModelFilters.innerHTML = filters.map(([id, label]) => `<button type="button" class="filter-chip${activeOpenaiModelFilter === id ? ' active' : ''}" data-openai-filter="${id}" aria-pressed="${activeOpenaiModelFilter === id}">${label}</button>`).join('');
  const visible = provider.models.filter(model => {
    if (activeOpenaiModelFilter === 'current') return model.lifecycle === 'current';
    if (activeOpenaiModelFilter === 'enabled') return model.callEnabled;
    if (activeOpenaiModelFilter === 'frontier' || activeOpenaiModelFilter === 'efficient') return model.groupId === activeOpenaiModelFilter;
    return true;
  });
  openaiModelList.innerHTML = visible.map(model => {
    const price = model.pricing;
    const failedAvailability = ['unavailable', 'not_found', 'access_denied', 'rate_limited'].includes(model.availability?.status);
    const cannotEnable = model.lifecycle === 'retired' || !model.eligibility?.verified || failedAvailability;
    const cannotProbe = model.lifecycle === 'retired' || !model.eligibility?.verified || !enabled;
    const accessClass = model.availability?.status === 'available' ? 'ready' : failedAvailability ? 'attention' : '';
    return `<article class="openai-model-row${model.isDefault ? ' is-default' : ''}">
      <div class="openai-model-copy">
        <div class="openai-model-title"><strong>${escapeHtml(model.label)}</strong><code>${escapeHtml(model.id)}</code>${model.isDefault ? '<span class="model-policy-badge default">기본</span>' : ''}<span class="model-policy-badge">${escapeHtml(model.groupId)}</span><span class="model-policy-badge ${model.eligibility?.verified ? 'ready' : 'attention'}">${model.eligibility?.status === 'observed_incentive' ? '무료 실측' : model.eligibility?.status === 'account_declared' ? '계정 표시' : '무료 미확인'}</span><span class="model-policy-badge ${accessClass}">${availabilityLabel(model.availability)}</span></div>
        <p>${escapeHtml(model.role)} · input ${formatPrice(price?.input)} / cached ${formatPrice(price?.cachedInput)} / output ${formatPrice(price?.output)} per 1M</p>
        <small>오늘 입력 ${formatTokens(model.usage.inputTokens)} · 출력 ${formatTokens(model.usage.outputTokens)} · 공유 풀 ${model.usage.sharedPoolPercent}% · 표준요금 환산 ${model.usage.estimatedStandardCostUsd == null ? '–' : `$${model.usage.estimatedStandardCostUsd.toFixed(5)}`}</small>
      </div>
      <div class="openai-model-actions">
        <button type="button" class="secondary" data-openai-model-action="call" data-model="${escapeHtml(model.id)}" data-call-enabled="${!model.callEnabled}" data-agent-selectable="${model.agentSelectable}" ${cannotEnable ? 'disabled' : ''}>API ${model.callEnabled ? '끄기' : '켜기'}</button>
        <button type="button" class="secondary" data-openai-model-action="agent" data-model="${escapeHtml(model.id)}" data-call-enabled="${model.callEnabled}" data-agent-selectable="${!model.agentSelectable}" ${cannotEnable || !model.callEnabled ? 'disabled' : ''}>Agent ${model.agentSelectable ? '제외' : '허용'}</button>
        <button type="button" class="secondary" data-openai-model-action="default" data-model="${escapeHtml(model.id)}" ${cannotEnable || !model.agentSelectable || model.isDefault ? 'disabled' : ''}>기본 지정</button>
        <button type="button" class="ghost" data-openai-model-action="probe" data-model="${escapeHtml(model.id)}" ${cannotProbe ? 'disabled' : ''}>연결 재확인</button>
      </div>
    </article>`;
  }).join('') || '<p class="empty-usage">선택한 조건에 맞는 모델이 없습니다.</p>';
}

function renderOpenaiUsage(data) {
  openaiKeyState.classList.toggle('online', data.keyConfigured);
  openaiGuardSummary.textContent = data.keyConfigured
    ? `Keychain 키 확인됨 · 유료 대상 모델 차단 · 무료 풀 95%에서 하드 정지`
    : 'Keychain에서 OpenAI API 키를 찾지 못했습니다.';
  openaiUsageUpdated.textContent = data.updatedAt
    ? `즉시 원장 ${new Date(data.updatedAt).toLocaleString('ko-KR')}`
    : `UTC ${data.dayUtc} · 아직 guard 호출 없음`;
  renderOpenaiProvider(data.provider);
  renderOpenaiMonitor(data.monitor, data.provider);
  const groupCards = data.groups.map(group => `
    <article class="usage-group-card">
      <div class="usage-group-head"><div><h3>${escapeHtml(group.label)}</h3><p>${formatTokens(group.tokens)} / ${formatTokens(group.freeLimit)} token</p></div><strong>${group.percent}%</strong></div>
      <div class="usage-meter"><progress aria-label="${escapeHtml(group.label)} 사용률" value="${Math.min(100, group.percent)}" max="100">${Math.min(100, group.percent)}%</progress><i title="로컬 하드 정지 95%"></i></div>
      <p class="usage-remaining">95% 하드 정지까지 ${formatTokens(group.hardRemaining)} token · 매일 00:00 UTC 초기화</p>
      <div class="model-usage-list">
        ${group.models.length ? group.models.map(model => `<div class="model-usage-row"><span><strong>${escapeHtml(model.model)}</strong><small>${formatTokens(model.requests)}회 · 입력 ${formatTokens(model.inputTokens)} · 캐시 ${formatTokens(model.cachedInputTokens)} · 출력 ${formatTokens(model.outputTokens)}</small></span><span><b>${formatTokens(model.totalTokens)}</b><small>${model.estimatedStandardCostUsd == null ? '가격 미등록' : `표준요금 환산 $${model.estimatedStandardCostUsd.toFixed(5)}`}</small></span></div>`).join('') : '<p class="empty-usage">아직 이 그룹의 guard 호출이 없습니다.</p>'}
      </div>
    </article>`).join('');
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const projectCard = `
    <article class="usage-project-card">
      <div class="usage-project-heading"><div><p class="eyebrow">PROJECT BUDGETS</p><h3>프로젝트별 AICC 사용량</h3></div><code>aicc openai project status</code></div>
      ${projects.length ? `<div class="usage-project-list">${projects.map(project => `
        <div class="usage-project-row">
          <span><strong>${escapeHtml(project.label)}</strong><small>${formatTokens(project.requests)}회 · ${formatTokens(project.tokens)} token · ${project.customized ? '사용자 한도' : '기본 10% 한도'}</small></span>
          <span class="usage-project-pools">${project.groups.map(group => `<small><b>${escapeHtml(group.id)}</b> ${formatTokens(group.tokens)} / ${formatTokens(group.limit)} (${group.percent}%)</small>`).join('')}</span>
        </div>`).join('')}</div>` : '<p class="empty-usage">프로젝트로 식별된 guard 호출이 아직 없습니다. 기존 호출은 다음 요청부터 Git 프로젝트별로 자동 기록됩니다.</p>'}
    </article>`;
  openaiUsageGroups.innerHTML = groupCards + projectCard;
}

async function loadOpenaiUsage() {
  const response = await fetch('/api/openai-usage', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  renderOpenaiUsage(data);
}

async function loadStatus() {
  const response = await fetch('/api/status', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  statusData = data;
  renderStatus(data);
}

async function loadCodexWorkGate() {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch('/api/codex-work-gate', { cache: 'no-store', signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    renderCodexWorkGate(data);
    return data;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function runNamedTask(taskId) {
  const item = catalog.items.find(candidate => candidate.taskId === taskId)
    || { title: taskId, taskId };
  return runTask(item);
}

function renderRecoveryHandoffStatus(data) {
  if (!supportBundleMeta) return;
  if (!data?.available) {
    recoveryHandoffDocuments = null;
    supportBundleMeta.textContent = '아직 저장된 문서가 없습니다. 복구 문서 갱신을 실행하세요.';
    copySupportPrompt.disabled = true;
    copySupportJson.disabled = true;
    revealSupportBundle.disabled = true;
    return;
  }
  recoveryHandoffDocuments = data.documents ?? recoveryHandoffDocuments;
  const generated = new Date(data.latest.generatedAt).toLocaleString('ko-KR');
  const freshness = data.latest.stale ? '갱신 필요' : 'current';
  const mode = data.latest.ownerOnly ? 'owner-only' : '권한 확인 필요';
  supportBundleMeta.textContent = `${generated} · ${freshness} · ${mode} · SHA-256 ${data.latest.markdownSha256.slice(0, 12)}…`;
  copySupportPrompt.disabled = !recoveryHandoffDocuments?.markdown;
  copySupportJson.disabled = !recoveryHandoffDocuments?.json;
  revealSupportBundle.disabled = data.finderAvailable !== true;
}

async function loadRecoveryHandoffStatus() {
  const response = await fetch('/api/recovery/handoff/content', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  renderRecoveryHandoffStatus(data);
  return data;
}

async function refreshRecoveryHandoff() {
  supportMessage.textContent = '비밀을 제외한 current 복구 문서를 owner-only 위치에 만들고 있습니다.';
  refreshSupportBundle.disabled = true;
  copySupportPrompt.disabled = true;
  copySupportJson.disabled = true;
  revealSupportBundle.disabled = true;
  try {
    const bundle = await postJson('/api/recovery/handoff/refresh', {});
    recoveryHandoffDocuments = bundle.documents;
    renderRecoveryHandoffStatus(bundle);
    const supportState = JSON.parse(bundle.documents.json).currentSupport?.state ?? '';
    supportMessage.textContent = supportState.startsWith('UNKNOWN_')
      ? `복구 문서를 갱신했습니다. 일부 실시간 상태는 ${supportState}으로 기록했습니다.`
      : 'current 복구 문서를 owner-only 위치에 갱신했습니다.';
  } catch (error) {
    supportMessage.textContent = `복구 문서를 갱신하지 못했습니다: ${error.message}`;
  } finally {
    refreshSupportBundle.disabled = false;
    copySupportPrompt.disabled = false;
    copySupportJson.disabled = false;
    await loadRecoveryHandoffStatus().catch(() => {});
  }
}

async function copySupportBundle(includePrompt) {
  const text = includePrompt ? recoveryHandoffDocuments?.markdown : recoveryHandoffDocuments?.json;
  if (!text) {
    supportMessage.textContent = '먼저 복구 문서를 갱신해 주세요.';
    return;
  }
  try {
    await writeClipboardText(text);
    supportMessage.textContent = includePrompt ? '현재 Markdown 복구 문서를 복사했습니다.' : '현재 진단 JSON을 복사했습니다.';
  } catch (error) {
    supportMessage.textContent = `복사하지 못했습니다: ${error.message}. Finder에서 열기를 사용하세요.`;
  }
}

async function revealRecoveryHandoff() {
  supportMessage.textContent = '가장 최근 복구 문서를 Finder에서 표시하고 있습니다.';
  revealSupportBundle.disabled = true;
  try {
    const result = await postJson('/api/recovery/handoff/reveal', {});
    supportMessage.textContent = `${result.path}을 Finder에서 표시했습니다.`;
  } catch (error) {
    supportMessage.textContent = `Finder에서 열지 못했습니다: ${error.message}`;
  } finally {
    await loadRecoveryHandoffStatus().catch(() => {});
  }
}

async function load() {
  refresh.disabled = true;
  refresh.classList.add('spinning');
  summary.textContent = '확인 중';
  try {
    const [
      catalogResult,
      productResult,
      statusResult,
      usageResult,
      monitoringResult,
      webJjonkuConfigResult,
      designSourcesResult,
      projectResult,
      knowledgeResult,
      localAccessResult,
      recoveryHandoffResult,
      codexWorkGateResult,
      latestRecoveryResult,
      goalResult
    ] = await Promise.allSettled([
      fetch('/api/catalog', { cache: 'no-store' }).then(async response => {
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
      }),
      fetch('/api/product', { cache: 'no-store' }).then(async response => {
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
      }),
      loadStatus(),
      loadOpenaiUsage(),
      loadMonitoring(),
      loadWebJjonkuConfig(),
      loadDesignSources(),
      loadProjectCatalog(),
      loadKnowledgeReview(),
      loadLocalAccess(),
      loadRecoveryHandoffStatus(),
      loadCodexWorkGate(),
      loadLatestRecoveryStatus(),
      loadGoals()
    ]);
    if (catalogResult.status === 'fulfilled') {
      catalog = catalogResult.value;
      renderCatalog();
    } else {
      toolLibrary.innerHTML = `<p class="error">도구 목록만 불러오지 못했습니다: ${escapeHtml(catalogResult.reason.message)}</p>`;
    }
    if (productResult.status === 'fulfilled') {
      product = productResult.value;
      renderProductGuide();
    } else {
      capabilityGuide.innerHTML = `<p class="error">사용 안내만 불러오지 못했습니다: ${escapeHtml(productResult.reason.message)}</p>`;
    }
    if (statusResult.status === 'rejected') {
      components.innerHTML = `<p class="error">상태 API를 확인하지 못했습니다: ${escapeHtml(statusResult.reason.message)}</p>`;
      roots.innerHTML = '';
      summary.textContent = '상태 확인 실패';
    }
    if (usageResult.status === 'rejected') {
      openaiUsageGroups.innerHTML = `<p class="error">OpenAI API 구역만 확인하지 못했습니다: ${escapeHtml(usageResult.reason.message)}</p>`;
      openaiUsageUpdated.textContent = '독립 구역 확인 실패';
    }
    if (monitoringResult.status === 'rejected') {
      monitoringLayers.innerHTML = `<p class="error">감시 체계 상태를 불러오지 못했습니다: ${escapeHtml(monitoringResult.reason.message)}</p>`;
      monitoringUpdated.textContent = '독립 구역 확인 실패';
      launchAgentList.innerHTML = '<p class="error">LaunchAgent 상태를 확인하지 못했습니다.</p>';
    }
    if (webJjonkuConfigResult.status === 'rejected') {
      webJjonkuConfigReady = false;
      saveWebJjonkuConfig.disabled = true;
      webJjonkuConfigStatus.textContent = '설정 확인 실패';
      webJjonkuLastRun.textContent = 'Codex 확인 기록을 읽지 못했습니다.';
      webJjonkuConfigMessage.textContent = `설정을 불러오지 못했습니다. 기존 설정을 보존하려고 저장을 막았습니다: ${webJjonkuConfigResult.reason.message}`;
    }
    if (designSourcesResult.status === 'rejected') {
      designSourceList.innerHTML = `<p class="error">디자인 원본 상태를 불러오지 못했습니다: ${escapeHtml(designSourcesResult.reason.message)}</p>`;
      designSourcesChecked.textContent = '독립 구역 확인 실패';
    }
    if (projectResult.status === 'rejected' && projectList) {
      projectList.innerHTML = `<p class="error">프로젝트 catalog를 불러오지 못했습니다: ${escapeHtml(projectResult.reason.message)}</p>`;
      projectCatalogSummary.textContent = '독립 구역 확인 실패';
    }
    if (knowledgeResult.status === 'rejected' && knowledgeReviewState) {
      knowledgeReviewState.textContent = '독립 구역 확인 실패';
      knowledgeReviewMessage.textContent = `공식 지식 상태를 불러오지 못했습니다: ${knowledgeResult.reason.message}`;
    }
    if (localAccessResult.status === 'rejected' && localAccessGrants) {
      localAccessGrants.innerHTML = `<p class="error">승인형 local access 상태를 불러오지 못했습니다: ${escapeHtml(localAccessResult.reason.message)}</p>`;
      localAccessMessage.textContent = '다른 읽기 경로로 자동 전환하지 않았습니다.';
    }
    if (recoveryHandoffResult.status === 'rejected' && supportBundleMeta) {
      supportBundleMeta.textContent = `복구 문서 상태를 확인하지 못했습니다: ${recoveryHandoffResult.reason.message}`;
    }
    if (codexWorkGateResult.status === 'rejected') {
      renderCodexWorkGate({ readOk: false, sequence: { stages: [] } });
    }
    if (latestRecoveryResult.status === 'rejected') {
      renderLatestRecovery({ available: false, state: 'unknown', gate: { readOk: false, exactIdle: false, activeCount: null, unknownCount: null } });
      latestRecoveryMessage.textContent = `최신 복구 상태를 불러오지 못했습니다: ${latestRecoveryResult.reason.message}`;
    }
    if (goalResult.status === 'rejected' && goalList) {
      goalList.setAttribute('aria-busy', 'false');
      goalList.innerHTML = `<p class="error">누적 목표 원장을 불러오지 못했습니다: ${escapeHtml(goalResult.reason.message)}</p>`;
      goalLedgerSummary.textContent = '목표 확인 실패';
    }
  } finally {
    refresh.disabled = false;
    refresh.classList.remove('spinning');
    if (!initialHashAligned && location.hash) {
      initialHashAligned = true;
      requestAnimationFrame(() => document.querySelector(location.hash)?.scrollIntoView({ block: 'start' }));
    }
  }
}

refresh.addEventListener('click', load);
goalSearch?.addEventListener('input', () => renderGoals());
goalStatusFilter?.addEventListener('change', () => {
  activeGoalStatus = goalStatusFilter.value;
  localStorage.setItem('aicc.goalStatus', activeGoalStatus);
  renderGoals();
});
goalSort?.addEventListener('change', () => {
  activeGoalSort = goalSort.value;
  localStorage.setItem('aicc.goalSort', activeGoalSort);
  renderGoals();
});
goalStatusCounts?.addEventListener('click', event => {
  const button = event.target.closest('[data-goal-status]');
  if (!button) return;
  activeGoalStatus = activeGoalStatus === button.dataset.goalStatus ? 'all' : button.dataset.goalStatus;
  localStorage.setItem('aicc.goalStatus', activeGoalStatus);
  renderGoals();
});
goalList?.addEventListener('change', event => {
  const input = event.target.closest('[data-goal-id]');
  if (input) setGoalChecked(input.dataset.goalId, input.checked);
});
userHelpList?.addEventListener('click', event => {
  const button = event.target.closest('[data-user-action-complete]');
  if (button) completeUserAction(button.dataset.userActionComplete);
});
$('#refreshWebGpt').addEventListener('click', load);
$('#openWebGpt').addEventListener('click', () => activateTool({ id: 'web-gpt', appId: 'web-gpt', title: 'Codex Web GPT' }));
previewKnowledgeReview?.addEventListener('click', previewOfficialKnowledgeReview);
enqueueKnowledgeReview?.addEventListener('click', enqueueOfficialKnowledgeReview);
localAccessForm?.addEventListener('submit', previewLocalAccessGrant);
confirmLocalGrant?.addEventListener('click', confirmLocalAccessGrant);
sessionApprovalForm?.addEventListener('submit', previewCodexSessionApproval);
confirmSessionApproval?.addEventListener('click', confirmCodexSessionApproval);
$('#workspacePreflight').addEventListener('click', () => {
  const item = catalog.items.find(candidate => candidate.id === 'workspace-publish');
  if (item) runTask(item);
});
$('#workspacePublicationSurface').addEventListener('change', () => {
  renderWorkspaceSurface(statusData);
  renderWorkspaceTargetPreferences();
  $('#workspaceTargetPreferenceMessage').textContent = '';
});
$('#workspaceTargetPreferences').addEventListener('submit', saveWorkspaceTargetPreferences);
renderWorkspaceTargetPreferences();
refreshSupportBundle.addEventListener('click', refreshRecoveryHandoff);
copySupportPrompt.addEventListener('click', () => copySupportBundle(true));
copySupportJson.addEventListener('click', () => copySupportBundle(false));
revealSupportBundle.addEventListener('click', revealRecoveryHandoff);
scanDesignSourcesButton.addEventListener('click', scanDesignSourceUpdates);
refreshUpstreamMonitoring.addEventListener('click', refreshUpstreamSignal);
selectAllDesignSources.addEventListener('click', () => {
  const available = selectableDesignSources();
  const allSelected = available.length && available.every(source => selectedDesignSources.has(source.id));
  selectedDesignSources.clear();
  if (!allSelected) available.forEach(source => selectedDesignSources.add(source.id));
  updateDesignSourceSelection();
});
applyDesignSources.addEventListener('click', () => previewAction('design-sources.apply', { ids: [...selectedDesignSources] }));
document.addEventListener('click', event => {
  const projectFilter = event.target.closest('[data-project-filter]');
  if (projectFilter) {
    activeProjectFilter = projectFilter.dataset.projectFilter;
    renderProjectCatalog();
    projectFilters.querySelector(`[data-project-filter="${CSS.escape(activeProjectFilter)}"]`)?.focus();
  }
  const projectPriority = event.target.closest('[data-priority-shift]');
  if (projectPriority) {
    previewProjectPriority(projectPriority.dataset.projectId, Number(projectPriority.dataset.priorityShift));
  }
  if (event.target.closest('[data-confirm-project-priority]')) confirmProjectPriorityChange();
  const projectServiceButton = event.target.closest('[data-project-service-action]');
  if (projectServiceButton) previewAction(projectServiceButton.dataset.projectServiceAction, { id: projectServiceButton.dataset.projectServiceId });
  const designSourceInput = event.target.closest('[data-design-source-id]');
  if (designSourceInput) {
    if (designSourceInput.checked) selectedDesignSources.add(designSourceInput.dataset.designSourceId);
    else selectedDesignSources.delete(designSourceInput.dataset.designSourceId);
    updateDesignSourceSelection();
  }
  const monitorSourceFilter = event.target.closest('[data-monitor-source-filter]');
  if (monitorSourceFilter) {
    activeMonitorSourceFilter = monitorSourceFilter.dataset.monitorSourceFilter;
    document.querySelectorAll('[data-monitor-source-filter]').forEach(button => {
      const active = button === monitorSourceFilter;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    renderMonitoringSources();
  }
  const flowButton = event.target.closest('[data-flow]');
  if (flowButton) {
    activeFlowId = flowButton.dataset.flow;
    localStorage.setItem('aicc.activeFlow', activeFlowId);
    renderProductGuide();
    flowSelector.querySelector(`[data-flow="${CSS.escape(activeFlowId)}"]`)?.focus();
  }
  const journeyButton = event.target.closest('.journey-summary');
  if (journeyButton) {
    const expanded = journeyButton.getAttribute('aria-expanded') === 'true';
    journeyButton.setAttribute('aria-expanded', String(!expanded));
    document.getElementById(journeyButton.getAttribute('aria-controls'))?.toggleAttribute('hidden', expanded);
  }
  const actionButton = event.target.closest('[data-action]');
  if (actionButton) previewAction(actionButton.dataset.action);
  const diagnosticButton = event.target.closest('[data-diagnostic-task]');
  if (diagnosticButton) runNamedTask(diagnosticButton.dataset.diagnosticTask);
  const toolButton = event.target.closest('[data-tool-run]');
  if (toolButton) {
    const item = catalog.items.find(candidate => candidate.id === toolButton.dataset.toolRun);
    if (item) activateTool(item);
  }
  const filterButton = event.target.closest('[data-filter]');
  if (filterButton) {
    activeFilter = filterButton.dataset.filter;
    renderCatalog();
    toolFilters.querySelector(`[data-filter="${CSS.escape(activeFilter)}"]`)?.focus();
  }
  const architectureButton = event.target.closest('[data-architecture-filter]');
  if (architectureButton) {
    activeArchitectureFilter = architectureButton.dataset.architectureFilter;
    renderArchitectureFilter();
  }
  const openaiFilter = event.target.closest('[data-openai-filter]');
  if (openaiFilter) {
    activeOpenaiModelFilter = openaiFilter.dataset.openaiFilter;
    if (statusData) loadOpenaiUsage().catch(error => { openaiActionMessage.textContent = error.message; });
  }
  const openaiModelAction = event.target.closest('[data-openai-model-action]');
  if (openaiModelAction) {
    const action = openaiModelAction.dataset.openaiModelAction;
    const model = openaiModelAction.dataset.model;
    if (action === 'call' || action === 'agent') previewAction('openai.model.set', {
      model,
      callEnabled: openaiModelAction.dataset.callEnabled === 'true',
      agentSelectable: openaiModelAction.dataset.agentSelectable === 'true'
    });
    if (action === 'default') previewAction('openai.default-model.set', { model });
    if (action === 'probe') previewAction('openai.model.probe', { model });
  }
});
copyPlannedPrompt.addEventListener('click', async () => {
  const text = plannedPrompt();
  if (!text) {
    planPromptMessage.textContent = '먼저 원하는 결과를 한 문장으로 적어 주세요.';
    taskBrief.focus();
    return;
  }
  try {
    await writeClipboardText(text);
    planPromptMessage.textContent = '현재 흐름의 경계와 성공 조건을 포함해 복사했습니다.';
  } catch (error) {
    planPromptMessage.textContent = `복사하지 못했습니다: ${error.message}`;
  }
});
toggleOpenaiProvider.addEventListener('click', () => previewAction('openai.provider.set', { enabled: toggleOpenaiProvider.dataset.enabled === 'true' }));
openaiDefaultModel.addEventListener('change', () => { setOpenaiDefaultModel.disabled = !openaiDefaultModel.value; });
setOpenaiDefaultModel.addEventListener('click', () => previewAction('openai.default-model.set', { model: openaiDefaultModel.value }));
probeAllOpenaiModels.addEventListener('click', () => previewAction('openai.catalog.probe-all', {}));
checkOpenaiCatalog.addEventListener('click', () => previewAction('openai.catalog.check', {}));
applyOpenaiAgentGuard.addEventListener('click', () => previewAction('openai.agent-guard.apply', {}));
switchAccount.addEventListener('click', () => previewAction('account.switch', { selector: accountSelector.value }));
switchOcxAccount.addEventListener('click', () => previewAction('ocx.account.use', { selector: ocxAccountSelector.value }));
actionDialog.addEventListener('close', () => {
  if (actionDialog.returnValue === 'default') executeAction();
  else {
    confirmationToken = null;
    confirmationAction = null;
  }
});
toolSearch.addEventListener('input', () => { searchIndex = 0; renderSearch(); });
toolSearch.addEventListener('keydown', event => {
  const matches = matchingTools(toolSearch.value);
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && matches.length) {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    searchIndex = (searchIndex + direction + matches.length) % matches.length;
    renderSearch();
    return;
  }
  if (event.key === 'Enter') {
    const selected = matches[searchIndex];
    if (selected) { event.preventDefault(); activateTool(selected); }
  }
  if (event.key === 'Escape') { toolSearch.value = ''; searchIndex = 0; renderSearch(); toolSearch.blur(); }
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
    event.preventDefault();
    toolSearch.focus();
  }
});
menuToggle.addEventListener('click', () => {
  const open = primarySidebar.classList.toggle('open');
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
});
primarySidebar.addEventListener('click', event => {
  if (event.target.closest('.nav-link') && matchMedia('(max-width: 760px)').matches) {
    primarySidebar.classList.remove('open');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', '메뉴 열기');
  }
});
document.addEventListener('click', event => {
  if (!event.target.closest('.command-search')) { searchResults.hidden = true; toolSearch.setAttribute('aria-expanded', 'false'); }
});
document.addEventListener('click', async event => {
  const filter = event.target.closest('[data-recipe-filter]');
  if (filter) {
    activeRecipeFilter = filter.dataset.recipeFilter;
    document.querySelectorAll('[data-recipe-filter]').forEach(button => {
      const active = button === filter;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    renderRecipes();
    return;
  }
  const copy = event.target.closest('[data-recipe-id]');
  if (!copy) return;
  const recipe = desktopRecipes.find(item => item.id === copy.dataset.recipeId);
  if (!recipe) return;
  const originalLabel = copy.textContent;
  copy.textContent = '복사 중…';
  try {
    await writeClipboardText(recipe.prompt);
    recipeMessage.textContent = `${recipe.title} 요청을 복사했습니다.`;
    copy.textContent = '복사됨 ✓';
  } catch (error) {
    recipeMessage.textContent = `복사하지 못했습니다: ${error.message}`;
    copy.textContent = '다시 시도';
  }
  window.setTimeout(() => { copy.textContent = originalLabel; }, 1_800);
});
activeFlowId = localStorage.getItem('aicc.activeFlow') || 'daily';
const orderedDetailIds = ['activity', 'web-gpt', 'ocx-console', 'accounts', 'workspace', 'troubleshoot', 'controls', 'openai-usage', 'monitoring', 'design-sources', 'system', 'architecture', 'tools'];
const mainContent = $('#mainContent');
orderedDetailIds.forEach(id => {
  const section = document.getElementById(id);
  if (section) mainContent.append(section);
});
const sections = [...document.querySelectorAll('.anchor-section, #home')];
const observer = new IntersectionObserver(entries => {
  const current = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
  if (!current) return;
  document.querySelectorAll('.nav-link').forEach(link => link.classList.toggle('active', link.getAttribute('href') === `#${current.target.id}`));
}, { rootMargin: '-20% 0px -65% 0px', threshold: [0, .2, .6] });
sections.forEach(section => observer.observe(section));
const revealObserver = new IntersectionObserver(entries => entries.forEach(entry => {
  if (entry.isIntersecting) entry.target.classList.add('in-view');
}), { rootMargin: '0px 0px -8% 0px', threshold: .08 });
document.querySelectorAll('section, .panel').forEach(element => revealObserver.observe(element));
renderRecipes();
renderArchitectureFilter();
load();
window.setInterval(() => {
  if (!document.hidden) loadOpenaiUsage().catch(() => {});
}, 30_000);
