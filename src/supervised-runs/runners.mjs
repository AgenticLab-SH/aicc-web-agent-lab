// 실행기 adapter: kiro / codex. 명령은 {executable,args,cwd}로만 만들고 실행은 주입된 runCommand가 한다.
// 진행 판정 규칙은 run-kiro-supervised-groups 스킬의 실제 함정 기록을 따른다:
// session.json status=in_progress + .lock 프로세스 생존. messages.jsonl 이벤트 꼬리로 진행을 판정하지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tailText } from './state.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const windowsTools = path.join(repoRoot, 'tools', 'platform', 'windows');

export function defaultScriptPaths(home = os.homedir()) {
  return {
    pwsh: process.env.AICC_SUPERVISE_PWSH?.trim() || 'pwsh.exe',
    openKiro: path.join(home, '.agents', 'skills', 'manage-codex-model-routes', 'scripts', 'Open-KiroSession.ps1'),
    requestElevatedKiro: path.join(home, '.codex', 'skills', 'launch-admin-powershell', 'scripts', 'Request-ElevatedKiro.ps1'),
    newRun: path.join(home, '.codex', 'skills', 'run-kiro-supervised-groups', 'scripts', 'New-KiroSupervisedRun.ps1'),
    closeTab: path.join(windowsTools, 'Close-SupervisedTab.ps1'),
    openCodex: path.join(windowsTools, 'Open-CodexSupervisedTab.ps1')
  };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function findKiroSessionDir(sessionsRoot, sessionId) {
  const direct = path.join(sessionsRoot, sessionId);
  if (fs.existsSync(path.join(direct, 'session.json'))) return direct;
  let buckets = [];
  try { buckets = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { return null; }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const candidate = path.join(sessionsRoot, bucket.name, sessionId);
    if (fs.existsSync(path.join(candidate, 'session.json'))) return candidate;
  }
  return null;
}

function lastTurnEnd(messagesFile) {
  const tail = tailText(messagesFile, 262_144);
  if (!tail) return null;
  const lines = tail.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].includes('"type":"turn_end"')) continue;
    try { return JSON.parse(lines[index]).timestamp ?? null; } catch { return null; }
  }
  return null;
}

function pwshFile(paths, script, params) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === false) continue;
    if (value === true) args.push(`-${key}`);
    else args.push(`-${key}`, String(value));
  }
  return { executable: paths.pwsh, args };
}

export function createKiroRunner(options = {}) {
  const sessionsRoot = options.sessionsRoot ?? path.join(os.homedir(), '.kiro', 'sessions');
  const isPidAlive = options.isPidAlive ?? pidAlive;
  const now = options.now ?? (() => Date.now());
  const paths = { ...defaultScriptPaths(), ...options.paths };
  return {
    id: 'kiro',
    inspect(sessionId, { staleMinutes = 45 } = {}) {
      const dir = findKiroSessionDir(sessionsRoot, sessionId);
      if (!dir) return { found: false, active: false, crashed: false, stale: false, lastTurnEndAt: null, lastWriteAt: null };
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')); } catch { /* unknown */ }
      const running = meta?.status === 'in_progress';
      let alive = false;
      try { alive = isPidAlive(JSON.parse(fs.readFileSync(path.join(dir, '.lock'), 'utf8')).pid); } catch { /* no lock */ }
      const messages = path.join(dir, 'messages.jsonl');
      let lastWriteMs = null;
      try { lastWriteMs = fs.statSync(messages).mtimeMs; } catch { /* none */ }
      const active = running && alive;
      return {
        found: true,
        active,
        processAlive: alive,
        crashed: running && !alive,
        stale: active && lastWriteMs !== null && now() - lastWriteMs >= staleMinutes * 60_000,
        lastTurnEndAt: lastTurnEnd(messages),
        lastWriteAt: lastWriteMs === null ? null : new Date(lastWriteMs).toISOString(),
        title: typeof meta?.title === 'string' ? meta.title.slice(0, 120) : null
      };
    },
    openCommand(group, { promptFile, replace = false } = {}) {
      const prompt = promptFile ?? group.promptFile;
      const common = { WorkingDirectory: group.workingDirectory, Agent: group.agent, PromptFile: prompt, SessionId: group.sessionId ?? undefined };
      if (group.elevated) return pwshFile(paths, paths.requestElevatedKiro, { ...common, Replace: Boolean(replace && group.sessionId) });
      return pwshFile(paths, paths.openKiro, common);
    },
    closeCommand(group, { promptFile } = {}) {
      if (group.elevated) {
        // 일반 권한 프로세스는 관리자 탭을 닫지 못한다(스킬 함정 기록). 관리자 예약 작업의 CloseOnly 요청을 쓴다.
        return pwshFile(paths, paths.requestElevatedKiro, {
          WorkingDirectory: group.workingDirectory, Agent: group.agent, PromptFile: promptFile ?? group.promptFile,
          SessionId: group.sessionId, CloseOnly: true
        });
      }
      return pwshFile(paths, paths.closeTab, { SessionId: group.sessionId, Runner: 'kiro' });
    },
    resumeHint(group) {
      return `${group.elevated ? 'Request-ElevatedKiro.ps1' : 'Open-KiroSession.ps1'} -SessionId ${group.sessionId} -WorkingDirectory "${group.workingDirectory}" -Agent ${group.agent} -PromptFile <지시 파일>`;
    }
  };
}

export function createCodexRunner(options = {}) {
  const paths = { ...defaultScriptPaths(), ...options.paths };
  // listProcesses(): [{pid, commandLine}] — status 1회당 한 번만 부른다(서비스가 캐시).
  const listProcesses = options.listProcesses ?? (() => []);
  return {
    id: 'codex',
    inspect(sessionId, { processes } = {}) {
      const list = processes === undefined ? listProcesses() : processes;
      const pattern = new RegExp(`\\bresume\\s+${sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'i');
      const alive = Array.isArray(list) && list.some(item => pattern.test(String(item.commandLine ?? '')));
      return { found: true, active: false, activityUnknown: true, processAlive: alive, crashed: false, stale: false, lastTurnEndAt: null, lastWriteAt: null };
    },
    openCommand(group, { promptFile } = {}) {
      throw Object.assign(new Error('기존 mux 또는 등록된 callback을 사용하세요.'), { code: 'direct_launch_retired' });
    },
    closeCommand(group) {
      throw Object.assign(new Error('기존 mux에서 정상 종료하세요.'), { code: 'codex_close_not_supported' });
    },
    resumeHint(group) {
      return 'mux recent에서 exact 대화 선택. 열린 터미널 연결은 지시 전송과 별개입니다.';
    }
  };
}

export function createRunners(options = {}) {
  return {
    kiro: options.kiro ?? createKiroRunner(options),
    codex: options.codex ?? createCodexRunner(options)
  };
}

// Windows 기본 프로세스 목록(codex 진행 판정용). 실패하면 빈 목록 → 대기로 보인다.
export async function listWindowsProcesses(runCommand) {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='codex.exe' OR Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  const result = await runCommand('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 15_000, maxBytes: 2_000_000 });
  if (!result.ok || !result.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(item => ({ pid: item.ProcessId, commandLine: item.CommandLine ?? '' }));
  } catch { return null; }
}
