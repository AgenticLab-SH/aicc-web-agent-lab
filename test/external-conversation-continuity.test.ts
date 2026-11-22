import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConversationFence} from '../tools/platform/opencodex/external-conversation-lifecycle';
import {createExternalOcxHttpBoundary} from '../tools/platform/opencodex/external-http-boundary';
import {ExternalSafeFault} from '../tools/platform/opencodex/external-safe-fault';
const key='a'.repeat(32),fingerprint='b'.repeat(64),nextFingerprint='c'.repeat(64);
const home=()=>mkdtempSync(join(tmpdir(),'aicc-continuity-'));
const request=()=>new Request('http://localhost/v1/responses',{method:'POST',headers:{authorization:'Bearer fixture'}});

test('new work follows an interrupted attempt while exact retries and concurrent work remain excluded',()=>{
  const root=home(),fence=createConversationFence(root),first=request(),next=request();
  fence.reserve(first,key,'a',fingerprint);fence.beforeDispatch(first);
  expect(()=>fence.reserve(next,key,'a',nextFingerprint)).toThrow('conversation_request_active');
  fence.settle(first,'unknown',()=>{throw Error('must not invent completion');});
  expect(()=>fence.reserve(request(),key,'a',fingerprint)).toThrow('request_outcome_unknown');
  fence.reserve(next,key,'a',nextFingerprint);
  // A late old settlement cannot release the successor's reservation.
  fence.settle(first,'completed',()=>{throw Error('stale settlement');});
  expect(()=>fence.assertIdle(key)).toThrow('conversation_request_active');
  fence.settle(next,'completed',()=>{});
  expect(fence.unknownCount()).toBe(1);expect(fence.inflightCount()).toBe(0);
  expect(()=>fence.reserve(request(),key,'a',fingerprint)).toThrow('request_outcome_unknown');
  const reloaded=createConversationFence(root);
  expect(()=>reloaded.reserve(request(),key,'a',fingerprint)).toThrow('request_outcome_unknown');
  expect(()=>reloaded.assertIdle(key,'d'.repeat(64))).not.toThrow();
  expect(readFileSync(join(root,'external-request-history.jsonl'),'utf8')).toContain('unresolved-attempt');
});

test('legacy and restarted records preserve uncertainty without a permanent conversation lock',()=>{
  const root=home();
  writeFileSync(join(root,'external-request-lifecycle.json'),JSON.stringify({schemaVersion:1,rows:[
    {key,operationId:'old-operation',accountId:'old-account',at:1,state:'dispatching'}]}));
  const fence=createConversationFence(root);
  expect(fence.unresolved(key)?.accountId).toBe('old-account');
  const next=request();fence.reserve(next,key,'old-account',nextFingerprint);
  fence.settle(next,'not_sent',()=>{});
  const reloaded=createConversationFence(root);
  expect(reloaded.unknownCount()).toBe(1);expect(reloaded.inflightCount()).toBe(0);
  expect(()=>reloaded.assertIdle(key)).not.toThrow();
});

test('request-scoped ambiguity returns a nonretryable conflict without a model dispatch',async()=>{
  let dispatches=0;
  const boundary=createExternalOcxHttpBoundary({dataToken:()=> 'fixture',settings:()=>({}) as any,
    select:async()=>{throw new ExternalSafeFault('request_outcome_unknown');},
    generationLive:()=>true,quota:()=>null,refresh:async()=>({quota:null,verified:false}),
    dispatch:async()=>{dispatches++;return Response.json({});},catalog:async()=>Response.json({})});
  const response=await boundary.handle(request());
  expect(response.status).toBe(409);expect(response.headers.get('x-should-retry')).toBe('false');
  expect((await response.json()).error.message).toContain('새 메시지');expect(dispatches).toBe(0);
});

test('a terminal failure releases a conversation before a transport that never reaches EOF',async()=>{
  const fence=createConversationFence(home());
  const quota={shortPercent:1,weeklyPercent:1};
  let cancelled=false,settlement='';
  const boundary=createExternalOcxHttpBoundary({dataToken:()=> 'fixture',
    settings:()=>({fiveHour:{usedThreshold:97,action:'switch'},longWindow:{usedThreshold:98,action:'switch'}}),
    select:async req=>{fence.reserve(req,key,'account',nextFingerprint);return {accountId:'account',chatgptAccountId:'account',accessToken:'fixture-access',generation:1,quota,quotaObservedAt:Date.now()};},
    beforeDispatch:req=>fence.beforeDispatch(req),
    noteSettlement:(req,outcome)=>{settlement=outcome;fence.settle(req,outcome,()=>{});},
    generationLive:()=>true,quota:()=>quota,refresh:async()=>({quota,verified:true,generation:1}),
    dispatch:async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n'));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}}),
    catalog:async()=>Response.json({})});
  const response=await boundary.handle(request()),reader=response.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  expect(settlement).toBe('failed');expect(boundary.activeTurns()).toBe(0);
  expect(fence.inflightCount()).toBe(0);expect(cancelled).toBe(true);
  expect((await reader.read()).done).toBe(true);
  expect(()=>fence.assertIdle(key)).not.toThrow();
});

test('weekly admission allows 97 percent under the 98 policy while short 97 and weekly 98 refuse',async()=>{
  for(const [shortPercent,weeklyPercent,longLimit,allowed] of [[1,97,98,true],[1,98,98,false],[97,1,98,false],[1,97,97,false]] as const){
    const quota={shortPercent,weeklyPercent};let dispatched=0;
    const boundary=createExternalOcxHttpBoundary({dataToken:()=> 'fixture',
      settings:()=>({fiveHour:{usedThreshold:97,action:'switch'},longWindow:{usedThreshold:longLimit,action:'switch'}}),
      select:async()=>({accountId:'account',chatgptAccountId:'account',accessToken:'fixture-access',generation:1,quota,quotaObservedAt:Date.now()}),
      generationLive:()=>true,quota:()=>quota,refresh:async()=>({quota,verified:true,generation:1}),
      dispatch:async()=>{dispatched++;return Response.json({status:'completed'});},catalog:async()=>Response.json({})});
    const response=await boundary.handle(request());await response.text();
    expect(response.status).toBe(allowed?200:429);expect(dispatched).toBe(allowed?1:0);
  }
});
