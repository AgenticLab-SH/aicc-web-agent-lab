import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('../scripts/capture_web_evidence.mjs', import.meta.url).pathname;

async function runNode(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('rejects local authentication on a remote source before browser launch', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-auth-remote-'));
  const scenario = path.join(temp, 'scenario.json');
  await fs.writeFile(scenario, JSON.stringify({
    title: 'remote auth rejection',
    claimState: 'unknown',
    steps: [
      { action: 'authenticateLocal', endpoint: '/login', usernameEnv: 'TEST_USER', passwordEnv: 'TEST_PASSWORD' },
      { action: 'capture', name: 'never' },
    ],
  }));
  const result = spawnSync(process.execPath, [script, '--url', 'https://example.com/', '--allow-remote', '--scenario', scenario, '--out', path.join(temp, 'out')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authenticateLocal is limited to local source URLs/);
});

test('authenticates an isolated local fixture without persisting credential values', async (context) => {
  const server = http.createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/login') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      if (parsed.username !== 'fixture-user' || parsed.password !== 'fixture-pass') {
        response.writeHead(401).end('denied');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=evidence; Path=/; SameSite=Strict' }).end('{"ok":true}');
      return;
    }
    const authenticated = String(request.headers.cookie || '').includes('session=evidence');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><main id="${authenticated ? 'authenticated' : 'locked'}">${authenticated ? 'Actual UI, test data' : 'Locked'}</main>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-auth-local-'));
  const scenario = path.join(temp, 'scenario.json');
  const out = path.join(temp, 'out');
  await fs.writeFile(scenario, JSON.stringify({
    title: 'local auth fixture',
    claimState: 'runtime_verified',
    viewport: { width: 640, height: 480 },
    steps: [
      { action: 'authenticateLocal', endpoint: '/login', usernameEnv: 'EVIDENCE_TEST_USER', passwordEnv: 'EVIDENCE_TEST_PASSWORD' },
      { action: 'waitFor', selector: '#authenticated' },
      { action: 'capture', name: 'authenticated', durationMs: 900 },
    ],
  }));
  const result = await runNode([
    script, '--url', `http://192.0.2.1:${address.port}/`, '--scenario', scenario, '--out', out,
  ], {
    env: { ...process.env, EVIDENCE_TEST_USER: 'fixture-user', EVIDENCE_TEST_PASSWORD: 'fixture-pass' },
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const raw = await fs.readFile(path.join(out, 'evidence.json'), 'utf8');
  assert.doesNotMatch(raw, /fixture-user|fixture-pass/);
  const evidence = JSON.parse(raw);
  assert.deepEqual(evidence.steps[0].credentialSource, {
    usernameEnv: 'EVIDENCE_TEST_USER',
    passwordEnv: 'EVIDENCE_TEST_PASSWORD',
    usernameField: 'username',
    passwordField: 'password',
    values: '[REDACTED]',
  });
  assert.equal(evidence.errors.length, 0);
  assert.equal(evidence.frames.length, 1);
});
