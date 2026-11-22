#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DEVICE_ID = process.env.AICC_REMOTE_DEVICE_ID || 'windows-primary';
const LOCAL_PORT = Number(process.env.AICC_REMOTE_LOCAL_PORT || 10311);
const STATE_ROOT = path.join(os.homedir(), '.ai-control-center', 'remote-gateway');
const WORKSPACE_CONFIG = process.env.AICC_REMOTE_WORKSPACE_CONFIG || path.join(STATE_ROOT, 'workspace-mcp', 'config.json');
const WORKSPACE_SERVER = process.env.AICC_REMOTE_WORKSPACE_SERVER || path.resolve('C:/demo/open-AICC/components/workspace-mcp/server.mjs');
const SSH_EXE = process.env.AICC_REMOTE_SSH_EXE || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'AICC-Tools', 'Git', 'usr', 'bin', 'ssh.exe');
const SSH_TARGET = process.env.AICC_REMOTE_SSH_TARGET || 'ubuntu@64.110.111.232';
const SSH_KEY = process.env.AICC_REMOTE_SSH_KEY || path.join(os.homedir(), '.ai-control-center', 'oracle-a1-access', 'id_rsa');
const SSH_KNOWN_HOSTS = process.env.AICC_REMOTE_SSH_KNOWN_HOSTS || path.join(os.homedir(), '.ai-control-center', 'oracle-a1-access', 'known_hosts');
const BASE_URL = 'http://127.0.0.1:' + LOCAL_PORT;
const LOCK_FILE = path.join(STATE_ROOT, 'agent.lock');
fs.mkdirSync(STATE_ROOT, { recursive: true });
try {
  const existing = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
  if (Number.isInteger(existing) && existing > 0) {
    try { process.kill(existing, 0); console.log('[remote-agent] already running pid=' + existing); process.exit(0); } catch {}
  }
} catch {}
try { fs.unlinkSync(LOCK_FILE); } catch {}
fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });

let sshChild = null;
let mcpClient = null;
let mcpTransport = null;
let stopping = false;

const headers = { 'content-type': 'application/json' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function startSshTunnel() {
  const args = [
    '-F', 'none', '-N', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + SSH_KNOWN_HOSTS,
    '-o', 'HostKeyAlias=aicc-oracle-a1', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-i', SSH_KEY, '-L', '127.0.0.1:' + LOCAL_PORT + ':127.0.0.1:' + LOCAL_PORT, SSH_TARGET
  ];
  sshChild = spawn(SSH_EXE, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  sshChild.stderr.setEncoding('utf8');
  sshChild.stderr.on('data', chunk => process.stderr.write('[remote-agent:ssh] ' + chunk));
  sshChild.once('exit', code => {
    if (!stopping) {
      console.error('[remote-agent] ssh tunnel exited code=' + code);
      setTimeout(startSshTunnel, 2000).unref?.();
    }
  });
}

async function waitForGateway() {
  for (;;) {
    try {
      const response = await fetch(BASE_URL + '/health');
      if (response.ok) return;
    } catch {}
    await sleep(500);
  }
}

async function connectWorkspaceMcp() {
  mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [WORKSPACE_SERVER, '--config', WORKSPACE_CONFIG],
    stderr: 'inherit'
  });
  mcpClient = new Client({ name: 'aicc-windows-remote-device', version: '0.1.0' });
  await mcpClient.connect(mcpTransport);
}

async function post(pathname, body) {
  return fetch(BASE_URL + pathname, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function sendResult(requestId, ok, result, error = null) {
  const response = await post('/device/result', {
    device_id: DEVICE_ID, request_id: requestId, ok, result: ok ? result : undefined, error: ok ? undefined : error
  });
  if (!response.ok) throw new Error('result delivery failed status=' + response.status);
}

async function pollLoop() {
  for (;;) {
    try {
      const response = await post('/device/poll', { device_id: DEVICE_ID });
      if (response.status === 204) {
        await sleep(750);
        continue;
      }
      if (!response.ok) throw new Error('poll failed status=' + response.status);
      const job = await response.json();
      try {
        const result = await mcpClient.callTool({ name: job.tool, arguments: job.arguments || {} });
        await sendResult(job.request_id, true, result);
      } catch (error) {
        await sendResult(job.request_id, false, null, error?.message || String(error));
      }
    } catch (error) {
      console.error('[remote-agent] poll error:', error?.message || error);
      await sleep(1500);
    }
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  try { await mcpClient?.close(); } catch {}
  try { sshChild?.kill(); } catch {}
  try { fs.unlinkSync(LOCK_FILE); } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startSshTunnel();
await waitForGateway();
await connectWorkspaceMcp();
console.log('[remote-agent] ready device=' + DEVICE_ID + ' gateway=' + BASE_URL);
await pollLoop();
