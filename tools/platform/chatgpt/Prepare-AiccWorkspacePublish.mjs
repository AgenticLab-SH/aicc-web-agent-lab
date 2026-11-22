#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readInstalledGatewayRegistration, readManagementOverview } from '../../../src/management-overview.mjs';
import { recordWorkspacePublication, workspacePublicationStatus } from '../../../src/workspace-publish.mjs';
import { workspaceMcpStatus } from '../../../src/workspace-mcp.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const surfaceProfile = args.includes('--personal-read-fetch') ? 'personal-read-fetch' : 'business-full';
const valueFor = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const evidenceFile = valueFor('--record-evidence');
if (args.includes('--mark-published')) {
  throw new Error('--mark-published scattered flags are no longer accepted; use --record-evidence with one reviewed JSON artifact.');
}
const evidence = evidenceFile ? (() => {
  if (!path.isAbsolute(evidenceFile)) throw new Error('--record-evidence path must be absolute.');
  const stat = fs.lstatSync(evidenceFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('--record-evidence must be a regular file.');
  return JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
})() : null;

const runtime = await workspaceMcpStatus({ surfaceProfile });
// The publication manifest must describe the same host capabilities as the
// runtime. On Windows, the configured owner-unrestricted workspace enables
// command tools; omitting this flag silently produced a false 19-tool
// read/apply-only manifest for a 22-tool runtime.
const commandSandboxAvailable = runtime.hostCapabilities?.commands === true;
const publication = evidence
  ? recordWorkspacePublication({ ...evidence, surfaceProfile, commandSandboxAvailable, webManagementAvailable: runtime.hostCapabilities?.webManagement === true, codexCliAvailable: runtime.hostCapabilities?.codexCli === true, gptQueueAvailable: runtime.hostCapabilities?.gptQueue === true })
  : workspacePublicationStatus({ surfaceProfile, commandSandboxAvailable, webManagementAvailable: runtime.hostCapabilities?.webManagement === true, codexCliAvailable: runtime.hostCapabilities?.codexCli === true, gptQueueAvailable: runtime.hostCapabilities?.gptQueue === true });
const result = {
  ok: runtime.state === 'ready',
  runtime: {
    state: runtime.state,
    detail: runtime.detail,
    workspaceCount: runtime.workspaceCount ?? 0,
    tunnelReady: runtime.tunnel?.ready === true
  },
  installedHostRegistration: readManagementOverview(process.env.AICC_STATE_ROOT?.trim() || path.join(os.homedir(), '.ai-control-center')).host,
  installedRegistration: readInstalledGatewayRegistration(process.env.AICC_STATE_ROOT?.trim() || path.join(os.homedir(), '.ai-control-center')),
  publication: {
    manifestScope: 'workspace-provider-only',
    surfaceProfile,
    needsPublish: publication.needsPublish,
    toolCount: publication.manifest.toolCount,
    readToolCount: publication.manifest.readToolCount,
    writeToolCount: publication.manifest.writeToolCount,
    manifestHash: publication.manifest.hash,
    tools: publication.manifest.tools,
    published: publication.published,
    manageUrl: publication.manageUrl
  },
  nextSteps: runtime.state === 'ready' ? [
    `정확한 ChatGPT 게시 대상, 기존 app ID, ${surfaceProfile} 전용 Secure MCP Tunnel ID를 먼저 기록하고 롤백 대상을 보존합니다.`,
    '기존 소유 앱의 지원되는 action 새로고침을 먼저 사용하고 실제 remote 도구명·활성 상태를 확인합니다. 실제 앱에서 새 version/검토가 요구될 때만 해당 기존 앱 절차를 따르며, 새로고침을 위해 앱을 복제하지 않습니다.',
    `읽기 ${publication.manifest.readToolCount}개와 쓰기 ${publication.manifest.writeToolCount}개, 총 ${publication.manifest.toolCount}개인지 확인합니다.`,
    '새 ChatGPT 대화에서 list → read-only open(correlation_id 포함) → info → read canary를 실행합니다. lease_ 입력이나 correlation_id 누락이 보이면 HOLD합니다.',
    '실제 앱이 게시/검토를 요구하면 해당 모달의 위험 섹션과 필수 확인란을 확인하고 정확히 한 번 실행합니다. 새로고침만으로 끝난 경우 불필요한 게시 절차를 만들지 않습니다.',
    `publisher account, 계정별 저장 대화, ${publication.manifest.toolCount}개 도구 결과, ${publication.manifest.writeToolCount}개 쓰기 rollback, 공개 범위와 위험 검토를 하나의 검토된 JSON에 기록한 뒤 --record-evidence로 스냅샷을 원자적으로 기록합니다.`,
    '기존 앱·연결과 rollback을 보존합니다. 실제로 승인된 교체가 필요했던 경우에만 계정별 검증 후 exact 구 앱의 보관/폐기 절차를 별도로 따릅니다.'
  ] : runtime.tunnel?.ready === true
    ? ['Tunnel은 응답 중입니다. 현재 source·설치판 identity 차이와 기존 적용 영수증을 대조하고 필요한 정상 배포를 잇습니다. 이 사전검사만으로 연결 장애나 재시작 필요를 단정하지 않습니다.']
    : ['Secure Tunnel과 로컬 MCP 런타임의 실제 상태를 먼저 확인합니다.']
};

if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`AICC Workspace 게시 사전검사: ${result.ok ? '준비됨' : '확인 필요'}`);
  console.log(result.runtime.detail);
  console.log(`도구 ${result.publication.toolCount}개 · 다시 게시 ${result.publication.needsPublish ? '필요' : '불필요'}`);
  console.log(result.publication.manageUrl);
}
process.exitCode = result.ok ? 0 : 1;
