import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { readMobileAppCatalog } from '../src/mobile-app-catalog.mjs';
import { createMobileControl } from '../src/mobile-control.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-app-catalog-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const projectsRoot=path.join(root,'projects'),codexHome=path.join(root,'codex'),ownerRoot=path.join(root,'owner');
  const write=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(data));};
  const registry=path.join(projectsRoot,'web','website-workspace.json');
  const portfolioFile=path.join(codexHome,'specs','ai-work-system-upgrade','portfolio','execution.json');
  write(registry,{services:[{key:'web-app',title:'한글 앱',production_url:'https://example.com/'},{key:'pc-app',title:'PC 앱',local_url:'http://127.0.0.1:9000/'},{key:'old-app',title:'옛 앱',production_url:'https://old.example.com/',merged_into:'web-app'},{key:'secret-url',production_url:'https://example.com/?token=secret'},{key:'invalid-scheme',production_url:'javascript:alert(1)'},{key:'embedded-auth',production_url:'https://user:secret@example.com/'}]});
  write(portfolioFile,{userApprovedClassification:{products:[{key:'web-app',name:'기존 앱',functions:'앱의 목적'},{key:'future-app',name:'준비 중',functions:'원래 등록 제품'}]}});
  write(path.join(codexHome,'specs','ai-work-system-upgrade','portfolio','index.json'),{local:[]});
  write(path.join(ownerRoot,'workspace-mcp','config.json'),{projectsRoot});
  return {root,projectsRoot,codexHome,ownerRoot,portfolioFile,registry,write};
}
test('all registered products are preserved; external destinations, retired apps and unsupported updates stay distinct',t=>{
  const f=fixture(t),result=readMobileAppCatalog(f);
  assert.equal(result.status,'AVAILABLE');assert.equal(result.apps.length,8);
  assert.equal(result.apps.find(a=>a.id==='web-app').description,'앱의 목적');
  assert.equal(result.apps.find(a=>a.id==='web-app').url,'https://example.com/');
  assert.equal(result.apps.find(a=>a.id==='pc-app').state,'PC_ONLY');
  assert.equal(result.apps.find(a=>a.id==='old-app').state,'RETIRED');
  for(const id of ['old-app','secret-url','invalid-scheme','embedded-auth','future-app'])assert.equal(result.apps.find(a=>a.id===id).url,null);
  assert.equal(result.availabilityVerified,false);assert.equal(result.readOnly,true);
  assert.doesNotMatch(JSON.stringify(result),/token=secret|user:secret|9000|projectsRoot/);
  f.write(f.registry,{services:[]});assert.equal(readMobileAppCatalog(f).apps.length,3,'registry changes appear on next read without a second ledger');
});

test('different keys reconcile only through one-to-one exact source roots, preserving unrelated and ambiguous services',t=>{
  const f=fixture(t),webRoot=path.join(f.projectsRoot,'web');
  f.write(f.registry,{services:[
    {key:'web-name',canonical_path:'apps/product',production_url:'https://example.com/'},
    {key:'sibling-a',canonical_path:'apps/shared/a',production_url:'https://a.example.com/'},
    {key:'sibling-b',canonical_path:'apps/shared/b',production_url:'https://b.example.com/'},
    {key:'same-title',title:'다른 앱',canonical_path:'apps/other'},
    {key:'retired',canonical_path:'apps/product',merged_into:'web-name'}
  ]});
  f.write(f.portfolioFile,{userApprovedClassification:{products:[
    {key:'product',name:'정본 제품',functions:'정본 설명',sourceIds:['p1']},
    {key:'shared',name:'공유 제품',sourceIds:['p2','p3']},
    {key:'different',name:'다른 앱',sourceIds:[]}
  ]}});
  const inventoryFile=path.join(f.codexHome,'specs','ai-work-system-upgrade','portfolio','index.json');
  f.write(inventoryFile,{local:[{id:'p1',path:path.join(webRoot,'apps/product')},{id:'p2',path:path.join(webRoot,'apps/shared/a')},{id:'p3',path:path.join(webRoot,'apps/shared/b')}]});
  const result=readMobileAppCatalog(f);
  assert.equal(result.aliasCount,1);assert.equal(result.apps.length,8);
  assert.equal(result.apps.find(a=>a.id==='web-name').title,'정본 제품');
  assert.equal(result.apps.find(a=>a.id==='web-name').description,'정본 설명');
  assert.equal(result.apps.find(a=>a.id==='product'),undefined);
  for(const id of ['shared','sibling-a','sibling-b','different','same-title','retired'])assert.ok(result.apps.find(a=>a.id===id));
  assert.doesNotMatch(JSON.stringify(result),/sourceIds|canonical_path|apps\/product|p1/);
  f.write(inventoryFile,{local:[{id:'p1',path:path.join(webRoot,'apps/product')},{id:'p1',path:path.join(webRoot,'apps/other')}]});
  assert.equal(readMobileAppCatalog(f).aliasCount,0,'conflicting source roots never merge');
  fs.writeFileSync(inventoryFile,'{');
  const partial=readMobileAppCatalog(f);assert.equal(partial.status,'PARTIAL');assert.equal(partial.aliasCount,0);assert.ok(partial.apps.find(a=>a.id==='product'));
});
test('missing, malformed and non-file registry stay partial',t=>{
  const f=fixture(t);fs.writeFileSync(f.registry,'{');
  const result=readMobileAppCatalog(f);assert.equal(result.status,'PARTIAL');assert.ok(result.apps.find(a=>a.id==='future-app'));
  fs.unlinkSync(f.registry);fs.mkdirSync(f.registry);assert.equal(readMobileAppCatalog(f).status,'PARTIAL');
});
test('apps HTTP projection requires the existing browser session, preserves scope and accepts no mutation',async t=>{
  const f=fixture(t),mobile=createMobileControl({ownerRoot:f.ownerRoot,appCatalog:f,trayTools:{status:async()=>({catalog:[],unresolved:[]})}});
  const server=http.createServer(async(req,res)=>{try{if(!await mobile.handle(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}}catch{res.writeHead(500);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  assert.notEqual((await fetch(origin+'/api/mobile/apps')).status,200);
  const auth=await fetch(origin+'/api/mobile/local-session',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});assert.equal(auth.status,200);
  const cookie=auth.headers.get('set-cookie').split(';')[0];
  const reply=await fetch(origin+'/api/mobile/apps',{headers:{cookie}});assert.equal(reply.status,200);assert.equal((await reply.json()).apps.length,8);
  assert.notEqual((await fetch(origin+'/api/mobile/apps',{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:'{}'})).status,200);
  assert.equal((await fetch(origin+'/api/mobile/apps',{headers:{cookie,origin:'https://other.example.com'}})).status,403);
});
