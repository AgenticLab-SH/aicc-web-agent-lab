import crypto from 'node:crypto';

const NOTION_API_VERSION = '2026-03-11';
const UUIDISH = /^[a-f0-9]{32}$|^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export class NotionAssetConnectorError extends Error {
  constructor(code, message, { status = null, effectMayHaveOccurred = false } = {}) {
    super(message);
    this.name = 'NotionAssetConnectorError';
    this.code = code;
    this.status = status;
    this.effectMayHaveOccurred = effectMayHaveOccurred;
  }
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new NotionAssetConnectorError('config_invalid', `${label} is required`);
  return value.trim();
}

function plainText(items) {
  return Array.isArray(items) ? items.map(item => item?.plain_text ?? item?.text?.content ?? '').join('') : '';
}

function propertyValue(property) {
  if (!property || typeof property !== 'object') return null;
  switch (property.type) {
    case 'title': return plainText(property.title);
    case 'rich_text': return plainText(property.rich_text);
    case 'number': return property.number;
    case 'select': return property.select?.name ?? null;
    case 'status': return property.status?.name ?? null;
    case 'url': return property.url ?? null;
    case 'checkbox': return property.checkbox === true;
    case 'date': return property.date?.start ?? null;
    case 'unique_id': return property.unique_id ? `${property.unique_id.prefix ?? ''}${property.unique_id.number}` : null;
    default: return null;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function encodeProperty(schema, value) {
  if (!schema?.type) throw new NotionAssetConnectorError('schema_mismatch', 'Notion property schema is missing');
  if (value === null || value === undefined) {
    if (schema.type === 'title') return { title: [] };
    if (schema.type === 'rich_text') return { rich_text: [] };
    if (schema.type === 'number') return { number: null };
    if (schema.type === 'select') return { select: null };
    if (schema.type === 'status') return { status: null };
    if (schema.type === 'url') return { url: null };
    if (schema.type === 'date') return { date: null };
  }
  if (schema.type === 'title') return { title: [{ type: 'text', text: { content: String(value) } }] };
  if (schema.type === 'rich_text') return { rich_text: [{ type: 'text', text: { content: String(value) } }] };
  if (schema.type === 'number' && Number.isFinite(Number(value))) return { number: Number(value) };
  if (schema.type === 'select') return { select: { name: String(value) } };
  if (schema.type === 'status') return { status: { name: String(value) } };
  if (schema.type === 'url') return { url: String(value) };
  if (schema.type === 'checkbox') return { checkbox: Boolean(value) };
  if (schema.type === 'date') return { date: { start: new Date(value).toISOString() } };
  throw new NotionAssetConnectorError('schema_mismatch', `unsupported writable Notion property type: ${schema.type}`);
}

function normalizedConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new NotionAssetConnectorError('config_invalid', 'Notion connector config must be an object');
  const dataSourceId = requireText(input.dataSourceId, 'dataSourceId');
  if (!UUIDISH.test(dataSourceId)) throw new NotionAssetConnectorError('config_invalid', 'dataSourceId must be an exact Notion UUID');
  const profile = input.profile ?? 'projectCatalog';
  if (!['projectCatalog', 'assetRegistry'].includes(profile)) throw new NotionAssetConnectorError('config_invalid', 'profile must be projectCatalog or assetRegistry');
  const properties = input.properties && typeof input.properties === 'object' && !Array.isArray(input.properties) ? input.properties : {};
  const requiredProperties = profile === 'projectCatalog' ? ['projectId', 'title', 'priority'] : ['assetId', 'title', 'assetKind', 'remoteId', 'lifecycle', 'syncState'];
  for (const key of requiredProperties) requireText(properties[key], `properties.${key}`);
  return {
    schemaVersion: 1,
    profile,
    dataSourceId,
    properties: {
      projectId: properties.projectId,
      title: properties.title,
      priority: properties.priority,
      lifecycle: properties.lifecycle ?? null,
      nextAction: properties.nextAction ?? null,
      canonicalRoot: properties.canonicalRoot ?? null,
      repository: properties.repository ?? null,
      recordKind: properties.recordKind ?? null,
      assetId: properties.assetId ?? null,
      assetKind: properties.assetKind ?? null,
      remoteId: properties.remoteId ?? null,
      syncState: properties.syncState ?? null
    },
    ideaKindValues: Array.isArray(input.ideaKindValues) ? input.ideaKindValues.map(String) : ['idea'],
    pageSize: Number.isInteger(input.pageSize) && input.pageSize > 0 && input.pageSize <= 100 ? input.pageSize : 100,
    maxPages: Number.isInteger(input.maxPages) && input.maxPages > 0 && input.maxPages <= 100 ? input.maxPages : 20,
    timeoutMs: Number.isInteger(input.timeoutMs) && input.timeoutMs >= 1000 && input.timeoutMs <= 60_000 ? input.timeoutMs : 15_000
  };
}

export class NotionAssetConnector {
  constructor({ config, token, fetchImpl = globalThis.fetch, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    this.config = normalizedConfig(config);
    this.token = requireText(token, 'Notion token');
    if (typeof fetchImpl !== 'function') throw new NotionAssetConnectorError('fetch_unavailable', 'fetch implementation is required');
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.schema = null;
  }

  async #request(method, pathname, body = null, { write = false, retry429 = !write } = {}) {
    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      let response;
      try {
        response = await this.fetch(`https://api.notion.com/v1${pathname}`, {
          method,
          headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', 'notion-version': NOTION_API_VERSION },
          body: body === null ? undefined : JSON.stringify(body),
          signal: controller.signal
        });
      } catch (error) {
        throw new NotionAssetConnectorError('notion_transport_unknown', error?.name === 'AbortError' ? 'Notion request timed out' : 'Notion transport failed', { effectMayHaveOccurred: write });
      } finally { clearTimeout(timeout); }
      let payload = null;
      try { payload = await response.json(); } catch { /* status is still authoritative */ }
      if (response.ok) return payload;
      if (response.status === 429 && retry429 && attempt === 0) {
        const seconds = Math.max(1, Math.min(10, Number(response.headers.get('retry-after') ?? 1)));
        attempt += 1;
        await this.sleep(seconds * 1000);
        continue;
      }
      const effectMayHaveOccurred = write && response.status >= 500;
      throw new NotionAssetConnectorError(
        response.status === 409 ? 'notion_conflict' : response.status === 429 ? 'notion_rate_limited' : response.status >= 500 ? 'notion_remote_unknown' : 'notion_request_rejected',
        payload?.message ?? `Notion API returned HTTP ${response.status}`,
        { status: response.status, effectMayHaveOccurred }
      );
    }
  }

  async inspectSchema() {
    const source = await this.#request('GET', `/data_sources/${this.config.dataSourceId}`);
    if (source?.object !== 'data_source' || source.id.replaceAll('-', '') !== this.config.dataSourceId.replaceAll('-', '')) {
      throw new NotionAssetConnectorError('identity_mismatch', 'Notion returned a different data source');
    }
    for (const [logical, propertyName] of Object.entries(this.config.properties)) {
      if (propertyName && !source.properties?.[propertyName]) throw new NotionAssetConnectorError('schema_mismatch', `Notion property is missing: ${logical} -> ${propertyName}`);
    }
    this.schema = source.properties;
    return { id: source.id, properties: Object.fromEntries(Object.entries(this.config.properties).filter(([, name]) => name).map(([logical, name]) => [logical, { name, type: source.properties[name].type }])) };
  }

  async queryPages() {
    if (!this.schema) await this.inspectSchema();
    const pages = [];
    let startCursor = null;
    for (let page = 0; page < this.config.maxPages; page += 1) {
      const result = await this.#request('POST', `/data_sources/${this.config.dataSourceId}/query`, { page_size: this.config.pageSize, ...(startCursor ? { start_cursor: startCursor } : {}) });
      pages.push(...(result?.results ?? []).filter(item => item?.object === 'page'));
      if (!result?.has_more) return pages;
      if (!result.next_cursor) throw new NotionAssetConnectorError('pagination_invalid', 'Notion query omitted next_cursor');
      startCursor = result.next_cursor;
    }
    throw new NotionAssetConnectorError('pagination_limit', 'Notion data source exceeded the configured page bound');
  }

  normalizePage(page) {
    if (this.config.profile !== 'projectCatalog') throw new NotionAssetConnectorError('profile_mismatch', 'project page normalization requires the projectCatalog profile');
    const read = logical => {
      const name = this.config.properties[logical];
      return name ? propertyValue(page.properties?.[name]) : null;
    };
    return {
      pageId: page.id,
      notionId: page.id,
      projectId: read('projectId'),
      title: read('title'),
      priority: { rank: read('priority') },
      lifecycle: read('lifecycle'),
      nextAction: read('nextAction'),
      canonicalRoot: read('canonicalRoot'),
      links: { repository: read('repository') },
      recordKind: read('recordKind'),
      lastEditedTime: page.last_edited_time,
      inTrash: page.in_trash === true
    };
  }

  snapshotFromPages(pages, { capturedAt = new Date(this.now()).toISOString() } = {}) {
    const normalized = pages.map(page => this.normalizePage(page)).filter(item => item.projectId && !item.inTrash).sort((left, right) => String(left.projectId).localeCompare(String(right.projectId)));
    const version = `notion-${fingerprint(normalized.map(item => ({ pageId: item.pageId, projectId: item.projectId, priority: item.priority, lifecycle: item.lifecycle, nextAction: item.nextAction, canonicalRoot: item.canonicalRoot, lastEditedTime: item.lastEditedTime })))}`;
    const ideas = [];
    const projects = [];
    for (const item of normalized) (this.config.ideaKindValues.includes(String(item.recordKind).toLowerCase()) ? ideas : projects).push(item);
    return { version, capturedAt, projects, ideas };
  }

  async pullSnapshot() { return this.snapshotFromPages(await this.queryPages()); }

  normalizeAssetPage(page) {
    if (this.config.profile !== 'assetRegistry') throw new NotionAssetConnectorError('profile_mismatch', 'asset page normalization requires the assetRegistry profile');
    const read = logical => propertyValue(page.properties?.[this.config.properties[logical]]);
    return {
      pageId: page.id,
      notionAssetId: read('assetId'),
      title: read('title'),
      assetKind: read('assetKind'),
      remoteId: read('remoteId'),
      lifecycle: read('lifecycle'),
      syncState: read('syncState'),
      lastEditedTime: page.last_edited_time,
      inTrash: page.in_trash === true
    };
  }

  assetPageFingerprint(page) {
    const item = this.normalizeAssetPage(page);
    return fingerprint(item);
  }

  assetSnapshotFromPages(pages, { capturedAt = new Date(this.now()).toISOString() } = {}) {
    const assets = pages.map(page => this.normalizeAssetPage(page)).filter(item => item.notionAssetId && !item.inTrash)
      .sort((left, right) => String(left.notionAssetId).localeCompare(String(right.notionAssetId)));
    return { schemaVersion: 1, version: `notion-assets-${fingerprint(assets)}`, capturedAt, assets };
  }

  async pullAssetSnapshot() { return this.assetSnapshotFromPages(await this.queryPages()); }

  planAssetMirror(localInventory, remoteSnapshot) {
    if (this.config.profile !== 'assetRegistry') throw new NotionAssetConnectorError('profile_mismatch', 'asset mirror planning requires the assetRegistry profile');
    const localAssets = localInventory.assets.filter(asset => ['chatgpt_project', 'custom_gpt'].includes(asset.assetKind));
    const remoteById = new Map(remoteSnapshot.assets.filter(asset => asset.remoteId).map(asset => [asset.remoteId, asset]));
    const localIds = new Set(localAssets.map(asset => asset.canonicalLocator));
    const entries = [];
    for (const local of localAssets) {
      const remote = remoteById.get(local.canonicalLocator);
      const desired = {
        ...(local.metadata?.nameObserved === false ? {} : { title: local.displayName }),
        assetKind: local.assetKind === 'chatgpt_project' ? 'ChatGPT Project' : 'Custom GPT',
        remoteId: local.canonicalLocator,
        syncState: local.syncState === 'IN_SYNC' || local.syncState === 'RETIRED' ? 'In Sync' : local.syncState === 'DRIFT' ? 'Drift' : 'Remote Observed'
      };
      if (!remote) {
        entries.push({ assetId: local.assetId, action: 'create', state: 'PLANNED', localFingerprint: local.fingerprint, remoteFingerprint: null, patch: { values: { ...desired, assetId: local.assetId, lifecycle: local.lifecycle === 'retired' ? 'Retired' : 'Active' } }, drift: ['NOTION_RECORD_MISSING'] });
        continue;
      }
      const drift = [];
      const values = {};
      for (const key of ['title', 'assetKind', 'remoteId', 'syncState']) {
        if (Object.hasOwn(desired, key) && String(remote[key] ?? '') !== String(desired[key] ?? '')) { drift.push(key); values[key] = desired[key]; }
      }
      const notionLifecycle = String(remote.lifecycle ?? '').toLowerCase();
      if (local.lifecycle === 'retired' && !['retired', 'archived'].includes(notionLifecycle)) drift.push('lifecycle');
      entries.push({
        assetId: local.assetId,
        action: Object.keys(values).length ? 'update' : 'noop',
        state: drift.length ? 'DRIFT' : 'IN_SYNC',
        localFingerprint: local.fingerprint,
        remoteFingerprint: fingerprint(remote),
        pageId: remote.pageId,
        expectedLastEditedTime: remote.lastEditedTime,
        patch: { pageId: remote.pageId, expectedLastEditedTime: remote.lastEditedTime, values },
        drift
      });
    }
    for (const remote of remoteSnapshot.assets) {
      if (remote.remoteId && !localIds.has(remote.remoteId)) entries.push({ notionAssetId: remote.notionAssetId, action: 'none', state: 'NOTION_ONLY', pageId: remote.pageId, remoteFingerprint: fingerprint(remote), drift: ['LOCAL_OBSERVATION_MISSING'] });
    }
    return {
      schemaVersion: 1,
      localFingerprint: localInventory.fingerprint,
      remoteVersion: remoteSnapshot.version,
      entries,
      summary: Object.fromEntries(['IN_SYNC', 'DRIFT', 'PLANNED', 'NOTION_ONLY'].map(state => [state, entries.filter(entry => entry.state === state).length])),
      externalWritePerformed: false
    };
  }

  async createAssetPage({ values } = {}) {
    if (this.config.profile !== 'assetRegistry' || !values || typeof values !== 'object') throw new NotionAssetConnectorError('create_invalid', 'assetRegistry values are required');
    if (!this.schema) await this.inspectSchema();
    const properties = {};
    for (const [logical, value] of Object.entries(values)) {
      const name = this.config.properties[logical];
      if (!name || !this.schema[name]) throw new NotionAssetConnectorError('schema_mismatch', `Notion mapping is unavailable: ${logical}`);
      properties[name] = encodeProperty(this.schema[name], value);
    }
    const created = await this.#request('POST', '/pages', { parent: { type: 'data_source_id', data_source_id: this.config.dataSourceId }, properties }, { write: true, retry429: false });
    const after = await this.#request('GET', `/pages/${created.id}`);
    for (const [logical, expected] of Object.entries(values)) {
      const actual = propertyValue(after.properties?.[this.config.properties[logical]]);
      if (String(actual ?? '') !== String(expected ?? '')) throw new NotionAssetConnectorError('postcondition_mismatch', `Notion create verification failed for ${logical}`, { effectMayHaveOccurred: true });
    }
    return { page: after, verified: true, externalWritePerformed: true };
  }

  async updatePageProperties({ pageId, expectedLastEditedTime, values } = {}) {
    if (!UUIDISH.test(String(pageId ?? '')) || !expectedLastEditedTime || !values || typeof values !== 'object') throw new NotionAssetConnectorError('update_invalid', 'pageId, expectedLastEditedTime, and values are required');
    if (!this.schema) await this.inspectSchema();
    const before = await this.#request('GET', `/pages/${pageId}`);
    if (before.last_edited_time !== expectedLastEditedTime) throw new NotionAssetConnectorError('remote_version_conflict', 'Notion page changed after inspection', { status: 409 });
    const properties = {};
    for (const [logical, value] of Object.entries(values)) {
      const name = this.config.properties[logical];
      if (!name || !this.schema[name]) throw new NotionAssetConnectorError('schema_mismatch', `Notion mapping is unavailable: ${logical}`);
      properties[name] = encodeProperty(this.schema[name], value);
    }
    await this.#request('PATCH', `/pages/${pageId}`, { properties }, { write: true, retry429: false });
    const after = await this.#request('GET', `/pages/${pageId}`);
    for (const [logical, expected] of Object.entries(values)) {
      const actual = propertyValue(after.properties?.[this.config.properties[logical]]);
      if (String(actual ?? '') !== String(expected ?? '')) throw new NotionAssetConnectorError('postcondition_mismatch', `Notion verification failed for ${logical}`, { effectMayHaveOccurred: true });
    }
    return { page: after, verified: true, externalWritePerformed: true };
  }

  async runPriorityOperation({ projectService, operationId, workerId } = {}) {
    let prepared = false;
    try {
      const pages = await this.queryPages();
      const snapshot = this.snapshotFromPages(pages);
      projectService.refreshNotionSnapshot(snapshot);
      const operation = projectService.listPriorityOperations().operations.find(item => item.operationId === operationId);
      if (!operation) throw new NotionAssetConnectorError('operation_not_found', 'priority operation is not present in the AICC outbox');
      const target = [...snapshot.projects, ...snapshot.ideas].find(item => item.projectId === operation.projectId);
      if (!target) throw new NotionAssetConnectorError('project_not_found', 'Notion snapshot does not contain the exact projectId');
      projectService.preparePrioritySync({ operationId, remoteVersion: snapshot.version, workerId });
      prepared = true;
      await this.updatePageProperties({ pageId: target.pageId, expectedLastEditedTime: target.lastEditedTime, values: { priority: operation.desiredRank } });
      const after = await this.pullSnapshot();
      const completed = projectService.completePrioritySync({ operationId, snapshot: after });
      return { ...completed, externalWritePerformed: true };
    } catch (error) {
      if (prepared && error?.effectMayHaveOccurred !== true) projectService.recordPrioritySyncFailure({ operationId, errorCode: error?.code ?? 'notion_sync_failed' });
      throw error;
    }
  }
}

export const notionApiVersion = NOTION_API_VERSION;
