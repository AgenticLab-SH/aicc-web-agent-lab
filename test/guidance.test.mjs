import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findGuidanceWorkflows, guidanceCommands, runGuidance } from '../src/guidance.mjs';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
test('guidance help never invokes deployment or touches agent homes', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-guidance-help-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const marker = path.join(home, 'preserved.txt'); fs.writeFileSync(marker, 'unchanged');
  for (const args of [['deploy', '--help'], ['deploy', '-h'], ['help'], ['--help']]) {
    const result = spawnSync(process.execPath, [path.join(repo, 'bin/aicc'), 'guidance', ...args], {
      cwd: repo, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: '' }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /aicc guidance plan\|deploy\|check/);
    assert.doesNotMatch(result.stdout, /deployed_skills|retired_skill_count/);
    assert.deepEqual(fs.readdirSync(home), ['preserved.txt']);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'unchanged');
  }
});
test('browser guidance separates declared routing from live identity and expiring plans', () => {
  const surface = fs.readFileSync(path.join(repo, 'guidance/skills/use-web-gpt/references/surface-selection.md'), 'utf8');
  const telegram = fs.readFileSync(path.join(repo, 'guidance/skills/manage-telegram-bots/SKILL.md'), 'utf8');
  const coordination = fs.readFileSync(path.join(repo, 'guidance/config/coordination.example.toml'), 'utf8');
  assert.match(surface, /일반 Chrome profile과 CDP profile은 별개/);
  assert.match(surface, /읽기 실패만으로 로그인 미완료라고 단정하지/);
  assert.match(surface, /만료 이후 Pro 사용은 실제 권한 재검증/);
  assert.doesNotMatch(surface, /1=default|2=secondary|3=pro/);
  assert.doesNotMatch(telegram, /general persistent 9224/);
  assert.match(coordination, /identity_verification_pending/);
  assert.doesNotMatch(coordination, /manual_login_pending/);
  assert.doesNotMatch(surface + telegram + coordination, /demo-ownerd28|wntlrqpdj|zhdlsqpdj/);
});

test('partial skill deployment preserves test resources and is idempotent', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-skill-resource-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const run = extra => {
    const result = spawnSync('pwsh', ['-NoProfile', '-File',
      path.join(repo, 'tools/platform/core/deploy_active_skills.ps1'),
      '-AiccRoot', repo, '-UserHome', home, '-TargetGroups', 'codex',
      '-SkillNames', 'agentic-website-maker', '-SummaryOnly', '-AsJson', ...extra],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const target = path.join(home, '.agents/skills/agentic-website-maker');
  assert.equal(run(['-Plan']).dry_run, true);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(run([]).deployed_skills, ['agentic-website-maker']);
  for (const relative of ['SKILL.md', 'scripts/site_ops.py', 'tests/test_site_ops.py']) {
    assert.deepEqual(fs.readFileSync(path.join(target, relative)),
      fs.readFileSync(path.join(repo, 'guidance/skills/agentic-website-maker', relative)));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(home, '.agents/skills/.aicc-guidance-deployment.json')));
  assert.ok(manifest.managed_skills.find(s => s.name === 'agentic-website-maker')
    .files.some(f => f.path === 'tests/test_site_ops.py'));
  assert.deepEqual(run([]).deployed_skills, []);
});

test('skill-root migration retires only verified manifest-owned legacy copies', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-skill-migration-'));
  const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-skill-catalog-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(catalogDir, { recursive: true, force: true }));
  const oldCatalog = path.join(catalogDir, 'old.toml');
  const newCatalog = path.join(catalogDir, 'new.toml');
  const header = `[deployment_policy]\ndefault_groups = ["codex"]\noptional_mode = "explicit"\nmanifest_name = ".aicc-guidance-deployment.json"\nlegacy_manifest_names = []\nprune_policy = "manifest-owned-only"\n\n[[deployment_targets]]\nid = "codex"\ndefault = true\n`;
  fs.writeFileSync(oldCatalog, `${header}skills = [".codex/skills"]\nactive_skills = ["develop-from-project-spec"]\nrules = [".codex/AGENTS.md"]\ngenerated = ["guidance/directives/generated/codex/AGENTS.md"]\n`);
  fs.writeFileSync(newCatalog, `${header}skills = [".agents/skills"]\nlegacy_skills = [".codex/skills"]\nactive_skills = ["develop-from-project-spec"]\nrules = [".codex/AGENTS.md"]\ngenerated = ["guidance/directives/generated/codex/AGENTS.md"]\n`);
  const deploy = catalog => spawnSync('pwsh', ['-NoProfile', '-File',
    path.join(repo, 'tools/platform/core/deploy_active_skills.ps1'),
    '-AiccRoot', repo, '-UserHome', home, '-CatalogPath', catalog,
    '-SkillNames', 'develop-from-project-spec', '-PruneManaged', '-SummaryOnly', '-AsJson'],
  { encoding: 'utf8', windowsHide: true, timeout: 60000 });

  const first = deploy(oldCatalog);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const legacyRoot = path.join(home, '.codex', 'skills');
  fs.mkdirSync(path.join(legacyRoot, 'unmanaged-user-skill'), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'unmanaged-user-skill', 'SKILL.md'), 'user-owned\n');

  const migrated = deploy(newCatalog);
  assert.equal(migrated.status, 0, migrated.stderr || migrated.stdout);
  const report = JSON.parse(migrated.stdout);
  assert.deepEqual(report.legacy_retired_skills, ['develop-from-project-spec']);
  assert.equal(fs.existsSync(path.join(home, '.agents', 'skills', 'develop-from-project-spec', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(legacyRoot, 'develop-from-project-spec')), false);
  assert.equal(fs.readFileSync(path.join(legacyRoot, 'unmanaged-user-skill', 'SKILL.md'), 'utf8'), 'user-owned\n');
});

test('guidance deploy generates directives before pruning managed skills', () => {
  const commands = guidanceCommands('deploy', '/fixture/aicc');
  assert.equal(commands.length, 2);
  assert.match(commands[0].args.join(' '), /deploy_directives\.ps1/);
  assert.match(commands[1].args.join(' '), /deploy_active_skills\.ps1/);
  assert.ok(commands[1].args.includes('-PruneManaged'));
  assert.ok(commands[0].args.includes('-PruneOptionalTargets'));
  assert.ok(commands[1].args.includes('-PruneOptionalTargets'));
});

test('explicit guidance target deploys only that target without pruning others', () => {
  const commands = guidanceCommands('deploy', '/fixture/aicc', { target: 'claude' });
  for (const command of commands) {
    assert.deepEqual(command.args.slice(command.args.indexOf('-TargetGroups'), command.args.indexOf('-TargetGroups') + 2), ['-TargetGroups', 'claude']);
    assert.ok(!command.args.includes('-PruneOptionalTargets'));
  }
  const check = guidanceCommands('check', '/fixture/aicc', { target: 'claude' })[0];
  assert.deepEqual(check.args.slice(check.args.indexOf('-TargetGroups'), check.args.indexOf('-TargetGroups') + 2), ['-TargetGroups', 'claude']);
  assert.throws(() => guidanceCommands('plan', '/fixture/aicc', { target: 'claude', allTargets: true }), /함께 사용할 수 없습니다/);
});

test('guidance runner stops after the first failed gate', () => {
  let calls = 0;
  assert.throws(() => runGuidance('deploy', {
    root: '/fixture/aicc',
    stdio: 'pipe',
    spawnSync: () => {
      calls += 1;
      return { status: 7 };
    }
  }), /exit 7/);
  assert.equal(calls, 1);
});

test('unknown guidance action fails closed', () => {
  assert.throws(() => guidanceCommands('remove', '/fixture/aicc'), /알 수 없는 guidance 명령/);
});

test('cold guidance search returns bounded metadata without registering skills', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-guidance-find-'));
  try {
    const skillRoot = path.join(root, 'guidance', 'skills');
    fs.mkdirSync(path.join(skillRoot, 'exact-workflow'), { recursive: true });
    fs.mkdirSync(path.join(skillRoot, 'body-match'), { recursive: true });
    fs.mkdirSync(path.join(root, 'guidance', 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'guidance', 'config', 'agent-catalog.toml'), `[[deployment_targets]]
id = "codex"
active_skills = ["exact-workflow"]
`);
    fs.writeFileSync(path.join(skillRoot, 'exact-workflow', 'SKILL.md'), '---\nname: exact-workflow\ndescription: Focused MCP review.\n---\n\n# Exact\n\nContinue with $body-match; ignore $false and $exact-workflow.\n');
    fs.writeFileSync(path.join(skillRoot, 'body-match', 'SKILL.md'), '---\nname: body-match\ndescription: Narrow fallback.\n---\n\nUse this for MCP review.\n');

    const result = findGuidanceWorkflows('MCP review', { root, limit: 1 });
    assert.equal(result.count, 1);
    assert.equal(result.total, 2);
    assert.equal(result.matches[0].name, 'exact-workflow');
    assert.equal(result.matches[0].delivery, 'active');
    assert.equal(result.matches[0].invocation, 'implicit');
    assert.deepEqual(result.matches[0].handoffs, ['body-match']);
    assert.deepEqual(Object.keys(result.matches[0]), ['name', 'description', 'delivery', 'invocation', 'handoffs', 'path']);
    assert.throws(() => findGuidanceWorkflows('', { root }), /검색어가 필요/);
    assert.throws(() => findGuidanceWorkflows('MCP', { root, limit: 21 }), /1~20/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Korean guidance search finds substantial intent work and rejects weak tiny-fix matches', () => {
  const substantial = findGuidanceWorkflows('새롭고 여러 영역에 걸친 기능을 설계하고 구현', { root: repo });
  assert.equal(substantial.matches[0]?.name, 'develop-from-project-spec');

  const tiny = findGuidanceWorkflows('오타 한 글자 수정', { root: repo });
  assert.equal(tiny.matches.some(match => match.name === 'develop-from-project-spec'), false);
  assert.equal(tiny.matches.some(match => match.name === 'generate-images-with-web-gpt'), false);
});

test('canonical Web GPT guidance keeps the entry lean and routes conditional local-access detail', () => {
  const skill = fs.readFileSync(new URL('../guidance/skills/use-web-gpt/SKILL.md', import.meta.url), 'utf8');
  const contract = fs.readFileSync(new URL('../guidance/skills/use-web-gpt/references/execution-contract.md', import.meta.url), 'utf8');
  assert.match(skill, /저장소 전체·대화 원문.*보내지 않는다/);
  assert.match(skill, /route 상태.*관련될 때만.*execution-contract\.md/s);
  assert.match(contract, /승인한 root와 도구 안에서만/);
  assert.match(contract, /exact-root `grant_ref`/);
  assert.match(contract, /별도 일회용 approval/);
  assert.match(contract, /별도 편의 alias로 이 경계를 우회하지 않는다/);
  assert.match(contract, /`runtimeReady`와.*write schema를 같은.*보지 않는다/s);
  assert.match(skill, /인위적인 최소 전송 간격을 두지 않는다/);
  assert.match(contract, /정상 상태의 account\/global submit 하한은 0초/);
  assert.match(contract, /명시적 provider pause는 15초부터 최대 60초.*성공 1회.*즉시 해제/s);
  assert.match(contract, /prompt,.*응답, URL, cookie.*session 원문/s);
  assert.match(contract, /`submission_uncertain`.*조용히 재시도하지 않는다/s);
});

test('repository instructions stay compact and route detail instead of duplicating it', () => {
  const instructions = fs.readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
  assert.ok(Buffer.byteLength(instructions) <= 1024);
  assert.ok(instructions.split(/\r?\n/).length <= 10);
  for (const required of [
    'docs/agent-operations.md',
    'public core',
    'guidance/',
    'deploy-only',
    '127.0.0.1',
    'single writer',
    'Workspace MCP',
    'fake runners'
  ]) assert.match(instructions, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('operations map exposes the cold-workflow lookup without inflating AGENTS.md', () => {
  const operations = fs.readFileSync(new URL('../docs/agent-operations.md', import.meta.url), 'utf8');
  const instructions = fs.readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
  assert.match(operations, /aicc guidance find '<intent>'/);
  assert.doesNotMatch(instructions, /aicc guidance find/);
});

test('coordination reader resolves one Web GPT role without returning the private file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-coordination-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'coordination.toml');
  fs.writeFileSync(file, `[browser]
web_gpt_default_account_alias = "default-account"
web_gpt_default_workspace = "default-workspace"
web_gpt_pro_account_alias = "pro-account"
web_gpt_pro_workspace = "pro-workspace"
web_gpt_pro_policy = "review"
private_unrelated_secret = "must-not-return"
`);
  const script = path.resolve('tools/platform/core/Read-AiccCoordination.ps1');
  const result = spawnSync('pwsh', ['-NoProfile', '-File', script, '-WebGptRole', 'pro', '-Path', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    role: 'pro', accountAlias: 'pro-account', workspaceAlias: 'pro-workspace', policy: 'review'
  });
  assert.doesNotMatch(result.stdout, /must-not-return|default-account/);
});
