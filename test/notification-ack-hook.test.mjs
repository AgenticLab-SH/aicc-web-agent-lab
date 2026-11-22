import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acknowledgeUserPrompt,
  loadSessionBinding,
  MAX_HOOK_INPUT_BYTES,
  parseUserPromptSubmit,
  runAckSubprocess
} from '../tools/platform/codex/notification-ack-hook.mjs';
import {
  applyNotificationAckHook,
  notificationAckHookCommand,
  notificationAckHookWindowsCommand,
  planNotificationAckHook,
  rollbackNotificationAckHook
} from '../tools/platform/codex/install-notification-ack-hook.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hookFile = path.join(root, 'tools', 'platform', 'codex', 'notification-ack-hook.mjs');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-notification-ack-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateRoot = path.join(home, 'state');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(path.join(stateRoot, 'notifications'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  return {
    home,
    stateRoot,
    codexHome,
    hooksPath: path.join(codexHome, 'hooks.json'),
    bindingPath: path.join(stateRoot, 'notifications', 'codex-session-bindings.json'),
    hookFile,
    nodeBinary: process.execPath,
    now: () => new Date('2026-08-16T03:00:00.000Z')
  };
}

function writeBinding(options, bindings, mode = 0o600) {
  fs.writeFileSync(options.bindingPath, `${JSON.stringify({ schemaVersion: 1, bindings })}\n`, { mode });
  fs.chmodSync(options.bindingPath, mode);
}

test('valid mapped session sends only exact ACK metadata through stdin', async t => {
  const options = fixture(t);
  const prompt = 'THIS_PROMPT_MUST_NOT_ESCAPE';
  writeBinding(options, {
    'session-123': {
      projectKey: 'ai-platform',
      taskId: 'task-456',
      eventId: 'event-789',
      expiresAt: '2026-08-16T04:00:00.000Z'
    }
  });
  const calls = [];
  const raw = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session-123',
    turn_id: 'turn-private',
    prompt,
    transcript_path: '/private/transcript.jsonl'
  });
  const result = await acknowledgeUserPrompt(raw, {
    ...options,
    runAck(binding) {
      calls.push(binding);
      return { ok: true, status: 0 };
    }
  });
  assert.deepEqual(result, { ok: true, state: 'acknowledged' });
  assert.deepEqual(calls, [{ projectKey: 'ai-platform', taskId: 'task-456', eventId: 'event-789' }]);
  assert.doesNotMatch(JSON.stringify(calls), /THIS_PROMPT|turn-private|transcript/);
});

test('default subprocess keeps identifiers out of argv and prompt out of stdin', () => {
  const invocations = [];
  const binding = { projectKey: 'project-secret-id', taskId: 'task-secret-id', eventId: 'event-secret-id' };
  const result = runAckSubprocess(binding, {
    aiccBin: '/canonical/aicc',
    spawnSync(executable, argv, options) {
      invocations.push({ executable, argv, input: options.input, stdio: options.stdio, windowsHide: options.windowsHide });
      return { status: 0 };
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(invocations[0].argv, ['notify', 'ack']);
  assert.equal(invocations[0].executable, '/canonical/aicc');
  assert.deepEqual(JSON.parse(invocations[0].input), binding);
  assert.doesNotMatch(invocations[0].argv.join(' '), /project-secret|task-secret|event-secret/);
  assert.doesNotMatch(invocations[0].input, /prompt|transcript|session/i);
  assert.deepEqual(invocations[0].stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(invocations[0].windowsHide, true);
});

test('Windows default subprocess launches the extensionless AICC script through Node', () => {
  if (process.platform !== 'win32') return;
  const invocations = [];
  const result = runAckSubprocess({ projectKey: 'project', taskId: 'task' }, {
    spawnSync(executable, argv, options) {
      invocations.push({ executable, argv, input: options.input });
      return { status: 0 };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(invocations[0].executable, process.execPath);
  assert.match(invocations[0].argv[0], /[\\/]bin[\\/]aicc$/);
  assert.deepEqual(invocations[0].argv.slice(1), ['notify', 'ack']);
});

test('acknowledgement passes no raw hook fields to its injected runner', async () => {
  const calls = [];
  const binding = { projectKey: 'project-secret-id', taskId: 'task-secret-id', eventId: 'event-secret-id' };
  const result = await acknowledgeUserPrompt(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'session-123' }), {
    loadBinding: () => binding,
    runAck(value, options) {
      calls.push({ value, options });
      return { ok: true };
    }
  });
  assert.equal(result.state, 'acknowledged');
  assert.deepEqual(calls[0].value, binding);
  assert.equal(Object.values(calls[0].options).some(value => String(value).includes('task-secret-id')), false);
});

test('wrong, missing, malformed, and oversized hook input is ignored without ACK', async () => {
  let calls = 0;
  const run = raw => acknowledgeUserPrompt(raw, {
    loadBinding() {
      calls += 1;
      return null;
    }
  });
  await run(JSON.stringify({ hook_event_name: 'Stop', session_id: 'session-123' }));
  await run(JSON.stringify({ hook_event_name: 'UserPromptSubmit' }));
  await run('{broken');
  await run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'session-123', prompt: 'x'.repeat(MAX_HOOK_INPUT_BYTES) }));
  assert.equal(calls, 0);
  assert.equal(parseUserPromptSubmit(Buffer.alloc(MAX_HOOK_INPUT_BYTES + 1, 65)), null);
});

test('missing, expired, unsafe, or absent session bindings fail open', async t => {
  const options = fixture(t);
  const raw = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'session-123' });
  assert.equal((await acknowledgeUserPrompt(raw, options)).reason, 'no_binding');
  writeBinding(options, { 'session-123': { projectKey: 'ai-platform', taskId: 'task-456', expiresAt: '2026-08-16T02:59:59.000Z' } });
  assert.equal(loadSessionBinding('session-123', options), null);
  fs.chmodSync(options.bindingPath, 0o644);
  if (process.platform !== 'win32') {
    assert.equal((await acknowledgeUserPrompt(raw, options)).reason, 'binding_unavailable');
  } else {
    assert.equal((await acknowledgeUserPrompt(raw, options)).reason, 'no_binding');
  }
  fs.rmSync(options.bindingPath);
  fs.symlinkSync(path.join(options.home, 'missing'), options.bindingPath);
  assert.equal((await acknowledgeUserPrompt(raw, options)).reason, 'binding_unavailable');
});

test('standalone hook emits no prompt, diagnostics, or ACK output on ignored input', t => {
  const options = fixture(t);
  const secret = 'PROMPT_MUST_NEVER_APPEAR';
  const result = spawnSync(process.execPath, [hookFile], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'unbound', prompt: secret }),
    encoding: 'utf8',
    env: { ...process.env, AICC_STATE_ROOT: options.stateRoot }
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
});

test('installer preserves unrelated hooks and is idempotent', t => {
  const options = fixture(t);
  const existing = {
    custom: { keep: true },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: '/usr/bin/true' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/usr/bin/existing' }] }]
    }
  };
  fs.writeFileSync(options.hooksPath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
  const plan = planNotificationAckHook(options);
  assert.equal(plan.changed, true);
  assert.equal(plan.action, 'apply');
  const applied = applyNotificationAckHook(options);
  assert.equal(applied.state, 'applied');
  const document = JSON.parse(fs.readFileSync(options.hooksPath, 'utf8'));
  assert.deepEqual(document.custom, existing.custom);
  assert.deepEqual(document.hooks.Stop, existing.hooks.Stop);
  assert.deepEqual(document.hooks.UserPromptSubmit[0], existing.hooks.UserPromptSubmit[0]);
  assert.equal(document.hooks.UserPromptSubmit.length, 2);
  assert.equal(document.hooks.UserPromptSubmit[1].hooks[0].command, notificationAckHookCommand(options));
  assert.equal(document.hooks.UserPromptSubmit[1].hooks[0].commandWindows, notificationAckHookWindowsCommand(options));
  const secondPlan = planNotificationAckHook(options);
  assert.equal(secondPlan.changed, false);
  assert.equal(applyNotificationAckHook(options).state, 'unchanged');
  assert.equal(JSON.parse(fs.readFileSync(options.hooksPath, 'utf8')).hooks.UserPromptSubmit.length, 2);
});

test('installer upgrades the legacy POSIX command to the Windows-safe command in place', t => {
  const options = fixture(t);
  if (process.platform !== 'win32') {
    t.skip('legacy Windows quoting upgrade is Windows-specific');
    return;
  }
  const legacyCommand = notificationAckHookCommand({ ...options, platform: 'linux' });
  const windowsCommand = notificationAckHookWindowsCommand(options);
  assert.notEqual(legacyCommand, windowsCommand);
  const legacy = {
    hooks: {
      UserPromptSubmit: [{ hooks: [{
        type: 'command',
        command: legacyCommand,
        commandWindows: windowsCommand,
        timeout: 5
      }] }]
    }
  };
  fs.writeFileSync(options.hooksPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
  const plan = planNotificationAckHook(options);
  assert.equal(plan.changed, true);
  applyNotificationAckHook(options);
  const hooks = JSON.parse(fs.readFileSync(options.hooksPath, 'utf8')).hooks.UserPromptSubmit;
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].hooks[0].command, windowsCommand);
  assert.equal(hooks[0].hooks[0].commandWindows, windowsCommand);
});

test('Windows hook command executes through the actual PowerShell hook shell', () => {
  if (process.platform !== 'win32') return;
  const command = notificationAckHookWindowsCommand({ nodeBinary: process.execPath, hookFile });
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'ignored' }),
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('rollback restores exact bytes and original mode', t => {
  const options = fixture(t);
  const before = Buffer.from('{\n  "hooks": {"Stop": []},\n  "spacing": "preserve me"\n}\n');
  fs.writeFileSync(options.hooksPath, before, { mode: 0o600 });
  fs.chmodSync(options.hooksPath, 0o600);
  applyNotificationAckHook(options);
  assert.notDeepEqual(fs.readFileSync(options.hooksPath), before);
  const result = rollbackNotificationAckHook(options);
  assert.equal(result.state, 'rolled_back');
  assert.deepEqual(fs.readFileSync(options.hooksPath), before);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(options.hooksPath).mode & 0o777, 0o600);
  }
});

test('installer rejects symlink and unsafe hooks permissions without mutation', t => {
  const options = fixture(t);
  const outside = path.join(options.home, 'outside.json');
  const before = Buffer.from('{"hooks":{}}\n');
  fs.writeFileSync(outside, before, { mode: 0o600 });
  fs.symlinkSync(outside, options.hooksPath);
  assert.throws(() => planNotificationAckHook(options), /hooks_config_unsafe_path/);
  assert.deepEqual(fs.readFileSync(outside), before);
  fs.rmSync(options.hooksPath);
  fs.writeFileSync(options.hooksPath, before, { mode: 0o644 });
  fs.chmodSync(options.hooksPath, 0o644);
  if (process.platform !== 'win32') {
    assert.throws(() => planNotificationAckHook(options), /hooks_config_unsafe_permissions/);
  }
  assert.deepEqual(fs.readFileSync(options.hooksPath), before);
});

test('rollback refuses to erase unrelated post-apply changes', t => {
  const options = fixture(t);
  fs.writeFileSync(options.hooksPath, '{"hooks":{}}\n', { mode: 0o600 });
  applyNotificationAckHook(options);
  const current = JSON.parse(fs.readFileSync(options.hooksPath, 'utf8'));
  current.unrelatedAfterApply = true;
  fs.writeFileSync(options.hooksPath, `${JSON.stringify(current)}\n`, { mode: 0o600 });
  assert.throws(() => rollbackNotificationAckHook(options), /rollback_precondition_failed/);
  assert.equal(JSON.parse(fs.readFileSync(options.hooksPath, 'utf8')).unrelatedAfterApply, true);
});
