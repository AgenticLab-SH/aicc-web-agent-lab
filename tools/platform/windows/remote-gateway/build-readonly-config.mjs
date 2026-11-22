#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [basePath, outputPath] = process.argv.slice(2);
if (!basePath || !outputPath) {
  throw new Error('Usage: build-readonly-config.mjs BASE_JSON OUTPUT_JSON');
}

const raw = fs.readFileSync(basePath, 'utf8').replace(/^\uFEFF/, '');
const config = JSON.parse(raw);
config.surfaceProfile = 'personal-read-fetch';
config.transport = { ...(config.transport || {}), mode: 'local-stdio' };
config.permissions = {
  ...(config.permissions || {}),
  files: 'read-only',
  commands: false,
  network: false
};
const localIdentity = 'local_' + createHash('sha256').update('aicc-remote-gateway-windows-primary').digest('hex').slice(0, 24);
config.remoteAuthority = {
  ...(config.remoteAuthority || {}),
  identityBinding: localIdentity,
  authenticationOwner: 'codex-local-stdio',
  defaultMode: 'read-only',
  writePolicy: 'read-only'
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(config, null, 2), 'utf8');
console.log(JSON.stringify({
  ok: true,
  output: outputPath,
  surfaceProfile: config.surfaceProfile,
  workspaceCount: config.workspaces?.length || 0,
  transportMode: config.transport.mode,
  writePolicy: config.remoteAuthority.writePolicy
}));
