#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(process.argv[2] || '.');
const errors = [];
const warnings = [];

function sha256(fileName) {
  return createHash('sha256').update(readFileSync(fileName)).digest('hex');
}

function inventory(dir, { rejectSymlinks = false } = {}) {
  const files = [];
  if (!existsSync(dir)) return files;
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fileName = path.join(current, entry.name);
      const info = lstatSync(fileName);
      if (info.isSymbolicLink()) {
        if (rejectSymlinks) errors.push(`symlink is not allowed: ${path.relative(projectRoot, fileName)}`);
        continue;
      }
      if (info.isDirectory()) walk(fileName);
      else files.push({
        path: path.relative(dir, fileName).split(path.sep).join('/'),
        bytes: info.size,
        sha256: sha256(fileName),
        mode: info.mode & 0o777,
      });
    }
  }
  walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function compareInventory(label, expected, actual) {
  const expectedMap = new Map();
  for (const item of expected) {
    if (!item || typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256 || '') || !Number.isInteger(item.bytes)) {
      errors.push(`${label}: invalid baseline item`);
      continue;
    }
    if (expectedMap.has(item.path)) errors.push(`${label}: duplicate baseline path ${item.path}`);
    expectedMap.set(item.path, item);
  }
  const actualMap = new Map(actual.map((item) => [item.path, item]));
  for (const [fileName, item] of expectedMap) {
    const found = actualMap.get(fileName);
    if (!found) errors.push(`${label}: missing ${fileName}`);
    else if (found.sha256 !== item.sha256 || found.bytes !== item.bytes) errors.push(`${label}: fingerprint mismatch ${fileName}`);
  }
  for (const fileName of actualMap.keys()) if (!expectedMap.has(fileName)) errors.push(`${label}: untracked ${fileName}`);
}

function validateMarkdown(dir, label) {
  if (!existsSync(dir)) return { files: 0, brokenLinks: 0 };
  const markdown = inventory(dir).filter((item) => item.path.endsWith('.md'));
  let brokenLinks = 0;
  for (const item of markdown) {
    const fileName = path.join(dir, item.path);
    const text = readFileSync(fileName, 'utf8');
    if (/\/(?:Users|home|private|var|tmp|Volumes)\/|[A-Za-z]:\\/.test(text)) errors.push(`${label}: absolute path in ${item.path}`);
    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) errors.push(`${label}: email-like value in ${item.path}`);
    if (/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i.test(text)) {
      errors.push(`${label}: secret-like value in ${item.path}`);
    }
    const links = /\[[^\n\]]+\]\(([^)\n]+)\)/g;
    let match;
    while ((match = links.exec(text))) {
      const target = match[1].split('#')[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      if (!existsSync(path.resolve(path.dirname(fileName), decodeURIComponent(target)))) {
        brokenLinks += 1;
        errors.push(`${label}: broken link ${item.path} -> ${target}`);
      }
    }
  }
  return { files: markdown.length, brokenLinks };
}

for (const required of ['context/PROJECT.md', 'sources/codex', 'sources/web-gpt', 'state/source-snapshot.json']) {
  if (!existsSync(path.join(projectRoot, required))) errors.push(`required path missing: ${required}`);
}

let state = null;
const stateFile = path.join(projectRoot, 'state/source-snapshot.json');
if (existsSync(stateFile)) {
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); }
  catch (error) { errors.push(`invalid source-snapshot.json: ${error.message}`); }
}

const laneDirs = { codex: 'codex', webGpt: 'web-gpt' };
const sourceCounts = {};
for (const [stateName, dirName] of Object.entries(laneDirs)) {
  const dir = path.join(projectRoot, 'sources', dirName);
  const files = inventory(dir, { rejectSymlinks: true });
  sourceCounts[stateName] = files.length;
  for (const item of files) if ((item.mode & 0o222) !== 0) errors.push(`source is writable: sources/${dirName}/${item.path}`);
  if (state?.sources?.[stateName]) compareInventory(`sources/${dirName}`, state.sources[stateName], files);
  else if (state) errors.push(`baseline lane missing: ${stateName}`);
}

const stagingResult = validateMarkdown(path.join(projectRoot, 'staging'), 'staging');
const currentDir = path.join(projectRoot, 'current');
const currentResult = validateMarkdown(currentDir, 'current');

if (state) {
  if (state.schemaVersion !== 1) errors.push(`unsupported schemaVersion: ${state.schemaVersion}`);
  if (!['pending', 'complete'].includes(state.fusionStatus)) errors.push(`invalid fusionStatus: ${state.fusionStatus}`);
  if (state.fusionStatus === 'complete') {
    if (!existsSync(currentDir)) errors.push('fusionStatus is complete but current/ is missing');
    compareInventory('current', state.output || [], inventory(currentDir));
  } else if (existsSync(currentDir)) {
    errors.push('current/ exists while fusionStatus is pending');
  } else {
    warnings.push('fusion is pending; current/ is not expected yet');
  }
}

const result = {
  ok: errors.length === 0,
  projectRoot,
  fusionStatus: state?.fusionStatus ?? null,
  sourceFiles: sourceCounts,
  stagingMarkdown: stagingResult.files,
  currentMarkdown: currentResult.files,
  errors,
  warnings,
};
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exitCode = 1;
