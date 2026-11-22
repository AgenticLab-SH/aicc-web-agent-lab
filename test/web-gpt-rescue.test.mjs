import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bootstrapWebGptRescueFromCdp, prepareWebGptRescue, startWebGptRescue, webGptRescueStatus } from '../src/web-gpt-rescue.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-web-gpt-rescue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const sourceRuntime = path.join(root, 'source-runtime');
  fs.mkdirSync(path.join(sourceRuntime, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(sourceRuntime, 'bin', 'codex-chatgpt-web'), '#!/bin/sh\necho 2.0.0-fixture\n', { mode: 0o755 });
  fs.mkdirSync(path.join(sourceRuntime, 'app'), { recursive: true });
  fs.writeFileSync(path.join(sourceRuntime, 'app', 'cli.js'), 'fixture');
  fs.symlinkSync('cli.js', path.join(sourceRuntime, 'app', 'cli-link.js'));
  const catalogSource = path.join(root, 'model-catalog.json');
  fs.writeFileSync(catalogSource, JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }, { slug: 'chatgpt-web/temporary/high' }] }));
  const spawnSync = (_command, args) => args[0] === 'print'
    ? { status: 1, stdout: '', stderr: '' }
    : { status: 0, stdout: '2.0.0-fixture\n', stderr: '' };
  return { root, home, sourceRuntime, catalogSource, spawnSync };
}

test('prepare creates an isolated port, provider home, runtime copy, and launch label', async t => {
  const f = fixture(t);
  const options = { home: f.home, stateRoot: path.join(f.home, '.ai-control-center'), sourceRuntime: f.sourceRuntime, catalogSource: f.catalogSource, spawnSync: f.spawnSync, allowUnsupportedPlatform: true };
  const prepared = prepareWebGptRescue(options);
  assert.equal(prepared.port, 17842);
  assert.equal(prepared.loginRequired, true);
  assert.equal(prepared.modelCatalogReady, true);
  // NTFS does not expose POSIX executable bits through Node's mode field.
  if (process.platform !== 'win32') assert.equal(fs.statSync(prepared.wrapper).mode & 0o777, 0o755);
  const config = JSON.parse(fs.readFileSync(path.join(prepared.root, 'provider-home', 'config.json'), 'utf8'));
  assert.equal(config.port, 17842);
  assert.equal(config.browserHost, 'managed-chrome');
  assert.equal(config.mode, 'browser-only');
  assert.match(config.runtimeCommand[0].replaceAll('\\', '/'), /web-gpt-rescue\/releases\/2\.0\.0-fixture\/runtime\/bin\/codex-chatgpt-web$/);
  const plist = fs.readFileSync(path.join(f.home, 'Library', 'LaunchAgents', 'com.agenticlab.aicc.web-gpt-rescue.plist'), 'utf8');
  assert.match(plist, /com\.agenticlab\.aicc\.web-gpt-rescue/);
  assert.doesNotMatch(plist, /<string>17841<\/string>/);
  const status = await webGptRescueStatus(options);
  assert.equal(status.state, 'login-required');
  assert.deepEqual(status.independentOf, ['http://127.0.0.1:17841', 'http://127.0.0.1:10100', '/Applications/Codex Web GPT.app']);
});

test('prepare rejects the integrated and OCX ports', t => {
  const f = fixture(t);
  for (const port of [17841, 10100]) {
    assert.throws(() => prepareWebGptRescue({ home: f.home, stateRoot: path.join(f.root, String(port)), sourceRuntime: f.sourceRuntime, catalogSource: f.catalogSource, spawnSync: f.spawnSync, allowUnsupportedPlatform: true, port }), /Invalid independent/);
  }
});

test('CDP bootstrap copies only verified ChatGPT auth cookies from the exact owned target', async t => {
  const f = fixture(t);
  const options = { home: f.home, stateRoot: path.join(f.home, '.ai-control-center'), sourceRuntime: f.sourceRuntime, catalogSource: f.catalogSource, spawnSync: f.spawnSync, allowUnsupportedPlatform: true };
  prepareWebGptRescue(options);
  const targetId = 'A'.repeat(32);
  class FakeWebSocket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(serialized) {
      const message = JSON.parse(serialized);
      const result = message.method === 'Runtime.evaluate'
        ? { result: { value: JSON.stringify({ sessionOk: true, aliasMatch: true, composer: true }) } }
        : message.method === 'Network.getAllCookies'
          ? { cookies: [
            { name: '__Secure-next-auth.session-token.0', value: 'secret', domain: '.chatgpt.com', path: '/', expires: 1, httpOnly: true, secure: true, sameSite: 'Lax' },
            { name: 'unrelated', value: 'secret', domain: '.example.com', path: '/', expires: 1, httpOnly: false, secure: true, sameSite: 'None' }
          ] }
          : {};
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, result }) })));
    }
    close() {}
  }
  const fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [{ id: targetId, type: 'page', url: 'https://chatgpt.com/?temporary-chat=true', webSocketDebuggerUrl: 'ws://127.0.0.1/test' }]
  });
  const result = await bootstrapWebGptRescueFromCdp({ ...options, endpoint: 'http://127.0.0.1:9222', targetId, accountAlias: 'secondary', WebSocketCtor: FakeWebSocket, fetch });
  assert.equal(result.cookieCount, 1);
  assert.equal(result.copiedOrigins, 0);
  const state = JSON.parse(fs.readFileSync(path.join(result.port === 17842 ? options.stateRoot : '', 'web-gpt-rescue', 'provider-home', 'browser', 'storage-state.json'), 'utf8'));
  assert.deepEqual(state.origins, []);
  assert.deepEqual(state.cookies.map(cookie => cookie.domain), ['.chatgpt.com']);
  assert.equal(await webGptRescueStatus(options).then(status => status.authenticated), true);
});

test('start resumes only an exact-zero isolated browser service', async t => {
  const f = fixture(t);
  const launchctlCalls = [];
  const spawnSync = (command, args) => {
    if (command === 'launchctl') launchctlCalls.push(args);
    if (args[0] === 'print') return { status: 1, stdout: '', stderr: '' };
    if (args[0] === 'print-disabled') return { status: 0, stdout: '\t\t"com.agenticlab.aicc.web-gpt-rescue" => disabled\n', stderr: '' };
    return { status: 0, stdout: '2.0.0-fixture\n', stderr: '' };
  };
  const stateRoot = path.join(f.home, '.ai-control-center');
  const base = { home: f.home, stateRoot, sourceRuntime: f.sourceRuntime, catalogSource: f.catalogSource, spawnSync, allowUnsupportedPlatform: true };
  prepareWebGptRescue(base);
  const providerBrowser = path.join(stateRoot, 'web-gpt-rescue', 'provider-home', 'browser');
  fs.mkdirSync(providerBrowser, { recursive: true });
  fs.writeFileSync(path.join(providerBrowser, 'storage-state.json'), '{"cookies":[],"origins":[]}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(providerBrowser, 'storage-state.json.verified.json'), '{"version":1,"authenticated":true,"verifiedAt":"2026-08-11T00:00:00Z"}\n', { mode: 0o600 });
  const requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET', authorization: init.headers?.authorization });
    return {
      ok: true,
      status: 200,
      json: async () => String(url).endsWith('/healthz')
        ? { active_http_turns: 0, active_browser_http_turns: 0, active_browser_turns: 0, accepting_browser_turns: false }
        : { accepting_browser_turns: true }
    };
  };
  const result = await startWebGptRescue({ ...base, fetch, sleep: async () => {} });
  assert.equal(result.resumedBrowser, true);
  assert.deepEqual(launchctlCalls.map(args => args[0]), ['print', 'print', 'print-disabled', 'enable', 'bootstrap']);
  assert.equal(requests.at(-1).method, 'POST');
  assert.match(requests.at(-1).authorization, /^Bearer [A-Za-z0-9_-]{40,}$/);
});

test('start restores an explicitly disabled launch label when bootstrap fails', async t => {
  const f = fixture(t);
  const launchctlCalls = [];
  const spawnSync = (command, args) => {
    if (command === 'launchctl') launchctlCalls.push(args);
    if (args[0] === 'print') return { status: 1, stdout: '', stderr: '' };
    if (args[0] === 'print-disabled') return { status: 0, stdout: '\t\t"com.agenticlab.aicc.web-gpt-rescue" => disabled\n', stderr: '' };
    if (args[0] === 'bootstrap') return { status: 5, stdout: '', stderr: 'fixture bootstrap failure' };
    return { status: 0, stdout: '2.0.0-fixture\n', stderr: '' };
  };
  const stateRoot = path.join(f.home, '.ai-control-center');
  const base = { home: f.home, stateRoot, sourceRuntime: f.sourceRuntime, catalogSource: f.catalogSource, spawnSync, allowUnsupportedPlatform: true };
  prepareWebGptRescue(base);
  const providerBrowser = path.join(stateRoot, 'web-gpt-rescue', 'provider-home', 'browser');
  fs.mkdirSync(providerBrowser, { recursive: true });
  fs.writeFileSync(path.join(providerBrowser, 'storage-state.json'), '{"cookies":[],"origins":[]}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(providerBrowser, 'storage-state.json.verified.json'), '{"version":1,"authenticated":true,"verifiedAt":"2026-08-11T00:00:00Z"}\n', { mode: 0o600 });

  await assert.rejects(() => startWebGptRescue(base), /fixture bootstrap failure/);
  assert.deepEqual(launchctlCalls.map(args => args[0]), ['print', 'print', 'print-disabled', 'enable', 'bootstrap', 'disable']);
});
