// One owner-requested live canary, isolated from the registered service/Native
// homes. It neither installs nor restarts a service and never replays inference.
import assert from 'node:assert/strict';
import {zstdCompressSync} from 'node:zlib';
import {bindOfficialOcxDispatch} from './external-stock-dispatch';
import {createExternalPoolState} from './external-pool-state';
import {createRegisteredA1BrokerTransport} from './external-broker-transport';
import {createExternalOcxHttpBoundary} from './external-http-boundary';
const root=process.env.AICC_OCX_SUPPLIER_ROOT,home=process.env.OPENCODEX_HOME;
if(!root || !home || !process.env.CODEX_HOME || process.env.AICC_EXPLICIT_LIVE_CANARY!=='1')throw Error('explicit-isolated-live-canary-required');
const stock=await bindOfficialOcxDispatch(root,'2.81.0');
const pool=createExternalPoolState({home,transport:createRegisteredA1BrokerTransport(),clientVersion:'0.162.0-alpha.2',supplier:stock});
await pool.owner.refreshSnapshot(true);
const before=pool.owner.currentSnapshot();
assert.equal(before.settings.fiveHour.usedThreshold,97);assert.equal(before.settings.longWindow.usedThreshold,97);
let physicalDispatches=0,selectedAccount:string|undefined;
const boundary=createExternalOcxHttpBoundary({dataToken:()=> 'isolated-canary',settings:pool.settings,
  select:pool.select,preparedBody:pool.preparedBody,generationLive:pool.generationLive,quota:pool.quota,
  refresh:pool.refresh,noteDispatch:pool.noteDispatch,
  dispatch:(request,lease)=>{physicalDispatches++;selectedAccount=lease?.accountId;return stock.dispatchFull(request,lease);},
  catalog:async()=>Response.json({})});
const catalog=await pool.catalog();
assert.ok(catalog.some(row=>row.slug==='gpt-6.1-sol' && Array.isArray(row.supported_reasoning_levels)));
const compressed=process.env.AICC_CANARY_ENCODING==='zstd';
const requestBody=JSON.stringify({model:'gpt-6.1-sol',instructions:'Follow the user request exactly.',store:false,stream:false,
  reasoning:{effort:'low'},input:[{role:'user',content:[{type:'input_text',text:'Return exactly AICC_OCX_281_CANARY'}]}]});
const request=new Request('http://127.0.0.1:10100/v1/responses',{method:'POST',
  headers:{authorization:'Bearer isolated-canary','content-type':'application/json','thread-id':'aicc-281-live-canary-'+crypto.randomUUID(),
    ...(compressed?{'content-encoding':'zstd'}:{})},
  body:compressed?zstdCompressSync(requestBody):requestBody,
  signal:AbortSignal.timeout(60_000)});
const response=await boundary.handle(request),body=await response.text();
assert.equal(response.status,200,'live-canary-http-status-'+response.status);
assert.ok(body.includes('AICC_OCX_281_CANARY'),'live-canary-marker-missing');
assert.equal(physicalDispatches,1);assert.equal(boundary.activeTurns(),0);
assert.notEqual(selectedAccount,'__main__');
console.log(JSON.stringify({status:'PASS',scope:'single-isolated-live-candidate-request',supplier:'2.81.0',
  bunVersion:Bun.version,physicalDispatches,requestEncoding:compressed?'zstd':'identity',marker:'AICC_OCX_281_CANARY',httpStatus:response.status,
  catalogCount:catalog.length,discoveryCount:pool.discovery(catalog).length,selectedAccount,
  requestExecution:'windows-local',credentialWriter:'a1',nativeExcluded:true,registeredRuntimeChanged:false}));
