import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeRescueStatus } from './native-rescue.mjs';

export const NATIVE_CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex';
export const WEB_GPT_CODEX_ENDPOINT = 'http://127.0.0.1:17841/v1';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function topLevelAssignments(source) {
  const values = new Map();
  for (const line of String(source).split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*(openai_base_url|model_provider|model_catalog_json)\s*=\s*["']([^"']*)["']/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function publicPath(file, home) {
  return file === home ? '~' : file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}

export function inspectNativeCallbackSafety(options = {}) {
  const home = options.home ?? os.homedir();
  const configFile = options.configFile ?? path.join(home, '.codex', 'config.toml');
  const journalFile = options.journalFile ?? path.join(home, '.codex-chatgpt-web', 'codex', 'integration-journal.json');
  const source = readText(configFile);
  const assignments = topLevelAssignments(source);
  const endpoint = assignments.get('openai_base_url') ?? NATIVE_CODEX_ENDPOINT;
  const provider = assignments.get('model_provider') ?? 'openai';
  const catalog = assignments.get('model_catalog_json') ?? null;
  const journalExists = fs.existsSync(journalFile);
  const journal = journalExists ? readJson(journalFile) : null;
  const journalKnown = !journalExists || (journal && typeof journal.active === 'boolean');
  const journalInactive = !journalExists || journal?.active === false;
  const managedMarkerPresent = source.includes('Managed by codex-chatgpt-web');
  const rescue = (options.nativeRescueInspector ?? nativeRescueStatus)({ home });
  const exactNativeRoute = endpoint === NATIVE_CODEX_ENDPOINT
    && provider === 'openai'
    && catalog === null
    && !managedMarkerPresent;
  const ok = Boolean(exactNativeRoute && journalKnown && journalInactive && rescue?.ok === true);
  return {
    ok,
    state: ok ? 'NATIVE_CALLBACK_ROUTE_SAFE' : 'NATIVE_CALLBACK_ROUTE_NOT_PROVEN',
    configSource: publicPath(configFile, home),
    endpoint,
    provider,
    customCatalogPresent: catalog !== null,
    managedWebGptMarkerPresent: managedMarkerPresent,
    webGptJournal: {
      source: publicPath(journalFile, home),
      exists: journalExists,
      known: journalKnown,
      active: journalKnown && journalExists ? journal.active : null,
      inactive: journalInactive
    },
    nativeRescue: {
      ready: rescue?.ok === true,
      model: rescue?.model ?? null,
      endpoint: rescue?.routeLock?.endpoint ?? NATIVE_CODEX_ENDPOINT,
      independentOf: rescue?.routeLock?.independentOf ?? [WEB_GPT_CODEX_ENDPOINT, 'http://127.0.0.1:10100']
    },
    compactRoute: endpoint,
    rawConfigIncluded: false,
    authMaterialIncluded: false
  };
}

function packageVersion(root) {
  const packageJson = readJson(path.join(root, 'app', 'package.json'));
  return typeof packageJson?.version === 'string' ? packageJson.version : null;
}

function manifestIdentity(root) {
  const manifest = readJson(path.join(root, 'manifest.json'));
  return {
    bundleId: typeof manifest?.bundleId === 'string' ? manifest.bundleId : null,
    sourceCommit: typeof manifest?.sourceCommit === 'string' ? manifest.sourceCommit : null
  };
}

function plistExecutable(plistFile) {
  const source = readText(plistFile);
  const args = source.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
  return args.match(/<string>([^<]+codex-chatgpt-web[^<]*)<\/string>/)?.[1] ?? null;
}

function versionRootFromExecutable(executable) {
  if (!executable) return null;
  const normalized = path.resolve(executable);
  const marker = `${path.sep}bin${path.sep}codex-chatgpt-web`;
  return normalized.endsWith(marker) ? normalized.slice(0, -marker.length) : null;
}

export function inspectWebGptReleaseMatrix(options = {}) {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const configFile = options.configFile ?? path.join(home, '.codex-chatgpt-web', 'config.json');
  const plistFile = options.plistFile ?? (platform === 'win32'
    ? path.join(home, '.codex-chatgpt-web', 'windows-service.json')
    : path.join(home, 'Library', 'LaunchAgents', 'io.github.codex-chatgpt-web.daemon.plist'));
  const appRuntimeRoot = options.appRuntimeRoot ?? (platform === 'win32'
    ? path.join(localAppData, 'Codex Web GPT', 'resources', 'runtime')
    : '/Applications/Codex Web GPT.app/Contents/Resources/runtime');
  const config = readJson(configFile);
  const configuredExecutable = Array.isArray(config?.runtimeCommand) && typeof config.runtimeCommand[0] === 'string'
    ? config.runtimeCommand[0]
    : null;
  const serviceRoot = versionRootFromExecutable(configuredExecutable);
  const plistCommand = plistExecutable(plistFile);
  const plistRoot = versionRootFromExecutable(plistCommand);
  const app = {
    releaseVersion: packageVersion(appRuntimeRoot),
    ...manifestIdentity(appRuntimeRoot)
  };
  const configured = {
    releaseVersion: typeof config?.releaseVersion === 'string' ? config.releaseVersion : null,
    executable: publicPath(configuredExecutable ?? '', home) || null,
    workspaceSnapshotRoot: publicPath(config?.workspaceSnapshotRoot ?? '', home) || null
  };
  const service = serviceRoot
    ? { releaseVersion: packageVersion(serviceRoot), ...manifestIdentity(serviceRoot), executable: publicPath(configuredExecutable, home) }
    : { releaseVersion: null, bundleId: null, sourceCommit: null, executable: publicPath(configuredExecutable ?? '', home) || null };
  const launchAgent = plistRoot
    ? { releaseVersion: packageVersion(plistRoot), ...manifestIdentity(plistRoot), executable: publicPath(plistCommand, home) }
    : { releaseVersion: null, bundleId: null, sourceCommit: null, executable: publicPath(plistCommand ?? '', home) || null };
  const serviceVersions = [configured.releaseVersion, service.releaseVersion, launchAgent.releaseVersion].filter(Boolean);
  const serviceCoherent = serviceVersions.length === 3 && new Set(serviceVersions).size === 1
    && Boolean(service.bundleId && launchAgent.bundleId && service.bundleId === launchAgent.bundleId);
  const allVersions = [app.releaseVersion, ...serviceVersions].filter(Boolean);
  const sameRelease = allVersions.length === 4 && new Set(allVersions).size === 1;
  return {
    ok: serviceCoherent && sameRelease,
    state: serviceCoherent && sameRelease ? 'WEB_GPT_RELEASE_MATRIX_COHERENT' : 'WEB_GPT_RELEASE_MATRIX_MISMATCH',
    app,
    configured,
    service,
    launchAgent,
    serviceCoherent,
    sameRelease,
    comparisonRule: 'launcher embedded runtime, owner config, durable service executable, and LaunchAgent must identify one release before Desktop restart or callback',
    secretsIncluded: false
  };
}
