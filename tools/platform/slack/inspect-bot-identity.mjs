#!/usr/bin/env node
import process from 'node:process';
import { inspectSlackBotIdentity } from '../../../src/slack-bot-transport.mjs';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

try {
  const result = await inspectSlackBotIdentity({
    keychainService: arg('--service'),
    keychainAccount: arg('--account')
  }, arg('--team'));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.code ?? 'slack_bot_identity_failed' })}\n`);
  process.exitCode = 1;
}
