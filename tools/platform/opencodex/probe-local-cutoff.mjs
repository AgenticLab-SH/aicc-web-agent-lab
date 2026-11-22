// Owner-authorized local pipeline fault injection. Model requests are mocked;
// only identity/lease and observational quota calls can reach A1/OpenAI.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {mock} from 'bun:test';
const root=process.env.AICC_OCX_PACKAGE_ROOT;
const load=relative=>import(pathToFileURL(path.join(root,relative)).href);
let server,starts=0,aborted=0,cancelled=0;
try{
  const auth=await load('src/aicc-local-auth.ts');await auth.initializeRemoteAuth();
  const configuration=await load('src/config.ts');
  const config=configuration.loadConfig();
  config.providers.openai.upstreamWebsocket=false;
  configuration.saveConfig(config);
  const mockedInference=async (_url,init)=>{
    starts++;
    let source;
    init.signal.addEventListener('abort',()=>{aborted++;cancelled=1;source?.error(init.signal.reason);},{once:true});
    const body=new ReadableStream({start(controller){
      source=controller;
      controller.enqueue(new TextEncoder().encode('event: response.created\ndata: '+JSON.stringify({type:'response.created',sequence_number:0,response:{id:'resp_aicc_mock',object:'response',created_at:Math.floor(Date.now()/1000),status:'in_progress',model:'gpt-5.6-luna',output:[]}})+'\n\n'));
      setTimeout(()=>fs.writeFileSync(path.join(process.env.OPENCODEX_HOME,'aicc-window-policy.json'),JSON.stringify({schemaVersion:1,fiveHour:{usedThreshold:1,action:'switch'},longWindow:{usedThreshold:1,action:'switch'}})),250);
    },cancel(){cancelled=1;}});
    return new Response(body,{headers:{'Content-Type':'text/event-stream'}});
  };
  const transport=await load('src/lib/proxy-env.ts');
  mock.module(path.join(root,'src/lib/proxy-env.ts'),()=>({...transport,configuredOutboundFetch:(input,init)=>{
    const url=typeof input==='string'?input:input.url??input.toString();
    return url.startsWith('https://chatgpt.com/backend-api/codex/responses')?mockedInference(input,init):transport.configuredOutboundFetch(input,init);
  }}));
  const {startServer}=await load('src/server/index.ts');server=startServer(10110);
  const request=new Request('http://127.0.0.1:10110/v1/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.OPENCODEX_API_AUTH_TOKEN},body:JSON.stringify({model:'gpt-5.6-luna',instructions:'Return 1.',input:[{role:'user',content:[{type:'input_text',text:'1'}]}],stream:true,store:false}),signal:AbortSignal.timeout(30000)});
  const response=await fetch(request);const wire=await response.text();
  if(starts!==1||aborted!==1||cancelled!==1||!wire.includes('aicc_window_inflight_cutoff')||wire.includes('response.completed'))throw Error('cutoff_pipeline_incomplete');
  console.log(JSON.stringify({terminal:'PASS_LOCAL_PIPELINE_CUTOFF',mockInferenceSends:starts,upstreamAbortSignals:aborted,upstreamBodyTerminations:cancelled,automaticReplays:0,realInferenceSends:0}));
}catch(error){console.log(JSON.stringify({terminal:'FAILED_LOCAL_PIPELINE_CUTOFF',reason:String(error?.message??error?.name??'unknown').slice(0,140),mockInferenceSends:starts,upstreamAbortSignals:aborted,upstreamBodyCancellations:cancelled}));process.exitCode=2;}
finally{server?.stop(true);setTimeout(()=>process.exit(process.exitCode??0),100);}
