import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readInstalledGatewayRegistration, readManagementOverview, readMobilePublicStopSupport, readMobilePublicStopSupportAsync } from '../src/management-overview.mjs';
import { createMobileStopStatusCard } from '../public/ai-cowork.js';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-manager-'));
  const write = (relative, value) => { const file = path.join(owner, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  const operations = path.join(owner, 'asset-control', 'operations'); fs.mkdirSync(operations, { recursive: true });
  const binding = { schemaVersion: 1, kind: 'aicc-web-management-owner-binding', executionBoundary: 'owner-registered-fixed-web-manager',
    bindingId: 'private-binding-secret', account: 'private-account-secret', identityHash: 'private-identity-secret', workspaceAlias: 'private-alias-secret',
    allowedActions: ['project-inspect', 'personal-skill-list'], blockedRequestHashes: ['private-denied-hash-secret'], blockedAssetKeys: ['private-asset-secret'], operationDirectory: operations };
  const bindingFile = write('asset-control/binding.json', binding);
  const config = { codexCli: { enabled: true }, webManagement: { enabled: true, bindingFile, bindingSha256: hash(fs.readFileSync(bindingFile)) } };
  write('workspace-mcp/config.json', config);
  write('asset-control/operations/operation-original-01.json', { bindingId: binding.bindingId, phase: 'OUTCOME_UNKNOWN_RECONCILE', request_id: 'private-request-secret', body: 'private-body-secret' });
  write('asset-control/operations/operation-original-01.request.json', { instructions: 'private-body-secret' });
  write('asset-control/operations/operation-other-0001.json', { bindingId: 'different-binding', phase: 'COMPLETED' });
  const gateway = path.join(owner, 'releases', 'unified-mcp', 'fixture-release');
  write('runtime/components.json', { components: { 'unified-mcp': { releaseRoot: gateway } } });
  write('releases/unified-mcp/fixture-release/config.json', { providers: [{ id: 'host', toolNames: ['aicc_host_capabilities', 'aicc_host_open', 'aicc_host_observe', 'aicc_host_act', 'aicc_host_close', 'aicc_host_operation_status'] }] });
  return { owner, bindingFile, binding, config, write };
}

test('management projection separates registered tools, source availability and unobserved execution', () => {
  const f = fixture(), value = readManagementOverview(f.owner);
  assert.equal(value.gpt.status, 'REGISTERED'); assert.equal(value.codex.cliRegistered, true);
  assert.deepEqual(value.gpt.actions, ['project-inspect', 'personal-skill-list']);
  assert.deepEqual(value.gpt.operations.phases, { OUTCOME_UNKNOWN_RECONCILE: 1 });
  assert.equal(value.gpt.operations.records, 1); assert.equal(value.host.toolCount, 6);
  assert.equal(value.host.sessionInventory, false); assert.equal(value.host.explicitWait, false);
  assert.equal(value.host.liveCapacity, 'UNOBSERVED'); assert.equal(value.runtimeVerified, false);
  assert.equal(value.automaticReplay, false);
});

test('management projection exports no account, alias, absolute paths, request bodies or denial hashes', () => {
  const f = fixture(), output = JSON.stringify(readManagementOverview(f.owner));
  assert.equal(output.includes('private-'), false); assert.equal(output.includes(f.owner.replaceAll('\\', '\\\\')), false);
  assert.equal(output.includes('bindingFile'), false); assert.equal(output.includes('request_id'), false);
});

test('changed owner binding never advertises confirmed management support', () => {
  const f = fixture(); fs.appendFileSync(f.bindingFile, ' ');
  const value = readManagementOverview(f.owner);
  assert.equal(value.gpt.status, 'PIN_MISMATCH'); assert.deepEqual(value.gpt.actions, []);
  assert.equal(value.gpt.supportConfirmed, false); assert.equal(value.codex.cliRegistered, true);
});

test('missing registration is distinct from host installation and does not fabricate a live zero', () => {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-manager-missing-'));
  const value = readManagementOverview(owner);
  assert.equal(value.gpt.status, 'NOT_REGISTERED'); assert.equal(value.host.status, 'NOT_REGISTERED');
  assert.equal(value.host.liveCapacity, 'UNOBSERVED'); assert.equal(value.host.toolCount, undefined);
});

test('host inventory reflects only the actual registered tool names', () => {
  const f = fixture(); f.write('releases/unified-mcp/fixture-release/config.json', { providers: [{ id: 'host', toolNames: ['aicc_host_sessions', 'aicc_host_wait'] }] });
  const value = readManagementOverview(f.owner);
  assert.equal(value.host.sessionInventory, true); assert.equal(value.host.explicitWait, true);
  assert.equal(value.host.toolCount, 2); assert.equal(value.host.liveCapacity, 'UNOBSERVED');
});

function installedFixture(t) {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-installed-registration-'));
  t.after(() => fs.rmSync(owner, { recursive: true, force: true }));
  const put = (relative, value) => { const file = path.join(owner, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const release = path.join(owner, 'releases/unified-mcp/installed');
  const entry = put('releases/unified-mcp/installed/gateway.cjs', 'private-command-content');
  const runtime = put('runtime/large-node.exe', Buffer.alloc(5 * 1024 * 1024, 97));
  const config = { schemaVersion: 1, surfaceProfile: 'business-full', hostControl: 'task-owned-v1', workspaceIdentityHash: 'private-identity-secret',
    providers: [['workspace',26,'aicc_fixture_'],['native',31,'codex_fixture_'],['host',8,'aicc_host_fixture_']].map(([id,count,prefix]) => {
      const providerEntry = put(`provider/${id}.cjs`, 'private-provider-content-' + id);
      return { id, command: runtime, entrypoint: providerEntry, args: [providerEntry,'private-argument-secret'],
        files: [runtime,providerEntry].map(file => ({ path: file, sha256: hash(fs.readFileSync(file)) })),
        toolNames: Array.from({ length: count }, (_,index) => prefix + index), toolHash: 'a'.repeat(64) };
    }) };
  const configFile = path.join(release, 'config.json');
  const seal = () => {
    put('releases/unified-mcp/installed/config.json', config);
    put('releases/unified-mcp/installed/manifest.json', { schemaVersion: 1, files: { 'gateway.cjs': hash(fs.readFileSync(entry)), 'config.json': hash(fs.readFileSync(configFile)) } });
  };
  seal();
  put('runtime/components.json', { components: { 'unified-mcp': { releaseRoot: release, entry, entryHash: hash(fs.readFileSync(entry)) } } });
  return { owner, config, configFile, release, entry, put, seal };
}

test('installed registration projects the exact 65-name union with large binary pins and no identity or execution claims', t => {
  const f = installedFixture(t), before = fs.readFileSync(f.configFile);
  const value = readInstalledGatewayRegistration(f.owner), output = JSON.stringify(value);
  assert.equal(value.status, 'VERIFIED_NAME_REGISTRATION');
  assert.deepEqual(value.providers.map(p => [p.id,p.toolCount]), [['workspace',26],['native',31],['host',8]]);
  assert.equal(value.toolCount,65); assert.equal(new Set(value.toolNames).size,65);
  assert.equal(value.filePinsVerified,true);
  assert.equal(value.inputSchemasVerified,false); assert.equal(value.remotePublicationVerified,false); assert.equal(value.executionVerified,false);
  assert.equal(output.includes('private-'),false); assert.equal(output.includes(f.owner.replaceAll('\\','\\\\')),false);
  assert.equal(output.includes('entrypoint'),false); assert.equal(output.includes('command'),false);
  assert.deepEqual(fs.readFileSync(f.configFile),before);
});

test('installed registration rejects duplicate providers, duplicate names and foreign tool prefixes instead of partial counts', t => {
  for (const change of [
    config => { config.providers[1].id='workspace'; },
    config => { config.providers[0].toolNames[1]=config.providers[0].toolNames[0]; },
    config => { config.providers[0].toolNames[0]='private-secret-tool'; }
  ]) {
    const f=installedFixture(t); change(f.config); f.seal();
    const result=readInstalledGatewayRegistration(f.owner);
    assert.equal(result.status,'NOT_VERIFIED'); assert.equal(result.toolCount,null); assert.deepEqual(result.providers,[]);
    assert.equal(JSON.stringify(result).includes('private-secret'),false);
  }
});

test('installed registration reports a broken provider pin without exposing its private path or content', t => {
  const f=installedFixture(t); fs.appendFileSync(f.config.providers[1].entrypoint,'changed');
  const value=readInstalledGatewayRegistration(f.owner);
  assert.equal(value.status,'NOT_VERIFIED'); assert.equal(value.reason,'PIN_MISMATCH');
  assert.equal(value.failedCheck,'provider-file-pin'); assert.equal(value.providerId,'native'); assert.equal(value.pinIndex,1);
  assert.equal(JSON.stringify(value).includes('private-'),false); assert.deepEqual(value.providers,[]);
});

test('installed registration enforces release boundary, manifest pins and the bounded metadata reader', t => {
  const f=installedFixture(t);
  const registryFile=path.join(f.owner,'runtime/components.json'), registry=JSON.parse(fs.readFileSync(registryFile));
  registry.components['unified-mcp'].releaseRoot=path.join(f.owner,'outside-release');fs.writeFileSync(registryFile,JSON.stringify(registry));
  assert.equal(readInstalledGatewayRegistration(f.owner).reason,'BINDING_INVALID');
  registry.components['unified-mcp'].releaseRoot=f.release;fs.writeFileSync(registryFile,JSON.stringify(registry));
  fs.appendFileSync(f.configFile,' ');
  assert.equal(readInstalledGatewayRegistration(f.owner).reason,'PIN_MISMATCH');
  f.seal();fs.writeFileSync(path.join(f.release,'manifest.json'),Buffer.alloc(4*1024*1024+1,32));
  assert.equal(readInstalledGatewayRegistration(f.owner).reason,'FILE_INVALID');
});

test('installed registration refuses hard-linked dependency files even when their bytes match', t => {
  const f=installedFixture(t), original=f.config.providers[2].entrypoint;
  fs.linkSync(original,path.join(f.owner,'linked-provider.cjs'));
  const value=readInstalledGatewayRegistration(f.owner);
  assert.equal(value.status,'NOT_VERIFIED'); assert.equal(value.reason,'FILE_INVALID');
  assert.equal(value.failedCheck,'provider-file-pin'); assert.equal(value.providerId,'host');
});

test('installed registration rejects a linked release ancestor without reading it as a trusted root', t => {
  const f=installedFixture(t), alias=path.join(path.dirname(f.release),'linked-release');
  fs.symlinkSync(f.release,alias,process.platform==='win32'?'junction':'dir');
  const registryFile=path.join(f.owner,'runtime/components.json'), registry=JSON.parse(fs.readFileSync(registryFile));
  registry.components['unified-mcp'].releaseRoot=alias; registry.components['unified-mcp'].entry=path.join(alias,'gateway.cjs');
  fs.writeFileSync(registryFile,JSON.stringify(registry));
  const value=readInstalledGatewayRegistration(f.owner);
  assert.equal(value.status,'NOT_VERIFIED'); assert.equal(value.reason,'LINK_REFUSED'); assert.equal(value.toolCount,null);
});
function mobileStopFixture(t, dated) {
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-g3-stop-'));
  t.after(() => fs.rmSync(owner, { recursive: true, force: true }));
  const runtimeId = '11111111-1111-4111-8111-111111111111';
  const put = (relative, value) => {
    const file = path.join(owner, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  const releaseRoot = path.join(owner, 'releases/cli/test-release');
  const sourceRelative = 'tools/platform/windows/Start-AiccMobilePublicRuntime.ps1';
  const supervisor = put('releases/cli/test-release/' + sourceRelative, dated
    ? '$x | ConvertFrom-Json -AsHashtable -DateKind String'
    : '$x | ConvertFrom-Json -AsHashtable');
  const manifest = put('releases/cli/test-release/.aicc-release.json', {
    schemaVersion: 1, component: 'mobile-public-control',
    files: [{ path: sourceRelative, size: fs.statSync(supervisor).size, sha256: hash(fs.readFileSync(supervisor)) }]
  });
  const statusFile = path.join(owner, 'runtime/mobile-public-control', runtimeId, 'status.json');
  const configFile = put('control-plane/mobile-public-runtime/' + runtimeId + '/runtime.json', {
    schemaVersion: 1, runtimeId, releaseRoot, releaseManifestSha256: hash(fs.readFileSync(manifest)),
    port: 4383, controlNonce: 'private-nonce-secret', statusFile, nodeExecutable: 'private-node-path'
  });
  put('runtime/mobile-public-control/' + runtimeId + '/status.json', {
    schemaVersion: 1, controlProtocolVersion: 2, runtimeId, pid: 54321,
    startedAt: '2026-11-07T00:12:00.410Z', state: 'LISTENING',
    releaseManifestSha256: hash(fs.readFileSync(manifest)), lastOperationId: 'private-operation-secret'
  });
  put('toolchain/pwsh-7.6.6/runtime/pwsh.exe', 'fixture-only-executable');
  const request = put('control-plane/mobile-public-runtime/' + runtimeId + '/stop-requests/original/request.json', { controlNonce: 'private-nonce-secret', token: 'private-token-secret' });
  const claim = put('control-plane/mobile-public-runtime/' + runtimeId + '/stop-requests/original/claim.json', { outcome: 'UNKNOWN', requestBody: 'private-request-secret' });
  return { owner, runtimeId, put, statusFile, configFile, manifest, supervisor, request, claim };
}
function fakeStopProbe(f, supported, onCall = () => {}) {
  return (executable, args, options) => {
    onCall();
    assert.ok(executable.endsWith('pwsh.exe'));
    assert.equal(args.includes('-Submit'), false);
    assert.equal(args.includes('-File'), true);
    assert.equal(args[args.indexOf('-ConfigFile') + 1], f.configFile);
    assert.equal(args[args.indexOf('-ExpectedConfigSha256') + 1], hash(fs.readFileSync(f.configFile)));
    assert.equal(args[args.indexOf('-WaitSeconds') + 1], '0');
    assert.ok(options.timeout <= 6000);
    return { status: 0, stdout: JSON.stringify({
      runtimeId: f.runtimeId, runtimeState: 'LISTENING',
      submittedThisCall: false, automaticReplay: false, forceStop: false,
      stopSubmissionSupported: supported,
      stopHoldReason: supported ? null : 'INSTALLED_SUPERVISOR_DATE_STRING_UNSUPPORTED',
      controlNonce: 'private-nonce-secret', pid: 54321, operationId: 'private-operation-secret'
    }) };
  };
}
test('G3 legacy supervisor remains unsupported; original UNKNOWN request and secrets are untouched', t => {
  const f = mobileStopFixture(t, false);
  const before = [fs.readFileSync(f.request), fs.readFileSync(f.claim)];
  let calls = 0;
  const result = readMobilePublicStopSupport(f.owner, { spawn: fakeStopProbe(f, false, () => calls++) });
  assert.equal(calls, 1);
  assert.equal(result.status, 'REPORTED_LISTENING');
  assert.equal(result.installedSupervisorSupport, 'UNSUPPORTED');
  assert.equal(result.stopSubmissionSupported, false);
  assert.equal(result.stopHoldReason, 'INSTALLED_SUPERVISOR_DATE_STRING_UNSUPPORTED');
  assert.equal(result.operationalTransition, 'HOLD');
  assert.equal(result.installationState, 'WAITING_FOR_NORMAL_STOP_AND_RECOVERY');
  assert.equal(result.liveProcessVerified, false);
  assert.equal(result.installControlEnabled, false);
  assert.equal(result.stopControlEnabled, false);
  assert.deepEqual([fs.readFileSync(f.request), fs.readFileSync(f.claim)], before);
  const exposed = JSON.stringify(result);
  for (const secret of ['private-', f.owner, f.runtimeId, '54321', 'controlNonce', 'operationId', 'token']) assert.equal(exposed.includes(secret), false);
});
test('G3 repaired dated supervisor reports support, but never enables source-only installation or stop', t => {
  const f = mobileStopFixture(t, true);
  assert.match(fs.readFileSync(f.supervisor, 'utf8'), /-DateKind String/);
  const result = readMobilePublicStopSupport(f.owner, { spawn: fakeStopProbe(f, true) });
  assert.equal(result.installedSupervisorSupport, 'SUPPORTED');
  assert.equal(result.stopSubmissionSupported, true);
  assert.equal(result.stopHoldReason, null);
  assert.equal(result.operationalTransition, 'HOLD');
  assert.equal(result.stopControlEnabled, false);
  assert.equal(result.installControlEnabled, false);
});

test('G3 supported supervisor still refuses new stop when an earlier delivery is uncertain', t => {
  const f = mobileStopFixture(t, true);
  const before = [fs.readFileSync(f.request), fs.readFileSync(f.claim)];
  const probe = fakeStopProbe(f, true);
  const result = readMobilePublicStopSupport(f.owner, { spawn: (...args) => {
    const answer = probe(...args), data = JSON.parse(answer.stdout);
    Object.assign(data, { installedSupervisorSupported: true, stopSubmissionSupported: false,
      stopHoldReason: 'EXISTING_STOP_OUTCOME_UNCONFIRMED', otherPendingStopRequests: 2 });
    return { ...answer, stdout: JSON.stringify(data) };
  } });
  assert.equal(result.installedSupervisorSupport, 'SUPPORTED');
  assert.equal(result.stopSubmissionSupported, false);
  assert.equal(result.stopHoldReason, 'EXISTING_STOP_OUTCOME_UNCONFIRMED');
  assert.equal(result.stopControlEnabled, false);
  assert.deepEqual([fs.readFileSync(f.request), fs.readFileSync(f.claim)], before);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});
test('G3 changed manifest, failed probe and unreadable status never fabricate installed stop support', t => {
  const f = mobileStopFixture(t, true);
  fs.appendFileSync(f.manifest, ' ');
  let calls = 0;
  const changed = readMobilePublicStopSupport(f.owner, { spawn: () => { calls++; throw Error('must not call'); } });
  assert.equal(calls, 0);
  assert.equal(changed.installedSupervisorSupport, 'UNKNOWN');
  assert.equal(changed.stopSubmissionSupported, null);
  assert.equal(changed.stopHoldReason, 'INSTALLED_SUPERVISOR_IDENTITY_UNKNOWN');
  const freshManifest = JSON.parse(fs.readFileSync(f.manifest, 'utf8'));
  f.put('releases/cli/test-release/.aicc-release.json', freshManifest);
  const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  config.releaseManifestSha256 = hash(fs.readFileSync(f.manifest)); fs.writeFileSync(f.configFile, JSON.stringify(config));
  const status = JSON.parse(fs.readFileSync(f.statusFile, 'utf8'));
  status.releaseManifestSha256 = config.releaseManifestSha256; fs.writeFileSync(f.statusFile, JSON.stringify(status));
  const failure = readMobilePublicStopSupport(f.owner, { spawn: () => ({ status: 1, stdout: 'private-error-content' }) });
  assert.equal(failure.stopHoldReason, 'PROBE_UNAVAILABLE');
  assert.equal(JSON.stringify(failure).includes('private-error-content'), false);
  fs.writeFileSync(f.statusFile, '{');
  const broken = readMobilePublicStopSupport(f.owner, { spawn: fakeStopProbe(f, true) });
  assert.equal(broken.status, 'UNKNOWN');
  assert.equal(broken.stopSubmissionSupported, null);
});
test('G3 ambiguous active generations produce UNKNOWN without a probe', t => {
  const f = mobileStopFixture(t, true), second = '22222222-2222-4222-8222-222222222222';
  const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  config.runtimeId = second; config.statusFile = path.join(f.owner, 'runtime/mobile-public-control', second, 'status.json');
  f.put('control-plane/mobile-public-runtime/' + second + '/runtime.json', config);
  const status = JSON.parse(fs.readFileSync(f.statusFile, 'utf8')); status.runtimeId = second;
  f.put('runtime/mobile-public-control/' + second + '/status.json', status);
  const result = readMobilePublicStopSupport(f.owner, { spawn: () => { throw Error('must not run'); } });
  assert.equal(result.status, 'UNKNOWN'); assert.equal(result.stopHoldReason, 'STATUS_AMBIGUOUS');
});
test('G3 read-only UI shows Korean hold reason to keyboard and screen readers with disabled actions', () => {
  const previous = globalThis.document, nodes = [];
  globalThis.document = { createElement(tag) {
    const entry = { tagName: tag.toUpperCase(), children: [], attributes: {}, disabled: false,
      append(...children) { this.children.push(...children); },
      setAttribute(name, value) { this.attributes[name] = value; } };
    nodes.push(entry); return entry;
  } };
  try {
    const card = createMobileStopStatusCard({ reportedRuntimeState: 'LISTENING',
      installedSupervisorSupport: 'UNSUPPORTED', stopSubmissionSupported: false,
      sourceComparison: 'DIFFERS', stopHoldReason: 'INSTALLED_SUPERVISOR_DATE_STRING_UNSUPPORTED' }, 'fake');
    assert.equal(card.attributes['aria-label'], 'G3 모바일 정상 종료와 운영 설치 상태');
    const controls = nodes.filter(node => node.tagName === 'BUTTON');
    assert.equal(controls.length, 2);
    assert.ok(controls.every(node => node.disabled === true));
    const explanation = nodes.find(node => node.attributes.role === 'status');
    assert.equal(explanation.tabIndex, 0);
    assert.match(explanation.textContent, /구세대.*날짜|구세대 supervisor/);
    assert.ok(controls.every(node => node.attributes['aria-describedby'] === explanation.id));
    assert.ok(nodes.some(node => /기록상 LISTENING/.test(node.textContent ?? '')));
    for (const sourceComparison of ['MATCHES', 'DIFFERS', 'UNKNOWN']) {
      nodes.length = 0;
      createMobileStopStatusCard({ sourceComparison, installedSupervisorSupport: 'SUPPORTED',
        stopSubmissionSupported: true, reportedRuntimeState: 'LISTENING' }, 'copy');
      assert.ok(!nodes.some(node => /현재 설치판 미적용|운영 설치 대기/.test(node.textContent ?? '')));
      assert.ok(nodes.some(node => /운영 교체.*이 화면에서 실행할 수 없습니다/.test(node.textContent ?? '')));
      assert.ok(nodes.filter(node => node.tagName === 'BUTTON').every(node => node.disabled));
    }
    for (const [reason, expected] of [
      ['EXISTING_STOP_OUTCOME_UNCONFIRMED', /이전에 보낸.*결과.*새 요청/],
      ['EXISTING_STOP_INVENTORY_UNKNOWN', /기존 정상 종료 요청.*원 기록.*차단/]
    ]) {
      nodes.length = 0;
      createMobileStopStatusCard({ reportedRuntimeState: 'LISTENING',
        installedSupervisorSupport: 'SUPPORTED', stopSubmissionSupported: false,
        stopHoldReason: reason }, 'pending');
      assert.match(nodes.find(node => node.attributes.role === 'status').textContent, expected);
      assert.ok(nodes.filter(node => node.tagName === 'BUTTON').every(node => node.disabled));
      assert.ok(nodes.some(node => /지원 확인.*기존 요청 확인 전/.test(node.textContent ?? '')));
    }
  } finally { globalThis.document = previous; }
});


test('G3 async installed probe leaves the event loop responsive and preserves the same evidence', async t => {
  const f = mobileStopFixture(t, true);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0, ticked = false;
  const probe = fakeStopProbe(f, true, () => calls++);
  const reading = readMobilePublicStopSupportAsync(f.owner, { execute: async (...args) => {
    await pending;
    return probe(...args);
  }});
  await new Promise(resolve => setImmediate(() => { ticked = true; resolve(); }));
  assert.equal(ticked, true); assert.equal(calls, 0);
  release();
  const result = await reading;
  assert.equal(calls, 1); assert.equal(result.installedSupervisorSupport, 'SUPPORTED');
  assert.equal(result.stopControlEnabled, false); assert.equal(result.automaticReplay, false);
  assert.deepEqual(result, readMobilePublicStopSupport(f.owner, { spawn: fakeStopProbe(f, true) }));
});

test('G3 async failed or changed probe never enables control or leaks failure content', async t => {
  const f = mobileStopFixture(t, true);
  for (const execute of [async () => { throw Error('private-raw-error'); },
    async () => ({ status: 1, stdout: 'private-raw-error' }),
    async (...args) => { const answer = fakeStopProbe(f, true)(...args); const value = JSON.parse(answer.stdout);
      value.runtimeId = 'foreign-runtime'; return { ...answer, stdout: JSON.stringify(value) }; }]) {
    const value = await readMobilePublicStopSupportAsync(f.owner, { execute });
    assert.equal(value.installedSupervisorSupport, 'UNKNOWN');
    assert.equal(value.stopControlEnabled, false); assert.equal(value.installControlEnabled, false);
    assert.equal(JSON.stringify(value).includes('private-'), false);
  }
  fs.appendFileSync(f.manifest, ' ');
  const value = await readMobilePublicStopSupportAsync(f.owner, { execute: async () => { assert.fail('invalid pin must not launch probe'); } });
  assert.equal(value.stopHoldReason, 'INSTALLED_SUPERVISOR_IDENTITY_UNKNOWN');
});
test('G3 async probe rejects generation changed while the process reply was pending', async t => {
  const f = mobileStopFixture(t, true);
  const result = await readMobilePublicStopSupportAsync(f.owner, { execute: async (...args) => {
    const reply = fakeStopProbe(f, true)(...args);
    const status = JSON.parse(fs.readFileSync(f.statusFile)); status.state = 'DRAINING';
    fs.writeFileSync(f.statusFile, JSON.stringify(status)); return reply;
  }});
  assert.equal(result.installedSupervisorSupport, 'UNKNOWN');
  assert.equal(result.stopHoldReason, 'PROBE_UNAVAILABLE');
  assert.equal(result.stopControlEnabled, false);
});

test('G3 overlapping installed reads share one pending probe but never cache settled support', async t => {
  const f = mobileStopFixture(t, true);
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const execute = async (...args) => { calls++; await gate; return fakeStopProbe(f, true)(...args); };
  const first = readMobilePublicStopSupportAsync(f.owner, { execute });
  const second = readMobilePublicStopSupportAsync(path.join(f.owner, '.'), { execute });
  assert.equal(calls, 1, 'overlapping reads must not launch duplicate PowerShell processes');
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.installedSupervisorSupport, 'SUPPORTED');
  assert.deepEqual(left, right);
  left.stopControlEnabled = true;
  assert.equal(right.stopControlEnabled, false, 'callers must not share mutable evidence');
  await readMobilePublicStopSupportAsync(f.owner, { execute });
  assert.equal(calls, 2, 'the next completed read must obtain fresh evidence');
});

test('G3 overlapping reads retain pending-generation refusal and recover only on a fresh probe', async t => {
  const f = mobileStopFixture(t, true);
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const execute = async (...args) => { calls++; await gate; return fakeStopProbe(f, true)(...args); };
  const first = readMobilePublicStopSupportAsync(f.owner, { execute });
  const second = readMobilePublicStopSupportAsync(f.owner, { execute });
  const original = fs.readFileSync(f.statusFile);
  const changed = JSON.parse(original); changed.state = 'DRAINING';
  fs.writeFileSync(f.statusFile, JSON.stringify(changed));
  release();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.stopHoldReason, 'PROBE_UNAVAILABLE');
    assert.equal(result.stopControlEnabled, false);
  }
  assert.equal(calls, 1);
  fs.writeFileSync(f.statusFile, original);
  assert.equal((await readMobilePublicStopSupportAsync(f.owner, { execute })).installedSupervisorSupport, 'SUPPORTED');
  assert.equal(calls, 2);
});

test('G3 failed pending probes do not poison later reads or merge distinct owners', async t => {
  const left = mobileStopFixture(t, true), right = mobileStopFixture(t, true);
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const execute = async () => { calls++; await gate; throw Error('private-error'); };
  const reads = [readMobilePublicStopSupportAsync(left.owner, { execute }),
    readMobilePublicStopSupportAsync(left.owner, { execute }),
    readMobilePublicStopSupportAsync(right.owner, { execute })];
  assert.equal(calls, 2);
  release();
  for (const value of await Promise.all(reads)) assert.equal(value.installedSupervisorSupport, 'UNKNOWN');
  const fresh = await readMobilePublicStopSupportAsync(left.owner, { execute: async (...args) => fakeStopProbe(left, true)(...args) });
  assert.equal(fresh.installedSupervisorSupport, 'SUPPORTED');
});
