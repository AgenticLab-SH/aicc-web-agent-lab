// Owner-requested regression acceptance. No network, service or real credential.
import assert from 'node:assert/strict';
import {zstdCompressSync} from 'node:zlib';
import {readExternalRequestJson,ExternalRequestBodyError} from './external-request-body';
import {externalTokenMatches} from './external-auth';
import {createExternalOcxHttpBoundary} from './external-http-boundary';
const checks:string[]=[];
const body={model:'fixture-model',input:'한국어와 tool 결과'};
function request(bytes:any=JSON.stringify(body),encoding?:string,signal?:AbortSignal) {
  return new Request('http://localhost:10100/v1/responses',{method:'POST',
    headers:{authorization:'Bearer fixture-data','content-type':'application/json',...(encoding?{'content-encoding':encoding}:{})},body:bytes,signal});
}
for(const encoding of ['identity','zstd']) {
  assert.deepEqual(await readExternalRequestJson(request(encoding==='zstd'?zstdCompressSync(JSON.stringify(body)):JSON.stringify(body),encoding)),body);
  checks.push(encoding+'-utf8-json');
}
for(const [bytes,encoding,status] of [[Buffer.from('invalid'),'zstd',400],['{}','gzip',415],['[]','identity',400],
  [Buffer.from([255]),'identity',400],[zstdCompressSync(JSON.stringify({input:'x'.repeat(8192)})),'zstd',413],['x'.repeat(8192),'identity',413]] as const) {
  await assert.rejects(readExternalRequestJson(request(bytes,encoding),1024),(error:any)=>error instanceof ExternalRequestBodyError && error.status===status);
  checks.push('refuses-'+encoding+'-'+status);
}
const cancelled=new AbortController();cancelled.abort();
await assert.rejects(readExternalRequestJson(request('{}','identity',cancelled.signal)));
checks.push('aborted-request-refused');
const auth=(headers:Record<string,string>)=>new Request('http://localhost:10100/api/system/memory',{headers});
assert.ok(externalTokenMatches(auth({authorization:'Bearer fixture-admin'}),'fixture-admin',true));
assert.ok(externalTokenMatches(auth({'x-opencodex-api-key':'fixture-admin'}),'fixture-admin',true));
assert.equal(externalTokenMatches(auth({'x-opencodex-api-key':'fixture-admin'}),'fixture-admin'),false);
assert.equal(externalTokenMatches(auth({authorization:'Bearer wrong','x-opencodex-api-key':'fixture-admin'}),'fixture-admin',true),false);
assert.equal(externalTokenMatches(auth({}),'fixture-admin',true),false);
checks.push('legacy-admin-header-only-on-management-and-invalid-bearer-refused');
let sends=0,decoded:any;
const rules={fiveHour:{usedThreshold:97,action:'switch' as const},longWindow:{usedThreshold:97,action:'switch' as const}};
const boundary=createExternalOcxHttpBoundary({dataToken:()=> 'fixture-data',settings:()=>rules,
  select:async req=>{decoded=await readExternalRequestJson(req.clone());return {accountId:'pool',chatgptAccountId:'fixture-account',accessToken:'fixture-access',generation:1,quota:{shortPercent:1,weeklyPercent:1},quotaObservedAt:Date.now()};},
  preparedBody:()=>decoded,generationLive:()=>true,quota:()=>({shortPercent:1,weeklyPercent:1}),
  refresh:async()=>({quota:{shortPercent:1,weeklyPercent:1},generation:1,verified:true}),catalog:async()=>Response.json({}),
  dispatch:async req=>{sends++;assert.equal(req.headers.has('content-encoding'),false);assert.deepEqual(await req.json(),body);return new Response('fixture-ok');}});
const response=await boundary.handle(request(zstdCompressSync(JSON.stringify(body)),'zstd'));
assert.equal(await response.text(),'fixture-ok');assert.equal(sends,1);assert.equal(boundary.activeTurns(),0);
assert.equal((await boundary.handle(request('bad','zstd'))).status,400);assert.equal(sends,1);assert.equal(boundary.activeTurns(),0);
checks.push('compressed-boundary-decodes-before-selection-and-dispatches-plain-json-once');
console.log(JSON.stringify({status:'PASS',scope:'external-wire-regression',network:'none',checks}));
