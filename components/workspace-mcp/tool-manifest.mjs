import { createHash } from 'node:crypto';
import { workspaceMcpInputContract } from './input-schemas.mjs';

export const WORKSPACE_SURFACE_PROFILES = Object.freeze({
  BUSINESS_FULL: 'business-full',
  PERSONAL_READ_FETCH: 'personal-read-fetch'
});

export const WORKSPACE_MCP_TOOLS = Object.freeze([
  { name: 'aicc_workspace_list', title: '워크스페이스 목록', mode: 'read' },
  { name: 'aicc_workspace_open', title: '워크스페이스 열기', mode: 'write' },
  { name: 'aicc_workspace_close', title: '워크스페이스 닫기', mode: 'read' },
  { name: 'aicc_workspace_info', title: '워크스페이스 개요', mode: 'read' },
  { name: 'aicc_workspace_read', title: '파일 읽기', mode: 'read' },
  { name: 'aicc_workspace_read_many', title: '여러 파일 읽기', mode: 'read' },
  { name: 'aicc_workspace_search', title: '파일·본문 검색', mode: 'read' },
  { name: 'aicc_workspace_changes', title: 'Git 변경 검토', mode: 'read' },
  { name: 'aicc_skill_inventory', title: 'AICC 스킬 목록', mode: 'read' },
  { name: 'aicc_skill_read', title: 'AICC 스킬 읽기', mode: 'read' },
  { name: 'aicc_workspace_apply_patch', title: '패치 적용', mode: 'write' },
  { name: 'aicc_workspace_exec', title: '명령 실행', mode: 'write' },
  { name: 'aicc_workspace_write_stdin', title: '명령 입력·폴링', mode: 'write' },
  { name: 'aicc_workspace_process_stop', title: '명령 중지', mode: 'write' },
  { name: 'aicc_local_source_list', title: '승인된 로컬 디렉터리 목록', mode: 'read' },
  { name: 'aicc_local_source_open_read', title: '승인된 로컬 읽기 열기', mode: 'read' },
  { name: 'aicc_local_source_search', title: '승인된 로컬 소스 검색', mode: 'read' },
  { name: 'aicc_local_source_read', title: '승인된 로컬 파일 읽기', mode: 'read' },
  { name: 'aicc_codex_session_search', title: 'Codex 세션 메타데이터 검색', mode: 'read' },
  { name: 'aicc_codex_session_info', title: 'Codex 세션 메타데이터', mode: 'read' },
  { name: 'aicc_codex_session_read_excerpt', title: '승인된 Codex 세션 발췌', mode: 'read' },
  { name: 'aicc_local_source_close', title: '로컬 읽기 닫기', mode: 'read' }
]);

export const WORKSPACE_WEB_MANAGEMENT_TOOLS = Object.freeze([
  { name: 'aicc_web_management_start', title: '승인된 Web 자산 관리 실행', mode: 'write' },
  { name: 'aicc_web_management_status', title: 'Web 자산 관리 결과', mode: 'read' }
]);
export const WORKSPACE_CODEX_CLI_TOOLS = Object.freeze([
  { name: 'aicc_codex_cli_start', title: 'Native·OCX Codex CLI 작업 접수', mode: 'write' },
  { name: 'aicc_codex_cli_status', title: 'Codex CLI 원 작업 결과', mode: 'read' }
]);
export const WORKSPACE_GPT_QUEUE_TOOLS = Object.freeze([
  {name:'aicc_gpt_queue_register',title:'원 소유자 고정 작업 일시중지 등록',mode:'write'},
  {name:'aicc_gpt_queue_list',title:'원 소유자 큐 목록',mode:'read'},
  {name:'aicc_gpt_queue_get',title:'원 작업 상태와 증거 조회',mode:'read'},
  {name:'aicc_gpt_queue_cancel',title:'미발신 원 작업 취소',mode:'write'},
  {name:'aicc_gpt_queue_activate',title:'원 소유자 등록 작업 실행 승인',mode:'write'}
]);
const PERSONAL_EXCLUDED_TOOLS = new Set([
  'aicc_workspace_apply_patch',
  'aicc_workspace_exec',
  'aicc_workspace_write_stdin',
  'aicc_workspace_process_stop'
]);

const COMMAND_TOOLS = new Set([
  'aicc_workspace_exec',
  'aicc_workspace_write_stdin',
  'aicc_workspace_process_stop'
]);

export function normalizeWorkspaceSurfaceProfile(value) {
  const profile = value ?? WORKSPACE_SURFACE_PROFILES.BUSINESS_FULL;
  if (!Object.values(WORKSPACE_SURFACE_PROFILES).includes(profile)) {
    throw new Error(`지원하지 않는 Workspace MCP surface profile입니다: ${profile}`);
  }
  return profile;
}

export function workspaceHostCapabilities(options = {}) {
  const surfaceProfile = normalizeWorkspaceSurfaceProfile(options.surfaceProfile);
  const platform = options.platform ?? process.platform;
  const businessFull = surfaceProfile === WORKSPACE_SURFACE_PROFILES.BUSINESS_FULL;
  const commandSandboxAvailable = options.commandSandboxAvailable
    ?? platform === 'darwin';
  const commands = businessFull && commandSandboxAvailable === true;
  return Object.freeze({
    platform,
    commands,
    network: commands
  });
}

export function workspaceCommandSandboxAvailable(config = {}, options = {}) {
  if (options.commandSandboxAvailable !== undefined) return options.commandSandboxAvailable === true;
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') return true;
  return platform === 'win32' && config.permissions?.commandIsolation === 'owner-unrestricted-windows';
}

export function workspacePermissionsForHost(permissions = {}, options = {}) {
  const capabilities = workspaceHostCapabilities(options);
  return {
    ...permissions,
    commands: permissions.commands === true && capabilities.commands,
    network: permissions.network === true && capabilities.network
  };
}

export function workspaceExecutionBoundaryForHost(executionBoundary, permissions) {
  if (!executionBoundary || typeof executionBoundary !== 'object') return executionBoundary ?? null;
  let externalWorkspaceTools = executionBoundary.externalWorkspaceTools;
  if (typeof externalWorkspaceTools === 'string') {
    if (permissions.commands !== true) externalWorkspaceTools = externalWorkspaceTools.replace('-terminal', '');
    if (permissions.network !== true) externalWorkspaceTools = externalWorkspaceTools.replace('-network', '');
  }
  return { ...executionBoundary, externalWorkspaceTools };
}

export function workspaceToolsForProfile(value, options = {}) {
  const surfaceProfile = normalizeWorkspaceSurfaceProfile(value);
  const capabilities = workspaceHostCapabilities({ ...options, surfaceProfile });
  let tools = options.webManagementAvailable === true && surfaceProfile === WORKSPACE_SURFACE_PROFILES.BUSINESS_FULL
    ? [...WORKSPACE_MCP_TOOLS, ...WORKSPACE_WEB_MANAGEMENT_TOOLS] : WORKSPACE_MCP_TOOLS;
  if (options.codexCliAvailable === true && surfaceProfile === WORKSPACE_SURFACE_PROFILES.BUSINESS_FULL
    && (options.platform ?? process.platform) === 'win32') tools = [...tools, ...WORKSPACE_CODEX_CLI_TOOLS];
  if (options.gptQueueAvailable === true && surfaceProfile === WORKSPACE_SURFACE_PROFILES.BUSINESS_FULL)
    tools = [...tools,...WORKSPACE_GPT_QUEUE_TOOLS];
  return tools
    .filter(tool => surfaceProfile === WORKSPACE_SURFACE_PROFILES.BUSINESS_FULL
      || !PERSONAL_EXCLUDED_TOOLS.has(tool.name))
    .filter(tool => capabilities.commands || !COMMAND_TOOLS.has(tool.name))
    .map(tool => surfaceProfile === WORKSPACE_SURFACE_PROFILES.PERSONAL_READ_FETCH
      && tool.name === 'aicc_workspace_open' ? { ...tool, mode: 'read' } : tool);
}

export function workspaceToolSnapshot(options = {}) {
  const surfaceProfile = normalizeWorkspaceSurfaceProfile(options.surfaceProfile);
  const capabilities = workspaceHostCapabilities({ ...options, surfaceProfile });
  const tools = workspaceToolsForProfile(surfaceProfile, options).map(tool => ({
    ...tool,
    inputSchema: workspaceMcpInputContract(tool.name, { surfaceProfile })
  }));
  const hashInput = capabilities.commands && capabilities.network
    ? { surfaceProfile, tools }
    : { surfaceProfile, capabilities: { commands: capabilities.commands, network: capabilities.network }, tools };
  const hash = createHash('sha256').update(JSON.stringify(hashInput)).digest('hex');
  return {
    schemaVersion: 4,
    surfaceProfile,
    capabilities: { commands: capabilities.commands, network: capabilities.network },
    toolCount: tools.length,
    readToolCount: tools.filter(tool => tool.mode === 'read').length,
    writeToolCount: tools.filter(tool => tool.mode === 'write').length,
    hash,
    tools
  };
}
