#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const guardMarker = '# Managed by AICC OpenAI API guard';

function regularDirectories(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(root, entry.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function walk(root, options = {}) {
  const results = [];
  const maxDepth = options.maxDepth ?? 6;
  function visit(current, depth) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EACCES') return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && depth < maxDepth) visit(candidate, depth + 1);
      else if (entry.isFile()) results.push(candidate);
    }
  }
  visit(root, 0);
  return results;
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

function directorySize(root) {
  return walk(root, { maxDepth: 16 }).reduce((total, file) => total + fileSize(file), 0);
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function tomlString(raw) {
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return null;
}

function trustedProjects(config) {
  const projects = [];
  let currentProject = null;
  let currentTrust = null;
  const flush = () => {
    if (currentProject && currentTrust === 'trusted') projects.push(currentProject);
    currentProject = null;
    currentTrust = null;
  };
  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      flush();
      const match = trimmed.match(/^\[projects\.("(?:[^"\\]|\\.)*"|'[^']*')\]$/);
      if (match) currentProject = tomlString(match[1]);
      continue;
    }
    if (!currentProject) continue;
    const trust = trimmed.match(/^trust_level\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
    if (trust) currentTrust = tomlString(trust[1]);
  }
  flush();
  return projects;
}

function rootTomlString(config, key) {
  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) break;
    const match = trimmed.match(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`));
    if (match) return tomlString(match[1]);
  }
  return null;
}

export function isWindowsDriveRoot(value) {
  const raw = String(value).trim();
  if (!/^[A-Za-z]:[\\/]/.test(raw)) return false;
  const normalized = path.win32.normalize(raw);
  return path.win32.parse(normalized).root === normalized;
}

function hasFeatureOverride(config, key, expected) {
  let inFeatures = false;
  for (const line of config.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inFeatures = trimmed === '[features]';
      continue;
    }
    if (inFeatures && new RegExp(`^${key}\\s*=\\s*${expected}\\s*(?:#.*)?$`).test(trimmed)) return true;
  }
  return false;
}

function configuredGuardHook(requirements) {
  const literal = requirements.match(/^command\s*=\s*("(?:\\.|[^"\\])*")\s*$/m);
  if (!literal) return null;
  let command;
  try {
    command = JSON.parse(literal[1]);
  } catch {
    return null;
  }
  const quoted = command.match(/["']([^"']*openai_api_guard_hook\.py)["']/);
  if (quoted) return quoted[1];
  return command.split(/\s+/).find(part => part.endsWith('openai_api_guard_hook.py')) ?? null;
}

function skillName(file) {
  const match = read(file).match(/^---\s*\n[\s\S]*?^name:\s*["']?([^\s"']+)["']?\s*$/m);
  return match?.[1] ?? null;
}

function addSkill(map, name, file) {
  if (!map.has(name)) map.set(name, []);
  map.get(name).push(file);
}

function skillInventory(codexHome) {
  const standalone = new Map();
  const plugin = new Map();
  for (const file of walk(path.join(codexHome, 'skills'), { maxDepth: 4 })) {
    if (path.basename(file) !== 'SKILL.md') continue;
    const name = skillName(file);
    if (name) addSkill(standalone, name, file);
  }
  for (const file of walk(path.join(codexHome, 'plugins', 'cache'), { maxDepth: 9 })) {
    if (path.basename(file) !== 'SKILL.md' || !file.split(path.sep).includes('skills')) continue;
    const name = skillName(file);
    if (name) addSkill(plugin, name, file);
  }
  const duplicateNames = [...standalone.keys()].filter(name => plugin.has(name)).sort();
  return { standaloneCount: standalone.size, pluginCount: plugin.size, duplicateNames };
}

function xmlDecode(value) {
  return value.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

function launchAgentProgram(file) {
  const text = read(file);
  const match = text.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>\s*<string>([^<]+)<\/string>/s);
  return match ? xmlDecode(match[1].trim()) : null;
}

function symlinkStatus(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isSymbolicLink()) return null;
    return { path: file, target: fs.readlinkSync(file), broken: !fs.existsSync(file) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function issue(severity, code, message, paths = []) {
  return { severity, code, message, paths };
}

export function auditCodexHome(options = {}) {
  const home = path.resolve(options.home || os.homedir());
  const codexHome = path.resolve(options.codexHome || path.join(home, '.codex'));
  const aiccRoot = path.resolve(options.aiccRoot || sourceRoot);
  const expectedGuardHook = path.join(aiccRoot, 'tools', 'platform', 'codex', 'openai_api_guard_hook.py');
  const accountHomes = regularDirectories(path.join(home, '.codex-multi', 'homes'));
  const now = options.now ?? Date.now();
  const targetPlatform = options.platform ?? process.platform;
  const staleBefore = now - (options.staleDays ?? 7) * 24 * 60 * 60 * 1000;
  const issues = [];
  const configFile = path.join(codexHome, 'config.toml');
  const config = read(configFile);
  if (!config) issues.push(issue('error', 'config_missing', 'Codex config.toml is missing or empty.', [configFile]));

  const projects = trustedProjects(config);
  const missingProjects = projects.filter(project => !fs.existsSync(project));
  const temporaryRoots = new Set([os.tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp', '/private/tmp'])].map(project => path.resolve(project)));
  const unsafeTemporaryTrust = projects.filter(project => temporaryRoots.has(path.resolve(project)));
  const broadHomeTrust = projects.filter(project => path.resolve(project) === home);
  const windowsDriveRootTrust = targetPlatform === 'win32' ? projects.filter(isWindowsDriveRoot) : [];
  if (missingProjects.length) issues.push(issue('warning', 'stale_trusted_projects', `${missingProjects.length} trusted project paths no longer exist.`, missingProjects));
  if (unsafeTemporaryTrust.length) issues.push(issue('error', 'temporary_root_trusted', 'A shared temporary root is trusted; recreated content can inherit trusted-project behavior.', unsafeTemporaryTrust));
  if (broadHomeTrust.length) issues.push(issue('warning', 'home_root_trusted', 'The whole user home is trusted, which is broader than repository-scoped trust.', broadHomeTrust));
  if (windowsDriveRootTrust.length) issues.push(issue('error', 'windows_drive_root_trusted', 'An entire Windows drive root is trusted; restrict trust to specific repository directories.', windowsDriveRootTrust));
  if (hasFeatureOverride(config, 'js_repl', 'false')) issues.push(issue('info', 'removed_feature_override', 'The removed js_repl feature still has an explicit override.', [configFile]));
  if (rootTomlString(config, 'approval_policy') === 'never' && rootTomlString(config, 'sandbox_mode') === 'danger-full-access') {
    issues.push(issue('warning', 'unrestricted_without_approval', 'The global default combines unrestricted filesystem access with no approval prompts.', [configFile]));
  }

  for (const target of [codexHome, ...accountHomes]) {
    const requirementsFile = path.join(target, 'requirements.toml');
    const requirements = read(requirementsFile);
    if (!requirements.includes(guardMarker)) continue;
    const configuredHook = configuredGuardHook(requirements);
    if (!configuredHook || !fs.existsSync(configuredHook)) issues.push(issue('error', 'guard_hook_missing', 'An AICC-managed OpenAI guard references a missing hook.', [requirementsFile, ...(configuredHook ? [configuredHook] : [])]));
    if (configuredHook && path.resolve(configuredHook) !== expectedGuardHook) issues.push(issue('warning', 'guard_source_drift', 'The managed OpenAI guard points at a different AICC checkout.', [requirementsFile, configuredHook, expectedGuardHook]));
  }

  const emptyRollouts = [...walk(path.join(codexHome, 'sessions'), { maxDepth: 5 }), ...walk(path.join(codexHome, 'archived_sessions'), { maxDepth: 2 })]
    .filter(file => file.endsWith('.jsonl') && fileSize(file) === 0 && fs.statSync(file).mtimeMs < staleBefore);
  if (emptyRollouts.length) issues.push(issue('warning', 'empty_rollouts', `${emptyRollouts.length} old rollout files are empty and cannot contain recoverable thread history.`, emptyRollouts));

  const staleStateTemps = walk(codexHome, { maxDepth: 0 }).filter(file => {
    const name = path.basename(file);
    return name.startsWith('..codex-global-state.json.tmp-') && fs.statSync(file).mtimeMs < staleBefore;
  });
  if (staleStateTemps.length) issues.push(issue('warning', 'stale_state_temps', `${staleStateTemps.length} abandoned global-state temporary files are older than the retention threshold.`, staleStateTemps));

  const launchAgent = path.join(home, 'Library', 'LaunchAgents', 'com.codex-account-manager.auth-sync.plist');
  const launchProgram = launchAgentProgram(launchAgent);
  if (launchProgram && path.isAbsolute(launchProgram) && !fs.existsSync(launchProgram)) issues.push(issue('error', 'broken_auth_sync_launcher', 'The cm auth-sync LaunchAgent executable does not exist.', [launchAgent, launchProgram]));

  const launcherLinks = ['codex', 'cm', 'aicc'].map(name => symlinkStatus(path.join(home, '.local', 'bin', name))).filter(Boolean);
  for (const link of launcherLinks.filter(item => item.broken)) issues.push(issue('error', 'broken_cli_symlink', 'A primary CLI shortcut is a broken symlink.', [link.path, link.target]));

  const skills = skillInventory(codexHome);
  if (skills.duplicateNames.length) issues.push(issue('warning', 'duplicate_skill_exposure', 'The same skill name is exposed both standalone and through a plugin.', skills.duplicateNames));

  const localBackups = accountHomes.flatMap(target => walk(target, { maxDepth: 1 }).filter(file => path.basename(file).includes('.local-backup-')));
  if (localBackups.length) issues.push(issue('info', 'account_local_backups', `${localBackups.length} account-local recovery copies remain; retain or prune only through Account Manager ownership.`));

  const worktreeRoot = path.join(codexHome, 'worktrees');
  const managedWorktrees = regularDirectories(worktreeRoot);
  if (managedWorktrees.length) issues.push(issue('info', 'managed_worktrees', `${managedWorktrees.length} Codex-managed worktree roots exist; archive their owning tasks before removal.`, managedWorktrees));

  const releaseRoot = path.join(codexHome, 'packages', 'standalone', 'releases');
  const releases = regularDirectories(releaseRoot);
  if (releases.length > 2) issues.push(issue('warning', 'excess_cli_releases', `${releases.length} standalone Codex releases are retained; current plus one rollback release is normally sufficient.`, releases));

  const facts = {
    codexHome,
    accountHomeCount: accountHomes.length,
    trustedProjectCount: projects.length,
    missingTrustedProjectCount: missingProjects.length,
    emptyRolloutCount: emptyRollouts.length,
    staleStateTempCount: staleStateTemps.length,
    standaloneSkillCount: skills.standaloneCount,
    pluginSkillCount: skills.pluginCount,
    duplicateSkillNames: skills.duplicateNames,
    managedWorktreeCount: managedWorktrees.length,
    standaloneReleaseCount: releases.length,
    sizes: options.measureSizes === false ? null : {
      activeSessions: directorySize(path.join(codexHome, 'sessions')),
      archivedSessions: directorySize(path.join(codexHome, 'archived_sessions')),
      logsDatabase: fileSize(path.join(codexHome, 'logs_2.sqlite')),
      plugins: directorySize(path.join(codexHome, 'plugins')),
      packages: directorySize(path.join(codexHome, 'packages')),
      worktrees: directorySize(worktreeRoot)
    }
  };
  if ((facts.sizes?.logsDatabase ?? 0) >= 1024 ** 3) issues.push(issue('info', 'large_owner_managed_log_db', 'The Codex log database exceeds 1 GiB; compact it only with owner-supported exclusive-writer tooling.', [path.join(codexHome, 'logs_2.sqlite')]));

  const counts = Object.fromEntries(['error', 'warning', 'info'].map(severity => [severity, issues.filter(item => item.severity === severity).length]));
  return { ok: counts.error === 0, state: counts.error ? 'blocked' : counts.warning ? 'attention' : 'ready', counts, facts, issues };
}

function parseArgs(argv) {
  const result = { json: false };
  const valueAfter = index => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argv[index]}`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json') result.json = true;
    else if (argv[index] === '--home') result.home = valueAfter(index++);
    else if (argv[index] === '--codex-home') result.codexHome = valueAfter(index++);
    else if (argv[index] === '--aicc-root') result.aiccRoot = valueAfter(index++);
    else if (argv[index] === '--skip-sizes') result.measureSizes = false;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return result;
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = auditCodexHome(options);
    process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : `${report.state}: ${report.counts.error} errors, ${report.counts.warning} warnings, ${report.counts.info} info\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Codex home audit failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}
