import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const relative = path.relative(root, file); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
function regularFile(file) {
  if (!path.isAbsolute(file ?? '')) throw Object.assign(Error(), { code: 'PATH_INVALID' });
  for (let current = file;; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw Object.assign(Error(), { code: 'LINK_REFUSED' });
    if (path.dirname(current) === current) break;
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.nlink !== 1) throw Object.assign(Error(), { code: 'FILE_INVALID' });
  return stat;
}
function bytes(file) {
  if (regularFile(file).size > 4 * 1024 * 1024) throw Object.assign(Error(), { code: 'FILE_INVALID' });
  return fs.readFileSync(file);
}
function pinnedDigest(file) {
  const before = regularFile(file);
  if (before.size > 512 * 1024 * 1024) throw Object.assign(Error(), { code: 'FILE_INVALID' });
  const descriptor = fs.openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) throw Object.assign(Error(), { code: 'PIN_MISMATCH' });
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    const after = regularFile(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Object.assign(Error(), { code: 'PIN_MISMATCH' });
    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}
const json = file => JSON.parse(bytes(file).toString('utf8').replace(/^\uFEFF/, ''));
function reason(error) {
  if (error.code === 'ENOENT') return 'NOT_REGISTERED';
  if (['EACCES', 'EPERM'].includes(error.code)) return 'OS_ACCESS_DENIED';
  return ['PIN_MISMATCH', 'LINK_REFUSED', 'PATH_INVALID', 'FILE_INVALID', 'BINDING_INVALID'].includes(error.code) ? error.code : 'RECORD_UNREADABLE';
}

const mobileRuntimeId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const mobileDigest = /^[a-f0-9]{64}$/;
const mobileScripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/platform/windows');
const samePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);

/**
 * Existing owner status + installed manifest pin + the existing non-Submit PowerShell
 * AST probe. The web API receives only bounded status codes, never owner paths,
 * PIDs, nonces, operation IDs, stop request content or the PowerShell raw output.
 * A LISTENING record is not independent process-liveness verification.
 */
function* mobilePublicStopSupport(ownerRoot) {
  const state = { status: 'UNKNOWN', reportedRuntimeState: 'UNKNOWN', liveProcessVerified: false,
    sourceComparison: 'UNKNOWN', installedSupervisorSupport: 'UNKNOWN',
    stopSubmissionSupported: null, stopHoldReason: 'STATUS_UNAVAILABLE',
    operationalTransition: 'HOLD', installationState: 'WAITING_FOR_NORMAL_STOP_AND_RECOVERY', stopControlEnabled: false,
    installControlEnabled: false, automaticReplay: false };
  const hold = code => ({ ...state, stopHoldReason: code });
  try {
    if (!path.isAbsolute(ownerRoot ?? '')) return hold('STATUS_UNAVAILABLE');
    const owner = path.resolve(ownerRoot);
    const base = path.join(owner, 'control-plane', 'mobile-public-runtime');
    const entries = fs.readdirSync(base, { withFileTypes: true });
    if (entries.length > 256) return hold('STATUS_AMBIGUOUS');
    const active = [];
    for (const entry of entries) {
      if (!mobileRuntimeId.test(entry.name)) continue;
      if (!entry.isDirectory()) return hold('STATUS_UNAVAILABLE');
      const configFile = path.join(base, entry.name, 'runtime.json');
      const configBytes = bytes(configFile), config = JSON.parse(configBytes.toString('utf8').replace(/^\uFEFF/, ''));
      if (config.schemaVersion !== 1 || config.runtimeId !== entry.name || config.port !== 4383
        || !mobileDigest.test(config.releaseManifestSha256 ?? '')
        || !path.isAbsolute(config.releaseRoot ?? '') || !path.isAbsolute(config.statusFile ?? '')
        || !samePath(config.statusFile, path.join(owner, 'runtime/mobile-public-control', entry.name, 'status.json'))) return hold('STATUS_UNAVAILABLE');
      const recordBytes = bytes(config.statusFile), record = JSON.parse(recordBytes.toString('utf8').replace(/^\uFEFF/, ''));
      if (record.schemaVersion !== 1 || record.controlProtocolVersion !== 2
        || record.runtimeId !== config.runtimeId || record.releaseManifestSha256 !== config.releaseManifestSha256
        || record.pid <= 0 || typeof record.startedAt !== 'string') return hold('STATUS_UNAVAILABLE');
      if (['LISTENING', 'DRAINING'].includes(record.state)) active.push({ configFile, configBytes, config, record, recordBytes });
    }
    if (active.length !== 1) return hold(active.length ? 'STATUS_AMBIGUOUS' : 'STATUS_UNAVAILABLE');
    const { configFile, configBytes, config, record, recordBytes } = active[0];
    state.status = 'REPORTED_' + record.state;
    state.reportedRuntimeState = record.state;
    const release = path.resolve(config.releaseRoot);
    if (!inside(path.join(owner, 'releases', 'cli'), release)) return hold('INSTALLED_SUPERVISOR_IDENTITY_UNKNOWN');
    const manifestBytes = bytes(path.join(release, '.aicc-release.json'));
    if (digest(manifestBytes) !== config.releaseManifestSha256) return hold('INSTALLED_SUPERVISOR_IDENTITY_UNKNOWN');
    const manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''));
    const relative = 'tools/platform/windows/Start-AiccMobilePublicRuntime.ps1';
    const pins = Array.isArray(manifest.files) ? manifest.files.filter(file => file.path === relative) : [];
    if (manifest.schemaVersion !== 1 || manifest.component !== 'mobile-public-control'
      || pins.length !== 1 || !mobileDigest.test(pins[0].sha256 ?? '')) return hold('INSTALLED_SUPERVISOR_IDENTITY_UNKNOWN');
    const installedSource = bytes(path.join(release, relative));
    if (digest(installedSource) !== pins[0].sha256 || (pins[0].size != null && pins[0].size !== installedSource.length)) return hold('INSTALLED_SUPERVISOR_IDENTITY_UNKNOWN');
    try {
      const source = bytes(path.join(mobileScripts, 'Start-AiccMobilePublicRuntime.ps1'));
      state.sourceComparison = digest(source) === digest(installedSource) ? 'MATCHES' : 'DIFFERS';
    } catch { /* Source comparison is optional evidence, never installed support. */ }
    const executable = path.join(owner, 'toolchain/pwsh-7.6.6/runtime/pwsh.exe');
    if (regularFile(executable).size > 128 * 1024 * 1024) return hold('PROBE_UNAVAILABLE');
    const scriptFile = path.join(mobileScripts, 'Request-AiccMobilePublicStop.ps1');
    if (!bytes(scriptFile).toString('utf8').includes('stopSubmissionSupported=')) return hold('PROBE_UNAVAILABLE');
    // Explicitly omit -Submit. No request, claim, task, process or service mutation.
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptFile,
      '-ConfigFile', configFile, '-ExpectedConfigSha256', digest(configBytes),
      '-OperationId', randomUUID(), '-WaitSeconds', '0'];
    const probe = yield [executable, args, { encoding: 'utf8', timeout: 6000,
      windowsHide: true, maxBuffer: 16 * 1024 }];
    if (probe.error || probe.status !== 0 || typeof probe.stdout !== 'string' || probe.stdout.length > 8192) return hold('PROBE_UNAVAILABLE');
    if (digest(bytes(configFile)) !== digest(configBytes)
      || digest(bytes(config.statusFile)) !== digest(recordBytes)
      || digest(bytes(path.join(release, '.aicc-release.json'))) !== digest(manifestBytes)
      || digest(bytes(path.join(release, relative))) !== digest(installedSource)) return hold('PROBE_UNAVAILABLE');
    const answer = JSON.parse(probe.stdout.replace(/^\uFEFF/, '').trim());
    if (answer.runtimeId !== config.runtimeId || answer.runtimeState !== record.state
      || answer.submittedThisCall !== false || answer.automaticReplay !== false || answer.forceStop !== false) return hold('PROBE_UNAVAILABLE');
    if (answer.stopSubmissionSupported === true && answer.stopHoldReason == null) {
      state.installedSupervisorSupport = 'SUPPORTED';
      state.stopSubmissionSupported = true;
      state.stopHoldReason = null;
    } else if (answer.stopSubmissionSupported === false
      && ['INSTALLED_SUPERVISOR_DATE_STRING_UNSUPPORTED', 'INSTALLED_SUPERVISOR_JSON_CONTRACT_UNKNOWN',
        'INSTALLED_SUPERVISOR_PARSE_UNKNOWN', 'INSTALLED_SUPERVISOR_IDENTITY_UNKNOWN'].includes(answer.stopHoldReason)) {
      state.stopSubmissionSupported = false;
      state.stopHoldReason = answer.stopHoldReason;
      state.installedSupervisorSupport = answer.stopHoldReason === 'INSTALLED_SUPERVISOR_DATE_STRING_UNSUPPORTED' ? 'UNSUPPORTED' : 'UNKNOWN';
    } else if (answer.stopSubmissionSupported === false &&
      ['EXISTING_STOP_OUTCOME_UNCONFIRMED', 'EXISTING_STOP_INVENTORY_UNKNOWN'].includes(answer.stopHoldReason)) {
      state.stopSubmissionSupported = false;
      state.stopHoldReason = answer.stopHoldReason;
      state.installedSupervisorSupport = answer.installedSupervisorSupported === true ? 'SUPPORTED' :
        answer.installedSupervisorSupported === false ? 'UNSUPPORTED' : 'UNKNOWN';
    } else return hold('PROBE_UNAVAILABLE');
    return state;
  } catch { return hold('STATUS_UNAVAILABLE'); }
}

// Share the same pinned projection with synchronous CLI consumers. Web handlers
// await the bounded child instead of freezing all other authenticated requests.
export function readMobilePublicStopSupport(ownerRoot, { spawn = spawnSync } = {}) {
  const reader = mobilePublicStopSupport(ownerRoot);
  const step = reader.next();
  if (step.done) return step.value;
  try { return reader.next(spawn(...step.value)).value; }
  catch (error) { return reader.throw(error).value; }
}

async function probeMobilePublicStopSupportAsync(ownerRoot, execute) {
  const reader = mobilePublicStopSupport(ownerRoot);
  const step = reader.next();
  if (step.done) return step.value;
  try {
    const invoke = execute ?? ((file, args, options) => new Promise(resolve => {
      execFile(file, args, options, (error, stdout) => resolve({
        status: error ? 1 : 0, error, stdout,
      }));
    }));
    return reader.next(await invoke(...step.value)).value;
  } catch (error) {
    return reader.throw(error).value;
  }
}

// Coalesce only overlapping reads from the same owner and executor. Do not
// retain a settled status: each later refresh rechecks the installed generation.
const pendingMobileStopReads = new Map();
export async function readMobilePublicStopSupportAsync(ownerRoot, { execute } = {}) {
  if (typeof ownerRoot !== 'string' || !path.isAbsolute(ownerRoot)) {
    return probeMobilePublicStopSupportAsync(ownerRoot, execute);
  }
  const resolved = path.resolve(ownerRoot);
  const ownerKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  let byExecutor = pendingMobileStopReads.get(ownerKey);
  if (!byExecutor) { byExecutor = new Map(); pendingMobileStopReads.set(ownerKey, byExecutor); }
  let reading = byExecutor.get(execute);
  if (!reading) {
    reading = probeMobilePublicStopSupportAsync(ownerRoot, execute);
    byExecutor.set(execute, reading);
  }
  try {
    // The projection contains only scalar evidence; never expose a shared
    // mutable object that could let one caller alter another caller's result.
    return { ...await reading };
  } finally {
    if (byExecutor.get(execute) === reading) byExecutor.delete(execute);
    if (!byExecutor.size && pendingMobileStopReads.get(ownerKey) === byExecutor) pendingMobileStopReads.delete(ownerKey);
  }
}
/** Installed names and pinned files only: no provider launch, input-schema discovery or publication write. */
export function readInstalledGatewayRegistration(ownerRoot) {
  const base = { scope: 'installed-unified-gateway-name-registration-only', inputSchemasVerified: false,
    remotePublicationVerified: false, executionVerified: false, observedAt: new Date().toISOString() };
  const fail = code => { throw Object.assign(Error(), { code }); };
  let failedCheck = 'registry', providerId = null, pinIndex = null;
  try {
    if (!path.isAbsolute(ownerRoot ?? '')) fail('PATH_INVALID');
    const owner = path.resolve(ownerRoot);
    const registryFile = path.join(owner, 'runtime', 'components.json'), registryBytes = bytes(registryFile);
    const registry = JSON.parse(registryBytes.toString('utf8').replace(/^\uFEFF/, ''));
    const gateway = registry.components?.['unified-mcp'];
    if (!gateway || !path.isAbsolute(gateway.releaseRoot ?? '') || !inside(path.join(owner, 'releases', 'unified-mcp'), gateway.releaseRoot)) fail('BINDING_INVALID');
    const release = path.resolve(gateway.releaseRoot);
    const normalized = file => {
      if (!path.isAbsolute(file ?? '')) fail('PATH_INVALID');
      const full = path.resolve(file);
      return process.platform === 'win32' ? full.toLowerCase() : full;
    };
    const hashes = new Map();
    const fileHash = file => {
      const key = normalized(file);
      if (!hashes.has(key)) hashes.set(key, pinnedDigest(file));
      return hashes.get(key);
    };
    failedCheck = 'gateway-entry-pin';
    if (normalized(gateway.entry) !== normalized(path.join(release, 'gateway.cjs')) || !/^[a-f0-9]{64}$/.test(gateway.entryHash ?? '') || fileHash(gateway.entry) !== gateway.entryHash) fail('PIN_MISMATCH');
    failedCheck = 'gateway-manifest';
    const manifestFile = path.join(release, 'manifest.json'), manifestBytes = bytes(manifestFile);
    const manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (manifest.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
      || !manifest.files['gateway.cjs'] || !manifest.files['config.json'] || Object.keys(manifest.files).length > 500) fail('MANIFEST_INVALID');
    for (const [relative, expected] of Object.entries(manifest.files)) {
      const file = path.resolve(release, relative);
      if (path.isAbsolute(relative) || !inside(release, file) || !/^[a-f0-9]{64}$/.test(expected)) fail('MANIFEST_INVALID');
      if (fileHash(file) !== expected) fail('PIN_MISMATCH');
    }
    failedCheck = 'gateway-config';
    const configFile = path.join(release, 'config.json'), configBytes = bytes(configFile);
    if (digest(configBytes) !== manifest.files['config.json']) fail('PIN_MISMATCH');
    const config = JSON.parse(configBytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (config.schemaVersion !== 1 || config.surfaceProfile !== 'business-full' || !Array.isArray(config.providers)) fail('PROVIDER_INVALID');
    const ids = config.providers.map(provider => provider?.id);
    const expectedIds = config.hostControl === 'task-owned-v1' ? ['host','native','workspace'] : ['native','workspace'];
    if (ids.length !== expectedIds.length || new Set(ids).size !== ids.length || ids.some(id => !expectedIds.includes(id))) fail('PROVIDER_INVALID');
    const allNames = new Set(), providers = [];
    for (const provider of config.providers) {
      providerId = provider.id; failedCheck = 'provider-tools'; pinIndex = null;
      const pattern = provider.id === 'native' ? /^codex_[a-z0-9_]+$/ : provider.id === 'host' ? /^aicc_host_[a-z0-9_]+$/ : /^aicc_(?!host_)[a-z0-9_]+$/;
      if (!Array.isArray(provider.toolNames) || !provider.toolNames.length || provider.toolNames.length > 500 || !/^[a-f0-9]{64}$/.test(provider.toolHash ?? '')) fail('TOOLS_INVALID');
      for (const name of provider.toolNames) {
        if (typeof name !== 'string' || name.length > 128 || !pattern.test(name) || allNames.has(name)) fail('TOOLS_INVALID');
        allNames.add(name);
      }
      if (!Array.isArray(provider.files) || !provider.files.length || provider.files.length > 1000 || !Array.isArray(provider.args) || provider.args[0] !== provider.entrypoint) fail('PROVIDER_INVALID');
      const pins = new Set();
      failedCheck = 'provider-file-pin';
      for (const [index, pin] of provider.files.entries()) {
        pinIndex = index;
        const key = normalized(pin?.path);
        if (pins.has(key) || !/^[a-f0-9]{64}$/.test(pin.sha256 ?? '')) fail('PROVIDER_INVALID');
        pins.add(key);
        if (fileHash(pin.path) !== pin.sha256) fail('PIN_MISMATCH');
      }
      if (!pins.has(normalized(provider.command)) || !pins.has(normalized(provider.entrypoint))) fail('PROVIDER_INVALID');
      providers.push({ id: provider.id, toolCount: provider.toolNames.length, toolNames: [...provider.toolNames].sort() });
    }
    failedCheck = 'registration-preimage'; providerId = null; pinIndex = null;
    if (digest(bytes(registryFile)) !== digest(registryBytes) || digest(bytes(manifestFile)) !== digest(manifestBytes) || digest(bytes(configFile)) !== digest(configBytes)) fail('REGISTRATION_CHANGED');
    return { ...base, status: 'VERIFIED_NAME_REGISTRATION', surfaceProfile: config.surfaceProfile,
      manifestSha256: digest(manifestBytes), configSha256: digest(configBytes), filePinsVerified: true,
      providers, toolCount: allNames.size, toolNames: [...allNames].sort(),
      meaning: '설치 등록 이름과 파일 pin의 읽기 증거입니다. 전체 inputSchema·원격 게시·실행 검증은 아닙니다.' };
  } catch (error) {
    return { ...base, status: 'NOT_VERIFIED', reason: ['MANIFEST_INVALID','PROVIDER_INVALID','TOOLS_INVALID','REGISTRATION_CHANGED'].includes(error.code) ? error.code : reason(error),
      failedCheck, ...(providerId ? { providerId } : {}), ...(pinIndex != null ? { pinIndex } : {}),
      filePinsVerified: false, providers: [], toolCount: null, toolNames: [] };
  }
}

// A read-only projection of the existing registered owners. It grants no lease,
// executes no manager and never exports identities, paths, request bodies or keys.
export function readManagementOverview(ownerRoot, { mobilePublic = readMobilePublicStopSupport(ownerRoot) } = {}) {
  const owner = path.resolve(ownerRoot);
  const snapshot = { ok: true, observedAt: new Date().toISOString(), manager: 'AICC 관리기',
    executionNotice: '관리기 이름은 관리 대상입니다. 실행은 현재 도구와 권한을 가진 지피티 또는 코덱스가 맡습니다.',
    runtimeVerified: false, automaticReplay: false, gpt: { status: 'NOT_REGISTERED', actions: [] }, codex: { status: 'NOT_REGISTERED' }, host: { status: 'NOT_REGISTERED' },
    mobilePublic };
  try {
    const config = json(path.join(owner, 'workspace-mcp', 'config.json'));
    snapshot.codex = { status: config.codexCli?.enabled === true ? 'REGISTERED' : 'NOT_REGISTERED',
      cliRegistered: config.codexCli?.enabled === true, liveExecution: 'UNOBSERVED',
      entrypoints: ['대화·큐', 'CLI', '계정·한도', '도구·설정'] };
    if (config.webManagement?.enabled === true) {
      const bindingFile = config.webManagement.bindingFile;
      if (!inside(owner, bindingFile)) throw Object.assign(Error(), { code: 'BINDING_INVALID' });
      const raw = bytes(bindingFile);
      if (digest(raw) !== config.webManagement.bindingSha256) throw Object.assign(Error(), { code: 'PIN_MISMATCH' });
      const binding = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
      if (binding.schemaVersion !== 1 || binding.kind !== 'aicc-web-management-owner-binding' || binding.executionBoundary !== 'owner-registered-fixed-web-manager'
        || !Array.isArray(binding.allowedActions) || binding.allowedActions.some(value => typeof value !== 'string' || !/^[a-z-]{1,64}$/.test(value))) throw Object.assign(Error(), { code: 'BINDING_INVALID' });
      snapshot.gpt = { status: 'REGISTERED', actions: [...new Set(binding.allowedActions)], liveExecution: 'UNOBSERVED',
        invocation: 'aicc_web_management_start / aicc_web_management_status',
        nativePlugins: '기존 Plugin Creator 연결 도구에서 생성·수정합니다. 이 등록 목록과 별도입니다.',
        blockedRequestCount: Array.isArray(binding.blockedRequestHashes) ? binding.blockedRequestHashes.length : null,
        blockedAssetCount: Array.isArray(binding.blockedAssetKeys) ? binding.blockedAssetKeys.length : null };
      const directory = binding.operationDirectory;
      if (!inside(owner, directory)) throw Object.assign(Error(), { code: 'BINDING_INVALID' });
      for (let current = directory;; current = path.dirname(current)) {
        if (fs.lstatSync(current).isSymbolicLink()) throw Object.assign(Error(), { code: 'LINK_REFUSED' });
        if (path.dirname(current) === current) break;
      }
      const files = fs.readdirSync(directory);
      if (files.length > 5000) throw Object.assign(Error(), { code: 'FILE_INVALID' });
      const phases = {}; let records = 0;
      for (const name of files.filter(name => /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}\.json$/.test(name))) {
        const record = json(path.join(directory, name));
        if (record.bindingId !== binding.bindingId || typeof record.phase !== 'string') continue;
        const phase = ['PREPARED', 'DISPATCHING', 'COMPLETED', 'OUTCOME_UNKNOWN_RECONCILE'].includes(record.phase) ? record.phase : 'UNRECOGNIZED';
        phases[phase] = (phases[phase] ?? 0) + 1; records++;
      }
      snapshot.gpt.operations = { records, phases, meaning: '도구 원 작업 기록입니다. 자산 전체 수나 부모 목표 완료가 아닙니다.' };
    }
  } catch (error) { snapshot.gpt = { ...snapshot.gpt, status: reason(error), supportConfirmed: false }; }
  try {
    const registry = json(path.join(owner, 'runtime', 'components.json'));
    const gateway = registry.components?.['unified-mcp'];
    const gatewayConfig = path.join(gateway.releaseRoot, 'config.json');
    if (!inside(path.join(owner, 'releases', 'unified-mcp'), gatewayConfig)) throw Object.assign(Error(), { code: 'BINDING_INVALID' });
    const provider = json(gatewayConfig).providers?.find(value => value.id === 'host');
    if (provider) snapshot.host = { status: 'REGISTERED', toolCount: provider.toolNames?.length ?? null,
      sessionInventory: provider.toolNames?.includes('aicc_host_sessions') === true, explicitWait: provider.toolNames?.includes('aicc_host_wait') === true,
      liveCapacity: 'UNOBSERVED', sourceAvailabilityIsInstallation: false };
  } catch (error) { snapshot.host = { status: reason(error), liveCapacity: 'UNOBSERVED' }; }
  return snapshot;
}
