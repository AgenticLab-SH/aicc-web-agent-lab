import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CodexAppServerClient,loadAppServerManifest} from '../../../src/adapters/codex-app-server.mjs';
import {createCodexAppServerProxySpawn} from '../../../src/adapters/codex-app-server-proxy.mjs';
import {prepareOriginalIssuerCallbackRegistration} from '../../../src/codex-goal-resume.mjs';
import {inspectRegisteredOriginalIssuerProducer} from '../../../src/original-cli-issuer-producer.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const hold=state=>({state,canApply:false,registrationChanged:false,
 dispatchable:false,modelRequests:0,newTurns:0,automaticRetry:false});
export async function inspectInstalledOriginalIssuerCallback(o,{
 probe=spawnSync,makeProxy=createCodexAppServerProxySpawn,
 makeClient=options=>new CodexAppServerClient(options),
 inspect=prepareOriginalIssuerCallbackRegistration
}={}){
 let client;
 try{
 const manifestFile=o.manifestFile,pin=o.manifestSha256;
 if(!path.isAbsolute(manifestFile??'')||sha(fs.readFileSync(manifestFile))!==pin)
  return hold('ORIGINAL_CALLBACK_MANIFEST_PIN_HOLD');
 const manifest=loadAppServerManifest(manifestFile);
 // This inspection must not connect with a manifest that can send work.
 const methods=['thread/read','thread/goal/get','account/rateLimits/read'];
 if(!Array.isArray(manifest.productionStableAllowlist)||
    methods.some(m=>!manifest.productionStableAllowlist.includes(m))||
    manifest.productionStableAllowlist.some(m=>!methods.includes(m))||
    manifest.officialQuotaRead?.method!=='account/rateLimits/read'||
    manifest.officialQuotaRead.readOnly!==true||
    manifest.officialQuotaRead.senderAllowed!==false||
    manifest.officialQuotaRead.originalCliIssuerBound!==false||
    manifest.officialQuotaRead.quotaRecoveryAuthority!==false)
  return hold('ORIGINAL_CALLBACK_READ_ONLY_CONTRACT_HOLD');
 if(!path.isAbsolute(manifest.executable??'')||
    sha(fs.readFileSync(manifest.executable))!==manifest.executableSha256)
  return hold('ORIGINAL_CALLBACK_BINARY_PIN_HOLD');
 // Reuse the producer's pinned local preflight before touching the daemon.
 // Historical pending and maintenance stops cannot be fixed by a connection.
 const readiness=inspectRegisteredOriginalIssuerProducer({registryFile:o.registryFile,
  registrySha256:o.registrySha256,threadId:o.threadId});
 if(readiness.state!=='ORIGINAL_PRODUCER_REGISTERED_LIVE_OBSERVATION_REQUIRED')
  return hold(readiness.state);
 const result=probe(manifest.executable,['app-server','daemon','version'],
  {encoding:'utf8',windowsHide:true,timeout:10000});
 if(result.error||result.status!==0)
  return hold('ORIGINAL_CALLBACK_ORIGINAL_DAEMON_UNAVAILABLE_HOLD');
 const daemon=JSON.parse(result.stdout);
 if(daemon.status!=='running'||daemon.appServerVersion!==manifest.codexVersion||
  !path.isAbsolute(daemon.managedCodexPath??'')||
  sha(fs.readFileSync(daemon.managedCodexPath))!==manifest.executableSha256)
  return hold('ORIGINAL_CALLBACK_ORIGINAL_DAEMON_IDENTITY_HOLD');
 // The version probe and awaited source reads yield to installers. Verify both
 // paths, including a separate daemon copy, before connecting and accepting.
 const installationUnchanged=()=>sha(fs.readFileSync(manifestFile))===pin&&
  sha(fs.readFileSync(manifest.executable))===manifest.executableSha256&&
  sha(fs.readFileSync(daemon.managedCodexPath))===manifest.executableSha256;
 if(!installationUnchanged())
  return hold('ORIGINAL_CALLBACK_INSTALLATION_DRIFT_HOLD');
 client=makeClient({executable:manifest.executable,manifest,
  spawnProcess:makeProxy({socketPath:daemon.socketPath})});
  await client.connect();
  const observation=await inspect({client,manifest,
   threadId:o.threadId,projectRoot:o.projectRoot,expectedGoalSha256:o.goalSha256,
   handoffFile:o.handoffFile,expectedHandoffFileSha256:o.handoffSha256,
   continuityRegistryFile:o.registryFile,expectedContinuityRegistrySha256:o.registrySha256,
   registrationCandidatePin:{kind:'aicc-original-cli-issuer-callback-pin/v1',
    receiptFile:o.callbackFile,receiptSha256:o.callbackSha256}});
  if(!installationUnchanged())
   return hold('ORIGINAL_CALLBACK_INSTALLATION_DRIFT_HOLD');
  return observation;
 }catch{return hold('ORIGINAL_CALLBACK_INSPECTION_UNAVAILABLE_HOLD');}
 finally{client?.close();}
}
export async function main(args=process.argv.slice(2)){
 const keys={'--manifest':'manifestFile','--manifest-sha256':'manifestSha256',
  '--thread':'threadId','--root':'projectRoot','--goal-sha256':'goalSha256',
  '--handoff':'handoffFile','--handoff-sha256':'handoffSha256',
  '--registry':'registryFile','--registry-sha256':'registrySha256',
  '--callback':'callbackFile','--callback-sha256':'callbackSha256'};
 if(args.length!==Object.keys(keys).length*2||
    args.some((x,i)=>i%2===0&&!keys[x])||
    Object.keys(keys).some(k=>args.filter(x=>x===k).length!==1))
  return hold('ORIGINAL_CALLBACK_EXACT_ARGUMENTS_HOLD');
 const o={};for(let i=0;i<args.length;i+=2)o[keys[args[i]]]=args[i+1];
 return inspectInstalledOriginalIssuerCallback(o);
}
if(path.resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
 const result=await main();console.log(JSON.stringify(result));
 if(!result.canApply)process.exitCode=4;
}
