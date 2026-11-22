import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skillRoot = path.join(root, 'guidance', 'skills', 'develop-from-project-spec');

function runPython(script, args) {
  const result = spawnSync('python', [path.join(skillRoot, 'scripts', script), ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

test('intent workflow is active only for Codex and keeps document roles separate', () => {
  const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const catalog = fs.readFileSync(path.join(root, 'guidance', 'config', 'agent-catalog.toml'), 'utf8');
  const codex = catalog.match(/id = "codex"[\s\S]*?active_skills = \[([^\n]+)\]/)?.[1] ?? '';
  const claude = catalog.match(/id = "claude"[\s\S]*?active_skills = \[([^\n]+)\]/)?.[1] ?? '';

  assert.match(skill, /준비만 요청했다면[\s\S]*제품 구현·서비스 변경을 몰래 시작하지 않는다/);
  assert.match(skill, /구현을 승인했다면 필요한 준비를 보완하고 계속한다/);
  assert.match(skill, /작고 명확한 수정[\s\S]*새 문서 묶음 없음/);
  assert.match(skill, /제품별 정본 유지[\s\S]*중앙은 연결·결정·공통 계약만/);
  assert.match(skill, /기존 FR\/SC ID를 재사용/);
  assert.match(skill, /current는 지금 상태와 다음 행동, spec은 제품 계약, plan\/tasks는 접근·순서·담당/);
  assert.match(skill, /check_intent\.py와 check_project_spec\.py[\s\S]*선택 도구/);
  assert.match(skill, /source 작성만으로[\s\S]*실제 작동·목표 전체 완료를 선언하지 않는다/);
  for (const [, relative] of skill.matchAll(/\]\((references\/[^)#]+)(?:#[^)]*)?\)/g)) {
    assert.ok(fs.existsSync(path.join(skillRoot, relative)), `missing skill reference: ${relative}`);
  }
  assert.match(codex, /"develop-from-project-spec"/);
  assert.doesNotMatch(claude, /"develop-from-project-spec"/);
});

test('intent and linked feature spec validators accept the repository workflow', () => {
  const intent = 'specs/intent-driven-development/intent.md';
  const spec = 'specs/intent-driven-development/spec.md';
  const intentResult = runPython('check_intent.py', [root, intent]);
  assert.equal(intentResult.status, 0, intentResult.output);
  assert.match(intentResult.output, /status (?:accepted|delivered)/);

  const specResult = runPython('check_project_spec.py', [root, '--spec', spec, '--intent', intent]);
  assert.equal(specResult.status, 0, specResult.output);
  assert.match(specResult.output, /7 requirements/);
});

test('intent validator rejects invalid status and unfinished decisions', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-intent-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const target = path.join(fixture, 'intent.md');
  fs.writeFileSync(target, `# Bad intent

- ID: INT-bad
- Status: building
- Owner: owner
- Target: fixture
- Supersedes: none

## Problem
x
## Evidence
x
## Desired outcome
x
## Affected users and systems
x
## Constraints
x
## Out of scope
x
## Success signals
x
## Open questions
None
## Decision
- pending
`);

  const result = runPython('check_intent.py', [fixture, 'intent.md']);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /invalid Status/);
});

test('feature spec validator rejects a mismatched source intent', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-spec-link-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, 'specs', 'change'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'specs', 'change', 'intent.md'), '# fixture');
  const source = fs.readFileSync(path.join(root, 'specs', 'intent-driven-development', 'spec.md'), 'utf8');
  fs.writeFileSync(
    path.join(fixture, 'specs', 'change', 'spec.md'),
    source.replace(
      'Source intent: specs/intent-driven-development/intent.md',
      'Source intent: specs/change/other-intent.md',
    ),
  );

  const result = runPython('check_project_spec.py', [
    fixture,
    '--spec', 'specs/change/spec.md',
    '--intent', 'specs/change/intent.md',
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Source intent must be specs\/change\/intent\.md/);
});
