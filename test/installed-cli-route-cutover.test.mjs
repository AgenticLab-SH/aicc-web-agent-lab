import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInstalledCliRouteCutover } from '../tools/platform/aicc/run-installed-cli-route-cutover.mjs';

test('cutover runner times out as pre-dispatch HOLD without touching the entry', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-cutover-runner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'entry');
  const current = path.join(root, 'current');
  const candidate = path.join(root, 'candidate');
  const recovery = path.join(root, 'recovery.ps1');
  const wrapper = path.join(root, 'aicc.cmd');
  const receipt = path.join(root, 'receipt.json');
  fs.mkdirSync(current);
  fs.mkdirSync(candidate);
  fs.writeFileSync(recovery, 'exit 0\n');
  fs.writeFileSync(wrapper, 'wrapper\n');
  fs.symlinkSync(current, entry, process.platform === 'win32' ? 'junction' : 'dir');
  const execution = await runInstalledCliRouteCutover([
    '--state-root', path.join(root, 'state'),
    '--entry', entry,
    '--candidate', candidate,
    '--backup-root', path.join(root, 'backups'),
    '--receipt', receipt,
    '--recovery-script', recovery,
    '--wrapper', wrapper,
    '--wait-ms', '0'
  ], {
    inspectGate: () => ({ readOk: true, exactIdle: false, state: 'unknown', activeCount: 0, unknownCount: 1 })
  });
  assert.equal(execution.exitCode, 3);
  assert.equal(execution.receipt.reason, 'exact_idle_not_reached');
  assert.equal(path.resolve(fs.readlinkSync(entry)), current);
  assert.equal(JSON.parse(fs.readFileSync(receipt, 'utf8')).terminal, 'HOLD_PRE_DISPATCH');
});
