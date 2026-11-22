import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WEB_JJONKU_AUTOMATION_ID = 'web-jjonku-monitor';
export const WEB_JJONKU_TARGET_THREAD_ID = '01a0d99e-00a5-7073-ad6c-bf8c25556843';
export const WEB_JJONKU_HEARTBEAT_RRULE = 'RRULE:FREQ=MINUTELY;INTERVAL=5';
export const WEB_JJONKU_HEARTBEAT_MINUTES = 5;

const AUTOMATION_NAME = '웹쫀쿠 GPT 그룹 7개 감시';
const AUTOMATION_PROMPT = [
  'web-jjonku-monitor 스킬을 사용해 저장된 웹쫀쿠 감시 설정을 읽어.',
  '설정이 켜져 있고 다음 확인 시각이 되었을 때만 Chrome GPT 그룹의 지정된 7개 대화를 안전하게 점검·재개하고 영수증을 갱신해.',
  '조건이 맞지 않거나 GPT 그룹 신원을 증명할 수 없으면 HOLD하고 아무 메시지도 보내지 마.'
].join(' ');

function automationError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function codexHome(options) {
  return options.codexHome
    ?? (process.env.CODEX_HOME?.trim() || null)
    ?? path.join(os.homedir(), '.codex');
}
function storePaths(options) {
  const home = path.resolve(codexHome(options));
  const root = path.join(home, 'automations');
  const directory = path.join(root, WEB_JJONKU_AUTOMATION_ID);
  return { home, root, directory, file: path.join(directory, 'automation.toml') };
}

function parseTomlValue(raw, key, file) {
  const value = raw.trim();
  try {
    if (value.startsWith('"')) return JSON.parse(value);
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
    if (/^-?\d+$/.test(value)) return Number(value);
  } catch {
    throw automationError('invalid_codex_automation', `Codex 자동화의 ${key} 값을 읽을 수 없습니다.`, { file });
  }
  throw automationError('invalid_codex_automation', `Codex 자동화의 ${key} 형식이 지원되지 않습니다.`, { file });
}

function parseAutomationToml(content, file) {
  const wanted = new Set([
    'version', 'id', 'kind', 'name', 'prompt', 'status', 'rrule',
    'notification_policy', 'target_thread_id', 'created_at', 'updated_at'
  ]);
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!match || !wanted.has(match[1])) continue;
    result[match[1]] = parseTomlValue(match[2], match[1], file);
  }
  return result;
}
function readAutomationFile(file, expectedId = null) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw automationError('unsafe_codex_automation', 'Codex 자동화 파일이 안전한 일반 파일이 아닙니다.', { file });
  }
  const content = fs.readFileSync(file, 'utf8');
  const value = parseAutomationToml(content, file);
  if (value.version !== 1 || typeof value.id !== 'string' || typeof value.kind !== 'string'
    || !['ACTIVE', 'PAUSED'].includes(value.status)) {
    throw automationError('invalid_codex_automation', 'Codex 자동화 형식 또는 상태를 확인할 수 없습니다.', { file });
  }
  if (expectedId && value.id !== expectedId) {
    throw automationError('invalid_codex_automation', 'Codex 자동화 ID와 저장 폴더가 일치하지 않습니다.', { file });
  }
  if (value.kind === 'heartbeat' && typeof value.target_thread_id !== 'string') {
    throw automationError('invalid_codex_automation', 'Heartbeat 대상 thread ID를 확인할 수 없습니다.', { file });
  }
  return { ...value, file, content };
}

function findActiveConflict(paths) {
  if (!fs.existsSync(paths.root)) return null;
  const stat = fs.lstatSync(paths.root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw automationError('unsafe_codex_automation', 'Codex automations 폴더가 안전한 일반 폴더가 아닙니다.');
  }
  for (const entry of fs.readdirSync(paths.root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === WEB_JJONKU_AUTOMATION_ID) continue;
    const file = path.join(paths.root, entry.name, 'automation.toml');
    if (!fs.existsSync(file)) continue;
    try {
      const other = readAutomationFile(file);
      if (other?.kind === 'heartbeat' && other.status === 'ACTIVE'
        && other.target_thread_id === WEB_JJONKU_TARGET_THREAD_ID) return other;
    } catch (error) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes(WEB_JJONKU_TARGET_THREAD_ID)) {
        throw automationError('ambiguous_codex_automation', '같은 Codex thread를 가리키는 자동화를 안전하게 판별할 수 없습니다.', { file, cause: error });
      }
    }
  }
  return null;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function serializeAutomation(value) {
  return [
    'version = 1',
    `id = ${tomlString(value.id)}`,
    `kind = ${tomlString(value.kind)}`,
    `name = ${tomlString(value.name)}`,
    `prompt = ${tomlString(value.prompt)}`,
    `status = ${tomlString(value.status)}`,
    `rrule = ${tomlString(value.rrule)}`,
    `notification_policy = ${tomlString(value.notification_policy)}`,
    `target_thread_id = ${tomlString(value.target_thread_id)}`,
    `created_at = ${value.created_at}`,
    `updated_at = ${value.updated_at}`,
    ''
  ].join('\n');
}
function ensureWritableDirectory(paths) {
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  for (const directory of [paths.root, paths.directory]) {
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { mode: 0o700 });
      continue;
    }
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw automationError('unsafe_codex_automation', 'Codex 자동화 저장 폴더가 안전한 일반 폴더가 아닙니다.', { directory });
    }
  }
}

function atomicWriteAutomation(paths, value) {
  ensureWritableDirectory(paths);
  if (fs.existsSync(paths.file)) {
    const stat = fs.lstatSync(paths.file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw automationError('unsafe_codex_automation', '기존 Codex 자동화 파일을 안전하게 교체할 수 없습니다.', { file: paths.file });
    }
  }
  const temporary = path.join(paths.directory, `.automation.toml.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, serializeAutomation(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, paths.file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve original error */ }
    throw error;
  }
}
function sameDefinition(current, desired) {
  if (!current) return false;
  return ['id', 'kind', 'name', 'prompt', 'status', 'rrule', 'notification_policy', 'target_thread_id']
    .every(key => current[key] === desired[key]);
}

export function createWebJjonkuMonitorAutomation(options = {}) {
  const paths = storePaths(options);
  const nowMs = options.nowMs ?? (() => Date.now());

  const current = () => {
    const value = readAutomationFile(paths.file, WEB_JJONKU_AUTOMATION_ID);
    if (!value) return null;
    if (value.kind !== 'heartbeat' || value.target_thread_id !== WEB_JJONKU_TARGET_THREAD_ID
      || !Number.isSafeInteger(value.created_at) || !Number.isSafeInteger(value.updated_at)) {
      throw automationError('invalid_codex_automation', '웹쫀쿠 Codex heartbeat 정의가 예상 계약과 다릅니다.', { file: paths.file });
    }
    return value;
  };

  const describe = (own, conflict) => ({
    kind: 'codex-heartbeat',
    automationId: WEB_JJONKU_AUTOMATION_ID,
    targetThreadId: WEB_JJONKU_TARGET_THREAD_ID,
    schedulerCadenceMinutes: WEB_JJONKU_HEARTBEAT_MINUTES,
    liveStatus: conflict ? 'conflict' : own ? own.status === 'ACTIVE' ? 'active' : 'paused' : 'not-created',
    conflictAutomationId: conflict?.id ?? null
  });

  const status = () => describe(current(), findActiveConflict(paths));
  return {
    status,
    sync({ enabled }) {
      if (typeof enabled !== 'boolean') {
        throw automationError('invalid_codex_automation_request', 'Codex heartbeat 활성화 여부가 필요합니다.');
      }
      const existing = current();
      const conflict = findActiveConflict(paths);
      if (!enabled && !existing) return describe(null, conflict);

      if (enabled && conflict) {
        throw automationError('codex_heartbeat_conflict', '같은 Codex thread에 다른 ACTIVE heartbeat가 있어 웹쫀쿠 예약을 만들지 않았습니다.', {
          conflictAutomationId: conflict.id
        });
      }

      const now = Number(nowMs());
      if (!Number.isSafeInteger(now) || now < 0) {
        throw automationError('invalid_codex_automation_clock', 'Codex heartbeat 시각을 만들 수 없습니다.');
      }
      const desired = {
        id: WEB_JJONKU_AUTOMATION_ID,
        kind: 'heartbeat',
        name: AUTOMATION_NAME,
        prompt: AUTOMATION_PROMPT,
        status: enabled ? 'ACTIVE' : 'PAUSED',
        rrule: WEB_JJONKU_HEARTBEAT_RRULE,
        notification_policy: 'failed_runs_only',
        target_thread_id: WEB_JJONKU_TARGET_THREAD_ID,
        created_at: existing?.created_at ?? now,
        updated_at: now
      };
      const changed = !sameDefinition(existing, desired);
      if (changed) atomicWriteAutomation(paths, desired);
      return describe(changed ? current() : existing, conflict);
    }
  };
}
