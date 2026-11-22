import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const executable = process.env.AICC_ISOLATED_QA_EXECUTABLE?.trim();
const profile = process.env.AICC_ISOLATED_QA_PROFILE?.trim();
const port = Number(process.env.AICC_ISOLATED_QA_PORT);
const url = process.env.AICC_ISOLATED_QA_URL?.trim() || 'http://127.0.0.1:4381/';
const outputRoot = process.env.AICC_ISOLATED_QA_OUTPUT?.trim();
const reportPath = process.env.AICC_ISOLATED_QA_REPORT?.trim();
if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) throw new Error('AICC_ISOLATED_QA_EXECUTABLE must be an existing absolute path');
if (!profile || !path.isAbsolute(profile)) throw new Error('AICC_ISOLATED_QA_PROFILE must be an absolute configured path');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('AICC_ISOLATED_QA_PORT must be the configured isolated QA port');
if (!outputRoot || !path.isAbsolute(outputRoot)) throw new Error('AICC_ISOLATED_QA_OUTPUT must be an absolute task-owned evidence path');
if (typeof WebSocket !== 'function') throw new Error('this smoke requires a Node runtime with the standard WebSocket client');

const endpoint = `http://127.0.0.1:${port}`;
const screenshotPath = path.join(outputRoot, 'isolated-qa.png');
let child = null;
let targetId = null;

async function reachable() {
  try { return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(300) })).ok; }
  catch { return false; }
}

async function waitUntil(operation, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await operation();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`${label} timeout`);
}

function cdpClient(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (message.method) events.push(message);
  });
  return {
    ready,
    events,
    command: async (method, params = {}) => {
      await ready;
      const id = nextId++;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return response;
    },
    close: () => socket.close()
  };
}

function waitForExit(processHandle, timeoutMs) {
  return Promise.race([
    new Promise(resolve => processHandle.once('exit', (code, signal) => resolve({ code, signal, forced: false }))),
    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))
  ]);
}

try {
  if (await reachable()) throw new Error(`isolated QA endpoint ${port} is already in use; refusing to attach or stop it`);
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  child = spawn(executable, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--profile-directory=Default', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const browserPid = child.pid;
  await waitUntil(reachable, 10_000, 'isolated QA browser readiness');
  const createdResponse = await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(3_000) });
  if (!createdResponse.ok) throw new Error(`target creation failed: ${createdResponse.status}`);
  const created = await createdResponse.json();
  targetId = created.id;
  if (!targetId || !created.webSocketDebuggerUrl) throw new Error('CDP did not return an exact task-owned target');

  const cdp = cdpClient(created.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.command('Runtime.enable');
  await cdp.command('Page.enable');
  await cdp.command('Network.enable');
  await cdp.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.command('Page.navigate', { url });
  await waitUntil(async () => {
    const state = await cdp.command('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    return state.result?.value === 'complete';
  }, 10_000, 'page load');
  await waitUntil(async () => {
    const rendered = await cdp.command('Runtime.evaluate', {
      expression: '/브라우저 세션 Broker/.test(document.body?.innerText||"")',
      returnByValue: true
    });
    return rendered.result?.value === true;
  }, 15_000, 'browser broker render');
  const visible = await cdp.command('Runtime.evaluate', {
    expression: '({title:document.title,hasControlCenter:/open-AICC/i.test(document.body?.innerText||""),hasBrowserBroker:/브라우저 세션 Broker/.test(document.body?.innerText||""),overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth})',
    returnByValue: true
  });
  const screenshot = await cdp.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
  const consoleErrors = cdp.events.filter(event => event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error').length
    + cdp.events.filter(event => event.method === 'Runtime.exceptionThrown').length;
  const networkFailures = cdp.events.filter(event => event.method === 'Network.loadingFailed').length;
  cdp.close();

  const closedResponse = await fetch(`${endpoint}/json/close/${targetId}`, { signal: AbortSignal.timeout(3_000) });
  const targetClosed = closedResponse.ok && await waitUntil(async () => {
    const targets = await (await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(1_000) })).json();
    return !targets.some(target => target.id === targetId);
  }, 5_000, 'exact target close');
  const gracefulExit = waitForExit(child, 5_000);
  child.kill('SIGTERM');
  let processExit = await gracefulExit;
  if (!processExit) {
    child.kill('SIGKILL');
    processExit = { ...(await waitForExit(child, 3_000)), forced: true };
  }
  child = null;
  const report = {
    ok: targetClosed && consoleErrors === 0 && visible.result?.value?.overflow === false && visible.result?.value?.hasControlCenter === true && visible.result?.value?.hasBrowserBroker === true,
    identity: { role: 'isolated-qa', engine: 'chromium', executable, userDataRoot: profile, profile: 'Default', cdpEndpoint: endpoint, owner: 'phase08-task-owned-smoke' },
    process: { pid: browserPid, exit: processExit },
    target: { targetId, ownership: 'task-created', url, closed: targetClosed },
    page: { title: visible.result?.value?.title ?? null, controlCenterMarker: visible.result?.value?.hasControlCenter ?? false, browserBrokerMarker: visible.result?.value?.hasBrowserBroker ?? false, horizontalOverflow: visible.result?.value?.overflow ?? null, consoleErrors, networkFailures },
    screenshot: { path: screenshotPath, bytes: fs.statSync(screenshotPath).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(screenshotPath)).digest('hex') },
    userTabsTouched: 0,
    providerOrAccountChanged: false
  };
  if (reportPath) fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} finally {
  if (targetId && await reachable()) await fetch(`${endpoint}/json/close/${targetId}`, { signal: AbortSignal.timeout(2_000) }).catch(() => {});
  if (child) child.kill('SIGTERM');
}
