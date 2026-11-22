import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skillRoot = path.join(root, 'guidance', 'skills', 'review-agent-platform-updates');

test('agent platform update review is stale-aware at task entry, active for Codex, and unscheduled', () => {
  const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const metadata = fs.readFileSync(path.join(skillRoot, 'agents', 'openai.yaml'), 'utf8');
  const runner = fs.readFileSync(path.join(skillRoot, 'scripts', 'knowledge-review.mjs'), 'utf8');
  const catalog = fs.readFileSync(path.join(root, 'guidance', 'config', 'agent-catalog.toml'), 'utf8');
  assert.match(skill, /마지막 성공이 7일을 \*\*초과\*\*/);
  assert.match(skill, /status`만 먼저 실행/);
  assert.match(skill, /모두 current면 preview와 run 없이 끝낸다/);
  assert.match(skill, /실패 source의 마지막 성공은/);
  assert.match(skill, /scheduler를 만들지 않는다/);
  assert.match(skill, /자동 적용하지 않는다/);
  assert.match(skill, /openai-developer-blog/);
  assert.match(skill, /anthropic-claude-blog/);
  assert.match(metadata, /allow_implicit_invocation: true/);
  assert.match(catalog, /active_skills = \[[^\n]*"review-agent-platform-updates"/);
  assert.match(runner, /\/api\/knowledge-review\/jobs/);
  assert.match(runner, /aicc-local-scheduler/);
  assert.match(runner, /src', 'local-scheduler\.mjs/);
  assert.match(runner, /src', 'bootstrap\.mjs/);
  assert.match(runner, /windowsHide: true/);
  assert.doesNotMatch(runner, /\.runOnce\(/);
});

test('agent platform baseline records official evidence and vendor ownership boundaries', () => {
  const baseline = fs.readFileSync(path.join(root, 'docs', 'agent-platform-baseline.md'), 'utf8');
  assert.match(baseline, /https:\/\/openai\.com\/index\/running-codex-safely\//);
  assert.match(baseline, /https:\/\/code\.claude\.com\/docs\/en\/features-overview/);
  assert.match(baseline, /codex-app-tools@openai-bundled/);
  assert.match(baseline, /node_repl/);
});
