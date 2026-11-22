import assert from 'node:assert/strict';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(root, 'tools', 'platform', 'codex', 'destructive_operation_guard_hook.py');
const python = process.platform === 'win32' ? 'py' : 'python3';
const pythonArgs = process.platform === 'win32' ? ['-3', hook] : [hook];

function run(tool_name, tool_input) {
  const result = spawnSync(python, pythonArgs, {
    input: JSON.stringify({ tool_name, tool_input }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function denied(result) {
  return result?.hookSpecificOutput?.permissionDecision === 'deny';
}

test('blocks destructive operations against protected Windows roots', () => {
  assert.equal(denied(run('Bash', { command: 'Remove-Item -LiteralPath C:\\\\ -Recurse -Force' })), true);
  assert.equal(denied(run('Bash', { command: "$root='C:\\\\demo\\\\open-AICC'; Remove-Item -LiteralPath $root -Recurse -Force" })), true);
  assert.equal(denied(run('Bash', { command: 'Clear-Disk -Number 0 -RemoveData' })), true);
});

test('blocks destructive git commands and mass delete patches', () => {
  assert.equal(denied(run('Bash', { command: 'git reset --hard HEAD' })), true);
  const patch = Array.from({ length: 20 }, (_, index) => `*** Delete File: fixture-${index}.txt`).join('\n');
  assert.equal(denied(run('apply_patch', { patch })), true);
});

test('allows ordinary child cleanup and read-only commands', () => {
  assert.equal(run('Bash', { command: 'Remove-Item -LiteralPath C:\\\\demo\\\\open-AICC\\\\.tmp-test -Recurse -Force' }), null);
  assert.equal(run('Bash', { command: 'git status --short' }), null);
});

test('root-denial diagnostics never expose owner paths or suggest splitting to bypass the guard', () => {
  const owner = os.homedir();
  for (const result of [run('Bash', { command: `Remove-Item -LiteralPath "${owner}" -Recurse -Force` }),
    run('remove_directory', { path: owner })]) {
    assert.equal(denied(result), true);
    const reason = result.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /protected root/);
    assert.match(reason, /do not retry through another tool/);
    assert.ok(!reason.toLowerCase().includes(owner.toLowerCase()));
  }
  const patch = Array.from({ length: 20 }, (_, i) => `*** Delete File: fixture-${i}.txt`).join('\n');
  const reason = run('apply_patch', { patch }).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /20 files/);
  assert.match(reason, /do not split requests to bypass/);
  assert.doesNotMatch(reason, /Split and review/);
});

test('deny is one compact ASCII envelope and allow remains silent', () => {
  const result = spawnSync(python, pythonArgs, { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD' } }), encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.doesNotMatch(result.stdout, /[^\x00-\x7f]/);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(result.stdout.trim(), JSON.stringify(parsed));
  assert.equal(run('Bash', { command: 'git status --short' }), null);
});