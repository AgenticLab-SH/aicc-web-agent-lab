// A disposable native turn against a local error fixture. No model inference,
// account change or external message; an existing notification binding aborts.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {CodexAppServerClient} from '../../../src/adapters/codex-app-server.mjs';
import {loadSessionBinding} from './notification-ack-hook.mjs';
const config=path.join(os.homedir(),'.codex/config.toml');
const digest=()=>crypto.createHash('sha256').update(fs.readFileSync(config)).digest('hex');
const before=digest();let requests=0,turnId,threadId,hook;
const server=http.createServer((req,res)=>{requests++;req.resume();res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":{"message":"Owned hook fixture; no inference performed"}}');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}/v1`;
const client=new CodexAppServerClient({executable:path.join(os.homedir(),'AppData/Local/Programs/OpenAI/Codex/bin/codex.exe'),
 cwd:os.homedir(),timeoutMs:30000,manifest:{codexVersion:'0.160.0',productionStableAllowlist:['thread/start','turn/start','turn/interrupt']},
 spawnProcess:(command,args,options)=>spawn(command,args,{...options,windowsHide:true}),
 env:{...process.env,AICC_HOOK_FIXTURE_KEY:'fixture-only'},
 args:['app-server','--listen','stdio://','-c','model_provider="hook-fixture"',
 '-c','model_providers.hook-fixture.name="Owned hook diagnostic"',
 '-c',`model_providers.hook-fixture.base_url=${JSON.stringify(base)}`,
 '-c','model_providers.hook-fixture.env_key="AICC_HOOK_FIXTURE_KEY"',
 '-c','model_providers.hook-fixture.requires_openai_auth=false',
 '-c','model_providers.hook-fixture.wire_api="responses"']});
client.on('notification',event=>{if(event.method==='hook/completed')hook=event.params;});
try{
 await client.connect();
 const thread=await client.threadStart({cwd:os.homedir(),model:'gpt-6.1-sol',ephemeral:true,approvalPolicy:'never',sandbox:'read-only'});
 threadId=thread.thread.id;
 if(loadSessionBinding(threadId))throw new Error('Unexpected notification binding; no hook run');
 const turn=await client.turnStart({threadId,input:[{type:'text',text:'Owned hook diagnostic. Do not use tools.',text_elements:[]}],model:'gpt-6.1-sol',approvalPolicy:'never'});
 turnId=turn.turn.id;
 const deadline=Date.now()+12000;
 while(!hook&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
 await client.turnInterrupt({threadId,turnId}).catch(()=>{});
 const run=hook?.run??hook?.hook?.run??hook;
 console.log(JSON.stringify({schemaVersion:1,hookObserved:Boolean(hook),hookRun:run,
  localFixtureRequests:requests,modelInferencePerformed:false,notificationBinding:false,nativeConfigUnchanged:digest()===before}));
 if(!hook)process.exitCode=1;
}finally{
 if(turnId)await client.turnInterrupt({threadId,turnId}).catch(()=>{});
 client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
