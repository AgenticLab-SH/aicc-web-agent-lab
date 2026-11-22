import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.agenticlab.aicc.web-gpt-rescue';
const DEFAULT_PORT = 17842;
const DEFAULT_RUNTIME = '/Applications/Codex Web GPT.app/Contents/Resources/runtime';
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WINDOWS_APP_NAME = 'Codex Web GPT';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WRAPPER_SOURCE = path.join(PROJECT_ROOT, 'tools', 'platform', 'codex', 'codex-web-gpt-rescue');

function platformOf(options = {}) {
  return options.platform ?? process.platform;
}

// Existing fixture callers use allowUnsupportedPlatform to exercise the macOS
// launch-agent implementation on a different host. Keep that explicit test
// escape hatch, but never treat a real Windows invocation as launchd-capable.
function effectivePlatform(options = {}) {
  const requested = platformOf(options);
  return requested !== 'darwin' && options.platform === undefined && options.allowUnsupportedPlatform === true
    ? 'darwin'
    : requested;
}

function windowsLocalAppData(home, environment = process.env) {
  return environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
}

function windowsChromePath(environment = process.env) {
  const programFiles = environment.ProgramFiles || 'C:\\Program Files';
  return path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe');
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function atomicWrite(file, contents, mode = 0o600) {
  privateDirectory(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, contents, { mode, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function loopbackEndpoint(value) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname)) {
    throw new Error(`CDP bootstrap endpoint must be loopback HTTP: ${value}`);
  }
  return endpoint;
}

async function connectCdp(webSocketUrl, options = {}) {
  const WebSocketCtor = options.WebSocketCtor ?? globalThis.WebSocket;
  if (!WebSocketCtor) throw new Error('CDP bootstrap requires a WebSocket-capable Node.js runtime');
  const socket = new WebSocketCtor(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); }
  };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function treeInventory(root) {
  const entries = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) entries.push({ path: relative, type: 'file', bytes: fs.statSync(absolute).size, sha256: sha256(absolute) });
      else if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        const resolvedTarget = path.resolve(path.dirname(absolute), target);
        if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${path.sep}`)) {
          throw new Error(`Runtime symbolic link escapes its release root: ${absolute}`);
        }
        entries.push({ path: relative, type: 'symlink', target });
      } else throw new Error(`Unsupported runtime entry: ${absolute}`);
    }
  };
  visit(root);
  const digest = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { entries, digest };
}

export function webGptRescuePaths(options = {}) {
  const home = options.home ?? os.homedir();
  const platform = effectivePlatform(options);
  const environment = options.env ?? process.env;
  const stateRoot = options.stateRoot ?? environment.AICC_STATE_ROOT ?? path.join(home, '.ai-control-center');
  const root = options.root ?? path.join(stateRoot, 'web-gpt-rescue');
  const providerHome = path.join(root, 'provider-home');
  const localAppData = options.localAppData ?? windowsLocalAppData(home, environment);
  const windowsRuntime = path.join(localAppData, WINDOWS_APP_NAME, 'resources', 'runtime');
  const sourceRuntime = options.sourceRuntime ?? environment.AICC_WEB_GPT_RESCUE_SOURCE_RUNTIME
    ?? (platform === 'win32' ? windowsRuntime : DEFAULT_RUNTIME);
  const launchAgent = options.launchAgent ?? (platform === 'win32'
    ? path.join(root, 'windows-service.json')
    : path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`));
  const chrome = options.chrome ?? environment.AICC_WEB_GPT_RESCUE_CHROME
    ?? (platform === 'win32' ? windowsChromePath(environment) : DEFAULT_CHROME);
  const wrapperDestination = options.wrapperDestination ?? (platform === 'win32'
    ? path.join(localAppData, 'AICC', 'bin', 'codex-web-gpt-rescue.cmd')
    : path.join(home, '.local', 'bin', 'codex-web-gpt-rescue'));
  return {
    platform,
    home,
    root,
    providerHome,
    config: path.join(providerHome, 'config.json'),
    storageState: path.join(providerHome, 'browser', 'storage-state.json'),
    loginMarker: path.join(providerHome, 'browser', 'storage-state.json.verified.json'),
    modelCatalog: path.join(root, 'model-catalog.json'),
    manifest: path.join(root, 'install.json'),
    sourceRuntime,
    releases: path.join(root, 'releases'),
    launchAgent,
    port: Number(options.port ?? environment.AICC_WEB_GPT_RESCUE_PORT ?? DEFAULT_PORT),
    chrome,
    wrapperSource: options.wrapperSource ?? DEFAULT_WRAPPER_SOURCE,
    wrapperDestination,
    catalogSource: options.catalogSource ?? environment.AICC_WEB_GPT_RESCUE_CATALOG_SOURCE ?? null
  };
}

function unixUid(options = {}) {
  if (Number.isInteger(options.uid) && options.uid >= 0) return options.uid;
  if (typeof process.getuid === 'function') return process.getuid();
  // A synthetic UID is only useful for explicit fixture overrides. A real
  // macOS call without getuid must fail closed instead of addressing another
  // user's launchd namespace.
  if (options.allowUnsupportedPlatform === true) return 0;
  return null;
}

function launchLoaded(options = {}) {
  if (effectivePlatform(options) !== 'darwin') return false;
  const uid = unixUid(options);
  if (uid === null) return false;
  const runner = options.spawnSync ?? spawnSync;
  const result = runner('launchctl', ['print', `gui/${uid}/${LABEL}`], { encoding: 'utf8', stdio: 'pipe' });
  return !result?.error && result.status === 0;
}

function launchDisabled(options = {}) {
  if (effectivePlatform(options) !== 'darwin') return false;
  const uid = unixUid(options);
  if (uid === null) throw new Error('user_uid_unknown');
  const runner = options.spawnSync ?? spawnSync;
  const result = runner('launchctl', ['print-disabled', `gui/${uid}`], { encoding: 'utf8', stdio: 'pipe' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `launchctl print-disabled exited with ${result.status}`);
  const escaped = LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(result.stdout ?? '').match(new RegExp(`"${escaped}"\\s*=>\\s*(true|false|disabled|enabled)`));
  return match?.[1] === 'true' || match?.[1] === 'disabled';
}

function runtimeVersion(executable, options = {}) {
  const runner = options.spawnSync ?? spawnSync;
  const result = runner(executable, ['--version'], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `Web GPT runtime exited with ${result.status}`);
  const version = String(result.stdout).trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid Web GPT runtime version: ${version}`);
  return version;
}

function plist(paths, executable) {
  const logRoot = path.join(paths.root, 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(executable)}</string>
    <string>--home</string>
    <string>${xml(paths.providerHome)}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(logRoot, 'stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logRoot, 'stderr.log'))}</string>
</dict>
</plist>
`;
}

export function prepareWebGptRescue(options = {}) {
  const platform = effectivePlatform(options);
  if (platform !== 'darwin') {
    throw new Error(platform === 'win32'
      ? 'web_gpt_rescue_windows_service_not_implemented'
      : 'Web GPT rescue service is currently implemented for macOS');
  }
  const paths = webGptRescuePaths(options);
  if (launchLoaded(options)) throw new Error('Stop the exact Web GPT rescue service before replacing its runtime');
  if (!Number.isInteger(paths.port) || paths.port < 1024 || paths.port > 65_535 || paths.port === 17841 || paths.port === 10100) {
    throw new Error(`Invalid independent Web GPT rescue port: ${paths.port}`);
  }
  const sourceExecutable = path.join(paths.sourceRuntime, 'bin', 'codex-chatgpt-web');
  if (!fs.existsSync(sourceExecutable)) throw new Error(`Packaged Web GPT runtime is unavailable: ${sourceExecutable}`);
  const version = runtimeVersion(sourceExecutable, options);
  const sourceInventory = treeInventory(paths.sourceRuntime);
  const releaseRoot = path.join(paths.releases, version);
  const runtimeRoot = path.join(releaseRoot, 'runtime');
  const manifest = readJson(paths.manifest);
  let modelCatalog = readJson(paths.modelCatalog);
  let catalogBytesToInstall = null;
  if (paths.catalogSource) {
    const sourceCatalog = readJson(paths.catalogSource);
    const sourceModels = Array.isArray(sourceCatalog?.models) ? sourceCatalog.models : [];
    if (!sourceModels.some(model => model?.slug === 'chatgpt-web/temporary/high')) {
      throw new Error(`Web GPT rescue catalog source lacks chatgpt-web/temporary/high: ${paths.catalogSource}`);
    }
    if (!sourceModels.some(model => model?.slug === 'gpt-5.6-sol')) {
      throw new Error(`Web GPT rescue catalog source lacks its native template: ${paths.catalogSource}`);
    }
    catalogBytesToInstall = fs.readFileSync(paths.catalogSource);
    modelCatalog = sourceCatalog;
  }
  const modelCatalogReady = Array.isArray(modelCatalog?.models)
    && modelCatalog.models.some(model => model?.slug === 'chatgpt-web/temporary/high');
  if (fs.existsSync(paths.modelCatalog)) {
    const installedCatalogSha256 = sha256(paths.modelCatalog);
    const catalogOwned = manifest?.schemaVersion === 1
      && manifest?.modelCatalog === paths.modelCatalog
      && manifest?.modelCatalogSha256 === installedCatalogSha256;
    const suppliedMatches = catalogBytesToInstall
      && crypto.createHash('sha256').update(catalogBytesToInstall).digest('hex') === installedCatalogSha256;
    if (!catalogOwned && !suppliedMatches) {
      throw new Error(`Refusing to adopt or replace an unowned Web GPT rescue catalog: ${paths.modelCatalog}`);
    }
  }
  if (!fs.existsSync(paths.wrapperSource)) throw new Error(`Web GPT rescue wrapper source is unavailable: ${paths.wrapperSource}`);
  const desiredWrapperSha256 = sha256(paths.wrapperSource);
  if (fs.existsSync(paths.wrapperDestination)) {
    const installedWrapperSha256 = sha256(paths.wrapperDestination);
    const wrapperOwned = manifest?.schemaVersion === 1
      && manifest?.wrapperDestination === paths.wrapperDestination
      && manifest?.wrapperSha256 === installedWrapperSha256;
    if (installedWrapperSha256 !== desiredWrapperSha256 && !wrapperOwned) {
      throw new Error(`Refusing to replace an unowned Web GPT rescue wrapper: ${paths.wrapperDestination}`);
    }
  }
  if (fs.existsSync(runtimeRoot)) {
    const currentInventory = treeInventory(runtimeRoot);
    const owned = manifest?.schemaVersion === 1
      && manifest?.runtimeRoot === runtimeRoot
      && manifest?.runtimeDigest === currentInventory.digest;
    if (currentInventory.digest !== sourceInventory.digest && !owned) {
      throw new Error(`Refusing to replace an unowned rescue runtime: ${runtimeRoot}`);
    }
    if (currentInventory.digest !== sourceInventory.digest) {
      throw new Error(`Owned rescue runtime for ${version} differs from the current package; use a new release version instead of overwriting rollback evidence`);
    }
  }
  if (!fs.existsSync(runtimeRoot)) {
    privateDirectory(paths.releases);
    const temporary = `${releaseRoot}.tmp-${process.pid}`;
    fs.cpSync(paths.sourceRuntime, path.join(temporary, 'runtime'), {
      recursive: true,
      errorOnExist: true,
      verbatimSymlinks: true
    });
    fs.renameSync(temporary, releaseRoot);
  }
  const copiedInventory = treeInventory(runtimeRoot);
  if (copiedInventory.digest !== sourceInventory.digest) throw new Error('Copied Web GPT rescue runtime failed exact inventory verification');
  if (catalogBytesToInstall) atomicWrite(paths.modelCatalog, catalogBytesToInstall);
  const executable = path.join(runtimeRoot, 'bin', 'codex-chatgpt-web');
  privateDirectory(path.dirname(paths.wrapperDestination));
  const wrapperTemporary = `${paths.wrapperDestination}.tmp-${process.pid}`;
  fs.copyFileSync(paths.wrapperSource, wrapperTemporary, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(wrapperTemporary, 0o755);
  fs.renameSync(wrapperTemporary, paths.wrapperDestination);
  const config = {
    version: 3,
    releaseVersion: version,
    mode: 'browser-only',
    host: '127.0.0.1',
    port: paths.port,
    contextWindow: 256000,
    appName: 'Codex Web GPT Rescue',
    browserHost: 'managed-chrome',
    runtimeOwner: 'service',
    chromeExecutablePath: paths.chrome,
    storageStatePath: paths.storageState,
    brokerSocketPath: path.join(paths.providerHome, 'runtime', 'turn-broker.sock'),
    headed: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: crypto.randomBytes(32).toString('base64url'),
    runtimeCommand: [executable],
    acknowledgedUnofficialAt: new Date().toISOString()
  };
  privateDirectory(path.join(paths.root, 'logs'));
  atomicWrite(paths.config, `${JSON.stringify(config, null, 2)}\n`);
  atomicWrite(paths.launchAgent, plist(paths, executable));
  atomicWrite(paths.manifest, `${JSON.stringify({
    schemaVersion: 1,
    owner: 'AICC',
    version,
    port: paths.port,
    runtimeRoot,
    runtimeDigest: copiedInventory.digest,
    runtimeFileCount: copiedInventory.entries.length,
    config: paths.config,
    launchAgent: paths.launchAgent,
    wrapperSource: paths.wrapperSource,
    wrapperDestination: paths.wrapperDestination,
    wrapperSha256: desiredWrapperSha256,
    modelCatalog: paths.modelCatalog,
    modelCatalogSha256: modelCatalogReady ? sha256(paths.modelCatalog) : null,
    modelCatalogReady,
    ...(paths.catalogSource ? { modelCatalogSourceSha256: sha256(paths.catalogSource) } : {}),
    preparedAt: new Date().toISOString()
  }, null, 2)}\n`);
  return { ok: true, prepared: true, version, port: paths.port, root: paths.root, executable, wrapper: paths.wrapperDestination, modelCatalog: paths.modelCatalog, modelCatalogReady, loginRequired: !fs.existsSync(paths.loginMarker) };
}

export async function webGptRescueStatus(options = {}) {
  const paths = webGptRescuePaths(options);
  const platform = effectivePlatform(options);
  const manifest = readJson(paths.manifest);
  const config = readJson(paths.config);
  const login = readJson(paths.loginMarker);
  const wrapperSha256 = fs.existsSync(paths.wrapperDestination) ? sha256(paths.wrapperDestination) : null;
  const modelCatalogSha256 = fs.existsSync(paths.modelCatalog) ? sha256(paths.modelCatalog) : null;
  const loaded = platform === 'darwin' ? launchLoaded(options) : false;
  let health = null;
  if (loaded) {
    try {
      const response = await (options.fetch ?? fetch)(`http://127.0.0.1:${paths.port}/healthz`, { signal: AbortSignal.timeout(2_500) });
      if (response.ok) health = await response.json();
    } catch { /* fail closed below */ }
  }
  const configured = manifest?.schemaVersion === 1
    && manifest.port === paths.port
    && config?.version === 3
    && config.port === paths.port
    && config.browserHost === 'managed-chrome'
    && config.runtimeCommand?.[0]?.startsWith(paths.releases)
    && manifest?.wrapperDestination === paths.wrapperDestination
    && manifest?.wrapperSha256 === wrapperSha256
    && manifest?.modelCatalog === paths.modelCatalog
    && manifest?.modelCatalogReady === true
    && manifest?.modelCatalogSha256 === modelCatalogSha256;
  const authenticated = login?.authenticated === true && fs.existsSync(paths.storageState);
  const ready = configured
    && authenticated
    && loaded
    && health?.status === 'ok'
    && health?.accepting_turns === true
    && health?.accepting_browser_turns === true;
  return {
    ok: ready,
    state: ready ? 'ready' : configured && authenticated ? 'standby' : configured ? 'login-required' : 'unprepared',
    independentOf: platform === 'win32'
      ? ['http://127.0.0.1:17841', 'http://127.0.0.1:10100', '%LOCALAPPDATA%\\Codex Web GPT']
      : ['http://127.0.0.1:17841', 'http://127.0.0.1:10100', '/Applications/Codex Web GPT.app'],
    configured,
    authenticated,
    loaded,
    port: paths.port,
    version: manifest?.version ?? null,
    root: paths.root,
    wrapper: paths.wrapperDestination,
    modelCatalog: paths.modelCatalog,
    active: health ? {
      http: health.active_http_turns ?? null,
      browserHttp: health.active_browser_http_turns ?? null,
      browser: health.active_browser_turns ?? null
    } : null,
    health
  };
}

export function loginWebGptRescue(options = {}) {
  if (effectivePlatform(options) === 'win32') throw new Error('web_gpt_rescue_windows_service_not_implemented');
  const paths = webGptRescuePaths(options);
  const config = readJson(paths.config);
  if (!config?.runtimeCommand?.[0]) throw new Error('Prepare the Web GPT rescue runtime before login');
  if (launchLoaded(options)) throw new Error('Stop the Web GPT rescue service before refreshing its login');
  const runner = options.spawnSync ?? spawnSync;
  const result = runner(config.runtimeCommand[0], ['--home', paths.providerHome, 'login'], {
    stdio: options.stdio ?? 'inherit',
    encoding: options.stdio ? 'utf8' : undefined,
    timeout: options.timeoutMs ?? 15 * 60_000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `Web GPT rescue login exited with ${result.status}`);
  return { ok: true, authenticated: fs.existsSync(paths.storageState) && readJson(paths.loginMarker)?.authenticated === true };
}

export async function bootstrapWebGptRescueFromCdp(options = {}) {
  if (effectivePlatform(options) === 'win32') throw new Error('web_gpt_rescue_windows_service_not_implemented');
  const paths = webGptRescuePaths(options);
  const config = readJson(paths.config);
  if (!config?.runtimeCommand?.[0]) throw new Error('Prepare the Web GPT rescue runtime before CDP bootstrap');
  if (launchLoaded(options)) throw new Error('Stop the Web GPT rescue service before CDP bootstrap');
  if (fs.existsSync(paths.storageState) || fs.existsSync(paths.loginMarker)) {
    throw new Error('Refusing to overwrite an existing Web GPT rescue login state');
  }
  const accountAlias = String(options.accountAlias ?? '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(accountAlias)) throw new Error('A verified expected account alias is required');
  const targetId = String(options.targetId ?? '').trim();
  if (!/^[A-Fa-f0-9]{32}$/.test(targetId)) throw new Error('An exact task-owned CDP target ID is required');
  const endpoint = loopbackEndpoint(options.endpoint ?? 'http://127.0.0.1:9222');
  const fetchImpl = options.fetch ?? fetch;
  const targetResponse = await fetchImpl(new URL('/json/list', endpoint), { signal: AbortSignal.timeout(2_500) });
  if (!targetResponse.ok) throw new Error(`CDP target list returned HTTP ${targetResponse.status}`);
  const targets = await targetResponse.json();
  const target = targets.find(candidate => candidate.id === targetId && candidate.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error(`Exact task-owned CDP target is unavailable: ${targetId}`);
  const targetUrl = new URL(target.url);
  if (targetUrl.protocol !== 'https:' || targetUrl.hostname !== 'chatgpt.com') {
    throw new Error(`CDP bootstrap target must already be on https://chatgpt.com: ${target.url}`);
  }

  const cdp = await connectCdp(target.webSocketDebuggerUrl, options);
  try {
    const quotedAlias = JSON.stringify(accountAlias.toLowerCase());
    const inspectionExpression = `(async()=>{
      const response=await fetch('/api/auth/session');
      const session=await response.json();
      const emails=[];
      const visit=value=>{
        if(!value||typeof value!=='object')return;
        for(const [key,item] of Object.entries(value)){
          if(key.toLowerCase().includes('email')&&typeof item==='string')emails.push(item);
          else visit(item);
        }
      };
      visit(session);
      return JSON.stringify({
        sessionOk:response.ok&&Object.keys(session||{}).length>0,
        aliasMatch:emails.some(email=>email.split('@')[0].toLowerCase()===${quotedAlias}),
        composer:!!document.querySelector('[data-testid="prompt-textarea"],#prompt-textarea,[contenteditable="true"][data-lexical-editor="true"]')
      });
    })()`;
    const inspectionResult = await cdp.send('Runtime.evaluate', {
      expression: inspectionExpression,
      awaitPromise: true,
      returnByValue: true
    });
    const inspection = JSON.parse(inspectionResult?.result?.value ?? '{}');
    if (!inspection.sessionOk || !inspection.aliasMatch || !inspection.composer) {
      throw new Error('The exact CDP target did not prove the expected authenticated ChatGPT account and composer');
    }

    await cdp.send('Network.enable');
    const allCookies = await cdp.send('Network.getAllCookies');
    const cookies = (allCookies.cookies ?? [])
      .filter(cookie => {
        const domain = String(cookie.domain ?? '').replace(/^\./, '');
        return domain === 'chatgpt.com' || domain.endsWith('.chatgpt.com')
          || domain === 'openai.com' || domain.endsWith('.openai.com')
          || domain === 'auth0.com' || domain.endsWith('.auth0.com');
      })
      .map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite === 'Strict' || cookie.sameSite === 'Lax' ? cookie.sameSite : 'None'
      }));
    if (!cookies.some(cookie => /session-token/.test(cookie.name))) {
      throw new Error('Authenticated CDP target did not expose a transferable ChatGPT session cookie');
    }
    atomicWrite(paths.storageState, `${JSON.stringify({ cookies, origins: [] })}\n`);
    atomicWrite(paths.loginMarker, `${JSON.stringify({
      version: 1,
      authenticated: true,
      verifiedAt: new Date().toISOString(),
      proAvailable: false,
      source: 'registered-cdp-minimal-transfer',
      accountAliasHash: crypto.createHash('sha256').update(accountAlias).digest('hex')
    })}\n`);
    return {
      ok: true,
      authenticated: true,
      source: 'registered-cdp-minimal-transfer',
      port: paths.port,
      cookieCount: cookies.length,
      copiedOrigins: 0,
      accountAliasHash: crypto.createHash('sha256').update(accountAlias).digest('hex')
    };
  } finally {
    cdp.close();
  }
}

export async function startWebGptRescue(options = {}) {
  if (effectivePlatform(options) === 'win32') throw new Error('web_gpt_rescue_windows_service_not_implemented');
  const paths = webGptRescuePaths(options);
  if (!fs.existsSync(paths.launchAgent)) throw new Error('Prepare the Web GPT rescue runtime before start');
  if (!fs.existsSync(paths.storageState) || readJson(paths.loginMarker)?.authenticated !== true) {
    throw new Error('Complete the isolated Web GPT rescue login before start');
  }
  const config = readJson(paths.config);
  if (!config?.controlToken) throw new Error('Web GPT rescue control token is missing');
  const wasLoaded = launchLoaded(options);
  const runner = options.spawnSync ?? spawnSync;
  const uid = unixUid(options);
  if (uid === null) throw new Error('user_uid_unknown');
  const target = `gui/${uid}/${LABEL}`;
  if (!wasLoaded) {
    const wasDisabled = launchDisabled(options);
    if (wasDisabled) {
      const enabled = runner('launchctl', ['enable', target], { encoding: 'utf8', stdio: 'pipe' });
      if (enabled.error) throw enabled.error;
      if (enabled.status !== 0) throw new Error(enabled.stderr?.trim() || `launchctl enable exited with ${enabled.status}`);
    }
    const result = runner('launchctl', ['bootstrap', `gui/${uid}`, paths.launchAgent], { encoding: 'utf8', stdio: 'pipe' });
    if (result.error || result.status !== 0) {
      if (wasDisabled) runner('launchctl', ['disable', target], { encoding: 'utf8', stdio: 'pipe' });
      if (result.error) throw result.error;
      throw new Error(result.stderr?.trim() || `launchctl bootstrap exited with ${result.status}`);
    }
  }
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let health = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${paths.port}/healthz`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch { /* startup remains UNKNOWN until the bounded loop ends */ }
    await sleep(100);
  }
  if (!health) throw new Error('Web GPT rescue health remained UNKNOWN after startup');
  const active = [health.active_http_turns, health.active_browser_http_turns, health.active_browser_turns];
  if (!active.every(value => Number.isInteger(value) && value === 0)) {
    throw new Error('Web GPT rescue browser resume requires exact zero active work');
  }
  if (health.accepting_browser_turns !== true) {
    const resume = await fetchImpl(`http://127.0.0.1:${paths.port}/admin/resume-browser`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.controlToken}` },
      signal: AbortSignal.timeout(2_500)
    });
    if (!resume.ok) throw new Error(`Web GPT rescue browser resume returned HTTP ${resume.status}`);
    const resumed = await resume.json();
    if (resumed.accepting_browser_turns !== true) throw new Error('Web GPT rescue browser did not enter accepting state');
  }
  return { ok: true, started: !wasLoaded, resumedBrowser: true, label: LABEL };
}

export async function stopWebGptRescue(options = {}) {
  if (effectivePlatform(options) === 'win32') throw new Error('web_gpt_rescue_windows_service_not_implemented');
  const status = await webGptRescueStatus(options);
  if (!status.loaded) return { ok: true, stopped: false, label: LABEL };
  const active = status.active;
  if (!active || !Number.isInteger(active.http) || !Number.isInteger(active.browserHttp) || !Number.isInteger(active.browser)) {
    throw new Error('Web GPT rescue active work is UNKNOWN; refusing to stop it');
  }
  if (active.http !== 0 || active.browserHttp !== 0 || active.browser !== 0) {
    throw new Error('Web GPT rescue has active work; refusing to stop it');
  }
  const runner = options.spawnSync ?? spawnSync;
  const uid = unixUid(options);
  if (uid === null) throw new Error('user_uid_unknown');
  const result = runner('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { encoding: 'utf8', stdio: 'pipe' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `launchctl bootout exited with ${result.status}`);
  return { ok: true, stopped: true, label: LABEL };
}

export const webGptRescueConstants = Object.freeze({ LABEL, DEFAULT_PORT });
