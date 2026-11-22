import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DurableJobStore } from '../src/jobs/durable-store.mjs';
import { JobManager } from '../src/jobs/job-manager.mjs';
import { WebGptOrchestrationService } from '../src/orchestration/service.mjs';
import { createDefaultOrchestrationService, createWebGptOrchestratorMcpServer, WEB_GPT_ORCHESTRATOR_TOOLS } from '../src/orchestration/mcp-server.mjs';

async function clientFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-orchestrator-mcp-'));
  const store = new DurableJobStore({ root: path.join(root, 'jobs') });
  const manager = new JobManager({ store });
  const service = new WebGptOrchestrationService({ manager, store, artifactRoot: path.join(root, 'artifacts') });
  const server = createWebGptOrchestratorMcpServer(service);
  const client = new Client({ name: 'orchestrator-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return client;
}

function payload(result) {
  return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
}

test('MCP original ACK reconciliation is a bounded read-only status request', async t => {
  const client = await clientFor(t);
  const listed = await client.listTools();
  const status = listed.tools.find(tool => tool.name === 'status');
  assert.equal(status.annotations.readOnlyHint, true);
  assert.ok(status.inputSchema.properties.consumption.required.includes('adoption'));
  assert.equal(status.inputSchema.properties.consumption.properties.adoption.properties.expectedRunUpdatedAt, undefined);
  const response = await client.callTool({ name: 'status', arguments: { consumption: { roleId: 'researcher',
    capabilitySnapshotHash: 'a'.repeat(64), resultId: 'result', attemptId: 'attempt', operationId: 'operation', requestHash: 'b'.repeat(64),
    adoption: { resultHash: 'c'.repeat(64), consumerId: 'parent', destination: 'parent://exact', effectKey: 'effect', goalRevision: 'revision', identityBinding: 'identity' } } } });
  assert.equal(response.isError, true);
  assert.equal(payload(response).error, 'invalid_request');
});

test('MCP native authority requirements reach the fail-closed boundary instead of being stripped', async t => {
  const client = await clientFor(t);
  const tools = (await client.listTools()).tools;
  const binding = tools.find(tool => tool.name === 'plan_run').inputSchema.properties.parentGoal;
  assert.equal(binding.additionalProperties, false);
  assert.deepEqual(binding.properties.authorityMode.enum, ['COOPERATIVE', 'NATIVE']);
  for (const requirement of [{ authorityMode: 'NATIVE' }, { stopEpoch: 0 }, { ownerThreadId: 'exact-parent' }]) {
    const response = await client.callTool({ name: 'plan_run', arguments: {
      requestId: 'native-boundary-plan', rootTaskId: 'root', workspaceId: 'workspace', routeId: 'unchanged-route', identityBinding: 'identity',
      parentGoal: { goalId: 'tracked-goal', sourceUpdatedAt: 'revision', ...requirement }, surface: 'full',
      tools: [{ id: 'read_file', classes: ['read'] }], roles: [{ roleId: 'researcher', kind: 'researcher', requiredToolIds: ['read_file'] }]
    } });
    assert.equal(response.isError, true);
    assert.equal(payload(response).error, 'native_parent_authority_unavailable');
  }
  assert.equal(payload(await client.callTool({ name: 'status', arguments: {} })).runCount, 0);
});

test('plugin MCP advertises only the eight bounded orchestration tools', async t => {
  const client = await clientFor(t);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [...WEB_GPT_ORCHESTRATOR_TOOLS].sort());
  assert.ok(listed.tools.find(tool => tool.name === 'plan_run').inputSchema.properties.parentGoal);
  assert.equal(listed.tools.find(tool => tool.name === 'plan_run').inputSchema.properties.parentGoal.properties.goalSnapshotHash.pattern, '^[a-f0-9]{64}$');
  const status = payload(await client.callTool({ name: 'status', arguments: {} }));
  assert.equal(status.ok, true);
  assert.equal(status.runCount, 0);
});

test('default orchestration connects only the selected state root tracked goal reader', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-orchestrator-goals-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createDefaultOrchestrationService({ stateRoot: root });
  assert.equal(service.goalLedger.paths.masterGoalsPath, path.join(root, 'control-plane', 'master-goals.json'));
  assert.equal(fs.existsSync(service.goalLedger.paths.masterGoalsPath), false);
  fs.mkdirSync(path.join(root, 'control-plane'), { recursive: true });
  fs.writeFileSync(service.goalLedger.paths.masterGoalsPath, JSON.stringify({ generatedAt: '2026-01-02T03:04:05.000Z', goals: [{ id: 'goal-fixture', title: 'Fixture', status: 'ACTIVE' }] }));
  const snapshot = service.goalLedger.status();
  assert.equal(snapshot.sourceUpdatedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(snapshot.nativeCodexGoal.state, 'UNKNOWN');
});

test('MCP returns explicit unsupported surface instead of inventing local browser-only tools', async t => {
  const client = await clientFor(t);
  const result = await client.callTool({
    name: 'plan_run',
    arguments: {
      requestId: 'mcp-browser-only-request',
      runId: 'mcp-browser-only-run',
      rootTaskId: 'root',
      workspaceId: 'workspace',
      routeId: 'chatgpt-web/temporary/high',
      identityBinding: 'identity',
      surface: 'browser-only',
      tools: [{ id: 'apply_patch', classes: ['write'] }],
      roles: [{ roleId: 'writer', kind: 'writer', mode: 'write', dependencies: [], requiredToolIds: ['apply_patch'] }],
      budgets: { defaultFanOut: 2, hardActiveCap: 5 }
    }
  });
  assert.equal(result.isError, true);
  assert.equal(payload(result).error, 'unsupported_surface');
});
