import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SlackBotTransportError,
  createSlackBotTransport,
  inspectSlackBotIdentity,
  readSlackBotToken,
  storeSlackBotToken,
  storeSlackBotTokenInKeychain,
  validateSlackBotConfig
} from '../src/slack-bot-transport.mjs';

const config = Object.freeze({
  schemaVersion: 1,
  transport: 'aicc_slack_bot',
  teamId: 'T0BQBP8D90D',
  recipientUserId: 'U0BQ96LHEAF',
  appId: 'A0BQALERT001',
  botUserId: 'U0BQALERT001',
  botId: 'B0BQALERT001',
  keychainService: 'aicc-slack-alerts',
  keychainAccount: 'T0BQBP8D90D'
});
const token = 'xoxb-demo-fixture-value-1';

function response(body, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] ?? null }, json: async () => body };
}

test('configuration binds an exact team, recipient, app and bot identity', () => {
  assert.deepEqual(validateSlackBotConfig(config), config);
  assert.throws(() => validateSlackBotConfig({ ...config, teamId: 'unknown' }), /invalid_team_id/);
  assert.throws(() => validateSlackBotConfig({ ...config, botUserId: config.recipientUserId }), /sender_must_be_distinct/);
});

test('Keychain storage passes the token only over stdin, never argv or result', async () => {
  let observed;
  const result = await storeSlackBotTokenInKeychain(config, token, {
    platform: 'darwin',
    runSecretCommand: async (executable, args, options) => {
      observed = { executable, args, input: options.input };
      return { ok: true, stdout: '', stderr: '', exitCode: 0 };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(observed.executable, '/usr/bin/swift');
  assert.match(observed.args[0], /store-bot-token\.swift$/);
  assert.deepEqual(observed.args.slice(1), [config.keychainService, config.keychainAccount]);
  assert.equal(observed.args.includes(token), false);
  assert.equal(observed.input, `${token}\n`);
  assert.doesNotMatch(JSON.stringify(result), /xoxb-/);
});

test('Windows Credential Manager transport keeps the token on stdin and out of argv and results', async () => {
  const calls = [];
  const runner = async (executable, args, options) => {
    calls.push({ executable, args, input: options.input });
    if (args.includes('Read')) return { ok: true, stdout: token, stderr: '', exitCode: 0 };
    return { ok: true, stdout: '{"ok":true}', stderr: '', exitCode: 0 };
  };
  const stored = await storeSlackBotToken(config, token, { platform: 'win32', pwshExecutable: 'pwsh', runSecretCommand: runner });
  const read = await readSlackBotToken(config, { platform: 'win32', pwshExecutable: 'pwsh', runSecretCommand: runner });
  assert.equal(stored.backend, 'windows_credential_manager');
  assert.equal(read, token);
  assert.equal(calls[0].executable, 'pwsh');
  assert.match(calls[0].args.join(' '), /Invoke-WindowsSlackSecretStore\.ps1.*Store/);
  assert.equal(calls[0].args.includes(token), false);
  assert.equal(calls[0].input, `${token}\n`);
  assert.match(calls[1].args.join(' '), /Invoke-WindowsSlackSecretStore\.ps1.*Read/);
  assert.equal(calls[1].input, undefined);
  assert.doesNotMatch(JSON.stringify(stored), /xoxb-/);
});

test('identity inspection fails closed on a different Slack workspace', async () => {
  await assert.rejects(() => inspectSlackBotIdentity(config, config.teamId, {
    tokenProvider: async () => token,
    fetchImpl: async () => response({ ok: true, team_id: 'TOTHER00001', user_id: config.botUserId, bot_id: config.botId })
  }), error => error instanceof SlackBotTransportError && error.code === 'slack_team_identity_mismatch');
});

test('bot sends once, records no body or token, and deduplicates an exact event', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-slack-transport-'));
  const calls = [];
  const transport = createSlackBotTransport({
    config,
    deliveryStateRoot: root,
    tokenProvider: async () => token,
    now: () => new Date('2026-08-15T14:00:00.000Z'),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/auth.test')) return response({ ok: true, team_id: config.teamId, user_id: config.botUserId, bot_id: config.botId });
      return response({
        ok: true,
        channel: 'D0BQALERT001',
        ts: '1786802400.000001',
        message: { user: config.botUserId, bot_id: config.botId, app_id: config.appId, text: 'secret body should not persist' }
      });
    }
  });
  const first = await transport.send({ eventId: 'ai-platform:mobile-alert:test-1', message: '모바일 알림 테스트' });
  const second = await transport.send({ eventId: 'ai-platform:mobile-alert:test-1', message: '모바일 알림 테스트' });
  assert.equal(first.state, 'sent');
  assert.equal(second.state, 'duplicate');
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /chat\.postMessage$/);
  assert.equal(JSON.parse(calls[1].init.body).channel, config.recipientUserId);
  assert.match(JSON.parse(calls[1].init.body).client_msg_id, /^[0-9a-f-]{36}$/);
  assert.equal(calls[1].init.headers.authorization, `Bearer ${token}`);
  const record = fs.readFileSync(path.join(root, fs.readdirSync(root).find(name => name.endsWith('.json'))), 'utf8');
  assert.doesNotMatch(record, /모바일 알림|다른 본문|secret body|xoxb-/);
  assert.doesNotMatch(JSON.stringify(first), /모바일 알림|xoxb-/);
  const recordFile = path.join(root, fs.readdirSync(root).find(name => name.endsWith('.json')));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(recordFile).mode & 0o777, 0o600);
  }
});

test('the same event ID with a different message fails as an idempotency conflict', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-slack-conflict-'));
  const transport = createSlackBotTransport({
    config,
    deliveryStateRoot: root,
    tokenProvider: async () => token,
    fetchImpl: async url => url.endsWith('/auth.test')
      ? response({ ok: true, team_id: config.teamId, user_id: config.botUserId, bot_id: config.botId })
      : response({
        ok: true,
        channel: 'D0BQALERT001',
        ts: '1786802400.000003',
        message: { user: config.botUserId, bot_id: config.botId, app_id: config.appId }
      })
  });
  await transport.send({ eventId: 'ai-platform:mobile-alert:conflict', message: '첫 번째 알림' });
  await assert.rejects(
    () => transport.send({ eventId: 'ai-platform:mobile-alert:conflict', message: '두 번째 알림' }),
    error => error instanceof SlackBotTransportError && error.code === 'slack_delivery_idempotency_conflict'
  );
});

test('an abandoned old delivery lock is recovered without removing a live owner lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-slack-stale-lock-'));
  const eventId = 'ai-platform:mobile-alert:stale-lock';
  const digest = crypto.createHash('sha256').update(eventId).digest('hex');
  const lock = path.join(root, `${digest}.lock`);
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 999999, acquiredAt: '2026-08-15T00:00:00.000Z' }), { mode: 0o600 });
  fs.utimesSync(lock, new Date('2026-08-15T00:00:00.000Z'), new Date('2026-08-15T00:00:00.000Z'));
  const transport = createSlackBotTransport({
    config,
    deliveryStateRoot: root,
    nowMs: Date.parse('2026-08-15T01:00:00.000Z'),
    processIsAlive: () => false,
    tokenProvider: async () => token,
    fetchImpl: async url => url.endsWith('/auth.test')
      ? response({ ok: true, team_id: config.teamId, user_id: config.botUserId, bot_id: config.botId })
      : response({
        ok: true,
        channel: 'D0BQALERT001',
        ts: '1786802400.000004',
        message: { user: config.botUserId, bot_id: config.botId, app_id: config.appId }
      })
  });
  assert.equal((await transport.send({ eventId, message: '중단된 잠금 복구' })).state, 'sent');
});

test('429 is reported once with a bounded retry hint and no delivery record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-slack-rate-limit-'));
  let calls = 0;
  const transport = createSlackBotTransport({
    config,
    deliveryStateRoot: root,
    tokenProvider: async () => token,
    fetchImpl: async url => {
      calls += 1;
      if (url.endsWith('/auth.test')) return response({ ok: true, team_id: config.teamId, user_id: config.botUserId, bot_id: config.botId });
      return response({ ok: false, error: 'ratelimited', secret: token }, 429, { 'retry-after': '31' });
    }
  });
  await assert.rejects(() => transport.send({ eventId: 'ai-platform:mobile-alert:rate-limit', message: 'test' }), error => {
    assert.equal(error.code, 'slack_rate_limited');
    assert.deepEqual(error.details, { retryAfterSeconds: 31 });
    assert.doesNotMatch(JSON.stringify(error), /xoxb-/);
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(fs.readdirSync(root).filter(name => name.endsWith('.json')).length, 0);
});

test('unexpected app or bot response fails without recording success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-slack-identity-'));
  const transport = createSlackBotTransport({
    config,
    deliveryStateRoot: root,
    tokenProvider: async () => token,
    fetchImpl: async url => url.endsWith('/auth.test')
      ? response({ ok: true, team_id: config.teamId, user_id: config.botUserId, bot_id: config.botId })
      : response({ ok: true, channel: 'D0BQALERT001', ts: '1786802400.000002', message: { user: config.botUserId, bot_id: config.botId, app_id: 'A0BQWRONG001' } })
  });
  await assert.rejects(() => transport.send({ eventId: 'ai-platform:mobile-alert:wrong-app', message: 'test' }), /slack_delivery_identity_mismatch/);
  assert.equal(fs.readdirSync(root).filter(name => name.endsWith('.json')).length, 0);
});

test('one native credential read binds auth verification and post; no cache across sends', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-slack-single-read-'));
  let reads=0;
  const transport=createSlackBotTransport({config,deliveryStateRoot:root,
    tokenProvider:async()=>{reads++; if(reads===2)throw new SlackBotTransportError('slack_bot_token_unavailable');return token;},
    fetchImpl:async url=>url.endsWith('/auth.test')
      ?response({ok:true,team_id:config.teamId,user_id:config.botUserId,bot_id:config.botId})
      :response({ok:true,channel:'D0BQALERT001',ts:'1786802400.000006',message:{user:config.botUserId,bot_id:config.botId,app_id:config.appId}})
  });
  assert.equal((await transport.send({eventId:'single-read:first',message:'검증과 발송'})).state,'sent');
  assert.equal(reads,1);
  await assert.rejects(()=>transport.send({eventId:'single-read:second',message:'두 번째 발송'}),/slack_bot_token_unavailable/);
  assert.equal(reads,2);
});