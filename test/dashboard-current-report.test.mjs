import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createDashboardWorkspace} from '../src/dashboard-workspace.mjs';
import {createServer} from '../src/server.mjs';
const thread='12345678-1234-4234-8234-123456789abc', central='23456789-2345-4345-8345-234567890abc';
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-current-report-')),ownerRoot=path.join(root,'owner'),workers=path.join(root,'workers'),portfolioRoot=path.join(root,'portfolio');
 const write=(f,v)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(v));};
 const at=new Date(Date.now()-10000).toISOString(), old=new Date(Date.now()-60000).toISOString();
 write(path.join(portfolioRoot,'group-registry.json'),{groups:[{id:'G3',name:'대시보드'}]});write(path.join(portfolioRoot,'execution.json'),{});
 write(path.join(workers,'G3.state.json'),{jobId:'G3',threadId:thread,root,state:'held',updatedAt:old,lastResult:path.join(workers,'G3.old.json')});write(path.join(workers,'G3.old.json'),{status:'blocked',summary:'과거 실패',remaining:['옛 잔여']});
 write(path.join(workers,'run.json'),{controllerThreadId:central,jobs:[{id:'G3',threadId:thread,root,session:'current-session'}]});
 const result={status:'partial',summary:'최신 설치 완료 / 제품 partial',remaining:['실화면 미완료'],blockers:[],nextAction:'중앙 인수',ownership:{state:'RETURNED_TO_EXISTING_CENTRAL',root,fromThread:thread,returnedTo:central,returnedAt:at}};
 const file=path.join(workers,'G3.current.result.json');write(file,result);
 const unit={thread,state:'COMPLETED_PARTIAL_INSTALLED_TESTED_ROOT_RETURNED',officialTurnStatus:'completed',result:path.basename(file),resultSha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),completedAt:at,scope:'current-unit'};
 const registration={group:'G3',thread,latestUnit:unit};
 const registry=path.join(workers,'followup-dispatch-20261102.json');write(registry,{central,dispatches:[registration]});
 const options={ownerRoot,workerStateRoot:workers,portfolioRoot,codexHome:root};return {root,ownerRoot,workers,write,file,result,unit,registration,registry,options,service:createDashboardWorkspace(options),save(){write(file,result);unit.resultSha256=createHash('sha256').update(fs.readFileSync(file)).digest('hex');write(registry,{central,dispatches:[registration]});}};
}
test('latest registered partial result replaces stale display only; exact identity, pin and pending remain separate',()=>{
 const f=fixture(),a=f.service.status().agents[0];assert.equal(a.summary,f.result.summary);assert.equal(a.state,'held');assert.equal(a.complete,false);assert.equal(a.archived,false);assert.equal(a.unitReport.ownership,'RETURNED_TO_EXISTING_CENTRAL');assert.equal(a.updatedAt,f.unit.completedAt);assert.equal(a.resumeCommand,null);
 f.service.commit({action:'pin',agentId:thread,pinned:true,expectedRevision:0},'pin');assert.equal(f.service.status().agents[0].pinned,true);
 f.write(path.join(f.ownerRoot,'control-plane/codex-continuity/registrations.json'),{threads:{[thread]:{state:'UNKNOWN',queueAttempt:{id:'original',state:'QUEUE_DELIVERY_UNCERTAIN',transport:'codex-queue'}}}});
 const after=f.service.status();assert.equal(after.agents[0].complete,false);assert.equal(after.registeredQueue[0].pendingAttempt,true);
});
test('active registration uses only explicit previous settled result, never promotes active/UNKNOWN to complete',()=>{
 const f=fixture();f.registration.latestUnit={thread,state:'UNKNOWN',result:'G3.unregistered.result.json',previousSettledUnit:{...f.unit}};f.save();const a=f.service.status().agents[0];assert.equal(a.summary,f.result.summary);assert.equal(a.unitReport.currentRegistrationState,'UNKNOWN');assert.equal(a.complete,false);assert.equal(a.unitReport.executionVerified,false);
});
test('wrong thread/root/hash/path, stale/future timestamps and unfinished turn reject result',()=>{
 for(const mutate of [f=>f.unit.thread=central,f=>f.result.ownership.root=path.dirname(f.root),f=>f.result.ownership.fromThread=central,f=>f.result.ownership.returnedTo=thread,f=>f.unit.result='../G3.current.result.json',f=>f.unit.completedAt='2000-01-01T00:00:00Z',f=>f.unit.completedAt=new Date(Date.now()+60000).toISOString(),f=>f.unit.officialTurnStatus='active',f=>f.result.ownership.returnedAt='2000-01-01T00:00:00Z',f=>f.result.remaining='invalid']){const f=fixture();mutate(f);f.save();assert.equal(f.service.status().agents[0].summary,'과거 실패');}
 const f=fixture();fs.appendFileSync(f.file,' ');assert.equal(f.service.status().agents[0].summary,'과거 실패');
 const g=fixture();g.write(path.join(g.workers,'G3.unregistered.result.json'),{...g.result,summary:'not registered'});assert.equal(g.service.status().agents[0].summary,g.result.summary);
});
test('HTTP projects registered result and leaves source records unchanged',async t=>{
 const f=fixture(),before=fs.readFileSync(f.registry),server=createServer({goals:{ownerRoot:f.ownerRoot},mobile:{ownerRoot:f.ownerRoot,dashboard:f.service,trayTools:{status:async()=>({catalog:[],unresolved:[]})}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const origin=`http://127.0.0.1:${server.address().port}`;
 const session=await fetch(origin+'/api/mobile/local-session',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'}),cookie=session.headers.get('set-cookie').split(';')[0];const data=await(await fetch(origin+'/api/mobile/dashboard',{headers:{cookie}})).json();assert.equal(data.agents[0].unitReport.status,'partial');assert.equal(data.agents[0].state,'held');assert.deepEqual(fs.readFileSync(f.registry),before);assert.doesNotMatch(JSON.stringify(data),new RegExp(f.root.replaceAll('\\','\\\\')));
});
