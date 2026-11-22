import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'scripts', 'audit_scroll_surfaces.mjs');

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`child timeout\n${stderr}`)); }, 60000);
    child.once('error', reject);
    child.once('exit', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

test('validates a bounded scroll manifest', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scroll-contract-'));
  try {
    const manifest = path.join(temp, 'manifest.json');
    await fs.writeFile(manifest, JSON.stringify({
      title: 'Contract fixture',
      targets: [{ id: 'fixture', url: 'http://192.0.2.1:32123/' }],
    }));
    const result = spawnSync(process.execPath, [script, '--manifest', manifest, '--out', path.join(temp, 'out'), '--validate-only'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, title: 'Contract fixture', targets: 1 });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('captures all scroll stops and reports visible defects', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scroll-runtime-'));
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
      body{margin:0;font:16px system-ui;min-height:1800px}.fixed{position:fixed;inset:0 0 auto;height:70px;background:#fff;z-index:9}
      main{padding-top:20px;width:600px}section{height:760px;padding:24px}.clip{width:90px;white-space:nowrap;overflow:hidden}.tiny{width:28px;height:28px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
    </style><div class="fixed">Fixed header</div><main><section><h1>실제 페이지</h1><span class="sr-only">접근성 전용 설명</span><details><summary>설정</summary><button class="tiny">숨김</button></details><p class="clip">잘리면 안 되는 긴 설명입니다</p><button class="tiny">작음</button></section><section><h2>두 번째 섹션</h2></section></main>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const manifest = path.join(temp, 'manifest.json');
    const out = path.join(temp, 'out');
    await fs.writeFile(manifest, JSON.stringify({
      title: 'Runtime fixture',
      defaultViewports: [{ name: 'mobile', width: 390, height: 600, mobile: true }],
      targets: [{ id: 'fixture', url: `http://192.0.2.1:${address.port}/`, contentPolicy: 'public', maxStops: 6 }],
    }));
    const result = await run(['--manifest', manifest, '--out', out]);
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));
    assert.ok(report.runs[0].frames.length >= 3, JSON.stringify(report.runs[0].geometry));
    assert.ok(report.runs[0].findings.some((item) => item.kind === 'horizontal-overflow'), JSON.stringify({ geometry: report.runs[0].geometry, findings: report.runs[0].findings }));
    assert.ok(report.runs[0].findings.some((item) => item.kind === 'clipped-text'));
    assert.ok(report.runs[0].findings.some((item) => item.kind === 'small-target'));
    assert.ok(!report.runs[0].findings.some((item) => item.selector?.includes('접근성 전용 설명')));
    assert.ok(!report.runs[0].findings.some((item) => item.selector?.includes('숨김')));
    assert.ok((await fs.stat(path.join(out, 'report.html'))).size > 500);
  } finally {
    server.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
