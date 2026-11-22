#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument near ${key ?? '<end>'}`);
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

function isWithin(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sortedStrings(values) {
  return [...(values ?? [])].map(String).sort();
}

function assertSame(actual, expected, label) {
  const left = sortedStrings(actual);
  const right = sortedStrings(expected);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} mismatch: manifest=${left.join(',')} definition=${right.join(',')}`);
  }
}

function normalizeRemote(value) {
  return String(value ?? '').trim().replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
}

async function git(root, ...args) {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { windowsHide: true, maxBuffer: 1_048_576 });
  return stdout.trim();
}

async function inspectPinnedSource(sourceRoot, expectedHead, expectedRemote) {
  if (!path.isAbsolute(sourceRoot)) throw new Error('Trusted source root must be an exact absolute path');
  const resolved = path.resolve(sourceRoot);
  const real = await fs.realpath(resolved);
  if (path.resolve(real) !== resolved || (await fs.lstat(resolved)).isSymbolicLink()) {
    throw new Error(`Trusted source root must not use a symlink or junction: ${resolved}`);
  }
  await fs.access(path.join(resolved, 'manifest.json'));
  if (!/^[a-f0-9]{40}$/i.test(expectedHead ?? '')) throw new Error('TrustRoot requires an exact 40-character ExpectedGitHead');
  if (!expectedRemote) throw new Error('TrustRoot requires ExpectedGitRemote');
  const topLevel = path.resolve(await git(resolved, 'rev-parse', '--show-toplevel'));
  if (topLevel !== resolved) throw new Error(`Trusted source must be the exact Git worktree root: ${resolved}`);
  const actualHead = await git(resolved, 'rev-parse', 'HEAD');
  if (actualHead.toLowerCase() !== expectedHead.toLowerCase()) throw new Error(`Git HEAD mismatch: actual=${actualHead} expected=${expectedHead}`);
  const actualRemote = await git(resolved, 'remote', 'get-url', 'origin');
  if (normalizeRemote(actualRemote) !== normalizeRemote(expectedRemote)) {
    throw new Error(`Git remote mismatch: actual=${actualRemote} expected=${expectedRemote}`);
  }
  if (await git(resolved, 'status', '--porcelain=v1')) throw new Error('Trusted extension source must have a clean Git worktree');
  return { path: resolved, git_head: actualHead.toLowerCase(), git_remote: actualRemote };
}

async function assertPinnedRootCurrent(registry, root) {
  const evidence = (registry.trusted_root_evidence ?? []).find(item => path.resolve(item.path) === path.resolve(root));
  if (evidence) await inspectPinnedSource(root, evidence.git_head, evidence.git_remote);
}

async function assertRegisteredEntriesMatchSource(registry, sourceRoot) {
  for (const entry of registry.extensions.filter(item => isWithin(item.path, sourceRoot))) {
    const manifest = JSON.parse(await fs.readFile(path.join(entry.path, 'manifest.json'), 'utf8'));
    if (manifest.name !== entry.manifest_name || manifest.manifest_version !== entry.manifest_version) {
      throw new Error(`Registered manifest identity drift for ${entry.key}`);
    }
    assertSame(manifest.permissions, entry.allowed_permissions, `${entry.key} permissions`);
    const contentMatches = (manifest.content_scripts ?? []).flatMap(script => script.matches ?? []);
    if (entry.forbid_host_permissions) {
      if ((manifest.host_permissions?.length ?? 0) > 0
          || (manifest.optional_host_permissions?.length ?? 0) > 0
          || contentMatches.length > 0) {
        throw new Error(`Registered host scope drift for ${entry.key}`);
      }
    } else {
      assertSame(manifest.host_permissions, entry.allowed_host_permissions, `${entry.key} host_permissions`);
      assertSame(manifest.optional_host_permissions, entry.allowed_optional_host_permissions, `${entry.key} optional_host_permissions`);
      assertSame(contentMatches, entry.allowed_content_script_matches, `${entry.key} content_script matches`);
    }
  }
}

function validateOptions(options = {}) {
  const booleanKeys = ['enabled', 'incognito_access', 'file_access', 'error_collection', 'show_access_requests_in_toolbar'];
  const allowedKeys = new Set([...booleanKeys, 'host_access']);
  for (const key of Object.keys(options)) {
    if (!allowedKeys.has(key)) throw new Error(`Unsupported extension option: ${key}`);
  }
  for (const key of booleanKeys) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  }
  if (options.host_access !== undefined && !['ON_CLICK', 'ON_SPECIFIC_SITES', 'ON_ALL_SITES'].includes(options.host_access)) {
    throw new Error('host_access must be ON_CLICK, ON_SPECIFIC_SITES, or ON_ALL_SITES');
  }
}

async function buildEntry(registry, definitionPath, expectedKey) {
  const definition = JSON.parse(await fs.readFile(definitionPath, 'utf8'));
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(definition.key ?? '')) throw new Error('Definition key must be lowercase kebab-case');
  if (definition.key !== expectedKey) throw new Error(`Definition key ${definition.key} does not match target ${expectedKey}`);
  if (!Array.isArray(definition.slots) || definition.slots.length === 0
      || definition.slots.some(slot => !['9222', '9223', '9224', '9225'].includes(String(slot)))) {
    throw new Error('Definition slots must be a non-empty subset of 9222-9225');
  }
  const extensionPath = path.resolve(definition.path ?? '');
  const trustedRoot = registry.trusted_roots
    .filter(root => isWithin(extensionPath, root))
    .sort((left, right) => path.resolve(right).length - path.resolve(left).length)[0];
  if (!trustedRoot) throw new Error(`Extension path is outside registry trusted roots: ${extensionPath}`);
  await assertPinnedRootCurrent(registry, trustedRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
  if (![2, 3].includes(manifest.manifest_version)) throw new Error('Only manifest v2 or v3 extensions can be registered');
  if (!Array.isArray(definition.allowed_permissions)) throw new Error('Definition must explicitly list allowed_permissions');
  assertSame(manifest.permissions, definition.allowed_permissions, 'permissions');
  const actualContentMatches = (manifest.content_scripts ?? []).flatMap(script => script.matches ?? []);
  const hasHostScope = (manifest.host_permissions?.length ?? 0) > 0
    || (manifest.optional_host_permissions?.length ?? 0) > 0
    || actualContentMatches.length > 0;
  const forbidHostPermissions = definition.forbid_host_permissions === true || !hasHostScope;
  if (forbidHostPermissions) {
    if (hasHostScope) throw new Error('forbid_host_permissions conflicts with manifest host or content-script scope');
  } else {
    if (!Array.isArray(definition.allowed_host_permissions)
        || !Array.isArray(definition.allowed_optional_host_permissions)
        || !Array.isArray(definition.allowed_content_script_matches)) {
      throw new Error('Definitions with host scope must explicitly list all host and content-script allowlists');
    }
    assertSame(manifest.host_permissions, definition.allowed_host_permissions, 'host_permissions');
    assertSame(manifest.optional_host_permissions, definition.allowed_optional_host_permissions, 'optional_host_permissions');
    assertSame(actualContentMatches, definition.allowed_content_script_matches, 'content_script matches');
  }
  validateOptions(definition.options);
  if (typeof definition.pin_to_toolbar !== 'boolean') throw new Error('pin_to_toolbar must be boolean');
  if (definition.storage !== undefined && (typeof definition.storage !== 'object' || Array.isArray(definition.storage))) {
    throw new Error('storage must be an object');
  }
  return {
    key: definition.key,
    path: extensionPath,
    manifest_name: manifest.name,
    manifest_version: manifest.manifest_version,
    allowed_permissions: sortedStrings(definition.allowed_permissions),
    ...(forbidHostPermissions ? {} : {
      allowed_host_permissions: sortedStrings(definition.allowed_host_permissions),
      allowed_optional_host_permissions: sortedStrings(definition.allowed_optional_host_permissions),
      allowed_content_script_matches: sortedStrings(definition.allowed_content_script_matches)
    }),
    forbid_host_permissions: forbidHostPermissions,
    pin_to_toolbar: definition.pin_to_toolbar,
    options: definition.options ?? {},
    storage: definition.storage ?? {},
    verify: definition.verify ?? {},
    slots: [...new Set(definition.slots.map(String))].sort()
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = String(args.action ?? '').toLowerCase();
  const registryPath = path.resolve(args.registry ?? '');
  const key = String(args.key ?? '');
  const dryRun = args['dry-run'] === 'true';
  const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  if (registry.schema_version !== 1 || !Array.isArray(registry.trusted_roots) || !Array.isArray(registry.extensions)) {
    throw new Error('Unsupported extension registry schema');
  }
  registry.trusted_root_evidence ??= [];
  let change;
  if (action === 'list') {
    process.stdout.write(`${JSON.stringify({ ok: true, action, registry: registryPath, trusted_roots: registry.trusted_roots, trusted_root_evidence: registry.trusted_root_evidence, extensions: registry.extensions })}\n`);
    return;
  }
  if (action === 'trust-root') {
    const evidence = await inspectPinnedSource(path.resolve(args['source-root'] ?? ''), args['expected-head'], args['expected-remote']);
    if (registry.trusted_roots.some(root => path.resolve(root) === evidence.path)) throw new Error(`Trusted root already exists: ${evidence.path}`);
    registry.trusted_roots.push(evidence.path);
    registry.trusted_roots.sort((left, right) => left.localeCompare(right));
    registry.trusted_root_evidence.push(evidence);
    registry.trusted_root_evidence.sort((left, right) => left.path.localeCompare(right.path));
    change = { operation: 'add_trusted_root', evidence };
  } else if (action === 'refresh-trust-root') {
    const sourceRoot = path.resolve(args['source-root'] ?? '');
    if (!registry.trusted_roots.some(root => path.resolve(root) === sourceRoot)) {
      throw new Error(`Trusted root does not exist: ${sourceRoot}`);
    }
    const evidenceIndex = registry.trusted_root_evidence.findIndex(item => path.resolve(item.path) === sourceRoot);
    if (evidenceIndex < 0) throw new Error(`Trusted root evidence does not exist: ${sourceRoot}`);
    const previous = registry.trusted_root_evidence[evidenceIndex];
    if (normalizeRemote(previous.git_remote) !== normalizeRemote(args['expected-remote'])) {
      throw new Error('RefreshTrustRoot cannot change the pinned Git remote');
    }
    const evidence = await inspectPinnedSource(sourceRoot, args['expected-head'], args['expected-remote']);
    await assertRegisteredEntriesMatchSource(registry, sourceRoot);
    registry.trusted_root_evidence[evidenceIndex] = evidence;
    change = { operation: 'refresh_trusted_root', previous, evidence };
  } else if (action === 'untrust-root') {
    const sourceRoot = path.resolve(args['source-root'] ?? '');
    if (registry.extensions.some(entry => isWithin(entry.path, sourceRoot))) throw new Error(`Unregister extensions under the trusted root before removing it: ${sourceRoot}`);
    const rootIndex = registry.trusted_roots.findIndex(root => path.resolve(root) === sourceRoot);
    if (rootIndex < 0) throw new Error(`Trusted root does not exist: ${sourceRoot}`);
    registry.trusted_roots.splice(rootIndex, 1);
    registry.trusted_root_evidence = registry.trusted_root_evidence.filter(item => path.resolve(item.path) !== sourceRoot);
    change = { operation: 'remove_trusted_root', path: sourceRoot };
  } else {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(key)) throw new Error('An exact lowercase kebab-case --key is required');
    const index = registry.extensions.findIndex(entry => entry.key === key);
    if (action === 'register') {
      const entry = await buildEntry(registry, path.resolve(args.definition ?? ''), key);
      const replace = args.replace === 'true';
      if (index >= 0 && !replace) throw new Error(`Registry key already exists; use explicit replace: ${key}`);
      if (index >= 0) registry.extensions[index] = entry;
      else registry.extensions.push(entry);
      registry.extensions.sort((left, right) => left.key.localeCompare(right.key));
      change = { operation: index >= 0 ? 'replace' : 'add', key, entry };
    } else if (action === 'unregister') {
      if (index < 0) throw new Error(`Registry key does not exist: ${key}`);
      const [removed] = registry.extensions.splice(index, 1);
      change = { operation: 'remove_registry_entry', key, entry: removed };
    } else {
      throw new Error(`Unsupported registry action: ${action}`);
    }
  }
  if (!dryRun) {
    const temporary = `${registryPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, registryPath);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, action, dry_run: dryRun, registry: registryPath, change })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
