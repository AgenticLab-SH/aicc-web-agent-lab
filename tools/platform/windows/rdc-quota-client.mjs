import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const endpoint='https://mcp.desktopcommander.app/mcp';
function fault(phase,message){return Object.assign(Error(message),{phase});}
function identity(session,target){
 let jwt;try{jwt=JSON.parse(Buffer.from(session.access_token.split('.')[1],'base64url'));}catch{throw fault('AUTH_REQUIRED','Stored RDC session is invalid; no automatic login.');}
 if(jwt.sub!==target.userId)throw fault('IDENTITY_MISMATCH','Stored RDC identity differs; session preserved.');
 return jwt;
}
export function quotaResult(value,target){
 if(!value||value.id!==target.userId||String(value.email).toLowerCase()!==target.email.toLowerCase())throw fault('IDENTITY_MISMATCH','Official RDC identity differs; quota not accepted.');
 const remaining=value.remote_calls_left_pct;
 if(typeof remaining!=='number'||!Number.isFinite(remaining)||remaining<0||remaining>100)throw fault('HOLD','Official RDC quota is invalid.');
 return {phase:'USAGE_OBSERVED',profile:target.profile,remainingPercent:remaining,observedAt:new Date().toISOString(),source:'rdc-who_am_i',usageRejected:false,lastSignInAt:value.last_sign_in_at??null};
}
async function checkedJson(fetcher,url,options){
 const response=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(25000)});
 if(response.status===401||response.status===403)throw fault(response.status===403?'SECURITY_REFUSED':'AUTH_REQUIRED','Official RDC authentication refused; no retry or login.');
 if(!response.ok)throw fault('HOLD','Official RDC request failed ('+response.status+'); no retry.');
 const type=response.headers.get('content-type')||'';
 if(!type.includes('application/json'))throw fault('HOLD','Official RDC response type changed.');
 return response.json();
}
export async function readRdcQuota({target,profile,currentDeviceId,fetcher=fetch,refresh,store}){
 if(profile.deviceId!==target.deviceId)throw fault('IDENTITY_MISMATCH','Stored RDC device differs; preserved.');
 let session=profile.session;const jwt=identity(session,target);
 if(!Number.isFinite(jwt.exp)||jwt.exp*1000<=Date.now()+60000){
  // The live agent is the sole refresh writer for its current account.
  if(currentDeviceId===target.deviceId)throw fault('AUTH_REFRESH_PENDING','Current RDC agent owns token refresh; connection unchanged.');
  if(!refresh)throw fault('AUTH_REQUIRED','Stored RDC session expired; no automatic login.');
  session=await refresh(session);identity(session,target);
  if(!session.refresh_token)throw fault('AUTH_REQUIRED','Refreshed RDC session incomplete.');
  await store({...profile,session:{access_token:session.access_token,refresh_token:session.refresh_token}});
 }
 const headers={Authorization:'Bearer '+session.access_token,Accept:'application/json, text/event-stream','Content-Type':'application/json'};
 const init=await checkedJson(fetcher,endpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'aicc-rdc-quota-read',version:'1.0.0'}}})});
 if(init.error||init.result?.serverInfo?.name!=='desktop-commander-remote-mcp')throw fault('HOLD','Official RDC MCP initialization differs.');
 const reply=await checkedJson(fetcher,endpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'who_am_i',arguments:{}}})});
 if(reply.error||reply.result?.isError)throw fault('HOLD','Official RDC who_am_i failed.');
 let value;try{value=JSON.parse(reply.result.content.find(c=>c.type==='text').text);}catch{throw fault('HOLD','Official RDC who_am_i response differs.');}
 return quotaResult(value,target);
}
export function quotaProfile(target,stored,current){
 // Current live agent exclusively refreshes its session. Its owner file is
 // authoritative for read-only quota; the inactive DPAPI copy may be old.
 if(current.deviceId===target.deviceId){identity(current.session,target);return current;}
 return stored;
}
export async function runQuota(cfg,target){
 const root=path.join(os.homedir(),'.desktop-commander-device');
 const managed=JSON.parse(fs.readFileSync(path.join(root,'managed-runtime.json'),'utf8'));
 const helper=managed.profileStore;
 if(!path.isAbsolute(helper)||createHash('sha256').update(fs.readFileSync(helper)).digest('hex')!==managed.profileStoreSha256)throw fault('HOLD','Profile store pin differs.');
 const storeProfile=(action,value)=>JSON.parse(execFileSync(cfg.powershell,['-NoProfile','-NonInteractive','-File',helper,'-Action',action,'-Profile',target.profile],{input:value?JSON.stringify(value):undefined,encoding:'utf8',windowsHide:true,timeout:15000,stdio:['pipe','pipe','pipe']}));
 const current=JSON.parse(fs.readFileSync(path.join(root,'device.json'),'utf8'));
 const currentDeviceId=current.deviceId;
 const profile=quotaProfile(target,currentDeviceId===target.deviceId?null:storeProfile('Read'),current);
 const refresh=async session=>{
  // Existing installed SDK and configured public auth contract. No OAuth/browser login.
  if(createHash('sha256').update(fs.readFileSync(managed.deviceModule)).digest('hex')!==managed.deviceModuleSha256)throw fault('HOLD','RDC owner module pin differs.');
  const info=await checkedJson(fetch,'https://mcp.desktopcommander.app/api/mcp-info',{});
  if(typeof info.supabaseUrl!=='string'||new URL(info.supabaseUrl).protocol!=='https:'||!info.supabasePublishableKey)throw fault('HOLD','Official RDC auth contract differs.');
  const require=createRequire(managed.deviceModule),{createClient}=require('@supabase/supabase-js');
  const client=createClient(info.supabaseUrl,info.supabasePublishableKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(url,options)=>{
   const response=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(25000)});
   if(response.status===401||response.status===403)throw fault(response.status===403?'SECURITY_REFUSED':'AUTH_REQUIRED','Official RDC session refresh refused; no retry or login.');
   return response;
  }}});
  const {data,error}=await client.auth.setSession(session);
  if(error||!data.session||data.user?.id!==target.userId)throw fault(error?.status===403?'SECURITY_REFUSED':'AUTH_REQUIRED','Official RDC session refresh unavailable; existing connection preserved.');
  return data.session;
 };
 const result=await readRdcQuota({target,profile,currentDeviceId,refresh,store:value=>storeProfile('Store',value)});
 process.stdout.write(JSON.stringify(result)+'\n');return result;
}