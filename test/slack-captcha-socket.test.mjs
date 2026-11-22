import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachSlackCaptchaListener, startSlackCaptchaSocket } from '../src/notifications/slack-captcha-socket.mjs';
import { SLACK_CAPTCHA_IDS } from '../src/notifications/slack-captcha-state.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const actionBody = () => ({ type: 'block_actions', actions: [{ action_id: SLACK_CAPTCHA_IDS.OPEN_ACTION_ID }] });
const modalBody = () => ({ type: 'view_submission', view: { callback_id: SLACK_CAPTCHA_IDS.CALLBACK_ID } });

test('bound CAPTCHA button ACKs and opens a plain-text modal without reporting payload data', async () => {
  const client = new EventEmitter();
  const sequence = [];
  const reports = [];
  const state = { modalForAction: () => ({ requestId: 'request-safe', triggerId: 'trigger-secret', view: {
    type: 'modal', callback_id: SLACK_CAPTCHA_IDS.CALLBACK_ID,
    blocks: [{ block_id: SLACK_CAPTCHA_IDS.INPUT_BLOCK_ID, element: { type: 'plain_text_input', multiline: false } }]
  } }) };
  const webClient = { views: { open: async value => { sequence.push(['open', value]); } } };
  attachSlackCaptchaListener(client, state, { webClient, report: value => reports.push(value) });
  client.emit('interactive', { body: actionBody(), ack: async () => { sequence.push(['ack']); } });
  await flush();
  assert.equal(sequence[0][0], 'ack');
  assert.equal(sequence[1][0], 'open');
  assert.equal(sequence[1][1].view.blocks[0].element.type, 'plain_text_input');
  assert.deepEqual(reports, [{ state: 'modal_opened', requestId: 'request-safe' }]);
  assert.doesNotMatch(JSON.stringify(reports), /trigger-secret/);
});

test('valid modal response commits before ACK; storage failure remains unacknowledged', async () => {
  for (const failure of [null, 'captcha_state_busy']) {
    const client = new EventEmitter();
    const sequence = [];
    attachSlackCaptchaListener(client, { receiveModal() {
      sequence.push('persist');
      if (failure) throw new Error(failure);
      return { ok: true, state: 'answer_ready', requestId: 'safe-request' };
    } }, { webClient: { views: { open() {} } }, report: value => sequence.push(value.state) });
    client.emit('interactive', { body: modalBody(), ack: async () => { sequence.push('ack'); } });
    await flush();
    assert.equal(sequence[0], 'persist');
    assert.equal(sequence.includes('ack'), failure === null);
    assert.equal(sequence.includes('storage_hold'), failure !== null);
  }
});

test('invalid CAPTCHA value keeps the modal open with a fixed field error and no raw echo', async () => {
  const client = new EventEmitter();
  const acknowledgements = [];
  const reports = [];
  attachSlackCaptchaListener(client, { receiveModal() { throw new Error('invalid_captcha_value'); } }, {
    webClient: { views: { open() {} } }, report: value => reports.push(value)
  });
  client.emit('interactive', { body: { ...modalBody(), private: 'raw value should not echo' }, ack: async value => acknowledgements.push(value) });
  await flush();
  assert.equal(acknowledgements[0].response_action, 'errors');
  assert.match(acknowledgements[0].errors[SLACK_CAPTCHA_IDS.INPUT_BLOCK_ID], /영문과 숫자/);
  assert.doesNotMatch(JSON.stringify({ acknowledgements, reports }), /raw value/);
});

test('unrelated interactive events are ignored for coexistence with the normal response listener', async () => {
  const client = new EventEmitter();
  let acknowledged = false;
  attachSlackCaptchaListener(client, {}, { webClient: { views: { open() {} } } });
  client.emit('interactive', { body: { type: 'block_actions', actions: [{ action_id: 'aicc_response_done' }] }, ack: async () => { acknowledged = true; } });
  await flush();
  assert.equal(acknowledged, false);
});

test('exact thread reply persists before ACK and never reports the CAPTCHA value', async () => {
  const client = new EventEmitter();
  const sequence = [];
  const reports = [];
  attachSlackCaptchaListener(client, { receiveThreadReply() {
    sequence.push('persist');
    return { ok: true, state: 'answer_ready', requestId: 'safe-request' };
  } }, { webClient: { views: { open() {} } }, report: value => reports.push(value) });
  client.emit('message', { body: { event: { text: 'NeverEcho7' } }, ack: async () => { sequence.push('ack'); } });
  await flush();
  assert.deepEqual(sequence, ['persist', 'ack']);
  assert.deepEqual(reports, [{ ok: true, state: 'answer_ready', requestId: 'safe-request' }]);
  assert.doesNotMatch(JSON.stringify(reports), /NeverEcho7/);
});

test('unbound message events ACK and reject while storage failure remains unacknowledged', async () => {
  for (const failure of ['captcha_delivery_binding_mismatch', 'captcha_state_busy']) {
    const client = new EventEmitter();
    const sequence = [];
    attachSlackCaptchaListener(client, { receiveThreadReply() { throw new Error(failure); } }, {
      webClient: { views: { open() {} } }, report: value => sequence.push(value.state)
    });
    client.emit('message', { body: {}, ack: async () => { sequence.push('ack'); } });
    await flush();
    assert.equal(sequence.includes('ack'), failure === 'captcha_delivery_binding_mismatch');
    assert.equal(sequence.includes('storage_hold'), failure === 'captcha_state_busy');
  }
});

test('Socket Mode uses app token only for the connection and bot token only for Web API', async () => {
  let socketInstance;
  let webInstance;
  class FakeSocket extends EventEmitter {
    constructor(options) { super(); socketInstance = this; this.options = options; }
    async start() { this.started = true; }
    async disconnect() { this.stopped = true; }
  }
  class FakeWebClient {
    constructor(token, options) {
      webInstance = this;
      this.token = token;
      this.options = options;
      this.views = { open() {} };
    }
  }
  const worker = await startSlackCaptchaSocket({
    state: {},
    appTokenProvider: async () => 'xapp-demo-fixture-value-1',
    botTokenProvider: async () => 'xoxb-demo-fixture-value-2',
    SocketClient: FakeSocket,
    SlackWebClient: FakeWebClient
  });
  assert.equal(socketInstance.options.appToken, 'xapp-demo-fixture-value-1');
  assert.equal(Object.hasOwn(socketInstance.options, 'token'), false);
  assert.equal(webInstance.token, 'xoxb-demo-fixture-value-2');
  await worker.stop();
  assert.equal(socketInstance.stopped, true);
  assert.equal(socketInstance.listenerCount('interactive'), 0);
  assert.equal(socketInstance.listenerCount('message'), 0);
});
