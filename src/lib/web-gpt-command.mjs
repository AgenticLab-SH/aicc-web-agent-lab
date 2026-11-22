import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function webGptCommand(args = [], options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const explicit = options.executable ?? (env.AICC_WEB_GPT_CLI?.trim() || env.CODEX_CHATGPT_WEB_CLI?.trim());
  if (explicit) return { executable: explicit, args: [...args] };
  if (platform !== 'win32') {
    return {
      executable: platform === 'darwin'
        ? '/Applications/Codex Web GPT.app/Contents/Resources/runtime/bin/codex-chatgpt-web'
        : 'codex-chatgpt-web',
      args: [...args]
    };
  }
  const home = options.home ?? os.homedir();
  const configPath = options.configPath ?? path.join(env.CODEX_CHATGPT_WEB_HOME?.trim() || path.join(home, '.codex-chatgpt-web'), 'config.json');
  const reader = options.readFile ?? fs.readFileSync;
  let config;
  try { config = JSON.parse(reader(configPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { executable: 'codex-chatgpt-web.exe', args: [...args] };
    throw new Error('Web GPT runtime configuration cannot be read safely');
  }
  const runtime = config.runtimeCommand;
  if (!Array.isArray(runtime) || runtime.length === 0 || runtime.some(value => typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value))) {
    throw new Error('Web GPT runtimeCommand must contain a native executable and separate arguments');
  }
  if (!path.win32.isAbsolute(runtime[0]) || !/\.exe$/i.test(runtime[0])) {
    throw new Error('Windows Web GPT runtimeCommand must start with an absolute native .exe, not a shell wrapper');
  }
  if (Number(config.port) === 17842 || /web-gpt-rescue/i.test(configPath) || /web-gpt-rescue/i.test(runtime[0])) {
    throw new Error('The isolated Web GPT rescue runtime cannot own the main Web GPT route');
  }
  return { executable: runtime[0], args: [...runtime.slice(1), ...args] };
}
