import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditCodexHome, isWindowsDriveRoot } from '../tools/platform/codex/audit-codex-home.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const auditScript = path.join(root, 'tools', 'platform', 'codex', 'audit-codex-home.mjs');
const hook = path.join(root, 'tools', 'platform', 'codex', 'openai_api_guard_hook.py');

function write(file, value = 'x', options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, options);
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-codex-home-audit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const project = path.join(home, 'project');
  const untrustedMissingProject = path.join(home, 'untrusted-missing-project');
  fs.mkdirSync(project, { recursive: true });
  write(path.join(codexHome, 'config.toml'), `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n[projects.${JSON.stringify(untrustedMissingProject)}]\ntrust_level = "untrusted"\n`);
  write(path.join(codexHome, 'requirements.toml'), `# Managed by AICC OpenAI API guard\n[hooks]\nmanaged_dir = ${JSON.stringify(path.dirname(hook))}\ncommand = ${JSON.stringify(`/usr/bin/python3 ${JSON.stringify(hook)}`)}\n`);
  write(path.join(codexHome, 'sessions', '2026', '01', '01', 'rollout-valid.jsonl'), '{}\n');
  write(path.join(home, '.local', 'bin', 'cm'), '#!/bin/sh\n');
  return { home, codexHome };
}

test('Codex home audit accepts a minimal healthy fixture and ignores untrusted missing projects', t => {
  const options = fixture(t);
  const report = auditCodexHome({ ...options, measureSizes: false });
  assert.equal(report.ok, true);
  assert.equal(report.state, 'ready');
  assert.deepEqual(report.counts, { error: 0, warning: 0, info: 0 });
  assert.equal(report.facts.trustedProjectCount, 1);
  assert.equal(report.facts.missingTrustedProjectCount, 0);
});

test('Codex home audit detects stale guard paths, unsafe trust and abandoned state', t => {
  const options = fixture(t);
  const missingProject = path.join(options.home, 'missing-project');
  write(path.join(options.codexHome, 'config.toml'), `approval_policy = "never"\nsandbox_mode = "danger-full-access"\n[features]\njs_repl = false\n[projects.${JSON.stringify(os.tmpdir())}]\ntrust_level = "trusted"\n[projects.${JSON.stringify(missingProject)}]\ntrust_level = "trusted"\n`);
  const missingHook = path.join(options.home, 'retired', 'openai_api_guard_hook.py');
  write(path.join(options.codexHome, 'requirements.toml'), `# Managed by AICC OpenAI API guard\n[hooks]\nmanaged_dir = ${JSON.stringify(path.dirname(missingHook))}\ncommand = ${JSON.stringify(`/usr/bin/python3 ${JSON.stringify(missingHook)}`)}\n`);
  const empty = path.join(options.codexHome, 'sessions', '2026', '01', '01', 'rollout-empty.jsonl');
  write(empty, '');
  const temporary = path.join(options.codexHome, '..codex-global-state.json.tmp-old');
  write(temporary, '{}');
  const old = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(empty, old, old);
  fs.utimesSync(temporary, old, old);
  const report = auditCodexHome({ ...options, now: new Date('2026-02-01T00:00:00Z').getTime(), measureSizes: false });
  const codes = new Set(report.issues.map(item => item.code));
  assert.equal(report.ok, false);
  for (const code of ['temporary_root_trusted', 'stale_trusted_projects', 'guard_hook_missing', 'guard_source_drift', 'empty_rollouts', 'stale_state_temps', 'removed_feature_override', 'unrestricted_without_approval']) {
    assert.equal(codes.has(code), true, code);
  }
});

test('Codex home audit blocks trusted Windows drive roots but allows repository scope', t => {
  const options = fixture(t);
  write(path.join(options.codexHome, 'config.toml'), [
    '[projects."C:\\\\"]',
    'trust_level = "trusted"',
    '[projects."c:/"]',
    'trust_level = "trusted"',
    '[projects."C:/demo/open-AICC"]',
    'trust_level = "trusted"',
  ].join('\n'));
  const report = auditCodexHome({ ...options, platform: 'win32', measureSizes: false });
  const findings = report.issues.filter(item => item.code === 'windows_drive_root_trusted');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error');
  assert.deepEqual(findings[0].paths, ['C:\\', 'c:/']);
  assert.equal(isWindowsDriveRoot('C:\\'), true);
  assert.equal(isWindowsDriveRoot('c:/'), true);
  assert.equal(isWindowsDriveRoot('C:/./'), true);
  assert.equal(isWindowsDriveRoot('C:/demo/open-AICC'), false);
});

test('Codex home audit detects a broken auth-sync launcher and duplicate skill exposure', t => {
  const options = fixture(t);
  const launchAgent = path.join(options.home, 'Library', 'LaunchAgents', 'com.codex-account-manager.auth-sync.plist');
  write(launchAgent, '<plist><dict><key>ProgramArguments</key><array><string>/missing/cm</string><string>auth-sync</string></array></dict></plist>');
  const skill = '---\nname: repeated-skill\ndescription: fixture\n---\n';
  write(path.join(options.codexHome, 'skills', 'repeated-skill', 'SKILL.md'), skill);
  write(path.join(options.codexHome, 'plugins', 'cache', 'local', 'fixture', '0.1.0', 'skills', 'repeated-skill', 'SKILL.md'), skill);
  const report = auditCodexHome({ ...options, measureSizes: false });
  const codes = new Set(report.issues.map(item => item.code));
  assert.equal(codes.has('broken_auth_sync_launcher'), true);
  assert.equal(codes.has('duplicate_skill_exposure'), true);
  assert.deepEqual(report.facts.duplicateSkillNames, ['repeated-skill']);
});

test('Codex home audit CLI is read-only and does not expose authentication contents', t => {
  const options = fixture(t);
  const authFile = path.join(options.codexHome, 'auth.json');
  const secret = 'fixture-secret-that-must-not-appear';
  write(authFile, JSON.stringify({ token: secret }), { mode: 0o600 });
  const before = fs.readFileSync(authFile, 'utf8');
  const run = spawnSync(process.execPath, [auditScript, '--home', options.home, '--codex-home', options.codexHome, '--aicc-root', root, '--skip-sizes', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.state, 'ready');
  assert.equal(fs.readFileSync(authFile, 'utf8'), before);
  assert.doesNotMatch(run.stdout, new RegExp(secret));
});

test('Codex home audit CLI rejects a missing path argument instead of auditing the default home', () => {
  const run = spawnSync(process.execPath, [auditScript, '--home', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Missing value for --home/);
});
