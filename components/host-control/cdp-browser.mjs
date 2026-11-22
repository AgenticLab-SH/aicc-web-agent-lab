// Task-owned adapter, not a browser manager. The registered CDP lease helper
// remains the sole authority for account/workspace, profile, port and target.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { CdpLeaseProvider } from '../../src/browser/cdp-lease-provider.mjs';
import { createBrowserIdentityRegistry } from '../../src/browser/session-broker.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const selector = 'a,button,input:not([type=password]),textarea,select,[role="button"],[role="link"],[role="checkbox"],[contenteditable="true"]';
const pinPattern = /^[a-f0-9]{64}$/;
function refused(code, beforeDispatch = false) {
 const error = Error(code); error.beforeDispatch = beforeDispatch; return error;
}
function pinned(file, expected) {
 if (!path.isAbsolute(file ?? '') || !pinPattern.test(expected ?? '')) throw refused('CDP_DEPENDENCY_PIN_REQUIRED', true);
 for (let cursor = file;; cursor = path.dirname(cursor)) {
  const item = fs.lstatSync(cursor);
  if (item.isSymbolicLink()) throw refused('CDP_DEPENDENCY_REPARSE_FORBIDDEN', true);
  if (cursor === file && !item.isFile()) throw refused('CDP_DEPENDENCY_FILE_REQUIRED', true);
  if (path.dirname(cursor) === cursor) break;
 }
 if (digest(fs.readFileSync(file)) !== expected) throw refused('CDP_DEPENDENCY_SHA_CHANGED', true);
 return file;
}
function safePageUrl(page, blocked) {
 const value = page.url();
 let u;
 try { u = new URL(value); } catch { throw refused('CDP_PAGE_URL_UNPROVEN'); }
 if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password ||
     blocked.some(part => value.includes(part))) throw refused('CDP_CURRENT_URL_REFUSED');
 return u;
}
function raw(value, content = []) {
 return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }, ...content] };
}
function redact(s) { return String(s ?? '').replace(/\s+/g, ' ').slice(0, 130); }
function elementFingerprint(v) {
 return digest(JSON.stringify([v.tag, v.role, v.name, v.type, v.href, v.label]));
}
function itemsFromDocument(nodes) {
 return nodes.slice(0, 220).map((el, index) => {
  const rect = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase(), type = el.getAttribute('type') ?? '';
  if (type.toLowerCase() === 'password' || rect.width <= 0 || rect.height <= 0 ||
      getComputedStyle(el).visibility === 'hidden') return null;
  return { index, tag, type, role: el.getAttribute('role') ?? '',
   name: (el.getAttribute('aria-label') || el.getAttribute('name') || '').slice(0, 130),
   label: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').slice(0, 130),
   href: (el.getAttribute('href') || '').slice(0, 200) };
 }).filter(Boolean);
}
export async function openCdpBrowser(config, { identityId, url, ownerTaskId }, {
 provider: injectedProvider, chromium: injectedChromium, identityExpression: injectedExpression
} = {}) {
 if (config?.enabled !== true || !Array.isArray(config.identities) ||
     !/^[a-zA-Z0-9_-]{1,64}$/.test(identityId ?? '')) throw refused('EXPLICIT_REGISTERED_CDP_IDENTITY_REQUIRED', true);
 const registry = createBrowserIdentityRegistry(config.identities);
 const identity = registry.get(identityId);
 const exact = config.identities.find(item => item.identityId === identityId);
 if (!identity || identity.role !== 'registered-cdp' || !identity.accountAlias ||
     !identity.workspaceAlias || !identity.cdpEndpoint ||
     !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(identity.cdpEndpoint) ||
     !identity.profile || !identity.userDataRoot || !identity.executable ||
     exact?.ownershipPolicy !== 'task-created-target-only') {
  throw refused('CDP_ACCOUNT_WORKSPACE_PROFILE_BINDING_REQUIRED', true);
 }
 const chatgpt = new URL(url).hostname.toLowerCase() === 'chatgpt.com';
 if (chatgpt && (!pinPattern.test(exact.sessionIdentityHash ?? '') ||
     !Object.hasOwn(exact, 'workspaceIdentityHash') ||
     (exact.workspaceIdentityHash !== null && !pinPattern.test(exact.workspaceIdentityHash)))) {
  throw refused('CDP_CHATGPT_IDENTITY_PROOF_REQUIRED', true);
 }
 const helper = pinned(config.leaseHelper, config.leaseHelperSha256);
 pinned(config.identityGuard, config.identityGuardSha256);
 const pwsh = pinned(config.powershell, config.powershellSha256);
 let chromium = injectedChromium, identityExpression = injectedExpression;
 if (!chromium) {
  const playwright = pinned(config.playwrightModule, config.playwrightModuleSha256);
  const required = createRequire(pathToFileURL(playwright));
  chromium = required(playwright).chromium;
 }
 if (!chromium?.connectOverCDP) throw refused('PINNED_PLAYWRIGHT_CDP_REQUIRED', true);
 if (chatgpt && !identityExpression) {
  const audit = pinned(config.identityAuditModule, config.identityAuditModuleSha256);
  const module = await import(pathToFileURL(audit).href);
  if (typeof module.sessionIdentityHashExpression !== 'function') throw refused('PINNED_SESSION_IDENTITY_AUDITOR_REQUIRED', true);
  identityExpression = module.sessionIdentityHashExpression();
 }
 if (chatgpt && typeof identityExpression !== 'string') throw refused('PINNED_SESSION_IDENTITY_AUDITOR_REQUIRED', true);
 const blocked = Array.isArray(config.blockedUrlFragments) ? config.blockedUrlFragments : [];
 if (blocked.some(part => typeof part !== 'string' || part.length > 200)) throw refused('CDP_BLOCKED_RESOURCE_POLICY_INVALID', true);
 const provider = injectedProvider ?? new CdpLeaseProvider({ executable: pwsh, script: helper });
 // Acquire is non-idempotent: never retry an ambiguous helper result.
 const lease = await provider.acquire({ identity, url, ownerTaskId });
 if (!lease?.capability || !/^[A-Fa-f0-9]{32}$/.test(lease.targetId ?? '') ||
     lease.endpoint !== identity.cdpEndpoint || lease.ownership !== 'task-created' ||
     lease.identityHash !== identity.hash) throw refused('CDP_ACQUIRE_IDENTITY_OR_TARGET_UNKNOWN');
 let browser, page;
 try {
  browser = await chromium.connectOverCDP(lease.endpoint);
  const pages = browser.contexts().flatMap(ctx => ctx.pages());
  if (pages.length > 100) throw refused('CDP_TOO_MANY_TARGETS_TO_PROVE');
  const matches = [];
  for (const candidate of pages) {
   const session = await candidate.context().newCDPSession(candidate);
   try {
    if ((await session.send('Target.getTargetInfo')).targetInfo?.targetId === lease.targetId) matches.push(candidate);
   } finally { await session.detach(); }
  }
  if (matches.length !== 1) throw refused('CDP_EXACT_TASK_TARGET_UNPROVEN');
  page = matches[0];
  page.setDefaultTimeout(15000);
 } catch (error) {
  await browser?.close().catch(() => {}); // disconnect only; never close a Chrome process or foreign tab
  // The exact created lease may remain. Owner reconciles it; no acquire replay.
  throw error;
 }
 let released = false, uncertain = false, disconnected = false, seen = new Map(), observedUrl = null;
 const assertOwned = async () => {
  if (disconnected) throw refused('CDP_TRANSPORT_DISCONNECTED_OWNER_RECONCILIATION_REQUIRED', true);
  if (released || uncertain || page.isClosed()) throw refused('CDP_OWNED_TARGET_UNAVAILABLE');
  const session = await page.context().newCDPSession(page);
  try {
   if ((await session.send('Target.getTargetInfo')).targetInfo?.targetId !== lease.targetId) throw refused('CDP_TARGET_ID_CHANGED');
  } finally { await session.detach(); }
  return safePageUrl(page, blocked);
 };
 const proveLogin = async () => {
  if (!chatgpt) return;
  const current = await assertOwned();
  if (current.hostname !== 'chatgpt.com') throw refused('CDP_CHATGPT_ORIGIN_CHANGED');
  const proof = await page.evaluate(identityExpression);
  if (proof?.accountName !== identity.accountAlias || proof?.identityHash !== exact.sessionIdentityHash) {
   throw refused('CDP_LOGIN_IDENTITY_MISMATCH');
  }
  if (!proof || !Object.hasOwn(proof, 'workspaceIdentityHash') ||
      proof.workspaceIdentityHash !== exact.workspaceIdentityHash) {
   throw refused('CDP_WORKSPACE_IDENTITY_MISMATCH');
  }
 };
 const heartbeat = async () => {
  const answer = await provider.heartbeat({ capability: lease.capability });
  if (answer?.ok !== true) throw refused('CDP_LEASE_HEARTBEAT_UNCONFIRMED');
 };
 const before = async () => {
  await heartbeat();
  const current = await assertOwned();
  if (chatgpt) await proveLogin();
  return current;
 };
 async function snapshot(screenshot = false) {
  const current = await before();
  const data = await page.locator(selector).evaluateAll(itemsFromDocument);
  const counts = new Map();
  for (const item of data) { const sig = elementFingerprint(item); counts.set(sig, (counts.get(sig) ?? 0) + 1); }
  seen = new Map(); observedUrl = page.url();
  const refs = [];
  for (const item of data) {
   const sig = elementFingerprint(item);
   if (counts.get(sig) !== 1 || seen.size >= 120) continue;
   const ref = 'r' + (seen.size + 1);
   seen.set(ref, { index: item.index, signature: sig });
   refs.push('[ref=' + ref + '] ' + redact(item.name || item.label || item.role || item.tag));
  }
  const tree = await page.locator('body').ariaSnapshot({ timeout: 15000 });
  await assertOwned();
  if (observedUrl !== page.url()) throw refused('CDP_OBSERVATION_NAVIGATED_UNKNOWN');
  const image = screenshot ? [{ type: 'image', mimeType: 'image/png', data: (await page.screenshot({ timeout: 15000 })).toString('base64') }] : [];
  return raw({ target_owned: true, browser_backend: 'cdp', identity: 'exact-slot+in-page-checked',
   origin: current.origin, page_ref_count: seen.size, tree: String(tree).slice(0, 20000) },
   [{ type: 'text', text: refs.join('\n') }, ...image]);
 }
 async function locate(ref) {
  const entry = seen.get(ref);
  if (!entry || observedUrl !== page.url()) throw refused('CDP_FRESH_OBSERVED_REF_REQUIRED', true);
  const loc = page.locator(selector).nth(entry.index);
  const actual = await loc.evaluate(el => ({
   index: 0, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') ?? '',
   role: el.getAttribute('role') ?? '', name: (el.getAttribute('aria-label') || el.getAttribute('name') || '').slice(0,130),
   label: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').slice(0,130),
   href: (el.getAttribute('href') || '').slice(0,200)
  }));
  if (elementFingerprint(actual) !== entry.signature || !(await loc.isVisible())) throw refused('CDP_OBSERVED_ELEMENT_CHANGED', true);
  return loc;
 }
 async function clickDownload(loc) {
  if (!config.downloadRoot) throw refused('CDP_DOWNLOAD_ROOT_NOT_CONFIGURED', true);
  const root = path.resolve(config.downloadRoot);
  if (!path.isAbsolute(config.downloadRoot)) throw refused('CDP_DOWNLOAD_ROOT_NOT_ABSOLUTE', true);
  for (let walk = root;; walk = path.dirname(walk)) {
   const st = fs.lstatSync(walk);
   if (st.isSymbolicLink() || (walk === root && !st.isDirectory())) throw refused('CDP_DOWNLOAD_ROOT_UNSAFE');
   if (path.dirname(walk) === walk) break;
  }
  const pending = page.waitForEvent('download', { timeout: 15000 });
  await loc.click({ timeout: 15000 });
  const download = await pending;
  const dir = path.join(root, 'host-' + randomUUID());
  fs.mkdirSync(dir, { mode: 0o700 });
  const name = path.basename(download.suggestedFilename() || 'download').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0,100) || 'download';
  const out = path.join(dir, name);
  let count = 0;
  const limit = 32 * 1024 * 1024;
  const bounded = new Transform({ transform(chunk, _, done) {
   count += chunk.length;
   done(count > limit ? refused('CDP_DOWNLOAD_32MIB_LIMIT') : null, chunk);
  } });
  await pipeline(await download.createReadStream(), bounded, fs.createWriteStream(out, { flags: 'wx', mode: 0o600 }));
  return { download: { bytes: count, sha256: digest(fs.readFileSync(out)), stored: true, output: out, target_owned: true } };
 }
 async function act(action, a) {
  await before();
  if (action === 'navigate') {
   // The host already checks the original blocked-URL policy before calling this.
   seen = new Map(); observedUrl = null;
   await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } else {
   const loc = await locate(a.ref);
   seen = new Map(); observedUrl = null;
   if (action === 'click') await loc.click();
   else if (action === 'fill') await loc.fill(a.text ?? '');
   else if (action === 'press') await loc.press(a.key);
   else if (action === 'select') await loc.selectOption(a.text);
   else if (action === 'check') await loc.check();
   else if (action === 'download') {
    const receipt = await clickDownload(loc);
    const post = await snapshot();
    return raw({ ...receipt, post_snapshot: post.structuredContent }, post.content);
   } else throw refused('UNSUPPORTED_CDP_ACTION', true);
  }
  return snapshot();
 }
 async function release() {
  if (released) return { ok: true, closed: true };
  if (uncertain) throw refused('CDP_UNCERTAIN_RELEASE_REQUIRES_OWNER');
  await before();
  // Playwright disconnect never terminates registered Chrome. Only the
  // original helper owns exact Target.closeTarget and its lease removal.
  const done = await provider.release({ capability: lease.capability, targetId: lease.targetId });
  if (done?.ok !== true || done?.targetClosed !== true) {
   uncertain = true; throw refused('CDP_RELEASE_ACK_UNPROVEN');
  }
  released = true;
  await browser.close(); // disconnect, not user-browser shutdown
  return { ok: true, closed: true, target_id: lease.targetId };
 }
 return {
  async observe(options = {}) { try { return await snapshot(options.screenshot === true); } catch (e) { uncertain = true; throw e; } },
  async act(action, args) { try { return await act(action, args); } catch (e) { uncertain = true; throw e; } },
  async close() { return release(); },
  async disconnect() { if (disconnected) return; disconnected = true; await browser.close().catch(() => {}); },
  get uncertain() { return uncertain; },
  get targetId() { return lease.targetId; },
  get identityId() { return identityId; }
 };
}
