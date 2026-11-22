// Dedicated fake-runner regression probe. Never opens a listener or sends live
// quota/inference; every fetch is replaced before any production function runs.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createExternalPoolState} from './external-pool-state';
import {createOriginalOcxQuotaReceiptStore} from './external-original-quota-receipt';
import {createOriginalIssuerAdmission,parseOriginalIssuerGrant,type OriginalIssuerGrant} from './external-original-issuer-admission';
import {createExternalOcxHttpBoundary} from './external-http-boundary';
import {bindOfficialOcxDispatch} from './external-stock-dispatch';

const root=process.env.AICC_ISSUER_ADMISSION_FIXTURE_ROOT;
if(!root)throw Error('dedicated_fixture_root_required');
const checks:string[]=[];
const check=async(name:string,fn:()=>void|Promise<void>)=>{await fn();checks.push(name);};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const body={model:'fixture-model',input:[{role:'user',content:'continue the original goal with new work'}]};
const fingerprint=hash(JSON.stringify(body));
const signal=()=>new AbortController().signal;
function grant():OriginalIssuerGrant {
  return {runtimeId:randomUUID(),epoch:1,goalId:randomUUID(),threadId:randomUUID(),
    originalTurnId:randomUUID(),originalRequestId:randomUUID(),ownerRequestId:randomUUID(),
    refusalSha256:'a'.repeat(64),attestationSha256:'b'.repeat(64),nextTurnId:randomUUID(),
    nextRequestId:randomUUID(),continuationFingerprint:fingerprint,nativeProof:'n'.repeat(43)};
}
function continuation(g:OriginalIssuerGrant,token:string,extra:Record<string,string>={},content:any=body) {
  return new Request('http://127.0.0.1:10101/v1/responses',{method:'POST',headers:{
    authorization:'Bearer fixture-data','content-type':'application/json',
    'x-aicc-original-issuer-reservation':token,'x-aicc-native-runtime-id':g.runtimeId,
    'x-aicc-native-epoch':String(g.epoch),'x-aicc-native-goal-id':g.goalId,
    'x-aicc-native-proof':g.nativeProof,'thread-id':g.threadId,
    'x-codex-turn-id':g.nextTurnId,'x-request-id':g.nextRequestId,...extra,
  },body:JSON.stringify(content)});
}
function authority() {
  let live=true,closed=0;
  return {revoke:()=>{live=false;},closed:()=>closed,provider:{acquire:async()=>({
    isCurrent:()=>live,runIfCurrent:(fn:()=>void)=>{if(!live)return false;fn();return true;},close:()=>{closed++;},
  })}};
}
await check('no native provider rejects without reading quota',async()=>{
  let resolved=false;const a=createOriginalIssuerAdmission({});
  await assert.rejects(a.reserve(grant(),async()=>{resolved=true;return {accountId:'a',generation:1};},signal()),/native_dispatch_fence_unavailable/);
  assert.equal(resolved,false);
});
await check('single consume and a distinct native continuation',async()=>{
  const guard=authority(),a=createOriginalIssuerAdmission({authority:guard.provider}),g=grant();
  const r=await a.reserve(g,async()=>({accountId:'a',generation:1}),signal());
  const request=continuation(g,r.reservation);assert.deepEqual(a.claim(request,fingerprint),{accountId:'a',generation:1});
  let sends=0;await a.dispatch(request,()=>{sends++;return Promise.resolve(new Response('ok'));},()=>{});
  await assert.rejects(async()=>a.dispatch(request,async()=>{sends++;return new Response();},()=>{}));
  assert.throws(()=>a.claim(continuation(g,r.reservation),fingerprint));assert.equal(sends,1);
  assert.notEqual(g.nextRequestId,g.originalRequestId);assert.notEqual(g.nextTurnId,g.originalTurnId);
});
await check('revocation and cancellation after resolve await',async()=>{
  for(const cancel of [false,true]) {
    const guard=authority(),controller=new AbortController(),a=createOriginalIssuerAdmission({authority:guard.provider});
    await assert.rejects(a.reserve(grant(),async()=>{await Promise.resolve();if(cancel)controller.abort();else guard.revoke();
      return {accountId:'a',generation:1};},controller.signal),/revoked_or_expired/);
    assert.equal(guard.closed(),1);
  }
});
await check('expiry and clock rollback never dispatch',async()=>{
  for(const delta of [15000,-1]) {
    let now=100000;const guard=authority(),a=createOriginalIssuerAdmission({authority:guard.provider,now:()=>now}),g=grant();
    const r=await a.reserve(g,async()=>({accountId:'a',generation:1}),signal());now+=delta;
    assert.throws(()=>a.claim(continuation(g,r.reservation),fingerprint),/revoked_or_expired/);
  }
});
await check('wrong thread goal epoch proof aliases and fingerprint consume capability',async()=>{
  const cases:Record<string,string>[]=[{'thread-id':randomUUID()},{'x-aicc-native-goal-id':randomUUID()},
    {'x-aicc-native-epoch':'2'},{'x-aicc-native-proof':'x'.repeat(43)},{'session_id':randomUUID()},
    {'turn-id':randomUUID()},{'x-client-request-id':randomUUID()}];
  for(const changes of cases) {
    const a=createOriginalIssuerAdmission({authority:authority().provider}),g=grant();
    const r=await a.reserve(g,async()=>({accountId:'a',generation:1}),signal());
    assert.throws(()=>a.claim(continuation(g,r.reservation,changes),fingerprint),/identity_mismatch/);
    assert.throws(()=>a.claim(continuation(g,r.reservation),fingerprint));
  }
  const a=createOriginalIssuerAdmission({authority:authority().provider}),g=grant();
  const r=await a.reserve(g,async()=>({accountId:'a',generation:1}),signal());
  assert.throws(()=>a.claim(continuation(g,r.reservation),'c'.repeat(64)),/identity_mismatch/);
});
await check('concurrent reservation allows only one and unknown never retries',async()=>{
  const a=createOriginalIssuerAdmission({authority:authority().provider}),g=grant();
  const r=await Promise.allSettled([a.reserve(g,async()=>({accountId:'a',generation:1}),signal()),
    a.reserve(g,async()=>({accountId:'a',generation:1}),signal())]);
  assert.equal(r.filter(v=>v.status==='fulfilled').length,1);
  await assert.rejects(a.reserve({...g,goalId:randomUUID(),ownerRequestId:randomUUID()},
    async()=>({accountId:'a',generation:1}),signal()),/already_reserved/);
  const reserved=(r.find(v=>v.status==='fulfilled') as PromiseFulfilledResult<any>).value;
  const request=continuation(g,reserved.reservation);a.claim(request,fingerprint);
  await assert.rejects(a.dispatch(request,async()=>{throw Error('delivery unknown');},()=>{}));
  a.settle(request);await assert.rejects(a.reserve(g,async()=>({accountId:'a',generation:1}),signal()),/already_reserved/);
});
await check('original turn and account injection are rejected',()=>{
  const g=grant();assert.throws(()=>parseOriginalIssuerGrant({...g,nextRequestId:g.originalRequestId}));
  assert.throws(()=>parseOriginalIssuerGrant({...g,nextTurnId:g.originalTurnId}));
  assert.throws(()=>parseOriginalIssuerGrant({...g,accountId:'b'}));
});

type Fixture=ReturnType<typeof fixture>;
let active:Fixture|undefined;
globalThis.fetch=Object.assign(async(input:any,init:any)=>{
  const f=active!;assert.ok(f,'fixture required');
  const url=String(input),id=new Headers(init?.headers).get('chatgpt-account-id');
  if(url.includes('/wham/usage')) {
    f.quotaCalls.push(id!);await f.onUsage?.();
    return Response.json({quota:{shortPercent:f.short,weeklyPercent:f.long},rate_limit:{allowed:true,
      primary_window:{limit_window_seconds:18000,used_percent:f.short,reset_at:Math.floor(Date.now()/1000)+18000}}});
  }
  if(url.includes('/codex/models?')){await f.onRoster?.();return Response.json({models:f.entitled?[{slug:'fixture-model'}]:[]});}
  throw Error('live_network_and_inference_forbidden');
},{preconnect:()=>{}});
let serial=0;
function fixture(options:{resetFuture?:boolean;backendProven?:boolean;pending?:boolean;replay?:boolean;legacy?:boolean}={}) {
  const home=join(root!,'case-'+(++serial));mkdirSync(home,{recursive:true});
  const g=grant(),ms=Date.now()-120000;
  const originalRequest=new Request('http://127.0.0.1:10101/v1/responses',{method:'POST',headers:{
    'x-request-id':g.originalRequestId,'thread-id':g.threadId,'x-codex-turn-id':g.originalTurnId,
  },body:'{}'});
  const receipts=createOriginalOcxQuotaReceiptStore({home,now:()=>ms});
  const policy={fiveHour:{usedThreshold:97,action:'stop' as const},longWindow:{usedThreshold:98,action:'stop' as const}};
  assert.ok(receipts.observeSelected(originalRequest,{accountId:'a',generation:1,quota:{shortPercent:100,weeklyPercent:10},
    window:{window:'primary',windowDurationMins:300,usedPercent:100,
      resetsAt:Math.floor((Date.now()+(options.resetFuture?60000:-60000))/1000),
      backendUsageAllowed:options.backendProven===false?true:false},quotaObservedAt:ms,policy,
      requestFingerprint:options.legacy?undefined:options.replay?fingerprint:hash('original failed semantic work')}));
  const refusal=receipts.recordRefusal(originalRequest,'window_stop_policy')!;
  const bind=receipts.attest({ownerRequestId:refusal.ownerRequestId,refusalSha256:refusal.receiptSha256,
    requestId:g.originalRequestId,threadId:g.threadId,turnId:g.originalTurnId});
  Object.assign(g,{ownerRequestId:refusal.ownerRequestId,refusalSha256:refusal.receiptSha256,attestationSha256:bind.receiptSha256});
  const config:any={codexAccounts:[{id:'a',isMain:false},{id:'b',isMain:false}],pausedCodexAccountIds:[],
    accountPoolStrategy:'quota',activeCodexAccountPinned:'a',providers:{}};
  const guard=authority();
  const f={home,g,config,guard,generation:1,short:10,long:10,entitled:true,quotaCalls:[] as string[],
    onUsage:undefined as undefined|(()=>Promise<void>),onRoster:undefined as undefined|(()=>Promise<void>),
    onSnapshot:undefined as undefined|(()=>void),pool:null as any};
  if(options.pending)writeFileSync(join(home,'external-request-lifecycle.json'),JSON.stringify({schemaVersion:1,rows:[{
    key:hash(g.threadId).slice(0,32),operationId:randomUUID(),accountId:'a',at:ms,state:'unknown',requestFingerprint:'f'.repeat(64),
  }]}));
  f.pool=createExternalPoolState({home,clientVersion:'0.162.0-alpha.2',originalIssuerAuthority:guard.provider,
    transport:{request:async(data:any)=>{
      if(data.action==='snapshot'){f.onSnapshot?.();return {ok:true,config:structuredClone(config),records:{a:{generation:f.generation},b:{generation:1}},
        settings:{schemaVersion:1,...policy}};}
      assert.equal(data.action,'lease');return {ok:true,accessToken:'fixture-token',chatgptAccountId:data.id,
        generation:f.generation,expiresAt:Date.now()+120000};
    }},supplier:{readBody:r=>r.json(),parseQuota:b=>b.quota,collectCarriers:()=>({}),
      resolveRoute:(_c,model)=>({modelId:model,provider:{adapter:'openai-responses',authMode:'forward',baseUrl:'https://chatgpt.com/backend-api/codex'}})}});
  active=f;return f;
}
async function reserved(f:Fixture) {return f.pool.reserveOriginalIssuer(f.g,signal());}
await check('real pool resolves refusal account despite other lower quota; ordinary new work unchanged',async()=>{
  const f=fixture(),r=await reserved(f),request=continuation(f.g,r.reservation);
  const lease=await f.pool.select(request,signal());assert.equal(lease.accountId,'a');assert.equal(lease.generation,1);
  assert.ok(f.quotaCalls.every(id=>id==='a'));f.pool.beforeDispatch(request);
  let sends=0;await lease.originalIssuerDispatch(async()=>{sends++;return new Response('ok');});assert.equal(sends,1);
  f.pool.noteSettlement(request,'completed');
  await assert.rejects(f.pool.select(continuation(f.g,r.reservation),signal()));
  const normal=new Request('http://127.0.0.1:10101/v1/responses',{method:'POST',headers:{'content-type':'application/json','thread-id':randomUUID()},body:JSON.stringify(body)});
  assert.ok(await f.pool.select(normal,signal()));f.pool.noteSettlement(normal,'not_sent');
});
await check('reset not yet and policy threshold only never issue admission',async()=>{
  for(const options of [{resetFuture:true},{backendProven:false}]){const f=fixture(options);await assert.rejects(reserved(f));assert.equal(f.quotaCalls.length,0);}
});
await check('new request IDs cannot replay original semantic work or upgrade legacy receipt',async()=>{
  for(const options of [{replay:true},{legacy:true}]) {
    const f=fixture(options);await assert.rejects(reserved(f),/original_chain_unverified/);assert.equal(f.quotaCalls.length,0);
  }
});
await check('paused pinned-away and short or long threshold reject without fallback',async()=>{
  for(const condition of ['paused','pin','short','long']) {
    const f=fixture();if(condition==='paused')f.config.pausedCodexAccountIds=['a'];
    if(condition==='pin')f.config.activeCodexAccountPinned='b';if(condition==='short')f.short=97;if(condition==='long')f.long=98;
    await assert.rejects(reserved(f));assert.ok(f.quotaCalls.every(id=>id==='a'));
  }
});
await check('generation replacement during quota await rejects exact issuer',async()=>{
  const f=fixture();f.onUsage=async()=>{f.generation=2;};await assert.rejects(reserved(f));
});
await check('revocation during entitlement await and missing entitlement reject before pending reserve',async()=>{
  for(const revoke of [true,false]) {
    const f=fixture(),r=await reserved(f);if(revoke)f.onRoster=async()=>f.guard.revoke();else f.entitled=false;
    const request=continuation(f.g,r.reservation);await assert.rejects(f.pool.select(request,signal()));
    f.pool.noteSettlement(request,'not_sent');assert.equal(f.pool.inflightFenceTurns(),0);
  }
});
await check('generation pause route replacement or revoke after selection blocks physical dispatch',async()=>{
  for(const condition of ['generation','pause','route','revoke']) {
    const f=fixture(),r=await reserved(f),request=continuation(f.g,r.reservation),lease=await f.pool.select(request,signal());
    f.pool.beforeDispatch(request);
    if(condition==='generation')f.generation=2;if(condition==='pause')f.config.pausedCodexAccountIds=['a'];
    if(condition==='route')f.config.providers={changed:true};if(condition==='revoke')f.guard.revoke();
    let sent=false;await assert.rejects(lease.originalIssuerDispatch(async()=>{sent=true;return new Response();}));
    assert.equal(sent,false);f.pool.noteSettlement(request,'not_sent');assert.equal(f.pool.inflightFenceTurns(),0);
  }
});
await check('UNKNOWN archive and existing dispatch fence stay protected',async()=>{
  const f=fixture({pending:true}),before=f.pool.unknownTurns(),r=await reserved(f),request=continuation(f.g,r.reservation);
  assert.equal(f.pool.unknownTurns(),before);assert.equal(f.pool.inflightFenceTurns(),0);
  const lease=await f.pool.select(request,signal());assert.equal(f.pool.unknownTurns(),before);
  const pendingBefore=readFileSync(join(f.home,'external-request-lifecycle.json'));
  const other={...f.g,epoch:2,nextTurnId:randomUUID(),nextRequestId:randomUUID()};
  const r2=await f.pool.reserveOriginalIssuer(other,signal());
  await assert.rejects(f.pool.select(continuation(other,r2.reservation),signal()),/conversation_request_active/);
  assert.ok(readFileSync(join(f.home,'external-request-lifecycle.json')).equals(pendingBefore));
  assert.equal(f.pool.inflightFenceTurns(),1);f.pool.beforeDispatch(request);
  await assert.rejects(lease.originalIssuerDispatch(async()=>{throw Error('UNKNOWN delivery');}));
  f.pool.noteSettlement(request,'unknown');assert.equal(f.pool.unknownTurns(),before+1);
  const r3=await f.pool.reserveOriginalIssuer({...other,epoch:3,nextTurnId:randomUUID(),nextRequestId:randomUUID()},signal());
  await assert.rejects(f.pool.select(continuation({...other,epoch:3,nextTurnId:r3.nextTurnId,nextRequestId:r3.nextRequestId},r3.reservation),signal()),/request_outcome_unknown/);
});
await check('HTTP boundary strips native capability and settles pre-send revoke',async()=>{
  for(const revoke of [false,true]) {
    const f=fixture(),r=await reserved(f);let physical=0;
    const b=createExternalOcxHttpBoundary({dataToken:()=> 'fixture-data',settings:f.pool.settings,select:f.pool.select,
      preparedBody:f.pool.preparedBody,generationLive:f.pool.generationLive,quota:f.pool.quota,refresh:f.pool.refresh,
      beforeDispatch:f.pool.beforeDispatch,noteSettlement:f.pool.noteSettlement,catalog:async()=>new Response(),
      dispatchEvidence:()=>({dispatchStarted:physical>0,source:'provider_fetch_invoked'}),
      dispatch:async(forwarded,lease)=>{
        assert.equal(forwarded.headers.get('x-aicc-native-proof'),null);
        assert.equal(forwarded.headers.get('x-aicc-original-issuer-reservation'),null);
        await Promise.resolve();if(revoke)f.guard.revoke();
        return lease!.originalIssuerDispatch!(async()=>{physical++;return Response.json({status:'completed',output:[]});});
      }});
    const response=await b.handle(continuation(f.g,r.reservation));await response.text();
    assert.equal(physical,revoke?0:1);assert.equal(f.pool.inflightFenceTurns(),0);
    if(revoke){assert.equal(response.headers.get('x-should-retry'),'false');assert.equal(f.pool.unknownTurns(),0);}
  }
});
const supplierRoot=process.env.AICC_ISSUER_ADMISSION_SUPPLIER_ROOT;
if(supplierRoot)await check('pinned supplier serializer fences at physical fetch after awaits; UNKNOWN send occurs once',async()=>{
  for(const folder of ['supplier-home','supplier-codex-home'])mkdirSync(join(root,folder),{recursive:true});
  process.env.OPENCODEX_HOME=join(root,'supplier-home');process.env.CODEX_HOME=join(root,'supplier-codex-home');
  const stock=await bindOfficialOcxDispatch(supplierRoot,'2.96.0');
  const provider={adapter:'openai-responses',authMode:'forward',baseUrl:'https://chatgpt.com/backend-api/codex'};
  for(const outcome of ['ok','revoke','unknown']) {
    const native=authority(),a=createOriginalIssuerAdmission({authority:native.provider}),g=grant();
    const reservation=await a.reserve(g,async()=>({accountId:'a',generation:1}),signal());
    const original=continuation(g,reservation.reservation);a.claim(original,fingerprint);
    let sends=0,entered=false;
    globalThis.fetch=Object.assign(async(input:any,init:any)=>{
      sends++;assert.equal(String(input),'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(new Headers(init.headers).get('chatgpt-account-id'),'fixture-account');
      if(outcome==='unknown')throw Error('lost provider response');
      return Response.json({id:'resp_fixture',object:'response',status:'completed',output:[]});
    },{preconnect:()=>{}});
    const forwarded=new Request('http://127.0.0.1:10101/v1/responses',{method:'POST',
      headers:{authorization:'Bearer fixture-token','chatgpt-account-id':'fixture-account','content-type':'application/json'},
      body:JSON.stringify(body)});
    const work=stock.dispatchFull(forwarded,{supplierContext:provider,originalIssuerDispatch:async send=>{
      entered=true;assert.equal(sends,0);if(outcome==='revoke')native.revoke();
      return a.dispatch(original,send,()=>{});
    }});
    if(outcome==='ok'){const response=await work;await response.text();}else await assert.rejects(work);
    assert.equal(entered,true);assert.equal(sends,outcome==='revoke'?0:1);
    assert.equal(stock.dispatchEvidence(forwarded).dispatchStarted,outcome==='revoke'?false:true);
  }
});
console.log(JSON.stringify({status:'PASS',checks:checks.length,names:checks,scope:'fake-only; source-only; no live account/model/listener'}));
