import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWebManagementExecutor, prepareWebManagementRequest } from '../components/workspace-mcp/web-management-provider.mjs';
import { createWorkspaceMcpServer } from '../components/workspace-mcp/server.mjs';
import { workspaceToolSnapshot } from '../components/workspace-mcp/tool-manifest.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const parent = process.env.AICC_WEB_MANAGEMENT_TEST_ROOT;
  assert.ok(parent && path.isAbsolute(parent), 'Explicit owner test directory required');
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  const workspace = { alias: 'test-management', root: path.join(root, 'workspace') };
  const owner = path.join(root, 'owner');
  const operations = path.join(owner, 'operations');
  fs.mkdirSync(workspace.root); fs.mkdirSync(owner); fs.mkdirSync(operations);
  const write = (file, value) => { fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const pin = name => { const file = write(path.join(owner, name), 'fixed ' + name); return { path: file, sha256: hash(fs.readFileSync(file)) }; };
  const node = pin('node.exe'), entry = pin('manager.mjs'), settings = pin('config.json'), dependency = pin('dependency.mjs');
  const binding = {
    schemaVersion: 1, kind: 'aicc-web-management-owner-binding', bindingId: 'binding-test-001',
    executionBoundary: 'owner-registered-fixed-web-manager',
    workspaceAlias: workspace.alias, workspaceRoot: workspace.root,
    account: 'test-account', identityHash: 'a'.repeat(64), workspaceIdentityHash: 'b'.repeat(64),
    allowedActions: ['project-inspect', 'project-create', 'project-upload', 'instructions-inspect'],
    blockedRequestHashes: [], blockedAssetKeys: [],
    node: node.path, nodeSha256: node.sha256,
    entry: entry.path, entrySha256: entry.sha256,
    config: settings.path, configSha256: settings.sha256,
    dependencyPins: [dependency], operationDirectory: operations, timeoutMs: 10000
  };
  const bindingFile = path.join(owner, 'binding.json');
  const config = { surfaceProfile: 'business-full', webManagement: { enabled: true, bindingFile } };
  const refreshBinding = () => { write(bindingFile, binding); config.webManagement.bindingSha256 = hash(fs.readFileSync(bindingFile)); };
  refreshBinding();
  const calls = [];
  const spawn = (...args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; return true; };
    calls.push({ args, child }); return child;
  };
  const executor = createWebManagementExecutor(config, { spawn });
  const request = (raw, id = 'request-test-001') => {
    const file = write(path.join(workspace.root, id + '.json'), raw);
    return { request_id: id, request_path: path.basename(file), request_sha256: hash(fs.readFileSync(file)) };
  };
  const complete = (value, exitCode = 0) => {
    const last = calls.at(-1);
    const prepared = JSON.parse(fs.readFileSync(last.args[1][1]));
    write(prepared.resultFile, value); last.child.emit('close', exitCode);
  };
  return { root, owner, workspace, operations, config, binding, refreshBinding, calls, executor, request, complete, write };
}
function mutationRequest(f,id='request-test-001'){
 const bundle=f.write(path.join(f.workspace.root,'bundle.json'),{});
 const receipt=f.write(path.join(f.workspace.root,'receipt.json'),{bundlePath:bundle});
 return f.request({schemaVersion:1,action:'project-create',name:'w-disposable',memory:'default',commit:true,backupReceipt:receipt},id);
}

test('named manager is unavailable by default and personal read-only profiles never expose it', () => {
  const f = fixture();
  const input = f.request({ schemaVersion: 1, action: 'instructions-inspect' });
  assert.throws(() => createWebManagementExecutor({}).start(f.workspace, input), /not owner-bound/);
  f.config.surfaceProfile = 'personal-read-fetch';
  assert.throws(() => f.executor.start(f.workspace, input), /not owner-bound/);
  const names = profile => workspaceToolSnapshot({ surfaceProfile: profile, webManagementAvailable: true }).tools.map(tool => tool.name);
  assert.ok(!workspaceToolSnapshot().tools.some(tool => tool.name.startsWith('aicc_web_management')));
  assert.ok(!names('personal-read-fetch').some(name => name.startsWith('aicc_web_management')));
  assert.ok(names('business-full').includes('aicc_web_management_start'));
  assert.equal(f.calls.length, 0);
});

test('fixed runner binds identity, passes no shell and reconciles the same request without another dispatch', () => {
  const f = fixture();
  const input = f.request({ schemaVersion: 1, action: 'instructions-inspect' });
  assert.equal(f.executor.start(f.workspace, input).status, 'DISPATCHING');
  assert.equal(f.executor.start(f.workspace, input).status, 'DISPATCHING');
  assert.equal(f.calls.length, 1);
  const [executable, args, options] = f.calls[0].args;
  assert.equal(executable, f.binding.node); assert.equal(args[0], f.binding.entry);
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.equal(options.env.NODE_OPTIONS, '');
  const prepared = JSON.parse(fs.readFileSync(args[1]));
  assert.equal(prepared.config, f.binding.config); assert.equal(prepared.account, f.binding.account);
  assert.equal(prepared.identityHash, f.binding.identityHash);
  f.complete({ status: 'INSPECTED', before: { fields: [] } });
  assert.equal(f.executor.status(f.workspace, input.request_id).result.status, 'INSPECTED');
  assert.equal(f.executor.start(f.workspace, input).status, 'COMPLETED');
  assert.equal(f.calls.length, 1);
  assert.equal(fs.existsSync(path.join(f.operations, 'writer.lock')), false);
});

test('input and code pin changes reject before any process creation', () => {
  const f = fixture();
  const request = f.request({ schemaVersion: 1, action: 'instructions-inspect', config: 'other-config' });
  assert.throws(() => f.executor.start(f.workspace, request), /Unknown management/);
  const safe = f.request({ schemaVersion: 1, action: 'instructions-inspect' }, 'request-test-002');
  assert.throws(() => f.executor.start(f.workspace, { ...safe, request_sha256: '0'.repeat(64) }), /Exact request/);
  assert.throws(() => f.executor.start(f.workspace, { ...safe, request_id: 'unsafe:stream' }), /Invalid management request ID/);
  assert.throws(() => f.executor.start(f.workspace, { ...safe, request_path: '../outside.json' }), /bounded non-hidden/);
  assert.throws(() => f.executor.start(f.workspace, { ...safe, request_path: 'request:stream' }), /bounded non-hidden/);
  f.write(f.binding.entry, 'changed');
  assert.throws(() => f.executor.start(f.workspace, safe), /pin changed/);
  assert.equal(f.calls.length, 0);
});

test('Project memory, exact Source bytes and nested fields are bounded', () => {
  const f = fixture();
  const bundle = f.write(path.join(f.workspace.root, 'bundle.json'), {});
  const receipt = f.write(path.join(f.workspace.root, 'receipt.json'), { bundlePath: bundle });
  const base = { schemaVersion: 1, action: 'project-create', name: 'w-테스트', memory: 'default', instructions: 'test', commit: true, backupReceipt: receipt };
  const prepare = raw => prepareWebManagementRequest(raw, f.binding, f.workspace, path.join(f.operations, 'result.json'));
  assert.equal(prepare(base).memory, 'default');
  assert.throws(() => prepare({ ...base, memory: 'project-only' }), /default memory/);
  assert.throws(() => prepare({ ...base, name: 'w-w-duplicate' }), /one w- prefix/);
  assert.throws(() => prepare({ ...base, desired: { command: 'arbitrary' } }), /Unknown desired/);
  assert.throws(() => prepare({ ...base, backupReceipt: f.binding.config }), /registered non-hidden workspace/);
  const sourceFile = f.write(path.join(f.workspace.root, 'source.txt'), 'source bytes');
  const source = { filename: 'source.txt', path: sourceFile, sha256: hash('source bytes'), sizeBytes: 12 };
  assert.equal(prepare({ ...base, sources: [source] }).sources.length, 1);
  assert.throws(() => prepare({ ...base, sources: [{ ...source, sha256: '0'.repeat(64) }] }), /bytes differ/);
  assert.throws(() => prepare({ ...base, sources: [{ ...source, filename: '../file' }] }), /metadata/);
});

test('previously denied hashes and exact targets cannot be replayed', () => {
  const f = fixture();
  const input = f.request({ schemaVersion: 1, action: 'instructions-inspect' });
  f.binding.blockedRequestHashes.push(input.request_sha256); f.refreshBinding();
  assert.throws(() => f.executor.start(f.workspace, input), /denied request/);
  f.binding.blockedRequestHashes = []; f.binding.blockedAssetKeys = ['instructions|' + f.binding.account + '|personalization']; f.refreshBinding();
  assert.throws(() => f.executor.start(f.workspace, input), /denied management target/);
  assert.equal(f.calls.length, 0);
});

test('a fixed manager inside the remote writable root cannot become authority', () => {
  const f = fixture();
  const entry = f.write(path.join(f.workspace.root, 'writable-entry.mjs'), 'bad authority');
  f.binding.entry = entry; f.binding.entrySha256 = hash('bad authority'); f.refreshBinding();
  assert.throws(() => f.executor.start(f.workspace, f.request({ schemaVersion: 1, action: 'instructions-inspect' })), /code and config must be outside/);
  assert.equal(f.calls.length, 0);
});

test('unknown manager results retain the writer lock and never auto-retry', () => {
  const f = fixture();
  const input = mutationRequest(f);
  f.executor.start(f.workspace, input); f.complete({ status: 'OUTCOME_UNKNOWN_RECONCILE' });
  assert.equal(f.executor.status(f.workspace, input.request_id).status, 'OUTCOME_UNKNOWN_RECONCILE');
  assert.equal(f.executor.start(f.workspace, input).status, 'OUTCOME_UNKNOWN_RECONCILE');
  assert.throws(() => f.executor.start(f.workspace, mutationRequest(f,'request-test-002')), /reconciliation/);
  assert.equal(f.calls.length, 1);
  assert.equal(fs.existsSync(path.join(f.operations, 'writer.lock')), true);
});

test('output overflow retains the result boundary without killing a browser worker mid-save', () => {
  const f = fixture(); f.binding.maximumOutputBytes = 8; f.refreshBinding();
  const input = mutationRequest(f);
  f.executor.start(f.workspace, input);
  const child = f.calls[0].child;
  child.stdout.write(Buffer.alloc(9));
  const observed = f.executor.status(f.workspace, input.request_id);
  assert.equal(observed.status, 'OUTCOME_UNKNOWN_RECONCILE');
  assert.equal(observed.running, true); assert.equal(child.killed, undefined);
  f.complete({ status: 'INSPECTED' });
  assert.equal(f.executor.status(f.workspace, input.request_id).status, 'OUTCOME_UNKNOWN_RECONCILE');
  assert.equal(fs.existsSync(path.join(f.operations, 'writer.lock')), true);
});
test('a restarted provider preserves an unobserved dispatch instead of sending again', () => {
  const f = fixture();
  const input = f.request({ schemaVersion: 1, action: 'instructions-inspect' });
  const record = { schemaVersion: 1, phase: 'DISPATCHING', bindingId: f.binding.bindingId, workspaceAlias: f.workspace.alias, requestSHA256: input.request_sha256 };
  f.write(path.join(f.operations, input.request_id + '.json'), record);
  assert.equal(f.executor.start(f.workspace, input).status, 'OUTCOME_UNKNOWN_RECONCILE');
  assert.equal(f.calls.length, 0);
});

test('MCP advertises the extra tools only for an explicitly enabled business binding', async () => {
  for (const [enabled, profile, expected] of [[false, 'business-full', 0], [true, 'business-full', 2], [true, 'personal-read-fetch', 0]]) {
    const f = fixture();
    const server = createWorkspaceMcpServer({ ...f.config, surfaceProfile: profile, webManagement: { ...f.config.webManagement, enabled }, workspaces: [f.workspace], permissions: { commands: false } }, { runtimeRoot: f.owner, remoteAuthority: { reconcileStartup() {} } });
    const client = new Client({ name: 'management-fixture', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a); await client.connect(b);
      const tools = (await client.listTools()).tools.filter(tool => tool.name.startsWith('aicc_web_management'));
      assert.equal(tools.length, expected);
      if (expected) {
        assert.equal(tools.find(tool => tool.name.endsWith('_start')).annotations.destructiveHint, true);
        assert.ok(tools.find(tool => tool.name.endsWith('_status')).inputSchema.properties.operation_id);
      }
    } finally { await client.close(); await server.close(); }
  }
});

test('personal skill reads need no backup and cannot supply execution or account fields', () => {
  const f=fixture();f.binding.allowedActions.push('personal-skill-list','personal-skill-inspect');f.refreshBinding();
  const raw={schemaVersion:1,action:'personal-skill-list',skill:{}};
  const prepare=value=>prepareWebManagementRequest(value,f.binding,f.workspace,path.join(f.operations,'result.json'));
  assert.equal(prepare(raw).account,f.binding.account);
  assert.throws(()=>prepare({...raw,skill:{config:f.binding.config}}),/Unknown personal skill/);
  const request=f.request(raw);f.executor.start(f.workspace,request);f.complete({status:'listed',rows:[]});
  assert.equal(f.executor.status(f.workspace,request.request_id).status,'COMPLETED');
});

test('personal skill file bytes and title output stay within the registered workspace', () => {
  const f=fixture();f.binding.allowedActions.push('personal-skill-upload','title-read');
  const prepare=value=>prepareWebManagementRequest(value,f.binding,f.workspace,path.join(f.operations,'result.json'));
  const file=f.write(path.join(f.workspace.root,'skill.zip'),'package');
  const base={schemaVersion:1,action:'personal-skill-upload',skill:{name:'example',file,fileSHA256:hash('changed')}};
  assert.throws(()=>prepare(base),/Exact personal skill file bytes/);
  assert.throws(()=>prepare({...base,skill:{...base.skill,file:f.binding.entry}}),/registered non-hidden workspace/);
  const title={explicitUserRequest:'Read this selected chat',conversationId:'example-conversation'};
  assert.throws(()=>prepare({schemaVersion:1,action:'title-read',title:{...title,outputDirectory:f.owner}}),/registered non-hidden directory/);
  assert.throws(()=>prepare({schemaVersion:1,action:'title-read',title:{...title,outputDirectory:path.join(f.workspace.root,'.hidden')}}),/registered non-hidden directory/);
});

test('title management requires an explicit request and bounded content-reading evidence', () => {
  const f=fixture();f.binding.allowedActions.push('title-inventory','title-read');
  const prepare=value=>prepareWebManagementRequest(value,f.binding,f.workspace,path.join(f.operations,'result.json'));
  assert.throws(()=>prepare({schemaVersion:1,action:'title-inventory',title:{filters:{titleContains:'example'}}}),/Explicit bounded/);
  assert.throws(()=>prepare({schemaVersion:1,action:'title-read',title:{explicitUserRequest:'Read it',contentEvidence:{method:'local-import',sourcePath:f.binding.entry,sha256:hash('x')}}}),/registered non-hidden workspace/);
  assert.equal(prepare({schemaVersion:1,action:'title-inventory',title:{explicitUserRequest:'Rename matching chats',filters:{titleContains:'example'}}}).title.filters.titleContains,'example');
});

test('failed read diagnostics never claim a writer lock or replay the failed request', () => {
  const f=fixture(),request=f.request({schemaVersion:1,action:'instructions-inspect'});
  f.executor.start(f.workspace,request);f.complete({status:'HOLD',reason:'Managed helper unavailable',action:'instructions-inspect'},1);
  const status=f.executor.status(f.workspace,request.request_id);
  assert.equal(status.failure.reason,'Managed helper unavailable');assert.equal(status.result,null);
  assert.equal(status.status,'OUTCOME_UNKNOWN_RECONCILE');assert.equal(status.automaticRetry,false);
  assert.equal(fs.existsSync(path.join(f.operations,'writer.lock')),false);assert.equal(f.calls.length,1);
});
test('read-only reconciliation succeeds while an unknown mutation remains locked',()=>{
 const f=fixture(),mutation=mutationRequest(f);
 f.executor.start(f.workspace,mutation);f.complete({status:'HOLD_UPLOAD_POSTREAD'});
 const lock=path.join(f.operations,'writer.lock'),original=fs.readFileSync(lock,'utf8');
 const read=f.request({schemaVersion:1,action:'instructions-inspect'},'request-test-read');
 assert.equal(f.executor.start(f.workspace,read).status,'DISPATCHING');
 f.complete({status:'INSPECTED'});
 assert.equal(f.executor.status(f.workspace,read.request_id).status,'COMPLETED');
 assert.equal(fs.readFileSync(lock,'utf8'),original);
 assert.equal(f.executor.status(f.workspace,mutation.request_id).status,'OUTCOME_UNKNOWN_RECONCILE');
 assert.throws(()=>f.executor.start(f.workspace,mutationRequest(f,'request-test-again')),/reconciliation/);
 assert.equal(f.calls.length,2);
});
test('a failed read cannot delete or replace another mutation writer lock',()=>{
 const f=fixture(),mutation=mutationRequest(f);
 f.executor.start(f.workspace,mutation);f.complete({status:'OUTCOME_UNKNOWN_RECONCILE'});
 const lock=path.join(f.operations,'writer.lock'),original=fs.readFileSync(lock,'utf8');
 const read=f.request({schemaVersion:1,action:'instructions-inspect'},'request-test-failed-read');
 f.executor.start(f.workspace,read);f.complete({status:'HOLD',reason:'Read unavailable'},1);
 assert.equal(fs.readFileSync(lock,'utf8'),original);
 assert.equal(f.executor.status(f.workspace,read.request_id).failure.reason,'Read unavailable');
});
test('uncertain upload status returns bounded mutation evidence without arbitrary manager data',()=>{
 const f=fixture(),request=mutationRequest(f);
 f.executor.start(f.workspace,request);
 f.complete({status:'HOLD_UPLOAD_POSTREAD',remoteMutation:true,privateData:'not exposed',requests:[{method:'POST',status:201,path:'/backend-api/hazelnuts/uploads/create',headers:{Authorization:'not exposed'}},{method:'GET',status:429,path:'/backend-api/example?token=not-exposed'}]});
 const result=f.executor.status(f.workspace,request.request_id);
 assert.equal(result.status,'OUTCOME_UNKNOWN_RECONCILE');
 assert.equal(result.failure.status,'HOLD_UPLOAD_POSTREAD');assert.equal(result.failure.remoteMutation,true);
 assert.deepEqual(result.failure.requests,[{method:'POST',status:201,path:'/backend-api/hazelnuts/uploads/create'}]);
 assert.equal(JSON.stringify(result).includes('not exposed'),false);
 assert.equal(fs.existsSync(path.join(f.operations,'writer.lock')),true);
});

test('new personal support-file requests retain source pins and require exact plan/apply authority', () => {
  const f=fixture();
  const bodyFile=f.write(path.join(f.workspace.root,'reference.md'),'# Reference\n\nNew content.\n');
  const bundle=f.write(path.join(f.workspace.root,'bundle.json'),{});
  const backupReceipt=f.write(path.join(f.workspace.root,'receipt.json'),{bundlePath:bundle});
  const skill={name:'example',displayName:'Example',skillId:'skill-test-0001',filePath:'references/new-reference.md',bodyFile,bodyFileSHA256:hash(fs.readFileSync(bodyFile))};
  const plan={schemaVersion:1,action:'personal-skill-plan-add-file',skill,backupReceipt};
  const prepare=raw=>prepareWebManagementRequest(raw,f.binding,f.workspace,path.join(f.operations,'result.json'));
  assert.throws(()=>prepare(plan),/outside its owner binding/);
  f.binding.allowedActions.push('personal-skill-plan-add-file','personal-skill-add-file');f.refreshBinding();
  assert.equal(prepare(plan).skill.bodyFileSHA256,skill.bodyFileSHA256);
  assert.throws(()=>prepare({...plan,commit:true}),/cannot commit/);
  const apply={...plan,action:'personal-skill-add-file',commit:true,confirm:'ADD-FILE:'+skill.skillId+':'+skill.filePath,
    skill:{...skill,expectedCurrentSha:'a'.repeat(64),expectedTreeSha:'b'.repeat(64)}};
  assert.equal(prepare(apply).skill.bodyFileSHA256,skill.bodyFileSHA256);
  for(const invalid of [{...apply,confirm:'ADD-FILE:other'}, {...apply,skill:{...apply.skill,expectedTreeSha:undefined}},
    {...apply,skill:{...apply.skill,filePath:'references/../unsafe.md'}}, {...apply,skill:{...apply.skill,bodyFileSHA256:'0'.repeat(64)}},
    {...apply,skill:{...apply.skill,planRequestId:'request-other'}}])assert.throws(()=>prepare(invalid));
  f.binding.blockedAssetKeys.push('skill|'+f.binding.account+'|'+skill.name);
  assert.throws(()=>prepare(apply),/denied management target/);
  assert.equal(f.calls.length,0);
});