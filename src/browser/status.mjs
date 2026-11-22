import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseBrowserSection(file) {
  const values = {};
  let section = '';
  for (const source of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = source.trim();
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) { section = heading[1]; continue; }
    if (section !== 'browser' || !line || line.startsWith('#')) continue;
    const quoted = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/.exec(line);
    const plain = /^([A-Za-z0-9_-]+)\s*=\s*([^\s#]+)/.exec(line);
    const match = quoted ?? plain;
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function activeExternalLeases(root, now) {
  let files = [];
  try {
    files = fs.readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.lease.json'))
      .map(entry => path.join(entry.parentPath ?? entry.path, entry.name));
  } catch { return 0; }
  let active = 0;
  for (const file of files) {
    try {
      const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.parse(lease.expires_at_utc) > now && !['releasing', 'cleanup_failed'].includes(lease.state)) active += 1;
    } catch { /* malformed lease is not reported ready */ }
  }
  return active;
}

export function browserBrokerStatus(options = {}) {
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center');
  const coordinationPath = options.coordinationPath ?? process.env.AICC_COORDINATION_FILE?.trim() ?? path.join(stateRoot, 'guidance', 'coordination.toml');
  if (!fs.existsSync(coordinationPath)) {
    return { id: 'browser-broker', label: '브라우저 세션 Broker', state: 'attention', detail: '브라우저 coordination 정본을 찾지 못했습니다.', configured: false };
  }
  let browser;
  try { browser = parseBrowserSection(coordinationPath); }
  catch { return { id: 'browser-broker', label: '브라우저 세션 Broker', state: 'attention', detail: '브라우저 coordination 정본을 읽지 못했습니다.', configured: false }; }
  const slotCount = Number(browser.cdp_slot_count ?? 0);
  const slots = [];
  const incomplete = [];
  for (let index = 1; index <= slotCount; index += 1) {
    const prefix = `cdp_slot${index}_`;
    const required = ['port', 'profile_dir', 'profile_directory', 'launcher', 'account_alias', 'workspace', 'usage'];
    const missing = required.filter(field => !browser[`${prefix}${field}`]);
    if (missing.length) incomplete.push(index);
    const usage = browser[`${prefix}usage`] ?? '';
    slots.push({
      index,
      port: Number(browser[`${prefix}port`] ?? 0),
      owner: 'aicc-cdp-target-lease-helper',
      tupleComplete: missing.length === 0,
      automaticLeaseEligible: !/pending|disabled|reserved/i.test(usage),
      pendingIdentity: /pending/i.test(usage),
      reservedAdministration: /telegram_admin|admin_reserved/i.test(usage),
      accountBound: Boolean(browser[`${prefix}account_alias`]),
      workspaceBound: Boolean(browser[`${prefix}workspace`])
    });
  }
  const qa = {
    role: 'isolated-qa',
    port: Number(browser.cdp_qa_port ?? 0),
    profileConfigured: Boolean(browser.cdp_qa_profile_dir),
    owner: 'aicc-stateless-qa',
    authentication: 'none-required'
  };
  const paths = [
    { role: 'in-app-browser', owner: 'current-outer-codex-browser-tool', configured: Boolean(browser.interactive_browser_role || browser.primary_access) },
    { role: 'web-gpt-partition', owner: 'webgpt-sessiond', configured: Boolean(browser.web_gpt_browser_policy || browser.web_gpt_new_chat_surface) },
    { role: 'registered-cdp', owner: 'aicc-cdp-target-lease-helper', configured: slots.length > 0 },
    { role: 'isolated-qa', owner: qa.owner, configured: qa.port > 0 && qa.profileConfigured }
  ];
  const active = activeExternalLeases(path.join(stateRoot, 'browser', 'cdp-target-leases'), options.now?.() ?? Date.now());
  const ready = incomplete.length === 0 && paths.every(item => item.configured);
  return {
    id: 'browser-broker',
    label: '브라우저 세션 Broker',
    state: ready ? 'ready' : 'attention',
    detail: ready
      ? `4개 경로 · 등록 CDP ${slotCount}개 · 활성 task target ${active}개`
      : `브라우저 identity tuple 또는 owner가 불완전합니다: ${incomplete.join(',') || 'path-policy'}`,
    configured: true,
    authority: 'deterministic-broker',
    paths,
    slots,
    isolatedQa: qa,
    activeTaskTargets: active,
    existingUserTabsEligible: false,
    rawLeaseCapabilitiesExposed: false
  };
}
