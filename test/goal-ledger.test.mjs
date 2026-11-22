import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGoalLedgerService } from '../src/goals/service.mjs';
import { UserActionLedger } from '../src/goals/user-action-ledger.mjs';
import { createServer } from '../src/server.mjs';
import { ControlReportStore } from '../src/control-plane/report-store.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-goals-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const masterGoalsPath = path.join(root, 'control-plane', 'master-goals.json');
  const statePath = path.join(root, 'dashboard', 'goal-ledger-state.json');
  const eventsPath = path.join(root, 'dashboard', 'goal-ledger-events.jsonl');
  const reportsPath = path.join(root, 'control-plane', 'reports-v1', 'snapshot.json');
  const sessionsPath = path.join(root, 'control-plane', 'session-registry.json');
  const userActionsPath = path.join(root, 'control-plane', 'user-actions.json');
  const userActionEventsPath = path.join(root, 'control-plane', 'user-action-events.jsonl');
  fs.mkdirSync(path.dirname(masterGoalsPath), { recursive: true });
  fs.writeFileSync(masterGoalsPath, JSON.stringify({
    generatedAt: '2026-08-31T00:00:00.000Z',
    statusDefinitions: { ACTIVE: '진행 중', COMPLETE: '완료' },
    userHelp: [{ id: 'H01', title: '정보 알려주기', ask: '프로젝트에서 맡은 일을 알려주세요.', why: '확인된 사실만 쓰기 위해 필요합니다.', steps: ['작업 이름을 적습니다.', '내가 맡은 일을 적습니다.'], readyNow: true }],
    notionSync: { stateLabel: '연결 준비', remoteRows: 15 },
    goals: [
      { id: 'G01', title: '중앙 관제', status: 'ACTIVE', progress: { records: 7 }, next: '계속 기록' },
      { id: 'G02', title: '이전 완료', status: 'COMPLETE', progress: { verified: true }, next: '정본 유지' }
    ]
  }));
  fs.mkdirSync(path.dirname(reportsPath), { recursive: true });
  fs.writeFileSync(reportsPath, JSON.stringify({ schemaVersion: 1, sequence: 3, digest: 'a'.repeat(64), updatedAt: '2026-08-31T02:00:00.000Z', counts: { PROGRESS: 1 }, attention: [], workers: { 'session-02': { status: 'PROGRESS', summary: '남은 일을 자동으로 처리하고 있습니다.', nextGate: null, updatedAt: '2026-08-31T02:00:00.000Z', revision: 'r1' } } }));
  fs.writeFileSync(sessionsPath, JSON.stringify({ schemaVersion: 1, sessions: [
    { number: '02', title: '잔여 작업 통합', state: 'IDLE', reportWorkerIds: ['session-02'], work: '남은 일을 모읍니다.', objective: '이전 뒤 남은 일을 마감합니다.', progress: '두 건을 마쳤습니다.', remaining: '안전한 다음 검사를 진행합니다.', decision: 'CONTINUE' },
    { number: '10', title: 'OCX 복구·검증', state: 'ARCHIVED', progress: '복구 계약을 검증했습니다.', remaining: '승인 전에는 복원하지 않습니다.', decision: 'ARCHIVE' },
    { number: '11', title: '야간 통합 관제', state: 'ACTIVE', progress: '정본을 주기적으로 확인합니다.', remaining: '최종 감사를 남깁니다.', decision: 'KEEP' }
  ] }));
  return { root, masterGoalsPath, statePath, eventsPath, reportsPath, sessionsPath, userActionsPath, userActionEventsPath };
}

test('goal ledger keeps personal checks separate and appends every change', t => {
  const paths = fixture(t);
  const service = createGoalLedgerService({ ...paths, now: () => '2026-08-31T03:00:00.000Z' });
  const initial = service.status();
  assert.equal(initial.summary.goalCount, 2);
  assert.equal(initial.summary.checkedCount, 0);
  assert.equal(initial.goals[0].status, 'ACTIVE');
  assert.equal(initial.coordination.userHelp[0].readyNow, true);
  assert.equal(initial.coordination.userActions.activeCount, 0);
  assert.equal(initial.coordination.sessions[0].state, 'PROGRESS');
  assert.equal(initial.coordination.sessions[0].latestSummary, '남은 일을 자동으로 처리하고 있습니다.');
  assert.equal(initial.coordination.sessions[0].objective, '이전 뒤 남은 일을 마감합니다.');
  assert.equal(initial.coordination.sessions[0].progress, '두 건을 마쳤습니다.');
  assert.equal(initial.coordination.sessions[0].remaining, '안전한 다음 검사를 진행합니다.');
  assert.equal(initial.coordination.sessions[0].decision, 'CONTINUE');
  assert.deepEqual(initial.coordination.sessions.map(session => session.number), ['02', '10', '11']);
  assert.equal(initial.coordination.sessions[2].title, '야간 통합 관제');
  assert.equal(initial.coordination.notionSync.remoteRows, 15);

  const checked = service.setChecked({ goalId: 'G01', checked: true });
  assert.equal(checked.goals[0].checked, true);
  assert.equal(checked.goals[0].status, 'ACTIVE', 'personal check must not mutate operational status');
  assert.equal(checked.historyCount, 1);

  const unchecked = service.setChecked({ goalId: 'G01', checked: false });
  assert.equal(unchecked.goals[0].checked, false);
  assert.equal(unchecked.historyCount, 2);
  assert.equal(fs.readFileSync(paths.eventsPath, 'utf8').trim().split(/\r?\n/).length, 2);
});

test('goal coordination preserves the existing producer short fields without changing goal authority', t => {
  const paths = fixture(t);
  const before = fs.readFileSync(paths.masterGoalsPath, 'utf8');
  const producerRoot = path.join(paths.root, 'producer');
  const service = createGoalLedgerService({ ...paths, reportsPath: path.join(producerRoot, 'snapshot.json') });
  const producer = new ControlReportStore({ root: producerRoot });
  const details = { completed: ['설명 연결'], remaining: ['실기기 확인'], choices: [], nextAction: '다음 독립 구현' };
  producer.write({ schemaVersion: 1, controlPlaneId: 'integrated-work-control', workerId: 'session-02', workerSequence: 1, status: 'DONE', revision: 'r2', summary: '짧은 보고', ...details });
  const view = service.status(), report = view.coordination.sessions[0].latestReport;
  for (const [key, value] of Object.entries(details)) assert.deepEqual(report[key], value);
  assert.equal(view.coordination.sessions[0].next, details.nextAction);
  assert.equal(view.goals[0].status, 'ACTIVE'); assert.equal(view.nativeCodexGoal.mutated, false);
  assert.equal(fs.readFileSync(paths.masterGoalsPath, 'utf8'), before);
});

test('goal ledger fails closed for unknown goals and invalid master status', t => {
  const paths = fixture(t);
  const service = createGoalLedgerService(paths);
  assert.throws(() => service.setChecked({ goalId: 'G99', checked: true }), error => error.code === 'unknown_goal');
  const invalid = JSON.parse(fs.readFileSync(paths.masterGoalsPath, 'utf8'));
  invalid.goals[0].status = 'MAYBE';
  fs.writeFileSync(paths.masterGoalsPath, JSON.stringify(invalid));
  assert.throws(() => service.status(), error => error.code === 'invalid_goal_ledger');
});

test('goal metadata edits preserve owner fields, operational states and checks with restart-safe receipts', t => {
  const paths = fixture(t), service = createGoalLedgerService(paths);
  const original = JSON.parse(fs.readFileSync(paths.masterGoalsPath, 'utf8'));
  service.setChecked({ goalId: 'G01', checked: true });
  const input = { action: 'goal-save', goalId: 'G01', title: '목표 설명 편집', description: '첫 줄 한글\nSecond line', dependsOn: ['G02'], expectedSourceRevision: service.status().sourceRevision };
  assert.match(service.prepareEdit(input).summary.join('\n'), /이전 완료/);
  const result = service.commitEdit(input, '01234567-89ab-4cde-8012-3456789abcde');
  assert.equal(result.dispatched, false); assert.equal(result.nativeGoalMutated, false);
  const updated = JSON.parse(fs.readFileSync(paths.masterGoalsPath, 'utf8'));
  assert.deepEqual(updated.goals[0].progress, original.goals[0].progress);
  assert.equal(updated.goals[0].status, 'ACTIVE'); assert.equal(updated.goals[0].next, original.goals[0].next);
  assert.deepEqual(updated.userHelp, original.userHelp); assert.deepEqual(updated.notionSync, original.notionSync);
  assert.deepEqual(updated._aiccDashboardEdits.history[0].before, original.goals[0]);
  assert.equal(service.status().goals[0].checked, true);
  assert.equal(service.status().goals[0].description, input.description);
  assert.equal(createGoalLedgerService(paths).commitEdit(input, '01234567-89ab-4cde-8012-3456789abcde').duplicate, true);
  assert.throws(() => service.commitEdit({ ...input, title: '다른 편집' }, '01234567-89ab-4cde-8012-3456789abcde'), error => error.code === 'goal_operation_conflict');
  assert.equal(updated._aiccDashboardEdits.history.length, 1);
});

test('goal edits reject stale revisions, another writer, authority fields and dependency cycles without overwriting', t => {
  const paths = fixture(t), service = createGoalLedgerService(paths);
  const input = { action: 'goal-save', goalId: 'G01', title: '수정', expectedSourceRevision: service.status().sourceRevision };
  const old = JSON.parse(fs.readFileSync(paths.masterGoalsPath, 'utf8')); old.goals[0].next = '다른 작성자가 변경';
  fs.writeFileSync(paths.masterGoalsPath, JSON.stringify(old));
  assert.throws(() => service.commitEdit(input, crypto.randomUUID()), error => error.code === 'goal_revision_conflict');
  const fresh = { ...input, expectedSourceRevision: service.status().sourceRevision };
  for (const extra of [{ status: 'COMPLETE' }, { ownerThreadId: 'forbidden' }, { dependsOn: ['G01'] }, { dependsOn: ['missing'] }]) assert.throws(() => service.prepareEdit({ ...fresh, ...extra }));
  fs.writeFileSync(paths.masterGoalsPath + '.edit.lock', 'synthetic writer');
  assert.throws(() => service.commitEdit(fresh, crypto.randomUUID()), error => error.code === 'goal_writer_busy');
  assert.equal(fs.readFileSync(paths.masterGoalsPath, 'utf8'), JSON.stringify(old));
});

test('goal creation and reversible archive keep one canonical ledger and reject archived dependencies', t => {
  const paths = fixture(t), service = createGoalLedgerService(paths);
  const save = input => service.commitEdit({ ...input, expectedSourceRevision: service.status().sourceRevision }, crypto.randomUUID());
  const result = save({ action: 'goal-save', title: '추가 목표', dependsOn: ['G01'] });
  let current = service.status().goals.find(g => g.id === result.goalId); assert.equal(current.status, 'UNASSIGNED');
  assert.throws(() => service.prepareEdit({ action: 'goal-save', goalId: 'G01', dependsOn: [current.id], expectedSourceRevision: service.status().sourceRevision }), error => error.code === 'goal_dependency_cycle');
  save({ action: 'goal-archive', goalId: current.id, archived: true });
  assert.equal(service.status().goals.find(g => g.id === current.id).archived, true);
  assert.throws(() => service.prepareEdit({ action: 'goal-save', title: '다른 목표', dependsOn: [current.id], expectedSourceRevision: service.status().sourceRevision }), error => error.code === 'invalid_goal_dependency');
  save({ action: 'goal-archive', goalId: current.id, archived: false });
  current = service.status().goals.find(g => g.id === current.id); assert.equal(current.archived, false); assert.equal(current.status, 'UNASSIGNED');
  assert.equal(service.status().goals.length, 3);
});

test('goal ledger rejects technical jargon in the user-facing help card', t => {
  const paths = fixture(t);
  const invalid = JSON.parse(fs.readFileSync(paths.masterGoalsPath, 'utf8'));
  invalid.userHelp[0].ask = 'UAC 창을 승인하세요.';
  fs.writeFileSync(paths.masterGoalsPath, JSON.stringify(invalid));
  assert.throws(() => createGoalLedgerService(paths).status(), error => error.code === 'invalid_goal_ledger');
});

test('server exposes same-origin goal reads and reversible check writes', async t => {
  const paths = fixture(t);
  const service = createGoalLedgerService({ ...paths, now: () => '2026-08-31T04:00:00.000Z' });
  const server = createServer({
    collectStatus: async () => ({ ok: true }),
    goalLedgerService: service,
    actionController: { list: () => [], preview: async () => ({}), execute: async () => ({}) }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const initial = await fetch(`${base}/api/goals`).then(response => response.json());
  assert.equal(initial.summary.goalCount, 2);
  const response = await fetch(`${base}/api/goals/check`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ goalId: 'G02', checked: true })
  });
  assert.equal(response.status, 200);
  const checked = await response.json();
  assert.equal(checked.goals[1].checked, true);
  assert.equal(checked.goals[1].status, 'COMPLETE');
});

test('server removes a completed user action from the active list and keeps completion history', async t => {
  const paths = fixture(t);
  const clock = () => '2026-08-31T04:00:00.000Z';
  const ledger = new UserActionLedger({ snapshotPath: paths.userActionsPath, eventsPath: paths.userActionEventsPath, now: clock });
  ledger.add({
    id: 'UA-02-FACTS', part: '02', partTitle: '잔여 작업 통합', title: '경험 내용 알려주기',
    ask: '내가 맡은 일을 알려주세요.', why: '확인된 내용만 기록하기 위해 필요합니다.',
    steps: ['경험 이름을 적습니다.', '맡은 일을 한 줄로 적습니다.'], completionCriteria: '다섯 경험의 역할이 기록됩니다.'
  });
  const service = createGoalLedgerService({ ...paths, userActionLedger: ledger, now: clock });
  const server = createServer({
    collectStatus: async () => ({ ok: true }), goalLedgerService: service,
    actionController: { list: () => [], preview: async () => ({}), execute: async () => ({}) }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const response = await fetch(`${base}/api/goals/user-actions/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ id: 'UA-02-FACTS', evidence: '사용자가 화면에서 완료를 확인했습니다.' })
  });
  assert.equal(response.status, 200);
  const completed = await response.json();
  assert.equal(completed.removed, true);
  assert.equal(completed.completedBy, 'USER');
  assert.equal(completed.userActions.activeCount, 0);
  assert.equal(completed.userActions.completedCount, 1);
  assert.match(fs.readFileSync(paths.userActionEventsPath, 'utf8'), /"type":"COMPLETED"/);
});
