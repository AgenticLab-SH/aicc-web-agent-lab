#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.AICC_REMOTE_MCP_URL || 'http://127.0.0.1:10311/mcp';
const client = new Client({ name: 'aicc-remote-read-canary', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(url));
const unwrap = result => {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find(item => item.type === 'text')?.text;
  return text ? JSON.parse(text) : result;
};

await client.connect(transport);
let opened;
try {
  const listed = unwrap(await client.callTool({ name: 'aicc_workspace_list', arguments: {} }));
  if (listed.workspaces?.length !== 1 || listed.workspaces[0]?.alias !== 'open-aicc') {
    throw new Error('least-privilege workspace list check failed');
  }
  opened = unwrap(await client.callTool({
    name: 'aicc_workspace_open',
    arguments: { alias: 'open-aicc', correlation_id: 'gateway-read-canary-20260925' }
  }));
  const leaseArgs = { workspace_id: opened.workspace_id, lease: opened.lease };
  const info = unwrap(await client.callTool({ name: 'aicc_workspace_info', arguments: leaseArgs }));
  const read = unwrap(await client.callTool({
    name: 'aicc_workspace_read',
    arguments: { ...leaseArgs, path: 'README.md', start_line: 1, max_lines: 12 }
  }));
  const search = unwrap(await client.callTool({
    name: 'aicc_workspace_search',
    arguments: { ...leaseArgs, query: 'RemoteLeaseAuthority', path: '.', files_only: false, max_results: 5 }
  }));
  const changes = unwrap(await client.callTool({ name: 'aicc_workspace_changes', arguments: leaseArgs }));
  console.log(JSON.stringify({
    ok: true,
    workspace_alias: opened.alias,
    workspace_id: opened.workspace_id,
    info_ok: info.ok === true,
    read_ok: read.ok === true,
    read_path: read.path,
    search_ok: search.ok === true,
    search_results: search.results?.length ?? 0,
    changes_ok: changes.ok === true
  }));
} finally {
  if (opened?.workspace_id && opened?.lease) {
    await client.callTool({
      name: 'aicc_workspace_close',
      arguments: { workspace_id: opened.workspace_id, lease: opened.lease }
    }).catch(() => {});
  }
  await client.close();
}
