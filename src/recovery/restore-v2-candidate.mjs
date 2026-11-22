import crypto from 'node:crypto';
import { attemptDisposition, DurableAttemptJournal } from './attempt-journal.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODE_OPTIONS = new Map([
  ['--status', 'status'],
  ['--dry-run', 'dry-run'],
  ['--apply', 'apply'],
  ['--reconcile', 'reconcile'],
  ['--rollback', 'rollback'],
  ['--stop', 'stop']
]);
const VALUE_OPTIONS = new Set(['--operation-id', '--attempt-id']);
const MUTATING_MODES = new Set(['apply', 'rollback']);

export const RESTORE_V2_HELP = `AICC restore v2 candidate

Usage:
  aicc restore
  aicc restore COMPONENT --status
  aicc restore COMPONENT --dry-run
  aicc restore COMPONENT --apply --operation-id ID --attempt-id ID
  aicc restore COMPONENT --reconcile --operation-id ID --attempt-id ID
  aicc restore COMPONENT --rollback --operation-id ID --attempt-id ID
  aicc restore COMPONENT --stop --operation-id ID --attempt-id ID

No argument is read-only status. UNKNOWN fails closed and external effects are never replayed.`;

export class RestoreV2Error extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RestoreV2Error';
    this.code = code;
  }
}

function requireSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new RestoreV2Error('invalid_identity', `${label} is invalid`);
  return value;
}

export function parseRestoreV2Args(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) return Object.freeze({ mode: 'help', component: null, operationId: null, attemptId: null, json: false });
  const parsed = { mode: 'status', component: null, operationId: null, attemptId: null, json: false };
  const seen = new Set();
  let explicitMode = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('-')) {
      if (parsed.component) throw new RestoreV2Error('unexpected_argument', `unexpected argument: ${token}`);
      parsed.component = requireSafeId(token, 'component');
      continue;
    }
    if (seen.has(token)) throw new RestoreV2Error('duplicate_option', `duplicate option: ${token}`);
    seen.add(token);
    if (token === '--json') {
      parsed.json = true;
      continue;
    }
    if (MODE_OPTIONS.has(token)) {
      if (explicitMode) throw new RestoreV2Error('conflicting_mode', 'restore mode options are mutually exclusive');
      parsed.mode = MODE_OPTIONS.get(token);
      explicitMode = true;
      continue;
    }
    if (VALUE_OPTIONS.has(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new RestoreV2Error('missing_option_value', `${token} requires a value`);
      index += 1;
      if (token === '--operation-id') parsed.operationId = requireSafeId(value, 'operation ID');
      else parsed.attemptId = requireSafeId(value, 'attempt ID');
      continue;
    }
    throw new RestoreV2Error('unknown_option', `unknown option: ${token}`);
  }
  if (!parsed.component && parsed.mode !== 'status') throw new RestoreV2Error('component_required', `${parsed.mode} requires an exact component`);
  if (['apply', 'reconcile', 'rollback', 'stop'].includes(parsed.mode) && (!parsed.operationId || !parsed.attemptId)) {
    throw new RestoreV2Error('attempt_identity_required', `${parsed.mode} requires operation and attempt IDs`);
  }
  return Object.freeze(parsed);
}

function terminalResult(terminal, reason, extra = {}) {
  return { ok: terminal === 'PASS' || terminal === 'NOT_APPLICABLE' || terminal === 'STATUS' || terminal === 'DRY_RUN' || terminal === 'ROLLED_BACK', terminal, reason, ...extra };
}

function blockers(snapshot) {
  if (!snapshot || snapshot.readOk !== true || !Array.isArray(snapshot.domains)) return [{ domain: 'global', reason: 'activity_unknown', active: null }];
  return snapshot.domains.flatMap(domain => {
    if (!Number.isInteger(domain.active) || !Number.isInteger(domain.unknown)) return [{ domain: domain.id ?? 'unknown', reason: 'activity_unknown', active: null }];
    if (domain.active !== 0) return [{ domain: domain.id ?? 'unknown', reason: 'active_nonzero', active: domain.active }];
    if (domain.unknown !== 0) return [{ domain: domain.id ?? 'unknown', reason: 'unknown_nonzero', active: null, unknown: domain.unknown }];
    return [];
  });
}

export function createRestoreV2Candidate({
  adapters = {},
  journalRoot,
  inspectGlobalActivity,
  writerIdentity,
  now = () => new Date().toISOString(),
  uuid = () => crypto.randomUUID(),
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  gateSamples = 5,
  gateIntervalMs = 2_000
} = {}) {
  if (!journalRoot) throw new RestoreV2Error('journal_root_required', 'journal root is required');
  if (typeof inspectGlobalActivity !== 'function') throw new RestoreV2Error('activity_inspector_required', 'global activity inspector is required');

  function adapterFor(component) {
    const adapter = adapters[component];
    if (!adapter) throw new RestoreV2Error('component_unknown', `unknown restore component: ${component}`);
    return adapter;
  }

  function journalFor(operationId, attemptId) {
    return new DurableAttemptJournal({ root: journalRoot, operationId, attemptId, writerIdentity, now });
  }

  async function sampleGate(journal) {
    const samples = [];
    for (let index = 0; index < gateSamples; index += 1) {
      let snapshot;
      try { snapshot = await inspectGlobalActivity(); }
      catch { snapshot = { readOk: false, domains: [] }; }
      const currentBlockers = blockers(snapshot);
      const evidence = { sample: index + 1, readOk: snapshot?.readOk === true, blockerCount: currentBlockers.length, generationHash: snapshot?.generationHash ?? null };
      journal.append('gate_sample', evidence);
      samples.push({ snapshot, blockers: currentBlockers });
      if (currentBlockers.length > 0) return { ok: false, samples, blockers: currentBlockers };
      if (index + 1 < gateSamples && gateIntervalMs > 0) await wait(gateIntervalMs);
    }
    return { ok: true, samples, blockers: [] };
  }

  function generatedIdentity(prefix) {
    return `${prefix}-${now().replace(/[-:.TZ]/g, '').slice(0, 14)}-${uuid().replace(/-/g, '').slice(0, 8)}`;
  }

  async function runParsed(parsed) {
    if (parsed.mode === 'help') return { exitCode: 0, output: `${RESTORE_V2_HELP}\n`, result: null };
    if (parsed.mode === 'status') {
      if (!parsed.component) {
        const statuses = {};
        for (const [component, adapter] of Object.entries(adapters)) statuses[component] = await adapter.inspect({ mode: 'status' });
        return { exitCode: 0, result: terminalResult('STATUS', 'read_only_inventory', { statuses }) };
      }
      const inspection = await adapterFor(parsed.component).inspect({ mode: 'status' });
      return { exitCode: 0, result: terminalResult('STATUS', 'read_only_component', { component: parsed.component, inspection }) };
    }

    const operationId = parsed.operationId ?? generatedIdentity('restore');
    const attemptId = parsed.attemptId ?? generatedIdentity('attempt');
    const journal = journalFor(operationId, attemptId);
    const adapter = adapterFor(parsed.component);
    const disposition = attemptDisposition(journal.inspect());

    if (parsed.mode === 'reconcile') {
      if (disposition.state === 'terminal') {
        return { exitCode: 3, result: terminalResult('HOLD_PRE_DISPATCH', 'attempt_already_terminal', {
          component: parsed.component, operationId, attemptId, recordedTerminal: disposition.terminal
        }) };
      }
      if (disposition.state !== 'reconcile_required') {
        return { exitCode: 3, result: terminalResult('HOLD_PRE_DISPATCH', 'reconcile_evidence_missing', {
          component: parsed.component, operationId, attemptId
        }) };
      }
      let reconciled;
      try { reconciled = await adapter.reconcile({ operationId, attemptId }); }
      catch {
        journal.append('reconcile', { component: parsed.component, effectCount: null, authoritative: false });
        journal.append('terminal', { terminal: 'UNCERTAIN', reason: 'reconcile_failed', component: parsed.component });
        return { exitCode: 4, result: terminalResult('UNCERTAIN', 'reconcile_failed', { component: parsed.component, operationId, attemptId }) };
      }
      journal.append('reconcile', { component: parsed.component, effectCount: reconciled?.effectCount ?? null, authoritative: reconciled?.authoritative === true });
      const terminal = reconciled?.authoritative !== true || ![0, 1].includes(reconciled?.effectCount) ? 'UNCERTAIN'
        : reconciled.effectCount === 1 ? 'PASS' : 'FAILED';
      const reason = terminal === 'PASS' ? 'effect_verified' : terminal === 'FAILED' ? 'known_no_effect' : 'effect_unknown_or_duplicate';
      journal.append('terminal', { terminal, reason, component: parsed.component });
      return { exitCode: terminal === 'PASS' ? 0 : 4, result: terminalResult(terminal, reason, { component: parsed.component, operationId, attemptId }) };
    }

    if (disposition.state === 'terminal') {
      return { exitCode: 3, result: terminalResult('HOLD_PRE_DISPATCH', 'attempt_already_terminal', {
        component: parsed.component, operationId, attemptId, recordedTerminal: disposition.terminal
      }) };
    }
    if (disposition.state === 'reconcile_required') {
      if (parsed.mode === 'stop') journal.append('stop_requested', { component: parsed.component, disposition: 'reconcile_required' });
      return { exitCode: 4, result: terminalResult('RECONCILE_REQUIRED', 'post_dispatch_attempt_exists', {
        component: parsed.component, operationId, attemptId
      }) };
    }
    if (disposition.state === 'pre_dispatch_started') {
      return { exitCode: 3, result: terminalResult('HOLD_PRE_DISPATCH', 'attempt_already_started', {
        component: parsed.component, operationId, attemptId
      }) };
    }

    journal.append('invocation', { component: parsed.component, mode: parsed.mode, argumentCount: 1 });
    journal.append('parsed', { component: parsed.component, mode: parsed.mode });

    if (parsed.mode === 'stop') {
      journal.append('stop_requested', { component: parsed.component });
      journal.append('terminal', { terminal: 'HOLD_PRE_DISPATCH', reason: 'stop_requested', component: parsed.component });
      return { exitCode: 3, result: terminalResult('HOLD_PRE_DISPATCH', 'stop_requested', { component: parsed.component, operationId, attemptId }) };
    }

    const gate = await sampleGate(journal);
    if (!gate.ok) {
      journal.append('terminal', { terminal: 'HOLD_PRE_DISPATCH', reason: 'activity_gate', component: parsed.component, blockerCount: gate.blockers.length });
      return { exitCode: 3, result: terminalResult('HOLD_PRE_DISPATCH', 'activity_gate', { component: parsed.component, operationId, attemptId }) };
    }

    let inspection;
    try { inspection = await adapter.inspect({ mode: parsed.mode, operationId, attemptId }); }
    catch {
      journal.append('terminal', { terminal: 'HOLD_PRE_DISPATCH', reason: 'inspection_failed', component: parsed.component });
      return { exitCode: 3, result: terminalResult('HOLD_PRE_DISPATCH', 'inspection_failed', { component: parsed.component, operationId, attemptId }) };
    }
    journal.append('inspection', { component: parsed.component, current: inspection?.current === true, fingerprintHash: inspection?.fingerprintHash ?? null });
    if (parsed.mode === 'dry-run') {
      const reason = inspection?.current === true
        ? 'not_applicable'
        : inspection?.fingerprintVerified === true ? 'candidate_ready' : 'adapter_not_ready';
      journal.append('terminal', { terminal: 'DRY_RUN', reason, component: parsed.component });
      return { exitCode: 0, result: terminalResult('DRY_RUN', reason, { component: parsed.component, operationId, attemptId, inspection }) };
    }

    if (parsed.mode === 'apply') {
      if (inspection?.current === true) {
        journal.append('terminal', { terminal: 'NOT_APPLICABLE', reason: 'component_current', component: parsed.component });
        return { exitCode: 0, result: terminalResult('NOT_APPLICABLE', 'component_current', { component: parsed.component, operationId, attemptId }) };
      }
      if (inspection?.fingerprintVerified !== true) {
        journal.append('terminal', { terminal: 'HOLD_PRE_DISPATCH', reason: 'fingerprint_unproven', component: parsed.component });
        return { exitCode: 3, result: terminalResult('HOLD_PRE_DISPATCH', 'fingerprint_unproven', { component: parsed.component, operationId, attemptId }) };
      }
      let backup;
      try { backup = await adapter.backup({ operationId, attemptId, inspection }); }
      catch {
        journal.append('terminal', { terminal: 'HOLD_PRE_DISPATCH', reason: 'backup_failed', component: parsed.component });
        return { exitCode: 3, result: terminalResult('HOLD_PRE_DISPATCH', 'backup_failed', { component: parsed.component, operationId, attemptId }) };
      }
      journal.append('backup', { component: parsed.component, backupRefHash: backup?.backupRefHash ?? null, verified: backup?.verified === true });
      if (backup?.verified !== true) {
        journal.append('terminal', { terminal: 'HOLD_PRE_DISPATCH', reason: 'backup_unverified', component: parsed.component });
        return { exitCode: 3, result: terminalResult('HOLD_PRE_DISPATCH', 'backup_unverified', { component: parsed.component, operationId, attemptId }) };
      }
      journal.append('dispatch_reserved', { component: parsed.component, mutationClass: 'component_scoped_one_shot' });
      let applied;
      try { applied = await adapter.apply({ operationId, attemptId, inspection, backup }); }
      catch {
        journal.append('reconcile_required', { component: parsed.component, reason: 'apply_ambiguous' });
        return { exitCode: 4, result: terminalResult('RECONCILE_REQUIRED', 'apply_ambiguous', { component: parsed.component, operationId, attemptId }) };
      }
      journal.append('dispatch_ack', { component: parsed.component, acknowledged: applied?.acknowledged === true, dispatchIdentityHash: applied?.dispatchIdentityHash ?? null });
      let verified;
      try { verified = await adapter.verify({ operationId, attemptId, inspection, backup, applied }); }
      catch {
        journal.append('reconcile_required', { component: parsed.component, reason: 'post_read_ambiguous' });
        return { exitCode: 4, result: terminalResult('RECONCILE_REQUIRED', 'post_read_ambiguous', { component: parsed.component, operationId, attemptId }) };
      }
      journal.append('post_read', { component: parsed.component, verified: verified?.ok === true, generationCurrent: verified?.generationCurrent === true });
      const terminal = verified?.ok === true && verified?.generationCurrent === true ? 'PASS' : 'HOLD_POSTREAD';
      journal.append('terminal', { terminal, reason: terminal === 'PASS' ? 'component_verified' : 'acceptance_incomplete', component: parsed.component });
      return { exitCode: terminal === 'PASS' ? 0 : 3, result: terminalResult(terminal, terminal === 'PASS' ? 'component_verified' : 'acceptance_incomplete', { component: parsed.component, operationId, attemptId }) };
    }

    if (parsed.mode === 'rollback') {
      journal.append('dispatch_reserved', { component: parsed.component, mutationClass: 'component_scoped_rollback' });
      let rolledBack;
      try { rolledBack = await adapter.rollback({ operationId, attemptId, inspection }); }
      catch {
        journal.append('terminal', { terminal: 'UNCERTAIN', reason: 'rollback_ambiguous', component: parsed.component });
        return { exitCode: 4, result: terminalResult('UNCERTAIN', 'rollback_ambiguous', { component: parsed.component, operationId, attemptId }) };
      }
      journal.append('rollback', { component: parsed.component, acknowledged: rolledBack?.acknowledged === true });
      let verified;
      try { verified = await adapter.verifyRollback({ operationId, attemptId, rolledBack }); }
      catch {
        journal.append('terminal', { terminal: 'UNCERTAIN', reason: 'rollback_post_read_ambiguous', component: parsed.component });
        return { exitCode: 4, result: terminalResult('UNCERTAIN', 'rollback_post_read_ambiguous', { component: parsed.component, operationId, attemptId }) };
      }
      const terminal = verified?.ok === true ? 'ROLLED_BACK' : 'UNCERTAIN';
      journal.append('terminal', { terminal, reason: terminal === 'ROLLED_BACK' ? 'preimage_verified' : 'rollback_unverified', component: parsed.component });
      return { exitCode: terminal === 'ROLLED_BACK' ? 0 : 4, result: terminalResult(terminal, terminal === 'ROLLED_BACK' ? 'preimage_verified' : 'rollback_unverified', { component: parsed.component, operationId, attemptId }) };
    }

    throw new RestoreV2Error('mode_unhandled', `unhandled restore mode: ${parsed.mode}`);
  }

  async function run(argv = []) {
    if (argv.includes('--help') || argv.includes('-h')) return runParsed(parseRestoreV2Args(argv));
    let parsed;
    try { parsed = parseRestoreV2Args(argv); }
    catch (error) {
      const operationId = 'restore-parse-failure';
      const attemptId = generatedIdentity('parse');
      const journal = journalFor(operationId, attemptId);
      journal.append('parse_failure', { argumentCount: argv.length, errorCode: error?.code ?? 'parse_failed' });
      journal.append('terminal', { terminal: 'HOLD_PRE_DISPATCH', reason: error?.code ?? 'parse_failed' });
      return { exitCode: 2, result: terminalResult('HOLD_PRE_DISPATCH', error?.code ?? 'parse_failed', { operationId, attemptId }) };
    }
    return runParsed(parsed);
  }

  return { run, runParsed, parse: parseRestoreV2Args, mutatingModes: MUTATING_MODES };
}
