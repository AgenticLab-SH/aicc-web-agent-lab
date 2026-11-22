import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {CodexAppServerClient} from '../../../src/adapters/codex-app-server.mjs';
const executable=path.join(os.homedir(),'AppData/Local/Programs/OpenAI/Codex/bin/codex.exe');
const client=new CodexAppServerClient({executable,cwd:os.homedir(),timeoutMs:30000,
  manifest:{codexVersion:'0.160.0',productionStableAllowlist:['windowsSandbox/readiness']},
  spawnProcess:(command,args,options)=>spawn(command,args,{...options,windowsHide:true})});
try{
  await client.connect();
  const readiness=await client.request('windowsSandbox/readiness',{});
  console.log(JSON.stringify({schemaVersion:1,executable,readiness,authChanged:false,setupRequested:false}));
}finally{client.close();}
