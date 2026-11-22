// Read the original request through its existing daemon only. No startup,
// resume, queue mutation, alternative server, or registry settlement.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CodexAppServerClient,loadAppServerManifest} from '../../../src/adapters/codex-app-server.mjs';
import {createCodexAppServerProxySpawn} from '../../../src/adapters/codex-app-server-proxy.mjs';
import {inspectOriginalQueuedRequest} from '../../../src/codex-goal-resume.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const denied=state=>({state,readOnly:true,pendingPreserved:true,dispatchable:false,
 modelRequests:0,newTurns:0,queueMutations:0,registrationChanged:false,automaticReplay:false});
function pinned(file,expected){
 if(!path.isAbsolute(file??'')||!/^[a-f0-9]{64}$/.test(expected??''))throw Error('pin');
 for(let p=path.resolve(file);;p=path.dirname(p)){
  if(fs.lstatSync(p).isSymbolicLink())throw Error('alias');
  if(p===path.dirname(p))break;
 }
 const st=fs.statSync(file);if(!st.isFile()||st.size<1||st.size>2097152)throw Error('bounds');
 const bytes=fs.readFileSync(file);if(sha(bytes)!==expected)throw Error('changed');return bytes;
}
export async function inspectInstalledOriginalQueue(o,{probe=spawnSync,
 makeClient=options=>new CodexAppServerClient(options),
 makeProxy=options=>createCodexAppServerProxySpawn(options)}={}){
 let client;
 try{
  const registryBytes=pinned(o.registryFile,o.registrySha256);
  pinned(o.manifestFile,o.manifestSha256);
  const cfg=JSON.parse(registryBytes),entry=cfg.threads?.[o.threadId];
  const attempt=entry?.queueAttempt;
  if(cfg.schemaVersion!==1||cfg.protocolVersion!==3||entry?.threadId!==o.threadId||
    !path.isAbsolute(o.projectRoot??'')||path.resolve(entry.projectRoot??'')!==path.resolve(o.projectRoot)||
    cfg.excludedThreadIds?.includes(o.threadId)||!attempt||sha(JSON.stringify(attempt))!==o.attemptSha256)
   return denied('ORIGINAL_QUEUE_REGISTERED_RECEIPT_HOLD');
  const manifest=loadAppServerManifest(o.manifestFile),proof=manifest.originalQueueInspection;
  if(proof?.method!=='thread/queue/list'||proof.readOnly!==true||proof.senderAllowed!==false||
     !['thread/read','thread/queue/list'].every(m=>manifest.productionStableAllowlist?.includes(m))||
     manifest.productionStableAllowlist.some(m=>!['thread/read','thread/queue/list'].includes(m))||
     !path.isAbsolute(manifest.executable??'')||
     sha(fs.readFileSync(manifest.executable))!==manifest.executableSha256)
   return denied('ORIGINAL_QUEUE_INSTALLED_READ_CONTRACT_HOLD');
  if(attempt.binarySha256!==manifest.executableSha256)
   return denied('ORIGINAL_QUEUE_ISSUER_BINARY_MISMATCH_HOLD');
  const binaryUnchanged=()=>
   sha(fs.readFileSync(manifest.executable))===manifest.executableSha256;
  const result=probe(manifest.executable,['app-server','daemon','version'],
   {encoding:'utf8',windowsHide:true,timeout:10000});
  if(result.error||result.status!==0)return denied('ORIGINAL_QUEUE_ORIGINAL_DAEMON_UNAVAILABLE_HOLD');
  const daemon=JSON.parse(result.stdout);
  if(daemon.status!=='running'||daemon.appServerVersion!==manifest.codexVersion||
     !path.isAbsolute(daemon.managedCodexPath??'')||
     sha(fs.readFileSync(daemon.managedCodexPath))!==manifest.executableSha256)
   return denied('ORIGINAL_QUEUE_ORIGINAL_DAEMON_IDENTITY_HOLD');
  // Version probes and awaited reads yield to installation changes.
  pinned(o.registryFile,o.registrySha256);pinned(o.manifestFile,o.manifestSha256);
  if(!binaryUnchanged())return denied('ORIGINAL_QUEUE_ISSUER_INSTALLATION_DRIFT_HOLD');
  client=makeClient({executable:manifest.executable,manifest,
   spawnProcess:makeProxy({socketPath:daemon.socketPath})});
  await client.connect();
  const observation=await inspectOriginalQueuedRequest({client,manifest,threadId:o.threadId,
   projectRoot:o.projectRoot,attempt,expectedAttemptSha256:o.attemptSha256});
  pinned(o.registryFile,o.registrySha256);pinned(o.manifestFile,o.manifestSha256);
  if(!binaryUnchanged()||
     sha(fs.readFileSync(daemon.managedCodexPath))!==manifest.executableSha256)
   return denied('ORIGINAL_QUEUE_ISSUER_INSTALLATION_DRIFT_HOLD');
  return {...observation,registrationChanged:false};
 }catch{return denied('ORIGINAL_QUEUE_INSPECTION_UNAVAILABLE_HOLD');}
 finally{client?.close();}
}
export async function main(args=process.argv.slice(2)){
 const keys={'--thread':'threadId','--root':'projectRoot','--registry':'registryFile',
  '--registry-sha256':'registrySha256','--attempt-sha256':'attemptSha256',
  '--manifest':'manifestFile','--manifest-sha256':'manifestSha256'};
 if(args.length!==Object.keys(keys).length*2||args.some((x,i)=>i%2===0&&!keys[x])||
    Object.keys(keys).some(k=>args.filter(x=>x===k).length!==1))return denied('ORIGINAL_QUEUE_EXACT_ARGUMENTS_HOLD');
 const o={};for(let i=0;i<args.length;i+=2)o[keys[args[i]]]=args[i+1];
 return inspectInstalledOriginalQueue(o);
}
if(path.resolve(process.argv[1]??'')===fileURLToPath(import.meta.url))
 console.log(JSON.stringify(await main()));
