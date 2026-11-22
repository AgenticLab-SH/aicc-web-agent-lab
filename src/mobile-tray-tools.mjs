import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{64}$/;
const PROFILE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const clean = (value, max = 240) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : null;
const inside = (root, file) => { const relative = path.relative(root, file); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";

function guard(file) {
  for (let current = path.resolve(file);; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('tray_tool_linked_path');
    if (current === path.dirname(current)) break;
  }
  return file;
}
function bytes(file, max = 4 * 1024 * 1024) {
  guard(file); const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) fail('tray_tool_file_invalid');
  return fs.readFileSync(file);
}
const json = file => JSON.parse(bytes(file).toString('utf8').replace(/^\uFEFF/, ''));
function atomic(file, value, exclusive = false) {
  guard(file);
  if (exclusive) {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return;
  }
  const temp = file + '.' + randomUUID() + '.tmp';
  atomic(temp, value, true); fs.renameSync(temp, file);
}
function run(shell, command, { timeout = 45000, emptyAccepted = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;" + command, 'utf16le').toString('base64')], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', overflow = false, done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(Object.assign(new Error(error), { code: error })) : resolve(value); };
    const timer = setTimeout(() => finish('tray_tool_result_unknown'), timeout);
    child.stdout.on('data', chunk => { if (output.length < 1048576) output += chunk; else overflow = true; });
    child.stderr.on('data', () => {});
    child.once('error', () => finish('tray_tool_start_unknown'));
    child.once('close', code => {
      if (code !== 0 || overflow) return finish('tray_tool_result_unknown');
      if (emptyAccepted && !output.trim()) return finish(null, { requestAccepted: true, actualDisplayVerified: false });
      try { finish(null, JSON.parse(output.replace(/^\uFEFF/, '').trim())); } catch { finish('tray_tool_result_unknown'); }
    });
  });
}

const entries = [
  ['status', 'AICC 상태·연결', '상태', 'root', 'account', 'OCX·AICC·웹 연결과 현재 관측 시각을 봅니다.'],
  ['refresh', '한도·연결 새로고침', '상태', 'root', 'account', '기존 수집기로 새 관측을 요청합니다.'],
  ['use', '선택 계정 사용', '계정', 'root', 'account', '정확한 selector·identity로 기존 미리보기와 확인을 거칩니다.'],
  ['pause', '계정 사용 중지', '계정', 'root', 'account', '자동 선택 대상에서 제외합니다.'],
  ['resume', '계정 사용 재개', '계정', 'root', 'account', '기존 계정을 자동 선택 대상에 돌려놓습니다.'],
  ['unpin', '수동 고정 해제·자동 선택', '계정', 'root', 'account', '현재 수동 선택 고정을 해제합니다.'],
  ['priority', '사용 우선순위', '자동 전환', 'root', 'account', '-100~100 범위의 순서를 저장합니다.'],
  ['order', '사용 순서 저장', '자동 전환', 'root', 'account', '정확한 계정 목록의 순서를 저장합니다.'],
  ['policy', '5시간·주간 차단 정책', '자동 전환', 'root', 'quota-policy', '두 기간의 사용률 차단선과 전환·중지를 따로 저장합니다.'],
  ['warnings', '일반·긴급 사전 경고', '경고', 'root', 'quota-warnings', '잔여량 경고 기준과 문구·단계·Slack을 저장합니다. 주간 일반 경고는 보내지 않습니다.'],
  ['credits', '초기화권 목록·만료', '계정', 'remote', null, '정확한 선택 계정의 초기화권을 조회합니다. 소비하지 않습니다.'],
  ['reset', '초기화권 1장 사용', '계정', 'remote', null, '계정 전체 초기화권 1장을 사용합니다. 특정 권 선택은 지원되지 않습니다.'],
  ['reconcile', 'OCX 원 변경 결과 조정', '계정', 'remote', null, '원 previewToken의 결과만 조회·조정하며 원 변경을 다시 보내지 않습니다.'],
  ['codex-ocx', 'Codex CLI · OCX', '도구', 'localOnly', null, 'PC에서 Git 폴더와 터미널을 선택해야 합니다. 일반 작업은 OCX를 사용합니다.'],
  ['codex-native', 'Codex CLI · Native', '도구', 'localOnly', null, 'PC의 독립 유지보수·복구 전용 시작 화면에서 폴더를 선택해야 합니다.'],
  ['troubleshoot', 'AICC 문제 해결·진단', '도구', 'remote', null, '현재 admission·실행 작업·UNKNOWN·독립 복구 준비 상태를 읽습니다.'],
  ['repair', '준비된 AICC 복구 적용', '도구', 'remote', null, '유효한 기존 plan·독립 READY와 현재 실행 세대가 일치할 때만 기존 helper가 적용합니다.'],
  ['repair-prepare', 'AICC 독립 복구 준비', '도구', 'localOnly', null, '현재 소유 Codex가 원 요청을 조정하고 후보·복구본·독립 READY를 준비해야 합니다. 일반 웹 요청이 이를 새로 승인하지 않습니다.'],
  ['repair-rollback', 'AICC 준비 복구 되돌리기', '도구', 'localOnly', null, '원 정비 담당자가 정확한 candidate·실행 세대·활성 작업을 대조하는 기존 절차를 사용합니다.'],
  ['rdc', 'RDC 계정 전환·상태', '도구', 'remote', null, '관리형 연결과 현재 profile·실행·미확인 작업을 읽습니다.'],
  ['rdc-save', 'RDC 현재 로그인 저장', 'RDC', 'remote', null, '현재 Windows 사용자 DPAPI 저장을 사용합니다. 로그인 원문은 웹에 반환하지 않습니다.'],
  ['rdc-switch', 'RDC 저장 계정 전환', 'RDC', 'remote', null, '기존 단일 순환 담당자의 정상 전환 계약을 사용합니다.'],
  ['rdc-auto', 'RDC 자동 순환 시작', 'RDC', 'remote', null, '기존 설치된 순환 담당자를 사용합니다. 새 로그인은 하지 않습니다.'],
  ['rdc-next', 'RDC 다음 계정', 'RDC', 'remote', null, '진행 중인 원 전환이 있으면 원 상태를 유지합니다.'],
  ['rdc-auto-stop', 'RDC 자동 순환 중지', 'RDC', 'remote', null, '순환 감시만 중지하고 실행 세션은 보존합니다.'],
  ['rdc-reconcile', 'RDC 원 전환 결과 조정', 'RDC', 'remote', null, '원 operationId와 agent ACK를 정상 대조합니다. 전환을 재발신하지 않습니다.'],
  ['rdc-pair', 'RDC 다른 계정 연결', 'RDC', 'localOnly', null, '새 로그인 계정 선택은 PC 공식 인증 화면에서 해야 합니다. 기존 로그인을 자동으로 해제하지 않습니다.'],
  ['rdc-start', 'RDC 연결 시작', 'RDC', 'localOnly', null, '현재 관리형·기존 실행 소유 확인 후 PC 운영자가 기존 시작 절차를 사용해야 합니다.'],
  ['rdc-adopt', 'RDC 기존 연결 인수', 'RDC', 'localOnly', null, '기존 legacy 작업과 pending 호출의 정확한 소유 확인이 필요한 유지보수 작업입니다.'],
  ['rdc-restart', 'RDC 연결 재시작', 'RDC', 'localOnly', null, '활성·UNKNOWN·정상 중지 ACK와 정확한 실행 세대가 필요한 유지보수 작업입니다.'],
  ['accounts', '계정·순환 전략·로그인 관리', '도구', 'remote', null, 'PC의 기존 OCX 계정 관리 화면을 엽니다. 로그인은 PC에서 직접 완료합니다.'],
  ['usage', '사용 이력', '도구', 'remote', null, 'PC의 기존 OCX 요청·모델·토큰 집계 화면을 엽니다.'],
  ['logs', '최근 오류', '도구', 'remote', null, 'PC의 기존 OCX 오류·요청 기록 화면을 엽니다.'],
  ['models', '모델·라우팅', '도구', 'remote', null, 'PC의 기존 OCX 모델·라우팅 화면을 엽니다.'],
  ['providers', '공급자 설정', '도구', 'remote', null, 'PC의 기존 OCX 공급자 관리 화면을 엽니다.'],
  ['versions', '설치·버전', '도구', 'remote', null, '현재 등록 버전을 보고 PC의 기존 OCX 관리 화면을 엽니다.'],
  ['aicc', 'AICC 관리 화면', '도구', 'remote', null, '기존 local-control health를 확인하고 PC 브라우저에 엽니다.'],
  ['phone', '휴대폰 연결·기기 관리', '도구', 'root', 'devices', '현재 인증된 웹의 기기 등록·철회를 사용합니다.'],
  ['diagnostics', '진단·상태 복사', '도구', 'remote', null, '비밀과 로컬 경로를 제외한 현재 연결 관측을 반환합니다. 브라우저의 복사 기능을 사용하세요.'],
  ['slack', 'Slack 알림 보기', '연결', 'remote', null, '검증된 기존 소유자 알림 DM을 현재 브라우저에서 엽니다. 새 메시지는 보내지 않습니다.'],
  ['portfolio', '전체 개발 현황', '상태', 'root', 'overview', '기존 개발 기록에서 그룹별 확인 결과와 다음 일을 봅니다.'],
  ['reports', 'AI 보고·인계', '대화', 'root', 'ai-reports', '기존 보고와 저장된 근거를 엽니다.'],
  ['instructions', '지시·목표', '대화', 'root', 'ai-queue', '정확한 대상을 선택해 지시와 목표를 확인합니다.'],
  ['goal-ledger', '전체 목표 원장', '대화', 'root', 'goals', '기존 목표 원장의 읽기 전용 상태와 근거를 봅니다.'],
  ['supervised-runs', '관제 실행', '대화', 'root', 'supervise', '기존 관제 화면에서 등록된 실행과 안전 확인을 봅니다.'],
  ['tasks', '대화·재개 현황', '대화', 'root', 'queue', '최근 대화·등록·전달·응답·목표 상태를 구분해 봅니다.'],
  ['find-thread', '대화 ID 찾기', '대화', 'root', 'queue', '정확한 기존 대화 ID로 조회합니다.'],
  ['terminal-tabs', 'Windows Terminal 탭 이름·순서', '대화', 'localOnly', null, 'PC PowerShell에서 aicc terminal-tabs 또는 mux tabs edit로 현재 창의 탭 이름과 번호순을 확인하고 적용합니다.'],
  ['open-thread', '선택한 기존 대화 열기', '대화', 'localOnly', null, 'Windows 트레이의 대화 자동재개에서 정확한 대화를 한 건 고른 뒤 관리 → 선택한 대화 열기를 사용하세요.'],
  ['queue-send', '선택 대화 메시지 전송', '대화', 'root', 'queue-message', '기존 단회 메시지와 원 전달 결과를 보존합니다.'],
  ['queue-register', '대화 등록', '대화', 'root', 'queue', '자동재개 등록과 실제 전송은 다릅니다.'],
  ['queue-enable', '자동재개 켜기', '대화', 'root', 'queue', '선택한 기존 대화만 재개 조건을 기다립니다.'],
  ['queue-disable', '자동재개 끄기', '대화', 'root', 'queue', '등록과 진행 중인 원 작업은 보존합니다.'],
  ['queue-resume', '선택 대화 보류 해제', '대화', 'root', 'queue', 'fresh terminal과 현재 소유 계약을 사용합니다.'],
  ['queue-complete', '자동재개 추적 완료', '대화', 'root', 'queue', '실제 목표 완료와 별개인 추적만 종료합니다.'],
  ['web-config', '웹 대화 관리 설정', '설정', 'root', 'web-config', '기존 웹 감시·역할·대상 설정을 사용합니다.'],
  ['text-size', '웹 글자 크기', '설정', 'root', 'view', '웹 화면에서 조절합니다. PC 트레이에는 별도 적용됩니다.'],
  ['quota-display', '사용량·잔여량 표시', '설정', 'root', 'view', '웹 화면의 표시 기준을 바꿉니다.'],
  ['refresh-interval', '웹 화면 갱신 주기', '설정', 'root', 'view', '웹의 관측 반영 주기이며 Slack 서버 감시와 별개입니다.'],
  ['app-install', 'AICC 설치·업데이트', '설정', 'root', 'install', '기존 웹앱 설치와 화면 업데이트, Android APK 다운로드를 안내합니다.'],
  ['tray-view', 'PC 트레이 글자·글래스·갱신', '설정', 'localOnly', null, '기존 ui-preferences는 생성시 한 번만 읽고 외부 CAS·실행 중 reload 계약이 없습니다. PC 트레이 설정에서 적용해야 합니다.'],
  ['pin-window', 'PC 트레이 창 고정', '설정', 'localOnly', null, '실행 중 WinForms 창의 메모리 상태이며 원격 명령 계약이 없습니다.'],
  ['glass', 'PC 트레이 글래스 효과', '설정', 'localOnly', null, '실행 중 WinForms 렌더링에 적용되는 설정이며 외부 reload 계약이 없습니다.'],
  ['guide', '사용 설명서·도움말', '설정', 'root', 'help', '각 기능의 목적·사용법·불가 이유는 이 목록에서 볼 수 있습니다.'],
  ['show-tray', 'PC AICC 상태 창 열기', '설정', 'localOnly', null, '기존 트레이 창을 조작하는 검증된 원격 IPC가 없습니다. PC 트레이 아이콘을 사용하세요.'],
  ['exit-tray', 'PC AICC 상태 종료', '설정', 'localOnly', null, '현재 실행 중 트레이의 정상 종료 IPC가 없습니다. 프로세스 강제 종료를 대신하지 않습니다.']
];

export function createMobileTrayTools(options = {}) {
  const owner = path.resolve(options.ownerRoot ?? process.env.AICC_STATE_ROOT ?? path.join(os.homedir(), '.ai-control-center'));
  // Existing operations helpers own this Windows user's registered state root.
  if (owner !== path.resolve(path.join(os.homedir(), '.ai-control-center'))) fail('tray_tool_owner_root_mismatch');
  const directory = path.join(owner, 'status-tray', 'mobile-tools');
  const previews = new Map();
  const catalog = entries.map(([action, label, group, capability, route, description]) => ({ action, label, group, capability, route, description,
    localOnly: capability === 'localOnly', delegated: capability === 'root', mutates: ['reset', 'repair', 'rdc-save', 'rdc-switch', 'rdc-auto', 'rdc-next', 'rdc-auto-stop', 'rdc-reconcile', 'reconcile'].includes(action),
    pcWindow: ['accounts','usage','logs','models','providers','versions','aicc'].includes(action),
    requiresAccount: ['credits', 'reset'].includes(action), requiresProfile: ['rdc-save', 'rdc-switch'].includes(action) }));
  function pin() {
    const cfg = json(path.join(owner, 'runtime', 'components.json')), tray = cfg.components?.tray;
    if (cfg.schemaVersion !== 1 || path.resolve(cfg.root ?? '.') !== owner || !tray?.sourceHashes || tray.location !== 'managed' || !path.isAbsolute(tray.releaseRoot ?? '') || !inside(path.join(owner, 'releases', 'tray'), tray.releaseRoot)) fail('tray_tools_pin_invalid');
    for (const [name, expected] of Object.entries(tray.sourceHashes)) {
      const file = path.resolve(tray.releaseRoot, name);
      if (!inside(tray.releaseRoot, file) || !SHA.test(String(expected).toLowerCase()) || hash(bytes(file)) !== expected.toLowerCase()) fail('tray_tools_pin_changed');
    }
    const shell = path.join(owner, 'toolchain', 'pwsh-7.6.6', 'runtime', 'pwsh.exe');
    bytes(shell, 256 * 1024 * 1024);
    return { root: tray.releaseRoot, shell, identity: hash(JSON.stringify(tray.sourceHashes)), component: tray };
  }
  function helperPath(p, relative) {
    if (!p.component.sourceHashes[relative]) fail('tray_tool_not_pinned');
    return path.join(p.root, relative);
  }
  const trouble = p => helperPath(p, 'tools/platform/windows/Invoke-AiccTroubleshooter.ps1');
  async function call(p, action, profile, operationDirectory) {
    return run(p.shell, '& ' + quote(trouble(p)) + ' -Action ' + quote(action) + (profile ? ' -Profile ' + quote(profile) : '') + (operationDirectory ? ' -OperationDirectory ' + quote(operationDirectory) : ''), { timeout: action === 'Repair' ? 190000 : 45000 });
  }
  function project(value) {
    const keys = ['ok', 'terminal', 'state', 'phase', 'message', 'managed', 'active', 'unknown', 'currentProfile', 'profiles', 'rotationConfigured', 'repairable', 'prepared', 'requestId', 'operationId', 'profile', 'current', 'from', 'to', 'reason', 'retryAfterMs', 'stopped', 'rotated', 'readVerified', 'stopMode', 'gatewayPid', 'requestAccepted', 'actualDisplayVerified'];
    const out = {};
    for (const key of keys) {
      const item = value?.[key];
      if (typeof item === 'boolean' || item === null || Number.isFinite(item)) out[key] = item;
      else if (typeof item === 'string') out[key] = clean(item);
    }
    if (Array.isArray(value?.profiles)) out.profiles = value.profiles.filter(item => PROFILE.test(item)).slice(0, 64);
    if (value?.rotation && typeof value.rotation === 'object') out.rotation = project(value.rotation);
    if (value?.providers && typeof value.providers === 'object') out.providers = Object.fromEntries(Object.entries(value.providers).slice(0, 16).map(([key, item]) => [clean(key, 40), Object.fromEntries(['active', 'unknown', 'reconnecting'].map(field => [field, Number.isInteger(item?.[field]) ? item[field] : null]))]));
    if (Array.isArray(value?.unknown)) out.unknown = value.unknown.slice(0, 48).map(item => ({ callId: clean(item.callId, 80), provider: clean(item.provider, 40), tool: clean(item.tool, 80), errorCategory: clean(item.errorCategory, 80) }));
    return out;
  }
  function rdcShape(value) {
    return { managed: value.managed, active: value.active, unknown: value.unknown, state: value.state,
      currentProfile: value.currentProfile, profiles: (value.profiles ?? []).filter(item => PROFILE.test(item)).sort(), rotationConfigured: value.rotationConfigured,
      rotation: value.rotation ? Object.fromEntries(['phase', 'current', 'operationId', 'from', 'to', 'agentRequestId'].map(key => [key, value.rotation[key] ?? null])) : null };
  }
  function rotation() {
    const rdc = path.join(os.homedir(), '.desktop-commander-device', 'rotation');
    const value = json(path.join(rdc, 'runtime.json'));
    if (!path.isAbsolute(value.entry ?? '') || !inside(rdc, value.entry) || !SHA.test(value.entrySha256 ?? '') || hash(bytes(value.entry)) !== value.entrySha256) fail('rdc_rotation_pin_invalid');
    return value;
  }
  async function account(p, input) {
    const module = await import(pathToFileURL(helperPath(p, 'tools/platform/windows/tray-status.mjs')).href);
    const state = await (await import('../tools/platform/windows/tray-status.mjs')).collectTrayAccountStatus({ refresh: false });
    const matches = (state.accounts ?? []).filter(row => row.selector === input.selector && row.identityHash === input.identityHash && row.displayNameVerified === true);
    if (matches.length !== 1 || state.controlNeedsReconcile && input.action !== 'reconcile') fail('tray_tool_account_unverified');
    return { module, row: matches[0] };
  }
  function unresolved() {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(name => /^(?:[a-f0-9]{32}|[a-f0-9-]{36})\.json$/.test(name)).map(name => json(path.join(directory, name))).filter(value => value.mutates !== false && ['DISPATCHING', 'UNKNOWN'].includes(value.terminal));
  }
  function prune() { for (const [id, item] of previews) if (item.expires <= Date.now()) previews.delete(id); }
  async function prepare(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['action', 'profile', 'selector', 'identityHash', 'operationRef', 'requestId'].includes(key))) fail('tray_tool_input_invalid');
    const entry = catalog.find(item => item.action === input.action);
    if (!entry) fail('tray_tool_action_invalid');
    if (input.profile !== undefined && !PROFILE.test(input.profile)) fail('tray_tool_profile_invalid');
    if (input.selector !== undefined && (!/^[A-Za-z0-9._-]{1,64}$/.test(input.selector) || input.selector === 'main') || input.identityHash !== undefined && !SHA.test(input.identityHash)) fail('tray_tool_identity_invalid');
    if (input.operationRef !== undefined && (!UUID.test(input.operationRef) && !/^[a-f0-9]{32}$/.test(input.operationRef)) || input.requestId !== undefined && !/^[a-f0-9]{32}$/.test(input.requestId)) fail('tray_tool_operation_invalid');
    const p = pin(), normalized = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    let binding = null, previewToken = null;
    if (entry.requiresAccount) { if (!input.selector || !input.identityHash) fail('tray_tool_exact_account_required'); await account(p, input); }
    if (entry.requiresProfile && !input.profile) fail('tray_tool_profile_required');
    if (input.action.startsWith('rdc') && entry.capability === 'remote') {
      const status = await call(p, 'RdcStatus'); binding = rdcShape(status);
      if (entry.mutates && input.action !== 'rdc-auto-stop' && input.action !== 'rdc-reconcile' && (status.managed !== true || status.active !== 0 || status.unknown !== 0)) fail('rdc_active_or_unknown_preserved');
      if (['rdc-switch', 'rdc-auto', 'rdc-next', 'rdc-auto-stop', 'rdc-reconcile'].includes(input.action)) rotation();
      if (input.action === 'rdc-switch' && !binding.profiles.includes(input.profile)) fail('rdc_saved_profile_required');
      if (input.action === 'rdc-reconcile' && (!input.operationRef || status.rotation?.operationId !== input.operationRef)) fail('rdc_exact_original_operation_required');
    }
    if (input.action === 'repair') {
      const state = await call(p, 'Status');
      if (state.prepared !== true || state.repairable !== true || typeof state.operationDirectory !== 'string') fail('aicc_independent_ready_required');
      const operationDirectory = path.resolve(state.operationDirectory);
      if (!inside(path.join(owner, 'backups', 'troubleshooter'), operationDirectory)) fail('aicc_repair_operation_invalid');
      const planBytes = bytes(path.join(operationDirectory, 'plan.json')), readyBytes = bytes(path.join(operationDirectory, 'ready.json'));
      binding = { operationDirectory, planHash: hash(planBytes), readyHash: hash(readyBytes), gatewayPid: state.gatewayPid };
    }
    if (input.action === 'reset') {
      const helper = helperPath(p, 'tools/platform/opencodex/Invoke-AiccOcxHubAccounts.ps1');
      const preview = await run(p.shell, '& ' + quote(helper) + ' -Action reset -Selector ' + quote(input.selector) + ' -ExpectedIdentity ' + quote(input.identityHash));
      if (preview.terminal !== 'DRY_RUN' || !/^[a-f0-9]{32}$/.test(preview.previewToken ?? '')) fail('reset_credit_preview_required');
      previewToken = preview.previewToken;
    }
    if (input.action === 'reconcile' && !input.requestId) fail('ocx_original_request_required');
    prune(); if (previews.size >= 64) fail('tray_tool_preview_capacity');
    const token = randomUUID();
    const fingerprint = hash(JSON.stringify({ input: normalized, sourcePin: p.identity, binding, previewToken }));
    const result = { action: input.action, input: normalized, sourcePin: p.identity, fingerprint, previewId: token,
      expiresAt: new Date(Date.now() + (previewToken ? 45000 : 60000)).toISOString(), summary: entry.label + ' · ' + entry.description,
      localOnly: entry.localOnly, delegated: entry.delegated, route: entry.route, reason: entry.localOnly ? entry.description : null };
    previews.set(token, { result: structuredClone(result), binding, previewToken, expires: Date.parse(result.expiresAt) });
    return structuredClone(result);
  }
  async function execute(prepared, { operationId } = {}) {
    prune();
    const saved = previews.get(prepared?.previewId);
    if (!saved || saved.result.fingerprint !== prepared?.fingerprint || hash(JSON.stringify(prepared.input)) !== hash(JSON.stringify(saved.result.input))) fail('tray_tool_preview_invalid_or_expired');
    if (!UUID.test(operationId ?? '') && !/^[a-f0-9]{32}$/.test(operationId ?? '')) fail('tray_tool_operation_id_required');
    previews.delete(prepared.previewId);
    const input = saved.result.input, entry = catalog.find(item => item.action === input.action), p = pin();
    if (p.identity !== saved.result.sourcePin) fail('tray_tools_pin_changed');
    if (entry.localOnly) return { terminal: 'LOCAL_ONLY', localOnly: true, action: entry.action, reason: entry.description, dispatched: false };
    if (entry.delegated) return { terminal: 'DELEGATED', action: entry.action, route: entry.route, dispatched: false, reason: '기존 모바일 전용 확인·실행 경로를 사용하세요.' };
    guard(directory); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const receipt = path.join(directory, operationId + '.json');
    if (fs.existsSync(receipt)) return { ...json(receipt), replayed: false };
    if (entry.mutates && !['reconcile', 'rdc-reconcile'].includes(entry.action) && unresolved().length) fail('tray_tool_previous_outcome_unknown');
    let gate;
    if (entry.mutates) { try { gate = fs.openSync(guard(path.join(directory, 'mutation.lock')), 'wx', 0o600); } catch { fail('tray_tool_mutation_owner_busy'); } }
    let dispatch = false;
    try {
      if (saved.binding && entry.action.startsWith('rdc')) {
        const current = await call(p, 'RdcStatus');
        if (JSON.stringify(rdcShape(current)) !== JSON.stringify(saved.binding)) fail('rdc_state_changed_prepare_again');
      }
      if (entry.action === 'repair') {
        for (const [file, expected] of [['plan.json', saved.binding.planHash], ['ready.json', saved.binding.readyHash]]) if (hash(bytes(path.join(saved.binding.operationDirectory, file))) !== expected) fail('aicc_ready_changed');
      }
      if (entry.requiresAccount) await account(p, input);
      if (pin().identity !== p.identity) fail('tray_tools_pin_changed');
      const intent = { schemaVersion: 1, operationId, action: entry.action, mutates: entry.mutates, fingerprint: prepared.fingerprint, terminal: 'DISPATCHING',
        originalRequestId: saved.previewToken ?? null, startedAt: new Date().toISOString(), automaticReplay: false };
      atomic(receipt, intent, true); dispatch = true;
      let value;
      if (entry.action === 'credits') {
        const { module } = await account(p, input);
        const result = await module.inspectResetCredits(input.selector, input.identityHash);
        value = { terminal: result.terminal, identityHash: input.identityHash, availableCount: result.availableCount ?? null, observedAt: result.observedAt ?? null,
          credits: (result.credits ?? []).slice(0, 48).map(row => ({ expiresAt: clean(row.expiresAt), expired: row.expired === true, remainingSeconds: Number.isFinite(row.remainingSeconds) ? row.remainingSeconds : null })) };
      } else if (entry.action === 'reset') {
        value = await run(p.shell, '& ' + quote(helperPath(p, 'tools/platform/opencodex/Invoke-AiccOcxHubAccounts.ps1')) + ' -Action reset -Selector ' + quote(input.selector) + ' -ExpectedIdentity ' + quote(input.identityHash) + ' -Commit -PreviewToken ' + quote(saved.previewToken), { timeout: 90000 });
        if (value.terminal !== 'PASS') fail('reset_credit_result_unknown');
        value = project(value);
      } else if (entry.action === 'reconcile') {
        const module = await import(pathToFileURL(helperPath(p, 'tools/platform/windows/tray-control.mjs')).href);
        const request = path.join(owner, 'status-tray', 'requests', operationId.replaceAll('-', '') + '.json');
        atomic(request, { action: 'reconcile', requestId: input.requestId }, true);
        value = project(await module.applyTrayRequest(request));
      } else if (entry.action === 'rdc-reconcile') {
        const runtime = rotation();
        value = project(await run(p.shell, '& ' + quote(runtime.entry) + ' -Action Reconcile -OperationId ' + quote(input.operationRef)));
      } else if (entry.action.startsWith('rdc') || ['troubleshoot', 'repair'].includes(entry.action)) {
        const actions = { rdc: 'RdcStatus', 'rdc-save': 'RdcSave', 'rdc-switch': 'RdcSwitch', 'rdc-auto': 'RdcAuto', 'rdc-next': 'RdcNext', 'rdc-auto-stop': 'RdcAutoStop', troubleshoot: 'Status', repair: 'Repair' };
        value = project(await call(p, actions[entry.action], input.profile, saved.binding?.operationDirectory));
      } else if (['accounts', 'usage', 'logs', 'models', 'providers', 'versions'].includes(entry.action)) {
        const page = entry.action === 'accounts' ? 'codex-auth' : entry.action === 'versions' ? 'dashboard' : entry.action;
        const launcher = helperPath(p, 'tools/platform/opencodex/Open-AiccOcxDashboard.ps1');
        await run(p.shell, '& ' + quote(launcher) + ' -Page ' + quote(page), { emptyAccepted: true });
        value = { requestAccepted: true, actualDisplayVerified: false, effect: 'PC_BROWSER_OPEN_REQUESTED', message: 'PC 관리 화면 열기 요청을 전달했습니다. 실제 표시와 로그인 완료는 미확인입니다.' };
      } else if (entry.action === 'slack') {
        const config = json(path.join(owner, 'notifications', 'slack-alerts.json')), navigation = json(path.join(owner, 'status-tray', 'slack-navigation.json'));
        if (navigation.schemaVersion !== 1 || config.transport !== 'aicc_slack_bot' || !/^T[A-Z0-9]+$/.test(navigation.teamId ?? '') || !/^D[A-Z0-9]+$/.test(navigation.dmChannelId ?? '') || ['teamId', 'botUserId', 'recipientUserId'].some(key => navigation[key] !== config[key])) fail('slack_navigation_unverified');
        value = { navigationUrl: `https://app.slack.com/client/${navigation.teamId}/${navigation.dmChannelId}`, effect: 'OPEN_IN_CURRENT_BROWSER', dispatchedMessage: false };
      } else if (entry.action === 'aicc') {
        const port = Number(process.env.AICC_PORT ?? 4381), host = process.env.AICC_HOST ?? '127.0.0.1';
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) fail('aicc_loopback_contract_invalid');
        const url = `http://${host}:${port}/`;
        const response = await fetch(url + 'healthz', { signal: AbortSignal.timeout(3000), redirect: 'error' });
        if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 4096) fail('aicc_existing_server_unverified');
        const health = await response.json(); if (health.ok !== true || health.mode !== 'local-control') fail('aicc_existing_server_unverified');
        await run(p.shell, 'Start-Process -FilePath ' + quote(url), { emptyAccepted: true });
        value = { requestAccepted: true, actualDisplayVerified: false, effect: 'PC_BROWSER_OPEN_REQUESTED' };
      } else if (entry.action === 'diagnostics') {
        const module = await import(pathToFileURL(helperPath(p, 'tools/platform/windows/tray-status.mjs')).href);
        const state = await module.collectTrayStatus({ refresh: false });
        value = { observedAt: clean(state.observedAt), workspaceReady: state.aiccReady === true, ocxReady: state.ocxReady === true, webReady: state.webReady === true,
          activeTurns: { ocx: state.ocxActiveTurns ?? null, web: state.webActiveTurns ?? null }, quotaReadFailed: state.quotaReadFailed === true,
          selectionVerified: state.selectionVerified === true, controlNeedsReconcile: state.controlNeedsReconcile === true,
          accounts: (state.accounts ?? []).map(row => ({ selector: clean(row.selector, 64), active: row.active === true, paused: row.paused === true, status: clean(row.status), shortRemaining: row.shortRemaining ?? null, longRemaining: row.longRemaining ?? null, quotaObservedAt: clean(row.quotaObservedAt) })) };
      } else fail('tray_tool_action_unimplemented');
      if (pin().identity !== p.identity) fail('tray_tools_pin_changed_after_dispatch');
      // Only the existing owner's successful exact reconciliation can clear its
      // matching wrapper fence. Other UNKNOWN operations remain untouched.
      const ocxReconciled = entry.action === 'reconcile' && value?.terminal === 'PASS';
      const rdcReconciled = entry.action === 'rdc-reconcile' && ['NOT_SWITCHED', 'UNVERIFIED'].includes(value?.phase) && value?.operationId === input.operationRef;
      if (ocxReconciled || rdcReconciled) {
        for (const name of fs.readdirSync(directory).filter(name => /^(?:[a-f0-9]{32}|[a-f0-9-]{36})\.json$/.test(name))) {
          const originalFile = path.join(directory, name), original = json(originalFile);
          if (!['DISPATCHING', 'UNKNOWN'].includes(original.terminal)) continue;
          const matches = ocxReconciled && original.action === 'reset' && original.originalRequestId === input.requestId ||
            rdcReconciled && original.action?.startsWith('rdc-') && original.result?.operationId === input.operationRef;
          if (matches) atomic(originalFile, { ...original, terminal: 'RECONCILED', reconciledBy: operationId, reconciledAt: new Date().toISOString(), automaticReplay: false });
        }
      }
      const terminal = ['UNCERTAIN', 'UNKNOWN', 'DISPATCHING', 'HOLD'].includes(value?.terminal) || ['HOLD', 'VERIFYING'].includes(value?.phase) ? 'UNKNOWN' : 'PASS';
      const outcome = { ...intent, terminal, finishedAt: new Date().toISOString(), result: value,
        verificationScope: entry.action.startsWith('rdc') ? 'existing-owner-response-not-proof-of-chatgpt-read' : value?.actualDisplayVerified === false ? 'pc-open-request-not-screen-observation' : 'named-helper-response' };
      atomic(receipt, outcome); return outcome;
    } catch (error) {
      if (!dispatch) throw error;
      const outcome = { schemaVersion: 1, operationId, action: entry.action, mutates: entry.mutates, originalRequestId: saved.previewToken ?? null,
        terminal: 'UNKNOWN', reason: /^[a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'tray_tool_result_unknown', automaticReplay: false };
      atomic(receipt, outcome); return outcome;
    } finally {
      if (gate !== undefined) { fs.closeSync(gate); fs.unlinkSync(path.join(directory, 'mutation.lock')); }
    }
  }
  return Object.freeze({
    async status() {
      let p, pinError = null, profiles = [], rdc = null;
      try { p = pin(); } catch (error) { pinError = error.code ?? 'tray_tools_unavailable'; }
      if (p) { try { const value = await call(p, 'RdcStatus'); rdc = project(value); profiles = rdc.profiles ?? []; } catch { rdc = { state: 'UNAVAILABLE', automaticReplay: false }; } }
      return { schemaVersion: 1, catalog: catalog.map(row => ({ ...row })), profiles, rdc,
        sourcePin: p?.identity ?? null, pinError, versions: p ? { tray: clean(p.component.releaseHash ?? path.basename(p.root), 64), source: 'runtime/components.json' } : null,
        capabilities: { namedActionsOnly: true, exactIdentityRequired: true, oneUsePreview: true, preservesUnknown: true, genericShell: false, arbitraryPaths: false, pcWindowDisplayVerified: false, trayLivePreferencesReload: false },
        unresolved: unresolved().map(row => ({ operationId: row.operationId, action: row.action, terminal: row.terminal,
          originalRequestId: row.originalRequestId ?? null, originalOperationId: row.result?.operationId ?? null, automaticReplay: false })) };
    }, prepare, execute
  });
}
