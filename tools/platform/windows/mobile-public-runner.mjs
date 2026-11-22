// Owned mobile UI lifecycle only. No model, browser, tunnel or queue worker is started.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';

const hash = value => createHash('sha256').update(value).digest('hex');
const sha = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9-]{36}$/;
const owner = path.resolve(process.env.AICC_STATE_ROOT ?? path.join(os.homedir(), '.ai-control-center'));
const within = (base, file) => { const r = path.relative(base, file); return !!r && !r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r); };
function regular(file, maximum = 4 * 1024 * 1024) {
  for (let p = path.resolve(file);; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw Error('linked_lifecycle_path');
    if (p === path.dirname(p)) break;
  }
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.nlink !== 1 || s.size > maximum) throw Error('invalid_lifecycle_file');
  return fs.readFileSync(file);
}
const configFile = path.resolve(process.argv[2] ?? '');
if (!within(path.join(owner, 'control-plane', 'mobile-public-runtime'), configFile)) throw Error('registered_lifecycle_config_required');
const configBytes = regular(configFile), cfg = JSON.parse(configBytes.toString('utf8').replace(/^\uFEFF/, ''));
if (cfg.schemaVersion !== 1 || !uuid.test(cfg.runtimeId ?? '') || !sha.test(cfg.controlNonce ?? '') || !sha.test(cfg.releaseManifestSha256 ?? '') || cfg.port !== 4383) throw Error('invalid_mobile_lifecycle_config');
const release = path.resolve(cfg.releaseRoot), manifestPath = path.join(release, '.aicc-release.json');
if (!within(path.join(owner, 'releases', 'cli'), release) || hash(regular(manifestPath, 16 * 1024 * 1024)) !== cfg.releaseManifestSha256) throw Error('mobile_release_pin_mismatch');
const manifest = JSON.parse(regular(manifestPath, 16 * 1024 * 1024).toString('utf8').replace(/^\uFEFF/, ''));
if (manifest.component !== 'mobile-public-control' || manifest.schemaVersion !== 1) throw Error('public_mobile_manifest_required');
for (const name of ['src/server.mjs','src/mobile-control.mjs','src/mobile-device-trust.mjs','src/dashboard-workspace.mjs','src/management-overview.mjs','src/goals/service.mjs','src/goals/user-action-ledger.mjs','public/mobile.html','public/mobile.js','public/dashboard-workspace.js','public/dashboard-workspace.css','public/aicc.webmanifest','public/aicc-sw.js','public/favicon.svg']) {
  const pin = manifest.files.find(f => f.path === name);
  if (!pin || !sha.test(pin.sha256) || hash(regular(path.join(release, name))) !== pin.sha256) throw Error('public_mobile_source_pin_mismatch');
}
const origin = new URL(cfg.remoteOrigin);
for (const size of [192, 512]) {
  const name = `public/aicc-icon-${size}.png`;
  const pin = manifest.files.find(f => f.path === name);
  if (!pin || !sha.test(pin.sha256) || hash(regular(path.join(release, name))) !== pin.sha256) throw Error('public_mobile_icon_pin_mismatch');
}
if (origin.protocol !== 'https:' || origin.origin !== cfg.remoteOrigin || origin.username || origin.password) throw Error('existing_https_origin_required');
const statusFile = path.resolve(cfg.statusFile);
if (!within(path.join(owner, 'runtime', 'mobile-public-control'), statusFile)) throw Error('owned_mobile_status_required');
const status = { schemaVersion: 1, controlProtocolVersion: 2, runtimeId: cfg.runtimeId, pid: process.pid, startedAt: new Date().toISOString(), releaseRoot: release, releaseManifestSha256: cfg.releaseManifestSha256, state: 'STARTING', automaticReplay: false };
function record(changes) {
  Object.assign(status, changes, { observedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  if (fs.existsSync(statusFile)) regular(statusFile);
  const temp = statusFile + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(status) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, statusFile);
}
const { startServer } = await import(pathToFileURL(path.join(release, 'src/server.mjs')).href);
const server = startServer({ host: '127.0.0.1', port: cfg.port, backgroundOpenaiMonitor: false, backgroundDesignSourceMonitor: false, backgroundRecoveryHandoff: false, mobile: { remoteOrigin: cfg.remoteOrigin } });
if (typeof server.beginMobileMaintenance !== 'function') throw Error('scoped_mobile_drain_not_supported');
server.once('listening', () => record({ state: 'LISTENING', address: '127.0.0.1', port: cfg.port }));
server.once('error', error => { record({ state: 'START_FAILED', errorCode: error.code ?? 'UNKNOWN' }); process.exitCode = 1; });
const seen = new Set();
function recordStopResult(request, changes) {
  // A later request must not erase an earlier refusal/ACK. The status file is
  // a latest-value view; this create-once receipt belongs to one exact input.
  const dir = path.join(path.dirname(configFile), 'stop-requests', request.operationId);
  const resultFile = path.join(dir, 'result.json');
  const requestBytes = regular(path.join(dir, 'request.json'), 4096);
  const saved = JSON.parse(requestBytes.toString('utf8'));
  const claim = JSON.parse(regular(path.join(dir, 'claim.json'), 4096).toString('utf8'));
  const { controlNonce, ...input } = request;
  if (Object.keys(saved).length !== Object.keys(input).length ||
      Object.keys(saved).some(k => saved[k] !== input[k]) ||
      claim.schemaVersion !== 1 || claim.operationId !== request.operationId ||
      claim.runtimeId !== cfg.runtimeId || claim.pid !== process.pid ||
      claim.requestSha256 !== hash(requestBytes) || claim.state !== 'CLAIMED_INPUT_OUTCOME_UNKNOWN')
    throw Error('stop_result_original_input_unproven');
  const result = { schemaVersion: 1, kind: 'aicc-mobile-stop-result/v1',
    operationId: request.operationId, runtimeId: cfg.runtimeId, pid: process.pid,
    startedAt: status.startedAt, releaseManifestSha256: cfg.releaseManifestSha256,
    requestSha256: hash(requestBytes), state: changes.state ?? status.state,
    lastStopResult: changes.lastStopResult, observedAt: new Date().toISOString(), automaticReplay: false };
  const fd = fs.openSync(resultFile, 'wx', 0o600);
  try { fs.writeSync(fd, JSON.stringify(result) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  record(changes);
}
const control = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
control.on('line', line => {
  if (line.length > 4096) return;
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (Object.keys(request).some(k => !['action','operationId','runtimeId','expectedPid','releaseManifestSha256','controlNonce','expectedStartedAt','expiresAt'].includes(k)) || request.action !== 'drain-and-stop' || !uuid.test(request.operationId ?? '') || request.runtimeId !== cfg.runtimeId || request.expectedPid !== process.pid || request.releaseManifestSha256 !== cfg.releaseManifestSha256 || request.controlNonce !== cfg.controlNonce || request.expectedStartedAt !== status.startedAt || !Number.isFinite(Date.parse(request.expiresAt)) || Date.parse(request.expiresAt) < Date.now() || Date.parse(request.expiresAt) > Date.now() + 60000 || seen.has(request.operationId)) return;
  seen.add(request.operationId);
  const terminal = changes => {
    try { recordStopResult(request, { ...changes, lastOperationId: request.operationId }); }
    catch { record({ lastOperationId: request.operationId, lastStopResult: 'UNKNOWN', stopResultReceipt: 'UNCONFIRMED' }); }
  };
  if (status.state !== 'LISTENING') { terminal({ lastStopResult: 'NOT_LISTENING_PRESERVED' }); return; }
  const gate = server.beginMobileMaintenance();
  if (!gate.accepted) { terminal({ lastStopResult: 'WORK_PRESERVED', drain: gate }); return; }
  record({ state: 'DRAINING', lastOperationId: request.operationId, lastStopResult: 'PENDING_NORMAL_STOP', drain: gate });
  server.close(error => {
    terminal({ state: error ? 'STOP_RESULT_UNKNOWN' : 'NORMAL_STOPPED', lastStopResult: error ? 'UNKNOWN' : 'NORMAL_STOP_ACK' });
    control.close();
    if (error) process.exitCode = 1;
  });
});
control.once('close', () => { if (!['NORMAL_STOPPED','STOP_RESULT_UNKNOWN'].includes(status.state)) record({ controlChannel: 'CLOSED', processPreserved: true }); });
