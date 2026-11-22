// Source-owned A1 pool policy. No credential, config or persistent state mutation.
import { getAccountQuota, resetAtToMs, type StoredAccountQuota } from "../quota";

export const AICC_ADMISSION_FRESHNESS_MS = 60_000;
const observations = new Map<string, number>();
const finitePercent = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

export function aiccWindowPolicyEnabled(): boolean {
  return process.env.AICC_OCX_WINDOW_THRESHOLDS === "95,98";
}

export function noteAiccAdmissionObservation(accountId: string, success: boolean, now = Date.now()): void {
  if (!success) observations.delete(accountId);
  else observations.set(accountId, now);
  for (const [id, at] of observations) if (now - at > AICC_ADMISSION_FRESHNESS_MS) observations.delete(id);
}

export function aiccQuotaAdmission(quota: StoredAccountQuota | null, observedAt: number | undefined, now = Date.now()): { allowed: boolean; reason: string; retryAt: number } {
  const fallback = now + 60_000;
  if (!quota || observedAt === undefined || observedAt > now || now - observedAt > AICC_ADMISSION_FRESHNESS_MS)
    return { allowed: false, reason: "quota_unverified", retryAt: fallback };
  const long = [quota.weeklyPercent, quota.monthlyPercent].filter(finitePercent);
  if (!finitePercent(quota.shortPercent) || long.length === 0)
    return { allowed: false, reason: "quota_incomplete", retryAt: fallback };
  const exhausted = [
    ...(quota.shortPercent >= 95 ? [quota.shortResetAt] : []),
    ...(finitePercent(quota.weeklyPercent) && quota.weeklyPercent >= 98 ? [quota.weeklyResetAt] : []),
    ...(finitePercent(quota.monthlyPercent) && quota.monthlyPercent >= 98 ? [quota.monthlyResetAt] : []),
  ];
  if (quota.shortPercent >= 95 || long.some(percent => percent >= 98)) {
    const resets = exhausted.filter((reset): reset is number => typeof reset === "number" && Number.isFinite(reset))
      .map(resetAtToMs).filter(reset => reset > now);
    return { allowed: false, reason: quota.shortPercent >= 95 ? "five_hour_threshold" : "long_window_threshold", retryAt: resets.length ? Math.max(...resets) : fallback };
  }
  return { allowed: true, reason: "headroom", retryAt: 0 };
}

export function aiccAccountAdmission(accountId: string, now = Date.now()) {
  if (!aiccWindowPolicyEnabled()) return { allowed: true, reason: "policy_disabled", retryAt: 0 };
  return aiccQuotaAdmission(getAccountQuota(accountId), observations.get(accountId), now);
}
