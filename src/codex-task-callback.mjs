import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CodexAppServerClient, loadAppServerManifest } from './adapters/codex-app-server.mjs';
import { createCodexAppServerDaemonSpawn, validateOwnerOnlyUnixSocket } from './adapters/codex-app-server-daemon.mjs';
import { createCodexAppServerProxySpawn, validateSharedProxySocket } from './adapters/codex-app-server-proxy.mjs';

const SCHEMA_VERSION = 1;
const MAX_RESULT_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const SAFE_PROJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_STATUS = /^[A-Z][A-Z0-9_:-]{0,63}$/;
const TERMINAL_TURN_STATES = new Set(['completed', 'interrupted', 'failed']);
const TERMINAL_CALLBACK_STATES = new Set(['completed', 'terminal_interrupted', 'terminal_failed']);
const CANCELLATION_REASONS = new Set(['manual_resume', 'operator_cancelled']);

export class CodexTaskCallbackError extends Error {
  constructor(code, message = code, data = null) {
    super(message);
    this.name = 'CodexTaskCallbackError';
    this.code = code;
    this.data = data;
  }
}

function requireIdentifier(value, pattern, code) {
  const normalized = String(value ?? '').trim();
  if (!pattern.test(normalized)) throw new CodexTaskCallbackError(code);
  return normalized;
}

function assertNoControlCharacters(value, code) {
  if (/\p{Cc}/u.test(value)) throw new CodexTaskCallbackError(code);
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CodexTaskCallbackError('callback_directory_unsafe');
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0) throw new CodexTaskCallbackError('callback_directory_permissions_unsafe');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new CodexTaskCallbackError('callback_directory_owner_unsafe');
  }
}

function assertOwnedRegularFile(file, { privateFile = false, code = 'callback_file_unsafe' } = {}) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CodexTaskCallbackError(code);
  if (process.platform !== 'win32') {
    if (privateFile && (stat.mode & 0o077) !== 0) throw new CodexTaskCallbackError(`${code}_permissions`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new CodexTaskCallbackError(`${code}_owner`);
  }
  return stat;
}

function assertPrivateParent(file) {
  const parent = fs.realpathSync(path.dirname(file));
  if (parent !== path.dirname(file)) throw new CodexTaskCallbackError('callback_result_parent_alias');
  ensurePrivateDirectory(parent);
  return parent;
}

function atomicPrivateJson(file, value) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function atomicPrivateText(file, value) {
  ensurePrivateDirectory(path.dirname(file));
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function sha256File(file, maximumBytes = Number.POSITIVE_INFINITY) {
  const stat = assertOwnedRegularFile(file, { code: 'callback_hash_file_unsafe' });
  if (!stat) throw new CodexTaskCallbackError('callback_hash_file_missing');
  if (stat.size > maximumBytes) throw new CodexTaskCallbackError('callback_file_too_large');
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function canonicalDirectory(directory, code) {
  if (!path.isAbsolute(directory)) throw new CodexTaskCallbackError(code);
  assertNoControlCharacters(directory, code);
  const canonical = fs.realpathSync(directory);
  if (path.resolve(directory) !== canonical) throw new CodexTaskCallbackError(`${code}_alias`);
  const stat = fs.lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CodexTaskCallbackError(code);
  return canonical;
}

function normalizeResultFile(file) {
  if (!path.isAbsolute(file)) throw new CodexTaskCallbackError('callback_result_path_invalid');
  assertNoControlCharacters(file, 'callback_result_path_invalid');
  const normalized = path.resolve(file);
  assertPrivateParent(normalized);
  return normalized;
}

function readJson(file, code) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new CodexTaskCallbackError(code); }
}

function parseCodexVersion(output) {
  const match = String(output ?? '').trim().match(/(?:codex-cli\s+)?([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)/);
  return match?.[1] ?? null;
}

function commandInvocation(executable, args) {
  if (process.platform !== 'win32') return { executable, args };
  const extension = path.extname(executable).toLowerCase();
  const absolute = path.win32.isAbsolute(executable) || path.isAbsolute(executable);
  const requiresCmd = !absolute || ['.bat', '.cmd', '.ps1'].includes(extension) || !extension;
  if (!requiresCmd) return { executable, args };
  const shell = process.env.ComSpec?.trim() || 'cmd.exe';
  return { executable: shell, args: ['/d', '/s', '/c', executable, ...args] };
}

function inspectPinnedBinary(executable, manifest) {
  if (!path.isAbsolute(executable)) throw new CodexTaskCallbackError('callback_codex_executable_invalid');
  assertNoControlCharacters(executable, 'callback_codex_executable_invalid');
  assertOwnedRegularFile(executable, { code: 'callback_codex_executable_unsafe' });
  const invocation = commandInvocation(executable, ['--version']);
  const versionResult = spawnSync(invocation.executable, invocation.args, { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (versionResult.error || versionResult.status !== 0) throw new CodexTaskCallbackError('callback_codex_version_unavailable');
  const version = parseCodexVersion(versionResult.stdout);
  if (version !== manifest.codexVersion) {
    throw new CodexTaskCallbackError('callback_codex_version_mismatch', 'pinned Codex binary does not match the schema manifest', {
      expected: manifest.codexVersion,
      observed: version
    });
  }
  return { version, sha256: sha256File(executable) };
}

function validateThreadScope(response, binding, { allowNotLoaded = false, allowActive = false } = {}) {
  const thread = response?.thread;
  if (!thread || thread.id !== binding.taskId) throw new CodexTaskCallbackError('callback_thread_identity_mismatch');
  let cwd;
  try { cwd = fs.realpathSync(thread.cwd); }
  catch { throw new CodexTaskCallbackError('callback_thread_root_unavailable'); }
  if (cwd !== binding.projectRoot) throw new CodexTaskCallbackError('callback_thread_root_mismatch');
  const status = thread.status?.type;
  if (status === 'active' && !allowActive) throw new CodexTaskCallbackError('callback_thread_active');
  const allowedStates = allowNotLoaded ? ['idle', 'notLoaded'] : ['idle'];
  if (allowActive) allowedStates.push('active');
  if (!allowedStates.includes(status)) {
    throw new CodexTaskCallbackError('callback_thread_state_unknown', 'Codex thread state is not supported for this operation', { status: status ?? null });
  }
  const inProgress = (thread.turns ?? []).filter(turn => turn?.status === 'inProgress');
  if (inProgress.length && !allowActive) throw new CodexTaskCallbackError('callback_thread_active');
  return thread;
}

function resultProof(binding) {
  const stat = assertOwnedRegularFile(binding.resultFile, { privateFile: true, code: 'callback_result_unsafe' });
  if (!stat) throw new CodexTaskCallbackError('callback_result_missing');
  if (stat.size > MAX_RESULT_BYTES) throw new CodexTaskCallbackError('callback_result_too_large');
  const document = readJson(binding.resultFile, 'callback_result_invalid_json');
  if (document?.[binding.operationField] !== binding.operationId) throw new CodexTaskCallbackError('callback_result_operation_mismatch');
  const status = document?.[binding.statusField];
  if (!binding.terminalStatuses.includes(status)) throw new CodexTaskCallbackError('callback_result_not_terminal');
  return { status, sha256: sha256File(binding.resultFile, MAX_RESULT_BYTES), bytes: stat.size };
}

function callbackPrompt(binding, proof) {
  return [
    '[AICC 자동 완료 이벤트]',
    `프로젝트 ${binding.projectKey}의 터미널 작업 ${binding.operationId}이 terminal 상태 ${proof.status}로 끝났습니다.`,
    `검증된 결과 파일: ${binding.resultFile}`,
    `SHA-256: ${proof.sha256}`,
    '이 자동 callback turn은 사용자 UI를 오래 점유하지 않는 60초 이내의 짧은 인수 turn입니다.',
    '결과 확인과 간결한 checkpoint만 수행하고, 장기 polling·광범위 탐색·두 번째 foreground 전환은 시작하지 마세요.',
    '60초 안에 끝낼 수 없는 남은 작업은 정확한 다음 행동과 안전 조건을 기록한 뒤 이 turn을 정상 완료하세요.',
    '사용자 메시지가 새로 도착하면 자동 turn을 이어 붙이거나 재발행하지 말고 새 사용자 turn을 우선하세요.',
    '전달 ACK·이 callback turn의 종료·원 결과 소비·제품/parent 목표 완료는 별개입니다. 실제 소비 근거 없이 adoption이나 전체 완료를 선언하지 마세요.',
    '현재 정본과 live state를 다시 확인하고, 완료된 작업을 반복하지 말고 다음 미완료 단계를 계속 수행하세요.',
    'source·historical evidence를 current runtime/browser PASS로 바꾸지 말고 active/UNKNOWN 작업을 종료하지 마세요.'
  ].join('\n');
}

function isDestinationWriterBusy(error) {
  return /already has an active writer/i.test(String(error?.message ?? ''));
}

function callbackTerminalState(turnStatus) {
  if (!TERMINAL_TURN_STATES.has(turnStatus)) throw new CodexTaskCallbackError('callback_turn_terminal_unknown');
  return turnStatus === 'completed' ? 'completed' : `terminal_${turnStatus}`;
}

export function defaultCodexTaskCallbackRoot(options = {}) {
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT ?? path.join(os.homedir(), '.ai-control-center');
  if (!path.isAbsolute(stateRoot)) throw new CodexTaskCallbackError('callback_state_root_invalid');
  return path.join(stateRoot, 'runtime', 'codex-task-callback');
}

export class CodexTaskCallbackService {
  constructor({ root, stateRoot, now = () => Date.now(), maxTtlMs = 24 * 60 * 60_000, randomUUID = crypto.randomUUID, randomBytes = crypto.randomBytes, clientFactory } = {}) {
    this.root = root ?? defaultCodexTaskCallbackRoot({ stateRoot });
    if (!path.isAbsolute(this.root)) throw new CodexTaskCallbackError('callback_root_invalid');
    if (!Number.isInteger(maxTtlMs) || maxTtlMs < 60_000 || maxTtlMs > 7 * 24 * 60 * 60_000) throw new CodexTaskCallbackError('callback_ttl_invalid');
    this.now = now;
    this.maxTtlMs = maxTtlMs;
    this.randomUUID = randomUUID;
    this.randomBytes = randomBytes;
    this.clientFactory = clientFactory ?? (options => new CodexAppServerClient(options));
  }

  #paths(callbackId) {
    const id = requireIdentifier(callbackId, SAFE_ID, 'callback_id_invalid');
    const directory = path.join(this.root, id);
    if (path.dirname(directory) !== path.resolve(this.root)) throw new CodexTaskCallbackError('callback_id_invalid');
    return { directory, binding: path.join(directory, 'binding.json'), token: path.join(directory, 'token'), lock: path.join(directory, 'complete.lock') };
  }

  #readBinding(callbackId) {
    const paths = this.#paths(callbackId);
    assertOwnedRegularFile(paths.binding, { privateFile: true, code: 'callback_binding_unsafe' });
    const binding = readJson(paths.binding, 'callback_binding_invalid');
    if (binding?.schemaVersion !== SCHEMA_VERSION || binding.callbackId !== callbackId) throw new CodexTaskCallbackError('callback_binding_invalid');
    return { paths, binding };
  }

  #writeBinding(paths, binding) {
    atomicPrivateJson(paths.binding, binding);
  }

  async #withLock(paths, work) {
    ensurePrivateDirectory(paths.directory);
    let descriptor;
    try { descriptor = fs.openSync(paths.lock, 'wx', 0o600); }
    catch (error) {
      if (error?.code === 'EEXIST') throw new CodexTaskCallbackError('callback_writer_busy');
      throw error;
    }
    try { return await work(); }
    finally {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
      try { fs.unlinkSync(paths.lock); } catch { /* exact lock already gone */ }
    }
  }

  arm({ projectKey, taskId, projectRoot, operationId, resultFile, manifestFile, codexExecutable, controlSocket = null, sharedDaemonProtocol = 'websocket-rpc', statusField = 'status', operationField = 'operation', terminalStatuses = ['PASS', 'HOLD', 'FAIL'], expiresAt = null } = {}) {
    const project = requireIdentifier(projectKey, SAFE_PROJECT_KEY, 'callback_project_key_invalid');
    const task = requireIdentifier(taskId, SAFE_ID, 'callback_task_id_invalid');
    const operation = requireIdentifier(operationId, SAFE_ID, 'callback_operation_id_invalid');
    const canonicalRoot = canonicalDirectory(projectRoot, 'callback_project_root_invalid');
    const result = normalizeResultFile(resultFile);
    if (fs.existsSync(result)) throw new CodexTaskCallbackError('callback_result_preexists');
    const statusKey = requireIdentifier(statusField, SAFE_FIELD, 'callback_status_field_invalid');
    const operationKey = requireIdentifier(operationField, SAFE_FIELD, 'callback_operation_field_invalid');
    if (!Array.isArray(terminalStatuses) || terminalStatuses.length < 1 || terminalStatuses.length > 12) throw new CodexTaskCallbackError('callback_terminal_statuses_invalid');
    const statuses = [...new Set(terminalStatuses.map(value => requireIdentifier(value, SAFE_STATUS, 'callback_terminal_status_invalid')))];
    if (!path.isAbsolute(manifestFile)) throw new CodexTaskCallbackError('callback_manifest_path_invalid');
    const manifestPath = path.resolve(manifestFile);
    assertOwnedRegularFile(manifestPath, { code: 'callback_manifest_unsafe' });
    const manifest = loadAppServerManifest(manifestPath);
    const executable = path.resolve(codexExecutable);
    const binary = inspectPinnedBinary(executable, manifest);
    if (!['websocket-rpc', 'official-proxy'].includes(sharedDaemonProtocol)) throw new CodexTaskCallbackError('callback_shared_protocol_invalid');
    if (sharedDaemonProtocol === 'official-proxy' && controlSocket == null) throw new CodexTaskCallbackError('callback_shared_socket_required');
    const daemonSocket = controlSocket == null ? null : (sharedDaemonProtocol === 'official-proxy'
      ? validateSharedProxySocket(controlSocket)
      : validateOwnerOnlyUnixSocket(controlSocket));
    const now = this.now();
    const requestedExpiry = expiresAt == null ? now + this.maxTtlMs : Date.parse(expiresAt);
    if (!Number.isFinite(requestedExpiry) || requestedExpiry <= now) throw new CodexTaskCallbackError('callback_expiry_invalid');
    const callbackId = this.randomUUID();
    const paths = this.#paths(callbackId);
    if (fs.existsSync(paths.directory)) throw new CodexTaskCallbackError('callback_id_conflict');
    ensurePrivateDirectory(paths.directory);
    const token = this.randomBytes(32).toString('base64url');
    atomicPrivateText(paths.token, `${token}\n`);
    const binding = {
      schemaVersion: SCHEMA_VERSION,
      callbackId,
      state: 'armed',
      projectKey: project,
      taskId: task,
      projectRoot: canonicalRoot,
      operationId: operation,
      resultFile: result,
      statusField: statusKey,
      operationField: operationKey,
      terminalStatuses: statuses,
      manifestFile: manifestPath,
      manifestSha256: sha256File(manifestPath),
      codexExecutable: executable,
      codexExecutableSha256: binary.sha256,
      codexVersion: binary.version,
      deliveryTransport: daemonSocket == null ? 'owned-stdio' : (sharedDaemonProtocol === 'official-proxy' ? 'desktop-shared-daemon-proxy' : 'desktop-shared-daemon'),
      sharedDaemonProtocol: daemonSocket == null ? null : sharedDaemonProtocol,
      controlSocket: daemonSocket,
      tokenSha256: crypto.createHash('sha256').update(token).digest('hex'),
      clientUserMessageId: `aicc-terminal-callback:${callbackId}`,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(Math.min(requestedExpiry, now + this.maxTtlMs)).toISOString(),
      updatedAt: new Date(now).toISOString()
    };
    this.#writeBinding(paths, binding);
    return Object.freeze({ ok: true, state: 'armed', callbackId, tokenFile: paths.token, expiresAt: binding.expiresAt, operationId: operation, taskId: task, deliveryTransport: binding.deliveryTransport });
  }

  inspect({ callbackId } = {}) {
    const { binding } = this.#readBinding(callbackId);
    return Object.freeze({
      ok: true,
      callbackId: binding.callbackId,
      state: binding.state,
      projectKey: binding.projectKey,
      taskId: binding.taskId,
      operationId: binding.operationId,
      projectRoot: binding.projectRoot,
      deliveryTransport: binding.deliveryTransport ?? 'owned-stdio',
      controlSocket: binding.controlSocket ?? null,
      sharedDaemonProtocol: binding.sharedDaemonProtocol ?? (binding.controlSocket == null ? null : 'websocket-rpc'),
      resultFile: binding.resultFile,
      resultSha256: binding.resultSha256 ?? null,
      resultStatus: binding.resultStatus ?? null,
      turnId: binding.turnId ?? null,
      terminalTurnStatus: binding.terminalTurnStatus ?? null,
      evidence: {
        dispatchIntentAt: binding.dispatchStartedAt ?? null,
        turnStartAck: binding.turnId ? { turnId: binding.turnId, receivedAt: binding.turnStartedAt ?? null } : null,
        sourceResult: binding.resultSha256 ? { operationId: binding.operationId, sha256: binding.resultSha256, status: binding.resultStatus ?? null } : null,
        terminalTurn: binding.terminalTurnStatus ? { turnId: binding.turnId, status: binding.terminalTurnStatus, observedAt: binding.completedAt ?? null } : null,
        deliveryUnknown: binding.state === 'dispatching',
        parentAdoption: 'unknown',
        parentGoalCompletion: 'unknown'
      },
      lastDeliveryErrorCode: binding.lastDeliveryErrorCode ?? null,
      deliveryBlockedAt: binding.deliveryBlockedAt ?? null,
      expiresAt: binding.expiresAt,
      completedAt: binding.completedAt ?? null,
      cancelledAt: binding.cancelledAt ?? null,
      cancellationReason: binding.cancellationReason ?? null
    });
  }

  async cancel({ callbackId, expectedResultSha256 = null, reason = 'operator_cancelled' } = {}) {
    const initial = this.#readBinding(callbackId);
    return this.#withLock(initial.paths, async () => {
      const { paths, binding } = this.#readBinding(callbackId);
      if (binding.state === 'cancelled') {
        return Object.freeze({ ok: true, state: 'cancelled', duplicateSuppressed: true, callbackId, resultSha256: binding.resultSha256 });
      }
      if (TERMINAL_CALLBACK_STATES.has(binding.state)) throw new CodexTaskCallbackError('callback_already_completed');
      if (['dispatching', 'turn_started'].includes(binding.state)) {
        throw new CodexTaskCallbackError('callback_cancel_unsafe', 'a callback turn may already exist; refusing cancellation');
      }
      if (!['armed', 'destination_busy'].includes(binding.state)) throw new CodexTaskCallbackError('callback_state_invalid');
      if (!CANCELLATION_REASONS.has(reason)) throw new CodexTaskCallbackError('callback_cancellation_reason_invalid');
      if (!/^[a-f0-9]{64}$/.test(String(expectedResultSha256 ?? ''))) throw new CodexTaskCallbackError('callback_result_hash_required');
      const proof = resultProof(binding);
      if (proof.sha256 !== expectedResultSha256) throw new CodexTaskCallbackError('callback_result_hash_mismatch');
      if (binding.resultSha256 && binding.resultSha256 !== proof.sha256) throw new CodexTaskCallbackError('callback_result_changed');
      const cancelled = {
        ...binding,
        state: 'cancelled',
        resultStatus: proof.status,
        resultSha256: proof.sha256,
        resultBytes: proof.bytes,
        cancellationReason: reason,
        cancelledAt: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString()
      };
      this.#writeBinding(paths, cancelled);
      try { fs.unlinkSync(paths.token); } catch { /* already consumed */ }
      return Object.freeze({ ok: true, state: 'cancelled', duplicateSuppressed: false, callbackId, resultSha256: proof.sha256 });
    });
  }

  async complete({ callbackId, expectedResultSha256 = null, timeoutMs = 12 * 60 * 60_000, waitForTerminal = true } = {}) {
    const initial = this.#readBinding(callbackId);
    return this.#withLock(initial.paths, async () => {
      const { paths, binding } = this.#readBinding(callbackId);
      if (TERMINAL_CALLBACK_STATES.has(binding.state)) return Object.freeze({
        ok: binding.state === 'completed',
        state: binding.state,
        duplicateSuppressed: true,
        callbackId,
        turnId: binding.turnId,
        terminalTurnStatus: binding.terminalTurnStatus,
        resultSha256: binding.resultSha256
      });
      if (binding.state === 'cancelled') throw new CodexTaskCallbackError('callback_cancelled');
      if (binding.state === 'dispatching') throw new CodexTaskCallbackError('callback_delivery_unknown', 'turn/start delivery is ambiguous; refusing replay');
      if (!['armed', 'destination_busy', 'turn_started'].includes(binding.state)) throw new CodexTaskCallbackError('callback_state_invalid');
      // Expiry forbids a new dispatch, not observation of an already ACKed turn.
      if (binding.state !== 'turn_started' && Date.parse(binding.expiresAt) <= this.now()) {
        const expired = { ...binding, state: 'expired', updatedAt: new Date(this.now()).toISOString() };
        this.#writeBinding(paths, expired);
        throw new CodexTaskCallbackError('callback_expired');
      }
      const tokenStat = assertOwnedRegularFile(paths.token, { privateFile: true, code: 'callback_token_unsafe' });
      if (!tokenStat) throw new CodexTaskCallbackError('callback_token_missing');
      const token = fs.readFileSync(paths.token, 'utf8').trim();
      if (crypto.createHash('sha256').update(token).digest('hex') !== binding.tokenSha256) throw new CodexTaskCallbackError('callback_token_mismatch');
      if (sha256File(binding.manifestFile) !== binding.manifestSha256) throw new CodexTaskCallbackError('callback_manifest_changed');
      if (sha256File(binding.codexExecutable) !== binding.codexExecutableSha256) throw new CodexTaskCallbackError('callback_codex_executable_changed');
      const manifest = loadAppServerManifest(binding.manifestFile);
      const binary = inspectPinnedBinary(binding.codexExecutable, manifest);
      if (binary.version !== binding.codexVersion) throw new CodexTaskCallbackError('callback_codex_version_changed');
      const sharedProtocol = binding.sharedDaemonProtocol ?? 'websocket-rpc';
      if (!['websocket-rpc', 'official-proxy'].includes(sharedProtocol)) throw new CodexTaskCallbackError('callback_shared_protocol_invalid');
      if (sharedProtocol === 'official-proxy' && (binding.controlSocket == null || binding.deliveryTransport !== 'desktop-shared-daemon-proxy')) {
        throw new CodexTaskCallbackError('callback_shared_transport_mismatch');
      }
      const daemonSpawn = binding.controlSocket == null
        ? null
        : (sharedProtocol === 'official-proxy'
          ? createCodexAppServerProxySpawn({ socketPath: binding.controlSocket })
          : createCodexAppServerDaemonSpawn({ socketPath: validateOwnerOnlyUnixSocket(binding.controlSocket) }));
      const proof = resultProof(binding);
      if (binding.resultSha256 && proof.sha256 !== binding.resultSha256) throw new CodexTaskCallbackError('callback_result_changed');
      if (['armed', 'destination_busy'].includes(binding.state)) {
        if (!/^[a-f0-9]{64}$/.test(String(expectedResultSha256 ?? ''))) throw new CodexTaskCallbackError('callback_result_hash_required');
        if (proof.sha256 !== expectedResultSha256) throw new CodexTaskCallbackError('callback_result_hash_mismatch');
      } else if (expectedResultSha256 != null && proof.sha256 !== expectedResultSha256) {
        throw new CodexTaskCallbackError('callback_result_hash_mismatch');
      }
      const clientOptions = {
        executable: binding.codexExecutable,
        cwd: binding.projectRoot,
        env: { ...process.env, AICC_CODEX_VERSION: binding.codexVersion },
        manifest,
        timeoutMs: Math.min(timeoutMs, 60_000)
      };
      if (daemonSpawn) clientOptions.spawnProcess = daemonSpawn;
      const client = this.clientFactory(clientOptions);
      try {
        await client.connect();
        const read = await client.threadRead({ threadId: binding.taskId, includeTurns: true });
        const thread = validateThreadScope(read, binding, { allowNotLoaded: true, allowActive: binding.state === 'turn_started' });
        if (binding.state === 'turn_started') {
          const turn = (thread.turns ?? []).find(item => item.id === binding.turnId);
          if (!turn) throw new CodexTaskCallbackError('callback_turn_reconcile_unknown');
          if (turn.status === 'inProgress' && !waitForTerminal) return Object.freeze({
            ok: true,
            state: 'turn_started',
            submitted: true,
            duplicateSuppressed: true,
            callbackId,
            turnId: binding.turnId,
            terminalTurnStatus: null,
            resultSha256: binding.resultSha256
          });
          if (turn.status === 'inProgress') throw new CodexTaskCallbackError('callback_turn_still_active');
          if (!TERMINAL_TURN_STATES.has(turn.status)) throw new CodexTaskCallbackError('callback_turn_reconcile_unknown');
          const state = callbackTerminalState(turn.status);
          const completedAt = new Date(this.now()).toISOString();
          const completed = { ...binding, state, terminalTurnStatus: turn.status, completedAt, updatedAt: completedAt };
          this.#writeBinding(paths, completed);
          try { fs.unlinkSync(paths.token); } catch { /* already consumed */ }
          return Object.freeze({ ok: state === 'completed', state, reconciled: true, callbackId, turnId: binding.turnId, terminalTurnStatus: turn.status, resultSha256: binding.resultSha256 });
        }
        let resumed;
        try {
          resumed = await client.threadResume({ threadId: binding.taskId });
        } catch (error) {
          if (!isDestinationWriterBusy(error)) throw error;
          const blocked = {
            ...binding,
            state: 'destination_busy',
            resultStatus: proof.status,
            resultSha256: proof.sha256,
            resultBytes: proof.bytes,
            lastDeliveryErrorCode: 'callback_destination_writer_busy',
            deliveryBlockedAt: new Date(this.now()).toISOString(),
            deliveryAttemptCount: (binding.deliveryAttemptCount ?? 0) + 1,
            updatedAt: new Date(this.now()).toISOString()
          };
          this.#writeBinding(paths, blocked);
          throw new CodexTaskCallbackError(
            'callback_destination_writer_busy',
            'Codex Desktop still owns the task writer; no callback turn was started',
            { retrySafe: true, resultSha256: proof.sha256 }
          );
        }
        validateThreadScope(resumed, binding);
        const dispatching = {
          ...binding,
          state: 'dispatching',
          resultStatus: proof.status,
          resultSha256: proof.sha256,
          resultBytes: proof.bytes,
          dispatchStartedAt: new Date(this.now()).toISOString(),
          updatedAt: new Date(this.now()).toISOString()
        };
        this.#writeBinding(paths, dispatching);
        let started;
        try {
          started = await client.turnStart({
            threadId: binding.taskId,
            cwd: binding.projectRoot,
            clientUserMessageId: binding.clientUserMessageId,
            input: [{ type: 'text', text: callbackPrompt(binding, proof) }]
          });
        } catch (error) {
          throw new CodexTaskCallbackError('callback_delivery_unknown', 'turn/start failed after dispatch began; refusing replay', { causeCode: error?.code ?? null });
        }
        const turnId = started?.turn?.id;
        if (!turnId) throw new CodexTaskCallbackError('callback_delivery_unknown', 'turn/start returned no turn id; refusing replay');
        const startedBinding = { ...dispatching, state: 'turn_started', turnId, turnStartedAt: new Date(this.now()).toISOString(), updatedAt: new Date(this.now()).toISOString() };
        this.#writeBinding(paths, startedBinding);
        if (!waitForTerminal) return Object.freeze({
          ok: true,
          state: 'turn_started',
          submitted: true,
          duplicateSuppressed: false,
          callbackId,
          turnId,
          terminalTurnStatus: null,
          resultSha256: proof.sha256
        });
        let terminal;
        try {
          terminal = await client.waitFor('turn/completed', params => params?.turn?.id === turnId
            && (params.threadId == null || params.threadId === binding.taskId), timeoutMs);
        } catch (error) {
          throw new CodexTaskCallbackError('callback_turn_wait_timeout', 'callback turn started and remains reconcilable', { turnId, causeCode: error?.code ?? null });
        }
        const terminalStatus = terminal?.turn?.status;
        const state = callbackTerminalState(terminalStatus);
        const completedAt = new Date(this.now()).toISOString();
        const completed = { ...startedBinding, state, terminalTurnStatus: terminalStatus, completedAt, updatedAt: completedAt };
        this.#writeBinding(paths, completed);
        try { fs.unlinkSync(paths.token); } catch { /* already consumed */ }
        return Object.freeze({ ok: state === 'completed', state, duplicateSuppressed: false, callbackId, turnId, terminalTurnStatus: terminalStatus, resultSha256: proof.sha256 });
      } finally {
        client.close();
      }
    });
  }
}

export function defaultDesktopCodexExecutable() {
  if (process.platform === 'darwin') return '/Applications/ChatGPT.app/Contents/Resources/codex';
  return 'codex';
}
