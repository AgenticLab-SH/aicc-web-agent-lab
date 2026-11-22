import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSlackResponseInbox, responseBlocks, WINDOWS_PRIVATE_ACL_POLICY } from '../src/notifications/slack-response-inbox.mjs';
import { runInboxCommand } from '../tools/platform/slack/response-inbox.mjs';
import { pendingSlackHint } from '../tools/platform/codex/slack-response-hook.mjs';
import { createSlackBotTransport } from '../src/slack-bot-transport.mjs';

const identity = { teamId: 'T123456789', appId: 'A123456789', userId: 'U123456789', botUserId: 'U987654321', botId: 'B123456789' };
function fixture(t, approval = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-slack-inbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = 1800000000000;
  // ACL is separately checked in production; this suite uses an isolated temporary directory.
  const options = { root, identity, now: () => clock, checkDirectory: () => {} };
  const inbox = createSlackResponseInbox(options);
  const input = { projectKey: 'project-a', taskId: 'task-a', revision: 'rev-1', operation: '테스트 파일 한 개 검증', approval,
    expiresAt: new Date(clock + 600000).toISOString() };
  const request = inbox.create(input);
  inbox.bind(request.requestId, { ...identity, recipientUserId: identity.userId, channelId: 'D123456789', messageTs: '1800000000.000001' });
  const body = { type: 'block_actions', team: { id: identity.teamId }, api_app_id: identity.appId, user: { id: identity.userId },
    channel: { id: 'D123456789' }, container: { type: 'message', channel_id: 'D123456789', message_ts: '1800000000.000001' },
    message: { user: identity.botUserId, bot_id: identity.botId, app_id: identity.appId, ts: '1800000000.000001' },
    actions: [{ type: 'button', action_id: 'aicc_response_approve', value: `${request.requestId}:${request.operationHash}`, action_ts: '1800000000.001' }] };
  return { root, options, inbox, input, request, body, tick(ms) { clock += ms; } };
}

test('FR1/3/4/5/6: response survives restart, exact-task receipt is not execution', t => {
  const f = fixture(t);
  assert.match(responseBlocks(f.request)[0].text.text, /유효 시간: .* KST/);
  const result = f.inbox.receive(f.body);
  assert.equal(result.state, 'queued_transport_unavailable');
  const reopened = createSlackResponseInbox(f.options);
  assert.equal(reopened.pending({ projectKey: 'project-b', taskId: 'task-a' }).length, 0);
  const [pending] = reopened.pending(f.input);
  assert.equal(pending.action, 'approve');
  assert.match(pending.authority, /not_native_permission/);
  assert.throws(() => reopened.acknowledge({ ...pending, taskId: 'task-b' }), /binding/);
  assert.throws(() => reopened.acknowledge({ ...pending, operationHash: 'changed' }), /binding/);
  assert.deepEqual(reopened.acknowledge(pending), { ok: true, state: 'agent_seen', executionVerified: false });
  assert.equal(reopened.pending(f.input).length, 0);
  assert.equal(reopened.status().desktopAutoWake, false);
});

test('FR2: duplicate delivery is idempotent and later different answer cannot change consent', t => {
  const f = fixture(t);
  f.inbox.receive(f.body);
  assert.equal(f.inbox.receive(f.body).state, 'duplicate');
  f.body.actions[0].action_id = 'aicc_response_reject';
  assert.throws(() => f.inbox.receive(f.body), /already_answered/);
});

test('FR1/7: optional outbound card preserves delivery dedupe and hashes the exact buttons', async t => {
  const f = fixture(t); const posted = [];
  const transport = createSlackBotTransport({
    config: { ...identity, recipientUserId: identity.userId, schemaVersion: 1, transport: 'aicc_slack_bot', keychainService: 'test-slack', keychainAccount: 'test-owner' },
    deliveryStateRoot: path.join(f.root, 'deliveries'), tokenProvider: async () => 'xoxb-demo-fixture-value-1',
    fetchImpl: async (url, init) => {
      const body = url.endsWith('/auth.test') ? { ok: true, team_id: identity.teamId, user_id: identity.botUserId, bot_id: identity.botId }
        : { ok: true, channel: 'D123456789', ts: '1800000000.000001', message: { user: identity.botUserId, bot_id: identity.botId, app_id: identity.appId } };
      if (url.endsWith('/chat.postMessage')) posted.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => body };
    }
  });
  const message = { eventId: 'response-test:card-v1', message: '검증 응답 요청', responseRequest: f.request };
  assert.equal((await transport.send(message)).state, 'sent');
  assert.equal((await transport.send(message)).state, 'duplicate');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].blocks[1].elements[2].value, `${f.request.requestId}:${f.request.operationHash}`);
  await assert.rejects(transport.send({ ...message, responseRequest: { ...f.request, revision: 'changed' } }), /idempotency_conflict/);
});

for (const [name, mutate] of Object.entries({
  workspace: b => b.team.id = 'T000000000', app: b => b.api_app_id = 'A000000000',
  sender: b => b.user.id = 'U000000000', bot: b => b.message.bot_id = 'B000000000',
  channel: b => b.channel.id = 'D000000000', message: b => b.container.message_ts = '1800000000.000002',
  revision: b => b.actions[0].value = b.actions[0].value.replace(/.$/, 'z'),
  edited: b => b.message.edited = { ts: '1800000001.0' },
  stale: b => b.actions[0].action_ts = '1700000000.0',
  future: b => b.actions[0].action_ts = '1900000000.0',
  freeText: b => b.actions[0].action_id = 'run_a_shell_command',
  multiple: b => b.actions.push(b.actions[0]),
  wrongType: b => b.actions[0].type = 'plain_text_input'
})) test(`FR2: rejects ${name}`, t => {
  const f = fixture(t); mutate(f.body);
  assert.throws(() => f.inbox.receive(f.body));
  assert.equal(f.inbox.pending(f.input).length, 0);
});

test('FR3: approval needs an approval request; acknowledgement and done are not approval', t => {
  const f = fixture(t, false);
  assert.throws(() => f.inbox.receive(f.body), /approval_not_requested/);
  assert.equal(responseBlocks(f.request)[1].elements.some(b => b.action_id === 'aicc_response_approve'), false);
  f.body.actions[0].action_id = 'aicc_response_done';
  f.inbox.receive(f.body);
  assert.equal(f.inbox.pending(f.input)[0].authority, 'owner_response_not_completion_proof');
});

test('FR3/6: approval expires even if received before expiry; cancel never grants', t => {
  const f = fixture(t); f.inbox.receive(f.body);
  const [response] = f.inbox.pending(f.input);
  f.tick(600001);
  assert.equal(f.inbox.pending(f.input).length, 0);
  assert.throws(() => f.inbox.acknowledge(response), /expiry/);
  assert.throws(() => f.inbox.create({ ...f.input, expiresAt: new Date(1800000000000 + 86400000).toISOString() }), /expiry/);
});

test('FR1/2: no delivery reassignment or scope change on one request', t => {
  const f = fixture(t);
  assert.throws(() => f.inbox.bind(f.request.requestId, { ...identity, recipientUserId: identity.userId, channelId: 'D123456789', messageTs: '1800000000.000002' }), /rebind/);
  f.inbox.cancel({ ...f.input, requestId: f.request.requestId });
  assert.throws(() => f.inbox.receive(f.body), /closed/);
});

test('FR4: raw Slack payload and response URLs never enter storage', t => {
  const f = fixture(t);
  f.body.response_url = 'https://sensitive.invalid/secret';
  f.body.message.text = 'private prompt secret';
  f.body.token = 'legacy-sensitive-value';
  f.inbox.receive(f.body);
  const stored = fs.readFileSync(path.join(f.root, 'inbox.json'), 'utf8');
  assert.doesNotMatch(stored, /sensitive|private prompt|response_url|legacy/);
});

test('FR4: corrupt state and leftover writer lock fail closed', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'inbox.lock'), 'old', { mode: 0o600 });
  assert.throws(() => f.inbox.receive(f.body), /busy/);
  fs.unlinkSync(path.join(f.root, 'inbox.lock'));
  fs.writeFileSync(path.join(f.root, 'inbox.json'), '{bad');
  assert.throws(() => f.inbox.receive(f.body), /corrupt/);
});

test('FR4: pre-bind early clicks remain retryable instead of permanently ACKed rejection', t => {
  const f = fixture(t);
  const early = f.inbox.create(f.input);
  f.body.actions[0].value = `${early.requestId}:${early.operationHash}`;
  assert.throws(() => f.inbox.receive(f.body), /delivery_binding_pending/);
});

test('Windows ACL: null DACL and broad grants rejected; private owner grant accepted', { skip: process.platform !== 'win32' }, () => {
  for (const [dacl, status] of [['D:NO_ACCESS_CONTROL', 4], ['D:(A;;FA;;;WD)', 3], ['D:(A;;FA;;;$sid)', 0]]) {
    const code = '$ErrorActionPreference="Stop"; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetSecurityDescriptorSddlForm("O:${sid}' + dacl + '"); ' + WINDOWS_PRIVATE_ACL_POLICY;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(result.status, status, result.stderr);
  }
});

test('FR5/7: CLI help is read-only and unconfigured status is explicit', async () => {
  assert.ok((await runInboxCommand(['--help'], '', { open() { throw new Error('must not open'); } })).commands.includes('pending'));
  assert.equal((await runInboxCommand(['status'], '', { open() { throw Object.assign(new Error(), { code: 'ENOENT' }); } })).state, 'not_configured');
});

test('FR5: hook only emits fixed hint on exact normal user turn, not Slack data or approval', () => {
  const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'task-a', prompt: 'sensitive' });
  const options = { loadBinding: () => ({ taskId: 'task-a', projectKey: 'project-a' }), open: () => ({ pending: () => [{ action: 'approve', operation: 'sensitive' }] }) };
  const output = pendingSlackHint(raw, options);
  assert.match(output.hookSpecificOutput.additionalContext, /not approval/);
  assert.doesNotMatch(JSON.stringify(output), /sensitive/);
  assert.equal(pendingSlackHint(raw, { ...options, loadBinding: () => null }), null);
  assert.equal(pendingSlackHint(JSON.stringify({ hook_event_name: 'Stop', session_id: 'task-a' }), options), null);
});
