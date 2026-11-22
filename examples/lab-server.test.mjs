import test from 'node:test';
import assert from 'node:assert/strict';
import { createLabServer } from './lab-server.mjs';

test('lab serves the app with private scope and a one-use synthetic confirmation', async t=>{
  const server=createLabServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin='http://127.0.0.1:'+server.address().port;
  const read=(url,headers)=>fetch(origin+url,{headers});
  const post=(endpoint,body,headers={})=>fetch(origin+'/api/mobile/'+endpoint,{
    method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify(body)
  });
  assert.equal((await read('/mobile.html')).status,200);
  assert.equal((await read('/api/mobile/apps')).status,409);
  assert.equal((await read('/downloads/aicc-mobile.apk')).status,404);
  assert.equal((await read('/.env.example')).status,404);
  const session=await post('local-session',{});
  const {csrf}=await session.json();
  const cookie=session.headers.get('set-cookie').split(';')[0];
  const auth={cookie,'x-aicc-csrf':csrf};
  const catalog=await (await read('/api/mobile/apps',auth)).json();
  assert.equal(catalog.mock,true);
  assert.deepEqual(catalog.apps.map(a=>a.state),['WEB','WEB','PC_ONLY','UNAVAILABLE','RETIRED']);
  const payload={kind:'tray-tool',config:{action:'diagnostics'}};
  assert.equal((await post('preview',payload,{cookie})).status,403);
  assert.equal((await post('preview',payload,{...auth,origin:'https://other.example.invalid'})).status,403);
  assert.equal((await post('queue-send',{id:'demo'},auth)).status,403);
  assert.equal((await post('pair',{remember:true},auth)).status,403);
  const valid=await (await post('preview',payload,auth)).json();
  const proof={confirmationToken:valid.confirmationToken};
  const accepted=await (await post('confirm',proof,auth)).json();
  const result=await (await read('/api/mobile/operation?id='+accepted.operationId,auth)).json();
  assert.equal(result.toolResult.dispatched,false);
  assert.equal((await post('confirm',proof,auth)).status,409);
  const unknown=await (await read('/api/mobile/operation?id=demo-unconfirmed',auth)).json();
  assert.equal(unknown.state,'UNKNOWN');
  assert.equal(unknown.automaticReplay,false);
});
