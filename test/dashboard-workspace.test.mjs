import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDashboardWorkspace } from '../src/dashboard-workspace.mjs';
import { createServer } from '../src/server.mjs';
import { ControlReportStore } from '../src/control-plane/report-store.mjs';
import { UserActionLedger } from '../src/goals/user-action-ledger.mjs';

const thread = '01234567-89ab-4cde-8012-3456789abcde';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-dashboard-'));
  const ownerRoot = path.join(root, 'owner'), portfolioRoot = path.join(root, 'portfolio'), workerStateRoot = path.join(root, 'workers');
  function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
  const options = { ownerRoot, portfolioRoot, workerStateRoot, codexHome: root };
  write(path.join(portfolioRoot, 'group-registry.json'), { currentNamespace: 'current', groups: Array.from({ length: 9 }, (_, i) => ({ id: `G${i + 1}`, name: `그룹 ${i + 1}`, rank: i + 1, state: 'waiting' })) });
  write(path.join(portfolioRoot, 'execution.json'), { userApprovedClassification: { products: [{ key: 'dashboard', groupId: 'G3', name: 'AI 대시보드', functions: '보고와 지시 관리', sourceIds: ['p1'] }] } });
  write(path.join(portfolioRoot, 'platform-estate.json'), { projects: [{ id: 'p1', requirements: [{ id: 'r1', behavior: '사용자는 보고를 읽습니다.', acceptance: '실제 보고가 보입니다.' }] }] });
  write(path.join(workerStateRoot, 'G3.state.json'), { jobId: 'G3', threadId: thread, state: 'partial', lastResult: path.join(workerStateRoot, 'G3.result.json') });
  write(path.join(workerStateRoot, 'G3.result.json'), { status: 'partial', summary: '소스 연결', validation: [], remaining: ['실행기 연결'], blockers: [], nextAction: '안전한 발신자 결속' });
  return { options, write, root, ownerRoot, portfolioRoot, workerStateRoot, service: createDashboardWorkspace(options) };
}
function commit(f, input, id = crypto.randomUUID()) { return f.service.commit({ ...input, expectedRevision: f.service.status().revision }, id); }
function registerSender(f) {
  f.write(path.join(f.ownerRoot, 'control-plane', 'codex-continuity', 'registrations.json'), { schemaVersion: 1, excludedThreadIds: [], threads: { [thread]: { threadId: thread, title: '합성 exact 대상', state: 'DISABLED' } } });
}
function fakeReceipt(f, q, state, overrides = {}) {
  const receipt = { id: q.attemptId, threadId: q.agentId, marker: q.marker, messageSha256: q.messageSha256, transport: 'codex-queue', state, at: new Date().toISOString(), queuedMessageId: '23456789-abcd-4ef0-8123-456789abcdef', acceptedAt: new Date().toISOString(), ...(['QUEUE_TURN_ACTIVE', 'QUEUE_TURN_COMPLETED', 'QUEUE_TURN_INTERRUPTED'].includes(state) ? { turnId: q.id } : {}), ...(['QUEUE_TURN_COMPLETED', 'QUEUE_TURN_INTERRUPTED'].includes(state) ? { terminalAt: new Date().toISOString(), goalComplete: false } : {}), ...overrides };
  f.write(path.join(f.ownerRoot, 'control-plane', 'codex-continuity', 'requests', `${q.attemptId}.json`), receipt);
  const terminal = ['QUEUE_TURN_COMPLETED', 'QUEUE_TURN_INTERRUPTED'].includes(state);
  f.write(path.join(f.ownerRoot, 'control-plane', 'codex-continuity', 'registrations.json'), { schemaVersion: 1, excludedThreadIds: [], threads: { [thread]: { threadId: thread, title: '합성 exact 대상', state: 'DISABLED', queueAttempt: terminal ? null : receipt, lastQueueAttempt: terminal ? receipt : null } } });
  return receipt;
}

test('local handoff preserves exact multiline bytes, locks once, creates no sender receipt and respects pause/dependencies', () => {
  const f = fixture(); registerSender(f);
  const instruction = '첫 줄 한글\n  Keep indentation and $literal\n마지막 줄';
  commit(f, { action: 'queue-add', agentId: thread, instruction });
  commit(f, { action: 'queue-add', agentId: thread, instruction: '다음 지시' });
  const [first, second] = f.service.status().queue;
  assert.throws(() => commit(f, { action: 'queue-prepare', id: first.id }), /queue_paused/);
  commit(f, { action: 'queue-stop', stopped: false });
  assert.throws(() => commit(f, { action: 'queue-prepare', id: second.id }), /previous_instruction_pending/);
  commit(f, { action: 'queue-pause', agentId: thread, paused: true });
  assert.throws(() => commit(f, { action: 'queue-prepare', id: first.id }), /queue_paused/);
  commit(f, { action: 'queue-pause', agentId: thread, paused: false });
  const result = commit(f, { action: 'queue-prepare', id: first.id }, 'original-handoff'); assert.equal(result.dispatched, false);
  const q = f.service.status().queue[0]; assert.equal(q.state, 'HANDOFF_READY'); assert.equal(q.readiness, 'UNVERIFIED_NOT_DISPATCHABLE');
  const requests = path.join(f.ownerRoot, 'control-plane', 'codex-continuity', 'requests');
  assert.equal(fs.readFileSync(path.join(requests, `${q.attemptId}.txt`), 'utf8'), instruction);
  assert.equal(fs.existsSync(path.join(requests, `${q.attemptId}.json`)), false);
  assert.equal(commit(f, { action: 'queue-prepare', id: q.id }, 'original-handoff').duplicate, true);
  assert.throws(() => commit(f, { action: 'queue-prepare', id: q.id }), /sent_item_locked/);
  assert.throws(() => commit(f, { action: 'queue-edit', id: q.id, instruction: '바꾸기' }), /sent_item_locked/);
  commit(f, { action: 'queue-reconcile', id: q.id }); assert.equal(f.service.status().queue[0].state, 'HANDOFF_READY');
});

test('original receipt scope, owner, turn, stage and explicit completion guard a single prepared attempt', () => {
  const f = fixture(); registerSender(f);
  commit(f, { action: 'queue-stop', stopped: false }); commit(f, { action: 'queue-add', agentId: thread, instruction: '합성 지시' });
  let q = f.service.status().queue[0]; commit(f, { action: 'queue-prepare', id: q.id }); q = f.service.status().queue[0];
  fakeReceipt(f, q, 'QUEUE_DELIVERY_UNCERTAIN'); commit(f, { action: 'queue-reconcile', id: q.id }); assert.equal(f.service.status().queue[0].state, 'UNKNOWN');
  assert.throws(() => commit(f, { action: 'queue-prepare', id: q.id }), /sent_item_locked/);
  fakeReceipt(f, q, 'QUEUE_ACCEPTED', { messageSha256: 'f'.repeat(64) }); assert.throws(() => commit(f, { action: 'queue-reconcile', id: q.id }), /scope_mismatch/);
  fakeReceipt(f, q, 'QUEUE_ACCEPTED'); commit(f, { action: 'queue-reconcile', id: q.id }); assert.equal(f.service.status().queue[0].state, 'ACCEPTED');
  fakeReceipt(f, q, 'QUEUE_TURN_ACTIVE'); commit(f, { action: 'queue-reconcile', id: q.id });
  fakeReceipt(f, q, 'QUEUE_ACCEPTED'); assert.throws(() => commit(f, { action: 'queue-reconcile', id: q.id }), /regression/);
  fakeReceipt(f, q, 'QUEUE_DELIVERY_UNCERTAIN'); commit(f, { action: 'queue-reconcile', id: q.id });
  fakeReceipt(f, q, 'QUEUE_ACCEPTED'); assert.throws(() => commit(f, { action: 'queue-reconcile', id: q.id }), /regression/);
  fakeReceipt(f, q, 'QUEUE_TURN_COMPLETED'); commit(f, { action: 'queue-reconcile', id: q.id });
  assert.equal(f.service.status().queue[0].state, 'TURN_COMPLETED');
  assert.throws(() => commit(f, { action: 'queue-complete', id: q.id, expectedAttemptId: 'wrong', summary: '확인' }), /completion_unproven/);
  commit(f, { action: 'queue-complete', id: q.id, expectedAttemptId: q.attemptId, summary: '합성 결과 직접 확인' });
  q = f.service.status().queue[0]; assert.equal(q.state, 'COMPLETED'); assert.equal(q.completion.nativeGoalMutated, false);
});

test('failed local staging persists UNKNOWN and never allocates or retries another attempt', () => {
  const f = fixture(); registerSender(f);
  commit(f, { action: 'queue-stop', stopped: false });
  commit(f, { action: 'queue-add', agentId: thread, instruction: '파일 저장 실패 합성 지시' });
  const q = f.service.status().queue[0];
  fs.writeFileSync(path.join(f.ownerRoot, 'control-plane', 'codex-continuity', 'requests'), 'synthetic obstruction');
  assert.throws(() => commit(f, { action: 'queue-prepare', id: q.id }, 'failed-stage'));
  const after = createDashboardWorkspace(f.options).status().queue[0];
  assert.equal(after.state, 'UNKNOWN'); assert.equal(after.attemptId, q.id);
  assert.equal(commit(f, { action: 'queue-prepare', id: q.id }, 'failed-stage').duplicate, true);
  assert.throws(() => commit(f, { action: 'queue-prepare', id: q.id }), /sent_item_locked/);
});

test('staged handoff inspection rechecks message, global attempts, pause and linked goal without writes', () => {
  const f = fixture(); registerSender(f);
  const goals = path.join(f.ownerRoot, 'control-plane', 'master-goals.json');
  f.write(goals, { goals: [{ id: 'g', status: 'ACTIVE', dependsOn: ['dep'] }, { id: 'dep', status: 'COMPLETE' }] });
  commit(f, { action: 'queue-stop', stopped: false });
  commit(f, { action: 'queue-add', agentId: thread, instruction: '합성 지시', goalId: 'g' });
  const q = f.service.status().queue[0]; commit(f, { action: 'queue-prepare', id: q.id });
  const input = () => ({ id: q.id, expectedRevision: f.service.status().revision });
  const stateFile = path.join(f.ownerRoot, 'project-catalog', 'workspace-state.json'), before = fs.readFileSync(stateFile, 'utf8');
  assert.equal(f.service.inspectHandoff(input()).dispatched, false); assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  f.write(goals, { goals: [{ id: 'g', status: 'ACTIVE', dependsOn: ['dep'] }, { id: 'dep', status: 'ACTIVE' }] });
  assert.throws(() => f.service.inspectHandoff(input()), /goal_dependency_pending/);
  f.write(goals, { goals: [{ id: 'g', status: 'ACTIVE' }] });
  commit(f, { action: 'queue-pause', agentId: thread, paused: true });
  assert.throws(() => f.service.inspectHandoff(input()), /queue_paused/);
  commit(f, { action: 'queue-pause', agentId: thread, paused: false });
  const registryFile = path.join(f.ownerRoot, 'control-plane', 'codex-continuity', 'registrations.json');
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')); registry.threads[thread].queueAttempt = { id: 'unknown' }; f.write(registryFile, registry);
  assert.throws(() => f.service.inspectHandoff(input()), /original_attempt_pending/);
  delete registry.threads[thread].queueAttempt; registry.threads.other = { queueAttempt: { id: 'unrelated-history' } }; f.write(registryFile, registry);
  const msg = path.join(f.ownerRoot, 'control-plane', 'codex-continuity', 'requests', `${q.id}.txt`);
  fs.writeFileSync(msg, '변조'); assert.throws(() => f.service.inspectHandoff(input()), /message_poststate_mismatch/);
  fs.writeFileSync(msg, '합성 지시');
  f.write(path.join(path.dirname(msg), `${q.id}.json`), { state: 'UNKNOWN' });
  assert.throws(() => f.service.inspectHandoff(input()), /existing_operation_preserved/);
});

test('local handoff reads actual goal dependencies and refuses checks, archive, hold and cycles as readiness', () => {
  const f = fixture(); registerSender(f);
  const goalsFile = path.join(f.ownerRoot, 'control-plane', 'master-goals.json');
  const goals = [{ id: 'prerequisite', title: '선행 목표', status: 'ACTIVE', checked: true }, { id: 'target', title: '대상 목표', status: 'ACTIVE', dependsOn: ['prerequisite'] }];
  f.write(goalsFile, { goals });
  commit(f, { action: 'queue-add', agentId: thread, instruction: '의존 지시', goalId: 'target' });
  commit(f, { action: 'queue-stop', stopped: false }); const q = f.service.status().queue[0];
  assert.throws(() => commit(f, { action: 'queue-prepare', id: q.id }), /goal_dependency_pending/);
  goals[0].status = 'COMPLETE'; f.write(goalsFile, { goals });
  const prepared = f.service.prepare({ action: 'queue-prepare', id: q.id, expectedRevision: f.service.status().revision });
  goals[0].title = '원문이 변경된 선행 목표'; f.write(goalsFile, { goals });
  assert.notEqual(f.service.prepare({ action: 'queue-prepare', id: q.id, expectedRevision: f.service.status().revision }).fingerprint, prepared.fingerprint);
  goals[1].archived = true; f.write(goalsFile, { goals }); assert.throws(() => commit(f, { action: 'queue-prepare', id: q.id }), /goal_not_ready/);
  goals[1].archived = false; goals[1].status = 'HOLD'; f.write(goalsFile, { goals }); assert.throws(() => commit(f, { action: 'queue-prepare', id: q.id }), /goal_not_ready/);
  goals[1].status = 'ACTIVE'; goals[0].dependsOn = ['prerequisite']; f.write(goalsFile, { goals }); assert.throws(() => commit(f, { action: 'queue-prepare', id: q.id }), /goal_dependency_pending/);
  goals[0].dependsOn = []; f.write(goalsFile, { goals });
  commit(f, { action: 'queue-prepare', id: q.id }); assert.equal(f.service.status().queue[0].state, 'HANDOFF_READY');
});

test('interrupted attempts never become completed or unlock a following instruction', () => {
  const f = fixture(); registerSender(f); commit(f, { action: 'queue-stop', stopped: false });
  for (const instruction of ['첫 지시', '둘째 지시']) commit(f, { action: 'queue-add', agentId: thread, instruction });
  let [q, second] = f.service.status().queue; commit(f, { action: 'queue-prepare', id: q.id }); q = f.service.status().queue[0];
  fakeReceipt(f, q, 'QUEUE_TURN_INTERRUPTED'); commit(f, { action: 'queue-reconcile', id: q.id });
  assert.throws(() => commit(f, { action: 'queue-complete', id: q.id, expectedAttemptId: q.attemptId, summary: '완료' }), /completion_unproven/);
  assert.throws(() => commit(f, { action: 'queue-prepare', id: second.id }), /previous_instruction_pending/);
  fakeReceipt(f, f.service.status().queue[0], 'QUEUE_TURN_COMPLETED');
  assert.throws(() => commit(f, { action: 'queue-reconcile', id: q.id }), /terminal_observation_preserved/);
});

test('metadata undo preserves prepared queues and owner files, survives restart and rejects newer edits or source changes', () => {
  const f = fixture(); registerSender(f);
  const project = f.service.status().nodes.find(n => n.kind === 'project');
  const sourceFile = path.join(f.portfolioRoot, 'execution.json'), original = fs.readFileSync(sourceFile, 'utf8');
  commit(f, { action: 'node-save', id: project.id, parentId: project.parentId, title: '첫 편집', description: '설명' });
  const first = f.service.status().editHistory.at(-1).id;
  commit(f, { action: 'queue-add', agentId: thread, nodeId: project.id, instruction: '보존할 합성 지시' });
  commit(f, { action: 'queue-stop', stopped: false });
  const id = f.service.status().queue[0].id; commit(f, { action: 'queue-prepare', id });
  const queue = structuredClone(f.service.status().queue);
  commit(f, { action: 'metadata-undo', historyId: first });
  assert.deepEqual(f.service.status().queue, queue);
  assert.equal(f.service.status().nodes.find(n => n.id === project.id).title, project.title);
  assert.ok(createDashboardWorkspace(f.options).status().editHistory[0].undoneAt);
  assert.throws(() => commit(f, { action: 'metadata-undo', historyId: first }), /undo_unavailable/);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), original);
  for (const title of ['두번째 편집', '세번째 편집']) commit(f, { action: 'node-save', id: project.id, parentId: project.parentId, title });
  const [, second, third] = f.service.status().editHistory;
  assert.throws(() => commit(f, { action: 'metadata-undo', historyId: second.id }), /undo_conflict/);
  commit(f, { action: 'metadata-undo', historyId: third.id });
  const changed = JSON.parse(original); changed.userApprovedClassification.products[0].name = '원장 변경'; f.write(sourceFile, changed);
  assert.throws(() => commit(f, { action: 'metadata-undo', historyId: second.id }), /undo_source_changed/);
});

test('undo cannot remove referenced local nodes or make a cycle after another node moves', () => {
  const f = fixture();
  commit(f, { action: 'node-save', kind: 'group', title: '로컬 그룹' });
  const groupEdit = f.service.status().editHistory.at(-1).id;
  const group = f.service.status().nodes.find(n => n.title === '로컬 그룹');
  commit(f, { action: 'node-save', kind: 'project', parentId: group.id, title: '하위 프로젝트' });
  assert.throws(() => commit(f, { action: 'metadata-undo', historyId: groupEdit }), /undo_referenced/);
  const project = f.service.status().nodes.find(n => n.kind === 'project');
  const a = f.service.status().nodes.find(n => n.kind === 'feature');
  commit(f, { action: 'node-save', kind: 'feature', parentId: project.id, title: '기능 B' });
  let b = f.service.status().nodes.find(n => n.title === '기능 B');
  commit(f, { action: 'node-save', id: b.id, parentId: a.id, title: b.title });
  commit(f, { action: 'node-save', id: b.id, parentId: project.id, title: b.title });
  const moved = f.service.status().editHistory.at(-1).id;
  commit(f, { action: 'node-save', id: a.id, parentId: b.id, title: a.title });
  assert.throws(() => commit(f, { action: 'metadata-undo', historyId: moved }), /parent_cycle/);
});

test('projects reference all nine current groups; annotations persist without rewriting owners', () => {
  const f = fixture(); const source = fs.readFileSync(path.join(f.portfolioRoot, 'execution.json'), 'utf8');
  let view = f.service.status(); assert.equal(view.coverage.groupCount, 9); assert.equal(view.coverage.featureCount, 1);
  const project = view.nodes.find(n => n.kind === 'project'); assert.equal(project.parentId, 'group:G3');
  commit(f, { action: 'node-save', id: project.id, parentId: 'group:G4', title: '길게 쓴 한영 설명 / Queue', description: '사용자가 실제 쓰는 방법', defaults: '미확인' });
  view = createDashboardWorkspace(f.options).status(); assert.equal(view.nodes.find(n => n.id === project.id).parentId, 'group:G4');
  assert.equal(fs.readFileSync(path.join(f.portfolioRoot, 'execution.json'), 'utf8'), source);
  const changed = JSON.parse(source); changed.userApprovedClassification.products[0].functions = '다른 원작성자의 변경';
  f.write(path.join(f.portfolioRoot, 'execution.json'), changed);
  assert.equal(f.service.status().nodes.find(n => n.id === project.id).sourceConflict, true);
  assert.equal(f.service.status().nodes.find(n => n.id === project.id).description, '사용자가 실제 쓰는 방법');
  commit(f, { action: 'node-archive', id: project.id, archived: true });
  commit(f, { action: 'node-archive', id: project.id, archived: false });
  assert.equal(f.service.status().nodes.find(n => n.id === project.id).archived, false);
});

test('feature explanations separate acceptance from usage and retain project installation and live uncertainty', () => {
  const f = fixture();
  const sourceFile = path.join(f.portfolioRoot, 'platform-estate.json');
  const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  source.projects[0].implementationState = { source: '코드 작성됨', installed: 'UNKNOWN', deployed: '미적용', live: 'UNKNOWN', thisTurn: '문서 비교만' };
  source.projects[0].nextAction = '실제 실행 여부 확인'; f.write(sourceFile, source);
  const before = fs.readFileSync(sourceFile, 'utf8');
  const n = f.service.status().nodes.find(n => n.kind === 'feature');
  assert.equal(n.usage, ''); assert.equal(n.options, ''); assert.equal(n.defaults, ''); assert.equal(n.impact, '');
  assert.equal(n.acceptance, '실제 보고가 보입니다.');
  assert.match(n.current, /소스: 코드 작성됨\n설치: UNKNOWN\n배포: 미적용\n실사용: UNKNOWN/);
  assert.equal(n.currentScope, 'project'); assert.equal(n.remainingScope, 'project');
  assert.equal(n.fieldOrigins.usage, 'unconfirmed'); assert.equal(n.fieldOrigins.current, 'source');
  assert.deepEqual(n.sourceRecord, { file: 'platform-estate.json', projectId: 'p1', requirementId: 'r1' });
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), before);
});

test('registered G3 dashboard uses feature descriptions from the existing product specification without another ledger', () => {
  const f = fixture();
  const executionFile = path.join(f.portfolioRoot, 'execution.json');
  const execution = JSON.parse(fs.readFileSync(executionFile, 'utf8'));
  execution.userApprovedClassification.products.push({ key: 'ai-dashboard', groupId: 'G3', name: 'AI 통합 대시보드', sourceIds: [] }); f.write(executionFile, execution);
  const before = fs.readFileSync(executionFile, 'utf8');
  const view = f.service.status(), features = view.nodes.filter(n => n.parentId === 'project:ai-dashboard');
  assert.equal(features.length, 6); assert.equal(view.coverage.featureCount, 7); assert.deepEqual(view.coverage.issues, []);
  for (const n of features) {
    for (const key of ['description', 'usage', 'options', 'defaults', 'impact', 'current', 'remaining', 'acceptance']) assert.ok(n[key], `${n.id}:${key}`);
    assert.equal(n.fieldOrigins.usage, 'source'); assert.equal(n.currentScope, 'feature');
    assert.equal(n.sourceRecord.file, 'dashboard-product-spec.md'); assert.equal(n.sourceRecord.projectId, 'ai-dashboard');
  }
  assert.match(features.find(n => n.sourceId === 'G3-QUEUE').defaults, /전체 새 시작은 정지/);
  assert.equal(fs.readFileSync(executionFile, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(f.ownerRoot, 'project-catalog', 'workspace-state.json')), false);
});

test('product description edits take the existing source-conflict and merge route without changing owner requirements', () => {
  const f = fixture();
  const executionFile = path.join(f.portfolioRoot, 'execution.json');
  f.write(executionFile, { userApprovedClassification: { products: [{ key: 'ai-dashboard', groupId: 'G3', name: '통합', sourceIds: [] }] } });
  const productSpecFile = path.join(f.root, 'product.md');
  const original = fs.readFileSync(new URL('../docs/dashboard-product-spec.md', import.meta.url), 'utf8');
  fs.writeFileSync(productSpecFile, original);
  f.service = createDashboardWorkspace({ ...f.options, productSpecFile });
  let n = f.service.status().nodes.find(n => n.sourceId === 'G3-QUEUE');
  commit(f, { action: 'node-save', id: n.id, title: n.title, parentId: n.parentId, usage: '기존 사용자 설명' });
  fs.writeFileSync(productSpecFile, original.replace('4000자 이내 지시', '최대 4000자 지시'));
  n = f.service.status().nodes.find(n => n.sourceId === 'G3-QUEUE');
  assert.equal(n.sourceConflict, true); assert.equal(n.usage, '기존 사용자 설명');
  assert.match(n.sourceCurrent.options, /최대 4000자/);
  const choices = Object.fromEntries(['title', 'parentId', 'description', 'usage', 'options', 'defaults', 'impact', 'current', 'remaining'].map(key => [key, key === 'usage' ? 'edited' : 'source']));
  commit(f, { action: 'node-merge', id: n.id, expectedSourceHash: n.sourceHash, choices });
  n = f.service.status().nodes.find(n => n.sourceId === 'G3-QUEUE'); assert.equal(n.sourceConflict, false); assert.equal(n.fieldOrigins.usage, 'annotation'); assert.match(n.options, /최대 4000자/);
});

test('missing, duplicate and invalid product description blocks are isolated and never silently invent features', () => {
  const f = fixture();
  f.write(path.join(f.portfolioRoot, 'execution.json'), { userApprovedClassification: { products: [{ key: 'ai-dashboard', groupId: 'G3', name: '통합', sourceIds: [] }] } });
  const productSpecFile = path.join(f.root, 'product.md'); f.service = createDashboardWorkspace({ ...f.options, productSpecFile });
  let view = f.service.status(); assert.equal(view.coverage.issues[0].code, 'dashboard_product_description_missing');
  const original = fs.readFileSync(new URL('../docs/dashboard-product-spec.md', import.meta.url), 'utf8');
  const block = original.match(/```aicc-dashboard-features\r?\n([\s\S]*?)\r?\n```/)[0];
  for (const content of ['bad document', `${block}\n${block}`, original.replace('"G3-WORK"', '"G3-REPORTS"'), original.replace('"usage": "에이전트 보고', '"usage": null, "extra": "에이전트 보고')]) {
    fs.writeFileSync(productSpecFile, content); view = f.service.status();
    assert.equal(view.coverage.issues[0].code, 'dashboard_product_description_invalid');
    assert.equal(view.nodes.filter(n => n.kind === 'feature').length, 0); assert.equal(view.coverage.groupCount, 9); assert.equal(view.agents.length, 1);
  }
});

test('explicit feature options, false defaults and zero impacts project without borrowing unrelated project settings', () => {
  const f = fixture();
  const spec = { id: 'p1', usage: '관련 없는 프로젝트 사용법', options: ['프로젝트 선택지'], implementationState: { state: '설계', productChanges: 0, runtimeAcceptance: 'UNKNOWN', testBuildDeploy: '미실행' }, requirements: [{ id: 'r1', behavior: '원 기능', acceptance: '수용 계획', usage: ['보고 선택', '다음 행동 확인'], options: { mode: ['수동', '자동'] }, defaults: false, impact: 0, current: '기능별 코드만 작성', remaining: ['실사용 확인'] }] };
  f.write(path.join(f.portfolioRoot, 'platform-estate.json'), { projects: [spec] });
  let n = f.service.status().nodes.find(n => n.kind === 'feature');
  assert.equal(n.usage, '보고 선택\n다음 행동 확인'); assert.equal(n.options, 'mode: 수동\n자동');
  assert.equal(n.defaults, 'false'); assert.equal(n.impact, '0'); assert.equal(n.currentScope, 'feature'); assert.equal(n.remainingScope, 'feature');
  delete spec.requirements[0].current; delete spec.requirements[0].options;
  f.write(path.join(f.portfolioRoot, 'platform-estate.json'), { projects: [spec] });
  n = f.service.status().nodes.find(n => n.kind === 'feature');
  assert.match(n.current, /제품 변경 수: 0/); assert.match(n.current, /운영 인수: UNKNOWN/); assert.equal(n.options, '');
});

test('feature origin labels follow annotations, source changes, explicit merge and undo without rewriting requirements', () => {
  const f = fixture(); const sourceFile = path.join(f.portfolioRoot, 'platform-estate.json');
  let n = f.service.status().nodes.find(n => n.kind === 'feature');
  commit(f, { action: 'node-save', id: n.id, parentId: n.parentId, title: n.title, usage: '화면에서 쓴 사용법' });
  n = f.service.status().nodes.find(n => n.kind === 'feature'); assert.equal(n.fieldOrigins.usage, 'annotation');
  const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8')); source.projects[0].requirements[0].usage = '원제품에서 확인한 방법'; f.write(sourceFile, source);
  const before = fs.readFileSync(sourceFile, 'utf8');
  n = f.service.status().nodes.find(n => n.kind === 'feature'); assert.equal(n.sourceConflict, true);
  const choices = Object.fromEntries(['title', 'parentId', 'description', 'usage', 'options', 'defaults', 'impact', 'current', 'remaining'].map(key => [key, 'source']));
  commit(f, { action: 'node-merge', id: n.id, expectedSourceHash: n.sourceHash, choices });
  n = f.service.status().nodes.find(n => n.kind === 'feature'); assert.equal(n.fieldOrigins.usage, 'source'); assert.equal(n.usage, '원제품에서 확인한 방법');
  commit(f, { action: 'metadata-undo', historyId: f.service.status().editHistory.at(-1).id });
  n = f.service.status().nodes.find(n => n.kind === 'feature'); assert.equal(n.fieldOrigins.usage, 'annotation'); assert.equal(n.usage, '화면에서 쓴 사용법'); assert.equal(n.sourceConflict, true);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), before);
});

test('stale revision, one writer, parent cycles and repeated operation cannot overwrite or duplicate', () => {
  const f = fixture();
  const request = { action: 'pin', agentId: thread, pinned: true, expectedRevision: 0 };
  f.service.prepare(request); f.service.commit(request, 'once');
  assert.equal(f.service.commit(request, 'once').duplicate, true);
  assert.throws(() => f.service.commit(request, 'other'), /revision_conflict/);
  const lock = path.join(f.ownerRoot, 'project-catalog', 'workspace-state.lock'); fs.writeFileSync(lock, 'other-writer');
  assert.throws(() => commit(f, { action: 'pin', agentId: thread, pinned: false }), /writer_busy/);
  const second = fixture(); const feature = second.service.status().nodes.find(n => n.kind === 'feature');
  assert.throws(() => commit(second, { action: 'node-save', id: feature.id, parentId: feature.id, title: 'cycle' }), /parent_cycle/);
});

test('source conflict requires explicit field merge, keeps queues and owner files, and remains selectively reversible', () => {
  const f = fixture();
  const project = f.service.status().nodes.find(n => n.kind === 'project');
  commit(f, { action: 'node-save', id: project.id, parentId: 'group:G4', title: '사용자 편집 이름', description: '유지할 사용자 설명', current: '화면 설명' });
  commit(f, { action: 'queue-add', agentId: thread, nodeId: project.id, instruction: '보존 지시' });
  const queue = structuredClone(f.service.status().queue), sourceFile = path.join(f.portfolioRoot, 'execution.json');
  const changed = JSON.parse(fs.readFileSync(sourceFile, 'utf8')); changed.userApprovedClassification.products[0].name = '최신 원문 이름'; changed.userApprovedClassification.products[0].implementation = '검증된 새 구현'; f.write(sourceFile, changed);
  const owner = fs.readFileSync(sourceFile, 'utf8');
  let current = f.service.status().nodes.find(n => n.id === project.id); assert.equal(current.sourceConflict, true);
  assert.throws(() => commit(f, { action: 'node-save', id: project.id, parentId: project.parentId, title: '충돌 덮기' }), /merge_required/);
  const choices = Object.fromEntries(['title', 'parentId', 'description', 'usage', 'options', 'defaults', 'impact', 'current', 'remaining'].map(key => [key, 'source'])); choices.description = 'edited'; choices.parentId = 'edited';
  const input = { action: 'node-merge', id: project.id, expectedSourceHash: current.sourceHash, choices };
  assert.throws(() => commit(f, { ...input, choices: { title: 'source' } }), /merge_choices_required/);
  assert.throws(() => commit(f, { ...input, expectedSourceHash: 'stale' }), /merge_source_changed/);
  assert.match(f.service.prepare({ ...input, expectedRevision: f.service.status().revision }).summary.join('\n'), /최신 원문 이름/);
  commit(f, input); current = createDashboardWorkspace(f.options).status().nodes.find(n => n.id === project.id);
  assert.equal(current.sourceConflict, false); assert.equal(current.title, '최신 원문 이름'); assert.equal(current.description, '유지할 사용자 설명'); assert.equal(current.current, '검증된 새 구현'); assert.equal(current.parentId, 'group:G4');
  assert.deepEqual(f.service.status().queue, queue); assert.equal(fs.readFileSync(sourceFile, 'utf8'), owner);
  const entry = f.service.status().editHistory.at(-1); assert.equal(entry.action, 'node-merge');
  commit(f, { action: 'metadata-undo', historyId: entry.id });
  current = f.service.status().nodes.find(n => n.id === project.id); assert.equal(current.sourceConflict, true); assert.equal(current.title, '사용자 편집 이름');
  commit(f, { ...input, expectedSourceHash: current.sourceHash });
  changed.userApprovedClassification.products[0].name = '다음 원문 이름'; f.write(sourceFile, changed);
  current = f.service.status().nodes.find(n => n.id === project.id); assert.equal(current.title, '다음 원문 이름', 'adopted fields must follow future owner updates'); assert.equal(current.description, '유지할 사용자 설명');
  assert.throws(() => commit(f, input), /merge_source_changed/);
});

test('an unreadable report is isolated while the real project and queue projections remain available', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.workerStateRoot, 'G3.result.json'), '{broken');
  const view = f.service.status(); assert.equal(view.coverage.groupCount, 9); assert.equal(view.coverage.issues.length, 1);
  assert.equal(view.agents[0].complete, false); assert.equal(view.coverage.issues[0].source, 'G3.result.json');
});

test('partial/error/terminal exit never hides a report; explicit completion still waits for pending queue and pins', () => {
  const f = fixture(); assert.equal(f.service.status().agents[0].archived, false);
  f.write(path.join(f.workerStateRoot, 'G3.result.json'), { status: 'completed', summary: '완료', remaining: [], blockers: [] });
  assert.equal(f.service.status().agents[0].archived, false, 'a previous completed result cannot hide a partial/running worker');
  f.write(path.join(f.workerStateRoot, 'G3.state.json'), { jobId: 'G3', threadId: thread, state: 'completed', lastResult: path.join(f.workerStateRoot, 'G3.result.json') });
  assert.equal(f.service.status().agents[0].archived, true);
  commit(f, { action: 'pin', agentId: thread, pinned: true }); assert.equal(f.service.status().agents[0].archived, false);
  commit(f, { action: 'pin', agentId: thread, pinned: false });
  commit(f, { action: 'queue-add', agentId: thread, instruction: '아직 하지 않은 다음 지시' });
  assert.equal(f.service.status().agents[0].archived, false);
  assert.equal(f.service.status().agents[0].automaticDelivery, false);
});

test('existing report producer projects short fields by registered exact thread and never confirms overall completion', t => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const reportRoot = path.join(f.ownerRoot, 'control-plane', 'reports-v1');
  const store = new ControlReportStore({ root: reportRoot, now: () => Date.parse('2026-11-02T02:00:00Z') });
  const input = { schemaVersion: 1, controlPlaneId: 'integrated-work-control', workerId: 'g3-short', workerSequence: 1, status: 'DONE', revision: 'r1', summary: '작은 보고 결론', completed: ['설명 연결'], remaining: ['실기기 확인'], choices: [], nextAction: '독립 구현 계속', evidence: [{ type: 'source', ref: 'src/dashboard-workspace.mjs' }] };
  f.write(path.join(f.ownerRoot, 'control-plane', 'session-registry.json'), { sessions: [{ threadId: thread, title: '등록 G3', number: '03', reportWorkerIds: ['g3-short'] }] });
  f.write(path.join(f.ownerRoot, 'control-plane', 'user-actions.json'), { actions: [{ part: '03', ask: '기기 확인 필요' }] });
  f.write(path.join(f.workerStateRoot, 'G3.state.json'), { jobId: 'G3', threadId: thread, state: 'completed', updatedAt: '2026-11-02T01:00:00Z', lastResult: path.join(f.workerStateRoot, 'G3.result.json') });
  f.write(path.join(f.workerStateRoot, 'G3.result.json'), { status: 'completed', summary: '이전 완료', remaining: [], blockers: [] });
  store.write(input);
  let a = f.service.status().agents[0];
  assert.equal(a.summary, input.summary); assert.deepEqual(a.completed, input.completed); assert.deepEqual(a.remaining, input.remaining);
  assert.deepEqual(a.choices, ['기기 확인 필요']); assert.equal(a.nextAction, input.nextAction);
  assert.match(a.evidence[0], /dashboard-workspace/); assert.equal(a.complete, false); assert.equal(a.archived, false);
  const previousRevision = a.reportRevision;
  store.write({ ...input, workerSequence: 2, revision: 'r2', remaining: [] });
  a = createDashboardWorkspace(f.options).status().agents[0];
  assert.notEqual(a.reportRevision, previousRevision); assert.deepEqual(a.remaining, []); assert.equal(a.complete, false);
  const beforeIdentityChange = a.reportRevision;
  store.write({ ...input, workerSequence: 3, revision: 'r3', remaining: [] });
  a = f.service.status().agents[0];
  assert.notEqual(a.reportRevision, beforeIdentityChange, 'new source revision at the same timestamp still invalidates replies');
  assert.throws(() => commit(f, { action: 'report-reply', agentId: thread, expectedReportRevision: beforeIdentityChange, instruction: 'old revision reply' }), /report_changed/);
  // Timestamp ties and missing worker timestamps never let a report win a merge.
  for (const updatedAt of ['2026-11-02T02:00:00Z', 'invalid', null]) {
    f.write(path.join(f.workerStateRoot, 'G3.state.json'), { jobId: 'G3', threadId: thread, state: 'running', updatedAt, lastResult: path.join(f.workerStateRoot, 'G3.result.json') });
    assert.equal(f.service.status().agents[0].summary, '이전 완료');
  }
  f.write(path.join(f.workerStateRoot, 'G3.state.json'), { jobId: 'G3', threadId: thread, state: 'running', updatedAt: '2026-11-02T03:00:00Z', lastResult: path.join(f.workerStateRoot, 'G3.result.json') });
  a = f.service.status().agents[0];
  assert.equal(a.summary, '이전 완료'); assert.equal(a.state, 'running'); assert.equal(a.complete, false);
  assert.deepEqual(a.choices, ['기기 확인 필요']);
  // Without an exact registry binding, report IDs never infer thread ownership.
  f.write(path.join(f.ownerRoot, 'control-plane', 'session-registry.json'), { sessions: [{ threadId: thread, title: '등록 G3', reportWorkerIds: ['unrelated'] }] });
  assert.equal(f.service.status().agents[0].summary, '이전 완료');
});

test('report user-action completion uses existing ledger with exact binding, fresh preview and one-shot mobile receipt', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const ledger = new UserActionLedger({ ownerRoot: f.ownerRoot });
  const action = { id: 'UA-03-DEVICE', part: '03', partTitle: '기기 확인', title: '실제 기기 확인', ask: '기기에서 화면을 확인하세요.', why: '실제로 사용할 수 있는지 확인합니다.', steps: ['기기를 엽니다.', '화면을 확인합니다.'], completionCriteria: '기기에서 보고가 읽힙니다.', agentNext: '결과를 보고 다음 안전한 작업을 선택합니다.' };
  ledger.add(action);
  f.write(path.join(f.ownerRoot, 'control-plane', 'session-registry.json'), { sessions: [{ threadId: thread, number: '03', title: '합성 보고', reportWorkerIds: [] }] });
  f.write(path.join(f.ownerRoot, 'control-plane', 'master-goals.json'), { goals: [{ id: 'g1', title: '기존 목표', status: 'ACTIVE' }] });
  const reportFile = path.join(f.workerStateRoot, 'G3.result.json'), beforeReport = fs.readFileSync(reportFile, 'utf8');
  const goalFile = path.join(f.ownerRoot, 'control-plane', 'master-goals.json'), beforeGoal = fs.readFileSync(goalFile, 'utf8');
  const server = createServer({ goals: { ownerRoot: f.ownerRoot }, mobile: { ownerRoot: f.ownerRoot, dashboardOptions: f.options, trayTools: { status: async () => ({ catalog: [], unresolved: [] }) } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function api(endpoint, auth = {}, data) {
    const response = await fetch(origin + '/api/mobile/' + endpoint, { method: data === undefined ? 'GET' : 'POST', headers: { ...(data === undefined ? {} : { 'content-type': 'application/json', origin }), ...(auth.cookie ? { cookie: auth.cookie } : {}), ...(auth.csrf ? { 'x-aicc-csrf': auth.csrf } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  const session = await api('local-session', {}, {}), auth = { cookie: session.headers.get('set-cookie').split(';')[0], csrf: session.data.csrf };
  const view = (await api('dashboard', auth)).data, a = view.agents[0], row = a.userActions[0];
  assert.equal(view.userActionCompletionSupported, true); assert.equal(row.id, action.id); assert.equal(row.revision, ledger.status().actions[0].revision);
  const input = { kind: 'user-action', config: { action: 'user-action-complete', agentId: a.id, expectedReportRevision: a.reportRevision, id: row.id, expectedActionRevision: row.revision, evidence: '합성 기기의 한글과 English 표시를 확인했습니다.' } };
  assert.equal((await api('preview', {}, input)).data.code, 'pair_required');
  assert.equal((await api('preview', { cookie: auth.cookie }, input)).data.code, 'csrf_required');
  assert.equal((await api('preview', auth, { ...input, config: { ...input.config, agentId: '12345678-1234-4123-8123-123456789abc' } })).data.code, 'dashboard_report_changed');
  const preview = await api('preview', auth, input); assert.equal(preview.status, 200); assert.match(preview.data.summary.join('\n'), /완료 기준/);
  ledger.add({ ...action, completionCriteria: '변경된 기기 확인 기준' });
  const stale = await api('confirm', auth, { confirmationToken: preview.data.confirmationToken }); assert.equal(stale.status, 409);
  assert.equal(ledger.status().activeCount, 1);
  const fresh = (await api('dashboard', auth)).data.agents[0]; input.config.expectedReportRevision = fresh.reportRevision; input.config.expectedActionRevision = fresh.userActions[0].revision;
  const reportPreview = await api('preview', auth, input);
  f.write(reportFile, { status: 'partial', summary: '보고 결론 변경', remaining: ['잔여'], blockers: [] });
  assert.equal((await api('confirm', auth, { confirmationToken: reportPreview.data.confirmationToken })).data.code, 'dashboard_report_changed');
  const latest = (await api('dashboard', auth)).data.agents[0]; input.config.expectedReportRevision = latest.reportRevision;
  const ready = await api('preview', auth, input); assert.equal(ready.status, 200);
  assert.equal((await api('preview', auth, { ...input, config: { ...input.config, evidence: 'x'.repeat(421) } })).data.code, 'invalid_user_action');
  const confirmed = await api('confirm', auth, { confirmationToken: ready.data.confirmationToken }); assert.equal(confirmed.status, 202);
  let result;
  for (let i = 0; i < 20; i++) { result = (await api('operation?id=' + confirmed.data.operationId, auth)).data; if (result.state === 'COMPLETED') break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(result.state, 'COMPLETED'); assert.equal(result.kind, 'user-action');
  assert.equal(result.userActionResult.id, action.id); assert.equal(result.userActionResult.removed, true); assert.equal(result.userActionResult.completedBy, 'USER');
  const { createHash } = await import('node:crypto'); const digest = createHash('sha256').update(ready.data.confirmationToken).digest('hex');
  assert.equal((await api('operation-by-confirmation?sha256=' + digest, auth)).data.operationId, confirmed.data.operationId);
  assert.equal((await api('confirm', auth, { confirmationToken: ready.data.confirmationToken })).data.code, 'confirmation_expired');
  assert.equal(ledger.status().activeCount, 0); assert.equal(ledger.status().completedCount, 1);
  const events = fs.readFileSync(path.join(f.ownerRoot, 'control-plane', 'user-action-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(e => e.type === 'COMPLETED').length, 1); assert.equal(events.at(-1).completedBy, 'USER'); assert.equal(events.at(-1).evidence, input.config.evidence);
  assert.deepEqual((await api('dashboard', auth)).data.agents[0].userActions, []);
  assert.equal(fs.readFileSync(goalFile, 'utf8'), beforeGoal); assert.deepEqual(f.service.status().queue, []);
  assert.equal(fs.readFileSync(reportFile, 'utf8').includes('보고 결론 변경'), true); assert.notEqual(beforeReport, fs.readFileSync(reportFile, 'utf8'));
  // Ambiguous legacy part owners cannot expose an actionable binding.
  ledger.add(action);
  f.write(path.join(f.ownerRoot, 'control-plane', 'session-registry.json'), { sessions: [{ threadId: thread, number: '03' }, { threadId: '12345678-1234-4123-8123-123456789abc', number: '03' }] });
  const ambiguous = (await api('dashboard', auth)).data;
  assert.deepEqual(ambiguous.agents.find(a => a.id === thread).userActions, []); assert.equal(ambiguous.coverage.issues.some(issue => issue.code === 'ambiguous_user_action_part'), true);
  f.write(path.join(f.ownerRoot, 'control-plane', 'session-registry.json'), { sessions: [{ threadId: thread, number: '03' }] });
  f.write(path.join(f.ownerRoot, 'status-tray', 'requests', `mobile-${'a'.repeat(32)}.json`), { operationId: 'a'.repeat(32), kind: 'user-action', state: 'UNKNOWN', automaticReplay: false });
  assert.equal((await api('preview', auth, input)).data.code, 'previous_outcome_unknown');
  assert.equal(ledger.status().activeCount, 1, 'an uncertain earlier completion never authorizes a replay');
});

test('completion notices are revision-bound and shared; replies stay in the same exact unsent queue', () => {
  const f = fixture(); let a = f.service.status().agents[0];
  assert.equal(a.completionUnread, false);
  assert.throws(() => commit(f, { action: 'report-seen', agentId: thread, expectedReportRevision: a.reportRevision }), /report_not_completed/);
  f.write(path.join(f.workerStateRoot, 'G3.state.json'), { jobId: 'G3', threadId: thread, state: 'completed', lastResult: path.join(f.workerStateRoot, 'G3.result.json') });
  f.write(path.join(f.workerStateRoot, 'G3.result.json'), { status: 'completed', summary: '확정 완료', remaining: [], blockers: [] });
  a = f.service.status().agents[0]; assert.equal(a.completionUnread, true); assert.equal(a.archived, true);
  commit(f, { action: 'report-seen', agentId: thread, expectedReportRevision: a.reportRevision });
  assert.equal(createDashboardWorkspace(f.options).status().agents[0].completionUnread, false);
  commit(f, { action: 'pin', agentId: thread, pinned: true });
  assert.equal(f.service.status().agents[0].reportRevision, a.reportRevision, 'screen pin must not invent a new source report');
  f.write(path.join(f.workerStateRoot, 'G3.result.json'), { status: 'completed', summary: '완료 근거 업데이트', remaining: [], blockers: [] });
  assert.equal(f.service.status().agents[0].completionUnread, true);
  const reply = { action: 'report-reply', agentId: thread, expectedReportRevision: a.reportRevision, instruction: '응답 첫 줄\nsecond line' };
  assert.throws(() => commit(f, reply), /report_changed/);
  a = f.service.status().agents[0]; reply.expectedReportRevision = a.reportRevision;
  const reportPath = path.join(f.workerStateRoot, 'G3.result.json'), original = fs.readFileSync(reportPath, 'utf8');
  commit(f, reply, 'one-report-reply'); assert.equal(commit(f, reply, 'one-report-reply').duplicate, true);
  const view = createDashboardWorkspace(f.options).status(); assert.equal(view.queue.length, 1);
  assert.equal(view.queue[0].agentId, thread); assert.equal(view.queue[0].state, 'UNSENT'); assert.equal(view.queue[0].attemptId, null);
  assert.equal(view.queue[0].instruction, reply.instruction); assert.equal(view.queue[0].reportRef.revision, a.reportRevision);
  assert.equal(view.agents[0].archived, false); assert.equal(view.agents[0].complete, false);
  assert.equal(fs.readFileSync(reportPath, 'utf8'), original);
  f.write(reportPath, { status: 'partial', summary: '새로운 원 보고', remaining: ['추가 작업'], blockers: [] });
  commit(f, { action: 'queue-stop', stopped: false });
  assert.throws(() => commit(f, { action: 'queue-prepare', id: view.queue[0].id }), /reply_report_changed/);
  assert.equal(f.service.status().queue[0].state, 'UNSENT');
});

test('two synthetic unsent intents reorder and survive restart; sent and UNKNOWN entries never unlock or replay', () => {
  const f = fixture();
  assert.throws(() => commit(f, { action: 'queue-add', agentId: thread, instruction: '잘못된 목표 연결', goalId: 'invented-goal' }), /goal_missing/);
  commit(f, { action: 'queue-add', agentId: thread, instruction: '합성 지시 하나' });
  commit(f, { action: 'queue-add', agentId: thread, instruction: '합성 지시 둘' });
  let view = f.service.status(); const ids = view.queue.map(q => q.id).reverse();
  commit(f, { action: 'queue-order', agentId: thread, ids });
  view = createDashboardWorkspace(f.options).status(); assert.deepEqual(view.queue.map(q => q.id), ids); assert.equal(view.stopped, true);
  const stateFile = path.join(f.ownerRoot, 'project-catalog', 'workspace-state.json');
  const original = JSON.parse(fs.readFileSync(stateFile)); original.queue[0].state = 'UNKNOWN'; original.queue[0].attemptId = 'original-attempt'; f.write(stateFile, original);
  assert.throws(() => commit(f, { action: 'queue-order', agentId: thread, ids }), /sent_item_locked/);
  assert.throws(() => commit(f, { action: 'queue-edit', id: ids[0], instruction: '다시 보내' }), /sent_item_locked/);
  assert.throws(() => commit(f, { action: 'queue-cancel', id: ids[0] }), /sent_item_locked/);
  commit(f, { action: 'queue-order', agentId: thread, ids: [ids[1]] });
  view = f.service.status(); assert.equal(view.queue[0].attemptId, 'original-attempt'); assert.equal(view.queue[0].state, 'UNKNOWN');
});

test('HTTP auth, CSRF, one-use preview, response-loss lookup and restart preserve the same unsent intent', async t => {
  const f = fixture();
  registerSender(f);
  f.write(path.join(f.ownerRoot, 'control-plane', 'master-goals.json'), { goals: [{ id: 'goal-1', title: '기존 목표', status: 'ACTIVE' }] });
  const server = createServer({ goals: { ownerRoot: f.ownerRoot }, mobile: { ownerRoot: f.ownerRoot, dashboardOptions: f.options, trayTools: { status: async () => ({ catalog: [], unresolved: [] }) } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function api(endpoint, { body, cookie, csrf } = {}) {
    const response = await fetch(origin + '/api/mobile/' + endpoint, { method: body ? 'POST' : 'GET', headers: { origin, ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-aicc-csrf': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  assert.equal((await api('dashboard')).data.code, 'pair_required');
  const session = await api('local-session', { body: {} }); const auth = { cookie: session.headers.get('set-cookie').split(';')[0], csrf: session.data.csrf };
  assert.equal((await api('preview', { cookie: auth.cookie, body: { kind: 'dashboard', config: {} } })).data.code, 'csrf_required');
  for (const instruction of ['合成 / 한국어 지시 1', 'English / 지시 2']) {
    const view = (await api('dashboard', auth)).data;
    const prepared = await api('preview', { ...auth, body: { kind: 'dashboard', config: { action: 'queue-add', agentId: thread, instruction, expectedRevision: view.revision } } });
    assert.equal(prepared.status, 200);
    const confirmed = await api('confirm', { ...auth, body: { confirmationToken: prepared.data.confirmationToken } }); assert.equal(confirmed.status, 202);
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(prepared.data.confirmationToken).digest('hex');
    const recovered = await api('operation-by-confirmation?sha256=' + digest, auth); assert.equal(recovered.data.operationId, confirmed.data.operationId);
    const replay = await api('confirm', { ...auth, body: { confirmationToken: prepared.data.confirmationToken } }); assert.equal(replay.data.code, 'confirmation_expired');
  }
  const view = (await api('dashboard', auth)).data; assert.equal(view.queue.length, 2); assert.equal(view.queue.every(q => q.state === 'UNSENT'), true);
  assert.equal(createDashboardWorkspace(f.options).status().queue.length, 2);
  async function mutate(input) {
    const before = (await api('dashboard', auth)).data;
    const prepared = await api('preview', { ...auth, body: { kind: 'dashboard', config: { ...input, expectedRevision: before.revision } } }); assert.equal(prepared.status, 200, prepared.data.code);
    const result = await api('confirm', { ...auth, body: { confirmationToken: prepared.data.confirmationToken } }); assert.equal(result.status, 202);
    return (await api('dashboard', auth)).data;
  }
  const ordered = view.queue.map(q => q.id).reverse();
  await mutate({ action: 'queue-order', agentId: thread, ids: ordered }); await mutate({ action: 'queue-stop', stopped: false });
  const executed = new Set(), observedText = [];
  for (const id of ordered) {
    let current = await mutate({ action: 'queue-prepare-next', agentId: thread, id }); const q = current.queue.find(q => q.id === id);
    const message = fs.readFileSync(path.join(f.ownerRoot, 'control-plane', 'codex-continuity', 'requests', `${q.attemptId}.txt`), 'utf8');
    // Deterministic fake runner only; never invokes QueueMessage, Codex, another worker or a model.
    assert.equal(executed.has(q.attemptId), false); executed.add(q.attemptId); observedText.push(message);
    fakeReceipt(f, q, 'QUEUE_ACCEPTED'); current = await mutate({ action: 'queue-reconcile', id }); assert.equal(current.queue.find(q => q.id === id).state, 'ACCEPTED');
    assert.equal(createDashboardWorkspace(f.options).status().queue.find(q => q.id === id).state, 'ACCEPTED');
    fakeReceipt(f, q, 'QUEUE_TURN_ACTIVE'); await mutate({ action: 'queue-reconcile', id });
    fakeReceipt(f, q, 'QUEUE_TURN_COMPLETED'); current = await mutate({ action: 'queue-reconcile', id }); assert.equal(current.queue.find(q => q.id === id).state, 'TURN_COMPLETED');
    current = await mutate({ action: 'queue-complete', id, expectedAttemptId: q.attemptId, summary: '합성 runner 결과 직접 확인' }); assert.equal(current.queue.find(q => q.id === id).state, 'COMPLETED');
  }
  assert.equal(executed.size, 2); assert.deepEqual(observedText, ['English / 지시 2', '合成 / 한국어 지시 1']);
  assert.equal(createDashboardWorkspace(f.options).status().queue.every(q => q.state === 'COMPLETED'), true);
  const edited = await mutate({ action: 'pin', agentId: thread, pinned: true });
  const restored = await mutate({ action: 'metadata-undo', historyId: edited.editHistory.at(-1).id });
  assert.equal(restored.agents.find(a => a.id === thread).pinned, false);
  assert.deepEqual(restored.queue, edited.queue);
  const goalView = (await api('goals', auth)).data;
  assert.equal(goalView.readOnly, false); assert.match(goalView.sourceRevision, /^[a-f0-9]{64}$/);
  const goalEdit = await api('preview', { ...auth, body: { kind: 'goal', config: { action: 'goal-save', goalId: 'goal-1', title: '실제 원장 합성 편집', description: '한글 첫 줄\nEnglish second line', dependsOn: [], expectedSourceRevision: goalView.sourceRevision } } });
  assert.equal(goalEdit.status, 200);
  const goalResult = await api('confirm', { ...auth, body: { confirmationToken: goalEdit.data.confirmationToken } }); assert.equal(goalResult.status, 202);
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(goalEdit.data.confirmationToken).digest('hex');
  assert.equal((await api('operation-by-confirmation?sha256=' + digest, auth)).data.operationId, goalResult.data.operationId);
  assert.equal((await api('confirm', { ...auth, body: { confirmationToken: goalEdit.data.confirmationToken } })).data.code, 'confirmation_expired');
  const updatedGoal = (await api('goals', auth)).data.goals[0];
  assert.equal(updatedGoal.title, '실제 원장 합성 편집'); assert.equal(updatedGoal.description, '한글 첫 줄\nEnglish second line'); assert.equal(updatedGoal.status, 'ACTIVE');
  assert.deepEqual((await api('dashboard', auth)).data.queue, restored.queue);
  const revision = (await api('goals', auth)).data.sourceRevision;
  const stale = await api('preview', { ...auth, body: { kind: 'goal', config: { action: 'goal-save', goalId: 'goal-1', title: '오래된 미리보기', expectedSourceRevision: revision } } }); assert.equal(stale.status, 200);
  const masterFile = path.join(f.ownerRoot, 'control-plane', 'master-goals.json');
  const concurrent = JSON.parse(fs.readFileSync(masterFile, 'utf8')); concurrent.goals[0].title = '다른 원 작성자 변경'; f.write(masterFile, concurrent);
  const rejected = await api('confirm', { ...auth, body: { confirmationToken: stale.data.confirmationToken } }); assert.equal(rejected.status, 409); assert.equal(rejected.data.code, 'goal_revision_conflict');
  assert.equal((await api('goals', auth)).data.goals[0].title, '다른 원 작성자 변경');
  assert.equal((await api('confirm', { ...auth, body: { confirmationToken: stale.data.confirmationToken } })).data.code, 'confirmation_expired');
  const finalReport = (await api('dashboard', auth)).data.agents.find(a => a.id === thread);
  const replyView = await mutate({ action: 'report-reply', agentId: thread, expectedReportRevision: finalReport.reportRevision, instruction: '보고를 확인한 합성 사용자 응답' });
  assert.equal(replyView.queue.at(-1).origin, 'report-reply'); assert.equal(replyView.queue.at(-1).state, 'UNSENT');
  assert.equal(replyView.queue.at(-1).reportRef.agentId, thread);
});

test('selected next binds current order, stages one exact agent and preserves unrelated UNKNOWN', () => {
  const f = fixture(); registerSender(f);
  commit(f, { action: 'queue-stop', stopped: false });
  commit(f, { action: 'queue-add', agentId: thread, instruction: '첫 지시 / first' });
  commit(f, { action: 'queue-add', agentId: thread, instruction: '다음 지시 / next' });
  let [first, second] = f.service.status().queue;
  const staleRevision = f.service.status().revision;
  f.service.prepare({ action: 'queue-prepare-next', agentId: thread, id: first.id, expectedRevision: staleRevision });
  commit(f, { action: 'queue-order', agentId: thread, ids: [second.id, first.id] });
  assert.throws(() => f.service.commit({ action: 'queue-prepare-next', agentId: thread, id: first.id, expectedRevision: staleRevision }, 'stale-next'), /revision_conflict/);
  assert.throws(() => commit(f, { action: 'queue-prepare-next', agentId: thread, id: first.id }), /next_instruction_changed/);
  const registryFile = path.join(f.ownerRoot, 'control-plane', 'codex-continuity', 'registrations.json');
  const registry = JSON.parse(fs.readFileSync(registryFile));
  registry.threads.unrelated = { state: 'DELIVERY_UNCERTAIN', queueAttempt: { id: 'historical-unknown' } };
  f.write(registryFile, registry); const registryBefore = fs.readFileSync(registryFile, 'utf8');
  const proof = f.service.prepare({ action: 'queue-prepare-next', agentId: thread, id: second.id, expectedRevision: f.service.status().revision });
  assert.match(proof.summary.join('\n'), /exact 에이전트/); assert.match(proof.summary.join('\n'), /次|다음 지시/);
  commit(f, { action: 'queue-prepare-next', agentId: thread, id: second.id }, 'selected-next-once');
  let rows = f.service.status().queue;
  assert.equal(rows.find(q => q.id === second.id).state, 'HANDOFF_READY');
  assert.equal(rows.find(q => q.id === first.id).state, 'UNSENT');
  assert.equal(fs.readFileSync(registryFile, 'utf8'), registryBefore);
  assert.equal(fs.existsSync(path.join(f.ownerRoot, 'control-plane', 'codex-continuity', 'requests', second.id + '.json')), false);
  assert.equal(commit(f, { action: 'queue-prepare-next', agentId: thread, id: second.id }, 'selected-next-once').duplicate, true);
  assert.throws(() => commit(f, { action: 'queue-prepare-next', agentId: thread, id: first.id }), /next_instruction_changed/);
});

test('next preparation never skips pending states and reuses goal and pause fences', () => {
  for (const state of ['HANDOFF_READY', 'ACCEPTED', 'RUNNING', 'TURN_COMPLETED', 'UNKNOWN', 'INTERRUPTED']) {
    const f = fixture(); registerSender(f); commit(f, { action: 'queue-stop', stopped: false });
    commit(f, { action: 'queue-add', agentId: thread, instruction: '원 지시' });
    commit(f, { action: 'queue-add', agentId: thread, instruction: '건너뛰면 안 되는 다음 지시' });
    const file = path.join(f.ownerRoot, 'project-catalog', 'workspace-state.json');
    const saved = JSON.parse(fs.readFileSync(file)); saved.queue[0].state = state; f.write(file, saved);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => commit(f, { action: 'queue-prepare-next', agentId: thread, id: saved.queue[0].id }), /previous_instruction_pending/);
    assert.throws(() => commit(f, { action: 'queue-prepare-next', agentId: thread, id: saved.queue[1].id }), /next_instruction_changed/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  const f = fixture(); registerSender(f);
  assert.throws(() => commit(f, { action: 'queue-prepare-next', agentId: thread, id: crypto.randomUUID() }), /next_instruction_missing/);
  f.write(path.join(f.ownerRoot, 'control-plane', 'master-goals.json'), { goals: [{ id: 'g', status: 'ACTIVE', dependsOn: ['dep'] }, { id: 'dep', status: 'ACTIVE' }] });
  commit(f, { action: 'queue-add', agentId: thread, instruction: '목표에 연결된 지시', goalId: 'g' });
  const id = f.service.status().queue[0].id;
  assert.throws(() => commit(f, { action: 'queue-prepare-next', agentId: thread, id }), /queue_paused/);
  commit(f, { action: 'queue-stop', stopped: false });
  assert.throws(() => commit(f, { action: 'queue-prepare-next', agentId: thread, id }), /goal_dependency_pending/);
  f.write(path.join(f.ownerRoot, 'control-plane', 'master-goals.json'), { goals: [{ id: 'g', status: 'ACTIVE', dependsOn: ['dep'] }, { id: 'dep', status: 'COMPLETE' }] });
  const input = { action: 'queue-prepare-next', agentId: thread, id, expectedRevision: f.service.status().revision };
  const original = f.service.prepare(input);
  f.write(path.join(f.ownerRoot, 'control-plane', 'master-goals.json'), { goals: [{ id: 'g', title: '새 목표 설명', status: 'ACTIVE', dependsOn: ['dep'] }, { id: 'dep', status: 'COMPLETE' }] });
  assert.notEqual(f.service.prepare(input).fingerprint, original.fingerprint, 'goal edits invalidate the displayed preview without a workspace revision change');
  const ownRegistry = path.join(f.ownerRoot, 'control-plane', 'codex-continuity', 'registrations.json');
  const registry = JSON.parse(fs.readFileSync(ownRegistry)); registry.threads[thread].queueAttempt = { id: 'own-unknown' }; f.write(ownRegistry, registry);
  assert.throws(() => f.service.prepare(input), /original_attempt_pending/);
  delete registry.threads[thread].queueAttempt; f.write(ownRegistry, registry);
  f.write(path.join(f.ownerRoot, 'control-plane', 'codex-continuity', 'requests', id + '.json'), { id, state: 'UNKNOWN', original: true });
  assert.throws(() => f.service.prepare(input), /existing_operation_preserved/);
});