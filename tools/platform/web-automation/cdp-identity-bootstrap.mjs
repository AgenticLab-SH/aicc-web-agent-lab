import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { identityObserverScript, readUiIdentityExpression, classifyUiIdentity } from './cdp-bootstrap-ui.mjs';

const mode = 'identity-bootstrap-read-only';
const sourceRoot = path.dirname(fileURLToPath(import.meta.url));

class Connection {
  pending = new Map();
  nextId = 0;
  async connect(url) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data));
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error('cdp_command_failed'));
        else request.resolve(message.result);
      } catch { this.close(); }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdp_connect_timeout')), 5000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cdp_connect_failed')); }, { once: true });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('cdp_command_timeout')); }, 18000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('cdp_closed')); }
    this.pending.clear();
    this.socket?.close();
  }
}

export function assertRegisteredIdentity(slot) {
  const result = spawnSync('pwsh', ['-NoProfile', '-File', path.join(sourceRoot, 'Assert-CdpEndpointIdentity.ps1'),
    '-ExpectedBrowser', 'chrome', '-Endpoint', slot.endpoint, '-ExpectedProfileDir', slot.profile, '-AsJson'],
  { encoding: 'utf8', timeout: 15000, windowsHide: true });
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new Error('identity_guard_failed'); }
  if (!report.ok && report.reasons?.length === 1 && report.reasons[0] === 'cdp_endpoint_unavailable') throw new Error('cdp_offline');
  if (result.status !== 0 || !report.ok || !report.profile_matches || !report.port_matches || !report.process_matches) throw new Error('identity_guard_failed');
}

export async function inspectSlot(slot, { guard = assertRegisteredIdentity, connection = new Connection(), getVersion = async endpoint => {
  const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(4000), redirect: 'error' });
  if (!response.ok) throw new Error('cdp_offline');
  return response.json();
}, wait = () => new Promise(resolve => setTimeout(resolve, 500)) } = {}) {
  let targetId;
  try {
    await guard(slot);
    const version = await getVersion(slot.endpoint);
    const address = new URL(version.webSocketDebuggerUrl);
    if (address.protocol !== 'ws:' || address.hostname !== '127.0.0.1' || Number(address.port) !== slot.port || !address.pathname.startsWith('/devtools/browser/') || address.username || address.password || address.search || address.hash) throw new Error('websocket_identity_mismatch');
    await connection.connect(address.href);
    await guard(slot);
    ({ targetId } = await connection.send('Target.createTarget', { url: 'about:blank', background: true, hidden: true }));
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    await connection.send('Page.enable', {}, sessionId);
    await connection.send('Page.addScriptToEvaluateOnNewDocument', { source: identityObserverScript }, sessionId);
    await connection.send('Page.navigate', { url: 'https://chatgpt.com/' }, sessionId);
    let frame;
    for (let attempt = 0; attempt < 40; attempt++) {
      const { frameTree } = await connection.send('Page.getFrameTree', {}, sessionId);
      if (frameTree?.frame?.url?.startsWith('https://chatgpt.com/')) { frame = frameTree.frame; break; }
      await wait();
    }
    if (!frame) throw new Error('chatgpt_origin_unavailable');
    let uiIdentity = null;
    const observationDeadline = Date.now() + 20000;
    for (let attempt = 0; attempt < 30 && Date.now() < observationDeadline; attempt++) {
      const snapshot = await connection.send('Runtime.evaluate', { expression: readUiIdentityExpression, awaitPromise: true, returnByValue: true }, sessionId);
      if (snapshot.result?.value?.ui) {
        uiIdentity = classifyUiIdentity(snapshot.result.value);
        if (uiIdentity.status === 'signed_out' || (uiIdentity.status === 'signed_in' && uiIdentity.account_id_sha256 && uiIdentity.ui.composer_visible)) break;
      }
      await wait();
    }
    if (uiIdentity?.status === 'signed_in' || uiIdentity?.status === 'signed_out') {
      await guard(slot);
      return uiIdentity;
    }
    const { executionContextId } = await connection.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'aicc-identity-bootstrap' }, sessionId);
    const result = await connection.send('Runtime.evaluate', { expression: identityExpression, contextId: executionContextId, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error('identity_evaluation_failed');
    await guard(slot);
    const sessionIdentity = sanitizeIdentity(result.result?.value);
    if (sessionIdentity.status === 'signed_in') return sessionIdentity;
    return uiIdentity ?? { ...sessionIdentity, status: 'unknown', login_required: null };
  } finally {
    try {
      if (targetId) {
        const closed = await connection.send('Target.closeTarget', { targetId });
        if (!closed.success) throw new Error('owned_target_cleanup_failed');
      }
    } finally { connection.close(); }
  }
}

export function verificationResult(slot, identity) {
  const digest = value => createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  const aliasMatch = slot.alias && identity.email_local_part_sha256 ? digest(slot.alias) === identity.email_local_part_sha256 : null;
  const authenticated = identity.status === 'signed_in' && /^[a-f0-9]{64}$/.test(identity.email_sha256 ?? '') && /^[a-f0-9]{64}$/.test(identity.user_id_sha256 ?? '');
  return { mode, port: slot.port, ...identity, observed_at: new Date().toISOString(),
    intended_alias_localpart_match: aliasMatch, reserved: slot.reserved === true,
    login_action_required: slot.reserved === true ? false : (identity.login_required ?? null),
    verification_scope: authenticated ? (identity.workspace_id_sha256 ? 'account_and_workspace' : 'account_only') : 'unverified',
    binding_verified: authenticated && aliasMatch === true && slot.reserved !== true,
    mutation_authorized: false };
}

export async function inspectIndependently(slots, inspect, emit) {
  let failed = false;
  for (const slot of slots) {
    let identity;
    try { identity = await inspect(slot); }
    catch (error) {
      const allowed = ['cdp_offline', 'identity_guard_failed', 'registration_changed', 'cdp_connect_timeout', 'cdp_connect_failed',
        'cdp_command_timeout', 'cdp_command_failed', 'cdp_closed', 'websocket_identity_mismatch', 'chatgpt_origin_unavailable',
        'identity_evaluation_failed', 'owned_target_cleanup_failed', 'bootstrap_busy'];
      identity = { status: 'unknown', login_required: null, error: allowed.includes(error.message) ? error.message : 'inspection_failed' };
    }
    const result = verificationResult(slot, identity);
    if (!slot.reserved && !result.binding_verified) failed = true;
    await emit(result);
  }
  return { failed };
}

async function main(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--mode', '--ports'].includes(argv[index]) || !argv[index + 1] || args.has(argv[index])) throw new Error('invalid_arguments');
    args.set(argv[index], argv[index + 1]);
  }
  if (args.get('--mode') !== mode) throw new Error('explicit_read_only_mode_required');
  const ports = args.get('--ports') === 'all' ? [9222, 9223, 9224, 9225] : (args.get('--ports') ?? '').split(',').map(Number);
  if (ports.some(port => ![9222, 9223, 9224, 9225].includes(port)) || new Set(ports).size !== ports.length) throw new Error('invalid_ports');
  const coordination = path.join(os.homedir(), '.ai-control-center', 'guidance', 'coordination.toml');
  const text = await fs.readFile(coordination, 'utf8');
  const slots = registeredSlots(text, ports);
  const lockRoot = path.join(os.homedir(), '.ai-control-center', 'browser', 'identity-bootstrap-locks');
  await fs.mkdir(lockRoot, { recursive: true });
  const summary = await inspectIndependently(slots, async slot => {
    let lock;
    const lockPath = path.join(lockRoot, `${slot.port}.lock`);
    try {
      try { lock = await fs.open(lockPath, 'wx'); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('bootstrap_busy'); throw error; }
      if (await fs.readFile(coordination, 'utf8') !== text) throw new Error('registration_changed');
      return await inspectSlot(slot, { guard: async selected => {
        if (await fs.readFile(coordination, 'utf8') !== text) throw new Error('registration_changed');
        assertRegisteredIdentity(selected);
      } });
    } finally {
      if (lock) { await lock.close(); await fs.unlink(lockPath); }
    }
  }, result => process.stdout.write(`${JSON.stringify(result)}\n`));
  if (summary.failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('identity_bootstrap_failed\n'); process.exitCode = 1; });
}

export function registeredSlots(text, ports) {
  let section = '';
  const browser = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = line.match(/^\[([^\]]+)\]$/);
    if (heading) { section = heading[1]; continue; }
    if (section !== 'browser') continue;
    const entry = line.match(/^(cdp_slot\d+_(?:port|profile_dir|usage|account_alias|alias))\s*=\s*(?:"([^"\r\n]*)"|(\d+))\s*(?:#.*)?$/);
    if (!entry) continue;
    if (browser.has(entry[1])) throw new Error('duplicate_registration');
    browser.set(entry[1], entry[2] ?? entry[3]);
  }
  const slots = [];
  for (const [key, value] of browser) {
    const match = key.match(/^cdp_slot(\d+)_port$/);
    if (!match || !ports.includes(Number(value))) continue;
    const prefix = `cdp_slot${match[1]}`;
    const profile = browser.get(`${prefix}_profile_dir`);
    const usage = browser.get(`${prefix}_usage`) ?? '';
    if (!profile || !path.isAbsolute(profile) || !usage || /disabled/i.test(usage)) throw new Error('registration_not_eligible');
    slots.push({ port: Number(value), endpoint: `http://127.0.0.1:${value}`, profile,
      alias: browser.get(`${prefix}_account_alias`) ?? browser.get(`${prefix}_alias`) ?? null, reserved: /reserved/i.test(usage) });
  }
  if (slots.length !== ports.length || new Set(slots.map(slot => slot.port)).size !== ports.length) throw new Error('exact_registration_required');
  return slots.sort((left, right) => left.port - right.port);
}

export const identityExpression = `(${async function () {
  const empty = { status: 'unknown', login_required: null, reason: 'origin_unavailable', user_id_sha256: null, email_sha256: null, account_id_sha256: null, workspace_id_sha256: null };
  if (location.origin !== 'https://chatgpt.com') return empty;
  try {
    const response = await fetch('/api/auth/session', { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12000) });
    if (response.status === 401) return { ...empty, status: 'signed_out', login_required: true, reason: 'unauthorized' };
    if (!response.ok) return { ...empty, reason: response.status === 403 ? 'forbidden' : 'session_http_error' };
    const session = await response.json();
    if (!session || typeof session !== 'object' || Array.isArray(session)) return { ...empty, reason: 'invalid_session_shape' };
    if (!session.user) {
      if (session.authenticated === false || session.isAuthenticated === false || session.isLoggedIn === false || session.loggedIn === false ||
          [session.error, session.message, session.detail].some(value => typeof value === 'string' && /^(not (logged|signed) in|unauthenticated|authentication required|no session)[.!]?$/i.test(value))) {
        return { ...empty, status: 'signed_out', login_required: true, reason: 'unauthorized' };
      }
      if (Object.hasOwn(session, 'WARNING_BANNER')) return { ...empty, reason: 'session_response_restricted' };
      return Object.keys(session).every(key => ['expires', 'user'].includes(key)) && session.user == null
        ? { ...empty, status: 'signed_out', login_required: true, reason: 'empty_session' }
        : { ...empty, reason: Object.hasOwn(session, 'error') ? 'session_error' : Object.hasOwn(session, 'message') ? 'session_message' : Object.hasOwn(session, 'detail') ? 'session_detail' : Object.hasOwn(session, 'url') ? 'session_url' : 'user_absent' };
    }
    const hash = async value => typeof value === 'string' && value.length > 0
      ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('') : null;
    const userHash = await hash(session.user.id);
    const emailHash = await hash(session.user.email?.trim().toLowerCase());
    if (!userHash || !emailHash) return { ...empty, reason: 'identity_incomplete' };
    return { ...empty, status: 'signed_in', login_required: false, reason: 'session_identity', user_id_sha256: userHash, email_sha256: emailHash,
      account_id_sha256: await hash(session.account?.id), workspace_id_sha256: await hash(session.workspace?.id) };
  } catch { return { ...empty, reason: 'session_fetch_failed' }; }
}})()`;

export function sanitizeIdentity(value) {
  if (!value || !['signed_in', 'signed_out', 'unknown'].includes(value.status)) throw new Error('invalid_identity_result');
  const expectedLogin = { signed_in: false, signed_out: true, unknown: null }[value.status];
  if (value.login_required !== expectedLogin) throw new Error('invalid_identity_result');
  const reasons = ['origin_unavailable', 'unauthorized', 'forbidden', 'session_http_error', 'invalid_session_shape', 'empty_session', 'user_absent', 'session_response_restricted', 'session_error', 'session_message', 'session_detail', 'session_url', 'identity_incomplete', 'session_identity', 'session_fetch_failed'];
  if (!reasons.includes(value.reason)) throw new Error('invalid_identity_result');
  const output = { status: value.status, login_required: value.login_required, reason: value.reason };
  for (const key of ['user_id_sha256', 'email_sha256', 'account_id_sha256', 'workspace_id_sha256']) {
    if (value[key] !== null && !/^[a-f0-9]{64}$/.test(value[key])) throw new Error('invalid_identity_result');
    output[key] = value[key];
  }
  if (value.status === 'signed_in' && (!output.user_id_sha256 || !output.email_sha256)) throw new Error('invalid_identity_result');
  if (value.status !== 'signed_in' && Object.values(output).some(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item))) throw new Error('invalid_identity_result');
  return output;
}
