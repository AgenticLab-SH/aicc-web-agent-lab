import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSlackCaptchaState, SLACK_CAPTCHA_IDS, MAX_CAPTCHA_LIFETIME_MS, assertPrivateCaptchaPath, captchaButtonBlocks } from '../src/notifications/slack-captcha-state.mjs';
import { resolveWindowsPwsh } from '../src/lib/windows-pwsh.mjs';

const identity = Object.freeze({ teamId: 'T123456789', appId: 'A123456789', userId: 'U123456789', botUserId: 'U987654321', botId: 'B123456789' });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-captcha-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let clock = 1_800_000_000_000;
  const state = createSlackCaptchaState({ root, identity, now: () => clock, checkDirectory: () => {} });
  const request = state.create({ projectKey: 'web', taskId: 'task-1', challengeRevision: 'challenge-2', siteLabel: 'NAVER',
    expiresAt: new Date(clock + 10 * 60_000).toISOString() });
  const delivery = { ...identity, recipientUserId: identity.userId, channelId: 'D123456789', messageTs: '1800000000.000001', fileId: 'F123456789' };
  state.bind(request.requestId, delivery);
  const actionBody = {
    type: 'block_actions', team: { id: identity.teamId }, api_app_id: identity.appId, user: { id: identity.userId },
    channel: { id: delivery.channelId }, trigger_id: '1234567890.abcdefgh',
    container: { type: 'message', channel_id: delivery.channelId, message_ts: delivery.messageTs },
    message: { user: identity.botUserId, bot_id: identity.botId, app_id: identity.appId, ts: delivery.messageTs },
    actions: [{ type: 'button', action_id: SLACK_CAPTCHA_IDS.OPEN_ACTION_ID, value: `${request.requestId}:${request.bindingHash}` }]
  };
  const modalBody = value => ({
    type: 'view_submission', team: { id: identity.teamId }, api_app_id: identity.appId, user: { id: identity.userId },
    view: { type: 'modal', callback_id: SLACK_CAPTCHA_IDS.CALLBACK_ID, private_metadata: `${request.requestId}:${request.bindingHash}`,
      state: { values: { [SLACK_CAPTCHA_IDS.INPUT_BLOCK_ID]: { [SLACK_CAPTCHA_IDS.INPUT_ACTION_ID]: { type: 'plain_text_input', value } } } } }
  });
  const threadBody = value => ({
    type: 'event_callback', team_id: identity.teamId, api_app_id: identity.appId,
    event: { type: 'message', channel_type: 'im', user: identity.userId, channel: delivery.channelId,
      thread_ts: delivery.messageTs, ts: '1800000000.000003', text: value }
  });
  return { root, state, request, delivery, actionBody, modalBody, threadBody, tick(ms) { clock += ms; } };
}

test('exact bound Slack message opens one single-line CAPTCHA modal', t => {
  const f = fixture(t);
  const modal = f.state.modalForAction(f.actionBody);
  assert.equal(modal.requestId, f.request.requestId);
  assert.equal(modal.view.callback_id, SLACK_CAPTCHA_IDS.CALLBACK_ID);
  const input = modal.view.blocks[0].element;
  assert.equal(input.type, 'plain_text_input');
  assert.equal(input.multiline, false);
  assert.equal(input.action_id, SLACK_CAPTCHA_IDS.INPUT_ACTION_ID);
  const blocks = captchaButtonBlocks(f.request);
  assert.match(blocks[0].text.text, /^5 긴급 \| /);
  assert.match(blocks[0].text.text, / KST까지/);
  assert.match(blocks[0].text.text, /한 번 입력하고 확인하는 데 동의/);
  assert.doesNotMatch(blocks[0].text.text, /T\d{2}:\d{2}:\d{2}|Z까지/);
  assert.equal(blocks[1].elements[0].value, `${f.request.requestId}:${f.request.bindingHash}`);
});

test('CAPTCHA requests allow one hour but reject a longer stale window', t => {
  const f = fixture(t);
  const createdAt = 1_800_000_000_000;
  const longest = f.state.create({ projectKey: 'web', taskId: 'task-1', challengeRevision: 'challenge-hour', siteLabel: 'NAVER',
    expiresAt: new Date(createdAt + MAX_CAPTCHA_LIFETIME_MS).toISOString() });
  assert.equal(Date.parse(longest.expiresAt) - createdAt, 60 * 60_000);
  assert.throws(() => f.state.create({ projectKey: 'web', taskId: 'task-1', challengeRevision: 'challenge-too-long', siteLabel: 'NAVER',
    expiresAt: new Date(createdAt + MAX_CAPTCHA_LIFETIME_MS + 1).toISOString() }), /invalid_captcha_expiry/);
});

test('the exact bot-authored native attachment edit remains bound', t => {
  const f = fixture(t);
  f.actionBody.message.edited = { user: identity.botUserId, ts: '1800000000.000002' };
  assert.equal(f.state.modalForAction(f.actionBody).requestId, f.request.requestId);
});

for (const [name, mutate] of Object.entries({
  workspace: body => { body.team.id = 'T000000000'; },
  app: body => { body.api_app_id = 'A000000000'; },
  user: body => { body.user.id = 'U000000000'; },
  channel: body => { body.container.channel_id = 'D000000000'; },
  message: body => { body.message.ts = '1800000000.000002'; },
  bot: body => { body.message.bot_id = 'B000000000'; },
  editor: body => { body.message.edited = { user: 'U000000000', ts: '1800000000.000002' }; },
  request: body => { body.actions[0].value = `00000000-0000-4000-8000-000000000000:${'a'.repeat(64)}`; },
  binding: body => {
    const last = body.actions[0].value.at(-1);
    body.actions[0].value = `${body.actions[0].value.slice(0, -1)}${last === '0' ? '1' : '0'}`;
  }
})) test(`rejects cross-bound ${name} action`, t => {
  const f = fixture(t);
  mutate(f.actionBody);
  assert.throws(() => f.state.modalForAction(f.actionBody));
});

test('first valid alphanumeric line is stored only until the exact task consumes it', async t => {
  const f = fixture(t);
  assert.throws(() => f.state.receiveModal(f.modalBody('abc 123')), /invalid_captcha_value/);
  assert.throws(() => f.state.receiveModal(f.modalBody('abc\n123')), /invalid_captcha_value/);
  assert.deepEqual(f.state.receiveModal(f.modalBody('  AbC123  ')), { ok: true, state: 'answer_ready', requestId: f.request.requestId });
  assert.throws(() => f.state.receiveModal(f.modalBody('ZZZ999')), /already_answered/);
  assert.equal(f.state.inspect(f.request.requestId).state, 'answer_ready');
  assert.doesNotMatch(JSON.stringify(f.state.inspect(f.request.requestId)), /AbC123/);

  let consumed = null;
  let deletedFile = null;
  const result = await f.state.consume(f.request, async value => { consumed = value; }, {
    deleteSlackFile: async fileId => { deletedFile = fileId; }
  });
  assert.equal(consumed, 'AbC123');
  assert.equal(deletedFile, f.delivery.fileId);
  assert.deepEqual(result, { ok: true, state: 'consumed_and_purged', slackFileDeleted: true });
  assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.captcha.json')), false);
  await assert.rejects(f.state.consume(f.request, async () => {}));
});

test('first exact owner reply in the bound message thread becomes the one-use answer', async t => {
  const f = fixture(t);
  assert.deepEqual(f.state.receiveThreadReply(f.threadBody('  XyZ789  ')), {
    ok: true, state: 'answer_ready', requestId: f.request.requestId
  });
  assert.equal(f.state.inspect(f.request.requestId).state, 'answer_ready');
  assert.doesNotMatch(JSON.stringify(f.state.inspect(f.request.requestId)), /XyZ789/);
  assert.throws(() => f.state.receiveThreadReply(f.threadBody('Again1')), /already_answered/);
  let consumed = null;
  await f.state.consume(f.request, async value => { consumed = value; });
  assert.equal(consumed, 'XyZ789');
});

for (const [name, mutate, error] of [
  ['unthreaded DM', body => { delete body.event.thread_ts; }, /unsupported/],
  ['wrong owner', body => { body.event.user = 'U000000000'; }, /unsupported/],
  ['wrong channel', body => { body.event.channel = 'D000000000'; }, /delivery_binding/],
  ['wrong parent', body => { body.event.thread_ts = '1800000000.000099'; }, /delivery_binding/],
  ['bot reply', body => { body.event.bot_id = 'B000000000'; }, /unsupported/],
  ['edited reply', body => { body.event.subtype = 'message_changed'; }, /unsupported/],
  ['prose', body => { body.event.text = 'code is Ab12'; }, /invalid_captcha_value/],
  ['multiline', body => { body.event.text = 'Ab12\nCd34'; }, /invalid_captcha_value/]
]) test(`thread reply rejects ${name}`, t => {
  const f = fixture(t);
  const body = f.threadBody('Ab12');
  mutate(body);
  assert.throws(() => f.state.receiveThreadReply(body), error);
  assert.equal(f.state.inspect(f.request.requestId).state, 'delivered');
});

test('wrong task, challenge revision, expiry and replay fail closed', async t => {
  const f = fixture(t);
  f.state.receiveModal(f.modalBody('A1b2'));
  await assert.rejects(f.state.consume({ ...f.request, taskId: 'task-2' }, async () => {}), /binding/);
  f.tick(10 * 60_000 + 1);
  await assert.rejects(f.state.consume(f.request, async () => {}), /expired/);
});

test('expiry purges protected answer state and attempts Slack image deletion', async t => {
  const f = fixture(t);
  f.state.receiveModal(f.modalBody('A1b2'));
  f.tick(10 * 60_000 + 1);
  const deleted = [];
  const result = await f.state.purgeExpired({ deleteSlackFile: async fileId => { deleted.push(fileId); } });
  assert.deepEqual(result, { ok: true, state: 'expired_purged', purged: 1, slackFilesDeleted: 1, held: 0 });
  assert.deepEqual(deleted, [f.delivery.fileId]);
  assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.captcha.json')), false);
});

test('consumer failure still purges the one-use answer and never exposes it in the error', async t => {
  const f = fixture(t);
  f.state.receiveModal(f.modalBody('Secret7'));
  await assert.rejects(f.state.consume(f.request, async () => { throw new Error('Secret7'); }), error => {
    assert.equal(error.message, 'captcha_value_consumer_failed');
    assert.doesNotMatch(JSON.stringify(error), /Secret7/);
    return true;
  });
  assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.captcha.json')), false);
});

test('protected state metadata never contains a crop path or Slack event body', t => {
  const f = fixture(t);
  const file = path.join(f.root, fs.readdirSync(f.root).find(name => name.endsWith('.captcha.json')));
  const stored = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(stored, /cropPath|response_url|trigger_id|private prompt/);
  assert.doesNotMatch(JSON.stringify(f.state.status()), /NAVER|task-1|challenge-2/);
});

test('one Slack message cannot be rebound to a second CAPTCHA request', t => {
  const f = fixture(t);
  const second = f.state.create({ projectKey: 'web', taskId: 'task-1', challengeRevision: 'challenge-3', siteLabel: 'NAVER',
    expiresAt: new Date(1_800_000_000_000 + 10 * 60_000).toISOString() });
  assert.throws(() => f.state.bind(second.requestId, f.delivery), /already_bound/);
});

test('exact callback binding makes live auto-wake visible without exposing callback metadata', t => {
  const f = fixture(t);
  assert.equal(f.state.status().liveAutoWake, false);
  f.state.bindWake(f.request.requestId, {
    callbackId: '87654321-4321-4321-8321-cba987654321',
    operationId: `slack-captcha:${f.request.requestId}`
  });
  assert.equal(f.state.status().liveAutoWake, true);
  assert.equal(f.state.inspect(f.request.requestId).liveAutoWake, true);
  assert.deepEqual(f.state.pendingWakes(), []);
  f.state.receiveModal(f.modalBody('A1b2'));
  const pending = f.state.pendingWakes();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].callbackId, '87654321-4321-4321-8321-cba987654321');
  assert.doesNotMatch(JSON.stringify(f.state.inspect(f.request.requestId)), /87654321|slack-captcha/);
});

test('Windows initializer creates an ACL-protected owner-only state directory', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-captcha-acl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'platform', 'slack', 'Initialize-WindowsSlackCaptchaState.ps1');
  const result = spawnSync(resolveWindowsPwsh(), ['-NoProfile', '-NonInteractive', '-File', script, '-StateRoot', root], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000
  });
  assert.equal(result.status, 0, result.stderr);
  const target = path.join(root, 'notifications', 'slack-captcha');
  assertPrivateCaptchaPath(target);
  assert.equal(JSON.parse(result.stdout).state, 'ready');
});
