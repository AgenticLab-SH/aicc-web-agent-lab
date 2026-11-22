import assert from 'node:assert/strict';
import test from 'node:test';
import { planDevelopmentWipWarnings } from '../src/projects/development-wip-warnings.mjs';

const projectUrl = id => `https://app.notion.com/p/${id.padEnd(32, '0')}`;
const projects = [
  { '프로젝트 ID': 'ai-platform', url: projectUrl('1'), '전략 분류': '집중', 'date:마지막 확인일:start': '2026-09-20' },
  { '프로젝트 ID': 'open-aicc', url: projectUrl('2'), '전략 분류': '집중', '상위 프로젝트': [projectUrl('1')], 'date:마지막 확인일:start': '2026-09-20' },
  { '프로젝트 ID': 'skct-practice', url: projectUrl('3'), '전략 분류': '집중', 'date:마지막 확인일:start': '2026-09-20' },
  { '프로젝트 ID': 'web', url: projectUrl('4'), '전략 분류': '집중', 'date:마지막 확인일:start': '2026-09-20' },
  { '프로젝트 ID': 'archive-candidate', url: projectUrl('5'), '전략 분류': '보관 검토', 'date:마지막 확인일:start': '2026-09-20' }
];

const report = {
  projects: [
    { id: 'open-aicc', role: 'source', canonical_repo: 'AgenticLab-SH/aicc-web-agent-lab', dirty_files: 10, head_date: '2026-09-25T00:00:00Z' },
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `open-aicc--wt--${index}`, role: 'worktree', canonical_repo: 'AgenticLab-SH/aicc-web-agent-lab',
      dirty_files: index < 3 ? 1 : 0, head_date: '2026-09-24T00:00:00Z'
    })),
    { id: 'archive-candidate', role: 'source', canonical_repo: 'AgenticLab-SH/archive-candidate', dirty_files: 0, head_date: '2026-09-25T00:00:00Z' }
  ]
};

test('WIP planner emits evidence-only warnings and uses explicit focused program grouping', () => {
  const tasks = Array.from({ length: 4 }, (_, index) => ({
    '작업 ID': `t-${index}`, 상태: '진행 중', '코드 단계': '운영', 프로젝트: [projectUrl('2')]
  }));
  const result = planDevelopmentWipWarnings({
    portfolioReport: report,
    projectRecords: projects,
    taskRecords: tasks,
    previousState: { dirtyFirstSeenByItemId: { 'open-aicc': '2026-09-10T00:00:00Z' } },
    observedAt: '2026-09-25T00:00:00Z',
    policy: { focusProgramGroups: [{ id: 'ai-control-plane', members: ['ai-platform', 'open-aicc'] }] }
  });
  assert.equal(result.externalWritePerformed, false);
  assert.equal(result.mutationPerformed, false);
  assert.equal(result.summary.focusProgramCount, 3);
  assert.ok(result.warnings.some(item => item.code === 'DIRTY_AGING' && item.projectId === 'open-aicc'));
  assert.ok(result.warnings.some(item => item.code === 'TASK_OVERLOAD' && item.projectId === 'open-aicc'));
  assert.ok(result.warnings.some(item => item.code === 'WORKTREE_OVERLOAD' && item.projectId === 'open-aicc'));
  assert.ok(result.warnings.some(item => item.code === 'GIT_NEWER_THAN_NOTION' && item.projectId === 'open-aicc'));
  assert.ok(result.warnings.some(item => item.code === 'ARCHIVE_REVIEW_NEW_COMMIT' && item.projectId === 'archive-candidate'));
  assert.equal(result.warnings.some(item => item.code === 'FOCUS_PROGRAM_OVERLOAD'), false);
});

test('first dirty observation seeds age without falsely claiming seven days', () => {
  const result = planDevelopmentWipWarnings({
    portfolioReport: { projects: [{ id: 'alpha', role: 'source', canonical_repo: 'x/alpha', dirty_files: 1 }] },
    projectRecords: [{ '프로젝트 ID': 'alpha', url: projectUrl('6') }],
    taskRecords: [],
    observedAt: '2026-09-25T00:00:00Z'
  });
  assert.equal(result.warnings.some(item => item.code === 'DIRTY_AGING'), false);
  assert.equal(result.nextState.dirtyFirstSeenByItemId.alpha, '2026-09-25T00:00:00.000Z');
});

test('clean observation clears dirty aging state', () => {
  const result = planDevelopmentWipWarnings({
    portfolioReport: { projects: [{ id: 'alpha', role: 'source', canonical_repo: 'x/alpha', dirty_files: 0 }] },
    projectRecords: [{ '프로젝트 ID': 'alpha', url: projectUrl('6') }],
    taskRecords: [],
    previousState: { dirtyFirstSeenByItemId: { alpha: '2026-09-01T00:00:00Z' } },
    observedAt: '2026-09-25T00:00:00Z'
  });
  assert.deepEqual(result.nextState.dirtyFirstSeenByItemId, {});
});

test('date-only Notion verification suppresses same-calendar-day Git noise', () => {
  const result = planDevelopmentWipWarnings({
    portfolioReport: { projects: [{ id: 'alpha', role: 'source', canonical_repo: 'x/alpha', dirty_files: 0, head_date: '2026-09-25T18:00:00+09:00' }] },
    projectRecords: [{ '프로젝트 ID': 'alpha', url: projectUrl('8'), 'date:마지막 확인일:start': '2026-09-25' }],
    taskRecords: [],
    observedAt: '2026-09-25T09:00:00Z'
  });
  assert.equal(result.warnings.some(item => item.code === 'GIT_NEWER_THAN_NOTION'), false);
});

test('focused axes warn only when distinct program roots exceed threshold', () => {
  const extra = { '프로젝트 ID': 'extra-focus', url: projectUrl('7'), '전략 분류': '집중' };
  const result = planDevelopmentWipWarnings({
    portfolioReport: { projects: [] },
    projectRecords: [...projects, extra],
    taskRecords: [],
    observedAt: '2026-09-25T00:00:00Z',
    policy: { focusProgramGroups: [{ id: 'ai-control-plane', members: ['ai-platform', 'open-aicc'] }] }
  });
  const focus = result.warnings.find(item => item.code === 'FOCUS_PROGRAM_OVERLOAD');
  assert.equal(result.summary.focusProgramCount, 4);
  assert.equal(focus.evidence.threshold, 3);
});
