import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { strictResumeArguments, runStrictResume } from '../src/codex-strict-continuity-bridge.mjs';

const input = { selector: 'opaque-fixture', threadId: '11111111-1111-4111-8111-111111111111',
  cwd: path.resolve('fixture-work'), prompt: 'Continue existing approved work; no replay.' };

test('strict bridge pins one selector, original thread, model and OCX invocation; never checkpoint', () => {
  const args = strictResumeArguments(input);
  assert.deepEqual(args.slice(0, 6), ['--route-account', input.selector, '--route-model', 'gpt-6.1-sol', '--route-effort', 'high']);
  assert.deepEqual(args.slice(-5), ['exec', 'resume', input.threadId, '--json', input.prompt]);
  assert.equal(args.includes('--handoff-checkpoint'), false);
  assert.equal(args.includes('--prefer-account'), false);
  assert.equal(args.includes('17841'), false);
});

test('strict bridge rejects changed exact original or unsafe selector', () => {
  assert.throws(() => strictResumeArguments({ ...input, threadId: 'new-thread' }), /exact_original_thread/);
  assert.throws(() => strictResumeArguments({ ...input, selector: 'other/selected' }), /strict_owner_selector/);
  assert.throws(() => strictResumeArguments({ ...input, selector: '__proto__' }), /strict_owner_selector/);
  assert.throws(() => strictResumeArguments({ ...input, cwd: 'not-absolute' }), /exact_original_thread/);
});

test('strict bridge refuses empty or oversized payload without launching', () => {
  assert.throws(() => strictResumeArguments({ ...input, prompt: '' }), /bounded_existing_work/);
  assert.throws(() => strictResumeArguments({ ...input, prompt: 'x'.repeat(12001) }), /bounded_existing_work/);

});

test('one-shot bridge checks pinned executable and calls official OCX launch once without fallback', async () => {
  const executable = fileURLToPath(import.meta.url);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  let calls = 0;
  const fakeLaunch = async (route, args, options) => {
    calls += 1;
    assert.equal(route, 'ocx');
    assert.deepEqual(args, strictResumeArguments(input));
    assert.equal(options.executable, executable);
    assert.equal(options.env.AICC_CODEX_CHECKPOINT_ATTEMPT, undefined);
    return { exitCode: 0 };
  };
  assert.equal(await runStrictResume({ ...input, executable, executableSha256: sha }, fakeLaunch), 0);
  assert.equal(calls, 1);
  await assert.rejects(runStrictResume({ ...input, executable, executableSha256: '0'.repeat(64) }, fakeLaunch),
    /pinned_codex_hash_mismatch/);
  assert.equal(calls, 1);
});
