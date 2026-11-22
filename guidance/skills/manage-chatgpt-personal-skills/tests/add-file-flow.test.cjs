'use strict';
// add-file ordering and outcome classification with a fake page driver. No ChatGPT access.
const test=require('node:test'),assert=require('node:assert/strict');
const {addFileFlow,treeHash}=require('../scripts/personal-skill-manager.cjs');
const {fakeDriver,writes,sha,SKILL_BODY}=require('./fake-editor-driver.cjs');
const BODY='# New reference\n\nExact desired text.\n';
const BEFORE_FILES=['SKILL.md','agents/openai.yaml','references/manager-contract.md'];
const base=(over={})=>({account:'alias-a',name:'example',skillId:'abcdef0123456789',filePath:'references/new-file.md',desiredBody:BODY,desiredSourceSHA256:sha(BODY),
 commit:true,expectedTreeSha:treeHash(BEFORE_FILES),expectedCurrentSha:sha(SKILL_BODY),...over});
function deps(over={}){
 const log={identity:[],gate:0,begin:0};
 return {log,deps:{verifyIdentity:async stage=>{log.identity.push(stage);if(over.identityFailAt===stage)throw Error('HOLD_IDENTITY_MISMATCH: live session identity differs')},
  assertGate:()=>{log.gate++;if(over.gateError)throw Error(over.gateError);return {bundleSHA256:'b'.repeat(64)}},
  beginMutation:()=>{log.begin++;if(over.beginError)throw Error(over.beginError)}}};
}
const saves=drv=>drv.calls.filter(c=>c[0]==='clickSave').length;

test('dry run reads tree and SKILL preimage, checks the gate, performs no write',async()=>{
 const drv=fakeDriver(),{log,deps:d}=deps();
 const r=await addFileFlow(drv,base({commit:false,expectedTreeSha:undefined,expectedCurrentSha:undefined}),d);
 assert.equal(r.status,'ADD_FILE_PLAN_READY');
 assert.equal(r.currentTreeSHA256,treeHash(BEFORE_FILES));assert.equal(r.currentSkillSHA256,sha(SKILL_BODY));
 assert.deepEqual(writes(drv.calls),[]);assert.equal(log.gate,1);assert.equal(log.begin,0);
 assert.equal(r.remoteMutation,false);assert.equal(r.confirm,'ADD-FILE:abcdef0123456789:references/new-file.md');
});

test('existing target path is refused before any draft or gate',async()=>{
 const drv=fakeDriver(),{log,deps:d}=deps();
 const r=await addFileFlow(drv,base({filePath:'references/manager-contract.md'}),d);
 assert.equal(r.status,'REFUSED_ADD_FILE_PATH_EXISTS');assert.deepEqual(writes(drv.calls),[]);assert.equal(log.gate,0);assert.equal(log.begin,0);
});

test('identity mismatch is HOLD before reading or writing',async()=>{
 const drv=fakeDriver(),{log,deps:d}=deps({identityFailAt:'editor'});
 const r=await addFileFlow(drv,base(),d);
 assert.equal(r.status,'HOLD_IDENTITY_MISMATCH');assert.equal(drv.calls.length,0);assert.equal(log.begin,0);
});

test('identity mismatch right before Save is HOLD with zero save clicks and no mutation start',async()=>{
 const drv=fakeDriver(),{log,deps:d}=deps({identityFailAt:'before-save'});
 const r=await addFileFlow(drv,base(),d);
 assert.equal(r.status,'HOLD_IDENTITY_MISMATCH');assert.equal(saves(drv),0);assert.equal(log.begin,0);assert.equal(r.remoteMutation,false);
});

test('missing backup gate is HOLD with no draft',async()=>{
 const drv=fakeDriver(),{log,deps:d}=deps({gateError:'HOLD_BACKUP_REQUIRED: absolute receipt path required'});
 const r=await addFileFlow(drv,base(),d);
 assert.equal(r.status,'HOLD_BACKUP_REQUIRED');assert.deepEqual(writes(drv.calls),[]);assert.equal(log.begin,0);
});

test('used receipt (one-use lock) is HOLD and Save is never clicked',async()=>{
 const drv=fakeDriver(),{deps:d}=deps({beginError:'HOLD_MUTATION_ALREADY_ATTEMPTED: reconcile original result, do not replay'});
 const r=await addFileFlow(drv,base(),d);
 assert.equal(r.status,'HOLD_MUTATION_ALREADY_ATTEMPTED');assert.equal(saves(drv),0);assert.equal(r.remoteMutation,false);
});

test('preimage conflict stops before the draft',async()=>{
 const drv=fakeDriver(),{log,deps:d}=deps();
 const r=await addFileFlow(drv,base({expectedCurrentSha:'0'.repeat(64)}),d);
 assert.equal(r.status,'HOLD_ADD_FILE_PREIMAGE_CONFLICT');assert.deepEqual(writes(drv.calls),[]);assert.equal(log.begin,0);
});

test('missing target folder is HOLD and absence is not inferred',async()=>{
 const drv=fakeDriver({folderExists:false}),{deps:d}=deps();
 const r=await addFileFlow(drv,base(),d);
 assert.equal(r.status,'HOLD_ADD_FILE_FOLDER_UNPROVEN');assert.deepEqual(writes(drv.calls),[]);
});

test('unobserved draft shape or failed rename stays local HOLD without Save',async()=>{
 for(const [opt,status] of [[{draftName:'Untitled-1.md'},'HOLD_ADD_FILE_DRAFT_UNOBSERVED'],[{renameWorks:false},'HOLD_ADD_FILE_RENAME_UNPROVEN'],[{inputEcho:false},'HOLD_ADD_FILE_INPUT_MISMATCH'],[{saveEnabled:false},'HOLD_ADD_FILE_SAVE_UNAVAILABLE']]){
  const drv=fakeDriver(opt),{log,deps:d}=deps();
  const r=await addFileFlow(drv,base(),d);
  assert.equal(r.status,status);assert.equal(saves(drv),0);assert.equal(log.begin,0);assert.equal(r.remoteMutation,false);
 }
});

test('verified add: one gate, one mutation start, one Save, fresh readback of tree and body',async()=>{
 const drv=fakeDriver(),{log,deps:d}=deps();
 const r=await addFileFlow(drv,base(),d);
 assert.equal(r.status,'file_added_verified');assert.equal(r.verified,true);
 assert.equal(saves(drv),1);assert.equal(log.gate,1);assert.equal(log.begin,1);
 assert.equal(r.afterTreeSHA256,treeHash([...BEFORE_FILES,'references/new-file.md']));
 assert.equal(r.afterBodySHA256,sha(BODY));assert.equal(r.skillUnchanged,true);
 assert.deepEqual(log.identity,['editor','before-save','readback']);
 const order=drv.calls.map(c=>c[0]);
 assert.ok(order.indexOf('clickSave')<order.indexOf('reloadFresh'));
 assert.ok(order.indexOf('renameFile')<order.indexOf('setBody'));
});

test('readback body mismatch is FAILED without a second Save',async()=>{
 const drv=fakeDriver({save:'persist-wrong-body'}),{deps:d}=deps();
 const r=await addFileFlow(drv,base(),d);
 assert.equal(r.status,'FAILED_ADD_FILE_READBACK_MISMATCH');assert.equal(r.verified,false);assert.equal(saves(drv),1);assert.equal(r.remoteMutation,true);
});

test('saved under the draft name is FAILED_ADD_FILE_WRONG_PATH',async()=>{
 const drv=fakeDriver({save:'persist-wrong-path'}),{deps:d}=deps();
 const r=await addFileFlow(drv,base(),d);
 assert.equal(r.status,'FAILED_ADD_FILE_WRONG_PATH');assert.equal(saves(drv),1);
});

test('collateral SKILL.md change is FAILED',async()=>{
 const drv=fakeDriver({save:'persist-collateral'}),{deps:d}=deps();
 const r=await addFileFlow(drv,base(),d);
 assert.equal(r.status,'FAILED_ADD_FILE_COLLATERAL_CHANGE');assert.equal(r.skillUnchanged,false);assert.equal(saves(drv),1);
});

test('uncertain Save click is UNKNOWN with zero retries or re-clicks',async()=>{
 const drv=fakeDriver({save:'throw'}),{deps:d}=deps();
 const r=await addFileFlow(drv,base(),d);
 assert.equal(r.status,'UNKNOWN_ADD_FILE_OUTCOME');assert.equal(saves(drv),1);assert.equal(r.remoteMutation,true);assert.equal(r.automaticRetry,false);
 assert.equal(drv.calls.filter(c=>c[0]==='reloadFresh').length,0);
});

test('no persisted path after bounded read-only observation is UNKNOWN, Save not replayed',async()=>{
 const drv=fakeDriver({save:'none'}),{deps:d}=deps();
 const r=await addFileFlow(drv,base(),d);
 assert.equal(r.status,'UNKNOWN_ADD_FILE_OUTCOME');assert.equal(saves(drv),1);
 assert.equal(drv.calls.filter(c=>c[0]==='reloadFresh').length,4);
});

test('reload failure after Save is UNKNOWN, not FAILED or retried',async()=>{
 const drv=fakeDriver({reload:'throw'}),{deps:d}=deps();
 const r=await addFileFlow(drv,base(),d);
 assert.equal(r.status,'UNKNOWN_ADD_FILE_OUTCOME');assert.equal(saves(drv),1);assert.match(r.reason,/readback failed/);
});
