import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

// Thin lifecycle adapter around the installed RDC owner, not another MCP server.
const root=path.join(os.homedir(),'.desktop-commander-device');
const control=path.join(root,'control');
fs.mkdirSync(control,{recursive:true});
const config=JSON.parse(fs.readFileSync(path.join(root,'managed-runtime.json'),'utf8'));
if(!path.isAbsolute(config.deviceModule)||createHash('sha256').update(fs.readFileSync(config.deviceModule)).digest('hex')!==config.deviceModuleSha256)throw new Error('RDC module pin differs');
const instanceId=randomUUID(),startedAt=new Date(Date.now()-process.uptime()*1000).toISOString();
let phase='STARTING',active=0,unknown=0,closing=false,shutdownFault=false,started=false;
function atomic(file,value){const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.renameSync(temp,file);}
function status(){if(started&&!closing&&['CONNECTED','DISCONNECTED'].includes(phase))phase=device.remoteChannel.isReachable()?'CONNECTED':'DISCONNECTED';atomic(path.join(control,'state.json'),{schemaVersion:1,pid:process.pid,instanceId,startedAt,observedAt:new Date().toISOString(),phase,active,unknown,capabilities:['hotRotate'],deviceId:device.deviceId});}
// RDC's stock console includes full tool arguments/results. Keep only lifecycle
// metadata here; never log authentication URLs, tokens or tool payloads.
console.debug=()=>{};console.info=()=>{};console.log=()=>{};
const note=(...args)=>{if(closing&&/shutdown error|close timeout|close.*error/i.test(args.map(String).join(' ')))shutdownFault=true;};
console.warn=note;console.error=note;
const {MCPDevice}=await import(pathToFileURL(config.deviceModule).href);
const device=new MCPDevice({persistSession:true});
const handle=device.handleNewToolCall.bind(device);
device.handleNewToolCall=async payload=>{
 if(closing)return;
 active++;status();
 try{return await handle(payload);}catch(error){unknown++;throw error;}finally{active--;status();}
};
// The stock method may swallow a failed terminal write. Observe the actual
// database update result rather than interpreting a returned Promise as ACK.
const start=device.remoteChannel.initialize.bind(device.remoteChannel);
device.remoteChannel.initialize=(...args)=>{
 const result=start(...args),client=device.remoteChannel.client;
 const from=client.from.bind(client);
 client.from=(table)=>{
  const query=from(table);
  if(table!=='mcp_remote_calls')return query;
  const update=query.update.bind(query);
  query.update=(...values)=>{
   const operation=update(...values),then=operation.then.bind(operation);
   operation.then=(fulfilled,rejected)=>then(result=>{if(result?.error){unknown++;status();}return fulfilled?fulfilled(result):result;},rejected);
   return operation;
  };
  return query;
 };
 return result;
};
// Account transport replacement keeps desktop.mcpClient/mcpTransport and all
// long-running local sessions alive. Credentials stay on the owner-local pipe.
function profileStore(action,profile,value,commit=false){
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(profile))throw Error('Invalid profile');
 const helper=config.profileStore;
 if(!helper||createHash('sha256').update(fs.readFileSync(helper)).digest('hex')!==config.profileStoreSha256)throw Error('Profile store pin differs');
 const args=['-NoProfile','-NonInteractive','-File',helper,'-Action',action,'-Profile',profile];if(commit)args.push('-Commit');
 return JSON.parse(execFileSync(config.powershell,args,{input:value?JSON.stringify(value):undefined,encoding:'utf8',windowsHide:true,timeout:15000,stdio:['pipe','pipe','pipe']}));
}
async function pending(channel,id){
 const r=await channel.client.from('mcp_remote_calls').select('id,status').eq('device_id',id).in('status',['pending','executing']).limit(1);
 if(r.error||!Array.isArray(r.data))throw Error('Pending calls unknown');return r.data.length>0;
}
async function hotRotate(profile){
 const target=profileStore('Read',profile),old=device.remoteChannel,oldId=device.deviceId;
 if(target.deviceId===oldId)return;
 if(active||unknown||await pending(old,oldId))throw Error('Calls busy or unknown');
 const {RemoteChannel}=await import(pathToFileURL(path.join(path.dirname(config.deviceModule),'remote-channel.js')).href);
 const candidate=new RemoteChannel();let committed=false,detached=false;
 const preserve=async rotated=>{
  const live=rotated??(await candidate.getSession()).data?.session;
  if(!live?.access_token||!live?.refresh_token)throw Error('Session unavailable');
  target.session={access_token:live.access_token,refresh_token:live.refresh_token};
  profileStore('Store',profile,target,committed);
 };
 let persistence=Promise.resolve();candidate.onSessionRefreshed(session=>{persistence=persistence.then(()=>preserve(session)).catch(()=>{unknown++;status();});});
 try{
  const info=await device.fetchSupabaseConfig();candidate.initialize(info.supabaseUrl,info.anonKey);
  const candidateFrom=candidate.client.from.bind(candidate.client);
  candidate.client.from=table=>{const q=candidateFrom(table);if(table!=='mcp_remote_calls')return q;const update=q.update.bind(q);q.update=(...v)=>{const op=update(...v),then=op.then.bind(op);op.then=(ok,fail)=>then(r=>{if(r?.error){unknown++;status();}return ok?ok(r):r;},fail);return op;};return q;};
  const expected=JSON.parse(Buffer.from(target.session.access_token.split('.')[1],'base64url').toString()).sub;
  const auth=await candidate.setSession(target.session);await preserve();
  if(auth.error||candidate.user?.id!==expected||!(await candidate.findDevice(target.deviceId)))throw Error('Target identity unavailable');
  if(active||unknown||await pending(old,oldId))throw Error('Activity changed');
  phase='SWITCHING';status();old.stopHeartbeat();await old.unsubscribe();detached=true;
  if(active||unknown||await pending(old,oldId))throw Error('Unresolved old calls');
  await device.configWriteChain;
  const current=JSON.parse(fs.readFileSync(path.join(root,'device.json'),'utf8'));
  profileStore('Store','device-'+oldId.slice(0,8),current);
  await old.setOffline(oldId);
  device.remoteChannel=candidate;device.deviceId=target.deviceId;committed=true;
  await persistence;await preserve();
  await candidate.registerDevice(await device.desktop.listClientTools(),device.deviceId,os.hostname(),payload=>device.handleNewToolCall(payload));
  candidate.startHeartbeat(device.deviceId);if(unknown)throw Error('Result persistence uncertain');phase='CONNECTED';status();
 }catch(error){
  if(!committed){candidate.stopHeartbeat();await candidate.unsubscribe().catch(()=>{});}
  if(detached){unknown++;phase='ROTATION_UNCERTAIN';}else phase='CONNECTED';status();throw error;
 }
}
status();
const heartbeat=setInterval(status,2000);
let pollBusy=false;
const poll=setInterval(async()=>{
 if(pollBusy||closing)return;pollBusy=true;
 try{
  for(const name of fs.readdirSync(control).filter(name=>/^[a-f0-9-]{36}\.request\.json$/.test(name))){
   const file=path.join(control,name),response=file.replace('.request.json','.response.json');
   if(fs.existsSync(response))continue;
   const request=JSON.parse(fs.readFileSync(file,'utf8'));
   if(request.instanceId!==instanceId)continue;
   if(request.requestId+'.request.json'!==name||!['stop','rotate'].includes(request.action)||Date.parse(request.expiresAt)<=Date.now()||Date.parse(request.expiresAt)>Date.now()+30000){atomic(response,{requestId:request.requestId,instanceId,stopped:false,reason:'invalid_or_expired'});continue;}
   if(phase!=='CONNECTED'||active!==0||unknown!==0){atomic(response,{requestId:request.requestId,instanceId,stopped:false,reason:'busy_or_unknown'});continue;}
   if(request.action==='rotate'){
    try{await hotRotate(request.profile);atomic(response,{requestId:request.requestId,instanceId,rotated:true,deviceId:device.deviceId,localCorePreserved:true});}
    catch{atomic(response,{requestId:request.requestId,instanceId,rotated:false,reason:unknown?'rotation_uncertain':'busy_or_auth_failed'});}
    continue;
   }
   closing=true;phase='STOPPING';status();
   try{
    await device.configWriteChain;
    await device.shutdown();
    if(shutdownFault||device.desktop.isReady!==false||device.desktop.mcpClient||device.desktop.mcpTransport)throw new Error('Normal shutdown unconfirmed');
    phase='STOPPED';status();atomic(response,{requestId:request.requestId,instanceId,stopped:true});
    clearInterval(heartbeat);clearInterval(poll);setTimeout(()=>process.exit(0),100);return;
   }catch{phase='STOP_UNCERTAIN';unknown++;status();atomic(response,{requestId:request.requestId,instanceId,stopped:false,reason:'shutdown_unconfirmed'});}
  }
 }catch{phase='CONTROL_ERROR';status();}finally{pollBusy=false;}
},200);
try{await device.start();started=true;phase='CONNECTED';status();}catch{phase='START_FAILED';status();process.exitCode=1;}
