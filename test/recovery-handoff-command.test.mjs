import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRecoveryHandoffArgs, runRecoveryHandoffCommand } from '../src/recovery-handoff-command.mjs';

test('recovery handoff parser is strict and help wins without state access', async () => {
  assert.deepEqual(parseRecoveryHandoffArgs([]), { mode: 'status', json: false });
  assert.deepEqual(parseRecoveryHandoffArgs(['refresh', '--json']), { mode: 'refresh', json: true });
  assert.throws(() => parseRecoveryHandoffArgs(['refresh', '--unknown']), /unknown/);
  let touched = false;
  const result = await runRecoveryHandoffCommand(['--help', '--unknown'], { service: { status() { touched = true; } } });
  assert.equal(result.exitCode, 0);
  assert.equal(touched, false);
});

test('refresh delegates once and reports the fixed workspace mirror paths', async () => {
  let refreshes = 0;
  const state = {
    ok: true,
    available: true,
    mirror: {
      markdownPath: '~/dev/projects/ai-platform/.aicc-recovery/LATEST.md',
      jsonPath: '~/dev/projects/ai-platform/.aicc-recovery/LATEST.json',
      manifestPath: '~/dev/projects/ai-platform/.aicc-recovery/LATEST.manifest.json'
    }
  };
  const execution = await runRecoveryHandoffCommand(['refresh'], {
    service: { async refresh() { refreshes += 1; return state; } }
  });
  assert.equal(refreshes, 1);
  assert.match(execution.output, /PASS: recovery handoff refreshed/);
  assert.match(execution.output, /\.aicc-recovery\/LATEST\.md/);
  assert.match(execution.output, /\.aicc-recovery\/LATEST\.json/);
});

test('status is read-only and JSON preserves the structured result', async () => {
  let statusReads = 0;
  const execution = await runRecoveryHandoffCommand(['status', '--json'], {
    service: { status() { statusReads += 1; return { ok: true, available: false, root: '~/.ai-control-center/recovery' }; } }
  });
  assert.equal(statusReads, 1);
  assert.deepEqual(JSON.parse(execution.output), { ok: true, available: false, root: '~/.ai-control-center/recovery' });
});
