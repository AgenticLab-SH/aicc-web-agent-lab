
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, clockLayout, durationMinutes, scheduleOnDate, validSchedule } from './data.mjs';

const date = '2026-11-22';
const schedule = { id: 'demo-night', title: '자정 경계 예시', date, start: '23:30', end: '00:15', fixed: true };

test('두 날짜의 원형과 목록에 같은 일정 식별자를 사용한다', () => {
  const first = scheduleOnDate(schedule, date);
  const second = scheduleOnDate(schedule, addDays(date, 1));
  assert.equal(first.clockId, second.clockId);
  assert.equal(first.id, schedule.id);
  assert.equal(first.segmentStart, '23:30');
  assert.equal(first.segmentEnd, '00:00');
  assert.equal(second.segmentStart, '00:00');
  assert.equal(second.segmentEnd, '00:15');
  assert.equal(durationMinutes({ start: first.segmentStart, end: first.segmentEnd }), 30);
  assert.equal(durationMinutes({ start: second.segmentStart, end: second.segmentEnd }), 15);
});

test('정확히 자정에 끝나는 일정은 다음 날에 나타나지 않는다', () => {
  assert.equal(scheduleOnDate({ ...schedule, end: '00:00' }, addDays(date, 1)), null);
});

test('시간이 겹치는 4개 항목과 자정 넘김은 다른 원 궤도에 배치한다', () => {
  const entries = [
    { segmentStart: '00:00', segmentEnd: '00:15' },
    { segmentStart: '23:30', segmentEnd: '00:15' },
    { segmentStart: '00:05', segmentEnd: '00:10' },
    { segmentStart: '00:04', segmentEnd: '00:08' },
    { segmentStart: '00:15', segmentEnd: '00:30' },
  ];
  assert.deepEqual(clockLayout(entries).map(({ track }) => track), [0, 1, 2, 3, 0]);
});

test('동일 시각·잘못된 날짜·알 수 없는 고정/유연 값은 거부한다', () => {
  assert.equal(validSchedule(schedule), true);
  assert.equal(validSchedule({ ...schedule, end: schedule.start }), false);
  assert.equal(validSchedule({ ...schedule, date: '2026-02-30' }), false);
  assert.equal(validSchedule({ ...schedule, fixed: 'true' }), false);
});
