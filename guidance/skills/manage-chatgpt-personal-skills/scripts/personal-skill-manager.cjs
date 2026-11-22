#!/usr/bin/env node
'use strict';
// ChatGPT personal Skills manager. All mutations use only the observed official UI
// in an exact task-owned, account-scoped AICC CDP target. No session/token reads.
const fs=require('node:fs'),path=require('node:path');
const cp=require('node:child_process'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {pathToFileURL}=require('node:url');
const {beginMutation,assertBackupReceipt}=require('../../manage-chatgpt-skills/scripts/backup-gate.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
// The web editor adds boundary newlines around the Markdown body.
const canonicalBody=s=>s.replace(/^\n+|\n+$/g,'');
const NAME=/^[a-z0-9][a-z0-9-]{1,63}$/,ID=/^[A-Za-z0-9_-]{8,200}$/,HASH=/^[a-f0-9]{64}$/i;
const CMDS=new Set(['list','inspect','upload','update','update-body','plan-file','add-file','delete']);
// add-file creates exactly one new references Markdown file in an existing owned skill.
// Nested folders, scripts, assets, root files and traversal stay unsupported.
const ADD_PATH=/^references\/[a-z0-9][a-z0-9-]{0,62}[.]md$/;
const EMPTY_SHA=sha('');
function parse(argv){
 const command=argv[0];if(!CMDS.has(command))throw Error('expected list|inspect|upload|update|update-body|plan-file|add-file|delete');
 const p={command,commit:false,allowOwnedDelete:false};
 const labels={'--account':'account','--name':'name','--display-name':'displayName','--file':'file','--description-file':'descriptionFile','--body-file':'bodyFile','--file-path':'filePath','--body-file-sha':'bodyFileSHA256','--skill-id':'skillId','--expected-current-sha':'expectedCurrentSha','--ack':'ack','--config':'config','--playwright-module':'playwrightModule','--editor-binding':'editorBinding','--identity-module':'identityModule','--backup-receipt':'backupReceipt','--expected-tree-sha':'expectedTreeSha','--expected-identity-hash':'expectedIdentityHash','--expected-workspace-hash':'expectedWorkspaceHash','--confirm':'confirm'};
 for(let i=1;i<argv.length;i++){
  const k=argv[i];if(k==='--include-files'){p.includeFiles=true;continue}if(k==='--include-body'){p.includeBody=true;continue}if(k==='--commit'){p.commit=true;continue}
  if(k==='--allow-owned-delete'){p.allowOwnedDelete=true;continue}
  if(!labels[k]||!argv[i+1]||argv[i+1].startsWith('--'))throw Error('unknown or missing '+k);
  if(p[labels[k]])throw Error('duplicate '+k);p[labels[k]]=argv[++i];
 }
 return p;
}
function readZipSkill(file){
 const b=fs.readFileSync(file);if(b.length>25*1024*1024||b.length<150)throw Error('invalid ZIP size');
 let eocd=-1;for(let i=b.length-22;i>=Math.max(0,b.length-65558);i--)if(b.readUInt32LE(i)===0x06054b50){eocd=i;break}
 if(eocd<0)throw Error('ZIP central directory missing');
 const count=b.readUInt16LE(eocd+10),off=b.readUInt32LE(eocd+16);if(count<1||count>1000)throw Error('ZIP entry count invalid');
 let at=off;const files=[];const seen=new Set();
 for(let i=0;i<count;i++){
  if(at+46>b.length||b.readUInt32LE(at)!==0x02014b50)throw Error('ZIP entry malformed');
  const method=b.readUInt16LE(at+10),size=b.readUInt32LE(at+20),plain=b.readUInt32LE(at+24);
  const nameLength=b.readUInt16LE(at+28),extra=b.readUInt16LE(at+30),comment=b.readUInt16LE(at+32),local=b.readUInt32LE(at+42);
  const raw=b.subarray(at+46,at+46+nameLength).toString('utf8'),name=raw.replaceAll('\\','/');
  if(!name||name.startsWith('/')||name.includes('..')||name.includes(':')||seen.has(name))throw Error('ZIP unsafe entry');
  seen.add(name);files.push({name,method,size,plain,local});at+=46+nameLength+extra+comment;
 }
 const readEntry=e=>{
  if(!e||e.plain>512_000||e.local+30>b.length||b.readUInt32LE(e.local)!==0x04034b50)throw Error('ZIP unsafe source');
  const localName=b.readUInt16LE(e.local+26),localExtra=b.readUInt16LE(e.local+28);
  const start=e.local+30+localName+localExtra;
  if(start+e.size>b.length)throw Error('ZIP bounds');
  const data=b.subarray(start,start+e.size),value=e.method===0?data:e.method===8?zlib.inflateRawSync(data):null;
  if(!value||value.length!==e.plain)throw Error('ZIP decompression');return value.toString('utf8');
 };
 const skills=files.filter(f=>/(^|\/)SKILL\.md$/.test(f.name));if(skills.length!==1)throw Error('ZIP must contain exactly one SKILL.md');
 const md=readEntry(skills[0]);const skillName=/^name:\s*([a-z0-9][a-z0-9-]*)\s*$/m.exec(md)?.[1];
 if(!NAME.test(skillName||''))throw Error('SKILL.md name invalid');
 const folder=skills[0].name.replace(/SKILL\.md$/,'');
 const agent=files.find(f=>f.name===folder+'agents/openai.yaml');
 const yaml=agent?readEntry(agent):'';const displayed=/^\s*display_name:\s*['"]?(.+?)['"]?\s*$/m.exec(yaml)?.[1]||skillName;
 const body=md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').replace(/\r\n/g,'\n');
 return {skillName,displayName:displayed,sha256:sha(b),bodySHA256:sha(canonicalBody(body)),bytes:b.length,files:files.length};
}
function validateAddPath(value){
 const v=String(value||'');
 // Reject traversal, absolute, drive, backslash and any path outside references/<slug>.md.
 if(!v||v.includes('..')||v.includes('\\')||v.startsWith('/')||/^[A-Za-z]:/.test(v)||v.includes('//')||!ADD_PATH.test(v))
  throw Error('HOLD_ADD_FILE_PATH_REJECTED: only a new references/<lowercase-slug>.md inside the skill root');
 return v;
}
function prepareAddFile(p){
 validateAddPath(p.filePath);
 if(!ID.test(p.skillId||''))throw Error('exact --skill-id required');
 if(p.editorBinding)throw Error('HOLD_ADD_FILE_PERSONAL_ONLY: workspace editor mode cannot add files');
 if(!HASH.test(p.bodyFileSHA256||''))throw Error('exact --body-file-sha (desired source bytes SHA-256) required');
 if(!path.isAbsolute(p.backupReceipt||''))throw Error('HOLD_BACKUP_REQUIRED: absolute --backup-receipt required');
 if(!path.isAbsolute(p.identityModule||''))throw Error('HOLD_IDENTITY_REQUIRED: registered --identity-module required');
 if(!HASH.test(p.expectedIdentityHash||'')||!HASH.test(p.expectedWorkspaceHash||''))throw Error('HOLD_IDENTITY_REQUIRED: --expected-identity-hash and --expected-workspace-hash required');
 if(p.commit){
  if(!HASH.test(p.expectedCurrentSha||'')||!HASH.test(p.expectedTreeSha||''))throw Error('commit needs fresh --expected-current-sha (SKILL.md) and --expected-tree-sha from the add-file dry run');
  if(p.confirm!=='ADD-FILE:'+p.skillId+':'+p.filePath)throw Error('commit needs --confirm ADD-FILE:<skill-id>:<file-path>');
 }else if(p.confirm)throw Error('--confirm is only valid with --commit');
}
// Stable tree preimage: sorted file paths (folders excluded), newline joined.
const treeFiles=tree=>tree.rows.filter(r=>!r.folder).map(r=>r.path).sort();
const treeHash=files=>sha([...files].sort().join('\n'));
function addFileGateExpected(p){
 const desired=sha(p.desiredBody);
 // WebAssetBackup has no add-file operation; a new file is a create with empty preimage.
 return {assetKey:'skill|'+p.account+'|'+p.skillId,operation:'create',preimageSHA256:EMPTY_SHA,desiredSHA256:desired,requiredFileHashes:[desired]};
}
function addFileBackupGate(p){
 const r=assertBackupReceipt(p.backupReceipt,addFileGateExpected(p));
 const bundle=JSON.parse(fs.readFileSync(r.bundlePath,'utf8').replace(/^\uFEFF/,''));
 if(!bundle.files.some(f=>f.path==='desired/'+p.filePath&&f.sha256===sha(p.desiredBody)))throw Error('HOLD_BACKUP_PATH_BINDING: bundle needs desired/'+p.filePath+' with the desired bytes');
 for(const suffix of ['.operation.json','.operation.lock'])if(fs.existsSync(p.backupReceipt+suffix))throw Error('HOLD_ORIGINAL_OPERATION_RECONCILE: this receipt was already used; reconcile, do not replay');
 return r;
}
const holdStatus=e=>{const m=String(e?.message||e);const head=/^(HOLD_[A-Z_]+|REFUSED_[A-Z_]+)/.exec(m)?.[1];return {status:head||'HOLD_ADD_FILE',reason:m.slice(0,300)}};
// Ordering contract (fake-driver tested): identity -> tree/preimage -> backup gate (read-only)
// -> local draft (new text file, rename, body) verified -> identity -> one-use beginMutation
// -> exactly one Save click -> fresh reload readback. Nothing after the Save click is replayed.
async function addFileFlow(drv,p,{verifyIdentity,assertGate,beginMutation,outputs=[]}){
 const folder=p.filePath.split('/')[0],desiredSHA256=sha(p.desiredBody);
 const base={operation:'add-file',account:p.account,name:p.name,skillId:p.skillId,filePath:p.filePath,desiredSHA256,desiredSourceSHA256:p.desiredSourceSHA256,automaticRetry:false};
 let before,beforeTree,beforeSkill;
 try{
  await verifyIdentity('editor');
  before=await drv.readTree(folder);
  if(before.folderMissing)return {...base,status:'HOLD_ADD_FILE_FOLDER_UNPROVEN',reason:'target folder row not observed; new folder creation is unobserved and absence is not inferred',remoteMutation:false,externalWritePerformed:false};
  const files=treeFiles(before);
  if(files.includes(p.filePath))return {...base,status:'REFUSED_ADD_FILE_PATH_EXISTS',reason:'use update-body for an existing file',remoteMutation:false,externalWritePerformed:false};
  if(files.includes('untitled.txt'))return {...base,status:'HOLD_ADD_FILE_PENDING_DRAFT',remoteMutation:false,externalWritePerformed:false};
  beforeTree=treeHash(files);beforeSkill=(await drv.readBody('SKILL.md')).bodySHA256;
  const gate=assertGate();
  const plan={...base,currentTreeSHA256:beforeTree,currentSkillSHA256:beforeSkill,treeFiles:files,backupBundleSHA256:gate?.bundleSHA256||null};
  if(!p.commit)return {...plan,status:'ADD_FILE_PLAN_READY',preimageMatches:{tree:p.expectedTreeSha?p.expectedTreeSha.toLowerCase()===beforeTree:null,skill:p.expectedCurrentSha?p.expectedCurrentSha.toLowerCase()===beforeSkill:null},confirm:'ADD-FILE:'+p.skillId+':'+p.filePath,remoteMutation:false,externalWritePerformed:false};
  if(beforeTree!==p.expectedTreeSha.toLowerCase()||beforeSkill!==p.expectedCurrentSha.toLowerCase())return {...plan,status:'HOLD_ADD_FILE_PREIMAGE_CONFLICT',remoteMutation:false,externalWritePerformed:false};
  // Local draft only (observed: root untitled.txt, selected, empty CodeMirror). No save yet.
  await drv.openNewTextFile();
  const draft=treeFiles(await drv.readTree(folder)),created=draft.filter(f=>!files.includes(f));
  if(created.length!==1||created[0]!=='untitled.txt'||draft.length!==files.length+1)return {...plan,status:'HOLD_ADD_FILE_DRAFT_UNOBSERVED',draftFiles:created,remoteMutation:false,externalWritePerformed:false};
  await drv.renameFile('untitled.txt',p.filePath);
  const renamed=treeFiles(await drv.readTree(folder)),added=renamed.filter(f=>!files.includes(f));
  if(added.length!==1||added[0]!==p.filePath||renamed.length!==files.length+1)return {...plan,status:'HOLD_ADD_FILE_RENAME_UNPROVEN',draftFiles:added,remoteMutation:false,externalWritePerformed:false};
  await drv.selectFile(p.filePath);
  const entered=await drv.setBody(p.desiredBody);
  if(entered!==p.desiredBody)return {...plan,status:'HOLD_ADD_FILE_INPUT_MISMATCH',remoteMutation:false,externalWritePerformed:false};
  const save=await drv.saveState();
  if(save.count!==1||!save.enabled)return {...plan,status:'HOLD_ADD_FILE_SAVE_UNAVAILABLE',remoteMutation:false,externalWritePerformed:false};
  await verifyIdentity('before-save');
  beginMutation();
 }catch(error){return {...base,...holdStatus(error),remoteMutation:false,externalWritePerformed:false}}
 const unknown=reason=>({...base,status:'UNKNOWN_ADD_FILE_OUTCOME',reason:String(reason).slice(0,300),beforeTreeSHA256:beforeTree,beforeSkillSHA256:beforeSkill,verified:false,saveClicks:1,remoteMutation:true,requests:outputs,nextAction:'reconcile this receipt by read-only inspect; never click Save again or reuse the receipt'});
 try{await drv.clickSave()}catch(error){return unknown('save click outcome uncertain: '+(error?.message||error))}
 try{
  await drv.wait(1800);
  let after=null;
  for(let observation=0;observation<4;observation++){
   await drv.reloadFresh();
   const t=await drv.readTree(folder);
   if(!t.folderMissing){
    const f=treeFiles(t);
    if(f.includes(p.filePath)||f.includes('untitled.txt')){after={files:f};break}
   }
   if(observation<3)await drv.wait(2000*(observation+1));
  }
  if(!after)return unknown('target path not observed after save; persistence may lag');
  await verifyIdentity('readback');
  const expectedFiles=[...treeFiles(before),p.filePath].sort(),afterTree=treeHash(after.files);
  const result={...base,beforeTreeSHA256:beforeTree,afterTreeSHA256:afterTree,beforeSkillSHA256:beforeSkill,saveClicks:1,remoteMutation:true,requests:outputs};
  if(!after.files.includes(p.filePath))return {...result,status:'FAILED_ADD_FILE_WRONG_PATH',verified:false};
  const body=await drv.readBody(p.filePath),skillAfter=(await drv.readBody('SKILL.md')).bodySHA256;
  const bodyMatch=canonicalBody(body.text)===canonicalBody(p.desiredBody),treeMatch=afterTree===treeHash(expectedFiles);
  const out={...result,afterBodySHA256:body.bodySHA256,afterSkillSHA256:skillAfter,bodyMatch,treeMatch,skillUnchanged:skillAfter===beforeSkill,boundaryNewlinesNormalized:bodyMatch&&body.text!==p.desiredBody};
  if(!bodyMatch)return {...out,status:'FAILED_ADD_FILE_READBACK_MISMATCH',verified:false};
  if(!treeMatch||skillAfter!==beforeSkill)return {...out,status:'FAILED_ADD_FILE_COLLATERAL_CHANGE',verified:false};
  return {...out,status:'file_added_verified',verified:true};
 }catch(error){return unknown('readback failed: '+(error?.message||error))}
}
function prepare(p,env=process.env){
 if(!/^[A-Za-z0-9._-]{2,100}$/.test(p.account||''))throw Error('exact --account required');
 if(p.command!=='list'&&!NAME.test(p.name||''))throw Error('exact lowercase --name required');
 if(p.command==='add-file')prepareAddFile(p);
 if(p.command==='inspect'||p.command==='update'||p.command==='update-body'||p.command==='plan-file'||p.command==='add-file'||p.command==='delete'){
  if(!p.displayName||p.displayName.length>150)throw Error('--display-name required from own skills list');
 }
 if(p.command==='update'||p.command==='update-body'||p.command==='plan-file'||p.command==='delete'){
  if(!ID.test(p.skillId||''))throw Error('exact --skill-id required');
  if(!HASH.test(p.expectedCurrentSha||''))throw Error('preimage --expected-current-sha required');
 }
 if(p.command==='upload'){
  if(!p.file||!path.isAbsolute(p.file))throw Error('absolute --file required');
  const s=fs.lstatSync(p.file);if(!s.isFile()||s.isSymbolicLink()||!p.file.toLowerCase().endsWith('.zip'))throw Error('unsafe ZIP');
  p.package=readZipSkill(p.file);if(p.package.skillName!==p.name)throw Error('ZIP frontmatter name mismatch');
 }
 if(p.command==='update'){
  if(!p.descriptionFile||!path.isAbsolute(p.descriptionFile))throw Error('absolute --description-file required');
  const st=fs.lstatSync(p.descriptionFile);if(!st.isFile()||st.isSymbolicLink()||st.size>8000)throw Error('unsafe description file');
  p.desiredDescription=fs.readFileSync(p.descriptionFile,'utf8');
  if(p.desiredDescription.length<10||p.desiredDescription.length>2000)throw Error('description size invalid');
 }
 if(p.command==='update-body'||p.command==='plan-file'||p.command==='add-file'){
  if(!p.bodyFile||!path.isAbsolute(p.bodyFile))throw Error('absolute --body-file required');
  const stat=fs.lstatSync(p.bodyFile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>100_000)throw Error('unsafe body source');
  const sourceBytes=fs.readFileSync(p.bodyFile);
  p.desiredSourceSHA256=sha(sourceBytes);
  if(p.bodyFileSHA256&&p.desiredSourceSHA256!==p.bodyFileSHA256.toLowerCase())throw Error('HOLD_FILE_SOURCE_CHANGED');
  p.desiredBody=new TextDecoder('utf-8',{fatal:true}).decode(sourceBytes).replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
  if(p.desiredBody.length<10||p.desiredBody.length>100_000)throw Error('body length invalid');
 }
 if(p.command==='delete'&&p.commit&&!p.allowOwnedDelete)throw Error('delete needs --allow-owned-delete');
 if(p.command==='list'&&p.commit)throw Error('read-only list');if(p.includeBody&&p.command!=='inspect')throw Error('--include-body is inspect only');
 if(p.commit&&p.command!=='list'&&p.command!=='inspect'&&p.ack!==p.name)throw Error('--ack must equal exact name');
 if(p.filePath&&p.command!=='add-file'&&(!['inspect','update-body','plan-file'].includes(p.command)||!/^(?:references\/[a-z0-9-]+[.]md|agents\/openai[.]yaml)$/.test(p.filePath)))throw Error('file-path is an existing references Markdown file or agents/openai.yaml only');
 if(p.command==='plan-file'){
  if(p.commit||p.editorBinding)throw Error('HOLD_PLAN_PERSONAL_READ_ONLY: no mutation or workspace editor mode');
  if(!/^references\/[a-z0-9-]+[.]md$/.test(p.filePath||''))throw Error('HOLD_SUPPORT_FILE_SURFACE_UNSUPPORTED: only an existing references Markdown file; new files and whole ZIP replacement are unsupported');
  if(!HASH.test(p.bodyFileSHA256||''))throw Error('Exact desired file bytes SHA required');
  if(!path.isAbsolute(p.backupReceipt||''))throw Error('HOLD_BACKUP_REQUIRED');
 }
 if(p.filePlan){
  const plan=p.filePlan;
  if(p.command!=='update-body'||plan.kind!=='existing-support-file-plan/v1'||plan.account!==p.account
   ||plan.skillId!==p.skillId||plan.name!==p.name||plan.displayName!==p.displayName||plan.filePath!==p.filePath
   ||plan.beforeSHA256!==p.expectedCurrentSha?.toLowerCase()||plan.desiredSHA256!==sha(p.desiredBody)
   ||plan.desiredSourceSHA256!==p.desiredSourceSHA256||plan.bodyFile!==p.bodyFile
   ||plan.backupReceipt!==p.backupReceipt)throw Error('HOLD_FILE_PLAN_CHANGED');
 }
 if(p.editorBinding){
  if(!['inspect','update-body','plan-file'].includes(p.command))throw Error('existing workspace editor supports inspect or update-body only');
  if(!path.isAbsolute(p.editorBinding)||!/^[a-f0-9]{32}$/i.test(p.skillId||''))throw Error('exact existing editor binding and resource ID required');
  const st=fs.lstatSync(p.editorBinding);if(!st.isFile()||st.isSymbolicLink()||st.size>64000)throw Error('unsafe editor binding');
  const binding=JSON.parse(fs.readFileSync(p.editorBinding,'utf8').replace(/^\uFEFF/,''));
  if(binding.schemaVersion!==1||binding.policy!=='EXISTING_WORKSPACE_EDITOR_ONLY'||binding.accountAlias!==p.account||binding.resourceId!==p.skillId||binding.name!==p.name||!HASH.test(binding.expectedIdentityHash||'')||!HASH.test(binding.expectedWorkspaceHash||'')||!binding.ownerLabel||!HASH.test(binding.packageSHA256||'')||!path.isAbsolute(binding.packagePreimage||''))throw Error('existing editor binding mismatch');
  const backup=fs.lstatSync(binding.packagePreimage);if(!backup.isFile()||backup.isSymbolicLink()||backup.size>25*1024*1024||sha(fs.readFileSync(binding.packagePreimage))!==binding.packageSHA256.toLowerCase())throw Error('exact package preimage mismatch');
  if(!path.isAbsolute(p.identityModule||''))throw Error('registered identity audit module required');
  const audit=fs.lstatSync(p.identityModule);if(!audit.isFile()||audit.isSymbolicLink())throw Error('unsafe identity audit module');
  p.editorBindingData=binding;
 }else if(p.identityModule&&p.command!=='add-file')throw Error('identity module requires existing editor binding');
 if(p.command==='add-file'){
  const audit=fs.lstatSync(p.identityModule);if(!audit.isFile()||audit.isSymbolicLink())throw Error('unsafe identity audit module');
 }
 // Owner configuration is supplied by the registered caller, not a historical backup folder.
 p.configFile=p.config||env.AICC_CHATGPT_ARCHIVE_CONFIG;
 if(!p.configFile)throw Error('owner config required: --config or AICC_CHATGPT_ARCHIVE_CONFIG');
 if(!path.isAbsolute(p.configFile))throw Error('absolute owner config required');
 return p;
}
function ownerConfig(file,alias){
 if(!path.isAbsolute(file))throw Error('absolute owner config required');
 const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink())throw Error('unsafe owner config');
 const cfg=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 if(cfg.schemaVersion!==1||!path.isAbsolute(cfg.leaseHelper))throw Error('archive config mismatch');
 const account=cfg.accounts?.find(x=>x.alias===alias&&x.enabled!==false);
 if(!account||typeof account.workspace!=='string'||!/^account-[a-f0-9]{32,64}$/.test(account.workspace))throw Error('account disabled/mismatch');
 return {helper:cfg.leaseHelper,account};
}
function leaseCmd(helper,args){
 const exe=process.env.AICC_PWSH||'pwsh';
 if(process.env.AICC_PWSH&&!path.isAbsolute(exe))throw Error('AICC_PWSH must be an absolute executable path');
 const r=cp.spawnSync(exe,['-NoProfile','-NonInteractive','-File',helper,...args,'-AsJson'],{encoding:'utf8',timeout:30000,windowsHide:true,maxBuffer:512000});
 if(r.status!==0||r.error){
  // Classify the known failure without copying stderr, account details or lease secrets.
  const diagnostic=String(r.stderr||'')+'\n'+String(r.stdout||'');
  if(/Registered CDP Chrome \d+ is offline/.test(diagnostic))throw Error('registered_browser_offline: prepare the existing registered profile through the authorized broker, then resume this manager; no new browser-start approval is required');
  if(r.error?.code==='ENOENT')throw Error('PowerShell unavailable: configure AICC_PWSH or PATH');
  if(r.error?.code==='ETIMEDOUT')throw Error('lease helper timed out: reconcile operation before retry');
  throw Error('lease helper failed (exit '+String(r.status??'unknown')+')');
 }
 return JSON.parse(r.stdout.trim());
}
function browserLibrary(p){
 const module=p.playwrightModule||process.env.AICC_PLAYWRIGHT_CORE;
 if(module){if(!path.isAbsolute(module))throw Error('absolute Playwright module needed');return require(module)}
 // Normal Node resolution or the caller's explicit module preserves portable deployment.
 return require('playwright-core');
}
async function getExactTarget(browser,id,nonce){
 if(!/^[a-f0-9]{64}$/i.test(nonce||''))throw Error('exact leased target nonce required');
 const pages=browser.contexts().flatMap(ctx=>ctx.pages()).filter(page=>{try{return new URL(page.url()).searchParams.get('aicc_task_target')===nonce}catch{return false}});
 if(pages.length!==1)throw Error('leased nonce target ambiguous or unavailable');
 const page=pages[0],session=await page.context().newCDPSession(page);
 try{if((await session.send('Target.getTargetInfo')).targetInfo.targetId!==id)throw Error('leased target ID mismatch')}finally{await session.detach()}
 return page;
}
async function loadSkills(page){
 // Read only the request made by the official Created by me UI, under its existing identity.
 const ownerRead=page.waitForResponse(r=>{try{const u=new URL(r.url());return r.request().method()==='GET'&&u.origin==='https://chatgpt.com'&&u.pathname==='/backend-api/hazelnuts'&&u.searchParams.get('scope')==='created'}catch{return false}},{timeout:55000}).then(async r=>({status:r.status(),data:r.status()===200?await r.json():null})).catch(()=>null);
 await page.goto('https://chatgpt.com/skills?collection=created',{waitUntil:'domcontentloaded',timeout:60000});
 const observed=await ownerRead;
 if(observed&&observed.status!==200)throw Error('owner_collection_http_'+observed.status+': no automatic retry or absence inference');
 if(!Array.isArray(observed?.data?.hazelnuts))throw Error('owner_collection_readback_unavailable: do not infer missing skills');
 const owned=observed.data.hazelnuts.filter(x=>x&&ID.test(x.id||'')&&NAME.test(x.name||''));
 if(owned.length!==observed.data.hazelnuts.length)throw Error('owner_collection_schema_changed: no partial inventory');
 // Capture readiness and row data in one DOM observation; heading-first React renders are incomplete.
 const handle=await page.waitForFunction(expected=>{
  const main=document.querySelector('main');
  const heading=[...(main?.querySelectorAll('h1,h2')||[])].find(x=>x.textContent.trim()==='내가 만든 항목');
  if(new URL(location.href).searchParams.get('collection')!=='created'||!heading||main.innerText.includes('스킬을 불러오는 중입니다'))return false;
  const arr=[...main.querySelectorAll('button[aria-label$="의 추가 작업"]')];
  if(arr.length!==expected)return false;
  const rows=arr.map(b=>{const row=b.closest('[role="button"]');const lines=(row?.innerText||'').trim().split(/\n+/).map(s=>s.trim());return {displayName:lines[0]||null,summary:lines.slice(1).join(' ').slice(0,260),menuLabel:b.getAttribute('aria-label')}});
  if(rows.some(x=>!x.displayName))return false;
  return {scope:true,collection:'created',sections:[{title:'내가 만든 항목',rows:arr.map(b=>b.getAttribute('aria-label'))}],rows};
 },owned.length,{timeout:55000});
 let snapshot;try{snapshot=await handle.jsonValue()}finally{await handle.dispose()}
 snapshot.identitySource='official-created-collection-response';
 snapshot.rows=snapshot.rows.map(row=>{
  const matches=owned.filter(x=>(x.display_name||x.name)===row.displayName);
  if(matches.length!==1)throw Error('owner_collection_row_mismatch: no name-only ID inference');
  const item=matches[0];return {...row,id:item.id,name:item.name,version:item.latest_version_no??null};
 });
 return snapshot;
}
function findOwned(list,displayName){const rows=list.rows.filter(r=>r.displayName===displayName);if(rows.length>1)throw Error('ambiguous owned skill display name');return rows[0]||null}
function uploadCandidates(before,after,names){const previous=new Set(before.rows.map(r=>r.displayName));return after.rows.filter(r=>names.includes(r.displayName)||!previous.has(r.displayName));}
function ownButton(page,display){
 // Restrict to the exact Created by me section rather than installed duplicates.
 if(new URL(page.url()).searchParams.get('collection')!=='created')throw Error('exact owned collection required');
 const section=page.locator('main').filter({has:page.getByRole('heading',{name:'내가 만든 항목',exact:true})});
 const escaped=display.replaceAll('\\','\\\\').replaceAll('"','\\"');
 return section.locator('button[aria-label="'+escaped+'의 추가 작업"]');
}
async function clickCreated(page,display,observed){
 const snap=observed||await loadSkills(page),row=findOwned(snap,display);if(!row)throw Error('owner-created skill not found');
 const buttons=ownButton(page,display),n=await buttons.count();if(n!==1)throw Error('owner-created action button ambiguous');
 await buttons.dispatchEvent('pointerdown',{button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true});
 const edit=page.getByRole('menuitem',{name:'편집',exact:true});await edit.waitFor({state:'visible',timeout:12000});if(await edit.count()!==1)throw Error('owner-created edit menu unavailable');
 await edit.dispatchEvent('click');
 await page.waitForURL(/\/skills\/editor\/[A-Za-z0-9_-]{8,200}/,{timeout:25000});return page.url();
}
async function editor(page,name,expectedId){
 const url=new URL(page.url());const id=url.pathname.match(/^\/skills\/editor\/([A-Za-z0-9_-]{8,200})$/)?.[1];
 if(!id||expectedId&&id!==expectedId)throw Error('skill editor ID mismatch');
 const input=page.locator('input[placeholder="your-skill-name"]');await input.waitFor({state:'visible',timeout:50000});
 if((await input.inputValue())!==name)throw Error('skill slug mismatch');
 const desc=page.locator('textarea[placeholder="스킬이 무엇을 하는지 설명하세요"]');if(await desc.count()!==1)throw Error('skill description missing');
 const text=await desc.inputValue();return {id,name,descriptionHash:sha(text),descriptionLength:text.length,descriptionText:text,desc};
}
async function fullLogicalBody(page,code){
 if(await code.count()!==1)throw Error("Exact body editor is not unique; HOLD");
 return page.evaluate(()=>{
  const editors=[...document.querySelectorAll('[role="textbox"][aria-label="코드 편집"]')];
  if(editors.length!==1)throw Error("Exact body editor binding is not unique; HOLD");
  const el=editors[0];
  // Discover only this editor's DOM bridge, then use CodeMirror's public API.
  // Never accept viewport DOM as a full-document fallback.
  const bridge=el.cmTile||el.cmView||el.closest('.cm-editor')?.cmView;
  const linked=bridge?.view||bridge?.root?.view||bridge?.rootView?.view;
  const EditorView=linked?.constructor;
  if(typeof EditorView?.findFromDOM!=='function')throw Error('Full CodeMirror document API unavailable; HOLD');
  const view=EditorView.findFromDOM(el);
  if(!view||view!==linked||view.contentDOM!==el)throw Error('Exact CodeMirror editor binding unavailable; HOLD');
  const doc=view.state?.doc;
  if(!doc||typeof doc.toString!=='function'||!Number.isInteger(doc.length))throw Error('Full CodeMirror document unavailable; HOLD');
  const text=doc.toString();
  if(text.length!==doc.length)throw Error('CodeMirror document length mismatch; HOLD');
  return text;
 });
}
async function codeBody(page,relativePath='SKILL.md'){
 if(relativePath!=='SKILL.md'&&!/^(?:references\/[a-z0-9-]+[.]md|agents\/openai[.]yaml)$/.test(relativePath))throw Error('Exact supported skill file path required');
 const tab=page.getByRole('button',{name:relativePath,exact:true});
 // Auxiliary file rows expose the full relative path as their accessible name.
 // Wait for the lazy file tree before deciding whether its folder is collapsed.
 if(relativePath.startsWith('references/')||relativePath==='agents/openai.yaml'){
  const folder=page.getByRole('button',{name:relativePath.split('/')[0],exact:true});
  await folder.waitFor({state:'visible',timeout:30000});
  if(await folder.getAttribute('aria-expanded')==='false')await folder.click({timeout:12000});
 }
 await tab.waitFor({state:'visible',timeout:30000});
 if(await tab.count()!==1)throw Error('Exact file row not unique');
 if(!await tab.isEnabled()||await tab.getAttribute('aria-disabled')==='true')throw Error('Exact file row disabled');
 await tab.dispatchEvent('click');
 await page.waitForFunction(path=>{const rows=[...document.querySelectorAll('[role=button]')].filter(e=>e.getAttribute('aria-current')==='page');return rows.some(e=>e.getAttribute('aria-label')===path||(path==='SKILL.md'&&e.textContent.trim()==='SKILL.md'))},relativePath,{timeout:12000});
 await page.waitForTimeout(1200); // Wait for the selected file document to replace the previous editor state.
 const code=page.getByRole('textbox',{name:'코드 편집'});
 await code.waitFor({state:'visible',timeout:30000});
 // CodeMirror innerText adds layout-only blank lines; logical cm-lines are source.
 const text=await fullLogicalBody(page,code);
 return {text,bodySHA256:sha(text),bodyLength:text.length,code};
}
// Playwright driver for add-file. Every selector below was observed read-only on 2026-11-01
// (W-G110 menu probe and W-PSM new-text-file probe): editor dialog "스킬 편집", tree rows
// div[role=button] with full-path aria-label, "업로드" menu -> "새 텍스트 파일" (creates a
// root untitled.txt draft), "<path> 액션" -> "이름 변경" -> input[aria-label="파일 경로"],
// "변경 사항 저장". The rename commit key and the save response were not observed; the
// flow verifies the renamed tree before Save and only reload readback decides success.
function addFileDriver(page,p){
 const dialog=()=>page.getByRole('dialog',{name:'스킬 편집',exact:true});
 const unique=async(locator,what)=>{if(await locator.count()!==1)throw Error('HOLD_ADD_FILE_CONTROL_NOT_UNIQUE: '+what);return locator};
 const openMenu=async(button,itemName)=>{
  await button.dispatchEvent('pointerdown',{button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true});
  const item=page.getByRole('menuitem',{name:itemName,exact:true});
  try{await item.waitFor({state:'visible',timeout:5000})}catch{await button.dispatchEvent('click');await item.waitFor({state:'visible',timeout:8000})}
  await unique(item,itemName);await item.dispatchEvent('click');
 };
 const drv={
  async readTree(folder){
   const d=await unique(dialog(),'editor dialog');
   await d.getByRole('button',{name:'SKILL.md',exact:true}).waitFor({state:'visible',timeout:30000});
   try{await d.getByRole('button',{name:folder,exact:true}).waitFor({state:'visible',timeout:15000})}catch{return {folderMissing:true,rows:[]}}
   for(let i=0;i<10;i++){const closed=d.locator('div[role="button"][aria-expanded="false"]');if(!await closed.count())break;await closed.first().click({timeout:12000});await page.waitForTimeout(600)}
   await page.waitForTimeout(1200);
   const rows=await d.locator('div[role="button"]').evaluateAll(es=>es.map(r=>({path:r.getAttribute('aria-label')||(r.textContent||'').trim(),folder:r.hasAttribute('aria-expanded'),current:r.getAttribute('aria-current')==='page'})));
   return {folderMissing:false,rows};
  },
  async readBody(relativePath){const b=await codeBody(page,relativePath);return {text:b.text,bodySHA256:b.bodySHA256}},
  async openNewTextFile(){await openMenu(await unique(dialog().getByRole('button',{name:'업로드',exact:true}),'업로드'),'새 텍스트 파일');await page.waitForTimeout(1500)},
  async renameFile(from,to){
   const d=dialog();await openMenu(await unique(d.getByRole('button',{name:from+' 액션',exact:true}),from+' 액션'),'이름 변경');
   const input=d.locator('input[aria-label="파일 경로"]');await input.waitFor({state:'visible',timeout:8000});await unique(input,'파일 경로');
   if(await input.inputValue()!==from)throw Error('HOLD_ADD_FILE_RENAME_UNPROVEN: rename input does not hold the draft path');
   await input.fill(to);if(await input.inputValue()!==to)throw Error('HOLD_ADD_FILE_RENAME_UNPROVEN: path input mismatch');
   await input.press('Enter');await page.waitForTimeout(1200);
  },
  async selectFile(relativePath){
   const row=await unique(dialog().getByRole('button',{name:relativePath,exact:true}),relativePath);
   await row.dispatchEvent('click');
   await page.waitForFunction(path=>[...document.querySelectorAll('[role=button]')].some(e=>e.getAttribute('aria-current')==='page'&&e.getAttribute('aria-label')===path),relativePath,{timeout:12000});
   await page.waitForTimeout(1200);
  },
  async setBody(text){
   const code=page.getByRole('textbox',{name:'코드 편집'});await code.waitFor({state:'visible',timeout:30000});
   await page.evaluate(value=>{
    const es=[...document.querySelectorAll('[role="textbox"][aria-label="코드 편집"]')];if(es.length!==1)throw Error('Exact body editor is not unique');
    const el=es[0],bridge=el.cmTile||el.cmView||el.closest('.cm-editor')?.cmView,linked=bridge?.view||bridge?.root?.view||bridge?.rootView?.view,view=linked?.constructor?.findFromDOM?.(el);
    if(!view||view!==linked||view.contentDOM!==el)throw Error('Exact CodeMirror editor unavailable');
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:value}});
   },text);
   return fullLogicalBody(page,code);
  },
  async saveState(){const s=dialog().getByRole('button',{name:'변경 사항 저장',exact:true});const count=await s.count();return {count,enabled:count===1&&await s.isEnabled()}},
  async clickSave(){await dialog().getByRole('button',{name:'변경 사항 저장',exact:true}).dispatchEvent('click')},
  async reloadFresh(){
   // A beforeunload or in-app guard could keep the unsaved document; require a new document.
   const marker=crypto.randomUUID();await page.evaluate(m=>{window.__aiccAddFileMarker=m},marker);
   await page.reload({waitUntil:'domcontentloaded',timeout:50000});
   if(await page.evaluate(()=>window.__aiccAddFileMarker||null))throw Error('reload did not produce a fresh document');
   await editor(page,p.name,p.skillId);
   const save=await drv.saveState();if(save.enabled)throw Error('pending edits remain after reload');
  },
  wait:ms=>page.waitForTimeout(ms)
 };
 return drv;
}
// Playwright normally initializes every existing page before CDP connect resolves.
// A stalled foreign renderer must not block or receive overrides from this task.
// Use its supported ConnectionTransport with only the broker-owned target attached.
async function connectOwnedBrowser(chromium,lease){
 const endpoint=new URL(lease.endpoint);
 if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.pathname!=='/'||endpoint.search||endpoint.hash||endpoint.username||endpoint.password||!endpoint.port||!/^[a-f0-9]{16,128}$/i.test(lease.target_id||'')||!/^[a-f0-9]{32,128}$/i.test(lease.task_target_nonce||''))throw Error('Exact loopback owned lease required');
 const response=await fetch(new URL('/json/version',endpoint),{signal:AbortSignal.timeout(5000),redirect:'error'});
 if(!response.ok)throw Error('Registered CDP discovery unavailable');
 const wsUrl=new URL((await response.json()).webSocketDebuggerUrl);
 if(wsUrl.protocol!=='ws:'||wsUrl.hostname!==endpoint.hostname||wsUrl.port!==endpoint.port||!/^\/devtools\/browser\/[\w-]+$/.test(wsUrl.pathname)||wsUrl.search||wsUrl.hash||wsUrl.username||wsUrl.password)throw Error('Registered CDP discovery identity differs');
 const ws=new WebSocket(wsUrl);const internal=new Map(),sessions=new Set(),browserSessions=new Set();let sequence=0,closed=false,attach;
 const transport={onmessage:null,onclose:null,send:message=>void send(message),close:()=>ws.close()};
 const emit=message=>queueMicrotask(()=>transport.onmessage?.(message));
 const rejectMessage=(message,error)=>emit({id:message.id,...(message.sessionId?{sessionId:message.sessionId}:{}),error:{code:-32000,message:String(error.message||error)}});
 const raw=message=>{if(ws.readyState!==WebSocket.OPEN)throw Error('Owned CDP transport closed');ws.send(JSON.stringify(message))};
 const command=(method,params={})=>new Promise((resolve,reject)=>{const id=--sequence;const timer=setTimeout(()=>{internal.delete(id);reject(Error('Owned CDP '+method+' timed out'))},12000);internal.set(id,{resolve,reject,timer});try{raw({id,method,params})}catch(error){clearTimeout(timer);internal.delete(id);reject(error)}});
 ws.addEventListener('message',event=>{
  let message;try{message=JSON.parse(String(event.data))}catch{return}
  const pending=internal.get(message.id);
  if(pending){clearTimeout(pending.timer);internal.delete(message.id);message.error?pending.reject(Error(message.error.message)):pending.resolve(message.result);return}
  if(message.sessionId&&!sessions.has(message.sessionId)&&!browserSessions.has(message.sessionId))return;
  if(message.method==='Target.attachedToTarget'){
   const {sessionId,targetInfo}=message.params;
   if((!message.sessionId||browserSessions.has(message.sessionId))&&targetInfo.targetId!==lease.target_id)return;
   sessions.add(sessionId);
  }
  if(!message.sessionId&&message.method?.startsWith('Target.')&&message.method!=='Target.attachedToTarget'&&message.method!=='Target.detachedFromTarget')return;
  if(message.method==='Target.detachedFromTarget'&&!sessions.has(message.params.sessionId)&&!browserSessions.has(message.params.sessionId))return;
  emit(message);
  if(message.method==='Target.detachedFromTarget'){sessions.delete(message.params.sessionId);browserSessions.delete(message.params.sessionId)}
 });
 ws.addEventListener('close',()=>{if(closed)return;closed=true;for(const p of internal.values()){clearTimeout(p.timer);p.reject(Error('Owned CDP disconnected'))}internal.clear();sessions.clear();browserSessions.clear();transport.onclose?.()});
 async function send(message){
  try{
   if(!message||!Number.isInteger(message.id)||message.id<0)throw Error('Invalid CDP request');
   if(message.method==='Browser.close')throw Error('Closing the shared browser is forbidden');
   if(message.params?.targetId&&message.params.targetId!==lease.target_id)throw Error('Foreign target command refused');
   if(message.sessionId&&sessions.has(message.sessionId)){
    if(!sessions.has(message.sessionId)||message.method.startsWith('Browser.'))throw Error('Foreign CDP session refused');
    const outgoing=message.method==='Target.setAutoAttach'?{...message,params:{...message.params,waitForDebuggerOnStart:false}}:message;
    raw(outgoing);return;
   }
   if(message.sessionId&&!browserSessions.has(message.sessionId))throw Error('Foreign CDP session refused');
   if(message.method==='Target.attachToBrowserTarget'){const result=await command('Target.attachToBrowserTarget');browserSessions.add(result.sessionId);emit({id:message.id,...(message.sessionId?{sessionId:message.sessionId}:{}),result});return}
   if(message.method==='Target.setAutoAttach'){
    if(message.params?.autoAttach&&!attach)attach=command('Target.attachToTarget',{targetId:lease.target_id,flatten:true});
    if(attach)await attach;
    emit({id:message.id,result:{}});return;
   }
   if(message.method==='Target.setDiscoverTargets'){emit({id:message.id,result:{}});return}
   if(message.method==='Target.getTargets'){
    const result=await command('Target.getTargets');emit({id:message.id,result:{targetInfos:result.targetInfos.filter(t=>t.targetId===lease.target_id)}});return;
   }
   if(message.method==='Target.attachToTarget'&&message.params?.targetId===lease.target_id&&message.params.flatten===true){raw(message);return}
   if(message.method==='Target.detachFromTarget'&&(sessions.has(message.params?.sessionId)||browserSessions.has(message.params?.sessionId))){raw(message);return}
   if(!['Browser.getVersion','Target.getTargetInfo'].includes(message.method))throw Error('Shared-browser command is outside the owned-target adapter: '+message.method);
   raw(message);
  }catch(error){rejectMessage(message,error)}
 }
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(Error('Owned CDP websocket timeout'))},5000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Owned CDP websocket failed'))},{once:true})});
  const {targetInfo}=await command('Target.getTargetInfo',{targetId:lease.target_id});
  const url=new URL(targetInfo.url);
  if(targetInfo.type!=='page'||targetInfo.targetId!==lease.target_id||url.origin!=='https://chatgpt.com'||url.searchParams.getAll('aicc_task_target').length!==1||url.searchParams.get('aicc_task_target')!==lease.task_target_nonce)throw Error('Exact owned CDP target binding differs');
  return await chromium.connectOverCDP(transport,{timeout:20000,noDefaults:true,isLocal:true});
 }catch(error){transport.close();throw error}
}
async function runUI(p,{verifyIdentity=async()=>{}}={}){
 const {helper,account}=ownerConfig(p.configFile,p.account), {chromium}=browserLibrary(p);
 const owner='personal-skills-'+p.command+'-'+crypto.randomUUID();let lease,browser,error=null;
 const outputs=[],responseJobs=[];let mutation,journalError=false;
 const journalTransport=event=>{
  if(!mutation||!p.backupReceipt)return;
  try{fs.appendFileSync(p.backupReceipt+'.transport.jsonl',JSON.stringify({...event,observedAt:new Date().toISOString()})+'\n',{encoding:'utf8',mode:0o600})}catch{journalError=true}
 };
 const startMutation=()=>{
  if(p.filePlan){
   const ready=assertBackupReceipt(p.backupReceipt,{assetKey:'skill|'+p.account+'|'+p.skillId,
    operation:'update-body',preimageSHA256:p.expectedCurrentSha.toLowerCase(),desiredSHA256:sha(p.desiredBody),
    requiredFileHashes:[p.expectedCurrentSha.toLowerCase(),sha(p.desiredBody)]});
   if(ready.bundleSHA256!==p.filePlan.backupBundleSHA256)throw Error('HOLD_FILE_PLAN_BACKUP_CHANGED');
  }
  mutation=beginMutation(p.backupReceipt,{assetKey:'skill|'+p.account+'|'+(p.skillId||p.name),operation:p.command==='upload'?'create':p.command,preimageSHA256:p.expectedCurrentSha?.toLowerCase()||sha(''),desiredSHA256:p.command==='upload'?p.package.sha256:p.command==='update-body'?sha(p.desiredBody):p.command==='update'?sha(p.desiredDescription):sha(''),recoveryComplete:p.command==='delete',requiredFileHashes:p.command==='upload'?[p.package.sha256]:p.command==='update-body'?(p.filePlan?[p.expectedCurrentSha.toLowerCase(),sha(p.desiredBody)]:[sha(p.desiredBody)]):p.command==='update'?[sha(p.desiredDescription)]:[]})};
 try{
  const ret=leaseCmd(helper,['-Action','Acquire','-OwnerId',owner,'-AccountAlias',account.alias,'-Workspace',account.workspace,'-Url','https://chatgpt.com/skills','-TtlSec','600']);
  lease=ret.lease;
  if(!ret.ok||!lease||lease.account_alias!==p.account||lease.workspace!==account.workspace||!lease.lease_token||!lease.target_id||!/^http:\/\/127\.0\.0\.1:\d+$/.test(lease.endpoint))throw Error('lease identity mismatch');
  browser=await connectOwnedBrowser(chromium,lease);const page=await getExactTarget(browser,lease.target_id,lease.task_target_nonce);
  page.on('response',r=>{
   try{
    const u=new URL(r.url());if(u.origin!=='https://chatgpt.com'||r.request().method()==='GET'||!/hazelnuts|skills/i.test(u.pathname))return;
    const event={method:r.request().method(),status:r.status(),path:u.pathname.slice(0,150)};outputs.push(event);journalTransport(event);
    let bodyTimer;
    const job=Promise.race([r.json(),new Promise((_,reject)=>{bodyTimer=setTimeout(()=>reject(Error('response_body_timeout')),15000)})]).then(body=>{
     // IDs are hints until the same owner/editor and exact content are read back.
     // Do not store response bodies, descriptions, auth material or arbitrary fields.
     const candidates=[];for(const value of [body,body?.hazelnut,body?.skill,body?.upload])if(value&&typeof value==='object'){
      for(const key of ['id','hazelnut_id','skill_id','upload_id'])if(ID.test(value[key]||''))candidates.push({field:key,value:value[key]});
     }
     if(candidates.length){event.candidateIds=candidates;event.identityVerified=false;journalTransport(event)}
    }).catch(()=>{}).finally(()=>clearTimeout(bodyTimer));responseJobs.push(job);
   }catch{}
  });
  let list=null;
  let addFileIdentity=null;
  if(p.command==='add-file'){
   // Personal add-file binds the live session to the caller's expected identity, not the alias alone.
   if(account.workspace!=='account-'+p.expectedWorkspaceHash.toLowerCase())throw Error('HOLD_IDENTITY_MISMATCH: registered workspace differs');
   const audit=await import(pathToFileURL(p.identityModule).href);
   addFileIdentity=async()=>{const actual=audit.assertAuthoritativeSessionIdentity(await page.evaluate(audit.sessionIdentityHashExpression()));if(actual.identityHash!==p.expectedIdentityHash.toLowerCase()||actual.workspaceIdentityHash!==p.expectedWorkspaceHash.toLowerCase())throw Error('HOLD_IDENTITY_MISMATCH: live session identity differs')};
   await addFileIdentity();
  }
  if(p.editorBindingData){
   const binding=p.editorBindingData;
   if(account.workspace!=='account-'+binding.expectedWorkspaceHash)throw Error('registered workspace binding mismatch');
   const audit=await import(pathToFileURL(p.identityModule).href);
   const checkIdentity=async()=>{const actual=audit.assertAuthoritativeSessionIdentity(await page.evaluate(audit.sessionIdentityHashExpression()));if(actual.identityHash!==binding.expectedIdentityHash||actual.workspaceIdentityHash!==binding.expectedWorkspaceHash)throw Error('live existing editor identity mismatch')};
   await checkIdentity();
   const url=new URL('https://chatgpt.com/skills/editor/'+p.skillId);url.searchParams.set('aicc_task_target',lease.task_target_nonce);
   await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:50000});
   await checkIdentity();
  }else list=await loadSkills(page);
  await verifyIdentity(page);
  if(p.command==='list')return {status:'listed',account:p.account,scope:'created_by_me',rows:list.rows,sections:list.sections,externalWritePerformed:false};
  if(p.command==='upload'){
   const check=[p.name,p.package.displayName];if(list.rows.some(x=>check.includes(x.displayName)))throw Error('skill already exists: no duplicate upload');
   if(!p.commit)return {status:'dry_run',name:p.name,sha256:p.package.sha256,scope:'created_by_me',externalWritePerformed:false};
   await verifyIdentity(page);startMutation();
   const add=page.getByRole('button',{name:'스킬 추가',exact:true});if(await add.count()!==1)throw Error('add control not unique');await add.dispatchEvent('pointerdown',{button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true});
   const choice=page.getByRole('menuitem',{name:'컴퓨터에서 업로드',exact:true});await choice.waitFor({state:'visible',timeout:12000});if(await choice.count()!==1)throw Error('upload menu missing');
   const uploadResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).origin==='https://chatgpt.com'&&new URL(r.url()).pathname==='/backend-api/hazelnuts/uploads/create',{timeout:60000}).catch(()=>null);
   const event=page.waitForEvent('filechooser',{timeout:9000}).catch(()=>null);await choice.dispatchEvent('click');
   const fc=await event;if(fc)await fc.setFiles(p.file);else{const input=page.locator('input[type="file"]');if(await input.count()!==1)throw Error('upload input ambiguous');await input.setInputFiles(p.file)};
   const uploadHttp=await uploadResponse;
   if(!uploadHttp||uploadHttp.status()!==201)throw Error('upload response uncertain or refused; reconcile original operation');
   // Current UI may finish without the older success dialog. HTTP 201 is only
   // transport acceptance; the fresh exact owner ID and full body below are mandatory.
   const dialog=page.getByRole('dialog');
   if(await dialog.count()>1)throw Error('upload result ambiguous');
   if(await dialog.count()===1){
    const result=await dialog.innerText();if(result.includes('업로드 실패'))throw Error('upload error or review');
    if(result.includes('스킬 업로드됨')){const done=dialog.getByRole('button',{name:'완료',exact:true});if(await done.count()!==1)throw Error('upload finish missing');await done.dispatchEvent('click');}
   }
   const submitted=outputs.some(x=>x.method==='POST'&&x.status===201&&x.path==='/backend-api/hazelnuts/uploads/create');
   let record=null,info=null,body=null;
   for(let observation=0;observation<4;observation++){
    const after=await loadSkills(page),candidates=uploadCandidates(list,after,[p.name,p.package.displayName]);
    if(candidates.length===1){
     record=candidates[0];await clickCreated(page,record.displayName,after);
     info=await editor(page,p.name);body=await codeBody(page,'SKILL.md');await verifyIdentity(page);
     break;
    }
    if(candidates.length>1)break;
    if(observation<3)await page.waitForTimeout(2000*(observation+1));
   }
   const verified=record&&info&&body&&submitted&&sha(canonicalBody(body.text))===p.package.bodySHA256;
   return {status:verified?'installed_verified':'HOLD_UPLOAD_POSTREAD',account:p.account,name:p.name,displayName:record?.displayName||null,skillId:info?.id||null,bodySHA256:body?.bodySHA256||null,zipSHA256:p.package.sha256,remoteMutation:true,requests:outputs};
  }
  if(!p.editorBindingData){
   const row=findOwned(list,p.displayName);if(!row)throw Error('own skill missing or display drift');
   await clickCreated(page,p.displayName,list);
  }
  const info=await editor(page,p.name,p.skillId||undefined);
  if(p.command==='add-file'){
   if(info.id!==p.skillId)throw Error('ID conflict; stop without modifying');
   const row=findOwned(list,p.displayName);if(row?.id&&row.id!==p.skillId)throw Error('owner-created row ID differs; stop without modifying');
   return await addFileFlow(addFileDriver(page,p),p,{outputs,
    verifyIdentity:async()=>{await addFileIdentity();await verifyIdentity(page)},
    assertGate:()=>addFileBackupGate(p),
    beginMutation:()=>{mutation=beginMutation(p.backupReceipt,addFileGateExpected(p))}});
  }
  if(p.command==='inspect'){const body=await codeBody(page,p.filePath||'SKILL.md');return {status:'inspected',account:p.account,displayName:p.displayName,id:info.id,name:info.name,filePath:p.filePath||'SKILL.md',descriptionSHA256:info.descriptionHash,descriptionLength:info.descriptionLength,bodySHA256:body.bodySHA256,bodyLength:body.bodyLength,...(p.includeFiles?{editorFileControls:await page.locator('button,[role=button]').evaluateAll(es=>es.map(e=>({text:(e.innerText||'').trim(),label:e.getAttribute('aria-label'),role:e.getAttribute('role')})).filter(x=>x.text==='SKILL.md'||['agents','assets','references'].includes(x.label)||/^(?:agents|assets|references|scripts)\/[a-zA-Z0-9_./-]+$/.test(x.label||'')))}:{}),...(p.includeBody?{bodyText:body.text,descriptionText:info.descriptionText}:{}),externalWritePerformed:false};}
  if(info.id!==p.skillId)throw Error('ID conflict; stop without modifying');
  let bodyBefore=null;
  if(p.command==='update-body'||p.command==='plan-file'){
   try{bodyBefore=await codeBody(page,p.filePath||'SKILL.md')}
   catch(error){
    if(p.command!=='plan-file')throw error;
    return {status:'HOLD_EXISTING_SUPPORT_FILE_UNPROVEN',skillId:p.skillId,filePath:p.filePath,
     reason:'The exact existing owned file could not be read through the supported editor',
     nextActor:'owner-manager-maintainer',automaticRetry:false,remoteMutation:false,
     newFileSupported:false,wholeZipReplacementSupported:false};
   }
  }
  const preimage=bodyBefore?bodyBefore.bodySHA256:info.descriptionHash;
  if(preimage!==p.expectedCurrentSha.toLowerCase())throw Error('preimage conflict; stop without modifying');
  if(p.command==='plan-file'){
   await verifyIdentity(page);
   const receipt=assertBackupReceipt(p.backupReceipt,{assetKey:'skill|'+p.account+'|'+p.skillId,
    operation:'update-body',preimageSHA256:preimage,desiredSHA256:sha(p.desiredBody),
    requiredFileHashes:[preimage,sha(p.desiredBody)]});
   for(const suffix of ['.operation.json','.operation.lock'])if(fs.existsSync(p.backupReceipt+suffix))throw Error('HOLD_ORIGINAL_OPERATION_RECONCILE');
   return {status:'FILE_PLAN_READY',kind:'existing-support-file-plan/v1',account:p.account,
    name:p.name,displayName:p.displayName,skillId:p.skillId,filePath:p.filePath,
    bodyFile:p.bodyFile,desiredSourceSHA256:p.desiredSourceSHA256,
    beforeSHA256:preimage,desiredSHA256:sha(p.desiredBody),backupReceipt:p.backupReceipt,
    backupBundleSHA256:receipt.bundleSHA256,remoteMutation:false,externalWritePerformed:false,
    newFileSupported:false,wholeZipReplacementSupported:false,automaticRetry:false};
  }
  if(!p.commit)return {status:'dry_run',account:p.account,operation:p.command,name:p.name,id:info.id,currentSHA256:preimage,externalWritePerformed:false};
  if(p.command==='update'){
   if(info.descriptionHash===sha(p.desiredDescription))return {status:'already_current',remoteMutation:false};
   await verifyIdentity(page);startMutation();
   await info.desc.fill(p.desiredDescription);const save=page.getByRole('button',{name:'변경 사항 저장'});if(await save.count()!==1||!await save.isEnabled())throw Error('update save disabled');
   await save.dispatchEvent('click');await page.waitForTimeout(1500);await page.reload({waitUntil:'domcontentloaded',timeout:50000});const after=await editor(page,p.name,p.skillId);
   const updated=after.descriptionHash===sha(p.desiredDescription);
   return {status:updated?'updated_verified':'HOLD_UPDATE_POSTREAD',name:p.name,skillId:info.id,beforeSHA256:info.descriptionHash,afterSHA256:after.descriptionHash,verified:updated,remoteMutation:true,requests:outputs};
  }
  if(p.command==='update-body'){
   if(canonicalBody(bodyBefore.text)===canonicalBody(p.desiredBody))return {status:'already_current',remoteMutation:false};
   if(p.editorBindingData&&!await bodyBefore.code.isEditable())throw Error('HOLD existing resource editor is read-only; no write');
   await verifyIdentity(page);startMutation();
   await page.evaluate(text=>{
    const es=[...document.querySelectorAll('[role="textbox"][aria-label="코드 편집"]')];if(es.length!==1)throw Error('Exact body editor is not unique');
    const el=es[0],bridge=el.cmTile||el.cmView||el.closest('.cm-editor')?.cmView,linked=bridge?.view||bridge?.root?.view||bridge?.rootView?.view,view=linked?.constructor?.findFromDOM?.(el);
    if(!view||view!==linked||view.contentDOM!==el)throw Error('Exact CodeMirror editor unavailable');
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:text}});
   },p.desiredBody);
   const enteredText=await fullLogicalBody(page,bodyBefore.code);
   if(enteredText!==p.desiredBody)throw Error('CodeMirror input mismatch; refuse save');
   const save=page.getByRole('button',{name:'변경 사항 저장',exact:true});
   await page.waitForFunction(()=>{const bs=[...document.querySelectorAll('button')].filter(b=>b.innerText==='변경 사항 저장');return bs.length===1&&!bs[0].disabled},null,{timeout:12000});
   if(await save.count()!==1||!await save.isEnabled())throw Error('body save disabled');
   await save.dispatchEvent('click');await page.waitForTimeout(1800);
   // Persistence may lag the Save click. Reconcile read-only, never replay Save.
   let after,updated=false;
   for(let observation=0;observation<4;observation++){
    await page.reload({waitUntil:'domcontentloaded',timeout:50000});await editor(page,p.name,p.skillId);
    after=await codeBody(page,p.filePath||'SKILL.md');updated=canonicalBody(after.text)===canonicalBody(p.desiredBody);
    if(updated||after.bodySHA256!==bodyBefore.bodySHA256)break;
    if(observation<3)await page.waitForTimeout(2000*(observation+1));
   }
   return {status:updated?'body_updated_verified':'HOLD_BODY_POSTREAD',name:p.name,skillId:info.id,beforeSHA256:bodyBefore.bodySHA256,afterSHA256:after.bodySHA256,verified:updated,boundaryNewlinesNormalized:updated&&after.text!==p.desiredBody,remoteMutation:true,requests:outputs};
  }
  // Delete only a previously inspected owner-created skill with a matching editor ID and description hash.
  await verifyIdentity(page);startMutation();
  await loadSkills(page);const actions=ownButton(page,p.displayName);const count=await actions.count();if(count!==1)throw Error('delete own row ambiguity');
  await actions.dispatchEvent('pointerdown',{button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true});const remove=page.getByRole('menuitem',{name:'삭제',exact:true});await remove.waitFor({state:'visible',timeout:12000});if(await remove.count()!==1)throw Error('delete menu unavailable');
  await remove.dispatchEvent('click');const dlg=page.getByRole('alertdialog').first();const modal=(await dlg.count())?dlg:page.getByRole('dialog').first();
  if(!await modal.count())throw Error('delete confirmation missing');const text=await modal.innerText();
  if(!text.includes(p.displayName)||!text.includes('스킬 삭제'))throw Error('delete confirmation not exact target');
  const confirm=modal.getByRole('button',{name:'스킬 삭제',exact:true});if(await confirm.count()!==1)throw Error('delete confirmation button ambiguous');
  await confirm.dispatchEvent('click');await page.waitForTimeout(1500);
  const after=await loadSkills(page);const gone=!findOwned(after,p.displayName);
  const receipt=outputs.find(x=>x.method==='DELETE'&&x.status===200&&x.path==='/backend-api/hazelnuts/'+p.skillId);
  return {status:gone&&receipt?'deleted_verified':'HOLD_DELETE_POSTREAD',name:p.name,skillId:p.skillId,verified:!!(gone&&receipt),remoteMutation:true,requests:outputs};
 }finally{
  await Promise.allSettled(responseJobs);
  if(mutation){mutation.close()}
  if(journalError)error='transport_evidence_write_failed_reconcile_original';
  if(browser)await browser.close().catch(()=>{});
  if(lease){try{const r=leaseCmd(helper,['-Action','Release','-LeaseToken',lease.lease_token]);if(!r.ok||r.target_closed!==true)error='lease_release_uncertain';}catch{error='lease_release_uncertain'}}
  if(error)throw Error('HOLD '+error);
 }
}
// The existing fixed host calls this adapter after its owner binding/denial checks.
// Remote action fields cannot supply executable, browser, identity or account authority.
function prepareNamedAddFileRequest(request,owner){
 const actions=new Set(['personal-skill-plan-add-file','personal-skill-add-file']);
 if(!request||!actions.has(request.action)||request.schemaVersion!==1)throw Error('named add-file action required');
 const keys=new Set(['schemaVersion','action','skill','commit','backupReceipt','confirm']);
 if(Object.keys(request).some(k=>!keys.has(k)))throw Error('unknown named add-file request field');
 const s=request.skill,skillKeys=new Set(['name','displayName','skillId','filePath','bodyFile','bodyFileSHA256','expectedCurrentSha','expectedTreeSha']);
 if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!skillKeys.has(k)))throw Error('unknown named add-file skill field');
 if(!owner||!path.isAbsolute(owner.config||'')||!path.isAbsolute(owner.identityModule||'')||!HASH.test(owner.identityHash||'')||!HASH.test(owner.workspaceIdentityHash||''))throw Error('fixed owner identity/config required');
 const commit=request.action==='personal-skill-add-file';
 if(commit?request.commit!==true:((request.commit!==undefined&&request.commit!==false)||request.confirm!==undefined))throw Error('named add-file plan/apply mismatch');
 return prepare({command:'add-file',account:owner.account,config:owner.config,identityModule:owner.identityModule,
  expectedIdentityHash:owner.identityHash,expectedWorkspaceHash:owner.workspaceIdentityHash,
  ...s,commit,ack:commit?s.name:undefined,confirm:request.confirm,backupReceipt:request.backupReceipt});
}
async function runPrepared(raw,options){const p=prepare(raw);
 // Pure local dry run. Do not incur external mutations for a plan-only request.
 if(!p.commit&&p.command!=='list'&&p.command!=='inspect'&&p.command!=='plan-file'&&p.command!=='add-file')return {status:'dry_run',operation:p.command,name:p.name,zipSHA256:p.package?.sha256||null,externalWritePerformed:false};
 const result=await runUI(p,options);
 if(p.backupReceipt&&result.remoteMutation===true){const attempt=p.backupReceipt+'.operation.json';const state=JSON.parse(fs.readFileSync(attempt,'utf8'));state.status=result.verified===true||result.status==='installed_verified'?'APPLIED':'OUTCOME_UNKNOWN_RECONCILE';state.result=result;fs.writeFileSync(attempt,JSON.stringify(state,null,2))}
 return result;
}
async function main(){const result=await runPrepared(parse(process.argv.slice(2)));console.log(JSON.stringify(result,null,2));if(/^(HOLD|UNKNOWN|FAILED|REFUSED)/.test(result.status))process.exitCode=2;}
if(require.main===module)main().catch(e=>{process.stderr.write('HOLD '+String(e.message||e)+'\n');process.exitCode=1});
module.exports={parse,prepare,prepareNamedAddFileRequest,readZipSkill,findOwned,uploadCandidates,ownerConfig,runPrepared,connectOwnedBrowser,validateAddPath,addFileFlow,addFileBackupGate,addFileGateExpected,treeHash};
