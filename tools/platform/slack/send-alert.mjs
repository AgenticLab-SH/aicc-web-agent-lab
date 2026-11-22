#!/usr/bin/env node
import process from 'node:process';
import { sendNotification } from '../../../src/notification-command.mjs';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk.toString('utf8');
  if (input.length > 16_384) break;
}

try {
  const event = JSON.parse(input);
  const result = await sendNotification(event);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.code ?? 'slack_alert_failed', details: error.details ?? {} })}\n`);
  process.exitCode = 1;
}
