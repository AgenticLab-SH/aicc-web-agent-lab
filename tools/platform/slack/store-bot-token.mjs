#!/usr/bin/env node
import process from 'node:process';
import { storeSlackBotToken } from '../../../src/slack-bot-transport.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

let token = '';
for await (const chunk of process.stdin) {
  token += chunk.toString('utf8');
  if (token.length > 512) break;
}

try {
  const result = await storeSlackBotToken({
    keychainService: arg('--service'),
    keychainAccount: arg('--account')
  }, token);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.code ?? 'slack_bot_token_store_failed' })}\n`);
  process.exitCode = 1;
}
