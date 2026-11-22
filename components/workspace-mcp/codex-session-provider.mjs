import fs from 'node:fs';
import path from 'node:path';
import {
  LocalAccessPolicyError,
  assertGrantedRelativePath,
  mapFilesystemError,
  redactLocalText,
  stableHash
} from './local-access-policy.mjs';
import { WORKSPACE_MCP_INPUT_SCHEMAS } from './input-schemas.mjs';
import { summarizeCodexSessionActivity } from './codex-session-activity.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HIDDEN_EVENT_KINDS = /(?:command|exec|function_call_output|tool_output|tool_result)/i;
const PROMPT_EVENT_KINDS = /(?:prompt|user_message|system_message|developer_message)/i;
const METADATA_SAMPLE_BYTES = 512 * 1024;

function eventKind(event) {
  const candidate = event?.type ?? event?.event ?? event?.kind ?? event?.payload?.type ?? 'unknown_redacted';
  return String(candidate).replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 80) || 'unknown_redacted';
}

function eventTimestamp(event) {
  const value = event?.timestamp ?? event?.created_at ?? event?.payload?.timestamp ?? null;
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function eventRole(event) {
  const value = event?.role ?? event?.payload?.role ?? event?.payload?.message?.role ?? null;
  return typeof value === 'string' ? value.slice(0, 32) : null;
}

function eventText(event) {
  const payload = event?.payload ?? event;
  const candidates = [payload?.text, payload?.message, payload?.content, payload?.output, payload?.summary];
  for (const value of candidates) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const joined = value.map(item => typeof item === 'string' ? item : item?.text ?? item?.content ?? '').filter(Boolean).join('\n');
      if (joined) return joined;
    }
    if (value && typeof value === 'object') {
      const nested = value.content ?? value.text;
      if (typeof nested === 'string') return nested;
      if (Array.isArray(nested)) {
        const joined = nested.map(item => typeof item === 'string' ? item : item?.text ?? '').filter(Boolean).join('\n');
        if (joined) return joined;
      }
    }
  }
  return null;
}

function sessionMetaFromEvents(events, file, relativePath, now = Date.now()) {
  const sessionMeta = events.find(event => eventKind(event) === 'session_meta') ?? events[0] ?? {};
  const payload = sessionMeta?.payload ?? sessionMeta;
  const filenameUuid = path.basename(relativePath, path.extname(relativePath));
  const uuid = payload?.id ?? payload?.session_id ?? payload?.sessionId ?? (UUID.test(filenameUuid) ? filenameUuid : null);
  if (!UUID.test(uuid ?? '')) return null;
  const timestamp = payload?.timestamp ?? payload?.created_at ?? events.map(eventTimestamp).find(Boolean) ?? null;
  const date = Number.isFinite(Date.parse(timestamp))
    ? new Date(timestamp).toISOString()
    : new Date(file.stat.mtimeMs).toISOString();
  const cwd = typeof payload?.cwd === 'string' ? redactLocalText(payload.cwd).slice(0, 512) : null;
  const titleCandidate = payload?.title ?? events.find(event => typeof event?.title === 'string')?.title ?? 'Untitled Codex session';
  const title = redactLocalText(titleCandidate).replace(/\s+/g, ' ').trim().slice(0, 240);
  return {
    session_uuid: uuid.toLocaleLowerCase('en-US'),
    date,
    cwd,
    title,
    ...summarizeCodexSessionActivity(events, { now }),
    size_bytes: file.stat.size,
    event_kinds: [...new Set(events.map(eventKind))].sort(),
    _relativePath: relativePath
  };
}

function enumerateJsonl(grant, limit, sessionUuid = null) {
  const queue = ['.'];
  const files = [];
  const exactUuid = typeof sessionUuid === 'string' ? sessionUuid.toLocaleLowerCase('en-US') : null;
  while (queue.length) {
    const relativeDirectory = queue.shift();
    const directory = assertGrantedRelativePath(grant, relativeDirectory, { expect: 'directory' });
    let entries;
    try { entries = fs.readdirSync(directory.path, { withFileTypes: true }); }
    catch (error) { throw mapFilesystemError(error, 'Codex session index read failed'); }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDirectory === '.' ? entry.name : `${relativeDirectory}/${entry.name}`;
      const resolved = assertGrantedRelativePath(grant, relativePath);
      if (resolved.stat.isDirectory()) queue.push(relativePath);
      else if (resolved.stat.isFile() && path.extname(entry.name).toLocaleLowerCase('en-US') === '.jsonl') {
        const basename = path.basename(entry.name, path.extname(entry.name)).toLocaleLowerCase('en-US');
        if (exactUuid && !basename.endsWith(exactUuid)) continue;
        files.push(resolved);
        if (files.length > limit) return files;
      }
    }
  }
  return files;
}

function readRange(file, offset, length) {
  if (length < 1) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  let descriptor;
  try {
    descriptor = fs.openSync(file.path, 'r');
    const bytes = fs.readSync(descriptor, buffer, 0, length, offset);
    return buffer.subarray(0, bytes);
  } catch (error) {
    throw mapFilesystemError(error, 'Codex session file read failed');
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function parseJsonlBuffer(buffer, { dropLeadingPartial = false, dropTrailingPartial = false } = {}) {
  let text = buffer.toString('utf8').replaceAll('\r\n', '\n');
  if (dropLeadingPartial) {
    const newline = text.indexOf('\n');
    text = newline === -1 ? '' : text.slice(newline + 1);
  }
  if (dropTrailingPartial) {
    const newline = text.lastIndexOf('\n');
    text = newline === -1 ? '' : text.slice(0, newline);
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { events.push({ type: 'invalid_json_redacted' }); }
  }
  return events;
}

function readMetadataEvents(file, grant, remainingBytes) {
  const approvedBytes = Math.min(file.stat.size, grant.budgets.maxFileBytes, remainingBytes, METADATA_SAMPLE_BYTES);
  if (approvedBytes < 1) throw new LocalAccessPolicyError('local_byte_budget_exceeded', 'session metadata scan exhausted the approved per-call budget');
  if (file.stat.size <= approvedBytes) {
    const buffer = readRange(file, 0, approvedBytes);
    return { events: parseJsonlBuffer(buffer), bytes: buffer.length, sampled: false };
  }
  const headBytes = Math.ceil(approvedBytes / 2);
  const tailBytes = approvedBytes - headBytes;
  const head = readRange(file, 0, headBytes);
  const tail = readRange(file, Math.max(0, file.stat.size - tailBytes), tailBytes);
  return {
    events: [
      ...parseJsonlBuffer(head, { dropTrailingPartial: true }),
      ...parseJsonlBuffer(tail, { dropLeadingPartial: true })
    ],
    bytes: head.length + tail.length,
    sampled: true
  };
}

function readExcerptEvents(file, grant) {
  const approvedBytes = Math.min(file.stat.size, grant.budgets.maxFileBytes, grant.budgets.maxReadBytes);
  if (approvedBytes < 1) throw new LocalAccessPolicyError('local_byte_budget_exceeded', 'session excerpt scan exhausted the approved per-call budget');
  const buffer = readRange(file, 0, approvedBytes);
  return {
    events: parseJsonlBuffer(buffer, { dropTrailingPartial: file.stat.size > buffer.length }),
    bytes: buffer.length,
    truncated: file.stat.size > buffer.length
  };
}

function buildSessionIndex(authority, record, { sessionUuid = null } = {}) {
  const sessions = [];
  let bytes = 0;
  const remainingFiles = record.grant.budgets.maxFiles - record.usedFiles;
  if (remainingFiles < 1) throw new LocalAccessPolicyError('local_file_budget_exceeded', 'the approved session file-count budget is exhausted');
  const files = enumerateJsonl(record.grant, remainingFiles, sessionUuid);
  if (files.length > remainingFiles) throw new LocalAccessPolicyError('local_file_budget_exceeded', 'the session index exceeds the approved file-count budget');
  for (const file of files) {
    const read = readMetadataEvents(file, record.grant, record.grant.budgets.maxReadBytes - bytes);
    bytes += read.bytes;
    if (bytes > record.grant.budgets.maxReadBytes) throw new LocalAccessPolicyError('local_byte_budget_exceeded', 'session index scan exceeds the approved per-call budget');
    const metadata = sessionMetaFromEvents(read.events, file, file.relativePath, authority.now());
    if (metadata) sessions.push(metadata);
  }
  authority.consume(record, { files: files.length, bytes });
  return sessions.sort((a, b) => b.date.localeCompare(a.date));
}

function publicSession(metadata) {
  const { _relativePath: _privatePath, ...value } = metadata;
  return value;
}

async function validateExcerptApproval(resolver, usedApprovals, input, record, now) {
  if (typeof resolver !== 'function') throw new LocalAccessPolicyError('session_approval_unavailable', 'a separate local UI excerpt approval resolver is required');
  const approvalKey = stableHash(`${record.sourceId}\0${input.approval_ref}`);
  if (usedApprovals.has(approvalKey)) throw new LocalAccessPolicyError('session_approval_replay', 'the excerpt approval_ref was already consumed');
  const approval = await resolver({
    approvalRef: input.approval_ref,
    sourceId: record.sourceId,
    sessionUuid: input.session_uuid,
    correlationId: input.correlation_id,
    auditHash: record.grant.auditHash
  });
  if (!approval?.approved) throw new LocalAccessPolicyError('session_approval_denied', 'the excerpt approval_ref is unknown or not approved');
  if (approval.sourceId !== record.sourceId || approval.sessionUuid !== input.session_uuid || approval.correlationId !== input.correlation_id) {
    throw new LocalAccessPolicyError('session_approval_mismatch', 'the excerpt approval is bound to another source, session, or correlation');
  }
  if (!Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= now()) {
    throw new LocalAccessPolicyError('session_approval_expired', 'the excerpt approval has expired');
  }
  for (const [field, maximum] of [['maxLines', 200], ['maxTurns', 20], ['maxBytes', 256 * 1024]]) {
    if (!Number.isInteger(approval[field]) || approval[field] < 1 || approval[field] > maximum) {
      throw new LocalAccessPolicyError('session_approval_invalid', `excerpt approval ${field} is invalid`);
    }
  }
  if (input.max_lines > approval.maxLines || input.max_turns > approval.maxTurns || input.max_bytes > approval.maxBytes) {
    throw new LocalAccessPolicyError('session_approval_scope', 'the requested excerpt exceeds the separately approved bounds');
  }
  usedApprovals.add(approvalKey);
  return approval;
}

function sanitizeExcerptEvent(event, line, turn, approval) {
  const kind = eventKind(event);
  const role = eventRole(event);
  const rawText = eventText(event);
  let text = null;
  let redacted = false;
  if (rawText !== null) {
    if (HIDDEN_EVENT_KINDS.test(kind)) {
      text = '<redacted-tool-output>';
      redacted = true;
    } else if (PROMPT_EVENT_KINDS.test(kind) || ['user', 'system', 'developer'].includes(role)) {
      text = '<redacted-prompt>';
      redacted = true;
    } else if (role === 'assistant' && approval.allowAssistantText === true) {
      text = redactLocalText(rawText).slice(0, 4000);
      redacted = text !== rawText;
    } else {
      text = '<redacted-session-text>';
      redacted = true;
    }
  }
  return { line, turn, kind, timestamp: eventTimestamp(event), role, text, redacted };
}

function selectExcerpt(events, input, approval) {
  const selected = [];
  let turn = 0;
  let outputBytes = 0;
  let scannedBytes = 0;
  for (let index = 0; index < events.length; index += 1) {
    const line = index + 1;
    const kind = eventKind(events[index]);
    if (/turn_context|user_message/i.test(kind)) turn += 1;
    if (turn === 0) turn = 1;
    const serializedBytes = Buffer.byteLength(JSON.stringify(events[index]));
    scannedBytes += serializedBytes;
    if (line < input.start_line || turn < input.start_turn) continue;
    if (turn >= input.start_turn + input.max_turns || selected.length >= input.max_lines) break;
    const safe = sanitizeExcerptEvent(events[index], line, turn, approval);
    const safeBytes = Buffer.byteLength(JSON.stringify(safe));
    if (outputBytes + safeBytes > input.max_bytes) break;
    outputBytes += safeBytes;
    selected.push(safe);
  }
  return { selected, outputBytes, scannedBytes };
}

export function registerCodexSessionTools(server, deps = {}) {
  const authority = deps.authority;
  if (!authority) throw new TypeError('registerCodexSessionTools requires the shared LocalReadGrantAuthority');
  const respond = deps.response ?? ((value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) }));
  const fail = deps.safeError ?? (error => respond({ ok: false, error: error.message, code: error.code ?? 'session_read_failed' }, true));
  const toolAnnotations = deps.annotations ?? (() => ({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }));
  const usedApprovals = new Set();
  const now = deps.now ?? authority.now ?? (() => Date.now());
  const withSession = callback => async input => {
    try {
      const record = authority.resolve({
        sourceId: input.source_id,
        capability: input.read_capability,
        correlationId: input.correlation_id,
        requiredSourceType: 'codex-sessions'
      });
      return respond(await callback(record, input));
    } catch (error) { return fail(error); }
  };

  server.registerTool('aicc_codex_session_search', {
    title: 'Codex 세션 메타데이터 검색',
    description: '승인된 Codex sessions root에서 UUID/date/cwd/title/status/size/redacted event kinds만 검색합니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_codex_session_search,
    annotations: toolAnnotations()
  }, withSession((record, input) => {
    const exactUuid = UUID.test(input.query.trim()) ? input.query.trim().toLocaleLowerCase('en-US') : null;
    const sessions = buildSessionIndex(authority, record, { sessionUuid: exactUuid });
    const query = (exactUuid ?? input.query).toLocaleLowerCase('en-US');
    const results = sessions.filter(item => [item.session_uuid, item.date, item.cwd, item.title, item.status]
      .filter(Boolean).some(value => String(value).toLocaleLowerCase('en-US').includes(query)))
      .slice(0, input.max_results).map(publicSession);
    return { ok: true, source_id: record.sourceId, results, result_count: results.length, raw_session_cached: false, audit_hash: record.grant.auditHash };
  }));

  server.registerTool('aicc_codex_session_info', {
    title: 'Codex 세션 메타데이터',
    description: '한 Codex session UUID의 redacted metadata만 반환하며 raw JSONL이나 본문을 복제하지 않습니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_codex_session_info,
    annotations: toolAnnotations()
  }, withSession((record, input) => {
    const sessionUuid = input.session_uuid.toLocaleLowerCase('en-US');
    const session = buildSessionIndex(authority, record, { sessionUuid }).find(item => item.session_uuid === sessionUuid);
    if (!session) throw new LocalAccessPolicyError('session_not_found', 'the requested Codex session UUID was not found in the approved root');
    return { ok: true, source_id: record.sourceId, session: publicSession(session), raw_session_cached: false, audit_hash: record.grant.auditHash };
  }));

  server.registerTool('aicc_codex_session_read_excerpt', {
    title: '승인된 Codex 세션 발췌',
    description: '별도 approval_ref로 한 세션의 bounded line/turn/bytes 발췌를 읽고 prompt/tool/command output과 secrets를 redaction합니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_codex_session_read_excerpt,
    annotations: toolAnnotations(false)
  }, withSession(async (record, input) => {
    const normalizedInput = { ...input, session_uuid: input.session_uuid.toLocaleLowerCase('en-US') };
    const approval = await validateExcerptApproval(deps.resolveExcerptApproval, usedApprovals, normalizedInput, record, now);
    const session = buildSessionIndex(authority, record, { sessionUuid: normalizedInput.session_uuid }).find(item => item.session_uuid === normalizedInput.session_uuid);
    if (!session) throw new LocalAccessPolicyError('session_not_found', 'the requested Codex session UUID was not found in the approved root');
    const file = assertGrantedRelativePath(record.grant, session._relativePath, { expect: 'file' });
    const read = readExcerptEvents(file, record.grant);
    const excerpt = selectExcerpt(read.events, normalizedInput, approval);
    if (read.truncated && excerpt.selected.length === 0) {
      throw new LocalAccessPolicyError('local_byte_budget_exceeded', 'the requested excerpt starts beyond the approved bounded scan');
    }
    authority.consume(record, { files: 1, bytes: read.bytes });
    return {
      ok: true,
      source_id: record.sourceId,
      session_uuid: normalizedInput.session_uuid,
      bounds: { start_line: input.start_line, max_lines: input.max_lines, start_turn: input.start_turn, max_turns: input.max_turns, max_bytes: input.max_bytes },
      events: excerpt.selected,
      output_bytes: excerpt.outputBytes,
      raw_jsonl: false,
      raw_prompt: false,
      raw_tool_output: false,
      audit_hash: record.grant.auditHash,
      approval_audit_hash: stableHash(`${record.sourceId}\0${normalizedInput.session_uuid}\0${input.approval_ref}`)
    };
  }));
}

export const __testing = Object.freeze({
  buildSessionIndex,
  eventKind,
  publicSession,
  sanitizeExcerptEvent,
  selectExcerpt,
  sessionMetaFromEvents
});
