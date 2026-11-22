import { createRecoveryHandoffService } from './recovery-handoff.mjs';

export const RECOVERY_HANDOFF_HELP = `AICC owner-only Web GPT recovery handoff

Usage:
  aicc recovery-handoff status [--json]
  aicc recovery-handoff refresh [--json]

refresh writes a secret-free Markdown/JSON/manifest bundle and mirrors it to the
workspace .aicc-recovery/LATEST.* paths. It does not restart or switch any route,
account, browser, Desktop, Tunnel, Workspace runtime, publication, or callback.`;

export function parseRecoveryHandoffArgs(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) return { mode: 'help', json: false };
  const args = [...argv];
  const jsonIndex = args.indexOf('--json');
  const json = jsonIndex >= 0;
  if (json) args.splice(jsonIndex, 1);
  if (args.includes('--json')) throw new Error('duplicate option: --json');
  const mode = args.shift() ?? 'status';
  if (args.length) throw new Error(`unknown recovery-handoff option: ${args.join(' ')}`);
  if (!['status', 'refresh'].includes(mode)) throw new Error('recovery-handoff expects status or refresh');
  return { mode, json };
}

export async function runRecoveryHandoffCommand(argv = [], options = {}) {
  const parsed = parseRecoveryHandoffArgs(argv);
  if (parsed.mode === 'help') return { exitCode: 0, output: `${RECOVERY_HANDOFF_HELP}\n`, result: null };
  const service = options.service ?? createRecoveryHandoffService(options.serviceOptions);
  const result = parsed.mode === 'refresh' ? await service.refresh() : service.status();
  const output = parsed.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : result.available
      ? `${parsed.mode === 'refresh' ? 'PASS: recovery handoff refreshed' : 'READY: recovery handoff available'}\nMarkdown: ${result.mirror?.markdownPath ?? result.latest?.markdownPath ?? 'UNKNOWN'}\nJSON: ${result.mirror?.jsonPath ?? result.latest?.jsonPath ?? 'UNKNOWN'}\nManifest: ${result.mirror?.manifestPath ?? 'owner bundle manifest'}\n`
      : `HOLD: recovery handoff has not been generated\nRoot: ${result.root}\n`;
  return { exitCode: 0, output, result };
}
