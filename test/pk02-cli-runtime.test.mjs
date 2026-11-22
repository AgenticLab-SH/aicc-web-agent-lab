import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { PK02_FILES,preparePk02CliRuntime,previewPk02CliRuntime,applyPk02CliRuntime,rollbackPk02CliRuntime } from '../tools/platform/aicc/pk02-cli-runtime.mjs';
import { sealInstalledCliCandidate,createInstalledCliRouteAdapter } from '../src/recovery/installed-cli-route-adapter.mjs';

const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function put(file,text){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
const write=(file,value)=>put(file,JSON.stringify(value));
const link=(file,root)=>fs.symlinkSync(root,file,process.platform==='win32'?'junction':'dir');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-pk02-cli-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const stateRoot=path.join(root,'state'),sourceRoot=path.join(root,'source'),operationDirectory=path.join(stateRoot,'asset-control/existing-operation');
  const baseline=path.join(stateRoot,'releases/cli/general-owned'),codex=path.join(stateRoot,'releases/cli/codex-owned'),nodeRoot=path.join(root,'node');
  fs.mkdirSync(operationDirectory,{recursive:true});fs.mkdirSync(codex,{recursive:true});
  for(const file of PK02_FILES){put(path.join(baseline,file),'export const oldValue=true;\n');put(path.join(sourceRoot,file),'export const newValue=true;\n');}
  put(path.join(sourceRoot,PK02_FILES[0]),"import { goal } from '../goals/service.mjs'; export const newValue=goal;\n");
  put(path.join(sourceRoot,PK02_FILES[1]),"import 'zod/v4'; import './service.mjs';\n");
  put(path.join(sourceRoot,PK02_FILES[3]),"import '../goals/user-action-ledger.mjs';export const goal='tracked';\n");
  put(path.join(baseline,'src/goals/user-action-ledger.mjs'),'export const existingOwnerPatch=true;\n');
  put(path.join(baseline,'node_modules/zod/package.json'),JSON.stringify({name:'zod',version:'4.4.3'}));
  put(path.join(baseline,'bin/aicc'),'import "../src/cli.mjs";\n');
  put(path.join(baseline,'src/cli.mjs'),"import './orchestration/mcp-server.mjs';\n");
  put(path.join(baseline,'src/recovery/restore-v2-command.mjs'),'export {};\n');
  put(path.join(baseline,'components/workspace-mcp/server.mjs'),'installed-patch-to-preserve\n');
  sealInstalledCliCandidate(baseline,{sourceRevision:'a'.repeat(40)});
  const node=path.join(nodeRoot,'node.exe');put(node,'fixture node');
  for(const name of ['aicc','aicc.cmd','aicc.ps1'])put(path.join(nodeRoot,name),'AICC_CODEX_HOME_ENTRY_V1 node_modules/open-aicc/bin/aicc\n');
  fs.mkdirSync(path.join(nodeRoot,'node_modules'));const entry=path.join(nodeRoot,'node_modules/open-aicc');link(entry,baseline);
  const registryFile=path.join(stateRoot,'runtime/components.json');write(registryFile,{schemaVersion:1,root:stateRoot,components:{cli:{runtime:node,releaseRoot:codex,entry:path.join(codex,'bin/aicc')},workspace:{releaseRoot:'existing-workspace'},'unified-mcp':{releaseRoot:'existing-host8-gateway'}}});
  return {root,stateRoot,sourceRoot,operationDirectory,baseline,codex,entry,registryFile};
}
function prepare(f){const result=preparePk02CliRuntime(f);return {...result,receipt:read(result.receiptFile)};}
function preview(p){const outputFile=path.join(path.dirname(p.receiptFile),'preview.json');return previewPk02CliRuntime({receiptFile:p.receiptFile,outputFile});}
function backup(f,p,v){
  const records=[p.receipt.installerPin,p.receipt.cutoverPin,p.receipt.recoveryPin,p.receipt.candidateManifest,p.receipt.baselineManifest,...p.receipt.wrappers,...p.receipt.sourcePins,{sha256:v.planSha256}];
  const bundlePath=path.join(f.operationDirectory,'fixture-backup-bundle.json');write(bundlePath,{files:records});
  const file=path.join(f.operationDirectory,'fixture-backup-receipt.json');write(file,{githubStatus:'VERIFIED',notionStatus:'VERIFIED',bundlePath,bundleSHA256:hash(bundlePath)});return file;
}
const options=(v,changeBackupReceipt)=>({planFile:v.planFile,expectedPlanSha256:v.planSha256,challenge:v.challenge,changeBackupReceipt,commit:true});

test('PK02 stages only four source files over the actual general CLI and preserves separate Codex and installed patches',t=>{
  const f=fixture(t),registryBefore=fs.readFileSync(f.registryFile),p=prepare(f);
  assert.notEqual(f.baseline,f.codex);assert.equal(fs.realpathSync(f.entry),f.baseline);
  assert.equal(p.receipt.registryCliPreserved,true);assert.equal(p.receipt.closure.relativeModuleClosureVerified,true);
  assert.equal(p.receipt.closure.relativeFiles.length,5);assert.equal(p.receipt.closure.packageManifests[0].name,'zod');
  for(const file of PK02_FILES)assert.equal(hash(path.join(p.candidate,file)),hash(path.join(f.sourceRoot,file)));
  assert.equal(fs.readFileSync(path.join(p.candidate,'components/workspace-mcp/server.mjs'),'utf8'),'installed-patch-to-preserve\n');
  assert.deepEqual(fs.readFileSync(f.registryFile),registryBefore);assert.equal(p.runtimeValidation,'NOT_RUN');
  assert.throws(()=>prepare(f),/existing_candidate_preserved/);
  const registry=read(f.registryFile);registry.components.workspace.releaseRoot='new-owner-workspace';write(f.registryFile,registry);
  assert.equal(preview(p).terminal,'PREVIEW_ONLY');assert.equal(fs.realpathSync(f.entry),f.baseline);
});

test('PK02 cannot omit goals/service or hide unresolved relative or package dependencies',t=>{
  for(const mode of ['missing-goals','relative','package']){
    const f=fixture(t);
    if(mode==='missing-goals')fs.unlinkSync(path.join(f.sourceRoot,PK02_FILES[3]));
    else put(path.join(f.sourceRoot,PK02_FILES[0]),mode==='relative'?"import './missing.mjs';":"import 'missing-package';");
    assert.throws(()=>prepare(f));assert.equal(fs.realpathSync(f.entry),f.baseline);
    assert.equal(fs.readdirSync(f.operationDirectory).some(name=>fs.existsSync(path.join(f.operationDirectory,name,'candidate-receipt.json'))),false);
  }
});

test('PK02 preview rejects changed source, wrapper, candidate and owned Codex component without touching the junction',t=>{
  for(const mode of ['source','wrapper','candidate','registry-cli']){
    const f=fixture(t),p=prepare(f);
    if(mode==='source')put(p.receipt.sourcePins[0].path,'changed source');
    if(mode==='wrapper')put(p.receipt.wrappers[0].path,'changed wrapper');
    if(mode==='candidate')put(path.join(p.candidate,'src/cli.mjs'),'changed candidate');
    if(mode==='registry-cli'){const registry=read(f.registryFile);registry.components.cli.entry+='other';write(f.registryFile,registry);}
    assert.throws(()=>preview(p));assert.equal(fs.realpathSync(f.entry),f.baseline);
  }
});

test('PK02 apply requires exact fresh plan and both backup destinations before it can call the existing cutover',async t=>{
  const f=fixture(t),p=prepare(f),v=preview(p);let calls=0;
  const dependencies={cutover:async()=>{calls++;throw new Error('must not call');}};
  await assert.rejects(applyPk02CliRuntime({...options(v,'missing'),commit:false},dependencies),/explicit_commit/);
  await assert.rejects(applyPk02CliRuntime({...options(v,'missing'),expectedPlanSha256:'0'.repeat(64)},dependencies),/preview_hash/);
  await assert.rejects(applyPk02CliRuntime({...options(v,'missing'),challenge:'different'},dependencies),/fresh_exact/);
  const bad=path.join(f.operationDirectory,'bad.json');write(bad,{githubStatus:'VERIFIED',notionStatus:'UNKNOWN'});
  await assert.rejects(applyPk02CliRuntime(options(v,bad),dependencies),/two_destination/);
  assert.equal(calls,0);assert.equal(fs.realpathSync(f.entry),f.baseline);
});

test('PK02 delegates exact-idle checks and never replays an existing attempt or changes the registry',async t=>{
  const f=fixture(t),p=prepare(f),v=preview(p),changeBackupReceipt=backup(f,p,v),before=fs.readFileSync(f.registryFile);let calls=0;
  const result=await applyPk02CliRuntime(options(v,changeBackupReceipt),{inspectGate:()=>({readOk:true,exactIdle:false,activeCount:0,unknownCount:1}),
    cutover:async(args,dependencies)=>{calls++;assert.deepEqual(dependencies.inspectGate(),{readOk:true,exactIdle:false,activeCount:0,unknownCount:1});
      assert.equal(args[args.indexOf('--entry')+1],f.entry);assert.equal(args[args.indexOf('--candidate')+1],p.candidate);
      return {receipt:{terminal:'HOLD_PRE_DISPATCH',installedCandidate:false}};}});
  assert.equal(result.terminal,'HOLD_PRE_DISPATCH');assert.equal(calls,1);
  await assert.rejects(applyPk02CliRuntime(options(v,changeBackupReceipt)),/EEXIST/);
  assert.deepEqual(fs.readFileSync(f.registryFile),before);assert.equal(fs.realpathSync(f.entry),f.baseline);
});

test('PK02 rollback restores only its exact candidate and preserves a newer unrelated registry component',async t=>{
  const f=fixture(t),p=prepare(f),v=preview(p),r=p.receipt,backupRoot=path.join(f.stateRoot,'backups/runtime-layout');fs.mkdirSync(backupRoot,{recursive:true});
  const adapter=createInstalledCliRouteAdapter({entryPath:f.entry,candidatePath:p.candidate,backupRoot,wrapperPaths:r.wrappers.map(row=>row.path),legacyPointerPath:f.registryFile,recoveryScriptPath:r.recoveryPin.path});
  const inspection=await adapter.inspect(),scope={operationId:'fixture-op',attemptId:'fixture-attempt',expectedGeneration:inspection.fingerprintHash,backupTarget:path.join(backupRoot,'fixture-op-fixture-attempt')};
  await adapter.backup(scope);await adapter.apply(scope);
  const cutoverReceiptFile=path.join(path.dirname(v.planFile),'cutover-result.json');write(cutoverReceiptFile,{component:'installed-cli-route',candidatePath:p.candidate,backupTarget:scope.backupTarget});
  const registry=read(f.registryFile);registry.components.workspace.releaseRoot='new-other-owner';write(f.registryFile,registry);const before=fs.readFileSync(f.registryFile);
  const rollback={planFile:v.planFile,expectedPlanSha256:v.planSha256,cutoverReceiptFile,expectedCutoverSha256:hash(cutoverReceiptFile),commit:true};
  const newer=path.join(f.stateRoot,'releases/cli/newer-owner');fs.mkdirSync(newer);fs.unlinkSync(f.entry);link(f.entry,newer);
  await assert.rejects(rollbackPk02CliRuntime(rollback),/rollback_target_changed/);assert.equal(fs.realpathSync(f.entry),newer);
  fs.unlinkSync(f.entry);link(f.entry,p.candidate);
  const result=await rollbackPk02CliRuntime(rollback);
  assert.equal(result.terminal,'ROLLED_BACK');assert.equal(fs.realpathSync(f.entry),f.baseline);assert.deepEqual(fs.readFileSync(f.registryFile),before);
});
