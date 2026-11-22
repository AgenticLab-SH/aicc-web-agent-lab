import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const JSONL_FAILURE = 'Failed to parse app-server stdout JSONL message';
const CHUNK_BYTES = 64 * 1024;
const PRE_ERROR_WINDOW_MS = 120_000;

function integerField(line, name) {
  const match = String(line).match(new RegExp(`${name}=([0-9]+)`));
  return match ? Number(match[1]) : null;
}

function quotedField(line, name) {
  const match = String(line).match(new RegExp(`${name}="([^"]*)"`));
  return match?.[1] ?? null;
}

function tokenField(line, name) {
  const match = String(line).match(new RegExp(`${name}=([^\\s]+)`));
  return match?.[1] ?? null;
}

function timestampOf(line) {
  const candidate = String(line).split(' ', 1)[0];
  return Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

function normalizePath(file, home = os.homedir()) {
  if (!file) return null;
  const value = String(file);
  const root = String(home);
  const normalizedValue = value.replaceAll('\\', '/');
  const normalizedRoot = root.replaceAll('\\', '/') === '/'
    ? '/'
    : root.replaceAll('\\', '/').replace(/\/+$/, '');
  const windowsPath = /^[A-Za-z]:\//.test(normalizedValue) || /^[A-Za-z]:\//.test(normalizedRoot);
  const comparison = windowsPath ? (candidate => candidate.toLowerCase()) : (candidate => candidate);
  const comparedValue = comparison(normalizedValue);
  const comparedRoot = comparison(normalizedRoot);
  if (comparedValue === comparedRoot) return '~';
  const prefix = comparedRoot.endsWith('/') ? comparedRoot : `${comparedRoot}/`;
  if (comparedValue.startsWith(prefix)) {
    const suffix = normalizedRoot === '/' ? `/${normalizedValue.slice(1)}` : normalizedValue.slice(normalizedRoot.length);
    // Keep the caller's separator style while removing the absolute home.
    return `~${value.slice(value.length - suffix.length)}`;
  }
  return value;
}

function nearChunkBoundary(position) {
  if (!Number.isInteger(position) || position < 0) return false;
  const remainder = position % CHUNK_BYTES;
  return remainder <= 2_048 || remainder >= CHUNK_BYTES - 2_048;
}

export function summarizeCodexDesktopLog(text, options = {}) {
  const errors = [];
  const spawns = [];
  const restartRecoveries = [];
  const streamRecoveryMarkers = [];
  const unknownConversationEvents = [];
  const threadActivity = [];
  const queueRejectionRequestIds = new Set();
  let catalogQueueExpiryCount = 0;

  for (const line of String(text ?? '').split(/\r?\n/)) {
    const timestamp = timestampOf(line);
    if (line.includes('stdio_transport_spawned')) {
      spawns.push({ timestamp, pid: integerField(line, 'pid') });
    }
    if (line.includes('websocket_reconnect_marked_threads_needing_resume')) {
      streamRecoveryMarkers.push({
        timestamp,
        conversationCount: integerField(line, 'conversationCount'),
        markedCount: integerField(line, 'markedCount'),
        previousStreamingCount: integerField(line, 'previousStreamingCount')
      });
    }
    if (line.includes('app_server_restart_recovery_done')) restartRecoveries.push({ timestamp });
    if (line.includes('App server catalog request expired while queued')) catalogQueueExpiryCount += 1;
    if (line.includes('app_server_client_request_queue_rejected')) {
      queueRejectionRequestIds.add(tokenField(line, 'requestId') ?? `line-${queueRejectionRequestIds.size}`);
    }
    if (line.includes('unknown conversation') || line.includes('Conversation state not found')) {
      unknownConversationEvents.push({ timestamp, conversationId: tokenField(line, 'conversationId') });
    }
    const threadId = tokenField(line, 'threadId');
    if (threadId) threadActivity.push({ timestamp, threadId });
    if (!line.includes(JSONL_FAILURE)) continue;

    const errorMessage = quotedField(line, 'errorMessage') ?? 'JSON parse failure';
    const errorPositionMatch = errorMessage.match(/position ([0-9]+)/);
    const errorPosition = errorPositionMatch ? Number(errorPositionMatch[1]) : null;
    errors.push({
      timestamp,
      lineBytes: integerField(line, 'lineBytes'),
      errorPosition,
      errorClass: errorMessage.replace(/ at position [0-9]+.*$/, '')
    });
  }

  const firstError = errors[0] ?? null;
  const lastError = errors.at(-1) ?? null;
  const firstErrorMs = firstError?.timestamp ? Date.parse(firstError.timestamp) : null;
  const beforeFirst = events => events
    .filter(event => event.timestamp && firstErrorMs !== null && Date.parse(event.timestamp) <= firstErrorMs)
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))[0] ?? null;
  const precedingSpawn = beforeFirst(spawns);
  const precedingRestartRecovery = beforeFirst(restartRecoveries);
  const precedingStreamRecovery = beforeFirst(streamRecoveryMarkers);
  const secondsSince = event => event?.timestamp && firstErrorMs !== null
    ? Math.max(0, (firstErrorMs - Date.parse(event.timestamp)) / 1_000)
    : null;
  const lineSizes = errors.map(error => error.lineBytes).filter(Number.isInteger);
  const nearBoundaryPositionCount = errors.filter(error => nearChunkBoundary(error.errorPosition)).length;
  const inPreErrorWindow = event => event.timestamp && firstErrorMs !== null
    && Date.parse(event.timestamp) <= firstErrorMs
    && firstErrorMs - Date.parse(event.timestamp) <= PRE_ERROR_WINDOW_MS;
  const preErrorUnknownEvents = unknownConversationEvents.filter(inPreErrorWindow);
  const preErrorThreadActivity = threadActivity.filter(inPreErrorWindow);
  const precedingUnknownEvent = beforeFirst(unknownConversationEvents);
  const unknownConversationBurst = preErrorUnknownEvents.length >= 4;
  const multiStreamRestartTrigger = Boolean(
    errors.length
    && (precedingStreamRecovery?.previousStreamingCount ?? 0) > 1
    && secondsSince(precedingRestartRecovery) !== null
    && secondsSince(precedingRestartRecovery) <= 5
  );

  return {
    source: normalizePath(options.source, options.home),
    parseErrorCount: errors.length,
    firstObservedAt: firstError?.timestamp ?? null,
    lastObservedAt: lastError?.timestamp ?? null,
    lineSize: {
      minimumBytes: lineSizes.length ? Math.min(...lineSizes) : null,
      maximumBytes: lineSizes.length ? Math.max(...lineSizes) : null,
      atLeast64KiB: lineSizes.filter(size => size >= CHUNK_BYTES).length,
      below16KiB: lineSizes.filter(size => size < 16 * 1024).length
    },
    chunkBoundaryPattern: {
      chunkBytes: CHUNK_BYTES,
      nearBoundaryPositionCount,
      ratio: errors.length ? Number((nearBoundaryPositionCount / errors.length).toFixed(3)) : 0
    },
    restartContext: {
      appServerPid: precedingSpawn?.pid ?? spawns.at(-1)?.pid ?? null,
      spawnAt: precedingSpawn?.timestamp ?? spawns.at(-1)?.timestamp ?? null,
      recoveryCompletedAt: precedingRestartRecovery?.timestamp ?? null,
      secondsFromRecoveryToFirstError: secondsSince(precedingRestartRecovery),
      previousStreamingCount: precedingStreamRecovery?.previousStreamingCount ?? null,
      markedForResumeCount: precedingStreamRecovery?.markedCount ?? null,
      multiStreamRestartTrigger
    },
    hiddenConversationContext: {
      observationWindowSeconds: PRE_ERROR_WINDOW_MS / 1_000,
      totalUnknownEventCount: unknownConversationEvents.length,
      totalUniqueConversationCount: new Set(unknownConversationEvents.map(event => event.conversationId).filter(Boolean)).size,
      preErrorEventCount: preErrorUnknownEvents.length,
      preErrorUniqueConversationCount: new Set(preErrorUnknownEvents.map(event => event.conversationId).filter(Boolean)).size,
      preErrorUniqueVisibleThreadCount: new Set(preErrorThreadActivity.map(event => event.threadId)).size,
      secondsFromLastUnknownEventToFirstError: secondsSince(precedingUnknownEvent),
      burstBeforeFirstError: unknownConversationBurst,
      identifiersIncluded: false
    },
    queueSymptoms: {
      catalogExpiryLogCount: catalogQueueExpiryCount,
      rejectedRequestCount: queueRejectionRequestIds.size
    },
    sampleErrors: errors.slice(0, 3),
    classification: errors.length === 0
      ? 'NO_JSONL_PARSE_FAILURE'
      : unknownConversationBurst
        ? 'JSONL_CORRUPTION_DURING_UNKNOWN_CONVERSATION_EVENT_BURST'
        : multiStreamRestartTrigger
        ? 'JSONL_CORRUPTION_AFTER_MULTI_STREAM_RESTART_RECOVERY'
        : 'JSONL_CORRUPTION',
    rawLogIncluded: false
  };
}

function collectLogFiles(root, depth = 5) {
  if (!root || depth < 0 || !fs.existsSync(root)) return [];
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...collectLogFiles(resolved, depth - 1));
    else if (entry.isFile() && entry.name.endsWith('.log')) output.push(resolved);
  }
  return output;
}

export function inspectCodexDesktopTransport(options = {}) {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const localAppData = options.localAppData ?? environment.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  // AppX redirects LOCALAPPDATA under the exact product package. Only inspect
  // package directory names and the product log subtree; never profiles or auth.
  const packageRoot = path.join(localAppData, 'Packages');
  let packagedLogRoots = [];
  if (platform === 'win32' && !options.logRoot) {
    try {
      packagedLogRoots = fs.readdirSync(packageRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^OpenAI\.Codex_[A-Za-z0-9]+$/.test(entry.name))
        .map(entry => path.join(packageRoot, entry.name, 'LocalCache', 'Local', 'Codex', 'Logs'));
    } catch { /* no package metadata is not evidence of healthy transport */ }
  }
  const logRoots = options.logRoot ? [options.logRoot] : platform === 'win32'
    ? [...packagedLogRoots, path.join(localAppData, 'OpenAI', 'Codex', 'logs'), path.join(localAppData, 'Codex', 'Logs')]
    : [path.join(home, 'Library', 'Logs', 'com.openai.codex')];
  const files = (options.files ?? [...new Set(logRoots.flatMap(logRoot => collectLogFiles(logRoot)))])
    .map(file => { const stat = fs.statSync(file); return { file, mtimeMs: stat.mtimeMs, sizeBytes: stat.size }; })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, options.maxFiles ?? 20);
  const summaries = files.map(({ file, mtimeMs, sizeBytes }) => ({
    mtimeMs,
    sizeBytes,
    ...summarizeCodexDesktopLog(fs.readFileSync(file, 'utf8'), { source: file, home })
  }));
  const latest = summaries[0] ?? null;
  const latestIncident = summaries.find(summary => summary.parseErrorCount > 0) ?? null;
  const now = options.now ?? Date.now();
  const logAgeMs = latest ? now - latest.mtimeMs : null;
  const logFresh = Number.isFinite(logAgeMs) && logAgeMs >= 0
    && logAgeMs <= (options.maxLogAgeMs ?? 24 * 60 * 60 * 1000);
  const currentlyHealthy = Boolean(latest && latest.sizeBytes > 0 && logFresh && latest.parseErrorCount === 0);

  return {
    ok: currentlyHealthy,
    state: !latest ? 'UNKNOWN_NO_DESKTOP_LOG' : latest.sizeBytes === 0 ? 'UNKNOWN_EMPTY_DESKTOP_LOG' : !logFresh ? 'UNKNOWN_STALE_DESKTOP_LOG' : currentlyHealthy ? 'RECOVERED_NO_CURRENT_PARSE_ERROR' : 'DEGRADED_JSONL_PARSE_FAILURE',
    checkedAt: new Date(options.now ?? Date.now()).toISOString(),
    currentLog: latest ? {
      source: latest.source,
      sizeBytes: latest.sizeBytes,
      modifiedAt: new Date(latest.mtimeMs).toISOString(),
      ageSeconds: Number.isFinite(logAgeMs) ? Math.floor(logAgeMs / 1000) : null,
      fresh: logFresh,
      observationOnly: true,
      parseErrorCount: latest.parseErrorCount,
      classification: latest.classification
    } : null,
    latestIncident: latestIncident ? {
      source: latestIncident.source,
      parseErrorCount: latestIncident.parseErrorCount,
      firstObservedAt: latestIncident.firstObservedAt,
      lastObservedAt: latestIncident.lastObservedAt,
      lineSize: latestIncident.lineSize,
      chunkBoundaryPattern: latestIncident.chunkBoundaryPattern,
      restartContext: latestIncident.restartContext,
      hiddenConversationContext: latestIncident.hiddenConversationContext,
      queueSymptoms: latestIncident.queueSymptoms,
      classification: latestIncident.classification,
      sampleErrors: latestIncident.sampleErrors
    } : null,
    assessment: latestIncident ? {
      confirmedFailureLayer: 'Codex Desktop child App Server stdout JSONL transport',
      confirmedTrigger: latestIncident.hiddenConversationContext.burstBeforeFirstError
        ? 'hidden or subagent conversation event burst immediately preceded the first malformed frame'
        : latestIncident.restartContext.multiStreamRestartTrigger
          ? 'App Server restart recovery with multiple previously streaming tasks'
          : 'not proven',
      likelyMechanism: 'large JSONL frames were corrupted around 64 KiB write boundaries under concurrent event delivery; the exact byte writer is not captured in Desktop logs',
      sourcePatchability: 'signed upstream Desktop/App Server component; AICC can detect and contain but does not patch it in place',
      confidence: latestIncident.hiddenConversationContext.burstBeforeFirstError || latestIncident.restartContext.multiStreamRestartTrigger
        ? 'high-layer-high-trigger-correlation-medium-mechanism'
        : 'medium-layer-low-mechanism'
    } : null,
    privacy: { rawLogIncluded: false, conversationContentIncluded: false, absoluteHomePathIncluded: false }
  };
}
