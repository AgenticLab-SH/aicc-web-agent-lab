// Owner-authorized temporary local request. No request content or credential receipt.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.AICC_OCX_PACKAGE_ROOT;
const load=relative=>import(pathToFileURL(path.join(root,relative)).href);
let server;
try{
  const auth=await load('src/aicc-local-auth.ts');
  await auth.initializeRemoteAuth();
  const {startServer}=await load('src/server/index.ts');
  server=startServer(10110);
  const readiness=await (await fetch('http://127.0.0.1:10110/healthz')).json();
  if(readiness.service!=='opencodex')throw Error('candidate_not_live');
  const denied=await fetch('http://127.0.0.1:10110/v1/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  if(denied.status!==401)throw Error('unauthenticated_request_not_refused');
  const response=await fetch('http://127.0.0.1:10110/v1/responses',{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.OPENCODEX_API_AUTH_TOKEN},
    body:JSON.stringify({model:'gpt-5.6-luna',instructions:'Return only 1.',input:[{role:'user',content:[{type:'input_text',text:'1'}]}],reasoning:{effort:'none'},max_output_tokens:16,stream:false,store:false}),signal:AbortSignal.timeout(45000)});
  const text=await response.text();
  if(!response.ok){console.log(JSON.stringify({terminal:'FAILED_LOCAL_REQUEST',status:response.status,errorCode:(()=>{try{const payload=JSON.parse(text),error=payload.error??payload;return typeof error==='string'?error.slice(0,180):error?.code??error?.message?.slice(0,180)??JSON.stringify(payload).slice(0,180);}catch{return 'unparsed';}})()}));process.exitCode=2;}
  else{
    const data=JSON.parse(text);
    if(data.status!=='completed')throw Error('candidate_response_incomplete');
    const records=Object.values(auth.remoteRecords());
    if(records.some(row=>Boolean(row.credential?.refreshToken)))throw Error('local_refresh_token_found');
    if(fs.existsSync(path.join(process.env.OPENCODEX_HOME,'codex-accounts.json')))throw Error('credential_file_created');
    console.log(JSON.stringify({terminal:'PASS_LOCAL_DIRECT_REQUEST',version:readiness.version,responseStatus:data.status,requestExecution:'windows-local',authenticationEnforced:true,refreshTokenCount:0,credentialFileCreated:false}));
  }
}catch(error){console.log(JSON.stringify({terminal:'FAILED_LOCAL_RUNTIME',reason:String(error?.message??error?.name??'unknown').replace(/(?:Bearer\s+\S+|eyJ[A-Za-z0-9_.-]+|xox[bap]-\S+)/g,'[redacted]').slice(0,300)}));process.exitCode=2;}
finally{server?.stop(true);setTimeout(()=>process.exit(process.exitCode??0),100);}
