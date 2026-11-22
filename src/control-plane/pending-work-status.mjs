import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PendingWorkInbox } from './pending-work.mjs';

// Metadata for the authenticated owner, never a sender or a completion authority.
export function readPendingWorkSummary({ stateRoot, now = Date.now } = {}) {
  const base = { ok: true, readOnly: true, automaticDispatch: false,
    developmentCompleted: false, status: 'UNKNOWN', observedAt: new Date(now()).toISOString(),
    total: null, items: [], partial: false, truncated: false, legacyCount: 0, unreadableCount: 0,
    nextAction: '인수 뒤 기존 프로젝트 정본에서 개발을 이어갑니다. 통합 표시는 개발 완료가 아닙니다.' };
  try {
    const root = path.join(stateRoot, 'pending-work');
    for (let p = path.resolve(stateRoot);; p = path.dirname(p)) {
      const stat = fs.lstatSync(p);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('invalid_owner');
      if (path.dirname(p) === p) break;
    }
    let directory;
    try { directory = fs.lstatSync(root); }
    catch (error) {
      if (error.code === 'ENOENT') return { ...base, status: 'NOT_INITIALIZED', total: 0 };
      throw error;
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('invalid_inbox');
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.length > 256) throw Error('inbox_bounds');
    const inbox = new PendingWorkInbox(root), rows = [];
    let legacyCount = 0, unreadableCount = 0;
    const label = (value, max) => typeof value === 'string' && value.trim()
      && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
    for (const entry of entries) {
      if (entry.name === 'README.md' || !entry.name.endsWith('.md')) continue;
      try {
        if (!entry.isFile() || entry.isSymbolicLink()) throw Error('invalid_item');
        const file = path.join(root, entry.name), before = fs.lstatSync(file);
        if (before.nlink !== 1 || before.size > 262144) throw Error('invalid_item');
        let row;
        try { row = inbox.read(entry.name.slice(0, -3)); }
        catch (error) {
          if (error.message !== 'legacy_document_preserved') throw error;
          const source = fs.readFileSync(file, 'utf8'), after = fs.lstatSync(file);
          if (source.trimStart().startsWith('<!-- aicc-pending-work-')
            || after.isSymbolicLink() || after.nlink !== 1 || before.ino !== after.ino
            || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('invalid_legacy_item');
          legacyCount++;
          continue;
        }
        if (!['PENDING', 'CLAIMED', 'MERGED'].includes(row.state) || !/^P[0-3]$/.test(row.priority)) throw Error('invalid_state');
        const title = label(row.title, 200), displayName = label(row.origin?.displayName, 160);
        if (!title || !displayName || !label(row.origin?.identityEvidence, 512)
          || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) throw Error('invalid_metadata');
        let conversationUrl = null;
        if (row.origin.conversationUrl !== null) {
          if (!/^https:\/\/chatgpt\.com\/(?:g\/[^/?#]+\/)?c\/[a-f0-9-]{36}$/.test(row.origin.conversationUrl ?? '')) throw Error('invalid_origin');
          conversationUrl = row.origin.conversationUrl;
        }
        const after = fs.lstatSync(file);
        if (after.isSymbolicLink() || after.nlink !== 1 || before.ino !== after.ino
          || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('item_changed');
        rows.push({ key: createHash('sha256').update('pending-work:' + row.id).digest('hex').slice(0, 20),
          title, priority: row.priority, state: row.state, displayName, conversationUrl,
          createdAt: row.createdAt, developmentCompleted: false });
      } catch { unreadableCount++; }
    }
    rows.sort((a, b) => a.priority.localeCompare(b.priority) || a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key));
    const partial = legacyCount + unreadableCount > 0;
    return { ...base, status: rows.length ? 'AVAILABLE' : unreadableCount ? 'UNKNOWN' : legacyCount ? 'LEGACY_ONLY' : 'EMPTY',
      total: partial ? null : rows.length, partial, legacyCount, unreadableCount,
      items: rows.slice(0, 24), truncated: rows.length > 24 };
  } catch { return base; }
}
