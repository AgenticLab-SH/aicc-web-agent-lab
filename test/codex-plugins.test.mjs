import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexPluginStatus, parseCodexCapabilityPolicy, parseCodexPluginList } from '../src/adapters/codex-plugins.mjs';

function fixture(t, { policy, config } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-codex-plugins-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const policyFile = path.join(home, '.ai-control-center', 'config', 'codex-capabilities.json');
  const configFile = path.join(home, '.codex', 'config.toml');
  if (policy) {
    fs.mkdirSync(path.dirname(policyFile), { recursive: true });
    fs.writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
  }
  if (config) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, config);
  }
  return { home, policyFile, configFile };
}

const policy = {
  schemaVersion: 1,
  requiredPlugins: ['notion@openai-curated'],
  extraPluginPolicy: 'report',
  features: { apps: true, remote_plugin: true, recommended_plugins: false }
};
const config = '[features]\napps = true\nremote_plugin = true\nrecommended_plugins = false\n';

test('Codex capability policy accepts only narrow plugin and feature declarations', () => {
  assert.deepEqual(parseCodexCapabilityPolicy(JSON.stringify(policy)), policy);
  assert.throws(() => parseCodexCapabilityPolicy('{"schemaVersion":1,"requiredPlugins":[],"features":{"unknown":true}}'), /unsupported feature/);
  assert.equal(parseCodexPluginList('{"installed":[{"pluginId":"notion@openai-curated","installed":true,"enabled":true,"version":"1"}]}').get('notion@openai-curated').enabled, true);
});

test('Codex plugin status verifies the required plugin and feature policy', async t => {
  const options = fixture(t, { policy, config });
  const status = await codexPluginStatus({
    ...options,
    runCommand: async () => ({ ok: true, stdout: JSON.stringify({ installed: [{ pluginId: 'notion@openai-curated', installed: true, enabled: true, version: '0.1.7' }] }) })
  });
  assert.equal(status.state, 'ready');
  assert.deepEqual(status.pluginDrift, []);
  assert.deepEqual(status.featureDrift, []);
  assert.deepEqual(status.extraPlugins, []);
  assert.deepEqual(status.disabledPlugins, []);
  assert.deepEqual(status.readinessScope, ['required-plugin-installation', 'required-plugin-enabled', 'configured-features']);
  assert.equal(status.accountConnection, 'not_observed');
});

test('Codex plugin status reports allowed extras and can enforce an exact policy', async t => {
  const extra = { pluginId: 'github@openai-curated', installed: true, enabled: true, version: '1' };
  const options = fixture(t, { policy, config });
  const report = await codexPluginStatus({
    ...options,
    runCommand: async () => ({ ok: true, stdout: JSON.stringify({ installed: [
      { pluginId: 'notion@openai-curated', installed: true, enabled: true, version: '1' }, extra
    ] }) })
  });
  assert.equal(report.state, 'ready');
  assert.deepEqual(report.extraPlugins.map(plugin => plugin.id), ['github@openai-curated']);
  assert.deepEqual(report.extraPluginDrift, []);
  assert.match(report.detail, /추가 활성 1개 보고/);

  fs.writeFileSync(options.policyFile, JSON.stringify({ ...policy, extraPluginPolicy: 'forbid' }), { mode: 0o600 });
  const exact = await codexPluginStatus({
    ...options,
    runCommand: async () => ({ ok: true, stdout: JSON.stringify({ installed: [
      { pluginId: 'notion@openai-curated', installed: true, enabled: true, version: '1' }, extra
    ] }) })
  });
  assert.equal(exact.state, 'attention');
  assert.deepEqual(exact.extraPluginDrift, ['github@openai-curated']);
});

test('Codex plugin status reports disabled plugins and feature drift without mutation', async t => {
  const options = fixture(t, { policy, config: config.replace('remote_plugin = true', 'remote_plugin = false') });
  const before = fs.readFileSync(options.configFile, 'utf8');
  const status = await codexPluginStatus({
    ...options,
    runCommand: async () => ({ ok: true, stdout: JSON.stringify({ installed: [{ pluginId: 'notion@openai-curated', installed: true, enabled: false, version: '0.1.7' }] }) })
  });
  assert.equal(status.state, 'attention');
  assert.deepEqual(status.pluginDrift, ['notion@openai-curated']);
  assert.deepEqual(status.featureDrift, [{ key: 'remote_plugin', expected: true, actual: false }]);
  assert.equal(fs.readFileSync(options.configFile, 'utf8'), before);
});

test('Codex plugin status is optional when no owner policy exists', async t => {
  const options = fixture(t, { config });
  const status = await codexPluginStatus(options);
  assert.equal(status.state, 'unavailable');
  assert.equal(status.optional, true);
});

test('Codex plugin status rejects a symlink or group-readable owner policy', async t => {
  if (process.platform === 'win32') return;
  const options = fixture(t, { policy, config });
  fs.chmodSync(options.policyFile, 0o644);
  const insecure = await codexPluginStatus(options);
  assert.equal(insecure.state, 'attention');
  assert.match(insecure.detail, /0600/);

  const target = `${options.policyFile}.target`;
  fs.renameSync(options.policyFile, target);
  fs.symlinkSync(target, options.policyFile);
  const linked = await codexPluginStatus(options);
  assert.equal(linked.state, 'attention');
  assert.match(linked.detail, /symlink/);
});
