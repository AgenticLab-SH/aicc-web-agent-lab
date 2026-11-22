import fs from 'node:fs';
import http from 'node:http';

const port = Number(process.argv[2]);
const readyFile = process.argv[3];
if (!Number.isInteger(port) || !readyFile) throw new Error('usage: compatibility-listener.mjs <port> <ready-file>');

const server = http.createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', pid: process.pid, port }));
    return;
  }
  response.writeHead(404);
  response.end();
});

server.on('error', error => {
  process.stderr.write(`${error.code ?? 'listener_error'}\n`);
  process.exitCode = 2;
});

server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(readyFile, `${JSON.stringify({ pid: process.pid, port, listener: `127.0.0.1:${port}` })}\n`, { flag: 'wx', mode: 0o600 });
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
