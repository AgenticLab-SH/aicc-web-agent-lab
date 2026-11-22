#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const fusionRoot = path.resolve(process.argv[2] || '.');
const vaultRoot = path.resolve(process.argv[3] || '');
const manifestFile = path.join(fusionRoot, 'state', 'knowledge-promotion.json');
const errors = [];

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(fileName) {
  return sha256Bytes(readFileSync(fileName));
}

function markdownInventory(root) {
  const files = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fileName = path.join(dir, entry.name);
      const info = lstatSync(fileName);
      if (info.isSymbolicLink()) {
        errors.push(`symlink is not allowed: ${path.relative(root, fileName)}`);
      } else if (info.isDirectory()) {
        walk(fileName);
      } else if (entry.name.endsWith('.md')) {
        files.push({
          path: path.relative(root, fileName).split(path.sep).join('/'),
          sha256: sha256File(fileName),
        });
      }
    }
  }
  if (existsSync(root)) walk(root);
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function treeHash(files) {
  const rows = files.map((item) => `${item.path}\0${item.sha256}`).join('\n');
  return sha256Bytes(`${rows}\n`);
}

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) &&
    value === value.split(path.sep).join('/') && !value.split('/').includes('..');
}

if (!existsSync(manifestFile)) errors.push('missing state/knowledge-promotion.json');
if (!existsSync(path.join(vaultRoot, '.obsidian'))) errors.push('target vault is missing .obsidian');
if (!existsSync(path.join(vaultRoot, '00_Meta', '00_Vault_Home.md'))) errors.push('target vault is missing 00_Meta/00_Vault_Home.md');

let manifest = null;
if (existsSync(manifestFile)) {
  try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); }
  catch (error) { errors.push(`invalid knowledge-promotion.json: ${error.message}`); }
}

const sourceRoot = path.join(fusionRoot, manifest?.sourceRoot || 'current');
const sourceFiles = markdownInventory(sourceRoot);
const sourcePaths = new Set(sourceFiles.map((item) => item.path));
const seen = new Set();
let vaultTargets = 0;

if (manifest) {
  if (manifest.schemaVersion !== 1) errors.push(`unsupported schemaVersion: ${manifest.schemaVersion}`);
  if (manifest.promotionStatus !== 'complete') errors.push(`promotionStatus is not complete: ${manifest.promotionStatus}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.targetVaultId || '')) errors.push('invalid targetVaultId');
  if (manifest.sourceMarkdown !== sourceFiles.length) errors.push(`sourceMarkdown mismatch: expected ${manifest.sourceMarkdown}, actual ${sourceFiles.length}`);
  const actualTree = treeHash(sourceFiles);
  if (manifest.sourceTreeSha256 !== actualTree) errors.push(`sourceTreeSha256 mismatch: ${actualTree}`);

  if (!Array.isArray(manifest.dispositions)) errors.push('dispositions must be an array');
  for (const item of manifest.dispositions || []) {
    if (!safeRelative(item.source)) {
      errors.push('invalid source path in disposition');
      continue;
    }
    if (seen.has(item.source)) errors.push(`duplicate source disposition: ${item.source}`);
    seen.add(item.source);
    if (!sourcePaths.has(item.source)) errors.push(`unknown source disposition: ${item.source}`);
    if (!['absorbed', 'owner-ledger', 'source-meta', 'artifact-only'].includes(item.action)) {
      errors.push(`invalid action for ${item.source}: ${item.action}`);
    }
    if (!Array.isArray(item.targets) || item.targets.length === 0) errors.push(`missing targets for ${item.source}`);
    for (const target of item.targets || []) {
      if (!['vault', 'owner-ledger', 'artifact'].includes(target.kind)) {
        errors.push(`invalid target kind for ${item.source}`);
        continue;
      }
      if (target.kind === 'vault') {
        vaultTargets += 1;
        if (!safeRelative(target.path)) {
          errors.push(`invalid vault target path for ${item.source}`);
          continue;
        }
        const fileName = path.join(vaultRoot, target.path);
        if (!existsSync(fileName)) errors.push(`missing vault target: ${target.path}`);
        else if (lstatSync(fileName).isSymbolicLink()) errors.push(`vault target is symlink: ${target.path}`);
        else if (!/^[a-f0-9]{64}$/.test(target.sha256 || '') || sha256File(fileName) !== target.sha256) {
          errors.push(`vault target hash mismatch: ${target.path}`);
        }
      } else if (typeof target.ref !== 'string' || !target.ref || /^(?:\/|[A-Za-z]:\\)/.test(target.ref)) {
        errors.push(`invalid logical target ref for ${item.source}`);
      }
    }
  }
  for (const source of sourcePaths) if (!seen.has(source)) errors.push(`source without disposition: ${source}`);
}

console.log(JSON.stringify({
  ok: errors.length === 0,
  fusionRoot,
  vaultRoot,
  sourceMarkdown: sourceFiles.length,
  sourceTreeSha256: treeHash(sourceFiles),
  dispositionCount: seen.size,
  vaultTargets,
  errors,
}, null, 2));
if (errors.length) process.exitCode = 1;
