import os from 'node:os';
import path from 'node:path';

function canonicalWindows(value, env = process.env) {
  if (typeof value !== 'string') return '';
  let text = value;
  const home = env.USERPROFILE || os.homedir();
  const replacements = new Map([
    ['%userprofile%', home],
    ['$env:userprofile', home],
    ['$' + '{env:userprofile}', home],
    ['$home', home],
    ['$' + '{home}', home],
    ['%systemroot%', env.SystemRoot || env.WINDIR || 'C:\\Windows'],
    ['$env:systemroot', env.SystemRoot || env.WINDIR || 'C:\\Windows'],
    ['%programdata%', env.ProgramData || 'C:\\ProgramData']
  ]);
  for (const [needle, replacement] of replacements) text = text.replaceAll(needle, replacement);
  text = text.replaceAll('/', '\\').toLowerCase();
  return text.replace(/\\{2,}/g, '\\');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
}

function exactPathPattern(raw, env) {
  let value = canonicalWindows(path.win32.normalize(raw), env);
  const driveRoot = /^[a-z]:\\$/.test(value);
  if (!driveRoot) value = value.replace(/\\+$/, '');
  const escaped = escapeRegex(value);
  const tail = '(?=$|[\\s"\\\'=,;&|)\\]])';
  return driveRoot
    ? new RegExp(escaped + '(?:\\\\?\\*|\\\\?\\.\\*)?' + tail, 'i')
    : new RegExp(escaped + '(?:\\\\(?:\\*|\\.\\*))?' + tail, 'i');
}

function variableBindings(command) {
  const bindings = new Map();
  const pattern = /\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"]([^'"]+)['"]/g;
  for (const match of command.matchAll(pattern)) bindings.set(match[1].toLowerCase(), match[2]);
  return bindings;
}

function expandKnownVariables(command) {
  let result = command;
  for (const [name, value] of variableBindings(command)) {
    result = result.replace(new RegExp('\\$\\{?' + escapeRegex(name) + '\\}?', 'ig'), () => value);
  }
  return result;
}

function protectedRoots({ workspaceRoot, home = os.homedir(), stateRoot, env = process.env } = {}) {
  const drive = env.SystemDrive || path.win32.parse(workspaceRoot || home || 'C:\\').root || 'C:';
  const roots = [
    drive.endsWith('\\') ? drive : drive + '\\',
    env.SystemRoot || env.WINDIR || 'C:\\Windows',
    env.ProgramFiles || 'C:\\Program Files',
    env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    env.ProgramData || 'C:\\ProgramData',
    home,
    path.win32.join(home, 'AppData'),
    path.win32.join(home, '.codex'),
    path.win32.join(home, '.ai-control-center'),
    path.win32.join(home, '.codex-chatgpt-web'),
    'C:\\src',
    'C:\\demo\\projects',
    'C:\\demo\\open-AICC',
    workspaceRoot,
    stateRoot
  ].filter(Boolean);
  return [...new Set(roots.map(value => path.win32.normalize(value)))];
}

export function catastrophicWorkspaceCommandReason(command, options = {}) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const expanded = expandKnownVariables(command);
  const normalized = canonicalWindows(expanded, options.env);

  if (/\b(?:shutdown(?:\.exe)?|restart-computer|stop-computer|logoff(?:\.exe)?|exitwindowsex|initiate(?:system)?shutdown)\b/i.test(normalized)
    || /\b(?:poweroff|reboot|halt)\b/i.test(normalized)
    || /\bwin32_operatingsystem\b[^\r\n]*\b(?:reboot|shutdown)\b/i.test(normalized)) {
    return 'System shutdown, reboot, and logoff commands are blocked by AICC.';
  }

  if (/\b(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*\s-(?:enc|encodedcommand)\b/i.test(normalized)) {
    return 'Encoded PowerShell is blocked because its destructive target cannot be inspected safely.';
  }

  const diskPatterns = [
    /\bdiskpart(?:\.exe)?\b/i,
    /\bclear-disk\b/i,
    /\binitialize-disk\b/i,
    /\bremove-partition\b/i,
    /\bremove-volume\b/i,
    /\bformat-volume\b/i,
    /\bformat(?:\.com)?\s+[a-z]:/i
  ];
  if (diskPatterns.some(pattern => pattern.test(normalized))) {
    return 'Disk or volume destructive commands are blocked by AICC.';
  }

  if (/\bgit\s+reset\s+--hard\b/i.test(normalized)) {
    return 'git reset --hard is blocked to protect uncommitted work.';
  }
  if (/\bgit\s+clean\b[^\r\n]*(?:--force|-[a-z]*f[a-z]*)/i.test(normalized)) {
    return 'git clean --force is blocked to protect untracked work.';
  }

  const destructive = /\b(?:remove-item|rm|rmdir|rd|del|erase)\b|\b(?:shutil\.rmtree|fs\.(?:rm|rmsync)|rimraf)\b|\brobocopy\b[^\r\n]*(?:\/mir|\/purge)\b/i;
  if (!destructive.test(normalized)) return null;

  for (const protectedRoot of protectedRoots(options)) {
    if (exactPathPattern(protectedRoot, options.env).test(normalized)) {
      return 'Destructive operation targeting protected root is blocked: ' + protectedRoot;
    }
  }

  const unresolvedVariableTarget = /\b(?:remove-item|rm|rmdir|rd|del|erase)\b[^\r\n]*(?:-recurse|\/s|\s-r\b|\s-rf\b)[^\r\n]*\$[A-Za-z_][A-Za-z0-9_]*/i;
  if (unresolvedVariableTarget.test(normalized)) {
    return 'Recursive deletion with an unresolved variable target is blocked; use an explicit bounded path.';
  }
  return null;
}

export function assertSafeWorkspaceCommand(command, options = {}) {
  const reason = catastrophicWorkspaceCommandReason(command, options);
  if (!reason) return;
  const error = new Error(reason);
  error.code = 'workspace_command_destructive_blocked';
  throw error;
}
