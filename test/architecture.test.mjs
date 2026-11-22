import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const canvas = JSON.parse(fs.readFileSync(new URL('../public/aicc-architecture.canvas', import.meta.url), 'utf8'));
const cutover = fs.readFileSync(new URL('../tools/platform/chatgpt/Complete-WebGptFullSetup.mjs', import.meta.url), 'utf8');

test('dashboard architecture map separates the two MCP tunnel roles', () => {
  assert.match(html, /Web GPT 작업 하네스 Tunnel/);
  assert.match(html, /AICC 원격 작업공간 Tunnel/);
  assert.match(html, /두 MCP는 AICC에서 함께 관리하지만/);
  assert.match(html, /이전 이름: Codex Native MCP · 네이티브 모델과 무관/);
});

test('dashboard records the latest six-mode Web GPT evidence without claiming it for a different bundle', () => {
  assert.match(html, /Web GPT 검증 bundle 6경로 실측/);
  assert.match(client, /현재 설치본 재검증 필요/);
  assert.match(client, /이전 bundle의 보존된 증거/);
  assert.match(html, /최소 30초 간격/);
  assert.match(html, /Terminal 6\/6/);
  assert.match(html, /Exact artifact 6\/6/);
  assert.match(html, /Browser-visible 6\/6/);
  assert.doesNotMatch(html, /완전 성공 3\/6/);
});

test('source lineage distinguishes runtime dependencies from reference-only sources', () => {
  assert.match(html, /<span class="source-tag fork">Fork<\/span>/);
  assert.match(html, /<span class="source-tag pinned">Pinned submodule<\/span>/);
  assert.match(html, /Waishnav\/devspace/);
  assert.match(html, /자동 추적 안 함 · 새 아이디어 조사 때만 재검토/);
  assert.match(html, /AICC에 융합된 결과/);
  assert.match(html, /원본 릴리스 비교 후 AICC fork에 선택 반영/);
});

test('dashboard exposes the OCX operation modules without copying credentials', () => {
  assert.match(html, /id="ocxModules"/);
  assert.match(html, /각 구역은 OCX 공식 CLI JSON을 독립적으로 읽습니다/);
  assert.match(html, /http:\/\/127\.0\.0\.1:10100\/#dashboard/);
  assert.match(html, /AICC는 OCX 자격증명을 복제하지 않습니다/);
});

test('dashboard exposes isolated recovery and support controls', () => {
  assert.match(html, /id="troubleshoot"/);
  assert.match(html, /data-action="codex\.web-gpt\.cancel-turns"/);
  assert.match(html, /data-action="codex\.web-gpt\.recover"/);
  assert.match(html, /data-action="codex\.native\.recover"/);
  assert.match(html, /data-action="codex\.bridge\.reconnect"/);
  assert.match(html, /data-diagnostic-task="web-gpt\.doctor"/);
  assert.match(html, /id="copySupportPrompt"/);
  assert.match(client, /codex\.web-gpt\.cancel-turns/);
  assert.match(client, /codex\.web-gpt\.recover/);
});

test('dashboard dynamic meters remain compatible with the strict style CSP', () => {
  assert.match(html, /rel="icon" href="\/favicon\.svg"/);
  assert.match(client, /setAttribute\('stroke-dasharray'/);
  assert.match(client, /<progress aria-label=/);
  assert.doesNotMatch(client, /style=/);
  assert.doesNotMatch(client, /\.style\./);
});

test('downloadable JSON Canvas has valid node and edge references', () => {
  assert.ok(canvas.nodes.length >= 20);
  assert.ok(canvas.edges.length >= 10);
  const nodeIds = new Set(canvas.nodes.map(node => node.id));
  assert.equal(nodeIds.size, canvas.nodes.length);
  for (const edge of canvas.edges) {
    assert.ok(nodeIds.has(edge.fromNode), `missing fromNode: ${edge.fromNode}`);
    assert.ok(nodeIds.has(edge.toNode), `missing toNode: ${edge.toNode}`);
  }
});

test('Web GPT full cutover uses the launcher transaction after an idle drain', () => {
  assert.match(cutover, /waitForIdleAndDrain/);
  assert.match(cutover, /window\.codexWebLauncher\.setupMcp/);
  assert.match(cutover, /Web GPT 작업 하네스/);
  assert.match(cutover, /await data\.text\(\)/);
  assert.match(cutover, /launcherTransactionalRollback/);
  assert.doesNotMatch(cutover, /process\.kill/);
  assert.doesNotMatch(cutover, /stagingPortFor/);
});
