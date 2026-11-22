export const sampleRoutines = Object.freeze([
  { id: 'wake-demo', title: '기상 · 창문 열기', start: '06:20', end: '06:30' },
  { id: 'water-demo', title: '물 한 잔과 비타민 챙기기', start: '06:30', end: '06:40' },
  { id: 'stretch-demo', title: '가볍게 스트레칭', start: '06:40', end: '07:05' },
  { id: 'read-demo', title: '책 읽기 · 오늘의 한 문장 기록', start: '07:00', end: '07:35' },
  { id: 'breakfast-demo', title: '건강한 아침 식사', start: '07:35', end: '08:05' },
  { id: 'focus-demo', title: '오늘의 가장 중요한 일 시작하기', start: '09:00', end: '10:30' },
  { id: 'lunch-demo', title: '점심 식사와 휴식', start: '12:00', end: '12:50' },
  { id: 'walk-demo', title: '점심 후 10분 산책', start: '12:20', end: '12:35' },
  { id: 'reset-demo', title: '오후 집중 리셋 · 물 마시기', start: '15:00', end: '15:20' },
  { id: 'review-demo', title: '오늘의 기록 정리', start: '21:20', end: '21:45' },
  { id: 'sleep-demo', title: '내일을 위한 편안한 수면 준비', start: '23:30', end: '00:15' },
]);
export function localDateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}
export function routineMinutes(time) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RangeError('시각은 HH:mm으로 입력하세요.');
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}
export function durationMinutes(routine) {
  const start = routineMinutes(routine.start);
  const end = routineMinutes(routine.end);
  return end > start ? end - start : end + 1440 - start;
}
export function timeOrder(entries) {
  return [...entries].sort((a, b) => routineMinutes(a.start) - routineMinutes(b.start));
}
export function isOvernight(routine) {
  return routineMinutes(routine.end) <= routineMinutes(routine.start);
}
