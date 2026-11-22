#!/usr/bin/env node
// G1-23: evidence-bound, single-row reconciliation of one OCX conversation UNKNOWN fence row.
// Offline only: the running external runtime keeps the fence in memory and rewrites the file,
// so this refuses while anything listens on 127.0.0.1:10100. Removing the exact row is what
// makes the result survive restart (the runtime reloads only the rows still in the file).
// It never deletes other rows, never replays the original request and never sends a model request.
//
// Usage (dry run by default):
//   node reconcile-conversation-unknown.mjs --key HEX32 --operation-id ID --evidence ABS_JSON
//        --operation-dir NEW_ABS_DIR [--apply]
// Evidence JSON (written by the owner who judged the original attempt):
//   { "schemaVersion":1, "kind":"ocx-unknown-reconcile-evidence", "key":"<32 hex>",
//     "operationId":"<fence row operationId>", "threadId":"<uuid>",
//     "finding":"no_output_delivered|completed_observed|owner_abandons_attempt",
//     "rollout":{"path":"<abs .../rollout-*-<threadId>.jsonl>","sha256":"<hex>"},
//     "note":"<plain text, why the original attempt needs no replay>" }
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const FINDINGS = new Set(['no_output_delivered', 'completed_observed', 'owner_abandons_attempt']);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function fail(code) { const error = Error(code); error.code = code; throw error; }
function regular(file, limit = 8 * 1024 * 1024) {
  if (!path.isAbsolute(file ?? '')) fail('absolute_path_required');
  for (let p = path.resolve(file);; p = path.dirname(p)) {
    if (fs.lstatSync(p).isSymbolicLink()) fail('linked_path_refused');
    if (p === path.dirname(p)) break;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > limit) fail('bounded_regular_file_required');
  return fs.readFileSync(file);
}
function exclusive(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
function parse(argv) {
  const options = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--apply') { options.apply = true; continue; }
    if (!['--key', '--operation-id', '--evidence', '--operation-dir'].includes(name) || !argv[i + 1]) fail('usage');
    options[name.slice(2)] = argv[++i];
  }
  if (!/^[a-f0-9]{32}$/.test(options.key ?? '') || typeof options['operation-id'] !== 'string'
    || !path.isAbsolute(options.evidence ?? '') || !path.isAbsolute(options['operation-dir'] ?? '')) fail('usage');
  return options;
}

export async function reconcileConversationUnknown(options, environment = process.env) {
  const stateRoot = environment.AICC_STATE_ROOT ?? path.join(os.homedir(), '.ai-control-center');
  const expectedHome = path.join(stateRoot, 'runtime', 'ocx-local', 'home');
  const registry = JSON.parse(regular(path.join(stateRoot, 'runtime', 'ocx-local', 'current.json'), 262144).toString('utf8'));
  if (path.resolve(registry.opencodexHome ?? '').toLowerCase() !== expectedHome.toLowerCase()) fail('registered_ocx_home_required');
  if (await (options.probe ?? listening)(10100)) fail('live_runtime_owns_fence_stop_ocx_first');
  const fenceFile = path.join(expectedHome, 'external-request-lifecycle.json');
  const beforeBytes = regular(fenceFile);
  const before = JSON.parse(beforeBytes.toString('utf8'));
  if (before.schemaVersion !== 1 || !Array.isArray(before.rows)) fail('fence_shape_invalid');
  const matches = before.rows.filter(row => row?.key === options.key);
  if (matches.length !== 1) fail(matches.length ? 'fence_key_duplicated' : 'fence_key_absent');
  const row = matches[0];
  if (row.state !== 'unknown' || row.operationId !== options['operation-id']) fail('fence_row_not_exact_unknown');
  const evidenceBytes = regular(options.evidence, 65536);
  const evidence = JSON.parse(evidenceBytes.toString('utf8'));
  if (evidence.schemaVersion !== 1 || evidence.kind !== 'ocx-unknown-reconcile-evidence'
    || evidence.key !== options.key || evidence.operationId !== row.operationId || !UUID.test(evidence.threadId ?? '')
    || sha(String(evidence.threadId).trim()).slice(0, 32) !== options.key || !FINDINGS.has(evidence.finding)
    || typeof evidence.note !== 'string' || !evidence.note.trim() || evidence.note.length > 2000) fail('exact_evidence_required');
  const rolloutBytes = regular(evidence.rollout?.path, 256 * 1024 * 1024);
  if (!path.basename(evidence.rollout.path).toLowerCase().endsWith('-' + evidence.threadId.toLowerCase() + '.jsonl')
    || sha(rolloutBytes) !== evidence.rollout.sha256) fail('rollout_evidence_mismatch');
  const remaining = before.rows.filter(other => other !== row);
  const afterBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, rows: remaining }) + '\n');
  const plan = { state: options.apply ? 'APPLYING' : 'DRY_RUN', key: options.key, operationId: row.operationId,
    threadId: evidence.threadId, finding: evidence.finding, rowsBefore: before.rows.length, rowsAfter: remaining.length,
    fenceBeforeSha256: sha(beforeBytes), fenceAfterSha256: sha(afterBytes), otherRowsChanged: false,
    originalRequestReplayed: false, automaticRetry: false };
  if (!options.apply) return plan;
  const operation = path.resolve(options['operation-dir']);
  if (!fs.statSync(path.dirname(operation)).isDirectory()) fail('operation_parent_required');
  fs.mkdirSync(operation, { mode: 0o700 });
  exclusive(path.join(operation, 'fence.before.json'), beforeBytes);
  exclusive(path.join(operation, 'evidence.json'), evidenceBytes);
  exclusive(path.join(operation, 'intent.json'), Buffer.from(JSON.stringify({ ...plan, state: 'INTENT' }, null, 2) + '\n'));
  // Re-check immediately before the single replacement; preserve everything on any change.
  if (sha(regular(fenceFile)) !== plan.fenceBeforeSha256) fail('fence_changed_preserved');
  if (await (options.probe ?? listening)(10100)) fail('live_runtime_started_preserved');
  const temp = fenceFile + '.' + randomUUID() + '.tmp';
  exclusive(temp, afterBytes);
  fs.renameSync(temp, fenceFile);
  const receipt = { ...plan, state: 'RECONCILED_SINGLE_ROW', at: new Date().toISOString(),
    accountIdSha256: sha(String(row.accountId)), evidenceSha256: sha(evidenceBytes), operationDirectory: operation,
    rollback: 'restore fence.before.json to external-request-lifecycle.json only if the runtime is stopped and the file still equals fenceAfterSha256' };
  exclusive(path.join(operation, 'receipt.json'), Buffer.from(JSON.stringify(receipt, null, 2) + '\n'));
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  reconcileConversationUnknown(parse(process.argv.slice(2)))
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(JSON.stringify({ state: 'REFUSED_PRESERVED', code: error.code ?? 'failed' })); process.exitCode = 1; });
}
