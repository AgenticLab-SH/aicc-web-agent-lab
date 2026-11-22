import assert from 'node:assert/strict';
import {bindOfficialOcxDispatch} from './external-stock-dispatch';
import {createExternalOcxHttpBoundary} from './external-http-boundary';
import {createExternalResponseSocket} from './external-response-socket';
const root=process.env.AICC_OCX_SUPPLIER_ROOT;
if(!root || !process.env.OPENCODEX_HOME || !process.env.CODEX_HOME)throw Error('isolated-socket-fixture-required');
const stock=await bindOfficialOcxDispatch(root,(process.env.AICC_OCX_SUPPLIER_VERSION ?? '2.81.0')),checks:string[]=[];
let sends=0,hold=false,cancelled=false,percent=10;
const boundary=createExternalOcxHttpBoundary({dataToken:()=> 'fixture-data',
  settings:()=>({fiveHour:{usedThreshold:97,action:'switch'},longWindow:{usedThreshold:97,action:'switch'}}),
  select:async()=>({accountId:'fixture',chatgptAccountId:'fixture',accessToken:'fixture-access',generation:1,
    quota:{shortPercent:percent,weeklyPercent:10},quotaObservedAt:Date.now()}),
  generationLive:()=>true,quota:()=>({shortPercent:percent,weeklyPercent:10}),
  refresh:async()=>({quota:{shortPercent:percent,weeklyPercent:10},generation:1,verified:true}),
  catalog:async()=>Response.json({}),
  dispatch:async(request)=>{
    sends++;assert.equal(request.headers.get('authorization'),'Bearer fixture-access');
    return new Response(new ReadableStream({start(c){
      c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.created',response:{id:'resp_fixture',status:'in_progress'}})+'\n\n'));
      if(!hold){c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.completed',response:{id:'resp_fixture',status:'completed',output:[]}})+'\n\n'));c.close();}
    },cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
  }});
const socket=createExternalResponseSocket(stock,boundary);
const server=Bun.serve({port:0,hostname:'127.0.0.1',idleTimeout:0,
  fetch(request,server){
    if(request.headers.get('authorization')!=='Bearer fixture-data')return new Response(null,{status:401});
    const headers=new Headers(request.headers);headers.delete('upgrade');headers.delete('connection');
    if(server.upgrade(request,{data:{headers,url:request.url,busy:false,turnId:0}}))return;
    return new Response(null,{status:400});
  },websocket:socket.handlers});
const pause=(ms=20)=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(predicate:()=>boolean)=>{const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw Error('fixture-event-timeout');await pause();}};
let client:any;
try {
  const refused=new WebSocket('ws://127.0.0.1:'+server.port+'/v1/responses');
  let denied=false;refused.onerror=()=>{denied=true;};await until(()=>denied);
  assert.equal(sends,0);checks.push('websocket-handshake-requires-data-token');
  client=new WebSocket('ws://127.0.0.1:'+server.port+'/v1/responses',{headers:{authorization:'Bearer fixture-data'}});
  const frames:any[]=[];client.onmessage=(event:any)=>frames.push(JSON.parse(String(event.data)));
  await until(()=>client.readyState===1);
  client.send(JSON.stringify({type:'response.create',model:'gpt-6.1-sol',generate:false,input:[]}));
  await until(()=>frames.some(frame=>frame.type==='response.completed'));
  assert.equal(sends,0);assert.equal(boundary.activeTurns(),0);checks.push('stock-warmup-completes-without-physical-inference');
  const beforeAck=frames.length;client.send(JSON.stringify({type:'response.processed'}));await pause();assert.equal(frames.length,beforeAck);
  checks.push('processed-ack-does-not-start-new-turn');
  frames.length=0;client.send(JSON.stringify({type:'response.create',model:'gpt-6.1-sol',input:'fixture'}));
  await until(()=>frames.some(frame=>frame.type==='response.completed'));await until(()=>boundary.activeTurns()===0);
  assert.equal(sends,1);checks.push('official-sse-reframing-keeps-one-model-dispatch');
  frames.length=0;hold=true;client.send(JSON.stringify({type:'response.create',model:'gpt-6.1-sol',input:'held'}));
  await until(()=>frames.some(frame=>frame.type==='response.created'));assert.equal(boundary.activeTurns(),1);
  client.send(JSON.stringify({type:'response.create',model:'gpt-6.1-sol',input:'overlap'}));
  await until(()=>frames.some(frame=>frame.error?.code==='request_in_progress'));assert.equal(sends,2);
  checks.push('overlapping-create-is-refused-without-replay');
  client.send(JSON.stringify({type:'response.cancel'}));await until(()=>boundary.activeTurns()===0);assert.equal(cancelled,true);
  checks.push('client-cancel-releases-full-response-lifetime');
  client.close();await until(()=>socket.sockets.size===0);checks.push('socket-close-releases-owned-connection');
  client=new WebSocket('ws://127.0.0.1:'+server.port+'/v1/responses',{headers:{authorization:'Bearer fixture-data'}});
  const second:any[]=[];client.onmessage=(event:any)=>second.push(JSON.parse(String(event.data)));await until(()=>client.readyState===1);
  percent=97;client.send(JSON.stringify({type:'response.create',model:'gpt-6.1-sol',input:'threshold'}));
  await until(()=>second.some(frame=>frame.type==='error'));assert.equal(sends,2);
  checks.push('reconnected-socket-cannot-bypass-window-admission');
  console.log(JSON.stringify({status:'PASS',scope:'isolated-responses-websocket-transport',supplier:(process.env.AICC_OCX_SUPPLIER_VERSION ?? '2.81.0'),inference:'fixture-only',checks}));
}finally{client?.close();server.stop(true);}
