import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createMobileControl, projectCliContinuityRuntime } from '../src/mobile-control.mjs';

test('CLI registration and worker heartbeat never attest automatic resume or consume pending requests', () => {
  const cfg={schemaVersion:1,protocolVersion:3,worker:{state:'RUNNING',heartbeatAt:new Date().toISOString()},
    threads:{current:{enabled:true,attempt:null},historic:{queueAttempt:{state:'QUEUE_ACCEPTED',message:'private-secret'}}}};
  const before=JSON.stringify(cfg);
  let result=projectCliContinuityRuntime(cfg);
  assert.equal(result.state,'PENDING_DELIVERY_RECONCILIATION');
  assert.equal(result.pendingDeliveries,1); assert.equal(result.automaticDeliveryVerified,false);
  assert.equal(result.automaticReplay,false); assert.equal(JSON.stringify(result).includes('private-'),false);
  assert.equal(JSON.stringify(cfg),before);
  cfg.workerStopRequestedAt='2026-11-16T00:00:00Z';
  result=projectCliContinuityRuntime(cfg);
  assert.equal(result.state,'STOPPED_FOR_MAINTENANCE'); assert.equal(result.pendingDeliveries,1);
  delete cfg.workerStopRequestedAt; cfg.worker.state='STOPPED_FOR_MAINTENANCE';
  assert.equal(projectCliContinuityRuntime(cfg).state,'STOPPED_FOR_MAINTENANCE');
  delete cfg.threads.historic; cfg.worker.state='RUNNING';
  assert.equal(projectCliContinuityRuntime(cfg).state,'ORIGINAL_ISSUER_SUPPORT_UNPROVEN');
});

test('invalid CLI registry projects unknown rather than an empty or ready queue', () => {
  for(const cfg of [null,{}, {schemaVersion:1,protocolVersion:3,threads:[]},
    {schemaVersion:1,protocolVersion:3,threads:{broken:null}}]) {
    const result=projectCliContinuityRuntime(cfg);
    assert.equal(result.state,'UNKNOWN'); assert.equal(result.pendingDeliveries,null);
    assert.equal(result.maintenanceStopped,null); assert.equal(result.automaticDeliveryVerified,false);
  }
});

const origin = 'https://mobile-control.example.invalid';
function fixture({ remote = false, saveFails = false, webQueueStatus } = {}) {
  const base = process.env.AICC_MOBILE_TEST_ROOT || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'mobile-fixture-'));
  let revision = 'revision-1', saves = 0;
  let config = { schemaVersion: 1, enabled: false, intervalSeconds: 60, targets: [], peerGrants: [] };
  const web = {
    status() { return { revision, config: structuredClone(config), roles: [], runner: {}, capabilities: {} }; },
    preview() {},
    save(value) { saves++; if (saveFails) throw new Error('uncertain fixture result'); config = structuredClone(value); revision = 'revision-2'; }
  };
  const options = { ownerRoot: root, webConfig: () => web, trayTools: { status: async () => ({ catalog: [], unresolved: [] }) }, ...(webQueueStatus ? { webQueueStatus } : {}), ...(remote ? { remoteOrigin: origin } : {}) };
  let control = createMobileControl(options);
  return {
    root, web, saves: () => saves, restart() { control = createMobileControl(options); },
    changeRevision() { revision = 'changed-outside-preview'; },
    async request(route, { method = 'GET', remote = false, cookie, csrf, data, headers = {}, address = '127.0.0.1' } = {}) {
      const authority = remote ? new URL(origin).host : '127.0.0.1:4383';
      const req = Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))]);
      req.method = method; req.socket = { localPort: 4383, remoteAddress: address };
      req.headers = { host: authority, origin: remote ? origin : 'http://' + authority,
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-aicc-csrf': csrf } : {}), ...headers };
      const response = { status: 0, headers: {}, body: null };
      const res = { setHeader(k, v) { response.headers[k] = v; },
        writeHead(status, h) { response.status = status; Object.assign(response.headers, h); },
        end(value) { response.body = JSON.parse(value); } };
      response.handled = await control.handle(req, res, new URL(route, 'http://127.0.0.1:4383'));
      await new Promise(resolve => setImmediate(resolve));
      return response;
    }
  };
}
async function localSession(f) {
  const r = await f.request('/api/mobile/local-session', { method: 'POST', data: {} });
  assert.equal(r.status, 200);
  return { cookie: r.headers['set-cookie'].split(';')[0], csrf: r.body.csrf };
}

test('portfolio overview requires the existing session; static view assets do not expose records', async () => {
  const f=fixture({remote:true});
  assert.equal((await f.request('/api/mobile/portfolio-overview',{remote:true})).status,409);
  const session=await localSession(f);
  const result=await f.request('/api/mobile/portfolio-overview',session);
  assert.equal(result.status,200);assert.equal(result.body.readOnly,true);
  assert.equal(result.body.runtimeVerified,false);
  for(const resource of ['/portfolio-overview.js','/portfolio-overview.css'])assert.equal((await f.request(resource,{remote:true})).handled,false);
  assert.equal((await f.request('/portfolio-overview.json',{remote:true})).status,403);
  assert.equal(f.saves(),0);
});

test('external PWA install resources pass scope gate while other host assets stay denied', async () => {
  const f = fixture({ remote: true });
  const manifest = JSON.parse(fs.readFileSync(new URL('../public/aicc.webmanifest', import.meta.url), 'utf8'));
  for (const resource of ['/install.html', '/install.js', '/aicc.webmanifest', '/aicc-sw.js', new URL(manifest.start_url, origin).pathname,
    ...manifest.icons.map(icon => icon.src)]) {
    assert.equal(fs.existsSync(new URL('../public' + resource, import.meta.url)), true, resource);
    const response = await f.request(resource, { remote: true });
    assert.equal(response.handled, false, resource + ' must reach the static server');
    assert.equal(response.status, 0, resource);
  }
  for (const resource of ['/index.html', '/server.mjs', '/install.js/private', '/aicc-icon-256.png', '/aicc-icon-192.png/private','/downloads/private.key','/downloads/aicc-mobile.apk/private']) {
    const response = await f.request(resource, { remote: true });
    assert.equal(response.handled, true, resource);
    assert.equal(response.status, 403, resource);
    assert.equal(response.body.code, 'mobile_scope_only', resource);
  }
  assert.equal((await f.request('/api/mobile/session', { remote: true })).status, 409);
  assert.equal(f.saves(), 0);
});

test('authenticated continuity state preserves queueAttempt and blocks enable before dispatch', async t => {
  const pwsh=path.join(os.homedir(),'.ai-control-center/toolchain/pwsh-7.6.6/runtime/pwsh.exe');
  if(process.platform!=='win32'||!fs.existsSync(pwsh)){t.skip('requires installed Windows PowerShell toolchain');return;}
  const f=fixture(), id='11111111-1111-4111-8111-111111111111';
  const helper=path.join(f.root,'releases/codex-continuity/fixture/helper.ps1');
  const registryFile=path.join(f.root,'control-plane/codex-continuity/registrations.json');
  fs.mkdirSync(path.dirname(helper),{recursive:true});fs.mkdirSync(path.dirname(registryFile),{recursive:true});
  const row={threadId:id,executionSurface:'cli',enabled:true,state:'QUEUE_ACCEPTED',queueAttempt:{message:'private-secret'}};
  fs.writeFileSync(helper,`param($Action,$StateRoot)\nif($Action -eq 'Status'){@{protocolMatch=$true;worker=@{state='STOPPED_FOR_MAINTENANCE'};threads=@((ConvertFrom-Json '${JSON.stringify(row)}'))}|ConvertTo-Json -Depth 6}else{@{candidates=@(@{threadId='${id}';title='fixture'})}|ConvertTo-Json -Depth 6}`);
  const {createHash}=await import('node:crypto');
  const cfg={schemaVersion:1,protocolVersion:3,helperPath:helper,helperSha256:createHash('sha256').update(fs.readFileSync(helper)).digest('hex'),
    worker:{state:'STOPPED_FOR_MAINTENANCE'},workerStopRequestedAt:'2026-11-16T00:00:00Z',threads:{[id]:row}};
  fs.writeFileSync(registryFile,JSON.stringify(cfg));const before=fs.readFileSync(registryFile);
  assert.equal((await f.request('/api/mobile/state')).status,409);
  const auth=await localSession(f), state=await f.request('/api/mobile/state',auth);
  assert.equal(state.status,200);assert.equal(state.body.cliAutomaticDelivery,false);
  assert.equal(state.body.cliRuntime.state,'STOPPED_FOR_MAINTENANCE');
  assert.equal(state.body.cliRuntime.pendingDeliveries,1);assert.equal(state.body.rows[0].pendingAttempt,true);
  assert.equal(JSON.stringify(state.body).includes('private-secret'),false);
  const blocked=await f.request('/api/mobile/preview',{method:'POST',...auth,data:{kind:'continuity',action:'Enable',targets:[{threadId:id}]}});
  assert.equal(blocked.body.code,'pending_delivery_preserved');
  assert.deepEqual(fs.readFileSync(registryFile),before);
});

test('mobile GPT queue reuses native projection, requires authentication and hides owner identifiers', async () => {
  let calls = 0, broken = false;
  const snapshot = { state: 'ready', observedAt: '2026-11-16T00:00:00Z', counts: { runs: 1, active: 0, paused: 1, completed: 0, failed: 0, cancelled: 0, unknown: 1, readyRoles: 0, runningRoles: 0 },
    items: [{ runRef: 'private-id', targetRef: 'private-target', status: 'paused', reason: 'SUBMISSION_UNCERTAIN', roles: 2, prompt: 'private-prompt', token: 'private-secret' }], itemsTruncated: false };
  const f = fixture({ remote: true, webQueueStatus: async () => { calls++; if (broken) throw Error('private-path'); return snapshot; } });
  assert.equal((await f.request('/api/mobile/web-queue')).status, 409); assert.equal(calls, 0);
  const auth = await localSession(f);
  const pair = await f.request('/api/mobile/pair', { method: 'POST', ...auth, data: { remember: true, deviceName: 'Test phone' } });
  const exchanged = await f.request('/api/mobile/exchange', { method: 'POST', remote: true, data: { token: new URL(pair.body.url).hash.slice('#pair='.length) } });
  const phone = { remote: true, cookie: exchanged.headers['set-cookie'].split(';')[0] };
  const before = JSON.stringify(snapshot);
  const result = await f.request('/api/mobile/web-queue?path=C%3A%5Csecret', phone);
  assert.equal(result.status, 200); assert.equal(result.body.status, 'AVAILABLE');
  assert.equal(result.body.items[0].state, 'UNKNOWN'); assert.equal(result.body.counts.unknown, 1);
  assert.equal(result.body.readOnly, true); assert.equal(result.body.automaticReplay, false);
  assert.equal(result.body.controls, 'CHROME_QUEUE_EXTENSION_ONLY');
  assert.equal(JSON.stringify(result.body).includes('private-'), false);
  assert.equal(JSON.stringify(snapshot), before); assert.equal(f.saves(), 0);
  broken = true;
  const failed = await f.request('/api/mobile/web-queue', auth);
  assert.equal(failed.body.status, 'UNKNOWN'); assert.equal(failed.body.counts, null);
  assert.equal(JSON.stringify(failed.body).includes('private-'), false);
  broken = false; snapshot.counts.active = -1;
  assert.equal((await f.request('/api/mobile/web-queue', auth)).body.status, 'UNKNOWN');
  snapshot.counts.active = 0; snapshot.items[0].reason = 'untrusted-error';
  assert.equal((await f.request('/api/mobile/web-queue', auth)).body.status, 'UNKNOWN');
  assert.equal((await f.request('/api/mobile/session', phone)).status, 200);
  const isolated = fixture();
  assert.equal((await isolated.request('/api/mobile/web-queue', await localSession(isolated))).body.status, 'UNKNOWN');
});

test('mobile collaboration uses owner authentication, bounded projection and never creates or mutates runs', async () => {
  const f = fixture();
  assert.equal((await f.request('/api/mobile/orchestration')).status, 409);
  assert.equal((await f.request('/api/mobile/work-activity')).status, 409);
  assert.equal(fs.existsSync(path.join(f.root, 'jobs')), false);
  const auth = await localSession(f);
  assert.equal((await f.request('/api/mobile/orchestration', auth)).body.status, 'NOT_INITIALIZED');
  assert.equal((await f.request('/api/mobile/work-activity', auth)).body.status, 'NOT_INITIALIZED');
  assert.equal(fs.existsSync(path.join(f.root, 'jobs')), false);
  fs.mkdirSync(path.join(f.root, 'jobs'));
  const runs = {}, jobs = {};
  for (let i = 0; i < 26; i++) {
    const id = 'private-run-' + i, jobId = 'private-job-' + i;
    runs[id] = { runId: id, state: 'running', roleDag: [{roleId: 'private-role', kind: 'writer'}], jobIds: [jobId],
      workspaceId: 'private-workspace', identityBinding: 'private-login', updatedAt: '2026-11-15T10:00:00Z',
      parentGoal: { goalId: 'private-goal' }, prompt: 'private-secret' };
    jobs[jobId] = { jobId, orchestrationRunId: id, roleId: 'private-role', workspaceId: 'private-workspace',
      identityBinding: 'private-login', state: 'running', results: [{ prompt: 'private-content' }] };
  }
  const file = path.join(f.root, 'jobs', 'state.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, sequence: 0, jobs, artifacts: {}, orchestrationRuns: runs }));
  const before = fs.readFileSync(file);
  const result = await f.request('/api/mobile/orchestration?path=C%3A%5Csecret', auth);
  assert.equal(result.status, 200); assert.equal(result.body.total, 26); assert.equal(result.body.shown, 24);
  assert.equal(result.body.truncated, true); assert.equal(result.body.readOnly, true);
  assert.equal(result.body.automaticReplay, false); assert.equal(result.body.nativeGoalAuthority, 'UNKNOWN');
  assert.equal(result.body.runs[0].roles[0].state, 'RUNNING');
  assert.equal(result.body.runs[0].completionVerified, false);
  assert.equal(JSON.stringify(result.body).includes('private-'), false);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(f.saves(), 0);
  fs.writeFileSync(file, '{broken');
  assert.equal((await f.request('/api/mobile/orchestration', auth)).body.status, 'UNKNOWN');
});

test('trusted mobile collaboration rejects stale identity binding without leaking or promoting results', async () => {
  const f = fixture({ remote: true }), auth = await localSession(f);
  assert.equal((await f.request('/api/mobile/orchestration', { remote: true })).status, 409);
  const pair = await f.request('/api/mobile/pair', { method: 'POST', ...auth, data: { remember: true, deviceName: 'test phone' } });
  const exchanged = await f.request('/api/mobile/exchange', { method: 'POST', remote: true,
    data: { token: new URL(pair.body.url).hash.slice('#pair='.length) } });
  const phone = { remote: true, cookie: exchanged.headers['set-cookie'].split(';')[0] };
  fs.mkdirSync(path.join(f.root, 'jobs'));
  fs.writeFileSync(path.join(f.root, 'jobs', 'state.json'), JSON.stringify({ schemaVersion: 1, sequence: 0, artifacts: {},
    orchestrationRuns: { r: { runId: 'r', state: 'completed', roleDag: [{roleId: 'w', kind: 'writer'}],
      jobIds: ['j'], workspaceId: 'root', identityBinding: 'original' } },
    jobs: {j: {jobId: 'j', roleId: 'w', orchestrationRunId: 'r', workspaceId: 'root', identityBinding: 'foreign', state: 'completed', results: [{}]}} }));
  const result = await f.request('/api/mobile/orchestration', phone);
  assert.equal(result.status, 200); assert.equal(result.body.runs[0].roles[0].state, 'UNKNOWN');
  assert.equal(result.body.runs[0].state, 'UNKNOWN');
  assert.equal(result.body.runs[0].roles[0].resultRecorded, false);
  assert.equal(result.body.runs[0].completionVerified, false);
});
function webInput(f) {
  const current = f.web.status();
  return { kind: 'web', config: { ...current.config, expectedRevision: current.revision, enabled: true } };
}
async function preview(f, auth) {
  const r = await f.request('/api/mobile/preview', { method: 'POST', ...auth, data: webInput(f) });
  assert.equal(r.status, 200); return r.body.confirmationToken;
}

test('mobile owner authentication rejects proxy, cross-origin, network and CSRF impersonation', async () => {
  const f = fixture();
  for (const options of [
    { headers: { 'x-forwarded-for': '127.0.0.1' } },
    { headers: { origin: 'https://untrusted.example.invalid' } },
    { address: '192.0.2.10' }
  ]) {
    const r = await f.request('/api/mobile/local-session', { method: 'POST', data: {}, ...options });
    assert.equal(r.status, 403); assert.equal(f.saves(), 0);
  }
  const auth = await localSession(f);
  const denied = await f.request('/api/mobile/preview', { method: 'POST', cookie: auth.cookie, data: webInput(f) });
  assert.equal(denied.body.code, 'csrf_required'); assert.equal(f.saves(), 0);
});

test('management overview stays behind the existing mobile authentication and exports only projection state', async () => {
  const f = fixture();
  const rejected = await f.request('/api/mobile/management'); assert.equal(rejected.status, 409);
  const auth = await localSession(f), result = await f.request('/api/mobile/management', auth);
  assert.equal(result.status, 200); assert.equal(result.body.manager, 'AICC 관리기');
  assert.equal(result.body.gpt.status, 'NOT_REGISTERED'); assert.equal(result.body.automaticReplay, false);
  assert.equal(JSON.stringify(result.body).includes(f.root.replaceAll('\\', '\\\\')), false);
  assert.equal(result.body.mobilePublic.status, 'UNKNOWN');
  assert.equal(result.body.mobilePublic.stopSubmissionSupported, null);
  assert.equal(result.body.mobilePublic.stopControlEnabled, false);
  assert.equal(result.body.mobilePublic.operationalTransition, 'HOLD');
  const dashboard = await f.request('/api/mobile/dashboard', auth);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.mobilePublic.stopSubmissionSupported, null);
  assert.equal(dashboard.body.mobilePublic.installControlEnabled, false);
});

test('evidence history GET uses existing mobile owner session and never exposes raw job records', async () => {
  const f = fixture();
  const denied = await f.request('/api/mobile/evidence-history');
  assert.equal(denied.status, 409);
  assert.equal(fs.existsSync(path.join(f.root, 'jobs')), false);
  const auth = await localSession(f);
  const missing = await f.request('/api/mobile/evidence-history', auth);
  assert.equal(missing.status, 200);
  assert.equal(missing.body.status, 'NOT_INITIALIZED');
  assert.equal(fs.existsSync(path.join(f.root, 'jobs')), false);
  fs.mkdirSync(path.join(f.root, 'jobs'));
  fs.writeFileSync(path.join(f.root, 'jobs', 'state.json'), JSON.stringify({
    schemaVersion: 1, sequence: 0, jobs: { 'private-client_key-job': {
      jobId: 'private-client_key-job', state: 'failed', updatedAt: '2026-11-08T00:00:00Z',
      artifactRefs: [], results: [], requestRef: 'C:\\secret\\prompt', terminalReason: 'private-password' } },
    artifacts: {}, orchestrationRuns: {}
  }));
  const response = await f.request('/api/mobile/evidence-history?path=C%3A%5Csecrets', auth);
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'AVAILABLE');
  assert.equal(response.body.jobs.length, 1);
  assert.equal(response.body.jobs[0].state, 'FAILED');
  assert.equal(response.body.fileOpenSupported, false);
  for (const secret of ['private-', 'client_key', 'password', 'prompt', 'C:\\']) assert.equal(JSON.stringify(response.body).includes(secret), false);
});
test('pending handoffs require the existing owner session and never expose private task content', async () => {
  const f=fixture();assert.equal((await f.request('/api/mobile/pending-work')).status,409);
  assert.equal(fs.existsSync(path.join(f.root,'pending-work')),false);
  const auth=await localSession(f);
  assert.equal((await f.request('/api/mobile/pending-work',auth)).body.status,'NOT_INITIALIZED');
  const {PendingWorkInbox}=await import('../src/control-plane/pending-work.mjs');
  fs.mkdirSync(path.join(f.root,'pending-work'));
  new PendingWorkInbox(path.join(f.root,'pending-work')).register({id:'request-test',title:'인계 시험',priority:'P0',
    projectRoot:f.root,origin:{displayName:'검증 지피티',conversationUrl:null,identityEvidence:'private-identity'},objective:'private-prompt',nextAction:'private-action'});
  const r=await f.request('/api/mobile/pending-work?path=foreign',auth);
  assert.equal(r.status,200);assert.equal(r.body.items[0].displayName,'검증 지피티');assert.equal(r.body.automaticDispatch,false);
  assert.equal(JSON.stringify(r.body).includes('private-'),false);assert.equal(f.saves(),0);
});

test('trusted phone survives controller restart, has a single-use pair and remains owner-revocable', async () => {
  const f = fixture({ remote: true }), auth = await localSession(f);
  const pair = await f.request('/api/mobile/pair', { method: 'POST', ...auth, data: { remember: true, deviceName: 'fixture phone' } });
  const secret = new URL(pair.body.url).hash.slice('#pair='.length);
  const exchanged = await f.request('/api/mobile/exchange', { method: 'POST', remote: true, data: { token: secret } });
  assert.equal(exchanged.body.trustedDevice, true);
  assert.match(exchanged.headers['set-cookie'], /HttpOnly.*SameSite=Strict.*Secure/);
  const phoneCookie = exchanged.headers['set-cookie'].split(';')[0];
  const replay = await f.request('/api/mobile/exchange', { method: 'POST', remote: true, data: { token: secret } });
  assert.equal(replay.body.code, 'pair_expired');
  f.restart();
  const restored = await f.request('/api/mobile/session', { remote: true, cookie: phoneCookie });
  assert.equal(restored.status, 200); assert.equal(restored.body.deviceId, exchanged.body.deviceId);
  const renewedOwner = await localSession(f);
  const devices = await f.request('/api/mobile/devices', renewedOwner);
  assert.equal(devices.body.devices.length, 1);
  const deviceDirectory = path.join(f.root, 'control-plane', 'mobile-devices');
  const records = fs.readdirSync(deviceDirectory).flatMap(dir => fs.readdirSync(path.join(deviceDirectory, dir)).map(file => fs.readFileSync(path.join(deviceDirectory, dir, file), 'utf8')));
  assert.ok(records.every(text => !text.includes(phoneCookie.split('=')[1]) && !text.includes(secret)));
  const revoked = await f.request('/api/mobile/revoke-device', { method: 'POST', ...renewedOwner, data: { deviceId: exchanged.body.deviceId } });
  assert.equal(revoked.status, 200);
  assert.equal((await f.request('/api/mobile/session', { remote: true, cookie: phoneCookie })).body.code, 'pair_required');
});

test('web control commits once, rejects confirmation replay and rejects changed preview state', async () => {
  const f = fixture(), auth = await localSession(f), confirmationToken = await preview(f, auth);
  const result = await f.request('/api/mobile/confirm', { method: 'POST', ...auth, data: { confirmationToken } });
  assert.equal(result.status, 202); assert.equal(f.saves(), 1);
  const receipt = await f.request('/api/mobile/operation?id=' + result.body.operationId, auth);
  assert.equal(receipt.body.state, 'COMPLETED'); assert.equal(receipt.body.automaticReplay, false);
  const replay = await f.request('/api/mobile/confirm', { method: 'POST', ...auth, data: { confirmationToken } });
  assert.equal(replay.body.code, 'confirmation_expired'); assert.equal(f.saves(), 1);
  const staleToken = await preview(f, auth); f.changeRevision();
  const stale = await f.request('/api/mobile/confirm', { method: 'POST', ...auth, data: { confirmationToken: staleToken } });
  assert.equal(stale.body.code, 'web_revision_changed'); assert.equal(f.saves(), 1);
});

test('uncertain execution is persisted across restart and prevents a second dispatch', async () => {
  const f = fixture({ saveFails: true }), auth = await localSession(f), confirmationToken = await preview(f, auth);
  const result = await f.request('/api/mobile/confirm', { method: 'POST', ...auth, data: { confirmationToken } });
  assert.equal(result.status, 202); assert.equal(f.saves(), 1);
  f.restart(); const renewedOwner = await localSession(f);
  const receipt = await f.request('/api/mobile/operation?id=' + result.body.operationId, renewedOwner);
  assert.equal(receipt.body.state, 'UNKNOWN'); assert.equal(receipt.body.automaticReplay, false);
  const blocked = await f.request('/api/mobile/preview', { method: 'POST', ...renewedOwner, data: webInput(f) });
  assert.equal(blocked.body.code, 'previous_outcome_unknown'); assert.equal(f.saves(), 1);
});
