#!/usr/bin/env node

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
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

const storyboardPath = path.resolve(required('storyboard'));
const outDir = path.resolve(required('out'));
const gifName = path.basename(argv.get('gif') || 'instructional-workflow.gif');
const posterName = path.basename(argv.get('poster') || 'instructional-workflow.png');
const sourceRoot = argv.get('source-root') ? path.resolve(argv.get('source-root')) : '';
const storyboard = JSON.parse(await fs.readFile(storyboardPath, 'utf8'));
const claimStates = new Set(['implemented', 'runtime_verified', 'authenticated_only', 'development', 'unknown']);
const allowedAnnotationTypes = new Set(['box', 'arrow', 'label']);

if (!String(storyboard.title || '').trim()) throw new Error('Storyboard title is required');
if (!claimStates.has(storyboard.claimState)) throw new Error('Storyboard claimState is invalid');
if (!Array.isArray(storyboard.scenes) || storyboard.scenes.length === 0) throw new Error('Storyboard scenes are required');

const canvas = {
  width: Number(storyboard.canvas?.width || 960),
  height: Number(storyboard.canvas?.height || 600),
  background: String(storyboard.canvas?.background || '#0b0a0a'),
};
if (canvas.width < 320 || canvas.height < 320 || canvas.width > 1920 || canvas.height > 1080) {
  throw new Error('Canvas must be between 320x320 and 1920x1080');
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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function safeName(value, index) {
  return String(value || `scene-${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || `scene-${index + 1}`;
}

function insideRoot(filePath, root) {
  if (!root) return true;
  const relative = path.relative(root, filePath);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function mimeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  return 'image/png';
}

async function sha256(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

const preparedScenes = [];
for (let index = 0; index < storyboard.scenes.length; index += 1) {
  const scene = storyboard.scenes[index];
  if (!scene?.image?.source) throw new Error(`Scene ${index + 1} requires image.source`);
  const sourcePath = path.resolve(path.dirname(storyboardPath), String(scene.image.source));
  if (!insideRoot(sourcePath, sourceRoot)) throw new Error(`Scene source escapes --source-root: ${scene.image.source}`);
  const sourceStat = await fs.stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error(`Scene source is not a file: ${scene.image.source}`);
  const annotations = Array.isArray(scene.annotations) ? scene.annotations : [];
  for (const annotation of annotations) {
    if (!allowedAnnotationTypes.has(annotation?.type)) throw new Error(`Unsupported annotation type: ${annotation?.type || '(missing)'}`);
  }
  const sourceBytes = await fs.readFile(sourcePath);
  preparedScenes.push({
    ...scene,
    name: safeName(scene.name, index),
    durationMs: Math.max(900, Number(scene.durationMs || 1800)),
    panels: Array.isArray(scene.panels) ? scene.panels : [],
    annotations,
    image: {
      x: Number(scene.image.x || 0),
      y: Number(scene.image.y || 0),
      width: Number(scene.image.width || canvas.width),
      height: Number(scene.image.height || canvas.height),
      fit: ['cover', 'contain', 'fill'].includes(scene.image.fit) ? scene.image.fit : 'contain',
      position: String(scene.image.position || 'center'),
      radius: Math.max(0, Number(scene.image.radius || 0)),
      dataUrl: `data:${mimeFor(sourcePath)};base64,${sourceBytes.toString('base64')}`,
      sourcePath,
      sourceSha256: await sha256(sourcePath),
    },
  });
}

function renderPanel(panel) {
  const x = Number(panel.x || 0);
  const y = Number(panel.y || 0);
  const width = Number(panel.width || canvas.width);
  const height = Number(panel.height || canvas.height);
  return `<section class="guide-panel" style="left:${x}px;top:${y}px;width:${width}px;height:${height}px;${panel.background ? `background:${escapeHtml(panel.background)};` : ''}">
    ${panel.header ? `<div class="guide-panel__header">${escapeHtml(panel.header)}</div>` : ''}
    <div class="guide-panel__body">
      ${panel.eyebrow ? `<span>${escapeHtml(panel.eyebrow)}</span>` : ''}
      ${panel.title ? `<strong>${escapeHtml(panel.title)}</strong>` : ''}
      ${panel.detail ? `<p>${escapeHtml(panel.detail)}</p>` : ''}
    </div>
  </section>`;
}

function renderAnnotation(annotation, index) {
  const delay = Math.min(0.7, Math.max(0, Number(annotation.delay || index * 0.08)));
  const color = escapeHtml(annotation.color || '#ff6b00');
  if (annotation.type === 'box') {
    return `<div class="annotation annotation-box" data-delay="${delay}" style="left:${Number(annotation.x || 0)}px;top:${Number(annotation.y || 0)}px;width:${Number(annotation.width || 80)}px;height:${Number(annotation.height || 44)}px;border-color:${color};border-radius:${Math.max(2, Number(annotation.radius || 10))}px;--accent:${color}"></div>`;
  }
  if (annotation.type === 'label') {
    const theme = annotation.theme === 'light' ? ' light' : '';
    return `<div class="annotation annotation-label${theme}" data-delay="${delay}" style="left:${Number(annotation.x || 0)}px;top:${Number(annotation.y || 0)}px;max-width:${Number(annotation.width || 360)}px;--accent:${color}">
      ${annotation.step ? `<b>${escapeHtml(annotation.step)}</b>` : ''}
      <strong>${escapeHtml(annotation.text || '')}</strong>
      ${annotation.detail ? `<span>${escapeHtml(annotation.detail)}</span>` : ''}
    </div>`;
  }
  const from = Array.isArray(annotation.from) ? annotation.from : [0, 0];
  const to = Array.isArray(annotation.to) ? annotation.to : [120, 0];
  const labelX = Number(annotation.labelX ?? ((Number(from[0]) + Number(to[0])) / 2));
  const labelY = Number(annotation.labelY ?? ((Number(from[1]) + Number(to[1])) / 2 - 34));
  return `<svg class="annotation annotation-arrow" data-delay="${delay}" viewBox="0 0 ${canvas.width} ${canvas.height}" aria-hidden="true" style="--accent:${color}">
    <defs><marker id="arrow-${index}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/></marker></defs>
    <line data-x1="${Number(from[0])}" data-y1="${Number(from[1])}" data-x2="${Number(to[0])}" data-y2="${Number(to[1])}" x1="${Number(from[0])}" y1="${Number(from[1])}" x2="${Number(from[0])}" y2="${Number(from[1])}" stroke="${color}" stroke-width="4" stroke-linecap="round" marker-end="url(#arrow-${index})"/>
    ${annotation.text ? `<foreignObject x="${labelX}" y="${labelY}" width="${Number(annotation.width || 240)}" height="72"><div xmlns="http://www.w3.org/1999/xhtml" class="arrow-caption">${escapeHtml(annotation.text)}</div></foreignObject>` : ''}
  </svg>`;
}

const publicScenes = preparedScenes.map((scene, sceneIndex) => ({
  name: scene.name,
  durationMs: scene.durationMs,
  html: `
    ${scene.panels.map(renderPanel).join('')}
    <img class="actual-screen" src="${scene.image.dataUrl}" alt="" style="left:${scene.image.x}px;top:${scene.image.y}px;width:${scene.image.width}px;height:${scene.image.height}px;object-fit:${scene.image.fit};object-position:${escapeHtml(scene.image.position)};border-radius:${scene.image.radius}px">
    ${scene.annotations.map((annotation, annotationIndex) => renderAnnotation(annotation, sceneIndex * 20 + annotationIndex)).join('')}
  `,
}));

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:${canvas.width}px;height:${canvas.height}px;overflow:hidden}body{position:relative;background:${escapeHtml(canvas.background)};font-family:Pretendard,"Apple SD Gothic Neo",system-ui,sans-serif}.stage{position:absolute;inset:0;overflow:hidden}.actual-screen{position:absolute;display:block}.guide-panel{position:absolute;color:#18202d;background:#eef1f4;border-right:2px solid rgba(255,107,0,.7)}.guide-panel__header{height:36px;padding:9px 18px;color:#667181;background:#dce2e8;font-size:14px;font-weight:850}.guide-panel__body{position:absolute;left:32px;right:32px;top:50%;transform:translateY(-50%);text-align:center}.guide-panel__body span{display:block;margin-bottom:14px;color:#ff5b35;font-size:14px;font-weight:900;letter-spacing:.08em}.guide-panel__body strong{display:block;font-size:34px;line-height:1.2;letter-spacing:-.04em}.guide-panel__body p{margin:16px 0 0;color:#677385;font-size:17px;font-weight:750}.annotation{position:absolute;z-index:5;will-change:transform,opacity}.annotation-box{border:4px solid var(--accent);box-shadow:0 0 0 5px color-mix(in srgb,var(--accent) 22%,transparent),0 0 24px color-mix(in srgb,var(--accent) 38%,transparent)}.annotation-label{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;align-items:center;padding:13px 16px;border:1px solid color-mix(in srgb,var(--accent) 65%,transparent);border-radius:13px;color:#fff;background:rgba(15,20,30,.94);box-shadow:0 12px 30px rgba(0,0,0,.25)}.annotation-label.light{color:#18202d;background:rgba(255,255,255,.95)}.annotation-label b{grid-row:1/3;display:grid;place-items:center;width:30px;height:30px;border-radius:999px;color:#111;background:var(--accent);font-size:15px}.annotation-label strong{font-size:19px;line-height:1.25;letter-spacing:-.025em}.annotation-label span{grid-column:2;color:#b8c0cd;font-size:13px;font-weight:700}.annotation-label.light span{color:#667181}.annotation-arrow{inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}.arrow-caption{display:inline-block;padding:8px 12px;border-radius:9px;color:#fff;background:rgba(15,20,30,.92);font:850 15px/1.25 Pretendard,"Apple SD Gothic Neo",system-ui,sans-serif}.truth-badge{position:absolute;right:14px;bottom:12px;z-index:10;padding:7px 10px;border:1px solid rgba(255,255,255,.25);border-radius:999px;color:#e9edf2;background:rgba(9,8,8,.82);font-size:11px;font-weight:800;letter-spacing:.02em}
</style></head><body><main id="stage" class="stage"></main><span class="truth-badge">실제 화면 · 안내 그래픽</span><script>
const scenes=${JSON.stringify(publicScenes)};
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
window.renderInstructionFrame=(sceneIndex,progress)=>{
  const scene=scenes[sceneIndex]; const stage=document.getElementById('stage'); stage.innerHTML=scene.html;
  const p=clamp(Number(progress)||0,0,1);
  stage.querySelectorAll('.annotation').forEach((node,index)=>{
    const delay=Number(node.dataset.delay||0); const local=clamp((p-delay)/(1-delay),0,1); const eased=1-Math.pow(1-local,3);
    node.style.opacity=String(eased);
    if(node.classList.contains('annotation-box')) node.style.transform='scale('+(0.93+eased*0.07)+')';
    if(node.classList.contains('annotation-label')) node.style.transform='translateY('+(12*(1-eased))+'px)';
    if(node.classList.contains('annotation-arrow')){
      const line=node.querySelector('line'); if(!line)return; const x1=Number(line.dataset.x1),y1=Number(line.dataset.y1),x2=Number(line.dataset.x2),y2=Number(line.dataset.y2);
      line.setAttribute('x2',String(x1+(x2-x1)*eased)); line.setAttribute('y2',String(y1+(y2-y1)*eased));
    }
  });
  return {scene:scene.name,progress:p};
};
</script></body></html>`;

class CdpClient {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timeout')), 5000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id); this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`)); else pending.resolve(message.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (!this.pending.has(id)) return; this.pending.delete(id); reject(new Error(`CDP command timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, method, timer });
    });
  }
  close() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    try { this.ws?.close(); } catch { /* best effort */ }
  }
}

async function waitForJson(url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const response = await fetch(url); if (response.ok) return response.json(); } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Composition evaluation failed');
  return result.result?.value;
}

async function buildGif(frames, targetPath) {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) throw new Error('ffmpeg is required');
  const concatPath = path.join(outDir, '.instructional-frames.ffconcat');
  const quote = (value) => value.replaceAll("'", "'\\''");
  const lines = ['ffconcat version 1.0'];
  for (const frame of frames) lines.push(`file '${quote(frame.path)}'`, `duration ${frame.durationMs / 1000}`);
  lines.push(`file '${quote(frames.at(-1).path)}'`, 'duration 0.1');
  await fs.writeFile(concatPath, `${lines.join('\n')}\n`);
  const filter = `fps=10,scale=${canvas.width}:${canvas.height}:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=160[p];[s1][p]paletteuse=dither=bayer`;
  const run = spawnSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-vf', filter, '-loop', '0', targetPath], { encoding: 'utf8' });
  await fs.rm(concatPath, { force: true });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr.slice(-1200)}`);
}

await fs.mkdir(outDir, { recursive: true });
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'instructional-web-evidence-'));
const htmlPath = path.join(tempDir, 'storyboard.html');
await fs.writeFile(htmlPath, html);
const port = 19000 + Math.floor(Math.random() * 20000);
const browser = spawn(findBrowser(), [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tempDir, 'profile')}`,
  `--window-size=${canvas.width},${canvas.height}`, '--force-device-scale-factor=1', '--hide-scrollbars', '--no-first-run',
  pathToFileURL(htmlPath).toString(),
], { stdio: 'ignore' });

let cdp;
const frames = [];
try {
  const version = await waitForJson(`http://192.0.2.1:${port}/json/version`);
  cdp = new CdpClient(version.webSocketDebuggerUrl); await cdp.connect();
  const { targetInfos = [] } = await cdp.send('Target.getTargets');
  const target = targetInfos.find((item) => item.type === 'page' && item.url.startsWith('file:'));
  if (!target) throw new Error('Composition page target was not found');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId); await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: canvas.width, height: canvas.height, deviceScaleFactor: 1, mobile: false }, sessionId);
  for (let sceneIndex = 0; sceneIndex < preparedScenes.length; sceneIndex += 1) {
    const scene = preparedScenes[sceneIndex];
    const samples = [0.08, 0.24, 0.43, 0.64, 0.83, 1];
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
      await evaluate(cdp, sessionId, `window.renderInstructionFrame(${sceneIndex},${samples[sampleIndex]})`);
      await new Promise((resolve) => setTimeout(resolve, 35));
      const name = `${String(sceneIndex + 1).padStart(2, '0')}-${scene.name}-${sampleIndex + 1}.png`;
      const framePath = path.join(outDir, name);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
      await fs.writeFile(framePath, Buffer.from(shot.data, 'base64'));
      const last = sampleIndex === samples.length - 1;
      frames.push({ scene: scene.name, file: name, path: framePath, progress: samples[sampleIndex], durationMs: last ? Math.max(400, scene.durationMs - 500) : 100 });
    }
  }
  await buildGif(frames, path.join(outDir, gifName));
  const posterScene = Math.min(preparedScenes.length - 1, Math.max(0, Number(storyboard.posterScene ?? preparedScenes.length - 1)));
  const posterFrame = [...frames].reverse().find((frame) => frame.scene === preparedScenes[posterScene].name && frame.progress === 1) || frames.at(-1);
  await fs.copyFile(posterFrame.path, path.join(outDir, posterName));
  const manifest = {
    schemaVersion: 1,
    title: storyboard.title,
    claimState: storyboard.claimState,
    createdAt: new Date().toISOString(),
    compositionKind: 'actual-screen-with-explanatory-overlays',
    truthBoundary: 'Product pixels come from recorded screenshots. Boxes, arrows, labels and document placeholders are explanatory overlays.',
    canvas,
    storyboard: sourceRoot && insideRoot(storyboardPath, sourceRoot) ? path.relative(sourceRoot, storyboardPath) : path.basename(storyboardPath),
    scenes: preparedScenes.map((scene) => ({
      name: scene.name,
      durationMs: scene.durationMs,
      source: sourceRoot ? path.relative(sourceRoot, scene.image.sourcePath) : path.basename(scene.image.sourcePath),
      sourceSha256: scene.image.sourceSha256,
      annotations: scene.annotations.map((annotation) => ({ type: annotation.type, text: annotation.text || undefined })),
      explanatoryPanels: scene.panels.length,
    })),
    gif: { file: gifName, sha256: await sha256(path.join(outDir, gifName)) },
    poster: { file: posterName, sha256: await sha256(path.join(outDir, posterName)) },
    frames: await Promise.all(frames.map(async (frame) => ({ file: frame.file, scene: frame.scene, progress: frame.progress, durationMs: frame.durationMs, sha256: await sha256(frame.path) }))),
  };
  await fs.writeFile(path.join(outDir, 'composition.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, outDir, scenes: preparedScenes.length, frames: frames.length, gif: gifName, poster: posterName }));
} finally {
  cdp?.close();
  if (browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once('exit', resolve)); browser.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await fs.rm(tempDir, { recursive: true, force: true }); break; }
    catch (error) {
      if (!['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error?.code) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 160 * (attempt + 1)));
    }
  }
}
