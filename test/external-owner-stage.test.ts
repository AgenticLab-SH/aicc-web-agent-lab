import {test,expect} from 'bun:test';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtempSync,symlinkSync,writeFileSync,mkdirSync} from 'node:fs';
import {assertPlainStagePaths,resolveOwnerStage,stageCandidatePolicyMatches,stageRequestAllowed} from '../tools/platform/opencodex/external-owner-stage';

function fixture(){
 const now=Date.now(),osHome=process.env.USERPROFILE!;
 const id='a'.repeat(32),profile=join(osHome,'.ai-control-center','backups','ocx-original-owner-staging',id);
 const home=join(profile,'.ai-control-center','runtime','ocx-local','home');
 return {now,osHome,profile,registry:{opencodexHome:home,tokenFile:join(home,'api-auth-token'),
 originalOwnerStage:{schemaVersion:1,id,mode:'identity-and-attachment-only',
 expiresAt:new Date(now+60_000).toISOString(),dataPort:50100,managementPort:50101}}};
}
test('ordinary registered runtime retains its original contract',()=>{
 expect(resolveOwnerStage({},'unused','unused')).toBeUndefined();
 expect(stageRequestAllowed(undefined,'POST','/v1/responses')).toBe(true);
});
test('bounded exact owner stage allows identity but blocks all inference and mutations',()=>{
 const f=fixture(),s=resolveOwnerStage(f.registry,f.profile,f.osHome,f.now)!;
 expect(s.managementPort).toBe(50101);
 expect(stageRequestAllowed(s,'GET','/api/aicc-local/original-issuer/identity',f.now)).toBe(true);
 for(const path of ['/v1/responses','/v1/models','/api/aicc-local/sync','/api/codex-auth/accounts','/'])
  for(const method of ['GET','POST'])expect(stageRequestAllowed(s,method,path,f.now)).toBe(false);
 expect(stageRequestAllowed(s,'POST','/api/aicc-local/original-issuer/identity',f.now)).toBe(false);
 expect(stageRequestAllowed(s,'GET','/healthz',s.expiresAt)).toBe(false);
});
test('operating profile, foreign root and token path cannot become a stage',()=>{
 for(const kind of ['operating','foreign','home','token']){
  const f=fixture();if(kind==='operating')f.profile=f.osHome;
  if(kind==='foreign')f.profile+='-other';
  if(kind==='home')f.registry.opencodexHome=f.osHome;
  if(kind==='token')f.registry.tokenFile=join(f.osHome,'api-auth-token');
  expect(()=>resolveOwnerStage(f.registry,f.profile,f.osHome,f.now)).toThrow();
 }
});
test('expired, unbounded, operating-port and unknown-field contracts refuse',()=>{
 for(const change of [{expiresAt:new Date(0).toISOString()},{expiresAt:new Date(Date.now()+16*60_000).toISOString()},
 {dataPort:10100},{managementPort:10101},{managementPort:50100},{dataPort:'50100'},{allowDispatch:true},
 {mode:'full'}, {id:'../foreign'}]){
  const f=fixture();Object.assign(f.registry.originalOwnerStage,change);
  expect(()=>resolveOwnerStage(f.registry,f.profile,f.osHome,f.now)).toThrow();
 }
});
test('non-activatable shipping plans require a stage and matching immutable policies',()=>{
 const f=fixture(),s=resolveOwnerStage(f.registry,f.profile,f.osHome,f.now)!;
 const policy={protocol:'retained-child-bootstrap/v1',artifactContract:'shipping-cli-appserver/v1',
  originalTuiAttachment:'SHIPPING_BUILD_CANDIDATE_ONLY',canActivate:false,
  bunSha256:'a'.repeat(64),shippingBuildSha256:'b'.repeat(64)};
 expect(stageCandidatePolicyMatches(s,policy,{...policy})).toBe(true);
 expect(stageCandidatePolicyMatches(undefined,policy,policy)).toBe(false);
 for(const change of [{canActivate:true},{canActivate:'false'},{artifactContract:'shipping-cli-appserver/v2'},
  {originalTuiAttachment:'ACTUAL_SHIPPING_ACCEPTED'},{protocol:'other'},
  {bunSha256:'c'.repeat(64)},{shippingBuildSha256:'d'.repeat(64)}]) {
  expect(stageCandidatePolicyMatches(s,policy,{...policy,...change})).toBe(false);
 }
});
test('stage path inspection rejects a junction without following it',()=>{
 const base=mkdtempSync(join(tmpdir(),'aicc-stage-alias-')),plain=join(base,'plain'),alias=join(base,'alias');
 mkdirSync(plain);writeFileSync(join(plain,'receipt.json'),'{}');
 assertPlainStagePaths([join(plain,'receipt.json')]);
 symlinkSync(plain,alias,'junction');
 expect(()=>assertPlainStagePaths([join(alias,'receipt.json')])).toThrow('original_owner_stage_alias_refused');
});
test('actual loopback HTTP gate never invokes downstream dispatch or management mutations',async()=>{
 const f=fixture(),s=resolveOwnerStage(f.registry,f.profile,f.osHome,f.now)!;
 let dispatch=0,identity=0;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){
  const path=new URL(request.url).pathname;
  if(!stageRequestAllowed(s,request.method,path))return new Response('stage refused',{status:403});
  if(path==='/api/aicc-local/original-issuer/identity'){identity++;return Response.json({identityOnly:true});}
  dispatch++;return new Response('unexpected');
 }});
 try{
  const origin=`http://127.0.0.1:${server.port}`;
  for(const path of ['/v1/responses','/responses','/api/aicc-local/original-issuer/admission','/api/aicc-local/sync']){
   const response=await fetch(origin+path,{method:'POST',body:'{}'});expect(response.status).toBe(403);await response.text();
  }
  const response=await fetch(origin+'/api/aicc-local/original-issuer/identity');expect(response.status).toBe(200);await response.text();
  expect(dispatch).toBe(0);expect(identity).toBe(1);
 }finally{server.stop(true);}
});
