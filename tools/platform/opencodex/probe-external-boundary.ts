// Requested isolated acceptance. All credentials and upstreams are fixtures.
import assert from 'node:assert/strict';
import { createExternalCredentialOwner } from './external-credential-owner';
import { createExternalOcxHttpBoundary } from './external-http-boundary';
import { createAiccInflightMonitor } from './window-inflight-monitor';

const checks:string[]=[];
const rules={fiveHour:{usedThreshold:97,action:'switch' as const},longWindow:{usedThreshold:97,action:'switch' as const}};
const snap=()=>({ok:true,config:{codexAccounts:[{id:'pool',isMain:false}]},records:{pool:{generation:1}},settings:{schemaVersion:1,...rules}});
const credential=()=>({ok:true,accessToken:'fixture-access',chatgptAccountId:'fixture-account',generation:1,expiresAt:Date.now()+120_000});
function checked(name:string){checks.push(name);}
{
  let calls:any[]=[];
  const owner=createExternalCredentialOwner({request:async data=>{calls.push(data);return (data as any).action==='snapshot'?snap():credential();}});
  await Promise.all([owner.refreshSnapshot(),owner.refreshSnapshot()]);
  assert.equal(calls.length,1);checked('snapshot-concurrency-coalesced');
  const leases=await Promise.all([owner.lease('pool'),owner.lease('pool')]);
  assert.equal(calls.length,2);assert.equal(leases[0],leases[1]);checked('lease-concurrency-coalesced');
  assert.equal('refreshToken' in leases[0],false);checked('lease-has-no-refresh-grant');
  await owner.lease('pool',{rejectedGeneration:1,rejectedAccessToken:'fixture-access'});
  const recover=calls[2];
  assert.equal(recover.action,'recover');assert.equal(recover.rejectedHash.length,64);
  assert.equal(JSON.stringify(recover).includes('fixture-access'),false);checked('recover-shares-only-rejected-hash');
  await assert.rejects(owner.lease('__main__'));checked('native-main-refused');
  const controller=new AbortController();controller.abort();
  await assert.rejects(owner.lease('pool',{signal:controller.signal}));checked('cancelled-lease-refused');
}
for(const invalid of ['main','access','refresh']) {
  const value=snap();
  if(invalid==='main') value.config.codexAccounts[0].isMain=true;
  else (value.records.pool as any).credential={[invalid==='access'?'accessToken':'refreshToken']:'forbidden'};
  const owner=createExternalCredentialOwner({request:async()=>value});
  await assert.rejects(owner.refreshSnapshot());checked('snapshot-refuses-'+invalid);
}
for(const expiresAt of [Date.now()-1,Date.now()+30_000]) {
  const owner=createExternalCredentialOwner({request:async data=>(data as any).action==='snapshot'?snap():{...credential(),expiresAt}});
  await owner.refreshSnapshot();await assert.rejects(owner.lease('pool'));
  checked('expired-or-short-lived-access-lease-refused');
}
function fixture() {
  let quota:any={shortPercent:10,weeklyPercent:20};
  let generation=1,dispatches=0,selectionCalls=0,seen:Request|undefined;
  let transport=(request:Request)=>Promise.resolve(new Response('fixture-ok'));
  const deps={dataToken:()=> 'fixture-data-token',settings:()=>rules,
    select:async()=>{selectionCalls++;return {accountId:'pool',chatgptAccountId:'fixture-account',accessToken:'fixture-access',generation:1,quota,quotaObservedAt:Date.now()};},
    generationLive:(_id:string,g:number)=>g===generation,quota:()=>quota,
    refresh:async()=>({quota,generation,verified:true}),
    dispatch:async(request:Request)=>{dispatches++;seen=request;return transport(request);},
    catalog:async()=>Response.json({object:'list',data:[]}),};
  return {deps,quota:(q:any)=>{quota=q;},generation:(g:number)=>{generation=g;},
    transport:(fn:typeof transport)=>{transport=fn;},dispatches:()=>dispatches,selectionCalls:()=>selectionCalls,seen:()=>seen};
}
function request(options:{path?:string;auth?:string;signal?:AbortSignal;headers?:Record<string,string>}={}) {
  return new Request('http://127.0.0.1:10100'+(options.path??'/v1/responses'),{
    method:'POST',headers:{authorization:options.auth??'Bearer fixture-data-token','content-type':'application/json',...options.headers},
    body:'{"model":"fixture-model","input":"hello"}',signal:options.signal});
}
{
  const f=fixture(),b=createExternalOcxHttpBoundary(f.deps);
  const r=await b.handle(request({auth:'Bearer incorrect'}));assert.equal(r.status,401);
  assert.equal(f.selectionCalls(),0);assert.equal(f.dispatches(),0);checked('auth-before-account-or-dispatch');
  const ws=await b.handle(request({headers:{upgrade:'websocket'}}));assert.equal(ws.status,426);checked('unguarded-websocket-refused');
}
for(const [name,quota] of [['five-hour-threshold',{shortPercent:97,weeklyPercent:20}],['weekly-threshold',{shortPercent:2,weeklyPercent:97}],['monthly-threshold',{shortPercent:2,monthlyPercent:97}],['missing-short',{weeklyPercent:2}],['missing-long',{shortPercent:2}],['invalid-percent',{shortPercent:NaN,weeklyPercent:2}]] as const) {
  const f=fixture();f.quota(quota);const b=createExternalOcxHttpBoundary(f.deps);
  const r=await b.handle(request());assert.equal(r.ok,false);assert.equal(f.dispatches(),0);assert.equal(b.activeTurns(),0);checked(name+'-no-inference');
}
{
  const f=fixture();f.generation(2);const b=createExternalOcxHttpBoundary(f.deps);
  assert.equal((await b.handle(request())).ok,false);assert.equal(f.dispatches(),0);checked('stale-generation-no-inference');
}
{
  const f=fixture(),b=createExternalOcxHttpBoundary(f.deps);
  const r=await b.handle(request({headers:{cookie:'fixture-cookie','x-api-key':'fixture-key','proxy-authorization':'fixture-proxy'}}));
  assert.equal(b.activeTurns(),1);assert.equal(f.dispatches(),1);assert.equal(await r.text(),'fixture-ok');assert.equal(b.activeTurns(),0);
  const seen=f.seen()!;assert.equal(seen.headers.get('authorization'),'Bearer fixture-access');
  assert.equal(seen.headers.get('chatgpt-account-id'),'fixture-account');
  for(const name of ['cookie','x-api-key','proxy-authorization']) assert.equal(seen.headers.has(name),false);
  checked('data-token-replaced-and-other-credentials-removed');checked('lifetime-includes-body-consumption');
}
{
  const f=fixture();f.transport(async()=>{throw Error('raw-secret-diagnostic');});
  const b=createExternalOcxHttpBoundary(f.deps),r=await b.handle(request());
  assert.equal(r.ok,false);assert.equal(f.dispatches(),1);assert.equal((await r.text()).includes('raw-secret'),false);
  assert.equal(r.headers.get('x-should-retry'),'false');assert.equal(b.activeTurns(),0);checked('physical-send-never-replayed-and-error-sanitized');
}
{
  const f=fixture();let cancelled=false;
  f.transport(async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}})));
  const b=createExternalOcxHttpBoundary(f.deps),r=await b.handle(request());
  assert.equal(b.activeTurns(),1);await r.body!.cancel('fixture-client-cancel');assert.equal(cancelled,true);
  assert.equal(b.activeTurns(),0);assert.equal(f.dispatches(),1);checked('body-cancel-releases-and-aborts-single-dispatch');
  assert.equal(b.drain(),true);assert.equal((await b.handle(request())).status,503);assert.equal(f.dispatches(),1);checked('drain-prevents-new-dispatch');
}
for(const action of ['switch','stop'] as const) {
  let now=1000,quota:any={shortPercent:20,weeklyPercent:20},verified=true,live=true;
  const timers=new Set<()=>void>(),cuts:string[]=[];
  const m=createAiccInflightMonitor({enabled:()=>true,now:()=>now,
    settings:()=>({fiveHour:{usedThreshold:97,action},longWindow:{usedThreshold:97,action}}),snapshot:()=>quota,
    generationLive:()=>live,refresh:async()=>({quota,generation:1,verified}),noteObservation:()=>{},
    schedule:fn=>{timers.add(fn);return()=>{timers.delete(fn);};}});
  const a=m.subscribe('pool',1,r=>cuts.push(r)),b=m.subscribe('pool',1,r=>cuts.push(r));
  for(let i=0;i<8;i++) await Promise.resolve();assert.equal(timers.size,1);
  quota={shortPercent:20,weeklyPercent:97};now+=1000;for(const tick of [...timers])tick();
  assert.deepEqual(cuts,['long_window_threshold','long_window_threshold']);assert.equal(timers.size,0);a();b();
  checked('inflight-97-'+action+'-cuts-all-serving-requests');
}
{
  let now=1000;const cuts:string[]=[],timers=new Set<()=>void>();
  const m=createAiccInflightMonitor({enabled:()=>true,now:()=>now,settings:()=>rules,snapshot:()=>({shortPercent:1,weeklyPercent:1}),generationLive:()=>true,
    refresh:async()=>({quota:{shortPercent:1,weeklyPercent:1},generation:1,verified:false}),noteObservation:()=>{},schedule:fn=>{timers.add(fn);return()=>timers.delete(fn);}});
  m.subscribe('pool',1,r=>cuts.push(r));for(let i=0;i<8;i++)await Promise.resolve();now+=15_000;for(const tick of [...timers])tick();
  assert.deepEqual(cuts,['quota_unverified']);assert.equal(timers.size,0);checked('failed-refresh-cache-cannot-renew-inflight-budget');
}
{
  // G1-01: admission refuses at 97%, but an already dispatched response drains.
  const f=fixture();const settled:string[]=[];(f.deps as any).noteSettlement=(_r:Request,o:string)=>settled.push(o);
  let push!:(text:string)=>void;
  f.transport(async()=>new Response(new ReadableStream({start(c){const e=new TextEncoder();push=t=>c.enqueue(e.encode(t));}}),
    {headers:{'content-type':'text/event-stream'}}));
  const b=createExternalOcxHttpBoundary(f.deps),r=await b.handle(request()),reader=r.body!.getReader();
  push('data: {"type":"response.created"}\n\n');await reader.read();
  f.quota({shortPercent:10,weeklyPercent:97});await new Promise(done=>setTimeout(done,1_200));
  push('data: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\n\n');
  let text='';for(;;){const row=await reader.read();if(row.done)break;text+=new TextDecoder().decode(row.value);}
  assert.match(text,/response\.completed/);assert.doesNotMatch(text,/aicc_window_inflight_cutoff/);
  assert.deepEqual(settled,['completed']);assert.equal(b.activeTurns(),0);assert.equal(f.dispatches(),1);
  checked('inflight-97-drains-admitted-response-to-completed-settlement');
}
for(const [name,make,expected] of [
  ['upstream-4xx-settles-rejected',()=>Response.json({error:{code:'usage_limit_reached'}},{status:429}),'rejected'],
  ['upstream-5xx-stays-unknown',()=>Response.json({error:{code:'fixture'}},{status:502}),'unknown'],
  ['sse-response-failed-settles-failed',()=>new Response('data: '+JSON.stringify({type:'response.failed',response:{status:'failed'}})+'\n\n',
    {headers:{'content-type':'text/event-stream'}}),'failed'],
] as const) {
  const f=fixture();const settled:string[]=[];(f.deps as any).noteSettlement=(_r:Request,o:string)=>settled.push(o);
  f.transport(async()=>make());const b=createExternalOcxHttpBoundary(f.deps),r=await b.handle(request());await r.text();
  assert.deepEqual(settled,[expected]);assert.equal(f.dispatches(),1);checked(name);
}
for(const [name,deliverFirst,expected] of [['client-cancel-before-any-byte-settles-abandoned',false,'abandoned'],
  ['client-cancel-after-delivered-bytes-stays-unknown',true,'unknown']] as const) {
  // G1-23 fixtures (written 2026-10-31, not run).
  const f=fixture();const settled:string[]=[];(f.deps as any).noteSettlement=(_r:Request,o:string)=>settled.push(o);
  let push!:(text:string)=>void;
  f.transport(async()=>new Response(new ReadableStream({start(c){const e=new TextEncoder();push=t=>c.enqueue(e.encode(t));}}),
    {headers:{'content-type':'text/event-stream'}}));
  const b=createExternalOcxHttpBoundary(f.deps),r=await b.handle(request()),reader=r.body!.getReader();
  if(deliverFirst){push('data: {"type":"response.created"}\n\n');await reader.read();}
  await reader.cancel('fixture-client-cancel');
  assert.deepEqual(settled,[expected]);assert.equal(f.dispatches(),1);checked(name);
}
console.log(JSON.stringify({status:'PASS',scope:'isolated-external-credential-http-inflight',inference:'fixture-only',checks}));
