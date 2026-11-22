import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./ocx-compatibility-plan.test.ps1', import.meta.url));
test('offline OCX compatibility intake binds prepared evidence and refuses unsafe archives', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', fixture], {
    cwd: path.dirname(fixture), encoding: 'utf8', windowsHide: true, timeout: 60_000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.status, 'PASS');
  assert.equal(proof.checks, 11);
});
