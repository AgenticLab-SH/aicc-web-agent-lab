import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashRecord } from './lab.mjs';

export class UpdateCoordinatorError extends Error {
  constructor(code, message) { super(message); this.name = 'UpdateCoordinatorError'; this.code = code; }
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows ACL */ }
}

function atomicJson(file, value) {
  privateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACL */ }
}

function initialState() { return { schemaVersion: 1, plans: {}, restartBudgets: {} }; }

const STAGES = ['shadow', 'canary', 'default'];

export class UpdateCoordinator {
  constructor({ stateRoot = path.join(process.env.AICC_STATE_ROOT || path.join(os.homedir(), '.ai-control-center'), 'compatibility'), now = () => Date.now() } = {}) {
    if (!path.isAbsolute(stateRoot) || path.resolve(stateRoot) === path.parse(path.resolve(stateRoot)).root) throw new UpdateCoordinatorError('invalid_state_root', 'compatibility state root must be a confined absolute path');
    this.stateRoot = path.resolve(stateRoot);
    this.file = path.join(this.stateRoot, 'state.json');
    this.now = now;
  }

  #read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return initialState(); throw error; }
  }

  #write(state) { atomicJson(this.file, state); }

  createPlan(input) {
    if (!input?.operationId || !input.targetComponent || !input.preconditionHash || !input.desiredHash || !input.rollbackRef || !input.backupRef) throw new UpdateCoordinatorError('invalid_update_plan', 'immutable update plan fields are incomplete');
    if (input.preconditionHash === input.desiredHash && input.allowSameReleaseCanary !== true) throw new UpdateCoordinatorError('invalid_update_plan', 'same-release plans must be explicit canaries');
    const activeCount = input.activeWorkProof?.count;
    const compatibility = input.compatibility?.ok === true;
    const body = {
      operationId: input.operationId,
      targetComponent: input.targetComponent,
      currentVersion: input.currentVersion,
      targetVersion: input.targetVersion,
      preconditionHash: input.preconditionHash,
      desiredHash: input.desiredHash,
      rollbackRef: input.rollbackRef,
      backupRef: input.backupRef,
      activeWorkProof: input.activeWorkProof,
      compatibilityHash: input.compatibilityHash,
      directRescue: input.directRescue,
      allowSameReleaseCanary: input.allowSameReleaseCanary === true
    };
    const digest = hashRecord(body);
    const state = this.#read();
    const existing = state.plans[input.operationId];
    if (existing) {
      if (existing.planHash !== digest) throw new UpdateCoordinatorError('immutable_plan_conflict', 'operation ID already has a different immutable plan');
      return { ok: true, duplicate: true, ...existing };
    }
    const blockers = [];
    if (!Number.isInteger(activeCount) || activeCount !== 0) blockers.push('active_work_not_exact_zero');
    if (!compatibility) blockers.push('compatibility_gate_failed');
    if (!Array.isArray(input.directRescue) || input.directRescue.some(item => item.status !== 'pass')) blockers.push('direct_rescue_incomplete');
    const record = {
      ...body,
      planHash: digest,
      state: blockers.length ? 'hold' : 'planned',
      blockers,
      stages: [],
      createdAt: new Date(this.now()).toISOString()
    };
    state.plans[input.operationId] = record;
    this.#write(state);
    return { ok: blockers.length === 0, duplicate: false, ...record };
  }

  lease(operationId, observedPreconditionHash) {
    const state = this.#read();
    const plan = state.plans[operationId];
    if (!plan) throw new UpdateCoordinatorError('plan_not_found', 'update plan not found');
    if (plan.state !== 'planned') throw new UpdateCoordinatorError('plan_not_ready', `update plan cannot be leased from ${plan.state}`);
    if (observedPreconditionHash !== plan.preconditionHash) throw new UpdateCoordinatorError('stale_precondition', 'component changed after plan creation');
    plan.state = 'leased';
    plan.leasedAt = new Date(this.now()).toISOString();
    this.#write(state);
    return { ok: true, operationId, targetComponent: plan.targetComponent, state: plan.state, planHash: plan.planHash };
  }

  recordStage(operationId, stage, evidence) {
    if (!STAGES.includes(stage) || evidence?.status !== 'pass' || typeof evidence.ref !== 'string' || !evidence.ref) throw new UpdateCoordinatorError('invalid_stage_evidence', 'stage requires a passing evidence reference');
    const state = this.#read();
    const plan = state.plans[operationId];
    if (!plan) throw new UpdateCoordinatorError('plan_not_found', 'update plan not found');
    const expected = STAGES[plan.stages.length];
    if (stage !== expected) throw new UpdateCoordinatorError('invalid_rollout_sequence', `expected ${expected}, received ${stage}`);
    if (!['leased', 'verifying'].includes(plan.state)) throw new UpdateCoordinatorError('plan_not_ready', `stage cannot run from ${plan.state}`);
    if (stage === 'default' && plan.directRescue.some(item => item.status !== 'pass')) throw new UpdateCoordinatorError('direct_rescue_failed', 'default rollout requires every direct rescue path');
    plan.stages.push({ stage, evidenceRef: evidence.ref, observedHash: evidence.observedHash ?? null, at: new Date(this.now()).toISOString() });
    plan.state = stage === 'default' ? 'committed' : 'verifying';
    this.#write(state);
    return { ok: true, operationId, stage, state: plan.state, completedStages: plan.stages.length };
  }

  rollback(operationId, evidence) {
    const state = this.#read();
    const plan = state.plans[operationId];
    if (!plan) throw new UpdateCoordinatorError('plan_not_found', 'update plan not found');
    if (!evidence?.restoredHash || evidence.restoredHash !== plan.preconditionHash || !evidence.ref) throw new UpdateCoordinatorError('rollback_unverified', 'rollback must restore the exact precondition hash');
    plan.state = 'rolled-back';
    plan.rollbackEvidenceRef = evidence.ref;
    plan.rolledBackAt = new Date(this.now()).toISOString();
    this.#write(state);
    return { ok: true, operationId, state: plan.state, targetComponent: plan.targetComponent };
  }

  recordRestartFailure(componentId, { fingerprint, evidenceRef, changedHypothesis = false } = {}) {
    if (!componentId || !fingerprint || !evidenceRef) throw new UpdateCoordinatorError('invalid_restart_record', 'restart failure requires component, fingerprint and evidence');
    const state = this.#read();
    const current = state.restartBudgets[componentId] ?? { componentId, windowStartedAt: new Date(this.now()).toISOString(), attempts: [], state: 'available' };
    if (current.state === 'quarantined') return { ok: false, componentId, state: 'quarantined', restartAllowed: false, attempts: current.attempts.length };
    const repeated = current.attempts.some(item => item.fingerprint === fingerprint);
    if (repeated && changedHypothesis) throw new UpdateCoordinatorError('invalid_restart_hypothesis', 'a changed hypothesis must have a distinct failure fingerprint');
    current.attempts.push({ fingerprint, evidenceRef, at: new Date(this.now()).toISOString(), changedHypothesis });
    if (current.attempts.length >= 2) {
      current.state = 'quarantined';
      current.quarantinedAt = new Date(this.now()).toISOString();
    }
    state.restartBudgets[componentId] = current;
    this.#write(state);
    return { ok: current.state !== 'quarantined', componentId, state: current.state, restartAllowed: current.state !== 'quarantined', attempts: current.attempts.length, remaining: Math.max(0, 2 - current.attempts.length) };
  }

  status() {
    const state = this.#read();
    const plans = Object.values(state.plans);
    const restartBudgets = Object.values(state.restartBudgets);
    return {
      ok: true,
      initialized: fs.existsSync(this.file),
      planCount: plans.length,
      activePlans: plans.filter(item => !['committed', 'rolled-back', 'hold'].includes(item.state)).length,
      holdPlans: plans.filter(item => item.state === 'hold').length,
      quarantinedComponents: restartBudgets.filter(item => item.state === 'quarantined').map(item => item.componentId),
      plans,
      restartBudgets
    };
  }
}
