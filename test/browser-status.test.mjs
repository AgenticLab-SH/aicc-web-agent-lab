import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { browserBrokerStatus } from '../src/browser/status.mjs';

function fixture(t, text) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-browser-status-'));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const coordinationPath = path.join(stateRoot, 'coordination.toml');
  fs.writeFileSync(coordinationPath, text, { mode: 0o600 });
  return { stateRoot, coordinationPath };
}

test('browser status reports four separately owned paths without account labels or lease tokens', t => {
  const { stateRoot, coordinationPath } = fixture(t, `[browser]
primary_access = "in-app"
interactive_browser_role = "in-app"
web_gpt_browser_policy = "partition"
cdp_slot_count = 3
cdp_slot1_port = 9222
cdp_slot1_profile_dir = "/fixture/one"
cdp_slot1_profile_directory = "Default"
cdp_slot1_launcher = "/fixture/one.app"
cdp_slot1_account_alias = "private-a"
cdp_slot1_workspace = "workspace-a"
cdp_slot1_usage = "agent_authenticated_shared"
cdp_slot2_port = 9224
cdp_slot2_profile_dir = "/fixture/two"
cdp_slot2_profile_directory = "Default"
cdp_slot2_launcher = "/fixture/two.app"
cdp_slot2_account_alias = "pending"
cdp_slot2_workspace = "pending"
cdp_slot2_usage = "manual_login_pending"
cdp_slot3_port = 9225
cdp_slot3_profile_dir = "/fixture/three"
cdp_slot3_profile_directory = "Default"
cdp_slot3_launcher = "/fixture/three.app"
cdp_slot3_account_alias = "private-c"
cdp_slot3_workspace = "workspace-c"
cdp_slot3_usage = "workflow_reserved"
cdp_qa_port = 9226
cdp_qa_profile_dir = "/fixture/qa"
`);
  const status = browserBrokerStatus({ stateRoot, coordinationPath, now: () => 1_700_000_000_000 });
  assert.equal(status.state, 'ready');
  assert.deepEqual(status.paths.map(item => item.role), ['in-app-browser', 'web-gpt-partition', 'registered-cdp', 'isolated-qa']);
  assert.equal(status.slots[1].pendingIdentity, true);
  assert.equal(status.slots[1].automaticLeaseEligible, false);
  assert.equal(status.slots[2].automaticLeaseEligible, false);
  assert.equal(status.existingUserTabsEligible, false);
  assert.equal(status.rawLeaseCapabilitiesExposed, false);
  assert.equal(JSON.stringify(status).includes('private-a'), false);
});

test('incomplete registered identity tuple fails closed', t => {
  const { stateRoot, coordinationPath } = fixture(t, `[browser]
primary_access = "in-app"
web_gpt_browser_policy = "partition"
cdp_slot_count = 1
cdp_slot1_port = 9222
cdp_qa_port = 9226
cdp_qa_profile_dir = "/fixture/qa"
`);
  const status = browserBrokerStatus({ stateRoot, coordinationPath });
  assert.equal(status.state, 'attention');
  assert.deepEqual(status.slots.map(item => item.tupleComplete), [false]);
});
