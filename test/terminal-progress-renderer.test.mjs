import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = path.resolve('tools/platform/aicc/render-terminal-progress.mjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-terminal-progress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = { root, progress: path.join(root, 'progress.json'), result: path.join(root, 'result.json'), processes: path.join(root, 'processes.json') };
  fs.writeFileSync(files.processes, JSON.stringify({ workerPid: process.pid }));
  return files;
}

function run(files) {
  return spawnSync(process.execPath, [script, '--label', 'AICC 시험 작업', '--progress', files.progress,
    '--result', files.result, '--processes', files.processes, '--once'], { encoding: 'utf8', timeout: 5_000 });
}

test('renderer shows KST, live progress and bounded resource use', t => {
  const files = fixture(t);
  fs.writeFileSync(files.progress, JSON.stringify({ percent: 42, step: '계정 확인', detail: 'STARTED', updatedAt: new Date().toISOString(), etaSeconds: 30, terminal: false }));
  const rendered = run(files);
  assert.equal(rendered.status, 0);
  assert.match(rendered.stdout, /KST/);
  assert.match(rendered.stdout, /터미널: AICC 시험 작업/);
  assert.match(rendered.stdout, /경과 \d+분 \d{2}초 · 진행률 42% · 현재 단계 계정 확인 · STARTED · 동작 중 · 예상 남은 시간/);
  assert.match(rendered.stdout, process.platform === 'win32' ? /작업 프로세스 PID .* 실행 중/ : /CPU .*% · 메모리/);
  assert.match(rendered.stdout, /경과 \d+분 \d{2}초/);
});

test('renderer exposes stale progress rather than pretending it is fresh', t => {
  const files = fixture(t);
  fs.writeFileSync(files.progress, JSON.stringify({ percent: 76, step: '앱 적용', detail: 'STARTED', updatedAt: '2026-01-01T00:00:00.000Z', terminal: false }));
  const rendered = run(files);
  assert.equal(rendered.status, 0);
  assert.match(rendered.stdout, /새 진행 신호 없음/);
});

test('renderer never reports zero remaining while a live worker is still waiting', t => {
  const files = fixture(t);
  fs.writeFileSync(files.progress, JSON.stringify({ percent: 54, step: '안전 게이트 확인', detail: 'sample_idle', updatedAt: '2026-01-01T00:00:00.000Z', etaSeconds: 1, terminal: false }));
  const rendered = run(files);
  assert.equal(rendered.status, 0);
  assert.match(rendered.stdout, /예상 시간 초과 · 완료 신호 대기/);
  assert.doesNotMatch(rendered.stdout, /예상 남은 시간 0분 00초/);
});

test('renderer keeps the operation result separate from final callback delivery', t => {
  const files = fixture(t);
  fs.writeFileSync(files.progress, JSON.stringify({ percent: 100, step: '현재 작업에 최종 결과 전달', updatedAt: new Date().toISOString(), terminal: true, terminalStatus: 'HOLD' }));
  fs.writeFileSync(files.result, JSON.stringify({ status: 'PASS' }));
  const rendered = run(files);
  assert.equal(rendered.status, 0);
  assert.match(rendered.stdout, /작업 결과 PASS · 완료/);
});

test('renderer marks terminal HOLD as unfinished even though the process ended', t => {
  const files = fixture(t);
  fs.writeFileSync(files.progress, JSON.stringify({ percent: 54, step: 'Business Workspace 복구', updatedAt: new Date().toISOString(), terminal: true, terminalStatus: 'HOLD' }));
  fs.writeFileSync(files.result, JSON.stringify({ status: 'HOLD' }));
  const rendered = run(files);
  assert.equal(rendered.status, 0);
  assert.match(rendered.stdout, /작업 결과 HOLD · 남은 작업 있음 · 자동 재실행 안 함/);
});

test('renderer treats a dead worker without terminal progress as UNKNOWN HOLD', t => {
  const files = fixture(t);
  fs.writeFileSync(files.progress, JSON.stringify({ percent: 50, step: '대기', updatedAt: new Date().toISOString(), terminal: false }));
  fs.writeFileSync(files.processes, JSON.stringify({ workerPid: 2_147_483_647 }));
  const rendered = run(files);
  assert.equal(rendered.status, 2);
  assert.match(rendered.stdout, /상태 확인 필요/);
});

test('renderer rejects an unlabeled non-Korean terminal', t => {
  const files = fixture(t);
  const rendered = spawnSync(process.execPath, [script, '--label', 'blank wait', '--progress', files.progress,
    '--result', files.result, '--processes', files.processes, '--once'], { encoding: 'utf8', timeout: 5_000 });
  assert.notEqual(rendered.status, 0);
  assert.match(rendered.stderr, /label_must_be_bounded_korean_text/);
});
