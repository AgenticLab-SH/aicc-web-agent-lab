#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectCodexWork, quitCodexDesktopOnce } from '../../../src/codex-desktop-restart.mjs';
import { CodexTaskCallbackService } from '../../../src/codex-task-callback.mjs';
import { nativeRescueStatus } from '../../../src/native-rescue.mjs';
import { installRouteLaunchers, routeLauncherPaths, routeLauncherStatus } from '../../../src/codex-route-launchers.mjs';
import { runWebGptWatchCallback } from '../../../src/web-gpt-watch-callback.mjs';
import {
  readWorkspaceMcpConfig,
  reconcileWorkspaceMcpRoots,
  workspaceMcpPaths,
  workspaceMcpStatus
} from '../../../src/workspace-mcp.mjs';
import { workspaceAppSyncStatus } from '../../../src/workspace-app-status.mjs';
import { installWorkspaceTunnelLaunchAgent } from '../workspace-mcp/install-launch-agent.mjs';
import { runRegisteredWorkspaceCanary } from '../workspace-mcp/run-registered-workspace-canary.mjs';
import { installDashboardLaunchAgent } from '../dashboard/install-launch-agent.mjs';
import { sealAiccRecoveryPointer } from '../../../src/aicc-recovery-command.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,63}$/i;
const APP_ID = 'dev.codexwebgpt.launcher';
const APP_PATH = '/Applications/Codex Web GPT.app';
const PRO_SLOT = '9224';
const ENDPOINTS = Object.freeze({ integrated: 17841, direct: 17842, ocx: 10100 });
const OBSERVER_PORT = 17843;
const DASHBOARD_PORT = 4381;
const DASHBOARD_LABEL = 'com.agenticlab.aicc-dashboard';
const GUIDANCE_SKILLS = Object.freeze([
  'agentic-website-maker',
  'browser-qa',
  'codex-frontend',
  'distill-conversation-archives',
  'generate-images-with-web-gpt',
  'high-risk-change',
  'maintain-llm-wiki',
  'manage-chatgpt-assets',
  'manage-codex-model-routes',
  'review-agent-platform-updates',
  'use-web-gpt'
]);
const RETRYABLE_FINAL_CALLBACK_ERRORS = new Set([
  'callback_destination_writer_busy',
  'callback_thread_active',
  'callback_turn_still_active',
  'callback_writer_busy'
]);
const LIVE_REPAIR_STAGE_ORDER = Object.freeze([
  'task-owned-native-cli-reconcile',
  'cold-survival-recovery',
  'codex-route-split',
  'account-3-lineage',
  'dashboard-recovery-gui',
  'codex-guidance',
  'launcher-aicc24',
  'workspace-business',
  'workspace-personal',
  'account-inventory-canaries',
  'recovery-gui-open',
  'callback-e2e',
  'desktop-reopen'
]);
const LIVE_REPAIR_STAGE_LABELS = Object.freeze({
  'task-owned-native-cli-reconcile': '현재 Codex 작업 종료 대기',
  'cold-survival-recovery': '꺼진 생존 경로 단발 복구',
  'initial-gate': '안전 게이트 확인',
  gate: '다음 구성요소 안전 게이트 확인',
  'codex-route-split': 'Native/AICC/Web/OCX 경로 분리 확인',
  'account-3-lineage': '기존 검토 결과 재사용',
  'dashboard-recovery-gui': '복구 대시보드 적용',
  'codex-guidance': 'Codex/AICC 지침 동기화',
  'launcher-aicc24': 'AICC 앱 최신화',
  'workspace-business': 'Business Workspace 복구',
  'workspace-personal': 'Personal Workspace 복구',
  'account-inventory-canaries': '세 계정 플러그인 검증',
  'recovery-gui-open': '복구 GUI 열기',
  'callback-e2e': 'Web GPT callback 종단 검증',
  'desktop-reopen': 'Codex Desktop 다시 열기',
  'final-callback': '현재 작업에 최종 결과 전달',
  terminal: '작업 종료'
});

function compactDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '계산 중';
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatKstTimestamp(milliseconds) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(milliseconds));
  const value = type => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')} KST`;
}

export function formatRepairProgressLine({ completed, total, stage, terminal, elapsedMs, remainingMs = null, reason = null }) {
  const safeCompleted = Number.isSafeInteger(completed) && completed >= 0 ? completed : 0;
  const safeTotal = Number.isSafeInteger(total) && total > 0 ? total : LIVE_REPAIR_STAGE_ORDER.length;
  const label = LIVE_REPAIR_STAGE_LABELS[stage] ?? String(stage ?? '상태 확인');
  const state = terminal === 'HOLD' || terminal === 'UNCERTAIN'
    ? `${terminal}: ${label}`
    : label;
  const terminalRemainingMs = new Set(['PASS', 'HOLD', 'UNCERTAIN', 'FAIL']).has(terminal) ? 0 : remainingMs;
  const eta = terminalRemainingMs === null ? '계산 중' : compactDuration(terminalRemainingMs);
  const suffix = reason ? ` · 사유 ${sanitizeError(reason).slice(0, 240)}` : '';
  return `AICC [${safeCompleted}/${safeTotal}] ${state} · 경과 ${compactDuration(elapsedMs)} · 예상 남음 ${eta}${suffix}`;
}

function createTerminalProgressReporter({ operation, file, stateFile, now = () => Date.now() }) {
  const startedAt = now();
  const completedStages = new Set();
  let lastStage = LIVE_REPAIR_STAGE_ORDER[0];
  let lastSampleAt = 0;
  const emit = (line, state) => {
    const output = `[${formatKstTimestamp(now())}] ${line}\n`;
    process.stdout.write(output);
    fs.appendFileSync(file, output, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(file, 0o600);
    atomicPrivateJson(stateFile, state);
  };
  emit(`AICC [0/${LIVE_REPAIR_STAGE_ORDER.length}] 시작 ${operation} · 경과 00:00 · 예상 남음 계산 중`, {
    schemaVersion: 1,
    operation,
    updatedAt: new Date(startedAt).toISOString(),
    percent: 0,
    completed: 0,
    total: LIVE_REPAIR_STAGE_ORDER.length,
    step: '시작',
    detail: '첫 checkpoint 대기',
    etaSeconds: null,
    deadlineAt: null,
    terminal: false,
    lastCheckpoint: null
  });
  return entry => {
    const timestamp = now();
    const sample = new Set(['sample_idle', 'sample_active', 'waiting_active', 'preflight']).has(entry.terminal);
    if (entry.stage !== 'gate' && entry.stage !== 'initial-gate' && entry.stage !== 'terminal') lastStage = entry.stage;
    if (sample && timestamp - lastSampleAt < 5_000) return;
    if (sample) lastSampleAt = timestamp;
    if (LIVE_REPAIR_STAGE_ORDER.includes(entry.stage)
      && new Set(['PASS', 'NOT_APPLICABLE']).has(entry.terminal)) completedStages.add(entry.stage);
    const elapsedMs = timestamp - startedAt;
    const completed = completedStages.size;
    const projectedRemainingMs = completed > 0 && completed < LIVE_REPAIR_STAGE_ORDER.length
      ? Math.round((elapsedMs / completed) * (LIVE_REPAIR_STAGE_ORDER.length - completed))
      : completed === LIVE_REPAIR_STAGE_ORDER.length ? 0 : null;
    const remainingMs = entry.stage === 'terminal'
      ? 0
      : entry.stage === 'final-callback' && Number.isFinite(entry.evidence?.remainingMs)
        ? Math.max(0, entry.evidence.remainingMs)
        : projectedRemainingMs;
    const terminalStage = entry.stage === 'terminal' ? lastStage : entry.stage;
    const terminalForLine = entry.stage === 'terminal' || entry.stage === 'final-callback'
      ? entry.terminal
      : null;
    const reason = entry.evidence?.code ?? entry.evidence?.message ?? entry.evidence?.errorCode ?? null;
    const line = formatRepairProgressLine({
      completed,
      total: LIVE_REPAIR_STAGE_ORDER.length,
      stage: terminalStage,
      terminal: terminalForLine,
      elapsedMs,
      remainingMs,
      reason: terminalForLine ? reason : null
    });
    const processTerminal = (entry.stage === 'final-callback' || entry.stage === 'terminal')
      && new Set(['PASS', 'HOLD', 'UNCERTAIN', 'FAIL']).has(entry.terminal);
    emit(line, {
      schemaVersion: 1,
      operation,
      updatedAt: new Date(timestamp).toISOString(),
      percent: Math.round((completed / LIVE_REPAIR_STAGE_ORDER.length) * 100),
      completed,
      total: LIVE_REPAIR_STAGE_ORDER.length,
      step: LIVE_REPAIR_STAGE_LABELS[terminalStage] ?? String(terminalStage),
      detail: terminalForLine ? `${entry.terminal}${reason ? ` · ${sanitizeError(reason).slice(0, 160)}` : ''}` : String(entry.terminal ?? '진행 중'),
      etaSeconds: remainingMs === null ? null : Math.max(0, Math.round(remainingMs / 1_000)),
      deadlineAt: entry.stage === 'final-callback' && Number.isFinite(remainingMs)
        ? new Date(timestamp + remainingMs).toISOString()
        : null,
      terminal: processTerminal,
      terminalStatus: processTerminal ? entry.terminal : null,
      operationStatus: entry.stage === 'terminal' ? entry.terminal : null,
      lastCheckpoint: [...completedStages].at(-1) ?? null
    });
  };
}

class LiveRepairError extends Error {
  constructor(code, message, data = null) {
    super(message);
    this.name = 'LiveRepairError';
    this.code = code;
    this.data = data;
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
}

function required(args, name, pattern = null) {
  const value = String(option(args, name) ?? '').trim();
  if (!value || (pattern && !pattern.test(value))) throw new LiveRepairError('invalid_option', `invalid ${name}`);
  return value;
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new LiveRepairError('unsafe_run_directory', 'run directory must be an owner-only real directory');
  }
  return fs.realpathSync(directory);
}

function atomicPrivateJson(file, value) {
  const parent = privateDirectory(path.dirname(file));
  if (parent !== path.dirname(file)) throw new LiveRepairError('result_parent_alias', 'result parent must be canonical');
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function appendJournal(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function sanitizeError(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/(?:remote_cap|local_read_cap|local_grant)_[A-Za-z0-9_-]+/g, '[capability redacted]')
    .slice(0, 4_000);
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
    cwd: options.cwd,
    env: options.env ?? process.env,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    input: options.input
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.allowFailure !== true) {
    const detail = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new LiveRepairError(options.failureCode ?? 'command_failed', `${path.basename(executable)} failed (${result.status}): ${detail.slice(0, 2_000)}`);
  }
  return { status: result.status, stdout: String(result.stdout ?? '').trim(), stderr: String(result.stderr ?? '').trim() };
}

function runJson(executable, args, options = {}) {
  const result = run(executable, args, options);
  try { return JSON.parse(result.stdout); }
  catch { throw new LiveRepairError(options.failureCode ?? 'command_output_invalid', `${path.basename(executable)} returned invalid JSON`); }
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function safeWorkSnapshot(work) {
  return {
    safe: work.safe === true,
    active: Array.isArray(work.active) ? work.active.map(item => ({ pid: item.pid ?? null, event: item.event ?? null, timestamp: item.timestamp ?? null })) : null,
    unknown: Array.isArray(work.unknown) ? work.unknown.map(item => ({ pid: item.pid ?? null, reason: item.reason ?? null, timestamp: item.timestamp ?? null })) : null
  };
}

export async function waitForExactIdle({ inspect = inspectCodexWork, maxWaitMs = 12 * 60 * 60_000, samples = 5, intervalMs = 1_000, onSample = () => {} } = {}) {
  const deadline = Date.now() + maxWaitMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    let work;
    try { work = inspect(); }
    catch (error) { throw new LiveRepairError('codex_gate_unknown', `Codex activity inspection failed: ${sanitizeError(error)}`); }
    if (!Array.isArray(work?.active) || !Array.isArray(work?.unknown) || work.unknown.length > 0) {
      throw new LiveRepairError('codex_gate_unknown', 'Codex ACTIVE/UNKNOWN gate contains UNKNOWN');
    }
    onSample(safeWorkSnapshot(work));
    if (work.active.length === 0 && work.safe === true) {
      consecutive += 1;
      if (consecutive >= samples) return { exactIdle: true, samples };
    } else {
      consecutive = 0;
    }
    await sleep(intervalMs);
  }
  throw new LiveRepairError('codex_gate_timeout', 'Codex tasks did not reach exact idle before the bounded deadline');
}

export async function reconcileTaskOwnedNativeCli({
  pid,
  expectedStartCommandSha256,
  inspect = inspectCodexWork,
  identify = processIdentity,
  terminate = targetPid => process.kill(targetPid, 'SIGTERM'),
  exists = targetPid => {
    try { process.kill(targetPid, 0); return true; }
    catch (error) { return error?.code === 'EPERM'; }
  },
  maxWaitMs = 12 * 60 * 60_000,
  intervalMs = 1_000,
  onSample = () => {}
} = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || !/^[a-f0-9]{64}$/.test(String(expectedStartCommandSha256 ?? ''))) {
    throw new LiveRepairError('native_cli_reconcile_invalid', 'task-owned Native CLI identity is invalid');
  }
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const work = inspect();
    if (!Array.isArray(work?.active) || !Array.isArray(work?.unknown)) {
      throw new LiveRepairError('codex_gate_unknown', 'Codex activity inspection returned an invalid shape');
    }
    const foreignUnknown = work.unknown.filter(item => item?.pid !== pid || item?.reason !== 'interactive_codex_without_rollout');
    if (foreignUnknown.length > 0 || work.unknown.length > 1) {
      throw new LiveRepairError('codex_gate_unknown', 'Codex gate contains a foreign or ambiguous UNKNOWN process');
    }
    onSample(safeWorkSnapshot(work));
    if (work.active.length > 0) {
      await sleep(intervalMs);
      continue;
    }
    if (work.unknown.length === 0) {
      if (work.safe !== true) throw new LiveRepairError('codex_gate_unknown', 'Codex gate is not safe after the task-owned CLI disappeared');
      return { terminal: 'NOT_APPLICABLE', pid, processAlreadyExited: true, mutation: false };
    }
    const identity = identify(pid);
    if (!identity || identity.startCommandSha256 !== expectedStartCommandSha256) {
      throw new LiveRepairError('native_cli_identity_conflict', 'task-owned Native CLI process identity changed; dispatch=0');
    }
    terminate(pid);
    const exitDeadline = Date.now() + 15_000;
    while (Date.now() < exitDeadline && exists(pid)) await sleep(250);
    if (exists(pid)) throw new LiveRepairError('native_cli_exit_hold', 'task-owned Native CLI did not exit after one graceful termination request');
    const post = inspect();
    if (post?.safe !== true || !Array.isArray(post.active) || post.active.length !== 0
      || !Array.isArray(post.unknown) || post.unknown.length !== 0) {
      throw new LiveRepairError('native_cli_postread_hold', 'Codex gate did not become exact idle after task-owned Native CLI reconciliation');
    }
    return { terminal: 'PASS', pid, processIdentity: identity, signal: 'SIGTERM', mutation: true, recovery: 'codex-native-rescue' };
  }
  throw new LiveRepairError('native_cli_reconcile_timeout', 'active Codex work did not finish before the task-owned Native CLI reconciliation deadline');
}

async function httpJson(port, pathname, accepted = [200]) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(2_500) });
    const body = await response.json().catch(() => null);
    return { ok: accepted.includes(response.status), status: response.status, body };
  } catch (error) {
    return { ok: false, status: null, body: null, error: sanitizeError(error) };
  }
}

function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const value = run('/bin/ps', ['-p', String(pid), '-o', 'lstart=,command='], { allowFailure: true, timeoutMs: 3_000 });
  if (value.status !== 0 || !value.stdout) return null;
  return { pid, startCommandSha256: sha256Bytes(value.stdout) };
}

function healthSummary(value) {
  const body = value?.body ?? {};
  const counters = {};
  for (const key of ['active_http_turns', 'active_browser_http_turns', 'active_browser_turns', 'active_turns']) {
    counters[key] = Number.isInteger(body[key]) ? body[key] : null;
  }
  return {
    status: value?.status ?? null,
    version: typeof body.version === 'string' ? body.version : null,
    mode: typeof body.mode === 'string' ? body.mode : null,
    pid: Number.isInteger(body.pid) ? body.pid : null,
    process: processIdentity(body.pid),
    acceptingTurns: body.accepting_turns === true,
    acceptingBrowserTurns: body.accepting_browser_turns === true,
    ready: body.ready === true || body.status === 'ready' || value?.status === 200,
    counters
  };
}

export async function runtimeSnapshot() {
  const [integratedHealth, integratedReady, directHealth, directReady, ocxHealth, ocxReady] = await Promise.all([
    httpJson(ENDPOINTS.integrated, '/healthz'), httpJson(ENDPOINTS.integrated, '/readyz'),
    httpJson(ENDPOINTS.direct, '/healthz'), httpJson(ENDPOINTS.direct, '/readyz'),
    httpJson(ENDPOINTS.ocx, '/healthz'), httpJson(ENDPOINTS.ocx, '/readyz')
  ]);
  return {
    integrated: { health: healthSummary(integratedHealth), ready: healthSummary(integratedReady) },
    direct: { health: healthSummary(directHealth), ready: healthSummary(directReady) },
    ocx: { health: healthSummary(ocxHealth), ready: healthSummary(ocxReady) },
    native: nativeRescueStatus()
  };
}

function launchdAbsent(result) {
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  return result?.status !== 0 && /Could not find service|service not found|Bad request/i.test(output);
}

async function waitForColdReady(check, { attempts = 120, intervalMs = 500, pause = sleep } = {}) {
  let latest = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latest = await check();
    if (latest?.ok) return latest;
    if (attempt + 1 < attempts) await pause(intervalMs);
  }
  throw new LiveRepairError('cold_service_readiness_timeout', 'configured service did not become ready after its one bootstrap', latest);
}

export async function recoverConfiguredSurvivalPaths(options = {}) {
  const inspectRuntime = options.inspectRuntime ?? runtimeSnapshot;
  const inspectObserver = options.inspectObserver ?? (async () => await httpJson(OBSERVER_PORT, '/healthz'));
  const inspectNative = options.inspectNative ?? nativeRescueStatus;
  const runCommand = options.runCommand ?? run;
  const pause = options.pause ?? sleep;
  const uid = Number(options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null));
  const home = options.home ?? os.homedir();
  if (!Number.isInteger(uid) || uid < 0) throw new LiveRepairError('cold_launchd_uid_unknown', 'launchd user domain is unknown');
  const nativeBefore = inspectNative();
  if (nativeBefore.ok !== true) throw new LiveRepairError('cold_native_not_ready', 'Native direct is not ready before survival recovery');
  const descriptors = [
    {
      id: 'web-direct-17842',
      label: 'com.agenticlab.aicc.web-gpt-rescue',
      plist: path.join(home, 'Library', 'LaunchAgents', 'com.agenticlab.aicc.web-gpt-rescue.plist'),
      ready: async () => {
        const value = await inspectRuntime();
        return { ok: evaluateDirectSurvival(value.direct).ok, value: value.direct };
      }
    },
    {
      id: 'ocx-direct-10100',
      label: 'com.opencodex.proxy',
      plist: path.join(home, 'Library', 'LaunchAgents', 'com.opencodex.proxy.plist'),
      ready: async () => {
        const value = await inspectRuntime();
        return { ok: value.ocx.health.ready && value.ocx.ready.ready, value: value.ocx };
      }
    },
    {
      id: 'integrated-17841',
      label: 'io.github.codex-chatgpt-web.daemon',
      plist: path.join(home, 'Library', 'LaunchAgents', 'io.github.codex-chatgpt-web.daemon.plist'),
      ready: async () => {
        const value = await inspectRuntime();
        return { ok: value.integrated.health.ready && value.integrated.health.acceptingTurns && allKnownZero(value.integrated), value: value.integrated };
      }
    },
    {
      id: 'observer-17843',
      label: 'dev.agenticlab.web-gpt-observer',
      plist: path.join(home, 'Library', 'LaunchAgents', 'dev.agenticlab.web-gpt-observer.plist'),
      ready: async () => {
        const value = await inspectObserver();
        return { ok: value?.status === 200, value: { status: value?.status ?? null } };
      }
    }
  ];
  const components = [];
  for (const descriptor of descriptors) {
    const before = await descriptor.ready();
    if (before.ok) {
      components.push({ id: descriptor.id, terminal: 'NOT_APPLICABLE', mutation: false });
      continue;
    }
    const job = runCommand('/bin/launchctl', ['print', `gui/${uid}/${descriptor.label}`], { allowFailure: true, timeoutMs: 10_000 });
    if (!launchdAbsent(job)) {
      throw new LiveRepairError('cold_service_registered_unhealthy', `${descriptor.id} is registered but not ready; kickstart/retry is forbidden`);
    }
    if (!fs.existsSync(descriptor.plist)) throw new LiveRepairError('cold_service_plist_missing', `${descriptor.id} LaunchAgent plist is missing`);
    const lint = runCommand('/usr/bin/plutil', ['-lint', descriptor.plist], { allowFailure: true, timeoutMs: 10_000 });
    if (lint.status !== 0) throw new LiveRepairError('cold_service_plist_invalid', `${descriptor.id} LaunchAgent plist is invalid`);
    const bootstrap = runCommand('/bin/launchctl', ['bootstrap', `gui/${uid}`, descriptor.plist], { allowFailure: true, timeoutMs: 30_000 });
    if (bootstrap.status !== 0) {
      throw new LiveRepairError('cold_service_bootstrap_failed', `${descriptor.id} one bootstrap failed; no retry is permitted`, { exitCode: bootstrap.status });
    }
    const after = await waitForColdReady(descriptor.ready, { attempts: Number(options.readyAttempts ?? 180), intervalMs: Number(options.intervalMs ?? 500), pause });
    components.push({ id: descriptor.id, terminal: 'PASS', mutation: true, plistSha256: sha256File(descriptor.plist), ready: after.value });
  }
  const nativeAfter = inspectNative();
  if (nativeAfter.ok !== true || nativeAfter.destination !== nativeBefore.destination) {
    throw new LiveRepairError('cold_native_identity_changed', 'Native direct identity changed during survival recovery');
  }
  return {
    ok: true,
    terminal: 'PASS',
    components,
    launcher: { terminal: 'DEFERRED_TO_VERSIONED_APP_STAGE', mutation: false },
    native: { destination: nativeAfter.destination }
  };
}

export function allKnownZero(route) {
  const counters = route?.health?.counters ?? {};
  const relevant = Object.values(counters).filter(value => value !== null);
  return relevant.length > 0 && relevant.every(value => value === 0);
}

export function evaluateDirectSurvival(route) {
  const legacyReadyNotApplicable = route?.health?.mode === 'browser-only' && route?.ready?.status === 404;
  const readyContract = route?.ready?.ready === true ? 'pass' : legacyReadyNotApplicable ? 'not_applicable' : 'fail';
  const counters = route?.health?.counters ?? {};
  const exactBrowserZero = ['active_http_turns', 'active_browser_http_turns', 'active_browser_turns']
    .every(key => Number.isInteger(counters[key]) && counters[key] === 0);
  return {
    ok: route?.health?.status === 200
      && route?.health?.ready === true
      && route?.health?.acceptingTurns === true
      && exactBrowserZero
      && readyContract !== 'fail',
    readyContract,
    legacyReadyNotApplicable
  };
}

function routeIdentity(route) {
  return JSON.stringify({ version: route?.health?.version ?? null, process: route?.health?.process ?? null });
}

export function assertSurvival(baseline, current, options = {}) {
  if (!evaluateDirectSurvival(current.direct).ok || routeIdentity(current.direct) !== routeIdentity(baseline.direct)) {
    throw new LiveRepairError('survival_route_changed', 'Web GPT direct 17842 survival identity changed');
  }
  const baselineOcxOff = baseline.ocx?.health?.status == null && baseline.ocx?.ready?.status == null;
  const currentOcxOff = current.ocx?.health?.status == null && current.ocx?.ready?.status == null;
  if (options.allowOcxOff === true && baselineOcxOff) {
    if (!currentOcxOff) throw new LiveRepairError('survival_route_changed', 'OCX 10100 changed from the preserved OFF state');
  } else if (!current.ocx.health.ready || !current.ocx.ready.ready || routeIdentity(current.ocx) !== routeIdentity(baseline.ocx)) {
    throw new LiveRepairError('survival_route_changed', 'OCX 10100 survival identity changed');
  }
  if (current.native.ok !== true || baseline.native.ok !== true || current.native.destination !== baseline.native.destination) {
    throw new LiveRepairError('survival_route_changed', 'Native rescue survival identity changed');
  }
}

function codexDesktopApplications() {
  const script = [
    'ObjC.import("AppKit");',
    'const apps=$.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.openai.codex");',
    'JSON.stringify(ObjC.deepUnwrap(apps.js.map(app => ({pid:Number(app.processIdentifier),terminated:Boolean(app.terminated)}))))'
  ].join(' ');
  const result = run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { allowFailure: true, timeoutMs: 10_000 });
  if (result.status !== 0) return { ok: false, applications: [] };
  try {
    return { ok: true, applications: JSON.parse(result.stdout).filter(item => !item.terminated && Number.isInteger(item.pid)) };
  } catch {
    return { ok: false, applications: [] };
  }
}

export async function releaseDesktopForOwnedCallbacks(options = {}) {
  const quitDesktop = options.quitDesktop ?? quitCodexDesktopOnce;
  const inspectRuntime = options.inspectRuntime ?? runtimeSnapshot;
  const expectedPid = Number(options.expectedPid);
  if (!Number.isInteger(expectedPid) || expectedPid <= 1) throw new LiveRepairError('callback_desktop_pid_invalid', 'exact Desktop PID is required');
  const result = quitDesktop({
    expectedPid,
    maxSamples: Number(options.maxSamples ?? 3_600),
    progress: options.progress ?? (() => {})
  });
  if (!result?.ok || result.operation !== 'quit' || result.oldPid !== expectedPid || result.newPid !== null || result.forcedTermination !== false) {
    throw new LiveRepairError('callback_desktop_release_failed', 'Desktop did not release the task writer through one graceful quit');
  }
  const after = await inspectRuntime();
  assertSurvival(options.baseline, after);
  return { ok: true, oldPid: expectedPid, released: true, quitCount: result.quitCount, forcedTermination: false };
}

export async function reopenDesktopAfterOwnedCallbacks(options = {}) {
  const inspectApps = options.inspectApps ?? codexDesktopApplications;
  const inspectRuntime = options.inspectRuntime ?? runtimeSnapshot;
  const runCommand = options.runCommand ?? run;
  const pause = options.pause ?? sleep;
  const before = inspectApps();
  if (!before.ok || before.applications.length !== 0) {
    throw new LiveRepairError('callback_desktop_reopen_precondition', 'Desktop is not proven closed before the one reopen');
  }
  const opened = runCommand('/usr/bin/open', ['-b', 'com.openai.codex'], { allowFailure: true, timeoutMs: 30_000 });
  if (opened.status !== 0) throw new LiveRepairError('callback_desktop_reopen_failed', 'Desktop one-shot reopen request failed');
  options.progress?.({ attempt: 0, state: 'open_requested', remainingMs: Number(options.readyAttempts ?? 180) * Number(options.intervalMs ?? 500) });
  for (let attempt = 0; attempt < Number(options.readyAttempts ?? 180); attempt += 1) {
    const apps = inspectApps();
    const runtime = await inspectRuntime();
    let survival = null;
    try {
      assertSurvival(options.baseline, runtime);
      survival = true;
    } catch {
      survival = false;
    }
    const integratedReady = runtime.integrated.health.ready
      && runtime.integrated.ready.ready
      && runtime.integrated.health.acceptingTurns
      && runtime.integrated.health.acceptingBrowserTurns
      && allKnownZero(runtime.integrated);
    if (apps.ok && apps.applications.length === 1 && survival && integratedReady) {
      return { ok: true, reopened: true, newPid: apps.applications[0].pid, openCount: 1 };
    }
    if (attempt % 10 === 0) {
      options.progress?.({
        attempt: attempt + 1,
        state: 'waiting_readiness',
        applications: apps.ok ? apps.applications.length : null,
        routesReady: survival && integratedReady,
        remainingMs: Math.max(0, (Number(options.readyAttempts ?? 180) - attempt - 1) * Number(options.intervalMs ?? 500))
      });
    }
    if (attempt + 1 < Number(options.readyAttempts ?? 180)) await pause(Number(options.intervalMs ?? 500));
  }
  throw new LiveRepairError('callback_desktop_reopen_readiness_timeout', 'Desktop or preserved routes did not become ready after the one reopen');
}

function appVersion(appPath) {
  return run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(appPath, 'Contents', 'Info.plist')], { timeoutMs: 5_000 }).stdout;
}

function verifyApp(appPath, expectedVersion) {
  const verified = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { allowFailure: true, timeoutMs: 30_000 });
  const version = appVersion(appPath);
  if (verified.status !== 0 || version !== expectedVersion) throw new LiveRepairError('app_candidate_invalid', 'candidate app signature or version did not match');
  return { version, signature: 'pass' };
}

function appMainPids(appPath = APP_PATH) {
  const executable = `${appPath}/Contents/MacOS/Codex Web GPT`;
  const ps = run('/bin/ps', ['-axo', 'pid=,command='], { timeoutMs: 5_000 });
  return ps.stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match && match[2] === executable ? [Number(match[1])] : [];
  });
}

async function waitUntil(check, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await check();
    if (last?.ok === true) return last;
    await sleep(intervalMs);
  }
  throw new LiveRepairError('postread_timeout', `bounded post-read timed out: ${JSON.stringify(last)}`);
}

function resolveRole(publicRoot, role) {
  return runJson('pwsh', [
    '-NoProfile', '-File', path.join(publicRoot, 'tools', 'platform', 'core', 'Read-AiccCoordination.ps1'),
    '-WebGptRole', role
  ], { failureCode: 'account_binding_unknown', timeoutMs: 30_000 });
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function guidanceCommand(options, { plan = false } = {}) {
  const script = path.join(options.publicRoot, 'tools', 'platform', 'core', 'deploy_active_skills.ps1');
  const skillArray = GUIDANCE_SKILLS.map(powershellLiteral).join(',');
  return `& ${powershellLiteral(script)} -AiccRoot ${powershellLiteral(options.publicRoot)} -TargetGroups @('codex') -SkillNames @(${skillArray})${plan ? ' -Plan' : ''} -SummaryOnly -AsJson`;
}

function backupDirectory(source, destination) {
  if (!fs.existsSync(source)) throw new LiveRepairError('guidance_preimage_missing', `managed guidance preimage is missing: ${path.basename(source)}`);
  if (fs.existsSync(destination)) throw new LiveRepairError('guidance_backup_conflict', `guidance backup already exists: ${path.basename(destination)}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  run('/usr/bin/ditto', [source, destination], { timeoutMs: 60_000 });
}

function routePreimageTargets(options) {
  const resolved = routeLauncherPaths();
  return [
    path.join(os.homedir(), '.codex', 'config.toml'),
    path.join(os.homedir(), '.codex-chatgpt-web', 'codex', 'integration-journal.json'),
    resolved.manifest,
    resolved.aiccCatalog,
    resolved.ocxCatalog,
    ...routeLauncherStatus().routes.map(item => item.destination)
  ];
}

function backupRouteSplit(options) {
  const root = privateDirectory(path.join(options.runDir, 'preimage', 'route-split'));
  const manifestFile = path.join(root, 'manifest.json');
  if (fs.existsSync(manifestFile)) throw new LiveRepairError('route_preimage_conflict', 'route split preimage already exists');
  const entries = routePreimageTargets(options).map((target, index) => {
    const exists = fs.existsSync(target);
    const backup = exists ? path.join(root, `${String(index).padStart(2, '0')}.bin`) : null;
    if (exists) {
      fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backup, 0o600);
    }
    return {
      target,
      exists,
      mode: exists ? fs.statSync(target).mode & 0o777 : null,
      sha256: exists ? sha256File(target) : null,
      backup
    };
  });
  atomicPrivateJson(manifestFile, { schemaVersion: 1, operation: options.operation, entries });
  return { root, manifestFile, manifestSha256: sha256File(manifestFile) };
}

export function restoreRouteSplitPreimage({ runDir, operation, expectedTargets = routePreimageTargets({}) }) {
  const root = path.join(runDir, 'preimage', 'route-split');
  const manifestFile = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new LiveRepairError('route_preimage_missing', 'route split preimage manifest is missing');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest?.schemaVersion !== 1 || manifest?.operation !== operation || !Array.isArray(manifest.entries)) {
    throw new LiveRepairError('route_preimage_invalid', 'route split preimage manifest is invalid');
  }
  const expected = new Set(expectedTargets);
  if (manifest.entries.length !== expected.size || manifest.entries.some(item => !expected.has(item.target))) {
    throw new LiveRepairError('route_preimage_scope_mismatch', 'route split preimage targets do not match the fixed route scope');
  }
  for (const entry of manifest.entries) {
    if (entry.exists && (!entry.backup || !fs.existsSync(entry.backup) || sha256File(entry.backup) !== entry.sha256)) {
      throw new LiveRepairError('route_preimage_hash_mismatch', 'route split backup hash does not match');
    }
  }
  const displacedRoot = privateDirectory(path.join(runDir, 'rollback-displaced', 'route-split'));
  const marker = path.join(displacedRoot, 'completed.json');
  if (fs.existsSync(marker)) throw new LiveRepairError('route_rollback_replay', 'route split rollback already completed');
  for (const [index, entry] of manifest.entries.entries()) {
    const displaced = path.join(displacedRoot, `${String(index).padStart(2, '0')}.bin`);
    if (fs.existsSync(entry.target)) fs.copyFileSync(entry.target, displaced, fs.constants.COPYFILE_EXCL);
    if (!entry.exists) {
      fs.rmSync(entry.target, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(entry.target), { recursive: true, mode: 0o700 });
    const temporary = `${entry.target}.aicc-rollback-${process.pid}`;
    fs.copyFileSync(entry.backup, temporary, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporary, entry.mode);
    fs.renameSync(temporary, entry.target);
  }
  atomicPrivateJson(marker, { schemaVersion: 1, operation, completedAt: new Date().toISOString() });
  return { ok: true, action: 'routes', restoredCount: manifest.entries.length, displacedRoot };
}

export function evaluateRouteSplitStatus(status, journal) {
  const expected = new Set(['codex-aicc', 'codex-web', 'codex-ocx']);
  const routes = Array.isArray(status?.routes) ? status.routes : [];
  const observed = new Set(routes.map(item => item?.name));
  return {
    desired: status?.ok === true
      && status?.defaultCodex?.native === true
      && journal?.active === false
      && routes.length === expected.size
      && [...expected].every(name => observed.has(name))
      && routes.every(item => item?.ready === true && item?.sourceSha256 === item?.installedSha256),
    defaultNative: status?.defaultCodex?.native === true,
    journalInactive: journal?.active === false,
    namedRoutesReady: routes.length === expected.size
      && [...expected].every(name => observed.has(name))
      && routes.every(item => item?.ready === true && item?.sourceSha256 === item?.installedSha256)
  };
}

async function ensureNativeDefaultAndNamedRoutes(options, baseline) {
  const journalPath = path.join(os.homedir(), '.codex-chatgpt-web', 'codex', 'integration-journal.json');
  const before = routeLauncherStatus();
  let journal = null;
  try { journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')); }
  catch { /* A missing or malformed journal is not the desired state and must not be inferred as inactive. */ }
  const evaluated = evaluateRouteSplitStatus(before, journal);
  if (evaluated.desired) {
    assertSurvival(baseline, await runtimeSnapshot());
    return {
      terminal: 'NOT_APPLICABLE',
      mutation: false,
      reason: 'exact_desired_state_already_installed',
      defaultCodex: before.defaultCodex,
      namedRoutes: before.routes.map(item => ({ name: item.name, ready: item.ready, installedSha256: item.installedSha256 })),
      fallback: false
    };
  }
  const backup = backupRouteSplit(options);
  const recovery = sealStageRecovery(options, 'routes', backup.root);
  const installed = await installRouteLaunchers();
  if (!installed.ok) throw new LiveRepairError('route_launcher_install_failed', 'named Codex route launchers did not install exactly');
  const routeCli = path.join(APP_PATH, 'Contents', 'Resources', 'runtime', 'bin', 'codex-chatgpt-web');
  const disconnected = run(routeCli, ['route', 'disconnect'], { timeoutMs: 60_000, failureCode: 'native_default_disconnect_failed' });
  journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  const post = routeLauncherStatus();
  if (!post.ok || post.defaultCodex.native !== true || journal.active !== false) {
    throw new LiveRepairError('native_default_postread_failed', 'default Codex route or named launcher post-read did not match the isolated route contract');
  }
  const statuses = {};
  for (const name of ['codex-native-rescue', 'codex-aicc', 'codex-web', 'codex-ocx']) {
    const command = path.join(os.homedir(), '.local', 'bin', name);
    const result = run(command, ['--status'], { timeoutMs: 10_000, failureCode: `${name}_status_failed` });
    statuses[name] = sha256Bytes(result.stdout);
  }
  assertSurvival(baseline, await runtimeSnapshot());
  return {
    terminal: 'PASS',
    mutation: true,
    backup,
    recovery,
    disconnectOutputSha256: sha256Bytes(disconnected.stdout),
    defaultCodex: post.defaultCodex,
    namedRoutes: post.routes.map(item => ({ name: item.name, ready: item.ready, installedSha256: item.installedSha256 })),
    statusOutputSha256: statuses,
    fallback: false
  };
}

function stageRecoveryWrapper(options, component) {
  const worker = path.resolve(fileURLToPath(import.meta.url));
  const expectedWorkerSha256 = sha256File(worker);
  return `#!/bin/zsh
set -eu
MODE="\${1:---status}"
WORKER=${JSON.stringify(worker)}
EXPECTED=${JSON.stringify(expectedWorkerSha256)}
OBSERVED="$(shasum -a 256 "$WORKER" | awk '{print $1}')"
test "$OBSERVED" = "$EXPECTED" || { echo "HOLD: recovery worker drift; dispatch=0" >&2; exit 3; }
case "$MODE" in
  status|--status) RECOVERY_MODE=status ;;
  dry-run|--dry-run) RECOVERY_MODE=dry-run ;;
  apply) RECOVERY_MODE=apply ;;
  *) echo "Usage: $0 [--status|--dry-run|apply]" >&2; exit 2 ;;
esac
exec ${JSON.stringify(process.execPath)} "$WORKER" --recovery-component ${JSON.stringify(component)} --recovery-mode "$RECOVERY_MODE" --run-dir ${JSON.stringify(options.runDir)}
`;
}

function sealStageRecovery(options, component, backup) {
  const directory = privateDirectory(path.join(options.runDir, 'recovery'));
  const script = path.join(directory, `${component}.sh`);
  if (fs.existsSync(script)) throw new LiveRepairError('recovery_wrapper_conflict', `recovery wrapper already exists for ${component}`);
  fs.writeFileSync(script, stageRecoveryWrapper(options, component), { mode: 0o700, flag: 'wx' });
  fs.chmodSync(script, 0o700);
  const sealed = sealAiccRecoveryPointer({
    script,
    component,
    operationId: options.operation,
    backup
  });
  return { script, pointerFile: sealed.pointerFile, scriptSha256: sealed.pointer.scriptSha256 };
}

function repairGuidanceDeployment(options) {
  const skillRoot = path.join(os.homedir(), '.codex', 'skills');
  const manifest = path.join(skillRoot, '.aicc-guidance-deployment.json');
  const backupRoot = path.join(options.runDir, 'preimage', 'codex-guidance');
  const plan = runJson('pwsh', ['-NoProfile', '-Command', guidanceCommand(options, { plan: true })], {
    failureCode: 'guidance_plan_failed', timeoutMs: 60_000
  });
  const planned = [...(plan.planned_deploy_skills ?? [])].sort();
  if (plan.dry_run !== true || plan.refused_count !== 0 || JSON.stringify(planned) !== JSON.stringify([...GUIDANCE_SKILLS].sort())) {
    throw new LiveRepairError('guidance_plan_drift', 'Codex guidance deployment plan did not match the exact managed skill set');
  }
  for (const name of GUIDANCE_SKILLS) backupDirectory(path.join(skillRoot, name), path.join(backupRoot, 'skills', name));
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  fs.copyFileSync(manifest, path.join(backupRoot, '.aicc-guidance-deployment.json'), fs.constants.COPYFILE_EXCL);
  const recovery = sealStageRecovery(options, 'guidance', backupRoot);
  const applied = runJson('pwsh', ['-NoProfile', '-Command', guidanceCommand(options)], {
    failureCode: 'guidance_deploy_failed', timeoutMs: 120_000
  });
  const deployed = [...(applied.deployed_skills ?? [])].sort();
  if (applied.status !== 'ok' || applied.refused_count !== 0 || JSON.stringify(deployed) !== JSON.stringify([...GUIDANCE_SKILLS].sort())) {
    throw new LiveRepairError('guidance_deploy_uncertain', 'Codex guidance deployment did not report the exact managed skill set');
  }
  const inspected = runJson('pwsh', [
    '-NoProfile', '-File', path.join(options.publicRoot, 'tools', 'platform', 'inspect', 'Inspect-AgentSkills.ps1'),
    '-AiccRoot', options.publicRoot, '-TargetGroups', 'codex', '-SummaryOnly', '-AsJson'
  ], { failureCode: 'guidance_postread_failed', timeoutMs: 60_000 });
  if (inspected.ok !== true || inspected.deployment_issue_count !== 0 || inspected.manifest_issue_count !== 0) {
    throw new LiveRepairError('guidance_postread_failed', 'Codex installed guidance remains out of sync after deployment');
  }
  return { deployedSkills: deployed, backupRoot, recovery, postRead: { ok: true, unmanagedExtrasPreserved: inspected.unmanaged_extra_count ?? null } };
}

async function restartDashboard(options, baseline) {
  const sourceRecovery = path.join(options.publicRoot, '.aicc-recovery', 'gui-final-20260825', 'restore.sh');
  const sourceManifest = path.join(options.publicRoot, '.aicc-recovery', 'gui-final-20260825', 'postimage.sha256');
  if (!fs.existsSync(sourceRecovery) || !fs.existsSync(sourceManifest)) {
    throw new LiveRepairError('dashboard_recovery_unsealed', 'dashboard source rollback bundle is not fully sealed');
  }
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${DASHBOARD_LABEL}.plist`);
  const backupRoot = privateDirectory(path.join(options.runDir, 'preimage', 'dashboard'));
  const plistBackup = path.join(backupRoot, `${DASHBOARD_LABEL}.plist`);
  if (!fs.existsSync(plist) || fs.existsSync(plistBackup)) throw new LiveRepairError('dashboard_preimage_conflict', 'dashboard LaunchAgent preimage is missing or already exists');
  fs.copyFileSync(plist, plistBackup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(plistBackup, 0o600);
  const recovery = sealStageRecovery(options, 'dashboard', backupRoot);
  let installed;
  try {
    installed = installDashboardLaunchAgent({ root: options.publicRoot, port: DASHBOARD_PORT });
  } catch (error) {
    throw new LiveRepairError('dashboard_launchagent_failed', sanitizeError(error));
  }
  const post = await waitUntil(async () => {
    const health = await httpJson(DASHBOARD_PORT, '/healthz');
    const latest = await httpJson(DASHBOARD_PORT, '/api/recovery/latest');
    return {
      ok: health.status === 200
        && latest.status === 200
        && latest.body?.available === true
        && latest.body?.component === 'dashboard',
      health: health.status,
      recovery: latest.body ? { state: latest.body.state, component: latest.body.component } : null
    };
  }, 60_000, 500);
  assertSurvival(baseline, await runtimeSnapshot());
  return {
    launchd: { label: installed.label, unloadConfirmed: installed.unloadConfirmed, unloadSamples: installed.unloadSamples, bootstrapAttempts: installed.bootstrapAttempts, registeredAfterBootstrapError: installed.registeredAfterBootstrapError },
    sourceRecoverySha256: sha256File(sourceRecovery),
    sourceManifestSha256: sha256File(sourceManifest),
    recovery,
    post
  };
}

function runPrivateJson(options, args, failureCode, timeoutMs = 15 * 60_000) {
  return runJson(options.bun, args, { cwd: options.privateRoot, timeoutMs, failureCode });
}

function safeBrowserResult(result) {
  return {
    mode: result.mode ?? null,
    model: result.model ?? null,
    conversationUrlHash: result.conversationUrl ? sha256Bytes(result.conversationUrl) : null,
    sidebarListed: result.sidebarListed === true,
    reloadVerified: result.reloadVerified === true,
    authenticatedApiVerified: result.authenticatedApiVerified === true,
    identityVerified: result.identityVerified === true,
    userTurns: Number.isInteger(result.userTurns) ? result.userTurns : null,
    assistantTurns: Number.isInteger(result.assistantTurns) ? result.assistantTurns : null,
    authenticatedAssistantNodes: Number.isInteger(result.authenticatedAssistantNodes) ? result.authenticatedAssistantNodes : null,
    assistantMessageIdSha256: /^[a-f0-9]{64}$/.test(result.assistantMessageIdSha256 ?? '') ? result.assistantMessageIdSha256 : null,
    attachments: Number.isInteger(result.attachments) ? result.attachments : null,
    expectedPromptSha256: /^[a-f0-9]{64}$/.test(result.expectedPromptSha256 ?? '') ? result.expectedPromptSha256 : null,
    submissions: Number.isInteger(result.submissions) ? result.submissions : null,
    remoteMutation: result.remoteMutation === true
  };
}

export function evaluateProSavedChatLineage(result) {
  const failures = [];
  if (result?.mode !== 'Chat') failures.push('mode');
  if (result?.model !== 'Pro') failures.push('model');
  if (result?.remoteMutation !== false) failures.push('remote_mutation');
  if (result?.submissions !== 0) failures.push('submission_count');
  if (result?.reloadVerified !== true) failures.push('reload');
  if (result?.authenticatedApiVerified !== true) failures.push('authenticated_api');
  if (result?.identityVerified !== true) failures.push('identity');
  if (result?.userTurns !== 1) failures.push('visible_user_turn');
  if (result?.assistantTurns !== 1) failures.push('visible_assistant_turn');
  if (!Number.isInteger(result?.authenticatedAssistantNodes) || result.authenticatedAssistantNodes < 1) failures.push('authenticated_assistant_nodes');
  if (!/^[a-f0-9]{64}$/.test(result?.assistantMessageIdSha256 ?? '')) failures.push('assistant_lineage_hash');
  return {
    ok: failures.length === 0,
    failures,
    sidebarObservation: result?.sidebarListed === true ? 'listed' : 'not_listed'
  };
}

async function verifyProSavedChat(options) {
  const result = runPrivateJson(options, [
    path.join(options.privateRoot, 'scripts', 'chatgpt-pro-chat-review.mjs'),
    '--lease-helper', options.leaseHelper,
    '--owner-id', `${options.operation}.pro-lineage`,
    '--slot-port', PRO_SLOT,
    '--verify-saved-task-chat', options.savedProChat,
    '--expected-prompt-file', options.savedProPrompt,
    '--expected-receipt-file', options.savedProReceipt
  ], 'pro_saved_chat_postread_failed');
  const evaluation = evaluateProSavedChatLineage(result);
  if (!evaluation.ok) {
    throw new LiveRepairError('pro_saved_chat_lineage_failed', `account 3 saved Chat lineage post-read did not pass: ${evaluation.failures.join(',')}`);
  }
  return { ...safeBrowserResult(result), lineage: evaluation };
}

function readJournalEntries(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try { return JSON.parse(line); }
      catch { throw new LiveRepairError('resume_journal_malformed', `resume journal line ${index + 1} is malformed`); }
    });
}

export function loadResumeEvidence(options) {
  if (!options.resumeFromRun) return null;
  const artifactsRoot = fs.realpathSync(path.join(os.homedir(), '.ai-control-center', 'artifacts-private'));
  const resumeRoot = fs.realpathSync(options.resumeFromRun);
  const stat = fs.lstatSync(resumeRoot);
  if (!resumeRoot.startsWith(`${artifactsRoot}${path.sep}`) || !stat.isDirectory() || stat.isSymbolicLink()
    || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new LiveRepairError('resume_scope_denied', 'resume evidence must be an owner-only real directory under artifacts-private');
  }
  if (resumeRoot === options.runDir) throw new LiveRepairError('resume_self_reference', 'a run cannot resume from itself');
  const journalFile = path.join(resumeRoot, 'journal.jsonl');
  const finalFile = path.join(resumeRoot, 'final-result.json');
  if (!fs.existsSync(journalFile) || !fs.existsSync(finalFile)) throw new LiveRepairError('resume_evidence_missing', 'resume journal or final result is missing');
  if (sha256File(journalFile) !== options.resumeEvidenceSha256) throw new LiveRepairError('resume_evidence_drift', 'resume journal hash changed');
  const final = JSON.parse(fs.readFileSync(finalFile, 'utf8'));
  if (!['HOLD', 'UNCERTAIN'].includes(final.status) || final.noReplay !== true) {
    throw new LiveRepairError('resume_terminal_invalid', 'resume source must be a no-replay HOLD or UNCERTAIN run');
  }
  const entries = readJournalEntries(journalFile);
  const completed = new Map();
  for (const entry of entries) {
    if (new Set(['PASS', 'NOT_APPLICABLE']).has(entry.terminal)) completed.set(entry.stage, entry);
  }
  for (const stage of ['cold-survival-recovery', 'codex-route-split', 'account-3-lineage', 'dashboard-recovery-gui', 'codex-guidance', 'launcher-aicc24']) {
    if (!completed.has(stage)) throw new LiveRepairError('resume_stage_incomplete', `resume source did not complete ${stage}`);
  }
  const lineage = completed.get('account-3-lineage').evidence;
  if (lineage.conversationUrlHash !== sha256Bytes(options.savedProChat)
    || lineage.expectedPromptSha256 !== sha256File(options.savedProPrompt)
    || !evaluateProSavedChatLineage(lineage).ok) {
    throw new LiveRepairError('resume_pro_lineage_drift', 'sealed Pro evidence does not match the current exact saved Chat tuple');
  }
  return { root: resumeRoot, journalFile, finalFile, journalSha256: options.resumeEvidenceSha256, final, completed };
}

async function verifyResumeCompletedStages(options, resume, baseline) {
  const observer = await httpJson(OBSERVER_PORT, '/healthz');
  const direct = evaluateDirectSurvival(baseline.direct);
  if (!baseline.integrated.health.ready || !baseline.integrated.ready.ready
    || !baseline.integrated.health.acceptingTurns || !baseline.integrated.health.acceptingBrowserTurns
    || !allKnownZero(baseline.integrated) || !direct.ok
    || !baseline.ocx.health.ready || !baseline.ocx.ready.ready || baseline.native.ok !== true
    || observer.status !== 200) {
    throw new LiveRepairError('resume_survival_drift', 'a preserved survival path is not strictly ready for resume');
  }

  const routeJournalPath = path.join(os.homedir(), '.codex-chatgpt-web', 'codex', 'integration-journal.json');
  let routeJournal;
  try { routeJournal = JSON.parse(fs.readFileSync(routeJournalPath, 'utf8')); }
  catch { throw new LiveRepairError('resume_route_journal_unknown', 'Native route journal cannot be verified'); }
  const route = routeLauncherStatus();
  if (!evaluateRouteSplitStatus(route, routeJournal).desired) throw new LiveRepairError('resume_route_drift', 'Native default or named route split drifted');

  const priorDashboard = resume.completed.get('dashboard-recovery-gui').evidence;
  const dashboardRecovery = path.join(options.publicRoot, '.aicc-recovery', 'gui-final-20260825', 'restore.sh');
  const dashboardManifest = path.join(options.publicRoot, '.aicc-recovery', 'gui-final-20260825', 'postimage.sha256');
  const dashboardHealth = await httpJson(DASHBOARD_PORT, '/healthz');
  const dashboardLatest = await httpJson(DASHBOARD_PORT, '/api/recovery/latest');
  if (dashboardHealth.status !== 200 || dashboardLatest.status !== 200 || dashboardLatest.body?.available !== true
    || sha256File(dashboardRecovery) !== priorDashboard.sourceRecoverySha256
    || sha256File(dashboardManifest) !== priorDashboard.sourceManifestSha256) {
    throw new LiveRepairError('resume_dashboard_drift', 'Dashboard or its sealed recovery source drifted');
  }

  const inspected = runJson('pwsh', [
    '-NoProfile', '-File', path.join(options.publicRoot, 'tools', 'platform', 'inspect', 'Inspect-AgentSkills.ps1'),
    '-AiccRoot', options.publicRoot, '-TargetGroups', 'codex', '-SummaryOnly', '-AsJson'
  ], { failureCode: 'resume_guidance_postread_failed', timeoutMs: 60_000 });
  if (inspected.ok !== true || inspected.deployment_issue_count !== 0 || inspected.manifest_issue_count !== 0) {
    throw new LiveRepairError('resume_guidance_drift', 'installed Codex guidance drifted after the prior PASS');
  }
  verifyApp(APP_PATH, options.expectedAppVersion);
  if (appVersion(APP_PATH) !== options.expectedAppVersion) throw new LiveRepairError('resume_app_drift', 'installed AICC app version drifted');

  const workspaces = {};
  for (const specification of [
    { key: 'business', stage: 'workspace-business', surface: 'business-full', toolCount: 22, readToolCount: 17, writeToolCount: 5 },
    { key: 'personal', stage: 'workspace-personal', surface: 'personal-read-fetch', toolCount: 18, readToolCount: 18, writeToolCount: 0 }
  ]) {
    const prior = resume.completed.get(specification.stage)?.evidence ?? null;
    if (!prior) {
      workspaces[specification.key] = null;
      continue;
    }
    const current = await workspaceMcpStatus({ surfaceProfile: specification.surface });
    const evaluation = evaluateReusableWorkspaceStage({ current, prior, ...specification });
    workspaces[specification.key] = evaluation.ok
      ? { ...prior, mutation: false, reused: true, currentPostRead: evaluation.postRead }
      : null;
  }

  let accounts = null;
  const priorAccounts = resume.completed.get('account-inventory-canaries')?.evidence ?? null;
  if (priorAccounts) {
    const topology = workspaceAppSyncStatus();
    const roleIdentities = Object.fromEntries(['pro', 'default', 'secondary'].map(role => [role, resolveRole(options.publicRoot, role)]));
    const evaluation = evaluateReusableAccountInventoryStage({ prior: priorAccounts, topology, roleIdentities });
    if (evaluation.ok) accounts = { ...priorAccounts, reused: true, remoteMutation: false, currentPostRead: evaluation.postRead };
  }

  const priorRecoveryGui = resume.completed.get('recovery-gui-open')?.evidence ?? null;
  const recoveryGui = priorRecoveryGui?.openedOnce === true && dashboardHealth.status === 200
    ? { ...priorRecoveryGui, reused: true, openedOnce: false, currentPostRead: { health: 200 } }
    : null;

  return {
    survival: { mutation: false, currentStrictReadiness: true, observer: 200 },
    route: { mutation: false, defaultNative: true, namedRoutes: route.routes.map(item => item.name) },
    pro: { ...resume.completed.get('account-3-lineage').evidence, reused: true, submissions: 0, remoteMutation: false },
    dashboard: {
      mutation: false,
      health: 200,
      recoveryAvailable: true,
      sourceRecoverySha256: sha256File(dashboardRecovery),
      sourceManifestSha256: sha256File(dashboardManifest)
    },
    guidance: { mutation: false, unmanagedExtrasPreserved: inspected.unmanaged_extra_count ?? null },
    app: { mutation: false, version: appVersion(APP_PATH), strictIntegratedReady: true },
    workspaces,
    accounts,
    recoveryGui
  };
}

export function evaluateReusableWorkspaceStage({ current, prior, surface, toolCount, readToolCount, writeToolCount }) {
  const failures = [];
  if (prior?.surface !== surface || prior?.canary?.ok !== true || prior?.canary?.surface !== surface) failures.push('prior_canary');
  if (current?.state !== 'ready' || current?.serverReady !== true) failures.push('server_ready');
  if (current?.remoteAuthority?.runtimeReady !== true || current?.remoteAuthority?.activeLeases !== 0) failures.push('authority_ready');
  if (current?.tunnel?.running !== true || current?.tunnel?.healthy !== true || current?.tunnel?.ready !== true) failures.push('tunnel_ready');
  if (current?.publication?.toolCount !== toolCount
    || current?.publication?.readToolCount !== readToolCount
    || current?.publication?.writeToolCount !== writeToolCount) failures.push('tool_manifest');
  if (prior?.sourceManifest?.toolCount !== toolCount
    || prior?.sourceManifest?.readToolCount !== readToolCount
    || prior?.sourceManifest?.writeToolCount !== writeToolCount) failures.push('prior_manifest');
  if (surface === 'business-full' && (prior?.canary?.write !== true || prior?.canary?.readback !== true || prior?.canary?.rollback !== 'pass')) failures.push('business_canary');
  if (surface === 'personal-read-fetch' && (prior?.canary?.forgedWriteDenied !== true || prior?.canary?.readback !== true || prior?.canary?.rollback !== 'not_applicable')) failures.push('personal_canary');
  return {
    ok: failures.length === 0,
    failures,
    postRead: {
      state: current?.state ?? null,
      serverReady: current?.serverReady === true,
      runtimeReady: current?.remoteAuthority?.runtimeReady === true,
      activeLeases: current?.remoteAuthority?.activeLeases ?? null,
      tunnelReady: current?.tunnel?.ready === true,
      toolCount: current?.publication?.toolCount ?? null,
      readToolCount: current?.publication?.readToolCount ?? null,
      writeToolCount: current?.publication?.writeToolCount ?? null
    }
  };
}

export function evaluateReusableAccountInventoryStage({ prior, topology, roleIdentities }) {
  const failures = [];
  const expected = [
    { role: 'pro', accountIndex: 3 },
    { role: 'default', accountIndex: 1 },
    { role: 'secondary', accountIndex: 2 }
  ];
  const accounts = Array.isArray(prior?.accounts) ? prior.accounts : [];
  const bindings = Array.isArray(topology?.accountBindings) ? topology.accountBindings : [];
  if (accounts.length !== 3 || bindings.length !== 3) failures.push('account_count');
  for (const specification of expected) {
    const identity = roleIdentities?.[specification.role];
    const binding = bindings.find(item => item.accountAlias === identity?.accountAlias);
    const account = accounts.find(item => item.accountIndex === specification.accountIndex);
    if (!identity?.accountAlias || !binding || !account) {
      failures.push(`account_${specification.accountIndex}_binding`);
      continue;
    }
    if (account.surface !== binding.surfaceProfile
      || account.canonicalAppIdHash !== sha256Bytes(binding.remoteAppId ?? '')) failures.push(`account_${specification.accountIndex}_app`);
    if (!/^[a-f0-9]{64}$/.test(account.identityHash ?? '')
      || !/^[a-f0-9]{64}$/.test(account.workspaceIdentityHash ?? '')
      || !/^[a-f0-9]{64}$/.test(account.appDisplayNameHash ?? '')) failures.push(`account_${specification.accountIndex}_identity`);
    if (account.preflight?.submissions !== 0 || account.preflight?.remoteMutation !== false
      || account.preflight?.mode !== 'Chat') failures.push(`account_${specification.accountIndex}_preflight`);
    if (account.canary?.submissions !== 1 || account.canary?.persistedToolCall !== true
      || !/^[a-f0-9]{64}$/.test(account.canary?.conversationUrlHash ?? '')) failures.push(`account_${specification.accountIndex}_canary`);
  }
  return {
    ok: failures.length === 0,
    failures,
    postRead: {
      accountAliases: expected.map(item => roleIdentities?.[item.role]?.accountAlias ?? null),
      appIdHashes: expected.map(item => {
        const alias = roleIdentities?.[item.role]?.accountAlias;
        const binding = bindings.find(candidate => candidate.accountAlias === alias);
        return binding?.remoteAppId ? sha256Bytes(binding.remoteAppId) : null;
      })
    }
  };
}

export async function installLauncherCandidate(options, baseline) {
  const expectedSha = options.candidateSha256;
  if (sha256File(options.candidateZip) !== expectedSha) throw new LiveRepairError('candidate_hash_changed', 'candidate launcher archive hash changed');
  const extracted = path.join(options.runDir, 'candidate-extracted');
  if (!fs.existsSync(extracted)) {
    fs.mkdirSync(extracted, { mode: 0o700 });
    run('/usr/bin/ditto', ['-x', '-k', options.candidateZip, extracted], { timeoutMs: 120_000 });
  }
  const candidateApp = path.join(extracted, 'Codex Web GPT.app');
  verifyApp(candidateApp, options.expectedAppVersion);
  if (!fs.existsSync(APP_PATH)) throw new LiveRepairError('installed_app_missing', 'installed launcher app is missing');
  const installedBefore = { version: appVersion(APP_PATH), pids: appMainPids(), appPath: APP_PATH };
  const ownerBackup = path.join(options.runDir, 'preimage', 'Codex Web GPT.app');
  fs.mkdirSync(path.dirname(ownerBackup), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(ownerBackup)) run('/usr/bin/ditto', [APP_PATH, ownerBackup], { timeoutMs: 120_000 });
  verifyApp(ownerBackup, installedBefore.version);
  const recovery = sealStageRecovery(options, 'app', ownerBackup);
  const adjacentBackup = `/Applications/.Codex Web GPT.aicc-preimage-${options.operation}.app`;
  const adjacentCandidate = `/Applications/.Codex Web GPT.aicc-candidate-${options.operation}.app`;
  const adjacentFailed = `/Applications/.Codex Web GPT.aicc-failed-${options.operation}.app`;
  for (const target of [adjacentBackup, adjacentCandidate, adjacentFailed]) {
    if (fs.existsSync(target)) throw new LiveRepairError('app_transaction_conflict', `app transaction target already exists: ${path.basename(target)}`);
  }
  run('/usr/bin/ditto', [candidateApp, adjacentCandidate], { timeoutMs: 120_000 });
  verifyApp(adjacentCandidate, options.expectedAppVersion);
  if (installedBefore.pids.length > 0) {
    const quit = run('/usr/bin/osascript', ['-e', `tell application id "${APP_ID}" to quit`], { allowFailure: true, timeoutMs: 30_000 });
    if (quit.status !== 0) throw new LiveRepairError('app_quit_refused', 'launcher normal quit was refused');
    await waitUntil(async () => ({ ok: appMainPids().length === 0 }), 90_000);
  }
  const afterQuit = await runtimeSnapshot();
  if (!afterQuit.integrated.health.ready || !allKnownZero(afterQuit.integrated)) {
    throw new LiveRepairError('integrated_service_changed_during_app_quit', '17841 service did not survive launcher quit at exact zero');
  }
  assertSurvival(baseline, afterQuit, { allowOcxOff: options.preserveOcxOff === true });
  let swapped = false;
  try {
    fs.renameSync(APP_PATH, adjacentBackup);
    fs.renameSync(adjacentCandidate, APP_PATH);
    swapped = true;
    verifyApp(APP_PATH, options.expectedAppVersion);
    run('/usr/bin/open', ['-gj', '--env', 'AICC_BACKGROUND_LAUNCH=1', APP_PATH], { timeoutMs: 30_000 });
    const post = await waitUntil(async () => {
      const runtime = await runtimeSnapshot();
      const pids = appMainPids();
      return {
        ok: pids.length === 1
          && runtime.integrated.health.ready
          && runtime.integrated.health.acceptingTurns
          && runtime.integrated.health.acceptingBrowserTurns
          && allKnownZero(runtime.integrated)
          && runtime.integrated.ready.ready,
        pids,
        runtime
      };
    }, 180_000, 1_000);
    if (routeIdentity(post.runtime.integrated) !== routeIdentity(baseline.integrated)) {
      throw new LiveRepairError('integrated_service_identity_changed', 'launcher update unexpectedly replaced 17841 service identity');
    }
    assertSurvival(baseline, post.runtime, { allowOcxOff: options.preserveOcxOff === true });
    return {
      installedBefore,
      installedAfter: { version: appVersion(APP_PATH), pids: post.pids },
      ownerBackup,
      adjacentBackup,
      recovery,
      candidateSha256: expectedSha,
      integrated: post.runtime.integrated
    };
  } catch (error) {
    if (swapped) {
      const quit = run('/usr/bin/osascript', ['-e', `tell application id "${APP_ID}" to quit`], { allowFailure: true, timeoutMs: 30_000 });
      if (quit.status === 0) await waitUntil(async () => ({ ok: appMainPids().length === 0 }), 60_000).catch(() => null);
      if (appMainPids().length === 0 && fs.existsSync(APP_PATH) && fs.existsSync(adjacentBackup)) {
        fs.renameSync(APP_PATH, adjacentFailed);
        fs.renameSync(adjacentBackup, APP_PATH);
        run('/usr/bin/open', ['-gj', '--env', 'AICC_BACKGROUND_LAUNCH=1', APP_PATH], { allowFailure: true, timeoutMs: 30_000 });
      } else {
        throw new LiveRepairError('app_rollback_uncertain', `launcher verification failed and rollback could not prove a safe swap: ${sanitizeError(error)}`);
      }
    }
    throw error;
  }
}

export function classifyWorkspaceRuntimeAction(status) {
  const activeLeases = status?.remoteAuthority?.activeLeases;
  if (activeLeases !== 0) {
    return {
      action: 'hold',
      code: activeLeases == null ? 'workspace_lease_unknown' : 'workspace_lease_active',
      reason: 'workspace runtime does not have exact zero leases'
    };
  }
  if (status?.missingCount !== 0) {
    return { action: 'hold', code: 'workspace_roots_unresolved', reason: 'workspace roots are not exact-complete' };
  }
  const strictReady = status?.state === 'ready'
    && status?.serverReady === true
    && status?.tunnel?.running === true
    && status?.tunnel?.healthy === true
    && status?.tunnel?.ready === true
    && status?.remoteAuthority?.runtimeReady === true;
  if (strictReady) return { action: 'reuse', reason: 'already_strict_ready' };

  const tunnelReady = status?.tunnel?.running === true
    && status?.tunnel?.healthy === true
    && status?.tunnel?.ready === true;
  const reasons = Array.isArray(status?.remoteAuthority?.runtimeReasons)
    ? status.remoteAuthority.runtimeReasons
    : [];
  const processIdentityOnly = reasons.length > 0
    && reasons.every(reason => ['process_identity', 'supervisor_identity'].includes(reason));
  if (tunnelReady && processIdentityOnly) {
    return { action: 'observe', reason: 'running_tunnel_identity_convergence' };
  }

  const restartableRuntimeDrift = reasons.length > 0
    && reasons.every(reason => ['source_identity', 'installed_identity'].includes(reason));
  if (tunnelReady && restartableRuntimeDrift) {
    return { action: 'install', reason: 'exact_runtime_identity_drift' };
  }

  const exactStopped = status?.tunnel?.running === false
    && status?.tunnel?.healthy === false
    && status?.tunnel?.ready === false
    && status?.tunnel?.reason === 'launchd 중지';
  if (exactStopped) return { action: 'install', reason: 'exact_launchd_stopped' };

  return {
    action: 'hold',
    code: 'workspace_runtime_state_unknown',
    reason: 'workspace runtime is neither strict-ready, identity-converging, exact-drift, nor exact-stopped'
  };
}

async function repairWorkspaceSurface(options, surface, baseline) {
  let pre = await workspaceMcpStatus({ surfaceProfile: surface });
  if (pre.remoteAuthority?.activeLeases !== 0) {
    throw new LiveRepairError(pre.remoteAuthority?.activeLeases === null ? 'workspace_lease_unknown' : 'workspace_lease_active', `${surface} does not have exact zero leases`);
  }
  const configPath = workspaceMcpPaths({ surfaceProfile: surface }).config;
  const backup = path.join(options.runDir, 'preimage', `workspace-${surface}-config.json`);
  fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(backup)) fs.copyFileSync(configPath, backup, fs.constants.COPYFILE_EXCL);
  const recoveryComponent = surface === 'business-full' ? 'business' : 'personal';
  const recovery = sealStageRecovery(options, recoveryComponent, backup);
  const reconciled = pre.missingCount > 0 ? reconcileWorkspaceMcpRoots({ surfaceProfile: surface }) : { duplicate: true, removed: [], workspaceCount: pre.workspaceCount };
  pre = await workspaceMcpStatus({ surfaceProfile: surface });
  if (pre.missingCount !== 0 || pre.remoteAuthority?.activeLeases !== 0) throw new LiveRepairError('workspace_reconcile_postread_failed', `${surface} root reconciliation did not reach exact zero missing/leases`);
  await options.gate();
  pre = await workspaceMcpStatus({ surfaceProfile: surface });
  const runtimeAction = classifyWorkspaceRuntimeAction(pre);
  if (runtimeAction.action === 'hold') {
    throw new LiveRepairError(runtimeAction.code, `${surface}: ${runtimeAction.reason}`, { status: pre });
  }
  const installed = runtimeAction.action === 'install'
    ? installWorkspaceTunnelLaunchAgent({ surfaceProfile: surface })
    : null;
  let ready;
  try {
    ready = runtimeAction.action === 'reuse' ? { ok: true, status: pre } : await waitUntil(async () => {
      const status = await workspaceMcpStatus({ surfaceProfile: surface });
      return { ok: status.state === 'ready' && status.serverReady === true && status.tunnel?.ready === true && status.remoteAuthority?.runtimeReady === true && status.remoteAuthority?.activeLeases === 0, status };
    }, 180_000, 1_000);
  } catch (error) {
    if (runtimeAction.action === 'observe') {
      throw new LiveRepairError('workspace_identity_convergence_hold', `${surface} identity did not converge without restart`, { status: pre, cause: sanitizeError(error) });
    }
    throw error;
  }
  const config = readWorkspaceMcpConfig({ surfaceProfile: surface });
  const canary = await runRegisteredWorkspaceCanary({
    config,
    workspaceRoot: options.publicRoot,
    runtimeRoot: path.join(options.runDir, 'workspace-canary-runtime', surface),
    runId: `${options.operation}.${surface === 'business-full' ? 'business' : 'personal'}`
  });
  const post = await workspaceMcpStatus({ surfaceProfile: surface });
  if (post.state !== 'ready' || post.remoteAuthority?.activeLeases !== 0) throw new LiveRepairError('workspace_post_canary_failed', `${surface} runtime post-read failed after canary`);
  assertSurvival(baseline, await runtimeSnapshot());
  return {
    surface,
    configBackup: backup,
    recovery,
    removedMissingCount: reconciled.removed?.length ?? 0,
    workspaceCount: post.workspaceCount,
    launchd: installed == null
      ? { mutation: false, reason: runtimeAction.action === 'observe' ? 'identity_converged_without_restart' : 'already_strict_ready' }
      : { mutation: true, label: installed.label, unloadConfirmed: installed.unloadConfirmed, bootstrapAttempts: installed.bootstrapAttempts, registeredAfterBootstrapError: installed.registeredAfterBootstrapError },
    runtime: { serverReady: post.serverReady, tunnelReady: post.tunnel.ready, authorityReady: post.remoteAuthority.runtimeReady, activeLeases: post.remoteAuthority.activeLeases },
    canary,
    sourceManifest: { toolCount: post.publication.toolCount, readToolCount: post.publication.readToolCount, writeToolCount: post.publication.writeToolCount },
    publication: post.publication.needsPublish ? 'PENDING_EXACT_REVIEW' : 'not_required'
  };
}

function browserRoleIndex(role) {
  return role === 'default' ? 1 : role === 'secondary' ? 2 : 3;
}

export function resolveVerifiedWorkspaceAppName(detailInventory, binding) {
  const lineage = detailInventory?.observation?.pageLineage;
  if (lineage?.pluginId !== binding?.remoteAppId || lineage?.exactPath !== true || lineage?.familyVisible !== true) {
    throw new LiveRepairError('account_app_name_lineage_failed', 'the app display name is not bound to the exact stable app ID');
  }
  const names = [...new Set((detailInventory?.observation?.headings ?? [])
    .filter(value => typeof value === 'string')
    .map(value => value.replace(/\s+/g, ' ').trim())
    .filter(value => value.includes('AICC Workspace') && value.length >= 14 && value.length <= 240))];
  if (names.length !== 1) {
    throw new LiveRepairError('account_app_name_unknown', `the exact AICC Workspace display name count is ${names.length}`);
  }
  return names[0];
}

async function auditAccount(options, role, binding) {
  const identity = resolveRole(options.publicRoot, role);
  if (identity.accountAlias !== binding.accountAlias) throw new LiveRepairError('account_binding_drift', `account ${browserRoleIndex(role)} topology does not match registered CDP role`);
  const identityResult = runPrivateJson(options, [
    path.join(options.privateRoot, 'scripts', 'chatgpt-account-identity-audit.mjs'),
    '--lease-helper', options.leaseHelper,
    '--owner-id', `${options.operation}.account-${browserRoleIndex(role)}-identity`,
    '--account-alias', identity.accountAlias,
    '--workspace-alias', identity.workspaceAlias
  ], 'account_identity_audit_failed');
  const appUrl = `https://chatgpt.com/plugins/${binding.remoteAppId}`;
  const listInventory = runPrivateJson(options, [
    path.join(options.privateRoot, 'scripts', 'chatgpt-workspace-app-inventory.mjs'),
    '--lease-helper', options.leaseHelper,
    '--account-alias', identity.accountAlias,
    '--workspace-alias', identity.workspaceAlias,
    '--owner-id', `${options.operation}.account-${browserRoleIndex(role)}-inventory-list`,
    '--url', 'https://chatgpt.com/plugins',
    '--family', 'AICC Workspace'
  ], 'account_plugin_inventory_failed');
  const detailInventory = runPrivateJson(options, [
    path.join(options.privateRoot, 'scripts', 'chatgpt-workspace-app-inventory.mjs'),
    '--lease-helper', options.leaseHelper,
    '--account-alias', identity.accountAlias,
    '--workspace-alias', identity.workspaceAlias,
    '--owner-id', `${options.operation}.account-${browserRoleIndex(role)}-inventory-detail`,
    '--url', appUrl,
    '--family', 'AICC Workspace'
  ], 'account_app_detail_failed');
  const probe = detailInventory.observation?.pluginProbe;
  const pageLineage = detailInventory.observation?.pageLineage;
  const browserLineage = pageLineage?.pluginId === binding.remoteAppId
    && pageLineage?.exactPath === true
    && pageLineage?.familyVisible === true
    && Number.isInteger(pageLineage?.familyHeadingCount)
    && pageLineage.familyHeadingCount >= 1;
  const apiLineage = probe?.detail?.status === 200 && probe.detail.containsTargetId === true;
  if (!browserLineage && !apiLineage) throw new LiveRepairError('account_app_lineage_failed', `account ${browserRoleIndex(role)} canonical app detail did not verify`);
  const appName = resolveVerifiedWorkspaceAppName(detailInventory, binding);
  const canaryArguments = ownerId => [
    path.join(options.privateRoot, 'scripts', 'chatgpt-workspace-app-canary.mjs'),
    '--lease-helper', options.leaseHelper,
    '--owner-id', ownerId,
    '--account-alias', identity.accountAlias,
    '--account-index', String(browserRoleIndex(role)),
    '--workspace-alias', identity.workspaceAlias,
    '--app-url', appUrl,
    '--app-name', appName,
    '--marker-suffix', `FINAL_${sha256Bytes(options.operation).slice(0, 12).toUpperCase()}`,
    '--require-call-tool'
  ];
  await options.gate();
  let preflight;
  try {
    preflight = runPrivateJson(options, [
      ...canaryArguments(`${options.operation}.account-${browserRoleIndex(role)}-canary-preflight`),
      '--inspect'
    ], 'account_canary_preflight_failed');
  } catch (error) {
    throw new LiveRepairError('account_canary_preflight_failed', `${sanitizeError(error)}; submissions=0`);
  }
  if (preflight.remoteMutation !== false || preflight.mode !== 'Chat' || preflight.workSelected !== false || preflight.canary !== null) {
    throw new LiveRepairError('account_canary_preflight_failed', `account ${browserRoleIndex(role)} inspect-only result was not exact; submissions=0`);
  }
  await options.gate();
  let canary;
  try {
    canary = runPrivateJson(options, [
      ...canaryArguments(`${options.operation}.account-${browserRoleIndex(role)}-canary-commit`),
      '--commit-list'
    ], 'account_canary_uncertain');
  } catch (error) {
    throw new LiveRepairError('account_canary_uncertain', `${sanitizeError(error)}; no replay is permitted`);
  }
  if (canary.remoteMutation !== true || canary.canary?.submissions !== 1 || canary.canary?.apiEvidence?.containsAiccWorkspaceList !== true) {
    throw new LiveRepairError('account_canary_postread_failed', `account ${browserRoleIndex(role)} app canary did not prove one persisted tool call`);
  }
  return {
    accountIndex: browserRoleIndex(role),
    surface: binding.surfaceProfile,
    identityHash: identityResult.identityHash,
    workspaceIdentityHash: identityResult.workspaceIdentityHash,
    plan: identityResult.accountPlan ?? null,
    canonicalAppIdHash: sha256Bytes(binding.remoteAppId),
    appDisplayNameHash: sha256Bytes(appName),
    visibleFamilyCardCount: listInventory.observation?.records?.length ?? null,
    detailProbe: { browserLineage, apiLineage, status: probe?.detail?.status ?? null, installedStatus: probe?.installed?.status ?? null },
    preflight: { submissions: 0, remoteMutation: false, mode: preflight.mode },
    canary: { submissions: 1, conversationUrlHash: sha256Bytes(canary.canary.conversationUrl), persistedToolCall: true }
  };
}

function responseText(body) {
  const values = [];
  const visit = value => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== 'object') return;
    if (value.type === 'output_text' && typeof value.text === 'string') values.push(value.text);
    for (const child of Object.values(value)) visit(child);
  };
  visit(body?.output);
  return values.join('').trim();
}

export function buildTrustedCallbackRequest({ taskId, turnId, publicRoot, marker }) {
  const encodeXmlText = value => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const rootXml = encodeXmlText(publicRoot);
  const environment = [
    '<environment_context>',
    `  <cwd>${rootXml}</cwd>`,
    '  <sandbox_mode>read-only</sandbox_mode>',
    `  <filesystem><workspace_roots><root>${rootXml}</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile></filesystem>`,
    '</environment_context>'
  ].join('\n');
  const prompt = `Reply with exactly ${marker} and no other text. Do not use tools.`;
  const turnMetadata = {
    thread_id: taskId,
    turn_id: turnId,
    request_kind: 'aicc_callback_canary',
    sandbox: 'read-only',
    workspaces: { [publicRoot]: { has_changes: false } }
  };
  return {
    prompt,
    body: {
      model: 'chatgpt-web/saved/high',
      reasoning: { effort: 'high' },
      stream: false,
      prompt_cache_key: taskId,
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify(turnMetadata) },
      input: [
        {
          id: 'msg_environment',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: environment }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId }
        },
        {
          id: 'msg_instruction',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId }
        }
      ]
    }
  };
}

async function observerRequest(pathname, options = {}) {
  const tokenFile = path.join(os.homedir(), '.codex-chatgpt-web', 'observer', 'token');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:17843${pathname}`, {
    method: options.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000)
  });
  if (!response.ok) throw new LiveRepairError('observer_http_error', `Observer HTTP ${response.status}`);
  return await response.json();
}

async function runIntegratedCallbackCanary(options, baseline) {
  const runtime = await runtimeSnapshot();
  if (!runtime.integrated.health.ready || !runtime.integrated.ready.ready
    || !runtime.integrated.health.acceptingTurns || !runtime.integrated.health.acceptingBrowserTurns
    || !allKnownZero(runtime.integrated)) {
    throw new LiveRepairError('integrated_not_strict_ready', '17841 strict browser readiness gate failed');
  }
  assertSurvival(baseline, runtime);
  const before = await observerRequest('/api/watches?limit=100');
  const beforeIds = new Set((before.watches ?? before.items ?? []).map(item => item.id));
  const marker = `AICC_CALLBACK_E2E_${sha256Bytes(options.operation).slice(0, 16).toUpperCase()}`;
  const turnId = `turn_${crypto.randomUUID()}`;
  const { prompt, body: requestBody } = buildTrustedCallbackRequest({
    taskId: options.taskId,
    turnId,
    publicRoot: options.publicRoot,
    marker
  });
  let response;
  try {
    response = await fetch('http://127.0.0.1:17841/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': `${options.operation}.callback` },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(12 * 60_000)
    });
  } catch (error) {
    throw new LiveRepairError('integrated_dispatch_uncertain', `${sanitizeError(error)}; the saved Chat request must not be replayed`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || responseText(body) !== marker) {
    throw new LiveRepairError('integrated_response_uncertain', `17841 returned HTTP ${response.status} or a non-exact response; no replay is permitted`);
  }
  const after = await observerRequest('/api/watches?limit=100');
  const promptHash = sha256Bytes(prompt);
  const matches = (after.watches ?? after.items ?? []).filter(item => !beforeIds.has(item.id)
    && item.ownerTaskId === options.taskId
    && item.surface === 'launcher'
    && item.expected?.promptSha256 === promptHash);
  if (matches.length !== 1) throw new LiveRepairError('observer_watch_ambiguous', `exact new Observer watch count is ${matches.length}; no replay is permitted`);
  const watch = matches[0];
  atomicPrivateJson(path.join(options.runDir, 'pre-callback-result.json'), {
    operation: options.operation,
    status: 'PASS_PENDING_CALLBACK',
    completedAt: new Date().toISOString(),
    watch: { id: watch.id, state: watch.state, version: watch.version, promptSha256: promptHash },
    stages: options.stageResults
  });
  if (!options.desktopReleased) {
    await options.gate();
    options.desktopRelease = await releaseDesktopForOwnedCallbacks({
      expectedPid: options.expectedDesktopPid,
      baseline,
      maxSamples: Math.max(5, Math.ceil(options.maxWaitMs / 2_000)),
      progress: event => options.writeProgress?.({
        at: new Date().toISOString(),
        operation: options.operation,
        stage: 'callback-e2e',
        terminal: 'desktop_release',
        evidence: event
      })
    });
    options.desktopReleased = true;
  }
  const callback = await runWebGptWatchCallback({ watchId: watch.id, callbackId: options.webCallbackId });
  if (!callback.ok || callback.watchState !== 'completed' || callback.callback?.terminalTurnStatus !== 'completed') {
    throw new LiveRepairError('callback_e2e_failed', 'same-task Web GPT callback did not reach a completed terminal');
  }
  return {
    markerSha256: sha256Bytes(marker),
    responseSha256: sha256Bytes(responseText(body)),
    watchId: watch.id,
    watchState: callback.watchState,
    resultSha256: callback.resultSha256,
    callback: { state: callback.callback.state, turnId: callback.callback.turnId, terminalTurnStatus: callback.callback.terminalTurnStatus }
  };
}

function repairPlan(options) {
  const dashboardRecovery = path.join(options.publicRoot, '.aicc-recovery', 'gui-final-20260825', 'restore.sh');
  const dashboardManifest = path.join(options.publicRoot, '.aicc-recovery', 'gui-final-20260825', 'postimage.sha256');
  return {
    schemaVersion: 1,
    operation: options.operation,
    taskId: options.taskId,
    mode: options.resumeFromRun ? 'component-scoped-resume-one-shot' : 'component-scoped-one-shot',
    resume: options.resumeFromRun ? { fromRun: options.resumeFromRun, journalSha256: options.resumeEvidenceSha256, replayCompletedStages: false } : null,
    createdAt: new Date().toISOString(),
    publicRoot: options.publicRoot,
    recoveryArtifacts: {
      dashboardSourceScriptSha256: fs.existsSync(dashboardRecovery) ? sha256File(dashboardRecovery) : null,
      dashboardPostimageSha256: fs.existsSync(dashboardManifest) ? sha256File(dashboardManifest) : null
    },
    order: [
      { id: 'task-owned-native-cli-reconcile', backup: 'exact PID plus process start/command identity', success: 'the isolated task-owned CLI exits once and Codex ACTIVE/UNKNOWN becomes exact zero', stop: 'active work, foreign UNKNOWN, PID reuse or graceful-exit refusal' },
      { id: 'cold-survival-recovery', backup: 'configured LaunchAgent plist hashes and exact absent/ready evidence', success: 'each configured offline survival path receives at most one bootstrap and reaches its own readiness contract', stop: 'registered-unhealthy or UNKNOWN job, invalid plist, bootstrap failure, browser readiness failure, or Native identity drift' },
      { id: 'codex-route-split', backup: 'default config, integration journal, named launchers and catalogs', success: 'codex is Native and explicit AICC/Web/OCX commands are installed with no fallback', stop: 'active/UNKNOWN, unowned file, route journal mismatch or any survival route change' },
      { id: 'account-3-lineage', backup: 'registered saved Chat URL, sealed prompt hash and account/workspace identity hashes', success: 'prior exact Pro evidence hash matches locally; no Chrome access and submissions=0', stop: 'sealed URL, prompt, receipt, identity or lineage mismatch' },
      { id: 'dashboard-recovery-gui', backup: 'exact source postimage, source preimage, and Dashboard LaunchAgent plist', success: '4381 health and fail-closed latest recovery API/button available', stop: 'source hash, bootstrap, health, or recovery pointer mismatch' },
      { id: 'codex-guidance', backup: 'exact managed skill trees and deployment manifest', success: 'source, installed trees and manifest match; unmanaged skills preserved', stop: 'plan/refusal/hash or post-read drift' },
      { id: 'launcher-aicc24', backup: 'signed installed app preimage and exact adjacent rollback bundle', success: 'aicc.24 app, strict 17841 browser readiness, service PID/start identity preserved', stop: 'normal quit refusal, hash/signature drift, route survival change' },
      { id: 'workspace-business', backup: 'Business config and LaunchAgent preimages', success: 'Tunnel/runtime ready, 22 tools, disposable write-readback-rollback', stop: 'active/UNKNOWN lease, bootstrap ambiguity, rollback mismatch' },
      { id: 'workspace-personal', backup: 'Personal config and LaunchAgent preimages', success: 'Tunnel/runtime ready, 18 read tools, forged write denied', stop: 'write exposure, active/UNKNOWN lease, bootstrap ambiguity' },
      { id: 'account-inventory-canaries', backup: 'stable app IDs and identity hashes; remote assets unchanged', success: 'accounts 3→1→2 exact inventory and one persisted list-tool canary each', stop: 'foreign target, permission/dispatch ambiguity, stable-ID mismatch' },
      { id: 'recovery-gui-open', backup: 'no runtime state change; local Dashboard URL only', success: 'the local recovery console is opened once for the owner', stop: 'exact-idle gate or Dashboard health failure' },
      { id: 'callback-e2e', backup: 'two exact callback bindings and Observer pre-snapshot', success: 'one saved response, one completed watch/artifact, same-task callback completed', stop: 'strict readiness failure, ambiguous send/watch/callback' },
      { id: 'desktop-reopen', backup: 'exact gracefully released Desktop PID and preserved route identities', success: 'one new Desktop PID appears after callback completion and all route identities remain ready', stop: 'open failure, multiple Desktop processes, route drift, or readiness timeout' }
    ],
    preserved: ['17842', '10100', 'Native', 'Desktop', 'registered Chrome user tabs', 'remote Projects/GPTs/Notion'],
    userLocks: [],
    pendingReviews: ['remote publication/update', 'duplicate plugin disable/delete', 'Project/GPT create/share/delete', 'Notion write']
  };
}

function recoveryScript(options) {
  const worker = path.resolve(fileURLToPath(import.meta.url));
  return `#!/bin/zsh
set -eu
COMMAND="\${1:---help}"
TARGET="\${2:-}"
SCRIPT_PATH="\${0:A}"
usage() {
  print -r -- "Usage: $SCRIPT_PATH status | $SCRIPT_PATH dry-run <routes|dashboard|app|guidance|business|personal> | $SCRIPT_PATH apply <target>"
}
case "$COMMAND" in
  -h|--help|help)
    usage
    exit 0
    ;;
  status)
    test -z "$TARGET" || { usage >&2; exit 2; }
    exec ${JSON.stringify(process.execPath)} ${JSON.stringify(worker)} --rollback status --run-dir ${JSON.stringify(options.runDir)}
    ;;
  dry-run|apply)
    case "$TARGET" in
      routes|dashboard|app|guidance|business|personal) ;;
      *) usage >&2; exit 2 ;;
    esac
    exec ${JSON.stringify(process.execPath)} ${JSON.stringify(worker)} --recovery-component "$TARGET" --recovery-mode "$COMMAND" --run-dir ${JSON.stringify(options.runDir)}
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
`;
}

function prepare(options) {
  privateDirectory(options.runDir);
  const planFile = path.join(options.runDir, 'repair-plan.json');
  const recoveryFile = path.join(options.runDir, 'recover.sh');
  if (fs.existsSync(planFile) || fs.existsSync(recoveryFile)) throw new LiveRepairError('prepare_conflict', 'run plan or recovery script already exists');
  atomicPrivateJson(planFile, repairPlan(options));
  fs.writeFileSync(recoveryFile, recoveryScript(options), { mode: 0o700, flag: 'wx' });
  return { planFile, recoveryFile, resultFile: path.join(options.runDir, 'final-result.json'), journalFile: path.join(options.runDir, 'journal.jsonl') };
}

export async function completeFinalCallback({ service, callbackId, digest, timeoutMs = 12 * 60 * 60_000, maxWaitMs = 10 * 60_000, retryMs = 5_000, now = () => Date.now(), wait = sleep, onRetry = null }) {
  const startedAt = now();
  const deadline = now() + maxWaitMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await service.complete({ callbackId, expectedResultSha256: digest, timeoutMs });
    } catch (error) {
      if (!RETRYABLE_FINAL_CALLBACK_ERRORS.has(error?.code) || now() + retryMs >= deadline) throw error;
      onRetry?.({
        attempt,
        errorCode: error.code,
        elapsedMs: now() - startedAt,
        remainingMs: deadline - now(),
        nextRetryMs: retryMs
      });
      await wait(retryMs);
    }
  }
}

async function deliverFinal(options, document, progress) {
  const callbackFile = options.finalCallbackPayload ?? path.join(options.runDir, 'final-callback-payload.json');
  if (!fs.existsSync(callbackFile)) atomicPrivateJson(callbackFile, { ...document, phase: 'PRE_REOPEN_HANDOFF' });
  const digest = sha256File(callbackFile);
  try {
    const callback = await completeFinalCallback({
      service: new CodexTaskCallbackService(),
      callbackId: options.finalCallbackId,
      digest,
      onRetry: evidence => progress({
        at: new Date().toISOString(),
        operation: options.operation,
        stage: 'final-callback',
        terminal: 'waiting_callback',
        evidence
      })
    });
    progress({
      at: new Date().toISOString(),
      operation: options.operation,
      stage: 'final-callback',
      terminal: 'PASS',
      evidence: { remainingMs: 0, callbackState: callback.state }
    });
    atomicPrivateJson(path.join(options.runDir, 'final-callback-result.json'), {
      schemaVersion: 1,
      operation: options.operation,
      status: 'PASS',
      completedAt: new Date().toISOString(),
      resultSha256: digest,
      callbackState: callback.state
    });
    return { callbackFile, digest, callback };
  } catch (error) {
    const terminal = error?.code?.includes('unknown') || error?.code?.includes('ambiguous') ? 'UNCERTAIN' : 'HOLD';
    progress({
      at: new Date().toISOString(),
      operation: options.operation,
      stage: 'final-callback',
      terminal,
      evidence: { remainingMs: 0, code: error?.code ?? 'callback_delivery_failed', message: sanitizeError(error) }
    });
    const callback = { state: terminal, errorCode: error?.code ?? 'callback_delivery_failed' };
    atomicPrivateJson(path.join(options.runDir, 'final-callback-result.json'), {
      schemaVersion: 1,
      operation: options.operation,
      status: terminal,
      completedAt: new Date().toISOString(),
      resultSha256: digest,
      callback
    });
    return { callbackFile, digest, callback };
  }
}

async function cancelFinalCallbackWithoutDelivery(options, document) {
  const callbackFile = options.finalCallbackPayload ?? path.join(options.runDir, 'final-callback-payload.json');
  if (!fs.existsSync(callbackFile)) atomicPrivateJson(callbackFile, { ...document, phase: 'DESKTOP_WRITER_PRESERVED' });
  const digest = sha256File(callbackFile);
  const service = new CodexTaskCallbackService();
  try {
    const binding = service.inspect({ callbackId: options.finalCallbackId });
    if (binding.state === 'armed' || binding.state === 'destination_busy') {
      const cancelled = await service.cancel({
        callbackId: options.finalCallbackId,
        expectedResultSha256: digest,
        reason: 'operator_cancelled'
      });
      return { callbackFile, digest, callback: cancelled, deliverySkipped: true };
    }
    return { callbackFile, digest, callback: binding, deliverySkipped: true };
  } catch (error) {
    return {
      callbackFile,
      digest,
      callback: { state: 'UNCERTAIN', errorCode: error?.code ?? error?.message ?? 'callback_cancel_failed' },
      deliverySkipped: true
    };
  }
}

async function finalizeOperation(options, document, progress, baseline) {
  let delivery;
  let desktopReopen = { status: 'NOT_APPLICABLE', reopened: false };
  if (options.desktopReleased) {
    delivery = await deliverFinal(options, document, progress);
    try {
      const reopened = await reopenDesktopAfterOwnedCallbacks({
        baseline,
        progress: evidence => progress({
          at: new Date().toISOString(),
          operation: options.operation,
          stage: 'desktop-reopen',
          terminal: 'waiting_reopen',
          evidence
        })
      });
      desktopReopen = { status: 'PASS', ...reopened };
    } catch (error) {
      desktopReopen = { status: 'HOLD', reason: error?.code ?? error?.message ?? 'desktop_reopen_failed' };
    }
  } else {
    delivery = await cancelFinalCallbackWithoutDelivery(options, document);
  }
  const callbackDeliveryPass = delivery.deliverySkipped !== true
    && (delivery.callback?.ok === true || delivery.callback?.state === 'completed');
  const overallPass = document.status === 'PASS'
    && callbackDeliveryPass
    && desktopReopen.status === 'PASS';
  const final = {
    ...document,
    status: overallPass ? 'PASS' : document.status === 'UNCERTAIN' ? 'UNCERTAIN' : 'HOLD',
    completedAt: new Date().toISOString(),
    finalCallback: {
      status: delivery.deliverySkipped ? 'NOT_DISPATCHED' : callbackDeliveryPass ? 'PASS' : 'HOLD',
      state: delivery.callback?.state ?? null,
      resultSha256: delivery.digest
    },
    desktopReopen
  };
  const finalFile = path.join(options.runDir, 'final-result.json');
  if (fs.existsSync(finalFile)) throw new LiveRepairError('final_result_conflict', 'final result already exists');
  atomicPrivateJson(finalFile, final);
  progress({
    at: new Date().toISOString(),
    operation: options.operation,
    stage: 'terminal',
    terminal: final.status,
    evidence: { remainingMs: 0, desktopReopen: desktopReopen.status, finalCallback: final.finalCallback.status }
  });
  return final;
}

async function cancelUnusedWebCallback(options, reason) {
  const service = new CodexTaskCallbackService();
  const binding = service.inspect({ callbackId: options.webCallbackId });
  if (binding.state !== 'armed') return;
  if (!fs.existsSync(binding.resultFile)) atomicPrivateJson(binding.resultFile, {
    operation: binding.operationId,
    status: 'HOLD',
    completedAt: new Date().toISOString(),
    reason
  });
  await service.cancel({ callbackId: options.webCallbackId, expectedResultSha256: sha256File(binding.resultFile), reason: 'operator_cancelled' });
}

async function execute(options) {
  const journal = path.join(options.runDir, 'journal.jsonl');
  const stages = [];
  const userLocks = [];
  const pendingReviews = ['remote_publication', 'duplicate_plugin_delete', 'project_gpt_mutation', 'notion_write'];
  const progress = createTerminalProgressReporter({ operation: options.operation, file: options.progressLog, stateFile: options.progressState });
  const writeJournal = entry => {
    appendJournal(journal, entry);
    progress(entry);
  };
  const record = (stage, terminal, evidence = {}) => {
    const entry = { at: new Date().toISOString(), operation: options.operation, stage, terminal, evidence };
    writeJournal(entry);
    stages.push(entry);
    return entry;
  };
  const start = (stage, evidence = {}) => writeJournal({
    at: new Date().toISOString(),
    operation: options.operation,
    stage,
    terminal: 'STARTED',
    evidence
  });
  const gate = async () => await waitForExactIdle({ onSample: sample => writeJournal({ at: new Date().toISOString(), operation: options.operation, stage: 'gate', terminal: sample.safe ? 'sample_idle' : 'sample_active', evidence: sample }) });
  options.gate = gate;
  options.writeProgress = writeJournal;
  options.stageResults = stages;
  let baseline;
  try {
    const resume = loadResumeEvidence(options);
    start('task-owned-native-cli-reconcile');
    const nativeCli = options.reconcileNativePid == null
      ? { terminal: 'NOT_APPLICABLE', reason: 'no_task_owned_native_cli_registered', mutation: false }
      : await reconcileTaskOwnedNativeCli({
        pid: options.reconcileNativePid,
        expectedStartCommandSha256: options.reconcileNativeIdentity,
        maxWaitMs: options.maxWaitMs,
        onSample: sample => writeJournal({ at: new Date().toISOString(), operation: options.operation, stage: 'task-owned-native-cli-reconcile', terminal: sample.active?.length > 0 ? 'waiting_active' : 'preflight', evidence: sample })
      });
    record('task-owned-native-cli-reconcile', nativeCli.terminal, nativeCli);
    await waitForExactIdle({ maxWaitMs: options.maxWaitMs, onSample: sample => writeJournal({ at: new Date().toISOString(), operation: options.operation, stage: 'initial-gate', terminal: sample.safe ? 'sample_idle' : 'waiting_active', evidence: sample }) });
    start('cold-survival-recovery');
    if (resume) {
      baseline = await runtimeSnapshot();
      options.resumeVerified = await verifyResumeCompletedStages(options, resume, baseline);
      record('cold-survival-recovery', 'NOT_APPLICABLE', options.resumeVerified.survival);
    } else {
      record('cold-survival-recovery', 'PASS', await recoverConfiguredSurvivalPaths());
      baseline = await runtimeSnapshot();
    }
    if (!baseline.integrated.health.ready || !allKnownZero(baseline.integrated)) throw new LiveRepairError('integrated_unknown_or_active', '17841 health and counters are not exact known zero');
    const directSurvival = evaluateDirectSurvival(baseline.direct);
    if (!directSurvival.ok) throw new LiveRepairError('direct_survival_not_ready', '17842 is not healthy, exact zero, and in a recognized ready or legacy standby contract');
    if (!baseline.ocx.health.ready || !baseline.ocx.ready.ready || baseline.native.ok !== true) throw new LiveRepairError('survival_path_not_ready', '10100 or Native survival path is not ready');
    record('initial-gate', 'PASS', { active: 0, unknown: 0, integratedReady: baseline.integrated.ready.ready, directSurvival: directSurvival.readyContract, ocxReady: true, nativeReady: true });

    await gate();
    start('codex-route-split');
    const routeSplit = resume
      ? { terminal: 'NOT_APPLICABLE', ...options.resumeVerified.route, reason: 'sealed_prior_pass_and_current_exact_postread' }
      : await ensureNativeDefaultAndNamedRoutes(options, baseline);
    record('codex-route-split', routeSplit.terminal, routeSplit);

    await gate();
    start('account-3-lineage');
    record('account-3-lineage', resume ? 'NOT_APPLICABLE' : 'PASS', resume
      ? options.resumeVerified.pro
      : await verifyProSavedChat(options));

    await gate();
    start('dashboard-recovery-gui');
    record('dashboard-recovery-gui', resume ? 'NOT_APPLICABLE' : 'PASS', resume
      ? options.resumeVerified.dashboard
      : await restartDashboard(options, baseline));

    await gate();
    start('codex-guidance');
    record('codex-guidance', resume ? 'NOT_APPLICABLE' : 'PASS', resume
      ? options.resumeVerified.guidance
      : repairGuidanceDeployment(options));

    await gate();
    start('launcher-aicc24');
    record('launcher-aicc24', resume ? 'NOT_APPLICABLE' : 'PASS', resume
      ? options.resumeVerified.app
      : await installLauncherCandidate(options, baseline));

    await gate();
    start('workspace-business');
    record('workspace-business', options.resumeVerified?.workspaces?.business ? 'NOT_APPLICABLE' : 'PASS', options.resumeVerified?.workspaces?.business
      ?? await repairWorkspaceSurface(options, 'business-full', baseline));

    await gate();
    start('workspace-personal');
    record('workspace-personal', options.resumeVerified?.workspaces?.personal ? 'NOT_APPLICABLE' : 'PASS', options.resumeVerified?.workspaces?.personal
      ?? await repairWorkspaceSurface(options, 'personal-read-fetch', baseline));

    start('account-inventory-canaries');
    if (options.resumeVerified?.accounts) {
      record('account-inventory-canaries', 'NOT_APPLICABLE', options.resumeVerified.accounts);
    } else {
      const topology = workspaceAppSyncStatus();
      if (!Array.isArray(topology.accountBindings) || topology.accountBindings.length !== 3) throw new LiveRepairError('app_topology_unknown', 'three-account app topology is unavailable');
      const bindingsByAlias = new Map(topology.accountBindings.map(item => [item.accountAlias, item]));
      const accountResults = [];
      for (const role of ['pro', 'default', 'secondary']) {
        await gate();
        const identity = resolveRole(options.publicRoot, role);
        const binding = bindingsByAlias.get(identity.accountAlias);
        if (!binding) throw new LiveRepairError('account_binding_unknown', `account ${browserRoleIndex(role)} has no canonical app binding`);
        accountResults.push(await auditAccount(options, role, binding));
        assertSurvival(baseline, await runtimeSnapshot());
      }
      record('account-inventory-canaries', 'PASS', { accounts: accountResults, duplicatesObserved: accountResults.some(item => (item.visibleFamilyCardCount ?? 0) > 1), cleanup: 'PENDING_EXACT_REVIEW' });
    }

    await gate();
    start('recovery-gui-open');
    if (options.resumeVerified?.recoveryGui) {
      record('recovery-gui-open', 'NOT_APPLICABLE', options.resumeVerified.recoveryGui);
    } else {
      const dashboardHealth = await httpJson(DASHBOARD_PORT, '/healthz');
      if (dashboardHealth.status !== 200) throw new LiveRepairError('dashboard_open_hold', 'recovery GUI cannot be opened because Dashboard health is not ready');
      run('/usr/bin/open', [`http://127.0.0.1:${DASHBOARD_PORT}/#troubleshoot`], { timeoutMs: 30_000, failureCode: 'dashboard_open_failed' });
      record('recovery-gui-open', 'PASS', { localOnly: true, openedOnce: true });
    }

    await gate();
    start('callback-e2e');
    const callback = await runIntegratedCallbackCanary(options, baseline);
    record('callback-e2e', 'PASS', callback);
    const final = {
      schemaVersion: 1,
      operation: options.operation,
      status: 'PASS',
      completedAt: new Date().toISOString(),
      source: 'PASS',
      installed: 'PASS',
      runtime: 'PASS',
      browserVisible: 'PASS',
      publication: 'PENDING_EXACT_REVIEW',
      callbackE2E: 'PASS',
      stages,
      userLocks,
      pendingReviews,
      recovery: { command: `${path.join(options.runDir, 'recover.sh')} status`, emergency: 'aicc restore' }
    };
    return await finalizeOperation(options, final, progress, baseline);
  } catch (error) {
    const terminal = error?.code?.includes('uncertain') || error?.code?.includes('ambiguous') ? 'UNCERTAIN' : 'HOLD';
    record('terminal', terminal, { code: error?.code ?? 'unexpected_error', message: sanitizeError(error), data: error?.data ?? null });
    await cancelUnusedWebCallback(options, error?.code ?? 'repair_hold').catch(cancelError => record('web-callback-cancel', 'UNCERTAIN', { message: sanitizeError(cancelError) }));
    const final = {
      schemaVersion: 1,
      operation: options.operation,
      status: terminal,
      completedAt: new Date().toISOString(),
      source: 'PASS',
      installed: stages.some(item => item.stage === 'launcher-aicc24' && new Set(['PASS', 'NOT_APPLICABLE']).has(item.terminal)) ? 'PASS' : 'HOLD',
      runtime: 'HOLD',
      browserVisible: 'HOLD',
      publication: 'PENDING_EXACT_REVIEW',
      callbackE2E: 'HOLD',
      error: { code: error?.code ?? 'unexpected_error', message: sanitizeError(error) },
      stages,
      userLocks,
      pendingReviews,
      noReplay: true,
      recovery: { command: `${path.join(options.runDir, 'recover.sh')} status`, emergency: 'aicc restore' }
    };
    return await finalizeOperation(options, final, progress, baseline);
  }
}

function parsePreparedPlan(runDir) {
  const file = path.join(runDir, 'repair-plan.json');
  if (!fs.existsSync(file)) throw new LiveRepairError('repair_plan_missing', 'prepared repair plan is missing');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function inspectStageRecovery({ runDir, component, verifyCurrent = false } = {}) {
  const resolvedRunDir = path.resolve(runDir ?? '');
  const plan = parsePreparedPlan(resolvedRunDir);
  const supported = new Set(['routes', 'dashboard', 'app', 'guidance', 'business', 'personal']);
  if (!supported.has(component)) throw new LiveRepairError('rollback_scope_invalid', 'unknown exact recovery component');
  const missing = [];
  const conflicts = [];
  let currentCheck = { ready: true, mode: verifyCurrent ? 'dry-run' : 'status' };
  if (component === 'routes') {
    const manifestFile = path.join(resolvedRunDir, 'preimage', 'route-split', 'manifest.json');
    if (!fs.existsSync(manifestFile)) missing.push(manifestFile);
    if (missing.length === 0) {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (manifest?.operation !== plan.operation || !Array.isArray(manifest.entries)) conflicts.push('route split preimage manifest mismatch');
      else for (const entry of manifest.entries) {
        if (entry.exists && (!entry.backup || !fs.existsSync(entry.backup) || sha256File(entry.backup) !== entry.sha256)) conflicts.push('route split preimage hash drift');
      }
    }
    if (verifyCurrent && missing.length === 0 && conflicts.length === 0) {
      const work = inspectCodexWork();
      currentCheck = { ready: work.safe === true && work.active.length === 0 && work.unknown.length === 0, mode: 'dry-run' };
    }
  } else if (component === 'dashboard') {
    const sourceRecovery = path.join(plan.publicRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'), '.aicc-recovery', 'gui-final-20260825', 'restore.sh');
    const sourceManifest = path.join(path.dirname(sourceRecovery), 'postimage.sha256');
    const plistBackup = path.join(resolvedRunDir, 'preimage', 'dashboard', `${DASHBOARD_LABEL}.plist`);
    for (const candidate of [sourceRecovery, sourceManifest, plistBackup]) if (!fs.existsSync(candidate)) missing.push(candidate);
    if (missing.length === 0 && (
      sha256File(sourceRecovery) !== plan.recoveryArtifacts?.dashboardSourceScriptSha256
      || sha256File(sourceManifest) !== plan.recoveryArtifacts?.dashboardPostimageSha256
    )) conflicts.push('dashboard recovery artifact hash drift');
    if (missing.length === 0) {
      const checked = run('/bin/zsh', [sourceRecovery, verifyCurrent ? '--dry-run' : '--status'], { allowFailure: true, timeoutMs: 30_000 });
      currentCheck = { ready: checked.status === 0, mode: verifyCurrent ? 'dry-run' : 'status', exitCode: checked.status, outputSha256: sha256Bytes(`${checked.stdout}\n${checked.stderr}`) };
    }
  } else if (component === 'app') {
    const owner = path.join(resolvedRunDir, 'preimage', 'Codex Web GPT.app');
    const adjacent = `/Applications/.Codex Web GPT.aicc-preimage-${plan.operation}.app`;
    if (!fs.existsSync(owner) && !fs.existsSync(adjacent)) missing.push(owner);
    if (!fs.existsSync(APP_PATH)) missing.push(APP_PATH);
    if (fs.existsSync(`/Applications/.Codex Web GPT.aicc-rollback-displaced-${plan.operation}.app`)) conflicts.push('app rollback displaced target');
    if (verifyCurrent && missing.length === 0) {
      const backup = fs.existsSync(adjacent) ? adjacent : owner;
      currentCheck = { ready: run('/usr/bin/codesign', ['--verify', '--deep', '--strict', backup], { allowFailure: true, timeoutMs: 30_000 }).status === 0, mode: 'dry-run' };
    }
  } else if (component === 'guidance') {
    const backupRoot = path.join(resolvedRunDir, 'preimage', 'codex-guidance');
    for (const name of GUIDANCE_SKILLS) {
      for (const candidate of [path.join(backupRoot, 'skills', name), path.join(os.homedir(), '.codex', 'skills', name)]) {
        if (!fs.existsSync(candidate)) missing.push(candidate);
      }
    }
    if (!fs.existsSync(path.join(backupRoot, '.aicc-guidance-deployment.json'))) missing.push('guidance manifest preimage');
    if (fs.existsSync(path.join(resolvedRunDir, 'rollback-displaced', 'codex-guidance'))) conflicts.push('guidance rollback displaced target');
  } else {
    const surface = component === 'business' ? 'business-full' : 'personal-read-fetch';
    const preimage = path.join(resolvedRunDir, 'preimage', `workspace-${surface}-config.json`);
    const target = workspaceMcpPaths({ surfaceProfile: surface }).config;
    if (!fs.existsSync(preimage)) missing.push(preimage);
    if (!fs.existsSync(target)) missing.push(target);
    if (fs.existsSync(`${target}.rollback-displaced-${plan.operation}`)) conflicts.push('workspace rollback displaced target');
    if (verifyCurrent && missing.length === 0) {
      const status = await workspaceMcpStatus({ surfaceProfile: surface });
      currentCheck = {
        ready: status.remoteAuthority?.activeLeases === 0,
        mode: 'dry-run',
        activeLeases: status.remoteAuthority?.activeLeases ?? null
      };
    }
  }
  const ready = missing.length === 0 && conflicts.length === 0 && currentCheck.ready === true;
  return { ok: ready, ready, operation: plan.operation, component, mode: currentCheck.mode, missingCount: missing.length, conflictCount: conflicts.length, currentCheck };
}

async function runStageRecovery(args) {
  const component = required(args, '--recovery-component');
  const mode = required(args, '--recovery-mode');
  const runDir = privateDirectory(required(args, '--run-dir'));
  if (!['status', 'dry-run', 'apply'].includes(mode)) throw new LiveRepairError('recovery_mode_invalid', 'recovery mode must be status, dry-run, or apply');
  const markerFile = path.join(runDir, 'recovery', `${component}.dispatch.json`);
  if (fs.existsSync(markerFile)) {
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    if (mode === 'status' && marker?.state === 'applied') {
      return { ok: true, ready: false, state: 'applied', operation: marker.operation, component, mutation: false, appliedAt: marker.completedAt };
    }
    throw new LiveRepairError(
      marker?.state === 'applied' ? 'recovery_replay_denied' : 'recovery_dispatch_uncertain',
      marker?.state === 'applied' ? `${component} recovery already completed; replay denied` : `${component} recovery dispatch is uncertain; replay denied`
    );
  }
  const inspection = await inspectStageRecovery({ runDir, component, verifyCurrent: mode !== 'status' });
  if (!inspection.ready) throw new LiveRepairError('recovery_preflight_hold', `${component} recovery preflight is HOLD`, inspection);
  if (mode !== 'apply') return { ...inspection, mutation: false };
  atomicPrivateJson(markerFile, {
    schemaVersion: 1,
    operation: inspection.operation,
    component,
    state: 'dispatching',
    startedAt: new Date().toISOString()
  });
  const action = component;
  const result = await rollback(['--rollback', action, '--run-dir', runDir]);
  atomicPrivateJson(markerFile, {
    schemaVersion: 1,
    operation: inspection.operation,
    component,
    state: 'applied',
    startedAt: JSON.parse(fs.readFileSync(markerFile, 'utf8')).startedAt,
    completedAt: new Date().toISOString()
  });
  return result;
}

async function rollback(args) {
  const action = required(args, '--rollback');
  const runDir = privateDirectory(required(args, '--run-dir'));
  const plan = parsePreparedPlan(runDir);
  if (action === 'status') {
    return {
      operation: plan.operation,
      finalResult: fs.existsSync(path.join(runDir, 'final-result.json')) ? JSON.parse(fs.readFileSync(path.join(runDir, 'final-result.json'), 'utf8')).status : 'PENDING',
      routePreimage: fs.existsSync(path.join(runDir, 'preimage', 'route-split', 'manifest.json')),
      appPreimage: fs.existsSync(`/Applications/.Codex Web GPT.aicc-preimage-${plan.operation}.app`),
      businessConfigPreimage: fs.existsSync(path.join(runDir, 'preimage', 'workspace-business-full-config.json')),
      personalConfigPreimage: fs.existsSync(path.join(runDir, 'preimage', 'workspace-personal-read-fetch-config.json')),
      mutation: false
    };
  }
  if (!['routes', 'dashboard', 'app', 'guidance', 'business', 'personal'].includes(action)) throw new LiveRepairError('rollback_scope_invalid', 'rollback action must be status, routes, dashboard, app, guidance, business, or personal');
  const work = inspectCodexWork();
  if (work.safe !== true || work.active.length !== 0 || work.unknown.length !== 0) throw new LiveRepairError('rollback_gate_hold', 'rollback requires exact Codex idle');
  if (action === 'routes') return restoreRouteSplitPreimage({ runDir, operation: plan.operation });
  if (action === 'dashboard') {
    const sourceRecovery = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'), '.aicc-recovery', 'gui-final-20260825', 'restore.sh');
    run('/bin/zsh', [sourceRecovery, 'apply'], { timeoutMs: 120_000, failureCode: 'dashboard_source_restore_failed' });
    const installed = installDashboardLaunchAgent({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'), port: DASHBOARD_PORT });
    const health = await waitUntil(async () => {
      const value = await httpJson(DASHBOARD_PORT, '/healthz');
      return { ok: value.status === 200, status: value.status };
    }, 60_000, 500);
    return { ok: true, action, sourceRestored: true, launchd: { label: installed.label, bootstrapAttempts: installed.bootstrapAttempts }, health };
  }
  if (action === 'app') {
    const adjacentPreimage = `/Applications/.Codex Web GPT.aicc-preimage-${plan.operation}.app`;
    const ownerPreimage = path.join(runDir, 'preimage', 'Codex Web GPT.app');
    const preimage = fs.existsSync(adjacentPreimage) ? adjacentPreimage : ownerPreimage;
    const displaced = `/Applications/.Codex Web GPT.aicc-rollback-displaced-${plan.operation}.app`;
    if (!fs.existsSync(preimage) || fs.existsSync(displaced)) throw new LiveRepairError('app_rollback_precondition', 'exact app preimage is unavailable or rollback target exists');
    if (appMainPids().length > 0) {
      const quit = run('/usr/bin/osascript', ['-e', `tell application id "${APP_ID}" to quit`], { allowFailure: true, timeoutMs: 30_000 });
      if (quit.status !== 0) throw new LiveRepairError('app_quit_refused', 'launcher normal quit was refused');
      await waitUntil(async () => ({ ok: appMainPids().length === 0 }), 90_000);
    }
    fs.renameSync(APP_PATH, displaced);
    if (preimage === adjacentPreimage) fs.renameSync(preimage, APP_PATH);
    else run('/usr/bin/ditto', [preimage, APP_PATH], { timeoutMs: 120_000 });
    run('/usr/bin/open', ['-gj', '--env', 'AICC_BACKGROUND_LAUNCH=1', APP_PATH], { timeoutMs: 30_000 });
    return { ok: true, action, restoredVersion: appVersion(APP_PATH), displaced };
  }
  if (action === 'guidance') {
    const skillRoot = path.join(os.homedir(), '.codex', 'skills');
    const backupRoot = path.join(runDir, 'preimage', 'codex-guidance');
    const displacedRoot = path.join(runDir, 'rollback-displaced', 'codex-guidance');
    if (fs.existsSync(displacedRoot)) throw new LiveRepairError('guidance_rollback_conflict', 'guidance rollback was already dispatched');
    for (const name of GUIDANCE_SKILLS) {
      const current = path.join(skillRoot, name);
      const preimage = path.join(backupRoot, 'skills', name);
      if (!fs.existsSync(current) || !fs.existsSync(preimage)) throw new LiveRepairError('guidance_rollback_precondition', `guidance rollback preimage is unavailable: ${name}`);
      fs.mkdirSync(path.join(displacedRoot, 'skills'), { recursive: true, mode: 0o700 });
      fs.renameSync(current, path.join(displacedRoot, 'skills', name));
      run('/usr/bin/ditto', [preimage, current], { timeoutMs: 60_000 });
    }
    const manifest = path.join(skillRoot, '.aicc-guidance-deployment.json');
    const manifestPreimage = path.join(backupRoot, '.aicc-guidance-deployment.json');
    fs.renameSync(manifest, path.join(displacedRoot, '.aicc-guidance-deployment.json'));
    fs.copyFileSync(manifestPreimage, manifest, fs.constants.COPYFILE_EXCL);
    return { ok: true, action, restoredSkills: [...GUIDANCE_SKILLS], displacedRoot };
  }
  const surface = action === 'business' ? 'business-full' : 'personal-read-fetch';
  const before = workspaceMcpStatus({ surfaceProfile: surface });
  if (before.remoteAuthority?.activeLeases !== 0) throw new LiveRepairError(before.remoteAuthority?.activeLeases === null ? 'workspace_lease_unknown' : 'workspace_lease_active', `${surface} rollback requires exact zero leases`);
  const preimage = path.join(runDir, 'preimage', `workspace-${surface}-config.json`);
  const target = workspaceMcpPaths({ surfaceProfile: surface }).config;
  if (!fs.existsSync(preimage)) throw new LiveRepairError('workspace_rollback_preimage_missing', `${surface} config preimage is missing`);
  const currentBackup = `${target}.rollback-displaced-${plan.operation}`;
  if (fs.existsSync(currentBackup)) throw new LiveRepairError('workspace_rollback_conflict', 'workspace displaced rollback file already exists');
  fs.copyFileSync(target, currentBackup, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(preimage, `${target}.rollback-${process.pid}.tmp`, fs.constants.COPYFILE_EXCL);
  fs.renameSync(`${target}.rollback-${process.pid}.tmp`, target);
  const installed = installWorkspaceTunnelLaunchAgent({ surfaceProfile: surface });
  const ready = await waitUntil(async () => {
    const status = await workspaceMcpStatus({ surfaceProfile: surface });
    return { ok: status.state === 'ready' && status.remoteAuthority?.activeLeases === 0, state: status.state, activeLeases: status.remoteAuthority?.activeLeases ?? null };
  }, 180_000, 1_000);
  return { ok: true, action, surface, restoredConfig: target, displaced: currentBackup, tunnelRestarted: true, launchd: { label: installed.label, bootstrapAttempts: installed.bootstrapAttempts }, ready };
}

function parseOptions(args) {
  const publicRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const operation = required(args, '--operation', SAFE_ID);
  const runDir = privateDirectory(required(args, '--run-dir'));
  const artifactsRoot = privateDirectory(path.join(os.homedir(), '.ai-control-center', 'artifacts-private'));
  if (!runDir.startsWith(`${artifactsRoot}${path.sep}`)) throw new LiveRepairError('run_directory_scope_denied', 'live repair run directory must remain under owner-only artifacts-private');
  const privateRoot = fs.realpathSync(required(args, '--private-root'));
  const candidateZip = fs.realpathSync(required(args, '--candidate-zip'));
  const leaseHelper = fs.realpathSync(required(args, '--lease-helper'));
  const requestedProgressLog = option(args, '--progress-log');
  const progressLog = requestedProgressLog ? path.resolve(requestedProgressLog) : path.join(runDir, 'progress.log');
  const progressState = path.join(runDir, 'progress.json');
  const finalCallbackPayload = path.resolve(option(args, '--final-callback-payload') ?? path.join(runDir, 'final-callback-payload.json'));
  const resumeFromRun = option(args, '--resume-from-run') == null ? null : path.resolve(required(args, '--resume-from-run'));
  const resumeEvidenceSha256 = resumeFromRun == null ? null : required(args, '--resume-evidence-sha256', /^[a-f0-9]{64}$/);
  if (path.dirname(progressLog) !== runDir) throw new LiveRepairError('progress_log_scope_denied', 'progress log must remain directly inside the exact run directory');
  if (path.dirname(finalCallbackPayload) !== runDir) throw new LiveRepairError('final_callback_payload_scope_denied', 'final callback payload must remain directly inside the exact run directory');
  if (fs.existsSync(progressLog)) throw new LiveRepairError('progress_log_conflict', 'progress log already exists; replay denied');
  if (fs.existsSync(progressState)) throw new LiveRepairError('progress_state_conflict', 'progress state already exists; replay denied');
  return {
    operation,
    runDir,
    publicRoot,
    privateRoot,
    candidateZip,
    candidateSha256: required(args, '--candidate-sha256', /^[a-f0-9]{64}$/),
    expectedAppVersion: required(args, '--expected-app-version', /^[A-Za-z0-9._-]{3,80}$/),
    savedProChat: required(args, '--saved-pro-chat'),
    savedProPrompt: fs.realpathSync(required(args, '--saved-pro-prompt')),
    savedProReceipt: fs.realpathSync(required(args, '--saved-pro-receipt')),
    taskId: required(args, '--task', TASK_ID),
    webCallbackId: required(args, '--web-callback', SAFE_ID),
    finalCallbackId: required(args, '--final-callback', SAFE_ID),
    finalCallbackPayload,
    expectedDesktopPid: Number(required(args, '--expected-desktop-pid', /^\d+$/)),
    leaseHelper,
    bun: fs.realpathSync(required(args, '--bun')),
    reconcileNativePid: option(args, '--reconcile-native-pid') == null ? null : Number(required(args, '--reconcile-native-pid', /^\d+$/)),
    reconcileNativeIdentity: option(args, '--reconcile-native-pid') == null ? null : required(args, '--reconcile-native-identity', /^[a-f0-9]{64}$/),
    maxWaitMs: Number(option(args, '--max-wait-ms') ?? 12 * 60 * 60_000),
    progressLog,
    progressState,
    resumeFromRun,
    resumeEvidenceSha256
  };
}

async function main() {
  if (process.platform !== 'darwin') throw new LiveRepairError('live_repair_requires_macos', 'final live repair is available only on macOS');
  const args = process.argv.slice(2);
  if (args.includes('--recovery-component')) {
    process.stdout.write(`${JSON.stringify(await runStageRecovery(args), null, 2)}\n`);
    return;
  }
  if (args.includes('--rollback')) {
    process.stdout.write(`${JSON.stringify(await rollback(args), null, 2)}\n`);
    return;
  }
  const options = parseOptions(args);
  if (args.includes('--prepare-only')) {
    process.stdout.write(`${JSON.stringify(prepare(options), null, 2)}\n`);
    return;
  }
  parsePreparedPlan(options.runDir);
  const result = await execute(options);
  process.stdout.write(`${JSON.stringify({ operation: result.operation, status: result.status, resultFile: path.join(options.runDir, 'final-result.json') }, null, 2)}\n`);
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`aicc-final-live-repair: ${error?.code ?? 'ERROR'}: ${sanitizeError(error)}\n`);
    process.exitCode = 1;
  });
}
