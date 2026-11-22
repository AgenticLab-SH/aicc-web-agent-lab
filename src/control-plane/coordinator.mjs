import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stableHash } from './registry.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export class ControlPlaneError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const TERMINAL_STATUSES = new Set(['pass', 'hold', 'uncertain']);

function requireSafeId(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)) {
    throw new ControlPlaneError('invalid_operation_identity', `${label} is invalid`);
  }
  return value;
}

function readRegularJson(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ControlPlaneError('operation_record_invalid', 'operation record must be a regular non-symlink file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeOwnerOnlyJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    try { fs.closeSync(descriptor); } catch { /* already closed */ }
    try { fs.unlinkSync(temporary); } catch { /* not created or already moved */ }
    throw error;
  }
}

function evidenceStatuses(verified = {}) {
  const value = field => verified[field] === 'pass' || verified[field] === 'hold'
    || verified[field] === 'not_applicable' ? verified[field] : 'not_assessed';
  return {
    sourceStatus: value('sourceStatus'),
    installedStatus: value('installedStatus'),
    runtimeStatus: value('runtimeStatus'),
    browserVisibleStatus: value('browserVisibleStatus')
  };
}

export class MaintenanceCoordinator {
  constructor({
    registry,
    stateRoot,
    now = () => new Date().toISOString(),
    gateSamples = 5,
    gateIntervalMs = 0,
    wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  }) {
    this.registry = registry;
    this.stateRoot = stateRoot;
    this.now = now;
    this.gateSamples = gateSamples;
    this.gateIntervalMs = gateIntervalMs;
    this.wait = wait;
  }

  async plan(componentId, desired, { mode = 'apply' } = {}) {
    const status = await this.registry.requireCapability(componentId, 'status')();
    const adapterPlan = await this.registry.requireCapability(componentId, 'plan')(desired, status);
    const plan = {
      operationId: stableHash({ componentId, desired, current: status, mode }),
      targetComponent: componentId,
      mode,
      preconditionHash: stableHash(status),
      desiredHash: stableHash(desired),
      activeWork: Number.isInteger(status.activeWork) ? status.activeWork : null,
      exactTargets: adapterPlan.exactTargets ?? [],
      requiresAuthority: adapterPlan.requiresAuthority ?? [],
      rollback: adapterPlan.rollback ?? null,
      desired: structuredClone(desired)
    };
    return deepFreeze({ ...plan, requestHash: stableHash(plan) });
  }

  operationPath(plan) {
    const component = requireSafeId(plan.targetComponent, 'target component');
    const operation = requireSafeId(plan.operationId, 'operation ID');
    return path.join(this.stateRoot, 'maintenance-operations', component, `${operation}.json`);
  }

  replay(plan) {
    const existing = readRegularJson(this.operationPath(plan));
    if (!existing) return null;
    if (existing.schemaVersion !== 2 || existing.operationId !== plan.operationId
      || existing.targetComponent !== plan.targetComponent || !TERMINAL_STATUSES.has(existing.terminal)) {
      throw new ControlPlaneError('operation_record_invalid', 'existing operation record failed identity or terminal validation');
    }
    if (existing.requestHash !== plan.requestHash) {
      throw new ControlPlaneError('operation_conflict', 'operation ID already belongs to a different immutable request');
    }
    return deepFreeze({
      ok: existing.terminal === 'pass',
      terminal: 'replay',
      replayOf: existing.terminal,
      operationId: existing.operationId,
      targetComponent: existing.targetComponent,
      evidence: existing.evidence,
      verification: existing.verification ?? null
    });
  }

  async requireFiveGlobalIdleSamples() {
    const samples = [];
    for (let index = 0; index < this.gateSamples; index += 1) {
      const statuses = await this.registry.status();
      const blockers = statuses
        .filter(status => !Number.isInteger(status.activeWork) || status.activeWork !== 0)
        .map(status => ({ component: status.id, activeWork: status.activeWork }));
      samples.push({ observedAt: this.now(), statuses, blockers });
      if (blockers.length > 0) {
        const unknown = blockers.some(blocker => blocker.activeWork === null);
        throw new ControlPlaneError(unknown ? 'active_work_unknown' : 'active_work_conflict', 'global activity gate is not exact idle');
      }
      if (index + 1 < this.gateSamples && this.gateIntervalMs > 0) await this.wait(this.gateIntervalMs);
    }
    return samples;
  }

  persistTerminal(plan, terminal, { gateSamples, verification = null, error = null }) {
    if (!TERMINAL_STATUSES.has(terminal)) throw new ControlPlaneError('invalid_terminal', 'operation terminal is invalid');
    const evidence = evidenceStatuses(verification ?? {});
    const record = {
      schemaVersion: 2,
      operationId: plan.operationId,
      requestHash: plan.requestHash,
      targetComponent: plan.targetComponent,
      preconditionHash: plan.preconditionHash,
      desiredHash: plan.desiredHash,
      exactTargets: plan.exactTargets,
      terminal,
      evidence,
      gateSampleHashes: gateSamples.map(sample => stableHash(sample)),
      verification,
      error,
      completedAt: this.now()
    };
    writeOwnerOnlyJson(this.operationPath(plan), record);
    return record;
  }

  async execute(plan) {
    if (plan.mode !== 'apply') return { ok: true, dryRun: true, plan };
    if (plan.requestHash !== stableHash({
      operationId: plan.operationId,
      targetComponent: plan.targetComponent,
      mode: plan.mode,
      preconditionHash: plan.preconditionHash,
      desiredHash: plan.desiredHash,
      activeWork: plan.activeWork,
      exactTargets: plan.exactTargets,
      requiresAuthority: plan.requiresAuthority,
      rollback: plan.rollback,
      desired: plan.desired
    })) throw new ControlPlaneError('plan_tampered', 'immutable maintenance plan hash does not match');
    const replay = this.replay(plan);
    if (replay) return replay;
    const gateSamples = await this.requireFiveGlobalIdleSamples();
    const adapter = this.registry.get(plan.targetComponent).adapter;
    const current = await this.registry.requireCapability(plan.targetComponent, 'status')();
    if (stableHash(current) !== plan.preconditionHash) throw new ControlPlaneError('stale_precondition', 'component state changed after preview');
    if (!Number.isInteger(current.activeWork)) throw new ControlPlaneError('active_work_unknown', 'active work must be known before apply');
    if (current.activeWork !== 0) throw new ControlPlaneError('active_work_conflict', 'component still has active work');
    const leaseDir = path.join(this.stateRoot, 'maintenance-leases');
    fs.mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    const leasePath = path.join(leaseDir, `${plan.targetComponent}.lock`);
    let descriptor;
    try { descriptor = fs.openSync(leasePath, 'wx', 0o600); }
    catch { throw new ControlPlaneError('maintenance_lease_conflict', 'component maintenance lease is already held'); }
    let terminalPersisted = false;
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ schemaVersion: 2, operationId: plan.operationId, requestHash: plan.requestHash, targetComponent: plan.targetComponent, startedAt: this.now() }));
      fs.fsyncSync(descriptor);
      let result;
      let verified;
      try {
        result = await this.registry.requireCapability(plan.targetComponent, 'apply')(plan.desired);
        verified = await this.registry.requireCapability(plan.targetComponent, 'verify')(plan.desired, result);
      } catch (error) {
        const record = this.persistTerminal(plan, 'uncertain', {
          gateSamples,
          error: error instanceof Error ? error.message : String(error)
        });
        terminalPersisted = true;
        const uncertain = new ControlPlaneError('mutation_uncertain', 'apply or verification did not reach a reconcilable terminal; blind retry is forbidden');
        uncertain.record = record;
        throw uncertain;
      }
      if (!verified?.ok) {
        try {
          await this.registry.requireCapability(plan.targetComponent, 'rollback')(plan.rollback);
        } catch (error) {
          const record = this.persistTerminal(plan, 'uncertain', {
            gateSamples,
            verification: verified,
            error: `rollback failed: ${error instanceof Error ? error.message : String(error)}`
          });
          terminalPersisted = true;
          const uncertain = new ControlPlaneError('rollback_uncertain', 'target-only rollback failed; blind retry is forbidden');
          uncertain.record = record;
          throw uncertain;
        }
        const record = this.persistTerminal(plan, 'hold', { gateSamples, verification: verified });
        terminalPersisted = true;
        throw new ControlPlaneError('verification_failed_rolled_back', 'verification failed and target rollback ran');
      }
      const record = this.persistTerminal(plan, 'pass', { gateSamples, verification: verified });
      terminalPersisted = true;
      return {
        ok: true,
        terminal: 'pass',
        operationId: plan.operationId,
        targetComponent: plan.targetComponent,
        evidence: record.evidence,
        verification: verified
      };
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      // If a mutation happened but its terminal record could not be persisted, preserve the
      // lease as a fail-closed reconciliation marker instead of enabling a blind retry.
      if (terminalPersisted) {
        try { fs.unlinkSync(leasePath); } catch { /* already released */ }
      }
    }
  }
}
