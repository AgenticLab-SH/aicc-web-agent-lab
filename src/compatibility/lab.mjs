import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const REQUIRED_SEQUENCE = ['shadow', 'canary', 'default'];
const PRODUCTION_PORTS = new Set([17841, 10100, 4381, 9222, 9223, 9224, 9225, 9226]);

export class CompatibilityError extends Error {
  constructor(code, message) { super(message); this.name = 'CompatibilityError'; this.code = code; }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
  return value;
}

export function hashRecord(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function overlaps(left, right) { return inside(left, right) || inside(right, left); }

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new CompatibilityError('invalid_canary_path', `${label} must be absolute`);
  return path.resolve(value);
}

export function validateCanaryEnvironment(definition, options = {}) {
  const root = requireAbsolute(definition?.root, 'canary root');
  if (root === path.parse(root).root) throw new CompatibilityError('invalid_canary_path', 'canary root is too broad');
  const writable = ['stateRoot', 'databaseRoot', 'profileRoot', 'artifactRoot'].map(key => ({ key, value: requireAbsolute(definition?.[key], key) }));
  for (const item of writable) if (!inside(root, item.value)) throw new CompatibilityError('shared_canary_state', `${item.key} must stay inside the canary root`);
  const activeRoots = (options.activeRoots ?? []).map(value => path.resolve(value));
  for (const active of activeRoots) if (overlaps(root, active)) throw new CompatibilityError('shared_canary_state', 'canary root overlaps active writable state');
  const ports = Object.entries(definition?.ports ?? {});
  if (!ports.length) throw new CompatibilityError('invalid_canary_ports', 'canary ports are required');
  const seen = new Set();
  const productionPorts = new Set(options.productionPorts ?? PRODUCTION_PORTS);
  for (const [id, raw] of ports) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new CompatibilityError('invalid_canary_ports', `invalid canary port: ${id}`);
    if (seen.has(port) || productionPorts.has(port)) throw new CompatibilityError('shared_canary_port', `canary port is duplicated or production-owned: ${port}`);
    seen.add(port);
  }
  return {
    ok: true,
    root,
    writableRoots: writable.map(item => item.value),
    ports: Object.fromEntries(ports.map(([id, value]) => [id, Number(value)])),
    activeStateShared: false,
    productionPortShared: false
  };
}

function validateVersionRecord(record, label) {
  if (!record || typeof record.version !== 'string' || !record.version.trim()) throw new CompatibilityError('invalid_release_matrix', `${label}.version is required`);
}

export function loadReleaseMatrix({ root = DEFAULT_ROOT, file = path.join(root, 'compatibility', 'release-matrix.json') } = {}) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.schemaVersion !== 1 || typeof parsed.releaseId !== 'string' || !Array.isArray(parsed.components)) throw new CompatibilityError('invalid_release_matrix', 'release matrix schema is invalid');
  if (JSON.stringify(parsed.policy?.sequence) !== JSON.stringify(REQUIRED_SEQUENCE) || parsed.policy?.restartBudget !== 2 || parsed.policy?.automaticVersionApply !== false) {
    throw new CompatibilityError('invalid_release_matrix', 'release policy must be shadow-canary-default with restart budget two and no automatic version apply');
  }
  const ids = new Set();
  for (const component of parsed.components) {
    if (!component.id || ids.has(component.id)) throw new CompatibilityError('invalid_release_matrix', 'component IDs must be unique');
    ids.add(component.id);
    validateVersionRecord(component.current, `${component.id}.current`);
    validateVersionRecord(component.target, `${component.id}.target`);
    if (!Number.isInteger(component.contractVersion) || component.contractVersion < 1 || !component.rollback) throw new CompatibilityError('invalid_release_matrix', `component compatibility fields are incomplete: ${component.id}`);
  }
  if (!Array.isArray(parsed.requiredRegression) || !parsed.requiredRegression.length || !Array.isArray(parsed.requiredDirectRescue) || !parsed.requiredDirectRescue.length) {
    throw new CompatibilityError('invalid_release_matrix', 'required regression and direct rescue sets are missing');
  }
  return parsed;
}

function flatten(value, prefix = '', out = new Map()) {
  if (Array.isArray(value)) value.forEach((item, index) => flatten(item, `${prefix}/${index}`, out));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) flatten(item, `${prefix}/${key}`, out);
  else out.set(prefix || '/', value);
  return out;
}

export function diffSchemas(current, target) {
  const left = flatten(current);
  const right = flatten(target);
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const added = [], removed = [], changed = [];
  for (const item of paths) {
    if (!left.has(item)) added.push(item);
    else if (!right.has(item)) removed.push(item);
    else if (JSON.stringify(left.get(item)) !== JSON.stringify(right.get(item))) changed.push(item);
  }
  return { identical: added.length + removed.length + changed.length === 0, added, removed, changed, currentHash: hashRecord(current), targetHash: hashRecord(target) };
}

export function buildCompatibilityMatrix(matrix, { observedAt = new Date().toISOString(), evidenceRef = null, schemaDiffs = {} } = {}) {
  const components = matrix.components.map(component => {
    const diff = schemaDiffs[component.id] ?? diffSchemas(component.current, component.target);
    return {
      id: component.id,
      classification: component.classification,
      currentVersion: component.current.version,
      targetVersion: component.target.version,
      contractVersion: component.contractVersion,
      versionChanged: component.current.version !== component.target.version,
      schemaDiff: diff,
      compatibility: diff.removed.length ? 'blocked' : 'compatible',
      rollback: component.rollback
    };
  });
  return { schemaVersion: 1, releaseId: matrix.releaseId, observedAt, evidenceRef, components, hash: hashRecord(components) };
}

export function evaluateRegression(matrix, result) {
  const checks = new Map((result?.checks ?? []).map(item => [item.id, item]));
  const rescues = new Map((result?.directRescue ?? []).map(item => [item.id, item]));
  const missing = matrix.requiredRegression.filter(id => checks.get(id)?.status !== 'pass');
  const rescueFailures = matrix.requiredDirectRescue.filter(id => rescues.get(id)?.status !== 'pass');
  const incompatible = (result?.compatibility?.components ?? []).filter(item => item.compatibility !== 'compatible').map(item => item.id);
  return {
    ok: missing.length === 0 && rescueFailures.length === 0 && incompatible.length === 0,
    missing,
    rescueFailures,
    incompatible,
    activeReleaseMayChange: missing.length === 0 && rescueFailures.length === 0 && incompatible.length === 0
  };
}

export function verifyStartOnce(records) {
  const active = (records?.services ?? []).filter(item => item.active === true);
  const labels = new Set();
  const listeners = new Set();
  const duplicateLabels = [];
  const duplicateListeners = [];
  for (const service of active) {
    if (!service.label || !Number.isInteger(service.pid) || service.pid <= 0) throw new CompatibilityError('invalid_launch_record', 'active service record is incomplete');
    if (labels.has(service.label)) duplicateLabels.push(service.label); else labels.add(service.label);
    if (service.listener && listeners.has(service.listener)) duplicateListeners.push(service.listener); else if (service.listener) listeners.add(service.listener);
  }
  const restartLoop = active.filter(item => (item.restartCount ?? 0) > 2).map(item => item.label);
  const guiKeepAlive = active.filter(item => item.kind === 'gui' && item.keepAlive === true).map(item => item.label);
  const duplicateJobs = Number(records?.duplicateJobs ?? 0);
  return {
    ok: !duplicateLabels.length && !duplicateListeners.length && !restartLoop.length && !guiKeepAlive.length && duplicateJobs === 0,
    activeServiceCount: active.length,
    duplicateLabels,
    duplicateListeners,
    restartLoop,
    guiKeepAlive,
    duplicateJobs
  };
}

export const __testing = { stable, inside, overlaps, flatten, PRODUCTION_PORTS };
