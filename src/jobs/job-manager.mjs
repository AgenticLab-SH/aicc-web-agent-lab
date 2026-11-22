import crypto from 'node:crypto';
import fs from 'node:fs';
import { DurableStoreError, durableStateHash } from './durable-store.mjs';
import { assertSupportedParentGoalAuthority } from '../goals/service.mjs';

const JOB_STATES = new Set(['queued', 'leased', 'running', 'verifying', 'paused', 'completed', 'failed', 'cancelled']);
const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled']);
const WORKLOAD_CLASSES = new Set(['interactive', 'batch', 'browser', 'remote', 'render']);
const MODES = new Set(['write', 'read-only']);
const DIRECTIONS = new Set(['web_to_local', 'local_to_web', 'local', 'oob_ops']);
const FORBIDDEN_KEYS = /^(?:prompt|response|transcript|cookie|cookies|secret|token|password|authorization|browserProfile|tabContent|content)$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export class JobManagerError extends Error {
  constructor(code, message) { super(message); this.name = 'JobManagerError'; this.code = code; }
}

function iso(now) { return new Date(now).toISOString(); }

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new JobManagerError('invalid_job', `${label} is required`);
  return value.trim();
}

function rejectSensitivePayload(value, path = 'request') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw new JobManagerError('sensitive_body_prohibited', `${path}.${key} cannot be stored`);
    rejectSensitivePayload(child, `${path}.${key}`);
  }
}

function activeAttempt(job) {
  return [...job.attempts].reverse().find(attempt => ['queued', 'running'].includes(attempt.state)) ?? null;
}

function releaseWriter(state, job) {
  if (job.writerLease?.mode === 'write') {
    const current = state.workspaceLeases[job.workspaceId];
    if (current?.attemptId === job.writerLease.attemptId) delete state.workspaceLeases[job.workspaceId];
  }
  job.writerLease = null;
}

function requireJob(state, jobId) {
  const job = state.jobs[jobId];
  if (!job) throw new JobManagerError('job_not_found', `unknown job: ${jobId}`);
  return job;
}

function requireState(job, allowed, operation) {
  if (!allowed.includes(job.state)) throw new JobManagerError('invalid_transition', `${operation} cannot run while job is ${job.state}`);
}

function validateResultRecord(record) {
  rejectSensitivePayload(record, 'result');
  const claim = requireString(record.claim, 'result claim');
  if (claim.length > 4_000) throw new JobManagerError('result_too_large', 'result claim must be 4000 characters or less');
  const evidence = Array.isArray(record.evidence) ? record.evidence.map(item => {
    const ref = requireString(item?.ref, 'evidence ref');
    const sha256 = requireString(item?.sha256, 'evidence sha256');
    if (!SHA256.test(sha256)) throw new JobManagerError('invalid_result', 'evidence sha256 is invalid');
    return { ref, sha256 };
  }) : [];
  if (!['pending', 'pass', 'fail', 'unknown'].includes(record.validatorStatus ?? 'pending')) throw new JobManagerError('invalid_result', 'validator status is invalid');
  return {
    resultId: record.resultId?.trim() || crypto.randomUUID(),
    claim,
    evidence,
    counterexample: record.counterexample?.trim() || null,
    unknown: record.unknown?.trim() || null,
    recommendation: record.recommendation?.trim() || null,
    artifactRefs: [...new Set(record.artifactRefs ?? [])],
    validatorStatus: record.validatorStatus ?? 'pending'
  };
}

export function resultRecordHash(record) {
  return durableStateHash({
    jobId: record.jobId, attemptId: record.attemptId,
    operationId: record.operationId ?? null, requestHash: record.requestHash ?? null,
    record: validateResultRecord(record)
  });
}
function validateRoleDag(roleDag, surfaceMode) {
  if (!Array.isArray(roleDag)) throw new JobManagerError('invalid_dag', 'role DAG must be an array');
  const roles = new Map();
  for (const role of roleDag) {
    const roleId = requireString(role?.roleId, 'role id');
    if (roles.has(roleId)) throw new JobManagerError('invalid_dag', `duplicate role id: ${roleId}`);
    if (!MODES.has(role.mode)) throw new JobManagerError('invalid_dag', `invalid role mode: ${role.mode}`);
    roles.set(roleId, role);
  }
  if ([...roles.values()].filter(role => role.mode === 'write').length > 1) throw new JobManagerError('invalid_dag', 'role DAG can declare at most one writer');
  if (surfaceMode === 'browser-only' && [...roles.values()].some(role => role.mode === 'write')) throw new JobManagerError('unsupported_surface', 'browser-only orchestration cannot declare a local writer');
  const visiting = new Set();
  const visited = new Set();
  const visit = roleId => {
    if (visiting.has(roleId)) throw new JobManagerError('invalid_dag', 'role DAG contains a cycle');
    if (visited.has(roleId)) return;
    visiting.add(roleId);
    for (const dependency of roles.get(roleId).dependencies ?? []) {
      if (!roles.has(dependency)) throw new JobManagerError('invalid_dag', `unknown role dependency: ${dependency}`);
      visit(dependency);
    }
    visiting.delete(roleId);
    visited.add(roleId);
  };
  for (const roleId of roles.keys()) visit(roleId);
  return structuredClone(roleDag);
}

export function selectWorker(job, workers, { mode = 'read-only' } = {}) {
  if (!MODES.has(mode)) throw new JobManagerError('invalid_mode', `unsupported worker mode: ${mode}`);
  const compatible = workers.filter(worker =>
    Array.isArray(worker.workloadClasses) && worker.workloadClasses.includes(job.workloadClass)
    && Array.isArray(worker.modes) && worker.modes.includes(mode)
    && Array.isArray(worker.routeIds) && (worker.routeIds.includes(job.requestedRoute) || worker.routeIds.includes('*'))
  );
  return compatible.sort((left, right) => (left.active ?? 0) - (right.active ?? 0) || String(left.workerId).localeCompare(String(right.workerId)))[0] ?? null;
}

export class JobManager {
  constructor({ store, now = () => Date.now(), leaseDurationMs = 30_000 } = {}) {
    if (!store) throw new JobManagerError('store_required', 'durable job store is required');
    this.store = store;
    this.now = now;
    this.leaseDurationMs = leaseDurationMs;
  }

  createRun(spec) {
    rejectSensitivePayload(spec, 'run');
    assertSupportedParentGoalAuthority(spec.parentGoal);
    const runId = spec.runId?.trim() || crypto.randomUUID();
    const capabilitySnapshotHash = requireString(spec.capabilitySnapshotHash, 'capability snapshot hash');
    if (!SHA256.test(capabilitySnapshotHash)) throw new JobManagerError('invalid_capability_snapshot', 'capability snapshot hash is invalid');
    const mode = requireString(spec.mode, 'mode');
    if (!['full', 'browser-only'].includes(mode)) throw new JobManagerError('invalid_run', `unsupported orchestration mode: ${mode}`);
    const roleDag = validateRoleDag(spec.roleDag ?? [], mode);
    const initiallyRunnable = roleDag.filter(role => role.dependencies.length === 0).length;
    const defaultFanOut = Number(spec.budgets?.defaultFanOut ?? Math.max(1, Math.min(64, initiallyRunnable)));
    const hardActiveCap = Number(spec.budgets?.hardActiveCap ?? Math.max(defaultFanOut, Math.min(64, roleDag.length)));
    if (!Number.isInteger(defaultFanOut) || defaultFanOut < 1 || defaultFanOut > 64
      || !Number.isInteger(hardActiveCap) || hardActiveCap < defaultFanOut || hardActiveCap > 64) {
      throw new JobManagerError('invalid_budget', 'fan-out and hard active cap must be integers from 1 to 64, with fan-out no greater than the cap');
    }
    return this.store.transaction('orchestration.run.create', state => {
      if (state.orchestrationRuns[runId]) throw new JobManagerError('run_exists', `orchestration run already exists: ${runId}`);
      const record = {
        contractVersion: 1,
        runId,
        requestId: requireString(spec.requestId, 'request id'),
        rootTaskId: requireString(spec.rootTaskId, 'root task id'),
        parentGoal: spec.parentGoal ? {
          goalId: requireString(spec.parentGoal.goalId, 'parent goal id'),
          sourceUpdatedAt: requireString(spec.parentGoal.sourceUpdatedAt, 'parent goal source revision'),
          ...(spec.parentGoal.authorityMode != null ? { authorityMode: spec.parentGoal.authorityMode } : {}),
          ...(spec.parentGoal.goalSnapshotHash != null ? { goalSnapshotHash: spec.parentGoal.goalSnapshotHash } : {})
        } : null,
        workspaceId: requireString(spec.workspaceId, 'workspace id'),
        routeId: requireString(spec.routeId, 'route id'),
        identityBinding: requireString(spec.identityBinding, 'identity binding'),
        mode,
        state: 'planned',
        budgets: { ...structuredClone(spec.budgets ?? {}), defaultFanOut, hardActiveCap },
        activeLimit: defaultFanOut,
        capabilitySnapshotHash,
        capabilitySnapshot: spec.capabilitySnapshot ? structuredClone(spec.capabilitySnapshot) : null,
        roleDag,
        jobIds: [],
        resultRefs: [],
        artifactRefs: [],
        hooks: [],
        operations: {},
        cleanup: null,
        rawTranscriptStored: false,
        createdAt: iso(this.now()),
        updatedAt: iso(this.now()),
        terminalReason: null
      };
      state.orchestrationRuns[runId] = record;
      return record;
    }).result;
  }

  submit(spec) {
    rejectSensitivePayload(spec);
    const workloadClass = requireString(spec.workloadClass, 'workload class');
    if (!WORKLOAD_CLASSES.has(workloadClass)) throw new JobManagerError('invalid_job', `unsupported workload class: ${workloadClass}`);
    const mode = spec.mode ?? 'read-only';
    if (!MODES.has(mode)) throw new JobManagerError('invalid_job', `unsupported job mode: ${mode}`);
    const direction = spec.direction == null ? null : requireString(spec.direction, 'direction');
    if (direction !== null && !DIRECTIONS.has(direction)) throw new JobManagerError('invalid_job', `unsupported job direction: ${direction}`);
    const routeClass = spec.routeClass == null ? null : requireString(spec.routeClass, 'route class');
    const routeInstanceRef = spec.routeInstanceRef == null ? null : requireString(spec.routeInstanceRef, 'route instance ref');
    const requestHash = requireString(spec.requestHash, 'request hash');
    if (!SHA256.test(requestHash)) throw new JobManagerError('invalid_job', 'request hash must be sha256');
    const workspaceId = requireString(spec.workspaceId, 'workspace id');
    const idempotencyKey = requireString(spec.idempotencyKey, 'idempotency key');
    const requestedRoute = requireString(spec.requestedRoute, 'requested route');
    const identityKey = `${workspaceId}:${idempotencyKey}`;
    return this.store.transaction('job.submit', state => {
      const existingId = state.idempotency[identityKey];
      if (existingId) return { job: state.jobs[existingId], duplicate: true };
      const jobId = spec.jobId?.trim() || crypto.randomUUID();
      if (state.jobs[jobId]) throw new JobManagerError('job_exists', `job already exists: ${jobId}`);
      const operationId = spec.operationId == null ? jobId : requireString(spec.operationId, 'operation id');
      const dependencies = [...new Set(spec.dependencies ?? [])];
      for (const dependency of dependencies) if (!state.jobs[dependency]) throw new JobManagerError('dependency_not_found', `unknown dependency: ${dependency}`);
      let run = null;
      if (spec.orchestrationRunId) {
        run = state.orchestrationRuns[spec.orchestrationRunId];
        if (!run) throw new JobManagerError('run_not_found', `unknown orchestration run: ${spec.orchestrationRunId}`);
        if (run.workspaceId !== workspaceId) throw new JobManagerError('run_workspace_mismatch', 'run and job workspace differ');
        const role = run.roleDag.find(item => item.roleId === spec.roleId);
        if (!role) throw new JobManagerError('role_not_found', `unknown run role: ${spec.roleId}`);
        if (role.mode !== mode) throw new JobManagerError('role_mode_mismatch', 'job mode differs from the role DAG');
        if (run.jobIds.some(id => state.jobs[id]?.roleId === spec.roleId)) throw new JobManagerError('role_already_bound', `role already has a job: ${spec.roleId}`);
      }
      const at = iso(this.now());
      const job = {
        contractVersion: 2,
        jobId,
        operationId,
        idempotencyKey,
        workloadClass,
        workspaceId,
        direction,
        requestedRoute,
        routeClass,
        routeInstanceRef,
        identityBinding: requireString(spec.identityBinding, 'identity binding'),
        mode,
        state: 'queued',
        requestRef: requireString(spec.requestRef, 'request ref'),
        requestHash,
        dependencies,
        orchestrationRunId: spec.orchestrationRunId ?? null,
        roleId: spec.roleId ?? null,
        attempts: [],
        writerLease: null,
        checkpoints: [],
        artifactRefs: [],
        results: [],
        createdAt: at,
        updatedAt: at,
        terminalReason: null
      };
      state.jobs[jobId] = job;
      state.idempotency[identityKey] = jobId;
      if (run) {
        run.jobIds.push(jobId);
        run.state = 'running';
        run.updatedAt = at;
      }
      return { job, duplicate: false };
    }).result;
  }

  dispatch(jobId, worker, { mode } = {}) {
    return this.store.transaction('job.dispatch', state => {
      const job = requireJob(state, jobId);
      requireState(job, ['queued'], 'dispatch');
      const effectiveMode = mode ?? job.mode;
      if (effectiveMode !== job.mode) throw new JobManagerError('mode_mismatch', 'dispatch mode differs from submitted mode');
      const dependenciesReady = job.dependencies.every(id => state.jobs[id]?.state === 'completed');
      if (!dependenciesReady) throw new JobManagerError('dependencies_pending', 'job dependencies are not complete');
      const run = job.orchestrationRunId ? state.orchestrationRuns[job.orchestrationRunId] : null;
      if (run) {
        const activeInRun = run.jobIds.filter(id => ['leased', 'running', 'verifying'].includes(state.jobs[id]?.state)).length;
        const activeLimit = Math.min(run.activeLimit ?? run.budgets.defaultFanOut, run.budgets.hardActiveCap);
        if (activeInRun >= activeLimit) throw new JobManagerError('run_backpressure', 'orchestration active limit reached');
      }
      if (!selectWorker(job, [worker], { mode: effectiveMode })) throw new JobManagerError('worker_incompatible', 'worker capability does not match job');
      const activeForWorker = Object.values(state.jobs).filter(candidate =>
        ['leased', 'running', 'verifying'].includes(candidate.state)
        && activeAttempt(candidate)?.workerId === worker.workerId
      ).length;
      if (Number.isInteger(worker.maxActive) && activeForWorker >= worker.maxActive) throw new JobManagerError('worker_backpressure', 'worker active queue limit reached');
      const attemptId = crypto.randomUUID();
      const expiresAt = iso(this.now() + this.leaseDurationMs);
      if (effectiveMode === 'write') {
        const held = state.workspaceLeases[job.workspaceId];
        if (held) throw new JobManagerError('writer_conflict', `workspace already has writer attempt ${held.attemptId}`);
        state.workspaceLeases[job.workspaceId] = { workspaceId: job.workspaceId, jobId, attemptId, mode: 'write', expiresAt };
      }
      const attempt = {
        attemptId,
        operationId: job.operationId ?? job.jobId,
        workerId: requireString(worker.workerId, 'worker id'),
        routeId: job.requestedRoute,
        routeClass: job.routeClass ?? null,
        routeInstanceRef: job.routeInstanceRef ?? null,
        identityBinding: job.identityBinding,
        state: 'queued',
        fallbackFrom: job.pendingFallback?.fallbackFrom ?? null,
        reason: job.pendingFallback?.reason ?? null,
        approvedPolicy: job.pendingFallback?.approvedPolicy ?? null,
        startedAt: null,
        heartbeatAt: null,
        terminalAt: null
      };
      delete job.pendingFallback;
      job.attempts.push(attempt);
      job.writerLease = { workspaceId: job.workspaceId, attemptId, mode: effectiveMode, expiresAt };
      job.state = 'leased';
      job.updatedAt = iso(this.now());
      return { job, attempt };
    }).result;
  }

  start(jobId, attemptId) {
    return this.store.transaction('job.start', state => {
      const job = requireJob(state, jobId);
      requireState(job, ['leased'], 'start');
      const attempt = activeAttempt(job);
      if (!attempt || attempt.attemptId !== attemptId || attempt.state !== 'queued') throw new JobManagerError('attempt_mismatch', 'attempt is not the current lease');
      const at = iso(this.now());
      attempt.state = 'running';
      attempt.startedAt = at;
      attempt.heartbeatAt = at;
      job.state = 'running';
      job.updatedAt = at;
      return { job, attempt };
    }).result;
  }

  heartbeat(jobId, attemptId, checkpoint = null) {
    if (checkpoint) {
      rejectSensitivePayload(checkpoint, 'checkpoint');
      if (!SHA256.test(requireString(checkpoint.sha256, 'checkpoint sha256'))) throw new JobManagerError('invalid_checkpoint', 'checkpoint sha256 is invalid');
    }
    return this.store.transaction('job.heartbeat', state => {
      const job = requireJob(state, jobId);
      requireState(job, ['running', 'verifying'], 'heartbeat');
      const attempt = activeAttempt(job);
      if (!attempt || attempt.attemptId !== attemptId) throw new JobManagerError('attempt_mismatch', 'attempt is not active');
      const at = iso(this.now());
      const expiresAt = iso(this.now() + this.leaseDurationMs);
      attempt.heartbeatAt = at;
      job.writerLease.expiresAt = expiresAt;
      if (job.writerLease.mode === 'write') state.workspaceLeases[job.workspaceId].expiresAt = expiresAt;
      if (checkpoint) job.checkpoints.push({ ref: requireString(checkpoint.ref, 'checkpoint ref'), sha256: checkpoint.sha256, at });
      job.updatedAt = at;
      return { job, attempt };
    }).result;
  }

  beginVerification(jobId, attemptId) {
    return this.store.transaction('job.verify.begin', state => {
      const job = requireJob(state, jobId);
      requireState(job, ['running'], 'begin verification');
      const attempt = activeAttempt(job);
      if (!attempt || attempt.attemptId !== attemptId) throw new JobManagerError('attempt_mismatch', 'attempt is not active');
      job.state = 'verifying';
      job.updatedAt = iso(this.now());
      return job;
    }).result;
  }

  recordResult(jobId, attemptId, resultRecord) {
    const record = validateResultRecord(resultRecord);
    return this.store.transaction('job.result.record', state => {
      const job = requireJob(state, jobId);
      const attempt = job.attempts.find(item => item.attemptId === attemptId);
      if (!attempt) throw new JobManagerError('attempt_mismatch', 'result does not name an existing attempt');
      const operationId = attempt.operationId ?? job.operationId ?? job.jobId;
      if ((resultRecord.operationId != null && resultRecord.operationId !== operationId)
        || (resultRecord.requestHash != null && resultRecord.requestHash !== job.requestHash)) {
        throw new JobManagerError('result_binding_mismatch', 'result differs from the original operation or request');
      }
      const prior = job.results.find(item => item.resultId === record.resultId);
      if (prior) {
        const priorRecord = Object.fromEntries(Object.keys(record).map(key => [key, prior[key]]));
        if (prior.attemptId !== attemptId || durableStateHash(priorRecord) !== durableStateHash(record)) {
          throw new JobManagerError('result_conflict', 'result id already refers to different attempt evidence');
        }
        return prior;
      }
      const current = activeAttempt(job);
      const late = !['running', 'verifying'].includes(job.state) || current?.attemptId !== attemptId;
      if (late && (!attempt.startedAt || !['paused', 'failed', 'superseded', 'completed'].includes(attempt.state))) {
        throw new JobManagerError('attempt_mismatch', 'late result requires an exact previously started attempt');
      }
      const saved = {
        contractVersion: 1, ...record, jobId, attemptId, operationId, requestHash: job.requestHash,
        late, observedAttemptState: attempt.state, parentAdoption: 'unknown', recordedAt: iso(this.now())
      };
      saved.resultHash = resultRecordHash(saved);
      job.results.push(saved);
      job.updatedAt = saved.recordedAt;
      const run = job.orchestrationRunId ? state.orchestrationRuns[job.orchestrationRunId] : null;
      // Preserve late evidence without feeding an obsolete attempt into the current merge.
      if (run && !late) {
        run.resultRefs.push(`${jobId}:${saved.resultId}`);
        run.updatedAt = saved.recordedAt;
      }
      return saved;
    }).result;
  }

  reconcileResultConsumption(jobId, attemptId, input) {
    rejectSensitivePayload(input, 'adoption');
    const binding = Object.fromEntries([
      'resultId', 'resultHash', 'operationId', 'requestHash', 'consumerId',
      'destination', 'effectKey', 'goalRevision', 'identityBinding'
    ].map(key => [key, requireString(input[key], key)]));
    if (!SHA256.test(binding.resultHash)) throw new JobManagerError('invalid_result', 'result hash is invalid');
    const state = this.store.read().state;
    const job = requireJob(state, jobId);
    const attempt = job.attempts.find(item => item.attemptId === attemptId);
    const result = job.results.find(item => item.resultId === binding.resultId && item.attemptId === attemptId);
    if (!attempt || !result) throw new JobManagerError('result_not_found', 'exact original attempt result is required');
    if (binding.operationId !== (attempt.operationId ?? job.operationId ?? job.jobId)
      || binding.requestHash !== job.requestHash || binding.resultHash !== resultRecordHash(result)) {
      throw new JobManagerError('result_binding_mismatch', 'consumption differs from the original result');
    }
    const run = state.orchestrationRuns[job.orchestrationRunId];
    if (!run || run.identityBinding !== binding.identityBinding) throw new JobManagerError('adoption_identity_mismatch', 'consumption must use the bound run identity');
    const key = durableStateHash({ resultId: binding.resultId, consumerId: binding.consumerId,
      destination: binding.destination, effectKey: binding.effectKey });
    const receipt = result.consumptions?.find(item => item.key === key) ?? null;
    if (receipt && durableStateHash(receipt.binding) !== durableStateHash(binding)) {
      throw new JobManagerError('adoption_conflict', 'consumption key already names different evidence or goal revision');
    }
    // Absence proves no stored ACK, never that an external turn/effect was not sent.
    return { state: receipt ? 'consumed' : 'unknown', receipt: structuredClone(receipt),
      reconciliation: receipt ? 'original-ack-found' : 'original-ack-not-found', replayAllowed: false,
      parentGoalCompletion: 'unknown' };
  }

  acknowledgeResult(jobId, attemptId, input, { checkParentGoal } = {}) {
    rejectSensitivePayload(input, 'adoption');
    const binding = Object.fromEntries([
      'resultId', 'resultHash', 'operationId', 'requestHash', 'consumerId',
      'destination', 'effectKey', 'goalRevision', 'identityBinding'
    ].map(key => [key, requireString(input[key], key)]));
    const expectedRunUpdatedAt = requireString(input.expectedRunUpdatedAt, 'expected run revision');
    if (!SHA256.test(binding.resultHash)) throw new JobManagerError('invalid_result', 'result hash is invalid');
    return this.store.transaction('job.result.consume', state => {
      const job = requireJob(state, jobId);
      const attempt = job.attempts.find(item => item.attemptId === attemptId);
      const result = job.results.find(item => item.resultId === binding.resultId && item.attemptId === attemptId);
      if (!attempt || !result) throw new JobManagerError('result_not_found', 'exact original attempt result is required');
      if (binding.operationId !== (attempt.operationId ?? job.operationId ?? job.jobId)
        || binding.requestHash !== job.requestHash || binding.resultHash !== resultRecordHash(result)) {
        throw new JobManagerError('result_binding_mismatch', 'consumption differs from the original result');
      }
      const run = state.orchestrationRuns[job.orchestrationRunId];
      if (!run || run.identityBinding !== binding.identityBinding) throw new JobManagerError('adoption_identity_mismatch', 'consumption must use the bound run identity');
      // Revision is suitability metadata, never a new key for replaying an effect.
      const key = durableStateHash({
        resultId: binding.resultId, consumerId: binding.consumerId,
        destination: binding.destination, effectKey: binding.effectKey
      });
      const prior = result.consumptions?.find(item => item.key === key);
      if (prior) {
        if (durableStateHash(prior.binding) !== durableStateHash(binding)) throw new JobManagerError('adoption_conflict', 'consumption key already names different evidence or goal revision');
        return { duplicate: true, receipt: prior };
      }
      assertSupportedParentGoalAuthority(run.parentGoal);
      if (run.updatedAt !== expectedRunUpdatedAt) throw new JobManagerError('adoption_revision_changed', 'read the current run before acknowledging consumption');
      if (['paused', 'cancelled'].includes(run.state) || ['paused', 'cancelled'].includes(job.state)) {
        throw new JobManagerError('adoption_stopped', 'paused or cancelled work cannot adopt a new result');
      }
      let parentGoalObservation = null;
      if (run.parentGoal) {
        if (binding.goalRevision !== run.parentGoal.sourceUpdatedAt) throw new JobManagerError('parent_goal_revision_changed', 'consumption must name the bound tracked goal revision');
        if (typeof checkParentGoal !== 'function') throw new JobManagerError('parent_goal_check_required', 'bound consumption requires the trusted tracked-goal reader');
        parentGoalObservation = checkParentGoal(structuredClone(run.parentGoal));
        if (!parentGoalObservation || parentGoalObservation.goalId !== run.parentGoal.goalId
          || parentGoalObservation.sourceUpdatedAt !== run.parentGoal.sourceUpdatedAt
          || parentGoalObservation.status !== 'ACTIVE' || parentGoalObservation.check !== 'tracked-ledger-observed'
          || !SHA256.test(parentGoalObservation.goalSnapshotHash ?? '')
          || run.parentGoal.goalSnapshotHash && parentGoalObservation.goalSnapshotHash !== run.parentGoal.goalSnapshotHash) {
          throw new JobManagerError('parent_goal_check_invalid', 'trusted tracked-goal observation does not match the bound run');
        }
        // Persist only defined observation metadata, never a reader's extra goal/body fields.
        parentGoalObservation = Object.fromEntries(['goalId','sourceUpdatedAt','goalSnapshotHash','status','check','definitionBinding','observedAt'].map(key => [key, parentGoalObservation[key]]));
      }
      const at = iso(this.now());
      const receipt = {
        key, binding, jobId, attemptId, runId: run.runId, rootTaskId: run.rootTaskId,
        state: 'consumed', authorityMode: 'COOPERATIVE',
        goalRevisionStatus: parentGoalObservation ? 'tracked-ledger-observed' : 'caller-reported', parentGoalCompletion: 'unknown',
        ...(parentGoalObservation ? { parentGoalObservation } : {}),
        observedRunUpdatedAt: expectedRunUpdatedAt, recordedAt: at
      };
      result.consumptions ??= [];
      result.consumptions.push(receipt);
      result.parentAdoption = 'consumed';
      // This ACK records the caller's consumption, not an external effect or goal completion.
      job.updatedAt = at;
      run.updatedAt = at;
      return { duplicate: false, receipt };
    }).result;
  }
  complete(jobId, attemptId, artifactRefs = []) {
    return this.store.transaction('job.complete', state => {
      const job = requireJob(state, jobId);
      requireState(job, ['verifying'], 'complete');
      const attempt = activeAttempt(job);
      if (!attempt || attempt.attemptId !== attemptId) throw new JobManagerError('attempt_mismatch', 'attempt is not active');
      const uniqueRefs = [...new Set(artifactRefs)];
      if (!uniqueRefs.length) throw new JobManagerError('artifact_required', 'completed jobs require a verified artifact');
      for (const artifactId of uniqueRefs) {
        const artifact = state.artifacts[artifactId];
        if (!artifact || artifact.jobId !== jobId || artifact.verificationCurrent !== true) {
          throw new JobManagerError('artifact_unverified', `artifact is missing, stale, or unverified: ${artifactId}`);
        }
        try {
          if (!artifact.privatePath || fileSha256(artifact.privatePath) !== artifact.output.sha256) {
            artifact.verificationCurrent = false;
            artifact.staleReason = 'output_hash_changed';
            throw new JobManagerError('artifact_unverified', `artifact changed after verification: ${artifactId}`);
          }
        } catch (error) {
          if (error instanceof JobManagerError) throw error;
          artifact.verificationCurrent = false;
          artifact.staleReason = 'output_missing';
          throw new JobManagerError('artifact_unverified', `artifact output is unavailable: ${artifactId}`);
        }
      }
      const at = iso(this.now());
      job.artifactRefs = uniqueRefs;
      job.state = 'completed';
      job.updatedAt = at;
      attempt.state = 'completed';
      attempt.terminalAt = at;
      releaseWriter(state, job);
      const run = job.orchestrationRunId ? state.orchestrationRuns[job.orchestrationRunId] : null;
      if (run) {
        run.artifactRefs = [...new Set([...run.artifactRefs, ...uniqueRefs])];
        const runJobs = run.jobIds.map(id => state.jobs[id]);
        if (runJobs.length && runJobs.every(item => item.state === 'completed')) run.state = 'completed';
        run.updatedAt = at;
      }
      return job;
    }).result;
  }

  pause(jobId, reason = 'operator_pause') {
    return this.store.transaction('job.pause', state => {
      const job = requireJob(state, jobId);
      requireState(job, ['leased', 'running', 'verifying'], 'pause');
      const attempt = activeAttempt(job);
      const at = iso(this.now());
      if (attempt) { attempt.state = 'paused'; attempt.reason = reason; attempt.terminalAt = at; }
      job.state = 'paused';
      job.terminalReason = reason;
      job.updatedAt = at;
      releaseWriter(state, job);
      return job;
    }).result;
  }

  resume(jobId) {
    return this.store.transaction('job.resume', state => {
      const job = requireJob(state, jobId);
      requireState(job, ['paused'], 'resume');
      job.state = 'queued';
      job.terminalReason = null;
      job.updatedAt = iso(this.now());
      return job;
    }).result;
  }

  cancel(jobId, reason = 'operator_cancel') {
    return this.store.transaction('job.cancel', state => {
      const job = requireJob(state, jobId);
      if (TERMINAL_JOB_STATES.has(job.state)) throw new JobManagerError('invalid_transition', `cannot cancel terminal job ${job.state}`);
      const attempt = activeAttempt(job);
      const at = iso(this.now());
      if (attempt) { attempt.state = 'failed'; attempt.reason = reason; attempt.terminalAt = at; }
      job.state = 'cancelled';
      job.terminalReason = reason;
      job.updatedAt = at;
      releaseWriter(state, job);
      return job;
    }).result;
  }

  failAttempt(jobId, attemptId, reason = 'worker_failed') {
    return this.store.transaction('job.fail', state => {
      const job = requireJob(state, jobId);
      requireState(job, ['leased', 'running', 'verifying'], 'fail');
      const attempt = activeAttempt(job);
      if (!attempt || attempt.attemptId !== attemptId) throw new JobManagerError('attempt_mismatch', 'attempt is not active');
      const at = iso(this.now());
      attempt.state = 'failed';
      attempt.reason = reason;
      attempt.terminalAt = at;
      job.state = 'failed';
      job.terminalReason = reason;
      job.updatedAt = at;
      releaseWriter(state, job);
      return job;
    }).result;
  }

  requestFailover(jobId, { routeId, routeClass = null, routeInstanceRef = null, identityBinding, reason, approvedPolicy }) {
    return this.store.transaction('job.failover.request', state => {
      const job = requireJob(state, jobId);
      requireState(job, ['paused', 'failed'], 'failover');
      const previous = job.attempts.at(-1);
      if (previous && !['paused', 'failed', 'superseded'].includes(previous.state)) throw new JobManagerError('attempt_not_terminal', 'previous attempt must be terminal before failover');
      if (previous) previous.state = 'superseded';
      const previousRoute = job.requestedRoute;
      job.requestedRoute = requireString(routeId, 'failover route');
      job.routeClass = routeClass == null ? null : requireString(routeClass, 'failover route class');
      job.routeInstanceRef = routeInstanceRef == null ? null : requireString(routeInstanceRef, 'failover route instance ref');
      job.identityBinding = requireString(identityBinding, 'failover identity');
      job.pendingFallback = {
        fallbackFrom: previousRoute,
        reason: requireString(reason, 'failover reason'),
        approvedPolicy: requireString(approvedPolicy, 'approved failover policy')
      };
      job.state = 'queued';
      job.terminalReason = null;
      job.updatedAt = iso(this.now());
      return job;
    }).result;
  }

  recoverExpired() {
    return this.store.transaction('job.recover.expired', state => {
      const recovered = [];
      const now = this.now();
      for (const job of Object.values(state.jobs)) {
        if (!['leased', 'running', 'verifying'].includes(job.state) || !job.writerLease) continue;
        if (Date.parse(job.writerLease.expiresAt) > now) continue;
        const attempt = activeAttempt(job);
        const at = iso(now);
        if (attempt) { attempt.state = 'paused'; attempt.reason = 'lease_expired'; attempt.terminalAt = at; }
        job.state = 'paused';
        job.terminalReason = 'lease_expired';
        job.updatedAt = at;
        releaseWriter(state, job);
        recovered.push(job.jobId);
      }
      return { recovered };
    }).result;
  }

  reserveEffect(jobId, attemptId, key, effectRef) {
    return this.store.transaction('job.effect.reserve', state => {
      const job = requireJob(state, jobId);
      requireState(job, ['running', 'verifying'], 'reserve effect');
      const attempt = activeAttempt(job);
      if (!attempt || attempt.attemptId !== attemptId) throw new JobManagerError('attempt_mismatch', 'attempt is not active');
      const effectKey = `${jobId}:${requireString(key, 'effect key')}`;
      if (state.effects[effectKey]) return { created: false, effect: state.effects[effectKey] };
      const effect = { jobId, firstAttemptId: attemptId, effectRef: requireString(effectRef, 'effect ref'), state: 'reserved', createdAt: iso(this.now()), completedAt: null };
      state.effects[effectKey] = effect;
      return { created: true, effect };
    }).result;
  }

  completeEffect(jobId, key) {
    return this.store.transaction('job.effect.complete', state => {
      const effectKey = `${jobId}:${requireString(key, 'effect key')}`;
      const effect = state.effects[effectKey];
      if (!effect) throw new JobManagerError('effect_not_found', 'effect reservation does not exist');
      if (!effect.completedAt) { effect.state = 'completed'; effect.completedAt = iso(this.now()); }
      return effect;
    }).result;
  }

  cancelRun(runId, reason = 'root_cancel') {
    return this.store.transaction('orchestration.run.cancel', state => {
      const run = state.orchestrationRuns[runId];
      if (!run) throw new JobManagerError('run_not_found', `unknown orchestration run: ${runId}`);
      const cancelled = [];
      const at = iso(this.now());
      for (const jobId of run.jobIds) {
        const job = state.jobs[jobId];
        if (!job || TERMINAL_JOB_STATES.has(job.state)) continue;
        const attempt = activeAttempt(job);
        if (attempt) { attempt.state = 'failed'; attempt.reason = reason; attempt.terminalAt = at; }
        job.state = 'cancelled';
        job.terminalReason = reason;
        job.updatedAt = at;
        releaseWriter(state, job);
        cancelled.push(jobId);
      }
      run.state = 'cancelled';
      run.terminalReason = reason;
      run.updatedAt = at;
      return { runId, cancelled };
    }).result;
  }

  read(jobId = null) {
    const state = this.store.read().state;
    if (jobId) return structuredClone(requireJob(state, jobId));
    return Object.values(state.jobs).map(job => structuredClone(job));
  }

  status() {
    const integrity = this.store.integrity();
    if (!integrity.ok) return { ok: false, integrity };
    const state = this.store.read().state;
    const counts = Object.fromEntries([...JOB_STATES].map(name => [name, 0]));
    for (const job of Object.values(state.jobs)) counts[job.state] += 1;
    return {
      ok: true,
      schemaVersion: state.schemaVersion,
      sequence: state.sequence,
      counts,
      total: Object.keys(state.jobs).length,
      activeWriters: Object.keys(state.workspaceLeases).length,
      orchestrationRuns: Object.keys(state.orchestrationRuns).length,
      artifacts: Object.keys(state.artifacts).length,
      integrity
    };
  }
}

export function normalizeStoreError(error) {
  if (error instanceof JobManagerError || error instanceof DurableStoreError) return error;
  return new JobManagerError('job_manager_failed', error.message);
}
