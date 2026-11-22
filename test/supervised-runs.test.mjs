import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import { createSupervisedRunService } from '../src/supervised-runs/service.mjs';
import { createKiroRunner, createCodexRunner } from '../src/supervised-runs/runners.mjs';
import { runSuperviseCommand } from '../src/supervised-runs/cli.mjs';

const G1 = 'sess_11111111-1111-4111-8111-111111111111';
const G2 = 'sess_22222222-2222-4222-8222-222222222222';
const S0 = 'sess_00000000-0000-4000-8000-000000000000';
const CODEX = '019a0000-0000-7000-8000-000000000001';
const NOW = Date.parse('2026-11-01T08:00:00+09:00');

function wakeFixture(t) {
  const f = fixture(t);
  const cfg = readConfig(f);
  cfg.groups.push({ name: 'C1', runner: 'codex', sessionId: CODEX, workingDirectory: f.base, wakeCallbackId: 'callback-1' });
  fs.writeFileSync(path.join(f.supervisor, 'wake-config.json'), JSON.stringify(cfg));
  const resultFile = path.join(f.base, 'result.json');
  fs.writeFileSync(resultFile, JSON.stringify({ operation: 'fixture', status: 'PASS' }));
  const binding = { callbackId: 'callback-1', taskId: CODEX, projectRoot: f.base, resultFile, state: 'armed' };
  const deliveries = [];
  const callbacks = {
    inspect: () => ({ ...binding }),
    complete: async input => { deliveries.push(input); binding.state = 'turn_started'; return { ok: true, state: 'turn_started', turnId: 'turn-1', submitted: true }; }
  };
  const service = createSupervisedRunService({ runsRoot: f.runsRoot, stateRoot: path.join(f.base, 'state'), callbacks, listProcesses: async () => null });
  return { ...f, binding, resultFile, deliveries, service, callbacks };
}

test('wake connects a bound exact Codex callback once and distinguishes submission from goal completion', async t => {
  const f = wakeFixture(t);
  const status = await f.service.status({ run: 'night-run' });
  assert.equal(status.runs[0].groups.at(-1).state, 'observation_unknown');
  await assert.rejects(f.service.preview('close-tab', { run: 'night-run', name: 'C1' }), { code: 'codex_close_not_supported' });
  const p = await f.service.preview('wake-group', { run: 'night-run', name: 'C1' });
  const outcomes = await Promise.allSettled([f.service.confirm(p.confirmationToken), f.service.confirm(p.confirmationToken)]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  const result = outcomes.find(item => item.status === 'fulfilled').value;
  assert.equal(result.delivery.state, 'turn_started');
  assert.equal(result.goalCompleted, false);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].waitForTerminal, false);
  assert.equal(f.deliveries[0].expectedResultSha256, crypto.createHash('sha256').update(fs.readFileSync(f.resultFile)).digest('hex'));
  await assert.rejects(f.service.preview('wake-group', { run: 'night-run', name: 'C1' }), { code: 'callback_not_dispatchable' });
});

test('wrong callback thread/root and UNKNOWN delivery stay held without creating another turn', async t => {
  const f = wakeFixture(t);
  f.binding.taskId = 'different';
  await assert.rejects(f.service.preview('wake-group', { run: 'night-run', name: 'C1' }), { code: 'callback_scope_mismatch' });
  f.binding.taskId = CODEX; f.binding.projectRoot = path.join(f.base, 'other');
  await assert.rejects(f.service.preview('wake-group', { run: 'night-run', name: 'C1' }), { code: 'callback_scope_mismatch' });
  f.binding.projectRoot = f.base;
  f.callbacks.complete = async () => { f.binding.state = 'dispatching'; throw Object.assign(new Error('unknown'), { code: 'callback_delivery_unknown' }); };
  const p = await f.service.preview('wake-group', { run: 'night-run', name: 'C1' });
  await assert.rejects(f.service.confirm(p.confirmationToken), { code: 'callback_delivery_unknown' });
  await assert.rejects(f.service.confirm(p.confirmationToken), { code: 'confirmation_not_found' });
  await assert.rejects(f.service.preview('wake-group', { run: 'night-run', name: 'C1' }), { code: 'callback_not_dispatchable' });
});

test('preview confirmation is bound to its surface and exact browser session', async t => {
  const f = fixture(t);
  const scope = { scope: 'local', sessionId: 'pc-1' };
  const p = await f.service.preview('end-group', { run: 'night-run', name: 'G2' }, scope);
  for (const other of [{ scope: 'phone', sessionId: 'phone-1' }, { scope: 'local', sessionId: 'pc-2' }]) {
    await assert.rejects(f.service.confirm(p.confirmationToken, other), { code: 'confirmation_scope_mismatch' });
  }
  assert.equal((await f.service.confirm(p.confirmationToken, scope)).ok, true);
});

function fixture(t, { config, alive = new Set() } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-supervise-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const runsRoot = path.join(base, 'ops');
  const opsDirectory = path.join(runsRoot, 'night-run');
  const supervisor = path.join(opsDirectory, 'SUPERVISOR');
  const sessionsRoot = path.join(base, 'kiro-sessions');
  fs.mkdirSync(supervisor, { recursive: true });
  const progress = path.join(base, 'G1-PROGRESS.md');
  fs.writeFileSync(progress, '| 07:50 | 1단계 완료 |\n| 07:55 | 2단계 진행 |\n');
  const cfg = config ?? {
    taskName: 'AICC-S0-Wake', deadline: '2026-11-01T09:00:00+09:00', minGapMinutes: 8, staleMinutes: 45,
    s0: { sessionId: S0, agent: 'codex-local', workingDirectory: supervisor, wakePrompt: path.join(supervisor, 'WAKE-PROMPT.md'), model: 'm', effort: 'high' },
    groups: [{ name: 'G1', sessionId: G1, progressFile: progress, agent: 'codex-g1', workingDirectory: base }, { name: 'G2', sessionId: G2 }, { name: 'G3', sessionId: null }]
  };
  // BOM 있는 기존 파일(PowerShell 작성)도 읽는다.
  fs.writeFileSync(path.join(supervisor, 'wake-config.json'), `\uFEFF${JSON.stringify(cfg, null, 4)}`);
  fs.writeFileSync(path.join(supervisor, 'wake-log.md'), '| 2026-11-01 07:52:49 | S0 깨움 · 새로 끝난 차례: G1 · 결과 LAUNCHED |\n');
  fs.writeFileSync(path.join(supervisor, 'SUPERVISOR-LOG.md'), '# S0\n- 07:53 G1 회수\n');
  fs.writeFileSync(path.join(supervisor, 'wake-state.json'), JSON.stringify({ lastWakeAt: '2026-11-01T07:52:37+09:00' }));
  const session = (id, status, pid, lines) => {
    const dir = path.join(sessionsRoot, 'bucket', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ id, status, title: id.slice(0, 9) }));
    fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid }));
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  };
  session(G1, 'in_progress', 101, [{ timestamp: '2026-10-31T22:40:00.000Z', payload: { type: 'turn_end' } }, { timestamp: 'x', payload: { type: 'turn_start' } }]);
  session(G2, 'idle', 202, [{ timestamp: '2026-10-31T22:30:00.000Z', payload: { type: 'turn_end' } }]);
  session(S0, 'in_progress', 303, []);
  const calls = [];
  const fakeRun = async (executable, args) => { calls.push({ executable, args }); return { ok: true, exitCode: 0, stdout: '', stderr: '' }; };
  const kiro = createKiroRunner({ sessionsRoot, isPidAlive: pid => alive.has(pid), now: () => NOW, paths: { pwsh: 'pwsh-fake' } });
  const service = createSupervisedRunService({
    runsRoot, stateRoot: path.join(base, 'state'), now: () => NOW, runCommand: fakeRun,
    runners: { kiro, codex: createCodexRunner({ paths: { pwsh: 'pwsh-fake' } }) },
    listProcesses: async () => [{ pid: 9, commandLine: `codex.exe exec resume ${CODEX} "go"` }],
    paths: { pwsh: 'pwsh-fake', newRun: 'New-KiroSupervisedRun.ps1' }
  });
  return { base, runsRoot, opsDirectory, supervisor, sessionsRoot, service, calls, alive, progress };
}

const readConfig = f => JSON.parse(fs.readFileSync(path.join(f.supervisor, 'wake-config.json'), 'utf8').replace(/^\uFEFF/, ''));

test('status reads the single canonical wake-config and classifies each group', async t => {
  const f = fixture(t, { alive: new Set([101, 202, 303]) });
  fs.utimesSync(path.join(f.sessionsRoot, 'bucket', G1, 'messages.jsonl'), new Date(NOW - 60_000), new Date(NOW - 60_000));
  const result = await f.service.status();
  assert.equal(result.runs.length, 1);
  const run = result.runs[0];
  assert.equal(run.runName, 'night-run');
  assert.equal(run.schemaVersion, 0);
  assert.equal(run.deadlinePassed, false);
  assert.equal(run.lastWakeAt, '2026-11-01T07:52:37+09:00');
  assert.match(run.lastWakeLog, /G1/);
  const byName = Object.fromEntries(run.groups.map(group => [group.name, group]));
  assert.equal(byName.G1.state, 'turn_active');
  assert.equal(byName.G1.stateLabel, '차례 진행');
  assert.equal(byName.G1.lastTurnEndAt, '2026-10-31T22:40:00.000Z');
  assert.ok(byName.G1.lastProgressAt, 'PROGRESS mtime is reported');
  assert.equal(byName.G2.state, 'waiting');
  assert.equal(byName.G2.tabOpen, true);
  assert.equal(byName.G3.state, 'unopened');
  assert.equal(run.s0.state, 'turn_active');
});

test('crashed and stale sessions are distinguished from waiting', async t => {
  const f = fixture(t, { alive: new Set([303]) });
  let run = (await f.service.status({ run: 'night-run' })).runs[0];
  assert.equal(run.groups.find(group => group.name === 'G1').state, 'crashed');
  f.alive.add(101);
  fs.utimesSync(path.join(f.sessionsRoot, 'bucket', G1, 'messages.jsonl'), new Date(NOW - 50 * 60_000), new Date(NOW - 50 * 60_000));
  run = (await f.service.status({ run: 'night-run' })).runs[0];
  assert.equal(run.groups.find(group => group.name === 'G1').state, 'stale');
});

test('Codex process presence and absence never prove turn idle or authorize prompt replay', () => {
  const codex = createCodexRunner();
  const open = codex.inspect(CODEX, { processes: [{ commandLine: `codex exec resume ${CODEX} x` }] });
  assert.equal(open.processAlive, true);
  assert.equal(open.activityUnknown, true);
  for (const processes of [[], null]) assert.equal(codex.inspect(CODEX, { processes }).activityUnknown, true);
  assert.throws(() => codex.openCommand({}), { code: 'direct_launch_retired' });
  assert.throws(() => codex.closeCommand({}), { code: 'codex_close_not_supported' });
});
test('kiro open command uses the elevated request for admin tabs and Open-KiroSession otherwise', () => {
  const kiro = createKiroRunner({ paths: { pwsh: 'p', requestElevatedKiro: 'REQ.ps1', openKiro: 'OPEN.ps1', closeTab: 'CLOSE.ps1' } });
  const group = { name: 'G9', sessionId: G1, agent: 'codex-g1', workingDirectory: 'C:\\w', promptFile: 'C:\\p.md', elevated: true };
  assert.ok(kiro.openCommand(group, { replace: true }).args.includes('REQ.ps1'));
  assert.ok(kiro.openCommand(group, { replace: true }).args.includes('-Replace'));
  assert.ok(kiro.closeCommand(group).args.includes('-CloseOnly'));
  assert.ok(kiro.openCommand({ ...group, elevated: false }).args.includes('OPEN.ps1'));
  assert.ok(kiro.closeCommand({ ...group, elevated: false }).args.includes('CLOSE.ps1'));
});

test('add-group: preview is one-use, writes canonical file atomically and keeps existing fields', async t => {
  const f = fixture(t);
  const before = readConfig(f);
  const preview = await f.service.preview('add-group', { run: 'night-run', group: { name: 'G5', runner: 'codex', workingDirectory: f.base, sessionId: CODEX } });
  assert.equal(preview.ok, true);
  assert.deepEqual(readConfig(f), before, 'preview does not write');
  const result = await f.service.confirm(preview.confirmationToken);
  assert.equal(result.ok, true);
  const after = readConfig(f);
  assert.equal(after.schemaVersion, 1);
  assert.equal(after.taskName, 'AICC-S0-Wake');
  assert.deepEqual(after.s0, before.s0);
  assert.equal(after.groups.at(-1).name, 'G5');
  assert.equal(after.groups.at(-1).runner, 'codex');
  await assert.rejects(f.service.confirm(preview.confirmationToken), { code: 'confirmation_not_found' });
  assert.equal(f.calls.length, 0, 'no tab opened without open:true');
  await assert.rejects(f.service.preview('add-group', { run: 'night-run', group: { name: 'G5', runner: 'codex', workingDirectory: f.base } }), { code: 'group_exists' });
});

test('stale preview is refused when the canonical file changed after preview', async t => {
  const f = fixture(t);
  const preview = await f.service.preview('end-group', { run: 'night-run', name: 'G2' });
  const cfg = readConfig(f); cfg.groups[2].sessionId = G2.replace('2222-4222', '3333-4333');
  fs.writeFileSync(path.join(f.supervisor, 'wake-config.json'), JSON.stringify(cfg));
  await assert.rejects(f.service.confirm(preview.confirmationToken), { code: 'stale_preview' });
  assert.equal(readConfig(f).groups.some(group => group.name === 'G2'), true);
});

test('end-group moves the group to endedGroups so the wake script stops watching it', async t => {
  const f = fixture(t, { alive: new Set([202]) });
  const preview = await f.service.preview('end-group', { run: 'night-run', name: 'G2', reason: '완료', closeTab: true });
  const result = await f.service.confirm(preview.confirmationToken);
  assert.equal(result.ok, true);
  const cfg = readConfig(f);
  assert.equal(cfg.groups.some(group => group.name === 'G2'), false);
  assert.equal(cfg.endedGroups[0].name, 'G2');
  assert.equal(cfg.endedGroups[0].reason, '완료');
  assert.equal(result.followUp.step, 'close-tab');
  assert.equal(f.calls.length, 1);
  const status = (await f.service.status()).runs[0];
  assert.equal(status.endedGroups[0].state, 'ended');
});

test('close-tab refuses an active turn and verifies the tab process is gone', async t => {
  const f = fixture(t, { alive: new Set([101, 202]) });
  await assert.rejects(f.service.preview('close-tab', { run: 'night-run', name: 'G1' }), { code: 'turn_active' });
  const preview = await f.service.preview('close-tab', { run: 'night-run', name: 'G2' });
  // 가짜 runner: 닫기 명령이 실행되면 프로세스가 사라진 것으로 만든다.
  f.calls.length = 0;
  const original = f.alive;
  const svc = f.service;
  const result = await (async () => { original.delete(202); return svc.confirm(preview.confirmationToken); })();
  assert.equal(result.ok, true);
  assert.match(result.rollback.hint, /Request-ElevatedKiro/);
});

test('close-tab reports failure when the process survives', async t => {
  const f = fixture(t, { alive: new Set([202]) });
  const preview = await f.service.preview('close-tab', { run: 'night-run', name: 'G2' });
  const result = await f.service.confirm(preview.confirmationToken);
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
});

test('single writer: a held lock refuses confirm', async t => {
  const f = fixture(t);
  const preview = await f.service.preview('end-group', { run: 'night-run', name: 'G2' });
  fs.mkdirSync(path.join(f.base, 'state', 'supervised-runs'), { recursive: true });
  fs.writeFileSync(path.join(f.base, 'state', 'supervised-runs', 'writer.lock'), '{}');
  await assert.rejects(f.service.confirm(preview.confirmationToken), { code: 'writer_busy' });
});

test('expired confirmation is refused', async t => {
  const f = fixture(t);
  const preview = await f.service.preview('end-group', { run: 'night-run', name: 'G2' });
  const late = createSupervisedRunService({ runsRoot: f.runsRoot, stateRoot: path.join(f.base, 'state'), now: () => NOW + 10 * 60_000, runCommand: async () => ({ ok: true }) });
  await assert.rejects(late.confirm(preview.confirmationToken), { code: 'confirmation_expired' });
});

test('start prepares the existing canonical run without Kiro, model launch or scheduler commands', async t => {
  const f = fixture(t);
  const input = { runName: 'r2', deadline: '2026-11-02T09:00:00+09:00', groups: [{ name: 'C1', runner: 'codex', workingDirectory: f.base }] };
  assert.throws(() => f.service.plan({ ...input, runName: 'x y' }), { code: 'invalid_run_name' });
  assert.throws(() => f.service.plan({ ...input, deadline: '2026-11-02T09:00:00' }), { code: 'invalid_deadline' });
  assert.throws(() => f.service.plan({ ...input, opsDirectory: path.join(f.base, 'elsewhere') }), { code: 'ops_outside_root' });
  assert.throws(() => f.service.plan({ ...input, launch: true }), { code: 'supervisor_launch_retired' });
  assert.equal(f.service.plan(input).wouldCreate.length, 1);
  const preview = await f.service.preview('start', input);
  const result = await f.service.confirm(preview.confirmationToken);
  assert.equal(result.ok, true);
  assert.equal(result.executionStarted, false);
  const cfg = JSON.parse(fs.readFileSync(path.join(f.runsRoot, 'r2', 'SUPERVISOR', 'wake-config.json')));
  assert.equal(cfg.s0, null);
  assert.equal(cfg.taskName, null);
  assert.equal(cfg.groups[0].runner, 'codex');
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.preview('start', input), { code: 'run_exists' });
});

test('direct launch cannot reactivate Kiro or replay a saved Codex request', async t => {
  const f = fixture(t);
  for (const runner of ['kiro', 'codex']) {
    await assert.rejects(f.service.preview('add-group', { run: 'night-run', open: true,
      group: { name: 'C2', runner, agent: 'legacy', workingDirectory: f.base, promptFile: f.progress } }), { code: 'direct_launch_retired' });
  }
  assert.equal(f.calls.length, 0);
});
test('logs returns tails of wake-log, SUPERVISOR-LOG and group PROGRESS', async t => {
  const f = fixture(t);
  const result = f.service.logs({ run: 'night-run', lines: 1 });
  assert.equal(result.wakeLog.length, 1);
  assert.match(result.supervisorLog[0], /G1 회수/);
  assert.match(result.groups.find(group => group.name === 'G1').lines[0], /2단계/);
});

test('unknown actions and runs outside the registered root are refused', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.preview('delete-run', {}), { code: 'action_not_allowed' });
  await assert.rejects(f.service.preview('end-group', { run: path.join(f.base, 'nope'), name: 'G1' }), { code: 'run_not_found' });
  await assert.rejects(f.service.preview('add-group', { run: 'night-run', group: { name: 'S0', agent: 'a', workingDirectory: f.base } }), { code: 'invalid_group_name' });
  await assert.rejects(f.service.preview('add-group', { run: 'night-run', group: { name: 'G7', agent: 'a', workingDirectory: 'relative' } }), { code: 'invalid_path' });
});

test('cli prints json status and requires a token for confirm', async t => {
  const f = fixture(t);
  const out = [];
  const result = await runSuperviseCommand(['status', '--json'], { service: f.service, log: line => out.push(line) });
  assert.equal(JSON.parse(out[0]).runs[0].runName, 'night-run');
  assert.equal(result.ok, true);
  await assert.rejects(runSuperviseCommand(['confirm'], { service: f.service, log: () => {} }), /confirmation/);
  await assert.rejects(runSuperviseCommand(['bogus'], { service: f.service, log: () => {} }), /알 수 없는/);
});
