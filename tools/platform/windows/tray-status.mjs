import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {resolveRuntimeLayout,insideDirectory} from '../../../src/runtime-layout.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
// The Chrome native host owns the queue. The tray only consumes its bounded,
// source-free projection and never creates a second sender or queue ledger.
export async function readWebQueueStatus(options={}){
  const unavailable=reason=>({schemaVersion:1,state:'unavailable',reason,status:'개발 큐 확인 필요'});
  try{
    const local=options.localAppData??process.env.LOCALAPPDATA;
    if(!local||!path.isAbsolute(local))return unavailable('config_missing');
    const configFile=path.join(local,'AICC','native-hosts','webgpt-queue','native-host.config.json');
    const regular=file=>{
      const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('unsafe');
      for(let dir=path.dirname(file);;dir=path.dirname(dir)){
        if(fs.lstatSync(dir).isSymbolicLink())throw Error('linked');
        if(path.dirname(dir)===dir)break;
      }
    };
    regular(configFile);
    const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
    if(typeof config.sourceDirectory!=='string'||!path.isAbsolute(config.sourceDirectory))return unavailable('source_unregistered');
    const script=path.join(config.sourceDirectory,'scripts','aicc-status.mjs');regular(script);
    const result=await (options.runner??runHidden)(process.execPath,[script,'--tray-details'],4000);
    const keys=['runs','active','paused','completed','failed','cancelled','unknown','readyRoles','runningRoles'];
    if(result?.schemaVersion!==1||!['ready','unavailable','invalid'].includes(result.state))return unavailable('projection_invalid');
    const counts={};
    for(const key of keys){const value=result.counts?.[key];if(!Number.isSafeInteger(value)||value<0||value>1000000)return unavailable('counts_invalid');counts[key]=value;}
    // The exact native ledger remains the only owner. Reject untrusted or
    // arbitrary fields from the source projection before WinForms sees them.
    let items=[];
    if(result.items!==undefined){
      if(!Array.isArray(result.items)||result.items.length>5||typeof result.itemsTruncated!=='boolean')return unavailable('details_invalid');
      for(const v of result.items){
        if(!v||Object.keys(v).sort().join('|')!==['control','reason','roles','runRef','status','targetRef','targetState'].sort().join('|')||
          typeof v.runRef!=='string'||!/^[a-f0-9]{12}$/.test(v.runRef)||
          !(v.targetRef===null||typeof v.targetRef==='string'&&/^[a-f0-9]{12}$/.test(v.targetRef))||
          !['running','paused','completed','failed','cancelled','unknown'].includes(v.status)||
          !['RECORDED_UNVERIFIED','NO_VERIFIED_CONVERSATION'].includes(v.targetState)||
          !['SUBMISSION_UNCERTAIN','ROLE_FAILED','RUN_FAILED','PAUSED','NONE'].includes(v.reason)||
          !Number.isSafeInteger(v.roles)||v.roles<2||v.roles>12||v.control!=='CHROME_QUEUE_EXTENSION_ONLY')
          return unavailable('details_invalid');
        items.push({runRef:v.runRef,status:v.status,targetRef:v.targetRef,targetState:v.targetState,roles:v.roles,reason:v.reason,control:v.control});
      }
    }
    const state=result.state;
    return {schemaVersion:1,state,observedAt:result.observedAt,counts,items,
      itemsTruncated:result.itemsTruncated===true,controls:'CHROME_QUEUE_EXTENSION_ONLY',
      status:state==='ready'?`진행 ${counts.active} · 대기 ${counts.paused} · 완료 ${counts.completed} · 취소 ${counts.cancelled} · 확인 ${counts.failed+counts.unknown}`:'개발 큐 확인 필요'};
  }catch{return unavailable('projection_unavailable');}
}
export function parseHiddenJson(stdout,code,overflow=false,acceptNonzero=null){
  if(overflow)return null;
  try{
    const value=JSON.parse(stdout);
    return code===0||code===1&&acceptNonzero?.(value)===true?value:null;
  }catch{return null;}
}
export function isWorkspaceStatus(value){
  return value?.id==='workspace-mcp'&&['ready','attention','unavailable'].includes(value.state);
}
const acceptWorkspaceAttention=value=>isWorkspaceStatus(value)&&value.state!=='ready';
export function runHidden(command,args,timeout=70000,killOnTimeout=true,acceptNonzero=null){
  return new Promise(resolve=>{
    const child=spawn(command,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']});
    let stdout='',overflow=false;
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>1048576){overflow=true;child.kill();}});
    const timer=setTimeout(()=>{if(killOnTimeout)child.kill();resolve(null);},timeout);
    child.once('error',()=>{clearTimeout(timer);resolve(null);});
    child.once('close',code=>{clearTimeout(timer);resolve(parseHiddenJson(stdout,code,overflow,acceptNonzero));});
  });
}
async function http(url,headers,timeout=1500){try{const r=await fetch(url,{headers,signal:AbortSignal.timeout(timeout)});return r.ok?await r.json():null;}catch{return null;}}
export function createStatusMemo(now=Date.now){
  const entries=new Map();
  return {get:key=>entries.get(key),expire(prefix){for(const [key,value] of entries)if(key.startsWith(prefix))entries.set(key,{...value,at:-Infinity});},async read(key,ttl,read,force=false){
    const previous=entries.get(key);
    if(!force&&previous&&now()-previous.at<ttl)return previous.value;
    let value;try{value=await read();}catch{value=null;}
    const retained=value??(key.startsWith('pool:')?previous?.value:null);
    entries.set(key,{at:now(),value:retained,failed:value==null});return retained;
  }};
}
// Retry failed Web reads at most once per display interval; never retain ready on failure.
export function createFailureBackoff(now=Date.now){
  const failures=new Map(),pending=new Map();
  return {async read(key,delay,read,force=false){
    if(pending.has(key))return pending.get(key);
    if(!force&&failures.has(key)&&now()-failures.get(key)<delay)return null;
    const request=Promise.resolve().then(read).catch(()=>null).then(value=>{
      if(value==null)failures.set(key,now());else failures.delete(key);
      return value;
    }).finally(()=>pending.delete(key));
    pending.set(key,request);return request;
  }};
}
const webFailureBackoff=createFailureBackoff();
const statusMemo=createStatusMemo();
const memoStatus=(...args)=>statusMemo.read(...args);

// Keep a manual refresh queued until its cooldown expires, rather than dropping it.
export function createRefreshSchedule(now=Date.now){
  let pending=true,lastRefresh=null;
  return {request(){pending=true;},retryMs(){return pending&&lastRefresh!==null?Math.max(0,30000-(now()-lastRefresh)):null;},
    take(){
      const retry=this.retryMs();
      if(pending&&(retry===null||retry===0)){pending=false;lastRefresh=now();return {refresh:true,refreshState:'requested',refreshRetryAfterSeconds:0};}
      return {refresh:false,refreshState:pending?'deferred':'cached',refreshRetryAfterSeconds:pending?Math.ceil(retry/1000):0};
    }};
}
export function quotaObservation(accounts,now=Date.now()){
  const times=(accounts??[]).map(row=>row.quota?.updatedAt).filter(value=>Number.isFinite(value)&&value>0&&value<=now);
  return {quotaObservedAt:times.length?new Date(Math.max(...times)).toISOString():null,
    quotaOldestObservedAt:times.length?new Date(Math.min(...times)).toISOString():null,
    quotaAgeSeconds:times.length?Math.floor((now-Math.min(...times))/1000):null};
}
async function localPoolStatus(stateRoot,refresh=false){
  try{
    const registry=JSON.parse(fs.readFileSync(path.join(stateRoot,'runtime/ocx-local/current.json'),'utf8'));
    const config=JSON.parse(fs.readFileSync(path.join(registry.opencodexHome,'config.json'),'utf8'));
    const token=fs.readFileSync(path.join(registry.opencodexHome,'admin-api-token'),'utf8').trim();
    // Only startup/open/manual refresh requests bypass upstream cache; never the 3s display tick.
    const payload=await memoStatus('pool:'+registry.opencodexHome,60000,()=>http('http://127.0.0.1:10100/api/codex-auth/accounts'+(refresh?'?refresh=1':''),{Authorization:'Bearer '+token},refresh?8000:4000),refresh);
    if(!Array.isArray(payload?.accounts))return {terminal:'FAIL'};
    const selectors=new Map(Object.entries(config.codexAccountNamespaces??{}).filter(([key])=>key!=='main').map(([key,id])=>[id,key]));
    const metadata=new Map((config.codexAccounts??[]).map(row=>[row.id,row]));
    let disk;try{disk=JSON.parse(fs.readFileSync(path.join(registry.opencodexHome,'codex-quota-cache.json'),'utf8'));}catch{}
    return {terminal:'PASS',quotaSource:'local-cache',quotaReadFailed:statusMemo.get('pool:'+registry.opencodexHome)?.failed===true,accounts:payload.accounts.filter(row=>!row.isMain&&selectors.has(row.id)).map(row=>{
      const stored=disk?.version===1?disk.quotas?.[row.id]:null;
      const quota=!registry.adapterManifest&&!row.needsReauth&&!row.quotaError&&stored&&Number.isFinite(stored.updatedAt)&&stored.updatedAt>=(row.quota?.updatedAt??0)&&stored.updatedAt<=Date.now()&&Date.now()-stored.updatedAt<=21600000?stored:row.quota;
      const account=metadata.get(row.id);
      const clean=value=>typeof value==='string'&&!/[\x00-\x1f\x7f]/.test(value)?value.trim().slice(0,80):'';
      const alias=clean(account?.alias??row.alias);
      const email=clean(account?.email??row.email);
      const name=alias||(/^[^\s*@]+@[^\s@]+$/.test(email)?email.split('@')[0]:'');
      return {selector:selectors.get(row.id),identityHash:createHash('sha256').update(row.id).digest('hex'),accountName:name||'이름 확인 필요',displayNameVerified:!!name,
        quotaProtectionEnabled:row.quotaProtectionEnabled,
        plan:clean(account?.plan??row.plan),active:false,paused:Array.isArray(config.pausedCodexAccountIds)?config.pausedCodexAccountIds.includes(row.id):row.paused===true,
        needsReauth:row.needsReauth===true,authState:row.authState??(row.needsReauth?'reauth_required':'unknown'),
        authReason:row.authReason??null,quotaError:row.quotaError??null,quotaRetryAt:row.quotaRetryAt??null,
        credentialOwner:registry.adapterManifest?'a1':null,credentialGeneration:row.credentialGeneration??null,priority:config.codexAccountPriorities?.[row.id]??row.priority??0,quota:quota??{}};
    })};
  }catch{return {terminal:'FAIL'};}
}
const kst=value=>Number.isFinite(value)&&value>0?new Date(value*1000).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'미확인';
const resetIso=value=>Number.isFinite(value)&&value>0&&value*1000<=8640000000000000?new Date(value*1000).toISOString():null;
export function projectTrayAccounts(payload){
  if(payload?.terminal!=='PASS'||!Array.isArray(payload.accounts))return [];
  return payload.accounts.map(row=>{
    const q=row.quota??{},percent=value=>Number.isFinite(value)&&value>=0&&value<=100?100-value:null;
    return {name:row.accountName||'이름 확인 필요',selector:row.selector,identityHash:row.identityHash,active:row.active===true,paused:row.paused===true,priority:row.priority??0,
      status:row.paused?'일시 중지':row.needsReauth?'로그인 필요':row.admission?.state==='blocked'?'한도 차단':row.quotaError?'조회 재시도':row.authState==='validation_pending'?'인증 확인 중':row.admission?.state==='unverified'?'확인 필요':row.localActiveUnknown?'선택 미확인':row.active?'사용 중':'대기',
      quotaProtectionEnabled:row.quotaProtectionEnabled,
      needsReauth:row.needsReauth===true,authState:row.authState??'unknown',
      authReason:row.authReason??null,quotaError:row.quotaError??null,quotaRetryAt:row.quotaRetryAt??null,
      recoveryHint:row.needsReauth?'서버에 다시 로그인하세요':row.authState==='validation_pending'?'로그인 완료 · 사용 권한 확인 대기':row.quotaError==='quota_access_denied'?'조회 접근 거절 · 서버 상태 확인':row.quotaError?'일시적 조회 오류 · 자동 재시도':null,
      shortRemaining:row.needsReauth?null:percent(q.shortPercent),longRemaining:row.needsReauth?null:percent(q.weeklyPercent??q.monthlyPercent),
      shortReset:q.shortWindowApplicable===false?'해당 없음':kst(q.shortResetAt),longReset:kst(q.weeklyResetAt??q.monthlyResetAt),
      shortResetAt:resetIso(q.shortResetAt),longResetAt:resetIso(q.weeklyResetAt??q.monthlyResetAt),resetTimeSource:'quota-observation',
      plan:row.plan??null,displayNameVerified:row.displayNameVerified??!!row.accountName,
      quotaObservedAt:Number.isFinite(q.updatedAt)&&q.updatedAt>0&&q.updatedAt<=Date.now()?new Date(q.updatedAt).toISOString():null,
      quotaAgeSeconds:Number.isFinite(q.updatedAt)&&q.updatedAt>0&&q.updatedAt<=Date.now()?Math.floor((Date.now()-q.updatedAt)/1000):null,
      longLabel:q.weeklyPercent!==undefined?'주간':q.monthlyPercent!==undefined?'월간':'장기',resetCredits:Number.isInteger(q.resetCredits)&&q.resetCredits>=0?q.resetCredits:null,fresh:payload.quotaSource==='live-refresh'};
  });
}
function controlNeedsReconcile(stateRoot){
  const directory=path.join(stateRoot,'status-tray','requests');
  try{
    for(const name of fs.readdirSync(directory).filter(name=>/^[a-f0-9]{32}\.json\.result\.json$/.test(name))){
      const file=path.join(directory,name),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)continue;
      const result=JSON.parse(fs.readFileSync(file,'utf8'));
      if(['DISPATCHING','UNCERTAIN'].includes(result.terminal)||['PASS','RECONCILED'].includes(result.terminal)&&result.localMetadataSynced===false)return true;
    }
  }catch{return fs.existsSync(directory);}
  return false;
}
export function activeCount(value){return Number.isInteger(value)&&value>=0?value:null;}
export function isOcxReady(probe){return (probe?.status==='ok'&&probe?.ready===true)||(probe?.status==='ready'&&probe?.ready!==false);}
export function connectionObservation(probe,ocx=false){
  if(!probe||typeof probe.status!=='string')return {ready:false,readOk:false,status:'조회 실패 · 연결 미확인'};
  const ready=ocx?isOcxReady(probe):probe.status==='ok';
  return {ready,readOk:true,status:ready?'연결됨':'점검 필요'};
}
export function browserObservation(port,probe){
  const known=typeof probe?.Browser==='string'&&probe.Browser.length>0;
  return {port,connected:known?true:null,readOk:known};
}
export function browserConnectionStatus(slots){
  const connected=slots.filter(slot=>slot.connected===true);
  const unknown=slots.some(slot=>slot.connected===null||slot.connected===undefined);
  if(connected.length)return connected.map(slot=>`${slot.port} 실행 중`).join(' · ')+(unknown?' · 일부 연결 미확인':'');
  return unknown?'연결 조회 실패 · 상태 미확인':'꺼짐 · 웹 작업 전에 실행 필요';
}
// Prefer the registered Workspace reader; keep CLI fallback for older registries.
export function resolveTrayStatusCli(layout,registry){
  const cli=registry?.components?.workspace??registry?.components?.cli;
  if(registry?.schemaVersion!==1||registry.root!==layout.root||
    typeof cli?.entry!=='string'||!path.isAbsolute(cli.entry)||
    typeof cli.runtime!=='string'||!path.isAbsolute(cli.runtime))return null;
  const entry=path.resolve(cli.entry);
  const registered=cli.location==='managed'&&insideDirectory(layout.releases,entry)||
    cli.location==='legacy-frozen'&&insideDirectory(layout.legacyReleaseRoot,entry);
  if(!registered||path.basename(entry)!=='aicc'||path.basename(path.dirname(entry))!=='bin')return null;
  return {entry,runtime:path.resolve(cli.runtime)};
}
// Keep the installed backend's existing identity checks; skip the unrelated CLI graph.
export const workspaceStatusReaderSource=`
try{
  const {workspaceMcpStatus,probeWorkspaceTunnel}=await import(process.argv[1]);
  // One slow/contended loopback probe must not freeze a false disconnected
  // status for the full display interval. Retry only this read, never an action.
  let tunnel=await probeWorkspaceTunnel({timeoutMs:6000});
  if(tunnel?.registered===true&&tunnel?.running===true&&tunnel?.ready!==true)
    tunnel=await probeWorkspaceTunnel({timeoutMs:6000});
  const result=tunnel?.ready===true
    ?await workspaceMcpStatus({tunnelProbe:async()=>tunnel})
    :{id:'workspace-mcp',state:'attention',serverReady:false,tunnel};
  console.log(JSON.stringify({id:result.id,state:result.state,serverReady:result.serverReady===true,
    tunnel:{ready:result.tunnel?.ready===true},remoteAuthority:{runtimeReady:result.remoteAuthority?.runtimeReady===true}}));
  if(result.state!=='ready')process.exitCode=1;
}catch{console.log('null');process.exitCode=1;}`;
export function readWorkspaceTrayStatus(cli,runner=runHidden){
  const moduleFile=path.join(path.dirname(path.dirname(cli.entry)),'src','workspace-mcp.mjs');
  // The registered identity reader can exceed 5s under Windows memory pressure.
  // Keep its safety checks intact and allow a bounded 20s collection budget.
  return runner(cli.runtime,['--input-type=module','-e',workspaceStatusReaderSource,pathToFileURL(moduleFile).href],20000,true,acceptWorkspaceAttention);
}
export function workspaceConnectionObservation(workspace,marker){
  if(!isWorkspaceStatus(workspace))return {ready:false,readFailed:true,
    status:marker?.phase==='starting'?'시작 중 · 연결 미확인':'상태 조회 실패 · 연결 미확인'};
  const ready=workspace.state==='ready'&&workspace.serverReady===true&&workspace.tunnel?.ready===true&&workspace.remoteAuthority?.runtimeReady!==false;
  return {ready,readFailed:false,status:ready?'연결됨':'점검 필요'};
}
function applyAccountAdmission(pool,policy){
  if(!policy||!Array.isArray(pool?.accounts))return;
  for(const row of pool.accounts){
    const q=row.quota??{},long=q.weeklyPercent??q.monthlyPercent;
    if(row.quotaProtectionEnabled!==false&&(Number.isFinite(q.shortPercent)&&q.shortPercent>=policy.fiveHourUsedThreshold||Number.isFinite(long)&&long>=policy.longWindowUsedThreshold))row.admission={state:'blocked'};
    else if((!(q.shortWindowApplicable===false&&q.shortPercent===undefined)&&(!Number.isFinite(q.shortPercent)||q.shortPercent<0||q.shortPercent>100))||!Number.isFinite(long)||long<0||long>100||!Number.isFinite(q.updatedAt)||q.updatedAt<=0||q.updatedAt>Date.now()||Date.now()-q.updatedAt>120000)row.admission={state:'unverified'};
  }
}
// Account management needs OCX, not a running tray, Workspace or browser.
// Full diagnostics remain explicit in collectTrayStatus below.
export async function collectTrayAccountStatus(options={}){
  const stateRoot=resolveRuntimeLayout().root,collectionStartedAt=new Date().toISOString();
  const [rawPool,active,ocx]=await Promise.all([
    localPoolStatus(stateRoot,options.refresh===true),
    memoStatus('active:'+stateRoot,15000,()=>localActiveStatus(stateRoot),options.refresh===true),
    memoStatus('ocx-health',15000,()=>http('http://127.0.0.1:10100/readyz'),options.refresh===true)
  ]);
  const pool=rawPool&&{...rawPool,accounts:rawPool.accounts?.map(row=>({...row}))};
  const policy=active?.configured?active.policy??null:pool?.effectivePolicy??null;
  applyAccountAdmission(pool,policy);
  const observation=quotaObservation(pool?.accounts),connection=connectionObservation(ocx,true);
  return {schemaVersion:1,snapshotPhase:'accounts-complete',diagnosticsPending:false,diagnosticsScope:'ocx-only',
    collectionStartedAt,observedAt:new Date().toISOString(),...observation,
    aiccReady:null,aiccStatus:'전체 진단에서 조회',webReady:null,webStatus:'전체 진단에서 조회',
    ocxReady:connection.ready,ocxStatus:connection.status,ocxReadFailed:!connection.readOk,ocxActiveTurns:activeCount(ocx?.activeTurns),
    accounts:projectTrayAccounts(localPoolView(pool,active)),selectionVerified:active?.configured?active.verified===true:pool?.terminal==='PASS',
    effectivePolicy:policy,quotaReadFailed:pool?.terminal!=='PASS'||pool?.quotaReadFailed===true,
    quotaFresh:pool?.quotaSource==='live-refresh',quotaSource:pool?.quotaSource??'unavailable',
    quotaStatus:pool?.terminal!=='PASS'?'OCX 조회 실패 · 마지막 관측을 확인하세요':policy?.strictAdmission&&policy?.freshQuotaRequired
      ?`로컬 적용 · 5시간 ${policy.fiveHourUsedThreshold}% / 주간 ${policy.longWindowUsedThreshold}% · 관측 ${observation.quotaAgeSeconds??'미확인'}초 전`
      :'OCX 계정 조회 · 차단 정책 미확인',controlNeedsReconcile:controlNeedsReconcile(stateRoot)};
}
export async function collectTrayStatus(options={}){
  const collectionStartedAt=new Date().toISOString();
  const layout=resolveRuntimeLayout(),stateRoot=layout.root;
  let marker;try{marker=JSON.parse(fs.readFileSync(path.join(stateRoot,'workspace-mcp/runtime/remote-authority-status.json'),'utf8'));}catch{}
  let statusCli;
  try{
    if(fs.lstatSync(layout.registry).isSymbolicLink())throw Error('linked_registry');
    statusCli=resolveTrayStatusCli(layout,JSON.parse(fs.readFileSync(layout.registry,'utf8')));
    if(statusCli&&[statusCli.entry,statusCli.runtime].some(file=>{const stat=fs.lstatSync(file);return !stat.isFile()||stat.isSymbolicLink();}))statusCli=null;
  }catch{statusCli=null;}
  // Start independent reads together. Account cards are published as soon as
  // pool/selection reads finish, without waiting for Workspace/Chrome probes.
  const poolJob=fs.existsSync(path.join(stateRoot,'runtime/ocx-local/current.json'))
    ?localPoolStatus(stateRoot,options.refresh===true)
    :runHidden('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(root,'tools/platform/opencodex/Invoke-AiccOcxHubAccounts.ps1'),'-Action',options.refresh===true?'refresh':'identity'],15000);
  const activeJob=memoStatus('active:'+stateRoot,15000,()=>localActiveStatus(stateRoot),options.refresh===true);
  const accountJob=Promise.all([poolJob,activeJob]);
  if(typeof options.onAccounts==='function')void accountJob.then(([pool,active])=>{
    const projected=localPoolView(pool&&{...pool,accounts:pool.accounts?.map(row=>({...row}))},active);
    if(Array.isArray(projected?.accounts))for(const row of projected.accounts)row.admission={state:'unverified'};
    options.onAccounts({schemaVersion:1,snapshotPhase:'accounts',diagnosticsPending:true,collectionStartedAt,
      observedAt:new Date().toISOString(),...quotaObservation(pool?.accounts),
      aiccReady:false,aiccStatus:'연결 확인 중',webReady:false,webStatus:'연결 확인 중',ocxReady:false,ocxStatus:'연결 확인 중',
      accounts:projectTrayAccounts(projected),effectivePolicy:active?.policy??pool?.effectivePolicy??null,
      selectionVerified:active?.verified===true,quotaReadFailed:pool?.terminal!=='PASS'||pool?.quotaReadFailed===true,
      controlNeedsReconcile:controlNeedsReconcile(stateRoot)});
  }).catch(()=>{});
  const [[pool,localActive],workspace,web,ocx,browsers,webQueue]=await Promise.all([
    accountJob,
    statusCli?memoStatus('workspace:'+statusCli.runtime+':'+statusCli.entry+':'+marker?.instanceId+':'+marker?.phase,60000,()=>readWorkspaceTrayStatus(statusCli),options.refresh===true):null,
    memoStatus('web-health',15000,()=>webFailureBackoff.read('web-health',30000,()=>http('http://127.0.0.1:17841/healthz'),options.refresh===true),options.refresh===true),
    memoStatus('ocx-health',15000,()=>http('http://127.0.0.1:10100/readyz'),options.refresh===true),
    Promise.all([9222,9223].map(async port=>browserObservation(port,await memoStatus('browser:'+port,60000,()=>http(`http://127.0.0.1:${port}/json/version`),options.refresh===true)))),
    memoStatus('web-queue',15000,()=>readWebQueueStatus(),options.refresh===true)
  ]);  const effectivePolicy=localActive?.configured?localActive.policy??null:pool?.effectivePolicy??null;
  applyAccountAdmission(pool,effectivePolicy);
  const policyDiffers=localActive?.configured&&effectivePolicy&&pool?.effectivePolicy&&
    ['fiveHourUsedThreshold','longWindowUsedThreshold','fiveHourAction','longWindowAction'].some(key=>effectivePolicy[key]!==pool.effectivePolicy[key]);
  let policyDeployment=null;
  try{
    const jobs=path.join(stateRoot,'jobs');
    for(const name of fs.readdirSync(jobs).filter(name=>/^ocx-dynamic-policy-[a-f0-9]{32}\.json$/.test(name)).sort()){
      const file=path.join(jobs,name);if(fs.lstatSync(file).isSymbolicLink())continue;
      const job=JSON.parse(fs.readFileSync(file,'utf8'));
      if(['QUEUED','WAITING_IDLE','DEPLOYING','UNCERTAIN','HOLD'].includes(job.state))policyDeployment={state:job.state,activeTurnCount:job.activeTurnCount??null,expiresAt:job.expiresAt};
    }
  }catch{}
  const observation=quotaObservation(pool?.accounts),quotaAgeSeconds=observation.quotaAgeSeconds;
  const workspaceConnection=workspaceConnectionObservation(workspace,marker),webConnection=connectionObservation(web),ocxConnection=connectionObservation(ocx,true);
  return {schemaVersion:1,snapshotPhase:'complete',diagnosticsPending:false,...observation,collectionStartedAt,observedAt:new Date().toISOString(),observedKst:new Date().toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}),
    aiccReady:workspaceConnection.ready,aiccReadFailed:workspaceConnection.readFailed,
    aiccStatus:workspaceConnection.status,
    webActiveTurns:activeCount(web?.active_http_turns),webBrowserTurns:activeCount(web?.active_browser_turns),ocxActiveTurns:activeCount(ocx?.activeTurns),
    webReady:webConnection.ready,webStatus:webConnection.status,webReadFailed:!webConnection.readOk,
    webBrowserStatus:browserConnectionStatus(browsers),webQueue,
    ocxReady:ocxConnection.ready,ocxStatus:ocxConnection.status,ocxReadFailed:!ocxConnection.readOk,
    accounts:projectTrayAccounts(localPoolView(pool,localActive)),selectionVerified:localActive?.configured?localActive.verified===true:pool?.terminal==='PASS',effectivePolicy,quotaStatus:pool?.terminal==='PASS'?(effectivePolicy?.strictAdmission===true&&effectivePolicy?.freshQuotaRequired===true?`${localActive?.configured?'로컬 적용':'캐시 조회'} · 5h ${effectivePolicy.fiveHourUsedThreshold}% / 주간 ${effectivePolicy.longWindowUsedThreshold}%${policyDiffers?' · 서버 설정 반영 대기':''} · 한도 캐시 ${quotaAgeSeconds===null?'시각 미확인':quotaAgeSeconds+'초 전'}`:'캐시 조회 · 로컬 차단 정책 미확인'):'조회 실패 · 한도 미확인',
    quotaFresh:pool?.quotaSource==='live-refresh',quotaReadFailed:pool?.terminal!=='PASS'||pool?.quotaReadFailed===true,quotaAgeSeconds,quotaSource:pool?.quotaSource??'unavailable',browserSlots:browsers,policyDeployment,controlNeedsReconcile:controlNeedsReconcile(stateRoot)};
}
async function localActiveStatus(stateRoot){
  const file=path.join(stateRoot,'runtime','ocx-local','current.json');
  if(!fs.existsSync(file))return null;
  try{
    const registry=JSON.parse(fs.readFileSync(file,'utf8'));
    const config=JSON.parse(fs.readFileSync(path.join(registry.opencodexHome,'config.json'),'utf8'));
    const token=fs.readFileSync(path.join(registry.opencodexHome,'admin-api-token'),'utf8').trim();
    const active=await http('http://127.0.0.1:10100/api/codex-auth/active',{Authorization:'Bearer '+token});
    let policy=null;
    if(registry.adapterManifest){
      // External OCX enforces A1-owned settings; the legacy local file is not its policy.
      const observed=await http('http://127.0.0.1:10100/api/aicc-local/policy',{Authorization:'Bearer '+token},4000);
      if(observed?.schemaVersion===1&&observed.version===registry.version&&observed.requestExecution==='windows-local'&&observed.credentialWriter==='a1'&&
        observed.settingsSupported===true&&observed.strictAdmission===true&&observed.freshQuotaRequired===true&&
        ['fiveHourUsedThreshold','longWindowUsedThreshold'].every(key=>Number.isInteger(observed[key])&&observed[key]>=1&&observed[key]<=100)&&
        ['fiveHourAction','longWindowAction'].every(key=>['switch','stop'].includes(observed[key]))){
        policy={version:observed.version,fiveHourUsedThreshold:observed.fiveHourUsedThreshold,longWindowUsedThreshold:observed.longWindowUsedThreshold,
          fiveHourAction:observed.fiveHourAction,longWindowAction:observed.longWindowAction,accountQuotaProtectionSupported:observed.accountQuotaProtectionSupported===true,settingsSupported:true,strictAdmission:true,freshQuotaRequired:true,scope:'Windows local pool requests only'};
      }
    }else try{
      const rules=JSON.parse(fs.readFileSync(path.join(registry.opencodexHome,'aicc-window-policy.json'),'utf8'));
      if(rules.schemaVersion===1&&['fiveHour','longWindow'].every(key=>Number.isInteger(rules[key]?.usedThreshold)&&rules[key].usedThreshold>=1&&rules[key].usedThreshold<=100&&['switch','stop'].includes(rules[key]?.action))){
        const supported=['2.77.0-aicc.local.2','2.77.0-aicc.local.3'].includes(registry.version);
        policy={version:registry.version,fiveHourUsedThreshold:rules.fiveHour.usedThreshold,longWindowUsedThreshold:rules.longWindow.usedThreshold,
          fiveHourAction:rules.fiveHour.action,longWindowAction:rules.longWindow.action,settingsSupported:supported,strictAdmission:supported,freshQuotaRequired:supported,scope:'Windows local pool requests only'};
      }
    }catch{}
    return {configured:true,namespaces:config.codexAccountNamespaces??{},verified:active!==null,accountId:active?.activeCodexAccountId,policy};
  }catch{return {configured:true,verified:false};}
}
export function normalizeResetCredits(input,now=Date.now()){
  if(!input||typeof input!=='object'||!Array.isArray(input.credits)||input.credits.length>48)
    return {terminal:'HOLD',reason:'credit_inventory_invalid'};
  const available=input.available_count;
  if(available!==undefined&&(!Number.isInteger(available)||available<0||available>1000))
    return {terminal:'HOLD',reason:'credit_count_invalid'};
  const entries=[];
  for(const raw of input.credits){
    if(!raw||typeof raw.granted_at!=='string'||typeof raw.expires_at!=='string')
      return {terminal:'HOLD',reason:'credit_date_missing'};
    const granted=Date.parse(raw.granted_at),expires=Date.parse(raw.expires_at);
    if(!Number.isFinite(granted)||!Number.isFinite(expires)||expires<=granted)
      return {terminal:'HOLD',reason:'credit_date_invalid'};
    entries.push({grantedAt:new Date(granted).toISOString(),expiresAt:new Date(expires).toISOString(),
      usable:expires>now});
  }
  entries.sort((a,b)=>a.expiresAt.localeCompare(b.expiresAt)||a.grantedAt.localeCompare(b.grantedAt));
  return {terminal:'PASS',availableCount:Number.isInteger(available)?available:null,credits:entries,
    observedAt:new Date(now).toISOString(),serverPicksCredit:true};
}
export async function inspectResetCredits(selector,identityHash,options={}){
  if(!/^[A-Za-z0-9._-]{1,64}$/.test(selector??'')||selector==='main'||!/^[a-f0-9]{64}$/.test(identityHash??''))
    return {terminal:'HOLD',reason:'account_identity_invalid'};
  const stateRoot=options.stateRoot??resolveRuntimeLayout().root;
  const doFetch=options.fetcher??fetch;
  try{
    const registryFile=path.join(stateRoot,'runtime','ocx-local','current.json');
    if(fs.lstatSync(registryFile).isSymbolicLink())throw Error('linked_registry');
    const registry=JSON.parse(fs.readFileSync(registryFile,'utf8'));
    const home=registry.opencodexHome;
    if(typeof home!=='string'||!insideDirectory(path.join(stateRoot,'runtime','ocx-local'),home))
      throw Error('unexpected_ocx_home');
    const configFile=path.join(home,'config.json'),secretFile=path.join(home,'admin-api-token');
    if(fs.lstatSync(configFile).isSymbolicLink()||fs.lstatSync(secretFile).isSymbolicLink()||!fs.lstatSync(secretFile).isFile())
      throw Error('linked_credential');
    const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
    const accountId=config.codexAccountNamespaces?.[selector];
    if(typeof accountId!=='string'||createHash('sha256').update(accountId).digest('hex')!==identityHash)
      return {terminal:'HOLD',reason:'account_identity_changed'};
    const token=fs.readFileSync(secretFile,'utf8').trim();
    if(!token)throw Error('credential_absent');
    const response=await doFetch('http://127.0.0.1:10100/api/codex-auth/reset-credits?accountId='+encodeURIComponent(accountId),
      {headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});
    if(!response?.ok){
      if(response?.status!==404)return {terminal:'HOLD',reason:'credit_lookup_unavailable',selector,identityHash};
      try{await response.body?.cancel();}catch{}
      // The Windows external OCX proxy intentionally exposes only a read-only account
      // subset. A1 remains the credential owner for its own pool. This is on demand.
      const ownerLookup=options.ownerLookup??(()=>runHidden('pwsh.exe',[
        '-NoProfile','-NonInteractive','-File',path.join(root,'tools/platform/opencodex/Invoke-AiccOcxHubAccounts.ps1'),
        '-Action','credits','-Selector',selector,'-ExpectedIdentity',identityHash],30000));
      const owner=await ownerLookup();
      if(owner?.terminal!=='PASS'||owner.identityHash!==identityHash||owner.selector!==selector||owner.remoteMutation!==false)
        return {terminal:'HOLD',reason:'owner_credit_inventory_unavailable',selector,identityHash};
      const normalized=normalizeResetCredits({credits:owner.credits,available_count:owner.available_count},options.now??Date.now());
      return {...normalized,selector,identityHash};
    }
    const payload=await response.json();
    const normalized=normalizeResetCredits(payload,options.now??Date.now());
    return {...normalized,selector,identityHash};
  }catch{return {terminal:'HOLD',reason:'credit_lookup_unavailable',selector,identityHash};}
}
function localPoolView(pool,active){
  if(!active)return pool;
  if(!Array.isArray(pool?.accounts))return pool;
  return {...pool,accounts:pool.accounts.map(row=>({...row,active:active.verified===true&&typeof active.accountId==='string'&&active.accountId.length>0&&active.namespaces[row.selector]===active.accountId,localActiveUnknown:active.verified!==true}))};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='--credits'){
    const output=process.argv.length===5?await inspectResetCredits(process.argv[3],process.argv[4]):{terminal:'HOLD',reason:'credit_request_invalid'};
    console.log(JSON.stringify(output));
  }else
  if(process.argv.includes('--watch')){
    let closed=false,visible=false,displaySeconds=15,schedule=createRefreshSchedule(),input='',wake=null,wakePending=false,lastQuotaRefresh=0;
    const creditCache=new Map();
    let creditWorker=null,latestResult=null,creditGeneration=0;
    const creditKey=row=>row.selector+':'+row.identityHash;
    const withCredits=snapshot=>({...snapshot,accounts:(snapshot.accounts??[]).map(row=>{
      const entry=creditCache.get(creditKey(row));
      return entry?{...row,resetCreditInventory:{...entry.value,lookupFailed:entry.failed===true}}:row;
    })});
    const publish=snapshot=>{
      if(snapshot.snapshotPhase==='complete')latestResult=snapshot;
      console.log(JSON.stringify(withCredits(snapshot)));
    };
    // Credit inventories never delay quota/connection publication. One read at
    // a time, only while visible; identity remains bound by inspectResetCredits.
    const prefetchCredits=()=>{
      if(creditWorker||closed||!visible||!latestResult)return;
      const due=latestResult.accounts.filter(row=>{
        if(!row.displayNameVerified||row.needsReauth)return false;
        const entry=creditCache.get(creditKey(row));
        return !entry||Date.now()-entry.at>=(entry.failed?600000:300000);
      });
      if(!due.length)return;
      creditWorker=(async()=>{
        for(const row of due){
          if(closed||!visible)break;
          if(!latestResult.accounts.some(current=>creditKey(current)===creditKey(row)))continue;
          const generation=creditGeneration,key=creditKey(row);
          const result=await inspectResetCredits(row.selector,row.identityHash);
          if(closed)break;
          if(generation!==creditGeneration)continue;
          const failed=result.terminal!=='PASS',previous=creditCache.get(key);
          const value=failed&&previous?.value?.terminal==='PASS'?previous.value:{...result,observedAt:result.observedAt??new Date().toISOString()};
          creditCache.set(key,{at:Date.now(),failed,value});
          if(latestResult)publish({...latestResult,snapshotPhase:'credits'});
        }
      })().catch(()=>{}).finally(()=>{creditWorker=null;});
    };
    // Persist only the public tray projection, never credentials or raw API bodies.
    const cacheFile=path.join(resolveRuntimeLayout().root,'status-tray','last-observation.json');
    try {
      const stat=fs.lstatSync(cacheFile);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>131072)throw Error('invalid_cache');
      const cached=JSON.parse(fs.readFileSync(cacheFile,'utf8'));
      const age=Date.now()-Date.parse(cached.observedAt);
      if(cached.schemaVersion!==1||!Array.isArray(cached.accounts)||!Number.isFinite(age)||age<0||age>21600000)throw Error('expired_cache');
      for(const row of cached.accounts){
        const inventory=row.resetCreditInventory,at=Date.parse(inventory?.observedAt);
        if(inventory?.terminal==='PASS'&&Number.isFinite(at)&&at<=Date.now()&&Date.now()-at<300000)
          creditCache.set(creditKey(row),{at,value:inventory,failed:inventory.lookupFailed===true});
      }
      cached.accounts=cached.accounts.map(row=>({...row,active:false,status:row.needsReauth?'로그인 필요':'확인 필요'}));
      console.log(JSON.stringify({...cached,snapshotPhase:'cached',refreshState:'cached',quotaReadFailed:true,
        selectionVerified:false,aiccReady:false,webReady:false,ocxReady:false,
        aiccStatus:'이전 관찰 · 연결 확인 중',webStatus:'확인 중',ocxStatus:'확인 중'}));
    }catch{}
    const signal=()=>{if(wake){wake();wake=null;}else wakePending=true;};
    process.stdin.setEncoding('utf8');
    process.stdin.on('data',chunk=>{
      input+=chunk;if(input.length>4096){closed=true;signal();return;}
      let newline;while((newline=input.indexOf('\n'))>=0){const line=input.slice(0,newline);input=input.slice(newline+1);
        try{const command=JSON.parse(line);if(command.action==='visible'&&typeof command.value==='boolean'){const opened=command.value&&!visible;visible=command.value;if([15,60].includes(command.intervalSeconds))displaySeconds=command.intervalSeconds;if(opened&&Date.now()-lastQuotaRefresh>=60000)schedule.request();signal();}
        else if(command.action==='refresh'){creditGeneration++;creditCache.clear();statusMemo.expire('active:');statusMemo.expire('pool:');schedule.request();signal();}}catch{}
      }
    });
    process.stdin.once('end',()=>{closed=true;signal();});
    while(!closed){
      wakePending=false;
      if(Date.now()-lastQuotaRefresh>=(visible?60000:300000))schedule.request();
      const request=schedule.take();
      try{
        if(request.refresh)lastQuotaRefresh=Date.now();
        const result=await collectTrayStatus({refresh:request.refresh,
          onAccounts:value=>publish({...value,...request})});
        publish({...result,...request});prefetchCredits();
        try{if(result.accounts.length&&!result.quotaReadFailed){
          const directory=path.dirname(cacheFile);fs.mkdirSync(directory,{recursive:true,mode:0o700});
          if(fs.existsSync(cacheFile)&&fs.lstatSync(cacheFile).isSymbolicLink())throw Error('linked_cache');
          const temporary=cacheFile+'.'+process.pid+'.'+Date.now()+'.tmp';
          fs.writeFileSync(temporary,JSON.stringify(withCredits(result))+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
          fs.renameSync(temporary,cacheFile);
        }}catch{} // A cache write failure must not invalidate a successful observation.
      }catch{console.log(JSON.stringify({schemaVersion:1,collectorError:true,...request,observedAt:new Date().toISOString()}));}
      if(!closed&&!wakePending)await new Promise(resolve=>{let settled=false;const done=()=>{if(settled)return;settled=true;clearTimeout(timer);wake=null;resolve();};const timer=setTimeout(done,Math.min(visible?displaySeconds*1000:300000,schedule.retryMs()??Infinity));wake=done;});
    }
  }else console.log(JSON.stringify(await collectTrayStatus({refresh:!process.argv.includes('--cached')})));
}


