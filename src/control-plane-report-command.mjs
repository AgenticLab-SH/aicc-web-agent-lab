import { ControlReportStore } from './control-plane/report-store.mjs';

export function runControlReportCommand(subcommand, input = null, options = {}) {
  const store = options.store ?? new ControlReportStore(options);
  if (subcommand === 'write') return store.write(input);
  if (subcommand === 'status') return store.status();
  if (subcommand === 'digest') return store.digest({ since: options.since ?? null });
  throw new Error('usage: aicc report write|status|digest [--since SHA256] [--json]');
}
