#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { armForegroundCodexRescueGuardian, runForegroundCodexRescueGuardian } from '../../../src/codex-foreground-rescue-guardian.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function required(name) {
  const value = String(option(name) ?? '').trim();
  if (!value) throw new Error(`missing_option:${name}`);
  return value;
}

async function main() {
  const plan = option('--plan');
  if (plan) {
    const result = await runForegroundCodexRescueGuardian(plan);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const result = armForegroundCodexRescueGuardian({
    projectRoot: required('--project-root'),
    projectKey: option('--project-key') ?? 'ai-platform',
    taskId: required('--task'),
    operationId: required('--operation'),
    operationResultFile: required('--operation-result'),
    expectedDesktopPid: required('--desktop-pid'),
    expectedWorkerPid: option('--worker-pid') ?? undefined,
    manifestFile: required('--manifest'),
    callbackCodexExecutable: option('--callback-codex') ?? undefined,
    controlSocket: option('--control-socket') ?? undefined,
    callbackRetryMs: option('--callback-retry-ms') ?? undefined,
    taskIdleGraceMs: option('--task-idle-grace-ms') ?? undefined,
    externalConversationUrl: option('--web-gpt-conversation') ?? undefined,
    launch: !process.argv.includes('--no-launch')
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`HOLD: ${error.code ?? error.message}\n`);
    process.exitCode = 1;
  });
}
