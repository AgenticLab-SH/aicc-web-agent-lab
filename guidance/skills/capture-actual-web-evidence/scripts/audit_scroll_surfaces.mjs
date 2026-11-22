#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith('--')) continue;
  const next = process.argv[index + 1];
  args.set(token.slice(2), next && !next.startsWith('--') ? next : 'true');
  if (next && !next.startsWith('--')) index += 1;
}
const required = (key) => {
  const value = args.get(key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
};

const manifestPath = path.resolve(required('manifest'));
const outDir = path.resolve(required('out'));
const allowRemote = args.get('allow-remote') === 'true';
const timeoutMs = Math.max(3000, Number(args.get('timeout') || 20000));
const localHosts = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1']);
const sensitiveParam = /(?:token|secret|password|passwd|session|code|key|auth|credential)/i;

function id(value, fallback) {
  const result = String(value || fallback).toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (!result) throw new Error(`Invalid id: ${value}`);
  return result;
}

function normalizeManifest(input) {
  if (!String(input.title || '').trim()) throw new Error('Manifest title is required');
  if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 24) {
    throw new Error('Manifest requires 1-24 targets');
  }
  const defaults = input.defaultViewports || [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844, mobile: true },
  ];
  const seen = new Set();
  const targets = input.targets.map((target, targetIndex) => {
    const targetId = id(target.id, `target-${targetIndex + 1}`);
    if (seen.has(targetId)) throw new Error(`Duplicate target id: ${targetId}`);
    seen.add(targetId);
    const url = new URL(String(target.url || ''));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Only http(s) URLs are supported: ${targetId}`);
    if (!localHosts.has(url.hostname) && !allowRemote) throw new Error(`Remote audit requires --allow-remote: ${targetId}`);
    for (const key of url.searchParams.keys()) {
      if (sensitiveParam.test(key)) throw new Error(`Sensitive URL parameter is not allowed: ${key}`);
    }
    const sourceViewports = target.viewports || defaults;
    if (!Array.isArray(sourceViewports) || !sourceViewports.length || sourceViewports.length > 4) {
      throw new Error(`Target ${targetId} requires 1-4 viewports`);
    }
    const viewports = sourceViewports.map((viewport, viewportIndex) => {
      const width = Number(viewport.width);
      const height = Number(viewport.height);
      if (width < 320 || width > 2560 || height < 320 || height > 1600) {
        throw new Error(`Viewport out of range for ${targetId}`);
      }
      return {
        name: id(viewport.name, `viewport-${viewportIndex + 1}`), width, height,
        deviceScaleFactor: Math.min(2, Math.max(1, Number(viewport.deviceScaleFactor || 1))),
        mobile: viewport.mobile === true,
      };
    });
    return {
      id: targetId, url, viewports,
      waitFor: target.waitFor ? String(target.waitFor) : '',
      scrollSelector: target.scrollSelector ? String(target.scrollSelector) : '',
      contentPolicy: target.contentPolicy === 'public' ? 'public' : 'private',
      settleMs: Math.min(2000, Math.max(0, Number(target.settleMs || 220))),
      maxStops: Math.min(24, Math.max(1, Number(target.maxStops || 16))),
    };
  });
  return { title: String(input.title), targets };
}

const contract = normalizeManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
if (args.get('validate-only') === 'true') {
  console.log(JSON.stringify({ ok: true, title: contract.title, targets: contract.targets.length }));
  process.exit(0);
}

function browserExecutable() {
  const candidates = [process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
  const found = candidates.find((candidate) => fsSync.existsSync(candidate));
  if (!found) throw new Error('Chrome or Edge was not found. Set CHROME_PATH.');
  return found;
}

async function waitForJson(url) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class CDP {
  constructor(url) { this.url = url; this.sequence = 0; this.pending = new Map(); this.events = []; }
  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timeout')), 5000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const pending = message.id && this.pending.get(message.id);
      if (!pending) { this.events.push(message); return; }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}, sessionId) {
    const message = { id: ++this.sequence, method, params };
    if (sessionId) message.sessionId = sessionId;
    this.socket.send(JSON.stringify(message));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(message.id)) return;
        this.pending.delete(message.id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(message.id, { resolve, reject, method, timer });
    });
  }
  close() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    try { this.socket?.close(); } catch { /* best effort */ }
  }
}

async function evaluate(cdp, sessionId, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Page evaluation failed');
  return response.result?.value;
}

async function ready(cdp, sessionId, selector) {
  const deadline = Date.now() + timeoutMs;
  const selectorDeadline = selector ? Math.min(deadline, Date.now() + 5000) : deadline;
  while (Date.now() < deadline) {
    const state = await evaluate(cdp, sessionId, `(() => {
      const node = ${JSON.stringify(selector)} ? document.querySelector(${JSON.stringify(selector)}) : document.body;
      const body = document.body;
      const bodyRect = body?.getBoundingClientRect();
      const rect = node?.getBoundingClientRect();
      return {
        documentReady: document.readyState === 'complete',
        selectorReady: Boolean(rect && rect.width > 0 && rect.height > 0),
        bodyReady: Boolean(bodyRect && bodyRect.width > 0 && bodyRect.height > 0)
      };
    })()`);
    if (state.documentReady && (state.selectorReady || (Date.now() >= selectorDeadline && state.bodyReady))) {
      await evaluate(cdp, sessionId, 'document.fonts?.ready || Promise.resolve()');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Page readiness timeout${selector ? `: ${selector}` : ''}`);
}

function safeUrl(input) {
  const url = new URL(input); url.hash = '';
  for (const key of url.searchParams.keys()) if (sensitiveParam.test(key)) url.searchParams.set(key, '[REDACTED]');
  return url.toString();
}

async function digest(file) { return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
function rank(value) { return value === 'error' ? 0 : value === 'warning' ? 1 : 2; }

function runtimeErrors(events) {
  const requestUrls = new Map(events.flatMap((event) => event.method === 'Network.requestWillBeSent'
    ? [[event.params?.requestId, String(event.params?.request?.url || '')]] : []));
  return events.flatMap((event) => {
    if (event.method === 'Runtime.exceptionThrown') return [{ severity: 'error', kind: 'runtime-exception', text: String(event.params?.exceptionDetails?.text || '').slice(0, 300) }];
    if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') return [{ severity: 'error', kind: 'runtime-console', text: (event.params.args || []).map((item) => item.value || item.description || '').join(' ').slice(0, 300) }];
    if (event.method === 'Network.loadingFailed' && !event.params?.canceled) {
      const url = requestUrls.get(event.params?.requestId) || '';
      // Cloudflare injects this managed challenge probe after the app response. Headless
      // auditing may block the probe while the first-party document and assets remain sound.
      const providerTelemetry = (() => {
        try {
          const parsed = new URL(url);
          return parsed.hostname === 'static.cloudflareinsights.com' && parsed.pathname.startsWith('/beacon.min.js/');
        } catch { return false; }
      })();
      if (url.includes('/cdn-cgi/challenge-platform/') || providerTelemetry) return [];
      const detail = [event.params?.errorText, url && safeUrl(url)].filter(Boolean).join(' ');
      return [{ severity: 'error', kind: 'runtime-network', text: detail.slice(0, 300) }];
    }
    return [];
  });
}

function html(report) {
  const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const articles = report.runs.map((run) => `<article><header><div><h2>${esc(run.targetId)} · ${esc(run.viewport.name)}</h2><p>${esc(run.finalUrl)}</p></div><strong>${run.summary.errors} errors · ${run.summary.warnings} warnings</strong></header><div class="frames">${run.frames.map((frame) => `<figure><img src="${esc(frame.file)}" alt="${esc(frame.name)}"><figcaption>${esc(frame.name)}</figcaption></figure>`).join('')}</div><ul>${run.findings.slice(0, 20).map((finding) => `<li class="${esc(finding.severity)}"><b>${esc(finding.kind)}</b> ${esc(finding.selector || '')}</li>`).join('') || '<li>자동 finding 없음</li>'}</ul></article>`).join('');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(report.title)}</title><style>:root{font-family:system-ui,sans-serif;color:#14202b;background:#eef2f5}body{margin:0;padding:24px}main{max-width:1600px;margin:auto}h1{font-size:28px}article{background:#fff;border:1px solid #cad4dc;border-radius:16px;margin:24px 0;padding:20px}article>header{display:flex;justify-content:space-between;gap:16px;align-items:start}h2{margin:0;font-size:20px}p{margin:6px 0;color:#536675;overflow-wrap:anywhere}.frames{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:18px}figure{margin:0;border:1px solid #d8e1e7;border-radius:10px;overflow:hidden;background:#f7f9fa}img{display:block;width:100%;height:auto}figcaption{padding:8px;font-size:12px}ul{columns:2;padding-left:22px}.error{color:#a2182f}.warning{color:#7b5410}@media(max-width:700px){body{padding:12px}article>header{display:block}ul{columns:1}}</style><main><h1>${esc(report.title)}</h1><p>${esc(report.capturedAt)} · ${report.summary.runs} runs · ${report.summary.errors} errors · ${report.summary.warnings} warnings</p>${articles}</main></html>`;
}

await fs.mkdir(outDir, { recursive: true });
const port = 20000 + Math.floor(Math.random() * 18000);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'scroll-audit-'));
const browser = spawn(browserExecutable(), ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let cdp;
const runs = [];
try {
  const version = await waitForJson(`http://192.0.2.1:${port}/json/version`);
  cdp = new CDP(version.webSocketDebuggerUrl); await cdp.connect();
  for (const target of contract.targets) for (const viewport of target.viewports) {
    const runDir = path.join(outDir, target.id, viewport.name); await fs.mkdir(runDir, { recursive: true });
    const eventIndex = cdp.events.length;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId); await cdp.send('Runtime.enable', {}, sessionId); await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, screenWidth: viewport.width, screenHeight: viewport.height }, sessionId);
    await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
    await cdp.send('Page.navigate', { url: target.url.toString() }, sessionId); await ready(cdp, sessionId, target.waitFor);
    await new Promise((resolve) => setTimeout(resolve, target.settleMs));
    const geometry = await evaluate(cdp, sessionId, `(() => { const root=${JSON.stringify(target.scrollSelector)}?document.querySelector(${JSON.stringify(target.scrollSelector)}):document.scrollingElement; return root&&{scrollHeight:Math.ceil(root.scrollHeight),clientHeight:Math.ceil(root.clientHeight),scrollWidth:Math.ceil(root.scrollWidth),clientWidth:Math.ceil(root.clientWidth)}; })()`);
    if (!geometry) throw new Error(`Scroll root unavailable for ${target.id}`);
    const max = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
    const step = Math.max(240, Math.floor(geometry.clientHeight * 0.82));
    const stops = [0];
    for (let value = step; value < max && stops.length < target.maxStops - 1; value += step) stops.push(value);
    if (max && stops.at(-1) !== max && stops.length < target.maxStops) stops.push(max);
    const findings = new Map(); const frames = []; let pageFacts;
    for (let index = 0; index < stops.length; index += 1) {
      const top = stops[index];
      await evaluate(cdp, sessionId, `(() => { const root=${JSON.stringify(target.scrollSelector)}?document.querySelector(${JSON.stringify(target.scrollSelector)}):document.scrollingElement;if(!root)return false;${target.scrollSelector ? `root.scrollTop=${top}` : `window.scrollTo({top:${top},behavior:'instant'})`};return true;})()`);
      await new Promise((resolve) => setTimeout(resolve, target.settleMs));
      const analysis = await evaluate(cdp, sessionId, `(() => {
        const clean=v=>String(v||'').replace(/\\s+/g,' ').trim(); const publicText=${target.contentPolicy === 'public'};
        const viewportWidth=document.documentElement.clientWidth,viewportHeight=document.documentElement.clientHeight;
        const hiddenByClosedDetails=n=>Boolean(n.closest('details:not([open])')&&!n.matches('details:not([open])>summary')&&!n.closest('details:not([open])>summary'));
        const visible=n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return !hiddenByClosedDetails(n)&&r.width>0&&r.height>0&&r.bottom>0&&r.top<viewportHeight&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>.02};
        const visuallyHidden=(n,s,r)=>s.position==='absolute'&&r.width<=2&&r.height<=2&&(s.clipPath.includes('50%')||s.clip!=='auto');
        const sel=n=>n.id?'#'+CSS.escape(n.id):n.getAttribute('data-testid')?'[data-testid="'+CSS.escape(n.getAttribute('data-testid'))+'"]':n.tagName.toLowerCase()+':' + clean(n.getAttribute('aria-label')||n.textContent).slice(0,32);
        const text=n=>publicText?clean(n.textContent).slice(0,96):''; const issues=[]; const all=[...document.querySelectorAll('body *')];
        const fixed=all.filter(n=>visible(n)&&['fixed','sticky'].includes(getComputedStyle(n).position)).map(n=>({n,r:n.getBoundingClientRect()}));
        const leaves=all.filter(n=>visible(n)&&clean(n.textContent)&&!n.children.length);
        for(const n of leaves){const s=getComputedStyle(n),r=n.getBoundingClientRect();if(!visuallyHidden(n,s,r)&&((n.scrollWidth>n.clientWidth+1&&['hidden','clip'].includes(s.overflowX))||(n.scrollHeight>n.clientHeight+1&&['hidden','clip'].includes(s.overflowY))))issues.push({severity:'error',kind:'clipped-text',selector:sel(n),text:text(n)});for(const o of fixed){if(o.n===n||o.n.contains(n)||n.contains(o.n))continue;const topOverlay=o.r.top<=2,bottomOverlay=o.r.bottom>=viewportHeight-2;if((topOverlay&&r.bottom<=o.r.bottom+3)||(bottomOverlay&&r.top>=o.r.top-3))continue;const left=Math.max(r.left,o.r.left),right=Math.min(r.right,o.r.right),top=Math.max(r.top,o.r.top),bottom=Math.min(r.bottom,o.r.bottom),x=right-left,y=bottom-top;if(x>3&&y>3){const points=[[left+x/2,top+y/2],[left+1,top+1],[right-1,bottom-1]];const blocked=points.some(([px,py])=>{const hit=document.elementFromPoint(Math.max(0,Math.min(viewportWidth-1,px)),Math.max(0,Math.min(viewportHeight-1,py)));return Boolean(hit&&(hit===o.n||o.n.contains(hit))&&hit!==n&&!n.contains(hit))});if(blocked){issues.push({severity:'error',kind:'fixed-overlap',selector:sel(n),overlay:sel(o.n),text:text(n)});break}}}}
        for(const n of all.filter(n=>visible(n)&&(n.matches('button,input:not([type=hidden]),select,textarea,[role=button]')||(n.matches('a[href]')&&getComputedStyle(n).display!=='inline')))){const r=n.getBoundingClientRect();if(r.width<40||r.height<40)issues.push({severity:'warning',kind:'small-target',selector:sel(n),text:text(n),width:r.width,height:r.height})}
        const overflow=Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth||0)-viewportWidth;if(overflow>1)issues.push({severity:'error',kind:'horizontal-overflow',selector:'document',pixels:Math.ceil(overflow)});
        const motion=all.filter(visible).filter(n=>{const s=getComputedStyle(n),active=v=>String(v).split(',').some(x=>parseFloat(x)>.01);return(s.animationName!=='none'&&active(s.animationDuration))||active(s.transitionDuration)});if(motion.length)issues.push({severity:'warning',kind:'reduced-motion-active',selector:sel(motion[0]),count:motion.length});
        if(publicText){const body=clean(document.querySelector('main')?.innerText||document.body?.innerText||'');for(const phrase of ['혁신적','탁월한','압도적','완벽한','새로운 지평','패러다임','미래를 이끄는','이를 통해','나아가']){const count=body.split(phrase).length-1;if(count)issues.push({severity:'warning',kind:'inflated-copy',selector:'main',text:phrase,count})}}
        return{title:document.title,h1:[...document.querySelectorAll('h1')].map(text),headingCount:document.querySelectorAll('h1,h2,h3').length,sectionCount:document.querySelectorAll('main section,main article').length,fontFamilies:[...new Set(leaves.map(n=>getComputedStyle(n).fontFamily))].slice(0,12),issues};
      })()`);
      pageFacts ||= { title: analysis.title, h1: analysis.h1, headingCount: analysis.headingCount, sectionCount: analysis.sectionCount, fontFamilies: analysis.fontFamilies };
      for (const finding of analysis.issues) { const key = [finding.kind, finding.selector, finding.overlay, finding.text].join('|'); if (!findings.has(key)) findings.set(key, { ...finding, firstScrollTop: top }); }
      const name = `${String(index + 1).padStart(2, '0')}-${top}.png`; const file = path.join(runDir, name);
      const image = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId); await fs.writeFile(file, Buffer.from(image.data, 'base64'));
      frames.push({ name, file: path.relative(outDir, file), scrollTop: top, sha256: await digest(file) });
    }
    const resultFindings = [...findings.values(), ...runtimeErrors(cdp.events.slice(eventIndex))].sort((a, b) => rank(a.severity) - rank(b.severity) || a.kind.localeCompare(b.kind));
    runs.push({ targetId: target.id, requestedUrl: safeUrl(target.url), finalUrl: safeUrl(await evaluate(cdp, sessionId, 'location.href')), viewport, contentPolicy: target.contentPolicy, geometry, pageFacts, frames, findings: resultFindings, summary: { errors: resultFindings.filter((item) => item.severity === 'error').length, warnings: resultFindings.filter((item) => item.severity === 'warning').length } });
    await cdp.send('Target.closeTarget', { targetId });
  }
  const report = { schemaVersion: 1, title: contract.title, capturedAt: new Date().toISOString(), manifest: path.basename(manifestPath), runs, summary: { runs: runs.length, errors: runs.reduce((sum, run) => sum + run.summary.errors, 0), warnings: runs.reduce((sum, run) => sum + run.summary.warnings, 0) } };
  await fs.writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`); await fs.writeFile(path.join(outDir, 'report.html'), html(report));
  console.log(JSON.stringify({ ok: report.summary.errors === 0, outDir, ...report.summary })); if (report.summary.errors) process.exitCode = 2;
} finally {
  cdp?.close(); if (browser.exitCode === null) { const exited = new Promise((resolve) => browser.once('exit', resolve)); browser.kill('SIGTERM'); await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]); }
  await fs.rm(profile, { recursive: true, force: true });
}
