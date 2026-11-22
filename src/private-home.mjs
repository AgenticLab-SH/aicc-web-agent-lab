import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MANIFEST = 'private-home.json';
const EXTERNAL_STATE = 'inventory/external-state.json';
const MOVABLE_FILES = Object.freeze([
  'config.env',
  'workspace-mcp/config.json',
  'workspace-mcp/publish-state.json',
  'jobs/state.json',
  'jobs/journal.jsonl',
  'extensions/state.json',
  'compatibility/state.json',
  'openai-usage/usage.json',
  'openai-usage/projects.json',
  'openai-usage/provider.json',
  'openai-usage/model-probes.json',
  'openai-usage/catalog-probe.json',
  'openai-usage/monitor.json',
  'openai-usage/catalog-check.json',
  'openai-usage/eligibility.json'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ownerOnly(stat) {
  return process.platform === 'win32' || (stat.mode & 0o077) === 0;
}

function confinedAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error(`${label} cannot be a filesystem root`);
  return resolved;
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`private home directory must be a real directory: ${directory}`);
  if (!ownerOnly(stat)) fs.chmodSync(directory, 0o700);
}

function privateWrite(file, value, mode = 0o600) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, value, { encoding: 'utf8', mode });
  if (process.platform !== 'win32') fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, mode);
}

function fileRecord(root, relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`movable private state must be a real file: ${relative}`);
  if (!ownerOnly(stat)) throw new Error(`movable private state must be owner-only: ${relative}`);
  const bytes = fs.readFileSync(file);
  return { relative, bytes, size: bytes.length, sha256: sha256(bytes), mode: stat.mode & 0o777 };
}

function externalStateInventory(home, exists = fs.existsSync, options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const localAppData = environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roamingAppData = environment.APPDATA || path.join(home, 'AppData', 'Roaming');
  const entries = platform === 'win32' ? [
    ['codex-desktop', path.join(roamingAppData, 'Codex'), 'OpenAI Codex Desktop', 'auth-session-database', 'official relocation unsupported'],
    ['codex-home', path.join(home, '.codex'), 'OpenAI Codex', 'auth-session-account-database', 'do not move or symlink; use Codex configuration and plugin interfaces'],
    ['claude-home', path.join(home, '.claude'), 'Claude', 'auth-session-account-state', 'do not move or symlink; deploy only declared AICC guidance'],
    ['ocx-home', path.join(home, '.opencodex'), 'OpenCodex', 'oauth-account-provider-state', 'component owner backup and restore only'],
    ['web-gpt-home', path.join(home, '.codex-chatgpt-web'), 'Codex Web GPT private adapter', 'browser-session-runtime-key', 'private adapter installer and owner backup only'],
    ['chrome-profile', path.join(localAppData, 'Google', 'Chrome', 'User Data'), 'Google Chrome', 'browser-profile-cookie-extension', 'browser-owned backup and erase workflow only'],
    ['whale-profile', path.join(localAppData, 'Naver', 'Naver Whale', 'User Data'), 'Naver Whale', 'browser-profile-cookie-extension', 'browser-owned backup and erase workflow only'],
    ['windows-credential-manager', null, 'Windows Credential Manager', 'raw-secret', 'never exported or erased by AICC']
  ] : [
    ['codex-desktop', path.join(home, 'Library', 'Application Support', 'Codex'), 'OpenAI Codex Desktop', 'auth-session-database', 'official relocation unsupported'],
    ['codex-home', path.join(home, '.codex'), 'OpenAI Codex', 'auth-session-account-database', 'do not move or symlink; use Codex configuration and plugin interfaces'],
    ['claude-home', path.join(home, '.claude'), 'Claude', 'auth-session-account-state', 'do not move or symlink; deploy only declared AICC guidance'],
    ['ocx-home', path.join(home, '.opencodex'), 'OpenCodex', 'oauth-account-provider-state', 'component owner backup and restore only'],
    ['web-gpt-home', path.join(home, '.codex-chatgpt-web'), 'Codex Web GPT private adapter', 'browser-session-runtime-key', 'private adapter installer and owner backup only'],
    ['chrome-profile', path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'), 'Google Chrome', 'browser-profile-cookie-extension', 'browser-owned backup and erase workflow only'],
    ['whale-profile', path.join(home, 'Library', 'Application Support', 'Naver', 'Whale'), 'Naver Whale', 'browser-profile-cookie-extension', 'browser-owned backup and erase workflow only'],
    ['macos-keychain', null, 'macOS Keychain', 'raw-secret', 'never exported or erased by AICC']
  ];
  return {
    schemaVersion: 1,
    policy: 'inventory-only-no-relocation-no-symlink',
    entries: entries.map(([id, itemPath, owner, sensitivity, procedure]) => ({
      id,
      owner,
      path: itemPath,
      exists: itemPath === null ? null : exists(itemPath),
      sensitivity,
      movableByAicc: false,
      backup: procedure,
      erase: procedure
    }))
  };
}

export function resolvePrivateHome(options = {}) {
  const home = options.home ?? os.homedir();
  const configured = options.stateRoot ?? options.env?.AICC_STATE_ROOT ?? process.env.AICC_STATE_ROOT;
  return {
    root: confinedAbsolute(configured?.trim() || path.join(home, '.ai-control-center'), 'AICC private home'),
    selection: configured?.trim() ? 'user-selected' : 'os-user-default',
    home
  };
}

export function initializePrivateHome(options = {}) {
  const resolved = resolvePrivateHome(options);
  ensurePrivateDirectory(resolved.root);
  for (const relative of ['backups', 'jobs', 'artifacts', 'inventory']) ensurePrivateDirectory(path.join(resolved.root, relative));
  const manifest = {
    schemaVersion: 1,
    selection: resolved.selection,
    root: resolved.root,
    permissions: 'owner-only',
    movableFiles: [...MOVABLE_FILES],
    excludedNamespaces: ['account-manager-auth', 'browser', 'notification-credentials', 'workspace-mcp/secrets'],
    externalState: EXTERNAL_STATE,
    rawSecrets: 'keychain-or-component-secret-store-only'
  };
  const inventory = externalStateInventory(resolved.home, options.exists, options);
  privateWrite(path.join(resolved.root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  privateWrite(path.join(resolved.root, EXTERNAL_STATE), `${JSON.stringify(inventory, null, 2)}\n`);
  return privateHomeStatus({ ...options, stateRoot: resolved.root });
}

export function privateHomeStatus(options = {}) {
  const resolved = resolvePrivateHome(options);
  const manifestPath = path.join(resolved.root, MANIFEST);
  const externalStatePath = path.join(resolved.root, EXTERNAL_STATE);
  const rootStat = fs.existsSync(resolved.root) ? fs.lstatSync(resolved.root) : null;
  const manifestStat = fs.existsSync(manifestPath) ? fs.lstatSync(manifestPath) : null;
  const externalStat = fs.existsSync(externalStatePath) ? fs.lstatSync(externalStatePath) : null;
  let manifest = null;
  let external = null;
  try { if (manifestStat?.isFile()) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
  try { if (externalStat?.isFile()) external = JSON.parse(fs.readFileSync(externalStatePath, 'utf8')); } catch {}
  const ok = Boolean(
    rootStat?.isDirectory() && !rootStat.isSymbolicLink() && ownerOnly(rootStat)
    && manifest?.schemaVersion === 1 && manifest.root === resolved.root
    && manifestStat?.isFile() && !manifestStat.isSymbolicLink() && ownerOnly(manifestStat)
    && external?.schemaVersion === 1 && external.policy === 'inventory-only-no-relocation-no-symlink'
    && externalStat?.isFile() && !externalStat.isSymbolicLink() && ownerOnly(externalStat)
  );
  return {
    ok,
    root: resolved.root,
    selection: manifest?.selection ?? resolved.selection,
    ownerOnly: rootStat ? ownerOnly(rootStat) : false,
    manifestPath,
    externalStatePath,
    movableFileCount: MOVABLE_FILES.length,
    presentMovableFiles: MOVABLE_FILES.filter(relative => fs.existsSync(path.join(resolved.root, relative))).length,
    externalEntries: Array.isArray(external?.entries) ? external.entries.length : 0,
    migrationRequired: !ok
  };
}

export function backupPrivateHome(options = {}) {
  const status = privateHomeStatus(options);
  if (!status.ok) throw new Error('private home must be initialized and owner-only before backup');
  const stamp = String(options.label ?? new Date().toISOString().replaceAll(':', '-'));
  if (!/^[A-Za-z0-9._-]+$/.test(stamp)) throw new Error('private home backup label is unsafe');
  const destination = confinedAbsolute(options.destination ?? path.join(status.root, 'backups', 'private-home', stamp), 'private home backup');
  if (destination === status.root || destination.startsWith(`${status.root}${path.sep}`) && !destination.startsWith(path.join(status.root, 'backups', 'private-home') + path.sep)) {
    throw new Error('private home backup destination must be the dedicated backup namespace or outside the private home');
  }
  if (fs.existsSync(destination)) throw new Error(`private home backup already exists: ${destination}`);
  ensurePrivateDirectory(destination);
  const records = [];
  for (const relative of MOVABLE_FILES) {
    const record = fileRecord(status.root, relative);
    if (!record) continue;
    const target = path.join(destination, 'files', relative);
    ensurePrivateDirectory(path.dirname(target));
    fs.writeFileSync(target, record.bytes, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
    records.push({ relative, size: record.size, sha256: record.sha256, mode: '0600' });
  }
  const manifest = {
    schemaVersion: 1,
    sourceRootHash: sha256(status.root),
    files: records,
    exclusions: ['raw secrets', 'credentials', 'browser profiles', 'account databases', 'notification credentials', 'workspace-mcp/secrets']
  };
  privateWrite(path.join(destination, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: true, destination, fileCount: records.length, files: records, rawSecretsCopied: false };
}

export function rehearsePrivateHomeRestore(options = {}) {
  const backup = confinedAbsolute(options.backup, 'private home backup');
  const manifestPath = path.join(backup, 'backup-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('private home backup manifest is invalid');
  const rehearsalRoot = fs.mkdtempSync(path.join(options.tempRoot ?? os.tmpdir(), 'aicc-private-home-restore-'));
  let verified = 0;
  try {
    for (const record of manifest.files) {
      if (typeof record.relative !== 'string'
        || path.isAbsolute(record.relative)
        || path.normalize(record.relative) !== record.relative
        || record.relative.split(path.sep).some(part => part === '' || part === '.' || part === '..')
        || !/^[A-Za-z0-9._/-]+$/.test(record.relative)) {
        throw new Error('private home backup contains an unsafe path');
      }
      const source = path.join(backup, 'files', record.relative);
      const bytes = fs.readFileSync(source);
      if (sha256(bytes) !== record.sha256 || bytes.length !== record.size) throw new Error(`private home backup hash mismatch: ${record.relative}`);
      const target = path.join(rehearsalRoot, record.relative);
      ensurePrivateDirectory(path.dirname(target));
      fs.writeFileSync(target, bytes, { mode: 0o600 });
      if (sha256(fs.readFileSync(target)) !== record.sha256) throw new Error(`private home restore verification failed: ${record.relative}`);
      verified += 1;
    }
    return { ok: true, verified, rawSecretsRestored: false, rehearsalRootRemoved: true };
  } finally {
    fs.rmSync(rehearsalRoot, { recursive: true, force: true });
  }
}

export function privateHomeErasePlan(options = {}) {
  const status = privateHomeStatus(options);
  return {
    ok: status.ok,
    mode: 'plan-only',
    approvalRequired: true,
    exactTargets: MOVABLE_FILES.filter(relative => fs.existsSync(path.join(status.root, relative))),
    excluded: ['external-state entries', 'Keychain', 'browser profiles', 'auth/session/account databases', 'raw secrets'],
    deletionPerformed: false
  };
}

export const PRIVATE_HOME_MOVABLE_FILES = MOVABLE_FILES;
