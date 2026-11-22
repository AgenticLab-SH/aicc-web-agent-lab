import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_ENDPOINT = 'https://chatgpt.com/backend-api/codex';
const ROUTES = Object.freeze([
  { name: 'codex-aicc', source: 'codex-aicc', catalog: 'aicc.models.json' },
  { name: 'codex-web', source: 'codex-web', catalog: null },
  { name: 'codex-ocx', source: 'codex-ocx', catalog: 'ocx.models.json' }
]);

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function replace(file, data, mode) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, data, { mode, flag: 'wx' });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, mode);
}

function snapshot(file) {
  return fs.existsSync(file)
    ? { exists: true, bytes: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 }
    : { exists: false };
}

function restore(file, before) {
  if (!before.exists) {
    fs.rmSync(file, { force: true });
    return;
  }
  replace(file, before.bytes, before.mode);
}

export function routeLauncherPaths(options = {}) {
  const home = options.home ?? os.homedir();
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT ?? path.join(home, '.ai-control-center');
  const stateDirectory = options.stateDirectory ?? path.join(stateRoot, 'route-launchers');
  const binDirectory = options.binDirectory ?? path.join(home, '.local', 'bin');
  const sourceDirectory = options.sourceDirectory ?? path.join(PROJECT_ROOT, 'tools', 'platform', 'codex');
  return {
    home,
    stateRoot,
    stateDirectory,
    binDirectory,
    sourceDirectory,
    manifest: options.manifest ?? path.join(stateDirectory, 'install.json'),
    aiccCatalog: options.aiccCatalog ?? path.join(stateDirectory, 'aicc.models.json'),
    ocxCatalog: options.ocxCatalog ?? path.join(stateDirectory, 'ocx.models.json'),
    ocxCatalogSource: options.ocxCatalogSource ?? path.join(home, '.opencodex', 'catalog-backup.json'),
    codexConfig: options.codexConfig ?? path.join(options.codexHome ?? process.env.CODEX_HOME ?? path.join(home, '.codex'), 'config.toml')
  };
}

function topLevelValue(text, key) {
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`));
    if (match) return match[1];
  }
  return null;
}

function normalizeCatalog(models) {
  return Buffer.from(`${JSON.stringify({ models }, null, 2)}\n`);
}

export function buildRouteCatalogs({ integrated, ocx, ocxSource }) {
  const integratedModels = Array.isArray(integrated?.models) ? integrated.models : [];
  if (!integratedModels.some(model => model?.slug === 'chatgpt-web/saved/high')) {
    throw new Error('Integrated 17841 catalog does not contain chatgpt-web/saved/high');
  }
  const ocxIds = new Set(Array.isArray(ocx?.data) ? ocx.data.map(model => model?.id).filter(Boolean) : []);
  if (!ocxIds.size) throw new Error('OCX 10100 advertised catalog is empty; no fixed legacy model is required');
  const sourceModels = Array.isArray(ocxSource?.models) ? ocxSource.models : [];
  const ocxModels = sourceModels.filter(model => ocxIds.has(model?.slug));
  const missing = [...ocxIds].filter(id => !ocxModels.some(model => model?.slug === id));
  if (missing.length > 0) throw new Error(`OCX catalog metadata is missing: ${missing.join(', ')}`);
  return {
    aicc: normalizeCatalog(integratedModels),
    ocx: normalizeCatalog(ocxModels)
  };
}

async function readJsonUrl(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
  try {
    const response = await (options.fetch ?? fetch)(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function captureRouteCatalogs(options = {}) {
  const resolved = routeLauncherPaths(options);
  const [integrated, ocx] = await Promise.all([
    readJsonUrl(options.aiccModelsUrl ?? 'http://127.0.0.1:17841/v1/models', options),
    readJsonUrl(options.ocxModelsUrl ?? 'http://127.0.0.1:10100/v1/models', options)
  ]);
  const ocxSource = readJson(resolved.ocxCatalogSource);
  if (!ocxSource) throw new Error('OCX owner catalog metadata is unavailable');
  return buildRouteCatalogs({ integrated, ocx, ocxSource });
}

export function routeLauncherStatus(options = {}) {
  const resolved = routeLauncherPaths(options);
  const manifest = readJson(resolved.manifest);
  const routes = ROUTES.map(route => {
    const source = path.join(resolved.sourceDirectory, route.source);
    const destination = path.join(resolved.binDirectory, route.name);
    const sourceSha256 = fs.existsSync(source) ? sha256File(source) : null;
    const installedSha256 = fs.existsSync(destination) ? sha256File(destination) : null;
    const catalog = route.catalog ? path.join(resolved.stateDirectory, route.catalog) : null;
    const catalogSha256 = catalog && fs.existsSync(catalog) ? sha256File(catalog) : null;
    const recorded = manifest?.routes?.find(item => item.name === route.name) ?? null;
    const ready = Boolean(
      sourceSha256 && installedSha256 && sourceSha256 === installedSha256
      && (!catalog || catalogSha256)
      && recorded?.sourceSha256 === sourceSha256
      && recorded?.installedSha256 === installedSha256
      && recorded?.catalogSha256 === catalogSha256
    );
    return { name: route.name, ready, sourceSha256, installedSha256, catalogSha256, destination };
  });
  const config = fs.existsSync(resolved.codexConfig) ? fs.readFileSync(resolved.codexConfig, 'utf8') : '';
  const defaultEndpoint = topLevelValue(config, 'openai_base_url') ?? NATIVE_ENDPOINT;
  const ok = manifest?.schemaVersion === 1 && routes.every(route => route.ready);
  return {
    ok,
    state: ok ? 'ready' : 'attention',
    defaultCodex: { endpoint: defaultEndpoint, native: defaultEndpoint === NATIVE_ENDPOINT },
    routes,
    manifest: resolved.manifest,
    isolation: {
      default: 'shared-HOME configured route; OCX is the command-route-r2 target',
      named: { 'codex-aicc': 17841, 'codex-web': 17842, 'codex-ocx': 10100 },
      fallback: false
    }
  };
}

export async function installRouteLaunchers(options = {}) {
  const resolved = routeLauncherPaths(options);
  const catalogs = options.catalogs ?? await captureRouteCatalogs(options);
  const previousManifest = readJson(resolved.manifest);
  const files = [];
  for (const route of ROUTES) {
    const source = path.join(resolved.sourceDirectory, route.source);
    const destination = path.join(resolved.binDirectory, route.name);
    if (!fs.existsSync(source)) throw new Error(`Route launcher source is missing: ${source}`);
    const currentSha256 = fs.existsSync(destination) ? sha256File(destination) : null;
    const previous = previousManifest?.routes?.find(item => item.name === route.name);
    if (currentSha256 && currentSha256 !== sha256File(source) && previous?.installedSha256 !== currentSha256) {
      throw new Error(`Refusing to overwrite an unowned route launcher: ${destination}`);
    }
    files.push({ file: destination, data: fs.readFileSync(source), mode: 0o755 });
  }
  for (const [file, data] of [[resolved.aiccCatalog, catalogs.aicc], [resolved.ocxCatalog, catalogs.ocx]]) {
    const currentSha256 = fs.existsSync(file) ? sha256File(file) : null;
    const previous = previousManifest?.routes?.find(item => item.catalog === file);
    if (currentSha256 && previous?.catalogSha256 !== currentSha256) {
      throw new Error(`Refusing to overwrite an unowned route catalog: ${file}`);
    }
    files.push({ file, data, mode: 0o600 });
  }
  const manifest = {
    schemaVersion: 1,
    owner: 'AICC',
    installedAt: new Date().toISOString(),
    routes: ROUTES.map(route => {
      const source = path.join(resolved.sourceDirectory, route.source);
      const destination = path.join(resolved.binDirectory, route.name);
      const catalog = route.catalog ? path.join(resolved.stateDirectory, route.catalog) : null;
      const catalogData = route.name === 'codex-aicc' ? catalogs.aicc : route.name === 'codex-ocx' ? catalogs.ocx : null;
      return {
        name: route.name,
        source,
        sourceSha256: sha256File(source),
        destination,
        installedSha256: sha256File(source),
        catalog,
        catalogSha256: catalogData ? sha256Bytes(catalogData) : null
      };
    })
  };
  files.push({ file: resolved.manifest, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mode: 0o600 });
  privateDirectory(resolved.binDirectory);
  privateDirectory(resolved.stateDirectory);
  const before = new Map(files.map(item => [item.file, snapshot(item.file)]));
  const replaceFile = options.replaceFile ?? replace;
  try {
    for (const item of files) replaceFile(item.file, item.data, item.mode);
  } catch (error) {
    const rollbackErrors = [];
    for (const item of [...files].reverse()) {
      try { restore(item.file, before.get(item.file)); }
      catch (rollbackError) { rollbackErrors.push(`${item.file}: ${rollbackError.message}`); }
    }
    if (rollbackErrors.length > 0) throw new Error(`${error.message}; route launcher rollback failed: ${rollbackErrors.join('; ')}`);
    throw error;
  }
  return routeLauncherStatus(options);
}

export const OFFICIAL_NATIVE_CODEX_ENDPOINT = NATIVE_ENDPOINT;
