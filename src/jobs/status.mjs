import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DurableJobStore } from './durable-store.mjs';
import { JobManager } from './job-manager.mjs';
import { readRegisteredCodexActivity } from './registered-codex-activity.mjs';

export function durableJobPaths(options = {}) {
  const stateRoot = options.stateRoot
    ?? process.env.AICC_STATE_ROOT?.trim()
    ?? path.join(os.homedir(), '.ai-control-center');
  return { stateRoot, root: path.join(stateRoot, 'jobs') };
}

export function createJobManager(options = {}) {
  const paths = durableJobPaths(options);
  const store = options.store ?? new DurableJobStore({ root: paths.root, create: options.create !== false });
  return new JobManager({ store, now: options.now, leaseDurationMs: options.leaseDurationMs });
}

export function jobManagerStatus(options = {}) {
  const paths = durableJobPaths(options);
  if (!fs.existsSync(paths.root)) {
    return {
      id: 'job-manager',
      label: '내구 작업·산출물',
      state: 'ready',
      detail: '내구 작업 저장소가 아직 초기화되지 않았습니다. 첫 작업 전까지 빈 상태입니다.',
      initialized: false,
      total: 0,
      active: 0,
      activeWriters: 0,
      artifacts: 0,
      orchestrationRuns: 0
    };
  }
  const manager = options.manager ?? createJobManager({ ...options, create: false });
  const status = manager.status();
  if (!status.ok) {
    return {
      id: 'job-manager', label: '내구 작업·산출물', state: 'attention',
      detail: '작업 저장소 무결성을 확인할 수 없습니다. 다른 AICC 기능은 계속 사용할 수 있습니다.',
      isolatedFailure: true,
      integrity: status.integrity
    };
  }
  const active = ['leased', 'running', 'verifying'].reduce((sum, name) => sum + status.counts[name], 0);
  return {
    id: 'job-manager',
    label: '내구 작업·산출물',
    state: 'ready',
    detail: `${status.total}개 작업 · 활성 ${active}개 · writer ${status.activeWriters}개`,
    initialized: true,
    schemaVersion: status.schemaVersion,
    sequence: status.sequence,
    total: status.total,
    active,
    activeWriters: status.activeWriters,
    artifacts: status.artifacts,
    orchestrationRuns: status.orchestrationRuns,
    counts: status.counts,
    integrity: status.integrity
  };
}

export function listDurableJobs(options = {}) {
  const paths = durableJobPaths(options);
  if (!fs.existsSync(paths.root)) return [];
  return createJobManager({ ...options, create: false }).read().map(job => ({
    jobId: job.jobId,
    workloadClass: job.workloadClass,
    workspaceId: job.workspaceId,
    requestedRoute: job.requestedRoute,
    identityBinding: job.identityBinding,
    mode: job.mode,
    state: job.state,
    attempts: job.attempts.length,
    artifacts: job.artifactRefs.length,
    updatedAt: job.updatedAt
  }));
}

export function showDurableJob(jobId, options = {}) {
  const paths = durableJobPaths(options);
  if (!fs.existsSync(paths.root)) return null;
  const job = createJobManager({ ...options, create: false }).read(jobId);
  return {
    ...job,
    checkpoints: job.checkpoints.map(item => ({ ref: item.ref, sha256: item.sha256, at: item.at })),
    results: job.results.map(item => ({ ...item }))
  };
}

const evidenceStates = new Set(['completed', 'failed']);
const evidenceTypes = new Set(['exact-bytes', 'code-test', 'document-pdf', 'browser-visual', 'deployment']);
const evidenceMedia = new Set(['application/json', 'text/plain', 'application/pdf', 'image/png', 'image/jpeg']);
const evidenceSha = /^[a-f0-9]{64}$/;
const evidenceTime = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const evidenceKey = value => createHash('sha256').update('aicc-evidence-history:' + value).digest('hex').slice(0, 20);

/** Current observations from the existing owner ledger; never a writer grant. */
function readLedgerWorkActivity(options = {}) {
  const clock = (options.now ?? Date.now)();
  const base = { ok: true, readOnly: true, automaticReplay: false, status: 'UNKNOWN',
    observedAt: new Date(clock).toISOString(), freshnessSeconds: 120, total: null,
    items: [], coverage: 'REGISTERED_LEDGER_ONLY', completionVerified: false,
    nextAction: '등록 원장의 관측만 표시합니다. 미등록 코덱스·브라우저와 파일 변경만으로 작업 중을 판정하지 않습니다.' };
  try {
    const { root } = durableJobPaths(options);
    if (!fs.existsSync(root)) return { ...base, status: 'NOT_INITIALIZED', total: 0 };
    for (let p = path.resolve(root);; p = path.dirname(p)) {
      const stat = fs.lstatSync(p);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('linked_owner');
      if (path.dirname(p) === p) break;
    }
    for (const name of ['state.json', 'journal.jsonl']) {
      const file = path.join(root, name);
      if (!fs.existsSync(file)) continue;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) throw Error('invalid_ledger');
    }
    const snapshot = path.join(root, 'state.json');
    if (fs.existsSync(snapshot)) {
      const raw = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
      if (!raw || raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.sequence) || raw.sequence < 0
        || !raw.jobs || typeof raw.jobs !== 'object' || Array.isArray(raw.jobs)) throw Error('invalid_activity_snapshot');
      for (const name of ['remoteLeases', 'remoteReplay']) {
        if (raw[name] !== undefined && (!raw[name] || typeof raw[name] !== 'object' || Array.isArray(raw[name]))) throw Error('invalid_activity_snapshot');
      }
    } else if (!fs.existsSync(path.join(root, 'journal.jsonl'))) {
      return { ...base, status: 'NOT_INITIALIZED', total: 0 };
    }
    const { state } = new DurableJobStore({ root, create: false }).read();
    const maps = [state.jobs, state.remoteLeases, state.remoteReplay];
    if (!maps.every(value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 10000)) throw Error('activity_bounds');
    const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
    const fresh = value => Number.isFinite(time(value)) && clock >= time(value) && clock - time(value) < 120000;
    const liveLease = value => Number.isFinite(time(value)) && time(value) > clock;
    const rows = [];
    for (const [id, job] of Object.entries(state.jobs)) {
      if (job?.jobId !== id || !Array.isArray(job.attempts)) throw Error('invalid_job');
      if (!['leased', 'running', 'verifying', 'paused'].includes(job.state)) continue;
      const attempt = job.attempts.at(-1), lease = job.writerLease;
      const bound = !!attempt && typeof attempt.attemptId === 'string' && !!attempt.attemptId
        && typeof job.workspaceId === 'string' && !!job.workspaceId
        && typeof job.identityBinding === 'string' && !!job.identityBinding
        && typeof job.requestedRoute === 'string' && !!job.requestedRoute
        && attempt.identityBinding === job.identityBinding && attempt.routeId === job.requestedRoute
        && lease?.workspaceId === job.workspaceId && lease?.attemptId === attempt.attemptId;
      const at = attempt?.heartbeatAt ?? attempt?.startedAt;
      const observed = bound && ['running', 'verifying'].includes(job.state)
        && attempt.state === 'running' && liveLease(lease.expiresAt) && fresh(at);
      rows.push({ key: evidenceKey('job:' + id), source: 'DURABLE_JOB',
        actor: job.direction === 'web_to_local' ? 'WEB_ROUTE' : job.direction === 'local' ? 'LOCAL_AGENT' : 'UNKNOWN',
        state: observed ? 'RECENT_EXECUTION' : job.state === 'paused' ? 'PAUSED' : bound ? 'STALE_OR_WAITING' : 'UNKNOWN',
        evidence: observed ? 'BOUND_ATTEMPT_HEARTBEAT' : 'SAVED_STATE_ONLY',
        lastObservedAt: evidenceTime(at), writeAuthorized: false, completionVerified: false });
    }
    for (const [id, lease] of Object.entries(state.remoteLeases)) {
      if (lease?.leaseId !== id) throw Error('invalid_remote_lease');
      if (lease.state !== 'leased') continue;
      const at = Object.values(state.remoteReplay).filter(item => item?.leaseId === id)
        .map(item => item.consumedAt).filter(value => Number.isFinite(time(value)))
        .sort((a, b) => time(b) - time(a))[0] ?? null;
      // Request consumption is admission, not a completed write or a live model.
      const observed = typeof lease.identityBinding === 'string' && !!lease.identityBinding
        && typeof lease.workspaceId === 'string' && !!lease.workspaceId && liveLease(lease.expiresAt) && fresh(at);
      rows.push({ key: evidenceKey('lease:' + id), source: 'WORKSPACE_MCP', actor: 'REMOTE_AGENT',
        state: observed ? 'RECENT_TOOL_ADMISSION' : 'STALE_OR_WAITING',
        evidence: observed ? 'CONSUMED_WRITE_REQUEST' : 'LEASE_ONLY', lastObservedAt: evidenceTime(at),
        writeAuthorized: false, completionVerified: false });
    }
    rows.sort((a, b) => (Date.parse(b.lastObservedAt) || 0) - (Date.parse(a.lastObservedAt) || 0) || a.key.localeCompare(b.key));
    return { ...base, status: rows.length ? 'AVAILABLE' : 'EMPTY', total: rows.length,
      items: rows.slice(0, 24), truncated: rows.length > 24 };
  } catch { return base; }
}

export function readMobileWorkActivity(options = {}) {
  const ledger = readLedgerWorkActivity(options);
  const local = readRegisteredCodexActivity({ stateRoot: durableJobPaths(options).stateRoot, now: (options.now ?? Date.now)() });
  if (local.status === 'NOT_INITIALIZED') return ledger;
  const items = [...ledger.items, ...local.items].sort((a, b) =>
    (Date.parse(b.lastObservedAt) || 0) - (Date.parse(a.lastObservedAt) || 0) || a.key.localeCompare(b.key));
  const unknown = ledger.status === 'UNKNOWN' || local.status === 'UNKNOWN' || local.partial === true;
  return { ...ledger, status: unknown && !items.length ? 'UNKNOWN' : items.length ? 'AVAILABLE' : 'EMPTY',
    coverage: 'REGISTERED_LEDGER_AND_CODEX_SESSIONS_ONLY', partial: unknown,
    sources: { ledger: ledger.status, codex: local.status }, total: unknown ? null : ledger.total + local.total,
    items: items.slice(0, 24), truncated: items.length > 24 || ledger.truncated === true,
    nextAction: '등록 원장과 등록된 코덱스 대화의 최근 이벤트만 표시합니다. 로그 관측은 현재 프로세스 생존·작성권·완료를 증명하지 않으며 미등록 작업은 확인할 수 없습니다.' };
}

/** Mobile projection only; no dispatch, writer acquisition or goal mutation. */
export function readMobileOrchestration(options = {}) {
  const base = { ok: true, readOnly: true, automaticReplay: false, status: 'UNKNOWN',
    observedAt: new Date().toISOString(), total: null, shown: 0, truncated: false, runs: [],
    nativeGoalAuthority: 'UNKNOWN',
    nextAction: '원 소유자 도구에서 협업 실행 원장과 지원 기능을 확인하세요.' };
  try {
    const { root } = durableJobPaths(options);
    try { fs.lstatSync(root); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { ...base, status: 'NOT_INITIALIZED', total: 0,
        nextAction: '저장된 협업 실행이 없습니다. 이 조회는 새 실행을 만들지 않습니다.' };
    }
    for (let cursor = path.resolve(root);; cursor = path.dirname(cursor)) {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('linked_owner');
      if (path.dirname(cursor) === cursor) break;
    }
    if (!fs.lstatSync(root).isDirectory()) throw Error('invalid_owner');
    for (const name of ['state.json', 'journal.jsonl']) {
      let stat;
      try { stat = fs.lstatSync(path.join(root, name)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) throw Error('invalid_ledger');
    }
    const { state } = new DurableJobStore({ root, create: false }).read();
    const runs = state.orchestrationRuns, jobs = state.jobs;
    if (state.schemaVersion !== 1 || !runs || Array.isArray(runs) || !jobs || Array.isArray(jobs)
      || Object.keys(runs).length > 10000 || Object.keys(jobs).length > 10000) throw Error('invalid_state');
    const states = new Set(['planned', 'queued', 'leased', 'running', 'verifying', 'completed', 'failed', 'cancelled', 'paused']);
    const kinds = new Set(['coordinator', 'researcher', 'critic', 'solver', 'merger', 'writer', 'verifier']);
    const rows = Object.entries(runs).map(([id, run]) => {
      if (!run || id !== run.runId || !Array.isArray(run.roleDag) || run.roleDag.length > 100
        || !Array.isArray(run.jobIds) || run.jobIds.length > 100) throw Error('invalid_run');
      const roles = run.roleDag.map((role, index) => {
        const matches = run.jobIds.filter(key => jobs[key]?.jobId === key).map(key => jobs[key]).filter(job => job?.roleId === role.roleId
          && job.orchestrationRunId === id && job.workspaceId === run.workspaceId && job.identityBinding === run.identityBinding);
        const job = matches.length === 1 ? matches[0] : null;
        return { label: '역할 ' + (index + 1), kind: kinds.has(role.kind) ? role.kind : 'UNKNOWN',
          state: job && states.has(job.state) ? job.state.toUpperCase() : 'UNKNOWN',
          resultRecorded: !!job && Array.isArray(job.results) && job.results.length > 0 };
      });
      const bindingUnproven = !run.workspaceId || !run.identityBinding
        || roles.some(role => role.state === 'UNKNOWN');
      return { key: evidenceKey(id), state: !bindingUnproven && states.has(run.state) ? run.state.toUpperCase() : 'UNKNOWN',
        updatedAt: evidenceTime(run.updatedAt), roles, parentGoalLinked: !!run.parentGoal,
        completionVerified: false };
    }).sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.key.localeCompare(b.key));
    return { ...base, status: rows.length ? 'AVAILABLE' : 'EMPTY', total: rows.length,
      shown: Math.min(rows.length, 24), truncated: rows.length > 24, runs: rows.slice(0, 24),
      nextAction: '역할 상태는 저장된 기록입니다. 실행 제어는 지원되는 원 소유자 도구에서 수행하세요.' };
  } catch { return base; }
}

/**
 * Owner-bound, read-only, bounded history from the existing durable store.
 * Only a safe projection is returned: no raw job IDs, request/result text,
 * identity bindings, private paths, tool arguments, leases or artifact bytes.
 * Saved verification flags describe the recorded time, not a fresh file check.
 */
export function readDurableEvidenceHistory(options = {}) {
  const base = { ok: true, scope: 'owner-durable-jobs', readOnly: true,
    status: 'UNKNOWN', totalTerminal: null, shown: 0, truncated: false,
    fileOpenSupported: false, currentFileReverified: false, jobs: [],
    nextAction: '기존 소유자 도구에서 내구 작업 원장과 등록된 파일 근거를 별도로 확인하세요.' };
  try {
    const { root } = durableJobPaths(options);
    let rootStat;
    try { rootStat = fs.lstatSync(root); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { ...base, status: 'NOT_INITIALIZED',
        totalTerminal: 0, nextAction: '내구 작업 저장소가 아직 초기화되지 않았습니다. 새 작업을 만들거나 재실행하지 않습니다.' };
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('owner_root_invalid');
    // Never follow an owner's job directory or ledger alias into another account.
    for (let cursor = path.resolve(root);; cursor = path.dirname(cursor)) {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('owner_boundary_linked');
      if (path.dirname(cursor) === cursor) break;
    }
    for (const name of ['state.json', 'journal.jsonl']) {
      const file = path.join(root, name);
      let stat;
      try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) throw Error('owner_ledger_invalid');
    }
    const store = options.store ?? new DurableJobStore({ root, create: false });
    const { state } = store.read();
    if (state.schemaVersion !== 1 || !state.jobs || !state.artifacts || !state.orchestrationRuns
      || Array.isArray(state.jobs) || Array.isArray(state.artifacts) || Array.isArray(state.orchestrationRuns)
      || Object.keys(state.jobs).length > 10000 || Object.keys(state.artifacts).length > 20000) throw Error('evidence_store_bounds');
    const terminal = Object.entries(state.jobs).filter(([key, job]) =>
      job && key === job.jobId && evidenceStates.has(job.state)
      && typeof job.jobId === 'string' && job.jobId.length > 0 && job.jobId.length <= 200).map(([, job]) => job);
    terminal.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
      || a.jobId.localeCompare(b.jobId));
    const jobs = terminal.slice(0, 24).map(job => {
      const run = job.orchestrationRunId ? state.orchestrationRuns[job.orchestrationRunId] : null;
      const runBound = !!run && Array.isArray(run.jobIds) && run.jobIds.includes(job.jobId)
        && run.runId === job.orchestrationRunId && run.workspaceId === job.workspaceId && run.identityBinding === job.identityBinding;
      const cleanup = !job.orchestrationRunId ? { status: 'NO_BOUND_RUN' }
        : !runBound ? { status: 'BINDING_UNKNOWN' }
          : run.cleanup && evidenceTime(run.cleanup.at) && run.cleanup.foreignTargetsTouched === 0
            && Array.isArray(run.cleanup.cleanedBrowserLeaseIds)
            ? { status: 'RECORDED', at: evidenceTime(run.cleanup.at),
                cleanedLeaseCount: Math.min(run.cleanup.cleanedBrowserLeaseIds.length, 10000),
                foreignTargetsUntouched: true }
            : { status: 'NOT_RECORDED' };
      const registered = Object.entries(state.artifacts).filter(([key, item]) =>
        item && key === item.artifactId && item.jobId === job.jobId).map(([, item]) => item).slice(0, 9);
      const refs = Array.isArray(job.artifactRefs) ? job.artifactRefs.slice(0, 100) : [];
      const artifacts = registered.slice(0, 8).map((item, index) => {
        const checks = Array.isArray(item.verification) ? item.verification.slice(0, 8)
          .filter(check => evidenceTypes.has(check?.type))
          .map(check => ({ type: check.type,
            status: check.status === 'pass' || check.status === 'fail' ? check.status : 'unknown',
            checkedAt: evidenceTime(check.checkedAt) })) : [];
        const recordedPass = item.verificationCurrent === true && checks.length > 0
          && checks.every(check => check.status === 'pass') && evidenceSha.test(item.output?.sha256 ?? '');
        return { label: '산출물 ' + (index + 1), mediaType: evidenceMedia.has(item.output?.mediaType) ? item.output.mediaType : 'UNKNOWN',
          sha256: evidenceSha.test(item.output?.sha256 ?? '') ? item.output.sha256 : null,
          referenceInCompletedJob: refs.includes(item.artifactId),
          verification: recordedPass ? 'RECORDED_PASS' : checks.some(check => check.status === 'fail')
            ? 'RECORDED_FAIL' : 'UNKNOWN', verifiedAt: evidenceTime(item.verifiedAt),
          checks };
      });
      const latest = Array.isArray(job.results) ? [...job.results].reverse().find(row =>
        row?.jobId === job.jobId && Array.isArray(job.attempts)
        && job.attempts.some(attempt => attempt.attemptId === row.attemptId)) : null;
      const validatorStatus = ['pass','fail','pending','unknown'].includes(latest?.validatorStatus)
        ? latest.validatorStatus.toUpperCase() : 'UNKNOWN';
      return { key: evidenceKey(job.jobId), state: job.state.toUpperCase(),
        updatedAt: evidenceTime(job.updatedAt), artifactCount: artifacts.length,
        unresolvedArtifactRefs: refs.filter(ref => !state.artifacts[ref] || state.artifacts[ref].artifactId !== ref || state.artifacts[ref].jobId !== job.jobId).length,
        additionalArtifactsOmitted: registered.length > artifacts.length,
        validatorStatus, artifactVerifications: artifacts, cleanup,
        nextAction: job.state === 'failed'
          ? '실패 기록을 원 소유자 작업에서 조정하세요. 원 요청을 자동 재전송하지 않습니다.'
          : !artifacts.length || artifacts.some(item => item.verification !== 'RECORDED_PASS')
            ? '원 소유자 도구로 누락·변경된 산출물과 검증 기록을 확인하세요.'
            : '검증은 원장 기록 시점 기준입니다. 현재 파일 확인과 실제 열기는 별도 소유자 도구가 필요합니다.' };
    });
    return { ...base, status: terminal.length ? 'AVAILABLE' : 'EMPTY',
      totalTerminal: terminal.length, shown: jobs.length, truncated: terminal.length > jobs.length, jobs,
      nextAction: terminal.length ? '각 작업을 펼쳐 저장된 검증·정리 기록을 읽으세요. 파일 내용은 이 화면에서 열지 않습니다.'
        : '저장된 완료·실패 내구 작업이 없습니다. 실행 또는 재조회 요청은 보내지 않습니다.' };
  } catch {
    return { ...base, status: 'UNKNOWN',
      nextAction: '내구 작업 원장 조회가 실패했습니다. 기존 소유자 도구에서 무결성과 권한을 확인하세요. 다른 기능은 유지됩니다.' };
  }
}
