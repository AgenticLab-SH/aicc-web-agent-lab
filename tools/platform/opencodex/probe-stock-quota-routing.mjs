import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Run with Bun. Every owner-state read/write goes to a fresh, isolated fixture home.
const root = process.env.AICC_OCX_PACKAGE_ROOT ?? path.join(os.homedir(), '.bun/install/global/node_modules/@bitkyc08/opencodex');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ocx-quota-fixture-'));
process.env.OPENCODEX_HOME = path.join(temporary, 'ocx');
process.env.CODEX_HOME = path.join(temporary, 'codex');
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
globalThis.fetch = async () => { throw new Error('Network disabled in quota fixture'); };
const imported = async relative => import(pathToFileURL(path.join(root, relative)).href);
try {
  const { loadConfig, saveConfig } = await imported('src/config.ts');
  const { saveCodexAccountCredential } = await imported('src/codex/account-store.ts');
  const { setAccountQuotaFromParsed: storeQuota, clearAccountQuota } = await imported('src/codex/quota.ts');
  const strict = fs.existsSync(path.join(root, 'src/codex/routing/aicc-window-admission.ts'));
  const admission = strict ? await imported('src/codex/routing/aicc-window-admission.ts') : null;
  const setAccountQuotaFromParsed = (id, value) => { storeQuota(id, value); admission?.noteAiccAdmissionObservation(id, true, now); };
  const { computeCodexUsageScore } = await imported('src/codex/routing/cooldown-math.ts');
  const { applyQuotaAutoSwitch } = await imported('src/codex/routing/selection.ts');
  const { setAccountHealth, deleteAccountHealth } = await imported('src/codex/routing/health-store.ts');
  const config = loadConfig();
  const active = 'fixture-active', safe = 'fixture-safe';
  const now = Date.now();
  config.codexAccounts = [active, safe].map(id => ({ id, email: `${id}@example.invalid`, isMain: false, plan: 'plus' }));
  config.autoSwitchThreshold = 95;
  config.accountPoolStrategy = 'reset-first';
  config.activeCodexAccountId = active;
  config.pool = { ...config.pool, cacheAffinity: false };
  saveConfig(config);
  for (const id of [active, safe]) saveCodexAccountCredential(id, { accessToken: 'fixture-only', refreshToken: 'fixture-only', expiresAt: now + 3600000, chatgptAccountId: id });
  const checks = [];
  const check = (name, fn) => { fn(); checks.push(name); };
  const quota = percent => ({ weeklyPercent: percent, weeklyResetAt: (now + 86400000) / 1000, shortPercent: 0, shortObservedAt: now, shortResetAt: (now + 3600000) / 1000 });
  setAccountQuotaFromParsed(safe, quota(10));
  check('unknown-is-not-zero', () => assert.ok(computeCodexUsageScore(null) > 100));
  check('short-zero-is-not-long-window-evidence', () => assert.ok(computeCodexUsageScore({ shortPercent: 0 }) > 100));
  if (process.env.AICC_OCX_WINDOW_THRESHOLDS === '95,98') {
    setAccountQuotaFromParsed(active, { ...quota(97), shortPercent: 94 });
    check('weekly-97-and-short-94-retain-active', () => assert.equal(applyQuotaAutoSwitch(config, active, now, undefined, undefined, false), active));
    setAccountQuotaFromParsed(active, { ...quota(97), shortPercent: 95 });
    check('short-95-selects-lower-usage', () => assert.equal(applyQuotaAutoSwitch(config, active, now, undefined, undefined, false), safe));
    setAccountQuotaFromParsed(active, { ...quota(98), shortPercent: 0 });
    check('weekly-98-selects-lower-usage', () => assert.equal(applyQuotaAutoSwitch(config, active, now, undefined, undefined, false), safe));
    check('actual-exhaustion-is-still-100', () => {
      assert.equal(computeCodexUsageScore(quota(100)), 100);
      const credits={hasCredits:true,balance:100,observedAt:now};
      assert.equal(computeCodexUsageScore({...quota(100),credits},undefined,now,true),100);
      assert.equal(computeCodexUsageScore({shortPercent:100,shortObservedAt:now,shortResetAt:(now+3600000)/1000,credits},undefined,now,true),100);
    });
    check('unknown-stays-unknown-under-policy', () => assert.ok(computeCodexUsageScore(null) > 100));
  }
  setAccountQuotaFromParsed(active, quota(94));
  check('94-retains-active', () => assert.equal(applyQuotaAutoSwitch(config, active, now, undefined, undefined, false), active));
  setAccountQuotaFromParsed(active, quota(process.env.AICC_OCX_WINDOW_THRESHOLDS ? 98 : 95));
  check('95-selects-lower-usage', () => assert.equal(applyQuotaAutoSwitch(config, active, now, undefined, undefined, false), safe));
  setAccountHealth(safe, { cooldownUntil: now + 60000 });
  check('cooling-replacement-is-excluded', () => assert.equal(applyQuotaAutoSwitch(config, active, now, undefined, undefined, false), active));
  deleteAccountHealth(safe);
  config.codexAccountAutoSwitchThresholds = { [active]: 100 };
  check('account-override-respected', () => assert.equal(applyQuotaAutoSwitch(config, active, now, undefined, undefined, false), active));
  delete config.codexAccountAutoSwitchThresholds;
  config.activeCodexAccountPinned = active;
  check('pin-does-not-block-known-95-switch', () => assert.equal(applyQuotaAutoSwitch(config, active, now, undefined, undefined, false), safe));
  delete config.activeCodexAccountPinned;
  config.pausedCodexAccountIds = [safe];
  check('paused-replacement-is-excluded', () => assert.equal(applyQuotaAutoSwitch(config, active, now, undefined, undefined, false), active));
  delete config.pausedCodexAccountIds;
  clearAccountQuota(safe);
  check('unknown-replacement-is-not-lower-usage', () => assert.equal(applyQuotaAutoSwitch(config, active, now, undefined, undefined, false), active));
  setAccountQuotaFromParsed(safe, quota(10));
  clearAccountQuota(active);
  check('unknown-does-not-force-rotation', () => assert.equal(applyQuotaAutoSwitch(config, active, now, undefined, undefined, false), active));
  check('shared-active-not-committed', () => assert.equal(config.activeCodexAccountId, active));
  if (strict) {
    const { isCodexAccountSelectable, getEligiblePoolAccounts } = await imported('src/codex/routing/selection.ts');
    const { aiccQuotaAdmission, aiccAccountAdmission, noteAiccAdmissionObservation } = admission;
    setAccountQuotaFromParsed(active, { ...quota(97), shortPercent: 94 });
    check('strict-94-97-admitted', () => assert.equal(isCodexAccountSelectable(config, active, now), true));
    setAccountQuotaFromParsed(active, { ...quota(10), shortPercent: 95 });
    check('strict-95-not-selectable', () => assert.equal(isCodexAccountSelectable(config, active, now), false));
    check('strict-95-not-eligible-even-with-pin', () => { config.activeCodexAccountPinned=active; assert.ok(!getEligiblePoolAccounts(config, undefined, now).includes(active)); delete config.activeCodexAccountPinned; });
    setAccountQuotaFromParsed(active, { ...quota(98), shortPercent: 0 });
    check('strict-weekly-98-not-selectable', () => assert.equal(isCodexAccountSelectable(config, active, now), false));
    noteAiccAdmissionObservation(active, false);
    check('strict-refresh-failure-cannot-reuse-cache', () => assert.equal(aiccAccountAdmission(active, now).allowed, false));
    check('strict-stale-positive-proof-refused', () => assert.equal(aiccQuotaAdmission({...quota(10),updatedAt:now},now-60001,now).allowed,false));
    check('strict-partial-window-refused', () => assert.equal(aiccQuotaAdmission({shortPercent:0,updatedAt:now},now,now).allowed,false));
    check('strict-reset-is-retry-not-assumed-zero', () => assert.equal(aiccQuotaAdmission({...quota(98),weeklyResetAt:(now-1000)/1000,updatedAt:now},now,now).allowed,false));
  }
  console.log(JSON.stringify({ terminal: 'PASS_SIMULATION', softwareVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, checks, liveAccountsChanged: false, liveThresholdCrossing: false, networkDisabled: true }));
} finally {
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('aicc-ocx-quota-fixture-')) throw new Error('Fixture cleanup boundary failed');
  fs.rmSync(resolved, { recursive: true, force: true });
}
