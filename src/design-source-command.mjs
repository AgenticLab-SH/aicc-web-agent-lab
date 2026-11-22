import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyDesignSourceSelection, restoreDesignSourceSelection, scanDesignSources } from './design-sources.mjs';

function parseJson(value, label) {
  try { return JSON.parse(value); } catch { throw new Error(`${label} must be valid JSON`); }
}

export function run(argv = process.argv.slice(2), options = {}) {
  const [command, value] = argv;
  const stateRoot = process.env.AICC_STATE_ROOT?.trim();
  const shared = { ...options, ...(stateRoot ? { stateRoot } : {}) };
  if (command === 'scan') return scanDesignSources(shared);
  if (command === 'apply') return applyDesignSourceSelection(parseJson(value, 'selection'), shared);
  if (command === 'restore') return restoreDesignSourceSelection(parseJson(value, 'revisions'), shared);
  throw new Error('Usage: design-source-command.mjs <scan|apply|restore> [json]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = run();
    process.stdout.write(`${JSON.stringify({ ok: true, counts: result.counts })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
