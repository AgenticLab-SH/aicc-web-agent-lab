import { getAccountQuota, type StoredAccountQuota } from '../quota';
import { isCodexAccountGenerationLive } from '../account-store';
import type { CodexAuthContext } from '../auth-context';
import { fetchPoolAccountQuota } from '../auth-api/pool-quota-probe';
import { aiccWindowPolicyEnabled, noteAiccAdmissionObservation } from './aicc-window-admission';
import { readAiccWindowSettings } from './aicc-window-settings';
import { createAiccInflightMonitor, type InflightReason } from './aicc-inflight-monitor';

export const AICC_INFLIGHT_CUTOFF_CODE = 'aicc_window_inflight_cutoff';
export class AiccInflightQuotaCutoff extends Error {
  readonly code = AICC_INFLIGHT_CUTOFF_CODE;
  constructor(readonly reason: InflightReason) {
    super(`AICC pool request interrupted to preserve quota: ${reason}. This request was not replayed. A new request will reselect a verified eligible account.`);
    this.name = 'AiccInflightQuotaCutoff';
  }
}
const monitor = createAiccInflightMonitor({
  enabled: aiccWindowPolicyEnabled,
  now: Date.now,
  settings: readAiccWindowSettings,
  snapshot: getAccountQuota,
  generationLive: isCodexAccountGenerationLive,
  refresh: async id => {
    const result = await fetchPoolAccountQuota(id, true);
    return { quota: result.freshQuota ?? null, generation: result.freshCredentialGeneration,
      verified: result.freshQuota !== undefined && !result.needsReauth
        && result.freshCredentialGeneration !== undefined
        && isCodexAccountGenerationLive(id, result.freshCredentialGeneration) };
  },
  noteObservation: noteAiccAdmissionObservation,
  schedule: (callback, periodMs) => {
    const timer = setInterval(callback, periodMs);
    timer.unref?.();
    return () => clearInterval(timer);
  },
});

// Called only after the upstream metadata's exact Pool credential/writer check.
export function observeAiccInflightQuota(id: string, generation: number, quota: StoredAccountQuota) {
  monitor.observe(id, generation, quota, quota.updatedAt);
}

export function createAiccInflightRequestGuard(signal: AbortSignal) {
  const controller = new AbortController();
  let stopWatch = () => {};
  let disposed = false;
  let bound: { id: string; generation: number } | undefined;
  let cutoff: AiccInflightQuotaCutoff | undefined;
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  function bind(context: CodexAuthContext | undefined) {
    if (context?.kind === 'pool' && bound?.id === context.accountId && bound.generation === context.generation) return;
    stopWatch(); stopWatch = () => {};
    bound = undefined;
    if (disposed || controller.signal.aborted || !context || context.kind !== 'pool' || !aiccWindowPolicyEnabled()) return;
    bound = { id: context.accountId, generation: context.generation };
    const unsubscribe = monitor.subscribe(context.accountId, context.generation, reason => {
      if (disposed || controller.signal.aborted) return;
      cutoff = new AiccInflightQuotaCutoff(reason);
      controller.abort(cutoff);
    });
    if (disposed) unsubscribe();
    else stopWatch = unsubscribe;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    stopWatch(); stopWatch = () => {};
    signal.removeEventListener('abort', onAbort);
  }
  return { signal: controller.signal, bind, dispose,
    cutoff: () => cutoff, cancel: (reason: unknown) => controller.abort(reason) };
}
