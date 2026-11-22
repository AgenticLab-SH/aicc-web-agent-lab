import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectCodexDesktopTransport, summarizeCodexDesktopLog } from '../src/codex-desktop-transport-diagnostics.mjs';

const incidentLog = `2026-08-15T16:12:42.908Z info [StdioConnection] stdio_transport_spawned argsCount=4 executablePath=/Applications/ChatGPT.app/Contents/Resources/codex pid=35329
2026-08-15T16:12:43.048Z info [electron-message-handler] websocket_reconnect_marked_threads_needing_resume conversationCount=16 markedCount=5 previousRoleCount=5 previousStreamingCount=5
2026-08-15T16:12:43.330Z info [electron-message-handler] app_server_restart_recovery_done resumedCurrentConversation=true
2026-08-15T16:12:43.340Z error [electron-message-handler] Received item/started for unknown conversation conversationId=child-1
2026-08-15T16:12:43.350Z error [electron-message-handler] Conversation state not found conversationId=child-1
2026-08-15T16:12:43.360Z error [electron-message-handler] Received item/completed for unknown conversation conversationId=child-2
2026-08-15T16:12:43.370Z info [electron-message-handler] Reasoning summary item completed threadId=root-1
2026-08-15T16:12:43.380Z error [electron-message-handler] Conversation state not found conversationId=child-2
2026-08-15T16:12:43.404Z error [StdioConnection] Failed to parse app-server stdout JSONL message errorMessage="Expected ',' or '}' after property value in JSON at position 65538 (line 1 column 65539)" errorName=SyntaxError lineBytes=131277
2026-08-15T16:12:55.918Z error [StdioConnection] Failed to parse app-server stdout JSONL message errorMessage="Expected ',' or '}' after property value in JSON at position 65516 (line 1 column 65517)" errorName=SyntaxError lineBytes=65797
2026-08-15T16:13:13.015Z warning [WindowContext] Thread catalog sync failed errorMessage="App server catalog request expired while queued"
2026-08-15T16:13:14.015Z warning [AppServerConnection] app_server_client_request_queue_rejected reason=queue-expired requestId=request-1
`;

test('desktop transport summary separates confirmed errors from the inferred restart trigger', () => {
  const summary = summarizeCodexDesktopLog(incidentLog, { source: '/demo/owner/Library/Logs/com.openai.codex/incident.log', home: '/demo/owner' });
  assert.equal(summary.parseErrorCount, 2);
  assert.equal(summary.firstObservedAt, '2026-08-15T16:12:43.404Z');
  assert.equal(summary.lineSize.maximumBytes, 131277);
  assert.equal(summary.lineSize.atLeast64KiB, 2);
  assert.equal(summary.chunkBoundaryPattern.nearBoundaryPositionCount, 2);
  assert.equal(summary.restartContext.previousStreamingCount, 5);
  assert.equal(summary.restartContext.multiStreamRestartTrigger, true);
  assert.equal(summary.hiddenConversationContext.preErrorEventCount, 4);
  assert.equal(summary.hiddenConversationContext.preErrorUniqueConversationCount, 2);
  assert.equal(summary.hiddenConversationContext.preErrorUniqueVisibleThreadCount, 1);
  assert.equal(summary.hiddenConversationContext.identifiersIncluded, false);
  assert.equal(summary.queueSymptoms.catalogExpiryLogCount, 1);
  assert.equal(summary.queueSymptoms.rejectedRequestCount, 1);
  assert.equal(summary.classification, 'JSONL_CORRUPTION_DURING_UNKNOWN_CONVERSATION_EVENT_BURST');
  assert.equal(summary.source, '~/Library/Logs/com.openai.codex/incident.log');
  assert.equal(summary.rawLogIncluded, false);
});

test('transport inspection reports a clean current log while preserving the latest incident aggregate', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-desktop-transport-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const logRoot = path.join(home, 'Library', 'Logs', 'com.openai.codex', '2026', '08', '16');
  fs.mkdirSync(logRoot, { recursive: true });
  const incident = path.join(logRoot, 'incident.log');
  const current = path.join(logRoot, 'current.log');
  fs.writeFileSync(incident, incidentLog);
  fs.writeFileSync(current, '2026-08-16T01:00:00.000Z info [StdioConnection] stdio_transport_spawned pid=37401\n');
  fs.utimesSync(incident, new Date('2026-08-15T16:20:00Z'), new Date('2026-08-15T16:20:00Z'));
  fs.utimesSync(current, new Date('2026-08-16T01:00:00Z'), new Date('2026-08-16T01:00:00Z'));

  const result = inspectCodexDesktopTransport({ home, logRoot, now: Date.parse('2026-08-16T01:01:00Z') });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'RECOVERED_NO_CURRENT_PARSE_ERROR');
  assert.equal(result.currentLog.parseErrorCount, 0);
  assert.equal(result.latestIncident.parseErrorCount, 2);
  assert.equal(result.assessment.confirmedTrigger, 'hidden or subagent conversation event burst immediately preceded the first malformed frame');
  assert.equal(JSON.stringify(result).includes(home), false);
});
