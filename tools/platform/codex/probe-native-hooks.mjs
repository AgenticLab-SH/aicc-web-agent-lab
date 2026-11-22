import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {CodexAppServerClient} from '../../../src/adapters/codex-app-server.mjs';
const client=new CodexAppServerClient({executable:path.join(os.homedir(),'AppData/Local/Programs/OpenAI/Codex/bin/codex.exe'),
 cwd:os.homedir(),timeoutMs:30000,manifest:{codexVersion:'0.160.0',productionStableAllowlist:['hooks/list']},
 spawnProcess:(command,args,options)=>spawn(command,args,{...options,windowsHide:true})});
try{await client.connect();console.log(JSON.stringify(await client.request('hooks/list',{cwds:[os.homedir()]})));}
finally{client.close();}
