import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectNativeCallbackSafety, inspectWebGptReleaseMatrix } from '../src/codex-callback-safety.mjs';

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-callback-safety-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex-chatgpt-web', 'codex'), { recursive: true });
  return home;
}

test('native callback safety requires the official endpoint, inactive Web GPT journal, and independent rescue', t => {
  const home = fixture(t);
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'openai_base_url = "https://chatgpt.com/backend-api/codex"\n\n[agents]\nenabled = false\n');
  fs.writeFileSync(path.join(home, '.codex-chatgpt-web', 'codex', 'integration-journal.json'), '{"version":6,"active":false}\n');
  const safe = inspectNativeCallbackSafety({ home, nativeRescueInspector: () => ({ ok: true, model: 'gpt-test', routeLock: { endpoint: 'https://chatgpt.com/backend-api/codex', independentOf: ['17841'] } }) });
  assert.equal(safe.ok, true);
  assert.equal(safe.compactRoute, 'https://chatgpt.com/backend-api/codex');
  assert.equal(safe.rawConfigIncluded, false);

  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '# Managed by codex-chatgpt-web\nopenai_base_url = "http://127.0.0.1:17841/v1"\n');
  const unsafe = inspectNativeCallbackSafety({ home, nativeRescueInspector: () => ({ ok: true }) });
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.managedWebGptMarkerPresent, true);
  assert.equal(unsafe.endpoint, 'http://127.0.0.1:17841/v1');
});

test('release matrix distinguishes coherent service files from an incompatible launcher runtime', t => {
  const home = fixture(t);
  const appRoot = path.join(home, 'app-runtime');
  const serviceRoot = path.join(home, '.codex-chatgpt-web', 'versions', '2.0.0-aicc.18-darwin-arm64');
  for (const root of [appRoot, serviceRoot]) fs.mkdirSync(path.join(root, 'app'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'app', 'package.json'), '{"version":"2.1.10"}\n');
  fs.writeFileSync(path.join(appRoot, 'manifest.json'), '{"bundleId":"app-bundle"}\n');
  fs.writeFileSync(path.join(serviceRoot, 'app', 'package.json'), '{"version":"2.0.0-aicc.18"}\n');
  fs.writeFileSync(path.join(serviceRoot, 'manifest.json'), '{"bundleId":"service-bundle","sourceCommit":"abc"}\n');
  const configFile = path.join(home, '.codex-chatgpt-web', 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({ releaseVersion: '2.0.0-aicc.18', runtimeCommand: [path.join(serviceRoot, 'bin', 'codex-chatgpt-web')] })}\n`);
  const plistFile = path.join(home, 'service.plist');
  fs.writeFileSync(plistFile, `<plist><dict><key>ProgramArguments</key><array><string>${path.join(serviceRoot, 'bin', 'codex-chatgpt-web')}</string><string>serve</string></array></dict></plist>`);
  const matrix = inspectWebGptReleaseMatrix({ home, appRuntimeRoot: appRoot, configFile, plistFile });
  assert.equal(matrix.serviceCoherent, true);
  assert.equal(matrix.sameRelease, false);
  assert.equal(matrix.state, 'WEB_GPT_RELEASE_MATRIX_MISMATCH');
  assert.equal(matrix.app.releaseVersion, '2.1.10');
  assert.equal(matrix.service.releaseVersion, '2.0.0-aicc.18');
});
