import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.mjs';

test('asset API exposes read inventory and guarded operation lifecycle without provider writes', async t => {
  const calls = [];
  const assetControlService = {
    status: () => ({ schemaVersion: 1, fingerprint: 'a'.repeat(64), summary: { total: 3 }, externalWritePerformed: false }),
    queryChatGptArchiveCatalog: input => ({ schemaVersion: 1, total: 1, items: [{ title: input.query || 'item' }], externalWritePerformed: false }),
    importChatGptArchiveCatalog: catalog => { calls.push(['catalog-import', catalog.items.length]); return { imported: catalog.items.length, externalWritePerformed: false }; },
    importChatGptSnapshot: snapshot => { calls.push(['import', snapshot.assets.length]); return { imported: snapshot.assets.length, externalWritePerformed: false }; },
    previewOperation: input => ({ operationId: 'asset-op-one', confirmationToken: 'confirm-one', operation: input, externalWritePerformed: false }),
    confirmOperation: token => { calls.push(['confirm', token]); return { operation: { operationId: 'asset-op-one', state: 'APPROVED' }, externalWritePerformed: false }; },
    prepareOperation: (id, input) => { calls.push(['prepare', id, input.workerId]); return { operation: { state: 'APPLYING' }, externalWritePerformed: false }; },
    completeOperation: (id, input) => { calls.push(['complete', id, input.workerId]); return { operation: { state: 'APPLIED' }, externalWritePerformed: false }; },
    failOperation: (id, input) => { calls.push(['failure', id, input.errorCode]); return { operation: { state: 'UNKNOWN' }, externalWritePerformed: false }; }
  };
  const server = createServer({
    collectStatus: async () => ({ ok: true }),
    actionController: { list: () => [], preview: async () => ({}), execute: async () => ({}) },
    assetControlService
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const endpoint = pathname => `http://127.0.0.1:${port}${pathname}`;
  const post = (pathname, body) => fetch(endpoint(pathname), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const status = await fetch(endpoint('/api/assets')).then(response => response.json());
  assert.equal(status.summary.total, 3);
  assert.equal(status.externalWritePerformed, false);
  const catalog = await fetch(endpoint('/api/assets/chatgpt-catalog?query=%EC%84%A4%EA%B3%84')).then(response => response.json());
  assert.equal(catalog.items[0].title, '설계');
  assert.equal((await post('/api/assets/chatgpt-import', { snapshot: { assets: [{}] } })).status, 200);
  assert.equal((await post('/api/assets/chatgpt-catalog/import', { catalog: { items: [{}] } })).status, 200);
  const preview = await post('/api/assets/operations/preview', { assetId: 'project:one', action: 'update' });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).confirmationToken, 'confirm-one');
  assert.equal((await post('/api/assets/operations/confirm', { confirmationToken: 'confirm-one' })).status, 202);
  assert.equal((await post('/api/assets/operations/prepare', { operationId: 'asset-op-one', workerId: 'worker' })).status, 200);
  assert.equal((await post('/api/assets/operations/complete', { operationId: 'asset-op-one', workerId: 'worker' })).status, 200);
  assert.equal((await post('/api/assets/operations/failure', { operationId: 'asset-op-two', workerId: 'worker', errorCode: 'unknown' })).status, 200);
  assert.deepEqual(calls.map(call => call[0]), ['import', 'catalog-import', 'confirm', 'prepare', 'complete', 'failure']);
});
