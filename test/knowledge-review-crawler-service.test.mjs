import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { crawlOfficialSource, crawlOfficialSources } from '../src/knowledge-review/crawler.mjs';
import { SafeOfficialFetcher } from '../src/knowledge-review/fetcher.mjs';
import { OFFICIAL_SOURCE_REGISTRY } from '../src/knowledge-review/policy.mjs';
import { KnowledgeReviewService } from '../src/knowledge-review/service.mjs';
import { KnowledgeReviewStore } from '../src/knowledge-review/storage.mjs';
import { fakeFetch, publicResolution } from './fixtures/knowledge-review/fake-fetch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, 'fixtures', 'knowledge-review');
const openaiSource = OFFICIAL_SOURCE_REGISTRY.sources[0];
const chatgptSource = OFFICIAL_SOURCE_REGISTRY.sources.find(source => source.id === 'openai-chatgpt');
const anthropicSource = OFFICIAL_SOURCE_REGISTRY.sources.find(source => source.id === 'anthropic-platform');

function text(name) { return fs.readFileSync(path.join(fixtureRoot, name), 'utf8'); }

function temporaryStore(t, registry = OFFICIAL_SOURCE_REGISTRY) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-knowledge-crawl-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, store: new KnowledgeReviewStore({ root: path.join(base, 'knowledge-review'), registry }) };
}

function safeFetcher(routes, calls = []) {
  return new SafeOfficialFetcher({
    fetchImpl: fakeFetch(routes, calls),
    resolveHost: publicResolution,
    robotsCheck: async () => true,
    sleeper: async () => {}
  });
}

test('nested llms indexes crawl content-addressed pages and unchanged index skips full refetch', async t => {
  const registry = { schemaVersion: 1, manualOnly: true, automaticApply: false, sources: [{ ...openaiSource, maxPages: 20 }] };
  const source = registry.sources[0];
  const { store } = temporaryStore(t, registry);
  const rootBody = '# Index\n- [API](https://developers.openai.com/api/llms.txt)\n';
  const routes = {
    [source.seedUrl]: { body: rootBody, headers: { 'content-type': 'text/plain', etag: 'root-v1', 'last-modified': 'Fri, 15 Aug 2026 00:00:00 GMT' } },
    'https://developers.openai.com/api/llms.txt': { body: text('openai-api-index.txt'), headers: { 'content-type': 'text/plain', etag: 'api-v1' } },
    'https://developers.openai.com/api/docs/guides/responses.md': { body: text('openai-page.md'), headers: { 'content-type': 'text/markdown', etag: 'responses-v1' } },
    'https://developers.openai.com/api/docs/guides/safety-best-practices.md': { body: '# Safety\n', headers: { 'content-type': 'text/markdown', etag: 'safety-v1' } }
  };
  const firstCalls = [];
  const first = await crawlOfficialSource({ source, store, fetcher: safeFetcher(routes, firstCalls) });
  assert.equal(first.outcome, 'completed');
  assert.equal(first.pagesProcessed, 3);
  assert.equal(first.changed.length, 4);
  const cursor = store.readCursor(source.id);
  assert.equal(cursor.index.etag, 'root-v1');
  assert.equal(cursor.index.lastModified, 'Fri, 15 Aug 2026 00:00:00 GMT');
  assert.equal(cursor.index.indexHash, cursor.index.contentHash);
  assert.equal(Object.keys(cursor.pages).length, 3);
  for (const page of Object.values(cursor.pages)) assert.equal(page.objectDigest.length, 64);

  const secondCalls = [];
  const second = await crawlOfficialSource({
    source,
    store,
    fetcher: safeFetcher({ [source.seedUrl]: { status: 304, headers: { etag: 'root-v1' } } }, secondCalls)
  });
  assert.equal(second.outcome, 'completed');
  assert.equal(second.pagesProcessed, 0);
  assert.equal(second.skippedUnchanged, 3);
  assert.deepEqual(secondCalls.map(call => call.url), [source.seedUrl]);
  assert.equal(secondCalls[0].options.headers['if-none-match'], 'root-v1');
});

test('llms indexes retain machine-readable documents and skip linked HTML pages on fresh and resumed crawls', async t => {
  const registry = { schemaVersion: 1, manualOnly: true, automaticApply: false, sources: [{ ...openaiSource, maxPages: 20 }] };
  const source = registry.sources[0];
  const { store } = temporaryStore(t, registry);
  const nested = 'https://developers.openai.com/showcase/llms.txt';
  const full = 'https://developers.openai.com/showcase/llms-full.txt';
  const markdown = 'https://developers.openai.com/api/docs/quickstart.md';
  const html = 'https://developers.openai.com/showcase/rift-vox';
  const oversized = openaiSource.excludedUrls[0];
  const retiredScope = 'https://developers.openai.com/codex/config-reference.md';
  const routes = {
    [source.seedUrl]: { body: `# Index\n- [Showcase index](${nested})\n- [Full export](${full})\n- [Quickstart](${markdown})\n- [Showcase page](${html})\n- [Known oversized page](${oversized})\n`, headers: { 'content-type': 'text/plain', etag: 'root-v1' } },
    [nested]: { body: `# Showcase\n- [Showcase page](${html})\n`, headers: { 'content-type': 'text/plain', etag: 'showcase-v1' } },
    [markdown]: { body: '# Quickstart\n', headers: { 'content-type': 'text/markdown', etag: 'quickstart-v1' } }
  };
  const firstCalls = [];
  const first = await crawlOfficialSource({ source, store, fetcher: safeFetcher(routes, firstCalls) });
  assert.equal(first.outcome, 'completed');
  assert.deepEqual(firstCalls.map(call => call.url), [source.seedUrl, markdown, nested]);
  assert.deepEqual(store.readCursor(source.id).index.discoveredUrls, [markdown, nested]);

  const cursor = store.readCursor(source.id);
  cursor.index.discoveredUrls.push(html);
  cursor.index.discoveredUrls.push(oversized);
  cursor.index.discoveredUrls.push(retiredScope);
  cursor.pages[nested].discoveredUrls = [html];
  store.writeCursor(source.id, cursor);
  const resumedCalls = [];
  const resumed = await crawlOfficialSource({
    source,
    store,
    fetcher: safeFetcher({ [source.seedUrl]: { status: 304, headers: { etag: 'root-v1' } } }, resumedCalls)
  });
  assert.equal(resumed.outcome, 'completed');
  assert.equal(resumed.pagesProcessed, 0);
  assert.deepEqual(resumedCalls.map(call => call.url), [source.seedUrl]);
});

test('canonical HTML sources skip exact retired links while retaining current same-host pages', async t => {
  const base = OFFICIAL_SOURCE_REGISTRY.sources.find(source => source.id === 'anthropic-engineering');
  const registry = { schemaVersion: 1, manualOnly: true, automaticApply: false, sources: [{ ...base, maxPages: 20 }] };
  const source = registry.sources[0];
  const { store } = temporaryStore(t, registry);
  const current = 'https://www.anthropic.com/engineering/building-effective-agents';
  const retired = source.excludedUrls[0];
  const routes = {
    [source.seedUrl]: { body: `<a href="${current}">current</a><a href="${retired}">retired</a>`, headers: { 'content-type': 'text/html', etag: 'engineering-v1' } },
    [current]: { body: '<main>Current article</main>', headers: { 'content-type': 'text/html', etag: 'article-v1' } }
  };
  const calls = [];
  const result = await crawlOfficialSource({ source, store, fetcher: safeFetcher(routes, calls) });
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(calls.map(call => call.url), [source.seedUrl, current]);
  assert.deepEqual(store.readCursor(source.id).index.discoveredUrls, [current]);
});

test('ChatGPT exact-host Markdown accepts its current bounded octet-stream response', async t => {
  const registry = { schemaVersion: 1, manualOnly: true, automaticApply: false, sources: [{ ...chatgptSource, maxPages: 20 }] };
  const source = registry.sources[0];
  const { store } = temporaryStore(t, registry);
  const manual = 'https://learn.chatgpt.com/docs/codex-manual.md';
  const calls = [];
  const result = await crawlOfficialSource({
    source,
    store,
    fetcher: safeFetcher({
      [source.seedUrl]: { body: `# Index\n- [Manual](${manual})\n`, headers: { 'content-type': 'text/plain', etag: 'index-v1' } },
      [manual]: { body: '# Codex Manual\n', headers: { 'content-type': 'application/octet-stream', etag: 'manual-v1' } }
    }, calls)
  });
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(calls.map(call => call.url), [source.seedUrl, manual]);
});

test('a 403 source checkpoint is held without rolling back another source', async t => {
  const registry = { schemaVersion: 1, manualOnly: true, automaticApply: false, sources: [openaiSource, anthropicSource] };
  const { store } = temporaryStore(t, registry);
  const results = await crawlOfficialSources({
    sources: registry.sources,
    store,
    fetcher: safeFetcher({
      [openaiSource.seedUrl]: { body: '# No pages\n', headers: { 'content-type': 'text/plain', etag: 'openai-v1' } },
      [anthropicSource.seedUrl]: { status: 403, headers: { 'content-type': 'text/plain' } }
    })
  });
  assert.deepEqual(results.map(result => result.outcome), ['completed', 'hold']);
  assert.equal(store.readCursor(openaiSource.id).lastOutcome, 'completed');
  assert.equal(store.readCursor(anthropicSource.id).lastOutcome, 'hold');
  assert.equal(store.readCursor(anthropicSource.id).lastError.code, 'http_403_hold');
});

test('legacy cursors without pages resume safely and broad source changes emit a review signal', async t => {
  const links = Array.from({ length: 20 }, (_, index) => `https://developers.openai.com/api/docs/page-${index}.md`);
  const registry = { schemaVersion: 1, manualOnly: true, automaticApply: false, sources: [{ ...openaiSource, maxPages: 30 }] };
  const source = registry.sources[0];
  const { store } = temporaryStore(t, registry);

  const legacy = store.readCursor(source.id);
  delete legacy.pages;
  const legacyStore = {
    readCursor: () => structuredClone(legacy),
    writeCursor: () => ({ sha256: '0'.repeat(64) }),
    putObject: () => ({ digest: '0'.repeat(64) })
  };
  const empty = await crawlOfficialSource({
    source,
    store: legacyStore,
    fetcher: safeFetcher({ [source.seedUrl]: { body: '# Empty\n', headers: { 'content-type': 'text/plain', etag: 'empty-v1' } } })
  });
  assert.equal(empty.outcome, 'completed');
  assert.equal(empty.bulkChangeSignal, null);

  const seeded = store.readCursor(source.id);
  seeded.index = { canonicalUrl: source.seedUrl, etag: 'old-index', lastModified: null, contentHash: 'old-index', indexHash: 'old-index', objectDigest: '0'.repeat(64), discoveredUrls: links, rejectedLinks: 0, status: 'current', lastSeenAt: new Date().toISOString() };
  seeded.pages = Object.fromEntries(links.map(url => [url, { canonicalUrl: url, etag: 'old', contentHash: 'old', objectDigest: '0'.repeat(64), discoveredUrls: [], status: 'current' }]));
  store.writeCursor(source.id, seeded);
  const routes = {
    [source.seedUrl]: { body: links.map(url => `- [page](${url})`).join('\n'), headers: { 'content-type': 'text/plain', etag: 'new-index' } },
    ...Object.fromEntries(links.map((url, index) => [url, { body: `# Changed ${index}\n`, headers: { 'content-type': 'text/markdown', etag: `new-${index}` } }]))
  };
  const changed = await crawlOfficialSource({ source, store, fetcher: safeFetcher(routes) });
  assert.equal(changed.outcome, 'completed');
  assert.deepEqual(changed.bulkChangeSignal, {
    code: 'bulk_source_change_review', previousPageCount: 20, changedPageCount: 20, ratio: 1
  });
});

test('unexpected source failures expose only a stable diagnostic id', async () => {
  const result = await crawlOfficialSources({
    sources: [openaiSource],
    store: { readCursor() { throw new Error('private path C:/secret should not escape'); } },
    fetcher: safeFetcher({})
  });
  assert.equal(result[0].errors[0].code, 'source_internal_error');
  assert.match(result[0].errors[0].diagnosticId, /^[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(result[0]), /private path|C:\/secret|stack/i);
});

test('API-neutral service requires manual confirmation and completes a durable idempotent job', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-knowledge-service-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const registry = { schemaVersion: 1, manualOnly: true, automaticApply: false, sources: [{ ...openaiSource, maxPages: 5 }] };
  const clock = { value: Date.parse('2026-08-15T01:00:00Z') };
  const sourceSentinel = path.join(base, 'source-sentinel.txt');
  const guidanceSentinel = path.join(base, 'guidance-sentinel.txt');
  fs.writeFileSync(sourceSentinel, 'source unchanged\n');
  fs.writeFileSync(guidanceSentinel, 'guidance unchanged\n');
  const options = {
    registry,
    stateRoot: path.join(base, 'owner-state'),
    now: () => clock.value,
    fetcher: safeFetcher({ [openaiSource.seedUrl]: { body: '# Empty fixture\n', headers: { 'content-type': 'text/plain', etag: 'service-v1' } } })
  };
  const service = new KnowledgeReviewService(options);
  assert.equal(typeof service.status, 'function');
  assert.equal(typeof service.preview, 'function');
  assert.equal(typeof service.enqueue, 'function');
  assert.equal(typeof service.runOnce, 'function');
  assert.equal(service.apply, undefined);
  assert.equal(service.promote, undefined);
  const preview = service.preview({ sourceIds: [openaiSource.id] });
  assert.equal(preview.requiresConfirmation, true);
  assert.equal(preview.writes.sourceOrGuidanceMutation, false);
  assert.equal(preview.agentBudget.modelCalls, 0);
  assert.throws(
    () => service.enqueue({ sourceIds: [openaiSource.id], requestId: 'manual-1', idempotencyKey: 'manual-1' }),
    error => error.code === 'confirmation_required'
  );
  const queued = service.enqueue({ sourceIds: [openaiSource.id], requestId: 'manual-1', idempotencyKey: 'manual-1', confirmed: true });
  const result = await service.runOnce(queued.job.jobId);
  assert.equal(result.job.state, 'completed');
  assert.equal(result.manifest.outcome, 'completed');
  assert.equal(result.manifest.automaticApply, false);
  assert.equal(result.manifest.promotionCount, 0);
  assert.equal(result.manifest.rollback.sourceOrGuidanceChanged, false);
  assert.equal(result.manifest.rollback.automaticRestore, false);
  assert.equal(service.store.rollbackPlan(result.manifest.rollback.cursorBackupId).apply, false);
  assert.ok(result.job.checkpoints.length >= 2);
  assert.equal(result.job.artifactRefs.length, 1);
  assert.equal(service.status().lastSuccessfulAt, new Date(clock.value).toISOString());
  const status = service.status();
  assert.equal(status.entryPolicy.staleAfterDays, 7);
  assert.equal(status.entryPolicy.backgroundSchedule, false);
  assert.equal(status.entryPolicy.automaticPromotion, false);
  assert.deepEqual(status.staleSourceIds, []);
  assert.equal(status.sources[0].freshness.stale, false);
  assert.equal(status.sources[0].freshness.lastSuccessfulCompletedAt, new Date(clock.value).toISOString());

  const restarted = new KnowledgeReviewService({ ...options, fetcher: safeFetcher({}) });
  const duplicate = restarted.enqueue({ sourceIds: [openaiSource.id], requestId: 'manual-1', idempotencyKey: 'manual-1', confirmed: true });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.job.jobId, queued.job.jobId);
  assert.equal((await restarted.runOnce(queued.job.jobId)).duplicate, true);
  assert.equal(fs.readFileSync(sourceSentinel, 'utf8'), 'source unchanged\n');
  assert.equal(fs.readFileSync(guidanceSentinel, 'utf8'), 'guidance unchanged\n');
});
