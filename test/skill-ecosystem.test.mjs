import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCatalog, findProjectSkillFiles, parseSkill, renderMarkdown } from '../tools/platform/inspect/inspect-skill-ecosystem.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function skill(root, relative, name, description, body = '') {
  const file = path.join(root, relative, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  return file;
}

test('multiline descriptions are measured without consuming the next metadata field', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-multiline-skill-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const marker of ['|', '>-']) {
    const file = skill(fixture, marker === '|' ? 'literal' : 'folded', 'multiline', `${marker}\n  Draw a diagram.\n  Export SVG when requested.\nmetadata:\n  short-description: Ignore nested metadata.`);
    assert.equal(parseSkill(file).description, 'Draw a diagram. Export SVG when requested.');
  }
});

test('project instruction discovery stays outside dependency and retained-history directories', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-project-guidance-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const write = relative => {
    const file = path.join(fixture, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'Keep project scope.\n');
    return file;
  };
  const root = write('repo/AGENTS.md');
  const nested = write('repo/src/AGENTS.override.md');
  write('repo/node_modules/example/AGENTS.md');
  write('repo/.git/AGENTS.md');
  const instructionFiles = [];
  assert.deepEqual(findProjectSkillFiles([fixture], { instructionFiles }), []);
  assert.deepEqual(instructionFiles.sort(), [root, nested].sort());
});

test('installed skills in different plugin namespaces do not collide by their short name', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-plugin-namespace-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const codex = path.join(fixture, '.codex');
  skill(codex, 'plugins/cache/example/analytics/1.0.0/skills/index', 'index', 'Analyze data.');
  skill(codex, 'plugins/cache/example/design/1.0.0/skills/index', 'index', 'Design a product.');
  const pluginListText = 'Marketplace `example`\nanalytics@example  installed, enabled  1.0.0  /analytics\ndesign@example  installed, enabled  1.0.0  /design\n';
  const catalog = buildCatalog({ aiccRoot: path.join(fixture, 'AICC'), codexHome: codex, pluginListText });
  assert.equal(catalog.summary.effectiveDuplicateNameCount, 0);
  assert.equal(catalog.duplicateNames[0].classification, 'isolated-plugin-namespaces');
  skill(codex, 'plugins/cache/example/design/1.0.0/skills/another-index', 'index', 'Another entry with the same name.');
  assert.throws(() => buildCatalog({ aiccRoot: path.join(fixture, 'AICC'), codexHome: codex, pluginListText }), /Duplicate logical skill ids/);
});

test('skill ecosystem catalogs canonical, delivery, plugin, and project ownership', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-skill-map-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const aicc = path.join(fixture, 'AICC');
  const codex = path.join(fixture, '.codex');
  const agentSkills = path.join(fixture, '.agents', 'skills');
  const projects = path.join(fixture, 'projects');
  skill(aicc, 'guidance/skills/shared', 'shared', 'Canonical shared skill.', 'Use $helper.');
  const explicitSource = skill(aicc, 'guidance/skills/explicit', 'explicit', 'Explicit-only workflow.');
  fs.mkdirSync(path.join(path.dirname(explicitSource), 'agents'), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(explicitSource), 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
  skill(aicc, 'guidance/skills/cold-only', 'cold-only', 'Intentional cold workflow.');
  skill(fixture, '.agents/skills/shared', 'shared', 'Canonical shared skill.', 'Use $helper.');
  const explicitDelivery = skill(fixture, '.agents/skills/explicit', 'explicit', 'Explicit-only workflow.');
  fs.mkdirSync(path.join(path.dirname(explicitDelivery), 'agents'), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(explicitDelivery), 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
  skill(codex, 'skills/.system/helper', 'helper', 'Built in helper.');
  skill(fixture, '.agents/skills/book-to-skill', 'book-to-skill', 'User-managed current skill.');
  skill(codex, 'skills/legacy-helper', 'legacy-helper', 'User-managed legacy skill.');
  skill(codex, 'plugins/cache/example/demo/1.2.3/skills/demo', 'demo', 'Installed plugin skill.');
  skill(codex, 'plugins/cache/aicc-local/shared/0.1.0/skills/shared', 'shared', 'Canonical shared skill.', 'Use $helper.');
  skill(projects, 'app/.agents/skills/local', 'local', 'Project skill.');
  skill(projects, 'app/.venv/lib/site-packages/fake/.agents/skills/ignored', 'ignored', 'Dependency skill.');
  const pluginList = 'Marketplace `example`\nfixture\n\ndemo@example  installed, enabled  1.2.3  /fixture/demo\n';
  const catalog = buildCatalog({ aiccRoot: aicc, codexHome: codex, projectRoots: [projects], pluginListText: pluginList, aiccActiveSkills: ['shared', 'explicit'], now: new Date('2026-08-13T00:00:00Z') });
  assert.equal(catalog.summary.byOwner.aicc, 3);
  assert.equal(catalog.summary.byOwner['codex-system'], 1);
  assert.equal(catalog.summary.byOwner.plugin, 1);
  assert.equal(catalog.summary.byOwner.project, 1);
  assert.equal(catalog.summary.byOwner.user, 2);
  assert.equal(catalog.summary.aiccActiveCount, 2);
  assert.equal(catalog.summary.aiccColdCount, 1);
  assert.equal(catalog.summary.aiccImplicitActiveCount, 1);
  assert.equal(catalog.summary.aiccExplicitOnlyCount, 1);
  assert.equal(catalog.summary.aiccImplicitDescriptionCharacters, 'Canonical shared skill.'.length);
  assert.ok(catalog.summary.aiccDeferredEntryBytes > 0);
  assert.equal(catalog.summary.aiccExactRepeatedInstructionLineGroupCount, 0);
  assert.equal(catalog.summary.unmanagedUserSkillCount, 2);
  assert.equal(catalog.summary.legacyManagedCopyCount, 0);
  assert.equal(catalog.summary.aiccDeliveryIssueCount, 0);
  assert.equal(catalog.summary.effectiveDuplicateNameCount, 0);
  assert.equal(catalog.skills.some(item => item.name === 'ignored'), false);
  assert.equal(catalog.skills.find(item => item.name === 'demo').status, 'installed-enabled');
  assert.deepEqual(catalog.skills.find(item => item.name === 'shared').handoffs, ['helper']);
  assert.equal(catalog.skills.find(item => item.name === 'shared').deliveryPaths.length, 2);
  assert.equal(catalog.skills.find(item => item.name === 'cold-only').status, 'canonical-cold');
  assert.equal(catalog.skills.find(item => item.name === 'book-to-skill').status, 'user-managed');
  assert.equal(catalog.skills.find(item => item.name === 'legacy-helper').status, 'legacy-user-managed');
  assert.equal(catalog.scope.agentSkillsRoot, agentSkills);
  assert.match(renderMarkdown(catalog), /Canonical shared skill/);
});

test('same-name audit separates retained plugin caches and isolated project scopes from effective collisions', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-skill-collisions-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const aicc = path.join(fixture, 'AICC');
  const codex = path.join(fixture, '.codex');
  const projects = path.join(fixture, 'projects');
  skill(codex, 'plugins/cache/example/demo/1.0.0/skills/demo', 'demo', 'Cached plugin skill.');
  skill(codex, 'plugins/cache/example/demo/2.0.0/skills/demo', 'demo', 'Installed plugin skill.');
  skill(projects, 'primary/.agents/skills/local', 'local', 'Primary project skill.');
  skill(projects, '_worktrees/feature/.agents/skills/local', 'local', 'Worktree project skill.');
  const pluginList = 'Marketplace `example`\nfixture\n\ndemo@example  installed, enabled  2.0.0  /fixture/demo\n';
  const catalog = buildCatalog({ aiccRoot: aicc, codexHome: codex, projectRoots: [projects], pluginListText: pluginList });
  assert.deepEqual(catalog.duplicateNames.map(item => [item.name, item.classification]), [
    ['demo', 'retained-plugin-cache'],
    ['local', 'isolated-project-scopes']
  ]);
  assert.equal(catalog.summary.effectiveDuplicateNameCount, 0);
  assert.match(renderMarkdown(catalog), /retained-plugin-cache/);
});

test('a stale managed slot is delivery drift, not a user collision', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-skill-drift-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const aicc = path.join(fixture, 'AICC');
  const codex = path.join(fixture, '.codex');
  skill(aicc, 'guidance/skills/shared', 'shared', 'Current canonical skill.');
  skill(fixture, '.agents/skills/shared', 'shared', 'Stale deployed skill.');
  const catalog = buildCatalog({
    aiccRoot: aicc,
    codexHome: codex,
    pluginListText: '',
    aiccActiveSkills: ['shared']
  });
  assert.equal(catalog.summary.aiccDeliveryIssueCount, 1);
  assert.equal(catalog.summary.unmanagedUserSkillCount, 0);
  assert.equal(catalog.summary.effectiveDuplicateNameCount, 0);
});

test('exact repeated active instructions are review signals, not hidden validator failures', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-skill-lines-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const aicc = path.join(fixture, 'AICC');
  const codex = path.join(fixture, '.codex');
  const repeated = 'Preserve the exact external target and verify the post-read before completion.';
  skill(aicc, 'guidance/skills/one', 'one', 'First workflow.', repeated);
  skill(aicc, 'guidance/skills/two', 'two', 'Second workflow.', repeated);
  const catalog = buildCatalog({
    aiccRoot: aicc,
    codexHome: codex,
    pluginListText: '',
    aiccActiveSkills: ['one', 'two']
  });
  assert.equal(catalog.summary.aiccExactRepeatedInstructionLineGroupCount, 1);
  assert.deepEqual(catalog.contextReview.exactRepeatedInstructionLines[0].occurrences.map(row => row.skill), ['one', 'two']);
});

test('frontmatter parser and project scanner stay bounded', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-skill-parse-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const file = skill(fixture, 'repo/.agent/skills/example', 'example', 'One line description.', 'Use $next-step.');
  assert.deepEqual(parseSkill(file), { name: 'example', description: 'One line description.', handoffs: ['next-step'] });
  assert.deepEqual(findProjectSkillFiles([fixture]), [file]);
});

test('canonical skill descriptions stay lean', () => {
  const skillRoot = path.join(repositoryRoot, 'guidance', 'skills');
  const descriptions = fs.readdirSync(skillRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(skillRoot, entry.name, 'SKILL.md'))
    .filter(file => fs.existsSync(file))
    .map(file => ({ file, ...parseSkill(file) }));
  const missing = descriptions.filter(item => !item.description).map(item => path.basename(path.dirname(item.file)));
  const oversized = descriptions.filter(item => item.description.length > 150)
    .map(item => `${item.name}:${item.description.length}`);
  const totalCharacters = descriptions.reduce((total, item) => total + item.description.length, 0);

  assert.deepEqual(missing, []);
  assert.deepEqual(oversized, []);
  assert.ok(totalCharacters <= 5000, `Skill descriptions use ${totalCharacters} characters; expected at most 5000.`);
});

test('catalog fails closed on duplicate logical ids', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-skill-id-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const aicc = path.join(fixture, 'AICC');
  const codex = path.join(fixture, '.codex');
  const first = path.join(fixture, 'one', 'same');
  const second = path.join(fixture, 'two', 'same');
  skill(first, '.agents/skills/duplicate', 'duplicate', 'First project skill.');
  skill(second, '.agents/skills/duplicate', 'duplicate', 'Second project skill.');
  assert.throws(() => buildCatalog({
    aiccRoot: aicc,
    codexHome: codex,
    projectRoots: [path.join(fixture, 'one'), path.join(fixture, 'two')],
    pluginListText: ''
  }), /Duplicate logical skill ids/);
});
