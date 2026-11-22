// Kiro CLI V3 Stop hook: deliver one queued instruction to the exact session that just finished a
// turn, in the same tab. Official contract: a Stop hook that exits 0 and prints
// {"decision":"block","reason":"..."} sends the reason back and the agent keeps going.
// Mailbox: <root>/<sessionId>.json written by Send-KiroTurnEndInstruction.ps1. Delivery claims the
// file by rename before printing, so a later Stop never redelivers. Any doubt -> deliver nothing.
// Root override: KIRO_TURN_MAILBOX_ROOT (tests). No network, no model call, no other session read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = process.env.KIRO_TURN_MAILBOX_ROOT || path.join(os.homedir(), '.codex', 'ops', 'kiro-turn-mailbox');
const sha = text => createHash('sha256').update(text).digest('hex');
function receipt(row) {
  try { fs.mkdirSync(root, { recursive: true }); fs.appendFileSync(path.join(root, 'receipts.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'); } catch { /* receipt is best effort */ }
}

let raw = '';
for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 65536) break; }
let event;
try { event = JSON.parse(raw); } catch { process.exit(0); }
const sessionId = String(event?.session_id ?? '');
if (!/^sess_[0-9a-f-]{36}$/.test(sessionId) || String(event?.hook_event_name ?? '').toLowerCase() !== 'stop') process.exit(0);
const file = path.join(root, `${sessionId}.json`);
let stat;
try { stat = fs.lstatSync(file); } catch { process.exit(0); }
if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) { receipt({ sessionId, state: 'REFUSED_INVALID_MAILBOX' }); process.exit(0); }
let item;
try { item = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { receipt({ sessionId, state: 'REFUSED_UNREADABLE' }); process.exit(0); }
const valid = item?.schemaVersion === 1 && item.sessionId === sessionId && typeof item.id === 'string' && /^[A-Za-z0-9._:-]{6,80}$/.test(item.id)
  && typeof item.instruction === 'string' && item.instruction.trim().length > 0 && item.instruction.length <= 24000
  && item.instructionSha256 === sha(item.instruction)
  && (item.expiresAt == null || Date.parse(item.expiresAt) > Date.now());
if (!valid) { receipt({ sessionId, id: item?.id ?? null, state: 'REFUSED_INVALID_OR_EXPIRED' }); process.exit(0); }
// Claim exactly once. If the rename fails (someone else claimed it), deliver nothing.
const delivered = path.join(root, 'delivered');
fs.mkdirSync(delivered, { recursive: true });
const claimed = path.join(delivered, `${sessionId}-${item.id}.json`);
try { fs.renameSync(file, claimed); } catch { receipt({ sessionId, id: item.id, state: 'CLAIM_LOST' }); process.exit(0); }
receipt({ sessionId, id: item.id, state: 'DELIVERED_AT_TURN_END', instructionSha256: item.instructionSha256 });
process.stdout.write(JSON.stringify({ decision: 'block', reason: item.instruction }));
