import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PendingWorkInbox } from '../src/control-plane/pending-work.mjs';
import { readPendingWorkSummary } from '../src/control-plane/pending-work-status.mjs';

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pending-summary-'));
  const inboxRoot=path.join(root,'pending-work');fs.mkdirSync(inboxRoot);
  const inbox=new PendingWorkInbox(inboxRoot);
  const request={id:'request-001',title:'영상 품질 심사',priority:'P1',projectRoot:root,
    origin:{displayName:'콘텐츠 지피티',conversationUrl:'https://chat.example.invalid/c/demo',identityEvidence:'fixture-only'},
    objective:'private-objective',nextAction:'private-next-action'};
  return {root,inboxRoot,inbox,request,read:()=>readPendingWorkSummary({stateRoot:root})};
}
test('owner metadata stays ordered and read-only without exposing prompt, root, identity evidence or granting completion',()=>{
  const f=fixture();f.inbox.register(f.request);f.inbox.register({...f.request,id:'request-002',priority:'P0'});
  const file=path.join(f.inboxRoot,'request-001.md'),before=fs.readFileSync(file);
  const r=f.read();assert.equal(r.status,'AVAILABLE');assert.equal(r.total,2);
  assert.equal(r.items[0].priority,'P0');assert.equal(r.items[0].displayName,'콘텐츠 지피티');
  assert.equal(r.items[0].conversationUrl,f.request.origin.conversationUrl);
  assert.equal(r.automaticDispatch,false);assert.equal(r.developmentCompleted,false);
  for(const secret of ['private-objective','private-next-action',f.root,'fixture-only','request-001'])assert.equal(JSON.stringify(r).includes(secret),false);
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(file+'.lock'),false);
});
test('unknown origin and merged state retain uncertainty and do not claim development completion',()=>{
  const f=fixture();let row=f.inbox.register({...f.request,origin:{...f.request.origin,displayName:'미확인',conversationUrl:null}});
  row=f.inbox.transition(row.id,{action:'claim',owner:'central',expectedSha256:row.sha256});
  assert.equal(f.read().items[0].state,'CLAIMED');assert.equal(f.read().items[0].conversationUrl,null);
  const canonicalPath=path.join(f.root,'PROJECT.md');fs.writeFileSync(canonicalPath,'accepted request');
  f.inbox.transition(row.id,{action:'merge',owner:'central',expectedSha256:row.sha256,canonicalPath,
    canonicalSha256:crypto.createHash('sha256').update(fs.readFileSync(canonicalPath)).digest('hex')});
  assert.equal(f.read().items[0].state,'MERGED');assert.equal(f.read().items[0].developmentCompleted,false);
});
test('legacy or corrupt items never make the inbox look empty; valid items remain visible',()=>{
  const f=fixture();fs.writeFileSync(path.join(f.inboxRoot,'README.md'),'readme');assert.equal(f.read().status,'EMPTY');
  fs.writeFileSync(path.join(f.inboxRoot,'old.md'),'preserved');assert.equal(f.read().status,'UNKNOWN');
  f.inbox.register(f.request);const r=f.read();assert.equal(r.status,'AVAILABLE');assert.equal(r.partial,true);assert.equal(r.total,null);
  assert.equal(r.items.length,1);assert.equal(fs.readFileSync(path.join(f.inboxRoot,'old.md'),'utf8'),'preserved');
});
test('malformed URL and state are rejected instead of becoming links or empty success',()=>{
  for(const change of [s=>s.replace('https://chat.example.invalid/c/demo','javascript:alert(1)'),s=>s.replace('"state": "PENDING"','"state": "COMPLETED"')]){
    const f=fixture();f.inbox.register(f.request);const file=path.join(f.inboxRoot,'request-001.md');fs.writeFileSync(file,change(fs.readFileSync(file,'utf8')));assert.equal(f.read().status,'UNKNOWN');
  }
});

test('legacy-only documents are counted without pretending the inbox is empty or unreadable',()=>{
  const f=fixture(),file=path.join(f.inboxRoot,'legacy-request.md');
  const original=Buffer.from('# Existing owner request\nprivate-objective');fs.writeFileSync(file,original);
  const r=f.read();assert.equal(r.status,'LEGACY_ONLY');assert.equal(r.partial,true);
  assert.equal(r.legacyCount,1);assert.equal(r.unreadableCount,0);assert.equal(r.total,null);
  assert.equal(r.items.length,0);assert.equal(r.automaticDispatch,false);
  for(const secret of ['legacy-request','private-objective',f.root])assert.equal(JSON.stringify(r).includes(secret),false);
  assert.deepEqual(fs.readFileSync(file),original);
});

test('a damaged managed record cannot be hidden by legacy-only classification',()=>{
  const f=fixture();fs.writeFileSync(path.join(f.inboxRoot,'legacy-request.md'),'legacy');
  const file=path.join(f.inboxRoot,'broken-request.md');fs.writeFileSync(file,'<!-- aicc-pending-work-v1\n{broken}\n-->\n');
  const r=f.read();assert.equal(r.status,'UNKNOWN');assert.equal(r.legacyCount,1);
  assert.equal(r.unreadableCount,1);assert.equal(r.total,null);
  f.inbox.register(f.request);const mixed=f.read();assert.equal(mixed.status,'AVAILABLE');
  assert.equal(mixed.items.length,1);assert.equal(mixed.partial,true);assert.equal(mixed.unreadableCount,1);
  fs.writeFileSync(file,'<!-- aicc-pending-work-v1\n{unfinished');
  assert.equal(f.read().unreadableCount,1);
});
test('missing inbox stays missing and results remain bounded',()=>{
  const f=fixture();const absent=path.join(f.root,'other');fs.mkdirSync(absent);
  assert.equal(readPendingWorkSummary({stateRoot:absent}).status,'NOT_INITIALIZED');assert.equal(fs.existsSync(path.join(absent,'pending-work')),false);
  for(let i=0;i<25;i++)f.inbox.register({...f.request,id:'request-'+String(i).padStart(3,'0')});
  const r=f.read();assert.equal(r.items.length,24);assert.equal(r.total,25);assert.equal(r.truncated,true);
});
test('hardlinked records are not exposed and HTML-looking labels remain plain data',()=>{
  const f=fixture();f.inbox.register({...f.request,title:'<img src=x onerror=alert(1)>'});
  assert.equal(f.read().items[0].title,'<img src=x onerror=alert(1)>');
  fs.linkSync(path.join(f.inboxRoot,'request-001.md'),path.join(f.root,'record-copy.md'));
  assert.equal(f.read().status,'UNKNOWN');
});
