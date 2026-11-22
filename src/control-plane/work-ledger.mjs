import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlReportStore } from './report-store.mjs';
import { UserActionLedger } from '../goals/user-action-ledger.mjs';

const SESSION_NUMBER = /^\d{2,3}$/;
const SAFE_DECISIONS = new Set(['KEEP', 'CONTINUE', 'ARCHIVE', 'HOLD', 'USER']);
const SECRET_LIKE = /(?:authorization|cookie|password|passwd|token|secret|api[_-]?key)\s*[:=]\s*\S+|\bbearer\s+[A-Za-z0-9._~-]{8,}/i;

export class WorkLedgerError extends Error {
  constructor(code, message) { super(message); this.name = 'WorkLedgerError'; this.code = code; }
}

function cleanText(value, field, max = 2000) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new WorkLedgerError('invalid_work_ledger_source', `${field} must be text`);
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new WorkLedgerError('invalid_work_ledger_source', `${field} is invalid`);
  }
  if (SECRET_LIKE.test(text)) throw new WorkLedgerError('secret_like_work_ledger_source', `${field} contains secret-like content`);
  return text;
}

function readJson(file, label) {
  if (!fs.existsSync(file)) return { ok: false, missing: true, value: null, error: `${label}_missing` };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, missing: false, value: null, error: `${label}_not_regular_file` };
    return { ok: true, missing: false, value: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
  } catch {
    return { ok: false, missing: false, value: null, error: `${label}_invalid_json` };
  }
}

function timestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestReport(reportIds, workers) {
  return reportIds.map(id => workers[id]).filter(Boolean)
    .sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt))[0] ?? null;
}

function normalizeSessions(raw, workers, actions) {
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.sessions)) {
    throw new WorkLedgerError('invalid_session_registry', 'session registry schema is invalid');
  }
  const seen = new Set();
  return raw.sessions.map((session, index) => {
    if (!session || typeof session !== 'object') throw new WorkLedgerError('invalid_session_registry', `session ${index} is invalid`);
    const number = String(session.number ?? '').trim();
    if (!SESSION_NUMBER.test(number) || seen.has(number)) throw new WorkLedgerError('invalid_session_registry', `session number is invalid or duplicated: ${number}`);
    seen.add(number);
    const reportWorkerIds = Array.isArray(session.reportWorkerIds) ? [...new Set(session.reportWorkerIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))] : [];
    const report = latestReport(reportWorkerIds, workers);
    const userActions = actions.filter(action => action.part === number);
    const decision = SAFE_DECISIONS.has(String(session.decision ?? '').toUpperCase()) ? String(session.decision).toUpperCase() : 'KEEP';
    const state = report?.status ?? cleanText(session.state, `session ${number} state`, 80) ?? 'UNKNOWN';
    const archived = decision === 'ARCHIVE' || String(session.state ?? '').toUpperCase() === 'ARCHIVED';
    return Object.freeze({
      number,
      title: cleanText(session.title, `session ${number} title`, 160) ?? `Session ${number}`,
      threadId: cleanText(session.threadId, `session ${number} thread id`, 160),
      mode: cleanText(session.mode, `session ${number} mode`, 80) ?? 'AUTOMATIC',
      state,
      decision,
      archived,
      resumable: !archived && !['DONE'].includes(state),
      objective: cleanText(session.objective ?? session.work, `session ${number} objective`),
      progress: cleanText(session.progress ?? report?.summary ?? session.latestSummary ?? session.work, `session ${number} progress`),
      remaining: cleanText(session.remaining ?? report?.nextGate ?? session.next, `session ${number} remaining`),
      nextGate: cleanText(report?.nextGate ?? session.next ?? session.remaining, `session ${number} next gate`),
      latestSummary: cleanText(report?.summary ?? session.latestSummary, `session ${number} latest summary`),
      updatedAt: report?.updatedAt ?? session.updatedAt ?? null,
      reportWorkerIds,
      userActions: userActions.map(action => ({ id: action.id, state: action.state, blocking: action.blocking, readyNow: action.readyNow, title: action.title, ask: action.ask })),
      blockingUserActions: userActions.filter(action => action.blocking).length
    });
  }).sort((left, right) => left.number.localeCompare(right.number));
}

function semanticDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class WorkLedgerResumeView {
  constructor(options = {}) {
    this.ownerRoot = path.resolve(options.ownerRoot ?? path.join(os.homedir(), '.ai-control-center'));
    this.sessionsPath = path.resolve(options.sessionsPath ?? path.join(this.ownerRoot, 'control-plane', 'session-registry.json'));
    this.reportStore = options.reportStore ?? new ControlReportStore({ stateRoot: this.ownerRoot });
    this.userActionLedger = options.userActionLedger ?? new UserActionLedger({ ownerRoot: this.ownerRoot });
  }

  status({ includeArchived = false } = {}) {
    const sourceHealth = {};
    let reports = { workers: {}, counts: {}, attention: [], sequence: 0, digest: null, updatedAt: null };
    try { reports = this.reportStore.status(); sourceHealth.reports = { ok: true, sequence: reports.sequence, digest: reports.digest }; }
    catch (error) { sourceHealth.reports = { ok: false, error: error.code ?? 'report_read_failed' }; }

    let userActions = { sequence: 0, activeCount: 0, blockingCount: 0, completedCount: 0, actions: [] };
    try { userActions = this.userActionLedger.status(); sourceHealth.userActions = { ok: true, sequence: userActions.sequence }; }
    catch (error) { sourceHealth.userActions = { ok: false, error: error.code ?? 'user_action_read_failed' }; }

    const sessionRead = readJson(this.sessionsPath, 'session_registry');
    sourceHealth.sessions = { ok: sessionRead.ok, error: sessionRead.error };
    let sessions = [];
    if (sessionRead.ok) {
      try { sessions = normalizeSessions(sessionRead.value, reports.workers ?? {}, userActions.actions ?? []); sourceHealth.sessions = { ok: true, updatedAt: sessionRead.value.updatedAt ?? null }; }
      catch (error) { sourceHealth.sessions = { ok: false, error: error.code ?? 'session_normalize_failed' }; }
    }

    const visible = includeArchived ? sessions : sessions.filter(session => !session.archived);
    const sessionWorkerIds = new Set(sessions.flatMap(session => session.reportWorkerIds));
    const orphanWorkers = Object.values(reports.workers ?? {}).filter(worker => !sessionWorkerIds.has(worker.workerId)).map(worker => ({
      workerId: worker.workerId, status: worker.status, revision: worker.revision ?? null, summary: worker.summary ?? null, nextGate: worker.nextGate ?? null, updatedAt: worker.updatedAt ?? null
    })).sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt) || left.workerId.localeCompare(right.workerId));

    const resumable = visible.filter(session => session.resumable).sort((left, right) => Number(right.blockingUserActions > 0) - Number(left.blockingUserActions > 0) || timestamp(right.updatedAt) - timestamp(left.updatedAt) || left.number.localeCompare(right.number));
    const blocking = (userActions.actions ?? []).filter(action => action.blocking);
    const current = resumable[0] ?? null;
    const activeOrphan = orphanWorkers.find(worker => ['PROGRESS', 'HOLD', 'APPROVAL_REQUIRED', 'DRIFT'].includes(worker.status)) ?? null;
    const resumeTarget = current ? {
      kind: 'session', id: current.number, state: current.state, objective: current.objective, progress: current.progress, nextGate: current.nextGate, updatedAt: current.updatedAt
    } : activeOrphan ? {
      kind: 'worker', id: activeOrphan.workerId, state: activeOrphan.status, objective: null, progress: activeOrphan.summary, nextGate: activeOrphan.nextGate, updatedAt: activeOrphan.updatedAt
    } : null;
    const semantic = { sessions: visible, orphanWorkers, resumeTarget, blocking: blocking.map(action => action.id), reportDigest: reports.digest ?? null, userActionSequence: userActions.sequence ?? 0 };
    return Object.freeze({
      ok: Object.values(sourceHealth).every(source => source.ok === true),
      schemaVersion: 1,
      digest: semanticDigest(semantic),
      currentControlPath: sessionRead.ok ? cleanText(sessionRead.value.currentControlPath, 'current control path', 500) : null,
      sourceHealth,
      summary: { sessions: visible.length, resumable: resumable.length, archivedHidden: includeArchived ? 0 : sessions.filter(session => session.archived).length, orphanWorkers: orphanWorkers.length, activeUserActions: userActions.activeCount ?? 0, blockingUserActions: blocking.length },
      current,
      resumeTarget,
      sessions: visible,
      orphanWorkers,
      blockingUserActions: blocking.map(action => ({ id: action.id, part: action.part, title: action.title, ask: action.ask, why: action.why, readyNow: action.readyNow })),
      nextGate: resumeTarget?.nextGate ?? blocking[0]?.agentNext ?? null
    });
  }
}

export function createWorkLedgerResumeView(options = {}) { return new WorkLedgerResumeView(options); }