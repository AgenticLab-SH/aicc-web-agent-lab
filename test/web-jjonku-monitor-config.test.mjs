import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createWebJjonkuMonitorConfig } from '../src/web-jjonku-monitor-config.mjs';
const id = '11111111-1111-4111-8111-111111111111';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-supervisor-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { ownerRoot: root, resolveBinding: role => ({ role, status: 'active', accountAlias: 'selected-user', workspaceAlias: 'business', identityHash: 'a'.repeat(64), workspaceIdentityHash: 'b'.repeat(64) }) };
  return { root, options, service: createWebJjonkuMonitorConfig(options) };
}
function target(extra = {}) { return { id: 'selected-chat', enabled: true, role: 'secondary', conversationUrl: 'https://chatgpt.com/c/' + id, autoResume: true, autoResumeMode: 'response-only', ...extra }; }
function edit(service, targets, enabled = true) { const current = service.status(); return { ...current.config, expectedRevision: current.revision, enabled, targets }; }
test('new selection is off and does not silently migrate old seven chats or write automation', t => {
  const { root, service } = fixture(t); fs.mkdirSync(path.join(root, 'control-plane'));
  const legacy = path.join(root, 'control-plane', 'web-jjonku-monitor.json'); fs.writeFileSync(legacy, '{"enabled":true}');
  const status = service.status();
  assert.equal(status.config.enabled, false); assert.deepEqual(status.config.targets, []); assert.equal(status.legacyPreserved, true);
  assert.equal(status.runner.rawAutomationWrites, false); assert.equal(status.runner.actualDispatchesProved, false);
  assert.equal(fs.readFileSync(legacy, 'utf8'), '{"enabled":true}');
});
test('one save binds only selected exact chats to registered identities and is private supervisor compatible', t => {
  const { service } = fixture(t);
  const saved = service.save(edit(service, [target({ identityHash: 'c'.repeat(64) })]));
  const config = JSON.parse(fs.readFileSync(saved.configFile, 'utf8'));
  assert.equal(config.schemaVersion, 1); assert.equal(config.targets.length, 1);
  assert.equal(config.targets[0].identityHash, 'a'.repeat(64)); assert.equal(config.targets[0].autoResumeMode, 'response-only');
  assert.equal(config.localApproval.arbitraryDispatch, false); assert.equal(config.localApproval.scope, 'selected-exact-chats-fixed-resume-only');
});
test('stale revision and duplicate conversation preserve the saved selection', t => {
  const { service } = fixture(t); const first = edit(service, [target()]); const saved = service.save(first);
  assert.throws(() => service.save(first), /다른 주체/);
  assert.throws(() => service.save(edit(service, [target(), target({ id: 'same-chat' })])), /중복/);
  assert.equal(service.status().revision, saved.revision);
});
test('unknown account, changed URL, missing mode cannot become active', t => {
  const { service } = fixture(t);
  assert.throws(() => service.save(edit(service, [target({ role: 'unregistered' })])), /등록 계정/);
  assert.throws(() => service.save(edit(service, [target({ conversationUrl: 'https://example.com/c/' + id })])), /원래 대화/);
  assert.throws(() => service.save(edit(service, [target({ autoResumeMode: undefined })])), /재개 방식/);
  assert.equal(service.status().config.enabled, false);
});
test('turning selected work off is available after identity resolution becomes unavailable', t => {
  const { service, options } = fixture(t); service.save(edit(service, [target()]));
  options.resolveBinding = () => { throw Error('unavailable'); };
  const disabled = service.save(edit(service, [target({ enabled: false })], false));
  assert.equal(disabled.config.enabled, false); assert.equal(disabled.config.targets[0].enabled, false);
  assert.equal(disabled.config.targets[0].identityHash, 'a'.repeat(64));
});
test('strict external mode stores explicit receipt reference without claiming it is currently idle', t => {
  const { service, root } = fixture(t);
  const saved = service.save(edit(service, [target({ autoResumeMode: 'strict-external', externalStateFile: path.join(root, 'caller.json'), externalStateSha256: 'f'.repeat(64) })]));
  assert.equal(saved.config.targets[0].autoResumeMode, 'strict-external');
  assert.equal(saved.runner.actualDispatchesProved, false);
});

test('timer readback distinguishes a pinned fresh OFF report from stale or changed receipts', t => {
  const { service, options, root } = fixture(t);
  const saved = service.save(edit(service, [], false));
  const release = path.join(root, 'releases', 'webgpt-supervisor', 'fixture'); fs.mkdirSync(release, { recursive: true });
  const manifestFile = path.join(release, 'manifest.json'); fs.writeFileSync(manifestFile, '{}');
  const directory = path.dirname(saved.configFile), observedAt = new Date().toISOString();
  fs.writeFileSync(path.join(directory, 'installation.json'), JSON.stringify({ schemaVersion: 1, componentId: 'aicc.owner-local.webgpt-supervisor/v1', configFile: saved.configFile, releaseRoot: release, manifestFile, manifestSha256: createHash('sha256').update('{}').digest('hex'), entrypoint: path.join(release, 'cli.mjs') }));
  const status = { schemaVersion: 1, configFile: saved.configFile, configSha256: saved.revision, observedAt, state: 'OFF', pid: 123, targetCount: 0, aiPolling: false };
  fs.writeFileSync(path.join(directory, 'worker-status.json'), JSON.stringify(status));
  const fresh = service.status().runner;
  assert.equal(fresh.installationVerified, true); assert.equal(fresh.receiptFresh, true); assert.equal(fresh.reportedState, 'OFF');
  assert.equal(fresh.processLivenessVerified, false); assert.equal(fresh.actualDispatchesProved, false);
  options.now = () => new Date(Date.parse(observedAt) + 30000).toISOString();
  const staleService = createWebJjonkuMonitorConfig(options);
  assert.equal(staleService.status().runner.receiptFresh, false);
  fs.writeFileSync(manifestFile, '{"changed":true}');
  assert.equal(service.status().runner.installationVerified, false);
});

function grant() { return { id: 'peer-review', enabled: true, sourceTargetId: 'selected-chat', recipientIds: ['peer-chat'], purpose: 'Review selected result', templateText: 'Review this result: {{result}}', inputFields: [{ name: 'result', maxLength: 200 }], expiresAt: new Date(Date.now() + 86400000).toISOString() }; }
function peers() { return [target({ enabled: false, autoResume: false }), target({ id: 'peer-chat', enabled: false, autoResume: false, conversationUrl: 'https://chat.example.invalid/c/demo' })]; }
function installPeerFixture(root, service) {
  const configFile = service.status().configFile, releaseRoot = path.join(root, 'releases', 'webgpt-supervisor', 'peer-fixture');
  fs.mkdirSync(releaseRoot, { recursive: true }); fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const manifestFile = path.join(releaseRoot, 'manifest.json'), bytes = JSON.stringify({ capabilities: { peerTemplateDispatch: true } }); fs.writeFileSync(manifestFile, bytes);
  fs.writeFileSync(path.join(path.dirname(configFile), 'installation.json'), JSON.stringify({ schemaVersion: 1, componentId: 'aicc.owner-local.webgpt-supervisor/v1', configFile, releaseRoot, manifestFile, manifestSha256: createHash('sha256').update(bytes).digest('hex'), entrypoint: path.join(releaseRoot, 'cli.mjs') }));
}
test('peer approval binds exact references and separately permits only the selected template', t => {
  const { service, root } = fixture(t), input = grant(); installPeerFixture(root, service);
  const saved = service.save({ ...edit(service, peers()), peerGrants: [input] });
  const g = saved.config.peerGrants[0];
  assert.equal(g.source.identityHash, 'a'.repeat(64)); assert.equal(g.recipients[0].targetId, 'peer-chat');
  assert.equal(g.template.sha256, createHash('sha256').update(input.templateText).digest('hex'));
  assert.equal(g.localApproval.scope, 'selected-peer-template-dispatch-only'); assert.match(g.localApproval.grantDigest, /^[a-f0-9]{64}$/);
  assert.equal(g.revision, 1); assert.equal(saved.config.targets.every(t => !t.autoResume && !t.enabled), true);
  const again = service.save({ ...edit(service, peers()), peerGrants: [input] }).config.peerGrants[0];
  assert.equal(again.revision, 1); assert.equal(again.localApproval.grantDigest, g.localApproval.grantDigest);
});
test('peer change and revocation advance revision while unavailable identity still allows OFF', t => {
  const { service, options, root } = fixture(t), input = grant(); installPeerFixture(root, service);
  service.save({ ...edit(service, peers()), peerGrants: [input] });
  const changed = service.save({ ...edit(service, peers()), peerGrants: [{ ...input, purpose: 'Different approved purpose' }] }).config.peerGrants[0];
  assert.equal(changed.revision, 2);
  options.resolveBinding = () => { throw Error('identity unavailable'); };
  const off = service.save({ ...edit(service, peers(), false), peerGrants: [{ ...changed, enabled: false }] }).config.peerGrants[0];
  assert.equal(off.revision, 3); assert.equal(off.enabled, false); assert.ok(off.revokedAt);
});
test('peer mismatched fields, self recipient, expired grant and missing target preserve selection', t => {
  const { service } = fixture(t); const before = service.status().revision;
  for (const input of [{ ...grant(), templateText: '{{unknown}}' }, { ...grant(), recipientIds: ['selected-chat'] }, { ...grant(), expiresAt: '2000-01-01T00:00:00.000Z' }, { ...grant(), sourceTargetId: 'absent' }]) {
    assert.throws(() => service.save({ ...edit(service, peers()), peerGrants: [input] }));
    assert.equal(service.status().revision, before);
  }
});
test('peer enabled requires the installed capability while OFF preparation remains available', t => {
  const { service } = fixture(t);
  assert.throws(() => service.save({ ...edit(service, peers()), peerGrants: [grant()] }), /아직 없습니다/);
  const prepared = service.save({ ...edit(service, peers(), false), peerGrants: [{ ...grant(), enabled: false }] });
  assert.equal(prepared.config.peerGrants[0].enabled, false);
});
test('changed approved peer binding must be disabled before reapproval', t => {
  const { service, root } = fixture(t); installPeerFixture(root, service);
  const input = grant(); service.save({ ...edit(service, peers()), peerGrants: [input] });
  const altered = peers(); altered[1].conversationUrl = 'https://chat.example.invalid/c/demo';
  assert.throws(() => service.save({ ...edit(service, altered), peerGrants: [input] }), /먼저 이 전달 승인을 끄고/);
});
