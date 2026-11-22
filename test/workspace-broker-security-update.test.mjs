import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const broker = 'tools/platform/windows/Invoke-AiccWorkspaceSandbox.ps1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = file => digest(fs.readFileSync(file));
const json = value => JSON.stringify(value, null, 2) + '\n';
const updater = fs.readFileSync(new URL('../tools/platform/workspace-mcp/Update-AiccWebManagementRuntime.ps1', import.meta.url), 'utf8');
const helpers = updater.slice(updater.indexOf('function Regular('), updater.indexOf('$OperationDirectory=[IO.Path]::GetFullPath'));

function fixture(t, patchParents = false) {
  const storeCheckpoint = patchParents === 'store-checkpoint';
  const lifecycle = patchParents === 'process-lifecycle';
  const broker = lifecycle ? 'components/workspace-mcp/server.mjs' : storeCheckpoint ? 'src/jobs/durable-store.mjs' : patchParents ? 'components/workspace-mcp/platform-ops.mjs' : 'tools/platform/windows/Invoke-AiccWorkspaceSandbox.ps1';
  const overlayKey = lifecycle ? 'processLifecycleOverlay' : storeCheckpoint ? 'storeCheckpointOverlay' : patchParents ? 'patchParentOverlay' : 'brokerSecurityOverlay';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-broker-security-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : json(value)); return file; };
  const baseline = path.join(root, 'releases/workspace/current'), backend = path.join(root, 'releases/workspace/security');
  const oldGateway = path.join(root, 'releases/unified-mcp/current'), gateway = path.join(root, 'releases/unified-mcp/security');
  const bindingFile = put(path.join(root, 'binding.json'), { identity: 'owner' });
  const configFile = put(path.join(root, 'workspace-mcp/config.json'), { surfaceProfile: 'business-full', permissions: { unchanged: true }, webManagement: { bindingFile, bindingSha256: hash(bindingFile) } });
  const profile = put(path.join(root, 'profile.yaml'), `entry: '${oldGateway}\\gateway.cjs'\nconfig: '${oldGateway}\\config.json'\n`);
  const beforeBroker = put(path.join(baseline, broker), 'old fixture broker');
  if (!lifecycle) put(path.join(baseline, 'components/workspace-mcp/server.mjs'), 'unchanged server');
  put(path.join(baseline, 'provider.mjs'), 'actual existing provider');
  const release = { schemaVersion: 1, metadata: 'preserve', files: [{ path: broker, sha256: hash(beforeBroker), size: fs.statSync(beforeBroker).size },
    { path: 'provider.mjs', sha256: 'a'.repeat(64), size: 3 }], fileCount: 2, totalBytes: fs.statSync(beforeBroker).size + 3 };
  put(path.join(baseline, '.aicc-release.json'), release);
  const drive = { schemaVersion: 1, metadata: 'preserve', files: { [broker]: hash(beforeBroker), '.aicc-release.json': 'b'.repeat(64), 'provider.mjs': 'a'.repeat(64) } };
  put(path.join(baseline, 'workspace-drive-manifest.json'), drive);
  const inventory = directory => {
    const rows = [];
    const visit = (folder, prefix = '') => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const relative = prefix + entry.name, file = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(file, relative + '/'); else rows.push({ path: relative, size: fs.statSync(file).size, sha256: hash(file) });
    } };
    visit(directory); return rows;
  };
  const inventoryBeforeFile = put(path.join(root, 'inventory.before.json'), inventory(baseline));
  fs.cpSync(baseline, backend, { recursive: true });
  const afterBroker = put(path.join(backend, broker), 'new fixture broker security');
  const proof = { schemaVersion: 1, baseline, oldGateway, registrySHA256: 'c'.repeat(64), baselineInventorySHA256: hash(inventoryBeforeFile),
    brokerBefore: hash(beforeBroker), brokerAfter: hash(afterBroker), configSHA256: hash(configFile), profileSHA256: hash(profile), acceptanceSHA256: 'd'.repeat(64),
    brokerRelative: broker, sourceBroker: afterBroker, acceptanceFile: path.join(root, 'acceptance.json'), manifestDiscrepancies: [{ path: 'provider.mjs', preserved: true }] };
  const nextRelease = structuredClone(release);
  nextRelease.files[0].sha256 = hash(afterBroker); nextRelease.files[0].size = fs.statSync(afterBroker).size;
  nextRelease.totalBytes = nextRelease.files.reduce((total, row) => total + row.size, 0); nextRelease[overlayKey] = proof;
  put(path.join(backend, '.aicc-release.json'), nextRelease);
  const nextDrive = structuredClone(drive); nextDrive.baseline = baseline; nextDrive.release = backend;
  nextDrive.files[broker] = hash(afterBroker); nextDrive.files['.aicc-release.json'] = hash(path.join(backend, '.aicc-release.json')); nextDrive[overlayKey] = proof;
  put(path.join(backend, 'workspace-drive-manifest.json'), nextDrive);
  const command = put(path.join(root, 'node.exe'), 'fixture node');
  const graph = { hostControl: 'task-owned-v1', metadata: 'preserve', providers: ['workspace', 'native', 'host'].map(id => {
    const entrypoint = id === 'workspace' ? path.join(baseline, 'components/workspace-mcp/server.mjs') : put(path.join(root, id + '.cjs'), id);
    return { id, command, entrypoint, args: [entrypoint], toolHash: id + '-contract', files: [command, entrypoint].map(file => ({ path: file, sha256: hash(file) })) };
  }) };
  put(path.join(oldGateway, 'config.json'), graph); put(path.join(oldGateway, 'gateway.cjs'), 'unchanged gateway');
  const manifest = { metadata: 'keep', releaseHash: hash(path.join(oldGateway, 'config.json')), files: Object.fromEntries(['gateway.cjs', 'config.json'].map(name => [name, hash(path.join(oldGateway, name))])) };
  put(path.join(oldGateway, 'manifest.json'), manifest);
  fs.cpSync(oldGateway, gateway, { recursive: true });
  const nextGraph = structuredClone(graph), workspace = nextGraph.providers[0];
  workspace.entrypoint = workspace.entrypoint.replace(baseline, backend); workspace.args[0] = workspace.entrypoint;
  workspace.files[1].path = workspace.entrypoint;
  if (lifecycle) workspace.files[1].sha256 = hash(afterBroker);
  put(path.join(gateway, 'config.json'), nextGraph);
  const nextManifest = structuredClone(manifest); nextManifest.files['config.json'] = hash(path.join(gateway, 'config.json')); nextManifest.releaseHash = nextManifest.files['config.json'];
  put(path.join(gateway, 'manifest.json'), nextManifest);
  const profileDesiredFile = put(path.join(root, 'profile.desired.yaml'), fs.readFileSync(profile, 'utf8').replaceAll(oldGateway, gateway));
  const candidate = { kind: lifecycle ? 'workspace-process-lifecycle-update' : storeCheckpoint ? 'workspace-store-checkpoint-update' : patchParents ? 'workspace-patch-parent-update' : 'workspace-broker-security-update', baseline, backend, oldGateway, gateway, configBeforeSHA256: hash(configFile), configDesiredSHA256: hash(configFile),
    bindingFile, bindingSHA256: hash(bindingFile), profileBeforeSHA256: hash(profile), profileDesiredFile,
    gatewayConfigSHA256: hash(path.join(gateway, 'config.json')), oldGatewayConfigSHA256: hash(path.join(oldGateway, 'config.json')), oldGatewayManifestSHA256: hash(path.join(oldGateway, 'manifest.json')),
    changedFiles: [broker, '.aicc-release.json', 'workspace-drive-manifest.json'], brokerSecurity: { ...proof, inventoryBeforeFile, inventoryBeforeSHA256: hash(inventoryBeforeFile), inventoryDesiredFile: path.join(root, 'inventory.desired.json') } };
  const candidateFile = path.join(root, 'candidate.json');
  const refresh = () => { put(candidate.brokerSecurity.inventoryDesiredFile, inventory(backend)); candidate.brokerSecurity.inventoryDesiredSHA256 = hash(candidate.brokerSecurity.inventoryDesiredFile); put(candidateFile, candidate); };
  refresh();
  const script = put(path.join(root, 'validate.ps1'), `param($CandidateReceipt,$configFile,$profileFile,$Check='delta')\n$ErrorActionPreference='Stop'\n${helpers}\n$c=Read $CandidateReceipt;$before=Read $configFile;$after=Read $configFile\nif($Check -eq 'revision'){Assert-BrokerSecurityUpdate $c $before $after}else{Assert-BrokerSecurityDelta $c $before $after}\n`);
  const validate = (check = 'delta') => spawnSync('pwsh', ['-NoProfile', '-File', script, candidateFile, configFile, profile, check], { encoding: 'utf8', windowsHide: true });
  return { root, baseline, backend, gateway, candidate, candidateFile, configFile, profileDesiredFile, refresh, put, validate };
}

test('broker security delta preserves stale metadata and exact graph while accepting only its three files', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const accepted = f.validate(); assert.equal(accepted.status, 0, accepted.stderr);
  const unchanged = fs.readFileSync(path.join(f.backend, 'provider.mjs'));
  f.put(path.join(f.backend, 'provider.mjs'), 'unrelated source-read modification'); f.refresh();
  const rejected = f.validate(); assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /exceeds exact approved delta/);
  fs.writeFileSync(path.join(f.backend, 'provider.mjs'), unchanged); f.refresh();
  f.put(path.join(f.backend, 'unexpected.mjs'), 'unapproved addition'); f.refresh();
  const addition = f.validate(); assert.notEqual(addition.status, 0); assert.match(addition.stderr, /file set changed/);
});

test('broker security rejects repinned foreign graph, profile and manifest edits and unsupported revisions', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const graphFile = path.join(f.gateway, 'config.json'), graph = JSON.parse(fs.readFileSync(graphFile));
  graph.providers[2].toolHash = 'expanded-host-authority'; f.put(graphFile, graph); f.candidate.gatewayConfigSHA256 = hash(graphFile); f.refresh();
  let run = f.validate(); assert.notEqual(run.status, 0); assert.match(run.stderr, /preserve host\/native\/tool authority/);
  graph.providers[2].toolHash = 'host-contract'; f.put(graphFile, graph); f.candidate.gatewayConfigSHA256 = hash(graphFile); f.refresh();
  fs.appendFileSync(f.profileDesiredFile, 'foreign: changed\n');
  run = f.validate(); assert.notEqual(run.status, 0); assert.match(run.stderr, /profile exceeds exact/);
  run = f.validate('revision'); assert.notEqual(run.status, 0); assert.match(run.stderr, /Exact reviewed broker security revision/);
});

test('store checkpoint delta preserves permissions and other providers and rejects an unreviewed revision', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t, 'store-checkpoint');
  let run = f.validate();
  assert.equal(run.status, 0, run.stderr);
  f.put(path.join(f.backend, 'provider.mjs'), 'unapproved unrelated source');
  f.refresh();
  run = f.validate();
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /exceeds exact approved delta/);
  run = f.validate('revision');
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Exact reviewed store checkpoint revision/);
});

test('patch-parent overlay accepts only its module and refuses unrelated security changes or unknown revision', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t, true);
  let run = f.validate(); assert.equal(run.status, 0, run.stderr);
  f.put(path.join(f.backend, 'provider.mjs'), 'unapproved change'); f.refresh();
  run = f.validate(); assert.notEqual(run.status, 0); assert.match(run.stderr, /exceeds exact approved delta/);
  run = f.validate('revision'); assert.notEqual(run.status, 0); assert.match(run.stderr, /Exact reviewed patch-parent revision/);
});

test('process lifecycle overlay preserves full inventory and fails closed on unrelated delta and revision', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t, 'process-lifecycle');
  let run = f.validate();
  assert.equal(run.status, 0, run.stderr);
  f.put(path.join(f.backend, 'provider.mjs'), 'unreviewed provider modification'); f.refresh();
  run = f.validate();
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /exceeds exact approved delta/);
  run = f.validate('revision');
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Exact reviewed process lifecycle revision/);
});
