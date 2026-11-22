import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {isDeepStrictEqual} from 'node:util';
import {buildGptQueueRuntimeOverlay,GPT_QUEUE_OVERLAY_FILES} from '../../../components/workspace-mcp/gpt-queue-runtime-overlay.mjs';

const [receiptPath]=process.argv.slice(2);
if(!receiptPath||process.argv.length!==3||!path.isAbsolute(receiptPath))throw Error('Exact staging receipt required');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function plain(file,directory=false){
  if(!path.isAbsolute(file))throw Error('Absolute staging path required');
  for(let p=path.resolve(file);;p=path.dirname(p)){
    const s=fs.lstatSync(p);if(s.isSymbolicLink())throw Error('Linked candidate refused');
    if(p===path.resolve(file)&&(directory?!s.isDirectory():!s.isFile()))throw Error('Candidate kind differs');
    if(p===path.dirname(p))break;
  }
}
plain(receiptPath);
const receipt=read(receiptPath);
if(receipt.kind!=='workspace-gpt-queue-source-stage/v1'||receipt.status!=='STAGED_NOT_INSTALLED'||
   receipt.activeWrites!==0||receipt.installed!==false||receipt.configChanged!==false)throw Error('Exact uninstalled candidate required');
plain(receipt.baseline,true);plain(receipt.backend,true);
const operation=path.dirname(receiptPath),beforeFile=path.join(operation,'inventory.before.json'),afterFile=path.join(operation,'inventory.desired.json');
if(hash(beforeFile)!==receipt.inventoryBeforeSha256||hash(afterFile)!==receipt.inventoryDesiredSha256)throw Error('Inventory receipt changed');
function inventory(root,rows){
  const map=new Map();
  for(const row of rows){
    if(typeof row.path!=='string'||row.path.includes('\\')||path.posix.normalize(row.path)!==row.path||row.path==='..'||row.path.startsWith('../')||path.posix.isAbsolute(row.path)||map.has(row.path))throw Error('Inventory relative path differs');
    const file=path.join(root,row.path);plain(file);
    if(hash(file)!==row.sha256||fs.statSync(file).size!==row.size)throw Error('Inventory bytes changed:'+row.path);
    map.set(row.path,row);
  }
  function visit(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('Linked candidate entry');
    if(entry.isDirectory())visit(file);else if(!map.has(path.relative(root,file).split(path.sep).join('/')))throw Error('Uninventoried entry');
  }}
  visit(root);return map;
}
function verifyReconciledBaseline(before,after) {
  const r=receipt.baselineReconciliation;
  if(!r)return null;
  const fail=()=>{throw Error('HOLD_RECONCILED_PROVIDER_BASELINE_UNPROVEN');};
  const target='components/workspace-mcp/web-management-provider.mjs';
  if(receipt.overlayMode!=='installed-provider-only'||r.kind!=='workspace-provider-baseline-reconciliation/v1'||
     r.path!==target||r.baseline!==receipt.baseline||r.mismatchCount!==1||
     r.sourceOwnerVerified!==true||r.operatingWrites!==0)fail();
  for(const [key,fileKey] of [
    ['priorReceiptSHA256','priorReceiptFile'],['priorPreparedSHA256','priorPreparedFile'],
    ['sealedInventorySHA256','sealedInventoryFile'],['registrySHA256','registryFile'],
    ['graphConfigSHA256','graphConfigFile'],['graphManifestSHA256','graphManifestFile']
  ]){plain(r[fileKey]);if(hash(r[fileKey])!==r[key])fail();}
  if(hash(path.join(receipt.baseline,'.aicc-release.json'))!==r.originalReleaseSHA256||
     hash(path.join(receipt.baseline,'workspace-drive-manifest.json'))!==r.originalDriveSHA256)fail();
  const owner=path.dirname(path.dirname(r.registryFile));
  const priorRoot=path.join(owner,'asset-control')+path.sep;
  if(!r.priorReceiptFile.startsWith(priorRoot)||
     path.basename(r.priorReceiptFile)!=='candidate.json'||
     r.priorPreparedFile!==path.join(path.dirname(r.priorReceiptFile),'prepared.json')||
     r.sealedInventoryFile!==path.join(path.dirname(r.priorReceiptFile),'inventory.before.json'))fail();
  const registry=read(r.registryFile),prior=read(r.priorReceiptFile),prepared=read(r.priorPreparedFile);
  if(registry.components?.workspace?.releaseRoot!==receipt.baseline||
     registry.components?.['unified-mcp']?.releaseRoot!==path.dirname(r.graphConfigFile)||
     prior.kind!=='workspace-gpt-queue-owner-replacement'||prior.status!=='PREPARED_NOT_ACTIVE'||
     prior.baseline!==receipt.baseline||prior.backend!==receipt.baseline||
     prior.configDesiredSHA256!==receipt.installedConfigSHA256||
     prior.queueBackendManifestSHA256!==r.originalReleaseSHA256||
     prior.queueDriveManifestSHA256!==r.originalDriveSHA256||
     prior.gptQueueRecovery?.inventoryBeforeFile!==r.sealedInventoryFile||
     prior.gptQueueRecovery?.inventoryBeforeSHA256!==r.sealedInventorySHA256||
     prepared.status!=='VALIDATED_NOT_ACTIVE'||
     prepared.candidateReceipt!==r.priorReceiptFile||
     prepared.candidateSHA256!==r.priorReceiptSHA256)fail();
  const inventoryRows=read(r.sealedInventoryFile);
  if(!Array.isArray(inventoryRows)||inventoryRows.length!==before.size)fail();
  const used=new Set();
  for(const row of inventoryRows){
    if(used.has(row.path)||!before.has(row.path)||
       before.get(row.path).sha256!==row.sha256||
       before.get(row.path).size!==row.size)fail();
    used.add(row.path);
  }
  const graph=read(r.graphConfigFile),graphManifest=read(r.graphManifestFile);
  if(graph.hostControl!=='task-owned-v1'||
     graph.providers?.map(p=>p.id).sort().join(',')!=='host,native,workspace'||
     graphManifest.files?.['config.json']!==r.graphConfigSHA256)fail();
  const pinPath=path.win32.normalize(path.join(receipt.baseline,target)).toLowerCase();
  const workspace=graph.providers.find(p=>p.id==='workspace');
  const pins=workspace.files.filter(p=>typeof p.path==='string'&&path.win32.normalize(p.path).toLowerCase()===pinPath);
  const original=read(path.join(receipt.baseline,'.aicc-release.json'));
  const historical=original.files.filter(p=>p.path===target);
  const drive=read(path.join(receipt.baseline,'workspace-drive-manifest.json'));
  const actual=before.get(target);
  if(pins.length!==1||historical.length!==1||!actual||!after.has(target)||
     !isDeepStrictEqual(actual,after.get(target))||
     pins[0].sha256!==actual.sha256||historical[0].sha256!==r.originalReleaseFileSHA256||
     historical[0].size!==r.originalReleaseFileSize||
     drive.files?.[target]!==r.originalDriveFileSHA256||
     actual.sha256!==r.actualFileSHA256||actual.size!==r.actualFileSize||
     historical[0].sha256===actual.sha256||drive.files[target]===actual.sha256)fail();
  let mismatches=0;
  for(const row of original.files){
    const item=before.get(row.path);
    if(!item)fail();
    if(item.sha256!==row.sha256||item.size!==row.size){
      if(row.path!==target)fail();
      mismatches++;
    }
  }
  if(mismatches!==1)fail();
  for(const provider of graph.providers){
    for(const pin of provider.files??[]){
      plain(pin.path);
      if(hash(pin.path)!==pin.sha256)fail();
    }
  }
  return {path:target,sha256:actual.sha256,size:actual.size};
}
const before=inventory(receipt.baseline,read(beforeFile)),after=inventory(receipt.backend,read(afterFile));
const reconciled=verifyReconciledBaseline(before,after);
const allowed=[...GPT_QUEUE_OVERLAY_FILES,'.aicc-release.json','workspace-drive-manifest.json'].sort();
const additions=['components/workspace-mcp/gpt-queue-provider.mjs','src/lib/windows-owner-only-acl.mjs','src/lib/windows-pwsh.mjs'];
if(JSON.stringify([...receipt.changedFiles].sort())!==JSON.stringify(allowed))throw Error('Unexpected candidate scope');
for(const [relative,row] of before){if(!after.has(relative)||(!allowed.includes(relative)&&row.sha256!==after.get(relative).sha256))throw Error('Unrelated installed bytes changed');}
for(const relative of after.keys())if(!before.has(relative)&&!additions.includes(relative))throw Error('Unapproved addition');
const installed={},source={};
for(const pin of receipt.sourcePins){plain(pin.path);if(hash(pin.path)!==pin.sha256)throw Error('Reviewed source changed');}
for(const relative of GPT_QUEUE_OVERLAY_FILES){
  const original=path.join(receipt.baseline,relative);if(fs.existsSync(original))installed[relative]=fs.readFileSync(original,'utf8');
  const pin=receipt.sourcePins.find(p=>p.path.split(path.sep).join('/').endsWith('/'+relative));
  if(!pin)throw Error('Exact source pin omitted');source[relative]=fs.readFileSync(pin.path,'utf8');
}
const expected=buildGptQueueRuntimeOverlay(installed,source,{mode:receipt.overlayMode});
for(const relative of GPT_QUEUE_OVERLAY_FILES)if(fs.readFileSync(path.join(receipt.backend,relative),'utf8')!==expected[relative])throw Error('Candidate exceeds exact queue overlay');
const release=read(path.join(receipt.baseline,'.aicc-release.json'));
const desiredRelease=read(path.join(receipt.backend,'.aicc-release.json'));
const proof=desiredRelease.gptQueueOverlay;
if(proof?.schemaVersion!==1||proof.kind!=='workspace-gpt-queue-overlay/v1'||proof.owner!==receipt.owner||
   proof.baseline!==receipt.baseline||proof.installedConfigChanged!==false||proof.toolCalls!==0||
   !isDeepStrictEqual(proof.sourcePins,receipt.sourcePins)||
   !isDeepStrictEqual(proof.baselineReconciliation??null,receipt.baselineReconciliation??null))throw Error('Release overlay provenance differs');
for(const relative of GPT_QUEUE_OVERLAY_FILES){
  const rows=release.files.filter(row=>row.path===relative),entry=after.get(relative);
  if(rows.length>1||(!rows.length&&!additions.includes(relative)))throw Error('Release preimage omitted or ambiguous');
  if(rows.length){rows[0].sha256=entry.sha256;rows[0].size=entry.size;}
  else release.files.push({path:relative,sha256:entry.sha256,size:entry.size});
}
if(reconciled){
  const row=release.files.find(row=>row.path===reconciled.path);
  if(!row)throw Error('Reconciled provider not in release manifest');
  row.sha256=reconciled.sha256;row.size=reconciled.size;
}
release.fileCount=release.files.length;release.totalBytes=release.files.reduce((n,r)=>n+r.size,0);release.gptQueueOverlay=proof;
if(!isDeepStrictEqual(release,desiredRelease))throw Error('Unrelated release metadata changed');
const drive=read(path.join(receipt.baseline,'workspace-drive-manifest.json'));
for(const relative of GPT_QUEUE_OVERLAY_FILES)drive.files[relative]=after.get(relative).sha256;
if(reconciled)drive.files[reconciled.path]=reconciled.sha256;
drive.baseline=receipt.baseline;drive.release=receipt.backend;
drive.files['.aicc-release.json']=after.get('.aicc-release.json').sha256;drive.gptQueueOverlay=proof;
if(!isDeepStrictEqual(drive,read(path.join(receipt.backend,'workspace-drive-manifest.json'))))throw Error('Unrelated drive metadata changed');
const moduleAt=relative=>import(pathToFileURL(path.join(receipt.backend,relative)).href);
const {assertWorkspaceMcpRuntimeClosure,workspaceMcpRuntimeHash}=await moduleAt('components/workspace-mcp/runtime-integrity.mjs');
const closure=assertWorkspaceMcpRuntimeClosure(receipt.backend);
const runtimeHash=workspaceMcpRuntimeHash(receipt.backend);
const {createWorkspaceMcpServer}=await moduleAt('components/workspace-mcp/server.mjs');
const {workspaceToolSnapshot}=await moduleAt('components/workspace-mcp/tool-manifest.mjs');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-queue-candidate-contract-'));
const results=[];
try{
  for(const [surface,enabled] of [['business-full',false],['business-full',true],['personal-read-fetch',true]]){
    const config={surfaceProfile:surface,workspaces:[],permissions:{commands:false},gptQueue:{enabled}};
    const server=createWorkspaceMcpServer(config,{runtimeRoot:temporary,remoteAuthority:{reconcileStartup(){}}});
    const client=new Client({name:'queue-candidate-contract',version:'1.0.0'});
    const [st,ct]=InMemoryTransport.createLinkedPair();
    try{
      await server.connect(st);await client.connect(ct);
      const actual=(await client.listTools()).tools;
      const projected=workspaceToolSnapshot({surfaceProfile:surface,commandSandboxAvailable:false,gptQueueAvailable:enabled});
      if(JSON.stringify(actual.map(x=>x.name).sort())!==JSON.stringify(projected.tools.map(x=>x.name).sort()))throw Error('Actual MCP tools and contract differ');
      const queue=actual.filter(t=>t.name.startsWith('aicc_gpt_queue_'));
      if(queue.length!==(surface==='business-full'&&enabled?5:0))throw Error('Queue surface scope differs');
      for(const tool of queue)if(!tool.inputSchema.required.includes('lease')||!tool.inputSchema.required.includes('workspace_id'))throw Error('Queue lease schema omitted');
      results.push({surface,enabled,queueTools:queue.map(x=>x.name),toolHash:projected.hash,toolCount:actual.length});
    }finally{await client.close();await server.close();}
  }
}finally{
  const full=path.resolve(temporary),boundary=path.resolve(os.tmpdir())+path.sep;
  if(!full.startsWith(boundary)||!path.basename(full).startsWith('aicc-queue-candidate-contract-'))throw Error('Temporary cleanup boundary differs');
  // File removal belongs to the calling PowerShell session; expose this small
  // empty contract directory in the receipt for explicit owner cleanup.
}
console.log(JSON.stringify({ok:true,status:'STAGED_CONTRACT_VERIFIED_NOT_INSTALLED',receiptSha256:hash(receiptPath),
  candidate:receipt.backend,closureVerified:closure.ok,runtimeHash,results,toolCalls:0,leasesOpened:0,
  liveConfigWrites:0,manifestsPreserved:true,temporaryDirectory:temporary},null,2));
