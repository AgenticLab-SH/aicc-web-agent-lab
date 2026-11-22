#!/usr/bin/env node
import { enqueueCodexCompletionToWebGpt } from '../../../src/codex-to-web-gpt-followup.mjs';

const FIELDS = Object.freeze({
  '--watch': 'watchId',
  '--origin-task': 'originTaskId',
  '--conversation-url': 'conversationUrl',
  '--codex-session': 'codexSessionId',
  '--operation': 'operationId',
  '--request-id': 'requestId',
  '--result-file': 'resultFile',
  '--sha256': 'expectedResultSha256',
  '--project-root': 'expectedProjectRoot'
});

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = FIELDS[argv[i]];
    const value = argv[i + 1];
    if (!key || !value || value.startsWith('--') || args[key] !== undefined) {
      throw Object.assign(new Error('invalid arguments'), { code: 'options_invalid' });
    }
    args[key] = value;
  }
  for (const key of Object.values(FIELDS).filter(name => name !== 'expectedProjectRoot')) {
    if (!args[key]) throw Object.assign(new Error('missing required option'), { code: 'options_missing' });
  }
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = await enqueueCodexCompletionToWebGpt(args);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error?.code ?? 'UNEXPECTED_ERROR' }));
  process.exitCode = 1;
}
