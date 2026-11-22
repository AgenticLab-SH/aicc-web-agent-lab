import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const MAX_ENTRIES = 10_000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const MANIFEST_NAME = 'aicc-snapshot-manifest.json';

export class PortableBundleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PortableBundleError';
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function normalizeEntryName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 16_384 || name.includes('\0')) {
    throw new PortableBundleError('zip_path_invalid', 'ZIP entry path must be a non-empty bounded string');
  }
  if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new PortableBundleError('zip_path_escape', `ZIP entry path is absolute or platform-specific: ${name}`);
  }
  const normalized = path.posix.normalize(name.replace(/^\.\//, ''));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized !== name.replace(/^\.\//, '')) {
    throw new PortableBundleError('zip_path_escape', `ZIP entry path escapes or is not canonical: ${name}`);
  }
  return normalized;
}

function assertOwnerFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new PortableBundleError('zip_file_unsafe', 'portable ZIP must be a regular non-symlink file');
  }
  if ((process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new PortableBundleError('zip_file_unsafe', 'portable ZIP must be owner-only and owned by the current user');
  }
  if (stat.size > MAX_ARCHIVE_BYTES) throw new PortableBundleError('zip_too_large', 'portable ZIP exceeds the archive size limit');
  return stat;
}

function entryHeader(nameBytes, bytes, offset, mode) {
  const crc = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(UTF8_FLAG, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(CENTRAL_FILE_SIGNATURE, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(UTF8_FLAG, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(((0o100000 | (mode & 0o777)) << 16) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  return { local, central, crc };
}

export function createPortableZip({ destination, manifest, files }) {
  if (!/^snapshot_[a-f0-9]{64}$/.test(manifest?.snapshotId ?? '')) {
    throw new PortableBundleError('manifest_invalid', 'portable manifest requires an exact snapshotId');
  }
  if (!Array.isArray(files) || files.length > MAX_ENTRIES - 1) {
    throw new PortableBundleError('zip_entry_limit', `portable ZIP supports at most ${MAX_ENTRIES - 1} source files`);
  }
  const prepared = files.map(file => {
    const name = normalizeEntryName(file.path);
    const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes ?? '');
    if (name === MANIFEST_NAME) throw new PortableBundleError('manifest_collision', 'source tree collides with the portable manifest name');
    if (bytes.length > MAX_ENTRY_BYTES) throw new PortableBundleError('zip_entry_too_large', `portable ZIP entry is too large: ${name}`);
    return { name, bytes, mode: Number(file.mode ?? 0o600) & 0o777 };
  });
  const unique = new Set(prepared.map(file => file.name));
  if (unique.size !== prepared.length) throw new PortableBundleError('zip_duplicate_entry', 'portable ZIP contains duplicate source paths');
  const sourceBytes = prepared.reduce((sum, file) => sum + file.bytes.length, 0);
  if (sourceBytes > MAX_TOTAL_BYTES) throw new PortableBundleError('zip_total_too_large', 'portable ZIP source bytes exceed the total limit');

  const portableManifest = {
    ...manifest,
    schemaVersion: 1,
    bundleFormat: 'aicc-workspace-snapshot-zip-v1',
    files: prepared.map(file => ({ path: file.name, bytes: file.bytes.length, sha256: sha256(file.bytes), mode: file.mode })),
  };
  portableManifest.treeDigest = sha256(stableJson(portableManifest.files));
  const manifestBytes = Buffer.from(`${JSON.stringify(portableManifest, null, 2)}\n`);
  const entries = [...prepared, { name: MANIFEST_NAME, bytes: manifestBytes, mode: 0o600 }].sort((left, right) => left.name.localeCompare(right.name));

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const header = entryHeader(nameBytes, entry.bytes, offset, entry.mode);
    localParts.push(header.local, nameBytes, entry.bytes);
    centralParts.push(header.central, nameBytes);
    offset += header.local.length + nameBytes.length + entry.bytes.length;
  }
  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  const archive = Buffer.concat([...localParts, ...centralParts, end]);
  if (archive.length > MAX_ARCHIVE_BYTES) throw new PortableBundleError('zip_too_large', 'portable ZIP exceeds the archive size limit');

  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, archive, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, destination);
  return { path: destination, bytes: archive.length, sha256: sha256(archive), manifest: portableManifest };
}

function locateEnd(bytes) {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === END_SIGNATURE) return offset;
  }
  throw new PortableBundleError('zip_structure_invalid', 'ZIP end record is missing');
}

function readEntryData(bytes, entry, centralOffset) {
  const offset = entry.localOffset;
  if (offset + 30 > centralOffset || bytes.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    throw new PortableBundleError('zip_structure_invalid', `ZIP local header is invalid: ${entry.name}`);
  }
  const flags = bytes.readUInt16LE(offset + 6);
  const method = bytes.readUInt16LE(offset + 8);
  const localCrc = bytes.readUInt32LE(offset + 14);
  const localCompressedSize = bytes.readUInt32LE(offset + 18);
  const localUncompressedSize = bytes.readUInt32LE(offset + 22);
  const nameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  if (flags !== entry.flags || method !== entry.method || (flags & 0x0009) !== 0) {
    throw new PortableBundleError('zip_feature_denied', `ZIP encryption or data descriptors are not allowed: ${entry.name}`);
  }
  if (localCrc !== entry.crc || localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize) {
    throw new PortableBundleError('zip_structure_invalid', `ZIP local and central sizes differ: ${entry.name}`);
  }
  const localName = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
  if (localName !== entry.name) throw new PortableBundleError('zip_structure_invalid', `ZIP local and central names differ: ${entry.name}`);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > centralOffset) throw new PortableBundleError('zip_structure_invalid', `ZIP data overlaps the central directory: ${entry.name}`);
  const compressed = bytes.subarray(dataStart, dataEnd);
  let output;
  try {
    output = method === 0
      ? Buffer.from(compressed)
      : zlib.inflateRawSync(compressed, { maxOutputLength: Math.min(MAX_ENTRY_BYTES, entry.uncompressedSize) });
  } catch {
    throw new PortableBundleError('zip_decompression_failed', `ZIP entry could not be decompressed safely: ${entry.name}`);
  }
  if (output.length !== entry.uncompressedSize || crc32(output) !== entry.crc) {
    throw new PortableBundleError('zip_integrity_failed', `ZIP entry size or CRC differs: ${entry.name}`);
  }
  return { output, range: [offset, dataEnd] };
}

export function validatePortableZip({ file, expectedSnapshotId = null }) {
  assertOwnerFile(file);
  const bytes = fs.readFileSync(file);
  const endOffset = locateEnd(bytes);
  const disk = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const diskEntries = bytes.readUInt16LE(endOffset + 8);
  const totalEntries = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const commentLength = bytes.readUInt16LE(endOffset + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries || totalEntries > MAX_ENTRIES) {
    throw new PortableBundleError('zip_feature_denied', 'multi-disk, ZIP64 or oversized ZIPs are not allowed');
  }
  if (endOffset + 22 + commentLength !== bytes.length || centralOffset + centralSize !== endOffset) {
    throw new PortableBundleError('zip_structure_invalid', 'ZIP central directory bounds are invalid');
  }

  const entries = [];
  const names = new Set();
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
      throw new PortableBundleError('zip_structure_invalid', 'ZIP central entry is invalid');
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const entryCommentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (next > endOffset || diskStart !== 0 || (flags & 0x0009) !== 0 || ![0, 8].includes(method)) {
      throw new PortableBundleError('zip_feature_denied', 'ZIP entry uses an unsupported or unsafe feature');
    }
    const name = normalizeEntryName(bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
    const unixType = (externalAttributes >>> 16) & 0o170000;
    if (unixType === 0o120000 || name.endsWith('/')) throw new PortableBundleError('zip_symlink_denied', `ZIP links and directory entries are not allowed: ${name}`);
    if (unixType !== 0o100000) throw new PortableBundleError('zip_special_entry_denied', `ZIP entry is not a regular file: ${name}`);
    if (names.has(name)) throw new PortableBundleError('zip_duplicate_entry', `ZIP contains duplicate entry: ${name}`);
    names.add(name);
    if (uncompressedSize > MAX_ENTRY_BYTES || totalBytes + uncompressedSize > MAX_TOTAL_BYTES) {
      throw new PortableBundleError('zip_bomb_denied', 'ZIP expanded bytes exceed the configured limit');
    }
    if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO)) {
      throw new PortableBundleError('zip_bomb_denied', `ZIP compression ratio is unsafe: ${name}`);
    }
    totalBytes += uncompressedSize;
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset, mode: (externalAttributes >>> 16) & 0o777 });
    cursor = next;
  }
  if (cursor !== endOffset) throw new PortableBundleError('zip_structure_invalid', 'ZIP central directory has trailing bytes');

  const contents = new Map();
  const ranges = [];
  for (const entry of entries) {
    const read = readEntryData(bytes, entry, centralOffset);
    contents.set(entry.name, read.output);
    ranges.push(read.range);
  }
  ranges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index][0] < ranges[index - 1][1]) throw new PortableBundleError('zip_structure_invalid', 'ZIP local entries overlap');
  }

  const manifestBytes = contents.get(MANIFEST_NAME);
  if (!manifestBytes) throw new PortableBundleError('manifest_missing', 'portable ZIP manifest is missing');
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new PortableBundleError('manifest_invalid', 'portable ZIP manifest is not valid JSON');
  }
  if (manifest?.bundleFormat !== 'aicc-workspace-snapshot-zip-v1' || !/^snapshot_[a-f0-9]{64}$/.test(manifest.snapshotId ?? '')) {
    throw new PortableBundleError('manifest_invalid', 'portable ZIP manifest identity is invalid');
  }
  if (expectedSnapshotId && manifest.snapshotId !== expectedSnapshotId) {
    throw new PortableBundleError('snapshot_mismatch', 'portable ZIP snapshot differs from the expected snapshot');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== entries.length - 1) {
    throw new PortableBundleError('manifest_invalid', 'portable ZIP manifest file count differs');
  }
  const entriesByName = new Map(entries.map(entry => [entry.name, entry]));
  const expectedNames = new Set(entries.map(entry => entry.name).filter(name => name !== MANIFEST_NAME));
  for (const item of manifest.files) {
    const name = normalizeEntryName(item?.path);
    const content = contents.get(name);
    const entry = entriesByName.get(name);
    if (!expectedNames.delete(name) || !content || !entry || item.bytes !== content.length || item.sha256 !== sha256(content) || item.mode !== entry.mode) {
      throw new PortableBundleError('manifest_integrity_failed', `portable ZIP manifest differs for ${name}`);
    }
  }
  if (expectedNames.size > 0 || manifest.treeDigest !== sha256(stableJson(manifest.files))) {
    throw new PortableBundleError('manifest_integrity_failed', 'portable ZIP tree digest differs');
  }
  return {
    ok: true,
    snapshotId: manifest.snapshotId,
    entries: manifest.files.length,
    expandedBytes: totalBytes,
    archiveBytes: bytes.length,
    sha256: sha256(bytes),
    manifest,
  };
}
