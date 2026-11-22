import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverSlackCaptcha } from '../src/notifications/slack-captcha-delivery.mjs';

const config = Object.freeze({ teamId: 'T123456789', recipientUserId: 'U123456789', appId: 'A123456789', botUserId: 'U987654321', botId: 'B123456789' });
const request = Object.freeze({ requestId: '12345678-1234-4234-8234-123456789abc', bindingHash: 'a'.repeat(64), siteLabel: 'NAVER', expiresAt: '2027-01-15T00:00:00.000Z' });

function png(width = 180, height = 60) {
  const value = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(value);
  value.writeUInt32BE(13, 8);
  value.write('IHDR', 12, 4, 'ascii');
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

function cropFixture(t, data = png()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-captcha-crop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'fresh-captcha.png');
  fs.writeFileSync(file, data);
  return file;
}

test('attaches one unshared minimal crop natively to the exact bound button DM', async t => {
  const cropPath = cropFixture(t);
  const calls = [];
  let binding;
  const webClient = {
    auth: { test: async () => ({ ok: true, team_id: config.teamId, user_id: config.botUserId, bot_id: config.botId }) },
    filesUploadV2: async payload => { calls.push(['upload', payload]); return { ok: true, files: [{ id: 'F123456789' }] }; },
    files: { delete: async payload => { calls.push(['delete', payload]); return { ok: true }; } },
    chat: {
      delete: async payload => { calls.push(['delete-message', payload]); return { ok: true }; },
      postMessage: async payload => { calls.push(['message', payload]); return { ok: true, channel: 'D123456789', ts: '1800000000.000001',
        message: { user: config.botUserId, bot_id: config.botId, app_id: config.appId } }; },
      update: async payload => { calls.push(['update', payload]); return { ok: true, channel: 'D123456789', ts: '1800000000.000001' }; }
    }
  };
  const result = await deliverSlackCaptcha({
    state: { bind: (requestId, delivery) => { binding = { requestId, delivery }; } }, request, cropPath, webClient, config
  });
  assert.equal(result.state, 'delivered');
  assert.equal(fs.existsSync(cropPath), false);
  assert.equal(calls[0][0], 'upload');
  assert.ok(Buffer.isBuffer(calls[0][1].file));
  assert.equal(calls[0][1].channel_id, undefined);
  assert.equal(calls[0][1].initial_comment, undefined);
  assert.equal(calls.filter(([kind]) => kind === 'upload').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'message').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'update').length, 1);
  assert.equal(calls[1][1].blocks[0].text.text.startsWith('5 긴급 | NAVER'), true);
  assert.match(calls[1][1].text, / KST까지$/);
  assert.deepEqual(calls[2][1].file_ids, ['F123456789']);
  assert.equal(calls[2][1].blocks[1].elements[0].action_id, 'aicc_captcha_open');
  assert.equal(binding.delivery.recipientUserId, config.recipientUserId);
  assert.equal(binding.delivery.fileId, 'F123456789');
  assert.doesNotMatch(JSON.stringify(result), /fresh-captcha|PNG|captcha\.png/);
});

test('accepts the nested completion response returned by the official filesUploadV2 SDK', async t => {
  const cropPath = cropFixture(t);
  const webClient = {
    auth: { test: async () => ({ ok: true, team_id: config.teamId, user_id: config.botUserId, bot_id: config.botId }) },
    filesUploadV2: async () => ({ ok: true, files: [{ ok: true, files: [{ id: 'F123456789' }] }] }),
    files: { delete: async () => ({ ok: true }) },
    chat: {
      postMessage: async () => ({ ok: true, channel: 'D123456789', ts: '1800000000.000001',
        message: { user: config.botUserId, bot_id: config.botId, app_id: config.appId } }),
      update: async () => ({ ok: true, channel: 'D123456789', ts: '1800000000.000001' }),
      delete: async () => ({ ok: true })
    }
  };
  const result = await deliverSlackCaptcha({ state: { bind() {} }, request, cropPath, webClient, config });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(cropPath), false);
});

test('upload failure sends no text-only fallback DM and removes the local crop', async t => {
  const cropPath = cropFixture(t);
  let messageCalls = 0;
  const webClient = {
    auth: { test: async () => ({ ok: true, team_id: config.teamId, user_id: config.botUserId, bot_id: config.botId }) },
    filesUploadV2: async () => { throw new Error('upload unavailable'); },
    files: { delete: async () => ({ ok: true }) },
    chat: { delete: async () => ({ ok: true }), postMessage: async () => { messageCalls += 1; }, update: async () => ({ ok: true }) }
  };
  await assert.rejects(deliverSlackCaptcha({ state: { bind() {} }, request, cropPath, webClient, config }), /upload unavailable/);
  assert.equal(messageCalls, 0);
  assert.equal(fs.existsSync(cropPath), false);
});

test('failed native attachment removes the local crop, posted message, and uploaded file', async t => {
  const cropPath = cropFixture(t);
  const deleted = [];
  const webClient = {
    auth: { test: async () => ({ ok: true, team_id: config.teamId, user_id: config.botUserId, bot_id: config.botId }) },
    filesUploadV2: async () => ({ ok: true, files: [{ id: 'F123456789' }] }),
    files: { delete: async payload => { deleted.push(payload.file); return { ok: true }; } },
    chat: {
      postMessage: async () => ({ ok: true, channel: 'D123456789', ts: '1800000000.000001',
        message: { user: config.botUserId, bot_id: config.botId, app_id: config.appId } }),
      update: async () => { throw new Error('native attachment failure'); },
      delete: async () => ({ ok: true })
    }
  };
  await assert.rejects(deliverSlackCaptcha({ state: { bind() {} }, request, cropPath, webClient, config }), /native attachment failure/);
  assert.equal(fs.existsSync(cropPath), false);
  assert.deepEqual(deleted, ['F123456789']);
});

test('rejects non-PNG or oversized crops without deleting an unrelated file', async t => {
  const cropPath = cropFixture(t, Buffer.from('not an image'));
  const webClient = { auth: { test() {} }, filesUploadV2() {}, files: { delete() {} }, chat: { postMessage() {}, update() {}, delete() {} } };
  await assert.rejects(deliverSlackCaptcha({ state: { bind() {} }, request, cropPath, webClient, config }), /invalid_captcha_crop|png_required/);
  assert.equal(fs.existsSync(cropPath), true);
});

test('failed local binding deletes the posted message, uploaded file, and local crop', async t => {
  const cropPath = cropFixture(t);
  const deleted = [];
  const webClient = {
    auth: { test: async () => ({ ok: true, team_id: config.teamId, user_id: config.botUserId, bot_id: config.botId }) },
    filesUploadV2: async () => ({ ok: true, files: [{ id: 'F123456789' }] }),
    files: { delete: async payload => { deleted.push(['file', payload.file]); return { ok: true }; } },
    chat: {
      postMessage: async () => ({ ok: true, channel: 'D123456789', ts: '1800000000.000001',
        message: { user: config.botUserId, bot_id: config.botId, app_id: config.appId } }),
      update: async () => ({ ok: true, channel: 'D123456789', ts: '1800000000.000001' }),
      delete: async payload => { deleted.push(['message', payload.channel, payload.ts]); return { ok: true }; }
    }
  };
  await assert.rejects(deliverSlackCaptcha({ state: { bind() { throw new Error('binding failed'); } }, request, cropPath, webClient, config }), /binding failed/);
  assert.deepEqual(deleted, [['message', 'D123456789', '1800000000.000001'], ['file', 'F123456789']]);
  assert.equal(fs.existsSync(cropPath), false);
});
