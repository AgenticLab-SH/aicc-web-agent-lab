#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDocument = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packed = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root,
  encoding: 'utf8',
  // Windows resolves npm.cmd through the command shell; without this flag
  // spawnSync can return a null status even though npm itself is installed.
  shell: process.platform === 'win32',
  env: { ...process.env, npm_config_update_notifier: 'false' }
});

assert.equal(packed.status, 0, packed.stderr || packed.stdout || 'npm pack --dry-run failed');
const rawReport = JSON.parse(packed.stdout);
const report = Array.isArray(rawReport) ? rawReport : Object.values(rawReport);
assert.equal(report.length, 1, 'expected one npm package report');
const files = report[0].files.map(entry => entry.path).sort();

assert.equal(packageDocument.name, 'open-aicc');
assert.deepEqual(Object.keys(packageDocument.bin).sort(), ['aicc', 'cm']);
assert.equal(packageDocument.repository.url, 'git+https://github.com/AgenticLab-SH/aicc-web-agent-lab.git');
assert.ok(files.includes('npm-shrinkwrap.json'), 'reproducible production dependency lock missing');
assert.ok(files.includes('contracts/model-adapter/capability.schema.json'), 'public adapter contract missing');
assert.ok(files.includes('docs/open-aicc-migration.md'), 'migration contract missing');

const forbiddenPath = /^(?:evidence|runtime|user-knowledge|design-library|profile|repos|node_modules|\.npm)(?:\/|$)|(?:^|\/)codex-chatgpt-web-private(?:\/|$)/;
const forbiddenGeneratedPath = /(?:^|\/)(?:__pycache__|\.DS_Store)(?:\/|$)|\.py[cod]$|\.log$/;
const forbiddenContent = [
  { pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/|\b)/, label: 'absolute user path' },
  { pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|\b)/, label: 'absolute Windows user path' },
  { pattern: /AgenticLab-SH\/AICC(?:\.git)?\b/, label: 'retired public repository URL' },
  { pattern: /\$HOME\/dev\/projects\/tools\/AICC\b/, label: 'fixed checkout assumption' }
];

for (const file of files) {
  assert.equal(forbiddenPath.test(file), false, `forbidden package path: ${file}`);
  assert.equal(forbiddenGeneratedPath.test(file), false, `generated or cache artifact in package: ${file}`);
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) continue;
  const text = buffer.toString('utf8');
  for (const check of forbiddenContent) assert.equal(check.pattern.test(text), false, `${check.label}: ${file}`);
}

for (const relative of files.filter(file => file.startsWith('contracts/') && file.endsWith('.json'))) {
  JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

const summary = {
  ok: true,
  package: packageDocument.name,
  commandCompatibility: Object.keys(packageDocument.bin).sort(),
  fileCount: files.length,
  unpackedBytes: report[0].unpackedSize,
  privatePredecessorIncluded: false,
  absoluteUserPaths: 0
};

// npm forwards lifecycle stdout into `npm pack --json`, which would turn the
// otherwise machine-readable pack report into two adjacent JSON documents.
// Keep direct distribution checks informative while making the prepack hook
// deliberately quiet.
if (process.env.npm_lifecycle_event !== 'prepack') {
  console.log(JSON.stringify(summary, null, 2));
}
