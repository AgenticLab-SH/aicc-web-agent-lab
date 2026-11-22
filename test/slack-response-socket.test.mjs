import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachSlackResponseListener, startSlackResponseSocket } from '../src/notifications/slack-response-socket.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('FR4: commit happens before ACK; known rejection ACKs but storage failure does not', async () => {
  for (const error of [null, 'untrusted_slack_response', 'inbox_busy', 'disk_full', 'delivery_binding_pending']) {
    const client = new EventEmitter(); const sequence = [];
    const detach = attachSlackResponseListener(client, { receive() {
      sequence.push('persist'); if (error) throw new Error(error); return { state: 'queued_transport_unavailable' };
    } }, value => sequence.push(value.state));
    client.emit('interactive', { body: {}, ack: async () => sequence.push('ack') });
    await flush();
    assert.equal(sequence.includes('ack'), !error || error === 'untrusted_slack_response');
    assert.equal(sequence[0], 'persist');
    detach(); assert.equal(client.listenerCount('interactive'), 0);
  }
});

test('FR4: ACK failure keeps durable response; emits no raw error/payload', async () => {
  const client = new EventEmitter(); const reports = [];
  attachSlackResponseListener(client, { receive: () => ({ state: 'queued_transport_unavailable' }) }, r => reports.push(r));
  client.emit('interactive', { body: { token: 'secret' }, ack: async () => { throw new Error('secret'); } });
  await flush(); assert.deepEqual(reports, [{ state: 'ack_uncertain' }]);
});

test('FR7: socket startup and rollback use official client lifecycle without public listener', async () => {
  let instance;
  class FakeClient extends EventEmitter {
    constructor(options) { super(); instance = this; this.options = options; }
    async start() { this.started = true; }
    async disconnect() { this.stopped = true; }
  }
  const worker = await startSlackResponseSocket({ inbox: {}, tokenProvider: async () => 'xapp-demo-fixture-value-1', Client: FakeClient });
  assert.equal(instance.started, true);
  assert.equal(instance.options.logger.getLevel(), 'error');
  await worker.stop(); assert.equal(instance.stopped, true);
  assert.equal(instance.listenerCount('interactive'), 0);
  await assert.rejects(startSlackResponseSocket({ inbox: {}, tokenProvider: async () => 'not-an-app-token', Client: FakeClient }), /socket_app_token_required/);
});
