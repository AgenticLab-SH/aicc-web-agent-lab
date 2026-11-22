import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveRuntimeLayout,insideDirectory} from '../../../src/runtime-layout.mjs';
import {runHidden,collectTrayStatus} from './tray-status.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
async function syncLocalMetadata(use=false){
  const stateRoot=resolveRuntimeLayout().root;
  const current=path.join(stateRoot,'runtime','ocx-local','current.json');
  if(!fs.existsSync(current))return null;
  try{
    const owner=JSON.parse(fs.readFileSync(current,'utf8'));
    if(owner.requestExecution!=='windows-local'||owner.credentialWriter!=='a1'||!insideDirectory(path.join(stateRoot,'runtime','ocx-local'),owner.opencodexHome))return false;
    const file=path.join(owner.opencodexHome,'admin-api-token');
    if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())return false;
    const token=fs.readFileSync(file,'utf8').trim();
    const response=await fetch('http://127.0.0.1:10100/api/aicc-local/sync',{method:'POST',headers:{Authorization:'Bearer '+token,...(use?{'x-aicc-local-use':'1'}:{})},signal:AbortSignal.timeout(50000)});
    if(!response.ok)return false;
    const result=await response.json();
    return result.ok===true&&result.requestExecution==='windows-local'&&result.credentialWriter==='a1';
  }catch{return false;}
}
export async function applyTrayRequest(file){
  const requests=path.join(resolveRuntimeLayout().root,'status-tray','requests');
  file=path.resolve(file);
  if(!insideDirectory(requests,file)||path.dirname(file)!==requests||fs.lstatSync(file).isSymbolicLink()||fs.lstatSync(requests).isSymbolicLink()||!fs.lstatSync(file).isFile()||fs.statSync(file).size>8192)throw Error('Invalid tray request');
  const resultFile=file+'.result.json';if(fs.existsSync(resultFile))throw Error('Request already dispatched; read its result instead of retrying');
  const request=JSON.parse(fs.readFileSync(file,'utf8'));
  if(request.action==='reconcile'){
    const metadataPending=[];
    for(const name of fs.readdirSync(requests).filter(n=>n.endsWith('.result.json'))){
      const receipt=path.join(requests,name);
      if(fs.lstatSync(receipt).isSymbolicLink())throw Error('Linked receipt refused');
      const previous=JSON.parse(fs.readFileSync(receipt,'utf8'));
      if(!['DISPATCHING','UNCERTAIN'].includes(previous.terminal)){
        if(['PASS','RECONCILED'].includes(previous.terminal)&&previous.localMetadataSynced===false)metadataPending.push({receipt,previous});
        continue;
      }
      if(previous.action==='quota-protection'){
        const original=JSON.parse(fs.readFileSync(receipt.slice(0,-'.result.json'.length),'utf8'));
        if(!/^[a-f0-9]{32}$/.test(previous.requestId??'')||!/^[A-Za-z0-9._-]{1,64}$/.test(original.selector??'')||!/^[a-f0-9]{64}$/.test(original.identityHash??'')||typeof original.enabled!=='boolean')throw Error('Exact local policy reconciliation required');
        const checked=await runHidden('pwsh.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'tools/platform/windows/Invoke-AiccAccountQuotaPolicy.ps1'),'-Selector',original.selector,'-ExpectedIdentity',original.identityHash,'-Enabled',String(original.enabled),'-PreviewToken',previous.requestId,'-ReadOnly'],30000,false);
        if(checked?.terminal!=='RECONCILED')return {terminal:'UNCERTAIN',reason:'local_account_quota_policy_readback_unconfirmed',mutationDispatched:true};
        fs.writeFileSync(receipt,JSON.stringify({...previous,...checked})+'\n',{mode:0o600});
        continue;
      }
      if(!/^[a-f0-9]{32}$/.test(previous.requestId??''))return {terminal:'UNCERTAIN',reason:'original_request_token_missing',mutationDispatched:true};
      const observed=await runHidden('pwsh.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'tools/platform/opencodex/Invoke-AiccOcxHubAccounts.ps1'),'-Action','reconcile','-PreviewToken',previous.requestId],90000,false);
      if(observed?.terminal!=='PASS')return {terminal:'UNCERTAIN',reason:observed?.reason??'readonly_reconciliation_unconfirmed',mutationDispatched:true,state:await collectTrayStatus()};
      const confirmed={...previous,terminal:'RECONCILED',reconciliation:observed,localMetadataSynced:false};
      fs.writeFileSync(receipt,JSON.stringify(confirmed)+'\n',{mode:0o600});
      metadataPending.push({receipt,previous:confirmed});
    }
    let localMetadataSynced;
    if(metadataPending.length){
      // This retries only the local metadata mirror, never an A1 account mutation.
      localMetadataSynced=await syncLocalMetadata(metadataPending.some(item=>item.previous.action==='use'));
      if(localMetadataSynced!==false)for(const {receipt,previous} of metadataPending){
        fs.writeFileSync(receipt,JSON.stringify({...previous,localMetadataSynced:localMetadataSynced===true})+'\n',{mode:0o600});
      }
    }
    return {terminal:'PASS',reconciliation:true,mutationDispatched:false,localMetadataSynced,state:await collectTrayStatus()};
  }
  for(const name of fs.readdirSync(requests).filter(n=>n.endsWith('.result.json'))){
    const outcome=JSON.parse(fs.readFileSync(path.join(requests,name),'utf8'));
    if(['DISPATCHING','UNCERTAIN'].includes(outcome.terminal))return {terminal:'UNCERTAIN',reason:'previous_mutation_requires_readonly_reconciliation',mutationDispatched:true};
  }
  if(request.action==='quota-protection'){
    if(!/^[A-Za-z0-9._-]{1,64}$/.test(request.selector??'')||!/^[a-f0-9]{64}$/.test(request.identityHash??'')||typeof request.enabled!=='boolean')throw Error('Exact account quota policy required');
    const args=['-NoProfile','-NonInteractive','-File',path.join(root,'tools/platform/windows/Invoke-AiccAccountQuotaPolicy.ps1'),'-Selector',request.selector,'-ExpectedIdentity',request.identityHash,'-Enabled',String(request.enabled)];
    const preview=await runHidden('pwsh.exe',args,30000,false);
    if(preview?.terminal!=='DRY_RUN'||!/^[a-f0-9]{32}$/.test(preview.previewToken??''))return {terminal:'HOLD',reason:'account_quota_preview_unconfirmed',mutationDispatched:false};
    fs.writeFileSync(resultFile,JSON.stringify({terminal:'DISPATCHING',action:request.action,requestId:preview.previewToken})+'\n',{flag:'wx',mode:0o600});
    const committed=await runHidden('pwsh.exe',[...args,'-Commit','-PreviewToken',preview.previewToken],30000,false);
    const outcome={...(committed?.terminal==='PASS'?committed:{terminal:'UNCERTAIN',action:request.action,reason:'account_quota_readback_required',mutationDispatched:true}),requestId:preview.previewToken};
    fs.writeFileSync(resultFile,JSON.stringify(outcome)+'\n',{mode:0o600});
    return {...outcome,state:await collectTrayStatus()};
  }
  if(!['pause','resume','priority','use','unpin','reset','policy','order'].includes(request.action))throw Error('Unknown account action');
  const args=['-NoProfile','-NonInteractive','-File',path.join(root,'tools/platform/opencodex/Invoke-AiccOcxHubAccounts.ps1'),'-Action',request.action];
  if(!['policy','order'].includes(request.action)){
    if(!/^[A-Za-z0-9._-]{1,64}$/.test(request.selector??'')||!/^([a-f0-9]{64})$/.test(request.identityHash??''))throw Error('Exact account identity required');
    args.push('-Selector',request.selector,'-ExpectedIdentity',request.identityHash);
  }
  if(request.action==='priority'){
    if(!Number.isInteger(request.priority)||request.priority<-100||request.priority>100)throw Error('Invalid priority');
    args.push('-Priority',String(request.priority));
  }
  if(request.action==='order'){
    const rows=request.order;
    if(!Array.isArray(rows)||rows.length<1||rows.length>16)throw Error('Invalid account order');
    const selectors=new Set(),identities=new Set();
    const normalized=rows.map((row,index)=>{
      if(!row||!/^[A-Za-z0-9._-]{1,64}$/.test(row.selector??'')||row.selector==='main'||!/^[a-f0-9]{64}$/.test(row.identityHash??'')||selectors.has(row.selector)||identities.has(row.identityHash))throw Error('Exact ordered identities required');
      selectors.add(row.selector);identities.add(row.identityHash);
      return {selector:row.selector,identityHash:row.identityHash,priority:rows.length-index};
    });
    args.push('-OrderBase64',Buffer.from(JSON.stringify(normalized),'utf8').toString('base64'));
  }
  if(request.action==='policy'){
    for(const key of ['shortThreshold','longThreshold'])if(!Number.isInteger(request[key])||request[key]<1||request[key]>100)throw Error('Invalid threshold');
    for(const key of ['shortAction','longAction'])if(!['switch','stop'].includes(request[key]))throw Error('Invalid action');
    args.push('-ShortThreshold',String(request.shortThreshold),'-LongThreshold',String(request.longThreshold),'-ShortAction',request.shortAction,'-LongAction',request.longAction);
  }
  // G1-25: per-step elapsed milliseconds go into the durable receipt to locate slow steps.
  const timings={};const started=Date.now();
  const preview=await runHidden('pwsh.exe',args,90000,false);
  timings.previewMs=Date.now()-started;
  if(preview?.terminal!=='DRY_RUN'||!/^[a-f0-9]{32}$/.test(preview.previewToken??''))return {terminal:'HOLD',reason:preview?.failureCode??'preview_unconfirmed',mutationDispatched:false,timings};
  // Durable dispatch fence: retrying a consumed request cannot execute another PUT.
  fs.writeFileSync(resultFile,JSON.stringify({terminal:'DISPATCHING',action:request.action,requestId:preview.previewToken,timings})+'\n',{flag:'wx',mode:0o600});
  const commitStarted=Date.now();
  const result=await runHidden('pwsh.exe',[...args,'-Commit','-PreviewToken',preview.previewToken],90000,false);
  timings.commitMs=Date.now()-commitStarted;
  const outcome=result?.terminal==='PASS'?{...result,action:request.action,requestId:preview.previewToken}
    :{terminal:'UNCERTAIN',action:request.action,reason:result?.failureCode??'commit_unconfirmed_do_not_retry',mutationDispatched:true,requestId:preview.previewToken};
  outcome.timings=timings;
  if(outcome.terminal==='PASS'&&fs.existsSync(path.join(resolveRuntimeLayout().root,'runtime','ocx-local','current.json')))outcome.localMetadataSynced=false;
  fs.writeFileSync(resultFile,JSON.stringify(outcome)+'\n',{mode:0o600});
  if(outcome.terminal==='PASS'){
    // Reconcile only metadata after the one confirmed owner transaction.
    const syncStarted=Date.now();
    const synced=await syncLocalMetadata(request.action==='use');
    timings.syncMs=Date.now()-syncStarted;
    if(synced!==null)outcome.localMetadataSynced=synced;
    // Persist the local sync result too; an A1 commit is not local application.
    fs.writeFileSync(resultFile,JSON.stringify(outcome)+'\n',{mode:0o600});
  }
  const lastReceipt=JSON.stringify(outcome)+'\n';
  // Refresh observations after one mutation, never repeat the mutation itself.
  const statusStarted=Date.now();
  const state=await collectTrayStatus();
  timings.statusMs=Date.now()-statusStarted;timings.totalMs=Date.now()-started;
  // Record the final step timings only if no reconciliation rewrote the receipt meanwhile.
  try{if(fs.readFileSync(resultFile,'utf8')===lastReceipt)fs.writeFileSync(resultFile,JSON.stringify(outcome)+'\n',{mode:0o600});}catch{}
  return {...outcome,state};
}
// S-TRAY: a failure after the durable receipt (e.g. the status re-read) must not report a
// committed change as "not executed". A PASS/RECONCILED receipt is the result.
export function failureOutcome(requestFile){
  let receipt=null;
  try{const file=path.resolve(requestFile)+'.result.json';if(fs.existsSync(file))receipt=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch{return {terminal:'UNCERTAIN',reason:'mutation_result_requires_readonly_reconciliation',mutationDispatched:true};}
  if(receipt&&['PASS','RECONCILED'].includes(receipt.terminal))return {...receipt,mutationDispatched:true,stateUnavailable:true};
  const pending=!!receipt&&['DISPATCHING','UNCERTAIN'].includes(receipt.terminal);
  return {terminal:pending?'UNCERTAIN':'HOLD',reason:pending?'mutation_result_requires_readonly_reconciliation':'tray_request_refused',mutationDispatched:pending};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length!==3)throw Error('Exact request file required');console.log(JSON.stringify(await applyTrayRequest(process.argv[2])));}
  catch{
    const outcome=process.argv.length===3?failureOutcome(process.argv[2]):{terminal:'HOLD',reason:'tray_request_refused',mutationDispatched:false};
    console.log(JSON.stringify(outcome));if(outcome.terminal!=='PASS'&&outcome.terminal!=='RECONCILED')process.exitCode=1;
  }
}
