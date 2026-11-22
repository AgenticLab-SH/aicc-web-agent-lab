import * as z from 'zod/v4';

const id = () => z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
const leaseFields = () => ({
  workspace_id: z.string().regex(/^ws_[a-f0-9]{24}$/),
  lease: z.string().regex(/^remote_cap_[a-f0-9]{64}$/)
});
const writeLeaseFields = () => ({ ...leaseFields(), request_id: id() });
const localReadFields = () => ({
  source_id: z.string().regex(/^local_source_[a-f0-9]{24}$/),
  read_capability: z.string().regex(/^local_read_cap_[a-f0-9]{64}$/),
  correlation_id: id()
});

export const WORKSPACE_MCP_INPUT_SCHEMAS = Object.freeze({
  aicc_workspace_list: {},
  aicc_workspace_open: {
    alias: z.string().min(1).max(128),
    mode: z.enum(['read-only', 'write']).optional(),
    correlation_id: id(),
    approval_ref: id().nullable().default(null),
    job_id: id().nullable().default(null),
    attempt_id: id().nullable().default(null),
    expires_in_seconds: z.number().int().min(1).max(7200).nullable().default(null)
  },
  aicc_workspace_close: leaseFields(),
  aicc_workspace_info: leaseFields(),
  aicc_workspace_read: {
    ...leaseFields(),
    path: z.string().min(1),
    start_line: z.number().int().min(1).default(1),
    max_lines: z.number().int().min(1).max(2000).default(400),
    offset_bytes: z.number().int().min(0).nullable().default(null).describe('다음 페이지에는 이전 응답의 next_offset_bytes를 넣으세요. null이면 기존 start_line으로 시작합니다.'),
    max_bytes: z.number().int().min(1).max(1_048_576).default(65_536).describe('한 응답의 원본 byte 예산입니다. 전체 파일 크기 제한이 아닙니다. 최대 1MiB이며 계속 이어 읽을 수 있습니다.'),
    encoding: z.enum(['auto', 'utf8', 'utf16le', 'utf16be', 'base64']).default('auto').describe('auto는 BOM/문자 바이트를 판별합니다. 바이너리·지원하지 않는 인코딩은 data_base64로 반환합니다. 바이너리는 base64로 요청할 수 있습니다.'),
    file_version: z.string().max(200).nullable().default(null).describe('이어 읽을 때 이전 file_version을 보내면 중간 파일 변경을 감지합니다.')
  },
  aicc_workspace_read_many: {
    ...leaseFields(),
    paths: z.array(z.string().min(1)).min(1).max(20),
    max_lines_each: z.number().int().min(1).max(1000).default(250),
    max_bytes_each: z.number().int().min(1).max(1_048_576).default(65_536).describe('파일별 첫 페이지 byte 예산. 나머지는 read에 path/next_offset_bytes/file_version을 보내 읽습니다.'),
    max_total_bytes: z.number().int().min(1).max(1_048_576).default(65_536).describe('이번 응답의 총 byte 예산. 파일 전체 합계 제한이 아닙니다.'),
    start_path_index: z.number().int().min(0).max(19).default(0).describe('next_path_index가 null이 아니면 같은 paths와 해당 index로 남은 파일의 첫 페이지를 읽습니다.'),
    encoding: z.enum(['auto', 'utf8', 'utf16le', 'utf16be', 'base64']).default('auto').describe('auto는 BOM/문자 바이트를 판별합니다. 바이너리·지원하지 않는 인코딩은 data_base64로 반환합니다. 바이너리는 base64로 요청할 수 있습니다.')
  },
  aicc_workspace_search: {
    ...leaseFields(),
    query: z.string().min(1).max(500),
    path: z.string().default('.'),
    files_only: z.boolean().default(false),
    max_results: z.number().int().min(1).max(500).default(100)
  },
  aicc_workspace_changes: leaseFields(),
  aicc_skill_inventory: leaseFields(),
  aicc_skill_read: {
    ...leaseFields(),
    skill_id: z.string().min(1).max(200),
    path: z.string().default('SKILL.md')
  },
  aicc_workspace_apply_patch: {
    ...writeLeaseFields(),
    patch: z.string().min(1).max(2_000_000)
  },
  aicc_workspace_exec: {
    ...writeLeaseFields(),
    command: z.string().min(1).max(20_000),
    yield_time_ms: z.number().int().min(50).max(10_000).default(1_000)
  },
  aicc_workspace_write_stdin: {
    ...writeLeaseFields(),
    session_id: z.string().regex(/^proc_[a-f0-9]{32}$/),
    chars: z.string().max(100_000).default(''),
    output_cursor: z.number().int().min(0).default(0)
  },
  aicc_workspace_process_stop: {
    ...writeLeaseFields(),
    session_id: z.string().regex(/^proc_[a-f0-9]{32}$/)
  },
  aicc_codex_cli_start: {
    ...writeLeaseFields(),
    operation_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/),
    route: z.enum(['native', 'ocx']),
    model: z.string().min(1).max(128),
    reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh']),
    prompt_path: z.string().min(1).max(1024),
    prompt_sha256: z.string().regex(/^[a-f0-9]{64}$/)
  },
  aicc_codex_cli_status: {
    ...leaseFields(),
    operation_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/)
  },
  aicc_gpt_queue_register: {
    ...writeLeaseFields(),
    title:z.string().min(1).max(140),
    roles:z.array(z.object({
      id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/),
      slot:z.enum(['9222','9223']),
      targetNonce:z.string().regex(/^[a-f0-9]{64}$/),
      conversationId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,126}$/),
      prompt:z.string().min(1).max(4000)
    }).strict()).length(2)
  },
  aicc_gpt_queue_list: leaseFields(),
  aicc_gpt_queue_get: {...leaseFields(),operation_id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/)},
  aicc_gpt_queue_cancel: {...writeLeaseFields(),operation_id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/)},
  aicc_gpt_queue_activate: {...writeLeaseFields(),operation_id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/),expected_revision:z.number().int().min(0)},
  aicc_web_management_start: {
    ...writeLeaseFields(),
    request_path: z.string().min(1).max(1024),
    request_sha256: z.string().regex(/^[a-f0-9]{64}$/)
  },
  aicc_web_management_status: {
    ...leaseFields(),
    operation_id: id()
  },
  aicc_local_source_list: {
    ...localReadFields(),
    path: z.string().min(1).default('.'),
    max_entries: z.number().int().min(1).max(1000).default(200)
  },
  aicc_local_source_open_read: {
    grant_ref: z.string().regex(/^local_grant_[A-Za-z0-9_-]{16,96}$/),
    correlation_id: id(),
    expires_in_seconds: z.number().int().min(1).max(3600).nullable().default(null)
  },
  aicc_local_source_search: {
    ...localReadFields(),
    query: z.string().min(1).max(500),
    path: z.string().min(1).default('.'),
    case_sensitive: z.boolean().default(false),
    max_results: z.number().int().min(1).max(500).default(100),
    max_files: z.number().int().min(1).max(5000).default(500),
    max_bytes: z.number().int().min(1).max(16 * 1024 * 1024).default(1024 * 1024),
    max_snippets_per_file: z.number().int().min(0).max(20).default(3)
  },
  aicc_local_source_read: {
    ...localReadFields(),
    path: z.string().min(1),
    start_line: z.number().int().min(1).default(1),
    max_lines: z.number().int().min(1).max(2000).default(400),
    max_bytes: z.number().int().min(1).max(16 * 1024 * 1024).default(1024 * 1024)
  },
  aicc_codex_session_search: {
    ...localReadFields(),
    query: z.string().min(1).max(500),
    max_results: z.number().int().min(1).max(200).default(50)
  },
  aicc_codex_session_info: {
    ...localReadFields(),
    session_uuid: z.string().uuid()
  },
  aicc_codex_session_read_excerpt: {
    ...localReadFields(),
    session_uuid: z.string().uuid(),
    approval_ref: id(),
    start_line: z.number().int().min(1).default(1),
    max_lines: z.number().int().min(1).max(200).default(40),
    start_turn: z.number().int().min(1).default(1),
    max_turns: z.number().int().min(1).max(20).default(3),
    max_bytes: z.number().int().min(1).max(256 * 1024).default(32 * 1024)
  },
  aicc_local_source_close: localReadFields()
});

const PERSONAL_READ_FETCH_OPEN_SCHEMA = Object.freeze({
  alias: z.string().min(1).max(128),
  mode: z.literal('read-only').optional(),
  correlation_id: id(),
  expires_in_seconds: z.number().int().min(1).max(7200).nullable().default(null)
});

export function workspaceMcpInputSchema(name, options = {}) {
  if (name === 'aicc_workspace_open' && options.surfaceProfile === 'personal-read-fetch') {
    return PERSONAL_READ_FETCH_OPEN_SCHEMA;
  }
  const inputSchema = WORKSPACE_MCP_INPUT_SCHEMAS[name];
  if (!inputSchema) throw new Error(`알 수 없는 AICC Workspace 도구입니다: ${name}`);
  return inputSchema;
}

export function workspaceMcpInputContract(name, options = {}) {
  const inputSchema = workspaceMcpInputSchema(name, options);
  const { $schema: _schema, ...contract } = z.toJSONSchema(z.object(inputSchema));
  return contract;
}
