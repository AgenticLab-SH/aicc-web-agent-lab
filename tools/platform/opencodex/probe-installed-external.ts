// One explicit installed-route canary. Never replay a failed/ambiguous send.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {zstdCompressSync} from 'node:zlib';
const registry=JSON.parse(readFileSync(join(homedir(),'.ai-control-center','runtime','ocx-local','current.json'),'utf8'));
if(registry.adapterVersion!=='0.1.1')throw Error('expected_installed_adapter_required');
const data=readFileSync(registry.tokenFile,'utf8').trim();
const admin=readFileSync(join(registry.opencodexHome,'admin-api-token'),'utf8').trim();
const base='http://127.0.0.1:10100';
const status=await fetch(base+'/api/system/memory',{headers:{'x-opencodex-api-key':admin},signal:AbortSignal.timeout(5000)});
if(status.status!==200)throw Error('legacy_admin_status_failed');
await status.json();
const models=await fetch(base+'/v1/models?client_version=0.162.0-alpha.2',{headers:{authorization:'Bearer '+data},signal:AbortSignal.timeout(30000)});
if(models.status!==200)throw Error('installed_catalog_failed');
const catalog:any=await models.json();
if(!catalog.models?.some((row:any)=>row.slug==='gpt-6.1-sol'))throw Error('installed_model_missing');
const marker='AICC_OCX_281_COMPRESSED_OK';
const response=await fetch(base+'/v1/responses',{method:'POST',redirect:'error',
  headers:{authorization:'Bearer '+data,'content-type':'application/json','content-encoding':'zstd','thread-id':'aicc-installed-wire-'+crypto.randomUUID()},
  body:zstdCompressSync(JSON.stringify({model:'gpt-6.1-sol',instructions:'Follow the user request exactly.',store:false,stream:false,
    reasoning:{effort:'low'},input:[{role:'user',content:[{type:'input_text',text:'Return exactly '+marker}]}]})),
  signal:AbortSignal.timeout(60000)});
const text=await response.text();
if(response.status!==200 || !text.includes(marker))throw Error('installed_compressed_request_not_completed');
const ready=await fetch(base+'/readyz',{signal:AbortSignal.timeout(5000)}).then(r=>r.json()) as any;
if(ready.adapterVersion!=='0.1.1')throw Error('installed_owner_changed');
console.log(JSON.stringify({status:'PASS',scope:'installed-external-ocx',adapterVersion:'0.1.1',supplier:'2.81.0',
  requestEncoding:'zstd',physicalRequests:1,httpStatus:response.status,marker,legacyManagementAuth:'PASS',catalog:'PASS',localActive:ready.localActive}));
