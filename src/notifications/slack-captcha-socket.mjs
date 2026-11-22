import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { SLACK_CAPTCHA_IDS } from './slack-captcha-state.mjs';

const REJECT_AND_ACK = new Set([
  'untrusted_captcha_response',
  'unsupported_captcha_response',
  'invalid_captcha_binding',
  'captcha_request_expired',
  'captcha_request_closed',
  'captcha_delivery_binding_pending',
  'captcha_delivery_binding_mismatch',
  'captcha_response_binding_mismatch',
  'captcha_request_already_answered',
  'captcha_state_identity_or_binding_mismatch'
]);

function isCaptchaInteraction(body) {
  return body?.type === 'view_submission' && body.view?.callback_id === SLACK_CAPTCHA_IDS.CALLBACK_ID
    || body?.type === 'block_actions' && body.actions?.some(action => action?.action_id === SLACK_CAPTCHA_IDS.OPEN_ACTION_ID);
}

export function attachSlackCaptchaListener(client, state, { webClient, report = () => {} } = {}) {
  if (!webClient?.views?.open) throw new Error('slack_web_client_capability_required');
  const listener = async ({ body, ack }) => {
    if (!isCaptchaInteraction(body)) return;
    if (body.type === 'block_actions') {
      let modal;
      try { modal = state.modalForAction(body); }
      catch (error) {
        if (REJECT_AND_ACK.has(error.message)) {
          await ack().catch(() => {});
          report({ state: 'rejected', reason: error.message });
          return;
        }
        report({ state: 'storage_hold' });
        return;
      }
      try {
        await ack();
        await webClient.views.open({ trigger_id: modal.triggerId, view: modal.view });
        report({ state: 'modal_opened', requestId: modal.requestId });
      } catch {
        report({ state: 'modal_open_failed' });
      }
      return;
    }

    let result;
    try { result = state.receiveModal(body); }
    catch (error) {
      if (error.message === 'invalid_captcha_value') {
        await ack({ response_action: 'errors', errors: { [SLACK_CAPTCHA_IDS.INPUT_BLOCK_ID]: '영문과 숫자 한 줄만 입력해 주세요.' } }).catch(() => {});
        report({ state: 'invalid_value' });
        return;
      }
      if (REJECT_AND_ACK.has(error.message)) {
        await ack({ response_action: 'clear' }).catch(() => {});
        report({ state: 'rejected', reason: error.message });
        return;
      }
      // Storage must commit before ACK. Slack may retry; never report the payload or exception.
      report({ state: 'storage_hold' });
      return;
    }
    try { await ack(); } catch { report({ state: 'ack_uncertain' }); return; }
    report(result);
  };
  const safeListener = event => { listener(event).catch(() => report({ state: 'receive_hold' })); };
  const messageListener = async ({ body, ack }) => {
    let result;
    try { result = state.receiveThreadReply(body); }
    catch (error) {
      if (error.message === 'invalid_captcha_value') {
        await ack().catch(() => {});
        report({ state: 'invalid_value' });
        return;
      }
      if (REJECT_AND_ACK.has(error.message)) {
        await ack().catch(() => {});
        report({ state: 'rejected', reason: error.message });
        return;
      }
      // Storage must commit before ACK so Slack can retry a transient local failure.
      report({ state: 'storage_hold' });
      return;
    }
    try { await ack(); } catch { report({ state: 'ack_uncertain' }); return; }
    report(result);
  };
  const safeMessageListener = event => { messageListener(event).catch(() => report({ state: 'receive_hold' })); };
  const errorListener = () => report({ state: 'socket_error' });
  client.on('interactive', safeListener);
  client.on('message', safeMessageListener);
  client.on('error', errorListener);
  return () => {
    client.removeListener('interactive', safeListener);
    client.removeListener('message', safeMessageListener);
    client.removeListener('error', errorListener);
  };
}

export async function startSlackCaptchaSocket({ state, appTokenProvider, botTokenProvider, report = () => {},
  SocketClient = SocketModeClient, SlackWebClient = WebClient }) {
  const appToken = await appTokenProvider();
  if (typeof appToken !== 'string' || !/^xapp-[A-Za-z0-9-]{20,}$/.test(appToken)) throw new Error('socket_app_token_required');
  const botToken = await botTokenProvider();
  if (typeof botToken !== 'string' || !/^xoxb-[A-Za-z0-9-]{20,}$/.test(botToken)) throw new Error('slack_bot_token_required');
  const logger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel() { return 'error'; }, setName() {} };
  const client = new SocketClient({ appToken, logger });
  const webClient = new SlackWebClient(botToken, { logger });
  const detach = attachSlackCaptchaListener(client, state, { webClient, report });
  try { await client.start(); }
  catch {
    detach();
    await client.disconnect().catch(() => {});
    throw new Error('socket_start_failed');
  }
  return Object.freeze({
    webClient,
    stop: async () => { await client.disconnect(); detach(); }
  });
}
