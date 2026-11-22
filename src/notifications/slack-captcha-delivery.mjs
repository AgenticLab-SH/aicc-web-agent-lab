import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captchaButtonBlocks } from './slack-captcha-state.mjs';
import { formatKstTimestamp } from '../lib/time-display.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ID = Object.freeze({
  team: /^T[A-Z0-9]{8,}$/,
  user: /^U[A-Z0-9]{8,}$/,
  bot: /^B[A-Z0-9]{8,}$/,
  app: /^A[A-Z0-9]{8,}$/,
  channel: /^D[A-Z0-9]{8,}$/,
  messageTs: /^\d{8,}\.\d+$/,
  file: /^F[A-Z0-9]{8,}$/
});

const fail = code => { throw new Error(code); };

function exact(name, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`invalid_${name}`);
  return value;
}

function validateIdentity(config) {
  return Object.freeze({
    teamId: exact('team_id', config?.teamId, ID.team),
    recipientUserId: exact('recipient_user_id', config?.recipientUserId, ID.user),
    appId: exact('app_id', config?.appId, ID.app),
    botUserId: exact('bot_user_id', config?.botUserId, ID.user),
    botId: exact('bot_id', config?.botId, ID.bot)
  });
}

function readBoundedPng(cropPath, allowedCropRoot) {
  const resolvedCrop = path.resolve(cropPath);
  const resolvedRoot = path.resolve(allowedCropRoot);
  if (resolvedCrop === resolvedRoot || !resolvedCrop.startsWith(`${resolvedRoot}${path.sep}`)) fail('captcha_crop_outside_private_temp');
  const stat = fs.lstatSync(cropPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 33 || stat.size > 2 * 1024 * 1024) fail('invalid_captcha_crop');
  const image = fs.readFileSync(cropPath);
  if (!image.subarray(0, 8).equals(PNG_SIGNATURE) || image.toString('ascii', 12, 16) !== 'IHDR') fail('captcha_crop_png_required');
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (width < 16 || height < 8 || width > 1200 || height > 500 || width * height > 600_000) fail('captcha_crop_bounds_required');
  return image;
}

function uploadedFileId(result) {
  const entries = Array.isArray(result?.files) ? result.files : result?.file ? [result.file] : [];
  const files = entries.flatMap(entry => Array.isArray(entry?.files)
    ? entry.files
    : entry?.file
      ? [entry.file]
      : entry?.id
        ? [entry]
        : []);
  if (result?.ok !== true || files.length !== 1) fail('slack_captcha_upload_failed');
  return exact('file_id', files[0]?.id, ID.file);
}

async function bestEffortDelete(webClient, fileId) {
  try { await webClient.files.delete({ file: fileId }); return true; } catch { return false; }
}

async function bestEffortDeleteMessage(webClient, channel, ts) {
  try { await webClient.chat.delete({ channel, ts }); return true; } catch { return false; }
}

export async function deliverSlackCaptcha({ state, request, cropPath, webClient, config, allowedCropRoot = os.tmpdir() }) {
  if (!state || typeof state.bind !== 'function' || !request?.requestId || !request?.bindingHash) fail('captcha_request_required');
  if (!webClient?.auth?.test || !webClient?.filesUploadV2 || !webClient?.files?.delete
    || !webClient?.chat?.postMessage || !webClient?.chat?.update || !webClient?.chat?.delete) {
    fail('slack_web_client_capability_required');
  }
  const identity = validateIdentity(config);
  let image;
  let cropAccepted = false;
  let fileId = null;
  let messageBinding = null;
  let localRemoved = false;
  try {
    image = readBoundedPng(cropPath, allowedCropRoot);
    cropAccepted = true;
    const auth = await webClient.auth.test();
    if (auth?.ok !== true || auth.team_id !== identity.teamId || auth.user_id !== identity.botUserId || auth.bot_id !== identity.botId) {
      fail('slack_captcha_identity_mismatch');
    }
    const upload = await webClient.filesUploadV2({
      file: image,
      filename: 'captcha.png',
      title: '보안문자',
      alt_text: '보안문자 이미지'
    });
    fileId = uploadedFileId(upload);
    const blocks = captchaButtonBlocks(request);
    const notificationText = `5 긴급 | ${request.siteLabel} 보안문자 입력 필요 · ${formatKstTimestamp(request.expiresAt)}까지`;
    const message = await webClient.chat.postMessage({
      channel: identity.recipientUserId,
      text: notificationText,
      blocks,
      unfurl_links: false,
      unfurl_media: false
    });
    const delivery = {
      ...identity,
      channelId: exact('channel_id', message?.channel, ID.channel),
      messageTs: exact('message_ts', message?.ts, ID.messageTs),
      fileId
    };
    messageBinding = { channel: delivery.channelId, ts: delivery.messageTs };
    if (message?.ok !== true || message.message?.user !== identity.botUserId || message.message?.bot_id !== identity.botId
      || (message.message?.app_id ?? message.message?.bot_profile?.app_id) !== identity.appId) fail('slack_captcha_delivery_identity_mismatch');
    const attached = await webClient.chat.update({
      channel: delivery.channelId,
      ts: delivery.messageTs,
      text: notificationText,
      blocks,
      file_ids: [fileId]
    });
    if (attached?.ok !== true || attached.channel !== delivery.channelId || attached.ts !== delivery.messageTs) {
      fail('slack_captcha_native_attachment_failed');
    }
    state.bind(request.requestId, delivery);
    return { ok: true, state: 'delivered', requestId: request.requestId, channelId: delivery.channelId, messageTs: delivery.messageTs };
  } catch (error) {
    if (messageBinding) await bestEffortDeleteMessage(webClient, messageBinding.channel, messageBinding.ts);
    if (fileId) await bestEffortDelete(webClient, fileId);
    throw error;
  } finally {
    if (image) image.fill(0);
    if (cropAccepted) {
      try { fs.unlinkSync(cropPath); localRemoved = true; } catch { localRemoved = false; }
      if (!localRemoved) {
        if (messageBinding) await bestEffortDeleteMessage(webClient, messageBinding.channel, messageBinding.ts);
        if (fileId) await bestEffortDelete(webClient, fileId);
        fail('captcha_crop_cleanup_failed');
      }
    }
  }
}

export async function deleteSlackCaptchaFile(webClient, fileId) {
  exact('file_id', fileId, ID.file);
  if (!webClient?.files?.delete) fail('slack_file_delete_capability_required');
  const result = await webClient.files.delete({ file: fileId });
  if (result?.ok !== true) fail('slack_captcha_file_delete_failed');
  return { ok: true };
}
