import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableAttemptJournal, processStartTokenHash } from '../src/recovery/attempt-journal.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-attempt-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let tick = 0;
  const writerIdentity = {
    pid: 42,
    processStartTokenHash: processStartTokenHash({ pid: 42, startedAt: '2026-08-24T00:00:00.000Z', executableHash: 'a'.repeat(64) })
  };
  const journal = new DurableAttemptJournal({
    root,
    operationId: 'restore-router',
    attemptId: 'attempt-001',
    writerIdentity,
    now: () => `2026-08-24T00:00:${String(tick++).padStart(2, '0')}.000Z`
  });
  return { root, journal };
}

test('attempt journal is append-only, owner-only and hash chained', t => {
  const { journal } = fixture(t);
  journal.append('invocation', { component: 'router-17841', mode: 'apply' });
  journal.append('gate_sample', { active: 0, unknown: 0, generationHash: 'b'.repeat(64) });
  journal.append('terminal', { terminal: 'HOLD_PRE_DISPATCH', reason: 'browser_not_ready' });
  const state = journal.inspect();
  assert.equal(state.events.length, 3);
  assert.equal(state.terminal, 'HOLD_PRE_DISPATCH');
  assert.match(state.chainHead, /^[a-f0-9]{64}$/);
  if (process.platform !== 'win32') {
    for (const name of fs.readdirSync(journal.eventsRoot)) {
      assert.equal(fs.statSync(path.join(journal.eventsRoot, name)).mode & 0o777, 0o600);
    }
  }
  assert.throws(() => journal.append('terminal', { terminal: 'PASS' }), error => error.code === 'attempt_terminal');
});

test('journal rejects private content and raw bytes', t => {
  const { journal } = fixture(t);
  assert.throws(() => journal.append('invocation', { prompt: 'private' }), error => error.code === 'sensitive_field_denied');
  assert.throws(() => journal.append('invocation', { evidence: Buffer.from('private') }), error => error.code === 'raw_bytes_denied');
  assert.equal(journal.inspect().events.length, 0);
});

test('stale writer lock fails closed and chain tampering is detected', t => {
  const { journal } = fixture(t);
  journal.append('invocation', { component: 'router-17841' });
  fs.writeFileSync(journal.lockFile, '{}\n', { mode: 0o600 });
  assert.throws(() => journal.append('inspection', {}), error => error.code === 'attempt_writer_conflict');
  fs.unlinkSync(journal.lockFile);
  const eventFile = path.join(journal.eventsRoot, '00000001.json');
  const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  event.metadata.component = 'other';
  fs.writeFileSync(eventFile, `${JSON.stringify(event)}\n`);
  assert.throws(() => journal.inspect(), error => error.code === 'event_hash_invalid');
});
