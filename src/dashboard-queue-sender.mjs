import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function bytes(file) {
  for (let p = file;; p = path.dirname(p)) { if (fs.lstatSync(p).isSymbolicLink()) fail('queue_sender_link_denied'); if (p === path.dirname(p)) break; }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) fail('queue_sender_file_invalid');
  return fs.readFileSync(file);
}
/** Adapter to the registered checked QueueMessage. No transport, daemon or evidence producer. */
export function createDashboardQueueSender({ ownerRoot, dashboard, queuePreflight, runner, executable = path.join(ownerRoot, 'toolchain', 'pwsh-7.6.6', 'runtime', 'pwsh.exe') }) {
  const root = path.join(path.resolve(ownerRoot), 'control-plane', 'codex-continuity');
  const seal = id => path.join(root, 'requests', `${id}.dashboard-send.json`);
  function binding(input) {
    if (!input || Object.keys(input).some(k => !['id', 'expectedRevision'].includes(k))) fail('queue_sender_input_invalid');
    const intent = dashboard.inspectHandoff(input);
    if (fs.existsSync(seal(intent.id))) fail('queue_sender_original_send_preserved');
    const registry = bytes(path.join(root, 'registrations.json')), cfg = JSON.parse(registry.toString('utf8').replace(/^\uFEFF/, ''));
    const helper = path.resolve(cfg.helperPath ?? '');
    if (cfg.schemaVersion !== 1 || cfg.protocolVersion !== 3 || !helper.startsWith(path.join(path.resolve(ownerRoot), 'releases', 'codex-continuity') + path.sep) || !/^[a-f0-9]{64}$/.test(cfg.helperSha256 ?? '')) fail('queue_sender_registration_invalid');
    const source = bytes(helper);
    if (sha(source) !== cfg.helperSha256) fail('queue_sender_helper_changed');
    if (!source.toString('utf8').includes('# Dashboard checked send reuses this exact sender')) fail('queue_sender_upgrade_required');
    const evidence = path.join(root, 'requests', `${intent.id}.preflight-evidence.json`);
    const fingerprint = sha(JSON.stringify({ intent, registry: sha(registry), helper: cfg.helperSha256, evidence: sha(bytes(evidence)) }));
    return { intent, helper, evidence, fingerprint };
  }
  async function prepare(input) {
    const before = binding(input), admission = await queuePreflight.inspect(input);
    if (!admission.ready) fail('queue_sender_admission_hold');
    if (binding(input).fingerprint !== before.fingerprint) fail('queue_sender_preview_changed');
    return { kind: 'queue-send', fingerprint: before.fingerprint, handoffFingerprint: before.intent.fingerprint,
      summary: ['선택 지시 한 건을 등록 QueueMessage로 한 번 보냅니다.', `exact 대상: ${before.intent.agentId}`, `원 attempt: ${before.intent.id}`, `본문 SHA-256: ${before.intent.messageSha256}`, '접수는 실행·turn 종료·목표 완료와 다릅니다. 불명 결과는 재발신하지 않습니다. 자동 다음 실행은 하지 않습니다.', dashboard.status().queue.find(q => q.id === input.id)?.instruction ?? ''] };
  }
  async function execute(input, preview) {
    return dashboard.withHandoff(input, preview.handoffFingerprint, async intent => {
      const current = await prepare(input);
      if (current.fingerprint !== preview.fingerprint) fail('queue_sender_preview_changed');
      const bound = binding(input);
      const record = { schemaVersion: 1, id: intent.id, threadId: intent.agentId, messageSha256: intent.messageSha256, state: 'UNKNOWN', at: new Date().toISOString(), automaticReplay: false };
      // Durable once-only boundary BEFORE invoking the helper. Never delete on failure.
      const fd = fs.openSync(seal(intent.id), 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const command = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);& " + quote(bound.helper) + ' -Action QueueMessage -StateRoot ' + quote(root) + ' -ThreadId ' + quote(intent.agentId) + ' -OperationId ' + quote(intent.id) + ' -MessageFile ' + quote(path.join(root, 'requests', `${intent.id}.txt`)) + ' -EvidenceFile ' + quote(bound.evidence);
      try {
        const result = await runner(executable, ['-NoProfile', '-NonInteractive', '-Command', command]);
        if (result?.id !== intent.id || result.threadId !== intent.agentId || result.messageSha256 !== intent.messageSha256 || result.marker !== intent.marker || result.transport !== 'codex-queue') fail('queue_sender_receipt_mismatch');
        // The helper receipt AND its registry attempt must own the same observation.
        const receipt = JSON.parse(bytes(path.join(root, 'requests', `${intent.id}.json`)));
        const cfg = JSON.parse(bytes(path.join(root, 'registrations.json')));
        const target = cfg.threads?.[intent.agentId];
        const attempt = [target?.queueAttempt, target?.lastQueueAttempt].find(a => a?.id === intent.id);
        for (const observation of [receipt, attempt]) if (!observation || ['id','threadId','messageSha256','marker','transport','state','turnId'].some(k => observation[k] !== result[k])) fail('queue_sender_receipt_mismatch');
        const stage = result.state === 'QUEUE_ACCEPTED' && /^[a-f0-9-]{36}$/.test(result.queuedMessageId ?? '') && Number.isFinite(Date.parse(result.acceptedAt)) ? 'ACCEPTED'
          : result.state === 'QUEUE_TURN_ACTIVE' && /^[a-f0-9-]{36}$/.test(result.turnId ?? '') ? 'RUNNING'
          : ['QUEUE_TURN_COMPLETED','QUEUE_TURN_INTERRUPTED'].includes(result.state) && /^[a-f0-9-]{36}$/.test(result.turnId ?? '') && Number.isFinite(Date.parse(result.terminalAt)) ? (result.state === 'QUEUE_TURN_COMPLETED' ? 'TURN_COMPLETED' : 'INTERRUPTED') : 'UNKNOWN';
        return { id: intent.id, agentId: intent.agentId, stage, accepted: stage === 'ACCEPTED', goalComplete: false, automaticReplay: false };
      } catch { return { id: intent.id, agentId: intent.agentId, stage: 'UNKNOWN', accepted: false, goalComplete: false, automaticReplay: false }; }
    });
  }
  return { prepare, execute };
}
