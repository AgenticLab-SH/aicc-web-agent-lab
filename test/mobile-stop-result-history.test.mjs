import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const sha=x=>createHash('sha256').update(x).digest('hex');
const runner=fileURLToPath(new URL('../tools/platform/windows/mobile-public-runner.mjs',import.meta.url));
const delay=()=>new Promise(r=>setTimeout(r,20));
async function until(read){const end=Date.now()+5000;do{const value=read();if(value)return value;await delay();}while(Date.now()<end);throw Error('fixture_timeout');}
function fixture(){
 const owner=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-stop-results-'));
 const runtimeId=randomUUID(),release=path.join(owner,'releases','cli','fixture');
 const dir=path.join(owner,'control-plane','mobile-public-runtime',runtimeId);
 const statusFile=path.join(owner,'runtime','mobile-public-control',runtimeId,'status.json');
 const names=['src/server.mjs','src/mobile-control.mjs','src/mobile-device-trust.mjs','src/dashboard-workspace.mjs','src/management-overview.mjs','src/goals/service.mjs','src/goals/user-action-ledger.mjs','public/mobile.html','public/mobile.js','public/dashboard-workspace.js','public/dashboard-workspace.css','public/aicc.webmanifest','public/aicc-sw.js','public/favicon.svg','public/aicc-icon-192.png','public/aicc-icon-512.png'];
 const server="import {EventEmitter} from 'node:events'; export function startServer(){const s=new EventEmitter();let calls=0;s.beginMobileMaintenance=()=>({accepted:++calls===3,deviceTrustPreserved:true});s.close=cb=>setImmediate(cb);setImmediate(()=>s.emit('listening'));return s;}";
 const files=names.map(name=>{const file=path.join(release,name),bytes=Buffer.from(name==='src/server.mjs'?server:'fixture');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return {path:name,sha256:sha(bytes)};});
 const manifest=JSON.stringify({schemaVersion:1,component:'mobile-public-control',files});fs.writeFileSync(path.join(release,'.aicc-release.json'),manifest);
 fs.mkdirSync(dir,{recursive:true});const configFile=path.join(dir,'runtime.json');
 const cfg={schemaVersion:1,runtimeId,controlNonce:'a'.repeat(64),releaseManifestSha256:sha(manifest),port:4383,releaseRoot:release,remoteOrigin:'https://fixture.invalid',statusFile};
 fs.writeFileSync(configFile,JSON.stringify(cfg));
 return {owner,dir,statusFile,cfg,configFile};
}
for (const mode of ['normal','wrong-claim','existing-result'])
test('real runner retains stop results without replay: '+mode, {timeout:10000},async()=>{
 const f=fixture(),child=spawn(process.execPath,[runner,f.configFile],{env:{...process.env,AICC_STATE_ROOT:f.owner},windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr+=b);child.stdout.resume();
 const exit=new Promise(resolve=>child.once('exit',code=>resolve(code)));
 const status=()=>fs.existsSync(f.statusFile)?JSON.parse(fs.readFileSync(f.statusFile,'utf8')):null;
 try{
  const start=await until(()=>status()?.state==='LISTENING'&&status()),receipts=[];
  for(let i=0;i<3;i++){
   const operationId=randomUUID(),dir=path.join(f.dir,'stop-requests',operationId);fs.mkdirSync(dir,{recursive:true});
   const request={action:'drain-and-stop',operationId,runtimeId:f.cfg.runtimeId,expectedPid:child.pid,expectedStartedAt:start.startedAt,releaseManifestSha256:f.cfg.releaseManifestSha256,expiresAt:new Date(Date.now()+30000).toISOString()};
   const bytes=JSON.stringify(request);fs.writeFileSync(path.join(dir,'request.json'),bytes);
   fs.writeFileSync(path.join(dir,'claim.json'),JSON.stringify({schemaVersion:1,operationId,runtimeId:f.cfg.runtimeId,pid:child.pid,requestSha256:i===0&&mode==='wrong-claim'?'0'.repeat(64):sha(bytes),state:'CLAIMED_INPUT_OUTCOME_UNKNOWN'}));
   const file=path.join(dir,'result.json');
   if(i===0&&mode==='existing-result')fs.writeFileSync(file,'{"historical":"preserve"}');
   const line=JSON.stringify({...request,controlNonce:f.cfg.controlNonce})+'\n';child.stdin.write(line);
   if(i===0&&mode!=='normal'){
    await until(()=>status()?.lastOperationId===operationId&&status()?.lastStopResult==='UNKNOWN');
    if(mode==='wrong-claim')assert.equal(fs.existsSync(file),false);
    else assert.equal(fs.readFileSync(file,'utf8'),'{"historical":"preserve"}');
    child.stdin.write(line);await delay();assert.equal(status().lastStopResult,'UNKNOWN');
    continue;
   }
   await until(()=>fs.existsSync(file)&&status()?.lastOperationId===operationId);
   const saved=fs.readFileSync(file,'utf8'),r=JSON.parse(saved);receipts.push({file,saved});
   assert.equal(r.lastStopResult,i===2?'NORMAL_STOP_ACK':'WORK_PRESERVED');assert.equal(r.requestSha256,sha(bytes));assert.equal(r.startedAt,start.startedAt);assert.equal(r.automaticReplay,false);
   assert.ok(!saved.includes(f.cfg.controlNonce));
   if(i<2){child.stdin.write(line);await delay();assert.equal(fs.readFileSync(file,'utf8'),saved);}
  }
  for(const {file,saved} of receipts)assert.equal(fs.readFileSync(file,'utf8'),saved);
  assert.equal(status().state,'NORMAL_STOPPED');assert.equal(await exit,0,stderr);
 }finally{child.stdin.end();}
});
