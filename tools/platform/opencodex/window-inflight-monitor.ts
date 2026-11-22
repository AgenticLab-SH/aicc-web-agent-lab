// Token-free, injected monitor. One bounded quota flight per serving account;
// disposing the last subscriber removes its timer, even if that flight hangs.
export const AICC_INFLIGHT_POLL_MS = 5_000;
export const AICC_INFLIGHT_FRESHNESS_MS = 15_000;
export const AICC_INFLIGHT_TICK_MS = 1_000;
export const AICC_INFLIGHT_MAX_ACCOUNTS = 16;
export type InflightQuota = { shortPercent?: number; weeklyPercent?: number; monthlyPercent?: number;
  // False only when a fresh supplier response explicitly declares a long-only window.
  shortWindowApplicable?: boolean };
export type InflightSettings = {
  thresholdProtection?: boolean;
  fiveHour: { usedThreshold: number; action: 'switch' | 'stop'; enabled?: boolean };
  longWindow: { usedThreshold: number; action: 'switch' | 'stop'; enabled?: boolean };
};
export type InflightReason = 'five_hour_threshold' | 'long_window_threshold'
  | 'quota_unverified' | 'quota_incomplete' | 'credential_changed'
  | 'invalid_window_policy' | 'monitor_capacity';
export type InflightMonitorDeps = {
  enabled: () => boolean;
  now: () => number;
  settings: (id?: string) => InflightSettings;
  snapshot: (id: string) => InflightQuota | null;
  generationLive: (id: string, generation: number) => boolean;
  refresh: (id: string) => Promise<{ quota: InflightQuota | null; generation?: number; verified: boolean }>;
  noteObservation: (id: string, verified: boolean) => void;
  schedule: (callback: () => void, periodMs: number) => () => void;
};
type Entry = {
  id: string; generation: number; freshAt: number; pollAt: number;
  busy: boolean; disposed: boolean; stopTimer: () => void;
  subscribers: Set<(reason: InflightReason) => void>;
};
const percentage = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
export const isCompleteInflightQuota = (quota: InflightQuota | null): quota is InflightQuota => !!quota
  && (percentage(quota.shortPercent) || (quota.shortWindowApplicable===false && quota.shortPercent===undefined))
  && [quota.weeklyPercent, quota.monthlyPercent].some(percentage);

// Disabling an early cutoff never makes an exhausted account usable. Keep this
// decision identical in selection, the final HTTP gate and the in-flight monitor.
export function quotaThresholdHits(quota: InflightQuota | null, settings: InflightSettings) {
  for (const rule of [settings.fiveHour, settings.longWindow]) {
    if (!rule || !Number.isInteger(rule.usedThreshold) || rule.usedThreshold < 1 || rule.usedThreshold > 100
      || !['switch', 'stop'].includes(rule.action)
      || (rule.enabled !== undefined && typeof rule.enabled !== 'boolean')) throw Error('invalid_window_policy');
  }
  const limit = (rule: InflightSettings['fiveHour']) =>
    settings.thresholdProtection === false || rule.enabled === false ? 100 : rule.usedThreshold;
  return {fiveHour:!!quota && percentage(quota.shortPercent) && quota.shortPercent >= limit(settings.fiveHour),
    longWindow:!!quota && [quota.weeklyPercent, quota.monthlyPercent].some(value => percentage(value) && value >= limit(settings.longWindow))};
}
export function quotaThresholdReason(quota: InflightQuota | null, settings: InflightSettings): InflightReason | undefined {
  const hits=quotaThresholdHits(quota,settings);
  return hits.fiveHour?'five_hour_threshold':hits.longWindow?'long_window_threshold':undefined;
}

export function createAiccInflightMonitor(deps: InflightMonitorDeps) {
  const entries = new Map<string, Entry>();
  function retire(entry: Entry) {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.stopTimer();
    if (entries.get(entry.id) === entry) entries.delete(entry.id);
  }
  function cutoff(entry: Entry, reason: InflightReason) {
    if (entry.disposed) return;
    // Never invalidate a replacement credential's admission observation.
    if (['quota_unverified', 'quota_incomplete'].includes(reason)
      && deps.generationLive(entry.id, entry.generation)) deps.noteObservation(entry.id, false);
    const subscribers = [...entry.subscribers];
    entry.subscribers.clear();
    retire(entry);
    for (const notify of subscribers) { try { notify(reason); } catch { /* notify all callers */ } }
  }
  function threshold(quota: InflightQuota | null, id: string): InflightReason | undefined {
    return quotaThresholdReason(quota, deps.settings(id));
  }
  function inspect(entry: Entry) {
    if (entry.disposed) return;
    try {
      if (!deps.enabled()) { cutoff(entry, 'invalid_window_policy'); return; }
      if (!deps.generationLive(entry.id, entry.generation)) { cutoff(entry, 'credential_changed'); return; }
      const quota = deps.snapshot(entry.id);
      const hit = threshold(quota, entry.id);
      if (hit) { cutoff(entry, hit); return; }
      if (!isCompleteInflightQuota(quota)) { cutoff(entry, 'quota_incomplete'); return; }
      const age = deps.now() - entry.freshAt;
      if (age < 0 || age >= AICC_INFLIGHT_FRESHNESS_MS) cutoff(entry, 'quota_unverified');
    } catch { cutoff(entry, 'invalid_window_policy'); }
  }
  async function poll(entry: Entry) {
    if (entry.disposed || entry.busy) return;
    entry.busy = true;
    entry.pollAt = deps.now();
    try {
      const result = await deps.refresh(entry.id);
      if (entry.disposed || entries.get(entry.id) !== entry) return;
      if ((result.generation !== undefined && result.generation !== entry.generation) || !deps.generationLive(entry.id, entry.generation)) {
        cutoff(entry, 'credential_changed'); return;
      }
      // A helper may return cached quota after a failed network read. Never renew
      // the watchdog from that cache, a credential-only reply, or incomplete data.
      if (!result.verified) return;
      if (!isCompleteInflightQuota(result.quota)) { cutoff(entry, 'quota_incomplete'); return; }
      const hit = threshold(result.quota, entry.id);
      entry.freshAt = deps.now();
      deps.noteObservation(entry.id, true);
      if (hit) cutoff(entry, hit);
    } catch { /* bounded freshness timer still runs independently of the flight */ }
    finally { entry.busy = false; }
  }
  function subscribe(id: string, generation: number, notify: (reason: InflightReason) => void): () => void {
    if (!deps.enabled()) return () => {};
    let entry = entries.get(id);
    if (entry && entry.generation !== generation) { cutoff(entry, 'credential_changed'); entry = undefined; }
    if (!entry) {
      if (entries.size >= AICC_INFLIGHT_MAX_ACCOUNTS) { notify('monitor_capacity'); return () => {}; }
      // The caller has just passed the existing fresh, generation-bound admission.
      // Force another quota read immediately; do not wait for the first interval.
      entry = { id, generation, freshAt: deps.now(), pollAt: -Infinity, busy: false,
        disposed: false, stopTimer: () => {}, subscribers: new Set() };
      entries.set(id, entry);
      const watched = entry;
      entry.stopTimer = deps.schedule(() => {
        inspect(watched);
        if (!watched.disposed && deps.now() - watched.pollAt >= AICC_INFLIGHT_POLL_MS) void poll(watched);
      }, AICC_INFLIGHT_TICK_MS);
    }
    const watched = entry;
    watched.subscribers.add(notify);
    inspect(watched);
    if (!watched.disposed) void poll(watched);
    return () => {
      watched.subscribers.delete(notify);
      if (!watched.subscribers.size) retire(watched);
    };
  }
  function observe(id: string, generation: number, quota: InflightQuota, observedAt: number) {
    const entry = entries.get(id);
    if (!entry || entry.generation !== generation || entry.disposed) return;
    if (!deps.generationLive(id, generation)) { cutoff(entry, 'credential_changed'); return; }
    const age = deps.now() - observedAt;
    if (!Number.isFinite(observedAt) || age < 0 || age >= AICC_INFLIGHT_FRESHNESS_MS) return;
    try {
      // Even a partial metadata frame can positively prove a threshold hit.
      // Only a complete frame renews the freshness budget.
      const hit = threshold(quota, id);
      if (hit) { cutoff(entry, hit); return; }
      if (isCompleteInflightQuota(quota)) entry.freshAt = observedAt;
    } catch { cutoff(entry, 'invalid_window_policy'); }
  }
  return { subscribe, observe, activeAccounts: () => entries.size };
}
