import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  attemptEventHash,
  DurableAttemptJournal,
  stopDisposition,
} from '../src/control-plane/durable-attempt-journal.mjs';

const hash = character => character.repeat(64);

function fixture(t) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-attempt-journal-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  return new DurableAttemptJournal({ stateRoot });
}

function event(sequence, phase, previous = null, overrides = {}) {
  return {
    schemaVersion: 1,
    operationId: 'op-1',
    attemptId: 'attempt-1',
    componentId: 'workspace-tunnel',
    requestHash: hash('a'),
    sequence,
    previousEventHash: previous ? attemptEventHash(previous) : null,
    phase,
    at: `2026-09-14T00:00:0${Math.min(sequence, 9)}.000Z`,
    processStartToken: 'pid-100-start-1',
    executableHash: hash('b'),
    bundleHash: hash('c'),
    configHash: hash('d'),
    routeGeneration: 'route-1',
    ...overrides,
  };
}

test('appends and validates a monotonic fsynced hash chain', t => {
  const journal = fixture(t);
  const one = event(1, 'invocation_received');
  const two = event(2, 'parsed', one);
  assert.equal(journal.append(one).sequence, 1);
  assert.equal(journal.append(two).sequence, 2);
  assert.deepEqual(journal.read(one).map(item => item.phase), ['invocation_received', 'parsed']);
});

test('rejects sequence, hash, identity and transition drift', t => {
  const journal = fixture(t);
  const one = event(1, 'invocation_received');
  journal.append(one);
  assert.throws(() => journal.append(event(3, 'parsed', one)), /journal_transition_invalid/);
  assert.throws(() => journal.append(event(2, 'dispatch_started', one)), /journal_transition_invalid/);
  assert.throws(() => journal.append(event(2, 'parsed', one, { requestHash: hash('e') })), /journal_transition_invalid/);
});

test('rejects arbitrary fields and likely secret-bearing payloads', t => {
  const journal = fixture(t);
  assert.throws(() => journal.append({ ...event(1, 'invocation_received'), prompt: 'secret' }), /journal_event_invalid/);
  assert.throws(() => journal.append({ ...event(1, 'invocation_received'), code: 'raw error with spaces' }), /journal_event_invalid/);
});

test('holds concurrent writers and refuses symlink journals', { skip: process.platform === 'win32' }, t => {
  const journal = fixture(t);
  const one = event(1, 'invocation_received');
  const file = journal.fileFor(one.componentId, one.operationId, one.attemptId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.lock`, 'held');
  assert.throws(() => journal.append(one), /journal_writer_conflict/);
  fs.unlinkSync(`${file}.lock`);
  fs.symlinkSync(path.join(path.dirname(file), 'missing'), file);
  assert.throws(() => journal.append(one), /journal_storage_invalid/);
});

test('post-dispatch restart can only reconcile and never redispatch', t => {
  const journal = fixture(t);
  const phases = ['invocation_received', 'parsed', 'gate_sampled', 'inspected',
    'preimage_sealed', 'backup_sealed', 'commit_reserved', 'dispatch_started'];
  let previous = null;
  for (let index = 0; index < phases.length; index += 1) {
    const current = event(index + 1, phases[index], previous);
    journal.append(current);
    previous = current;
  }
  assert.deepEqual(stopDisposition(journal.read(previous)), { safeToStop: false, state: 'reconcile_required' });
  assert.throws(() => journal.append(event(9, 'dispatch_started', previous,
    { processStartToken: 'pid-200-start-2' })), /journal_transition_invalid/);
  const reconcile = event(9, 'reconcile_started', previous,
    { processStartToken: 'pid-200-start-2' });
  journal.append(reconcile);
  assert.equal(journal.read(reconcile).at(-1).phase, 'reconcile_started');
});

test('pre-dispatch stop is safe and terminal attempts reject later events', t => {
  const journal = fixture(t);
  const one = event(1, 'invocation_received');
  const two = event(2, 'terminal_hold', one, { code: 'owner_stop' });
  journal.append(one);
  assert.deepEqual(stopDisposition(journal.read(one)), { safeToStop: true, state: 'stoppable' });
  journal.append(two);
  assert.throws(() => journal.append(event(3, 'parsed', two)), /journal_transition_invalid/);
});
