import { addDays, clockLayout, durationMinutes, localDateKey, parseDateKey, routineMinutes, sampleRoutines, sampleSchedules, scheduleOnDate, timeOrder, validRoutine, validSchedule } from './data.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);
const ROUTINES = 'miru-routine.routines.v2';
const SCHEDULES = 'miru-dated-schedules.v1';
const INITIALIZED = 'miru-dated-schedules.initialized.v1';
const COMPLETIONS = 'miru-routine.completions.';
const COLORS = ['#0875d1', '#4ecbb3', '#9589ea', '#ff8a7a', '#f7c950', '#388fb8'];
const blocked = new Set();
let toastTimer;
let hideToastTimer;
let selectedDate = localDateKey(new Date());
let followToday = true;
let routines = loadRoutines();
let schedules = loadSchedules();
let completed = loadCompletions();
let filter = 'all';

function read(key, validate) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (!validate(value)) throw new TypeError('Invalid saved data');
    return value;
  } catch {
    blocked.add(key);
    return undefined;
  }
}

function write(key, value) {
  try {
    if (blocked.has(key)) throw new Error('Saved data could not be read');
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    toast('저장하지 못했어요. 기존 데이터와 입력을 유지했어요.');
    return false;
  }
}

function toast(message) {
  const node = $('toast');
  clearTimeout(toastTimer);
  clearTimeout(hideToastTimer);
  node.textContent = message;
  node.hidden = false;
  requestAnimationFrame(() => node.classList.add('is-visible'));
  toastTimer = setTimeout(() => {
    node.classList.remove('is-visible');
    hideToastTimer = setTimeout(() => { node.hidden = true; }, 180);
  }, 2600);
}

function today() { return selectedDate === localDateKey(new Date()); }

function itemList(value, validate) {
  return Array.isArray(value) && value.every(validate) && new Set(value.map(({ id }) => id)).size === value.length;
}

function loadRoutines() {
  const saved = read(ROUTINES, (value) => itemList(value, validRoutine));
  if (saved !== null) return timeOrder(saved ?? []);
  write(ROUTINES, sampleRoutines);
  return timeOrder(sampleRoutines);
}

function loadSchedules() {
  const saved = read(SCHEDULES, (value) => itemList(value, validSchedule));
  if (saved !== null) return saved ?? [];
  const initialized = read(INITIALIZED, (value) => typeof value === 'boolean');
  if (initialized !== null && initialized !== false) return [];
  const examples = sampleSchedules.map((item) => ({ ...item, date: selectedDate }));
  if (write(SCHEDULES, examples)) write(INITIALIZED, true);
  return examples;
}

function loadCompletions() {
  const saved = read(`${COMPLETIONS}${selectedDate}`, (value) =>
    Array.isArray(value) && value.every((id) => typeof id === 'string'));
  return new Set(saved ?? []);
}
function formatDate(value) { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'full' }).format(parseDateKey(value)); }
function shortDate(value) { return new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }).format(parseDateKey(value)); }
function nowMinutes() { const date = new Date(); return date.getHours() * 60 + date.getMinutes(); }
function nowText() { return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); }
function isActive(item) { const now = nowMinutes(); const start = routineMinutes(item.segmentStart || item.start); const end = routineMinutes(item.segmentEnd || item.end); return end > start ? now >= start && now < end : now >= start || now < end; }
function dayItems() {
  const repeats = routines.map((routine) => ({ ...routine, kind: 'routine', clockId: routine.id, segmentStart: routine.start, segmentEnd: routine.end }));
  const dated = schedules.map((schedule) => scheduleOnDate(schedule, selectedDate)).filter(Boolean).map((schedule) => ({ ...schedule, kind: 'schedule' }));
  return [...repeats, ...dated].sort((a, b) => routineMinutes(a.segmentStart) - routineMinutes(b.segmentStart) || a.kind.localeCompare(b.kind));
}
function visibleItems(items) { if (filter === 'routine') return items.filter((item) => item.kind === 'routine'); if (filter === 'schedule') return items.filter((item) => item.kind === 'schedule'); if (filter === 'done') return items.filter((item) => item.kind === 'routine' && completed.has(item.id)); return items; }
function renderHeader(items) {
  $('today').dateTime = selectedDate; $('today').textContent = formatDate(selectedDate); $('page-title').textContent = today() ? '오늘의 계획' : '하루 계획'; $('date-label').textContent = shortDate(selectedDate); $('date-hint').textContent = today() ? '오늘' : '선택한 날짜'; $('selected-date').value = selectedDate;
  const repeat = items.filter((item) => item.kind === 'routine'); const done = repeat.filter((item) => completed.has(item.id)).length;
  $('progress').max = Math.max(repeat.length, 1); $('progress').value = done; $('progress-count').textContent = `${done} / ${repeat.length}`;
  $('completion-help').textContent = today() ? '반복 루틴의 완료 상태는 오늘 날짜에만 기록돼요.' : '다른 날짜에서는 완료 상태를 바꾸지 않아요.';
  const active = today() ? items.find(isActive) : null; const next = items.find((item) => routineMinutes(item.segmentStart) > nowMinutes());
  const summary = active ? `지금은 ‘${active.title}’ 시간이에요.`
    : today() && next ? `${next.segmentStart} · 다음은 ‘${next.title}’이에요.`
    : items.length ? '원형이나 목록에서 이 날짜의 계획을 확인해 보세요.' : '이 날짜의 첫 계획을 만들어 보세요.';
  $('summary').textContent = blocked.size ? '저장된 일부 데이터를 읽지 못했어요. 기존 저장 내용은 유지했어요.' : summary;
}
function openItem(item) { if (item.kind === 'schedule') openScheduleDialog(schedules.find((schedule) => schedule.id === item.id)); else { filter = 'all'; render(); requestAnimationFrame(() => $('item-' + item.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })); } }
function renderClock(items) {
  const holder = $('clock-items');
  holder.replaceChildren();
  $('clock-caption').textContent = today() ? 'NOW' : 'DAY';
  $('clock-now').textContent = today() ? nowText() : selectedDate.slice(5).replace('-', '.');
  $('clock-subtext').textContent = today() ? '현재 시각' : '선택한 날짜';
  [0, 6, 12, 18].forEach((hour) => {
    const label = document.createElement('span');
    label.className = 'hour-label';
    label.dataset.hour = String(hour);
    label.textContent = String(hour).padStart(2, '0');
    holder.append(label);
  });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('clock-arcs');
  svg.setAttribute('viewBox', '0 0 360 360');
  const arcs = clockLayout(items);
  const tracks = Math.max(1, ...arcs.map((arc) => arc.track + 1));
  const spacing = Math.min(19, 72 / Math.max(1, tracks - 1));
  arcs.forEach(({ item, start, duration, track }, index) => {
    const path = document.createElementNS(SVG_NS, 'path');
    const radius = 145 - track * spacing;
    const point = (minute) => {
      const angle = (minute / 4 - 90) * Math.PI / 180;
      return [180 + radius * Math.cos(angle), 180 + radius * Math.sin(angle)];
    };
    const [x1, y1] = point(start);
    const [x2, y2] = point(start + duration);
    path.setAttribute('d', `M ${x1} ${y1} A ${radius} ${radius} 0 ${duration > 720 ? 1 : 0} 1 ${x2} ${y2}`);
    path.classList.add('clock-arc');
    path.classList.toggle('is-completed', item.kind === 'routine' && completed.has(item.id));
    path.classList.toggle('is-current', today() && isActive(item));
    path.classList.toggle('is-flexible', item.kind === 'schedule' && !item.fixed);
    path.style.setProperty('--arc-color', COLORS[index % COLORS.length]);
    path.style.setProperty('--arc-width', String(Math.min(13, spacing * 0.78)));
    path.setAttribute('role', 'button');
    path.setAttribute('tabindex', '0');
    path.setAttribute('aria-label', `${item.title}, ${item.kind === 'schedule' ? (item.fixed ? '고정 일정' : '유연 일정') : '루틴'}, ${item.segmentStart}부터 ${item.segmentEnd}까지`);
    path.addEventListener('click', () => openItem(item));
    path.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openItem(item);
      }
    });
    svg.append(path);
  });
  holder.append(svg);
}
function scheduleLabel(item) { return `${item.startsToday ? '' : '전날 '}${item.displayStart} – ${item.displayEnd}${item.endsToday ? '' : ' · 다음 날'}`; }
function createCard(item) {
  const row = document.createElement('li'); row.id = `item-${item.id}`; row.className = `routine-card${item.kind === 'schedule' ? ' schedule-card' : ''}${item.kind === 'routine' && completed.has(item.id) ? ' is-completed' : ''}${today() && isActive(item) ? ' is-current' : ''}`;
  if (item.kind === 'routine') { const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'check-button'; toggle.disabled = !today(); toggle.setAttribute('aria-pressed', String(completed.has(item.id))); toggle.textContent = completed.has(item.id) ? '✓' : ''; toggle.setAttribute('aria-label', `${item.title} 완료 상태 변경`); toggle.addEventListener('click', () => {
    if (!today()) return;
    const updated = new Set(completed);
    if (updated.has(item.id)) updated.delete(item.id); else updated.add(item.id);
    if (!write(`${COMPLETIONS}${selectedDate}`, [...updated])) return;
    completed = updated;
    render();
    toast(completed.has(item.id) ? '완료로 기록했어요.' : '완료 표시를 되돌렸어요.');
  }); row.append(toggle); } else { const tag = document.createElement('span'); tag.className = `type-tag ${item.fixed ? 'fixed' : 'flexible'}`; tag.textContent = item.fixed ? '고정' : '유연'; row.append(tag); }
  const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'routine-copy'; const time = document.createElement('div'); time.className = 'routine-time'; time.textContent = item.kind === 'schedule' ? scheduleLabel(item) : `${item.start} – ${item.end}`; const title = document.createElement('p'); title.className = 'routine-title'; title.textContent = item.title; const note = document.createElement('small'); note.className = 'routine-note'; note.textContent = item.kind === 'schedule' ? '날짜 일정' : (today() && isActive(item) ? '지금 진행 중' : completed.has(item.id) ? '오늘 완료' : `약 ${durationMinutes(item)}분`); copy.append(time, title, note); copy.addEventListener('click', () => openItem(item));
  const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'edit-button'; edit.textContent = '수정'; edit.addEventListener('click', () => item.kind === 'schedule' ? openScheduleDialog(schedules.find((schedule) => schedule.id === item.id)) : openRoutineDialog(routines.find((routine) => routine.id === item.id))); row.append(copy, edit); return row;
}
function renderList(items) { const shown = visibleItems(items); $('items').replaceChildren(...shown.map(createCard)); $('item-total').textContent = `${items.length}개 계획`; const empty = $('empty-state'); empty.hidden = shown.length > 0; $('empty-title').textContent = items.length ? '이 조건에 맞는 계획이 없어요' : '이 날짜의 계획이 비어 있어요'; $('empty-copy').textContent = items.length ? '다른 보기를 선택하거나 새 계획을 추가해 보세요.' : '반복 루틴이나 날짜 일정을 추가해 보세요.'; document.querySelectorAll('[data-filter]').forEach((button) => { const selected = button.dataset.filter === filter; button.classList.toggle('is-selected', selected); button.setAttribute('aria-pressed', String(selected)); }); }
function render() { routines = timeOrder(routines); const items = dayItems(); renderHeader(items); renderClock(items); renderList(items); }
function id(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }
function dialog(name) { return $(name + '-dialog'); }
function closeAll() { document.querySelectorAll('dialog[open]').forEach((node) => node.close()); }
function overnight(noteId, startId, endId, noun) { const start = $(startId).value; const end = $(endId).value; $(noteId).textContent = start && end && end < start ? `다음 날 ${end}에 끝나는 ${noun}이에요.` : ''; }
function openRoutineDialog(routine) { $('routine-dialog-title').textContent = routine ? '루틴 수정' : '루틴 추가'; $('routine-id').value = routine?.id || ''; $('routine-title').value = routine?.title || ''; $('routine-start').value = routine?.start || '07:00'; $('routine-end').value = routine?.end || '07:30'; $('routine-error').textContent = ''; $('delete-routine').hidden = !routine; overnight('routine-overnight-note', 'routine-start', 'routine-end', '루틴'); dialog('routine').showModal(); $('routine-title').focus(); }
function openScheduleDialog(schedule) { $('schedule-dialog-title').textContent = schedule ? '날짜 일정 수정' : '날짜 일정 추가'; $('schedule-id').value = schedule?.id || ''; $('schedule-title').value = schedule?.title || ''; $('schedule-date').value = schedule?.date || selectedDate; $('schedule-start').value = schedule?.start || '09:00'; $('schedule-end').value = schedule?.end || '09:30'; document.querySelector(`input[name="fixed"][value="${schedule?.fixed ?? false}"]`).checked = true; $('schedule-error').textContent = ''; $('delete-schedule').hidden = !schedule; overnight('schedule-overnight-note', 'schedule-start', 'schedule-end', '일정'); dialog('schedule').showModal(); $('schedule-title').focus(); }
function saveRoutine(event) {
  event.preventDefault();
  const routine = {
    id: $('routine-id').value || id('routine'),
    title: $('routine-title').value.trim(),
    start: $('routine-start').value,
    end: $('routine-end').value,
  };
  if (!validRoutine(routine)) {
    $('routine-error').textContent = '루틴 이름과 서로 다른 시작·종료 시각을 입력해 주세요.';
    return;
  }
  const isNew = !routines.some((item) => item.id === routine.id);
  const updated = [...routines.filter((item) => item.id !== routine.id), routine];
  if (!write(ROUTINES, updated)) return;
  routines = updated;
  closeAll();
  render();
  toast(isNew ? '루틴을 추가했어요.' : '루틴을 수정했어요.');
}
function saveSchedule(event) {
  event.preventDefault();
  const schedule = {
    id: $('schedule-id').value || id('schedule'),
    title: $('schedule-title').value.trim(),
    date: $('schedule-date').value,
    start: $('schedule-start').value,
    end: $('schedule-end').value,
    fixed: document.querySelector('input[name="fixed"]:checked').value === 'true',
  };
  if (!validSchedule(schedule)) {
    $('schedule-error').textContent = schedule.start === schedule.end
      ? '시작과 종료 시간을 다르게 정해 주세요.' : '일정 이름, 날짜와 시각을 확인해 주세요.';
    return;
  }
  const isNew = !schedules.some((item) => item.id === schedule.id);
  const updated = [...schedules.filter((item) => item.id !== schedule.id), schedule];
  if (!write(SCHEDULES, updated)) return;
  schedules = updated;
  if (!scheduleOnDate(schedule, selectedDate)) {
    selectedDate = schedule.date;
    followToday = today();
    completed = loadCompletions();
  }
  closeAll();
  render();
  toast(isNew ? '날짜 일정을 추가했어요.' : '날짜 일정을 수정했어요.');
}
function removeRoutine() {
  const target = routines.find((item) => item.id === $('routine-id').value);
  if (!target || !confirm(`‘${target.title}’ 루틴을 삭제할까요?`)) return;
  const updated = routines.filter((item) => item.id !== target.id);
  if (!write(ROUTINES, updated)) return;
  routines = updated;
  closeAll();
  render();
  toast('루틴을 삭제했어요.');
}
function removeSchedule() {
  const target = schedules.find((item) => item.id === $('schedule-id').value);
  if (!target || !confirm(`‘${target.title}’ 일정을 삭제할까요?`)) return;
  const updated = schedules.filter((item) => item.id !== target.id);
  if (!write(SCHEDULES, updated)) return;
  schedules = updated;
  closeAll();
  render();
  toast('날짜 일정을 삭제했어요.');
}
function changeDate(value) { try { selectedDate = localDateKey(parseDateKey(value)); followToday = today(); completed = loadCompletions(); filter = 'all'; render(); } catch { toast('날짜를 확인해 주세요.'); } }

$('add-routine').addEventListener('click', () => openRoutineDialog()); $('add-schedule').addEventListener('click', () => openScheduleDialog()); $('empty-add').addEventListener('click', () => openScheduleDialog());
$('routine-form').addEventListener('submit', saveRoutine); $('schedule-form').addEventListener('submit', saveSchedule); $('delete-routine').addEventListener('click', removeRoutine); $('delete-schedule').addEventListener('click', removeSchedule);
$('routine-start').addEventListener('input', () => overnight('routine-overnight-note', 'routine-start', 'routine-end', '루틴')); $('routine-end').addEventListener('input', () => overnight('routine-overnight-note', 'routine-start', 'routine-end', '루틴')); $('schedule-start').addEventListener('input', () => overnight('schedule-overnight-note', 'schedule-start', 'schedule-end', '일정')); $('schedule-end').addEventListener('input', () => overnight('schedule-overnight-note', 'schedule-start', 'schedule-end', '일정'));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => $(button.dataset.close).close())); document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { filter = button.dataset.filter || 'all'; renderList(dayItems()); }));
$('previous-day').addEventListener('click', () => changeDate(addDays(selectedDate, -1))); $('next-day').addEventListener('click', () => changeDate(addDays(selectedDate, 1))); $('date-picker').addEventListener('click', () => $('selected-date').showPicker?.() || $('selected-date').focus()); $('selected-date').addEventListener('change', (event) => changeDate(event.target.value)); $('jump-now').addEventListener('click', () => changeDate(localDateKey(new Date())));
function refreshDay() {
  if (followToday) selectedDate = localDateKey(new Date());
  completed = loadCompletions();
  render();
}
window.addEventListener('focus', refreshDay);
window.setInterval(refreshDay, 60000);
render();
