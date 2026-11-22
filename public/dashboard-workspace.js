import { createMobileStopStatusCard } from '/ai-cowork.js';
const root = document.getElementById('aiWorkspace');
const $ = (tag, value, cls) => { const n = document.createElement(tag); if (value != null) n.textContent = value; if (cls) n.className = cls; return n; };
const button = (title, action, disabled = false) => { const b = $('button', title); b.type = 'button'; b.disabled = disabled; b.onclick = action; return b; };
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) + ' KST' : '확인 안 됨';
const fields = [['description', '무엇을 할 수 있는가'], ['usage', '언제 쓰는가 / 실제 사용 예'], ['options', '방식과 선택지'], ['defaults', '기본값'], ['impact', '선택에 따른 영향'], ['current', '현재 가능한 것'], ['remaining', '남은 것과 이유']];
const errors = { dashboard_revision_conflict: '다른 편집이 먼저 저장됐습니다. 새로 조회한 뒤 다시 편집하세요.', preview_stale: '대상 상태가 바뀌었습니다. 최신 상태에서 다시 미리보기 하세요.', dashboard_sent_item_locked: '인계 준비나 전달이 시작된 지시는 수정·재정렬할 수 없습니다.', dashboard_queue_paused: '전체 새 시작 또는 이 에이전트가 일시정지 상태입니다.', dashboard_previous_instruction_pending: '앞 지시의 완료 확인이 남아 있습니다. 원 결과를 먼저 조정하세요.', dashboard_original_attempt_pending: '이 대상에 기존 불명/진행 중 전달이 있습니다. 원 attempt를 보존하고 조정하세요.', dashboard_handoff_target_unavailable: '기존 continuity 원장에 사용할 수 있는 exact 대상이 없습니다.', dashboard_receipt_scope_mismatch: '원 영수증의 대상·메시지·attempt가 맞지 않습니다. 재발신하지 않습니다.', dashboard_receipt_owner_mismatch: '원 영수증과 기존 실행 원장의 관측이 다릅니다. 원 결과를 조정하세요.', dashboard_task_completion_unproven: '같은 지시의 실제 turn 종료 근거가 먼저 필요합니다.', pair_required: '브라우저 연결이 필요합니다. 기존 기기 연결을 사용하세요.', csrf_required: '연결이 바뀌었습니다. 다시 조회하세요.', dashboard_writer_busy: '다른 작성자가 저장 중입니다. 현재 결과를 조회하세요.' };
Object.assign(errors, { dashboard_next_instruction_missing: '선택 에이전트에 준비할 다음 지시가 없습니다.', dashboard_next_instruction_changed: '선택 에이전트의 첫 지시가 바뀌었습니다. 현재 순서를 다시 확인하세요.' });
const queueStates = { UNSENT: '미전송', HANDOFF_PENDING: '로컬 인계 준비 결과 확인 필요', HANDOFF_READY: '로컬 인계 준비됨 · 발신 안 함', ACCEPTED: '전송 접수됨', RUNNING: '실제 turn 실행 관측', TURN_COMPLETED: 'turn 종료 · 지시 완료 확인 대기', INTERRUPTED: 'turn 중단 · 원 결과 조정 필요', UNKNOWN: '결과 불명 · 재발신 금지', COMPLETED: '지시 결과 사용자 확인 완료', CANCELLED: '미전송 취소' };
Object.assign(errors, {
  dashboard_undo_unavailable: '이미 되돌렸거나 보관 범위를 벗어난 편집입니다. 새로 조회하세요.',
  dashboard_undo_conflict: '이 항목이 이후 편집됐습니다. 현재 내용을 보존하고 직접 편집하세요.',
  dashboard_undo_source_changed: '원제품 원장이 달라져 자동으로 되돌리지 않습니다. 현재 원문과 비교하세요.',
  dashboard_undo_referenced: '하위 작업이나 지시가 참조하는 항목입니다. 참조를 보존하고 직접 편집하세요.',
  dashboard_parent_cycle: '상위와 하위가 서로 참조하게 되어 변경을 중단했습니다.',
  dashboard_terminal_observation_preserved: '이미 확인한 turn 종료·중단 근거와 다릅니다. 원 영수증을 확인하세요.',
  dashboard_receipt_regression: '앞서 확인한 실행 단계보다 과거의 영수증입니다. 원 결과를 확인하세요.'
});
Object.assign(errors, { goal_revision_conflict: '목표 원장이 바뀌었습니다. 새로 조회한 뒤 다시 편집하세요.', goal_writer_busy: '다른 목표 작성자가 저장 중입니다. 현재 내용을 먼저 조회하세요.', goal_edit_unavailable: '현재 설치된 목표 서비스는 편집을 지원하지 않습니다.', goal_dependency_cycle: '서로 완료를 기다리는 순환 관계입니다. 의존 목표를 다시 선택하세요.', invalid_goal_dependency: '의존 목표가 보관되었거나 현재 원장과 맞지 않습니다.', invalid_goal_edit: '목표 이름·설명·선택 항목을 확인하세요.', dashboard_goal_not_ready: '연결 목표가 보관·대기·완료 상태이거나 원장에 없습니다. 목표를 먼저 확인하세요.', dashboard_goal_dependency_pending: '먼저 완료해야 할 목표가 남았거나 의존 관계 확인이 필요합니다.' });
const tabNames = { 'ai-reports': '에이전트 보고', 'ai-work': '작업', 'ai-queue': 'Queue & Goal' };
let snapshot, goals, csrf, local = false, busy = false, initialized = false, needsConnect = false, search = '', archive = false, pinned = false, dragged = null;
let statusLine, body, tabs, editor, confirmDialog, installPrompt;
let showArchivedGoals = false;
let evidenceHistory = null, evidenceHistoryError = null;
Object.assign(errors, { dashboard_report_changed: '보고가 바뀌었습니다. 최신 보고를 확인한 뒤 응답·확인을 다시 준비하세요.', dashboard_report_not_completed: '미결 지시나 선택이 남았거나 확정 완료 보고가 아닙니다.', dashboard_reply_report_changed: '응답 뒤 원 보고가 바뀌었습니다. 이 미전송 응답을 취소하고 최신 보고에서 다시 작성하세요.' });
Object.assign(errors, { dashboard_merge_required: '원문이 달라졌습니다. 원문과 편집 비교에서 항목별로 선택해 병합하세요.', dashboard_merge_source_changed: '병합할 원문이 다시 바뀌었습니다. 새로 조회한 뒤 비교하세요.', dashboard_merge_choices_required: '각 항목에서 현재 원문 채택 또는 기존 편집 유지를 선택하세요.' });
const selection = key => new URL(location.href).searchParams.get(key);
Object.assign(errors, { user_action_edit_unavailable: '현재 서비스는 보고에서 사용자 할 일 완료를 지원하지 않습니다.', user_action_revision_conflict: '사용자 할 일이나 완료 기준이 바뀌었습니다. 새로 조회해 확인하세요.', user_action_report_binding_changed: '보고와 사용자 할 일 연결이 바뀌었습니다. 최신 보고에서 다시 확인하세요.', unknown_user_action: '이미 완료됐거나 현재 원장에 없는 사용자 할 일입니다. 새로 조회하세요.', invalid_user_action: '420자 이내의 실제 완료 근거를 입력하세요.', user_action_revision_required: '현재 사용자 할 일의 버전을 새로 조회하세요.' });
const tab = () => tabNames[location.hash.slice(1)] ? location.hash.slice(1) : 'ai-reports';
function navigate(nextTab, key, value) {
  const url = new URL(location.href); url.hash = nextTab;
  if (key) url.searchParams.set(key, value);
  history.pushState(null, '', url); render();
}
async function request(endpoint, data) {
  const controller = data === undefined ? new AbortController() : null;
  let timeout;
  const read = async () => {
    const response = await fetch('/api/mobile/' + endpoint, { credentials: 'same-origin', cache: 'no-store', headers: data === undefined ? {} : { 'content-type': 'application/json', 'x-aicc-csrf': csrf ?? '' }, ...(controller ? { signal: controller.signal } : {}), ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) });
    const value = await response.json();
    if (!response.ok || value.ok === false) throw Object.assign(new Error(errors[value.code] ?? value.code ?? '연결을 확인할 수 없습니다.'), { code: value.code });
    return value;
  };
  // Bound reads through body parsing, even when transport cancellation is delayed.
  // A timed-out read never replays a preview, confirmation or uncertain mutation.
  if (!controller) return read();
  try {
    return await Promise.race([read(), new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(Object.assign(new Error('조회 응답이 지연됩니다. 마지막 표시값은 유지합니다. 연결 후 새로 조회하세요. 지시는 자동 재전송하지 않습니다.'), { code: 'read_timeout' }));
        controller.abort();
      }, 20000);
    })]);
  } catch (error) {
    if (error instanceof TypeError) throw Object.assign(new Error('조회 연결이 끊겼습니다. 마지막 표시값은 유지합니다. 연결 후 새로 조회하세요. 지시는 자동 재전송하지 않습니다.'), { code: 'read_network_error' });
    throw error;
  } finally { clearTimeout(timeout); }
}
function message(value, error = false) { statusLine.textContent = value; statusLine.dataset.error = String(error); }
async function run(fn) {
  if (busy) return;
  busy = true; root.setAttribute('aria-busy', 'true');
  try { await fn(); } catch (error) { message(error.message, true); }
  finally {
    busy = false; root.setAttribute('aria-busy', 'false');
    if (needsConnect && !initialized) { needsConnect = false; void connect(); }
  }
}
async function load() {
  message('등록된 원장을 읽고 있습니다.');
  const session = await request('session'); csrf = session.csrf; local = session.local;
  // Independent owner failures must not erase the rest of the screen.
  const results = await Promise.allSettled([request('dashboard'), request('goals')]);
  if (results[0].status === 'rejected') throw results[0].reason;
  snapshot = results[0].value;
  goals = results[1].status === 'fulfilled' ? results[1].value : null;
  initialized = true; render();
  message(`${snapshot.coverage.available ? '' : '원 portfolio 등록을 읽지 못했습니다. / '}${snapshot.coverage.groupCount}그룹 · ${snapshot.coverage.projectCount}프로젝트 · ${snapshot.coverage.featureCount}기능 · 확인 ${date(snapshot.observedAt)}${goals ? '' : ' / 목표 원장 조회 실패'}`, !snapshot.coverage.available);
  if (snapshot.coverage.issues.length) statusLine.append($('p', '일부 원장 조회 실패: ' + snapshot.coverage.issues.map(i => `${i.source} (${i.code})`).join(', ')));
}
async function outcome(operationId) {
  if (operationId.startsWith('confirmation:')) {
    const original = await request('operation-by-confirmation?sha256=' + operationId.slice('confirmation:'.length));
    if (!original.operationId) { message('원래 확인의 실행 여부가 아직 불명입니다. 자동 재발신하지 않습니다.', true); statusLine.append(button('원래 확인 결과 조회', () => run(() => outcome(operationId)))); return; }
    operationId = original.operationId;
    localStorage.setItem('aicc.dashboard.pendingOperation', operationId);
  }
  for (let i = 0; i < 8; i++) {
    const result = await request('operation?id=' + encodeURIComponent(operationId));
    if (result.state === 'COMPLETED') {
      localStorage.removeItem('aicc.dashboard.pendingOperation');
      await load(); message(result.kind === 'queue-send' ? `원 발신 결과: ${result.queueResult?.stage ?? 'UNKNOWN'}. 접수·turn 종료는 전체 지시/목표 완료가 아닙니다. 원 영수증 조정으로 확인하세요.` : result.kind === 'terminal' ? 'PC의 기존 mux 연결 창을 요청했습니다. 화면 연결 성공은 아직 확인되지 않았습니다. 새 대화·프롬프트 발신은 하지 않았습니다.' : '기록을 저장했습니다. 이 변경이 실제 대화 발신·실행을 수행하지는 않습니다.'); return;
    }
    if (result.state === 'UNKNOWN') break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  message('저장 결과가 불명입니다. 같은 변경을 다시 보내지 말고 원래 결과를 조회하세요.', true);
  statusLine.append(button('원래 결과 조회', () => run(() => outcome(operationId))));
}
async function preview(input, kind = 'dashboard') {
  await run(async () => {
    if (localStorage.getItem('aicc.dashboard.pendingOperation')) throw Error('원래 저장 결과를 먼저 조회하세요.');
    message('현재 상태와 변경 영향을 확인하고 있습니다.');
    const proof = await request('session'); csrf = proof.csrf;
    const prepared = await request('preview', { kind, config: { ...input, ...(kind === 'goal' ? { expectedSourceRevision: goals.sourceRevision } : kind === 'dashboard' ? { expectedRevision: snapshot.revision } : {}) } });
    confirmDialog.replaceChildren($('h2', '변경 미리보기'));
    const ul = $('ul'); for (const line of prepared.summary) ul.append($('li', line));
    const actions = $('div', null, 'ai-actions');
    actions.append(button('취소', () => confirmDialog.close()), button('이 변경 저장', async () => {
      confirmDialog.close();
      await run(async () => {
        const fresh = await request('session');
        if (fresh.csrf !== proof.csrf) throw Error('연결이 바뀌어 확인을 취소했습니다. 새 미리보기가 필요합니다.');
        // From this point a disconnect is ambiguous. Never repeat confirm automatically.
        const marker = { confirmationToken: prepared.confirmationToken };
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prepared.confirmationToken));
        const digest = [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('aicc.dashboard.pendingOperation', 'confirmation:' + digest);
        try {
          const result = await request('confirm', marker);
          localStorage.setItem('aicc.dashboard.pendingOperation', result.operationId);
          await outcome(result.operationId);
        } catch (error) {
          message('확인 응답을 받지 못했습니다. 자동 재발신하지 않습니다. 운영 도구에서 원 요청을 조정하세요. ' + error.message, true);
          statusLine.append(button('원래 확인 결과 조회', () => run(() => outcome('confirmation:' + digest))));
        }
      });
    }));
    confirmDialog.append(ul, $('p', '확인 유효 시각: ' + date(prepared.expiresAt), 'ai-meta'), actions); confirmDialog.showModal();
  });
}
function heading(title, detail) { const n = $('div'); n.append($('h3', title), $('p', detail, 'ai-meta')); return n; }
function definition(parent, title, value) {
  parent.append($('dt', title)); const dd = $('dd');
  if (Array.isArray(value)) { if (!value.length) dd.textContent = '보고 없음'; else { const ul = $('ul'); for (const line of value) ul.append($('li', line)); dd.append(ul); } }
  else dd.textContent = value || '확인된 기록이 없습니다.';
  parent.append(dd);
}
function evidenceHistoryPanel() {
  const section = $('section', null, 'ai-evidence-history');
  section.setAttribute('aria-label', '완료·실패 작업의 근거 이력');
  section.append(heading('내구 작업 근거 이력', '기존 소유자 원장에서 저장된 산출물·검증·정리 기록만 읽습니다. 파일 원문 열기와 작업 재실행은 지원하지 않습니다.'));
  const read = button(evidenceHistory ? '근거 이력 새로 읽기' : '완료·실패 근거 읽기', () => void run(async () => {
    try {
      evidenceHistory = await request('evidence-history');
      evidenceHistoryError = null;
    } catch {
      evidenceHistory = null;
      evidenceHistoryError = '인증 또는 원장 조회에 실패했습니다. 원래 작업을 실행하지 않았습니다. 기존 소유자 도구에서 연결과 원장 무결성을 확인하세요.';
    }
    renderBody();
  }));
  read.setAttribute('aria-label', '완료 및 실패 작업 근거를 읽기 전용으로 조회');
  section.append(read);
  if (evidenceHistoryError) section.append($('p', evidenceHistoryError, 'ai-meta'));
  if (!evidenceHistory) {
    section.append($('p', '조회 전 · 저장된 실행 근거가 아직 표시되지 않았습니다.', 'ai-meta'));
    return section;
  }
  const result = evidenceHistory;
  const status = { AVAILABLE: '등록된 근거', EMPTY: '완료·실패 작업 0건', NOT_INITIALIZED: '내구 작업 원장 미초기화', UNKNOWN: '원장 상태 확인 실패' }[result.status] ?? 'UNKNOWN';
  section.append($('p', status + (result.status === 'AVAILABLE' ? ' · ' + result.shown + '건 표시' : ''), 'ai-meta'));
  section.append($('p', result.nextAction || '원 소유자 도구에서 현재 근거를 확인하세요.', 'ai-meta'));
  if (result.truncated) section.append($('p', '최근 24건만 표시합니다. 전체 내구 작업 이력은 기존 소유자 도구에서 조회하세요.', 'ai-meta'));
  for (const job of result.jobs ?? []) {
    const detail = $('details');
    const label = job.state === 'COMPLETED' ? '완료' : job.state === 'FAILED' ? '실패' : '상태 미확인';
    detail.append($('summary', label + ' · 조회번호 ' + job.key + ' · ' + date(job.updatedAt)));
    const dl = $('dl');
    definition(dl, '작업 상태', label + ' · 원장에 기록된 상태');
    definition(dl, '결과 검토', '원장 validatorStatus: ' + job.validatorStatus + ' · 독립 검증 완료를 뜻하지 않습니다.');
    definition(dl, '산출물', job.artifactCount ? job.artifactCount + '개 등록 · 현재 파일 원문 미확인' : '등록된 산출물 근거 없음');
    if (job.unresolvedArtifactRefs) definition(dl, '누락', job.unresolvedArtifactRefs + '개 참조의 등록 산출물 근거를 찾지 못함');
    if (job.additionalArtifactsOmitted) definition(dl, '추가 자료', '목록 상한을 넘어 나머지는 원 소유자 도구에서 확인 필요');
    const cleanup = job.cleanup ?? {};
    definition(dl, '정리 증거', cleanup.status === 'RECORDED'
      ? '원장 기록 ' + date(cleanup.at) + ' · 정리된 브라우저 lease ' + cleanup.cleanedLeaseCount + '개 · 타 소유자 변경 0(기록 기준)'
      : cleanup.status === 'NO_BOUND_RUN' ? '연결된 역할 작업 없음 · 정리 증거 확인 불가'
        : cleanup.status === 'BINDING_UNKNOWN' ? '원 작업·소유자 결속 불일치 또는 기록 없음 · 확인 필요'
          : '정리 영수증 미기록 · 완료로 추정하지 않습니다.');
    definition(dl, '다음 확인', job.nextAction);
    detail.append(dl);
    if ((job.artifactVerifications ?? []).length) {
      const list = $('ul');
      for (const artifact of job.artifactVerifications) {
        const item = $('li');
        item.append($('strong', artifact.label + ' · ' + artifact.mediaType),
          $('p', '저장된 검증: ' + artifact.verification + ' · ' + date(artifact.verifiedAt) +
            (artifact.referenceInCompletedJob ? ' · 완료 작업 참조에 결속' : ' · 완료 작업 참조와 별도 등록')));
        if (artifact.sha256) { const digest = $('code', artifact.sha256); digest.style.overflowWrap = 'anywhere'; item.append(digest); }
        const checks = $('ul');
        for (const check of artifact.checks ?? []) checks.append($('li', check.type + ' · ' + check.status + ' · ' + date(check.checkedAt)));
        if (checks.children.length) item.append(checks);
        list.append(item);
      }
      detail.append(list);
    }
    detail.append($('p', '파일 내용 열기·현재 파일 해시 재검사는 이 화면에서 제공하지 않습니다. 원 소유자 도구에서 별도 확인해야 합니다.', 'ai-meta'));
    section.append(detail);
  }
  return section;
}
function toolbar() {
  const n = $('div', null, 'ai-toolbar');
  const label = $('label', '찾기'); const input = $('input'); input.type = 'search'; input.value = search; input.placeholder = '이름, 기능, exact 대화 ID';
  input.oninput = () => { search = input.value; renderBody(); }; label.append(input);
  const toggle = button(archive ? '활성 목록 보기' : '완료함 / 보관함', () => { archive = !archive; renderBody(); });
  n.append(label, toggle); return n;
}
function selectedAgent() { return snapshot.agents.find(a => a.id === selection('agent')) ?? snapshot.agents.find(a => !a.archived) ?? snapshot.agents[0]; }
function reports() {
  body.append(createMobileStopStatusCard(snapshot.mobilePublic, 'dashboard'));
  body.append(evidenceHistoryPanel());
  const unread = snapshot.agents.filter(a => a.completionUnread);
  if (unread.length) {
    const notice = $('section', null, 'ai-notice'); notice.setAttribute('aria-label', '확인할 완료 보고'); notice.append($('strong', `확인할 완료 보고 ${unread.length}개`), $('p', '현재 원장 조회에서 확인한 완료 보고입니다. 완료함에 보관된 보고도 포함합니다. 백그라운드 알림이나 실제 발신은 하지 않습니다.', 'ai-meta'));
    for (const a of unread) notice.append(button(a.title + ' · 완료 보고 보기', () => { archive = a.archived; pinned = false; search = ''; navigate('ai-reports', 'agent', a.id); }));
    body.append(notice);
  }
  const controls = toolbar(); controls.append(button(pinned ? '모든 보고' : '핀만 보기', () => { pinned = !pinned; renderBody(); })); body.append(controls);
  const rows = snapshot.agents.filter(a => a.archived === archive && (!pinned || a.pinned) && `${a.title} ${a.id} ${a.summary}`.toLowerCase().includes(search.toLowerCase()));
  const split = $('div', null, 'ai-split'), list = $('div', null, 'ai-list'); list.setAttribute('aria-label', '등록 에이전트 보고');
  const current = rows.find(a => a.id === selection('agent')) ?? rows[0];
  for (const a of rows) {
    const b = button((a.pinned ? '📌 ' : '') + a.title, () => navigate('ai-reports', 'agent', a.id));
    b.setAttribute('aria-current', String(a.id === current?.id)); b.append($('small', (a.unitReport ? '최신 단위 ' + a.unitReport.status : a.state) + ' · ' + date(a.updatedAt))); list.append(b);
  }
  if (!rows.length) list.append($('p', '해당하는 보고가 없습니다.'));
  const detail = $('article', null, 'ai-detail');
  if (current) {
    const header = $('div', null, 'ai-report-header'); header.append(heading(current.title, `${current.id} / ${current.unitReport ? '최신 단위 ' + current.unitReport.status + ' · 현재 실행 미확인' : current.state}`));
    header.append($('code', current.resumeCommand ?? 'resume 준비 안 됨', 'ai-resume'), $('p', current.resumeReason, 'ai-meta'));
    const actions = $('div', null, 'ai-actions');
    actions.append(button('resume 확인 / 복사', () => run(async () => {
      const state = await request('dashboard-resume-check', { agentId: current.id, expectedReportRevision: current.reportRevision });
      if (!state.supported) { message('재개 명령 준비 안 됨 · 기존 선택기의 정상 종료·작성권 해제·실행 경로와 해제 영수증 만료를 확인하세요. ' + state.reason, true); return; }
      editor.replaceChildren($('h2', 'exact 대화 재개 명령'), $('p', state.reason), $('p', `${state.provider} / ${state.model} / ${state.effort || '기존 설정'} · 만료 ${date(state.expiresAt)}`, 'ai-meta'), $('code', state.command, 'ai-resume'), button('명령 복사', () => run(async () => {
        if (Date.parse(state.expiresAt) <= Date.now()) throw Error('재개 근거가 만료됐습니다. 다시 확인하세요.');
        await navigator.clipboard.writeText(state.command); message('검사된 재개 명령을 복사했습니다. 아직 실행하지 않았습니다.');
      })), button('닫기', () => editor.close())); editor.showModal();
    }), !local), button('PC mux 연결 확인', async () => {
      if (busy) return;
      let state;
      await run(async () => {
      state = await request('dashboard-terminal?agentId=' + encodeURIComponent(current.id));
      if (!state.supported) { message('PC mux 연결을 준비할 수 없습니다. ' + ({ terminal_picker_upgrade_required: '등록된 선택기의 AttachOnly 계약 적용이 필요합니다.', terminal_picker_attach_unavailable: '열린 exact Codex 터미널이 필요합니다. 닫힌 기록을 재개하지 않습니다.', terminal_picker_ambiguous: '같은 대화에 여러 기록이 있어 기존 선택기에서 조정해야 합니다.', terminal_picker_not_registered: '기존 선택기에 연결된 exact 기록이 없습니다.' }[state.reason] ?? '등록·해시·현재 대상의 근거를 기존 선택기에서 확인하세요.'), true); return; }
      });
      if (state?.supported) await preview({ action: 'mux-attach', agentId: current.id, expectedReportRevision: current.reportRevision, expectedTerminalRevision: state.revision }, 'terminal');
    }), button(current.pinned ? '핀 해제' : '핀', () => preview({ action: 'pin', agentId: current.id, pinned: !current.pinned })), button('다음 지시 쌓기', () => navigate('ai-queue', 'agent', current.id)));
    if (current.complete) actions.append(button(current.completionUnread ? '완료 보고 확인' : '완료 보고 확인됨', () => preview({ action: 'report-seen', agentId: current.id, expectedReportRevision: current.reportRevision }), !current.completionUnread));
    header.append(actions, $('p', 'resume 확인/복사는 PC 로컬에서 닫힌 대화의 fresh 해제 근거를 확인하고 명령만 제공합니다. 폰에서는 기존 SSH 선택기를 사용하세요. PC mux 연결 확인은 열린 exact 대상에 연결 창을 요청하며 닫힌 대화는 재개하지 않습니다.', 'ai-meta'));
    if (current.muxCommand) header.append($('code', current.muxCommand, 'ai-resume'), button('기존 mux 연결 명령 복사', () => run(async () => { await navigator.clipboard.writeText(current.muxCommand); message('기존 mux 연결 명령을 복사했습니다.'); })));
    const dl = $('dl');
    if (current.unitReport) {
      definition(dl, '최신 확정 단위 결과', `${current.unitReport.status} · ${date(current.unitReport.at)} · ${current.unitReport.resultName}`);
      definition(dl, '작성권 반환', '이 결과 단위는 기존 중앙에 반환됐습니다. 현재 실행 여부·전체 완료와 별개입니다.');
      definition(dl, '기존 실행 원장 상태', `${current.legacyState} · ${date(current.legacyStateAt)} · 과거 state 기록이며 최신 단위 결과와 구분합니다.`);
      definition(dl, '현재 등록 단위 상태', `${current.unitReport.currentRegistrationState} · 실제 실행 여부는 별도 관측이 필요합니다.`);
    }
    definition(dl, '한 줄 결론', current.summary); definition(dl, '완료한 것 / 검사 근거', current.completed); definition(dl, '남은 것', current.remaining); definition(dl, '필요한 선택 / 입력', current.choices); definition(dl, '다음 행동', current.nextAction); definition(dl, '근거', current.evidence);
    detail.append(header, dl, $('p', '종료·오류·한도 대기는 전체 완료가 아닙니다. 명시적 전체 완료와 미결 없음이 함께 확인된 핀 없는 보고만 완료함으로 이동합니다.', 'ai-meta'));
    for (const action of current.userActions ?? []) {
      const card = $('section', null, 'ai-user-action'); card.append(heading('사용자 할 일 · ' + action.title, `${action.id} / ${action.state}`));
      const facts = $('dl'); definition(facts, '할 일', action.ask); definition(facts, '필요한 이유', action.why); definition(facts, '방법', action.steps); definition(facts, '완료 기준', action.completionCriteria); if (action.agentNext) definition(facts, '완료 뒤 에이전트의 다음 행동', action.agentNext);
      const form = $('form'), label = $('label', '실제로 마친 내용 / 완료 근거'), evidence = $('textarea'), submit = $('button', '사용자 할 일 완료 미리보기');
      evidence.required = true; evidence.maxLength = 420; label.append(evidence); submit.type = 'submit'; submit.disabled = snapshot.userActionCompletionSupported !== true;
      form.append(label, $('p', submit.disabled ? '현재 설치된 서비스는 보고에서 완료 처리를 지원하지 않습니다.' : '완료 기준을 충족한 근거를 적고 다음 화면에서 확인하세요. 사용자 할 일만 완료하며 지시 전송·에이전트 재개·목표 완료는 별도입니다.', 'ai-meta'), submit);
      form.onsubmit = e => { e.preventDefault(); void preview({ action: 'user-action-complete', agentId: current.id, expectedReportRevision: current.reportRevision, id: action.id, expectedActionRevision: action.revision, evidence: evidence.value }, 'user-action'); };
      card.append(facts, form); detail.append(card);
    }
    const replyForm = $('form'), replyLabel = $('label', '이 보고에 대한 응답 / 선택한 내용'), reply = $('textarea'), save = $('button', '이 에이전트의 미전송 큐에 저장');
    reply.required = true; reply.maxLength = 4000; replyLabel.append(reply); save.type = 'submit';
    replyForm.append(replyLabel, $('p', '위 exact 대화에 연결된 미전송 지시로 저장합니다. 실제 전달·실행·사용자 할 일 완료 처리는 별도입니다.', 'ai-meta'), save);
    replyForm.onsubmit = e => { e.preventDefault(); void preview({ action: 'report-reply', agentId: current.id, expectedReportRevision: current.reportRevision, instruction: reply.value }); };
    detail.append(replyForm);
  } else detail.append($('p', '보고를 선택하세요.'));
  split.append(list, detail); body.append(split);
}
function nodeForm(node = null, parent = null) {
  editor.replaceChildren($('h2', node ? '작업 설명 편집' : '항목 추가'));
  const form = $('form'), inputs = {};
  function field(key, title, type = 'textarea', value = '') {
    const label = $('label', title), input = $(type); input.value = value; input.name = key; input.maxLength = key === 'title' ? 240 : 1200; label.append(input); form.append(label); inputs[key] = input; return input;
  }
  const kind = node?.kind ?? (parent ? parent.kind === 'group' ? 'project' : 'feature' : 'group');
  field('title', '이름', 'input', node?.title ?? '').required = true;
  if (kind !== 'group') {
    const select = field('parentId', '상위 항목 / 이동', 'select');
    for (const n of snapshot.nodes.filter(n => n.id !== node?.id && (kind === 'project' ? n.kind === 'group' : ['project', 'feature'].includes(n.kind)))) {
      const option = $('option', n.title); option.value = n.id; select.append(option);
    }
    select.value = node?.parentId ?? parent?.id ?? '';
  }
  for (const [key, title] of fields) field(key, title, 'textarea', node?.[key] ?? '');
  const actions = $('div', null, 'ai-actions'); const save = $('button', '미리보기'); save.type = 'submit';
  actions.append(button('닫기', () => editor.close()), save); form.append(actions);
  form.onsubmit = e => { e.preventDefault(); editor.close(); void preview({ action: 'node-save', ...(node ? { id: node.id } : { kind }), parentId: inputs.parentId?.value ?? null, ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value])) }); };
  editor.append($('p', '화면의 분류·설명만 저장합니다. 저장소·계정·에이전트를 새로 만들지 않습니다.', 'ai-meta'), form); editor.showModal();
}
function moveNode(node, delta) {
  const ids = snapshot.nodes.filter(n => n.parentId === node.parentId).map(n => n.id), from = ids.indexOf(node.id), to = from + delta;
  if (to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  void preview({ action: 'node-order', parentId: node.parentId, ids });
}
function mergeNode(node) {
  editor.replaceChildren($('h2', '현재 원문과 화면 편집 병합'));
  const form = $('form'), choices = {};
  for (const [key, title] of [['title', '이름'], ['parentId', '상위 항목'], ...fields]) {
    const row = $('fieldset'); row.append($('legend', title));
    const describe = value => key === 'parentId' ? snapshot.nodes.find(n => n.id === value)?.title ?? '없음' : value || '확인된 기록 없음';
    const dl = $('dl'); definition(dl, '현재 원문', describe(node.sourceCurrent[key])); definition(dl, '현재 화면 편집', describe(node[key])); row.append(dl);
    const label = $('label', title + ' 선택'), select = $('select'); select.required = true;
    for (const [value, text] of [['', '직접 선택하세요'], ['source', '현재 원문 채택 · 이후 원장 변경 반영'], ['edited', '기존 화면 편집 유지']]) { const option = $('option', text); option.value = value; select.append(option); }
    label.append(select); row.append(label); form.append(row); choices[key] = select;
  }
  const save = $('button', '병합 미리보기'); save.type = 'submit'; const actions = $('div', null, 'ai-actions'); actions.append(button('닫기', () => editor.close()), save); form.append(actions);
  form.onsubmit = e => { e.preventDefault(); editor.close(); void preview({ action: 'node-merge', id: node.id, expectedSourceHash: node.sourceHash, choices: Object.fromEntries(Object.entries(choices).map(([key, value]) => [key, value.value])) }); };
  editor.append($('p', '항목별로 원문 채택과 편집 유지를 선택하세요. 원제품 파일·실행 상태·큐는 보존합니다. 선택이 끝나도 기존 변경 미리보기와 확인을 거쳐 저장합니다.', 'ai-meta'), form); editor.showModal();
}
function work() {
  const controls = toolbar(); controls.append(button('그룹 추가', () => nodeForm())); body.append(controls);
  const split = $('div', null, 'ai-split'), list = $('div', null, 'ai-list'), detail = $('article', null, 'ai-detail');
  function isArchived(node, seen = new Set()) { if (seen.has(node.id)) return true; seen.add(node.id); return node.archived || (node.parentId && snapshot.nodes.find(n => n.id === node.parentId) && isArchived(snapshot.nodes.find(n => n.id === node.parentId), seen)); }
  const rows = [];
  function walk(parentId = null, depth = 0) {
    if (depth > 30) return;
    for (const n of snapshot.nodes.filter(n => n.parentId === parentId)) {
      if (!!isArchived(n) === archive && `${n.title} ${n.sourceId} ${n.description}`.toLowerCase().includes(search.toLowerCase())) rows.push({ ...n, depth });
      walk(n.id, depth + 1);
    }
  }
  walk(); const current = rows.find(n => n.id === selection('work')) ?? rows[0];
  for (const n of rows) {
    const b = button(`${'　'.repeat(Math.min(n.depth, 3))}${n.kind === 'group' ? n.sourceId ?? '그룹' : n.kind === 'project' ? '프로젝트' : '기능'} · ${n.title}`, () => navigate('ai-work', 'work', n.id));
    b.setAttribute('aria-current', String(n.id === current?.id)); list.append(b);
  }
  if (current) {
    detail.append(heading(current.title, `${current.id} / ${current.status || '추가 기록'} / 원장 분류이며 실사용 증거와 구분됩니다.`));
    if (current.sourceConflict) {
      detail.append($('p', '화면에서 편집한 뒤 원제품 원장도 변경됐습니다. 아래 현재 원문과 비교해 설명을 갱신하세요. 기존 편집은 보존했습니다.', 'ai-notice'));
      const original = $('details'); original.append($('summary', '변경된 원문 보기'));
      const values = $('dl'); definition(values, '원문 이름', current.sourceCurrent.title);
      for (const [key, title] of fields) definition(values, title, current.sourceCurrent[key]); original.append(values); detail.append(original);
      detail.append(button('원문과 편집 비교 / 병합', () => mergeNode(current)));
    }
    const actions = $('div', null, 'ai-actions');
    actions.append(button('설명 편집 / 이동', () => nodeForm(current), current.sourceConflict), button(current.kind === 'group' ? '프로젝트 추가' : '기능 추가', () => nodeForm(null, current)), button(current.archived ? '복원' : '보관', () => preview({ action: 'node-archive', id: current.id, archived: !current.archived })), button('위로', () => moveNode(current, -1)), button('아래로', () => moveNode(current, 1)));
    const dl = $('dl');
    for (const [key, title] of fields) {
      const origin = current.fieldOrigins?.[key];
      const scope = origin === 'source' && ['current', 'remaining'].includes(key) && current[`${key}Scope`] === 'project' ? ' · 프로젝트 공통 기록' : '';
      const note = { annotation: '화면 편집', source: '원장 기록', unconfirmed: '원문 미확인' }[origin];
      definition(dl, note ? `${title} (${note}${scope})` : title, current[key]);
    }
    if (current.sourceRecord) {
      definition(dl, '요구사항 완료 기준 · 실제 통과 증거와 구분', current.acceptance);
      definition(dl, '설명 출처', `${current.sourceRecord.file} / ${current.sourceRecord.projectId} / ${current.sourceRecord.requirementId}`);
    }
    detail.append(actions, dl, $('p', '원제품 원문에서 확인되지 않은 방식·기본값·운영 상태는 확인 안 됨으로 유지합니다. 보관은 원본이나 대화를 삭제하지 않습니다.', 'ai-meta'));
  } else detail.append($('p', '해당하는 항목이 없습니다.'));
  split.append(list, detail); body.append(split); editHistory();
}
function editHistory() {
  const panel = $('details'); panel.append($('summary', '편집 이력 / 안전한 되돌리기'));
  panel.append($('p', '최근 60회의 작업 설명·분류·정렬·핀 변경을 보관합니다. 되돌릴 항목이 이후 바뀌거나 원문이 달라지면 중단합니다. 지시·전송·실행·목표 상태는 되돌리지 않습니다.', 'ai-meta'));
  const names = { pin: '보고 핀', 'node-save': '설명 / 분류', 'node-merge': '원문 / 편집 병합', 'node-archive': '보관 / 복원', 'node-order': '순서' };
  const rows = [...(snapshot.editHistory ?? [])].reverse();
  if (!rows.length) panel.append($('p', '기록된 편집 이력이 없습니다.'));
  for (const entry of rows) {
    const row = $('div', null, 'ai-queue-item');
    row.append($('p', `${date(entry.at)} · ${names[entry.action] ?? entry.action}`), $('p', entry.changes.map(c => c.title).join(' / ')));
    if (entry.undoneAt) row.append($('p', '되돌림 완료 · ' + date(entry.undoneAt), 'ai-meta'));
    else row.append(button('이 편집 되돌리기', () => preview({ action: 'metadata-undo', historyId: entry.id }), !entry.undoSupported));
    panel.append(row);
  }
  body.append(panel);
}
function reorder(agentId, id, targetId) {
  const ids = snapshot.queue.filter(q => q.agentId === agentId && q.state === 'UNSENT' && !q.attemptId).map(q => q.id);
  const from = ids.indexOf(id), to = ids.indexOf(targetId); if (from < 0 || to < 0 || from === to) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]); void preview({ action: 'queue-order', agentId, ids });
}
function queue() {
  const a = selectedAgent(); const label = $('label', '정확한 에이전트'); const select = $('select');
  for (const agent of snapshot.agents) { const o = $('option', `${agent.title} / ${agent.id}`); o.value = agent.id; select.append(o); }
  select.value = a?.id ?? ''; select.onchange = () => navigate('ai-queue', 'agent', select.value); label.append(select); body.append(label);
  body.append($('p', '미전송 저장 → 로컬 인계 준비 → 접수 → 실제 turn → 지시 완료 확인을 구분합니다. 인계 준비는 기존 실행기용 입력만 남깁니다. 이 화면은 직접 발신하거나 자동 실행하지 않습니다.', 'ai-notice'));
  if (!a) { body.append($('p', '등록 에이전트가 없습니다. 목표 원장은 아래에서 확인하세요.')); goalPanel(); return; }
  const original = snapshot.registeredQueue.find(q => q.agentId === a.id);
  if (original) {
    const evidence = $('dl');
    definition(evidence, '기존 큐 / 원 상태 (읽기 전용)', original.state);
    definition(evidence, '원 attempt', original.attemptId ?? '관측 기록 없음');
    definition(evidence, '전송 접수', original.accepted ? 'ACK 기록 있음' : '확인 안 됨');
    definition(evidence, '실제 새 turn', original.turnObserved ? original.turnStatus || '관측됨' : '확인 안 됨');
    definition(evidence, '전체 목표 완료', 'UNKNOWN · 큐 추적 종료와 구분합니다.'); body.append(evidence);
  }
  const next = snapshot.queue.find(q => q.agentId === a.id && !['COMPLETED', 'CANCELLED'].includes(q.state));
  const actions = $('div', null, 'ai-actions'); actions.append(button(snapshot.paused[a.id] ? '에이전트 대기 해제' : '에이전트 일시정지', () => preview({ action: 'queue-pause', agentId: a.id, paused: !snapshot.paused[a.id] })), button(snapshot.stopped ? '전체 새 시작 정지 해제' : '전체 새 시작 정지', () => preview({ action: 'queue-stop', stopped: !snapshot.stopped })), button('선택 에이전트 다음 한 건 준비', () => preview({ action: 'queue-prepare-next', agentId: a.id, id: next.id }), !next || next.state !== 'UNSENT' || !!next.attemptId || !a.handoffSupported || snapshot.stopped || snapshot.paused[a.id]), button('안전한 자동 다음 실행', () => {}, true)); body.append(actions, $('p', '다음 한 건 준비는 현재 순서의 첫 미완료 지시만 미리보기로 확인합니다. 앞 지시가 접수·실행·결과 불명·완료 확인 대기이면 건너뛰지 않습니다. 실제 발신·자동 실행은 하지 않습니다.', 'ai-meta'), $('p', a.deliveryReason, 'ai-meta'));
  const form = $('form'), instructionLabel = $('label', '다음 지시 / 이 저장을 승인한 내용만 남깁니다.'), instruction = $('textarea'); instruction.maxLength = 4000; instruction.required = true; instructionLabel.append(instruction);
  const goalLabel = $('label', '연결할 AICC 목표 (선택)'), goal = $('select'); goal.append($('option', '연결 안 함')); goal.firstChild.value = '';
  for (const g of (goals?.goals ?? []).filter(g => !g.archived && g.status !== 'COMPLETE')) { const o = $('option', g.title); o.value = g.id; goal.append(o); } goalLabel.append(goal);
  const nodeLabel = $('label', '연결할 작업 (선택)'), node = $('select'); const none = $('option', '연결 안 함'); none.value = ''; node.append(none);
  for (const n of snapshot.nodes.filter(n => n.kind !== 'group' && !n.archived)) { const o = $('option', n.title); o.value = n.id; node.append(o); } nodeLabel.append(node);
  const submit = $('button', '미전송 지시 쌓기'); submit.type = 'submit';
  form.append(instructionLabel, goalLabel, nodeLabel, submit); form.onsubmit = e => { e.preventDefault(); void preview({ action: 'queue-add', agentId: a.id, instruction: instruction.value, goalId: goal.value || null, nodeId: node.value || null }); }; body.append(form);
  const rows = snapshot.queue.filter(q => q.agentId === a.id && q.state !== 'CANCELLED'), unsent = rows.filter(q => q.state === 'UNSENT' && !q.attemptId);
  body.append($('h3', `저장된 지시 ${rows.length}개`));
  for (const q of rows) {
    const item = $('article', null, 'ai-queue-item'); item.dataset.queueId = q.id; const editable = q.state === 'UNSENT' && !q.attemptId;
    item.append($('small', `${queueStates[q.state] ?? q.state} / ${q.attemptId ?? '전달 시도 없음'}`), $('strong', q.instruction));
    if (q.turnId) item.append($('p', '원 turn: ' + q.turnId, 'ai-meta'));
    if (q.completion) item.append($('p', '직접 확인한 결과: ' + q.completion.summary, 'ai-meta'));
    if (q.reportRef) item.append($('p', '보고에 대한 응답 · 원 보고 시각: ' + date(q.reportRef.updatedAt), 'ai-meta'));
    const controls = $('div', null, 'ai-actions'); const index = unsent.indexOf(q);
    const move = delta => { if (unsent[index + delta]) reorder(a.id, q.id, unsent[index + delta].id); };
    controls.append(button('위로', () => move(-1), !editable || index === 0), button('아래로', () => move(1), !editable || index === unsent.length - 1), button('수정', () => {
      editor.replaceChildren($('h2', '미전송 지시 수정')); const f = $('form'), l = $('label', '지시'), t = $('textarea'), save = $('button', '미리보기'); t.value = q.instruction; t.required = true; t.maxLength = 4000; l.append(t); f.append(l, save, button('닫기', () => editor.close()));
      f.onsubmit = e => { e.preventDefault(); editor.close(); void preview({ action: 'queue-edit', id: q.id, instruction: t.value }); }; editor.append(f); editor.showModal();
    }, !editable), button('미전송 취소', () => preview({ action: 'queue-cancel', id: q.id }), !editable));
    const handle = button('↕ 순서 이동', () => message('드래그하거나 Alt+위/아래 또는 옆의 위로·아래로 버튼을 사용하세요.'), !editable);
    handle.onkeydown = e => { if (e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); move(e.key === 'ArrowUp' ? -1 : 1); } };
    handle.style.touchAction = 'none';
    handle.onpointerdown = e => { if (!editable || e.pointerType === 'mouse') return; dragged = q.id; handle.setPointerCapture(e.pointerId); };
    handle.onpointerup = e => { if (!dragged || e.pointerType === 'mouse') return; const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-queue-id]'); const from = dragged; dragged = null; if (target) reorder(a.id, from, target.dataset.queueId); };
    handle.onpointercancel = () => { dragged = null; };
    controls.prepend(handle); item.append(controls); item.draggable = editable;
    if (editable) controls.append(button('로컬 인계 준비', () => preview({ action: 'queue-prepare', id: q.id }), !a.handoffSupported || snapshot.stopped || snapshot.paused[a.id] || snapshot.queue.find(row => row.agentId === a.id && !['COMPLETED', 'CANCELLED'].includes(row.state))?.id !== q.id));
    if (q.state === 'HANDOFF_READY') controls.append(button('실행 전 조건 조회', () => run(async () => {
      const result = await request('dashboard-queue-preflight', { id: q.id, expectedRevision: snapshot.revision });
      message(result.ready ? result.reason : '실행 전 조건 확인 보류 · ' + ({ queue_preflight_upgrade_required: '등록 helper의 새 사전 검사 계약 적용이 필요합니다.', queue_preflight_evidence_or_registration_missing: '기존 공식 관측 owner의 fresh exact 대상·경로 근거가 필요합니다.' }[result.reason] ?? result.reason) + ' · 지시는 보존하며 발신하지 않습니다.', !result.ready);
    })));
    if (q.state === 'HANDOFF_READY') controls.append(button('이 한 건 보내기', () => preview({ id: q.id, expectedRevision: snapshot.revision }, 'queue-send'), snapshot.stopped || snapshot.paused[a.id]));
    if (q.attemptId && !['COMPLETED', 'CANCELLED'].includes(q.state)) controls.append(button('원 영수증 조정', () => preview({ action: 'queue-reconcile', id: q.id })));
    if (q.state === 'TURN_COMPLETED') controls.append(button('이 지시 완료 확인', () => {
      editor.replaceChildren($('h2', '실제 결과를 확인했나요?'), $('p', 'turn 종료는 지시 전체 완료와 다릅니다. 실제 결과를 직접 확인한 뒤 이 지시의 완료 내용만 적으세요. Codex goal은 변경하지 않습니다.'));
      const form = $('form'), label = $('label', '직접 확인한 완료 결과'), summary = $('textarea'), save = $('button', '완료 확인 미리보기'); summary.required = true; summary.maxLength = 800; label.append(summary); form.append(label, save, button('닫기', () => editor.close()));
      form.onsubmit = e => { e.preventDefault(); editor.close(); void preview({ action: 'queue-complete', id: q.id, expectedAttemptId: q.attemptId, summary: summary.value }); }; editor.append(form); editor.showModal();
    }));
    item.ondragstart = e => { dragged = q.id; e.dataTransfer.setData('text/plain', q.id); };
    item.ondragover = e => { if (editable) { e.preventDefault(); item.dataset.drop = 'true'; } };
    item.ondragleave = () => delete item.dataset.drop;
    item.ondrop = e => { e.preventDefault(); delete item.dataset.drop; const from = dragged; dragged = null; if (from && editable) reorder(a.id, from, q.id); };
    item.ondragend = () => { dragged = null; }; body.append(item);
  }
  goalPanel();
}
function goalForm(goal = null) {
  editor.replaceChildren($('h2', goal ? '목표 설명 / 의존 관계 편집' : '추적 목표 추가'));
  const form = $('form'), titleLabel = $('label', '목표 이름'), title = $('input'), descriptionLabel = $('label', '하려는 일 / 완료 기준'), description = $('textarea');
  title.value = goal?.title ?? ''; title.maxLength = 240; title.required = true; titleLabel.append(title);
  description.value = goal?.description ?? ''; description.maxLength = 2000; descriptionLabel.append(description);
  const dependencies = $('fieldset', null, 'ai-goal-dependencies'); dependencies.append($('legend', '먼저 완료해야 할 목표 (선택)'));
  const checks = [];
  for (const other of goals.goals.filter(g => g.id !== goal?.id)) {
    const label = $('label'), check = $('input'); check.type = 'checkbox'; check.value = other.id; check.checked = goal?.dependsOn?.includes(other.id) ?? false; check.disabled = other.archived && !check.checked;
    label.append(check, document.createTextNode(other.title + (other.archived ? ' · 보관됨' : ''))); dependencies.append(label); checks.push(check);
  }
  const actions = $('div', null, 'ai-actions'), save = $('button', '변경 미리보기'); save.type = 'submit'; actions.append(button('닫기', () => editor.close()), save);
  form.append(titleLabel, descriptionLabel, dependencies, actions);
  form.onsubmit = e => { e.preventDefault(); editor.close(); void preview({ action: 'goal-save', ...(goal ? { goalId: goal.id } : {}), title: title.value, description: description.value, dependsOn: checks.filter(c => c.checked).map(c => c.value) }, 'goal'); };
  editor.append($('p', '기존 AICC 추적 원장에 저장합니다. 새 목표의 운영 상태는 미배정이며 편집으로 실행·완료 처리하지 않습니다.', 'ai-meta'), form); editor.showModal();
}
function goalPanel() {
  const section = $('section', null, 'ai-goals'); section.append($('h3', 'AICC 추적 목표'));
  section.append($('p', '설명·의존 관계·보관을 같은 원장에 저장합니다. 의존 목표가 실제 완료로 기록돼야 연결 지시를 로컬 준비할 수 있습니다. 사용자 체크·한 turn 종료·설명 편집은 목표 완료가 아닙니다. Codex 내장 goal은 조회·변경하지 않습니다.', 'ai-meta'));
  const editable = goals?.readOnly === false && !!goals.sourceRevision && !goals.summary.truncated;
  const actions = $('div', null, 'ai-actions'); actions.append(button('목표 추가', () => goalForm(), !editable), button(showArchivedGoals ? '활성 목표 보기' : '목표 보관함', () => { showArchivedGoals = !showArchivedGoals; renderBody(); })); section.append(actions);
  if (!editable) section.append($('p', goals ? '현재 서비스 또는 조회 범위는 목표 편집을 지원하지 않습니다.' : '목표 원장을 읽지 못했습니다. 새로 조회하세요.', 'ai-notice'));
  const names = { ACTIVE: '진행 중', HOLD: '대기', REVIEW_READY: '검토 준비', USER_MANAGED_READY: '사용자 관리 준비', COMPLETE: '완료', UNASSIGNED: '미배정' };
  for (const goal of (goals?.goals ?? []).filter(g => !!g.archived === showArchivedGoals)) {
    const row = $('article', null, 'ai-queue-item'); row.append($('strong', goal.title), $('p', `${goal.id} / ${names[goal.status] ?? '상태 확인 필요'}`));
    const dl = $('dl'); definition(dl, '하려는 일 / 완료 기준', goal.description); definition(dl, '먼저 완료할 목표', (goal.dependsOn ?? []).map(id => { const other = goals.goals.find(g => g.id === id); return other ? `${other.title} · ${names[other.status] ?? other.status}${other.archived ? ' · 보관됨' : ''}` : `${id} · 원장 확인 필요`; })); row.append(dl);
    const controls = $('div', null, 'ai-actions'); controls.append(button('설명 / 의존 관계 편집', () => goalForm(goal), !editable), button(goal.archived ? '목표 복원' : '목표 보관', () => preview({ action: 'goal-archive', goalId: goal.id, archived: !goal.archived }, 'goal'), !editable)); row.append(controls); section.append(row);
  }
  body.append(section);
}
function renderBody() { if (!snapshot) return; body.replaceChildren(); if (tab() === 'ai-work') work(); else if (tab() === 'ai-queue') queue(); else reports(); }
function render() {
  const active = (!location.hash && location.pathname !== '/mobile.html') || !!tabNames[location.hash.slice(1)]; root.hidden = !active;
  document.body.classList.toggle('ai-primary', active);
  for (const a of tabs.children) { if (a.hash === '#' + tab()) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  renderBody();
}
async function connect() {
  await run(async () => {
    try { await load(); }
    catch (error) {
      const loopback = location.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
      if (error.code === 'pair_required' && loopback && location.pathname !== '/mobile.html') { await request('local-session', {}); await load(); }
      else throw error;
    }
    const operation = localStorage.getItem('aicc.dashboard.pendingOperation');
    if (operation) { message('원래 저장 결과를 확인해야 합니다. 자동 재발신하지 않습니다.', true); statusLine.append(button('원래 결과 조회', () => run(() => outcome(operation)))); }
  });
}
if (root) {
  const top = $('div', null, 'ai-top'); top.append($('h2', 'AI 통합 대시보드'));
  const ops = $('a', '운영 / 설정', 'ai-button'); ops.href = location.pathname === '/mobile.html' ? '#tools' : '#system';
  const topActions = $('div', null, 'ai-actions'); topActions.append(button('새로 조회', connect), ops);
  if (location.pathname === '/mobile.html') { const collaboration = $('a', '협업 실행', 'ai-button'); collaboration.href = '#orchestration'; topActions.append(collaboration); }
  const installed = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const install = button(installed() ? '앱으로 실행 중' : '앱 설치', async () => {
    if (installed()) { message('앱으로 실행 중입니다. 작업은 연결된 PC·서버에서 계속됩니다.'); return; }
    if (!installPrompt) { message('브라우저 메뉴의 앱 설치를 확인하세요. 설치할 수 없으면 웹으로 계속 사용할 수 있습니다. 연결된 PC·서버가 켜져 있어야 합니다.'); return; }
    const prompt = installPrompt; installPrompt = null; install.disabled = true;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      message(choice.outcome === 'accepted' ? '설치를 요청했습니다. 홈 화면에서 AICC를 열어 완료를 확인하세요.' : '설치를 취소했습니다. 웹에서 계속 사용할 수 있습니다.');
    } catch { message('설치 창을 열지 못했습니다. 브라우저 메뉴에서 앱 설치를 확인하세요.', true); }
    finally { install.disabled = installed(); install.textContent = installed() ? '앱으로 실행 중' : '앱 설치'; }
  }); install.disabled = installed(); topActions.append(install);
  topActions.append(button('앱 업데이트', async event => {
    if (busy || editor.open || confirmDialog.open || document.querySelector('input:focus,textarea:focus')) {
      message('편집·확인 중인 내용을 먼저 마쳐 주세요. 업데이트는 지시를 다시 보내지 않습니다.'); return;
    }
    const control = event.currentTarget; control.disabled = true;
    try {
      const check = await fetch('/mobile.html', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(12000) });
      if (!check.ok) throw Error('연결 확인 실패');
      if ('serviceWorker' in navigator) await (await navigator.serviceWorker.getRegistration())?.update();
      location.reload();
    } catch { message('업데이트를 가져오지 못했습니다. 기존 화면은 유지했습니다. 연결 후 다시 시도하세요.', true); }
    finally { control.disabled = false; }
  }));
  const help = $('a', '설치 안내', 'ai-button'); help.href = '/install.html'; topActions.append(help); top.append(topActions);
  tabs = $('nav', null, 'ai-tabs'); tabs.setAttribute('aria-label', 'AI 대시보드 주 메뉴');
  for (const [id, name] of Object.entries(tabNames)) { const a = $('a', name); a.href = '#' + id; a.id = id; a.onclick = e => { if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; e.preventDefault(); navigate(id); }; tabs.append(a); }
  statusLine = $('p', '기존 연결을 확인하고 있습니다.', 'ai-notice'); statusLine.setAttribute('role', 'status');
  body = $('div'); editor = $('dialog'); confirmDialog = $('dialog'); root.append(top, tabs, statusLine, body, editor, confirmDialog);
  window.addEventListener('popstate', render); window.addEventListener('hashchange', render); window.addEventListener('aicc:panel-change', render);
  window.addEventListener('aicc:session-ready', () => { if (!initialized) { if (busy) needsConnect = true; else void connect(); } });
  window.addEventListener('offline', () => message('연결 끊김 · 표시된 값은 마지막 조회입니다. 지시를 자동 재전송하지 않습니다.', true));
  window.addEventListener('online', () => message('네트워크가 돌아왔습니다. 새로 조회해 실제 연결과 원 결과를 확인하세요.'));
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; });
  window.addEventListener('appinstalled', () => { installPrompt = null; install.disabled = true; install.textContent = '앱 설치됨'; message('앱 설치가 확인됐습니다. 홈 화면에서 AICC를 열 수 있습니다.'); });
  if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/aicc-sw.js').catch(() => message('앱 준비를 확인하지 못했습니다. 웹은 계속 사용할 수 있습니다. 연결 후 새로 조회해 주세요.', true));
  render(); void connect();
}
