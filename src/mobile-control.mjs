import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createMobileDeviceTrust } from './mobile-device-trust.mjs';
import { createGoalLedgerService } from './goals/service.mjs';
import { createDashboardWorkspace } from './dashboard-workspace.mjs';
import { readMobileAppCatalog } from './mobile-app-catalog.mjs';
import { readPortfolioOverview } from './portfolio-overview.mjs';
import { createDashboardTerminal } from './dashboard-terminal.mjs';
import { createDashboardQueuePreflight } from './dashboard-queue-preflight.mjs';
import { createDashboardQueueSender } from './dashboard-queue-sender.mjs';
import { readManagementOverview, readMobilePublicStopSupportAsync } from './management-overview.mjs';
import { readDurableEvidenceHistory, readMobileOrchestration, readMobileWorkActivity } from './jobs/status.mjs';
import { createMobileTrayTools } from './mobile-tray-tools.mjs';
import { createOcxQuotaDashboard, validateOcxQuotaPolicy } from './ocx-quota-dashboard.mjs';
import { readPendingWorkSummary } from './control-plane/pending-work-status.mjs';

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const cookieName = 'aicc_mobile';
const sha = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
const clean = (value, max = 180) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : null;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const loopback = ip => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
// Registration is not a live sender, quota admission, ACK or resumed turn.
// Project only fixed codes: the registry contains private prompts and paths.
export function projectCliContinuityRuntime(cfg) {
  const base = { state: 'UNKNOWN', automaticDeliveryVerified: false,
    pendingDeliveries: null, maintenanceStopped: null, automaticReplay: false };
  if (cfg?.schemaVersion !== 1 || cfg.protocolVersion !== 3 || !cfg.threads ||
      typeof cfg.threads !== 'object' || Array.isArray(cfg.threads) ||
      Object.keys(cfg.threads).length > 10000 ||
      Object.values(cfg.threads).some(t => !t || typeof t !== 'object' || Array.isArray(t))) return base;
  const pendingDeliveries = Object.values(cfg.threads).filter(t => t.attempt != null || t.queueAttempt != null).length;
  const maintenanceStopped = !!cfg.workerStopRequestedAt || cfg.worker?.state === 'STOPPED_FOR_MAINTENANCE';
  return { ...base, state: maintenanceStopped ? 'STOPPED_FOR_MAINTENANCE' :
    pendingDeliveries ? 'PENDING_DELIVERY_RECONCILIATION' : 'ORIGINAL_ISSUER_SUPPORT_UNPROVEN',
    pendingDeliveries, maintenanceStopped };
}
const inside = (root, file) => { const r = path.relative(root, file); return r && !r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r); };
function regular(file, max = 4 * 1024 * 1024) {
  for (let p = path.resolve(file);; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail('linked_owner_path');
    if (p === path.dirname(p)) break;
  }
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.nlink !== 1 || s.size > max) fail('owner_file_invalid');
  return file;
}
function read(file) { return JSON.parse(fs.readFileSync(regular(file), 'utf8').replace(/^\uFEFF/, '')); }
function hashFile(file) { return sha(fs.readFileSync(regular(file, 256 * 1024 * 1024))); }
function atomic(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, file);
}
function send(res, status, value, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) fail('json_required');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 65536) fail('request_too_large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('json_invalid'); }
}
function exactKeys(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !keys.includes(k))) fail('unsupported_fields');
}
function run(executable, args) {
  // A timeout is an uncertain outcome, never evidence that the child did not run.
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0, output = [], ended = false, overflow = false;
    const timer = setTimeout(() => finish('helper_outcome_unknown'), 45000);
    function finish(code, value) { if (ended) return; ended = true; clearTimeout(timer); code ? reject(Object.assign(new Error(code), { code })) : resolve(value); }
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes <= 2097152) output.push(chunk); else overflow = true; });
    child.stderr.on('data', () => {}); // Never expose script output or secret-bearing exceptions.
    child.once('error', () => finish('helper_start_unknown'));
    child.once('close', code => {
      if (code !== 0 || overflow) return finish('helper_result_unknown');
      try { finish(null, JSON.parse(Buffer.concat(output).toString('utf8').replace(/^\uFEFF/, ''))); }
      catch { finish('helper_result_unknown'); }
    });
  });
}

export function createMobileControl(options = {}) {
  const owner = path.resolve(options.ownerRoot ?? process.env.AICC_STATE_ROOT ?? path.join(os.homedir(), '.ai-control-center'));
  const localConfig = path.join(owner, 'control-plane', 'mobile-control.json');
  const configured = options.remoteOrigin ?? process.env.AICC_MOBILE_ORIGIN ?? (fs.existsSync(localConfig) ? read(localConfig).remoteOrigin : null);
  let remoteOrigin = null;
  if (configured) {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || parsed.origin !== configured) fail('mobile_origin_invalid');
    remoteOrigin = parsed.origin;
  }
  const devices = remoteOrigin ? createMobileDeviceTrust(owner, remoteOrigin) : null;
  const pairs = new Map(), sessions = new Map(), previews = new Map();
  const requests = path.join(owner, 'status-tray', 'requests');
  const registryFile = path.join(owner, 'control-plane', 'codex-continuity', 'registrations.json');
  let mutationBusy = false, statePending = null, trayPending = null, activeApiRequests = 0, maintenanceDraining = false;
  function directory() {
    for (let p = requests;; p = path.dirname(p)) { if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail('linked_owner_path'); if (p === path.dirname(p)) break; }
    fs.mkdirSync(requests, { recursive: true, mode: 0o700 });
  }
  function helperPin() {
    const cfg = read(registryFile), file = path.resolve(cfg.helperPath ?? '');
    if (cfg.schemaVersion !== 1 || cfg.protocolVersion !== 3 || !SHA.test(cfg.helperSha256 ?? '') || !inside(path.join(owner, 'releases', 'codex-continuity'), file) || hashFile(file) !== cfg.helperSha256) fail('continuity_pin_mismatch');
    const executable = path.join(os.homedir(), '.ai-control-center', 'toolchain', 'pwsh-7.6.6', 'runtime', 'pwsh.exe');
    regular(executable, 256 * 1024 * 1024);
    return { file, executable, sha256: cfg.helperSha256 };
  }
  async function helper(action, threadId, terminalSha256) {
    const pin = helperPin();
    if (!['Status','Candidates','Register','Enable','Disable','Resume','Complete'].includes(action) || (threadId && !UUID.test(threadId)) || (terminalSha256 && !SHA.test(terminalSha256))) fail('helper_arguments_invalid');
    const quote = text => "'" + text.replaceAll("'", "''") + "'";
    const command = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);& " + quote(pin.file) + ' -Action ' + quote(action)
      + ' -StateRoot ' + quote(path.dirname(registryFile)) + (threadId ? ' -ThreadId ' + quote(threadId) : '') + (terminalSha256 ? ' -ExpectedTerminalSha256 ' + quote(terminalSha256) : '');
    return run(pin.executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
  }
  async function continuity() {
    if (statePending) return statePending;
    const pending = (async () => {
      const pin = helperPin();
      const registryBytes = fs.readFileSync(regular(registryFile));
      const registrySha256 = sha(registryBytes), registry = JSON.parse(registryBytes.toString('utf8').replace(/^\uFEFF/, ''));
      const status = await helper('Status'), candidates = await helper('Candidates');
      if (helperPin().sha256 !== pin.sha256 || status.protocolMatch !== true ||
          hashFile(registryFile) !== registrySha256) fail('continuity_pin_mismatch');
      const registered = new Map((status.threads ?? []).map(t => [t.threadId, t]));
      const rows = (candidates.candidates ?? []).filter(t => UUID.test(t.threadId ?? '')).map(t => {
        const r = registered.get(t.threadId); const x = r ?? t;
        // Older installed helpers lack progress. Unknown stages must remain unknown.
        const p = x.executionSurface === 'desktop' ? x.progress : null;
        const progress = x.executionSurface === 'desktop' ? {
          source: p ? 'installed-helper' : 'installed-helper-without-stage-evidence',
          reason: clean(p?.reason, 80) ?? (!x.enabled ? 'SELECTION_DISABLED' : x.holdReason ? 'USER_ACTION_HOLD' : x.attempt ? 'DELIVERY_UNCERTAIN_NO_REPLAY' : 'OFFICIAL_SENDER_REQUIRED'),
          dispatchable: false, localWorkerCanInvoke: false, automaticReplay: false,
          queueRegistered: !!r, selected: x.enabled === true,
          quota: { state: clean(p?.quota?.state, 40) ?? 'UNKNOWN', observedAt: clean(p?.quota?.observedAt), scope: 'ocx-pool-only', targetRoute: p?.quota?.targetRoute === 'RECORDED_OCX_AT_CLAIM' ? 'RECORDED_OCX_AT_CLAIM' : 'UNPROVEN', targetRouteObservedAt: clean(p?.quota?.targetRouteObservedAt), currentTargetRouteReady: false },
          claim: { state: clean(p?.claim?.state, 40) ?? 'UNKNOWN', attemptId: UUID.test(p?.claim?.attemptId ?? '') ? p.claim.attemptId : null },
          deliveryAck: { state: clean(p?.deliveryAck?.state, 40) ?? 'UNKNOWN', at: clean(p?.deliveryAck?.at) },
          newTurn: { state: clean(p?.newTurn?.state, 40) ?? 'UNKNOWN', turnStatus: clean(p?.newTurn?.turnStatus, 40), observedAt: clean(p?.newTurn?.observedAt) },
          goal: { state: 'UNKNOWN', source: 'codex-goal-not-read', queueTrackingComplete: x.state === 'COMPLETE' }
        } : null;
        return { threadId: t.threadId, title: clean(t.title ?? x.title, 110), registered: !!r, enabled: x.enabled === true,
          executionSurface: ['cli', 'desktop'].includes(x.executionSurface) ? x.executionSurface : 'unknown', state: clean(x.state, 80), holdReason: clean(x.holdReason, 80),
          terminalSha256: SHA.test(x.terminalSha256 ?? '') ? x.terminalSha256 : null, pendingAttempt: x.attempt != null || x.queueAttempt != null,
          nextCheckAt: clean(x.nextCheckAt), nextResetAt: clean(x.nextResetAt), observedAt: clean(x.observedAt),
          progress, desktopDelivery: x.executionSurface === 'desktop' ? 'AGENT_TOOL_HANDOFF_ONLY_LOCAL_DISPATCH_UNAVAILABLE' : null };
      });
      return { rows, helperSha256: pin.sha256, protocolMatch: true, worker: { state: clean(status.worker?.state, 80), heartbeatAt: clean(status.worker?.heartbeatAt) },
        desktopAutomaticDelivery: false,
        desktopAgentDelivery: { transport: 'codex-app.send_message_to_thread', availability: 'authorized-agent-tool-context', localWorkerCanInvoke: false, claimRequired: true, automaticReplay: false },
        desktopReason: '승인된 에이전트는 공식 도구로 기존 Desktop 대화에 전달할 수 있습니다. 로컬 감시기는 이 도구를 무인 호출하지 못하므로 한도 회복만으로 자동 재개되지는 않습니다.',
        cliAutomaticDelivery: false, cliRuntime: projectCliContinuityRuntime(registry),
        nativeFallback: false, recurringAutomationCreated: false };
    })();
    statePending = pending; try { return await pending; } finally { if (statePending === pending) statePending = null; }
  }
  function trayPin() {
    if (owner !== path.resolve(process.env.AICC_STATE_ROOT ?? path.join(os.homedir(), '.ai-control-center'))) fail('tray_owner_root_mismatch');
    const cfg = read(path.join(owner, 'runtime', 'components.json')), entry = cfg.components?.tray;
    if (!entry?.releaseRoot || !entry.sourceHashes) fail('tray_not_installed');
    const root = path.resolve(entry.releaseRoot);
    if (!inside(path.join(owner, 'releases', 'tray'), root)) fail('tray_pin_mismatch');
    for (const [name, expected] of Object.entries(entry.sourceHashes)) {
      const file = path.resolve(root, name);
      if (!inside(root, file) || !SHA.test(expected) || hashFile(file) !== expected) fail('tray_pin_mismatch');
    }
    for (const name of ['tools/platform/windows/tray-status.mjs', 'tools/platform/windows/tray-control.mjs']) if (!entry.sourceHashes[name]) fail('tray_pin_mismatch');
    return { root, identity: sha(JSON.stringify(entry.sourceHashes)) };
  }
  async function tray(refresh = false) {
    if (trayPending) return trayPending;
    const pending = (async () => {
      const pin = trayPin();
      const module = await import('../tools/platform/windows/tray-status.mjs');
      const value = await module.collectTrayAccountStatus({ refresh });
      if (trayPin().identity !== pin.identity) fail('tray_pin_mismatch');
      return { sourcePin: pin.identity, observedAt: value.observedAt, quotaStatus: clean(value.quotaStatus, 250), quotaFresh: value.quotaFresh === true,
        quotaReadFailed: value.quotaReadFailed === true, quotaAgeSeconds: value.quotaAgeSeconds ?? null, controlNeedsReconcile: value.controlNeedsReconcile === true,
        selectionVerified: value.selectionVerified === true, effectivePolicy: value.effectivePolicy ? Object.fromEntries(['fiveHourUsedThreshold', 'longWindowUsedThreshold', 'fiveHourAction', 'longWindowAction', 'strictAdmission', 'freshQuotaRequired'].map(k => [k, value.effectivePolicy[k] ?? null])) : null,
        diagnosticsScope: value.diagnosticsScope, connections: { workspace: value.aiccReady, ocx: value.ocxReady, web: value.webReady },
        accounts: (value.accounts ?? []).map(a => Object.fromEntries(['name','selector','identityHash','active','paused','priority','status','shortRemaining','longRemaining','shortReset','longReset','shortResetAt','longResetAt','resetTimeSource','quotaObservedAt','quotaAgeSeconds','fresh','needsReauth','quotaError','longLabel','resetCredits','displayNameVerified'].map(k => [k, a[k] ?? null]))) };
    })();
    trayPending = pending; try { return await pending; } finally { if (trayPending === pending) trayPending = null; }
  }
  const trayTools = options.trayTools ?? createMobileTrayTools({ ownerRoot: owner });
  const dashboard = options.dashboard ?? createDashboardWorkspace({ ownerRoot: owner, ...options.dashboardOptions });
  const terminalPicker = options.terminalPicker ?? createDashboardTerminal({ ownerRoot: owner, runner: run });
  const queuePreflight = options.queuePreflight ?? createDashboardQueuePreflight({ ownerRoot: owner, dashboard, runner: run });
  const queueSender = options.queueSender ?? createDashboardQueueSender({ ownerRoot: owner, dashboard, queuePreflight, runner: run });
  let fallbackGoalService;
  const goalLedger = options.goalLedger ?? (() => ({ status() {
    const value = (fallbackGoalService ??= createGoalLedgerService({ ownerRoot: owner })).status();
    // Earlier installed servers do not inject the ledger or its later contract marker.
    if (value?.ok !== true || !Array.isArray(value.goals)) fail('goal_ledger_unavailable');
    return { ...value, ledgerKind: 'aicc-tracked-goals' };
  }, prepareEdit(input) { return (fallbackGoalService ??= createGoalLedgerService({ ownerRoot: owner })).prepareEdit(input); }, commitEdit(input, operationId) { return (fallbackGoalService ??= createGoalLedgerService({ ownerRoot: owner })).commitEdit(input, operationId); } }));
  const quotaDashboard = options.quotaDashboard ?? createOcxQuotaDashboard({ ownerRoot: owner, collectTray: ({ refresh = false } = {}) => tray(refresh) });
  function webStatus() {
    const value = options.webConfig().status();
    return { revision: value.revision, config: { schemaVersion: 1, enabled: value.config.enabled, intervalSeconds: value.config.intervalSeconds,
      targets: value.config.targets.map(t => ({ id: t.id, enabled: t.enabled, role: t.role, conversationUrl: t.conversationUrl, autoResume: t.autoResume, autoResumeMode: t.autoResumeMode ?? 'response-only', hasExternalReceipt: !!t.externalStateFile })),
      peerGrants: (value.config.peerGrants ?? []).map(g => ({ id: g.id, enabled: g.enabled, sourceTargetId: g.source.targetId, recipientIds: g.recipients.map(r => r.targetId), purpose: g.purpose, templateText: g.template.text, inputFields: g.inputFields, expiresAt: g.expiresAt, revision: g.revision })) },
      roles: value.roles.map(r => ({ role: r.role, available: r.available })), runner: { liveStatus: value.runner.liveStatus, reportedState: value.runner.reportedState ?? null, receiptFresh: value.runner.receiptFresh, processLivenessVerified: value.runner.processLivenessVerified, installationVerified: value.runner.installationVerified, peerDispatchSupported: value.runner.peerDispatchSupported }, capabilities: value.capabilities };
  }
  function unresolved() {
    if (!fs.existsSync(requests)) return [];
    return fs.readdirSync(requests).filter(n => /^mobile-[a-f0-9]{32}\.json$/.test(n)).map(n => read(path.join(requests, n))).filter(r => ['DISPATCHING','UNKNOWN'].includes(r.state)).map(r => ({ operationId: r.operationId, kind: r.kind, state: r.state, completed: r.completed ?? [], automaticReplay: false }));
  }
  const sessionExpiry = session => (session.trusted || !session.remote) ? null : new Date(session.expires).toISOString();
  const sessionMaximum = session => (session.trusted || !session.remote) ? null : new Date(session.maximum).toISOString();
  function cookie(sid, session) { return `${cookieName}=${sid}; Path=/api/mobile/; HttpOnly; SameSite=Strict; Max-Age=${(session.trusted || !session.remote) ? 34560000 : Math.max(0, Math.floor((session.expires - Date.now()) / 1000))}${session.remote ? '; Secure' : ''}`; }
  function newSession(remote, remember = false, deviceName = '') {
    const now = Date.now(), sid = token(), trusted = remote && remember, permanent = trusted || !remote;
    const device = trusted ? devices.issue(sid, deviceName) : null;
    const session = { id: sid, remote, csrf: token(), expires: permanent ? Infinity : now + 900000, maximum: permanent ? Infinity : now + 7200000, remember: permanent, trusted, deviceId: device?.id ?? null };
    sessions.set(sid, session); return session;
  }
  function reap() {
    const now = Date.now();
    for (const [k, v] of pairs) if (v.expires <= now) pairs.delete(k);
    for (const [k, v] of sessions) if (v.expires <= now) sessions.delete(k);
    for (const [k, v] of previews) if (v.expires <= now) previews.delete(k);
  }
  async function trackedGoals() {
    let snapshot;
    try {
      snapshot = await goalLedger().status();
      if (snapshot?.ok === true && !snapshot.ledgerKind && Array.isArray(snapshot.goals)) snapshot = { ...snapshot, ledgerKind: 'aicc-tracked-goals' };
      if (snapshot?.ok !== true || snapshot.ledgerKind !== 'aicc-tracked-goals' || !Array.isArray(snapshot.goals)) fail('goal_ledger_unavailable');
    } catch { fail('goal_ledger_unavailable'); }
    const statuses = ['ACTIVE', 'HOLD', 'REVIEW_READY', 'USER_MANAGED_READY', 'COMPLETE', 'UNASSIGNED'];
    const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
    const goals = snapshot.goals.slice(0, 200).map(goal => ({
      id: clean(goal?.id, 120), title: clean(goal?.title, 240),
      status: statuses.includes(goal?.status) ? goal.status : 'UNKNOWN',
      checked: goal?.checked === true, checkedAt: timestamp(goal?.checkedAt),
      description: typeof goal?.description === 'string' ? goal.description.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, 2000) : null,
      dependsOn: Array.isArray(goal?.dependsOn) ? goal.dependsOn.slice(0, 100).map(id => clean(id, 120)) : [], archived: goal?.archived === true
    }));
    return {
      ok: true, ledgerKind: 'aicc-tracked-goals', readOnly: !(snapshot.metadataEditingSupported === true && typeof goalLedger().prepareEdit === 'function' && typeof goalLedger().commitEdit === 'function'),
      sourceRevision: SHA.test(snapshot.sourceRevision ?? '') ? snapshot.sourceRevision : null,
      observedAt: new Date().toISOString(), sourceUpdatedAt: timestamp(snapshot.sourceUpdatedAt), viewUpdatedAt: timestamp(snapshot.viewUpdatedAt),
      nativeCodexGoal: { state: 'UNKNOWN', read: false, mutated: false },
      checkedMeaning: 'owner-check-only-not-goal-completion',
      summary: {
        goalCount: snapshot.goals.length, shownCount: goals.length, truncated: snapshot.goals.length > goals.length,
        checkedCount: snapshot.goals.filter(goal => goal?.checked === true).length,
        completedCount: snapshot.goals.filter(goal => goal?.status === 'COMPLETE').length,
        byStatus: Object.fromEntries(statuses.map(status => [status, snapshot.goals.filter(goal => goal?.status === status).length]))
      }, goals
    };
  }
  function sessionFor(req, remote, mutate) {
    const sid = String(req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    let session = sessions.get(sid);
    const device = remote ? devices.lookup(sid) : null;
    if (session?.trusted && (!device || device.id !== session.deviceId)) { sessions.delete(sid); fail('pair_required'); }
    if (!session && device) {
      session = { id: sid, remote: true, csrf: token(), expires: Infinity, maximum: Infinity, remember: true, trusted: true, deviceId: device.id };
      sessions.set(sid, session);
    }
    if (!session || session.remote !== remote || session.expires <= Date.now()) fail('pair_required');
    if (mutate && req.headers['x-aicc-csrf'] !== session.csrf) fail('csrf_required');
    if (!session.remember) session.expires = Math.min(session.maximum, Date.now() + 900000);
    return session;
  }
  async function prepare(input) {
    exactKeys(input, ['kind','action','targets','selector','identityHash','priority','config']);
    const pending = unresolved();
    const isReconcile = input.kind === 'tray-tool' && ['reconcile','rdc-reconcile'].includes(input.config?.action);
    // Metadata-only dashboard edits have no external sender. Preserve unrelated UNKNOWNs.
    if (pending.length && !isReconcile && !['dashboard', 'goal', 'queue-send'].includes(input.kind)) fail('previous_outcome_unknown');
    if (pending.length && isReconcile) {
      const matching = pending.some(row => {
        const prior = read(path.join(requests, `mobile-${row.operationId}.json`));
        return prior.kind === 'tray-tool' && (input.config.action === 'reconcile'
          ? prior.toolResult?.originalRequestId && prior.toolResult.originalRequestId === input.config.requestId
          : prior.toolResult?.originalOperationId && prior.toolResult.originalOperationId === input.config.operationRef);
      });
      if (!matching) fail('previous_outcome_unknown');
    }
    if (input.kind === 'dashboard') return dashboard.prepare(input.config);
    if (input.kind === 'queue-send') return queueSender.prepare(input.config);
    if (input.kind === 'terminal') {
      const agent = dashboard.status().agents.find(row => row.id === input.config?.agentId);
      if (!agent || agent.reportRevision !== input.config.expectedReportRevision) fail('dashboard_report_changed');
      const prepared = await terminalPicker.prepare(input.config);
      return { kind: 'terminal', fingerprint: sha(JSON.stringify({ terminal: prepared.fingerprint, report: agent.reportRevision })), summary: prepared.summary };
    }
    if (input.kind === 'goal') {
      if (typeof goalLedger().prepareEdit !== 'function' || typeof goalLedger().commitEdit !== 'function') fail('goal_edit_unavailable');
      return goalLedger().prepareEdit(input.config);
    }
    if (input.kind === 'user-action') {
      exactKeys(input.config, ['action','agentId','expectedReportRevision','id','expectedActionRevision','evidence']);
      if (input.config.action !== 'user-action-complete' || typeof goalLedger().prepareUserActionComplete !== 'function' || typeof goalLedger().completeUserAction !== 'function') fail('user_action_edit_unavailable');
      const agent = dashboard.status().agents.find(row => row.id === input.config.agentId);
      if (!agent || agent.reportRevision !== input.config.expectedReportRevision) fail('dashboard_report_changed');
      if (!agent.userActions?.some(row => row.id === input.config.id && row.revision === input.config.expectedActionRevision)) fail('user_action_report_binding_changed');
      const prepared = goalLedger().prepareUserActionComplete(input.config);
      return { ...prepared, kind: input.kind, fingerprint: sha(JSON.stringify({ action: prepared.fingerprint, agentId: agent.id, reportRevision: agent.reportRevision })), summary: [`보고 대상: ${agent.title} · ${agent.id}`, ...prepared.summary] };
    }
    if (input.kind === 'continuity') {
      if (!['Register','Enable','Disable','Resume','Complete'].includes(input.action) || !Array.isArray(input.targets) || !input.targets.length || input.targets.length > 20) fail('selection_required');
      const current = await continuity(), ids = new Set();
      const selected = input.targets.map(t => {
        exactKeys(t, ['threadId','terminalSha256']);
        if (!UUID.test(t.threadId ?? '') || ids.has(t.threadId)) fail('exact_selection_required'); ids.add(t.threadId);
        const row = current.rows.find(r => r.threadId === t.threadId); if (!row) fail('exact_selection_required');
        if (input.action === 'Register' ? row.registered : !row.registered) fail('registration_state_changed');
        if (['Enable','Resume','Complete'].includes(input.action) && row.pendingAttempt) fail('pending_delivery_preserved');
        if (input.action === 'Resume' && (!row.holdReason || !SHA.test(t.terminalSha256 ?? '') || t.terminalSha256 !== row.terminalSha256)) fail('displayed_terminal_changed');
        return { ...row, expectedTerminalSha256: input.action === 'Resume' ? t.terminalSha256 : null };
      });
      const stable = selected.map(r => ({ threadId: r.threadId, registered: r.registered, enabled: r.enabled, state: r.state, terminalSha256: r.terminalSha256, pendingAttempt: r.pendingAttempt, executionSurface: r.executionSurface }));
      return { kind: input.kind, action: input.action, targets: selected, fingerprint: sha(JSON.stringify({ helper: current.helperSha256, stable })), summary: [...selected.map(r => `${r.title} · ${r.threadId} · ${input.action}${r.executionSurface === 'desktop' ? ' (Desktop 큐 선택 · 로컬 무인 전달 미연결)' : ''}`), ...(input.action === 'Complete' ? ['이 동작은 큐 추적을 종료합니다. Codex 내장 goal과 전체 업무 완료 상태는 바꾸지 않습니다.'] : [])] };
    }
    if (input.kind === 'account') {
      if (!['use','pause','resume','priority','unpin'].includes(input.action) || !/^[A-Za-z0-9._-]{1,64}$/.test(input.selector ?? '') || !SHA.test(input.identityHash ?? '')) fail('account_action_invalid');
      if (input.action === 'priority' && (!Number.isInteger(input.priority) || input.priority < -100 || input.priority > 100)) fail('priority_invalid');
      const current = await tray(), row = current.accounts.find(a => a.selector === input.selector && a.identityHash === input.identityHash);
      if (!row || !current.selectionVerified || current.controlNeedsReconcile) fail('account_identity_unconfirmed');
      if (input.action === 'use' && (row.paused || ['한도 차단','로그인 필요','확인 필요','선택 미확인'].includes(row.status))) fail('account_not_admitted');
      const request = { action: input.action, selector: row.selector, identityHash: row.identityHash, ...(input.action === 'priority' ? { priority: input.priority } : {}) };
      return { kind: input.kind, request, fingerprint: sha(JSON.stringify({ source: current.sourcePin, identity: row.identityHash, active: row.active, paused: row.paused, priority: row.priority })), summary: [`${row.name} · ${row.selector} · ${input.action}${input.action === 'priority' ? ' ' + input.priority : ''}`, '이미 실행 중인 요청과 로그인은 유지됩니다.'] };
    }
    if (input.kind === 'quota-policy') {
      const request = validateOcxQuotaPolicy(input.config);
      const current = await tray();
      if (current.controlNeedsReconcile || !current.effectivePolicy) fail('account_identity_unconfirmed');
      return { kind: input.kind, request, fingerprint: sha(JSON.stringify({ source: current.sourcePin, policy: current.effectivePolicy, request })), summary: [`5시간 사용률 ${request.shortThreshold}% · ${request.shortAction === 'stop' ? '새 요청 중지' : '다른 계정 전환'}`, `주간 사용률 ${request.longThreshold}% · ${request.longAction === 'stop' ? '새 요청 중지' : '다른 계정 전환'}`, '사전 경고 잔여 비율과 별개이며 기존 트레이 실행기로 한 번 적용합니다.'] };
    }
    if (input.kind === 'quota-warning') {
      exactKeys(input.config, ['expectedRevision', 'settings']);
      const prepared = await quotaDashboard.prepareWarnings(input.config);
      return { ...prepared, kind: input.kind };
    }
    if (input.kind === 'account-order') {
      exactKeys(input.config, ['order']);
      const current = await tray(), order = input.config.order;
      if (!current.selectionVerified || current.controlNeedsReconcile || !Array.isArray(order) || !order.length || order.length > 16) fail('account_identity_unconfirmed');
      const eligible = current.accounts.filter(a => a.selector !== 'main' && SHA.test(a.identityHash ?? ''));
      const seen = new Set();
      if (order.length !== eligible.length || order.some(a => { exactKeys(a, ['selector','identityHash']); const key = a.selector + ':' + a.identityHash; if (seen.has(key) || !eligible.some(b => a.selector === b.selector && a.identityHash === b.identityHash)) return true; seen.add(key); return false; })) fail('account_identity_unconfirmed');
      const request = { action: 'order', order: order.map(a => ({ selector: a.selector, identityHash: a.identityHash })) };
      return { kind: input.kind, request, fingerprint: sha(JSON.stringify({ pin: current.sourcePin, previous: eligible.map(a => [a.identityHash,a.priority]), request })), summary: order.map((a,i) => `${i+1}. ${eligible.find(b => b.identityHash === a.identityHash).name} · 우선순위 ${order.length-i}`) };
    }
    if (input.kind === 'tray-tool') {
      exactKeys(input, ['kind', 'config']);
      const prepared = await trayTools.prepare(input.config);
      if (prepared.localOnly) fail('tray_tool_local_only');
      return { ...prepared, kind: input.kind };
    }
    if (input.kind === 'web') {
      exactKeys(input.config, ['schemaVersion','expectedRevision','enabled','intervalSeconds','targets','peerGrants']);
      const current = webStatus();
      if (input.config.expectedRevision !== current.revision || input.config.schemaVersion !== 1 || typeof input.config.enabled !== 'boolean' || !Array.isArray(input.config.targets) || input.config.targets.length > 32 || !Array.isArray(input.config.peerGrants) || input.config.peerGrants.length > 16) fail('web_revision_changed');
      for (const t of input.config.targets) exactKeys(t, ['id','enabled','role','conversationUrl','autoResume','autoResumeMode']);
      for (const g of input.config.peerGrants) exactKeys(g, ['id','enabled','sourceTargetId','recipientIds','purpose','templateText','inputFields','expiresAt']);
      if (input.config.peerGrants.some(g => g.enabled) && !current.runner.peerDispatchSupported) fail('peer_not_installed');
      const value = structuredClone(input.config), old = options.webConfig().status();
      for (const target of value.targets) {
        const original = old.config.targets.find(t => t.id === target.id && t.role === target.role && t.conversationUrl === target.conversationUrl);
        if (original?.externalStateFile) { target.externalStateFile = original.externalStateFile; target.externalStateSha256 = original.externalStateSha256; }
      }
      options.webConfig().preview(value);
      return { kind: input.kind, config: input.config, fingerprint: current.revision, summary: [`전체 ${input.config.enabled ? '켜기' : '끄기'} · 선택 대화 ${input.config.targets.length}개 · 별도 전달 승인 ${input.config.peerGrants.length}개`, '응답만 재개는 외부 작업 결과를 UNKNOWN으로 유지합니다. 전달 승인은 선택한 틀과 수신 범위에만 적용됩니다.'] };
    }
    fail('action_not_supported');
  }
  async function execute(preview, file, receipt) {
    if (preview.kind === 'queue-send') {
      receipt.queueResult = await queueSender.execute(preview.input.config, preview);
      receipt.state = receipt.queueResult.stage === 'UNKNOWN' ? 'UNKNOWN' : 'COMPLETED';
      receipt.completedAt = new Date().toISOString(); atomic(file, receipt); return;
    } else if (preview.kind === 'dashboard') {
      receipt.dashboardResult = dashboard.commit(preview.input.config, receipt.operationId);
    } else if (preview.kind === 'terminal') {
      const agent = dashboard.status().agents.find(row => row.id === preview.input.config.agentId);
      if (!agent || agent.reportRevision !== preview.input.config.expectedReportRevision) fail('dashboard_report_changed');
      receipt.terminalResult = await terminalPicker.execute(preview.input.config);
    } else if (preview.kind === 'goal') {
      receipt.goalResult = goalLedger().commitEdit(preview.input.config, receipt.operationId);
    } else if (preview.kind === 'user-action') {
      // Recheck the exact report immediately before the existing ledger's locked CAS.
      const agent = dashboard.status().agents.find(row => row.id === preview.input.config.agentId);
      if (!agent || agent.reportRevision !== preview.input.config.expectedReportRevision || !agent.userActions?.some(row => row.id === preview.input.config.id && row.revision === preview.input.config.expectedActionRevision)) fail('user_action_report_binding_changed');
      receipt.userActionResult = goalLedger().completeUserAction(preview.input.config);
    } else if (preview.kind === 'continuity') {
      for (const row of preview.targets) {
        receipt.currentThreadId = row.threadId; atomic(file, receipt);
        await helper(preview.action, row.threadId, row.expectedTerminalSha256);
        receipt.completed.push(row.threadId); atomic(file, receipt);
      }
    } else if (preview.kind === 'account' || preview.kind === 'account-order' || preview.kind === 'quota-policy') {
      const pin = trayPin(), module = await import(pathToFileURL(path.join(pin.root, 'tools/platform/windows/tray-control.mjs')).href);
      const requestFile = path.join(requests, receipt.operationId + '.json');
      fs.writeFileSync(requestFile, JSON.stringify(preview.request) + '\n', { flag: 'wx', mode: 0o600 });
      const result = await module.applyTrayRequest(requestFile);
      receipt.ownerTerminal = clean(result?.terminal, 80); receipt.localMetadataSynced = result?.localMetadataSynced ?? null;
      if (!['PASS','RECONCILED'].includes(result?.terminal) || result?.localMetadataSynced === false) fail('account_outcome_unknown');
    } else if (preview.kind === 'tray-tool') {
      const result = await trayTools.execute(preview, { operationId: receipt.operationId });
      receipt.ownerTerminal = clean(result?.terminal, 80);
      receipt.toolResult = {
        terminal: clean(result?.terminal, 80), action: clean(result?.action, 80),
        originalRequestId: /^[a-f0-9]{32}$/.test(result?.originalRequestId ?? '') ? result.originalRequestId : null,
        originalOperationId: /^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/.test(result?.result?.operationId ?? '') ? result.result.operationId : null,
        automaticReplay: false, verificationScope: clean(result?.verificationScope, 120), result: result?.result ?? null
      };
      if (!['PASS','RECONCILED','COMPLETED'].includes(result?.terminal)) {
        if (result?.mutates === false) { receipt.state = 'READ_FAILED'; receipt.completedAt = new Date().toISOString(); atomic(file, receipt); return; }
        fail('tray_tool_outcome_unknown');
      }
      if (['reconcile','rdc-reconcile'].includes(preview.action)) {
        const stillPending = new Set((await trayTools.status()).unresolved.map(row => row.operationId));
        for (const pending of unresolved()) {
          if (pending.operationId === receipt.operationId || pending.kind !== 'tray-tool' || stillPending.has(pending.operationId)) continue;
          const originalFile = path.join(requests, `mobile-${pending.operationId}.json`), original = read(originalFile);
          const matches = preview.action === 'reconcile'
            ? original.toolResult?.originalRequestId && original.toolResult.originalRequestId === preview.input?.requestId
            : original.toolResult?.originalOperationId && original.toolResult.originalOperationId === preview.input?.operationRef;
          if (matches) atomic(originalFile, { ...original, state: 'RECONCILED', reconciledBy: receipt.operationId, reconciledAt: new Date().toISOString(), automaticReplay: false });
        }
      }
    } else if (preview.kind === 'quota-warning') {
      await quotaDashboard.saveWarnings(preview);
    } else {
      const before = options.webConfig().status();
      const config = structuredClone(preview.config);
      // Remote callers never supply a filesystem path. Existing scoped receipts stay local.
      for (const target of config.targets) {
        const old = before.config.targets.find(t => t.id === target.id && t.conversationUrl === target.conversationUrl && t.role === target.role);
        if (old?.externalStateFile) { target.externalStateFile = old.externalStateFile; target.externalStateSha256 = old.externalStateSha256; }
      }
      options.webConfig().save(config);
    }
    receipt.state = 'COMPLETED'; receipt.completedAt = new Date().toISOString(); atomic(file, receipt);
  }
  const control = {
    remoteOrigin,
    beginMaintenance() {
      reap();
      const pendingOutcomes = unresolved().length;
      if (activeApiRequests || mutationBusy || statePending || trayPending || quotaDashboard.collectionPending === true || previews.size || pendingOutcomes) {
        return { accepted: false, reason: 'mobile_work_preserved', activeApiRequests, mutationBusy, pendingPreviews: previews.size, pendingOutcomes };
      }
      maintenanceDraining = true;
      return { accepted: true, state: 'DRAINING', activeApiRequests: 0, mutationBusy: false, pendingOutcomes: 0, deviceTrustPreserved: true };
    },
    async handle(req, res, url) {
      reap();
      const port = req.socket.localPort;
      const localHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
      const authority = String(req.headers.host ?? '').toLowerCase();
      const remote = !!remoteOrigin && authority === new URL(remoteOrigin).host.toLowerCase();
      const proxyHeader = ['forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','tailscale-user-login','tailscale-user-name'].some(h => req.headers[h] !== undefined);
      const local = localHosts.has(authority) && !proxyHeader;
      if (!loopback(req.socket.remoteAddress) || (!remote && !local)) { send(res, 403, { ok: false, code: 'host_not_allowed' }); return true; }
      const mobileStatic = ['/mobile.html','/mobile.js','/mobile.css','/mobile-quota.js','/mobile-quota.css','/mobile-tools.js','/dashboard-workspace.js','/dashboard-workspace.css','/aicc.webmanifest','/aicc-sw.js','/favicon.svg','/ai-cowork.js','/ai-cowork.json','/supervise.html','/supervise.js','/supervise.css'].includes(url.pathname);
      const mobileInstallIcon = ['/aicc-icon-192.png', '/aicc-icon-512.png','/install.html','/install.js','/downloads/aicc-mobile.apk','/downloads/aicc-mobile.json','/portfolio-overview.js','/portfolio-overview.css'].includes(url.pathname);
      if (remote && !mobileStatic && !mobileInstallIcon && !url.pathname.startsWith('/api/mobile/')) { send(res, 403, { ok: false, code: 'mobile_scope_only' }); return true; }
      if (!url.pathname.startsWith('/api/mobile/')) return false;
      const expectedOrigin = remote ? remoteOrigin : `http://${authority}`;
      if ((req.headers.origin && req.headers.origin !== expectedOrigin) || (req.method === 'POST' && req.headers.origin !== expectedOrigin) || req.headers['sec-fetch-site'] === 'cross-site') { send(res, 403, { ok: false, code: 'same_origin_required' }); return true; }
      if (maintenanceDraining) { send(res, 503, { ok: false, code: 'mobile_maintenance', automaticReplay: false }); return true; }
      activeApiRequests++;
      try {
        if (req.method === 'POST' && url.pathname === '/api/mobile/local-session') {
          if (!local || sessions.size > 64) fail('local_owner_required'); await body(req);
          const session = newSession(false); send(res, 200, { ok: true, csrf: session.csrf, local: true, remoteConfigured: !!remoteOrigin, expiresAt: sessionExpiry(session) }, { 'set-cookie': cookie(session.id, session) }); return true;
        }
        if (req.method === 'POST' && url.pathname === '/api/mobile/exchange') {
          if (!remote || sessions.size > 64) fail('remote_pair_required');
          const input = await body(req); exactKeys(input, ['token']);
          if (!TOKEN.test(input.token ?? '')) fail('pair_invalid');
          const key = sha(input.token), pair = pairs.get(key); pairs.delete(key);
          if (!pair || pair.expires <= Date.now()) fail('pair_expired');
          const session = newSession(true, pair.remember, pair.deviceName);
          send(res, 200, { ok: true, csrf: session.csrf, local: false, trustedDevice: session.trusted, deviceId: session.deviceId, expiresAt: sessionExpiry(session), maximumExpiresAt: sessionMaximum(session) }, { 'set-cookie': cookie(session.id, session) }); return true;
        }
        const session = sessionFor(req, remote, req.method !== 'GET');
        res.setHeader('set-cookie', cookie(session.id, session));
        if (req.method === 'GET' && url.pathname === '/api/mobile/session') { send(res, 200, { ok: true, local, csrf: session.csrf, trustedDevice: session.trusted === true, deviceId: session.deviceId ?? null, remoteConfigured: !!remoteOrigin, expiresAt: sessionExpiry(session), maximumExpiresAt: sessionMaximum(session) }); return true; }
        if (req.method === 'GET' && url.pathname === '/api/mobile/devices') { if (!local) fail('local_owner_required'); send(res, 200, { ok: true, devices: devices?.list() ?? [] }); return true; }
        if (req.method === 'GET' && url.pathname === '/api/mobile/state') { send(res, 200, { ok: true, ...await continuity(), unresolved: unresolved() }); return true; }
        if (req.method === 'GET' && url.pathname === '/api/mobile/goals') { send(res, 200, await trackedGoals()); return true; }
        if (req.method === 'GET' && url.pathname === '/api/mobile/portfolio-overview') { send(res, 200, readPortfolioOverview({ codexRoot: options.codexRoot })); return true; }
        if (req.method === 'GET' && url.pathname === '/api/mobile/evidence-history') { send(res, 200, readDurableEvidenceHistory({ stateRoot: owner })); return true; }
        if (req.method === 'GET' && url.pathname === '/api/mobile/orchestration') { send(res, 200, readMobileOrchestration({ stateRoot: owner })); return true; }
        if (req.method === 'GET' && url.pathname === '/api/mobile/pending-work') { send(res, 200, readPendingWorkSummary({ stateRoot: owner })); return true; }
        if (req.method === 'GET' && url.pathname === '/api/mobile/work-activity') { send(res, 200, readMobileWorkActivity({ stateRoot: owner })); return true; }
        if (req.method === 'GET' && url.pathname === '/api/mobile/web-queue') {
          const base = { ok: true, readOnly: true, automaticReplay: false, status: 'UNKNOWN', counts: null, items: [], controls: 'CHROME_QUEUE_EXTENSION_ONLY', observedAt: new Date().toISOString() };
          try {
            // Reuse the tray's bounded native-owner projection, never browser storage
            // or a second ledger. The caller cannot select a path or another owner.
            if (!options.webQueueStatus && owner !== path.resolve(process.env.AICC_STATE_ROOT ?? path.join(os.homedir(), '.ai-control-center'))) throw Error('owner_mismatch');
            const source = options.webQueueStatus ?? (await import('../tools/platform/windows/tray-status.mjs')).readWebQueueStatus;
            const value = await source();
            const keys = ['runs','active','paused','completed','failed','cancelled','unknown','readyRoles','runningRoles'];
            if (value?.state !== 'ready' || !keys.every(key => Number.isSafeInteger(value.counts?.[key]) && value.counts[key] >= 0 && value.counts[key] <= 1000000) || !Array.isArray(value.items) || value.items.length > 5) throw Error('invalid_projection');
            const statuses = new Set(['running','paused','completed','failed','cancelled','unknown']);
            const reasons = new Set(['SUBMISSION_UNCERTAIN','ROLE_FAILED','RUN_FAILED','PAUSED','NONE']);
            if (value.items.some(item => !statuses.has(item?.status) || !reasons.has(item.reason) || !Number.isSafeInteger(item.roles) || item.roles < 2 || item.roles > 12)) throw Error('invalid_projection');
            send(res, 200, { ...base, status: 'AVAILABLE', sourceObservedAt: typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt)) ? value.observedAt : null,
              counts: Object.fromEntries(keys.map(key => [key, value.counts[key]])), itemsTruncated: value.itemsTruncated === true,
              items: value.items.map((item, index) => ({ label: 'GPT 큐 ' + (index + 1), state: item.reason === 'SUBMISSION_UNCERTAIN' ? 'UNKNOWN' : item.status.toUpperCase(), reason: item.reason, roles: item.roles })) });
          } catch { send(res, 200, base); }
          return true;
        }
        if (req.method === 'GET' && url.pathname === '/api/mobile/apps') { send(res, 200, readMobileAppCatalog({ ...options.appCatalog, ownerRoot: owner })); return true; }
        if (req.method === 'GET' && url.pathname === '/api/mobile/dashboard') { send(res, 200, { ...dashboard.status(), userActionCompletionSupported: typeof goalLedger().prepareUserActionComplete === 'function' && typeof goalLedger().completeUserAction === 'function', mobilePublic: await readMobilePublicStopSupportAsync(owner) }); return true; }
        if (req.method === 'GET' && url.pathname === '/api/mobile/dashboard-terminal') {
          const agentId = url.searchParams.get('agentId');
          if (!dashboard.status().agents.some(row => row.id === agentId)) fail('dashboard_agent_missing');
          send(res, 200, { ok: true, ...await terminalPicker.status(agentId) }); return true;
        }
        if (req.method === 'POST' && url.pathname === '/api/mobile/dashboard-resume-check') {
          // The returned local command contains a private registered helper path.
          if (!local) fail('local_owner_required');
          if (unresolved().length) fail('previous_outcome_unknown');
          const input = await body(req); exactKeys(input, ['agentId','expectedReportRevision']);
          const agent = dashboard.status().agents.find(row => row.id === input.agentId);
          if (!agent || agent.reportRevision !== input.expectedReportRevision) fail('dashboard_report_changed');
          if (typeof terminalPicker.resumeStatus !== 'function') fail('terminal_picker_upgrade_required');
          send(res, 200, { ok: true, ...await terminalPicker.resumeStatus(input.agentId) }); return true;
        }
        if (req.method === 'POST' && url.pathname === '/api/mobile/dashboard-queue-preflight') {
          if (unresolved().length) fail('previous_outcome_unknown');
          const input = await body(req); exactKeys(input, ['id','expectedRevision']);
          send(res, 200, { ok: true, ...await queuePreflight.inspect(input) }); return true;
        }
        if (req.method === 'GET' && url.pathname === '/api/mobile/management') { send(res, 200, readManagementOverview(owner, { mobilePublic: await readMobilePublicStopSupportAsync(owner) })); return true; }
        if (req.method === 'GET' && url.pathname === '/api/mobile/quota') { send(res, 200, { ok: true, ...await quotaDashboard.read({ accountsOnly: url.searchParams.get('view') === 'accounts' }), notificationMonitor: options.quotaMonitor?.status() ?? null }); return true; }
        if (req.method === 'GET' && url.pathname === '/api/mobile/tray') { send(res, 200, { ok: true, ...await tray() }); return true; }
        if (req.method === 'GET' && url.pathname === '/api/mobile/tools') { send(res, 200, { ok: true, ...await trayTools.status() }); return true; }
        if (req.method === 'GET' && url.pathname === '/api/mobile/web') { send(res, 200, { ok: true, ...webStatus() }); return true; }
        if (url.pathname === '/api/mobile/supervise' || url.pathname.startsWith('/api/mobile/supervise/')) return await handleSupervise(req, res, url, local, session);
        if (req.method === 'GET' && url.pathname === '/api/mobile/operation') {
          const id = url.searchParams.get('id'); if (!/^[a-f0-9]{32}$/.test(id ?? '')) fail('operation_invalid');
          const result = read(path.join(requests, `mobile-${id}.json`));
          send(res, 200, { ok: true, operationId: id, kind: result.kind, state: result.state, completed: result.completed, automaticReplay: false, ownerTerminal: result.ownerTerminal ?? null, toolResult: result.toolResult ?? null, terminalResult: result.terminalResult ?? null, queueResult: result.queueResult ?? null, userActionResult: result.userActionResult ? { id: result.userActionResult.id, removed: result.userActionResult.removed === true, completedAt: result.userActionResult.completedAt, completedBy: result.userActionResult.completedBy } : null }); return true;
        }
        if (req.method === 'GET' && url.pathname === '/api/mobile/operation-by-confirmation') {
          const digest = url.searchParams.get('sha256'); if (!SHA.test(digest ?? '')) fail('operation_invalid');
          const matches = fs.existsSync(requests) ? fs.readdirSync(requests).filter(n => /^mobile-[a-f0-9]{32}\.json$/.test(n)).map(n => read(path.join(requests, n))).filter(r => ['dashboard', 'goal', 'user-action', 'terminal', 'queue-send'].includes(r.kind) && r.confirmationSha256 === digest) : [];
          if (matches.length !== 1) { send(res, 200, { ok: true, state: 'UNKNOWN', operationId: null, automaticReplay: false }); return true; }
          const result = matches[0]; send(res, 200, { ok: true, operationId: result.operationId, state: result.state, automaticReplay: false }); return true;
        }
        if (req.method !== 'POST') { send(res, 405, { ok: false, code: 'method_not_allowed' }); return true; }
        const input = await body(req);
        if (url.pathname === '/api/mobile/logout') { if (session.trusted) devices.revokeSecret(session.id); sessions.delete(session.id); send(res, 200, { ok: true }, { 'set-cookie': `${cookieName}=; Path=/api/mobile/; HttpOnly; SameSite=Strict; Max-Age=0${remote ? '; Secure' : ''}` }); return true; }
        if (url.pathname === '/api/mobile/revoke') { if (!local) fail('local_owner_required'); devices?.revokeAll(); sessions.clear(); pairs.clear(); previews.clear(); send(res, 200, { ok: true }); return true; }
        if (url.pathname === '/api/mobile/revoke-device') {
          if (!local) fail('local_owner_required'); exactKeys(input, ['deviceId']);
          devices.revokeId(input.deviceId);
          for (const [id, value] of sessions) if (value.deviceId === input.deviceId) sessions.delete(id);
          previews.clear(); send(res, 200, { ok: true }); return true;
        }
        if (url.pathname === '/api/mobile/pair') {
          if (!local || !remoteOrigin) fail('local_owner_required'); exactKeys(input, ['remember','deviceName']);
          if (typeof input.remember !== 'boolean') fail('remember_required');
          pairs.clear(); const secret = token(), expires = Date.now() + 120000;
          pairs.set(sha(secret), { expires, remember: input.remember, deviceName: clean(input.deviceName, 80) });
          send(res, 200, { ok: true, url: `${remoteOrigin}/mobile.html#pair=${secret}`, expiresAt: new Date(expires).toISOString() }); return true;
        }
        if (url.pathname === '/api/mobile/quota/refresh') { exactKeys(input, []); send(res, 200, { ok: true, ...await quotaDashboard.read({ refresh: true }), notificationMonitor: options.quotaMonitor?.status() ?? null }); return true; }
        if (url.pathname === '/api/mobile/refresh-quota') { exactKeys(input, []); send(res, 200, { ok: true, ...await tray(true) }); return true; }
        if (url.pathname === '/api/mobile/preview') {
          if (mutationBusy || previews.size > 64) fail('mutation_busy');
          const prepared = await prepare(input), confirmation = token(), expires = Date.now() + 60000;
          previews.set(confirmation, { ...prepared, input, sessionId: session.id, expires });
          send(res, 200, { ok: true, confirmationToken: confirmation, expiresAt: new Date(expires).toISOString(), summary: prepared.summary, automaticReplay: false }); return true;
        }
        if (url.pathname === '/api/mobile/confirm') {
          exactKeys(input, ['confirmationToken']);
          const preview = previews.get(input.confirmationToken); previews.delete(input.confirmationToken);
          if (!preview || preview.sessionId !== session.id || preview.expires <= Date.now()) fail('confirmation_expired');
          if (mutationBusy) fail('mutation_busy'); mutationBusy = true;
          let receipt, file, lock;
          const lockFile = path.join(requests, 'mobile-operation.lock');
          try {
            directory();
            try { lock = fs.openSync(lockFile, 'wx', 0o600); }
            catch { fail('mutation_busy'); }
            const fresh = await prepare(preview.input);
            if (fresh.fingerprint !== preview.fingerprint) fail('preview_stale');
            if (session.expires <= Date.now() || preview.expires <= Date.now()) fail('confirmation_expired');
            directory(); const operationId = randomUUID().replaceAll('-', ''); file = path.join(requests, `mobile-${operationId}.json`);
            receipt = { schemaVersion: 1, operationId, kind: preview.kind, state: 'DISPATCHING', requestSha256: sha(JSON.stringify(preview.input)), ...(['dashboard', 'goal', 'user-action', 'terminal', 'queue-send'].includes(preview.kind) ? { confirmationSha256: sha(input.confirmationToken) } : {}), startedAt: new Date().toISOString(), completed: [], automaticReplay: false };
            fs.writeFileSync(file, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
            // A disconnect does not cancel or repeat the one operation; its result stays queryable.
            send(res, 202, { ok: true, operationId, state: receipt.state, automaticReplay: false });
            void execute(preview, file, receipt).catch(() => { receipt.state = 'UNKNOWN'; receipt.automaticReplay = false; try { atomic(file, receipt); } catch {} }).finally(() => { mutationBusy = false; try { fs.closeSync(lock); } catch {} try { fs.unlinkSync(lockFile); } catch {} });
          } catch (error) { mutationBusy = false; if (lock !== undefined) { fs.closeSync(lock); try { fs.unlinkSync(lockFile); } catch {} } throw error; }
          return true;
        }
        send(res, 404, { ok: false, code: 'mobile_action_unknown' }); return true;
      } catch (error) { send(res, 409, { ok: false, code: /^[a-z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'owner_operation_unavailable', automaticReplay: false }); return true; } finally { activeApiRequests--; }
    }
  };
  let supervisedRunService = options.supervisedRuns ?? null;
  async function handleSupervise(req, res, url, local, session) {
    const svc = supervisedRunService ??= (await import('./supervised-runs/service.mjs')).createSupervisedRunService(options.supervisedRunOptions);
    const reply = (status, value) => { send(res, status, value); return true; };
    try {
      if (req.method === 'GET' && url.pathname === '/api/mobile/supervise') return reply(200, { ...await svc.status({ run: url.searchParams.get('run') || undefined }), local });
      if (req.method === 'GET' && url.pathname === '/api/mobile/supervise/logs') return reply(200, svc.logs({ run: url.searchParams.get('run'), lines: Number(url.searchParams.get('lines') ?? 30) }));
      if (req.method !== 'POST') return reply(405, { ok: false, code: 'method_not_allowed' });
      const input = await body(req);
      if (url.pathname === '/api/mobile/supervise/plan') { if (!local) fail('local_owner_required'); return reply(200, svc.plan(input)); }
      if (url.pathname === '/api/mobile/supervise/preview') {
        exactKeys(input, ['action', 'input']);
        if (!local && !['end-group', 'close-tab'].includes(input.action)) fail('local_owner_required');
        return reply(200, await svc.preview(input.action, input.input ?? {}, { scope: local ? 'local' : 'phone', sessionId: session.id }));
      }
      if (url.pathname === '/api/mobile/supervise/confirm') {
        exactKeys(input, ['confirmationToken']);
        const result = await svc.confirm(input.confirmationToken, { scope: local ? 'local' : 'phone', sessionId: session.id });
        return reply(result.ok ? 200 : 409, result);
      }
      return reply(404, { ok: false, code: 'mobile_action_unknown' });
    } catch (error) {
      const code = /^[a-z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'supervise_unavailable';
      return reply(error?.status && error.status < 500 ? error.status : 409, { ok: false, code, automaticReplay: false });
    }
  }
  options.onControlReady?.(control);
  return control;
}
