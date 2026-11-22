'use strict';
// add-file argument and path validation. Local temp files only; no browser or network.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {parse,prepare,validateAddPath}=require('../scripts/personal-skill-manager.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'psm-add-file-'));
const body=path.join(dir,'new.md'),identity=path.join(dir,'identity.mjs'),receipt=path.join(dir,'r.receipt.json'),config=path.join(dir,'config.json');
fs.writeFileSync(body,'# New reference\n\nBody text.\n');fs.writeFileSync(identity,'export {}\n');
const BODY_SHA=sha(fs.readFileSync(body)),H='a'.repeat(64),ID='abcdef0123456789';
const args=(extra=[])=>['add-file','--account','alias-a','--name','example','--display-name','Example','--skill-id',ID,'--file-path','references/new-file.md',
 '--body-file',body,'--body-file-sha',BODY_SHA,'--backup-receipt',receipt,'--identity-module',identity,'--expected-identity-hash',H,'--expected-workspace-hash',H,'--config',config,...extra];
const commitArgs=(extra=[])=>args(['--commit','--ack','example','--expected-current-sha',H,'--expected-tree-sha',H,'--confirm','ADD-FILE:'+ID+':references/new-file.md',...extra]);
const withPath=(list,value)=>list.map((x,i)=>list[i-1]==='--file-path'?value:x);
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));

test('path outside references/<slug>.md, traversal, absolute and backslash are rejected',()=>{
 for(const bad of ['../x.md','references/../SKILL.md','/references/x.md','C:/x.md','references\\x.md','references//x.md','SKILL.md','agents/openai.yaml','scripts/x.cjs','references/sub/x.md','references/X.md','references/x.txt','references/.md',''])
  assert.throws(()=>validateAddPath(bad),/HOLD_ADD_FILE_PATH_REJECTED/,bad);
 assert.equal(validateAddPath('references/asset-lifecycle.md'),'references/asset-lifecycle.md');
 assert.throws(()=>prepare(parse(withPath(args(),'references/../x.md'))),/HOLD_ADD_FILE_PATH_REJECTED/);
});

test('dry run is accepted without commit inputs and keeps commit false',()=>{
 const p=prepare(parse(args()));
 assert.equal(p.commit,false);assert.equal(p.desiredSourceSHA256,BODY_SHA);
});

test('commit requires ack, confirm token, both preimages',()=>{
 assert.ok(prepare(parse(commitArgs())).commit);
 assert.throws(()=>prepare(parse(args(['--commit','--ack','example','--expected-current-sha',H,'--expected-tree-sha',H]))),/--confirm ADD-FILE/);
 assert.throws(()=>prepare(parse(args(['--commit','--ack','example','--expected-current-sha',H,'--confirm','ADD-FILE:'+ID+':references/new-file.md']))),/expected-tree-sha/);
 assert.throws(()=>prepare(parse(args(['--commit','--ack','example','--expected-current-sha',H,'--expected-tree-sha',H,'--confirm','ADD-FILE:'+ID+':references/other.md']))),/--confirm ADD-FILE/);
 assert.throws(()=>prepare(parse(args(['--commit','--ack','wrong','--expected-current-sha',H,'--expected-tree-sha',H,'--confirm','ADD-FILE:'+ID+':references/new-file.md']))),/--ack/);
 assert.throws(()=>prepare(parse(args(['--confirm','ADD-FILE:'+ID+':references/new-file.md']))),/only valid with --commit/);
});

test('missing backup receipt, identity, or changed source bytes are HOLD',()=>{
 const drop=(list,flag)=>{const i=list.indexOf(flag);return [...list.slice(0,i),...list.slice(i+2)]};
 assert.throws(()=>prepare(parse(drop(args(),'--backup-receipt'))),/HOLD_BACKUP_REQUIRED/);
 assert.throws(()=>prepare(parse(drop(args(),'--identity-module'))),/HOLD_IDENTITY_REQUIRED/);
 assert.throws(()=>prepare(parse(drop(args(),'--expected-identity-hash'))),/HOLD_IDENTITY_REQUIRED/);
 assert.throws(()=>prepare(parse(args().map(x=>x===BODY_SHA?'b'.repeat(64):x))),/HOLD_FILE_SOURCE_CHANGED/);
 assert.throws(()=>prepare(parse(args(['--editor-binding',path.join(dir,'b.json')]))),/HOLD_ADD_FILE_PERSONAL_ONLY/);
});
