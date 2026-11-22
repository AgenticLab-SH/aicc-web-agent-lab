import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractRoot = path.join(root, 'contracts');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

test('public contracts are portable draft 2020-12 schemas', () => {
  const schemas = walk(contractRoot).filter(file => file.endsWith('.schema.json'));
  const intentionallyClosed = new Set([
    'contracts/control-report.schema.json',
    'contracts/assets/chatgpt-archive-catalog.schema.json',
    'contracts/assets/workspace-plugin-inventory.schema.json',
    'contracts/remote/codex-session-index.schema.json',
    'contracts/remote/oob-adapter.schema.json',
    'contracts/remote/local-source-grant.schema.json'
  ]);
  assert.equal(schemas.length, 38);
  for (const file of schemas) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    const schema = JSON.parse(text);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', relative);
    assert.equal(schema.type, 'object', relative);
    assert.equal(
      schema.additionalProperties,
      intentionallyClosed.has(relative) ? false : true,
      intentionallyClosed.has(relative)
        ? `${relative} must reject undeclared sensitive fields`
        : `${relative} must preserve future root fields`
    );
    assert.doesNotMatch(text, /\/(?:Users|home)\/[A-Za-z0-9._-]+/);
    assert.doesNotMatch(text, /(?:cookie|password|refreshToken|apiKey)\s*[=:]\s*["'][^"']+/i);
  }
});

test('public contracts preserve the four independent route and state boundaries', () => {
  const router = JSON.parse(fs.readFileSync(path.join(contractRoot, 'codex-responses/router-contract.schema.json'), 'utf8'));
  const adapter = JSON.parse(fs.readFileSync(path.join(contractRoot, 'model-adapter/capability.schema.json'), 'utf8'));
  const privateState = JSON.parse(fs.readFileSync(path.join(contractRoot, 'private-state/inventory.schema.json'), 'utf8'));
  const orchestration = JSON.parse(fs.readFileSync(path.join(contractRoot, 'orchestration/run.schema.json'), 'utf8'));
  assert.equal(router.properties.routing.properties.silentFallback.const, false);
  assert.deepEqual(adapter.properties.protocol.enum, ['openai-responses', 'anthropic-messages']);
  assert.ok(privateState.required.includes('entries'));
  assert.ok(orchestration.required.includes('capabilitySnapshotHash'));
});
