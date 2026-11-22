// AICC pool ownership stays outside the clean supplier tree. All access leases,
// entitlement rows and usage observations are volatile and generation-bound.
import { createHash } from 'node:crypto';
import { createConversationFence, type RequestSettlement } from './external-conversation-lifecycle';
import { ExternalSafeFault } from './external-safe-fault';
import { makePinnedHighRows, selectExactBoundAccount, enforceBoundModelEffort, SOL_MODEL, type VerifiedAccount } from './external-account-picker';
import { readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createExternalCredentialOwner, type BrokerTransport } from './external-credential-owner';
import type { ExternalOcxLease } from './external-http-boundary';
import { isCompleteInflightQuota, quotaThresholdHits, type InflightQuota, type InflightSettings } from './window-inflight-monitor';
import {createOriginalOcxQuotaReceiptStore,readActualFiveHourWindow} from './external-original-quota-receipt';
import {createOriginalIssuerAdmission,parseOriginalIssuerGrant,hasOriginalIssuerHeaders,
  type NativeOriginalIssuerAuthority} from './external-original-issuer-admission';

type Reading = { quota:InflightQuota; at:number; generation:number };
type ModelRows = { rows:any[]; at:number; generation:number; clientVersion:string };
type SupplierFacade = {
  readBody:(request:Request)=>Promise<any>;
  parseQuota:(body:any)=>InflightQuota|null;
  collectCarriers:(body:any)=>{previousResponseId?:string;providerConversationId?:string;fileIds?:string[];encryptedReasoning?:unknown};
  resolveRoute:(config:any,model:string)=>{modelId:string;wireModel?:string;accountId?:string;provider:Record<string,unknown>};
  controlPlaneModel?:(rows:any[],model:string)=>any|undefined;
  buildCatalog?:(config:any,rows:any[])=>any[];
  discovery?:(config:any,rows:any[])=>any[];
  scrubAccountChange?:(body:any,preserveCurrentAccountFiles?:boolean)=>Promise<any>;
};
const validPercent = (v:unknown):v is number => typeof v==='number' && Number.isFinite(v) && v>=0 && v<=100;
const complete = isCompleteInflightQuota;

// Only an explicit, installed local policy opts into account-specific defaults.
// Missing/ambiguous aliases keep the existing protection; array order is never identity.
export function resolveAccountQuotaProtection(config:any, policy:any, id:string):boolean {
  if (!policy) return true;
  if (policy.schemaVersion!==1 || policy.defaultOtherAccounts!==false || !policy.overrides ||
      typeof policy.overrides!=='object' || Array.isArray(policy.overrides) ||
      Object.entries(policy.overrides).some(([key,value])=>!key || typeof value!=='boolean')) throw Error('account_quota_policy_invalid');
  const rows=(config?.codexAccounts??[]).filter((row:any)=>!row.isMain && row.id!=='__main__');
  const target=rows.filter((row:any)=>row.id===id);
  if(target.length!==1) throw Error('account_quota_identity_unverified');
  const number=(row:any)=>typeof row.alias==='string'?/^(\d{1,2})(?:번(?:\(|$)|$)/.exec(row.alias)?.[1]:undefined;
  const n=number(target[0]);
  if(!n || Number(n)<1 || rows.filter((row:any)=>Number(number(row))===Number(n)).length!==1)return true;
  if(Object.hasOwn(policy.overrides,id))return policy.overrides[id];
  return Number(n)===1;
}

export function resolveAccountWindowOverrides(policy:any, id:string):Partial<Pick<InflightSettings,'fiveHour'|'longWindow'>> {
  if(policy?.windowOverrides===undefined)return {};
  const overrides=policy.windowOverrides;
  if(!overrides || typeof overrides!=='object' || Array.isArray(overrides))throw Error('account_window_policy_invalid');
  for(const [account, windows] of Object.entries(overrides) as [string,any][]) {
    if(!account || !windows || typeof windows!=='object' || Array.isArray(windows))throw Error('account_window_policy_invalid');
    for(const [name, rule] of Object.entries(windows) as [string,any][]) {
      if(!['fiveHour','longWindow'].includes(name) || !rule || typeof rule!=='object' || Array.isArray(rule)
        || Object.keys(rule).some(key=>!['usedThreshold','enabled'].includes(key))
        || (rule.enabled!==undefined && typeof rule.enabled!=='boolean')
        || (rule.usedThreshold!==undefined && (!Number.isInteger(rule.usedThreshold) || rule.usedThreshold<1 || rule.usedThreshold>100)))throw Error('account_window_policy_invalid');
    }
  }
  return overrides[id]??{};
}

export function createExternalPoolState(options:{transport:BrokerTransport;home:string;clientVersion:string;supplier:SupplierFacade;
  originalIssuerAuthority?:NativeOriginalIssuerAuthority}) {
  if (!/^\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/.test(options.clientVersion) || /^0(?:\.0)+(?:[-+]|$)/.test(options.clientVersion)) {
    throw Error('registered_codex_client_version_required');
  }
  const owner = createExternalCredentialOwner(options.transport);
  const readings = new Map<string,Reading>();
  const rawQuotaWindows = new Map<string,{generation:number;at:number;window:ReturnType<typeof readActualFiveHourWindow>}>();
  const originalQuota = createOriginalOcxQuotaReceiptStore({home:options.home});
  const originalAdmission=createOriginalIssuerAdmission({authority:options.originalIssuerAuthority});
  const originalSelections=new WeakMap<Request,{id:string;generation:number;scope:string;wireModel:string}>();
  const accountScope=()=>JSON.stringify([owner.currentSnapshot()?.config,owner.currentSnapshot()?.settings]);
  function assertOriginalSelection(request:Request) {
    originalAdmission.assertCurrent(request);
    const exact=originalSelections.get(request);if(!exact)return;
    const snap=owner.currentSnapshot(),pin=snap?.config.activeCodexAccountPinned;
    const roster=models.get(exact.id),now=Date.now();
    const entitled=roster?.rows.filter(row=>row.slug===exact.wireModel)??[];
    if(!entitled.length&&roster) {
      const internal=options.supplier.controlPlaneModel?.(roster.rows,exact.wireModel);
      if(internal)entitled.push(internal);
    }
    if(request.signal.aborted||!owner.generationLive(exact.id,exact.generation)||
      terminalAuth(snap?.records?.[exact.id])||accountScope()!==exact.scope||
      (snap?.config.pausedCodexAccountIds??[]).includes(exact.id)||
      (pin&&pin!==exact.id)||!admission(exact.id).allowed||
      !roster||roster.generation!==exact.generation||now<roster.at||now-roster.at>=60000||entitled.length!==1)
      throw Error('original_issuer_selection_scope_changed');
  }
  const selectedQuotaGeneration=new WeakMap<Request,{id:string;generation:number}>();
  const models = new Map<string,ModelRows>();
  const quotaFailures = new Map<string,{code:string;attempts:number;retryAt:number;generation?:number}>();
  const terminalAuth = (record:any) => !record || record.lastCodexValidationTerminal===true;
  function failedQuota(id:string,code:string,generation?:number) {
    const previous=quotaFailures.get(id);
    const attempts=previous?.generation===generation?Math.min(5,(previous?.attempts??0)+1):1;
    const retryAt=Date.now()+Math.min(300_000,15_000*2**(attempts-1));
    quotaFailures.set(id,{code,attempts,retryAt,generation});
    return {quota:null,generation,verified:false};
  }
  const quotaFlights = new Map<string,Promise<{quota:InflightQuota|null;generation?:number;verified:boolean}>>();
  const modelFlights = new Map<string,Promise<any[]>>();
  const fence=createConversationFence(options.home);
  const issuers = new Map<string,{accountId:string;at:number;completedAt?:number;portableHistory?:boolean;generation?:number;wireModel?:string}>();
  const prepared = new WeakMap<Request,any>();
  const pendingBindings=new WeakMap<Request,{key:string;accountId:string;portableHistory:boolean;generation:number;wireModel:string}>();
  const issuerPath=join(options.home,'external-issuers.json');
  function persistIssuers() {
    const temporary=issuerPath+'.'+crypto.randomUUID()+'.tmp';
    writeFileSync(temporary,JSON.stringify({schemaVersion:1,rows:[...issuers].map(([key,value])=>({key,...value}))})+'\n',
      {encoding:'utf8',flag:'wx',mode:0o600});
    renameSync(temporary,issuerPath);
  }
  try {
    const saved=JSON.parse(readFileSync(issuerPath,'utf8'));
    if(saved.schemaVersion!==1 || !Array.isArray(saved.rows) || saved.rows.length>10_000) throw Error('invalid');
    for(const row of saved.rows) {
      if(!/^[a-f0-9]{32}$/.test(row.key) || typeof row.accountId!=='string' || row.accountId==='__main__'
        || !Number.isFinite(row.at)) throw Error('invalid');
      if((row.generation!==undefined&&(!Number.isSafeInteger(row.generation)||row.generation<0))||
        (row.wireModel!==undefined&&(typeof row.wireModel!=='string'||!/^[\w.-]{1,128}$/.test(row.wireModel))))
        throw Error('invalid');
      issuers.set(row.key,{accountId:row.accountId,at:row.at,completedAt:Number.isFinite(row.completedAt)?row.completedAt:undefined,portableHistory:row.portableHistory===true,
        ...(row.generation!==undefined?{generation:row.generation}:{}),...(row.wireModel!==undefined?{wireModel:row.wireModel}:{})});
    }
  } catch(error:any) {if(error.code!=='ENOENT') throw Error('external_issuer_metadata_invalid_preserve_existing');}
  let selected:string|undefined;
  let selectionTail:Promise<unknown> = Promise.resolve();
  const activePath = join(options.home,'external-selection.json');
  const localConfigPath = join(options.home,'config.json');
  let mirroredPinSnapshot:any;
  let pinMirrorStatus='not_checked';
  function reconcileRemovedPin(snapshot:any) {
    if(mirroredPinSnapshot===snapshot) return;
    mirroredPinSnapshot=snapshot;
    if(snapshot.config.activeCodexAccountPinned) {pinMirrorStatus='broker_pinned';return;}
    let temporary:string|undefined;
    try {
      const before=readFileSync(localConfigPath,'utf8');
      const local=JSON.parse(before);
      if(!local || typeof local!=='object' || Array.isArray(local)) throw Error('local_config_invalid');
      if(!Object.hasOwn(local,'activeCodexAccountPinned') || !local.activeCodexAccountPinned) {
        pinMirrorStatus='in_sync';return;
      }
      if(typeof local.activeCodexAccountPinned!=='string') throw Error('local_pin_invalid');
      delete local.activeCodexAccountPinned;
      // The A1 snapshot owns pin removal. Keep the local active choice and
      // every other config value; never touch issuer or request state.
      if(readFileSync(localConfigPath,'utf8')!==before) {pinMirrorStatus='local_changed';return;}
      temporary=localConfigPath+'.'+crypto.randomUUID()+'.tmp';
      writeFileSync(temporary,JSON.stringify(local)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
      if(readFileSync(localConfigPath,'utf8')!==before) {pinMirrorStatus='local_changed';return;}
      renameSync(temporary,localConfigPath);temporary=undefined;
      pinMirrorStatus='unpin_reconciled';
    } catch {pinMirrorStatus='sync_failed';}
    finally {if(temporary) {try {unlinkSync(temporary);} catch {pinMirrorStatus='sync_failed';}}}
  }
  try {
    const saved=JSON.parse(readFileSync(activePath,'utf8'));
    if (saved.schemaVersion===1 && typeof saved.accountId==='string' && saved.accountId!=='__main__') selected=saved.accountId;
  } catch (error:any) {
    if(error.code!=='ENOENT') throw Error('external_selection_invalid_preserve_existing');
    // Seed only the existing selected pool id, never any credential or Native
    // setting. Conversation issuers still require their separate provenance.
    try {
      const legacy=JSON.parse(readFileSync(join(options.home,'config.json'),'utf8'));
      if(typeof legacy.activeCodexAccountId==='string' && legacy.activeCodexAccountId!=='__main__') selected=legacy.activeCodexAccountId;
    } catch (legacyError:any) {if(legacyError.code!=='ENOENT') throw Error('legacy_selection_invalid_preserve_existing');}
  }

  function settings(id?:string):InflightSettings {
    const value=owner.currentSnapshot()?.settings;
    if(value?.schemaVersion!==1) throw new ExternalSafeFault('window_policy_unavailable');
    for(const rule of [value.fiveHour,value.longWindow]) {
      if(!Number.isInteger(rule?.usedThreshold) || rule.usedThreshold<1 || rule.usedThreshold>100
        || !['switch','stop'].includes(rule.action)) throw Error('window_policy_invalid');
    }
    // Independent admission ceilings: short 97%, long 98%; stricter owner limits win.
    let thresholdProtection=true;
    let windows:ReturnType<typeof resolveAccountWindowOverrides>={};
    if(id) {
      const file=join(options.home,'aicc-account-quota-policy.json');
      let policy;
      try {const stat=lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||stat.size>65536)throw Error('account_quota_policy_invalid');policy=JSON.parse(readFileSync(file,'utf8'));}
      catch(error:any){if(error.code!=='ENOENT')throw error;}
      thresholdProtection=resolveAccountQuotaProtection(owner.currentSnapshot()?.config,policy,id);
      windows=resolveAccountWindowOverrides(policy,id);
    }
    return {thresholdProtection,fiveHour:{...value.fiveHour,usedThreshold:Math.min(97,value.fiveHour.usedThreshold),...windows.fiveHour},
      longWindow:{...value.longWindow,usedThreshold:Math.min(98,value.longWindow.usedThreshold),...windows.longWindow}};
  }
  function persistSelection(id:string) {
    if(selected===id) return;
    const temporary=activePath+'.'+crypto.randomUUID()+'.tmp';
    writeFileSync(temporary,JSON.stringify({schemaVersion:1,accountId:id})+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
    renameSync(temporary,activePath);
    selected=id;
  }
  const scopedSignal = (signal?:AbortSignal) => signal
    ? AbortSignal.any([signal,AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000);
  async function usage(id:string,signal?:AbortSignal) {
    const pending=quotaFlights.get(id);
    if(pending) return pending;
    const work=(async()=>{
      const snapshot=await owner.refreshSnapshot();
      if(terminalAuth(snapshot.records[id])) {
        readings.delete(id);models.delete(id);
        return failedQuota(id,'reauth_required',snapshot.records[id]?.generation);
      }
      let credential=await owner.lease(id,{signal});
      for(let attempt=0;attempt<2;attempt++) {
        const response=await fetch('https://chatgpt.com/backend-api/wham/usage',{
          headers:{authorization:'Bearer '+credential.accessToken,'chatgpt-account-id':credential.chatgptAccountId},
          signal:scopedSignal(signal),redirect:'error'});
        if(response.status===401) {
          await response.body?.cancel();
          readings.delete(id);models.delete(id);
          if(attempt===1)return failedQuota(id,'credential_rejected',credential.generation);
          // Only the credential owner may rotate a grant. Retry this read once
          // with its replacement lease; never replay an inference request.
          credential=await owner.lease(id,{signal,rejectedGeneration:credential.generation,rejectedAccessToken:credential.accessToken});
          continue;
        }
        if(!response.ok) {
          await response.body?.cancel();
          return failedQuota(id,response.status===429?'quota_rate_limited':response.status===403?'quota_access_denied':'quota_upstream_unavailable',credential.generation);
        }
        const content=await boundedJson(response,262_144);
        const quota=options.supplier.parseQuota(content);
        if(!complete(quota) || !owner.generationLive(id,credential.generation)) {
          readings.delete(id);
          return failedQuota(id,'quota_unverified',credential.generation);
        }
        const at=Date.now();
        readings.set(id,{quota,at,generation:credential.generation});
        rawQuotaWindows.set(id,{generation:credential.generation,at,window:readActualFiveHourWindow(content)});
        quotaFailures.delete(id);
        return {quota,generation:credential.generation,verified:true};
      }
      return failedQuota(id,'quota_unverified');
    })().catch(()=>failedQuota(id,signal?.aborted?'quota_cancelled':'credential_owner_or_network_unavailable',owner.currentSnapshot()?.records?.[id]?.generation))
      .finally(()=>{quotaFlights.delete(id);});
    quotaFlights.set(id,work);
    return work;
  }  async function roster(id:string,signal?:AbortSignal):Promise<any[]> {
    const current=owner.currentSnapshot()?.records?.[id]?.generation;
    const saved=models.get(id);
    if(saved && saved.generation===current && saved.clientVersion===options.clientVersion && Date.now()-saved.at<60_000) return saved.rows;
    const pending=modelFlights.get(id);
    if(pending) return pending;
    const work=(async()=>{
      const credential=await owner.lease(id,{signal});
      const response=await fetch('https://chatgpt.com/backend-api/codex/models?client_version='+encodeURIComponent(options.clientVersion),{
        headers:{authorization:'Bearer '+credential.accessToken,'chatgpt-account-id':credential.chatgptAccountId},
        signal:scopedSignal(signal),redirect:'error'});
      if(!response.ok) { await response.body?.cancel(); throw Error('model_entitlement_unverified'); }
      const value=await boundedJson(response,2*1024*1024);
      if(!Array.isArray(value.models) || !owner.generationLive(id,credential.generation)) throw Error('model_entitlement_unverified');
      const rows=value.models.filter((row:any)=>typeof row?.slug==='string' && row.slug.length<200);
      models.set(id,{rows,at:Date.now(),generation:credential.generation,clientVersion:options.clientVersion});
      return rows;
    })().finally(()=>{modelFlights.delete(id);});
    modelFlights.set(id,work);
    return work;
  }
  function admission(id:string) {
    const reading=readings.get(id);
    if(!reading || Date.now()-reading.at>=60_000 || !owner.generationLive(id,reading.generation) || !complete(reading.quota)) return {allowed:false,stop:false};
    const rules=settings(id);
    const hits=quotaThresholdHits(reading.quota,rules);
    return {allowed:!hits.fiveHour&&!hits.longWindow,stop:hits.fiveHour&&rules.fiveHour.action==='stop'
      ||hits.longWindow&&rules.longWindow.action==='stop'};
  }
  function observeOriginalSelected(request:Request,id:string,generation?:number,requestFingerprint?:string) {
    const reading=readings.get(id),raw=rawQuotaWindows.get(id);
    if(!reading||!raw||!raw.window||!Number.isSafeInteger(generation)||
       reading.generation!==generation||raw.generation!==generation||
       reading.at!==raw.at||!owner.generationLive(id,generation))return false;
    const captured=originalQuota.observeSelected(request,{accountId:id,generation,
      quota:reading.quota,window:raw.window,quotaObservedAt:reading.at,policy:settings(id),requestFingerprint});
    if(captured)selectedQuotaGeneration.set(request,{id,generation});
    return captured;
  }
  async function freshOriginalAccountByHash(accountIdSha256:string,generation:number) {
    const snapshot=await owner.refreshSnapshot(true);
    const matching=Object.entries(snapshot.records??{}).filter(([id,row]:[string,any])=>
      id!=='__main__'&&createHash('sha256').update(id).digest('hex')===accountIdSha256&&
      row?.generation===generation&&row.lastCodexValidationTerminal!==true&&
      snapshot.config.codexAccounts.some((a:any)=>a.id===id&&!a.isMain)&&
      !(snapshot.config.pausedCodexAccountIds??[]).includes(id));
    if(matching.length!==1)return null;
    const id=matching[0][0];
    const observed=await usage(id);
    const sample=readings.get(id),raw=rawQuotaWindows.get(id);
    if(!observed.verified||observed.generation!==generation||!sample||!raw?.window||
       raw.at!==sample.at||sample.generation!==generation||raw.generation!==generation||
       !owner.generationLive(id,generation)||!admission(id).allowed)return null;
    return {accountIdSha256,generation,quota:sample.quota,window:raw.window,
      quotaObservedAt:sample.at,policy:settings(id)};
  }
  function threadKey(request:Request,body:any,fingerprint?:string) {
    // A parent is a placement hint, never proof that a child's ciphertext was
    // minted by the parent's serving account.
    const header=request.headers.get('thread-id') ?? request.headers.get('session_id')
      ?? request.headers.get('session-id');
    const value=header || request.headers.get('x-aicc-socket-session')
      || (typeof body.previous_response_id==='string'?body.previous_response_id:undefined);
    if(!value || value.length>4096 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
    // Codex can summarize memory while the next user turn starts on the same
    // thread. This independent request has its own issuer and active lifetime;
    // it must neither lock the user turn nor replace that turn's issuer binding.
    let memory=false;
    try {
      const raw=request.headers.get('x-codex-turn-metadata');
      if(raw && raw.length<=4096) memory=JSON.parse(raw)?.request_kind==='memory';
    } catch { /* malformed metadata retains the ordinary thread contract */ }
    const identity=memory ? 'aicc-memory\0'+value.trim()+(fingerprint?'\0'+fingerprint:'') : value.trim();
    return createHash('sha256').update(identity).digest('hex').slice(0,32);
  }
  async function selectOne(request:Request,signal:AbortSignal):Promise<ExternalOcxLease> {
    const snap=await owner.refreshSnapshot();
    reconcileRemovedPin(snap);
    let body=await options.supplier.readBody(request.clone());
    if(typeof body.model!=='string') throw new ExternalSafeFault('model_required');
    const config=snap.config;
    const candidates=(config.codexAccounts as any[]).filter(row=>snap.records[row.id] && !row.isMain
      && !(config.pausedCodexAccountIds??[]).includes(row.id));
    if(!candidates.length) throw new ExternalSafeFault('no_unpaused_pool_account');
    // Account-qualified native selectors retain their explicit physical owner.
    const requestedModel=body.model;
    const preferredMatch=/^preferred-([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/([A-Za-z0-9][A-Za-z0-9._-]{0,198})$/.exec(requestedModel);
    const preferredSelector=preferredMatch && !Object.hasOwn(config.codexAccountNamespaces??{},requestedModel.split('/')[0])
      ? preferredMatch[1] : undefined;
    const preferredAccountId=preferredSelector && Object.hasOwn(config.codexAccountNamespaces??{},preferredSelector)
      ? config.codexAccountNamespaces[preferredSelector] : undefined;
    if(preferredMatch && !preferredSelector) throw new ExternalSafeFault('preferred_account_selector_ambiguous');
    if(preferredSelector && (!preferredAccountId || preferredAccountId==='__main__'
      || !config.codexAccounts.some((row:any)=>row.id===preferredAccountId && !row.isMain))) throw new ExternalSafeFault('preferred_pool_account_unavailable');
    const routing=options.supplier.resolveRoute(config,preferredSelector?preferredMatch![2]:requestedModel);
    if(preferredAccountId && routing.accountId) throw new ExternalSafeFault('preferred_account_selector_ambiguous');
    const qualified=preferredSelector?undefined:routing.accountId;
    const wireModel=routing.modelId;
    if(wireModel.includes('/') || !/^[\w.-]+$/.test(wireModel)) throw new ExternalSafeFault('external_routed_model_contract_required');
    if(qualified==='__main__') throw new ExternalSafeFault('native_identity_outside_pool');
    const isSearch=new URL(request.url).pathname.endsWith('/alpha/search');
    // Ignore transport metadata and account selectors: neither makes an automatic replay new work.
    const fingerprint=createHash('sha256').update(JSON.stringify({model:wireModel,input:body.input,
      instructions:body.instructions,tools:body.tools,tool_choice:body.tool_choice,reasoning:body.reasoning,
      previous_response_id:body.previous_response_id,conversation:body.conversation})).digest('hex');
    const original=originalAdmission.claim(request,fingerprint);
    if(original) {
      if(isSearch||preferredSelector||(qualified&&qualified!==original.accountId)||
        !candidates.some(row=>row.id===original.accountId))throw Error('original_issuer_route_mismatch');
      originalSelections.set(request,{id:original.accountId,generation:original.generation,scope:accountScope(),wireModel});
      assertOriginalSelectionIdentity();
    }
    function assertOriginalSelectionIdentity() {
      if(!original)return;
      originalAdmission.assertCurrent(request);
      const pinned=config.activeCodexAccountPinned;
      if(signal.aborted||!owner.generationLive(original.accountId,original.generation)||
        (pinned&&pinned!==original.accountId)||terminalAuth(owner.currentSnapshot()?.records?.[original.accountId]))
        throw Error('original_issuer_identity_changed');
    }
    const key=isSearch?undefined:threadKey(request,body,fingerprint);
    // Independent memory jobs may overlap. Identical semantic work retains one
    // fence across retries; the legacy memory fence still protects unresolved
    // attempts recorded before per-job isolation. Never migrate away UNKNOWN.
    const legacyKey=isSearch?undefined:threadKey(request,body);
    if(legacyKey && legacyKey!==key) fence.assertIdle(legacyKey,fingerprint);
    if(key) fence.assertIdle(key,fingerprint);
    const unresolved=key?fence.unresolved(key):undefined;
    const issuer=key?issuers.get(key):undefined;
    // An interrupted attempt still identifies its physical account. Preserve that provenance
    // without inventing completion or preventing a later caller instruction.
    const prior=unresolved?{...issuer,accountId:unresolved.accountId,at:unresolved.at,completedAt:undefined}:issuer;
    if(original&&prior&&prior.accountId!==original.accountId)throw Error('original_issuer_prior_owner_mismatch');
    const carriers=options.supplier.collectCarriers(body);
    let scoped=!!carriers.previousResponseId || !!carriers.providerConversationId
      || !!carriers.encryptedReasoning || !!carriers.fileIds?.length;
    // G1-04: a new child/forked thread may carry full readable history plus
    // ciphertext minted under an unknown account. The parent is never proof of
    // that account. When the only account-bound carrier is ciphertext inside a
    // full input history, strip it with the existing account-change scrubber and
    // start this thread as portable plaintext. Server-side references and files
    // cannot be recovered that way and stay refused.
    let portableFresh=false;
    if(scoped && !prior && !carriers.previousResponseId && !carriers.providerConversationId && !carriers.fileIds?.length) {
      if(!options.supplier.scrubAccountChange) throw new ExternalSafeFault('account_change_scrubber_unavailable');
      body=await options.supplier.scrubAccountChange(body,false);
      scoped=false;portableFresh=true;
    }
    if(scoped && !prior) throw new ExternalSafeFault('account_scoped_input_owner_unknown');
    // An issuer proves provenance; only an explicit selector is a hard pin.
    const bound=original?.accountId??qualified;
    const exact=selectExactBoundAccount(bound,candidates,prior?.accountId);
    if(exact) {
      candidates.splice(0,candidates.length,exact);
      if(scoped && !prior) throw new ExternalSafeFault('account_scoped_input_owner_unknown');
    }
    const priority=(id:string)=>Number.isFinite(config.codexAccountPriorities?.[id])?config.codexAccountPriorities[id]:0;
    candidates.sort((a,b)=>priority(b.id)-priority(a.id) || a.id.localeCompare(b.id));
    const current=candidates.find(row=>row.id===(prior?.accountId??selected));
    if(bound && !candidates.some(row=>row.id===bound)) throw new ExternalSafeFault('bound_pool_account_unavailable');
    const admitted:any[]=[];
    const preparedByAccount=new Map<string,any>();
    let rosterUnavailable=false,entitlementRejected=false;
    let thresholdBlocked=0;
    for(const row of candidates) {
      if(bound && row.id!==bound) continue;
      if(signal.aborted) throw Error('request_cancelled');
      const usageResult=await usage(row.id,signal);
            if(!usageResult.verified) {
        if(bound) throw new ExternalSafeFault('quota_unverified');
        continue;
      }
      const admittedWindow=admission(row.id);
      if(!admittedWindow.allowed) {
        thresholdBlocked++;
        if(bound) {
          observeOriginalSelected(request,row.id,readings.get(row.id)?.generation,fingerprint);
          throw new ExternalSafeFault('window_threshold','no_admissible_account',{
          mode:qualified?'strict':preferredAccountId?'preferred':'automatic',
          nextAction:'wait_for_reset',
          sameThreadAccountSwitch:false,originalRequestReplay:false,
          });
        }
        continue;
      }
      // A failed lookup is never a verified empty/unsupported entitlement roster.
      const rows=await roster(row.id,signal).catch(()=>{rosterUnavailable=true;return null;});
      if(rows===null) continue;
      let entitled=rows.filter(model=>model.slug===wireModel);
      if(!entitled.length && requestedModel===wireModel && !qualified && !preferredAccountId) {
        // Official control-plane rows deliberately live outside the public
        // account roster. Reuse its native-support projection on this account's
        // fresh, generation-bound rows; never alias the reviewer to a work model.
        const internal=options.supplier.controlPlaneModel?.(rows,wireModel);
        if(internal) entitled=[internal];
      }
      if(entitled.length!==1) {entitlementRejected=true;continue;}
      if(qualified || preferredAccountId) {
        try { preparedByAccount.set(row.id,enforceBoundModelEffort(body,row.id,requestedModel,entitled[0])); }
        catch(error) { if(qualified) throw error; continue; }
      }
      admitted.push(row);
    }
    const strategy=config.accountPoolStrategy??'quota';
    if(!bound && !['quota','reset-first','fill-first','round-robin'].includes(strategy)) throw Error('pool_strategy_not_supported');
    const score=(row:any)=>{
      const q=readings.get(row.id)?.quota;
      return q && complete(q)?Math.max(...[q.shortPercent,q.weeklyPercent,q.monthlyPercent].filter(validPercent)):100;
    };
    const reset=(row:any)=>{
      const q=readings.get(row.id)?.quota as any;
      return Math.min(...[q?.shortResetAt,q?.weeklyResetAt,q?.monthlyResetAt].filter(Number.isFinite)
        .map(value=>value<1e12?value*1000:value).filter(value=>value>Date.now()));
    };
    // Only a new unbound quota request ignores legacy priority/current choice.
    // A preferred selector may lead this order; an issuer/qualified route stays exact.
    const automaticQuota=!bound && !scoped && strategy==='quota';
    const quotaRanks=new Map<string,readonly [number,number]>();
    if(automaticQuota) for(const row of admitted) {
      const reading=readings.get(row.id);
      // Reuse the existing freshness/generation/window policy after all roster awaits.
      // Unknown/incomplete observations are excluded, never scored as zero usage.
      if(!reading || !complete(reading.quota) || !admission(row.id).allowed) continue;
      const long=[reading.quota.weeklyPercent,reading.quota.monthlyPercent].filter(validPercent);
      // Both applicable long windows retain their individual admission thresholds;
      // their greatest used percentage is the conservative least-remaining key.
      // No short window is not a fabricated zero: rank this plan by its actual long window.
      quotaRanks.set(row.id,[reading.quota.shortPercent??Math.max(...long),Math.max(...long)]);
    }
    const quotaOrder=(a:any,b:any)=>{
      const left=quotaRanks.get(a.id)!,right=quotaRanks.get(b.id)!;
      return left[0]-right[0] || left[1]-right[1] || (a.id<b.id?-1:a.id>b.id?1:0);
    };
    // The global manual pin never narrows this request's eligible pool.
    // Preserve explicitly selected non-quota strategy ordering and stickiness.
    let eligible=automaticQuota
      ? admitted.filter(row=>quotaRanks.has(row.id)).sort(quotaOrder)
      : admitted.sort((a,b)=>priority(b.id)-priority(a.id)
        || (strategy==='reset-first'?reset(a)-reset(b):0)||score(a)-score(b)||a.id.localeCompare(b.id));
    // G1-24: the tray "use this account" action leaves only the broker pin (id stays null).
    // A new conversation without an issuer leads with that pin when it is admitted; the pool
    // is not narrowed, so an exhausted/paused pin still falls back to the next eligible account.
    const manualPin=typeof config.activeCodexAccountPinned==='string' ? config.activeCodexAccountPinned : undefined;
    const pinned=!prior && !preferredAccountId && !bound && manualPin ? eligible.find(row=>row.id===manualPin) : undefined;
    const preferred=prior?eligible.find(row=>row.id===prior.accountId):preferredAccountId?eligible.find(row=>row.id===preferredAccountId)
      : pinned ?? (!automaticQuota && (!config.codexAccountPriorityFailback || strategy==='fill-first')
        ? current && eligible.find(row=>row.id===current.id) : undefined);
    if(preferred) eligible=[preferred,...eligible.filter(row=>row.id!==preferred.id)];
    if(strategy==='round-robin' && !prior && !preferredAccountId && !pinned && !scoped && eligible.length>1) {
      const index=eligible.findIndex(row=>row.id===selected);
      if(index>=0) eligible=[...eligible.slice(index+1),...eligible.slice(0,index+1)];
    }
    for(const row of eligible) {
      const changing=!!prior && prior.accountId!==row.id;
      let candidateBody=preparedByAccount.get(row.id)??body;
      if(changing) {
        // Completion of the old attempt is not required to admit a new instruction.
        // Account-bound references still pass through the existing migration scrubber.
        // An explicit stop policy also applies to automatic/preferred modes.
        if(admission(prior.accountId).stop) {
          observeOriginalSelected(request,prior.accountId,readings.get(prior.accountId)?.generation,fingerprint);
          throw new ExternalSafeFault('window_stop_policy');
        }
        if(carriers.fileIds?.length) throw new ExternalSafeFault('uploaded_files_cannot_change_account');
      }
      if(changing || prior?.portableHistory) {
        if(!options.supplier.scrubAccountChange) throw new ExternalSafeFault('account_change_scrubber_unavailable');
        // Old ciphertext can remain in later full-history requests after a switch.
        // Strip it on every migrated-thread request; keep current-account files only when staying.
        candidateBody=await options.supplier.scrubAccountChange(candidateBody,!changing);
      }
      const credential=await owner.lease(row.id,{signal});
      if(original) {
        await owner.refreshSnapshot(true);
        assertOriginalSelectionIdentity();
        assertOriginalSelection(request);
        if(credential.generation!==original.generation)throw Error('original_issuer_generation_changed');
      }
      const reading=readings.get(row.id)!;
      if(reading.generation!==credential.generation || !admission(row.id).allowed) continue;
      // G1-24: only a new unbound conversation updates the global selection. Continuing (or
      // migrating) an existing issuer conversation must not reset it to that old account.
      if(!bound && !preferredAccountId && !prior) persistSelection(row.id);
      if(key) {
        if(!issuers.has(key) && issuers.size>=10_000) throw new ExternalSafeFault('conversation_binding_capacity');
        // Preserve an interrupted issuer even if the new request is subsequently not sent.
        if(unresolved && prior) {issuers.set(key,prior);persistIssuers();}
        fence.reserve(request,key,row.id,fingerprint);
        pendingBindings.set(request,{key,accountId:row.id,portableHistory:changing || portableFresh || prior?.portableHistory===true,
          generation:credential.generation,wireModel:routing.wireModel??wireModel});
      }
      prepared.set(request,{...candidateBody,model:routing.wireModel??wireModel});
      const accountSelector = typeof row.logLabel === 'string' && /^p[0-9a-f]{6}$/.test(row.logLabel) ? row.logLabel : undefined;
      observeOriginalSelected(request,row.id,credential.generation,fingerprint);
      return {...credential,accountSelector,quota:reading.quota,quotaObservedAt:reading.at,supplierContext:routing.provider,supplierConfig:config,
        ...(original?{originalIssuerDispatch:async(send:()=>Promise<Response>)=>{
          await owner.refreshSnapshot(true);
          return originalAdmission.dispatch(request,send,()=>assertOriginalSelection(request));
        }}:{})};
    }
    if(thresholdBlocked===candidates.length) throw new ExternalSafeFault('window_threshold','no_admissible_account',{
      mode:qualified?'strict':preferredAccountId?'preferred':'automatic',nextAction:'wait_for_reset',
      sameThreadAccountSwitch:false,originalRequestReplay:false,
    });
    throw new ExternalSafeFault(rosterUnavailable?'model_entitlement_unverified':entitlementRejected?'model_not_supported_by_account':bound?'bound_pool_account_not_admissible':'no_verified_pool_account',
      rosterUnavailable?'roster_unavailable':entitlementRejected?'verified_entitlement_rejected':'no_admissible_account');
  }
  const select=(request:Request,signal:AbortSignal):Promise<ExternalOcxLease> => {
    const work=selectionTail.catch(()=>{}).then(()=>selectOne(request,signal)).catch(error=>{
      if(hasOriginalIssuerHeaders(request))originalAdmission.settle(request);throw error;
    });
    selectionTail=work.then(()=>{},()=>{});
    return work;
  };
  async function catalogSnapshot() {
    const snap=await owner.refreshSnapshot();
    const observations=new Map<string,ModelRows>();
    for(const account of snap.config.codexAccounts) {
      if(account.isMain || account.id==='__main__' || terminalAuth(snap.records[account.id])
        || (snap.config.pausedCodexAccountIds??[]).includes(account.id)) continue;
      await roster(account.id).catch(()=>[]);
      const cached=models.get(account.id);
      if(cached) observations.set(account.id,cached);
    }
    // All accounts are rechecked after the last await. An earlier account may
    // have rotated generation or lost its namespace while another roster loads.
    const current=owner.currentSnapshot();
    const live=(id:string,cached:ModelRows) => {
      const age=Date.now()-cached.at;
      return models.get(id)===cached && Number.isFinite(cached.at) && age>=0 && age<60_000
        && cached.clientVersion===options.clientVersion && Number.isInteger(cached.generation)
        && owner.generationLive(id,cached.generation) && current?.records?.[id]?.generation===cached.generation
        && !terminalAuth(current?.records?.[id]) && !(current.config.pausedCodexAccountIds??[]).includes(id)
        && current.config.codexAccounts.some((account:any)=>account.id===id && !account.isMain && id!=='__main__');
    };
    const rows=new Map<string,any>();
    for(const [id,cached] of observations) {
      if(live(id,cached))for(const row of cached.rows) if(!rows.has(row.slug))rows.set(row.slug,row);
    }
    const stock=options.supplier.buildCatalog?.(current.config,[...rows.values()])??[...rows.values()];
    const numberedLabel=(account:any):string|undefined=>{
      const number=typeof account.alias==='string'?/^(\d{1,2})(?:번(?:\(|$)|$)/.exec(account.alias)?.[1]:undefined;
      return number && Number(number)>0?'계정 '+Number(number):undefined;
    };
    const accounts=current.config.codexAccounts.filter((account:any)=>!account.isMain && account.id!=='__main__'
      && !terminalAuth(current.records[account.id]) && !(current.config.pausedCodexAccountIds??[]).includes(account.id));
    const labelCounts=new Map<string,number>();
    for(const account of current.config.codexAccounts) {
      if(account.isMain || account.id==='__main__')continue;
      const label=numberedLabel(account);if(label)labelCounts.set(label,(labelCounts.get(label)??0)+1);
    }
    const targets:VerifiedAccount[]=[],proofs:{selector:string;accountId:string;credentialGeneration:number;observedAt:string;entitledModels:string[];clientVersion:string}[]=[];
    for(const account of accounts) {
      const cached=observations.get(account.id),label=numberedLabel(account);
      const selectors=Object.entries(current.config.codexAccountNamespaces??{}).filter(([name,id])=>id===account.id && name!=='main');
      if(!cached || !live(account.id,cached) || selectors.length!==1 || !label || labelCounts.get(label)!==1)continue;
      const selector=selectors[0][0];
      if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(selector) || ['main','__main__','openai','chatgpt-web'].includes(selector.toLowerCase()))continue;
      const entitledModels=[...new Set(cached.rows.map(row=>row.slug))];
      targets.push({selector,publicLabel:label,present:true,credentialAvailable:true,paused:false,entitledModels});
      proofs.push({selector,accountId:account.id,credentialGeneration:cached.generation,
        observedAt:new Date(cached.at).toISOString(),entitledModels,clientVersion:cached.clientVersion});
    }
    const pinned=targets.length && stock.some(row=>row.slug===SOL_MODEL)
      ?makePinnedHighRows({models:stock},targets.sort((a,b)=>Number(a.publicLabel.slice(3))-Number(b.publicLabel.slice(3)))):[];
    return {models:[...stock,...pinned],accountRosterProofs:proofs,
      accountRosterProofsStatus:proofs.length===0?'UNSUPPORTED':proofs.length===accounts.length?'SUPPORTED':'PARTIAL'};
  }
  return {owner,settings,select,refresh:usage,generationLive:owner.generationLive,
    readOriginalIssuerIdentity(threadId:string,wireModel:string) {
      // Read only the exact thread's terminal serving account. Active/pinned
      // picker state and legacy rows without generation are not provenance.
      const work=selectionTail.catch(()=>{}).then(async()=>{
        if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(threadId)||
          !/^[\w.-]{1,128}$/.test(wireModel))throw Error('original_issuer_identity_parameters_required');
        await owner.refreshSnapshot(true);
        const key=createHash('sha256').update(threadId).digest('hex').slice(0,32);
        fence.assertIdle(key);
        const issuer=issuers.get(key),snap=owner.currentSnapshot();
        if(fence.unresolved(key)||!issuer||!Number.isFinite(issuer.completedAt)||
          issuer.generation===undefined||issuer.wireModel!==wireModel||
          !owner.generationLive(issuer.accountId,issuer.generation)||terminalAuth(snap.records[issuer.accountId])||
          snap.config.codexAccounts.filter((a:any)=>a.id===issuer.accountId&&!a.isMain).length!==1||
          (snap.config.pausedCodexAccountIds??[]).includes(issuer.accountId))
          throw Error('original_issuer_terminal_identity_unverified');
        return {schemaVersion:1,kind:'aicc-ocx-original-thread-issuer-identity/v1',threadId,wireModel,
          accountIdSha256:createHash('sha256').update(issuer.accountId).digest('hex'),
          credentialGeneration:issuer.generation,observedAt:new Date().toISOString(),
          identityOnly:true,dispatchable:false,issuerAuthorityGranted:false};
      });
      selectionTail=work.then(()=>{},()=>{});return work;
    },
    noteOriginalQuotaRefusal:(request:Request,reason:'window_threshold'|'window_stop_policy')=>{
      const prior=selectedQuotaGeneration.get(request);
      selectedQuotaGeneration.delete(request);
      if(!prior||!owner.generationLive(prior.id,prior.generation)||
        readings.get(prior.id)?.generation!==prior.generation)return null;
      return originalQuota.recordRefusal(request,reason);
    },
    attestOriginalQuota:(input:{ownerRequestId:string;refusalSha256:string;
      requestId:string;threadId:string;turnId:string})=>originalQuota.attest(input),
    recoverOriginalQuota:(input:{ownerRequestId:string;attestationSha256:string})=>
      originalQuota.recover({...input,readSameAccount:freshOriginalAccountByHash}),
    originalIssuerAdmissionSupported:originalAdmission.supported,
    reserveOriginalIssuer(input:unknown,signal:AbortSignal) {
      const grant=parseOriginalIssuerGrant(input);
      const work=selectionTail.catch(()=>{}).then(()=>originalAdmission.reserve(grant,async()=>{
        const failed=originalQuota.readRefusal(grant.ownerRequestId,grant.refusalSha256);
        const bind=originalQuota.readAttestation(grant.ownerRequestId,grant.attestationSha256);
        if(failed.kind!=='aicc-ocx-original-fivehour-pre-dispatch-refusal/v1'||
          failed.dispatchStarted!==false||failed.replayed!==false||
          !/^[a-f0-9]{64}$/.test(failed.requestFingerprint??'')||
          failed.requestFingerprint===grant.continuationFingerprint||
          failed.quota?.providerLimitProven!==true||failed.quota.windowDurationMins!==300||
          failed.quota.usedPercent!==100||failed.quota.backendUsageAllowed!==false||
          failed.correlation?.requestId!==grant.originalRequestId||failed.correlation?.threadId!==grant.threadId||
          failed.correlation?.turnId!==grant.originalTurnId||
          bind.kind!=='aicc-ocx-management-bound-turn-correlation/v1'||bind.managementTurnCorrelationBound!==true||
          bind.refusalSha256!==grant.refusalSha256||bind.requestId!==grant.originalRequestId||
          bind.threadId!==grant.threadId||bind.turnId!==grant.originalTurnId||
          bind.accountIdSha256!==failed.accountIdSha256||bind.credentialGeneration!==failed.credentialGeneration)
          throw Error('original_issuer_original_chain_unverified');
        const result=await originalQuota.recover({ownerRequestId:grant.ownerRequestId,
          attestationSha256:grant.attestationSha256,readSameAccount:freshOriginalAccountByHash});
        if(result.state!=='ORIGINAL_SAME_ACCOUNT_FRESH_QUOTA_SOURCE_ONLY')throw Error('original_issuer_fresh_quota_required');
        await owner.refreshSnapshot(true);
        const snap=owner.currentSnapshot();
        const ids=Object.keys(snap.records).filter(id=>id!=='__main__'&&
          createHash('sha256').update(id).digest('hex')===failed.accountIdSha256);
        const id=ids[0],reading=readings.get(id),raw=rawQuotaWindows.get(id);
        if(ids.length!==1||!owner.generationLive(id,failed.credentialGeneration)||terminalAuth(snap.records[id])||
          !snap.config.codexAccounts.some((a:any)=>a.id===id&&!a.isMain)||
          (snap.config.pausedCodexAccountIds??[]).includes(id)||
          (snap.config.activeCodexAccountPinned&&snap.config.activeCodexAccountPinned!==id)||
          !admission(id).allowed||!reading||reading.at<failed.quota.resetsAt*1000||
          !raw?.window||raw.window.backendUsageAllowed!==true||raw.window.resetsAt*1000<=Date.now())
          throw Error('original_issuer_exact_account_unavailable');
        return {accountId:id,generation:failed.credentialGeneration};
      },signal));
      selectionTail=work.then(()=>{},()=>{});return work;
    },
    readOriginalQuotaRefusal:(id:string,sha:string)=>originalQuota.readRefusal(id,sha),
    async synchronize(manualUse=false) {
      const snap=await owner.refreshSnapshot(true);
      const configPath=localConfigPath;
      const local=JSON.parse(readFileSync(configPath,'utf8'));
      // Mirror policy/labels only. A1 credentials, paths and refresh grants never
      // enter the Windows supplier config or its private Native profile.
      local.codexAccounts=snap.config.codexAccounts.map((row:any)=>Object.fromEntries(
        ['id','email','alias','plan','logLabel'].filter(key=>row[key]!==undefined).map(key=>[key,row[key]])));
      for(const key of ['codexAccountNamespaces','pausedCodexAccountIds','codexAccountPriorities',
        'activeCodexAccountId','activeCodexAccountPinned','accountPoolStrategy','accountPoolStickyLimit','codexAccountPriorityFailback']) {
        if(snap.config[key]!==undefined)local[key]=snap.config[key];else delete local[key];
      }
      const temporary=configPath+'.'+crypto.randomUUID()+'.tmp';
      writeFileSync(temporary,JSON.stringify(local)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});renameSync(temporary,configPath);
      mirroredPinSnapshot=snap;pinMirrorStatus='in_sync';
      // G1-24: A1 PUT active keeps only the pin and leaves activeCodexAccountId null.
      const pin=snap.config.activeCodexAccountPinned;
      const active=typeof pin==='string' && pin ? pin : snap.config.activeCodexAccountId;
      if(manualUse && typeof active==='string' && snap.records[active])persistSelection(active);
      return {ok:true,requestExecution:'windows-local',credentialWriter:'a1'};
    },
    async describeAccounts(refresh=false) {
      const snap=await owner.refreshSnapshot();
      if(refresh)await Promise.all(snap.config.codexAccounts.filter((row:any)=>
        !(snap.config.pausedCodexAccountIds??[]).includes(row.id) && snap.records[row.id]).map((row:any)=>usage(row.id)));
      return {accounts:snap.config.codexAccounts.map((row:any)=>{
        const reading=readings.get(row.id);
        const record=snap.records[row.id],failure=quotaFailures.get(row.id);
        const needsReauth=terminalAuth(record);
        const relevantFailure=failure && failure.generation===record?.generation?failure:null;
        const verified=!needsReauth && reading && owner.generationLive(row.id,reading.generation);
        return {id:row.id,email:row.email,alias:row.alias,plan:row.plan,logLabel:row.logLabel,isMain:false,
          quotaProtectionEnabled:settings(row.id).thresholdProtection!==false,
          quotaProtection:settings(row.id),
          paused:(snap.config.pausedCodexAccountIds??[]).includes(row.id),priority:snap.config.codexAccountPriorities?.[row.id]??0,
          hasCredential:!!record,needsReauth,
          authState:needsReauth?'reauth_required':record?.codexValidationPending===true?'validation_pending':relevantFailure?'retry_pending':'available',
          authReason:needsReauth?'credential_revoked_or_missing':relevantFailure?.code??null,
          quotaError:relevantFailure?.code??null,quotaRetryAt:relevantFailure?.retryAt??null,
          credentialGeneration:record?.generation??null,credentialOwner:'a1',
          quota:verified?{...reading.quota,updatedAt:reading.at}:null};
      })};
    },
    describeActive() {
      const config=owner.currentSnapshot()?.config;
      return {activeCodexAccountId:selected??null,pinned:!!config?.activeCodexAccountPinned,
        pinnedAccountId:config?.activeCodexAccountPinned??null,accountPoolStrategy:config?.accountPoolStrategy,
        accountPoolStickyLimit:config?.accountPoolStickyLimit,pinMirrorStatus};
    },
    beforeDispatch(request:Request) {assertOriginalSelection(request);fence.beforeDispatch(request);},
    noteSettlement(request:Request,outcome:RequestSettlement) {
      originalAdmission.settle(request);originalSelections.delete(request);
      fence.settle(request,outcome,()=>{
        const pending=pendingBindings.get(request);
        if(!pending) throw Error('conversation_binding_missing');
        const now=Date.now();
        issuers.set(pending.key,{accountId:pending.accountId,at:now,completedAt:now,portableHistory:pending.portableHistory,
          generation:pending.generation,wireModel:pending.wireModel});
        persistIssuers();
      });
      pendingBindings.delete(request);
    },
    unknownTurns:fence.unknownCount,
    inflightFenceTurns:fence.inflightCount,
    quota:(id:string)=>readings.get(id)?.quota??null,
    preparedBody:(request:Request)=>prepared.get(request),
    activeAccount:()=>selected,
    // Compatibility callers keep the array; private catalog obtains proof and
    // models from this single observation, never from a separately timed getter.
    catalog:async():Promise<any[]> => (await catalogSnapshot()).models,
    catalogSnapshot,
    discovery:(rows:any[])=>options.supplier.discovery?.(owner.currentSnapshot()?.config,rows)
      ?? rows.map(row=>({id:row.slug,object:'model',owned_by:'opencodex'})),
  };
}

async function boundedJson(response:Response,limit:number):Promise<any> {
  if(!response.body) throw Error('upstream_read_empty');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];
  let bytes=0;
  try {
    for(;;) {
      const row=await reader.read(); if(row.done) break;
      bytes+=row.value.byteLength;
      if(bytes>limit) throw Error('upstream_read_limit');
      chunks.push(row.value);
    }
    const all=new Uint8Array(bytes); let at=0;
    for(const chunk of chunks) {all.set(chunk,at);at+=chunk.length;}
    return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(all));
  } catch {try{await reader.cancel();}catch{} throw Error('upstream_metadata_unverified');}
  finally {reader.releaseLock();}
}
