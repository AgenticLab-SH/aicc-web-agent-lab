import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CodexTaskCallbackService } from '../codex-task-callback.mjs';
import { ensureWindowsOwnerOnlyDirectory, protectWindowsOwnerOnlyPath } from '../lib/windows-owner-only-acl.mjs';

const RETRYABLE = new Set([
  'callback_thread_active',
  'callback_destination_writer_busy',
  'callback_turn_still_active',
  'callback_writer_busy'
]);

function ensurePrivateDirectory(directory) {
  if (process.platform === 'win32') {
    ensureWindowsOwnerOnlyDirectory(directory);
    return;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('captcha_wake_directory_unsafe');
  fs.chmodSync(directory, 0o700);
}

function atomicPrivateJson(file, value) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  if (process.platform === 'win32') protectWindowsOwnerOnlyPath(file, { directory: false });
  else fs.chmodSync(file, 0o600);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function armSlackCaptchaWake({
  state,
  request,
  projectRoot,
  manifestFile,
  codexExecutable,
  resultRoot,
  callbackService = new CodexTaskCallbackService()
}) {
  if (!state?.bindWake || !request?.requestId) throw new Error('captcha_wake_state_required');
  const operationId = `slack-captcha:${request.requestId}`;
  const directory = path.join(path.resolve(resultRoot), request.requestId);
  ensurePrivateDirectory(directory);
  const resultFile = path.join(directory, 'result.json');
  if (fs.existsSync(resultFile)) throw new Error('captcha_wake_result_preexists');
  const armed = callbackService.arm({
    projectKey: request.projectKey,
    taskId: request.taskId,
    projectRoot,
    operationId,
    resultFile,
    manifestFile,
    codexExecutable,
    terminalStatuses: ['PASS', 'HOLD'],
    expiresAt: request.expiresAt
  });
  state.bindWake(request.requestId, { callbackId: armed.callbackId, operationId });
  return Object.freeze({
    ok: true,
    state: 'wake_armed',
    requestId: request.requestId,
    callbackId: armed.callbackId,
    operationId,
    resultFile,
    expiresAt: armed.expiresAt
  });
}

export async function completeSlackCaptchaWake({
  state,
  wake,
  callbackService = new CodexTaskCallbackService(),
  now = () => Date.now(),
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  retryMs = 1_000,
  callbackTimeoutMs = 60_000
}) {
  const inspected = state.inspect(wake.requestId);
  if (inspected.state !== 'answer_ready' || inspected.liveAutoWake !== true) throw new Error('captcha_answer_not_ready');
  const binding = callbackService.inspect({ callbackId: wake.callbackId });
  if (binding.operationId !== wake.operationId || binding.taskId !== inspected.taskId) throw new Error('captcha_wake_binding_mismatch');
  if (Date.parse(binding.expiresAt) !== Date.parse(wake.expiresAt)) throw new Error('captcha_wake_expiry_mismatch');
  if (!fs.existsSync(binding.resultFile)) {
    atomicPrivateJson(binding.resultFile, {
      operation: binding.operationId,
      status: 'PASS',
      completedAt: new Date(now()).toISOString(),
      captcha: {
        requestId: wake.requestId,
        state: 'answer_ready',
        authorization: 'exact_challenge_entry_and_submit'
      }
    });
  }
  const digest = sha256File(binding.resultFile);
  const deadline = Date.parse(binding.expiresAt);
  for (;;) {
    try {
      return await callbackService.complete({
        callbackId: binding.callbackId,
        expectedResultSha256: digest,
        timeoutMs: callbackTimeoutMs
      });
    } catch (error) {
      if (!RETRYABLE.has(error?.code) || now() + retryMs >= deadline) throw error;
      await sleep(retryMs);
    }
  }
}
