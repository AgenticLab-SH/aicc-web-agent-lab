#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { collectStatus } from './status.mjs';
import { normalizeHealth } from './control-plane/registry.mjs';

export function recoveryPlan(routeId) {
  const profiles = {
    integrated: { provider: 'selected-adapter', identity: 'current-explicit-binding', mode: 'read-write', dependencies: ['router-17841'] },
    'web-gpt-direct': { provider: 'chatgpt-web', identity: 'explicit-web-gpt-binding', mode: 'read-only', dependencies: ['web-gpt-adapter', 'web-gpt-session-service'] },
    'ocx-direct': { provider: 'ocx', identity: 'explicit-ocx-binding', mode: 'read-only', dependencies: ['ocx-10100'] },
    'native-direct': { provider: 'codex-official', identity: 'native-codex-profile', mode: 'read-only', dependencies: ['codex-official'] }
  };
  if (!profiles[routeId]) throw new Error(`unknown route: ${routeId}`);
  return { routeId, ...profiles[routeId], silentFailover: false, writerLeaseRequiredForMutation: true };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === 'status') {
    const status = await collectStatus();
    return { schemaVersion: 1, generatedAt: status.generatedAt, components: status.components.map(normalizeHealth), summary: status.summary };
  }
  if (argv[0] === 'diagnose' && argv[1] === '--via' && argv[2]) return recoveryPlan(argv[2]);
  throw new Error('usage: control-plane-cli status | diagnose --via <integrated|web-gpt-direct|ocx-direct|native-direct>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
}
