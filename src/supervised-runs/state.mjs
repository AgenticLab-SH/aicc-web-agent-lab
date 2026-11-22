// 관제 실행 정본(<ops>\SUPERVISOR\wake-config.json) 읽기·정규화·원자적 쓰기와 기록 꼬리 읽기.
// 정본은 이 파일 하나다. wake-state.json·wake-log.md·SUPERVISOR-LOG.md·PROGRESS.md는 각 소유자의 기록이며 읽기만 한다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SCHEMA_VERSION = 1;
export const RUNNERS = Object.freeze(['kiro', 'codex']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const SESSION = { kiro: /^sess_[0-9a-f-]{36}$/, codex: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i };

export class SupervisedRunError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export function defaultRunsRoot(env = process.env) {
  return env.AICC_SUPERVISED_RUNS_ROOT?.trim() || path.join(os.homedir(), '.codex', 'ops');
}

export function configPathFor(opsDirectory) {
  return path.join(opsDirectory, 'SUPERVISOR', 'wake-config.json');
}

export function validName(value) { return typeof value === 'string' && NAME.test(value); }

export function validSessionId(runner, value) {
  return typeof value === 'string' && (SESSION[runner] ?? SESSION.kiro).test(value);
}

export function fingerprint(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function readText(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// 정본 원문(바이트 그대로의 문자열)과 정규화한 보기를 함께 돌려준다. 원문은 지문·되돌리기에 쓴다.
export function readRun(opsDirectory) {
  const file = configPathFor(opsDirectory);
  let raw;
  try { raw = readText(file); }
  catch (error) {
    if (error.code === 'ENOENT') throw new SupervisedRunError('run_not_found', `관제 실행 정본이 없습니다: ${file}`, 404);
    throw error;
  }
  let config;
  try { config = JSON.parse(raw); }
  catch { throw new SupervisedRunError('run_config_invalid', `정본 JSON을 읽을 수 없습니다: ${file}`, 409); }
  return { file, raw, fingerprint: fingerprint(raw), config, run: normalizeRun(opsDirectory, config) };
}

export function normalizeGroup(group = {}, ended = false) {
  const runner = RUNNERS.includes(group.runner) ? group.runner : 'kiro';
  return {
    name: String(group.name ?? ''),
    sessionId: group.sessionId || null,
    runner,
    agent: group.agent ?? null,
    workingDirectory: group.workingDirectory ?? null,
    promptFile: group.promptFile ?? null,
    progressFile: group.progressFile ?? null,
    wakeCallbackId: group.wakeCallbackId ?? null,
    elevated: runner === 'kiro' && group.elevated !== false,
    addedAt: group.addedAt ?? null,
    ...(ended ? { endedAt: group.endedAt ?? null, reason: group.reason ?? null } : {})
  };
}

export function normalizeRun(opsDirectory, config = {}) {
  const supervisorDirectory = path.join(opsDirectory, 'SUPERVISOR');
  return {
    schemaVersion: Number.isInteger(config.schemaVersion) ? config.schemaVersion : 0,
    runName: config.runName || path.basename(opsDirectory),
    opsDirectory,
    supervisorDirectory,
    taskName: config.taskName ?? null,
    deadline: config.deadline ?? null,
    minGapMinutes: config.minGapMinutes ?? null,
    staleMinutes: config.staleMinutes ?? 45,
    s0: config.s0 ? { ...normalizeGroup({ name: 'S0', ...config.s0 }), wakePrompt: config.s0.wakePrompt ?? null } : null,
    groups: (Array.isArray(config.groups) ? config.groups : []).map(item => normalizeGroup(item)),
    endedGroups: (Array.isArray(config.endedGroups) ? config.endedGroups : []).map(item => normalizeGroup(item, true))
  };
}

export function discoverRuns(root = defaultRunsRoot()) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const opsDirectory = path.join(root, entry.name);
    if (fs.existsSync(configPathFor(opsDirectory))) runs.push(opsDirectory);
  }
  return runs.sort();
}

// tmp → rename. BOM 없는 UTF-8(Windows PowerShell 5.1의 [IO.File]::ReadAllText(...,UTF8)도 그대로 읽는다).
export function writeRunRaw(file, raw) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, raw, { encoding: 'utf8', flag: 'wx' });
  try { fs.renameSync(temp, file); }
  catch (error) { try { fs.unlinkSync(temp); } catch { /* no-op */ } throw error; }
}

export function serializeConfig(config) { return `${JSON.stringify(config, null, 2)}\n`; }

export function fileMtime(file) {
  if (!file) return null;
  try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
}

// 큰 파일도 끝부분만 읽는다(messages.jsonl은 수 MB).
export function tailText(file, maxBytes = 16_384) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    if (length < size) text = text.slice(text.indexOf('\n') + 1);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function tailLines(file, lines = 20, maxBytes = 32_768) {
  const text = tailText(file, maxBytes);
  if (text === null) return null;
  return text.split(/\r?\n/).filter(line => line.length).slice(-lines);
}
