import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { workspaceMcpRuntimeClosureAudit } from '../components/workspace-mcp/runtime-integrity.mjs';
test('a new owner execution import must be declared before an installation can start', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-owner-closure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'components/workspace-mcp'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'server.mjs'), "import './windows-owner-environment.mjs';\n");
  fs.writeFileSync(path.join(folder, 'windows-owner-environment.mjs'), 'export const owner = true;\n');
  const server = 'components/workspace-mcp/server.mjs', owner = 'components/workspace-mcp/windows-owner-environment.mjs';
  const missing = workspaceMcpRuntimeClosureAudit(root, [server]); assert.equal(missing.ok, false); assert.deepEqual(missing.missing, [owner]);
  const accepted = workspaceMcpRuntimeClosureAudit(root, [server, owner]); assert.equal(accepted.ok, true);
  fs.writeFileSync(path.join(folder, 'windows-owner-environment.mjs'), "import './unexpected.mjs';\n");
  fs.writeFileSync(path.join(folder, 'unexpected.mjs'), 'export const foreign = true;\n');
  const expanded = workspaceMcpRuntimeClosureAudit(root, [server, owner]); assert.equal(expanded.ok, false); assert.deepEqual(expanded.missing, ['components/workspace-mcp/unexpected.mjs']);
});
