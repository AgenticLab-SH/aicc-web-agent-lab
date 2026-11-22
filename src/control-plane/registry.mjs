import crypto from 'node:crypto';
import fs from 'node:fs';

export const HEALTH_FIELDS = ['installed', 'startup', 'live', 'ready', 'draining', 'degraded', 'quarantined', 'activeWork', 'version', 'sourceHash', 'lastVerifiedAt', 'attentionReasons'];

export function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function normalizeHealth(component = {}) {
  const state = component.state ?? 'unknown';
  const ready = component.ready ?? state === 'ready';
  return {
    id: component.id,
    installed: component.installed ?? state !== 'unavailable',
    startup: component.startup ?? (state === 'unavailable' ? 'not-started' : 'started'),
    live: component.live ?? component.healthy ?? !['unavailable', 'offline'].includes(state),
    ready,
    draining: component.draining ?? false,
    degraded: component.degraded ?? ['attention', 'degraded'].includes(state),
    quarantined: component.quarantined ?? false,
    activeWork: Number.isInteger(component.activeWork) ? component.activeWork : null,
    version: component.version ?? null,
    sourceHash: component.sourceHash ?? null,
    lastVerifiedAt: component.lastVerifiedAt ?? null,
    attentionReasons: component.attentionReasons ?? (ready ? [] : [component.detail ?? 'readiness unknown'])
  };
}

export function loadContractJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export class UnsupportedActionError extends Error {
  constructor(componentId, capability) {
    super(`${componentId} does not support ${capability}`);
    this.code = 'unsupported_action';
  }
}

export class ComponentRegistry {
  #components = new Map();

  register(definition, adapter) {
    if (!definition?.id || this.#components.has(definition.id)) throw new Error(`duplicate or missing component id: ${definition?.id}`);
    const capabilities = Object.fromEntries(['discover', 'status', 'plan', 'apply', 'verify', 'rollback', 'drain'].map(name => [name, typeof adapter?.[name] === 'function']));
    this.#components.set(definition.id, { definition: structuredClone(definition), adapter, capabilities });
    return this;
  }

  get(id) {
    const entry = this.#components.get(id);
    if (!entry) throw new Error(`unknown component: ${id}`);
    return entry;
  }

  requireCapability(id, capability) {
    const entry = this.get(id);
    if (!entry.capabilities[capability]) throw new UnsupportedActionError(id, capability);
    return entry.adapter[capability].bind(entry.adapter);
  }

  list() {
    return [...this.#components.entries()].map(([id, entry]) => ({ id, ...entry.definition, capabilities: entry.capabilities }));
  }

  async status() {
    return Promise.all(this.list().map(async ({ id }) => {
      const entry = this.get(id);
      try { return normalizeHealth({ id, ...(await this.requireCapability(id, 'status')()) }); }
      catch (error) { return normalizeHealth({ id, installed: null, live: false, ready: false, degraded: true, attentionReasons: [error.code ?? 'status_failed'] }); }
    }));
  }
}
