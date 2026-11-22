import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runRegisteredWorkspaceCanary } from '../tools/platform/workspace-mcp/run-registered-workspace-canary.mjs';

function fixture(t, surfaceProfile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-registered-canary-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.aicc-recovery'));
  fs.writeFileSync(path.join(root, 'README.md'), '# canary\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    config: {
      schemaVersion: 2,
      surfaceProfile,
      defaultWorkspace: 'fixture',
      workspaces: [{ alias: 'fixture', label: 'Fixture', root }],
      permissions: surfaceProfile === 'personal-read-fetch'
        ? { files: 'read-only', commands: false, network: false, maxReadBytes: 1_048_576, maxOutputBytes: 262_144 }
        : { files: 'read-write', commands: true, network: false, maxReadBytes: 1_048_576, maxOutputBytes: 262_144 },
      remoteAuthority: surfaceProfile === 'personal-read-fetch'
        ? { identityBinding: 'remote_personal_canary', defaultMode: 'read-only', writePolicy: 'read-only' }
        : { identityBinding: 'remote_business_canary', defaultMode: 'write', writePolicy: 'owner-unrestricted' },
      skillRoots: []
    }
  };
}

test('Business registered workspace canary writes, reads, and rolls back one exact file', async t => {
  const value = fixture(t, 'business-full');
  const result = await runRegisteredWorkspaceCanary({ config: value.config, workspaceRoot: value.root, runtimeRoot: path.join(value.root, 'runtime'), runId: 'canary-business-0001' });
  assert.equal(result.ok, true);
  assert.equal(result.write, true);
  assert.equal(result.readback, true);
  assert.equal(result.rollback, 'pass');
  assert.equal(fs.readdirSync(path.join(value.root, '.aicc-recovery')).some(name => name.startsWith('workspace-canary-canary-business-0001')), false);
});

test('Personal registered workspace canary proves read-only schema and forged write denial', async t => {
  const value = fixture(t, 'personal-read-fetch');
  const result = await runRegisteredWorkspaceCanary({ config: value.config, workspaceRoot: value.root, runtimeRoot: path.join(value.root, 'runtime'), runId: 'canary-personal-0001' });
  assert.equal(result.ok, true);
  assert.equal(result.toolCount, 18);
  assert.equal(result.forgedWriteDenied, true);
  assert.equal(result.readback, true);
});
