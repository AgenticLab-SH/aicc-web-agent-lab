// Imports the pinned official package without starting its server. Inference,
// quota and account operations use an explicit fake fetch, never the network.
import assert from 'node:assert/strict';
import { bindOfficialOcxDispatch } from './external-stock-dispatch';
const root=process.env.AICC_OCX_SUPPLIER_ROOT;
if(!root || !process.env.OPENCODEX_HOME || !process.env.CODEX_HOME) throw Error('isolated-stock-fixture-required');
const sends:{url:string;headers:Headers;body:any}[]=[];
let fixtureStatus=200;
globalThis.fetch=async(input:any,init:any)=>{
  sends.push({url:String(input),headers:new Headers(init.headers),body:JSON.parse(init.body)});
  assert.ok(['error','manual'].includes(init.redirect));
  if(fixtureStatus!==200)return Response.json({error:{code:'fixture_upstream_failure',message:'fixture failure'}},{status:fixtureStatus});
  if(String(input).endsWith('/responses/compact')) return Response.json({id:'cmp_fixture',object:'response.compaction',created_at:0,output:[]});
  return Response.json({id:'resp_fixture',object:'response',created_at:0,status:'completed',
    model:'gpt-6.1-sol',output:[{id:'msg_fixture',type:'message',role:'assistant',status:'completed',
      content:[{type:'output_text',text:'fixture-ok',annotations:[]}]}]});
};
const stock=await bindOfficialOcxDispatch(root,(process.env.AICC_OCX_SUPPLIER_VERSION ?? '2.81.0'));
const config={defaultProvider:'openai',providers:{openai:{adapter:'openai-responses',authMode:'forward',baseUrl:'https://chatgpt.com/backend-api/codex',codexAccountMode:'pool'}},codexAccounts:[],codexAccountNamespaces:{}};
const route=stock.resolveRoute(config,'gpt-6.1-sol');
assert.equal(route.modelId,'gpt-6.1-sol');
const headers={authorization:'Bearer fixture-access','chatgpt-account-id':'fixture-account','content-type':'application/json'};
const checks=['stock-import-does-not-start-service','canonical-route-resolved'];
for(const path of ['/v1/responses','/v1/responses/compact']) {
  const body={model:'gpt-6.1-sol',input:[{role:'user',content:'fixture-only'}]};
  const result=await stock.dispatch(new Request('http://127.0.0.1:10100'+path,{method:'POST',headers,body:JSON.stringify(body)}),{supplierContext:route.provider});
  assert.equal(result.status,200);await result.text();
  const sent=sends.at(-1)!;
  assert.equal(sent.url,'https://chatgpt.com/backend-api/codex'+path.replace('/v1',''));
  assert.equal(sent.headers.get('authorization'),'Bearer fixture-access');
  assert.equal(sent.headers.get('chatgpt-account-id'),'fixture-account');
  assert.equal(sent.body.model,'gpt-6.1-sol');
  checks.push(path.endsWith('compact')?'compact-envelope-and-auth-preserved':'responses-envelope-and-auth-preserved');
}
assert.equal(sends.length,2);checks.push('one-physical-send-per-request');
const before=sends.length;
await assert.rejects(stock.dispatch(new Request('http://127.0.0.1:10100/v1/responses',{method:'POST',headers,body:'{"model":"gpt-6.1-sol","input":[] }'}),{supplierContext:{...route.provider,baseUrl:'https://invalid.example'}}));
assert.equal(sends.length,before);checks.push('changed-provider-refused-before-send');
const carriers=stock.collectCarriers({previous_response_id:'fixture-response',input:[{type:'input_file',file_id:'fixture-file'}]});
assert.equal(carriers.previousResponseId,'fixture-response');assert.deepEqual(carriers.fileIds,['fixture-file']);checks.push('account-scoped-carriers-detected');
const fullBefore=sends.length;
const full=await stock.dispatchFull(new Request('http://127.0.0.1:10100/v1/responses',{method:'POST',headers,
  body:JSON.stringify({model:'gpt-6.1-sol',input:[{role:'user',content:'fixture-only'}],stream:false})}),{supplierContext:route.provider});
const fullText=await full.text();
assert.equal(full.status,200,fullText);assert.equal(sends.length,fullBefore+1);
assert.equal(sends.at(-1)!.headers.get('authorization'),'Bearer fixture-access');
assert.equal(sends.at(-1)!.headers.get('chatgpt-account-id'),'fixture-account');
assert.ok(fullText.includes('fixture-ok'));checks.push('full-stock-pipeline-forwards-request-owned-lease-once');
for(const status of [429,502,503]) {
  fixtureStatus=status;const before=sends.length;
  const result=await stock.dispatchFull(new Request('http://127.0.0.1:10100/v1/responses',{method:'POST',headers,
    body:JSON.stringify({model:'gpt-6.1-sol',input:[{role:'user',content:'fixture-only'}],stream:false})}),{supplierContext:route.provider});
  await result.text();assert.equal(result.ok,false);assert.equal(sends.length,before+1);
  checks.push('full-stock-'+status+'-not-replayed');
}
fixtureStatus=200;
const compactBefore=sends.length;
const compact=await stock.dispatchFull(new Request('http://127.0.0.1:10100/v1/responses/compact',{method:'POST',headers,
  body:JSON.stringify({model:'gpt-6.1-sol',input:[{role:'user',content:'fixture-only'}]})}),{supplierContext:route.provider});
assert.equal(compact.status,200,await compact.text());assert.equal(sends.length,compactBefore+1);
assert.equal(sends.at(-1)!.url,'https://chatgpt.com/backend-api/codex/responses/compact');
checks.push('full-stock-native-compact-single-send');
const fastConfig={...config,fastRows:true,multiAgentMode:'v1',subagentModels:['gpt-6.1-sol']};
const fastRoute=stock.resolveRoute(fastConfig,'gpt-6.1-sol--fast');
assert.equal(fastRoute.modelId,'gpt-6.1-sol');assert.equal(fastRoute.wireModel,'gpt-6.1-sol--fast');
checks.push('stock-fast-selector-admission-uses-physical-base-model');
const catalog=stock.buildCatalog(fastConfig,[{slug:'gpt-6.1-sol',additional_speed_tiers:['fast']}]);
assert.equal(catalog.length,1);assert.equal(catalog[0].slug,'gpt-6.1-sol');
assert.ok(catalog[0].base_instructions);assert.ok(Array.isArray(catalog[0].supported_reasoning_levels));
assert.equal(catalog[0].multi_agent_version,'v1');checks.push('stock-native-catalog-keeps-instructions-effort-and-agent-contract');
assert.deepEqual(stock.discovery(fastConfig,[{slug:'gpt-6.1-sol',additional_speed_tiers:['fast']}]).map(row=>row.id),
  ['gpt-6.1-sol','gpt-6.1-sol--fast']);checks.push('stock-fast-discovery-requires-tier-evidence');
const original={model:'gpt-6.1-sol',previous_response_id:'resp_foreign',conversation:'conv_foreign',input:[
  {role:'user',content:[{type:'input_text',text:'readable history'}]},
  {type:'reasoning',id:'foreign_reasoning',encrypted_content:'ciphertext',summary:[{type:'summary_text',text:'readable summary'}]},
  {type:'function_call',call_id:'call_fixture',name:'fixture_tool',arguments:'{}'},
  {type:'function_call_output',call_id:'call_fixture',output:'readable tool result'}]};
const scrubbed=await stock.scrubAccountChange(original);
assert.equal(scrubbed.previous_response_id,undefined);assert.equal(scrubbed.conversation,undefined);
assert.ok(!JSON.stringify(scrubbed).includes('ciphertext'));assert.ok(!JSON.stringify(scrubbed).includes('foreign_reasoning'));
assert.ok(JSON.stringify(scrubbed).includes('readable history'));assert.ok(JSON.stringify(scrubbed).includes('readable summary'));
assert.ok(JSON.stringify(scrubbed).includes('readable tool result'));assert.equal(original.previous_response_id,'resp_foreign');
checks.push('stock-account-change-scrub-preserves-readable-history-and-tool-results');
await assert.rejects(stock.scrubAccountChange({model:'gpt-6.1-sol',input:[{type:'input_file',file_id:'file_foreign'}]}));
checks.push('uploaded-file-scope-cannot-be-silently-moved');
console.log(JSON.stringify({status:'PASS',scope:'pinned-official-dispatch',supplier:stock.supplier.version,network:'fixture-only',checks}));
