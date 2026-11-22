import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexConfigFingerprint } from './ocx-upstream-sync-command.mjs';

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
  return output;
}

export function startOcxAsUpstream(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const executable = options.ocxExecutable ?? env.AICC_OCX_EXECUTABLE?.trim() ?? 'ocx';
  const spawnRunner = options.spawnSync ?? spawnSync;
  const runner = options.run ?? ((command, args) => run(command, args, env, platform, spawnRunner));
  const fingerprint = options.fingerprint ?? (() => codexConfigFingerprint(env));
  const before = fingerprint();
  runner(executable, ['service', 'start']);
  const healthOutput = runner(executable, ['health', '--json']);
  let health;
  try { health = JSON.parse(healthOutput); } catch { throw new Error('health_json_invalid'); }
  if (health?.ok !== true || !Number.isInteger(health?.port)) throw new Error('ocx_not_ready');
  const after = fingerprint();
  if (after !== before) throw new Error('codex_route_config_changed');
  return {
    ok: true,
    serviceStarted: true,
    topology: 'upstream-only',
    routeMutation: false,
    routeFingerprintPreserved: true,
    directEndpoint: `http://127.0.0.1:${health.port}/v1`
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(startOcxAsUpstream())}\n`);
  } catch (error) {
    process.stderr.write(`ocx-upstream-start: ${error.message}\n`);
    process.exitCode = 1;
  }
}
