import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  advanceOcxReadinessProof,
  childEnvironment,
  classifyOcxRouteMutation,
  inspectOcxUpstreamOnlyIntent,
  reconcileOcxStartupFiles,
  sealOcxLaunchArtifact,
  validateOcxHealthPayload,
  validateOcxReadinessPayload
} from '../src/ocx-upstream-service-wrapper.mjs';
import { cutoverOcxUpstreamLaunchAgent } from '../tools/platform/ocx/cutover-upstream-launch-agent.mjs';
import { installOcxUpstreamLaunchAgent } from '../tools/platform/ocx/install-upstream-launch-agent.mjs';

function readyRuntimeState() {
  return {
    schemaVersion: 2,
    state: 'ready',
    routeMutation: false,
    ownerPid: 42,
    launcherPid: 77,
    servicePid: 99,
    listenerPid: 99,
    serviceStartToken: 'c'.repeat(64),
    launchArtifact: { sha256: 'd'.repeat(64) },
    livenessCurrent: true,
    readinessCurrent: true,
    artifactCurrent: true,
    readinessProof: {
      current: true,
      ready: true,
      consecutive: 3,
      required: 3,
      identity: 'e'.repeat(64)
    },
    codexHomeIsolation: true,
    updatedAt: new Date(Date.now() + 1_000).toISOString()
  };
}

test('OCX startup reconciler accepts only a root catalog pointer insertion', () => {
  const before = 'model = "gpt-5"\n\n[features]\napps = true\n';
  const after = 'model = "gpt-5"\nmodel_catalog_json = "/tmp/opencodex-catalog.json"\n\n[features]\napps = true\n';
  assert.equal(classifyOcxRouteMutation(before, after), 'ocx_catalog_pointer_only');
  assert.equal(classifyOcxRouteMutation(before, before), 'unchanged');
  assert.equal(classifyOcxRouteMutation(before, after.replace('apps = true', 'apps = false')), 'conflict');
  assert.equal(classifyOcxRouteMutation(before, before.replace('[features]', '[features]\nmodel_catalog_json = "nested"')), 'conflict');
});

test('OCX startup reconciler restores only its exact config and invalidated cache writes', t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ocx-reconcile-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const config = path.join(codexHome, 'config.toml');
  const cache = path.join(codexHome, 'models_cache.json');
  const catalog = path.join(codexHome, 'opencodex-catalog.json');
  const original = Buffer.from('model = "gpt-5"\n\n[features]\napps = true\n');
  fs.writeFileSync(config, original, { mode: 0o600 });
  const beforeConfig = { exists: true, bytes: original, mode: 0o600 };
  const beforeCache = { exists: false, bytes: null, mode: 0o600 };
  fs.writeFileSync(config, 'model = "gpt-5"\nmodel_catalog_json = "/tmp/opencodex-catalog.json"\n\n[features]\napps = true\n');
  fs.writeFileSync(catalog, JSON.stringify({ models: [{ slug: 'provider/model' }] }));
  fs.writeFileSync(cache, JSON.stringify({ fetched_at: '2000-01-01T00:00:00Z', client_version: '0.0.0', models: [{ slug: 'provider/model' }] }));
  const result = reconcileOcxStartupFiles({ codexHome, beforeConfig, beforeCache });
  assert.deepEqual(result, { route: 'restored', modelCache: 'restored', ok: true });
  assert.deepEqual(fs.readFileSync(config), original);
  assert.equal(fs.existsSync(cache), false);
});

test('OCX startup reconciler preserves unrelated concurrent changes', t => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ocx-conflict-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const config = path.join(codexHome, 'config.toml');
  const cache = path.join(codexHome, 'models_cache.json');
  const original = Buffer.from('model = "gpt-5"\n');
  fs.writeFileSync(config, 'model = "user-change"\nmodel_catalog_json = "/tmp/opencodex-catalog.json"\n');
  fs.writeFileSync(cache, JSON.stringify({ fetched_at: '2026-08-10T00:00:00Z', client_version: '1.0.0', models: [] }));
  const result = reconcileOcxStartupFiles({
    codexHome,
    beforeConfig: { exists: true, bytes: original, mode: 0o600 },
    beforeCache: { exists: false, bytes: null, mode: 0o600 }
  });
  assert.deepEqual(result, { route: 'conflict', modelCache: 'preserved_non_ocx_change', ok: false });
  assert.match(fs.readFileSync(config, 'utf8'), /user-change/);
  assert.equal(fs.existsSync(cache), true);
});

test('OCX upstream child cannot mutate the active Codex home', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ocx-isolated-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const activeCodexHome = path.join(root, 'active-codex');
  const serviceCodexHome = path.join(root, 'runtime', 'ocx-upstream-codex-home');
  const opencodexHome = path.join(root, 'opencodex');
  fs.mkdirSync(activeCodexHome, { recursive: true });
  fs.writeFileSync(path.join(activeCodexHome, 'models_cache.json'), '{"owner":"desktop"}\n');

  const env = childEnvironment({
    home: root,
    codexHome: activeCodexHome,
    serviceCodexHome,
    opencodexHome,
  });

  assert.equal(env.CODEX_HOME, serviceCodexHome);
  assert.notEqual(env.CODEX_HOME, activeCodexHome);
  assert.equal(env.OPENCODEX_HOME, opencodexHome);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(serviceCodexHome).mode & 0o077, 0);
  }
  assert.equal(fs.readFileSync(path.join(activeCodexHome, 'models_cache.json'), 'utf8'), '{"owner":"desktop"}\n');
});

test('OCX wrapper distinguishes the launcher PID from the health-proven proxy PID', () => {
  assert.deepEqual(
    validateOcxHealthPayload({ status: 'ok', service: 'opencodex', port: 10100, pid: 321 }, 10100),
    { ready: true, servicePid: 321 }
  );
  assert.deepEqual(
    validateOcxHealthPayload({ status: 'ok', service: 'opencodex', port: 10100 }, 10100),
    { ready: false, servicePid: null }
  );
  assert.deepEqual(
    validateOcxReadinessPayload({ status: 'ready', service: 'opencodex', port: 10100, pid: 321 }, 10100),
    { ready: true, servicePid: 321 }
  );
  assert.deepEqual(
    validateOcxReadinessPayload({ status: 'failed', service: 'opencodex', port: 10100, pid: 321 }, 10100),
    { ready: false, servicePid: null }
  );
});

test('OCX readiness proof requires consecutive current samples from one exact identity', () => {
  const sampleA = { current: true, identity: 'a'.repeat(64) };
  const sampleB = { current: true, identity: 'b'.repeat(64) };
  let proof = advanceOcxReadinessProof(null, sampleA, 3);
  assert.equal(proof.ready, false);
  proof = advanceOcxReadinessProof(proof, sampleA, 3);
  assert.equal(proof.consecutive, 2);
  proof = advanceOcxReadinessProof(proof, sampleB, 3);
  assert.equal(proof.consecutive, 1);
  proof = advanceOcxReadinessProof(proof, sampleB, 3);
  proof = advanceOcxReadinessProof(proof, sampleB, 3);
  assert.equal(proof.ready, true);
  proof = advanceOcxReadinessProof(proof, { current: false, identity: sampleB.identity }, 3);
  assert.deepEqual(proof, { current: false, ready: false, consecutive: 0, required: 3, identity: null });
});

test('OCX launch artifact seal rejects symlink aliases and changes identity with bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ocx-artifact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifact = path.join(root, 'ocx');
  fs.writeFileSync(artifact, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const before = sealOcxLaunchArtifact(artifact);
  assert.match(before.sha256, /^[a-f0-9]{64}$/);
  fs.writeFileSync(artifact, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const after = sealOcxLaunchArtifact(artifact);
  assert.notEqual(after.sha256, before.sha256);
  fs.symlinkSync(artifact, path.join(root, 'ocx-alias'));
  assert.throws(() => sealOcxLaunchArtifact(path.join(root, 'ocx-alias')), /ocx_artifact_not_regular/);
});

test('OCX upstream-only service requires native Codex integration to be explicitly disabled', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ocx-upstream-intent-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ autoSwitchThreshold: 98 }));
  assert.deepEqual(inspectOcxUpstreamOnlyIntent(home), { ok: false, reason: 'codex_integration_not_disabled' });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ clientIntegrations: { codex: false } }));
  assert.deepEqual(inspectOcxUpstreamOnlyIntent(home), { ok: true, reason: null });
});

test('OCX upstream LaunchAgent installer is bounded and preserves the route fingerprint', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ocx-launchd-'));
  const root = path.join(home, 'AICC');
  const node = path.join(home, 'node');
  const ocx = path.join(home, 'ocx');
  const wrapper = path.join(root, 'src', 'ocx-upstream-service-wrapper.mjs');
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  fs.writeFileSync(node, '#!/bin/sh\n', { mode: 0o700 });
  fs.writeFileSync(ocx, '#!/bin/sh\n', { mode: 0o700 });
  fs.writeFileSync(wrapper, '', { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.opencodex.proxy.plist'), '<old/>\n', { mode: 0o600 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateFile = path.join(home, '.ai-control-center', 'runtime', 'ocx-upstream-service.json');
  let fingerprints = 0;
  const spawnSync = (command, args) => {
    if (command === 'plutil' || args?.[0] === 'bootout' || args?.[0] === 'bootstrap') return { status: 0, stdout: '', stderr: '' };
    if (args?.[0] === 'print') return { status: 113, stdout: '', stderr: 'not registered' };
    if (command === 'curl') {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(readyRuntimeState()));
      const ready = args.at(-1).endsWith('/readyz');
      return { status: 0, stdout: JSON.stringify({ status: ready ? 'ready' : 'ok', service: 'opencodex', pid: 99, port: 10100 }), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  const result = installOcxUpstreamLaunchAgent({
    platform: 'darwin', home, root, node, ocx, wrapper, uid: 501,
    activeState: { activeTurns: 0, draining: false },
    upstreamOnlyIntent: { ok: true, reason: null },
    previousRegistration: { status: 0, stdout: 'registered' },
    previousHealth: { status: 0, stdout: '{"status":"ok"}' },
    spawnSync,
    fingerprint: () => { fingerprints += 1; return 'stable'; },
    pause: () => {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.keepAlive, false);
  assert.equal(result.restartBudget, 2);
  assert.equal(result.codexHomeIsolation, true);
  assert.equal(result.serviceCodexHome, path.join(home, '.ai-control-center', 'runtime', 'ocx-upstream-codex-home'));
  assert.equal(result.routeFingerprintPreserved, true);
  assert.equal(result.bootstrapAttempts, 1);
  assert.equal(result.registeredAfterBootstrapError, false);
  assert.equal(fingerprints, 2);
  assert.ok(result.backup);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(result.backup).mode & 0o077, 0);
  }
  const plist = fs.readFileSync(result.plist, 'utf8');
  assert.match(plist, /<key>KeepAlive<\/key><false\/>/);
  assert.match(plist, /--max-restarts<\/string><string>2<\/string>/);
  assert.match(plist, /--service-codex-home<\/string>/);
  assert.equal(
    plist.includes(`<key>CODEX_HOME</key><string>${result.serviceCodexHome}</string>`),
    true
  );
  assert.equal(
    plist.includes(`<key>CODEX_HOME</key><string>${path.join(home, '.codex')}</string>`),
    false
  );
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(result.serviceCodexHome).mode & 0o077, 0);
  }
  assert.doesNotMatch(plist, /service-api-token/);
});

test('OCX upstream LaunchAgent installer accepts launchd error 5 only after exact registration proof', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ocx-launchd-five-'));
  const root = path.join(home, 'AICC');
  const node = path.join(home, 'node');
  const ocx = path.join(home, 'ocx');
  const wrapper = path.join(root, 'src', 'ocx-upstream-service-wrapper.mjs');
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  for (const file of [node, ocx, wrapper]) fs.writeFileSync(file, '', { mode: 0o700 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateFile = path.join(home, '.ai-control-center', 'runtime', 'ocx-upstream-service.json');
  let printCalls = 0;
  let bootstrapCalls = 0;
  let bootstrapAttempted = false;
  const spawnSync = (command, args) => {
    if (command === 'plutil' || args?.[0] === 'bootout') return { status: 0, stdout: '', stderr: '' };
    if (command === 'curl') {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(readyRuntimeState()));
      const ready = args.at(-1).endsWith('/readyz');
      return { status: 0, stdout: JSON.stringify({ status: ready ? 'ready' : 'ok', service: 'opencodex', pid: 99, port: 10100 }), stderr: '' };
    }
    if (args?.[0] === 'bootstrap') {
      bootstrapCalls += 1;
      bootstrapAttempted = true;
      return { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
    }
    if (args?.[0] === 'print') {
      printCalls += 1;
      return bootstrapAttempted
        ? { status: 0, stdout: `program = ${node}\n${wrapper}\nstate = running`, stderr: '' }
        : { status: 113, stdout: '', stderr: 'not registered' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  const result = installOcxUpstreamLaunchAgent({
    platform: 'darwin', home, root, node, ocx, wrapper, uid: 501,
    activeState: { activeTurns: 0, draining: false },
    upstreamOnlyIntent: { ok: true, reason: null },
    previousRegistration: { status: 0, stdout: 'registered' },
    previousHealth: { status: 0, stdout: '{"status":"ok"}' },
    spawnSync,
    fingerprint: () => 'stable',
    pause: () => {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.registeredAfterBootstrapError, true);
  assert.equal(result.bootstrapAttempts, 1);
  assert.equal(bootstrapCalls, 1);
  assert.equal(printCalls, 2);
});

test('OCX upstream LaunchAgent installer restores the prior owner on readiness failure', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ocx-launchd-rollback-'));
  const root = path.join(home, 'AICC');
  const node = path.join(home, 'node');
  const ocx = path.join(home, 'ocx');
  const wrapper = path.join(root, 'src', 'ocx-upstream-service-wrapper.mjs');
  const launchAgents = path.join(home, 'Library', 'LaunchAgents');
  const plist = path.join(launchAgents, 'com.opencodex.proxy.plist');
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.mkdirSync(launchAgents, { recursive: true });
  for (const file of [node, ocx, wrapper]) fs.writeFileSync(file, '', { mode: 0o700 });
  fs.writeFileSync(plist, '<previous-owner/>\n', { mode: 0o600 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let bootstrapCalls = 0;
  const spawnSync = (command, args) => {
    if (command === 'plutil' || args?.[0] === 'bootout') return { status: 0, stdout: '', stderr: '' };
    if (args?.[0] === 'print') return { status: 113, stdout: '', stderr: 'not registered' };
    if (args?.[0] === 'bootstrap') {
      bootstrapCalls += 1;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'curl') return { status: 7, stdout: '', stderr: 'unavailable' };
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  assert.throws(() => installOcxUpstreamLaunchAgent({
    platform: 'darwin', home, root, node, ocx, wrapper, uid: 501,
    activeState: { activeTurns: 0, draining: false },
    upstreamOnlyIntent: { ok: true, reason: null },
    previousRegistration: { status: 0, stdout: 'registered' },
    previousHealth: { status: 0, stdout: '{"status":"ok"}' },
    spawnSync,
    fingerprint: () => 'stable',
    healthAttempts: 1,
    pause: () => {}
  }), /ocx_upstream_not_ready:\{.*"healthOk":false.*\};rollback=restored/);
  assert.equal(fs.readFileSync(plist, 'utf8'), '<previous-owner/>\n');
  assert.equal(bootstrapCalls, 2);
});

test('OCX upstream LaunchAgent installer fails closed on unknown or active turns', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ocx-launchd-hold-'));
  const root = path.join(home, 'AICC');
  const node = path.join(home, 'node');
  const ocx = path.join(home, 'ocx');
  const wrapper = path.join(root, 'src', 'ocx-upstream-service-wrapper.mjs');
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  for (const file of [node, ocx, wrapper]) fs.writeFileSync(file, '', { mode: 0o700 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.throws(() => installOcxUpstreamLaunchAgent({
    platform: 'darwin', home, root, node, ocx, wrapper, uid: 501,
    activeState: { activeTurns: null, draining: null }
  }), /ocx_active_state_not_safe:UNKNOWN:UNKNOWN/);
  assert.throws(() => installOcxUpstreamLaunchAgent({
    platform: 'darwin', home, root, node, ocx, wrapper, uid: 501,
    activeState: { activeTurns: 1, draining: false }
  }), /ocx_active_state_not_safe:1:false/);
});

function cutoverFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ocx-cutover-'));
  const root = path.join(home, 'AICC');
  const ocx = path.join(home, 'ocx');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(ocx, '#!/bin/sh\n', { mode: 0o700 });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, root, ocx };
}

function cutoverSpawn({ samples, stopStatus = 0, recoverStatus = 0, healthAfterStop = 7, routingInjected = false }) {
  const calls = [];
  let stopped = false;
  let recovered = false;
  const spawnSync = (command, args) => {
    calls.push([command, ...args]);
    const isOcx = path.basename(command) === 'ocx';
    if (command === 'launchctl' && args[0] === 'bootout') {
      stopped = true;
      return { status: stopStatus, stdout: '', stderr: stopStatus === 0 ? '' : 'handoff failed' };
    }
    if (command === 'launchctl' && args[0] === 'print') {
      return stopped && !recovered
        ? { status: 113, stdout: '', stderr: 'not registered' }
        : { status: 0, stdout: 'registered', stderr: '' };
    }
    if (command === 'curl') {
      return stopped && !recovered
        ? { status: healthAfterStop, stdout: '', stderr: 'unavailable' }
        : { status: 0, stdout: '{"status":"ok"}', stderr: '' };
    }
    if (isOcx && args[0] === 'system') {
      const sample = samples.shift() ?? { activeTurns: null, draining: null, pid: null };
      if (sample.activeTurns === null) return { status: 1, stdout: '', stderr: 'unknown' };
      return {
        status: 0,
        stdout: JSON.stringify({ startup: { routingInjected }, memory: {
          activeTurnCount: sample.activeTurns,
          isDraining: sample.draining,
          pid: sample.pid
        } }),
        stderr: ''
      };
    }
    if (isOcx && args[0] === 'service' && args[1] === 'start') {
      if (recoverStatus === 0) recovered = true;
      return { status: recoverStatus, stdout: '', stderr: recoverStatus === 0 ? '' : 'recover failed' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  return { calls, spawnSync };
}

test('OCX cutover owns five-zero proof, exact launchd graceful handoff, and install in one process', t => {
  const fixture = cutoverFixture(t);
  const fake = cutoverSpawn({
    samples: Array.from({ length: 5 }, () => ({ activeTurns: 0, draining: false, pid: 42 }))
  });
  const events = [];
  let installOptions = null;
  const result = cutoverOcxUpstreamLaunchAgent({
    platform: 'darwin', ...fixture, uid: 501,
    spawnSync: fake.spawnSync,
    pause: () => {},
    progress: event => events.push(event),
    fingerprint: () => 'stable',
    install: options => {
      installOptions = options;
      return { ok: true, keepAlive: false, serviceCodexHome: path.join(fixture.home, 'isolated') };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.zeroSamples, 5);
  assert.equal(result.stoppedPid, 42);
  assert.equal(result.recovery, 'not-needed');
  assert.deepEqual(installOptions.activeState, { activeTurns: 0, draining: false });
  assert.equal(installOptions.previousRegistration.status, 0);
  assert.equal(installOptions.previousHealth.status, 7);
  assert.equal(fake.calls.filter(call => call[0] === 'launchctl' && call[1] === 'bootout').length, 1);
  assert.equal(fake.calls.filter(call => path.basename(call[0]) === 'ocx' && call[1] === 'stop').length, 0);
  assert.equal(fake.calls.filter(call => path.basename(call[0]) === 'ocx' && call[1] === 'service').length, 0);
  assert.deepEqual(events.map(event => event.step).filter((step, index, all) => index === 0 || step !== all[index - 1]), [
    'preflight', 'zero-active wait', 'graceful handoff', 'isolated install', 'PASS'
  ]);
});

test('OCX cutover fails closed on unknown state without stopping or recovering', t => {
  const fixture = cutoverFixture(t);
  const fake = cutoverSpawn({ samples: [] });
  let clock = 0;
  assert.throws(() => cutoverOcxUpstreamLaunchAgent({
    platform: 'darwin', ...fixture, uid: 501,
    spawnSync: fake.spawnSync,
    pause: () => {},
    now: () => { clock += 600; return clock; },
    drainTimeoutMs: 1_000,
    maxDrainSamples: 5,
    progress: () => {},
    fingerprint: () => 'stable',
    install: () => assert.fail('installer must not run')
  }), /ocx_zero_window_timeout;recovery=not-needed/);
  assert.equal(fake.calls.some(call => path.basename(call[0]) === 'ocx' && call[1] === 'stop'), false);
  assert.equal(fake.calls.some(call => call[0] === 'launchctl' && call[1] === 'bootout'), false);
  assert.equal(fake.calls.some(call => path.basename(call[0]) === 'ocx' && call[1] === 'service'), false);
});

test('OCX cutover resets consecutive proof when the serving PID changes', t => {
  const fixture = cutoverFixture(t);
  const fake = cutoverSpawn({ samples: [
    { activeTurns: 0, draining: false, pid: 10 },
    { activeTurns: 0, draining: false, pid: 10 },
    { activeTurns: 0, draining: false, pid: 11 },
    ...Array.from({ length: 4 }, () => ({ activeTurns: 0, draining: false, pid: 11 }))
  ] });
  const result = cutoverOcxUpstreamLaunchAgent({
    platform: 'darwin', ...fixture, uid: 501,
    spawnSync: fake.spawnSync,
    pause: () => {},
    progress: () => {},
    fingerprint: () => 'stable',
    install: () => ({ ok: true })
  });
  assert.equal(result.ok, true);
  assert.equal(result.stoppedPid, 11);
  assert.equal(fake.calls.filter(call => path.basename(call[0]) === 'ocx' && call[1] === 'system').length, 7);
});

test('OCX cutover attempts one recovery when install fails after a clean stop', t => {
  const fixture = cutoverFixture(t);
  const fake = cutoverSpawn({
    samples: Array.from({ length: 5 }, () => ({ activeTurns: 0, draining: false, pid: 77 }))
  });
  assert.throws(() => cutoverOcxUpstreamLaunchAgent({
    platform: 'darwin', ...fixture, uid: 501,
    spawnSync: fake.spawnSync,
    pause: () => {},
    progress: () => {},
    fingerprint: () => 'stable',
    install: () => { throw new Error('synthetic_install_failure'); }
  }), /synthetic_install_failure;recovery=10100-healthy/);
  assert.equal(fake.calls.filter(call => path.basename(call[0]) === 'ocx' && call[1] === 'service' && call[2] === 'start').length, 1);
});

test('OCX cutover refuses a route-injected Desktop before any stop', t => {
  const fixture = cutoverFixture(t);
  const fake = cutoverSpawn({
    samples: [{ activeTurns: 0, draining: false, pid: 88 }],
    routingInjected: true
  });
  assert.throws(() => cutoverOcxUpstreamLaunchAgent({
    platform: 'darwin', ...fixture, uid: 501,
    spawnSync: fake.spawnSync,
    pause: () => {},
    progress: () => {},
    fingerprint: () => 'stable',
    install: () => assert.fail('installer must not run')
  }), /ocx_cutover_refuses_injected_codex_route;recovery=not-needed/);
  assert.equal(fake.calls.some(call => path.basename(call[0]) === 'ocx' && call[1] === 'stop'), false);
  assert.equal(fake.calls.some(call => call[0] === 'launchctl' && call[1] === 'bootout'), false);
});

test('OCX cutover refuses an unmanaged listener before any lifecycle mutation', t => {
  const fixture = cutoverFixture(t);
  const fake = cutoverSpawn({
    samples: Array.from({ length: 5 }, () => ({ activeTurns: 0, draining: false, pid: 99 }))
  });
  const spawnSync = (command, args, options) => {
    if (command === 'launchctl' && args[0] === 'print') return { status: 113, stdout: '', stderr: 'not registered' };
    return fake.spawnSync(command, args, options);
  };
  assert.throws(() => cutoverOcxUpstreamLaunchAgent({
    platform: 'darwin', ...fixture, uid: 501,
    spawnSync,
    pause: () => {},
    progress: () => {},
    fingerprint: () => 'stable',
    install: () => assert.fail('installer must not run')
  }), /ocx_cutover_requires_managed_launchd_owner;recovery=not-needed/);
  assert.equal(fake.calls.some(call => call[0] === 'launchctl' && call[1] === 'bootout'), false);
});
