import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function ids(source) {
  return [...source.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
}

test('homepage keeps every static application binding and unique DOM identity', () => {
  const htmlIds = ids(html);
  const idSet = new Set(htmlIds);
  assert.equal(idSet.size, htmlIds.length, 'duplicate HTML id');

  const appBindings = new Set([...script.matchAll(/\$\('#([^']+)'\)/g)].map(match => match[1]));
  assert.deepEqual([...appBindings].filter(id => !idSet.has(id)), []);
});

test('first control view follows the ledger hierarchy without removing deep workflows', () => {
  const firstOrder = ['goals', 'projects', 'coreRouteLedger', 'attention', 'repair-sequence', 'recentEvidence', 'manual-reviews'];
  const positions = firstOrder.map(id => html.indexOf(`id="${id}"`));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);

  for (const id of ['guide', 'recipes', 'activity', 'web-gpt', 'ocx-console', 'accounts', 'workspace', 'troubleshoot', 'openai-usage', 'monitoring', 'design-sources', 'system', 'architecture', 'tools']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test('goal ledger separates cumulative personal checks from operational status', () => {
  assert.match(html, /id="goals"/);
  assert.match(html, /체크는 개인 검토 표시이며 운영 상태를 바꾸지 않습니다/);
  assert.match(html, /id="goalSearch"[^>]*type="search"/);
  assert.match(html, /id="goalStatusFilter"/);
  assert.match(html, /id="goalSort"/);
  assert.match(html, /id="userHelpList"/);
  assert.match(html, /완료하기 전까지 파트별로 남습니다/);
  assert.match(html, /id="sessionList"/);
  assert.match(html, /id="threadDecisionRows"/);
  assert.match(html, /진행된 내용/);
  assert.match(html, /남은 일/);
  assert.match(html, /id="notionSyncState"/);
  assert.match(script, /fetch\('\/api\/goals'/);
  assert.match(script, /postJson\('\/api\/goals\/check'/);
  assert.match(script, /postJson\('\/api\/goals\/user-actions\/complete'/);
  assert.match(script, /data-user-action-complete/);
  assert.match(script, /운영 상태는 변경하지 않았습니다/);
  assert.match(styles, /\.goal-row\.checked \.goal-identity strong/);
  assert.match(styles, /\.goal-state\.hold/);
  assert.match(styles, /\.session-list/);
  assert.match(styles, /\.thread-decision-table/);
  assert.match(styles, /\.user-help-item\.blocking/);
  assert.match(script, /renderCoordination/);
  assert.match(script, /sessionDecisionLabels/);
  assert.match(script, /allowedNotionPageUrl/);
  assert.match(script, /\['app\.notion\.com', 'notion\.so', 'www\.notion\.so'\]/);
  assert.match(script, /notionSyncLink\.removeAttribute\('href'\)/);
});

test('repair sequence fails closed and exposes one read-only stage contract without action controls', () => {
  assert.match(html, /id="repair-sequence"/);
  assert.match(html, /한 번에 하나씩 수리/);
  assert.match(script, /fetch\('\/api\/codex-work-gate'/);
  assert.match(script, /정비에 필요한 유휴 상태를 증명하지 못했습니다/);
  assert.match(script, /진행 중인 작업이 있어 이 연결의 수리·재시작은 보류/);
  assert.match(script, /표시된 한 단계의 읽기 전용 확인/);
  assert.match(script, /stage\.state\) \? stage\.state : 'blocked'/);
  const section = html.slice(html.indexOf('id="repair-sequence"'), html.indexOf('id="recentEvidence"'));
  assert.doesNotMatch(section, /<button|<form|data-action=/);
  assert.match(styles, /grid-template-areas:[^}]*"routes repair"[^}]*"evidence repair"/s);
  assert.match(styles, /grid-template-areas:[^}]*"projects" "routes" "attention" "repair" "evidence" "manual"/s);
});

test('manual review controls fail closed before an explicit second action', () => {
  assert.match(html, /id="enqueueKnowledgeReview"[^>]*disabled/);
  assert.match(html, /id="confirmLocalGrant"[^>]*disabled/);
  assert.match(html, /id="confirmSessionApproval"[^>]*disabled/);
  assert.match(html, /id="localAccessWholeHomeApproved"[^>]*type="checkbox"/);
  assert.doesNotMatch(html, /id="localAccessRoot"[^>]*value=/);
  assert.match(html, /non-empty denylist|비어 있지 않은 denylist/);
  assert.match(html, /symlink/);
  assert.match(html, /prompt, tool 입력, command output/);
  assert.match(html, /배포 후보 22개/);
  assert.match(html, /live 별도 확인/);
});

test('successful JSON actions do not require every service response to repeat ok true', () => {
  assert.match(script, /data\.ok === false && !options\.acceptFindings/);
  assert.doesNotMatch(script, /\(!data\.ok && !options\.acceptFindings\)/);
});

test('copy controls fail over when the Clipboard API is denied or stalls', () => {
  assert.match(script, /Promise\.race\(\[/);
  assert.match(script, /clipboard API timeout/);
  assert.match(script, /document\.execCommand\('copy'\)/);
  assert.match(styles, /\.clipboard-copy-fallback\s*\{/);
});

test('mobile navigation restores its accessible closed label after link activation', () => {
  assert.match(script, /primarySidebar\.classList\.remove\('open'\);\s*menuToggle\.setAttribute\('aria-expanded', 'false'\);\s*menuToggle\.setAttribute\('aria-label', '메뉴 열기'\);/s);
});

test('Luminous Control Ledger preserves accessible responsive source contracts', () => {
  assert.match(styles, /--bg:\s*#f3f7f7/i);
  assert.match(styles, /--accent:\s*#007f8d/i);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /body\s*\{[^}]*min-width:\s*0/s);
  assert.doesNotMatch(styles, /body\s*\{[^}]*min-width:\s*320px/s);
  assert.match(styles, /@media\s*\(max-width:\s*760px\)/);
  assert.match(styles, /@media\s*\(max-width:\s*420px\)/);
  assert.match(styles, /\.topbar \.updated-at\s*\{[^}]*position:\s*static[^}]*grid-column:\s*1/s);
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test('route ledger separates exact active and browser evidence and fails closed offline', () => {
  assert.match(html, /Active gate/);
  assert.match(html, /Browser\/harness/);
  assert.match(html, /aicc restore/);
  assert.match(script, /function exactActiveGate\(/);
  assert.match(script, /routeBusyOrUnknown = !bridgeHealthy \|\| !exactWebCountersKnown/);
  assert.match(script, /17841 health와 active counter가 UNKNOWN/);
  assert.match(styles, /grid-template-columns:\s*repeat\(6,/);
});

test('recovery console exposes one prominent fail-closed exact restore control', () => {
  assert.match(html, /id="latestRecoveryButton"[^>]*data-action="aicc\.restore\.latest"[^>]*disabled/);
  assert.match(html, /id="latestRecoveryMessage"[^>]*aria-live="polite"/);
  assert.match(script, /fetch\('\/api\/recovery\/latest'/);
  assert.match(script, /data\.gate\.activeCount > 0 \|\| data\.gate\.unknownCount > 0/);
  assert.match(script, /latestRecoveryButton\.disabled = !ready/);
  assert.match(script, /복구 완료 · 재실행 금지/);
  assert.match(styles, /\.recovery-primary\s*\{[^}]*min-height:\s*48px/s);
});

test('repair status never presents malformed counters or explicit not-idle as EXACT IDLE', () => {
  const start = script.indexOf('function renderCodexWorkGate(data) {');
  const end = script.indexOf('\nfunction renderCatalog()', start);
  assert.ok(start >= 0 && end > start);
  const element = () => ({ textContent: '', className: '', innerHTML: '', setAttribute() {} });
  const context = { repairGateState: element(), repairGateDetail: element(), repairSequenceList: element(), repairScope: element(), escapeHtml: String };
  vm.createContext(context);
  vm.runInContext(script.slice(start, end), context);
  const render = gate => { context.gate = gate; vm.runInContext('renderCodexWorkGate(gate)', context); return context.repairGateState.textContent; };
  assert.equal(render({ readOk: true, activeCount: 0, unknownCount: 0, exactIdle: true }), 'EXACT IDLE');
  assert.equal(render({ readOk: true, activeCount: 1, unknownCount: 0, exactIdle: false }), 'ACTIVE 1');
  for (const gate of [
    { readOk: true, activeCount: -1, unknownCount: 0 },
    { readOk: true, activeCount: 0, unknownCount: -1 },
    { readOk: true, activeCount: Number.MAX_SAFE_INTEGER + 1, unknownCount: 0 },
    { readOk: true, activeCount: 0, unknownCount: 0, exactIdle: false }
  ]) {
    assert.equal(render(gate), 'UNKNOWN');
    assert.match(context.repairGateDetail.textContent, /현재 연결을 끊는 수리·재시작은 보류/);
    assert.match(context.repairGateDetail.textContent, /승인된 독립 소스 작업은 계속/);
  }
});