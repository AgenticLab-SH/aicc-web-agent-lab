'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {prepareNamedAddFileRequest}=require('../scripts/personal-skill-manager.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
test('fixed-host add-file adapter preserves trusted identity and rejects remote authority',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'aicc-add-named-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const bodyFile=path.join(root,'body.md'),identityModule=path.join(root,'identity.mjs');
 fs.writeFileSync(bodyFile,'# Reference\n\nNew material.\n');fs.writeFileSync(identityModule,'export {}');
 const owner={account:'owner-alias',config:path.join(root,'config.json'),identityModule,identityHash:'a'.repeat(64),workspaceIdentityHash:'b'.repeat(64)};
 const skill={name:'example',displayName:'Example',skillId:'skill-test-0001',filePath:'references/new-file.md',bodyFile,bodyFileSHA256:sha(fs.readFileSync(bodyFile))};
 const plan={schemaVersion:1,action:'personal-skill-plan-add-file',skill,backupReceipt:path.join(root,'receipt.json')};
 const prepared=prepareNamedAddFileRequest(plan,owner);
 assert.equal(prepared.command,'add-file');assert.equal(prepared.commit,false);assert.equal(prepared.account,owner.account);
 assert.equal(prepared.expectedIdentityHash,owner.identityHash);assert.equal(prepared.desiredSourceSHA256,skill.bodyFileSHA256);
 const apply={...plan,action:'personal-skill-add-file',commit:true,confirm:'ADD-FILE:'+skill.skillId+':'+skill.filePath,
   skill:{...skill,expectedCurrentSha:'c'.repeat(64),expectedTreeSha:'d'.repeat(64)}};
 assert.equal(prepareNamedAddFileRequest(apply,owner).commit,true);
 for(const request of [{...plan,account:'other'}, {...plan,skill:{...skill,identityModule}}, {...plan,commit:true},
   {...apply,confirm:'ADD-FILE:other'}, {...apply,skill:{...apply.skill,expectedTreeSha:undefined}}])assert.throws(()=>prepareNamedAddFileRequest(request,owner));
 fs.writeFileSync(bodyFile,'Changed source bytes');assert.throws(()=>prepareNamedAddFileRequest(apply,owner),/HOLD_FILE_SOURCE_CHANGED/);
});