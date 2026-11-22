#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const options = { intervalMs: 1_000, staleMs: 10_000, resourceMs: 5_000, once: false, label: 'AICC 작업 진행' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--once') options.once = true;
    else if (key.startsWith('--')) options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
    else throw new Error(`unexpected_argument:${key}`);
  }
  for (const key of ['progress', 'result', 'processes']) {
    if (!path.isAbsolute(options[key] ?? '')) throw new Error(`${key}_must_be_absolute`);
  }
  for (const key of ['intervalMs', 'staleMs', 'resourceMs']) options[key] = Number(options[key]);
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 250 || options.intervalMs > 5_000) throw new Error('interval_ms_invalid');
  if (!Number.isInteger(options.staleMs) || options.staleMs < 2_000) throw new Error('stale_ms_invalid');
  if (!Number.isInteger(options.resourceMs) || options.resourceMs < 5_000) throw new Error('resource_ms_invalid');
  if (typeof options.label !== 'string' || options.label.length < 2 || options.label.length > 80 || !/[가-힣]/.test(options.label) || /[\x00-\x1f\x7f]/.test(options.label)) {
    throw new Error('label_must_be_bounded_korean_text');
  }
  return options;
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe_status_file:${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function formatKst(value = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(value));
  const pick = type => parts.find(part => part.type === type)?.value;
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')} KST`;
}

function duration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0 ? `${hours}시간 ${String(minutes).padStart(2, '0')}분` : `${minutes}분 ${String(remainder).padStart(2, '0')}초`;
}

function eta(progress, now) {
  if (typeof progress?.deadlineAt === 'string' && Number.isFinite(Date.parse(progress.deadlineAt))) {
    const remaining = Date.parse(progress.deadlineAt) - now;
    return remaining > 0 ? duration(remaining) : '기한 경과';
  }
  if (Number.isFinite(Number(progress?.etaSeconds))) {
    const updatedAt = Date.parse(progress?.updatedAt ?? '');
    const ageMs = Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : 0;
    const remainingMs = Number(progress.etaSeconds) * 1_000 - ageMs;
    return remainingMs > 0 ? duration(remainingMs) : '예상 시간 초과 · 완료 신호 대기';
  }
  return '산정 불가';
}

function resourceSample(pid) {
  if (!processAlive(pid)) return { alive: false, text: pid == null ? '작업 프로세스 번호 대기' : '작업 프로세스 종료' };
  if (process.platform === 'win32') return { alive: true, text: `작업 프로세스 PID ${pid} 실행 중` };
  const sampled = spawnSync('/bin/ps', ['-p', String(pid), '-o', '%cpu=,%mem=,etime='], { encoding: 'utf8', timeout: 2_000 });
  const fields = String(sampled.stdout ?? '').trim().split(/\s+/);
  return sampled.status === 0 && fields.length >= 3
    ? { alive: true, text: `CPU ${fields[0]}% · 메모리 ${fields[1]}% · 프로세스 실행 ${fields[2]}` }
    : { alive: true, text: '작업 프로세스 실행 중' };
}

function fit(text) {
  if (!process.stdout.isTTY) return text;
  const width = Math.max(80, Number(process.stdout.columns ?? 120));
  return text.length > width - 1 ? `${text.slice(0, width - 2)}…` : text;
}

const options = parseArgs(process.argv.slice(2));
const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const initialProgress = readJson(options.progress);
const suppliedStartedAt = Date.parse(initialProgress?.startedAt ?? '');
const startedAt = Number.isFinite(suppliedStartedAt) ? suppliedStartedAt : Date.now();
let tick = 0;
let lastResourceAt = 0;
let sampledResource = { alive: null, text: '작업 프로세스 확인 중' };
let terminal = false;

if (process.stdout.isTTY) process.stdout.write(`\x1b]0;${options.label}\x07`);
process.stdout.write(`터미널: ${options.label}\n시작: ${formatKst(startedAt)} · 진행 상태 연결 완료\n`);

function render() {
  const now = Date.now();
  const result = readJson(options.result);
  const progress = readJson(options.progress);
  const processes = readJson(options.processes);
  const pid = Number(processes?.workerPid);
  if (now - lastResourceAt >= options.resourceMs || sampledResource.alive == null) {
    sampledResource = resourceSample(Number.isInteger(pid) ? pid : null);
    lastResourceAt = now;
  }
  if (progress?.terminal === true) {
    const operation = result?.status ?? progress.operationStatus ?? 'UNKNOWN';
    const followup = operation === 'PASS' ? '완료' : '남은 작업 있음 · 자동 재실행 안 함';
    process.stdout.write(`\r\x1b[2K${fit(`■ ${formatKst(now)} · 작업 결과 ${operation} · ${followup} · 현재 단계 ${progress.step ?? '종료'} · 경과 ${duration(now - startedAt)}`)}\n`);
    terminal = true;
    return;
  }
  const updatedAt = Date.parse(progress?.updatedAt ?? '');
  const ageMs = Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : Number.POSITIVE_INFINITY;
  const stale = ageMs >= options.staleMs;
  const state = Number.isInteger(pid) && !sampledResource.alive
    ? '상태 확인 필요 · 결과 파일 확인'
    : stale
      ? `새 진행 신호 없음 ${Number.isFinite(ageMs) ? duration(ageMs) : '시간 산정 불가'}`
      : '동작 중';
  const percent = Number.isFinite(Number(progress?.percent)) ? `${Math.round(Number(progress.percent))}%` : '산정 불가';
  const line = `${spinner[tick % spinner.length]} ${formatKst(now)} · 경과 ${duration(now - startedAt)} · 진행률 ${percent} · 현재 단계 ${progress?.step ?? '진행 신호 대기'} · ${progress?.detail ?? ''} · ${state} · 예상 남은 시간 ${eta(progress, now)} · ${sampledResource.text}`;
  process.stdout.write(`\r\x1b[2K${fit(line)}`);
  tick += 1;
  if (Number.isInteger(pid) && !sampledResource.alive) terminal = true;
}

function finish() {
  if (!terminal) process.stdout.write('\r\x1b[2K');
  process.stdout.write('\n');
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { finish(); process.exit(128); });

do {
  render();
  if (options.once || terminal) break;
  await new Promise(resolve => setTimeout(resolve, options.intervalMs));
} while (true);

finish();
if (!readJson(options.progress)?.terminal && sampledResource.alive === false && Number.isInteger(Number(readJson(options.processes)?.workerPid))) process.exitCode = 2;
