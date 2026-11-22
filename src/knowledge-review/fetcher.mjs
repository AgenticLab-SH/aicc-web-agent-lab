import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { assertPublicResolution, KnowledgePolicyError, validateOfficialUrl } from './policy.mjs';

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const RETRYABLE = new Set([500, 502, 503, 504]);

export class KnowledgeFetchError extends Error {
  constructor(code, message, { status = null, retryable = false, url = null } = {}) {
    super(message);
    this.name = 'KnowledgeFetchError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.url = url;
  }
}

export function normalizeKnowledgeText(input) {
  let text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, '\n');
  return `${text.replace(/\n+$/g, '')}\n`;
}

export function contentHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function contentType(headers) {
  return String(headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
}

async function readLimitedText(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new KnowledgeFetchError('response_too_large', 'source response exceeds its byte limit', { status: response.status });
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new KnowledgeFetchError('response_too_large', 'source response exceeds its byte limit', { status: response.status });
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new KnowledgeFetchError('response_too_large', 'source response exceeds its byte limit', { status: response.status });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function parseRobots(text, pathname) {
  let applies = false;
  const disallow = [];
  for (const rawLine of normalizeKnowledgeText(text).split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') applies = value === '*';
    else if (field === 'disallow' && applies && value) disallow.push(value);
  }
  return !disallow.some(prefix => pathname.startsWith(prefix));
}

function retryDelay(attempt) {
  return Math.min(250 * (2 ** (attempt - 1)), 1_000);
}

export class SafeOfficialFetcher {
  constructor({ fetchImpl = globalThis.fetch, resolveHost = (host) => dns.lookup(host, { all: true, verbatim: true }), robotsCheck = null, sleeper = ms => new Promise(resolve => setTimeout(resolve, ms)), maxAttempts = 3, maxRedirects = 3 } = {}) {
    if (typeof fetchImpl !== 'function') throw new KnowledgeFetchError('fetch_unavailable', 'a fetch implementation is required');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new KnowledgeFetchError('invalid_retry_policy', 'fetch attempts must be bounded between one and three');
    this.fetchImpl = fetchImpl;
    this.resolveHost = resolveHost;
    this.robotsCheck = robotsCheck;
    this.sleeper = sleeper;
    this.maxAttempts = maxAttempts;
    this.maxRedirects = maxRedirects;
    this.robotsCache = new Map();
  }

  async #assertNetworkTarget(source, url) {
    const canonical = validateOfficialUrl(source, url);
    let addresses;
    try { addresses = await this.resolveHost(new URL(canonical).hostname); }
    catch { throw new KnowledgeFetchError('dns_unverified', 'official host resolution failed', { url: canonical }); }
    try { assertPublicResolution(addresses); }
    catch (error) {
      if (error instanceof KnowledgePolicyError) throw new KnowledgeFetchError(error.code, error.message, { url: canonical });
      throw error;
    }
    return canonical;
  }

  async #request(source, url, { headers = {}, allowedContentTypes = source.contentTypes, maxBytes = source.maxBytes, allowNotModified = true } = {}) {
    let current = await this.#assertNetworkTarget(source, url);
    for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
      const response = await this.fetchImpl(current, { method: 'GET', headers, redirect: 'manual' });
      if (REDIRECTS.has(response.status)) {
        if (redirects === this.maxRedirects) throw new KnowledgeFetchError('redirect_limit', 'source redirect limit exceeded', { status: response.status, url: current });
        const location = response.headers.get('location');
        if (!location) throw new KnowledgeFetchError('redirect_invalid', 'source redirect has no location', { status: response.status, url: current });
        let redirected;
        try { redirected = validateOfficialUrl(source, new URL(location, current).toString(), { redirectFrom: current }); }
        catch (error) {
          if (error instanceof KnowledgePolicyError) throw new KnowledgeFetchError(error.code, error.message, { status: response.status, url: current });
          throw error;
        }
        current = await this.#assertNetworkTarget(source, redirected);
        continue;
      }
      if (allowNotModified && response.status === 304) return { status: 304, url: current, response, body: null };
      if (response.status === 403 || response.status === 429) {
        throw new KnowledgeFetchError(response.status === 403 ? 'http_403_hold' : 'http_429_hold', 'official source denied or rate-limited the request; bypass is prohibited', { status: response.status, retryable: false, url: current });
      }
      if (!response.ok) throw new KnowledgeFetchError('http_error', `official source returned HTTP ${response.status}`, { status: response.status, retryable: RETRYABLE.has(response.status), url: current });
      const type = contentType(response.headers);
      if (!allowedContentTypes.includes(type)) throw new KnowledgeFetchError('content_type_denied', `source content type is not allowed: ${type || 'missing'}`, { status: response.status, url: current });
      const body = await readLimitedText(response, maxBytes);
      return { status: response.status, url: current, response, body };
    }
    throw new KnowledgeFetchError('redirect_limit', 'source redirect limit exceeded', { url: current });
  }

  async #robotsAllowed(source, url) {
    if (typeof this.robotsCheck === 'function') return this.robotsCheck({ source: structuredClone(source), url });
    const target = new URL(url);
    const key = target.origin;
    if (!this.robotsCache.has(key)) {
      const robotsSource = { ...source, allowedPathPrefixes: ['/robots.txt'], contentTypes: ['text/plain'], maxBytes: 256 * 1024 };
      const pending = this.#request(robotsSource, `${target.origin}/robots.txt`, { allowNotModified: false })
        .then(result => ({ status: result.status, text: result.body.toString('utf8') }))
        .catch(error => {
          if (error.status === 404) return { status: 404, text: '' };
          throw error;
        });
      this.robotsCache.set(key, pending);
    }
    const robots = await this.robotsCache.get(key);
    return robots.status === 404 || parseRobots(robots.text, target.pathname);
  }

  async fetch(source, url, cursor = null) {
    const canonical = validateOfficialUrl(source, url);
    const allowed = await this.#robotsAllowed(source, canonical);
    if (allowed !== true) throw new KnowledgeFetchError('robots_disallowed', 'robots policy disallows this source path; bypass is prohibited', { url: canonical });
    const headers = { accept: source.contentTypes.join(', ') };
    if (cursor?.etag) headers['if-none-match'] = cursor.etag;
    if (cursor?.lastModified) headers['if-modified-since'] = cursor.lastModified;
    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const result = await this.#request(source, canonical, { headers });
        if (result.status === 304) {
          if (!cursor?.contentHash) throw new KnowledgeFetchError('invalid_not_modified', '304 response has no durable prior content hash', { status: 304, url: canonical });
          return { status: 304, canonicalUrl: result.url, attempts: attempt, etag: cursor?.etag ?? null, lastModified: cursor?.lastModified ?? null, text: null, contentHash: cursor?.contentHash ?? null };
        }
        const text = normalizeKnowledgeText(result.body);
        return {
          status: result.status,
          canonicalUrl: result.url,
          attempts: attempt,
          etag: result.response.headers.get('etag'),
          lastModified: result.response.headers.get('last-modified'),
          text,
          contentHash: contentHash(text)
        };
      } catch (error) {
        lastError = error instanceof KnowledgeFetchError ? error : new KnowledgeFetchError('network_error', 'official source request failed', { retryable: true, url: canonical });
        if (!lastError.retryable || attempt === this.maxAttempts) throw lastError;
        await this.sleeper(retryDelay(attempt));
      }
    }
    throw lastError;
  }
}

export function discoverOfficialLinks(source, text, baseUrl) {
  const candidates = [];
  if (source.kind === 'canonical-html-seed') {
    for (const match of String(text).matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) candidates.push(match[1]);
  } else {
    for (const match of String(text).matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) candidates.push(match[1]);
    for (const match of String(text).matchAll(/<(https:\/\/[^>\s]+)>/g)) candidates.push(match[1]);
  }
  const accepted = [];
  const rejected = [];
  for (const candidate of candidates) {
    try {
      const canonical = validateOfficialUrl(source, new URL(candidate, baseUrl).toString());
      if (canonical !== validateOfficialUrl(source, source.seedUrl)) accepted.push(canonical);
    } catch (error) {
      rejected.push({ candidate: String(candidate).slice(0, 300), code: error.code ?? 'invalid_url' });
    }
  }
  return { accepted: [...new Set(accepted)].sort(), rejected };
}
