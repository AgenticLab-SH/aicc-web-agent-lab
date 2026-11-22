import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveCodexVersion, resolveOcxVersion, scanLocalUpstreams } from '../src/upstream-monitor.mjs';

test('Windows review uses the registered Codex installation and preserves an explicit executable', async () => {
  for (const explicit of [undefined, 'registered-exact-codex.exe']) {
    let observed;
    const result = await resolveCodexVersion({ platform: 'win32', home: '/fixture-owner', codexExecutable: explicit }, async (executable, args) => {
      observed = executable; assert.deepEqual(args, ['--version']);
      return { ok: true, stdout: 'codex-cli 0.165.0' };
    });
    assert.equal(result, '0.165.0');
    assert.equal(observed, explicit ?? path.join('/fixture-owner', 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
  }
});

test('OCX monitoring prefers the managed 10100 runtime identity over a stale standalone CLI', async () => {
  const calls = [];
  const version = await resolveOcxVersion({}, async (executable, args) => {
    calls.push([executable, args]);
    if (executable === 'curl') return { ok: true, stdout: '{"status":"ok","version":"2.29.0"}' };
    return { ok: true, stdout: 'opencodex 2.12.0\n' };
  });
  assert.equal(version, '2.29.0');
  assert.equal(calls.length, 1);
});

test('local upstream scan builds an owner-local manifest and uses local git credentials', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-upstream-monitor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const portfolio = path.join(root, 'portfolio.toml');
  const ledger = path.join(root, 'ledger.json');
  const manifest = path.join(root, 'monitoring', 'manifest.json');
  const state = path.join(root, 'monitoring', 'state.json');
  const events = path.join(root, 'monitoring', 'events.jsonl');
  fs.writeFileSync(portfolio, 'projects = []\n');
  fs.writeFileSync(ledger, '{"sources":[]}\n');
  const calls = [];
  const result = await scanLocalUpstreams({
    stateRoot: root,
    portfolioPath: portfolio,
    sourceLedgerPath: ledger,
    upstreamManifestPath: manifest,
    upstreamStatePath: state,
    upstreamEventsPath: events,
    ocxVersion: '2.16.0',
    codexVersion: '0.147.0',
    webGptBaselineRevision: 'a'.repeat(40),
    pythonCommand: { executable: 'python-fixture', args: [] },
    runCommand: async (executable, args) => {
      calls.push([executable, args]);
      if (args.some(value => String(value).endsWith('build_manifest.py'))) {
        fs.mkdirSync(path.dirname(manifest), { recursive: true });
        fs.writeFileSync(manifest, '{"schemaVersion":1,"sources":[]}\n');
      } else {
        fs.writeFileSync(state, JSON.stringify({ schemaVersion: 1, checkedAt: '2026-08-14T00:00:00Z', automaticApply: false, counts: { current: 1 }, sources: [] }));
      }
      return { ok: true, stdout: '{}', stderr: '' };
    }
  });
  assert.equal(result.origin, 'local-aicc-direct');
  assert.equal(result.automaticApply, false);
  assert.ok(calls[1][1].includes('local-git'));
  const built = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(built.sources.find(source => source.id === 'codex-cli-npm').baselineVersion, '0.147.0');
  assert.equal(built.sources.find(source => source.id === 'codex-cli-npm').applyAction, 'codex-cli.update');
  assert.equal(built.sources.find(source => source.id === 'codexpro-reference-npm').observationMode, 'reference');
  assert.equal(built.sources.find(source => source.id === 'devspace-reference-npm').installed, false);
  assert.equal(built.sources.find(source => source.id === 'codex-web-gpt-upstream').baselineRevision, 'a'.repeat(40));
});
