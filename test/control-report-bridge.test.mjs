import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ControlReportStore} from '../src/control-plane/report-store.mjs';
import {NotificationOutboxService} from '../src/notifications/outbox-service.mjs';
import {collectControlReportNotifications,renderControlReport} from '../src/notifications/control-report-bridge.mjs';
const at='2026-11-20T01:00:00Z';
const config={schemaVersion:1,enabled:true,enabledAt:at,workers:[{workerId:'g1',projectKey:'ai-platform',taskId:'exact-owner',label:'G1 자동재개'}]};
const report={workerId:'g1',workerSequence:1,status:'PROGRESS',summary:'연결 수리 검증',completed:['소유 프로세스 확인'],remaining:['설치 검증'],nextAction:'원 계정 검증',updatedAt:at};
function fixture(worker=report){const events=new Map();return {events,reports:{status:()=>({workers:{g1:worker}})},outbox:{list:()=>[...events.values()].map(e=>({...e,state:'waiting'})),arm:(e)=>{const duplicate=events.has(e.eventId);events.set(e.eventId,e);return {duplicate,notification:{state:'waiting'}};}}};}
test('changed structured result arms existing outbox, repeated sequence/time does not repeat',()=>{
 const f=fixture();const run=()=>collectControlReportNotifications(config,f);
 assert.equal(run().results[0].duplicate,false);report.workerSequence++;report.updatedAt='2026-11-20T01:01:00Z';
 assert.equal(run().results[0].duplicate,true);assert.equal(f.events.size,1);
 assert.match([...f.events.values()][0].summary,/G1.*반영:[\s\S]*남음:[\s\S]*다음:/s);
});
test('old, unmapped and progress without delivered work send nothing',()=>{
 for(const worker of [{...report,updatedAt:'2026-01-01T00:00:00Z'},{...report,completed:[]}])assert.equal(collectControlReportNotifications(config,fixture(worker)).results.length,0);
 assert.equal(collectControlReportNotifications({...config,workers:[]},fixture()).results.length,0);
});
test('approval is attention, DONE is only a unit result and secrets/paths are not published',()=>{
 const f=fixture({...report,status:'APPROVAL_REQUIRED',nextGate:'사용자 선택'});collectControlReportNotifications(config,f);
 assert.equal([...f.events.values()][0].urgency,4);
 const rendered=renderControlReport({...report,status:'DONE',summary:'C:\\private\\file https://private.example/x password=abc xoxb-example user@example.com'},'G1');
 assert.match(rendered,/단위 결과 완료/);assert.doesNotMatch(rendered,/private|password=abc|xoxb-|user@example/);assert.ok(rendered.length<=700);
});
test('invalid or disabled bindings fail before arming any event',()=>{
 const f=fixture();assert.throws(()=>collectControlReportNotifications({...config,enabled:false},f));
 assert.throws(()=>collectControlReportNotifications({...config,workers:[config.workers[0],{workerId:'bad binding'}]},f));assert.equal(f.events.size,0);
});
test('actual report journal and durable outbox dedupe survives timestamp changes and restart',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-report-bridge-'));
 const reports=new ControlReportStore({stateRoot:root,now:()=>Date.parse(at)});
 const input={schemaVersion:1,controlPlaneId:'integrated-work-control',workerId:'g1',workerSequence:1,status:'DONE',revision:'test-r1',summary:'검증 완료',completed:['격리 검증'],remaining:['운영 설치'],nextAction:'기존 후보 인수'};
 reports.write(input);
 const first=collectControlReportNotifications(config,{stateRoot:root,reports});assert.equal(first.results[0].state,'waiting');
 const later=new ControlReportStore({stateRoot:root,now:()=>Date.parse(at)+60000});later.write({...input,workerSequence:2,revision:'test-r2'});
 const second=collectControlReportNotifications(config,{stateRoot:root,reports:later});assert.equal(second.results[0].duplicate,true);
 const outbox=new NotificationOutboxService({root:path.join(root,'notifications','outbox')});assert.equal(outbox.list({projectKey:'ai-platform',taskId:'exact-owner'}).length,1);
 // Leave the tiny test-owned evidence directory; Windows cleanup is owner-managed.
});
