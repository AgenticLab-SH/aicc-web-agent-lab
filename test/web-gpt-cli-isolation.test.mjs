import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('Web GPT status CLI probes its own adapter rather than the full AICC status graph', () => {
  const file = new URL('../src/cli.mjs', import.meta.url);
  const cli = fs.readFileSync(file, 'utf8');
  const command = cli.match(/if \(command === 'web-gpt'\) \{([\s\S]*?)if \(subcommand === 'doctor'\) \{/);
  assert.ok(command, 'Web GPT status branch must be identifiable');
  const status = command[1].match(/if \(subcommand === 'status'\) \{([\s\S]*?)return;\s*\}/);
  assert.ok(status, 'Dedicated status branch must exist');
  assert.match(status[1], /await webGptStatus\(\)/);
  assert.doesNotMatch(status[1], /collectStatus\(/);
});
