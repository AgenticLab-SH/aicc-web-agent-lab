import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const helper=fileURLToPath(new URL('../tools/platform/windows/Start-AiccCodexCli.ps1',import.meta.url));
const windows=process.platform==='win32';
function fixture(git=true){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-tray-cli-'));
  const workspace=path.join(root,"한글 작업's folder");fs.mkdirSync(workspace,{recursive:true});if(git)fs.mkdirSync(path.join(workspace,'.git'));
  const release=path.join(root,'releases','cli','fixture');fs.mkdirSync(path.join(release,'bin'),{recursive:true});fs.mkdirSync(path.join(release,'src'));
  const entry=path.join(release,'bin','aicc');fs.writeFileSync(entry,'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));');
  const sourceHashes={};
  for(const relative of ['src/cli.mjs','src/codex-cli-routes.mjs']){const bytes=Buffer.from('// pinned fixture\n');fs.writeFileSync(path.join(release,relative),bytes);sourceHashes[relative]=crypto.createHash('sha256').update(bytes).digest('hex');}
  fs.mkdirSync(path.join(root,'runtime'));fs.writeFileSync(path.join(root,'runtime','components.json'),JSON.stringify({components:{cli:{entry,releaseRoot:release,runtime:process.execPath,location:'managed',sourceHashes}}}));
  const run=(route,extra=[])=>spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',helper,'-Route',route,'-Workspace',workspace,...extra],{encoding:'utf8',timeout:20000,windowsHide:true,env:{...process.env,AICC_STATE_ROOT:root}});
  return {root,workspace,release,run};
}
test('real tray PowerShell launcher preserves explicit route, effort, model and Unicode Git folder without invoking Codex',{skip:!windows},()=>{
  const f=fixture();
  for(const route of ['ocx','native']){
    const result=f.run(route);assert.equal(result.status,0,result.stderr);
    const actual=JSON.parse(result.stdout.split(/\r?\n/).find(line=>line.startsWith('{"args":')));
    // FR-017: a new tray launch has no default model/effort; Codex user layers decide them.
    assert.deepEqual(actual.args,['codex',route,'-C',f.workspace]);assert.equal(actual.cwd,f.workspace);
  }
  const explicit=f.run('native',['-Model','gpt-6.1-sol','-ReasoningEffort','medium']);assert.equal(explicit.status,0,explicit.stderr);
  assert.deepEqual(JSON.parse(explicit.stdout.split(/\r?\n/).find(line=>line.startsWith('{"args":'))).args,['codex','native','--route-model','gpt-6.1-sol','--route-effort','medium','-C',f.workspace]);
  const high=f.run('ocx',['-Model','gpt-6.1-sol','-ReasoningEffort','high']);assert.equal(high.status,0,high.stderr);assert.match(high.stdout,/"high"/);
  const numbered=f.run('ocx',['-Account','1','-ReasoningEffort','high']);assert.equal(numbered.status,0,numbered.stderr);
  const actual=JSON.parse(numbered.stdout.split(/\r?\n/).find(line=>line.startsWith('{"args":')));
  assert.deepEqual(actual.args,['codex','ocx','--route-effort','high','--account','1','-C',f.workspace]);
  assert.match(numbered.stdout,/계정: A1/);
});
test('launcher refuses unsupported route, unsafe model, non-Git folder and changed registered route bytes before dispatch',{skip:!windows},()=>{
  const f=fixture();
  for(const result of [f.run('automatic'),f.run('native',['-Model','bad;Write-Host injected']),f.run('native',['-ReasoningEffort','automatic'])]){assert.notEqual(result.status,0);assert.doesNotMatch(result.stdout,/"args":/);}
  for(const result of [f.run('native',['-Account','1']),f.run('ocx',['-Account','1','-AccountSelector','legacy-selector'])]){assert.notEqual(result.status,0);assert.doesNotMatch(result.stdout,/"args":/);}
  const noGit=fixture(false).run('native');assert.notEqual(noGit.status,0);assert.doesNotMatch(noGit.stdout,/"args":/);
  fs.appendFileSync(path.join(f.release,'src/codex-cli-routes.mjs'),'// changed\n');
  const changed=f.run('ocx');assert.notEqual(changed.status,0);assert.doesNotMatch(changed.stdout,/"args":/);
});
