#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const prunedNames = new Set([
  '.git', '.cache', '.venv', 'venv', 'node_modules', 'vendor', 'dist', 'build',
  'site-packages', '.backups', 'backups', '__pycache__'
]);

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return '';
    throw error;
  }
}

function unquote(value) {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  return text;
}

export function parseSkill(file) {
  const text = readText(file);
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const frontmatter = match?.[1] ?? '';
  const fields = {};
  const frontmatterLines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < frontmatterLines.length; index += 1) {
    const line = frontmatterLines[index];
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!field) continue;
    if (/^[|>][+-]?(?:\s+#.*)?$/.test(field[2].trim())) {
      const block = [];
      while (index + 1 < frontmatterLines.length && /^(?:\s+\S|\s*$)/.test(frontmatterLines[index + 1])) {
        block.push(frontmatterLines[++index].trim());
      }
      fields[field[1]] = block.join(field[2].startsWith('>') ? ' ' : '\n');
    } else fields[field[1]] = unquote(field[2]);
  }
  const body = match ? text.slice(match[0].length) : text;
  const handoffs = [...new Set([...body.matchAll(/\$([a-z0-9]+(?:-[a-z0-9]+)*)/g)].map(item => item[1]))].sort();
  return {
    name: fields.name || path.basename(path.dirname(file)),
    description: (fields.description || '').replace(/\s+/g, ' ').trim(),
    handoffs
  };
}

function countFiles(root, readErrors = []) {
  let count = 0;
  const visit = current => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (['EACCES','EPERM','UNKNOWN','ENOTDIR'].includes(error.code)) {
        readErrors.push({ path: current, code: error.code });
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) count += 1;
    }
  };
  visit(root);
  return count;
}

function resources(skillDir) {
  const readErrors = [];
  return {
    references: countFiles(path.join(skillDir, 'references'), readErrors),
    scripts: countFiles(path.join(skillDir, 'scripts'), readErrors),
    assets: countFiles(path.join(skillDir, 'assets'), readErrors),
    readErrors
  };
}

function invocationPolicy(skillFile) {
  const metadata = readText(path.join(path.dirname(skillFile), 'agents', 'openai.yaml'));
  const raw = metadata.match(/^\s*allow_implicit_invocation:\s*(true|false)\s*$/mi)?.[1];
  return {
    allowImplicitInvocation: raw !== 'false',
    declared: raw === undefined ? null : raw === 'true'
  };
}

function instructionLines(skill) {
  const lines = [];
  let fenced = false;
  for (const [index, raw] of readText(skill.canonicalPath).split(/\r?\n/).entries()) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('```')) { fenced = !fenced; continue; }
    if (fenced || !trimmed || trimmed === '---' || trimmed.startsWith('#') || trimmed.startsWith('|')) continue;
    const normalized = trimmed.replace(/^[-*]|^\d+[.)]/, '').replace(/\s+/g, ' ').trim();
    if (normalized.length >= 40) lines.push({ text: normalized, line: index + 1 });
  }
  return lines;
}

function repeatedInstructionLines(skills) {
  const occurrences = new Map();
  for (const skill of skills) {
    for (const line of instructionLines(skill)) {
      const rows = occurrences.get(line.text) || [];
      rows.push({ skill: skill.name, line: line.line });
      occurrences.set(line.text, rows);
    }
  }
  return [...occurrences.entries()]
    .map(([text, rows]) => ({ text, occurrences: rows }))
    .filter(item => new Set(item.occurrences.map(row => row.skill)).size > 1)
    .sort((left, right) => left.text.localeCompare(right.text));
}

function directSkillFiles(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => {
        if (entry.isDirectory()) return true;
        if (!entry.isSymbolicLink()) return false;
        try { return fs.statSync(path.join(root, entry.name)).isDirectory(); }
        catch { return false; }
      })
      .map(entry => path.join(root, entry.name, 'SKILL.md'))
      .filter(file => fs.existsSync(file));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return [];
    throw error;
  }
}

function codexActiveSkillNames(aiccRoot) {
  const catalog = readText(path.join(aiccRoot, 'guidance', 'config', 'agent-catalog.toml'));
  const blocks = [...catalog.matchAll(/\[\[deployment_targets\]\]([\s\S]*?)(?=\n\[\[deployment_targets\]\]|$)/g)]
    .map(match => match[1]);
  const codex = blocks.find(block => /^\s*id\s*=\s*["']codex["']/m.test(block));
  if (!codex) return null;
  const raw = codex.match(/^\s*active_skills\s*=\s*\[([^\]]*)\]/m)?.[1];
  if (raw === undefined) return null;
  return [...raw.matchAll(/["']([^"']+)["']/g)].map(match => match[1]);
}

export function findProjectSkillFiles(roots, { instructionFiles = [] } = {}) {
  const files = [];
  const visit = current => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && /^(?:AGENTS(?:\.override)?\.md|\.agents\.md|TEAM_GUIDE\.md)$/.test(entry.name)) {
        instructionFiles.push(path.resolve(current, entry.name));
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isDirectory() || prunedNames.has(entry.name)) continue;
      const candidate = path.join(current, entry.name);
      if (entry.name === '.agent' || entry.name === '.agents') {
        files.push(...directSkillFiles(path.join(candidate, 'skills')));
        continue;
      }
      visit(candidate);
    }
  };
  for (const root of roots) visit(root);
  return [...new Set(files.map(file => path.resolve(file)))].sort();
}

function parsePluginList(text) {
  const installed = new Map();
  let marketplace = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^Marketplace `([^`]+)`/);
    if (heading) { marketplace = heading[1]; continue; }
    const row = line.match(/^([^\s]+)\s+installed, enabled\s+(\S+)\s+/);
    if (!row || !marketplace) continue;
    const qualified = row[1];
    const at = qualified.lastIndexOf('@');
    const pluginName = at > 0 ? qualified.slice(0, at) : qualified;
    installed.set(`${marketplace}/${pluginName}`, { marketplace, pluginName, version: row[2], qualified });
  }
  return installed;
}

function walkSkillFiles(root, maxDepth = 9) {
  const files = [];
  const visit = (current, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) visit(candidate, depth + 1);
      else if (entry.isFile() && entry.name === 'SKILL.md' && candidate.split(path.sep).includes('skills')) files.push(candidate);
    }
  };
  visit(root, 0);
  return files.sort();
}

function pluginIdentity(file, cacheRoot) {
  const relative = path.relative(cacheRoot, file).split(path.sep);
  if (relative.length < 4) return null;
  return { marketplace: relative[0], pluginName: relative[1], version: relative[2] };
}

function safeIdPart(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function makeEntry({
  file,
  owner,
  status,
  idPrefix,
  projectScope = null,
  plugin = null,
  deliveryPaths = [],
  currentDeliveryPresent = null,
  legacyDeliveryPresent = false
}) {
  const parsed = parseSkill(file);
  return {
    id: `${idPrefix}:${safeIdPart(parsed.name)}`,
    name: parsed.name,
    description: parsed.description,
    owner,
    status,
    canonicalPath: path.resolve(file),
    deliveryPaths: deliveryPaths.map(item => path.resolve(item)),
    projectScope,
    plugin,
    invocationPolicy: invocationPolicy(file),
    entryBytes: Buffer.byteLength(readText(file), 'utf8'),
    resourceCounts: resources(path.dirname(file)),
    handoffs: parsed.handoffs,
    sameNameOwners: [],
    currentDeliveryPresent,
    legacyDeliveryPresent
  };
}

function treeFiles(root) {
  const result = [];
  const visit = current => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'].includes(entry.name)) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && !/\.(?:pyc|pyo)$/i.test(entry.name) && entry.name !== '.DS_Store') result.push(path.relative(root, candidate));
    }
  };
  visit(root);
  return result.sort();
}

function sameTree(left, right) {
  if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
  const leftFiles = treeFiles(left);
  const rightFiles = treeFiles(right);
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) return false;
  return leftFiles.every(relative => fs.readFileSync(path.join(left, relative)).equals(fs.readFileSync(path.join(right, relative))));
}

function sameFile(left, right) {
  return fs.existsSync(left) && fs.existsSync(right) && fs.readFileSync(left).equals(fs.readFileSync(right));
}

function projectScopeFor(file) {
  const markers = [`${path.sep}.agents${path.sep}skills${path.sep}`, `${path.sep}.agent${path.sep}skills${path.sep}`];
  const indexes = markers.map(marker => file.indexOf(marker)).filter(index => index >= 0);
  return indexes.length ? file.slice(0, Math.min(...indexes)) : path.dirname(path.dirname(path.dirname(file)));
}

function classifySameNameEntries(entries) {
  const installedPlugins = entries.filter(entry => entry.owner === 'plugin' && entry.status === 'installed-enabled');
  if (entries.every(entry => entry.owner === 'plugin') && installedPlugins.length <= 1) return 'retained-plugin-cache';
  if (entries.every(entry => entry.owner === 'plugin')) {
    const namespaces = installedPlugins.map(entry => entry.plugin?.pluginName).filter(Boolean);
    if (new Set(namespaces).size === installedPlugins.length) return 'isolated-plugin-namespaces';
  }
  if (entries.every(entry => entry.owner === 'project')) {
    const scopes = entries.map(entry => entry.projectScope).filter(Boolean);
    if (new Set(scopes).size === entries.length) return 'isolated-project-scopes';
  }
  return 'effective-collision';
}

export function buildCatalog(options = {}) {
  const aiccRoot = path.resolve(options.aiccRoot || sourceRoot);
  const codexHome = path.resolve(options.codexHome || path.join(os.homedir(), '.codex'));
  const agentSkillsRoot = path.resolve(options.agentSkillsRoot || path.join(path.dirname(codexHome), '.agents', 'skills'));
  const legacySkillsRoot = path.join(codexHome, 'skills');
  const projectRoots = (options.projectRoots || []).map(root => path.resolve(root));
  const pluginCache = path.join(codexHome, 'plugins', 'cache');
  const pluginList = options.pluginListText ?? spawnSync('codex', ['plugin', 'list'], { encoding: 'utf8' }).stdout ?? '';
  const installed = parsePluginList(pluginList);
  const skills = [];
  const configuredActive = options.aiccActiveSkills ?? codexActiveSkillNames(aiccRoot);
  const activeAiccNames = configuredActive === null ? null : new Set(configuredActive);

  for (const file of directSkillFiles(path.join(codexHome, 'skills', '.system'))) {
    skills.push(makeEntry({ file, owner: 'codex-system', status: 'builtin', idPrefix: 'system' }));
  }

  const aiccByName = new Map();
  for (const file of directSkillFiles(path.join(aiccRoot, 'guidance', 'skills'))) aiccByName.set(parseSkill(file).name, file);
  for (const [name, file] of [...aiccByName.entries()].sort()) {
    const currentDelivery = path.join(agentSkillsRoot, name);
    const legacyDelivery = path.join(legacySkillsRoot, name);
    const currentDeliveryPresent = sameTree(path.dirname(file), currentDelivery);
    const legacyDeliveryPresent = sameTree(path.dirname(file), legacyDelivery);
    const deliveryPaths = [
      ...(currentDeliveryPresent ? [currentDelivery] : []),
      ...(legacyDeliveryPresent ? [legacyDelivery] : [])
    ];
    const active = activeAiccNames === null || activeAiccNames.has(name);
    skills.push(makeEntry({
      file,
      owner: 'aicc',
      status: active ? 'canonical-active' : 'canonical-cold',
      idPrefix: 'aicc',
      deliveryPaths,
      currentDeliveryPresent,
      legacyDeliveryPresent
    }));
  }

  const userSkillFiles = [...new Set([
    ...directSkillFiles(agentSkillsRoot),
    ...directSkillFiles(legacySkillsRoot)
  ].map(file => path.resolve(file)))];
  for (const file of userSkillFiles) {
    const parsed = parseSkill(file);
    const aiccSource = aiccByName.get(parsed.name);
    if (aiccSource && sameTree(path.dirname(aiccSource), path.dirname(file))) continue;
    const parentRoot = path.resolve(path.dirname(path.dirname(file)));
    const activeManagedSlot = aiccSource && (activeAiccNames === null || activeAiccNames.has(parsed.name)) && (
      parentRoot === agentSkillsRoot || parentRoot === path.resolve(legacySkillsRoot)
    );
    if (activeManagedSlot) continue;
    const legacy = path.dirname(path.dirname(file)) === path.resolve(legacySkillsRoot);
    skills.push(makeEntry({
      file,
      owner: 'user',
      status: legacy ? 'legacy-user-managed' : 'user-managed',
      idPrefix: `user:${legacy ? 'legacy' : 'current'}`
    }));
  }

  for (const file of walkSkillFiles(pluginCache)) {
    const identity = pluginIdentity(file, pluginCache);
    if (!identity) continue;
    const installedInfo = installed.get(`${identity.marketplace}/${identity.pluginName}`);
    const status = installedInfo && installedInfo.version === identity.version ? 'installed-enabled' : 'cached';
    const parsed = parseSkill(file);
    const aiccSource = aiccByName.get(parsed.name);
    const isAiccPluginDelivery = identity.marketplace === 'aicc-local' && aiccSource && sameFile(aiccSource, file);
    if (aiccSource && (sameTree(path.dirname(aiccSource), path.dirname(file)) || isAiccPluginDelivery)) {
      const owner = skills.find(item => item.id === `aicc:${safeIdPart(parsed.name)}`);
      if (owner && !owner.deliveryPaths.includes(path.dirname(file))) owner.deliveryPaths.push(path.dirname(file));
      continue;
    }
    skills.push(makeEntry({
      file, owner: 'plugin', status,
      idPrefix: `plugin:${safeIdPart(identity.marketplace)}:${safeIdPart(identity.pluginName)}:${safeIdPart(identity.version)}`,
      plugin: { ...identity, installed: status === 'installed-enabled' }
    }));
  }

  const instructionFiles = [];
  for (const file of findProjectSkillFiles(projectRoots, { instructionFiles })) {
    const scope = projectScopeFor(file);
    skills.push(makeEntry({
      file, owner: 'project', status: 'project-local',
      idPrefix: `project:${safeIdPart(path.basename(scope))}`,
      projectScope: scope
    }));
  }

  const byName = new Map();
  for (const skill of skills) {
    if (!byName.has(skill.name)) byName.set(skill.name, []);
    byName.get(skill.name).push(skill);
  }
  const duplicateNames = [];
  for (const [name, entries] of [...byName.entries()].sort()) {
    if (entries.length > 1) duplicateNames.push({
      name,
      classification: classifySameNameEntries(entries),
      ids: entries.map(item => item.id).sort()
    });
    const owners = [...new Set(entries.map(item => item.owner))].sort();
    for (const entry of entries) entry.sameNameOwners = owners.filter(owner => owner !== entry.owner);
  }
  skills.sort((left, right) => left.owner.localeCompare(right.owner) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const ids = skills.map(skill => skill.id);
  if (new Set(ids).size !== ids.length) {
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
    throw new Error(`Duplicate logical skill ids: ${duplicates.join(', ')}`);
  }
  const byOwner = {};
  for (const skill of skills) byOwner[skill.owner] = (byOwner[skill.owner] || 0) + 1;
  const aiccActiveCount = skills.filter(skill => skill.owner === 'aicc' && skill.status === 'canonical-active').length;
  const aiccColdCount = skills.filter(skill => skill.owner === 'aicc' && skill.status === 'canonical-cold').length;
  const unmanagedUserSkillCount = skills.filter(skill => skill.owner === 'user').length;
  const aiccDeliveryIssueCount = skills.filter(skill => (
    skill.owner === 'aicc' && skill.status === 'canonical-active' && skill.currentDeliveryPresent !== true
  )).length;
  const activeAiccSkills = skills.filter(skill => skill.owner === 'aicc' && skill.status === 'canonical-active');
  const aiccImplicitActiveCount = activeAiccSkills.filter(skill => skill.invocationPolicy.allowImplicitInvocation).length;
  const aiccExplicitOnlyCount = activeAiccSkills.length - aiccImplicitActiveCount;
  const aiccImplicitDescriptionCharacters = activeAiccSkills
    .filter(skill => skill.invocationPolicy.allowImplicitInvocation)
    .reduce((total, skill) => total + skill.description.length, 0);
  const aiccDeferredEntryBytes = activeAiccSkills.reduce((total, skill) => total + skill.entryBytes, 0);
  const legacyManagedCopyCount = activeAiccSkills.filter(skill => skill.legacyDeliveryPresent).length;
  const exactRepeatedInstructionLines = repeatedInstructionLines(activeAiccSkills);
  const effectiveDuplicateNameCount = duplicateNames.filter(item => item.classification === 'effective-collision').length;
  return {
    schemaVersion: 2,
    generatedAt: (options.now || new Date()).toISOString(),
    scope: { aiccRoot, codexHome, agentSkillsRoot, legacySkillsRoot, projectRoots },
    instructionFiles: [...new Set(instructionFiles)].sort(),
    summary: {
      logicalSkillCount: skills.length,
      byOwner,
      aiccActiveCount,
      aiccColdCount,
      aiccImplicitActiveCount,
      aiccExplicitOnlyCount,
      aiccImplicitDescriptionCharacters,
      aiccDeferredEntryBytes,
      aiccExactRepeatedInstructionLineGroupCount: exactRepeatedInstructionLines.length,
      unmanagedUserSkillCount,
      legacyManagedCopyCount,
      aiccDeliveryIssueCount,
      effectiveDuplicateNameCount
    },
    skills,
    duplicateNames,
    contextReview: { exactRepeatedInstructionLines }
  };
}

function markdownEscape(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

export function renderMarkdown(catalog) {
  const lines = [
    '# Skill ecosystem map', '',
    `Generated: ${catalog.generatedAt}`, '',
    'This is an owner-local index, not an instruction bundle. Read the selected `SKILL.md` only when a task triggers it.', '',
    `Logical entries: ${catalog.summary.logicalSkillCount} · AICC active/cold: ${catalog.summary.aiccActiveCount}/${catalog.summary.aiccColdCount} · implicit/explicit-only: ${catalog.summary.aiccImplicitActiveCount}/${catalog.summary.aiccExplicitOnlyCount} · implicit description characters: ${catalog.summary.aiccImplicitDescriptionCharacters} · deferred entry bytes: ${catalog.summary.aiccDeferredEntryBytes} · user-managed: ${catalog.summary.unmanagedUserSkillCount} · legacy managed copies: ${catalog.summary.legacyManagedCopyCount} · AICC delivery issues: ${catalog.summary.aiccDeliveryIssueCount} · effective same-name collisions: ${catalog.summary.effectiveDuplicateNameCount}`, '',
    '| No. | Name | Owner / status | Description | Canonical path | Delivery / handoff |',
    '|---:|---|---|---|---|---|'
  ];
  catalog.skills.forEach((skill, index) => {
    const delivery = [
      skill.deliveryPaths.length ? `delivery ${skill.deliveryPaths.join(', ')}` : '',
      skill.handoffs.length ? `handoff ${skill.handoffs.join(', ')}` : ''
    ].filter(Boolean).join('; ') || '-';
    lines.push(`| ${index + 1} | \`${markdownEscape(skill.name)}\` | ${skill.owner} / ${skill.status} | ${markdownEscape(skill.description)} | \`${markdownEscape(skill.canonicalPath)}\` | ${markdownEscape(delivery)} |`);
  });
  lines.push('', '## Same-name entries', '');
  if (catalog.duplicateNames.length === 0) lines.push('None.');
  else for (const duplicate of catalog.duplicateNames) lines.push(`- \`${duplicate.name}\` (${duplicate.classification}): ${duplicate.ids.join(', ')}`);
  lines.push('', '## Exact repeated instruction lines', '');
  if (catalog.contextReview.exactRepeatedInstructionLines.length === 0) lines.push('None.');
  else for (const item of catalog.contextReview.exactRepeatedInstructionLines) {
    lines.push(`- ${markdownEscape(item.text)} — ${item.occurrences.map(row => `${row.skill}:${row.line}`).join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

function writePrivateAtomic(file, content) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function parseArgs(argv) {
  const options = { projectRoots: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--aicc-root') options.aiccRoot = argv[++index];
    else if (argument === '--codex-home') options.codexHome = argv[++index];
    else if (argument === '--agent-skills-root') options.agentSkillsRoot = argv[++index];
    else if (argument === '--state-root') options.stateRoot = argv[++index];
    else if (argument === '--project-root') options.projectRoots.push(argv[++index]);
    else if (argument === '--plugin-list-file') options.pluginListText = readText(argv[++index]);
    else if (argument === '--write') options.noWrite = false;
    else if (argument === '--no-write') options.noWrite = true;
    else if (argument === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function usage() {
  return `Usage: node tools/platform/inspect/inspect-skill-ecosystem.mjs [options]\n\n` +
    `  --project-root PATH   Scan project-local .agent(s)/skills (repeatable)\n` +
    `  --state-root PATH     Owner-local AICC state root (default: AICC_STATE_ROOT or ~/.ai-control-center)\n` +
    `  --aicc-root PATH      Canonical AICC checkout\n` +
    `  --codex-home PATH     Active Codex home\n` +
    `  --agent-skills-root P Current user skill root (default: sibling .agents/skills)\n` +
    `  --plugin-list-file F  Use captured 'codex plugin list' text\n` +
    `  --write               Write owner-local files (default)\n` +
    `  --no-write            Print summary without owner-local files\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(usage()); return; }
  const catalog = buildCatalog(options);
  const stateRoot = path.resolve(options.stateRoot || process.env.AICC_STATE_ROOT || path.join(os.homedir(), '.ai-control-center'));
  const jsonPath = path.join(stateRoot, 'inventory', 'skill-catalog.json');
  const markdownPath = path.join(stateRoot, 'reports', 'skill-map.md');
  if (!options.noWrite) {
    writePrivateAtomic(jsonPath, `${JSON.stringify(catalog, null, 2)}\n`);
    writePrivateAtomic(markdownPath, renderMarkdown(catalog));
  }
  process.stdout.write(`${JSON.stringify({ ok: true, summary: catalog.summary, duplicateNameCount: catalog.duplicateNames.length, effectiveDuplicateNameCount: catalog.summary.effectiveDuplicateNameCount, written: options.noWrite ? [] : [jsonPath, markdownPath] }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
