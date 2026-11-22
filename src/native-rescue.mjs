import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(projectRoot, 'tools', 'platform', 'codex', 'codex-native-rescue');
const WINDOWS_SOURCE = path.join(projectRoot, 'tools', 'platform', 'codex', 'codex-native-rescue.cmd');
const DEFAULT_MODEL = 'gpt-5.6-sol';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function paths(options = {}) {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT ?? path.join(home, '.ai-control-center');
  return {
    platform,
    source: options.source ?? (platform === 'win32' ? WINDOWS_SOURCE : SOURCE),
    destination: options.destination ?? path.join(
      home,
      '.local',
      'bin',
      platform === 'win32' ? 'codex-native-rescue.cmd' : 'codex-native-rescue'
    ),
    manifest: options.manifest ?? path.join(stateRoot, 'native-rescue', 'install.json'),
    catalog: options.catalog ?? path.join(stateRoot, 'native-rescue', 'models.json'),
    catalogSource: options.catalogSource ?? path.join(options.codexHome ?? process.env.CODEX_HOME ?? path.join(home, '.codex'), 'models_cache.json'),
    codexHome: options.codexHome ?? process.env.CODEX_HOME ?? path.join(home, '.codex')
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function snapshot(file) {
  return fs.existsSync(file)
    ? { exists: true, data: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 }
    : { exists: false };
}

function restore(file, previous) {
  if (!previous.exists) {
    fs.rmSync(file, { force: true });
    return;
  }
  const temporary = `${file}.restore-${process.pid}`;
  fs.writeFileSync(temporary, previous.data, { mode: previous.mode, flag: 'wx' });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, previous.mode);
}

function replace(file, data, mode) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, data, { mode, flag: 'wx' });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, mode);
}

function officialCodexCandidate(codexHome, options = {}) {
  const windowsInstalled = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? (() => {
      const root = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
      try {
        return fs.readdirSync(root, { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
          .map(entry => path.join(root, entry.name, 'codex.exe'));
      } catch { return []; }
    })()
    : [];
  const candidates = [
    options.executable,
    process.env.AICC_NATIVE_CODEX_EXECUTABLE,
    process.platform === 'darwin' ? '/Applications/ChatGPT.app/Contents/Resources/codex' : null,
    path.join(codexHome, 'packages', 'standalone', 'current', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    ...windowsInstalled
  ].filter(Boolean);
  return candidates.find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
  }) ?? null;
}

export function nativeRescueStatus(options = {}) {
  const resolved = paths(options);
  const sourceSha256 = fs.existsSync(resolved.source) ? sha256(resolved.source) : null;
  const installedSha256 = fs.existsSync(resolved.destination) ? sha256(resolved.destination) : null;
  const manifest = readJson(resolved.manifest);
  const catalogPath = resolved.catalog;
  const catalog = readJson(catalogPath);
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const modelAvailable = models.some(model => model?.slug === (options.model ?? DEFAULT_MODEL));
  const executable = officialCodexCandidate(resolved.codexHome, options);
  const installed = Boolean(sourceSha256 && installedSha256 && sourceSha256 === installedSha256);
  const manifestMatches = Boolean(
    manifest?.schemaVersion === 2
    && manifest?.destination === resolved.destination
    && manifest?.sha256 === installedSha256
    && manifest?.catalog === catalogPath
    && manifest?.catalogSha256 === (fs.existsSync(catalogPath) ? sha256(catalogPath) : null)
  );
  const ok = installed && manifestMatches && Boolean(executable) && modelAvailable;
  return {
    ok,
    state: ok ? 'ready' : 'attention',
    installed,
    manifestMatches,
    destination: resolved.destination,
    executable,
    model: options.model ?? DEFAULT_MODEL,
    modelAvailable,
    catalogPath,
    routeLock: {
      endpoint: 'https://chatgpt.com/backend-api/codex',
      provider: 'openai',
      catalog: catalogPath,
      cliOverrideHighestPrecedence: true,
      rejectsCallerRouteOverride: true,
      independentOf: ['http://127.0.0.1:17841', 'http://127.0.0.1:10100']
    }
  };
}

export function installNativeRescue(options = {}) {
  const resolved = paths(options);
  if (!fs.existsSync(resolved.source)) throw new Error(`Native rescue source is missing: ${resolved.source}`);
  const desiredSha256 = sha256(resolved.source);
  const previous = readJson(resolved.manifest);
  const previousFiles = new Map([
    [resolved.destination, snapshot(resolved.destination)],
    [resolved.catalog, snapshot(resolved.catalog)],
    [resolved.manifest, snapshot(resolved.manifest)]
  ]);
  const digest = data => crypto.createHash('sha256').update(data).digest('hex');
  const previousHash = file => previousFiles.get(file).exists ? digest(previousFiles.get(file).data) : null;
  for (const [file, expected] of [
    [resolved.manifest, options.expectedManifestSha256],
    [resolved.catalog, options.expectedCatalogSha256]
  ]) {
    if (expected !== undefined && previousHash(file) !== expected) {
      throw new Error(`Native rescue compare-and-swap conflict: ${file}`);
    }
  }
  if (fs.existsSync(resolved.destination)) {
    const currentSha256 = sha256(resolved.destination);
    const ownerMatched = [1, 2].includes(previous?.schemaVersion)
      && previous.destination === resolved.destination
      && previous.sha256 === currentSha256;
    if (currentSha256 !== desiredSha256 && !ownerMatched) {
      throw new Error(`Refusing to overwrite an unowned Native rescue executable: ${resolved.destination}`);
    }
  }
  const requestedModel = options.model ?? previous?.model ?? DEFAULT_MODEL;
  const existingCatalogSha256 = fs.existsSync(resolved.catalog) ? sha256(resolved.catalog) : null;
  const existingCatalogOwned = Boolean(
    previous?.schemaVersion === 2
    && previous?.catalog === resolved.catalog
    && previous?.catalogSha256 === existingCatalogSha256
  );
  if (existingCatalogSha256 && !existingCatalogOwned) {
    throw new Error(`Refusing to overwrite an unowned Native rescue catalog: ${resolved.catalog}`);
  }
  let catalogData;
  let catalogMode = previous?.catalogMode ?? 'single-model';
  let catalogProvenance = previous?.catalogProvenance ?? null;
  if (options.officialCatalogSourceReceipt) {
    if (!options.expectedManifestSha256 || !options.expectedCatalogSha256 || !existingCatalogOwned) {
      throw new Error('Official Native catalog adoption requires owned catalog and exact manifest/catalog CAS hashes');
    }
    const receiptPath = path.resolve(options.officialCatalogSourceReceipt);
    const receiptData = fs.readFileSync(receiptPath);
    const receipt = JSON.parse(receiptData.toString('utf8'));
    const endpoint = new URL(receipt.source);
    if (receipt.schema !== 'aicc-native-official-catalog-source/v1'
      || receipt.state !== 'FETCHED_NOT_APPLIED'
      || endpoint.origin !== 'https://chatgpt.com'
      || endpoint.pathname !== '/backend-api/codex/models'
      || endpoint.searchParams.get('client_version') !== receipt.clientVersion
      || !/^\d+\.\d+\.\d+$/.test(receipt.clientVersion)
      || !/^[a-f0-9]{64}$/.test(receipt.nativeAccountIdSha256)
      || !path.isAbsolute(receipt.catalogPath)) {
      throw new Error('Invalid official Native catalog source receipt');
    }
    catalogData = fs.readFileSync(receipt.catalogPath);
    if (digest(catalogData) !== receipt.catalogSha256) {
      throw new Error('Official Native catalog source hash mismatch');
    }
    const catalog = JSON.parse(catalogData.toString('utf8'));
    const models = catalog?.models;
    if (!Array.isArray(models) || models.length === 0 || models.length !== receipt.returnedModelRows
      || models.some(model => typeof model?.slug !== 'string' || !model.slug)
      || new Set(models.map(model => model.slug)).size !== models.length
      || !models.some(model => model.slug === requestedModel && model.visibility === 'list')) {
      throw new Error(`Official Native catalog is invalid or does not list default model ${requestedModel}`);
    }
    catalogMode = 'official-snapshot';
    catalogProvenance = { ...receipt, receiptPath, receiptSha256: digest(receiptData) };
  } else if (catalogMode === 'official-snapshot') {
    if (!existingCatalogOwned || !previousFiles.get(resolved.catalog).exists) {
      throw new Error('Cannot reinstall an unowned official Native catalog');
    }
    catalogData = previousFiles.get(resolved.catalog).data;
    const catalog = JSON.parse(catalogData.toString('utf8'));
    if (!Array.isArray(catalog?.models) || !catalog.models.some(model => model?.slug === requestedModel)) {
      throw new Error(`Owned official Native catalog does not contain ${requestedModel}`);
    }
  } else {
    const sourceCatalog = readJson(resolved.catalogSource);
    const sourceModels = Array.isArray(sourceCatalog?.models) ? sourceCatalog.models : [];
    const selectedModel = sourceModels.find(model => model?.slug === requestedModel);
    const existingCatalog = readJson(resolved.catalog);
    const existingModel = Array.isArray(existingCatalog?.models)
      ? existingCatalog.models.find(model => model?.slug === requestedModel)
      : null;
    const nativeModel = selectedModel ?? existingModel;
    if (!nativeModel) {
      throw new Error(`Native rescue model ${requestedModel} is unavailable in both the source and owned catalogs`);
    }
    catalogData = Buffer.from(`${JSON.stringify({
      ...(typeof sourceCatalog?.client_version === 'string' ? { client_version: sourceCatalog.client_version } : {}),
      models: [nativeModel]
    }, null, 2)}\n`);
  }
  const catalogSha256 = digest(catalogData);
  privateDirectory(path.dirname(resolved.destination));
  privateDirectory(path.dirname(resolved.manifest));
  const manifest = {
    schemaVersion: 2,
    owner: 'AICC',
    source: resolved.source,
    destination: resolved.destination,
    sha256: desiredSha256,
    catalog: resolved.catalog,
    catalogSha256,
    catalogMode,
    catalogProvenance,
    model: requestedModel,
    installedAt: new Date().toISOString()
  };
  const backupDirectory = path.join(path.dirname(resolved.manifest), 'backups', `${Date.now()}-${crypto.randomUUID()}`);
  privateDirectory(backupDirectory);
  const originals = [];
  for (const [file, original] of previousFiles) {
    const backupPath = path.join(backupDirectory, path.basename(file));
    if (original.exists) fs.writeFileSync(backupPath, original.data, { mode: 0o600, flag: 'wx' });
    originals.push({ path: file, exists: original.exists, sha256: previousHash(file), backupPath: original.exists ? backupPath : null, mode: original.mode ?? null });
  }
  manifest.rollback = { directory: backupDirectory, originals };
  const replaceFile = options.replaceFile ?? replace;
  const writtenFiles = new Map();
  const writeOwned = (file, data, mode) => {
    const currentHash = fs.existsSync(file) ? sha256(file) : null;
    if (currentHash !== previousHash(file)) throw new Error(`Native rescue compare-and-swap conflict: ${file}`);
    if (currentHash === digest(data)) return;
    writtenFiles.set(file, digest(data));
    replaceFile(file, data, mode);
  };
  try {
    for (const file of previousFiles.keys()) {
      if ((fs.existsSync(file) ? sha256(file) : null) !== previousHash(file)) {
        throw new Error(`Native rescue compare-and-swap conflict: ${file}`);
      }
    }
    writeOwned(resolved.catalog, catalogData, 0o600);
    const launcherData = fs.readFileSync(resolved.source);
    if (digest(launcherData) !== desiredSha256) throw new Error('Native rescue launcher source changed during installation');
    writeOwned(resolved.destination, launcherData, 0o755);
    writeOwned(resolved.manifest, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 0o600);
  } catch (error) {
    const restoreErrors = [];
    for (const [file, writtenHash] of [...writtenFiles].reverse()) {
      try {
        const currentHash = fs.existsSync(file) ? sha256(file) : null;
        if (currentHash === previousHash(file)) continue;
        if (currentHash !== writtenHash) throw new Error('Rollback CAS conflict; preserving concurrent change and backup');
        restore(file, previousFiles.get(file));
      } catch (restoreError) {
        restoreErrors.push(`${file}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      }
    }
    if (restoreErrors.length > 0) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; Native rescue rollback failed: ${restoreErrors.join('; ')}`);
    }
    throw error;
  }
  return {
    ok: true,
    state: 'installed_not_verified',
    installed: true,
    destination: resolved.destination,
    catalogPath: resolved.catalog,
    model: requestedModel,
    catalogMode,
    catalogSha256,
    catalogRows: JSON.parse(catalogData.toString('utf8')).models.length,
    manifestPath: resolved.manifest,
    manifestSha256: digest(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)),
    rollbackDirectory: backupDirectory,
    writes: [...writtenFiles].map(([file, hash]) => ({ path: file, sha256: hash })),
    digestEvidence: 'written input bytes; no post-write readback',
    verification: 'NOT_RUN',
    activeTuiReloaded: false
  };
}

export const nativeRescuePaths = paths;
