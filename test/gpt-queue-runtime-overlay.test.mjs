import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {buildGptQueueRuntimeOverlay,GPT_QUEUE_OVERLAY_FILES,GPT_QUEUE_PROVIDER_ONLY_DELTA} from '../components/workspace-mcp/gpt-queue-runtime-overlay.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=Object.fromEntries(GPT_QUEUE_OVERLAY_FILES.map(p=>[p,fs.readFileSync(path.join(root,p),'utf8')]));
function fixture(){
  return {
    'components/workspace-mcp/server.mjs':[
      "import { createCodexCliExecutor } from './codex-cli-provider.mjs';",
      '  if (codexCli) codexCliExecutors.add(codexCli);',
      '  const writerAuthorizer = options.writerAuthorizer ?? null;',
      '  if (!personalReadFetch && config.webManagement?.enabled === true) {',
      '  }',
      '        codexCliAvailable: config.codexCli?.enabled === true',
      'INSTALLED_PROCESS_EXIT_FIX_PRESERVE_EXACTLY'
    ].join('\n'),
    'components/workspace-mcp/input-schemas.mjs':'EXISTING_SCHEMA\n  aicc_web_management_start: {\n',
    'components/workspace-mcp/tool-manifest.mjs':'const PERSONAL_EXCLUDED_TOOLS = new Set([\nEXISTING_TOOL_FILTER\n  return tools\n',
    'components/workspace-mcp/runtime-integrity.mjs':"  'components/workspace-mcp/codex-cli-provider.mjs',\n  'installed/platform-ops.mjs',\n",
    'components/workspace-mcp/runtime-marker.mjs':'codexCliAvailable: config.codexCli?.enabled === true\nEXISTING_RUNTIME_MARKER',
    'src/workspace-mcp.mjs':'codexCliAvailable: config.codexCli?.enabled === true\ncodexCli: config?.codexCli?.enabled === true\nEXISTING_STATUS',
    'tools/platform/chatgpt/Prepare-AiccWorkspacePublish.mjs':'codexCliAvailable: runtime.hostCapabilities?.codexCli === true\ncodexCliAvailable: runtime.hostCapabilities?.codexCli === true\nEXISTING_PUBLICATION'
  };
}
test('queue overlay adds exact five leased tools while preserving installed lifecycle and metadata code',()=>{
  const before=fixture(),original=structuredClone(before),out=buildGptQueueRuntimeOverlay(before,source);
  assert.deepEqual(before,original);
  assert.deepEqual(Object.keys(out),GPT_QUEUE_OVERLAY_FILES);
  assert.ok(out['components/workspace-mcp/server.mjs'].includes('INSTALLED_PROCESS_EXIT_FIX_PRESERVE_EXACTLY'));
  assert.ok(out['components/workspace-mcp/server.mjs'].includes('  const writerAuthorizer = options.writerAuthorizer ?? null;'));
  assert.equal((out['components/workspace-mcp/server.mjs'].match(/server\.registerTool\('aicc_gpt_queue_/g)||[]).length,5);
  assert.ok(out['components/workspace-mcp/server.mjs'].includes("withLease('write'"));
  assert.ok(out['components/workspace-mcp/server.mjs'].includes('!personalReadFetch && config.gptQueue?.enabled === true'));
  assert.ok(out['components/workspace-mcp/runtime-integrity.mjs'].includes("'installed/platform-ops.mjs'"));
  for(const [p,label] of [['src/workspace-mcp.mjs','EXISTING_STATUS'],['components/workspace-mcp/runtime-marker.mjs','EXISTING_RUNTIME_MARKER'],['tools/platform/chatgpt/Prepare-AiccWorkspacePublish.mjs','EXISTING_PUBLICATION']])assert.ok(out[p].includes(label));
  assert.equal(out['components/workspace-mcp/gpt-queue-provider.mjs'],source['components/workspace-mcp/gpt-queue-provider.mjs'].replace(/\r\n/g,'\n'));
});
test('queue overlay rejects ambiguous installed anchors and already installed queue code',()=>{
  for(const mode of ['missing','duplicate','already-present','provider-present']){
    const before=fixture();
    if(mode==='missing')before['components/workspace-mcp/server.mjs']=before['components/workspace-mcp/server.mjs'].replace('  if (codexCli) codexCliExecutors.add(codexCli);','different installed context');
    if(mode==='duplicate')before['components/workspace-mcp/input-schemas.mjs']+='  aicc_web_management_start: {';
    if(mode==='already-present')before['src/workspace-mcp.mjs']+='\ngptQueueAvailable: true';
    if(mode==='provider-present')before['components/workspace-mcp/gpt-queue-provider.mjs']='existing installed provider';
    const snapshot=structuredClone(before);
    assert.throws(()=>buildGptQueueRuntimeOverlay(before,source),/QUEUE_OVERLAY_/);
    assert.deepEqual(before,snapshot);
  }
});
test('queue overlay refuses changed source registration boundaries without touching the installed texts',()=>{
  const before=fixture(),desired=structuredClone(source);
  desired['components/workspace-mcp/server.mjs']=desired['components/workspace-mcp/server.mjs'].replace('  if (gptQueue) {','  if (differentQueue) {');
  assert.throws(()=>buildGptQueueRuntimeOverlay(before,desired),/QUEUE_OVERLAY_SOURCE_BOUNDARY_CHANGED/);
});
test('already-installed queue provider-only mode preserves all non-provider bytes and the five-tool schema',()=>{
 const provider='components/workspace-mcp/gpt-queue-provider.mjs';
 const installed={...source,[provider]:'// REVIEWED_OLD_PROVIDER\n'+source[provider]};
 const before=structuredClone(installed);
 const updated=buildGptQueueRuntimeOverlay(installed,source,{mode:'installed-provider-only'});
 assert.deepEqual(installed,before);
 assert.deepEqual(Object.keys(updated),GPT_QUEUE_OVERLAY_FILES);
 assert.equal(updated[provider],source[provider].replace(/\r\n/g,'\n'));
 for(const file of GPT_QUEUE_OVERLAY_FILES.filter(f=>f!==provider))
   assert.equal(updated[file],installed[file],file);
 const differences=Object.keys(updated).filter(k=>updated[k]!==installed[k]);
 assert.deepEqual(differences,[provider]);
 assert.deepEqual(GPT_QUEUE_PROVIDER_ONLY_DELTA,[provider,'.aicc-release.json','workspace-drive-manifest.json']);
 assert.throws(()=>buildGptQueueRuntimeOverlay(installed,source,{mode:'initial-install'}),/QUEUE_OVERLAY_ALREADY_PRESENT/);
});
test('provider-only mode rejects partial or unreviewed installed baseline and a no-op update',()=>{
 const provider='components/workspace-mcp/gpt-queue-provider.mjs';
 for(const mode of ['missing-server','missing-schema','unknown-provider','missing-integrity','missing-file','same-provider']){
  const installed={...source,[provider]:'// REVIEWED_OLD_PROVIDER\n'+source[provider]};
  if(mode==='missing-server')installed['components/workspace-mcp/server.mjs']='UNREVIEWED_OLD_SERVER';
  if(mode==='missing-schema')installed['components/workspace-mcp/input-schemas.mjs']='UNREVIEWED_OLD_SCHEMA';
  if(mode==='unknown-provider')installed[provider]='UNKNOWN_PROVIDER';
  if(mode==='missing-integrity')installed['components/workspace-mcp/runtime-integrity.mjs']='UNKNOWN_INTEGRITY';
  if(mode==='missing-file')delete installed['src/lib/windows-pwsh.mjs'];
  if(mode==='same-provider')installed[provider]=source[provider];
  const before=structuredClone(installed);
  assert.throws(()=>buildGptQueueRuntimeOverlay(installed,source,{mode:'installed-provider-only'}),/QUEUE_OVERLAY_/);
  assert.deepEqual(installed,before);
 }
 assert.throws(()=>buildGptQueueRuntimeOverlay({...source},source,{mode:'unreviewed-mode'}),/QUEUE_OVERLAY_EXPLICIT_MODE_REQUIRED/);
});
const shaFile=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const writeJson=(p,value)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(value,null,2)+'\n');return p;};
function fakeInstalledStage(t){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-queue-provider-update-test-'));
 t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const owner=path.join(temp,'.ai-control-center');
 const baseline=path.join(owner,'releases','workspace','installed');
 const stageSource=path.join(root,'tools/platform/workspace-mcp/Prepare-AiccGptQueueRuntime.ps1');
 const provider='components/workspace-mcp/gpt-queue-provider.mjs';
 const tracked=[];
 for(const relative of GPT_QUEUE_OVERLAY_FILES){
  const full=path.join(baseline,relative);
  fs.mkdirSync(path.dirname(full),{recursive:true});
  fs.writeFileSync(full,relative===provider?'// REVIEWED_PREVIOUS_PROVIDER\n'+source[relative]:source[relative]);
  tracked.push({path:relative,sha256:shaFile(full),size:fs.statSync(full).size});
 }
 const releaseFile=writeJson(path.join(baseline,'.aicc-release.json'),{
  schemaVersion:1,files:tracked,fileCount:tracked.length,
  totalBytes:tracked.reduce((n,row)=>n+row.size,0),
  gptQueueOverlay:{kind:'workspace-gpt-queue-overlay/v1'}
 });
 const driveFile=writeJson(path.join(baseline,'workspace-drive-manifest.json'),{
  files:Object.fromEntries(tracked.map(row=>[row.path,row.sha256])),baseline,release:baseline
 });
 const binding=writeJson(path.join(owner,'asset-control','sealed-binding.json'),{kind:'fake-owner-binding'});
 const configFile=writeJson(path.join(owner,'workspace-mcp','config.json'),{
  surfaceProfile:'business-full',
  gptQueue:{enabled:true,bindingFile:binding,bindingSha256:shaFile(binding)}
 });
 writeJson(path.join(owner,'runtime','components.json'),{
  components:{workspace:{location:'managed',releaseRoot:baseline,runtime:process.execPath}}
 });
 const psQuote=v=>"'"+v.replaceAll("'","''")+"'";
 let harness=fs.readFileSync(stageSource,'utf8');
 const before=harness;
 harness=harness.replace(/^\$sourceRoot=.*$/m,()=>'$sourceRoot='+psQuote(root));
 harness=harness.replace(/^\$ownerRoot=.*$/m,()=>'$ownerRoot='+psQuote(owner));
 assert.notEqual(harness,before);
 const harnessFile=path.join(temp,'isolated-stage.ps1');
 fs.writeFileSync(harnessFile,harness);
 function run(label='pass',options={}){
  const operation=path.join(owner,'asset-control','stage-'+label);
  const args=['-NoLogo','-NoProfile','-NonInteractive','-File',harnessFile,
   '-OperationDirectory',operation];
  if(options.mode!==false)args.push('-UpdateInstalledProvider');
  args.push('-ExpectedInstalledConfigSha256',options.badConfig?'0'.repeat(64):shaFile(configFile),
   '-ExpectedInstalledProviderSha256',options.badProvider?'0'.repeat(64):shaFile(path.join(baseline,provider)),
   '-ExpectedSourceProviderSha256',options.badSource?'0'.repeat(64):shaFile(path.join(root,provider)),
   '-ExpectedInstalledReleaseSha256',shaFile(releaseFile),
   '-ExpectedInstalledDriveManifestSha256',shaFile(driveFile));
  if(options.reconcile){
   const previous=path.join(owner,'asset-control','previous-candidate','candidate.json');
   const registry=path.join(owner,'runtime','components.json');
   const gateway=path.join(owner,'releases','unified-mcp','current');
   args.push('-ReconcileInstalledBaseline',
    '-BaselineEvidenceReceiptFile',previous,
    '-ExpectedBaselineEvidenceReceiptSha256',options.badReceiptSha?'0'.repeat(64):shaFile(previous),
    '-ExpectedInstalledRegistrySha256',shaFile(registry),
    '-ExpectedInstalledGatewayConfigSha256',options.badGraphSha?'0'.repeat(64):shaFile(path.join(gateway,'config.json')),
    '-ExpectedInstalledGatewayManifestSha256',shaFile(path.join(gateway,'manifest.json')));
  }
  const processResult=spawnSync('pwsh',args,{encoding:'utf8',timeout:120000,
   windowsHide:true,env:{...process.env,CODEX_THREAD_ID:'synthetic-owner'}});
  return {...processResult,operation};
 }
 return {owner,baseline,provider,configFile,releaseFile,driveFile,run};
}
function fakeReconciledStage(t){
 const f=fakeInstalledStage(t);
 const rel='components/workspace-mcp/web-management-provider.mjs';
 const file=path.join(f.baseline,rel);
 fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,'EXACT_REVIEWED_WEB_MANAGEMENT_PROVIDER_BYTES');
 const release=JSON.parse(fs.readFileSync(f.releaseFile,'utf8'));
 release.files.push({path:rel,sha256:'e'.repeat(64),size:fs.statSync(file).size-2});
 release.fileCount=release.files.length;
 release.totalBytes=release.files.reduce((n,row)=>n+row.size,0);
 writeJson(f.releaseFile,release);
 const drive=JSON.parse(fs.readFileSync(f.driveFile,'utf8'));
 drive.files[rel]='f'.repeat(64);
 writeJson(f.driveFile,drive);
 const gateway=path.join(f.owner,'releases','unified-mcp','current');
 const graph=writeJson(path.join(gateway,'config.json'),{
  hostControl:'task-owned-v1',providers:[
   {id:'workspace',files:[{path:file,sha256:shaFile(file)}]},
   {id:'native',files:[]},{id:'host',files:[]}]
 });
 writeJson(path.join(gateway,'manifest.json'),{files:{'config.json':shaFile(graph)}});
 const registry=path.join(f.owner,'runtime','components.json');
 writeJson(registry,{components:{
  workspace:{location:'managed',releaseRoot:f.baseline,runtime:process.execPath},
  'unified-mcp':{location:'managed',releaseRoot:gateway}
 }});
 const inventory=[];
 function walk(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   const full=path.join(dir,entry.name);
   if(entry.isDirectory())walk(full);
   else inventory.push({path:path.relative(f.baseline,full).replaceAll(path.sep,'/'),
    sha256:shaFile(full),size:fs.statSync(full).size});
  }
 }
 walk(f.baseline);
 const priorRoot=path.join(f.owner,'asset-control','previous-candidate');
 const priorInventory=writeJson(path.join(priorRoot,'inventory.before.json'),inventory);
 const receipt=writeJson(path.join(priorRoot,'candidate.json'),{
  kind:'workspace-gpt-queue-owner-replacement',status:'PREPARED_NOT_ACTIVE',
  baseline:f.baseline,backend:f.baseline,configDesiredSHA256:shaFile(f.configFile),
  queueBackendManifestSHA256:shaFile(f.releaseFile),
  queueDriveManifestSHA256:shaFile(f.driveFile),
  gptQueueRecovery:{inventoryBeforeFile:priorInventory,inventoryBeforeSHA256:shaFile(priorInventory)}
 });
 const prepared=writeJson(path.join(priorRoot,'prepared.json'),{
  status:'VALIDATED_NOT_ACTIVE',candidateReceipt:receipt,candidateSHA256:shaFile(receipt)});
 return {...f,rel,file,graph,gateway,registry,receipt,prepared,priorInventory,
  runReconcile:(label,options={})=>f.run(label,{reconcile:true,...options})};
}
test('existing installed provider-only stage writes immutable three-file candidate under isolated fake owner',
 {skip:process.platform!=='win32'},t=>{
 const f=fakeInstalledStage(t),configBefore=shaFile(f.configFile),
  oldProvider=shaFile(path.join(f.baseline,f.provider));
 const result=f.run();
 assert.equal(result.status,0,result.stderr||result.stdout);
 const stage=JSON.parse(fs.readFileSync(path.join(result.operation,'stage.json'),'utf8'));
 assert.equal(stage.overlayMode,'installed-provider-only');
 assert.deepEqual([...stage.actualChangedFiles].sort(),[...GPT_QUEUE_PROVIDER_ONLY_DELTA].sort());
 assert.equal(stage.installedConfigSHA256,configBefore);
 assert.equal(stage.baselineProviderSHA256,oldProvider);
 assert.equal(stage.desiredProviderSHA256,shaFile(path.join(root,f.provider)));
 for(const relative of GPT_QUEUE_OVERLAY_FILES.filter(p=>p!==f.provider))
  assert.equal(shaFile(path.join(stage.baseline,relative)),
   shaFile(path.join(stage.backend,relative)),relative);
 assert.equal(shaFile(f.configFile),configBefore);
 assert.equal(shaFile(path.join(f.baseline,f.provider)),oldProvider);
 assert.notEqual(f.run().status,0,'create-once stage cannot be silently repeated');
});
test('isolated provider stage refuses old-mode, unknown baseline/source/config SHA and unrelated installed drift',
 {skip:process.platform!=='win32'},t=>{
 for(const mode of ['no-opt-in','bad-source','bad-config','bad-provider','other-file-modified']){
  const f=fakeInstalledStage(t);
  if(mode==='other-file-modified')
   fs.appendFileSync(path.join(f.baseline,'components/workspace-mcp/server.mjs'),
    '\nUNREVIEWED_UNPINNED_BACKEND_CODE');
  const options={mode:mode!=='no-opt-in',badSource:mode==='bad-source',
   badConfig:mode==='bad-config',badProvider:mode==='bad-provider'};
  const result=f.run(mode,options);
  assert.notEqual(result.status,0,mode);
  assert.equal(fs.existsSync(path.join(result.operation,'stage.json')),false,mode);
 }
});
test('existing updater exact provider-only inventory gate accepts reviewed stage and rejects other files',
 {skip:process.platform!=='win32'},t=>{
 function fixture(){
  const f=fakeInstalledStage(t),generated=f.run('runtime');
  assert.equal(generated.status,0,generated.stderr||generated.stdout);
  const receiptFile=path.join(generated.operation,'stage.json');
  const stage=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
  const relative='components/workspace-mcp/runtime-integrity.mjs';
  const candidate={
   queueProviderOnlyUpdate:true,queueStageFile:receiptFile,
   baseline:stage.baseline,backend:stage.backend,
   configBeforeSHA256:shaFile(f.configFile),configDesiredSHA256:shaFile(f.configFile),
   changedFiles:stage.actualChangedFiles,
   queueProviderUpdatePins:{
    installedConfigSHA256:shaFile(f.configFile),
    baselineProviderSHA256:shaFile(path.join(stage.baseline,f.provider)),
    desiredProviderSHA256:shaFile(path.join(stage.backend,f.provider)),
    installedReleaseSHA256:shaFile(path.join(stage.baseline,'.aicc-release.json')),
    installedDriveManifestSHA256:shaFile(path.join(stage.baseline,'workspace-drive-manifest.json')),
    runtimeIntegritySHA256:shaFile(path.join(stage.baseline,relative))
   }
  };
  const runtimeSource=fs.readFileSync(path.join(root,
   'tools/platform/workspace-mcp/GptQueueRuntimeDeployment.ps1'),'utf8');
  const start=runtimeSource.indexOf('function Assert-GptQueueProviderOnlyStage(');
  const end=runtimeSource.indexOf('function Assert-GptQueueRuntimeCandidate(',start);
  assert.ok(start>=0&&end>start);
  const functions=runtimeSource.slice(start,end);
  const harness=path.join(f.owner,'asset-control','fake-runtime-verify.ps1');
  const command=[
   'param([string]$CandidatePath)',
   "$ErrorActionPreference='Stop'",
   "function Read([string]$p){Get-Content -LiteralPath $p -Raw|ConvertFrom-Json -AsHashtable -DateKind String}",
   "function Hash([string]$p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}",
   "function Same($a,$b){($a|ConvertTo-Json -Compress -Depth 50) -ceq ($b|ConvertTo-Json -Compress -Depth 50)}",
   functions,
   '$candidate=Read $CandidatePath',
   '$stage=Read $candidate.queueStageFile',
   'Assert-GptQueueProviderOnlyStage $candidate $stage',
   "'EXACT_PROVIDER_UPDATE_GATE_PASSED'"
  ].join('\n')+'\n';
  fs.writeFileSync(harness,command);
  const candidatePath=path.join(f.owner,'asset-control','runtime-candidate.json');
  function verify(){
   writeJson(candidatePath,candidate);
   return spawnSync('pwsh',['-NoLogo','-NoProfile','-NonInteractive','-File',
    harness,'-CandidatePath',candidatePath],
    {encoding:'utf8',timeout:60000,windowsHide:true});
  }
  return {...f,candidate,stage,receiptFile,verify};
 }
 const good=fixture(),result=good.verify();
 assert.equal(result.status,0,result.stderr||result.stdout);
 assert.match(result.stdout,/EXACT_PROVIDER_UPDATE_GATE_PASSED/);
 for(const mode of ['wrong-source-sha','unexpected-candidate-file','unknown-staged-mode','other-backend-change','installed-release-drift']){
  const f=fixture();
  if(mode==='wrong-source-sha')f.candidate.queueProviderUpdatePins.desiredProviderSHA256='0'.repeat(64);
  if(mode==='unexpected-candidate-file')f.candidate.changedFiles.push('components/workspace-mcp/server.mjs');
  if(mode==='unknown-staged-mode'){
   f.stage.overlayMode='unreviewed';writeJson(f.receiptFile,f.stage);
  }
  if(mode==='other-backend-change')
   fs.appendFileSync(path.join(f.stage.backend,'components/workspace-mcp/server.mjs'),
    '\nUNREVIEWED_FILE_EDIT');
  if(mode==='installed-release-drift')
   fs.appendFileSync(path.join(f.stage.baseline,'.aicc-release.json'),'\nUNREVIEWED_METADATA');
  const denied=f.verify();
  assert.notEqual(denied.status,0,mode);
  assert.doesNotMatch(String(denied.stdout),/EXACT_PROVIDER_UPDATE_GATE_PASSED/);
 }
});
test('queue stage, candidate preparer and runtime verifier remain valid PowerShell without execution',
 {skip:process.platform!=='win32'},()=>{
 for(const rel of [
  'tools/platform/workspace-mcp/Prepare-AiccGptQueueRuntime.ps1',
  'tools/platform/workspace-mcp/Prepare-AiccGptQueueDeployment.ps1',
  'tools/platform/workspace-mcp/GptQueueRuntimeDeployment.ps1'
 ]){
  const file=path.join(root,rel).replaceAll("'","''");
  const script="$tokens=$null;$errors=$null;"+
   "[System.Management.Automation.Language.Parser]::ParseFile('"+file+
   "',[ref]$tokens,[ref]$errors)|Out-Null;"+
   "if($errors.Count){$errors|ForEach-Object {$_.Message};exit 1};'PARSE_OK'";
  const r=spawnSync('pwsh',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],
   {encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(r.status,0,rel+': '+r.stderr+' '+r.stdout);
  assert.match(r.stdout,/PARSE_OK/);
 }
});
test('reviewed baseline reconciliation stages only provider and manifests, preserving installed web provider bytes',
 {skip:process.platform!=='win32'},t=>{
 const f=fakeReconciledStage(t),baselineWeb=shaFile(f.file),
  baselineConfig=shaFile(f.configFile),releaseBefore=shaFile(f.releaseFile),
  driveBefore=shaFile(f.driveFile);
 const run=f.runReconcile('reviewed-pass');
 assert.equal(run.status,0,run.stderr||run.stdout);
 const stage=JSON.parse(fs.readFileSync(path.join(run.operation,'stage.json'),'utf8'));
 assert.equal(stage.overlayMode,'installed-provider-only');
 assert.equal(stage.baselineReconciliation.kind,'workspace-provider-baseline-reconciliation/v1');
 assert.equal(stage.baselineReconciliation.priorReceiptSHA256,shaFile(f.receipt));
 assert.deepEqual([...stage.actualChangedFiles].sort(),[...GPT_QUEUE_PROVIDER_ONLY_DELTA].sort());
 assert.equal(shaFile(path.join(stage.backend,f.rel)),baselineWeb);
 assert.equal(shaFile(f.file),baselineWeb);
 assert.equal(shaFile(f.configFile),baselineConfig);
 assert.equal(shaFile(f.releaseFile),releaseBefore);
 assert.equal(shaFile(f.driveFile),driveBefore);
 const newRelease=JSON.parse(fs.readFileSync(path.join(stage.backend,'.aicc-release.json'),'utf8'));
 const newDrive=JSON.parse(fs.readFileSync(path.join(stage.backend,'workspace-drive-manifest.json'),'utf8'));
 assert.equal(newRelease.files.find(r=>r.path===f.rel).sha256,baselineWeb);
 assert.equal(newDrive.files[f.rel],baselineWeb);
 assert.deepEqual(newRelease.gptQueueOverlay.baselineReconciliation,stage.baselineReconciliation);
 assert.deepEqual(newDrive.gptQueueOverlay.baselineReconciliation,stage.baselineReconciliation);
 assert.notEqual(f.runReconcile('reviewed-pass').status,0,'same operation cannot stage twice');
});
test('reviewed baseline reconciliation rejects unsealed, mismatched graph and other drift',
 {skip:process.platform!=='win32'},t=>{
 for(const mode of ['missing-opt-in','wrong-prior-receipt','wrong-graph-sha',
   'wrong-current-graph-pin','missing-registered-graph-pin',
   'second-release-file-mismatch','unsealed-new-file','prior-receipt-owner-mismatch']){
  const f=fakeReconciledStage(t),opts={};
  if(mode==='missing-opt-in')opts.reconcile=false;
  if(mode==='wrong-prior-receipt')opts.badReceiptSha=true;
  if(mode==='wrong-graph-sha')opts.badGraphSha=true;
  if(mode==='wrong-current-graph-pin'){
   const graph=JSON.parse(fs.readFileSync(f.graph,'utf8'));
   graph.providers[0].files[0].sha256='1'.repeat(64);
   writeJson(f.graph,graph);
   writeJson(path.join(f.gateway,'manifest.json'),{files:{'config.json':shaFile(f.graph)}});
  }
  if(mode==='missing-registered-graph-pin'){
   const graph=JSON.parse(fs.readFileSync(f.graph,'utf8'));
   graph.providers[0].files=[];
   writeJson(f.graph,graph);
   writeJson(path.join(f.gateway,'manifest.json'),{files:{'config.json':shaFile(f.graph)}});
  }
  if(mode==='unsealed-new-file'){
   fs.writeFileSync(path.join(f.baseline,'unreviewed-new-file.mjs'),'UNSEALED_NEW_FILE');
  }
  if(mode==='second-release-file-mismatch'){
   fs.appendFileSync(path.join(f.baseline,'components/workspace-mcp/server.mjs'),
    '\nSECOND_UNREVIEWED_INSTALLED_CHANGE');
  }
  if(mode==='prior-receipt-owner-mismatch'){
   const receipt=JSON.parse(fs.readFileSync(f.receipt,'utf8'));
   receipt.backend=path.join(f.owner,'releases','workspace','other-owner');
   writeJson(f.receipt,receipt);
  }
  const run=f.run('reviewed-'+mode,{reconcile:mode!=='missing-opt-in',...opts});
  assert.notEqual(run.status,0,mode);
  assert.equal(fs.existsSync(path.join(run.operation,'stage.json')),false,mode);
 }
});
test('exact source verifier accepts sealed previous inventory and rejects post-stage graph or receipt drift',
 {skip:process.platform!=='win32'},t=>{
 const f=fakeReconciledStage(t),run=f.runReconcile('verifier');
 assert.equal(run.status,0,run.stderr||run.stdout);
 const stagePath=path.join(run.operation,'stage.json');
 const sourceVerifier=fs.readFileSync(path.join(root,
  'tools/platform/workspace-mcp/Verify-AiccGptQueueRuntime.mjs'),'utf8');
 const start=sourceVerifier.indexOf('function verifyReconciledBaseline(');
 const end=sourceVerifier.indexOf('const before=inventory(',start);
 assert.ok(start>=0&&end>start);
 const actualFunction=sourceVerifier.slice(start,end);
 const harness=[
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import {createHash} from 'node:crypto';",
  "import {isDeepStrictEqual} from 'node:util';",
  "const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));",
  "const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');",
  "const plain=p=>{if(!path.isAbsolute(p)||fs.lstatSync(p).isSymbolicLink())throw Error('LINKED_SOURCE_HOLD');};",
  "const receipt=read(process.argv[1]);",
  "const dir=path.dirname(process.argv[1]);",
  "const before=new Map(read(path.join(dir,'inventory.before.json')).map(x=>[x.path,x]));",
  "const after=new Map(read(path.join(dir,'inventory.desired.json')).map(x=>[x.path,x]));",
  actualFunction,
  "const result=verifyReconciledBaseline(before,after);",
  "if(result?.path!=='components/workspace-mcp/web-management-provider.mjs')throw Error('INCORRECT_PROVENANCE');",
  "console.log('RECONCILED_VERIFIER_PASSED');"
 ].join('\n');
 const verify=()=>spawnSync(process.execPath,['--input-type=module','-e',harness,stagePath],
  {encoding:'utf8',timeout:30000,windowsHide:true});
 let v=verify();assert.equal(v.status,0,v.stderr||v.stdout);
 assert.match(v.stdout,/RECONCILED_VERIFIER_PASSED/);
 const graph=JSON.parse(fs.readFileSync(f.graph,'utf8'));
 graph.providers[0].files[0].sha256='0'.repeat(64);
 writeJson(f.graph,graph);
 v=verify();assert.notEqual(v.status,0,'graph mismatch must be HOLD');
});
test('exact Runtime provider-only validation requires unchanged sealed receipt and candidate proof',
 {skip:process.platform!=='win32'},t=>{
 const f=fakeReconciledStage(t),run=f.runReconcile('runtime-reconciled');
 assert.equal(run.status,0,run.stderr||run.stdout);
 const stagePath=path.join(run.operation,'stage.json');
 const stage=JSON.parse(fs.readFileSync(stagePath,'utf8'));
 const candidate={
  queueProviderOnlyUpdate:true,queueStageFile:stagePath,
  queueProviderBaselineReconciliation:stage.baselineReconciliation,
  baseline:stage.baseline,backend:stage.backend,
  changedFiles:stage.actualChangedFiles,
  configBeforeSHA256:shaFile(f.configFile),configDesiredSHA256:shaFile(f.configFile),
  queueProviderUpdatePins:{
   installedConfigSHA256:shaFile(f.configFile),
   baselineProviderSHA256:stage.baselineProviderSHA256,
   desiredProviderSHA256:stage.desiredProviderSHA256,
   installedReleaseSHA256:stage.installedReleaseSHA256,
   installedDriveManifestSHA256:stage.installedDriveManifestSHA256,
   runtimeIntegritySHA256:shaFile(path.join(stage.baseline,
    'components/workspace-mcp/runtime-integrity.mjs'))
  }
 };
 const psSource=fs.readFileSync(path.join(root,
  'tools/platform/workspace-mcp/GptQueueRuntimeDeployment.ps1'),'utf8');
 const begin=psSource.indexOf('function Assert-GptQueueProviderOnlyStage(');
 const stop=psSource.indexOf('function Assert-GptQueueRuntimeCandidate(',begin);
 assert.ok(begin>=0&&stop>begin);
 const script=[
  'param([string]$CandidatePath)',
  "$ErrorActionPreference='Stop'",
  "function Read([string]$p){Get-Content -LiteralPath $p -Raw|ConvertFrom-Json -AsHashtable -DateKind String}",
  "function Hash([string]$p){(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()}",
  "function Same($a,$b){($a|ConvertTo-Json -Compress -Depth 80) -ceq ($b|ConvertTo-Json -Compress -Depth 80)}",
  psSource.slice(begin,stop),
  '$candidate=Read $CandidatePath',
  '$registryFile=$candidate.queueProviderBaselineReconciliation.registryFile',
  '$stage=Read $candidate.queueStageFile',
  'Assert-GptQueueProviderOnlyStage $candidate $stage',
  "'PROVIDER_BASELINE_RUNTIME_GATE_PASSED'"
 ].join('\n');
 const harness=path.join(f.owner,'asset-control','verify-runtime-reconciled.ps1');
 fs.writeFileSync(harness,script);
 const candidateFile=path.join(f.owner,'asset-control','fake-candidate-reconciled.json');
 const check=()=>{
  writeJson(candidateFile,candidate);
  return spawnSync('pwsh',['-NoLogo','-NoProfile','-NonInteractive',
   '-File',harness,'-CandidatePath',candidateFile],{encoding:'utf8',timeout:60000,windowsHide:true});
 };
 let result=check();
 assert.equal(result.status,0,result.stderr||result.stdout);
 assert.match(result.stdout,/PROVIDER_BASELINE_RUNTIME_GATE_PASSED/);
 candidate.queueProviderBaselineReconciliation={...candidate.queueProviderBaselineReconciliation,
  actualFileSHA256:'0'.repeat(64)};
 result=check();assert.notEqual(result.status,0);
});
