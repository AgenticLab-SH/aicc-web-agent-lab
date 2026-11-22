export const sampleRoutines = Object.freeze([
  { id: 'wake-demo', title: '기상 · 창문 열기', start: '06:20', end: '06:30' },
  { id: 'water-demo', title: '물 한 잔과 비타민 챙기기', start: '06:30', end: '06:40' },
  { id: 'stretch-demo', title: '가볍게 스트레칭', start: '06:40', end: '07:05' },
  { id: 'focus-demo', title: '오늘의 가장 중요한 일 시작하기', start: '09:00', end: '10:30' },
  { id: 'lunch-demo', title: '점심 식사와 휴식', start: '12:00', end: '12:50' },
  { id: 'walk-demo', title: '점심 후 10분 산책', start: '12:20', end: '12:35' },
  { id: 'review-demo', title: '오늘의 기록 정리', start: '21:20', end: '21:45' },
]);

export const sampleSchedules = Object.freeze([
  { id: 'schedule-demo-focus', title: '기획안 집중 검토 · 긴 이름도 자연스럽게 표시됩니다', date: '2026-11-22', start: '09:30', end: '11:10', fixed: true },
  { id: 'schedule-demo-lunch', title: '동료와 점심 약속', date: '2026-11-22', start: '12:20', end: '13:10', fixed: false },
  { id: 'schedule-demo-overnight', title: '내일 발표 자료 마무리', date: '2026-11-22', start: '23:30', end: '00:15', fixed: true },
]);

export function localDateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function parseDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('날짜 형식을 확인해 주세요.');
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime()) || localDateKey(date) !== value) throw new RangeError('날짜를 확인해 주세요.');
  return date;
}

export function addDays(dateKey, amount) {
  const date = parseDateKey(dateKey);
  date.setDate(date.getDate() + amount);
  return localDateKey(date);
}

export function routineMinutes(time) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RangeError('시각은 HH:mm으로 입력하세요.');
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

export function isOvernight(item) {
  return routineMinutes(item.end) <= routineMinutes(item.start);
}

export function durationMinutes(item) {
  const start = routineMinutes(item.start);
  const end = routineMinutes(item.end);
  return end > start ? end - start : end + 1440 - start;
}

export function timeOrder(entries) {
  return [...entries].sort((a, b) => routineMinutes(a.start) - routineMinutes(b.start) || a.title.localeCompare(b.title, 'ko'));
}

export function scheduleOnDate(schedule, date) {
  const finalDate = isOvernight(schedule) ? addDays(schedule.date, 1) : schedule.date;
  if (date !== schedule.date && (date !== finalDate || schedule.end === '00:00')) return null;
  if (date === schedule.date) {
    return { ...schedule, clockId: `dated:${schedule.id}`, segmentStart: schedule.start, segmentEnd: isOvernight(schedule) ? '00:00' : schedule.end, displayStart: schedule.start, displayEnd: schedule.end, startsToday: true, endsToday: !isOvernight(schedule) };
  }
  return { ...schedule, clockId: `dated:${schedule.id}`, segmentStart: '00:00', segmentEnd: schedule.end, displayStart: schedule.start, displayEnd: schedule.end, startsToday: false, endsToday: true };
}

export function validRoutine(item) {
  if (!item || typeof item.id !== 'string' || typeof item.title !== 'string') return false;
  try { routineMinutes(item.start); routineMinutes(item.end); return item.title.trim().length > 0 && item.start !== item.end; } catch { return false; }
}

export function validSchedule(item) {
  if (!item || typeof item.id !== 'string' || typeof item.title !== 'string' || typeof item.fixed !== 'boolean') return false;
  try { parseDateKey(item.date); return validRoutine(item); } catch { return false; }
}

export function clockLayout(items) {
  const tracks = [];
  return items.map((item) => {
    const start = routineMinutes(item.segmentStart);
    const duration = durationMinutes({ start: item.segmentStart, end: item.segmentEnd });
    const finish = start + duration;
    const occupied = [[start, Math.min(finish, 1440)]];
    if (finish > 1440) occupied.push([0, finish - 1440]);
    let track = tracks.findIndex((reserved) => occupied.every(([from, to]) =>
      reserved.every(([otherFrom, otherTo]) => from >= otherTo || otherFrom >= to)));
    if (track === -1) track = tracks.push([]) - 1;
    tracks[track].push(...occupied);
    return { item, start, duration, track };
  });
}
