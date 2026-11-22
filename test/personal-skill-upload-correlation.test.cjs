const test=require('node:test'),assert=require('node:assert/strict');
const {uploadCandidates}=require('../guidance/skills/manage-chatgpt-personal-skills/scripts/personal-skill-manager.cjs');
const list=(...names)=>({rows:names.map(displayName=>({displayName}))});
test('asynchronously generated display name is only a candidate for exact editor validation',()=>{
 const before=list('Existing'),after=list('Existing','generated canary name');
 assert.deepEqual(uploadCandidates(before,after,['canary','Requested Name']).map(r=>r.displayName),['generated canary name']);
});
test('multiple new owned rows stay ambiguous and existing unrelated rows are excluded',()=>{
 assert.equal(uploadCandidates(list('Existing'),list('Existing'),['canary']).length,0);
 assert.equal(uploadCandidates(list('Existing'),list('Existing','A','B'),['canary']).length,2);
});
