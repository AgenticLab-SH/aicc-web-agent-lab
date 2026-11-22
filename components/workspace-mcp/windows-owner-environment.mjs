import path from 'node:path';

// The MCP stdio transport passes a reduced environment. In owner mode a missing
// ComSpec or a PATHEXT containing only .CPL makes Windows PowerShell silently
// skip native applications. Reconstruct Windows command discovery explicitly.
export function windowsOwnerEnvironment({ env = process.env, root, runtimeRoot, nodePath = process.execPath, gitPath = null }) {
  const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
  const originalPath = env.PATH ?? env.Path ?? '';
  const directories = [path.win32.dirname(nodePath), gitPath ? path.win32.dirname(gitPath) : null,
    ...String(originalPath).split(';'), path.win32.join(systemRoot, 'System32'),
    path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].filter(Boolean);
  const seen = new Set();
  const unique = directories.filter(directory => { const key = directory.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  const result = { ...env };
  for (const key of Object.keys(result)) if (['path', 'pathext', 'comspec', 'systemroot', 'windir'].includes(key.toLowerCase())) delete result[key];
  return { ...result, PATH: unique.join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL',
    ComSpec: path.win32.join(systemRoot, 'System32', 'cmd.exe'), SystemRoot: systemRoot, WINDIR: systemRoot,
    HOME: root, AICC_WORKSPACE_ROOT: root, AICC_RUNTIME_ROOT: runtimeRoot, NO_COLOR: '1', CI: '1' };
}
