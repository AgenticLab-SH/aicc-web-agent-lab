import fs from 'node:fs';
import path from 'node:path';
import {createHash,createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {verifyRegisteredOriginalIssuerCallback} from './codex-goal-resume.mjs';
import {assertWindowsOwnerOnlyPath} from './lib/windows-owner-only-acl.mjs';

const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ROUTE='official-codex-to-17841-to-nonweb-OCX10101';
const hash=b=>createHash('sha256').update(b).digest('hex');
function pinned(file,expected,max=2097152){
 if(!path.isAbsolute(file??'')||!SHA.test(expected??''))throw Error('producer_exact_pin_required');
 for(let p=path.resolve(file);;p=path.dirname(p)){
  if(fs.lstatSync(p).isSymbolicLink())throw Error('producer_link_refused');
  if(p===path.dirname(p))break;
 }
 const st=fs.statSync(file);
 if(!st.isFile()||st.size<1||st.size>max)throw Error('producer_file_bounds');
 const bytes=fs.readFileSync(file);
 if(hash(bytes)!==expected)throw Error('producer_file_changed');
 return bytes;
}
function registry(bytes,threadId){
 const cfg=JSON.parse(bytes),entry=cfg.threads?.[threadId];
 if(cfg.schemaVersion!==1||cfg.protocolVersion!==3||entry?.threadId!==threadId||
    entry.enabled!==true||entry.executionSurface!=='cli'||entry.strictAccount!=null||
    entry.groupOwnerOnly===true||cfg.excludedThreadIds?.includes(threadId)||
    !path.isAbsolute(entry.projectRoot??''))throw Error('producer_registered_original_cli_required');
 if(Object.values(cfg.threads).some(e=>e.attempt||e.queueAttempt))throw Error('producer_pending_preserved');
 if(cfg.workerStopRequestedAt||cfg.worker?.state==='STOPPED_FOR_MAINTENANCE')throw Error('producer_stop_preserved');
 if(entry.originalIssuerQuotaCallback)throw Error('producer_existing_callback_preserved');
 if(!SHA.test(entry.originalIssuerOwnerRevision??'')||
    !SHA.test(entry.originalIssuerReceiptSha256??'')||
    !SHA.test(entry.originalIssuerWriterProcessIdentitySha256??'')||
    !Number.isSafeInteger(entry.originalIssuerStopEpoch)||entry.originalIssuerStopEpoch<0||
    !Number.isSafeInteger(entry.originalIssuerPreviousStopEpoch)||entry.originalIssuerPreviousStopEpoch<0||
    entry.originalIssuerPreviousStopEpoch>entry.originalIssuerStopEpoch)
  throw Error('producer_registered_owner_epoch_required');
 return {cfg,entry};
}

export function inspectRegisteredOriginalIssuerProducer({registryFile,registrySha256,threadId}={}){
 const base={readOnly:true,canSeal:false,registrationChanged:false,dispatchable:false,
  issuerAuthorityGranted:false,modelRequests:0,newTurns:0};
 try{
  if(!UUID.test(threadId??''))throw Error('producer_exact_thread_required');
  const {cfg}=registry(pinned(registryFile,registrySha256),threadId);
  const p=cfg.originalGeneralCliIssuerProducer;
  if(!p?.authorityReader||!p.privateKey||!cfg.originalOcxSelectionReader)
   throw Error('producer_independent_registration_required');
  // Presence is diagnostic only. Actual invocation rechecks executable, key,
  // modules and current source/owner observations before any signature.
  return {...base,state:'ORIGINAL_PRODUCER_REGISTERED_LIVE_OBSERVATION_REQUIRED'};
 }catch(error){return {...base,state:'ORIGINAL_PRODUCER_PREFLIGHT_HOLD',reason:error.message};}
}

// This producer has no registration, key provisioning, worker or sender action.
// Its two independent readers must already be installed and pinned by the owner.
// A caller cannot supply observations, a reader function, keys or authority flags.
export async function sealRegisteredOriginalIssuerCallback({registryFile,registrySha256,
 threadId,goalSha256,pin,outputFile,now=Date.now}={}){
 if(!UUID.test(threadId??'')||!SHA.test(goalSha256??'')||!pin||
    Object.keys(pin).sort().join(',')!=='attestationSha256,ownerRequestId,recoverySha256'||
    !UUID.test(pin.ownerRequestId??'')||!SHA.test(pin.attestationSha256??'')||!SHA.test(pin.recoverySha256??''))
  throw Error('producer_exact_original_selection_required');
 pin=Object.freeze({...pin});
 const before=pinned(registryFile,registrySha256),{cfg,entry}=registry(before,threadId);
 const producer=cfg.originalGeneralCliIssuerProducer,authority=producer?.authorityReader;
 const reader=cfg.originalOcxSelectionReader,keyPin=producer?.privateKey;
 if(producer?.kind!=='aicc-original-cli-issuer-producer-pin/v1'||producer.route!==ROUTE||
    path.resolve(producer.executableFile??'')!==path.resolve(process.execPath)||
    typeof producer.publicKeyPem!=='string'||producer.publicKeyPem.length>8192||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(producer.keyId??'')||
    authority?.exportName!=='readOriginalIssuerAuthority'||
    reader?.exportName!=='readOriginalCliQuotaReceiptChain')throw Error('producer_independent_registration_required');
 const executable=pinned(producer.executableFile,producer.executableSha256,134217728);
 const authorityBytes=pinned(authority.moduleFile,authority.moduleSha256,16777216);
 const readerBytes=pinned(reader.moduleFile,reader.moduleSha256,16777216);
 function checkPrivatePermissions(){
  if(!path.isAbsolute(keyPin?.file??''))throw Error('producer_private_key_path_required');
  if(process.platform==='win32'){
   assertWindowsOwnerOnlyPath(path.dirname(keyPin.file),{directory:true});
   assertWindowsOwnerOnlyPath(keyPin.file,{directory:false});
  }else{
   for(const file of [keyPin.file,path.dirname(keyPin.file)]){
    const st=fs.statSync(file);
    if(st.mode&0o077||typeof process.getuid==='function'&&st.uid!==process.getuid())
     throw Error('producer_private_key_permissions_required');
   }
  }
 }
 checkPrivatePermissions();
 const keyBytes=pinned(keyPin?.file,keyPin?.sha256,8192);
 const privateKey=createPrivateKey(keyBytes);
 const publicKey=createPublicKey(privateKey);
 if(privateKey.asymmetricKeyType!=='ed25519'||
    hash(publicKey.export({type:'spki',format:'der'}))!==producer.publicKeySha256||
    !publicKey.export({type:'spki',format:'der'}).equals(createPublicKey(producer.publicKeyPem).export({type:'spki',format:'der'})))
  throw Error('producer_key_pair_changed');
 const expected={threadId,projectRoot:entry.projectRoot,route:ROUTE,goalSnapshotSha256:goalSha256,
  ownerRevision:entry.originalIssuerOwnerRevision,stopEpoch:entry.originalIssuerStopEpoch,
  previousStopEpoch:entry.originalIssuerPreviousStopEpoch,issuerReceiptSha256:entry.originalIssuerReceiptSha256,
  writerProcessIdentitySha256:entry.originalIssuerWriterProcessIdentitySha256};
 const inputPin=Object.freeze({...pin});
 const sourceModule=await import(pathToFileURL(reader.moduleFile).href+'?sha256='+reader.moduleSha256);
 const ownerModule=await import(pathToFileURL(authority.moduleFile).href+'?sha256='+authority.moduleSha256);
 if(typeof sourceModule[reader.exportName]!=='function'||typeof ownerModule[authority.exportName]!=='function')
  throw Error('producer_registered_export_required');
 const source=await sourceModule[reader.exportName](inputPin);
 const owner=await ownerModule[authority.exportName](Object.freeze({...expected,pin:inputPin}));
 const clock=now(),at=Date.parse(source?.observedAt??''),quotaAt=Date.parse(source?.quotaObservedAt??''),ownerAt=Date.parse(owner?.observedAt??'');
 if(source?.state!=='ORIGINAL_SELECTION_QUOTA_CHAIN_VERIFIED_SENDER_AUTHORITY_REQUIRED'||
    source.threadId!==threadId||!UUID.test(source.turnId??'')||!SHA.test(source.accountIdSha256??'')||
    !Number.isSafeInteger(source.credentialGeneration)||source.credentialGeneration<0||
    !SHA.test(source.failureReceiptSha256??'')||source.attestationSha256!==pin.attestationSha256||
    source.recoveryReceiptSha256!==pin.recoverySha256||
    source.originalTerminal?.threadId!==threadId||source.originalTerminal?.turnId!==source.turnId||
    !['turn_failed','turn_aborted','task_complete'].includes(source.originalTerminal?.terminalType)||
    !SHA.test(source.originalTerminal?.terminalSha256??'')||
    source.sourceOnly!==true||source.originalIssuerVerified!==false||source.writerReturned!==false||
    source.issuerAuthorityGranted!==false||source.dispatchable!==false||source.modelRequests!==0||source.newTurns!==0||
    !Number.isSafeInteger(source.originalResetAt)||source.originalResetAt<=0||
    typeof source.backendLimitProven!=='boolean'||
    at<source.originalResetAt*1000||quotaAt<source.originalResetAt*1000||
    ![clock,at,quotaAt,ownerAt].every(Number.isFinite)||at>clock||quotaAt>at||ownerAt>clock||
    clock-at>=60000||clock-quotaAt>=60000||clock-ownerAt>=60000)
  throw Error('producer_original_selection_or_freshness_hold');
 if(owner?.kind!=='aicc-original-cli-issuer-authority-observation/v1'||
    Object.keys(expected).some(k=>owner[k]!==expected[k])||
    owner.failedTurnId!==source.turnId||owner.terminalSha256!==source.originalTerminal.terminalSha256||
    owner.accountIdSha256!==source.accountIdSha256||owner.ownerRequestId!==pin.ownerRequestId||
    owner.credentialGeneration!==source.credentialGeneration||owner.attestationSha256!==pin.attestationSha256||
    owner.failureReceiptSha256!==source.failureReceiptSha256||owner.admissionReceiptSha256!==pin.recoverySha256||
    owner.originalIssuerBound!==true||owner.writerReturned!==true||owner.writerClosed!==true||
    owner.pendingSettled!==true||owner.stopRequested!==false||!['active','usageLimited'].includes(owner.goalStatus))
  throw Error('producer_original_owner_authority_hold');
 function recheck(){
  checkPrivatePermissions();
  pinned(registryFile,registrySha256);
  pinned(producer.executableFile,hash(executable),134217728);
  pinned(authority.moduleFile,hash(authorityBytes),16777216);
  pinned(reader.moduleFile,hash(readerBytes),16777216);
  pinned(keyPin.file,hash(keyBytes),8192);
 }
 recheck();
 const callback={kind:'aicc-original-cli-issuer-callback/v1',...expected,
  failedTurnId:source.turnId,terminalSha256:source.originalTerminal.terminalSha256,
  accountIdSha256:source.accountIdSha256,failureReceiptSha256:source.failureReceiptSha256,
  admissionReceiptSha256:pin.recoverySha256,quotaSourceKind:'ocx-selection',ownerRequestId:pin.ownerRequestId,
  credentialGeneration:source.credentialGeneration,attestationSha256:pin.attestationSha256,
  originalIssuerBound:true,writerReturned:true,writerClosed:true};
 const payload=Buffer.from(JSON.stringify({...callback,producerExecutableSha256:producer.executableSha256,
  observedAt:new Date(clock).toISOString()}));
 callback.signedSource={kind:'aicc-original-cli-issuer-signed-source/v1',keyId:producer.keyId,
  payloadBase64:payload.toString('base64'),signatureBase64:sign(null,payload,privateKey).toString('base64')};
 if(!verifyRegisteredOriginalIssuerCallback({callback,producer,binding:callback,now:()=>clock}).authenticated)
  throw Error('producer_consumer_verification_failed');
 if(!path.isAbsolute(outputFile??'')||path.dirname(path.resolve(outputFile))!==path.dirname(path.resolve(keyPin.file))||
    fs.existsSync(outputFile))throw Error('producer_new_owner_local_output_required');
 recheck();
 const bytes=Buffer.from(JSON.stringify(callback));
 const fd=fs.openSync(outputFile,'wx',0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 // A committed file survives a readback error; callers reconcile it, never replay.
 pinned(outputFile,hash(bytes),65536);
 return {state:'ORIGINAL_CALLBACK_SEALED_NOT_REGISTERED',receiptFile:outputFile,receiptSha256:hash(bytes),
  registrationChanged:false,dispatchable:false,issuerAuthorityGranted:false,modelRequests:0,newTurns:0};
}
