import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPythonCommand } from './config.mjs';
import { runCommand } from './lib/command.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watcherRoot = path.join(root, 'tools', 'platform', 'oracle', 'upstream-watch');

function stateRoot(options = {}) {
  return options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center');
}

export function upstreamMonitorPaths(options = {}) {
  const ownerRoot = stateRoot(options);
  const monitoringRoot = path.join(ownerRoot, 'monitoring');
  return {
    monitoringRoot,
    portfolio: options.portfolioPath ?? path.join(ownerRoot, 'cross-device', 'project-portfolio.toml'),
    manifest: options.upstreamManifestPath ?? path.join(monitoringRoot, 'local-upstream-manifest.json'),
    state: options.upstreamStatePath ?? path.join(monitoringRoot, 'local-upstream.json'),
    events: options.upstreamEventsPath ?? path.join(monitoringRoot, 'local-upstream-events.jsonl'),
    ledger: options.sourceLedgerPath ?? path.join(root, 'guidance', 'skills', 'aicc-guidance-review', 'references', 'absorption-ledger.json')
  };
}

function ensureOwnerDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* best effort */ }
}

async function checkedRun(runner, executable, args, options) {
  const result = await runner(executable, args, options);
  if (!result?.ok) throw new Error(String(result?.stderr || result?.error || `${path.basename(executable)} failed`).trim().slice(0, 500));
  return result;
}

export async function resolveOcxVersion(options, runner) {
  if (options.ocxVersion) return String(options.ocxVersion);
  const health = await runner('curl', ['--fail', '--silent', '--show-error', '--max-time', '3', options.ocxHealthUrl ?? 'http://127.0.0.1:10100/healthz'], { timeoutMs: 5_000, maxBytes: 20_000 });
  if (health?.ok) {
    try {
      const version = String(JSON.parse(health.stdout)?.version ?? '');
      if (/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) return version;
    } catch { /* fall through to the standalone CLI */ }
  }
  const result = await checkedRun(runner, options.ocxExecutable ?? 'ocx', ['--version'], { timeoutMs: 15_000, maxBytes: 20_000 });
  const match = /(?:opencodex\s+)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i.exec(result.stdout);
  if (!match) throw new Error('OCX 버전을 확인할 수 없습니다.');
  return match[1];
}

export async function resolveCodexVersion(options, runner) {
  if (options.codexVersion) return String(options.codexVersion);
  const home = options.home ?? os.homedir();
  const installed = (options.platform ?? process.platform) === 'win32'
    ? path.join(home, 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
    : path.join(home, '.local', 'bin', 'codex');
  const result = await checkedRun(runner, options.codexExecutable ?? installed, ['--version'], { timeoutMs: 15_000, maxBytes: 20_000 });
  const match = /(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/i.exec(result.stdout);
  if (!match) throw new Error('Codex CLI 버전을 확인할 수 없습니다.');
  return match[1];
}

async function resolveWebGptBaseline(options, runner) {
  if (options.webGptBaselineRevision) return String(options.webGptBaselineRevision);
  const repository = options.webGptRepositoryPath ?? path.resolve(root, '..', 'codex-chatgpt-web-private');
  const result = await runner('git', ['-C', repository, 'rev-parse', 'refs/remotes/upstream/main'], { timeoutMs: 15_000, maxBytes: 20_000 });
  const revision = String(result?.stdout ?? '').trim();
  return result?.ok && /^[0-9a-f]{40}$/.test(revision) ? revision : 'UNKNOWN';
}

function enrichToolSources(manifest, { codexVersion, ocxVersion, webGptBaselineRevision }) {
  const retained = manifest.sources.filter(source => ![
    'codex-cli-npm',
    'codexpro-reference-npm',
    'devspace-reference-npm',
    'codex-web-gpt-upstream'
  ].includes(source.id));
  const sources = retained.map(source => source.id === 'ocx-upstream-npm' ? {
    ...source,
    label: 'OpenCodex (OCX)',
    sourceUrl: 'https://github.com/lidge-jun/opencodex',
    observationMode: 'installed',
    applyPolicy: 'agent-review',
    applyReason: 'AICC pinned source, 10100 service, route health와 함께 검토해야 합니다.'
  } : source);
  sources.push(
    {
      id: 'codex-cli-npm',
      type: 'npm',
      package: '@openai/codex',
      baselineVersion: codexVersion,
      channel: 'latest',
      label: 'OpenAI Codex CLI',
      sourceUrl: 'https://github.com/openai/codex',
      observationMode: 'installed',
      applyPolicy: 'guarded-action',
      applyAction: 'codex-cli.update',
      applyReason: '공식 standalone 관리 설치와 exact idle이 확인될 때만 적용합니다.'
    },
    {
      id: 'codexpro-reference-npm',
      type: 'npm',
      package: 'codexpro',
      channel: 'latest',
      label: 'CodexPro',
      sourceUrl: 'https://github.com/rebel0789/codexpro',
      observationMode: 'reference',
      installed: false,
      applyPolicy: 'reference-only',
      applyReason: '현재 AICC 런타임 의존성이 아니므로 설치하지 않고 agent 비교 대상으로만 유지합니다.'
    },
    {
      id: 'devspace-reference-npm',
      type: 'npm',
      package: '@waishnav/devspace',
      channel: 'latest',
      label: 'DevSpace',
      sourceUrl: 'https://github.com/Waishnav/devspace',
      observationMode: 'reference',
      installed: false,
      applyPolicy: 'reference-only',
      applyReason: 'AICC가 채택하지 않은 참고 구현이므로 최신 상태만 관측합니다.'
    },
    {
      id: 'codex-web-gpt-upstream',
      type: 'github',
      repository: 'miuuyy/codex-chatgpt-web',
      visibility: 'public',
      trackedRef: 'HEAD',
      baselineRevision: webGptBaselineRevision,
      label: 'Codex Web GPT 원본',
      sourceUrl: 'https://github.com/miuuyy/codex-chatgpt-web',
      observationMode: 'fork-baseline',
      applyPolicy: 'agent-review',
      applyReason: 'AICC private fork의 기능·보안·회귀를 검토해 선택 흡수해야 하므로 자동 merge하지 않습니다.'
    }
  );
  return { ...manifest, sources: sources.sort((left, right) => left.id.localeCompare(right.id)) };
}

export async function scanLocalUpstreams(options = {}) {
  const paths = upstreamMonitorPaths(options);
  if (!fs.existsSync(paths.portfolio)) throw new Error('등록된 프로젝트 portfolio를 찾을 수 없습니다.');
  ensureOwnerDirectory(paths.monitoringRoot);
  const runner = options.runCommand ?? runCommand;
  const python = options.pythonCommand ?? defaultPythonCommand();
  const version = await resolveOcxVersion(options, runner);
  const codexVersion = await resolveCodexVersion(options, runner);
  const webGptBaselineRevision = await resolveWebGptBaseline(options, runner);
  await checkedRun(runner, python.executable, [
    ...python.args,
    path.join(watcherRoot, 'build_manifest.py'),
    '--portfolio', paths.portfolio,
    '--output', paths.manifest,
    '--ocx-version', version,
    '--source-ledger', paths.ledger
  ], { timeoutMs: options.buildTimeoutMs ?? 2 * 60_000, maxBytes: 200_000 });
  const generated = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
  const manifest = enrichToolSources(generated, { codexVersion, ocxVersion: version, webGptBaselineRevision });
  fs.writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(paths.manifest, 0o600); } catch { /* best effort */ }
  await checkedRun(runner, python.executable, [
    ...python.args,
    path.join(watcherRoot, 'upstream_watch.py'),
    '--manifest', paths.manifest,
    '--state', paths.state,
    '--events', paths.events,
    '--credential-mode', 'local-git'
  ], { timeoutMs: options.scanTimeoutMs ?? 8 * 60_000, maxBytes: 200_000 });
  const report = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
  return { ...report, origin: 'local-aicc-direct' };
}
