import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.env.AICC_OCX_PACKAGE_ROOT;
if(!root || process.env.AICC_OCX_WINDOW_THRESHOLDS !== '95,98') throw Error('Exact candidate policy required');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-ocx-admission-fixture-'));
process.env.OPENCODEX_HOME=path.join(temporary,'ocx');
process.env.CODEX_HOME=path.join(temporary,'codex');
fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});
const load=relative=>import(pathToFileURL(path.join(root,relative)).href);
const checks=[];
let networkFailure=false, inferenceAttempts=0;
const percentages=new Map();
globalThis.fetch=async(url, init)=>{
  const pathname=new URL(typeof url==='string'?url:url.url??String(url)).pathname;
  if(!pathname.endsWith('/wham/usage')) { inferenceAttempts++; throw Error('Inference forbidden in fixture'); }
  if(networkFailure) throw Error('Synthetic quota network failure');
  const id=new Headers(init?.headers).get('ChatGPT-Account-Id');
  const [short,long]=percentages.get(id)??[0,0];
  return Response.json({plan_type:'plus',rate_limit:{allowed:true,primary_window:{used_percent:short,reset_at:Math.floor(Date.now()/1000)+18000,limit_window_seconds:18000},secondary_window:{used_percent:long,reset_at:Math.floor(Date.now()/1000)+604800,limit_window_seconds:604800}}});
};
try {
  const {loadConfig,saveConfig}=await load('src/config.ts');
  const {saveCodexAccountCredential}=await load('src/codex/account-store.ts');
  const {resolveCodexAuthContext,CodexAccountCooldownError}=await load('src/codex/auth-context.ts');
  const config=loadConfig(), active='fixture-active',safe='fixture-safe';
  config.codexAccounts=[active,safe].map(id=>({id,email:`${id}@example.invalid`,isMain:false,plan:'plus'}));
  config.autoSwitchThreshold=95;config.accountPoolStrategy='reset-first';config.activeCodexAccountId=active;
  config.pool={...config.pool,cacheAffinity:false};saveConfig(config);
  for(const id of [active,safe])saveCodexAccountCredential(id,{accessToken:'fixture-only',refreshToken:'fixture-only',expiresAt:Date.now()+3600000,chatgptAccountId:id});
  percentages.set(active,[94,97]);percentages.set(safe,[10,10]);
  const headers=new Headers({'session_id':'aicc-owned-fixture'});
  const resolve=(options={})=>resolveCodexAuthContext(headers,config,'pool',{isMainAccountTokenLive:()=>false,...options});
  const blocked=async(name,options={})=>{await assert.rejects(()=>resolve(options),error=>error instanceof CodexAccountCooldownError);checks.push(name);};
  const initial=await resolve({accountId:active});assert.equal(initial.accountId,active);checks.push('explicit-94-97-fresh-admitted');
  percentages.set(safe,[96,10]);
  assert.equal((await resolve()).accountId,active);checks.push('existing-thread-bound-below-threshold');
  percentages.set(safe,[10,10]);
  percentages.set(active,[95,97]);await blocked('explicit-95-blocked-before-inference',{accountId:active});
  const rotated=await resolve();assert.equal(rotated.accountId,safe);checks.push('pool-95-rotates-to-fresh-safe');
  config.activeCodexAccountPinned=active;config.codexAccountAutoSwitchThresholds={[active]:100};
  await blocked('pin-and-override-cannot-bypass-strict-95',{accountId:active});
  delete config.activeCodexAccountPinned;delete config.codexAccountAutoSwitchThresholds;
  config.pausedCodexAccountIds=[safe];await blocked('no-available-replacement-blocks');delete config.pausedCodexAccountIds;
  percentages.set(safe,[95,10]);await blocked('all-95-blocked-before-inference');
  percentages.set(active,[0,98]);await blocked('explicit-weekly-98-blocked',{accountId:active});
  percentages.set(active,[0,10]);percentages.set(safe,[0,10]);networkFailure=true;
  await blocked('failed-refresh-old-cache-blocked',{accountId:active});
  assert.equal(inferenceAttempts,0);checks.push('zero-inference-dispatches');
  const dynamicChecks=[];
  if(fs.existsSync(path.join(root,'src/codex/routing/aicc-window-settings.ts'))){
    networkFailure=false;
    const settingsFile=path.join(process.env.OPENCODEX_HOME,'aicc-window-policy.json');
    let sequence=0;
    const scenario=async(name,short,long,shortAction,longAction,expected)=>{
      const original=`dynamic-original-${++sequence}`,replacement=`dynamic-safe-${sequence}`;
      config.codexAccounts=[original,replacement].map(id=>({id,email:`${id}@example.invalid`,isMain:false,plan:'plus'}));
      config.activeCodexAccountId=original;delete config.activeCodexAccountPinned;delete config.pausedCodexAccountIds;delete config.codexAccountAutoSwitchThresholds;
      saveConfig(config);
      fs.writeFileSync(settingsFile,JSON.stringify({schemaVersion:1,fiveHour:{usedThreshold:80,action:shortAction},longWindow:{usedThreshold:70,action:longAction}}));
      for(const id of [original,replacement])saveCodexAccountCredential(id,{accessToken:'fixture-only',refreshToken:'fixture-only',expiresAt:Date.now()+3600000,chatgptAccountId:id});
      percentages.set(original,[short,long]);percentages.set(replacement,[10,10]);
      if(expected==='blocked')await assert.rejects(()=>resolve(),error=>error instanceof CodexAccountCooldownError);
      else assert.equal((await resolve(expected==='original'?{accountId:original}:{})).accountId,expected==='original'?original:replacement);
      dynamicChecks.push(name);
    };
    await scenario('independent-79-69-admitted',79,69,'switch','switch','original');
    await scenario('five-hour-80-switches',80,69,'switch','stop','replacement');
    await scenario('weekly-70-switches',79,70,'stop','switch','replacement');
    await scenario('five-hour-80-stops-with-safe-replacement',80,69,'stop','switch','blocked');
    await scenario('weekly-70-stops-with-safe-replacement',79,70,'switch','stop','blocked');
    await scenario('either-stop-wins-at-both-thresholds',80,70,'switch','stop','blocked');
    fs.writeFileSync(settingsFile,JSON.stringify({schemaVersion:1,fiveHour:{usedThreshold:0,action:'switch'},longWindow:{usedThreshold:70,action:'switch'}}));
    await assert.rejects(()=>resolve());dynamicChecks.push('invalid-settings-fail-closed');
    assert.equal(inferenceAttempts,0);dynamicChecks.push('dynamic-zero-inference-dispatches');
  }
  console.log(JSON.stringify({terminal:'PASS_ADMISSION',checks,dynamicChecks,inferenceAttempts,liveAccountsChanged:false}));
} finally {
  if(path.dirname(path.resolve(temporary))!==path.resolve(os.tmpdir())||!path.basename(temporary).startsWith('aicc-ocx-admission-fixture-'))throw Error('Cleanup boundary');
  fs.rmSync(temporary,{recursive:true,force:true});
}
