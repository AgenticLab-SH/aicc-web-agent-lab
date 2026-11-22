// AICC-owned composition root. Stock source, account storage and Native Codex
// remain independent. Operating listeners require an accepted immutable release.
import { readFileSync, realpathSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { externalTokenMatches } from './external-auth';
import { createRegisteredA1BrokerTransport } from './external-broker-transport';
import { createExternalPoolState } from './external-pool-state';
import { createNativeOriginalIssuerBridge } from './external-original-issuer-bridge';
import { startRegisteredOriginalIssuerListener } from './external-original-issuer-listener';
import { startRegisteredOriginalIssuerBootstrap } from './external-original-issuer-bootstrap';
import { createExternalOcxHttpBoundary } from './external-http-boundary';
import { bindOfficialOcxDispatch } from './external-stock-dispatch';
import { startOfficialManagement } from './external-stock-management';
import { createExternalResponseSocket } from './external-response-socket';
import { failureHeaders, type SafeFailure } from './external-safe-fault';
import { assertPlainStagePaths, resolveOwnerStage, stageCandidatePolicyMatches, stageRequestAllowed } from './external-owner-stage';

const manifestPath=process.argv[2];
if(!manifestPath || !isAbsolute(manifestPath)) throw Error('external_release_manifest_required');
const releaseRoot=dirname(realpathSync(manifestPath));
const manifestBytes=readFileSync(manifestPath);
const manifest=JSON.parse(manifestBytes.toString('utf8'));
if(manifest.schema!=='aicc-external-ocx-release/v1' || !['2.81.0','2.96.0'].includes(manifest.supplierVersion)
  || manifest.requestExecution!=='windows-local' || manifest.credentialWriter!=='a1'
  || manifest.nativeExcluded!==true) throw Error('external_release_identity_invalid');
if(!manifest.supplierFiles || !Object.keys(manifest.supplierFiles).length) throw Error('external_supplier_inventory_required');
for(const [name,hash] of Object.entries(manifest.supplierFiles) as [string,string][]) {
  if(name.startsWith('/') || name.includes('..') || name.includes('\\') || !/^[a-f0-9]{64}$/.test(hash)) throw Error('external_supplier_inventory_invalid');
  if(createHash('sha256').update(readFileSync(join(manifest.supplierRoot,name))).digest('hex')!==hash) throw Error('external_supplier_changed');
}
for(const [name,hash] of Object.entries(manifest.adapterFiles) as [string,string][]) {
  if(!/^[\w.-]+\.ts$/.test(name) || !/^[a-f0-9]{64}$/.test(hash)) throw Error('external_adapter_inventory_invalid');
  const actual=createHash('sha256').update(readFileSync(join(releaseRoot,name))).digest('hex');
  if(actual!==hash) throw Error('external_adapter_changed');
}
const acceptance=JSON.parse(readFileSync(join(releaseRoot,'compatibility-acceptance.json'),'utf8'));
const acceptanceHash=createHash('sha256').update(readFileSync(join(releaseRoot,'compatibility-acceptance.json'))).digest('hex');
const required=['stockArtifact','credentialOwner','windowAdmission','inflightLifetime','manualAccountPolicy',
  'modelEntitlements','nativeIsolation','catalogParity','continuationParity','transportParity','managementParity','softwareRollback',
  'requestCompression','legacyManagementAuth'];
const exactInventory=(left:any,right:any)=>left && right && typeof left==='object' && typeof right==='object'
  && !Array.isArray(left) && !Array.isArray(right) && Object.keys(left).length>0
  && Object.keys(left).length===Object.keys(right).length
  && Object.entries(left).every(([name,hash])=>typeof hash==='string' && /^[a-f0-9]{64}$/.test(hash) && right[name]===hash);
const compatibilityAccepted=acceptance.schema==='aicc-external-ocx-acceptance/v1'
  && required.every(key=>acceptance.checks?.[key]?.status==='PASS' && typeof acceptance.checks[key].evidence==='string')
  && (manifest.supplierVersion==='2.81.0' || (acceptance.verification==='FIXTURE_PASS'
    && exactInventory(acceptance.sourceSha256,manifest.adapterFiles)
    && exactInventory(acceptance.supplierFiles,manifest.supplierFiles)));
let explicitInstallAccepted=false;
if(manifest.supplierVersion==='2.81.0' && acceptance.schema==='aicc-external-ocx-user-install-acceptance/v1') {
  const decisionBytes=readFileSync(join(releaseRoot,'user-install-decision.json'));
  const decision=JSON.parse(decisionBytes.toString('utf8'));
  explicitInstallAccepted=createHash('sha256').update(decisionBytes).digest('hex')===acceptance.userDecisionSha256
    && (decision.schema==='aicc-exact-ocx-user-install-decision/v1'
      || (decision.schema==='aicc-exact-ocx-user-install-decision/v2'
        && decision.scopeRevision==='g1-rotation-lifecycle-r2-r3'
        && manifest.scopeRevision===decision.scopeRevision && manifest.operationId===decision.operationId
        && typeof decision.operationId==='string' && /^[a-z0-9][a-z0-9-]{7,120}$/.test(decision.operationId)
        && Object.keys(manifest.adapterFiles).length>=14
        && typeof manifest.adapterFiles['external-conversation-lifecycle.ts']==='string'
        && typeof manifest.adapterFiles['window-inflight-monitor.ts']==='string'))
    && decision.action==='INSTALL_EXACT_UNVERIFIED_OCX_DELTA' && decision.installationExplicitlyRequested===true
    && typeof decision.userInstruction==='string' && decision.userInstruction.trim().length>0
    && typeof decision.controllerThreadId==='string' && /^[a-f0-9-]{36}$/.test(decision.controllerThreadId)
    && decision.target==='ocx-only' && decision.verification==='NOT_RUN'
    && acceptance.verification==='NOT_RUN' && acceptance.compatibilityPassed===false
    && /^[a-f0-9]{64}$/.test(decision.inputPackSha256)
    && /^[a-f0-9]{64}$/.test(decision.previousManifestSha256)
    && exactInventory(decision.sourceSha256,manifest.adapterFiles)
    && exactInventory(acceptance.sourceSha256,manifest.adapterFiles)
    && required.every(key=>acceptance.checks?.[key]?.status==='NOT_RUN');
}
const stageProfile=process.env.AICC_ORIGINAL_OWNER_STAGE_PROFILE;
const profile=stageProfile??homedir();
const registryPath=join(profile,'.ai-control-center','runtime','ocx-local','current.json');
const registry=JSON.parse(readFileSync(registryPath,'utf8'));
const ownerStage=resolveOwnerStage(registry,profile,userInfo().homedir);
if(stageProfile&&!ownerStage)throw Error('explicit_original_owner_stage_contract_required');
if(ownerStage)assertPlainStagePaths([registryPath,registry.opencodexHome,registry.tokenFile]);
if(registry.schemaVersion!==1 || registry.requestExecution!=='windows-local' || registry.credentialWriter!=='a1'
  || registry.cliPath!==realpathSync(process.argv[1]) || registry.packageRoot!==manifest.supplierRoot
  || registry.version!==manifest.supplierVersion) throw Error('registered_external_runtime_owner_required');
const isolatedCandidateAccepted=Boolean(stageProfile && ownerStage && manifest.supplierVersion==='2.96.0'
  && acceptance.accepted===false && acceptance.fixtureOnly===false && compatibilityAccepted
  && registry.adapterManifest===realpathSync(manifestPath)
  && registry.manifestSha256===createHash('sha256').update(manifestBytes).digest('hex')
  && exactInventory(acceptance.nativeAdapterFiles,manifest.nativeAdapterFiles)
  && stageCandidatePolicyMatches(ownerStage,manifest.sharedLauncher,acceptance.sharedLauncher));
if(acceptanceHash!==manifest.acceptanceSha256 || acceptance.supplierVersion!==manifest.supplierVersion
  || (!isolatedCandidateAccepted
    && (acceptance.accepted!==true || (!compatibilityAccepted && !explicitInstallAccepted)))) {
  throw Error('external_compatibility_acceptance_required');
}
const home=realpathSync(registry.opencodexHome);
const expectedHome=realpathSync(join(profile,'.ai-control-center','runtime','ocx-local','home'));
if(home.toLowerCase()!==expectedHome.toLowerCase()) throw Error('registered_external_home_required');
const privateCodexHome=join(home,'external-stock-codex');
mkdirSync(privateCodexHome,{recursive:true});
process.env.OPENCODEX_HOME=home;
process.env.CODEX_HOME=privateCodexHome;
const stock=await bindOfficialOcxDispatch(manifest.supplierRoot,manifest.supplierVersion);
const localConfig=JSON.parse(readFileSync(join(home,'config.json'),'utf8'));
if(localConfig.codexNativeSteering===true || localConfig.codexNativeInjection===true) throw Error('external_native_control_compatibility_required');
// Concrete authority is composed here. Only a trusted native host may bind an
// already authenticated original session; current standalone launcher has none.
// No JSON/config/management endpoint can manufacture that missing capability.
export const originalIssuerBridge=createNativeOriginalIssuerBridge();
// The registered service owns one private local socket for its entire Bun
// lifetime. A conversation release closes only that client's socket. Old
// installers without the protected directory remain safely unsupported.
const originalIssuerSocketListener=(()=>{
  try {
    const handle=process.env.AICC_ORIGINAL_ISSUER_BOOTSTRAP_HANDLE;
    delete process.env.AICC_ORIGINAL_ISSUER_BOOTSTRAP_HANDLE;
    if(handle) {
      const addon=join(releaseRoot,'original-issuer-bootstrap.node');
      const pinned=manifest.nativeAdapterFiles?.['original-issuer-bootstrap.node'];
      if(typeof pinned!=='string'||!/^[a-f0-9]{64}$/.test(pinned)
        ||dirname(realpathSync(addon))!==releaseRoot
        ||createHash('sha256').update(readFileSync(addon)).digest('hex')!==pinned)
        throw Error('original_issuer_bootstrap_immutable_pin_required');
      return startRegisteredOriginalIssuerBootstrap(originalIssuerBridge,addon,handle);
    }
    return startRegisteredOriginalIssuerListener(originalIssuerBridge,join(home,'oi','issuer.sock'));
  }catch {
    console.warn('original_issuer_socket_unavailable_no_unverified_fallback');
    return undefined;
  }
})();
void originalIssuerSocketListener;
const pool=createExternalPoolState({home,transport:createRegisteredA1BrokerTransport(),
  clientVersion:manifest.codexClientVersion,supplier:stock,
  originalIssuerAuthority:originalIssuerBridge.authority});
await pool.owner.refreshSnapshot(true);
const readToken=(file:string)=>readFileSync(file,'utf8').trim();
const tokenMatches=(request:Request,file:string)=>externalTokenMatches(request,readToken(file),file===managementToken);
const websocketInputs=new WeakSet<object>();
const socketRequests=new WeakSet<Request>();
// G1-23: in-memory only; a restart starts counting again and never hides a first refusal.
const repeatedFailures=new Map<string,{writtenAt:number;suppressed:number}>();
const boundary=createExternalOcxHttpBoundary({dataToken:()=>readToken(registry.tokenFile),
  settings:pool.settings,select:async(request,signal)=>{const lease=await pool.select(request,signal);
    if(socketRequests.has(request))websocketInputs.add(lease);return lease;},preparedBody:pool.preparedBody,
  generationLive:pool.generationLive,quota:pool.quota,refresh:pool.refresh,
  dispatch:(forwarded,lease)=>{if(websocketInputs.has(lease as object))stock.markWebsocketRequest(forwarded);return stock.dispatchFull(forwarded,lease);},
  dispatchEvidence:stock.dispatchEvidence,
  beforeDispatch:pool.beforeDispatch,
  noteSettlement:pool.noteSettlement,
  noteOriginalQuotaRefusal:pool.noteOriginalQuotaRefusal,
  noteFailure:(request,status,failure,continuation)=>{
    const uuid=(value:string|null)=>value && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)?value:null;
    // Codex 0.16x sends x-client-request-id; the older names stay as fallbacks. Without it,
    // 35 refusals in one turn could not be told apart (2026-10-31 G1 audit).
    const requestId=request.headers.get('x-request-id')??request.headers.get('x-codex-request-id')??request.headers.get('x-client-request-id');
    // Only two allowlisted short labels from turn metadata: which kind of request hit the fence
    // (e.g. a reviewer or subagent sharing the thread). No other metadata is stored.
    let requestKind:string|null=null,subagentKind:string|null=null;
    try {
      const raw=request.headers.get('x-codex-turn-metadata');
      if(raw && raw.length<=4096) {
        const meta=JSON.parse(raw),label=(v:unknown)=>typeof v==='string' && /^[a-z0-9_-]{1,40}$/i.test(v)?v:null;
        requestKind=label(meta?.request_kind);subagentKind=label(meta?.subagent_kind);
      }
    } catch { /* absent or malformed metadata stays null */ }
    const row={schemaVersion:1,kind:'ocx-request-failure',observedAt:new Date().toISOString(),
      requestId:requestId && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(requestId)?requestId:null,
      requestKind,subagentKind,
      threadId:uuid(request.headers.get('thread-id')??request.headers.get('session_id')??request.headers.get('session-id')),
      parentThreadId:uuid(request.headers.get('x-codex-parent-thread-id')),
      turnId:uuid(request.headers.get('x-codex-turn-id')??request.headers.get('turn-id')),
      status,failure,...(continuation?{continuation}:{}),automaticRetry:false};
    // G1-23/G1-05: a fenced conversation used to add one row per client retry (126 rows for one
    // request). Repeated pre-dispatch refusals of the same thread+code+status within 60 s are
    // counted in memory; the next written row carries how many were suppressed.
    const repeatKey=row.threadId && failure?.dispatchStarted===false ? row.threadId+'|'+failure.code+'|'+status : null;
    if(repeatKey) {
      const now=Date.now(),seen=repeatedFailures.get(repeatKey);
      if(seen && now-seen.writtenAt<60_000) {seen.suppressed++;return;}
      if(seen?.suppressed) (row as any).suppressedRepeats=seen.suppressed;
      repeatedFailures.set(repeatKey,{writtenAt:now,suppressed:0});
      if(repeatedFailures.size>1000) repeatedFailures.delete(repeatedFailures.keys().next().value!);
    }
    // Never include bodies, credentials, ciphertext, response/file IDs or raw exceptions.
    appendFileSync(join(home,'request-failures.jsonl'),JSON.stringify(row)+'\n',{encoding:'utf8',mode:0o600});
  },
  catalog:async request=>{
    const snapshot=await pool.catalogSnapshot();
    const url=new URL(request.url);
    // Account identity proofs belong only to the authenticated private catalog.
    // Standard model/client-version and discovery responses keep their shape.
    return Response.json(url.pathname.endsWith('/catalog') ? snapshot
      :url.searchParams.has('client_version') ? {models:snapshot.models}
      :{object:'list',data:pool.discovery(snapshot.models)},
      {headers:{'cache-control':'no-store'}});
  }});
// A stage does not register a connected machine or open the management UI.
const management=ownerStage ? undefined
  :await startOfficialManagement(manifest.supplierRoot,join(homedir(),'.opencodex','config.json'));
const responseSocket=createExternalResponseSocket({...stock,markWebsocketRequest:(request:Request)=>socketRequests.add(request)},boundary);
const managementToken=join(home,'admin-api-token');
const servers:any[]=[];
const sockets=responseSocket.sockets;
const startedAt=Date.now();
function refused(code:string,status=503,failure?:SafeFailure) {
  const headers=new Headers({'x-should-retry':'false'});
  failureHeaders(headers,status,failure);
  const unsupported=code==='external_route_contract_required';
  return Response.json({error:{code,...(unsupported?{type:'unsupported_route_error'}:{}),
    message:unsupported?'Requested route is not implemented by this AICC adapter.':'This operation requires the registered AICC owner.'}},
    {status,headers});
}
// Only the existing owner management token on port 10101 can bind a source
// refusal to a bridge-observed original request/turn. The data-client headers
// alone are correlation hints, not authentication. No account parameter.
async function readBoundedOriginalQuotaAttestation(request:Request) {
  const declared=Number(request.headers.get('content-length')??0);
  if(!Number.isFinite(declared)||declared<0||declared>4096||
     !request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw Error('original_quota_attestation_bounds');
  const reader=request.body?.getReader();
  if(!reader)throw Error('original_quota_attestation_body_required');
  const chunks:Uint8Array[]=[];let size=0;
  try{
    for(;;){
      const row=await reader.read();if(row.done)break;
      size+=row.value.byteLength;
      if(size>4096)throw Error('original_quota_attestation_too_large');
      chunks.push(row.value);
    }
  }finally{try{await reader.cancel();}catch{}reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  const keys=['schemaVersion','kind','ownerRequestId','refusalSha256','requestId','threadId','turnId'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||
    keys.some(k=>!Object.hasOwn(value,k))||value.schemaVersion!==1||
    value.kind!=='aicc-17841-original-turn-binding/v1')
    throw Error('original_quota_attestation_shape');
  return value;
}
async function handle(request:Request,server:any):Promise<Response|undefined> {
  const url=new URL(request.url);
  if(!stageRequestAllowed(ownerStage,request.method,url.pathname))
    return refused('original_owner_stage_no_dispatch_or_mutation',403);
  if(url.pathname==='/api/aicc-local/original-issuer/identity') {
    if(server.port!==(ownerStage?.managementPort??10101)||!['127.0.0.1','localhost'].includes(url.hostname)||
      request.method!=='GET'||!tokenMatches(request,managementToken))return refused('authentication_error',401);
    const keys=[...url.searchParams.keys()];
    if(keys.length!==2||new Set(keys).size!==2||!keys.includes('threadId')||!keys.includes('wireModel'))
      return refused('original_issuer_identity_parameters_required',409);
    try {
      const result=await pool.readOriginalIssuerIdentity(url.searchParams.get('threadId')??'',url.searchParams.get('wireModel')??'');
      return Response.json(result,{headers:{'cache-control':'no-store'}});
    }catch{return refused('original_issuer_terminal_identity_unverified',409);}
  }
  if(url.pathname==='/api/aicc-local/original-issuer/admission') {
    // The management token authenticates this channel, never the native grant.
    // No provider is registered by JSON/config/epoch files. Until the original
    // runtime transport supplies the synchronous native fence, fail closed.
    if(server.port!==10101||!['127.0.0.1','localhost'].includes(url.hostname)||
      request.method!=='POST'||!tokenMatches(request,managementToken))return refused('authentication_error',401);
    if(!pool.originalIssuerAdmissionSupported())return refused('original_issuer_native_dispatch_fence_unavailable',409);
    if(boundary.isDraining())return refused('maintenance_draining',409);
    try {
      if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))throw Error('content_type');
      const reader=request.body?.getReader();if(!reader)throw Error('body_required');
      const chunks:Uint8Array[]=[];let size=0;
      try{for(;;){const row=await reader.read();if(row.done)break;size+=row.value.byteLength;
        if(size>4096)throw Error('body_bounds');chunks.push(row.value);}}
      finally{try{await reader.cancel();}catch{}reader.releaseLock();}
      const grant=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));
      const result=await pool.reserveOriginalIssuer(grant,request.signal);
      return Response.json(result,{headers:{'cache-control':'no-store'}});
    }catch{return refused('original_issuer_admission_unconfirmed_no_retry',409);}
  }
  if(request.headers.get('upgrade')?.toLowerCase()==='websocket') {
    if(request.method!=='GET' || !/^\/(?:v1\/)?responses$/.test(url.pathname)) return refused('external_websocket_route_not_supported',426);
    if(!tokenMatches(request,registry.tokenFile)) return refused('authentication_error',401);
    if(boundary.isDraining()) return refused('maintenance_draining');
    const headers=new Headers(request.headers);
    headers.delete('upgrade'); headers.delete('connection'); headers.delete('sec-websocket-key');
    headers.set('x-aicc-socket-session',crypto.randomUUID());
    if(server.upgrade(request,{data:{headers,url:request.url,busy:false,turnId:0,controller:undefined}})) return undefined;
    return refused('websocket_upgrade_not_completed',400);
  }
  if(['GET','HEAD'].includes(request.method) && ['/readyz','/healthz','/livez'].includes(url.pathname)) {
    return Response.json({service:'opencodex',status:boundary.isDraining()?'draining':'ok',pid:process.pid,port:server.port,
      uptimeSeconds:Math.floor((Date.now()-startedAt)/1000),restartCapability:1,ownershipProtocolVersion:1,
      ready:!boundary.isDraining(),state:boundary.isDraining()?'draining':'ready',
      version:manifest.supplierVersion,upstreamVersion:manifest.supplierVersion,
      adapterVersion:manifest.adapterVersion,requestExecution:'windows-local',credentialWriter:'a1',
      activeTurns:boundary.activeTurns(),localActive:boundary.activeTurns(),unknownTurns:pool.unknownTurns(),
      // G1-07: maintenance gates on live work only. unknownTurns are durable
      // per-conversation fence rows that a restart reloads unchanged.
      inflightFenceTurns:pool.inflightFenceTurns(),unknownTurnsScope:'historical-request-evidence',unknownTurnsSurviveRestart:true,
      conversationUnknownBlocks:false,requestReplayProtection:'semantic-fingerprint',
      maintenanceIdle:boundary.activeTurns()===0&&pool.inflightFenceTurns()===0&&[...sockets].every(socket=>!socket.data.busy),
      activeWebSockets:[...sockets].filter(socket=>socket.data.busy).length,nativeExcluded:true});
  }
  if(/^\/(?:v1\/)?(?:responses(?:\/compact)?|models|catalog|alpha\/search)$/.test(url.pathname)) return boundary.handle(request);
  if(url.pathname==='/api/aicc-local/original-quota/attest') {
    if(server.port!==10101||request.method!=='POST'||!tokenMatches(request,managementToken))
      return refused('authentication_error',401);
    try{
      const value=await readBoundedOriginalQuotaAttestation(request);
      const result=pool.attestOriginalQuota(value);
      return Response.json({schemaVersion:1,state:'ORIGINAL_OCX_MANAGEMENT_CORRELATION_BOUND_SOURCE_ONLY',
        ...result,originalCodexTurnTerminalVerified:false,goalVerified:false,
        stopEpochVerified:false,writerReturnedVerified:false,issuerAuthorityGranted:false},
        {headers:{'cache-control':'no-store'}});
    }catch{return refused('original_quota_attestation_unverified',409);}
  }
  if(url.pathname==='/api/aicc-local/original-quota/recovery') {
    if(server.port!==10101||request.method!=='GET'||!tokenMatches(request,managementToken))
      return refused('authentication_error',401);
    const keys=[...url.searchParams.keys()];
    if(keys.length!==2||new Set(keys).size!==2||
      !keys.includes('ownerRequestId')||!keys.includes('attestationSha256'))
      return refused('original_quota_exact_recovery_pin_required',409);
    try{
      const result=await pool.recoverOriginalQuota({
        ownerRequestId:url.searchParams.get('ownerRequestId')??'',
        attestationSha256:url.searchParams.get('attestationSha256')??''});
      return Response.json(result,{headers:{'cache-control':'no-store'}});
    }catch{return refused('original_quota_same_account_recovery_unverified',409);}
  }
  if(url.pathname==='/api/aicc-local/policy' && request.method==='GET') {
    if(!tokenMatches(request,managementToken)) return refused('authentication_error',401);
    await pool.owner.refreshSnapshot();
    const rules=pool.settings();
    return Response.json({schemaVersion:1,version:manifest.supplierVersion,
      requestExecution:'windows-local',credentialWriter:'a1',
      fiveHourUsedThreshold:rules.fiveHour.usedThreshold,longWindowUsedThreshold:rules.longWindow.usedThreshold,
      fiveHourAction:rules.fiveHour.action,longWindowAction:rules.longWindow.action,
      settingsSupported:true,strictAdmission:true,freshQuotaRequired:true,
      accountQuotaProtectionSupported:true,
      accountQuotaWindowOverridesSupported:true,
      scope:'Windows local pool requests only'}, {headers:{'cache-control':'no-store'}});
  }
  if(url.pathname==='/api/aicc-local/drain' && request.method==='POST') {
    if(!tokenMatches(request,managementToken)) return refused('authentication_error',401);
    const idle=boundary.drain();
    responseSocket.closeIdle();
    return Response.json({draining:true,activeTurns:boundary.activeTurns(),idle});
  }
  if(url.pathname==='/api/aicc-local/sync' && request.method==='POST') {
    if(!tokenMatches(request,managementToken)) return refused('authentication_error',401);
    return Response.json(await pool.synchronize(request.headers.get('x-aicc-local-use')==='1'));
  }
  if(['/api/codex-auth/accounts','/api/codex-auth/active','/api/system/memory'].includes(url.pathname)) {
    if(!tokenMatches(request,managementToken))return refused('authentication_error',401);
    if(request.method!=='GET')return refused('account_mutations_require_a1_owner',403);
    const result=url.pathname.endsWith('/accounts')?await pool.describeAccounts(url.searchParams.get('refresh')==='1')
      :url.pathname.endsWith('/active')?pool.describeActive()
      :{activeTurnCount:boundary.activeTurns(),isDraining:boundary.isDraining(),requestExecution:'windows-local'};
    return Response.json(result,{headers:{'cache-control':'no-store'}});
  }
  if(url.pathname.startsWith('/api/')) {
    return management ? management.handle(request) : refused('original_owner_stage_no_management',403);
  }
  if(request.method!=='GET') return refused('external_route_contract_required',404);
  return management ? management.handle(request) : refused('original_owner_stage_no_management',403);
}
if(ownerStage && Date.now()>=ownerStage.expiresAt) throw Error('original_owner_stage_expired_before_listen');
try {
  for(const port of ownerStage?.ports??[10100,10101]) servers.push(Bun.serve({hostname:'127.0.0.1',port,
    maxRequestBodySize:32*1024*1024,idleTimeout:0,
    fetch:(request,server)=>handle(request,server).catch(error=>
      refused('external_operation_not_completed',503,boundary.failureFor(request,error))),
    websocket:responseSocket.handlers
  }));
} catch (error) {for(const server of servers) server.stop(true);management?.stop();throw error;}
if(ownerStage) {
  // One bounded process lifetime; expiration never restarts a stage.
  setTimeout(()=>{for(const server of servers)server.stop(true);process.exit(0);},
    Math.max(0,ownerStage.expiresAt-Date.now()));
}
// No credential or request body is written to status output.
console.log(JSON.stringify({event:'external-ocx-started',version:manifest.supplierVersion,adapterVersion:manifest.adapterVersion}));
