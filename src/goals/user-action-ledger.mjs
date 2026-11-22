import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ACTION_STATES = new Set(['OPEN', 'BLOCKING']);
const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const PART_NUMBER = /^(?:0[0-9]|1[01])$/;
const SIMPLE_TEXT_FORBIDDEN = /\b(?:UAC|HOLD|SHA-?256|MCP|CDP|PIT|OOS|SSOT|DRIFT)\b/i;

function ledgerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { throw ledgerError('invalid_user_action_ledger', `사용자 할 일 원장을 읽을 수 없습니다: ${filePath}`); }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function appendEvent(filePath, event) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(event)}\n`);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows ACL or unsupported mode */ }
}

function eventCount(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).length;
}

function cleanText(value, field, { required = true, max = 420, simple = true } = {}) {
  if (!required && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !value.trim()) throw ledgerError('invalid_user_action', `${field}에 쉬운 설명이 필요합니다.`);
  const text = value.trim();
  if (text.length > max) throw ledgerError('invalid_user_action', `${field} 설명이 너무 깁니다.`);
  if (simple && SIMPLE_TEXT_FORBIDDEN.test(text)) throw ledgerError('invalid_user_action', `${field}에는 어려운 약자를 바로 쓸 수 없습니다.`);
  return text;
}

function normalizeInput(input = {}) {
  if (typeof input.id !== 'string' || !ACTION_ID.test(input.id)) throw ledgerError('invalid_user_action', '안정된 사용자 할 일 id가 필요합니다.');
  if (typeof input.part !== 'string' || !PART_NUMBER.test(input.part)) throw ledgerError('invalid_user_action', '담당 파트는 00~11 번호여야 합니다.');
  const steps = Array.isArray(input.steps) ? input.steps : [];
  if (steps.length < 1 || steps.length > 3) throw ledgerError('invalid_user_action', '방법은 1~3단계여야 합니다.');
  const state = input.state ?? 'OPEN';
  if (!ACTION_STATES.has(state)) throw ledgerError('invalid_user_action', '상태는 OPEN 또는 BLOCKING이어야 합니다.');
  if (state === 'BLOCKING' && input.safeWorkRemaining !== false) {
    throw ledgerError('invalid_user_action', 'BLOCKING은 다른 안전한 일이 0개임을 safeWorkRemaining: false로 확인해야 합니다.');
  }
  const availableAfter = input.availableAfter ?? null;
  if (availableAfter !== null && (typeof availableAfter !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(availableAfter) || Number.isNaN(Date.parse(availableAfter)))) {
    throw ledgerError('invalid_user_action', 'availableAfter는 날짜와 시간이 포함된 값이어야 합니다.');
  }
  return {
    id: input.id,
    part: input.part,
    partTitle: cleanText(input.partTitle, '파트 이름', { max: 80 }),
    title: cleanText(input.title, '제목', { max: 100 }),
    ask: cleanText(input.ask, '지금 할 일'),
    why: cleanText(input.why, '필요한 이유'),
    steps: steps.map((step, index) => cleanText(step, `방법 ${index + 1}`, { max: 220 })),
    completionCriteria: cleanText(input.completionCriteria, '끝난 기준'),
    agentNext: cleanText(input.agentNext, '에이전트의 다음 행동', { required: false, max: 240, simple: false }),
    sourceRef: cleanText(input.sourceRef, '출처', { required: false, max: 160, simple: false }),
    state,
    blockingReason: state === 'BLOCKING' ? cleanText(input.blockingReason, '지금 꼭 필요한 이유') : null,
    safeWorkRemaining: state === 'BLOCKING' ? false : null,
    availableAfter
  };
}

function normalizeSnapshot(raw) {
  if (raw === null) return { schemaVersion: 1, sequence: 0, updatedAt: null, completedCount: 0, actions: [] };
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.actions)
    || !Number.isInteger(raw.sequence) || raw.sequence < 0
    || !Number.isInteger(raw.completedCount) || raw.completedCount < 0) {
    throw ledgerError('invalid_user_action_ledger', '사용자 할 일 원장의 구조가 올바르지 않습니다.');
  }
  const ids = new Set();
  const actions = raw.actions.map(action => {
    const normalized = normalizeInput(action);
    if (ids.has(normalized.id)) throw ledgerError('invalid_user_action_ledger', `중복 사용자 할 일 id입니다: ${normalized.id}`);
    ids.add(normalized.id);
    return {
      ...normalized,
      createdAt: cleanText(action.createdAt, '생성 시각', { max: 64, simple: false }),
      updatedAt: cleanText(action.updatedAt, '갱신 시각', { max: 64, simple: false })
    };
  });
  return {
    schemaVersion: 1,
    sequence: raw.sequence,
    updatedAt: raw.updatedAt ?? null,
    completedCount: raw.completedCount,
    actions
  };
}

function comparable(action) {
  const { createdAt, updatedAt, ...value } = action;
  return JSON.stringify(value);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

export function userActionRevision(action) {
  return createHash('sha256').update(JSON.stringify({ ...normalizeInput(action), createdAt: action.createdAt, updatedAt: action.updatedAt })).digest('hex');
}

export class UserActionLedger {
  constructor(options = {}) {
    const ownerRoot = options.ownerRoot ?? path.join(os.homedir(), '.ai-control-center');
    this.snapshotPath = options.snapshotPath ?? path.join(ownerRoot, 'control-plane', 'user-actions.json');
    this.eventsPath = options.eventsPath ?? path.join(ownerRoot, 'control-plane', 'user-action-events.jsonl');
    this.lockPath = options.lockPath ?? path.join(path.dirname(this.snapshotPath), 'user-actions.lock');
    this.now = options.now ?? (() => new Date().toISOString());
    this.clock = options.clock ?? (() => Date.now());
    this.lockStaleMs = options.lockStaleMs ?? 30_000;
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
  }

  acquireLock() {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    const open = () => {
      const descriptor = fs.openSync(this.lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: this.clock() }));
      fs.fsyncSync(descriptor);
      return descriptor;
    };
    try { return open(); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lock = readJson(this.lockPath, null);
      const age = lock && Number.isFinite(lock.createdAt) ? this.clock() - lock.createdAt : 0;
      if (!lock || age <= this.lockStaleMs || this.isProcessAlive(lock.pid)) {
        throw ledgerError('writer_busy', '사용자 할 일 원장에 다른 쓰기 작업이 진행 중입니다.');
      }
      try { fs.unlinkSync(this.lockPath); }
      catch { throw ledgerError('writer_busy', '중단된 사용자 할 일 쓰기 잠금을 복구하지 못했습니다.'); }
      try { return open(); }
      catch { throw ledgerError('writer_busy', '사용자 할 일 원장 쓰기가 동시에 시작되었습니다.'); }
    }
  }

  withLock(action) {
    const descriptor = this.acquireLock();
    try { return action(); }
    finally {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
      try { fs.unlinkSync(this.lockPath); } catch { /* exact lock already released */ }
    }
  }

  read() {
    return normalizeSnapshot(readJson(this.snapshotPath, null));
  }

  status() {
    const snapshot = this.read();
    const nowMs = Date.parse(this.now());
    const actions = snapshot.actions.map(action => ({
      ...action,
      blocking: action.state === 'BLOCKING',
      revision: userActionRevision(action),
      readyNow: action.state === 'BLOCKING' || !action.availableAfter || Date.parse(action.availableAfter) <= nowMs
    })).sort((left, right) => Number(right.blocking) - Number(left.blocking)
      || Number(right.readyNow) - Number(left.readyNow)
      || left.part.localeCompare(right.part)
      || left.createdAt.localeCompare(right.createdAt));
    return {
      schemaVersion: 1,
      sequence: snapshot.sequence,
      updatedAt: snapshot.updatedAt,
      activeCount: actions.length,
      blockingCount: actions.filter(action => action.blocking).length,
      readyCount: actions.filter(action => action.readyNow).length,
      laterCount: actions.filter(action => !action.readyNow).length,
      completedCount: snapshot.completedCount,
      historyCount: eventCount(this.eventsPath),
      actions
    };
  }

  add(input = {}) {
    const candidate = normalizeInput(input);
    return this.withLock(() => {
      const snapshot = this.read();
      const index = snapshot.actions.findIndex(action => action.id === candidate.id);
      const at = this.now();
      const next = {
        ...candidate,
        createdAt: index >= 0 ? snapshot.actions[index].createdAt : at,
        updatedAt: at
      };
      if (index >= 0 && comparable(snapshot.actions[index]) === comparable(next)) {
        return { ok: true, changed: false, action: this.status().actions.find(action => action.id === candidate.id) };
      }
      if (index >= 0) snapshot.actions[index] = next;
      else snapshot.actions.push(next);
      snapshot.sequence += 1;
      snapshot.updatedAt = at;
      atomicWriteJson(this.snapshotPath, snapshot);
      appendEvent(this.eventsPath, { schemaVersion: 1, sequence: snapshot.sequence, at, type: index >= 0 ? 'UPDATED' : 'ADDED', action: next });
      return { ok: true, changed: true, action: this.status().actions.find(action => action.id === candidate.id), sequence: snapshot.sequence };
    });
  }

  prepareComplete(input = {}) {
    if (!/^[a-f0-9]{64}$/.test(input.expectedActionRevision ?? '')) throw ledgerError('user_action_revision_required', '현재 사용자 할 일의 버전이 필요합니다.');
    const action = this.status().actions.find(row => row.id === input.id);
    if (!action) throw ledgerError('unknown_user_action', '현재 남아 있는 사용자 할 일을 찾지 못했습니다.');
    if (action.revision !== input.expectedActionRevision) throw ledgerError('user_action_revision_conflict', '사용자 할 일이 바뀌었습니다. 새로 조회하세요.');
    const evidence = cleanText(input.evidence, '완료 근거', { max: 420, simple: false });
    return { action, evidence, fingerprint: createHash('sha256').update(JSON.stringify({ revision: action.revision, evidence })).digest('hex'), summary: [action.title, `요청: ${action.ask}`, `완료 기준: ${action.completionCriteria}`, `완료 근거: ${evidence}`, '이 사용자 할 일만 완료 이력에 기록합니다. 에이전트·지시·목표 완료나 실제 발신을 수행하지 않습니다.'] };
  }

  complete(input = {}) {
    if (!ACTION_ID.test(String(input.id ?? ''))) throw ledgerError('invalid_user_action', '완료할 사용자 할 일 id가 필요합니다.');
    const evidence = cleanText(input.evidence, '완료 근거', { max: 420, simple: false });
    const completedBy = input.completedBy === 'USER' ? 'USER' : 'AGENT';
    return this.withLock(() => {
      const snapshot = this.read();
      const index = snapshot.actions.findIndex(action => action.id === input.id);
      if (index < 0) throw ledgerError('unknown_user_action', `남아 있는 사용자 할 일을 찾지 못했습니다: ${input.id}`);
      if (input.expectedActionRevision !== undefined && input.expectedActionRevision !== userActionRevision(snapshot.actions[index])) {
        throw ledgerError('user_action_revision_conflict', '사용자 할 일이 바뀌었습니다. 현재 내용과 완료 기준을 다시 확인하세요.');
      }
      const [action] = snapshot.actions.splice(index, 1);
      const at = this.now();
      snapshot.sequence += 1;
      snapshot.updatedAt = at;
      snapshot.completedCount += 1;
      atomicWriteJson(this.snapshotPath, snapshot);
      appendEvent(this.eventsPath, { schemaVersion: 1, sequence: snapshot.sequence, at, type: 'COMPLETED', id: action.id, part: action.part, title: action.title, completedBy, evidence });
      return { ok: true, changed: true, removed: true, id: action.id, completedAt: at, completedBy, sequence: snapshot.sequence };
    });
  }
}

export function runUserActionCommand(subcommand, input = null, options = {}) {
  const ledger = options.ledger ?? new UserActionLedger(options);
  if (subcommand === 'status') return { ok: true, ...ledger.status() };
  if (subcommand === 'add') return ledger.add(input);
  if (subcommand === 'complete') return ledger.complete(input);
  throw new Error('usage: aicc user-action status|add|complete [--json]');
}
