import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { CodexAppServerClient, AppServerError, summarizeReadState } from '../src/adapters/codex-app-server.mjs';
import { runRescue } from '../src/codex-app-server-rescue.mjs';

const allowlist = ['initialize', 'model/list', 'modelProvider/capabilities/read', 'skills/list', 'hooks/list', 'app/installed', 'thread/list', 'thread/start', 'thread/resume', 'thread/read', 'turn/start', 'turn/steer', 'turn/interrupt'];

function fakeProcess() {
  const process = new EventEmitter(); process.stdout = new PassThrough(); process.stderr = new PassThrough();
  process.pid = 4242;
  const writes = [];
  process.stdin = new Writable({ write(chunk, _encoding, callback) { writes.push(JSON.parse(String(chunk))); callback(); } });
  process.stdin.writes = writes; process.killed = false; process.kill = () => { process.killed = true; };
  return process;
}

test('initialize precedes initialized and stable requests', async () => {
  const child = fakeProcess();
  const client = new CodexAppServerClient({ manifest: { codexVersion: '1', productionStableAllowlist: allowlist }, env: { AICC_CODEX_VERSION: '1' }, spawnProcess: () => child });
  const connecting = client.connect();
  assert.equal(child.stdin.writes[0].method, 'initialize');
  const id = child.stdin.writes[0].id;
  child.stdout.write(`${JSON.stringify({ id, result: { platformFamily: 'unix' } })}\n`);
  await connecting;
  assert.equal(child.stdin.writes[1].method, 'initialized');
  client.close();
});

test('experimental or unsupported methods are denied before transport', () => {
  const child = fakeProcess();
  const client = new CodexAppServerClient({ manifest: { codexVersion: '1', productionStableAllowlist: allowlist }, spawnProcess: () => child });
  assert.throws(() => client.request('plugin/install', {}), error => error instanceof AppServerError && error.code === 'method_not_allowlisted');
});

test('original queue inspection enables only the pinned read contract and never enables a sender',async()=>{
 const child=fakeProcess(),threadId='11111111-1111-4111-8111-111111111111';
 const manifest={codexVersion:'1',productionStableAllowlist:['thread/read','thread/queue/list'],
  originalQueueInspection:{method:'thread/queue/list',readOnly:true,senderAllowed:false,
   paramsSchemaSha256:'a'.repeat(64),responseSchemaSha256:'b'.repeat(64)}};
 const client=new CodexAppServerClient({manifest,spawnProcess:()=>child});
 const connected=client.connect();
 assert.equal(child.stdin.writes[0].params.capabilities.experimentalApi,true);
 child.stdout.write(JSON.stringify({id:child.stdin.writes[0].id,result:{}})+'\n');await connected;
 const pending=client.threadQueueListForInspection({threadId,limit:100});
 const wire=child.stdin.writes.at(-1);assert.equal(wire.method,'thread/queue/list');
 child.stdout.write(JSON.stringify({id:wire.id,result:{data:[]}})+'\n');
 assert.deepEqual(await pending,{data:[]});
 assert.throws(()=>client.request('thread/queue/add',{}),/not allowlisted/);
 assert.throws(()=>client.threadQueueListForInspection({threadId,message:'never'}),/read-only queue contract/);
 client.close();
});
test('unregistered or changed queue inspection schema stays nonexperimental and cannot read',async()=>{
 for(const mode of ['absent','changed','sender','allowlist']){
  const child=fakeProcess(),manifest={codexVersion:'1',productionStableAllowlist:['thread/queue/list'],
   originalQueueInspection:{method:'thread/queue/list',readOnly:true,senderAllowed:false,
    paramsSchemaSha256:'a'.repeat(64),responseSchemaSha256:'b'.repeat(64)}};
  if(mode==='absent')delete manifest.originalQueueInspection;
  if(mode==='changed')manifest.originalQueueInspection.paramsSchemaSha256='bad';
  if(mode==='sender')manifest.originalQueueInspection.senderAllowed=true;
  if(mode==='allowlist')manifest.productionStableAllowlist=[];
  const client=new CodexAppServerClient({manifest,spawnProcess:()=>child});
  const connected=client.connect();assert.equal(child.stdin.writes[0].params.capabilities.experimentalApi,false,mode);
  child.stdout.write(JSON.stringify({id:child.stdin.writes[0].id,result:{}})+'\n');await connected;
  assert.throws(()=>client.threadQueueListForInspection({threadId:'11111111-1111-4111-8111-111111111111'}),/read-only queue contract/);
  assert.equal(child.stdin.writes.length,2);client.close();
 }
});

test('explicit user goal resume uses provenance without allowing generic goal mutation', async () => {
  const child=fakeProcess();
  const threadId='01a1c19b-5641-7a50-9168-19e87601b1ef';
  const client=new CodexAppServerClient({manifest:{codexVersion:'1',productionStableAllowlist:allowlist,
    userGoalResume:{method:'thread/goal/set',provenanceField:'origin',paramsSchemaSha256:'a'.repeat(64)}},spawnProcess:()=>child});
  const connected=client.connect();child.stdout.write(JSON.stringify({id:child.stdin.writes[0].id,result:{}})+'\n');await connected;
  assert.throws(()=>client.request('thread/goal/set',{threadId,status:'active'}),/not allowlisted/);
  assert.throws(()=>client.threadGoalResumeForUser({threadId},null),/pinned provenance contract/);
  const pending=client.threadGoalResumeForUser({threadId},{kind:'explicit-user-goal-resume',threadId,reference:'current-user-request'});
  const wire=child.stdin.writes.at(-1);assert.deepEqual(wire.params,{threadId,status:'active',origin:'user'});
  child.stdout.write(JSON.stringify({id:wire.id,result:{goal:{threadId,status:'active'}}})+'\n');
  assert.equal((await pending).goal.status,'active');client.close();
});

test('server error notifications do not trigger EventEmitter fatal error semantics', async () => {
  const child = fakeProcess();
  const client = new CodexAppServerClient({ manifest: { codexVersion: '1', productionStableAllowlist: allowlist }, spawnProcess: () => child });
  const connecting = client.connect();
  child.stdout.write(`${JSON.stringify({ id: child.stdin.writes[0].id, result: {} })}\n`);
  await connecting;
  const observed = new Promise(resolve => client.once('serverError', resolve));
  child.stdout.write(`${JSON.stringify({ method: 'error', params: { error: { type: 'unsupported_route' } } })}\n`);
  assert.deepEqual(await observed, { error: { type: 'unsupported_route' } });
  client.close();
});

test('valid JSONL responses larger than 64 KiB parse without a transport limit', async () => {
  const child = fakeProcess();
  const client = new CodexAppServerClient({ manifest: { codexVersion: '1', productionStableAllowlist: allowlist }, spawnProcess: () => child });
  const connecting = client.connect();
  child.stdout.write(`${JSON.stringify({ id: child.stdin.writes[0].id, result: {} })}\n`);
  await connecting;
  const pending = client.threadList({});
  const request = child.stdin.writes.at(-1);
  const line = `${JSON.stringify({ id: request.id, result: { data: [{ preview: 'x'.repeat(80_000) }] } })}\n`;
  child.stdout.write(line.slice(0, 40_000));
  child.stdout.write(line.slice(40_000));
  const result = await pending;
  assert.equal(result.data[0].preview.length, 80_000);
  client.close();
});

test('invalid JSONL fails pending requests immediately without retaining raw payload', async () => {
  const child = fakeProcess();
  const client = new CodexAppServerClient({ manifest: { codexVersion: '1', productionStableAllowlist: allowlist }, spawnProcess: () => child, timeoutMs: 5_000 });
  const connecting = client.connect();
  child.stdout.write(`${JSON.stringify({ id: child.stdin.writes[0].id, result: {} })}\n`);
  await connecting;
  const protocolError = new Promise(resolve => client.once('protocolError', resolve));
  const pending = client.threadList({});
  child.stdout.write('{"id":2,"result":{"data":[broken]}}\n');
  await assert.rejects(pending, error => error.code === 'protocol_invalid_json');
  const error = await protocolError;
  assert.equal(error.data.rawPayloadIncluded, false);
  assert.equal(error.data.lineBytes, 36);
  assert.equal(error.data.newlineComplete, true);
  assert.equal(error.data.partialWriteSuspected, false);
  assert.equal(error.data.writer.childPid, 4242);
  assert.match(error.data.writer.processStartIdentityHash, /^[a-f0-9]{64}$/);
  assert.match(error.data.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(error).includes('broken'), false);
  assert.equal(child.killed, true);
  child.stdout.write(`${JSON.stringify({ id: 2, result: { data: ['late'] } })}\n`);
});

test('abrupt child close seals an unterminated frame as typed partial-write metadata', async () => {
  const child = fakeProcess();
  const times = [
    '2026-08-23T00:00:00.000Z',
    '2026-08-23T00:00:01.000Z',
    '2026-08-23T00:00:02.000Z',
    '2026-08-23T00:00:03.000Z',
    '2026-08-23T00:00:04.000Z'
  ];
  const client = new CodexAppServerClient({
    manifest: { codexVersion: '1', productionStableAllowlist: allowlist },
    spawnProcess: () => child,
    timeoutMs: 5_000,
    now: () => times.shift() ?? '2026-08-23T00:00:09.000Z'
  });
  const connecting = client.connect();
  child.stdout.write(`${JSON.stringify({ id: child.stdin.writes[0].id, result: {} })}\n`);
  await connecting;
  const protocolError = once(client, 'protocolError');
  const pending = client.threadList({});
  child.stdout.write('{"id":2,"result":{"data":["partial');
  child.stderr.write('private diagnostic text');
  child.emit('exit', 9, 'SIGKILL');
  const stdoutEnded = once(child.stdout, 'end');
  const stderrEnded = once(child.stderr, 'end');
  child.stdout.end();
  child.stderr.end();
  await Promise.all([stdoutEnded, stderrEnded]);
  child.emit('close', 9, 'SIGKILL');

  await assert.rejects(pending, error => error.code === 'protocol_incomplete_jsonl');
  const [error] = await protocolError;
  assert.equal(error.data.newlineComplete, false);
  assert.equal(error.data.partialWriteSuspected, true);
  assert.equal(error.data.writer.processExit.code, 9);
  assert.equal(error.data.writer.processExit.signal, 'SIGKILL');
  assert.equal(error.data.writer.exitBeforeStdoutEnd, true);
  assert.equal(error.data.writer.stderrBytes, 23);
  assert.match(error.data.writer.stderrSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(error).includes('private diagnostic text'), false);
  assert.equal(JSON.stringify(error).includes('{\\"id\\":2,\\"result\\"'), false);
});

test('parallel response burst resolves each request exactly once', async () => {
  const child = fakeProcess();
  const client = new CodexAppServerClient({ manifest: { codexVersion: '1', productionStableAllowlist: allowlist }, spawnProcess: () => child });
  const connecting = client.connect();
  child.stdout.write(`${JSON.stringify({ id: child.stdin.writes[0].id, result: {} })}\n`);
  await connecting;
  const requests = [client.threadList({}), client.modelList({}), client.skillsList({})];
  const ids = child.stdin.writes.slice(-3).map(request => request.id);
  child.stdout.write(ids.map((id, index) => JSON.stringify({ id, result: { index } })).join('\n') + '\n');
  assert.deepEqual(await Promise.all(requests), [{ index: 0 }, { index: 1 }, { index: 2 }]);
  assert.equal(client.pending.size, 0);
  client.close();
});

test('schema mismatch fails before spawning', async () => {
  let spawned = false;
  const client = new CodexAppServerClient({ manifest: { codexVersion: '1', productionStableAllowlist: allowlist }, env: { AICC_CODEX_VERSION: '2' }, spawnProcess: () => { spawned = true; } });
  await assert.rejects(client.connect(), error => error.code === 'schema_version_mismatch');
  assert.equal(spawned, false);
});

test('summary excludes conversation and auth material', () => {
  assert.deepEqual(summarizeReadState({ models: { data: [1] }, skills: { data: [1, 2] }, threads: { data: [1] } }), { modelCount: 1, providerCount: null, skillCount: 2, hookCount: null, appCount: null, threadCount: 1, conversationBodiesIncluded: false, authMaterialIncluded: false });
});

test('writer lease downgrades requested write rescue to read-only', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-rescue-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'manifest.json'); fs.writeFileSync(manifest, JSON.stringify({ codexVersion: '1', productionStableAllowlist: allowlist }));
  const lease = path.join(root, 'writer.lock'); fs.writeFileSync(lease, 'held');
  class FakeClient { async connect() { return {}; } modelList(){return {data:[]}} providerCapabilities(){return {}} skillsList(){return {data:[]}} hooksList(){return {data:[]}} appsInstalled(){return {data:[]}} threadList(){return {data:[]}} close(){} }
  const result = await runRescue({ route: 'native-direct', 'profile-home': root, workspace: root, mode: 'write', manifest, 'writer-lease': lease, 'base-url': 'https://chatgpt.com/backend-api/codex' }, { Client: FakeClient });
  assert.equal(result.mode, 'read-only');
});

test('route label and endpoint mismatch fails before client startup', async () => {
  await assert.rejects(runRescue({ route: 'web-gpt-direct', 'profile-home': '/tmp', workspace: '/tmp', mode: 'read-only', manifest: '/missing', 'base-url': 'http://127.0.0.1:17841/v1' }), /cannot depend on 17841/);
});
test('pinned official quota read uses only rateLimits/read, never turn/start or account mutation',async()=>{
 const child=fakeProcess();
 const contract={method:'account/rateLimits/read',generatedClientRequestSha256:'a'.repeat(64),
   readOnly:true,originalCliIssuerBound:false,quotaRecoveryAuthority:false,senderAllowed:false};
 const client=new CodexAppServerClient({manifest:{codexVersion:'1',
   productionStableAllowlist:[...allowlist,'account/rateLimits/read'],officialQuotaRead:contract},
   spawnProcess:()=>child});
 const init=client.connect();
 child.stdout.write(JSON.stringify({id:child.stdin.writes[0].id,result:{}})+'\n');
 await init;
 const queried=client.rateLimitsReadForInspection();
 const wire=child.stdin.writes.at(-1);
 assert.deepEqual({method:wire.method,params:wire.params},
   {method:'account/rateLimits/read',params:{}});
 child.stdout.write(JSON.stringify({id:wire.id,result:{rateLimits:{limitId:'codex'}}})+'\n');
 assert.deepEqual(await queried,{rateLimits:{limitId:'codex'}});
 assert.equal(child.stdin.writes.filter(m=>m.method==='turn/start').length,0);
 assert.throws(()=>client.request('account/logout',{}),/not allowlisted/);
 client.close();
 const unpinned=new CodexAppServerClient({manifest:{codexVersion:'1',
   productionStableAllowlist:[...allowlist,'account/rateLimits/read']}});
 assert.throws(()=>unpinned.rateLimitsReadForInspection(),
   e=>e instanceof AppServerError&&e.code==='quota_read_contract_required');
});
test('same owned App Server failed turn creates pinned private-free five-hour receipt and fresh read admission',async()=>{
 const child=fakeProcess(),threadId='01a1c19b-5641-7a50-9168-19e87601b1ef',
       turnId='ababaaba-aaaa-4aaa-baaa-aaaaaaaaaaaa';
 const start=Date.parse('2026-11-14T00:00:00.000Z');
 const reset=Math.floor(Date.parse('2026-11-14T01:00:00.000Z')/1000);
 let observed=start;
 const manifest={codexVersion:'0.167.0',executableSha256:'a'.repeat(64),
  productionStableAllowlist:[...allowlist,'account/rateLimits/read'],
  officialQuotaRead:{method:'account/rateLimits/read',readOnly:true,originalCliIssuerBound:false,
    quotaRecoveryAuthority:false,senderAllowed:false,generatedClientRequestSha256:'b'.repeat(64)}};
 const client=new CodexAppServerClient({manifest,spawnProcess:()=>child,
  now:()=>new Date(observed).toISOString()});
 const connecting=client.connect();
 child.stdout.write(JSON.stringify({id:child.stdin.writes[0].id,result:{}})+'\n');await connecting;
 const ownerContext={kind:'aicc-original-cli-owner-context/v1',threadId,
  projectRoot:process.cwd(),goalSnapshotSha256:'c'.repeat(64),
  ownerRevision:'d'.repeat(64),stopEpoch:8,issuerReceiptSha256:'e'.repeat(64),
  route:'official-codex-to-17841-to-nonweb-OCX10101',quotaLimitId:'codex'};
 child.stdout.write(JSON.stringify({method:'turn/started',params:{threadId,
   turn:{id:turnId,status:'inProgress'}}})+'\n');
 child.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId,
  turn:{id:turnId,status:'failed',error:{codexErrorInfo:'usageLimitExceeded',
    message:'PRIVATE-UPSTREAM-ERROR'}}}})+'\n');
 const pending=client.captureOwnedFiveHourFailure({threadId,turnId,ownerContext});
 const wire=child.stdin.writes.at(-1);
 assert.equal(wire.method,'account/rateLimits/read');assert.deepEqual(wire.params,{});
 child.stdout.write(JSON.stringify({id:wire.id,result:{accountId:'private_account_identifier',
  ordinaryUsageAllowed:false,rateLimitsByLimitId:{codex:{limitId:'codex',
    secondary:{windowDurationMins:300,usedPercent:100,resetsAt:reset},
    rateLimitReachedType:'rate_limit_reached'}}}})+'\n');
 const failure=await pending;
 assert.equal(failure.failedTurnId,turnId);
 assert.equal(failure.quota.ordinaryUsageAllowed,false);
 assert.equal(failure.originalOcxIssuerVerified,false);
 assert.equal(failure.dispatchable,false);
 assert.equal(JSON.stringify(failure).includes('PRIVATE-UPSTREAM-ERROR'),false);
 assert.equal(JSON.stringify(failure).includes('private_account_identifier'),false);
 observed=(reset*1000)+1500;
 const recovering=client.captureOwnedFreshQuotaAdmission({failureReceipt:failure});
 const fresh=child.stdin.writes.at(-1);assert.equal(fresh.method,'account/rateLimits/read');
 child.stdout.write(JSON.stringify({id:fresh.id,result:{accountId:'private_account_identifier',
  ordinaryUsageAllowed:true,rateLimitsByLimitId:{codex:{limitId:'codex',
    secondary:{windowDurationMins:300,usedPercent:3,resetsAt:reset+18000},
    rateLimitReachedType:null}}}})+'\n');
 const admitted=await recovering;
 assert.equal(admitted.quota.ordinaryUsageAllowed,true);
 assert.equal(admitted.quota.accountIdSha256,failure.quota.accountIdSha256);
 assert.equal(admitted.originalOcxIssuerVerified,false);
 assert.equal(admitted.modelRequests,0);assert.equal(admitted.newTurns,0);
 assert.equal(child.stdin.writes.some(w=>['turn/start','thread/goal/set'].includes(w.method)),false);
 client.close();
});
test('original owner failure collector rejects absent/changed turn, ordinary quota and foreign account',async()=>{
 const child=fakeProcess(),threadId='01a1c19b-5641-7a50-9168-19e87601b1ef';
 const client=new CodexAppServerClient({manifest:{codexVersion:'0.167.0',
   productionStableAllowlist:[...allowlist,'account/rateLimits/read'],
   officialQuotaRead:{method:'account/rateLimits/read',readOnly:true,
     originalCliIssuerBound:false,quotaRecoveryAuthority:false,senderAllowed:false,
     generatedClientRequestSha256:'c'.repeat(64)}},spawnProcess:()=>child});
 const init=client.connect();child.stdout.write(JSON.stringify({id:child.stdin.writes[0].id,result:{}})+'\n');await init;
 const context={kind:'aicc-original-cli-owner-context/v1',threadId,projectRoot:process.cwd(),
   goalSnapshotSha256:'1'.repeat(64),ownerRevision:'2'.repeat(64),stopEpoch:0,
   issuerReceiptSha256:'3'.repeat(64),
   route:'official-codex-to-17841-to-nonweb-OCX10101',quotaLimitId:'codex'};
 await assert.rejects(client.captureOwnedFiveHourFailure({
  threadId,turnId:'ababaaba-aaaa-4aaa-baaa-aaaaaaaaaaaa',ownerContext:context}),
  e=>e.code==='original_failed_turn_unproven');
 assert.equal(child.stdin.writes.filter(w=>w.method==='account/rateLimits/read').length,0);
 const wrong={...context,stopEpoch:-1};
 await assert.rejects(client.captureOwnedFiveHourFailure({
  threadId,turnId:'ababaaba-aaaa-4aaa-baaa-aaaaaaaaaaaa',ownerContext:wrong}),
  e=>e.code==='original_sender_context_unverified');
 client.close();
});

test('owned source sealer creates exactly one canonical SHA-pinned failure/admission pair without sender authority',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-owned-appserver-source-seal-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const client=new CodexAppServerClient();
 const failure={schemaVersion:1,kind:'aicc-app-server-owned-five-hour-failure/v1',
  originalOcxIssuerVerified:false,dispatchable:false,modelRequests:0,newTurns:0,
  ownerContext:{kind:'aicc-original-cli-owner-context/v1'},quota:{usedPercent:100}};
 const failureFile=path.join(dir,'failed.json'),admissionFile=path.join(dir,'admitted.json');
 client.captureOwnedFiveHourFailure=async()=>failure;
 const first=await client.sealOwnedFiveHourFailure({outputFile:failureFile});
 assert.equal(first.status,'OWNED_APP_SERVER_SOURCE_SEALED_NOT_ORIGINAL_ISSUER');
 assert.equal(first.originalOcxIssuerVerified,false);
 assert.deepEqual(JSON.parse(fs.readFileSync(failureFile,'utf8')),failure);
 assert.equal(fs.readFileSync(failureFile,'utf8'),JSON.stringify(failure));
 await assert.rejects(client.sealOwnedFiveHourFailure({outputFile:failureFile}));
 client.captureOwnedFreshQuotaAdmission=async({failureReceipt})=>({
  schemaVersion:1,kind:'aicc-app-server-owned-five-hour-admission/v1',
  originalOcxIssuerVerified:false,dispatchable:false,modelRequests:0,newTurns:0,
  failureReceiptSha256:first.outputSha256,sourceFailureWas:failureReceipt.kind});
 const admitted=await client.sealOwnedFreshQuotaAdmission({
  failureFile,expectedFailureFileSha256:first.outputSha256,outputFile:admissionFile});
 assert.equal(admitted.dispatchable,false);
 assert.equal(admitted.newTurns,0);
 assert.equal(JSON.parse(fs.readFileSync(admissionFile,'utf8')).failureReceiptSha256,
  first.outputSha256);
 await assert.rejects(client.sealOwnedFreshQuotaAdmission({
  failureFile,expectedFailureFileSha256:'0'.repeat(64),
  outputFile:path.join(dir,'bad.json')}),e=>e.code==='quota_failure_sha_changed');
 assert.equal(fs.existsSync(path.join(dir,'bad.json')),false);
});
