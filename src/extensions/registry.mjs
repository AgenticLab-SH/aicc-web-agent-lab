import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const EXTENSION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const REQUIRED_TOOLS = ['plan_run', 'start_role', 'wait_role', 'submit_result', 'request_writer', 'status', 'cancel_run', 'cleanup_run'];

export class ExtensionRegistryError extends Error {
  constructor(code, message) { super(message); this.name = 'ExtensionRegistryError'; this.code = code; }
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new ExtensionRegistryError('invalid_extension', `${label} is required`);
  return value.trim();
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function confined(root, relative, label) {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0')) throw new ExtensionRegistryError('invalid_path', `${label} must be repository-relative`);
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw new ExtensionRegistryError('invalid_path', `${label} escapes the repository`);
  return target;
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new ExtensionRegistryError('symlink_prohibited', `extension package contains a symlink: ${absolute}`);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function parseChecksums(file) {
  const records = new Map();
  for (const [index, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})  ([^\0]+)$/);
    if (!match || path.isAbsolute(match[2]) || match[2].split('/').includes('..')) throw new ExtensionRegistryError('invalid_integrity', `invalid checksum line ${index + 1}`);
    if (records.has(match[2])) throw new ExtensionRegistryError('invalid_integrity', `duplicate checksum path: ${match[2]}`);
    records.set(match[2], match[1]);
  }
  if (!records.size) throw new ExtensionRegistryError('invalid_integrity', 'checksum manifest is empty');
  return records;
}

function secretScan(packageRoot, files) {
  const hits = [];
  const binary = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip']);
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /(?:^|[^A-Za-z])sk-[A-Za-z0-9_-]{20,}/,
    /(?:bearer|password|secret|api[_-]?key)\s*[:=]\s*["'][^"']{12,}["']/i,
    /\/Users\/[^/\s]+\/(?:\.codex|\.ai-control-center|Library\/Application Support)/
  ];
  for (const file of files) {
    if (binary.has(path.extname(file).toLowerCase())) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (patterns.some(pattern => pattern.test(text))) hits.push(path.relative(packageRoot, file).split(path.sep).join('/'));
  }
  return hits;
}

function validatePlugin(packageRoot, entry) {
  const manifestPath = path.join(packageRoot, '.codex-plugin', 'plugin.json');
  const mcpPath = path.join(packageRoot, '.mcp.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  if (manifest.name !== entry.id || manifest.version !== entry.source.version || !SEMVER.test(manifest.version)) throw new ExtensionRegistryError('invalid_manifest', 'plugin name/version does not match the registry');
  if (manifest.mcpServers !== './.mcp.json' || manifest.skills !== './skills/') throw new ExtensionRegistryError('invalid_manifest', 'plugin paths must use the canonical relative layout');
  const server = mcp.mcpServers?.['web-gpt-orchestrator'];
  if (server?.command !== 'aicc' || JSON.stringify(server.args) !== JSON.stringify(['orchestration', 'mcp']) || server.cwd !== '.') {
    throw new ExtensionRegistryError('invalid_manifest', 'plugin MCP must use the public AICC orchestration command');
  }
  const skill = path.join(packageRoot, 'skills', 'web-gpt-orchestrator', 'SKILL.md');
  if (!fs.statSync(skill).isFile()) throw new ExtensionRegistryError('invalid_manifest', 'plugin skill is missing');
  return { manifest, mcp };
}

export function validateExtensionPackage(root, entry, options = {}) {
  const packageRoot = options.packageRoot ?? confined(root, entry.source.path, 'extension source path');
  const checksumPath = options.checksumPath ?? confined(root, entry.integrity, 'integrity path');
  const packageStat = fs.lstatSync(packageRoot);
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) throw new ExtensionRegistryError('invalid_package', 'extension package must be a real directory');
  const expected = parseChecksums(checksumPath);
  const files = walk(packageRoot).filter(file => path.resolve(file) !== path.resolve(checksumPath));
  const actualPaths = files.map(file => path.relative(packageRoot, file).split(path.sep).join('/')).sort();
  assertSameSet(actualPaths, [...expected.keys()].sort(), 'checksum manifest does not cover the exact package file set');
  for (const relative of actualPaths) {
    const observed = hashFile(path.join(packageRoot, relative));
    if (observed !== expected.get(relative)) throw new ExtensionRegistryError('integrity_mismatch', `checksum mismatch: ${relative}`);
  }
  const hits = secretScan(packageRoot, files);
  if (hits.length) throw new ExtensionRegistryError('public_secret_scan_failed', `secret-like content in public package: ${hits.join(', ')}`);
  const plugin = entry.type === 'codex-plugin' ? validatePlugin(packageRoot, entry) : null;
  return {
    ok: true,
    id: entry.id,
    version: entry.source.version,
    packageRoot,
    fileCount: files.length,
    digest: hashFile(checksumPath),
    secretScan: 'pass',
    plugin
  };
}

function assertSameSet(left, right, message) {
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) throw new ExtensionRegistryError('integrity_coverage', message);
}

function validateEntry(root, entry) {
  const id = requireString(entry?.id, 'extension id');
  if (!EXTENSION_ID.test(id)) throw new ExtensionRegistryError('invalid_extension', `invalid extension id: ${id}`);
  if (entry.type !== 'codex-plugin') throw new ExtensionRegistryError('invalid_extension', `unsupported extension type: ${entry.type}`);
  requireString(entry.owner, 'extension owner');
  if (entry.distribution !== 'public') throw new ExtensionRegistryError('invalid_extension', 'public registry entries must be public');
  if (entry.license !== 'MIT') throw new ExtensionRegistryError('invalid_extension', 'extension license must be explicitly compatible');
  if (!SEMVER.test(requireString(entry.source?.version, 'extension version'))) throw new ExtensionRegistryError('invalid_extension', 'extension version must be strict semver');
  if (!/^https:\/\//.test(requireString(entry.source?.url, 'source URL'))) throw new ExtensionRegistryError('invalid_extension', 'source URL must use HTTPS');
  requireString(entry.source?.revision, 'source revision');
  for (const key of ['notice', 'sbom', 'integrity']) {
    const file = confined(root, entry[key], key);
    if (!fs.statSync(file).isFile()) throw new ExtensionRegistryError('invalid_extension', `${key} file is missing`);
  }
  for (const key of ['filesystem', 'network', 'browser', 'secrets', 'tools']) if (!Array.isArray(entry.permissions?.[key])) throw new ExtensionRegistryError('invalid_extension', `permissions.${key} must be an array`);
  assertSameSet([...entry.permissions.tools].sort(), [...REQUIRED_TOOLS].sort(), 'orchestrator tool permission list is incomplete');
  for (const key of ['install', 'enable', 'disable', 'update', 'uninstall', 'rollback']) requireString(entry.lifecycle?.[key], `lifecycle.${key}`);
  if (!Array.isArray(entry.health?.command) || entry.health.command.some(value => typeof value !== 'string') || entry.health.mcpToolCount !== 8) throw new ExtensionRegistryError('invalid_extension', 'extension health contract is invalid');
  return validateExtensionPackage(root, entry);
}

function validateMarketplace(root) {
  const file = path.join(root, '.agents', 'plugins', 'marketplace.json');
  const marketplace = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (marketplace.name !== 'aicc-local' || marketplace.interface?.displayName !== 'AICC Local') throw new ExtensionRegistryError('invalid_marketplace', 'AICC marketplace identity is invalid');
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) throw new ExtensionRegistryError('invalid_marketplace', 'AICC marketplace must expose exactly the packaged orchestrator');
  const item = marketplace.plugins[0];
  if (item.name !== 'web-gpt-orchestrator' || item.source?.source !== 'local' || item.source?.path !== './plugins/web-gpt-orchestrator') throw new ExtensionRegistryError('invalid_marketplace', 'orchestrator marketplace source is invalid');
  if (item.policy?.installation !== 'AVAILABLE' || item.policy?.authentication !== 'ON_INSTALL' || item.category !== 'Developer Tools') throw new ExtensionRegistryError('invalid_marketplace', 'orchestrator marketplace policy is invalid');
  return { name: marketplace.name, displayName: marketplace.interface.displayName, pluginCount: marketplace.plugins.length };
}

export class ExtensionRegistry {
  constructor({ root = DEFAULT_ROOT, file = path.join(root, 'extensions', 'registry.json') } = {}) {
    this.root = path.resolve(root);
    this.file = path.resolve(file);
  }

  load() {
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.extensions)) throw new ExtensionRegistryError('invalid_registry', 'extension registry schema is invalid');
    const ids = new Set();
    for (const entry of parsed.extensions) {
      if (ids.has(entry.id)) throw new ExtensionRegistryError('invalid_registry', `duplicate extension: ${entry.id}`);
      ids.add(entry.id);
    }
    return parsed;
  }

  validate() {
    const registry = this.load();
    const extensions = registry.extensions.map(entry => validateEntry(this.root, entry));
    const marketplace = validateMarketplace(this.root);
    return { ok: true, schemaVersion: registry.schemaVersion, extensionCount: extensions.length, marketplace, extensions };
  }

  entry(id) {
    const entry = this.load().extensions.find(item => item.id === id);
    if (!entry) throw new ExtensionRegistryError('extension_not_found', `unknown extension: ${id}`);
    return entry;
  }
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows ACL */ }
}

function atomicJson(file, value) {
  privateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACL */ }
}

export class ExtensionManager {
  constructor({ registry = new ExtensionRegistry(), installRoot, now = () => Date.now() } = {}) {
    if (!installRoot || !path.isAbsolute(installRoot)) throw new ExtensionRegistryError('invalid_install_root', 'extension install root must be absolute');
    const resolved = path.resolve(installRoot);
    if (resolved === path.parse(resolved).root || resolved === os.homedir()) throw new ExtensionRegistryError('invalid_install_root', 'extension install root is too broad');
    this.registry = registry;
    this.installRoot = resolved;
    this.stateFile = path.join(resolved, 'state.json');
    this.now = now;
    privateDirectory(resolved);
  }

  #read() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, extensions: {} }; throw error; }
  }

  #write(state) { atomicJson(this.stateFile, state); }

  install(id) {
    const entry = this.registry.entry(id);
    const verified = validateEntry(this.registry.root, entry);
    const destination = path.join(this.installRoot, 'packages', id, entry.source.version, verified.digest.slice(0, 16));
    if (!fs.existsSync(destination)) {
      const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
      privateDirectory(path.dirname(temporary));
      fs.cpSync(verified.packageRoot, temporary, { recursive: true, errorOnExist: true, force: false });
      validateExtensionPackage(this.registry.root, entry, { packageRoot: temporary, checksumPath: path.join(temporary, 'checksums.sha256') });
      fs.renameSync(temporary, destination);
    }
    const state = this.#read();
    const previous = state.extensions[id];
    if (previous?.digest === verified.digest && previous?.version === entry.source.version) return { ok: true, duplicate: true, ...previous };
    const history = [...(previous?.history ?? [])];
    if (previous) history.push({ version: previous.version, digest: previous.digest, packagePath: previous.packagePath, enabled: previous.enabled });
    state.extensions[id] = {
      id,
      version: entry.source.version,
      digest: verified.digest,
      packagePath: destination,
      enabled: true,
      installedAt: new Date(this.now()).toISOString(),
      history
    };
    this.#write(state);
    return { ok: true, duplicate: false, ...state.extensions[id] };
  }

  setEnabled(id, enabled) {
    const state = this.#read();
    const current = state.extensions[id];
    if (!current) throw new ExtensionRegistryError('not_installed', `extension is not installed: ${id}`);
    current.enabled = Boolean(enabled);
    current.updatedAt = new Date(this.now()).toISOString();
    this.#write(state);
    return { ok: true, id, enabled: current.enabled, version: current.version, digest: current.digest };
  }

  rollback(id) {
    const state = this.#read();
    const current = state.extensions[id];
    if (!current || !current.history.length) throw new ExtensionRegistryError('rollback_unavailable', `no verified rollback is available: ${id}`);
    const restored = current.history.pop();
    if (!fs.existsSync(restored.packagePath)) throw new ExtensionRegistryError('rollback_missing', 'verified rollback package is missing');
    current.history.push({ version: current.version, digest: current.digest, packagePath: current.packagePath, enabled: current.enabled });
    Object.assign(current, restored, { rolledBackAt: new Date(this.now()).toISOString() });
    this.#write(state);
    return { ok: true, id, version: current.version, digest: current.digest, enabled: current.enabled };
  }

  uninstall(id) {
    const state = this.#read();
    const current = state.extensions[id];
    if (!current) return { ok: true, id, removed: false, recoverable: true };
    const quarantineRoot = path.join(this.installRoot, 'quarantine');
    privateDirectory(quarantineRoot);
    const quarantinePath = path.join(quarantineRoot, `${id}-${this.now()}`);
    fs.renameSync(current.packagePath, quarantinePath);
    delete state.extensions[id];
    state.quarantine ??= [];
    state.quarantine.push({ id, version: current.version, digest: current.digest, path: quarantinePath, at: new Date(this.now()).toISOString() });
    this.#write(state);
    return { ok: true, id, removed: true, recoverable: true, quarantinePath };
  }

  status(id = null) {
    const state = this.#read();
    if (id) return state.extensions[id] ? { ok: true, installed: true, ...state.extensions[id] } : { ok: true, installed: false, id };
    return { ok: true, installed: Object.keys(state.extensions).length, extensions: Object.values(state.extensions), quarantined: state.quarantine?.length ?? 0 };
  }
}

export const __testing = { parseChecksums, secretScan, confined, walk, hashFile, validatePlugin, validateMarketplace };
