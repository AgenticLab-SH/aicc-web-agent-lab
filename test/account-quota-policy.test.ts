import {test,expect} from 'bun:test';
import {resolveAccountQuotaProtection,resolveAccountWindowOverrides} from '../tools/platform/opencodex/external-pool-state';
import {createExternalOcxHttpBoundary} from '../tools/platform/opencodex/external-http-boundary';
import {createAiccInflightMonitor,quotaThresholdReason} from '../tools/platform/opencodex/window-inflight-monitor';
const config={codexAccounts:[{id:'b',alias:'2번(other)'},{id:'a',alias:'1번(main)'},{id:'c',alias:'3번'}]};
const policy={schemaVersion:1,defaultOtherAccounts:false,overrides:{}};
test('explicit migration keeps account1 protected and disables other numbered accounts independent of order',()=>{
 expect(resolveAccountQuotaProtection(config,undefined,'b')).toBe(true);
 expect(resolveAccountQuotaProtection(config,policy,'a')).toBe(true);
 expect(resolveAccountQuotaProtection(config,policy,'b')).toBe(false);
 expect(resolveAccountQuotaProtection(config,policy,'c')).toBe(false);
 expect(resolveAccountQuotaProtection(config,{...policy,overrides:{b:true}},'b')).toBe(true);
 expect(resolveAccountQuotaProtection(config,JSON.parse(JSON.stringify(policy)),'b')).toBe(false);
});
test('unknown and duplicate identity never silently disable protection',()=>{
 expect(resolveAccountQuotaProtection({codexAccounts:[{id:'x',alias:'unnumbered'}]},policy,'x')).toBe(true);
 expect(resolveAccountQuotaProtection({codexAccounts:[...config.codexAccounts,{id:'x',alias:'2番'}]},policy,'x')).toBe(true);
 expect(resolveAccountQuotaProtection({codexAccounts:[...config.codexAccounts,{id:'x',alias:'2번'}]},policy,'b')).toBe(true);
 expect(()=>resolveAccountQuotaProtection(config,policy,'absent')).toThrow();
 expect(()=>resolveAccountQuotaProtection(config,{...policy,overrides:{b:'false'}},'b')).toThrow();
});
async function request(protectedAccount:boolean,quota:any,generationLive=true){
 let calls=0;
 const boundary=createExternalOcxHttpBoundary({dataToken:()=> 'fixture',
  settings:()=>({thresholdProtection:protectedAccount,fiveHour:{usedThreshold:97,action:'switch'},longWindow:{usedThreshold:98,action:'switch'}}),
  select:async()=>({accountId:'b',chatgptAccountId:'fixture',accessToken:'fixture',generation:1,quota,quotaObservedAt:Date.now()}),
  generationLive:()=>generationLive,quota:()=>quota,refresh:async()=>({quota,verified:true,generation:1}),
  dispatch:async()=>{calls++;return new Response('data: {"type":"response.completed"}\n\n',{headers:{'content-type':'text/event-stream'}});},
  catalog:async()=>new Response('{}')});
 const response=await boundary.handle(new Request('http://localhost/v1/responses',{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:'{"model":"fixture","input":"test"}'}));
 await response.text();return {status:response.status,calls};
}
test('disabled early cutoff still refuses exhausted accounts and retains freshness completeness and generation gates',async()=>{
 expect(await request(false,{shortPercent:99,weeklyPercent:99})).toEqual({status:200,calls:1});
 expect(await request(false,{shortPercent:100,weeklyPercent:20})).toEqual({status:429,calls:0});
 expect(await request(false,{shortPercent:20,weeklyPercent:100})).toEqual({status:429,calls:0});
 expect((await request(true,{shortPercent:100,weeklyPercent:100})).calls).toBe(0);
 expect((await request(false,{shortPercent:100})).calls).toBe(0);
 expect((await request(false,{shortPercent:100,weeklyPercent:100},false)).calls).toBe(0);
});
test('monitor resolves the serving account on initial, refresh and metadata checks',async()=>{
 const seen:string[]=[],cuts:string[]=[];let clock=100;let tick=()=>{};
 const monitor=createAiccInflightMonitor({enabled:()=>true,now:()=>clock,
  settings:id=>{seen.push(id!);return {thresholdProtection:id==='a',fiveHour:{usedThreshold:97,action:'switch'},longWindow:{usedThreshold:98,action:'switch'}};},
  snapshot:()=>({shortPercent:99,weeklyPercent:99}),generationLive:()=>true,
  refresh:async()=>({quota:{shortPercent:99,weeklyPercent:99},verified:true,generation:1}),noteObservation:()=>{},
  schedule:callback=>{tick=callback;return ()=>{};}});
 const stop=monitor.subscribe('b',1,reason=>cuts.push(reason));
 await Promise.resolve();await Promise.resolve();
 monitor.observe('b',1,{shortPercent:99,weeklyPercent:99},clock);tick();
 expect(cuts).toEqual([]);expect(seen.every(id=>id==='b')).toBe(true);
 stop();monitor.subscribe('a',1,reason=>cuts.push(reason));expect(cuts).toEqual(['five_hour_threshold']);
});

test('five-hour and long-window early limits are independent, with an unavoidable actual exhaustion gate',()=>{
 const settings:any={thresholdProtection:true,fiveHour:{usedThreshold:98,action:'switch',enabled:true},longWindow:{usedThreshold:97,action:'switch',enabled:false}};
 expect(quotaThresholdReason({shortPercent:97,weeklyPercent:99},settings)).toBeUndefined();
 expect(quotaThresholdReason({shortPercent:98,weeklyPercent:99},settings)).toBe('five_hour_threshold');
 expect(quotaThresholdReason({shortPercent:20,weeklyPercent:100},settings)).toBe('long_window_threshold');
 expect(quotaThresholdReason({shortWindowApplicable:false,monthlyPercent:100},settings)).toBe('long_window_threshold');
 expect(quotaThresholdReason({shortWindowApplicable:false,monthlyPercent:99},settings)).toBeUndefined();
 expect(quotaThresholdReason({shortPercent:100,weeklyPercent:10},{...settings,thresholdProtection:false})).toBe('five_hour_threshold');
});

test('account window overrides reject malformed thresholds and action injection',()=>{
 const windows={b:{fiveHour:{usedThreshold:98,enabled:true},longWindow:{enabled:false}}};
 expect(resolveAccountWindowOverrides({...policy,windowOverrides:windows},'b')).toEqual(windows.b);
 for(const value of [NaN,0,101,98.5,'98'])expect(()=>resolveAccountWindowOverrides({...policy,windowOverrides:{b:{fiveHour:{usedThreshold:value}}}},'b')).toThrow();
 expect(()=>resolveAccountWindowOverrides({...policy,windowOverrides:{b:{longWindow:{action:'switch'}}}},'b')).toThrow();
});
