#!/usr/bin/env node

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const argv = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith('--')) continue;
  const key = token.slice(2);
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) {
    argv.set(key, next);
    index += 1;
  } else {
    argv.set(key, 'true');
  }
}

const required = (name) => {
  const value = argv.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
};

const sourceUrl = new URL(required('url'));
const scenarioPath = path.resolve(required('scenario'));
const outDir = path.resolve(required('out'));
const allowRemote = argv.get('allow-remote') === 'true';
const timeoutMs = Number(argv.get('timeout') || 15000);
const gifName = argv.get('gif') || '';
const posterName = argv.get('poster') || '';
const sourceRoot = argv.get('source-root') ? path.resolve(argv.get('source-root')) : '';
const localHosts = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1']);
const sensitiveParam = /(?:token|secret|password|passwd|session|code|key|auth|credential)/i;

if (!['http:', 'https:'].includes(sourceUrl.protocol)) throw new Error('Only http(s) URLs are supported');
if (!localHosts.has(sourceUrl.hostname) && !allowRemote) {
  throw new Error('Remote capture requires --allow-remote. Prefer a production-like local build.');
}
for (const key of sourceUrl.searchParams.keys()) {
  if (sensitiveParam.test(key)) throw new Error(`Sensitive URL parameter is not allowed: ${key}`);
}

const scenario = JSON.parse(await fs.readFile(scenarioPath, 'utf8'));
const claimStates = new Set(['implemented', 'runtime_verified', 'authenticated_only', 'development', 'unknown']);
if (!String(scenario.title || '').trim()) throw new Error('Scenario title is required');
if (!claimStates.has(scenario.claimState)) {
  throw new Error(`Scenario claimState must be one of: ${[...claimStates].join(', ')}`);
}
if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) throw new Error('Scenario steps are required');
const viewport = {
  width: Number(scenario.viewport?.width || argv.get('width') || 1440),
  height: Number(scenario.viewport?.height || argv.get('height') || 900),
  deviceScaleFactor: Number(scenario.viewport?.deviceScaleFactor || 1),
  mobile: scenario.viewport?.mobile === true,
};
const nativeWindow = scenario.nativeWindow === true;
const nativeCaptureHeight = Number(scenario.nativeCaptureHeight || 0);
if (viewport.width < 320 || viewport.height < 320 || viewport.deviceScaleFactor <= 0) {
  throw new Error('Viewport must be at least 320x320 with a positive deviceScaleFactor');
}

const allowedActions = new Set([
  'wait', 'waitFor', 'authenticateLocal', 'click', 'clickAndSwitchPopup', 'type', 'select', 'scroll', 'press',
  'assertVisible', 'assertText', 'measure', 'assertMeasure', 'capture',
]);
for (const step of scenario.steps) {
  if (!allowedActions.has(step?.action)) throw new Error(`Unsupported action: ${step?.action || '(missing)'}`);
  if (step.action === 'authenticateLocal') {
    if (!localHosts.has(sourceUrl.hostname)) throw new Error('authenticateLocal is limited to local source URLs');
    const endpoint = new URL(String(step.endpoint || ''), sourceUrl);
    if (endpoint.origin !== sourceUrl.origin || !endpoint.pathname.startsWith('/') || endpoint.search || endpoint.hash) {
      throw new Error('authenticateLocal endpoint must be a query-free same-origin path');
    }
    for (const field of ['usernameEnv', 'passwordEnv']) {
      if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(String(step[field] || ''))) {
        throw new Error(`authenticateLocal ${field} must name an uppercase environment variable`);
      }
    }
    for (const field of ['usernameField', 'passwordField']) {
      if (step[field] !== undefined && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(String(step[field]))) {
        throw new Error(`authenticateLocal ${field} must be a JSON field name`);
      }
    }
  }
}

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const found = candidates.find((candidate) => fsSync.existsSync(candidate));
  if (!found) throw new Error('Chrome or Edge was not found. Set CHROME_PATH to an existing executable.');
  return found;
}

async function waitForJson(url, timeout) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timeout')), 5000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(event.error || new Error('CDP connection failed'));
      }, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
        else pending.resolve(message.result);
        return;
      }
      this.events.push(message);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
    });
  }

  close() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    try { this.ws?.close(); } catch { /* best effort */ }
  }
}

function safeFrameName(value, index) {
  const normalized = String(value || `frame-${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || `frame-${index + 1}`;
}

function redactUrl(value) {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (sensitiveParam.test(key)) url.searchParams.set(key, '[REDACTED]');
  }
  url.hash = '';
  return url.toString();
}

function inspectGit(root) {
  if (!root) return null;
  const run = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const revision = run(['rev-parse', 'HEAD']);
  const status = run(['status', '--porcelain']);
  if (revision.status !== 0 || status.status !== 0) return { root: path.basename(root), unavailable: true };
  return {
    root: path.basename(root),
    revision: revision.stdout.trim(),
    dirty: status.stdout.trim().length > 0,
  };
}

async function sha256(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Page evaluation failed');
  return result.result?.value;
}

async function waitForVisible(cdp, sessionId, selector, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const visible = await evaluate(cdp, sessionId, `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })()`);
    if (visible) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Visible selector timeout: ${selector}`);
}

async function waitForDocumentReady(cdp, sessionId, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await evaluate(cdp, sessionId, 'document.readyState');
    if (ready === 'complete') return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error('Timed out waiting for the page to finish loading');
}

async function attachPageTarget(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Emulation.setEmulatedMedia', { media: 'screen' }, sessionId);
  return sessionId;
}

async function clickWithPointer(cdp, sessionId, selector, timeout) {
  await waitForVisible(cdp, sessionId, selector, timeout);
  const point = await evaluate(cdp, sessionId, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node || node.disabled || node.getAttribute('aria-disabled') === 'true') return null;
    node.scrollIntoView({ block:'center', inline:'center' });
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new Error(`Clickable selector unavailable: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
}

async function waitForPopupTarget(cdp, openerTargetId, previousTargetIds, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { targetInfos = [] } = await cdp.send('Target.getTargets');
    const target = targetInfos.find((item) => (
      item.type === 'page'
      && !previousTargetIds.has(item.targetId)
      && (item.openerId === openerTargetId || item.url !== 'about:blank')
    ));
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Popup target did not open');
}

async function measureSelector(cdp, sessionId, selector) {
  const result = await evaluate(cdp, sessionId, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
      right: Math.round(rect.right * 100) / 100,
      bottom: Math.round(rect.bottom * 100) / 100
    };
  })()`);
  if (!result) throw new Error(`Measurement selector unavailable: ${selector}`);
  return result;
}

async function runStep(cdp, context, step, measurements, measurementAssertions) {
  const sessionId = context.sessionId;
  const selector = step.selector ? String(step.selector) : '';
  if (step.action === 'wait') {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(step.ms || 0))));
    return;
  }
  if (step.action === 'waitFor') {
    await waitForVisible(cdp, sessionId, selector, Number(step.timeoutMs || timeoutMs));
    return;
  }
  if (step.action === 'press') {
    const key = String(step.key || '');
    if (!/^(?:Tab|Enter|Escape|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Space)$/.test(key)) {
      throw new Error(`Unsupported key: ${key}`);
    }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key }, sessionId);
    return;
  }
  if (step.action === 'authenticateLocal') {
    const username = process.env[String(step.usernameEnv || '')];
    const password = process.env[String(step.passwordEnv || '')];
    if (!username || !password) throw new Error('authenticateLocal credential environment variables are required');
    const endpoint = new URL(String(step.endpoint), sourceUrl).pathname;
    const usernameField = String(step.usernameField || 'username');
    const passwordField = String(step.passwordField || 'password');
    const result = await evaluate(cdp, sessionId, `(async () => {
      const response = await fetch(${JSON.stringify(endpoint)}, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          [${JSON.stringify(usernameField)}]: ${JSON.stringify(username)},
          [${JSON.stringify(passwordField)}]: ${JSON.stringify(password)}
        })
      });
      return { ok: response.ok, status: response.status };
    })()`);
    if (!result?.ok) throw new Error(`authenticateLocal failed with HTTP ${result?.status || 'unknown'}`);
    if (step.reload !== false) {
      await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
      await waitForDocumentReady(cdp, sessionId, Number(step.timeoutMs || timeoutMs));
    }
    return;
  }
  if (!selector) throw new Error(`${step.action} requires selector`);
  if (step.action === 'waitFor' || step.action === 'assertVisible') {
    await waitForVisible(cdp, sessionId, selector, Number(step.timeoutMs || timeoutMs));
    return;
  }
  if (step.action === 'click') {
    await waitForVisible(cdp, sessionId, selector, Number(step.timeoutMs || timeoutMs));
    const result = await evaluate(cdp, sessionId, `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node || node.disabled || node.getAttribute('aria-disabled') === 'true') return { ok:false };
      node.scrollIntoView({ block:'center', inline:'center' }); node.click(); return { ok:true };
    })()`);
    if (!result?.ok) throw new Error(`Clickable selector unavailable: ${selector}`);
    return;
  }
  if (step.action === 'clickAndSwitchPopup') {
    if (!nativeWindow) throw new Error('clickAndSwitchPopup requires scenario.nativeWindow=true');
    const { targetInfos = [] } = await cdp.send('Target.getTargets');
    const previousTargetIds = new Set(targetInfos.map((item) => item.targetId));
    await clickWithPointer(cdp, sessionId, selector, Number(step.timeoutMs || timeoutMs));
    const popupTarget = await waitForPopupTarget(cdp, context.targetId, previousTargetIds, Number(step.timeoutMs || timeoutMs));
    context.targetId = popupTarget.targetId;
    context.sessionId = await attachPageTarget(cdp, popupTarget.targetId);
    await waitForDocumentReady(cdp, context.sessionId, Number(step.timeoutMs || timeoutMs));
    return;
  }
  if (step.action === 'scroll') {
    const ok = await evaluate(cdp, sessionId, `(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node)return false; node.scrollIntoView({block:'center',inline:'center'}); return true; })()`);
    if (!ok) throw new Error(`Scroll selector unavailable: ${selector}`);
    return;
  }
  if (step.action === 'type') {
    const result = await evaluate(cdp, sessionId, `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node || !('value' in node)) return { ok:false, reason:'missing' };
      const type = String(node.type || '').toLowerCase();
      const autocomplete = String(node.autocomplete || '').toLowerCase();
      if (type === 'password' || autocomplete.includes('password')) return { ok:false, reason:'password' };
      node.focus(); node.value = ${JSON.stringify(String(step.text ?? ''))};
      node.dispatchEvent(new Event('input', { bubbles:true }));
      node.dispatchEvent(new Event('change', { bubbles:true }));
      return { ok:true };
    })()`);
    if (!result?.ok) throw new Error(result?.reason === 'password' ? 'Password input capture is forbidden' : `Input unavailable: ${selector}`);
    return;
  }
  if (step.action === 'select') {
    const ok = await evaluate(cdp, sessionId, `(() => {
      const node=document.querySelector(${JSON.stringify(selector)}); if(!(node instanceof HTMLSelectElement))return false;
      node.value=${JSON.stringify(String(step.value ?? ''))}; node.dispatchEvent(new Event('change',{bubbles:true})); return node.value===${JSON.stringify(String(step.value ?? ''))};
    })()`);
    if (!ok) throw new Error(`Select value unavailable: ${selector}`);
    return;
  }
  if (step.action === 'assertText') {
    const ok = await evaluate(cdp, sessionId, `(() => { const node=document.querySelector(${JSON.stringify(selector)}); return Boolean(node && (node.textContent || '').includes(${JSON.stringify(String(step.contains ?? ''))})); })()`);
    if (!ok) throw new Error(`Text assertion failed: ${selector}`);
    return;
  }
  if (step.action === 'measure') {
    const name = safeFrameName(step.name, measurements.size);
    measurements.set(name, {
      name,
      selector,
      rect: await measureSelector(cdp, sessionId, selector),
    });
    return;
  }
  if (step.action === 'assertMeasure') {
    const name = safeFrameName(step.name, measurements.size);
    const reference = measurements.get(name);
    if (!reference) throw new Error(`Measurement reference not found: ${name}`);
    const current = await measureSelector(cdp, sessionId, selector);
    const fields = Array.isArray(step.fields) && step.fields.length ? step.fields : ['width', 'height'];
    const tolerance = Math.max(0, Number(step.tolerance || 0));
    const deltas = {};
    for (const field of fields) {
      if (!['x', 'y', 'width', 'height', 'right', 'bottom'].includes(field)) throw new Error(`Unsupported measurement field: ${field}`);
      deltas[field] = Math.round((current[field] - reference.rect[field]) * 100) / 100;
      if (Math.abs(deltas[field]) > tolerance) {
        throw new Error(`Measurement assertion failed for ${name}.${field}: ${reference.rect[field]} -> ${current[field]} (tolerance ${tolerance})`);
      }
    }
    measurementAssertions.push({ name, selector, fields, tolerance, before: reference.rect, after: current, deltas });
  }
}

async function buildGif(frames, targetPath) {
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (ffmpeg.status !== 0) throw new Error('ffmpeg is required when --gif is requested');
  const manifestPath = path.join(outDir, '.frames.ffconcat');
  const quote = (value) => value.replaceAll("'", "'\\''");
  const lines = ['ffconcat version 1.0'];
  for (const frame of frames) {
    lines.push(`file '${quote(frame.path)}'`, `duration ${Math.max(100, frame.durationMs) / 1000}`);
  }
  lines.push(`file '${quote(frames.at(-1).path)}'`, 'duration 0.1');
  await fs.writeFile(manifestPath, `${lines.join('\n')}\n`);
  const filter = "fps=10,scale='min(960,iw)':-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer";
  const run = spawnSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', manifestPath, '-vf', filter, '-loop', '0', targetPath], { encoding: 'utf8' });
  await fs.rm(manifestPath, { force: true });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr.slice(-1200)}`);
}

await fs.mkdir(outDir, { recursive: true });
const browserPath = findBrowser();
const port = 19000 + Math.floor(Math.random() * 20000);
const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'actual-web-evidence-'));
const browser = spawn(browserPath, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  `--window-size=${viewport.width},${viewport.height}`,
  '--window-position=0,0',
  '--force-device-scale-factor=1',
  '--no-first-run',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' });

let cdp;
const frames = [];
const measurements = new Map();
const measurementAssertions = [];
try {
  const version = await waitForJson(`http://192.0.2.1:${port}/json/version`, timeoutMs);
  cdp = new CdpClient(version.webSocketDebuggerUrl);
  await cdp.connect();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const context = { targetId, sessionId: await attachPageTarget(cdp, targetId) };
  if (nativeWindow) {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId });
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 0, top: 0, width: viewport.width, height: viewport.height, windowState: 'normal' },
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      ...viewport,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    }, context.sessionId);
  } else {
    await cdp.send('Emulation.setDeviceMetricsOverride', viewport, context.sessionId);
  }
  await cdp.send('Page.navigate', { url: sourceUrl.toString() }, context.sessionId);
  await waitForDocumentReady(cdp, context.sessionId, timeoutMs);

  for (let index = 0; index < scenario.steps.length; index += 1) {
    const step = scenario.steps[index];
    if (step.action !== 'capture') {
      await runStep(cdp, context, step, measurements, measurementAssertions);
      continue;
    }
    const frameName = `${String(frames.length + 1).padStart(2, '0')}-${safeFrameName(step.name, index)}.png`;
    const framePath = path.join(outDir, frameName);
    if (nativeWindow && nativeCaptureHeight > 0) {
      const nativeWidth = await evaluate(cdp, context.sessionId, 'window.outerWidth');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: Math.max(320, Number(nativeWidth || viewport.width)),
        height: Math.max(320, nativeCaptureHeight),
        deviceScaleFactor: viewport.deviceScaleFactor,
        mobile: false,
        screenWidth: viewport.width,
        screenHeight: viewport.height,
      }, context.sessionId);
    }
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, context.sessionId);
    await fs.writeFile(framePath, Buffer.from(shot.data, 'base64'));
    const windowMetrics = await evaluate(cdp, context.sessionId, `({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      screenX: window.screenX,
      screenY: window.screenY,
      availWidth: window.screen.availWidth,
      availHeight: window.screen.availHeight
    })`);
    frames.push({ name: frameName, path: framePath, durationMs: Number(step.durationMs || 900), windowMetrics });
  }
  if (!frames.length) throw new Error('Scenario must include at least one capture step');

  if (gifName) await buildGif(frames, path.join(outDir, path.basename(gifName)));
  if (posterName) await fs.copyFile(frames.at(-1).path, path.join(outDir, path.basename(posterName)));

  const finalUrl = await evaluate(cdp, context.sessionId, 'location.href');
  const errors = cdp.events.flatMap((event) => {
    if (event.method === 'Runtime.exceptionThrown') return [{ type: 'exception', text: event.params?.exceptionDetails?.text || 'runtime exception' }];
    if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') {
      return [{ type: 'console', text: (event.params.args || []).map((item) => item.value || item.description || '').join(' ').slice(0, 500) }];
    }
    if (event.method === 'Network.loadingFailed' && !event.params?.canceled) return [{ type: 'network', text: String(event.params?.errorText || 'loading failed').slice(0, 500) }];
    return [];
  });
  const manifest = {
    schemaVersion: 1,
    title: String(scenario.title || ''),
    claimState: scenario.claimState,
    capturedAt: new Date().toISOString(),
    runtime: localHosts.has(sourceUrl.hostname) ? 'local-isolated-browser' : 'remote-isolated-browser',
    requestedUrl: redactUrl(sourceUrl.toString()),
    finalUrl: redactUrl(finalUrl),
    viewport,
    nativeWindow,
    nativeCaptureHeight: nativeCaptureHeight || null,
    source: inspectGit(sourceRoot),
    steps: scenario.steps.map((step) => ({
      action: step.action,
      selector: step.selector || undefined,
      endpoint: step.action === 'authenticateLocal' ? step.endpoint : undefined,
      credentialSource: step.action === 'authenticateLocal'
        ? {
            usernameEnv: step.usernameEnv,
            passwordEnv: step.passwordEnv,
            usernameField: step.usernameField || 'username',
            passwordField: step.passwordField || 'password',
            values: '[REDACTED]',
          }
        : undefined,
      name: step.name || undefined,
      value: step.action === 'type' || step.action === 'select' ? '[REDACTED]' : undefined,
      durationMs: step.durationMs || undefined,
    })),
    measurements: [...measurements.values()],
    measurementAssertions,
    frames: await Promise.all(frames.map(async (frame) => ({
      file: frame.name,
      durationMs: frame.durationMs,
      windowMetrics: frame.windowMetrics,
      sha256: await sha256(frame.path),
    }))),
    gif: gifName ? path.basename(gifName) : null,
    poster: posterName ? path.basename(posterName) : null,
    errors,
  };
  await fs.writeFile(path.join(outDir, 'evidence.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, outDir, claimState: manifest.claimState, frames: frames.length, gif: manifest.gif, poster: manifest.poster, errors: errors.length }));
} finally {
  cdp?.close();
  if (browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once('exit', resolve));
    browser.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(profileDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error?.code) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 160 * (attempt + 1)));
    }
  }
}
