import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UserActionLedger, runUserActionCommand } from '../src/goals/user-action-ledger.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-user-actions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    snapshotPath: path.join(root, 'user-actions.json'),
    eventsPath: path.join(root, 'user-action-events.jsonl'),
    now: () => '2026-08-31T00:00:00.000Z'
  };
}

function action(overrides = {}) {
  return {
    id: 'UA-02-FACTS', part: '02', partTitle: '잔여 작업 통합', title: '경험 내용 알려주기',
    ask: '내가 맡은 일을 알려주세요.', why: '확인된 내용만 기록하기 위해 필요합니다.',
    steps: ['경험 이름을 적습니다.', '맡은 일을 한 줄로 적습니다.'],
    completionCriteria: '다섯 경험의 역할이 기록됩니다.', sourceRef: 'session-02', ...overrides
  };
}

test('user actions accumulate by stable id and unchanged writes are idempotent', t => {
  const options = fixture(t);
  const ledger = new UserActionLedger(options);
  const first = ledger.add(action());
  const duplicate = ledger.add(action());
  assert.equal(first.changed, true);
  assert.equal(duplicate.changed, false);
  assert.equal(ledger.status().activeCount, 1);
  assert.equal(ledger.status().historyCount, 1);

  const updated = ledger.add(action({ ask: '내가 맡은 일과 결과를 알려주세요.' }));
  assert.equal(updated.changed, true);
  assert.equal(ledger.status().actions[0].ask, '내가 맡은 일과 결과를 알려주세요.');
  assert.equal(ledger.status().historyCount, 2);
});

test('blocking actions sort first and future actions remain recorded for later', t => {
  const options = fixture(t);
  const ledger = new UserActionLedger(options);
  ledger.add(action({ id: 'UA-06-LATER', part: '06', partTitle: '로컬 환경 최적화', title: '저장장치 용도 고르기', availableAfter: '2026-09-07T00:00:00.000Z' }));
  ledger.add(action({
    id: 'UA-08-BLOCK', part: '08', partTitle: '실전 자동매매', title: '손실 한도 정하기', state: 'BLOCKING',
    safeWorkRemaining: false, blockingReason: '안전 한도 없이는 다음 시험을 시작할 수 없습니다.'
  }));
  const status = ledger.status();
  assert.equal(status.activeCount, 2);
  assert.equal(status.blockingCount, 1);
  assert.equal(status.laterCount, 1);
  assert.equal(status.actions[0].id, 'UA-08-BLOCK');
  assert.equal(status.actions[1].readyNow, false);
});

test('completion removes the active action but preserves an append-only evidence event', t => {
  const options = fixture(t);
  const ledger = new UserActionLedger(options);
  ledger.add(action());
  const result = ledger.complete({ id: 'UA-02-FACTS', completedBy: 'AGENT', evidence: '다섯 경험의 역할을 정본에서 확인했습니다.' });
  assert.equal(result.removed, true);
  assert.equal(ledger.status().activeCount, 0);
  assert.equal(ledger.status().completedCount, 1);
  assert.equal(ledger.status().historyCount, 2);
  const events = fs.readFileSync(options.eventsPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(events.map(event => event.type), ['ADDED', 'COMPLETED']);
  assert.equal(events[1].evidence, '다섯 경험의 역할을 정본에서 확인했습니다.');
});

test('command exposes compact machine-readable status for future agents', t => {
  const ledger = new UserActionLedger(fixture(t));
  runUserActionCommand('add', action(), { ledger });
  const status = runUserActionCommand('status', null, { ledger });
  assert.equal(status.ok, true);
  assert.equal(status.activeCount, 1);
  assert.equal(status.actions[0].agentNext, null);
});

test('user-facing actions reject technical abbreviations and vague completion', t => {
  const ledger = new UserActionLedger(fixture(t));
  assert.throws(() => ledger.add(action({ ask: 'UAC를 눌러주세요.' })), error => error.code === 'invalid_user_action');
  assert.throws(() => ledger.add(action({ completionCriteria: '' })), error => error.code === 'invalid_user_action');
  assert.throws(() => ledger.add(action({ state: 'BLOCKING', blockingReason: '지금 필요합니다.' })), error => error.code === 'invalid_user_action');
});

test('all numbered parts are accepted and invalid existing state fails closed', t => {
  const options = fixture(t);
  const ledger = new UserActionLedger(options);
  ledger.add(action({ id: 'UA-10-REVIEW', part: '10', partTitle: '복구 검토' }));
  ledger.add(action({ id: 'UA-11-CONTROL', part: '11', partTitle: '통합 관제' }));
  assert.deepEqual(ledger.status().actions.map(item => item.part), ['10', '11']);

  fs.writeFileSync(options.snapshotPath, JSON.stringify({ schemaVersion: 2, actions: [] }));
  assert.throws(() => ledger.status(), error => error.code === 'invalid_user_action_ledger');
  assert.throws(() => ledger.add(action()), error => error.code === 'invalid_user_action_ledger');
  assert.equal(JSON.parse(fs.readFileSync(options.snapshotPath, 'utf8')).schemaVersion, 2);
});

test('ids and future gates use exact string contracts', t => {
  const ledger = new UserActionLedger(fixture(t));
  assert.throws(() => ledger.add(action({ id: 12 })), error => error.code === 'invalid_user_action');
  assert.throws(() => ledger.add(action({ availableAfter: '2026-09-07' })), error => error.code === 'invalid_user_action');
});

test('completion preview binds the entire action and locked completion rejects changed criteria', t => {
  const ledger = new UserActionLedger(fixture(t));
  ledger.add(action());
  const original = ledger.status().actions[0];
  const input = { id: original.id, expectedActionRevision: original.revision, evidence: '확인된 실제 완료 근거' };
  assert.match(ledger.prepareComplete(input).summary.join('\n'), /다섯 경험/);
  assert.throws(() => ledger.prepareComplete({ ...input, evidence: '' }), error => error.code === 'invalid_user_action');
  assert.throws(() => ledger.prepareComplete({ ...input, expectedActionRevision: null }), error => error.code === 'user_action_revision_required');
  ledger.add(action({ completionCriteria: '변경된 완료 기준' }));
  assert.throws(() => ledger.prepareComplete(input), error => error.code === 'user_action_revision_conflict');
  assert.throws(() => ledger.complete(input), error => error.code === 'user_action_revision_conflict');
  assert.equal(ledger.status().activeCount, 1);
  const current = ledger.status().actions[0];
  ledger.complete({ ...input, expectedActionRevision: current.revision, completedBy: 'USER' });
  assert.equal(ledger.status().activeCount, 0);
  assert.equal(ledger.status().completedCount, 1);
});

test('a live writer lock prevents concurrent ledger changes', t => {
  const options = fixture(t);
  const lockPath = path.join(path.dirname(options.snapshotPath), 'user-actions.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
  const ledger = new UserActionLedger({ ...options, lockPath });
  assert.throws(() => ledger.add(action()), error => error.code === 'writer_busy');
  assert.equal(fs.existsSync(options.snapshotPath), false);
});
