import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const idPattern = /^[a-z0-9][a-z0-9_-]{3,100}$/;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const text = (value, name, max = 2048) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw Error(`invalid_${name}`);
  return value.trim();
};
function regular(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw Error('regular_owner_path_required');
  return stat;
}
function rootPath(root) {
  if (!path.isAbsolute(root)) throw Error('absolute_pending_root_required');
  const full = path.resolve(root);
  if (full === path.parse(full).root) throw Error('pending_root_must_be_scoped');
  for (let cursor = full;; cursor = path.dirname(cursor)) {
    regular(cursor, true);
    if (cursor === path.dirname(cursor)) break;
  }
  return full;
}
function itemPath(root, id) {
  if (!idPattern.test(id ?? '')) throw Error('invalid_request_id');
  return path.join(root, `${id}.md`);
}
function decode(file) {
  if (regular(file).size > 262144) throw Error('pending_document_too_large');
  const bytes = fs.readFileSync(file);
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const match = /^<!-- aicc-pending-work-v1\r?\n([\s\S]+?)\r?\n-->\r?\n/.exec(source);
  if (!match) throw Error('legacy_document_preserved');
  const record = JSON.parse(match[1]);
  if (record.schemaVersion !== 1 || !idPattern.test(record.id) || !Number.isSafeInteger(record.revision) || record.revision < 1) throw Error('invalid_pending_record');
  return { record, sha256: digest(bytes), bytes };
}
function encode(record) {
  return Buffer.from(`<!-- aicc-pending-work-v1\n${JSON.stringify(record, null, 2)}\n-->\n# ${record.title}\n\n- 상태: ${record.state}\n- 우선순위: ${record.priority}\n- 보낸 지피티: ${record.origin.displayName}\n- 원 대화: ${record.origin.conversationUrl ?? '미확인'}\n- 담당: ${record.owner ?? '미배정'}\n- 대상: ${record.projectRoot}\n\n${record.objective}\n\n정본: ${record.canonicalPath ?? '인수 후 연결'}\n다음 행동: ${record.nextAction}\n`, 'utf8');
}
// This inbox is a document lifecycle, not a sender, queue authority or credential store.
export class PendingWorkInbox {
  constructor(root, { archiveRoot } = {}) {
    this.root = rootPath(root);
    this.archiveRoot = archiveRoot;
  }
  read(id) {
    const { record, sha256 } = decode(itemPath(this.root, id));
    if (record.id !== id) throw Error('pending_id_mismatch');
    return { ...record, sha256 };
  }
  list() {
    const items = [], legacy = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.name.endsWith('.md') || !entry.isFile() || entry.isSymbolicLink()) continue;
      try { items.push(this.read(entry.name.slice(0, -3))); }
      catch (error) { legacy.push({ name: entry.name, reason: error.message }); }
    }
    items.sort((a, b) => a.priority.localeCompare(b.priority) || a.createdAt.localeCompare(b.createdAt));
    return { items, legacy, automaticDispatch: false };
  }
  register(input) {
    const file = itemPath(this.root, input.id);
    const origin = { displayName: text(input.origin?.displayName, 'origin_name', 160), conversationUrl: input.origin?.conversationUrl ?? null,
      identityEvidence: text(input.origin?.identityEvidence, 'identity_evidence', 512) };
    if (origin.conversationUrl !== null && !/^https:\/\/chatgpt\.com\/(?:g\/[^/?#]+\/)?c\/[a-f0-9-]{36}$/.test(origin.conversationUrl)) throw Error('exact_chatgpt_url_required');
    if (!/^P[0-3]$/.test(input.priority)) throw Error('invalid_priority');
    if (!path.isAbsolute(input.projectRoot ?? '')) throw Error('absolute_project_root_required');
    const request = { id: input.id, title: text(input.title, 'title', 200), priority: input.priority, origin,
      projectRoot: path.resolve(input.projectRoot), targetThreadId: input.targetThreadId ?? null,
      objective: text(input.objective, 'objective', 16000), nextAction: text(input.nextAction, 'next_action', 2000) };
    if (request.targetThreadId !== null && !/^[a-f0-9-]{36}$/.test(request.targetThreadId)) throw Error('invalid_target_thread');
    const fingerprint = digest(JSON.stringify(request));
    if (fs.existsSync(file)) {
      const previous = this.read(input.id);
      if (previous.fingerprint !== fingerprint) throw Error('request_id_conflict');
      return { ...previous, duplicate: true };
    }
    const record = { schemaVersion: 1, ...request, fingerprint, state: 'PENDING', revision: 1,
      owner: null, canonicalPath: null, createdAt: new Date().toISOString() };
    fs.writeFileSync(file, encode(record), { flag: 'wx', mode: 0o600 });
    return this.read(input.id);
  }
  transition(id, { expectedSha256, owner, action, canonicalPath, canonicalSha256, nextAction }) {
    const file = itemPath(this.root, id), lock = `${file}.lock`;
    const fd = fs.openSync(lock, 'wx', 0o600);
    try {
      const current = decode(file);
      if (current.sha256 !== expectedSha256) throw Error('pending_revision_changed');
      if (current.record.id !== id) throw Error('pending_id_mismatch');
      const record = current.record, exactOwner = text(owner, 'owner', 160);
      if (record.owner && record.owner !== exactOwner) throw Error('different_pending_owner');
      if (action === 'claim' && record.state === 'PENDING') { record.state = 'CLAIMED'; record.owner = exactOwner; }
      else if (action === 'merge' && record.state === 'CLAIMED') {
        if (!path.isAbsolute(canonicalPath ?? '')) throw Error('absolute_canonical_path_required');
        regular(canonicalPath);
        if (digest(fs.readFileSync(canonicalPath)) !== canonicalSha256) throw Error('canonical_evidence_changed');
        record.state = 'MERGED'; record.canonicalPath = path.resolve(canonicalPath); record.canonicalSha256 = canonicalSha256;
      } else if (action === 'archive' && record.state === 'MERGED') {
        if (digest(fs.readFileSync(record.canonicalPath)) !== record.canonicalSha256) throw Error('canonical_evidence_changed');
        const archive = rootPath(this.archiveRoot ?? '');
        if (archive === this.root || archive.startsWith(this.root + path.sep)) throw Error('archive_must_be_separate');
        const target = itemPath(archive, id);
        if (fs.existsSync(target)) throw Error('archive_already_exists');
        fs.renameSync(file, target);
        return { id, state: 'ARCHIVED', path: target, deleted: false, dispatched: false };
      } else throw Error('invalid_pending_transition');
      record.revision++; record.updatedAt = new Date().toISOString();
      if (nextAction !== undefined) record.nextAction = text(nextAction, 'next_action', 2000);
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, encode(record), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
      return this.read(id);
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}
