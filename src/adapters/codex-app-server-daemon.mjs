import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export class CodexAppServerDaemonError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'CodexAppServerDaemonError';
    this.code = code;
  }
}

export function validateOwnerOnlyUnixSocket(socketPath) {
  if (!path.isAbsolute(socketPath) || /\p{Cc}/u.test(socketPath)) {
    throw new CodexAppServerDaemonError('daemon_socket_path_invalid');
  }
  const normalized = path.resolve(socketPath);
  const parent = path.dirname(normalized);
  if (fs.realpathSync(parent) !== parent) throw new CodexAppServerDaemonError('daemon_socket_parent_alias');
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new CodexAppServerDaemonError('daemon_socket_parent_unsafe');
  }
  const stat = fs.lstatSync(normalized);
  if (!stat.isSocket() || stat.isSymbolicLink()) throw new CodexAppServerDaemonError('daemon_socket_unsafe');
  if (process.platform !== 'win32') {
    if ((parentStat.mode & 0o077) !== 0 || (stat.mode & 0o077) !== 0) {
      throw new CodexAppServerDaemonError('daemon_socket_permissions_unsafe');
    }
    if (typeof process.getuid === 'function' && (parentStat.uid !== process.getuid() || stat.uid !== process.getuid())) {
      throw new CodexAppServerDaemonError('daemon_socket_owner_unsafe');
    }
  }
  return normalized;
}

function encodeClientFrame(opcode, payload, randomBytes) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let headerBytes = 2;
  if (body.length >= 126 && body.length <= 0xffff) headerBytes += 2;
  else if (body.length > 0xffff) headerBytes += 8;
  const frame = Buffer.allocUnsafe(headerBytes + 4 + body.length);
  frame[0] = 0x80 | opcode;
  let offset = 2;
  if (body.length < 126) frame[1] = 0x80 | body.length;
  else if (body.length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(body.length, 2);
    offset += 2;
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(body.length), 2);
    offset += 8;
  }
  const mask = randomBytes(4);
  mask.copy(frame, offset);
  offset += 4;
  for (let index = 0; index < body.length; index += 1) frame[offset + index] = body[index] ^ mask[index % 4];
  return frame;
}

function parseHeader(response) {
  const lines = response.split('\r\n');
  const status = lines.shift();
  const headers = new Map();
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return { status, headers };
}

export class CodexAppServerDaemonProcess extends EventEmitter {
  constructor({ socketPath, connect = net.createConnection, randomBytes = crypto.randomBytes, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
    super();
    this.socketPath = validateOwnerOnlyUnixSocket(socketPath);
    if (!Number.isInteger(maxMessageBytes) || maxMessageBytes < 1024) throw new CodexAppServerDaemonError('daemon_max_message_bytes_invalid');
    this.connectSocket = connect;
    this.randomBytes = randomBytes;
    this.maxMessageBytes = maxMessageBytes;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdinBuffer = '';
    this.pendingMessages = [];
    this.handshakeBuffer = Buffer.alloc(0);
    this.frameBuffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.opened = false;
    this.closed = false;
    this.killed = false;
    this.exitEmitted = false;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          this.#acceptJsonl(chunk);
          callback();
        } catch (error) {
          callback(error);
          this.#fail(error);
        }
      }
    });
    this.#open();
  }

  kill() {
    if (this.closed) return;
    this.killed = true;
    if (this.opened) {
      try { this.socket.write(encodeClientFrame(0x8, Buffer.alloc(0), this.randomBytes)); } catch { /* socket already closed */ }
    }
    this.socket?.destroy();
    this.#finish(0, 'SIGTERM');
  }

  #open() {
    const key = this.randomBytes(16).toString('base64');
    this.expectedAccept = crypto.createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
    this.socket = this.connectSocket({ path: this.socketPath });
    this.socket.once('connect', () => {
      this.socket.write([
        'GET /rpc HTTP/1.1',
        'Host: localhost',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        ''
      ].join('\r\n'));
    });
    this.socket.on('data', chunk => this.#receive(chunk));
    this.socket.once('error', error => this.#fail(new CodexAppServerDaemonError('daemon_socket_error', error.message)));
    this.socket.once('close', () => this.#finish(this.killed ? 0 : 1, this.killed ? 'SIGTERM' : null));
  }

  #acceptJsonl(chunk) {
    this.stdinBuffer += String(chunk);
    if (Buffer.byteLength(this.stdinBuffer, 'utf8') > this.maxMessageBytes) throw new CodexAppServerDaemonError('daemon_client_message_too_large');
    let newline;
    while ((newline = this.stdinBuffer.indexOf('\n')) >= 0) {
      const line = this.stdinBuffer.slice(0, newline);
      this.stdinBuffer = this.stdinBuffer.slice(newline + 1);
      if (line.endsWith('\r')) this.#queueMessage(line.slice(0, -1));
      else this.#queueMessage(line);
    }
  }

  #queueMessage(line) {
    if (!line) return;
    if (Buffer.byteLength(line, 'utf8') > this.maxMessageBytes) throw new CodexAppServerDaemonError('daemon_client_message_too_large');
    if (!this.opened) this.pendingMessages.push(line);
    else this.socket.write(encodeClientFrame(0x1, Buffer.from(line), this.randomBytes));
  }

  #receive(chunk) {
    if (!this.opened) {
      this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
      if (this.handshakeBuffer.length > 64 * 1024) return this.#fail(new CodexAppServerDaemonError('daemon_handshake_too_large'));
      const boundary = this.handshakeBuffer.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const response = this.handshakeBuffer.subarray(0, boundary).toString('latin1');
      const remaining = this.handshakeBuffer.subarray(boundary + 4);
      this.handshakeBuffer = Buffer.alloc(0);
      const { status, headers } = parseHeader(response);
      if (status !== 'HTTP/1.1 101 Switching Protocols'
        || headers.get('upgrade')?.toLowerCase() !== 'websocket'
        || !headers.get('connection')?.toLowerCase().split(',').map(value => value.trim()).includes('upgrade')
        || headers.get('sec-websocket-accept') !== this.expectedAccept) {
        return this.#fail(new CodexAppServerDaemonError('daemon_handshake_invalid'));
      }
      this.opened = true;
      for (const line of this.pendingMessages.splice(0)) this.#queueMessage(line);
      if (remaining.length) this.#receiveFrames(remaining);
      return;
    }
    this.#receiveFrames(chunk);
  }

  #receiveFrames(chunk) {
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
    while (this.frameBuffer.length >= 2) {
      const first = this.frameBuffer[0];
      const second = this.frameBuffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if ((first & 0x70) !== 0 || (second & 0x80) !== 0) return this.#fail(new CodexAppServerDaemonError('daemon_frame_invalid'));
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.frameBuffer.length < 4) return;
        length = this.frameBuffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.frameBuffer.length < 10) return;
        const large = this.frameBuffer.readBigUInt64BE(2);
        if (large > BigInt(this.maxMessageBytes)) return this.#fail(new CodexAppServerDaemonError('daemon_server_message_too_large'));
        length = Number(large);
        offset = 10;
      }
      if (length > this.maxMessageBytes || this.fragmentBytes + length > this.maxMessageBytes) {
        return this.#fail(new CodexAppServerDaemonError('daemon_server_message_too_large'));
      }
      if (this.frameBuffer.length < offset + length) return;
      const payload = this.frameBuffer.subarray(offset, offset + length);
      this.frameBuffer = this.frameBuffer.subarray(offset + length);
      if (opcode >= 0x8 && (!fin || length > 125)) return this.#fail(new CodexAppServerDaemonError('daemon_control_frame_invalid'));
      if (opcode === 0x8) {
        if (!this.closed) this.socket.write(encodeClientFrame(0x8, payload, this.randomBytes));
        this.socket.destroy();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(encodeClientFrame(0xA, payload, this.randomBytes));
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode === 0x2 || (opcode !== 0x0 && opcode !== 0x1)) return this.#fail(new CodexAppServerDaemonError('daemon_frame_opcode_unsupported'));
      if (opcode === 0x1 && this.fragments.length) return this.#fail(new CodexAppServerDaemonError('daemon_fragment_sequence_invalid'));
      if (opcode === 0x0 && !this.fragments.length) return this.#fail(new CodexAppServerDaemonError('daemon_fragment_sequence_invalid'));
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (fin) {
        const message = Buffer.concat(this.fragments, this.fragmentBytes);
        this.fragments = [];
        this.fragmentBytes = 0;
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(message); }
        catch { return this.#fail(new CodexAppServerDaemonError('daemon_server_message_invalid_utf8')); }
        this.stdout.write(`${text}\n`);
      }
    }
  }

  #fail(error) {
    if (this.closed) return;
    this.stderr.write(`${error.code}\n`);
    this.socket?.destroy();
    this.#finish(1, null);
  }

  #finish(code, signal) {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('exit', code, signal));
  }
}

export function createCodexAppServerDaemonSpawn(options) {
  return () => new CodexAppServerDaemonProcess(options);
}
