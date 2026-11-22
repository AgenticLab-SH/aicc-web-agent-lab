#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProjectServicesManifest } from '../../../src/project-services.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

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

function connections(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-t'], { encoding: 'utf8', timeout: 5_000 });
  if (result.error || (result.status !== 0 && String(result.stderr ?? '').trim())) throw new Error(`port ${port} 활성 연결을 확인할 수 없습니다.`);
  return new Set(String(result.stdout ?? '').split(/\s+/).filter(value => /^\d+$/.test(value))).size;
}

function ownerRoot() {
  return process.env.AICC_STATE_ROOT?.trim() || path.join(os.homedir(), '.ai-control-center');
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* best effort */ }
}

function allUnits(manifest) {
  return manifest.projects.flatMap(project => project.units.map(unit => ({ ...unit, projectId: project.id })));
}

function restore(backupDir, manifest, uid) {
  const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const state = JSON.parse(fs.readFileSync(path.join(backupDir, 'state.json'), 'utf8'));
  const units = allUnits(manifest);
  for (const unit of [...units].sort((a, b) => a.stopOrder - b.stopOrder)) {
    const target = path.join(launchAgents, `${unit.label}.plist`);
    if (jobState(unit.label, uid).loaded) spawnSync('launchctl', ['bootout', `gui/${uid}`, target], { encoding: 'utf8', timeout: 15_000 });
    fs.copyFileSync(path.join(backupDir, `${unit.label}.plist`), target);
  }
  for (const unit of [...units].sort((a, b) => a.startOrder - b.startOrder)) {
    const target = path.join(launchAgents, `${unit.label}.plist`);
    run('launchctl', ['bootstrap', `gui/${uid}`, target]);
    if (state.runningLabels.includes(unit.label) && !jobState(unit.label, uid).running) run('launchctl', ['kickstart', '-k', `gui/${uid}/${unit.label}`]);
  }
}

function apply(manifest, uid) {
  for (const project of manifest.projects) {
    const active = connections(project.listenPort);
    if (active > 0) throw new Error(`${project.label}에 활성 연결 ${active}개가 있어 정책을 바꾸지 않았습니다.`);
  }
  const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const units = allUnits(manifest);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupDir = path.join(ownerRoot(), 'backups', 'project-services', timestamp);
  privateDirectory(backupDir);
  const runningLabels = units.filter(unit => jobState(unit.label, uid).running).map(unit => unit.label);
  for (const unit of units) {
    const plist = path.join(launchAgents, `${unit.label}.plist`);
    if (!fs.existsSync(plist)) throw new Error(`LaunchAgent plist가 없습니다: ${unit.label}`);
    fs.copyFileSync(plist, path.join(backupDir, `${unit.label}.plist`));
    fs.chmodSync(path.join(backupDir, `${unit.label}.plist`), 0o600);
  }
  fs.writeFileSync(path.join(backupDir, 'state.json'), `${JSON.stringify({ schemaVersion: 1, runningLabels }, null, 2)}\n`, { mode: 0o600 });
  try {
    for (const unit of units) {
      const plist = path.join(launchAgents, `${unit.label}.plist`);
      run('plutil', ['-replace', 'RunAtLoad', '-bool', 'false', plist]);
      run('plutil', ['-replace', 'KeepAlive', '-bool', 'false', plist]);
    }
    for (const unit of [...units].sort((a, b) => a.stopOrder - b.stopOrder)) {
      const plist = path.join(launchAgents, `${unit.label}.plist`);
      if (jobState(unit.label, uid).loaded) run('launchctl', ['bootout', `gui/${uid}`, plist]);
    }
    for (const unit of [...units].sort((a, b) => a.startOrder - b.startOrder)) {
      const plist = path.join(launchAgents, `${unit.label}.plist`);
      run('launchctl', ['bootstrap', `gui/${uid}`, plist]);
      if (jobState(unit.label, uid).running) throw new Error(`${unit.label}이 온디맨드 전환 뒤에도 실행 중입니다.`);
    }
  } catch (error) {
    restore(backupDir, manifest, uid);
    throw new Error(`${error.message} 기존 LaunchAgent 상태를 복구했습니다.`);
  }
  return backupDir;
}

function main() {
  const args = process.argv.slice(2);
  const manifest = loadProjectServicesManifest();
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') throw new Error('macOS 사용자 LaunchAgent에서만 실행할 수 있습니다.');
  const uid = process.getuid();
  if (args[0] === '--rollback') {
    const backupDir = path.resolve(String(args[1] || ''));
    if (!backupDir.startsWith(path.join(ownerRoot(), 'backups', 'project-services') + path.sep)) throw new Error('등록된 project-services 백업 경로만 복구할 수 있습니다.');
    restore(backupDir, manifest, uid);
    console.log(JSON.stringify({ ok: true, action: 'rollback', backupDir }));
    return;
  }
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ ok: true, action: 'what-if', projects: manifest.projects.map(project => project.id), mutation: false }));
    return;
  }
  const backupDir = apply(manifest, uid);
  console.log(JSON.stringify({ ok: true, action: 'apply', mode: 'manual-on-demand', backupDir }));
}

try { main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
