import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildRouteCatalogs, installRouteLaunchers, routeLauncherStatus } from '../src/codex-route-launchers.mjs';
import { buildCodexCliInvocation, codexCliRouteStatus, launchCodexCli, parseCodexRouteArguments } from '../src/codex-cli-routes.mjs';

function model(slug) {
  return { slug, display_name: slug, description: slug, default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high', description: 'high' }] };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-route-launchers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const codexHome = path.join(home, '.codex');
  const sourceDirectory = path.join(root, 'sources');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'openai_base_url = "https://chatgpt.com/backend-api/codex"\n');
  for (const name of ['codex-aicc', 'codex-web', 'codex-ocx']) {
    fs.writeFileSync(path.join(sourceDirectory, name), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  }
  return { root, home, codexHome, sourceDirectory, stateRoot: path.join(home, '.ai-control-center') };
}

function catalogs() {
  return buildRouteCatalogs({
    integrated: { models: [model('chatgpt-web/saved/high'), model('gpt-5.6-sol')] },
    ocx: { data: [{ id: 'gpt-5.6-sol' }] },
    ocxSource: { models: [model('gpt-5.6-sol'), model('unused')] }
  });
}

test('builds dedicated catalogs only from currently advertised route models', () => {
  const result = catalogs();
  assert.deepEqual(JSON.parse(result.aicc).models.map(item => item.slug), ['chatgpt-web/saved/high', 'gpt-5.6-sol']);
  assert.deepEqual(JSON.parse(result.ocx).models.map(item => item.slug), ['gpt-5.6-sol']);
});

test('installs three owned launchers without changing default Native config', async t => {
  const f = fixture(t);
  const options = { ...f, catalogs: catalogs() };
  const before = fs.readFileSync(path.join(f.codexHome, 'config.toml'));
  const result = await installRouteLaunchers(options);
  assert.equal(result.ok, true);
  assert.equal(result.defaultCodex.native, true);
  assert.deepEqual(fs.readFileSync(path.join(f.codexHome, 'config.toml')), before);
  assert.deepEqual(result.routes.map(item => item.name), ['codex-aicc', 'codex-web', 'codex-ocx']);
});

test('launcher installer refuses unowned destination and preserves it', async t => {
  const f = fixture(t);
  const destination = path.join(f.home, '.local', 'bin', 'codex-aicc');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, '#!/bin/sh\necho owner\n', { mode: 0o755 });
  await assert.rejects(installRouteLaunchers({ ...f, catalogs: catalogs() }), /unowned route launcher/);
  assert.match(fs.readFileSync(destination, 'utf8'), /owner/);
});

test('launcher installer rolls back every file on bounded failure', async t => {
  const f = fixture(t);
  const options = { ...f, catalogs: catalogs() };
  await installRouteLaunchers(options);
  const status = routeLauncherStatus(options);
  const files = [status.manifest, ...status.routes.map(item => item.destination), path.join(f.stateRoot, 'route-launchers', 'aicc.models.json'), path.join(f.stateRoot, 'route-launchers', 'ocx.models.json')];
  const before = new Map(files.map(file => [file, fs.readFileSync(file)]));
  let writes = 0;
  await assert.rejects(installRouteLaunchers({ ...options, replaceFile(file, data, mode) {
    writes += 1;
    if (writes === 4) throw new Error('fixture failure');
    fs.writeFileSync(file, data, { mode });
  }}), /fixture failure/);
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes);
});

test('real route wrappers reject caller route overrides before execution', t => {
  if (process.platform === 'win32') {
    t.skip('route wrapper sources are POSIX shell scripts; Windows routes remain fail-closed until a dedicated .cmd implementation is installed');
    return;
  }
  for (const name of ['codex-aicc', 'codex-ocx']) {
    const source = new URL(`../tools/platform/codex/${name}`, import.meta.url);
    const result = spawnSync('/bin/sh', [source.pathname, '-c', 'openai_base_url="https://example.invalid"'], { encoding: 'utf8' });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /route\/model override is not allowed/);
  }
});

function dualRouteFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-dual-codex-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const codexHome = path.join(home, '.codex');
  const stateRoot = path.join(home, '.ai-control-center');
  const nativeCatalog = path.join(codexHome, 'models_cache.json');
  const ocxCatalog = path.join(home, '.opencodex', 'catalog-backup.json');
  const executable = path.join(root, 'codex.exe');
  fs.mkdirSync(path.dirname(nativeCatalog), { recursive: true });
  fs.mkdirSync(path.dirname(ocxCatalog), { recursive: true });
  fs.writeFileSync(nativeCatalog, JSON.stringify({ models: [model('gpt-5.6-sol')] }));
  fs.writeFileSync(ocxCatalog, JSON.stringify({ models: [model('gpt-5.6-sol')] }));
  fs.writeFileSync(executable, 'fixture');
  // r2 contract: Native uses the shared-HOME V2 profile file; launch refuses without it.
  fs.writeFileSync(path.join(codexHome, 'native.config.toml'), '# fixture native V2 profile\n');
  return {
    root, home, codexHome, stateRoot, nativeCatalog, ocxCatalog, executable,
    nativeStatus: { executable, catalogPath: nativeCatalog, modelAvailable: true }
  };
}

// Every OCX launch now needs the registered admission credential (no unauthenticated or route fallback).
function registerManagedLocalAdmission(f, token = 'fixture-managed-token-1234567890') {
  const localHome = path.join(f.stateRoot, 'runtime', 'ocx-local', 'home');
  const tokenFile = path.join(f.home, '.opencodex', 'service-api-token');
  fs.mkdirSync(localHome, { recursive: true });
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, token);
  fs.writeFileSync(path.join(f.stateRoot, 'runtime', 'ocx-local', 'current.json'), JSON.stringify({
    schemaVersion: 1, requestExecution: 'windows-local', credentialWriter: 'a1', opencodexHome: localHome, tokenFile
  }));
  return token;
}

test('builds independent Native and OCX invocations without changing the base config', t => {
  const f = dualRouteFixture(t);
  const config = path.join(f.codexHome, 'config.toml');
  fs.writeFileSync(config, 'openai_base_url = "https://chatgpt.com/backend-api/codex"\n');
  const before = fs.readFileSync(config);
  const native = buildCodexCliInvocation('native', ['exec', 'fixture'], f);
  const ocx = buildCodexCliInvocation('ocx', ['exec', 'fixture'], f);
  assert.deepEqual(native.args.slice(0, 6), ['--profile', 'native', '-c', 'openai_base_url="https://chatgpt.com/backend-api/codex"', '-c', 'model_provider="openai"']);
  assert.equal(ocx.endpoint, 'http://127.0.0.1:10100/v1');
  assert.equal(ocx.provider, 'aicc-ocx-compat');
  assert.ok(ocx.args.includes('model_provider="aicc-ocx-compat"'));
  assert.ok(ocx.args.includes('model_providers.aicc-ocx-compat.base_url="http://127.0.0.1:10100/v1"'));
  // G1-05: OCX never replays, so the compat provider disables client request/stream retries.
  assert.ok(ocx.args.includes('model_providers.aicc-ocx-compat.request_max_retries=0'));
  assert.ok(ocx.args.includes('model_providers.aicc-ocx-compat.stream_max_retries=0'));
  assert.equal(native.args.some(value => value.includes('max_retries')), false);
  assert.equal(ocx.args.some(value => value.startsWith('openai_base_url=')), false);
  assert.deepEqual(ocx.args.slice(-2), ['exec', 'fixture']);
  assert.equal(native.executable, ocx.executable);
  assert.equal(native.fallback, false);
  assert.equal(ocx.fallback, false);
  assert.deepEqual(fs.readFileSync(config), before);
});

test('Native launch refuses when the shared-HOME V2 profile is absent', t => {
  const f = dualRouteFixture(t);
  fs.rmSync(path.join(f.codexHome, 'native.config.toml'));
  assert.throws(() => buildCodexCliInvocation('native', [], f), /native\.config\.toml V2 profile is not installed/);
  assert.equal(codexCliRouteStatus(f).routes.native.ready, false);
});

test('dual CLI status is local-only and reports both routes separately', t => {
  const f = dualRouteFixture(t);
  fs.rmSync(f.ocxCatalog);
  const result = codexCliRouteStatus(f);
  assert.equal(result.ok, true);
  assert.equal(result.defaultRoute, 'ocx');
  assert.equal(result.defaultRouteMeaning, 'source-target-not-effective-daemon-proof');
  assert.equal(result.liveReadiness, 'NOT_CHECKED');
  assert.equal(result.globalConfigMutation, false);
  assert.equal(result.serviceMutation, false);
  assert.equal(result.routes.native.endpoint, 'https://chatgpt.com/backend-api/codex');
  assert.equal(result.routes.ocx.endpoint, 'http://127.0.0.1:10100/v1');
  // No legacy/native catalog fallback for OCX.
  assert.equal(result.routes.ocx.catalog, f.ocxCatalog);
  assert.notEqual(result.routes.ocx.catalog, f.nativeCatalog);
});

test('dual CLI rejects caller route and model overrides', t => {
  const f = dualRouteFixture(t);
  for (const [args, refusal] of [
    [['-c', 'openai_base_url="https://example.invalid"'], /route\/auth\/catalog overrides are refused/],
    [['--profile', 'other'], /cannot replace the selected route/],
    [['--model=gpt-5.5'], /GPT-5\.5 is not allowed/]
  ]) {
    assert.throws(() => buildCodexCliInvocation('native', args, f), refusal);
  }
  assert.deepEqual(parseCodexRouteArguments(['--route-model', 'gpt-5.6-sol', 'exec', 'fixture']), {
    model: 'gpt-5.6-sol', reasoningEffort: null, args: ['exec', 'fixture']
  });
  assert.throws(() => parseCodexRouteArguments(['--route-model=gpt-5.5']), /GPT-5.5 is not allowed/);
});

test('route effort is explicit, bounded, and passed only to the selected invocation', t => {
  const f = dualRouteFixture(t);
  const parsed = parseCodexRouteArguments(['--route-effort', 'medium', '--route-model=gpt-5.6-sol', 'exec', '-']);
  assert.deepEqual(parsed, { model: 'gpt-5.6-sol', reasoningEffort: 'medium', args: ['exec', '-'] });
  for (const route of ['native', 'ocx']) {
    const invocation = buildCodexCliInvocation(route, parsed.args, { ...f, model: parsed.model, reasoningEffort: parsed.reasoningEffort });
    assert.ok(invocation.args.includes('model_reasoning_effort="medium"'));
    assert.equal(invocation.reasoningEffort, 'medium');
  }
  assert.throws(() => parseCodexRouteArguments(['--route-effort=medium', '--route-effort=high']), /only once/);
  assert.throws(() => parseCodexRouteArguments(['--route-effort=unbounded']), /Invalid/);
  assert.throws(() => parseCodexRouteArguments(['--route-effort']), /Invalid/);
});

test('OCX CLI remote client uses the paired hub data endpoint and injects admission auth only into the child', async t => {
  const f = dualRouteFixture(t);
  const ocxHome = path.join(f.home, '.opencodex');
  fs.mkdirSync(ocxHome, { recursive: true });
  fs.writeFileSync(path.join(ocxHome, 'config.json'), JSON.stringify({
    runtimeRole: 'client',
    client: { serverUrl: 'http://localhost:10101' }
  }));
  fs.writeFileSync(path.join(ocxHome, 'service-api-token'), 'fixture-client-token-1234567890');

  const invocation = buildCodexCliInvocation('ocx', ['exec', 'fixture'], { ...f, opencodexHome: ocxHome });
  assert.equal(invocation.mode, 'remote-client');
  assert.equal(invocation.endpoint, 'http://localhost:10101/v1');
  assert.ok(invocation.args.includes('model_provider="aicc-ocx-compat"'));
  assert.ok(invocation.args.includes('model_providers.aicc-ocx-compat.base_url="http://localhost:10101/v1"'));
  assert.ok(invocation.args.includes('model_providers.aicc-ocx-compat.env_key="OPENCODEX_API_AUTH_TOKEN"'));
  // Remote OCX no longer overrides features.hooks; the existing command safety hooks come from
  // the user's Codex layers and are never switched off by this launcher.
  assert.equal(invocation.args.some(value => value.startsWith('features.hooks=')), false);
  assert.equal(invocation.args.includes('openai_base_url="http://localhost:10101/v1"'), false);

  const calls = [];
  const before = process.env.OPENCODEX_API_AUTH_TOKEN;
  const result = await launchCodexCli('ocx', ['exec', 'fixture'], {
    ...f,
    opencodexHome: ocxHome,
    env: { TEST_MARKER: 'present' },
    fetch: async url => ({
      ok: true,
      async json() {
        if (url === 'http://localhost:10101/healthz') return { status: 'ok' };
        if (url === 'http://localhost:10101/readyz') return { status: 'ready' };
        if (url === 'http://localhost:10101/v1/models') return { data: [{ id: 'gpt-5.6-sol' }] };
        throw new Error('unexpected URL');
      }
    }),
    spawnSync: (executable, args, options) => {
      calls.push({ executable, args, options });
      return { status: 0 };
    }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.TEST_MARKER, 'present');
  assert.equal(calls[0].options.env.OPENCODEX_API_AUTH_TOKEN, 'fixture-client-token-1234567890');
  assert.equal(process.env.OPENCODEX_API_AUTH_TOKEN, before);
});

test('OCX CLI client route refuses a non-loopback data endpoint', t => {
  const f = dualRouteFixture(t);
  const ocxHome = path.join(f.home, '.opencodex');
  fs.mkdirSync(ocxHome, { recursive: true });
  fs.writeFileSync(path.join(ocxHome, 'config.json'), JSON.stringify({
    runtimeRole: 'client',
    client: { serverUrl: 'https://example.com' }
  }));
  assert.throws(
    () => buildCodexCliInvocation('ocx', [], { ...f, opencodexHome: ocxHome }),
    /owner-local loopback HTTP origin/
  );
});

test('OCX CLI fails closed without starting Native when 10100 is unavailable', async t => {
  const f = dualRouteFixture(t);
  let spawnCount = 0;
  let fetchCount = 0;
  // Without a registered admission credential nothing is probed or started.
  await assert.rejects(launchCodexCli('ocx', [], {
    ...f,
    fetch: async () => { fetchCount += 1; throw new Error('fixture offline'); },
    spawnSync: () => { spawnCount += 1; return { status: 0 }; }
  }), /admission credential is required; no authentication or route fallback/);
  assert.equal(fetchCount, 0);
  registerManagedLocalAdmission(f);
  await assert.rejects(launchCodexCli('ocx', [], {
    ...f,
    fetch: async () => { throw new Error('fixture offline'); },
    spawnSync: () => { spawnCount += 1; return { status: 0 }; }
  }), /Native was not used as fallback/);
  assert.equal(spawnCount, 0);
});

test('OCX CLI starts the exact Codex executable only after bounded readiness checks', async t => {
  const f = dualRouteFixture(t);
  const token = registerManagedLocalAdmission(f);
  const calls = [];
  const seen = [];
  const result = await launchCodexCli('ocx', ['exec', 'fixture'], {
    ...f,
    fetch: async (url, request) => {
      seen.push({ url, authorization: request?.headers?.Authorization ?? null });
      return {
      ok: true,
      async json() {
        if (url.endsWith('/healthz')) return { status: 'ok' };
        if (url.endsWith('/readyz')) return { status: 'ready' };
        return { data: [{ id: 'gpt-5.6-sol' }] };
      }
    }; },
    spawnSync: (executable, args, options) => {
      calls.push({ executable, args, options });
      return { status: 0 };
    }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, f.executable);
  assert.deepEqual(calls[0].args.slice(-2), ['exec', 'fixture']);
  assert.equal(calls[0].options.stdio, 'inherit');
  assert.equal(calls[0].options.env.OPENCODEX_API_AUTH_TOKEN, token);
  assert.equal(seen.find(item => item.url.endsWith('/v1/models'))?.authorization, `Bearer ${token}`);
});
