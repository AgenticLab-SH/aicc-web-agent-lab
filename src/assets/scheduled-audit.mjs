import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssetControlService } from './service.mjs';

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function assetAuditTick({ service, stateRoot = process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center'), now = () => Date.now(), intervalMs = 6 * 60 * 60_000, force = false } = {}) {
  const file = path.join(stateRoot, 'asset-control', 'audit-state.json');
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (!force && previous?.nextAuditAt && Date.parse(previous.nextAuditAt) > now()) {
    return { skipped: true, reason: 'not_due', nextAuditAt: previous.nextAuditAt, externalWritePerformed: false };
  }
  const inventory = (service ?? createAssetControlService({ stateRoot })).inventory();
  const changed = previous?.fingerprint !== inventory.fingerprint;
  const result = {
    schemaVersion: 1,
    auditedAt: new Date(now()).toISOString(),
    nextAuditAt: new Date(now() + intervalMs).toISOString(),
    fingerprint: inventory.fingerprint,
    changed,
    summary: inventory.summary
  };
  atomicJson(file, result);
  return { ...result, skipped: false, externalWritePerformed: false };
}
