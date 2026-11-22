#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { CodexAppServerClient, loadAppServerManifest } from '../src/adapters/codex-app-server.mjs';

const workspace = process.argv[2];
const manifestPath = process.argv[3];
const model = process.argv[4];
if (!workspace || !manifestPath || !model) throw new Error('usage: smoke-app-server <isolated-workspace> <manifest> <model>');
const manifest = loadAppServerManifest(manifestPath);
const client = new CodexAppServerClient({ cwd: workspace, manifest, env: { ...process.env, AICC_CODEX_VERSION: manifest.codexVersion }, timeoutMs: 120_000 });
const events = [];
client.on('notification', event => events.push(event.method));

try {
  await client.connect();
  const started = await client.threadStart({ model, cwd: workspace, approvalPolicy: 'never', sandbox: 'workspace-write', ephemeral: true, serviceName: 'aicc-phase-03-smoke' });
  const threadId = started.thread.id;
  const completedPromise = client.waitFor('turn/completed', params => params.turn?.id, 120_000);
  const turn = await client.turnStart({ threadId, input: [{ type: 'text', text: 'Create a file named app-server-smoke.txt in the current workspace containing exactly APP_SERVER_PHASE_03_PASS followed by one newline. Then finish.', text_elements: [] }], cwd: workspace, approvalPolicy: 'never', model });
  const completed = await completedPromise;
  const bytes = fs.readFileSync(path.join(workspace, 'app-server-smoke.txt'));
  if (!bytes.equals(Buffer.from('APP_SERVER_PHASE_03_PASS\n'))) throw new Error('artifact bytes mismatch');
  const read = await client.threadRead({ threadId, includeTurns: false });

  const cancelStartedPromise = client.waitFor('turn/started', params => params.turn?.id, 30_000);
  const cancelResponse = await client.turnStart({ threadId, input: [{ type: 'text', text: 'Wait for 30 seconds before replying. Do not change files.', text_elements: [] }], cwd: workspace, approvalPolicy: 'never', model });
  const cancelStarted = await cancelStartedPromise;
  const cancelledPromise = client.waitFor('turn/completed', params => params.turn?.id === cancelResponse.turn.id, 60_000);
  await client.turnInterrupt({ threadId, turnId: cancelResponse.turn.id });
  const cancelled = await cancelledPromise;

  console.log(JSON.stringify({ ok: true, model, threadId, firstTurnId: turn.turn.id, firstStatus: completed.turn.status, artifactBytes: bytes.length, readThreadId: read.thread?.id ?? null, readIncludesTurns: false, cancelTurnId: cancelStarted.turn.id, cancelStatus: cancelled.turn.status, eventCounts: Object.fromEntries([...new Set(events)].map(name => [name, events.filter(value => value === name).length])), ephemeral: true }, null, 2));
} finally { client.close(); }
