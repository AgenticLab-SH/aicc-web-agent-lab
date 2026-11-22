import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMobileControl } from '../src/mobile-control.mjs';

const REMOTE = 'https://phone.example.test';

function fakeService() {
  const calls = [];
  return {
    calls,
    status: async args => { calls.push(['status', args]); return { ok: true, runs: [{ runName: 'r', groups: [] }] }; },
    logs: args => { calls.push(['logs', args]); return { ok: true, wakeLog: ['a'], supervisorLog: [], groups: [] }; },
    plan: input => { calls.push(['plan', input]); return { ok: true }; },
    preview: async (action, input) => { calls.push(['preview', action, input]); return { ok: true, action, confirmationToken: 'x'.repeat(43) }; },
    confirm: async token => { calls.push(['confirm', token]); if (token === 'bad') throw Object.assign(new Error('없음'), { code: 'confirmation_not_found', status: 404 }); return { ok: true }; }
  };
}

async function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-sup-mobile-'));
  const service = fakeService();
  const control = createMobileControl({ ownerRoot: root, remoteOrigin: REMOTE, supervisedRuns: service, trayTools: { status: async () => ({ catalog: [], unresolved: [] }) }, webConfig: () => ({}) });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!(await control.handle(req, res, url))) { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const port = server.address().port;
  const send = (route, { method = 'GET', data, cookie, csrf, remote = false } = {}) => new Promise((resolve, reject) => {
    const host = remote ? new URL(REMOTE).host : `127.0.0.1:${port}`;
    const origin = remote ? REMOTE : `http://${host}`;
    const headers = { host, origin };
    if (data !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-aicc-csrf'] = csrf;
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text || '{}'), cookie: String(res.headers['set-cookie'] ?? '').split(';')[0] }));
    });
    req.on('error', reject);
    if (data !== undefined) req.write(JSON.stringify(data));
    req.end();
  });
  const local = await send('/api/mobile/local-session', { method: 'POST', data: {} });
  return { service, send, local: { cookie: local.cookie, csrf: local.body.csrf } };
}

test('local owner reads status/logs and previews any named supervise action', async t => {
  const h = await harness(t);
  const s = await h.send('/api/mobile/supervise', { cookie: h.local.cookie });
  assert.equal(s.status, 200);
  assert.equal(s.body.local, true);
  const l = await h.send('/api/mobile/supervise/logs?run=r&lines=5', { cookie: h.local.cookie });
  assert.deepEqual(l.body.wakeLog, ['a']);
  assert.deepEqual(h.service.calls.find(call => call[0] === 'logs')[1], { run: 'r', lines: 5 });
  const p = await h.send('/api/mobile/supervise/preview', { method: 'POST', cookie: h.local.cookie, csrf: h.local.csrf, data: { action: 'add-group', input: { run: 'r' } } });
  assert.equal(p.status, 200);
  const c = await h.send('/api/mobile/supervise/confirm', { method: 'POST', cookie: h.local.cookie, csrf: h.local.csrf, data: { confirmationToken: 'bad' } });
  assert.equal(c.status, 404);
  assert.equal(c.body.code, 'confirmation_not_found');
  assert.equal(c.body.automaticReplay, false);
});

test('mutations require csrf and exact fields', async t => {
  const h = await harness(t);
  const noCsrf = await h.send('/api/mobile/supervise/preview', { method: 'POST', cookie: h.local.cookie, data: { action: 'end-group', input: {} } });
  assert.notEqual(noCsrf.status, 200);
  const extra = await h.send('/api/mobile/supervise/preview', { method: 'POST', cookie: h.local.cookie, csrf: h.local.csrf, data: { action: 'end-group', input: {}, force: true } });
  assert.equal(extra.body.code, 'unsupported_fields');
  assert.equal(h.service.calls.filter(call => call[0] === 'preview').length, 0);
});

test('a paired phone may only read, end a group, or close a tab', async t => {
  const h = await harness(t);
  const pair = await h.send('/api/mobile/pair', { method: 'POST', cookie: h.local.cookie, csrf: h.local.csrf, data: { remember: false, deviceName: 'phone' } });
  assert.equal(pair.status, 200, JSON.stringify(pair.body));
  const secret = pair.body.url.split('#pair=')[1];
  const exchange = await h.send('/api/mobile/exchange', { method: 'POST', remote: true, data: { token: secret } });
  assert.equal(exchange.status, 200, JSON.stringify(exchange.body));
  const phone = { cookie: exchange.cookie, csrf: exchange.body.csrf, remote: true };
  const s = await h.send('/api/mobile/supervise', phone);
  assert.equal(s.status, 200);
  assert.equal(s.body.local, false);
  for (const action of ['start', 'add-group']) {
    const denied = await h.send('/api/mobile/supervise/preview', { ...phone, method: 'POST', data: { action, input: {} } });
    assert.equal(denied.body.code, 'local_owner_required', action);
  }
  const plan = await h.send('/api/mobile/supervise/plan', { ...phone, method: 'POST', data: {} });
  assert.equal(plan.body.code, 'local_owner_required');
  const ok = await h.send('/api/mobile/supervise/preview', { ...phone, method: 'POST', data: { action: 'close-tab', input: { run: 'r', name: 'G1' } } });
  assert.equal(ok.status, 200);
  const page = await h.send('/supervise.html', { remote: true });
  assert.notEqual(page.status, 403, 'supervise page is inside the phone scope');
});
