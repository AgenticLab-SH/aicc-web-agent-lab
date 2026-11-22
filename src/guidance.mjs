import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { resolveGuidanceCheckRoot } from './guidance-root.mjs';

export const guidanceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function frontmatterValue(raw, key) {
  const frontmatter = raw.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)?.[1] ?? '';
  const value = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

function tomlArray(raw, key) {
  const value = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'))?.[1] ?? '';
  return [...value.matchAll(/["']([^"']+)["']/g)].map(match => match[1]);
}

function codexDelivery(root, skillName) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(root, 'guidance', 'config', 'agent-catalog.toml'), 'utf8'); }
  catch { return 'unknown'; }
  const blocks = [...raw.matchAll(/\[\[deployment_targets\]\]([\s\S]*?)(?=\n\[\[deployment_targets\]\]|$)/g)]
    .map(match => match[1]);
  const codex = blocks.find(block => /^\s*id\s*=\s*["']codex["']/m.test(block));
  if (!codex) return 'unknown';
  const active = tomlArray(codex, 'active_skills');
  if (active.length) return active.includes(skillName) ? 'active' : 'cold';
  return tomlArray(codex, 'excluded_skills').includes(skillName) ? 'cold' : 'active';
}

function invocationMode(skillDir) {
  try {
    const metadata = fs.readFileSync(path.join(skillDir, 'agents', 'openai.yaml'), 'utf8');
    return /^\s*allow_implicit_invocation:\s*false\s*$/m.test(metadata) ? 'explicit' : 'implicit';
  } catch { return 'implicit'; }
}

const searchStopWords = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'or', 'the', 'this', 'to', 'with']);

function normalizeSearchToken(token) {
  const normalized = token.toLocaleLowerCase();
  if (!/[\p{Script=Hangul}]/u.test(normalized)) return normalized;
  const suffixes = ['으로', '에서', '하고', '하며', '하는', '하게', '된다', '한다', '처럼', '까지', '부터', '에게', '한테', '보다', '이나', '거나', '라도', '은', '는', '이', '가', '을', '를', '에', '의', '와', '과', '로', '도', '만'];
  const suffix = suffixes.find(candidate => normalized.endsWith(candidate) && normalized.length - candidate.length >= 2);
  return suffix ? normalized.slice(0, -suffix.length) : normalized;
}

function queryTokens(value) {
  const tokens = value.match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [];
  return [...new Set(tokens.map(normalizeSearchToken).filter(token => token.length > 1 && !searchStopWords.has(token)))];
}

function scoreWorkflow({ query, tokens, directory, name, description, body }) {
  const normalizedName = name.toLocaleLowerCase();
  const normalizedDirectory = directory.toLocaleLowerCase();
  const normalizedDescription = description.toLocaleLowerCase();
  const normalizedBody = body.toLocaleLowerCase();
  let score = 0;
  if (normalizedName === query || normalizedDirectory === query) score += 1_200;
  else if (normalizedName.includes(query) || normalizedDirectory.includes(query)) score += 700;
  if (normalizedDescription.includes(query)) score += 500;
  else if (normalizedBody.includes(query)) score += 120;
  let matched = 0;
  let strongMatched = 0;
  for (const token of tokens) {
    let tokenScore = 0;
    if (normalizedName.includes(token) || normalizedDirectory.includes(token)) { tokenScore = 80; strongMatched += 1; }
    else if (normalizedDescription.includes(token)) { tokenScore = 45; strongMatched += 1; }
    else if (normalizedBody.includes(token)) tokenScore = 6;
    if (tokenScore) matched += 1;
    score += tokenScore;
  }
  const required = tokens.length <= 2 ? 1 : Math.ceil(tokens.length * 0.5);
  const exactBodyMatch = normalizedBody.includes(query);
  const bodyOnlyRequired = tokens.length <= 2 ? tokens.length : Math.ceil(tokens.length * 0.75);
  const matchIsCredible = strongMatched > 0
    ? matched >= required
    : exactBodyMatch || (matched >= bodyOnlyRequired && score >= 18);
  return score > 0 && matchIsCredible ? score : 0;
}

export function findGuidanceWorkflows(query, options = {}) {
  const normalizedQuery = String(query ?? '').trim().toLocaleLowerCase();
  if (!normalizedQuery) throw new Error('검색어가 필요합니다: aicc guidance find <query>');
  const limit = options.limit === undefined ? 10 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('--limit은 1~20 정수여야 합니다.');

  const root = options.root ?? guidanceRoot;
  const skillRoot = path.join(root, 'guidance', 'skills');
  const tokens = queryTokens(normalizedQuery);
  const skillDirectories = fs.readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  const knownSkillNames = new Set(skillDirectories.map((entry) => entry.name));
  const matches = skillDirectories
    .flatMap((entry) => {
      const skillPath = path.join(skillRoot, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillPath)) return [];
      const raw = fs.readFileSync(skillPath, 'utf8');
      const name = frontmatterValue(raw, 'name') || entry.name;
      const description = frontmatterValue(raw, 'description');
      const score = scoreWorkflow({
        query: normalizedQuery, tokens, directory: entry.name, name, description, body: raw
      });
      if (!score) return [];
      const handoffs = [...new Set(
        [...raw.matchAll(/\$([a-z0-9]+(?:-[a-z0-9]+)*)/g)]
          .map(match => match[1])
          .filter(candidate => candidate !== name && knownSkillNames.has(candidate))
      )].sort();
      return [{
        name,
        description,
        delivery: codexDelivery(root, entry.name),
        invocation: invocationMode(path.dirname(skillPath)),
        handoffs,
        path: skillPath,
        score
      }];
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return {
    query: String(query).trim(),
    count: Math.min(matches.length, limit),
    total: matches.length,
    matches: matches.slice(0, limit).map(({ score: _score, ...match }) => match)
  };
}

export function guidanceCommands(action, root = guidanceRoot, options = {}) {
  const common = ['-NoProfile', '-File'];
  const target = String(options.target ?? '').trim();
  if (target && options.allTargets) throw new Error('--target과 --all-targets는 함께 사용할 수 없습니다.');
  const targetArgs = target ? ['-TargetGroups', target] : options.allTargets ? ['-AllTargets'] : [];
  const pruneOptionalArgs = target || options.allTargets ? [] : ['-PruneOptionalTargets'];
  if (action === 'deploy') {
    return [
      { executable: 'pwsh', args: [...common, path.join(root, 'tools/platform/core/deploy_directives.ps1'), '-AiccRoot', root, ...targetArgs, ...pruneOptionalArgs, '-SummaryOnly', '-AsJson'] },
      { executable: 'pwsh', args: [...common, path.join(root, 'tools/platform/core/deploy_active_skills.ps1'), '-AiccRoot', root, ...targetArgs, '-PruneManaged', ...pruneOptionalArgs, '-SummaryOnly', '-AsJson'] }
    ];
  }
  if (action === 'plan') {
    return [
      { executable: 'pwsh', args: [...common, path.join(root, 'tools/platform/core/deploy_directives.ps1'), '-AiccRoot', root, ...targetArgs, ...pruneOptionalArgs, '-Plan', '-SummaryOnly', '-AsJson'] },
      { executable: 'pwsh', args: [...common, path.join(root, 'tools/platform/core/deploy_active_skills.ps1'), '-AiccRoot', root, ...targetArgs, '-PruneManaged', ...pruneOptionalArgs, '-Plan', '-SummaryOnly', '-AsJson'] }
    ];
  }
  if (action === 'check') {
    return [{ executable: 'pwsh', args: [...common, path.join(root, 'tools/platform/test/Test-AiccGuidance.ps1'), '-AiccRoot', root, ...targetArgs, '-AsJson'] }];
  }
  throw new Error(`알 수 없는 guidance 명령: ${action}`);
}

export function runGuidance(action, options = {}) {
  const runner = options.spawnSync ?? spawnSync;
  const runtimeRoot = options.root ?? guidanceRoot;
  const root = action === 'check'
    ? resolveGuidanceCheckRoot({ runtimeRoot, home: options.home ?? os.homedir(), explicitRoot: options.guidanceRoot }).root
    : runtimeRoot;
  const commands = guidanceCommands(action, root, options);
  for (const command of commands) {
    const result = runner(command.executable, command.args, {
      cwd: root,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit',
      windowsHide: true
    });
    if (result.error) {
      if (result.error.code === 'ENOENT') throw new Error('PowerShell 7(pwsh)이 필요합니다.');
      throw result.error;
    }
    if (result.status !== 0) throw new Error(`guidance ${action} 실패(exit ${result.status ?? 'unknown'})`);
  }
  return { ok: true, action, commandCount: commands.length };
}
