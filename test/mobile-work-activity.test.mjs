import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { emptyJobState, DurableJobStore } from '../src/jobs/durable-store.mjs';
import { readMobileWorkActivity } from '../src/jobs/status.mjs';

const now = Date.parse('2026-11-17T00:00:00Z');
const at = offset => new Date(now + offset).toISOString();
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-activity-'));
  const jobs = path.join(root, 'jobs');
  fs.mkdirSync(jobs);
  const state = emptyJobState();
  const save = () => fs.writeFileSync(path.join(jobs, 'state.json'), JSON.stringify(state));
  const read = () => readMobileWorkActivity({ stateRoot: root, now: () => now });
  return { root, jobs, state, save, read };
}
function running(id = 'private-job') {
  return { jobId: id, workspaceId: 'private-workspace', identityBinding: 'private-identity',
    direction: 'web_to_local', requestedRoute: 'private-route', state: 'running',
    prompt: 'secret private prompt', writerLease: { workspaceId: 'private-workspace', attemptId: 'a', expiresAt: at(10000) },
    attempts: [{ attemptId: 'a', identityBinding: 'private-identity', routeId: 'private-route',
      state: 'running', heartbeatAt: at(-1000), startedAt: at(-20000) }] };
}
test('only a fresh bound attempt is an execution observation; projection does not grant write or expose private data', () => {
  const f = fixture(); f.state.jobs['private-job'] = running(); f.save();
  const before = fs.readFileSync(path.join(f.jobs, 'state.json'));
  const r = f.read();
  assert.equal(r.items[0].state, 'RECENT_EXECUTION');
  assert.equal(r.items[0].actor, 'WEB_ROUTE');
  assert.equal(r.items[0].writeAuthorized, false);
  assert.equal(r.completionVerified, false);
  assert.equal(JSON.stringify(r).includes('private-'), false);
  assert.deepEqual(fs.readFileSync(path.join(f.jobs, 'state.json')), before);
  assert.equal(fs.existsSync(path.join(f.jobs, 'writer.lock')), false);
});
test('expired/future/stale/queued and mismatched original attempts never become current execution', () => {
  const changes = [j => { j.attempts[0].heartbeatAt = at(-120000); },
    j => { j.attempts[0].heartbeatAt = at(1); }, j => { j.writerLease.expiresAt = at(0); },
    j => { j.attempts[0].identityBinding = 'foreign'; }, j => { j.writerLease.attemptId = 'foreign'; },
    j => { j.attempts[0].routeId = 'foreign'; }, j => { j.attempts[0].state = 'queued'; },
    j => { j.state = 'leased'; }, j => { j.attempts[0].heartbeatAt = 'invalid'; }];
  for (const change of changes) {
    const f = fixture(), job = running(); change(job); f.state.jobs[job.jobId] = job; f.save();
    assert.notEqual(f.read().items[0].state, 'RECENT_EXECUTION');
  }
});
test('a remote lease is never evidence of a live GPT; consumed write requests attest admission only', () => {
  const f = fixture();
  f.state.remoteLeases.l = { leaseId: 'l', workspaceId: 'private-ws', identityBinding: 'private-owner',
    mode: 'write', state: 'leased', expiresAt: at(10000), issuedAt: at(-1000) };
  f.save(); assert.equal(f.read().items[0].state, 'STALE_OR_WAITING');
  f.state.remoteReplay.r = { leaseId: 'l', consumedAt: at(-1000), requestHash: 'private-hash' };
  f.save(); const r = f.read();
  assert.equal(r.items[0].state, 'RECENT_TOOL_ADMISSION');
  assert.equal(r.items[0].actor, 'REMOTE_AGENT');
  assert.equal(JSON.stringify(r).includes('private-'), false);
  f.state.remoteReplay.r.consumedAt = at(1000); f.save();
  assert.equal(f.read().items[0].state, 'STALE_OR_WAITING');
});
test('read committed WAL and cap projection; a corrupt WAL preserves unknown without mutating source', () => {
  const f = fixture(); f.save();
  const store = new DurableJobStore({ root: f.jobs, create: false, now: () => now });
  store.transaction('fixture.activity', state => { for (let i=0;i<30;i++)state.jobs['j'+i] = running('j'+i); });
  const r = f.read(); assert.equal(r.items.length, 24); assert.equal(r.total, 30); assert.equal(r.truncated, true);
  fs.appendFileSync(path.join(f.jobs, 'journal.jsonl'), '{broken}\n');
  assert.equal(f.read().status, 'UNKNOWN');
});
test('missing or invalid stores never claim all agents idle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-activity-absent-'));
  const result = readMobileWorkActivity({ stateRoot: root, now: () => now });
  assert.equal(result.status, 'NOT_INITIALIZED');
  assert.equal(result.coverage, 'REGISTERED_LEDGER_ONLY');
  assert.equal(fs.existsSync(path.join(root, 'jobs')), false);
  const f = fixture(); fs.writeFileSync(path.join(f.jobs, 'state.json'), '{bad');
  assert.equal(f.read().status, 'UNKNOWN');
});

test('valid JSON with an invalid schema or binding cannot masquerade as an empty or live ledger', () => {
  const f = fixture();
  for (const value of [null, [], {}, {schemaVersion: 0, jobs: {}},
    {...emptyJobState(), sequence: -1}, {...emptyJobState(), jobs: []},
    {...emptyJobState(), remoteLeases: []}, {...emptyJobState(), remoteReplay: null}]) {
    fs.writeFileSync(path.join(f.jobs, 'state.json'), JSON.stringify(value));
    assert.equal(f.read().status, 'UNKNOWN');
  }
  for (const mutate of [j => { delete j.requestedRoute; delete j.attempts[0].routeId; },
    j => { delete j.attempts[0].attemptId; delete j.writerLease.attemptId; },
    j => { j.identityBinding = j.attempts[0].identityBinding = {}; }]) {
    f.state.jobs = { 'private-job': running() }; mutate(f.state.jobs['private-job']); f.save();
    assert.equal(f.read().items[0].state, 'UNKNOWN');
  }
});
