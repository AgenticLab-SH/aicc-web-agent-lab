import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadProjectServicesManifest, projectServicesExampleManifest, projectServicesSnapshot, projectServicesStatus, selectProjectService } from '../src/project-services.mjs';

test('public project service example keeps required core routes and owner projects separate', () => {
  const manifest = loadProjectServicesManifest(projectServicesExampleManifest);
  assert.deepEqual(manifest.projects, []);
  assert.ok(manifest.policy.requiredCoreLabels.includes('com.opencodex.proxy'));
  assert.ok(manifest.policy.requiredCoreLabels.includes('com.agenticlab.aicc-workspace-tunnel'));
  assert.equal(manifest.policy.autoStop, false);
});

test('project service status detects on-demand plist state and active connections', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-project-services-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = {
    schemaVersion: 1,
    policy: { requiredCoreLabels: [] },
    projects: [{ id: 'demo', label: 'Demo', description: 'demo', healthUrl: 'http://127.0.0.1:1/healthz', listenPort: 1234, units: [{ label: 'com.example.demo', role: 'app', startOrder: 1, stopOrder: 1 }] }]
  };
  fs.writeFileSync(path.join(root, 'com.example.demo.plist'), 'fixture');
  const runSync = (executable, args) => {
    if (executable === 'plutil') return { status: 0, stdout: 'false' };
    if (executable === 'launchctl') return { status: 0, stdout: 'path = fixture\npid = 42\n' };
    if (executable === 'lsof') return { status: 0, stdout: '' };
    return { status: 1, stdout: '' };
  };
  const status = projectServicesStatus({ platform: 'darwin', manifest, launchAgentsRoot: root, uid: 501, runSync });
  assert.equal(status.projects[0].state, 'running');
  assert.equal(status.projects[0].onDemandReady, true);
  assert.equal(status.projects[0].activeConnections, 0);
  assert.deepEqual(selectProjectService({ id: 'demo' }, status, 'stopped'), { id: 'demo' });
  assert.equal(projectServicesSnapshot(status).projects[0].units[0].running, true);
});

test('project service status isolates LaunchAgent probes on Windows', () => {
  const manifest = {
    schemaVersion: 1,
    policy: { requiredCoreLabels: [] },
    projects: [{ id: 'demo', label: 'Demo', description: 'demo', healthUrl: 'http://127.0.0.1:1/healthz', listenPort: 1234, units: [{ label: 'com.example.demo', role: 'app' }] }]
  };
  let calls = 0;
  const status = projectServicesStatus({ platform: 'win32', manifest, runSync: () => { calls += 1; } });
  assert.equal(status.supported, false);
  assert.equal(status.projects[0].state, 'unavailable');
  assert.equal(calls, 0);
  assert.throws(() => selectProjectService({ id: 'demo' }, status, 'running'), /macOS/);
});

test('project stop selection fails closed when active connections exist', () => {
  const status = { projects: [{ id: 'demo', state: 'running', onDemandReady: true, activeConnections: 1 }] };
  assert.throws(() => selectProjectService({ id: 'demo' }, status, 'stopped'), /현재 사이트 연결/);
});
