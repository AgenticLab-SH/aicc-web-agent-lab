import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
function bytes(file) {
  for (let p = file;; p = path.dirname(p)) { if (fs.lstatSync(p).isSymbolicLink()) fail('queue_preflight_link_denied'); if (p === path.dirname(p)) break; }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) fail('queue_preflight_file_invalid');
  return fs.readFileSync(file);
}
const quote = value => "'" + value.replaceAll("'", "''") + "'";
/** Read-only admission inspection. Evidence is supplied by the existing official owner, never this adapter. */
export function createDashboardQueuePreflight({ ownerRoot, dashboard, runner, executable = path.join(ownerRoot, 'toolchain', 'pwsh-7.6.6', 'runtime', 'pwsh.exe') }) {
  const root = path.join(path.resolve(ownerRoot), 'control-plane', 'codex-continuity');
  async function inspect(input) {
    try {
      if (!input || Object.keys(input).some(k => !['id', 'expectedRevision'].includes(k))) fail('queue_preflight_input_invalid');
      const intent = dashboard.inspectHandoff(input);
      const registryBytes = bytes(path.join(root, 'registrations.json')), cfg = JSON.parse(registryBytes.toString('utf8').replace(/^\uFEFF/, ''));
      const helper = path.resolve(cfg.helperPath ?? '');
      if (cfg.schemaVersion !== 1 || cfg.protocolVersion !== 3 || !helper.startsWith(path.join(path.resolve(ownerRoot), 'releases', 'codex-continuity') + path.sep) || !/^[a-f0-9]{64}$/.test(cfg.helperSha256 ?? '')) fail('queue_preflight_helper_invalid');
      const helperBytes = bytes(helper);
      if (hash(helperBytes) !== cfg.helperSha256) fail('queue_preflight_helper_changed');
      if (!helperBytes.toString('utf8').includes("'QueuePreflight' {")) fail('queue_preflight_upgrade_required');
      const evidence = path.join(root, 'requests', `${intent.id}.preflight-evidence.json`);
      const evidenceBytes = bytes(evidence);
      const command = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);& " + quote(helper) + ' -Action QueuePreflight -StateRoot ' + quote(root) + ' -ThreadId ' + quote(intent.agentId) + ' -OperationId ' + quote(intent.id) + ' -MessageFile ' + quote(path.join(root, 'requests', `${intent.id}.txt`)) + ' -EvidenceFile ' + quote(evidence);
      const result = await runner(executable, ['-NoProfile', '-NonInteractive', '-Command', command]);
      if (dashboard.inspectHandoff(input).fingerprint !== intent.fingerprint || hash(bytes(path.join(root, 'registrations.json'))) !== hash(registryBytes) || hash(bytes(helper)) !== cfg.helperSha256 || hash(bytes(evidence)) !== hash(evidenceBytes)) fail('queue_preflight_changed');
      if (result?.schemaVersion !== 1 || result.kind !== 'aicc-queue-preflight' || result.threadId !== intent.agentId || result.operationId !== intent.id || result.dispatched !== false || result.claimed !== false || result.automaticDelivery !== false) fail('queue_preflight_result_invalid');
      if (result.state !== 'READY_NOT_AUTHORIZED') return { supported: true, ready: false, state: 'HOLD', reason: /^[A-Z_]{1,80}$/.test(result.state ?? '') ? result.state : 'UNKNOWN', dispatched: false, automaticDelivery: false };
      const age = Date.now() - Date.parse(result.observedAt);
      if (age < -2000 || age > 10000 || !Number.isFinite(age) || result.messageSha256 !== intent.messageSha256 || result.evidenceSha256 !== hash(evidenceBytes) || result.targetRoute !== 'EXACT_OCX' || result.idleVerified !== true || result.quotaFresh !== true || !/^[a-f0-9]{64}$/.test(result.binarySha256 ?? '')) fail('queue_preflight_result_invalid');
      return { supported: true, ready: true, state: 'READY_NOT_AUTHORIZED', agentId: intent.agentId, id: intent.id, observedAt: result.observedAt, dispatched: false, automaticDelivery: false, reason: '사전 조건 관측만 통과했습니다. 발신 승인·claim·실행은 별도이며 자동 실행하지 않습니다.' };
    } catch (error) { return { supported: false, ready: false, state: 'HOLD', reason: /^(?:dashboard|queue_preflight)_[a-z_]+$/.test(error.code ?? '') ? error.code : error.code === 'ENOENT' ? 'queue_preflight_evidence_or_registration_missing' : 'queue_preflight_unavailable', dispatched: false, automaticDelivery: false }; }
  }
  return { inspect };
}
