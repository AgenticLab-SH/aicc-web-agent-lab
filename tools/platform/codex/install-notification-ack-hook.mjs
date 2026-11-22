#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const defaultHookFile = path.join(sourceRoot, 'tools', 'platform', 'codex', 'notification-ack-hook.mjs');
const stateFileName = 'notification-ack-hook-install.json';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function windowsCommandQuote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function assertSafeOwnerFile(file, options = {}) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT' && options.allowMissing) return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${options.label ?? 'file'}_unsafe_path`);
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0) throw new Error(`${options.label ?? 'file'}_unsafe_permissions`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`${options.label ?? 'file'}_unsafe_owner`);
    }
  }
  return stat;
}

function assertRegularSource(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('hook_source_unsafe_path');
}

function atomicWrite(file, bytes, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', mode);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, mode);
}

function withInstallLock(options, work) {
  const root = notificationStateRoot(options);
  const lockRoot = path.join(root, 'locks');
  const lock = path.join(lockRoot, 'notification-ack-hook.lock');
  fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('notification_ack_hook_install_busy');
    throw error;
  }
  try {
    return work();
  } finally {
    fs.rmdirSync(lock);
  }
}

export function notificationStateRoot(options = {}) {
  return options.stateRoot
    ?? process.env.AICC_STATE_ROOT?.trim()
    ?? path.join(options.home ?? os.homedir(), '.ai-control-center');
}

export function defaultHooksPath(options = {}) {
  return options.hooksPath ?? path.join(options.codexHome ?? path.join(options.home ?? os.homedir(), '.codex'), 'hooks.json');
}

function notificationAckHookPosixCommand(options = {}) {
  const nodeBinary = options.nodeBinary ?? process.execPath;
  const hookFile = options.hookFile ?? defaultHookFile;
  return `${shellQuote(nodeBinary)} ${shellQuote(hookFile)}`;
}

export function notificationAckHookWindowsCommand(options = {}) {
  const nodeBinary = options.nodeBinary ?? process.execPath;
  const hookFile = options.hookFile ?? defaultHookFile;
  // Codex derives its Windows hook shell from the task's PowerShell shell.
  // A quoted executable without the call operator is only a string expression.
  const literal = value => `'${String(value).replaceAll("'", "''")}'`;
  return `& ${literal(nodeBinary)} ${literal(hookFile)}`;
}

export function notificationAckHookCommand(options = {}) {
  return (options.platform ?? process.platform) === 'win32'
    ? notificationAckHookWindowsCommand(options)
    : notificationAckHookPosixCommand(options);
}

export function managedHookEntry(options = {}) {
  return Object.freeze({
    hooks: Object.freeze([Object.freeze({
      type: 'command',
      command: notificationAckHookCommand(options),
      commandWindows: notificationAckHookWindowsCommand(options),
      timeout: 5
    })])
  });
}

function readHooksDocument(file) {
  const stat = assertSafeOwnerFile(file, { allowMissing: true, label: 'hooks_config' });
  if (!stat) return { existed: false, mode: 0o600, bytes: Buffer.alloc(0), document: {} };
  const bytes = fs.readFileSync(file);
  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('hooks_config_invalid_json');
  }
  if (!isPlainObject(document)) throw new Error('hooks_config_invalid_shape');
  if (document.hooks != null && !isPlainObject(document.hooks)) throw new Error('hooks_config_invalid_shape');
  if (document.hooks?.UserPromptSubmit != null && !Array.isArray(document.hooks.UserPromptSubmit)) {
    throw new Error('hooks_config_invalid_shape');
  }
  return { existed: true, mode: stat.mode & 0o777, bytes, document };
}

function entryContainsCommand(entry, command, commandWindows) {
  return isPlainObject(entry)
    && Array.isArray(entry.hooks)
    && entry.hooks.some(hook => isPlainObject(hook)
      && hook.type === 'command'
      && hook.command === command
      && hook.commandWindows === commandWindows);
}

function upgradeManagedCommand(entry, command, commandWindows, legacyCommands = []) {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return { changed: false, entry, found: false };
  let changed = false;
  let found = false;
  const hooks = entry.hooks.map(hook => {
    if (!isPlainObject(hook) || hook.type !== 'command') return hook;
    const managed = hook.command === command || legacyCommands.includes(hook.command);
    if (!managed) return hook;
    found = true;
    if (hook.command === command && hook.commandWindows === commandWindows) return hook;
    changed = true;
    return { ...hook, command, commandWindows };
  });
  return { changed, found, entry: changed ? { ...entry, hooks } : entry };
}

function mergedDocument(document, options = {}) {
  const command = notificationAckHookCommand(options);
  const commandWindows = notificationAckHookWindowsCommand(options);
  const legacyCommands = (options.platform ?? process.platform) === 'win32'
    ? [notificationAckHookPosixCommand(options), `${windowsCommandQuote(options.nodeBinary ?? process.execPath)} ${windowsCommandQuote(options.hookFile ?? defaultHookFile)}`]
    : [];
  let upgraded = false;
  let managedFound = false;
  const userPromptSubmit = (document.hooks?.UserPromptSubmit ?? []).map(entry => {
    const result = upgradeManagedCommand(entry, command, commandWindows, legacyCommands);
    upgraded ||= result.changed;
    managedFound ||= result.found;
    return result.entry;
  });
  const alreadyPresent = managedFound
    && userPromptSubmit.some(entry => entryContainsCommand(entry, command, commandWindows));
  if (!alreadyPresent) userPromptSubmit.push(managedHookEntry(options));
  return {
    changed: upgraded || !alreadyPresent,
    document: {
      ...document,
      hooks: {
        ...(document.hooks ?? {}),
        UserPromptSubmit: userPromptSubmit
      }
    }
  };
}

export function planNotificationAckHook(options = {}) {
  const file = defaultHooksPath(options);
  const hookFile = options.hookFile ?? defaultHookFile;
  assertRegularSource(hookFile);
  const current = readHooksDocument(file);
  const merged = mergedDocument(current.document, options);
  const nextBytes = Buffer.from(`${JSON.stringify(merged.document, null, 2)}\n`, 'utf8');
  return Object.freeze({
    ok: true,
    action: merged.changed ? 'apply' : 'none',
    changed: merged.changed,
    target: file,
    existed: current.existed,
    beforeHash: sha256(current.bytes),
    afterHash: sha256(nextBytes),
    hookCommand: notificationAckHookCommand(options),
    nextBytes,
    beforeBytes: current.bytes,
    beforeMode: current.mode
  });
}

export function applyNotificationAckHook(options = {}) {
  return withInstallLock(options, () => {
    const plan = planNotificationAckHook(options);
    if (!plan.changed) return Object.freeze({ ok: true, state: 'unchanged', target: plan.target, afterHash: plan.afterHash });
    const stateRoot = notificationStateRoot(options);
    const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
    const backupRoot = path.join(stateRoot, 'backups', 'notification-ack-hook', stamp);
    fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    const backup = path.join(backupRoot, 'hooks.json.before');
    if (plan.existed) atomicWrite(backup, plan.beforeBytes, 0o600);
    try {
      const prewrite = readHooksDocument(plan.target);
      if (sha256(prewrite.bytes) !== plan.beforeHash) throw new Error('hooks_config_precondition_failed');
      atomicWrite(plan.target, plan.nextBytes, 0o600);
      const installed = fs.readFileSync(plan.target);
      if (sha256(installed) !== plan.afterHash) throw new Error('hooks_config_postcondition_failed');
      const state = {
        schemaVersion: 1,
        target: plan.target,
        existed: plan.existed,
        beforeMode: plan.beforeMode,
        beforeHash: plan.beforeHash,
        appliedHash: plan.afterHash,
        backup: plan.existed ? backup : null,
        appliedAt: (options.now?.() ?? new Date()).toISOString()
      };
      const stateFile = path.join(stateRoot, 'notifications', stateFileName);
      atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`, 0o600);
      return Object.freeze({ ok: true, state: 'applied', target: plan.target, afterHash: plan.afterHash, backupRoot });
    } catch (error) {
      if (plan.existed) atomicWrite(plan.target, plan.beforeBytes, plan.beforeMode);
      else fs.rmSync(plan.target, { force: true });
      throw error;
    }
  });
}

export function rollbackNotificationAckHook(options = {}) {
  return withInstallLock(options, () => {
    const stateRoot = notificationStateRoot(options);
    const stateFile = path.join(stateRoot, 'notifications', stateFileName);
    assertSafeOwnerFile(stateFile, { label: 'install_state' });
    let state;
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      throw new Error('install_state_invalid_json');
    }
    if (!isPlainObject(state) || state.schemaVersion !== 1 || typeof state.target !== 'string') {
      throw new Error('install_state_invalid_shape');
    }
    const target = defaultHooksPath(options);
    if (path.resolve(state.target) !== path.resolve(target)) throw new Error('rollback_target_mismatch');
    assertSafeOwnerFile(target, { label: 'hooks_config' });
    const current = fs.readFileSync(target);
    if (sha256(current) !== state.appliedHash) throw new Error('rollback_precondition_failed');
    if (state.existed) {
      assertSafeOwnerFile(state.backup, { label: 'hooks_backup' });
      const before = fs.readFileSync(state.backup);
      if (sha256(before) !== state.beforeHash) throw new Error('rollback_backup_mismatch');
      atomicWrite(target, before, state.beforeMode);
    } else {
      fs.rmSync(target);
    }
    return Object.freeze({ ok: true, state: 'rolled_back', target, restoredHash: state.beforeHash });
  });
}

function publicPlan(plan) {
  const { nextBytes, beforeBytes, ...safe } = plan;
  return safe;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] ?? 'plan';
    const result = command === 'apply'
      ? applyNotificationAckHook()
      : command === 'rollback'
        ? rollbackNotificationAckHook()
        : publicPlan(planNotificationAckHook());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}
