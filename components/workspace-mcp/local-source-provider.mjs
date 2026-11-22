import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE_MCP_INPUT_SCHEMAS } from './input-schemas.mjs';
import { LocalReadGrantAuthority } from './local-read-grant-authority.mjs';
import {
  LocalAccessPolicyError,
  assertGrantedRelativePath,
  contentDisposition,
  mapFilesystemError,
  redactLocalText,
  stableHash
} from './local-access-policy.mjs';
import { registerCodexSessionTools } from './codex-session-provider.mjs';

function response(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {})
  };
}

function safeError(error) {
  const normalized = error instanceof LocalAccessPolicyError
    ? error
    : mapFilesystemError(error, 'approved local source read failed');
  return response({ ok: false, error: normalized.message, code: normalized.code }, true);
}

function annotations(idempotent = true) {
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false };
}

function relativeJoin(parent, child) {
  return parent === '.' ? child : `${parent}/${child}`;
}

function publicMetadata(relativePath, stat, disposition = null) {
  const resolved = disposition ?? (stat.isDirectory() ? { kind: 'directory', contentMode: 'metadata-only' } : contentDisposition(relativePath));
  return {
    path: relativePath,
    kind: resolved.kind,
    content_mode: resolved.contentMode,
    size_bytes: stat.size,
    modified_at: new Date(stat.mtimeMs).toISOString()
  };
}

function listSource(authority, record, input) {
  const directory = assertGrantedRelativePath(record.grant, input.path, { expect: 'directory' });
  const entries = [];
  let examined = 0;
  try {
    for (const entry of fs.readdirSync(directory.path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= input.max_entries) break;
      if (entry.isSymbolicLink()) continue;
      examined += 1;
      const relativePath = relativeJoin(directory.relativePath, entry.name);
      try {
        const resolved = assertGrantedRelativePath(record.grant, relativePath);
        entries.push(publicMetadata(relativePath, resolved.stat));
      } catch (error) {
        if (error instanceof LocalAccessPolicyError && ['local_path_not_granted', 'local_sensitive_path_denied', 'HOLD_TCC'].includes(error.code)) continue;
        throw error;
      }
    }
  } catch (error) { throw mapFilesystemError(error, 'approved local directory listing failed'); }
  authority.consume(record, { files: examined });
  return {
    ok: true,
    source_id: record.sourceId,
    path: directory.relativePath,
    entries,
    truncated: entries.length >= input.max_entries,
    audit_hash: record.grant.auditHash
  };
}

function readSource(authority, record, input) {
  const file = assertGrantedRelativePath(record.grant, input.path, { expect: 'file' });
  const disposition = contentDisposition(file.path);
  if (disposition.contentMode === 'metadata-only') {
    authority.consume(record, { files: 1 });
    return {
      ok: true,
      source_id: record.sourceId,
      ...publicMetadata(file.relativePath, file.stat, disposition),
      content: null,
      redacted: true,
      audit_hash: record.grant.auditHash
    };
  }
  if (file.stat.size > record.grant.budgets.maxFileBytes || file.stat.size > input.max_bytes) {
    throw new LocalAccessPolicyError('local_file_budget_exceeded', 'the file exceeds the approved per-file or per-call byte budget');
  }
  let buffer;
  try { buffer = fs.readFileSync(file.path); } catch (error) { throw mapFilesystemError(error, 'approved local file read failed'); }
  const detected = contentDisposition(file.path, buffer);
  if (detected.contentMode === 'metadata-only') {
    authority.consume(record, { files: 1, bytes: Math.min(buffer.length, 8192) });
    return {
      ok: true,
      source_id: record.sourceId,
      ...publicMetadata(file.relativePath, file.stat, detected),
      content: null,
      redacted: true,
      audit_hash: record.grant.auditHash
    };
  }
  authority.consume(record, { files: 1, bytes: buffer.length });
  const lines = buffer.toString('utf8').replaceAll('\r\n', '\n').split('\n');
  const start = input.start_line - 1;
  const selected = lines.slice(start, start + input.max_lines);
  const content = redactLocalText(selected.join('\n'));
  return {
    ok: true,
    source_id: record.sourceId,
    path: file.relativePath,
    kind: 'text',
    content_mode: 'redacted-text',
    start_line: input.start_line,
    end_line: start + selected.length,
    content,
    redacted: content !== selected.join('\n'),
    truncated: start + selected.length < lines.length,
    audit_hash: record.grant.auditHash
  };
}

function walkSearchRoot(record, searchRoot, visit, state) {
  const queue = [searchRoot.relativePath];
  while (queue.length && !state.stop) {
    const relativeDirectory = queue.shift();
    const directory = assertGrantedRelativePath(record.grant, relativeDirectory, { expect: 'directory' });
    let entries;
    try { entries = fs.readdirSync(directory.path, { withFileTypes: true }); } catch (error) { throw mapFilesystemError(error, 'approved local search failed'); }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (state.stop) break;
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeJoin(relativeDirectory, entry.name);
      let resolved;
      try { resolved = assertGrantedRelativePath(record.grant, relativePath); }
      catch (error) {
        if (error instanceof LocalAccessPolicyError && ['local_path_not_granted', 'local_sensitive_path_denied', 'HOLD_TCC'].includes(error.code)) continue;
        throw error;
      }
      if (resolved.stat.isDirectory()) queue.push(relativePath);
      else if (resolved.stat.isFile()) visit(resolved, state);
    }
  }
}

function searchSource(authority, record, input) {
  const searchRoot = assertGrantedRelativePath(record.grant, input.path, { expect: 'directory' });
  const query = input.case_sensitive ? input.query : input.query.toLocaleLowerCase('en-US');
  const results = [];
  const state = { files: 0, bytes: 0, matches: 0, stop: false, truncated: false };
  walkSearchRoot(record, searchRoot, (file, current) => {
    if (current.files >= input.max_files || current.matches >= input.max_results) {
      current.stop = true;
      current.truncated = true;
      return;
    }
    current.files += 1;
    const byName = input.case_sensitive ? file.relativePath : file.relativePath.toLocaleLowerCase('en-US');
    const nameMatches = byName.includes(query);
    const disposition = contentDisposition(file.path);
    if (disposition.contentMode === 'metadata-only' || file.stat.size > record.grant.budgets.maxFileBytes) {
      if (nameMatches) {
        results.push({ path: file.relativePath, match_count: 1, snippets: [], content_mode: 'metadata-only' });
        current.matches += 1;
      }
      return;
    }
    if (current.bytes + file.stat.size > input.max_bytes || current.bytes + file.stat.size > record.grant.budgets.maxReadBytes) {
      current.stop = true;
      current.truncated = true;
      return;
    }
    let buffer;
    try { buffer = fs.readFileSync(file.path); } catch (error) { throw mapFilesystemError(error, 'approved local search read failed'); }
    current.bytes += buffer.length;
    if (contentDisposition(file.path, buffer).contentMode === 'metadata-only') return;
    let matchCount = nameMatches ? 1 : 0;
    const snippets = [];
    const lines = buffer.toString('utf8').replaceAll('\r\n', '\n').split('\n');
    for (let index = 0; index < lines.length && current.matches + matchCount < input.max_results; index += 1) {
      const comparable = input.case_sensitive ? lines[index] : lines[index].toLocaleLowerCase('en-US');
      if (!comparable.includes(query)) continue;
      matchCount += 1;
      if (snippets.length < input.max_snippets_per_file) snippets.push({ line: index + 1, text: redactLocalText(lines[index]).slice(0, 500) });
    }
    if (matchCount) {
      results.push({ path: file.relativePath, match_count: matchCount, snippets, content_mode: 'redacted-text' });
      current.matches += matchCount;
    }
    if (current.matches >= input.max_results) {
      current.stop = true;
      current.truncated = true;
    }
  }, state);
  authority.consume(record, { files: state.files, bytes: state.bytes, matches: state.matches });
  return {
    ok: true,
    source_id: record.sourceId,
    query_hash: stableHash(input.query),
    path: searchRoot.relativePath,
    results,
    match_count: state.matches,
    scanned_files: state.files,
    scanned_bytes: state.bytes,
    truncated: state.truncated,
    audit_hash: record.grant.auditHash
  };
}

export function registerLocalAccessTools(server, deps = {}) {
  if (!server?.registerTool) throw new TypeError('registerLocalAccessTools requires an MCP server');
  const authority = deps.authority ?? new LocalReadGrantAuthority({ resolveGrant: deps.resolveGrant, now: deps.now, maximumTtlMs: deps.maximumTtlMs });
  const withLocal = (sourceType, callback) => async input => {
    try {
      const record = authority.resolve({
        sourceId: input.source_id,
        capability: input.read_capability,
        correlationId: input.correlation_id,
        requiredSourceType: sourceType
      });
      return response(await callback(authority, record, input));
    } catch (error) { return safeError(error); }
  };

  server.registerTool('aicc_local_source_open_read', {
    title: '승인된 로컬 읽기 열기',
    description: 'AICC 로컬 UI가 미리 만든 exact-root grant_ref만 소비해 메모리 전용 read capability를 엽니다. 경로나 쓰기 권한을 입력받지 않습니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_local_source_open_read,
    annotations: annotations(false)
  }, async input => {
    try {
      const opened = await authority.openRead({ grantRef: input.grant_ref, correlationId: input.correlation_id, expiresInSeconds: input.expires_in_seconds });
      return response({ ok: true, source_id: opened.source.sourceId, read_capability: opened.capability, ...opened.source });
    } catch (error) { return safeError(error); }
  });

  server.registerTool('aicc_local_source_list', {
    title: '승인된 로컬 디렉터리 목록',
    description: '열린 exact-root local source 안의 승인된 상대 경로만 나열하고 민감 경로와 symlink를 숨깁니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_local_source_list,
    annotations: annotations()
  }, withLocal('local', (activeAuthority, record, input) => listSource(activeAuthority, record, input)));

  server.registerTool('aicc_local_source_search', {
    title: '승인된 로컬 소스 검색',
    description: '승인 범위 안에서만 검색하고 상대 경로, match count, redacted snippet만 반환합니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_local_source_search,
    annotations: annotations()
  }, withLocal('local', (activeAuthority, record, input) => searchSource(activeAuthority, record, input)));

  server.registerTool('aicc_local_source_read', {
    title: '승인된 로컬 파일 읽기',
    description: '승인 범위의 text만 bounded/redacted 형태로 읽습니다. binary/archive/database는 metadata-only입니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_local_source_read,
    annotations: annotations()
  }, withLocal('local', (activeAuthority, record, input) => readSource(activeAuthority, record, input)));

  server.registerTool('aicc_local_source_close', {
    title: '로컬 읽기 닫기',
    description: '메모리 전용 read capability를 즉시 무효화합니다.',
    inputSchema: WORKSPACE_MCP_INPUT_SCHEMAS.aicc_local_source_close,
    annotations: annotations(false)
  }, async input => {
    try {
      return response({ ok: true, ...authority.close({ sourceId: input.source_id, capability: input.read_capability, correlationId: input.correlation_id }) });
    } catch (error) { return safeError(error); }
  });

  registerCodexSessionTools(server, { ...deps, authority, response, safeError, annotations });
  return { authority };
}

export const __testing = Object.freeze({ listSource, readSource, searchSource, publicMetadata });
