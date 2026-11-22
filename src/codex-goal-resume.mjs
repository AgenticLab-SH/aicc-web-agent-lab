import {createHash,createPublicKey,verify} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function goalSnapshotSha256(goal) {
  return createHash('sha256').update(JSON.stringify([
    goal.threadId,goal.objective,goal.status,goal.tokenBudget??null,goal.createdAt,goal.updatedAt
  ])).digest('hex');
}

// Explicit user resume only; never used as a quota timer or parent-result authority.
// The caller supplies the existing authenticated owner transport and pinned manifest.
export async function resumeExistingThreadGoal({client,manifest,threadId,projectRoot,
  expectedGoalSha256,authorization}={}) {
  if(!UUID.test(threadId??'')||!path.isAbsolute(projectRoot??'')||
    authorization?.kind!=='explicit-user-goal-resume'||authorization.threadId!==threadId||
    typeof authorization.reference!=='string'||!authorization.reference.trim())
    throw Error('goal_resume_explicit_user_authorization_required');
  if(manifest?.userGoalResume?.method!=='thread/goal/set'||
    manifest.userGoalResume.provenanceField!=='origin'||
    !manifest.productionStableAllowlist?.includes('thread/goal/get')||
    !manifest.productionStableAllowlist?.includes('thread/read'))
    throw Error('goal_resume_installed_contract_required');
  if(!/^[a-f0-9]{64}$/.test(expectedGoalSha256??''))throw Error('goal_resume_snapshot_required');
  const {thread}=await client.threadRead({threadId,includeTurns:false});
  if(thread?.id!==threadId||typeof thread.cwd!=='string'||path.resolve(thread.cwd)!==path.resolve(projectRoot))
    throw Error('goal_resume_thread_root_mismatch');
  if(!['active','idle'].includes(thread.status?.type))
    throw Error('goal_resume_original_owner_transport_required');
  const {goal}=await client.threadGoalGet({threadId});
  if(!goal||goal.threadId!==threadId||goalSnapshotSha256(goal)!==expectedGoalSha256)
    throw Error('goal_resume_snapshot_changed');
  if(goal.status==='active')return {state:'ALREADY_ACTIVE',mutations:0,goal};
  // usageLimited requires fresh original-issuer quota evidence in its own contract.
  if(!['blocked','paused'].includes(goal.status))throw Error('goal_resume_status_requires_separate_contract');
  let response;
  try {
    // Omit objective/tokenBudget: preserves the original goal and usage history.
    response=await client.threadGoalResumeForUser({threadId},authorization);
  }catch(error){
    // A transport timeout may follow a committed mutation. Return a readback-only
    // reconciliation instruction; never automatically repeat this request.
    return {state:'RESUME_UNCONFIRMED',mutations:1,automaticRetry:false,
      errorCode:error?.code??null,nextAction:'read_exact_goal_before_any_new_resume'};
  }
  const after=response?.goal;
  if(!after||after.threadId!==threadId||after.status!=='active'||
    after.objective!==goal.objective||after.createdAt!==goal.createdAt||
    (after.tokenBudget??null)!==(goal.tokenBudget??null)||
    after.tokensUsed<goal.tokensUsed||after.timeUsedSeconds<goal.timeUsedSeconds)
    return {state:'RESUME_UNCONFIRMED',mutations:1,automaticRetry:false,
      nextAction:'read_exact_goal_before_any_new_resume'};
  return {state:'GOAL_ACTIVE',mutations:1,goal:after,automaticQuotaResumeProven:false};
}
/**
 * A minimum official read chain on the caller's EXISTING, owned App Server
 * connection. It cannot infer the original shared-HOME/17841/OCX issuer,
 * ownerRevision, stopEpoch, failure turn or old queue ACK from a rate-limit API.
 * There is deliberately no sender/claim/scheduler transition in this function.
 */
export async function inspectExistingGoalQuotaWindow({client,manifest,threadId,
  projectRoot,expectedGoalSha256,now=Date.now}={}) {
  if(!UUID.test(threadId??'')||!path.isAbsolute(projectRoot??'')||
    !/^[a-f0-9]{64}$/.test(expectedGoalSha256??'')||
    manifest?.officialQuotaRead?.method!=='account/rateLimits/read'||
    manifest.officialQuotaRead.readOnly!==true||
    manifest.officialQuotaRead.originalCliIssuerBound!==false||
    manifest.officialQuotaRead.quotaRecoveryAuthority!==false||
    manifest.officialQuotaRead.senderAllowed!==false||
    !manifest.productionStableAllowlist?.includes('account/rateLimits/read')||
    !manifest.productionStableAllowlist?.includes('thread/read')||
    !manifest.productionStableAllowlist?.includes('thread/goal/get')||
    typeof client?.rateLimitsReadForInspection!=='function')
    throw Error('quota_read_exact_installed_contract_required');
  const base={schemaVersion:1,kind:'aicc-original-goal-official-quota-observation',
    threadId,readOnly:true,goalChanged:false,goalCreated:false,
    originalIssuerVerified:false,ownerRevisionVerified:false,stopEpochVerified:false,
    failureTurnVerified:false,originalQueueAckVerified:false,sameOcxAccountVerified:false,
    originalWriterReturned:false,dispatchable:false,automaticRetry:false,
    modelRequests:0,newTurns:0,queueOperations:0};
  const {thread}=await client.threadRead({threadId,includeTurns:false});
  if(thread?.id!==threadId||typeof thread.cwd!=='string'||
    path.resolve(thread.cwd)!==path.resolve(projectRoot)||
    !['active','idle'].includes(thread.status?.type))
    return {...base,state:'ORIGINAL_APP_SERVER_THREAD_OR_OWNER_UNVERIFIED_HOLD'};
  const {goal}=await client.threadGoalGet({threadId});
  if(!goal||goal.threadId!==threadId||
    goalSnapshotSha256(goal)!==expectedGoalSha256)
    return {...base,state:'ORIGINAL_GOAL_SNAPSHOT_CHANGED_HOLD'};
  if(goal.status!=='active')
    return {...base,state:'GOAL_NOT_ACTIVE_HOLD',goalStatus:goal.status};
  let quota;
  try{quota=await client.rateLimitsReadForInspection();}
  catch(error){return {...base,state:'OFFICIAL_QUOTA_READ_UNKNOWN_NO_RETRY',
    errorCode:String(error?.code??'read_failed').slice(0,80)};}
  const byId=quota?.rateLimitsByLimitId;
  const buckets=byId&&typeof byId==='object'&&!Array.isArray(byId)
    ?Object.values(byId):[quota?.rateLimits];
  const fiveHour=[];
  for(const bucket of buckets){
    if(!bucket||typeof bucket!=='object'||!['codex','codex_other'].includes(bucket.limitId))
      continue;
    for(const name of ['primary','secondary']){
      const row=bucket[name];
      if(row?.windowDurationMins===300)
        fiveHour.push({limitId:bucket.limitId,window:name,
          usedPercent:row.usedPercent,resetsAt:row.resetsAt,
          reachedType:bucket.rateLimitReachedType??null});
    }
  }
  if(fiveHour.length!==1)
    return {...base,state:fiveHour.length?'AMBIGUOUS_FIVE_HOUR_QUOTA_BUCKET_HOLD':
      'FIVE_HOUR_QUOTA_BUCKET_NOT_RETURNED_HOLD',observedBucketCount:fiveHour.length};
  const window=fiveHour[0],observedMs=now();
  if(!Number.isFinite(observedMs)||!Number.isFinite(window.usedPercent)||
    window.usedPercent<0||window.usedPercent>100||
    !Number.isSafeInteger(window.resetsAt)||window.resetsAt<=0)
    return {...base,state:'OFFICIAL_QUOTA_WINDOW_INVALID_HOLD'};
  const snapshot={limitId:window.limitId,window:window.window,
    usedPercent:window.usedPercent,resetsAt:window.resetsAt,
    observedAt:new Date(observedMs).toISOString()};
  if(window.usedPercent>=100||window.reachedType!==null)
    return {...base,state:'OFFICIAL_FIVE_HOUR_QUOTA_STILL_LIMITED_HOLD',quota:snapshot};
  return {...base,state:'OFFICIAL_FIVE_HOUR_WINDOW_READABLE_OWNER_RELEASE_HOLD',
    quota:snapshot,needs:['exact_original_issuer_failed_turn_receipt',
      'same_OCX_account_route_and_fresh_admission','ownerRevision_and_stopEpoch',
      'original_writer_release','historical_pending_issuer_settlement',
      'original_sender_one_time_ack_and_new_turn']};
}
const QUOTA_SHA=/^[a-f0-9]{64}$/;
const shaJson=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

// Reconcile an existing queue receipt on its original, already connected
// transport. An empty queue, archived rollout or notLoaded thread is never
// evidence that the original request completed. This read cannot settle the
// registry or grant a subsequent sender permission.
export async function inspectOriginalQueuedRequest({client,manifest,threadId,
 projectRoot,attempt,expectedAttemptSha256,maxPages=8}={}) {
 const base={kind:'aicc-original-queue-inspection/v1',readOnly:true,
  pendingPreserved:true,dispatchable:false,modelRequests:0,newTurns:0,
  queueMutations:0,automaticReplay:false};
 const hold=state=>({...base,state});
 if(!UUID.test(threadId??'')||!path.isAbsolute(projectRoot??'')||
  !attempt||attempt.threadId!==threadId||!UUID.test(attempt.id??'')||
  !UUID.test(attempt.queuedMessageId??'')||
  attempt.transport!=='codex-queue'||attempt.automaticReplay!==false||
  attempt.marker!=='AICC_QUEUE_ATTEMPT:'+attempt.id||
  !QUOTA_SHA.test(attempt.messageSha256??'')||
  !QUOTA_SHA.test(expectedAttemptSha256??'')||shaJson(attempt)!==expectedAttemptSha256||
  !Number.isInteger(maxPages)||maxPages<1||maxPages>32||
  !['thread/read','thread/queue/list'].every(m=>manifest?.productionStableAllowlist?.includes(m))||
  typeof client?.threadRead!=='function'||typeof client?.threadQueueListForInspection!=='function')
  throw Error('original_queue_exact_receipt_and_read_contract_required');
 const receipt=JSON.stringify(attempt);
 const unchanged=()=>JSON.stringify(attempt)===receipt;
 let before,after;const queued=[],cursors=new Set();let cursor=null;
 try {
  ({thread:before}=await client.threadRead({threadId,includeTurns:true}));
  if(before?.id!==threadId||path.resolve(before.cwd??'')!==path.resolve(projectRoot))
   return hold('ORIGINAL_QUEUE_THREAD_SCOPE_HOLD');
  for(let page=0;;page++) {
   if(page>=maxPages)return hold('ORIGINAL_QUEUE_INCOMPLETE_PAGINATION_HOLD');
   const response=await client.threadQueueListForInspection({threadId,limit:100,...(cursor?{cursor}:{})});
   if(!Array.isArray(response?.data)||response.data.length>100||
      (response.nextCursor!=null&&(typeof response.nextCursor!=='string'||!response.nextCursor)))
    return hold('ORIGINAL_QUEUE_INVALID_RESPONSE_HOLD');
   queued.push(...response.data);
   if(response.nextCursor==null)break;
   if(cursors.has(response.nextCursor))return hold('ORIGINAL_QUEUE_CURSOR_CYCLE_HOLD');
   cursors.add(response.nextCursor);cursor=response.nextCursor;
  }
  ({thread:after}=await client.threadRead({threadId,includeTurns:true}));
 }catch{return hold('ORIGINAL_QUEUE_READ_UNAVAILABLE_HOLD');}
 if(!after||!unchanged()||shaJson(before)!==shaJson(after))
  return hold('ORIGINAL_QUEUE_SNAPSHOT_CHANGED_HOLD');
 const exact=queued.filter(row=>row?.id===attempt.queuedMessageId);
 if(exact.length>1)return hold('ORIGINAL_QUEUE_DUPLICATE_ID_HOLD');
 if(exact.length===1)return {...hold('ORIGINAL_QUEUE_STILL_QUEUED_HOLD'),queuedIdObserved:true};
 // This is a source observation, not owner authority. Even matching saved
 // history cannot release a notLoaded owner's historical pending gate.
 if(!['active','idle'].includes(after?.status?.type))
  return hold('ORIGINAL_QUEUE_OWNER_NOT_LOADED_HOLD');
 if(!Array.isArray(after.turns))return hold('ORIGINAL_QUEUE_TURNS_UNAVAILABLE_HOLD');
 const matches=[];
 for(const turn of after.turns) {
  if(!UUID.test(turn?.id??'')||!Array.isArray(turn.items))
   return hold('ORIGINAL_QUEUE_INVALID_TURN_HOLD');
  for(const item of turn.items) {
   if(item?.type!=='userMessage')continue;
   if(!Array.isArray(item.content))return hold('ORIGINAL_QUEUE_INVALID_MESSAGE_HOLD');
   const text=item.content.filter(x=>x?.type==='text').map(x=>x.text).join('\n');
   const suffix='\n\n'+attempt.marker;
   if(!text.endsWith(suffix))continue;
   if(item.content.some(x=>x?.type!=='text'||typeof x.text!=='string')||
    createHash('sha256').update(text.slice(0,-suffix.length)).digest('hex')!==attempt.messageSha256)
    return hold('ORIGINAL_QUEUE_MESSAGE_SHA_CONFLICT_HOLD');
   matches.push(turn);
  }
 }
 if(matches.length!==1)return hold(matches.length?'ORIGINAL_QUEUE_MULTIPLE_TURNS_HOLD':
  'ORIGINAL_QUEUE_ABSENT_OUTCOME_UNKNOWN_HOLD');
 const turn=matches[0];
 if(attempt.turnId&&attempt.turnId!==turn.id)return hold('ORIGINAL_QUEUE_SAVED_TURN_CONFLICT_HOLD');
 if(!['completed','failed','interrupted','inProgress'].includes(turn.status))
  return hold('ORIGINAL_QUEUE_TURN_STATUS_UNKNOWN_HOLD');
 return {...base,state:turn.status==='inProgress'?'ORIGINAL_QUEUE_EXACT_TURN_ACTIVE':
   'ORIGINAL_QUEUE_EXACT_TERMINAL_OBSERVED_OWNER_SETTLEMENT_REQUIRED',
  threadId,attemptId:attempt.id,queuedMessageId:attempt.queuedMessageId,
  turnId:turn.id,turnStatus:turn.status,
  observationSha256:shaJson([threadId,attempt.id,turn.id,turn.status,shaJson(after)]),
  next:'original owner must authenticate source and CAS settlement; no replay or automatic gate release'};
}
// Consume the actual non-Web OCX selection-owner contract. Do not translate a
// policy refusal into an App Server usageLimitExceeded event: the two producers
// authenticate different things. The injected reader must be the installed
// private adapter's pinned readOriginalCliQuotaReceiptChain, not caller JSON.
export async function inspectOriginalOcxSelectionQuotaChain({
 client,manifest,threadId,projectRoot,expectedGoalSha256,
 continuityRegistryFile,expectedContinuityRegistrySha256,
 sourceReaderPin,pin,now=Date.now
}={}) {
 const out={schemaVersion:1,kind:'aicc-original-ocx-selection-continuity-inspection/v1',
  sourceOnly:true,dispatchable:false,issuerAuthorityGranted:false,
  writerReturned:false,queueAck:false,newTurns:0,modelRequests:0,
  registrationChanged:false,automaticRetry:false};
 const hold=(state,extra={})=>({...out,state,...extra});
 if(!UUID.test(threadId??'')||!path.isAbsolute(projectRoot??'')||
  !QUOTA_SHA.test(expectedGoalSha256??'')||
  !manifest?.productionStableAllowlist?.includes('thread/read')||
  !manifest?.productionStableAllowlist?.includes('thread/goal/get'))
  throw Error('original_selection_exact_thread_goal_contract_required');
 let cfg;
 try{cfg=readPinnedOriginalQuotaFile(continuityRegistryFile,expectedContinuityRegistrySha256,2097152);}
 catch{return hold('ORIGINAL_SELECTION_REGISTRY_PIN_HOLD');}
 const entry=cfg.threads?.[threadId];
 if(cfg.schemaVersion!==1||cfg.protocolVersion!==3||entry?.threadId!==threadId||
  entry.enabled!==true||entry.executionSurface!=='cli'||entry.strictAccount!=null||
  entry.groupOwnerOnly===true||cfg.excludedThreadIds?.includes(threadId)||
  path.resolve(entry.projectRoot??'')!==path.resolve(projectRoot))
  return hold('ORIGINAL_SELECTION_REGISTERED_SCOPE_HOLD');
 // Preserve the existing global gate, including other historical requests.
 const pending=Object.values(cfg.threads).filter(x=>x.attempt||x.queueAttempt).length;
 if(pending)return hold('ORIGINAL_OR_HISTORICAL_PENDING_UNSETTLED_HOLD',{pendingCount:pending});
 if(cfg.workerStopRequestedAt||cfg.worker?.state==='STOPPED_FOR_MAINTENANCE')
  return hold('MAINTENANCE_STOP_EPOCH_PRESERVED_HOLD');
 // The reader implementation must match an independent owner registration.
 const registered=cfg.originalOcxSelectionReader;
 if(!registered||!sourceReaderPin||
  registered.moduleFile!==sourceReaderPin.moduleFile||
  registered.moduleSha256!==sourceReaderPin.moduleSha256||
  registered.exportName!=='readOriginalCliQuotaReceiptChain'||
  sourceReaderPin.exportName!==registered.exportName)
  return hold('ORIGINAL_SELECTION_READER_NOT_REGISTERED_HOLD');
 if(!pin||Object.keys(pin).sort().join(',')!=='attestationSha256,ownerRequestId,recoverySha256'||
  !UUID.test(pin.ownerRequestId??'')||!QUOTA_SHA.test(pin.attestationSha256??'')||
  !QUOTA_SHA.test(pin.recoverySha256??''))
  return hold('ORIGINAL_SELECTION_EXACT_RECEIPT_PIN_HOLD');
 const inspectReader=()=>{
  const file=registered.moduleFile;
  if(!path.isAbsolute(file??'')||!QUOTA_SHA.test(registered.moduleSha256??''))throw Error('reader_pin');
  for(let p=path.resolve(file);;p=path.dirname(p)){
   if(fs.lstatSync(p).isSymbolicLink())throw Error('reader_alias');
   if(p===path.dirname(p))break;
  }
  const st=fs.statSync(file);
  if(!st.isFile()||st.size<1||st.size>16777216||
   createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==registered.moduleSha256)
   throw Error('reader_changed');
 };
 let source,thread,goal;
 try{
  inspectReader();
  const module=await import(pathToFileURL(registered.moduleFile).href+'?sha256='+registered.moduleSha256);
  const sourceReader=module[registered.exportName];
  if(typeof sourceReader!=='function')throw Error('reader_export');
  source=await sourceReader(pin);
  ({thread}=await client.threadRead({threadId,includeTurns:false}));
  ({goal}=await client.threadGoalGet({threadId}));
  inspectReader();
  readPinnedOriginalQuotaFile(continuityRegistryFile,expectedContinuityRegistrySha256,2097152);
 }catch{return hold('ORIGINAL_SELECTION_SOURCE_OR_OWNER_CHANGED_HOLD');}
 const at=Date.parse(source?.observedAt??''),quotaAt=Date.parse(source?.quotaObservedAt??''),clock=now();
 if(source?.state!=='ORIGINAL_SELECTION_QUOTA_CHAIN_VERIFIED_SENDER_AUTHORITY_REQUIRED'||
  source.threadId!==threadId||!UUID.test(source.turnId??'')||
  !QUOTA_SHA.test(source.accountIdSha256??'')||
  !Number.isSafeInteger(source.credentialGeneration)||source.credentialGeneration<0||
  !['failureReceiptSha256','attestationSha256','recoveryReceiptSha256'].every(k=>QUOTA_SHA.test(source[k]??''))||
  source.attestationSha256!==pin?.attestationSha256||source.recoveryReceiptSha256!==pin?.recoverySha256||
  !Number.isSafeInteger(source.originalResetAt)||source.originalResetAt<=0||
  ![clock,at,quotaAt].every(Number.isFinite)||at>clock||quotaAt>at||
  clock-at>=60000||clock-quotaAt>=60000||at<source.originalResetAt*1000||
  quotaAt<source.originalResetAt*1000||
  !['sourceOnly','originalIssuerVerified','writerReturned','issuerAuthorityGranted','dispatchable'].every(k=>source[k]===(k==='sourceOnly'))||
  source.modelRequests!==0||source.newTurns!==0||
  source.originalTerminal?.threadId!==threadId||source.originalTerminal?.turnId!==source.turnId||
  !QUOTA_SHA.test(source.originalTerminal?.terminalSha256??'')||
  !['turn_failed','turn_aborted','task_complete'].includes(source.originalTerminal?.terminalType)||
  typeof source.backendLimitProven!=='boolean')
  return hold('ORIGINAL_SELECTION_CHAIN_OR_FRESHNESS_HOLD');
 if(thread?.id!==threadId||path.resolve(thread.cwd??'')!==path.resolve(projectRoot)||
  !['active','idle'].includes(thread.status?.type)||goal?.threadId!==threadId||
  !['active','usageLimited'].includes(goal.status)||
  goalSnapshotSha256(goal)!==expectedGoalSha256)
  return hold('ORIGINAL_SELECTION_CURRENT_GOAL_HOLD');
 // Policy refusals and backend exhaustion have different source schemas.
 // Authenticate the real selection chain directly; never turn a 97% policy
 // cutoff into a fabricated App Server usageLimitExceeded/100% receipt.
 const callbackPin=entry.originalIssuerQuotaCallback;
 if(callbackPin){
  let callback;
  try{callback=readPinnedOriginalQuotaFile(callbackPin.receiptFile,callbackPin.receiptSha256);}
  catch{return hold('ORIGINAL_SELECTION_CALLBACK_PIN_CHANGED_HOLD');}
  if(callbackPin.kind!=='aicc-original-cli-issuer-callback-pin/v1'||
    !QUOTA_SHA.test(entry.originalIssuerOwnerRevision??'')||
    !Number.isSafeInteger(entry.originalIssuerStopEpoch)||entry.originalIssuerStopEpoch<0||
    !Number.isSafeInteger(entry.originalIssuerPreviousStopEpoch)||entry.originalIssuerPreviousStopEpoch<0||
    !QUOTA_SHA.test(entry.originalIssuerReceiptSha256??''))
   return hold('ORIGINAL_SELECTION_REGISTERED_OWNER_GENERATION_HOLD');
  const authentication=verifyRegisteredOriginalIssuerCallback({callback,
   producer:cfg.originalGeneralCliIssuerProducer,now,binding:{
    threadId,route:'official-codex-to-17841-to-nonweb-OCX10101',projectRoot,
    goalSnapshotSha256:expectedGoalSha256,ownerRevision:entry.originalIssuerOwnerRevision,
    stopEpoch:entry.originalIssuerStopEpoch,previousStopEpoch:entry.originalIssuerPreviousStopEpoch,
    issuerReceiptSha256:entry.originalIssuerReceiptSha256,failedTurnId:source.turnId,
    terminalSha256:source.originalTerminal.terminalSha256,accountIdSha256:source.accountIdSha256,
    writerProcessIdentitySha256:entry.originalIssuerWriterProcessIdentitySha256,
    failureReceiptSha256:source.failureReceiptSha256,admissionReceiptSha256:source.recoveryReceiptSha256,
    quotaSourceKind:'ocx-selection',ownerRequestId:pin.ownerRequestId,
    credentialGeneration:source.credentialGeneration,attestationSha256:source.attestationSha256,
    originalIssuerBound:true,writerReturned:true,writerClosed:true
   }});
  if(!authentication.authenticated)return hold(authentication.state);
  try{
   inspectReader();
   readPinnedOriginalQuotaFile(continuityRegistryFile,expectedContinuityRegistrySha256,2097152);
   readPinnedOriginalQuotaFile(callbackPin.receiptFile,callbackPin.receiptSha256);
  }catch{return hold('ORIGINAL_SELECTION_CALLBACK_OR_AUTHORITY_DRIFT_HOLD');}
  return hold('ORIGINAL_OCX_SELECTION_SIGNED_CALLBACK_VERIFIED_SENDER_AUTHORITY_REQUIRED_HOLD',{
   sourceChainVerified:true,callbackSourceAuthenticated:true,threadId,failedTurnId:source.turnId,
   backendLimitProven:source.backendLimitProven,callbackReceiptSha256:callbackPin.receiptSha256,
   ownerRevision:entry.originalIssuerOwnerRevision,stopEpoch:entry.originalIssuerStopEpoch,
   next:'original connected sender must claim once, acknowledge and observe the resumed goal turn'});
 }
 // A source terminal is not a normal writer handoff. Keep stop/revision and
 // one-shot original sender authentication as explicit independent gates.
 return hold('ORIGINAL_OCX_SELECTION_CHAIN_VERIFIED_OWNER_CALLBACK_REQUIRED_HOLD',{
  sourceChainVerified:true,threadId,failedTurnId:source.turnId,
  backendLimitProven:source.backendLimitProven,
  originalTerminalType:source.originalTerminal.terminalType,
  failureReceiptSha256:source.failureReceiptSha256,
  admissionReceiptSha256:source.recoveryReceiptSha256,
  next:'original owner revision/stop epoch, normal writer handoff and original sender single ACK are required'});
}
// Consumer boundary: source observations alone NEVER establish that a new App
// Server owns the original OCX 17841 sender. The existing installer must verify
// the owner-side receipt pins, writer handoff, monotonic stop fence and pending
// settlement before granting any authority. This function never sends a turn.
export async function inspectOriginalOwnerQuotaReceiptPair({
 client,manifest,threadId,projectRoot,expectedGoalSha256,
 failureReceipt,expectedFailureReceiptSha256,
 admissionReceipt,expectedAdmissionReceiptSha256,
 originalOwnerProof,globalPendingCount,now=Date.now
}={}) {
 if(!UUID.test(threadId??'')||!path.isAbsolute(projectRoot??'')||
   !QUOTA_SHA.test(expectedGoalSha256??'')||
   !QUOTA_SHA.test(expectedFailureReceiptSha256??'')||
   !QUOTA_SHA.test(expectedAdmissionReceiptSha256??'')||
   !Number.isSafeInteger(globalPendingCount)||globalPendingCount<0||
   manifest?.productionStableAllowlist?.includes('thread/read')!==true||
   manifest?.productionStableAllowlist?.includes('thread/goal/get')!==true)
  throw Error('quota_owner_exact_inputs_required');
 const base={schemaVersion:1,kind:'aicc-quota-owner-source-consumption/v1',threadId,
   sourceOnly:true,dispatchable:false,automaticRetry:false,newTurns:0,modelRequests:0,
   queueMutations:0,issuerAuthorityGranted:false,originalOcxIssuerVerified:false,
   writerAuthorityTransferred:false,originalQueueAck:false};
 const deny=(reason,extra={})=>({...base,state:reason,...extra});
 if(failureReceipt?.schemaVersion!==1||admissionReceipt?.schemaVersion!==1||
   failureReceipt?.terminalType!=='turn/completed'||
   failureReceipt?.kind!=='aicc-app-server-owned-five-hour-failure/v1'||
   admissionReceipt?.kind!=='aicc-app-server-owned-five-hour-admission/v1'||
   shaJson(failureReceipt)!==expectedFailureReceiptSha256||
   shaJson(admissionReceipt)!==expectedAdmissionReceiptSha256||
   admissionReceipt.failureReceiptSha256!==expectedFailureReceiptSha256)
  return deny('ORIGINAL_SOURCE_RECEIPT_SHA_OR_CHAIN_HOLD');
 const context=failureReceipt.ownerContext;
 if(context?.kind!=='aicc-original-cli-owner-context/v1'||
   context.threadId!==threadId||
   path.resolve(context.projectRoot??'')!==path.resolve(projectRoot)||
   context.goalSnapshotSha256!==expectedGoalSha256||
   context.route!=='official-codex-to-17841-to-nonweb-OCX10101'||
   !QUOTA_SHA.test(context.ownerRevision??'')||
   !Number.isSafeInteger(context.stopEpoch)||context.stopEpoch<0||
   !QUOTA_SHA.test(context.issuerReceiptSha256??'')||
   !QUOTA_SHA.test(failureReceipt.ownerContextSha256??'')||
   failureReceipt.ownerContextSha256!==shaJson(context)||
   admissionReceipt.ownerContextSha256!==failureReceipt.ownerContextSha256||
   !QUOTA_SHA.test(failureReceipt.writerProcessIdentitySha256??'')||
   admissionReceipt.writerProcessIdentitySha256!==failureReceipt.writerProcessIdentitySha256||
   !QUOTA_SHA.test(failureReceipt.terminalSha256??'')||
   failureReceipt.errorInfo!=='usageLimitExceeded'||
   !UUID.test(failureReceipt.failedTurnId??'') ||
   failureReceipt.threadId!==threadId ||
   failureReceipt.originalOcxIssuerVerified!==false ||
   admissionReceipt.originalOcxIssuerVerified!==false)
  return deny('ORIGINAL_ISSUER_THREAD_ROUTE_OR_OWNER_CLAIM_HOLD');
 const failed=failureReceipt.quota,admitted=admissionReceipt.quota;
 const failureAt=Date.parse(failureReceipt.observedAt??'');
 const admittedAt=Date.parse(admissionReceipt.observedAt??'');
 const observedNow=now();
 // A source receipt must retain the precise 300-minute primary/secondary
 // window classified by the pinned App Server producer; missing data is
 // UNKNOWN, never recovered (JS NaN comparisons alone do not reject it).
 const windowValid=(w)=>w==='primary'||w==='secondary';
 const percentValid=(x)=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=100;
 if(!Number.isFinite(observedNow)||!Number.isFinite(failureAt)||
   !Number.isFinite(admittedAt)||
   failureAt>admittedAt||admittedAt>observedNow||
   observedNow-admittedAt>120000||
   !QUOTA_SHA.test(failed?.accountIdSha256??'')||
   admitted?.accountIdSha256!==failed.accountIdSha256||
   failed.limitId!==context.quotaLimitId||admitted.limitId!==failed.limitId||
   !windowValid(failed.window)||admitted.window!==failed.window||
   !percentValid(failed.usedPercent)||failed.usedPercent!==100||
   !percentValid(admitted.usedPercent)||admitted.usedPercent>=100||
   failed.rateLimitReachedType!=='rate_limit_reached'||
   failed.ordinaryUsageAllowed!==false||
   admitted.rateLimitReachedType!==null||
   admitted.spendControlReached!==false||admitted.ordinaryUsageAllowed!==true||
   !Number.isSafeInteger(failed.resetsAt)||failed.resetsAt*1000<=failureAt||
   failed.resetsAt*1000>failureAt+6*3600000||
   admittedAt<failed.resetsAt*1000||
   !Number.isSafeInteger(admitted.resetsAt)||admitted.resetsAt<=0||
   admitted.resetsAt*1000<=admittedAt||
   admitted.resetsAt*1000>admittedAt+6*3600000)
  return deny('ORIGINAL_QUOTA_FAILURE_ADMISSION_OR_FRESHNESS_HOLD');
 // A different App Server can read the same persisted thread, but it cannot
 // authenticate original route/writer ownership. This is goal consistency only.
 let thread,goal;
 try{
  ({thread}=await client.threadRead({threadId,includeTurns:false}));
  ({goal}=await client.threadGoalGet({threadId}));
 }catch(error){return deny('CURRENT_GOAL_READ_UNKNOWN_NO_RETRY',
   {errorCode:String(error?.code??'read_failed').slice(0,80)});}
 if(thread?.id!==threadId||typeof thread.cwd!=='string'||
   path.resolve(thread.cwd)!==path.resolve(projectRoot)||
   !['active','idle'].includes(thread.status?.type)||
   goal?.threadId!==threadId||goalSnapshotSha256(goal)!==expectedGoalSha256||
   goal.status!=='active')
  return deny('CURRENT_ORIGINAL_GOAL_CHANGED_HOLD');
 if(globalPendingCount!==0)
  return deny('HISTORICAL_OR_UNKNOWN_PENDING_SETTLEMENT_HOLD',
    {pendingCount:globalPendingCount});
 // The owner proof is a claim until matched to the true original sender by the
 // existing registered installer. No untrusted boolean confers sender rights.
 if(!originalOwnerProof||
   originalOwnerProof.ownerRevision!==context.ownerRevision||
   originalOwnerProof.stopEpoch!==context.stopEpoch||
   originalOwnerProof.issuerReceiptSha256!==context.issuerReceiptSha256||
   originalOwnerProof.sourceWriterReceiptSha256!==expectedFailureReceiptSha256||
   originalOwnerProof.returned!==true||
   originalOwnerProof.closed!==true)
  return deny('ORIGINAL_WRITER_RETURN_AND_OWNER_REVISION_HOLD');
 return {...base,state:'RECEIPT_CHAIN_MATCHED_EXTERNAL_OWNER_GATE_REQUIRED',
   exactFailureSha256:expectedFailureReceiptSha256,
   exactAdmissionSha256:expectedAdmissionReceiptSha256,
   ownerRevision:context.ownerRevision,stopEpoch:context.stopEpoch,
   accountIdSha256:failed.accountIdSha256,
   afterReset:true,backendOrdinaryUsageAllowed:true,
   next:'registered owner installer must authenticate original OCX issuer, release, stop fence, pending and one-shot sender claim'};
}

// Read-only consumer of the source handoff and *registered* original-owner
// callback. Unlike a caller-provided boolean, a callback must be SHA-pinned by
// the current existing continuity registry. That registry currently has NO
// original-general-CLI callback producer: the safe result is HOLD. Even a
// matched callback remains source evidence until the installed sender gates
// one-use claim, ACK and turn through its original connection.
function readPinnedOriginalQuotaFile(file,sha,sizeLimit=65536) {
  if(typeof file!=='string'||!path.isAbsolute(file)||!QUOTA_SHA.test(sha??''))
    throw Error('original_quota_file_exact_sha_required');
  const full=path.resolve(file);
  for(let part=full;;part=path.dirname(part)){
    if(fs.lstatSync(part).isSymbolicLink())
      throw Error('original_quota_file_alias_refused');
    if(part===path.dirname(part))break;
  }
  const st=fs.statSync(full);
  if(!st.isFile()||st.size<1||st.size>sizeLimit)
    throw Error('original_quota_file_bounds_required');
  const bytes=fs.readFileSync(full);
  if(createHash('sha256').update(bytes).digest('hex')!==sha)
    throw Error('original_quota_file_sha_changed');
  const result=JSON.parse(bytes.toString('utf8'));
  if(!result||typeof result!=='object'||Array.isArray(result))
    throw Error('original_quota_file_object_required');
  return result;
}

// The original producer must be pinned independently by the existing owner
// registry. A key shipped inside the callback is never a trust root. This is
// source authentication only, not a sender claim or permission to resume.
export function verifyRegisteredOriginalIssuerCallback({callback,producer,binding,now=Date.now}={}) {
  const out={authenticated:false,dispatchable:false,issuerAuthorityGranted:false,
    modelRequests:0,newTurns:0};
  const hold=state=>({...out,state});
  if(producer?.kind!=='aicc-original-cli-issuer-producer-pin/v1'||
     producer.route!=='official-codex-to-17841-to-nonweb-OCX10101'||
     !QUOTA_SHA.test(producer.executableSha256??'')||
     !QUOTA_SHA.test(producer.publicKeySha256??'')||
     typeof producer.publicKeyPem!=='string'||producer.publicKeyPem.length>8192||
     typeof producer.keyId!=='string'||!/^[A-Za-z0-9._:-]{8,128}$/.test(producer.keyId))
    return hold('ORIGINAL_ISSUER_PRODUCER_NOT_REGISTERED_HOLD');
  let key;
  try {
    if(typeof producer.executableFile!=='string'||!path.isAbsolute(producer.executableFile))
      throw Error('absolute_executable_required');
    for(let p=path.resolve(producer.executableFile);;p=path.dirname(p)){
      if(fs.lstatSync(p).isSymbolicLink())throw Error('alias');
      if(p===path.dirname(p))break;
    }
    const item=fs.statSync(producer.executableFile);
    if(!item.isFile()||item.size<1||item.size>134217728)throw Error('executable_bounds');
    const executable=fs.readFileSync(producer.executableFile);
    if(createHash('sha256').update(executable).digest('hex')!==producer.executableSha256)
      throw Error('changed_executable');
    key=createPublicKey(producer.publicKeyPem);
    if(key.asymmetricKeyType!=='ed25519'||
       createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex')!==producer.publicKeySha256)
      throw Error('changed_key');
  } catch {return hold('ORIGINAL_ISSUER_PRODUCER_PIN_CHANGED_HOLD');}
  const signed=callback?.signedSource;
  if(signed?.kind!=='aicc-original-cli-issuer-signed-source/v1'||
     signed.keyId!==producer.keyId||typeof signed.payloadBase64!=='string'||
     signed.payloadBase64.length>65536||typeof signed.signatureBase64!=='string'||
     !/^[A-Za-z0-9+/]{86}==$/.test(signed.signatureBase64))
    return hold('ORIGINAL_ISSUER_SIGNATURE_REQUIRED_HOLD');
  let payload;
  try{
    const bytes=Buffer.from(signed.payloadBase64,'base64');
    if(bytes.toString('base64')!==signed.payloadBase64||
       !verify(null,bytes,key,Buffer.from(signed.signatureBase64,'base64')))
      throw Error('signature');
    payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('shape');
  }catch{return hold('ORIGINAL_ISSUER_SIGNATURE_UNVERIFIED_HOLD');}
  const fields=['threadId','route','projectRoot','goalSnapshotSha256','ownerRevision',
    'stopEpoch','previousStopEpoch','issuerReceiptSha256','failedTurnId','terminalSha256',
    'accountIdSha256','writerProcessIdentitySha256','failureReceiptSha256','admissionReceiptSha256',
    'originalIssuerBound','writerReturned','writerClosed'];
  if(binding?.quotaSourceKind==='ocx-selection'){
    fields.push('quotaSourceKind','ownerRequestId','credentialGeneration','attestationSha256');
    if(!UUID.test(binding.ownerRequestId??'')||
       !Number.isSafeInteger(binding.credentialGeneration)||binding.credentialGeneration<0||
       !QUOTA_SHA.test(binding.attestationSha256??'')||
       !QUOTA_SHA.test(binding.writerProcessIdentitySha256??''))
      return hold('ORIGINAL_SELECTION_SIGNED_OWNER_BINDING_HOLD');
  }
  if(payload.kind!=='aicc-original-cli-issuer-callback/v1'||
     fields.some(k=>payload[k]!==callback[k])||
     payload.producerExecutableSha256!==producer.executableSha256||
     !binding||fields.some(k=>payload[k]!==binding[k])||
     !Number.isSafeInteger(payload.stopEpoch)||payload.stopEpoch<0||
     !Number.isSafeInteger(payload.previousStopEpoch)||payload.previousStopEpoch<0||
     payload.previousStopEpoch>payload.stopEpoch||
     payload.originalIssuerBound!==true||payload.writerReturned!==true||payload.writerClosed!==true)
    return hold('ORIGINAL_ISSUER_SIGNED_BINDING_OR_EPOCH_HOLD');
  const at=Date.parse(payload.observedAt??''),clock=now();
  if(!Number.isFinite(clock)||!Number.isFinite(at)||at>clock||clock-at>120000)
    return hold('ORIGINAL_ISSUER_SIGNED_SOURCE_STALE_HOLD');
  return {...out,state:'ORIGINAL_ISSUER_SIGNED_SOURCE_VERIFIED_SENDER_AUTHORITY_REQUIRED',
    authenticated:true,keyId:producer.keyId};
}
export async function inspectSealedOriginalOwnerQuotaHandoff({
  client,manifest,threadId,projectRoot,expectedGoalSha256,
  handoffFile,expectedHandoffFileSha256,
  continuityRegistryFile,expectedContinuityRegistrySha256,now=Date.now,
  registrationCandidatePin=null
}={}) {
  const base={schemaVersion:1,kind:'aicc-original-cli-quota-registered-source-readback/v1',
    sourceOnly:true,dispatchable:false,issuerAuthorityGranted:false,
    registrationChanged:false,writerAuthorityTransferred:false,
    automaticRetry:false,modelRequests:0,newTurns:0,queueMutations:0,
    originalQueueAck:false};
  const hold=(state,detail={})=>({...base,state,...detail});
  if(!UUID.test(threadId??'')||!path.isAbsolute(projectRoot??'')||
    !QUOTA_SHA.test(expectedGoalSha256??''))
    throw Error('original_quota_exact_thread_goal_required');
  let handoff,failure,admission,cfg;
  try{
    handoff=readPinnedOriginalQuotaFile(handoffFile,expectedHandoffFileSha256);
    failure=readPinnedOriginalQuotaFile(handoff?.sources?.failure?.file,
      handoff?.sources?.failure?.sha256);
    admission=readPinnedOriginalQuotaFile(handoff?.sources?.admission?.file,
      handoff?.sources?.admission?.sha256);
    cfg=readPinnedOriginalQuotaFile(continuityRegistryFile,
      expectedContinuityRegistrySha256,2097152);
  }catch(error){return hold('OWNER_SOURCE_FILE_OR_REGISTRY_PIN_HOLD',
    {errorCode:String(error?.message??'read_failure').slice(0,80)});}
  const context=failure.ownerContext;
  if(handoff.schemaVersion!==1||
    handoff.kind!=='aicc-original-cli-quota-source-owner-handoff/v1'||
    handoff.status!=='SOURCE_RECEIPTS_PINNED_OWNER_AUTHORITY_NOT_GRANTED'||
    handoff.originalIssuerAttested!==false||handoff.originalOwnerReleased!==false||
    handoff.dispatchable!==false||handoff.modelRequests!==0||handoff.newTurns!==0||
    handoff.threadId!==threadId||context?.threadId!==threadId||
    path.resolve(handoff.projectRoot??'')!==path.resolve(projectRoot)||
    handoff.goalSnapshotSha256!==expectedGoalSha256||
    handoff.ownerRevision!==context.ownerRevision||
    handoff.stopEpoch!==context.stopEpoch||
    handoff.originalIssuerReceiptSha256!==context.issuerReceiptSha256||
    handoff.failedTurnId!==failure.failedTurnId||
    handoff.terminalSha256!==failure.terminalSha256||
    handoff.recordedOwnerProcessSha256!==failure.writerProcessIdentitySha256||
    handoff.accountIdSha256!==failure.quota?.accountIdSha256||
    handoff.quotaLimitId!==failure.quota?.limitId||
    handoff.originalFiveHourResetAt!==failure.quota?.resetsAt||
    handoff.route!=='official-codex-to-17841-to-nonweb-OCX10101')
    return hold('OWNER_HANDOFF_ROUTE_GOAL_OR_SOURCE_FIELDS_HOLD');
  if(cfg.schemaVersion!==1||cfg.protocolVersion!==3||
    !cfg.threads||typeof cfg.threads!=='object'||Array.isArray(cfg.threads)||
    cfg.threads[threadId]?.threadId!==threadId||
    path.resolve(cfg.threads[threadId].projectRoot??'')!==path.resolve(projectRoot)||
    cfg.threads[threadId].strictAccount!=null||
    cfg.threads[threadId].groupOwnerOnly===true||
    cfg.threads[threadId].enabled!==true||
    cfg.excludedThreadIds?.includes(threadId))
    return hold('ORIGINAL_GENERAL_CLI_REGISTERED_OWNER_SCOPE_HOLD');
  const pendingCount=Object.values(cfg.threads).filter(entry=>entry.attempt||entry.queueAttempt).length;
  // Reuse exact quota/read-only goal checks, but NEVER convert an external
  // owner proof (or static receipt hash) into issuer authority.
  const verdict=await inspectOriginalOwnerQuotaReceiptPair({
    client,manifest,threadId,projectRoot,expectedGoalSha256,
    failureReceipt:failure,expectedFailureReceiptSha256:shaJson(failure),
    admissionReceipt:admission,expectedAdmissionReceiptSha256:shaJson(admission),
    globalPendingCount:pendingCount,now,
    originalOwnerProof:{
      ownerRevision:context.ownerRevision,stopEpoch:context.stopEpoch,
      issuerReceiptSha256:context.issuerReceiptSha256,
      sourceWriterReceiptSha256:shaJson(failure),returned:false,closed:false
    }
  });
  if(verdict.state!=='ORIGINAL_WRITER_RETURN_AND_OWNER_REVISION_HOLD')
    return hold(verdict.state,{pendingCount,registeredRegistrySha256:expectedContinuityRegistrySha256});
  if(cfg.workerStopRequestedAt||cfg.worker?.state==='STOPPED_FOR_MAINTENANCE')
    return hold('MAINTENANCE_STOP_EPOCH_PRESERVED_HOLD',
      {pendingCount,registeredRegistrySha256:expectedContinuityRegistrySha256});
  const existingPin=cfg.threads[threadId].originalIssuerQuotaCallback;
  // Candidate inspection is read-only. It cannot replace a registered callback
  // or supply its own producer trust root.
  if(registrationCandidatePin&&existingPin)
    return hold('ORIGINAL_ISSUER_CALLBACK_ALREADY_REGISTERED_HOLD');
  if(registrationCandidatePin&&!cfg.originalGeneralCliIssuerProducer)
    return hold('ORIGINAL_ISSUER_PRODUCER_NOT_REGISTERED_HOLD');
  const pin=registrationCandidatePin??existingPin;
  if(pin?.kind!=='aicc-original-cli-issuer-callback-pin/v1'||
    !QUOTA_SHA.test(pin.receiptSha256??'')||
    typeof pin.receiptFile!=='string')
    return hold('ORIGINAL_GENERAL_CLI_ISSUER_CALLBACK_NOT_REGISTERED_HOLD',
      {pendingCount,registeredRegistrySha256:expectedContinuityRegistrySha256});
  let callback;
  try{callback=readPinnedOriginalQuotaFile(pin.receiptFile,pin.receiptSha256);}
  catch{return hold('ORIGINAL_GENERAL_CLI_ISSUER_CALLBACK_PIN_CHANGED_HOLD');}
  // A new callback type must be produced and sealed at the existing TUI/
  // 17841/nonweb OCX10101 *original* sender boundary, not this App Server.
  // Even a matching shape is not an authenticated delivery/claim.
  if(callback.kind!=='aicc-original-cli-issuer-callback/v1'||
    callback.threadId!==threadId||callback.route!==handoff.route||
    callback.projectRoot!==projectRoot||callback.goalSnapshotSha256!==expectedGoalSha256||
    callback.ownerRevision!==context.ownerRevision||
    callback.stopEpoch!==context.stopEpoch||
    !Number.isSafeInteger(callback.stopEpoch)||callback.stopEpoch<0||
    !Number.isSafeInteger(callback.previousStopEpoch)||callback.previousStopEpoch<0||
    callback.previousStopEpoch>callback.stopEpoch||
    callback.issuerReceiptSha256!==context.issuerReceiptSha256||
    callback.failedTurnId!==failure.failedTurnId||
    callback.terminalSha256!==failure.terminalSha256||
    callback.accountIdSha256!==failure.quota.accountIdSha256||
    callback.writerProcessIdentitySha256!==failure.writerProcessIdentitySha256||
    callback.failureReceiptSha256!==shaJson(failure)||
    callback.admissionReceiptSha256!==shaJson(admission)||
    callback.originalIssuerBound!==true||
    callback.writerReturned!==true||callback.writerClosed!==true)
    return hold('ORIGINAL_GENERAL_CLI_CALLBACK_IDENTITY_OR_EPOCH_HOLD');
  const producer=cfg.originalGeneralCliIssuerProducer;
  if(producer){
    const registeredOwner=cfg.threads[threadId];
    if(registeredOwner.originalIssuerOwnerRevision!==context.ownerRevision||
       registeredOwner.originalIssuerStopEpoch!==context.stopEpoch||
       registeredOwner.originalIssuerReceiptSha256!==context.issuerReceiptSha256)
      return hold('ORIGINAL_ISSUER_REGISTERED_OWNER_GENERATION_CHANGED_HOLD');
    const authentication=verifyRegisteredOriginalIssuerCallback({callback,producer,now,binding:{
      threadId,route:handoff.route,projectRoot,goalSnapshotSha256:expectedGoalSha256,
      ownerRevision:context.ownerRevision,stopEpoch:context.stopEpoch,
      previousStopEpoch:registeredOwner.originalIssuerPreviousStopEpoch,
      issuerReceiptSha256:context.issuerReceiptSha256,failedTurnId:failure.failedTurnId,
      terminalSha256:failure.terminalSha256,accountIdSha256:failure.quota.accountIdSha256,
      writerProcessIdentitySha256:failure.writerProcessIdentitySha256,
      failureReceiptSha256:shaJson(failure),admissionReceiptSha256:shaJson(admission),
      originalIssuerBound:true,writerReturned:true,writerClosed:true
    }});
    if(!authentication.authenticated)return hold(authentication.state);
    try{
      readPinnedOriginalQuotaFile(continuityRegistryFile,expectedContinuityRegistrySha256,2097152);
      readPinnedOriginalQuotaFile(handoffFile,expectedHandoffFileSha256);
      readPinnedOriginalQuotaFile(handoff.sources.failure.file,handoff.sources.failure.sha256);
      readPinnedOriginalQuotaFile(handoff.sources.admission.file,handoff.sources.admission.sha256);
      readPinnedOriginalQuotaFile(pin.receiptFile,pin.receiptSha256);
    }catch{return hold('ORIGINAL_CALLBACK_SOURCE_OR_AUTHORITY_DRIFT_HOLD');}
    return hold(authentication.state,{callbackSourceAuthenticated:true,
      callbackReceiptSha256:pin.receiptSha256,pendingCount,
      registeredRegistrySha256:expectedContinuityRegistrySha256,
      next:'existing owner installer CAS and original sender one-shot claim/ACK remain required'});
  }
  return hold('REGISTERED_CALLBACK_SOURCE_CHAIN_MATCHED_SENDER_AUTHORITY_REQUIRED',
    {pendingCount,ownerRevision:context.ownerRevision,stopEpoch:context.stopEpoch,
      registeredRegistrySha256:expectedContinuityRegistrySha256,
      callbackReceiptSha256:pin.receiptSha256,
      next:'installed original OCX sender independently verifies callback origin, process return, stop epoch, exact pending settlement and one-shot sender ACK/new turn'});
}

// Preview for the existing owner installer. This deliberately has no file
// writes, claim, worker start or model sender. Applying a preview requires the
// owner's registry lock, a new inspection and exact CAS of both source pins.
export async function prepareOriginalIssuerCallbackRegistration(options={}){
  const result=await inspectSealedOriginalOwnerQuotaHandoff(options);
  const base={schemaVersion:1,kind:'aicc-original-cli-callback-registration-plan/v1',
    state:result.state,canApply:false,registrationChanged:false,dispatchable:false,
    modelRequests:0,newTurns:0};
  if(result.callbackSourceAuthenticated!==true||!options.registrationCandidatePin)
    return base;
  // Awaited goal reads may yield to a stop or registry update. Never publish
  // a ready preview against an old authority snapshot.
  try{
    readPinnedOriginalQuotaFile(options.continuityRegistryFile,
      options.expectedContinuityRegistrySha256,2097152);
    readPinnedOriginalQuotaFile(options.registrationCandidatePin.receiptFile,
      options.registrationCandidatePin.receiptSha256);
  }catch{return {...base,state:'ORIGINAL_REGISTRATION_PREVIEW_CAS_CHANGED_HOLD'};}
  return {...base,state:'PREPARED_ORIGINAL_CALLBACK_REGISTRATION_REQUIRES_OWNER_CAS',
    threadId:options.threadId,projectRoot:options.projectRoot,
    goalSnapshotSha256:options.expectedGoalSha256,
    registrySha256:options.expectedContinuityRegistrySha256,
    callbackPin:{kind:'aicc-original-cli-issuer-callback-pin/v1',
      receiptFile:options.registrationCandidatePin.receiptFile,
      receiptSha256:options.registrationCandidatePin.receiptSha256},
    sourceHandoffSha256:options.expectedHandoffFileSha256,
    // Validity is bounded by the already checked source observation as well.
    createdAt:new Date((options.now??Date.now)()).toISOString(),
    next:'owner installer must lock/reinspect/CAS; producer provisioning and sender activation are separate'};
}
