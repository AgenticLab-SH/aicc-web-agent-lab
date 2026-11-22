import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MonitoringJobService } from '../src/monitoring-job-service.mjs';
import { buildUpstreamUpdateNotification, schedulerTick } from '../src/local-scheduler.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-monitor-jobs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { value: Date.parse('2026-08-15T00:00:00.000Z') };
  let scans = 0;
  const state = path.join(root, 'monitoring', 'local-upstream.json');
  const service = new MonitoringJobService({
    stateRoot: root,
    root: path.join(root, 'monitoring', 'scheduler'),
    upstreamStatePath: state,
    now: () => clock.value,
    manifest: { policy: { localScanIntervalHours: 24 }, sources: Array.from({ length: 52 }, (_, index) => ({ id: `source-${index}` })) },
    scan: async options => {
      scans += 1;
      fs.mkdirSync(path.dirname(options.upstreamStatePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(options.upstreamStatePath, `${JSON.stringify({ schemaVersion: 1, checkedAt: new Date(clock.value).toISOString(), automaticApply: false, counts: { current: 39, update_available: 13, unknown: 0 }, sources: [] })}\n`, { mode: 0o600 });
      return JSON.parse(fs.readFileSync(options.upstreamStatePath, 'utf8'));
    }
  });
  return { root, clock, service, get scans() { return scans; } };
}

test('monitoring job requires confirmation, deduplicates one cadence window, and completes with verified evidence', async t => {
  const f = fixture(t);
  assert.equal(f.service.preview().sourceCount, 52);
  assert.throws(() => f.service.enqueue({ requestId: 'manual', idempotencyKey: 'manual' }), error => error.code === 'confirmation_required');

  const due = f.service.enqueueDue();
  assert.equal(due.due, true);
  const duplicate = f.service.enqueueDue();
  assert.equal(duplicate.due, false);
  assert.equal(duplicate.reason, 'pending-job');

  const result = await f.service.runOnce(due.job.jobId);
  assert.equal(result.job.state, 'completed');
  assert.equal(result.report.automaticApply, false);
  assert.equal(f.scans, 1);
  assert.equal(f.service.status().activeJobIds.length, 0);

  const current = f.service.enqueueDue();
  assert.equal(current.due, false);
  assert.equal(current.reason, 'cadence-current');
  f.clock.value += 24 * 60 * 60_000;
  assert.equal(f.service.enqueueDue().due, true);
});

test('scheduler runs at most one queued job per ledger, never auto-enqueues knowledge review, and isolates notification dispatch', async () => {
  const calls = [];
  const manager = { recoverExpired: () => calls.push('recover') };
  const monitoring = {
    manager,
    enqueueDue: () => ({ due: false, reason: 'cadence-current' }),
    status: () => ({ queuedJobIds: ['monitor-1'] }),
    runOnce: async id => { calls.push(`monitor:${id}`); return { jobId: id }; }
  };
  const knowledge = {
    manager,
    status: () => ({ queuedJobIds: [] }),
    runOnce: async id => { calls.push(`knowledge:${id}`); return { jobId: id }; }
  };
  const result = await schedulerTick({
    monitoringService: monitoring,
    knowledgeService: knowledge,
    processNotifications: async () => { calls.push('notifications'); return { ok: true, sent: 0 }; }
  });
  assert.deepEqual(calls, ['recover', 'monitor:monitor-1', 'notifications']);
  assert.equal(result.knowledge.reason, 'no-confirmed-job');
  assert.deepEqual(result.notifications, { ok: true, sent: 0 });
  assert.equal(result.automaticApply, false);
});

test('scheduler runs a confirmed knowledge job when monitoring setup fails', async () => {
  const calls = [];
  const monitoring = {
    manager: { recoverExpired: () => calls.push('monitor-recover') },
    enqueueDue: () => { throw Object.assign(new Error('portfolio missing'), { code: 'portfolio_missing' }); },
    status: () => ({ queuedJobIds: [] })
  };
  const knowledge = {
    manager: { recoverExpired: () => calls.push('knowledge-recover') },
    status: () => ({ queuedJobIds: ['knowledge-1'] }),
    runOnce: async id => { calls.push(`knowledge:${id}`); return { jobId: id, state: 'completed' }; }
  };
  const result = await schedulerTick({
    monitoringService: monitoring,
    knowledgeService: knowledge,
    auditAssets: () => ({ ok: true }),
    processNotifications: async () => ({ ok: true, sent: 0 })
  });
  assert.equal(result.monitoring.error, 'portfolio_missing');
  assert.equal(result.knowledge.state, 'completed');
  assert.deepEqual(calls, ['monitor-recover', 'knowledge-recover', 'knowledge:knowledge-1']);
});

test('scheduler arms one deduplicated Korean update alert from a completed local scan', async () => {
  const armed = [];
  const manager = { recoverExpired: () => {} };
  const report = {
    sources: [
      { id: 'ocx-upstream-npm', label: 'OpenCodex', status: 'update_available', currentVersion: '2.29.0' },
      { id: 'current-source', status: 'current', currentRevision: 'abc' }
    ]
  };
  const monitoring = {
    manager,
    enqueueDue: () => ({ due: false, reason: 'cadence-current' }),
    status: () => ({ queuedJobIds: ['monitor-2'] }),
    runOnce: async () => ({ report })
  };
  const knowledge = { manager, status: () => ({ queuedJobIds: [] }) };
  const result = await schedulerTick({
    monitoringService: monitoring,
    knowledgeService: knowledge,
    auditAssets: () => ({ ok: true }),
    armUpdateNotification: async (event, options) => { armed.push({ event, options }); return { ok: true, duplicate: false }; },
    processNotifications: async () => ({ ok: true, sent: 0 })
  });
  assert.equal(armed.length, 1);
  assert.equal(armed[0].event.type, 'report_ready');
  assert.equal(armed[0].event.taskId, 'aicc:upstream-monitor:daily');
  assert.match(armed[0].event.summary, /OCX 최신판은 2\.29\.0/);
  assert.equal(armed[0].options.bindingStore, false);
  assert.equal(result.updateNotification.ok, true);
  assert.equal(buildUpstreamUpdateNotification({ sources: [] }), null);
});

test('monitoring durable request root rejects a symlink owner ledger', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-monitor-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  const linked = path.join(root, 'linked');
  fs.symlinkSync(target, linked);
  assert.throws(
    () => new MonitoringJobService({
      stateRoot: root,
      root: linked,
      manifest: { policy: { localScanIntervalHours: 24 }, sources: [] }
    }),
    error => error.code === 'owner_state_symlink_denied'
  );
});
