import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ControlReportStore } from '../src/control-plane/report-store.mjs';
import { WorkLedgerResumeView } from '../src/control-plane/work-ledger.mjs';
import { UserActionLedger } from '../src/goals/user-action-ledger.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-work-ledger-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const control = path.join(root, 'control-plane');
  fs.mkdirSync(control, { recursive: true });
  fs.writeFileSync(path.join(control, 'session-registry.json'), JSON.stringify({
    schemaVersion: 1, updatedAt: '2026-09-26T00:00:00.000Z', currentControlPath: 'C:/safe/PROJECT.md', sessions: [
      { number: '01', title: 'Main control', state: 'ACTIVE', decision: 'KEEP', objective: 'Continue verified work.', progress: 'Baseline passed.', remaining: 'Run next gate.', reportWorkerIds: ['session-01'] },
      { number: '12', title: 'Historical', state: 'ARCHIVED', decision: 'ARCHIVE', objective: 'Old work.', progress: 'Done.', remaining: 'None.', reportWorkerIds: ['session-12'] }
    ]
  }));
  const reports = new ControlReportStore({ stateRoot: root, now: () => 1_790_000_000_000 });
  reports.write({ schemaVersion: 1, controlPlaneId: 'integrated-work-control', workerId: 'session-01', workerSequence: 1, status: 'PROGRESS', revision: 'r1', summary: 'Verified progress.', nextGate: 'Implement resume view.', evidence: [] });
  reports.write({ schemaVersion: 1, controlPlaneId: 'integrated-work-control', workerId: 'orphan-worker', workerSequence: 1, status: 'HOLD', revision: 'r1', summary: 'Independent work.', nextGate: 'Inspect orphan.', evidence: [] });
  const actions = new UserActionLedger({ ownerRoot: root, now: () => '2026-09-26T00:00:00.000Z' });
  actions.add({ id: 'UA-01', part: '01', partTitle: 'Main', title: 'Confirm one thing', ask: 'Confirm the value.', why: 'The next write needs it.', steps: ['Check the value.'], completionCriteria: 'Value confirmed.', state: 'BLOCKING', blockingReason: 'No safe write remains.', safeWorkRemaining: false });
  return { root, reports, actions };
}

test('resume view merges session, reports, user actions, and orphan workers without mutating sources', t => {
  const f = fixture(t);
  const view = new WorkLedgerResumeView({ ownerRoot: f.root, reportStore: f.reports, userActionLedger: f.actions });
  const before = fs.readFileSync(path.join(f.root, 'control-plane', 'session-registry.json'), 'utf8');
  const result = view.status();
  assert.equal(result.ok, true);
  assert.equal(result.summary.sessions, 1);
  assert.equal(result.summary.archivedHidden, 1);
  assert.equal(result.current.number, '01');
  assert.equal(result.current.latestSummary, 'Verified progress.');
  assert.equal(result.current.blockingUserActions, 1);
  assert.equal(result.blockingUserActions[0].id, 'UA-01');
  assert.equal(result.orphanWorkers[0].workerId, 'orphan-worker');
  assert.equal(result.resumeTarget.kind, 'session');
  assert.equal(result.resumeTarget.id, '01');
  assert.equal(fs.readFileSync(path.join(f.root, 'control-plane', 'session-registry.json'), 'utf8'), before);
});

test('resume view supports session numbers beyond the legacy 01-11 range', t => {
  const f = fixture(t);
  const result = new WorkLedgerResumeView({ ownerRoot: f.root, reportStore: f.reports, userActionLedger: f.actions }).status({ includeArchived: true });
  assert.deepEqual(result.sessions.map(session => session.number), ['01', '12']);
});

test('a corrupt optional session registry degrades the view instead of hiding report recovery data', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'control-plane', 'session-registry.json'), '{bad json');
  const result = new WorkLedgerResumeView({ ownerRoot: f.root, reportStore: f.reports, userActionLedger: f.actions }).status();
  assert.equal(result.ok, false);
  assert.equal(result.sourceHealth.sessions.ok, false);
  assert.equal(result.orphanWorkers.length, 2);
  assert.equal(result.resumeTarget.kind, 'worker');
  assert.equal(result.resumeTarget.id, 'orphan-worker');
  assert.equal(result.summary.blockingUserActions, 1);
});

test('secret-like session text is never surfaced by the resume view', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'control-plane', 'session-registry.json'), JSON.stringify({ schemaVersion: 1, sessions: [{ number: '01', title: 'Main', objective: 'token=should-not-leak', reportWorkerIds: [] }] }));
  const result = new WorkLedgerResumeView({ ownerRoot: f.root, reportStore: f.reports, userActionLedger: f.actions }).status();
  assert.equal(result.ok, false);
  assert.equal(result.sourceHealth.sessions.error, 'secret_like_work_ledger_source');
  assert.equal(result.sessions.length, 0);
});