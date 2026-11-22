import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { webGptCommand } from './lib/web-gpt-command.mjs';

const MANAGED_ROUTE_KEYS = ['openai_base_url', 'model_provider', 'model_catalog_json'];

function resolveUserPath(value, home) {
  if (!value) return null;
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return path.resolve(value);
}

function command(executable, args, env = process.env) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env
  });
  if (result.error) throw result.error;
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return { ok: result.status === 0, output, status: result.status };
}

function topLevelManagedAssignments(configText) {
  const found = new Map();
  for (const rawLine of String(configText).split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (/^\[/.test(trimmed)) break;
    const match = rawLine.match(/^\s*(openai_base_url|model_provider|model_catalog_json)\s*=\s*(.+?)\s*$/);
    if (match) found.set(match[1], { rawLine, value: match[2] });
  }
  return found;
}

function rebaselineInactiveWebGptJournal({ env, home }) {
  const webGptHome = resolveUserPath(env.CODEX_CHATGPT_WEB_HOME?.trim() || '~/.codex-chatgpt-web', home);
  const codexHome = resolveUserPath(env.CODEX_HOME?.trim() || '~/.codex', home);
  const journalPath = path.join(webGptHome, 'codex', 'integration-journal.json');
  const configPath = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(journalPath)) return { changed: false, reason: 'journal-missing' };
  if (!fs.existsSync(configPath)) throw new Error(`Codex config is missing: ${configPath}`);

  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  if (![4, 5, 6].includes(journal?.version) || journal.active !== false) {
    throw new Error('Web GPT integration journal is not an inactive v4-v6 route; refusing to rebaseline it');
  }
  if (path.resolve(journal.configPath) !== path.resolve(configPath)) {
    throw new Error('Web GPT integration journal targets a different Codex config; refusing to rebaseline it');
  }

  const assignments = topLevelManagedAssignments(fs.readFileSync(configPath, 'utf8'));
  const remaining = MANAGED_ROUTE_KEYS.filter(key => assignments.has(key));
  if (remaining.length) {
    throw new Error(`Native Codex route still contains managed routing keys (${remaining.join(', ')}); refusing journal rebaseline`);
  }

  journal.previous = Object.fromEntries(MANAGED_ROUTE_KEYS.map(key => [key, { present: false }]));
  const temporary = `${journalPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, journalPath);
  return { changed: true, journalPath };
}

export function recoverNativeCodexRoute(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const disconnectCommand = webGptCommand(['route', 'disconnect'], { executable: options.webGptExecutable, env, home });
  const ocxExecutable = options.ocxExecutable
    ?? env.AICC_OCX_EXECUTABLE?.trim()
    ?? 'ocx';
  const runner = options.run ?? ((executable, args) => command(executable, args, env));

  const disconnected = runner(disconnectCommand.executable, disconnectCommand.args);
  if (!disconnected.ok) {
    const recoverableInactiveMismatch = /changed while the bridge was disconnected|Managed Codex route marker is present while the bridge is disconnected/i.test(disconnected.output);
    if (!recoverableInactiveMismatch) throw new Error(disconnected.output || `route disconnect exited with ${disconnected.status}`);
  }

  const restored = runner(ocxExecutable, ['restore']);
  if (!restored.ok) throw new Error(restored.output || `ocx restore exited with ${restored.status}`);
  const journal = rebaselineInactiveWebGptJournal({ env, home });

  return {
    ok: true,
    webGptRouteDisconnected: disconnected.ok,
    webGptDisconnectAlreadyInactive: !disconnected.ok,
    ocxRouteRestored: true,
    journalRebased: journal.changed,
    output: [disconnected.output, restored.output].filter(Boolean).join('\n')
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(recoverNativeCodexRoute())}\n`);
  } catch (error) {
    process.stderr.write(`codex-native-recovery: ${error.message}\n`);
    process.exitCode = 1;
  }
}
