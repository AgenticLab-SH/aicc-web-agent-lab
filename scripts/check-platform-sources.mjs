#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [mode, ...files] = process.argv.slice(2);
if (!['shell', 'swift'].includes(mode) || files.length === 0) {
  console.error('Usage: node scripts/check-platform-sources.mjs shell|swift <file...>');
  process.exit(2);
}

function run(executable, args) {
  const result = spawnSync(executable, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (mode === 'shell') {
  let shell = 'sh';
  if (process.platform === 'win32') {
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    shell = path.resolve(execPath, '..', '..', '..', 'bin', 'sh.exe');
    if (!existsSync(shell)) throw new Error(`Git shell not found: ${shell}`);
  }
  run(shell, ['-n', ...files]);
  process.exit(0);
}

const probe = spawnSync('swiftc', ['--version'], { encoding: 'utf8', windowsHide: true });
if (probe.error?.code === 'ENOENT' && process.platform !== 'darwin') {
  console.log(JSON.stringify({ status: 'skipped', language: 'swift', platform: process.platform }));
  process.exit(0);
}
if (probe.error) throw probe.error;
if (probe.status !== 0) process.exit(probe.status ?? 1);
run('swiftc', ['-parse', ...files]);
