import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProjectCatalogService, discoverProjectRoots } from '../src/projects/service.mjs';

const NOW = Date.parse('2026-08-15T06:00:00.000Z');

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-project-service-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const projectsRoot = path.join(temporary, 'projects');
  const stateRoot = path.join(temporary, 'state');
  fs.mkdirSync(path.join(projectsRoot, 'apps', 'alpha', '.git'), { recursive: true });
  fs.mkdirSync(path.join(projectsRoot, 'labs', 'prototype', '.git'), { recursive: true });
  fs.writeFileSync(path.join(projectsRoot, 'README.md'), '# fixture\n');
  const service = new ProjectCatalogService({ projectsRoot, stateRoot, now: () => NOW });
  return { projectsRoot: fs.realpathSync(projectsRoot), stateRoot, service };
}

test('project discovery finds independent and nested repository roots without traversing generated trees', t => {
  const { projectsRoot } = fixture(t);
  fs.mkdirSync(path.join(projectsRoot, 'apps', 'alpha', 'nested', '.git'), { recursive: true });
  const roots = discoverProjectRoots(projectsRoot);
  assert.deepEqual(roots.map(root => path.relative(projectsRoot, root).replaceAll('\\', '/')), ['apps/alpha', 'apps/alpha/nested', 'labs/prototype']);
});

test('service preserves local-only catalog until an owner Notion snapshot is injected', t => {
  const { service } = fixture(t);
  const before = service.status();
  assert.equal(before.notionSource.available, false);
  assert.equal(before.summary.localOnly, 2);
  const saved = service.saveNotionSnapshot({
    version: 'notion-v1',
    capturedAt: '2026-08-15T05:00:00.000Z',
    projects: [{ projectId: 'alpha', title: 'Alpha', lifecycle: 'building', priority: { rank: 10, updatedAt: '2026-08-15T05:00:00.000Z' } }],
    ideas: [{ uniqueId: 'idea-001', pageId: '11111111-1111-1111-1111-111111111111', title: 'Idea', lifecycle: 'idea', priority: { rank: 20, updatedAt: '2026-08-15T05:00:00.000Z' } }]
  });
  assert.equal(saved.projects, 1);
  const after = service.status();
  assert.equal(after.notionSource.available, true);
  assert.equal(after.summary.drift, 1);
  assert.equal(after.summary.notionOnly, 1);
});

test('priority reorder is previewed, confirmed once, and completes only after a verified remote snapshot', t => {
  const { service } = fixture(t);
  service.saveNotionSnapshot({
    version: 'notion-v1',
    capturedAt: '2026-08-15T05:00:00.000Z',
    projects: [{ projectId: 'alpha', title: 'Alpha', lifecycle: 'building', priority: { rank: 10, updatedAt: '2026-08-15T05:00:00.000Z' } }],
    ideas: []
  });
  const preview = service.previewPriority({ projectId: 'alpha', desiredRank: 5, expectedRemoteVersion: 'notion-v1' });
  assert.equal(preview.externalWritePerformed, false);
  const queued = service.confirmPriority(preview.confirmationToken);
  assert.equal(queued.operation.state, 'PENDING_SYNC');
  assert.equal(queued.externalWritePerformed, false);
  assert.throws(() => service.confirmPriority(preview.confirmationToken), error => error.code === 'confirmation_invalid');
  assert.equal(service.listPriorityOperations().operations[0].state, 'PENDING_SYNC');
  const prepared = service.preparePrioritySync({ operationId: queued.operation.operationId, remoteVersion: 'notion-v1', workerId: 'notion-connector' });
  assert.equal(prepared.operation.state, 'SYNCING');
  assert.equal(prepared.request.desiredRank, 5);
  assert.equal(prepared.externalWritePerformed, false);
  const snapshot = {
    version: 'notion-v2',
    capturedAt: '2026-08-15T05:05:00.000Z',
    projects: [{ projectId: 'alpha', title: 'Alpha', lifecycle: 'building', priority: { rank: 5, updatedAt: '2026-08-15T05:05:00.000Z' } }],
    ideas: []
  };
  const completed = service.completePrioritySync({ operationId: queued.operation.operationId, snapshot });
  assert.equal(completed.operation.state, 'APPLIED');
  assert.equal(completed.snapshot.version, 'notion-v2');
  assert.equal(completed.externalWritePerformed, false);
  assert.equal(service.status().priorityOutbox.applied, 1);
  assert.equal(service.notionSnapshot().version, 'notion-v2');
  const duplicate = service.completePrioritySync({ operationId: queued.operation.operationId, snapshot });
  assert.equal(duplicate.duplicate, true);
});

test('failed connector attempt returns a syncing priority operation to the durable pending queue', t => {
  const { service } = fixture(t);
  service.saveNotionSnapshot({
    version: 'notion-v1', capturedAt: '2026-08-15T05:00:00.000Z',
    projects: [{ projectId: 'alpha', priority: { rank: 10 } }], ideas: []
  });
  const preview = service.previewPriority({ projectId: 'alpha', desiredRank: 5, expectedRemoteVersion: 'notion-v1' });
  const queued = service.confirmPriority(preview.confirmationToken);
  service.preparePrioritySync({ operationId: queued.operation.operationId, remoteVersion: 'notion-v1', workerId: 'notion-connector' });
  const failed = service.recordPrioritySyncFailure({ operationId: queued.operation.operationId, errorCode: 'notion_transport_failed' });
  assert.equal(failed.operation.state, 'PENDING_SYNC');
  assert.equal(failed.operation.lastErrorCode, 'notion_transport_failed');
  assert.equal(failed.externalWritePerformed, false);
});

test('project catalog owner state root rejects symlinks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-project-service-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, 'projects');
  fs.mkdirSync(path.join(projectsRoot, 'alpha', '.git'), { recursive: true });
  fs.writeFileSync(path.join(projectsRoot, 'README.md'), '# fixture\n');
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  const linked = path.join(root, 'linked');
  fs.symlinkSync(target, linked);
  assert.throws(
    () => new ProjectCatalogService({ projectsRoot, root: linked }),
    error => error.code === 'state_symlink_denied'
  );
});
