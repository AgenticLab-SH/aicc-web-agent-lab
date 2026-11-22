#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSlackResponseInbox } from '../../../src/notifications/slack-response-inbox.mjs';

export function openOwnerInbox(stateRoot = process.env.AICC_STATE_ROOT || path.join(os.homedir(), '.ai-control-center')) {
  const config = JSON.parse(fs.readFileSync(path.join(stateRoot, 'notifications', 'slack-alerts.json'), 'utf8'));
  return createSlackResponseInbox({ root: path.join(stateRoot, 'notifications', 'slack-responses'),
    identity: { ...config, userId: config.recipientUserId } });
}

export async function runInboxCommand(args, input, { open = openOwnerInbox } = {}) {
  const command = args[0] ?? 'status';
  if (command === '--help') return { commands: ['status', 'pending', 'acknowledge', 'cancel'],
    input: 'pending: projectKey/taskId; acknowledge: add requestId/responseId/operationHash; cancel: add requestId',
    note: 'JSON on stdin. No network, wakeup, command execution, or native permission approval.' };
  if (!['status', 'pending', 'acknowledge', 'cancel'].includes(command)) throw new Error('unsupported_inbox_command');
  let inbox;
  try { inbox = open(); }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'not_configured', desktopAutoWake: false };
    throw error;
  }
  if (command === 'status') return inbox.status();
  const payload = JSON.parse(input);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid_inbox_input');
  return inbox[command](payload);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    let input = '';
    if (!['status', '--help', undefined].includes(process.argv[2])) {
      for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input) > 4096) throw new Error('inbox_input_too_large');
      }
    }
    process.stdout.write(`${JSON.stringify(await runInboxCommand(process.argv.slice(2), input))}\n`);
  } catch {
    process.stderr.write('{"ok":false,"state":"inbox_hold"}\n');
    process.exitCode = 1;
  }
}
