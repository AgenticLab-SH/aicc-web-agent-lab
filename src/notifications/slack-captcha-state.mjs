import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertPrivateDirectory, WINDOWS_PRIVATE_ACL_POLICY } from './slack-response-inbox.mjs';
import { formatKstTimestamp } from '../lib/time-display.mjs';
import { resolveWindowsPwsh } from '../lib/windows-pwsh.mjs';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const UUID = /^[a-f0-9-]{36}$/;
const SLACK_IDS = Object.freeze({
  teamId: /^T[A-Z0-9]{8,}$/,
  appId: /^A[A-Z0-9]{8,}$/,
  userId: /^U[A-Z0-9]{8,}$/,
  botUserId: /^U[A-Z0-9]{8,}$/,
  botId: /^B[A-Z0-9]{8,}$/,
  channelId: /^D[A-Z0-9]{8,}$/,
  messageTs: /^\d{8,}\.\d+$/,
  fileId: /^F[A-Z0-9]{8,}$/
});
const CALLBACK_ID = 'aicc_captcha_submit';
const OPEN_ACTION_ID = 'aicc_captcha_open';
const INPUT_BLOCK_ID = 'aicc_captcha_value';
const INPUT_ACTION_ID = 'aicc_captcha_value_input';
const MAX_STATE_BYTES = 32 * 1024;
export const MAX_CAPTCHA_LIFETIME_MS = 60 * 60_000;

const fail = code => { throw new Error(code); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function exact(name, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`invalid_${name}`);
  return value;
}

function identifier(name, value) {
  return exact(name, value, IDENTIFIER);
}

function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('unsafe_captcha_state_path');
  if (stat.size > MAX_STATE_BYTES) fail('captcha_state_too_large');
  return stat;
}

export function assertPrivateCaptchaPath(target, directory = true) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail('unsafe_captcha_state_path');
  if (process.platform !== 'win32') {
    assertPrivateDirectory(target, directory);
    return;
  }
  const result = spawnSync(resolveWindowsPwsh(), ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $p=[Console]::In.ReadToEnd(); $acl=Get-Acl -LiteralPath $p; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ' + WINDOWS_PRIVATE_ACL_POLICY],
  { input: target, encoding: 'utf8', windowsHide: true, timeout: 20_000, stdio: ['pipe', 'ignore', 'ignore'] });
  if (result.status !== 0 || result.error) fail('private_windows_acl_required');
}

function atomicPrivateJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function safeSiteLabel(value) {
  const label = String(value ?? '').trim();
  if (!label || label.length > 80 || /[\x00-\x1f]|https?:\/\/|xox[baprs]-|xapp-/i.test(label)) fail('invalid_site_label');
  return label;
}

function parseBoundValue(value) {
  const parts = String(value ?? '').split(':');
  if (parts.length !== 2 || !UUID.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])) fail('invalid_captcha_binding');
  return { requestId: parts[0], bindingHash: parts[1] };
}

function requestFile(root, requestId) {
  return path.join(root, `${hash(requestId)}.captcha.json`);
}

function lockFile(root, requestId) {
  return path.join(root, `${hash(requestId)}.captcha.lock`);
}

function createOwner(identity) {
  const owner = Object.freeze({
    teamId: exact('team_id', identity?.teamId, SLACK_IDS.teamId),
    appId: exact('app_id', identity?.appId, SLACK_IDS.appId),
    userId: exact('user_id', identity?.userId, SLACK_IDS.userId),
    botUserId: exact('bot_user_id', identity?.botUserId, SLACK_IDS.botUserId),
    botId: exact('bot_id', identity?.botId, SLACK_IDS.botId)
  });
  if (owner.userId === owner.botUserId) fail('distinct_bot_required');
  return owner;
}

function publicRequest(request) {
  return {
    requestId: request.requestId,
    projectKey: request.projectKey,
    taskId: request.taskId,
    challengeRevision: request.challengeRevision,
    siteLabel: request.siteLabel,
    expiresAt: new Date(request.expiresAt).toISOString(),
    bindingHash: request.bindingHash,
    delivery: request.delivery ? { channelId: request.delivery.channelId, messageTs: request.delivery.messageTs } : null,
    state: request.response ? 'answer_ready' : request.delivery ? 'delivered' : 'created',
    liveAutoWake: Boolean(request.wake?.callbackId)
  };
}

export function captchaButtonBlocks(request) {
  return [
    { type: 'section', text: { type: 'plain_text', text: `5 긴급 | ${request.siteLabel}\n보안문자의 영문·숫자만 입력해 주세요. 버튼이 열리지 않으면 이 메시지의 스레드 댓글에 문자만 보내세요. 문자를 보내면 이 요청의 현재 보안문자 칸에 한 번 입력하고 확인하는 데 동의한 것으로 처리합니다. 이 요청은 ${formatKstTimestamp(request.expiresAt)}까지 한 번만 유효합니다.` } },
    { type: 'actions', elements: [{
      type: 'button',
      text: { type: 'plain_text', text: '문자 입력' },
      action_id: OPEN_ACTION_ID,
      value: `${request.requestId}:${request.bindingHash}`
    }] },
    { type: 'context', elements: [{ type: 'plain_text', text: '비밀번호나 인증 코드는 입력하지 마세요.' }] }
  ];
}

export function createSlackCaptchaState({ root, identity, now = Date.now, checkDirectory = assertPrivateCaptchaPath }) {
  if (!path.isAbsolute(root)) fail('absolute_state_root_required');
  const owner = createOwner(identity);
  checkDirectory(root);
  const ownerHash = hash(JSON.stringify(owner));

  function read(requestId) {
    exact('request_id', requestId, UUID);
    const file = requestFile(root, requestId);
    regular(file);
    checkDirectory(file, false);
    let request;
    try { request = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('captcha_state_corrupt'); }
    if (request.schemaVersion !== 1 || request.kind !== 'slack_captcha_request' || request.ownerHash !== ownerHash
      || request.requestId !== requestId || request.bindingHash !== hash(JSON.stringify({
        ownerHash,
        requestId: request.requestId,
        projectKey: request.projectKey,
        taskId: request.taskId,
        challengeRevision: request.challengeRevision,
        expiresAt: request.expiresAt
      }))) fail('captcha_state_identity_or_binding_mismatch');
    return { file, request };
  }

  function transaction(requestId, work) {
    checkDirectory(root);
    const lock = lockFile(root, requestId);
    let descriptor;
    try { descriptor = fs.openSync(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail('captcha_state_busy'); throw error; }
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
      fs.fsyncSync(descriptor);
      const loaded = read(requestId);
      const result = work(loaded.request, loaded.file);
      if (result?.write !== false && fs.existsSync(loaded.file)) atomicPrivateJson(loaded.file, loaded.request);
      return result?.value;
    } finally {
      fs.closeSync(descriptor);
      fs.unlinkSync(lock);
    }
  }

  function assertOpen(request) {
    if (now() >= request.expiresAt) fail('captcha_request_expired');
    if (request.cancelled || request.consumed) fail('captcha_request_closed');
  }

  function verifySlackEnvelope(body) {
    if (body?.team?.id !== owner.teamId || body.api_app_id !== owner.appId || body.user?.id !== owner.userId
      || body.user?.is_bot || body.is_enterprise_install) fail('untrusted_captcha_response');
  }

  function verifyDeliveryEnvelope(request, body) {
    if (!request.delivery) fail('captcha_delivery_binding_pending');
    const expectedBotEdit = !body.message?.edited
      || body.message.edited.user === owner.botUserId && SLACK_IDS.messageTs.test(body.message.edited.ts ?? '');
    if (body.channel?.id !== request.delivery.channelId || body.container?.type !== 'message'
      || body.container?.is_ephemeral || body.container?.channel_id !== request.delivery.channelId
      || body.container?.message_ts !== request.delivery.messageTs || body.message?.ts !== request.delivery.messageTs
      || body.message?.user !== owner.botUserId || body.message?.bot_id !== owner.botId
      || (body.message?.app_id ?? body.message?.bot_profile?.app_id) !== owner.appId
      || !expectedBotEdit || (body.message?.subtype && body.message.subtype !== 'bot_message')) fail('captcha_delivery_binding_mismatch');
  }

  return Object.freeze({
    create(input) {
      const createdAt = now();
      const expiresAt = Date.parse(input?.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= createdAt || expiresAt - createdAt > MAX_CAPTCHA_LIFETIME_MS) fail('invalid_captcha_expiry');
      const requestId = crypto.randomUUID();
      const request = {
        schemaVersion: 1,
        kind: 'slack_captcha_request',
        ownerHash,
        requestId,
        projectKey: identifier('project_key', input?.projectKey),
        taskId: identifier('task_id', input?.taskId),
        challengeRevision: identifier('challenge_revision', input?.challengeRevision),
        siteLabel: safeSiteLabel(input?.siteLabel),
        createdAt,
        expiresAt,
        bindingHash: null,
        delivery: null,
        wake: null,
        response: null,
        cancelled: false,
        consumed: false
      };
      request.bindingHash = hash(JSON.stringify({ ownerHash, requestId, projectKey: request.projectKey, taskId: request.taskId,
        challengeRevision: request.challengeRevision, expiresAt }));
      const file = requestFile(root, requestId);
      if (fs.existsSync(file)) fail('captcha_request_collision');
      atomicPrivateJson(file, request);
      return publicRequest(request);
    },

    bind(requestId, delivery) {
      return transaction(requestId, request => {
        assertOpen(request);
        for (const [key, expected] of Object.entries({ teamId: owner.teamId, appId: owner.appId,
          recipientUserId: owner.userId, botUserId: owner.botUserId, botId: owner.botId })) {
          if (delivery?.[key] !== expected) fail('captcha_delivery_identity_mismatch');
        }
        const binding = {
          channelId: exact('channel_id', delivery?.channelId, SLACK_IDS.channelId),
          messageTs: exact('message_ts', delivery?.messageTs, SLACK_IDS.messageTs),
          fileId: exact('file_id', delivery?.fileId, SLACK_IDS.fileId)
        };
        for (const name of fs.readdirSync(root).filter(value => /^[a-f0-9]{64}\.captcha\.json$/.test(value))) {
          const candidateFile = path.join(root, name);
          if (candidateFile === requestFile(root, requestId)) continue;
          checkDirectory(candidateFile, false);
          regular(candidateFile);
          let candidate;
          try { candidate = JSON.parse(fs.readFileSync(candidateFile, 'utf8')); } catch { fail('captcha_state_corrupt'); }
          if (candidate.ownerHash !== ownerHash) fail('captcha_state_identity_or_binding_mismatch');
          if (candidate.delivery?.channelId === binding.channelId && candidate.delivery?.messageTs === binding.messageTs) {
            fail('captcha_delivery_already_bound');
          }
        }
        if (request.delivery && JSON.stringify(request.delivery) !== JSON.stringify(binding)) fail('captcha_delivery_rebind_forbidden');
        request.delivery = binding;
        return { value: { ok: true, state: 'bound' } };
      });
    },

    bindWake(requestId, wake) {
      return transaction(requestId, request => {
        assertOpen(request);
        const binding = {
          callbackId: exact('callback_id', wake?.callbackId, UUID),
          operationId: identifier('operation_id', wake?.operationId)
        };
        if (request.wake && JSON.stringify(request.wake) !== JSON.stringify(binding)) fail('captcha_wake_rebind_forbidden');
        request.wake = binding;
        return { value: { ok: true, state: 'wake_bound' } };
      });
    },

    modalForAction(body) {
      if (body?.type !== 'block_actions' || body.actions?.length !== 1) fail('unsupported_captcha_response');
      verifySlackEnvelope(body);
      const action = body.actions[0];
      if (action?.type !== 'button' || action.action_id !== OPEN_ACTION_ID) fail('unsupported_captcha_response');
      const { requestId, bindingHash } = parseBoundValue(action.value);
      const { request } = read(requestId);
      assertOpen(request);
      verifyDeliveryEnvelope(request, body);
      if (request.bindingHash !== bindingHash || request.response) fail('captcha_request_closed');
      exact('trigger_id', body.trigger_id, /^\d+\.[A-Za-z0-9.:-]{8,}$/);
      return {
        requestId,
        triggerId: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: CALLBACK_ID,
          private_metadata: `${requestId}:${request.bindingHash}`,
          title: { type: 'plain_text', text: '보안문자 입력' },
          submit: { type: 'plain_text', text: '전달' },
          close: { type: 'plain_text', text: '취소' },
          blocks: [{
            type: 'input',
            block_id: INPUT_BLOCK_ID,
            label: { type: 'plain_text', text: `${request.siteLabel}에 보이는 문자` },
            element: { type: 'plain_text_input', action_id: INPUT_ACTION_ID, multiline: false, max_length: 64 }
          }]
        }
      };
    },

    receiveModal(body) {
      if (body?.type !== 'view_submission' || body.view?.type !== 'modal' || body.view?.callback_id !== CALLBACK_ID) fail('unsupported_captcha_response');
      verifySlackEnvelope(body);
      const { requestId, bindingHash } = parseBoundValue(body.view.private_metadata);
      const values = body.view?.state?.values;
      const entry = values?.[INPUT_BLOCK_ID]?.[INPUT_ACTION_ID];
      if (Object.keys(values ?? {}).length !== 1 || Object.keys(values?.[INPUT_BLOCK_ID] ?? {}).length !== 1
        || entry?.type !== 'plain_text_input') fail('invalid_captcha_value');
      const value = String(entry.value ?? '').trim();
      if (!value || value.length > 64 || !/^[A-Za-z0-9]+$/.test(value)) fail('invalid_captcha_value');
      return transaction(requestId, request => {
        assertOpen(request);
        if (request.bindingHash !== bindingHash || !request.delivery) fail('captcha_response_binding_mismatch');
        if (request.response) fail('captcha_request_already_answered');
        request.response = { value, receivedAt: now() };
        return { value: { ok: true, state: 'answer_ready', requestId } };
      });
    },

    receiveThreadReply(body) {
      if (body?.type !== 'event_callback' || body.team_id !== owner.teamId || body.api_app_id !== owner.appId) {
        fail('untrusted_captcha_response');
      }
      const event = body.event;
      if (event?.type !== 'message' || event.channel_type !== 'im' || event.user !== owner.userId
        || event.bot_id || event.subtype || event.hidden || !SLACK_IDS.channelId.test(event.channel ?? '')
        || !SLACK_IDS.messageTs.test(event.thread_ts ?? '') || !SLACK_IDS.messageTs.test(event.ts ?? '')
        || event.ts === event.thread_ts) fail('unsupported_captcha_response');

      const matches = [];
      for (const name of fs.readdirSync(root).filter(value => /^[a-f0-9]{64}\.captcha\.json$/.test(value))) {
        const file = path.join(root, name);
        checkDirectory(file, false);
        regular(file);
        let candidate;
        try { candidate = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('captcha_state_corrupt'); }
        if (candidate.ownerHash !== ownerHash || !UUID.test(candidate.requestId) || requestFile(root, candidate.requestId) !== file) {
          fail('captcha_state_identity_or_binding_mismatch');
        }
        read(candidate.requestId);
        if (candidate.delivery?.channelId === event.channel && candidate.delivery?.messageTs === event.thread_ts) {
          matches.push(candidate.requestId);
        }
      }
      if (matches.length !== 1) fail('captcha_delivery_binding_mismatch');
      const value = String(event.text ?? '').trim();
      if (!value || value.length > 64 || !/^[A-Za-z0-9]+$/.test(value)) fail('invalid_captcha_value');
      return transaction(matches[0], request => {
        assertOpen(request);
        if (!request.delivery || request.delivery.channelId !== event.channel || request.delivery.messageTs !== event.thread_ts) {
          fail('captcha_response_binding_mismatch');
        }
        if (request.response) fail('captcha_request_already_answered');
        request.response = { value, receivedAt: now() };
        return { value: { ok: true, state: 'answer_ready', requestId: request.requestId } };
      });
    },

    async consume(binding, useValue, options = {}) {
      if (typeof useValue !== 'function') fail('captcha_value_consumer_required');
      const requestId = exact('request_id', binding?.requestId, UUID);
      const lock = lockFile(root, requestId);
      let descriptor;
      try { descriptor = fs.openSync(lock, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') fail('captcha_state_busy'); throw error; }
      let value;
      let fileId;
      try {
        const loaded = read(requestId);
        const request = loaded.request;
        assertOpen(request);
        if (request.projectKey !== binding?.projectKey || request.taskId !== binding?.taskId
          || request.challengeRevision !== binding?.challengeRevision || request.bindingHash !== binding?.bindingHash) fail('captcha_consumer_binding_mismatch');
        if (!request.response?.value) fail('captcha_answer_not_ready');
        value = request.response.value;
        fileId = request.delivery?.fileId ?? null;
        fs.unlinkSync(loaded.file);
      } finally {
        fs.closeSync(descriptor);
        fs.unlinkSync(lock);
      }
      try {
        await useValue(value);
      } catch {
        throw new Error('captcha_value_consumer_failed');
      } finally {
        value = null;
      }
      let slackFileDeleted = false;
      if (fileId && typeof options.deleteSlackFile === 'function') {
        try { await options.deleteSlackFile(fileId); slackFileDeleted = true; } catch { slackFileDeleted = false; }
      }
      return { ok: true, state: 'consumed_and_purged', slackFileDeleted };
    },

    async cancel(binding, options = {}) {
      const requestId = exact('request_id', binding?.requestId, UUID);
      let fileId = null;
      transaction(requestId, (request, file) => {
        if (request.projectKey !== binding?.projectKey || request.taskId !== binding?.taskId
          || request.bindingHash !== binding?.bindingHash) fail('captcha_cancel_binding_mismatch');
        fileId = request.delivery?.fileId ?? null;
        fs.unlinkSync(file);
        return { write: false, value: null };
      });
      let slackFileDeleted = false;
      if (fileId && typeof options.deleteSlackFile === 'function') {
        try { await options.deleteSlackFile(fileId); slackFileDeleted = true; } catch { slackFileDeleted = false; }
      }
      return { ok: true, state: 'cancelled_and_purged', slackFileDeleted };
    },

    async purgeExpired(options = {}) {
      checkDirectory(root);
      const files = fs.readdirSync(root).filter(name => /^[a-f0-9]{64}\.captcha\.json$/.test(name));
      const fileIds = [];
      let purged = 0;
      let held = 0;
      for (const name of files) {
        const file = path.join(root, name);
        let request;
        try {
          checkDirectory(file, false);
          regular(file);
          try { request = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('captcha_state_corrupt'); }
          if (request.ownerHash !== ownerHash || !UUID.test(request.requestId) || requestFile(root, request.requestId) !== file) {
            fail('captcha_state_identity_or_binding_mismatch');
          }
          if (now() < request.expiresAt) continue;
          transaction(request.requestId, (current, currentFile) => {
            if (now() < current.expiresAt) return { write: false, value: null };
            if (current.delivery?.fileId) fileIds.push(current.delivery.fileId);
            fs.unlinkSync(currentFile);
            purged += 1;
            return { write: false, value: null };
          });
        } catch (error) {
          if (error.message === 'captcha_state_busy') { held += 1; continue; }
          throw error;
        }
      }
      let slackFilesDeleted = 0;
      if (typeof options.deleteSlackFile === 'function') {
        for (const fileId of fileIds) {
          try { await options.deleteSlackFile(fileId); slackFilesDeleted += 1; } catch { /* local expiry purge remains authoritative. */ }
        }
      }
      return { ok: held === 0, state: held === 0 ? 'expired_purged' : 'purge_hold', purged, slackFilesDeleted, held };
    },

    inspect(requestId) {
      const { request } = read(requestId);
      return publicRequest(request);
    },

    pendingWakes() {
      checkDirectory(root);
      const pending = [];
      for (const name of fs.readdirSync(root).filter(value => /^[a-f0-9]{64}\.captcha\.json$/.test(value))) {
        const file = path.join(root, name);
        checkDirectory(file, false);
        regular(file);
        let request;
        try { request = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('captcha_state_corrupt'); }
        if (request.ownerHash !== ownerHash || !UUID.test(request.requestId) || requestFile(root, request.requestId) !== file) {
          fail('captcha_state_identity_or_binding_mismatch');
        }
        read(request.requestId);
        if (now() < request.expiresAt && request.response && request.wake?.callbackId) {
          pending.push(Object.freeze({
            requestId: request.requestId,
            callbackId: exact('callback_id', request.wake.callbackId, UUID),
            operationId: identifier('operation_id', request.wake.operationId),
            expiresAt: new Date(request.expiresAt).toISOString()
          }));
        }
      }
      return Object.freeze(pending);
    },

    status() {
      checkDirectory(root);
      const files = fs.readdirSync(root).filter(name => /^[a-f0-9]{64}\.captcha\.json$/.test(name));
      let active = 0;
      let answerReady = 0;
      let expired = 0;
      let wakeReady = 0;
      for (const name of files) {
        const file = path.join(root, name);
        checkDirectory(file, false);
        regular(file);
        let request;
        try { request = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('captcha_state_corrupt'); }
        if (request.ownerHash !== ownerHash || !UUID.test(request.requestId) || requestFile(root, request.requestId) !== file) {
          fail('captcha_state_identity_or_binding_mismatch');
        }
        read(request.requestId);
        if (now() >= request.expiresAt) expired += 1;
        else {
          if (request.wake?.callbackId) wakeReady += 1;
          if (request.response) answerReady += 1;
          else active += 1;
        }
      }
      return { schemaVersion: 1, liveAutoWake: wakeReady > 0, active, answerReady, expired };
    }
  });
}

export const SLACK_CAPTCHA_IDS = Object.freeze({ CALLBACK_ID, OPEN_ACTION_ID, INPUT_BLOCK_ID, INPUT_ACTION_ID });
