import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { inventoryInstalledCliCandidate, sealInstalledCliCandidate, verifyInstalledCliCandidate, createInstalledCliRouteAdapter } from '../../../src/recovery/installed-cli-route-adapter.mjs';
import { runInstalledCliRouteCutover } from './run-installed-cli-route-cutover.mjs';
import { codexWorkGateStatus } from '../../../src/codex-work-gate.mjs';

export const PK02_FILES = Object.freeze(['src/orchestration/service.mjs','src/orchestration/mcp-server.mjs','src/jobs/job-manager.mjs','src/goals/service.mjs']);
const KIND='pk02-general-cli-overlay',SELF=fileURLToPath(import.meta.url);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const inside=(root,file)=>{const relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
function plain(file,directory=false){
  if(!path.isAbsolute(file))throw new Error('absolute_path_required');
  const item=fs.lstatSync(file);if(item.isSymbolicLink()||(directory?!item.isDirectory():!item.isFile()))throw new Error('regular_path_required');
  for(let parent=path.dirname(file);;parent=path.dirname(parent)){if(fs.lstatSync(parent).isSymbolicLink())throw new Error('linked_ancestor_refused');if(path.dirname(parent)===parent)break;}
  return file;
}
const bytes=file=>fs.readFileSync(plain(file));
const json=file=>JSON.parse(bytes(file).toString('utf8'));
const pin=file=>({path:file,sha256:hash(bytes(file))});
const check=record=>{if(hash(bytes(record.path))!==record.sha256)throw new Error('pinned_file_changed');};
function write(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});return pin(file);}
function target(entry){if(!fs.lstatSync(entry).isSymbolicLink())throw new Error('general_cli_entry_not_junction');return path.resolve(path.dirname(entry),fs.readlinkSync(entry));}
function layout(stateRoot){
  plain(stateRoot,true);const registryFile=path.join(stateRoot,'runtime/components.json'),registry=json(registryFile),node=registry.components?.cli?.runtime;
  if(registry.schemaVersion!==1||!same(registry.root,stateRoot)||!path.isAbsolute(node??''))throw new Error('registered_cli_runtime_required');
  plain(node);const nodeRoot=path.dirname(node),entry=path.join(nodeRoot,'node_modules/open-aicc');
  const baseline=plain(target(entry),true),releaseParent=plain(path.join(stateRoot,'releases/cli'),true);
  if(!inside(releaseParent,baseline)||path.dirname(baseline)!==releaseParent)throw new Error('managed_general_cli_baseline_required');
  const wrappers=['aicc','aicc.cmd','aicc.ps1'].map(name=>pin(path.join(nodeRoot,name)));
  // Codex/home use the registered component; ordinary orchestration uses npm.
  const powershell=bytes(wrappers[2].path).toString('utf8');
  if(!powershell.includes('AICC_CODEX_HOME_ENTRY_V1')||!powershell.includes('node_modules/open-aicc/bin/aicc'))throw new Error('supported_split_cli_launcher_required');
  return {registryFile,registry,node,entry,baseline,releaseParent,wrappers};
}
function relativeClosure(root){
  const seen=new Set(),packages=new Map();
  function visit(relative){
    relative=relative.replaceAll('\\','/');if(seen.has(relative))return;seen.add(relative);
    const file=path.resolve(root,relative);if(!inside(root,file))throw new Error('dependency_path_escape');
    const source=bytes(file).toString('utf8'),tree=parse(source,{ecmaVersion:'latest',sourceType:'module'}),imports=[];
    const walk=node=>{if(!node||typeof node!=='object')return;
      if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source)imports.push(node.source.value);
      if(node.type==='ImportExpression'){if(node.source?.type!=='Literal'||typeof node.source.value!=='string')throw new Error('dynamic_dependency_unresolved');imports.push(node.source.value);}
      for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);}
    };walk(tree);
    for(const specifier of imports){
      if(specifier.startsWith('node:'))continue;
      if(specifier.startsWith('.')){const dependency=path.resolve(path.dirname(file),specifier);if(!inside(root,dependency))throw new Error('dependency_path_escape');visit(path.relative(root,dependency));}
      else{
        const name=specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0];
        const packageFile=path.join(root,'node_modules',name,'package.json'),record=json(packageFile);
        if(record.name!==name||typeof record.version!=='string')throw new Error('package_dependency_unresolved');
        packages.set(name,{name,version:record.version,...pin(packageFile)});
      }
    }
  }
  PK02_FILES.forEach(visit);
  return {relativeModuleClosureVerified:true,relativeFiles:[...seen].sort().map(relative=>({relative,...pin(path.join(root,relative))})),
    packageManifests:[...packages.values()].sort((a,b)=>a.name.localeCompare(b.name)),packageResolution:'preserved-candidate-package-trees',runtimeValidation:'NOT_RUN'};
}
function assertPrepared(receipt){
  if(receipt.kind!==KIND||receipt.state!=='PREPARED_NOT_ACTIVE')throw new Error('exact_pk02_candidate_required');
  const current=layout(receipt.stateRoot);
  if(!same(current.entry,receipt.entry)||!same(current.baseline,receipt.baseline)||hash(JSON.stringify(current.registry.components.cli))!==receipt.registryCliHash)throw new Error('installed_route_or_cli_changed');
  receipt.wrappers.forEach(check);check(receipt.baselineManifest);receipt.sourcePins.forEach(check);check(receipt.installerPin);check(receipt.cutoverPin);check(receipt.recoveryPin);
  const verified=verifyInstalledCliCandidate(receipt.candidate);
  if(!verified.ok||verified.manifestHash!==receipt.candidateManifest.sha256)throw new Error('candidate_manifest_or_inventory_changed');
  for(const record of receipt.overlayPins)check(record);
  return current;
}

export function preparePk02CliRuntime({stateRoot,sourceRoot,operationDirectory}){
  const current=layout(stateRoot);plain(sourceRoot,true);plain(operationDirectory,true);
  if(!inside(path.join(stateRoot,'asset-control'),operationDirectory))throw new Error('existing_owner_operation_required');
  const sourcePins=PK02_FILES.map(relative=>pin(path.join(sourceRoot,relative)));
  const baselineManifest=pin(path.join(current.baseline,'.aicc-release.json'));
  const baselineInventory=inventoryInstalledCliCandidate(current.baseline);
  const baselineHash=hash(JSON.stringify(baselineInventory)),inputHash=hash(JSON.stringify({baselineHash,sourcePins,wrappers:current.wrappers}));
  const stage=path.join(operationDirectory,'pk02-cli-'+inputHash.slice(0,16));
  const candidate=path.join(current.releaseParent,'pk02-'+inputHash.slice(0,20));
  if(fs.existsSync(stage)||fs.existsSync(candidate))throw new Error('existing_candidate_preserved');
  // Source inputs are immutable for this assembly. Copy only this baseline,
  // preserving installed patches; never replace it with the current checkout.
  sourcePins.forEach(check);fs.mkdirSync(stage,{mode:0o700});
  fs.copyFileSync(current.registryFile,path.join(stage,'components.before.json'),fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(baselineManifest.path,path.join(stage,'release.before.json'),fs.constants.COPYFILE_EXCL);
  write(path.join(stage,'source-before.json'),PK02_FILES.map(relative=>({relative,...pin(path.join(current.baseline,relative))})));
  fs.cpSync(current.baseline,candidate,{recursive:true,errorOnExist:true,force:false});
  for(let i=0;i<PK02_FILES.length;i++){check(sourcePins[i]);fs.copyFileSync(sourcePins[i].path,path.join(candidate,PK02_FILES[i]));}
  const after=inventoryInstalledCliCandidate(candidate),beforeMap=new Map(baselineInventory.files.map(row=>[row.path,row]));
  if(after.files.length!==baselineInventory.files.length||after.files.some(row=>!beforeMap.has(row.path)||(!PK02_FILES.includes(row.path)&&row.sha256!==beforeMap.get(row.path).sha256)))throw new Error('unrelated_installed_file_changed');
  if(hash(JSON.stringify(inventoryInstalledCliCandidate(current.baseline)))!==baselineHash)throw new Error('baseline_changed_during_copy');
  const closure=relativeClosure(candidate);
  if(!bytes(path.join(candidate,'src/cli.mjs')).toString('utf8').includes("'./orchestration/mcp-server.mjs'"))throw new Error('installed_orchestration_entry_missing');
  fs.renameSync(path.join(candidate,'.aicc-release.json'),path.join(stage,'candidate-baseline-manifest.json'));
  const old=json(baselineManifest.path),sealed=sealInstalledCliCandidate(candidate,{sourceRevision:old.sourceRevision});
  const receipt={schemaVersion:1,kind:KIND,state:'PREPARED_NOT_ACTIVE',stateRoot,entry:current.entry,baseline:current.baseline,candidate,
    baselineManifest,baselineInventoryHash:baselineHash,componentsHash:hash(JSON.stringify(current.registry.components)),registryCliHash:hash(JSON.stringify(current.registry.components.cli)),
    wrappers:current.wrappers,sourcePins,overlayPins:PK02_FILES.map(relative=>({relative,...pin(path.join(candidate,relative))})),closure,
    candidateManifest:pin(sealed.manifestFile),installerPin:pin(SELF),cutoverPin:pin(path.join(path.dirname(SELF),'run-installed-cli-route-cutover.mjs')),
    recoveryPin:pin(path.join(path.dirname(SELF),'restore-installed-cli-route.ps1')),
    registryCliPreserved:true,workspaceGatewayHostPreserved:true,servicesRestarted:false,runtimeValidation:'NOT_RUN'};
  const receiptFile=path.join(stage,'candidate-receipt.json');write(receiptFile,receipt);assertPrepared(receipt);
  return {terminal:'PREPARED_NOT_ACTIVE',receiptFile,receiptSha256:hash(bytes(receiptFile)),candidate,liveMutation:false,runtimeValidation:'NOT_RUN'};
}

export function previewPk02CliRuntime({receiptFile,outputFile}){
  const receipt=json(receiptFile);assertPrepared(receipt);
  if(path.dirname(outputFile)!==path.dirname(receiptFile))throw new Error('preview_must_remain_in_candidate_operation');
  const plan={schemaVersion:1,kind:KIND,receipt:pin(receiptFile),challenge:crypto.randomBytes(32).toString('hex'),
    expiresAt:new Date(Date.now()+25*60_000).toISOString(),entry:receipt.entry,baseline:receipt.baseline,candidate:receipt.candidate,
    componentsHash:receipt.componentsHash,registryCliPreserved:true,serviceStops:0,modelRouteChanges:0,
    allowedRecovery:['restore-exact-general-cli-junction-with-cas'],liveMutation:false};
  const result=write(outputFile,plan);return {terminal:'PREVIEW_ONLY',planFile:result.path,planSha256:result.sha256,challenge:plan.challenge,expiresAt:plan.expiresAt,liveMutation:false};
}

function boundPlan({planFile,expectedPlanSha256,challenge}){
  if(hash(bytes(planFile))!==expectedPlanSha256)throw new Error('exact_preview_hash_required');
  const plan=json(planFile);if(plan.kind!==KIND||plan.challenge!==challenge||Date.now()>=Date.parse(plan.expiresAt)||!Number.isFinite(Date.parse(plan.expiresAt)))throw new Error('fresh_exact_preview_required');
  check(plan.receipt);const receipt=json(plan.receipt.path);assertPrepared(receipt);
  if(path.dirname(planFile)!==path.dirname(plan.receipt.path)||plan.entry!==receipt.entry||plan.baseline!==receipt.baseline||plan.candidate!==receipt.candidate)throw new Error('preview_candidate_binding_changed');
  return {plan,receipt};
}
function backupProof(file,receipt,planFile){
  const backup=json(file);if(backup.githubStatus!=='VERIFIED'||backup.notionStatus!=='VERIFIED')throw new Error('verified_two_destination_backup_required');
  if(hash(bytes(backup.bundlePath))!==backup.bundleSHA256)throw new Error('backup_bundle_changed');
  const bundle=json(backup.bundlePath),pins=new Set((bundle.files??[]).map(row=>row.sha256));
  if(![receipt.installerPin,receipt.cutoverPin,receipt.recoveryPin,receipt.candidateManifest,receipt.baselineManifest,...receipt.wrappers,...receipt.sourcePins,pin(planFile)].every(record=>pins.has(record.sha256)))throw new Error('backup_must_cover_exact_pk02_candidate_and_updater');
}

export async function applyPk02CliRuntime(options,dependencies={}){
  if(options.commit!==true)throw new Error('explicit_commit_required');
  const {receipt}=boundPlan(options);backupProof(options.changeBackupReceipt,receipt,options.planFile);
  const op=path.dirname(options.planFile),claim=path.join(op,'apply-start.json');
  // An existing or uncertain attempt is reconciled, never re-dispatched.
  write(claim,{kind:KIND,plan:pin(options.planFile),startedAt:new Date().toISOString(),retryAllowed:false});
  const output=path.join(op,'cutover-result.json'),args=['--state-root',receipt.stateRoot,'--entry',receipt.entry,'--candidate',receipt.candidate,
    '--backup-root',path.join(receipt.stateRoot,'backups/runtime-layout'),'--receipt',output,'--recovery-script',receipt.recoveryPin.path,
    '--legacy-pointer',path.join(receipt.stateRoot,'runtime/components.json'),'--wait-ms','0',...receipt.wrappers.flatMap(row=>['--wrapper',row.path])];
  const inspectGate=()=>{try{assertPrepared(receipt);}catch{return {readOk:false,exactIdle:false,activeCount:null,unknownCount:null};}return (dependencies.inspectGate??codexWorkGateStatus)();};
  const execution=await (dependencies.cutover??runInstalledCliRouteCutover)(args,{inspectGate});
  const actual=layout(receipt.stateRoot);
  const preserved=hash(JSON.stringify(actual.registry.components.cli))===receipt.registryCliHash&&receipt.wrappers.every(row=>hash(bytes(row.path))===row.sha256);
  write(path.join(op,'apply-readback.json'),{kind:KIND,cutoverReceipt:fs.existsSync(output)?pin(output):null,entryTarget:actual.baseline,
    componentsAfterHash:hash(JSON.stringify(actual.registry.components)),registryWritten:false,registryCliPreserved:preserved,runtimeValidation:'NOT_RUN'});
  return {terminal:preserved?execution.receipt.terminal:'HOLD_PARTIAL',cutoverReceipt:output,liveMutation:execution.receipt.installedCandidate===true,runtimeValidation:'NOT_RUN'};
}

export async function rollbackPk02CliRuntime({planFile,expectedPlanSha256,cutoverReceiptFile,expectedCutoverSha256,commit}){
  if(commit!==true||hash(bytes(planFile))!==expectedPlanSha256||hash(bytes(cutoverReceiptFile))!==expectedCutoverSha256)throw new Error('exact_rollback_receipts_required');
  const plan=json(planFile);if(plan.kind!==KIND)throw new Error('exact_pk02_plan_required');check(plan.receipt);
  const receipt=json(plan.receipt.path),cutover=json(cutoverReceiptFile),backupRoot=path.join(receipt.stateRoot,'backups/runtime-layout');
  check(receipt.installerPin);check(receipt.cutoverPin);check(receipt.recoveryPin);
  if(path.dirname(cutoverReceiptFile)!==path.dirname(planFile)||cutover.component!=='installed-cli-route'||!inside(backupRoot,cutover.backupTarget??'')||!same(cutover.candidatePath,receipt.candidate))throw new Error('exact_cutover_backup_required');
  const current=layout(receipt.stateRoot);receipt.wrappers.forEach(check);
  if(hash(JSON.stringify(current.registry.components.cli))!==receipt.registryCliHash)throw new Error('rollback_registry_cli_changed');
  const backup=json(path.join(cutover.backupTarget,'manifest.json'));
  if(!same(backup.entryPath,receipt.entry)||!same(backup.sourceTarget,receipt.baseline)||!same(backup.candidatePath,receipt.candidate))throw new Error('rollback_owner_changed');
  if(same(current.baseline,receipt.baseline))return {terminal:'ROLLED_BACK',reason:'already_at_exact_baseline',liveMutation:false};
  if(!same(current.baseline,receipt.candidate))throw new Error('rollback_target_changed');
  const adapter=createInstalledCliRouteAdapter({entryPath:receipt.entry,candidatePath:receipt.candidate,backupRoot,wrapperPaths:receipt.wrappers.map(row=>row.path),
    legacyPointerPath:current.registryFile,recoveryScriptPath:receipt.recoveryPin.path});
  const scope={operationId:backup.operationId,attemptId:backup.attemptId,backupTarget:cutover.backupTarget};
  const result=await adapter.rollback(scope),verified=await adapter.verifyRollback(scope);
  return {terminal:result.acknowledged&&verified.ok?'ROLLED_BACK':'HOLD_PARTIAL',liveMutation:true,registryCliPreserved:true};
}

export async function main(argv=process.argv.slice(2)){
  const [mode,...args]=argv,options={};
  const keys={ '--state-root':'stateRoot','--source-root':'sourceRoot','--operation-directory':'operationDirectory','--receipt':'receiptFile','--output':'outputFile',
    '--plan':'planFile','--expected-plan-sha256':'expectedPlanSha256','--challenge':'challenge','--change-backup-receipt':'changeBackupReceipt',
    '--cutover-receipt':'cutoverReceiptFile','--expected-cutover-sha256':'expectedCutoverSha256','--commit':'commit'};
  for(let i=0;i<args.length;i++){const key=keys[args[i]];if(!key||key in options)throw new Error('unknown_or_duplicate_option');
    if(key==='commit')options[key]=true;else{const value=args[++i];if(!value||value.startsWith('--'))throw new Error('option_value_required');options[key]=value;}}
  const actions={prepare:preparePk02CliRuntime,preview:previewPk02CliRuntime,apply:applyPk02CliRuntime,rollback:rollbackPk02CliRuntime};
  if(!actions[mode])throw new Error('prepare_preview_apply_or_rollback_required');
  if(['prepare','preview'].includes(mode)&&options.commit)throw new Error('preparation_is_readonly');
  return actions[mode](options);
}
if(process.argv[1]&&same(process.argv[1],SELF))main().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error('pk02-cli-runtime: '+error.message);process.exitCode=3;});
