import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const digest=value=>createHash('sha256').update(value).digest('hex');

test('PowerShell add-file preparation binds normalized bytes, path, preimages and stable mutation ID', {skip:process.platform!=='win32'}, t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'aicc-request-prep-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const write=(name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));return file;};
  write('web-asset-requests/catalog.json',{schemaVersion:1,kind:'aicc-web-asset-package-catalog',execution:{accountAlias:'fixture-account',workspaceAlias:'fixture'},candidates:[]});
  const body='\uFEFF# Reference\r\n\r\nNew content.\r\n';
  const desired=body.replace(/^\uFEFF/,'').replaceAll('\r\n','\n');
  const bodyFile=write('reference.md',body),desiredSHA256=digest(desired);
  const bundle={assetKey:'skill|fixture-account|skill-test-0001',operation:'create',preimageSHA256:digest(''),desiredSHA256,
    files:[{path:'desired/references/new-file.md',sha256:desiredSHA256,contentBase64:Buffer.from(desired).toString('base64')}]};
  const bundlePath=write('bundle.json',bundle);
  const backupReceipt=write('receipt.json',{schemaVersion:1,...bundle,bundlePath,bundleSHA256:digest(fs.readFileSync(bundlePath)),
    githubStatus:'VERIFIED',notionStatus:'VERIFIED',githubBlobSHA:'fixture-only',notionPageId:'fixture-only',notionFileUploadId:'fixture-only'});
  const skill={name:'example',displayName:'Example',skillId:'skill-test-0001',filePath:'references/new-file.md',bodyFile};
  const plan={schemaVersion:1,action:'personal-skill-plan-add-file',skill,backupReceipt};
  const run=request=>{
    write('input.json',request);
    const result=spawnSync('powershell.exe',['-NoProfile','-File',path.join(repository,'tools/platform/chatgpt/Prepare-WebManagementRequest.ps1'),'-WorkspaceRoot',root,'-Action','Prepare','-InputPath','input.json'],{encoding:'utf8',windowsHide:true,timeout:20000});
    assert.equal(result.error,undefined);
    const report=JSON.parse(result.stdout.replace(/^\uFEFF/,''));return {result,report};
  };
  const prepared=run(plan);assert.equal(prepared.result.status,0,prepared.result.stderr+prepared.result.stdout);
  assert.equal(prepared.report.remoteMutationPerformed,false);
  const read=JSON.parse(fs.readFileSync(path.join(root,prepared.report.request_path),'utf8'));
  assert.equal(read.skill.bodyFileSHA256,digest(fs.readFileSync(bodyFile)));
  const apply={...plan,action:'personal-skill-add-file',commit:true,confirm:'ADD-FILE:'+skill.skillId+':'+skill.filePath,
    skill:{...skill,expectedCurrentSha:'a'.repeat(64),expectedTreeSha:'b'.repeat(64)}};
  const first=run(apply),second=run(apply);
  assert.equal(first.result.status,0,first.result.stderr+first.result.stdout);
  assert.equal(first.report.request_id,second.report.request_id);
  assert.match(first.report.request_id,/^asset-/);
  for(const request of [{...plan,commit:true},{...apply,confirm:'ADD-FILE:wrong'},
    {...apply,skill:{...apply.skill,expectedTreeSha:undefined}},
    {...apply,skill:{...apply.skill,filePath:'references/other-file.md'}},
    {...apply,skill:{...apply.skill,filePath:'references/../unsafe.md'}}]){
    const invalid=run(request);assert.equal(invalid.result.status,2,JSON.stringify(invalid.report));
    assert.equal(invalid.report.remoteMutationPerformed,false);
  }
  write('receipt.json.operation.json',{status:'OUTCOME_UNKNOWN_RECONCILE'});
  assert.match(run(apply).report.reason,/PRIOR_ATTEMPT_RECONCILE/);
  assert.equal(fs.existsSync(backupReceipt+'.operation.lock'),false);
});