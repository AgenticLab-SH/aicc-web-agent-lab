// Requested OCX 503 regression scope. Supplier code is real; all account,
// quota and roster reads use fixtures. No inference or real network is allowed.
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {mkdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {bindOfficialOcxDispatch} from './external-stock-dispatch';
import {createExternalPoolState} from './external-pool-state';
const supplierRoot=process.env.AICC_OCX_SUPPLIER_ROOT;
const fixtureRoot=process.env.AICC_CONTROL_PLANE_FIXTURE_ROOT;
if(!supplierRoot || !fixtureRoot || !process.env.OPENCODEX_HOME || !process.env.CODEX_HOME
  || resolve(process.env.OPENCODEX_HOME)!==resolve(fixtureRoot)
  || resolve(process.env.CODEX_HOME)!==resolve(fixtureRoot,'codex')) throw Error('isolated-control-plane-fixture-required');
const checks:string[]=[];
const stock=await bindOfficialOcxDispatch(supplierRoot,(process.env.AICC_OCX_SUPPLIER_VERSION ?? '2.81.0'));
const nativeRows=[{slug:'gpt-6.1-sol',visibility:'list',supported_in_api:true}];
const original=structuredClone(nativeRows);
const review=stock.controlPlaneModel(nativeRows,'codex-auto-review');
assert.equal(review?.slug,'codex-auto-review');
assert.equal(review?.visibility,'hide');assert.equal(review?.supported_in_api,true);
assert.deepEqual(nativeRows,original);checks.push('official-hidden-review-projection-preserves-source-roster');
assert.equal(stock.controlPlaneModel([],'codex-auto-review'),undefined);
assert.equal(stock.controlPlaneModel([{slug:'account/gpt-6.1-sol'}],'codex-auto-review'),undefined);
checks.push('no-native-support-or-only-account-alias-cannot-authorize-review');
assert.equal(stock.controlPlaneModel(nativeRows,'unregistered-review-model'),undefined);
checks.push('no-general-model-or-review-alias-exemption');
let quota:any={a:{shortPercent:97,weeklyPercent:20},b:{shortPercent:20,weeklyPercent:20}};
let roster:any={a:nativeRows,b:nativeRows};
globalThis.fetch=async(input:any,init:any)=>{
  const url=String(input),id=new Headers(init?.headers).get('chatgpt-account-id')!;
  assert.ok(id==='a'||id==='b');
  if(url==='https://chatgpt.com/backend-api/wham/usage')return Response.json(quota[id]);
  if(url==='https://chatgpt.com/backend-api/codex/models?client_version=0.163.0')return Response.json({models:roster[id]});
  throw Error('inference-and-real-network-forbidden');
};
const config:any={defaultProvider:'openai',codexAccounts:[{id:'a',isMain:false},{id:'b',isMain:false}],
  pausedCodexAccountIds:[],codexAccountPriorities:{},codexAccountPriorityFailback:false,
  accountPoolStrategy:'reset-first',codexAccountNamespaces:{},providers:{openai:{adapter:'openai-responses',
  baseUrl:'https://chatgpt.com/backend-api/codex',authMode:'forward',codexAccountMode:'pool'}}};
function pool(name:string){const home=join(fixtureRoot,name);mkdirSync(home,{recursive:true});
  return createExternalPoolState({home,clientVersion:'0.163.0',supplier:{...stock,readBody:r=>r.json(),parseQuota:v=>v},
    transport:{request:async(data:any)=>data.action==='snapshot'?{ok:true,config,records:{a:{generation:1},b:{generation:1}},
      settings:{schemaVersion:1,fiveHour:{usedThreshold:97,action:'switch'},longWindow:{usedThreshold:97,action:'switch'}}}
      :{ok:true,accessToken:'fixture-'+data.id,chatgptAccountId:data.id,generation:1,expiresAt:Date.now()+120_000}}});}
const request=(extra:any={})=>new Request('http://127.0.0.1:10101/v1/responses',{method:'POST',
  headers:{'content-type':'application/json','thread-id':'new-independent-fixture'},body:JSON.stringify({
  model:'codex-auto-review',instructions:'Fixture review instructions must stay unchanged.',input:'fixture',reasoning:{effort:'high'},...extra})});
{
  const p=pool('safe-alternative'),r=request();
  const lease=await p.select(r,new AbortController().signal);assert.equal(lease.accountId,'b');
  const body:any=p.preparedBody(r);assert.equal(body.model,'codex-auto-review');assert.equal(body.reasoning.effort,'high');
  assert.equal(body.instructions,'Fixture review instructions must stay unchanged.');
  checks.push('review-uses-fresh-eligible-account-with-97-percent-protection');
  checks.push('review-model-instructions-and-effort-are-not-substituted');
}
{
  quota={a:{shortPercent:97,weeklyPercent:20},b:{shortPercent:97,weeklyPercent:20}};
  await assert.rejects(pool('all-protected').select(request(),new AbortController().signal),/window_threshold/);
  checks.push('all-protected-accounts-still-refused');
}
{
  quota={a:{shortPercent:10,weeklyPercent:20},b:{shortPercent:20,weeklyPercent:20}};roster={a:[],b:[]};
  await assert.rejects(pool('no-native-roster').select(request(),new AbortController().signal),/model_not_supported_by_account/);
  checks.push('missing-physical-native-support-still-refused');
}
{
  roster={a:nativeRows,b:nativeRows};
  await assert.rejects(pool('foreign-scope').select(request({previous_response_id:'unowned-fixture-response'}),
    new AbortController().signal),/account_scoped_input_owner_unknown/);
  checks.push('unknown-prior-response-account-boundary-preserved');
}
const sourceSha256=Object.fromEntries(['external-stock-dispatch.ts','external-pool-state.ts','external-account-picker.ts',
  'external-credential-owner.ts','external-request-body.ts','window-inflight-monitor.ts','probe-external-control-plane.ts']
  .map(name=>[name,createHash('sha256').update(readFileSync(join(import.meta.dir,name))).digest('hex')]));
console.log(JSON.stringify({status:'PASS',scope:'official-hidden-control-plane-and-account-admission',
  network:'fixture-only-no-inference',supplierVersion:(process.env.AICC_OCX_SUPPLIER_VERSION ?? '2.81.0'),sourceSha256,runtimeChanged:false,checks,
  observedAt:new Date().toISOString()}));
