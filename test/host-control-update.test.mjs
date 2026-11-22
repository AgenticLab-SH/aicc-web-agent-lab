import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareHostUpdate, hostToolHash } from '../components/host-control/prepare-update.mjs';
import { HOST_TOOLS } from '../components/host-control/server.mjs';
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-host-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const command = put('runtime/node.exe', 'fake-node');
  const binding = put('owner/binding.json', { identity: 'unchanged' });
  const configFile = put('workspace-mcp/config.json', { webManagement: { enabled: true, bindingFile: binding, bindingSha256: hash(binding) }, unrelated: 'preserved' });
  const gateway = path.join(root, 'releases/unified-mcp/current');
  const hostConfig = put('owner/host.json', { schemaVersion: 1, scope: 'task-owned-v1', stateRoot: path.join(root, 'private-journals') });
  const providers = ['workspace', 'native', 'host'].map(id => {
    const entrypoint = put(`provider/${id}.cjs`, id);
    const args = id === 'host' ? [entrypoint, '--config', hostConfig] : [entrypoint];
    const files = [command, entrypoint, ...(id === 'host' ? [hostConfig] : [])].map(file => ({ path: file, sha256: hash(file) }));
    return { id, command, entrypoint, args, files, toolNames: [id + '_old'], toolHash: 'a'.repeat(64), unknownMetadata: id };
  });
  const before = { schemaVersion: 1, surfaceProfile: 'business-full', hostControl: 'task-owned-v1', providers, workspaceIdentityHash: 'b'.repeat(64), diagnosticPath: 'preserved' };
  put('releases/unified-mcp/current/config.json', before);
  const entry = put('releases/unified-mcp/current/gateway.cjs', 'exact-existing-gateway');
  put('releases/unified-mcp/current/auxiliary.txt', 'preserve-manifest-entry');
  put('releases/unified-mcp/current/manifest.json', { schemaVersion: 1, releaseHash: 'old', metadata: 'keep', files: Object.fromEntries(['gateway.cjs', 'config.json', 'auxiliary.txt'].map(name => [name, hash(path.join(gateway, name))])) });
  const registryFile = put('runtime/components.json', { components: { workspace: { releaseRoot: path.join(root, 'releases/workspace/current') }, 'unified-mcp': { releaseRoot: gateway, entry, entryHash: hash(entry) }, foreign: { unchanged: true } } });
  fs.mkdirSync(path.join(root, 'releases/workspace/current'), { recursive: true });
  const profile = put('workspace-mcp/tunnel/profiles/aicc-workspace.yaml', `entry: '${gateway}\\gateway.cjs'\nconfig: '${gateway}\\config.json'\n`);
  const inputs = [registryFile, configFile, profile, path.join(gateway, 'manifest.json'), hostConfig].map(file => [file, hash(file)]);
  const buildHost = async ({ output }) => fs.writeFileSync(output, 'fixture-bundle');
  const operationDirectory = path.join(root, 'asset-control/host-update');
  return { root, gateway, before, inputs, buildHost, operationDirectory, put };
}

test('host replacement preserves graph order, other providers, owner config and every old manifest entry', async t => {
  const f = fixture(t);
  const result = await prepareHostUpdate({ stateRoot: f.root, operationDirectory: f.operationDirectory, buildHost: f.buildHost });
  assert.equal(result.status, 'PREPARED_NOT_ACTIVE');
  assert.equal(result.liveCutover, false);
  const next = JSON.parse(fs.readFileSync(path.join(result.gateway, 'config.json')));
  assert.deepEqual(next.providers.map(p => p.id), f.before.providers.map(p => p.id));
  assert.deepEqual(next.providers.filter(p => p.id !== 'host'), f.before.providers.filter(p => p.id !== 'host'));
  const host = next.providers.find(p => p.id === 'host');
  assert.deepEqual(host.toolNames, HOST_TOOLS.map(tool => tool.name));
  assert.equal(host.toolHash, hostToolHash(HOST_TOOLS));
  assert.equal(host.args[2], f.before.providers[2].args[2]);
  assert.equal(hash(path.join(result.gateway, 'gateway.cjs')), hash(path.join(f.gateway, 'gateway.cjs')));
  const manifest = JSON.parse(fs.readFileSync(path.join(result.gateway, 'manifest.json')));
  assert.equal(manifest.metadata, 'keep');
  assert.equal(manifest.files['auxiliary.txt'], hash(path.join(f.gateway, 'auxiliary.txt')));
  assert.ok(f.inputs.every(([file, digest]) => hash(file) === digest));
  await assert.rejects(prepareHostUpdate({ stateRoot: f.root, operationDirectory: f.operationDirectory, buildHost: f.buildHost }), /OPERATION_EXISTS_RECONCILE/);
});

test('missing host and changed dependency fail before creating an operation', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.before.providers[0].entrypoint, 'changed');
  await assert.rejects(prepareHostUpdate({ stateRoot: f.root, operationDirectory: f.operationDirectory, buildHost: f.buildHost }), /PROVIDER_PIN_CHANGED/);
  assert.equal(fs.existsSync(f.operationDirectory), false);
});

test('host updater validates prepared graph and rejects unrelated provider and profile mutations', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const result = await prepareHostUpdate({ stateRoot: f.root, operationDirectory: f.operationDirectory, buildHost: f.buildHost });
  const updater = fs.readFileSync(new URL('../tools/platform/workspace-mcp/Update-AiccWebManagementRuntime.ps1', import.meta.url), 'utf8');
  // Load only existing pure validation helpers, never the updater's operational entrypoint.
  const helpers = updater.slice(updater.indexOf('function Regular('), updater.indexOf('$OperationDirectory=[IO.Path]::GetFullPath'));
  const script = path.join(f.root, 'validate.ps1');
  const candidateFile = path.join(f.operationDirectory, 'candidate-receipt.json');
  fs.writeFileSync(script, `param($stateRoot,$CandidateReceipt)\n$ErrorActionPreference='Stop'\n$configFile=Join-Path $stateRoot 'workspace-mcp/config.json'\n$profileFile=Join-Path $stateRoot 'workspace-mcp/tunnel/profiles/aicc-workspace.yaml'\n${helpers}\nValidate-Candidate (Read $CandidateReceipt)\n`);
  const validate = () => spawnSync('pwsh', ['-NoProfile', '-File', script, f.root, candidateFile], { encoding: 'utf8', windowsHide: true });
  let run = validate(); assert.equal(run.status, 0, run.stderr);
  const nextConfig = path.join(result.gateway, 'config.json');
  const original = fs.readFileSync(nextConfig);
  const mutated = JSON.parse(original); mutated.providers[0].unknownMetadata = 'foreign-change'; fs.writeFileSync(nextConfig, JSON.stringify(mutated));
  // Re-pin both config references to show graph validation, rather than only checksum validation, rejects the foreign change.
  const receiptFile = path.join(f.operationDirectory, 'candidate-receipt.json');
  const receiptBytes = fs.readFileSync(receiptFile);
  const receipt = JSON.parse(receiptBytes); receipt.gatewayConfigSHA256 = hash(nextConfig); fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  const manifestFile = path.join(result.gateway, 'manifest.json'), manifestBytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes); manifest.files['config.json'] = hash(nextConfig); manifest.releaseHash = hash(nextConfig); fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  run = validate(); assert.notEqual(run.status, 0);
  assert.match(run.stderr, /other providers must remain exact/);
  fs.writeFileSync(nextConfig, original);
  fs.writeFileSync(receiptFile, receiptBytes); fs.writeFileSync(manifestFile, manifestBytes);
  fs.appendFileSync(result.profileDesiredFile, 'foreign: changed\n');
  run = validate(); assert.notEqual(run.status, 0);
});

test('bootstrap requires the operation-bound consumed three-provider drain and preserves unknown work', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const instance = path.join(f.root, 'runtime/unified-mcp-maintenance/123-fixture');
  const stateFile = path.join(instance, 'state.json');
  const configPath = path.join(f.gateway, 'config.json');
  const identity = { instanceDirectory: instance.replaceAll('\\', '/'), configPath: configPath.replaceAll('\\', '/'), configSha256: hash(configPath), gateway: { pid: 123, startedAt: '2026-01-01T00:00:00Z', instanceId: 'fixture' } };
  f.put('runtime/unified-mcp-maintenance/123-fixture/identity.json', identity);
  f.put('workspace-mcp/runtime/remote-authority-status.json', { supervisor: { pid: 123 } });
  const plan = { request_id: 'fixture-operation', challenge: 'c'.repeat(64), expires_at: new Date(Date.now() + 120000).toISOString(), ownership: { processes: [{ pid: 123 }] } };
  const state = { identity, phase: 'CONSUMED', closed: true, initialized: true, fault: null, expired: false, consumedSnapshotSha256: 'd'.repeat(64),
    operation: { operationId: plan.request_id, nonce: plan.challenge, operationExpiresAt: new Date(Date.now() + 60000).toISOString() },
    calls: [], unknown: [], providers: Object.fromEntries(['workspace', 'native', 'host'].map(id => [id, { active: 0, unknown: 0, reconnecting: 0 }])) };
  const planFile = f.put('owner/plan.json', plan), candidateFile = f.put('owner/candidate.json', { oldGateway: f.gateway });
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const updater = fs.readFileSync(new URL('../tools/platform/workspace-mcp/Update-AiccWebManagementRuntime.ps1', import.meta.url), 'utf8');
  const helpers = updater.slice(updater.indexOf('function Regular('), updater.indexOf('$OperationDirectory=[IO.Path]::GetFullPath'));
  const script = f.put('check-maintenance.ps1', `param($stateRoot,$PlanFile,$CandidateFile,$StateFile)\n$ErrorActionPreference='Stop'\n${helpers}\nAssert-HostMaintenance (Read $PlanFile) (Read $CandidateFile) $StateFile | Out-Null\n`);
  const validate = () => spawnSync('pwsh', ['-NoProfile', '-File', script, f.root, planFile, candidateFile, stateFile], { encoding: 'utf8', windowsHide: true });
  let run = validate(); assert.equal(run.status, 0, run.stderr);
  state.phase = 'OPEN'; state.closed = false; fs.writeFileSync(stateFile, JSON.stringify(state));
  run = validate(); assert.notEqual(run.status, 0); assert.match(run.stderr, /drain must be consumed/);
  state.phase = 'CONSUMED'; state.closed = true;
  state.providers.host.unknown = 1; fs.writeFileSync(stateFile, JSON.stringify(state));
  run = validate(); assert.notEqual(run.status, 0); assert.match(run.stderr, /work must remain preserved/);
  state.providers.host.unknown = 0; state.operation.nonce = 'e'.repeat(64); fs.writeFileSync(stateFile, JSON.stringify(state));
  run = validate(); assert.notEqual(run.status, 0); assert.match(run.stderr, /operation differs/);
  state.operation.nonce = plan.challenge; state.phase = 'DRAINING'; fs.writeFileSync(stateFile, JSON.stringify(state));
  run = validate(); assert.notEqual(run.status, 0); assert.match(run.stderr, /drain must be consumed/);
});

test('an unreviewed installed manifest difference is not silently repaired or adopted', async t => {
  const f = fixture(t);
  const graph = structuredClone(f.before); graph.diagnosticPath = 'unreviewed change';
  fs.writeFileSync(path.join(f.gateway, 'config.json'), JSON.stringify(graph));
  const before = hash(path.join(f.gateway, 'config.json'));
  await assert.rejects(prepareHostUpdate({ stateRoot: f.root, operationDirectory: f.operationDirectory, buildHost: f.buildHost }), /GATEWAY_MANIFEST_PIN_CHANGED/);
  assert.equal(hash(path.join(f.gateway, 'config.json')), before);
  assert.equal(fs.existsSync(f.operationDirectory), false);
});

test('actual host bundle advertises eight tools using isolated state without opening a driver', { skip: !process.env.AICC_HOST_BUILD_BUN || process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const source = path.resolve('components/host-control/server.mjs').replaceAll('\\', '/');
  const entry = f.put('bundle-entry.mjs', `import {runHostServer} from ${JSON.stringify(source)};runHostServer(process.argv[2]).catch(()=>{process.exitCode=1});`);
  const output = path.join(f.root, 'host.cjs');
  const built = spawnSync(process.env.AICC_HOST_BUILD_BUN, ['build', entry, '--target=node', '--format=cjs', '--outfile=' + output], { encoding: 'utf8', windowsHide: true });
  assert.equal(built.status, 0, built.stderr);
  const executor = f.put('fake-executor.exe', 'never-launched-fixture');
  const cfg = f.put('isolated-config.json', { schemaVersion: 1, scope: 'task-owned-v1',
    aside: { command: executor, sha256: hash(executor) }, cua: { command: executor, sha256: hash(executor) }, powershell: executor,
    stateRoot: path.join(f.root, 'isolated-journals'), apps: {}, blockedUrlFragments: [] });
  const client = new Client({ name: 'host-update-isolated-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [output, cfg], stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), HOST_TOOLS.map(tool => tool.name));
  assert.equal(hostToolHash(tools.tools), hostToolHash(HOST_TOOLS));
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'isolated-journals')), []);
  assert.ok(f.inputs.every(([file, digest]) => hash(file) === digest));
  await client.close();
});

test('completed operation provenance closes a legacy manifest difference and rejects unrelated graph changes', async t => {
  const f = fixture(t);
  const baseline = path.join(f.root, 'releases/unified-mcp/baseline');
  fs.cpSync(f.gateway, baseline, { recursive: true });
  const configFile = path.join(f.root, 'workspace-mcp/config.json');
  const baselineConfig = path.join(baseline, 'config.json');
  const currentConfig = path.join(f.gateway, 'config.json');
  // Model the old installer's missing manifest refresh, with exact original admission proof.
  fs.writeFileSync(currentConfig, JSON.stringify(f.before, null, 2));
  const registry = JSON.parse(fs.readFileSync(path.join(f.root, 'runtime/components.json')));
  const before = structuredClone(registry);
  before.components['unified-mcp'].releaseRoot = baseline;
  before.components['unified-mcp'].entry = path.join(baseline, 'gateway.cjs');
  const directory = path.join(f.root, 'backups/original-overlay/review/workspace-activation');
  fs.mkdirSync(directory, { recursive: true });
  const put = (name, value) => { const file = path.join(directory, name); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  put('registry.before.json', before);
  put('config.before.json', fs.readFileSync(configFile, 'utf8'));
  const desiredConfig = put('desired.json', fs.readFileSync(configFile, 'utf8'));
  const plan = { schemaVersion: 1, status: 'START_ACCEPTED_RUNTIME_UNOBSERVED', operationId: 'overlay-fixture',
    beforeWorkspace: before.components.workspace, beforeGateway: before.components['unified-mcp'],
    workspaceCandidate: registry.components.workspace.releaseRoot, gatewayCandidate: f.gateway, config: configFile,
    configBeforeSha256: hash(configFile), desiredConfig, desiredConfigSha256: hash(configFile), modelRoutesChanged: [], gatewayEntryHash: hash(path.join(f.gateway, 'gateway.cjs')) };
  put('plan.json', plan); put('journal.json', { status: plan.status, operationId: plan.operationId, startAttempts: 1, rollbackStartAttempts: 0 });
  const request = { operationId: plan.operationId, action: 'consume', readySnapshotSha256: 'f'.repeat(64) };
  const requestFile = put('request.json', request);
  const response = { ok: true, phase: 'CONSUMED', action: 'consume', operation: { operationId: plan.operationId, operationExpiresAt: '2026-01-01T00:00:00.000Z' }, identity: { configPath: baselineConfig, configSha256: hash(baselineConfig) }, consumedSnapshotSha256: request.readySnapshotSha256 };
  const responseFile = put('response.json', response);
  put('gateway-consume.json', { response, client: { requestFile, requestSha256: hash(requestFile), responseFile } });
  const result = await prepareHostUpdate({ stateRoot: f.root, operationDirectory: f.operationDirectory, workspaceOverlayOperation: directory, buildHost: f.buildHost });
  assert.equal(result.manifestProvenance.operationId, plan.operationId);
  assert.equal(result.oldGatewayConfigSHA256, hash(currentConfig));
  assert.equal(result.manifestProvenance.baselineConfigSHA256, hash(baselineConfig));
  const altered = structuredClone(f.before); altered.providers[1].unknownMetadata = 'foreign'; fs.writeFileSync(currentConfig, JSON.stringify(altered));
  await assert.rejects(prepareHostUpdate({ stateRoot: f.root, operationDirectory: f.operationDirectory + '-other', workspaceOverlayOperation: directory, buildHost: f.buildHost }), /WORKSPACE_OVERLAY_GRAPH_CLOSURE_MISMATCH/);
});

test('partial local prepare resumes only identical bytes and retains prior output', async t => {
  const f = fixture(t);
  await assert.rejects(prepareHostUpdate({ stateRoot: f.root, operationDirectory: f.operationDirectory, buildHost: async ({ output }) => { fs.writeFileSync(output, 'partial-build'); throw Error('INTERRUPTED_LOCAL_BUILD'); } }), /INTERRUPTED_LOCAL_BUILD/);
  const entry = path.join(f.operationDirectory, 'host-entry.mjs'), entryHash = hash(entry);
  const preserved = path.join(f.operationDirectory, 'prior-output.txt'); fs.writeFileSync(preserved, 'retain');
  const result = await prepareHostUpdate({ stateRoot: f.root, operationDirectory: f.operationDirectory, resumeLocalPrepare: true, buildHost: f.buildHost });
  assert.equal(result.liveCutover, false); assert.equal(hash(entry), entryHash);
  assert.equal(fs.readFileSync(preserved, 'utf8'), 'retain');
  await assert.rejects(prepareHostUpdate({ stateRoot: f.root, operationDirectory: f.operationDirectory, resumeLocalPrepare: true, buildHost: f.buildHost }), /OPERATION_EXISTS_RECONCILE/);
});

function ownerCdpFixture(t, { packageKind = 'playwright-plus-core' } = {}) {
 if (!['playwright-plus-core','playwright-core-only'].includes(packageKind))
   throw Error('Fixture package kind must be one of the exact two approved kinds');
 const f = fixture(t);
 const helper = path.resolve('tools/platform/web-automation/Manage-CdpChromeSlotLease.ps1');
 const guard = path.resolve('tools/platform/web-automation/Assert-CdpEndpointIdentity.ps1');
 const pwsh = f.put('runtime/fake-pwsh.exe','fixture-powershell');
 const chrome = f.put('runtime/chrome.exe','fixture-chrome');
 const playwrightVersion='1.62.1';
 const rootExports={'.':{types:'./index.d.ts',import:'./index.mjs',require:'./index.js',default:'./index.js'},
  './package.json':'./package.json'};
 f.put('node_modules/playwright-core/package.json',{name:'playwright-core',version:playwrightVersion,
  exports:{...rootExports,'./lib/attached':'./lib/attached.js'}});
 f.put('node_modules/playwright-core/lib/attached.js','exports.attached=true;exports.chromium={connectOverCDP:async()=>{}};');
 f.put('node_modules/playwright-core/index.mjs','export const chromium = {};');
 f.put('node_modules/playwright-core/index.d.ts','export declare const chromium: any;');
 const coreSource=f.put('source-bytes/playwright-core-index','module.exports=require("./lib/attached.js");');
 const coreEntry=path.join(f.root,'node_modules/playwright-core/index.js');
 fs.linkSync(coreSource,coreEntry);
 let playwright=coreEntry;
 if (packageKind === 'playwright-plus-core') {
  f.put('node_modules/playwright/package.json',{name:'playwright',version:playwrightVersion,main:'index.js',
   exports:rootExports,dependencies:{'playwright-core':playwrightVersion}});
  f.put('node_modules/playwright/index.mjs','export const chromium = {};');
  f.put('node_modules/playwright/index.d.ts','export declare const chromium: any;');
  const fullSource=f.put('source-bytes/playwright-index','module.exports=require("playwright-core");');
  playwright=path.join(f.root,'node_modules/playwright/index.js');
  fs.linkSync(fullSource,playwright);
 }
 const auditDependency=f.put('runtime/audit-helper.mjs','export const sessionIdentityHashExpression = ()=>"";');
 const auditSource=f.put('source-bytes/audit-entry','export { sessionIdentityHashExpression } from "./audit-helper.mjs";');
 const audit=path.join(f.root,'runtime/audit.mjs');
 fs.linkSync(auditSource,audit);
 assert.ok(fs.statSync(playwright).nlink>=2);
 assert.ok(fs.statSync(audit).nlink>=2);
 const profile = path.join(f.root,'browser-profiles/chrome/9222/UserData');fs.mkdirSync(profile,{recursive:true});
 const coordinator = f.put('guidance/coordination.toml', [
  '[browser]','cdp_slot_count = 1','cdp_slot1_port = 9222',
  'cdp_slot1_profile_dir = "'+profile+'"','cdp_slot1_profile_directory = "Default"',
  'cdp_slot1_account_alias = "fixture-account"','cdp_slot1_workspace = "fixture-space"',
  'cdp_slot1_usage = "authenticated"',''
 ].join('\n'));
 const hostCfg=f.before.providers[2].args[2],host=JSON.parse(fs.readFileSync(hostCfg));
 // The official updater uses an already-pinned Node command, not a fake shell
 // or another engine. This fixture points that existing command at the test Node.
 for(const provider of f.before.providers){
   const previous=provider.command;provider.command=process.execPath;
   provider.files=provider.files.filter(pin=>pin.path!==previous);
   provider.files.unshift({path:process.execPath,sha256:hash(process.execPath)});
 }
 Object.assign(host,{powershell:pwsh,aside:{command:pwsh,sha256:hash(pwsh)},cua:{command:pwsh,sha256:hash(pwsh)},
  apps:{preserved:{enabled:true}},blockedUrlFragments:['blocked.invalid']});
 f.put('owner/host.json',host);
 f.before.providers[2].files.find(p=>p.path===hostCfg).sha256=hash(hostCfg);
 const gatewayCfg=path.join(f.gateway,'config.json');fs.writeFileSync(gatewayCfg,JSON.stringify(f.before));
 const manifestFile=path.join(f.gateway,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestFile));
 manifest.files['config.json']=hash(gatewayCfg);fs.writeFileSync(manifestFile,JSON.stringify(manifest));
 const identity={identityId:'fixture-slot',role:'registered-cdp',engine:'chrome',appIdentity:'Google Chrome',
  executable:chrome,executableSha256:hash(chrome),userDataRoot:profile,profile:'Default',
  cdpEndpoint:'http://127.0.0.1:9222',accountAlias:'fixture-account',workspaceAlias:'fixture-space',
  owner:'fixture-owner',ownershipPolicy:'task-created-target-only',sessionIdentityHash:'a'.repeat(64),workspaceIdentityHash:'b'.repeat(64)};
 const cdp={enabled:true,identities:[identity],leaseHelper:helper,leaseHelperSha256:hash(helper),
  identityGuard:guard,identityGuardSha256:hash(guard),powershellSha256:hash(pwsh),
  playwrightModule:playwright,playwrightModuleSha256:hash(playwright),
  identityAuditModule:audit,identityAuditModuleSha256:hash(audit)};
 const bindingFile=f.put('asset-control/owner-cdp-binding.json',{schemaVersion:1,kind:'host-cdp-owner-binding/v1',
  hostConfigBeforeSha256:hash(hostCfg),coordinationFile:coordinator,coordinationSha256:hash(coordinator),cdp});
 const prepare=()=>prepareHostUpdate({stateRoot:f.root,operationDirectory:f.operationDirectory,
  ownerCdpBindingFile:bindingFile,ownerCdpBindingSha256:hash(bindingFile),buildHost:f.buildHost});
 return {...f,hostCfg,helper,guard,pwsh,chrome,playwright,audit,profile,coordinator,identity,cdp,bindingFile,prepare};
}
function ownerCdpValidator(f,command='Validate-Candidate (Read $CandidateReceipt)'){
 const updater=fs.readFileSync(new URL('../tools/platform/workspace-mcp/Update-AiccWebManagementRuntime.ps1',import.meta.url),'utf8');
 const helpers=updater.slice(updater.indexOf('function Regular('),updater.indexOf('$OperationDirectory=[IO.Path]::GetFullPath'));
 const script=path.join(f.root,'owner-cdp-helper-fixture.ps1'),candidate=path.join(f.operationDirectory,'candidate-receipt.json');
 const preface=[
  'param($stateRoot,$CandidateReceipt)',
  "$ErrorActionPreference='Stop'",
  "$configFile=Join-Path $stateRoot 'workspace-mcp/config.json'",
  "$profileFile=Join-Path $stateRoot 'workspace-mcp/tunnel/profiles/aicc-workspace.yaml'",
  "$registryFile=Join-Path $stateRoot 'runtime/components.json'",
  "$receiptFile=Join-Path $stateRoot 'backups/workspace-tunnel-windows-task/fixture.install.json'",
  "$launcherFile=Join-Path $stateRoot 'workspace-mcp/runtime/fixture.hidden.ps1'",
  helpers,command
 ].join('\n')+'\n';
 fs.writeFileSync(script,preface);
 return spawnSync('pwsh',['-NoProfile','-NonInteractive','-File',script,f.root,candidate],
  {encoding:'utf8',windowsHide:true,timeout:30000});
}
test('owner CDP additive immutable candidate preserves non-CDP fields, original bytes and exact config pin',async t=>{
 const f=ownerCdpFixture(t),old=JSON.parse(fs.readFileSync(f.hostCfg)),oldSHA=hash(f.hostCfg);
 const candidate=await f.prepare();
 assert.equal(candidate.hostConfigUnchanged,false);
 assert.equal(candidate.status,'PREPARED_NOT_ACTIVE');
 assert.equal(hash(f.hostCfg),oldSHA);
 assert.equal(candidate.oldHostConfigSHA256,oldSHA);
 const desired=JSON.parse(fs.readFileSync(candidate.hostConfigDesiredFile));
 assert.deepEqual(Object.fromEntries(Object.entries(desired).filter(([key])=>key!=='cdp')),old);
 assert.deepEqual(desired.cdp,{...f.cdp,
   playwrightModule:candidate.dependencyMaterialization.playwrightModule,
   playwrightModuleSha256:hash(candidate.dependencyMaterialization.playwrightModule),
   identityAuditModule:candidate.dependencyMaterialization.identityAuditModule,
   identityAuditModuleSha256:hash(candidate.dependencyMaterialization.identityAuditModule)});
 assert.equal(fs.statSync(candidate.dependencyMaterialization.playwrightModule).nlink,1);
 assert.equal(fs.statSync(candidate.dependencyMaterialization.identityAuditModule).nlink,1);
 const after=JSON.parse(fs.readFileSync(path.join(candidate.gateway,'config.json')));
 assert.deepEqual(after.providers.filter(p=>p.id!=='host'),f.before.providers.filter(p=>p.id!=='host'));
 const host=after.providers.find(p=>p.id==='host');
 assert.equal(host.args[2],candidate.hostConfigDesiredFile);
 assert.equal(host.files.filter(p=>p.path===candidate.hostConfigDesiredFile).length,1);
 assert.equal(host.files.filter(p=>p.path===f.hostCfg).length,0);
 assert.equal(host.files.find(p=>p.path===candidate.hostConfigDesiredFile).sha256,candidate.hostConfigDesiredSHA256);
 const hostRelease=JSON.parse(fs.readFileSync(path.join(candidate.hostRoot,'manifest.json')));
 assert.ok(Object.keys(hostRelease.files).length>6);
 assert.ok(Object.keys(hostRelease.files).includes('node_modules/playwright-core/lib/attached.js'));
 assert.ok(Object.keys(hostRelease.files).includes('cdp-audit/audit-helper.mjs'));
 assert.ok(Object.keys(hostRelease.files).includes('dependency-provenance.json'));
 assert.ok(candidate.dependencyMaterialization.sourceClosureSHA256);
 assert.equal(candidate.cdpBinding.coordinationSha256,hash(f.coordinator));
 assert.equal(candidate.liveCutover,false);
});
test('owner CDP invalid scope, workspace, foreign port, extra authority, browser pin or binding drift reject before operation',async t=>{
 const scenarios={
  scope:(f,v)=>{const c=JSON.parse(fs.readFileSync(f.hostCfg));c.scope='other';fs.writeFileSync(f.hostCfg,JSON.stringify(c));},
  missingWorkspace:(f,v)=>{delete v.cdp.identities[0].workspaceAlias;},
  missingIdentity:(f,v)=>{delete v.cdp.identities[0].identityId;},
  missingLoginHash:(f,v)=>{delete v.cdp.identities[0].sessionIdentityHash;},
  missingWorkspaceHash:(f,v)=>{delete v.cdp.identities[0].workspaceIdentityHash;},
  malformedWorkspaceHash:(f,v)=>{v.cdp.identities[0].workspaceIdentityHash='not-a-hash';},
  foreignWorkspace:(f,v)=>{v.cdp.identities[0].workspaceAlias='not-registered';},
  foreignPort:(f,v)=>{v.cdp.identities[0].cdpEndpoint='http://127.0.0.1:9223';},
  foreignProfile:(f,v)=>{v.cdp.identities[0].userDataRoot=f.root;},
  extraAuthority:(f,v)=>{v.cdp.ownerNetwork=true;},
  pinDrift:(f,v)=>{v.cdp.identityGuardSha256='e'.repeat(64);},
  oldHash:(f,v)=>{v.hostConfigBeforeSha256='f'.repeat(64);},
  oldBinding:(f,v)=>{fs.appendFileSync(f.bindingFile,' ');return true;},
  coordinationChanged:(f,v)=>{fs.appendFileSync(f.coordinator,'# changed\n');return true;}
 };
 for(const [name,mutate] of Object.entries(scenarios)){
  await t.test(name,async sub=>{
   const f=ownerCdpFixture(sub),v=JSON.parse(fs.readFileSync(f.bindingFile)),pinnedSHA=hash(f.bindingFile);
   const onDisk=mutate(f,v);
   if(!onDisk)fs.writeFileSync(f.bindingFile,JSON.stringify(v));
   await assert.rejects(name==='oldBinding'?prepareHostUpdate({stateRoot:f.root,operationDirectory:f.operationDirectory,
    ownerCdpBindingFile:f.bindingFile,ownerCdpBindingSha256:pinnedSHA,buildHost:f.buildHost}):f.prepare());
   assert.equal(fs.existsSync(f.operationDirectory),false);
  });
 }
});
test('owner CDP updater exact graph, config pin and unrelated delta checks', {skip:process.platform!=='win32'},async t=>{
 const f=ownerCdpFixture(t),candidate=await f.prepare();
 const receiptFile=path.join(f.operationDirectory,'candidate-receipt.json'),
  configFile=path.join(candidate.gateway,'config.json'),manifestFile=path.join(candidate.gateway,'manifest.json');
 const hostManifest=path.join(candidate.hostRoot,'manifest.json');
 const allPaths=[receiptFile,configFile,manifestFile,candidate.hostConfigDesiredFile,hostManifest];
 const original=allPaths.map(p=>fs.readFileSync(p));
 const restore=()=>allPaths.forEach((p,i)=>fs.writeFileSync(p,original[i]));
 const mutateGraph=edit=>{
  const graph=JSON.parse(fs.readFileSync(configFile));edit(graph);fs.writeFileSync(configFile,JSON.stringify(graph));
  const receipt=JSON.parse(fs.readFileSync(receiptFile));receipt.gatewayConfigSHA256=hash(configFile);fs.writeFileSync(receiptFile,JSON.stringify(receipt));
  const m=JSON.parse(fs.readFileSync(manifestFile));m.files['config.json']=hash(configFile);m.releaseHash=hash(configFile);fs.writeFileSync(manifestFile,JSON.stringify(m));
 };
 const pass=ownerCdpValidator(f);assert.equal(pass.status,0,pass.stderr || pass.stdout);
 try {
  mutateGraph(graph=>{const host=graph.providers.find(p=>p.id==='host');host.files.push({...host.files.find(p=>p.path===candidate.hostConfigDesiredFile)});});
  let result=ownerCdpValidator(f);assert.notEqual(result.status,0);restore();
  mutateGraph(graph=>{graph.providers.find(p=>p.id==='workspace').unknownMetadata='illegal-change';});
  result=ownerCdpValidator(f);assert.notEqual(result.status,0);assert.match(result.stderr,/other providers must remain exact/i);restore();
  mutateGraph(graph=>{graph.providers.find(p=>p.id==='host').args[2]=f.hostCfg;});
  result=ownerCdpValidator(f);assert.notEqual(result.status,0);restore();
  const undesired=JSON.parse(fs.readFileSync(candidate.hostConfigDesiredFile));
  undesired.blockedUrlFragments=[];fs.writeFileSync(candidate.hostConfigDesiredFile,JSON.stringify(undesired));
  const newConfigSha=hash(candidate.hostConfigDesiredFile);
  const changedGraph=JSON.parse(fs.readFileSync(configFile));
  const configPin=changedGraph.providers.find(p=>p.id==='host').files.find(p=>p.path===candidate.hostConfigDesiredFile);
  configPin.sha256=newConfigSha;fs.writeFileSync(configFile,JSON.stringify(changedGraph));
  const hostRelease=JSON.parse(fs.readFileSync(hostManifest));
  hostRelease.files['host-config.json']=newConfigSha;fs.writeFileSync(hostManifest,JSON.stringify(hostRelease));
  const gwManifest=JSON.parse(fs.readFileSync(manifestFile));
  gwManifest.files['config.json']=hash(configFile);gwManifest.releaseHash=hash(configFile);
  fs.writeFileSync(manifestFile,JSON.stringify(gwManifest));
  const review=JSON.parse(fs.readFileSync(receiptFile));
  review.hostConfigDesiredSHA256=newConfigSha;review.gatewayConfigSHA256=hash(configFile);
  fs.writeFileSync(receiptFile,JSON.stringify(review));
  result=ownerCdpValidator(f);
  assert.notEqual(result.status,0);assert.match(result.stderr,/unrelated changes beyond additive materialized CDP/i);restore();
  fs.appendFileSync(f.bindingFile,' ');
  result=ownerCdpValidator(f);assert.notEqual(result.status,0);
 } finally {restore();}
});
test('owner CDP rollback source preimage hash is independently checked', {skip:process.platform!=='win32'},async t=>{
 const f=ownerCdpFixture(t);await f.prepare();
 const op=path.join(f.root,'asset-control/fake-approved-operation');fs.mkdirSync(op,{recursive:true});
 const original=path.join(op,'host-config.before');fs.copyFileSync(f.hostCfg,original);
 const command="$candidate=Read $CandidateReceipt\nAssert-HostCdpRecoveryPreimage $candidate '"+op.replaceAll("'","''")+"'";
 let result=ownerCdpValidator(f,command);assert.equal(result.status,0,result.stderr);
 fs.appendFileSync(original,' ');
 result=ownerCdpValidator(f,command);assert.notEqual(result.status,0);assert.match(result.stderr,/recovery preimage changed/i);
});

test('owner CDP backup inventory must include original config, signed candidate, private registration and source provenance', {skip:process.platform!=='win32'},async t=>{
 const f=ownerCdpFixture(t),candidate=await f.prepare();
 const privateBackup=path.join(f.root,'asset-control/fixture-backup');
 fs.mkdirSync(privateBackup,{recursive:true});
 const taskReceipt=f.put('backups/workspace-tunnel-windows-task/fixture.install.json',{status:'unchanged'});
 const launcher=f.put('workspace-mcp/runtime/fixture.hidden.ps1','unchanged');
 const backupReceipt=path.join(privateBackup,'receipt.json');
 const command="$candidate=Read $CandidateReceipt\n$backup=Read '"+backupReceipt.replaceAll("'","''")+"'\nAssert-ChangeBackupPolicy $candidate $backup";
 const first=ownerCdpValidator(f,command);
 assert.notEqual(first.status,0); // only writes a scoped fake validator, no live updater entrypoint
 const script=path.join(f.root,'owner-cdp-helper-fixture.ps1');
 const original=JSON.parse(fs.readFileSync(path.join(candidate.oldGateway,'config.json')));
 const originalHost=original.providers.find(p=>p.id==='host');
 const sources=[script,path.join(f.operationDirectory,'candidate-receipt.json'),path.join(f.root,'runtime/components.json'),
  path.join(f.root,'workspace-mcp/config.json'),path.join(f.root,'workspace-mcp/tunnel/profiles/aicc-workspace.yaml'),
  taskReceipt,launcher,
  path.join(candidate.oldGateway,'config.json'),path.join(candidate.oldGateway,'manifest.json'),
  path.join(candidate.gateway,'config.json'),path.join(candidate.gateway,'manifest.json'),
  path.join(candidate.hostRoot,'host.cjs'),originalHost.entrypoint,
  candidate.oldHostConfigFile,candidate.hostConfigDesiredFile,candidate.cdpBinding.bindingFile,
  candidate.cdpBinding.coordinationFile,candidate.preparerSourceFile,
  path.join(candidate.hostRoot,'manifest.json'),
  ...candidate.cdpBinding.dependencies.filter(pin=>![f.cdp.playwrightModule,f.cdp.identityAuditModule].includes(pin.file)).map(pin=>pin.file),
  ...Object.keys(candidate.dependencyMaterialization.files).map(relative=>path.join(candidate.hostRoot,...relative.split('/'))),
  ...candidate.hostSourceClosure.pins.map(pin=>path.join(candidate.hostSourceRoot,pin.relative))];
 const files=[...new Set(sources)].map((source,index)=>{
  const backupFile='source-'+String(index).padStart(3,'0')+'.copy';
  fs.copyFileSync(source,path.join(privateBackup,backupFile));
  return {path:source,backupFile,sha256:hash(source)};
 });
 const bundleFile=path.join(privateBackup,'bundle.json');
 const bundle={schemaVersion:1,kind:'host-runtime-local-backup/v1',files};
 fs.writeFileSync(bundleFile,JSON.stringify(bundle));
 fs.writeFileSync(backupReceipt,JSON.stringify({kind:bundle.kind,localStatus:'PREPARED',bundlePath:bundleFile,bundleSHA256:hash(bundleFile)}));
 let validated=ownerCdpValidator(f,command);
 assert.equal(validated.status,0,validated.stderr || validated.stdout);
 bundle.files=bundle.files.filter(row=>row.path!==candidate.cdpBinding.bindingFile);
 fs.writeFileSync(bundleFile,JSON.stringify(bundle));
 fs.writeFileSync(backupReceipt,JSON.stringify({kind:bundle.kind,localStatus:'PREPARED',bundlePath:bundleFile,bundleSHA256:hash(bundleFile)}));
 validated=ownerCdpValidator(f,command);
 assert.notEqual(validated.status,0);
 assert.match(validated.stderr,/Required host recovery source is missing or changed/i);
});

test('owner CDP materialized HardLink originals stay untouched and strict Regular refuses source as executable', {skip:process.platform!=='win32'}, async t=>{
 const f=ownerCdpFixture(t),beforeSHA=hash(f.playwright),beforeLinks=fs.statSync(f.playwright).nlink;
 const result=await f.prepare();
 assert.equal(hash(f.playwright),beforeSHA);
 assert.equal(fs.statSync(f.playwright).nlink,beforeLinks);
 const candidate=result.dependencyMaterialization;
 assert.equal(hash(candidate.playwrightModule),beforeSHA);
 assert.equal(fs.statSync(candidate.playwrightModule).nlink,1);
 const call=ownerCdpValidator(f,"Hash '"+f.playwright.replaceAll("'","''")+"' | Out-Null");
 assert.notEqual(call.status,0);
 assert.match(call.stderr,/regular non-linked file is required/i);
});
test('owner CDP missing relative audit import fails before writing a candidate',async t=>{
 const f=ownerCdpFixture(t);
 fs.rmSync(path.join(f.root,'runtime/audit-helper.mjs'));
 await assert.rejects(f.prepare(),/CDP_AUDIT_RELATIVE_IMPORT_MISSING_OR_AMBIGUOUS/);
 assert.equal(fs.existsSync(f.operationDirectory),false);
});
test('owner CDP source package closure drift, added candidate and audit pin mismatch fail official validator', {skip:process.platform!=='win32'},async t=>{
 for(const item of ['sourcePackageExtra','copiedFileDrift','sourceAuditDrift','candidateUnlistedFile']){
  await t.test(item,async sub=>{
   const f=ownerCdpFixture(sub),candidate=await f.prepare();
   let mutated;
   if(item==='sourcePackageExtra') mutated=f.put('node_modules/playwright/unreviewed.js','module.exports=1;');
   if(item==='copiedFileDrift') {mutated=candidate.dependencyMaterialization.playwrightModule;fs.appendFileSync(mutated,' ');}
   if(item==='sourceAuditDrift') {mutated=path.join(f.root,'runtime/audit-helper.mjs');fs.appendFileSync(mutated,' ');}
   if(item==='candidateUnlistedFile') mutated=f.put(path.relative(f.root,path.join(candidate.hostRoot,'cdp-audit','unexpected.json')),'{}');
   const check=ownerCdpValidator(f);
   assert.notEqual(check.status,0);
  });
 }
});
test('owner CDP source package symlink/junction is rejected, not followed or copied',async t=>{
 const f=ownerCdpFixture(t);
 const source=path.join(f.root,'runtime'),link=path.join(f.root,'node_modules/playwright/linked');
 try{fs.symlinkSync(source,link,process.platform==='win32'?'junction':'dir');}
 catch(error){
  if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('Operating system does not allow junction fixture creation');return;}
  throw error;
 }
 await assert.rejects(f.prepare(),/CDP_SOURCE_REPARSE_REFUSED|LINK_REFUSED/);
 assert.equal(fs.existsSync(f.operationDirectory),false);
});

test('owner CDP core-only 1.62.1 exact package entry and immutable single-package closure passes official validator', {skip:process.platform!=='win32'},async t=>{
 const f=ownerCdpFixture(t,{packageKind:'playwright-core-only'});
 assert.equal(fs.existsSync(path.join(f.root,'node_modules/playwright')),false);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'node_modules/playwright-core/package.json'))).main,undefined);
 const sourceSHA=hash(f.playwright),sourceLinks=fs.statSync(f.playwright).nlink;
 const candidate=await f.prepare();
 const material=candidate.dependencyMaterialization;
 assert.equal(material.packageKind,'playwright-core-only');
 assert.deepEqual(JSON.parse(fs.readFileSync(material.manifestFile)).packageInfo.map(p=>p.name),['playwright-core']);
 assert.equal(material.playwrightModule,path.join(candidate.hostRoot,'node_modules/playwright-core/index.js'));
 assert.equal(hash(f.playwright),sourceSHA);
 assert.equal(fs.statSync(f.playwright).nlink,sourceLinks);
 assert.equal(fs.statSync(material.playwrightModule).nlink,1);
 const {createRequire}=await import('node:module');
 const chromium=createRequire(import.meta.url)(material.playwrightModule).chromium;
 assert.equal(typeof chromium?.connectOverCDP,'function');
 const manifest=JSON.parse(fs.readFileSync(path.join(candidate.hostRoot,'manifest.json')));
 assert.ok(Object.keys(manifest.files).some(name=>name.startsWith('node_modules/playwright-core/')));
 assert.ok(!Object.keys(manifest.files).some(name=>name.startsWith('node_modules/playwright/')));
 const desired=JSON.parse(fs.readFileSync(candidate.hostConfigDesiredFile));
 assert.equal(desired.cdp.playwrightModule,material.playwrightModule);
 const gateway=JSON.parse(fs.readFileSync(path.join(candidate.gateway,'config.json')));
 assert.deepEqual(gateway.providers.filter(p=>p.id!=='host'),f.before.providers.filter(p=>p.id!=='host'));
 assert.equal(gateway.providers.find(p=>p.id==='host').toolNames.length,8);
 const out=ownerCdpValidator(f);
 assert.equal(out.status,0,out.stderr||out.stdout);
});
test('owner CDP core-only wrong package identity, export or entry, extra dependencies and nested package fail pre-write',async t=>{
 const cases={
  foreignName:(f,p)=>{p.name='another-package';},
  wrongFolderName:(f,p)=>{p.name='playwright';},
  malformedVersion:(f,p)=>{p.version='not-a-version';},
  missingExports:(f,p)=>{delete p.exports;},
  wrongRequireExport:(f,p)=>{p.exports['.'].require='./lib/attached.js';},
  missingExportFile:(f,p)=>{p.exports['./new']='./lib/not-present.js';},
  escapingExport:(f,p)=>{p.exports['./new']='../outside.js';},
  wrongMain:(f,p)=>{p.main='lib/attached.js';},
  extraDependency:(f,p)=>{p.dependencies={another:'1.0.0'};},
  optionalDependency:(f,p)=>{p.optionalDependencies={fsevents:'1.0.0'};},
  nestedPackage:(f,p)=>{f.put('node_modules/playwright-core/node_modules/other/index.js','module.exports={};');},
  otherEntry:(f,p)=>{
    const binding=JSON.parse(fs.readFileSync(f.bindingFile));
    binding.cdp.playwrightModule=path.join(f.root,'node_modules/playwright-core/index.mjs');
    binding.cdp.playwrightModuleSha256=hash(binding.cdp.playwrightModule);
    fs.writeFileSync(f.bindingFile,JSON.stringify(binding));
  }
 };
 for(const [name,mutate] of Object.entries(cases)){
  await t.test(name,async sub=>{
   const f=ownerCdpFixture(sub,{packageKind:'playwright-core-only'});
   const file=path.join(f.root,'node_modules/playwright-core/package.json');
   const pkg=JSON.parse(fs.readFileSync(file));
   mutate(f,pkg);
   if(name!=='otherEntry')fs.writeFileSync(file,JSON.stringify(pkg));
   await assert.rejects(f.prepare(),/CDP_/);
   assert.equal(fs.existsSync(f.operationDirectory),false);
  });
 }
});
test('owner CDP core-only signed package-kind drift and raw/copy pin drift fail official validator', {skip:process.platform!=='win32'},async t=>{
 for(const name of ['candidateKindSpoof','candidateKindCaseDrift','sourceCorePinDrift','copiedCorePinDrift','sourceExportsDrift']){
  await t.test(name,async sub=>{
   const f=ownerCdpFixture(sub,{packageKind:'playwright-core-only'}),candidate=await f.prepare();
   if(name==='candidateKindSpoof' || name==='candidateKindCaseDrift'){
    const file=path.join(f.operationDirectory,'candidate-receipt.json'),value=JSON.parse(fs.readFileSync(file));
    value.dependencyMaterialization.packageKind=name==='candidateKindCaseDrift'?'PLAYWRIGHT-CORE-ONLY':'playwright-plus-core';
    fs.writeFileSync(file,JSON.stringify(value));
   }else if(name==='sourceCorePinDrift')fs.appendFileSync(f.playwright,' ');
   else if(name==='copiedCorePinDrift')fs.appendFileSync(candidate.dependencyMaterialization.playwrightModule,' ');
   else {
    const file=path.join(f.root,'node_modules/playwright-core/package.json'),value=JSON.parse(fs.readFileSync(file));
    value.exports['./tamper']='./lib/attached.js';
    fs.writeFileSync(file,JSON.stringify(value));
   }
   const check=ownerCdpValidator(f);
   assert.notEqual(check.status,0,'Official updater accepted '+name);
  });
 }
});
test('owner CDP core-only exact original-config preimage remains protected for rollback', {skip:process.platform!=='win32'},async t=>{
 const f=ownerCdpFixture(t,{packageKind:'playwright-core-only'}),candidate=await f.prepare();
 const op=path.join(f.root,'asset-control/core-only-recovery-fixture');fs.mkdirSync(op,{recursive:true});
 const original=path.join(op,'host-config.before');fs.copyFileSync(f.hostCfg,original);
 const command="$candidate=Read $CandidateReceipt\nAssert-HostCdpRecoveryPreimage $candidate '"+op.replaceAll("'","''")+"'";
 let result=ownerCdpValidator(f,command);
 assert.equal(result.status,0,result.stderr||result.stdout);
 fs.appendFileSync(original,' ');
 result=ownerCdpValidator(f,command);
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/recovery preimage changed/i);
 assert.equal(candidate.hostConfigUnchanged,false);
});

test('owner CDP core-only local recovery backup requires copied core pin, never raw HardLink', {skip:process.platform!=='win32'},async t=>{
 const f=ownerCdpFixture(t,{packageKind:'playwright-core-only'}),candidate=await f.prepare();
 const backupDir=path.join(f.root,'asset-control/core-only-backup-fixture');
 fs.mkdirSync(backupDir,{recursive:true});
 const taskReceipt=f.put('backups/workspace-tunnel-windows-task/fixture.install.json',{status:'unchanged'});
 const launcher=f.put('workspace-mcp/runtime/fixture.hidden.ps1','unchanged');
 const receiptFile=path.join(backupDir,'receipt.json');
 const command="$candidate=Read $CandidateReceipt\n$backup=Read '"+receiptFile.replaceAll("'","''")+"'\nAssert-ChangeBackupPolicy $candidate $backup";
 // The fake wrapper represents PSCommandPath and must be backed up with the
 // exact later validator bytes, not a different temporary test command.
 const staged=ownerCdpValidator(f,command);
 assert.notEqual(staged.status,0);
 const script=path.join(f.root,'owner-cdp-helper-fixture.ps1');
 const originalHost=JSON.parse(fs.readFileSync(path.join(candidate.oldGateway,'config.json'))).providers.find(p=>p.id==='host');
 const rawOnly=[f.cdp.playwrightModule,f.cdp.identityAuditModule];
 const sourcePaths=[script,path.join(f.operationDirectory,'candidate-receipt.json'),
  path.join(f.root,'runtime/components.json'),path.join(f.root,'workspace-mcp/config.json'),
  path.join(f.root,'workspace-mcp/tunnel/profiles/aicc-workspace.yaml'),taskReceipt,launcher,
  path.join(candidate.oldGateway,'config.json'),path.join(candidate.oldGateway,'manifest.json'),
  path.join(candidate.gateway,'config.json'),path.join(candidate.gateway,'manifest.json'),
  path.join(candidate.hostRoot,'host.cjs'),originalHost.entrypoint,
  candidate.oldHostConfigFile,candidate.hostConfigDesiredFile,candidate.cdpBinding.bindingFile,
  candidate.cdpBinding.coordinationFile,candidate.preparerSourceFile,
  path.join(candidate.hostRoot,'manifest.json'),
  ...candidate.cdpBinding.dependencies.filter(pin=>!rawOnly.includes(pin.file)).map(pin=>pin.file),
  ...Object.keys(candidate.dependencyMaterialization.files).map(rel=>path.join(candidate.hostRoot,...rel.split('/'))),
  ...candidate.hostSourceClosure.pins.map(pin=>path.join(candidate.hostSourceRoot,pin.relative))];
 assert.equal(sourcePaths.includes(f.playwright),false);
 assert.ok(sourcePaths.includes(candidate.dependencyMaterialization.playwrightModule));
 const files=[...new Set(sourcePaths)].map((source,i)=>{
  const backupFile='copy-'+String(i).padStart(3,'0')+'.bytes';
  fs.copyFileSync(source,path.join(backupDir,backupFile));
  return {path:source,backupFile,sha256:hash(source)};
 });
 const bundleFile=path.join(backupDir,'bundle.json');
 const bundle={schemaVersion:1,kind:'host-runtime-local-backup/v1',files};
 const updateBundle=()=>{
  fs.writeFileSync(bundleFile,JSON.stringify(bundle));
  fs.writeFileSync(receiptFile,JSON.stringify({kind:bundle.kind,localStatus:'PREPARED',
   bundlePath:bundleFile,bundleSHA256:hash(bundleFile)}));
 };
 updateBundle();
 let validated=ownerCdpValidator(f,command);
 assert.equal(validated.status,0,validated.stderr||validated.stdout);
 bundle.files=bundle.files.filter(row=>row.path!==candidate.dependencyMaterialization.playwrightModule);
 updateBundle();
 validated=ownerCdpValidator(f,command);
 assert.notEqual(validated.status,0);
 assert.match(validated.stderr,/Required host recovery source is missing or changed/i);
});

test('owner CDP full-plus-core refuses mismatched versions and missing full entry',async t=>{
 const cases=[
  {name:'coreVersionMismatch',file:'node_modules/playwright-core/package.json',modify:p=>{p.version='1.62.2';}},
  {name:'fullMainMissing',file:'node_modules/playwright/package.json',modify:p=>{delete p.main;}}
 ];
 for(const entry of cases){
  await t.test(entry.name,async sub=>{
   const f=ownerCdpFixture(sub,{packageKind:'playwright-plus-core'}),file=path.join(f.root,entry.file);
   const contents=JSON.parse(fs.readFileSync(file));entry.modify(contents);
   fs.writeFileSync(file,JSON.stringify(contents));
   await assert.rejects(f.prepare(),/CDP_PLAYWRIGHT_CORE_VERSION_MISMATCH|CDP_OFFICIAL_PACKAGE_MAIN_CHANGED/);
   assert.equal(fs.existsSync(f.operationDirectory),false);
  });
 }
});
test('owner CDP core-only package symlink or junction is refused without source modification',async t=>{
 const f=ownerCdpFixture(t,{packageKind:'playwright-core-only'});
 const source=path.join(f.root,'runtime'),link=path.join(f.root,'node_modules/playwright-core/linked');
 try{fs.symlinkSync(source,link,process.platform==='win32'?'junction':'dir');}
 catch(error){
  if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('OS refused isolated junction fixture');return;}
  throw error;
 }
 await assert.rejects(f.prepare(),/CDP_SOURCE_REPARSE_REFUSED|LINK_REFUSED/);
 assert.equal(fs.existsSync(f.operationDirectory),false);
});
