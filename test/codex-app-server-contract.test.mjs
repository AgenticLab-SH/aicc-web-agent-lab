import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareAppServerContract, treeHash } from '../tools/platform/codex/prepare-app-server-contract.mjs';

const METHODS = [
  'initialize', 'thread/start', 'thread/resume', 'thread/list', 'thread/read', 'turn/start',
  'turn/steer', 'turn/interrupt', 'model/list', 'modelProvider/capabilities/read',
  'skills/list', 'hooks/list', 'app/installed'
];

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-app-server-contract-')));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'codex');
  fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o700 });
  const baseline = path.join(root, 'baseline');
  fs.mkdirSync(path.join(baseline, 'json-schema'), { recursive: true });
  fs.mkdirSync(path.join(baseline, 'typescript'), { recursive: true });
  fs.writeFileSync(path.join(baseline, 'manifest.json'), JSON.stringify({ codexVersion: '0.148.0-alpha.15' }));
  fs.writeFileSync(path.join(baseline, 'json-schema', 'ClientRequest.json'), '{}\n');
  fs.writeFileSync(path.join(baseline, 'typescript', 'ClientRequest.ts'), 'export type ClientRequest = { "method": "initialize" };\n');
  return { root, binary, baseline, output: path.join(root, 'output') };
}

function fakeSpawn(_binary, args) {
  if (args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.149.0-alpha.4.3\n', stderr: '' };
  const output = args.at(-1);
  fs.mkdirSync(output, { recursive: true });
  if (args[1] === 'generate-ts') {
    fs.writeFileSync(path.join(output, 'ClientRequest.ts'), `// GENERATED CODE! DO NOT MODIFY BY HAND!\nexport type ClientRequest = ${METHODS.map(method => `{ "method": "${method}" }`).join(' | ')};\n`);
  } else {
    fs.writeFileSync(path.join(output, 'ClientRequest.json'), '{}\n');
  }
  return { status: 0, stdout: '', stderr: '' };
}

test('prepares an owner-private version-pinned contract and compatibility summary', t => {
  const f = fixture(t);
  const result = prepareAppServerContract({
    executable: f.binary,
    outputRoot: f.output,
    baselineRoot: f.baseline,
    spawnSync: fakeSpawn,
    now: () => Date.parse('2026-08-25T07:00:00Z')
  });
  assert.equal(result.version, '0.149.0-alpha.4.3');
  const manifest = JSON.parse(fs.readFileSync(result.manifestFile, 'utf8'));
  assert.equal(manifest.codexVersion, result.version);
  assert.equal(manifest.callbackRequiredMethods.join(','), 'initialize,thread/read,thread/resume,turn/start');
  assert.equal(manifest.compatibilityDiff.clientRequestMethods.added, METHODS.length - 1);
  assert.equal(manifest.outputs.typescript.treeSha256, treeHash(path.join(result.root, 'typescript')));
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.output).mode & 0o077, 0);
  else assert.equal(fs.lstatSync(f.output).isSymbolicLink(), false);
});

test('fails closed when a reviewed stable method disappears', t => {
  const f = fixture(t);
  const missing = (_binary, args) => {
    if (args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.149.0-alpha.4.3\n', stderr: '' };
    const output = args.at(-1);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, args[1] === 'generate-ts' ? 'ClientRequest.ts' : 'ClientRequest.json'), args[1] === 'generate-ts' ? 'export type ClientRequest = { "method": "initialize" };\n' : '{}\n');
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.throws(() => prepareAppServerContract({ executable: f.binary, outputRoot: f.output, spawnSync: missing }), /stable_methods_missing/);
  assert.equal(fs.existsSync(path.join(f.output, '0.149.0-alpha.4.3')), false);
});

test('refuses to overwrite an existing version contract', t => {
  const f = fixture(t);
  prepareAppServerContract({ executable: f.binary, outputRoot: f.output, spawnSync: fakeSpawn });
  assert.throws(() => prepareAppServerContract({ executable: f.binary, outputRoot: f.output, spawnSync: fakeSpawn }), /contract_version_preexists/);
});

test('user goal resume is described only with installed provenance schema and stays opt-in', t => {
  for (const withOrigin of [false, true]) {
    const f = fixture(t);
    const generator = (binary, args) => {
      const result = fakeSpawn(binary, args);
      if (args[1] === 'generate-ts') {
        fs.appendFileSync(path.join(args.at(-1), 'ClientRequest.ts'), '\nexport type Goals = { "method": "thread/goal/get" } | { "method": "thread/goal/set" };\n');
      } else if (args[1] === 'generate-json-schema') {
        const dir = path.join(args.at(-1), 'v2');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'ThreadGoalSetParams.json'), JSON.stringify({
          required: ['threadId'], properties: { origin: {}, status: {} },
          definitions: { ThreadGoalMutationOrigin: { enum: withOrigin ? ['user', 'automatic'] : ['automatic'] }, ThreadGoalStatus: { enum: ['active'] } }
        }));
      }
      return result;
    };
    const result = prepareAppServerContract({ executable: f.binary, outputRoot: f.output, spawnSync: generator });
    const manifest = JSON.parse(fs.readFileSync(result.manifestFile, 'utf8'));
    assert.equal(Boolean(manifest.userGoalResume), withOrigin);
    assert.equal(manifest.productionStableAllowlist.includes('thread/goal/get'), true);
    assert.equal(manifest.productionStableAllowlist.includes('thread/goal/set'), false);
    assert.equal(manifest.nativeParentGoalAuthority.authorityReady, false);
  }
});
test('optional installed rate limits read is schema-pinned, read-only and cannot grant original issuer authority',t=>{
  const f=fixture(t);
  const generator=(binary,args)=>{
    const result=fakeSpawn(binary,args);
    if(args[1]==='generate-ts')
      fs.appendFileSync(path.join(args.at(-1),'ClientRequest.ts'),
        '\nexport type RateLimitRead={ "method": "account/rateLimits/read" };\n');
    return result;
  };
  const out=prepareAppServerContract({executable:f.binary,outputRoot:f.output,spawnSync:generator});
  const manifest=JSON.parse(fs.readFileSync(out.manifestFile,'utf8'));
  const proof=manifest.officialQuotaRead;
  assert.equal(proof.method,'account/rateLimits/read');
  assert.equal(proof.readOnly,true);
  assert.equal(proof.originalCliIssuerBound,false);
  assert.equal(proof.quotaRecoveryAuthority,false);
  assert.equal(proof.senderAllowed,false);
  assert.match(proof.generatedClientRequestSha256,/^[a-f0-9]{64}$/);
  assert.equal(manifest.productionStableAllowlist.includes('account/rateLimits/read'),true);
  assert.equal(manifest.productionStableAllowlist.includes('thread/goal/set'),false);
  const f2=fixture(t);
  const noMethod=prepareAppServerContract({executable:f2.binary,outputRoot:f2.output,spawnSync:fakeSpawn});
  const unsupported=JSON.parse(fs.readFileSync(noMethod.manifestFile,'utf8'));
  assert.equal(unsupported.officialQuotaRead,null);
  assert.equal(unsupported.productionStableAllowlist.includes('account/rateLimits/read'),false);
});
