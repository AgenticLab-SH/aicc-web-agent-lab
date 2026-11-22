import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export class BrowserRegistryError extends Error {
  constructor(code, message) { super(message); this.name = 'BrowserRegistryError'; this.code = code; }
}

function parseSection(file, sectionName) {
  if (!fs.existsSync(file)) throw new BrowserRegistryError('coordination_missing', `coordination file not found: ${file}`);
  const values = {};
  let section = '';
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) { section = heading[1]; continue; }
    if (section !== sectionName || !line || line.startsWith('#')) continue;
    const quoted = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/.exec(line);
    const plain = /^([A-Za-z0-9_-]+)\s*=\s*([^\s#]+)/.exec(line);
    const match = quoted ?? plain;
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function normalizedPort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new BrowserRegistryError('invalid_cdp_slot', `${label} has an invalid port`);
  return port;
}

function nonempty(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new BrowserRegistryError('invalid_cdp_slot', `${label} is missing`);
  return text;
}

function slotFromConfig(browser, index) {
  const prefix = `cdp_slot${index}_`;
  const port = normalizedPort(browser[`${prefix}port`], `slot ${index}`);
  const profileRoot = nonempty(browser[`${prefix}profile_dir`], `slot ${index} profile root`);
  const profileDirectory = nonempty(browser[`${prefix}profile_directory`] ?? 'Default', `slot ${index} profile directory`);
  const launcher = nonempty(browser[`${prefix}launcher`], `slot ${index} launcher`);
  const accountAlias = nonempty(browser[`${prefix}account_alias`], `slot ${index} account alias`);
  const workspace = nonempty(browser[`${prefix}workspace`], `slot ${index} workspace`);
  const usage = nonempty(browser[`${prefix}usage`], `slot ${index} usage`);
  const automaticLeaseEligible = !/pending|disabled|reserved|telegram_admin|admin_reserved/i.test(usage);
  return Object.freeze({
    slotId: `cdp-${port}`,
    identityId: `registered-cdp-${port}`,
    port,
    cdpEndpoint: `http://127.0.0.1:${port}`,
    profileRoot,
    profileDirectory,
    launcher,
    accountAlias,
    workspace,
    usage,
    automaticLeaseEligible,
    automation: true
  });
}

export function registeredCdpSlots(options = {}) {
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center');
  const coordinationPath = options.coordinationPath ?? process.env.AICC_COORDINATION_FILE?.trim() ?? path.join(stateRoot, 'guidance', 'coordination.toml');
  const browser = parseSection(coordinationPath, 'browser');
  const count = Number(browser.cdp_slot_count ?? 0);
  if (!Number.isInteger(count) || count < 0 || count > 32) throw new BrowserRegistryError('invalid_cdp_slot_count', 'CDP slot count is invalid');
  const slots = [];
  const ports = new Set();
  const profiles = new Set();
  for (let index = 1; index <= count; index += 1) {
    const slot = slotFromConfig(browser, index);
    const profileKey = path.resolve(slot.profileRoot).toLowerCase();
    if (ports.has(slot.port) || profiles.has(profileKey)) throw new BrowserRegistryError('duplicate_cdp_slot', 'registered CDP ports and profile roots must be unique');
    ports.add(slot.port); profiles.add(profileKey); slots.push(slot);
  }
  return Object.freeze(slots);
}

function helperStatus(options = {}) {
  const executable = options.executable ?? 'pwsh';
  const script = options.script ?? path.resolve('tools', 'platform', 'web-automation', 'Manage-CdpChromeSlotLease.ps1');
  const args = ['-NoProfile', '-File', script, '-Action', 'Status', '-AsJson'];
  if (options.coordinationPath) args.push('-CoordinationPath', options.coordinationPath);
  if (options.stateRoot) args.push('-StateRoot', path.join(options.stateRoot, 'browser', 'cdp-target-leases'));
  const result = (options.runner ?? spawnSync)(executable, args, { encoding: 'utf8', timeout: 45_000, windowsHide: true, shell: false });
  if (result.error || result.status !== 0) throw new BrowserRegistryError('cdp_status_failed', result.error?.message || result.stderr?.trim() || 'CDP status helper failed');
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new BrowserRegistryError('cdp_status_invalid', 'CDP status helper did not return JSON'); }
  if (!parsed?.ok || !Array.isArray(parsed.slots)) throw new BrowserRegistryError('cdp_status_invalid', 'CDP status helper returned an invalid result');
  return parsed.slots;
}

export function liveCdpSlotInventory(options = {}) {
  const configured = registeredCdpSlots(options);
  const observed = new Map(helperStatus(options).map(item => [Number(item.port), item]));
  return configured.map(slot => {
    const status = observed.get(slot.port);
    if (!status && slot.automaticLeaseEligible) throw new BrowserRegistryError('cdp_slot_unobserved', `eligible CDP slot ${slot.port} was not returned by the lease helper`);
    if (!status) return Object.freeze({
      ...slot,
      helperStatus: 'excluded-by-policy',
      activeCount: 0,
      capacity: 0,
      externallyBusy: false,
      poolEligible: false
    });
    const activeCount = Number(status.active_count ?? 0);
    const capacity = Number(status.capacity ?? 0);
    return Object.freeze({
      ...slot,
      helperStatus: String(status.status ?? 'unknown'),
      activeCount,
      capacity,
      externallyBusy: activeCount > 0,
      poolEligible: slot.automaticLeaseEligible && activeCount === 0
    });
  });
}

export function sanitizedCdpInventory(options = {}) {
  return liveCdpSlotInventory(options).map(slot => ({
    slotId: slot.slotId,
    port: slot.port,
    usage: slot.usage,
    profileExists: fs.existsSync(slot.profileRoot),
    launcherExists: fs.existsSync(slot.launcher),
    automaticLeaseEligible: slot.automaticLeaseEligible,
    helperStatus: slot.helperStatus,
    activeCount: slot.activeCount,
    capacity: slot.capacity,
    poolEligible: slot.poolEligible,
    accountBound: Boolean(slot.accountAlias),
    workspaceBound: Boolean(slot.workspace)
  }));
}