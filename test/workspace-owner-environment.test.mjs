import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { windowsOwnerEnvironment } from '../components/workspace-mcp/windows-owner-environment.mjs';
test('owner environment restores native commands from reduced MCP environment without duplicate Windows keys', () => {
  const env = windowsOwnerEnvironment({ env: { Path: 'C:\\tools;C:\\TOOLS', PATHEXT: '.CPL', SystemRoot: 'C:\\Windows', UserProfile: 'C:\\owner' }, root: 'C:\\project', runtimeRoot: 'C:\\runtime', nodePath: 'C:\\node\\node.exe', gitPath: 'C:\\git\\git.exe' });
  assert.equal(env.ComSpec, 'C:\\Windows\\System32\\cmd.exe'); assert.ok(env.PATHEXT.includes('.EXE;.BAT;.CMD'));
  assert.equal(env.Path, undefined); assert.equal(env.PATH.split(';').filter(x => x.toLowerCase() === 'c:\\tools').length, 1);
  assert.equal(env.PATH.split(';')[0], 'C:\\node'); assert.equal(env.UserProfile, 'C:\\owner'); assert.equal(env.HOME, 'C:\\project');
});
test('owner environment keeps input immutable and does not invent credentials', () => {
  const input = { PATH: '', PATHEXT: '.CPL', ComSpec: '' }, before = structuredClone(input);
  const env = windowsOwnerEnvironment({ env: input, root: 'C:\\work', runtimeRoot: 'C:\\run', nodePath: 'C:\\node\\node.exe' });
  assert.deepEqual(input, before); assert.equal(env.OPENCODEX_API_AUTH_TOKEN, undefined); assert.equal(env.AICC_WORKSPACE_ROOT, 'C:\\work');
});
test('Windows owner PowerShell really executes native Node and preserves UTF-8 output', { skip: process.platform !== 'win32' }, () => {
  const env = windowsOwnerEnvironment({ env: { SystemRoot: process.env.SystemRoot, PATH: '', PATHEXT: '.CPL' }, root: process.cwd(), runtimeRoot: process.cwd() });
  const run = spawnSync(env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); node.exe --version; if($LASTEXITCODE -ne 0){exit 9}; Write-Output "한글 실행 완료"'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /v\d+\.\d+\.\d+/); assert.match(run.stdout, /한글 실행 완료/);
});
