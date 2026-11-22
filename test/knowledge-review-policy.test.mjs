import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertPublicResolution,
  assertSafeOwnerRoot,
  evaluateKnowledgeReviewEntry,
  KNOWLEDGE_REVIEW_ENTRY_POLICY,
  OFFICIAL_SOURCE_REGISTRY,
  validateOfficialUrl,
  validateSourceRegistry
} from '../src/knowledge-review/policy.mjs';
import { contentHash, discoverOfficialLinks, normalizeKnowledgeText } from '../src/knowledge-review/fetcher.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(here, 'fixtures', 'knowledge-review');
const contractRoot = path.join(here, '..', 'contracts', 'knowledge-review');

test('task entry is status-first and selects only stale or signalled exact sources', () => {
  const now = Date.parse('2026-08-30T02:40:00Z');
  const sevenDays = KNOWLEDGE_REVIEW_ENTRY_POLICY.staleAfterMilliseconds;
  const sourceStates = [
    { sourceId: 'current', lastSuccessfulCompletedAt: new Date(now - sevenDays).toISOString(), lastOutcome: 'partial' },
    { sourceId: 'stale', lastSuccessfulCompletedAt: new Date(now - sevenDays - 1).toISOString(), lastOutcome: 'completed' },
    { sourceId: 'signalled', lastSuccessfulCompletedAt: new Date(now - 1_000).toISOString(), lastOutcome: 'completed' }
  ];
  const entry = evaluateKnowledgeReviewEntry({
    sourceStates,
    affectedSourceIds: ['current', 'stale', 'signalled'],
    importantChangelogSourceIds: ['signalled'],
    now
  });
  assert.equal(entry.statusReadOnlyFirst, true);
  assert.deepEqual(entry.sourceIdsToRun, ['stale', 'signalled']);
  assert.equal(entry.sources[0].stale, false);
  assert.equal(entry.sources[0].lastSuccessfulCompletedAt, sourceStates[0].lastSuccessfulCompletedAt);
  assert.equal(entry.backgroundSchedule, false);
  assert.equal(entry.automaticPromotion, false);
  assert.equal(entry.automaticApply, false);
  const explicit = evaluateKnowledgeReviewEntry({ sourceStates, affectedSourceIds: ['current'], trigger: 'explicit-request', now });
  assert.deepEqual(explicit.sourceIdsToRun, ['current']);
  assert.throws(
    () => evaluateKnowledgeReviewEntry({ sourceStates, affectedSourceIds: ['current'], importantChangelogSourceIds: ['signalled'], now }),
    error => error.code === 'entry_signal_out_of_scope'
  );
});

test('registry pins official docs and blog seeds with exact host boundaries', () => {
  const registry = validateSourceRegistry(OFFICIAL_SOURCE_REGISTRY);
  assert.equal(registry.manualOnly, true);
  assert.equal(registry.automaticApply, false);
  assert.deepEqual(registry.sources.map(source => source.seedUrl), [
    'https://developers.openai.com/llms.txt',
    'https://developers.openai.com/api/docs/guides/latest-model',
    'https://learn.chatgpt.com/llms.txt',
    'https://learn.chatgpt.com/blog',
    'https://openai.com/news/rss.xml',
    'https://platform.claude.com/llms.txt',
    'https://code.claude.com/llms.txt',
    'https://academy.claude.com/courses/ai-native-sdlc-playbook/capture-intent',
    'https://claude.com/blog',
    'https://www.anthropic.com/engineering'
  ]);
  const openai = registry.sources[0];
  for (const prefix of ['/api/', '/ads/', '/plugins/', '/workspace-agents/', '/commerce/', '/cookbook/', '/learn/', '/showcase/']) {
    assert.ok(openai.allowedPathPrefixes.includes(prefix), prefix);
  }
  assert.ok(!openai.allowedPathPrefixes.includes('/blog/'));
  assert.ok(!openai.allowedPathPrefixes.includes('/codex/'));
  assert.ok(!openai.allowedPathPrefixes.includes('/apps-sdk/'));
  assert.ok(!openai.allowedHosts.includes('learn.chatgpt.com'));
  assert.equal(openai.excludedUrls.length, 7);
  assert.ok(openai.excludedUrls.every(url => url.startsWith('https://developers.openai.com/')));
  const latestModel = registry.sources.find(source => source.id === 'openai-latest-model-guide');
  assert.deepEqual(latestModel.allowedHosts, ['developers.openai.com']);
  assert.deepEqual(latestModel.allowedPathPrefixes, ['/api/docs/guides/latest-model']);
  assert.deepEqual(latestModel.contentTypes, ['text/html']);
  assert.equal(latestModel.kind, 'single-document');
  assert.equal(latestModel.maxPages, 1);
  const chatgpt = registry.sources.find(source => source.id === 'openai-chatgpt');
  assert.deepEqual(chatgpt.allowedHosts, ['learn.chatgpt.com']);
  assert.deepEqual(chatgpt.allowedPathPrefixes, ['/llms.txt', '/docs/']);
  assert.deepEqual(chatgpt.contentTypes, ['text/plain', 'text/markdown', 'application/octet-stream']);
  assert.equal(chatgpt.maxBytes, 3 * 1024 * 1024);
  assert.ok(!chatgpt.allowedHosts.includes('developers.openai.com'));
  const openaiBlog = registry.sources.find(source => source.id === 'openai-developer-blog');
  assert.deepEqual(openaiBlog.allowedHosts, ['learn.chatgpt.com']);
  assert.deepEqual(openaiBlog.allowedPathPrefixes, ['/blog']);
  assert.equal(openaiBlog.kind, 'canonical-html-seed');
  const openaiNews = registry.sources.find(source => source.id === 'openai-news');
  assert.deepEqual(openaiNews.allowedHosts, ['openai.com']);
  assert.deepEqual(openaiNews.allowedPathPrefixes, ['/news/rss.xml']);
  assert.equal(openaiNews.kind, 'single-document');
  assert.equal(openaiNews.maxPages, 1);
  const anthropic = registry.sources.find(source => source.id === 'anthropic-platform');
  assert.equal(anthropic.excludedUrls.length, 4);
  assert.ok(anthropic.excludedUrls.every(url => url.startsWith('https://platform.claude.com/')));
  const claudeCode = registry.sources.find(source => source.id === 'anthropic-claude-code');
  assert.deepEqual(claudeCode.allowedHosts, ['code.claude.com']);
  assert.deepEqual(claudeCode.allowedPathPrefixes, ['/llms.txt', '/docs/']);
  const academy = registry.sources.find(source => source.id === 'anthropic-academy-sdlc');
  assert.deepEqual(academy.allowedHosts, ['academy.claude.com']);
  assert.deepEqual(academy.allowedPathPrefixes, ['/courses/ai-native-sdlc-playbook']);
  assert.equal(academy.kind, 'canonical-html-seed');
  const claudeBlog = registry.sources.find(source => source.id === 'anthropic-claude-blog');
  assert.deepEqual(claudeBlog.allowedHosts, ['claude.com']);
  assert.deepEqual(claudeBlog.allowedPathPrefixes, ['/blog']);
  assert.equal(claudeBlog.kind, 'canonical-html-seed');
  const engineering = registry.sources.find(source => source.id === 'anthropic-engineering');
  assert.deepEqual(engineering.excludedUrls, ['https://www.anthropic.com/engineering/claude-code-best-practices']);
});

test('registry rejects duplicate or out-of-scope exact exclusions', () => {
  const source = OFFICIAL_SOURCE_REGISTRY.sources[0];
  for (const [excludedUrls, code] of [
    [[source.seedUrl, source.seedUrl], 'invalid_source_exclusions'],
    [['https://example.invalid/page.md'], 'host_denied']
  ]) {
    const registry = { ...OFFICIAL_SOURCE_REGISTRY, sources: [{ ...source, excludedUrls }] };
    assert.throws(() => validateSourceRegistry(registry), error => error.code === code);
  }
});

test('official URL policy rejects scheme, host, redirect, port, query, and path escapes', () => {
  const source = OFFICIAL_SOURCE_REGISTRY.sources[0];
  assert.equal(validateOfficialUrl(source, source.seedUrl), source.seedUrl);
  for (const [url, code] of [
    ['http://developers.openai.com/llms.txt', 'https_downgrade'],
    ['file:///etc/passwd', 'scheme_denied'],
    ['https://developers.openai.com:8443/llms.txt', 'port_denied'],
    ['https://developers.openai.com/llms.txt?redirect=1', 'query_denied'],
    ['https://developers.openai.com/private/secret.md', 'path_scope_denied'],
    ['https://learn.chatgpt.com/llms.txt', 'host_denied']
  ]) assert.throws(() => validateOfficialUrl(source, url), error => error.code === code, url);
  assert.throws(
    () => validateOfficialUrl(source, 'https://learn.chatgpt.com/llms.txt', { redirectFrom: source.seedUrl }),
    error => error.code === 'cross_host_redirect'
  );
});

test('private and reserved resolutions plus sensitive owner roots are denied', () => {
  for (const address of ['127.0.0.1', '10.0.0.4', '169.254.1.2', '192.168.1.3', '::1', 'fd00::1', 'fe80::1']) {
    assert.throws(() => assertPublicResolution([{ address }]), error => error.code === 'private_address_denied', address);
  }
  assert.equal(assertPublicResolution([{ address: '93.184.216.34' }]), true);
  for (const root of ['/tmp/.ssh/knowledge', '/tmp/Keychains/knowledge', '/tmp/.codex/sessions/knowledge', '/tmp/Chrome/knowledge']) {
    assert.throws(() => assertSafeOwnerRoot(root), error => error.code === 'sensitive_path_denied', root);
  }
});

test('normalization removes BOM, canonicalizes line endings, and adds one final newline', () => {
  const normalized = normalizeKnowledgeText('\ufeffalpha\r\nbeta\rgamma\n\n');
  assert.equal(normalized, 'alpha\nbeta\ngamma\n');
  assert.equal(contentHash(normalized).length, 64);
});

test('synthetic indexes discover only same-host allowlisted links', () => {
  const source = OFFICIAL_SOURCE_REGISTRY.sources[0];
  const fixture = fs.readFileSync(path.join(fixtureRoot, 'openai-root.txt'), 'utf8');
  const links = discoverOfficialLinks(source, fixture, source.seedUrl);
  assert.equal(links.accepted.length, 3);
  assert.deepEqual(links.rejected.map(item => item.code), ['path_scope_denied', 'host_denied']);
  assert.ok(links.accepted.includes('https://developers.openai.com/plugins/llms.txt'));
});

test('official blog indexes discover only exact-host article links', () => {
  for (const sourceId of ['openai-developer-blog', 'anthropic-claude-blog']) {
    const source = OFFICIAL_SOURCE_REGISTRY.sources.find(item => item.id === sourceId);
    const host = source.allowedHosts[0];
    const html = `<a href="/blog/example-article">ok</a><a href="https://${host}/about">out</a><a href="https://example.invalid/blog/no">no</a>`;
    const links = discoverOfficialLinks(source, html, source.seedUrl);
    assert.deepEqual(links.accepted, [`https://${host}/blog/example-article`]);
    assert.deepEqual(links.rejected.map(item => item.code), ['path_scope_denied', 'host_denied']);
  }
});

test('knowledge-review contract roots are portable draft 2020-12 schemas', () => {
  const files = fs.readdirSync(contractRoot).filter(file => file.endsWith('.schema.json'));
  assert.deepEqual(files.sort(), ['candidate.schema.json', 'decision-event.schema.json', 'run-manifest.schema.json', 'source-registry.schema.json']);
  for (const file of files) {
    const schema = JSON.parse(fs.readFileSync(path.join(contractRoot, file), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, true);
  }
});
