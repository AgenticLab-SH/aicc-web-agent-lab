#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.env.AICC_REMOTE_MCP_URL || 'http://127.0.0.1:10311/mcp';
const client = new Client({ name: 'aicc-remote-gateway-canary', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(base));

await client.connect(transport);
const tools = await client.listTools();
const names = tools.tools.map(tool => tool.name);
if (!names.includes('aicc_workspace_list') || !names.includes('aicc_remote_status')) {
  throw new Error('expected remote gateway tools are missing');
}

const status = await client.callTool({ name: 'aicc_remote_status', arguments: {} });
const listed = await client.callTool({ name: 'aicc_workspace_list', arguments: {} });
console.log(JSON.stringify({ ok: true, tools: names, status: status.structuredContent ?? status.content, listed: listed.structuredContent ?? listed.content }));
await client.close();
