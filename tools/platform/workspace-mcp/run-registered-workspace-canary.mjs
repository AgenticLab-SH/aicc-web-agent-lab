#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorkspaceMcpServer, loadConfig } from '../../../components/workspace-mcp/server.mjs';
import { workspaceToolsForProfile } from '../../../components/workspace-mcp/tool-manifest.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,80}$/;

function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
}

function payload(result) {
  return result?.structuredContent
    ?? JSON.parse(result?.content?.find(item => item.type === 'text')?.text ?? '{}');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function patchCreate(relative, marker) {
  return `--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1 @@\n+${marker}\n`;
}

function directRollback(file, expected) {
  if (!fs.existsSync(file)) return { required: false, removed: false };
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return { required: true, removed: false, reason: 'canary_target_identity_changed' };
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== sha256(expected)) return { required: true, removed: false, reason: 'canary_content_changed' };
  fs.unlinkSync(file);
  return { required: true, removed: true };
}

export async function runRegisteredWorkspaceCanary({ config, workspaceRoot, runtimeRoot, runId }) {
  if (!SAFE_ID.test(runId ?? '')) throw new Error('canary run ID is invalid');
  const exactRoot = fs.realpathSync(workspaceRoot);
  const workspace = config.workspaces.find(item => fs.realpathSync(item.root) === exactRoot);
  if (!workspace) throw new Error('workspace root is not registered in the selected surface');
  const surface = config.surfaceProfile;
  const expectedTools = workspaceToolsForProfile(surface).map(tool => tool.name).sort();
  const server = createWorkspaceMcpServer(config, {
    runtimeRoot: path.resolve(runtimeRoot)
  });
  const client = new Client({ name: 'aicc-registered-workspace-canary', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let opened = null;
  let canaryFile = null;
  let canaryBytes = null;
  let rollback = { required: false, removed: false };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const actualTools = listed.tools.map(tool => tool.name).sort();
    if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) throw new Error('advertised tool surface differs from the canonical manifest');

    if (surface === 'personal-read-fetch') {
      if (actualTools.some(name => ['aicc_workspace_apply_patch', 'aicc_workspace_exec', 'aicc_workspace_write_stdin', 'aicc_workspace_process_stop'].includes(name))) {
        throw new Error('personal surface exposes a write tool');
      }
      let writeDenied = false;
      try {
        const result = await client.callTool({
          name: 'aicc_workspace_open',
          arguments: { alias: workspace.alias, mode: 'write', correlation_id: `${runId}.personal-deny` }
        });
        writeDenied = result.isError === true;
      } catch {
        writeDenied = true;
      }
      if (!writeDenied) throw new Error('personal surface accepted a forged write lease');
      const readOpen = payload(await client.callTool({
        name: 'aicc_workspace_open',
        arguments: { alias: workspace.alias, correlation_id: `${runId}.personal-read` }
      }));
      if (readOpen.mode !== 'read-only') throw new Error('personal surface did not issue a read-only lease');
      const info = payload(await client.callTool({
        name: 'aicc_workspace_info',
        arguments: { workspace_id: readOpen.workspace_id, lease: readOpen.lease }
      }));
      const closed = payload(await client.callTool({
        name: 'aicc_workspace_close',
        arguments: { workspace_id: readOpen.workspace_id, lease: readOpen.lease }
      }));
      if (info.alias !== workspace.alias || closed.closed !== true) throw new Error('personal read lease post-read failed');
      return {
        ok: true,
        surface,
        workspaceAlias: workspace.alias,
        toolCount: actualTools.length,
        writeToolCount: 0,
        forgedWriteDenied: true,
        readback: true,
        rollback: 'not_applicable'
      };
    }

    const relative = `.aicc-recovery/workspace-canary-${runId}.txt`;
    canaryFile = path.join(exactRoot, relative);
    if (fs.existsSync(canaryFile)) throw new Error('canary target already exists');
    const marker = `AICC_REGISTERED_WORKSPACE_CANARY_${runId}`;
    canaryBytes = `${marker}\n`;
    opened = payload(await client.callTool({
      name: 'aicc_workspace_open',
      arguments: { alias: workspace.alias, mode: 'write', correlation_id: `${runId}.business-open`, expires_in_seconds: 300 }
    }));
    if (opened.mode !== 'write') throw new Error('business surface did not issue a write lease');
    const created = await client.callTool({
      name: 'aicc_workspace_apply_patch',
      arguments: {
        workspace_id: opened.workspace_id,
        lease: opened.lease,
        request_id: `${runId}.create`,
        patch: patchCreate(relative, marker)
      }
    });
    if (created.isError === true || payload(created).ok !== true) throw new Error('business canary create failed');
    const read = payload(await client.callTool({
      name: 'aicc_workspace_read',
      arguments: { workspace_id: opened.workspace_id, lease: opened.lease, path: relative, start_line: 1, max_lines: 10 }
    }));
    if (read.text !== canaryBytes) throw new Error('business canary readback mismatch');
    if (process.platform === 'win32') {
      rollback = directRollback(canaryFile, canaryBytes);
      if (rollback.required !== true || rollback.removed !== true || fs.existsSync(canaryFile)) {
        throw new Error(`business canary rollback failed (direct=${rollback.removed === true}, targetExists=${fs.existsSync(canaryFile)})`);
      }
    } else {
      const removed = await client.callTool({
        name: 'aicc_workspace_exec',
        arguments: {
          workspace_id: opened.workspace_id,
          lease: opened.lease,
          request_id: `${runId}.rollback`,
          command: `set -eu; test "$(cat -- '${relative}')" = '${marker}'; rm -- '${relative}'; test ! -e '${relative}'; printf 'ROLLBACK_OK'`,
          yield_time_ms: 1_000
        }
      });
      const removedPayload = payload(removed);
      if (removed.isError === true || removedPayload.ok !== true || removedPayload.running === true
        || removedPayload.exit_code !== 0 || removedPayload.output !== 'ROLLBACK_OK' || fs.existsSync(canaryFile)) {
        throw new Error(`business canary rollback failed (toolError=${removed.isError === true}, toolOk=${removedPayload.ok === true}, running=${removedPayload.running === true}, exit=${removedPayload.exit_code ?? 'unknown'}, targetExists=${fs.existsSync(canaryFile)})`);
      }
    }
    const closed = payload(await client.callTool({
      name: 'aicc_workspace_close',
      arguments: { workspace_id: opened.workspace_id, lease: opened.lease }
    }));
    opened = null;
    if (closed.closed !== true) throw new Error('business canary lease close failed');
    return {
      ok: true,
      surface,
      workspaceAlias: workspace.alias,
      toolCount: actualTools.length,
      writeToolCount: listed.tools.filter(tool => tool.annotations?.readOnlyHint === false).length,
      write: true,
      readback: true,
      rollback: 'pass',
      canarySha256: sha256(canaryBytes)
    };
  } catch (error) {
    if (canaryFile && canaryBytes) rollback = directRollback(canaryFile, canaryBytes);
    error.canaryRollback = rollback;
    throw error;
  } finally {
    if (opened) {
      await client.callTool({
        name: 'aicc_workspace_close',
        arguments: { workspace_id: opened.workspace_id, lease: opened.lease }
      }).catch(() => {});
    }
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const configFile = option(args, '--config');
  const workspaceRoot = option(args, '--workspace-root');
  const runtimeRoot = option(args, '--runtime-root');
  const runId = option(args, '--run-id');
  if (!configFile || !path.isAbsolute(configFile) || !workspaceRoot || !path.isAbsolute(workspaceRoot)
    || !runtimeRoot || !path.isAbsolute(runtimeRoot) || !runId) {
    throw new Error('Usage: run-registered-workspace-canary.mjs --config ABSOLUTE_JSON --workspace-root ABSOLUTE_DIRECTORY --runtime-root ABSOLUTE_DIRECTORY --run-id SAFE_ID');
  }
  const result = await runRegisteredWorkspaceCanary({ config: loadConfig(configFile), workspaceRoot, runtimeRoot, runId });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, rollback: error.canaryRollback ?? null })}\n`);
    process.exitCode = 1;
  });
}
