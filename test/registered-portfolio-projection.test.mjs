import assert from 'node:assert/strict';
import test from 'node:test';
import { projectPortfolioDevelopmentState } from '../src/projects/registered-portfolio-projection.mjs';

const baseline = {
  projects: {
    'ai-platform': {
      local: {
        projectId: 'ai-platform',
        title: 'AI Platform',
        canonicalRoot: 'C:/old/ai-platform',
        repository: 'https://github.com/AgenticLab-SH/ai-platform-private.git',
        serviceUrl: null
      }
    }
  }
};

const report = {
  project_count: 4,
  error_count: 0,
  warning_count: 3,
  projects: [
    {
      id: 'ai-platform',
      role: 'source',
      path: 'C:/demo/projects/ai-platform',
      git_root: 'C:/demo/projects/ai-platform',
      canonical_repo: 'AgenticLab-SH/ai-platform-private',
      dirty_files: 25,
      ahead: 0,
      behind: 0
    },
    {
      id: 'open-aicc',
      role: 'source',
      path: 'C:/demo/open-AICC',
      git_root: 'C:/demo/open-AICC',
      canonical_repo: 'AgenticLab-SH/aicc-web-agent-lab',
      dirty_files: 168,
      ahead: 0,
      behind: 0
    },
    {
      id: 'open-aicc--wt--desktop',
      role: 'worktree',
      path: 'C:/demo/worktrees/open-aicc-desktop',
      git_root: 'C:/demo/worktrees/open-aicc-desktop',
      canonical_repo: 'AgenticLab-SH/aicc-web-agent-lab',
      dirty_files: 1
    },
    {
      id: 'open-aicc--wt--recovery',
      role: 'worktree',
      path: 'C:/demo/worktrees/open-aicc-recovery',
      git_root: 'C:/demo/worktrees/open-aicc-recovery',
      canonical_repo: 'AgenticLab-SH/aicc-web-agent-lab',
      dirty_files: 0
    }
  ]
};

test('registered portfolio projects only canonical source rows into development sync', () => {
  const result = projectPortfolioDevelopmentState({
    report,
    baseline,
    notionRecords: [{ '프로젝트 ID': 'open-aicc', 프로젝트: 'AICC Workspace' }]
  });
  assert.equal(result.localProjects.length, 2);
  const ai = result.localProjects.find(item => item.projectId === 'ai-platform');
  assert.equal(ai.title, 'AI Platform');
  assert.equal(ai.canonicalRoot, 'C:/demo/projects/ai-platform');
  assert.equal(ai.repository, 'https://github.com/AgenticLab-SH/ai-platform-private');

  const aicc = result.localProjects.find(item => item.projectId === 'open-aicc');
  assert.equal(aicc.title, 'AICC Workspace');
  assert.equal(aicc.canonicalRoot, 'C:/demo/open-AICC');

  assert.equal(result.portfolioSummary.registeredCount, 4);
  assert.equal(result.portfolioSummary.sourceCount, 2);
  assert.equal(result.portfolioSummary.worktreeCount, 2);
  assert.equal(result.portfolioSummary.dirtyRegisteredCount, 3);

  const aiccSummary = result.portfolioSummary.projects.find(item => item.projectId === 'open-aicc');
  assert.equal(aiccSummary.registeredWorktreeCount, 3);
  assert.equal(aiccSummary.dirtyWorktreeCount, 2);
  assert.equal(aiccSummary.dirtyFiles, 169);
});
