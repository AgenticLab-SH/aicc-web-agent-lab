import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {startOfficialManagement} from './external-stock-management';
const root=process.env.AICC_OCX_SUPPLIER_ROOT,home=process.env.OPENCODEX_HOME;
if(!root || !home || !process.env.CODEX_HOME) throw Error('isolated-management-fixture-required');
const connectionFile=join(home,'fixture-connection.json');
writeFileSync(join(home,'config.json'),JSON.stringify({port:10100,hostname:'127.0.0.1',runtimeRole:'client',
  codexAutoStart:false,clientIntegrations:{codex:false},providers:{},defaultProvider:'openai',codexAccounts:[]}));
writeFileSync(connectionFile,JSON.stringify({runtimeRole:'client',client:{serverUrl:'http://localhost:10101',
  managementUrl:'http://localhost:10102',managementTransport:'relay',protocolVersion:1,
  selectedClients:[],apiKeyId:'fixture-api-key',tokenFingerprint:'fixture-fingerprint',connectedAt:new Date().toISOString()}}));
const management=await startOfficialManagement(root,connectionFile),checks:string[]=[];
const base='http://localhost:10100';
try {
  const result=await management.handle(new Request(base+'/'));
  const html=await result.text();
  assert.equal(result.status,200);assert.match(html,/opencodex-runtime-role" content="client/);
  checks.push('unmodified-supplier-client-gui-served');
  const meta=(name:string)=>html.match(new RegExp('<meta name="'+name+'" content="([^"]+)"'))?.[1];
  const token=meta('opencodex-session-token'),csrf=meta('opencodex-session-csrf');
  assert.ok(token);assert.ok(csrf);
  assert.equal(meta('opencodex-session-origin'),base);assert.equal(meta('opencodex-session-server-origin'),base);
  checks.push('public-origin-session-preserved-through-private-listener');
  const headers={'x-opencodex-api-key':token!,'x-opencodex-gui-origin':base,'x-opencodex-csrf-token':csrf!,origin:base};
  assert.equal((await management.handle(new Request(base+'/api/machine/status'))).status,401);
  checks.push('unauthenticated-machine-status-refused');
  const status=await management.handle(new Request(base+'/api/machine/status',{headers}));
  assert.equal(status.status,200);const value=await status.json();
  assert.equal(value.machineBase,base);assert.equal(value.sharedBase,base+'/api/machine/hub-relay');
  checks.push('authenticated-machine-status-uses-existing-a1-management');
  assert.equal((await management.handle(new Request(base+'/api/machine/status',{headers:{...headers,'x-opencodex-gui-origin':'https://invalid.example'}}))).status,401);
  checks.push('foreign-origin-session-refused');
  for(const path of ['/v1/responses','/v1/responses/compact','/v1/models']) {
    const result=await management.handle(new Request(base+path,{method:'POST',headers:{...headers,authorization:'Bearer fixture-data'},body:'{}'}));
    assert.equal(result.status,404);await result.text();
  }
  checks.push('management-listener-cannot-bypass-inference-boundary');
  const mutation=await management.handle(new Request(base+'/api/machine/disconnect',{method:'POST',headers,body:'{}'}));
  assert.equal(mutation.status,403);await mutation.text();
  checks.push('gui-session-cannot-rewrite-native-client-configuration');
  console.log(JSON.stringify({status:'PASS',scope:'isolated-stock-management',supplier:(process.env.AICC_OCX_SUPPLIER_VERSION ?? '2.81.0'),checks,
    remoteA1Calls:0,realNativeAccess:false}));
} finally {management.stop();}
