// 관제 실행 화면. 모바일 세션(쿠키 + CSRF)으로 /api/mobile/supervise*만 부른다.
// 변경은 미리보기 → 확인 대화상자 → 한 번 실행. 응답이 끊긴 변경은 다시 보내지 않는다.
const $ = id => document.getElementById(id);
let csrf = null, session = null, status = null, selectedRun = null, selectedGroup = null, pending = null, busy = false;
const errors = {
  local_owner_required: 'PC 로컬 연결에서만 할 수 있는 작업입니다.',
  turn_active: '차례 진행 중이라 닫지 않았습니다. 차례가 끝난 뒤 다시 시도하세요.',
  writer_busy: '다른 관제 변경이 진행 중입니다. 끝난 뒤 다시 시도하세요.',
  stale_preview: '미리보기 뒤 실행 정본이 바뀌었습니다. 새로 미리보세요.',
  confirmation_not_found: '확인이 이미 사용되었거나 없습니다. 새로 미리보세요.',
  confirmation_expired: '확인 시간이 지났습니다. 새로 미리보세요.',
  csrf_required: '연결 정보가 바뀌었습니다. 새로 조회한 뒤 시도하세요. 요청은 실행되지 않았습니다.',
  pair_required: '이 브라우저는 아직 연결되지 않았습니다. PC 관리 화면에서 연결 링크를 만드세요.'
};
const kst = iso => {
  if (!iso) return '-';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
};
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
};
function notice(text) { $('notice').textContent = text ?? ''; }

async function request(endpoint, value) {
  const headers = {};
  if (value !== undefined) { headers['content-type'] = 'application/json'; if (csrf) headers['x-aicc-csrf'] = csrf; }
  let response;
  try {
    response = await fetch('/api/mobile/' + endpoint, { method: value === undefined ? 'GET' : 'POST', headers, credentials: 'same-origin', cache: 'no-store', ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  } catch {
    throw Error(value === undefined ? '조회 연결이 끊겼습니다. 잠시 뒤 다시 조회하세요.' : '응답 연결이 끊겼습니다. 요청을 다시 보내지 말고 상태를 새로 조회해 결과를 확인하세요.');
  }
  let data; try { data = await response.json(); } catch { throw Error('응답을 읽지 못했습니다. 변경 요청은 자동으로 반복하지 않습니다.'); }
  if (!response.ok || data.ok === false) {
    const error = Error(errors[data.code] ?? data.error ?? ('처리할 수 없습니다 · ' + (data.code ?? '결과 미확인')));
    error.code = data.code; error.status = response.status; error.result = data; throw error;
  }
  return data;
}

async function connect() {
  let value;
  try { value = await request('session'); }
  catch (error) {
    const loopback = location.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
    if (error.code !== 'pair_required' || !loopback) throw error;
    value = await request('local-session', {});
  }
  session = value; csrf = value.csrf;
  $('connection').textContent = value.local ? 'PC 로컬 연결 · 모든 시각은 한국 시간(KST)' : '이 브라우저 연결 · 읽기와 그룹 종료·탭 닫기만 가능 · KST';
  $('addFields').disabled = !value.local; $('newFields').disabled = !value.local;
  if (!value.local) $('addHelp').textContent = '그룹 추가와 새 실행은 PC 로컬 연결에서만 할 수 있습니다.';
  document.body.classList.remove('connecting');
}

function setBusy(button, on, label) {
  busy = on;
  if (button) {
    if (on) { button.dataset.label = button.textContent; button.textContent = label ?? '처리 중…'; button.setAttribute('aria-busy', 'true'); }
    else if (button.dataset.label) { button.textContent = button.dataset.label; button.removeAttribute('aria-busy'); }
    button.disabled = on;
  }
}

async function refresh() {
  const button = $('refresh');
  setBusy(button, true, '조회 중…'); $('runs').setAttribute('aria-busy', 'true');
  try {
    status = await request('supervise');
    renderRuns(); notice('');
  } catch (error) { notice(error.message); }
  finally { setBusy(button, false); $('runs').setAttribute('aria-busy', 'false'); button.disabled = false; }
}

function currentRun() { return status?.runs.find(run => run.opsDirectory === selectedRun) ?? null; }

function renderRuns() {
  const select = $('runSelect'); select.replaceChildren();
  if (!status.runs.length) {
    select.append(el('option', { textContent: '실행 없음' })); select.disabled = true;
    $('runSummary').textContent = '등록 위치에 관제 실행이 없습니다. 아래 "새 실행"에서 만들 수 있습니다.';
    $('groups').replaceChildren(); return;
  }
  for (const run of status.runs) select.append(el('option', { value: run.opsDirectory, textContent: run.runName + (run.error ? ' (읽기 실패)' : '') }));
  if (!status.runs.some(run => run.opsDirectory === selectedRun)) selectedRun = status.runs[0].opsDirectory;
  select.value = selectedRun; select.disabled = status.runs.length < 2;
  renderRun();
}

function renderRun() {
  const run = currentRun(); const box = $('groups');
  if (!run) return;
  if (run.error) { $('runSummary').textContent = '정본을 읽지 못했습니다: ' + run.error.message; box.replaceChildren(); return; }
  $('runSummary').replaceChildren(
    el('span', {}, '기한 ', el('strong', { textContent: kst(run.deadline) }), run.deadlinePassed ? ' (지남)' : ''),
    el('span', {}, '마지막 깨우기 ', el('strong', { textContent: kst(run.lastWakeAt) })),
    el('span', {}, '진행 ', el('strong', { textContent: String(run.groups.length) }), ' · 종료 ', el('strong', { textContent: String(run.endedGroups.length) })),
    el('span', { className: 'muted', textContent: '조회 ' + kst(status.generatedAt) })
  );
  const all = [...(run.s0 ? [{ ...run.s0, isS0: true }] : []), ...run.groups, ...run.endedGroups];
  box.replaceChildren(...all.map(group => groupCard(run, group)));
  const target = $('logTarget'); const keep = target.value; target.replaceChildren(el('option', { value: '', textContent: '깨우기·S0' }));
  for (const group of [...run.groups, ...run.endedGroups]) if (group.progressFile) target.append(el('option', { value: group.name, textContent: group.name + ' PROGRESS' }));
  target.value = [...target.options].some(option => option.value === keep) ? keep : '';
  target.disabled = false; $('readLogs').disabled = false;
}

function groupCard(run, group) {
  const ended = group.state === 'ended';
  const card = el('article', { className: 'card group-card', tabIndex: 0 });
  card.setAttribute('aria-selected', String(selectedGroup === group.name));
  card.setAttribute('aria-label', `${group.name} ${group.stateLabel}`);
  card.addEventListener('focus', () => { selectedGroup = group.name; for (const node of document.querySelectorAll('.group-card')) node.setAttribute('aria-selected', String(node === card)); });
  const head = el('div', { className: 'group-head' }, el('h3', { textContent: group.isS0 ? 'S0 상위 관제' : group.name }), el('span', { className: 'chip ' + group.state, textContent: group.stateLabel }));
  const facts = el('dl', { className: 'facts' },
    el('dt', { textContent: '실행기' }), el('dd', { textContent: `${group.runner}${group.agent ? ' · ' + group.agent : ''}${group.elevated ? ' · 관리자 탭' : ''}` }),
    el('dt', { textContent: '마지막 PROGRESS' }), el('dd', { textContent: kst(group.lastProgressAt) }),
    el('dt', { textContent: '마지막 차례 끝' }), el('dd', { textContent: kst(group.lastTurnEndAt) }),
    ended ? el('dt', { textContent: '종료' }) : null, ended ? el('dd', { textContent: kst(group.endedAt) + (group.reason ? ' · ' + group.reason : '') }) : null
  );
  const actions = el('div', { className: 'actions' });
  const reasons = [];
  const log = el('button', { type: 'button', textContent: '로그 보기', disabled: !group.progressFile && !group.isS0 });
  if (!group.progressFile && !group.isS0) reasons.push('PROGRESS 파일이 등록되지 않아 그룹 로그가 없습니다.');
  log.addEventListener('click', () => { $('logTarget').value = group.isS0 ? '' : group.name; readLogs(); $('logs').scrollIntoView({ block: 'start' }); });
  actions.append(log);
  if (!group.isS0) {
    const close = el('button', { type: 'button', textContent: '탭 닫기', className: 'danger' });
    const canClose = group.runner !== 'codex' && group.sessionId && group.state !== 'turn_active' && group.state !== 'stale' && group.tabOpen;
    close.disabled = !canClose;
    if (!group.sessionId) reasons.push('세션 ID가 없어 닫을 탭이 없습니다.');
    else if (group.state === 'turn_active' || group.state === 'stale') reasons.push('차례 진행 중에는 탭을 닫을 수 없습니다.');
    else if (!group.tabOpen) reasons.push('열린 탭이 없습니다.');
    close.addEventListener('click', () => previewChange('close-tab', { run: run.opsDirectory, name: group.name }, close));
    actions.append(close);
    if (group.runner === 'codex') {
      reasons.push('터미널 연결과 차례 진행은 별개입니다. Codex 종료는 기존 mux에서 합니다.');
      reasons.push('깨우기: ' + (group.wake?.state ?? '미등록') + (group.wake?.reason ? ' · ' + group.wake.reason : ' · 접수·차례 시작·완료를 별도로 확인하세요.'));
      const wake = el('button', { type: 'button', textContent: '결과 전달 · 한 번 깨우기', disabled: !session?.local || ended || !group.wake?.canWake });
      wake.addEventListener('click', () => previewChange('wake-group', { run: run.opsDirectory, name: group.name }, wake));
      actions.append(wake);
    }
    if (!ended) {
      const end = el('button', { type: 'button', textContent: '그룹 종료', className: 'danger' });
      end.addEventListener('click', () => previewChange('end-group', { run: run.opsDirectory, name: group.name, reason: '화면에서 종료', closeTab: Boolean(canClose) }, end));
      actions.append(end);
    }
  }
  card.append(head, facts, actions, ...reasons.map(text => el('p', { className: 'reason', textContent: text })));
  return card;
}

async function readLogs() {
  const run = currentRun(); if (!run) return;
  const button = $('readLogs'); setBusy(button, true, '읽는 중…'); $('logStatus').textContent = '기록을 읽고 있습니다…';
  try {
    const result = await request('supervise/logs?run=' + encodeURIComponent(run.opsDirectory) + '&lines=30');
    const target = $('logTarget').value;
    const block = (title, lines) => el('div', { className: 'log-block' }, el('h3', { textContent: title }), el('pre', { className: 'scroll-output', tabIndex: 0, textContent: lines.length ? lines.join('\n') : '(기록 없음)' }));
    if (target) {
      const group = result.groups.find(item => item.name === target);
      $('logBlocks').replaceChildren(block(`${target} PROGRESS · 수정 ${kst(group?.lastProgressAt)}`, group?.lines ?? []));
    } else $('logBlocks').replaceChildren(block('깨우기 기록 (wake-log)', result.wakeLog), block('S0 기록 (SUPERVISOR-LOG)', result.supervisorLog));
    $('logStatus').textContent = '읽은 시각 ' + kst(new Date().toISOString()) + ' · 끝 30줄';
  } catch (error) { $('logStatus').textContent = error.message; }
  finally { setBusy(button, false); }
}

async function previewChange(action, input, button) {
  if (busy) return;
  setBusy(button, true, '미리보는 중…');
  try {
    const result = await request('supervise/preview', { action, input });
    pending = result;
    $('confirmImpact').textContent = result.impact;
    $('confirmRollback').textContent = '되돌리기: ' + result.rollback;
    $('confirmExpiry').textContent = '이 확인은 한 번만 쓸 수 있고 ' + kst(result.expiresAt) + '까지 유효합니다.';
    $('confirmChange').disabled = false;
    $('confirmDialog').showModal();
  } catch (error) { notice(error.message); }
  finally { setBusy(button, false); }
}

async function confirmChange() {
  if (!pending) return;
  const token = pending.confirmationToken; pending = null;
  const button = $('confirmChange'); setBusy(button, true, '실행 중…');
  try {
    const result = await request('supervise/confirm', { confirmationToken: token });
    const follow = result.followUp ? ` · 이어서 ${result.followUp.step}: ${result.followUp.skipped ?? (result.followUp.command?.ok ? '요청됨' : '실패')}` : '';
    notice(result.delivery ? `전달 ${result.delivery.state} · 차례 ${result.delivery.turnId ?? '미확인'} · 작업 목표 완료는 별도 확인` : `목록 변경 확인 · ${result.action}${follow}`);
  } catch (error) {
    const rb = error.result?.rollback;
    notice(error.message + (rb?.attempted ? ` · 되돌리기 ${rb.restored ? '완료' : '불완전, 정본을 확인하세요'}` : ''));
  } finally {
    setBusy(button, false); button.disabled = true;
    $('confirmDialog').close(); await refresh();
  }
}

function groupInput() {
  const value = id => $(id).value.trim() || undefined;
  return { name: value('gName'), runner: $('gRunner').value, agent: value('gAgent'), sessionId: value('gSession'), workingDirectory: value('gCwd'), promptFile: value('gPrompt'), progressFile: value('gProgress'), wakeCallbackId: value('gCallback'), elevated: $('gElevated').checked };
}
function runInput() {
  let groups;
  try { groups = JSON.parse($('rGroups').value); } catch { throw Error('그룹 목록 JSON을 읽을 수 없습니다.'); }
  const local = $('rDeadline').value;
  return { runName: $('rName').value.trim(), deadline: local ? `${local.length === 16 ? local + ':00' : local}+09:00` : '', intervalMinutes: Number($('rInterval').value), launch: $('rLaunch').checked, groups };
}

$('gRunner').addEventListener('change', () => { const codex = $('gRunner').value === 'codex'; $('gElevated').disabled = codex; if (codex) $('gElevated').checked = false; });
$('runSelect').addEventListener('change', () => { selectedRun = $('runSelect').value; renderRun(); });
$('refresh').addEventListener('click', refresh);
$('readLogs').addEventListener('click', readLogs);
$('confirmChange').addEventListener('click', confirmChange);
$('confirmDialog').addEventListener('close', () => { pending = null; });
$('previewAdd').addEventListener('click', () => {
  const run = currentRun(); if (!run) { notice('먼저 실행을 고르세요.'); return; }
  previewChange('add-group', { run: run.opsDirectory, group: groupInput(), open: $('gOpen').checked }, $('previewAdd'));
});
$('planRun').addEventListener('click', async () => {
  const button = $('planRun'); setBusy(button, true, '확인 중…');
  try { const plan = await request('supervise/plan', runInput()); $('planOut').hidden = false; $('planOut').textContent = JSON.stringify({ ok: plan.ok, conflicts: plan.conflicts, wouldCreate: plan.wouldCreate, launch: plan.launch, canonicalState: plan.canonicalState }, null, 2); }
  catch (error) { notice(error.message); }
  finally { setBusy(button, false); }
});
$('previewRun').addEventListener('click', () => { try { previewChange('start', runInput(), $('previewRun')); } catch (error) { notice(error.message); } });

(async () => {
  try { await connect(); await refresh(); }
  catch (error) { $('connection').textContent = '연결 실패'; $('connection').classList.add('offline'); notice(error.message); document.body.classList.remove('connecting'); }
  setInterval(() => { if (!busy && !document.hidden && !$('confirmDialog').open) refresh(); }, 30_000);
})();
