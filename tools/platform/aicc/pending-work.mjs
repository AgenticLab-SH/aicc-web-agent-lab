import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PendingWorkInbox } from '../../../src/control-plane/pending-work.mjs';

const args = process.argv.slice(2), action = args.shift();
const options = {};
while (args.length) {
  const name = args.shift();
  if (!['--root', '--archive-root', '--input', '--id'].includes(name) || !args.length || options[name]) throw Error('usage: list|read|register|transition [--root ABS] [--archive-root ABS] [--input ABS.json] [--id ID]');
  options[name] = args.shift();
}
const state = path.join(os.homedir(), '.ai-control-center');
const inbox = new PendingWorkInbox(options['--root'] ?? path.join(state, 'pending-work'), {
  archiveRoot: options['--archive-root'] ?? path.join(state, 'receipts', 'pending-work')
});
const input = () => {
  if (!path.isAbsolute(options['--input'] ?? '')) throw Error('absolute_input_required');
  return JSON.parse(fs.readFileSync(options['--input'], 'utf8'));
};
let result;
if (action === 'list') result = inbox.list();
else if (action === 'read') result = inbox.read(options['--id']);
else if (action === 'register') result = inbox.register(input());
else if (action === 'transition') result = inbox.transition(options['--id'], input());
else throw Error('unknown_pending_action');
console.log(JSON.stringify(result, null, 2));
