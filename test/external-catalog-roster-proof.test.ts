import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createExternalPoolState} from '../tools/platform/opencodex/external-pool-state';
const originalFetch=globalThis.fetch,originalNow=Date.now;
afterEach(()=>{globalThis.fetch=originalFetch;Date.now=originalNow;});
const sol={slug:'gpt-6.1-sol',visibility:'list',supported_in_api:true,supported_reasoning_levels:[{effort:'high',description:'High'}]};
function assertStrictPreferredPairs(snapshot:any){
 const expected=snapshot.accountRosterProofs.flatMap((proof:any)=>[
  proof.selector+'/gpt-6.1-sol','preferred-'+proof.selector+'/gpt-6.1-sol']);
 const actual=snapshot.models.filter((row:any)=>String(row.slug).endsWith('/gpt-6.1-sol')).map((row:any)=>row.slug);
 expect(actual.slice().sort()).toEqual(expected.slice().sort());
 expect(new Set(actual).size).toBe(actual.length);
}
function fixture(count=4){
 const home=mkdtempSync(join(tmpdir(),'aicc-roster-proof-'));
 let now=1792870000000;Date.now=()=>now;
 const ids=Array.from({length:count},(_,i)=>'private-owner-'+i);
 const config:any={codexAccounts:ids.map((id,i)=>({id,alias:(i+1)+'번(fixture)',logLabel:'p'+String(i+1).padStart(6,'0')})),codexAccountNamespaces:Object.fromEntries(ids.map((id,i)=>['p'+String(i+1).padStart(6,'0'),id])),pausedCodexAccountIds:[],activeCodexAccountId:ids[0]};
 const records:any=Object.fromEntries(ids.map(id=>[id,{generation:1}]));
 const calls:string[]=[];let hook:(id:string)=>void=()=>{};let buildHook=()=>{};
 writeFileSync(join(home,'config.json'),JSON.stringify(config));
 globalThis.fetch=(async(input:any,init:any)=>{
  if(!String(input).startsWith('https://chatgpt.com/backend-api/codex/models?client_version=0.163.0'))throw Error('only-model-roster-fixtures-allowed');
  const id=new Headers(init.headers).get('chatgpt-account-id')!;calls.push(id);hook(id);
  return Response.json({models:[sol,{slug:'fixture-other-model',privateProviderMetadata:'not-in-proof'}]});
 }) as any;
 const pool=createExternalPoolState({home,clientVersion:'0.163.0',supplier:{readBody:r=>r.json(),parseQuota:v=>v,collectCarriers:()=>({}),resolveRoute:(_c,m)=>({modelId:m,provider:{}}),buildCatalog:(_c,rows)=>{buildHook();return rows;}},transport:{request:async(d:any)=>d.action==='snapshot'?{ok:true,config,records,settings:{schemaVersion:1,fiveHour:{usedThreshold:97,action:'stop'},longWindow:{usedThreshold:97,action:'stop'}}}:{ok:true,accessToken:'fixture-secret-'+d.id,chatgptAccountId:d.id,generation:records[d.id].generation,expiresAt:now+120000}}});
 return {pool,config,records,ids,calls,advance:(ms:number)=>{now+=ms;},onFetch:(f:(id:string)=>void)=>{hook=f;},onBuild:(f:()=>void)=>{buildHook=f;},now:()=>now};
}
test('private catalog proves four exact account/cache generations, timestamps and entitled slugs',async()=>{
 const f=fixture(),snapshot=await f.pool.catalogSnapshot();
 expect(snapshot.accountRosterProofsStatus).toBe('SUPPORTED');expect(snapshot.accountRosterProofs).toHaveLength(4);
 for(const [i,proof] of snapshot.accountRosterProofs.entries()){
  expect(proof).toEqual({selector:'p'+String(i+1).padStart(6,'0'),accountId:f.ids[i],credentialGeneration:1,observedAt:new Date(f.now()).toISOString(),entitledModels:['gpt-6.1-sol','fixture-other-model'],clientVersion:'0.163.0'});
 }
 assertStrictPreferredPairs(snapshot);
 expect(JSON.stringify(snapshot.accountRosterProofs)).not.toMatch(/accessToken|fixture-secret|privateProviderMetadata/);
 expect(f.calls).toHaveLength(4);
});
test('cached proof keeps the original observation instead of refreshing its timestamp',async()=>{
 const f=fixture();const first=await f.pool.catalogSnapshot();f.advance(25000);const second=await f.pool.catalogSnapshot();
 expect(second.accountRosterProofs).toEqual(first.accountRosterProofs);expect(f.calls).toHaveLength(4);
});
test('generation rotation during another account read drops earlier proof and pinned row',async()=>{
 const f=fixture();f.onFetch(id=>{if(id===f.ids[3])f.records[f.ids[0]].generation=2;});
 const value=await f.pool.catalogSnapshot();
 expect(value.accountRosterProofsStatus).toBe('PARTIAL');expect(value.accountRosterProofs.some(p=>p.accountId===f.ids[0])).toBe(false);
 expect(value.models.some(row=>row.slug==='p000001/gpt-6.1-sol')).toBe(false);
});
test('cache expiration while another roster loads cannot mint a new observation time',async()=>{
 const f=fixture();f.onFetch(id=>{if(id===f.ids[3])f.advance(60001);});const value=await f.pool.catalogSnapshot();
 expect(value.accountRosterProofs).toHaveLength(1);expect(value.accountRosterProofs[0].accountId).toBe(f.ids[3]);
 assertStrictPreferredPairs(value);
});
test('current namespace ambiguity and duplicate managed numbers never produce guessed proofs',async()=>{
 const f=fixture(2);f.config.codexAccountNamespaces.extra=f.ids[0];f.config.codexAccounts[1].alias='01번(ambiguous)';
 const value=await f.pool.catalogSnapshot();expect(value.accountRosterProofsStatus).toBe('UNSUPPORTED');expect(value.accountRosterProofs).toEqual([]);
 expect(value.models.some(row=>String(row.slug).includes('/gpt-6.1-sol'))).toBe(false);
});
test('terminal/paused accounts are excluded without fetching their rosters',async()=>{
 const f=fixture();f.records[f.ids[0]].lastCodexValidationTerminal=true;f.config.pausedCodexAccountIds=[f.ids[1]];
 const value=await f.pool.catalogSnapshot();expect(value.accountRosterProofs.map(p=>p.accountId)).toEqual(f.ids.slice(2));expect(f.calls).toEqual(f.ids.slice(2));
});
test('generation change in stock presentation also cannot leave a pinned proof',async()=>{
 const f=fixture(1);f.onBuild(()=>{f.records[f.ids[0]].generation=2;});const value=await f.pool.catalogSnapshot();
 expect(value.accountRosterProofsStatus).toBe('UNSUPPORTED');expect(value.accountRosterProofs).toEqual([]);expect(value.models.some(row=>String(row.slug).includes('/gpt-6.1-sol'))).toBe(false);
});
test('array catalog compatibility and runtime route projection keep private proofs out of models/discovery',async()=>{
 const f=fixture(1),rows=await f.pool.catalog();expect(Array.isArray(rows)).toBe(true);expect(JSON.stringify(rows)).not.toContain(f.ids[0]);
 expect(JSON.stringify(f.pool.discovery(rows))).not.toContain('accountRosterProofs');
 const runtime=readFileSync(new URL('../tools/platform/opencodex/external-runtime.ts',import.meta.url),'utf8');
 const start=runtime.indexOf('    const snapshot=await pool.catalogSnapshot();');
 const end=runtime.indexOf("      {headers:{'cache-control':'no-store'}});",start)+"      {headers:{'cache-control':'no-store'}});".length;
 expect(start).toBeGreaterThan(0);const handler=new Function('pool','request','Response','URL',`return (async()=>{${runtime.slice(start,end)}})()`);
 for(const [path,privateExpected] of [['/v1/catalog',true],['/v1/models?client_version=0.163.0',false],['/v1/models',false]] as const){
  const response=await handler(f.pool,new Request('http://127.0.0.1:10100'+path),Response,URL);const body=await response.json();
  expect(Object.hasOwn(body,'accountRosterProofs')).toBe(privateExpected);expect(JSON.stringify(body).includes(f.ids[0])).toBe(privateExpected);
 }
});
