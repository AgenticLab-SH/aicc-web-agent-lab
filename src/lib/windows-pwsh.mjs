import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveWindowsPwsh(options = {}) {
  const environment = options.environment ?? process.env;
  const home = options.home ?? os.homedir();
  const candidates = [
    environment.AICC_PWSH_PATH,
    environment.ProgramFiles && path.join(environment.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe'),
    environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe')
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || !fs.existsSync(candidate)) continue;
    const resolved = fs.realpathSync(candidate);
    const stat = fs.lstatSync(resolved);
    if (stat.isFile() && !stat.isSymbolicLink()) return resolved;
  }
  return 'pwsh';
}
