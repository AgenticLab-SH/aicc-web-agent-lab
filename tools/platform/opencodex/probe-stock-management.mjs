import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.join(os.homedir(), '.bun/install/global/node_modules/@bitkyc08/opencodex');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ocx-management-fixture-'));
process.env.OPENCODEX_HOME = path.join(temporary, 'ocx');
process.env.CODEX_HOME = path.join(temporary, 'codex');
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
globalThis.fetch = async () => { throw new Error('Network disabled'); };
try {
  const { authorizeGuiSessionRequest, REMOTE_GUI_SESSION_TTL_MS, GUI_PAIRING_GRANT_TTL_MS } = await import(pathToFileURL(path.join(root, 'src/server/gui-session.ts')).href);
  const { relayHubManagementRequest } = await import(pathToFileURL(path.join(root, 'src/client/hub-relay.ts')).href);
  const now = 1000000, token = 'fixture-only';
  const record = { serverOrigin: 'http://localhost:10102', browserOrigin: 'http://localhost:10100', csrfToken: 'fixture-csrf', expiresAt: now + REMOTE_GUI_SESSION_TTL_MS, issuance: 'pairing' };
  const state = { sessions: new Map([[token, record]]), pairingGrants: new Map() };
  const request = new Request('http://localhost:10102/api/models', { headers: { Host: 'localhost:10102', Origin: record.browserOrigin, 'x-opencodex-api-key': token, 'x-opencodex-gui-origin': record.browserOrigin } });
  assert.equal(GUI_PAIRING_GRANT_TTL_MS, 300000);
  assert.equal(REMOTE_GUI_SESSION_TTL_MS, 43200000);
  assert.equal(authorizeGuiSessionRequest(request, {}, state, now).ok, true);
  const expired = authorizeGuiSessionRequest(request, {}, state, now + REMOTE_GUI_SESSION_TTL_MS);
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired');
  assert.equal(state.sessions.has(token), false);
  let calls = 0;
  const response = await relayHubManagementRequest(new Request('http://localhost:10100/api/machine/hub-relay/api/models'), '/api/models', { managementUrl: record.serverOrigin, browserOrigin: record.browserOrigin }, {
    fetchImpl: async url => { calls++; assert.equal(new URL(url).origin, record.serverOrigin); throw new Error('Fixture connection refused'); },
  });
  assert.equal(response.status, 502);
  assert.equal(calls, 1);
  assert.ok((await response.text()).includes('hub relay unavailable'));
  console.log(JSON.stringify({ terminal: 'PASS_MANAGEMENT_FIXTURE', checks: ['grant-five-minutes', 'paired-session-twelve-hours', 'expired-session-rejected-and-removed', 'offline-relay-explicit-502', 'one-hub-attempt-no-provider-fallback'], operatingSessionsTouched: false, networkDisabled: true }));
} finally {
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aicc-ocx-management-fixture-')) throw new Error('Cleanup boundary failed');
  fs.rmSync(resolved, { recursive: true, force: true });
}
