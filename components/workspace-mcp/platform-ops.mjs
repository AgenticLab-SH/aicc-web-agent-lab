import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function executableFile(candidate) {
  if (!candidate || !path.isAbsolute(candidate)) return null;
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return null;
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

export function resolveExecutable(name, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configured = options.configured?.trim();
  if (configured) {
    const exact = executableFile(configured);
    if (!exact) throw new Error(`${name} executable must be an executable absolute path`);
    return exact;
  }
  const pathEntries = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = platform === 'win32'
    ? (path.extname(name) ? [name] : [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name])
    : [name];
  const candidates = pathEntries.flatMap(entry => names.map(item => path.join(entry, item)));
  if (platform === 'win32') {
    const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
    const localAppData = env.LOCALAPPDATA;
    if (name === 'git') {
      for (const root of programFiles) {
        candidates.push(path.join(root, 'Git', 'cmd', 'git.exe'));
        candidates.push(path.join(root, 'Git', 'bin', 'git.exe'));
      }
      if (localAppData) candidates.push(path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'));
    }
    if (name === 'powershell') {
      const systemRoot = env.SystemRoot || env.WINDIR;
      if (systemRoot) candidates.unshift(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    }
    if (name === 'pwsh') {
      for (const root of programFiles) candidates.push(path.join(root, 'PowerShell', '7', 'pwsh.exe'));
    }
  } else if (name === 'git') {
    candidates.push('/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git');
  }
  for (const candidate of new Set(candidates)) {
    const exact = executableFile(candidate);
    if (exact) return exact;
  }
  return null;
}

export function resolveGitExecutable(options = {}) {
  return resolveExecutable('git', { ...options, configured: options.configured ?? options.env?.AICC_GIT_EXECUTABLE ?? process.env.AICC_GIT_EXECUTABLE });
}

export function resolvePowerShellExecutable(options = {}) {
  const env = options.env ?? process.env;
  return resolveExecutable('powershell', { ...options, env, configured: options.configured ?? env.AICC_POWERSHELL_EXECUTABLE })
    ?? resolveExecutable('pwsh', { ...options, env, configured: options.pwshConfigured ?? env.AICC_PWSH_EXECUTABLE });
}

export function runGit(root, args, options = {}) {
  const executable = options.executable ?? resolveGitExecutable(options);
  if (!executable) {
    return { status: null, stdout: '', stderr: 'Git executable is unavailable.', error: new Error('Git executable is unavailable.') };
  }
  return (options.run ?? spawnSync)(executable, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: options.timeout ?? 15_000,
    maxBuffer: options.maxBuffer ?? 1_048_576,
    windowsHide: true,
    shell: false,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...(options.env ?? {}) }
  });
}

function headerPath(line) {
  const raw = line.slice(4).split('\t')[0].trim();
  if (!raw) throw new Error('패치 파일 경로가 비어 있습니다.');
  if (raw === '/dev/null') return raw;
  if (raw.startsWith('"') || raw.endsWith('"')) throw new Error('따옴표 경로 패치는 지원하지 않습니다.');
  return raw.replace(/^[ab]\//, '');
}

function parseHunkHeader(line) {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) throw new Error(`올바르지 않은 unified diff hunk입니다: ${line}`);
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4])
  };
}

export function parseUnifiedPatch(patchText) {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n');
  const files = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].startsWith('--- ')) {
      index += 1;
      continue;
    }
    const oldPath = headerPath(lines[index]);
    index += 1;
    if (index >= lines.length || !lines[index].startsWith('+++ ')) throw new Error('unified diff의 +++ 파일 헤더가 없습니다.');
    const newPath = headerPath(lines[index]);
    index += 1;
    if (oldPath !== '/dev/null' && newPath !== '/dev/null' && oldPath !== newPath) {
      throw new Error('파일 rename 패치는 아직 지원하지 않습니다.');
    }
    const hunks = [];
    while (index < lines.length && !lines[index].startsWith('--- ')) {
      if (!lines[index].startsWith('@@ ')) {
        index += 1;
        continue;
      }
      const header = parseHunkHeader(lines[index]);
      index += 1;
      const body = [];
      let oldSeen = 0;
      let newSeen = 0;
      while (index < lines.length && (oldSeen < header.oldCount || newSeen < header.newCount)) {
        const line = lines[index];
        if (line === '\\ No newline at end of file') {
          index += 1;
          continue;
        }
        const prefix = line[0];
        if (![' ', '+', '-'].includes(prefix)) throw new Error(`올바르지 않은 patch body line입니다: ${line}`);
        const text = line.slice(1);
        body.push({ prefix, text });
        if (prefix !== '+') oldSeen += 1;
        if (prefix !== '-') newSeen += 1;
        index += 1;
      }
      if (oldSeen !== header.oldCount || newSeen !== header.newCount) {
        throw new Error('patch hunk line count가 헤더와 일치하지 않습니다.');
      }
      hunks.push({ ...header, body });
    }
    if (!hunks.length) throw new Error(`패치 hunk가 없습니다: ${newPath === '/dev/null' ? oldPath : newPath}`);
    files.push({ oldPath, newPath, hunks });
  }
  if (!files.length) throw new Error('unified diff에 적용할 파일이 없습니다.');
  return files;
}

function splitText(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized === '') return { lines: [], eol, finalNewline: false };
  const finalNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

function applyHunks(sourceLines, hunks, label) {
  const output = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const target = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (target < cursor || target > sourceLines.length) throw new Error(`patch 위치가 범위를 벗어났습니다: ${label}`);
    output.push(...sourceLines.slice(cursor, target));
    let sourceIndex = target;
    for (const item of hunk.body) {
      if (item.prefix === ' ') {
        if (sourceLines[sourceIndex] !== item.text) throw new Error(`patch context가 현재 파일과 다릅니다: ${label}`);
        output.push(item.text);
        sourceIndex += 1;
      } else if (item.prefix === '-') {
        if (sourceLines[sourceIndex] !== item.text) throw new Error(`patch 삭제 대상이 현재 파일과 다릅니다: ${label}`);
        sourceIndex += 1;
      } else {
        output.push(item.text);
      }
    }
    cursor = sourceIndex;
  }
  output.push(...sourceLines.slice(cursor));
  return output;
}

export function applyUnifiedPatch(root, patchText, options = {}) {
  const resolvePath = options.resolvePath;
  if (typeof resolvePath !== 'function') throw new Error('safe patch path resolver is required');
  const maxFileBytes = options.maxFileBytes ?? 16 * 1024 * 1024;
  const parsed = parseUnifiedPatch(patchText);
  const plans = parsed.map(file => {
    const relative = file.newPath === '/dev/null' ? file.oldPath : file.newPath;
    const sourceRelative = file.oldPath === '/dev/null' ? null : file.oldPath;
    const targetRelative = file.newPath === '/dev/null' ? null : file.newPath;
    const sourcePath = sourceRelative ? resolvePath(sourceRelative, false) : null;
    const targetPath = targetRelative ? resolvePath(targetRelative, true) : null;
    let original = null;
    let mode = null;
    if (sourcePath) {
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile()) throw new Error(`일반 텍스트 파일만 패치할 수 있습니다: ${sourceRelative}`);
      if (stat.size > maxFileBytes) throw new Error(`패치 대상 파일이 제한보다 큽니다: ${sourceRelative}`);
      original = fs.readFileSync(sourcePath, 'utf8');
      mode = stat.mode;
    }
    const base = splitText(original ?? '');
    const nextLines = applyHunks(base.lines, file.hunks, relative);
    const deleteFile = file.newPath === '/dev/null';
    const finalNewline = deleteFile ? false : (file.oldPath === '/dev/null' ? true : base.finalNewline);
    const next = deleteFile ? null : nextLines.join(base.eol) + (finalNewline ? base.eol : '');
    return { relative, sourcePath, targetPath, original, mode, deleteFile, next, existed: Boolean(sourcePath && fs.existsSync(sourcePath)) };
  });

  const applied = [];
  const createdParents = [];
  const canonicalRoot = fs.realpathSync(root);
  const withinRoot = candidate => {
    const relative = path.relative(canonicalRoot, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('패치 상위 디렉터리가 워크스페이스를 벗어났습니다.');
    }
  };
  const requireDirectory = directory => {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('일반 패치 상위 디렉터리가 필요합니다.');
    withinRoot(fs.realpathSync(directory));
  };
  try {
    // Validate every hunk before creating anything. Create each missing parent
    // separately so a link or concurrent replacement cannot redirect recursion.
    for (const plan of plans) {
      if (!plan.targetPath) continue;
      const missing = [];
      let directory = path.dirname(plan.targetPath);
      withinRoot(directory);
      while (!fs.existsSync(directory)) {
        missing.push(directory);
        directory = path.dirname(directory);
      }
      requireDirectory(directory);
      for (const parent of missing.reverse()) {
        requireDirectory(path.dirname(parent));
        resolvePath(path.relative(root, parent), true);
        try {
          fs.mkdirSync(parent);
          createdParents.push(parent);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        requireDirectory(parent);
      }
    }
    for (const plan of plans) {
      if (plan.targetPath) {
        requireDirectory(path.dirname(plan.targetPath));
        if (resolvePath(plan.relative, true) !== plan.targetPath) throw new Error('패치 경로가 변경되었습니다.');
      }
      if (plan.deleteFile) {
        fs.unlinkSync(plan.sourcePath);
      } else {
        const temp = `${plan.targetPath}.aicc-patch-${process.pid}-${randomBytes(6).toString('hex')}`;
        fs.writeFileSync(temp, plan.next, 'utf8');
        if (plan.mode !== null && process.platform !== 'win32') fs.chmodSync(temp, plan.mode);
        try {
          fs.renameSync(temp, plan.targetPath);
        } catch (error) {
          try { fs.unlinkSync(temp); } catch { /* best effort */ }
          if (process.platform === 'win32' && fs.existsSync(plan.targetPath)) {
            fs.writeFileSync(plan.targetPath, plan.next, 'utf8');
          } else {
            throw error;
          }
        }
      }
      applied.push(plan);
    }
  } catch (error) {
    for (const plan of applied.reverse()) {
      try {
        if (plan.original === null) {
          if (plan.targetPath && fs.existsSync(plan.targetPath)) fs.unlinkSync(plan.targetPath);
        } else {
          const restorePath = plan.sourcePath ?? plan.targetPath;
          fs.writeFileSync(restorePath, plan.original, 'utf8');
          if (plan.mode !== null && process.platform !== 'win32') fs.chmodSync(restorePath, plan.mode);
        }
      } catch { /* preserve the primary patch error */ }
    }
    for (const parent of createdParents.reverse()) {
      try { fs.rmdirSync(parent); } catch { /* remove only our still-empty parents */ }
    }
    throw error;
  }
  return { ok: true, files: plans.map(plan => plan.relative), output: `patched ${plans.length} file(s)` };
}


function windowsBrokerPath(options = {}) {
  if (options.brokerPath) return options.brokerPath;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/platform/windows/Invoke-AiccWorkspaceSandbox.ps1');
}

export function runWindowsSandboxCommandSync(root, runtimeRoot, command, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') throw new Error('Windows AppContainer runner requires win32');
  const powershell = options.powershellExecutable ?? resolvePowerShellExecutable(options);
  if (!powershell) throw new Error('Windows PowerShell or PowerShell 7 is unavailable.');
  const broker = windowsBrokerPath(options);
  if (!fs.existsSync(broker)) throw new Error('Windows AppContainer workspace broker is missing.');
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const commandFile = path.join(runtimeRoot, `command-${randomBytes(16).toString('hex')}.txt`);
  fs.writeFileSync(commandFile, command, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const readOnlyPaths = [...new Set((options.readOnlyPaths ?? []).filter(Boolean).map(item => path.resolve(item)))];
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', broker,
    '-WorkspaceRoot', root,
    '-RuntimeRoot', runtimeRoot,
    '-CommandFile', commandFile,
    '-Network', options.network === false ? 'Disabled' : 'Enabled'
  ];
  for (const allowed of readOnlyPaths) args.push('-ReadOnlyPath', allowed);
  const environment = options.env ?? process.env;
  const systemRoot = environment.SystemRoot || environment.WINDIR || 'C:\\Windows';
  try {
    return (options.run ?? spawnSync)(powershell, args, {
      cwd: root,
      env: {
        ...environment,
        PSModulePath: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
      },
      encoding: 'utf8',
      timeout: options.timeout ?? 120_000,
      maxBuffer: options.maxBuffer ?? 1_048_576,
      windowsHide: true,
      shell: false
    });
  } finally {
    try { fs.unlinkSync(commandFile); } catch { /* broker may already have cleaned it */ }
  }
}
