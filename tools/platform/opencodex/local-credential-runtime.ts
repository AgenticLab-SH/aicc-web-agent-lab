// In-process SSH bridge; refresh grants never leave their A1 owner.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFileSync,renameSync,mkdirSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import type {CodexAccountCredentialRecord,OcxConfig} from './types';
const ownerHome=()=>process.env.OPENCODEX_HOME!;
export const remoteMode=()=>process.env.AICC_OCX_LOCAL_AUTH==='1';
let records:Record<string,CodexAccountCredentialRecord>={};
let observedAt=0;
let snapshotFlight:Promise<void>|undefined;
let runtimeConfig:OcxConfig|undefined;
const leases=new Map<string,{at:number;value:any}>();
const flights=new Map<string,{promise:Promise<any>;recovering:boolean}>();
function rpc(request:unknown):Promise<any>{
  return new Promise((resolve,reject)=>{
    const child=spawn('ssh.exe',['-T','-o','BatchMode=yes','-o','ConnectTimeout=10','skct-relay-micro','/demo/owner/.local/bin/oracle-a1-connection exec -- python3 /demo/owner/.local/share/aicc-ocx-local/local-broker.py'],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    let body='',bytes=0,done=false;
    const finish=(error?:Error,value?:unknown)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(Error('credential_owner_timeout'));},45000);
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>262144){child.kill();finish(Error('credential_owner_response_limit'));}else body+=chunk;});
    child.stderr.on('data',()=>{}); // Never log remote auth diagnostics.
    child.once('error',()=>finish(Error('credential_owner_unavailable')));
    child.once('close',code=>{try{const value=JSON.parse(body);if(code!==0||value.ok!==true)throw Error();finish(undefined,value);}catch{finish(Error('credential_owner_unavailable'));}});
    child.stdin.on('error',()=>finish(Error('credential_owner_unavailable')));
    child.stdin.end(JSON.stringify(request));
  });
}
function atomic(name:string,value:unknown){const file=join(ownerHome(),name),temporary=file+'.new';writeFileSync(temporary,JSON.stringify(value)+'\n',{mode:0o600});renameSync(temporary,file);}
export function remoteRecords(){return records;}
export function persistRemoteRecords(value:Record<string,CodexAccountCredentialRecord>){
  // Validation metadata remains local and volatile. Refuse any refresh credential.
  if(Object.values(value).some(row=>Boolean(row.credential?.refreshToken)))throw Error('remote_refresh_grant_forbidden');
  records=value;
}
export function bindRemoteConfig(config:OcxConfig){runtimeConfig=config;}
export async function refreshRemoteSnapshot(force=false){
  if(!force&&Date.now()-observedAt<30000)return;
  if(snapshotFlight)return snapshotFlight;
  snapshotFlight=(async()=>{
    const value=await rpc({action:'snapshot'});
    const next:typeof records={};
    for(const [id,row] of Object.entries(value.records) as [string,CodexAccountCredentialRecord][]){
      const prior=records[id];
      next[id]=prior?.generation===row.generation?{...row,credential:prior.credential}:row;
      if(prior?.generation!==row.generation)leases.delete(id);
    }
    records=next;
    for(const id of leases.keys())if(!records[id])leases.delete(id);
    const configFile=join(ownerHome(),'config.json');
    // Local request selection owns activeCodexAccountId; never copy hub selection.
    if(runtimeConfig){
      const previousPin=runtimeConfig.activeCodexAccountPinned;
      Object.assign(runtimeConfig,value.config);
      if(!Object.hasOwn(value.config,'activeCodexAccountPinned'))delete runtimeConfig.activeCodexAccountPinned;
      if(value.config.activeCodexAccountPinned&&value.config.activeCodexAccountPinned!==previousPin)runtimeConfig.activeCodexAccountId=value.config.activeCodexAccountPinned;
      atomic('config.json',runtimeConfig);
    }
    else {
      let previous:any;
      if(existsSync(configFile)){
        try{previous=JSON.parse(readFileSync(configFile,'utf8'));}
        catch{throw Error('local_config_invalid_preserve_existing');}
      }
      const registered=(id:unknown)=>typeof id==='string'&&Object.hasOwn(records,id);
      const active=registered(value.config.activeCodexAccountPinned)?value.config.activeCodexAccountPinned
        :registered(previous?.activeCodexAccountId)?previous.activeCodexAccountId:undefined;
      const config={...value.config,port:10100,hostname:'127.0.0.1',runtimeRole:'standalone',
        ...(active?{activeCodexAccountId:active}:{}),
        codexAutoStart:false,clientIntegrations:{codex:false},codexQuotaAutoRefresh:{},
        claudeCode:{enabled:false,intercept:{enabled:false}},
        appOwnedMemoryBudgetMb:200,modelDiscovery:{enabled:false},visionSidecar:{enabled:false}};
      atomic('config.json',config);
    }
    atomic('aicc-window-policy.json',value.settings);
    observedAt=Date.now();
    atomic('remote-auth-status.json',{schemaVersion:1,observedAt,refreshTokenWriter:'a1',requestExecution:'windows-local',accountCount:Object.keys(records).length});
  })().finally(()=>{snapshotFlight=undefined;});
  return snapshotFlight;
}
export async function remoteToken(id:string,options:{signal?:AbortSignal;rejectedGeneration?:number;rejectedAccessToken?:string}={}):Promise<any>{
  if(options.signal?.aborted)throw options.signal.reason;
  const cached=leases.get(id);
  if(options.rejectedAccessToken===undefined&&cached&&Date.now()-cached.at<60000&&cached.value.expiresAt-Date.now()>60000)return cached.value;
  const recovering=options.rejectedAccessToken!==undefined;
  const pending=flights.get(id);
  if(recovering&&pending&&!pending.recovering){
    // A normal lease already in progress cannot stand in for rejected-token recovery.
    const current=await waitToken(pending.promise,options.signal);
    if(current.generation!==options.rejectedGeneration||current.accessToken!==options.rejectedAccessToken){
      return {...current,rotated:current.generation!==options.rejectedGeneration};
    }
    return remoteToken(id,options);
  }
  let flight=pending?.promise;
  if(!flight){
    flight=rpc(options.rejectedAccessToken===undefined?{action:'lease',id}:{action:'recover',id,generation:options.rejectedGeneration,rejectedHash:createHash('sha256').update(options.rejectedAccessToken).digest('hex')}).then(value=>{
      const row=records[id];if(!row)throw Error('remote_account_removed');
      records[id]={...row,generation:value.generation,credential:{accessToken:value.accessToken,refreshToken:'',chatgptAccountId:value.chatgptAccountId,expiresAt:value.expiresAt}};
      const result={accessToken:value.accessToken,chatgptAccountId:value.chatgptAccountId,generation:value.generation,expiresAt:value.expiresAt,
        rotated:options.rejectedGeneration!==undefined&&value.generation!==options.rejectedGeneration,selfRefreshed:false,provenance:'external-replacement'};
      leases.set(id,{at:Date.now(),value:result});return result;
    }).finally(()=>{if(flights.get(id)?.promise===flight)flights.delete(id);});flights.set(id,{promise:flight,recovering});
  }
  return waitToken(flight,options.signal);
}
function waitToken(flight:Promise<any>,signal?:AbortSignal):Promise<any>{
  if(!signal)return flight;
  if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});flight.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();});
}
export async function initializeRemoteAuth(){mkdirSync(ownerHome(),{recursive:true,mode:0o700});if(process.env.CODEX_HOME)mkdirSync(process.env.CODEX_HOME,{recursive:true,mode:0o700});await refreshRemoteSnapshot(true);}
