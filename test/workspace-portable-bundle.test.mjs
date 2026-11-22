import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPortableZip, PortableBundleError, validatePortableZip } from '../src/workspace-snapshots/portable-bundle.mjs';

const SNAPSHOT_ID = `snapshot_${'a'.repeat(64)}`;

function fixture(t, files = [{ path: 'aa/file.txt', bytes: Buffer.from('safe\n'), mode: 0o600 }]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-portable-zip-'));
  const file = path.join(root, 'bundle.zip');
  const result = createPortableZip({ destination: file, manifest: { snapshotId: SNAPSHOT_ID, workspaceId: 'workspace_fixture' }, files });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file, result };
}

function centralOffset(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  return bytes.readUInt32LE(end + 16);
}

test('creates and validates a deterministic manifest-bound owner-only ZIP', t => {
  const { file, result } = fixture(t, [
    { path: 'src/index.mjs', bytes: Buffer.from('export const ok = true;\n'), mode: 0o700 },
    { path: 'README.md', bytes: Buffer.from('# Fixture\n'), mode: 0o600 },
  ]);
  const validated = validatePortableZip({ file, expectedSnapshotId: SNAPSHOT_ID });
  assert.equal(validated.ok, true);
  assert.equal(validated.entries, 2);
  assert.equal(validated.sha256, result.sha256);
  assert.equal(validated.manifest.treeDigest, result.manifest.treeDigest);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
});

test('rejects traversal, symlink, bomb ratio, CRC corruption, wrong identity and unsafe file mode', t => {
  const traversal = fixture(t);
  const traversalBytes = fs.readFileSync(traversal.file);
  const central = centralOffset(traversalBytes);
  const localNameLength = traversalBytes.readUInt16LE(26);
  const centralNameLength = traversalBytes.readUInt16LE(central + 28);
  assert.equal(localNameLength, 11);
  assert.equal(centralNameLength, 11);
  Buffer.from('../file.txt').copy(traversalBytes, 30);
  Buffer.from('../file.txt').copy(traversalBytes, central + 46);
  fs.writeFileSync(traversal.file, traversalBytes, { mode: 0o600 });
  assert.throws(
    () => validatePortableZip({ file: traversal.file }),
    error => error instanceof PortableBundleError && error.code === 'zip_path_escape',
  );

  const linked = fixture(t);
  const linkedBytes = fs.readFileSync(linked.file);
  linkedBytes.writeUInt32LE(((0o120777) << 16) >>> 0, centralOffset(linkedBytes) + 38);
  fs.writeFileSync(linked.file, linkedBytes, { mode: 0o600 });
  assert.throws(
    () => validatePortableZip({ file: linked.file }),
    error => error instanceof PortableBundleError && error.code === 'zip_symlink_denied',
  );

  const modeDrift = fixture(t);
  const modeBytes = fs.readFileSync(modeDrift.file);
  modeBytes.writeUInt32LE(((0o100700) << 16) >>> 0, centralOffset(modeBytes) + 38);
  fs.writeFileSync(modeDrift.file, modeBytes, { mode: 0o600 });
  assert.throws(
    () => validatePortableZip({ file: modeDrift.file }),
    error => error instanceof PortableBundleError && error.code === 'manifest_integrity_failed',
  );

  const special = fixture(t);
  const specialBytes = fs.readFileSync(special.file);
  specialBytes.writeUInt32LE(((0o140600) << 16) >>> 0, centralOffset(specialBytes) + 38);
  fs.writeFileSync(special.file, specialBytes, { mode: 0o600 });
  assert.throws(
    () => validatePortableZip({ file: special.file }),
    error => error instanceof PortableBundleError && error.code === 'zip_special_entry_denied',
  );

  const bomb = fixture(t, [{ path: 'tiny.txt', bytes: Buffer.from('x'), mode: 0o600 }]);
  const bombBytes = fs.readFileSync(bomb.file);
  bombBytes.writeUInt32LE(60_000_000, centralOffset(bombBytes) + 24);
  fs.writeFileSync(bomb.file, bombBytes, { mode: 0o600 });
  assert.throws(
    () => validatePortableZip({ file: bomb.file }),
    error => error instanceof PortableBundleError && error.code === 'zip_bomb_denied',
  );

  const corrupt = fixture(t);
  const corruptBytes = fs.readFileSync(corrupt.file);
  const dataOffset = 30 + corruptBytes.readUInt16LE(26) + corruptBytes.readUInt16LE(28);
  corruptBytes[dataOffset] ^= 0xff;
  fs.writeFileSync(corrupt.file, corruptBytes, { mode: 0o600 });
  assert.throws(
    () => validatePortableZip({ file: corrupt.file }),
    error => error instanceof PortableBundleError && error.code === 'zip_integrity_failed',
  );

  const wrong = fixture(t);
  assert.throws(
    () => validatePortableZip({ file: wrong.file, expectedSnapshotId: `snapshot_${'b'.repeat(64)}` }),
    error => error instanceof PortableBundleError && error.code === 'snapshot_mismatch',
  );

  if (process.platform !== 'win32') {
    const unsafe = fixture(t);
    fs.chmodSync(unsafe.file, 0o644);
    assert.throws(
      () => validatePortableZip({ file: unsafe.file }),
      error => error instanceof PortableBundleError && error.code === 'zip_file_unsafe',
    );
  }
});

test('rejects unsafe source paths and duplicate portable entries before writing', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-portable-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => createPortableZip({ destination: path.join(root, 'escape.zip'), manifest: { snapshotId: SNAPSHOT_ID }, files: [{ path: '../escape', bytes: Buffer.from('x') }] }),
    error => error instanceof PortableBundleError && error.code === 'zip_path_escape',
  );
  assert.throws(
    () => createPortableZip({ destination: path.join(root, 'duplicate.zip'), manifest: { snapshotId: SNAPSHOT_ID }, files: [{ path: 'same', bytes: Buffer.from('x') }, { path: 'same', bytes: Buffer.from('y') }] }),
    error => error instanceof PortableBundleError && error.code === 'zip_duplicate_entry',
  );
});
