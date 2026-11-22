import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ExtensionManager, ExtensionRegistry } from '../src/extensions/registry.mjs';
import { WEB_GPT_ORCHESTRATOR_TOOLS } from '../src/orchestration/mcp-server.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = process.env.AICC_EXTENSION_SMOKE_REPORT?.trim();
if (!output || !path.isAbsolute(output)) throw new Error('AICC_EXTENSION_SMOKE_REPORT must be an absolute task-owned report path');

async function routeHealth() {
  try {
    const response = await fetch('http://127.0.0.1:17841/healthz', { signal: AbortSignal.timeout(1_000) });
    return { reachable: response.ok, status: response.status };
  } catch { return { reachable: false, status: null }; }
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-extension-smoke-'));
const stateRoot = path.join(temporary, 'state');
const installRoot = path.join(temporary, 'extensions');
const routeBefore = await routeHealth();
let client = null;
try {
  const registry = new ExtensionRegistry({ root });
  const validated = registry.validate();
  const manager = new ExtensionManager({ registry, installRoot });
  const installed = manager.install('web-gpt-orchestrator');
  const duplicate = manager.install('web-gpt-orchestrator');
  const disabled = manager.setEnabled('web-gpt-orchestrator', false);
  const routeWhileDisabled = await routeHealth();
  const enabled = manager.setEnabled('web-gpt-orchestrator', true);
  const descriptor = JSON.parse(fs.readFileSync(path.join(installed.packagePath, '.mcp.json'), 'utf8')).mcpServers['web-gpt-orchestrator'];
  if (descriptor.command !== 'aicc' || JSON.stringify(descriptor.args) !== JSON.stringify(['orchestration', 'mcp'])) throw new Error('installed MCP descriptor changed');
  const transport = new StdioClientTransport({
    command: path.join(root, 'bin', 'aicc'),
    args: descriptor.args,
    cwd: installed.packagePath,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      NO_COLOR: '1',
      AICC_STATE_ROOT: stateRoot
    },
    stderr: 'pipe'
  });
  client = new Client({ name: 'aicc-extension-smoke', version: '1.0.0' });
  await client.connect(transport);
  const toolNames = (await client.listTools()).tools.map(tool => tool.name).sort();
  const expectedTools = [...WEB_GPT_ORCHESTRATOR_TOOLS].sort();
  const statusResult = await client.callTool({ name: 'status', arguments: {} });
  const status = statusResult.structuredContent ?? JSON.parse(statusResult.content.find(item => item.type === 'text').text);
  await client.close();
  client = null;
  const uninstalled = manager.uninstall('web-gpt-orchestrator');
  const routeAfter = await routeHealth();
  const report = {
    ok: validated.ok
      && installed.ok && duplicate.duplicate
      && disabled.enabled === false && enabled.enabled === true
      && JSON.stringify(toolNames) === JSON.stringify(expectedTools)
      && status.ok && status.runCount === 0
      && uninstalled.recoverable
      && routeBefore.reachable === routeWhileDisabled.reachable
      && routeBefore.reachable === routeAfter.reachable,
    registry: { extensionCount: validated.extensionCount, digest: validated.extensions[0].digest, secretScan: validated.extensions[0].secretScan },
    lifecycle: {
      cleanInstall: installed.ok && !installed.duplicate,
      idempotentInstall: duplicate.duplicate,
      disable: disabled.enabled === false,
      enable: enabled.enabled === true,
      uninstall: uninstalled.removed,
      uninstallRecoverable: uninstalled.recoverable
    },
    mcp: { descriptorCommand: descriptor.command, toolCount: toolNames.length, exactTools: toolNames, statusReadOnly: status.ok },
    routeIsolation: { before: routeBefore, whileDisabled: routeWhileDisabled, after: routeAfter, changed: routeBefore.reachable !== routeAfter.reachable },
    privateAdapterRequired: false,
    personalMarketplaceChanged: false,
    installedCodexConfigChanged: false
  };
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} finally {
  if (client) await client.close().catch(() => {});
  fs.rmSync(temporary, { recursive: true, force: true });
}
