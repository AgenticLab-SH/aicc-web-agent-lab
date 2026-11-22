import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceSkill = path.join(root, 'guidance', 'skills', 'web-gpt-orchestrator');
const pluginRoot = path.join(root, 'plugins', 'web-gpt-orchestrator');
const pluginSkill = path.join(pluginRoot, 'skills', 'web-gpt-orchestrator');
const checksumFile = path.join(pluginRoot, 'checksums.sha256');
const requiredSourceFiles = ['SKILL.md', path.join('agents', 'openai.yaml')];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`plugin packages cannot contain symlinks: ${absolute}`);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

for (const relative of requiredSourceFiles) {
  const source = path.join(sourceSkill, relative);
  if (!fs.existsSync(source)) throw new Error(`canonical skill file is missing: ${relative}`);
  const destination = path.join(pluginSkill, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(pluginRoot, 'LICENSE'));

const packageFiles = walk(pluginRoot)
  .filter(file => file !== checksumFile)
  .map(file => ({ file, relative: path.relative(pluginRoot, file).split(path.sep).join('/') }))
  .sort((left, right) => left.relative.localeCompare(right.relative));
const checksums = `${packageFiles.map(item => `${sha256(item.file)}  ${item.relative}`).join('\n')}\n`;
fs.writeFileSync(checksumFile, checksums, { mode: 0o644 });

const skillMatches = requiredSourceFiles.every(relative => sha256(path.join(sourceSkill, relative)) === sha256(path.join(pluginSkill, relative)));
const result = {
  ok: skillMatches,
  plugin: 'web-gpt-orchestrator',
  version: JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8')).version,
  fileCount: packageFiles.length,
  skillMatchesCanonical: skillMatches,
  checksumManifest: path.relative(root, checksumFile)
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
