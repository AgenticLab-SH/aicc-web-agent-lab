import { durationMinutes, isOvernight, localDateKey, routineMinutes, sampleRoutines, timeOrder } from './data.mjs';
const get = (id) => document.getElementById(id);
const routinesKey = ['miru-routine', 'routines', 'v2'].join('.');
const completionPrefix = 'miru-routine.completions.';
const colors = ['#0875d1', '#4ecbb3', '#9589ea', '#ff8a7a', '#f7c950', '#388fb8'];
let today = new Date();
let routines = loadRoutines();
let completed = loadCompletions();
let tickId = null;
function safeRead(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch {
    return fallback;
  }
}
function dateKey() {
  return localDateKey(today);
}
function loadRoutines() {
  const saved = safeRead(routinesKey, null);
  const usable = Array.isArray(saved) ? saved.filter(validRoutine) : [];
  if (usable.length === 0) {
    const initial = timeOrder(sampleRoutines);
    try { localStorage.setItem(routinesKey, JSON.stringify(initial)); } catch { /* 저장 불가 시 화면 데이터만 사용 */ }
    return initial;
  }
  return timeOrder(usable);
}
function loadCompletions() {
  const saved = safeRead(`${completionPrefix}${dateKey()}`, []);
  return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : []);
}
function validRoutine(item) {
  if (!item || typeof item.id !== 'string' || typeof item.title !== 'string') return false;
  try {
    routineMinutes(item.start);
    routineMinutes(item.end);
    return item.title.trim().length > 0 && item.start !== item.end;
  } catch {
    return false;
  }
}
function persistRoutines() {
  try {
    localStorage.setItem(routinesKey, JSON.stringify(routines));
    return true;
  } catch {
    showNotice('이 브라우저에서는 루틴을 저장할 수 없어요.');
    return false;
  }
}
function persistCompletions() {
  try {
    localStorage.setItem(`${completionPrefix}${dateKey()}`, JSON.stringify([...completed]));
  } catch {
    showNotice('이 브라우저에서는 완료 상태를 저장할 수 없어요.');
  }
}
function showNotice(message) {
  get('summary').textContent = message;
}
function formatDate(date) {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'full' }).format(date);
}
function formatTime(date) {
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
function nowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}
function currentRoutine() {
  const current = nowMinutes();
  return routines.find((routine) => {
    const start = routineMinutes(routine.start);
    const end = routineMinutes(routine.end);
    return end > start ? current >= start && current < end : current >= start || current < end;
  });
}
function nextRoutine() {
  const current = nowMinutes();
  return routines.find((routine) => routineMinutes(routine.start) > current) || routines[0];
}
function renderHeader() {
  get('today').dateTime = dateKey();
  get('today').textContent = formatDate(today);
}
function renderProgress() {
  const count = routines.filter(({ id }) => completed.has(id)).length;
  const active = currentRoutine();
  const next = nextRoutine();
  get('progress').max = Math.max(routines.length, 1);
  get('progress').value = count;
  get('progress-count').textContent = `${count} / ${routines.length}`;
  get('routine-total').textContent = routines.length ? `${routines.length}개 루틴` : '';
  if (!routines.length) {
    get('summary').textContent = '오늘의 첫 루틴을 만들어 보세요.';
  } else if (active) {
    get('summary').textContent = `지금은 ‘${active.title}’ 시간이에요.`;
  } else if (next) {
    get('summary').textContent = `다음은 ${next.start}, ‘${next.title}’이에요.`;
  }
}
function renderClock() {
  const items = get('clock-items');
  items.replaceChildren();
  get('clock-now').textContent = formatTime(new Date());
  [0, 6, 12, 18].forEach((hour) => {
    const label = document.createElement('span');
    label.className = 'hour-label';
    label.style.setProperty('--angle', `${hour * 15 - 90}deg`);
    label.textContent = String(hour).padStart(2, '0');
    items.append(label);
  });
  const activeId = currentRoutine()?.id;
  routines.forEach((routine, index) => {
    const start = routineMinutes(routine.start);
    const duration = durationMinutes(routine);
    const button = document.createElement('button');
    const segment = document.createElement('span');
    button.type = 'button';
    button.className = `clock-item${completed.has(routine.id) ? ' is-completed' : ''}${routine.id === activeId ? ' is-current' : ''}`;
    button.style.setProperty('--start-angle', `${start / 4 - 90}deg`);
    button.setAttribute('aria-label', `${routine.title}, ${routine.start}부터 ${routine.end}까지${completed.has(routine.id) ? ', 완료됨' : ''}`);
    segment.className = 'clock-segment';
    segment.style.setProperty('--length', `${Math.max(13, duration / 4)}px`);
    segment.style.setProperty('--radius', `${64 + (index % 3) * 19}px`);
    segment.style.setProperty('--segment-color', colors[index % colors.length]);
    button.append(segment);
    button.addEventListener('click', () => document.getElementById(`routine-${routine.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    items.append(button);
  });
}
function createRoutineCard(routine) {
  const item = document.createElement('li');
  const active = currentRoutine()?.id === routine.id;
  item.id = `routine-${routine.id}`;
  item.className = `routine-card${completed.has(routine.id) ? ' is-completed' : ''}${active ? ' is-current' : ''}`;
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'check-button';
  check.setAttribute('aria-pressed', String(completed.has(routine.id)));
  check.setAttribute('aria-label', `${routine.title} ${completed.has(routine.id) ? '완료 취소' : '완료'}`);
  check.textContent = completed.has(routine.id) ? '✓' : '';
  check.addEventListener('click', () => toggleCompletion(routine.id));
  const copy = document.createElement('div');
  copy.className = 'routine-copy';
  const time = document.createElement('div');
  time.className = 'routine-time';
  time.textContent = `${routine.start} – ${routine.end}`;
  if (isOvernight(routine)) {
    const badge = document.createElement('span');
    badge.className = 'overnight';
    badge.textContent = '다음 날';
    time.append(badge);
  }
  const title = document.createElement('p');
  title.className = 'routine-title';
  title.textContent = routine.title;
  copy.append(time, title);
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'edit-button';
  edit.textContent = '⋯';
  edit.setAttribute('aria-label', `${routine.title} 수정`);
  edit.addEventListener('click', () => openDialog(routine));
  item.append(check, copy, edit);
  return item;
}
function renderList() {
  const list = get('routines');
  list.replaceChildren(...routines.map(createRoutineCard));
  get('empty-state').hidden = routines.length !== 0;
}
function render() {
  routines = timeOrder(routines);
  renderHeader();
  renderProgress();
  renderClock();
  renderList();
}
function toggleCompletion(id) {
  if (completed.has(id)) completed.delete(id);
  else completed.add(id);
  persistCompletions();
  render();
}
function makeId() {
  return `routine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
function openDialog(routine = null) {
  const dialog = get('routine-dialog');
  const editing = Boolean(routine);
  get('dialog-title').textContent = editing ? '루틴 수정' : '루틴 추가';
  get('routine-id').value = routine?.id || '';
  get('routine-title').value = routine?.title || '';
  get('routine-start').value = routine?.start || '07:00';
  get('routine-end').value = routine?.end || '07:30';
  get('delete-routine').hidden = !editing;
  get('form-error').textContent = '';
  dialog.showModal();
  get('routine-title').focus();
}
function closeDialog() {
  get('routine-dialog').close();
}
function saveRoutine(event) {
  event.preventDefault();
  const id = get('routine-id').value || makeId();
  const title = get('routine-title').value.trim();
  const start = get('routine-start').value;
  const end = get('routine-end').value;
  const error = get('form-error');
  if (!title) {
    error.textContent = '루틴 이름을 입력해 주세요.';
    return;
  }
  try {
    routineMinutes(start);
    routineMinutes(end);
  } catch {
    error.textContent = '시작과 종료 시간을 확인해 주세요.';
    return;
  }
  if (start === end) {
    error.textContent = '시작과 종료 시간은 서로 달라야 해요.';
    return;
  }
  const routine = { id, title, start, end };
  const position = routines.findIndex((item) => item.id === id);
  if (position >= 0) routines[position] = routine;
  else routines.push(routine);
  persistRoutines();
  closeDialog();
  render();
}
function deleteRoutine() {
  const id = get('routine-id').value;
  if (!id) return;
  const target = routines.find((routine) => routine.id === id);
  if (!target || !window.confirm(`‘${target.title}’ 루틴을 삭제할까요?`)) return;
  routines = routines.filter((routine) => routine.id !== id);
  completed.delete(id);
  persistRoutines();
  persistCompletions();
  closeDialog();
  render();
}
function jumpToNow() {
  const active = currentRoutine();
  if (active) document.getElementById(`routine-${active.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  else get('clock-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function refreshForDateChange() {
  const actualToday = new Date();
  if (dateKey() !== localDateKey(actualToday)) {
    today = actualToday;
    completed = loadCompletions();
  }
  render();
}
get('add-routine').addEventListener('click', () => openDialog());
get('empty-add').addEventListener('click', () => openDialog());
get('close-dialog').addEventListener('click', closeDialog);
get('cancel-dialog').addEventListener('click', closeDialog);
get('routine-form').addEventListener('submit', saveRoutine);
get('delete-routine').addEventListener('click', deleteRoutine);
get('jump-now').addEventListener('click', jumpToNow);
window.addEventListener('focus', refreshForDateChange);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshForDateChange(); });
render();
tickId = window.setInterval(refreshForDateChange, 60000);
window.addEventListener('beforeunload', () => window.clearInterval(tickId));
