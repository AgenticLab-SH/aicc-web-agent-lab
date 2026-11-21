export const sampleRoutines = Object.freeze([
  { id: 'water-demo', title: '물 한 잔', start: '06:30', end: '06:40' },
  { id: 'stretch-demo', title: '가볍게 스트레칭', start: '06:40', end: '07:00' },
  { id: 'read-demo', title: '책 읽기', start: '07:05', end: '07:35' },
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

export function timeOrder(entries) {
  return [...entries].sort((a, b) => routineMinutes(a.start) - routineMinutes(b.start));
}
