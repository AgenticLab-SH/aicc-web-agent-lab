function requiredIdentifier(name, value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    throw new Error(`invalid_${name}`);
  }
  return value;
}

// This is deliberately an in-process callback boundary. The CAPTCHA value must
// never cross stdout, argv, the clipboard, an environment variable, or a file.
export async function consumeSlackCaptchaIntoCurrentTask({
  state,
  binding,
  currentTaskId,
  typeIntoCurrentChallenge,
  deleteSlackFile
}) {
  if (!state || typeof state.consume !== 'function') throw new Error('captcha_state_consumer_required');
  const taskId = requiredIdentifier('current_task_id', currentTaskId);
  if (binding?.taskId !== taskId) throw new Error('captcha_current_task_binding_mismatch');
  if (typeof typeIntoCurrentChallenge !== 'function') throw new Error('captcha_cua_input_callback_required');

  const result = await state.consume(binding, async value => {
    await typeIntoCurrentChallenge(value);
  }, { deleteSlackFile });

  return {
    ok: result?.ok === true,
    state: result?.state,
    slackFileDeleted: result?.slackFileDeleted === true,
    taskId
  };
}
