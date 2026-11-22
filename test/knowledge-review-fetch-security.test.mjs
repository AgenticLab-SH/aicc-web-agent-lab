import assert from 'node:assert/strict';
import test from 'node:test';
import { SafeOfficialFetcher } from '../src/knowledge-review/fetcher.mjs';
import { OFFICIAL_SOURCE_REGISTRY } from '../src/knowledge-review/policy.mjs';
import { fakeFetch, publicResolution } from './fixtures/knowledge-review/fake-fetch.mjs';

const source = OFFICIAL_SOURCE_REGISTRY.sources[0];

function fetcher(routes, calls = [], options = {}) {
  return new SafeOfficialFetcher({
    fetchImpl: fakeFetch(routes, calls),
    resolveHost: publicResolution,
    robotsCheck: async () => true,
    sleeper: async () => {},
    ...options
  });
}

test('conditional fetch sends ETag and Last-Modified and preserves a 304 content hash', async () => {
  const calls = [];
  const client = fetcher({ [source.seedUrl]: { status: 304, headers: { etag: 'v1' } } }, calls);
  const result = await client.fetch(source, source.seedUrl, { etag: 'v1', lastModified: 'Fri, 15 Aug 2026 00:00:00 GMT', contentHash: 'a'.repeat(64) });
  assert.equal(result.status, 304);
  assert.equal(result.contentHash, 'a'.repeat(64));
  assert.equal(calls[0].options.headers['if-none-match'], 'v1');
  assert.equal(calls[0].options.headers['if-modified-since'], 'Fri, 15 Aug 2026 00:00:00 GMT');
  assert.equal(calls[0].options.redirect, 'manual');
  await assert.rejects(
    fetcher({ [source.seedUrl]: { status: 304, headers: { etag: 'orphan' } } }).fetch(source, source.seedUrl),
    error => error.code === 'invalid_not_modified'
  );
});

test('cross-host redirects and HTTPS downgrades are rejected without following', async () => {
  for (const location of ['https://learn.chatgpt.com/llms.txt', 'http://developers.openai.com/llms.txt']) {
    const calls = [];
    const client = fetcher({ [source.seedUrl]: { status: 302, headers: { location } } }, calls);
    await assert.rejects(client.fetch(source, source.seedUrl), error => ['cross_host_redirect', 'https_downgrade'].includes(error.code));
    assert.equal(calls.length, 1);
  }
});

test('private DNS answers fail before the HTTP client is called', async () => {
  const calls = [];
  const client = fetcher({}, calls, { resolveHost: async () => [{ address: '127.0.0.1', family: 4 }] });
  await assert.rejects(client.fetch(source, source.seedUrl), error => error.code === 'private_address_denied');
  assert.equal(calls.length, 0);
});

test('robots denial is terminal and cannot be bypassed', async () => {
  const calls = [];
  const client = fetcher({}, calls, { robotsCheck: async () => false });
  await assert.rejects(client.fetch(source, source.seedUrl), error => error.code === 'robots_disallowed');
  assert.equal(calls.length, 0);

  const defaultCalls = [];
  const defaultClient = new SafeOfficialFetcher({
    fetchImpl: fakeFetch({
      'https://developers.openai.com/robots.txt': { body: 'User-agent: *\nDisallow: /llms.txt\n', headers: { 'content-type': 'text/plain' } },
      [source.seedUrl]: { body: 'must not be fetched', headers: { 'content-type': 'text/plain' } }
    }, defaultCalls),
    resolveHost: publicResolution,
    sleeper: async () => {}
  });
  await assert.rejects(defaultClient.fetch(source, source.seedUrl), error => error.code === 'robots_disallowed');
  assert.deepEqual(defaultCalls.map(call => call.url), ['https://developers.openai.com/robots.txt']);
});

test('content type and size limits fail closed', async () => {
  await assert.rejects(
    fetcher({ [source.seedUrl]: { body: '{}', headers: { 'content-type': 'application/json' } } }).fetch(source, source.seedUrl),
    error => error.code === 'content_type_denied'
  );
  await assert.rejects(
    fetcher({ [source.seedUrl]: { body: 'small', headers: { 'content-type': 'text/plain', 'content-length': String(source.maxBytes + 1) } } }).fetch(source, source.seedUrl),
    error => error.code === 'response_too_large'
  );
  const tinySource = { ...source, maxBytes: 4 };
  await assert.rejects(
    fetcher({ [source.seedUrl]: { body: '12345', headers: { 'content-type': 'text/plain' } } }).fetch(tinySource, source.seedUrl),
    error => error.code === 'response_too_large'
  );
});

test('network and 5xx retries are bounded while 403 and 429 are never retried', async () => {
  const retryCalls = [];
  const retryClient = fetcher({
    [source.seedUrl]: [new Error('synthetic network failure'), { status: 503, headers: { 'content-type': 'text/plain' } }, { body: 'ok\r\n', headers: { 'content-type': 'text/plain' } }]
  }, retryCalls);
  const recovered = await retryClient.fetch(source, source.seedUrl);
  assert.equal(recovered.text, 'ok\n');
  assert.equal(recovered.attempts, 3);
  assert.equal(retryCalls.length, 3);

  for (const status of [403, 429]) {
    const calls = [];
    const client = fetcher({ [source.seedUrl]: { status, headers: { 'content-type': 'text/plain' } } }, calls);
    await assert.rejects(client.fetch(source, source.seedUrl), error => error.status === status && error.retryable === false);
    assert.equal(calls.length, 1);
  }
});
