import assert from 'node:assert/strict';
import test from 'node:test';
import { webGptCommand } from '../src/lib/web-gpt-command.mjs';

const nativeRuntime = ['C:\\Program Files\\Bun\\bun.exe', 'C:\\AICC runtime\\cli.js'];
const windows = config => ({ platform: 'win32', env: {}, readFile: () => JSON.stringify(config) });

test('Windows main route invokes the configured native runtime without a shell', () => {
  assert.deepEqual(webGptCommand(['doctor', '--json'], windows({ port: 17841, runtimeCommand: nativeRuntime })), {
    executable: nativeRuntime[0], args: [nativeRuntime[1], 'doctor', '--json']
  });
});

test('an absent Windows installation never resolves to the independent rescue route', () => {
  const options = { platform: 'win32', env: {}, readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } };
  assert.deepEqual(webGptCommand(['doctor'], options), { executable: 'codex-chatgpt-web.exe', args: ['doctor'] });
});

test('invalid, rescue, or shell runtime descriptors fail closed', () => {
  for (const runtimeCommand of [[], ['bun.exe'], ['C:\\AICC\\bridge.cmd'], ['C:\\AICC\\bridge.ps1'], ['C:\\Bun\\bun.exe', 'bad\nargument']]) {
    assert.throws(() => webGptCommand([], windows({ port: 17841, runtimeCommand })), /runtimeCommand/);
  }
  assert.throws(() => webGptCommand([], windows({ port: 17842, runtimeCommand: nativeRuntime })), /rescue runtime/);
  assert.throws(() => webGptCommand([], { ...windows({}), readFile: () => 'invalid' }), /cannot be read safely/);
});

test('explicit executable injection and legacy environment aliases remain available', () => {
  for (const key of ['AICC_WEB_GPT_CLI', 'CODEX_CHATGPT_WEB_CLI']) {
    assert.deepEqual(webGptCommand(['status'], { platform: 'win32', env: { [key]: 'fixture-cli' } }), { executable: 'fixture-cli', args: ['status'] });
  }
  assert.deepEqual(webGptCommand(['status'], { executable: 'fixture-cli', env: {} }), { executable: 'fixture-cli', args: ['status'] });
  assert.equal(webGptCommand([], { env: { AICC_WEB_GPT_CLI: ' ', CODEX_CHATGPT_WEB_CLI: 'legacy-fixture' } }).executable, 'legacy-fixture');
});

test('macOS retains its app runtime and Linux uses its native CLI', () => {
  assert.match(webGptCommand([], { platform: 'darwin', env: {} }).executable, /^\/Applications\/Codex Web GPT.app\//);
  assert.equal(webGptCommand([], { platform: 'linux', env: {} }).executable, 'codex-chatgpt-web');
});
