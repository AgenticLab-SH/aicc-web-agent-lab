import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealInstalledCliCandidate } from '../src/recovery/installed-cli-route-adapter.mjs';

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
  return argv[index + 1];
}

export function runSealInstalledCliCandidate(argv = process.argv.slice(2)) {
  const root = option(argv, '--root');
  const sourceRevision = option(argv, '--source-revision');
  if (!path.isAbsolute(root)) throw new Error('--root must be absolute');
  const result = sealInstalledCliCandidate(root, { sourceRevision });
  return { ok: true, ...result };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(runSealInstalledCliCandidate(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
