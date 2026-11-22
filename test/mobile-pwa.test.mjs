import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from '../src/server.mjs';

test('mobile install entry serves manifest, correctly sized PNG icons and network-only worker', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin + '/mobile.html');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<link rel="manifest" href="\/aicc.webmanifest">/);
  const reply = await fetch(origin + '/aicc.webmanifest');
  assert.equal(reply.status, 200);
  assert.match(reply.headers.get('content-type'), /application\/manifest\+json/);
  const manifest = await reply.json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.name, 'AICC');
  assert.equal(manifest.short_name, 'AICC');
  assert.equal(manifest.id, '/mobile.html');
  assert.equal(manifest.start_url, '/mobile.html#apps');
  const guide = await fetch(origin + '/install.html');
  assert.equal(guide.status, 200);
  assert.match(await guide.text(), /href="\/mobile\.html#apps">웹에서 열기 · 내 앱/);
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(icon => icon.sizes === `${size}x${size}`);
    assert.ok(icon);
    const response = await fetch(new URL(icon.src, origin));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  const worker = await fetch(origin + '/aicc-sw.js');
  assert.equal(worker.status, 200);
  const script = await worker.text();
  assert.doesNotMatch(script, /caches\.|cache\.put|respondWith/);
  const prepare = fs.readFileSync(new URL('../tools/platform/windows/Prepare-AiccMobilePublicRuntime.ps1', import.meta.url), 'utf8');
  for (const size of [192, 512]) assert.ok(prepare.includes(`public/aicc-icon-${size}.png`));
});
