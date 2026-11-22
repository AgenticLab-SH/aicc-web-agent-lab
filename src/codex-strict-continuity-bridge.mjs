// One-shot, owner-pinned continuity adapter. Never a checkpoint handoff or pool fallback.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { launchCodexCli } from './codex-cli-routes.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;

export function strictResumeArguments({ selector, threadId, cwd, prompt }) {
  if (!SELECTOR.test(selector ?? '') || ['__proto__', 'prototype', 'constructor'].includes(selector?.toLowerCase()))
    throw Error('strict_owner_selector_required');
  if (!UUID.test(threadId ?? '') || !path.isAbsolute(cwd ?? '')) throw Error('exact_original_thread_and_root_required');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000 || prompt.includes('\0'))
    throw Error('bounded_existing_work_prompt_required');
  return ['--route-account', selector, '--route-model', 'gpt-6.1-sol', '--route-effort', 'high',
    '-C', cwd, '-a', 'never', '-s', 'danger-full-access', 'exec', 'resume', threadId, '--json', prompt];
}

export async function runStrictResume({ selector, threadId, cwd, executable, executableSha256, prompt }, launch = launchCodexCli) {
  if (!path.isAbsolute(executable ?? '') || !HASH.test(executableSha256 ?? '')) throw Error('pinned_codex_executable_required');
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('pinned_codex_file_unsafe');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
  if (actual !== executableSha256) throw Error('pinned_codex_hash_mismatch');
  const env = { ...process.env };
  for (const key of ['AICC_CODEX_CHECKPOINT_ATTEMPT', 'AICC_CODEX_CHECKPOINT_DRAFT', 'AICC_CODEX_CHECKPOINT_OPERATION']) delete env[key];
  const result = await launch('ocx', strictResumeArguments({ selector, threadId, cwd, prompt }), { executable, env });
  if (!Number.isInteger(result?.exitCode) || result.exitCode < 0) throw Error('strict_route_terminal_unknown');
  return result.exitCode;
}

// Caller pins this bridge and the official route module before launch.
// Positional input comes from ProcessStartInfo.ArgumentList, never a shell.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 8) throw Error('strict_exact_six_arguments_required');
  const [selector, threadId, cwd, executable, executableSha256, prompt] = process.argv.slice(2);
  try { process.exitCode = await runStrictResume({ selector, threadId, cwd, executable, executableSha256, prompt }); }
  catch (error) {
    console.error('strict_continuity_launch_refused:' + String(error?.message ?? error).slice(0, 100));
    process.exitCode = 1;
  }
}
