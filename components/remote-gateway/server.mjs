#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import * as z from 'zod/v4';

const HOST = process.env.AICC_REMOTE_GATEWAY_HOST || '127.0.0.1';
const PORT = Number(process.env.AICC_REMOTE_GATEWAY_PORT || 10311);
const DEVICE_ID = process.env.AICC_REMOTE_DEVICE_ID || 'windows-primary';
const CALL_TIMEOUT_MS = Number(process.env.AICC_REMOTE_CALL_TIMEOUT_MS || 45000);
const ONLINE_TTL_MS = Number(process.env.AICC_REMOTE_ONLINE_TTL_MS || 15000);

const queue = [];
const inflight = new Map();
let lastSeenAt = 0;

function authorize(req, res) {
  const address = req.socket?.remoteAddress || '';
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true;
  res.status(403).json({ ok: false, error: 'device_endpoint_loopback_only' });
  return false;
}

function deviceOnline() {
  return Date.now() - lastSeenAt <= ONLINE_TTL_MS;
}

function response(value) {
  if (value && Array.isArray(value.content)) return value;
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function forward(tool, args = {}) {
  if (!deviceOnline()) throw new Error('Windows AICC device is offline');
  if (inflight.size >= 64) throw new Error('Windows AICC pending call limit reached; no call dispatched');
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inflight.delete(requestId);
      const queuedIndex = queue.findIndex(job => job.request_id === requestId);
      if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
      reject(new Error('Windows AICC device call timed out'));
    }, CALL_TIMEOUT_MS);
    timer.unref?.();
    inflight.set(requestId, { resolve, reject, timer });
    queue.push({ request_id: requestId, tool, arguments: args, expires_at: Date.now() + CALL_TIMEOUT_MS });
  });
}

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
const lease = {
  workspace_id: z.string().regex(/^ws_[a-f0-9]{24}$/),
  lease: z.string().regex(/^remote_cap_[a-f0-9]{64}$/)
};

function buildMcpServer() {
  const server = new McpServer({ name: 'aicc-a1-remote-gateway', version: '0.1.0' });
  server.registerTool('aicc_remote_status', {
    description: 'A1 gateway와 Windows AICC device의 연결 상태를 반환합니다.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => response({ ok: true, device_id: DEVICE_ID, online: deviceOnline(), queued: queue.length, inflight: inflight.size }));

  server.registerTool('aicc_workspace_list', {
    description: 'Windows AICC에 등록된 워크스페이스 별칭을 조회합니다.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => response(await forward('aicc_workspace_list')));

  server.registerTool('aicc_workspace_open', {
    description: '등록 워크스페이스를 read-only lease로 엽니다.',
    inputSchema: {
      alias: z.string().min(1).max(128),
      correlation_id: id,
      expires_in_seconds: z.number().int().min(1).max(3600).nullable().default(null)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async input => response(await forward('aicc_workspace_open', { ...input, mode: 'read-only' })));

  server.registerTool('aicc_workspace_close', {
    description: '열린 read-only lease를 반환합니다.',
    inputSchema: lease,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async input => response(await forward('aicc_workspace_close', input)));

  server.registerTool('aicc_workspace_info', {
    description: '워크스페이스 Git 상태와 최상위 항목을 요약합니다.',
    inputSchema: lease,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async input => response(await forward('aicc_workspace_info', input)));

  server.registerTool('aicc_workspace_read', {
    description: '워크스페이스 내부 텍스트 파일 범위를 읽습니다.',
    inputSchema: {
      ...lease,
      path: z.string().min(1),
      start_line: z.number().int().min(1).default(1),
      max_lines: z.number().int().min(1).max(2000).default(400)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async input => response(await forward('aicc_workspace_read', input)));

  server.registerTool('aicc_workspace_read_many', {
    description: '워크스페이스 내부 여러 텍스트 파일을 한 번에 읽습니다.',
    inputSchema: {
      ...lease,
      paths: z.array(z.string().min(1)).min(1).max(20),
      max_lines_each: z.number().int().min(1).max(1000).default(250)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async input => response(await forward('aicc_workspace_read_many', input)));

  server.registerTool('aicc_workspace_search', {
    description: '워크스페이스 내부를 bounded search 합니다.',
    inputSchema: {
      ...lease,
      query: z.string().min(1).max(500),
      path: z.string().default('.'),
      files_only: z.boolean().default(false),
      max_results: z.number().int().min(1).max(500).default(100)
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async input => response(await forward('aicc_workspace_search', input)));

  server.registerTool('aicc_workspace_changes', {
    description: '현재 Git 변경 요약을 반환합니다.',
    inputSchema: lease,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async input => response(await forward('aicc_workspace_changes', input)));

  return server;
}

const allowedHosts = (process.env.AICC_REMOTE_ALLOWED_HOSTS || '127.0.0.1,localhost')
  .split(',').map(value => value.trim()).filter(Boolean);
const app = createMcpExpressApp({ host: HOST, allowedHosts });

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'aicc-a1-remote-gateway', device_online: deviceOnline(), queued: queue.length, inflight: inflight.size });
});

app.post('/device/heartbeat', (req, res) => {
  if (!authorize(req, res)) return;
  if (req.body?.device_id !== DEVICE_ID) return res.status(403).json({ ok: false, error: 'wrong_device' });
  lastSeenAt = Date.now();
  res.json({ ok: true });
});

app.post('/device/poll', (req, res) => {
  if (!authorize(req, res)) return;
  if (req.body?.device_id !== DEVICE_ID) return res.status(403).json({ ok: false, error: 'wrong_device' });
  lastSeenAt = Date.now();
  while (queue.length && queue[0].expires_at < Date.now()) queue.shift();
  const job = queue.shift();
  if (!job) return res.status(204).end();
  res.json(job);
});

app.post('/device/result', (req, res) => {
  if (!authorize(req, res)) return;
  if (req.body?.device_id !== DEVICE_ID) return res.status(403).json({ ok: false, error: 'wrong_device' });
  lastSeenAt = Date.now();
  const entry = inflight.get(req.body?.request_id);
  if (!entry) return res.status(404).json({ ok: false, error: 'unknown_request' });
  clearTimeout(entry.timer);
  inflight.delete(req.body.request_id);
  if (req.body.ok) entry.resolve(req.body.result);
  else entry.reject(new Error(String(req.body.error || 'device_call_failed')));
  res.json({ ok: true });
});

app.post('/mcp', async (req, res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void Promise.allSettled([Promise.resolve().then(() => transport.close()), Promise.resolve().then(() => server.close())]);
  };
  res.once('close', close);
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    close();
    console.error('[remote-gateway] MCP request failed:', error?.message || error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});

for (const method of ['get', 'delete']) {
  app[method]('/mcp', (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));
}

app.listen(PORT, HOST, error => {
  if (error) throw error;
  console.log('[remote-gateway] listening http://' + HOST + ':' + PORT + '/mcp device=' + DEVICE_ID);
});
