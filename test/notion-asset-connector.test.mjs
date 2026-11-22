import assert from 'node:assert/strict';
import test from 'node:test';
import { NotionAssetConnector } from '../src/assets/notion-connector.mjs';
import { buildAssetInventory, normalizeAssetRecord } from '../src/assets/asset-registry.mjs';

const config = {
  dataSourceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  properties: { projectId: 'Project ID', title: 'Name', priority: 'Priority', lifecycle: 'Lifecycle', nextAction: 'Next Action', recordKind: 'Kind' }
};

function response(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] ?? null }, json: async () => body };
}

function page(rank = 1, edited = '2026-08-16T00:00:00.000Z') {
  return {
    object: 'page', id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', last_edited_time: edited, in_trash: false,
    properties: {
      'Project ID': { type: 'rich_text', rich_text: [{ plain_text: 'project-one' }] },
      Name: { type: 'title', title: [{ plain_text: 'Project One' }] },
      Priority: { type: 'number', number: rank },
      Lifecycle: { type: 'status', status: { name: 'building' } },
      'Next Action': { type: 'rich_text', rich_text: [{ plain_text: 'verify' }] },
      Kind: { type: 'select', select: { name: 'project' } }
    }
  };
}

const schema = {
  object: 'data_source', id: config.dataSourceId,
  properties: {
    'Project ID': { type: 'rich_text' }, Name: { type: 'title' }, Priority: { type: 'number' }, Lifecycle: { type: 'status' },
    'Next Action': { type: 'rich_text' }, Kind: { type: 'select' }
  }
};

test('Notion connector uses current data-source API, paginates, and creates a versioned snapshot', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return response(200, schema);
    return response(200, { object: 'list', results: [page()], has_more: false, next_cursor: null });
  };
  const connector = new NotionAssetConnector({ config, token: 'owner-token', fetchImpl, now: () => Date.parse('2026-08-16T00:00:00Z') });
  const snapshot = await connector.pullSnapshot();
  assert.match(snapshot.version, /^notion-[a-f0-9]{64}$/);
  assert.equal(snapshot.projects[0].projectId, 'project-one');
  assert.equal(snapshot.projects[0].priority.rank, 1);
  assert.equal(calls[0].options.headers['notion-version'], '2026-03-11');
  assert.match(calls[1].url, /\/v1\/data_sources\/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\/query$/);
});

test('Notion writes enforce last-edited precondition and verify the exact property', async () => {
  const calls = [];
  let current = page();
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/data_sources/')) return response(200, schema);
    if (options.method === 'PATCH') {
      const body = JSON.parse(options.body);
      current = page(body.properties.Priority.number, '2026-08-16T00:01:00.000Z');
      return response(200, current);
    }
    return response(200, current);
  };
  const connector = new NotionAssetConnector({ config, token: 'owner-token', fetchImpl });
  const result = await connector.updatePageProperties({ pageId: current.id, expectedLastEditedTime: current.last_edited_time, values: { priority: 7 } });
  assert.equal(result.externalWritePerformed, true);
  assert.equal(current.properties.Priority.number, 7);
  assert.equal(calls.filter(call => call.options.method === 'PATCH').length, 1);
});

test('Notion ambiguous write failures are UNKNOWN and are never retried', async () => {
  let patches = 0;
  const fetchImpl = async (url, options) => {
    if (url.includes('/data_sources/')) return response(200, schema);
    if (options.method === 'PATCH') { patches += 1; return response(503, { message: 'unavailable' }); }
    return response(200, page());
  };
  const connector = new NotionAssetConnector({ config, token: 'owner-token', fetchImpl });
  await assert.rejects(
    connector.updatePageProperties({ pageId: page().id, expectedLastEditedTime: page().last_edited_time, values: { priority: 2 } }),
    error => error.code === 'notion_remote_unknown' && error.effectMayHaveOccurred === true
  );
  assert.equal(patches, 1);
});

test('Notion read rate limits have one bounded Retry-After retry', async () => {
  let requests = 0;
  const sleeps = [];
  const fetchImpl = async () => {
    requests += 1;
    return requests === 1 ? response(429, { message: 'slow' }, { 'retry-after': '2' }) : response(200, schema);
  };
  const connector = new NotionAssetConnector({ config, token: 'owner-token', fetchImpl, sleep: async ms => sleeps.push(ms) });
  await connector.inspectSchema();
  assert.equal(requests, 2);
  assert.deepEqual(sleeps, [2000]);
});

const assetConfig = {
  profile: 'assetRegistry', dataSourceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  properties: { assetId: 'Asset ID', title: 'Name', assetKind: 'Asset Kind', remoteId: 'Remote ID', lifecycle: 'Lifecycle', syncState: 'Sync Status' }
};

function assetPage({ name = 'Remote', status = 'Remote Observed', edited = '2026-08-16T00:00:00.000Z' } = {}) {
  return {
    object: 'page', id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', last_edited_time: edited, in_trash: false,
    properties: {
      'Asset ID': { type: 'rich_text', rich_text: [{ plain_text: 'legacy-id' }] }, Name: { type: 'title', title: [{ plain_text: name }] },
      'Asset Kind': { type: 'select', select: { name: 'ChatGPT Project' } }, 'Remote ID': { type: 'rich_text', rich_text: [{ plain_text: 'g-p-remote' }] },
      Lifecycle: { type: 'select', select: { name: 'Active' } }, 'Sync Status': { type: 'select', select: { name: status } }
    }
  };
}

test('AI Asset Registry profile matches by Remote ID and plans only local-authoritative fields', () => {
  const connector = new NotionAssetConnector({ config: assetConfig, token: 'owner-token', fetchImpl: async () => response(500, {}) });
  const local = normalizeAssetRecord({
    assetId: 'chatgpt-project:g-p-remote', assetKind: 'chatgpt_project', displayName: 'Verified Remote', canonicalOwner: 'ChatGPT visible UI',
    canonicalLocator: 'g-p-remote', lifecycle: 'active', syncState: 'IN_SYNC', adapterId: 'chatgpt-visible-ui-v1'
  });
  const inventory = buildAssetInventory({ chatgpt: [local], generatedAt: '2026-08-16T00:00:00Z' });
  const remote = connector.assetSnapshotFromPages([assetPage()]);
  const plan = connector.planAssetMirror(inventory, remote);
  assert.equal(plan.summary.DRIFT, 1);
  assert.deepEqual(plan.entries[0].patch.values, { title: 'Verified Remote', syncState: 'In Sync' });
  assert.equal(plan.entries[0].patch.pageId, assetPage().id);
  assert.equal(plan.entries[0].remoteFingerprint, connector.assetPageFingerprint(assetPage()));
});

test('AI Asset Registry never overwrites a Notion title when visible UI did not observe a name', () => {
  const connector = new NotionAssetConnector({ config: assetConfig, token: 'owner-token', fetchImpl: async () => response(500, {}) });
  const local = normalizeAssetRecord({
    assetId: 'chatgpt-project:g-p-remote', assetKind: 'chatgpt_project', displayName: 'g-p-remote', canonicalOwner: 'ChatGPT visible UI',
    canonicalLocator: 'g-p-remote', lifecycle: 'active', syncState: 'DISCOVERED', adapterId: 'chatgpt-visible-ui-v1', metadata: { nameObserved: false }
  });
  const inventory = buildAssetInventory({ chatgpt: [local], generatedAt: '2026-08-16T00:00:00Z' });
  const plan = connector.planAssetMirror(inventory, connector.assetSnapshotFromPages([assetPage({ name: 'Human Name' })]));
  assert.equal(Object.hasOwn(plan.entries[0].patch.values, 'title'), false);
});

test('AI Asset Registry create uses exact mapped properties and verifies the created page', async () => {
  const assetSchema = {
    object: 'data_source', id: assetConfig.dataSourceId,
    properties: {
      'Asset ID': { type: 'rich_text' }, Name: { type: 'title' }, 'Asset Kind': { type: 'select' }, 'Remote ID': { type: 'rich_text' },
      Lifecycle: { type: 'select' }, 'Sync Status': { type: 'select' }
    }
  };
  const created = assetPage({ name: 'Created', status: 'In Sync' });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/data_sources/')) return response(200, assetSchema);
    if (options.method === 'POST') return response(200, { id: created.id });
    return response(200, created);
  };
  const connector = new NotionAssetConnector({ config: assetConfig, token: 'owner-token', fetchImpl });
  const result = await connector.createAssetPage({ values: { assetId: 'legacy-id', title: 'Created', assetKind: 'ChatGPT Project', remoteId: 'g-p-remote', lifecycle: 'Active', syncState: 'In Sync' } });
  assert.equal(result.verified, true);
  const create = calls.find(call => call.url.endsWith('/v1/pages') && call.options.method === 'POST');
  assert.equal(JSON.parse(create.options.body).parent.data_source_id, assetConfig.dataSourceId);
  assert.equal(calls.filter(call => call.options.method === 'POST' && call.url.endsWith('/v1/pages')).length, 1);
});
