import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDashboardTerminal } from '../src/dashboard-terminal.mjs';
import { createServer } from '../src/server.mjs';

const agentId = '01234567-89ab-4cde-8012-3456789abcde';
const reportRevision = 'd'.repeat(64);
function fixture() {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-terminal-fixture-'));
  const release = path.join(ownerRoot, 'releases', 'tray', 'synthetic');
  const sourceHashes = {}, files = ['tools/platform/windows/Invoke-AiccTerminalPicker.ps1', 'tools/platform/codex/Select-PhoneTerminal.ps1', 'tools/platform/codex/Resume-PhoneTerminal.ps1'];
  for (const file of files) {
    const full = path.join(release, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, '# inert fixture');
    sourceHashes[file] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  }
  fs.mkdirSync(path.join(ownerRoot, 'runtime'));
  fs.writeFileSync(path.join(ownerRoot, 'runtime', 'components.json'), JSON.stringify({ components: { tray: { releaseRoot: release, sourceHashes } } }));
  const executable = path.join(ownerRoot, 'fake.exe'); fs.writeFileSync(executable, 'never executed');
  const row = { id: 'a'.repeat(32), binding: 'existing-session:0.0|' + agentId, threadId: agentId, kind: 'Codex', opened: true, pending: false, canOpen: true };
  const f = { ownerRoot, release, row, calls: [], failAttach: false, snapshot: { schemaVersion: 1, kind: 'aicc-terminal-picker', attachOnlySupported: true, items: [row] } };
  f.runner = async (_file, args) => {
    const command = args.at(-1); f.calls.push(command);
    if (command.includes('-Action Snapshot')) return { observedAt: new Date().toISOString(), ...f.snapshot };
    if (command.includes('-Action CheckResume')) return { schemaVersion: 1, kind: 'aicc-terminal-resume-check', recordId: row.id, threadId: agentId, binding: row.binding, releaseSha256: 'f'.repeat(64), expiresAt: new Date(Date.now() + 30000).toISOString(), provider: 'aicc-ocx', model: 'existing-model', effort: 'high', normalExit: true, writerReleased: true, activeCount: 0, unknownCount: 0, newConversationCreated: false, promptReplayed: false, ...f.proof };
    assert.match(command, /-Action AttachOnly/); assert.doesNotMatch(command, /-Action (?:Open|Connect|PowerShell)/);
    if (f.failAttach) throw Object.assign(Error('synthetic timeout'), { code: 'helper_outcome_unknown' });
    return { state: 'ATTACH_WINDOW_REQUESTED', newConversationCreated: false, promptReplayed: false };
  };
  f.service = createDashboardTerminal({ ownerRoot, runner: f.runner, executable });
  f.input = async () => ({ action: 'mux-attach', agentId, expectedReportRevision: reportRevision, expectedTerminalRevision: (await f.service.status(agentId)).revision });
  return f;
}

test('registered picker pins and fresh exact target allow AttachOnly without exposing owner paths', async () => {
  const f = fixture(), state = await f.service.status(agentId);
  assert.equal(state.supported, true); assert.equal(state.resumeSupported, false); assert.doesNotMatch(JSON.stringify(state), /existing-session|synthetic|releaseRoot/);
  const input = await f.input(), prepared = await f.service.prepare(input);
  assert.match(prepared.summary.join(' '), /새 대화/);
  const result = await f.service.execute(input);
  assert.equal(result.attachedVerified, false); assert.equal(result.promptReplayed, false);
  assert.equal(f.calls.filter(s => s.includes('-Action AttachOnly')).length, 1);
});

test('closed exact resume check returns only a guarded original-route command and never dispatches resume', async () => {
  const f = fixture(); f.row.opened = false;
  const result = await f.service.resumeStatus(agentId);
  assert.equal(result.supported, true); assert.equal(result.executed, false);
  assert.match(result.command, /-Action ResumeChecked/); assert.match(result.command, /-ExpectedReleaseSha256/);
  assert.doesNotMatch(result.command, /--route-model|exec resume|Native|prompt/);
  assert.equal(f.calls.some(s => /-Action (?:ResumeChecked|AttachOnly|Open)/.test(s)), false);
});

test('resume proof expiry, changed writer, UNKNOWN, wrong thread, route and duplicate record fail closed', async () => {
  for (const proof of [{ expiresAt: '2000-01-01T00:00:00Z' }, { writerReleased: false }, { unknownCount: 1 }, { activeCount: 1 }, { threadId: 'wrong' }, { binding: 'changed' }, { provider: 'native' }, { releaseSha256: 'invalid' }, { promptReplayed: true }]) {
    const f = fixture(); f.row.opened = false; f.proof = proof;
    assert.equal((await f.service.resumeStatus(agentId)).supported, false);
    assert.equal(f.calls.some(s => s.includes('-Action ResumeChecked')), false);
  }
  const f = fixture(); f.row.opened = false; f.snapshot.items.push({ ...f.row });
  assert.equal((await f.service.resumeStatus(agentId)).reason, 'terminal_picker_ambiguous');
});

test('closed, pending, ambiguous, wrong kind, stale and older picker observations remain unavailable', async () => {
  for (const change of [
    f => { f.row.opened = false; }, f => { f.row.pending = true; }, f => { f.snapshot.items.push({ ...f.row }); },
    f => { f.row.kind = 'PowerShell'; }, f => { f.snapshot.observedAt = '2000-01-01T00:00:00Z'; },
    f => { delete f.snapshot.attachOnlySupported; }, f => { f.row.binding = 'wrong|other'; }, f => { f.row.binding = 'pane" -Action Open|' + agentId; }
  ]) {
    const f = fixture(); change(f); const result = await f.service.status(agentId);
    assert.equal(result.supported, false); assert.equal(f.calls.some(s => s.includes('-Action AttachOnly')), false);
  }
});

test('changed binding, changed source pin and unapproved input reject before attach', async () => {
  const f = fixture(), input = await f.input(); f.row.binding = 'new-pane|' + agentId;
  await assert.rejects(f.service.execute(input), /target_changed/);
  await assert.rejects(f.service.prepare({ ...input, command: 'anything' }), /input_invalid/);
  fs.appendFileSync(path.join(f.release, 'tools/platform/windows/Invoke-AiccTerminalPicker.ps1'), '# drift');
  assert.equal((await f.service.status(agentId)).reason, 'terminal_picker_pin_mismatch');
  assert.equal(f.calls.some(s => s.includes('-Action AttachOnly')), false);
});

test('mobile terminal action uses auth, CSRF, fresh preview, single confirm and recoverable UNKNOWN receipts', async t => {
  const f = fixture(); let revision = reportRevision;
  const server = createServer({ goals: { ownerRoot: f.ownerRoot }, mobile: { ownerRoot: f.ownerRoot, terminalPicker: f.service,
    dashboard: { status: () => ({ agents: [{ id: agentId, reportRevision: revision }] }) }, trayTools: { status: async () => ({ catalog: [], unresolved: [] }) } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function api(endpoint, auth = {}, body) {
    const response = await fetch(origin + '/api/mobile/' + endpoint, { method: body ? 'POST' : 'GET', headers: { origin, ...auth, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  assert.equal((await api('dashboard-terminal?agentId=' + agentId)).data.code, 'pair_required');
  const session = await api('local-session', {}, {}), cookie = session.headers.get('set-cookie').split(';')[0];
  const auth = { cookie, 'x-aicc-csrf': session.data.csrf };
  const input = { kind: 'terminal', config: await f.input() };
  assert.equal((await api('preview', { cookie }, input)).data.code, 'csrf_required');
  assert.equal((await api('dashboard-resume-check', { cookie }, { agentId, expectedReportRevision: reportRevision })).data.code, 'csrf_required');
  assert.equal((await api('dashboard-resume-check', auth, { agentId, expectedReportRevision: 'stale' })).data.code, 'dashboard_report_changed');
  f.row.opened = false;
  assert.equal((await api('dashboard-resume-check', auth, { agentId, expectedReportRevision: reportRevision })).data.supported, true);
  f.row.opened = true;
  assert.equal((await api('dashboard-terminal?agentId=' + agentId, auth)).data.supported, true);
  let p = await api('preview', auth, input); assert.equal(p.status, 200);
  f.row.binding = 'changed|' + agentId;
  assert.equal((await api('confirm', auth, { confirmationToken: p.data.confirmationToken })).data.code, 'terminal_picker_target_changed');
  input.config = await f.input(); p = await api('preview', auth, input); revision = 'e'.repeat(64);
  assert.equal((await api('confirm', auth, { confirmationToken: p.data.confirmationToken })).data.code, 'dashboard_report_changed'); revision = reportRevision;
  p = await api('preview', auth, input); assert.equal(p.status, 200);
  const c = await api('confirm', auth, { confirmationToken: p.data.confirmationToken }); assert.equal(c.status, 202);
  assert.equal((await api('confirm', auth, { confirmationToken: p.data.confirmationToken })).data.code, 'confirmation_expired');
  let outcome;
  for (let n = 0; n < 30; n++) { outcome = await api('operation?id=' + c.data.operationId, auth); if (outcome.data.state !== 'DISPATCHING') break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(outcome.data.state, 'COMPLETED'); assert.equal(outcome.data.terminalResult.attachedVerified, false);
  const hash = createHash('sha256').update(p.data.confirmationToken).digest('hex');
  assert.equal((await api('operation-by-confirmation?sha256=' + hash, auth)).data.operationId, c.data.operationId);
  f.failAttach = true; p = await api('preview', auth, input); const unknown = await api('confirm', auth, { confirmationToken: p.data.confirmationToken });
  for (let n = 0; n < 30; n++) { outcome = await api('operation?id=' + unknown.data.operationId, auth); if (outcome.data.state !== 'DISPATCHING') break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(outcome.data.state, 'UNKNOWN');
  assert.equal((await api('preview', auth, input)).data.code, 'previous_outcome_unknown');
  assert.equal((await api('dashboard-resume-check', auth, { agentId, expectedReportRevision: reportRevision })).data.code, 'previous_outcome_unknown');
  assert.equal(f.calls.filter(s => s.includes('-Action AttachOnly')).length, 2);
});
