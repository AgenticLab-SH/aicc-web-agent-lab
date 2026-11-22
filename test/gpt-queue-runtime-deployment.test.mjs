import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {hostToolHash} from '../components/host-control/prepare-update.mjs';

const helper=path.resolve('tools/platform/workspace-mcp/GptQueueRuntimeDeployment.ps1');
const updater=fs.readFileSync('tools/platform/workspace-mcp/Update-AiccWebManagementRuntime.ps1','utf8');
const helpers=updater.slice(updater.indexOf('function Regular('),updater.indexOf('$OperationDirectory=[IO.Path]::GetFullPath'));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const json=v=>JSON.stringify(v,null,2);
test('queue deployment pins the actual MCP contract using the gateway canonical hash',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'queue-actual-hash-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const config=path.join(root,'config.json');
  fs.writeFileSync(config,json({surfaceProfile:'business-full',workspaces:[],permissions:{commands:false},gptQueue:{enabled:true}}));
  const scripts=['Prepare-AiccGptQueueDeployment.ps1','GptQueueRuntimeDeployment.ps1'].map(name=>{
    const body=fs.readFileSync(path.join('tools/platform/workspace-mcp',name),'utf8');
    return body.match(/\$contractScript=@'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
  });
  assert.ok(scripts[0]);assert.equal(scripts[0],scripts[1]);
  const result=spawnSync(process.execPath,['--input-type=module','-e',scripts[0],process.cwd(),config],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const contract=JSON.parse(result.stdout);
  assert.equal(contract.hash,hostToolHash(contract.tools));
  assert.equal(contract.tools.filter(t=>t.name.startsWith('aicc_gpt_queue_')).length,5);
  assert.equal(contract.toolCalls,0);assert.equal(contract.leasesOpened,0);
  const changed=structuredClone(contract.tools);changed[0].description+=' changed';
  assert.notEqual(contract.hash,hostToolHash(changed));
});
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'queue-deployment-contract-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const put=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof v==='string'?v:json(v));return p;};
  const baseline=path.join(root,'baseline'),backend=path.join(root,'candidate'),oldGateway=path.join(root,'old-gateway'),gateway=path.join(root,'gateway');
  fs.mkdirSync(baseline);fs.mkdirSync(backend);
  const configFile=path.join(root,'config.json'),manager=put(path.join(root,'manager.json'),{});
  const before={surfaceProfile:'business-full',permissions:{commands:false,network:false},workspaces:[{alias:'fixture-project',root:baseline}],webManagement:{bindingFile:manager,bindingSha256:hash(manager)}};
  put(configFile,before);put(path.join(root,'workspace-config.before.json'),before);
  const native=put(path.join(root,'native.exe'),'SYNTHETIC-NATIVE-NOT-EXECUTED');
  const cfg=put(path.join(root,'native-config.json'),{}),manifest=put(path.join(root,'native-manifest.json'),{});
  const proof=put(path.join(root,'proof.json'),{});
  const binding={schemaVersion:1,kind:'aicc-gpt-queue-owner-binding',workspaceAlias:'fixture-project',workspaceRoot:baseline,
    originalRequestSha256:'a'.repeat(64),ownerIdentityHash:'b'.repeat(64),nativeExecutable:native,nativeExecutableSha256:hash(native),
    nativeConfig:cfg,nativeConfigSha256:hash(cfg),nativeManifest:manifest,nativeManifestSha256:hash(manifest),
    bindingId:'fixture-binding',ownerId:'fixture-owner',
    targets:['9222','9223'].map((slot,i)=>{
      const target={slot,targetId:(i?'B':'A').repeat(32),targetNonce:(i?'c':'d').repeat(64),
        conversationId:'fixture-conversation-'+slot,originalLeaseSha256:'e'.repeat(64),accountAlias:'fixture-account',
        accountIdentityHash:'f'.repeat(64),workspaceIdentityHash:'1'.repeat(64)};
      const file=put(path.join(root,'proof-'+slot+'.json'),{...target,kind:'aicc-queue-exact-target-proof',
        state:'OWNED_ACTIVE',bindingId:'fixture-binding',ownerId:'fixture-owner',originalRequestSha256:'a'.repeat(64),
        ownerIdentityHash:'b'.repeat(64),observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+120000).toISOString()});
      return {...target,proofFile:file,proofSha256:hash(file)};
    })};
  const bindingFile=put(path.join(root,'binding.json'),binding);
  const after={...structuredClone(before),gptQueue:{enabled:true,bindingFile,bindingSha256:hash(bindingFile)}};
  const configDesiredFile=put(path.join(root,'desired.json'),after);
  const prepared=put(path.join(root,'prepared.json'),{kind:'aicc-gpt-queue-owner-prepared',bindingSha256:hash(bindingFile),originalRequestSha256:binding.originalRequestSha256,ownerIdentityHash:binding.ownerIdentityHash,inspectedTargets:2,originalRequestDispatched:false});
  const entry=put(path.join(baseline,'server.mjs'),'old'),candidateEntry=put(path.join(backend,'server.mjs'),'candidate');
  const queue=put(path.join(backend,'components/workspace-mcp/gpt-queue-provider.mjs'),'queue');
  const contract={hash:'c'.repeat(64),tools:[{name:'original_tool'},{name:'aicc_gpt_queue_get'}]};
  const original={hostControl:'task-owned-v1',providers:[{id:'workspace',entrypoint:entry,args:[entry],files:[{path:entry,sha256:hash(entry)},{path:configFile,sha256:hash(configFile)}]},
    {id:'native',entrypoint:native,files:[{path:native,sha256:hash(native)}]},{id:'host',files:[]}]};
  put(path.join(oldGateway,'config.json'),original);put(path.join(oldGateway,'gateway.cjs'),'unchanged gateway');
  const oldManifest={files:{'config.json':hash(path.join(oldGateway,'config.json')),'gateway.cjs':hash(path.join(oldGateway,'gateway.cjs'))},releaseHash:hash(path.join(oldGateway,'config.json'))};
  put(path.join(oldGateway,'manifest.json'),oldManifest);
  const next=structuredClone(original),w=next.providers[0];w.entrypoint=candidateEntry;w.args=[candidateEntry];w.files=[{path:candidateEntry,sha256:hash(candidateEntry)},{path:configFile,sha256:hash(configDesiredFile)},{path:queue,sha256:hash(queue)}];w.toolHash=contract.hash;w.toolNames=contract.tools.map(x=>x.name);
  put(path.join(gateway,'config.json'),next);put(path.join(gateway,'gateway.cjs'),'unchanged gateway');
  const nextManifest=structuredClone(oldManifest);nextManifest.files['config.json']=hash(path.join(gateway,'config.json'));nextManifest.releaseHash=nextManifest.files['config.json'];put(path.join(gateway,'manifest.json'),nextManifest);
  const profileFile=put(path.join(root,'profile.yaml'),`entry: ${oldGateway}\nconfig: ${oldGateway}\n`);
  const profileDesiredFile=put(path.join(root,'profile.desired.yaml'),`entry: ${gateway}\nconfig: ${gateway}\n`);
  const registryFile=put(path.join(root,'registry.json'),{components:{workspace:{releaseRoot:baseline,runtime:'Invoke-QueueFixtureRuntime'},'unified-mcp':{releaseRoot:oldGateway}}});
  const inventory=put(path.join(root,'inventory.before.json'),[]);
  const stage=put(path.join(root,'stage.json'),{owner:'fixture-owner',baseline,backend,inventoryBeforeSha256:hash(inventory)});
  const verifier=put(path.join(root,'verifier.mjs'),'SYNTHETIC-NOT-EXECUTED');
  const verified={ok:true,closureVerified:true,manifestsPreserved:true,receiptSha256:hash(stage),toolCalls:0,leasesOpened:0};
  const candidate={kind:'workspace-gpt-queue-update',baseline,backend,oldGateway,gateway,bindingFile:manager,bindingSHA256:hash(manager),queueStageFile:stage,queueStageSHA256:hash(stage),queueVerifierFile:verifier,queueVerifierSHA256:hash(verifier),queueOwnerPreparedFile:prepared,queueOwnerPreparedSHA256:hash(prepared),configDesiredFile,configDesiredSHA256:hash(configDesiredFile),toolHash:contract.hash,oldGatewayConfigSHA256:hash(path.join(oldGateway,'config.json')),oldGatewayManifestSHA256:hash(path.join(oldGateway,'manifest.json')),gatewayConfigSHA256:hash(path.join(gateway,'config.json')),profileDesiredFile,gptQueueRecovery:{registrySHA256:hash(registryFile),inventoryBeforeFile:inventory,inventoryBeforeSHA256:hash(inventory)}};
  const candidateFile=put(path.join(root,'candidate.json'),candidate);
  const fake=put(path.join(root,'fake.json'),{contract,verified,manifest});
  const harness=put(path.join(root,'verify.ps1'),`param($CandidateReceipt,$configFile,$profileFile,$registryFile,$FakeFile,$Helper)\n$ErrorActionPreference='Stop'\n${helpers}\n. $Helper\n$fixture=Read $FakeFile\n$script:inventoryChecked=$false\nfunction Get-ItemProperty {param($LiteralPath) @{ '(default)'=$fixture.manifest }}\nfunction Invoke-QueueFixtureRuntime { if($args[0] -eq '--input-type=module'){if($args[2] -match 'verifyGptQueueOwnerConfig'){if(-not $script:inventoryChecked){throw 'issuer consumed before full inventory'};$fixture.current|ConvertTo-Json -Depth 10}else{$fixture.contract|ConvertTo-Json -Depth 10}}else{$script:inventoryChecked=$true;$fixture.verified|ConvertTo-Json -Depth 10};$global:LASTEXITCODE=0 }\n$env:CODEX_THREAD_ID='fixture-owner'\n$c=Read $CandidateReceipt;$before=Read $configFile;$after=Read $c.configDesiredFile\nAssert-GptQueueRuntimeCandidate $c $before $after\n`);
  const refresh=()=>put(candidateFile,candidate);
  const run=()=>spawnSync('pwsh',['-NoProfile','-File',harness,candidateFile,configFile,profileFile,registryFile,fake,helper],{encoding:'utf8',windowsHide:true});
  return {root,put,before,after,candidate,configFile,configDesiredFile,bindingFile,prepared,stage,registryFile,next,gateway,refresh,run,fake};
}
test('queue deployment preserves exact owner config and host/native graph; rejects repinned unrelated changes',{skip:process.platform!=='win32'},t=>{
  const f=fixture(t);let r=f.run();assert.equal(r.status,0,r.stderr||r.stdout);
  f.after.permissions.network=true;f.put(f.configDesiredFile,f.after);f.candidate.configDesiredSHA256=hash(f.configDesiredFile);f.refresh();
  r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/unrelated owner configuration/);
});

test('queue deployment consumes exact fresh original issuer after inventory while preserving expired historical bytes',{skip:process.platform!=='win32'},t=>{
  for(const mutation of ['valid','owner','expired','unknown']){
    const f=fixture(t),binding=JSON.parse(fs.readFileSync(f.bindingFile));
    binding.currentIssuer={kind:'registered-cdp-current-issuer/v1'};
    for(const target of binding.targets){const p=JSON.parse(fs.readFileSync(target.proofFile));
      p.observedAt=new Date(Date.now()-600000).toISOString();p.expiresAt=new Date(Date.now()-480000).toISOString();
      f.put(target.proofFile,p);target.proofSha256=hash(target.proofFile);}
    f.put(f.bindingFile,binding);f.after.gptQueue.bindingSha256=hash(f.bindingFile);
    f.put(f.configDesiredFile,f.after);f.candidate.configDesiredSHA256=hash(f.configDesiredFile);
    const prepared=JSON.parse(fs.readFileSync(f.prepared));prepared.bindingSha256=hash(f.bindingFile);
    f.put(f.prepared,prepared);f.candidate.queueOwnerPreparedSHA256=hash(f.prepared);
    const graph=f.next;graph.providers[0].files.find(p=>p.path===f.configFile).sha256=f.candidate.configDesiredSHA256;
    f.put(path.join(f.gateway,'config.json'),graph);f.candidate.gatewayConfigSHA256=hash(path.join(f.gateway,'config.json'));
    const manifest=JSON.parse(fs.readFileSync(path.join(f.gateway,'manifest.json')));
    manifest.files['config.json']=f.candidate.gatewayConfigSHA256;manifest.releaseHash=f.candidate.gatewayConfigSHA256;
    f.put(path.join(f.gateway,'manifest.json'),manifest);f.refresh();
    const data=JSON.parse(fs.readFileSync(f.fake));
    data.current={ok:true,status:'CURRENT_ORIGINAL_ISSUER_VERIFIED_READ_ONLY',
      originalRequestSha256:binding.originalRequestSha256,ownerIdentityHash:binding.ownerIdentityHash,
      definitionSha256:binding.definitionSha256,targetCount:2,filesWritten:0,executionAuthorized:false,dispatched:false,
      observations:['9222','9223'].map(slot=>({slot,observedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()}))};
    if(mutation==='owner')data.current.ownerIdentityHash='foreign';
    if(mutation==='expired')data.current.observations[0].expiresAt=new Date(Date.now()-500).toISOString();
    if(mutation==='unknown')data.current={ok:false};
    f.put(f.fake,data);const before=hash(f.configFile),original=hash(f.bindingFile),r=f.run();
    if(mutation==='valid')assert.equal(r.status,0,r.stderr||r.stdout);
    else{assert.notEqual(r.status,0,mutation);assert.match(r.stderr,/Current original queue|QUEUE_CURRENT_ISSUER_INSPECT_UNPROVEN/);}
    assert.equal(hash(f.configFile),before);assert.equal(hash(f.bindingFile),original);
  }
});
test('queue deployment refuses another workspace, changed native pin and wrong owner before cutover',{skip:process.platform!=='win32'},t=>{
  for(const mutation of ['workspace','native','owner','graph']){
    const f=fixture(t);
    if(mutation==='workspace'){f.after.workspaces=[];f.put(f.configFile,f.after);f.put(path.join(f.root,'workspace-config.before.json'),f.after);}
    if(mutation==='native')f.put(path.join(f.root,'native.exe'),'changed');
    if(mutation==='owner'){const s=JSON.parse(fs.readFileSync(f.stage));s.owner='other';f.put(f.stage,s);f.candidate.queueStageSHA256=hash(f.stage);f.refresh();}
    if(mutation==='graph'){f.next.providers[1].id='other';f.put(path.join(f.gateway,'config.json'),f.next);f.candidate.gatewayConfigSHA256=hash(path.join(f.gateway,'config.json'));f.refresh();}
    const r=f.run();assert.notEqual(r.status,0,mutation);assert.match(r.stderr,/workspace|binding|native queue pins|reviewed queue stage|exact Workspace/);
  }
});

test('queue deployment refuses expired, future, oversized lifetime and substituted owner proof despite valid hashes',{skip:process.platform!=='win32'},t=>{
  for(const mutation of ['expired','future','long-lifetime','owner','target']){
    const f=fixture(t),binding=JSON.parse(fs.readFileSync(f.bindingFile));
    const target=binding.targets[0],proof=JSON.parse(fs.readFileSync(target.proofFile));
    if(mutation==='expired'){proof.observedAt=new Date(Date.now()-240000).toISOString();proof.expiresAt=new Date(Date.now()-120000).toISOString();}
    if(mutation==='future')proof.observedAt=new Date(Date.now()+60000).toISOString();
    if(mutation==='long-lifetime')proof.expiresAt=new Date(Date.now()+3600000).toISOString();
    if(mutation==='owner')proof.ownerId='foreign-owner';
    if(mutation==='target')proof.targetId='C'.repeat(32);
    f.put(target.proofFile,proof);target.proofSha256=hash(target.proofFile);f.put(f.bindingFile,binding);
    f.after.gptQueue.bindingSha256=hash(f.bindingFile);f.put(f.configDesiredFile,f.after);
    const prepared=JSON.parse(fs.readFileSync(f.prepared));prepared.bindingSha256=hash(f.bindingFile);f.put(f.prepared,prepared);
    f.candidate.queueOwnerPreparedSHA256=hash(f.prepared);f.candidate.configDesiredSHA256=hash(f.configDesiredFile);f.refresh();
    const before=hash(f.configFile),r=f.run();assert.notEqual(r.status,0,mutation);
    assert.match(r.stderr,/Fresh queue owner proof|Original queue proof owner|Original queue target proof/);
    assert.equal(hash(f.configFile),before);
  }
});
test('replacement native only reads upgraded capability, previous terminal run and new absence',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'queue-replacement-native-read-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const nativeScript=fs.readFileSync(helper,'utf8').match(/\$nativeReadScript=@'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
  assert.ok(nativeScript);
  const provider=path.join(root,'components/workspace-mcp/gpt-queue-provider.mjs');
  fs.mkdirSync(path.dirname(provider),{recursive:true});
  fs.writeFileSync(path.join(root,'package.json'),json({type:'module'}));
  fs.writeFileSync(provider,[
    "import fs from 'node:fs';",
    "export async function nativeGptQueueExchange(_binding,body){",
    "const state=JSON.parse(fs.readFileSync(process.env.QUEUE_TEST_NATIVE_JSON,'utf8'));",
    "if(body.type==='orchestration_capabilities')return {ok:true,payload:state.capability};",
    "if(body.type!=='orchestration_get')throw Error('UNAUTHORIZED_NATIVE_MUTATION');",
    "state.types.push(body.type);",
    "return body.runId===state.oldId?{ok:true,payload:{revision:5,run:state.oldRun}}:",
    "state.newGet;",
    "}"
  ].join('\n'));
  const roles=['9222','9223'].map((slot,i)=>({roleId:'role-'+slot,slot,targetNonce:(i?'b':'a').repeat(64),
    conversationId:'conversation-'+slot}));
  const old={bindingId:'original-binding-01',operationId:'previous-op-0001',
    originalRequestSha256:'a'.repeat(64),ownerIdentityHash:'b'.repeat(64),
    definitionSha256:'c'.repeat(64),targets:roles};
  const next={...old,bindingId:'replacement-binding-01',operationId:'next-op-0001',
    originalRequestSha256:'d'.repeat(64),nativeExecutable:path.join(root,'native.exe')};
  const oldFile=path.join(root,'old.json'),newFile=path.join(root,'next.json');
  fs.writeFileSync(oldFile,json(old));fs.writeFileSync(newFile,json(next));
  const id=b=>'gptq_'+createHash('sha256').update(b.bindingId+'\0'+b.ownerIdentityHash).digest('hex').slice(0,24)+'_'+b.operationId;
  const stateFile=path.join(root,'native.json');
  const run={id:id(old),registrationOnly:true,status:'cancelled',
    ownerBinding:{originalRequestSha256:old.originalRequestSha256,
      ownerIdentityHash:old.ownerIdentityHash,definitionSha256:old.definitionSha256},
    roles:roles.map(r=>({id:r.roleId,slot:r.slot,targetNonce:r.targetNonce,
      conversationId:r.conversationId,status:'cancelled',dispatchCount:0,submissionUncertain:false}))};
  const base={oldId:id(old),oldRun:run,newGet:{ok:false,error:'WEBGPT_ORCHESTRATION_RUN_NOT_FOUND'},
    capability:{pausedRegistration:true,revisionFencedCancel:true,ownerBoundActivation:true},types:[]};
  const execute=(change={})=>{
    fs.writeFileSync(stateFile,json({...structuredClone(base),...change}));
    return spawnSync(process.execPath,['--input-type=module','-e',nativeScript,root,oldFile,newFile],{
      env:{...process.env,QUEUE_TEST_NATIVE_JSON:stateFile},encoding:'utf8',windowsHide:true});
  };
  let result=execute();assert.equal(result.status,0,result.stderr);
  const good=JSON.parse(result.stdout);
  assert.equal(good.status,'PREVIOUS_TERMINAL_NEW_ABSENT');
  assert.equal(good.previousStatus,'cancelled');assert.equal(good.readOnly,true);
  assert.equal(good.nextRegistered,false);
  for(const mutation of [
    {oldRun:{...run,status:'active'}},
    {oldRun:{...run,roles:run.roles.map((r,i)=>({...r,submissionUncertain:i===0}))}},
    {oldRun:{...run,roles:run.roles.map((r,i)=>({...r,errorCode:i===0?'DISPATCH_OUTCOME_UNKNOWN':null}))}},
    {oldRun:{...run,roles:run.roles.map((r,i)=>({...r,dispatchCount:i===0?1:0}))}},
    {oldRun:{...run,ownerBinding:{...run.ownerBinding,definitionSha256:'f'.repeat(64)}}},
    {capability:{...base.capability,ownerBoundActivation:false}},
    {newGet:{ok:true,payload:{revision:1,run:{id:id(next)}}}},
    {newGet:{ok:false,error:'WEBGPT_ORCHESTRATION_UNKNOWN'}}
  ]){result=execute(mutation);assert.notEqual(result.status,0,JSON.stringify(mutation));}
  const completed={...run,status:'completed',
    roles:run.roles.map(r=>({...r,status:'completed',dispatchCount:1,
      userMessageId:'saved-user',assistantMessageId:'saved-assistant'}))};
  result=execute({oldRun:completed});assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).previousStatus,'completed');
});
function replacementFixture(t){
  const f=fixture(t),put=f.put,root=f.root;
  const old=JSON.parse(fs.readFileSync(f.bindingFile,'utf8'));
  old.operationId='previous-operation-0001';old.definitionSha256='2'.repeat(64);old.baseDirectory=root;
  put(old.nativeConfig,{baseDirectory:root});
  put(old.nativeManifest,{name:'com.agenticfabworks.webgpt_queue',type:'stdio',
    path:old.nativeExecutable,allowed_origins:['chrome-extension://'+'a'.repeat(32)+'/']});
  old.nativeConfigSha256=hash(old.nativeConfig);
  old.nativeManifestSha256=hash(old.nativeManifest);
  const priorFile=put(path.join(root,'previous-binding.json'),old);
  const priorReceipt=put(path.join(root,'previous-prepared.json'),{
    kind:'aicc-gpt-queue-owner-prepared',bindingSha256:hash(priorFile),
    originalRequestSha256:old.originalRequestSha256,ownerIdentityHash:old.ownerIdentityHash});
  const next=structuredClone(old);next.bindingId='next-binding-fixture';
  next.operationId='next-operation-0001';next.originalRequestSha256='7'.repeat(64);
  next.currentIssuer={kind:'registered-cdp-current-issuer/v1'};
  for(let i=0;i<next.targets.length;i++){
    const target=next.targets[i],previous=JSON.parse(fs.readFileSync(target.proofFile,'utf8'));
    const fresh={...previous,bindingId:next.bindingId,originalRequestSha256:next.originalRequestSha256};
    target.proofFile=put(path.join(root,'new-proof-'+i+'.json'),fresh);
    target.proofSha256=hash(target.proofFile);
  }
  put(f.bindingFile,next);
  const before=structuredClone(f.before);
  before.gptQueue={enabled:true,bindingFile:priorFile,bindingSha256:hash(priorFile)};
  put(f.configFile,before);put(path.join(root,'workspace-config.before.json'),before);
  const after=structuredClone(before);
  after.gptQueue={enabled:true,bindingFile:f.bindingFile,bindingSha256:hash(f.bindingFile)};
  put(f.configDesiredFile,after);
  put(f.prepared,{kind:'aicc-gpt-queue-owner-prepared',bindingSha256:hash(f.bindingFile),
    originalRequestSha256:next.originalRequestSha256,ownerIdentityHash:next.ownerIdentityHash,
    inspectedTargets:2,originalRequestDispatched:false});
  const toolNames=['aicc_workspace_list','aicc_gpt_queue_register','aicc_gpt_queue_activate',
    'aicc_gpt_queue_list','aicc_gpt_queue_get','aicc_gpt_queue_cancel'];
  const graphFile=path.join(root,'old-gateway','config.json');
  const graph=JSON.parse(fs.readFileSync(graphFile,'utf8'));
  const w=graph.providers.find(p=>p.id==='workspace');
  w.files.find(p=>p.path===f.configFile).sha256=hash(f.configFile);
  w.toolHash='3'.repeat(64);w.toolNames=toolNames;
  put(graphFile,graph);
  const oldManifestFile=path.join(root,'old-gateway','manifest.json');
  const oldManifest=JSON.parse(fs.readFileSync(oldManifestFile,'utf8'));
  oldManifest.files['config.json']=hash(graphFile);
  oldManifest.releaseHash=hash(graphFile);
  put(oldManifestFile,oldManifest);
  const desiredGraph=structuredClone(graph);
  desiredGraph.providers.find(p=>p.id==='workspace').files
    .find(p=>p.path===f.configFile).sha256=hash(f.configDesiredFile);
  put(path.join(f.gateway,'config.json'),desiredGraph);
  const desiredManifest=structuredClone(oldManifest);
  desiredManifest.files['config.json']=hash(path.join(f.gateway,'config.json'));
  desiredManifest.releaseHash=desiredManifest.files['config.json'];
  put(path.join(f.gateway,'manifest.json'),desiredManifest);
  const backendRoot=path.join(root,'baseline');
  const release=put(path.join(backendRoot,'.aicc-release.json'),{fileCount:0});
  const drive=put(path.join(backendRoot,'workspace-drive-manifest.json'),{files:{}});
  function inventory(dir=backendRoot){
    const rows=[];
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const p=path.join(dir,entry.name);
      if(entry.isDirectory())rows.push(...inventory(p));
      else rows.push({path:path.relative(backendRoot,p).replaceAll(path.sep,'/'),
        sha256:hash(p),size:fs.statSync(p).size});
    }
    return rows;
  }
  const inventoryFile=put(path.join(root,'inventory.before.json'),inventory());
  const nativeReceipt=put(path.join(root,'native-install-receipt.json'),{
    status:'INSTALLED',ownerBoundActivation:true});
  const nativeEvidenceFile=put(path.join(root,'native-upgrade-evidence.json'),{
    kind:'aicc-gpt-queue-native-upgrade-readback/v1',status:'INSTALLED_VERIFIED',
    ownerBoundActivation:true,previousBindingSha256:hash(priorFile),
    installedExecutableSha256:hash(next.nativeExecutable),
    installedConfigSha256:hash(next.nativeConfig),
    installedManifestSha256:hash(next.nativeManifest),
    registeredManifest:next.nativeManifest,installReceiptFile:nativeReceipt,
    installReceiptSha256:hash(nativeReceipt),currentGraphFile:graphFile,
    currentGraphSha256:hash(graphFile)});
  const nativeReadback={status:'PREVIOUS_TERMINAL_NEW_ABSENT',
    previousOperationId:old.operationId,previousRunId:'fixture-old-run',
    previousStatus:'cancelled',previousDispatchUnknown:false,
    nextOperationId:next.operationId,nextRunId:'fixture-next-run',
    nextRegistered:false,nativeOwnerBoundActivation:true,readOnly:true};
  const readback=put(path.join(root,'native-readback.json'),nativeReadback);
  const candidate={...f.candidate,kind:'workspace-gpt-queue-owner-replacement',
    baseline:backendRoot,backend:backendRoot,changedFiles:[],toolHash:w.toolHash,
    queueToolNames:toolNames,configBeforeSHA256:hash(f.configFile),
    configDesiredSHA256:hash(f.configDesiredFile),
    gatewayConfigSHA256:hash(path.join(f.gateway,'config.json')),
    oldGatewayConfigSHA256:hash(graphFile),
    oldGatewayManifestSHA256:hash(oldManifestFile),
    queuePreviousBindingFile:priorFile,queuePreviousBindingSHA256:hash(priorFile),
    queuePreviousPreparedFile:priorReceipt,queuePreviousPreparedSHA256:hash(priorReceipt),
    queueNextBindingFile:f.bindingFile,queueNextBindingSHA256:hash(f.bindingFile),
    queueOwnerPreparedFile:f.prepared,queueOwnerPreparedSHA256:hash(f.prepared),
    nativeUpgradeEvidenceFile:nativeEvidenceFile,nativeUpgradeEvidenceSHA256:hash(nativeEvidenceFile),
    queueNativeReadbackFile:readback,queueNativeReadbackSHA256:hash(readback),
    queueBackendManifestSHA256:hash(release),queueDriveManifestSHA256:hash(drive),
    gptQueueRecovery:{registrySHA256:hash(f.registryFile),
      inventoryBeforeFile:inventoryFile,inventoryBeforeSHA256:hash(inventoryFile)}};
  put(path.join(root,'candidate.json'),candidate);
  const fake=JSON.parse(fs.readFileSync(f.fake,'utf8'));
  fake.contract={hash:candidate.toolHash,names:toolNames,toolCalls:0,leasesOpened:0};
  fake.nativeReadback=nativeReadback;
  fake.current={ok:true,status:'CURRENT_ORIGINAL_ISSUER_VERIFIED_READ_ONLY',
    originalRequestSha256:next.originalRequestSha256,ownerIdentityHash:next.ownerIdentityHash,
    definitionSha256:next.definitionSha256,targetCount:2,executionAuthorized:false,
    dispatched:false,filesWritten:0,
    observations:['9222','9223'].map(slot=>({slot,
      observedAt:new Date(Date.now()-1000).toISOString(),
      expiresAt:new Date(Date.now()+60000).toISOString()}))};
  put(f.fake,fake);
  const harness=put(path.join(root,'replacement-verify.ps1'),
    "param($CandidateReceipt,$configFile,$profileFile,$registryFile,$FakeFile,$Helper)\n"+
    "$ErrorActionPreference='Stop'\n"+helpers+"\n. $Helper\n"+
    "$fixture=Read $FakeFile\n"+
    "function Get-ItemProperty {param($LiteralPath) @{ '(default)'=$fixture.manifest }}\n"+
    "function Get-GptQueueReplacementNativeReadback {param($a,$b,$c,$d) $fixture.nativeReadback }\n"+
    "function Invoke-QueueFixtureRuntime {\n"+
    "if($args[0] -ne '--input-type=module'){throw 'unexpected-runtime'}\n"+
    "if($args[2] -match 'verifyGptQueueOwnerConfig'){$fixture.current|ConvertTo-Json -Depth 10}\n"+
    "else{$fixture.contract|ConvertTo-Json -Depth 10}\n"+
    "$global:LASTEXITCODE=0\n}\n"+
    "$env:CODEX_THREAD_ID='fixture-owner'\n"+
    "$c=Read $CandidateReceipt;$before=Read $configFile;$after=Read $c.configDesiredFile\n"+
    "Assert-GptQueueOwnerReplacementCandidate $c $before $after\n");
  const run=()=>spawnSync('pwsh',['-NoProfile','-File',harness,
    path.join(root,'candidate.json'),f.configFile,
    path.join(root,'profile.yaml'),f.registryFile,f.fake,helper],
    {encoding:'utf8',windowsHide:true});
  return {...f,before,after,old,next,priorFile,priorReceipt,nativeEvidenceFile,
    graphFile,oldManifestFile,candidate,fake:f.fake,run,refresh:()=>put(path.join(root,'candidate.json'),candidate)};
}
test('replacement preserves installed backend/manager/host/native/tools and fails closed on original or freshness drift',
  {skip:process.platform!=='win32'},t=>{
  {
    const f=replacementFixture(t);
    const original=hash(f.configFile),old=hash(f.priorFile),next=hash(f.bindingFile);
    const r=f.run();assert.equal(r.status,0,r.stderr||r.stdout);
    assert.equal(hash(f.configFile),original);
    assert.equal(hash(f.priorFile),old);assert.equal(hash(f.bindingFile),next);
    assert.equal(f.candidate.baseline,f.candidate.backend);
  }
  for(const mutation of [
    'original-config','native-binary','native-evidence','stale-native-graph',
    'wrong-tool-hash','unrelated-owner-permission','wrong-gateway-provider',
    'closed-target','expired-target','wrong-previous-prepared','active-current-target'
  ]){
    const f=replacementFixture(t);
    const configHash=hash(f.configFile),oldHash=hash(f.priorFile),nextHash=hash(f.bindingFile);
    if(mutation==='original-config'){
      const before={...f.before,permissions:{...f.before.permissions,network:true}};
      f.put(f.configFile,before);
    }else if(mutation==='native-binary'){
      f.put(f.next.nativeExecutable,'SYNTHETIC_CHANGED_NOT_EXECUTED');
    }else if(mutation==='native-evidence'){
      const e=JSON.parse(fs.readFileSync(f.nativeEvidenceFile));
      e.ownerBoundActivation=false;f.put(f.nativeEvidenceFile,e);
      f.candidate.nativeUpgradeEvidenceSHA256=hash(f.nativeEvidenceFile);f.refresh();
    }else if(mutation==='stale-native-graph'){
      f.put(f.graphFile,{hostControl:'different'});
    }else if(mutation==='wrong-tool-hash'){
      f.candidate.toolHash='f'.repeat(64);f.refresh();
    }else if(mutation==='unrelated-owner-permission'){
      f.after.permissions.commands=true;
      f.put(f.configDesiredFile,f.after);
      f.candidate.configDesiredSHA256=hash(f.configDesiredFile);f.refresh();
    }else if(mutation==='wrong-gateway-provider'){
      const graph=JSON.parse(fs.readFileSync(path.join(f.gateway,'config.json')));
      graph.providers.find(p=>p.id==='native').id='forged';
      f.put(path.join(f.gateway,'config.json'),graph);
      f.candidate.gatewayConfigSHA256=hash(path.join(f.gateway,'config.json'));f.refresh();
    }else if(mutation==='closed-target'||mutation==='expired-target'||mutation==='active-current-target'){
      const fake=JSON.parse(fs.readFileSync(f.fake));
      if(mutation==='closed-target')fake.current.ok=false;
      if(mutation==='expired-target')fake.current.observations[0].expiresAt=new Date(Date.now()-30000).toISOString();
      if(mutation==='active-current-target')fake.current.executionAuthorized=true;
      f.put(f.fake,fake);
    }else if(mutation==='wrong-previous-prepared'){
      f.put(f.priorReceipt,{kind:'wrong'});
    }
    const r=f.run();assert.notEqual(r.status,0,mutation);
    if(mutation!=='original-config')assert.equal(hash(f.configFile),configHash);
    if(mutation!=='wrong-previous-prepared')assert.equal(hash(f.priorFile),oldHash);
    assert.equal(hash(f.bindingFile),nextHash);
  }
});
test('replacement preparer creates immutable candidate without touching installed config or graph',
 {skip:process.platform!=='win32'},t=>{
  const source=fs.readFileSync('tools/platform/workspace-mcp/Prepare-AiccGptQueueDeployment.ps1','utf8');
  const start=source.indexOf('if($ReplaceExistingOwnerBinding){');
  const end=source.indexOf("if(!$StageReceipt){throw 'Original uninstalled owner stage receipt required'}",start);
  assert.ok(start>0&&end>start,'exact reviewed explicit replacement branch');
  const branch=source.slice(start,end);
  for(const wrongCas of [false,true]){
    const f=replacementFixture(t);
    const operation=path.join(f.root,'asset-control','candidate-generation');
    fs.mkdirSync(path.dirname(operation),{recursive:true});
    const meta={
      stateRoot:f.root,operation,registryFile:f.registryFile,configFile:f.configFile,
      profileFile:path.join(f.root,'profile.yaml'),helper,
      ownerPrepared:f.prepared,ownerPreparedSha:hash(f.prepared),
      oldPrepared:f.priorReceipt,oldPreparedSha:hash(f.priorReceipt),
      oldBindingSha:hash(f.priorFile),upgradeEvidence:f.nativeEvidenceFile,
      upgradeSha:hash(f.nativeEvidenceFile),configSha:wrongCas?'f'.repeat(64):hash(f.configFile),
      registrySha:hash(f.registryFile),
      releaseSha:f.candidate.queueBackendManifestSHA256,
      driveSha:f.candidate.queueDriveManifestSHA256,
      gatewaySha:hash(f.graphFile),gatewayManifestSha:hash(f.oldManifestFile),
      fake:f.fake
    };
    const contextFile=f.put(path.join(f.root,'replacement-context.json'),meta);
    const harness=f.put(path.join(f.root,'prepare-replacement.ps1'),
      "param($ContextFile)\n$ErrorActionPreference='Stop'\n"+helpers+"\n"+
      "$ctx=Read $ContextFile\n"+
      "$stateRoot=$ctx.stateRoot;$registryFile=$ctx.registryFile;$configFile=$ctx.configFile\n"+
      "$profileFile=$ctx.profileFile\n. $ctx.helper\n"+
      "$OwnerPreparedReceipt=$ctx.ownerPrepared\n"+
      "$ExpectedOwnerPreparedSha256=$ctx.ownerPreparedSha\n"+
      "$PreviousOwnerPreparedReceipt=$ctx.oldPrepared\n"+
      "$ExpectedPreviousOwnerPreparedSha256=$ctx.oldPreparedSha\n"+
      "$ExpectedPreviousBindingSha256=$ctx.oldBindingSha\n"+
      "$NativeUpgradeEvidenceFile=$ctx.upgradeEvidence\n"+
      "$ExpectedNativeUpgradeEvidenceSha256=$ctx.upgradeSha\n"+
      "$ExpectedInstalledConfigSha256=$ctx.configSha\n"+
      "$ExpectedInstalledRegistrySha256=$ctx.registrySha\n"+
      "$ExpectedInstalledBackendReleaseSha256=$ctx.releaseSha\n"+
      "$ExpectedInstalledDriveManifestSha256=$ctx.driveSha\n"+
      "$ExpectedInstalledGatewayConfigSha256=$ctx.gatewaySha\n"+
      "$ExpectedInstalledGatewayManifestSha256=$ctx.gatewayManifestSha\n"+
      "$OperationDirectory=$ctx.operation\n$ReplaceExistingOwnerBinding=$true\n"+
      "$env:CODEX_THREAD_ID='fixture-owner'\n"+
      "$prepared=Read $OwnerPreparedReceipt\n"+
      "$ownerBinding=Join-Path (Split-Path $OwnerPreparedReceipt -Parent) 'binding.json'\n"+
      "$binding=Read $ownerBinding\n"+
      "Assert-GptQueueTargetProofFreshness $binding\n"+
      "function Get-GptQueueReplacementNativeReadback {param($one,$two,$three,$four) (Read $ctx.fake).nativeReadback}\n"+
      "function Validate-Candidate {param($Candidate)\n"+
      "if($Candidate.kind -cne 'workspace-gpt-queue-owner-replacement' -or $Candidate.backend -cne $Candidate.baseline){throw 'BAD_REPLACEMENT_CANDIDATE'}\n"+
      "}\n"+branch+"\n");
    const originalHash=hash(f.configFile),originalGraphHash=hash(f.graphFile);
    const result=spawnSync('pwsh',['-NoProfile','-File',harness,contextFile],
      {encoding:'utf8',windowsHide:true});
    if(wrongCas){
      assert.notEqual(result.status,0,result.stdout);
      assert.match(result.stderr,/CAS/);
      assert.equal(fs.existsSync(operation),false);
    }else{
      assert.equal(result.status,0,result.stderr||result.stdout);
      const output=JSON.parse(result.stdout.trim());
      assert.equal(output.status,'VALIDATED_NOT_ACTIVE');
      assert.equal(output.liveWrites,0);assert.equal(output.dispatched,false);
      const created=JSON.parse(fs.readFileSync(path.join(operation,'candidate.json'),'utf8'));
      assert.equal(created.kind,'workspace-gpt-queue-owner-replacement');
      assert.equal(created.backend,created.baseline);
      const desired=JSON.parse(fs.readFileSync(created.configDesiredFile,'utf8'));
      const before=JSON.parse(fs.readFileSync(f.configFile,'utf8'));
      assert.deepEqual({...desired,gptQueue:before.gptQueue},before);
      assert.deepEqual(desired.gptQueue,{enabled:true,bindingFile:f.bindingFile,
        bindingSha256:hash(f.bindingFile)});
      assert.equal(created.toolHash,f.candidate.toolHash);
      const configured=JSON.parse(fs.readFileSync(path.join(created.gateway,'config.json'),'utf8'));
      const installed=JSON.parse(fs.readFileSync(f.graphFile,'utf8'));
      configured.providers.find(p=>p.id==='workspace').files
        .find(p=>p.path===f.configFile).sha256=hash(f.configFile);
      assert.deepEqual(configured,installed);
      // Reusing the same prepared owner directory must never overwrite.
      const repeated=spawnSync('pwsh',['-NoProfile','-File',harness,contextFile],
        {encoding:'utf8',windowsHide:true});
      assert.notEqual(repeated.status,0,'candidate create-once boundary');
    }
    assert.equal(hash(f.configFile),originalHash);
    assert.equal(hash(f.graphFile),originalGraphHash);
  }
});
test('PowerShell parser accepts queue replacement helper, preparer and existing updater',
 {skip:process.platform!=='win32'},()=>{
  const files=['tools/platform/workspace-mcp/Prepare-AiccGptQueueDeployment.ps1',
    'tools/platform/workspace-mcp/GptQueueRuntimeDeployment.ps1',
    'tools/platform/workspace-mcp/Update-AiccWebManagementRuntime.ps1'];
  const list=files.map(f=>"'"+path.resolve(f).replaceAll("'","''")+"'").join(',');
  const source='$files=@('+list+');foreach($file in $files){'+
    '$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile('+
    '$file,[ref]$tokens,[ref]$errors)|Out-Null;'+
    'if($errors.Count){$errors|ForEach-Object {$_.Message};exit 1}}';
  const result=spawnSync('pwsh',['-NoProfile','-EncodedCommand',
    Buffer.from(source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
});
test('replacement reads the full actual MCP tool list and retains canonical schema hash',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'queue-replacement-actual-tools-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'config.json');
  fs.writeFileSync(file,json({surfaceProfile:'business-full',workspaces:[],
    permissions:{commands:false},gptQueue:{enabled:true}}));
  const code=fs.readFileSync(helper,'utf8');
  const after=code.slice(code.indexOf('function Assert-GptQueueReplacementActualTools('));
  const snippet=after.match(/\$contractScript=@'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
  assert.ok(snippet);
  const result=spawnSync(process.execPath,['--input-type=module','-e',snippet,process.cwd(),file],
    {encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const actual=JSON.parse(result.stdout);
  assert.equal(actual.toolCalls,0);assert.equal(actual.leasesOpened,0);
  assert.equal(actual.names.filter(n=>n.startsWith('aicc_gpt_queue_')).length,5);
  const expected=spawnSync(process.execPath,['--input-type=module','-e',
    "import fs from 'node:fs';import {createWorkspaceMcpServer} from './components/workspace-mcp/server.mjs';"+
    "import {Client} from '@modelcontextprotocol/sdk/client/index.js';"+
    "import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';"+
    "import {hostToolHash} from './components/host-control/prepare-update.mjs';"+
    "const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));"+
    "const temp=process.argv[1]+\'.runtime\';fs.mkdirSync(temp,{recursive:true});"+
    "const server=createWorkspaceMcpServer(c,{runtimeRoot:temp,remoteAuthority:{reconcileStartup(){}}});"+
    "const client=new Client({name:'hash-check',version:'1.0.0'});"+
    "const [s,t]=InMemoryTransport.createLinkedPair();await server.connect(s);await client.connect(t);"+
    "const r=(await client.listTools()).tools;console.log(hostToolHash(r));"+
    "await client.close();await server.close();",file],{encoding:'utf8',windowsHide:true});
  assert.equal(expected.status,0,expected.stderr);
  assert.equal(actual.hash,expected.stdout.trim());
});
test('legacy cancelled-unsent predecessor is accepted only with sealed exact native and cancellation evidence',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'queue-legacy-cancel-read-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const nativeScript=fs.readFileSync(helper,'utf8').match(/\$nativeReadScript=@'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
  assert.ok(nativeScript);
  fs.writeFileSync(path.join(root,'package.json'),json({type:'module'}));
  const provider=path.join(root,'components/workspace-mcp/gpt-queue-provider.mjs');
  fs.mkdirSync(path.dirname(provider),{recursive:true});
  fs.writeFileSync(provider,[
    "import fs from 'node:fs';",
    "export async function nativeGptQueueExchange(_binding,body){",
    "const state=JSON.parse(fs.readFileSync(process.env.QUEUE_TEST_NATIVE_JSON,'utf8'));",
    "if(body.type==='orchestration_capabilities')return {ok:true,payload:state.capability};",
    "if(body.type!=='orchestration_get')throw Error('UNAUTHORIZED_MUTATION');",
    "return body.runId===state.oldId?{ok:true,payload:{revision:5,run:state.oldRun}}:state.newGet;",
    "}"
  ].join('\n'));
  const title='legacy paused owner fixture';
  const roles=['9222','9223'].map((slot,i)=>({
    id:'role-'+slot,slot,targetNonce:(i?'b':'a').repeat(64),
    conversationId:'conversation-'+slot,prompt:'Synthetic original role '+slot
  }));
  const request={schemaVersion:1,kind:'aicc-gpt-queue-original-owner-request',
    operationId:'previous-operation-0001',bindingId:'previous-binding-0001',
    ownerId:'fixture-owner-0001',ownerIdentityHash:'b'.repeat(64),
    workspaceAlias:'fixture-workspace',workspaceRoot:root,title,roles};
  const requestFile=path.join(root,'original-private-request.json');
  fs.writeFileSync(requestFile,json(request));
  const digest=x=>createHash('sha256').update(x).digest('hex');
  const id=b=>'gptq_'+digest(b.bindingId+'\0'+b.ownerIdentityHash).slice(0,24)+'_'+b.operationId;
  const old={bindingId:request.bindingId,operationId:request.operationId,
    originalRequestSha256:hash(requestFile),ownerId:request.ownerId,
    ownerIdentityHash:request.ownerIdentityHash,workspaceAlias:request.workspaceAlias,
    workspaceRoot:request.workspaceRoot,definitionSha256:digest(JSON.stringify({title,roles})),
    currentIssuer:{requestFile},targets:roles.map(r=>({roleId:r.id,slot:r.slot,
      targetNonce:r.targetNonce,conversationId:r.conversationId}))};
  const next={...old,bindingId:'next-binding-0001',operationId:'next-operation-0001',
    originalRequestSha256:'d'.repeat(64),nativeExecutable:path.join(root,'synthetic.exe')};
  const oldFile=path.join(root,'old-binding.json'),nextFile=path.join(root,'new-binding.json');
  fs.writeFileSync(oldFile,json(old));fs.writeFileSync(nextFile,json(next));
  const originalBindingSHA=hash(oldFile);
  const run={id:id(old),registrationOnly:true,status:'cancelled',paused:true,
    cancelledAt:'2026-11-12T00:00:00.000Z',title,
    roles:roles.map((r,i)=>({...r,position:i,attempt:0,history:[],status:'cancelled'}))};
  const ownerRoles=status=>roles.map(r=>({id:r.id,slot:r.slot,status,
    dispatchCount:0,submissionUncertain:false,conversationRecorded:true,
    userMessageRecorded:false,assistantMessageRecorded:false,errorCode:null,structuredResult:null}));
  const before={ok:true,operationId:old.operationId,revision:4,
    status:'paused',paused:true,registrationOnly:true,
    dispatchState:'NOT_DISPATCHED',executionAuthorized:false,roles:ownerRoles('ready')};
  const final={...before,revision:5,status:'cancelled',
    cancel:'CANCELLED_UNSENT',roles:ownerRoles('cancelled')};
  const receiptFile=path.join(root,'original-cancel-receipt.json');
  const stateFile=path.join(root,'synthetic-native-result.json');
  const base={oldId:id(old),oldRun:run,
    capability:{pausedRegistration:true,revisionFencedCancel:true,ownerBoundActivation:true},
    newGet:{ok:false,error:'WEBGPT_ORCHESTRATION_RUN_NOT_FOUND'}};
  const execute=(opts={})=>{
    fs.writeFileSync(receiptFile,json(opts.receipt??{before,result:final}));
    fs.writeFileSync(stateFile,json({...base,oldRun:opts.run??run}));
    const receiptSha=opts.wrongSha?'f'.repeat(64):hash(receiptFile);
    const args=['--input-type=module','-e',nativeScript,root,oldFile,nextFile];
    if(!opts.noReceipt)args.push(receiptFile,receiptSha);
    return spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true,
      env:{...process.env,QUEUE_TEST_NATIVE_JSON:stateFile}});
  };
  const good=execute();assert.equal(good.status,0,good.stderr);
  assert.equal(JSON.parse(good.stdout).previousProof,'SEALED_LEGACY_CANCELLED_UNSENT');
  for(const opts of [
    {noReceipt:true},{wrongSha:true},
    {run:{...run,status:'active'}},
    {run:{...run,roles:run.roles.map((r,i)=>({...r,attempt:i?1:0}))}},
    {receipt:{before,result:{...final,dispatchState:'DISPATCH_RECORDED'}}},
    {receipt:{before:{...before,revision:3},result:final}}
  ]){
    const denied=execute(opts);assert.notEqual(denied.status,0,JSON.stringify(opts));
  }
  assert.equal(hash(oldFile),originalBindingSHA);
});
function unregisteredRebindNativeFixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'queue-same-operation-unregistered-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const put=(name,value)=>{
    const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,typeof value==='string'?value:json(value));return file;};
  const digest=text=>createHash('sha256').update(text).digest('hex');
  const script=fs.readFileSync(helper,'utf8').match(/\$rebindNativeScript=@'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
  assert.ok(script,'dedicated unregistered-only script');
  const base={schemaVersion:1,kind:'aicc-gpt-queue-original-owner-request',
    bindingId:'same-operation-binding',operationId:'same-operation-fixture',
    ownerId:'same-owner',ownerIdentityHash:'a'.repeat(64),
    workspaceAlias:'fixture-project',workspaceRoot:root,title:'Exact bounded same-operation probe'};
  const roles=['9222','9223'].map((slot,i)=>({
    id:'canary-role-'+slot,slot,targetId:(i?'B':'A').repeat(32),
    leaseToken:(i?'b':'a').repeat(32),targetNonce:(i?'d':'c').repeat(64),
    conversationId:'exact-conversation-'+slot,prompt:'G1 bounded probe',
    accountAlias:'exact-account-'+slot,browserWorkspace:'exact-space-'+slot
  }));
  const nextRoles=roles.map((r,i)=>({...r,targetId:(i?'D':'C').repeat(32),
    leaseToken:(i?'d':'c').repeat(32),targetNonce:(i?'f':'e').repeat(64)}));
  const prevRequest=put('previous-request.json',{...base,roles});
  const nextRequest=put('next-request.json',{...base,roles:nextRoles});
  const target=r=>({roleId:r.id,slot:r.slot,targetId:r.targetId,
    targetNonce:r.targetNonce,conversationId:r.conversationId,
    accountAlias:r.accountAlias,browserWorkspace:r.browserWorkspace,
    originalLeaseSha256:digest(r.leaseToken),
    accountIdentityHash:'7'.repeat(64),workspaceIdentityHash:'8'.repeat(64)});
  const common={
    schemaVersion:1,kind:'aicc-gpt-queue-owner-binding',bindingId:base.bindingId,
    operationId:base.operationId,ownerId:base.ownerId,ownerIdentityHash:base.ownerIdentityHash,
    workspaceAlias:base.workspaceAlias,workspaceRoot:base.workspaceRoot,
    nativeExecutable:path.join(root,'native-not-executed.exe'),
    nativeExecutableSha256:'1'.repeat(64),
    nativeConfig:path.join(root,'native-config-not-executed.json'),
    nativeConfigSha256:'2'.repeat(64),
    nativeManifest:path.join(root,'native-manifest-not-executed.json'),
    nativeManifestSha256:'3'.repeat(64),baseDirectory:path.join(root,'native-state'),
  };
  const current=(requestFile)=>({kind:'registered-cdp-current-issuer/v1',
    requestFile,requestSha256:hash(requestFile),helperFile:path.join(root,'helper.ps1'),
    helperSha256:'4'.repeat(64),identityGuardFile:path.join(root,'guard.ps1'),
    identityGuardSha256:'5'.repeat(64),powershellFile:path.join(root,'pwsh.exe'),
    powershellSha256:'6'.repeat(64)});
  const definition=rr=>digest(JSON.stringify({title:base.title,roles:rr.map(r=>({
    id:r.id,slot:r.slot,targetNonce:r.targetNonce,conversationId:r.conversationId,prompt:r.prompt
  }))}));
  const old=put('old-binding.json',{...common,currentIssuer:current(prevRequest),
    originalRequestSha256:hash(prevRequest),definitionSha256:definition(roles),
    targets:roles.map(target)});
  const newer=put('new-binding.json',{...common,currentIssuer:current(nextRequest),
    originalRequestSha256:hash(nextRequest),definitionSha256:definition(nextRoles),
    targets:nextRoles.map(target)});
  const prior=put('previous-prepared.json',{schemaVersion:1,
    kind:'aicc-gpt-queue-owner-prepared',inspectedTargets:2,
    originalRequestDispatched:false,bindingSha256:hash(old),
    originalRequestSha256:hash(prevRequest),ownerIdentityHash:base.ownerIdentityHash});
  const prepared=put('new-prepared.json',{schemaVersion:1,
    kind:'aicc-gpt-queue-owner-prepared',inspectedTargets:2,
    originalRequestDispatched:false,bindingSha256:hash(newer),
    originalRequestSha256:hash(nextRequest),ownerIdentityHash:base.ownerIdentityHash,
    reboundUnregisteredRequest:true,refreshedByOriginalIssuer:true,
    priorReceiptPath:prior,priorReceiptSha256:hash(prior),
    priorBindingSha256:hash(old),priorOriginalRequestSha256:hash(prevRequest),
    nativePinned:true,sourceOnly:true,installedWorkspaceProvider:false,toolPublished:false});
  put('package.json',{type:'module'});
  put('components/workspace-mcp/gpt-queue-provider.mjs',[
    "import fs from 'node:fs';",
    "export async function nativeGptQueueExchange(_binding,input){",
    "const s=JSON.parse(fs.readFileSync(process.env.QUEUE_REBIND_NATIVE_STATE,'utf8'));",
    "if(input.type==='orchestration_capabilities')return {ok:true,payload:s.capabilities};",
    "if(input.type!=='orchestration_get')throw Error('FORBIDDEN_NATIVE_MUTATION');",
    "if(input.runId!==s.runId)throw Error('WRONG_ORIGINAL_RUN_ID');",
    "const i=s.count++;",
    "const result=s.responses[i]??{ok:false,error:'WEBGPT_ORCHESTRATION_RUN_NOT_FOUND'};",
    "fs.writeFileSync(process.env.QUEUE_REBIND_NATIVE_STATE,JSON.stringify(s));",
    "return result;",
    "}"
  ].join('\n'));
  const runId='gptq_'+digest(base.bindingId+'\0'+base.ownerIdentityHash).slice(0,24)+'_'+base.operationId;
  const stateFile=path.join(root,'native-state-test.json');
  const nativeState={count:0,runId,
    capabilities:{pausedRegistration:true,ownerBoundActivation:true,revisionFencedCancel:true},
    responses:[{ok:false,error:'WEBGPT_ORCHESTRATION_RUN_NOT_FOUND'},
      {ok:false,error:'WEBGPT_ORCHESTRATION_RUN_NOT_FOUND'}]};
  const execute=(mutation=()=>{},stateMutation=()=>{})=>{
    const snapshot=JSON.parse(fs.readFileSync(newer,'utf8'));
    const nextSource=JSON.parse(fs.readFileSync(nextRequest,'utf8'));
    const receipt=JSON.parse(fs.readFileSync(prepared,'utf8'));
    const originalSource=JSON.parse(fs.readFileSync(prevRequest,'utf8'));
    const state=structuredClone(nativeState);
    mutation({snapshot,nextSource,receipt,originalSource});
    // A malicious caller may attempt to re-sign new request/binding/receipt.
    if(JSON.stringify(nextSource)!==fs.readFileSync(nextRequest,'utf8').trim()){
      put('next-request.json',nextSource);
      snapshot.currentIssuer.requestSha256=hash(nextRequest);
      snapshot.originalRequestSha256=hash(nextRequest);
      snapshot.definitionSha256=definition(nextSource.roles);
    }
    if(JSON.stringify(originalSource)!==fs.readFileSync(prevRequest,'utf8').trim()){
      put('previous-request.json',originalSource);
    }
    if(JSON.stringify(snapshot)!==fs.readFileSync(newer,'utf8').trim()){
      put('new-binding.json',snapshot);receipt.bindingSha256=hash(newer);
      receipt.originalRequestSha256=snapshot.originalRequestSha256;
    }
    put('new-prepared.json',receipt);
    stateMutation(state);
    fs.writeFileSync(stateFile,json(state));
    const result=spawnSync(process.execPath,['--input-type=module','-e',
      script,root,old,newer,prior,prepared],{encoding:'utf8',windowsHide:true,
      env:{...process.env,QUEUE_REBIND_NATIVE_STATE:stateFile}});
    const calls=JSON.parse(fs.readFileSync(stateFile,'utf8')).count;
    return {result,calls};
  };
  return {root,script,old,newer,prior,prepared,prevRequest,nextRequest,
    put,execute,nativeState};
}
test('same-operation rebind reads exact installed Native NOT_FOUND twice without registration',t=>{
 const f=unregisteredRebindNativeFixture(t);
 const {result,calls}=f.execute();
 assert.equal(result.status,0,result.stderr);
 const output=JSON.parse(result.stdout);
 assert.equal(output.status,'UNREGISTERED_SAME_OPERATION_REBOUND_ABSENT');
 assert.equal(output.operationId,'same-operation-fixture');
 assert.equal(output.bindingId,'same-operation-binding');
 assert.equal(output.nativeReadCount,2);
 assert.equal(output.dispatched,false);assert.equal(output.executionAuthorized,false);
 assert.equal(output.nativeRegistration,'NOT_FOUND');assert.equal(calls,2);
 assert.ok(!result.stdout.includes('leaseToken'));
});
test('same-operation rebind refuses registered, active, UNKNOWN and partial Native outcomes',t=>{
 const cases=[
   [[{ok:true,payload:{status:'paused'}}],1],
   [[{ok:true,payload:{status:'active'}}],1],
   [[{ok:false,error:'NATIVE_OUTCOME_UNKNOWN'}],1],
   [[{ok:false,error:'WEBGPT_ORCHESTRATION_RUN_NOT_FOUND'},
     {ok:true,payload:{status:'completed'}}],2],
   [[{ok:false,error:'WEBGPT_ORCHESTRATION_RUN_NOT_FOUND'},
     {ok:false,error:'NATIVE_OUTCOME_UNKNOWN'}],2]
 ];
 for(const [responses,max] of cases){
   const f=unregisteredRebindNativeFixture(t);
   const {result,calls}=f.execute(()=>{},s=>{s.responses=responses;});
   assert.notEqual(result.status,0,JSON.stringify(responses));assert.equal(calls,max);
 }
});
test('same-operation rebind rejects semantic drift, forged source SHA and unsealed receipt',t=>{
 for(const mutate of [
   ({nextSource})=>{nextSource.title='Different task';},
   ({nextSource})=>{nextSource.roles[0].prompt='Different instruction';},
   ({nextSource})=>{nextSource.roles[1].conversationId='foreign-conversation';},
   ({nextSource})=>{nextSource.roles[0].accountAlias='foreign-account';},
   ({nextSource})=>{nextSource.roles[0].targetId='A'.repeat(32);},
   ({nextSource})=>{nextSource.roles[0].targetNonce='c'.repeat(64);},
   ({snapshot})=>{snapshot.ownerIdentityHash='f'.repeat(64);},
   ({snapshot})=>{snapshot.bindingId='replaced-binding-forbidden';},
   ({snapshot})=>{snapshot.operationId='replaced-operation-forbidden';},
   ({snapshot})=>{snapshot.nativeExecutableSha256='f'.repeat(64);},
   ({receipt})=>{receipt.priorReceiptSha256='f'.repeat(64);},
   ({receipt})=>{receipt.priorOriginalRequestSha256='f'.repeat(64);},
   ({receipt})=>{receipt.reboundUnregisteredRequest=false;},
   ({receipt})=>{receipt.installedWorkspaceProvider=true;}
 ]){
  const f=unregisteredRebindNativeFixture(t);
  const {result,calls}=f.execute(mutate);
  assert.notEqual(result.status,0,mutate.toString());
  assert.equal(calls,0,'identity and immutable receipt must fail before native reads');
 }
});
function sameOperationCandidateFixture(t){
 const f=replacementFixture(t),native=unregisteredRebindNativeFixture(t);
 const root=f.root,put=f.put,digest=x=>createHash('sha256').update(x).digest('hex');
 const previous=JSON.parse(fs.readFileSync(f.priorFile,'utf8'));
 const next=structuredClone(previous);
 const base={schemaVersion:1,kind:'aicc-gpt-queue-original-owner-request',
  operationId:previous.operationId,bindingId:previous.bindingId,ownerId:previous.ownerId,
  ownerIdentityHash:previous.ownerIdentityHash,
  workspaceAlias:previous.workspaceAlias,workspaceRoot:previous.workspaceRoot,
  title:'G1 synthetic same-operation connection'};
 const roles=['9222','9223'].map((slot,i)=>{
  const target=previous.targets[i];return {id:'exact-role-'+slot,slot,
   targetId:target.targetId,leaseToken:(i?'b':'a').repeat(32),
   targetNonce:target.targetNonce,conversationId:target.conversationId,
   prompt:'Exact bounded synthetic probe',accountAlias:target.accountAlias,
   browserWorkspace:'fixture-space-'+slot};
 });
 const newerRoles=roles.map((r,i)=>({...r,targetId:(i?'D':'C').repeat(32),
  leaseToken:(i?'d':'c').repeat(32),targetNonce:(i?'f':'e').repeat(64)}));
 const sourceOld=put(path.join(root,'request-previous.json'),{...base,roles});
 const sourceNew=put(path.join(root,'request-next.json'),{...base,roles:newerRoles});
 const issuer=(source)=>({kind:'registered-cdp-current-issuer/v1',
  requestFile:source,requestSha256:hash(source),
  helperFile:path.join(root,'helper.ps1'),helperSha256:'4'.repeat(64),
  identityGuardFile:path.join(root,'guard.ps1'),identityGuardSha256:'5'.repeat(64),
  powershellFile:path.join(root,'pwsh.exe'),powershellSha256:'6'.repeat(64)});
 const definition=rs=>digest(JSON.stringify({title:base.title,roles:rs.map(r=>({
  id:r.id,slot:r.slot,targetNonce:r.targetNonce,conversationId:r.conversationId,prompt:r.prompt
 }))}));
 const targetsFor=(binding,rs,prefix)=>{
  return rs.map((r,i)=>{
   const target={...binding.targets[i],roleId:r.id,slot:r.slot,
    targetId:r.targetId,targetNonce:r.targetNonce,conversationId:r.conversationId,
    accountAlias:r.accountAlias,browserWorkspace:r.browserWorkspace,
    originalLeaseSha256:digest(r.leaseToken)};
   const proof=put(path.join(root,prefix+'-proof-'+i+'.json'),{
    schemaVersion:1,kind:'aicc-queue-exact-target-proof',
    state:'OWNED_ACTIVE',bindingId:binding.bindingId,ownerId:binding.ownerId,
    originalRequestSha256:binding.originalRequestSha256,
    ownerIdentityHash:binding.ownerIdentityHash,...target,
    observedAt:new Date(Date.now()-1000).toISOString(),
    expiresAt:new Date(Date.now()+60000).toISOString()});
   return {...target,proofFile:proof,proofSha256:hash(proof)};
  });
 };
 previous.currentIssuer=issuer(sourceOld);previous.originalRequestSha256=hash(sourceOld);
 previous.definitionSha256=definition(roles);
 previous.targets=targetsFor(previous,roles,'previous');
 next.currentIssuer=issuer(sourceNew);next.originalRequestSha256=hash(sourceNew);
 next.definitionSha256=definition(newerRoles);
 next.targets=targetsFor(next,newerRoles,'next');
 put(f.priorFile,previous);put(f.bindingFile,next);
 const priorReceipt={schemaVersion:1,kind:'aicc-gpt-queue-owner-prepared',
  inspectedTargets:2,originalRequestDispatched:false,
  bindingSha256:hash(f.priorFile),originalRequestSha256:hash(sourceOld),
  ownerIdentityHash:previous.ownerIdentityHash};
 put(f.priorReceipt,priorReceipt);
 const prepared={schemaVersion:1,kind:'aicc-gpt-queue-owner-prepared',
  inspectedTargets:2,originalRequestDispatched:false,
  bindingSha256:hash(f.bindingFile),originalRequestSha256:hash(sourceNew),
  ownerIdentityHash:previous.ownerIdentityHash,
  reboundUnregisteredRequest:true,refreshedByOriginalIssuer:true,
  priorReceiptPath:f.priorReceipt,priorReceiptSha256:hash(f.priorReceipt),
  priorBindingSha256:hash(f.priorFile),priorOriginalRequestSha256:hash(sourceOld),
  nativePinned:true,sourceOnly:true,installedWorkspaceProvider:false,toolPublished:false};
 put(f.prepared,prepared);
 const before={...f.before,gptQueue:{enabled:true,
  bindingFile:f.priorFile,bindingSha256:hash(f.priorFile)}};
 const after={...structuredClone(before),gptQueue:{enabled:true,
  bindingFile:f.bindingFile,bindingSha256:hash(f.bindingFile)}};
 put(f.configFile,before);put(path.join(root,'workspace-config.before.json'),before);
 put(f.configDesiredFile,after);
 const graph=JSON.parse(fs.readFileSync(f.graphFile,'utf8'));
 graph.providers.find(p=>p.id==='workspace').files.find(p=>p.path===f.configFile).sha256=hash(f.configFile);
 put(f.graphFile,graph);
 const installedManifest=JSON.parse(fs.readFileSync(f.oldManifestFile,'utf8'));
 installedManifest.files['config.json']=hash(f.graphFile);
 installedManifest.releaseHash=installedManifest.files['config.json'];
 put(f.oldManifestFile,installedManifest);
 const future=structuredClone(graph);
 future.providers.find(p=>p.id==='workspace').files.find(p=>p.path===f.configFile).sha256=hash(f.configDesiredFile);
 put(path.join(f.gateway,'config.json'),future);
 const futureManifest=structuredClone(installedManifest);
 futureManifest.files['config.json']=hash(path.join(f.gateway,'config.json'));
 futureManifest.releaseHash=futureManifest.files['config.json'];
 put(path.join(f.gateway,'manifest.json'),futureManifest);
 const evidence=JSON.parse(fs.readFileSync(f.nativeEvidenceFile,'utf8'));
 evidence.previousBindingSha256=hash(f.priorFile);
 evidence.currentGraphSha256=hash(f.graphFile);
 put(f.nativeEvidenceFile,evidence);
 const readback={status:'UNREGISTERED_SAME_OPERATION_REBOUND_ABSENT',
  operationId:previous.operationId,bindingId:previous.bindingId,
  previousRequestSha256:hash(sourceOld),nextRequestSha256:hash(sourceNew),
  previousPreparedSHA256:hash(f.priorReceipt),nextPreparedSHA256:hash(f.prepared),
  previousBindingSHA256:hash(f.priorFile),nextBindingSHA256:hash(f.bindingFile),
  nativeReadCount:2,nativeRegistration:'NOT_FOUND',dispatched:false,
  readOnly:true,executionAuthorized:false,ownerBoundActivation:true};
 const readbackFile=put(path.join(root,'native-readback.json'),readback);
 f.candidate.queueRebindUnregisteredSameOperation=true;
 f.candidate.queuePreviousOriginalRequestSHA256=hash(sourceOld);
 f.candidate.queueNextOriginalRequestSHA256=hash(sourceNew);
 f.candidate.legacyCancelReceiptFile='';
 f.candidate.legacyCancelReceiptSHA256='';
 Object.assign(f.candidate,{
  configBeforeSHA256:hash(f.configFile),configDesiredSHA256:hash(f.configDesiredFile),
  gatewayConfigSHA256:hash(path.join(f.gateway,'config.json')),
  oldGatewayConfigSHA256:hash(f.graphFile),oldGatewayManifestSHA256:hash(f.oldManifestFile),
  queuePreviousBindingSHA256:hash(f.priorFile),queueNextBindingSHA256:hash(f.bindingFile),
  queuePreviousPreparedSHA256:hash(f.priorReceipt),queueOwnerPreparedSHA256:hash(f.prepared),
  nativeUpgradeEvidenceSHA256:hash(f.nativeEvidenceFile),
  queueNativeReadbackFile:readbackFile,queueNativeReadbackSHA256:hash(readbackFile),
  gptQueueRecovery:{...f.candidate.gptQueueRecovery,registrySHA256:hash(f.registryFile)}
 });
 f.refresh();
 const fake=JSON.parse(fs.readFileSync(f.fake,'utf8'));
 fake.nativeReadback=readback;
 fake.current.originalRequestSha256=next.originalRequestSha256;
 fake.current.definitionSha256=next.definitionSha256;
 put(f.fake,fake);
 const harness=path.join(root,'replacement-verify.ps1');
 const text=fs.readFileSync(harness,'utf8');
 const anchor="function Get-GptQueueReplacementNativeReadback";
 assert.ok(text.includes(anchor));
 put(harness,text.replace(anchor,
  "function Get-GptQueueUnregisteredRebindNativeReadback {param($a,$b,$c,$d,$e,$f) $fixture.nativeReadback }\n"+anchor));
 const source=fs.readFileSync('tools/platform/workspace-mcp/Prepare-AiccGptQueueDeployment.ps1','utf8');
 const beginning=source.indexOf('if($ReplaceExistingOwnerBinding){');
 const ending=source.indexOf("if(!$StageReceipt){throw 'Original uninstalled owner stage receipt required'}",beginning);
 assert.ok(beginning>0&&ending>beginning);
 const branch=source.slice(beginning,ending);
 const operation=path.join(root,'asset-control','synthetic-rebind');
 const contextFile=put(path.join(root,'rebind-context.json'),{
  stateRoot:root,operation,registryFile:f.registryFile,configFile:f.configFile,
  profileFile:path.join(root,'profile.yaml'),helper,
  ownerPrepared:f.prepared,ownerPreparedSha:hash(f.prepared),
  oldPrepared:f.priorReceipt,oldPreparedSha:hash(f.priorReceipt),
  oldBindingSha:hash(f.priorFile),upgradeEvidence:f.nativeEvidenceFile,
  upgradeSha:hash(f.nativeEvidenceFile),configSha:hash(f.configFile),
  registrySha:hash(f.registryFile),
  releaseSha:f.candidate.queueBackendManifestSHA256,
  driveSha:f.candidate.queueDriveManifestSHA256,
  gatewaySha:hash(f.graphFile),gatewayManifestSha:hash(f.oldManifestFile),
  fake:f.fake
 });
 const sourceHarness=put(path.join(root,'rebind-source-prepare.ps1'),
  "param($ContextFile)\n$ErrorActionPreference='Stop'\n"+helpers+"\n"+
  "$ctx=Read $ContextFile\n"+
  "$stateRoot=$ctx.stateRoot;$registryFile=$ctx.registryFile;$configFile=$ctx.configFile\n"+
  "$profileFile=$ctx.profileFile\n. $ctx.helper\n"+
  "$OwnerPreparedReceipt=$ctx.ownerPrepared\n"+
  "$ExpectedOwnerPreparedSha256=$ctx.ownerPreparedSha\n"+
  "$PreviousOwnerPreparedReceipt=$ctx.oldPrepared\n"+
  "$ExpectedPreviousOwnerPreparedSha256=$ctx.oldPreparedSha\n"+
  "$ExpectedPreviousBindingSha256=$ctx.oldBindingSha\n"+
  "$NativeUpgradeEvidenceFile=$ctx.upgradeEvidence\n"+
  "$ExpectedNativeUpgradeEvidenceSha256=$ctx.upgradeSha\n"+
  "$ExpectedInstalledConfigSha256=$ctx.configSha\n"+
  "$ExpectedInstalledRegistrySha256=$ctx.registrySha\n"+
  "$ExpectedInstalledBackendReleaseSha256=$ctx.releaseSha\n"+
  "$ExpectedInstalledDriveManifestSha256=$ctx.driveSha\n"+
  "$ExpectedInstalledGatewayConfigSha256=$ctx.gatewaySha\n"+
  "$ExpectedInstalledGatewayManifestSha256=$ctx.gatewayManifestSha\n"+
  "$OperationDirectory=$ctx.operation\n$ReplaceExistingOwnerBinding=$true\n"+
  "$RebindUnregisteredSameOperation=$true\n$LegacyCancelReceiptFile=''\n"+
  "$ExpectedLegacyCancelReceiptSha256=''\n"+
  "$env:CODEX_THREAD_ID='fixture-owner'\n"+
  "$prepared=Read $OwnerPreparedReceipt\n"+
  "$ownerBinding=Join-Path (Split-Path $OwnerPreparedReceipt -Parent) 'binding.json'\n"+
  "$binding=Read $ownerBinding\n"+
  "Assert-GptQueueTargetProofFreshness $binding\n"+
  "function Get-GptQueueUnregisteredRebindNativeReadback {param($a,$b,$c,$d,$e,$f) (Read $ctx.fake).nativeReadback}\n"+
  "function Validate-Candidate {param($Candidate)\n"+
  "if($Candidate.kind -cne 'workspace-gpt-queue-owner-replacement' -or $Candidate.queueRebindUnregisteredSameOperation -cne $true){throw 'BAD_REBIND_CANDIDATE'}\n"+
  "}\n"+branch+"\n");
 const prepRun=()=>spawnSync('pwsh',['-NoProfile','-File',sourceHarness,contextFile],
  {encoding:'utf8',windowsHide:true});
 return {...f,native,previous,next,before,after,sourceOld,sourceNew,readback,
  operation,prepRun,sourceHarness,contextFile};
}
test('same-operation rebind candidate keeps existing graph/CAS and original terminal replacement strict',
 {skip:process.platform!=='win32'},t=>{
 const f=sameOperationCandidateFixture(t);
 const cfgSHA=hash(f.configFile),graphSHA=hash(f.graphFile);
 const success=f.run();
 assert.equal(success.status,0,success.stderr||success.stdout);
 assert.equal(hash(f.configFile),cfgSHA);
 assert.equal(hash(f.graphFile),graphSHA);
 for(const mode of ['no-opt-in','operation-drift','unknown-native','expired-target','unrelated-permission']){
  const g=sameOperationCandidateFixture(t);
  if(mode==='no-opt-in')g.candidate.queueRebindUnregisteredSameOperation=false;
  if(mode==='operation-drift')g.candidate.queuePreviousOriginalRequestSHA256='f'.repeat(64);
  if(mode==='unknown-native'){const fake=JSON.parse(fs.readFileSync(g.fake));
   fake.nativeReadback.status='UNKNOWN';g.put(g.fake,fake);}
  if(mode==='expired-target'){const fake=JSON.parse(fs.readFileSync(g.fake));
   fake.current.observations[0].expiresAt=new Date(Date.now()-1000).toISOString();
   g.put(g.fake,fake);}
  if(mode==='unrelated-permission'){const desired={...g.after,permissions:{...g.after.permissions,network:true}};
   g.put(g.configDesiredFile,desired);g.candidate.configDesiredSHA256=hash(g.configDesiredFile);}
  g.refresh();
  const result=g.run();
  assert.notEqual(result.status,0,mode);
 }
 // Existing terminal-replacement path remains separate and requires new IDs.
 const legacy=replacementFixture(t);
 legacy.candidate.queueRebindUnregisteredSameOperation=false;
 legacy.refresh();
 assert.equal(legacy.run().status,0);
});
test('same-operation rebind preparer creates source-only candidate and keeps current installed config untouched',
 {skip:process.platform!=='win32'},t=>{
 const f=sameOperationCandidateFixture(t),original=hash(f.configFile);
 const r=f.prepRun();
 assert.equal(r.status,0,r.stderr||r.stdout);
 const output=JSON.parse(r.stdout.trim());
 assert.equal(output.status,'VALIDATED_NOT_ACTIVE');
 assert.equal(output.liveWrites,0);
 assert.equal(output.dispatched,false);
 const saved=JSON.parse(fs.readFileSync(path.join(f.operation,'candidate.json'),'utf8'));
 assert.equal(saved.queueRebindUnregisteredSameOperation,true);
 assert.equal(saved.queuePreviousOriginalRequestSHA256,hash(f.sourceOld));
 assert.equal(saved.queueNextOriginalRequestSHA256,hash(f.sourceNew));
 assert.equal(saved.queueNativeReadbackSHA256,hash(saved.queueNativeReadbackFile));
 assert.equal(hash(f.configFile),original);
 assert.notEqual(f.prepRun().status,0,'source prepare is create-once');
});
test('replacement Prepare/Apply source gate keeps only fixed issuer diagnostics and never alters config on HOLD',
 {skip:process.platform!=='win32'},t=>{
 const allowed=[
  'QUEUE_CURRENT_ISSUER_TARGET_CLOSED_OR_UNPROVEN',
  'QUEUE_CURRENT_ISSUER_IDENTITY_HOLD',
  'QUEUE_CURRENT_ISSUER_INSPECT_TIMEOUT',
  'QUEUE_CURRENT_ISSUER_INSPECT_MALFORMED',
  'QUEUE_CURRENT_ISSUER_INSPECT_NONZERO'
 ];
 for(const reason of [...allowed,'QUEUE_CURRENT_ISSUER_LEASE_SECRET_DO_NOT_LOG']){
  const f=replacementFixture(t),fixedBefore=hash(f.configFile),graphBefore=hash(f.graphFile);
  const fake=JSON.parse(fs.readFileSync(f.fake));
  fake.current={ok:false,status:'HOLD',diagnosticCode:reason};
  f.put(f.fake,fake);
  const r=f.run();
  assert.notEqual(r.status,0,reason);
  const expected=allowed.includes(reason)?reason:'QUEUE_CURRENT_ISSUER_INSPECT_UNPROVEN';
  assert.ok(String(r.stderr).includes(expected),reason);
  assert.equal(String(r.stderr).includes('LEASE_SECRET_DO_NOT_LOG'),false);
  assert.equal(hash(f.configFile),fixedBefore);
  assert.equal(hash(f.graphFile),graphBefore);
 }
});

function issuerHelperUpgradeNativeFixture(t){
 const f=unregisteredRebindNativeFixture(t);
 const oldDir='previous-issuer',newDir='next-issuer';
 const oldHelper=f.put(oldDir+'/Manage-CdpChromeSlotLease.ps1',
   "param([string]$Action)\n# exact old issuer has no QueueOwnerRequestFile\n");
 const oldGuard=f.put(oldDir+'/Assert-CdpEndpointIdentity.ps1',
   '# original synthetic registered identity guard');
 const sourceHelper=path.resolve('tools/platform/web-automation/Manage-CdpChromeSlotLease.ps1');
 const sourceGuard=path.resolve('tools/platform/web-automation/Assert-CdpEndpointIdentity.ps1');
 const newHelper=f.put(newDir+'/Manage-CdpChromeSlotLease.ps1',fs.readFileSync(sourceHelper,'utf8'));
 const newGuard=f.put(newDir+'/Assert-CdpEndpointIdentity.ps1',fs.readFileSync(sourceGuard,'utf8'));
 const old=JSON.parse(fs.readFileSync(f.old));
 const next=JSON.parse(fs.readFileSync(f.newer));
 old.currentIssuer.helperFile=oldHelper;old.currentIssuer.helperSha256=hash(oldHelper);
 old.currentIssuer.identityGuardFile=oldGuard;old.currentIssuer.identityGuardSha256=hash(oldGuard);
 next.currentIssuer.helperFile=newHelper;next.currentIssuer.helperSha256=hash(newHelper);
 next.currentIssuer.identityGuardFile=newGuard;next.currentIssuer.identityGuardSha256=hash(newGuard);
 next.targetLifecycle='queue-owner-keep-target-before-registration/v1';
 const upgrade={kind:'aicc-queue-current-issuer-helper-upgrade/v1',
   previousHelperSha256:hash(oldHelper),previousGuardSha256:hash(oldGuard),
   nextHelperSha256:hash(newHelper),nextGuardSha256:hash(newGuard),
   sourceHelperFile:sourceHelper,sourceHelperSha256:hash(sourceHelper),
   sourceGuardFile:sourceGuard,sourceGuardSha256:hash(sourceGuard),
   powershellSha256:old.currentIssuer.powershellSha256,
   requiredArgument:'QueueOwnerRequestFile',
   targetLifecycle:next.targetLifecycle};
 next.issuerHelperUpgrade=upgrade;
 f.put('old-binding.json',old);
 f.put('new-binding.json',next);
 const prior=JSON.parse(fs.readFileSync(f.prior));
 prior.bindingSha256=hash(f.old);f.put('previous-prepared.json',prior);
 const prepared=JSON.parse(fs.readFileSync(f.prepared));
 prepared.issuerHelperUpgrade=upgrade;prepared.bindingSha256=hash(f.newer);
 prepared.priorReceiptSha256=hash(f.prior);prepared.priorBindingSha256=hash(f.old);
 f.put('new-prepared.json',prepared);
 const stateFile=path.join(f.root,'native-upgrade-state.json');
 const run=(mutation=()=>{},override={})=>{
   mutation({old,newHelper,newGuard,sourceHelper,sourceGuard,upgrade});
   fs.writeFileSync(stateFile,JSON.stringify(f.nativeState));
   const args=['--input-type=module','-e',f.script,f.root,f.old,f.newer,
      f.prior,f.prepared,'true',override.previousHelperSha256??hash(oldHelper),
      override.nextHelperSha256??hash(newHelper),
      override.nextGuardSha256??hash(newGuard),sourceHelper,sourceGuard];
   const result=spawnSync(process.execPath,args,{encoding:'utf8',windowsHide:true,
     env:{...process.env,QUEUE_REBIND_NATIVE_STATE:stateFile}});
   const count=JSON.parse(fs.readFileSync(stateFile)).count;
   return {result,count};
 };
 return {f,old,next,upgrade,oldHelper,oldGuard,newHelper,newGuard,
   sourceHelper,sourceGuard,run};
}
test('helper upgrade native readback verifies both SHA-pinned generations and reads official missing run twice',t=>{
 const f=issuerHelperUpgradeNativeFixture(t);
 const {result,count}=f.run();
 assert.equal(result.status,0,result.stderr);
 assert.equal(count,2);
 const data=JSON.parse(result.stdout);
 assert.equal(data.status,'UNREGISTERED_SAME_OPERATION_REBOUND_ABSENT');
 assert.equal(data.nativeRegistration,'NOT_FOUND');assert.equal(data.nativeReadCount,2);
 assert.equal(data.issuerHelperUpgrade,true);
 assert.equal(data.previousHelperSha256,hash(f.oldHelper));
 assert.equal(data.nextHelperSha256,hash(f.newHelper));
 assert.equal(data.nextGuardSha256,hash(f.newGuard));
 assert.equal(data.executionAuthorized,false);assert.equal(data.dispatched,false);
 assert.equal(JSON.stringify(data).includes('leaseToken'),false);
});
test('helper upgrade native verifier refuses missing upgrade mode, wrong old pin and altered guard before Native reads',t=>{
 const scenarios=[
  f=>f.run(()=>{}, {previousHelperSha256:'f'.repeat(64)}),
  f=>f.run(()=>{}, {nextGuardSha256:'f'.repeat(64)}),
  f=>f.run(({newGuard})=>fs.appendFileSync(newGuard,'\n# swapped guard')),
  f=>{
   const prepared=JSON.parse(fs.readFileSync(f.f.prepared));
   delete prepared.issuerHelperUpgrade;
   f.f.put('new-prepared.json',prepared);
   return f.run();
  }
 ];
 for(const scenario of scenarios){
  const f=issuerHelperUpgradeNativeFixture(t);
  const {result,count}=scenario(f);
  assert.notEqual(result.status,0);
  assert.equal(count,0,'No Native query before all source and generation pins pass');
  assert.equal(result.stdout.includes('leaseToken'),false);
 }
});

function issuerUpgradeCandidateFixture(t){
 const f=sameOperationCandidateFixture(t);
 const sourceHelper=path.resolve('tools/platform/web-automation/Manage-CdpChromeSlotLease.ps1');
 const sourceGuard=path.resolve('tools/platform/web-automation/Assert-CdpEndpointIdentity.ps1');
 const oldHelper=f.put(path.join(f.root,'old-issuer','Manage-CdpChromeSlotLease.ps1'),
   "param([string]$Action)\n# source-only old helper\n");
 const oldGuard=f.put(path.join(f.root,'old-issuer','Assert-CdpEndpointIdentity.ps1'),'# source-only previous guard');
 const newHelper=f.put(path.join(f.root,'new-issuer','Manage-CdpChromeSlotLease.ps1'),fs.readFileSync(sourceHelper,'utf8'));
 const newGuard=f.put(path.join(f.root,'new-issuer','Assert-CdpEndpointIdentity.ps1'),fs.readFileSync(sourceGuard,'utf8'));
 const previous=JSON.parse(fs.readFileSync(f.priorFile));
 const next=JSON.parse(fs.readFileSync(f.bindingFile));
 const shell=f.put(path.join(f.root,'pwsh.exe'),'SYNTHETIC_FAKE_POWERSHELL_NEVER_EXECUTED');
 previous.currentIssuer.powershellSha256=hash(shell);
 next.currentIssuer.powershellSha256=hash(shell);
 Object.assign(previous.currentIssuer,{helperFile:oldHelper,helperSha256:hash(oldHelper),
   identityGuardFile:oldGuard,identityGuardSha256:hash(oldGuard)});
 Object.assign(next.currentIssuer,{helperFile:newHelper,helperSha256:hash(newHelper),
   identityGuardFile:newGuard,identityGuardSha256:hash(newGuard)});
 const mode='queue-owner-keep-target-before-registration/v1';
 next.targetLifecycle=mode;
 const upgrade={kind:'aicc-queue-current-issuer-helper-upgrade/v1',
   previousHelperSha256:hash(oldHelper),previousGuardSha256:hash(oldGuard),
   nextHelperSha256:hash(newHelper),nextGuardSha256:hash(newGuard),
   sourceHelperFile:sourceHelper,sourceHelperSha256:hash(sourceHelper),
   sourceGuardFile:sourceGuard,sourceGuardSha256:hash(sourceGuard),
   powershellSha256:previous.currentIssuer.powershellSha256,
   requiredArgument:'QueueOwnerRequestFile',targetLifecycle:mode};
 next.issuerHelperUpgrade=upgrade;
 f.put(f.priorFile,previous);f.put(f.bindingFile,next);
 const priorReceipt=JSON.parse(fs.readFileSync(f.priorReceipt));
 priorReceipt.bindingSha256=hash(f.priorFile);f.put(f.priorReceipt,priorReceipt);
 const prepared=JSON.parse(fs.readFileSync(f.prepared));
 prepared.issuerHelperUpgrade=upgrade;
 prepared.bindingSha256=hash(f.bindingFile);
 prepared.priorBindingSha256=hash(f.priorFile);
 prepared.priorReceiptSha256=hash(f.priorReceipt);
 f.put(f.prepared,prepared);
 const before=JSON.parse(fs.readFileSync(f.configFile));
 before.gptQueue.bindingSha256=hash(f.priorFile);
 f.put(f.configFile,before);
 f.put(path.join(f.root,'workspace-config.before.json'),before);
 const after=JSON.parse(fs.readFileSync(f.configDesiredFile));
 after.gptQueue.bindingSha256=hash(f.bindingFile);
 f.put(f.configDesiredFile,after);
 const graph=JSON.parse(fs.readFileSync(f.graphFile));
 graph.providers.find(p=>p.id==='workspace').files.find(x=>x.path===f.configFile).sha256=hash(f.configFile);
 f.put(f.graphFile,graph);
 const oldManifest=JSON.parse(fs.readFileSync(f.oldManifestFile));
 oldManifest.files['config.json']=hash(f.graphFile);
 oldManifest.releaseHash=oldManifest.files['config.json'];f.put(f.oldManifestFile,oldManifest);
 const future=structuredClone(graph);
 future.providers.find(p=>p.id==='workspace').files.find(x=>x.path===f.configFile).sha256=hash(f.configDesiredFile);
 f.put(path.join(f.gateway,'config.json'),future);
 const futureManifest=structuredClone(oldManifest);
 futureManifest.files['config.json']=hash(path.join(f.gateway,'config.json'));
 futureManifest.releaseHash=futureManifest.files['config.json'];
 f.put(path.join(f.gateway,'manifest.json'),futureManifest);
 const evidence=JSON.parse(fs.readFileSync(f.nativeEvidenceFile));
 evidence.previousBindingSha256=hash(f.priorFile);
 evidence.currentGraphSha256=hash(f.graphFile);
 f.put(f.nativeEvidenceFile,evidence);
 const readback={...f.readback,issuerHelperUpgrade:true,
   previousHelperSha256:hash(oldHelper),nextHelperSha256:hash(newHelper),
   nextGuardSha256:hash(newGuard)};
 f.put(f.candidate.queueNativeReadbackFile,readback);
 Object.assign(f.candidate,{
   queueUpgradeCurrentIssuerHelper:true,
   queuePreviousIssuerHelperSHA256:hash(oldHelper),
   queueNextIssuerHelperSHA256:hash(newHelper),
   queueNextIssuerGuardSHA256:hash(newGuard),
   configBeforeSHA256:hash(f.configFile),
   configDesiredSHA256:hash(f.configDesiredFile),
   oldGatewayConfigSHA256:hash(f.graphFile),
   oldGatewayManifestSHA256:hash(f.oldManifestFile),
   gatewayConfigSHA256:hash(path.join(f.gateway,'config.json')),
   queuePreviousBindingSHA256:hash(f.priorFile),
   queueNextBindingSHA256:hash(f.bindingFile),
   queuePreviousPreparedSHA256:hash(f.priorReceipt),
   queueOwnerPreparedSHA256:hash(f.prepared),
   nativeUpgradeEvidenceSHA256:hash(f.nativeEvidenceFile),
   queueNativeReadbackSHA256:hash(f.candidate.queueNativeReadbackFile)
 });
 f.refresh();
 const fake=JSON.parse(fs.readFileSync(f.fake));
 fake.nativeReadback=readback;f.put(f.fake,fake);
 const ctx=JSON.parse(fs.readFileSync(f.contextFile));
 Object.assign(ctx,{oldBindingSha:hash(f.priorFile),
   oldPreparedSha:hash(f.priorReceipt),
   ownerPreparedSha:hash(f.prepared),
   configSha:hash(f.configFile),
   gatewaySha:hash(f.graphFile),
   gatewayManifestSha:hash(f.oldManifestFile),
   upgradeSha:hash(f.nativeEvidenceFile)});
 f.put(f.contextFile,ctx);
 const start=fs.readFileSync(f.sourceHarness,'utf8');
 const marker='$RebindUnregisteredSameOperation=$true';
 assert.ok(start.includes(marker));
 const extra=[marker,'$UpgradeCurrentIssuerHelper=$true',
   "$ExpectedPriorIssuerHelperSha256='"+hash(oldHelper)+"'",
   "$ExpectedNextIssuerHelperSha256='"+hash(newHelper)+"'",
   "$ExpectedNextIssuerGuardSha256='"+hash(newGuard)+"'"].join('\n');
 f.put(f.sourceHarness,start.replace(marker,extra));
 return {...f,oldHelper,oldGuard,newHelper,newGuard,sourceHelper,sourceGuard,
   upgrade,readback};
}
test('helper upgrade candidate Apply contract checks old and new sibling/source pins without touching installed fixture',t=>{
 const f=issuerUpgradeCandidateFixture(t);
 const installedSHA=hash(f.configFile),graphSHA=hash(f.graphFile);
 const run=f.run();
 assert.equal(run.status,0,run.stderr||run.stdout||String(run.error));
 assert.equal(hash(f.configFile),installedSHA);
 assert.equal(hash(f.graphFile),graphSHA);
 const illegal=issuerUpgradeCandidateFixture(t);
 const illegalInstalledBefore=hash(illegal.configFile),illegalGraphBefore=hash(illegal.graphFile);
 illegal.candidate.queueNextIssuerHelperSHA256='0'.repeat(64);
 illegal.refresh();
 const denied=illegal.run();
 assert.notEqual(denied.status,0);
 assert.equal(hash(illegal.configFile),illegalInstalledBefore);
 assert.equal(hash(illegal.graphFile),illegalGraphBefore);
 assert.match(String(denied.stderr),/HOLD_ISSUER_HELPER_UPGRADE_/);
});
test('helper upgrade candidate Prepare seals exactly one rollback-capable generation without changing registry or owner config',t=>{
 const f=issuerUpgradeCandidateFixture(t);
 const before=hash(f.configFile),graph=hash(f.graphFile);
 const r=f.prepRun();
 assert.equal(r.status,0,r.stderr||r.stdout||String(r.error));
 const candidate=JSON.parse(fs.readFileSync(path.join(f.operation,'candidate.json')));
 assert.equal(candidate.queueRebindUnregisteredSameOperation,true);
 assert.equal(candidate.queueUpgradeCurrentIssuerHelper,true);
 assert.equal(candidate.queuePreviousIssuerHelperSHA256,hash(f.oldHelper));
 assert.equal(candidate.queueNextIssuerHelperSHA256,hash(f.newHelper));
 assert.equal(candidate.queueNextIssuerGuardSHA256,hash(f.newGuard));
 assert.equal(candidate.queueNativeReadbackSHA256,hash(candidate.queueNativeReadbackFile));
 assert.equal(hash(f.configFile),before);
 assert.equal(hash(f.graphFile),graph);
 assert.notEqual(f.prepRun().status,0,'preparer must stay create-once');
});

function combinedIssuerProviderFixture(t){
 const f=issuerUpgradeCandidateFixture(t),c=f.candidate;
 const provider='components/workspace-mcp/gpt-queue-provider.mjs';
 const integrity='components/workspace-mcp/runtime-integrity.mjs';
 const sourceProvider=path.resolve(provider);
 f.put(path.join(c.baseline,provider),'// synthetic previous provider');
 f.put(path.join(c.baseline,integrity),'// unchanged integrity');
 f.put(path.join(c.baseline,'.aicc-release.json'),{
  files:[{path:provider,sha256:hash(path.join(c.baseline,provider))}],
  gptQueueOverlay:{kind:'workspace-gpt-queue-overlay/v1'}});
 f.put(path.join(c.baseline,'workspace-drive-manifest.json'),{
  files:{[provider]:hash(path.join(c.baseline,provider))}});
 const backend=path.join(f.root,'combined-backend');
 fs.cpSync(c.baseline,backend,{recursive:true});
 f.put(path.join(backend,provider),fs.readFileSync(sourceProvider,'utf8'));
 const release=JSON.parse(fs.readFileSync(path.join(backend,'.aicc-release.json')));
 release.files[0].sha256=hash(path.join(backend,provider));
 f.put(path.join(backend,'.aicc-release.json'),release);
 f.put(path.join(backend,'workspace-drive-manifest.json'),{
  files:{[provider]:hash(path.join(backend,provider))}});
 function inventory(root){
  return fs.readdirSync(root,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{
   const file=path.join(e.parentPath,e.name);
   return {path:path.relative(root,file).split(path.sep).join('/'),sha256:hash(file),size:fs.statSync(file).size};
  });
 }
 const stageDir=path.join(f.root,'combined-stage');
 const beforeFile=f.put(path.join(stageDir,'inventory.before.json'),inventory(c.baseline));
 const desiredFile=f.put(path.join(stageDir,'inventory.desired.json'),inventory(backend));
 const changed=[provider,'.aicc-release.json','workspace-drive-manifest.json'];
 const stage={kind:'workspace-gpt-queue-source-stage/v1',status:'STAGED_NOT_INSTALLED',
  owner:'fixture-owner',baseline:c.baseline,backend,overlayMode:'installed-provider-only',
  actualChangedFiles:changed,installedConfigSHA256:hash(f.configFile),
  baselineProviderSHA256:hash(path.join(c.baseline,provider)),
  desiredProviderSHA256:hash(path.join(backend,provider)),
  installedReleaseSHA256:hash(path.join(c.baseline,'.aicc-release.json')),
  installedDriveManifestSHA256:hash(path.join(c.baseline,'workspace-drive-manifest.json')),
  inventoryBeforeSha256:hash(beforeFile),inventoryDesiredSha256:hash(desiredFile),
  sourcePins:[{path:sourceProvider,sha256:hash(sourceProvider)}]};
 const stageFile=f.put(path.join(stageDir,'stage.json'),stage);
 Object.assign(c,{backend,queueCombinedIssuerProviderUpdate:true,
  queueStageFile:stageFile,queueStageSHA256:hash(stageFile),changedFiles:changed,
  queueBackendManifestSHA256:stage.installedReleaseSHA256,
  queueDriveManifestSHA256:stage.installedDriveManifestSHA256,
  queueProviderUpdatePins:{installedConfigSHA256:stage.installedConfigSHA256,
   baselineProviderSHA256:stage.baselineProviderSHA256,desiredProviderSHA256:stage.desiredProviderSHA256,
   installedReleaseSHA256:stage.installedReleaseSHA256,
   installedDriveManifestSHA256:stage.installedDriveManifestSHA256,
   runtimeIntegritySHA256:hash(path.join(c.baseline,integrity))},
  gptQueueRecovery:{...c.gptQueueRecovery,inventoryBeforeFile:beforeFile,inventoryBeforeSHA256:hash(beforeFile)}});
 const graph=JSON.parse(fs.readFileSync(f.graphFile));
 const w=graph.providers.find(p=>p.id==='workspace');
 w.entrypoint=path.join(c.baseline,provider);w.args=[w.entrypoint];
 w.files.push({path:w.entrypoint,sha256:stage.baselineProviderSHA256});
 f.put(f.graphFile,graph);
 const oldManifest=JSON.parse(fs.readFileSync(f.oldManifestFile));
 oldManifest.files['config.json']=hash(f.graphFile);oldManifest.releaseHash=hash(f.graphFile);
 f.put(f.oldManifestFile,oldManifest);
 const future=structuredClone(graph),fw=future.providers.find(p=>p.id==='workspace');
 fw.entrypoint=path.join(backend,provider);fw.args=[fw.entrypoint];
 for(const pin of fw.files){if(pin.path.startsWith(c.baseline+path.sep)){
  pin.path=path.join(backend,path.relative(c.baseline,pin.path));pin.sha256=hash(pin.path);
 }}
 fw.files.find(p=>p.path===f.configFile).sha256=hash(f.configDesiredFile);
 f.put(path.join(f.gateway,'config.json'),future);
 const manifest=structuredClone(oldManifest);
 manifest.files['config.json']=hash(path.join(f.gateway,'config.json'));manifest.releaseHash=manifest.files['config.json'];
 f.put(path.join(f.gateway,'manifest.json'),manifest);
 c.oldGatewayConfigSHA256=hash(f.graphFile);c.oldGatewayManifestSHA256=hash(f.oldManifestFile);
 c.gatewayConfigSHA256=hash(path.join(f.gateway,'config.json'));
 const evidence=JSON.parse(fs.readFileSync(f.nativeEvidenceFile));
 evidence.currentGraphSha256=hash(f.graphFile);f.put(f.nativeEvidenceFile,evidence);
 c.nativeUpgradeEvidenceSHA256=hash(f.nativeEvidenceFile);f.refresh();
 const context=JSON.parse(fs.readFileSync(f.contextFile));
 Object.assign(context,{gatewaySha:hash(f.graphFile),gatewayManifestSha:hash(f.oldManifestFile),
  upgradeSha:hash(f.nativeEvidenceFile),releaseSha:stage.installedReleaseSHA256,driveSha:stage.installedDriveManifestSHA256});
 f.put(f.contextFile,context);
 const start=fs.readFileSync(f.sourceHarness,'utf8');
 f.put(f.sourceHarness,start.replace('$UpgradeCurrentIssuerHelper=$true',
  `$UpgradeCurrentIssuerHelper=$true\n$UpgradeIssuerAndProviderTogether=$true\n$StageReceipt='${stageFile.replaceAll("'","''")}'`));
 return {...f,stage,stageFile};
}

test('combined helper and exact provider delta validates and prepares without installed writes',t=>{
 const f=combinedIssuerProviderFixture(t),before=hash(f.configFile),graph=hash(f.graphFile);
 const result=f.run();assert.equal(result.status,0,result.stderr||result.stdout);
 const prepared=f.prepRun();assert.equal(prepared.status,0,prepared.stderr||prepared.stdout);
 const c=JSON.parse(fs.readFileSync(path.join(f.operation,'candidate.json')));
 assert.equal(c.queueCombinedIssuerProviderUpdate,true);
 assert.equal(c.backend,f.stage.backend);assert.equal(c.baseline,f.stage.baseline);
 assert.deepEqual(c.changedFiles.sort(),f.stage.actualChangedFiles.sort());
 assert.equal(hash(f.configFile),before);assert.equal(hash(f.graphFile),graph);
});

test('combined helper/provider rejects altered pins, extra delta, owner and noncombined backend change',t=>{
 for(const mode of ['pin','extra','owner','opt-in','helper','schema']){
  const f=combinedIssuerProviderFixture(t),before=hash(f.configFile);
  if(mode==='pin')f.candidate.queueProviderUpdatePins.desiredProviderSHA256='0'.repeat(64);
  if(mode==='extra')f.candidate.changedFiles.push('components/workspace-mcp/server.mjs');
  if(mode==='owner'){f.stage.owner='foreign';f.put(f.stageFile,f.stage);f.candidate.queueStageSHA256=hash(f.stageFile);}
  if(mode==='opt-in')delete f.candidate.queueCombinedIssuerProviderUpdate;
  if(mode==='helper')f.candidate.queueUpgradeCurrentIssuerHelper=false;
  if(mode==='schema')f.candidate.toolHash='0'.repeat(64);
  f.refresh();const result=f.run();assert.notEqual(result.status,0,mode);
  assert.equal(hash(f.configFile),before);
 }
});
