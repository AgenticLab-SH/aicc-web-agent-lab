import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runControlReportCommand } from '../src/control-plane-report-command.mjs';
import { CONTROL_REPORT_STATUSES, ControlReportError, ControlReportStore, controlReportHash, normalizeControlReport } from '../src/control-plane/report-store.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-control-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, store: new ControlReportStore({ root, now: () => 1_788_100_000_000, ...options }) };
}

function report(overrides = {}) {
  return {
    schemaVersion: 1,
    controlPlaneId: 'integrated-work-control',
    workerId: 'windows',
    workerSequence: 1,
    status: 'DONE',
    revision: 'windows-canonical-r1',
    summary: 'Windows canonical path verification passed.',
    evidence: [{ type: 'receipt', ref: 'dev-junction-retirement', sha256: 'a'.repeat(64) }],
    ...overrides
  };
}

test('writes a bounded worker report and builds one deterministic snapshot', t => {
  const { root, store } = fixture(t);
  const written = store.write(report());
  assert.equal(written.changed, true);
  assert.equal(written.sequence, 1);
  const status = store.status();
  assert.equal(status.workers.windows.status, 'DONE');
  assert.equal(status.counts.DONE, 1);
  assert.equal(status.integrity.journalEvents, 1);
  assert.equal(fs.lstatSync(path.join(root, 'snapshot.json')).isSymbolicLink(), false);
});

test('optional evidence hashes stay omitted across durable replay', t => {
  const { root, store } = fixture(t);
  store.write(report({ evidence: [{ type: 'git', ref: 'open-AICC@9783c78' }] }));
  assert.deepEqual(store.status().workers.windows.evidence, [{ type: 'git', ref: 'open-AICC@9783c78' }]);
  assert.deepEqual(new ControlReportStore({ root }).status().workers.windows.evidence, [{ type: 'git', ref: 'open-AICC@9783c78' }]);
});

test('same worker sequence is idempotent only for exact report content', t => {
  const { store } = fixture(t);
  store.write(report());
  const duplicate = store.write(report());
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.sequence, 1);
  assert.throws(() => store.write(report({ summary: 'different' })), error => error instanceof ControlReportError && error.code === 'worker_sequence_conflict');
  assert.throws(() => store.write(report({ workerSequence: 0 })), error => error.code === 'invalid_worker_sequence');
});

test('stale worker sequences fail closed', t => {
  const { store } = fixture(t);
  store.write(report({ workerSequence: 2 }));
  assert.throws(() => store.write(report({ workerSequence: 1 })), error => error.code === 'stale_worker_sequence');
});

test('attention is derived without a model or thread message', t => {
  const { store } = fixture(t);
  store.write(report());
  store.write(report({
    workerId: 'deploy',
    status: 'HOLD',
    revision: 'provider-gate-r1',
    nextGate: 'Attend the September billing and provider gate.',
    evidence: []
  }));
  const status = store.status();
  assert.deepEqual(status.attention, ['deploy']);
  assert.equal(status.counts.DONE, 1);
  assert.equal(status.counts.HOLD, 1);
});

test('strict schema rejects prompt fields, secret-like content, and missing gates', t => {
  const { store } = fixture(t);
  assert.throws(() => store.write({ ...report(), prompt: 'copy this into a task' }), error => error.code === 'unknown_report_field');
  assert.throws(() => store.write(report({ summary: 'token=should-not-be-stored' })), error => error.code === 'secret_like_content_rejected');
  assert.throws(() => store.write(report({ status: 'HOLD' })), error => error.code === 'next_gate_required');
});

test('journal recovers a snapshot after a crash between append and rename', t => {
  const { root } = fixture(t);
  const crashing = new ControlReportStore({ root, now: () => 1_788_100_000_000, crashAfterJournal: true });
  assert.throws(() => crashing.write(report()), error => error.code === 'injected_crash_after_journal');
  const recovered = new ControlReportStore({ root }).status();
  assert.equal(recovered.sequence, 1);
  assert.equal(recovered.workers.windows.status, 'DONE');
  assert.equal(recovered.integrity.recoveredFromJournal, true);
});

test('tampered journal and live writer lock are rejected', t => {
  const { root, store } = fixture(t);
  store.write(report());
  fs.appendFileSync(path.join(root, 'events.jsonl'), '{"schemaVersion":1}\n');
  assert.throws(() => store.status(), error => error.code === 'journal_invalid');

  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-control-report-lock-'));
  t.after(() => fs.rmSync(secondRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(secondRoot, 'writer.lock'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
  const locked = new ControlReportStore({ root: secondRoot });
  assert.throws(() => locked.write(report()), error => error.code === 'writer_busy');
});

test('digest suppresses unchanged worker payload and command adapter stays deterministic', t => {
  const { root, store } = fixture(t);
  const written = runControlReportCommand('write', report(), { store });
  const unchanged = runControlReportCommand('digest', null, { store, since: written.digest });
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.workers, []);
  const status = runControlReportCommand('status', null, { root });
  assert.equal(status.sequence, 1);
});

test('published JSON schema stays aligned with the runtime contract', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../contracts/control-report.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.status.enum, [...CONTROL_REPORT_STATUSES]);
  assert.equal(schema.properties.evidence.maxItems, 8);
  assert.equal(schema.properties.workerSequence.minimum, 1);
  assert.deepEqual(schema.allOf[0].then.required, ['nextGate']);
  for (const key of ['completed', 'remaining', 'choices']) assert.equal(schema.properties[key].$ref, '#/$defs/shortList');
  assert.equal(schema.$defs.shortList.maxItems, 6);
});

test('legacy v1 hashes and crash replay stay stable when structured fields are absent', t => {
  const { root } = fixture(t);
  const legacy = { ...report(), nextGate: null };
  assert.equal(controlReportHash(normalizeControlReport(report())), controlReportHash(legacy));
  const crashing = new ControlReportStore({ root, crashAfterJournal: true });
  assert.throws(() => crashing.write(report()), error => error.code === 'injected_crash_after_journal');
  const recovered = new ControlReportStore({ root });
  const state = recovered.status(), worker = state.workers.windows;
  assert.equal(worker.reportHash, controlReportHash(legacy));
  assert.equal(state.digest, controlReportHash({ schemaVersion: 1, workers: { windows: {
    workerSequence: 1, status: 'DONE', revision: legacy.revision, summary: legacy.summary,
    nextGate: null, evidenceHash: controlReportHash(legacy.evidence), reportHash: controlReportHash(legacy)
  } } }));
  assert.equal(recovered.write(report()).duplicate, true);
  assert.equal(Object.hasOwn(recovered.status().workers.windows, 'remaining'), false);
});

test('structured report changes reach digest and durable replay without a second ledger', t => {
  const { root, store } = fixture(t);
  const old = store.write(report());
  const details = { completed: ['설명 저장'], remaining: ['실화면 확인'], choices: ['기본 옵션 선택'], nextAction: '다음 독립 구현' };
  const input = report({ workerSequence: 2, status: 'PROGRESS', ...details });
  const crashing = new ControlReportStore({ root, crashAfterJournal: true });
  assert.throws(() => runControlReportCommand('write', input, { store: crashing }), error => error.code === 'injected_crash_after_journal');
  const replayed = new ControlReportStore({ root });
  const digest = replayed.digest({ since: old.digest });
  assert.equal(digest.changed, true);
  for (const [key, value] of Object.entries(details)) {
    assert.deepEqual(digest.workers[0][key], value);
    assert.deepEqual(replayed.status().workers.windows[key], value);
  }
  assert.deepEqual(replayed.digest({ since: digest.digest }).workers, []);
  assert.equal(replayed.write(input).duplicate, true);
  assert.throws(() => replayed.write({ ...input, remaining: [] }), error => error.code === 'worker_sequence_conflict');
});

test('structured report fields reject oversized, nontext and secret content; snapshot details are integrity bound', t => {
  const { root, store } = fixture(t);
  for (const patch of [{ remaining: Array(7).fill('short') }, { choices: [42] }, { completed: ['x'.repeat(241)] }, { nextAction: null }, { nextAction: 'x'.repeat(161) }, { remaining: ['line\nbreak'] }]) {
    assert.throws(() => store.write(report(patch)), error => error.code.startsWith('invalid_'));
  }
  assert.throws(() => store.write(report({ choices: ['token=hidden'] })), error => error.code === 'secret_like_content_rejected');
  store.write(report({ remaining: [] }));
  const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'snapshot.json'), 'utf8'));
  snapshot.workers.windows.remaining = ['injected'];
  fs.writeFileSync(path.join(root, 'snapshot.json'), JSON.stringify(snapshot));
  assert.throws(() => store.status(), error => error.code === 'snapshot_hash_invalid');
});
