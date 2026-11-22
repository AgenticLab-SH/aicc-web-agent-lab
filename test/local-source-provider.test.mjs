import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerLocalAccessTools } from '../components/workspace-mcp/local-source-provider.mjs';
import { LocalReadGrantAuthority } from '../components/workspace-mcp/local-read-grant-authority.mjs';
import { localAuditHash, localPolicyHash } from '../components/workspace-mcp/local-access-policy.mjs';
import { WORKSPACE_MCP_INPUT_SCHEMAS, workspaceMcpInputContract } from '../components/workspace-mcp/input-schemas.mjs';
import { WORKSPACE_MCP_TOOLS } from '../components/workspace-mcp/tool-manifest.mjs';

const FIXTURE = path.resolve('test/fixtures/local-access/local');
const NOW = Date.parse('2026-08-15T03:00:00.000Z');
const ACCESS_TOOLS = [
  'aicc_local_source_list',
  'aicc_local_source_open_read',
  'aicc_local_source_search',
  'aicc_local_source_read',
  'aicc_codex_session_search',
  'aicc_codex_session_info',
  'aicc_codex_session_read_excerpt',
  'aicc_local_source_close'
];

class FakeServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, spec, handler) { this.tools.set(name, { spec, handler }); }
  async call(name, input) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`missing fake tool: ${name}`);
    return tool.handler(input);
  }
}

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-local-provider-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'approved-root');
  fs.cpSync(FIXTURE, root, { recursive: true });
  return { temporary, root: fs.realpathSync(root) };
}

function grantFor(root, overrides = {}) {
  const sourceType = overrides.sourceType ?? 'local';
  const sourceId = overrides.sourceId ?? 'local_source_0123456789abcdef01234567';
  const correlationId = overrides.correlationId ?? 'correlation-local-provider';
  const includes = overrides.includes ?? ['**/*'];
  const denies = overrides.denies ?? ['private/**'];
  const policy = { wholeHomeApproved: false, applicationSupportApproved: false };
  const budgets = {
    maxFiles: 100,
    maxFileBytes: 1024 * 1024,
    maxReadBytes: 2 * 1024 * 1024,
    maxRunBytes: 4 * 1024 * 1024,
    maxMatches: 100,
    ...overrides.budgets
  };
  const canonicalRoot = fs.realpathSync(root);
  const approvedAt = '2026-08-15T02:00:00.000Z';
  const expiresAt = '2026-08-15T04:00:00.000Z';
  const policyHash = localPolicyHash({ sourceType, canonicalRoot, includes, denies, policy, budgets });
  const auditHash = localAuditHash({ sourceId, policyHash, correlationId, approvedAt, expiresAt, previewFileCount: 4 });
  return {
    schemaVersion: 1,
    grantRef: overrides.grantRef ?? 'local_grant_0123456789abcdef',
    sourceId,
    sourceType,
    label: 'Synthetic local source',
    root: canonicalRoot,
    canonicalRoot,
    includes,
    denies,
    policy,
    budgets,
    preview: { fileCount: 4, policyHash },
    correlationId,
    approvedAt,
    expiresAt,
    policyHash,
    auditHash
  };
}

function payload(result) { return result.structuredContent; }

async function openedFixture(t, overrides = {}) {
  const paths = fixture(t);
  const grant = grantFor(paths.root, overrides);
  const authority = new LocalReadGrantAuthority({ resolveGrant: async ref => ref === grant.grantRef ? grant : null, now: () => NOW });
  const server = new FakeServer();
  registerLocalAccessTools(server, { authority, now: () => NOW });
  const opened = payload(await server.call('aicc_local_source_open_read', {
    grant_ref: grant.grantRef,
    correlation_id: grant.correlationId,
    expires_in_seconds: 300
  }));
  return { ...paths, grant, authority, server, opened };
}

function leaseInput(opened, grant, extra = {}) {
  return { source_id: grant.sourceId, read_capability: opened.read_capability, correlation_id: grant.correlationId, ...extra };
}

test('manifest and input contracts expose the exact eight approved local/session tools as read-only', () => {
  const present = WORKSPACE_MCP_TOOLS.filter(tool => ACCESS_TOOLS.includes(tool.name));
  assert.deepEqual(present.map(tool => tool.name), ACCESS_TOOLS);
  assert.ok(present.every(tool => tool.mode === 'read'));
  for (const name of ACCESS_TOOLS) {
    assert.ok(WORKSPACE_MCP_INPUT_SCHEMAS[name]);
    assert.equal(workspaceMcpInputContract(name).type, 'object');
    const properties = workspaceMcpInputContract(name).properties;
    for (const forbidden of ['command', 'patch', 'request_id', 'workspace_id', 'lease']) assert.equal(Object.hasOwn(properties, forbidden), false, `${name}:${forbidden}`);
  }
  const open = workspaceMcpInputContract('aicc_local_source_open_read');
  assert.deepEqual(Object.keys(open.properties).sort(), ['correlation_id', 'expires_in_seconds', 'grant_ref']);
  assert.equal(Object.hasOwn(open.properties, 'root'), false);
  assert.equal(Object.hasOwn(open.properties, 'path'), false);
});

test('provider registration is a single helper and open_read consumes only a local UI grant_ref', async t => {
  const { server, opened, grant } = await openedFixture(t);
  assert.deepEqual([...server.tools.keys()].sort(), ACCESS_TOOLS.toSorted());
  assert.equal(opened.ok, true);
  assert.equal(opened.source_id, grant.sourceId);
  assert.match(opened.read_capability, /^local_read_cap_[a-f0-9]{64}$/);
  assert.equal(opened.mode, 'read-only');
  assert.equal(opened.write, false);
  assert.equal(opened.exec, false);

  const denied = payload(await server.call('aicc_local_source_open_read', {
    grant_ref: 'local_grant_ffffffffffffffff',
    correlation_id: grant.correlationId,
    expires_in_seconds: 300
  }));
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'local_grant_unknown');
});

test('approved local list/search/read returns relative metadata and redacted snippets within budgets', async t => {
  const { server, opened, grant } = await openedFixture(t);
  const listed = payload(await server.call('aicc_local_source_list', leaseInput(opened, grant, { path: '.', max_entries: 20 })));
  assert.equal(listed.ok, true);
  assert.ok(listed.entries.some(entry => entry.path === 'README.md'));
  assert.ok(listed.entries.every(entry => !path.isAbsolute(entry.path)));

  const searched = payload(await server.call('aicc_local_source_search', leaseInput(opened, grant, {
    query: 'alpha', path: '.', case_sensitive: false, max_results: 20, max_files: 20, max_bytes: 1024 * 1024, max_snippets_per_file: 3
  })));
  assert.equal(searched.ok, true);
  assert.equal(searched.match_count, 2);
  assert.ok(searched.results.every(result => !path.isAbsolute(result.path)));

  const secretSearch = payload(await server.call('aicc_local_source_search', leaseInput(opened, grant, {
    query: 'api_key', path: '.', case_sensitive: false, max_results: 20, max_files: 20, max_bytes: 1024 * 1024, max_snippets_per_file: 3
  })));
  assert.doesNotMatch(JSON.stringify(secretSearch), /synthetic-fixture-secret/);
  assert.match(JSON.stringify(secretSearch), /<redacted>/);

  const read = payload(await server.call('aicc_local_source_read', leaseInput(opened, grant, {
    path: 'notes.txt', start_line: 1, max_lines: 20, max_bytes: 1024 * 1024
  })));
  assert.equal(read.ok, true);
  assert.match(read.content, /alpha searchable text/);
  assert.doesNotMatch(read.content, /synthetic-fixture-secret|synthetic private prompt|synthetic command result/);
  assert.match(read.content, /<redacted/);

  const archive = payload(await server.call('aicc_local_source_read', leaseInput(opened, grant, {
    path: 'archive.zip', start_line: 1, max_lines: 20, max_bytes: 1024 * 1024
  })));
  assert.equal(archive.content_mode, 'metadata-only');
  assert.equal(archive.content, null);
});

test('provider refuses traversal, symlink, TCC, sensitive paths, wrong source/correlation, and session raw reads', async t => {
  const openedLocal = await openedFixture(t);
  fs.mkdirSync(path.join(openedLocal.root, '.ssh'));
  fs.writeFileSync(path.join(openedLocal.root, '.ssh', 'id_ed25519'), 'synthetic');
  fs.mkdirSync(path.join(openedLocal.root, 'Library', 'Mail'), { recursive: true });
  fs.writeFileSync(path.join(openedLocal.root, 'Library', 'Mail', 'message.txt'), 'synthetic');
  fs.symlinkSync(openedLocal.temporary, path.join(openedLocal.root, 'escape'));

  for (const [pathValue, code] of [['../outside', 'local_path_escape'], ['escape', 'local_symlink_denied'], ['.ssh/id_ed25519', 'local_sensitive_path_denied'], ['Library/Mail/message.txt', 'HOLD_TCC']]) {
    const denied = payload(await openedLocal.server.call('aicc_local_source_read', leaseInput(openedLocal.opened, openedLocal.grant, {
      path: pathValue, start_line: 1, max_lines: 20, max_bytes: 1024 * 1024
    })));
    assert.equal(denied.ok, false, pathValue);
    assert.equal(denied.code, code, pathValue);
  }

  const wrongCorrelation = payload(await openedLocal.server.call('aicc_local_source_list', leaseInput(openedLocal.opened, openedLocal.grant, {
    correlation_id: 'correlation-wrong-value', path: '.', max_entries: 20
  })));
  assert.equal(wrongCorrelation.code, 'local_correlation_mismatch');
  const wrongSource = payload(await openedLocal.server.call('aicc_local_source_list', leaseInput(openedLocal.opened, openedLocal.grant, {
    source_id: 'local_source_ffffffffffffffffffffffff', path: '.', max_entries: 20
  })));
  assert.equal(wrongSource.code, 'local_source_mismatch');

  const sessionRoot = path.join(openedLocal.temporary, '.codex', 'sessions');
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, '019ff9b0-e2a7-7543-bff8-681819bfcd98.jsonl'), '{}\n');
  const sessionGrant = grantFor(fs.realpathSync(sessionRoot), {
    sourceType: 'codex-sessions',
    sourceId: 'local_source_aaaaaaaaaaaaaaaaaaaaaaaa',
    grantRef: 'local_grant_aaaaaaaaaaaaaaaa',
    correlationId: 'correlation-session-raw'
  });
  const sessionAuthority = new LocalReadGrantAuthority({ resolveGrant: async () => sessionGrant, now: () => NOW });
  const sessionServer = new FakeServer();
  registerLocalAccessTools(sessionServer, { authority: sessionAuthority, now: () => NOW });
  const sessionOpen = payload(await sessionServer.call('aicc_local_source_open_read', { grant_ref: sessionGrant.grantRef, correlation_id: sessionGrant.correlationId, expires_in_seconds: 300 }));
  const rawDenied = payload(await sessionServer.call('aicc_local_source_read', leaseInput(sessionOpen, sessionGrant, {
    path: '019ff9b0-e2a7-7543-bff8-681819bfcd98.jsonl', start_line: 1, max_lines: 20, max_bytes: 1024
  })));
  assert.equal(rawDenied.code, 'local_source_type_mismatch');
});

test('close and expiry reject replay while byte budgets fail closed', async t => {
  const active = await openedFixture(t);
  const closed = payload(await active.server.call('aicc_local_source_close', leaseInput(active.opened, active.grant)));
  assert.equal(closed.closed, true);
  const replay = payload(await active.server.call('aicc_local_source_list', leaseInput(active.opened, active.grant, { path: '.', max_entries: 20 })));
  assert.equal(replay.code, 'local_capability_invalid');

  const paths = fixture(t);
  const grant = grantFor(paths.root, { budgets: { maxFileBytes: 8, maxReadBytes: 8, maxRunBytes: 8 } });
  const authority = new LocalReadGrantAuthority({ resolveGrant: async () => grant, now: () => NOW });
  const server = new FakeServer();
  registerLocalAccessTools(server, { authority, now: () => NOW });
  const opened = payload(await server.call('aicc_local_source_open_read', { grant_ref: grant.grantRef, correlation_id: grant.correlationId, expires_in_seconds: 300 }));
  const denied = payload(await server.call('aicc_local_source_read', leaseInput(opened, grant, { path: 'README.md', start_line: 1, max_lines: 20, max_bytes: 1024 })));
  assert.equal(denied.code, 'local_file_budget_exceeded');
});
