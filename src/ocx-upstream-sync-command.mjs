import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function commandInvocation(executable, args, env, platform) {
  if (platform !== 'win32') return { executable, args };
  const extension = path.extname(executable).toLowerCase();
  const absolute = path.win32.isAbsolute(executable) || path.isAbsolute(executable);
  const requiresCmd = !absolute || ['.bat', '.cmd', '.ps1'].includes(extension) || !extension;
  if (!requiresCmd) return { executable, args };
  const shell = env?.ComSpec?.trim() || process.env.ComSpec?.trim() || 'cmd.exe';
  return { executable: shell, args: ['/d', '/s', '/c', executable, ...args] };
}

function run(executable, args, env, platform, spawnRunner = spawnSync) {
  const invocation = commandInvocation(executable, args, env, platform);
  const result = spawnRunner(invocation.executable, invocation.args, {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env
  });
  if (result.error) throw result.error;
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.status !== 0) throw new Error(output || `${executable} exited with ${result.status}`);
  return result.stdout.trim();
}

export function codexConfigFingerprint(env = process.env, reader = fs.readFileSync) {
  const codexHome = env.CM_APP_CODEX_HOME?.trim() || env.CODEX_HOME?.trim();
  if (!codexHome) return 'unresolved';
  try {
    const bytes = reader(path.join(codexHome, 'config.toml'));
    return crypto.createHash('sha256').update(bytes).digest('hex');
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : 'unreadable';
  }
}

function json(output, label) {
  try { return JSON.parse(output); }
  catch { throw new Error(`${label}_json_invalid`); }
}

export function syncOcxUpstreamCatalog(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const executable = options.ocxExecutable ?? env.AICC_OCX_EXECUTABLE?.trim() ?? 'ocx';
  const spawnRunner = options.spawnSync ?? spawnSync;
  const runner = options.run ?? ((command, args) => run(command, args, env, platform, spawnRunner));
  const fingerprint = options.fingerprint ?? (() => codexConfigFingerprint(env));
  const before = fingerprint();
  const health = json(runner(executable, ['health', '--json']), 'health');
  if (health?.ok !== true || !Number.isInteger(health?.port)) throw new Error('ocx_not_ready');
  const providers = json(runner(executable, ['provider', 'list', '--json']), 'providers');
  const models = json(runner(executable, ['models', 'list', '--json']), 'models');
  const after = fingerprint();
  if (after !== before) throw new Error('codex_route_config_changed');
  return {
    ok: true,
    topology: 'upstream-only',
    routeMutation: false,
    routeFingerprintPreserved: true,
    providerCount: Array.isArray(providers?.configured) ? providers.configured.length : 0,
    modelCount: Array.isArray(models?.models) ? models.models.length : 0,
    directEndpoint: `http://127.0.0.1:${health.port}/v1`
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(syncOcxUpstreamCatalog())}\n`);
  } catch (error) {
    process.stderr.write(`ocx-upstream-sync: ${error.message}\n`);
    process.exitCode = 1;
  }
}
