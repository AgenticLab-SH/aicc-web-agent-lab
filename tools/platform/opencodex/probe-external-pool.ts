// Request selection fixtures; no network, real account or inference is used.
import assert from 'node:assert/strict';
import { createExternalPoolState } from './external-pool-state';
import { join } from 'node:path';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const fixtureRoot=process.env.AICC_OCX_POOL_FIXTURE_ROOT;
if(!fixtureRoot) throw Error('fixture-root-required');
const checks:string[]=[],calls:string[]=[];
let quotas:any={a:{shortPercent:10,weeklyPercent:10},b:{shortPercent:20,weeklyPercent:20}};
let rosters:any={a:[{slug:'fixture-model'}],b:[{slug:'fixture-model'}]};
globalThis.fetch=async(input:any,init:any)=>{
  const id=new Headers(init.headers).get('chatgpt-account-id')!;
  const url=String(input);calls.push(id+':'+(url.includes('/usage')?'usage':'models'));
  if(url.includes('/wham/usage'))return Response.json(quotas[id]);
  if(url.includes('/codex/models?client_version=0.162.0-alpha.2'))return Response.json({models:rosters[id]});
  throw Error('inference-forbidden-in-pool-fixture');
};
function config(){return {defaultProvider:'openai',codexAccounts:[{id:'a',isMain:false},{id:'b',isMain:false}],pausedCodexAccountIds:[],codexAccountPriorities:{},codexAccountPriorityFailback:false,accountPoolStrategy:'reset-first',codexAccountNamespaces:{},providers:{openai:{adapter:'openai-responses',baseUrl:'https://chatgpt.com/backend-api/codex',authMode:'forward',codexAccountMode:'pool'}}};}
function pool(name:string,c:any=config(),scrub?:boolean){
  mkdirSync(join(fixtureRoot,name),{recursive:true});
  return createExternalPoolState({home:join(fixtureRoot,name),clientVersion:'0.162.0-alpha.2',supplier:{
    readBody:request=>request.json(),parseQuota:value=>value,collectCarriers:body=>({previousResponseId:body.previous_response_id,fileIds:body.fileIds}),
    resolveRoute:(config,model)=>({modelId:model.startsWith('a/')?model.slice(2):model,accountId:model.startsWith('a/')?'a':undefined,provider:config.providers.openai}),
    scrubAccountChange:scrub?async(body:any)=>{const copy=structuredClone(body);delete copy.previous_response_id;return copy;}:undefined},
    transport:{request:async(data:any)=>data.action==='snapshot'?{ok:true,config:c,records:{a:{generation:1},b:{generation:1}},settings:{schemaVersion:1,fiveHour:{usedThreshold:97,action:'switch'},longWindow:{usedThreshold:97,action:'switch'}}}:{ok:true,accessToken:'fixture-'+data.id,chatgptAccountId:data.id,generation:1,expiresAt:Date.now()+120_000}}});
}
const request=(model='fixture-model',extra:any={})=>new Request('http://127.0.0.1:10100/v1/responses',{method:'POST',headers:{'thread-id':'fixture-thread','content-type':'application/json'},body:JSON.stringify({model,input:'fixture',...extra})});
const signal=()=>new AbortController().signal;
{
  const p=pool('normal'),r=request(),lease=await p.select(r,signal());assert.equal(lease.accountId,'a');assert.equal(p.preparedBody(r).model,'fixture-model');checks.push('first-admitted-model-account-selected');
}
{
  const c:any=config();c.pausedCodexAccountIds=['a'];const p=pool('paused',c);assert.equal((await p.select(request(),signal())).accountId,'b');checks.push('paused-account-excluded');
}
{
  const c:any=config();c.activeCodexAccountPinned='b';const p=pool('pinned',c);assert.equal((await p.select(request(),signal())).accountId,'b');checks.push('manual-pin-selected');
}
{
  const c:any=config();c.codexAccountPriorities={a:-1,b:2};const p=pool('priority',c);assert.equal((await p.select(request(),signal())).accountId,'b');checks.push('manual-priority-respected');
}
{
  quotas.a={shortPercent:97,weeklyPercent:10};const p=pool('threshold');assert.equal((await p.select(request(),signal())).accountId,'b');checks.push('97-threshold-switches-before-inference');
  const bound=pool('explicit');await assert.rejects(bound.select(request('a/fixture-model'),signal()));checks.push('explicit-selector-cannot-bypass-97');quotas.a={shortPercent:10,weeklyPercent:10};
}
{
  rosters.a=[];const p=pool('entitlement');assert.equal((await p.select(request(),signal())).accountId,'b');checks.push('model-entitlement-account-specific');rosters.a=[{slug:'fixture-model'}];
}
{
  const p=pool('unknown-scope');const before=calls.length;await assert.rejects(p.select(request('fixture-model',{previous_response_id:'fixture-response'}),signal()),/account_scoped_input_owner_unknown/);assert.equal(calls.length,before);checks.push('unknown-issuer-refused-before-upstream');
}
{
  const p=pool('cancelled'),controller=new AbortController();controller.abort();await assert.rejects(p.select(request(),controller.signal));checks.push('aborted-selection-not-dispatched');
}
{
  const c:any=config();c.pausedCodexAccountIds=['a'];const p=pool('catalog',c);const rows=await p.catalog();assert.equal(rows.length,1);assert.equal(rows[0].slug,'fixture-model');checks.push('catalog-excludes-paused-account-entitlements');
}
{
  const p=pool('binding',config(),true),first=request();await p.select(first,signal());
  await assert.rejects(p.select(request('fixture-model',{previous_response_id:'resp_first'}),signal()),/conversation_request_active/);
  p.noteSettlement(first,'not_sent');
  await assert.rejects(pool('binding',config()).select(request('fixture-model',{previous_response_id:'resp_first'}),signal()),/owner_unknown/);
  checks.push('selection-reservation-excludes-active-and-not-sent-does-not-claim-issuer');
  const rejected=request('fixture-model',{input:'rejected fixture'});await p.select(rejected,signal());
  p.beforeDispatch(rejected);p.noteSettlement(rejected,'rejected');
  await assert.rejects(pool('binding',config()).select(request('fixture-model',{previous_response_id:'resp_first'}),signal()),/owner_unknown/);
  checks.push('known-rejection-does-not-persist-state-issuer');
  const completed=request('fixture-model',{input:'completed fixture'});await p.select(completed,signal());
  p.beforeDispatch(completed);p.noteSettlement(completed,'completed');
  const restored=pool('binding',config(),true),same=request('fixture-model',{previous_response_id:'resp_first'});
  assert.equal((await restored.select(same,signal())).accountId,'a');
  assert.equal(restored.preparedBody(same).previous_response_id,'resp_first');
  restored.beforeDispatch(same);restored.noteSettlement(same,'completed');
  checks.push('successful-state-issuer-survives-component-restart');
  quotas.a={shortPercent:97,weeklyPercent:10};
  const rotated=pool('binding',config(),true),next=request('fixture-model',{previous_response_id:'resp_first'});
  assert.equal((await rotated.select(next,signal())).accountId,'b');
  assert.equal(rotated.preparedBody(next).previous_response_id,undefined);
  assert.equal(rotated.preparedBody(next).input,'fixture');
  checks.push('97-switch-scrubs-foreign-state-and-keeps-readable-history');
  rotated.noteSettlement(next,'not_sent');
  const files=pool('binding',config(),true);
  await assert.rejects(files.select(request('fixture-model',{previous_response_id:'resp_first',fileIds:['file_a']}),signal()),/cannot_change_account/);
  checks.push('bound-file-reference-refused-on-account-change');
  quotas.a={shortPercent:10,weeklyPercent:10};
}
{
  quotas.a={shortPercent:10,weeklyPercent:10,shortResetAt:Date.now()+200_000};
  quotas.b={shortPercent:20,weeklyPercent:20,shortResetAt:Date.now()+100_000};
  const p=pool('reset-order');assert.equal((await p.select(request(),signal())).accountId,'b');
  checks.push('reset-first-uses-earliest-verified-future-window');
  quotas={a:{shortPercent:10,weeklyPercent:10},b:{shortPercent:20,weeklyPercent:20}};
}
{
  const c=config();c.codexAccounts[0].email='fixture@example.invalid';c.codexAccounts[0].refreshToken='must-not-copy';
  c.activeCodexAccountId='b';
  const p=pool('local-status',c);
  writeFileSync(join(fixtureRoot,'local-status','config.json'),JSON.stringify({defaultProvider:'fixture',untouched:'keep'}));
  await p.synchronize(true);
  const saved=JSON.parse(readFileSync(join(fixtureRoot,'local-status','config.json'),'utf8'));
  assert.equal(saved.untouched,'keep');assert.equal(saved.codexAccounts[0].refreshToken,undefined);
  assert.equal(p.describeActive().activeCodexAccountId,'b');
  checks.push('manual-use-sync-mirrors-policy-without-credentials');
  const accounts=await p.describeAccounts(true);
  assert.equal(accounts.accounts.length,2);assert.equal(accounts.accounts[0].quota?.shortPercent,10);
  assert.ok(accounts.accounts[0].quota.updatedAt>0);
  assert.equal(accounts.accounts[0].refreshToken,undefined);
  checks.push('local-status-preserves-tray-account-and-quota-contract');
}
{
  // A background memory request and the user turn share a thread, not a lifetime.
  // Exercise both arrival orders and settle them independently.
  for(const memoryFirst of [true,false]) {
    const p=pool('memory-lane-'+memoryFirst,config(),true);
    const turn=request('fixture-model',{input:'user work'});
    const memory=request('fixture-model',{input:'memory work'});
    memory.headers.set('x-codex-turn-metadata',JSON.stringify({request_kind:'memory'}));
    const first=memoryFirst?memory:turn,second=memoryFirst?turn:memory;
    await p.select(first,signal());p.beforeDispatch(first);
    await p.select(second,signal());p.beforeDispatch(second);
    assert.equal(p.inflightFenceTurns(),2);
    const duplicate=request('fixture-model',{input:'another user turn'});
    await assert.rejects(p.select(duplicate,signal()),/conversation_request_active/);
    const duplicateMemory=request('fixture-model',{input:'memory work'});
    duplicateMemory.headers.set('x-codex-turn-metadata','{"request_kind":"memory"}');
    await assert.rejects(p.select(duplicateMemory,signal()),/conversation_request_active/);
    const independentMemory=request('fixture-model',{input:'another independent memory job'});
    independentMemory.headers.set('x-codex-turn-metadata','{"request_kind":"memory"}');
    await p.select(independentMemory,signal());
    assert.equal(p.inflightFenceTurns(),3);
    p.noteSettlement(independentMemory,'completed');
    p.noteSettlement(memory,'completed');
    assert.equal(p.inflightFenceTurns(),1);
    await assert.rejects(p.select(duplicate,signal()),/conversation_request_active/);
    p.noteSettlement(turn,'completed');
    assert.equal(p.inflightFenceTurns(),0);assert.equal(p.unknownTurns(),0);
  }
  checks.push('memory-and-user-turn-independent-in-both-arrival-orders');
}
{
  const memory=(input:string)=>{
    const r=request('fixture-model',{input});
    r.headers.set('x-codex-turn-metadata','{"request_kind":"memory"}');return r;
  };
  const p=pool('memory-unresolved',config(),true),a=memory('unresolved memory');
  await p.select(a,signal());p.beforeDispatch(a);p.noteSettlement(a,'unknown');
  await assert.rejects(p.select(memory('unresolved memory'),signal()),/request_outcome_unknown/);
  const b=memory('new independent memory');await p.select(b,signal());p.noteSettlement(b,'completed');
  assert.equal(p.unknownTurns(),1);
  const reloaded=pool('memory-unresolved',config(),true);
  await assert.rejects(reloaded.select(memory('unresolved memory'),signal()),/request_outcome_unknown/);
  const home=join(fixtureRoot,'legacy-memory-unresolved');mkdirSync(home,{recursive:true});
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  const key=hash('aicc-memory\0fixture-thread').slice(0,32);
  const fingerprint=hash(JSON.stringify({model:'fixture-model',input:'legacy unresolved memory'}));
  writeFileSync(join(home,'external-request-lifecycle.json'),JSON.stringify({schemaVersion:1,rows:[
    {key,operationId:'legacy',accountId:'a',at:Date.now(),state:'unknown',requestFingerprint:fingerprint}]}));
  const legacy=pool('legacy-memory-unresolved',config(),true);
  await assert.rejects(legacy.select(memory('legacy unresolved memory'),signal()),/request_outcome_unknown/);
  const c=memory('new work after upgrade');await legacy.select(c,signal());legacy.noteSettlement(c,'completed');
  assert.equal(legacy.unknownTurns(),1);
  await assert.rejects(legacy.select(memory('legacy unresolved memory'),signal()),/request_outcome_unknown/);
  checks.push('independent-memory-jobs-preserve-new-and-legacy-unknown-replay-protection');
}
console.log(JSON.stringify({status:'PASS',scope:'isolated-external-pool-policy',inference:'forbidden',checks,
  compatibilityRemaining:['live-legacy-issuer-preimage','management-and-WebSocket-live-parity']}));
