import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserRegistryError, liveCdpSlotInventory, registeredCdpSlots, sanitizedCdpInventory } from '../src/browser/registry.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-browser-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const one = path.join(root, 'one'); const two = path.join(root, 'two');
  fs.mkdirSync(one); fs.mkdirSync(two);
  const launchOne = path.join(root, 'one.cmd'); const launchTwo = path.join(root, 'two.cmd');
  fs.writeFileSync(launchOne, '@echo off'); fs.writeFileSync(launchTwo, '@echo off');
  const coordinationPath = path.join(root, 'coordination.toml');
  fs.writeFileSync(coordinationPath, `[browser]\ncdp_slot_count = 2\ncdp_slot1_port = 19222\ncdp_slot1_profile_dir = "${one.replaceAll('\\','/')}"\ncdp_slot1_profile_directory = "Default"\ncdp_slot1_launcher = "${launchOne.replaceAll('\\','/')}"\ncdp_slot1_account_alias = "account-a"\ncdp_slot1_workspace = "workspace-a"\ncdp_slot1_usage = "agent_authenticated_shared"\ncdp_slot2_port = 19223\ncdp_slot2_profile_dir = "${two.replaceAll('\\','/')}"\ncdp_slot2_profile_directory = "Default"\ncdp_slot2_launcher = "${launchTwo.replaceAll('\\','/')}"\ncdp_slot2_account_alias = "account-b"\ncdp_slot2_workspace = "workspace-b"\ncdp_slot2_usage = "manual_login_pending"\n`);
  const runner = () => ({ status: 0, stdout: JSON.stringify({ ok: true, slots: [
    { port: 19222, status: 'available', active_count: 0, capacity: 3 },
    { port: 19223, status: 'shared', active_count: 1, capacity: 3 }
  ] }), stderr: '' });
  return { root, coordinationPath, runner };
}

test('registered slots preserve exact private bindings but sanitized inventory exposes no account labels', t => {
  const f = fixture(t);
  const slots = registeredCdpSlots({ stateRoot: f.root, coordinationPath: f.coordinationPath });
  assert.equal(slots[0].accountAlias, 'account-a');
  assert.equal(slots[1].automaticLeaseEligible, false);
  const safe = sanitizedCdpInventory({ stateRoot: f.root, coordinationPath: f.coordinationPath, runner: f.runner, script: 'fixture.ps1' });
  assert.equal(safe[0].poolEligible, true);
  assert.equal(safe[1].poolEligible, false);
  assert.equal(JSON.stringify(safe).includes('account-a'), false);
});

test('live inventory treats any external helper lease as busy for exclusive AICC Browser Pool allocation', t => {
  const f = fixture(t);
  const inventory = liveCdpSlotInventory({ stateRoot: f.root, coordinationPath: f.coordinationPath, runner: f.runner, script: 'fixture.ps1' });
  assert.equal(inventory[0].externallyBusy, false);
  assert.equal(inventory[1].externallyBusy, true);
});

test('duplicate CDP ports fail closed', t => {
  const f = fixture(t);
  const text = fs.readFileSync(f.coordinationPath, 'utf8').replace('cdp_slot2_port = 19223', 'cdp_slot2_port = 19222');
  fs.writeFileSync(f.coordinationPath, text);
  assert.throws(() => registeredCdpSlots({ stateRoot: f.root, coordinationPath: f.coordinationPath }), error => error instanceof BrowserRegistryError && error.code === 'duplicate_cdp_slot');
});

test('policy-excluded slots may be absent from helper status without becoming an observation failure', t => {
  const f = fixture(t);
  const runner = () => ({ status: 0, stdout: JSON.stringify({
    ok: true, slots: [{ port: 19222, status: 'available', active_count: 0, capacity: 3 }]
  }), stderr: '' });
  const inventory = liveCdpSlotInventory({ stateRoot: f.root, coordinationPath: f.coordinationPath, runner, script: 'fixture.ps1' });
  assert.equal(inventory[1].helperStatus, 'excluded-by-policy');
  assert.equal(inventory[1].poolEligible, false);
});
