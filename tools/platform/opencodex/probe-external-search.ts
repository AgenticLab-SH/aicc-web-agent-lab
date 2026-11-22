// Explicitly requested search-path check. Isolated homes, fixture credentials,
// and a deny-by-default fake transport: no service or network operation.
import assert from 'node:assert/strict';
import {readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {bindOfficialOcxDispatch} from './external-stock-dispatch';
import {createExternalOcxHttpBoundary} from './external-http-boundary';
const root=process.env.AICC_OCX_SUPPLIER_ROOT,fixtureHome=process.env.AICC_SEARCH_FIXTURE_HOME;
if(!root || !fixtureHome || !process.env.OPENCODEX_HOME || !process.env.CODEX_HOME
  || realpathSync(process.env.OPENCODEX_HOME)!==realpathSync(fixtureHome)
  || realpathSync(process.env.CODEX_HOME)!==realpathSync(join(fixtureHome,'codex'))) throw Error('isolated-search-fixture-required');
const token='fixture.'+Buffer.from(JSON.stringify({chatgpt_account_id:'fixture-account'})).toString('base64url')+'.signature';
const checks:string[]=[],sends:{url:string;body:any}[]=[];
let upstreamStatus=200;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input:any,init:any)=>{
  assert.equal(String(input),'https://chatgpt.com/backend-api/codex/alpha/search');
  assert.equal(init.method,'POST');assert.equal(init.redirect,'manual');
  const headers=new Headers(init.headers);
  assert.equal(headers.get('authorization'),'Bearer '+token);
  assert.equal(headers.get('chatgpt-account-id'),'fixture-account');
  for(const key of ['cookie','proxy-authorization','x-api-key'])assert.equal(headers.has(key),false);
  const body=JSON.parse(init.body);sends.push({url:String(input),body});
  return Response.json(upstreamStatus===200?{fixture_search_result:true}:{error:{code:'fixture_failure'}},{status:upstreamStatus});
};
try {
  const stock=await bindOfficialOcxDispatch(root,(process.env.AICC_OCX_SUPPLIER_VERSION ?? '2.81.0'));
  const provider={adapter:'openai-responses',authMode:'forward',baseUrl:'https://chatgpt.com/backend-api/codex',codexAccountMode:'pool'};
  let quota={shortPercent:10,weeklyPercent:20},generation=1,selected=0,issuerWrites=0,dispatches=0;
  const boundary=createExternalOcxHttpBoundary({dataToken:()=> 'fixture-local-token',
    settings:()=>({fiveHour:{usedThreshold:97,action:'switch'},longWindow:{usedThreshold:97,action:'switch'}}),
    select:async()=>{selected++;return {accountId:'fixture-pool',accessToken:token,chatgptAccountId:'fixture-account',
      generation:1,quota,quotaObservedAt:Date.now(),supplierContext:provider};},
    generationLive:(_id,g)=>g===generation,quota:()=>quota,refresh:async()=>({quota,generation,verified:true}),
    noteDispatch:()=>{issuerWrites++;},catalog:async()=>Response.json({}),
    dispatch:async(request,lease)=>{dispatches++;return stock.dispatchFull(request,lease);}});
  const payload={model:'gpt-6.1-sol',queries:[{query:'fixture-only'}],response_length:'short'};
  const request=(path='/v1/alpha/search',auth='Bearer fixture-local-token',method='POST')=>new Request('http://127.0.0.1:10100'+path,
    {method,headers:{authorization:auth,'content-type':'application/json',cookie:'fixture-cookie','x-api-key':'fixture-key'},
      ...(method==='POST'?{body:JSON.stringify(payload)}:{})});
  assert.equal((await boundary.handle(request(undefined,'Bearer wrong'))).status,401);
  assert.equal(selected,0);assert.equal(sends.length,0);checks.push('search-auth-before-selection');
  for(const path of ['/v1/alpha/search','/alpha/search']) {
    const result=await boundary.handle(request(path));
    assert.equal(result.status,200);assert.deepEqual(await result.json(),{fixture_search_result:true});
    assert.deepEqual(sends.at(-1)!.body,payload);assert.equal(boundary.activeTurns(),0);
  }
  assert.equal(issuerWrites,0);assert.equal(dispatches,2);checks.push('both-exact-search-routes-use-official-handler');
  checks.push('admitted-request-auth-body-preserved-without-conversation-binding');
  for(const [kind,value] of [['quota',{shortPercent:97,weeklyPercent:20}],['generation',{shortPercent:10,weeklyPercent:20}]] as const) {
    const before=sends.length;quota={...value};if(kind==='generation')generation=2;
    const result=await boundary.handle(request());assert.equal(result.ok,false);
    await result.text();assert.equal(sends.length,before);checks.push('search-'+kind+'-refused-before-send');
  }
  quota={shortPercent:10,weeklyPercent:20};generation=1;
  for(const req of [request('/v1/alpha/not-search'),request('/v1/alpha/search',undefined,'GET')]) {
    const before=sends.length,result=await boundary.handle(req);
    assert.equal(result.status,404);assert.equal((await result.json() as any).error.type,'unsupported_route_error');
    assert.equal(sends.length,before);
  }
  checks.push('unlisted-route-and-wrong-method-are-not-auth-refusals');
  for(const status of [401,403,429,503,302]) {
    upstreamStatus=status;const before=sends.length,result=await boundary.handle(request());
    assert.equal(result.status,status);await result.text();assert.equal(sends.length,before+1);
    assert.equal(result.headers.get('x-should-retry'),'false');
  }
  checks.push('upstream-denials-and-redirect-never-replayed-or-followed');
  const before=sends.length;
  await assert.rejects(stock.dispatchFull(new Request('http://127.0.0.1:10100/v1/alpha/search',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}),
    {supplierContext:{...provider,baseUrl:'https://invalid.example'}}));
  assert.equal(sends.length,before);checks.push('noncanonical-provider-rejected');
  assert.equal(boundary.drain(),true);assert.equal((await boundary.handle(request())).status,503);
  assert.equal(sends.length,before);checks.push('search-drain-stops-new-admission');
  const sourceSha256=Object.fromEntries(['external-stock-dispatch.ts','external-http-boundary.ts','external-runtime.ts','probe-external-search.ts']
    .map(name=>[name,createHash('sha256').update(readFileSync(join(import.meta.dir,name))).digest('hex')]));
  console.log(JSON.stringify({status:'PASS',scope:'isolated-official-alpha-search',network:'fixture-only',
    supplierVersion:(process.env.AICC_OCX_SUPPLIER_VERSION ?? '2.81.0'),sourceSha256,checks,liveSearchVerified:false,registeredRuntimeChanged:false,observedAt:new Date().toISOString()}));
} finally {globalThis.fetch=originalFetch;}
