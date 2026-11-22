import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { CodexAppServerClient } from '../src/adapters/codex-app-server.mjs';
import { createCodexAppServerDaemonSpawn, validateOwnerOnlyUnixSocket } from '../src/adapters/codex-app-server-daemon.mjs';

const TASK_ID = '01a0061f-05c0-7dc0-bf14-f21440901a6b';
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function serverFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function consumeClientFrame(buffer) {
  if (buffer.length < 2) return null;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  assert.equal(masked, true);
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) payload[index] = buffer[offset + 4 + index] ^ mask[index % 4];
  const opcode = buffer[0] & 0x0f;
  return {
    opcode,
    message: opcode === 0x1 ? JSON.parse(payload.toString('utf8')) : null,
    remaining: buffer.subarray(offset + 4 + length)
  };
}

test('owner-only Unix WebSocket transport reaches one shared App Server daemon', { skip: process.platform === 'win32' }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-app-server-daemon-')));
  fs.chmodSync(root, 0o700);
  const socketPath = path.join(root, 'control.sock');
  const server = net.createServer();
  server.listen(socketPath);
  await once(server, 'listening');
  fs.chmodSync(socketPath, 0o600);
  t.after(async () => {
    server.close();
    await once(server, 'close');
    fs.rmSync(root, { recursive: true, force: true });
  });

  server.on('connection', socket => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const boundary = buffer.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const request = buffer.subarray(0, boundary).toString('latin1');
        const key = request.match(/Sec-WebSocket-Key:\s*([^\r\n]+)/i)?.[1]?.trim();
        assert.ok(key);
        const accept = crypto.createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buffer = buffer.subarray(boundary + 4);
        upgraded = true;
      }
      while (buffer.length) {
        const frame = consumeClientFrame(buffer);
        if (!frame) return;
        buffer = frame.remaining;
        if (frame.opcode !== 0x1) continue;
        if (frame.message.method === 'initialize') {
          socket.write(serverFrame({ id: frame.message.id, result: { userAgent: 'test-daemon/1', platformFamily: 'unix', platformOs: 'macos' } }));
        }
        if (frame.message.method === 'thread/read') {
          socket.write(serverFrame({
            id: frame.message.id,
            result: { thread: { id: TASK_ID, cwd: root, status: { type: 'idle' }, turns: [] } }
          }));
        }
      }
    });
  });

  assert.equal(validateOwnerOnlyUnixSocket(socketPath), socketPath);
  const client = new CodexAppServerClient({
    cwd: root,
    env: { AICC_CODEX_VERSION: '1' },
    manifest: { codexVersion: '1', productionStableAllowlist: ['initialize', 'thread/read'] },
    spawnProcess: createCodexAppServerDaemonSpawn({ socketPath }),
    timeoutMs: 5_000
  });
  try {
    const connected = await client.connect();
    assert.equal(connected.userAgent, 'test-daemon/1');
    const read = await client.threadRead({ threadId: TASK_ID, includeTurns: false });
    assert.equal(read.thread.id, TASK_ID);
    assert.equal(read.thread.status.type, 'idle');
  } finally {
    client.close();
  }
});

test('daemon transport rejects aliases, non-sockets and group-readable sockets', { skip: process.platform === 'win32' }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ws-sec-')));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const regular = path.join(root, 'regular');
  fs.writeFileSync(regular, 'not a socket\n', { mode: 0o600 });
  assert.throws(() => validateOwnerOnlyUnixSocket(regular), error => error.code === 'daemon_socket_unsafe');

  const socketPath = path.join(root, 'control.sock');
  const server = net.createServer();
  server.listen(socketPath);
  await once(server, 'listening');
  t.after(() => server.close());
  fs.chmodSync(socketPath, 0o660);
  assert.throws(() => validateOwnerOnlyUnixSocket(socketPath), error => error.code === 'daemon_socket_permissions_unsafe');
});
