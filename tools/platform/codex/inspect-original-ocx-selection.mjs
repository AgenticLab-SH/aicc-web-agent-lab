// Existing owner-local continuity inspector. Never starts an App Server, sends
// a model message or changes a registration. All authority comes from pins.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectOriginalOcxSelectionQuotaChain} from '../../../src/codex-goal-resume.mjs';
import {CodexAppServerClient,loadAppServerManifest} from '../../../src/adapters/codex-app-server.mjs';
import {createCodexAppServerProxySpawn} from '../../../src/adapters/codex-app-server-proxy.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const denied=state=>({state,dispatchable:false,modelRequests:0,newTurns:0,queueAck:false,registrationChanged:false,automaticRetry:false});
export async function inspectInstalledOriginalOcxSelection(options){
 let client;
 // The consumer performs the pending, stop and reader gates before this lazy
 // connection. Missing daemon is an error, never permission to launch one.
 const connect=async()=>{
  if(client)return client;
  const file=options.manifestFile;
  if(!path.isAbsolute(file??'')||sha(fs.readFileSync(file))!==options.manifestSha256)
   throw Error('original_selection_manifest_pin');
  const manifest=loadAppServerManifest(file);
  if(sha(fs.readFileSync(manifest.executable))!==manifest.executableSha256)
   throw Error('original_selection_binary_pin');
  const probe=spawnSync(manifest.executable,['app-server','daemon','version'],{encoding:'utf8',windowsHide:true,timeout:10000});
  if(probe.error||probe.status!==0)throw Error('original_selection_daemon_unavailable');
  const daemon=JSON.parse(probe.stdout);
  if(daemon.status!=='running'||daemon.appServerVersion!==manifest.codexVersion||
   sha(fs.readFileSync(daemon.managedCodexPath))!==manifest.executableSha256)
   throw Error('original_selection_original_daemon_required');
  client=new CodexAppServerClient({executable:manifest.executable,manifest,
   spawnProcess:createCodexAppServerProxySpawn({socketPath:daemon.socketPath})});
  await client.connect();return client;
 };
 try{return await inspectOriginalOcxSelectionQuotaChain({...options,
  // Allowlist here enables only the lazy read. The loaded installed manifest
  // is checked by CodexAppServerClient before every real RPC.
  manifest:{productionStableAllowlist:['thread/read','thread/goal/get']},
  client:{threadRead:async p=>(await connect()).threadRead(p),
   threadGoalGet:async p=>(await connect()).threadGoalGet(p)}});
 }catch{return denied('ORIGINAL_SELECTION_INSPECTION_UNAVAILABLE_HOLD');}
 finally{client?.close();}
}
export async function main(args=process.argv.slice(2)){
 const names=['--thread','--root','--goal-sha256','--registry','--registry-sha256',
  '--reader','--reader-sha256','--owner-request','--attestation-sha256','--recovery-sha256',
  '--manifest','--manifest-sha256'];
 if(args.length!==names.length*2||names.some(k=>args.filter(x=>x===k).length!==1)||
  args.some((x,i)=>i%2===0&&!names.includes(x)))throw Error('original_selection_exact_arguments');
 const v=k=>args[args.indexOf(k)+1];
 return inspectInstalledOriginalOcxSelection({threadId:v('--thread'),projectRoot:v('--root'),
  expectedGoalSha256:v('--goal-sha256'),continuityRegistryFile:v('--registry'),
  expectedContinuityRegistrySha256:v('--registry-sha256'),
  sourceReaderPin:{moduleFile:v('--reader'),moduleSha256:v('--reader-sha256'),exportName:'readOriginalCliQuotaReceiptChain'},
  pin:{ownerRequestId:v('--owner-request'),attestationSha256:v('--attestation-sha256'),recoverySha256:v('--recovery-sha256')},
  manifestFile:v('--manifest'),manifestSha256:v('--manifest-sha256')});
}
if(path.resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await main()));}
 catch{console.log(JSON.stringify(denied('ORIGINAL_SELECTION_EXACT_INPUTS_HOLD')));process.exitCode=4;}
}
