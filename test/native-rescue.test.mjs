import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { installNativeRescue, nativeRescueStatus } from '../src/native-rescue.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-native-rescue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'openai_base_url = "http://127.0.0.1:10100/v1"',
    'model_provider = "opencodex"',
    'model_catalog_json = "/broken/ocx-catalog.json"'
  ].join('\n'));
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }] }));
  const executable = path.join(root, 'official-codex');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  return { root, home, codexHome, executable };
}

test('installed rescue locks official route above a contaminated base config', t => {
  const f = fixture(t);
  const destination = path.join(f.home, '.local', 'bin', 'codex-native-rescue');
  const options = {
    home: f.home,
    codexHome: f.codexHome,
    stateRoot: path.join(f.home, '.ai-control-center'),
    destination,
    executable: f.executable
  };
  assert.equal(installNativeRescue(options).ok, true);
  assert.equal(nativeRescueStatus(options).routeLock.cliOverrideHighestPrecedence, true);
  if (process.platform === 'win32') return;
  const result = spawnSync(destination, ['exec', '--json', 'fixture'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: f.home, CODEX_HOME: f.codexHome, AICC_NATIVE_CODEX_EXECUTABLE: f.executable }
  });
  assert.equal(result.status, 0, result.stderr);
  const args = result.stdout.trim().split('\n');
  assert.deepEqual(args.slice(0, 8), [
    '-c', 'openai_base_url="https://chatgpt.com/backend-api/codex"',
    '-c', 'model_provider="openai"',
    '-c', `model_catalog_json="${path.join(f.home, '.ai-control-center', 'native-rescue', 'models.json')}"`,
    '-m', 'gpt-5.6-sol'
  ]);
  assert.deepEqual(args.slice(8), ['exec', '--json', 'fixture']);
});

test('installed rescue remains ready after the Desktop model cache is removed', t => {
  const f = fixture(t);
  const stateRoot = path.join(f.home, '.ai-control-center');
  const destination = path.join(f.home, '.local', 'bin', 'codex-native-rescue');
  const options = {
    home: f.home,
    codexHome: f.codexHome,
    stateRoot,
    destination,
    executable: f.executable
  };
  const installed = installNativeRescue(options);
  assert.equal(installed.ok, true);
  assert.equal(installed.catalogPath, path.join(stateRoot, 'native-rescue', 'models.json'));
  fs.rmSync(path.join(f.codexHome, 'models_cache.json'));
  assert.equal(nativeRescueStatus(options).ok, true);
  if (process.platform === 'win32') return;
  const result = spawnSync(destination, ['--status'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: f.home,
      CODEX_HOME: f.codexHome,
      AICC_STATE_ROOT: stateRoot,
      AICC_NATIVE_CODEX_EXECUTABLE: f.executable
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`catalog=${path.join(stateRoot, 'native-rescue', 'models.json')}`));
});

test('rescue refuses caller attempts to replace the route or model', t => {
  const f = fixture(t);
  const destination = path.join(f.home, '.local', 'bin', 'codex-native-rescue');
  installNativeRescue({
    home: f.home,
    codexHome: f.codexHome,
    stateRoot: path.join(f.home, '.ai-control-center'),
    destination,
    executable: f.executable
  });
  if (process.platform === 'win32') return;
  for (const args of [['-c', 'openai_base_url="http://127.0.0.1:10100/v1"'], ['--profile', 'ocx'], ['-m', 'other']]) {
    const result = spawnSync(destination, args, {
      encoding: 'utf8',
      env: { ...process.env, HOME: f.home, CODEX_HOME: f.codexHome, AICC_NATIVE_CODEX_EXECUTABLE: f.executable }
    });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /route\/model override is not allowed/);
  }
});

test('installer preserves an unowned executable', t => {
  const f = fixture(t);
  const destination = path.join(f.home, '.local', 'bin', 'codex-native-rescue');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, '#!/bin/sh\necho user-owned\n', { mode: 0o755 });
  assert.throws(() => installNativeRescue({
    home: f.home,
    codexHome: f.codexHome,
    stateRoot: path.join(f.home, '.ai-control-center'),
    destination,
    executable: f.executable
  }), /unowned/);
  assert.match(fs.readFileSync(destination, 'utf8'), /user-owned/);
});

test('installer preserves an unowned Native catalog', t => {
  const f = fixture(t);
  const stateRoot = path.join(f.home, '.ai-control-center');
  const catalog = path.join(stateRoot, 'native-rescue', 'models.json');
  fs.mkdirSync(path.dirname(catalog), { recursive: true });
  fs.writeFileSync(catalog, '{"owner":"user"}\n', { mode: 0o600 });
  assert.throws(() => installNativeRescue({
    home: f.home,
    codexHome: f.codexHome,
    stateRoot,
    destination: path.join(f.home, '.local', 'bin', 'codex-native-rescue'),
    executable: f.executable
  }), /unowned Native rescue catalog/);
  assert.equal(fs.readFileSync(catalog, 'utf8'), '{"owner":"user"}\n');
});

test('failed install restores the previously owned executable, catalog and manifest', t => {
  const f = fixture(t);
  const stateRoot = path.join(f.home, '.ai-control-center');
  const destination = path.join(f.home, '.local', 'bin', 'codex-native-rescue');
  const options = {
    home: f.home,
    codexHome: f.codexHome,
    stateRoot,
    destination,
    executable: f.executable
  };
  installNativeRescue(options);
  const catalog = path.join(stateRoot, 'native-rescue', 'models.json');
  const manifest = path.join(stateRoot, 'native-rescue', 'install.json');
  const before = new Map([destination, catalog, manifest].map(file => [file, fs.readFileSync(file)]));
  // Force an owned catalog delta; unchanged files are intentionally not rewritten.
  fs.writeFileSync(path.join(f.codexHome, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', display_name: 'updated fixture' }] }));
  let replacements = 0;
  const replaceFile = (file, data, mode) => {
    replacements += 1;
    if (file === manifest) throw new Error('fixture manifest failure');
    fs.writeFileSync(file, data, { mode });
    fs.chmodSync(file, mode);
  };
  assert.throws(() => installNativeRescue({ ...options, replaceFile }), /fixture manifest failure/);
  assert.equal(replacements, 2);
  for (const [file, data] of before) assert.deepEqual(fs.readFileSync(file), data);
});
