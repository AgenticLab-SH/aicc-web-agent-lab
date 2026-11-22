'use strict';
// add-file backup binding against the shared backup-gate with temp receipts. No network.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {addFileBackupGate,addFileGateExpected}=require('../scripts/personal-skill-manager.cjs');
const {beginMutation}=require('../../manage-chatgpt-skills/scripts/backup-gate.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'psm-add-gate-'));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const BODY='# New reference\n\nBody text.\n';
let n=0;
function receipt({filePath='references/new-file.md',operation='create',preimage=sha(''),bodyBytes=BODY,github='VERIFIED'}={}){
 const dir=path.join(root,String(++n));fs.mkdirSync(dir);
 const data=Buffer.from(bodyBytes,'utf8');
 const bundle={schemaVersion:1,assetKey:'skill|alias-a|abcdef0123456789',operation,preimageSHA256:preimage,desiredSHA256:sha(BODY),recoveryComplete:false,
  files:[{path:'desired/'+filePath,sha256:sha(data),contentBase64:data.toString('base64')}]};
 const bytes=Buffer.from(JSON.stringify(bundle),'utf8'),bundlePath=path.join(dir,'bundle.json');fs.writeFileSync(bundlePath,bytes);
 const r={schemaVersion:1,assetKey:bundle.assetKey,operation,preimageSHA256:preimage,desiredSHA256:sha(BODY),bundleSHA256:sha(bytes),bundlePath,
  githubStatus:github,notionStatus:'VERIFIED',notionPageId:'page-1',notionFileUploadId:'upload-1',githubBlobSHA:'blob-1'};
 const file=path.join(dir,'x.receipt.json');fs.writeFileSync(file,JSON.stringify(r));return file;
}
const p=file=>({account:'alias-a',skillId:'abcdef0123456789',filePath:'references/new-file.md',desiredBody:BODY,backupReceipt:file});

test('verified two-destination receipt with desired/<path> bytes passes and is not consumed',()=>{
 const file=receipt();
 assert.ok(addFileBackupGate(p(file)).bundleSHA256);
 assert.equal(fs.existsSync(file+'.operation.json'),false);
 assert.ok(addFileBackupGate(p(file)));
});

test('missing or incomplete receipt is HOLD',()=>{
 assert.throws(()=>addFileBackupGate(p(path.join(root,'absent.receipt.json'))));
 assert.throws(()=>addFileBackupGate(p(receipt({github:'NOT_STARTED'}))),/HOLD_BACKUP_INCOMPLETE/);
});

test('receipt for another path, operation, preimage or bytes is HOLD',()=>{
 assert.throws(()=>addFileBackupGate(p(receipt({filePath:'references/other.md'}))),/HOLD_BACKUP_PATH_BINDING/);
 assert.throws(()=>addFileBackupGate(p(receipt({operation:'update-body'}))),/HOLD_BACKUP_BINDING_MISMATCH: operation/);
 assert.throws(()=>addFileBackupGate(p(receipt({preimage:'c'.repeat(64)}))),/HOLD_BACKUP_BINDING_MISMATCH: preimageSHA256/);
 assert.throws(()=>addFileBackupGate(p(receipt({bodyBytes:'other\n'}))),/HOLD_BACKUP_MISSING_BYTES/);
});

test('after the one-use mutation start the same receipt cannot be planned or replayed',()=>{
 const file=receipt(),input=p(file);
 const m=beginMutation(file,addFileGateExpected(input));m.close();
 assert.throws(()=>addFileBackupGate(input),/HOLD_ORIGINAL_OPERATION_RECONCILE/);
 assert.throws(()=>beginMutation(file,addFileGateExpected(input)),/HOLD_MUTATION_ALREADY_ATTEMPTED/);
});
