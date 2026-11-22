import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeRescuePaths } from './native-rescue.mjs';

const bundleId = 'com.openai.codex';
const requiredWebModel = 'chatgpt-web/saved/extra-high';

function platformOf(options = {}) {
  return options.platform ?? process.platform;
}

function windowsPowerShell(options = {}) {
  return options.windowsPowerShell ?? process.env.AICC_POWERSHELL ?? 'powershell.exe';
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function run(spawn, executable, args, options = {}) {
  const result = spawn(executable, args, { encoding: 'utf8', windowsHide: true, ...options });
  return {
    status: Number.isInteger(result?.status) ? result.status : null,
    stdout: String(result?.stdout || ''),
    stderr: String(result?.stderr || ''),
    error: result?.error ?? null
  };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function lastLifecycleEvent(file, options = {}) {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const chunkBytes = options.chunkBytes ?? 256 * 1024;
  const handle = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(handle).size;
    let end = size;
    let suffix = '';
    let examined = 0;
    while (end > 0 && examined < maxBytes) {
      const length = Math.min(chunkBytes, end, maxBytes - examined);
      const start = end - length;
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, start);
      const lines = `${buffer.toString('utf8')}${suffix}`.split('\n');
      suffix = start > 0 ? lines.shift() ?? '' : '';
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (entry?.type === 'response_item'
            && entry?.payload?.type === 'message'
            && entry?.payload?.phase === 'final_answer') {
            return {
              type: 'task_complete',
              timestamp: entry.timestamp ?? null,
              terminal: 'final_answer',
              sourceType: 'response_item_final_answer'
            };
          }
          const type = entry?.type === 'event_msg' ? entry?.payload?.type : null;
          if (type === 'task_started' || type === 'task_complete') {
            return { type, timestamp: entry.timestamp ?? null };
          }
          // Codex Desktop records an interrupted turn as `turn_aborted` without always
          // appending a later `task_complete`. Treat the newer abort as terminal so an
          // interrupted, already-idle task cannot hold the global maintenance gate forever.
          if (type === 'turn_aborted') {
            return {
              type: 'task_complete',
              timestamp: entry.timestamp ?? null,
              terminal: 'interrupted',
              sourceType: type
            };
          }
        } catch { /* retry a possible split line with the preceding chunk */ }
      }
      end = start;
      examined += length;
    }
    return null;
  } finally {
    fs.closeSync(handle);
  }
}

function windowsCodexProcesses(spawn, options = {}) {
  const script = [
    '$ErrorActionPreference="Stop";',
    '$items=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match "^(codex|codex-cli)(\\.exe)?$" } | Select-Object ProcessId,Name,CommandLine,ExecutablePath);',
    '$items | ConvertTo-Json -Compress'
  ].join(' ');
  let result = run(spawn, windowsPowerShell(options), ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (result.error || result.status !== 0) {
    const fallbackScript = [
      '$items=@(Get-Process -Name codex,codex-cli -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path);',
      '$items | ConvertTo-Json -Compress'
    ].join(' ');
    result = run(spawn, windowsPowerShell(options), ['-NoProfile', '-NonInteractive', '-Command', fallbackScript]);
    if (result.error || result.status !== 0) return { ok: false, reason: 'codex_process_list_unknown', processes: [] };
    let fallbackPayload;
    try { fallbackPayload = result.stdout.trim() ? JSON.parse(result.stdout) : []; } catch { return { ok: false, reason: 'codex_process_list_unparseable', processes: [] }; }
    const fallbackItems = Array.isArray(fallbackPayload) ? fallbackPayload : fallbackPayload ? [fallbackPayload] : [];
    if (fallbackItems.length === 0) return { ok: true, processes: [] };
    const discovered = discoverSessionRollouts(options);
    if (!discovered.ok) return { ok: false, reason: discovered.reason, processes: [] };
    return {
      ok: true,
      processes: [{
        pid: Number(fallbackItems[0].Id),
        command: 'codex app-server (session fallback)',
        rollouts: discovered.files,
        unknown: false,
        executablePath: String(fallbackItems[0].Path ?? '').trim() || null
      }]
    };
  }
  let payload;
  try { payload = result.stdout.trim() ? JSON.parse(result.stdout) : []; } catch { return { ok: false, reason: 'codex_process_list_unparseable', processes: [] }; }
  const items = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const discovered = items.some(item => String(item.CommandLine ?? '').includes(' app-server'))
    ? discoverSessionRollouts(options)
    : { ok: true, files: [] };
  if (!discovered.ok) return { ok: false, reason: discovered.reason, processes: [] };
  const processes = items.map(item => {
    const pid = Number(item.ProcessId);
    const command = String(item.CommandLine ?? '').trim();
    const executablePath = String(item.ExecutablePath ?? '').trim();
    // A Windows process does not expose lsof-like open-file handles. Only trust
    // rollout paths explicitly present in the command line; otherwise mark the
    // process unknown so an active task cannot be mistaken for an idle one.
    const rollouts = [...new Set(command.match(/(?:[A-Za-z]:[\\/]|\\\\)[^"']*?sessions[\\/][^"']*?rollout-[^"'\\s]+\.jsonl/gi) ?? [])]
      .map(file => file.replaceAll('/', path.sep));
    const appServer = command.includes(' app-server');
    const associatedRollouts = appServer && rollouts.length === 0 ? discovered.files : rollouts;
    const unknown = !Number.isInteger(pid) || pid <= 1 || (!appServer && associatedRollouts.length === 0);
    return { pid, command, rollouts: associatedRollouts, unknown, executablePath: executablePath || null };
  }).filter(item => Number.isInteger(item.pid) && item.pid > 1);
  return { ok: true, processes };
}

function discoverSessionRollouts(options = {}) {
  const codexHome = path.resolve(options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  const root = path.join(codexHome, 'sessions');
  const maxFiles = options.maxSessionRollouts ?? 10_000;
  if (!Number.isInteger(maxFiles) || maxFiles < 1) return { ok: false, reason: 'session_rollout_limit_invalid', files: [] };
  if (!fs.existsSync(root)) return { ok: true, files: [] };
  const files = [];
  const pending = [root];
  try {
    while (pending.length > 0) {
      const directory = pending.pop();
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, reason: 'session_directory_unsafe', files: [] };
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) return { ok: false, reason: 'session_entry_unsafe', files: [] };
        if (entry.isDirectory()) {
          pending.push(target);
          continue;
        }
        if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
        files.push(target);
        if (files.length > maxFiles) return { ok: false, reason: 'session_rollout_limit_exceeded', files: [] };
      }
    }
  } catch {
    return { ok: false, reason: 'session_rollout_scan_failed', files: [] };
  }
  return { ok: true, files };
}

function codexProcesses(spawn, options = {}) {
  if (platformOf(options) === 'win32') return windowsCodexProcesses(spawn, options);
  const found = run(spawn, 'ps', ['-axo', 'pid=,command=']);
  if (found.status !== 0) return { ok: false, reason: 'codex_process_list_unknown', processes: [] };
  const pids = [];
  for (const line of found.stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\S+)/);
    if (!match) continue;
    const pid = Number(match[1]);
    const executable = match[2];
    if (Number.isInteger(pid) && pid > 1 && path.basename(executable) === 'codex') pids.push(pid);
  }
  const processes = [];
  for (const pid of pids) {
    const details = run(spawn, 'ps', ['-ww', '-p', String(pid), '-o', 'command=']);
    const files = run(spawn, 'lsof', ['-nP', '-Fn', '-p', String(pid)]);
    if (details.status !== 0 || files.status !== 0) {
      processes.push({ pid, command: null, rollouts: [], unknown: true });
      continue;
    }
    const rollouts = [...new Set(files.stdout.split('\n')
      .filter(line => line.startsWith('n'))
      .map(line => line.slice(1))
      .filter(file => file.includes('/sessions/') && /\/rollout-.*\.jsonl$/.test(file)))];
    processes.push({ pid, command: details.stdout.trim(), rollouts, unknown: false });
  }
  return { ok: true, processes };
}

export function inspectCodexWork(options = {}) {
  const spawn = options.spawnSync ?? spawnSync;
  const lifecycle = options.lastLifecycleEvent ?? lastLifecycleEvent;
  // Tests that inject a POSIX fake runner are explicitly emulating the legacy
  // macOS process contract. Production calls with no injected runner use the
  // host platform and therefore query Windows via CIM when appropriate.
  const platform = options.platform ?? (options.spawnSync ? 'darwin' : process.platform);
  const inventory = options.processes ?? codexProcesses(spawn, { ...options, platform });
  if (!inventory.ok) return { safe: false, active: [], complete: [], unknown: [{ reason: inventory.reason }] };
  const active = [];
  const complete = [];
  const unknown = [];
  const seen = new Set();
  const nowMs = options.nowMs ?? Date.now();
  const noLifecycleGraceMs = options.noLifecycleGraceMs ?? 2 * 60_000;
  const activeStaleGraceMs = options.activeStaleGraceMs ?? 24 * 60 * 60_000;
  for (const process of inventory.processes) {
    if (process.unknown) {
      unknown.push({ pid: process.pid, reason: 'process_inspection_failed' });
      continue;
    }
    if (process.rollouts.length === 0 && !String(process.command).includes(' app-server')) {
      unknown.push({ pid: process.pid, reason: 'interactive_codex_without_rollout' });
      continue;
    }
    for (const file of process.rollouts) {
      if (seen.has(file)) continue;
      seen.add(file);
      let event;
      try { event = lifecycle(file); } catch { event = null; }
      const item = { pid: process.pid, file, event: event?.type ?? 'unknown', timestamp: event?.timestamp ?? null };
      let modifiedAtMs = null;
      try { modifiedAtMs = fs.statSync(file).mtimeMs; } catch { /* handled as unknown */ }
      if (event?.type === 'task_started') {
        if (!Number.isFinite(modifiedAtMs) || nowMs - modifiedAtMs <= activeStaleGraceMs) active.push({ ...item, modifiedAtMs });
      }
      else if (event?.type === 'task_complete') complete.push(item);
      else {
        if (!Number.isFinite(modifiedAtMs) || nowMs - modifiedAtMs <= noLifecycleGraceMs) {
          unknown.push({ ...item, modifiedAtMs, reason: 'lifecycle_unknown' });
        }
      }
    }
  }
  return { safe: active.length === 0 && unknown.length === 0, active, complete, unknown };
}

function desktopApplications(spawn) {
  const script = [
    'ObjC.import("AppKit");',
    `const apps=$.NSRunningApplication.runningApplicationsWithBundleIdentifier("${bundleId}");`,
    'JSON.stringify(ObjC.deepUnwrap(apps.js.map(app => ({pid:Number(app.processIdentifier),terminated:Boolean(app.terminated)}))))'
  ].join(' ');
  const result = run(spawn, '/usr/bin/osascript', ['-l', 'JavaScript', '-e', script]);
  if (result.status !== 0) return { ok: false, applications: [] };
  try {
    return {
      ok: true,
      applications: JSON.parse(result.stdout).filter(item => !item.terminated && Number.isInteger(item.pid))
    };
  } catch {
    return { ok: false, applications: [] };
  }
}

function requestGracefulQuit(spawn, expectedPid) {
  const script = [
    'ObjC.import("AppKit");',
    `const apps=$.NSRunningApplication.runningApplicationsWithBundleIdentifier("${bundleId}");`,
    `const matches=apps.js.filter(app => Number(app.processIdentifier)===${Number(expectedPid)} && !Boolean(app.terminated));`,
    'if(matches.length!==1){throw new Error("exact_desktop_pid_not_found");}',
    'String(Boolean(matches[0].terminate()));'
  ].join(' ');
  return run(spawn, '/usr/bin/osascript', ['-l', 'JavaScript', '-e', script]);
}

function confirmScheduledTaskQuit(spawn, expectedPid) {
  const script = [
    'const se=Application("System Events");',
    `const matches=se.applicationProcesses.whose({unixId:${Number(expectedPid)}})();`,
    'if(matches.length!==1){console.log(JSON.stringify({clicked:false,reason:"exact_desktop_pid_not_found"}));}',
    'else {',
    '  const process=matches[0];',
    '  const containers=[];',
    '  for(const window of process.windows()){',
    '    try { containers.push(...window.sheets()); } catch {}',
    '    try { containers.push(...window.dialogs()); } catch {}',
    '    try { if(String(window.subrole())==="AXDialog") containers.push(window); } catch {}',
    '  }',
    '  const read=(element,key)=>{try{return String(element[key]());}catch{return "";}};',
    '  const eligible=[];',
    '  for(const container of containers){',
    '    const fields=[];',
    '    for(const key of ["staticTexts","textFields"]){try{fields.push(...container[key]());}catch{}}',
    '    const text=[container,...fields].map(element=>["name","value","description","help"].map(key=>read(element,key)).join(" ")).join("\n");',
    '    let buttons=[]; try { buttons=container.buttons(); } catch {}',
    '    const quitButtons=buttons.filter(button=>/^(종료|Quit)$/i.test(read(button,"name")));',
    '    if(/예약된 작업|scheduled task/i.test(text) && quitButtons.length===1) eligible.push(quitButtons[0]);',
    '  }',
    '  if(eligible.length!==1){console.log(JSON.stringify({clicked:false,reason:"exact_scheduled_task_quit_not_found",matches:eligible.length}));}',
    '  else {eligible[0].click(); console.log(JSON.stringify({clicked:true,button:read(eligible[0],"name")}));}',
    '}'
  ].join(' ');
  return run(spawn, '/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5_000 });
}

function fetchJson(spawn, url) {
  const result = run(spawn, 'curl', ['--fail', '--silent', '--show-error', '--max-time', '2', url]);
  if (result.status !== 0) return { ok: false, payload: null };
  try { return { ok: true, payload: JSON.parse(result.stdout) }; }
  catch { return { ok: false, payload: null }; }
}

function serviceSnapshot(spawn, options = {}) {
  const web = fetchJson(spawn, 'http://127.0.0.1:17841/healthz');
  const rescue = fetchJson(spawn, 'http://127.0.0.1:17842/healthz');
  const ocxHealth = fetchJson(spawn, 'http://127.0.0.1:10100/healthz');
  const ocx = run(spawn, options.ocxExecutable ?? 'ocx', ['system', 'status', '--json'], { timeout: 8_000 });
  const native = run(spawn, options.nativeRescue ?? nativeRescuePaths({ home: os.homedir() }).destination, ['--status'], { timeout: 8_000 });
  let ocxState = null;
  try { ocxState = ocx.status === 0 ? JSON.parse(ocx.stdout) : null; } catch { ocxState = null; }
  return { web: web.payload, rescue: rescue.payload, ocx: ocxHealth.payload, ocxState, nativeReady: native.status === 0 };
}

export function validateSurvival(snapshot, options = {}) {
  const exactZero = ['active_http_turns', 'active_browser_http_turns', 'active_browser_turns']
    .every(key => snapshot?.web?.[key] === 0);
  const webReady = snapshot?.web?.status === 'ok'
    && snapshot.web.accepting_turns === true
    && snapshot.web.accepting_browser_turns === true
    && exactZero;
  const rescueReady = snapshot?.rescue?.status === 'ok';
  const ocxReady = snapshot?.ocx?.status === 'ok'
    && snapshot?.ocxState?.memory?.activeTurnCount === 0
    && snapshot?.ocxState?.memory?.isDraining === false;
  const pidsStable = !options.before || [['web', 'pid'], ['rescue', 'pid'], ['ocx', 'pid']]
    .every(([section, key]) => Number(snapshot?.[section]?.[key]) > 0
      && snapshot?.[section]?.[key] === options.before?.[section]?.[key]);
  return {
    ok: webReady && rescueReady && ocxReady && snapshot?.nativeReady === true && pidsStable,
    webReady, rescueReady, ocxReady, nativeReady: snapshot?.nativeReady === true, pidsStable
  };
}

export function inspectCodexDesktopCatalog(home, modelSlug = requiredWebModel, options = {}) {
  const routeUrl = String(options.routeUrl ?? 'http://127.0.0.1:17841/v1').replace(/\/$/, '');
  const spawn = options.spawnSync ?? spawnSync;
  try {
    const config = fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
    const payload = readJson(path.join(home, '.codex/models_cache.json'));
    const cachedModels = Array.isArray(payload.models) ? payload.models : [];
    const routeCatalog = fetchJson(spawn, `${routeUrl}/models`);
    const routeModels = Array.isArray(routeCatalog.payload?.models) ? routeCatalog.payload.models : [];
    const modelId = model => typeof model === 'string' ? model : String(model?.slug ?? model?.id ?? '');
    const configManaged = /^\s*openai_base_url\s*=\s*["']http:\/\/127\.0\.0\.1:17841\/v1["']/m.test(config)
      && !/^\s*model_catalog_json\s*=/m.test(config)
      && !/^\s*model_provider\s*=/m.test(config);
    const nativeModelCount = cachedModels.filter(model => !modelId(model).startsWith('chatgpt-web/')).length;
    const requiredModelPresent = routeModels.some(model => modelId(model) === modelSlug);
    const liveCatalogReady = routeCatalog.ok && routeModels.length > 0 && requiredModelPresent;
    return {
      ok: configManaged && nativeModelCount > 0 && liveCatalogReady,
      configManaged,
      nativeCacheReady: nativeModelCount > 0,
      liveCatalogReady,
      modelCount: routeModels.length,
      nativeModelCount,
      webModelCount: routeModels.filter(model => modelId(model).startsWith('chatgpt-web/')).length,
      requiredModel: modelSlug,
      catalogSource: 'live_route'
    };
  } catch {
    return {
      ok: false,
      configManaged: false,
      nativeCacheReady: false,
      liveCatalogReady: false,
      modelCount: null,
      nativeModelCount: null,
      webModelCount: null,
      requiredModel: modelSlug,
      catalogSource: 'live_route'
    };
  }
}

function progress(event, output = process.stdout) {
  output.write(`[${new Date().toISOString()}] ${String(event.percent).padStart(3)}% | ${event.step} | ETA ${event.eta} | ${event.detail}\n`);
}

function runCodexDesktopLifecycleOnce(options = {}) {
  if (platformOf(options) !== 'darwin') throw new Error('codex_desktop_restart_requires_macos');
  const operation = options.operation ?? 'restart';
  if (!['quit', 'restart'].includes(operation)) throw new Error('invalid_desktop_lifecycle_operation');
  const spawn = options.spawnSync ?? spawnSync;
  const wait = options.pause ?? pause;
  const emit = options.progress ?? (event => progress(event));
  const apps = options.desktopApplications ?? (() => desktopApplications(spawn));
  const work = options.inspectWork ?? (() => inspectCodexWork({ spawnSync: spawn }));
  const services = options.serviceSnapshot ?? (() => serviceSnapshot(spawn, options));
  const catalog = options.catalogState ?? (() => inspectCodexDesktopCatalog(
    options.home ?? os.homedir(),
    options.requiredWebModel,
    { spawnSync: spawn, routeUrl: options.routeUrl }
  ));
  const quit = options.requestGracefulQuit ?? (() => requestGracefulQuit(spawn, expectedPid));
  const confirmQuit = options.confirmScheduledTaskQuit ?? (() => confirmScheduledTaskQuit(spawn, expectedPid));
  const open = options.openDesktop ?? (() => run(spawn, '/usr/bin/open', ['-b', bundleId]));
  const expectedPid = Number(options.expectedPid);
  const zeroSamplesRequired = Number(options.zeroSamplesRequired ?? 5);
  const sampleIntervalMs = Number(options.sampleIntervalMs ?? 2_000);
  const maxSamples = Number(options.maxSamples ?? 3_600);
  const terminateAttempts = Number(options.terminateAttempts ?? 60);
  const readyAttempts = Number(options.readyAttempts ?? 120);
  if (!Number.isInteger(expectedPid) || expectedPid <= 1) throw new Error('expected_desktop_pid_required');
  if (!Number.isInteger(zeroSamplesRequired) || zeroSamplesRequired < 2) throw new Error('invalid_zero_samples');
  if (!Number.isInteger(maxSamples) || maxSamples < zeroSamplesRequired || maxSamples > 21_600) throw new Error('invalid_max_samples');

  const waitMinutes = Math.ceil(maxSamples * sampleIntervalMs / 60_000);
  emit({ percent: 2, step: 'preflight', eta: `up to ${waitMinutes}m`, detail: `Waiting for all Codex tasks and route turns to become safely idle before one ${operation}.` });
  let consecutive = 0;
  let before = null;
  for (let sample = 0; sample < maxSamples; sample += 1) {
    const currentApps = apps();
    if (!currentApps.ok || currentApps.applications.length !== 1 || currentApps.applications[0].pid !== expectedPid) {
      throw new Error('desktop_identity_changed_before_restart');
    }
    const currentWork = work();
    const currentServices = services();
    const survival = validateSurvival(currentServices);
    if (currentWork.safe && survival.ok) {
      before = currentServices;
      consecutive += 1;
      emit({
        percent: 5 + consecutive * 3,
        step: 'idle proof',
        eta: `${Math.max(0, zeroSamplesRequired - consecutive) * Math.ceil(sampleIntervalMs / 1000)}s`,
        detail: `safe sample ${consecutive}/${zeroSamplesRequired}`
      });
      if (consecutive >= zeroSamplesRequired) break;
    } else {
      consecutive = 0;
      emit({
        percent: 5,
        step: 'idle wait',
        eta: `up to ${waitMinutes}m`,
        detail: `active=${currentWork.active.length} unknown=${currentWork.unknown.length} routes_ready=${survival.ok}`
      });
    }
    wait(sampleIntervalMs);
  }
  if (consecutive < zeroSamplesRequired || !before) throw new Error('safe_idle_window_timeout');

  emit({ percent: 30, step: 'graceful quit', eta: 'under 30s', detail: `Requesting one normal termination for exact Desktop PID ${expectedPid}.` });
  const quitResult = quit();
  let disappeared = false;
  let confirmationAttempted = false;
  let confirmationClicked = false;
  for (let attempt = 0; attempt < terminateAttempts; attempt += 1) {
    const current = apps();
    if (current.ok && current.applications.length === 0) { disappeared = true; break; }
    if (!current.ok || current.applications.some(app => app.pid !== expectedPid)) {
      throw new Error('desktop_identity_changed_during_quit');
    }
    if (!confirmationAttempted && attempt >= 3) {
      confirmationAttempted = true;
      const confirmed = confirmQuit();
      if (confirmed.status === 0) {
        try { confirmationClicked = JSON.parse(confirmed.stdout)?.clicked === true; } catch { confirmationClicked = false; }
      }
      emit({
        percent: confirmationClicked ? 42 : 35,
        step: 'scheduled-task confirmation',
        eta: 'under 30s',
        detail: confirmationClicked
          ? 'Clicked the exact scheduled-task Quit button once.'
          : 'No exact scheduled-task Quit dialog was eligible; continuing bounded graceful wait.'
      });
    }
    wait(500);
  }
  if (!disappeared) {
    if (quitResult.status !== 0 && !confirmationClicked) throw new Error('graceful_quit_request_failed');
    throw new Error('desktop_did_not_exit_gracefully');
  }

  if (operation === 'quit') {
    emit({ percent: 70, step: 'post-quit verification', eta: 'up to 60s', detail: 'Desktop is closed; verifying all four independent recovery paths without reopening it.' });
    let after = null;
    for (let attempt = 0; attempt < readyAttempts; attempt += 1) {
      const current = apps();
      const currentServices = services();
      if (current.ok && current.applications.length === 0 && validateSurvival(currentServices, { before }).ok) {
        after = currentServices;
        break;
      }
      wait(500);
    }
    if (!after) throw new Error('desktop_quit_survival_timeout');
    emit({ percent: 100, step: 'PASS', eta: 'done', detail: `Desktop PID ${expectedPid} quit once; it was not reopened and all recovery paths survived.` });
    return {
      ok: true,
      operation,
      oldPid: expectedPid,
      newPid: null,
      zeroSamples: zeroSamplesRequired,
      quitCount: 1,
      restartCount: 0,
      forcedTermination: false,
      scheduledTaskConfirmationClicked: confirmationClicked,
      servicePids: { web: after.web.pid, rescue: after.rescue.pid, ocx: after.ocx.pid }
    };
  }

  emit({ percent: 55, step: 'settle', eta: '2s', detail: 'Old Desktop PID is gone; waiting before one reopen.' });
  wait(Number(options.reopenDelayMs ?? 2_000));
  const opened = open();
  if (opened.status !== 0) throw new Error('desktop_reopen_failed');

  emit({ percent: 70, step: 'readiness', eta: 'up to 60s', detail: 'Waiting for one new Desktop PID and preserving all four recovery paths.' });
  let newPid = null;
  let after = null;
  for (let attempt = 0; attempt < readyAttempts; attempt += 1) {
    const current = apps();
    const currentServices = services();
    const survival = validateSurvival(currentServices, { before });
    if (current.ok && current.applications.length === 1 && current.applications[0].pid !== expectedPid && survival.ok) {
      newPid = current.applications[0].pid;
      after = currentServices;
      break;
    }
    wait(500);
  }
  if (!newPid || !after) throw new Error('desktop_reopen_readiness_timeout');

  let catalogProof = catalog();
  for (let attempt = 0; attempt < 60 && !catalogProof.ok; attempt += 1) {
    wait(500);
    catalogProof = catalog();
  }
  if (!catalogProof.ok) throw new Error('desktop_catalog_postcondition_failed');
  emit({ percent: 100, step: 'PASS', eta: 'done', detail: `Desktop restarted once (${expectedPid} -> ${newPid}); catalog and recovery paths are ready.` });
  return {
    ok: true,
    operation,
    oldPid: expectedPid,
    newPid,
    zeroSamples: zeroSamplesRequired,
    restartCount: 1,
    forcedTermination: false,
    scheduledTaskConfirmationClicked: confirmationClicked,
    servicePids: { web: after.web.pid, rescue: after.rescue.pid, ocx: after.ocx.pid },
    catalog: catalogProof
  };
}

export function restartCodexDesktopOnce(options = {}) {
  return runCodexDesktopLifecycleOnce({ ...options, operation: 'restart' });
}

export function quitCodexDesktopOnce(options = {}) {
  return runCodexDesktopLifecycleOnce({ ...options, operation: 'quit' });
}

function prepareForegroundResult(file, operationId, options = {}) {
  const home = options.home ?? os.homedir();
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(home, '.ai-control-center');
  const allowedRoot = path.join(stateRoot, 'runtime', 'foreground-rescue');
  const resolved = path.resolve(String(file ?? ''));
  const relative = path.relative(path.resolve(allowedRoot), resolved);
  if (!path.isAbsolute(String(file ?? '')) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('foreground_result_outside_owner_runtime');
  }
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(parent, 0o700);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || (process.platform !== 'win32' && (parentStat.mode & 0o077) !== 0)) {
    throw new Error('foreground_result_parent_not_private');
  }
  fs.writeFileSync(resolved, `${JSON.stringify({
    operation: operationId,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    scheduledTask: false,
    forceTermination: false
  }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return resolved;
}

function writeForegroundResult(file, document) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return file;
}

export function runCodexDesktopForegroundOnce(options = {}) {
  if (platformOf(options) !== 'darwin') throw new Error('codex_desktop_restart_requires_macos');
  const operation = options.operation ?? 'restart';
  if (!['quit', 'restart'].includes(operation)) throw new Error('invalid_desktop_lifecycle_operation');
  const operationId = String(options.operationId ?? '').trim();
  const expectedThreadId = String(options.expectedThreadId ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(operationId)) throw new Error('foreground_operation_id_required');
  if (!/^[0-9a-f-]{36}$/i.test(expectedThreadId)) throw new Error('expected_thread_id_required');
  const inspect = options.inspectWork ?? inspectCodexWork({ spawnSync: options.spawnSync ?? spawnSync });
  const observedThread = [...inspect.active, ...inspect.complete, ...inspect.unknown]
    .some(item => String(item.file ?? '').includes(expectedThreadId));
  if (!observedThread) throw new Error('expected_thread_not_observed');
  const resultFile = prepareForegroundResult(options.resultFile, operationId, options);
  const lifecycle = options.lifecycle
    ?? (operation === 'quit' ? quitCodexDesktopOnce : restartCodexDesktopOnce);
  let document;
  try {
    const result = lifecycle(options);
    document = {
      operation: operationId,
      status: 'PASS',
      completedAt: new Date().toISOString(),
      reason: operation === 'quit' ? 'desktop_exact_pid_gracefully_exited' : 'desktop_exact_pid_gracefully_restarted',
      scheduledTask: false,
      forceTermination: false,
      desktop: { oldPid: result.oldPid, newPid: result.newPid ?? null },
      servicePids: result.servicePids ?? null
    };
  } catch (error) {
    document = {
      operation: operationId,
      status: 'HOLD',
      completedAt: new Date().toISOString(),
      reason: error?.message ?? 'foreground_desktop_lifecycle_failed',
      scheduledTask: false,
      forceTermination: false
    };
  }
  writeForegroundResult(resultFile, document);
  return { ...document, resultFile };
}

function activeRunPointer(stateRoot) {
  return path.join(stateRoot, 'runtime/codex-desktop-restart/active.json');
}

export function armCodexDesktopRestart(options = {}) {
  if (platformOf(options) !== 'darwin') throw new Error('codex_desktop_restart_requires_macos');
  const spawn = options.spawnSync ?? spawnSync;
  const home = options.home ?? os.homedir();
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(home, '.ai-control-center');
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  const expectedPid = Number(options.expectedPid);
  const operation = options.operation ?? 'restart';
  if (!['quit', 'restart'].includes(operation)) throw new Error('invalid_desktop_lifecycle_operation');
  const expectedThreadId = String(options.expectedThreadId ?? '').trim();
  if (!Number.isInteger(uid) || uid < 0) throw new Error('user_uid_unknown');
  if (!Number.isInteger(expectedPid) || expectedPid <= 1) throw new Error('expected_desktop_pid_required');
  if (!/^[0-9a-f-]{36}$/i.test(expectedThreadId)) throw new Error('expected_thread_id_required');
  const initialWork = options.inspectWork ?? inspectCodexWork({ spawnSync: spawn });
  const observedThread = [...initialWork.active, ...initialWork.complete, ...initialWork.unknown]
    .some(item => String(item.file ?? '').includes(expectedThreadId));
  if (!observedThread) throw new Error('expected_thread_not_observed');
  const pointer = activeRunPointer(stateRoot);
  if (fs.existsSync(pointer)) {
    try {
      const active = readJson(pointer);
      const terminal = active.runDir && fs.existsSync(path.join(active.runDir, 'result.json'));
      const loaded = active.label && run(spawn, 'launchctl', ['print', `gui/${uid}/${active.label}`]).status === 0;
      if (!terminal || loaded) throw new Error(`restart_already_armed:${active.label ?? 'unknown'}`);
    } catch (error) {
      if (String(error.message).startsWith('restart_already_armed:')) throw error;
      throw new Error('restart_active_pointer_unreadable');
    }
  }
  const now = options.now ?? new Date();
  const id = now.toISOString().replace(/[-:.]/g, '');
  const label = `com.agenticlab.aicc.codex-desktop-${operation}.${id}`;
  const runDir = path.join(stateRoot, 'runtime/codex-desktop-restart', id);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const planFile = path.join(runDir, 'plan.json');
  const script = fileURLToPath(import.meta.url);
  const node = options.node ?? process.execPath;
  const ocxLookup = options.ocxExecutable
    ? { status: 0, stdout: options.ocxExecutable }
    : run(spawn, '/usr/bin/which', ['ocx']);
  const ocxExecutable = ocxLookup.status === 0 ? ocxLookup.stdout.trim() : '';
  if (!path.isAbsolute(ocxExecutable) || !fs.existsSync(ocxExecutable)) throw new Error('ocx_executable_unresolved');
  const plan = {
    schemaVersion: 1,
    label,
    runDir,
    home,
    expectedPid,
    expectedThreadId,
    operation,
    requiredWebModel: options.requiredWebModel ?? requiredWebModel,
    ocxExecutable,
    maxSamples: Number(options.maxSamples ?? 3_600),
    scriptSha256: sha256(script),
    createdAt: now.toISOString()
  };
  writePrivate(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  const plistFile = path.join(runDir, 'one-shot.plist');
  const workerPath = [...new Set([
    path.dirname(node),
    path.dirname(ocxExecutable),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ])].join(':');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key><array><string>${xmlEscape(node)}</string><string>${xmlEscape(script)}</string><string>--worker</string><string>${xmlEscape(planFile)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${xmlEscape(home)}</string>
    <key>PATH</key><string>${xmlEscape(workerPath)}</string>
  </dict>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(runDir, 'progress.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(runDir, 'stderr.log'))}</string>
</dict></plist>
`;
  writePrivate(plistFile, plist);
  const lint = run(spawn, 'plutil', ['-lint', plistFile]);
  if (lint.status !== 0) throw new Error('restart_plist_invalid');
  writePrivate(pointer, `${JSON.stringify({ label, runDir, expectedPid, expectedThreadId, createdAt: plan.createdAt }, null, 2)}\n`);
  const boot = run(spawn, 'launchctl', ['bootstrap', `gui/${uid}`, plistFile]);
  if (boot.status !== 0) {
    try { fs.unlinkSync(pointer); } catch { /* best effort */ }
    throw new Error(`restart_worker_bootstrap_failed:${boot.status ?? 'unknown'}`);
  }
  return { ok: true, operation, label, runDir, planFile, plistFile, keepAlive: false, expectedPid, expectedThreadId };
}

export function armCodexDesktopQuit(options = {}) {
  return armCodexDesktopRestart({ ...options, operation: 'quit' });
}

function workerMain(planFile) {
  const plan = readJson(planFile);
  const resultFile = path.join(plan.runDir, 'result.json');
  const finalFile = path.join(plan.runDir, 'final-message.md');
  const pointer = activeRunPointer(path.resolve(plan.runDir, '../../..'));
  try {
    if (sha256(fileURLToPath(import.meta.url)) !== plan.scriptSha256) throw new Error('restart_worker_source_changed');
    const operation = plan.operation ?? 'restart';
    const lifecycle = operation === 'quit' ? quitCodexDesktopOnce : restartCodexDesktopOnce;
    const result = lifecycle({
      home: plan.home,
      expectedPid: plan.expectedPid,
      requiredWebModel: plan.requiredWebModel,
      ocxExecutable: plan.ocxExecutable,
      maxSamples: plan.maxSamples
    });
    writePrivate(resultFile, `${JSON.stringify({ state: 'PASS', ...result }, null, 2)}\n`);
    writePrivate(finalFile, operation === 'quit'
      ? `PASS: Codex Desktop quit once (PID ${result.oldPid}) without reopening or forced termination.\n`
      : `PASS: Codex Desktop restarted once (${result.oldPid} -> ${result.newPid}) without forced termination.\n`);
  } catch (error) {
    writePrivate(resultFile, `${JSON.stringify({ state: 'HOLD', ok: false, reason: error.message, forcedTermination: false }, null, 2)}\n`);
    writePrivate(finalFile, `HOLD: ${error.message}. No forced termination or repeat was attempted.\n`);
    process.exitCode = 1;
  } finally {
    try { fs.unlinkSync(pointer); } catch { /* external monitor may also clear the terminal pointer */ }
  }
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  const workerIndex = process.argv.indexOf('--worker');
  if (workerIndex >= 0) workerMain(process.argv[workerIndex + 1]);
}
