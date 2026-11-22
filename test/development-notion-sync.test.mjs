import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyDevelopmentSyncChanges,
  completeDevelopmentSync,
  createDevelopmentSyncBaseline,
  developmentSyncOwnerPaths,
  initializeDevelopmentSyncBaseline,
  migrateDevelopmentSyncBaseline,
  planDevelopmentSync,
  prepareDevelopmentSync,
  readDevelopmentSyncBaseline,
  restoreDevelopmentSyncBaseline
} from '../src/projects/development-notion-sync.mjs';

const local = [{ id: 'alpha', title: 'Alpha', canonicalRoot: 'C:/demo/alpha', links: { repository: 'https://example.test/alpha' } }];
const notion = [{ '고유 ID': 'alpha', '이름': 'Alpha', '로컬 정본': 'C:/demo/alpha', GitHub: 'https://example.test/alpha', 상태: '진행 중', 수명주기: '운영', 보관: '__NO__', url: 'https://notion.test/alpha', lastEditedTime: '2026-08-31T00:00:00.000Z' }];
const binding = {
  notionPageUrl: 'https://app.notion.com/p/0123456789abcdef0123456789abcdef',
  notionDataSourceId: '12345678-1234-4123-8123-123456789abc'
};

function fixture(t) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-development-sync-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  return { stateRoot };
}

test('first run creates one owner-local baseline and performs no transport', t => {
  const options = fixture(t);
  const result = prepareDevelopmentSync({ ...options, localProjects: local, notionRecords: notion, binding });
  assert.equal(result.status, 'BASELINE_CREATED');
  assert.equal(result.externalWritePerformed, false);
  assert.deepEqual(result.operations, { localToNotion: [], notionToLocal: [] });
  const saved = readDevelopmentSyncBaseline(options);
  assert.equal(saved.digest, result.baseline.digest);
  assert.equal(fs.existsSync(developmentSyncOwnerPaths(options).baselineFile), true);
});

test('unchanged initial divergence is not replayed after baseline', () => {
  const baseline = createDevelopmentSyncBaseline({ localProjects: local, notionRecords: notion, capturedAt: '2026-08-31T00:00:00.000Z', binding });
  const plan = planDevelopmentSync({ localProjects: local, notionRecords: notion, baseline });
  assert.equal(plan.status, 'IN_SYNC');
  assert.deepEqual(plan.operations, { localToNotion: [], notionToLocal: [] });
});

test('changed local root produces one changed-row Notion patch', () => {
  const baseline = createDevelopmentSyncBaseline({ localProjects: local, notionRecords: notion, capturedAt: '2026-08-31T00:00:00.000Z', binding });
  const changed = [{ ...local[0], canonicalRoot: 'C:/demo/projects/alpha' }];
  const plan = planDevelopmentSync({ localProjects: changed, notionRecords: notion, baseline });
  assert.equal(plan.status, 'READY');
  assert.equal(plan.entries[0].state, 'LOCAL_TO_NOTION');
  assert.deepEqual(plan.operations.localToNotion, [{
    projectId: 'alpha',
    pageUrl: 'https://notion.test/alpha',
    expectedLastEditedTime: '2026-08-31T00:00:00.000Z',
    patch: { canonicalRoot: 'C:/demo/projects/alpha' }
  }]);
  assert.deepEqual(plan.operations.notionToLocal, []);
});

test('changed Notion-owned status produces one changed-row local patch', () => {
  const baseline = createDevelopmentSyncBaseline({ localProjects: local, notionRecords: notion, binding });
  const changed = [{ ...notion[0], 상태: '보류' }];
  const plan = planDevelopmentSync({ localProjects: local, notionRecords: changed, baseline });
  assert.equal(plan.status, 'READY');
  assert.deepEqual(plan.operations.notionToLocal, [{ projectId: 'alpha', patch: { status: '보류' } }]);
  assert.deepEqual(plan.operations.localToNotion, []);
});

test('same field changed differently on both sides stops for review', () => {
  const baseline = createDevelopmentSyncBaseline({ localProjects: local, notionRecords: notion, binding });
  const localChanged = [{ ...local[0], canonicalRoot: 'C:/demo/new-alpha' }];
  const notionChanged = [{ ...notion[0], '로컬 정본': 'D:/alpha' }];
  const plan = planDevelopmentSync({ localProjects: localChanged, notionRecords: notionChanged, baseline });
  assert.equal(plan.status, 'REVIEW_REQUIRED');
  assert.equal(plan.transportBlocked, true);
  assert.deepEqual(plan.entries[0].conflicts, ['canonicalRoot']);
  assert.equal(plan.externalWritePerformed, false);
});

test('changes in both directions stop even when fields differ', async () => {
  const baseline = createDevelopmentSyncBaseline({ localProjects: local, notionRecords: notion, binding });
  const localChanged = [{ ...local[0], canonicalRoot: 'C:/demo/new-alpha' }];
  const notionChanged = [{ ...notion[0], 상태: '보류' }];
  const plan = planDevelopmentSync({ localProjects: localChanged, notionRecords: notionChanged, baseline });
  assert.equal(plan.status, 'REVIEW_REQUIRED');
  assert.equal(plan.entries[0].state, 'BOTH_DIRECTIONS');
  await assert.rejects(() => applyDevelopmentSyncChanges({ plan }), error => error.code === 'review_required');
});

test('ready plan invokes only the exact changed-row writer', async () => {
  const baseline = createDevelopmentSyncBaseline({ localProjects: local, notionRecords: notion, binding });
  const changed = [{ ...local[0], canonicalRoot: 'C:/demo/projects/alpha' }];
  const plan = planDevelopmentSync({ localProjects: changed, notionRecords: notion, baseline });
  const calls = [];
  const result = await applyDevelopmentSyncChanges({ plan, writeNotionRow: operation => calls.push(operation) });
  assert.equal(result.status, 'APPLIED_AWAITING_VERIFICATION');
  assert.equal(result.changedRowsOnly, true);
  assert.deepEqual(calls, plan.operations.localToNotion);
});

test('baseline advances only after post-read shows both sides equal', t => {
  const options = fixture(t);
  const initialized = initializeDevelopmentSyncBaseline({ ...options, localProjects: local, notionRecords: notion, binding });
  const localChanged = [{ ...local[0], canonicalRoot: 'C:/demo/projects/alpha' }];
  assert.throws(() => completeDevelopmentSync({
    ...options,
    localProjects: localChanged,
    notionRecords: notion,
    expectedBaselineDigest: initialized.baseline.digest
  }), error => error.code === 'verification_required');
  const notionAfter = [{ ...notion[0], '로컬 정본': 'C:/demo/projects/alpha' }];
  const completed = completeDevelopmentSync({
    ...options,
    localProjects: localChanged,
    notionRecords: notionAfter,
    expectedBaselineDigest: initialized.baseline.digest,
    capturedAt: '2026-08-31T01:00:00.000Z'
  });
  assert.equal(completed.completed, true);
  assert.equal(fs.existsSync(completed.backupFile), true);
  assert.notEqual(completed.baseline.digest, initialized.baseline.digest);
});

test('restore is dry-run by default and needs exact digest plus confirmation', t => {
  const options = fixture(t);
  const initialized = initializeDevelopmentSyncBaseline({ ...options, localProjects: local, notionRecords: notion, binding });
  const localChanged = [{ ...local[0], canonicalRoot: 'C:/demo/projects/alpha' }];
  const notionAfter = [{ ...notion[0], '로컬 정본': 'C:/demo/projects/alpha' }];
  const completed = completeDevelopmentSync({
    ...options,
    localProjects: localChanged,
    notionRecords: notionAfter,
    expectedBaselineDigest: initialized.baseline.digest
  });
  const preview = restoreDevelopmentSyncBaseline({
    ...options,
    backupFile: completed.backupFile,
    expectedCurrentDigest: completed.baseline.digest,
    dryRun: true
  });
  assert.equal(preview.mutationPerformed, false);
  assert.equal(readDevelopmentSyncBaseline(options).digest, completed.baseline.digest);
  assert.throws(() => restoreDevelopmentSyncBaseline({
    ...options,
    backupFile: completed.backupFile,
    expectedCurrentDigest: completed.baseline.digest
  }), error => error.code === 'restore_confirmation_required');
  const restored = restoreDevelopmentSyncBaseline({
    ...options,
    backupFile: completed.backupFile,
    expectedCurrentDigest: completed.baseline.digest,
    confirm: 'restore-development-sync-baseline'
  });
  assert.equal(restored.mutationPerformed, true);
  assert.equal(readDevelopmentSyncBaseline(options).digest, initialized.baseline.digest);
});

test('explicit migration requires exact digests, dry-run and confirmation', t => {
  const options = fixture(t);
  const initialized = initializeDevelopmentSyncBaseline({ ...options, localProjects: local, notionRecords: notion, binding });
  const betaLocal = { id: 'beta', title: 'Beta', canonicalRoot: 'C:/demo/beta', links: { repository: 'https://example.test/beta' } };
  const betaNotion = { '고유 ID': 'beta', '이름': 'Beta', '로컬 정본': 'C:/demo/beta', GitHub: 'https://example.test/beta', 상태: '완료', 수명주기: '운영', 보관: '__NO__', url: 'https://notion.test/beta' };
  const candidate = createDevelopmentSyncBaseline({ localProjects: [...local, betaLocal], notionRecords: [...notion, betaNotion], binding });
  const paths = developmentSyncOwnerPaths(options);
  const candidateFile = path.join(paths.root, 'baseline-candidate.json');
  fs.writeFileSync(candidateFile, `${JSON.stringify(candidate, null, 2)}\n`);

  const preview = migrateDevelopmentSyncBaseline({
    ...options,
    candidateFile,
    expectedCurrentDigest: initialized.baseline.digest,
    expectedCandidateDigest: candidate.digest,
    dryRun: true
  });
  assert.equal(preview.mutationPerformed, false);
  assert.equal(readDevelopmentSyncBaseline(options).digest, initialized.baseline.digest);

  assert.throws(() => migrateDevelopmentSyncBaseline({
    ...options,
    candidateFile,
    expectedCurrentDigest: initialized.baseline.digest,
    expectedCandidateDigest: candidate.digest
  }), error => error.code === 'migration_confirmation_required');

  assert.throws(() => migrateDevelopmentSyncBaseline({
    ...options,
    candidateFile,
    expectedCurrentDigest: initialized.baseline.digest,
    expectedCandidateDigest: '0'.repeat(64),
    dryRun: true
  }), error => error.code === 'candidate_changed');

  const migrated = migrateDevelopmentSyncBaseline({
    ...options,
    candidateFile,
    expectedCurrentDigest: initialized.baseline.digest,
    expectedCandidateDigest: candidate.digest,
    confirm: 'migrate-development-sync-baseline'
  });
  assert.equal(migrated.mutationPerformed, true);
  assert.equal(migrated.externalWritePerformed, false);
  assert.equal(fs.existsSync(migrated.backupFile), true);
  assert.equal(readDevelopmentSyncBaseline(options).digest, candidate.digest);

  const restorePreview = restoreDevelopmentSyncBaseline({
    ...options,
    backupFile: migrated.backupFile,
    expectedCurrentDigest: candidate.digest,
    dryRun: true
  });
  assert.equal(restorePreview.fromDigest, candidate.digest);
  assert.equal(restorePreview.toDigest, initialized.baseline.digest);
  assert.equal(restorePreview.mutationPerformed, false);
});

test('different existing baseline refuses silent overwrite', t => {
  const options = fixture(t);
  initializeDevelopmentSyncBaseline({ ...options, localProjects: local, notionRecords: notion, binding });
  const changed = [{ ...local[0], canonicalRoot: 'C:/different' }];
  assert.throws(() => initializeDevelopmentSyncBaseline({ ...options, localProjects: changed, notionRecords: notion, binding }), error => error.code === 'baseline_exists');
});

test('owner binding is required for first use and exact identifiers are validated', t => {
  const options = fixture(t);
  assert.throws(() => prepareDevelopmentSync({ ...options, localProjects: local, notionRecords: notion }), error => error.code === 'binding_required');
  assert.throws(() => createDevelopmentSyncBaseline({
    localProjects: local,
    notionRecords: notion,
    binding: { ...binding, notionDataSourceId: '12345678-1234-1234-1234-123456789abc' }
  }), error => error.code === 'binding_invalid');
  assert.throws(() => createDevelopmentSyncBaseline({
    localProjects: local,
    notionRecords: notion,
    binding: { ...binding, notionPageUrl: `${binding.notionPageUrl}?workspace=owner` }
  }), error => error.code === 'binding_invalid');
});


test('current Notion project property names normalize without legacy aliases', () => {
  const current = createDevelopmentSyncBaseline({
    localProjects: [{ id: 'alpha', title: 'Alpha', canonicalRoot: 'C:/demo/alpha', links: { repository: 'https://example.test/alpha' } }],
    notionRecords: [{
      '프로젝트 ID': 'alpha',
      '프로젝트': 'Alpha',
      '로컬 기준 경로': 'C:/demo/alpha',
      GitHub: 'https://example.test/alpha',
      '서비스 주소': 'https://alpha.example.test/',
      상태: '진행 중',
      '운영 단계': '운영',
      메모: 'current schema',
      보관: '__NO__',
      url: 'https://notion.test/alpha'
    }],
    binding
  });
  assert.equal(current.projects.alpha.notion.projectId, 'alpha');
  assert.equal(current.projects.alpha.notion.title, 'Alpha');
  assert.equal(current.projects.alpha.notion.canonicalRoot, 'C:/demo/alpha');
  assert.equal(current.projects.alpha.notion.lifecycle, '운영');
  assert.equal(current.projects.alpha.notion.serviceUrl, 'https://alpha.example.test/');
});
