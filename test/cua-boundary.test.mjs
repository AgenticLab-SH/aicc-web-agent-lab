import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARDED_ADAPTER = path.join(REPO, 'src', 'control-plane', 'cua-driver-adapter.mjs');

function runtimeFiles(root) {
  const output = [];
  if (!fs.existsSync(root)) return output;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry.name)) continue;
      output.push(...runtimeFiles(absolute));
      continue;
    }
    if (/\.(?:mjs|js|cjs|ps1|py)$/.test(entry.name)) output.push(absolute);
  }
  return output;
}

function relative(file) {
  return path.relative(REPO, file).replaceAll('\\', '/');
}

test('all runtime cua-driver process access is centralized in GuardedCuaDriver', () => {
  const offenders = [];
  for (const file of [...runtimeFiles(path.join(REPO, 'src')), ...runtimeFiles(path.join(REPO, 'tools'))]) {
    if (path.resolve(file) === path.resolve(GUARDED_ADAPTER)) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (/\bcua-driver\b/i.test(source)) offenders.push(relative(file));
  }
  assert.deepEqual(offenders, []);
});

test('runtime source has no legacy foreground input injection bypass', () => {
  const offenders = [];
  const forbidden = /\b(?:SetForegroundWindow|SendInput|mouse_event|keybd_event)\b/i;
  for (const file of [...runtimeFiles(path.join(REPO, 'src')), ...runtimeFiles(path.join(REPO, 'tools'))]) {
    const source = fs.readFileSync(file, 'utf8');
    if (forbidden.test(source)) offenders.push(relative(file));
  }
  assert.deepEqual(offenders, []);
});

test('Slack CAPTCHA runtime is browser-lease only and contains no native CUA fallback', () => {
  const files = [
    ...runtimeFiles(path.join(REPO, 'src', 'notifications')).filter(file => /slack-captcha/i.test(path.basename(file))),
    ...runtimeFiles(path.join(REPO, 'tools', 'platform', 'slack'))
  ];
  const offenders = [];
  const forbidden = /\bcua-driver\b|\bGuardedCuaDriver\b|\bSetForegroundWindow\b|\bSendInput\b/i;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (forbidden.test(source)) offenders.push(relative(file));
  }
  assert.deepEqual(offenders, []);

  const loopback = fs.readFileSync(path.join(REPO, 'src', 'notifications', 'slack-captcha-loopback.mjs'), 'utf8');
  const authorize = loopback.indexOf('browserGuard.authorize({');
  const consume = loopback.indexOf('consumeSlackCaptchaIntoCurrentTask({');
  assert.ok(authorize >= 0, 'CAPTCHA loopback must authorize the exact browser lease');
  assert.ok(consume > authorize, 'browser lease authorization must happen before CAPTCHA consumption');
});
