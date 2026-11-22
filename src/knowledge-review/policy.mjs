import net from 'node:net';
import path from 'node:path';

const SOURCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRIVATE_PATH_SEGMENTS = new Set([
  '.ssh', '.gnupg', '.aws', '.codex', '.codex-multi', '.codex-chatgpt-web', '.opencodex',
  'keychains', 'cookies', 'chrome', 'chromium', 'firefox', 'safari', 'browser profiles',
  'login data', 'local state'
]);

export class KnowledgePolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KnowledgePolicyError';
    this.code = code;
  }
}

export const OFFICIAL_SOURCE_REGISTRY = Object.freeze({
  schemaVersion: 1,
  manualOnly: true,
  automaticApply: false,
  sources: Object.freeze([
    Object.freeze({
      id: 'openai-developers',
      label: 'OpenAI Developers',
      kind: 'llms-index',
      seedUrl: 'https://developers.openai.com/llms.txt',
      allowedHosts: Object.freeze(['developers.openai.com']),
      allowedPathPrefixes: Object.freeze([
        '/llms.txt', '/api/', '/ads/', '/plugins/', '/workspace-agents/', '/commerce/',
        '/cookbook/', '/learn/', '/showcase/'
      ]),
      excludedUrls: Object.freeze([
        'https://developers.openai.com/api/reference/resources/beta/subresources/responses/streaming-events.md',
        'https://developers.openai.com/api/reference/resources/beta/subresources/responses/websocket-events.md',
        'https://developers.openai.com/api/reference/resources/responses.md',
        'https://developers.openai.com/api/reference/resources/responses/streaming-events.md',
        'https://developers.openai.com/api/reference/resources/responses/websocket-events.md',
        'https://developers.openai.com/cookbook/examples/agents_sdk/computer_use_with_daytona/computer_use_with_daytona.md',
        'https://developers.openai.com/cookbook/examples/partners/mcp_powered_voice_agents/mcp_powered_agents_cookbook.md'
      ]),
      contentTypes: Object.freeze(['text/plain', 'text/markdown']),
      maxPages: 2_000,
      maxBytes: 2 * 1024 * 1024,
      manualOnly: true,
      automaticApply: false
    }),
    Object.freeze({
      id: 'openai-latest-model-guide',
      label: 'OpenAI Latest Model Guide',
      kind: 'single-document',
      seedUrl: 'https://developers.openai.com/api/docs/guides/latest-model',
      allowedHosts: Object.freeze(['developers.openai.com']),
      allowedPathPrefixes: Object.freeze(['/api/docs/guides/latest-model']),
      contentTypes: Object.freeze(['text/html']),
      maxPages: 1,
      maxBytes: 2 * 1024 * 1024,
      manualOnly: true,
      automaticApply: false
    }),
    Object.freeze({
      id: 'openai-chatgpt',
      label: 'OpenAI ChatGPT and Codex',
      kind: 'llms-index',
      seedUrl: 'https://learn.chatgpt.com/llms.txt',
      allowedHosts: Object.freeze(['learn.chatgpt.com']),
      allowedPathPrefixes: Object.freeze(['/llms.txt', '/docs/']),
      contentTypes: Object.freeze(['text/plain', 'text/markdown', 'application/octet-stream']),
      maxPages: 2_000,
      maxBytes: 3 * 1024 * 1024,
      manualOnly: true,
      automaticApply: false
    }),
    Object.freeze({
      id: 'openai-developer-blog',
      label: 'OpenAI Developer Blog',
      kind: 'canonical-html-seed',
      seedUrl: 'https://learn.chatgpt.com/blog',
      allowedHosts: Object.freeze(['learn.chatgpt.com']),
      allowedPathPrefixes: Object.freeze(['/blog']),
      contentTypes: Object.freeze(['text/html']),
      maxPages: 500,
      maxBytes: 2 * 1024 * 1024,
      manualOnly: true,
      automaticApply: false
    }),
    Object.freeze({
      id: 'openai-news',
      label: 'OpenAI News Feed',
      kind: 'single-document',
      seedUrl: 'https://openai.com/news/rss.xml',
      allowedHosts: Object.freeze(['openai.com']),
      allowedPathPrefixes: Object.freeze(['/news/rss.xml']),
      contentTypes: Object.freeze(['application/rss+xml', 'application/xml', 'text/xml']),
      maxPages: 1,
      maxBytes: 2 * 1024 * 1024,
      manualOnly: true,
      automaticApply: false
    }),
    Object.freeze({
      id: 'anthropic-platform',
      label: 'Anthropic Platform',
      kind: 'llms-index',
      seedUrl: 'https://platform.claude.com/llms.txt',
      allowedHosts: Object.freeze(['platform.claude.com']),
      allowedPathPrefixes: Object.freeze(['/llms.txt', '/llms-full.txt', '/docs/']),
      excludedUrls: Object.freeze([
        'https://platform.claude.com/docs/en/api/beta.md',
        'https://platform.claude.com/docs/en/api/compliance.md',
        'https://platform.claude.com/docs/en/api/compliance/activities.md',
        'https://platform.claude.com/docs/en/api/compliance/activities/list.md'
      ]),
      contentTypes: Object.freeze(['text/plain', 'text/markdown']),
      maxPages: 2_000,
      maxBytes: 2 * 1024 * 1024,
      manualOnly: true,
      automaticApply: false
    }),
    Object.freeze({
      id: 'anthropic-claude-code',
      label: 'Anthropic Claude Code',
      kind: 'llms-index',
      seedUrl: 'https://code.claude.com/llms.txt',
      allowedHosts: Object.freeze(['code.claude.com']),
      allowedPathPrefixes: Object.freeze(['/llms.txt', '/docs/']),
      contentTypes: Object.freeze(['text/plain', 'text/markdown']),
      maxPages: 2_000,
      maxBytes: 2 * 1024 * 1024,
      manualOnly: true,
      automaticApply: false
    }),
    Object.freeze({
      id: 'anthropic-academy-sdlc',
      label: 'Anthropic Claude Academy AI-Native SDLC',
      kind: 'canonical-html-seed',
      seedUrl: 'https://academy.claude.com/courses/ai-native-sdlc-playbook/capture-intent',
      allowedHosts: Object.freeze(['academy.claude.com']),
      allowedPathPrefixes: Object.freeze(['/courses/ai-native-sdlc-playbook']),
      contentTypes: Object.freeze(['text/html']),
      maxPages: 100,
      maxBytes: 2 * 1024 * 1024,
      manualOnly: true,
      automaticApply: false
    }),
    Object.freeze({
      id: 'anthropic-claude-blog',
      label: 'Claude Blog',
      kind: 'canonical-html-seed',
      seedUrl: 'https://claude.com/blog',
      allowedHosts: Object.freeze(['claude.com']),
      allowedPathPrefixes: Object.freeze(['/blog']),
      contentTypes: Object.freeze(['text/html']),
      maxPages: 500,
      maxBytes: 2 * 1024 * 1024,
      manualOnly: true,
      automaticApply: false
    }),
    Object.freeze({
      id: 'anthropic-engineering',
      label: 'Anthropic Engineering',
      kind: 'canonical-html-seed',
      seedUrl: 'https://www.anthropic.com/engineering',
      allowedHosts: Object.freeze(['www.anthropic.com']),
      allowedPathPrefixes: Object.freeze(['/engineering']),
      excludedUrls: Object.freeze(['https://www.anthropic.com/engineering/claude-code-best-practices']),
      contentTypes: Object.freeze(['text/html']),
      maxPages: 500,
      maxBytes: 2 * 1024 * 1024,
      manualOnly: true,
      automaticApply: false
    })
  ])
});

export const KNOWLEDGE_REVIEW_ENTRY_POLICY = Object.freeze({
  schemaVersion: 1,
  statusReadOnlyFirst: true,
  staleAfterDays: 7,
  staleAfterMilliseconds: 7 * 24 * 60 * 60 * 1_000,
  explicitRequest: Object.freeze({ run: 'one-shot', sourceScope: 'exact-requested-sources' }),
  relatedTaskEntry: Object.freeze({ run: 'only-when-stale-or-signalled', sourceScope: 'exact-affected-sources' }),
  importantChangelogSignal: 'exact-affected-sources-only',
  partialSuccess: 'advance-completed-source-checkpoints-only',
  backgroundSchedule: false,
  automaticPromotion: false,
  automaticApply: false
});

export function evaluateKnowledgeReviewEntry({
  sourceStates,
  affectedSourceIds,
  importantChangelogSourceIds = [],
  trigger = 'related-task-entry',
  now = Date.now()
} = {}) {
  if (!Array.isArray(sourceStates) || !Array.isArray(affectedSourceIds) || affectedSourceIds.length === 0) {
    throw new KnowledgePolicyError('invalid_entry_scope', 'knowledge review entry requires source states and at least one exact affected source');
  }
  if (!['explicit-request', 'related-task-entry'].includes(trigger)) {
    throw new KnowledgePolicyError('invalid_entry_trigger', 'knowledge review entry trigger is invalid');
  }
  const nowMilliseconds = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMilliseconds)) throw new KnowledgePolicyError('invalid_entry_time', 'knowledge review entry time is invalid');
  const states = new Map(sourceStates.map(state => [state?.sourceId, state]));
  const affected = [...new Set(affectedSourceIds)];
  const signals = new Set(importantChangelogSourceIds);
  for (const sourceId of [...affected, ...signals]) {
    if (typeof sourceId !== 'string' || !states.has(sourceId)) {
      throw new KnowledgePolicyError('entry_source_not_found', `knowledge review entry source is unknown: ${sourceId}`);
    }
  }
  for (const sourceId of signals) {
    if (!affected.includes(sourceId)) {
      throw new KnowledgePolicyError('entry_signal_out_of_scope', `important changelog signal is outside the affected source scope: ${sourceId}`);
    }
  }
  const sources = affected.map(sourceId => {
    const state = states.get(sourceId);
    const lastSuccessfulCompletedAt = state.lastSuccessfulCompletedAt ?? state.lastCompletedAt ?? null;
    const completedMilliseconds = lastSuccessfulCompletedAt === null ? Number.NaN : Date.parse(lastSuccessfulCompletedAt);
    const ageMilliseconds = Number.isFinite(completedMilliseconds) ? Math.max(0, nowMilliseconds - completedMilliseconds) : null;
    const stale = ageMilliseconds === null || ageMilliseconds > KNOWLEDGE_REVIEW_ENTRY_POLICY.staleAfterMilliseconds;
    const importantChangelogSignal = signals.has(sourceId);
    const shouldRun = trigger === 'explicit-request' || stale || importantChangelogSignal;
    const reason = trigger === 'explicit-request'
      ? 'explicit-request'
      : importantChangelogSignal ? 'important-changelog-signal' : stale ? 'stale' : 'current';
    return {
      sourceId,
      lastSuccessfulCompletedAt,
      ageMilliseconds,
      stale,
      importantChangelogSignal,
      shouldRun,
      reason
    };
  });
  return {
    schemaVersion: 1,
    trigger,
    statusReadOnlyFirst: true,
    sourceIdsToRun: sources.filter(source => source.shouldRun).map(source => source.sourceId),
    current: sources.every(source => !source.shouldRun),
    sources,
    backgroundSchedule: false,
    automaticPromotion: false,
    automaticApply: false
  };
}

function prefixAllows(pathname, prefix) {
  if (prefix.endsWith('/')) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function validateSourceRegistry(registry = OFFICIAL_SOURCE_REGISTRY) {
  if (registry?.schemaVersion !== 1 || registry.manualOnly !== true || registry.automaticApply !== false || !Array.isArray(registry.sources)) {
    throw new KnowledgePolicyError('invalid_registry', 'knowledge source registry must be manual-only schema version 1');
  }
  const ids = new Set();
  for (const source of registry.sources) {
    if (!SOURCE_ID.test(source?.id ?? '') || ids.has(source.id)) throw new KnowledgePolicyError('invalid_source', 'source id must be unique and portable');
    ids.add(source.id);
    if (source.manualOnly !== true || source.automaticApply !== false) throw new KnowledgePolicyError('automatic_apply_prohibited', `source ${source.id} must remain manual-only`);
    if (!Array.isArray(source.allowedHosts) || source.allowedHosts.length !== 1 || !Array.isArray(source.allowedPathPrefixes) || source.allowedPathPrefixes.length === 0) {
      throw new KnowledgePolicyError('invalid_source_scope', `source ${source.id} requires one exact official host and explicit path prefixes`);
    }
    validateOfficialUrl(source, source.seedUrl);
    if (source.excludedUrls !== undefined) {
      if (!Array.isArray(source.excludedUrls) || new Set(source.excludedUrls).size !== source.excludedUrls.length) {
        throw new KnowledgePolicyError('invalid_source_exclusions', `source ${source.id} exclusions must be unique URLs`);
      }
      for (const excludedUrl of source.excludedUrls) validateOfficialUrl(source, excludedUrl);
    }
  }
  return structuredClone(registry);
}

export function validateOfficialUrl(source, input, { redirectFrom = null } = {}) {
  let url;
  try { url = new URL(input); }
  catch { throw new KnowledgePolicyError('invalid_url', 'source URL is invalid'); }
  if (url.protocol !== 'https:') throw new KnowledgePolicyError(url.protocol === 'http:' ? 'https_downgrade' : 'scheme_denied', 'only HTTPS official sources are allowed');
  if (url.username || url.password) throw new KnowledgePolicyError('url_credentials_denied', 'source URL credentials are prohibited');
  if (url.port && url.port !== '443') throw new KnowledgePolicyError('port_denied', 'source URL must use the default HTTPS port');
  if (url.search) throw new KnowledgePolicyError('query_denied', 'source URL query aliases are not allowed');
  const host = url.hostname.toLowerCase();
  if (!source.allowedHosts.includes(host)) throw new KnowledgePolicyError(redirectFrom ? 'cross_host_redirect' : 'host_denied', `host is outside source ${source.id}`);
  if (redirectFrom && new URL(redirectFrom).hostname.toLowerCase() !== host) throw new KnowledgePolicyError('cross_host_redirect', 'redirects may not change host');
  if (!source.allowedPathPrefixes.some(prefix => prefixAllows(url.pathname, prefix))) {
    throw new KnowledgePolicyError('path_scope_denied', `path is outside source ${source.id}`);
  }
  url.hash = '';
  return url.toString();
}

function ipv4Private(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return ipv4Private(address);
  if (family !== 6) return true;
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('2001:db8:')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  return mapped ? ipv4Private(mapped[1]) : false;
}

export function assertPublicResolution(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) throw new KnowledgePolicyError('dns_unverified', 'official host resolution is unavailable');
  for (const entry of addresses) {
    const address = typeof entry === 'string' ? entry : entry?.address;
    if (!address || isPrivateAddress(address)) throw new KnowledgePolicyError('private_address_denied', 'private, loopback, link-local, or reserved addresses are denied');
  }
  return true;
}

export function assertSafeOwnerRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new KnowledgePolicyError('invalid_owner_root', 'knowledge owner root must be absolute');
  const normalized = path.resolve(root);
  const segments = normalized.split(path.sep).filter(Boolean).map(segment => segment.toLowerCase());
  if (segments.some(segment => PRIVATE_PATH_SEGMENTS.has(segment))) {
    throw new KnowledgePolicyError('sensitive_path_denied', 'knowledge state cannot be placed inside authentication, session, browser, or credential storage');
  }
  return normalized;
}

export function sourceById(registry, sourceId) {
  const source = validateSourceRegistry(registry).sources.find(item => item.id === sourceId);
  if (!source) throw new KnowledgePolicyError('source_not_found', `unknown source: ${sourceId}`);
  return source;
}
