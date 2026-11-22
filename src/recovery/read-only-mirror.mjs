import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_INPUT_BYTES = 1_048_576;
const WEB_GPT_URL = 'http://127.0.0.1:17841/v1';
const OCX_URL = 'http://127.0.0.1:10100/v1';
const NATIVE_URL = 'https://chatgpt.com/backend-api/codex';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function inside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function requireInside(root, file, label) {
  if (!inside(root, file)) throw new Error(`${label}_outside_owner_root`);
  return path.resolve(file);
}

function tomlString(text, key) {
  return String(text).match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm'))?.[1] ?? null;
}

function routeKind(url) {
  if (!url || url === NATIVE_URL) return 'native';
  if (url === WEB_GPT_URL) return 'web-gpt';
  if (url === OCX_URL) return 'ocx';
  return 'custom';
}

function configSummary(bytes, native = false) {
  const route = tomlString(bytes.toString('utf8'), 'openai_base_url');
  return native
    ? { officialEndpoint: route === NATIVE_URL, routeKind: routeKind(route), routeHash: route ? sha256(route) : null }
    : { routeKind: routeKind(route), routeHash: route ? sha256(route) : null };
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function enumOrNull(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function hashOrNull(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function timestampOrNull(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) ? value : null;
}

function countBy(items, selector, allowed) {
  const counts = {};
  for (const item of Array.isArray(items) ? items : []) {
    const candidate = selector(item);
    const key = typeof candidate === 'string' && allowed.has(candidate) ? candidate : 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function jsonSummary(bytes, kind) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { return { parseable: false }; }
  if (kind === 'topology') {
    const accounts = Array.isArray(value?.accounts) ? value.accounts : [];
    return {
      parseable: true,
      schemaVersion: integerOrNull(value?.schemaVersion),
      accountCount: accounts.length,
      roles: countBy(accounts, account => account?.role, new Set(['owner', 'member'])),
      surfaceProfiles: countBy(accounts, account => account?.surfaceProfile, new Set(['business-full', 'personal-read-fetch']))
    };
  }
  if (kind === 'inventory') {
    const accounts = Array.isArray(value?.accounts) ? value.accounts : [];
    const apps = accounts.flatMap(account => Array.isArray(account?.apps) ? account.apps : []);
    return {
      parseable: true,
      schemaVersion: integerOrNull(value?.schemaVersion),
      accountCount: accounts.length,
      appCount: apps.length,
      enabledAppCount: apps.filter(app => app?.enabled === true).length
    };
  }
  if (kind === 'sync-result') {
    return {
      parseable: true,
      schemaVersion: integerOrNull(value?.schemaVersion),
      terminal: enumOrNull(value?.terminal, new Set(['PASS', 'HOLD', 'FAILED', 'UNCERTAIN', 'ROLLED_BACK'])),
      completedAt: timestampOrNull(value?.completedAt)
    };
  }
  return {
    parseable: true,
    schemaVersion: integerOrNull(value?.schemaVersion),
    surfaceProfile: enumOrNull(value?.surfaceProfile, new Set(['business-full', 'personal-read-fetch'])),
    toolCount: Number.isInteger(value?.toolCount) ? value.toolCount : null,
    manifestHash: hashOrNull(value?.manifestHash),
    accountCanaryCount: Array.isArray(value?.accountCanaries) ? value.accountCanaries.length : 0,
    verifiedAt: timestampOrNull(value?.verifiedAt)
  };
}

function fingerprint({ label, file, root, summarize }) {
  const resolved = requireInside(root, file, label);
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch (error) {
    if (error?.code === 'ENOENT') return { label, exists: false, sha256: null, size: null, summary: null };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label}_not_regular_file`);
  if (stat.size > MAX_INPUT_BYTES) throw new Error(`${label}_too_large`);
  const bytes = fs.readFileSync(resolved);
  return {
    label,
    exists: true,
    sha256: sha256(bytes),
    size: bytes.length,
    summary: summarize(bytes)
  };
}

export function collectRestoreV2ReadOnlyMirror(options = {}) {
  const home = path.resolve(options.home ?? os.homedir());
  const codexRoot = path.resolve(options.codexRoot ?? path.join(home, '.codex'));
  const stateRoot = path.resolve(options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(home, '.ai-control-center'));
  const files = [
    { label: 'codex-config', root: codexRoot, file: path.join(codexRoot, 'config.toml'), summarize: bytes => configSummary(bytes, false) },
    { label: 'codex-native-config', root: codexRoot, file: path.join(codexRoot, 'codex-native.config.toml'), summarize: bytes => configSummary(bytes, true) },
    { label: 'workspace-topology', root: stateRoot, file: path.join(stateRoot, 'workspace-app-sync', 'topology.json'), summarize: bytes => jsonSummary(bytes, 'topology') },
    { label: 'workspace-inventory', root: stateRoot, file: path.join(stateRoot, 'workspace-app-sync', 'inventory.json'), summarize: bytes => jsonSummary(bytes, 'inventory') },
    { label: 'workspace-latest-result', root: stateRoot, file: path.join(stateRoot, 'workspace-app-sync', 'latest-result.json'), summarize: bytes => jsonSummary(bytes, 'sync-result') },
    { label: 'business-publication', root: stateRoot, file: path.join(stateRoot, 'workspace-mcp', 'publish-state.json'), summarize: bytes => jsonSummary(bytes, 'publication') },
    { label: 'personal-publication', root: stateRoot, file: path.join(stateRoot, 'workspace-mcp-personal-read-fetch', 'publish-state.json'), summarize: bytes => jsonSummary(bytes, 'publication') }
  ].map(fingerprint);
  const manifests = files
    .filter(file => ['business-publication', 'personal-publication'].includes(file.label))
    .map(file => ({
      label: file.label,
      exists: file.exists,
      surfaceProfile: file.summary?.surfaceProfile ?? null,
      toolCount: file.summary?.toolCount ?? null,
      manifestHash: file.summary?.manifestHash ?? null,
      fileSha256: file.sha256
    }));
  const fingerprintHash = sha256(JSON.stringify({ files, manifests }));
  return Object.freeze({
    schemaVersion: 1,
    kind: 'restore-v2-read-only-mirror',
    fingerprintHash,
    files,
    manifests,
    safety: {
      rawContentIncluded: false,
      absolutePathsIncluded: false,
      accountAliasesIncluded: false,
      remoteIdentifiersIncluded: false,
      networkCalls: 0,
      childProcesses: 0,
      writeSurfaces: 0,
      browserTargetsCreated: 0
    }
  });
}

export function readOnlyMirrorAdapter(options = {}) {
  return Object.freeze({
    readOnly: true,
    async inspect() {
      const mirror = collectRestoreV2ReadOnlyMirror(options);
      return {
        available: true,
        current: true,
        fingerprintVerified: true,
        fingerprintHash: mirror.fingerprintHash,
        mirror
      };
    }
  });
}
