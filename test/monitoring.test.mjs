import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectCodexAutomations,
  collectLaunchAgents,
  loadMonitoringManifest,
  monitoringStatus,
  pullOracleMonitoring
} from '../src/monitoring.mjs';

test('monitoring manifest describes one local control chain with automatic apply disabled', () => {
  const manifest = loadMonitoringManifest();
  assert.equal(manifest.policy.automaticApply, false);
  assert.equal(manifest.policy.upstreamPrimary, 'local-aicc-direct');
  assert.equal(manifest.policy.oracleAdapterDefault, 'disabled');
  assert.deepEqual(manifest.layers.map(layer => layer.id), ['authority', 'sensors', 'signal', 'review', 'apply', 'evidence']);
  assert.ok(manifest.launchAgentRoles.some(item => item.label === 'com.opencodex.proxy'));
  assert.deepEqual(manifest.projectOwnedLabelPrefixes, ['com.agenticfabworks.', 'com.agenticlab.youtube-']);
  assert.equal(JSON.stringify(manifest).includes('demo-owner'), false);
});

test('Codex automation inventory reads status without exposing prompt content', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-automations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'paused'), { recursive: true });
  fs.writeFileSync(path.join(root, 'paused', 'automation.toml'), 'id = "paused"\nname = "점검"\nkind = "heartbeat"\nstatus = "PAUSED"\nprompt = "secret prompt"\n');
  const result = collectCodexAutomations({ automationsRoot: root });
  assert.deepEqual(result, {
    count: 1,
    paused: 1,
    active: 0,
    items: [{ id: 'paused', name: '점검', status: 'PAUSED', kind: 'heartbeat' }]
  });
  assert.equal(JSON.stringify(result).includes('secret prompt'), false);
});

test('LaunchAgent inventory sums a process tree and classifies AICC roles', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-launch-agents-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'com.opencodex.proxy.plist'), 'fixture');
  const runSync = (executable, args) => {
    if (executable === 'launchctl') return { status: 0, stdout: 'PID\tStatus\tLabel\n100\t0\tcom.opencodex.proxy\n' };
    if (executable === 'ps') return { status: 0, stdout: '100 1 1.5 10240\n101 100 0.5 5120\n' };
    if (executable === 'plutil') {
      const key = args[1];
      const values = { Label: 'com.opencodex.proxy', KeepAlive: 'false', StartInterval: '' };
      return values[key] ? { status: 0, stdout: values[key] } : { status: 1, stdout: '' };
    }
    return { status: 1, stdout: '' };
  };
  const result = collectLaunchAgents({ platform: 'darwin', launchAgentsRoot: root, runSync });
  assert.equal(result.summary.registered, 1);
  assert.equal(result.summary.residentMiB, 15);
  assert.equal(result.items[0].processCount, 2);
  assert.equal(result.items[0].group, 'aicc-core');
});

test('registered on-demand project units stay intentional-off after a graceful stop', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-launch-agents-on-demand-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'com.example.site.plist'), 'fixture');
  const runSync = (executable, args) => {
    if (executable === 'launchctl') return { status: 0, stdout: 'PID\tStatus\tLabel\n-\t143\tcom.example.site\n' };
    if (executable === 'ps') return { status: 0, stdout: '' };
    if (executable === 'plutil') {
      const values = { Label: 'com.example.site', RunAtLoad: 'false', KeepAlive: 'false', StartInterval: '' };
      return values[args[1]] !== undefined ? { status: 0, stdout: values[args[1]] } : { status: 1, stdout: '' };
    }
    return { status: 1, stdout: '' };
  };
  const result = collectLaunchAgents({
    platform: 'darwin',
    launchAgentsRoot: root,
    projectServiceLabels: new Set(['com.example.site']),
    runSync
  });
  assert.equal(result.items[0].group, 'project-on-demand');
  assert.equal(result.items[0].attention, false);
  assert.equal(result.items[0].runAtLoad, false);
  assert.equal(result.items[0].keepAlive, false);
});

test('Oracle pull uses the registered transport, sanitizes state, and writes a private local signal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-monitoring-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot = path.join(root, 'oracle-upstream.json');
  const remote = {
    state: {
      checkedAt: '2026-08-14T00:00:00Z',
      automaticApply: false,
      counts: { current: 0, update_available: 1, auth_required: 0, unknown: 0 },
      sources: [{ id: 'ocx-upstream-npm', type: 'npm', repository: 'private/name', status: 'update_available', baselineVersion: '1', currentVersion: '2' }]
    },
    timer: { ActiveState: 'active', SubState: 'waiting', UnitFileState: 'enabled' },
    service: { Type: 'oneshot', ActiveState: 'inactive', SubState: 'dead', Result: 'success', CPUUsageNSec: '1234' }
  };
  const calls = [];
  const result = await pullOracleMonitoring({
    oracleSnapshotPath: snapshot,
    connection: { bastionTarget: 'bastion-alias', identityFile: '/owner/key' },
    now: () => Date.parse('2026-08-14T01:00:00Z'),
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args, input: options.input });
      return `${JSON.stringify(remote)}\n`;
    }
  });
  assert.equal(calls[0].executable, 'ssh');
  assert.ok(calls[0].input.includes('open-aicc-upstream-watch.service'));
  assert.equal(result.sources[0].repository, undefined);
  assert.equal(result.sources[0].currentVersion, '2');
  if (process.platform !== 'win32') assert.equal(fs.statSync(snapshot).mode & 0o077, 0);
});

test('monitoring status marks a recent direct local scan as the primary signal', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-monitoring-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot = path.join(root, 'local-upstream.json');
  fs.writeFileSync(snapshot, JSON.stringify({ checkedAt: '2026-08-14T00:00:00Z', counts: {}, sources: [] }));
  const result = monitoringStatus({
    upstreamStatePath: snapshot,
    oracleSnapshotPath: path.join(root, 'missing-oracle.json'),
    now: () => Date.parse('2026-08-14T01:00:00Z'),
    launchAgents: { supported: true, items: [], summary: { registered: 0, running: 0, residentMiB: 0, cpuPercent: 0 } },
    automations: { count: 0, paused: 0, active: 0, items: [] },
    projectServices: { ok: true, projects: [], summary: {} }
  });
  assert.equal(result.signal.state, 'current');
  assert.equal(result.oracle, null);
  assert.equal(result.upstream.checkedAt, '2026-08-14T00:00:00Z');
  assert.equal(result.automaticApply, false);
});
