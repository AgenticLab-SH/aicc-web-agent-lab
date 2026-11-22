#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const routingPath = path.resolve(here, '../references/design-source-routing.json');

function argumentsFrom(argv) {
  const result = { surface: '', intent: '', json: false, limit: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--surface') result.surface = String(argv[++index] ?? '').toLowerCase();
    else if (arg === '--intent') result.intent = String(argv[++index] ?? '').toLowerCase();
    else if (arg === '--limit') result.limit = Math.max(1, Math.min(5, Number(argv[++index] ?? 3)));
    else if (arg === '--json') result.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.surface && !result.intent) throw new Error('Use --surface <web|presentation|diagram|logo|...> or --intent <task>.');
  return result;
}

function score(source, query) {
  let value = source.surfaces.includes(query.surface) ? 8 : 0;
  const haystack = `${query.surface} ${query.intent}`;
  const matches = source.keywords.filter(keyword => haystack.includes(keyword.toLowerCase()));
  for (const _keyword of matches) value += 3;
  if (source.id === 'impeccable' && ['web', 'ui', 'dashboard'].includes(query.surface)) value += 4;
  if (source.id === 'shadcn-ui' && ['web', 'ui', 'dashboard'].includes(query.surface)) value += 2;
  if (source.id === 'ai-website-cloner-template' && matches.length === 0) value = 0;
  return value;
}

export function select(argv = process.argv.slice(2), options = {}) {
  const query = argumentsFrom(argv);
  const catalog = JSON.parse(fs.readFileSync(options.routingPath ?? routingPath, 'utf8'));
  const stateRoot = options.stateRoot ?? process.env.AICC_STATE_ROOT?.trim() ?? path.join(os.homedir(), '.ai-control-center');
  const activeRoot = path.join(stateRoot, 'design-sources', 'active');
  const matches = catalog.sources
    .map(source => ({ source, score: score(source, query) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.source.id.localeCompare(right.source.id))
    .slice(0, query.limit)
    .map(({ source, score: relevance }) => {
      const activePath = path.join(activeRoot, source.id);
      let revision = null;
      let available = false;
      try {
        const resolved = fs.realpathSync(activePath);
        revision = path.basename(resolved);
        available = /^[0-9a-f]{40}$/.test(revision);
      } catch { /* source is not installed yet */ }
      return {
        id: source.id,
        relevance,
        available,
        revision,
        activePath: available ? activePath : null,
        recommendedPaths: source.recommendedPaths.map(relative => available ? path.join(activePath, relative) : relative),
        usageRestriction: source.usageRestriction ?? null
      };
    });
  return { ok: true, surface: query.surface || null, intent: query.intent || null, stateRoot, matches };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = select();
    if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      for (const match of result.matches) process.stdout.write(`${match.available ? 'READY' : 'MISSING'}\t${match.id}\t${match.revision ?? '-'}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
