import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../lib/command.mjs';

const allowedFeatures = new Set(['apps', 'remote_plugin', 'recommended_plugins']);

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function privatePolicyStatus(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return { exists: true, ok: false, reason: 'policy file must not be a symlink' };
    if (!stat.isFile()) return { exists: true, ok: false, reason: 'policy path must be a file' };
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) return { exists: true, ok: false, reason: 'policy file must be owner-only (0600)' };
    return { exists: true, ok: true, reason: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, ok: false, reason: 'policy file is missing' };
    throw error;
  }
}

function featureValues(config) {
  const values = {};
  let inFeatures = false;
  for (const source of String(config).split(/\r?\n/)) {
    const line = source.trim();
    if (line.startsWith('[')) {
      inFeatures = line === '[features]';
      continue;
    }
    if (!inFeatures) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(true|false)\s*(?:#.*)?$/.exec(line);
    if (match) values[match[1]] = match[2] === 'true';
  }
  return values;
}

export function parseCodexCapabilityPolicy(text) {
  const value = JSON.parse(text);
  if (value?.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  if (!Array.isArray(value.requiredPlugins) || value.requiredPlugins.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9-]*$/.test(id))) {
    throw new Error('requiredPlugins must contain qualified plugin IDs');
  }
  if (!value.features || typeof value.features !== 'object' || Array.isArray(value.features)) throw new Error('features must be an object');
  for (const [key, expected] of Object.entries(value.features)) {
    if (!allowedFeatures.has(key) || typeof expected !== 'boolean') throw new Error(`unsupported feature policy: ${key}`);
  }
  const extraPluginPolicy = value.extraPluginPolicy ?? 'report';
  if (!['report', 'forbid'].includes(extraPluginPolicy)) throw new Error('extraPluginPolicy must be report or forbid');
  return {
    schemaVersion: 1,
    requiredPlugins: [...new Set(value.requiredPlugins)].sort(),
    extraPluginPolicy,
    features: Object.fromEntries(Object.entries(value.features).sort(([left], [right]) => left.localeCompare(right)))
  };
}

export function parseCodexPluginList(text) {
  const value = JSON.parse(text);
  if (!Array.isArray(value?.installed)) throw new Error('Codex plugin list is missing installed entries');
  return new Map(value.installed.map(item => [item.pluginId, {
    id: item.pluginId,
    installed: item.installed === true,
    enabled: item.enabled === true,
    version: typeof item.version === 'string' ? item.version : null
  }]));
}

export async function codexPluginStatus(options = {}) {
  const home = path.resolve(options.home ?? os.homedir());
  const stateRoot = path.resolve(options.stateRoot ?? (process.env.AICC_STATE_ROOT?.trim() || path.join(home, '.ai-control-center')));
  const policyFile = path.resolve(options.policyFile ?? (process.env.AICC_CODEX_CAPABILITY_POLICY?.trim() || path.join(stateRoot, 'config', 'codex-capabilities.json')));
  const configFile = path.resolve(options.configFile ?? path.join(home, '.codex', 'config.toml'));
  const policySecurity = privatePolicyStatus(policyFile);
  if (!policySecurity.exists) {
    return {
      id: 'codex-plugins', label: 'Codex 필수 Plugin', state: 'unavailable', optional: true,
      detail: 'owner-local capability 정책이 없어 필수 plugin을 강제하지 않습니다.', policyFile
    };
  }
  if (!policySecurity.ok) {
    return {
      id: 'codex-plugins', label: 'Codex 필수 Plugin', state: 'attention', optional: false,
      detail: `capability 정책 보안 검사가 실패했습니다: ${policySecurity.reason}`, policyFile
    };
  }
  const rawPolicy = read(policyFile);

  let policy;
  try { policy = parseCodexCapabilityPolicy(rawPolicy); }
  catch (error) {
    return {
      id: 'codex-plugins', label: 'Codex 필수 Plugin', state: 'attention', optional: false,
      detail: `capability 정책을 읽을 수 없습니다: ${error.message}`, policyFile
    };
  }

  const rawConfig = read(configFile);
  if (rawConfig === null) {
    return {
      id: 'codex-plugins', label: 'Codex 필수 Plugin', state: 'attention', optional: false,
      detail: 'Codex config.toml을 찾지 못했습니다.', policyFile, configFile
    };
  }

  const result = await (options.runCommand ?? runCommand)(options.executable ?? 'codex', ['plugin', 'list', '--json'], {
    timeoutMs: options.timeoutMs ?? 8_000,
    maxBytes: 512_000,
    env: options.env ?? process.env
  });
  if (!result.ok) {
    return {
      id: 'codex-plugins', label: 'Codex 필수 Plugin', state: 'attention', optional: false,
      detail: 'Codex plugin 상태를 읽지 못했습니다.', policyFile, configFile
    };
  }

  let installed;
  try { installed = parseCodexPluginList(result.stdout); }
  catch (error) {
    return {
      id: 'codex-plugins', label: 'Codex 필수 Plugin', state: 'attention', optional: false,
      detail: `Codex plugin 응답을 읽을 수 없습니다: ${error.message}`, policyFile, configFile
    };
  }

  const plugins = policy.requiredPlugins.map(id => installed.get(id) ?? { id, installed: false, enabled: false, version: null });
  const installedPlugins = [...installed.values()].sort((left, right) => left.id.localeCompare(right.id));
  const enabledPlugins = installedPlugins.filter(plugin => plugin.installed && plugin.enabled);
  const extraPlugins = enabledPlugins.filter(plugin => !policy.requiredPlugins.includes(plugin.id));
  const disabledPlugins = installedPlugins.filter(plugin => plugin.installed && !plugin.enabled);
  const features = featureValues(rawConfig);
  const featureDrift = Object.entries(policy.features)
    .filter(([key, expected]) => features[key] !== expected)
    .map(([key, expected]) => ({ key, expected, actual: features[key] ?? null }));
  const pluginDrift = plugins.filter(plugin => !plugin.installed || !plugin.enabled);
  const extraPluginDrift = policy.extraPluginPolicy === 'forbid' ? extraPlugins : [];
  const ready = pluginDrift.length === 0 && featureDrift.length === 0 && extraPluginDrift.length === 0;
  return {
    id: 'codex-plugins', label: 'Codex 필수 Plugin', state: ready ? 'ready' : 'attention', optional: false,
    detail: ready
      ? `필수 plugin ${plugins.length}개 활성 · 추가 활성 ${extraPlugins.length}개 보고 · feature 정책 일치 · 계정 연결 미검사`
      : `plugin/feature drift ${pluginDrift.length + featureDrift.length + extraPluginDrift.length}건 · 추가 활성 ${extraPlugins.length}개 · 계정 연결 미검사`,
    policyFile,
    policySecurity: 'owner-only',
    configFile,
    plugins,
    installedPluginCount: installedPlugins.filter(plugin => plugin.installed).length,
    enabledPluginCount: enabledPlugins.length,
    extraPluginPolicy: policy.extraPluginPolicy,
    extraPlugins,
    extraPluginDrift: extraPluginDrift.map(plugin => plugin.id),
    disabledPlugins,
    features: Object.fromEntries(Object.keys(policy.features).map(key => [key, features[key] ?? null])),
    pluginDrift: pluginDrift.map(plugin => plugin.id),
    featureDrift,
    accountConnection: 'not_observed',
    readinessScope: ['required-plugin-installation', 'required-plugin-enabled', 'configured-features']
  };
}
