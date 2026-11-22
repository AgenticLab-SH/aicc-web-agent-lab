import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {normalizeResetCredits,inspectResetCredits} from '../tools/platform/windows/tray-status.mjs';

const start=Date.parse('2026-10-11T00:00:00Z');
const dto={available_count:2,credits:[
  {granted_at:'2026-10-09T10:00:00Z',expires_at:'2026-10-13T10:00:00Z'},
  {granted_at:'2026-10-09T10:00:00Z',expires_at:'2026-10-11T10:00:00Z'}
]};
test('OCX credit inventory sorts by expiry and shows only real server dates',()=>{
 const result=normalizeResetCredits(dto,start);
 assert.equal(result.terminal,'PASS');
 assert.equal(result.availableCount,2);
 assert.equal(result.credits.length,2);
 assert.equal(result.credits[0].expiresAt,'2026-10-11T10:00:00.000Z');
 assert.equal(result.credits[1].usable,true);
 assert.equal(result.serverPicksCredit,true);
 assert.equal(normalizeResetCredits(dto,Date.parse('2026-10-14T10:00:00Z')).credits[1].usable,false);
});
test('malformed or unverified lists cannot enable consumption',()=>{
 for(const payload of [null,{}, {credits:[] ,available_count:-2},
  {credits:[{granted_at:'n/a',expires_at:'not-date'}],available_count:1},
  {credits:[{granted_at:'2026-10-11T00:00:00Z',expires_at:'2026-10-09T00:00:00Z'}],available_count:1}
 ])assert.equal(normalizeResetCredits(payload,start).terminal,'HOLD');
 assert.equal(normalizeResetCredits({credits:[]},start).availableCount,null);
});
test('only expected selector and identity can inspect authenticated reset credits',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-credit-fixture-'));
 const dataDir=path.join(tmp,'runtime','ocx-local');
 const home=path.join(dataDir,'demo');
 const configPath=path.join(home,'config.json'),tokenPath=path.join(home,'admin-api-token'),markerPath=path.join(dataDir,'current.json');
 fs.mkdirSync(home,{recursive:true});
 const accountId='fixture-account-id-001';
 const hash=createHash('sha256').update(accountId).digest('hex');
 fs.writeFileSync(configPath,JSON.stringify({codexAccountNamespaces:{'A1':accountId}}));
 fs.writeFileSync(tokenPath,'fixture-token-should-never-be-returned');
 fs.writeFileSync(markerPath,JSON.stringify({opencodexHome:home}));
 let calls=0;
 const fetcher=async(url,init)=>{
   calls++;
   assert.match(url,/^http:\/\/127\.0\.0\.1:10100\/api\/codex-auth\/reset-credits\?accountId=/);
   assert.equal(init.method,undefined);
   assert.equal(init.headers.Authorization,'Bearer fixture-token-should-never-be-returned');
   return {ok:true,json:async()=>dto};
 };
 try{
   const wrong=await inspectResetCredits('A1','a'.repeat(64),{stateRoot:tmp,fetcher,now:start});
   assert.equal(wrong.terminal,'HOLD');
   assert.equal(calls,0);
   assert.equal(wrong.reason,'account_identity_changed');
   const good=await inspectResetCredits('A1',hash,{stateRoot:tmp,fetcher,now:start});
   assert.equal(good.terminal,'PASS');
   assert.equal(good.availableCount,2);
   assert.equal(calls,1);
   const unavailable=await inspectResetCredits('A1',hash,{stateRoot:tmp,fetcher:async()=>{throw Error('fixture timeout');}});
   assert.equal(unavailable.terminal,'HOLD');assert.equal(unavailable.reason,'credit_lookup_unavailable');
   const rejected=await inspectResetCredits('A1',hash,{stateRoot:tmp,fetcher:async()=>({ok:false,status:403}),ownerLookup:async()=>{throw Error('must not call owner');}});
   assert.equal(rejected.terminal,'HOLD');assert.equal(rejected.reason,'credit_lookup_unavailable');
   const resultText=JSON.stringify(good);
   assert.ok(!resultText.includes(accountId));
   assert.ok(!resultText.includes('fixture-token-should-never-be-returned'));
   assert.equal((await inspectResetCredits('!invalid!',hash,{stateRoot:tmp,fetcher})).terminal,'HOLD');
   assert.equal(calls,1);
 }finally{
   for(const file of [configPath,tokenPath,markerPath])fs.unlinkSync(file);
   for(const dir of [home,dataDir,path.join(tmp,'runtime'),tmp])fs.rmdirSync(dir);
 }
});

test('a 404 on the Windows external proxy uses only the A1 owner read path and rejects mismatched identity',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-reset-404-'));
  const data=path.join(tmp,'runtime','ocx-local');
  const home=path.join(data,'fixture');fs.mkdirSync(home,{recursive:true});
  const id='fixture-physical-id-404';
  const hash=createHash('sha256').update(id).digest('hex');
  const config=path.join(home,'config.json'),token=path.join(home,'admin-api-token'),registry=path.join(data,'current.json');
  fs.writeFileSync(registry,JSON.stringify({opencodexHome:home}));
  fs.writeFileSync(config,JSON.stringify({codexAccountNamespaces:{A1:id}}));
  fs.writeFileSync(token,'fixture-read-only-token');
  let called=0;
  try{
    const fetcher=async()=>({ok:false,status:404});
    const lookup=async()=>{called++;return {terminal:'PASS',selector:'A1',identityHash:hash,remoteMutation:false,available_count:2,credits:dto.credits};};
    const good=await inspectResetCredits('A1',hash,{stateRoot:tmp,fetcher,ownerLookup:lookup,now:start});
    assert.equal(good.terminal,'PASS');
    assert.equal(good.availableCount,2);
    assert.equal(called,1);
    const wrong=await inspectResetCredits('A1',hash,{stateRoot:tmp,fetcher,ownerLookup:async()=>({...await lookup(),identityHash:'a'.repeat(64)}),now:start});
    assert.equal(wrong.terminal,'HOLD');
    assert.equal(wrong.reason,'owner_credit_inventory_unavailable');
    const unauthorized=await inspectResetCredits('A1','b'.repeat(64),{stateRoot:tmp,fetcher,ownerLookup:lookup});
    assert.equal(unauthorized.terminal,'HOLD');
    assert.equal(called,2);
  }finally{
    for(const f of [registry,config,token])fs.unlinkSync(f);
    for(const dir of [home,data,path.join(tmp,'runtime'),tmp])fs.rmdirSync(dir);
  }
});

test('Windows OCX owner wrapper repairs only process-local ProgramData before SSH',()=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const source=fs.readFileSync(path.join(root,'tools/platform/opencodex/Invoke-AiccOcxHubAccounts.ps1'),'utf8');
 assert.match(source,/IsNullOrWhiteSpace\(\$env:ProgramData\)/);
 assert.match(source,/GetFolderPath\(\[Environment\+SpecialFolder\]::CommonApplicationData\)/);
 assert.match(source,/Test-Path -LiteralPath \$commonData -PathType Container/);
 assert.match(source,/\$env:ProgramData = \$commonData/);
 assert.ok(source.indexOf('$env:ProgramData = $commonData')<source.indexOf('Get-Content -Raw -LiteralPath $source | ssh'));
 assert.doesNotMatch(source,/SetEnvironmentVariable\s*\(|setx(?:\.exe)?\b|New-ItemProperty.*ProgramData/);
 assert.match(source,/if\(\$Action -eq 'credits' -and \(\$Commit/);
});
