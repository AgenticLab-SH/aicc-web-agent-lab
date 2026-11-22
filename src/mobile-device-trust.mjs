import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ensureWindowsOwnerOnlyDirectory } from './lib/windows-owner-only-acl.mjs';

const TOKEN = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
export function createMobileDeviceTrust(owner, origin) {
  const home = path.join(owner, 'control-plane', 'mobile-devices');
  const directory = path.join(home, hash(origin));
  for (let p = directory;; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail('linked_owner_path');
    if (p === path.dirname(p)) break;
  }
  ensureWindowsOwnerOnlyDirectory(home);
  ensureWindowsOwnerOnlyDirectory(directory);
  function names() { const result = fs.readdirSync(directory).filter(n => /^[a-f0-9]{64}\.json$/.test(n)); if (result.length > 4096) fail('device_store_limit'); return result; }
  function read(name) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) fail('device_store_invalid');
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (row.schemaVersion !== 1 || row.origin !== origin || !UUID.test(row.id ?? '') || row.tokenHash + '.json' !== name || !TOKEN.test(row.tokenHash ?? '') || typeof row.label !== 'string') fail('device_store_invalid');
    return row;
  }
  function save(row, exclusive = false) {
    const file = path.join(directory, row.tokenHash + '.json');
    if (exclusive) { fs.writeFileSync(file, JSON.stringify(row) + '\n', { flag: 'wx', mode: 0o600 }); return; }
    const temporary = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(row) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  function all() { return names().map(read); }
  function revoke(row) { if (!row.revokedAt) { row.revokedAt = new Date().toISOString(); save(row); } }
  return {
    issue(secret, label) {
      if (!TOKEN.test(secret)) fail('device_token_invalid');
      if (all().filter(r => !r.revokedAt).length >= 64) fail('device_limit');
      const row = { schemaVersion: 1, id: randomUUID(), tokenHash: hash(secret), origin, label: String(label || '허용한 기기').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80), createdAt: new Date().toISOString(), revokedAt: null };
      save(row, true); return row;
    },
    lookup(secret) {
      if (!TOKEN.test(secret ?? '')) return null;
      const name = hash(secret) + '.json';
      if (!fs.existsSync(path.join(directory, name))) return null;
      const row = read(name); return row.revokedAt ? null : row;
    },
    list() { return all().filter(r => !r.revokedAt).map(r => ({ id: r.id, label: r.label, createdAt: r.createdAt })); },
    revokeSecret(secret) { const row = this.lookup(secret); if (row) revoke(row); },
    revokeId(id) { if (!UUID.test(id ?? '')) fail('device_invalid'); const row = all().find(r => r.id === id); if (!row) fail('device_not_found'); revoke(row); },
    revokeAll() { for (const row of all()) revoke(row); }
  };
}