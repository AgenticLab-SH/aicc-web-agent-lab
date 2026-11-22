import { SocketModeClient } from '@slack/socket-mode';

// A signed-in app connector is deliberately not a token provider for this worker.
// No inbound HTTP route or public listener; only the official authenticated SDK.
const REJECTIONS = new Set(['untrusted_slack_response', 'unsupported_response', 'invalid_response_binding',
  'stale_response', 'request_not_found', 'response_binding_mismatch', 'request_closed',
  'approval_not_requested', 'request_already_answered']);

export function attachSlackResponseListener(client, inbox, report = () => {}) {
  const listener = async ({ body, ack }) => {
    let result;
    try { result = inbox.receive(body); }
    catch (error) {
      if (REJECTIONS.has(error.message)) {
        await ack();
        report({ state: 'rejected', reason: error.message });
        return;
      }
      // No successful receipt before durable commit. Slack can retry; never log body/error objects.
      report({ state: 'storage_hold' });
      return;
    }
    try { await ack(); } catch { report({ state: 'ack_uncertain' }); return; }
    report(result);
  };
  const safeListener = event => { listener(event).catch(() => report({ state: 'receive_hold' })); };
  const errorListener = () => report({ state: 'socket_error' });
  client.on('interactive', safeListener);
  client.on('error', errorListener);
  return () => { client.removeListener('interactive', safeListener); client.removeListener('error', errorListener); };
}

export async function startSlackResponseSocket({ inbox, tokenProvider, report = () => {}, Client = SocketModeClient }) {
  const token = await tokenProvider();
  if (typeof token !== 'string' || !/^xapp-[A-Za-z0-9-]{20,}$/.test(token)) throw new Error('socket_app_token_required');
  // SDK debug logs may include payloads and connection URLs. Never enable them here.
  const logger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel() { return 'error'; }, setName() {} };
  const client = new Client({ appToken: token, logger });
  const detach = attachSlackResponseListener(client, inbox, report);
  try { await client.start(); }
  catch { detach(); await client.disconnect().catch(() => {}); throw new Error('socket_start_failed'); }
  return { stop: async () => { await client.disconnect(); detach(); } };
}
