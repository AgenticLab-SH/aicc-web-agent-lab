import { localDateKey, sampleRoutines, timeOrder } from './data.mjs';

const get = (id) => document.getElementById(id);
const now = new Date();
const dateKey = localDateKey(now);
const storageKey = `miru-demo.completions.${dateKey}`;
const routines = timeOrder(sampleRoutines);
let completed = new Set();
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
  if (Array.isArray(saved)) completed = new Set(saved);
} catch {
  // The preview can still be used if storage is unavailable.
}

get('today').dateTime = dateKey;
get('today').textContent = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'full' }).format(now);

function renderProgress() {
  const count = routines.filter(({ id }) => completed.has(id)).length;
  get('progress').max = routines.length || 1;
  get('progress').value = count;
  get('summary').textContent = `${count} / ${routines.length} 완료`;
}

for (const routine of routines) {
  const item = document.createElement('li');
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  const copy = document.createElement('span');
  const time = document.createElement('time');
  checkbox.type = 'checkbox';
  checkbox.checked = completed.has(routine.id);
  time.dateTime = routine.start;
  time.textContent = `${routine.start}–${routine.end}`;
  copy.append(time, routine.title);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) completed.add(routine.id);
    else completed.delete(routine.id);
    renderProgress();
    try {
      localStorage.setItem(storageKey, JSON.stringify([...completed]));
    } catch {
      get('summary').textContent += ' · 이 브라우저에서는 저장할 수 없습니다.';
    }
  });
  label.append(checkbox, copy);
  item.append(label);
  get('routines').append(item);
}

renderProgress();
