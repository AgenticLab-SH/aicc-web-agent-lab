'use strict';
// Fake page driver for add-file tests. It emulates the observed editor tree and records
// every call. No browser, CDP, network or ChatGPT access.
const crypto=require('node:crypto');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const SKILL_BODY='# Example skill\n\nUse the references.\n';
function fakeDriver(options={}){
 const o={folderExists:true,draftName:'untitled.txt',renameWorks:true,inputEcho:true,saveEnabled:true,
  save:'persist',reload:'ok',remoteFiles:null,...options};
 const remote=new Map(o.remoteFiles||[['SKILL.md',SKILL_BODY],['agents/openai.yaml','interface: {}\n'],['references/manager-contract.md','contract\n']]);
 let local=new Map(remote),selected='SKILL.md';
 const calls=[];
 const rows=()=>{
  const folders=new Set([...local.keys()].filter(f=>f.includes('/')).map(f=>f.split('/')[0]));
  if(!o.folderExists)folders.delete('references');
  const files=[...local.keys()].filter(f=>o.folderExists||!f.startsWith('references/'));
  return [...[...folders].map(f=>({path:f,folder:true,current:false})),...files.map(f=>({path:f,folder:false,current:f===selected}))];
 };
 const drv={
  calls,remote,
  async readTree(folder){calls.push(['readTree',folder]);if(!rows().some(r=>r.folder&&r.path===folder))return {folderMissing:true,rows:[]};return {folderMissing:false,rows:rows()}},
  async readBody(path){calls.push(['readBody',path]);if(!local.has(path))throw Error('file row missing');const text=local.get(path);return {text,bodySHA256:sha(text)}},
  async openNewTextFile(){calls.push(['openNewTextFile']);if(o.draftName){local.set(o.draftName,'');selected=o.draftName}},
  async renameFile(from,to){calls.push(['renameFile',from,to]);if(!o.renameWorks)return;const v=local.get(from);local.delete(from);local.set(to,v);selected=to},
  async selectFile(path){calls.push(['selectFile',path]);if(!local.has(path))throw Error('HOLD_ADD_FILE_CONTROL_NOT_UNIQUE: '+path);selected=path},
  async setBody(text){calls.push(['setBody']);local.set(selected,o.inputEcho?text:text+'x');return local.get(selected)},
  async saveState(){calls.push(['saveState']);return {count:1,enabled:o.saveEnabled}},
  async clickSave(){
   calls.push(['clickSave']);
   if(o.save==='throw')throw Error('target closed during click');
   if(o.save==='persist')for(const [k,v] of local)remote.set(k,v);
   if(o.save==='persist-wrong-body')for(const [k,v] of local)remote.set(k,remote.has(k)?remote.get(k):v+'\ncorrupted');
   if(o.save==='persist-wrong-path')for(const [k,v] of local)remote.set(k.startsWith('references/new')?'untitled.txt':k,v);
   if(o.save==='persist-collateral'){for(const [k,v] of local)remote.set(k,v);remote.set('SKILL.md',SKILL_BODY+'changed\n')}
  },
  async reloadFresh(){calls.push(['reloadFresh']);if(o.reload==='throw')throw Error('reload did not produce a fresh document');local=new Map(remote);selected='SKILL.md'},
  async wait(ms){calls.push(['wait',ms])}
 };
 return drv;
}
const WRITE_CALLS=new Set(['openNewTextFile','renameFile','setBody','clickSave']);
const writes=calls=>calls.filter(c=>WRITE_CALLS.has(c[0])).map(c=>c[0]);
module.exports={fakeDriver,writes,sha,SKILL_BODY};
