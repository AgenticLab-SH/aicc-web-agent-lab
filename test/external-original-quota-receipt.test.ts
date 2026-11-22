import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOriginalOcxQuotaReceiptStore,readActualFiveHourWindow} from '../tools/platform/opencodex/external-original-quota-receipt';
import {createExternalPoolState} from '../tools/platform/opencodex/external-pool-state';
import {createExternalOcxHttpBoundary} from '../tools/platform/opencodex/external-http-boundary';

const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
const threadId='01a1c19b-5641-7a50-9168-19e87601b1ef';
const turnId='ababaaba-aaaa-4aaa-baaa-aaaaaaaaaaaa';
const otherTurn='aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';
const requestId='central-original-request-001';
const sourceFiles=(home:string,id:string)=>join(home,'external-original-quota-receipts',id);
function fixture({noTurn=false,wrongWindow=false,ambiguous=false}:{
 noTurn?:boolean;wrongWindow?:boolean;ambiguous?:boolean
}={}){
 const home=mkdtempSync(join(tmpdir(),'aicc-real-ocx-quota-'));
 const config:any={codexAccounts:[{id:'raw-private-account-A',alias:'1번'},{id:'raw-private-account-B',alias:'2번'}],
  codexAccountNamespaces:{p000001:'raw-private-account-A',p000002:'raw-private-account-B'},
  pausedCodexAccountIds:[],codexAccountPriorities:{},accountPoolStrategy:'fill-first'};
 writeFileSync(join(home,'config.json'),JSON.stringify(config));
 const records:any={
  'raw-private-account-A':{generation:1,lastCodexValidationTerminal:false},
  'raw-private-account-B':{generation:1,lastCodexValidationTerminal:false}
 };
 const backend:any={
  'raw-private-account-A':{used:97,allowed:true,week:10},
  'raw-private-account-B':{used:97,allowed:true,week:10}
 };
 const resetAt=Math.ceil(Date.now()/1000)+1;
 const requests:string[]=[];let sends=0;
 globalThis.fetch=(async(url:any,init:any)=>{
  const account=new Headers(init.headers).get('chatgpt-account-id')!;
  requests.push(account);
  if(String(url).includes('/wham/usage'))return Response.json({
   rate_limit:{allowed:backend[account].allowed,
    primary_window:{limit_window_seconds:wrongWindow?900:18000,
      used_percent:backend[account].used,reset_at:backend[account].resetAt??resetAt},
    secondary_window:{limit_window_seconds:604800,
      used_percent:backend[account].week,reset_at:resetAt+604800}}});
  if(String(url).includes('/codex/models'))return Response.json({models:[]});
  throw Error('model dispatch forbidden');
 }) as any;
 const pool=createExternalPoolState({home,clientVersion:'0.167.0',
  supplier:{readBody:r=>r.json(),collectCarriers:()=>({}),
   parseQuota:body=>({shortPercent:body.rate_limit.primary_window.used_percent,
    weeklyPercent:body.rate_limit.secondary_window.used_percent}),
   resolveRoute:(_config,model)=>({modelId:model.split('/').at(-1),
    accountId:model.startsWith('p000001/')?'raw-private-account-A':
     model.startsWith('p000002/')?'raw-private-account-B':undefined,provider:{}})},
  transport:{request:async(data:any)=>data.action==='snapshot'
    ?{ok:true,config,records,settings:{schemaVersion:1,
      fiveHour:{usedThreshold:97,action:'stop'},
      longWindow:{usedThreshold:98,action:'stop'}}}
    :{ok:true,accessToken:'access-secret-'+data.id,chatgptAccountId:data.id,
      generation:records[data.id].generation,expiresAt:Date.now()+120000}}});
 const boundary=createExternalOcxHttpBoundary({
  dataToken:()=> 'fixture-data-token',settings:pool.settings,select:pool.select,
  generationLive:pool.generationLive,quota:pool.quota,refresh:pool.refresh,
  beforeDispatch:pool.beforeDispatch,noteSettlement:pool.noteSettlement,
  noteOriginalQuotaRefusal:pool.noteOriginalQuotaRefusal,
  dispatch:async()=>{sends++;throw Error('inference must not start');},
  catalog:async()=>new Response('{}')});
 const request=(extraHeaders:Record<string,string>={},model=ambiguous?'gpt-6.1-sol':'p000001/gpt-6.1-sol')=>
  new Request('http://127.0.0.1:10101/v1/responses',{method:'POST',
   headers:{authorization:'Bearer fixture-data-token','x-client-request-id':requestId,
    'thread-id':threadId,...(noTurn?{}:{'x-codex-turn-id':turnId}),...extraHeaders},
   body:JSON.stringify({model,input:'PRIVATE_ENCRYPTED_CONTEXT_NEVER_WRITE'})});
 const run=async(extra:Record<string,string>={},model?:string)=>{
  const response=await boundary.handle(request(extra,model));
  return {status:response.status,body:await response.json()};
 };
 return {home,config,records,backend,resetAt,requests,pool,run,request,sends:()=>sends,
  cleanup:()=>rmSync(home,{recursive:true,force:true})};
}
test('exact WHAM 300 minutes is distinguished from a 97% OCX policy stop',()=>{
 const resetAt=Math.floor(Date.now()/1000)+18000;
 expect(readActualFiveHourWindow({rate_limit:{allowed:true,
  primary_window:{limit_window_seconds:18000,used_percent:97,reset_at:resetAt}}}))
  .toMatchObject({windowDurationMins:300,usedPercent:97,backendUsageAllowed:true});
 expect(readActualFiveHourWindow({rate_limit:{allowed:false,
  primary_window:{limit_window_seconds:18000,used_percent:100,reset_at:resetAt}}}))
  .toMatchObject({usedPercent:100,backendUsageAllowed:false});
 for(const duration of [900,3600,17999,18001]){
  expect(readActualFiveHourWindow({rate_limit:{
    primary_window:{limit_window_seconds:duration,used_percent:100,reset_at:resetAt}}})).toBeNull();
 }
 expect(readActualFiveHourWindow({rate_limit:{
  primary_window:{limit_window_seconds:18000,used_percent:NaN,reset_at:resetAt}}})).toBeNull();
});
test('backend explicitly refused at actual 100 percent is recorded separately from an OCX 97 percent policy block',async()=>{
 const f=fixture();
 try{
  f.backend['raw-private-account-A']={used:100,allowed:false,week:10};
  const {status,body}=await f.run();
  expect(status).toBe(429);
  const origin=body.error.ownerQuotaEvidence;
  expect(origin).toBeTruthy();
  const source=JSON.parse(readFileSync(sourceFiles(f.home,origin.ownerRequestId+'.refusal.json'),'utf8'));
  expect(source.quota).toMatchObject({windowDurationMins:300,usedPercent:100,
    backendUsageAllowed:false,providerLimitProven:true});
  expect(source.policy.fiveHourUsedThreshold).toBe(97);
  expect(source.originalTurnAuthenticated).toBe(false);
  expect(f.sends()).toBe(0);
 }finally{f.cleanup();}
});
test('original OCX selected-account 97% refusal seals no-send source without secrets, then exact management-bound turn and same-account fresh recovery',async()=>{
 const f=fixture();
 try {
  const {status,body}=await f.run();
  expect(status).toBe(429);expect(f.sends()).toBe(0);
  const ref=body.error.ownerQuotaEvidence;
  expect(ref).toMatchObject({kind:'aicc-ocx-original-fivehour-pre-dispatch-refusal/v1',
   sourceOnly:true,originalIssuerVerified:false,dispatchable:false});
  expect(ref.ownerRequestId).toMatch(/^[0-9a-f-]{36}$/);
  const privateText=readFileSync(sourceFiles(f.home,ref.ownerRequestId+'.refusal.json'),'utf8');
  const sealed=JSON.parse(privateText);
  expect(sealed).toMatchObject({accountIdSha256:expect.stringMatching(/^[a-f0-9]{64}$/),
   credentialGeneration:1,reason:'window_threshold',phase:'pre_dispatch',
   dispatchStarted:false,issuerAuthorityGranted:false,originalTurnAuthenticated:false,
   quota:{windowDurationMins:300,usedPercent:97,backendUsageAllowed:true,providerLimitProven:false},
   policy:{fiveHourUsedThreshold:97}});
  for(const forbidden of ['raw-private-account-A','access-secret','PRIVATE_ENCRYPTED_CONTEXT',
    'fixture-data-token','refreshToken']) {
   expect(privateText).not.toContain(forbidden);
   expect(JSON.stringify(body)).not.toContain(forbidden);
  }
  expect(body.error.quotaRefusal).toMatchObject({requestId,threadId,turnId});
  expect(()=>f.pool.attestOriginalQuota({ownerRequestId:ref.ownerRequestId,
   refusalSha256:ref.receiptSha256,requestId,threadId,turnId:otherTurn})).toThrow();
  const bound=f.pool.attestOriginalQuota({ownerRequestId:ref.ownerRequestId,
   refusalSha256:ref.receiptSha256,requestId,threadId,turnId});
  expect(bound).toMatchObject({kind:'aicc-ocx-management-bound-turn-correlation/v1',dispatchable:false});
  expect(()=>f.pool.attestOriginalQuota({ownerRequestId:ref.ownerRequestId,
   refusalSha256:ref.receiptSha256,requestId,threadId,turnId})).toThrow();
  const early=await f.pool.recoverOriginalQuota({ownerRequestId:ref.ownerRequestId,
   attestationSha256:bound.receiptSha256});
  expect(early.state).toBe('ORIGINAL_FIVE_HOUR_RESET_NOT_YET_OBSERVED_HOLD');
  f.backend['raw-private-account-A']={used:12,allowed:true,week:10,resetAt:f.resetAt+18000};
  await Bun.sleep(Math.max(0,f.resetAt*1000-Date.now()+40));
  const recovered=await f.pool.recoverOriginalQuota({ownerRequestId:ref.ownerRequestId,
   attestationSha256:bound.receiptSha256});
  expect(recovered).toMatchObject({state:'ORIGINAL_SAME_ACCOUNT_FRESH_QUOTA_SOURCE_ONLY',
   dispatchable:false,modelRequests:0,newTurns:0});
  const content=readFileSync(sourceFiles(f.home,ref.ownerRequestId+'.recovery.json'),'utf8');
  expect(JSON.parse(content)).toMatchObject({priorRefusalClass:'EXACT_OCX_POLICY_THRESHOLD_ONLY',
   accountIdSha256:sealed.accountIdSha256,credentialGeneration:1,
   freshQuota:{windowDurationMins:300,usedPercent:12,backendUsageAllowed:true},
   goalVerified:false,stopEpochVerified:false,writerReturnedVerified:false});
  expect(content).not.toContain('raw-private-account-A');
  expect(f.requests.every(id=>id==='raw-private-account-A')).toBe(true);
  expect(f.sends()).toBe(0);
 }finally{f.cleanup();}
});
test('wrong or absent original turn, ambiguous selector, or non-300 backend produces no issuer receipt',async()=>{
 for(const options of [{noTurn:true},{ambiguous:true},{wrongWindow:true}]){
  const f=fixture(options);
  try {
   const value=await f.run();
   expect(value.body.error.ownerQuotaEvidence).toBeUndefined();
   expect(f.sends()).toBe(0);
   expect(value.body.error.quotaRefusal?.dispatchStarted??false).toBe(false);
  }finally{f.cleanup();}
 }
});
test('pinned source refuses tampered files and does not accept a different account or changed generation',async()=>{
 const f=fixture();try {
  const {body}=await f.run(),ref=body.error.ownerQuotaEvidence;
  expect(ref).toBeTruthy();
  expect(()=>f.pool.attestOriginalQuota({ownerRequestId:ref.ownerRequestId,
    refusalSha256:'0'.repeat(64),requestId,threadId,turnId})).toThrow();
  const bound=f.pool.attestOriginalQuota({ownerRequestId:ref.ownerRequestId,
    refusalSha256:ref.receiptSha256,requestId,threadId,turnId});
  f.backend['raw-private-account-B']={used:1,allowed:true,week:1};
  f.config.pausedCodexAccountIds=['raw-private-account-A'];
  await Bun.sleep(Math.max(0,f.resetAt*1000-Date.now()+40));
  const unrelated=await f.pool.recoverOriginalQuota({ownerRequestId:ref.ownerRequestId,
   attestationSha256:bound.receiptSha256});
  expect(unrelated.state).toBe('ORIGINAL_SAME_ACCOUNT_FRESH_QUOTA_UNVERIFIED_HOLD');
  expect(f.requests).not.toContain('raw-private-account-B');
  f.config.pausedCodexAccountIds=[];f.records['raw-private-account-A'].generation=2;
  const rotated=await f.pool.recoverOriginalQuota({ownerRequestId:ref.ownerRequestId,
   attestationSha256:bound.receiptSha256});
  expect(rotated.state).toBe('ORIGINAL_SAME_ACCOUNT_FRESH_QUOTA_UNVERIFIED_HOLD');
  expect(existsSync(sourceFiles(f.home,ref.ownerRequestId+'.recovery.json'))).toBe(false);
 }finally{f.cleanup();}
});
test('owner proof is not manufactured from untrusted client metadata or UNKNOWN/future/expired source',async()=>{
 const home=mkdtempSync(join(tmpdir(),'aicc-source-auth-negative-'));
 try {
  let ms=Date.parse('2026-11-14T00:00:00Z');
  const store=createOriginalOcxQuotaReceiptStore({home,now:()=>ms});
  const goodWindow={window:'primary' as const,windowDurationMins:300 as const,
   usedPercent:100,resetsAt:Math.floor((ms+3600000)/1000),backendUsageAllowed:false};
  const request=new Request('http://127.0.0.1:10101/v1/responses',
   {headers:{'x-client-request-id':requestId,'thread-id':threadId,'x-codex-turn-id':turnId}});
  const policy={fiveHour:{usedThreshold:97,action:'stop' as const},
   longWindow:{usedThreshold:98,action:'stop' as const}};
  expect(store.observeSelected(request,{accountId:'PRIVATE_1',generation:2,
   quota:{shortPercent:100,weeklyPercent:2},window:goodWindow,
   quotaObservedAt:ms,policy})).toBe(true);
  const ref=store.recordRefusal(request,'window_threshold');
  expect(ref).toBeTruthy();
  expect(ref!.codexUsageLimit).toEqual({resetsAt:goodWindow.resetsAt,windowMinutes:300});
  expect(store.recordRefusal(request,'window_threshold')).toBeNull();
  ms+=600001;
  expect(()=>store.attest({ownerRequestId:ref!.ownerRequestId,
   refusalSha256:ref!.receiptSha256,requestId,threadId,turnId})).toThrow();
  const other=new Request('http://127.0.0.1:10101/v1/responses',
   {headers:{'x-client-request-id':requestId,'thread-id':threadId}});
  expect(store.observeSelected(other,{accountId:'PRIVATE_1',generation:2,
   quota:{shortPercent:100,weeklyPercent:2},window:goodWindow,quotaObservedAt:ms,policy})).toBe(false);
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('runtime admin route is restricted to the existing management token and nonweb OCX10101',()=>{
 const runtime=readFileSync(new URL('../tools/platform/opencodex/external-runtime.ts',import.meta.url),'utf8');
 expect(runtime).toContain("server.port!==10101||request.method!=='POST'||!tokenMatches(request,managementToken)");
 expect(runtime).toContain("server.port!==10101||request.method!=='GET'||!tokenMatches(request,managementToken)");
 expect(runtime).toContain("original-quota/attest");
 expect(runtime).toContain("original-quota/recovery");
 expect(runtime).not.toContain('originalQuotaMutationAllowed:true');
});

test('recovery GET remains fresh across repetition, concurrency and store restart without rewriting first evidence',async()=>{
 const home=mkdtempSync(join(tmpdir(),'aicc-recovery-repeat-'));
 let ms=Date.parse('2026-11-14T00:00:00Z'),used=5,long:any=10,generation=1,reads=0;
 const policy={fiveHour:{usedThreshold:97,action:'stop' as const},longWindow:{usedThreshold:98,action:'stop' as const}};
 const store=createOriginalOcxQuotaReceiptStore({home,now:()=>ms});
 const req=new Request('http://127.0.0.1:10101/v1/responses',{headers:{'x-client-request-id':requestId,'thread-id':threadId,'x-codex-turn-id':turnId}});
 const reset=ms/1000+60;
 store.observeSelected(req,{accountId:'fixture-account',generation:1,quota:{shortPercent:100,weeklyPercent:10},
  window:{window:'primary',windowDurationMins:300,usedPercent:100,resetsAt:reset,backendUsageAllowed:false},quotaObservedAt:ms,policy});
 const ref=store.recordRefusal(req,'window_threshold')!;
 const pin=store.attest({ownerRequestId:ref.ownerRequestId,refusalSha256:ref.receiptSha256,requestId,threadId,turnId});
 const input={ownerRequestId:ref.ownerRequestId,attestationSha256:pin.receiptSha256,
  readSameAccount:async(accountIdSha256:string)=>{reads++;return {accountIdSha256,generation,policy,
   quota:{shortPercent:used,weeklyPercent:long},quotaObservedAt:ms,
   window:{window:'primary' as const,windowDurationMins:300 as const,usedPercent:used,resetsAt:ms/1000+18000,backendUsageAllowed:true}};}};
 ms=reset*1000+1;
 const first=await store.recover(input),file=sourceFiles(home,ref.ownerRequestId+'.recovery.json');
 const bytes=readFileSync(file,'utf8');
 expect((await store.recover(input)).receiptSha256).toBe(first.receiptSha256);
 const restarted=createOriginalOcxQuotaReceiptStore({home,now:()=>ms});
 expect((await restarted.recover(input)).receiptSha256).toBe(first.receiptSha256);
 expect((await Promise.all([store.recover(input),restarted.recover(input)])).every(x=>x.receiptSha256===first.receiptSha256)).toBe(true);
 ms+=120001;
 const fresh=await restarted.recover(input);
 expect(fresh.receiptSha256).not.toBe(first.receiptSha256);
 expect(readFileSync(file,'utf8')).toBe(bytes);
 expect(readdirSync(join(home,'external-original-quota-receipts')).filter(x=>x.includes('.recovery.'))).toHaveLength(3);
 for(const invalid of ['exhausted','generation','unknown-long','invalid-long','long-exhausted']){
  used=invalid==='exhausted'?100:5;generation=invalid==='generation'?2:1;
  long=invalid==='unknown-long'?undefined:invalid==='invalid-long'?NaN:invalid==='long-exhausted'?100:10;
  expect((await restarted.recover(input)).state).toBe('ORIGINAL_SAME_ACCOUNT_FRESH_QUOTA_UNVERIFIED_HOLD');
 }
 used=5;generation=1;long=10;
 writeFileSync(file,JSON.stringify({...JSON.parse(bytes),attestationSha256:'f'.repeat(64)}));
 await expect(restarted.recover(input)).rejects.toThrow();
 writeFileSync(file,bytes);
 const observation=join(home,'external-original-quota-receipts',ref.ownerRequestId+'.recovery.'+first.receiptSha256+'.json');
 const observationBytes=readFileSync(observation,'utf8');
 writeFileSync(observation,'{}');
 await expect(restarted.recover(input)).rejects.toThrow('first_recovery_pin_changed');
 writeFileSync(observation,observationBytes);
 const previousMs=ms;
 const rollback={...input,readSameAccount:async(id:string)=>{const row=await input.readSameAccount(id);ms-=1;return row;}};
 expect((await restarted.recover(rollback)).state).toBe('ORIGINAL_SAME_ACCOUNT_FRESH_QUOTA_UNVERIFIED_HOLD');
 ms=previousMs;
 expect(reads).toBeGreaterThanOrEqual(12);
});
