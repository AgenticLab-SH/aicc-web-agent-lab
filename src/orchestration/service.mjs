import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ArtifactRegistry } from '../artifacts/registry.mjs';
import { resultRecordHash } from '../jobs/job-manager.mjs';
import { assertSupportedParentGoalAuthority } from '../goals/service.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const TOOL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const TOOL_CLASSES = new Set(['read', 'write', 'browser', 'computer-use', 'network']);
const ROLE_KINDS = new Set(['coordinator', 'researcher', 'critic', 'solver', 'merger', 'writer', 'verifier']);
const HOOKS = new Set(['before_dispatch', 'before_tool_call', 'before_write', 'after_result', 'before_merge', 'on_terminal_cleanup']);
const ACTIVE_JOB_STATES = new Set(['leased', 'running', 'verifying']);
const TERMINAL_JOB_STATES = new Set(['completed', 'failed', 'cancelled']);
const FORBIDDEN_KEYS = /^(?:prompt|response|transcript|cookie|cookies|secret|token|password|authorization|browserProfile|tabContent|content)$/i;

export class OrchestrationError extends Error {
  constructor(code, message) { super(message); this.name = 'OrchestrationError'; this.code = code; }
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new OrchestrationError('invalid_request', `${label} is required`);
  return value.trim();
}

function rejectSensitive(value, at = 'request') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw new OrchestrationError('sensitive_body_prohibited', `${at}.${key} cannot be stored`);
    rejectSensitive(child, `${at}.${key}`);
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex');
}

function atomicPrivateWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch { /* Windows ACL */ }
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACL */ }
}

function validateTools(tools) {
  if (!Array.isArray(tools) || !tools.length || tools.length > 100) throw new OrchestrationError('invalid_capability_snapshot', 'one to 100 advertised tools are required');
  const seen = new Set();
  return tools.map(item => {
    const id = requireString(item?.id, 'tool id');
    if (!TOOL_ID.test(id) || seen.has(id) || id === '*' || /all[_-]?(?:tools|skills|plugins)/i.test(id)) {
      throw new OrchestrationError('invalid_capability_snapshot', `invalid or inferred tool id: ${id}`);
    }
    seen.add(id);
    const classes = [...new Set(item.classes ?? [])].sort();
    if (!classes.length || classes.some(value => !TOOL_CLASSES.has(value))) throw new OrchestrationError('invalid_capability_snapshot', `tool classes are invalid: ${id}`);
    return { id, classes };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function validateRoles(roles, tools) {
  if (!Array.isArray(roles) || !roles.length || roles.length > 100) throw new OrchestrationError('invalid_dag', 'one to 100 roles are required');
  const available = new Set(tools.map(tool => tool.id));
  return roles.map(role => {
    const roleId = requireString(role?.roleId, 'role id');
    const kind = requireString(role?.kind, 'role kind');
    if (!ROLE_KINDS.has(kind)) throw new OrchestrationError('invalid_dag', `unsupported role kind: ${kind}`);
    const mode = role.mode ?? (kind === 'writer' ? 'write' : 'read-only');
    if (!['read-only', 'write'].includes(mode)) throw new OrchestrationError('invalid_dag', `invalid role mode: ${roleId}`);
    if (kind === 'writer' && mode !== 'write') throw new OrchestrationError('invalid_dag', 'writer role must use write mode');
    if (kind !== 'writer' && mode === 'write') throw new OrchestrationError('invalid_dag', 'only the writer role may request write mode');
    const requiredToolIds = [...new Set(role.requiredToolIds ?? [])].sort();
    for (const id of requiredToolIds) if (!available.has(id)) throw new OrchestrationError('unsupported_capability', `role ${roleId} requires an unadvertised tool: ${id}`);
    return {
      roleId,
      kind,
      mode,
      dependencies: [...new Set(role.dependencies ?? [])],
      requiredToolIds,
      requestRef: role.requestRef?.trim() || `orchestration-request://${roleId}`,
      requestHash: role.requestHash && SHA256.test(role.requestHash) ? role.requestHash : sha256({ roleId, kind, requiredToolIds })
    };
  });
}

function topologicalRoles(roles) {
  const byId = new Map(roles.map(role => [role.roleId, role]));
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = role => {
    if (visiting.has(role.roleId)) throw new OrchestrationError('invalid_dag', 'role DAG contains a cycle');
    if (visited.has(role.roleId)) return;
    visiting.add(role.roleId);
    for (const dependency of role.dependencies) {
      const parent = byId.get(dependency);
      if (!parent) throw new OrchestrationError('invalid_dag', `unknown dependency: ${dependency}`);
      visit(parent);
    }
    visiting.delete(role.roleId);
    visited.add(role.roleId);
    ordered.push(role);
  };
  for (const role of roles) visit(role);
  return ordered;
}

function safeRun(run, state) {
  const roles = run.roleDag.map(role => {
    const job = run.jobIds.map(id => state.jobs[id]).find(item => item?.roleId === role.roleId);
    const attempt = job?.attempts?.at(-1) ?? null;
    return {
      roleId: role.roleId,
      kind: role.kind,
      mode: role.mode,
      dependencies: role.dependencies,
      requiredToolIds: role.requiredToolIds,
      jobId: job?.jobId ?? null,
      state: job?.state ?? 'unbound',
      attemptId: attempt?.attemptId ?? null,
      resultCount: job?.results?.length ?? 0,
      results: (job?.results ?? []).map(result => ({
        resultId: result.resultId, attemptId: result.attemptId,
        operationId: result.operationId ?? null, requestHash: result.requestHash ?? null,
        resultHash: resultRecordHash(result), late: result.late ?? false,
        parentAdoption: result.parentAdoption ?? 'unknown',
        consumptions: result.consumptions ?? []
      })),
      artifactCount: job?.artifactRefs?.length ?? 0
    };
  });
  return {
    runId: run.runId,
    requestId: run.requestId,
    workspaceId: run.workspaceId,
    routeId: run.routeId,
    identityBinding: run.identityBinding,
    mode: run.mode,
    state: run.state,
    rootTaskId: run.rootTaskId,
    updatedAt: run.updatedAt,
    parentGoal: run.parentGoal ?? null,
    parentGoalAuthority: run.parentGoal ? { authorityMode: run.parentGoal.authorityMode ?? 'COOPERATIVE', nativeOwner: 'UNKNOWN', stopEpoch: 'UNKNOWN',
      nativeAuthorityReady: false, requiredReader: 'exact-parent-owner-revision-and-latest-stop-epoch' } : null,
    parentGoalCompletion: 'unknown',
    budgets: run.budgets,
    activeLimit: run.activeLimit,
    capabilitySnapshot: run.capabilitySnapshot ? {
      hash: run.capabilitySnapshot.hash,
      surface: run.capabilitySnapshot.surface,
      toolIds: run.capabilitySnapshot.tools.map(tool => tool.id),
      capturedAt: run.capabilitySnapshot.capturedAt,
      expiresAt: run.capabilitySnapshot.expiresAt,
      revokedAt: run.capabilitySnapshot.revokedAt ?? null
    } : null,
    roles,
    cleanup: run.cleanup ?? null,
    rawTranscriptStored: false
  };
}

export class WebGptOrchestrationService {
  constructor({ manager, store, artifactRegistry = null, artifactRoot, goalLedger = null, now = () => Date.now() } = {}) {
    if (!manager || !store) throw new OrchestrationError('store_required', 'job manager and durable store are required');
    if (!artifactRoot || !path.isAbsolute(artifactRoot)) throw new OrchestrationError('artifact_root_required', 'an absolute private artifact root is required');
    this.manager = manager;
    this.store = store;
    this.artifacts = artifactRegistry ?? new ArtifactRegistry({ store, now });
    this.artifactRoot = artifactRoot;
    this.now = now;
    this.goalLedger = goalLedger;
  }

  #checkParentGoal(binding) {
    if (!binding) return null;
    assertSupportedParentGoalAuthority(binding);
    if (!this.goalLedger?.status) throw new OrchestrationError('parent_goal_unavailable', 'the bound tracked goal ledger is unavailable');
    const goalId = requireString(binding.goalId, 'parent goal id');
    const sourceUpdatedAt = requireString(binding.sourceUpdatedAt, 'parent goal source revision');
    let snapshot;
    try { snapshot = this.goalLedger.status(); }
    catch { throw new OrchestrationError('parent_goal_unavailable', 'the bound tracked goal ledger could not be read'); }
    if (snapshot.ledgerKind !== 'aicc-tracked-goals' || !Array.isArray(snapshot.goals)) {
      throw new OrchestrationError('parent_goal_unavailable', 'the tracked goal ledger contract is unavailable');
    }
    const goal = snapshot.goals.find(item => item.id === goalId);
    if (!goal) throw new OrchestrationError('parent_goal_not_found', 'the exact bound tracked goal no longer exists');
    if (goal.status !== 'ACTIVE') throw new OrchestrationError('parent_goal_inactive', 'the bound tracked goal is not active');
    if (snapshot.sourceUpdatedAt !== sourceUpdatedAt) throw new OrchestrationError('parent_goal_revision_changed', 'read the current tracked goal revision before continuing');
    // Personal checklist changes are view state, not a new goal's scope or stop revision.
    const { checked, checkedAt, ...goalDefinition } = goal;
    const goalSnapshotHash = sha256(goalDefinition);
    if (binding.goalSnapshotHash != null && (!SHA256.test(binding.goalSnapshotHash) || binding.goalSnapshotHash !== goalSnapshotHash)) {
      throw new OrchestrationError('parent_goal_revision_changed', 'the bound tracked goal definition changed');
    }
    // This is a read guard, not a native parent-goal authority or cross-store transaction.
    return { goalId, sourceUpdatedAt, goalSnapshotHash, status: goal.status, authorityMode: 'COOPERATIVE',
      check: 'tracked-ledger-observed', definitionBinding: binding.goalSnapshotHash ? 'hash-bound' : 'timestamp-only-legacy',
      observedAt: new Date(this.now()).toISOString() };
  }

  #state() { return this.store.read().state; }

  #run(runId) {
    const state = this.#state();
    const run = state.orchestrationRuns[runId];
    if (!run) throw new OrchestrationError('run_not_found', `unknown orchestration run: ${runId}`);
    return { run, state };
  }

  #job(run, state, roleId) {
    const job = run.jobIds.map(id => state.jobs[id]).find(item => item?.roleId === roleId);
    if (!job) throw new OrchestrationError('role_not_found', `unknown run role: ${roleId}`);
    return job;
  }

  #hook(runId, name, metadata = {}) {
    if (!HOOKS.has(name)) throw new OrchestrationError('invalid_hook', `unsupported hook: ${name}`);
    rejectSensitive(metadata, 'hook');
    return this.store.transaction('orchestration.hook', state => {
      const run = state.orchestrationRuns[runId];
      if (!run) throw new OrchestrationError('run_not_found', `unknown orchestration run: ${runId}`);
      run.hooks ??= [];
      run.hooks.push({ name, at: new Date(this.now()).toISOString(), ...structuredClone(metadata) });
      if (run.hooks.length > 200) run.hooks.splice(0, run.hooks.length - 200);
      run.updatedAt = new Date(this.now()).toISOString();
      return run.hooks.at(-1);
    }).result;
  }

  #assertSnapshot(run, hash, requiredToolIds = []) {
    const snapshot = run.capabilitySnapshot;
    if (!snapshot || snapshot.hash !== hash || snapshot.revokedAt) throw new OrchestrationError('stale_capability', 'capability snapshot is missing, changed, or revoked; re-plan the run');
    if (Date.parse(snapshot.expiresAt) <= this.now()) throw new OrchestrationError('stale_capability', 'capability snapshot expired; re-plan the run');
    const available = new Set(snapshot.tools.map(tool => tool.id));
    for (const id of requiredToolIds) if (!available.has(id)) throw new OrchestrationError('unsupported_capability', `tool is not in the current capability snapshot: ${id}`);
    return snapshot;
  }

  #remember(runId, requestId, operation, value, inputHash = null) {
    return this.store.transaction('orchestration.operation', state => {
      const run = state.orchestrationRuns[runId];
      if (!run) throw new OrchestrationError('run_not_found', `unknown orchestration run: ${runId}`);
      run.operations ??= {};
      const existing = run.operations[requestId];
      if (existing && existing.operation !== operation) throw new OrchestrationError('request_replay', 'request id was already used for another operation');
      if (existing && inputHash && existing.inputHash !== inputHash) throw new OrchestrationError('request_replay', 'request id already names different or unbound input');
      if (!existing) run.operations[requestId] = { operation, inputHash, value: structuredClone(value), at: new Date(this.now()).toISOString() };
      return structuredClone(run.operations[requestId].value);
    }).result;
  }

  planRun(spec) {
    rejectSensitive(spec);
    assertSupportedParentGoalAuthority(spec.parentGoal);
    const requestId = requireString(spec.requestId, 'request id');
    const existingState = this.#state();
    const existing = Object.values(existingState.orchestrationRuns).find(run => run.requestId === requestId);
    if (existing) return { ok: true, duplicate: true, run: safeRun(existing, existingState) };
    const surface = requireString(spec.surface, 'surface');
    if (!['full', 'browser-only'].includes(surface)) throw new OrchestrationError('unsupported_surface', `unsupported surface: ${surface}`);
    const tools = validateTools(spec.tools);
    const roles = validateRoles(spec.roles, tools);
    const ttlSeconds = Number(spec.capabilityTtlSeconds ?? 300);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 600) throw new OrchestrationError('invalid_capability_snapshot', 'capability TTL must be 30 to 600 seconds');
    const hasWriteTool = tools.some(tool => tool.classes.includes('write'));
    if (roles.some(role => role.mode === 'write') && !hasWriteTool) throw new OrchestrationError('unsupported_capability', 'writer role requires an actually advertised write-class tool');
    if (surface === 'browser-only' && roles.some(role => role.mode === 'write')) throw new OrchestrationError('unsupported_surface', 'browser-only orchestration cannot edit local files');
    const capturedAt = new Date(this.now()).toISOString();
    const snapshotValue = { surface, tools, capturedAt, expiresAt: new Date(this.now() + ttlSeconds * 1000).toISOString() };
    const capabilitySnapshot = { ...snapshotValue, hash: sha256(snapshotValue), revokedAt: null };
    const parentGoal = spec.parentGoal ? {
      goalId: requireString(spec.parentGoal.goalId, 'parent goal id'),
      sourceUpdatedAt: requireString(spec.parentGoal.sourceUpdatedAt, 'parent goal source revision'),
      ...(spec.parentGoal.authorityMode != null ? { authorityMode: spec.parentGoal.authorityMode } : {}),
      ...(spec.parentGoal.goalSnapshotHash != null ? { goalSnapshotHash: spec.parentGoal.goalSnapshotHash } : {})
    } : null;
    const parentGoalObservation = this.#checkParentGoal(parentGoal);
    if (parentGoal) parentGoal.goalSnapshotHash = parentGoalObservation.goalSnapshotHash;
    const run = this.manager.createRun({
      runId: spec.runId,
      requestId,
      rootTaskId: requireString(spec.rootTaskId, 'root task id'),
      workspaceId: requireString(spec.workspaceId, 'workspace id'),
      routeId: requireString(spec.routeId, 'route id'),
      identityBinding: requireString(spec.identityBinding, 'identity binding'),
      parentGoal,
      mode: surface,
      budgets: spec.budgets,
      capabilitySnapshotHash: capabilitySnapshot.hash,
      capabilitySnapshot,
      roleDag: roles
    });
    const jobIds = new Map();
    for (const role of topologicalRoles(roles)) {
      const submitted = this.manager.submit({
        idempotencyKey: `${run.runId}:${role.roleId}`,
        workloadClass: role.requiredToolIds.some(id => tools.find(tool => tool.id === id)?.classes.includes('browser')) ? 'browser' : 'batch',
        workspaceId: run.workspaceId,
        requestedRoute: run.routeId,
        identityBinding: run.identityBinding,
        mode: role.mode,
        requestRef: role.requestRef,
        requestHash: role.requestHash,
        dependencies: role.dependencies.map(id => jobIds.get(id)),
        orchestrationRunId: run.runId,
        roleId: role.roleId
      });
      jobIds.set(role.roleId, submitted.job.jobId);
    }
    const finalState = this.#state();
    return { ok: true, duplicate: false, run: safeRun(finalState.orchestrationRuns[run.runId], finalState) };
  }

  #start(spec, write) {
    rejectSensitive(spec);
    const requestId = requireString(spec.requestId, 'request id');
    const { run, state } = this.#run(requireString(spec.runId, 'run id'));
    const roleId = requireString(spec.roleId, 'role id');
    const job = this.#job(run, state, roleId);
    if ((job.mode === 'write') !== write) throw new OrchestrationError(write ? 'writer_role_required' : 'request_writer_required', write ? 'request_writer requires the declared writer role' : 'write roles must use request_writer');
    const prior = run.operations?.[requestId];
    if (prior) {
      if (prior.operation !== (write ? 'request_writer' : 'start_role')) throw new OrchestrationError('request_replay', 'request id was already used for another operation');
      return structuredClone(prior.value);
    }
    const role = run.roleDag.find(item => item.roleId === roleId);
    this.#checkParentGoal(run.parentGoal);
    const snapshot = this.#assertSnapshot(run, requireString(spec.capabilitySnapshotHash, 'capability snapshot hash'), role.requiredToolIds);
    this.#hook(run.runId, 'before_tool_call', { toolName: write ? 'request_writer' : 'start_role', roleId });
    this.#hook(run.runId, write ? 'before_write' : 'before_dispatch', { roleId });
    const refreshed = this.#run(run.runId);
    const currentJob = this.#job(refreshed.run, refreshed.state, roleId);
    let attempt = currentJob.attempts.at(-1) ?? null;
    if (currentJob.state === 'queued') {
      const dispatched = this.manager.dispatch(currentJob.jobId, {
        workerId: 'outer-codex-host',
        workloadClasses: ['batch', 'browser'],
        modes: [currentJob.mode],
        routeIds: [run.routeId],
        maxActive: run.budgets.hardActiveCap,
        active: 0
      }, { mode: currentJob.mode });
      attempt = this.manager.start(currentJob.jobId, dispatched.attempt.attemptId).attempt;
    } else if (!ACTIVE_JOB_STATES.has(currentJob.state)) {
      throw new OrchestrationError('role_not_startable', `role is ${currentJob.state}`);
    }
    const value = {
      ok: true,
      runId: run.runId,
      roleId,
      jobId: currentJob.jobId,
      attemptId: attempt.attemptId,
      mode: currentJob.mode,
      routeId: run.routeId,
      identityBinding: run.identityBinding,
      requiredToolIds: role.requiredToolIds,
      capabilitySnapshotHash: snapshot.hash,
      dispatch: 'host-mediated',
      writerLease: write ? 'exclusive-workspace-writer-held' : null
    };
    return this.#remember(run.runId, requestId, write ? 'request_writer' : 'start_role', value);
  }

  startRole(spec) { return this.#start(spec, false); }
  requestWriter(spec) { return this.#start(spec, true); }

  waitRole(spec) {
    const { run, state } = this.#run(requireString(spec.runId, 'run id'));
    const roleId = requireString(spec.roleId, 'role id');
    const job = this.#job(run, state, roleId);
    const role = safeRun(run, state).roles.find(item => item.roleId === roleId);
    return { ok: true, terminal: TERMINAL_JOB_STATES.has(job.state), role };
  }

  submitResult(spec) {
    rejectSensitive(spec);
    const requestId = requireString(spec.requestId, 'request id');
    const inputHash = sha256(spec);
    const { run, state } = this.#run(requireString(spec.runId, 'run id'));
    const roleId = requireString(spec.roleId, 'role id');
    const job = this.#job(run, state, roleId);
    const prior = run.operations?.[requestId];
    if (prior) {
      if (prior.operation !== 'submit_result' || prior.inputHash !== inputHash) throw new OrchestrationError('request_replay', 'request id already names different or unbound input');
      return structuredClone(prior.value);
    }
    const action = spec.action ?? 'record';
    if (!['record', 'consume'].includes(action)) throw new OrchestrationError('invalid_request', 'unsupported result action');
    const explicitAttempt = spec.attemptId != null;
    const attempt = explicitAttempt
      ? job.attempts.find(item => item.attemptId === spec.attemptId)
      : job.attempts.at(-1);
    if (!attempt) throw new OrchestrationError('attempt_mismatch', 'an existing exact attempt is required');
    const requireOriginalBinding = () => {
      if (!explicitAttempt) throw new OrchestrationError('attempt_mismatch', 'preservation or consumption requires an explicit original attempt');
      requireString(spec.resultId, 'result id');
      if (requireString(spec.operationId, 'operation id') !== (attempt.operationId ?? job.operationId ?? job.jobId)
        || requireString(spec.requestHash, 'request hash') !== job.requestHash) {
        throw new OrchestrationError('result_binding_mismatch', 'result differs from the original operation or input');
      }
    };
    const snapshotHash = requireString(spec.capabilitySnapshotHash, 'capability snapshot hash');
    if (snapshotHash !== run.capabilitySnapshotHash) throw new OrchestrationError('stale_capability', 'original capability binding does not match');
    if (action === 'consume') {
      requireOriginalBinding();
      this.#assertSnapshot(run, snapshotHash);
      const acknowledged = this.manager.acknowledgeResult(job.jobId, attempt.attemptId, {
        ...spec.adoption, resultId: spec.resultId, operationId: spec.operationId, requestHash: spec.requestHash
      }, { checkParentGoal: binding => this.#checkParentGoal(binding) });
      return this.#remember(run.runId, requestId, 'submit_result', {
        ok: true, runId: run.runId, roleId, jobId: job.jobId, resultId: spec.resultId,
        state: 'consumed', executionState: job.state, parentGoalCompletion: 'unknown',
        parentGoalObservation: acknowledged.receipt.parentGoalObservation ?? null, ...acknowledged
      }, inputHash);
    }
    const preserveOnly = spec.recordOnly === true || !ACTIVE_JOB_STATES.has(job.state)
      || job.attempts.at(-1)?.attemptId !== attempt.attemptId
      || job.results.some(item => item.resultId === spec.resultId && item.late);
    if (explicitAttempt || preserveOnly) requireOriginalBinding();
    if (!preserveOnly) {
      const role = run.roleDag.find(item => item.roleId === roleId);
      this.#assertSnapshot(run, snapshotHash, role.requiredToolIds);
      this.#hook(run.runId, 'before_tool_call', { toolName: 'submit_result', roleId });
      if (role.kind === 'merger') this.#hook(run.runId, 'before_merge', { roleId });
    }
    // Exact old binding permits evidence preservation after expiry, never old tool execution.
    const result = this.manager.recordResult(job.jobId, attempt.attemptId, {
      resultId: spec.resultId ?? requestId,
      operationId: spec.operationId, requestHash: spec.requestHash,
      claim: requireString(spec.claim, 'result claim'),
      evidence: spec.evidence ?? [],
      counterexample: spec.counterexample,
      unknown: spec.unknown,
      recommendation: spec.recommendation,
      artifactRefs: [],
      validatorStatus: spec.validatorStatus ?? 'pending'
    });
    if (preserveOnly || result.late) {
      return this.#remember(run.runId, requestId, 'submit_result', {
        ok: true, runId: run.runId, roleId, jobId: job.jobId, attemptId: attempt.attemptId,
        resultId: result.resultId, resultHash: resultRecordHash(result), state: 'recorded',
        late: result.late, executionState: this.manager.read(job.jobId).state,
        parentAdoption: result.parentAdoption, parentGoalCompletion: 'unknown'
      }, inputHash);
    }
    if (job.state === 'running') this.manager.beginVerification(job.jobId, attempt.attemptId);
    const directory = path.join(this.artifactRoot, run.runId);
    const file = path.join(directory, roleId + '.result.json');
    const bytes = JSON.stringify({
      contractVersion: 1, runId: run.runId, roleId,
      jobId: job.jobId, attemptId: attempt.attemptId, result
    }, null, 2) + '\n';
    atomicPrivateWrite(file, bytes);
    const artifactId = 'orchestration-result-' + job.jobId;
    const registered = this.artifacts.register({
      artifactId, jobId: job.jobId, privatePath: file,
      inputSources: [{ ref: 'capability://' + run.runId, sha256: run.capabilitySnapshotHash }],
      generator: { tool: 'web-gpt-orchestrator', version: '0.1.0', routeId: job.requestedRoute },
      outputRef: 'orchestration://' + run.runId + '/' + roleId + '/result',
      mediaType: 'application/json', sensitivity: 'internal',
      rollbackRef: 'orchestration://' + run.runId + '/' + roleId + '/rollback'
    });
    const verified = this.artifacts.verify(registered.artifact.artifactId, [{ type: 'exact-bytes', expectedSha256: registered.artifact.output.sha256 }]);
    this.manager.complete(job.jobId, attempt.attemptId, [verified.artifactId]);
    this.#hook(run.runId, 'after_result', { roleId, resultId: result.resultId, artifactId: verified.artifactId });
    const value = {
      ok: true, runId: run.runId, roleId, jobId: job.jobId, resultId: result.resultId,
      resultHash: resultRecordHash(result), artifactId: verified.artifactId, state: 'completed',
      parentAdoption: result.parentAdoption, parentGoalCompletion: 'unknown'
    };
    return this.#remember(run.runId, requestId, 'submit_result', value, inputHash);
  }
  status(spec = {}) {
    if (spec.consumption) {
      rejectSensitive(spec);
      const { run, state } = this.#run(requireString(spec.runId, 'run id'));
      const query = spec.consumption;
      const job = this.#job(run, state, requireString(query.roleId, 'role id'));
      if (requireString(query.capabilitySnapshotHash, 'original capability snapshot hash') !== run.capabilitySnapshotHash) {
        throw new OrchestrationError('stale_capability', 'original capability binding does not match');
      }
      // Historical metadata lookup is not authorization to execute with an expired snapshot.
      return { ok: true, runId: run.runId, jobId: job.jobId,
        ...this.manager.reconcileResultConsumption(job.jobId, requireString(query.attemptId, 'original attempt id'), {
          ...query.adoption, resultId: query.resultId, operationId: query.operationId, requestHash: query.requestHash
        }) };
    }
    const state = this.#state();
    if (spec.runId) {
      const run = state.orchestrationRuns[spec.runId];
      if (!run) throw new OrchestrationError('run_not_found', `unknown orchestration run: ${spec.runId}`);
      return { ok: true, run: safeRun(run, state) };
    }
    const runs = Object.values(state.orchestrationRuns).map(run => safeRun(run, state));
    return { ok: true, runCount: runs.length, activeRuns: runs.filter(run => !['completed', 'cancelled', 'failed'].includes(run.state)).length, runs };
  }

  cancelRun(spec) {
    const requestId = requireString(spec.requestId, 'request id');
    const { run } = this.#run(requireString(spec.runId, 'run id'));
    const prior = run.operations?.[requestId];
    if (prior) {
      if (prior.operation !== 'cancel_run') throw new OrchestrationError('request_replay', 'request id was already used for another operation');
      return structuredClone(prior.value);
    }
    this.#hook(run.runId, 'before_tool_call', { toolName: 'cancel_run' });
    const result = run.state === 'cancelled' ? { runId: run.runId, cancelled: [] } : this.manager.cancelRun(run.runId, spec.reason?.trim() || 'root_cancel');
    return this.#remember(run.runId, requestId, 'cancel_run', { ok: true, ...result, targetCleanup: 'owned-targets-only' });
  }

  cleanupRun(spec) {
    const requestId = requireString(spec.requestId, 'request id');
    const { run, state } = this.#run(requireString(spec.runId, 'run id'));
    const prior = run.operations?.[requestId];
    if (prior) {
      if (prior.operation !== 'cleanup_run') throw new OrchestrationError('request_replay', 'request id was already used for another operation');
      return structuredClone(prior.value);
    }
    const active = run.jobIds.map(id => state.jobs[id]).filter(job => job && ACTIVE_JOB_STATES.has(job.state));
    if (active.length) throw new OrchestrationError('run_active', 'cleanup requires every owned role to be terminal');
    this.#hook(run.runId, 'on_terminal_cleanup');
    const value = this.store.transaction('orchestration.cleanup', next => {
      const current = next.orchestrationRuns[run.runId];
      const cleanedBrowserLeaseIds = [];
      for (const [leaseId, lease] of Object.entries(next.browserLeases)) {
        if (lease.runId !== run.runId) continue;
        delete next.browserLeases[leaseId];
        cleanedBrowserLeaseIds.push(leaseId);
      }
      current.capabilitySnapshot.revokedAt ??= new Date(this.now()).toISOString();
      current.cleanup = { at: new Date(this.now()).toISOString(), cleanedBrowserLeaseIds, foreignTargetsTouched: 0 };
      current.updatedAt = current.cleanup.at;
      return { ok: true, runId: run.runId, ...current.cleanup };
    }).result;
    return this.#remember(run.runId, requestId, 'cleanup_run', value);
  }
}

export const __testing = { sha256, validateTools, validateRoles, topologicalRoles, safeRun };
