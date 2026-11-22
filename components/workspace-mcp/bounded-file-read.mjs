import fs from 'node:fs';

// The bound is a response-page budget, never an on-disk file-size limit.
export const FILE_PAGE_MAX_BYTES = 1_048_576;
const version = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
function encodingFor(probe, requested) {
  if (requested !== 'auto') return requested;
  if (probe[0] === 0xff && probe[1] === 0xfe) return 'utf16le';
  if (probe[0] === 0xfe && probe[1] === 0xff) return 'utf16be';
  if (probe.some(byte => byte === 0 || (byte < 9 || byte > 13 && byte < 32))) return 'base64';
  return 'utf8';
}
function newlineOffset(bytes, encoding, wanted) {
  const step = encoding.startsWith('utf16') ? 2 : 1;
  for (let i = 0; i + step <= bytes.length; i += step) {
    const newline = step === 1 ? bytes[i] === 10 : encoding === 'utf16le'
      ? bytes[i] === 10 && bytes[i + 1] === 0 : bytes[i] === 0 && bytes[i + 1] === 10;
    if (newline && --wanted === 0) return i + step;
  }
  return -1;
}
function decode(bytes, encoding) {
  if (encoding === 'utf16be') {
    const swapped = Buffer.from(bytes);
    swapped.swap16();
    return new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(swapped);
  }
  return new TextDecoder(encoding === 'utf16le' ? 'utf-16le' : 'utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
export function readFilePage(file, input = {}) {
  const maxBytes = Math.max(1, Math.min(FILE_PAGE_MAX_BYTES, input.max_bytes ?? 65_536));
  const maxLines = input.max_lines ?? 400;
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('일반 파일만 읽을 수 있습니다.');
    const fileVersion = version(stat);
    if (input.file_version && input.file_version !== fileVersion) throw new Error('파일이 변경되었습니다. 새 버전의 첫 페이지부터 읽어 주세요.');
    const probe = Buffer.alloc(Math.min(4096, stat.size));
    fs.readSync(fd, probe, 0, probe.length, 0);
    let encoding = encodingFor(probe, input.encoding ?? 'auto');
    let offset = input.offset_bytes ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size) throw new Error('유효한 파일 byte offset이 필요합니다.');
    if (encoding.startsWith('utf16') && offset % 2) throw new Error('UTF-16 byte offset은 짝수여야 합니다.');
    const bom = offset === 0 && ((encoding === 'utf8' && probe[0] === 0xef && probe[1] === 0xbb && probe[2] === 0xbf) ? 3
      : encoding.startsWith('utf16') && ((probe[0] === 0xff && probe[1] === 0xfe) || (probe[0] === 0xfe && probe[1] === 0xff)) ? 2 : 0);
    offset += bom;
    // Legacy line positioning scans bounded blocks; it never retains skipped data.
    let startLine = input.offset_bytes == null ? input.start_line ?? 1 : null;
    if (encoding !== 'base64' && startLine > 1) {
      let remaining = startLine - 1;
      const block = Buffer.alloc(65_536);
      while (remaining && offset < stat.size) {
        const count = fs.readSync(fd, block, 0, block.length, offset);
        if (!count) break;
        const bytes = block.subarray(0, count);
        const stop = newlineOffset(bytes, encoding, remaining);
        if (stop >= 0) { offset += stop; remaining = 0; break; }
        const step = encoding.startsWith('utf16') ? 2 : 1;
        for (let i = 0; i + step <= count; i += step) if (step === 1 ? bytes[i] === 10 : encoding === 'utf16le' ? bytes[i] === 10 && bytes[i + 1] === 0 : bytes[i] === 0 && bytes[i + 1] === 10) remaining--;
        offset += count;
      }
    }
    const allocation = Buffer.alloc(Math.min(maxBytes + 4, stat.size - offset));
    const count = fs.readSync(fd, allocation, 0, allocation.length, offset);
    let length = Math.min(maxBytes, count);
    if (encoding.startsWith('utf16')) {
      length -= length % 2;
      if (length >= 2 && offset + length < stat.size) {
        const unit = encoding === 'utf16le' ? allocation.readUInt16LE(length - 2) : allocation.readUInt16BE(length - 2);
        if (unit >= 0xd800 && unit <= 0xdbff) length -= 2;
      }
    } else if (encoding === 'utf8' && offset + length < stat.size) {
      while (length > 0 && (allocation[length] & 0xc0) === 0x80) length--;
    }
    // A too-small text budget still makes progress by returning raw bytes.
    if (length === 0 && count > 0) { encoding = 'base64'; length = Math.min(maxBytes, count); }
    let bytes = allocation.subarray(0, length);
    if (encoding !== 'base64') {
      const lineEnd = newlineOffset(bytes, encoding, maxLines);
      if (lineEnd >= 0) { length = lineEnd; bytes = allocation.subarray(0, length); }
    }
    let text = null;
    if (encoding !== 'base64') {
      try { text = decode(bytes, encoding); }
      catch (error) {
        if ((input.encoding ?? 'auto') !== 'auto') throw new Error('지정한 문자 인코딩과 파일 바이트가 맞지 않습니다. base64로 읽을 수 있습니다.');
        encoding = 'base64';
      }
    }
    if (version(fs.fstatSync(fd)) !== fileVersion) throw new Error('읽는 중 파일이 변경되었습니다. 새 버전으로 다시 열어 주세요.');
    const next = offset + length;
    const eof = next >= stat.size;
    const lines = text == null || !text.length ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return { ok: true, encoding, ...(encoding === 'base64' ? { data_base64: bytes.toString('base64') } : { text }),
      file_bytes: stat.size, file_version: fileVersion, offset_bytes: offset, bytes_read: length,
      next_offset_bytes: next, eof, truncated: !eof, start_line: startLine,
      end_line: startLine == null ? null : Math.max(startLine, startLine + lines - 1),
      total_lines: eof && startLine != null && text != null ? startLine + lines - 1 : null };
  } finally { fs.closeSync(fd); }
}
