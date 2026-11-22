// 관제 실행 서비스: 읽기(status·plan·logs)와 변경(preview → 일회 confirm).
// 변경 규칙(AGENTS.md): 이름 있는 action, 새 preview, 일회 확인, 단일 writer, 전후 상태 확인, 되돌리기.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand as defaultRunCommand } from '../lib/command.mjs';
import { createRunners, defaultScriptPaths, listWindowsProcesses } from './runners.mjs';
import { CodexTaskCallbackService } from '../codex-task-callback.mjs';
import {
  RUNNERS, SCHEMA_VERSION, SupervisedRunError, configPathFor, defaultRunsRoot, discoverRuns, fileMtime,
  fingerprint, normalizeGroup, readRun, serializeConfig, tailLines, validName, validSessionId, writeRunRaw
} from './state.mjs';

export { SupervisedRunError } from './state.mjs';
export const ACTIONS = Object.freeze(['start', 'add-group', 'end-group', 'close-tab', 'wake-group']);
const PREVIEW_TTL_MS = 5 * 60_000;
const GROUP_KEYS = ['name', 'runner', 'agent', 'workingDirectory', 'sessionId', 'promptFile', 'progressFile', 'elevated', 'wakeCallbackId'];

function fail(code, message, status = 400) { throw new SupervisedRunError(code, message, status); }

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function absoluteOrNull(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('invalid_path', `${label}는 절대 경로여야 합니다.`);
  return path.normalize(value);
}

export function validateGroupInput(input = {}) {
  if (!input || typeof input !== 'object') fail('invalid_group', '그룹 정보가 필요합니다.');
  for (const key of Object.keys(input)) if (!GROUP_KEYS.includes(key)) fail('invalid_group', `알 수 없는 그룹 필드: ${key}`);
  if (!validName(input.name) || /^S0$/i.test(input.name)) fail('invalid_group_name', '그룹 이름은 영문·숫자·._- 41자 이내이며 S0는 쓸 수 없습니다.');
  const runner = input.runner ?? 'codex';
  if (!RUNNERS.includes(runner)) fail('invalid_runner', `실행기는 ${RUNNERS.join('/')} 중 하나입니다.`);
  if (runner === 'kiro' && !validName(input.agent ?? '')) fail('invalid_agent', 'Kiro 그룹에는 agent 이름이 필요합니다.');
  const workingDirectory = absoluteOrNull(input.workingDirectory, 'workingDirectory');
  if (!workingDirectory) fail('invalid_path', 'workingDirectory가 필요합니다.');
  if (input.sessionId && !validSessionId(runner, input.sessionId)) fail('invalid_session_id', '세션 ID 형식이 실행기와 맞지 않습니다.');
  return {
    name: input.name,
    sessionId: input.sessionId || null,
    runner,
    agent: input.agent ?? null,
    workingDirectory,
    promptFile: absoluteOrNull(input.promptFile, 'promptFile'),
    progressFile: absoluteOrNull(input.progressFile, 'progressFile'),
    wakeCallbackId: input.wakeCallbackId ? String(input.wakeCallbackId) : null,
    elevated: runner === 'kiro' ? input.elevated !== false : false
  };
}

function groupState(group, inspection, ended) {
  if (ended) return 'ended';
  if (!group.sessionId) return 'unopened';
  if (inspection?.activityUnknown) return 'observation_unknown';
  if (!inspection?.found) return 'not_found';
  if (inspection.stale) return 'stale';
  if (inspection.active) return 'turn_active';
  if (inspection.crashed) return 'crashed';
  return 'waiting';
}

export const STATE_LABELS = Object.freeze({
  turn_active: '차례 진행', waiting: '대기', ended: '종료', unopened: '미개시',
  crashed: '비정상 종료 의심', stale: '정체 의심', not_found: '세션 없음', observation_unknown: '차례 상태 미확인'
});

export function createSupervisedRunService(options = {}) {
  const runsRoot = path.resolve(options.runsRoot ?? defaultRunsRoot(options.env));
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center');
  const root = path.join(stateRoot, 'supervised-runs');
  const previewsRoot = path.join(root, 'previews');
  const lockPath = path.join(root, 'writer.lock');
  const now = options.now ?? (() => Date.now());
  const runCommand = options.runCommand ?? defaultRunCommand;
  const paths = { ...defaultScriptPaths(), ...options.paths };
  const runners = options.runners ?? createRunners({ ...options, paths });
  const listProcesses = options.listProcesses ?? (() => listWindowsProcesses(runCommand));
  const commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
  const callbacks = options.callbacks ?? new CodexTaskCallbackService({ stateRoot });

  function callbackFor(group) {
    if (group.runner !== 'codex' || !group.sessionId || !group.wakeCallbackId) fail('callback_required', '기존 exact 대화에 등록한 일회용 callback이 필요합니다.', 409);
    const binding = callbacks.inspect({ callbackId: group.wakeCallbackId });
    if (binding.taskId !== group.sessionId || !binding.projectRoot || path.resolve(binding.projectRoot) !== path.resolve(group.workingDirectory)) fail('callback_scope_mismatch', 'callback 대화와 작업 폴더가 그룹과 다릅니다.', 409);
    return binding;
  }

  function wakeStatus(group) {
    if (group.runner !== 'codex') return { supported: false, state: 'retired', reason: 'Kiro 깨우기는 종료됐습니다.' };
    try {
      const binding = callbackFor(group);
      return { supported: true, callbackId: binding.callbackId, state: binding.state, evidence: binding.evidence, canWake: ['armed', 'destination_busy'].includes(binding.state) };
    } catch (error) { return { supported: false, state: 'HOLD', canWake: false, reason: error.code ?? 'callback_unavailable' }; }
  }

  function resolveRun(ref) {
    if (typeof ref !== 'string' || !ref.trim()) fail('run_required', '실행(run) 이름 또는 ops 폴더가 필요합니다.');
    const candidates = discoverRuns(runsRoot);
    const direct = path.isAbsolute(ref) ? path.resolve(ref) : null;
    const match = direct
      ? candidates.find(item => path.resolve(item).toLowerCase() === direct.toLowerCase())
      : candidates.find(item => {
        try { return readRun(item).run.runName === ref; } catch { return path.basename(item) === ref; }
      }) ?? candidates.find(item => path.basename(item) === ref);
    if (!match) fail('run_not_found', `등록 위치(${runsRoot}) 안에서 실행을 찾지 못했습니다: ${ref}`, 404);
    return match;
  }

  async function inspectRun(opsDirectory, processes) {
    const { run, fingerprint: fp } = readRun(opsDirectory);
    const needsProcesses = [run.s0, ...run.groups, ...run.endedGroups].some(group => group?.runner === 'codex' && group.sessionId);
    const procList = needsProcesses ? (processes ?? await listProcesses()) : [];
    const describe = (group, ended) => {
      const runner = runners[group.runner];
      const inspection = group.sessionId && runner ? runner.inspect(group.sessionId, { staleMinutes: run.staleMinutes, processes: procList }) : null;
      const state = groupState(group, inspection, ended);
      return {
        ...group,
        state,
        stateLabel: STATE_LABELS[state],
        tabOpen: Boolean(inspection?.found && (inspection.active || inspection.processAlive)),
        lastTurnEndAt: inspection?.lastTurnEndAt ?? null,
        lastWriteAt: inspection?.lastWriteAt ?? null,
        lastProgressAt: fileMtime(group.progressFile) ?? inspection?.lastTurnEndAt ?? null,
        wake: wakeStatus(group)
      };
    };
    const s0 = run.s0 ? describe(run.s0, false) : null;
    let wakeState = null;
    try { wakeState = JSON.parse(fs.readFileSync(path.join(run.supervisorDirectory, 'wake-state.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { /* none */ }
    const deadlineMs = run.deadline ? Date.parse(run.deadline) : NaN;
    return {
      runName: run.runName,
      opsDirectory: run.opsDirectory,
      schemaVersion: run.schemaVersion,
      deadline: run.deadline,
      deadlinePassed: Number.isFinite(deadlineMs) ? now() >= deadlineMs : null,
      taskName: run.taskName,
      fingerprint: fp,
      lastWakeAt: wakeState?.lastWakeAt ?? null,
      lastWakeLog: tailLines(path.join(run.supervisorDirectory, 'wake-log.md'), 1)?.[0] ?? null,
      s0,
      groups: run.groups.map(group => describe(group, false)),
      endedGroups: run.endedGroups.map(group => describe(group, true))
    };
  }

  async function status({ run } = {}) {
    const dirs = run ? [resolveRun(run)] : discoverRuns(runsRoot);
    let processes;
    const runs = [];
    for (const dir of dirs) {
      try {
        const cfg = readRun(dir).run;
        if (processes === undefined && [cfg.s0, ...cfg.groups, ...cfg.endedGroups].some(group => group?.runner === 'codex' && group.sessionId)) processes = await listProcesses();
        runs.push(await inspectRun(dir, processes ?? []));
      } catch (error) {
        runs.push({ runName: path.basename(dir), opsDirectory: dir, error: { code: error.code ?? 'read_failed', message: error.message } });
      }
    }
    return { ok: true, schemaVersion: 1, runsRoot, generatedAt: new Date(now()).toISOString(), runs };
  }

  function validateStart(input = {}) {
    if (!validName(input.runName)) fail('invalid_run_name', '실행 이름은 영문·숫자·._- 41자 이내입니다.');
    const opsDirectory = absoluteOrNull(input.opsDirectory, 'opsDirectory') ?? path.join(runsRoot, input.runName);
    if (!inside(runsRoot, opsDirectory)) fail('ops_outside_root', `ops 폴더는 ${runsRoot} 아래여야 합니다.`, 403);
    const deadlineMs = Date.parse(input.deadline ?? '');
    if (!Number.isFinite(deadlineMs) || !/[+-]\d\d:\d\d$|Z$/.test(String(input.deadline))) fail('invalid_deadline', '기한은 시간대가 있는 ISO 시각이어야 합니다(예: 2026-11-02T09:00:00+09:00).');
    if (deadlineMs <= now()) fail('deadline_passed', '기한이 이미 지났습니다.');
    const groups = (Array.isArray(input.groups) ? input.groups : []).map(validateGroupInput);
    if (!groups.length) fail('groups_required', '그룹이 하나 이상 필요합니다.');
    if (new Set(groups.map(group => group.name.toLowerCase())).size !== groups.length) fail('duplicate_group', '그룹 이름이 겹칩니다.');
    if (input.launch === true) fail('supervisor_launch_retired', '예약 S0/Kiro 실행을 다시 켜지 않습니다. 준비 후 기존 Codex callback을 연결하세요.', 409);
    const intervalMinutes = Number.isInteger(input.intervalMinutes) ? input.intervalMinutes : 10;
    if (intervalMinutes < 5 || intervalMinutes > 120) fail('invalid_interval', '깨우기 간격은 5~120분입니다.');
    const s0Agent = input.s0Agent ?? 'codex-local';
    if (!validName(s0Agent)) fail('invalid_agent', 'S0 agent 이름이 올바르지 않습니다.');
    return { runName: input.runName, opsDirectory: path.normalize(opsDirectory), deadline: String(input.deadline), intervalMinutes, s0Agent, launch: input.launch === true, groups };
  }

  function plan(input = {}) {
    const args = validateStart(input);
    const supervisor = path.join(args.opsDirectory, 'SUPERVISOR');
    const exists = fs.existsSync(configPathFor(args.opsDirectory));
    return {
      ok: !exists,
      action: 'start',
      args,
      conflicts: exists ? ['이 ops 폴더에는 이미 관제 실행 정본이 있습니다. 그룹 추가·종료를 쓰세요.'] : [],
      wouldCreate: ['wake-config.json']
        .filter(name => !fs.existsSync(path.join(supervisor, name))).map(name => path.join(supervisor, name)),
      launch: args.launch
        ? { s0: '관리자 Kiro 탭(UAC 없음)', wakeTask: `AICC-S0-Wake-${args.runName}`, intervalMinutes: args.intervalMinutes }
        : null,
      canonicalState: configPathFor(args.opsDirectory)
    };
  }

  function logs({ run, lines = 30 } = {}) {
    const dir = resolveRun(run);
    const { run: cfg } = readRun(dir);
    const count = Math.max(1, Math.min(200, Number(lines) || 30));
    const sup = cfg.supervisorDirectory;
    return {
      ok: true,
      runName: cfg.runName,
      wakeLog: tailLines(path.join(sup, 'wake-log.md'), count) ?? [],
      supervisorLog: tailLines(path.join(sup, 'SUPERVISOR-LOG.md'), count) ?? [],
      groups: [...cfg.groups, ...cfg.endedGroups].map(group => ({
        name: group.name,
        progressFile: group.progressFile,
        lastProgressAt: fileMtime(group.progressFile),
        lines: group.progressFile ? tailLines(group.progressFile, count) ?? [] : []
      }))
    };
  }

  // ---- 변경 ----
  function readCurrent(action, args) {
    if (action === 'start') {
      const file = configPathFor(args.opsDirectory);
      return { fingerprint: fs.existsSync(file) ? fingerprint(fs.readFileSync(file, 'utf8')) : 'absent' };
    }
    const dir = resolveRun(args.run);
    const current = readRun(dir);
    return { ...current, opsDirectory: dir };
  }

  async function prepare(action, input = {}) {
    if (action === 'start') {
      const args = validateStart(input);
      if (fs.existsSync(configPathFor(args.opsDirectory))) fail('run_exists', '이미 있는 실행입니다. 덮어쓰지 않습니다.', 409);
      return { args, impact: '관제 실행 목록을 준비합니다. 모델 실행·S0 예약 등록은 하지 않습니다.', rollback: '이번에 생성한 wake-config.json만 이전 부재 상태로 복원합니다.' };
    }
    const dir = resolveRun(input.run);
    const { run } = readRun(dir);
    const runRef = dir;
    if (action === 'add-group') {
      const group = validateGroupInput(input.group);
      if (run.groups.some(item => item.name.toLowerCase() === group.name.toLowerCase())) fail('group_exists', `이미 있는 그룹입니다: ${group.name}`, 409);
      const open = input.open === true;
      if (open) fail('direct_launch_retired', '탭 열기와 지시 전송은 별개입니다. 기존 mux에 연결하거나 등록된 callback으로 깨우세요.', 409);
      if (open && !group.promptFile) fail('prompt_required', '탭을 열려면 promptFile이 필요합니다.');
      return { args: { run: runRef, group, open }, impact: `${run.runName}에 ${group.name}(${group.runner})를 등록합니다. 등록만으로 실행되지 않습니다.`, rollback: '정본을 이전 내용으로 되돌립니다.' };
    }
    if (action === 'end-group') {
      if (!validName(input.name)) fail('invalid_group_name', '그룹 이름이 필요합니다.');
      const group = run.groups.find(item => item.name === input.name);
      if (!group) fail('group_not_found', `진행 목록에 없는 그룹입니다: ${input.name}`, 404);
      const reason = typeof input.reason === 'string' ? input.reason.slice(0, 200) : null;
      return { args: { run: runRef, name: group.name, reason, closeTab: input.closeTab === true }, impact: `${group.name}를 종료 목록으로 옮깁니다. 진행 중 차례와 외부에 이미 등록된 callback은 중지하지 않습니다${input.closeTab === true && group.runner !== 'codex' ? '. 차례가 끝나 있으면 탭도 닫습니다' : ''}.`, rollback: '정본을 이전 내용으로 되돌립니다.' };
    }
    if (action === 'close-tab') {
      if (!validName(input.name)) fail('invalid_group_name', '그룹 이름이 필요합니다.');
      const group = [...run.groups, ...run.endedGroups].find(item => item.name === input.name);
      if (!group) fail('group_not_found', `없는 그룹입니다: ${input.name}`, 404);
      if (!group.sessionId) fail('session_required', '세션 ID가 없는 그룹은 닫을 탭이 없습니다.', 409);
      const inspection = await inspectGroup(group, run);
      if (group.runner === 'codex') fail('codex_close_not_supported', '기존 mux에 연결해 Codex를 정상 종료하세요. 프로세스 부재로 차례 종료를 추정하지 않습니다.', 409);
      if (inspection.active) fail('turn_active', `${group.name}는 차례 진행 중입니다. 끝난 뒤 닫으세요.`, 409);
      return { args: { run: runRef, name: group.name }, impact: `${group.name} 세션(${group.sessionId})의 터미널 탭만 닫습니다. 대화 기록은 남습니다.`, rollback: `되돌리기 대신 같은 세션 재개: ${runners[group.runner].resumeHint(group)}` };
    }
    if (action === 'wake-group') {
      const group = run.groups.find(item => item.name === input.name);
      if (!group) fail('group_not_found', '진행 목록에 없는 그룹입니다.', 404);
      const binding = callbackFor(group);
      if (!['armed', 'destination_busy'].includes(binding.state)) fail('callback_not_dispatchable', '기존 callback 결과를 조회하세요. 자동 재발신하지 않습니다.', 409);
      const stat = fs.lstatSync(binding.resultFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail('callback_result_unsafe', '결과 파일을 확인할 수 없습니다.', 409);
      const resultSha256 = crypto.createHash('sha256').update(fs.readFileSync(binding.resultFile)).digest('hex');
      return { args: { run: runRef, name: group.name, callbackId: binding.callbackId, resultSha256 }, impact: `${group.name}의 기존 exact 대화에 결과 hash를 한 번 전달합니다. 접수·차례 시작·완료는 별도로 확인합니다.`, rollback: '전송 후 취소·원요청 재전송은 하지 않습니다. 같은 callback 영수증을 조회합니다.' };
    }
    fail('action_not_allowed', `허용되지 않은 작업입니다: ${action}`, 404);
  }

  async function inspectGroup(group, run) {
    const processes = group.runner === 'codex' ? await listProcesses() : [];
    return runners[group.runner].inspect(group.sessionId, { staleMinutes: run?.staleMinutes ?? 45, processes });
  }

  function previewFile(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(token)) fail('invalid_confirmation', '확인 토큰 형식이 올바르지 않습니다.');
    return path.join(previewsRoot, `${fingerprint(token)}.json`);
  }

  async function preview(action, input = {}, audience = { scope: 'cli' }) {
    if (!ACTIONS.includes(action)) fail('action_not_allowed', `허용되지 않은 작업입니다: ${action}`, 404);
    const prepared = await prepare(action, input);
    const current = readCurrent(action, prepared.args);
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now() + (options.previewLifetimeMs ?? PREVIEW_TTL_MS);
    fs.mkdirSync(previewsRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(previewFile(token), JSON.stringify({ schemaVersion: 1, action, args: prepared.args, before: current.fingerprint, expiresAt, audience }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { ok: true, action, args: prepared.args, impact: prepared.impact, rollback: prepared.rollback, before: current.fingerprint, confirmationToken: token, expiresAt: new Date(expiresAt).toISOString() };
  }

  function acquireLock(action) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, action, startedAt: new Date(now()).toISOString() }));
      fs.closeSync(fd);
    } catch (error) {
      if (error.code === 'EEXIST') fail('writer_busy', '다른 관제 변경이 진행 중입니다. 끝난 뒤 다시 시도하세요.', 409);
      throw error;
    }
    return () => { try { fs.unlinkSync(lockPath); } catch { /* no-op */ } };
  }

  async function run(command, timeoutMs = commandTimeoutMs) {
    const result = await runCommand(command.executable, command.args, { timeoutMs, maxBytes: 256_000, cwd: command.cwd });
    return { ok: Boolean(result.ok), exitCode: result.exitCode ?? null, timedOut: Boolean(result.timedOut), stdout: String(result.stdout ?? '').slice(-4000), stderr: String(result.stderr ?? '').slice(-2000) };
  }

  function mutateConfig(current, mutate) {
    const config = JSON.parse(current.raw);
    mutate(config);
    config.schemaVersion = SCHEMA_VERSION;
    if (!config.runName) config.runName = current.run.runName;
    const raw = serializeConfig(config);
    writeRunRaw(current.file, raw);
    return raw;
  }

  function restore(current) {
    writeRunRaw(current.file, current.raw);
    return fingerprint(fs.readFileSync(current.file, 'utf8')) === current.fingerprint;
  }

  async function executeStart(args) {
    // Prepare only. Existing mux/callback owners retain execution and scheduling.
    const file = configPathFor(args.opsDirectory);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const config = { schemaVersion: SCHEMA_VERSION, runName: args.runName, deadline: args.deadline,
      taskName: null, s0: null, groups: args.groups, endedGroups: [] };
    fs.writeFileSync(file, serializeConfig(config), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const after = readRun(args.opsDirectory).run;
    return { verified: after.runName === args.runName, after, executionStarted: false, rollback: { attempted: false } };
  }
  async function confirm(token, audience = { scope: 'cli' }) {
    const file = previewFile(token);
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') fail('confirmation_not_found', '확인 토큰이 없거나 이미 사용되었습니다.', 404);
      fail('invalid_confirmation', '확인 기록을 읽을 수 없습니다. 새로 미리보세요.');
    }
    if (JSON.stringify(record.audience) !== JSON.stringify(audience) || (audience.scope === 'phone' && !['end-group', 'close-tab'].includes(record.action))) fail('confirmation_scope_mismatch', '미리 본 연결에서만 확인할 수 있습니다.', 403);
    // Atomic claim: only one concurrent caller can consume this preview.
    try { fs.renameSync(file, `${file}.consumed`); }
    catch { fail('confirmation_not_found', '이미 소비한 확인입니다.', 409); }
    if (record.expiresAt <= now()) fail('confirmation_expired', '확인 시간이 지났습니다. 새로 미리보세요.', 409);
    const release = acquireLock(record.action);
    try {
      const current = readCurrent(record.action, record.args);
      if (current.fingerprint !== record.before) fail('stale_preview', '정본이 미리보기 이후 달라졌습니다. 다시 미리보세요.', 409);
      const { action, args } = record;
      if (action === 'wake-group') {
        const group = current.run.groups.find(item => item.name === args.name);
        const binding = callbackFor(group ?? {});
        if (binding.callbackId !== args.callbackId) fail('callback_scope_mismatch', 'callback 연결이 달라졌습니다.', 409);
        const delivery = await callbacks.complete({ callbackId: args.callbackId, expectedResultSha256: args.resultSha256, waitForTerminal: false, timeoutMs: 20_000 });
        return { ok: delivery.ok, action, verified: Boolean(delivery.turnId), delivery, goalCompleted: false, automaticReplay: false };
      }
      if (action === 'start') {
        const result = await executeStart(args);
        return { ok: result.verified, action, args, ...result, after: result.after ? summarize(result.after) : null };
      }
      if (action === 'add-group' || action === 'end-group') {
        const stamp = new Date(now()).toISOString();
        let target;
        mutateConfig(current, config => {
          config.groups = Array.isArray(config.groups) ? config.groups : [];
          config.endedGroups = Array.isArray(config.endedGroups) ? config.endedGroups : [];
          if (action === 'add-group') {
            config.endedGroups = config.endedGroups.filter(item => item.name !== args.group.name);
            target = { ...args.group, addedAt: stamp };
            config.groups.push(target);
          } else {
            const index = config.groups.findIndex(item => item.name === args.name);
            target = { ...config.groups[index], endedAt: stamp, reason: args.reason };
            config.groups.splice(index, 1);
            config.endedGroups.push(target);
          }
        });
        const after = readRun(current.opsDirectory);
        const verified = action === 'add-group'
          ? after.run.groups.filter(item => item.name === args.group.name).length === 1
          : !after.run.groups.some(item => item.name === args.name) && after.run.endedGroups.some(item => item.name === args.name);
        if (!verified) {
          const restored = restore(current);
          return { ok: false, action, args, verified, rollback: { attempted: true, restored } };
        }
        let followUp = null;
        const group = normalizeGroup(target, action === 'end-group');
        if (action === 'add-group' && args.open) {
          followUp = { step: 'open', command: await run(runners[group.runner].openCommand(group, {}), 120_000) };
        }
        if (action === 'end-group' && args.closeTab && group.sessionId) {
          const inspection = await inspectGroup(group, after.run);
          followUp = inspection.active || inspection.activityUnknown || group.runner === 'codex'
            ? { step: 'close-tab', skipped: group.runner === 'codex' ? 'codex_close_not_supported' : 'turn_active' }
            : { step: 'close-tab', command: await run(runners[group.runner].closeCommand(group, { promptFile: group.promptFile ?? after.run.s0?.wakePrompt }), 120_000) };
        }
        return { ok: true, action, args, verified, rollback: { attempted: false }, followUp, after: summarize(after.run) };
      }
      if (action === 'close-tab') {
        const group = [...current.run.groups, ...current.run.endedGroups].find(item => item.name === args.name);
        if (!group?.sessionId) fail('group_not_found', '그룹이 사라졌습니다.', 409);
        if (group.runner === 'codex') fail('codex_close_not_supported', 'mux에서 정상 종료하세요.', 409);
        const before = await inspectGroup(group, current.run);
        if (before.active) fail('turn_active', `${group.name}는 차례 진행 중입니다.`, 409);
        const command = await run(runners[group.runner].closeCommand(group, { promptFile: group.promptFile ?? current.run.s0?.wakePrompt }), 120_000);
        const afterInspection = await inspectGroup(group, current.run);
        const verified = command.ok && !afterInspection.active && !afterInspection.processAlive;
        return { ok: verified, action, args, verified, command, rollback: { attempted: false, hint: runners[group.runner].resumeHint(group) } };
      }
      fail('action_not_allowed', '허용되지 않은 작업입니다.', 404);
    } finally { release(); }
  }

  function summarize(run) {
    return { runName: run.runName, deadline: run.deadline, groups: run.groups.map(group => group.name), endedGroups: run.endedGroups.map(group => group.name) };
  }

  return { runsRoot, status, plan, logs, preview, confirm, actions: ACTIONS };
}
