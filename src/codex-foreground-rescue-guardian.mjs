import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient, loadAppServerManifest } from './adapters/codex-app-server.mjs';
import { createCodexAppServerDaemonSpawn, validateOwnerOnlyUnixSocket } from './adapters/codex-app-server-daemon.mjs';
import { CodexTaskCallbackService } from './codex-task-callback.mjs';
import { inspectNativeCallbackSafety } from './codex-callback-safety.mjs';
import { nativeRescuePaths, nativeRescueStatus } from './native-rescue.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/;
const TERMINAL_STATUSES = new Set(['PASS', 'HOLD', 'FAIL']);
const DEFAULT_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_POLL_MS = 500;
const DEFAULT_CALLBACK_RETRY_MS = 1_000;
const DEFAULT_CALLBACK_DELIVERY_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_TASK_IDLE_GRACE_MS = 15_000;
const DEFAULT_WEB_GPT_MODEL = 'chatgpt-web/temporary/high';
const SAFE_CALLBACK_RETRY_CODES = new Set([
  'callback_writer_busy',
  'callback_thread_active',
  'callback_destination_writer_busy',
  'callback_turn_still_active',
  'callback_turn_wait_timeout'
]);

export class CodexForegroundRescueError extends Error {
  constructor(code, message = code, data = null) {
    super(message);
    this.name = 'CodexForegroundRescueError';
    this.code = code;
    this.data = data;
  }
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CodexForegroundRescueError('guardian_directory_unsafe');
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0) throw new CodexForegroundRescueError('guardian_directory_permissions_unsafe');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new CodexForegroundRescueError('guardian_directory_owner_unsafe');
  }
  return directory;
}

function atomicPrivateFile(file, data, mode = 0o600) {
  privateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', mode);
  try {
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, mode);
}

function atomicPrivateJson(file, value) {
  atomicPrivateFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256Data(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sha256File(file) {
  return sha256Data(fs.readFileSync(file));
}

function pinnedCallbackSafety(plan, options = {}) {
  const home = path.dirname(path.dirname(plan.backups.config.path));
  const rescue = (options.nativeRescueInspector ?? nativeRescueStatus)({ home });
  const rescueUnchanged = fs.existsSync(plan.nativeRescueExecutable)
    && sha256File(plan.nativeRescueExecutable) === plan.nativeCallback.rescueExecutableSha256;
  const callbackUnchanged = fs.existsSync(plan.callbackCodexExecutable)
    && sha256File(plan.callbackCodexExecutable) === plan.nativeCallback.callbackExecutableSha256;
  const ok = rescue?.ok === true && rescueUnchanged && callbackUnchanged;
  return {
    ok,
    state: ok ? 'PINNED_NATIVE_CALLBACK_SAFE' : 'PINNED_NATIVE_CALLBACK_NOT_PROVEN',
    compactRoute: rescue?.routeLock?.endpoint ?? 'official-direct',
    nativeRescue: { ready: rescue?.ok === true },
    rescueExecutableUnchanged: rescueUnchanged,
    callbackExecutableUnchanged: callbackUnchanged
  };
}

function encodeXmlText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function snapshot(file, backupFile) {
  if (!fs.existsSync(file)) return { path: file, exists: false, sha256: null, mode: null, backupFile: null };
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CodexForegroundRescueError('guardian_backup_source_unsafe', file);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new CodexForegroundRescueError('guardian_backup_source_owner_unsafe', file);
  const data = fs.readFileSync(file);
  atomicPrivateFile(backupFile, data);
  return { path: file, exists: true, sha256: sha256Data(data), mode: stat.mode & 0o777, backupFile };
}

function currentIdentity(file) {
  if (!fs.existsSync(file)) return { exists: false, sha256: null };
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CodexForegroundRescueError('guardian_restore_target_unsafe', file);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new CodexForegroundRescueError('guardian_restore_target_owner_unsafe', file);
  return { exists: true, sha256: sha256File(file) };
}

function identityKey(identity) {
  return identity.exists ? `sha256:${identity.sha256}` : 'absent';
}

export function restoreGuardedSnapshot(backup, allowedCurrentIdentities = []) {
  const current = currentIdentity(backup.path);
  const allowed = new Set([
    identityKey({ exists: backup.exists, sha256: backup.sha256 }),
    ...allowedCurrentIdentities.map(value => String(value))
  ]);
  if (!allowed.has(identityKey(current))) {
    return { ok: false, state: 'UNKNOWN_DRIFT', path: backup.path, current: identityKey(current), restored: false };
  }
  if (identityKey(current) === identityKey(backup)) {
    return { ok: true, state: 'UNCHANGED', path: backup.path, current: identityKey(current), restored: false };
  }
  if (!backup.exists) {
    fs.rmSync(backup.path, { force: true });
  } else {
    const data = fs.readFileSync(backup.backupFile);
    if (sha256Data(data) !== backup.sha256) throw new CodexForegroundRescueError('guardian_backup_changed', backup.path);
    atomicPrivateFile(backup.path, data, backup.mode ?? 0o600);
  }
  const after = currentIdentity(backup.path);
  if (identityKey(after) !== identityKey(backup)) throw new CodexForegroundRescueError('guardian_restore_postcondition_failed', backup.path);
  return { ok: true, state: 'RESTORED', path: backup.path, current: identityKey(after), restored: true };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function terminalOperationResult(file, operationId) {
  if (!fs.existsSync(file)) return null;
  const document = readJson(file);
  if (!document || document.operation !== operationId || !TERMINAL_STATUSES.has(document.status)) return null;
  return { status: document.status, sha256: sha256File(file), document };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 15_000, ...options });
  return {
    status: Number.isInteger(result.status) ? result.status : null,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
    error: result.error ?? null
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function requireAbsolute(file, code) {
  if (!path.isAbsolute(file) || /\p{Cc}/u.test(file)) throw new CodexForegroundRescueError(code);
  return path.resolve(file);
}

function requireId(value, code) {
  const normalized = String(value ?? '').trim();
  if (!SAFE_ID.test(normalized)) throw new CodexForegroundRescueError(code);
  return normalized;
}

function planPaths(stateRoot, now) {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  const runDir = path.join(stateRoot, 'runtime', 'codex-foreground-rescue', stamp);
  return {
    runDir,
    planFile: path.join(runDir, 'plan.json'),
    commandFile: path.join(runDir, 'run-in-terminal.command'),
    resultFile: path.join(runDir, 'result.json'),
    deliveryFile: path.join(runDir, 'delivery.json'),
    webGptFile: path.join(runDir, 'web-gpt-advice.json'),
    mirrorMarkdown: path.join(runDir, 'TERMINAL-RESCUE.md')
  };
}

export function armForegroundCodexRescueGuardian(options = {}) {
  if ((options.platform ?? process.platform) !== 'darwin') throw new CodexForegroundRescueError('guardian_requires_macos');
  const home = options.home ?? os.homedir();
  const stateRoot = requireAbsolute(options.stateRoot ?? path.join(home, '.ai-control-center'), 'guardian_state_root_invalid');
  const projectRoot = fs.realpathSync(requireAbsolute(options.projectRoot, 'guardian_project_root_invalid'));
  const operationId = requireId(options.operationId, 'guardian_operation_id_invalid');
  const taskId = requireId(options.taskId, 'guardian_task_id_invalid');
  const expectedDesktopPid = Number(options.expectedDesktopPid);
  if (!Number.isInteger(expectedDesktopPid) || expectedDesktopPid <= 1) throw new CodexForegroundRescueError('guardian_desktop_pid_invalid');
  const operationResultFile = requireAbsolute(options.operationResultFile, 'guardian_operation_result_invalid');
  if (fs.existsSync(operationResultFile)) throw new CodexForegroundRescueError('guardian_operation_result_preexists');
  const now = options.now ?? new Date();
  const ttlMs = Number(options.ttlMs ?? DEFAULT_TTL_MS);
  if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60_000) throw new CodexForegroundRescueError('guardian_ttl_invalid');
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const nativeSafety = (options.inspectNativeSafety ?? inspectNativeCallbackSafety)({ home });
  if (nativeSafety?.nativeRescue?.ready !== true) {
    throw new CodexForegroundRescueError('guardian_native_route_not_safe', 'Independent Native rescue executable must be ready', nativeSafety);
  }
  const nativeSafetyAtArm = nativeSafety?.ok
    ? nativeSafety.state
    : 'PINNED_NATIVE_RESCUE_READY_ON_MANAGED_ROUTE';
  const nativeRescueExecutable = requireAbsolute(
    options.nativeRescueExecutable ?? nativeRescuePaths({ home }).destination,
    'guardian_native_rescue_invalid'
  );
  const callbackCodexExecutable = requireAbsolute(
    options.callbackCodexExecutable ?? nativeRescueExecutable,
    'guardian_callback_codex_invalid'
  );
  const controlSocket = options.controlSocket == null
    ? null
    : requireAbsolute(options.controlSocket, 'guardian_control_socket_invalid');
  const manifestFile = requireAbsolute(options.manifestFile, 'guardian_manifest_invalid');
  const workerFile = requireAbsolute(
    options.workerFile ?? fileURLToPath(new URL('../tools/platform/codex/run-foreground-rescue-guardian.mjs', import.meta.url)),
    'guardian_worker_invalid'
  );
  const nodeExecutable = requireAbsolute(options.nodeExecutable ?? process.execPath, 'guardian_node_invalid');
  for (const file of [nativeRescueExecutable, callbackCodexExecutable, manifestFile, workerFile, nodeExecutable]) {
    if (!fs.existsSync(file)) throw new CodexForegroundRescueError('guardian_required_file_missing', file);
  }
  const paths = planPaths(stateRoot, now);
  privateDirectory(paths.runDir);
  const backupDir = privateDirectory(path.join(paths.runDir, 'backup'));
  const configFile = requireAbsolute(options.configFile ?? path.join(home, '.codex', 'config.toml'), 'guardian_config_invalid');
  const integrationJournalFile = requireAbsolute(
    options.integrationJournalFile ?? path.join(home, '.codex-chatgpt-web', 'runtime', 'codex-integration.json'),
    'guardian_journal_invalid'
  );
  const backups = {
    config: snapshot(configFile, path.join(backupDir, 'config.toml')),
    integrationJournal: snapshot(integrationJournalFile, path.join(backupDir, 'codex-integration.json'))
  };
  const guardianOperationId = requireId(`rescue-${operationId}`, 'guardian_callback_operation_invalid');
  const callbackService = options.callbackService ?? new CodexTaskCallbackService({ stateRoot });
  const callback = callbackService.arm({
    projectKey: options.projectKey ?? 'ai-platform',
    taskId,
    projectRoot,
    operationId: guardianOperationId,
    resultFile: paths.resultFile,
    manifestFile,
    codexExecutable: callbackCodexExecutable,
    controlSocket,
    terminalStatuses: ['PASS', 'HOLD'],
    expiresAt
  });
  const plan = {
    schemaVersion: 1,
    owner: 'AICC',
    mode: 'foreground-terminal-one-shot',
    operationId,
    guardianOperationId,
    taskId,
    projectRoot,
    expectedDesktopPid,
    expectedWorkerPid: Number.isInteger(Number(options.expectedWorkerPid)) ? Number(options.expectedWorkerPid) : null,
    operationResultFile,
    resultFile: paths.resultFile,
    deliveryFile: paths.deliveryFile,
    webGptFile: paths.webGptFile,
    mirrorMarkdown: paths.mirrorMarkdown,
    workspaceMirrorDirectory: requireAbsolute(
      options.workspaceMirrorDirectory ?? path.join(projectRoot, '.aicc-recovery'),
      'guardian_workspace_mirror_invalid'
    ),
    callbackId: callback.callbackId,
    backups,
    allowedCurrentIdentities: {
      config: [...new Set((options.allowedConfigIdentities ?? []).map(String))],
      integrationJournal: [...new Set((options.allowedIntegrationJournalIdentities ?? []).map(String))]
    },
    nativeRescueExecutable,
    callbackCodexExecutable,
    nativeCallback: {
      rescueExecutableSha256: sha256File(nativeRescueExecutable),
      callbackExecutableSha256: sha256File(callbackCodexExecutable),
      routeStateAtArm: nativeSafetyAtArm
    },
    controlSocket,
    manifestFile,
    workerFile,
    workerSha256: sha256File(workerFile),
    nodeExecutable,
    pollMs: Number(options.pollMs ?? DEFAULT_POLL_MS),
    callbackRetryMs: Number(options.callbackRetryMs ?? DEFAULT_CALLBACK_RETRY_MS),
    callbackDeliveryTimeoutMs: Number(options.callbackDeliveryTimeoutMs ?? DEFAULT_CALLBACK_DELIVERY_TIMEOUT_MS),
    taskIdleGraceMs: Number(options.taskIdleGraceMs ?? DEFAULT_TASK_IDLE_GRACE_MS),
    detectTaskIdleWithoutResult: options.detectTaskIdleWithoutResult !== false && controlSocket != null,
    desktopDisappearGraceMs: Number(options.desktopDisappearGraceMs ?? 10_000),
    reopenDesktop: options.reopenDesktop !== false,
    webGpt: {
      enabled: options.webGptEnabled !== false,
      endpoint: options.webGptEndpoint ?? 'http://127.0.0.1:17841',
      model: options.webGptModel ?? DEFAULT_WEB_GPT_MODEL,
      externalConversationUrl: options.externalConversationUrl ?? null
    },
    createdAt: now.toISOString(),
    expiresAt
  };
  atomicPrivateJson(paths.planFile, plan);
  const terminalTitle = `AICC ${operationId}`;
  const closeTerminalScript = path.join(paths.runDir, 'close-terminal-window.applescript');
  atomicPrivateFile(closeTerminalScript, [
    'on run argv',
    '  set targetTitle to item 1 of argv',
    '  set targetTty to item 2 of argv',
    '  tell application "Terminal"',
    '    repeat with targetWindow in windows',
    '      repeat with targetTab in tabs of targetWindow',
    '        if tty of targetTab is targetTty then',
    '          if busy of targetTab is false then',
    '            close targetWindow',
    '            return "closed"',
    '          end if',
    '        end if',
    '      end repeat',
    '    end repeat',
    '  end tell',
    '  return "waiting"',
    'end run',
    ''
  ].join('\n'), 0o700);
  const command = [
    '#!/bin/zsh',
    'set -u',
    `print -n $'\\e]0;${terminalTitle}\\e\\\\'`,
    'terminal_tty="$(tty)"',
    'worker_status=0',
    `${shellQuote(nodeExecutable)} ${shellQuote(workerFile)} --plan ${shellQuote(paths.planFile)} || worker_status=$?`,
    '(',
    '  for attempt in {1..10}; do',
    '    sleep 1',
    `    outcome=$(/usr/bin/osascript ${shellQuote(closeTerminalScript)} ${shellQuote(terminalTitle)} "$terminal_tty" 2>/dev/null || true)`,
    '    [[ "$outcome" == "closed" ]] && exit 0',
    '  done',
    ') >/dev/null 2>&1 &!',
    'exit "$worker_status"',
    ''
  ].join('\n');
  atomicPrivateFile(paths.commandFile, command, 0o700);
  const launched = options.launch === false
    ? { status: 0, stdout: 'not-launched', stderr: '' }
    : (options.runCommand ?? run)('/usr/bin/open', ['-a', 'Terminal', paths.commandFile]);
  if (launched.status !== 0) throw new CodexForegroundRescueError('guardian_terminal_launch_failed', launched.stderr || 'Terminal launch failed');
  return {
    ok: true,
    mode: plan.mode,
    operationId,
    guardianOperationId,
    taskId,
    runDir: paths.runDir,
    planFile: paths.planFile,
    commandFile: paths.commandFile,
    closeTerminalScript,
    callbackId: callback.callbackId,
    expiresAt: plan.expiresAt,
    launched: options.launch !== false,
    scheduledTask: false,
    nativeSafety: nativeSafetyAtArm
  };
}

async function fetchJson(url, options = {}, fetchImpl = fetch, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function exactWebGptIdle(health) {
  return health?.status === 'ok'
    && health?.accepting_turns === true
    && health?.accepting_browser_turns === true
    && health?.active_http_turns === 0
    && health?.active_browser_http_turns === 0
    && health?.active_browser_turns === 0;
}

export async function requestWebGptRescueAdvice(plan, incident, options = {}) {
  if (!plan.webGpt?.enabled) return { attempted: false, state: 'DISABLED' };
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const healthUrl = `${plan.webGpt.endpoint}/healthz`;
  const samples = [];
  for (let index = 0; index < 2; index += 1) {
    const sample = await fetchJson(healthUrl, {}, fetchImpl, 3_000).catch(error => ({ ok: false, status: null, body: null, error: error.message }));
    samples.push(sample);
    if (!sample.ok || !exactWebGptIdle(sample.body)) return { attempted: false, state: 'NOT_EXACT_IDLE', samples };
    if (index === 0) await sleep(500);
  }
  const mirrorFile = path.join(plan.workspaceMirrorDirectory, 'TERMINAL-RESCUE.md');
  let mirror = 'UNAVAILABLE';
  try {
    const stat = fs.lstatSync(mirrorFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_192) throw new Error('mirror_unsafe');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('mirror_owner_unsafe');
    mirror = fs.readFileSync(mirrorFile, 'utf8');
  } catch {}
  const prompt = [
    'AICC foreground rescue advisor request. Do not modify local files or create a Codex task.',
    `Project root: ${plan.projectRoot}`,
    `Workspace recovery mirror: ${path.join(plan.workspaceMirrorDirectory, 'TERMINAL-RESCUE.md')}`,
    `Exact task: ${plan.taskId}`,
    `Exact operation: ${plan.operationId}`,
    `Incident: ${incident.trigger}`,
    'The following sanitized owner-generated mirror contains no credentials or raw session data:',
    mirror,
    'Return a concise diagnosis plus the smallest safe next action using only these supplied facts.',
    'Never request secrets, never stop other work, and do not claim a local mutation occurred.'
  ].join('\n');
  const threadId = `aicc-rescue-${crypto.randomUUID()}`;
  const turnId = `aicc-rescue-turn-${crypto.randomUUID()}`;
  const projectRootXml = encodeXmlText(plan.projectRoot);
  const environment = [
    '<environment_context>',
    `  <cwd>${projectRootXml}</cwd>`,
    '  <sandbox_mode>read-only</sandbox_mode>',
    `  <filesystem><workspace_roots><root>${projectRootXml}</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry></file_system></permission_profile></filesystem>`,
    '</environment_context>'
  ].join('\n');
  const turnMetadata = {
    thread_id: threadId,
    turn_id: turnId,
    sandbox: 'read-only',
    workspaces: { [plan.projectRoot]: { has_changes: false } }
  };
  const response = await fetchJson(`${plan.webGpt.endpoint}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: plan.webGpt.model,
      stream: false,
      prompt_cache_key: threadId,
      client_metadata: { 'x-codex-turn-metadata': JSON.stringify(turnMetadata) },
      input: [
        {
          id: 'msg_environment',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: environment }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId }
        },
        {
          id: 'msg_instruction',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId }
        }
      ]
    })
  }, fetchImpl, 20 * 60_000).catch(error => ({ ok: false, status: null, body: null, error: error.message }));
  const completed = response.ok && response.body?.status === 'completed';
  return { attempted: true, state: completed ? 'COMPLETED' : 'FAILED', model: plan.webGpt.model, response };
}

function writeWorkspaceMirror(plan, incident, restore, nativeSafety, webGpt = null) {
  privateDirectory(plan.workspaceMirrorDirectory);
  const markdown = [
    '# AICC terminal rescue',
    '',
    `- task: ${plan.taskId}`,
    `- operation: ${plan.operationId}`,
    `- trigger: ${incident.trigger}`,
    `- watched result: ${incident.operationResult?.status ?? 'MISSING'}`,
    `- Native callback route: ${nativeSafety?.state ?? 'UNKNOWN'}`,
    `- config recovery: ${restore.config.state}`,
    `- integration journal recovery: ${restore.integrationJournal.state}`,
    `- Web GPT advisor: ${webGpt?.state ?? 'NOT_ATTEMPTED'}`,
    '',
    'This owner-only file is the external ChatGPT/AICC Workspace recovery handoff. It contains no credentials or raw session data.',
    ''
  ].join('\n');
  atomicPrivateFile(plan.mirrorMarkdown, markdown);
  atomicPrivateFile(path.join(plan.workspaceMirrorDirectory, 'TERMINAL-RESCUE.md'), markdown);
  return { markdown, sha256: sha256Data(markdown) };
}

async function completeCallbackWhenSafe(plan, callbackService, expectedResultSha256, options = {}) {
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const expiryDeadline = Date.parse(plan.expiresAt);
  const retryMs = Number(plan.callbackRetryMs ?? DEFAULT_CALLBACK_RETRY_MS);
  if (!Number.isInteger(retryMs) || retryMs < 100 || retryMs > 60_000) {
    throw new CodexForegroundRescueError('guardian_callback_retry_invalid');
  }
  const deliveryTimeoutMs = Number(plan.callbackDeliveryTimeoutMs ?? DEFAULT_CALLBACK_DELIVERY_TIMEOUT_MS);
  if (!Number.isInteger(deliveryTimeoutMs) || deliveryTimeoutMs < 100 || deliveryTimeoutMs > 10 * 60_000) {
    throw new CodexForegroundRescueError('guardian_callback_delivery_timeout_invalid');
  }
  const deadline = Math.min(expiryDeadline, now() + deliveryTimeoutMs);
  let attempts = 0;
  let lastError = null;
  while (now() < deadline) {
    attempts += 1;
    const remainingMs = Math.max(1, deadline - now());
    try {
      const callback = await callbackService.complete({
        callbackId: plan.callbackId,
        expectedResultSha256,
        timeoutMs: Math.min(60_000, remainingMs),
        waitForTerminal: false
      });
      return { callback, attempts, lastRetryCode: lastError?.code ?? null };
    } catch (error) {
      if (!SAFE_CALLBACK_RETRY_CODES.has(error?.code)) throw error;
      lastError = error;
      const waitMs = Math.min(retryMs, Math.max(0, deadline - now()));
      if (waitMs <= 0) break;
      await sleep(waitMs);
    }
  }
  throw new CodexForegroundRescueError(
    'guardian_callback_retry_expired',
    'Exact-task callback did not become safely deliverable before guardian expiry',
    { attempts, lastErrorCode: lastError?.code ?? null }
  );
}

async function inspectExactTaskThroughSharedDaemon(plan, options = {}) {
  if (!plan.controlSocket || !plan.callbackCodexExecutable || !plan.manifestFile) {
    return { state: 'unavailable', reason: 'shared_daemon_not_configured' };
  }
  const manifest = loadAppServerManifest(plan.manifestFile);
  const clientFactory = options.taskClientFactory ?? (clientOptions => new CodexAppServerClient(clientOptions));
  const client = clientFactory({
    executable: plan.callbackCodexExecutable,
    cwd: plan.projectRoot,
    env: { ...process.env, AICC_CODEX_VERSION: manifest.codexVersion },
    manifest,
    spawnProcess: createCodexAppServerDaemonSpawn({ socketPath: validateOwnerOnlyUnixSocket(plan.controlSocket) }),
    timeoutMs: 10_000
  });
  try {
    await client.connect();
    const response = await client.threadRead({ threadId: plan.taskId, includeTurns: true });
    const thread = response?.thread;
    if (!thread || thread.id !== plan.taskId) return { state: 'unknown', reason: 'task_identity_mismatch' };
    let cwd;
    try { cwd = fs.realpathSync(thread.cwd); }
    catch { return { state: 'unknown', reason: 'task_root_unavailable' }; }
    if (cwd !== plan.projectRoot) return { state: 'scope_changed', reason: 'task_root_mismatch' };
    const inProgress = (thread.turns ?? []).filter(turn => turn?.status === 'inProgress').length;
    const status = thread.status?.type;
    if (status === 'active' || inProgress > 0) return { state: 'active', status: status ?? null, inProgress };
    if (['idle', 'notLoaded'].includes(status) && inProgress === 0) return { state: 'idle', status, inProgress: 0 };
    return { state: 'unknown', status: status ?? null, inProgress };
  } catch (error) {
    return { state: 'unknown', reason: error?.code ?? error?.message ?? 'task_probe_failed' };
  } finally {
    client.close();
  }
}

export async function runForegroundCodexRescueGuardian(planFile, options = {}) {
  const plan = readJson(requireAbsolute(planFile, 'guardian_plan_invalid'));
  if (plan?.schemaVersion !== 1 || plan.mode !== 'foreground-terminal-one-shot') throw new CodexForegroundRescueError('guardian_plan_invalid');
  if (sha256File(plan.workerFile) !== plan.workerSha256) throw new CodexForegroundRescueError('guardian_worker_changed');
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const isPidAlive = options.pidAlive ?? pidAlive;
  const now = options.now ?? Date.now;
  const deadline = Date.parse(plan.expiresAt);
  const taskIdleGraceMs = Number(plan.taskIdleGraceMs ?? DEFAULT_TASK_IDLE_GRACE_MS);
  if (!Number.isInteger(taskIdleGraceMs) || taskIdleGraceMs < 1_000 || taskIdleGraceMs > 10 * 60_000) {
    throw new CodexForegroundRescueError('guardian_task_idle_grace_invalid');
  }
  let incident = null;
  let sawTaskActive = false;
  let taskIdleSince = null;
  let lastTaskProbe = null;
  while (now() < deadline) {
    const operationResult = terminalOperationResult(plan.operationResultFile, plan.operationId);
    const desktopAlive = isPidAlive(plan.expectedDesktopPid);
    const workerAlive = plan.expectedWorkerPid == null ? true : isPidAlive(plan.expectedWorkerPid);
    if (operationResult) {
      incident = { trigger: 'operation_terminal', operationResult, desktopAlive, workerAlive };
      break;
    }
    if (!desktopAlive || !workerAlive) {
      const graceDeadline = Math.min(deadline, now() + Number(plan.desktopDisappearGraceMs));
      let lateResult = null;
      while (now() < graceDeadline && lateResult == null) {
        const waitMs = Math.min(Number(plan.pollMs), Math.max(1, graceDeadline - now()));
        await sleep(waitMs);
        lateResult = terminalOperationResult(plan.operationResultFile, plan.operationId);
      }
      incident = {
        trigger: lateResult ? 'operation_terminal_after_desktop_exit' : (!workerAlive ? 'worker_disappeared_without_terminal_result' : 'desktop_disappeared_without_terminal_result'),
        operationResult: lateResult,
        desktopAlive: isPidAlive(plan.expectedDesktopPid),
        workerAlive: plan.expectedWorkerPid == null ? true : isPidAlive(plan.expectedWorkerPid)
      };
      break;
    }
    if (plan.detectTaskIdleWithoutResult === true) {
      const inspectTask = options.inspectTaskState ?? inspectExactTaskThroughSharedDaemon;
      lastTaskProbe = await inspectTask(plan, options);
      if (lastTaskProbe.state === 'scope_changed') {
        incident = {
          trigger: 'task_scope_changed_without_terminal_result',
          operationResult: null,
          desktopAlive,
          workerAlive,
          taskProbe: lastTaskProbe
        };
        break;
      }
      if (lastTaskProbe.state === 'active') {
        sawTaskActive = true;
        taskIdleSince = null;
      } else if (lastTaskProbe.state === 'idle' && sawTaskActive) {
        taskIdleSince ??= now();
        if (now() - taskIdleSince >= taskIdleGraceMs) {
          incident = {
            trigger: 'task_idle_without_terminal_result',
            operationResult: null,
            desktopAlive,
            workerAlive,
            taskProbe: lastTaskProbe
          };
          break;
        }
      } else if (lastTaskProbe.state !== 'idle') {
        taskIdleSince = null;
      }
    }
    await sleep(plan.pollMs);
  }
  if (!incident) incident = {
    trigger: 'guardian_expired',
    operationResult: null,
    desktopAlive: isPidAlive(plan.expectedDesktopPid),
    workerAlive: false,
    taskProbe: lastTaskProbe
  };

  const restore = {
    config: restoreGuardedSnapshot(plan.backups.config, plan.allowedCurrentIdentities.config),
    integrationJournal: restoreGuardedSnapshot(plan.backups.integrationJournal, plan.allowedCurrentIdentities.integrationJournal)
  };
  const nativeSafety = options.inspectNativeSafety
    ? options.inspectNativeSafety({ home: path.dirname(path.dirname(plan.backups.config.path)) })
    : pinnedCallbackSafety(plan, options);
  let recoveryMirror = writeWorkspaceMirror(plan, incident, restore, nativeSafety);
  let webGpt = null;
  if (!incident.operationResult || !restore.config.ok || !restore.integrationJournal.ok || !nativeSafety?.ok) {
    webGpt = await (options.requestWebGptAdvice ?? requestWebGptRescueAdvice)(plan, incident, options);
    atomicPrivateJson(plan.webGptFile, webGpt);
    recoveryMirror = writeWorkspaceMirror(plan, incident, restore, nativeSafety, webGpt);
  }
  const status = incident.operationResult && restore.config.ok && restore.integrationJournal.ok && nativeSafety?.ok ? 'PASS' : 'HOLD';
  const result = {
    operation: plan.guardianOperationId,
    status,
    completedAt: new Date().toISOString(),
    mode: plan.mode,
    scheduledTask: false,
    taskId: plan.taskId,
    watchedOperation: plan.operationId,
    trigger: incident.trigger,
    watchedResult: incident.operationResult == null ? null : { status: incident.operationResult.status, sha256: incident.operationResult.sha256 },
    restore,
    nativeRoute: { state: nativeSafety?.state ?? 'UNKNOWN', compactRoute: nativeSafety?.compactRoute ?? null },
    webGpt: webGpt == null ? { attempted: false, state: 'NOT_NEEDED' } : { attempted: webGpt.attempted, state: webGpt.state },
    recoveryMirror: { file: path.join(plan.workspaceMirrorDirectory, 'TERMINAL-RESCUE.md'), sha256: recoveryMirror.sha256 }
  };
  atomicPrivateJson(plan.resultFile, result);
  const resultSha256 = sha256File(plan.resultFile);
  let delivery;
  try {
    const callbackService = options.callbackService ?? new CodexTaskCallbackService();
    const completed = await completeCallbackWhenSafe(plan, callbackService, resultSha256, { sleep, now });
    delivery = {
      status: completed.callback.ok ? 'PASS' : 'HOLD',
      callback: completed.callback,
      attempts: completed.attempts,
      lastRetryCode: completed.lastRetryCode,
      resultSha256,
      completedAt: new Date().toISOString()
    };
  } catch (error) {
    delivery = {
      status: 'HOLD',
      reason: error.code ?? error.message,
      detail: error.data ?? null,
      resultSha256,
      completedAt: new Date().toISOString()
    };
  }
  atomicPrivateJson(plan.deliveryFile, delivery);

  let reopenedDesktop = false;
  if (!isPidAlive(plan.expectedDesktopPid) && plan.reopenDesktop && nativeSafety?.ok) {
    const opened = (options.runCommand ?? run)('/usr/bin/open', ['-b', 'com.openai.codex']);
    reopenedDesktop = opened.status === 0;
  }
  return { ok: status === 'PASS' && delivery.status === 'PASS', status, resultFile: plan.resultFile, deliveryFile: plan.deliveryFile, resultSha256, delivery, reopenedDesktop };
}
