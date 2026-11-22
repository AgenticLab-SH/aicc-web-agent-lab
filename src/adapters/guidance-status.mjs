import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../lib/command.mjs';
import { resolveGuidanceCheckRoot } from '../guidance-root.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function sameFile(left, right) {
  try { return sha256(left) === sha256(right); }
  catch { return false; }
}

function targetRoots(home, group) {
  if (group === 'codex') return [path.join(home, '.agents', 'skills'), path.join(home, '.codex', 'skills')];
  return [path.join(home, `.${group}`, 'skills')];
}

function defaultGroups(root) {
  try {
    const raw = fs.readFileSync(path.join(root, 'guidance', 'config', 'agent-catalog.toml'), 'utf8');
    const values = raw.match(/^\s*default_groups\s*=\s*\[([^\]]*)\]/m)?.[1] ?? '';
    const groups = [...values.matchAll(/["']([^"']+)["']/g)].map(match => match[1]);
    return groups.length ? groups : ['codex'];
  } catch { return ['codex']; }
}

function quickDeployment(root, home, group) {
  const targetRoot = targetRoots(home, group).find(candidate => (
    fs.existsSync(path.join(candidate, '.aicc-guidance-deployment.json'))
  ));
  if (!targetRoot) throw new Error(`${group} 배포 manifest가 없습니다.`);
  const manifestPath = path.join(targetRoot, '.aicc-guidance-deployment.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema_version !== 1 || manifest.target_group !== group || manifest.aicc_root !== root) {
    throw new Error(`${group} 배포 manifest 소유권이 일치하지 않습니다.`);
  }
  let mismatches = 0;
  for (const skill of manifest.managed_skills ?? []) {
    const files = Array.isArray(skill.files) ? skill.files : skill.files ? [skill.files] : [];
    for (const file of files) {
      const source = path.join(root, 'guidance', 'skills', skill.name, file.path);
      const target = path.join(targetRoot, skill.name, file.path);
      const expected = String(file.sha256 ?? '').toUpperCase();
      try {
        if (sha256(source) !== expected || sha256(target) !== expected) mismatches += 1;
      } catch { mismatches += 1; }
    }
  }
  return { skillCount: manifest.managed_skills?.length ?? 0, mismatches };
}

export function guidanceStatusQuick(options = {}) {
  const runtimeRoot = options.root ?? defaultRoot;
  const home = options.home ?? os.homedir();
  try {
    const resolved = resolveGuidanceCheckRoot({ runtimeRoot, home, explicitRoot: options.guidanceRoot });
    const root = resolved.root;
    const groups = defaultGroups(root);
    const deployments = groups.map(group => quickDeployment(root, home, group));
    const directivePairs = groups.flatMap(group => group === 'codex'
      ? [['guidance/directives/generated/codex/AGENTS.md', '.codex/AGENTS.md']]
      : [['guidance/directives/generated/claude/CLAUDE.md', '.claude/CLAUDE.md']]);
    const directiveMismatches = directivePairs.filter(([source, target]) => (
      !sameFile(path.join(root, source), path.join(home, target))
    )).length;
    const mismatches = deployments.reduce((sum, item) => sum + item.mismatches, directiveMismatches);
    const skillCount = Math.max(...deployments.map(item => item.skillCount), 0);
    return {
      id: 'guidance',
      label: '지침·스킬·Codex 에이전트',
      state: mismatches === 0 ? 'ready' : 'attention',
      detail: mismatches === 0
        ? `정본과 배포본 해시가 일치합니다 · 스킬 ${skillCount}개`
        : `정본과 배포본 불일치 ${mismatches}건 · 전체 점검 필요`,
      checks: null,
      failed: mismatches,
      skillCount,
      deploymentIssues: mismatches,
      manifestIssues: 0,
      canonicalRootSource: resolved.source,
      quick: true
    };
  } catch (error) {
    return {
      id: 'guidance', label: '지침·스킬·Codex 에이전트', state: 'attention', optional: false,
      detail: `빠른 정본 검사를 완료하지 못했습니다: ${error.message}`,
      quick: true
    };
  }
}

function parseJsonOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) throw new Error('지침 검사 결과가 비어 있습니다.');
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* continue */ }
  }
  try { return JSON.parse(text); }
  catch { throw new Error('지침 검사 JSON을 읽을 수 없습니다.'); }
}

function reportStatus(result) {
  if (result.error?.code === 'ENOENT') {
    return {
      id: 'guidance', label: '지침과 스킬', state: 'unavailable', optional: false,
      detail: 'PowerShell 7을 찾지 못해 정본 정합성을 확인하지 못했습니다.'
    };
  }
  try {
    const report = parseJsonOutput(result.stdout);
    const failed = Number(report.failed_count ?? 0);
    const skills = report.checks?.find?.(check => check.name === 'skills')?.result;
    const directives = report.checks?.find?.(check => check.name === 'directives')?.result;
    const agents = report.checks?.find?.(check => check.name === 'agents')?.result;
    const issueCount = Number(skills?.deployment_issue_count ?? 0)
      + Number(skills?.manifest_issue_count ?? 0)
      + Number(agents?.deployment_issue_count ?? 0)
      + Number(agents?.manifest_issue_count ?? 0)
      + Number(directives?.failed_count ?? 0);
    return {
      id: 'guidance',
      label: '지침·스킬·Codex 에이전트',
      state: failed === 0 && result.status === 0 ? 'ready' : 'attention',
      detail: failed === 0 && result.status === 0
        ? `정본과 배포본이 일치합니다 · 스킬 ${skills?.central_skill_count ?? 0}개 · 에이전트 ${agents?.agent_count ?? 0}개`
        : `정본과 배포본 불일치 ${Math.max(failed, issueCount)}건`,
      checks: Number(report.check_count ?? 0),
      failed,
      skillCount: Number(skills?.central_skill_count ?? 0),
      deploymentIssues: Number(skills?.deployment_issue_count ?? 0),
      manifestIssues: Number(skills?.manifest_issue_count ?? 0),
      agentCount: Number(agents?.agent_count ?? 0),
      agentDeploymentIssues: Number(agents?.deployment_issue_count ?? 0),
      agentManifestIssues: Number(agents?.manifest_issue_count ?? 0)
    };
  } catch (error) {
    return {
      id: 'guidance', label: '지침·스킬·Codex 에이전트', state: 'attention', optional: false,
      detail: `정본 검사를 완료하지 못했습니다: ${error.message}`
    };
  }
}

export function guidanceStatus(options = {}) {
  const runtimeRoot = options.root ?? defaultRoot;
  const home = options.home ?? os.homedir();
  const runner = options.spawnSync ?? spawnSync;
  const executable = options.executable ?? 'pwsh';
  try {
    const root = resolveGuidanceCheckRoot({ runtimeRoot, home, explicitRoot: options.guidanceRoot }).root;
    const script = path.join(root, 'tools/platform/test/Test-AiccGuidance.ps1');
    return reportStatus(runner(executable, ['-NoProfile', '-File', script, '-AiccRoot', root, '-AsJson'], {
      cwd: root,
      env: options.env ?? process.env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 2 * 1024 * 1024
    }));
  } catch (error) {
    return { id: 'guidance', label: '지침·스킬·Codex 에이전트', state: 'attention', optional: false, detail: `정본 root를 확인하지 못했습니다: ${error.message}` };
  }
}

export async function guidanceStatusAsync(options = {}) {
  const runtimeRoot = options.root ?? defaultRoot;
  const home = options.home ?? os.homedir();
  const executable = options.executable ?? 'pwsh';
  let root;
  try { root = resolveGuidanceCheckRoot({ runtimeRoot, home, explicitRoot: options.guidanceRoot }).root; }
  catch (error) { return { id: 'guidance', label: '지침·스킬·Codex 에이전트', state: 'attention', optional: false, detail: `정본 root를 확인하지 못했습니다: ${error.message}` }; }
  const script = path.join(root, 'tools/platform/test/Test-AiccGuidance.ps1');
  const result = await (options.runCommand ?? runCommand)(
    executable,
    ['-NoProfile', '-File', script, '-AiccRoot', root, '-AsJson'],
    { cwd: root, env: options.env ?? process.env, timeoutMs: options.timeoutMs ?? 30_000, maxBytes: 2 * 1024 * 1024 }
  );
  return reportStatus({
    ...result,
    status: result.exitCode,
    error: result.error ? { code: result.error.includes('ENOENT') ? 'ENOENT' : 'command_failed', message: result.error } : null
  });
}
