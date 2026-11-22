#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Explicit, manual inventory. Never schedules work or reads authentication/state bodies.
const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return path.resolve(args[i + 1]);
}
const aiccRoot = option('--aicc-root', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
const codexHome = option('--codex-home', process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const output = option('--output', null);
const slash = value => value.replaceAll('\\', '/');
const errors = [];
const stateNames = new Set(['auth.json', 'history.jsonl', 'sessions', 'archived_sessions', 'logs', 'sqlite', 'state', 'memories', 'dictation-history', 'attachments', 'mcp-oauth-locks', 'thread-writer-locks', 'project-metadata-locks', 'tui-thread-reference-capabilities', '.sandbox-secrets']);
const localSourceNames = new Set(['config.toml', 'hooks.json', 'hooks', 'policies', 'rules', 'ops', 'automations', 'docs', 'context', 'model-catalog-overrides', 'aicc-maintenance.config.toml', 'aicc-webgpt.config.toml', 'local-work.config.toml']);
const sourceTrees = new Set(['hooks', 'policies', 'rules', 'docs', 'model-catalog-overrides']);
function codexCategory(name) {
  if (name === 'AGENTS.md' || name === 'agents') return 'aicc-managed-delivery';
  if (name === 'skills') return 'mixed-user-source-and-system-delivery';
  if (name === 'plugins' || name === 'packages' || name === 'releases' || name === 'vendor_imports' || name === 'node_repl' || name === 'computer-use' || name === 'code-review-plugin' || name === 'pets') return 'supplier-extension-or-runtime';
  if (localSourceNames.has(name)) return 'owner-local-source';
  if (stateNames.has(name) || /\.sqlite(?:-(?:wal|shm))?$/.test(name) || /(?:lock|cap_sid|installation_id|global-state)/i.test(name)) return 'private-operational-state';
  if (/^(?:cache|temp|tmp|\.tmp|\.sandbox|\.wrangler|backups|recovery|worktrees|visualizations|browser|app-server|windows-health|rollout-migrations)/.test(name) || /(?:\.bak|\.tmp|backup|pre-safety|\.png$)/i.test(name)) return 'installation-cache-recovery-or-project-data';
  return 'owner-local-metadata-or-runtime';
}
function metadata(file, relative) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return { path: slash(relative), kind: 'symlink-not-followed' };
    if (!stat.isFile()) return { path: slash(relative), kind: 'directory-or-submodule' };
    return { path: slash(relative), bytes: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  } catch (error) {
    errors.push({ path: slash(relative), code: error.code || error.message });
    return { path: slash(relative), unavailable: true };
  }
}
const gitPaths = execFileSync('git', ['-C', aiccRoot, 'ls-files', '-c', '-o', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
const aiccFiles = [...new Set(gitPaths)].sort().map(relative => metadata(path.join(aiccRoot, relative), relative));
const aiccEntries = fs.readdirSync(aiccRoot, { withFileTypes: true }).map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file', category: entry.name === '.git' || entry.name === 'node_modules' ? 'git-or-dependency-not-source' : 'repository-source-or-source-metadata', indexedFiles: aiccFiles.filter(f => f.path === entry.name || f.path.startsWith(`${entry.name}/`)).length }));
const codexEntries = fs.readdirSync(codexHome, { withFileTypes: true }).map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file', category: codexCategory(entry.name), contentCopied: false }));
const localFiles = [];
function walkLocal(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkLocal(file);
    else if (entry.isFile() && /\.(?:mjs|js|ps1|psm1|py|md|toml|json|yaml|yml|rules)$/.test(entry.name)) localFiles.push(metadata(file, path.relative(codexHome, file)));
  }
}
for (const entry of codexEntries) {
  if (entry.kind === 'directory' && sourceTrees.has(entry.name)) walkLocal(path.join(codexHome, entry.name));
  else if (entry.kind === 'file' && localSourceNames.has(entry.name)) {
    // Even config hashes are metadata, not a settings/authentication body export.
    localFiles.push(metadata(path.join(codexHome, entry.name), entry.name));
  }
}
const group = files => {
  const counts = {};
  for (const file of files) { const key = file.path.split('/')[0]; counts[key] = (counts[key] || 0) + 1; }
  return counts;
};
const inventory = { schemaVersion: 1, capturedAt: new Date().toISOString(), requestMode: 'manual-only', roots: { aicc: slash(aiccRoot), codex: slash(codexHome) }, scope: { aicc: 'all Git tracked and non-ignored source paths; submodule pointer only', codex: 'all top-level component boundaries; hashes of direct config and reusable hooks/policies/rules/docs/model metadata; existing skill catalog owns skills and plugin entry paths', excludedContents: 'auth, sessions, memories, SQLite, logs, backups, browser profiles, runtime journals, dependency and supplier package contents', wholeRuntimeValidated: false }, aicc: { entries: aiccEntries, sourceFileCount: aiccFiles.length, byTopLevel: group(aiccFiles), files: aiccFiles }, codex: { entries: codexEntries, localSourceFiles: localFiles }, errors };
if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(inventory, null, 2)}\n`); }
console.log(JSON.stringify({ aiccSourceFiles: aiccFiles.length, aiccRootEntries: aiccEntries.length, codexRootEntries: codexEntries.length, codexLocalSourceFiles: localFiles.length, errors, output: output ? slash(output) : null }));
if (errors.length) process.exitCode = 1;
