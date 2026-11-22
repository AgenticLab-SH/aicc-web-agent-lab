import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { userActionRevision } from './goals/user-action-ledger.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const terminal = new Set(['COMPLETED', 'CANCELLED']);
const metadataActions = new Set(['pin', 'node-save', 'node-merge', 'node-archive', 'node-order']);
const mergeFields = ['title', 'parentId', 'description', 'usage', 'options', 'defaults', 'impact', 'current', 'remaining'];
const text = (value, max = 1200) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '';
// Explain structured owner records without dropping false/0 or inventing missing defaults.
function explanation(value, depth = 0) {
  if (typeof value === 'string') return text(value);
  if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (!value || typeof value !== 'object' || depth > 2) return '';
  const lines = Array.isArray(value)
    ? value.slice(0, 12).map(v => explanation(v, depth + 1))
    : Object.entries(value).slice(0, 12).map(([key, v]) => { const content = explanation(v, depth + 1); return content ? `${text(key, 80)}: ${content}` : ''; });
  return lines.filter(Boolean).join('\n').slice(0, 1200);
}
function implementationExplanation(value) {
  if (typeof value === 'string') return text(value);
  const labels = { source: '소스', installed: '설치', deployed: '배포', live: '실사용', state: '기록 상태', productChanges: '제품 변경 수', runtimeAcceptance: '운영 인수', testBuildDeploy: '검사·빌드·배포', thisTurn: '원장 작성 당시 작업' };
  return Object.entries(labels).map(([key, label]) => { const content = explanation(value?.[key]); return content ? `${label}: ${content.slice(0, 240)}` : ''; }).filter(Boolean).join('\n');
}
const digestText = value => createHash('sha256').update(value, 'utf8').digest('hex');
function instructionText(value) {
  if (typeof value !== 'string') fail('dashboard_instruction_required');
  const instruction = value.replace(/\r\n/g, '\n').trim();
  if (!instruction || instruction.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(instruction)) fail('dashboard_instruction_invalid');
  return instruction;
}
function read(file, fallback = null, parse = JSON.parse) {
  try {
    for (let current = file;; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) fail('dashboard_symlink_denied');
      if (path.dirname(current) === current) break;
    }
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) fail('dashboard_source_invalid');
    const buffer = fs.readFileSync(file);
    return parse(buffer.toString('utf8').replace(/^\uFEFF/, ''), buffer);
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, file);
}
const empty = () => ({ schemaVersion: 1, revision: 0, nodes: {}, pins: {}, queue: [], paused: {}, stopped: true, operations: [] });
const list = value => Array.isArray(value) ? value.slice(0, 12).map(v => text(typeof v === 'string' ? v : JSON.stringify(v), 800)) : [];

/** A projection of registered owners plus project-catalog annotations and explicit unsent intents.
 * Never writes portfolio/execution, reports-v1, native goals or the official Desktop queue. */
export function createDashboardWorkspace(options = {}) {
  const owner = path.resolve(options.ownerRoot ?? process.env.AICC_STATE_ROOT ?? path.join(os.homedir(), '.ai-control-center'));
  const codex = path.resolve(options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  const portfolio = options.portfolioRoot ?? path.join(codex, 'specs', 'ai-work-system-upgrade', 'portfolio');
  const productSpecFile = options.productSpecFile ?? fileURLToPath(new URL('../docs/dashboard-product-spec.md', import.meta.url));
  const directory = path.join(owner, 'project-catalog');
  const file = path.join(directory, 'workspace-state.json');
  const continuityRoot = path.join(owner, 'control-plane', 'codex-continuity');
  const requestRoot = path.join(continuityRoot, 'requests');
  const now = () => new Date().toISOString();
  function state() { return read(file, empty()); }
  function assertGoalReady(q) {
    if (!q.goalId) return;
    const goals = read(path.join(owner, 'control-plane', 'master-goals.json'))?.goals ?? [];
    const goal = goals.find(g => g.id === q.goalId);
    if (!goal || goal.archived || ['HOLD', 'COMPLETE'].includes(goal.status)) fail('dashboard_goal_not_ready');
    const visiting = new Set(), visited = new Set();
    const check = current => {
      if (!current || current.archived || visiting.has(current.id) || visiting.size > 500) fail('dashboard_goal_dependency_pending');
      if (visited.has(current.id)) return;
      visiting.add(current.id);
      if (!Array.isArray(current.dependsOn ?? [])) fail('dashboard_goal_dependency_pending');
      for (const id of current.dependsOn ?? []) {
        const dependency = goals.find(g => g.id === id);
        if (dependency?.status !== 'COMPLETE') fail('dashboard_goal_dependency_pending');
        check(dependency);
      }
      visiting.delete(current.id); visited.add(current.id);
    };
    check(goal);
  }
  // Recheck a staged intent without consuming it, claiming a sender or creating evidence.
  function inspectHandoff(input) {
    if (!input || !uuid.test(input.id ?? '')) fail('dashboard_queue_missing');
    const view = status(), q = view.queue.find(row => row.id === input.id);
    if (!q || q.state !== 'HANDOFF_READY' || q.attemptId !== q.id || q.marker !== `AICC_QUEUE_ATTEMPT:${q.id}` || !/^[a-f0-9]{64}$/.test(q.messageSha256 ?? '')) fail('dashboard_handoff_not_ready');
    if (view.revision !== input.expectedRevision) fail('dashboard_revision_conflict');
    if (view.stopped || view.paused[q.agentId]) fail('dashboard_queue_paused');
    if (view.queue.find(row => row.agentId === q.agentId && !terminal.has(row.state))?.id !== q.id) fail('dashboard_previous_instruction_pending');
    const agent = view.agents.find(row => row.id === q.agentId);
    if (!agent || q.reportRef && q.reportRef.revision !== agent.reportRevision) fail('dashboard_reply_report_changed');
    assertGoalReady(q);
    const registry = read(path.join(continuityRoot, 'registrations.json'));
    const target = registry?.threads?.[q.agentId];
    if (!target || registry.excludedThreadIds?.includes(q.agentId) || /ARCHIVED|MISSING|SCOPE|HOLD|COMPLETE/.test(target.state ?? '') || registry.workerStopRequestedAt) fail('dashboard_handoff_target_unavailable');
    if (target.attempt || target.queueAttempt) fail('dashboard_original_attempt_pending');
    if (fs.existsSync(path.join(requestRoot, `${q.id}.json`))) fail('dashboard_existing_operation_preserved');
    const messageFile = path.join(requestRoot, `${q.id}.txt`);
    for (let current = messageFile;; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) fail('dashboard_symlink_denied');
      if (path.dirname(current) === current) break;
    }
    const stat = fs.statSync(messageFile);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32768) fail('dashboard_message_poststate_mismatch');
    const bytes = fs.readFileSync(messageFile), message = bytes.toString('utf8');
    if (message !== q.instruction || digestText(message.trim()) !== q.messageSha256) fail('dashboard_message_poststate_mismatch');
    const goalBinding = q.goalId ? read(path.join(owner, 'control-plane', 'master-goals.json')) : null;
    return { id: q.id, agentId: q.agentId, messageSha256: q.messageSha256, marker: q.marker, fingerprint: hash({ revision: view.revision, q, registry, goalBinding, reportRevision: q.reportRef ? agent.reportRevision : null, bytes: digestText(message) }), dispatched: false };
  }
  function receiptFor(q) {
    if (!uuid.test(q.attemptId ?? '') || q.attemptId !== q.id) fail('dashboard_attempt_binding_invalid');
    const receipt = read(path.join(requestRoot, `${q.attemptId}.json`));
    if (!receipt) return null; // Absence never proves NOT_DISPATCHED.
    if (receipt.id !== q.attemptId || receipt.threadId !== q.agentId || receipt.messageSha256 !== q.messageSha256 || receipt.marker !== q.marker || receipt.transport !== 'codex-queue') fail('dashboard_receipt_scope_mismatch');
    const registered = read(path.join(continuityRoot, 'registrations.json'))?.threads?.[q.agentId];
    const attempt = [registered?.queueAttempt, registered?.lastQueueAttempt].find(a => a?.id === q.attemptId);
    if (!attempt || attempt.threadId !== q.agentId || attempt.messageSha256 !== q.messageSha256 || attempt.marker !== q.marker || attempt.state !== receipt.state || attempt.turnId !== receipt.turnId) fail('dashboard_receipt_owner_mismatch');
    if (!Number.isFinite(Date.parse(receipt.at)) || Date.parse(receipt.at) < Date.parse(q.preparedAt) - 2000 || Date.parse(receipt.at) > Date.now() + 5000) fail('dashboard_receipt_time_invalid');
    return receipt;
  }
  function receiptState(receipt) {
    if (receipt.state === 'QUEUE_ACCEPTED' && uuid.test(receipt.queuedMessageId ?? '') && Number.isFinite(Date.parse(receipt.acceptedAt))) return 'ACCEPTED';
    if (receipt.state === 'QUEUE_TURN_ACTIVE' && uuid.test(receipt.turnId ?? '')) return 'RUNNING';
    if (['QUEUE_TURN_COMPLETED', 'QUEUE_TURN_INTERRUPTED'].includes(receipt.state) && uuid.test(receipt.turnId ?? '') && Number.isFinite(Date.parse(receipt.terminalAt)) && Date.parse(receipt.terminalAt) >= Date.parse(receipt.at)) return receipt.state === 'QUEUE_TURN_COMPLETED' ? 'TURN_COMPLETED' : 'INTERRUPTED';
    return 'UNKNOWN';
  }
  function stageMessage(q) {
    // This is an inert input to the EXISTING explicit QueueMessage action, never a sender.
    fs.mkdirSync(requestRoot, { recursive: true, mode: 0o700 });
    for (let current = requestRoot;; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) fail('dashboard_symlink_denied');
      if (path.dirname(current) === current) break;
    }
    const messageFile = path.join(requestRoot, `${q.attemptId}.txt`);
    const fd = fs.openSync(messageFile, 'wx', 0o600);
    try { fs.writeFileSync(fd, q.instruction, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (digestText(fs.readFileSync(messageFile, 'utf8').trim()) !== q.messageSha256) fail('dashboard_message_poststate_mismatch');
  }
  function sources() {
    const issues = [];
    const sourceRead = file => {
      try { return read(file); }
      catch (error) { issues.push({ source: path.basename(file), code: /^[a-z_]+$/.test(error.code ?? '') ? error.code : 'source_unreadable' }); return null; }
    };
    const registry = sourceRead(path.join(portfolio, 'group-registry.json'));
    const execution = sourceRead(path.join(portfolio, 'execution.json'));
    const groups = registry?.groups ?? [];
    const products = execution?.userApprovedClassification?.products ?? [];
    let productFeatures = [];
    if (products.some(p => p.key === 'ai-dashboard')) {
      try {
        productFeatures = read(productSpecFile, [], markdown => {
          const blocks = [...markdown.matchAll(/```aicc-dashboard-features\r?\n([\s\S]*?)\r?\n```/g)];
          if (blocks.length !== 1) fail('dashboard_product_description_invalid');
          const value = JSON.parse(blocks[0][1]);
          if (value.schemaVersion !== 1 || value.projectKey !== 'ai-dashboard' || !Array.isArray(value.features) || value.features.length > 30 || !value.features.length) fail('dashboard_product_description_invalid');
          const ids = new Set();
          for (const row of value.features) {
            if (!row || !/^[A-Z][A-Z0-9-]{1,79}$/.test(row.id ?? '') || ids.has(row.id)) fail('dashboard_product_description_invalid');
            ids.add(row.id);
            for (const key of ['title', 'description', 'usage', 'options', 'defaults', 'impact', 'current', 'remaining', 'acceptance']) {
              if (typeof row[key] !== 'string' || !row[key].trim() || row[key].length > (key === 'title' ? 240 : 1200) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(row[key])) fail('dashboard_product_description_invalid');
            }
          }
          return value.features;
        });
      } catch { issues.push({ source: 'dashboard-product-spec.md', code: 'dashboard_product_description_invalid' }); }
      if (!productFeatures.length && !issues.some(i => i.code === 'dashboard_product_description_invalid')) issues.push({ source: 'dashboard-product-spec.md', code: 'dashboard_product_description_missing' });
    }
    const specs = ['platform-estate.json', 'products-tools.json', 'content-career.json'].flatMap(name => (sourceRead(path.join(portfolio, name))?.projects ?? []).map(spec => ({ ...spec, sourceFile: name })));
    const nodes = groups.map(g => ({ id: `group:${g.id}`, kind: 'group', parentId: null, title: text(g.name, 240), sourceId: g.id, rank: g.rank, status: text(g.state), description: '그룹 원장의 현재 분류입니다. 화면 편집은 실행 승인이나 실제 저장소 변경을 뜻하지 않습니다.' }));
    const unmatched = [];
    for (const p of products) {
      const group = groups.find(g => g.id === p.groupId);
      if (!group) { unmatched.push(text(p.key)); continue; }
      const id = `project:${p.key}`;
      nodes.push({ id, kind: 'project', parentId: `group:${group.id}`, title: text(p.name, 240), sourceId: text(p.key), status: text(p.status), description: text(p.functions), current: text(p.implementation), remaining: text(p.action), rank: nodes.length });
      if (p.key === 'ai-dashboard') for (const r of productFeatures) {
        nodes.push({ id: `feature:${p.key}:${r.id}`, kind: 'feature', parentId: id, sourceId: r.id, ...Object.fromEntries(['title', 'description', 'usage', 'options', 'defaults', 'impact', 'current', 'remaining', 'acceptance'].map(key => [key, r[key]])), sourceRecord: { file: 'dashboard-product-spec.md', projectId: p.key, requirementId: r.id }, currentScope: 'feature', remainingScope: 'feature', rank: nodes.length });
      }
      for (const spec of specs.filter(s => (p.sourceIds ?? []).includes(s.id))) {
        for (const r of spec.requirements ?? []) {
          const featureId = `feature:${p.key}:${r.id}`;
          if (nodes.some(n => n.id === featureId)) continue;
          nodes.push({ id: featureId, kind: 'feature', parentId: id, title: text(r.behavior, 240), sourceId: text(r.id), description: text(r.description) || text(r.behavior), usage: explanation(r.usage), options: explanation(r.options), defaults: explanation(r.defaults), impact: explanation(r.impact), current: explanation(r.current) || implementationExplanation(spec.implementationState), remaining: explanation(r.remaining) || explanation(spec.nextAction), acceptance: explanation(r.acceptance), sourceRecord: { file: spec.sourceFile, projectId: text(spec.id, 120), requirementId: text(r.id, 120) }, currentScope: explanation(r.current) ? 'feature' : 'project', remainingScope: explanation(r.remaining) ? 'feature' : 'project', rank: nodes.length });
        }
      }
    }
    const sessions = sourceRead(path.join(owner, 'control-plane', 'session-registry.json'))?.sessions ?? [];
    const reports = sourceRead(path.join(owner, 'control-plane', 'reports-v1', 'snapshot.json'))?.workers ?? {};
    const continuity = sourceRead(path.join(owner, 'control-plane', 'codex-continuity', 'registrations.json'))?.threads ?? {};
    const userActions = sourceRead(path.join(owner, 'control-plane', 'user-actions.json'))?.actions ?? [];
    const registeredQueue = Object.entries(continuity).filter(([id]) => uuid.test(id)).map(([id, row]) => {
      const attempt = row.queueAttempt ?? row.attempt ?? row.lastQueueAttempt ?? row.lastContinuityAttempt;
      const observation = row.lastDesktopObservation ?? row.lastDesktopResult;
      const manualQueue = attempt?.transport === 'codex-queue';
      const turnObserved = manualQueue ? uuid.test(attempt?.turnId ?? '') : !!attempt && observation?.attemptId === attempt.id && !!observation.turnId && observation.turnId !== attempt.previousTurnId;
      return { agentId: id, title: text(row.title, 240), state: text(manualQueue ? attempt.state : row.state || 'UNKNOWN'), selected: row.enabled === true, pendingAttempt: !!row.attempt || !!row.queueAttempt, attemptId: text(attempt?.id, 128) || null, accepted: manualQueue ? uuid.test(attempt?.queuedMessageId ?? '') : !!attempt?.ack, turnObserved, turnStatus: turnObserved ? text(manualQueue ? attempt.state : observation.turnStatus, 80) : null, goalState: 'UNKNOWN', observedAt: row.observedAt ?? null, locked: true, automaticReplay: false };
    });
    const agents = new Map();
    const sessionReports = new Map();
    for (const s of sessions.filter(s => uuid.test(s.threadId ?? ''))) {
      const report = (s.reportWorkerIds ?? []).map(id => reports[id]).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
      if (report) sessionReports.set(s.threadId, report);
      agents.set(s.threadId, { id: s.threadId, title: text(s.title, 240), state: text(report?.status ?? s.state ?? 'UNKNOWN'), summary: text(report?.summary ?? s.latestSummary ?? s.work), completed: list(report?.completed), remaining: list(report?.remaining ?? [report?.nextGate ?? s.remaining ?? s.next].filter(Boolean)), choices: list([...list(report?.choices), ...userActions.filter(a => a.part === s.number).map(a => a.ask ?? a.title)]), nextAction: text(report?.nextAction ?? report?.nextGate ?? s.next), evidence: list(report?.evidence), updatedAt: report?.updatedAt ?? s.updatedAt ?? null, complete: false, sourceArchived: s.state === 'ARCHIVED', source: 'session-registry/reports-v1' });
      if (report) agents.get(s.threadId).reportIdentity = { revision: text(report.revision, 120), sequence: report.workerSequence ?? null, hash: text(report.reportHash, 64) };
    }
    for (const q of registeredQueue) if (!agents.has(q.agentId)) agents.set(q.agentId, { id: q.agentId, title: q.title || q.agentId, state: q.state, summary: '기존 대화 큐의 등록 상태입니다. 실제 실행·전체 완료는 별도 근거가 필요합니다.', completed: [], remaining: [], choices: [], evidence: [], nextAction: '기존 원 attempt의 접수·새 turn 근거를 조회합니다.', updatedAt: q.observedAt, complete: false, source: 'codex-continuity' });
    // The execution record registers the worker run. Never scan arbitrary sessions or raw logs.
    const plan = execution?.currentPreparation?.supervisedRun?.plan;
    let workers = options.workerStateRoot;
    if (!workers && typeof plan === 'string' && !path.isAbsolute(plan)) {
      const full = path.resolve(codex, plan);
      if (full.startsWith(codex + path.sep)) workers = path.dirname(full);
    }
    const run = workers ? sourceRead(path.join(workers, 'run.json')) : null;
    const followups = workers ? sourceRead(path.join(workers, 'followup-dispatch-20261102.json')) : null;
    const namespace = /^[A-Za-z0-9_-]{1,80}$/.test(run?.namespace ?? '') ? run.namespace : null;
    if (workers && fs.existsSync(workers)) for (const name of fs.readdirSync(workers).filter(n => /^[A-Za-z0-9-]+\.state\.json$/.test(n))) {
      const s = sourceRead(path.join(workers, name));
      if (!uuid.test(s?.threadId ?? '')) continue;
      // lastResult must stay beside the registered state; no arbitrary-file reads.
      let result = null;
      if (s.lastResult && path.dirname(path.resolve(s.lastResult)) === path.resolve(workers)) result = sourceRead(s.lastResult);
      const job = run?.jobs?.find(j => j.id === s.jobId && j.session === s.session);
      const sessionAgent = agents.get(s.threadId), report = sessionReports.get(s.threadId);
      agents.set(s.threadId, { id: s.threadId, title: `${text(s.jobId, 80)} · ${text(s.session, 160)}`, groupId: text(s.jobId, 80), state: text(s.state ?? 'UNKNOWN'), summary: text(result?.summary ?? s.reason), completed: list(result?.validation), remaining: list(result?.remaining), choices: list(result?.blockers), nextAction: text(result?.nextAction), evidence: list(result?.changedFiles).filter(v => !/^(?:[A-Za-z]:|\/)/.test(v)), updatedAt: s.updatedAt ?? null, complete: s.state === 'completed' && result?.status === 'completed' && Array.isArray(result.remaining) && !result.remaining.length && Array.isArray(result.blockers) && !result.blockers.length, source: 'registered-worker-result', muxSession: job && namespace && /^[A-Za-z0-9_-]{1,100}$/.test(s.session ?? '') ? s.session : null, muxNamespace: namespace });
      const worker = agents.get(s.threadId);
      // Only an explicitly registered, strictly newer report replaces display fields.
      // It cannot confirm overall completion or override a running worker's state.
      if (report && Date.parse(report.updatedAt) > Date.parse(s.updatedAt)) {
        for (const key of ['summary', 'completed', 'remaining', 'nextAction', 'evidence', 'updatedAt', 'reportIdentity']) worker[key] = sessionAgent[key];
        worker.choices = list([...worker.choices, ...sessionAgent.choices]);
        worker.complete = false;
        worker.source = 'registered-worker-result/reports-v1';
      } else {
        // Pending user decisions must not disappear when a worker result is present.
        const session = sessions.find(row => row.threadId === s.threadId);
        worker.choices = list([...worker.choices, ...userActions.filter(a => session && a.part === session.number).map(a => a.ask ?? a.title)]);
      }
      // Consume only controller-registered settled units. Never discover result files
      // by directory/mtime scans, and never replace live execution with product status.
      const registration = followups?.dispatches?.find(d => d.group === s.jobId && d.thread === s.threadId);
      const registeredJob = run?.jobs?.find(j => j.id === s.jobId && j.threadId === s.threadId);
      if (registration && registeredJob && path.isAbsolute(registeredJob.root ?? '') && path.isAbsolute(s.root ?? '') && path.resolve(registeredJob.root) === path.resolve(s.root) && uuid.test(run.controllerThreadId ?? '') && followups.central === run.controllerThreadId) {
        let unit = registration.latestUnit;
        for (let depth = 0; unit && depth < 12; depth++, unit = unit.previousSettledUnit) {
          if (unit.thread !== s.threadId || !/^COMPLETED_/.test(unit.state ?? '') || unit.officialTurnStatus !== 'completed') continue;
          try {
            const resultPath = path.resolve(workers, unit.result ?? '');
            if (path.dirname(resultPath) !== path.resolve(workers) || !path.basename(resultPath).startsWith(s.jobId + '.') || !/\.result\.json$/.test(resultPath) || !/^[a-f0-9]{64}$/i.test(unit.resultSha256 ?? '')) throw Error('binding');
            let digest;
            const document = read(resultPath, null, (raw, buffer) => { digest = createHash('sha256').update(buffer).digest('hex'); return JSON.parse(raw); });
            if (fs.statSync(resultPath).nlink !== 1) throw Error('binding');
            const at = Date.parse(unit.completedAt), returned = document?.ownership;
            if (digest !== unit.resultSha256.toLowerCase() || !Number.isFinite(at) || at > Date.now() + 5000 || !Number.isFinite(Date.parse(worker.updatedAt ?? s.updatedAt)) || at <= Date.parse(worker.updatedAt ?? s.updatedAt) || (returned?.fromThread ?? returned?.writer) !== s.threadId || returned.returnedTo !== run.controllerThreadId || returned.state !== 'RETURNED_TO_EXISTING_CENTRAL' || path.resolve(returned.root ?? '') !== path.resolve(registeredJob.root) || Date.parse(returned.returnedAt) !== at || !['partial','blocked','completed'].includes(document.status) || typeof document.summary !== 'string' || !Array.isArray(document.remaining)) throw Error('binding');
            worker.unitReport = { status: document.status, unitStatus: text(document.unitStatus ?? unit.state, 100), at: unit.completedAt, ownership: 'RETURNED_TO_EXISTING_CENTRAL', resultName: path.basename(resultPath), sha256: digest, scope: text(unit.scope, 160), currentRegistrationState: text(registration.latestUnit?.state, 100), executionVerified: false };
            worker.legacyState = worker.state;
            worker.legacyStateAt = s.updatedAt ?? null;
            worker.summary = text(document.summary); worker.remaining = list(document.remaining); worker.nextAction = text(document.nextAction);
            worker.completed = list(document.completed);
            const session = sessions.find(row => row.threadId === s.threadId);
            worker.choices = list([...list(document.blockers), ...list(report?.choices), ...userActions.filter(a => session && a.part === session.number).map(a => a.ask ?? a.title)]);
            worker.updatedAt = unit.completedAt;
            worker.reportIdentity = { hash: digest, revision: path.basename(resultPath), source: 'registered-followup-result' };
            worker.source = 'registered-worker-result/registered-followup-result';
            worker.complete = false; // A settled unit, including partial, is not overall completion.
            break;
          } catch { issues.push({ source: 'registered-followup-result', code: 'invalid_registered_result' }); }
        }
      }
    }
    for (const a of agents.values()) {
      // A legacy part number is only a binding when exactly one registered thread owns it.
      const session = sessions.find(row => row.threadId === a.id);
      const exactPart = session && new Set(sessions.filter(row => row.number === session.number).map(row => row.threadId)).size === 1;
      a.userActions = [];
      if (exactPart) for (const action of userActions.filter(row => row.part === session.number)) {
        try { a.userActions.push({ id: action.id, title: text(action.title, 100), ask: text(action.ask, 420), why: text(action.why, 420), steps: list(action.steps), completionCriteria: text(action.completionCriteria, 420), agentNext: text(action.agentNext, 240), state: action.state, revision: userActionRevision(action) }); }
        catch { issues.push({ source: 'user-actions.json', code: 'invalid_user_action' }); }
      }
      if (session && !exactPart && userActions.some(row => row.part === session.number)) issues.push({ source: 'user-actions.json', code: 'ambiguous_user_action_part' });
    }
    return { nodes, agents: [...agents.values()], registeredQueue, sourceRevision: hash({ registry, products, specs, productFeatures, agents: [...agents.values()], registeredQueue }), coverage: { groupCount: groups.length, projectCount: products.length, featureCount: nodes.filter(n => n.kind === 'feature').length, unmappedProjectIds: unmatched, available: !!registry && !!execution, namespace: registry?.currentNamespace ?? null, issues } };
  }
  function status() {
    const s = state(), source = sources();
    const merged = new Map(source.nodes.map(n => {
      const overlay = s.nodes[n.id] ?? {}, sourceHash = hash(n);
      const sourceConflict = !!overlay._sourceHash && overlay._sourceHash !== sourceHash;
      const fieldOrigins = Object.fromEntries(mergeFields.filter(key => !['title', 'parentId'].includes(key)).map(key => [key, Object.hasOwn(overlay, key) ? 'annotation' : n[key] ? 'source' : 'unconfirmed']));
      return [n.id, { ...n, ...overlay, sourceHash, sourceConflict, fieldOrigins, ...(sourceConflict ? { sourceCurrent: n } : {}) }];
    }));
    for (const [id, n] of Object.entries(s.nodes)) if (!merged.has(id)) merged.set(id, n);
    const agents = source.agents.map(a => {
      const pending = s.queue.some(q => q.agentId === a.id && !terminal.has(q.state)) || source.registeredQueue.some(q => q.agentId === a.id && (q.pendingAttempt || /UNKNOWN|ACTIVE|ACCEPTED/.test(q.state)));
      const completed = a.complete && !pending && !a.choices.length;
      const reportRevision = hash(a);
      return { ...a, complete: completed, reportRevision, completionUnread: completed && s.reportSeen?.[a.id]?.revision !== reportRevision, pinned: s.pins[a.id] === true, archived: (completed || a.sourceArchived === true) && !pending && s.pins[a.id] !== true, resumeCommand: null, resumeReason: '닫힌 대화의 정상 종료·작성권 해제·실행 경로 결속 전입니다. 기존 터미널 선택기를 사용하세요.', muxCommand: a.muxSession ? `psmux -L ${a.muxNamespace} attach-session -t ${a.muxSession}` : null, muxOpenSupported: false, handoffSupported: source.registeredQueue.some(q => q.agentId === a.id), automaticDelivery: false, deliveryReason: '준비된 한 건은 별도 미리보기·확인으로 등록 sender에 요청합니다. 설치 helper와 fresh 작성권·경로·한도가 확인돼야 하며 자동 다음 실행은 하지 않습니다.' };
    });
    return { ok: true, schemaVersion: 1, revision: s.revision, observedAt: now(), sourceRevision: source.sourceRevision, coverage: source.coverage, nodes: [...merged.values()].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)), agents, editHistory: (s.editHistory ?? []).map(entry => ({ id: entry.id, action: entry.action, at: entry.at, undoneAt: entry.undoneAt ?? null, changes: entry.changes.map(c => ({ section: c.section, id: c.id, title: c.title })), undoSupported: !entry.undoneAt })), queue: s.queue, registeredQueue: source.registeredQueue, paused: s.paused, stopped: s.stopped, nativeGoal: { state: 'UNKNOWN', mutated: false }, automaticReplay: false };
  }
  function apply(s, input, view) {
    const node = id => view.nodes.find(n => n.id === id) ?? fail('dashboard_node_missing');
    const agent = id => view.agents.find(a => a.id === id) ?? fail('dashboard_agent_missing');
    switch (input.action) {
      case 'report-seen': {
        const a = agent(input.agentId);
        if (input.expectedReportRevision !== a.reportRevision) fail('dashboard_report_changed');
        if (!a.complete) fail('dashboard_report_not_completed');
        s.reportSeen ??= {}; s.reportSeen[a.id] = { revision: a.reportRevision, at: now() }; break;
      }
      case 'metadata-undo': {
        const entry = (s.editHistory ?? []).find(e => e.id === input.historyId);
        if (!entry || entry.undoneAt) fail('dashboard_undo_unavailable');
        // Compare only the touched metadata. Queue, attempts and current owner records
        // are never restored from previous snapshots, even after a disconnect.
        for (const c of entry.changes) {
          if (hash(s[c.section][c.id] ?? null) !== hash(c.after)) fail('dashboard_undo_conflict');
          if (c.section === 'pins') { agent(c.id); continue; }
          if ((view.nodes.find(n => n.id === c.id)?.sourceHash ?? null) !== c.sourceHash) fail('dashboard_undo_source_changed');
          if (c.before === null && c.sourceHash === null && (view.nodes.some(n => n.parentId === c.id) || s.queue.some(q => q.nodeId === c.id))) fail('dashboard_undo_referenced');
          if (c.before?.parentId && !view.nodes.some(n => n.id === c.before.parentId)) fail('dashboard_undo_conflict');
          // Undoing a move must not introduce a cycle after intervening edits.
          let cursor = c.before?.parentId;
          for (let depth = 0; cursor; depth++) {
            if (depth > 30 || cursor === c.id) fail('dashboard_parent_cycle');
            cursor = view.nodes.find(n => n.id === cursor)?.parentId;
          }
        }
        for (const c of entry.changes) {
          if (c.before === null) delete s[c.section][c.id];
          else s[c.section][c.id] = structuredClone(c.before);
        }
        entry.undoneAt = now(); break;
      }
      case 'pin': agent(input.agentId); if (typeof input.pinned !== 'boolean') fail('dashboard_input_invalid'); s.pins[input.agentId] = input.pinned; break;
      case 'node-merge': {
        const n = node(input.id);
        if (!n.sourceConflict || !n.sourceCurrent || input.expectedSourceHash !== n.sourceHash) fail('dashboard_merge_source_changed');
        if (!input.choices || typeof input.choices !== 'object' || Array.isArray(input.choices) || Object.keys(input.choices).length !== mergeFields.length || mergeFields.some(key => !['source', 'edited'].includes(input.choices[key]))) fail('dashboard_merge_choices_required');
        const values = Object.fromEntries(mergeFields.map(key => [key, (input.choices[key] === 'source' ? n.sourceCurrent : n)[key] ?? (key === 'parentId' ? null : '')]));
        // Reuse all hierarchy/title guards, then remove adopted overrides so future
        // owner updates flow through. No source file or queue is rewritten.
        apply(s, { action: 'node-save', id: n.id, ...values }, { ...view, nodes: view.nodes.map(row => row.id === n.id ? { ...row, sourceConflict: false } : row) });
        for (const key of mergeFields) if (input.choices[key] === 'source') delete s.nodes[n.id][key];
        s.nodes[n.id]._sourceHash = n.sourceHash;
        break;
      }
      case 'node-save': {
        const existing = input.id ? node(input.id) : null;
        if (existing?.sourceConflict) fail('dashboard_merge_required');
        const kind = existing?.kind ?? input.kind;
        if (!['group', 'project', 'feature'].includes(kind)) fail('dashboard_kind_invalid');
        const parentId = input.parentId ?? null;
        const parent = parentId ? node(parentId) : null;
        if ((kind === 'group' && parent) || (kind === 'project' && parent?.kind !== 'group') || (kind === 'feature' && !['project', 'feature'].includes(parent?.kind))) fail('dashboard_parent_invalid');
        let cursor = parent;
        for (let depth = 0; cursor; depth++) {
          if (depth > 30 || cursor.id === existing?.id) fail('dashboard_parent_cycle');
          cursor = cursor.parentId ? node(cursor.parentId) : null;
        }
        const title = text(input.title, 240).trim(); if (!title) fail('dashboard_title_required');
        const id = existing?.id ?? `local:${randomUUID()}`;
        const saved = { ...(s.nodes[id] ?? {}), id, kind, parentId, title, rank: existing?.rank ?? view.nodes.length, _sourceHash: existing?.sourceHash ?? null };
        for (const key of ['description', 'usage', 'options', 'defaults', 'impact', 'current', 'remaining']) saved[key] = text(input[key]);
        s.nodes[id] = saved; break;
      }
      case 'node-archive': {
        const n = node(input.id); if (typeof input.archived !== 'boolean') fail('dashboard_input_invalid');
        s.nodes[n.id] = { ...(s.nodes[n.id] ?? {}), archived: input.archived }; break;
      }
      case 'node-order': {
        const siblings = view.nodes.filter(n => n.parentId === input.parentId);
        if (!Array.isArray(input.ids) || new Set(input.ids).size !== siblings.length || input.ids.length !== siblings.length || siblings.some(n => !input.ids.includes(n.id))) fail('dashboard_order_invalid');
        input.ids.forEach((id, rank) => { s.nodes[id] = { ...(s.nodes[id] ?? {}), rank }; }); break;
      }
      case 'queue-add': case 'report-reply': {
        const a = agent(input.agentId); const instruction = instructionText(input.instruction);
        if (input.action === 'report-reply' && input.expectedReportRevision !== a.reportRevision) fail('dashboard_report_changed');
        if (s.queue.filter(q => !terminal.has(q.state)).length >= 200) fail('dashboard_queue_full');
        if (input.nodeId) node(input.nodeId);
        if (input.goalId && !read(path.join(owner, 'control-plane', 'master-goals.json'))?.goals?.some(g => g.id === input.goalId && !g.archived)) fail('dashboard_goal_missing');
        s.queue.push({ id: randomUUID(), agentId: input.agentId, instruction, nodeId: input.nodeId ?? null, goalId: text(input.goalId, 120) || null, state: 'UNSENT', createdAt: now(), automaticNext: false, attemptId: null, ...(input.action === 'report-reply' ? { origin: 'report-reply', reportRef: { agentId: a.id, revision: a.reportRevision, updatedAt: a.updatedAt } } : {}) }); break;
      }
      case 'queue-edit': case 'queue-cancel': {
        const q = s.queue.find(q => q.id === input.id) ?? fail('dashboard_queue_missing');
        if (q.state !== 'UNSENT' || q.attemptId) fail('dashboard_sent_item_locked');
        if (input.action === 'queue-cancel') q.state = 'CANCELLED';
        else q.instruction = instructionText(input.instruction); break;
      }
      case 'queue-prepare-next': {
        agent(input.agentId);
        const next = s.queue.find(q => q.agentId === input.agentId && !terminal.has(q.state));
        if (!next) fail('dashboard_next_instruction_missing');
        // Bind the displayed head; never skip a sent, UNKNOWN or unfinished item.
        if (next.id !== input.id) fail('dashboard_next_instruction_changed');
        if (next.state !== 'UNSENT' || next.attemptId) fail('dashboard_previous_instruction_pending');
        return apply(s, { ...input, action: 'queue-prepare', id: next.id }, view);
      }
      case 'queue-prepare': {
        const q = s.queue.find(q => q.id === input.id) ?? fail('dashboard_queue_missing');
        const a = agent(q.agentId);
        if (s.stopped || s.paused[q.agentId]) fail('dashboard_queue_paused');
        if (q.state !== 'UNSENT' || q.attemptId) fail('dashboard_sent_item_locked');
        if (s.queue.find(row => row.agentId === q.agentId && !terminal.has(row.state))?.id !== q.id) fail('dashboard_previous_instruction_pending');
        if (q.reportRef && q.reportRef.revision !== a.reportRevision) fail('dashboard_reply_report_changed');
        assertGoalReady(q);
        const registry = read(path.join(continuityRoot, 'registrations.json'));
        const binding = registry?.threads?.[q.agentId];
        if (!binding || registry.excludedThreadIds?.includes(q.agentId) || /ARCHIVED|MISSING|SCOPE|HOLD/.test(binding.state ?? '')) fail('dashboard_handoff_target_unavailable');
        if (binding.attempt || binding.queueAttempt) fail('dashboard_original_attempt_pending');
        if (fs.existsSync(path.join(requestRoot, `${q.id}.txt`)) || fs.existsSync(path.join(requestRoot, `${q.id}.json`))) fail('dashboard_existing_operation_preserved');
        q.attemptId = q.id; q.marker = `AICC_QUEUE_ATTEMPT:${q.id}`; q.messageSha256 = digestText(q.instruction.trim());
        q.state = 'HANDOFF_PENDING'; q.preparedAt = now(); q.readiness = 'UNVERIFIED_NOT_DISPATCHABLE';
        break;
      }
      case 'queue-reconcile': case 'queue-complete': {
        const q = s.queue.find(q => q.id === input.id) ?? fail('dashboard_queue_missing');
        if (terminal.has(q.state)) fail('dashboard_queue_already_terminal');
        const receipt = receiptFor(q);
        if (input.action === 'queue-reconcile') {
          if (receipt) {
            const observed = receiptState(receipt), order = { ACCEPTED: 1, RUNNING: 2, TURN_COMPLETED: 3, INTERRUPTED: 3 };
            if (order[observed] && order[observed] < (q.observedStage ?? order[q.state] ?? 0)) fail('dashboard_receipt_regression');
            if (q.turnId && receipt.turnId && q.turnId !== receipt.turnId) fail('dashboard_receipt_turn_mismatch');
            if (receipt.turnId && s.queue.some(other => other.id !== q.id && other.agentId === q.agentId && other.turnId === receipt.turnId)) fail('dashboard_receipt_turn_reused');
            const priorTerminal = q.terminalObservation ?? (['INTERRUPTED', 'TURN_COMPLETED'].includes(q.state) ? q.state : null);
            if (priorTerminal && observed !== priorTerminal) fail('dashboard_terminal_observation_preserved');
            if (['INTERRUPTED', 'TURN_COMPLETED'].includes(observed)) q.terminalObservation = observed;
            q.observedStage = Math.max(q.observedStage ?? order[q.state] ?? 0, order[observed] ?? 0);
            q.state = observed; q.receiptSha256 = hash(receipt); q.turnId = receipt.turnId ?? q.turnId ?? null; q.reconciledAt = now();
          }
        } else {
          if (input.expectedAttemptId !== q.attemptId || !receipt || receiptState(receipt) !== 'TURN_COMPLETED' || q.state !== 'TURN_COMPLETED' || q.receiptSha256 !== hash(receipt)) fail('dashboard_task_completion_unproven');
          const summary = text(input.summary, 800).trim(); if (!summary) fail('dashboard_completion_summary_required');
          q.state = 'COMPLETED'; q.completedAt = now(); q.completion = { source: 'owner-confirmation', summary, turnId: receipt.turnId, receiptSha256: hash(receipt), nativeGoalMutated: false };
        }
        break;
      }
      case 'queue-order': {
        agent(input.agentId);
        const rows = s.queue.filter(q => q.agentId === input.agentId && q.state === 'UNSENT' && !q.attemptId);
        if (!Array.isArray(input.ids) || new Set(input.ids).size !== rows.length || input.ids.length !== rows.length || rows.some(q => !input.ids.includes(q.id))) fail('dashboard_sent_item_locked');
        const ordered = input.ids.map(id => rows.find(q => q.id === id)); let index = 0;
        s.queue = s.queue.map(q => rows.includes(q) ? ordered[index++] : q); break;
      }
      case 'queue-pause': agent(input.agentId); if (typeof input.paused !== 'boolean') fail('dashboard_input_invalid'); s.paused[input.agentId] = input.paused; break;
      case 'queue-stop': if (typeof input.stopped !== 'boolean') fail('dashboard_input_invalid'); s.stopped = input.stopped; break;
      default: fail('dashboard_action_invalid');
    }
    return s;
  }
  function prepare(input) {
    if (!input || input.expectedRevision !== state().revision) fail('dashboard_revision_conflict');
    const view = status();
    // Validate without writing; generated IDs are deliberately allocated only at commit.
    apply(structuredClone(state()), input, view);
    const q = view.queue.find(q => q.id === input.id);
    const receipt = ['queue-reconcile', 'queue-complete'].includes(input.action) && q ? receiptFor(q) : null;
    const goalBinding = (input.goalId || q?.goalId) ? read(path.join(owner, 'control-plane', 'master-goals.json')) : null;
    const detail = [];
    if (input.action === 'node-merge') {
      const n = view.nodes.find(row => row.id === input.id);
      const labels = { title: '이름', parentId: '상위 항목', description: '할 수 있는 일', usage: '사용 예', options: '선택지', defaults: '기본값', impact: '영향', current: '현재 가능한 것', remaining: '남은 것' };
      for (const key of mergeFields) {
        const source = input.choices[key] === 'source', value = (source ? n.sourceCurrent : n)[key];
        detail.push(`${labels[key]} · ${source ? '현재 원문 채택' : '기존 화면 편집 유지'}: ${key === 'parentId' ? view.nodes.find(row => row.id === value)?.title ?? '없음' : value || '확인된 기록 없음'}`);
      }
      detail.push('원제품 원문과 큐는 변경하지 않습니다. 채택한 원문 항목은 이후 원장 변경을 따라 표시합니다.');
    }
    if (['report-seen', 'report-reply'].includes(input.action)) {
      const a = view.agents.find(a => a.id === input.agentId);
      detail.push(`원 보고: ${a.title}`, `보고 결론: ${a.summary}`, input.action === 'report-seen' ? '이 버전의 완료 보고를 확인했다고 기록합니다. 업무·목표 완료 상태는 변경하지 않습니다.' : '같은 exact 에이전트의 미전송 지시로만 저장합니다. 사용자 할 일을 완료 처리하거나 실제 전달하지 않습니다.');
    }
    if (input.action === 'metadata-undo') {
      const entry = state().editHistory.find(e => e.id === input.historyId);
      const describe = (change, value) => {
        if (change.section === 'pins') return value === true ? '핀 고정' : '핀 없음';
        if (value === null) return change.sourceHash ? '원제품 원문 표시' : '추가 항목 없음';
        const labels = { title: '이름', parentId: '상위 항목', rank: '표시 순서', archived: '보관', description: '할 수 있는 일', usage: '사용 예', options: '선택지', defaults: '기본값', impact: '영향', current: '현재 가능한 것', remaining: '남은 것' };
        return Object.entries(labels).filter(([key]) => value[key] !== undefined).map(([key, label]) => `${label}: ${key === 'parentId' ? view.nodes.find(n => n.id === value[key])?.title ?? value[key] ?? '없음' : value[key]}`).join('\n');
      };
      for (const change of entry.changes) detail.push(`되돌릴 항목: ${change.title}`, `현재 화면 기록:\n${describe(change, change.after)}`, `복원할 화면 기록:\n${describe(change, change.before)}`);
      detail.push('변경된 화면 기록만 복원합니다. 지시·전송 attempt·정지·목표·원제품 원문은 보존합니다.');
    }
    if (input.action === 'node-save') for (const key of ['title', 'parentId', 'description', 'usage', 'options', 'defaults', 'impact', 'current', 'remaining']) if (input[key]) detail.push(`${key}: ${text(input[key])}`);
    if (input.instruction || ['queue-prepare', 'queue-prepare-next'].includes(input.action)) detail.push(`exact 에이전트: ${input.agentId ?? q.agentId}`, `지시 내용:\n${input.instruction ?? q.instruction}`);
    if (input.action === 'queue-complete') detail.push(`직접 확인한 결과: ${text(input.summary, 800)}`);
    return { kind: 'dashboard', action: input.action, fingerprint: hash({ revision: view.revision, source: view.sourceRevision, input, receipt, goalBinding }), summary: [`동작: ${input.action}`, `대상: ${text(input.id ?? input.historyId ?? input.agentId ?? input.title ?? '전체 새 시작')}`, ['queue-prepare', 'queue-prepare-next'].includes(input.action) ? '기존 continuity 요청 폴더에 이 지시의 UTF-8 입력만 준비합니다. 실행기·모델·외부 호출은 하지 않습니다. 준비 후 지시와 순서는 잠깁니다.' : input.action === 'queue-complete' ? '확인한 지시 결과를 사용자 확인 완료로 기록합니다. turn 종료나 목표 전체 완료로 자동 추론하지 않습니다.' : '프로젝트 화면 기록·미전송 지시 또는 원 영수증 관측만 변경합니다. 실제 실행·발신·원본 삭제는 하지 않습니다.', ...detail, '직전 상태는 같은 원장의 previous 필드에 보관합니다.'] };
  }
  function commit(input, operationId) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Reject links before opening a cross-process single-writer lock.
    for (let current = directory;; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) fail('dashboard_symlink_denied');
      if (path.dirname(current) === current) break;
    }
    const lockFile = path.join(directory, 'workspace-state.lock');
    let lock; try { lock = fs.openSync(lockFile, 'wx', 0o600); } catch { fail('dashboard_writer_busy'); }
    try {
      const previous = state();
      if (previous.operations.includes(operationId)) return { revision: previous.revision, duplicate: true, dispatched: false };
      prepare(input);
      const view = status();
      const next = apply(structuredClone(previous), input, view);
      if (metadataActions.has(input.action)) {
        const changes = [];
        for (const section of ['nodes', 'pins']) for (const id of new Set([...Object.keys(previous[section]), ...Object.keys(next[section])])) {
          const before = previous[section][id] ?? null, after = next[section][id] ?? null;
          if (hash(before) === hash(after)) continue;
          const target = section === 'nodes' ? view.nodes.find(n => n.id === id) : view.agents.find(a => a.id === id);
          changes.push({ section, id, title: text(after?.title ?? target?.title ?? id, 240), sourceHash: target?.sourceHash ?? null, before, after: structuredClone(after) });
        }
        if (changes.length) next.editHistory = [...(previous.editHistory ?? []), { id: randomUUID(), action: input.action, at: now(), changes }].slice(-60);
      }
      const { previous: ignored, ...preimage } = previous;
      next.previous = preimage; next.revision++; next.updatedAt = now();
      next.operations = [...previous.operations, operationId].slice(-100);
      next.lastChange = { action: input.action, operationId, at: next.updatedAt };
      atomic(file, next);
      if (['queue-prepare', 'queue-prepare-next'].includes(input.action)) {
        const q = next.queue.find(q => q.id === input.id);
        try { stageMessage(q); q.state = 'HANDOFF_READY'; }
        catch (error) { q.state = 'UNKNOWN'; q.stageError = 'local_input_preparation_uncertain'; atomic(file, next); throw error; }
        atomic(file, next);
      }
      if (state().revision !== next.revision) fail('dashboard_poststate_mismatch');
      return { revision: next.revision, dispatched: false, automaticReplay: false };
    } finally { fs.closeSync(lock); fs.unlinkSync(lockFile); }
  }
  async function withHandoff(input, expectedFingerprint, consume) {
    const lockFile = path.join(directory, 'workspace-state.lock');
    let lock; try { lock = fs.openSync(lockFile, 'wx', 0o600); } catch { fail('dashboard_writer_busy'); }
    try {
      const intent = inspectHandoff(input);
      if (intent.fingerprint !== expectedFingerprint) fail('dashboard_revision_conflict');
      return await consume(intent);
    } finally { fs.closeSync(lock); fs.unlinkSync(lockFile); }
  }
  return { status, prepare, commit, inspectHandoff, withHandoff };
}
