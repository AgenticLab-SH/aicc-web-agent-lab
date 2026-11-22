import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { prepareCodexCliLaunch } from '../../src/codex-cli-routes.mjs';

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value, null, 2);
const terminal = new Set(['COMPLETED', 'REJECTED_BEFORE_DISPATCH', 'OUTCOME_UNKNOWN_RECONCILE']);
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function exactPath(value, directory = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw Error('An absolute owner path is required');
  const file = path.resolve(value);
  for (let current = file;; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw Error('Linked Codex dispatch paths are refused');
    if (current === path.dirname(current)) break;
  }
  const stat = fs.statSync(file);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw Error('Unexpected Codex dispatch path type');
  return fs.realpathSync(file);
}
function pinned(file, expected) {
  const exact = exactPath(file);
  if (!SHA.test(expected || '') || hash(fs.readFileSync(exact)) !== expected) throw Error('Owner Codex dispatch pin changed');
  return exact;
}
function readJson(file) {
  const exact = exactPath(file);
  if (fs.statSync(exact).size > 1048576) throw Error('Codex dispatch record exceeds its bound');
  return JSON.parse(fs.readFileSync(exact, 'utf8').replace(/^\uFEFF/, ''));
}
function writeNew(file, value) { fs.writeFileSync(file, encode(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
function save(file, value) {
  const descriptor = fs.openSync(file, 'r+');
  try { fs.ftruncateSync(descriptor, 0); fs.writeFileSync(descriptor, encode(value)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}
function bindingFor(config, workspace, { validateRuntime = true } = {}) {
  if (process.platform !== 'win32' || config.surfaceProfile === 'personal-read-fetch' || config.codexCli?.enabled !== true) throw Error('Named Windows Codex CLI dispatch is not enabled');
  const declaration = config.codexCli.bindings
    ? config.codexCli.bindings[workspace.alias]
    : config.codexCli;
  if (!declaration) throw Error('CODEX_CLI_WORKSPACE_NOT_REGISTERED: this workspace has no owner binding; changing prompt_path cannot grant dispatch. Preserve the original operation ID and ask the owner to register this exact workspace.');
  const bindingFile = pinned(declaration.bindingFile, declaration.bindingSha256);
  const binding = readJson(bindingFile), root = exactPath(workspace.root, true);
  if (binding.schemaVersion !== 1 || binding.kind !== 'aicc-codex-cli-owner-binding'
    || binding.executionBoundary !== 'owner-registered-codex-cli-workspace-write'
    || binding.workspaceAlias !== workspace.alias || exactPath(binding.workspaceRoot, true) !== root
    || root === path.parse(root).root || root === os.homedir() || !fs.existsSync(path.join(root, '.git'))
    || !ID.test(binding.bindingId || '') || inside(root, bindingFile)) throw Error('An exact Git workspace and separate owner authority are required');
  if (!Array.isArray(binding.blockedPromptHashes) || binding.blockedPromptHashes.some(value => !SHA.test(value))) throw Error('Owner denial reconciliation list is required');
  if (!binding.models || Object.keys(binding.models).some(route => !['native', 'ocx'].includes(route))
    || !Object.keys(binding.models).length || Object.values(binding.models).some(models => !Array.isArray(models) || !models.length || models.some(model => typeof model !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(model)))) throw Error('Explicit route/model allowlists are required');
  if (!Array.isArray(binding.reasoningEfforts) || !binding.reasoningEfforts.length || binding.reasoningEfforts.some(value => !['low', 'medium', 'high', 'xhigh'].includes(value))) throw Error('Explicit reasoning effort allowlist is required');
  for (const [key, maximum] of [['timeoutMs', 3600000], ['maximumPromptBytes', 262144], ['maximumOutputBytes', 1048576]]) {
    if (!Number.isSafeInteger(binding[key]) || binding[key] < 1 || binding[key] > maximum) throw Error('Invalid Codex dispatch resource limit');
  }
  const directory = exactPath(binding.operationDirectory, true);
  if (inside(root, directory)) throw Error('Dispatch journal must be outside the writable task workspace');
  for (const key of validateRuntime ? ['codex', 'powershell', 'launcher', 'processJob'] : []) {
    pinned(binding[key], binding[key + 'Sha256']);
    if (inside(root, binding[key])) throw Error('Dispatch runtime must be outside the writable task workspace');
  }
  return { ...binding, operationDirectory: directory, workspaceRoot: root };
}
function filesFor(binding, id) {
  if (!ID.test(id || '')) throw Error('Invalid Codex operation ID');
  const prefix = path.join(binding.operationDirectory, id);
  return { record: prefix + '.json', invocation: prefix + '.invocation.json', result: prefix + '.result.md', lock: path.join(binding.operationDirectory, 'writer.lock') };
}
function promptBytes(workspace, input, maximum) {
  const relative = input.prompt_path;
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
    || relative.split(/[\\/]/).some(part => !part || part.startsWith('.') || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) throw Error('A non-hidden workspace prompt file is required');
  const file = exactPath(path.resolve(workspace.root, relative));
  if (!inside(workspace.root, file) || fs.statSync(file).size > maximum) throw Error('Prompt is outside the allowed workspace or byte limit');
  const bytes = fs.readFileSync(file);
  if (!bytes.length || !SHA.test(input.prompt_sha256 || '') || hash(bytes) !== input.prompt_sha256) throw Error('Exact prompt bytes are required');
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return bytes;
}

// This is a separate, explicitly owner-bound capability. General exec stays isolated.
export function createCodexCliExecutor(config, options = {}) {
  const sessions = new Map(), pending = new Map(), retiredLeases = new Set();
  const spawnProcess = options.spawn ?? spawn;
  const prepareLaunch = options.prepareLaunch ?? prepareCodexCliLaunch;
  const now = () => new Date().toISOString();
  function activeForLease(leaseId) { return [...pending.values()].includes(leaseId) || [...sessions.values()].some(session => session.leaseId === leaseId); }
  function assertNoWriter(workspace) {
    if (config.codexCli?.enabled !== true) return;
    // Protect overlapping aliases too, including a broader parent opened after lease expiry.
    const declarations = config.codexCli.bindings ? Object.values(config.codexCli.bindings) : [config.codexCli];
    const currentRoot = exactPath(workspace.root, true);
    for (const declaration of declarations) {
      const owner = readJson(pinned(declaration.bindingFile, declaration.bindingSha256));
      const target = config.workspaces.find(item => item.alias === owner.workspaceAlias);
      if (!target) throw Error('Codex owner binding lost its registered workspace');
      // General workspace writes consult the pinned owner journal only; an unrelated
      // retired CLI binary must not disable isolated file/command capabilities.
      const binding = bindingFor(config, target, { validateRuntime: false });
      if ((inside(binding.workspaceRoot, currentRoot) || inside(currentRoot, binding.workspaceRoot))
        && fs.existsSync(filesFor(binding, 'lock-probe').lock)) throw Error('Codex CLI owns this workspace writer or requires original-outcome reconciliation');
    }
  }
  function stopLease(leaseId) {
    for (const id of pending.values()) if (!leaseId || id === leaseId) retiredLeases.add(id);
    for (const session of sessions.values()) if (!leaseId || session.leaseId === leaseId) {
      session.stopped = true;
      try { session.child.kill('SIGTERM'); } catch { /* Already exiting. */ }
    }
  }
  function status(workspace, operationId) {
    const binding = bindingFor(config, workspace), files = filesFor(binding, operationId), record = readJson(files.record);
    if (record.bindingId !== binding.bindingId || record.workspaceAlias !== workspace.alias) throw Error('Codex operation belongs to another owner binding');
    const running = sessions.has(files.record), preparing = pending.has(files.record);
    const phase = !running && !preparing && !terminal.has(record.phase) ? 'OUTCOME_UNKNOWN_RECONCILE' : record.phase;
    let result = null;
    if (phase === 'COMPLETED') {
      const resultFile = exactPath(files.result);
      if (fs.statSync(resultFile).size > binding.maximumOutputBytes || hash(fs.readFileSync(resultFile)) !== record.resultSHA256) throw Error('Saved Codex result changed');
      result = fs.readFileSync(resultFile, 'utf8');
    }
    return { ok: phase === 'COMPLETED' || running || preparing, operation_id: operationId, status: phase, running, preparing,
      route: record.route, model: record.model, reasoning_effort: record.reasoningEffort,
      configured_provider: record.provider ?? null, observed_provider: null,
      session_id: record.threadId ?? null, task_started: record.turnStarted === true, turn_completed: record.turnCompleted === true,
      exit_code: record.exitCode ?? null, result, result_sha256: record.resultSHA256 ?? null,
      reason: record.reason ?? null, automaticRetry: false, fallback: false };
  }
  async function start(workspace, input, lease) {
    const binding = bindingFor(config, workspace), files = filesFor(binding, input.operation_id);
    if (!binding.models[input.route]?.includes(input.model) || !binding.reasoningEfforts.includes(input.reasoning_effort)) throw Error('Route, model or reasoning effort is outside the owner binding');
    const bytes = promptBytes(workspace, input, binding.maximumPromptBytes);
    if (binding.blockedPromptHashes.includes(input.prompt_sha256)) throw Error('Previously denied prompt remains blocked; do not re-dispatch');
    const fingerprint = hash(encode({ bindingId: binding.bindingId, alias: workspace.alias, route: input.route, model: input.model, effort: input.reasoning_effort, promptSHA256: input.prompt_sha256 }));
    if (fs.existsSync(files.record)) {
      if (readJson(files.record).fingerprint !== fingerprint) throw Error('Codex operation ID was already used with different input');
      return status(workspace, input.operation_id);
    }
    // A durable, per-binding writer lock survives transport/process loss. Never auto-clear it.
    const lock = fs.openSync(files.lock, 'wx', 0o600);
    const record = { schemaVersion: 1, bindingId: binding.bindingId, workspaceAlias: workspace.alias, operationId: input.operation_id,
      fingerprint, promptSHA256: input.prompt_sha256, route: input.route, model: input.model, reasoningEffort: input.reasoning_effort,
      leaseId: lease.leaseId, expiresAt: lease.expiresAt, createdAt: now(), phase: 'PREPARING', turnStarted: false, turnCompleted: false };
    let child, dispatched = false;
    try {
      fs.writeFileSync(lock, encode({ operationId: input.operation_id, fingerprint })); fs.fsyncSync(lock); fs.closeSync(lock);
      writeNew(files.record, record); pending.set(files.record, lease.leaseId);
      const prepared = await prepareLaunch(input.route, [
        '-a', 'never', 'exec', '--json', '--ephemeral', '--sandbox', 'workspace-write', '-C', binding.workspaceRoot, '-o', files.result, '-'
      ], { model: input.model, reasoningEffort: input.reasoning_effort, executable: binding.codex });
      if (retiredLeases.has(lease.leaseId) || Date.parse(lease.expiresAt) <= Date.now()) throw Error('Writer lease ended before dispatch');
      const invocation = { schemaVersion: 1, executable: binding.codex, args: prepared.invocation.args, cwd: binding.workspaceRoot,
        processJob: binding.processJob, processJobSha256: binding.processJobSha256 };
      const invocationBytes = encode(invocation);
      fs.writeFileSync(files.invocation, invocationBytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      record.provider = prepared.invocation.provider; record.phase = 'DISPATCHING'; save(files.record, record);
      dispatched = true;
      child = spawnProcess(binding.powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', binding.launcher,
        '-InvocationFile', files.invocation, '-InvocationSha256', hash(invocationBytes)], {
        cwd: binding.operationDirectory, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...prepared.environment, NODE_OPTIONS: '', NODE_PATH: '', NO_COLOR: '1' }
      });
    } catch (error) {
      pending.delete(files.record);
      record.phase = dispatched ? 'OUTCOME_UNKNOWN_RECONCILE' : 'REJECTED_BEFORE_DISPATCH';
      record.reason = dispatched ? 'PROCESS_START_UNKNOWN' : 'PREFLIGHT_REJECTED';
      if (fs.existsSync(files.record)) save(files.record, record);
      if (!dispatched) fs.unlinkSync(files.lock);
      throw Error(dispatched ? 'Codex start outcome unknown; query the original operation ID' : 'Codex preflight rejected; no model task was dispatched');
    }
    pending.delete(files.record);
    const session = { child, leaseId: lease.leaseId, stopped: false };
    sessions.set(files.record, session);
    let outputBytes = 0, partial = '', failed = false, finished = false;
    const stop = reason => { if (!session.stopped) { record.reason = reason; session.stopped = true; child.kill('SIGTERM'); } };
    const consume = chunk => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > binding.maximumOutputBytes) { stop('OUTPUT_LIMIT'); return false; }
      return true;
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => {
      if (!consume(chunk)) return;
      partial += chunk;
      const lines = partial.split('\n'); partial = lines.pop() ?? '';
      for (const line of lines) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'thread.started' && /^[a-f0-9-]{36}$/i.test(event.thread_id || '')) record.threadId = event.thread_id;
        if (event.type === 'turn.started') { record.turnStarted = true; record.phase = 'TASK_STARTED'; }
        if (event.type === 'turn.completed') record.turnCompleted = true;
        if (event.type === 'turn.failed' || event.type === 'error') failed = true;
      }
      save(files.record, record);
    });
    child.stderr?.on('data', consume); // Do not return raw logs, prompts, tool output or credentials.
    child.stdin.on('error', () => stop('PROMPT_PIPE_ERROR'));
    const timer = setTimeout(() => stop('DEADLINE_REACHED'), Math.max(1, Math.min(binding.timeoutMs, Date.parse(lease.expiresAt) - Date.now())));
    timer.unref?.();
    const finish = (code, error = false) => {
      if (finished) return; finished = true; clearTimeout(timer); sessions.delete(files.record);
      record.finishedAt = now(); record.exitCode = code;
      record.phase = 'OUTCOME_UNKNOWN_RECONCILE';
      if (!error && !failed && !session.stopped && code === 0 && record.turnCompleted && fs.existsSync(files.result)) {
        try {
          const resultFile = exactPath(files.result), size = fs.statSync(resultFile).size;
          if (size > 0 && size <= binding.maximumOutputBytes) { record.resultSHA256 = hash(fs.readFileSync(resultFile)); record.phase = 'COMPLETED'; }
        } catch { record.reason = 'RESULT_UNAVAILABLE'; }
      }
      save(files.record, record);
      if (record.phase === 'COMPLETED') fs.unlinkSync(files.lock);
    };
    child.once('error', () => finish(null, true)); child.once('close', code => finish(code));
    child.stdin.end(bytes);
    return { ok: true, operation_id: input.operation_id, status: 'DISPATCHING', route: input.route, model: input.model,
      reasoning_effort: input.reasoning_effort, task_started: false, automaticRetry: false, fallback: false };
  }
  return { start, status, assertNoWriter, activeForLease, stopLease };
}
