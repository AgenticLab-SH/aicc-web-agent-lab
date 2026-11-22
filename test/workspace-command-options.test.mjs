import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkspaceSubcommandOptions } from '../src/workspace-command-options.mjs';

test('workspace configure requires an explicit failure-domain surface', () => {
  assert.throws(() => parseWorkspaceSubcommandOptions('configure', []), /requires --surface/);
  assert.equal(parseWorkspaceSubcommandOptions('configure', ['--surface', 'business-full']).surfaceProfile, 'business-full');
  assert.equal(parseWorkspaceSubcommandOptions('configure', ['--personal-read-fetch']).surfaceProfile, 'personal-read-fetch');
});

test('workspace configure accepts the explicit owner-unrestricted Windows command flag only for configuration', () => {
  const parsed = parseWorkspaceSubcommandOptions('configure', ['--surface', 'business-full', '--unrestricted-windows-commands']);
  assert.equal(parsed.unrestrictedWindowsCommands, true);
  assert.throws(() => parseWorkspaceSubcommandOptions('status', ['--surface', 'business-full', '--unrestricted-windows-commands']), /unknown/);
});

test('workspace options fail closed for unknown, duplicate and conflicting surfaces', () => {
  assert.throws(() => parseWorkspaceSubcommandOptions('status', ['--unknown']), /unknown/);
  assert.throws(() => parseWorkspaceSubcommandOptions('status', ['--json', '--json']), /duplicate/);
  assert.throws(() => parseWorkspaceSubcommandOptions('status', ['--surface', 'business-full', '--personal-read-fetch']), /conflicting/);
  assert.throws(() => parseWorkspaceSubcommandOptions('status', ['--surface', 'other']), /must be/);
});

test('workspace help wins before malformed options', () => {
  assert.equal(parseWorkspaceSubcommandOptions('configure', ['--unknown', '--help']).help, true);
});

test('local configuration requires an explicit surface and bounded alias selections', () => {
  assert.throws(() => parseWorkspaceSubcommandOptions('configure-local', []), /requires --surface/);
  assert.throws(() => parseWorkspaceSubcommandOptions('configure-local', ['--surface', 'business-full', '--alias']), /Invalid/);
  assert.throws(() => parseWorkspaceSubcommandOptions('configure-local', ['--surface', 'business-full', '--alias', 'one', '--alias', 'one']), /duplicate/);
  assert.throws(() => parseWorkspaceSubcommandOptions('configure-local', ['--surface', 'business-full', '--owner-unrestricted-write']), /unknown/);
  assert.throws(() => parseWorkspaceSubcommandOptions('configure', ['--surface', 'business-full', '--local']), /unknown/);
  const parsed = parseWorkspaceSubcommandOptions('configure-local', ['--surface', 'business-full', '--source-surface', 'personal-read-fetch', '--alias', 'one', '--alias', 'two', '--dry-run', '--repair']);
  assert.deepEqual(parsed.aliases, ['one', 'two']);
  assert.equal(parsed.sourceSurface, 'personal-read-fetch');
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.repair, true);
  assert.equal(parseWorkspaceSubcommandOptions('doctor', ['--local', '--surface', 'personal-read-fetch']).local, true);
});
