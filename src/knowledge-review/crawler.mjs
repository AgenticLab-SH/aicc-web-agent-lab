import crypto from 'node:crypto';
import { discoverOfficialLinks, KnowledgeFetchError } from './fetcher.mjs';
import { validateOfficialUrl } from './policy.mjs';

function at(now) { return new Date(now()).toISOString(); }

function failureOutcome(error) {
  return ['http_403_hold', 'http_429_hold', 'robots_disallowed'].includes(error?.code) ? 'hold' : 'failed';
}

function errorRecord(error) {
  return {
    code: error?.code ?? 'source_failed',
    status: error?.status ?? null,
    retryable: error?.retryable === true
  };
}

function internalErrorRecord(error) {
  const diagnosticId = crypto.createHash('sha256')
    .update([error?.name, error?.code, error?.message, error?.stack].map(value => String(value ?? '')).join('\n'))
    .digest('hex')
    .slice(0, 16);
  return { code: 'source_internal_error', status: null, retryable: false, diagnosticId };
}

function bulkChangeSignal(source, changed, previousPageCount) {
  if (previousPageCount < 20) return null;
  const changedPageCount = new Set(changed.filter(url => url !== source.seedUrl)).size;
  const ratio = changedPageCount / previousPageCount;
  if (ratio < 0.8) return null;
  return {
    code: 'bulk_source_change_review',
    previousPageCount,
    changedPageCount,
    ratio: Math.round(ratio * 1_000) / 1_000
  };
}

async function persistCheckpoint(store, source, cursor, onCheckpoint, progress) {
  const saved = store.writeCursor(source.id, cursor);
  if (typeof onCheckpoint === 'function') await onCheckpoint({
    sourceId: source.id,
    cursorRef: `knowledge-review://cursors/${source.id}`,
    cursorSha256: saved.sha256,
    progress
  });
  return saved;
}

function isNestedIndex(source, url) {
  return source.kind === 'llms-index' && new URL(url).pathname.endsWith('/llms.txt');
}

function crawlableLinks(source, urls) {
  const excluded = new Set(source.excludedUrls ?? []);
  return urls.filter(url => {
    if (excluded.has(url)) return false;
    try { validateOfficialUrl(source, url); }
    catch { return false; }
    if (source.kind !== 'llms-index') return true;
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('/llms-full.txt')) return false;
    return pathname.endsWith('.txt') || pathname.endsWith('.md');
  });
}

export async function crawlOfficialSource({ source, store, fetcher, now = () => Date.now(), onCheckpoint = null } = {}) {
  const cursor = store.readCursor(source.id);
  cursor.pages ??= {};
  cursor.index ??= null;
  const previousPageCount = Object.keys(cursor.pages).length;
  const startedAt = at(now);
  const changed = [];
  const errors = [];
  let index;
  try {
    index = await fetcher.fetch(source, source.seedUrl, cursor.index);
  } catch (error) {
    const failure = errorRecord(error);
    cursor.lastOutcome = failureOutcome(error);
    cursor.lastError = failure;
    cursor.lastAttemptedAt = at(now);
    await persistCheckpoint(store, source, cursor, onCheckpoint, { phase: 'source-terminal', outcome: cursor.lastOutcome, pagesProcessed: 0 });
    return { sourceId: source.id, outcome: cursor.lastOutcome, changed, errors: [failure], pagesProcessed: 0, skippedUnchanged: 0, bulkChangeSignal: null, startedAt, finishedAt: at(now) };
  }

  let rootLinks = crawlableLinks(source, cursor.index?.discoveredUrls ?? []);
  const previousIndexHash = cursor.index?.indexHash ?? null;
  if (index.status === 200) {
    const object = store.putObject(index.text);
    const discovered = discoverOfficialLinks(source, index.text, index.canonicalUrl);
    rootLinks = crawlableLinks(source, discovered.accepted);
    cursor.index = {
      canonicalUrl: index.canonicalUrl,
      etag: index.etag,
      lastModified: index.lastModified,
      indexHash: index.contentHash,
      contentHash: index.contentHash,
      objectDigest: object.digest,
      discoveredUrls: rootLinks,
      rejectedLinks: discovered.rejected.length,
      status: 'current',
      lastSeenAt: at(now)
    };
    if (index.contentHash !== previousIndexHash) changed.push(index.canonicalUrl);
  } else {
    cursor.index = { ...cursor.index, status: 'unchanged', lastSeenAt: at(now) };
  }
  cursor.lastError = null;
  cursor.lastAttemptedAt = at(now);
  await persistCheckpoint(store, source, cursor, onCheckpoint, { phase: 'index', outcome: index.status === 304 ? 'unchanged' : 'current', pagesProcessed: 0 });

  const indexChanged = index.status === 200 && index.contentHash !== previousIndexHash;
  const queue = [...rootLinks];
  const queued = new Set(queue);
  let pagesProcessed = 0;
  let skippedUnchanged = 0;
  while (queue.length > 0 && pagesProcessed < source.maxPages) {
    const requestedUrl = queue.shift();
    const previous = cursor.pages[requestedUrl] ?? null;
    const needsFetch = indexChanged || !previous || !['current', 'unchanged'].includes(previous.status);
    if (!needsFetch) {
      skippedUnchanged += 1;
      for (const child of crawlableLinks(source, previous.discoveredUrls ?? [])) {
        if (!queued.has(child)) { queued.add(child); queue.push(child); }
      }
      continue;
    }
    pagesProcessed += 1;
    try {
      const page = await fetcher.fetch(source, requestedUrl, previous);
      if (page.status === 304) {
        cursor.pages[requestedUrl] = { ...previous, canonicalUrl: previous?.canonicalUrl ?? requestedUrl, status: 'unchanged', lastSeenAt: at(now), lastError: null };
      } else {
        const object = store.putObject(page.text);
        const discovered = isNestedIndex(source, page.canonicalUrl)
          ? discoverOfficialLinks(source, page.text, page.canonicalUrl)
          : { accepted: [], rejected: [] };
        const pageRecord = {
          canonicalUrl: page.canonicalUrl,
          etag: page.etag,
          lastModified: page.lastModified,
          contentHash: page.contentHash,
          objectDigest: object.digest,
          discoveredUrls: crawlableLinks(source, discovered.accepted),
          rejectedLinks: discovered.rejected.length,
          status: 'current',
          lastSeenAt: at(now),
          lastError: null
        };
        if (page.canonicalUrl !== requestedUrl) delete cursor.pages[requestedUrl];
        cursor.pages[page.canonicalUrl] = pageRecord;
        if (page.contentHash !== previous?.contentHash) changed.push(page.canonicalUrl);
        for (const child of pageRecord.discoveredUrls) {
          if (!queued.has(child)) { queued.add(child); queue.push(child); }
        }
      }
    } catch (error) {
      const failure = errorRecord(error);
      const outcome = failureOutcome(error);
      cursor.pages[requestedUrl] = {
        ...previous,
        canonicalUrl: previous?.canonicalUrl ?? requestedUrl,
        status: outcome,
        lastSeenAt: at(now),
        lastError: failure
      };
      errors.push({ url: requestedUrl, ...failure });
    }
    await persistCheckpoint(store, source, cursor, onCheckpoint, { phase: 'page', outcome: errors.at(-1)?.url === requestedUrl ? cursor.pages[requestedUrl].status : 'current', pagesProcessed });
  }

  if (queue.length > 0) errors.push({ code: 'page_limit_hold', status: null, retryable: false, remaining: queue.length });
  cursor.lastCompletedAt = at(now);
  cursor.lastOutcome = errors.some(error => String(error.code).endsWith('_hold')) ? 'hold' : errors.length ? 'partial' : 'completed';
  cursor.lastError = errors.length ? errors.at(-1) : null;
  await persistCheckpoint(store, source, cursor, onCheckpoint, { phase: 'source-terminal', outcome: cursor.lastOutcome, pagesProcessed });
  return {
    sourceId: source.id,
    outcome: cursor.lastOutcome,
    changed: [...new Set(changed)],
    errors,
    pagesProcessed,
    skippedUnchanged,
    bulkChangeSignal: bulkChangeSignal(source, changed, previousPageCount),
    startedAt,
    finishedAt: at(now)
  };
}

export async function crawlOfficialSources({ sources, store, fetcher, now = () => Date.now(), onCheckpoint = null } = {}) {
  const results = [];
  for (const source of sources) {
    try {
      results.push(await crawlOfficialSource({ source, store, fetcher, now, onCheckpoint }));
    } catch (error) {
      const failure = error instanceof KnowledgeFetchError ? errorRecord(error) : internalErrorRecord(error);
      results.push({ sourceId: source.id, outcome: failureOutcome(error), changed: [], errors: [failure], pagesProcessed: 0, skippedUnchanged: 0, bulkChangeSignal: null, startedAt: at(now), finishedAt: at(now) });
    }
  }
  return results;
}
