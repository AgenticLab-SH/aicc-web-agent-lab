import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ids = new Set(['G1','G2','G3','G4','G5','G6','G7','G8','G9','G-DOC']);
const states = new Set(['PRIORITY','PARTIAL','HOLD','WAITING','ARCHIVED','PARALLEL']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function regular(file, max = 2 * 1024 * 1024) {
  for (let p = path.resolve(file);; p = path.dirname(p)) {
    if (fs.lstatSync(p).isSymbolicLink()) throw Error('linked_source');
    if (p === path.dirname(p)) break;
  }
  const s = fs.statSync(file);
  if (!s.isFile() || s.size > max) throw Error('invalid_source');
  return fs.readFileSync(file);
}
function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 400 || /[\x00-\x1f\x7f]|https?:\/\/|[A-Z]:[\\/]|[\w.+-]+@[\w.-]+|(?:token|password|secret)\s*[:=]/i.test(value)) throw Error('invalid_text');
  return value;
}
function list(value, max = 18) {
  if (!Array.isArray(value) || value.length > max) throw Error('invalid_list');
  return value.map(text);
}
// A read-only view of the existing controller record, never a second task store.
// No raw markdown, paths, accounts, conversation IDs or command execution reach the client.
export function readPortfolioOverview(options = {}) {
  const codex = options.codexRoot ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const base = { ok: true, readOnly: true, status: 'UNAVAILABLE', groups: [], observedAt: new Date().toISOString(), runtimeVerified: false };
  try {
    const root = path.join(codex, 'ops', 'web-group-tray-20261106');
    const source = JSON.parse(regular(path.join(root, 'execution.json')).toString('utf8').replace(/^\uFEFF/, ''));
    const view = source.userFacingOverview;
    if (view?.schemaVersion !== 1 || !Number.isFinite(Date.parse(view.reviewedAt)) || !Array.isArray(view.groups) || view.groups.length !== ids.size) throw Error('overview_missing');
    const seen = new Set();
    const groups = view.groups.map(g => {
      if (!ids.has(g.id) || seen.has(g.id) || !states.has(g.state)) throw Error('invalid_group');
      seen.add(g.id);
      return { id: g.id, displayId: g.id === 'G-DOC' ? 'G10' : g.id, name: text(g.name), state: g.state, purpose: text(g.purpose), initial: text(g.initial), current: text(g.current),
        products: list(g.products), completed: list(g.completed), remaining: list(g.remaining), next: text(g.next),
        milestones: list(g.milestones), evidence: list(g.evidence), stages: list(g.stages, 5) };
    });
    // These are the two existing canon files. Caller-selected paths are never accepted.
    const pins = view.sourcePins;
    const current = pins && pins.project === sha(regular(path.join(codex, 'context', 'PROJECT.md'))) && pins.remaining === sha(regular(path.join(root, 'G1-G4-REMAINING-20261110.md')));
    return { ...base, status: current ? 'AVAILABLE' : 'STALE', reviewedAt: view.reviewedAt, summary: text(view.summary),
      order: list(view.order, 4), timeline: list(view.timeline), groups, scope: text(view.scope) };
  } catch { return base; }
}
