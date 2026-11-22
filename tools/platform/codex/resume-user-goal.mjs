import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CodexAppServerClient,loadAppServerManifest} from '../../../src/adapters/codex-app-server.mjs';
import {createCodexAppServerProxySpawn} from '../../../src/adapters/codex-app-server-proxy.mjs';
import {goalSnapshotSha256,resumeExistingThreadGoal} from '../../../src/codex-goal-resume.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
function arg(name){const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];}
export async function main(){
 const threadId=arg('--thread'),root=arg('--root'),manifestFile=arg('--manifest'),pin=arg('--manifest-sha256');
 if(!path.isAbsolute(manifestFile??'')||!path.isAbsolute(root??'')||!pin||sha(fs.readFileSync(manifestFile))!==pin)
  throw Error('goal_resume_pinned_manifest_and_root_required');
 const manifest=loadAppServerManifest(manifestFile);
 if(sha(fs.readFileSync(manifest.executable))!==manifest.executableSha256)throw Error('goal_resume_binary_changed');
 const probe=spawnSync(manifest.executable,['app-server','daemon','version'],{encoding:'utf8',windowsHide:true,timeout:10000});
 if(probe.error||probe.status!==0)throw Error('goal_resume_daemon_version_unavailable');
 const daemon=JSON.parse(probe.stdout);
 if(daemon.status!=='running'||daemon.appServerVersion!==manifest.codexVersion||
   sha(fs.readFileSync(daemon.managedCodexPath))!==manifest.executableSha256)
  throw Error('goal_resume_same_daemon_binary_required');
 const client=new CodexAppServerClient({executable:manifest.executable,manifest,
   spawnProcess:createCodexAppServerProxySpawn({socketPath:daemon.socketPath})});
 try {
  await client.connect();
  if(!process.argv.includes('--apply')){
   const {thread}=await client.threadRead({threadId,includeTurns:false});
   if(thread?.id!==threadId||path.resolve(thread.cwd??'')!==path.resolve(root))throw Error('goal_resume_thread_root_mismatch');
   const {goal}=await client.threadGoalGet({threadId});
   if(!goal)throw Error('goal_resume_existing_goal_required');
   return {state:'PREVIEW',threadId,status:goal.status,snapshotSha256:goalSnapshotSha256(goal),mutations:0};
  }
  return await resumeExistingThreadGoal({client,manifest,threadId,projectRoot:root,
   expectedGoalSha256:arg('--expected-goal-sha256'),
   authorization:{kind:'explicit-user-goal-resume',threadId,reference:arg('--user-request-ref')}});
 }finally{client.close();}
}
if(path.resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
 try {console.log(JSON.stringify(await main()));}
 catch(error){console.error(JSON.stringify({state:'HOLD',code:error.code??null,reason:error.message,automaticRetry:false}));process.exitCode=4;}
}
