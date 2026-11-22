import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCodexCliInvocation, launchCodexCli, ocxCliAccountSelectors, parseCodexRouteArguments } from '../src/codex-cli-routes.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-account-number-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Current contract: exact account binding exists only on the registered managed-local OCX
  // (windows-local, A1 credential writer), and every OCX launch needs its admission token.
  const stateRoot = path.join(root, 'state');
  const opencodexHome = path.join(stateRoot, 'runtime', 'ocx-local', 'home');
  fs.mkdirSync(opencodexHome, { recursive: true });
  const tokenFile = path.join(root, '.opencodex', 'service-api-token');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, 'fixture-admission-token-1234567890');
  fs.writeFileSync(path.join(stateRoot, 'runtime', 'ocx-local', 'current.json'), JSON.stringify({
    schemaVersion: 1, requestExecution: 'windows-local', credentialWriter: 'a1', opencodexHome, tokenFile
  }));
  const configFile = path.join(opencodexHome, 'config.json');
  const config = {
    codexAccounts: [
      { id: 'fixture-b', alias: '2번(editor8)', logLabel: 'private-b' },
      { id: 'fixture-a', alias: '1번(example28)', logLabel: 'private-a' }
    ], codexAccountNamespaces: { 'private-b': 'fixture-b', 'private-a': 'fixture-a', stale: 'removed' },
    pausedCodexAccountIds: []
  };
  const write = () => fs.writeFileSync(configFile, JSON.stringify(config));
  write();
  const catalog = path.join(root, 'models.json');
  fs.writeFileSync(catalog, JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', display_name: 'Sol 6.1', supported_reasoning_levels: [{ effort: 'high' }] }] }));
  const options = { home: root, codexHome: root, stateRoot,
    executable: 'fixture-only.exe', nativeStatus: { executable: 'fixture-only.exe', catalogPath: catalog },
    nativeCatalog: catalog, ocxCatalog: catalog, model: 'gpt-6.1-sol', reasoningEffort: 'high' };
  const fetch = async url => ({ ok: true, json: async () => url.endsWith('/models')
    ? { data: [{ id: 'gpt-6.1-sol' }] } : url.endsWith('/readyz') ? { status: 'ready', ready: true } : { status: 'ok' } });
  return { root, config, write, options, fetch, tokenFile };
}

test('human account aliases accept either number option and reject mixed or non-number input', () => {
  for (const args of [['--account', '1'], ['--account=1'], ['--route-account', '1'], ['--route-account=1']]) {
    assert.equal(parseCodexRouteArguments(args).accountSelector, '1');
  }
  assert.equal(parseCodexRouteArguments(['--route-account', 'legacy-selector']).accountSelector, 'legacy-selector');
  for (const args of [['--account', 'private-a'], ['--account', '0'], ['--account'], ['--account', '1', '--route-account', '2']]) {
    assert.throws(() => parseCodexRouteArguments(args));
  }
  assert.equal(parseCodexRouteArguments(['--prefer-account', '2']).preferredAccount, '2');
  assert.equal(parseCodexRouteArguments(['--prefer-account=2']).preferredAccount, '2');
  for(const args of [['--prefer-account', 'private-a'],['--prefer-account', '0'],
    ['--prefer-account', '2', '--account', '1']]) assert.throws(()=>parseCodexRouteArguments(args));
});

test('normal account list is number-sorted, collision-expanded and contains no internal binding IDs', t => {
  const f = fixture(t);
  const list = ocxCliAccountSelectors(f.options);
  assert.deepEqual(list.accounts.map(row => row.label), ['A1 ex-8', 'A2 ed-8']);
  assert.doesNotMatch(JSON.stringify(list), /private-|fixture-|stale|removed|selector/);
  assert.equal(list.liveAccountAdmission, 'NOT_CHECKED');
});

test('account number binds exact alias target regardless of pool order or priority', t => {
  const f = fixture(t);
  const invocation = buildCodexCliInvocation('ocx', [], { ...f.options, accountSelector: '1' });
  assert.equal(invocation.model, 'private-a/gpt-6.1-sol');
  assert.equal(invocation.accountBinding.target, 'fixture-a');
  assert.equal(invocation.accountBinding.label, 'A1 ex-8');
  assert.equal(buildCodexCliInvocation('ocx', [], { ...f.options, accountSelector: 'private-a' }).model, invocation.model);
  assert.throws(() => buildCodexCliInvocation('native', [], { ...f.options, accountSelector: '1' }), /only supported/);
  const preferred=buildCodexCliInvocation('ocx', [], { ...f.options, preferredAccount:'1' });
  assert.equal(preferred.model,'preferred-private-a/gpt-6.1-sol');
  assert.equal(preferred.preferredAccountBinding.target,'fixture-a');
  assert.throws(()=>buildCodexCliInvocation('native',[],{...f.options,preferredAccount:'1'}),/only supported/);
});

test('paused, removed, duplicated and unbound numbers fail closed without picking another account', t => {
  const f = fixture(t);
  const build = () => buildCodexCliInvocation('ocx', [], { ...f.options, accountSelector: '1' });
  f.config.pausedCodexAccountIds = ['fixture-a']; f.write();
  assert.throws(build, /paused/);
  f.config.pausedCodexAccountIds = []; delete f.config.codexAccountNamespaces['private-a']; f.write();
  assert.throws(build, /Unknown OCX account number/);
  f.config.codexAccountNamespaces['private-a'] = 'fixture-a';
  f.config.codexAccounts[0].alias = '1번(editor8)'; f.write();
  assert.throws(build, /Ambiguous OCX account number/);
  f.config.codexAccounts[0].alias = '2번(editor8)';
  f.config.codexAccounts = f.config.codexAccounts.filter(row => row.id !== 'fixture-a'); f.write();
  assert.throws(build, /Unknown OCX account number/);
});

test('launch uses private exact route with a short display and deletes only its temporary catalog', async t => {
  const f = fixture(t);
  let scopedFile;
  const result = await launchCodexCli('ocx', ['exec', 'fixture'], {
    ...f.options, accountSelector: '1', fetch: f.fetch,
    spawnSync(executable, args, spawnOptions) {
      assert.equal(executable, 'fixture-only.exe');
      assert.equal(spawnOptions.env.OPENCODEX_API_AUTH_TOKEN, 'fixture-admission-token-1234567890');
      assert.ok(args.includes('model_providers.aicc-ocx-compat.request_max_retries=0'));
      assert.ok(args.includes('model_providers.aicc-ocx-compat.stream_max_retries=0'));
      assert.equal(args[args.indexOf('-m') + 1], 'private-a/gpt-6.1-sol');
      scopedFile = JSON.parse(args.find(value => value.startsWith('model_catalog_json=')).slice('model_catalog_json='.length));
      const scoped = JSON.parse(fs.readFileSync(scopedFile)).models[0];
      assert.equal(scoped.display_name, 'A1 ex-8 엄격 고정 / Sol 6.1');
      assert.doesNotMatch(scoped.display_name, /private|fixture/);
      return { status: 0 };
    }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(fs.existsSync(scopedFile), false);
});
test('preferred CLI route has a distinct model and keeps the old strict route unchanged',async t=>{
  const f=fixture(t);let scopedFile;
  const plan=buildCodexCliInvocation('ocx',[],{...f.options,preferredAccount:'1'});
  assert.equal(plan.sameThreadAccountSwitch,'conditional');
  assert.equal(plan.actualAccount,'NOT_OBSERVED');
  assert.equal(plan.accountSelectionOwner,'ocx');
  assert.equal(plan.quotaProtectionPercent,97);
  const result=await launchCodexCli('ocx',[],{...f.options,preferredAccount:'1',fetch:f.fetch,
    spawnSync(_executable,args){
      assert.equal(args[args.indexOf('-m')+1],'preferred-private-a/gpt-6.1-sol');
      scopedFile=JSON.parse(args.find(value=>value.startsWith('model_catalog_json=')).slice('model_catalog_json='.length));
      const row=JSON.parse(fs.readFileSync(scopedFile)).models[0];
      // Preferred binds only a new conversation; the same thread never switches accounts.
      assert.match(row.display_name,/새 대화 우선/);
      assert.equal(row.opencodex_catalog_kind,'preferred-account-v1');
      return {status:0};
    }});
  assert.equal(result.exitCode,0);assert.equal(fs.existsSync(scopedFile),false);
});

test('number reassignment after readiness cannot silently change the account', async t => {
  const f = fixture(t);
  let spawned = false;
  await assert.rejects(launchCodexCli('ocx', [], {
    ...f.options, accountSelector: '1', fetch: async url => {
      if (url.endsWith('/readyz')) {
        f.config.codexAccounts[1].alias = '3번(example28)';
        f.config.codexAccounts[0].alias = '1번(editor8)'; f.write();
      }
      return f.fetch(url);
    }, spawnSync() { spawned = true; return { status: 0 }; }
  }), /binding changed before launch/);
  assert.equal(spawned, false);
});

test('model catalog precheck survives a response after three seconds without starting inference early', async t => {
  const f = fixture(t);
  let launched = false;
  const result = await launchCodexCli('ocx', [], {
    ...f.options, fetch: async (url, request) => {
      if (url.endsWith('/models')) {
        await new Promise(resolve => setTimeout(resolve, 3_100));
        assert.equal(request.signal.aborted, false);
      }
      return f.fetch(url);
    },
    spawnSync() { launched = true; return { status: 0 }; }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(launched, true);
});
