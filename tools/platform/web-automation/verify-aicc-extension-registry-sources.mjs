#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`Invalid argument near ${argv[index] ?? '<end>'}`);
    parsed[argv[index].slice(2)] = argv[index + 1];
  }
  return parsed;
}

function isWithin(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRemote(value) {
  return String(value ?? '').trim().replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
}

async function git(root, ...args) {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], { windowsHide: true, maxBuffer: 1_048_576 });
  return stdout.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registryPath = path.resolve(args.registry ?? '');
  const selectedKey = String(args.extension ?? 'all');
  const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  const entries = registry.extensions.filter(entry => selectedKey === 'all' || entry.key === selectedKey);
  if (entries.length === 0) throw new Error(`No registered extension matches key ${selectedKey}`);
  const checked = [];
  for (const entry of entries) {
    const evidence = (registry.trusted_root_evidence ?? [])
      .filter(item => isWithin(entry.path, item.path))
      .sort((left, right) => path.resolve(right.path).length - path.resolve(left.path).length)[0];
    if (!evidence) continue;
    const root = path.resolve(evidence.path);
    const real = await fs.realpath(root);
    if (real !== root || (await fs.lstat(root)).isSymbolicLink()) throw new Error(`Pinned source uses a symlink or junction: ${root}`);
    const topLevel = path.resolve(await git(root, 'rev-parse', '--show-toplevel'));
    const head = await git(root, 'rev-parse', 'HEAD');
    const remote = await git(root, 'remote', 'get-url', 'origin');
    const status = await git(root, 'status', '--porcelain=v1');
    if (topLevel !== root || head.toLowerCase() !== evidence.git_head.toLowerCase()
        || normalizeRemote(remote) !== normalizeRemote(evidence.git_remote) || status) {
      throw new Error(`Pinned extension source drift for ${entry.key}`);
    }
    checked.push({ key: entry.key, path: root, git_head: head.toLowerCase(), git_remote: remote });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, registry: registryPath, extension: selectedKey, checked })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
