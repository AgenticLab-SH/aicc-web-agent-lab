import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerLocalAccessTools } from '../components/workspace-mcp/local-source-provider.mjs';
import { LocalReadGrantAuthority } from '../components/workspace-mcp/local-read-grant-authority.mjs';
import { localAuditHash, localPolicyHash } from '../components/workspace-mcp/local-access-policy.mjs';

const FIXTURE = path.resolve('test/fixtures/local-access/sessions');
const NOW = Date.parse('2026-08-15T03:00:00.000Z');
const TARGET_UUID = '019ff9b0-e2a7-7543-bff8-681819bfcd98';

class FakeServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, spec, handler) { this.tools.set(name, { spec, handler }); }
  async call(name, input) { return this.tools.get(name).handler(input); }
}

function payload(result) { return result.structuredContent; }

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-session-provider-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const codexHome = path.join(temporary, '.codex');
  const root = path.join(codexHome, 'sessions');
  fs.cpSync(FIXTURE, root, { recursive: true });
  return { temporary, root: fs.realpathSync(root) };
}

function grantFor(root, overrides = {}) {
  const sourceType = 'codex-sessions';
  const sourceId = overrides.sourceId ?? 'local_source_aaaaaaaaaaaaaaaaaaaaaaaa';
  const correlationId = overrides.correlationId ?? 'correlation-codex-session';
  const includes = ['**/*'];
  const denies = [];
  const policy = { wholeHomeApproved: false, applicationSupportApproved: false };
  const budgets = overrides.budgets
    ?? { maxFiles: 100, maxFileBytes: 1024 * 1024, maxReadBytes: 2 * 1024 * 1024, maxRunBytes: 8 * 1024 * 1024, maxMatches: 100 };
  const canonicalRoot = fs.realpathSync(root);
  const approvedAt = '2026-08-15T02:00:00.000Z';
  const expiresAt = '2026-08-15T04:00:00.000Z';
  const policyHash = localPolicyHash({ sourceType, canonicalRoot, includes, denies, policy, budgets });
  const auditHash = localAuditHash({ sourceId, policyHash, correlationId, approvedAt, expiresAt, previewFileCount: 2 });
  return {
    schemaVersion: 1,
    grantRef: 'local_grant_sessions0123456789',
    sourceId,
    sourceType,
    label: 'Synthetic Codex sessions',
    root: canonicalRoot,
    canonicalRoot,
    includes,
    denies,
    policy,
    budgets,
    preview: { fileCount: 2, policyHash },
    correlationId,
    approvedAt,
    expiresAt,
    policyHash,
    auditHash
  };
}

function leaseInput(opened, grant, extra = {}) {
  return { source_id: grant.sourceId, read_capability: opened.read_capability, correlation_id: grant.correlationId, ...extra };
}

async function setup(t, { approvalFactory = null, prepareRoot = fixture, grantOverrides = {} } = {}) {
  const paths = prepareRoot(t);
  const grant = grantFor(paths.root, grantOverrides);
  const authority = new LocalReadGrantAuthority({ resolveGrant: async ref => ref === grant.grantRef ? grant : null, now: () => NOW });
  const server = new FakeServer();
  const defaultApproval = ({ approvalRef, sourceId, sessionUuid, correlationId }) => ({
    approved: approvalRef.startsWith('approval-'),
    sourceId,
    sessionUuid,
    correlationId,
    expiresAt: '2026-08-15T03:30:00.000Z',
    maxLines: 20,
    maxTurns: 3,
    maxBytes: 16 * 1024,
    allowAssistantText: true
  });
  registerLocalAccessTools(server, {
    authority,
    now: () => NOW,
    resolveExcerptApproval: approvalFactory ?? defaultApproval
  });
  const opened = payload(await server.call('aicc_local_source_open_read', {
    grant_ref: grant.grantRef,
    correlation_id: grant.correlationId,
    expires_in_seconds: 300
  }));
  return { ...paths, grant, authority, server, opened };
}

test('UUID metadata search finds the target fixture even when the JSONL has no title', async t => {
  const { server, opened, grant } = await setup(t);
  const result = payload(await server.call('aicc_codex_session_search', leaseInput(opened, grant, {
    query: `  ${TARGET_UUID.toUpperCase()}  `,
    max_results: 20
  })));
  assert.equal(result.ok, true);
  assert.equal(result.result_count, 1);
  assert.equal(result.results[0].session_uuid, TARGET_UUID);
  assert.equal(result.results[0].title, 'Untitled Codex session');
  assert.equal(result.results[0].cwd, '/synthetic/project');
  assert.equal(result.results[0].status, 'completed');
  assert.equal(result.raw_session_cached, false);
  assert.equal(Object.hasOwn(result.results[0], '_relativePath'), false);
  assert.doesNotMatch(JSON.stringify(result), /fixture-user-secret|fixture-assistant-secret|synthetic personal prompt/);
});

test('session info normalizes UUID case and exposes only UUID/date/cwd/title/status/size/redacted event kinds', async t => {
  const { server, opened, grant } = await setup(t);
  const result = payload(await server.call('aicc_codex_session_info', leaseInput(opened, grant, { session_uuid: TARGET_UUID.toUpperCase() })));
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.session).sort(), ['activity', 'cwd', 'date', 'event_kinds', 'session_uuid', 'size_bytes', 'status', 'title']);
  assert.equal(result.session.activity.state, 'TURN_ENDED');
  assert.equal(result.session.activity.liveOwnerVerified, false);
  assert.ok(result.session.event_kinds.includes('function_call_output'));
  assert.equal(result.raw_session_cached, false);
  assert.doesNotMatch(JSON.stringify(result), /\.jsonl|synthetic personal prompt|command output/);
});

test('exact UUID lookup and excerpt stay bounded for a large archived rollout', async t => {
  const prepareRoot = activeTest => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-archived-session-provider-'));
    activeTest.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, '.codex', 'archived_sessions');
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, `rollout-2026-08-13T14-55-46-${TARGET_UUID}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-08-13T05:55:46.983Z', payload: { id: TARGET_UUID, timestamp: '2026-08-13T05:55:46.983Z', cwd: '/synthetic/archived-project' } }),
      JSON.stringify({ type: 'turn_context', payload: { type: 'turn_context' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'synthetic archived prompt' } }),
      ...Array.from({ length: 640 }, (_, index) => JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: `safe filler ${index} ${'x'.repeat(4096)}` }
      })),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })
    ];
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return { temporary, root: fs.realpathSync(root), file };
  };
  const budgets = {
    maxFiles: 10,
    maxFileBytes: 128 * 1024,
    maxReadBytes: 512 * 1024,
    maxRunBytes: 8 * 1024 * 1024,
    maxMatches: 20
  };
  const active = await setup(t, { prepareRoot, grantOverrides: { budgets } });
  assert.ok(fs.statSync(active.file).size > budgets.maxFileBytes);

  const search = payload(await active.server.call('aicc_codex_session_search', leaseInput(active.opened, active.grant, {
    query: TARGET_UUID,
    max_results: 5
  })));
  assert.equal(search.ok, true);
  assert.equal(search.result_count, 1);
  assert.equal(search.results[0].session_uuid, TARGET_UUID);
  assert.equal(search.results[0].status, 'completed');
  assert.equal(search.results[0].size_bytes, fs.statSync(active.file).size);

  const info = payload(await active.server.call('aicc_codex_session_info', leaseInput(active.opened, active.grant, {
    session_uuid: TARGET_UUID
  })));
  assert.equal(info.ok, true);
  assert.equal(info.session.cwd, '/synthetic/archived-project');
  assert.equal(info.session.status, 'completed');

  const excerpt = payload(await active.server.call('aicc_codex_session_read_excerpt', leaseInput(active.opened, active.grant, {
    session_uuid: TARGET_UUID,
    approval_ref: 'approval-large-archived-0001',
    start_line: 1,
    max_lines: 20,
    start_turn: 1,
    max_turns: 3,
    max_bytes: 16 * 1024
  })));
  assert.equal(excerpt.ok, true);
  assert.equal(excerpt.raw_jsonl, false);
  assert.ok(excerpt.events.length > 0);
  assert.ok(excerpt.events.length <= 20);
  assert.doesNotMatch(JSON.stringify(excerpt), /synthetic archived prompt/);
});

test('separately approved excerpt is line/turn/byte bounded and redacts prompt, tool output, cookies, and token-like values', async t => {
  const { server, opened, grant } = await setup(t);
  const result = payload(await server.call('aicc_codex_session_read_excerpt', leaseInput(opened, grant, {
    session_uuid: TARGET_UUID,
    approval_ref: 'approval-excerpt-0001',
    start_line: 1,
    max_lines: 20,
    start_turn: 1,
    max_turns: 3,
    max_bytes: 16 * 1024
  })));
  assert.equal(result.ok, true);
  assert.equal(result.raw_jsonl, false);
  assert.equal(result.raw_prompt, false);
  assert.equal(result.raw_tool_output, false);
  assert.ok(result.output_bytes <= 16 * 1024);
  assert.ok(result.events.length <= 20);
  assert.ok(result.events.every(event => event.turn <= 3));
  const serialized = JSON.stringify(result);
  assert.match(serialized, /<redacted-prompt>/);
  assert.match(serialized, /<redacted-tool-output>/);
  assert.match(serialized, /Synthetic safe answer/);
  assert.doesNotMatch(serialized, /synthetic personal prompt|synthetic-cookie-value|fixture-user-secret|fixture-assistant-secret/);
});

test('excerpt approval is source/session/correlation bound, deterministic-clock expired, and one-use', async t => {
  const mismatch = await setup(t, {
    approvalFactory: async ({ sessionUuid, correlationId }) => ({
      approved: true,
      sourceId: 'local_source_ffffffffffffffffffffffff',
      sessionUuid,
      correlationId,
      expiresAt: '2026-08-15T03:30:00.000Z',
      maxLines: 20,
      maxTurns: 3,
      maxBytes: 16 * 1024,
      allowAssistantText: false
    })
  });
  const mismatchResult = payload(await mismatch.server.call('aicc_codex_session_read_excerpt', leaseInput(mismatch.opened, mismatch.grant, {
    session_uuid: TARGET_UUID,
    approval_ref: 'approval-mismatch-0001',
    start_line: 1,
    max_lines: 20,
    start_turn: 1,
    max_turns: 3,
    max_bytes: 16 * 1024
  })));
  assert.equal(mismatchResult.code, 'session_approval_mismatch');

  const expired = await setup(t, {
    approvalFactory: async ({ sourceId, sessionUuid, correlationId }) => ({
      approved: true,
      sourceId,
      sessionUuid,
      correlationId,
      expiresAt: '2026-08-15T02:59:59.999Z',
      maxLines: 20,
      maxTurns: 3,
      maxBytes: 16 * 1024,
      allowAssistantText: false
    })
  });
  const expiredResult = payload(await expired.server.call('aicc_codex_session_read_excerpt', leaseInput(expired.opened, expired.grant, {
    session_uuid: TARGET_UUID,
    approval_ref: 'approval-expired-0001',
    start_line: 1,
    max_lines: 20,
    start_turn: 1,
    max_turns: 3,
    max_bytes: 16 * 1024
  })));
  assert.equal(expiredResult.code, 'session_approval_expired');

  const active = await setup(t);
  const input = leaseInput(active.opened, active.grant, {
    session_uuid: TARGET_UUID,
    approval_ref: 'approval-replay-0001',
    start_line: 1,
    max_lines: 20,
    start_turn: 1,
    max_turns: 3,
    max_bytes: 16 * 1024
  });
  assert.equal(payload(await active.server.call('aicc_codex_session_read_excerpt', input)).ok, true);
  assert.equal(payload(await active.server.call('aicc_codex_session_read_excerpt', input)).code, 'session_approval_replay');
});

test('session tools reject wrong source, wrong correlation, closed capability, and unapproved excerpt', async t => {
  const active = await setup(t);
  const wrongSource = payload(await active.server.call('aicc_codex_session_search', leaseInput(active.opened, active.grant, {
    source_id: 'local_source_ffffffffffffffffffffffff', query: TARGET_UUID, max_results: 20
  })));
  assert.equal(wrongSource.code, 'local_source_mismatch');
  const wrongCorrelation = payload(await active.server.call('aicc_codex_session_search', leaseInput(active.opened, active.grant, {
    correlation_id: 'correlation-wrong-session', query: TARGET_UUID, max_results: 20
  })));
  assert.equal(wrongCorrelation.code, 'local_correlation_mismatch');

  const unapproved = payload(await active.server.call('aicc_codex_session_read_excerpt', leaseInput(active.opened, active.grant, {
    session_uuid: TARGET_UUID,
    approval_ref: 'unknown-approval-ref',
    start_line: 1,
    max_lines: 20,
    start_turn: 1,
    max_turns: 3,
    max_bytes: 16 * 1024
  })));
  assert.equal(unapproved.code, 'session_approval_denied');

  assert.equal(payload(await active.server.call('aicc_local_source_close', leaseInput(active.opened, active.grant))).closed, true);
  const replay = payload(await active.server.call('aicc_codex_session_info', leaseInput(active.opened, active.grant, { session_uuid: TARGET_UUID })));
  assert.equal(replay.code, 'local_capability_invalid');
});

test('Codex session index contract is metadata-only and forbids raw path/content fields', () => {
  const schema = JSON.parse(fs.readFileSync('contracts/remote/codex-session-index.schema.json', 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required.toSorted(), ['cwd', 'date', 'event_kinds', 'session_uuid', 'size_bytes', 'status', 'title'].toSorted());
  for (const forbidden of ['path', 'raw_jsonl', 'content', 'prompt', 'tool_output', 'approval_ref', 'capability']) {
    assert.equal(Object.hasOwn(schema.properties, forbidden), false);
  }
});
