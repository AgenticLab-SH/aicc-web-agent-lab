import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const projectServicesExampleManifest = path.join(root, 'guidance', 'project-services.example.json');

export function defaultProjectServicesManifest(options = {}) {
  const ownerRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center');
  const ownerManifest = path.join(ownerRoot, 'config', 'project-services.json');
  return fs.existsSync(ownerManifest) ? ownerManifest : projectServicesExampleManifest;
}

function syncCommand(executable, args, options = {}) {
  const result = (options.runSync ?? spawnSync)(executable, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 5_000,
    maxBuffer: 1024 * 1024
  });
  return {
    ok: !result?.error && result?.status === 0,
    stdout: String(result?.stdout ?? '').trim(),
    stderr: String(result?.stderr ?? '').trim()
  };
}

function plistValue(file, key, options = {}) {
  const result = syncCommand(options.plutilExecutable ?? 'plutil', ['-extract', key, 'raw', '-o', '-', file], options);
  return result.ok ? result.stdout : '';
}

function launchJob(label, options = {}) {
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  if (!Number.isInteger(uid)) return { loaded: false, running: false, pid: null };
  const result = syncCommand(options.launchctlExecutable ?? 'launchctl', ['print', `gui/${uid}/${label}`], options);
  if (!result.ok) return { loaded: false, running: false, pid: null };
  const pid = Number(/^\s*pid\s*=\s*(\d+)\s*$/m.exec(result.stdout)?.[1]);
  return { loaded: true, running: Number.isInteger(pid) && pid > 0, pid: Number.isInteger(pid) && pid > 0 ? pid : null };
}

function activeConnections(port, options = {}) {
  if (!Number.isInteger(port)) return null;
  const result = syncCommand(options.lsofExecutable ?? 'lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-t'], options);
  if (!result.ok && result.stderr && !/no such process/i.test(result.stderr)) return null;
  return new Set(result.stdout.split(/\s+/).filter(value => /^\d+$/.test(value))).size;
}

export function loadProjectServicesManifest(file = null) {
  const source = file ?? defaultProjectServicesManifest();
  const manifest = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.projects) || !Array.isArray(manifest.policy?.requiredCoreLabels)) {
    throw new Error('Unsupported project services manifest');
  }
  const seen = new Set();
  for (const project of manifest.projects) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(project.id) || !Array.isArray(project.units) || project.units.length === 0) {
      throw new Error('Invalid project service definition');
    }
    for (const unit of project.units) {
      if (!/^[A-Za-z0-9._-]+$/.test(unit.label) || seen.has(unit.label)) throw new Error('Invalid or duplicate project service label');
      seen.add(unit.label);
    }
  }
  return manifest;
}

export function projectServicesStatus(options = {}) {
  const manifest = options.manifest ?? loadProjectServicesManifest(options.manifestPath);
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      ok: true,
      schemaVersion: 1,
      supported: false,
      platform,
      detail: '프로젝트 LaunchAgent 수명주기는 macOS 전용이며 이 플랫폼에서는 실행하지 않습니다.',
      policy: manifest.policy,
      projects: manifest.projects.map(project => ({
        id: project.id,
        label: project.label,
        description: project.description,
        healthUrl: project.healthUrl,
        listenPort: project.listenPort,
        state: 'unavailable',
        runningCount: 0,
        unitCount: project.units.length,
        activeConnections: null,
        onDemandReady: false,
        units: []
      })),
      summary: { running: 0, stopped: 0, partial: 0, onDemandReady: 0 }
    };
  }
  const home = options.home ?? os.homedir();
  const launchAgentsRoot = options.launchAgentsRoot ?? path.join(home, 'Library', 'LaunchAgents');
  const projects = manifest.projects.map(project => {
    const units = project.units.map(unit => {
      const plistPath = path.join(launchAgentsRoot, `${unit.label}.plist`);
      const exists = fs.existsSync(plistPath);
      const job = exists ? launchJob(unit.label, options) : { loaded: false, running: false, pid: null };
      const runAtLoad = exists ? plistValue(plistPath, 'RunAtLoad', options) === 'true' : null;
      const keepAliveRaw = exists ? plistValue(plistPath, 'KeepAlive', options) : '';
      const keepAlive = keepAliveRaw === 'true' ? true : keepAliveRaw === 'false' || !keepAliveRaw ? false : 'conditional';
      return { ...unit, plistPath, exists, ...job, runAtLoad, keepAlive, onDemandReady: exists && runAtLoad === false && keepAlive === false };
    });
    const runningCount = units.filter(unit => unit.running).length;
    const state = runningCount === units.length ? 'running' : runningCount === 0 ? 'stopped' : 'partial';
    return {
      id: project.id,
      label: project.label,
      description: project.description,
      healthUrl: project.healthUrl,
      listenPort: project.listenPort,
      state,
      runningCount,
      unitCount: units.length,
      activeConnections: activeConnections(project.listenPort, options),
      onDemandReady: units.every(unit => unit.onDemandReady),
      units
    };
  });
  return {
    ok: true,
    schemaVersion: 1,
    policy: manifest.policy,
    projects,
    summary: {
      running: projects.filter(project => project.state === 'running').length,
      stopped: projects.filter(project => project.state === 'stopped').length,
      partial: projects.filter(project => project.state === 'partial').length,
      onDemandReady: projects.filter(project => project.onDemandReady).length
    }
  };
}

export function projectServicesSnapshot(status) {
  return {
    projects: (status?.projects ?? []).map(project => ({
      id: project.id,
      state: project.state,
      activeConnections: project.activeConnections,
      onDemandReady: project.onDemandReady,
      units: project.units.map(unit => ({ label: unit.label, loaded: unit.loaded, running: unit.running, onDemandReady: unit.onDemandReady }))
    }))
  };
}

export function selectProjectService(args, status, targetState) {
  if (status?.supported === false) throw new Error('프로젝트 서비스 수명주기는 macOS에서만 지원합니다.');
  const id = String(args?.id ?? '').trim();
  const project = status?.projects?.find(item => item.id === id);
  if (!project) throw new Error('관리할 프로젝트 서비스를 찾지 못했습니다.');
  if (!project.onDemandReady) throw new Error('프로젝트 LaunchAgent가 아직 온디맨드 정책으로 전환되지 않았습니다.');
  if (targetState === 'running' && project.state === 'running') throw new Error('프로젝트 서비스가 이미 실행 중입니다.');
  if (targetState === 'stopped' && project.state === 'stopped') throw new Error('프로젝트 서비스가 이미 중지되어 있습니다.');
  if (targetState === 'stopped' && project.activeConnections === null) throw new Error('활성 연결 수를 확인할 수 없어 프로젝트를 중지하지 않습니다.');
  if (targetState === 'stopped' && project.activeConnections > 0) throw new Error('현재 사이트 연결이 있어 프로젝트를 중지하지 않습니다.');
  return { id: project.id };
}
