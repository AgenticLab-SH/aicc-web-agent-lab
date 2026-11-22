import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('AICC Alerts manifest enables only the CAPTCHA response capabilities', () => {
  const manifest = fs.readFileSync(path.join(root, 'guidance', 'config', 'slack-alerts-app-manifest.yaml'), 'utf8');
  assert.match(manifest, /^\s+- chat:write\s*$/m);
  assert.match(manifest, /^\s+- files:write\s*$/m);
  assert.match(manifest, /^\s+- im:history\s*$/m);
  assert.match(manifest, /^\s+- message\.im\s*$/m);
  assert.match(manifest, /^\s+messages_tab_read_only_enabled: false\s*$/m);
  assert.match(manifest, /^\s+socket_mode_enabled: true\s*$/m);
  assert.match(manifest, /^\s+interactivity:\s*\r?\n\s+is_enabled: true\s*$/m);
  assert.doesNotMatch(manifest, /channels:history|groups:history|mpim:history|incoming-webhook|^\s+user:\s*$/m);
  const scopes = [...manifest.matchAll(/^\s+- ([a-z.:-]+)\s*$/gm)].map(match => match[1]);
  assert.deepEqual(scopes, ['chat:write', 'files:write', 'im:history', 'message.im']);
});
