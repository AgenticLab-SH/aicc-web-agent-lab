import {test,expect} from 'bun:test';
import {createExternalOcxHttpBoundary} from '../tools/platform/opencodex/external-http-boundary';
import {ExternalSafeFault} from '../tools/platform/opencodex/external-safe-fault';
import {PickerError} from '../tools/platform/opencodex/external-account-picker';
const ids={requestId:'request-exact-123',threadId:'11111111-1111-4111-8111-111111111111',turnId:'22222222-2222-4222-8222-222222222222'};

test('real selected backend exhaustion maps to official Codex usage limit; policy thresholds and invalid source never do',async()=>{
 const reset=Math.ceil(Date.now()/1000)+3600;
 for(const source of [null,{ownerRequestId:'33333333-3333-4333-8333-333333333333',receiptSha256:'a'.repeat(64),
   kind:'aicc-ocx-original-fivehour-pre-dispatch-refusal/v1',dispatchable:false as const},
   {ownerRequestId:'33333333-3333-4333-8333-333333333333',receiptSha256:'a'.repeat(64),
   kind:'aicc-ocx-original-fivehour-pre-dispatch-refusal/v1',dispatchable:false as const,codexUsageLimit:{resetsAt:reset,windowMinutes:300 as const}},
   {ownerRequestId:'bad',receiptSha256:'a'.repeat(64),kind:'aicc-ocx-original-fivehour-pre-dispatch-refusal/v1',dispatchable:false as const,codexUsageLimit:{resetsAt:reset,windowMinutes:300 as const}},
   {ownerRequestId:'33333333-3333-4333-8333-333333333333',receiptSha256:'a'.repeat(64),kind:'aicc-ocx-original-fivehour-pre-dispatch-refusal/v1',dispatchable:false as const,codexUsageLimit:{resetsAt:1,windowMinutes:300 as const}}]){
   let sends=0;
   const b=createExternalOcxHttpBoundary({dataToken:()=> 'fixture',settings:()=>({fiveHour:{usedThreshold:97,action:'stop'},longWindow:{usedThreshold:98,action:'stop'}}),
    select:async()=>{throw new ExternalSafeFault('window_threshold');},generationLive:()=>true,quota:()=>null,
    refresh:async()=>({quota:null,verified:false}),dispatch:async()=>{sends++;return new Response('unexpected');},catalog:async()=>new Response('{}'),noteOriginalQuotaRefusal:()=>source});
   const r=await b.handle(new Request('http://127.0.0.1:10100/v1/responses',{method:'POST',headers:{authorization:'Bearer fixture'},body:'{}'}));
   const value=await r.json(),valid=source?.ownerRequestId.startsWith('3333')&&source.codexUsageLimit?.resetsAt===reset;
   expect(value.error.type).toBe(valid?'usage_limit_reached':'quota_protection_error');
   expect(value.error.resets_at).toBe(valid?reset:undefined);
   expect(value.error.limit_window_minutes).toBe(valid?300:undefined);
   expect(r.headers.get('x-should-retry')).toBe('false');expect(sends).toBe(0);expect(value.error.code).toBe('window_stop_policy');
 }
});
function fixture(reason:string,afterDispatch=false,headers:Record<string,string>={},typed=true,physicalProof:boolean|null=true){
 let dispatched=0;
 const quota={shortPercent:1,weeklyPercent:1};
 const boundary=createExternalOcxHttpBoundary({
  dataToken:()=> 'fixture',settings:()=>({fiveHour:{usedThreshold:97,action:'switch'},longWindow:{usedThreshold:97,action:'switch'}}),
  select:async()=>{if(!afterDispatch)throw typed
    ? reason.startsWith('picker_')?new PickerError(reason):new ExternalSafeFault(reason)
    : Error(reason);return {accountId:'pool',chatgptAccountId:'account',accessToken:'fixture-access',generation:1,quota,quotaObservedAt:Date.now()};},
  generationLive:()=>true,quota:()=>quota,refresh:async()=>({quota,verified:true,generation:1}),
  // Dispatch function invocation alone is not physical-send proof. This fake runner supplies it explicitly.
  dispatchEvidence:()=>({dispatchStarted:physicalProof,source:physicalProof===true?'provider_fetch_invoked':'supplier_handoff'}),
  dispatch:async()=>{dispatched++;throw Error(reason);},catalog:async()=>new Response('{}')
 });
 const request=new Request('http://127.0.0.1:10100/v1/responses',{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json',...headers},body:'{"input":"private fixture body"}'});
 return {run:()=>boundary.handle(request),count:()=>dispatched};
}
test('an active request is a non-retryable conflict, with no provider dispatch',async()=>{
 const f=fixture('conversation_request_active',false,{'thread-id':ids.threadId,'x-request-id':ids.requestId});
 const r=await f.run();
 expect(r.status).toBe(409);expect(r.headers.get('x-should-retry')).toBe('false');
 expect(r.headers.get('x-aicc-failure-code')).toBe('conversation_request_active');
 expect(r.headers.get('x-aicc-dispatch-started')).toBe('false');
 expect(f.count()).toBe(0);
});

test('only exact pre-dispatch quota reasons retain bounded identity and canonical code',async()=>{
 for(const reason of ['window_stop_policy','window_threshold']){
  const f=fixture(reason,false,{'x-request-id':ids.requestId,'thread-id':ids.threadId,'x-codex-turn-id':ids.turnId,secret:'never-return'});
  const r=await f.run(),body=await r.json();
  expect(r.status).toBe(429);expect(f.count()).toBe(0);expect(body.error.code).toBe('window_stop_policy');
  expect(body.error.quotaRefusal).toMatchObject({...ids,reason,phase:'pre_dispatch',dispatchStarted:false,replayed:false});
  expect(JSON.stringify(body)).not.toContain('private fixture');expect(JSON.stringify(body)).not.toContain('never-return');
 }
});
test('unknown reason and a same-named post-dispatch error preserve uncertain503',async()=>{
 for(const [reason,after] of [['quota_unverified',false],['raw-secret',false],['window_stop_policy',true],['window_threshold',true]] as const){
  const f=fixture(reason,after),r=await f.run(),body=await r.json();
  expect(r.status).toBe(503);expect(body.error.code).toBe('external_request_not_completed');
  expect(body.error.quotaRefusal).toBeUndefined();expect(f.count()).toBe(after?1:0);
  expect(body.error.failure).toMatchObject({phase:after?'dispatch_started':'pre_dispatch',dispatchStarted:after,replayed:false});
  expect(JSON.stringify(body)).not.toContain('raw-secret');expect(r.headers.get('x-should-retry')).toBe('false');
 }
});
test('allowlisted local selection code is visible while raw secrets and post-dispatch lookalikes stay private',async()=>{
 for(const reason of ['bound_pool_account_not_admissible','picker_model_effort_unsupported']){
  const f=fixture(reason),r=await f.run(),body=await r.json();
  expect(body.error.code).toBe('external_request_not_completed');
  expect(body.error.failure).toEqual({code:reason,phase:'pre_dispatch',dispatchStarted:false,replayed:false});
  expect(f.count()).toBe(0);
  const after=fixture(reason,true),afterBody=await(await after.run()).json();
  expect(afterBody.error.failure.code).toBe('dispatch_failed');expect(after.count()).toBe(1);
 }
 const f=fixture('secret-token-and-private-identity'),body=await(await f.run()).json();
 expect(body.error.failure.code).toBe('selection_failed');expect(JSON.stringify(body)).not.toContain('secret-token-and-private-identity');
});
test('first-party 503 exposes only bounded code, phase and dispatch state in headers',async()=>{
 const local=await fixture('preferred_pool_account_unavailable').run();
 expect(local.headers.get('x-aicc-failure-code')).toBe('preferred_pool_account_unavailable');
 expect(local.headers.get('x-aicc-failure-phase')).toBe('pre_dispatch');
 expect(local.headers.get('x-aicc-dispatch-started')).toBe('false');
 const uncertain=await fixture('secret-token-and-private-identity',true).run();
 expect(uncertain.headers.get('x-aicc-failure-code')).toBe('dispatch_failed');
 expect(uncertain.headers.get('x-aicc-failure-phase')).toBe('dispatch_started');
 expect(uncertain.headers.get('x-aicc-dispatch-started')).toBe('true');
 expect(JSON.stringify([...uncertain.headers])).not.toContain('secret-token-and-private-identity');
});
test('untrusted upstream 503 cannot spoof first-party diagnostic headers',async()=>{
 const quota={shortPercent:1,weeklyPercent:1};
 const boundary=createExternalOcxHttpBoundary({dataToken:()=> 'fixture',
  settings:()=>({fiveHour:{usedThreshold:97,action:'switch'},longWindow:{usedThreshold:97,action:'switch'}}),
  select:async()=>({accountId:'pool',chatgptAccountId:'account',accessToken:'fixture-access',generation:1,quota,quotaObservedAt:Date.now()}),
  generationLive:()=>true,quota:()=>quota,refresh:async()=>({quota,verified:true,generation:1}),
  dispatch:async request=>{
   expect(request.headers.has('x-aicc-failure-code')).toBe(false);
   return new Response('upstream',{status:503,headers:{'x-aicc-failure-code':'dispatch_failed',
    'x-aicc-failure-phase':'dispatch_started','x-aicc-dispatch-started':'true'}});
  },catalog:async()=>new Response('{}')});
 const request=new Request('http://127.0.0.1:10100/v1/responses',{method:'POST',
  headers:{authorization:'Bearer fixture','x-aicc-failure-code':'selection_failed'},body:'{}'});
 const response=await boundary.handle(request);
 expect(response.status).toBe(503);
 for(const key of ['x-aicc-failure-code','x-aicc-failure-phase','x-aicc-dispatch-started']) expect(response.headers.has(key)).toBe(false);
});
test('parent thread hint and invalid IDs cannot manufacture bound proof',async()=>{
 const f=fixture('window_stop_policy',false,{'x-request-id':'bad','x-codex-parent-thread-id':ids.threadId,'turn-id':'bad'});
 const body=await(await f.run()).json();
 expect(body.error.quotaRefusal.requestId).toBeNull();expect(body.error.quotaRefusal.threadId).toBeNull();expect(body.error.quotaRefusal.turnId).toBeNull();
});
test('same-named plain errors cannot forge local quota or picker diagnostic provenance',async()=>{
 for(const reason of ['window_threshold','window_stop_policy','picker_model_effort_unsupported','preferred_pool_account_unavailable']){
  const f=fixture(reason,false,{},false),response=await f.run(),body=await response.json();
  expect(response.status).toBe(503);expect(f.count()).toBe(0);
  expect(body.error.quotaRefusal).toBeUndefined();
  expect(body.error.failure).toEqual({code:'selection_failed',phase:'pre_dispatch',dispatchStarted:false,replayed:false});
  expect(JSON.stringify(body)).not.toContain(reason);
 }
});
test('unknown supplier handoff stays unknown and cannot emit a proven dispatch header',async()=>{
 const f=fixture('raw-secret',true,{},false,null),response=await f.run(),body=await response.json();
 expect(response.status).toBe(503);expect(f.count()).toBe(1);
 expect(body.error.failure).toEqual({code:'dispatch_failed',phase:null,dispatchStarted:null,replayed:false});
 for(const key of ['x-aicc-failure-code','x-aicc-failure-phase','x-aicc-dispatch-started'])expect(response.headers.has(key)).toBe(false);
 expect(JSON.stringify(body)).not.toContain('raw-secret');
});
test('HTTP200 and EOF alone do not release a completed conversation settlement',async()=>{
 const quota={shortPercent:1,weeklyPercent:1},settlements:string[]=[];
 const boundary=createExternalOcxHttpBoundary({dataToken:()=> 'fixture',
  settings:()=>({fiveHour:{usedThreshold:97,action:'switch'},longWindow:{usedThreshold:97,action:'switch'}}),
  select:async()=>({accountId:'pool',chatgptAccountId:'account',accessToken:'fixture-access',generation:1,quota,quotaObservedAt:Date.now()}),
  generationLive:()=>true,quota:()=>quota,refresh:async()=>({quota,verified:true,generation:1}),
  dispatchEvidence:()=>({dispatchStarted:true,source:'provider_fetch_invoked'}),
  dispatch:async()=>new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}),
  noteSettlement:(_request,outcome)=>settlements.push(outcome),catalog:async()=>new Response('{}')});
 const request=new Request('http://127.0.0.1:10100/v1/responses',{method:'POST',headers:{authorization:'Bearer fixture'},body:'{}'});
 const response=await boundary.handle(request);await response.text();
 expect(settlements).toEqual(['unknown']);
});

