const mobileStopReasons = Object.freeze({
  EXISTING_STOP_OUTCOME_UNCONFIRMED: '이전에 보낸 정상 종료 요청의 결과를 확인하지 못했습니다. 원 요청을 확인할 때까지 새 요청을 보내지 않습니다.',
  EXISTING_STOP_INVENTORY_UNKNOWN: '기존 정상 종료 요청을 정확히 읽지 못했습니다. 원 기록을 보존하고 새 요청을 차단합니다.',
  INSTALLED_SUPERVISOR_DATE_STRING_UNSUPPORTED: '현재 설치된 구세대 supervisor는 날짜 문자열 보존을 지원하지 않습니다. 새 정상 종료 요청을 보내면 안 됩니다.',
  INSTALLED_SUPERVISOR_IDENTITY_UNKNOWN: '설치 manifest 또는 supervisor 파일 신원을 확인하지 못했습니다.',
  INSTALLED_SUPERVISOR_JSON_CONTRACT_UNKNOWN: '설치본의 JSON 날짜 처리 방식을 확인하지 못했습니다.',
  INSTALLED_SUPERVISOR_PARSE_UNKNOWN: '설치본의 날짜 처리 구문을 확인하지 못했습니다.',
  STATUS_AMBIGUOUS: '실행 중이라고 기록된 세대가 여럿이므로 어느 설치본인지 결정할 수 없습니다.',
  STATUS_UNAVAILABLE: '설치된 운영 기록을 정확히 읽지 못했습니다.',
  PROBE_UNAVAILABLE: '정상 종료 지원 조회가 실패했거나 설치본 확인 결과가 일치하지 않습니다.'
});

/** Read-only shared view for the existing dashboard and management overview. */
export function createMobileStopStatusCard(value, surface = 'management') {
  const node = (tag, text, cls) => {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (cls) el.className = cls;
    return el;
  };
  const state = value && typeof value === 'object' ? value : null;
  const card = node('article', null, 'cowork-manager');
  card.setAttribute('aria-label', 'G3 모바일 정상 종료와 운영 설치 상태');
  card.append(node('h4', 'G3 모바일 제어 · 정상 종료 지원'));
  const reported = state?.reportedRuntimeState === 'LISTENING' ? '기록상 LISTENING'
    : state?.reportedRuntimeState === 'DRAINING' ? '기록상 종료 처리 중'
    : 'UNKNOWN';
  card.append(node('p', '현재 운영 · ' + reported + ' (실제 프로세스 신원·생존 별도 확인)'));
  const installed = state?.installedSupervisorSupport === 'SUPPORTED'
    ? state.stopSubmissionSupported === true ? '지원 확인 · 설치 supervisor의 날짜 원문 처리 검증' : '지원 확인 · 기존 요청 확인 전 새 요청 차단'
    : state?.installedSupervisorSupport === 'UNSUPPORTED' && state.stopSubmissionSupported === false
      ? '구세대 미지원 · 정상 종료 요청 차단'
      : 'UNKNOWN · 지원 확인 전 요청 차단';
  card.append(node('p', '설치본 정상 종료 · ' + installed));
  const source = state?.sourceComparison === 'DIFFERS'
    ? '현재 수리 소스와 설치본 파일이 다릅니다. 소스 준비는 운영 적용이 아닙니다.'
    : state?.sourceComparison === 'MATCHES'
      ? '현재 소스와 설치 파일은 같습니다. 실제 실행 중인 버전은 별도 확인이 필요합니다.'
      : '소스·설치본 비교 UNKNOWN. 소스 수정만으로 운영 적용을 주장할 수 없습니다.';
  card.append(node('p', '소스 / 설치 · ' + source));
  card.append(node('p', '운영 교체 · 이 화면에서 실행할 수 없습니다. 위 소스·설치 비교와 실행 기록을 확인하세요. 다음 교체에는 정상 종료 ACK·실제 프로세스 퇴장·독립 복구 확인이 필요하며, 기존 결과 불명은 보존합니다.'));
  const reasonId = 'g3-stop-reason-' + String(surface).replace(/[^a-z0-9-]/gi, '');
  const explanation = node('p', (mobileStopReasons[state?.stopHoldReason] || (state?.installedSupervisorSupport === 'SUPPORTED'
    ? '설치본이 정상 종료 문법을 지원하더라도 기존 결과 불명과 운영 복구 조건이 남아 있습니다.'
    : '설치본의 정상 종료 지원을 확인하지 못했습니다.')) +
    ' 이 화면은 읽기 전용이며 원 요청 재전송, 강제 종료, 운영 교체를 실행하지 않습니다.', 'meta');
  explanation.id = reasonId;
  explanation.tabIndex = 0;
  explanation.setAttribute('role', 'status');
  card.append(explanation);
  const actions = node('div', null, 'actions');
  for (const title of ['정상 종료 요청 · 보류', '운영 설치 · 보류']) {
    const control = node('button', title);
    control.type = 'button';
    control.disabled = true;
    control.setAttribute('aria-describedby', reasonId);
    actions.append(control);
  }
  card.append(actions);
  return card;
}

export function createCoworkView() {
  const root = document.getElementById('cowork');
  const search = document.getElementById('coworkSearch');
  const scope = document.getElementById('coworkScope');
  const status = document.getElementById('coworkStatus');
  const content = document.getElementById('coworkContent');
  const managers = document.createElement('div'); managers.className = 'cowork-managers';
  root.insertBefore(managers, root.querySelector('.list-toolbar'));
  let documentData = null, pending = null, selectedManager = 'all', managerState = null, managerReading = false, managerError = '';
  const node = (tag, text, className) => { const value = document.createElement(tag); if (text != null) value.textContent = text; if (className) value.className = className; return value; };
  const phaseLabels = { PREPARED: '준비', DISPATCHING: '실행 결과 대기', COMPLETED: '도구 결과 기록', OUTCOME_UNKNOWN_RECONCILE: '원 결과 확인 필요', UNRECOGNIZED: '기록 형식 확인 필요' };
  const stateLabels = { REGISTERED: '기존 관리기 등록됨', NOT_REGISTERED: '등록 근거 없음', OS_ACCESS_DENIED: '파일 읽기 접근 거절', PIN_MISMATCH: '등록 버전 불일치', LINK_REFUSED: '연결 경로 확인 필요', BINDING_INVALID: '등록 형식 확인 필요', PATH_INVALID: '등록 경로 확인 필요', FILE_INVALID: '등록 파일 확인 필요', RECORD_UNREADABLE: '기록을 읽지 못함' };
  async function readManagers() {
    if (managerReading) return;
    managerReading = true; managerError = ''; renderManagement();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch('/api/mobile/management', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw Error(response.status === 404 ? '이 설치판에는 관리 상태 조회가 아직 없습니다.' : '브라우저 연결과 관리 상태 조회를 확인해야 합니다.');
      const value = await response.json(); if (!value.ok || !value.gpt || !value.codex || !value.host) throw Error('관리 상태 응답 형식을 확인해야 합니다.');
      managerState = value;
    } catch (error) { managerState = null; managerError = error.name === 'AbortError' ? '조회 응답을 기다리는 시간이 지났습니다. 자산 작업은 실행하지 않았습니다.' : error.message; }
    finally { clearTimeout(timeout); managerReading = false; renderManagement(); }
  }
  function renderManagement() {
    if (!documentData?.management) return;
    const value = documentData.management, fragment = document.createDocumentFragment();
    fragment.append(node('h3', value.name), node('p', value.description), node('p', value.execution, 'cowork-execution'));
    const tabs = node('div', null, 'cowork-manager-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '관리 대상 선택');
    for (const [id, label] of [['all', 'AICC 관리기'], ...value.children.map(item => [item.scope, item.name])]) {
      const tab = node('button', label); tab.type = 'button'; tab.id = 'manager-tab-' + id; tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(selectedManager === id)); tab.setAttribute('aria-controls', 'manager-panel'); tab.tabIndex = selectedManager === id ? 0 : -1;
      tab.onclick = () => { selectedManager = id; renderManagement(); document.getElementById(tab.id).focus(); };
      tab.onkeydown = event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const ids = ['all', ...value.children.map(item => item.scope)], index = ids.indexOf(selectedManager); selectedManager = ids[event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + ids.length) % ids.length]; renderManagement(); document.getElementById('manager-tab-' + selectedManager).focus(); };
      tabs.append(tab);
    }
    fragment.append(tabs);
    const panel = node('div'); panel.id = 'manager-panel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', 'manager-tab-' + selectedManager);
    for (const item of value.children.filter(item => selectedManager === 'all' || item.scope === selectedManager)) {
      const card = node('article', null, 'cowork-manager'); card.append(node('h4', item.name), node('p', '관리 대상 · ' + item.targets), node('p', '실행 방법 · ' + item.execution));
      const links = node('div', null, 'actions');
      for (const link of item.links) {
        const target = /^#(?:accounts|conversations|tools|web|goals|settings)$/.test(link.href) ? document.getElementById(link.href.slice(1)) : null;
        if (target) { const anchor = node('a', link.label, 'cowork-manager-link'); anchor.href = link.href; links.append(anchor); }
        else { const unavailable = node('button', link.label + ' · 이 화면 미지원'); unavailable.type = 'button'; unavailable.disabled = true; links.append(unavailable); }
      }
      card.append(links);
      if (item.scope === 'gpt') {
        card.append(node('p', '자산 실행 도구 · aicc_web_management_start / aicc_web_management_status. 일반 Chat에서 등록 작업폴더와 기존 lease로 요청합니다. 플러그인 생성·수정은 연결된 Plugin Creator의 create_plugin / update_plugin을 사용합니다. 이 탭을 열거나 조회해도 자산을 변경하지 않습니다.'));
        if (managerState) {
          card.append(node('p', stateLabels[managerState.gpt.status] ?? '등록 상태 확인 필요'));
          if (managerState.gpt.status === 'REGISTERED') {
            const actions = node('details'), title = node('summary', '현재 등록된 자산 작업 ' + managerState.gpt.actions.length + '개'); actions.append(title);
            const list = node('ul'); for (const action of managerState.gpt.actions) list.append(node('li', action)); actions.append(list); card.append(actions);
            const operations = managerState.gpt.operations;
            if (operations) card.append(node('p', '원 작업 ' + operations.records + '건 · ' + Object.entries(operations.phases).map(([phase, count]) => (phaseLabels[phase] ?? '미분류') + ' ' + count).join(' / ')));
            card.append(node('p', '원 결과 불명·보안 거절은 보존합니다. 등록 목록은 현재 로그인 신원·실행 성공·자산 전체 목록의 증거가 아닙니다.', 'meta'));
          }
        }
      } else if (managerState) card.append(node('p', (stateLabels[managerState.codex.status] ?? '등록 상태 확인 필요') + ' · 실제 실행 결과는 각 기능에서 확인합니다.'));
      panel.append(card);
    }
    const read = node('button', managerReading ? '관리 상태 읽는 중…' : '설치·지원·원 작업 상태 조회'); read.type = 'button'; read.disabled = managerReading; read.onclick = () => void readManagers(); panel.append(createMobileStopStatusCard(managerState?.mobilePublic, 'management'), read);
    const notice = node('p', managerError || (managerState ? '조회 ' + new Date(managerState.observedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' KST · 호스트 설치 ' + (managerState.host.toolCount ?? '미확인') + '도구 · 점유 조회 ' + (managerState.host.sessionInventory ? '등록됨' : '미설치 또는 미확인') + ' · 대기 claim/취소 ' + (managerState.host.explicitWait ? '등록됨' : '미설치 또는 미확인') : '조회 전 · 실제 설치 지원은 위 버튼으로 읽습니다. 조회는 자산 실행이나 새 모델 요청을 보내지 않습니다.')); notice.setAttribute('role', 'status'); panel.append(notice);
    fragment.append(panel); managers.replaceChildren(fragment);
  }
  function render() {
    renderManagement();
    const query = search.value.trim().toLocaleLowerCase();
    const entries = [...documentData.terms, ...documentData.rules].filter(item =>
      (scope.value === 'all' || item.scope === scope.value) &&
      `${item.category} ${item.name} ${item.description}`.toLocaleLowerCase().includes(query));
    const fragment = document.createDocumentFragment();
    let category = '';
    for (const item of entries) {
      if (category !== item.category) {
        category = item.category;
        const heading = document.createElement('h3'); heading.textContent = category; fragment.append(heading);
      }
      const term = document.createElement('dt');
      term.textContent = `${documentData.scopes[item.scope]} ${item.name}`;
      const explanation = document.createElement('dd'); explanation.textContent = item.description;
      const list = document.createElement('dl'); list.append(term, explanation); fragment.append(list);
    }
    content.replaceChildren(fragment);
    status.textContent = `${entries.length}개 표시 · 안내 개정 ${documentData.revision} · 현재 설치·작동 여부는 각 기능의 상태와 구분합니다.`;
  }
  search.addEventListener('input', () => { if (documentData) render(); });
  scope.addEventListener('change', () => { if (documentData) render(); });
  async function load() {
    if (documentData) return;
    if (pending) return pending;
    status.textContent = '명칭과 공통·환경별 규칙을 읽고 있습니다.';
    pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch('/ai-cowork.json', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw Error('unavailable');
        const value = await response.json();
        if (value.schemaVersion !== 1 || !Array.isArray(value.terms) || !Array.isArray(value.rules) || !value.scopes) throw Error('format');
        documentData = value; render();
      } catch {
        status.textContent = '안내를 읽지 못했습니다. 아래 다시 읽기를 누르세요. 계정·실행 설정은 변경하지 않았습니다.';
      } finally { clearTimeout(timeout); pending = null; }
    })();
    return pending;
  }
  root.querySelector('[data-cowork-reload]').addEventListener('click', () => { documentData = null; void load(); });
  return { load };
}
