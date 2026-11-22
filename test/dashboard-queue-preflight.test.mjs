import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDashboardQueuePreflight } from '../src/dashboard-queue-preflight.mjs';
import { createServer } from '../src/server.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const id = '12345678-1234-4123-8123-123456789abc', agentId = '23456789-2345-4234-8234-234567890abc';
function fixture() {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-preflight-'));
  const root = path.join(ownerRoot, 'control-plane', 'codex-continuity');
  const helper = path.join(ownerRoot, 'releases', 'codex-continuity', 'fake', 'helper.ps1');
  fs.mkdirSync(path.dirname(helper), { recursive: true }); fs.mkdirSync(path.join(root, 'requests'), { recursive: true });
  fs.writeFileSync(helper, "# inert fixture\n'QueuePreflight' { }");
  const registryFile = path.join(root, 'registrations.json');
  fs.writeFileSync(registryFile, JSON.stringify({ schemaVersion: 1, protocolVersion: 3, helperPath: helper, helperSha256: sha(fs.readFileSync(helper)) }));
  const evidence = path.join(root, 'requests', `${id}.preflight-evidence.json`); fs.writeFileSync(evidence, '{"synthetic":true}');
  const intent = { id, agentId, messageSha256: sha('합성'), fingerprint: 'original', dispatched: false };
  const f = { ownerRoot, root, helper, registryFile, evidence, intent, calls: [], overrides: {} };
  f.dashboard = { inspectHandoff: input => { assert.equal(input.id, id); if (f.intentError) throw Object.assign(Error(f.intentError), { code: f.intentError }); return { ...intent }; }, status: () => ({ agents: [] }) };
  f.service = createDashboardQueuePreflight({ ownerRoot, dashboard: f.dashboard, runner: async (_exe, args) => {
    f.calls.push(args.at(-1)); assert.match(args.at(-1), /-Action QueuePreflight/); assert.doesNotMatch(args.at(-1), /-Action QueueMessage/);
    const result = { schemaVersion: 1, kind: 'aicc-queue-preflight', state: 'READY_NOT_AUTHORIZED', threadId: agentId, operationId: id, messageSha256: intent.messageSha256, targetRoute: 'EXACT_OCX', idleVerified: true, quotaFresh: true, binarySha256: 'b'.repeat(64), evidenceSha256: sha(fs.readFileSync(evidence)), observedAt: new Date().toISOString(), dispatched: false, claimed: false, automaticDelivery: false, ...f.overrides };
    f.after?.(); return result;
  } }); return f;
}
test('preflight passes only exact fresh owner admission and never provides dispatch authority', async () => {
  const f = fixture(); const result = await f.service.inspect({ id, expectedRevision: 1 });
  assert.equal(result.ready, true); assert.equal(result.state, 'READY_NOT_AUTHORIZED'); assert.equal(result.dispatched, false); assert.equal(result.automaticDelivery, false);
  assert.doesNotMatch(JSON.stringify(result), /helperPath|evidenceSha256|synthetic/);
  assert.equal(fs.existsSync(path.join(f.root, 'requests', `${id}.json`)), false);
});
test('message/goal fences, missing evidence, older helper, pin drift and changed observation never authorize', async () => {
  for (const change of [
    f => { f.intentError = 'dashboard_goal_dependency_pending'; },
    f => { fs.renameSync(f.evidence, f.evidence + '.preserved'); },
    f => { fs.writeFileSync(f.helper, '# old helper'); },
    f => { f.after = () => fs.appendFileSync(f.evidence, ' '); },
    f => { f.after = () => { f.intent.fingerprint = 'changed'; }; },
    f => { f.overrides = { quotaFresh: false }; },
    f => { f.overrides = { threadId: id }; },
    f => { f.overrides = { claimed: true }; },
    f => { f.overrides = { observedAt: '2000-01-01T00:00:00Z' }; }
  ]) { const f = fixture(); change(f); const result = await f.service.inspect({ id, expectedRevision: 1 }); assert.equal(result.ready, false); assert.equal(result.automaticDelivery, false); }
  const f = fixture(); f.overrides = { state: 'QUOTA_WAIT' };
  assert.equal((await f.service.inspect({ id, expectedRevision: 1 })).reason, 'QUOTA_WAIT');
});
test('preflight HTTP uses the existing authenticated CSRF path and preserves UNKNOWN', async t => {
  const f = fixture(), server = createServer({ goals: { ownerRoot: f.ownerRoot }, mobile: { ownerRoot: f.ownerRoot, dashboard: f.dashboard, queuePreflight: f.service, trayTools: { status: async () => ({ catalog: [], unresolved: [] }) } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function api(name, headers = {}, body = {}) { const r = await fetch(origin + '/api/mobile/' + name, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); return { headers: r.headers, data: await r.json() }; }
  const input = { id, expectedRevision: 1 };
  assert.equal((await api('dashboard-queue-preflight', {}, input)).data.code, 'pair_required');
  const session = await api('local-session'), cookie = session.headers.get('set-cookie').split(';')[0];
  assert.equal((await api('dashboard-queue-preflight', { cookie }, input)).data.code, 'csrf_required');
  const auth = { cookie, 'x-aicc-csrf': session.data.csrf };
  assert.equal((await api('dashboard-queue-preflight', auth, input)).data.ready, true);
  const requests = path.join(f.ownerRoot, 'status-tray', 'requests'); fs.mkdirSync(requests, { recursive: true });
  fs.writeFileSync(path.join(requests, 'mobile-' + 'c'.repeat(32) + '.json'), JSON.stringify({ state: 'UNKNOWN', operationId: 'c'.repeat(32) }));
  assert.equal((await api('dashboard-queue-preflight', auth, input)).data.code, 'previous_outcome_unknown');
  assert.equal(f.calls.length, 1);
});
