import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createExternalPoolState} from '../tools/platform/opencodex/external-pool-state';
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
const model={slug:'gpt-6.1-sol',visibility:'list',supported_in_api:true,
  supported_reasoning_levels:[{effort:'high',description:'High'}]};
function fixture({blocked=false,missing=false,terminal=false,allEligible=false,active='b',models=[model],scrub,quota,switchActions=false}:{blocked?:boolean;missing?:boolean;terminal?:boolean;allEligible?:boolean;active?:string;models?:any[];scrub?:(body:any,preserve?:boolean)=>Promise<any>;quota?:(id:string)=>any;switchActions?:boolean}={}) {
  const home=mkdtempSync(join(tmpdir(),'aicc-picker-pool-'));
  const config:any={codexAccounts:[{id:'a',alias:'1번(fixture)',logLabel:'p000001'},
    {id:'b',alias:'2번(other)',logLabel:'p000002'}],codexAccountNamespaces:{p000001:'a',p000002:'b',pstale:'gone'},
    pausedCodexAccountIds:[],activeCodexAccountPinned:'b',activeCodexAccountId:active,
    codexAccountPriorities:{a:100,b:-100},accountPoolStrategy:'fill-first'};
  writeFileSync(join(home,'config.json'),JSON.stringify(config));
  const reads:string[]=[];
  globalThis.fetch=(async(url:any,init:any)=>{
    const id=new Headers(init.headers).get('chatgpt-account-id')!;reads.push(id);
    if(String(url).includes('/wham/usage'))return Response.json(quota?quota(id):{shortPercent:id==='a'&&blocked?97:10,weeklyPercent:id==='b'&&!allEligible?99:10});
    if(String(url).includes('/codex/models?'))return Response.json({models:id==='a'&&missing?[]:models});
    throw Error('inference forbidden in fixture');
  }) as any;
  const records={a:{generation:1,lastCodexValidationTerminal:terminal},b:{generation:1}};
  const reload=()=>createExternalPoolState({home,clientVersion:'0.163.0',supplier:{
    readBody:r=>r.json(),parseQuota:v=>v,
    collectCarriers:b=>({previousResponseId:b.previous_response_id,encryptedReasoning:b.encryptedReasoning}),
    ...(scrub?{scrubAccountChange:scrub}:{}),
    resolveRoute:(_c,m)=>({modelId:m.includes('/')?m.split('/')[1]:m,accountId:m.startsWith('p000001/')?'a':m.startsWith('p000002/')?'b':undefined,provider:{}}),
    buildCatalog:(_c,rows)=>rows},transport:{request:async(d:any)=>d.action==='snapshot'
      ?{ok:true,config,records,settings:{schemaVersion:1,fiveHour:{usedThreshold:97,action:switchActions?'switch':'stop'},longWindow:{usedThreshold:97,action:switchActions?'switch':'stop'}}}
      :{ok:true,accessToken:'fixture-'+d.id,chatgptAccountId:d.id,generation:1,expiresAt:Date.now()+120000}}});
  const pool=reload();
  return {pool,home,reads,config,records,reload};
}
const request=(selector='p000001',extra={},thread='new-fixture-thread')=>new Request('http://localhost/v1/responses',{method:'POST',headers:{'thread-id':thread},body:JSON.stringify({model:selector+'/gpt-6.1-sol',input:'fixture',...extra})});
// Pool unit fixture supplies an explicit terminal settlement, never HTTP200-as-completion.
function completeFixture(pool:ReturnType<typeof createExternalPoolState>,req:Request){
  pool.beforeDispatch(req);pool.noteSettlement(req,'completed');
}

test('original issuer identity follows exact terminal thread and generation, never active picker',async()=>{
 const {pool,config,records}=fixture({allEligible:true});const thread=randomUUID();
 const first=request('p000001',{},thread);await pool.select(first,new AbortController().signal);
 await expect(pool.readOriginalIssuerIdentity(thread,'gpt-6.1-sol')).rejects.toThrow('conversation_request_active');
 completeFixture(pool,first);
 const result=await pool.readOriginalIssuerIdentity(thread,'gpt-6.1-sol');
 expect(result.accountIdSha256).toBe(createHash('sha256').update('a').digest('hex'));
 expect(result.credentialGeneration).toBe(1);expect(result.dispatchable).toBe(false);
 expect(config.activeCodexAccountPinned).toBe('b');
 await expect(pool.readOriginalIssuerIdentity(randomUUID(),'gpt-6.1-sol')).rejects.toThrow('unverified');
 await expect(pool.readOriginalIssuerIdentity(thread,'other-model')).rejects.toThrow('unverified');
 records.a.generation=2;
 await expect(pool.readOriginalIssuerIdentity(thread,'gpt-6.1-sol')).rejects.toThrow('unverified');
});

test('original issuer identity refuses legacy generationless metadata and unresolved attempt',async()=>{
 const {pool,home,reload}=fixture({allEligible:true});const thread=randomUUID();
 const first=request('p000001',{},thread);await pool.select(first,new AbortController().signal);completeFixture(pool,first);
 const path=join(home,'external-issuers.json'),saved=JSON.parse(readFileSync(path,'utf8'));
 const historical={...saved.rows[0]};delete historical.generation;delete historical.wireModel;
 // Existing legacy storage stays readable, but cannot be upgraded into identity proof.
 writeFileSync(path,JSON.stringify({...saved,rows:[historical]}));
 await expect(reload().readOriginalIssuerIdentity(thread,'gpt-6.1-sol')).rejects.toThrow('unverified');
 const next=request('p000001',{input:'new explicit fixture instruction'},thread);
 await pool.select(next,new AbortController().signal);pool.beforeDispatch(next);pool.noteSettlement(next,'unknown');
 await expect(pool.readOriginalIssuerIdentity(thread,'gpt-6.1-sol')).rejects.toThrow('unverified');
 expect(pool.unknownTurns()).toBe(1);
});

test('same thread leaves an exhausted issuer even with early cutoff disabled and global pin unchanged',async()=>{
 let used=99;
 const scrubbed:any[]=[];
 const {pool,home,config}=fixture({allEligible:true,switchActions:true,quota:id=>({shortPercent:id==='b'?used:10,weeklyPercent:10}),
   scrub:async body=>{scrubbed.push(body);const {encryptedReasoning,...portable}=body;return portable;}});
 writeFileSync(join(home,'aicc-account-quota-policy.json'),JSON.stringify({schemaVersion:1,defaultOtherAccounts:false,overrides:{b:false}}));
 const make=(input:string,extra={})=>new Request('http://localhost/v1/responses',{method:'POST',headers:{'thread-id':'exhausted-issuer'},body:JSON.stringify({model:'gpt-6.1-sol',input,...extra})});
 const first=make('first');expect((await pool.select(first,new AbortController().signal)).accountId).toBe('b');completeFixture(pool,first);
 used=100;
 const next=make('next new instruction',{encryptedReasoning:'old-account-ciphertext'});
 expect((await pool.select(next,new AbortController().signal)).accountId).toBe('a');
 expect(pool.preparedBody(next).encryptedReasoning).toBeUndefined();expect(scrubbed.length).toBe(1);
 expect(config.activeCodexAccountPinned).toBe('b');completeFixture(pool,next);
 const after=make('third instruction');expect((await pool.select(after,new AbortController().signal)).accountId).toBe('a');pool.noteSettlement(after,'not_sent');
});

test('98 percent five-hour override switches a continuing account without a weekly early cutoff',async()=>{
 let used=97;
 const {pool,home}=fixture({allEligible:true,switchActions:true,quota:id=>({shortPercent:id==='b'?used:10,weeklyPercent:99}),scrub:async body=>body});
 writeFileSync(join(home,'aicc-account-quota-policy.json'),JSON.stringify({schemaVersion:1,defaultOtherAccounts:false,overrides:{a:true,b:true},
   windowOverrides:{a:{fiveHour:{usedThreshold:97},longWindow:{enabled:false}},b:{fiveHour:{usedThreshold:98},longWindow:{enabled:false}}}}));
 const make=(input:string)=>new Request('http://localhost/v1/responses',{method:'POST',headers:{'thread-id':'threshold-issuer'},body:JSON.stringify({model:'gpt-6.1-sol',input})});
 const first=make('first');expect((await pool.select(first,new AbortController().signal)).accountId).toBe('b');completeFixture(pool,first);
 used=98;
 const next=make('next');expect((await pool.select(next,new AbortController().signal)).accountId).toBe('a');pool.noteSettlement(next,'not_sent');
 expect(pool.settings('b').fiveHour.usedThreshold).toBe(98);expect(pool.settings('b').longWindow.enabled).toBe(false);
});
test('explicit account ignores blocked global pin, priority and selection writes; wire effort is High',async()=>{
  const {pool,home,reads}=fixture();const req=request();
  expect((await pool.select(req,new AbortController().signal)).accountId).toBe('a');
  expect(pool.preparedBody(req).model).toBe('gpt-6.1-sol');
  expect(pool.preparedBody(req).reasoning.effort).toBe('high');
  expect(reads.every(id=>id==='a')).toBe(true);
  expect(existsSync(join(home,'external-selection.json'))).toBe(false);
  expect(pool.activeAccount()).toBe('b');
});
test('exhaustion and missing entitlement never fall back to another account',async()=>{
  for(const [option,code] of [[{blocked:true},'window_threshold'],[{missing:true},'model_not_supported_by_account'],[{terminal:true},'quota_unverified']] as const){
    const {pool,reads}=fixture(option);
    await expect(pool.select(request(),new AbortController().signal)).rejects.toThrow(code);
    expect(reads.includes('b')).toBe(false);
  }
});
test('unsupported effort and prior physical issuer are refused without fallback',async()=>{
  const {pool,reads}=fixture();await expect(pool.select(request('p000001',{reasoning:{effort:'low'}}),new AbortController().signal)).rejects.toThrow('picker_model_effort_unsupported');
  expect(reads.includes('b')).toBe(false);
  const first=request();await pool.select(first,new AbortController().signal);completeFixture(pool,first);
  await expect(pool.select(request('p000002'),new AbortController().signal)).rejects.toThrow('pinned_thread_account_change_refused');
});
test('every supported native effort is preserved on the exact model and account',async()=>{
  for(const slug of ['gpt-6.1-sol','gpt-6-astra','gpt-6-luna','gpt-6-terra']){
    const levels=['none','minimal','low','medium','high','xhigh'];
    const {pool,reads}=fixture({models:[{...model,slug,supported_reasoning_levels:levels.map(effort=>({effort}))}]});
    for(const effort of levels){
      const req=request('p000001',{model:'p000001/'+slug,reasoning:{effort,summary:'auto'}});
      expect((await pool.select(req,new AbortController().signal)).accountId).toBe('a');
      expect(pool.preparedBody(req)).toMatchObject({model:slug,reasoning:{effort,summary:'auto'}});
      completeFixture(pool,req);
    }
    expect(reads.every(id=>id==='a')).toBe(true);
  }
});
test('invalid capability and duplicate entitlement fail closed before dispatch',async()=>{
  for(const models of [[{...model,supported_reasoning_levels:[]}],[model,model]]){
    const {pool,reads}=fixture({models});
    await expect(pool.select(request(),new AbortController().signal)).rejects.toThrow();
    expect(reads.includes('b')).toBe(false);
  }
});
test('catalog uses current A1 aliases and excludes stale selector',async()=>{
  const {pool}=fixture();const rows=await pool.catalog();
  expect(rows.map(row=>row.slug)).toEqual(['gpt-6.1-sol','p000001/gpt-6.1-sol','preferred-p000001/gpt-6.1-sol',
    'p000002/gpt-6.1-sol','preferred-p000002/gpt-6.1-sol']);
  expect(rows[1].display_name).toBe('OCX · 계정 1 · Sol 6.1 · High');
});
test('automatic selection ignores an exhausted global pin and can use a higher priority eligible account',async()=>{
  const {pool,reads,config}=fixture();
  config.accountPoolStrategy='reset-first';config.codexAccountPriorities={a:300,b:200};
  const req=new Request('http://localhost/v1/responses',{method:'POST',headers:{'thread-id':'new-auto-thread'},
    body:JSON.stringify({model:'gpt-6.1-sol',input:'fresh text'})});
  expect((await pool.select(req,new AbortController().signal)).accountId).toBe('a');
  expect(reads).toContain('b');
});
test('preferred account falls back before dispatch while strict account remains exact',async()=>{
  const {pool,reads}=fixture();
  const req=request('preferred-p000002');
  expect((await pool.select(req,new AbortController().signal)).accountId).toBe('a');
  expect(pool.preparedBody(req)).toMatchObject({model:'gpt-6.1-sol',reasoning:{effort:'high'}});
  expect(reads).toContain('b');
  completeFixture(pool,req);
  await expect(pool.select(request('p000002',{},'strict-independent'),new AbortController().signal)).rejects.toThrow('window_threshold');
});
test('round robin cannot rotate an eligible preferred account out of first place',async()=>{
  const {pool,config}=fixture({allEligible:true,active:'a'});
  config.accountPoolStrategy='round-robin';
  expect((await pool.select(request('preferred-p000001'),new AbortController().signal)).accountId).toBe('a');
});
test('fresh A1 unpin removes only the local pin while preserving active choice and accepted issuer',async()=>{
  const {pool,home,config}=fixture({allEligible:true});
  const first=request('p000001');
  await pool.select(first,new AbortController().signal);
  completeFixture(pool,first);
  delete config.activeCodexAccountPinned;
  await pool.owner.refreshSnapshot(true);
  const later=request('preferred-p000002');
  expect((await pool.select(later,new AbortController().signal)).accountId).toBe('a');
  const local=JSON.parse(readFileSync(join(home,'config.json'),'utf8'));
  expect(Object.hasOwn(local,'activeCodexAccountPinned')).toBe(false);
  expect(local.activeCodexAccountId).toBe('b');
  expect(pool.activeAccount()).toBe('b');
  expect(pool.describeActive().pinMirrorStatus).toBe('unpin_reconciled');
});
test('an invalid local config is not overwritten and does not interrupt safe admission',async()=>{
  const {pool,home,config}=fixture();
  delete config.activeCodexAccountPinned;
  writeFileSync(join(home,'config.json'),'{invalid local config');
  expect((await pool.select(request('preferred-p000001'),new AbortController().signal)).accountId).toBe('a');
  expect(readFileSync(join(home,'config.json'),'utf8')).toBe('{invalid local config');
  expect(pool.describeActive().pinMirrorStatus).toBe('sync_failed');
});
test('an accepted preferred conversation stays with its issuer, including a later different preference',async()=>{
  const {pool}=fixture();const first=request('preferred-p000002');
  const lease=await pool.select(first,new AbortController().signal);
  completeFixture(pool,first);
  const later=request('preferred-p000001');
  expect((await pool.select(later,new AbortController().signal)).accountId).toBe(lease.accountId);
});
test('1 and 2 above 97 percent do not block 3 or 4 for new automatic and preferred requests',async()=>{
  const home=mkdtempSync(join(tmpdir(),'aicc-four-account-pool-'));
  const accounts=['a','b','c','d'].map((id,index)=>({id,alias:`${index+1}번(fixture${index+1})`,logLabel:`p00000${index+1}`}));
  const config:any={codexAccounts:accounts,codexAccountNamespaces:{p000001:'a',p000002:'b',p000003:'c',p000004:'d'},
    activeCodexAccountPinned:'b',activeCodexAccountId:'b',pausedCodexAccountIds:[],
    codexAccountPriorities:{a:1,b:2,c:3,d:4},accountPoolStrategy:'reset-first'};
  writeFileSync(join(home,'config.json'),JSON.stringify(config));
  const quotas:any={a:97,b:98,c:0,d:61};const observed:string[]=[];
  globalThis.fetch=(async(_url:any,init:any)=>{
    const id=new Headers(init.headers).get('chatgpt-account-id')!;observed.push(id);
    if(String(_url).includes('/wham/usage'))return Response.json({shortPercent:quotas[id],weeklyPercent:0});
    if(String(_url).includes('/codex/models?'))return Response.json({models:[model]});
    throw Error('no inference dispatch in fixture');
  }) as any;
  const records=Object.fromEntries(accounts.map(row=>[row.id,{generation:1}]));
  const pool=createExternalPoolState({home,clientVersion:'0.163.0',supplier:{readBody:r=>r.json(),parseQuota:v=>v,
    collectCarriers:b=>({previousResponseId:b.previous_response_id,encryptedReasoning:b.encryptedReasoning,fileIds:b.fileIds}),
    resolveRoute:(_c,m)=>({modelId:m.includes('/')?m.split('/')[1]:m,
      accountId:m.startsWith('p000001/')?'a':m.startsWith('p000002/')?'b':undefined,provider:{}}),
    buildCatalog:(_c,rows)=>rows},transport:{request:async(d:any)=>d.action==='snapshot'
      ?{ok:true,config,records,settings:{schemaVersion:1,fiveHour:{usedThreshold:97,action:'stop'},longWindow:{usedThreshold:97,action:'stop'}}}
      :{ok:true,accessToken:'fixture-'+d.id,chatgptAccountId:d.id,generation:1,expiresAt:Date.now()+120000}}});
  const make=(name:string,slug:string,extra={})=>new Request('http://localhost/v1/responses',{method:'POST',
    headers:{'thread-id':name},body:JSON.stringify({model:slug,input:'fresh text',...extra})});
  const auto=make('auto-new','gpt-6.1-sol');expect((await pool.select(auto,new AbortController().signal)).accountId).toBe('d');
  const preferred=make('preferred-new','preferred-p000002/gpt-6.1-sol');
  expect((await pool.select(preferred,new AbortController().signal)).accountId).toBe('d');
  expect(observed).toContain('a');expect(observed).toContain('b');expect(observed).toContain('c');expect(observed).toContain('d');
  await expect(pool.select(make('strict-new','p000002/gpt-6.1-sol'),new AbortController().signal))
    .rejects.toThrow('window_threshold');
  // G1-04 (2026-10-31): ciphertext-only carriers on a new thread are stripped by the existing
  // account-change scrubber. This fixture supplier has none, so it fails closed before dispatch.
  await expect(pool.select(make('encrypted-new','preferred-p000002/gpt-6.1-sol',{encryptedReasoning:'ciphertext'}),new AbortController().signal))
    .rejects.toThrow('account_change_scrubber_unavailable');
  await expect(pool.select(make('file-new','preferred-p000002/gpt-6.1-sol',{fileIds:['file-1']}),new AbortController().signal))
    .rejects.toThrow('account_scoped_input_owner_unknown');
});
test('ambiguous A1 account numbers omit both bound rows without removing stock models',async()=>{
  const {pool,config}=fixture();
  config.codexAccounts[1].alias='01번(duplicate-number)';
  const rows=await pool.catalog();
  expect(rows.map(row=>row.slug)).toEqual(['gpt-6.1-sol']);
});
test('an active reservation blocks a second same-thread request until explicit completed settlement',async()=>{
  const {pool}=fixture();const first=request();await pool.select(first,new AbortController().signal);
  await expect(pool.select(request(),new AbortController().signal)).rejects.toThrow('conversation_request_active');
  completeFixture(pool,first);
  const later=request();expect((await pool.select(later,new AbortController().signal)).accountId).toBe('a');
  pool.noteSettlement(later,'not_sent');
});
test('unknown preserves evidence and stops only an identical replay, allowing the next instruction',async()=>{
  const {pool,home}=fixture();const first=request();await pool.select(first,new AbortController().signal);
  pool.beforeDispatch(first);pool.noteSettlement(first,'unknown');
  expect(pool.unknownTurns()).toBe(1);
  await expect(pool.select(request(),new AbortController().signal)).rejects.toThrow('request_outcome_unknown');
  const next=request('p000001',{input:'new caller instruction'});
  expect((await pool.select(next,new AbortController().signal)).accountId).toBe('a');
  expect(pool.unknownTurns()).toBe(1);
  expect(JSON.parse(readFileSync(join(home,'external-request-history.jsonl'),'utf8')).originalRequestReplayed).toBe(false);
  pool.noteSettlement(next,'completed');
  expect(pool.unknownTurns()).toBe(1);
});
test('an interrupted issuer may migrate a new instruction through the existing account scrubber',async()=>{
  const scrubbed:any[]=[];
  const {pool,config}=fixture({allEligible:true,scrub:async(body:any)=>{scrubbed.push(body);return {...body,input:'portable next'};}});
  const first=request();await pool.select(first,new AbortController().signal);
  pool.beforeDispatch(first);pool.noteSettlement(first,'unknown');
  config.pausedCodexAccountIds=['a'];
  const next=request('preferred-p000002',{model:'gpt-6.1-sol',input:'new instruction'});
  expect((await pool.select(next,new AbortController().signal)).accountId).toBe('b');
  expect(scrubbed.length).toBe(1);expect(pool.preparedBody(next).input).toBe('portable next');
  completeFixture(pool,next);expect(pool.unknownTurns()).toBe(1);
});

test('not-sent settlement releases reservation without inventing a physical issuer',async()=>{
  const {pool}=fixture({allEligible:true});const first=request();await pool.select(first,new AbortController().signal);
  pool.noteSettlement(first,'not_sent');
  const later=request('p000002');expect((await pool.select(later,new AbortController().signal)).accountId).toBe('b');
  pool.noteSettlement(later,'not_sent');
});
test('G1-04 new thread with ciphertext-only carriers is scrubbed and bound as portable plaintext',async()=>{
  const scrubbed:any[]=[];
  const {pool}=fixture({allEligible:true,scrub:async(body:any)=>{scrubbed.push(body);const {encryptedReasoning,...rest}=body;return rest;}});
  const child=()=>new Request('http://localhost/v1/responses',{method:'POST',headers:{'thread-id':'child-fixture'},
    body:JSON.stringify({model:'p000001/gpt-6.1-sol',input:'fixture',encryptedReasoning:'ciphertext'})});
  const req=child();
  expect((await pool.select(req,new AbortController().signal)).accountId).toBe('a');
  expect(scrubbed.length).toBe(1);expect(pool.preparedBody(req).encryptedReasoning).toBeUndefined();
  completeFixture(pool,req);
  // The completed child is bound as portable history, so its next request is scrubbed again.
  const next=child();await pool.select(next,new AbortController().signal);expect(scrubbed.length).toBe(2);
  pool.noteSettlement(next,'not_sent');
  // Without a scrubber the same shape fails closed before any lease or dispatch.
  const {pool:bare}=fixture({allEligible:true});
  await expect(bare.select(child(),new AbortController().signal)).rejects.toThrow('account_change_scrubber_unavailable');
  // Server-side carriers stay refused regardless of scrubber availability.
  const linked=new Request('http://localhost/v1/responses',{method:'POST',headers:{'thread-id':'child-linked'},
    body:JSON.stringify({model:'p000001/gpt-6.1-sol',input:'fixture',previous_response_id:'resp_fixture_parent'})});
  await expect(pool.select(linked,new AbortController().signal)).rejects.toThrow('account_scoped_input_owner_unknown');
});
