import test from 'node:test';
import assert from 'node:assert/strict';
import { apps, filterApps, states } from './aicc-mobile/data.mjs';
import { localDateKey, routineMinutes, sampleRoutines, timeOrder } from './miru-routine/data.mjs';

test('app fixtures have unique IDs and cover every supported state', () => {
  assert.equal(new Set(apps.map(({ id }) => id)).size, apps.length);
  assert.deepEqual(new Set(apps.map(({ state }) => state)), new Set(Object.keys(states)));
});

test('app filters combine query and state', () => {
  assert.deepEqual(filterApps(apps, '  읽기 ', 'INSTALLABLE').map(({ id }) => id), ['reader-demo']);
  assert.deepEqual(filterApps(apps, '읽기', 'WEB'), []);
});

test('routine times sort correctly and use the local day', () => {
  assert.equal(localDateKey(new Date(2026, 0, 2, 0, 1)), '2026-01-02');
  assert.equal(routineMinutes('23:59'), 1439);
  assert.throws(() => routineMinutes('24:00'), RangeError);
  assert.deepEqual(timeOrder([...sampleRoutines].reverse()), sampleRoutines);
});
