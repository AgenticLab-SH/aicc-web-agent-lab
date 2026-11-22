import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated browser only. Pairing secrets live only in this process and the official GUI memory.
const playwrightModule = process.argv[2];
const openOnly = process.argv.includes('--open');
const progressFlag = process.argv.indexOf('--progress');
const progressPath = progressFlag >= 0 ? process.argv[progressFlag + 1] : null;
if (progressPath && (!path.isAbsolute(progressPath) || fs.existsSync(progressPath))) throw new Error('Fresh progress path required');
const progress = phase => { if (progressPath) fs.appendFileSync(progressPath, JSON.stringify({ phase, at: new Date().toISOString() }) + '\n'); };
if (!playwrightModule || !path.isAbsolute(playwrightModule)) throw new Error('Absolute Playwright package required');
const { chromium } = createRequire(playwrightModule)('playwright');
const nativePath = path.join(os.homedir(), '.codex/config.toml');
const before = fs.readFileSync(nativePath);
const browser = await chromium.launch({ channel: 'chrome', headless: !openOnly });
progress('browser_launched');
const receipt = { origin: 'http://localhost:10100', userProfilesTouched: 0, secretsPersisted: false };
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(receipt.origin);
  progress('origin_loaded');
  await page.getByText('ocx gui pair', { exact: false }).waitFor({ timeout: 15000 });
  receipt.freshBrowserRequiresPairing = true;
  progress('pairing_required');
  const command = '/demo/owner/.local/bin/oracle-a1-connection exec -- env OPENCODEX_HOME=/demo/owner/.opencodex-hub CODEX_HOME=/demo/owner/.opencodex-hub/codex-runtime /demo/owner/.local/opt/bun-1.4.0/bun-linux-aarch64/bun /demo/owner/.bun/install/global/node_modules/@bitkyc08/opencodex/src/cli/index.ts gui pair --origin http://localhost:10100 --json';
  const paired = spawnSync('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'skct-relay-micro', command], { encoding: 'utf8', timeout: 45000, windowsHide: true });
  if (paired.status !== 0) throw new Error('Official hub pairing command failed; no secret output forwarded');
  let grant;
  try { grant = JSON.parse(paired.stdout); } catch { throw new Error('Invalid official pairing result'); }
  const code = grant.grant ?? grant.code ?? grant.pairingCode;
  if (typeof code !== 'string' || code.length < 8 || code.length > 512) throw new Error('Official pairing code missing');
  await page.getByRole('textbox').fill(code);
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByText('ocx gui pair', { exact: false }).waitFor({ state: 'hidden', timeout: 25000 });
  grant = null;
  paired.stdout = '';
  receipt.pairingAccepted = true;
  progress('pairing_accepted');
  await page.getByRole('button', { name: 'Codex 설정', exact: true }).click();
  await page.waitForTimeout(2500);
  // The official GUI wraps window.fetch with both machine and hub session auth.
  // Use that wrapper without extracting its tokens or changing the auth boundary.
  const request = (suffix, options) => page.evaluate(async ({ suffix, options }) => {
    const response = await window.fetch('/api/machine/hub-relay' + suffix, options);
    return { status: response.status, ok: response.ok, body: response.ok ? await response.json() : null };
  }, { suffix, options });
  const activeResponse = await request('/api/codex-auth/active');
  progress('policy_response');
  receipt.policyReadStatus = activeResponse.status;
  if (!activeResponse.ok) throw new Error('Active policy unavailable');
  const active = activeResponse.body;
  if (openOnly) {
    const policyResult = spawnSync('pwsh', ['-NoProfile', '-File', path.join(import.meta.dirname, 'Invoke-AiccOcxWindowPolicy.ps1'), '-Action', 'status'], {encoding:'utf8',timeout:45000,windowsHide:true});
    let policy;
    try { policy=JSON.parse(policyResult.stdout); } catch { policy=null; }
    if(policyResult.status===0 && policy?.terminal==='PASS' && policy.enabled===true) {
      receipt.windowPolicy={version:policy.version,fiveHourUsedThreshold:policy.fiveHourUsedThreshold,weeklyUsedThreshold:policy.weeklyUsedThreshold};
      await page.evaluate(({version,short,long})=>{
        const notice=document.createElement('div');notice.id='aicc-window-policy-status';notice.setAttribute('role','status');
        notice.textContent=`A1 서버 ${version} · 자동 전환: 5시간 ${short}% 사용 / 주간 ${long}% 사용 (${100-long}% 남음). 아래 단일 임계값은 95로 유지하세요. 업데이트는 aicc-ocx-update를 사용하세요.`;
        notice.style.cssText='position:sticky;top:0;z-index:100;padding:12px 20px;background:#163a30;color:white;border-bottom:1px solid #558b73;font-size:14px';
        document.body.prepend(notice);
      },{version:policy.version,short:policy.fiveHourUsedThreshold,long:policy.weeklyUsedThreshold});
    }
    const cards = await page.locator('body').evaluate(e => /메인 계정|계정 풀|Codex 인증/.test(e.innerText));
    if (!cards || !before.equals(fs.readFileSync(nativePath))) throw new Error('Dashboard read postcondition failed');
    const visibleReceipt = { ...receipt, terminal: 'PASS_PAIRED_VISIBLE_DASHBOARD', accountCardsVisible: cards, nativeConfigUnchanged: true, origin: receipt.origin + '/#codex-set', userProfilesTouched: 0, secretsPersisted: false, policyChanged: false };
    const receiptFlag = process.argv.indexOf('--receipt');
    if (receiptFlag >= 0) {
      const target = process.argv[receiptFlag + 1];
      if (!target || !path.isAbsolute(target) || fs.existsSync(target)) throw new Error('Fresh absolute receipt required');
      fs.writeFileSync(target, JSON.stringify(visibleReceipt) + '\n', { flag: 'wx' });
    }
    console.log(JSON.stringify(visibleReceipt));
    // A single owner-initiated session. No saved cookies, expiry bypass or automatic re-pair.
    await new Promise(resolve => browser.once('disconnected', resolve));
    process.exitCode = 0;
  } else {
  if (active.autoSwitchThreshold !== 95) throw new Error('Expected threshold preimage differs');
  // Idempotent save through the same official authenticated relay used by the GUI.
  // Never turn a canary into an operating policy or account change.
  const save = await request('/api/codex-auth/auto-switch', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threshold: 95 }) });
  receipt.policySaveStatus = save.status;
  const saved = save.body;
  const postPolicy = await request('/api/codex-auth/active');
  if (!save.ok || saved.ok !== true || !postPolicy.ok || postPolicy.body.autoSwitchThreshold !== 95 || postPolicy.body.activeCodexAccountId !== active.activeCodexAccountId || postPolicy.body.pinnedAccountId !== active.pinnedAccountId) throw new Error('Policy save postcondition failed');
  receipt.savedThreshold = postPolicy.body.autoSwitchThreshold;
  receipt.activeAccountAndPinUnchanged = true;
  const memoryResponse = await request('/api/system/memory');
  if (!memoryResponse.ok) throw new Error('Hub lifecycle unavailable');
  const memory = memoryResponse.body;
  receipt.hubLifecycle = { activeTurnCount: memory.activeTurnCount, isDraining: memory.isDraining };
  const checkResponse = await request('/api/update/check?tag=latest');
  if (!checkResponse.ok) throw new Error('Hub update check unavailable');
  const checked = checkResponse.body;
  receipt.hubUpdateCheck = Object.fromEntries(Object.entries(checked).filter(([key, value]) => /version|channel|available|update/i.test(key) && (typeof value === 'string' || typeof value === 'boolean')));
  receipt.updateButtonTarget = 'A1 hub via official management relay';
  const paths = new Set();
  let modelPayload;
  const pending = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === receipt.origin && /\/api\//.test(url.pathname)) {
      paths.add(`${url.pathname}:${response.status()}`);
      if (url.pathname.endsWith('/api/models') && response.status() === 200) pending.push(response.json().then(value => { modelPayload = value; }));
    }
  });
  await page.getByRole('button', { name: 'Codex 설정', exact: true }).click();
  await page.waitForTimeout(2500);
  receipt.accountCardsVisible = await page.locator('body').evaluate(e => /메인 계정|계정 풀|Codex 인증/.test(e.innerText));
  receipt.policyControls = await page.locator('input[type="number"]').evaluateAll(es => es.map(e => ({ value: e.value, label: e.getAttribute('aria-label'), title: e.title })));
  receipt.policyButtons = (await page.getByRole('button').allTextContents()).filter(value => /자동|사용량|전환|저장|적용/.test(value));
  await page.getByRole('button', { name: '모델', exact: true }).click();
  await page.waitForTimeout(2500);
  await Promise.all(pending);
  receipt.modelPageHeadings = await page.getByRole('heading').allTextContents();
  receipt.nativeModelIds = [...new Set(JSON.stringify(modelPayload ?? {}).match(/gpt-[a-z0-9.-]+/g) ?? [])].slice(0, 12);
  receipt.modelPageVisible = receipt.nativeModelIds.length > 0 && receipt.modelPageHeadings.some(value => /모델|Model/i.test(value));
  receipt.apiResponses = [...paths].sort();
  await page.reload();
  await page.getByText('ocx gui pair', { exact: false }).waitFor({ timeout: 15000 });
  receipt.reloadRequiresPairing = true;
  const fresh = await context.newPage();
  await fresh.goto(receipt.origin);
  await fresh.getByText('ocx gui pair', { exact: false }).waitFor({ timeout: 15000 });
  receipt.newTabRequiresPairing = true;
  receipt.nativeConfigUnchanged = before.equals(fs.readFileSync(nativePath));
  if (!receipt.accountCardsVisible || !receipt.modelPageVisible || !receipt.nativeConfigUnchanged) throw new Error('Dashboard postcondition failed');
  receipt.terminal = 'PASS_READ_AND_PAIRING';
  console.log(JSON.stringify(receipt));
  }
} catch (error) {
  console.log(JSON.stringify({ ...receipt, terminal: 'HOLD', failure: error instanceof Error && /^[A-Za-z0-9 ;.]+$/.test(error.message) ? error.message : 'dashboard_verification_failed' }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
