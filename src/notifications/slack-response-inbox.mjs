import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { formatKstTimestamp } from '../lib/time-display.mjs';

export const RESPONSE_LABELS = Object.freeze({
  acknowledge: '확인', done: '처리 완료', approve: '이 작업 승인', reject: '거절', hold: '보류'
});
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const UUID = /^[a-f0-9-]{36}$/;
const MAX_BYTES = 1024 * 1024;
export const WINDOWS_PRIVATE_ACL_POLICY = '$sd=New-Object Security.AccessControl.RawSecurityDescriptor($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)); if($null -eq $sd.DiscretionaryAcl){exit 4}; $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; if($owner -ne $sid){exit 2}; foreach($r in $acl.Access){if($r.AccessControlType -eq "Allow" -and $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($sid,"S-1-5-18","S-1-5-32-544")){exit 3}}';
const fail = code => { throw new Error(code); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function id(value) { if (typeof value !== 'string' || !ID.test(value)) fail('invalid_identifier'); return value; }
function exact(value, pattern) { if (typeof value !== 'string' || !pattern.test(value)) fail('invalid_binding'); return value; }
function regular(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail('unsafe_state_path');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid())) fail('unsafe_state_permissions');
  return stat;
}

// Check the actual Windows ACL; chmod(0600) is not an ACL protection mechanism.
export function assertPrivateDirectory(root, directory = true) {
  regular(root, directory);
  if (process.platform !== 'win32') return;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $p=[Console]::In.ReadToEnd(); $acl=Get-Acl -LiteralPath $p; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ' + WINDOWS_PRIVATE_ACL_POLICY],
  { input: root, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['pipe', 'ignore', 'ignore'] });
  if (result.status !== 0 || result.error) fail('private_windows_acl_required');
}

export function createSlackResponseInbox({ root, identity, now = Date.now, checkDirectory = assertPrivateDirectory }) {
  if (!path.isAbsolute(root)) fail('absolute_state_root_required');
  const owner = Object.freeze({
    teamId: exact(identity?.teamId, /^T[A-Z0-9]{8,}$/),
    appId: exact(identity?.appId, /^A[A-Z0-9]{8,}$/),
    userId: exact(identity?.userId, /^U[A-Z0-9]{8,}$/),
    botUserId: exact(identity?.botUserId, /^U[A-Z0-9]{8,}$/),
    botId: exact(identity?.botId, /^B[A-Z0-9]{8,}$/)
  });
  if (owner.userId === owner.botUserId) fail('distinct_bot_required');
  // Read-only construction never creates state; writes require a pre-protected root.
  checkDirectory(root);
  const file = path.join(root, 'inbox.json');
  const lock = path.join(root, 'inbox.lock');
  if (fs.existsSync(file)) checkDirectory(file, false);
  const ownerHash = hash(JSON.stringify(owner));
  function read() {
    if (!fs.existsSync(file)) return { schemaVersion: 1, ownerHash, requests: [] };
    if (regular(file).size > MAX_BYTES) fail('inbox_too_large');
    let state;
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('inbox_corrupt'); }
    if (state.schemaVersion !== 1 || state.ownerHash !== ownerHash || !Array.isArray(state.requests)) fail('inbox_identity_or_schema_mismatch');
    return state;
  }
  function transaction(work) {
    regular(root, true);
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') fail('inbox_busy'); throw error; }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      fs.fsyncSync(fd);
      const state = read();
      const result = work(state);
      const bytes = JSON.stringify(state);
      if (Buffer.byteLength(bytes) > MAX_BYTES || state.requests.length > 1000) fail('inbox_capacity_hold');
      const temp = path.join(root, `${crypto.randomUUID()}.tmp`);
      const out = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(out, bytes); fs.fsyncSync(out); } finally { fs.closeSync(out); }
      try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
      return result;
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  function find(state, requestId) {
    const request = state.requests.find(item => item.requestId === requestId);
    if (!request) fail('request_not_found');
    return request;
  }
  function publicResponse(request) {
    return { requestId: request.requestId, projectKey: request.projectKey, taskId: request.taskId,
      revision: request.revision, operation: request.operation, operationHash: request.operationHash,
      expiresAt: request.expiresAt, ...request.response,
      authority: request.response?.action === 'approve' ? 'single_operation_consent_not_native_permission' : 'owner_response_not_completion_proof' };
  }
  return Object.freeze({
    create(input) {
      const { projectKey, taskId, revision, operation, approval = false, expiresAt } = input;
      id(projectKey); id(taskId); id(revision);
      if (typeof operation !== 'string' || !operation.trim() || operation.length > 240 || /[\x00-\x1f]|https?:\/\/|xox[baprs]-|xapp-/.test(operation)) fail('invalid_public_operation_summary');
      if (typeof approval !== 'boolean') fail('invalid_approval_flag');
      const expiry = Date.parse(expiresAt);
      const createdAt = now();
      if (!Number.isFinite(expiry) || expiry <= createdAt || expiry - createdAt > (approval ? 900000 : 86400000)) fail('invalid_request_expiry');
      return transaction(state => {
        const request = { requestId: crypto.randomUUID(), projectKey, taskId, revision, operation,
          operationHash: hash(JSON.stringify({ projectKey, taskId, revision, operation, approval })),
          approval, createdAt, expiresAt: expiry, delivery: null, response: null, cancelled: false };
        state.requests.push(request);
        return structuredClone(request);
      });
    },
    bind(requestId, delivery) {
      return transaction(state => {
        const request = find(state, requestId);
        if (request.cancelled || request.response || now() >= request.expiresAt) fail('request_closed');
        for (const [key, expected] of Object.entries({ teamId: owner.teamId, appId: owner.appId,
          recipientUserId: owner.userId, botUserId: owner.botUserId, botId: owner.botId })) {
          if (delivery?.[key] !== expected) fail('delivery_identity_mismatch');
        }
        const binding = { channelId: exact(delivery.channelId, /^D[A-Z0-9]{8,}$/), messageTs: exact(delivery.messageTs, /^\d{8,}\.\d+$/) };
        if (request.delivery && JSON.stringify(request.delivery) !== JSON.stringify(binding)) fail('delivery_rebind_forbidden');
        if (state.requests.some(item => item.requestId !== requestId && item.delivery?.channelId === binding.channelId && item.delivery?.messageTs === binding.messageTs)) fail('delivery_already_bound');
        request.delivery = binding;
        return { ok: true, state: 'bound' };
      });
    },
    receive(body) {
      // Called only by the authenticated Socket Mode adapter, never an HTTP route.
      if (body?.type !== 'block_actions' || body.team?.id !== owner.teamId || body.api_app_id !== owner.appId || body.user?.id !== owner.userId
        || body.user?.is_bot || body.is_enterprise_install || body.container?.type !== 'message'
        || body.container?.is_ephemeral || body.message?.user !== owner.botUserId
        || body.message?.bot_id !== owner.botId || (body.message?.app_id ?? body.message?.bot_profile?.app_id) !== owner.appId
        || body.message?.edited || body.message?.subtype && body.message.subtype !== 'bot_message'
        || body.actions?.length !== 1) fail('untrusted_slack_response');
      const action = body.actions[0];
      const actionName = String(action.action_id ?? '').replace(/^aicc_response_/, '');
      if (action.type !== 'button' || action.action_id !== `aicc_response_${actionName}` || !Object.hasOwn(RESPONSE_LABELS, actionName)) fail('unsupported_response');
      const parts = String(action.value ?? '').split(':');
      const [requestId, operationHash] = parts;
      if (parts.length !== 2 || !UUID.test(requestId) || !/^[a-f0-9]{64}$/.test(operationHash)) fail('invalid_response_binding');
      const actionAt = Number(action.action_ts) * 1000;
      if (!Number.isFinite(actionAt) || Math.abs(now() - actionAt) > 300000) fail('stale_response');
      return transaction(state => {
        const request = find(state, requestId);
        if (request.operationHash !== operationHash) fail('response_binding_mismatch');
        if (!request.delivery) fail('delivery_binding_pending');
        if (request.delivery.channelId !== body.channel?.id
          || request.delivery.channelId !== body.container.channel_id || request.delivery.messageTs !== body.container.message_ts
          || request.delivery.messageTs !== body.message.ts) fail('response_binding_mismatch');
        if (request.cancelled || now() >= request.expiresAt || actionAt < request.createdAt) fail('request_closed');
        if (actionName === 'approve' && !request.approval) fail('approval_not_requested');
        const responseId = hash(`${requestId}:${actionName}:${action.action_ts}`);
        if (request.response) {
          if (request.response.responseId === responseId) return { ok: true, state: 'duplicate', responseId };
          fail('request_already_answered');
        }
        request.response = { responseId, action: actionName, receivedAt: now(), state: 'queued_transport_unavailable' };
        return { ok: true, state: request.response.state, responseId };
      });
    },
    pending({ projectKey, taskId }) {
      id(projectKey); id(taskId);
      return read().requests.filter(r => r.projectKey === projectKey && r.taskId === taskId && !r.cancelled
        && r.expiresAt > now() && r.response?.state === 'queued_transport_unavailable').map(publicResponse);
    },
    acknowledge({ projectKey, taskId, requestId, responseId, operationHash }) {
      return transaction(state => {
        const r = find(state, requestId);
        if (r.projectKey !== projectKey || r.taskId !== taskId || r.operationHash !== operationHash
          || r.response?.responseId !== responseId || r.cancelled || now() >= r.expiresAt) fail('receipt_binding_or_expiry_mismatch');
        r.response.state = 'agent_seen';
        r.response.seenAt = now();
        return { ok: true, state: 'agent_seen', executionVerified: false };
      });
    },
    cancel({ projectKey, taskId, requestId }) {
      return transaction(state => {
        const r = find(state, requestId);
        if (r.projectKey !== projectKey || r.taskId !== taskId) fail('cancel_binding_mismatch');
        r.cancelled = true;
        return { ok: true, state: 'cancelled' };
      });
    },
    status() {
      const requests = read().requests;
      return { schemaVersion: 1, desktopAutoWake: false, requestCount: requests.length,
        pending: requests.filter(r => !r.cancelled && r.expiresAt > now() && r.response?.state === 'queued_transport_unavailable').length,
        expired: requests.filter(r => r.expiresAt <= now()).length };
    }
  });
}

export function responseBlocks(request) {
  const actions = Object.entries(RESPONSE_LABELS).filter(([action]) => action !== 'approve' || request.approval);
  return [
    { type: 'section', text: { type: 'plain_text', text: `${request.operation}\n프로젝트: ${request.projectKey} / 버전: ${request.revision}\n유효 시간: ${formatKstTimestamp(request.expiresAt)}\n응답은 한 번만 받습니다. 처리 완료는 확인 요청이며 실제 완료 증거는 아닙니다.` } },
    { type: 'actions', elements: actions.map(([action, label]) => ({ type: 'button',
      text: { type: 'plain_text', text: label }, action_id: `aicc_response_${action}`,
      value: `${request.requestId}:${request.operationHash}`,
      ...(action === 'approve' ? { confirm: { title: { type: 'plain_text', text: '이 작업만 승인' },
        text: { type: 'plain_text', text: request.operation.slice(0, 300) },
        confirm: { type: 'plain_text', text: '승인' }, deny: { type: 'plain_text', text: '취소' } } } : {}) })) },
    { type: 'context', elements: [{ type: 'plain_text', text: '답변 수신과 Codex 전달은 별개입니다. 자동 전달 연결이 없으면 보관 후 작업 재개 시 확인합니다.' }] }
  ];
}
