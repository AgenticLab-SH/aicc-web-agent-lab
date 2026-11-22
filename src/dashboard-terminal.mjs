import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = code => { throw Object.assign(Error(code), { code }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = value => digest(JSON.stringify(value));
const files = ['tools/platform/windows/Invoke-AiccTerminalPicker.ps1', 'tools/platform/codex/Select-PhoneTerminal.ps1', 'tools/platform/codex/Resume-PhoneTerminal.ps1'];
function bytes(file) {
  for (let p = path.resolve(file);; p = path.dirname(p)) {
    if (fs.lstatSync(p).isSymbolicLink()) fail('terminal_picker_link_denied');
    if (p === path.dirname(p)) break;
  }
  const s = fs.statSync(file);
  if (!s.isFile() || s.nlink !== 1 || s.size > 4 * 1024 * 1024) fail('terminal_picker_file_invalid');
  return fs.readFileSync(file);
}
const quote = value => "'" + value.replaceAll("'", "''") + "'";

/** Adapter to the registered tray picker; guarded resume commands are copied, never dispatched here. */
export function createDashboardTerminal({ ownerRoot, runner, executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') }) {
  const owner = path.resolve(ownerRoot);
  function pin() {
    const tray = JSON.parse(bytes(path.join(owner, 'runtime', 'components.json')).toString('utf8').replace(/^\uFEFF/, '')).components?.tray;
    const root = path.resolve(tray?.releaseRoot ?? '');
    if (!root.startsWith(path.join(owner, 'releases', 'tray') + path.sep)) fail('terminal_picker_registration_invalid');
    const pins = files.map(relative => {
      const sha256 = tray?.sourceHashes?.[relative];
      if (!SHA.test(sha256 ?? '') || digest(bytes(path.join(root, relative))) !== sha256) fail('terminal_picker_pin_mismatch');
      return { relative, sha256 };
    });
    const stat = fs.statSync(executable);
    if (!stat.isFile() || fs.lstatSync(executable).isSymbolicLink()) fail('terminal_picker_executable_invalid');
    return { helper: path.join(root, files[0]), identity: hash({ root, pins, executable, size: stat.size, mtime: stat.mtimeMs }) };
  }
  async function invoke(p, action, row) {
    if (pin().identity !== p.identity) fail('terminal_picker_pin_changed');
    const command = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);& " + quote(p.helper)
      + ' -Action ' + action + (action === 'Snapshot' ? ' -Refresh' : ' -RecordId ' + quote(row.id) + ' -Binding ' + quote(row.binding));
    return runner(executable, ['-NoProfile', '-NonInteractive', '-Command', command]);
  }
  async function inspect(agentId, resume = false) {
    if (!UUID.test(agentId ?? '')) fail('terminal_exact_agent_required');
    const p = pin(), snapshot = await invoke(p, 'Snapshot');
    if (pin().identity !== p.identity) fail('terminal_picker_pin_changed');
    if (snapshot?.schemaVersion !== 1 || snapshot.kind !== 'aicc-terminal-picker' || snapshot.attachOnlySupported !== true || !Array.isArray(snapshot.items) || snapshot.items.length > 1000) fail('terminal_picker_upgrade_required');
    const age = Date.now() - Date.parse(snapshot.observedAt);
    if (!Number.isFinite(age) || age < -5000 || age > 15000) fail('terminal_picker_observation_stale');
    const matches = snapshot.items.filter(row => row.threadId === agentId);
    if (matches.length !== 1) fail(matches.length ? 'terminal_picker_ambiguous' : 'terminal_picker_not_registered');
    const row = matches[0];
    if (!/^[a-f0-9]{32}$/.test(row.id ?? '') || typeof row.binding !== 'string' || !/^[A-Za-z0-9_.:/-]{1,700}\|[a-f0-9-]{36}$/.test(row.binding) || !row.binding.endsWith('|' + agentId) || row.kind !== 'Codex') fail('terminal_picker_binding_invalid');
    if (row.pending !== false || (resume ? row.opened !== false : row.opened !== true || row.canOpen !== true)) fail(resume ? 'terminal_picker_resume_unavailable' : 'terminal_picker_attach_unavailable');
    const revision = hash({ pin: p.identity, id: row.id, binding: row.binding, threadId: agentId, opened: row.opened, pending: row.pending });
    return { p, row, revision };
  }
  async function status(agentId) {
    try { const current = await inspect(agentId); return { supported: true, agentId, revision: current.revision, action: 'mux-attach', resumeSupported: false, reason: '열린 exact mux에 연결할 PC 창을 요청합니다. 닫힌 대화를 재개하거나 프롬프트를 보내지 않습니다.' }; }
    catch (error) { return { supported: false, agentId, resumeSupported: false, reason: /^terminal_[a-z_]+$/.test(error.code ?? '') ? error.code : 'terminal_picker_unavailable' }; }
  }
  async function resumeStatus(agentId) {
    try {
      const current = await inspect(agentId, true);
      // CheckResume is a read-only wrapper around the existing owner's release assertion.
      const proof = await invoke(current.p, 'CheckResume', current.row);
      if (pin().identity !== current.p.identity) fail('terminal_picker_pin_changed');
      const remaining = Date.parse(proof?.expiresAt) - Date.now();
      if (proof?.schemaVersion !== 1 || proof.kind !== 'aicc-terminal-resume-check' || proof.threadId !== agentId || proof.recordId !== current.row.id || proof.binding !== current.row.binding || !SHA.test(proof.releaseSha256 ?? '') || proof.normalExit !== true || proof.writerReleased !== true || proof.activeCount !== 0 || proof.unknownCount !== 0 || proof.newConversationCreated !== false || proof.promptReplayed !== false || !Number.isFinite(remaining) || remaining <= 0 || remaining > 65000) fail('terminal_picker_resume_proof_invalid');
      if (!['opencodex', 'aicc-ocx', 'aicc-ocx-compat'].includes(proof.provider) || !/^[A-Za-z0-9._/-]{1,120}$/.test(proof.model ?? '') || !/^[A-Za-z0-9_-]{0,40}$/.test(proof.effort ?? '')) fail('terminal_picker_resume_route_invalid');
      const command = '& ' + quote(current.p.helper) + ' -Action ResumeChecked -RecordId ' + quote(current.row.id) + ' -Binding ' + quote(current.row.binding) + ' -ExpectedReleaseSha256 ' + quote(proof.releaseSha256);
      return { supported: true, agentId, command, expiresAt: proof.expiresAt, provider: proof.provider, model: proof.model, effort: proof.effort, executed: false, reason: '현재 종료·작성권 해제를 확인한 exact 재개 명령입니다. 복사 후 실행 시 다시 검사하며 만료되면 새 근거가 필요합니다. 추가 프롬프트를 보내지 않습니다.' };
    } catch (error) { return { supported: false, agentId, executed: false, reason: /^terminal_[a-z_]+$/.test(error.code ?? '') ? error.code : 'terminal_picker_resume_unavailable' }; }
  }
  async function prepare(input) {
    if (!input || Object.keys(input).some(k => !['action', 'agentId', 'expectedTerminalRevision', 'expectedReportRevision'].includes(k)) || input.action !== 'mux-attach' || !SHA.test(input.expectedTerminalRevision ?? '')) fail('terminal_picker_input_invalid');
    const current = await inspect(input.agentId);
    if (current.revision !== input.expectedTerminalRevision) fail('terminal_picker_target_changed');
    return { kind: 'terminal', fingerprint: hash({ action: input.action, agentId: input.agentId, revision: current.revision }), summary: [`exact 대화: ${input.agentId}`, 'PC에서 이미 열린 mux 연결 창을 한 번 요청합니다. 새 대화·닫힌 대화 재개·프롬프트 발신은 하지 않습니다.'], ...current };
  }
  async function execute(input) {
    const prepared = await prepare(input), result = await invoke(prepared.p, 'AttachOnly', prepared.row);
    if (result?.state !== 'ATTACH_WINDOW_REQUESTED' || result.newConversationCreated !== false || result.promptReplayed !== false) fail('terminal_picker_outcome_unknown');
    if (pin().identity !== prepared.p.identity) fail('terminal_picker_outcome_unknown');
    return { state: result.state, agentId: input.agentId, newConversationCreated: false, promptReplayed: false, attachedVerified: false };
  }
  return { status, resumeStatus, prepare, execute };
}
