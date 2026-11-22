import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRecoveryHandoffService, DEFAULT_RECOVERY_SUPPORT_TIMEOUT_MS, inspectCodexRootOnlyContainment } from '../src/recovery-handoff.mjs';

function supportFixture() {
  return {
    ok: false,
    generatedAt: '2026-08-16T01:00:00.000Z',
    components: [
      { id: 'web-gpt', state: 'ready', healthy: true, version: '2.0.0-aicc.17', activeHttpTurns: 0, activeBrowserHttpTurns: 0, activeBrowserTurns: 0 },
      { id: 'web-gpt-rescue', state: 'ready', version: '2.0.0-aicc.6', active: { http: 0, browserHttp: 0, browser: 0 } },
      { id: 'workspace-mcp-business', state: 'ready', workspaceCount: 32, publication: { toolCount: 22, needsPublish: false } },
      { id: 'workspace-mcp-personal', state: 'attention', workspaceCount: 40, publication: { toolCount: 18, needsPublish: true } },
      { id: 'browser-broker', state: 'ready', activeTaskTargets: 0 },
      { id: 'codex-routes', state: 'ready', nativeReady: true },
      { id: 'ocx', state: 'ready', version: '2.14.1' }
    ],
    accidentalSecret: 'Bearer should-not-survive',
    consultationPrompt: 'safe'
  };
}

test('recovery support timeout covers the bounded survival-path collector window', () => {
  assert.equal(DEFAULT_RECOVERY_SUPPORT_TIMEOUT_MS, 15_000);
});

test('recovery handoff writes immutable owner-only Markdown, JSON, and checksummed manifest', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-recovery-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const opened = [];
  const times = [new Date('2026-08-16T01:00:00.000Z'), new Date('2026-08-16T02:00:00.000Z')];
  const service = createRecoveryHandoffService({
    home,
    root: path.join(home, '.ai-control-center', 'recovery', 'web-gpt-handoff'),
    platform: 'darwin',
    now: () => times.shift() ?? new Date('2026-08-16T02:00:00.000Z'),
    supportCollector: async () => supportFixture(),
    transportInspector: () => ({ ok: true, state: 'RECOVERED_NO_CURRENT_PARSE_ERROR', privacy: { rawLogIncluded: false } }),
    containmentInspector: () => ({ ok: true, state: 'ROOT_ONLY_CONTAINMENT_ACTIVE', rawConfigIncluded: false }),
    nativeSafetyInspector: () => ({ ok: true, state: 'NATIVE_CALLBACK_ROUTE_SAFE', compactRoute: 'https://chatgpt.com/backend-api/codex' }),
    releaseMatrixInspector: () => ({ ok: false, state: 'WEB_GPT_RELEASE_MATRIX_MISMATCH', sameRelease: false }),
    openFinder: async file => { opened.push(file); }
  });

  assert.equal(service.status().available, false);
  const first = await service.refresh();
  assert.equal(first.available, true);
  assert.equal(first.latest.ownerOnly, true);
  assert.match(first.documents.markdown, /open-AICC 최후 복구 전달문/);
  assert.match(first.documents.markdown, /17841/);
  assert.equal(first.documents.markdown.includes('should-not-survive'), false);
  assert.equal(first.documents.json.includes(home), false);
  assert.equal(first.documents.json.includes(process.env.AICC_WORKSPACE_PROJECTS_ROOT ?? '__not_configured__'), false);
  assert.equal(first.documents.json.includes('Bearer should-not-survive'), false);
  assert.equal(JSON.parse(first.documents.json).desktopContainment.state, 'ROOT_ONLY_CONTAINMENT_ACTIVE');
  assert.equal(JSON.parse(first.documents.json).nativeCallbackSafety.state, 'NATIVE_CALLBACK_ROUTE_SAFE');
  assert.equal(JSON.parse(first.documents.json).webGptReleaseMatrix.sameRelease, false);
  assert.equal(JSON.parse(first.documents.json).routeTopology.directWebGptRescue.state, 'ready');
  assert.equal(JSON.parse(first.documents.json).routeTopology.integratedWebGpt.state, 'ready');
  assert.deepEqual(JSON.parse(first.documents.json).routeTopology.integratedWebGpt.active, { http: 0, browserHttp: 0, browser: 0 });
  assert.equal(JSON.parse(first.documents.json).routeTopology.workspaceSurfaces.personal.workspaceCount, 40);
  assert.equal(JSON.parse(first.documents.json).routeTopology.browserGate.activeTaskTargets, 0);
  assert.equal(JSON.parse(first.documents.json).currentSupport.components.find(item => item.id === 'workspace-mcp-business').workspaceCount, 32);
  assert.equal(JSON.parse(first.documents.json).currentSupport.components.find(item => item.id === 'workspace-mcp-personal').workspaceCount, 40);
  assert.equal(first.documents.json.includes('<circular>'), false);
  assert.match(first.latest.markdownSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.mirror.workspaceReadable, true);
  assert.equal(first.mirror.ownerOnly, true);
  assert.equal(fs.readFileSync(path.join(home, 'dev', 'projects', 'ai-platform', '.aicc-recovery', 'LATEST.md'), 'utf8'), first.documents.markdown);

  const firstBundle = first.latest.bundleId;
  const second = await service.refresh();
  assert.notEqual(second.latest.bundleId, firstBundle);
  const bundles = fs.readdirSync(path.join(home, '.ai-control-center', 'recovery', 'web-gpt-handoff', 'bundles'));
  assert.equal(bundles.length, 2);
  assert.ok(bundles.includes(firstBundle));

  const revealed = await service.reveal();
  assert.equal(revealed.revealed, true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].endsWith('AICC-WEB-GPT-RECOVERY.md'), true);
  assert.equal(revealed.path.startsWith('~/.ai-control-center/'), true);
});

test('root-only containment inspection reads only bounded concurrency controls', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-root-only-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configFile = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `[features]\nmulti_agent_v2 = { enabled = false, max_concurrent_threads_per_session = 1 }\nsecret = "do-not-copy"\n\n[agents]\nenabled = false\nmax_concurrent_threads_per_session = 4\n`);
  const result = inspectCodexRootOnlyContainment({ home, configFile });
  assert.equal(result.ok, true);
  assert.equal(result.v1AgentsDisabled, true);
  assert.equal(result.v2FeatureDisabled, true);
  assert.equal(result.v2TotalThreadLimit, 1);
  assert.equal(result.rawConfigIncluded, false);
  assert.equal(JSON.stringify(result).includes('do-not-copy'), false);
});

test('root-only containment accepts a disabled scalar v2 feature with V1 agents disabled', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-root-disabled-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configFile = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `[features]\nmulti_agent_v2 = false\n\n[agents]\nenabled = false\nmax_concurrent_threads_per_session = 4\n`);
  const result = inspectCodexRootOnlyContainment({ home, configFile });
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'ALL_LOCAL_MULTI_AGENT_SURFACES_DISABLED');
  assert.equal(result.v2TotalThreadLimit, null);
});

test('root-only containment accepts the installed default-disabled v2 feature when it is absent', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-root-default-disabled-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configFile = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `[features]\nmemories = true\n\n[agents]\nenabled = false\n`);
  const result = inspectCodexRootOnlyContainment({ home, configFile, v2DefaultEnabled: false });
  assert.equal(result.ok, true);
  assert.equal(result.v2FeatureDeclared, false);
  assert.equal(result.v2DefaultAssumedDisabled, true);
});

test('recovery handoff records UNKNOWN and completes when support collection stalls', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-recovery-timeout-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = createRecoveryHandoffService({
    home,
    supportTimeoutMs: 250,
    supportCollector: () => new Promise(() => {}),
    transportInspector: () => ({ ok: false, state: 'DEGRADED_JSONL_PARSE_FAILURE' }),
    containmentInspector: () => ({ ok: true, state: 'ROOT_ONLY_CONTAINMENT_ACTIVE' })
  });
  const started = Date.now();
  const result = await service.refresh();
  assert.ok(Date.now() - started < 1_000);
  assert.equal(JSON.parse(result.documents.json).currentSupport.state, 'UNKNOWN_SUPPORT_COLLECTION_TIMEOUT');
  assert.equal(result.latest.ownerOnly, true);
});

test('Finder reveal fails closed outside macOS', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-recovery-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const service = createRecoveryHandoffService({ home, platform: 'linux', supportCollector: async () => supportFixture(), transportInspector: () => ({ ok: true }) });
  await assert.rejects(service.reveal(), error => error.code === 'finder_unavailable');
});
