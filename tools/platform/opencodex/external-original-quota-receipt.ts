// Original OCX *selection-owner* evidence only. Never a Codex goal/stop/writer
// or one-shot sender capability. The 17841 client headers are correlation hints;
// only the existing management-token/loopback endpoint can bind a real turn.
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,lstatSync,readFileSync,readdirSync,openSync,writeSync,fsyncSync,closeSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {InflightQuota,InflightSettings} from './window-inflight-monitor';

const SHA=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CORR=/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const percent=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=100;
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const deny=(reason:string):never=>{throw Error(reason);};
const epochSeconds=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const privateJson=(value:unknown)=>JSON.stringify(value);
type Window={window:'primary'|'secondary';windowDurationMins:300;usedPercent:number;resetsAt:number;backendUsageAllowed:boolean|null};
type Candidate={ownerRequestId:string;accountIdSha256:string;generation:number;
  requestFingerprint?:string;
  quota:InflightQuota;window:Window;quotaObservedAt:number;policy:InflightSettings;
  requestCorrelation:string;threadCorrelation:string;turnCorrelation:string};
export type PinnedQuotaObservation={accountIdSha256:string;generation:number;
  quota:InflightQuota;window:Window;quotaObservedAt:number;policy:InflightSettings};

export function readActualFiveHourWindow(body:any):Window|null {
  const limit=body?.rate_limit;
  if(!limit||typeof limit!=='object'||Array.isArray(limit))return null;
  const windows=(['primary','secondary'] as const).flatMap(name=>{
    const row=limit[name+'_window'];
    return row?.limit_window_seconds===18000?[{name,row}]:[];
  });
  if(windows.length!==1)return null;
  const {name,row}=windows[0];
  if(!percent(row.used_percent)||!epochSeconds(row.reset_at))return null;
  return {window:name,windowDurationMins:300,usedPercent:row.used_percent,
    resetsAt:row.reset_at,backendUsageAllowed:typeof limit.allowed==='boolean'?limit.allowed:null};
}

export function createOriginalOcxQuotaReceiptStore({home,now=Date.now}:{
 home:string;now?:()=>number;
}) {
  const root=resolve(home);
  if(realpathSync(root)!==root||!lstatSync(root).isDirectory()||lstatSync(root).isSymbolicLink())
    deny('original_quota_owner_home_required');
  const dir=join(root,'external-original-quota-receipts');
  try{mkdirSync(dir,{mode:0o700});}catch(e:any){if(e?.code!=='EEXIST')throw e;}
  if(realpathSync(dir)!==dir||!lstatSync(dir).isDirectory()||lstatSync(dir).isSymbolicLink())
    deny('original_quota_store_alias_refused');
  const pending=new WeakMap<Request,Candidate>();
  const recordedCorrelations=new Set<string>();
  function fileFor(id:string,part:'refusal'|'attestation'|'recovery'){
    if(!UUID.test(id))deny('original_quota_owner_request_uuid_required');
    return join(dir,id+'.'+part+'.json');
  }
  function writeOnce(id:string,part:'refusal'|'attestation'|'recovery',value:any){
    const body=privateJson(value);
    if(realpathSync(dir)!==dir||lstatSync(dir).isSymbolicLink()||
       readdirSync(dir).length>=3072)deny('original_quota_store_capacity_or_alias_hold');
    if(body.length<2||Buffer.byteLength(body)>8192)deny('original_quota_receipt_size_refused');
    const pathname=fileFor(id,part),handle=openSync(pathname,'wx',0o600);
    try{writeSync(handle,body);fsyncSync(handle);}finally{closeSync(handle);}
    return {ownerRequestId:id,receiptSha256:digest(body),kind:value.kind,
      sourceAuthority:'ocx-selection-observation-only',dispatchable:false as const,
      modelRequests:0,newTurns:0};
  }
  function readPinned(id:string,part:'refusal'|'attestation'|'recovery',expectedSha256:string){
    if(!SHA.test(expectedSha256??''))deny('original_quota_receipt_sha_required');
    const file=fileFor(id,part),st=lstatSync(file);
    if(st.isSymbolicLink()||!st.isFile()||st.size<2||st.size>8192)deny('original_quota_receipt_file_refused');
    const bytes=readFileSync(file),body=bytes.toString('utf8');
    if(digest(body)!==expectedSha256)deny('original_quota_receipt_sha_changed');
    const parsed=JSON.parse(body);
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||
       privateJson(parsed)!==body||parsed.ownerRequestId!==id)deny('original_quota_receipt_shape_changed');
    return parsed;
  }
  function recoveryObservation(id:string,value:any){
    // Content-addressed observations preserve each original read. Concurrent
    // identical GETs read the same bytes; a later fresh GET gets its own pin.
    const body=privateJson(value),sha256=digest(body);
    const file=join(dir,id+'.recovery.'+sha256+'.json');
    if(realpathSync(dir)!==dir||lstatSync(dir).isSymbolicLink()||
       readdirSync(dir).length>=3072)deny('original_quota_store_capacity_or_alias_hold');
    if(Buffer.byteLength(body)>8192)deny('original_quota_receipt_size_refused');
    try{
      const fd=openSync(file,'wx',0o600);
      try{writeSync(fd,body);fsyncSync(fd);}finally{closeSync(fd);}
    }catch(error:any){if(error?.code!=='EEXIST')throw error;}
    const st=lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink()||st.size!==Buffer.byteLength(body)||
       digest(readFileSync(file,'utf8'))!==sha256)
      deny('original_quota_recovery_observation_changed');
    return {ownerRequestId:id,receiptSha256:sha256,kind:value.kind,
      sourceAuthority:'ocx-selection-observation-only',dispatchable:false,
      modelRequests:0,newTurns:0};
  }
  function observeSelected(request:Request,{accountId,generation,quota,window,quotaObservedAt,policy,requestFingerprint}:{
    accountId:string;generation:number;quota:InflightQuota;window:Window|null;
    quotaObservedAt:number;policy:InflightSettings;requestFingerprint?:string;
  }) {
    const requestCorrelation=request.headers.get('x-request-id')
      ??request.headers.get('x-codex-request-id')??request.headers.get('x-client-request-id');
    const threadCorrelation=request.headers.get('thread-id')
      ??request.headers.get('session_id')??request.headers.get('session-id');
    const turnCorrelation=request.headers.get('x-codex-turn-id')??request.headers.get('turn-id');
    const ms=now();
    // No account-less, wrong-turn or merely caller-selected/ambiguous receipt.
    // Header IDs remain untrusted until a separately authenticated bridge bind.
    if(!accountId||accountId==='__main__'||!Number.isSafeInteger(generation)||
       !window||!percent(quota.shortPercent)||quota.shortPercent!==window.usedPercent||
       !Number.isFinite(ms)||!Number.isFinite(quotaObservedAt)||
       ms<quotaObservedAt||ms-quotaObservedAt>=60000||
       !CORR.test(requestCorrelation??'')||!UUID.test(threadCorrelation??'')||
       !UUID.test(turnCorrelation??'')||
       !Number.isInteger(policy.fiveHour.usedThreshold)||
       policy.fiveHour.usedThreshold<1||policy.fiveHour.usedThreshold>100||
       !['switch','stop'].includes(policy.fiveHour.action))return false;
    if(requestFingerprint!==undefined&&!SHA.test(requestFingerprint))return false;
    pending.set(request,{ownerRequestId:randomUUID(),accountIdSha256:digest(accountId),requestFingerprint,
      generation,quota:{shortPercent:quota.shortPercent,weeklyPercent:quota.weeklyPercent,
        monthlyPercent:quota.monthlyPercent,shortWindowApplicable:quota.shortWindowApplicable},
      window,quotaObservedAt,policy:{fiveHour:{...policy.fiveHour},
        longWindow:{...policy.longWindow}},
      requestCorrelation:requestCorrelation!,threadCorrelation:threadCorrelation!,
      turnCorrelation:turnCorrelation!});
    return true;
  }
  function recordRefusal(request:Request,reason:'window_stop_policy'|'window_threshold'){
    const candidate=pending.get(request);pending.delete(request);
    if(!candidate)return null;
    const ms=now();
    if(!Number.isFinite(ms)||ms<candidate.quotaObservedAt||
       ms-candidate.quotaObservedAt>=60000||
       !percent(candidate.quota.shortPercent)||
       candidate.quota.shortPercent<candidate.policy.fiveHour.usedThreshold||
       candidate.window.resetsAt*1000<=ms||
       !['window_stop_policy','window_threshold'].includes(reason))return null;
    const correlationKey=digest(JSON.stringify([candidate.requestCorrelation,
      candidate.threadCorrelation,candidate.turnCorrelation]));
    if(recordedCorrelations.has(correlationKey))return null;
    const row={schemaVersion:1,kind:'aicc-ocx-original-fivehour-pre-dispatch-refusal/v1',
      ownerRequestId:candidate.ownerRequestId,
      source:'original-ocx-selected-pool-account',route:'codex-tui-17841-nonweb-ocx10101',
      correlation:{requestId:candidate.requestCorrelation,
        threadId:candidate.threadCorrelation,turnId:candidate.turnCorrelation},
      ...(candidate.requestFingerprint?{requestFingerprint:candidate.requestFingerprint}:{}),
      originalTurnAuthenticated:false,accountIdSha256:candidate.accountIdSha256,
      credentialGeneration:candidate.generation,
      quota:{window:candidate.window.window,windowDurationMins:300,
        usedPercent:candidate.window.usedPercent,resetsAt:candidate.window.resetsAt,
        backendUsageAllowed:candidate.window.backendUsageAllowed,
        providerLimitProven:candidate.window.usedPercent===100&&candidate.window.backendUsageAllowed===false},
      policy:{fiveHourUsedThreshold:candidate.policy.fiveHour.usedThreshold,
        fiveHourAction:candidate.policy.fiveHour.action,
        longWindowUsedThreshold:candidate.policy.longWindow.usedThreshold,
        longWindowAction:candidate.policy.longWindow.action},
      reason,phase:'pre_dispatch',dispatchStarted:false,replayed:false,
      observedAt:new Date(ms).toISOString(),
      ownerRevisionVerified:false,stopEpochVerified:false,goalVerified:false,
      writerReturnedVerified:false,issuerAuthorityGranted:false,
      dispatchable:false,modelRequests:0,newTurns:0};
    const sealed=writeOnce(candidate.ownerRequestId,'refusal',row);
    recordedCorrelations.add(correlationKey);
    // Codex recognizes this provider error separately from our early policy
    // threshold. Emit only real backend exhaustion of the selected 300m window.
    return {...sealed,...(row.quota.providerLimitProven ? {
      codexUsageLimit:{resetsAt:row.quota.resetsAt,windowMinutes:300 as const}
    }: {})};
  }
  function attest({ownerRequestId,refusalSha256,requestId,threadId,turnId}:{
    ownerRequestId:string;refusalSha256:string;requestId:string;threadId:string;turnId:string;
  }) {
    if(!CORR.test(requestId??'')||!UUID.test(threadId??'')||!UUID.test(turnId??''))
      deny('original_quota_authenticated_turn_identity_required');
    const failure=readPinned(ownerRequestId,'refusal',refusalSha256);
    const age=now()-Date.parse(failure.observedAt);
    if(!Number.isFinite(age)||age<0||age>600000||
      failure.kind!=='aicc-ocx-original-fivehour-pre-dispatch-refusal/v1'||
      failure.dispatchStarted!==false||failure.originalTurnAuthenticated!==false||
      failure.correlation?.requestId!==requestId||failure.correlation?.threadId!==threadId||
      failure.correlation?.turnId!==turnId)
      deny('original_quota_refusal_identity_or_freshness_hold');
    // This function is never exposed on the data route. Runtime checks the
    // existing owner management token *before* calling it; no caller can
    // assign an OCX account, generation, goal, stop epoch or writer.
    const record={schemaVersion:1,kind:'aicc-ocx-management-bound-turn-correlation/v1',
      ownerRequestId,refusalSha256,requestId,threadId,turnId,
      accountIdSha256:failure.accountIdSha256,
      credentialGeneration:failure.credentialGeneration,
      managementTurnCorrelationBound:true,originalCodexTurnTerminalVerified:false,
      ownerRevisionVerified:false,stopEpochVerified:false,goalVerified:false,
      writerReturnedVerified:false,issuerAuthorityGranted:false,dispatchable:false,
      modelRequests:0,newTurns:0,recordedAt:new Date(now()).toISOString()};
    return writeOnce(ownerRequestId,'attestation',record);
  }
  async function recover({ownerRequestId,attestationSha256,
    readSameAccount}:{
      ownerRequestId:string;attestationSha256:string;
      readSameAccount:(accountIdSha256:string,generation:number)=>Promise<PinnedQuotaObservation|null>;
  }) {
    const bind=readPinned(ownerRequestId,'attestation',attestationSha256);
    if(bind.kind!=='aicc-ocx-management-bound-turn-correlation/v1'||
       bind.managementTurnCorrelationBound!==true||
       bind.originalCodexTurnTerminalVerified!==false||
       bind.issuerAuthorityGranted!==false)deny('original_quota_bound_receipt_untrusted');
    const failed=readPinned(ownerRequestId,'refusal',bind.refusalSha256);
    if(failed.kind!=='aicc-ocx-original-fivehour-pre-dispatch-refusal/v1'||
       bind.accountIdSha256!==failed.accountIdSha256||
       bind.credentialGeneration!==failed.credentialGeneration||
       bind.threadId!==failed.correlation.threadId||
       bind.turnId!==failed.correlation.turnId||
       bind.requestId!==failed.correlation.requestId)
      deny('original_quota_original_chain_changed');
    const ms=now();
    if(!Number.isFinite(ms)||ms<failed.quota.resetsAt*1000)
      return {state:'ORIGINAL_FIVE_HOUR_RESET_NOT_YET_OBSERVED_HOLD',
        sourceOnly:true,dispatchable:false,modelRequests:0};
    // No account input or pool re-selection. The owner must resolve one exact
    // SHA-pinned physical account + credential generation in its own snapshot.
    const current=await readSameAccount(failed.accountIdSha256,failed.credentialGeneration);
    const freshMs=now();
    const longValues=current?[current.quota.weeklyPercent,current.quota.monthlyPercent]:[];
    if(!Number.isFinite(freshMs)||!current||current.accountIdSha256!==failed.accountIdSha256||
       freshMs<ms||
       current.generation!==failed.credentialGeneration||
       current.window.windowDurationMins!==300||
       current.window.window!==failed.quota.window||
       !percent(current.window.usedPercent)||current.window.usedPercent>=failed.policy.fiveHourUsedThreshold||
       current.window.backendUsageAllowed!==true||
       current.window.resetsAt*1000<=freshMs||
       !Number.isFinite(current.quotaObservedAt)||freshMs<current.quotaObservedAt||
       freshMs-current.quotaObservedAt>=60000||
       current.quota.shortPercent!==current.window.usedPercent||
       !percent(current.quota.shortPercent)||
       !longValues.some(percent)||longValues.some(v=>v!=null&&!percent(v))||
       longValues.some(v=>percent(v)&&v>=failed.policy.longWindowUsedThreshold))
      return {state:'ORIGINAL_SAME_ACCOUNT_FRESH_QUOTA_UNVERIFIED_HOLD',
        sourceOnly:true,dispatchable:false,modelRequests:0};
    const result={schemaVersion:1,kind:'aicc-ocx-original-same-account-quota-recovery/v1',
      ownerRequestId,attestationSha256,refusalSha256:bind.refusalSha256,
      accountIdSha256:failed.accountIdSha256,
      credentialGeneration:failed.credentialGeneration,
      requestId:bind.requestId,threadId:bind.threadId,turnId:bind.turnId,
      route:'codex-tui-17841-nonweb-ocx10101',
      priorRefusalClass:failed.quota.providerLimitProven===true
        ?'BACKEND_USAGE_LIMIT_OBSERVED':'EXACT_OCX_POLICY_THRESHOLD_ONLY',
      freshQuota:{window:current.window.window,windowDurationMins:300,
        usedPercent:current.window.usedPercent,resetsAt:current.window.resetsAt,
        backendUsageAllowed:true},
      quotaObservedAt:new Date(current.quotaObservedAt).toISOString(),
      observedAt:new Date(freshMs).toISOString(),
      sourceAuthority:'ocx-selection-and-same-account-quota-only',
      originalCodexTurnTerminalVerified:false,ownerRevisionVerified:false,
      stopEpochVerified:false,goalVerified:false,writerReturnedVerified:false,
      issuerAuthorityGranted:false,dispatchable:false,originalRequestReplayed:false,
      modelRequests:0,newTurns:0};
    // The first recovery remains immutable for older consumers. Never accept
    // EEXIST blindly: verify its chain, canonical bytes and non-future time.
    let createdFirst=false;
    try{writeOnce(ownerRequestId,'recovery',result);createdFirst=true;}
    catch(error:any){if(error?.code!=='EEXIST')throw error;}
    const firstFile=fileFor(ownerRequestId,'recovery'),firstStat=lstatSync(firstFile);
    if(!firstStat.isFile()||firstStat.isSymbolicLink()||firstStat.size<2||firstStat.size>8192)
      deny('original_quota_recovery_file_refused');
    const firstBytes=readFileSync(firstFile,'utf8');
    const first=readPinned(ownerRequestId,'recovery',digest(firstBytes));
    if(!createdFirst){
      const pinnedFirst=join(dir,ownerRequestId+'.recovery.'+digest(firstBytes)+'.json');
      const pinnedStat=lstatSync(pinnedFirst);
      if(!pinnedStat.isFile()||pinnedStat.isSymbolicLink()||pinnedStat.size!==firstStat.size||
         readFileSync(pinnedFirst,'utf8')!==firstBytes)
        deny('original_quota_first_recovery_pin_changed');
    }
    if(first.kind!==result.kind||first.attestationSha256!==attestationSha256||
       first.refusalSha256!==bind.refusalSha256||first.accountIdSha256!==failed.accountIdSha256||
       first.credentialGeneration!==failed.credentialGeneration||
       first.dispatchable!==false||first.issuerAuthorityGranted!==false||
       first.modelRequests!==0||first.newTurns!==0||
       !Number.isFinite(Date.parse(first.observedAt))||Date.parse(first.observedAt)>freshMs)
      deny('original_quota_first_recovery_chain_changed');
    return {state:'ORIGINAL_SAME_ACCOUNT_FRESH_QUOTA_SOURCE_ONLY',
      ...recoveryObservation(ownerRequestId,result)};
  }
  return {observeSelected,recordRefusal,attest,recover,
    // Read-only exact private evidence for the authenticated central consumer.
    readRefusal:(ownerRequestId:string,sha256:string)=>
      readPinned(ownerRequestId,'refusal',sha256),
    readAttestation:(ownerRequestId:string,sha256:string)=>
      readPinned(ownerRequestId,'attestation',sha256)};
}
