import { spawnSync } from 'node:child_process';
import { FocusGuard } from '../control-plane/focus-guard.mjs';

const ACTIONS = new Set(['click','double_click','type_text','set_value','press_key','hotkey','scroll']);

export class CuaDriverAdapterError extends Error {
  constructor(code, message) { super(message); this.name = 'CuaDriverAdapterError'; this.code = code; }
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new CuaDriverAdapterError('invalid_cua_target', `${label} must be a positive integer`);
  return number;
}

function safeSession(value) {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/.test(text)) throw new CuaDriverAdapterError('invalid_cua_session', 'CUA session label is invalid');
  return text;
}

function invoke(runner, executable, tool, payload) {
  const result = runner(executable, [tool, JSON.stringify(payload)], { encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: false });
  if (result?.error) throw new CuaDriverAdapterError('cua_driver_unavailable', result.error.message);
  const stdout = String(result?.stdout ?? '').trim();
  let parsed = null;
  try { parsed = stdout ? JSON.parse(stdout) : null; } catch {
    throw new CuaDriverAdapterError('cua_driver_invalid_output', `cua-driver ${tool} returned non-JSON output`);
  }
  if (result?.status !== 0 || parsed?.isError === true || parsed?.error) {
    const code = parsed?.error?.code ?? parsed?.code ?? 'cua_driver_action_failed';
    const error = new CuaDriverAdapterError(code, parsed?.error?.message ?? parsed?.message ?? `cua-driver ${tool} failed`);
    error.result = parsed;
    throw error;
  }
  return parsed ?? {};
}

function extractSnapshotId(snapshot) {
  return snapshot?.structuredContent?.snapshot_id ?? snapshot?.snapshot_id ?? null;
}

function snapshotTokens(snapshot) {
  const elements = snapshot?.structuredContent?.elements ?? snapshot?.elements ?? [];
  return new Set(elements.map(item => item?.element_token).filter(Boolean));
}

function normalizeActionArgs(action, input, snapshot, target, session, deliveryMode) {
  if (!ACTIONS.has(action)) throw new CuaDriverAdapterError('unsupported_cua_action', `unsupported CUA action: ${action}`);
  const args = { ...(input ?? {}), pid: target.pid, window_id: target.windowId, session, delivery_mode: deliveryMode };
  const snapshotId = extractSnapshotId(snapshot);
  if (args.element_token) {
    if (!snapshotTokens(snapshot).has(args.element_token)) throw new CuaDriverAdapterError('cua_snapshot_token_mismatch', 'element token is not from the fresh target snapshot');
    delete args.element_index;
    delete args.snapshot_id;
  } else if (args.element_index !== undefined) {
    if (!snapshotId) throw new CuaDriverAdapterError('cua_snapshot_id_missing', 'fresh snapshot did not expose snapshot_id');
    args.snapshot_id = snapshotId;
  } else if (!(Number.isFinite(args.x) && Number.isFinite(args.y)) && !['press_key','hotkey','scroll'].includes(action)) {
    throw new CuaDriverAdapterError('cua_snapshot_target_required', 'action must use a token/index from the fresh snapshot or explicit snapshot pixels');
  }
  return args;
}

function isBackgroundUnavailable(error) {
  return error?.code === 'background_unavailable' || error?.result?.error?.code === 'background_unavailable';
}

const WINDOWS_IDLE_SCRIPT = String.raw`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AiccLastInput { [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; } [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii); [DllImport("kernel32.dll")] static extern ulong GetTickCount64(); public static uint IdleMs(){ var x=new LASTINPUTINFO(); x.cbSize=(uint)Marshal.SizeOf(x); if(!GetLastInputInfo(ref x)) throw new Exception("GetLastInputInfo failed"); return unchecked((uint)GetTickCount64()-x.dwTime); } }'; [Console]::Out.Write([AiccLastInput]::IdleMs())`;

export function windowsUserActivity({ runner = spawnSync, thresholdMs = 3000 } = {}) {
  if (process.platform !== 'win32') return { active: false, idleMs: null, source: 'non-windows' };
  const result = runner('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command', WINDOWS_IDLE_SCRIPT], { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false });
  if (result?.error || result?.status !== 0) throw new CuaDriverAdapterError('user_activity_unknown', 'Windows last-input state could not be observed safely');
  const idleMs = Number(String(result.stdout ?? '').trim());
  if (!Number.isFinite(idleMs) || idleMs < 0) throw new CuaDriverAdapterError('user_activity_unknown', 'Windows last-input state was invalid');
  return { active: idleMs < thresholdMs, idleMs, source: 'GetLastInputInfo' };
}

export class GuardedCuaDriver {
  constructor({ runner = spawnSync, executable = 'cua-driver', focusGuard, activityProbe = windowsUserActivity } = {}) {
    this.runner = runner;
    this.executable = executable;
    this.activityProbe = activityProbe;
    if (!focusGuard?.begin || !focusGuard?.authorize || !focusGuard?.end) throw new CuaDriverAdapterError('cua_focus_guard_required', 'Focus Guard is required for CUA mutation');
    this.focusGuard = focusGuard;
  }

  snapshot({ pid, windowId, session, includeScreenshot = false } = {}) {
    const target = { pid: positiveInteger(pid, 'pid'), windowId: positiveInteger(windowId, 'window id') };
    const label = safeSession(session);
    return invoke(this.runner, this.executable, 'get_window_state', {
      pid: target.pid, window_id: target.windowId, session: label, include_screenshot: includeScreenshot
    });
  }

  verify({ pid, windowId, session, expect, includeScreenshot = false } = {}) {
    const target = { pid: positiveInteger(pid, 'pid'), windowId: positiveInteger(windowId, 'window id') };
    const label = safeSession(session);
    if (!Array.isArray(expect) || expect.length < 1 || expect.length > 8) throw new CuaDriverAdapterError('cua_verify_expect_required', 'one to eight verification predicates are required');
    return invoke(this.runner, this.executable, 'verify_state', {
      pid: target.pid, window_id: target.windowId, session: label, expect, include_screenshot: includeScreenshot, timeout_ms: 5_000, stable_samples: 2
    });
  }

  perform({ pid, windowId, session, ownerTaskId, ownerActorId, action, actionArgs = {}, expect, userActive = false, foregroundAuthorized = false } = {}) {
    const target = { pid: positiveInteger(pid, 'pid'), windowId: positiveInteger(windowId, 'window id') };
    const label = safeSession(session);
    const exactTargetId = `window:${target.pid}:${target.windowId}`;
    const snapshot = this.snapshot({ ...target, session: label, includeScreenshot: Number.isFinite(actionArgs.x) && Number.isFinite(actionArgs.y) });
    const backgroundArgs = normalizeActionArgs(action, actionArgs, snapshot, target, label, 'background');
    let result;
    let focusSession = null;
    let escalated = false;
    try {
      try {
        result = invoke(this.runner, this.executable, action, backgroundArgs);
      } catch (error) {
        if (!isBackgroundUnavailable(error)) throw error;
        if (!foregroundAuthorized) throw new CuaDriverAdapterError('foreground_authorization_required', 'background CUA delivery was unavailable and foreground escalation is not authorized');
        let observedActivity;
        try { observedActivity = this.activityProbe(); }
        catch (activityError) { throw activityError?.code ? activityError : new CuaDriverAdapterError('user_activity_unknown', 'user activity could not be proven idle'); }
        if (!observedActivity || typeof observedActivity.active !== 'boolean') throw new CuaDriverAdapterError('user_activity_unknown', 'user activity probe returned no decision');
        focusSession = this.focusGuard.begin({
          ownerTaskId, ownerActorId, exactTargetId, userActive: userActive === true || observedActivity.active, mutation: true,
          routeOptions: { foregroundComputerUseAvailable: true }, recoveryRef: `cua:${label}`
        });
        this.focusGuard.authorize(focusSession);
        const foregroundArgs = normalizeActionArgs(action, actionArgs, snapshot, target, label, 'foreground');
        result = invoke(this.runner, this.executable, action, foregroundArgs);
        escalated = true;
      }
      const verification = this.verify({ ...target, session: label, expect });
      const status = verification?.structuredContent?.status ?? verification?.status;
      if (status !== 'satisfied') throw new CuaDriverAdapterError('cua_postcondition_not_satisfied', `CUA verification returned ${status ?? 'unknown'}`);
      return Object.freeze({ ok: true, action, route: escalated ? 'foreground' : 'background', exactTargetId, verification: 'satisfied' });
    } finally {
      if (focusSession) this.focusGuard.end(focusSession, 'cua-action-complete');
    }
  }
}