'use strict';
// Receipt validation is a consistency boundary, not a replacement for host/tool authorization.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function json(file){
 if(!path.isAbsolute(file||''))throw Error('HOLD_BACKUP_REQUIRED: absolute receipt path required');
 const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw Error('HOLD_BACKUP_REQUIRED: regular receipt required');
 return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
}
function assertBackupReceipt(file,expected){
 const r=json(file);
 if(r.schemaVersion!==1||r.githubStatus!=='VERIFIED'||r.notionStatus!=='VERIFIED'||!r.notionPageId||(!r.notionFileUploadId&&r.notionFormat!=='INLINE_JSON')||!r.githubBlobSHA)throw Error('HOLD_BACKUP_INCOMPLETE: GitHub and Notion byte readbacks required');
 if(r.notionFormat==='INLINE_JSON'){
  const proof=json(r.notionRecoveryProofPath),page=json(r.notionPageReadPath);
  let text=page.text;
  if(typeof text!=='string'&&Array.isArray(page.content)&&page.content.length===1){try{text=JSON.parse(page.content[0].text).text}catch{}}
  if(typeof text!=='string'||proof.source!=='notion-page-inline-json'||proof.notionPageId!==r.notionPageId||sha(Buffer.from(proof.content||'','utf8'))!==r.bundleSHA256||!text.replaceAll('-','').includes(r.notionPageId.replaceAll('-','')))throw Error('HOLD_NOTION_INLINE_PROOF');
  const matches=[...text.matchAll(/^```json\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm)].filter(m=>sha(Buffer.from(m[1],'utf8'))===r.bundleSHA256);
  if(matches.length!==1||matches[0][1]!==proof.content)throw Error('HOLD_NOTION_INLINE_BYTES');
 }
 const b=json(r.bundlePath),bytes=fs.readFileSync(r.bundlePath);
 if(sha(bytes)!==r.bundleSHA256)throw Error('HOLD_BACKUP_CHANGED');
 for(const key of ['assetKey','operation','preimageSHA256','desiredSHA256']){
  if(expected[key]!==undefined&&(r[key]!==expected[key]||b[key]!==expected[key]))throw Error('HOLD_BACKUP_BINDING_MISMATCH: '+key);
 }
 if(expected.recoveryComplete===true&&(r.recoveryComplete!==true||b.recoveryComplete!==true))throw Error('HOLD_FULL_RECOVERY_REQUIRED');
 if(!Array.isArray(b.files)||!b.files.length)throw Error('HOLD_EMPTY_BACKUP');
 const hashes=new Set();
 for(const f of b.files){const data=Buffer.from(f.contentBase64,'base64');if(sha(data)!==f.sha256)throw Error('HOLD_BACKUP_FILE_CHANGED');hashes.add(f.sha256)}
 for(const digest of expected.requiredFileHashes||[]){if(!hashes.has(digest))throw Error('HOLD_BACKUP_MISSING_BYTES')}
 return r;
}
function beginMutation(file,expected){
 const r=assertBackupReceipt(file,expected),attempt=file+'.operation.json',lock=file+'.operation.lock';
 let fd;
 try{fd=fs.openSync(lock,'wx');}catch{throw Error('HOLD_MUTATION_WRITER_OR_UNKNOWN: reconcile exact receipt; do not replace the lock')}
 try{
  if(fs.existsSync(attempt))throw Error('HOLD_MUTATION_ALREADY_ATTEMPTED: reconcile original result, do not replay');
  const state={schemaVersion:1,bundleSHA256:r.bundleSHA256,assetKey:r.assetKey,operation:r.operation,status:'DISPATCHING',at:new Date().toISOString()};
  fs.writeFileSync(attempt,JSON.stringify(state,null,2),{flag:'wx'});
  return {complete(result){state.status=/^(body_updated_verified|updated_verified|installed_verified|deleted_verified|already_current|PASS|verified|VERIFIED|CREATED_CONFIGURATION_PENDING|NO_CHANGE)$/.test(result.status||'')?'APPLIED':'OUTCOME_UNKNOWN_RECONCILE';state.result=result;fs.writeFileSync(attempt,JSON.stringify(state,null,2));},close(){fs.closeSync(fd);fs.unlinkSync(lock)}};
 }catch(error){fs.closeSync(fd);fs.unlinkSync(lock);throw error}
}
module.exports={assertBackupReceipt,beginMutation};