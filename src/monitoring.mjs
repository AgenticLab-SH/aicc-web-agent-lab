import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectServicesStatus } from './project-services.mjs';
import { upstreamMonitorPaths } from './upstream-monitor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultMonitoringManifest = path.join(root, 'guidance', 'monitoring.json');

function stateRoot(options = {}) {
  return options.stateRoot
    ?? process.env.AICC_STATE_ROOT?.trim()
    ?? path.join(os.homedir(), '.ai-control-center');
}

export function monitoringPaths(options = {}) {
  const ownerRoot = stateRoot(options);
  const monitoringRoot = path.join(ownerRoot, 'monitoring');
  return {
    ownerRoot,
    monitoringRoot,
    oracleConnection: options.oracleConnectionPath ?? path.join(ownerRoot, 'oracle', 'a1-bastion.json'),
    oracleSnapshot: options.oracleSnapshotPath ?? path.join(monitoringRoot, 'oracle-upstream.json'),
    localUpstream: options.upstreamStatePath ?? upstreamMonitorPaths(options).state
  };
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* best effort outside POSIX */ }
}

function atomicJson(file, value) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}

export function loadMonitoringManifest(file = defaultMonitoringManifest) {
  const manifest = readJson(file);
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.layers) || !Array.isArray(manifest.launchAgentRoles)) {
    throw new Error('Unsupported monitoring manifest');
  }
  return manifest;
}

function ownerOnlyJson(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('Oracle connection config is not a file');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Oracle connection config must be mode 0600');
  const value = readJson(file);
  if (!value?.bastion_target || !value?.identity_file) throw new Error('Oracle connection config is incomplete');
  return { bastionTarget: String(value.bastion_target), identityFile: path.resolve(String(value.identity_file).replace(/^~(?=\/)/, os.homedir())) };
}

function runAsync(executable, args, options = {}) {
  if (options.runCommand) return options.runCommand(executable, args, options);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? process.env });
    let stdout = '';
    let stderr = '';
    let overflow = false;
    const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024;
    const collect = (chunk, stream) => {
      if (overflow) return;
      if (stdout.length + stderr.length + chunk.length > maxBuffer) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => collect(chunk, 'stdout'));
    child.stderr.on('data', chunk => collect(chunk, 'stderr'));
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000);
    timer.unref();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (overflow) return reject(new Error('Oracle status response exceeded the output limit'));
      if (code !== 0) return reject(new Error(`Oracle status pull failed (${signal || code}): ${stderr.trim().slice(0, 400)}`));
      resolve(stdout);
    });
    child.stdin.end(options.input ?? '');
  });
}

function remoteStatusScript() {
  return `set -euo pipefail
A1_CONNECTION="$HOME/.local/bin/oracle-a1-connection"
A1_CONFIG="$HOME/.config/oracle-a1/connection.json"
test "$(stat -c '%a' "$A1_CONNECTION")" = 700
test "$(stat -c '%a' "$A1_CONFIG")" = 600
"$A1_CONNECTION" status </dev/null >/dev/null
"$A1_CONNECTION" exec -- bash -s <<'REMOTE'
set -euo pipefail
sudo python3 - <<'PY'
import json
import subprocess
from pathlib import Path

state = json.loads(Path('/var/lib/open-aicc-upstream-watch/state.json').read_text())

def properties(unit, names):
    result = subprocess.run(
        ['systemctl', 'show', unit, *sum((['-p', name] for name in names), [])],
        check=True, capture_output=True, text=True,
    )
    values = {}
    for line in result.stdout.splitlines():
        key, _, value = line.partition('=')
        values[key] = value
    return values

timer = properties('open-aicc-upstream-watch.timer', ['ActiveState', 'SubState', 'UnitFileState', 'LastTriggerUSec', 'NextElapseUSecRealtime'])
service = properties('open-aicc-upstream-watch.service', ['ActiveState', 'SubState', 'Type', 'Result', 'ExecMainStartTimestamp', 'ExecMainExitTimestamp', 'CPUUsageNSec'])
print(json.dumps({'state': state, 'timer': timer, 'service': service}, separators=(',', ':')))
PY
REMOTE
`;
}

function parseLastJsonLine(output) {
  const lines = String(output).split(/\r?\n/).map(line => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch { /* continue */ }
  }
  throw new Error('Oracle status pull returned no JSON state');
}

function sanitizeOraclePayload(payload, fetchedAt) {
  const sourceFields = ['id', 'type', 'status', 'baselineRevision', 'currentRevision', 'baselineVersion', 'currentVersion', 'channel', 'reason'];
  const sources = Array.isArray(payload?.state?.sources) ? payload.state.sources.map(source => Object.fromEntries(
    sourceFields.filter(field => source[field] !== undefined).map(field => [field, source[field]])
  )) : [];
  const counts = payload?.state?.counts && typeof payload.state.counts === 'object'
    ? payload.state.counts
    : Object.fromEntries(['current', 'update_available', 'auth_required', 'unknown'].map(status => [status, sources.filter(source => source.status === status).length]));
  return {
    schemaVersion: 1,
    fetchedAt,
    transport: 'oracle-a1-bastion-pull',
    automaticApply: false,
    checkedAt: payload?.state?.checkedAt ?? null,
    counts,
    sources,
    timer: {
      activeState: payload?.timer?.ActiveState ?? 'unknown',
      subState: payload?.timer?.SubState ?? 'unknown',
      unitFileState: payload?.timer?.UnitFileState ?? 'unknown',
      lastTrigger: payload?.timer?.LastTriggerUSec ?? null,
      nextElapse: payload?.timer?.NextElapseUSecRealtime ?? null
    },
    observer: {
      type: payload?.service?.Type ?? 'unknown',
      activeState: payload?.service?.ActiveState ?? 'unknown',
      subState: payload?.service?.SubState ?? 'unknown',
      result: payload?.service?.Result ?? 'unknown',
      lastStarted: payload?.service?.ExecMainStartTimestamp ?? null,
      lastFinished: payload?.service?.ExecMainExitTimestamp ?? null,
      cpuUsageNanoseconds: Number(payload?.service?.CPUUsageNSec || 0)
    }
  };
}

export async function pullOracleMonitoring(options = {}) {
  const paths = monitoringPaths(options);
  const config = options.connection ?? ownerOnlyJson(paths.oracleConnection);
  const output = await runAsync(options.sshExecutable ?? 'ssh', [
    '-i', config.identityFile,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    config.bastionTarget,
    'bash', '-s'
  ], { ...options, input: remoteStatusScript() });
  const fetchedAt = new Date(options.now?.() ?? Date.now()).toISOString();
  const snapshot = sanitizeOraclePayload(parseLastJsonLine(output), fetchedAt);
  atomicJson(paths.oracleSnapshot, snapshot);
  return snapshot;
}

function syncCommand(executable, args, options = {}) {
  const result = (options.runSync ?? spawnSync)(executable, args, { encoding: 'utf8', timeout: options.timeoutMs ?? 5_000, maxBuffer: 2 * 1024 * 1024 });
  if (result?.error || result?.status !== 0) return '';
  return String(result.stdout ?? '').trim();
}

function plistValue(file, key, options) {
  return syncCommand(options.plutilExecutable ?? 'plutil', ['-extract', key, 'raw', '-o', '-', file], options);
}

function processTable(options = {}) {
  const output = syncCommand(options.psExecutable ?? 'ps', ['-axo', 'pid=,ppid=,%cpu=,rss='], options);
  const rows = output.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 4).map(parts => ({
    pid: Number(parts[0]), ppid: Number(parts[1]), cpu: Number(parts[2]) || 0, rssKiB: Number(parts[3]) || 0
  })).filter(row => Number.isInteger(row.pid));
  return { byPid: new Map(rows.map(row => [row.pid, row])), children: rows.reduce((map, row) => {
    const list = map.get(row.ppid) ?? [];
    list.push(row.pid);
    map.set(row.ppid, list);
    return map;
  }, new Map()) };
}

function processTreeMetrics(pid, table) {
  if (!Number.isInteger(pid)) return { pidTree: [], cpuPercent: 0, residentMiB: 0 };
  const queue = [pid];
  const visited = new Set();
  let cpu = 0;
  let rss = 0;
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    const row = table.byPid.get(current);
    if (row) { cpu += row.cpu; rss += row.rssKiB; }
    queue.push(...(table.children.get(current) ?? []));
  }
  return { pidTree: [...visited], cpuPercent: Number(cpu.toFixed(2)), residentMiB: Number((rss / 1024).toFixed(2)) };
}

function launchctlRows(options = {}) {
  const output = syncCommand(options.launchctlExecutable ?? 'launchctl', ['list'], options);
  const rows = new Map();
  for (const line of output.split(/\r?\n/).slice(1)) {
    const match = /^\s*(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    rows.set(match[3], {
      pid: /^\d+$/.test(match[1]) ? Number(match[1]) : null,
      lastExitCode: /^-?\d+$/.test(match[2]) ? Number(match[2]) : null
    });
  }
  return rows;
}

function launchAgentRole(label, manifest, projectServiceLabels = new Set()) {
  const exact = manifest.launchAgentRoles.find(item => item.label === label);
  if (exact) return exact;
  if (projectServiceLabels.has(label)) {
    return { group: 'project-on-demand', role: 'AICC 온디맨드 프로젝트 unit', need: '사이트 사용 시에만 AICC에서 묶음 실행' };
  }
  const projectOwnedPrefixes = Array.isArray(manifest.projectOwnedLabelPrefixes)
    ? manifest.projectOwnedLabelPrefixes.filter(prefix => typeof prefix === 'string' && prefix.length > 0)
    : [];
  if (projectOwnedPrefixes.some(prefix => label.startsWith(prefix))) {
    return { group: 'project-owned', role: '독립 프로젝트 서비스', need: 'AICC 핵심이 아니며 해당 프로젝트 사용 여부로 판단' };
  }
  return { group: 'external', role: '외부 앱 또는 로컬 서비스', need: '소유 앱의 사용 여부와 종료 계약으로 판단' };
}

export function collectLaunchAgents(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return { supported: false, items: [], summary: { registered: 0, running: 0, residentMiB: 0, cpuPercent: 0 } };
  const manifest = options.manifest ?? loadMonitoringManifest(options.manifestPath);
  const launchAgentsRoot = options.launchAgentsRoot ?? path.join(options.home ?? os.homedir(), 'Library', 'LaunchAgents');
  const files = fs.existsSync(launchAgentsRoot)
    ? fs.readdirSync(launchAgentsRoot).filter(name => name.endsWith('.plist')).sort().map(name => path.join(launchAgentsRoot, name))
    : [];
  const loaded = launchctlRows(options);
  const table = processTable(options);
  const projectServiceLabels = options.projectServiceLabels instanceof Set
    ? options.projectServiceLabels
    : new Set(options.projectServiceLabels ?? []);
  const items = files.map(file => {
    const label = plistValue(file, 'Label', options) || path.basename(file, '.plist');
    const job = loaded.get(label) ?? { pid: null, lastExitCode: null };
    const metrics = processTreeMetrics(job.pid, table);
    const role = launchAgentRole(label, manifest, projectServiceLabels);
    const interval = Number(plistValue(file, 'StartInterval', options)) || null;
    const runAtLoadRaw = plistValue(file, 'RunAtLoad', options);
    const keepAliveRaw = plistValue(file, 'KeepAlive', options);
    const running = Number.isInteger(job.pid);
    const attention = role.group !== 'project-on-demand' && !running && job.lastExitCode !== null && job.lastExitCode !== 0;
    return {
      label,
      group: role.group,
      role: role.role,
      need: role.need,
      running,
      pid: job.pid,
      lastExitCode: job.lastExitCode,
      cpuPercent: metrics.cpuPercent,
      residentMiB: metrics.residentMiB,
      processCount: metrics.pidTree.length,
      startIntervalSeconds: interval,
      runAtLoad: runAtLoadRaw === 'true' ? true : runAtLoadRaw === 'false' || !runAtLoadRaw ? false : 'conditional',
      keepAlive: keepAliveRaw === 'true' ? true : keepAliveRaw === 'false' || !keepAliveRaw ? false : 'conditional',
      attention
    };
  });
  return {
    supported: true,
    items,
    summary: {
      registered: items.length,
      running: items.filter(item => item.running).length,
      residentMiB: Number(items.reduce((sum, item) => sum + item.residentMiB, 0).toFixed(2)),
      cpuPercent: Number(items.reduce((sum, item) => sum + item.cpuPercent, 0).toFixed(2)),
      attention: items.filter(item => item.attention).length
    }
  };
}

export function collectCodexAutomations(options = {}) {
  const automationsRoot = options.automationsRoot ?? path.join(options.codexHome ?? path.join(os.homedir(), '.codex'), 'automations');
  if (!fs.existsSync(automationsRoot)) return { count: 0, paused: 0, active: 0, items: [] };
  const items = fs.readdirSync(automationsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const file = path.join(automationsRoot, entry.name, 'automation.toml');
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    const value = key => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(text)?.[1] ?? null;
    return [{ id: value('id') ?? entry.name, name: value('name') ?? entry.name, status: value('status') ?? 'UNKNOWN', kind: value('kind') ?? 'unknown' }];
  });
  return { count: items.length, paused: items.filter(item => item.status === 'PAUSED').length, active: items.filter(item => item.status === 'ACTIVE').length, items };
}

function localSignal(snapshot, manifest, now) {
  if (!snapshot?.checkedAt) return { state: 'missing', ageHours: null, stale: true, detail: '아직 로컬 업스트림 검사를 실행하지 않았습니다.' };
  const ageHours = Math.max(0, (now - Date.parse(snapshot.checkedAt)) / 3_600_000);
  const stale = !Number.isFinite(ageHours) || ageHours > manifest.policy.localSignalStaleAfterHours;
  return {
    state: stale ? 'stale' : 'current',
    ageHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(2)) : null,
    stale,
    detail: stale ? '보존된 로컬 검사 결과가 오래되었습니다. 업스트림을 다시 확인하세요.' : 'AICC가 이 Mac에서 업스트림을 직접 확인한 최신 결과입니다.'
  };
}

export function monitoringStatus(options = {}) {
  const manifest = options.manifest ?? loadMonitoringManifest(options.manifestPath);
  const paths = monitoringPaths(options);
  const oracle = readJson(paths.oracleSnapshot);
  const upstream = readJson(paths.localUpstream);
  const now = options.now?.() ?? Date.now();
  const automations = options.automations ?? collectCodexAutomations(options);
  const projectServices = options.projectServices ?? projectServicesStatus(options.projectServiceOptions);
  const projectServiceLabels = new Set((projectServices.projects ?? []).flatMap(project => (project.units ?? []).map(unit => unit.label)));
  const launchAgents = options.launchAgents ?? collectLaunchAgents({ ...options, manifest, projectServiceLabels });
  return {
    ok: true,
    schemaVersion: 1,
    automaticApply: false,
    policy: manifest.policy,
    layers: manifest.layers,
    signal: localSignal(upstream, manifest, now),
    upstream,
    oracle,
    local: {
      sensors: [
        { id: 'openai-usage', label: 'OpenAI 사용량', cadence: '60초', mode: 'AICC 내부 interval', apply: '95% 선제 정지 정책' },
        { id: 'openai-catalog', label: 'OpenAI 모델 목록', cadence: '6시간', mode: 'AICC 내부 interval', apply: '자동 적용 없음' },
        { id: 'upstreams', label: 'GitHub·npm 업스트림', cadence: '시작 시 + 24시간', mode: '로컬 AICC 직접 검사', apply: '자동 적용 없음' },
        { id: 'design-sources', label: '디자인 원본 7개', cadence: '6시간', mode: 'AICC 내부 interval', apply: '선택 미리보기 후 exact commit' },
        { id: 'launch-agents', label: 'macOS LaunchAgent', cadence: '화면 조회 시', mode: launchAgents.supported ? 'launchctl + ps snapshot' : '현재 플랫폼에서 격리됨', apply: '자동 중지·삭제 없음' },
        { id: 'codex-automations', label: 'Codex 자동화', cadence: 'Codex scheduler', mode: `${automations.count}개 등록`, apply: 'Codex 앱 전용 관리' }
      ],
      launchAgents,
      automations,
      projectServices
    }
  };
}
