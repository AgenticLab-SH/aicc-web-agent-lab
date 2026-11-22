import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const launcher = path.resolve('tools/platform/aicc/Open-AiccProgressTerminal.ps1');
const presenter = path.resolve('tools/platform/aicc/Show-AiccProgressTerminal.ps1');

test('Windows launcher plans a labeled foreground terminal without opening it', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-progress-launcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', launcher,
    '-Title', 'AICC 복구 진행', '-Purpose', '현재 작업 완료 대기',
    '-Progress', path.join(root, 'progress.json'), '-Result', path.join(root, 'result.json'),
    '-Processes', path.join(root, 'processes.json'), '-NodePath', process.execPath, '-Plan'],
  { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.mode, 'foreground-visible');
  assert.equal(plan.title, 'AICC 복구 진행');
  assert.equal(plan.purpose, '현재 작업 완료 대기');
  assert.equal(plan.renderer, path.resolve('tools/platform/aicc/render-terminal-progress.mjs'));
});

test('launcher requires Korean identity text', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-progress-launcher-label-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', launcher,
    '-Title', 'blank wait', '-Purpose', 'current wait',
    '-Progress', path.join(root, 'progress.json'), '-Result', path.join(root, 'result.json'),
    '-Processes', path.join(root, 'processes.json'), '-NodePath', process.execPath, '-Plan'],
  { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.notEqual(result.status, 0);
});

test('presenter prints identity before starting the renderer and updates the title', () => {
  const source = fs.readFileSync(presenter, 'utf8');
  const identity = source.indexOf('Write-Host "터미널: $Title"');
  const renderer = source.indexOf('& $NodePath $RendererPath');
  assert.ok(identity >= 0 && renderer > identity);
  assert.match(source, /WindowTitle = "\$Title · 준비 중"/);
  assert.match(source, /Write-Host "용도: \$Purpose"/);
});
