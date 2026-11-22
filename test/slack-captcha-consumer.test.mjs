import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeSlackCaptchaIntoCurrentTask } from '../src/notifications/slack-captcha-consumer.mjs';

const binding = Object.freeze({
  requestId: '12345678-1234-4234-8234-123456789abc',
  projectKey: 'open-AICC',
  taskId: 'codex-task-42',
  challengeRevision: 'rev-7',
  bindingHash: 'a'.repeat(64)
});

test('current task consumes through an in-process CUA callback without returning the value', async () => {
  let received;
  let consumeCalls = 0;
  const result = await consumeSlackCaptchaIntoCurrentTask({
    state: { consume: async (actualBinding, useValue, options) => {
      consumeCalls += 1;
      assert.equal(actualBinding, binding);
      assert.equal(typeof options.deleteSlackFile, 'function');
      await useValue('A9b2');
      return { ok: true, state: 'consumed_and_purged', slackFileDeleted: true };
    } },
    binding,
    currentTaskId: binding.taskId,
    typeIntoCurrentChallenge: async value => { received = value; },
    deleteSlackFile: async () => {}
  });
  assert.equal(received, 'A9b2');
  assert.equal(consumeCalls, 1);
  assert.deepEqual(result, { ok: true, state: 'consumed_and_purged', slackFileDeleted: true, taskId: binding.taskId });
  assert.doesNotMatch(JSON.stringify(result), /A9b2/);
});

test('task mismatch is rejected before state is touched', async () => {
  let consumeCalls = 0;
  await assert.rejects(consumeSlackCaptchaIntoCurrentTask({
    state: { consume: async () => { consumeCalls += 1; } },
    binding,
    currentTaskId: 'different-task',
    typeIntoCurrentChallenge: async () => {}
  }), /captcha_current_task_binding_mismatch/);
  assert.equal(consumeCalls, 0);
});

test('consumer requires an in-process CUA input callback', async () => {
  await assert.rejects(consumeSlackCaptchaIntoCurrentTask({
    state: { consume: async () => {} }, binding, currentTaskId: binding.taskId
  }), /captcha_cua_input_callback_required/);
});
