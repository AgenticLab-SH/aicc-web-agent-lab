import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeWorkspaceSurfaceProfile,
  WORKSPACE_SURFACE_PROFILES,
  workspaceToolSnapshot
} from '../components/workspace-mcp/tool-manifest.mjs';

// This manifest covers the Workspace provider, not the complete installed gateway.
// Refresh the existing owned app through its supported controls first; create a
// replacement only when the actual app requires an explicitly approved cutover.
// This module records evidence only; it never mutates ChatGPT.
export const CHATGPT_APP_MANAGE_URL = 'https://chatgpt.com/plugins';

const SAVED_CHAT_URL = /^https:\/\/chatgpt\.com\/c\/[a-z0-9-]+(?:[?#].*)?$/i;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function workspacePublishStatePath(options = {}) {
  const stateRoot = options.stateRoot
    ?? process.env.AICC_STATE_ROOT?.trim()
    ?? path.join(os.homedir(), '.ai-control-center');
  const surfaceProfile = normalizeWorkspaceSurfaceProfile(options.surfaceProfile);
  const directory = surfaceProfile === WORKSPACE_SURFACE_PROFILES.BUSINESS_FULL
    ? 'workspace-mcp'
    : `workspace-mcp-${surfaceProfile}`;
  return path.join(stateRoot, directory, 'publish-state.json');
}

function readState(file, surfaceProfile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.schemaVersion === 4) {
      return surfaceProfile === WORKSPACE_SURFACE_PROFILES.BUSINESS_FULL ? parsed : null;
    }
    return parsed?.schemaVersion === 5 && parsed.surfaceProfile === surfaceProfile ? parsed : null;
  } catch { return null; }
}

function uniqueStrings(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} 배열이 필요합니다.`);
  const result = value.map(item => String(item ?? '').trim());
  if (result.some(item => !item) || new Set(result).size !== result.length) {
    throw new Error(`${label}에는 비어 있지 않은 고유 값만 허용됩니다.`);
  }
  return result;
}

function validateAccountCanaries(options, status) {
  const requiredAccountAliases = uniqueStrings(options.requiredAccountAliases, 'requiredAccountAliases');
  if (requiredAccountAliases.length < 1) throw new Error('requiredAccountAliases cannot be empty.');
  const canaries = Array.isArray(options.accountCanaries) ? options.accountCanaries : [];
  const aliases = canaries.map(item => String(item?.accountAlias ?? '').trim());
  if (new Set(aliases).size !== aliases.length) throw new Error('계정별 canary alias는 중복될 수 없습니다.');
  const missingAccounts = requiredAccountAliases.filter(alias => !aliases.includes(alias));
  const unexpectedAccounts = aliases.filter(alias => !requiredAccountAliases.includes(alias));
  if (missingAccounts.length || unexpectedAccounts.length) {
    throw new Error(`계정별 canary 범위가 정확하지 않습니다: missing=${missingAccounts.join(',') || '-'} unexpected=${unexpectedAccounts.join(',') || '-'}`);
  }
  const requiredTools = status.manifest.tools.map(tool => tool.name);
  const writeTools = status.manifest.tools.filter(tool => tool.mode === 'write').map(tool => tool.name);
  return requiredAccountAliases.map(accountAlias => {
    const canary = canaries.find(item => item.accountAlias === accountAlias);
    const workspaceAlias = String(canary.workspaceAlias ?? '').trim();
    if (!workspaceAlias) throw new Error(`${accountAlias} canary workspaceAlias가 필요합니다.`);
    const conversationUrl = String(canary.conversationUrl ?? '').trim();
    if (!SAVED_CHAT_URL.test(conversationUrl)) throw new Error(`${accountAlias} canary는 저장된 /c/ 대화 URL이어야 합니다.`);
    if (canary.appId !== options.appId || canary.appVersionId !== options.appVersionId) {
      throw new Error(`${accountAlias} canary 앱 릴리스가 게시 기록과 정확히 일치해야 합니다.`);
    }
    if (canary.manifestHash !== status.manifest.hash) {
      throw new Error(`${accountAlias} canary manifest hash가 현재 ${status.manifest.toolCount}개 도구 계약과 일치하지 않습니다.`);
    }
    if (canary.status !== 'pass') throw new Error(`${accountAlias} canary status=pass 증거가 필요합니다.`);
    if (typeof canary.verifiedAt !== 'string' || !RFC3339_UTC.test(canary.verifiedAt)
      || !Number.isFinite(Date.parse(canary.verifiedAt))) {
      throw new Error(`${accountAlias} canary verifiedAt은 RFC3339 UTC여야 합니다.`);
    }
    const toolResults = Array.isArray(canary.toolResults) ? canary.toolResults : [];
    const resultNames = toolResults.map(item => String(item?.name ?? '').trim());
    if (new Set(resultNames).size !== resultNames.length
      || requiredTools.some(name => !resultNames.includes(name))
      || resultNames.some(name => !requiredTools.includes(name))
      || toolResults.some(item => item.status !== 'pass')) {
      throw new Error(`${accountAlias} canary는 현재 manifest의 ${requiredTools.length}개 도구 모두에 대한 pass 증거가 필요합니다.`);
    }
    const rollbackVerifiedTools = uniqueStrings(canary.rollbackVerifiedTools, `${accountAlias}.rollbackVerifiedTools`);
    if (writeTools.some(name => !rollbackVerifiedTools.includes(name))
      || rollbackVerifiedTools.some(name => !writeTools.includes(name))) {
      throw new Error(`${accountAlias} canary는 현재 ${writeTools.length}개 쓰기 도구 모두의 rollback 검증이 필요합니다.`);
    }
    return {
      accountAlias,
      workspaceAlias,
      conversationUrl,
      appId: canary.appId,
      appVersionId: canary.appVersionId,
      manifestHash: canary.manifestHash,
      status: 'pass',
      toolResults: requiredTools.map(name => ({ name, status: 'pass' })),
      rollbackVerifiedTools: [...writeTools],
      verifiedAt: new Date(canary.verifiedAt).toISOString()
    };
  });
}

export function workspacePublicationStatus(options = {}) {
  const surfaceProfile = normalizeWorkspaceSurfaceProfile(options.surfaceProfile);
  const manifest = workspaceToolSnapshot({ ...options, surfaceProfile });
  const stateFile = workspacePublishStatePath(options);
  const published = readState(stateFile, surfaceProfile);
  return {
    surfaceProfile,
    manifest,
    capabilities: manifest.capabilities,
    published: published ? {
      surfaceProfile: published.surfaceProfile ?? WORKSPACE_SURFACE_PROFILES.BUSINESS_FULL,
      appName: published.appName ?? null,
      appId: published.appId ?? null,
      appVersionId: published.appVersionId ?? null,
      workspaceName: published.workspaceName ?? null,
      tunnelId: published.tunnelId ?? null,
      toolCount: Number(published.toolCount ?? 0),
      manifestHash: published.manifestHash ?? null,
      publisherAccountAlias: published.publisherAccountAlias ?? null,
      requiredAccountAliases: Array.isArray(published.requiredAccountAliases) ? published.requiredAccountAliases : [],
      accountCanaries: Array.isArray(published.accountCanaries) ? published.accountCanaries : [],
      discoverability: published.discoverability ?? null,
      riskReviewSections: Array.isArray(published.riskReviewSections) ? published.riskReviewSections : [],
      riskReviewCheckboxes: Array.isArray(published.riskReviewCheckboxes) ? published.riskReviewCheckboxes : [],
      replacementOfAppId: published.replacementOfAppId ?? null,
      verifiedAt: published.verifiedAt ?? null
    } : null,
    needsPublish: !published || published.manifestHash !== manifest.hash,
    manageUrl: CHATGPT_APP_MANAGE_URL,
    stateFile
  };
}

export function recordWorkspacePublication(options = {}) {
  const appName = String(options.appName ?? '').trim();
  if (!appName) throw new Error('검증된 ChatGPT 앱 이름이 필요합니다.');
  const appId = String(options.appId ?? '').trim();
  if (!/^asdk_app_[a-z0-9]+$/i.test(appId)) throw new Error('검증된 ChatGPT app ID가 필요합니다.');
  const appVersionId = String(options.appVersionId ?? '').trim();
  if (!/^asdk_app_v_[a-z0-9]+$/i.test(appVersionId)) throw new Error('검증된 ChatGPT app version ID가 필요합니다.');
  const workspaceName = String(options.workspaceName ?? '').trim();
  if (!workspaceName) throw new Error('검증된 ChatGPT 게시 대상 이름이 필요합니다.');
  const tunnelId = String(options.tunnelId ?? '').trim();
  if (!/^tunnel_[a-z0-9]+$/i.test(tunnelId)) throw new Error('검증된 Secure MCP Tunnel ID가 필요합니다.');
  const publisherAccountAlias = String(options.publisherAccountAlias ?? '').trim();
  if (!publisherAccountAlias) throw new Error('게시를 실행한 검증된 계정 alias가 필요합니다.');
  const discoverability = String(options.discoverability ?? '').trim();
  if (!['workspace_directory', 'workspace_link', 'invite_only'].includes(discoverability)) {
    throw new Error('검증된 앱 공개 범위가 필요합니다.');
  }
  const riskReviewSections = [...new Set((options.riskReviewSections ?? [])
    .map(value => String(value).replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const riskReviewCheckboxes = (options.riskReviewCheckboxes ?? [])
    .map(value => String(value).replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (statusManifestWriteToolCount(options) > 0 && riskReviewSections.length < 1) {
    throw new Error('쓰기 도구가 있는 앱은 잠재적 위험 검토 섹션 증거가 필요합니다.');
  }
  if (riskReviewCheckboxes.length < riskReviewSections.length) {
    throw new Error('각 잠재적 위험 검토 섹션의 체크박스 증거가 필요합니다.');
  }
  if (options.riskReviewStatus !== 'pass') throw new Error('riskReviewStatus=pass 증거가 필요합니다.');
  const replacementOfAppId = String(options.replacementOfAppId ?? '').trim() || null;
  if (replacementOfAppId && !/^asdk_app_[a-z0-9]+$/i.test(replacementOfAppId)) {
    throw new Error('replacement app ID 형식이 올바르지 않습니다.');
  }
  const status = workspacePublicationStatus(options);
  const accountCanaries = validateAccountCanaries(options, status);
  const requiredAccountAliases = accountCanaries.map(canary => canary.accountAlias);
  if (!requiredAccountAliases.includes(publisherAccountAlias)) {
    throw new Error('게시 계정 alias가 계정별 canary 증거에 포함되어야 합니다.');
  }
  const file = status.stateFile;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const payload = {
    schemaVersion: 5,
    surfaceProfile: status.surfaceProfile,
    appName,
    appId,
    appVersionId,
    workspaceName,
    tunnelId,
    toolCount: status.manifest.toolCount,
    manifestHash: status.manifest.hash,
    publisherAccountAlias,
    requiredAccountAliases,
    accountCanaries,
    discoverability,
    riskReviewSections,
    riskReviewCheckboxes,
    riskReviewStatus: 'pass',
    replacementOfAppId,
    verifiedAt: new Date().toISOString()
  };
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return workspacePublicationStatus(options);
}

function statusManifestWriteToolCount(options = {}) {
  return workspaceToolSnapshot(options).writeToolCount;
}
