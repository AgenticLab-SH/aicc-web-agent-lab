#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function usage() {
  console.log(`Usage:
  knowledge-review.mjs status [--api-base URL] [--aicc-root PATH]
  knowledge-review.mjs preview --source ID [--source ID ...] [--api-base URL] [--aicc-root PATH]
  knowledge-review.mjs run --confirmed --source ID [--source ID ...] [--api-base URL] [--aicc-root PATH] [--timeout-seconds N]`);
}

function sourceRootFrom(start) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, 'src', 'knowledge-review', 'service.mjs'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function executableOnPath(name) {
  for (const directory of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate);
    } catch { /* continue */ }
  }
  return null;
}

function resolveAiccRoot(explicitRoot) {
  const candidates = [explicitRoot, process.env.AICC_SOURCE_ROOT, process.cwd()].filter(Boolean);
  const executable = executableOnPath('aicc');
  if (executable) candidates.push(path.dirname(executable));
  for (const candidate of candidates) {
    const root = sourceRootFrom(candidate);
    if (root) return root;
  }
  throw new Error('AICC source root not found; pass --aicc-root /absolute/path/to/open-AICC');
}

function parse(argv) {
  const result = {
    command: argv.shift() ?? null,
    root: null,
    sourceIds: [],
    confirmed: false,
    apiBase: process.env.AICC_DASHBOARD_URL?.trim() || 'http://192.0.2.1:4381',
    timeoutSeconds: 1_800
  };
  while (argv.length) {
    const token = argv.shift();
    if (token === '--aicc-root') result.root = argv.shift() ?? null;
    else if (token === '--source') result.sourceIds.push(argv.shift() ?? '');
    else if (token === '--confirmed') result.confirmed = true;
    else if (token === '--api-base') result.apiBase = argv.shift() ?? '';
    else if (token === '--timeout-seconds') result.timeoutSeconds = Number(argv.shift());
    else throw new Error(`unknown argument: ${token}`);
  }
  if (result.sourceIds.some(id => !id)) throw new Error('--source requires a source id');
  if (!/^https?:\/\//.test(result.apiBase)) throw new Error('--api-base requires an HTTP(S) URL');
  if (!Number.isInteger(result.timeoutSeconds) || result.timeoutSeconds < 30 || result.timeoutSeconds > 7_200) {
    throw new Error('--timeout-seconds must be an integer between 30 and 7200');
  }
  return result;
}

function pause(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function apiJson(base, pathname, { method = 'GET', body, retries = 0 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    let payload;
    try {
      response = await fetch(new URL(pathname, base), {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      payload = await response.json();
    } catch (error) {
      lastError = Object.assign(new Error(`AICC Dashboard API unavailable at ${base}`), { code: 'dashboard_unavailable', cause: error });
      if (attempt === retries) throw lastError;
      await pause(Math.min(1_000, 100 * (2 ** attempt)));
      continue;
    }
    if (response.ok) return payload;
    const error = new Error(payload.error ?? `Dashboard API returned HTTP ${response.status}`);
    error.code = payload.code ?? 'dashboard_api_failed';
    error.status = response.status;
    if (error.code !== 'writer_busy' || attempt === retries) throw error;
    lastError = error;
    await pause(Math.min(1_000, 100 * (2 ** attempt)));
  }
  throw lastError;
}

async function localService(args) {
  const root = resolveAiccRoot(args.root);
  const moduleUrl = pathToFileURL(path.join(root, 'src', 'knowledge-review', 'service.mjs')).href;
  const { createKnowledgeReviewService } = await import(moduleUrl);
  return createKnowledgeReviewService();
}

async function statusWithFallback(args) {
  try { return await apiJson(args.apiBase, '/api/knowledge-review/status'); }
  catch (error) {
    if (error.code !== 'dashboard_unavailable') throw error;
    return (await localService(args)).status();
  }
}

async function waitForScheduler(args, jobId) {
  const deadline = Date.now() + (args.timeoutSeconds * 1_000);
  while (Date.now() < deadline) {
    let status;
    try { status = await apiJson(args.apiBase, '/api/knowledge-review/status'); }
    catch (error) {
      if (error.code !== 'dashboard_unavailable') throw error;
      await pause(1_000);
      continue;
    }
    const active = [...(status.queuedJobIds ?? []), ...(status.runningJobIds ?? [])];
    if (status.latestRun?.jobId === jobId && !active.includes(jobId)) return status.latestRun;
    if (!active.includes(jobId)) {
      const service = await localService(args);
      const job = service.manager.read(jobId);
      if (['failed', 'cancelled'].includes(job.state)) {
        const error = new Error(`knowledge review job ${job.state}: ${job.terminalReason ?? 'no terminal reason'}`);
        error.code = `knowledge_review_${job.state}`;
        throw error;
      }
    }
    await pause(2_000);
  }
  const error = new Error(`scheduler did not finish ${jobId} within ${args.timeoutSeconds} seconds`);
  error.code = 'knowledge_review_timeout';
  throw error;
}

function runWindowsSchedulerOnce(args) {
  if (process.platform !== 'win32') return Promise.resolve({ skipped: true, reason: 'platform-scheduler' });
  const root = resolveAiccRoot(args.root);
  const scheduler = path.join(root, 'src', 'local-scheduler.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scheduler], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error('Windows scheduler tick exceeded the review timeout'), { code: 'knowledge_review_timeout' }));
    }, args.timeoutSeconds * 1_000);
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4_096); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code === 0) resolve({ ok: true, executionOwner: 'aicc-local-scheduler' });
      else reject(Object.assign(new Error(stderr.trim() || `Windows scheduler exited with code ${code}`), { code: 'scheduler_failed' }));
    });
  });
}

async function startWindowsDashboardIfNeeded(args) {
  try {
    await apiJson(args.apiBase, '/api/knowledge-review/status');
    return null;
  } catch (error) {
    if (error.code !== 'dashboard_unavailable' || process.platform !== 'win32') throw error;
  }
  const root = resolveAiccRoot(args.root);
  const child = spawn(process.execPath, [path.join(root, 'src', 'bootstrap.mjs'), 'start'], {
    cwd: root,
    windowsHide: true,
    stdio: 'ignore'
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await pause(100);
    try {
      await apiJson(args.apiBase, '/api/knowledge-review/status');
      return child;
    } catch (error) {
      if (error.code !== 'dashboard_unavailable') {
        child.kill();
        throw error;
      }
    }
  }
  child.kill();
  throw Object.assign(new Error(`AICC Dashboard did not start at ${args.apiBase}`), { code: 'dashboard_unavailable' });
}

const args = parse(process.argv.slice(2));
if (!['status', 'preview', 'run'].includes(args.command)) {
  usage();
  process.exitCode = 2;
} else {
  const sourceIds = args.sourceIds.length ? args.sourceIds : undefined;
  let result;
  if (args.command === 'status') {
    result = await statusWithFallback(args);
  } else if (args.command === 'preview') {
    try { result = await apiJson(args.apiBase, '/api/knowledge-review/preview', { method: 'POST', body: { sourceIds } }); }
    catch (error) {
      if (error.code !== 'dashboard_unavailable') throw error;
      result = (await localService(args)).preview({ sourceIds });
    }
  } else {
    if (!args.confirmed) throw new Error('run requires --confirmed after an explicit request or an eligible stale/changelog task-entry trigger');
    if (!sourceIds) throw new Error('run requires at least one exact --source');
    const localDashboard = await startWindowsDashboardIfNeeded(args);
    try {
      const requestId = `agent-platform-review-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
      const preview = await apiJson(args.apiBase, '/api/knowledge-review/preview', { method: 'POST', body: { sourceIds } });
      const submitted = await apiJson(args.apiBase, '/api/knowledge-review/jobs', {
        method: 'POST',
        retries: 8,
        body: { sourceIds, confirmed: true, requestId, idempotencyKey: requestId }
      });
      const schedulerAttempt = runWindowsSchedulerOnce(args).then(value => ({ value }), error => ({ error }));
      const completed = await waitForScheduler(args, submitted.job.jobId);
      const schedulerOutcome = await schedulerAttempt;
      if (schedulerOutcome.error) throw schedulerOutcome.error;
      const scheduler = schedulerOutcome.value;
      result = { preview, submitted, completed, scheduler, executionOwner: 'aicc-local-scheduler' };
    } finally {
      localDashboard?.kill();
    }
  }
  console.log(JSON.stringify(result, null, 2));
}
