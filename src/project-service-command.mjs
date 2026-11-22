#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadProjectServicesManifest, projectServicesStatus } from './project-services.mjs';

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: options.timeoutMs ?? 15_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim().slice(0, 500);
    throw new Error(`${executable} ${args[0] || ''} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout ?? '').trim();
}

function jobState(label, uid) {
  const result = spawnSync('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0) return { loaded: false, running: false };
  return { loaded: true, running: /^\s*pid\s*=\s*\d+\s*$/m.test(String(result.stdout)) };
}

function activeConnections(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-t'], { encoding: 'utf8', timeout: 5_000 });
  if (result.error || (result.status !== 0 && String(result.stderr ?? '').trim())) throw new Error('활성 사이트 연결을 확인할 수 없습니다.');
  return new Set(String(result.stdout ?? '').split(/\s+/).filter(value => /^\d+$/.test(value))).size;
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(message);
}

async function healthReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000), cache: 'no-store' });
    return response.ok;
  } catch { return false; }
}

async function startProject(project, uid) {
  for (const unit of [...project.units].sort((a, b) => a.startOrder - b.startOrder)) {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${unit.label}.plist`);
    if (!fs.existsSync(plist)) throw new Error(`LaunchAgent plist가 없습니다: ${unit.label}`);
    if (!jobState(unit.label, uid).loaded) run('launchctl', ['bootstrap', `gui/${uid}`, plist]);
    if (!jobState(unit.label, uid).running) run('launchctl', ['kickstart', `gui/${uid}/${unit.label}`]);
    await waitFor(() => jobState(unit.label, uid).running, 10_000, `${unit.label} 기동을 확인하지 못했습니다.`);
    if (unit.role === 'app') await waitFor(() => healthReady(project.healthUrl), 20_000, `${project.label} health 확인에 실패했습니다.`);
  }
}

async function stopProject(project, uid) {
  const connections = activeConnections(project.listenPort);
  if (connections > 0) throw new Error(`활성 사이트 연결 ${connections}개가 있어 중지하지 않았습니다.`);
  for (const unit of [...project.units].sort((a, b) => a.stopOrder - b.stopOrder)) {
    const current = jobState(unit.label, uid);
    if (!current.loaded || !current.running) continue;
    run('launchctl', ['kill', 'SIGTERM', `gui/${uid}/${unit.label}`]);
    await waitFor(() => !jobState(unit.label, uid).running, 15_000, `${unit.label}이 정상 종료되지 않았습니다.`);
  }
}

async function main() {
  const [action, id] = process.argv.slice(2);
  if (!['start', 'stop'].includes(action) || !id) throw new Error('Usage: project-service-command.mjs <start|stop> <project-id>');
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') throw new Error('Project service lifecycle is available only on macOS.');
  const manifest = loadProjectServicesManifest();
  const project = manifest.projects.find(item => item.id === id);
  if (!project) throw new Error('허용되지 않은 프로젝트 서비스입니다.');
  const before = projectServicesStatus().projects.find(item => item.id === id);
  if (!before?.onDemandReady) throw new Error('온디맨드 LaunchAgent 정책이 준비되지 않았습니다.');
  const uid = process.getuid();
  await (action === 'start' ? startProject(project, uid) : stopProject(project, uid));
  const after = projectServicesStatus().projects.find(item => item.id === id);
  const expected = action === 'start' ? 'running' : 'stopped';
  if (after?.state !== expected) throw new Error(`요청한 상태를 확인하지 못했습니다: ${after?.state || 'unknown'}`);
  process.stdout.write(`${JSON.stringify({ ok: true, id, action, state: after.state })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
