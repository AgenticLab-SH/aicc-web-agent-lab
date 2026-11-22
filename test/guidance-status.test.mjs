import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { guidanceStatus, guidanceStatusQuick } from '../src/adapters/guidance-status.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isolatedGuidanceRoot(t) {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-guidance-report-')));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'source');
  const home = path.join(fixture, 'home');
  for (const relative of ['guidance/skills', 'guidance/directives', 'tools/platform/test']) {
    fs.mkdirSync(path.join(root, relative), { recursive: true });
  }
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, 'tools/platform/test/Test-AiccGuidance.ps1'), '# fixture\n');
  return { root, home, guidanceRoot: root };
}

test('guidance status reports a clean deployment', t => {
  const status = guidanceStatus({
    ...isolatedGuidanceRoot(t),
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({
        ok: true, failed_count: 0, check_count: 4,
        checks: [
          { name: 'skills', result: { central_skill_count: 16, deployment_issue_count: 0, manifest_issue_count: 0 } },
          { name: 'agents', result: { agent_count: 1, deployment_issue_count: 0, manifest_issue_count: 0 } }
        ]
      })
    })
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.skillCount, 16);
  assert.equal(status.agentCount, 1);
});

test('guidance status reports deployment drift without throwing', t => {
  const status = guidanceStatus({
    ...isolatedGuidanceRoot(t),
    spawnSync: () => ({
      status: 1,
      stdout: JSON.stringify({
        ok: false, failed_count: 1, check_count: 4,
        checks: [
          { name: 'skills', result: { central_skill_count: 16, deployment_issue_count: 2, manifest_issue_count: 0 } },
          { name: 'agents', result: { agent_count: 1, deployment_issue_count: 0, manifest_issue_count: 0 } }
        ]
      })
    })
  });
  assert.equal(status.state, 'attention');
  assert.match(status.detail, /불일치/);
  assert.equal(status.deploymentIssues, 2);
});

test('quick guidance status verifies source and deployed hashes without PowerShell', t => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-guidance-quick-')));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'AICC');
  const home = path.join(fixture, 'home');
  const content = 'fixture\n';
  const digest = createHash('sha256').update(content).digest('hex').toUpperCase();
  fs.mkdirSync(path.join(root, 'tools', 'platform', 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'platform', 'test', 'Test-AiccGuidance.ps1'), '# fixture\n');
  for (const group of ['codex']) {
    const source = path.join(root, 'guidance', 'skills', 'fixture-skill', 'SKILL.md');
    const target = path.join(home, `.${group}`, 'skills', 'fixture-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(source, content);
    fs.writeFileSync(target, content);
    fs.writeFileSync(path.join(home, `.${group}`, 'skills', '.aicc-guidance-deployment.json'), JSON.stringify({
      schema_version: 1, target_group: group, aicc_root: root,
      managed_skills: [{ name: 'fixture-skill', files: [{ path: 'SKILL.md', sha256: digest }] }]
    }));
  }
  for (const [source, target] of [
    ['guidance/directives/generated/codex/AGENTS.md', '.codex/AGENTS.md']
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, source)), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(home, target)), { recursive: true });
    fs.writeFileSync(path.join(root, source), content);
    fs.writeFileSync(path.join(home, target), content);
  }
  assert.equal(guidanceStatusQuick({ root, home }).state, 'ready');
  fs.writeFileSync(path.join(home, '.codex', 'skills', 'fixture-skill', 'SKILL.md'), 'drift\n');
  assert.equal(guidanceStatusQuick({ root, home }).state, 'attention');
});

test('relocated runtime resolves the exact common guidance root from owner manifests', t => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-guidance-relocated-')));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const sourceRoot = path.join(fixture, 'source');
  const runtimeRoot = path.join(fixture, 'sealed-runtime');
  const home = path.join(fixture, 'home');
  const content = 'fixture\n';
  const digest = createHash('sha256').update(content).digest('hex').toUpperCase();
  for (const required of ['guidance/skills', 'guidance/directives', 'tools/platform/test']) fs.mkdirSync(path.join(sourceRoot, required), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'tools/platform/test/Test-AiccGuidance.ps1'), '# fixture\n');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  for (const group of ['codex', 'claude']) {
    const source = path.join(sourceRoot, 'guidance', 'skills', 'fixture-skill', 'SKILL.md');
    const target = path.join(home, `.${group}`, 'skills', 'fixture-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(source, content);
    fs.writeFileSync(target, content);
    fs.writeFileSync(path.join(home, `.${group}`, 'skills', '.aicc-guidance-deployment.json'), JSON.stringify({
      schema_version: 1, target_group: group, aicc_root: sourceRoot,
      managed_skills: [{ name: 'fixture-skill', files: [{ path: 'SKILL.md', sha256: digest }] }]
    }));
  }
  for (const [source, target] of [
    ['guidance/directives/generated/codex/AGENTS.md', '.codex/AGENTS.md'],
    ['guidance/directives/generated/claude/CLAUDE.md', '.claude/CLAUDE.md']
  ]) {
    fs.mkdirSync(path.dirname(path.join(sourceRoot, source)), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(home, target)), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, source), content);
    fs.writeFileSync(path.join(home, target), content);
  }
  const result = guidanceStatusQuick({ root: runtimeRoot, home });
  assert.equal(result.state, 'ready');
  assert.equal(result.canonicalRootSource, 'deployment-manifests');
});

test('conflicting Codex and Claude manifest roots fail closed', t => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-guidance-conflict-')));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const runtimeRoot = path.join(fixture, 'runtime');
  const home = path.join(fixture, 'home');
  fs.mkdirSync(runtimeRoot);
  for (const [group, root] of [['codex', '/fixture/a'], ['claude', '/fixture/b']]) {
    const directory = path.join(home, `.${group}`, 'skills');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, '.aicc-guidance-deployment.json'), JSON.stringify({ schema_version: 1, target_group: group, aicc_root: root }));
  }
  const result = guidanceStatusQuick({ root: runtimeRoot, home });
  assert.equal(result.state, 'attention');
  assert.match(result.detail, /guidance_manifest_root_conflict/);
});
