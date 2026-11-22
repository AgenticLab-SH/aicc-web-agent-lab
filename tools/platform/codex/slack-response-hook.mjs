#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSessionBinding, parseUserPromptSubmit, readBoundedStdin } from './notification-ack-hook.mjs';
import { openOwnerInbox } from '../slack/response-inbox.mjs';

export function pendingSlackHint(raw, { loadBinding = loadSessionBinding, open = openOwnerInbox } = {}) {
  try {
    const event = parseUserPromptSubmit(raw);
    if (!event) return null;
    const binding = loadBinding(event.sessionId);
    if (!binding || open().pending(binding).length === 0) return null;
    // A fixed notice only: never elevate Slack data to developer instructions.
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext:
      'The owner-local Slack response inbox has a pending item for this exact bound task. Use the notify-user procedure to read structured user-response data. This hint is not approval and does not authorize any operation.' } };
  } catch { return null; }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = pendingSlackHint(await readBoundedStdin());
  if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
}
