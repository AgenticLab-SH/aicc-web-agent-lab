import {getAccountQuota,resetAtToMs,type StoredAccountQuota} from '../quota';
import {readAiccWindowSettings} from './aicc-window-settings';
export const AICC_ADMISSION_FRESHNESS_MS=60_000;
const observations=new Map<string,number>();
const percent=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100;
export function aiccWindowPolicyEnabled(){return Boolean(process.env.AICC_OCX_WINDOW_THRESHOLDS);}
export function noteAiccAdmissionObservation(id:string,success:boolean,now=Date.now()){
  if(success)observations.set(id,now);else observations.delete(id);
  for(const [key,at] of observations)if(now-at>AICC_ADMISSION_FRESHNESS_MS)observations.delete(key);
}
function breaches(quota:StoredAccountQuota){
  const settings=readAiccWindowSettings();
  return [
    ...(percent(quota.shortPercent)&&quota.shortPercent>=settings.fiveHour.usedThreshold?[{reason:'five_hour_threshold',reset:quota.shortResetAt,action:settings.fiveHour.action}]:[]),
    ...(percent(quota.weeklyPercent)&&quota.weeklyPercent>=settings.longWindow.usedThreshold?[{reason:'long_window_threshold',reset:quota.weeklyResetAt,action:settings.longWindow.action}]:[]),
    ...(percent(quota.monthlyPercent)&&quota.monthlyPercent>=settings.longWindow.usedThreshold?[{reason:'long_window_threshold',reset:quota.monthlyResetAt,action:settings.longWindow.action}]:[])
  ];
}
export function aiccQuotaAdmission(quota:StoredAccountQuota|null,observedAt:number|undefined,now=Date.now()){
  const fallback=now+60_000;
  if(!quota||observedAt===undefined||observedAt>now||now-observedAt>AICC_ADMISSION_FRESHNESS_MS)return {allowed:false,reason:'quota_unverified',retryAt:fallback};
  if(!percent(quota.shortPercent)||![quota.weeklyPercent,quota.monthlyPercent].some(percent))return {allowed:false,reason:'quota_incomplete',retryAt:fallback};
  const hit=breaches(quota);
  if(hit.length){const resets=hit.map(row=>row.reset).filter((r):r is number=>typeof r==='number'&&Number.isFinite(r)).map(resetAtToMs).filter(r=>r>now);return {allowed:false,reason:hit[0]!.reason,retryAt:resets.length?Math.max(...resets):fallback};}
  return {allowed:true,reason:'headroom',retryAt:0};
}
export function aiccAccountAdmission(id:string,now=Date.now()){
  if(!aiccWindowPolicyEnabled())return {allowed:true,reason:'policy_disabled',retryAt:0};
  return aiccQuotaAdmission(getAccountQuota(id),observations.get(id),now);
}
export function aiccStopPolicyAdmission(originalId:string|undefined,now=Date.now()){
  if(!originalId||!aiccWindowPolicyEnabled())return {allowed:true,reason:'no_stop_rule',retryAt:0};
  const quota=getAccountQuota(originalId),admission=aiccQuotaAdmission(quota,observations.get(originalId),now);
  if(!quota||['quota_unverified','quota_incomplete'].includes(admission.reason))return admission;
  return breaches(quota).some(row=>row.action==='stop')?{...admission,reason:'window_stop_policy'}:{allowed:true,reason:'switch_permitted',retryAt:0};
}
