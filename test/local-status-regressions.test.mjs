import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { guidanceStatusQuick } from '../src/adapters/guidance-status.mjs';
import { ocxAccountStatus } from '../src/adapters/ocx-accounts.mjs';
import { ocxStatus } from '../src/adapters/ocx.mjs';
import { resolveGuidanceCheckRoot } from '../src/guidance-root.mjs';

test('current Codex guidance manifest under .agents resolves and verifies', t => {
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-agents-guidance-')));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'source');
  const runtimeRoot = path.join(fixture, 'sealed-runtime');
  const home = path.join(fixture, 'home');
  const content = 'fixture\n';
  const digest = createHash('sha256').update(content).digest('hex').toUpperCase();
  for (const relative of ['guidance/skills/fixture-skill', 'guidance/directives/generated/codex', 'guidance/config', 'tools/platform/test']) {
    fs.mkdirSync(path.join(root, relative), { recursive: true });
  }
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(root, 'guidance/config/agent-catalog.toml'), 'default_groups = ["codex"]\n');
  fs.writeFileSync(path.join(root, 'guidance/skills/fixture-skill/SKILL.md'), content);
  fs.writeFileSync(path.join(root, 'guidance/directives/generated/codex/AGENTS.md'), content);
  fs.writeFileSync(path.join(root, 'tools/platform/test/Test-AiccGuidance.ps1'), '# fixture\n');
  const targetRoot = path.join(home, '.agents', 'skills');
  fs.mkdirSync(path.join(targetRoot, 'fixture-skill'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, 'fixture-skill/SKILL.md'), content);
  fs.writeFileSync(path.join(home, '.codex/AGENTS.md'), content);
  fs.writeFileSync(path.join(targetRoot, '.aicc-guidance-deployment.json'), JSON.stringify({
    schema_version: 1,
    target_group: 'codex',
    aicc_root: root,
    managed_skills: [{ name: 'fixture-skill', files: [{ path: 'SKILL.md', sha256: digest }] }]
  }));
  assert.equal(resolveGuidanceCheckRoot({ runtimeRoot, home }).root, fs.realpathSync(root));
  assert.equal(guidanceStatusQuick({ root: runtimeRoot, home }).state, 'ready');
});

test('OCX status probes use Windows-realistic default budgets', async () => {
  const observed = [];
  await ocxStatus({
    executable: 'ocx-fixture',
    probeManagedRuntime: false,
    runCommand: async (_executable, args, options) => {
      observed.push({ args: args.join(' '), timeoutMs: options.timeoutMs });
      if (args[0] === '--version') return { ok: true, stdout: 'opencodex 2.33.0\n' };
      if (args[0] === 'health') return { ok: true, stdout: '{"ok":true,"pid":42,"port":10100}' };
      if (args[0] === 'ready') return { ok: true, stdout: '{"ready":true,"status":"ready","pid":42,"port":10100}' };
      return { ok: true, stdout: '{}' };
    }
  });
  assert.equal(observed.find(item => item.args === '--version').timeoutMs, 3_000);
  assert.equal(observed.find(item => item.args === 'agent status --json').timeoutMs, 8_000);

  let accountTimeout;
  await ocxAccountStatus({
    executable: 'ocx-fixture',
    runCommand: async (_executable, _args, options) => {
      accountTimeout = options.timeoutMs;
      return { ok: true, stdout: '{"accounts":[]}' };
    }
  });
  assert.equal(accountTimeout, 10_000);
});

test('managed OCX loopback probe tolerates a busy event loop longer than two seconds', async () => {
  const delayedFetch = (url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({
      ok: true,
      json: async () => String(url).endsWith('/healthz')
        ? { status: 'ok', service: 'opencodex', version: '2.33.0', pid: 42, port: 10100 }
        : { status: 'ready', service: 'opencodex', version: '2.33.0', pid: 42, port: 10100 }
    }), 2_100);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
  const status = await ocxStatus({
    executable: 'ocx-fixture',
    fetch: delayedFetch,
    runCommand: async (_executable, args) => {
      if (args[0] === '--version') return { ok: true, stdout: 'opencodex 2.33.0\n' };
      return { ok: false, timedOut: true, stdout: '', error: 'command timed out' };
    }
  });
  assert.equal(status.managedRuntimeProbe.healthVerified, true);
  assert.equal(status.managedRuntimeProbe.readinessVerified, true);
  assert.equal(status.state, 'ready');
});
