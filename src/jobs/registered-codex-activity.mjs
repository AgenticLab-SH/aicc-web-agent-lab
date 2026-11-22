import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { summarizeCodexSessionActivity } from '../../components/workspace-mcp/codex-session-activity.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const activityName = value => typeof value === 'string' && value.trim()
  && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
function regular(file, max) {
  for (let p = path.resolve(file);; p = path.dirname(p)) {
    if (fs.lstatSync(p).isSymbolicLink()) throw Error('linked_activity_source');
    if (path.dirname(p) === p) break;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw Error('activity_source_bounds');
  return stat;
}
const equalPath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

function readRolloutObservation(file, now) {
  const stat = regular(file, 512 * 1024 * 1024), fd = fs.openSync(file, 'r');
  let tail;
  try {
    const offset = Math.max(0, stat.size - 262144), buffer = Buffer.alloc(stat.size - offset);
    if (fs.readSync(fd, buffer, 0, buffer.length, offset) !== buffer.length) throw Error('observation_short_read');
    const after = fs.fstatSync(fd);
    if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw Error('observation_changed');
    tail = offset ? buffer.subarray(buffer.indexOf(10) + 1) : buffer;
  } finally { fs.closeSync(fd); }
  if (!tail.length || tail.at(-1) !== 10) throw Error('observation_rollout_partial');
  const events = tail.toString('utf8').split('\n').filter(x => x.trim()).map(x => JSON.parse(x));
  // Sampling may omit the turn start. A timestamped native tool event is an
  // observation, never an inferred active turn or a live-process assertion.
  let tool = null;
  for (const event of events) {
    if (event.type === 'response_item' && ['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'].includes(event.payload?.type)) tool = event;
    else if (event.type === 'event_msg' && ['task_complete', 'task_completed', 'turn_complete', 'turn_completed', 'turn_aborted', 'task_interrupted', 'task_started', 'turn_started'].includes(event.payload?.type)) tool = null;
  }
  const { activity } = summarizeCodexSessionActivity(events, { now });
  if (tool && activity.state === 'UNKNOWN') {
    const age = now - Date.parse(tool.timestamp);
    return { state: Number.isFinite(age) && age >= 0 && age < 120000 ? 'RECENT_EXECUTION_EVENT' : 'STALE_OR_WAITING',
      evidence: 'TOOL_EVENT', lastObservedAt: Number.isFinite(age) ? tool.timestamp : null };
  }
  return { state: activity.state, evidence: activity.evidence, lastObservedAt: activity.lastObservedAt };
}

// Only exact existing registrations, bounded reads, no search or new ownership.
function readContinuityActivity({ stateRoot, now = Date.now() } = {}) {
  const registry = path.join(stateRoot, 'control-plane/codex-continuity/registrations.json');
  const base = { status: 'NOT_INITIALIZED', items: [], total: 0 };
  if (!fs.existsSync(registry)) return base;
  try {
    regular(registry, 2 * 1024 * 1024);
    const original = fs.readFileSync(registry);
    const cfg = JSON.parse(original.toString('utf8').replace(/^\uFEFF/, ''));
    if (cfg.schemaVersion !== 1 || cfg.protocolVersion !== 3 || !cfg.threads || typeof cfg.threads !== 'object'
      || Array.isArray(cfg.threads) || Object.keys(cfg.threads).length > 256) throw Error('activity_registry_shape');
    const sessions = path.resolve(stateRoot, '../.codex/sessions');
    const items = [];
    for (const [id, entry] of Object.entries(cfg.threads)) {
      if (entry?.enabled !== true || entry.executionSurface !== 'cli') continue;
      const key = createHash('sha256').update('registered-codex:' + id).digest('hex').slice(0, 20);
      const unknown = { key, source: 'CODEX_SESSION', actor: 'CODEX_CLI', state: 'UNKNOWN',
        evidence: 'SAVED_STATE_ONLY', lastObservedAt: null, writeAuthorized: false, completionVerified: false };
      try {
        if (!uuid.test(id) || entry.threadId !== id || typeof entry.rollout !== 'string'
          || !path.isAbsolute(entry.rollout) || typeof entry.projectRoot !== 'string' || !path.isAbsolute(entry.projectRoot)) throw Error('activity_binding');
        const relative = path.relative(sessions, entry.rollout);
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('activity_scope');
        const stat = regular(entry.rollout, 512 * 1024 * 1024);
        const fd = fs.openSync(entry.rollout, 'r');
        let head, tail;
        try {
          head = Buffer.alloc(Math.min(stat.size, 262144));
          head = head.subarray(0, fs.readSync(fd, head, 0, head.length, 0));
          const offset = Math.max(head.length, stat.size - 262144);
          tail = Buffer.alloc(stat.size - offset);
          tail = tail.subarray(0, fs.readSync(fd, tail, 0, tail.length, offset));
          if (fs.fstatSync(fd).ino !== stat.ino) throw Error('activity_source_replaced');
        } finally { fs.closeSync(fd); }
        const end = head.indexOf(10);
        if (end < 0) throw Error('activity_metadata');
        const meta = JSON.parse(head.subarray(0, end).toString('utf8'));
        if (meta.type !== 'session_meta' || meta.payload?.id !== id || meta.payload.source !== 'cli'
          || !['codex-tui', 'codex_exec', 'codex-exec'].includes(meta.payload.originator)
          || typeof meta.payload.cwd !== 'string' || !equalPath(meta.payload.cwd, entry.projectRoot)) throw Error('activity_identity');
        unknown.displayName = activityName(entry.title);
        const events = [];
        const parse = (buffer, leadingPartial) => {
          let text = buffer.toString('utf8');
          if (leadingPartial) text = text.slice(text.indexOf('\n') + 1);
          text = text.slice(0, text.lastIndexOf('\n') + 1);
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try { events.push(JSON.parse(line)); } catch { events.push({type:'invalid_json_redacted'}); }
          }
        };
        parse(head, false);
        // A sampled gap may contain a terminal or a new turn. Never bridge it.
        if (stat.size - tail.length > head.length) events.length = 0;
        parse(tail, tail.length > 0);
        const { activity } = summarizeCodexSessionActivity(events, { now });
        items.push({ ...unknown, state: activity.state, evidence: activity.evidence,
          lastObservedAt: activity.lastObservedAt });
      } catch { items.push(unknown); }
    }
    if (!fs.readFileSync(registry).equals(original)) throw Error('activity_registration_changed');
    return { status: items.length ? 'AVAILABLE' : 'EMPTY', items, total: items.length };
  } catch { return { ...base, status: 'UNKNOWN' }; }
}

// Explicit observation bindings live in the existing session registry. They do
// not register continuity, authorize a writer or wake a model. exec JSON streams
// can continue changing while their original rollout header remains buffered.
function readObservationActivity({ stateRoot, now }) {
  const registry = path.join(stateRoot, 'control-plane/session-registry.json');
  if (!fs.existsSync(registry)) return { status: 'NOT_INITIALIZED', items: [], total: 0 };
  try {
    regular(registry, 2 * 1024 * 1024);
    const original = fs.readFileSync(registry);
    const cfg = JSON.parse(original.toString('utf8').replace(/^\uFEFF/, ''));
    if (cfg.schemaVersion !== 1 || !Array.isArray(cfg.sessions) || cfg.sessions.length > 256) throw Error('observation_registry');
    const home = path.resolve(stateRoot, '..'), sessions = path.join(home, '.codex/sessions'), ops = path.join(home, '.codex/ops');
    const inside = (root, file) => { const r = path.relative(root, file); return r && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
    const ids = new Set(), items = [];
    for (const row of cfg.sessions) {
      const entry = row?.activityObservation;
      if (entry?.enabled !== true) continue;
      const id = row.threadId;
      const unknown = { key: createHash('sha256').update('registered-codex:' + id).digest('hex').slice(0, 20),
        source: 'CODEX_SESSION', actor: 'CODEX_CLI', state: 'UNKNOWN', evidence: 'SAVED_STATE_ONLY',
        lastObservedAt: null, writeAuthorized: false, completionVerified: false };
      try {
        if (!uuid.test(id) || ids.has(id)) throw Error('observation_identity');
        ids.add(id);
        if (![entry.rollout, entry.projectRoot, entry.eventStream].every(x => typeof x === 'string' && path.isAbsolute(x))
          || !inside(sessions, entry.rollout) || !inside(ops, entry.eventStream)) throw Error('observation_scope');
        const rolloutStat = regular(entry.rollout, 512 * 1024 * 1024);
        const metaFd = fs.openSync(entry.rollout, 'r'); let header;
        try { const b = Buffer.alloc(262144); const n = fs.readSync(metaFd, b, 0, b.length, 0); header = b.subarray(0, n); }
        finally { fs.closeSync(metaFd); }
        const line = header.indexOf(10); if (line < 0) throw Error('observation_metadata');
        const meta = JSON.parse(header.subarray(0, line).toString('utf8'));
        if (meta.type !== 'session_meta' || meta.payload?.id !== id || meta.payload.source !== 'exec'
          || !['codex_exec', 'codex-exec'].includes(meta.payload.originator)
          || typeof meta.payload.cwd !== 'string' || !equalPath(meta.payload.cwd, entry.projectRoot)) throw Error('observation_metadata');
        const stat = regular(entry.eventStream, 512 * 1024 * 1024), fd = fs.openSync(entry.eventStream, 'r');
        let first, tail;
        try {
          const h = Buffer.alloc(Math.min(stat.size, 4096)); fs.readSync(fd, h, 0, h.length, 0); first = h;
          const offset = Math.max(0, stat.size - 262144), t = Buffer.alloc(stat.size - offset);
          fs.readSync(fd, t, 0, t.length, offset); tail = t;
          const after = fs.fstatSync(fd);
          if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw Error('observation_changed');
          if (offset) tail = tail.subarray(tail.indexOf(10) + 1);
        } finally { fs.closeSync(fd); }
        const start = JSON.parse(first.subarray(0, first.indexOf(10)).toString('utf8'));
        if (start.type !== 'thread.started' || start.thread_id !== id) throw Error('observation_stream_identity');
        unknown.displayName = activityName(row.title);
        if (tail.at(-1) !== 10) {
          // PowerShell buffers exec stdout mid-JSON. Observe the independently
          // validated original native rollout; do not parse the partial event.
          items.push({ ...unknown, ...readRolloutObservation(entry.rollout, now) });
          continue;
        }
        let state = 'UNKNOWN', evidence = 'SAVED_STATE_ONLY';
        for (const text of tail.toString('utf8').split('\n')) {
          if (!text.trim()) continue;
          const event = JSON.parse(text);
          if (['turn.completed', 'turn.failed'].includes(event.type)) { state = 'TURN_ENDED'; evidence = 'TURN_TERMINAL_EVENT'; }
          else if (event.type === 'turn.started') { state = 'STALE_OR_WAITING'; evidence = 'TURN_START_EVENT'; }
          else if (['item.started', 'item.completed'].includes(event.type)) {
            state = event.item?.type === 'command_execution' ? 'RECENT_EXECUTION_EVENT' : 'STALE_OR_WAITING';
            evidence = event.item?.type === 'command_execution' ? 'EXEC_COMMAND_EVENT' : 'SAVED_STATE_ONLY';
          }
        }
        const age = now - stat.mtimeMs;
        // A resumed exec can have a new stream. A newer original rollout makes
        // the old stream's terminal event historical, not the current turn.
        if (state === 'TURN_ENDED' && rolloutStat.mtimeMs > stat.mtimeMs) {
          state = 'STALE_OR_WAITING'; evidence = 'SAVED_STATE_ONLY';
        }
        if (age < 0) { state = 'UNKNOWN'; evidence = 'SAVED_STATE_ONLY'; }
        if (state === 'RECENT_EXECUTION_EVENT' && !(age >= 0 && age < 120000)) state = 'STALE_OR_WAITING';
        items.push({ ...unknown, state, evidence, lastObservedAt: new Date(stat.mtimeMs).toISOString() });
      } catch { items.push(unknown); }
    }
    if (!fs.readFileSync(registry).equals(original)) throw Error('observation_registry_changed');
    return { status: items.length ? 'AVAILABLE' : 'EMPTY', items, total: items.length };
  } catch { return { status: 'UNKNOWN', items: [], total: 0 }; }
}

export function readRegisteredCodexActivity({ stateRoot, now = Date.now() } = {}) {
  const continuity = readContinuityActivity({ stateRoot, now }), observation = readObservationActivity({ stateRoot, now });
  if (observation.status === 'NOT_INITIALIZED' || observation.status === 'EMPTY') return continuity;
  const items = new Map(continuity.items.map(item => [item.key, item]));
  for (const item of observation.items) items.set(item.key, item);
  const partial = [continuity, observation].some(x => x.status === 'UNKNOWN');
  return { status: partial && !items.size ? 'UNKNOWN' : items.size ? 'AVAILABLE' : 'EMPTY', partial,
    total: items.size, items: [...items.values()] };
}
