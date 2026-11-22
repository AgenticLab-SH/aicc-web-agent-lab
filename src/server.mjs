import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActionError, createActionController } from './actions.mjs';
import { openLocalApp } from './apps.mjs';
import { toolCatalog } from './catalog.mjs';
import { dashboardProductSpec } from './dashboard-product.mjs';
import { collectStatus } from './status.mjs';
import { checkOpenaiCatalog } from './openai-catalog-check.mjs';
import { evaluateOpenaiMonitor, openaiUsageStatus } from './openai-usage.mjs';
import { listTasks, runTask } from './tasks.mjs';
import { designSourcesStatus, scanDesignSourcesAsync } from './design-sources.mjs';
import { monitoringStatus } from './monitoring.mjs';
import { createKnowledgeReviewService } from './knowledge-review/service.mjs';
import { createLocalAccessService } from './local-access/service.mjs';
import { createMonitoringJobService } from './monitoring-job-service.mjs';
import { createProjectCatalogService } from './projects/service.mjs';
import { createRecoveryHandoffService } from './recovery-handoff.mjs';
import { createAssetControlService } from './assets/service.mjs';
import { codexWorkGateStatus } from './codex-work-gate.mjs';
import { aiccRecoveryStatus } from './aicc-recovery-status.mjs';
import { createGoalLedgerService } from './goals/service.mjs';
import { createWebJjonkuMonitorConfig } from './web-jjonku-monitor-config.mjs';
import { createMobileControl } from './mobile-control.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'public');
const host = process.env.AICC_HOST || '127.0.0.1';
const port = Number(process.env.AICC_PORT || 4381);
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.canvas', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png']
  ,['.apk', 'application/vnd.android.package-archive']
  ,['.json', 'application/json; charset=utf-8']
]);

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function staticFile(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const resolved = path.resolve(publicRoot, requested);
  if (!resolved.startsWith(`${publicRoot}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    json(res, 404, { ok: false, error: 'not found' });
    return;
  }
  res.writeHead(200, {
    'content-type': contentTypes.get(path.extname(resolved)) || 'application/octet-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
  });
  if (pathname === '/mobile.html') {
    // Use the sealed release timestamp, never the request time or process start.
    let stamp = null;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, '.aicc-release.json'), 'utf8').replace(/^\uFEFF/, ''));
      if (manifest.component === 'mobile-public-control' && typeof manifest.createdAt === 'string' && Number.isFinite(Date.parse(manifest.createdAt))) stamp = new Date(manifest.createdAt);
    } catch { /* Older releases and development checkouts have no release time. */ }
    const time = stamp ? `<time id="appUpdatedAt" datetime="${stamp.toISOString()}">${stamp.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} KST</time>` : '<time id="appUpdatedAt">시각 미확인</time>';
    res.end(fs.readFileSync(resolved, 'utf8').replace('<time id="appUpdatedAt">시각 미확인</time>', time));
    return;
  }
  fs.createReadStream(resolved).pipe(res);
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === req.headers.host && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  } catch {
    return false;
  }
}

async function readJson(req, maxBytes = 16_384) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new ActionError('request_too_large', '요청이 너무 큽니다.', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ActionError('invalid_json', 'JSON 요청을 읽을 수 없습니다.'); }
}

function actionFailure(res, error) {
  const status = error instanceof ActionError ? error.status : 500;
  const code = error instanceof ActionError ? error.code : 'internal_error';
  return json(res, status, { ok: false, code, error: error.message });
}

function serviceFailure(res, error) {
  const code = error?.code ?? 'internal_error';
  const denied = code === 'HOLD_TCC' || /(?:denied|escape|symlink|outside|scope|too_broad|unsafe)/i.test(code);
  const conflict = /(?:confirmation|conflict|expired|exists|already|pending|busy|replay)/i.test(code);
  const invalid = /(?:invalid|required|missing|unavailable|mismatch|unknown)/i.test(code);
  const status = denied ? 403 : conflict ? 409 : invalid ? 400 : 500;
  return json(res, status, { ok: false, code, error: error?.message ?? 'internal error' });
}

function requestAllowed(req, res, options = {}) {
  if (!isLoopback(req.socket.remoteAddress)) {
    json(res, 403, { ok: false, code: 'loopback_required', error: '로컬 요청만 허용됩니다.' });
    return false;
  }
  if (!isSameOrigin(req)) {
    json(res, 403, { ok: false, code: 'same_origin_required', error: '같은 로컬 화면에서 보낸 요청만 허용됩니다.' });
    return false;
  }
  if (options.jsonRequired !== false && !String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    json(res, 415, { ok: false, code: 'json_required', error: 'JSON 요청만 허용됩니다.' });
    return false;
  }
  return true;
}

export function createServer(options = {}) {
  const statusCollector = options.collectStatus ?? collectStatus;
  const workGateStatus = options.codexWorkGateStatus ?? codexWorkGateStatus;
  const recoveryStatus = options.aiccRecoveryStatus ?? aiccRecoveryStatus;
  const actionController = options.actionController ?? createActionController(options.actions);
  const statusCacheTtlMs = options.statusCacheTtlMs ?? 10_000;
  let statusCache = null;
  let statusCacheAt = 0;
  let statusInFlight = null;
  let knowledgeReviewService = options.knowledgeReviewService ?? null;
  let localAccessService = options.localAccessService ?? null;
  let monitoringJobService = options.monitoringJobService ?? null;
  let projectCatalogService = options.projectCatalogService ?? null;
  let recoveryHandoffService = options.recoveryHandoffService ?? null;
  let assetControlService = options.assetControlService ?? null;
  let goalLedgerService = options.goalLedgerService ?? null;
  let webJjonkuMonitorConfigService = options.webJjonkuMonitorConfigService ?? null;
  const knowledgeReview = () => (knowledgeReviewService ??= createKnowledgeReviewService(options.knowledgeReview));
  const localAccess = () => (localAccessService ??= createLocalAccessService(options.localAccess));
  const monitoringJobs = () => (monitoringJobService ??= createMonitoringJobService(options.monitoring));
  const projects = () => (projectCatalogService ??= createProjectCatalogService(options.projects));
  const recoveryHandoff = () => (recoveryHandoffService ??= createRecoveryHandoffService(options.recoveryHandoff));
  const assets = () => (assetControlService ??= createAssetControlService(options.assets));
  const goals = () => (goalLedgerService ??= createGoalLedgerService(options.goals));
  const webJjonkuMonitorConfig = () => (webJjonkuMonitorConfigService ??= createWebJjonkuMonitorConfig(options.webJjonkuMonitorConfig));
  const mobile = createMobileControl({ ...options.mobile, webConfig: webJjonkuMonitorConfig, goalLedger: options.mobile?.goalLedger ?? goals });
  const currentStatus = async () => {
    if (statusCache && Date.now() - statusCacheAt < statusCacheTtlMs) return statusCache;
    if (statusInFlight) return statusInFlight;
    const pending = Promise.resolve(statusCollector()).then(result => {
      statusCache = result;
      statusCacheAt = Date.now();
      return result;
    });
    statusInFlight = pending;
    try { return await pending; }
    finally { if (statusInFlight === pending) statusInFlight = null; }
  };
  const currentMonitoring = () => ({
    ...(options.monitoringStatus ?? monitoringStatus)(options.monitoring),
    scheduler: monitoringJobs().status()
  });
  let maintenanceDraining = false, activeHttpRequests = 0;
  const server = http.createServer(async (req, res) => {
    if (maintenanceDraining) return json(res, 503, { ok: false, code: 'mobile_maintenance', automaticReplay: false });
    activeHttpRequests++;
    let ended = false;
    const finished = () => { if (!ended) { ended = true; activeHttpRequests--; } };
    res.once('finish', finished); res.once('close', finished);
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`); }
    catch { return json(res, 400, { ok: false, code: 'invalid_request_url' }); }
    if (await mobile.handle(req, res, url)) return;
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true, mode: 'local-control' });
    if (req.method === 'GET' && url.pathname === '/api/status') {
      try { return json(res, 200, await currentStatus()); }
      catch (error) { return json(res, 500, { ok: false, error: error.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/goals') {
      try { return json(res, 200, goals().status()); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'GET' && url.pathname === '/api/codex-work-gate') {
      try { return json(res, 200, await workGateStatus(options.codexWorkGate)); }
      catch { return json(res, 200, codexWorkGateStatus({ inspectCodexWork: () => { throw new Error('inspection failed'); } })); }
    }
    if (req.method === 'GET' && url.pathname === '/api/recovery/latest') {
      try { return json(res, 200, await recoveryStatus(options.aiccRecovery)); }
      catch (error) {
        return json(res, 200, {
          ok: true,
          available: false,
          state: 'unknown',
          reason: error?.code ?? 'recovery_status_unknown',
          component: null,
          operationId: null,
          gate: { readOk: false, exactIdle: false, activeCount: null, unknownCount: null }
        });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/catalog') {
      return json(res, 200, { ok: true, ...toolCatalog() });
    }
    if (req.method === 'GET' && url.pathname === '/api/product') {
      return json(res, 200, { ok: true, ...dashboardProductSpec({ actions: actionController.list(), tasks: listTasks() }) });
    }
    if (req.method === 'GET' && url.pathname === '/api/actions') {
      return json(res, 200, { ok: true, actions: actionController.list() });
    }
    if (req.method === 'GET' && url.pathname === '/api/openai-usage') {
      try { return json(res, 200, await (options.openaiUsageStatus ?? openaiUsageStatus)()); }
      catch (error) { return json(res, 500, { ok: false, error: error.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/design-sources') {
      try { return json(res, 200, await (options.designSourcesStatus ?? designSourcesStatus)(options.designSources)); }
      catch (error) { return json(res, 500, { ok: false, error: error.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/monitoring') {
      try { return json(res, 200, await currentMonitoring()); }
      catch (error) { return json(res, 500, { ok: false, error: error.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/web-jjonku-monitor/config') {
      if (!requestAllowed(req, res, { jsonRequired: false })) return;
      try { return json(res, 200, webJjonkuMonitorConfig().status()); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'GET' && url.pathname === '/api/knowledge-review/status') {
      try { return json(res, 200, knowledgeReview().status()); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      try { return json(res, 200, projects().status()); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'GET' && url.pathname === '/api/projects/priority/outbox') {
      try { return json(res, 200, projects().listPriorityOperations()); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'GET' && url.pathname === '/api/assets') {
      try { return json(res, 200, assets().status()); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'GET' && url.pathname === '/api/assets/chatgpt-catalog') {
      try { return json(res, 200, assets().queryChatGptArchiveCatalog({ accountAlias: url.searchParams.get('account') ?? undefined, kind: url.searchParams.get('kind') ?? undefined, status: url.searchParams.get('status') ?? undefined, query: url.searchParams.get('query') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 25), cursor: Number(url.searchParams.get('cursor') ?? 0) })); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'GET' && url.pathname === '/api/local-access') {
      try { return json(res, 200, localAccess().status()); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'GET' && url.pathname === '/api/recovery/handoff') {
      try { return json(res, 200, recoveryHandoff().status()); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'GET' && url.pathname === '/api/recovery/handoff/content') {
      try { return json(res, 200, recoveryHandoff().content()); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/monitoring/upstream-preview') {
      if (!requestAllowed(req, res)) return;
      try { await readJson(req); return json(res, 200, monitoringJobs().preview()); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/web-jjonku-monitor/config') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, webJjonkuMonitorConfig().save(await readJson(req, 32_768))); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/goals/check') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, goals().setChecked(await readJson(req))); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/goals/user-actions/complete') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, goals().completeUserAction(await readJson(req))); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/monitoring/upstream-refresh') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 202, monitoringJobs().enqueue(await readJson(req))); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/knowledge-review/preview') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, knowledgeReview().preview(await readJson(req))); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/knowledge-review/jobs') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 202, knowledgeReview().enqueue(await readJson(req))); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/projects/priority/preview') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, projects().previewPriority(await readJson(req))); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/projects/priority/confirm') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 202, projects().confirmPriority((await readJson(req)).confirmationToken)); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/projects/notion-snapshot') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, projects().refreshNotionSnapshot((await readJson(req, 262_144)).snapshot)); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/projects/priority/sync/prepare') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, projects().preparePrioritySync(await readJson(req))); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/projects/priority/sync/complete') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, projects().completePrioritySync(await readJson(req, 262_144))); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/projects/priority/sync/failure') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, projects().recordPrioritySyncFailure(await readJson(req))); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/assets/chatgpt-import') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, assets().importChatGptSnapshot((await readJson(req, 262_144)).snapshot)); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/assets/chatgpt-catalog/import') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, assets().importChatGptArchiveCatalog((await readJson(req, 4_194_304)).catalog)); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/assets/operations/preview') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, assets().previewOperation(await readJson(req))); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/assets/operations/confirm') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 202, assets().confirmOperation((await readJson(req)).confirmationToken)); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/assets/operations/prepare') {
      if (!requestAllowed(req, res)) return;
      try { const body = await readJson(req); return json(res, 200, assets().prepareOperation(body.operationId, body)); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/assets/operations/complete') {
      if (!requestAllowed(req, res)) return;
      try { const body = await readJson(req); return json(res, 200, assets().completeOperation(body.operationId, body)); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/assets/operations/failure') {
      if (!requestAllowed(req, res)) return;
      try { const body = await readJson(req); return json(res, 200, assets().failOperation(body.operationId, body)); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/local-access/grants/preview') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, localAccess().previewGrant(await readJson(req))); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/local-access/grants/confirm') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 201, localAccess().confirmGrant((await readJson(req)).confirmationToken)); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/local-access/excerpts/preview') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, localAccess().previewExcerpt(await readJson(req))); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/local-access/excerpts/confirm') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 201, localAccess().confirmExcerpt((await readJson(req)).confirmationToken)); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/design-sources/scan') {
      if (!requestAllowed(req, res)) return;
      try { return json(res, 200, await (options.scanDesignSources ?? scanDesignSourcesAsync)(options.designSources)); }
      catch (error) { return actionFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/recovery/handoff/refresh') {
      if (!requestAllowed(req, res)) return;
      try { await readJson(req); return json(res, 201, await recoveryHandoff().refresh()); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/recovery/handoff/reveal') {
      if (!requestAllowed(req, res)) return;
      try { await readJson(req); return json(res, 200, await recoveryHandoff().reveal()); }
      catch (error) { return serviceFailure(res, error); }
    }
    if (req.method === 'POST' && url.pathname === '/api/tasks/run') {
      if (!requestAllowed(req, res)) return;
      try {
        const body = await readJson(req);
        const result = await (options.runTask ?? runTask)(body.taskId);
        // A completed diagnostic may legitimately report findings (`ok: false`).
        // Keep that result distinct from a transport or execution failure so the
        // dashboard can show the diagnostic output instead of hiding it behind
        // an HTTP error.
        return json(res, 200, result);
      } catch (error) {
        return actionFailure(res, error);
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/apps/open') {
      if (!requestAllowed(req, res)) return;
      try {
        const body = await readJson(req);
        return json(res, 200, await (options.openLocalApp ?? openLocalApp)(body.appId));
      } catch (error) {
        return actionFailure(res, error);
      }
    }
    if (req.method === 'POST' && (url.pathname === '/api/actions/preview' || url.pathname === '/api/actions/execute')) {
      if (!requestAllowed(req, res)) return;
      try {
        const body = await readJson(req);
        const result = url.pathname.endsWith('/preview')
          ? await actionController.preview(body.action, body.args)
          : await actionController.execute(body.confirmationToken);
        return json(res, result.ok ? 200 : 409, result);
      } catch (error) {
        return actionFailure(res, error);
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'method not allowed' });
    return staticFile(res, url.pathname);
  });
  Object.defineProperty(server, 'beginMobileMaintenance', { value: () => {
    if (activeHttpRequests) return { accepted: false, reason: 'http_requests_active', activeHttpRequests };
    const result = mobile.beginMaintenance();
    if (result.accepted) maintenanceDraining = true;
    return result;
  } });
  return server;
}

export function startServer(options = {}) {
  const recoveryHandoffService = options.recoveryHandoffService ?? createRecoveryHandoffService(options.recoveryHandoff);
  const server = createServer({ ...options, recoveryHandoffService });
  const listenHost = options.host ?? host;
  const listenPort = options.port ?? port;
  if (!['127.0.0.1', '::1', 'localhost'].includes(listenHost)) throw new Error('AICC control requires a loopback listener');
  server.listen(listenPort, listenHost, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : listenPort;
    console.log(`open-AICC: http://${listenHost}:${actualPort}`);
    console.log('Mode: local-control');
  });
  if (options.backgroundOpenaiMonitor !== false) {
    const monitor = options.evaluateOpenaiMonitor ?? evaluateOpenaiMonitor;
    const catalogCheck = options.checkOpenaiCatalog ?? checkOpenaiCatalog;
    const runMonitor = () => Promise.resolve().then(() => monitor()).catch(error => console.error(`OpenAI monitor: ${error.message}`));
    const runCatalogCheck = () => Promise.resolve().then(() => catalogCheck()).catch(error => console.error(`OpenAI catalog check: ${error.message}`));
    const monitorTimer = setInterval(runMonitor, options.openaiMonitorIntervalMs ?? 60_000);
    const catalogTimer = setInterval(runCatalogCheck, options.openaiCatalogIntervalMs ?? 6 * 60 * 60_000);
    monitorTimer.unref();
    catalogTimer.unref();
    server.once('listening', () => {
      runMonitor();
      setTimeout(runCatalogCheck, 5_000).unref();
    });
    server.once('close', () => {
      clearInterval(monitorTimer);
      clearInterval(catalogTimer);
    });
  }
  if (options.backgroundDesignSourceMonitor !== false) {
    const scan = options.scanDesignSources ?? scanDesignSourcesAsync;
    const runScan = () => Promise.resolve().then(() => scan(options.designSources)).catch(error => console.error(`Design source monitor: ${error.message}`));
    const designSourceTimer = setInterval(runScan, options.designSourceMonitorIntervalMs ?? 6 * 60 * 60_000);
    designSourceTimer.unref();
    server.once('listening', () => setTimeout(runScan, options.designSourceInitialDelayMs ?? 10_000).unref());
    server.once('close', () => clearInterval(designSourceTimer));
  }
  if (options.backgroundRecoveryHandoff !== false) {
    const runRefresh = () => Promise.resolve()
      .then(() => recoveryHandoffService.refresh())
      .catch(error => console.error(`Recovery handoff refresh: ${error.message}`));
    const recoveryTimer = setInterval(runRefresh, options.recoveryHandoffIntervalMs ?? 60 * 60_000);
    recoveryTimer.unref();
    server.once('listening', () => setTimeout(runRefresh, options.recoveryHandoffInitialDelayMs ?? 15_000).unref());
    server.once('close', () => clearInterval(recoveryTimer));
  }
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
